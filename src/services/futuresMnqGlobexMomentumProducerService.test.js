'use strict';

const assert = require('assert/strict');

const {
  STRATEGY_ID,
  createFuturesMnqGlobexMomentumProducerService,
} = require('./futuresMnqGlobexMomentumProducerService');

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + (minutes * 60_000)).toISOString();
}

function makeCandles({
  start,
  closes,
  source = 'real_market_data',
  volume = 100,
  closed = true,
  root = 'MNQ',
  symbol = root,
}) {
  return closes.map((close, index) => {
    const open = index === 0 ? close - 1 : closes[index - 1];
    const high = Math.max(open, close) + 2;
    const low = Math.min(open, close) - 2;
    return {
      timestamp: addMinutes(start, index),
      open,
      high,
      low,
      close,
      volume,
      closed,
      root,
      symbol,
      instrument: root,
      source,
      dataSource: source,
    };
  });
}

function assertProducerSafety(row) {
  assert.equal(row.mode, 'paper_only');
  assert.equal(row.actions_allowed, false);
  assert.equal(row.can_place_orders, false);
  assert.equal(row.live_trading_enabled, false);
  assert.equal(row.broker_enabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'diagnosticCandidatePreview'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'wouldCreateCandidate'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'executionEnabled'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'entryEligible'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'eligibleForPaperEntry'), false);
}

const producer = createFuturesMnqGlobexMomentumProducerService({
  config: {
    lookback: 5,
    minClosedCandles: 5,
    momentumThresholdPoints: 6,
    staleAfterMs: 20 * 60_000,
    maxExtensionRangeMultiple: 3,
  },
});

// 1, 9. Long signal from closed MNQ candles in Europe.
let result = producer.evaluate({
  now: '2026-07-14T07:05:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T07:01:00.000Z',
    closes: [20000, 20003, 20007, 20010, 20014],
  }),
});
assert.equal(result.ok, true);
assert.equal(result.strategyId, STRATEGY_ID);
assert.equal(result.family, 'futures_globex_momentum');
assert.equal(result.instrument, 'MNQ');
assert.equal(result.producerType, 'futures_native');
assert.equal(result.signalState, 'signal');
assert.equal(result.direction, 'long');
assert.equal(result.sessionId, 'europe');
assert.equal(result.sessionLabel, 'Europe');
assert.equal(result.isRth, false);
assert.equal(result.isMarketOpen, true);
assert.equal(result.canonicalSignalReady, true);
assert.equal(result.producerEvidence.closedCandlesUsed, 5);
assert.equal(result.signal.strategyId, STRATEGY_ID);
assert.equal(result.signal.symbol, 'MNQ');
assert.equal(result.signal.marketType, 'futures');
assert.equal(result.signal.direction, 'long');
assert.equal(result.signal.entry, 20014);
assert.equal(result.signal.stopLossPct, 0.3);
assert.equal(result.signal.takeProfitPct, 0.6);
assert.equal(result.signal.riskReward, 2);
assert.equal(result.signal.signalSubtype, 'GLOBEX_MOMENTUM');
assert.equal(result.signal.closedCandleConfirmed, true);
assert.equal(result.signal.source, 'futures_native_mnq_candles');
assertProducerSafety(result);

// 2, 10. Short signal from closed MNQ candles in US Premarket.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:06:00.000Z',
    closes: [20020, 20016, 20012, 20008, 20003],
  }),
});
assert.equal(result.ok, true);
assert.equal(result.signalState, 'signal');
assert.equal(result.direction, 'short');
assert.equal(result.sessionId, 'us_premarket');
assert.equal(result.sessionLabel, 'US Premarket');
assert.equal(result.isRth, false);
assert.equal(result.canonicalSignalReady, true);
assertProducerSafety(result);

// 3. No signal when threshold is not met.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:06:00.000Z',
    closes: [20000, 20001, 20002, 20003, 20004],
  }),
});
assert.equal(result.ok, true);
assert.equal(result.signalState, 'no_signal');
assert.equal(result.direction, null);
assert.equal(result.blockedReason, 'momentum_threshold_not_met');
assert.equal(result.canonicalSignalReady, false);
assertProducerSafety(result);

