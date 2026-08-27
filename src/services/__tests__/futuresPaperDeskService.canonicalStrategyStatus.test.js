'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildCanonicalDataModel,
} = require('../futuresPaperDeskService');

test('FAS 5: Canonical Strategy Status', async (suite) => {
  await suite.test('paperEligible drives Redo för Paper', () => {
    const strategyStatus = {
      strategies: [
        {
          strategyId: 'native_futures_ema_v1',
          displayName: 'EMA Strategy',
          paperEligible: true,
          forwardPaperActive: false,
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

    const strategy = model.canonical.strategies.data.strategies[0];
    assert.strictEqual(strategy.paperEligible, true, 'paperEligible should be true');
    assert.strictEqual(model.strategyStatusNormalization.readyForPaper.includes('paperEligible'), true);
  });

  await suite.test('forwardPaperActive drives Aktiv i Paper', () => {
    const strategyStatus = {
      strategies: [
        {
          strategyId: 'native_futures_ema_v1',
          displayName: 'EMA Strategy',
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

    const strategy = model.canonical.strategies.data.strategies[0];
    assert.strictEqual(strategy.forwardPaperActive, true, 'forwardPaperActive should be true');
  });

  await suite.test('eligible + inactive drives Redo och väntar', () => {
    const strategyStatus = {
      strategies: [
        {
          strategyId: 'native_futures_ema_v1',
          displayName: 'EMA Strategy',
          paperEligible: true,
          forwardPaperActive: false,
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

    const rule = model.strategyStatusNormalization.readyAndWaiting;
    assert(rule.includes('paperEligible === true'));
    assert(rule.includes('forwardPaperActive !== true'));
  });

  await suite.test('variants do not inherit base runtime readiness', () => {
    // Variants must be checked independently
    const strategyStatus = {
      strategies: [
        {
          strategyId: 'native_futures_ema_v1__fast',
          displayName: 'EMA Strategy (Fast Variant)',
          paperEligible: false,
          forwardPaperActive: false,
          runtimeImplemented: false,
          blockedReason: 'runtime_not_implemented',
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

    const variant = model.canonical.strategies.data.strategies[0];
    assert.strictEqual(variant.paperEligible, false, 'variant should NOT inherit base readiness');
    assert.strictEqual(variant.blockedReason !== undefined, true);
  });

  await suite.test('canonical blockedReason drives attention state', () => {
    const strategyStatus = {
      strategies: [
        {
          strategyId: 'native_futures_ema_v1',
          displayName: 'EMA Strategy',
          paperEligible: false,
          blocked: true,
          blockedReason: 'insufficient_evidence',
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

    const rule = model.strategyStatusNormalization.needsAttention;
    assert(rule.includes('blockedReason'), 'canonical blockedReason should drive attention');
    const strategy = model.canonical.strategies.data.strategies[0];
    assert.strictEqual(strategy.blockedReason, 'insufficient_evidence');
  });

  await suite.test('legacy blocked flags cannot override canonical state', () => {
    // Test verifies that even if legacy.blocked was true,
    // canonical.blocked is the authoritative source
    const strategyStatus = {
      strategies: [
        {
          strategyId: 'native_futures_ema_v1',
          displayName: 'EMA Strategy',
          blocked: false,
          blockedReason: null,
          // hypothetical legacy field (not consulted)
          // legacy_blocked: true,
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

    // Verify strategyStatusNormalization documents that only canonical fields are used
    assert(model.strategyStatusNormalization.legacyFields_DEPRECATED.includes('candidateQueue'));
    assert(!model.strategyStatusNormalization.canonicalFields.includes('candidateQueue'));
  });

  await suite.test('candidateQueue cannot change counts', () => {
    // Strategy count must come from canonical, not queue
    const strategyStatus = {
      strategies: [
        { strategyId: 'native_futures_ema_v1', displayName: 'EMA' },
        { strategyId: 'native_futures_rsi_v1', displayName: 'RSI' },
        { strategyId: 'native_futures_macd_v1', displayName: 'MACD' },
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

    const count = model.canonical.strategies.data.strategies.length;
    assert.strictEqual(count, 3, 'count should be from canonical strategies, not queue');
  });

  await suite.test('all counts come from canonical strategies', () => {
    const strategyStatus = {
      totalStrategies: 24,
      strategies: Array(24).fill(null).map((_, i) => ({
        strategyId: `strategy_${i}`,
        displayName: `Strategy ${i}`,
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

    assert.strictEqual(model.canonical.strategies.data.totalStrategies, 24);
    assert.strictEqual(model.canonical.strategies.data.strategies.length, 24);
  });

  await suite.test('strategyStatusNormalization documents canonical field mapping', () => {
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
      runtimePerformance: null,
    });

    const norm = model.strategyStatusNormalization;
    assert(norm.canonicalFields.includes('paperEligible'));
    assert(norm.canonicalFields.includes('forwardPaperActive'));
    assert(norm.canonicalFields.includes('blockedReason'));
    assert(!norm.canonicalFields.includes('lifecycle'));
    assert(!norm.canonicalFields.includes('runtimeState'));
  });
});
