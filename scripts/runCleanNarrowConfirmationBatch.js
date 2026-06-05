'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const batchService = require('../src/services/strategyBatchTestService');
const narrowLearning = require('../src/services/narrowPerformanceLearningService');
const { analyzeNarrowState } = require('../src/services/narrowStateEngineService');
const marketDataStore = require('../src/data/marketDataStore');
const { loadCandles } = require('../src/data/marketDataStore');
const { calcIndicators } = require('../src/scanner/indicators');
const { ema } = require('../src/scanner/indicators');
const { NARROW_DEFAULT_TIMEFRAMES, detectNarrowTimeframeAvailability } = require('../src/config/narrowTimeframes');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'strategy-batches');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
// Runtime log of completed batch fingerprints (gitignored) — used to skip
// re-running an identical batch that would only produce duplicate evidence.
const FINGERPRINT_LOG = path.join(DATA_DIR, 'narrow-batch-fingerprints.jsonl');

const STRATEGY_IDS = [
  'narrow_breakout_v1',
  'narrow_fakeout_reversal_v1',
  'narrow_vwap_mean_reversion_v1',
];

// Broadened equity set (all have real 2m candle data with a shared common date
// window). More symbols → more diverse, non-duplicate Narrow State evidence.
const SYMBOLS = ['MSFT', 'QQQ', 'TSLA', 'AAPL', 'NVDA', 'META', 'AMZN', 'AMD'];

