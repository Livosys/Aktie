'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Narrow Test Autopilot Service (v1)
//
// A SAFE test-assistant. It reads what Narrow Performance Learning recommends
// and turns that into a validated, paper/replay/batch-only test plan. It can
// log plans, validate their safety, and (only when explicitly asked) run one
// small batch via the existing clean-batch script.
//
// IMPORTANT — this is NOT a trading bot:
//   - It NEVER places real orders.
//   - It NEVER enables a broker.
//   - It NEVER enables live trading.
//   - It NEVER auto-applies strategy changes or modifies risk.
//   - It only works with replay / batch / paper / analysis / learning.
//
// dryRun-first: runNarrowAutopilotOnce defaults to dryRun:true. Only an
// explicit options.dryRun === false will run a real (paper/batch) test.
// ────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const narrowPerformanceLearning = require('./narrowPerformanceLearningService');
const { NARROW_DEFAULT_TIMEFRAMES, detectNarrowTimeframeAvailability } = require('../config/narrowTimeframes');

// Always-false safety contract. This object is the single source of truth and
// is forced onto every plan, history entry and status response.
const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const MODE = 'paper_only';
const SOURCE = 'narrow_performance_learning';

// The only test types the autopilot may ever plan.
const ALLOWED_TEST_TYPES = Object.freeze(['batch', 'replay', 'paper']);

// Broadened equity set — all have real 2m candle data with a shared common date
// window. More symbols → more diverse, non-duplicate Narrow State evidence.
const DEFAULT_SYMBOLS = Object.freeze(['MSFT', 'QQQ', 'TSLA', 'AAPL', 'NVDA', 'META', 'AMZN', 'AMD']);
// Narrow timeframe standard comes from the central config (currently 2m-only).
// The plan REQUESTS the standard; the safe runnable subset is detected from data.
const DEFAULT_TIMEFRAMES = NARROW_DEFAULT_TIMEFRAMES;
const DEFAULT_STRATEGY_ID = 'narrow_fakeout_reversal_v1';
const DEFAULT_BAND = 'confirmed_narrow';
const DEFAULT_CONFIRMATIONS = Object.freeze(['macd']);

const DEFAULT_LIMITS = Object.freeze({
  maxSymbols: 8,
  maxTimeframes: 4,
  maxRuns: 3,
  maxRuntimeSeconds: 120,
});

// Hard caps. validateNarrowAutopilotPlan blocks anything above these.
const HARD_LIMITS = Object.freeze({
  maxSymbols: 10,
  maxTimeframes: 4,
  maxRuns: 25,
  maxRuntimeSeconds: 600,
});

// Data dir is env-overridable so tests can isolate to a tmp dir.
const DATA_DIR = path.resolve(process.env.NARROW_AUTOPILOT_DIR || path.resolve(__dirname, '../../data/autopilot'));
const HISTORY_FILE = path.join(DATA_DIR, 'narrow-autopilot-history.jsonl');

const CLEAN_BATCH_SCRIPT = path.resolve(__dirname, '../../scripts/runCleanNarrowConfirmationBatch.js');

// ── helpers ──────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function uniqueStrings(value, { upper = false, limit = null } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of toArray(value)) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    const normalized = upper ? raw.toUpperCase() : raw;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function appendJsonl(file, entry) {
  if (!ensureDir()) return false;
  try {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// The set of strategy ids that legitimately belong to the narrow_state family.
function narrowStrategyIds() {
  try { return narrowPerformanceLearning.narrowStrategyIdSet(); } catch (_) { return new Set(); }
}

function isNarrowStrategy(strategyId) {
  const id = String(strategyId || '').trim();
  if (!id) return false;
  return narrowStrategyIds().has(id);
}

function inferMarketGroup(symbols) {
  const list = uniqueStrings(symbols, { upper: true });
  if (!list.length) return 'unknown';
  if (list.some((s) => s.endsWith('USDT') || s.endsWith('USD') || s.endsWith('PERP'))) return 'crypto';
  return 'stocks';
}

// Deep scan for any live/order/broker/execution intent hiding in input.
// Returns the offending key/value string, or null when clean.
function findBlockedIntent(input) {
  const blockedKeys = new Set(['broker', 'order', 'execution', 'place_order', 'buy_now', 'sell_now']);
  const blockedValues = new Set(['broker', 'order', 'execution', 'place_order', 'buy_now', 'sell_now', 'live', 'live_trading']);
  const liveFlagKeys = ['live_trading_enabled', 'can_place_orders', 'actions_allowed', 'broker_enabled', 'auto_apply', 'auto_apply_results'];
  const seen = new Set();

  function walk(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') {
      if (typeof value === 'string' && blockedValues.has(value.trim().toLowerCase())) return value;
      return null;
    }
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) { const hit = walk(item); if (hit) return hit; }
      return null;
    }
    for (const [key, val] of Object.entries(value)) {
      const lowered = String(key || '').trim().toLowerCase();
      if (blockedKeys.has(lowered)) return key;
      if (liveFlagKeys.some((flag) => lowered.includes(flag))) {
        if (val === true || String(val).trim().toLowerCase() === 'true') return key;
      }
      const hit = walk(val);
      if (hit) return hit;
    }
    return null;
  }

  return walk(input);
}

