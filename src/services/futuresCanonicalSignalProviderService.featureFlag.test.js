'use strict';

// `node src/services/futuresCanonicalSignalProviderService.featureFlag.test.js`

const assert = require('assert/strict');
const crypto = require('crypto');
const nativeFixture = require('./canonical/__fixtures__/nativeFuturesSignal.mnq.long.json');
const {
  createFuturesCanonicalSignalProviderService,
  _internal,
} = require('./futuresCanonicalSignalProviderService');
const {
  createFuturesTradingOsSignalAdapterService,
} = require('./futuresTradingOsSignalAdapterService');

const now = new Date('2026-08-13T12:35:00.000Z');

function expectedLifecycleId(signalId) {
  return `signal_lifecycle_${crypto.createHash('sha1').update(signalId).digest('hex').slice(0, 24)}`;
}

function legacySignal() {
  return {
    signalId: 'legacy-reader-signal-1',
    strategyId: 'trend_continuation',
    symbol: 'QQQ',
    marketType: 'stocks',
    direction: 'long',
    entry: 500,
    stopLoss: 497.5,
    takeProfit: 505,
    riskReward: 2,
    createdAt: '2026-08-13T12:34:00.000Z',
  };
}

function producerSignal() {
  return {
    signalId: 'legacy-producer-signal-1',
    strategyId: 'mnq_globex_momentum_v1',
    symbol: 'MNQ',
    marketType: 'futures',
    direction: 'long',
    entry: 29880,
    stopLossPct: 0.3,
    takeProfitPct: 0.6,
    riskReward: 2,
    createdAt: '2026-08-13T12:34:00.000Z',
  };
}

function nativeProvider(signals = [nativeFixture]) {
  return {
    calls: 0,
    collectNativeFuturesSignals({ now: currentNow } = {}) {
      this.calls += 1;
      return {
        ok: true,
        generatedAt: new Date(currentNow).toISOString(),
        signals,
        rejected: [],
        stats: {
          inputSignals: signals.length,
          acceptedSignals: signals.length,
          rejectedSignals: 0,
        },
      };
    },
  };
}

function nativePriceFeed() {
  return {
    getCandles: (symbol) => {
      if (symbol !== 'MNQ') return { candles: [], contract: null };
      return {
        candles: [{
          symbol: 'MNQ',
          timestamp: '2026-08-13T12:34:00.000Z',
          open: 29870,
          high: 29890,
          low: 29868,
          close: 29886,
          volume: 1200,
          source: 'ib_historical',
        }],
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
      };
    },
    getQuote: (symbol) => {
      if (symbol !== 'MNQ') return null;
      return {
        root: 'MNQ',
        symbol: 'MNQ',
        timestamp: '2026-08-13T12:34:58.000Z',
        bid: 29886,
        ask: 29886.5,
        last: 29886.25,
        source: 'ibkr_realtime',
      };
    },
  };
}

console.log('futuresCanonicalSignalProviderService.featureFlag');

assert.equal(_internal.envFlagEnabled(undefined), false);
assert.equal(_internal.envFlagEnabled('false'), false);
assert.equal(_internal.envFlagEnabled('true'), true);
assert.equal(_internal.isNativeProviderEnabled({ FUTURES_NATIVE_PROVIDER_ENABLED: 'true' }), true);

let legacyReaderCalls = 0;
let legacyProducerCalls = 0;
const offNativeProvider = nativeProvider();
const offProvider = createFuturesCanonicalSignalProviderService({
  env: { FUTURES_NATIVE_PROVIDER_ENABLED: 'false' },
  nativeSignalProviderService: offNativeProvider,
  signalReader: () => {
    legacyReaderCalls += 1;
    return [legacySignal()];
  },
  signalProducers: [{
    STRATEGY_ID: 'legacy_producer',
    evaluate: () => {
      legacyProducerCalls += 1;
      return {
        ok: true,
        strategyId: 'legacy_producer',
        signalState: 'signal',
        signal: producerSignal(),
      };
    },
  }],
});
const off = offProvider.getCanonicalSignals({ now });

assert.equal(legacyReaderCalls, 1);
assert.equal(legacyProducerCalls, 1);
assert.equal(offNativeProvider.calls, 0);
assert.equal(off.signalInputs.length, 2);
assert.equal(off.signalInputs[0].signalId, 'legacy-reader-signal-1');
assert.equal(off.signalInputs[1].signalId, 'legacy-producer-signal-1');
assert.equal(off.signalInputs[0].lifecycleId, expectedLifecycleId('legacy-reader-signal-1'));
assert.equal(off.stats.readerSignalsRead, 1);
assert.equal(off.stats.providerSignalsRead, 1);
assert.equal(off.stats.providersEvaluated, 1);
assert.equal(Object.prototype.hasOwnProperty.call(off.providerResults, 'native_futures_signal_provider'), false);
console.log('  ok - flag OFF uses legacy reader/producers only');

