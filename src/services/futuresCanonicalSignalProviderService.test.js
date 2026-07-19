'use strict';

const assert = require('assert/strict');

const { createFuturesCanonicalSignalProviderService } = require('./futuresCanonicalSignalProviderService');

const now = '2026-07-16T10:00:00.000Z';

const readerSignal = {
  signalId: 'reader-signal-1',
  strategyId: 'trend_continuation',
  symbol: 'QQQ',
  direction: 'long',
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  createdAt: now,
};

const providerSignal = {
  signalId: 'provider-signal-1',
  strategyId: 'mnq_globex_momentum_v1',
  symbol: 'MNQ',
  direction: 'long',
  entry: 20000,
  stopLossPct: 0.3,
  takeProfitPct: 0.6,
  riskReward: 2,
  createdAt: now,
};

let producerCalls = 0;
const provider = createFuturesCanonicalSignalProviderService({
  signalReader: () => [readerSignal],
  signalProducers: [{
    STRATEGY_ID: 'mnq_globex_momentum_v1',
    evaluate: ({ now: evaluationNow }) => {
      producerCalls += 1;
      return {
        ok: true,
        strategyId: 'mnq_globex_momentum_v1',
        signalState: 'signal',
        direction: 'long',
        dataQuality: 'real',
        timestamp: new Date(evaluationNow).toISOString(),
        producerEvidence: { latestCandleTimestamp: now },
        signal: providerSignal,
      };
    },
  }],
});

const result = provider.getCanonicalSignals({ now });

assert.equal(result.ok, true);
assert.equal(producerCalls, 1);
assert.equal(result.signalInputs.length, 2);
assert.equal(result.signalInputs[0], readerSignal);
assert.equal(result.signalInputs[1], providerSignal);
assert.equal(result.stats.signalInputsRead, 2);
assert.equal(result.stats.readerSignalsRead, 1);
assert.equal(result.stats.providerSignalsRead, 1);
assert.equal(result.stats.providersEvaluated, 1);
assert.equal(result.providerResults.mnq_globex_momentum_v1.signals, 1);
assert.equal(result.providerResults.mnq_globex_momentum_v1.signalState, 'signal');
assert.equal(result.providerResults.mnq_globex_momentum_v1.latestSignalTimestamp, now);
assert.equal(Object.prototype.hasOwnProperty.call(result, 'candidates'), false);

console.log('futuresCanonicalSignalProviderService.test.js passed');
