'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildCanonicalDataModel,
} = require('../futuresPaperDeskService');

test('FAS 4: Canonical AI Summary', async (suite) => {
  await suite.test('latest native trade determines strategy identity', () => {
    const closedTrades = [
      {
        strategyId: 'native_futures_ema_pullback_continuation_v1',
        strategyName: 'EMA Pullback Continuation',
        symbol: 'MES',
        direction: 'LONG',
        netPnl: 182.69,
        exitTime: '2026-08-27T10:15:00Z',
      },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades,
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    assert.strictEqual(model.aiSummaryContext.strategyId, 'native_futures_ema_pullback_continuation_v1');
    assert.strictEqual(model.aiSummaryContext.strategyName, 'EMA Pullback Continuation');
    assert.strictEqual(model.aiSummaryContext.symbol, 'MES');
    assert.strictEqual(model.aiSummaryContext.result, 182.69);
    assert.strictEqual(model.aiSummaryContext.canonical, true);
    assert.strictEqual(model.aiSummaryContext.source, 'latest_canonical_closed_trade');
  });

  await suite.test('legacy queue cannot override strategy identity', () => {
    // This test verifies that even if queueCandidates had data,
    // aiSummaryContext comes from closed trades, not queue

    const closedTrades = [
      {
        strategyId: 'native_futures_narrow_fakeout_reversal_v1',
        strategyName: 'Narrow Fakeout Reversal',
        symbol: 'MNQ',
        netPnl: 250.00,
      },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades,
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    // Verify it comes from trade, not from a hypothetical queue
    assert.strictEqual(model.aiSummaryContext.source, 'latest_canonical_closed_trade');
    assert.strictEqual(model.aiSummaryContext.strategyName, 'Narrow Fakeout Reversal');
    assert.strictEqual(model.legacy.deprecated.includes('candidateQueue'), true);
  });

  await suite.test('canonical daily result is used', () => {
    const closedTrades = [
      {
        strategyId: 'native_futures_ema_v1',
        strategyName: 'EMA Strategy',
        netPnl: 500.00,
        resultCurrency: 'SEK',
      },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades,
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    assert.strictEqual(model.aiSummaryContext.result, 500.00);
    assert.strictEqual(model.aiSummaryContext.resultCurrency, 'SEK');
  });

  await suite.test('stale activity fails closed', () => {
    // When there are no closed trades, show unavailable
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],  // No trades
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    assert.strictEqual(model.aiSummaryContext.canonical, false);
    assert.strictEqual(model.aiSummaryContext.stale, true);
    assert.strictEqual(model.aiSummaryContext.strategyId, null);
    assert.strictEqual(model.aiSummaryContext.note.includes('No recent canonical'), true);
  });

  await suite.test('missing activity shows neutral fallback', () => {
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: null,  // Null, not array
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    assert.strictEqual(model.aiSummaryContext.source, 'none');
    assert.strictEqual(model.aiSummaryContext.canonical, false);
    assert(model.aiSummaryContext.note.includes('No recent canonical trade'));
  });

  await suite.test('legacy queue dependency is removed', () => {
    // Verify that aiSummaryContext does not reference queueCandidates
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [
        { strategyId: 'native_futures_test', strategyName: 'Test' },
      ],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    // aiSummaryContext source must NOT be candidateQueue
    assert.strictEqual(model.aiSummaryContext.source, 'latest_canonical_closed_trade');
    assert(!model.aiSummaryContext.source.includes('queue'));
    assert(model.legacy.deprecated.includes('candidateQueue'));
  });

  await suite.test('multiple closed trades use latest', () => {
    const closedTrades = [
      {
        strategyId: 'native_futures_ema_v1',
        strategyName: 'EMA Strategy',
        symbol: 'MES',
        netPnl: 182.69,
        exitTime: '2026-08-27T10:15:00Z',
      },
      {
        strategyId: 'native_futures_rsi_v1',
        strategyName: 'RSI Strategy',
        symbol: 'MNQ',
        netPnl: 95.00,
        exitTime: '2026-08-27T09:00:00Z',
      },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades,
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    // Should use first (latest) trade
    assert.strictEqual(model.aiSummaryContext.strategyName, 'EMA Strategy');
    assert.strictEqual(model.aiSummaryContext.symbol, 'MES');
    assert.strictEqual(model.aiSummaryContext.result, 182.69);
  });
});