// 4. Missing candles produce a deterministic blocked reason.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: [],
});
assert.equal(result.ok, false);
assert.equal(result.signalState, 'blocked');
assert.equal(result.blockedReason, 'missing_mnq_data');
assert.equal(result.direction, null);
assert.equal(result.canonicalSignalReady, false);
assertProducerSafety(result);

// 5. Insufficient candles.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:08:00.000Z',
    closes: [20000, 20010, 20020],
  }),
});
assert.equal(result.ok, false);
assert.equal(result.signalState, 'blocked');
assert.equal(result.blockedReason, 'insufficient_candles');
assertProducerSafety(result);

// 6. Invalid candles are blocked deterministically.
const invalidCandles = makeCandles({
  start: '2026-07-14T12:06:00.000Z',
  closes: [20000, 20003, 20007, 20010, 20014],
});
invalidCandles[2].high = invalidCandles[2].low - 1;
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: invalidCandles,
});
assert.equal(result.ok, false);
assert.equal(result.signalState, 'blocked');
assert.equal(result.blockedReason, 'invalid_ohlc');
assert.equal(result.direction, null);
assertProducerSafety(result);

const missingPriceCandles = makeCandles({
  start: '2026-07-14T12:06:00.000Z',
  closes: [20000, 20003, 20007, 20010, 20014],
});
missingPriceCandles[3].close = null;
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: missingPriceCandles,
});
assert.equal(result.ok, false);
assert.equal(result.signalState, 'blocked');
assert.equal(result.blockedReason, 'missing_price');
assertProducerSafety(result);

// 7. A wrong instrument, such as MES, cannot create an MNQ signal.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:06:00.000Z',
    closes: [5000, 5004, 5008, 5012, 5018],
    root: 'MES',
  }),
});
assert.equal(result.ok, false);
assert.equal(result.signalState, 'blocked');
assert.equal(result.blockedReason, 'wrong_instrument');
assert.equal(result.producerEvidence.expectedInstrument, 'MNQ');
assert.equal(result.producerEvidence.receivedInstrument, 'MES');
assert.equal(result.direction, null);
assertProducerSafety(result);

// 8. An open candle is ignored and cannot create the signal.
const closedNoSignal = makeCandles({
  start: '2026-07-14T12:04:00.000Z',
  closes: [20000, 20001, 20002, 20003, 20004],
});
const openSpike = {
  timestamp: '2026-07-14T12:09:00.000Z',
  open: 20004,
  high: 20120,
  low: 20004,
  close: 20120,
  volume: 100,
  closed: false,
  source: 'real_market_data',
};
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: [...closedNoSignal, openSpike],
});
assert.equal(result.ok, true);
assert.equal(result.signalState, 'no_signal');
assert.equal(result.producerEvidence.latestCandleTimestamp, '2026-07-14T12:08:00.000Z');
assertProducerSafety(result);

// 9. Stale data is blocked.
result = producer.evaluate({
  now: '2026-07-14T12:40:00.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:00:00.000Z',
    closes: [20000, 20004, 20008, 20012, 20018],
  }),
});
assert.equal(result.ok, false);
assert.equal(result.blockedReason, 'stale_market_data');
assert.equal(result.direction, null);
assertProducerSafety(result);

// 10. Maintenance break is blocked before any signal.
result = producer.evaluate({
  now: '2026-07-14T21:30:00.000Z',
  candles: makeCandles({
    start: '2026-07-14T21:25:00.000Z',
    closes: [20000, 20004, 20008, 20012, 20018],
  }),
});
assert.equal(result.ok, false);
assert.equal(result.sessionId, 'maintenance_break');
assert.equal(result.blockedReason, 'maintenance_break');
assert.equal(result.direction, null);
assertProducerSafety(result);

// 11. Weekend market close is blocked.
result = producer.evaluate({
  now: '2026-07-11T17:00:00.000Z',
  candles: makeCandles({
    start: '2026-07-11T16:55:00.000Z',
    closes: [20000, 20004, 20008, 20012, 20018],
  }),
});
assert.equal(result.ok, false);
assert.equal(result.sessionId, 'market_closed');
assert.equal(result.blockedReason, 'market_closed');
assert.equal(result.direction, null);
assertProducerSafety(result);

