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
  lifecycleId: 'life-sig-qqq-long-1',
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
// READY_FOR_PAPER-steget mappar INTE krypto till MNQ. Signalbeslutet — riktning,
// subtyp, rvol, regim — beräknas på det underliggande instrumentet, och en stark
// struktur i Ethereum säger ingenting om Nasdaq-100. Att strategin är redo för
// paper gör den inte instrumentagnostisk. (Tidigare asserterade de här två
// fallen motsatsen; beteendet är ändrat medvetet, inte råkat.)
assert.equal(mapSignalToFutures(
  { symbol: 'ETHUSDT', market: 'crypto', strategyId: 'ema_pullback_continuation' },
  { readyForPaperStrategyIds: new Set(['ema_pullback_continuation']) },
).futuresSymbol, null);
assert.equal(mapSignalToFutures(
  { symbol: 'ETHUSDT', market: 'crypto', strategyId: 'ema_pullback_continuation' },
  { readyForPaperStrategyIds: new Set(['ema_pullback_continuation']) },
).mappingReason, 'no_index_kinship_for_default_root');
assert.equal(mapSignalToFutures(
  { symbol: 'ETHUSDT', market: 'crypto', strategyId: 'crypto_watch_only' },
  { readyForPaperStrategyIds: new Set(['ema_pullback_continuation']) },
).mappingReason, 'no_safe_futures_mapping');
assert.equal(mapSignalToFutures(
  { symbol: 'SOLUSDT', market: 'crypto', signalSubtype: 'VWAP_RECLAIM_UP' },
  { readyForPaperStrategies: [{ strategyId: 'vwap_volume_breakout_long', readiness: 'READY_FOR_PAPER', producedSubtypes: ['VWAP_RECLAIM_UP'] }] },
).futuresSymbol, null);

// Aktier och ETF:er är oberörda — de mappas på FAKTISKT släktskap i steg 3/4,
// inte av READY_FOR_PAPER-steget.
assert.equal(mapSignalToFutures(
  { symbol: 'MSFT', market: 'stocks', strategyId: 'ema_pullback_continuation' },
  { readyForPaperStrategyIds: new Set(['ema_pullback_continuation']) },
).futuresSymbol, 'MNQ');

// Escape-hatchen består: anger signalen explicit exekveringskontrakt är
// släktskapsfrågan redan besvarad av den som satte det.
assert.equal(mapSignalToFutures({ symbol: 'BTCUSDT', market: 'crypto', executionSymbol: 'MNQ' }).futuresSymbol, 'MNQ');

// Okänd marknad räknas aldrig som släktskap.
assert.equal(mapSignalToFutures(
  { symbol: 'WHATEVER', strategyId: 'ema_pullback_continuation' },
  { readyForPaperStrategyIds: new Set(['ema_pullback_continuation']) },
).futuresSymbol, null);
assert.equal(mapSignalToFutures({ symbol: 'BTCUSDT', market: 'crypto', executionSymbol: 'MES' }).futuresSymbol, 'MES');
assert.equal(mapSignalToFutures({ symbol: 'BTCUSDT', market: 'crypto', futuresInstrument: 'NQ' }).futuresSymbol, 'MNQ');

const adapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [signal],
});

const mnqQuotes = [
  {
    root: 'MNQ',
    symbol: 'MNQ',
    price: 20000,
    previousPrice: 19999,
    tickSize: 0.25,
    source: 'real_market_data',
    fallback: false,
  },
];

const result = adapter.getFuturesCandidates({
  now,
  quotes: mnqQuotes,
});

assert.equal(result.ok, true);
assert.equal(result.stats.signalInputsRead, 1);
assert.equal(result.stats.readerSignalsRead, 1);
assert.equal(result.stats.signalsMappedToFutures, 1);
assert.equal(result.candidates.length, 1);

const candidate = result.candidates[0];
assert.equal(candidate.lifecycleId, 'life-sig-qqq-long-1');
assert.notEqual(candidate.lifecycleId, candidate.candidateId);
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
assert.equal(candidate.executionGate, 'production_execution_law_v2');
assert.equal(candidate.registryGatePending, false);
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