// ── plan building ────────────────────────────────────────────────────────────

function buildNarrowAutopilotPlan(options = {}) {
  const warnings = [];
  let summary = null;
  let recommendedNextTest = null;

  try {
    const full = narrowPerformanceLearning.buildNarrowPerformanceSummary();
    summary = full && full.summary ? full.summary : null;
    recommendedNextTest = full ? full.recommendedNextTest : null;
  } catch (err) {
    warnings.push(`performance_summary_unavailable:${err.message}`);
  }

  // Map Performance Learning's recommendation onto a concrete, cautious plan.
  let strategyId = DEFAULT_STRATEGY_ID;
  let reason = 'Ingen rekommendation tillgänglig — använder försiktig default-plan.';
  let priority = 'low';
  let testType = 'batch';
  let symbols = [...DEFAULT_SYMBOLS];
  let narrowScoreBand = DEFAULT_BAND;
  let confirmations = [...DEFAULT_CONFIRMATIONS];

  if (recommendedNextTest && recommendedNextTest.strategy_id) {
    strategyId = recommendedNextTest.strategy_id;
    reason = recommendedNextTest.reason || recommendedNextTest.title || reason;
    priority = recommendedNextTest.priority || priority;
    const recType = String(recommendedNextTest.source || '').trim();
    testType = ALLOWED_TEST_TYPES.includes(recType) ? recType : 'batch';
    const f = recommendedNextTest.suggestedFilters || {};
    // Broaden, never narrow: prioritise the recommendation's best symbols, then
    // fill with the broad default set so we keep testing more symbols (the cap
    // is applied later). Avoids re-running only the same 3 symbols every time.
    const recSymbols = uniqueStrings(f.symbols, { upper: true });
    symbols = uniqueStrings([...recSymbols, ...DEFAULT_SYMBOLS], { upper: true });
    narrowScoreBand = String(f.narrowScoreBand || DEFAULT_BAND);
    const recConfirms = uniqueStrings(f.confirmations);
    confirmations = recConfirms.length ? recConfirms : [...DEFAULT_CONFIRMATIONS];
  } else {
    warnings.push('no_recommended_next_test_using_default_plan');
    // If summary names a leading narrow strategy, prefer it for the default.
    if (summary && summary.bestStrategy && isNarrowStrategy(summary.bestStrategy.strategy_id)) {
      strategyId = summary.bestStrategy.strategy_id;
      reason = `Ingen explicit rekommendation — testar ledande strategi "${summary.bestStrategy.name || strategyId}" försiktigt vidare.`;
    }
  }

  // confirmationQuality follows the measured evidence quality when available.
  const confirmationQuality = summary && summary.strongestConfirmation && summary.strongestConfirmation.evidenceQuality
    ? summary.strongestConfirmation.evidenceQuality
    : 'mixed';

  // Allow callers to tighten (never loosen) the small limits.
  const limits = {
    maxSymbols: clampInt(options.maxSymbols, DEFAULT_LIMITS.maxSymbols, 1, HARD_LIMITS.maxSymbols),
    maxTimeframes: clampInt(options.maxTimeframes, DEFAULT_LIMITS.maxTimeframes, 1, HARD_LIMITS.maxTimeframes),
    maxRuns: clampInt(options.maxRuns, DEFAULT_LIMITS.maxRuns, 1, HARD_LIMITS.maxRuns),
    maxRuntimeSeconds: clampInt(options.maxRuntimeSeconds, DEFAULT_LIMITS.maxRuntimeSeconds, 5, HARD_LIMITS.maxRuntimeSeconds),
  };

  symbols = symbols.slice(0, limits.maxSymbols);

  // Timeframes: always REQUEST the new standard (1m/2m/5m/10m), then run only
  // the safe subset that has real, loadable candle data. Never fake missing tfs.
  const requestedTimeframes = [...NARROW_DEFAULT_TIMEFRAMES];
  const availability = detectNarrowTimeframeAvailability(symbols, requestedTimeframes);
  const availableTimeframes = availability.available;
  const missingTimeframes = availability.missing;
  const timeframes = availableTimeframes.slice(0, limits.maxTimeframes);
  for (const w of availability.warnings) warnings.push(w);

  if (!isNarrowStrategy(strategyId)) {
    warnings.push(`non_narrow_strategy:${strategyId}`);
  }

  const plan = {
    id: newId('narrow_autopilot_plan'),
    createdAt: nowIso(),
    mode: MODE,
    source: SOURCE,
    strategy_id: strategyId,
    reason,
    priority,
    testType,
    symbols,
    // Safe runnable subset (what the batch will actually test).
    timeframes,
    // New Narrow timeframe standard + honest availability breakdown.
    requestedTimeframes,
    availableTimeframes,
    missingTimeframes,
    timeframeDetails: availability.details,
    filters: {
      narrowScoreBand,
      confirmations,
      confirmationQuality,
      marketGroup: inferMarketGroup(symbols),
    },
    limits,
    safety: { ...SAFETY },
    status: 'planned',
    warnings,
    nextStep: 'validate',
  };

  return plan;
}