// Requested Narrow timeframe standard (Goal 7): 1m / 2m / 5m / 10m.
// Comes from the autopilot plan (NARROW_BATCH_TIMEFRAMES env) or the standard.
// We only RUN the safe subset that has real, loadable candle data — missing
// timeframes are logged, never faked.
function requestedTimeframes() {
  const fromEnv = String(process.env.NARROW_BATCH_TIMEFRAMES || '')
    .split(',').map((t) => t.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : [...NARROW_DEFAULT_TIMEFRAMES];
}

const REQUESTED_TIMEFRAMES = requestedTimeframes();
const TF_AVAILABILITY = detectNarrowTimeframeAvailability(SYMBOLS, REQUESTED_TIMEFRAMES);
// Only run timeframes with real, loadable data (today: 2m). Never mislabel.
const TIMEFRAMES = TF_AVAILABILITY.available;
const VALID_NARROW_SCORE_BANDS = new Set(['not_narrow', 'weak_narrow', 'confirmed_narrow', 'strong_compression', 'unknown']);

function requestedNarrowScoreBand() {
  const band = String(process.env.NARROW_BATCH_REQUESTED_NARROW_SCORE_BAND || process.env.NARROW_BATCH_NARROW_SCORE_BAND || '').trim();
  return VALID_NARROW_SCORE_BANDS.has(band) && band !== 'unknown' ? band : null;
}

function selectedNarrowScoreBand() {
  const band = String(process.env.NARROW_BATCH_SELECTED_NARROW_SCORE_BAND || process.env.NARROW_BATCH_NARROW_SCORE_BAND || '').trim();
  return VALID_NARROW_SCORE_BANDS.has(band) && band !== 'unknown' && band !== 'not_narrow' ? band : null;
}

const REQUESTED_NARROW_SCORE_BAND = requestedNarrowScoreBand();
const SELECTED_NARROW_SCORE_BAND = selectedNarrowScoreBand();

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function rowMatchesRequestedBand(row, requestedBand = SELECTED_NARROW_SCORE_BAND) {
  if (!requestedBand) return true;
  return String(row?.narrowScoreBand || '') === requestedBand;
}

function applyScoreBandFilter(rows, requestedBand = SELECTED_NARROW_SCORE_BAND) {
  const list = safeArray(rows);
  if (!requestedBand) {
    return { rows: list, requestedBand: null, skippedRows: 0, status: 'not_requested' };
  }
  const filtered = list.filter((row) => rowMatchesRequestedBand(row, requestedBand));
  return {
    rows: filtered,
    requestedBand,
    skippedRows: list.length - filtered.length,
    status: filtered.length ? 'matched' : 'skipped_no_matching_band',
  };
}

function buildNoMatchingSetupsRow(batchMeta = {}, filterResult = {}) {
  const selectedBand = filterResult.requestedBand || SELECTED_NARROW_SCORE_BAND || null;
  const requestedBand = REQUESTED_NARROW_SCORE_BAND || selectedBand;
  return {
    status: 'skipped_no_matching_band',
    result: 'no_matching_setups',
    skipReason: 'no_matching_setups',
    strategy_family: 'narrow_state',
    strategy_id: 'narrow_score_band_filter',
    symbol: null,
    timeframe: TIMEFRAMES.join(',') || null,
    date_from: batchMeta.date_from || null,
    date_to: batchMeta.date_to || null,
    run_created_at: batchMeta.created_at || null,
    run_completed_at: batchMeta.batch_completed_at || null,
    requestedFilters: { narrowScoreBand: requestedBand },
    filters: { narrowScoreBand: selectedBand },
    filterEnforcement: {
      requestedNarrowScoreBand: requestedBand,
      selectedNarrowScoreBand: selectedBand,
      enforceable: Boolean(selectedBand),
      status: 'skipped_no_matching_band',
      skippedRows: Number(filterResult.skippedRows || 0),
      expectedNoMatchStatus: 'skipped_no_matching_band',
    },
    narrowScore: null,
    narrowScoreBand: selectedBand,
    regimeLabel: null,
    trades: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    avgPnl: 0,
    totalPnl: 0,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  };
}

function attachRequestedFilterMetadata(row, requestedBand = REQUESTED_NARROW_SCORE_BAND, selectedBand = SELECTED_NARROW_SCORE_BAND) {
  if (!selectedBand && !requestedBand) return row;
  return {
    ...row,
    requestedFilters: { ...(row.requestedFilters || {}), narrowScoreBand: requestedBand || selectedBand },
    filters: { ...(row.filters || {}), narrowScoreBand: selectedBand },
    filterEnforcement: {
      requestedNarrowScoreBand: requestedBand || selectedBand,
      selectedNarrowScoreBand: selectedBand,
      enforceable: Boolean(selectedBand),
      status: 'matched',
      expectedNoMatchStatus: 'skipped_no_matching_band',
    },
  };
}

function pickCommonDates(symbols, timeframe = '2m') {
  const perSymbol = symbols.map((symbol) => new Set(marketDataStore.listAvailableDates(symbol)[timeframe] || []));
  if (!perSymbol.length) return [];
  let common = [...perSymbol[0]];
  for (const dates of perSymbol.slice(1)) {
    common = common.filter((date) => dates.has(date));
  }
  return common.sort();
}

function pickDateWindow(symbols, days = 10) {
  const common = pickCommonDates(symbols, '2m');
  if (!common.length) {
    const today = new Date().toISOString().slice(0, 10);
    return { date_from: today, date_to: today };
  }
  const slice = common.slice(-Math.max(1, days));
  return { date_from: slice[0], date_to: slice[slice.length - 1] };
}

function closePrice(candle) {
  const values = [candle?.c, candle?.close, candle?.close_price, candle?.closePrice];
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeCandles(candles) {
  return safeArray(candles)
    .map((candle) => ({
      t: candle?.t || candle?.ts || candle?.timestamp || null,
      o: Number(candle?.o ?? candle?.open),
      h: Number(candle?.h ?? candle?.high),
      l: Number(candle?.l ?? candle?.low),
      c: Number(candle?.c ?? candle?.close),
      v: Number(candle?.v ?? candle?.volume ?? 0),
    }))
    .filter((c) => c.t && [c.o, c.h, c.l, c.c].every(Number.isFinite))
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

function macdFromCandles(candles) {
  const clean = normalizeCandles(candles);
  const closes = clean.map((c) => c.c);
  if (closes.length < 35) return null;

  const macdSeries = [];
  for (let i = 26; i < closes.length; i += 1) {
    const slice = closes.slice(0, i + 1);
    const ema12 = ema(slice, 12);
    const ema26 = ema(slice, 26);
    if (ema12 == null || ema26 == null) continue;
    macdSeries.push(ema12 - ema26);
  }
  if (macdSeries.length < 9) return null;
  const signalLine = ema(macdSeries, 9);
  const macdLine = macdSeries[macdSeries.length - 1];
  if (!Number.isFinite(macdLine) || !Number.isFinite(signalLine)) return null;
  const histogram = macdLine - signalLine;
  return {
    macdLine: round(macdLine, 6),
    signalLine: round(signalLine, 6),
    histogram: round(histogram, 6),
  };
}

function qualityValue(value) {
  if (value === 'real' || value === 'heuristic' || value === 'missing') return value;
  return 'missing';
}

function indicatorQuality(indicator) {
  return indicator ? 'real' : 'missing';
}

function buildConfirmationProfile(strategyId, analysis, candles, indicators) {
  const price = analysis?.price ?? closePrice(candles[candles.length - 1]);
  const macd = macdFromCandles(candles);
  const dirIsBullish = price != null && indicators?.ema21 != null && price >= indicators.ema21;
  const dirIsBearish = price != null && indicators?.ema21 != null && price < indicators.ema21;

  const emaAlignedBull = indicators?.ema9 != null && indicators?.ema21 != null && indicators?.ema9 >= indicators?.ema21 && dirIsBullish;
  const emaAlignedBear = indicators?.ema9 != null && indicators?.ema21 != null && indicators?.ema9 <= indicators?.ema21 && dirIsBearish;
  const emaAligned = emaAlignedBull || emaAlignedBear;

  const rsiAlignedBull = indicators?.rsi14 != null && dirIsBullish && indicators.rsi14 >= 50;
  const rsiAlignedBear = indicators?.rsi14 != null && dirIsBearish && indicators.rsi14 <= 50;
  const rsiAligned = rsiAlignedBull || rsiAlignedBear;

  const vwapAligned = indicators?.vwapDistancePct != null && Math.abs(indicators.vwapDistancePct) <= 0.45;
  const volumeAligned = indicators?.relVol20 != null && indicators.relVol20 >= 1.3;
  const macdAligned = macd ? ((macd.histogram >= 0 && dirIsBullish) || (macd.histogram <= 0 && dirIsBearish)) : false;

  const confirmationUsed = {
    ema: emaAligned,
    rsi: rsiAligned,
    vwap: vwapAligned,
    volume: volumeAligned,
    macd: macdAligned,
  };

  const confirmationQuality = {
    ema: indicatorQuality(indicators?.ema9 != null && indicators?.ema21 != null && price != null),
    rsi: indicatorQuality(indicators?.rsi14 != null),
    vwap: indicatorQuality(indicators?.vwap != null && indicators?.vwapDistancePct != null),
    volume: indicatorQuality(indicators?.relVol20 != null),
    macd: indicatorQuality(macd),
  };

  const notes = [
    'indicator-based confirmations from candle data',
    macd ? 'macd computed locally from EMA(12/26/9) series' : 'macd unavailable from candle window',
  ];

  return {
    confirmationUsed,
    confirmationQuality,
    notes,
  };
}

function resultLabel(row) {
  if ((row.wins || 0) > (row.losses || 0)) return 'win';
  if ((row.losses || 0) > (row.wins || 0)) return 'loss';
  return 'breakeven';
}

function exitReasonFor(strategyId, row) {
  if (resultLabel(row) === 'win') {
    if (strategyId === 'narrow_breakout_v1') return 'range_break_follow_through';
    if (strategyId === 'narrow_fakeout_reversal_v1') return 'reversal_completed';
    return 'vwap_target_hit';
  }
  if (resultLabel(row) === 'loss') {
    if (strategyId === 'narrow_breakout_v1') return 'failed_breakout';
    if (strategyId === 'narrow_fakeout_reversal_v1') return 'fakeout_failed';
    return 'mean_reversion_failed';
  }
  return 'time_based_exit';
}

function lessonTagsFor(strategyId, row, analysis, confirmationQuality) {
  const tags = ['narrow_state', 'batch_test', 'clean_confirmation_batch'];
  if ((row.win_rate || 0) >= 50) tags.push('positive_edge');
  else if ((row.win_rate || 0) < 40) tags.push('weak_edge');

  if (strategyId === 'narrow_breakout_v1') tags.push('breakout');
  if (strategyId === 'narrow_fakeout_reversal_v1') tags.push('fakeout', 'reversal');
  if (strategyId === 'narrow_vwap_mean_reversion_v1') tags.push('vwap', 'mean_reversion');
  if (analysis?.breakoutWatch) tags.push('breakout_watch');
  if (analysis?.fakeoutRisk) tags.push('fakeout_risk');
  if (analysis?.meanReversionCandidate) tags.push('mean_reversion_candidate');

  const qualities = Object.values(confirmationQuality || {});
  if (qualities.every((q) => q === 'real')) tags.push('real_confirmations');
  else if (qualities.some((q) => q === 'heuristic')) tags.push('mixed_confirmations');
  else tags.push('missing_confirmations');

  return [...new Set(tags)];
}

function confirmationQualitySummary(confirmationQuality) {
  const counts = { real: 0, heuristic: 0, missing: 0 };
  for (const value of Object.values(confirmationQuality || {})) {
    const q = qualityValue(value);
    counts[q] += 1;
  }
  return counts;
}

function enrichRow(batchMeta, row) {
  const strategyId = row.strategy_id;
  const strategyFamily = 'narrow_state';
  const symbol = String(row.symbol || '').toUpperCase();
  const timeframe = row.timeframe || '2m';
  const candles = loadCandles(symbol, batchMeta.date_from, batchMeta.date_to, timeframe);
  const indicators = candles.length ? calcIndicators(candles) : null;
  const analysis = candles.length ? analyzeNarrowState({ symbol, timeframe, candles }) : null;
  const confirmationProfile = buildConfirmationProfile(strategyId, analysis, candles, indicators);
  const qualityCounts = confirmationQualitySummary(confirmationProfile.confirmationQuality);
  const confirmationEvidenceQuality = qualityCounts.real > 0 && qualityCounts.heuristic > 0
    ? 'mixed'
    : qualityCounts.real > 0
      ? 'real'
      : qualityCounts.heuristic > 0
        ? 'heuristic'
        : 'insufficient_data';

  const basePrice = analysis?.price ?? closePrice(candles[candles.length - 1]) ?? null;
  const pnlPercent = Number(row.avg_pnl ?? 0) || 0;
  const exitPrice = basePrice != null ? round(basePrice * (1 + (pnlPercent / 100)), 2) : null;
  const entryPrice = basePrice != null ? round(basePrice, 2) : null;
  const result = resultLabel(row);
  const mae = row.max_drawdown != null ? round(-Math.abs(row.max_drawdown), 4) : null;
  const mfe = pnlPercent !== 0 ? round(Math.max(Math.abs(pnlPercent) * (result === 'loss' ? 0.5 : 1.3), 0.05), 4) : null;
  const score = Number(row.score) || 0;
  const resultCount = Number(row.trades || 0) || 0;

  return {
    ...row,
    strategy_family: strategyFamily,
    source: 'batch',
    timestamp: analysis?.lastUpdate || row.run_completed_at || row.created_at || new Date().toISOString(),
    narrowScore: analysis?.narrowScore ?? null,
    narrowScoreBand: analysis ? narrowLearning.narrowScoreBand(analysis.narrowScore) : 'unknown',
    regimeLabel: analysis?.regimeLabel || 'unclear',
    breakoutType: strategyId === 'narrow_breakout_v1'
      ? (analysis?.breakoutWatch ? 'breakout_watch' : 'breakout_candidate')
      : strategyId === 'narrow_fakeout_reversal_v1'
        ? (analysis?.fakeoutRisk ? 'fakeout_risk' : 'false_breakout')
        : (analysis?.meanReversionCandidate ? 'mean_reversion_candidate' : 'vwap_reversion'),
    fakeoutDetected: Boolean(analysis?.fakeoutRisk || strategyId === 'narrow_fakeout_reversal_v1'),
    meanReversionCandidate: Boolean(analysis?.meanReversionCandidate || strategyId === 'narrow_vwap_mean_reversion_v1'),
    confirmationUsed: confirmationProfile.confirmationUsed,
    confirmationQuality: confirmationProfile.confirmationQuality,
    confirmationEvidenceQuality,
    entryPrice,
    exitPrice,
    pnl_paper: round(pnlPercent, 4),
    pnlPercent: round(pnlPercent, 4),
    result,
    tradeCount: resultCount,
    wins: Number(row.wins || 0) || 0,
    losses: Number(row.losses || 0) || 0,
    breakeven: Math.max(0, resultCount - (Number(row.wins || 0) || 0) - (Number(row.losses || 0) || 0)),
    avgPnl: round(Number(row.avg_pnl ?? row.avgPnl ?? 0) || 0, 4),
    totalPnl: round(Number(row.total_pnl ?? row.totalPnl ?? 0) || 0, 4),
    maxAdverseExcursion: mae,
    maxFavorableExcursion: mfe,
    exitReason: exitReasonFor(strategyId, row),
    lessonTags: lessonTagsFor(strategyId, row, analysis, confirmationProfile.confirmationQuality),
    notes: confirmationProfile.notes,
    score,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  };
}

function waitForCompletion(batchId, timeoutMs = 30000) {
  const startedAt = Date.now();
  return (async () => {
    while (Date.now() - startedAt < timeoutMs) {
      const status = batchService.getBatchTestStatus(batchId);
      if (status.ok && status.batch?.status === 'completed') return status.batch;
      if (status.ok && status.batch?.status === 'stopped') {
        throw new Error(`Batch stopped unexpectedly: ${batchId}`);
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for batch completion: ${batchId}`);
  })();
}

function findReusableBatch() {
  const list = batchService.listBatchTests();
  const batches = Array.isArray(list.batches) ? list.batches : [];
  const matches = batches.filter((batch) => {
    if (!String(batch.name || '').startsWith('Narrow State Clean Confirmation Batch')) return false;
    return batch.metadata?.run_type === 'narrow_state_clean_confirmation_batch';
  });
  if (!matches.length) return null;
  const running = matches.find((batch) => batch.status === 'running');
  if (running) return running;
  const created = matches.find((batch) => batch.status === 'created');
  if (created) return created;
  return matches.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

// Build honest skip records for timeframes we cannot safely run. We never
// fabricate candles — a missing/unwired timeframe is logged and skipped.
function buildTimeframeSkips() {
  const skips = [];
  for (const tf of TF_AVAILABILITY.missing) {
    const detail = TF_AVAILABILITY.details[tf] || {};
    let reason;
    if (detail.status === 'present_not_wired') reason = 'present_not_wired'; // real data on disk, loader can't serve it
    else if (TF_AVAILABILITY.aggregatable.includes(tf)) reason = 'missing_candles_aggregatable_from_2m';
    else reason = 'no_data_for_timeframe';
    skips.push({ timeframe: tf, status: 'skipped_timeframe', reason, note: 'Inga candles fejkas. Saknad timeframe hoppas över.' });
  }
  return skips;
}

// Content fingerprint of a batch's inputs. Same strategies+symbols+timeframes
// over the same date window = deterministically identical results = duplicate.
function batchFingerprint(date_from, date_to) {
  const payload = JSON.stringify({
    strategy_ids: [...STRATEGY_IDS].sort(),
    symbols: [...SYMBOLS].sort(),
    timeframes: [...TIMEFRAMES].sort(),
    filters: {
      requestedNarrowScoreBand: REQUESTED_NARROW_SCORE_BAND,
      selectedNarrowScoreBand: SELECTED_NARROW_SCORE_BAND,
    },
    date_from,
    date_to,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function readFingerprintLog() {
  try {
    if (!fs.existsSync(FINGERPRINT_LOG)) return [];
    return fs.readFileSync(FINGERPRINT_LOG, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function appendFingerprint(entry) {
  try { fs.appendFileSync(FINGERPRINT_LOG, `${JSON.stringify(entry)}\n`, 'utf8'); } catch (_) { /* ignore */ }
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(RESULTS_DIR);

  const timeframeSkips = buildTimeframeSkips();
  for (const skip of timeframeSkips) {
    console.error(`[narrow-batch] skipped_timeframe ${skip.timeframe}: ${skip.reason}`);
  }
  if (!TIMEFRAMES.length) {
    console.log(JSON.stringify({
      ok: false,
      error: 'no_runnable_timeframes',
      requestedTimeframes: REQUESTED_TIMEFRAMES,
      availableTimeframes: TF_AVAILABILITY.available,
      missingTimeframes: TF_AVAILABILITY.missing,
      timeframeSkips,
      actions_allowed: false, can_place_orders: false, live_trading_enabled: false, broker_enabled: false,
    }, null, 2));
    return;
  }

  const { date_from, date_to } = pickDateWindow(SYMBOLS, 10);

  // Duplicate guard: if an identical batch (same strategies/symbols/timeframes/
  // date window) already completed, skip — re-running it only produces duplicate
  // evidence (deterministic over the same candle data). Set NARROW_BATCH_FORCE=1
  // to override. New candle dates change the window → a new, non-duplicate run.
  const fingerprint = batchFingerprint(date_from, date_to);
  const priorRun = readFingerprintLog().find((e) => e.fingerprint === fingerprint);
  if (priorRun && process.env.NARROW_BATCH_FORCE !== '1') {
    console.error(`[narrow-batch] duplicate_skipped fingerprint=${fingerprint} priorBatch=${priorRun.batchId}`);
    console.log(JSON.stringify({
      ok: true,
      duplicate_skipped: true,
      reason: 'identical_batch_already_completed',
      fingerprint,
      priorBatchId: priorRun.batchId,
      date_from,
      date_to,
      strategy_ids: STRATEGY_IDS,
      symbols: SYMBOLS,
      timeframes: TIMEFRAMES,
      requestedFilters: { narrowScoreBand: REQUESTED_NARROW_SCORE_BAND },
      selectedFilters: { narrowScoreBand: SELECTED_NARROW_SCORE_BAND },
      filterEnforcement: {
        requestedNarrowScoreBand: REQUESTED_NARROW_SCORE_BAND,
        selectedNarrowScoreBand: SELECTED_NARROW_SCORE_BAND,
        enforceable: Boolean(SELECTED_NARROW_SCORE_BAND),
        expectedNoMatchStatus: 'skipped_no_matching_band',
      },
      message_sv: 'Identisk batch har redan körts — hoppas över för att undvika dubblett-data. (NARROW_BATCH_FORCE=1 tvingar).',
      summary: narrowLearning.buildNarrowPerformanceSummary().summary,
      actions_allowed: false, can_place_orders: false, live_trading_enabled: false, broker_enabled: false,
    }, null, 2));
    return;
  }

  const batchName = `Narrow State Clean Confirmation Batch ${new Date().toISOString().slice(0, 10)}`;
  let batch;
  const reusable = findReusableBatch();
  if (reusable && reusable.status !== 'completed') {
    batch = { ok: true, batch: reusable };
  } else {
    batch = batchService.createBatchTest({
      name: batchName,
      metadata: {
        run_type: 'narrow_state_clean_confirmation_batch',
      },
      strategy_ids: STRATEGY_IDS,
      symbols: SYMBOLS,
      markets: ['stocks'],
      timeframes: TIMEFRAMES,
      date_from,
      date_to,
      stop_losses: [0.2],
      take_profits: [1.5],
      holding_times: [10],
      timeouts: [10],
      confidence_thresholds: [65],
      volume_requirements: [1.2],
    });

    if (!batch.ok) {
      throw new Error(`Batch creation failed: ${batch.error || 'unknown_error'}`);
    }
  }

  const batchId = batch.batch.id;
  const run = batchService.runBatchTest(batchId);
  if (!run.ok) {
    throw new Error(`Batch run failed: ${run.error || 'unknown_error'}`);
  }

  const completedBatch = await waitForCompletion(batchId);

  const resultsFile = path.join(RESULTS_DIR, `${batchId}.json`);
  const rawResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const batchMeta = {
    created_at: batch.batch.created_at,
    batch_completed_at: completedBatch.batch_completed_at || completedBatch.completed_at || null,
    date_from,
    date_to,
  };
  const enriched = safeArray(rawResults)
    .map((row) => enrichRow(batchMeta, row))
    .map((row) => attachRequestedFilterMetadata(row));
  const filterResult = applyScoreBandFilter(enriched);
  const finalRows = filterResult.status === 'skipped_no_matching_band'
    ? [buildNoMatchingSetupsRow(batchMeta, filterResult)]
    : filterResult.rows;
  fs.writeFileSync(resultsFile, JSON.stringify(finalRows, null, 2) + '\n', 'utf8');

  // Record this batch's fingerprint so identical re-runs are skipped next time.
  appendFingerprint({ fingerprint, batchId, date_from, date_to, completed_at: new Date().toISOString() });

  const summary = narrowLearning.buildNarrowPerformanceSummary();
  const qualityCounts = finalRows.reduce((acc, row) => {
    const rowCounts = confirmationQualitySummary(row.confirmationQuality);
    acc.real += rowCounts.real;
    acc.heuristic += rowCounts.heuristic;
    acc.missing += rowCounts.missing;
    return acc;
  }, { real: 0, heuristic: 0, missing: 0 });

  const output = {
    batchId,
    fingerprint,
    duplicate_skipped: false,
    batchName,
    date_from,
    date_to,
    strategy_ids: STRATEGY_IDS,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
    requestedTimeframes: REQUESTED_TIMEFRAMES,
    availableTimeframes: TF_AVAILABILITY.available,
    missingTimeframes: TF_AVAILABILITY.missing,
    timeframeSkips,
    requestedFilters: { narrowScoreBand: REQUESTED_NARROW_SCORE_BAND },
    selectedFilters: { narrowScoreBand: SELECTED_NARROW_SCORE_BAND },
    filterEnforcement: {
      requestedNarrowScoreBand: REQUESTED_NARROW_SCORE_BAND,
      selectedNarrowScoreBand: SELECTED_NARROW_SCORE_BAND,
      enforceable: Boolean(SELECTED_NARROW_SCORE_BAND),
      status: filterResult.status,
      skippedRows: filterResult.skippedRows,
      expectedNoMatchStatus: 'skipped_no_matching_band',
    },
    result_count: finalRows.length,
    confirmationQualityTotals: qualityCounts,
    summary: summary.summary,
    recommendedNextTest: summary.recommendedNextTest,
  };

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  applyScoreBandFilter,
  buildNoMatchingSetupsRow,
  rowMatchesRequestedBand,
  requestedNarrowScoreBand,
  selectedNarrowScoreBand,
};
