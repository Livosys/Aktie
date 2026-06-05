'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const cleanBatch = require('../../scripts/runCleanNarrowConfirmationBatch');

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

function bandAvailabilityOverride(bands = {}) {
  const availableBands = {
    confirmed_narrow: { rows: 0, estimatedTrades: 0, symbols: [] },
    weak_narrow: { rows: 0, estimatedTrades: 0, symbols: [] },
    strong_compression: { rows: 0, estimatedTrades: 0, symbols: [] },
  };
  for (const [band, rows] of Object.entries(bands)) {
    availableBands[band] = { rows, estimatedTrades: rows, symbols: rows ? ['MSFT'] : [] };
  }
  return {
    requestedBand: 'confirmed_narrow',
    availableBands,
    blockedBands: { not_narrow: { reason: 'not_valid_for_narrow_strategy', rows: 24, estimatedTrades: 24, symbols: ['QQQ'] } },
  };
}

// ── 1) plan is created from recommendedNextTest and defaults to paper_only ────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan({ bandAvailabilityOverride: bandAvailabilityOverride({ confirmed_narrow: 3 }) });
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
  assert.equal(plan.requestedNarrowScoreBand, 'confirmed_narrow', 'plan requests confirmed_narrow by default');
  assert.equal(plan.selectedNarrowScoreBand, 'confirmed_narrow', 'plan selects confirmed_narrow when available');
  assert.equal(plan.filters.narrowScoreBand, 'confirmed_narrow', 'batch filter uses selected confirmed_narrow');
  assert.equal(plan.filterEnforcement.requestedNarrowScoreBand, 'confirmed_narrow', 'plan exposes requested score-band enforcement');
  assert.equal(plan.filterEnforcement.selectedNarrowScoreBand, 'confirmed_narrow', 'plan exposes selected score-band enforcement');
  assert.equal(plan.filterEnforcement.enforceable, true, 'score-band filter is enforceable');
  assert.equal(plan.filterEnforcement.expectedNoMatchStatus, 'skipped_no_matching_band', 'no-match behavior is explicit');
}

// ── 2) default (cautious) plan when there is no narrow data ───────────────────
{
  const { service } = loadServiceWithData(); // no seed → no narrow data
  const plan = service.buildNarrowAutopilotPlan({ bandAvailabilityOverride: bandAvailabilityOverride({ weak_narrow: 3 }) });
  assert.equal(plan.mode, 'paper_only', 'default plan paper_only');
  // With an empty dataset the recommendation still names a narrow strategy.
  assert.ok(service.isNarrowStrategy(plan.strategy_id), 'default plan uses a narrow strategy');
  const validation = service.validateNarrowAutopilotPlan(plan);
  assert.equal(validation.ok, true, 'default plan validates');
  assert.equal(validation.blocked, false, 'default plan not blocked');
  assert.equal(plan.selectedNarrowScoreBand, 'weak_narrow', 'falls back to weak_narrow when confirmed missing');
  assert.ok(plan.warnings.includes('fallback_from_confirmed_to_weak'), 'fallback warning exposed');
}

// ── 3) unsafe plan is blocked (mode + safety flag) ────────────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan({ bandAvailabilityOverride: bandAvailabilityOverride({ confirmed_narrow: 3 }) });
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
  const plan = service.buildNarrowAutopilotPlan({ bandAvailabilityOverride: bandAvailabilityOverride({ confirmed_narrow: 3 }) });
  const bad = { ...plan, strategy_id: 'some_random_live_strategy' };
  const validation = service.validateNarrowAutopilotPlan(bad);
  assert.equal(validation.blocked, true, 'non-narrow strategy blocked');
  assert.ok(validation.reasons.some((r) => r.startsWith('unknown_or_non_narrow_strategy')), 'reports non-narrow strategy');
}

// ── 5) live_trading_enabled=true intent anywhere is blocked ───────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan({ bandAvailabilityOverride: bandAvailabilityOverride({ confirmed_narrow: 3 }) });
  const withIntent = { ...plan, filters: { ...plan.filters, broker: 'order' } };
  const validation = service.validateNarrowAutopilotPlan(withIntent);
  assert.equal(validation.blocked, true, 'blocked intent plan is blocked');
  assert.ok(validation.reasons.some((r) => r.startsWith('blocked_intent')), 'reports blocked intent');

  // run-once with explicit live intent in options must refuse before running.
  const run = service.runNarrowAutopilotOnce({ live_trading_enabled: true, bandAvailabilityOverride: bandAvailabilityOverride({ confirmed_narrow: 3 }) });
  assert.equal(run.ok, false, 'run with live intent refused');
  assert.equal(run.blocked, true, 'run with live intent blocked');
  assert.equal(run.live_trading_enabled, false, 'run response keeps flag false');
}

