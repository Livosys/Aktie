'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');

const { createFuturesCanonicalSignalProviderService } = require('./futuresCanonicalSignalProviderService');

const now = '2026-07-16T10:00:00.000Z';

function expectedLifecycleId(signalId) {
  return `signal_lifecycle_${crypto.createHash('sha1').update(signalId).digest('hex').slice(0, 24)}`;
}

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

const existingLifecycleSignal = {
  signalId: 'reader-signal-existing-life',
  lifecycleId: 'life-existing-signal',
  strategyId: 'trend_continuation',
  symbol: 'QQQ',
  direction: 'long',
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  createdAt: now,
};

let producerCalls = 0;
const provider = createFuturesCanonicalSignalProviderService({
  signalReader: () => [readerSignal, existingLifecycleSignal],
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
assert.equal(result.signalInputs.length, 3);
assert.notEqual(result.signalInputs[0], readerSignal);
assert.equal(result.signalInputs[0].signalId, readerSignal.signalId);
assert.equal(result.signalInputs[0].lifecycleId, expectedLifecycleId(readerSignal.signalId));
assert.equal(Object.prototype.hasOwnProperty.call(result.signalInputs[0], 'candidateId'), false);
assert.equal(Object.prototype.hasOwnProperty.call(readerSignal, 'lifecycleId'), false);
assert.equal(result.signalInputs[1], existingLifecycleSignal);
assert.equal(result.signalInputs[1].lifecycleId, 'life-existing-signal');
assert.notEqual(result.signalInputs[2], providerSignal);
assert.equal(result.signalInputs[2].signalId, providerSignal.signalId);
assert.equal(result.signalInputs[2].lifecycleId, expectedLifecycleId(providerSignal.signalId));
assert.equal(Object.prototype.hasOwnProperty.call(providerSignal, 'lifecycleId'), false);
assert.equal(result.stats.signalInputsRead, 3);
assert.equal(result.stats.readerSignalsRead, 2);
assert.equal(result.stats.providerSignalsRead, 1);
assert.equal(result.stats.providersEvaluated, 1);
assert.equal(result.providerResults.mnq_globex_momentum_v1.signals, 1);
assert.equal(result.providerResults.mnq_globex_momentum_v1.signalState, 'signal');
assert.equal(result.providerResults.mnq_globex_momentum_v1.latestSignalTimestamp, now);
assert.equal(
  result.providerResults.mnq_globex_momentum_v1.result.signal.lifecycleId,
  expectedLifecycleId(providerSignal.signalId),
);
assert.equal(Object.prototype.hasOwnProperty.call(result, 'candidates'), false);

const missingSignalIdProvider = createFuturesCanonicalSignalProviderService({
  signalReader: () => [{
    id: 'not-a-signal-id-root',
    strategyId: 'mnq_globex_momentum_v1',
    symbol: 'MNQ',
    direction: 'long',
    entry: 20000,
    stopLossPct: 0.3,
    takeProfitPct: 0.6,
    riskReward: 2,
    createdAt: now,
  }],
  signalProducers: [],
});
const missingSignalId = missingSignalIdProvider.getCanonicalSignals({ now });
assert.equal(missingSignalId.signalInputs.length, 1);
assert.equal(Object.prototype.hasOwnProperty.call(missingSignalId.signalInputs[0], 'lifecycleId'), false);

console.log('futuresCanonicalSignalProviderService.test.js passed');