// ── safety validation ────────────────────────────────────────────────────────

function validateNarrowAutopilotPlan(plan = {}) {
  const reasons = [];
  const warnings = Array.isArray(plan.warnings) ? [...plan.warnings] : [];

  if (!plan || typeof plan !== 'object') {
    return { ok: false, blocked: true, reasons: ['plan_missing'], warnings, normalizedPlan: null };
  }

  // 1) Mode must be paper_only.
  if (plan.mode !== MODE) reasons.push(`mode_not_paper_only:${plan.mode}`);

  // 2) Every safety flag must be explicitly false.
  const safety = plan.safety || {};
  for (const key of Object.keys(SAFETY)) {
    if (safety[key] !== false) reasons.push(`safety_flag_not_false:${key}`);
  }

  // 3) testType must be batch/replay/paper.
  if (!ALLOWED_TEST_TYPES.includes(plan.testType)) reasons.push(`invalid_test_type:${plan.testType}`);

  // 4) No live/order/broker/execution intent anywhere in the plan.
  const blockedIntent = findBlockedIntent(plan);
  if (blockedIntent) reasons.push(`blocked_intent:${blockedIntent}`);

  // 5) strategy_id must be a known narrow_state strategy.
  if (!isNarrowStrategy(plan.strategy_id)) reasons.push(`unknown_or_non_narrow_strategy:${plan.strategy_id}`);

  // 6) symbols and timeframes must be present.
  const symbols = uniqueStrings(plan.symbols, { upper: true });
  const timeframes = uniqueStrings(plan.timeframes);
  if (!symbols.length) reasons.push('no_symbols');
  if (!timeframes.length) reasons.push('no_timeframes');

  // 7) Limits must be sane.
  const limits = plan.limits || {};
  const maxRuns = Number(limits.maxRuns);
  if (!Number.isFinite(maxRuns) || maxRuns < 1) reasons.push('invalid_max_runs');
  else if (maxRuns > HARD_LIMITS.maxRuns) reasons.push(`max_runs_too_high:${maxRuns}`);
  if (symbols.length > HARD_LIMITS.maxSymbols) reasons.push(`too_many_symbols:${symbols.length}`);
  if (timeframes.length > HARD_LIMITS.maxTimeframes) reasons.push(`too_many_timeframes:${timeframes.length}`);

  const blocked = reasons.length > 0;

  // The normalized plan ALWAYS carries the forced safety contract, regardless
  // of what came in. A blocked plan is marked status: 'blocked'.
  const normalizedPlan = {
    ...plan,
    mode: MODE,
    symbols,
    timeframes,
    safety: { ...SAFETY },
    status: blocked ? 'blocked' : 'validated',
    warnings,
    nextStep: blocked ? 'fix_plan' : (plan.testType === 'batch' || plan.testType === 'replay' || plan.testType === 'paper' ? 'run_or_queue' : 'fix_plan'),
  };

  return { ok: !blocked, blocked, reasons, warnings, normalizedPlan };
}

