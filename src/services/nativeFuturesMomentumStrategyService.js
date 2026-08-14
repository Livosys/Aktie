'use strict';

// Phase 5 only: pure decision layer for a native futures market snapshot.

const STRATEGY_ID = 'native_futures_momentum_v1';
const STRATEGY_VERSION = 'phase5.1';
const SOURCE = 'native_futures_momentum_strategy';
const SUPPORTED_SYMBOLS = new Set(['MNQ', 'MES']);
const DEFAULT_TICK_SIZE = 0.25;

const DECISIONS = Object.freeze({
  NO_SIGNAL: 'NO_SIGNAL',
  BLOCKED: 'BLOCKED',
  SIGNAL: 'SIGNAL',
});

const DIRECTIONS = Object.freeze({
  LONG: 'LONG',
  SHORT: 'SHORT',
});

const DEFAULT_OPTIONS = Object.freeze({
  minBodyPoints: 8,
  minBodyToRangeRatio: 0.45,
  minStopDistancePoints: 20,
  rewardMultiple: 2,
  tickSize: DEFAULT_TICK_SIZE,
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function upper(value) {
  const text = safeString(value);
  return text ? text.toUpperCase() : null;
}

function lower(value) {
  const text = safeString(value);
  return text ? text.toLowerCase() : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNumber(value, fallback) {
  const n = numberOrNull(value);
  return n != null && n > 0 ? n : fallback;
}

function roundToTick(value, tickSize = DEFAULT_TICK_SIZE) {
  const n = numberOrNull(value);
  const tick = positiveNumber(tickSize, DEFAULT_TICK_SIZE);
  if (n == null) return null;
  return Number((Math.round(n / tick) * tick).toFixed(2));
}

function baseDecision(snapshot, now, decision, reason, extra = {}) {
  return {
    ok: decision !== DECISIONS.BLOCKED,
    decision,
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    symbol: upper(snapshot && snapshot.symbol),
    timeframe: lower(snapshot && snapshot.timeframe),
    reason,
    blockers: [],
    evaluatedAt: nowIso(now),
    marketSnapshotTimestamp: safeString(snapshot && snapshot.timestamp),
    source: SOURCE,
    direction: null,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    ...extra,
  };
}

function candleMetrics(candle = {}) {
  if (!candle || typeof candle !== 'object') return null;
  const open = numberOrNull(candle.open);
  const high = numberOrNull(candle.high);
  const low = numberOrNull(candle.low);
  const close = numberOrNull(candle.close);
  if ([open, high, low, close].some((value) => value == null)) return null;
  const range = high - low;
  if (range <= 0 || open > high || open < low || close > high || close < low) return null;
  const body = close - open;
  return {
    open,
    high,
    low,
    close,
    range,
    body,
    absBody: Math.abs(body),
    bodyToRangeRatio: Math.abs(body) / range,
  };
}

function quotePrice(quote = {}) {
  if (!quote || typeof quote !== 'object') return null;
  const direct = numberOrNull(quote.price);
  if (direct != null && direct > 0) return direct;
  const last = numberOrNull(quote.last);
  if (last != null && last > 0) return last;
  const bid = numberOrNull(quote.bid);
  const ask = numberOrNull(quote.ask);
  if (bid != null && ask != null && bid > 0 && ask > 0 && ask >= bid) {
    return (bid + ask) / 2;
  }
  return null;
}

function contractBlockers(snapshot = {}) {
  const symbol = upper(snapshot.symbol);
  const contract = snapshot.contract || {};
  const blockers = [];
  const contractErrors = Array.isArray(snapshot.contractErrors)
    ? snapshot.contractErrors.filter(Boolean)
    : [];

  if (!SUPPORTED_SYMBOLS.has(symbol)) blockers.push('unsupported_futures_symbol');
  if (snapshot.contractStatus && snapshot.contractStatus !== 'valid') blockers.push('invalid_contract');
  if (snapshot.status === 'invalid_contract') blockers.push('invalid_contract');
  if (contractErrors.length > 0) blockers.push('invalid_contract');
  if (upper(contract.secType) && upper(contract.secType) !== 'FUT') blockers.push('invalid_contract');
  if (upper(contract.exchange) && upper(contract.exchange) !== 'CME') blockers.push('invalid_contract');
  if (numberOrNull(contract.conId) == null || numberOrNull(contract.conId) <= 0) blockers.push('invalid_contract');
  if (/CONT/i.test(safeString(contract.localSymbol) || '')) blockers.push('invalid_contract');

  return [...new Set(blockers)];
}

function marketBlockers(snapshot = {}) {
  const blockers = [];
  if (snapshot.sessionStatus !== 'open') blockers.push('session_closed');
  if (!snapshot.latestCandle) blockers.push('missing_candle');
  if (snapshot.candleStatus === 'stale') blockers.push('stale_candle');
  if (snapshot.candleStatus === 'invalid_timestamp') blockers.push('invalid_candle_timestamp');
  if (!snapshot.latestQuote) blockers.push('missing_quote');
  if (snapshot.quoteStatus === 'stale') blockers.push('stale_quote');
  if (snapshot.status === 'stale_market_data') blockers.push('stale_market_data');
  if (snapshot.status === 'missing_market_data') blockers.push('missing_market_data');
  if (candleMetrics(snapshot.latestCandle) == null) blockers.push('invalid_candle');
  if (quotePrice(snapshot.latestQuote) == null) blockers.push('invalid_quote');
  return [...new Set(blockers)];
}

function evaluateNativeFuturesMomentumStrategy(snapshot, options = {}) {
  const now = options.now || new Date();
  const settings = { ...DEFAULT_OPTIONS, ...options };

  if (!snapshot || typeof snapshot !== 'object') {
    return baseDecision(null, now, DECISIONS.BLOCKED, 'missing_market_snapshot', {
      blockers: ['missing_market_snapshot'],
    });
  }

  const blockers = [
    ...contractBlockers(snapshot),
    ...marketBlockers(snapshot),
  ];
  if (blockers.length > 0) {
    return baseDecision(snapshot, now, DECISIONS.BLOCKED, blockers[0], {
      blockers: [...new Set(blockers)],
    });
  }

  const metrics = candleMetrics(snapshot.latestCandle);
  const entry = roundToTick(quotePrice(snapshot.latestQuote), settings.tickSize);
  const minBodyPoints = positiveNumber(settings.minBodyPoints, DEFAULT_OPTIONS.minBodyPoints);
  const minBodyToRangeRatio = positiveNumber(
    settings.minBodyToRangeRatio,
    DEFAULT_OPTIONS.minBodyToRangeRatio
  );

  if (
    !metrics ||
    entry == null ||
    metrics.absBody < minBodyPoints ||
    metrics.bodyToRangeRatio < minBodyToRangeRatio
  ) {
    return baseDecision(snapshot, now, DECISIONS.NO_SIGNAL, 'momentum_threshold_not_met', {
      evidence: metrics ? {
        candleBodyPoints: Number(metrics.body.toFixed(2)),
        candleRangePoints: Number(metrics.range.toFixed(2)),
        bodyToRangeRatio: Number(metrics.bodyToRangeRatio.toFixed(4)),
      } : null,
    });
  }

  const direction = metrics.body > 0 ? DIRECTIONS.LONG : DIRECTIONS.SHORT;
  const rewardMultiple = positiveNumber(settings.rewardMultiple, DEFAULT_OPTIONS.rewardMultiple);
  const stopDistance = Math.max(
    positiveNumber(settings.minStopDistancePoints, DEFAULT_OPTIONS.minStopDistancePoints),
    metrics.range
  );
  const stopLoss = direction === DIRECTIONS.LONG
    ? roundToTick(entry - stopDistance, settings.tickSize)
    : roundToTick(entry + stopDistance, settings.tickSize);
  const takeProfit = direction === DIRECTIONS.LONG
    ? roundToTick(entry + (stopDistance * rewardMultiple), settings.tickSize)
    : roundToTick(entry - (stopDistance * rewardMultiple), settings.tickSize);

  return baseDecision(
    snapshot,
    now,
    DECISIONS.SIGNAL,
    direction === DIRECTIONS.LONG
      ? 'bullish_native_futures_momentum'
      : 'bearish_native_futures_momentum',
    {
      direction,
      entryPrice: entry,
      stopLoss,
      takeProfit,
      riskReward: Number(rewardMultiple.toFixed(2)),
      signalTimestamp: safeString(snapshot.latestCandle && snapshot.latestCandle.timestamp),
      evidence: {
        candleBodyPoints: Number(metrics.body.toFixed(2)),
        candleRangePoints: Number(metrics.range.toFixed(2)),
        bodyToRangeRatio: Number(metrics.bodyToRangeRatio.toFixed(4)),
        candleClose: roundToTick(metrics.close, settings.tickSize),
        quotePrice: entry,
      },
    }
  );
}

function createNativeFuturesMomentumStrategy(options = {}) {
  return {
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    evaluate(snapshot, overrides = {}) {
      return evaluateNativeFuturesMomentumStrategy(snapshot, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesMomentumStrategy = createNativeFuturesMomentumStrategy();

module.exports = {
  STRATEGY_ID,
  STRATEGY_VERSION,
  DECISIONS,
  DIRECTIONS,
  createNativeFuturesMomentumStrategy,
  defaultNativeFuturesMomentumStrategy,
  evaluateNativeFuturesMomentumStrategy,
  _internal: {
    candleMetrics,
    quotePrice,
    roundToTick,
    contractBlockers,
    marketBlockers,
  },
};