// ── 6) dryRun writes history but never runs a batch ───────────────────────────
{
  const { service, historyFile } = loadServiceWithData(seedNarrowData);
  assert.equal(fs.existsSync(historyFile), false, 'no history before run');
  const run = service.runNarrowAutopilotOnce({ bandAvailabilityOverride: bandAvailabilityOverride({ confirmed_narrow: 3 }) }); // dryRun default
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

// ── 9) score-band filtering never keeps non-matching batch rows ──────────────
{
  const rows = [
    { strategy_family: 'narrow_state', strategy_id: 'narrow_fakeout_reversal_v1', symbol: 'MSFT', timeframe: '2m', narrowScoreBand: 'not_narrow', trades: 12 },
    { strategy_family: 'narrow_state', strategy_id: 'narrow_fakeout_reversal_v1', symbol: 'AAPL', timeframe: '2m', narrowScoreBand: 'confirmed_narrow', trades: 4 },
  ];
  const filtered = cleanBatch.applyScoreBandFilter(rows, 'confirmed_narrow');
  assert.equal(filtered.status, 'matched', 'confirmed_narrow row matched');
  assert.equal(filtered.rows.length, 1, 'only matching row kept');
  assert.equal(filtered.rows[0].narrowScoreBand, 'confirmed_narrow', 'non-matching not_narrow row removed');
  assert.equal(filtered.skippedRows, 1, 'skipped row counted');
}

// ── 10) no matching score-band writes an honest zero-trade skip row ──────────
{
  const filtered = cleanBatch.applyScoreBandFilter([
    { strategy_family: 'narrow_state', strategy_id: 'narrow_fakeout_reversal_v1', symbol: 'MSFT', timeframe: '2m', narrowScoreBand: 'not_narrow', trades: 12 },
  ], 'confirmed_narrow');
  assert.equal(filtered.status, 'skipped_no_matching_band', 'no matching band skips');
  assert.equal(filtered.rows.length, 0, 'no invalid result rows kept');
  const skip = cleanBatch.buildNoMatchingSetupsRow({ date_from: '2026-01-01', date_to: '2026-01-02' }, filtered);
  assert.equal(skip.status, 'skipped_no_matching_band', 'skip status set');
  assert.equal(skip.result, 'no_matching_setups', 'skip result honest');
  assert.equal(skip.tradeCount, 0, 'skip row has zero tradeCount');
  assert.equal(skip.trades, 0, 'skip row has zero trades');
  assert.equal(skip.narrowScoreBand, 'confirmed_narrow', 'skip row records requested band');
  assert.equal(skip.actions_allowed, false, 'skip safety actions false');
  assert.equal(skip.can_place_orders, false, 'skip safety orders false');
  assert.equal(skip.live_trading_enabled, false, 'skip safety live false');
  assert.equal(skip.broker_enabled, false, 'skip safety broker false');
}

// ── 11) dry-run warns if latest identical batch produced the wrong band ──────
{
  const { service } = loadServiceWithData((tmpDir) => {
    seedNarrowData(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'strategy-batches', 'results', 'batch_latest.json'), JSON.stringify([
      {
        strategy_family: 'narrow_state',
        strategy_id: 'narrow_fakeout_reversal_v1',
        symbol: 'MSFT',
        timeframe: '2m',
        narrowScore: 20,
        narrowScoreBand: 'not_narrow',
        trades: 3,
        wins: 1,
        losses: 2,
      },
    ], null, 2), 'utf8');
  });
  const run = service.runNarrowAutopilotOnce({ bandAvailabilityOverride: bandAvailabilityOverride({ confirmed_narrow: 3 }) });
  assert.equal(run.dryRun, true, 'mismatch check stays dry-run');
  assert.equal(run.executed, false, 'mismatch check does not execute');
  assert.ok(run.plan.warnings.includes('filter_mismatch_previous_run'), 'mismatch warning exposed');
  assert.equal(run.plan.filterEnforcement.previousRunWarning.requestedNarrowScoreBand, 'confirmed_narrow', 'mismatch records requested band');
  assert.deepEqual(run.plan.filterEnforcement.previousRunWarning.observedNarrowScoreBands, ['not_narrow'], 'mismatch records observed band');
}

// ── 12) adaptive band selection prefers confirmed_narrow ────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const selected = service.selectNarrowScoreBand(bandAvailabilityOverride({ confirmed_narrow: 3, weak_narrow: 6 }));
  assert.equal(selected.selectedBand, 'confirmed_narrow', 'confirmed_narrow wins when available');
  assert.equal(selected.selectionReason, 'confirmed_narrow_available', 'confirmed selection reason');
}