// 12. US RTH can create a signal.
result = producer.evaluate({
  now: '2026-07-14T13:40:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T13:36:00.000Z',
    closes: [20000, 20003, 20007, 20010, 20014],
  }),
});
assert.equal(result.ok, true);
assert.equal(result.signalState, 'signal');
assert.equal(result.sessionId, 'us_rth');
assert.equal(result.isRth, true);
assertProducerSafety(result);

// 13. The signal uses its own candle timestamp, not current wall-clock time.
assert.equal(result.signal.timestamp, '2026-07-14T13:40:00.000Z');
assert.equal(result.producerEvidence.latestCandleTimestamp, '2026-07-14T13:40:00.000Z');

// 14. DST classification in the US/Sweden offset mismatch week.
result = producer.evaluate({
  now: '2026-03-16T13:40:30.000Z',
  candles: makeCandles({
    start: '2026-03-16T13:36:00.000Z',
    closes: [20000, 20003, 20007, 20010, 20014],
  }),
});
assert.equal(result.ok, true);
assert.equal(result.sessionId, 'us_rth');
assert.equal(result.isRth, true);
assertProducerSafety(result);

// 15. Simulated fallback can produce a signal with simulated data quality.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:06:00.000Z',
    closes: [20000, 20003, 20007, 20010, 20014],
    source: 'simulated_fallback',
  }),
});
assert.equal(result.ok, true);
assert.equal(result.dataQuality, 'simulated');
assert.equal(result.canonicalSignalReady, true);
assertProducerSafety(result);

// 16. IB historical candles are real market data for entry-contract freshness.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:06:00.000Z',
    closes: [20000, 20003, 20007, 20010, 20014],
    source: 'ib_historical',
  }),
});
assert.equal(result.ok, true);
assert.equal(result.dataQuality, 'real');
assert.equal(result.signal.dataFreshness, 'LIVE');
assert.equal(result.signal.dataSource, 'real_market_data');
assertProducerSafety(result);

// Missing volume is a warning by default.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:06:00.000Z',
    closes: [20000, 20003, 20007, 20010, 20014],
    volume: null,
  }),
});
assert.equal(result.ok, true);
assert.equal(result.signalState, 'signal');
assert.equal(result.warnings.includes('missing_volume'), true);
assertProducerSafety(result);

// Open-only candle input is blocked.
result = producer.evaluate({
  now: '2026-07-14T12:10:30.000Z',
  candles: makeCandles({
    start: '2026-07-14T12:09:00.000Z',
    closes: [20020],
    closed: false,
  }),
});
assert.equal(result.ok, false);
assert.equal(result.blockedReason, 'open_candle_not_eligible');
assertProducerSafety(result);

// 16. The producer ignores stock market status and remains deterministic.
const deterministicInput = {
  now: '2026-07-14T12:10:30.000Z',
  stockMarketStatus: 'MARKET_CLOSED',
  decisionMonitorStatus: 'MARKET_CLOSED',
  candles: makeCandles({
    start: '2026-07-14T12:06:00.000Z',
    closes: [20000, 20003, 20007, 20010, 20014],
  }),
};
const first = producer.evaluate(deterministicInput);
const second = producer.evaluate(deterministicInput);
const stockOpen = producer.evaluate({
  ...deterministicInput,
  stockMarketStatus: 'OPEN',
  decisionMonitorStatus: 'OPEN',
});
assert.deepEqual(second, first);
assert.deepEqual(stockOpen, first);
assert.equal(first.signalState, 'signal');
assert.equal(first.direction, 'long');
assertProducerSafety(first);

console.log('Europe long signal', {
  sessionId: 'europe',
  direction: 'long',
});
console.log('US Premarket short signal', {
  sessionId: 'us_premarket',
  direction: 'short',
});
console.log('No-signal result', {
  blockedReason: 'momentum_threshold_not_met',
});
console.log('futuresMnqGlobexMomentumProducerService.test.js passed');