// ── history ──────────────────────────────────────────────────────────────────

function logEvent(event, plan, extra = {}) {
  const entry = {
    timestamp: nowIso(),
    event,
    planId: plan ? plan.id : null,
    strategy_id: plan ? plan.strategy_id : null,
    testType: plan ? plan.testType : null,
    symbols: plan ? uniqueStrings(plan.symbols, { upper: true }) : [],
    timeframes: plan ? uniqueStrings(plan.timeframes) : [],
    status: plan ? plan.status : null,
    safety: { ...SAFETY },
    summary: extra.summary || null,
    warnings: Array.isArray(extra.warnings) ? extra.warnings : (plan && Array.isArray(plan.warnings) ? plan.warnings : []),
  };
  appendJsonl(HISTORY_FILE, entry);
  return entry;
}

function readNarrowAutopilotHistory(limit = 25) {
  const all = readJsonl(HISTORY_FILE);
  const n = clampInt(limit, 25, 1, 500);
  return all.slice(-n);
}

// ── run once (dryRun-first) ──────────────────────────────────────────────────

function runNarrowAutopilotOnce(options = {}) {
  // dryRun-first: anything other than an explicit `false` stays a dry run.
  const dryRun = options.dryRun !== false;

  // Reject any live/order intent in the options before doing anything.
  const blockedIntent = findBlockedIntent(options);
  if (blockedIntent) {
    const plan = buildNarrowAutopilotPlan(options);
    plan.status = 'blocked';
    plan.warnings.push(`blocked_intent_in_options:${blockedIntent}`);
    logEvent('run_blocked', plan, { warnings: plan.warnings });
    return {
      ok: false, blocked: true, dryRun,
      reasons: [`blocked_intent:${blockedIntent}`],
      plan, mode: MODE, ...SAFETY,
    };
  }

  const plan = buildNarrowAutopilotPlan(options);
  logEvent('plan_created', plan);

  const validation = validateNarrowAutopilotPlan(plan);
  const finalPlan = validation.normalizedPlan;
  logEvent(validation.blocked ? 'run_blocked' : 'plan_validated', finalPlan, { warnings: validation.reasons });

  if (validation.blocked) {
    return {
      ok: false, blocked: true, dryRun,
      reasons: validation.reasons,
      plan: finalPlan, mode: MODE, ...SAFETY,
    };
  }

  if (dryRun) {
    finalPlan.status = 'planned';
    finalPlan.nextStep = 'run_with_--execute';
    return {
      ok: true, blocked: false, dryRun: true, executed: false,
      plan: finalPlan,
      message_sv: 'Dry-run: plan skapad och validerad. Inget test kördes. Använd --execute för en liten, säker testkörning.',
      mode: MODE, ...SAFETY,
    };
  }

  // Non-dryRun: run ONE small, safe paper/batch test via the existing clean
  // batch script (paper/batch only — it cannot place orders or go live).
  logEvent('run_started', finalPlan);
  let runSummary = null;
  let runStatus = 'completed';
  const runWarnings = [];
  try {
    const timeoutMs = Math.min(HARD_LIMITS.maxRuntimeSeconds, finalPlan.limits.maxRuntimeSeconds) * 1000;
    // Pass the plan's safe runnable timeframes to the batch script. The script
    // re-detects availability and skips any timeframe without real candle data.
    const planTimeframes = Array.isArray(finalPlan.timeframes) ? finalPlan.timeframes.join(',') : '';
    const proc = spawnSync('node', [CLEAN_BATCH_SCRIPT], {
      cwd: path.resolve(__dirname, '../..'),
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NARROW_BATCH_TIMEFRAMES: planTimeframes },
    });
    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
      runStatus = 'failed';
      runWarnings.push(`batch_exit_${proc.status}`);
    }
    // The script prints a JSON summary on stdout; parse the last JSON block.
    try {
      const out = String(proc.stdout || '').trim();
      const start = out.indexOf('{');
      if (start >= 0) runSummary = JSON.parse(out.slice(start));
    } catch (_) { runWarnings.push('summary_parse_failed'); }
  } catch (err) {
    runStatus = 'failed';
    runWarnings.push(`run_error:${err.message}`);
  }

  // The batch skips itself if an identical run already completed (no duplicate
  // tests). Surface that as a distinct, non-failed outcome.
  const duplicateSkipped = Boolean(runSummary && runSummary.duplicate_skipped);
  if (duplicateSkipped && runStatus !== 'failed') {
    runStatus = 'duplicate_skipped';
    runWarnings.push(`duplicate_skipped:${runSummary.priorBatchId || ''}`);
  }

  finalPlan.status = runStatus;
  const compact = runSummary && runSummary.summary ? {
    status: runSummary.summary.status,
    totalTrades: runSummary.summary.totalTrades,
    bestStrategy: runSummary.summary.bestStrategy ? runSummary.summary.bestStrategy.strategy_id : null,
  } : null;
  const eventName = runStatus === 'failed' ? 'run_failed'
    : runStatus === 'duplicate_skipped' ? 'run_skipped_duplicate'
    : 'run_completed';
  logEvent(eventName, finalPlan, { summary: compact, warnings: runWarnings });

  return {
    ok: runStatus !== 'failed',
    blocked: false,
    dryRun: false,
    executed: runStatus === 'completed',
    duplicateSkipped,
    plan: finalPlan,
    runStatus,
    summary: compact,
    warnings: runWarnings,
    message_sv: runStatus === 'failed'
      ? 'Testkörningen misslyckades. Inga order lades. Se warnings.'
      : runStatus === 'duplicate_skipped'
        ? 'Identisk batch fanns redan — hoppade över för att undvika dubblett-data. Inga order lades.'
        : 'En liten, säker paper/batch-testkörning slutfördes. Inga riktiga order lades.',
    mode: MODE, ...SAFETY,
  };
}