const missingLifecycle = adapter.getFuturesCandidates({
  now,
  quotes: mnqQuotes,
  signalInputs: [{ ...signal, lifecycleId: undefined }],
});
assert.equal(missingLifecycle.candidates.length, 1);
assert.equal(missingLifecycle.candidates[0].lifecycleId, null);
assert.equal(missingLifecycle.candidates[0].candidateId, candidate.candidateId);
assert.equal(missingLifecycle.candidates[0].signalId, candidate.signalId);

const lifecycleOnlyChanged = adapter.getFuturesCandidates({
  now,
  quotes: mnqQuotes,
  signalInputs: [{ ...signal, lifecycleId: 'life-sig-qqq-long-2' }],
});
assert.equal(lifecycleOnlyChanged.candidates.length, 1);
assert.equal(lifecycleOnlyChanged.candidates[0].lifecycleId, 'life-sig-qqq-long-2');
assert.equal(lifecycleOnlyChanged.candidates[0].candidateId, candidate.candidateId);
assert.equal(lifecycleOnlyChanged.candidates[0].signalId, candidate.signalId);

const readyFallbackAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [],
  readyForPaperStrategyIdsReader: () => new Set(['ema_pullback_continuation']),
});
const readyFallback = readyFallbackAdapter.getFuturesCandidates({
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
  signalInputs: [{
    ...signal,
    signalId: 'sig-ema-crypto-ready',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    symbol: 'ETHUSDT',
    market: 'crypto',
    direction: 'long',
  }],
});
// En krypto-signal blir ingen futures-kandidat, hur redo strategin än är. Hela
// kedjan nedströms — readiness, router, guard, order — bygger på att kandidatens
// bevis gäller instrumentet den exekveras på.
assert.equal(readyFallback.ok, true);
assert.equal(readyFallback.stats.signalsMappedToFutures, 0);
assert.equal(readyFallback.stats.signalsSkippedNoMapping, 1);
assert.equal(readyFallback.candidates.length, 0);

// Steg 5 har fortfarande ett syfte: aktier UTANFÖR de explicita Nasdaq-/S&P-
// listorna mappas via READY_FOR_PAPER-vägen, eftersom marknaden är släkt.
const readyEquity = readyFallbackAdapter.getFuturesCandidates({
  now,
  quotes: [{
    root: 'MNQ', symbol: 'MNQ', price: 20000, previousPrice: 19999,
    tickSize: 0.25, source: 'real_market_data', fallback: false,
  }],
  signalInputs: [{
    ...signal,
    signalId: 'sig-ema-equity-ready',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    symbol: 'ZZTOP',
    market: 'stocks',
    direction: 'long',
  }],
});
assert.equal(readyEquity.stats.signalsMappedToFutures, 1);
assert.equal(readyEquity.candidates.length, 1);
assert.equal(readyEquity.candidates[0].symbol, 'MNQ');
assert.equal(readyEquity.candidates[0].futuresSymbol, 'MNQ');
assert.equal(readyEquity.candidates[0].executionSymbol, 'MNQ');
assert.equal(readyEquity.candidates[0].futuresInstrument, 'MNQ');
assert.equal(readyEquity.candidates[0].mappingReason, 'ready_for_paper_default_micro_futures_root');

const upstreamLifecycle = readyFallbackAdapter.getFuturesCandidates({
  now,
  quotes: [{
    root: 'MNQ', symbol: 'MNQ', price: 20000, previousPrice: 19999,
    tickSize: 0.25, source: 'real_market_data', fallback: false,
  }],
  signalInputs: [{
    ...signal,
    lifecycleId: 'life-upstream-1',
    signalId: 'sig-ema-upstream-life',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    symbol: 'ZZTOP',
    market: 'stocks',
    direction: 'long',
  }],
});
assert.equal(upstreamLifecycle.candidates.length, 1);
assert.equal(upstreamLifecycle.candidates[0].lifecycleId, 'life-upstream-1');

const subtypeResolvedAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [],
  readyForPaperStrategiesReader: () => [{
    strategyId: 'narrow_state_expansion_long',
    strategyName: 'Narrow State Expansion Long',
    readiness: 'READY_FOR_PAPER',
    producedSubtypes: ['NARROW_BULL_ENTRY'],
  }],
});
const subtypeResolved = subtypeResolvedAdapter.getFuturesCandidates({
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
  signalInputs: [{
    ...signal,
    signalId: 'sig-narrow-no-strategy-id',
    strategyId: undefined,
    strategyName: undefined,
    signalSubtype: 'NARROW_BULL_ENTRY',
    // Aktie, inte krypto: det här testet handlar om att subtypen ska kunna lösa
    // upp strategyId, inte om instrumentmappningen. Med en krypto-symbol hade
    // släktskapsgrinden stoppat kandidaten innan upplösningen ens mättes.
    symbol: 'ZZTOP',
    market: 'stocks',
    direction: 'long',
  }],
});
assert.equal(subtypeResolved.ok, true);
assert.equal(subtypeResolved.stats.signalsMappedToFutures, 1);
assert.equal(subtypeResolved.stats.signalsSkippedNoMapping, 0);
assert.equal(subtypeResolved.candidates.length, 1);
assert.equal(subtypeResolved.candidates[0].strategyId, 'narrow_state_expansion_long');
assert.equal(subtypeResolved.candidates[0].symbol, 'MNQ');
assert.equal(subtypeResolved.candidates[0].mappingReason, 'ready_for_paper_default_micro_futures_root');

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

const productionNativeAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [],
});
const productionNative = productionNativeAdapter.getFuturesCandidates({
  now,
  quotes: [{ root: 'MNQ', price: 20000, source: 'real_market_data', fallback: false }],
  signalInputs: [{
    signalId: 'mnq-native-production-signal-1',
    strategyId: 'native_futures_momentum_v1',
    strategyName: 'Native Futures Momentum',
    signalFamily: 'native_futures_momentum',
    signalSubtype: 'NATIVE_FUTURES_MOMENTUM',
    symbol: 'MNQ',
    market: 'futures',
    marketType: 'futures',
    provider: 'ibkr',
    exchange: 'CME',
    contract: {
      root: 'MNQ',
      symbol: 'MNQ',
      localSymbol: 'MNQU6',
      conId: 793356225,
      secType: 'FUT',
      exchange: 'CME',
      currency: 'USD',
      expiry: '20260918',
      lastTradeDateOrContractMonth: '20260918',
    },
    direction: 'long',
    confidence: 0.72,
    entry: 20000,
    stopLoss: 19940,
    takeProfit: 20120,
    riskReward: 2,
    timeframe: '2m',
    signalStatus: 'ready',
    signalSource: 'native_futures',
    dataSource: 'real_market_data',
    dataFreshness: 'LIVE',
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    createdAt: signalTimestamp,
  }],
});
assert.equal(productionNative.ok, true);
assert.equal(productionNative.candidates.length, 1);
const productionNativeCandidate = productionNative.candidates[0];
assert.equal(productionNativeCandidate.source, 'native_futures_candidate_adapter');
assert.equal(productionNativeCandidate.signalSource, 'native_futures');
assert.equal(productionNativeCandidate.marketType, 'futures');
assert.equal(productionNativeCandidate.provider, 'ibkr');
assert.equal(productionNativeCandidate.exchange, 'CME');
assert.equal(productionNativeCandidate.symbol, 'MNQ');
assert.equal(Object.prototype.hasOwnProperty.call(productionNativeCandidate, 'originalSymbol'), false);
assert.equal(Object.prototype.hasOwnProperty.call(productionNativeCandidate, 'originalMarket'), false);
assert.equal(Object.prototype.hasOwnProperty.call(productionNativeCandidate, 'mappingReason'), false);
assert.equal(Object.prototype.hasOwnProperty.call(productionNativeCandidate, 'mapping'), false);
assert.equal(JSON.stringify(productionNativeCandidate).includes('trading_os'), false);

