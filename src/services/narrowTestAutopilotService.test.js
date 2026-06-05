'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

// Isolate both the performance-learning data dir and the autopilot history dir
// to a fresh tmp dir, then load the service with a clean require cache.
function loadServiceWithData(seedFn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narrow-autopilot-'));
  fs.mkdirSync(path.join(tmpDir, 'paper-trading'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'strategy-batches', 'results'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'replay', 'runs', 'run_test'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'autopilot'), { recursive: true });

  if (typeof seedFn === 'function') seedFn(tmpDir);

  process.env.NARROW_DATA_DIR = tmpDir;
  process.env.NARROW_AUTOPILOT_DIR = path.join(tmpDir, 'autopilot');

  const perfPath = require.resolve('./narrowPerformanceLearningService');
  const svcPath = require.resolve('./narrowTestAutopilotService');
  delete require.cache[perfPath];
  delete require.cache[svcPath];
  const service = require('./narrowTestAutopilotService');
  return { service, tmpDir, historyFile: path.join(tmpDir, 'autopilot', 'narrow-autopilot-history.jsonl') };
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function seedNarrowData(tmpDir) {
  // Enough narrow_state evidence that recommendedNextTest names a narrow strategy.
  writeJsonl(path.join(tmpDir, 'paper-trading', 'trades.jsonl'), [
    {
      tradeId: 'narrow_trade_1', symbol: 'NVDA',
      strategy_id: 'narrow_breakout_v1', strategy_family: 'narrow_state',
      narrowScore: 84, regimeLabel: 'narrow_breakout_watch',
      confirmationUsed: { vwap: true, volume: true },
      confirmationQuality: { vwap: 'real', volume: 'heuristic', ema: 'missing', rsi: 'missing', macd: 'missing' },
      entryPrice: 100, exitPrice: 101, result: 'WIN', pnlPct: 1.0,
    },
  ]);
}

// ── 1) plan is created from recommendedNextTest and defaults to paper_only ────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan();
  assert.equal(plan.mode, 'paper_only', 'plan defaults to paper_only');
  assert.equal(plan.source, 'narrow_performance_learning', 'plan source is performance learning');
  assert.ok(service.isNarrowStrategy(plan.strategy_id), 'plan strategy is a narrow strategy');
  assert.equal(plan.safety.actions_allowed, false, 'safety actions_allowed false');
  assert.equal(plan.safety.can_place_orders, false, 'safety can_place_orders false');
  assert.equal(plan.safety.live_trading_enabled, false, 'safety live_trading_enabled false');
  assert.equal(plan.safety.broker_enabled, false, 'safety broker_enabled false');
  assert.ok(plan.symbols.length >= 1, 'plan has symbols');
  assert.ok(plan.timeframes.length >= 1, 'plan has timeframes');
  assert.ok(service.ALLOWED_TEST_TYPES.includes(plan.testType), 'plan testType is allowed');
}

// ── 2) default (cautious) plan when there is no narrow data ───────────────────
{
  const { service } = loadServiceWithData(); // no seed → no narrow data
  const plan = service.buildNarrowAutopilotPlan();
  assert.equal(plan.mode, 'paper_only', 'default plan paper_only');
  // With an empty dataset the recommendation still names a narrow strategy.
  assert.ok(service.isNarrowStrategy(plan.strategy_id), 'default plan uses a narrow strategy');
  const validation = service.validateNarrowAutopilotPlan(plan);
  assert.equal(validation.ok, true, 'default plan validates');
  assert.equal(validation.blocked, false, 'default plan not blocked');
}

// ── 3) unsafe plan is blocked (mode + safety flag) ────────────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan();
  const unsafe = { ...plan, mode: 'live', safety: { ...plan.safety, live_trading_enabled: true } };
  const validation = service.validateNarrowAutopilotPlan(unsafe);
  assert.equal(validation.blocked, true, 'unsafe plan is blocked');
  assert.ok(validation.reasons.some((r) => r.startsWith('mode_not_paper_only')), 'reports bad mode');
  assert.ok(validation.reasons.some((r) => r.startsWith('safety_flag_not_false')), 'reports live flag');
  assert.equal(validation.normalizedPlan.mode, 'paper_only', 'normalized plan forces paper_only');
  assert.equal(validation.normalizedPlan.safety.live_trading_enabled, false, 'normalized plan forces flag false');
  assert.equal(validation.normalizedPlan.status, 'blocked', 'normalized blocked status');
}