let onLegacyReaderCalls = 0;
let onLegacyProducerCalls = 0;
const onNativeProvider = nativeProvider();
const onProvider = createFuturesCanonicalSignalProviderService({
  env: { FUTURES_NATIVE_PROVIDER_ENABLED: 'true' },
  nativeSignalProviderService: onNativeProvider,
  signalReader: () => {
    onLegacyReaderCalls += 1;
    throw new Error('legacy_reader_should_not_run_when_native_enabled');
  },
  signalProducers: [{
    STRATEGY_ID: 'legacy_producer',
    evaluate: () => {
      onLegacyProducerCalls += 1;
      throw new Error('legacy_producer_should_not_run_when_native_enabled');
    },
  }],
});
const on = onProvider.getCanonicalSignals({ now });

assert.equal(onLegacyReaderCalls, 0);
assert.equal(onLegacyProducerCalls, 0);
assert.equal(onNativeProvider.calls, 1);
assert.equal(on.ok, true);
assert.equal(on.signalInputs.length, 1);
assert.equal(on.signalInputs[0].signalId, nativeFixture.signalId);
assert.equal(on.signalInputs[0].marketType, 'futures');
assert.equal(on.signalInputs[0].signalSource, 'native_futures');
assert.equal(on.signalInputs[0].provider, 'ibkr');
assert.equal(on.signalInputs[0].exchange, 'CME');
assert.equal(on.signalInputs[0].lifecycleId, expectedLifecycleId(nativeFixture.signalId));
assert.equal(on.stats.readerSignalsRead, 0);
assert.equal(on.stats.providerSignalsRead, 1);
assert.equal(on.stats.providersEvaluated, 1);
assert.equal(on.providerResults.native_futures_signal_provider.providerId, 'native_futures_signal_provider');
assert.equal(on.providerResults.native_futures_signal_provider.signalState, 'signal');
console.log('  ok - flag ON uses native futures provider only');

const defaultNativeProviderPath = createFuturesCanonicalSignalProviderService({
  env: { FUTURES_NATIVE_PROVIDER_ENABLED: 'true' },
  signalReader: () => {
    throw new Error('legacy_reader_should_not_run_when_default_native_enabled');
  },
  signalProducers: [{
    STRATEGY_ID: 'legacy_producer',
    evaluate: () => {
      throw new Error('legacy_producer_should_not_run_when_default_native_enabled');
    },
  }],
});
const defaultNative = defaultNativeProviderPath.getCanonicalSignals({
  now,
  priceFeedService: nativePriceFeed(),
});

assert.equal(defaultNative.ok, true);
assert.equal(defaultNative.signalInputs.length, 1);
assert.equal(defaultNative.signalInputs[0].signalSource, 'native_futures');
assert.equal(defaultNative.signalInputs[0].strategyId, 'native_futures_momentum_v1');
assert.equal(defaultNative.signalInputs[0].symbol, 'MNQ');
assert.equal(defaultNative.stats.readerSignalsRead, 0);
assert.equal(defaultNative.stats.providerSignalsRead, 1);
console.log('  ok - flag ON default native provider creates signal from market data');

const candidateAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [],
});
const candidates = candidateAdapter.getFuturesCandidates({
  now,
  quotes: [],
  signalInputs: on.signalInputs,
});

assert.equal(candidates.ok, true);
assert.equal(candidates.signalsRead, 1);
assert.equal(candidates.candidates.length, 1);
assert.equal(candidates.candidates[0].signalId, nativeFixture.signalId);
assert.equal(candidates.candidates[0].symbol, 'MNQ');
assert.equal(candidates.candidates[0].marketType, 'futures');
assert.equal(candidates.candidates[0].signalSource, 'native_futures');
assert.equal(candidates.candidates[0].entryPrice, nativeFixture.entryPrice);
assert.equal(candidates.candidates[0].stopLoss, nativeFixture.stopLoss);
assert.equal(candidates.candidates[0].takeProfit, nativeFixture.takeProfit);
assert.equal(candidates.candidates[0].riskSource, 'signal_absolute_levels');
assert.equal(candidates.candidates[0].tradeType, 'canonical_signal');
console.log('  ok - unchanged candidate adapter consumes native futures signalInputs');

console.log('\nfuturesCanonicalSignalProviderService.featureFlag.test.js passed');