// ── 13) adaptive band selection falls back to weak_narrow ───────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const selected = service.selectNarrowScoreBand(bandAvailabilityOverride({ weak_narrow: 6, strong_compression: 3 }));
  assert.equal(selected.selectedBand, 'weak_narrow', 'weak_narrow chosen when confirmed missing');
  assert.ok(selected.warnings.includes('fallback_from_confirmed_to_weak'), 'weak fallback warning included');
}

// ── 14) not_narrow is never selected ─────────────────────────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const plan = service.buildNarrowAutopilotPlan({ bandAvailabilityOverride: bandAvailabilityOverride({}) });
  const validation = service.validateNarrowAutopilotPlan(plan);
  assert.equal(plan.selectedNarrowScoreBand, null, 'no allowed band selected');
  assert.notEqual(plan.selectedNarrowScoreBand, 'not_narrow', 'not_narrow never selected');
  assert.equal(validation.blocked, true, 'no narrow bands blocks plan');
  assert.ok(validation.reasons.includes('no_matching_narrow_bands'), 'reports no matching narrow bands');
}

// ── 15) date-window selection prefers confirmed_narrow ──────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const best = service.selectBestNarrowDateWindow([
    { dateFrom: '2026-04-20', dateTo: '2026-05-01', bandAvailability: { confirmed_narrow: 0, weak_narrow: 2, strong_compression: 0, not_narrow: 6 } },
    { dateFrom: '2026-05-04', dateTo: '2026-05-15', bandAvailability: { confirmed_narrow: 1, weak_narrow: 0, strong_compression: 0, not_narrow: 7 } },
  ]);
  assert.equal(best.dateFrom, '2026-05-04', 'confirmed_narrow window selected');
}

// ── 16) date-window selection falls back to weak_narrow ─────────────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const best = service.selectBestNarrowDateWindow([
    { dateFrom: '2026-04-20', dateTo: '2026-05-01', bandAvailability: { confirmed_narrow: 0, weak_narrow: 0, strong_compression: 2, not_narrow: 6 } },
    { dateFrom: '2026-05-04', dateTo: '2026-05-15', bandAvailability: { confirmed_narrow: 0, weak_narrow: 1, strong_compression: 0, not_narrow: 7 } },
  ]);
  assert.equal(best.dateFrom, '2026-05-04', 'weak_narrow chosen before strong_compression');
}

// ── 17) date-window selection blocks when only not_narrow exists ────────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const best = service.selectBestNarrowDateWindow([
    { dateFrom: '2026-04-20', dateTo: '2026-05-01', bandAvailability: { confirmed_narrow: 0, weak_narrow: 0, strong_compression: 0, not_narrow: 8 } },
  ]);
  assert.equal(best, null, 'only not_narrow produces no best window');
}

// ── 18) date-window selection avoids already-tested identical windows ───────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const best = service.selectBestNarrowDateWindow([
    { dateFrom: '2026-05-04', dateTo: '2026-05-15', alreadyTested: true, bandAvailability: { confirmed_narrow: 3, weak_narrow: 0, strong_compression: 0, not_narrow: 5 } },
    { dateFrom: '2026-04-20', dateTo: '2026-05-01', alreadyTested: false, bandAvailability: { confirmed_narrow: 0, weak_narrow: 2, strong_compression: 0, not_narrow: 6 } },
  ]);
  assert.equal(best.dateFrom, '2026-04-20', 'already-tested confirmed window skipped');
}

// ── 19) window analysis reads real candles and exposes safety false ─────────
{
  const { service } = loadServiceWithData(seedNarrowData);
  const analysis = service.analyzeNarrowDateWindows({ symbols: ['MSFT', 'QQQ'], timeframe: '2m' });
  assert.ok(Array.isArray(analysis.windows), 'window analysis returns windows');
  assert.ok(analysis.windows.length > 0, 'real repo candles produce windows');
  assert.ok(analysis.windows.every((window) => Number(window.candleCount || 0) > 0), 'windows use real candle counts');
  const status = service.getNarrowAutopilotStatus();
  assert.equal(status.actions_allowed, false, 'status actions false after window analysis');
  assert.equal(status.can_place_orders, false, 'status orders false after window analysis');
  assert.equal(status.live_trading_enabled, false, 'status live false after window analysis');
  assert.equal(status.broker_enabled, false, 'status broker false after window analysis');
}

console.log('Narrow test autopilot tests passed.');
