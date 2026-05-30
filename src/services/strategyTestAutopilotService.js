'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const daytradingStrategyCatalog = require('./daytradingStrategyCatalogService');
const marketUniverse = require('./marketUniverseService');

const DATA_DIR = path.resolve(__dirname, '../../data/strategy-test-autopilot');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.jsonl');

const MAX_STRATEGIES = 5;
const MAX_SYMBOLS = 10;
const MAX_TIMEFRAMES = 4;
const MAX_COMBINATIONS = 100;

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: 'paper_replay_batch_only',
  interval_minutes: 60,
  max_runs_per_day: 24,
  max_parallel_jobs: 1,
  allowed_strategies: [],
  allowed_symbols: [],
  allowed_timeframes: ['2m', '5m', '15m', '30m'],
  test_combinations: true,
  auto_apply_results: false,
  live_trading_enabled: false,
  can_place_orders: false,
  actions_allowed: false,
});

const SAFETY = Object.freeze({
  live: false,
  paper_only: true,
  replay_mode: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  can_create_trades: false,
  can_modify_risk: false,
  can_auto_apply_results: false,
  agent_mode: 'paper_replay_batch_only',
});

let inMemoryRunning = false;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function appendJsonl(file, entry) {
  ensureDir();
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
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

function hasBlockedIntent(input) {
  const blockedKeys = new Set(['broker', 'order', 'execution', 'place_order', 'buy_now', 'sell_now']);
  const blockedValues = new Set(['broker', 'order', 'execution', 'place_order', 'buy_now', 'sell_now', 'live']);
  const seen = new Set();

  function walk(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') {
      if (typeof value === 'string' && blockedValues.has(value.trim().toLowerCase())) {
        return value;
      }
      return null;
    }
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, val] of Object.entries(value)) {
      const lowered = String(key || '').trim().toLowerCase();
      if (blockedKeys.has(lowered)) return key;
      if (lowered.includes('live_trading_enabled') || lowered.includes('can_place_orders') || lowered.includes('actions_allowed') || lowered.includes('auto_apply_results')) {
        if (val === true || String(val).trim().toLowerCase() === 'true') return key;
      }
      const hit = walk(val);
      if (hit) return hit;
    }
    return null;
  }

  return walk(input);
}

function ensureSafety(config = {}) {
  return {
    ...config,
    live_trading_enabled: false,
    can_place_orders: false,
    actions_allowed: false,
    auto_apply_results: false,
    paper_only: true,
    replay_mode: true,
    live: false,
    can_create_trades: false,
    can_modify_risk: false,
    can_auto_apply_results: false,
    agent_mode: SAFETY.agent_mode,
  };
}

function normalizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const merged = { ...DEFAULT_CONFIG, ...base, ...input };
  const mode = String(merged.mode || DEFAULT_CONFIG.mode).trim() || DEFAULT_CONFIG.mode;
  const allowedModes = new Set(['paper_replay_batch_only']);
  const safeMode = allowedModes.has(mode) ? mode : DEFAULT_CONFIG.mode;
  return ensureSafety({
    enabled: merged.enabled === true,
    mode: safeMode,
    interval_minutes: clampInt(merged.interval_minutes, DEFAULT_CONFIG.interval_minutes, 1, 1440),
    max_runs_per_day: clampInt(merged.max_runs_per_day, DEFAULT_CONFIG.max_runs_per_day, 1, 1000),
    max_parallel_jobs: 1,
    allowed_strategies: uniqueStrings(merged.allowed_strategies, { limit: MAX_STRATEGIES }),
    allowed_symbols: uniqueStrings(merged.allowed_symbols, { upper: true, limit: MAX_SYMBOLS }),
    allowed_timeframes: uniqueStrings(merged.allowed_timeframes, { limit: MAX_TIMEFRAMES }),
    test_combinations: merged.test_combinations !== false,
    auto_apply_results: false,
  });
}

function loadConfig() {
  const fileConfig = readJson(CONFIG_FILE, {});
  return normalizeConfig(fileConfig);
}

function saveConfig(updates = {}) {
  const blocked = hasBlockedIntent(updates);
  if (blocked) {
    return {
      ok: false,
      error: `Otillaten live/order-intent upptackt: ${blocked}`,
      ...SAFETY,
    };
  }
  const current = loadConfig();
  const next = normalizeConfig({ ...current, ...updates });
  writeJson(CONFIG_FILE, next);
  saveStatus({
    ...loadStatus(),
    config: next,
    updated_at: nowIso(),
  });
  return {
    ok: true,
    config: next,
    ...SAFETY,
  };
}

