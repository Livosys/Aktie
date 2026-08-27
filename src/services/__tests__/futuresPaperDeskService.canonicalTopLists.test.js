'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildCanonicalDataModel,
} = require('../futuresPaperDeskService');

test('FAS 6: Canonical Top Lists', async (suite) => {
  await suite.test('bestResult sorts descending by canonical netPnlSek', () => {
    const strategies = [
      {
        strategyId: 'native_futures_ema_v1',
        displayName: 'EMA Strategy',
        netPnlSek: 100,
        closedTrades: 5,
        winRatePct: 60,
      },
      {
        strategyId: 'native_futures_rsi_v1',
        displayName: 'RSI Strategy',
        netPnlSek: 250,
        closedTrades: 5,
        winRatePct: 55,
      },
      {
        strategyId: 'native_futures_macd_v1',
        displayName: 'MACD Strategy',
        netPnlSek: 50,
        closedTrades: 5,
        winRatePct: 50,
      },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies },
    });

    const bestResult = model.rankings.rankings.bestResult;
    assert.strictEqual(bestResult.canonical, true);
    assert.strictEqual(bestResult.strategyId, 'native_futures_rsi_v1', 'should be highest netPnl');
    assert.strictEqual(bestResult.value, 250);
    assert(bestResult.source.includes('futuresPaperStrategyPerformanceService'));
  });

  await suite.test('negative bestResult is labeled correctly', () => {
    const strategies = [
      { strategyId: 'strategy_a', displayName: 'Strategy A', netPnlSek: -100, closedTrades: 5 },
      { strategyId: 'strategy_b', displayName: 'Strategy B', netPnlSek: -50, closedTrades: 5 },
      { strategyId: 'strategy_c', displayName: 'Strategy C', netPnlSek: -200, closedTrades: 5 },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies },
    });

    const bestResult = model.rankings.rankings.bestResult;
    assert.strictEqual(bestResult.strategyId, 'strategy_b', 'should be best (least negative)');
    assert.strictEqual(bestResult.value, -50);
    assert(bestResult.meaning.includes('negative'), 'meaning must indicate all results are negative');
  });

  await suite.test('highestWinRate sorts correctly', () => {
    const strategies = [
      { strategyId: 'strategy_a', displayName: 'Strategy A', winRatePct: 75, closedTrades: 5 },
      { strategyId: 'strategy_b', displayName: 'Strategy B', winRatePct: 60, closedTrades: 5 },
      { strategyId: 'strategy_c', displayName: 'Strategy C', winRatePct: 55, closedTrades: 5 },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies },
    });

    const highestWinRate = model.rankings.rankings.highestWinRate;
    assert.strictEqual(highestWinRate.canonical, true);
    assert.strictEqual(highestWinRate.strategyId, 'strategy_a');
    assert.strictEqual(highestWinRate.value, 75);
    assert(highestWinRate.source.includes('futuresPaperStrategyPerformanceService'));
  });

  await suite.test('missing winRate is not mis-ranked', () => {
    const strategies = [
      { strategyId: 'strategy_a', displayName: 'Strategy A', winRatePct: null, closedTrades: 0 },
      { strategyId: 'strategy_b', displayName: 'Strategy B', winRatePct: 60, closedTrades: 5 },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies },
    });

    const highestWinRate = model.rankings.rankings.highestWinRate;
    assert.strictEqual(highestWinRate.canonical, true);
    assert.strictEqual(highestWinRate.strategyId, 'strategy_b', 'should rank only strategies with winRate data');
  });

  await suite.test('winRate requires minimum 5 closed trades', () => {
    const strategies = [
      { strategyId: 'strategy_a', displayName: 'Strategy A', winRatePct: 100, closedTrades: 1 },
      { strategyId: 'strategy_b', displayName: 'Strategy B', winRatePct: 60, closedTrades: 5 },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies },
    });

    const highestWinRate = model.rankings.rankings.highestWinRate;
    assert.strictEqual(highestWinRate.strategyId, 'strategy_b', 'should exclude strategy_a (only 1 trade)');
    assert((highestWinRate.closedTrades || 0) >= 5, 'winner must have minimum trades');
  });

  await suite.test('variant uses its own netPnl, not base', () => {
    const strategies = [
      {
        strategyId: 'native_futures_ema_v1',
        displayName: 'EMA Base',
        netPnlSek: 1000,
        closedTrades: 10,
        winRatePct: 65,
      },
      {
        strategyId: 'native_futures_ema_v1__fast',
        displayName: 'EMA Fast Variant',
        netPnlSek: -200,
        closedTrades: 5,
        winRatePct: 40,
      },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies },
    });

    const bestResult = model.rankings.rankings.bestResult;
    assert.strictEqual(bestResult.strategyId, 'native_futures_ema_v1', 'base has best result');
    assert.strictEqual(bestResult.value, 1000);

    const highestWinRate = model.rankings.rankings.highestWinRate;
    assert.strictEqual(highestWinRate.strategyId, 'native_futures_ema_v1', 'base has best win rate');
  });

  await suite.test('legacy score fields are NOT used for ranking', () => {
    const strategies = [
      {
        strategyId: 'strategy_a',
        displayName: 'Strategy A',
        netPnlSek: 50,
        winRatePct: 50,
        closedTrades: 5,
        // legacy fields that should NOT affect ranking
        score: 100,
        strategyScore: 95,
        confidenceScore: 90,
      },
    ];

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies },
    });

    // Verify bestResult uses only netPnlSek, not legacy score
    const bestResult = model.rankings.rankings.bestResult;
    assert.strictEqual(bestResult.metric, 'netPnlSek', 'should use canonical metric only');
    assert(!bestResult.source.includes('score'), 'should not reference legacy score sources');
  });

  await suite.test('no improvement metric without canonical definition', () => {
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies: [] },
    });

    const biggestImprovement = model.rankings.rankings.biggestImprovement;
    assert.strictEqual(biggestImprovement.canonical, false, 'should be marked non-canonical');
    assert(biggestImprovement.stale, 'should be marked stale');
    assert(biggestImprovement.note.includes('Improvement metric'), 'should explain why');
  });

  await suite.test('no promising metric without canonical definition', () => {
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies: [] },
    });

    const mostPromising = model.rankings.rankings.mostPromising;
    assert.strictEqual(mostPromising.canonical, false, 'should be marked non-canonical');
    assert(mostPromising.stale, 'should be marked stale');
    assert(mostPromising.note.includes('Promising metric'), 'should explain why');
  });

  await suite.test('rankings field documents canonical ownership', () => {
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies: [] },
    });

    const rankings = model.rankings;
    assert(rankings.canonicalOwnership, 'should document ownership');
    assert(rankings.canonicalOwnership.bestResult.includes('netPnlSek'));
    assert(rankings.canonicalOwnership.highestWinRate.includes('winRatePct'));
    assert(rankings.legacySourcesRemoved, 'should list removed legacy sources');
    assert(rankings.legacySourcesRemoved.some((s) => s.includes('score')));
  });

  await suite.test('empty strategy list fails closed', () => {
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies: [] },
    });

    const bestResult = model.rankings.rankings.bestResult;
    assert.strictEqual(bestResult.canonical, false);
    assert(bestResult.stale, 'should mark stale when no data');
    assert(bestResult.note.includes('No strategies'));
  });
});
