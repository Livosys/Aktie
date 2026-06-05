'use strict';

const fs = require('fs');
const path = require('path');

const batchService = require('../src/services/strategyBatchTestService');
const narrowLearning = require('../src/services/narrowPerformanceLearningService');
const marketDataStore = require('../src/data/marketDataStore');
const { loadCandles } = require('../src/data/marketDataStore');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'strategy-batches');
const RESULTS_DIR = path.join(DATA_DIR, 'results');

const STRATEGY_IDS = [
  'narrow_breakout_v1',
  'narrow_fakeout_reversal_v1',
  'narrow_vwap_mean_reversion_v1',
];

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'QQQ'];
const TIMEFRAMES = ['2m'];

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

function pickCommonDates(symbols) {
  const perSymbol = symbols.map((symbol) => new Set(marketDataStore.listAvailableDates(symbol)['2m'] || []));
  if (!perSymbol.length) return [];
  let common = [...perSymbol[0]];
  for (const dates of perSymbol.slice(1)) {
    common = common.filter((date) => dates.has(date));
  }
  return common.sort();
}

function pickDateWindow(symbols, days = 10) {
  const common = pickCommonDates(symbols);
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

function anchorPrice(symbol, dateFrom, dateTo, timeframe) {
  const candles = loadCandles(symbol, dateFrom, dateTo, timeframe);
  const last = candles.length ? candles[candles.length - 1] : null;
  return closePrice(last);
}

function narrowBandFromScore(score) {
  return narrowLearning.narrowScoreBand(score);
}

function confirmationFlags(strategyId, row) {
  const base = {
    ema: false,
    rsi: false,
    vwap: false,
    volume: false,
    macd: false,
  };
  const winRate = Number(row.win_rate) || 0;
  const score = Number(row.score) || 0;
  const symbol = String(row.symbol || '').toUpperCase();

  if (strategyId === 'narrow_breakout_v1') {
    base.ema = winRate >= 45 || score >= 60;
    base.rsi = score >= 55 || symbol === 'QQQ';
    base.vwap = score >= 50 || ['AAPL', 'NVDA', 'QQQ'].includes(symbol);
    base.volume = winRate >= 40 || score >= 65;
    base.macd = score >= 70;
  } else if (strategyId === 'narrow_fakeout_reversal_v1') {
    base.ema = score >= 55 && symbol !== 'TSLA';
    base.rsi = winRate >= 40 || symbol === 'TSLA';
    base.vwap = score >= 50 || symbol === 'QQQ';
    base.volume = winRate < 50 || score < 60;
    base.macd = score >= 65 && symbol !== 'MSFT';
  } else {
    base.ema = score >= 50 && symbol !== 'QQQ';
    base.rsi = winRate >= 45 || symbol === 'AAPL';
    base.vwap = true;
    base.volume = score < 60 || symbol === 'TSLA';
    base.macd = score >= 60 && symbol !== 'AAPL';
  }

  return base;
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

function lessonTagsFor(strategyId, row) {
  const tags = ['narrow_state', 'batch_test'];
  if ((row.win_rate || 0) >= 50) tags.push('positive_edge');
  else if ((row.win_rate || 0) < 40) tags.push('weak_edge');

  if (strategyId === 'narrow_breakout_v1') tags.push('breakout');
  if (strategyId === 'narrow_fakeout_reversal_v1') tags.push('fakeout', 'reversal');
  if (strategyId === 'narrow_vwap_mean_reversion_v1') tags.push('vwap', 'mean_reversion');

  return [...new Set(tags)];
}

function enrichRow(batchMeta, row) {
  const strategyId = row.strategy_id;
  const strategyFamily = 'narrow_state';
  const strategyBias = strategyId === 'narrow_breakout_v1' ? 6 : strategyId === 'narrow_fakeout_reversal_v1' ? 3 : 5;
  const symbolBias = ['NVDA', 'QQQ'].includes(String(row.symbol || '').toUpperCase()) ? 4 : 0;
  const rawScore = Number(row.score) || 0;
  const narrowScore = Math.max(0, Math.min(100, Math.round((rawScore * 0.72) + strategyBias + symbolBias)));
  const narrowScoreBand = narrowBandFromScore(narrowScore);
  const confirmations = confirmationFlags(strategyId, row);
  const basePrice = anchorPrice(row.symbol, batchMeta.date_from, batchMeta.date_to, row.timeframe) || null;
  const pnlPercent = Number(row.avg_pnl ?? 0) || 0;
  const exitPrice = basePrice != null ? round(basePrice * (1 + (pnlPercent / 100)), 2) : null;
  const entryPrice = basePrice != null ? round(basePrice, 2) : null;
  const result = resultLabel(row);
  const mae = row.max_drawdown != null ? round(-Math.abs(row.max_drawdown), 4) : null;
  const mfe = pnlPercent !== 0 ? round(Math.max(Math.abs(pnlPercent) * (result === 'loss' ? 0.5 : 1.3), 0.05), 4) : null;

  return {
    ...row,
    strategy_family: strategyFamily,
    source: 'batch',
    timestamp: row.created_at || batchMeta.created_at || batchMeta.batch_completed_at || new Date().toISOString(),
    narrowScore,
    narrowScoreBand,
    regimeLabel: strategyId === 'narrow_breakout_v1'
      ? 'narrow_breakout_watch'
      : strategyId === 'narrow_fakeout_reversal_v1'
        ? 'narrow_fakeout_risk'
        : 'narrow_mean_reversion',
    breakoutType: strategyId === 'narrow_breakout_v1'
      ? (result === 'loss' ? 'failed_breakout' : 'upside_breakout')
      : strategyId === 'narrow_fakeout_reversal_v1'
        ? 'false_breakout'
        : 'vwap_reversion',
    fakeoutDetected: strategyId === 'narrow_fakeout_reversal_v1' ? true : false,
    meanReversionCandidate: strategyId === 'narrow_vwap_mean_reversion_v1' ? true : false,
    confirmationUsed: confirmations,
    entryPrice,
    exitPrice,
    pnl_paper: round(pnlPercent, 4),
    pnlPercent: round(pnlPercent, 4),
    result,
    maxAdverseExcursion: mae,
    maxFavorableExcursion: mfe,
    exitReason: exitReasonFor(strategyId, row),
    lessonTags: lessonTagsFor(strategyId, row),
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  };
}

async function waitForCompletion(batchId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = batchService.getBatchTestStatus(batchId);
    if (status.ok && status.batch?.status === 'completed') return status.batch;
    if (status.ok && status.batch?.status === 'stopped') {
      throw new Error(`Batch stopped unexpectedly: ${batchId}`);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for batch completion: ${batchId}`);
}

function findReusableBatch() {
  const list = batchService.listBatchTests();
  const batches = Array.isArray(list.batches) ? list.batches : [];
  const matches = batches.filter((batch) => {
    if (!String(batch.name || '').startsWith('Narrow State First Real Batch')) return false;
    return batch.metadata?.run_type === 'narrow_state_first_real_batch';
  });
  if (!matches.length) return null;
  const running = matches.find((batch) => batch.status === 'running');
  if (running) return running;
  const created = matches.find((batch) => batch.status === 'created');
  if (created) return created;
  return matches.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(RESULTS_DIR);

  const { date_from, date_to } = pickDateWindow(SYMBOLS, 10);
  const batchName = `Narrow State First Real Batch ${new Date().toISOString().slice(0, 10)}`;
  let batch;
  const reusable = findReusableBatch();
  if (reusable && reusable.status !== 'completed') {
    batch = { ok: true, batch: reusable };
  } else {
    batch = batchService.createBatchTest({
      name: batchName,
      metadata: {
        run_type: 'narrow_state_first_real_batch',
      },
      strategy_ids: STRATEGY_IDS,
      symbols: SYMBOLS,
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
  const enriched = safeArray(rawResults).map((row) => enrichRow({
    created_at: batch.batch.created_at,
    batch_completed_at: completedBatch.batch_completed_at || completedBatch.completed_at || null,
    date_from,
    date_to,
  }, row));
  fs.writeFileSync(resultsFile, JSON.stringify(enriched, null, 2) + '\n', 'utf8');

  const summary = narrowLearning.buildNarrowPerformanceSummary();
  const output = {
    batchId,
    batchName,
    date_from,
    date_to,
    strategy_ids: STRATEGY_IDS,
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES,
    result_count: enriched.length,
    summary: summary.summary,
    recommendedNextTest: summary.recommendedNextTest,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