function emptyStatus() {
  return {
    enabled: false,
    running: false,
    last_run_id: null,
    last_run_at: null,
    last_run_status: 'idle',
    last_run_message_sv: 'Ingen korning annu.',
    total_runs: 0,
    planned_runs: 0,
    executed_runs: 0,
    failed_runs: 0,
    updated_at: nowIso(),
    config: loadConfig(),
    recent_runs: [],
    recent_error: null,
    ...SAFETY,
  };
}

function loadStatus() {
  const status = readJson(STATUS_FILE, null);
  const next = status ? { ...emptyStatus(), ...status } : emptyStatus();
  next.config = loadConfig();
  next.recent_runs = loadRecentRuns(10);
  next.enabled = next.config.enabled === true;
  next.running = inMemoryRunning === true || next.running === true;
  return ensureSafety(next);
}

function saveStatus(nextStatus = {}) {
  const current = loadStatus();
  const merged = ensureSafety({
    ...current,
    ...nextStatus,
    updated_at: nowIso(),
  });
  writeJson(STATUS_FILE, merged);
  return merged;
}

function loadRecentRuns(limit = 10) {
  return readJsonl(RUNS_FILE).slice(-Math.max(1, Math.min(50, Number(limit) || 10)));
}

function appendRunLog(entry = {}) {
  const run = {
    run_id: entry.run_id || `autopilot_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    status: entry.status || 'planned',
    run_type: entry.run_type || 'planned_only',
    created_at: entry.created_at || nowIso(),
    completed_at: entry.completed_at || nowIso(),
    message_sv: entry.message_sv || 'Plan skapad.',
    summary_sv: entry.summary_sv || null,
    error: entry.error || null,
    counts: entry.counts || {},
    config_snapshot: entry.config_snapshot || null,
    limits: entry.limits || {
      max_strategies: MAX_STRATEGIES,
      max_symbols: MAX_SYMBOLS,
      max_timeframes: MAX_TIMEFRAMES,
      max_combinations: MAX_COMBINATIONS,
    },
    planned: entry.planned === true,
    executed: entry.executed === true,
    combinations: Array.isArray(entry.combinations) ? entry.combinations : [],
    selected_strategies: uniqueStrings(entry.selected_strategies, { limit: MAX_STRATEGIES }),
    selected_symbols: uniqueStrings(entry.selected_symbols, { upper: true, limit: MAX_SYMBOLS }),
    selected_timeframes: uniqueStrings(entry.selected_timeframes, { limit: MAX_TIMEFRAMES }),
    safety: SAFETY,
    ...SAFETY,
  };
  appendJsonl(RUNS_FILE, run);

  const status = loadStatus();
  const nextStatus = {
    ...status,
    last_run_id: run.run_id,
    last_run_at: run.completed_at || run.created_at,
    last_run_status: run.status,
    last_run_message_sv: run.message_sv,
    recent_error: run.error || null,
    total_runs: (status.total_runs || 0) + 1,
    planned_runs: (status.planned_runs || 0) + (run.status === 'planned' ? 1 : 0),
    executed_runs: (status.executed_runs || 0) + (run.executed ? 1 : 0),
    failed_runs: (status.failed_runs || 0) + (run.status === 'failed' ? 1 : 0),
    running: false,
  };
  saveStatus(nextStatus);
  return run;
}

function buildSelections(config, options = {}) {
  const requestedStrategies = uniqueStrings(options.allowed_strategies || options.strategies || config.allowed_strategies, { limit: MAX_STRATEGIES });
  const requestedSymbols = uniqueStrings(options.allowed_symbols || options.symbols || config.allowed_symbols, { upper: true, limit: MAX_SYMBOLS });
  const requestedTimeframes = uniqueStrings(options.allowed_timeframes || options.timeframes || config.allowed_timeframes, { limit: MAX_TIMEFRAMES });

  const validStrategies = requestedStrategies.filter((id) => Boolean(daytradingStrategyCatalog.getStrategyById(id)));
  const validSymbols = requestedSymbols.filter((symbol) => marketUniverse.symbolEnabledFor(symbol, 'replay'));
  const validTimeframes = requestedTimeframes.length ? requestedTimeframes : [];

  return {
    strategies: validStrategies.slice(0, MAX_STRATEGIES),
    symbols: validSymbols.slice(0, MAX_SYMBOLS),
    timeframes: validTimeframes.slice(0, MAX_TIMEFRAMES),
    requested: {
      strategies: requestedStrategies,
      symbols: requestedSymbols,
      timeframes: requestedTimeframes,
    },
  };
}

function buildCombinations(selection, config) {
  const combos = [];
  const useCrossProduct = config.test_combinations !== false;
  const strategies = selection.strategies;
  const symbols = selection.symbols;
  const timeframes = selection.timeframes;

  if (!useCrossProduct) {
    const count = Math.min(strategies.length, symbols.length, timeframes.length, MAX_COMBINATIONS);
    for (let i = 0; i < count; i += 1) {
      combos.push({
        strategy_id: strategies[i],
        symbol: symbols[i],
        timeframe: timeframes[i],
      });
    }
    return { combos, capped: false, mode: 'paired' };
  }

  for (const strategyId of strategies) {
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        combos.push({ strategy_id: strategyId, symbol, timeframe });
        if (combos.length >= MAX_COMBINATIONS) {
          return { combos, capped: true, mode: 'cross_product' };
        }
      }
    }
  }

  return { combos, capped: false, mode: 'cross_product' };
}

function runOnce(options = {}) {
  const blocked = hasBlockedIntent(options);
  if (blocked) {
    const error = `Otillaten live/order-intent upptackt: ${blocked}`;
    const run = appendRunLog({
      status: 'failed',
      run_type: 'manual_run_once',
      message_sv: 'Körningen blockerades av safety.',
      error,
      created_at: nowIso(),
      completed_at: nowIso(),
    });
    return {
      ok: false,
      error,
      run,
      ...SAFETY,
    };
  }

  const config = loadConfig();
  const selection = buildSelections(config, options);
  if (!selection.strategies.length) {
    const error = 'Inga strategier valda eller godkanda for test.';
    return {
      ok: false,
      error,
      message_sv: error,
      selection,
      ...SAFETY,
    };
  }
  if (!selection.symbols.length) {
    const error = 'Inga symboler valda eller godkanda for replay/batch.';
    return {
      ok: false,
      error,
      message_sv: error,
      selection,
      ...SAFETY,
    };
  }
  if (!selection.timeframes.length) {
    const error = 'Inga timeframes valda.';
    return {
      ok: false,
      error,
      message_sv: error,
      selection,
      ...SAFETY,
    };
  }

  const planned = buildCombinations(selection, config);
  const combinations = planned.combos.slice(0, MAX_COMBINATIONS);
  const runId = `autopilot_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const run = appendRunLog({
    run_id: runId,
    status: 'planned',
    run_type: 'manual_run_once',
    created_at: nowIso(),
    completed_at: nowIso(),
    message_sv: 'Korsning planerad. Inga riktiga tester startades i v1.',
    summary_sv: `Planerad korning med ${selection.strategies.length} strategier, ${selection.symbols.length} symboler och ${selection.timeframes.length} timeframes.`,
    counts: {
      strategies: selection.strategies.length,
      symbols: selection.symbols.length,
      timeframes: selection.timeframes.length,
      combinations: combinations.length,
      combinations_capped: planned.capped,
    },
    config_snapshot: {
      enabled: config.enabled,
      mode: config.mode,
      interval_minutes: config.interval_minutes,
      max_runs_per_day: config.max_runs_per_day,
      max_parallel_jobs: config.max_parallel_jobs,
      test_combinations: config.test_combinations,
    },
    limits: {
      max_strategies: MAX_STRATEGIES,
      max_symbols: MAX_SYMBOLS,
      max_timeframes: MAX_TIMEFRAMES,
      max_combinations: MAX_COMBINATIONS,
    },
    selected_strategies: selection.strategies,
    selected_symbols: selection.symbols,
    selected_timeframes: selection.timeframes,
    combinations,
  });

  return {
    ok: true,
    planned: true,
    executed: false,
    run,
    selection,
    combinations: combinations.length,
    combinations_capped: planned.capped,
    combination_mode: planned.mode,
    message_sv: 'Plan skapad. Inga tester startades i v1.',
    ...SAFETY,
  };
}

function enable(updates = {}) {
  const blocked = hasBlockedIntent(updates);
  if (blocked) {
    return {
      ok: false,
      error: `Otillaten live/order-intent upptackt: ${blocked}`,
      ...SAFETY,
    };
  }
  const result = saveConfig({ ...updates, enabled: true });
  if (!result.ok) return result;
  return getStatus();
}

function disable() {
  const result = saveConfig({ enabled: false });
  if (!result.ok) return result;
  return getStatus();
}

function getConfig() {
  return {
    ok: true,
    config: loadConfig(),
    ...SAFETY,
  };
}

function getStatus() {
  const config = loadConfig();
  const status = loadStatus();
  const runs = loadRecentRuns(10);
  return {
    ok: true,
    enabled: config.enabled,
    running: Boolean(status.running || inMemoryRunning),
    config,
    status: {
      ...status,
      enabled: config.enabled,
      running: Boolean(status.running || inMemoryRunning),
    },
    recent_runs: runs,
    recent_runs_count: runs.length,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  DEFAULT_CONFIG,
  getStatus,
  getConfig,
  saveConfig,
  runOnce,
  enable,
  disable,
  appendRunLog,
  hasBlockedIntent,
};
