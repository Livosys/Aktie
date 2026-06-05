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
const marketDataStore = require('../data/marketDataStore');
const { loadCandles } = require('../data/marketDataStore');
const { analyzeNarrowState } = require('./narrowStateEngineService');

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
const ALLOWED_TEST_BANDS = Object.freeze(['confirmed_narrow', 'weak_narrow', 'strong_compression']);
const WINDOW_BAND_PRIORITY = Object.freeze(['confirmed_narrow', 'weak_narrow', 'strong_compression']);
const DEFAULT_DATE_WINDOW_TRADING_DAYS = 10;
const BLOCKED_TEST_BANDS = Object.freeze({
  not_narrow: { reason: 'not_valid_for_narrow_strategy' },
});

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
const LEARNING_DATA_DIR = path.resolve(process.env.NARROW_DATA_DIR || path.resolve(__dirname, '../../data'));
const BATCH_RESULTS_DIR = path.join(LEARNING_DATA_DIR, 'strategy-batches', 'results');

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

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function latestBatchRows() {
  try {
    if (!fs.existsSync(BATCH_RESULTS_DIR)) return [];
    const files = fs.readdirSync(BATCH_RESULTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, path: path.join(BATCH_RESULTS_DIR, f), stat: fs.statSync(path.join(BATCH_RESULTS_DIR, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (!files.length) return [];
    const data = safeReadJson(files[0].path, []);
    const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
    return rows.map((row) => ({ ...row, __sourceFile: files[0].file }));
  } catch (_) {
    return [];
  }
}

function detectPreviousFilterMismatch(plan) {
  const requestedBand = String(plan?.filters?.narrowScoreBand || '').trim();
  if (!requestedBand) return null;
  const symbols = new Set(uniqueStrings(plan.symbols, { upper: true }));
  const timeframes = new Set(uniqueStrings(plan.timeframes));
  const rows = latestBatchRows().filter((row) => {
    const symbol = String(row.symbol || '').toUpperCase();
    const timeframe = String(row.timeframe || '');
    return symbols.has(symbol) && timeframes.has(timeframe);
  });
  if (!rows.length) return null;
  const bands = [...new Set(rows.map((row) => String(row.narrowScoreBand || 'unknown')))];
  const requestedFilterSeen = rows.some((row) => String(row.requestedFilters?.narrowScoreBand || row.filters?.narrowScoreBand || '') === requestedBand);
  const hasRequestedBand = rows.some((row) => String(row.narrowScoreBand || '') === requestedBand);
  if (requestedFilterSeen || hasRequestedBand) return null;
  return {
    code: 'filter_mismatch_previous_run',
    requestedNarrowScoreBand: requestedBand,
    observedNarrowScoreBands: bands,
    sourceFile: rows[0].__sourceFile || null,
  };
}

function pickCommonDates(symbols, timeframe = '2m') {
  const perSymbol = uniqueStrings(symbols, { upper: true })
    .map((symbol) => new Set(marketDataStore.listAvailableDates(symbol)[timeframe] || []));
  if (!perSymbol.length) return [];
  let common = [...perSymbol[0]];
  for (const dates of perSymbol.slice(1)) {
    common = common.filter((date) => dates.has(date));
  }
  return common.sort();
}

function pickDateWindow(symbols, days = 10, timeframe = '2m') {
  const common = pickCommonDates(symbols, timeframe);
  if (!common.length) return { date_from: null, date_to: null };
  const slice = common.slice(-Math.max(1, days));
  return { date_from: slice[0], date_to: slice[slice.length - 1] };
}

function dateWindowKey(dateFrom, dateTo, timeframe = '2m') {
  return `${dateFrom || ''}:${dateTo || ''}:${timeframe || ''}`;
}

function countBusinessDayGaps(dates = []) {
  const sorted = [...dates].sort();
  let gaps = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00Z`);
    const next = new Date(`${sorted[i]}T00:00:00Z`);
    if (Number.isNaN(prev.getTime()) || Number.isNaN(next.getTime())) continue;
    prev.setUTCDate(prev.getUTCDate() + 1);
    while (prev < next) {
      const day = prev.getUTCDay();
      if (day !== 0 && day !== 6) gaps += 1;
      prev.setUTCDate(prev.getUTCDate() + 1);
    }
  }
  return gaps;
}

function readAlreadyTestedWindows({ timeframe = '2m', symbols = DEFAULT_SYMBOLS } = {}) {
  const wantedSymbols = uniqueStrings(symbols, { upper: true }).sort();
  const windows = [];
  const seen = new Set();

  function add(entry = {}, source = 'unknown') {
    const dateFrom = entry.date_from || entry.dateFrom || entry.metadata?.date_from || entry.metadata?.dateFrom || null;
    const dateTo = entry.date_to || entry.dateTo || entry.metadata?.date_to || entry.metadata?.dateTo || null;
    if (!dateFrom || !dateTo) return;
    const entryTimeframes = uniqueStrings(entry.timeframes || entry.metadata?.timeframes || [timeframe]);
    if (entryTimeframes.length && !entryTimeframes.includes(timeframe)) return;
    const entrySymbols = uniqueStrings(entry.symbols || entry.metadata?.symbols || wantedSymbols, { upper: true }).sort();
    const sameSymbols = !entrySymbols.length || JSON.stringify(entrySymbols) === JSON.stringify(wantedSymbols);
    if (!sameSymbols) return;
    const key = dateWindowKey(dateFrom, dateTo, timeframe);
    if (seen.has(key)) return;
    seen.add(key);
    windows.push({
      dateFrom,
      dateTo,
      timeframe,
      symbols: entrySymbols.length ? entrySymbols : wantedSymbols,
      source,
      batchId: entry.batchId || entry.batch_id || entry.id || null,
      fingerprint: entry.fingerprint || null,
      completedAt: entry.completed_at || entry.completedAt || entry.batch_completed_at || null,
    });
  }

  readJsonl(path.join(LEARNING_DATA_DIR, 'strategy-batches', 'narrow-batch-fingerprints.jsonl'))
    .forEach((entry) => add(entry, 'narrow-batch-fingerprints'));

  const batches = safeReadJson(path.join(LEARNING_DATA_DIR, 'strategy-batches', 'batches-v1.json'), []);
  const list = Array.isArray(batches) ? batches : toArray(batches.batches);
  list.forEach((batch) => {
    const isNarrow = String(batch?.metadata?.run_type || batch?.name || '').toLowerCase().includes('narrow');
    if (isNarrow && ['completed', 'done'].includes(String(batch.status || '').toLowerCase())) add(batch, 'batches-v1');
  });

  return windows.sort((a, b) => `${a.dateFrom}:${a.dateTo}`.localeCompare(`${b.dateFrom}:${b.dateTo}`));
}

function makeEmptyWindowBandAvailability() {
  return { confirmed_narrow: 0, weak_narrow: 0, strong_compression: 0, not_narrow: 0 };
}

function windowBandRank(window = {}) {
  if (!window || typeof window !== 'object') return { rank: 0, band: null };
  const bands = window.bandAvailability || {};
  if (Number(bands.confirmed_narrow || 0) > 0) return { rank: 3, band: 'confirmed_narrow' };
  if (Number(bands.weak_narrow || 0) > 0) return { rank: 2, band: 'weak_narrow' };
  if (Number(bands.strong_compression || 0) > 0) return { rank: 1, band: 'strong_compression' };
  return { rank: 0, band: null };
}

function selectBestNarrowDateWindow(windows = []) {
  const candidates = toArray(windows).filter((window) => !window.alreadyTested);
  let bestWindow = null;
  for (const window of candidates) {
    const current = windowBandRank(window);
    if (!current.rank) continue;
    const best = windowBandRank(bestWindow);
    if (!bestWindow || current.rank > best.rank) bestWindow = window;
    else if (current.rank === best.rank) {
      const dateCmp = String(window.dateTo || '').localeCompare(String(bestWindow.dateTo || ''));
      if (dateCmp > 0) bestWindow = window;
      else if (dateCmp === 0 && Number(window.candleCount || 0) > Number(bestWindow.candleCount || 0)) bestWindow = window;
    }
  }
  return bestWindow;
}

function analyzeNarrowDateWindows({ symbols = DEFAULT_SYMBOLS, timeframe = '2m', windowTradingDays = DEFAULT_DATE_WINDOW_TRADING_DAYS } = {}) {
  const normalizedSymbols = uniqueStrings(symbols, { upper: true });
  const warnings = [];
  const perSymbol = {};
  const commonDates = pickCommonDates(normalizedSymbols, timeframe);
  const alreadyTestedWindows = readAlreadyTestedWindows({ symbols: normalizedSymbols, timeframe });
  const alreadyTestedKeys = new Set(alreadyTestedWindows.map((w) => dateWindowKey(w.dateFrom, w.dateTo, timeframe)));

  for (const symbol of normalizedSymbols) {
    const dates = marketDataStore.listAvailableDates(symbol)[timeframe] || [];
    const candleCount = dates.reduce((sum, date) => sum + marketDataStore.countCandles(symbol, date, timeframe), 0);
    perSymbol[symbol] = {
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      candleCount,
      tradingDays: dates.length,
      gaps: countBusinessDayGaps(dates),
      dates,
    };
    if (!dates.length) warnings.push(`no_${timeframe}_data:${symbol}`);
  }

  const windowSize = Math.max(1, clampInt(windowTradingDays, DEFAULT_DATE_WINDOW_TRADING_DAYS, 1, 60));
  const windows = [];
  if (commonDates.length < windowSize) {
    warnings.push(`common_window_too_short:${commonDates.length}<${windowSize}`);
  }

  for (let start = 0; start + windowSize <= commonDates.length; start += 1) {
    const windowDates = commonDates.slice(start, start + windowSize);
    const dateFrom = windowDates[0];
    const dateTo = windowDates[windowDates.length - 1];
    const bandAvailability = makeEmptyWindowBandAvailability();
    const symbolBands = {};
    let candleCount = 0;

    for (const symbol of normalizedSymbols) {
      const candles = loadCandles(symbol, dateFrom, dateTo, timeframe);
      candleCount += candles.length;
      if (!candles.length) {
        warnings.push(`window_no_symbol_candles:${symbol}:${timeframe}:${dateFrom}:${dateTo}`);
        continue;
      }
      const analysis = analyzeNarrowState({ symbol, timeframe, candles });
      const band = narrowPerformanceLearning.narrowScoreBand(analysis?.narrowScore);
      const normalizedBand = bandAvailability[band] != null ? band : 'not_narrow';
      bandAvailability[normalizedBand] += 1;
      symbolBands[symbol] = {
        band: normalizedBand,
        narrowScore: analysis?.narrowScore ?? null,
        candleCount: candles.length,
      };
    }

    const alreadyTested = alreadyTestedKeys.has(dateWindowKey(dateFrom, dateTo, timeframe));
    const hasAllowedBand = WINDOW_BAND_PRIORITY.some((band) => bandAvailability[band] > 0);
    const preferred = windowBandRank({ bandAvailability }).band;
    windows.push({
      dateFrom,
      dateTo,
      timeframe,
      symbols: normalizedSymbols,
      candleCount,
      tradingDays: windowDates.length,
      bandAvailability,
      symbolBands,
      alreadyTested,
      recommended: false,
      reason: alreadyTested
        ? 'identical_window_already_tested'
        : hasAllowedBand
          ? `${preferred}_available`
          : 'no_matching_narrow_windows',
    });
  }

  const bestWindow = selectBestNarrowDateWindow(windows);
  for (const window of windows) {
    if (bestWindow && window.dateFrom === bestWindow.dateFrom && window.dateTo === bestWindow.dateTo && window.timeframe === bestWindow.timeframe) {
      window.recommended = true;
      window.reason = `selected_${windowBandRank(window).band}`;
    }
  }
  if (!bestWindow && windows.length) warnings.push('no_matching_narrow_windows');

  return {
    windows,
    bestWindow: bestWindow || null,
    warnings,
    symbols: normalizedSymbols,
    timeframe,
    commonDateWindow: {
      dateFrom: commonDates[0] || null,
      dateTo: commonDates[commonDates.length - 1] || null,
      tradingDays: commonDates.length,
    },
    perSymbol,
    alreadyTestedWindows,
  };
}

function emptyBandAvailability(requestedBand) {
  return {
    requestedBand: requestedBand || DEFAULT_BAND,
    availableBands: {
      confirmed_narrow: { rows: 0, estimatedTrades: 0, symbols: [] },
      weak_narrow: { rows: 0, estimatedTrades: 0, symbols: [] },
      strong_compression: { rows: 0, estimatedTrades: 0, symbols: [] },
    },
    blockedBands: {
      not_narrow: { ...BLOCKED_TEST_BANDS.not_narrow },
    },
    selectedBand: null,
    selectionReason: 'no_matching_narrow_bands',
    warnings: [],
  };
}

function selectNarrowScoreBand(availability = {}) {
  const availableBands = availability.availableBands || {};
  const hasRows = (band) => Number(availableBands[band]?.rows || 0) > 0;
  const warnings = Array.isArray(availability.warnings) ? [...availability.warnings] : [];

  if (hasRows('confirmed_narrow')) {
    return { selectedBand: 'confirmed_narrow', selectionReason: 'confirmed_narrow_available', warnings };
  }
  if (hasRows('weak_narrow')) {
    warnings.push('fallback_from_confirmed_to_weak');
    return { selectedBand: 'weak_narrow', selectionReason: 'confirmed_missing_weak_available', warnings };
  }
  if (hasRows('strong_compression')) {
    return { selectedBand: 'strong_compression', selectionReason: 'only_strong_compression_available', warnings };
  }
  warnings.push('no_matching_narrow_bands');
  return { selectedBand: null, selectionReason: 'no_matching_narrow_bands', warnings };
}

function addAvailabilityHit(availability, band, symbol, strategyCount) {
  if (!ALLOWED_TEST_BANDS.includes(band)) return;
  const bucket = availability.availableBands[band];
  bucket.rows += strategyCount;
  bucket.estimatedTrades += strategyCount;
  if (symbol && !bucket.symbols.includes(symbol)) bucket.symbols.push(symbol);
}

function analyzeNarrowBandAvailability(plan = {}) {
  if (plan.bandAvailabilityOverride && typeof plan.bandAvailabilityOverride === 'object') {
    const base = {
      ...emptyBandAvailability(plan.filters?.narrowScoreBand || plan.requestedNarrowScoreBand || DEFAULT_BAND),
      ...plan.bandAvailabilityOverride,
    };
    const selected = selectNarrowScoreBand(base);
    return { ...base, ...selected };
  }

  const requestedBand = String(plan.filters?.narrowScoreBand || plan.requestedNarrowScoreBand || DEFAULT_BAND).trim();
  const availability = emptyBandAvailability(requestedBand);
  const symbols = uniqueStrings(plan.symbols, { upper: true });
  const timeframes = uniqueStrings(plan.timeframes).filter((tf) => tf === '2m');
  const strategyCount = Math.max(1, narrowStrategyIds().size || 3);

  if (!symbols.length) availability.warnings.push('band_availability_no_symbols');
  if (!timeframes.length) availability.warnings.push('band_availability_no_2m_timeframe');

  for (const timeframe of timeframes) {
    const selectedWindow = plan.dateWindowSelected && plan.dateWindowSelected.timeframe === timeframe ? plan.dateWindowSelected : null;
    const { date_from, date_to } = selectedWindow
      ? { date_from: selectedWindow.dateFrom, date_to: selectedWindow.dateTo }
      : pickDateWindow(symbols, 10, timeframe);
    if (!date_from || !date_to) {
      availability.warnings.push(`band_availability_no_candles:${timeframe}`);
      continue;
    }

    for (const symbol of symbols) {
      const candles = loadCandles(symbol, date_from, date_to, timeframe);
      if (!candles.length) {
        availability.warnings.push(`band_availability_no_symbol_candles:${symbol}:${timeframe}`);
        continue;
      }
      const analysis = analyzeNarrowState({ symbol, timeframe, candles });
      const band = narrowPerformanceLearning.narrowScoreBand(analysis?.narrowScore);
      if (band === 'not_narrow') {
        const blocked = availability.blockedBands.not_narrow;
        blocked.rows = (blocked.rows || 0) + strategyCount;
        blocked.estimatedTrades = (blocked.estimatedTrades || 0) + strategyCount;
        blocked.symbols = [...new Set([...(blocked.symbols || []), symbol])];
      } else {
        addAvailabilityHit(availability, band, symbol, strategyCount);
      }
    }
  }

  for (const band of ALLOWED_TEST_BANDS) {
    availability.availableBands[band].symbols.sort();
  }
  if (availability.blockedBands.not_narrow?.symbols) availability.blockedBands.not_narrow.symbols.sort();

  const selected = selectNarrowScoreBand(availability);
  return { ...availability, ...selected };
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
  let requestedNarrowScoreBand = DEFAULT_BAND;
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
    requestedNarrowScoreBand = String(f.narrowScoreBand || DEFAULT_BAND);
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

  const dateWindowRequested = {
    timeframe: '2m',
    tradingDays: DEFAULT_DATE_WINDOW_TRADING_DAYS,
    requestedBand: requestedNarrowScoreBand,
    symbols,
  };
  const dateWindowAnalysis = analyzeNarrowDateWindows({ symbols, timeframe: '2m', windowTradingDays: DEFAULT_DATE_WINDOW_TRADING_DAYS });
  const dateWindowSelected = dateWindowAnalysis.bestWindow;
  const selectedWindowBand = dateWindowSelected ? windowBandRank(dateWindowSelected).band : null;
  const freshnessStatus = dateWindowSelected
    ? (dateWindowSelected.dateTo === dateWindowAnalysis.commonDateWindow.dateTo ? 'fresh_common_window' : 'older_matching_window')
    : (dateWindowAnalysis.commonDateWindow.dateTo ? 'no_matching_narrow_window_in_available_data' : 'missing_2m_data');
  for (const w of dateWindowAnalysis.warnings) {
    if (!warnings.includes(w)) warnings.push(w);
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
    requestedNarrowScoreBand,
    filters: {
      narrowScoreBand: requestedNarrowScoreBand,
      confirmations,
      confirmationQuality,
      marketGroup: inferMarketGroup(symbols),
    },
    filterEnforcement: {
      requestedNarrowScoreBand,
      enforceable: true,
      expectedNoMatchStatus: 'skipped_no_matching_band',
      expectedNoMatchResult: 'no_matching_setups',
    },
    dateWindowRequested,
    dateWindowSelected,
    dateWindowAvailability: {
      windows: dateWindowAnalysis.windows,
      bestWindow: dateWindowSelected,
      commonDateWindow: dateWindowAnalysis.commonDateWindow,
      perSymbol: dateWindowAnalysis.perSymbol,
      warnings: dateWindowAnalysis.warnings,
    },
    freshnessStatus,
    alreadyTestedWindows: dateWindowAnalysis.alreadyTestedWindows,
    windowSelectionReason: dateWindowSelected
      ? dateWindowSelected.reason
      : 'no_matching_narrow_windows',
    limits,
    safety: { ...SAFETY },
    status: 'planned',
    warnings,
    nextStep: 'validate',
  };

  const bandAvailability = analyzeNarrowBandAvailability({
    ...plan,
    bandAvailabilityOverride: options.bandAvailabilityOverride,
  });
  if (!options.bandAvailabilityOverride && dateWindowSelected) {
    const strategyCount = Math.max(1, narrowStrategyIds().size || 3);
    const selectedAvailability = emptyBandAvailability(requestedNarrowScoreBand);
    for (const band of ALLOWED_TEST_BANDS) {
      const symbolHits = Object.entries(dateWindowSelected.symbolBands || {})
        .filter(([, row]) => row?.band === band)
        .map(([symbol]) => symbol)
        .sort();
      selectedAvailability.availableBands[band] = {
        rows: symbolHits.length * strategyCount,
        estimatedTrades: symbolHits.length * strategyCount,
        symbols: symbolHits,
      };
    }
    selectedAvailability.blockedBands.not_narrow = {
      ...selectedAvailability.blockedBands.not_narrow,
      rows: Number(dateWindowSelected.bandAvailability?.not_narrow || 0) * strategyCount,
      estimatedTrades: Number(dateWindowSelected.bandAvailability?.not_narrow || 0) * strategyCount,
      symbols: Object.entries(dateWindowSelected.symbolBands || {})
        .filter(([, row]) => row?.band === 'not_narrow')
        .map(([symbol]) => symbol)
        .sort(),
    };
    Object.assign(bandAvailability, selectedAvailability, selectNarrowScoreBand(selectedAvailability));
  }
  plan.bandAvailability = bandAvailability;
  plan.bandSelection = {
    requestedNarrowScoreBand,
    selectedNarrowScoreBand: bandAvailability.selectedBand,
    selectionReason: bandAvailability.selectionReason,
  };
  plan.bandSelectionWarnings = bandAvailability.warnings;
  plan.selectedNarrowScoreBand = bandAvailability.selectedBand;
  plan.filters.narrowScoreBand = bandAvailability.selectedBand;
  plan.filterEnforcement.selectedNarrowScoreBand = bandAvailability.selectedBand;
  plan.filterEnforcement.bandSelection = plan.bandSelection;
  plan.filterEnforcement.bandAvailability = bandAvailability;
  if (requestedNarrowScoreBand !== bandAvailability.selectedBand && bandAvailability.selectedBand) {
    plan.warnings.push(`selected_band_differs_from_requested:${requestedNarrowScoreBand}->${bandAvailability.selectedBand}`);
  }
  for (const warning of bandAvailability.warnings) {
    if (!plan.warnings.includes(warning)) plan.warnings.push(warning);
  }
  if (!bandAvailability.selectedBand) {
    plan.status = dateWindowSelected ? 'no_matching_narrow_bands' : 'no_matching_narrow_windows';
    plan.nextStep = dateWindowSelected ? 'collect_more_data_or_broaden_date_window' : 'collect_more_2m_data_or_expand_symbols';
  }
  if (dateWindowSelected && selectedWindowBand && bandAvailability.selectedBand !== selectedWindowBand) {
    plan.warnings.push(`selected_band_differs_from_window:${selectedWindowBand}->${bandAvailability.selectedBand || 'none'}`);
  }

  const mismatch = detectPreviousFilterMismatch(plan);
  if (mismatch) {
    plan.warnings.push(mismatch.code);
    plan.filterEnforcement.previousRunWarning = mismatch;
  }

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
  if (!plan.selectedNarrowScoreBand && !plan.filters?.narrowScoreBand) {
    reasons.push(plan.status === 'no_matching_narrow_windows' ? 'no_matching_narrow_windows' : 'no_matching_narrow_bands');
  }
  if (plan.selectedNarrowScoreBand === 'not_narrow' || plan.filters?.narrowScoreBand === 'not_narrow') {
    reasons.push('not_narrow_not_allowed_for_narrow_strategy');
  }

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
    filterEnforcement: {
      ...(plan.filterEnforcement || {}),
      requestedNarrowScoreBand: plan.requestedNarrowScoreBand || plan.filterEnforcement?.requestedNarrowScoreBand || null,
      selectedNarrowScoreBand: plan.selectedNarrowScoreBand || plan.filters?.narrowScoreBand || null,
      enforceable: true,
      expectedNoMatchStatus: 'skipped_no_matching_band',
      expectedNoMatchResult: 'no_matching_setups',
    },
    safety: { ...SAFETY },
    status: blocked
      ? (reasons.includes('no_matching_narrow_windows') ? 'no_matching_narrow_windows'
        : reasons.includes('no_matching_narrow_bands') ? 'no_matching_narrow_bands'
          : 'blocked')
      : 'validated',
    warnings,
    nextStep: blocked
      ? (reasons.includes('no_matching_narrow_windows') ? 'collect_more_2m_data_or_expand_symbols'
        : reasons.includes('no_matching_narrow_bands') ? 'collect_more_data_or_broaden_date_window'
          : 'fix_plan')
      : (plan.testType === 'batch' || plan.testType === 'replay' || plan.testType === 'paper' ? 'run_or_queue' : 'fix_plan'),
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
    const noMatchingBands = validation.reasons.includes('no_matching_narrow_bands');
    const noMatchingWindows = validation.reasons.includes('no_matching_narrow_windows');
    return {
      ok: false, blocked: true, dryRun,
      reasons: validation.reasons,
      plan: finalPlan, mode: MODE, ...SAFETY,
      message_sv: noMatchingWindows
        ? 'Dry-run: inga körbara narrow-fönster hittades i riktig 2m-data. Samla mer/färskare data eller bredda symbolerna.'
        : noMatchingBands
        ? 'Dry-run: inga körbara narrow-band finns i aktuell 2m-data. not_narrow används inte som giltigt narrow-test. Samla mer data eller bredda datum/symboler.'
        : 'Planen blockerades av säkerhetsvalideringen. Inget test kördes.',
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
    const requestedBand = String(finalPlan.requestedNarrowScoreBand || finalPlan.filterEnforcement?.requestedNarrowScoreBand || '').trim();
    const selectedBand = String(finalPlan.selectedNarrowScoreBand || finalPlan.filters?.narrowScoreBand || '').trim();
    const selectedWindow = finalPlan.dateWindowSelected || {};
    const proc = spawnSync('node', [CLEAN_BATCH_SCRIPT], {
      cwd: path.resolve(__dirname, '../..'),
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NARROW_BATCH_TIMEFRAMES: planTimeframes,
        NARROW_BATCH_REQUESTED_NARROW_SCORE_BAND: requestedBand,
        NARROW_BATCH_SELECTED_NARROW_SCORE_BAND: selectedBand,
        NARROW_BATCH_NARROW_SCORE_BAND: selectedBand,
        NARROW_BATCH_DATE_FROM: selectedWindow.dateFrom || '',
        NARROW_BATCH_DATE_TO: selectedWindow.dateTo || '',
      },
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
  analyzeNarrowBandAvailability,
  analyzeNarrowDateWindows,
  selectBestNarrowDateWindow,
  selectNarrowScoreBand,
};
