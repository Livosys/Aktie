'use strict';

const assert = require('assert/strict');

const {
  createFuturesTradingOsSignalAdapterService,
  mapSignalToFutures,
} = require('./futuresTradingOsSignalAdapterService');

const now = '2026-07-06T11:00:00.000Z';
const signalTimestamp = '2026-07-06T12:45:00.000Z';
const signal = {
  signalId: 'sig-qqq-long-1',
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  symbol: 'QQQ',
  market: 'stocks',
  direction: 'long',
  confidence: 0.82,
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  timeframe: '2m',
  source: 'scanner',
  signalSource: 'scanner',
  dataSource: 'real_market_data',
  approved: false,
  approvalReason: 'legacy_approval_must_be_ignored',
  strategyLogicVersion: 'test-v1',
  createdAt: signalTimestamp,
};

assert.deepEqual(mapSignalToFutures({ symbol: 'QQQ', market: 'stocks' }).futuresSymbol, 'MNQ');
assert.deepEqual(mapSignalToFutures({ symbol: 'SPY', market: 'stocks' }).futuresSymbol, 'MES');
assert.equal(mapSignalToFutures({ symbol: 'XYZ', market: 'stocks' }).mappingReason, 'no_safe_futures_mapping');

const adapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [signal],
});

const result = adapter.getFuturesCandidates({
  now,
  quotes: [
    {
      root: 'MNQ',
      symbol: 'MNQ',
      price: 20000,
      previousPrice: 19999,
      tickSize: 0.25,
      source: 'real_market_data',
      fallback: false,
    },
  ],
});

assert.equal(result.ok, true);
assert.equal(result.stats.signalInputsRead, 1);
assert.equal(result.stats.readerSignalsRead, 1);
assert.equal(result.stats.signalsMappedToFutures, 1);
assert.equal(result.candidates.length, 1);

const candidate = result.candidates[0];
assert.equal(candidate.tradeType, 'canonical_signal');
assert.equal(candidate.signalId, 'sig-qqq-long-1');
assert.equal(candidate.strategyId, 'trend_continuation');
assert.equal(candidate.symbol, 'MNQ');
assert.equal(candidate.futuresSymbol, 'MNQ');
assert.equal(candidate.direction, 'long');
assert.equal(candidate.entryPrice, 20000);
assert.equal(candidate.stopLoss, 19900);
assert.equal(candidate.takeProfit, 20200);
assert.equal(candidate.riskReward, 2);
assert.equal(candidate.usedRealStrategyLogic, true);
assert.equal(candidate.usedFallbackPrice, false);
assert.equal(candidate.excludedFromStats, false);
assert.equal(candidate.dataSource, 'real_market_data');
assert.equal(candidate.mappingReason, 'nasdaq_100_or_large_cap_proxy');
assert.equal(candidate.strategyLogicVersion, 'test-v1');
assert.equal(candidate.executionGate, 'strategy_registry_execution_allowlist');
assert.equal(candidate.registryGatePending, true);
assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'approvalReason'), false);
assert.equal(candidate.createdAt, signalTimestamp);
assert.equal(candidate.timestamp, signalTimestamp);
assert.equal(candidate.sessionMetadata.sessionId, 'us_premarket');
assert.equal(candidate.sessionId, 'us_premarket');
assert.equal(candidate.sessionLabel, 'US Premarket');
assert.equal(candidate.exchangeTimezone, 'America/Chicago');
assert.equal(candidate.exchangeLocalTime, '07:45');
assert.equal(candidate.isRth, false);
assert.equal(candidate.isMarketOpen, true);
assert.equal(candidate.rawSignalSummary.sessionMetadata.sessionId, 'us_premarket');

const nativeAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [],
});
const native = nativeAdapter.getFuturesCandidates({
  now,
  quotes: [{ root: 'MNQ', price: 20000, source: 'real_market_data', fallback: false }],
  signalInputs: [{
    signalId: 'mnq-native-signal-1',
    strategyId: 'mnq_globex_momentum_v1',
    strategyName: 'MNQ Globex Momentum',
    signalFamily: 'futures_globex_momentum',
    signalSubtype: 'GLOBEX_MOMENTUM',
    symbol: 'MNQ',
    market: 'futures',
    marketType: 'futures',
    direction: 'long',
    confidence: 0.72,
    entry: 20000,
    stopLossPct: 0.3,
    takeProfitPct: 0.6,
    riskReward: 2,
    timeframe: '1m',
    signalStatus: 'ready',
    source: 'futures_native_mnq_candles',
    signalSource: 'futures_native_mnq_candles',
    dataSource: 'real_market_data',
    dataFreshness: 'LIVE',
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    createdAt: signalTimestamp,
  }],
});
assert.equal(native.ok, true);
assert.equal(native.stats.signalInputsRead, 1);
assert.equal(native.stats.readerSignalsRead, 0);
assert.equal(native.candidates.length, 1);
assert.equal(native.candidates[0].strategyId, 'mnq_globex_momentum_v1');
assert.equal(native.candidates[0].source, 'trading_os_signal_adapter');
assert.equal(native.candidates[0].signalSource, 'futures_native_mnq_candles');
assert.equal(native.candidates[0].signalSubtype, 'GLOBEX_MOMENTUM');
assert.equal(native.candidates[0].signalStatus, 'ready');
assert.equal(native.candidates[0].entryPrice, 20000);
assert.equal(native.candidates[0].stopLoss, 19940);
assert.equal(native.candidates[0].takeProfit, 20120);
assert.equal(native.candidates[0].tradeType, 'canonical_signal');

const noRiskAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [{ ...signal, stopLoss: undefined, takeProfit: undefined, stopLossPct: undefined, targetPct: undefined, symbol: 'NDX' }],
});
const noRisk = noRiskAdapter.getFuturesCandidates({ now, quotes: [{ root: 'MNQ', price: 20000, source: 'real_market_data' }] });
assert.equal(noRisk.candidates.length, 0);
assert.equal(noRisk.stats.signalsSkippedNoRisk, 1);

// ── Färskhetssemantik: candle-stängning, inte candle-öppning ────────────────
// decisionMonitor.js:1328-1330 löser redan "stängning om bekräftad, annars
// öppning" och lägger resultatet på signal.signalTimestamp. Adaptern måste läsa
// det fältet — annars mäts åldern från candle-öppning, vilket för 2m förbrukar
// hela maxAgeMs-budgeten (120000) redan innan candlen stängt.

const CANDLE_OPEN_2M = '2026-07-06T12:44:00.000Z';
const CANDLE_CLOSE_2M = '2026-07-06T12:46:00.000Z';

function twoMinuteSignal(overrides = {}) {
  return {
    signalId: 'sig-2m-freshness',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    signalSubtype: 'EMA_PULLBACK_UP',
    symbol: 'QQQ',
    market: 'stocks',
    direction: 'long',
    confidence: 0.74,
    entry: 500,
    stopLoss: 497.5,
    takeProfit: 505,
    riskReward: 2,
    timeframe: '2m',
    source: 'scanner',
    signalSource: 'scanner',
    dataSource: 'real_market_data',
    timestamp: CANDLE_OPEN_2M,
    candleTimestamp: CANDLE_OPEN_2M,
    ...overrides,
  };
}

function adaptOne(signalInput, quoteNow = now) {
  const svc = createFuturesTradingOsSignalAdapterService({ signalReader: () => [signalInput] });
  return svc.getFuturesCandidates({
    now: quoteNow,
    quotes: [{ root: 'MNQ', symbol: 'MNQ', price: 20000, tickSize: 0.25, source: 'real_market_data', fallback: false }],
  });
}

// (1) 2m med bekräftat stängd candle → åldern ska räknas från STÄNGNING.
const confirmed2m = adaptOne(twoMinuteSignal({
  closedCandleConfirmed: true,
  latestCandleClosed: true,
  candleClosedAt: CANDLE_CLOSE_2M,
  signalTimestamp: CANDLE_CLOSE_2M,
}));
assert.equal(confirmed2m.candidates.length, 1);
assert.equal(confirmed2m.candidates[0].signalTimestamp, CANDLE_CLOSE_2M);
assert.equal(confirmed2m.candidates[0].createdAt, CANDLE_CLOSE_2M);
assert.equal(confirmed2m.candidates[0].closedCandleConfirmed, true);
// candleTimestamp ska fortfarande bära öppningen (spårbarhet till råcandlen).
assert.equal(confirmed2m.candidates[0].candleTimestamp, CANDLE_OPEN_2M);
// Kärnan: exakt en candle-längd yngre än före ändringen.
assert.equal(
  Date.parse(confirmed2m.candidates[0].signalTimestamp) - Date.parse(CANDLE_OPEN_2M),
  120000,
);