// ── status ───────────────────────────────────────────────────────────────────

function getNarrowAutopilotStatus() {
  const history = readNarrowAutopilotHistory(25);
  const lastPlanEvent = [...history].reverse().find((e) => e.planId);

  // A fresh, validated plan preview (does not run anything, does not log).
  let plan = null;
  let validation = null;
  try {
    plan = buildNarrowAutopilotPlan();
    validation = validateNarrowAutopilotPlan(plan);
  } catch (err) {
    validation = { ok: false, blocked: true, reasons: [`plan_build_error:${err.message}`], warnings: [], normalizedPlan: null };
  }

  // Pull the live recommendation through for the Supervisor card.
  let recommendedNextTest = null;
  try {
    const full = narrowPerformanceLearning.buildNarrowPerformanceSummary();
    recommendedNextTest = full ? full.recommendedNextTest : null;
  } catch (_) { recommendedNextTest = null; }

  return {
    ok: true,
    mode: MODE,
    ...SAFETY,
    autopilot: {
      enabled: true,
      dryRunDefault: true,
      executionRequiresExplicitFlag: true,
      currentPlan: validation ? validation.normalizedPlan : plan,
      planValidation: validation ? { ok: validation.ok, blocked: validation.blocked, reasons: validation.reasons } : null,
      recommendedNextTest,
      lastEvent: lastPlanEvent || (history.length ? history[history.length - 1] : null),
      recentEvents: history.slice(-10),
      historyCount: history.length,
      note: 'Autopiloten får bara planera och köra säkra batch/replay/paper-tester. Den kan aldrig lägga riktiga order.',
    },
  };
}

module.exports = {
  SAFETY,
  MODE,
  ALLOWED_TEST_TYPES,
  DEFAULT_LIMITS,
  HARD_LIMITS,
  buildNarrowAutopilotPlan,
  validateNarrowAutopilotPlan,
  runNarrowAutopilotOnce,
  getNarrowAutopilotStatus,
  readNarrowAutopilotHistory,
  findBlockedIntent,
  isNarrowStrategy,
};
