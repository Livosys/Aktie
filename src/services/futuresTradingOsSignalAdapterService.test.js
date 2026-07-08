'use strict';

const assert = require('assert/strict');

const {
  createFuturesTradingOsSignalAdapterService,
  mapSignalToFutures,
} = require('./futuresTradingOsSignalAdapterService');

const now = '2026-07-06T11:00:00.000Z';
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
  approved: true,
  approvalReason: 'test_approved_signal',
  strategyLogicVersion: 'test-v1',
  createdAt: now,
};

assert.deepEqual(mapSignalToFutures({ symbol: 'QQQ', market: 'stocks' }).futuresSymbol, 'MNQ');
assert.deepEqual(mapSignalToFutures({ symbol: 'SPY', market: 'stocks' }).futuresSymbol, 'MES');
assert.equal(mapSignalToFutures({ symbol: 'XYZ', market: 'stocks' }).mappingReason, 'no_safe_futures_mapping');

const adapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [signal],
  approvalService: {
    evaluateSignal: () => ({
      approved: true,
      strategyId: 'trend_continuation',
      strategyName: 'Trend Continuation',
      approvalReason: 'test_approved_signal',
    }),
  },
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
assert.equal(result.stats.tradingOsSignalsRead, 1);
assert.equal(result.stats.signalsMappedToFutures, 1);
assert.equal(result.candidates.length, 1);

const candidate = result.candidates[0];
assert.equal(candidate.tradeType, 'trading_os_signal');
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

const noRiskAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [{ ...signal, stopLoss: undefined, takeProfit: undefined, stopLossPct: undefined, targetPct: undefined, symbol: 'NDX' }],
  approvalService: { evaluateSignal: () => ({ approved: true }) },
});
const noRisk = noRiskAdapter.getFuturesCandidates({ now, quotes: [{ root: 'MNQ', price: 20000, source: 'real_market_data' }] });
assert.equal(noRisk.candidates.length, 0);
assert.equal(noRisk.stats.signalsSkippedNoRisk, 1);

console.log('futuresTradingOsSignalAdapterService.test.js passed');