// ── 4) unknown / non-narrow strategy is blocked ───────────────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan();
  const bad = { ...plan, strategy_id: 'some_random_live_strategy' };
  const validation = service.validateNarrowAutopilotPlan(bad);
  assert.equal(validation.blocked, true, 'non-narrow strategy blocked');
  assert.ok(validation.reasons.some((r) => r.startsWith('unknown_or_non_narrow_strategy')), 'reports non-narrow strategy');
}

// ── 5) live_trading_enabled=true intent anywhere is blocked ───────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan();
  const withIntent = { ...plan, filters: { ...plan.filters, broker: 'order' } };
  const validation = service.validateNarrowAutopilotPlan(withIntent);
  assert.equal(validation.blocked, true, 'blocked intent plan is blocked');
  assert.ok(validation.reasons.some((r) => r.startsWith('blocked_intent')), 'reports blocked intent');

  // run-once with explicit live intent in options must refuse before running.
  const run = service.runNarrowAutopilotOnce({ live_trading_enabled: true });
  assert.equal(run.ok, false, 'run with live intent refused');
  assert.equal(run.blocked, true, 'run with live intent blocked');
  assert.equal(run.live_trading_enabled, false, 'run response keeps flag false');
}

// ── 6) dryRun writes history but never runs a batch ───────────────────────────
{
  const { service, historyFile } = loadServiceWithData(seedNarrowData);
  assert.equal(fs.existsSync(historyFile), false, 'no history before run');
  const run = service.runNarrowAutopilotOnce(); // dryRun default
  assert.equal(run.dryRun, true, 'defaults to dryRun');
  assert.equal(run.executed, false, 'dryRun does not execute');
  assert.equal(run.ok, true, 'dryRun ok');
  assert.equal(fs.existsSync(historyFile), true, 'history written');
  const events = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === 'plan_created'), 'logged plan_created');
  assert.ok(events.some((e) => e.event === 'plan_validated'), 'logged plan_validated');
  assert.ok(!events.some((e) => e.event === 'run_started'), 'dryRun did not start a run');
  for (const e of events) {
    assert.equal(e.safety.live_trading_enabled, false, 'history safety flag false');
    assert.equal(e.safety.can_place_orders, false, 'history can_place_orders false');
  }
}

// ── 7) status works even without a history file ───────────────────────────────
{
  const { service, historyFile } = loadServiceWithData(seedNarrowData);
  assert.equal(fs.existsSync(historyFile), false, 'no history file yet');
  const status = service.getNarrowAutopilotStatus();
  assert.equal(status.ok, true, 'status ok without history');
  assert.equal(status.mode, 'paper_only', 'status paper_only');
  assert.equal(status.actions_allowed, false, 'status actions_allowed false');
  assert.equal(status.can_place_orders, false, 'status can_place_orders false');
  assert.equal(status.live_trading_enabled, false, 'status live_trading_enabled false');
  assert.equal(status.broker_enabled, false, 'status broker_enabled false');
  assert.ok(status.autopilot, 'status carries autopilot block');
  assert.equal(status.autopilot.dryRunDefault, true, 'dryRun default exposed');
  assert.ok(status.autopilot.currentPlan, 'status previews a plan');
  assert.equal(status.autopilot.historyCount, 0, 'history count zero, no crash');
}

// ── 8) readNarrowAutopilotHistory returns [] with no file ─────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const history = service.readNarrowAutopilotHistory();
  assert.ok(Array.isArray(history), 'history is an array');
  assert.equal(history.length, 0, 'history empty before any run');
}

console.log('Narrow test autopilot tests passed.');
