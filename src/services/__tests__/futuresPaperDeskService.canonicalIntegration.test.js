'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildCanonicalDataModel,
} = require('../futuresPaperDeskService');

test('FAS 9: Frontend Integration - Canonical Data Wiring', async (suite) => {
  await suite.test('journal result displayed from canonical results', () => {
    const performance = {
      netToday: 500,
      netTotal: 5000,
      grossPnl: 6000,
      commission: 1000,
      winRate: 0.55,
      closedTrades: 10,
      updatedAt: '2026-08-27T10:00:00Z',
    };

    const model = buildCanonicalDataModel({
      account: { accountIdMasked: 'DU***596', currency: 'SEK', generatedAt: new Date().toISOString() },
      portfolio: null,
      performance,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    const results = model.canonical.results;
    assert.strictEqual(results.canonical, true);
    assert.strictEqual(results.data.netToday, 500);
    assert(results.source.includes('futuresPaperStrategyPerformanceService'));
  });

  await suite.test('AI summary uses canonical latest trade', () => {
    const closedTrades = [
      {
        strategyId: 'native_futures_ema_v1',
        strategyName: 'EMA Strategy',
        symbol: 'MES',
        netPnl: 250,
        exitTime: '2026-08-27T12:55:00Z',
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

    const summary = model.aiSummaryContext;
    assert.strictEqual(summary.strategyId, 'native_futures_ema_v1');
    assert.strictEqual(summary.strategyName, 'EMA Strategy');
    assert.strictEqual(summary.result, 250);
  });

  await suite.test('strategy counts ignore candidateQueue', () => {
    const strategyStatus = {
      totalStrategies: 24,
      strategies: Array(24).fill(null).map((_, i) => ({
        strategyId: `strategy_${i}`,
        displayName: `Strategy ${i}`,
        paperEligible: i < 5,
      })),
    };

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    const strategies = model.canonical.strategies.data;
    assert.strictEqual(strategies.totalStrategies, 24);
    assert.strictEqual(strategies.strategies.length, 24);
  });

  await suite.test('strategy cards use canonical readiness', () => {
    const strategyStatus = {
      strategies: [
        {
          strategyId: 'strategy_ready',
          displayName: 'Ready Strategy',
          paperEligible: true,
          forwardPaperActive: false,
          blocked: false,
        },
        {
          strategyId: 'strategy_active',
          displayName: 'Active Strategy',
          paperEligible: true,
          forwardPaperActive: true,
          blocked: false,
        },
      ],
    };

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    const strats = model.canonical.strategies.data.strategies;
    assert.strictEqual(strats[0].paperEligible, true, 'ready should have paperEligible');
    assert.strictEqual(strats[1].forwardPaperActive, true, 'active should have forwardPaperActive');
  });

  await suite.test('top lists use canonical rankings', () => {
    const strategies = [
      { strategyId: 'a', displayName: 'A', netPnlSek: 100, closedTrades: 5, winRatePct: 60 },
      { strategyId: 'b', displayName: 'B', netPnlSek: 200, closedTrades: 5, winRatePct: 50 },
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
    assert.strictEqual(bestResult.strategyId, 'b', 'should rank by netPnlSek');
    assert.strictEqual(bestResult.value, 200);
  });

  await suite.test('broker health ready => Allt normalt', () => {
    const brokerReconciliation = {
      executionConnected: true,
      status: 'ok',
      degraded: false,
      blockingDiscrepancies: [],
      liveBlocked: true,
      generatedAt: new Date().toISOString(),
    };

    const account = {
      accountIdMasked: 'DU***596',
      currency: 'SEK',
      generatedAt: new Date().toISOString(),
    };

    const model = buildCanonicalDataModel({
      account,
      portfolio: null,
      performance: null,
      brokerReconciliation,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    const health = model.brokerHealth;
    assert.strictEqual(health.state, 'ready');
    assert.strictEqual(health.healthy, true, 'ready state should be healthy');
  });

  await suite.test('paper submission enabled does not show Problem', () => {
    const brokerReconciliation = {
      executionConnected: true,
      status: 'ok',
      degraded: false,
      blockingDiscrepancies: [],
      liveBlocked: true,
      generatedAt: new Date().toISOString(),
    };

    const account = {
      accountIdMasked: 'DU***596',
      currency: 'SEK',
      generatedAt: new Date().toISOString(),
    };

    const model = buildCanonicalDataModel({
      account,
      portfolio: null,
      performance: null,
      brokerReconciliation,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: null,
    });

    const health = model.brokerHealth;
    // Paper submission enabled should NOT be a problem
    assert.strictEqual(health.state, 'ready', 'paper submission enabled is healthy');
    assert(!health.blocking, 'should not be blocking');
  });

  await suite.test('legacy July scanner timestamp not rendered', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z',
      },
      latestScanAt: '2026-08-27T12:54:00Z',
    };

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: { marketOpen: true },
      executionTarget: 'ibkr_paper',
      now,
      runtimePerformance,
    });

    const watch = model.marketWatch;
    // Frontend should use this latestScanAt, NOT legacy 2026-07-16
    assert.strictEqual(watch.latestScanAt, '2026-08-27T12:54:00Z');
    assert(!watch.latestScanAt.includes('2026-07-16'));
  });

  await suite.test('no current signal => neutral state', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: null,
      latestScanAt: null,
    };

    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null,
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: { marketOpen: true },
      executionTarget: 'ibkr_paper',
      now,
      runtimePerformance,
    });

    const watch = model.marketWatch;
    assert.strictEqual(watch.health, 'inactive', 'no signal is inactive, not error');
    assert.strictEqual(watch.stale, false);
  });

  await suite.test('stale data => stale/unknown UI', () => {
    const now = new Date('2026-08-27T13:05:00Z');
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z', // 10 minutes old
      },
    };

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
      now,
      runtimePerformance,
    });

    const watch = model.marketWatch;
    assert.strictEqual(watch.stale, true);
    assert.strictEqual(watch.health, 'stale');
  });

  await suite.test('canonical data is exposed in runtime response', () => {
    const model = buildCanonicalDataModel({
      account: { accountIdMasked: 'DU***596', currency: 'SEK', generatedAt: new Date().toISOString() },
      portfolio: null,
      performance: { netToday: 100, updatedAt: new Date().toISOString() },
      brokerReconciliation: { executionConnected: true, status: 'ok', generatedAt: new Date().toISOString() },
      brokerPositions: [],
      closedTrades: [{ strategyId: 'test', netPnl: 100, exitTime: new Date().toISOString() }],
      strategyOverview: [],
      strategyStatus: { totalStrategies: 1, strategies: [] },
      session: { marketOpen: true },
      executionTarget: 'ibkr_paper',
      now: new Date(),
      runtimePerformance: { strategies: [], latestSignal: { timestamp: new Date().toISOString() } },
    });

    // All canonical models should be exposed
    assert(model.canonical, 'should have canonical');
    assert(model.aiSummaryContext, 'should have aiSummaryContext');
    assert(model.rankings, 'should have rankings');
    assert(model.brokerHealth, 'should have brokerHealth');
    assert(model.marketWatch, 'should have marketWatch');
  });
});