const nativeStopOnly = nativeAdapter.getFuturesCandidates({
  now,
  quotes: [{ root: 'MNQ', price: 20000, source: 'real_market_data', fallback: false }],
  signalInputs: [{
    signalId: 'mnq-native-stop-only-1',
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
assert.equal(nativeStopOnly.ok, true);
assert.equal(nativeStopOnly.stats.signalsMappedToFutures, 1);
assert.equal(nativeStopOnly.stats.signalsSkippedNoRisk, 0);
assert.equal(nativeStopOnly.candidates.length, 1);
assert.equal(nativeStopOnly.candidates[0].stopLoss, 19940);
assert.equal(nativeStopOnly.candidates[0].takeProfit, null);
assert.equal(nativeStopOnly.candidates[0].riskReward, null);
assert.equal(nativeStopOnly.candidates[0].riskSource, 'signal_risk_percent');

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

// (6) nextMoveBias/bias får inte vetoa eller skriva över en explicit riktning.
function readerSignal({ signal: signalToken, nextMoveBias }) {
  const row = twoMinuteSignal({
    signalId: `sig-bias-${signalToken}-${nextMoveBias}`,
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    candleClosedAt: CANDLE_CLOSE_2M,
    signalTimestamp: CANDLE_CLOSE_2M,
  });
  delete row.direction; // decisionMonitor sätter aldrig fältet
  return { ...row, signal: signalToken, nextMoveBias };
}

// 6a: ingen riktning någonstans → strategin gav faktiskt ingenting.
const noDirection = adaptOne(readerSignal({ signal: 'NO_SIGNAL', nextMoveBias: 'UNCERTAIN' }));
assert.equal(noDirection.candidates.length, 0);
assert.equal(noDirection.skipped[0].skipReason, 'missing_signal_direction');

// 6b: LONG_TRIGGERED + UP → enighet, kandidat med long.
const longAgree = adaptOne(readerSignal({ signal: 'LONG_TRIGGERED', nextMoveBias: 'UP' }));
assert.equal(longAgree.candidates.length, 1);
assert.equal(longAgree.candidates[0].direction, 'long');

// 6c: LONG_TRIGGERED + UNCERTAIN → token är riktning; bias får inte vetoa.
const longVetoed = adaptOne(readerSignal({ signal: 'LONG_TRIGGERED', nextMoveBias: 'UNCERTAIN' }));
assert.equal(longVetoed.candidates.length, 1);
assert.equal(longVetoed.candidates[0].direction, 'long');
assert.equal(longVetoed.skipped.length, 0);

// 6d: SHORT_TRIGGERED + DOWN → enighet, kandidat med short.
const shortAgree = adaptOne(readerSignal({ signal: 'SHORT_TRIGGERED', nextMoveBias: 'DOWN' }));
assert.equal(shortAgree.candidates.length, 1);
assert.equal(shortAgree.candidates[0].direction, 'short');

// 6e: SHORT_TRIGGERED + UNCERTAIN → token är riktning; bias får inte vetoa.
const shortVetoed = adaptOne(readerSignal({ signal: 'SHORT_TRIGGERED', nextMoveBias: 'UNCERTAIN' }));
assert.equal(shortVetoed.candidates.length, 1);
assert.equal(shortVetoed.candidates[0].direction, 'short');
assert.equal(shortVetoed.skipped.length, 0);

// 6f: WAIT → ingen riktning att veta mot.
const waiting = adaptOne(readerSignal({ signal: 'WAIT', nextMoveBias: 'UNCERTAIN' }));
assert.equal(waiting.candidates.length, 0);
assert.equal(waiting.skipped[0].skipReason, 'missing_signal_direction');

// 6g: NEUTRAL-bias är inte en production-gate.
const neutralVetoed = adaptOne(readerSignal({ signal: 'LONG_WATCH', nextMoveBias: 'NEUTRAL' }));
assert.equal(neutralVetoed.candidates.length, 1);
assert.equal(neutralVetoed.candidates[0].direction, 'long');
assert.equal(neutralVetoed.skipped.length, 0);

// 6h + 6i: när signal-token och bias pekar åt olika håll vinner signal-token.
const longVsDown = adaptOne(readerSignal({ signal: 'LONG_TRIGGERED', nextMoveBias: 'DOWN' }));
assert.equal(longVsDown.candidates.length, 1);
assert.equal(longVsDown.candidates[0].direction, 'long');
assert.equal(longVsDown.skipped.length, 0);

const shortVsUp = adaptOne(readerSignal({ signal: 'SHORT_TRIGGERED', nextMoveBias: 'UP' }));
assert.equal(shortVsUp.candidates.length, 1);
assert.equal(shortVsUp.candidates[0].direction, 'short');
assert.equal(shortVsUp.skipped.length, 0);

// 6j: native-producenten sätter direction och når aldrig biaset — oförändrad.
assert.equal(native.candidates.length, 1);

// 6k: statistiken räknar de två orsakerna var för sig.
const mixed = createFuturesTradingOsSignalAdapterService({ signalReader: () => [] })
  .getFuturesCandidates({
    now,
    quotes: [{ root: 'MNQ', symbol: 'MNQ', price: 20000, source: 'real_market_data' }],
    signalInputs: [
      readerSignal({ signal: 'LONG_TRIGGERED', nextMoveBias: 'UNCERTAIN' }),
      readerSignal({ signal: 'SHORT_WATCH', nextMoveBias: 'UNCERTAIN' }),
      readerSignal({ signal: 'WAIT', nextMoveBias: 'UNCERTAIN' }),
    ],
  });
assert.equal(mixed.stats.signalsSkippedDirectionVetoed, 0);
assert.equal(mixed.stats.signalsSkippedNoDirection, 1);
assert.equal(mixed.candidates.length, 2);

// (7) Adapterns stats beskriver samma uppdelning som scannern persisterar.
// adaptSignal skippar bara på fem orsaker, så de fem räknarna ska summera
// exakt till skipped.length. Slår en ny orsakskod till utan räknare faller det
// ut här i stället för som en tyst lucka i telemetrin.
const allFiveReasons = createFuturesTradingOsSignalAdapterService({ signalReader: () => [] })
  .getFuturesCandidates({
    now,
    // MNQ-quote finns men INTE MES — SPY mappar till MES och faller därför på pris.
    quotes: [{ root: 'MNQ', symbol: 'MNQ', price: 20000, source: 'real_market_data' }],
    signalInputs: [
      { ...signal, signalId: 'r1', symbol: 'XYZ' },                            // no_safe_futures_mapping
      readerSignal({ signal: 'LONG_TRIGGERED', nextMoveBias: 'UNCERTAIN' }),   // candidate; bias ignored
      readerSignal({ signal: 'WAIT', nextMoveBias: 'UNCERTAIN' }),             // missing_signal_direction
      { ...signal, signalId: 'r4', symbol: 'SPY', entry: undefined, entryPrice: undefined, price: undefined, referencePrice: undefined },
      { ...signal, signalId: 'r5', symbol: 'NDX', stopLoss: undefined, takeProfit: undefined, stopLossPct: undefined, targetPct: undefined },
    ],
  });

assert.equal(allFiveReasons.stats.signalsSkippedNoMapping, 1);
assert.equal(allFiveReasons.stats.signalsSkippedDirectionVetoed, 0);
assert.equal(allFiveReasons.stats.signalsSkippedNoDirection, 1);
assert.equal(allFiveReasons.stats.signalsSkippedNoEntryPrice, 1);
assert.equal(allFiveReasons.stats.signalsSkippedNoRisk, 1);

// Summan sluts: varje skippad signal har exakt en räknare.
const skipCounters = [
  'signalsSkippedNoMapping',
  'signalsSkippedNoRisk',
  'signalsSkippedNoDirection',
  'signalsSkippedDirectionVetoed',
  'signalsSkippedNoEntryPrice',
];
assert.equal(
  skipCounters.reduce((sum, key) => sum + allFiveReasons.stats[key], 0),
  allFiveReasons.skipped.length,
);

// Och adapterns tre "other"-orsaker är exakt de scannern lägger i
// signalsSkippedOther — samma uppdelning, två ytor.
const otherReasons = new Set(['missing_signal_direction', 'direction_vetoed_by_bias', 'no_futures_entry_price']);
assert.equal(
  allFiveReasons.skipped.filter((row) => otherReasons.has(row.skipReason)).length,
  allFiveReasons.stats.signalsSkippedNoDirection
    + allFiveReasons.stats.signalsSkippedDirectionVetoed
    + allFiveReasons.stats.signalsSkippedNoEntryPrice,
);

// Befintliga fält oförändrade.
assert.equal(allFiveReasons.stats.signalInputsRead, 5);
assert.equal(allFiveReasons.stats.readerSignalsRead, 0);
assert.equal(allFiveReasons.stats.signalsMappedToFutures, 1);
assert.equal(allFiveReasons.candidates.length, 1);

console.log('futuresTradingOsSignalAdapterService.test.js passed');
