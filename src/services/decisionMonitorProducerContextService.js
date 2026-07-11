'use strict';

const { aggregate1mTo2m, filterComplete } = require('../data/candleAggregator');
const { buildDaytradeSignal } = require('../scanner/daytradeSignalEngine');
const daytradingStrategyCatalog = require('./daytradingStrategyCatalogService');
const strategyPerformance = require('./strategyPerformanceService');

function addStrategyPerformanceContext(result) {
  try {
    const strategy = daytradingStrategyCatalog.inferStrategyForSignal(result);
    if (!strategy) return result;
    const performance = strategyPerformance.getSignalPerformanceBadge(strategy.id);
    const priorityBase = Number(result.priorityScore ?? result.tradeScore ?? result.signalScore ?? 0) || 0;
    return {
      ...result,
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      strategyLabel: strategy.name,
      strategy_market_group: strategy.market_group,
      strategy_performance_badge: performance.badge,
      strategy_performance_message: performance.message,
      strategy_priority_score: Math.max(0, Math.min(100, Math.round(priorityBase + performance.priority_adjustment))),
      strategy_performance: {
        win_rate: performance.win_rate,
        trades: performance.trades,
        score: performance.score,
        priority_adjustment: performance.priority_adjustment,
      },
    };
  } catch (_) {
    return result;
  }
}

function addDaytradeSignals(results) {
  return (results || []).map((row) => ({
    ...row,
    ...buildDaytradeSignal(row),
  })).map(addStrategyPerformanceContext);
}

function normalizeDebugCandle(c) {
  const timestamp = c?.timestamp || c?.ts || c?.t || null;
  const normalized = {
    timestamp,
    open: c?.open ?? c?.o ?? null,
    high: c?.high ?? c?.h ?? null,
    low: c?.low ?? c?.l ?? null,
    close: c?.close ?? c?.c ?? null,
    volume: c?.volume ?? c?.v ?? null,
  };
  if (typeof c?.incomplete === 'boolean') normalized.incomplete = c.incomplete;
  return normalized;
}

function secondsSince(iso, now = new Date()) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}

function readLiveCandleDebug({
  symbol,
  marketType,
  timeframe = '2m',
  limit = 5,
  stockReader,
  cryptoReader,
  now = new Date(),
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const type = String(marketType || '').toLowerCase();
  const tf = String(timeframe || '2m').toLowerCase();
  const checkedSources = [];
  const notes = [];
  const reader = type === 'crypto' ? cryptoReader : stockReader;

  let source = typeof reader === 'function' ? reader(normalizedSymbol, tf) : null;
  checkedSources.push(`${type || 'stock'}:${tf}:live-cache`);

  if (!source && tf === '2m' && typeof reader === 'function') {
    const oneMinute = reader(normalizedSymbol, '1m');
    checkedSources.push(`${type || 'stock'}:1m:live-cache`);
    if (oneMinute?.candles?.length) {
      const scannerBars = oneMinute.candles.map((c) => {
        const normalized = normalizeDebugCandle(c);
        return {
          ts: normalized.timestamp,
          t: normalized.timestamp,
          open: normalized.open,
          high: normalized.high,
          low: normalized.low,
          close: normalized.close,
          volume: normalized.volume,
        };
      });
      const aggregated = filterComplete(aggregate1mTo2m(scannerBars)).map(normalizeDebugCandle);
      source = {
        symbol: normalizedSymbol,
        marketType: oneMinute.marketType || type || 'stock',
        timeframe: '2m',
        sourceName: `${oneMinute.sourceName || 'live_1m'}_aggregated_to_2m`,
        updatedAt: oneMinute.updatedAt,
        candles: aggregated,
      };
      notes.push('2m candles aggregerade från 1m live bars');
    }
  }

  if (!source?.candles?.length) {
    return {
      ok: false,
      error: 'Live candles saknas för symbolen',
      debug: { checkedSources },
    };
  }

  const candles = source.candles
    .map(normalizeDebugCandle)
    .filter((c) => c.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-limit);
  const latestTimestamp = candles[candles.length - 1]?.timestamp || null;

  return {
    ok: true,
    symbol: normalizedSymbol,
    marketType: source.marketType || type || 'stock',
    timeframe: source.timeframe || tf,
    latestTimestamp,
    dataAgeSeconds: secondsSince(latestTimestamp, now),
    source: source.sourceName || 'live-cache',
    candles,
    debug: {
      hasLiveCandles: candles.length > 0,
      candleCount: candles.length,
      sourceName: source.sourceName || 'live-cache',
      notes,
    },
  };
}

function buildLiveCandleDebugMap(results, readers = {}, options = {}) {
  return (results || []).reduce((acc, item) => {
    if (!item?.symbol) return acc;
    const marketType = item._market || item.marketType || item.market || (String(item.symbol).endsWith('USDT') ? 'crypto' : 'stock');
    const result = readLiveCandleDebug({
      symbol: item.symbol,
      marketType,
      timeframe: options.timeframe || '2m',
      limit: options.limit || 5,
      stockReader: readers.stockReader,
      cryptoReader: readers.cryptoReader,
      now: options.now || new Date(),
    });
    if (result.ok) acc[item.symbol] = result;
    return acc;
  }, {});
}

module.exports = {
  addDaytradeSignals,
  addStrategyPerformanceContext,
  normalizeDebugCandle,
  secondsSince,
  readLiveCandleDebug,
  buildLiveCandleDebugMap,
};
