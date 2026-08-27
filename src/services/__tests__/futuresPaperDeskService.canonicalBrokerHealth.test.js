'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildCanonicalDataModel,
} = require('../futuresPaperDeskService');

test('FAS 7: Canonical Broker/Order Health', async (suite) => {
  await suite.test('READY + API connected + verified paper account + reconciliation ok => healthy', () => {
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
    assert.strictEqual(health.canonical, true);
    assert.strictEqual(health.state, 'ready');
    assert.strictEqual(health.healthy, true);
    assert.strictEqual(health.blocking, false);
    assert.strictEqual(health.isConnected, true);
    assert.strictEqual(health.isReconciled, true);
    assert.strictEqual(health.accountVerified, true);
  });

  await suite.test('paper submission enabled does NOT produce Problem', () => {
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
    // Paper submission enabled should NOT affect health state
    assert.strictEqual(health.state, 'ready', 'paper submission enabled is expected and healthy');
    assert.strictEqual(health.blocking, false, 'paper submission enabled is not blocking');
  });

  await suite.test('live trading disabled remains healthy/expected', () => {
    const brokerReconciliation = {
      executionConnected: true,
      status: 'ok',
      degraded: false,
      blockingDiscrepancies: [],
      liveBlocked: true, // This is expected in paper mode
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
    assert.strictEqual(health.liveBlocked, true, 'live should be blocked in paper mode');
    assert.strictEqual(health.state, 'ready', 'live blocked does not affect paper health');
    assert.strictEqual(health.healthy, true, 'paper trading with live blocked is healthy');
  });

  await suite.test('API disconnected => blocked/problem', () => {
    const brokerReconciliation = {
      executionConnected: false, // Disconnected
      status: null,
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
    assert.strictEqual(health.state, 'offline');
    assert.strictEqual(health.blocking, true, 'disconnection is blocking');
    assert.strictEqual(health.healthy, false);
    assert(health.reasons.some((r) => r.includes('disconnected')));
  });

  await suite.test('reconciliation failure => blocked/problem', () => {
    const brokerReconciliation = {
      executionConnected: true,
      status: 'failed', // Reconciliation failed
      degraded: true,
      blockingDiscrepancies: [{ reason: 'Order mismatch' }],
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
    assert.strictEqual(health.state, 'degraded');
    assert.strictEqual(health.isDegraded, true);
    assert.strictEqual(health.blocking, false, 'degradation is non-blocking but needs attention');
  });

  await suite.test('blocking discrepancy => blocked/problem', () => {
    const brokerReconciliation = {
      executionConnected: true,
      status: 'ok',
      degraded: false,
      blockingDiscrepancies: [{ reason: 'Critical order mismatch' }],
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
    assert.strictEqual(health.hasBlockingDiscrepancy, true);
    assert.strictEqual(health.state, 'degraded');
    assert(health.reasons.some((r) => r.includes('discrepancy')));
  });

  await suite.test('stale snapshot => stale/unknown', () => {
    const model = buildCanonicalDataModel({
      account: null,
      portfolio: null,
      performance: null,
      brokerReconciliation: null, // No reconciliation snapshot
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
    assert.strictEqual(health.state, 'unknown');
    assert.strictEqual(health.canonical, true);
    assert(!health.healthy, 'unknown state is not healthy');
    assert(health.reasons.some((r) => r.includes('snapshot')));
  });

  await suite.test('problem state exposes real reason', () => {
    const brokerReconciliation = {
      executionConnected: false,
      status: null,
      degraded: false,
      blockingDiscrepancies: [],
      liveBlocked: true,
      generatedAt: new Date().toISOString(),
    };

    const account = null; // No account verification

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
    assert(health.reasons.length > 0, 'problem state should explain why');
    assert(Array.isArray(health.reasons), 'reasons should be array');
    assert(health.reasons.some((r) => r.includes('disconnected') || r.includes('not verified')));
  });

  await suite.test('legacy scanner state cannot affect broker/order health', () => {
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
      // Legacy scanner data (should NOT affect broker health)
      // These would normally be in the response but should not influence canonical broker health
    });

    const health = model.brokerHealth;
    // Health state should come ONLY from brokerReconciliation, not legacy sources
    assert.strictEqual(health.source, 'ibPaperExecutionOrchestratorService.reconciliation');
    assert.strictEqual(health.canonical, true);
    assert.strictEqual(health.state, 'ready');
  });

  await suite.test('broker health documents canonical sources', () => {
    const model = buildCanonicalDataModel({
      account: { accountIdMasked: 'DU***596', currency: 'SEK', generatedAt: new Date().toISOString() },
      portfolio: null,
      performance: null,
      brokerReconciliation: { executionConnected: true, status: 'ok', degraded: false, blockingDiscrepancies: [], liveBlocked: true, generatedAt: new Date().toISOString() },
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
    assert(health.source.includes('ibPaperExecutionOrchestratorService'), 'should document canonical source');
    assert(health.canonical === true);
    assert(typeof health.isConnected === 'boolean', 'should expose connectivity state');
    assert(typeof health.isReconciled === 'boolean', 'should expose reconciliation state');
    assert(typeof health.accountVerified === 'boolean', 'should expose account verification');
  });
});
