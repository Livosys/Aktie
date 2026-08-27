'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildCanonicalDataModel,
} = require('../futuresPaperDeskService');

test('FAS 2: Canonical Ownership Layer', async (suite) => {
  await suite.test('legacy candidateQueue is NOT canonical', () => {
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
    });

    assert.strictEqual(model.legacy.active, false, 'legacy should not be active');
    assert(model.legacy.deprecated.includes('candidateQueue'), 'candidateQueue should be marked deprecated');
    assert(!model.canonical.strategies.canonical, 'strategies should not be canonical when no strategyStatus');
  });

  await suite.test('legacy scanHistory is NOT canonical', () => {
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
    });

    assert(model.legacy.deprecated.includes('scanHistory'), 'scanHistory should be marked deprecated');
    assert(model.legacy.note.includes('diagnostic') || model.legacy.note.includes('available for'), 'legacy note should warn against canonical use');
  });

  await suite.test('current results come from canonical performance', () => {
    const performance = {
      netToday: 1234.56,
      netTotal: 5000,
      grossPnl: 6000,
      netPnl: 5000,
      commission: 1000,
      winRate: 0.55,
      closedTrades: 10,
      updatedAt: '2026-08-27T10:00:00Z',
    };

    const model = buildCanonicalDataModel({
      account: null,
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
    });

    assert.strictEqual(model.canonical.results.canonical, true, 'results should be canonical');
    assert.strictEqual(model.canonical.results.source, 'futuresPaperStrategyPerformanceService');
    assert.strictEqual(model.canonical.results.data.netToday, 1234.56);
    assert.strictEqual(model.canonical.results.data.closedTrades, 10);
  });

  await suite.test('current broker state comes from reconciliation', () => {
    const brokerReconciliation = {
      generatedAt: '2026-08-27T10:00:00Z',
      executionConnected: true,
      status: 'ok',
      degraded: false,
      openOrders: [{}, {}],
      executions: [{}, {}, {}],
    };

    const account = {
      accountIdMasked: 'DU***123',
      currency: 'SEK',
      dailyPnl: 500,
      generatedAt: '2026-08-27T10:00:00Z',
    };

    const model = buildCanonicalDataModel({
      account,
      portfolio: null,
      performance: null,
      brokerReconciliation,
      brokerPositions: [{}, {}],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: null,
      session: null,
      executionTarget: 'ibkr_paper',
      now: new Date(),
    });

    assert.strictEqual(model.canonical.broker.canonical, true, 'broker should be canonical');
    assert.strictEqual(model.canonical.broker.source, 'ibPaperExecutionOrchestratorService.reconciliation');
    assert.strictEqual(model.canonical.broker.data.connected, true);
    assert.strictEqual(model.canonical.broker.data.positions, 2);
    assert.strictEqual(model.canonical.broker.data.orders, 2);
  });

  await suite.test('strategy status comes from canonical registry', () => {
    const strategyStatus = {
      totalStrategies: 24,
      tradableNow: 5,
      strategies: [
        {
          strategyId: 'native_futures_ema_v1',
          displayName: 'EMA Pullback',
          status: 'active',
          paperEligible: true,
          forwardPaperActive: true,
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
    });

    assert.strictEqual(model.canonical.strategies.canonical, true, 'strategies should be canonical');
    assert.strictEqual(model.canonical.strategies.source, 'nativeFuturesStrategyRegistryService + strategyLibraryEnrichment');
    assert.strictEqual(model.canonical.strategies.data.totalStrategies, 24);
    assert.strictEqual(model.canonical.strategies.data.strategies[0].name, 'EMA Pullback');
    assert.strictEqual(model.canonical.strategies.data.strategies[0].paperEligible, true);
  });

  await suite.test('native runtime owns active runtime state', () => {
    const brokerReconciliation = {
      generatedAt: '2026-08-27T10:00:00Z',
      executionConnected: true,
    };

    const model = buildCanonicalDataModel({
      account: null,
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
    });

    assert.strictEqual(model.canonical.runtime.canonical, true, 'runtime should be canonical');
    assert.strictEqual(model.canonical.runtime.source, 'ibPaperExecutionOrchestratorService + futuresPaperScannerService');
    assert.strictEqual(model.canonical.runtime.data.mode, 'paper');
    assert.strictEqual(model.canonical.runtime.data.connected, true);
  });

  await suite.test('market status does NOT use stale legacy scanner.lastScanAt', () => {
    const session = {
      name: 'RTH',
      marketOpen: true,
      nextTransition: '2026-08-28T14:30:00Z',
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
      session,
      executionTarget: 'ibkr_paper',
      now: new Date('2026-08-27T10:00:00Z'),
    });

    assert.strictEqual(model.canonical.market.canonical, true, 'market should be canonical');
    assert.strictEqual(model.canonical.market.source, 'futuresMarketHoursService + futuresMarketDataService');
    assert.strictEqual(model.canonical.market.data.currentSession, 'RTH');
    // Verify that market status comes from session, NOT from legacy scanner.lastScanAt
    assert(!model.canonical.market.data.lastScanAt, 'market should NOT include lastScanAt from legacy scanner');
  });

  await suite.test('legacy deprecated fields are marked non-canonical', () => {
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
    });

    const deprecated = model.legacy.deprecated;
    assert(deprecated.includes('candidateQueue'), 'candidateQueue should be deprecated');
    assert(deprecated.includes('scanHistory'), 'scanHistory should be deprecated');
    assert(deprecated.includes('legacyInternalSimulation'), 'legacyInternalSimulation should be deprecated');
    assert(deprecated.includes('scanner.lastScanAt'), 'scanner.lastScanAt should be deprecated');
  });

  await suite.test('every canonical domain has source attribution', () => {
    const model = buildCanonicalDataModel({
      account: { accountIdMasked: 'DU***123', currency: 'SEK', generatedAt: '2026-08-27T10:00:00Z' },
      portfolio: null,
      performance: { netToday: 100, updatedAt: '2026-08-27T10:00:00Z' },
      brokerReconciliation: { generatedAt: '2026-08-27T10:00:00Z', executionConnected: true, status: 'ok' },
      brokerPositions: [],
      closedTrades: [],
      strategyOverview: [],
      strategyStatus: { totalStrategies: 1, strategies: [] },
      session: { name: 'RTH', marketOpen: true },
      executionTarget: 'ibkr_paper',
      now: new Date(),
    });

    const domains = ['results', 'broker', 'strategies', 'runtime', 'market', 'account'];
    for (const domain of domains) {
      const canonical = model.canonical[domain];
      assert(canonical, `${domain} should exist in canonical`);
      if (canonical.canonical === true) {
        assert(canonical.source, `${domain} should have source attribution`);
        assert(canonical.updatedAt !== undefined, `${domain} should have updatedAt`);
      }
    }
  });
});
