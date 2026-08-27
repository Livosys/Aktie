'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildCanonicalDataModel,
} = require('../futuresPaperDeskService');

test('FAS 8: Canonical Market Watch / Latest Signal', async (suite) => {
  await suite.test('native signal owns latestSignalAt', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z',
        type: 'BUY',
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
    assert.strictEqual(watch.canonical, true);
    assert.strictEqual(watch.source.includes('futuresPaperScannerService'), true);
    assert.strictEqual(watch.latestSignalAt, '2026-08-27T12:55:00Z');
    assert.strictEqual(watch.active, true);
  });

  await suite.test('legacy scanner.lastScanAt cannot override native signal', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z',
      },
      latestScanAt: '2026-08-27T12:54:00Z',
      // Hypothetical legacy field (should be ignored)
      legacyLastScanAt: '2026-07-16T10:00:00Z',
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
    // Must show current signal (today), NOT legacy July timestamp
    assert.strictEqual(watch.latestSignalAt, '2026-08-27T12:55:00Z', 'should use native signal, not legacy');
    assert(!watch.latestSignalAt.includes('2026-07-16'), 'should never show July legacy timestamp');
  });

  await suite.test('no native signal => neutral "no current signal"', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: null, // No current signal
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
    assert.strictEqual(watch.active, false, 'should be inactive');
    assert.strictEqual(watch.health, 'inactive', 'should be marked inactive');
    assert.strictEqual(watch.latestSignalAt, null);
    assert.strictEqual(watch.stale, false, 'no signal is not stale, just inactive');
  });

  await suite.test('stale native signal => stale status', () => {
    const now = new Date('2026-08-27T13:05:00Z'); // 10 minutes after signal
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z', // 10 minutes old
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
    assert.strictEqual(watch.stale, true, 'signal older than 5 minutes should be stale');
    assert.strictEqual(watch.health, 'stale');
    assert(watch.reason.includes('age'), 'should explain why stale');
  });

  await suite.test('current signal => fresh status', () => {
    const now = new Date('2026-08-27T12:56:00Z'); // 1 minute after signal
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z', // 1 minute old
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
    assert.strictEqual(watch.stale, false, 'signal within 5 minutes should be fresh');
    assert.strictEqual(watch.health, 'fresh');
    assert.strictEqual(watch.active, true);
  });

  await suite.test('latest scan uses current runtime owner', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z',
      },
      latestScanAt: '2026-08-27T12:54:30Z',
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
    assert.strictEqual(watch.latestScanAt, '2026-08-27T12:54:30Z');
    assert(watch.source.includes('futuresPaperScannerService'), 'should use runtime scanner owner');
  });

  await suite.test('legacy scanHistory cannot affect current status', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: {
        signalId: 'sig_001',
        timestamp: '2026-08-27T12:55:00Z',
      },
      latestScanAt: '2026-08-27T12:54:00Z',
      // Legacy scanHistory (should NOT affect current status)
      scanHistory: [
        { timestamp: '2026-07-16T10:00:00Z', status: 'completed' },
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
      strategyStatus: null,
      session: { marketOpen: true },
      executionTarget: 'ibkr_paper',
      now,
      runtimePerformance,
    });

    const watch = model.marketWatch;
    // Should use current signal, not historical scan
    assert.strictEqual(watch.latestSignalAt, '2026-08-27T12:55:00Z');
    assert(!watch.latestSignalAt.includes('2026-07-16'));
  });

  await suite.test('market data connection is separate from signal existence', () => {
    const now = new Date('2026-08-27T12:55:00Z');
    const runtimePerformance = {
      latestSignal: null, // No signal
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
      session: { marketOpen: true }, // Market open
      executionTarget: 'ibkr_paper',
      now,
      runtimePerformance,
    });

    const watch = model.marketWatch;
    // Market data connected but no current signal is valid
    assert.strictEqual(watch.marketDataConnected, true, 'market data can be connected');
    assert.strictEqual(watch.active, false, 'but no current signal');
    assert.strictEqual(watch.health, 'inactive', 'not an error state');
  });

  await suite.test('market watch documents canonical ownership', () => {
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
      now: new Date(),
      runtimePerformance: { latestSignal: { timestamp: '2026-08-27T12:55:00Z' }, latestScanAt: '2026-08-27T12:54:00Z' },
    });

    const watch = model.marketWatch;
    assert.strictEqual(watch.canonical, true);
    assert(watch.source.includes('futuresPaperScannerService'), 'should document native runtime owner');
    assert.strictEqual(watch.legacyScannnerLastScanAt_DEPRECATED, null, 'should not expose legacy timestamp');
  });
});