// (2) 2m utan bekräftad stängning → decisionMonitor sätter signalTimestamp lika
// med öppningen, och beteendet ska degradera till exakt som tidigare.
const unconfirmed2m = adaptOne(twoMinuteSignal({
  closedCandleConfirmed: false,
  latestCandleClosed: false,
  candleClosedAt: null,
  signalTimestamp: CANDLE_OPEN_2M,
}));
assert.equal(unconfirmed2m.candidates.length, 1);
assert.equal(unconfirmed2m.candidates[0].signalTimestamp, CANDLE_OPEN_2M);
assert.equal(unconfirmed2m.candidates[0].createdAt, CANDLE_OPEN_2M);

// (3) Native-form (1m) saknar signalTimestamp helt → genomfallet till createdAt
// måste vara oförändrat. Regressionslås för mnq_globex_momentum_v1.
const nativeShaped = adaptOne({
  signalId: 'mnq-native-freshness',
  strategyId: 'mnq_globex_momentum_v1',
  signalSubtype: 'GLOBEX_MOMENTUM',
  symbol: 'MNQ',
  market: 'futures',
  marketType: 'futures',
  direction: 'long',
  confidence: 0.72,
  entry: 20000,
  stopLossPct: 0.3,
  takeProfitPct: 0.6,
  riskReward: 2,
  timeframe: '1m',
  signalStatus: 'ready',
  dataSource: 'real_market_data',
  closedCandleConfirmed: true,
  latestCandleClosed: true,
  candleTimestamp: signalTimestamp,
  createdAt: signalTimestamp,
  timestamp: signalTimestamp,
});
assert.equal(nativeShaped.candidates.length, 1);
assert.equal(nativeShaped.candidates[0].signalTimestamp, signalTimestamp);
assert.equal(nativeShaped.candidates[0].createdAt, signalTimestamp);
assert.equal(Object.prototype.hasOwnProperty.call(nativeShaped.candidates[0], 'signalTimestamp'), true);

// (4) candidateId får inte flytta sig när signalTimestamp tillkommer.
// stableCandidateId (adapter:127-136) har en egen uppslagskedja och ska inte
// påverkas — annars bryts dedup och idempotensnycklar.
const idWithout = adaptOne(twoMinuteSignal({ createdAt: CANDLE_OPEN_2M })).candidates[0].candidateId;
const idWith = adaptOne(twoMinuteSignal({
  createdAt: CANDLE_OPEN_2M,
  closedCandleConfirmed: true,
  candleClosedAt: CANDLE_CLOSE_2M,
  signalTimestamp: CANDLE_CLOSE_2M,
})).candidates[0].candidateId;
assert.equal(idWith, idWithout);

// (5) Sessionsgräns: candle som öppnar i premarket och stänger i RTH.
// 12:44Z = 07:44 CT (premarket), 13:30Z = 08:30 CT (RTH-öppning).
// Med stängningssemantik klassas signalen i den session den är handlingsbar i.
const boundary = adaptOne(twoMinuteSignal({
  timestamp: '2026-07-06T13:28:00.000Z',
  candleTimestamp: '2026-07-06T13:28:00.000Z',
  closedCandleConfirmed: true,
  latestCandleClosed: true,
  candleClosedAt: '2026-07-06T13:30:00.000Z',
  signalTimestamp: '2026-07-06T13:30:00.000Z',
}));
assert.equal(boundary.candidates.length, 1);
assert.equal(boundary.candidates[0].signalTimestamp, '2026-07-06T13:30:00.000Z');
assert.equal(boundary.candidates[0].exchangeLocalTime, '08:30');
assert.equal(boundary.candidates[0].sessionId, 'us_rth');
assert.equal(boundary.candidates[0].isRth, true);

console.log('futuresTradingOsSignalAdapterService.test.js passed');
