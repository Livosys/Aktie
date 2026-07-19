'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const now = '2026-07-06T11:00:00.000Z';
const signalTimestamp = '2026-07-06T12:45:00.000Z';
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-scanner-'));

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService } = require('./futuresPaperLedgerService');
const { createFuturesPaperScannerService } = require('./futuresPaperScannerService');
const { createFuturesPaperExecutionTargetReservationService } = require('./futuresPaperExecutionTargetReservationService');
const { createFuturesTradingOsSignalAdapterService } = require('./futuresTradingOsSignalAdapterService');

const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage, allowInternalSimulationForTests: true });
const ledger = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc, allowInternalSimulationForTests: true });
const executionTargetReservations = createFuturesPaperExecutionTargetReservationService({
  dir: path.join(rootDir, 'execution-target-reservations'),
});
let ledgerOpenCalls = 0;
const originalOpenFuturesPaperPosition = ledger.openFuturesPaperPosition.bind(ledger);
ledger.openFuturesPaperPosition = (input) => {
  ledgerOpenCalls += 1;
  return originalOpenFuturesPaperPosition(input);
};
let signals = [];
let providerSignals = [];
let registryEntries = new Map();

function setRegistryStrategy(strategyId, status = 'active', enabled = true) {
  registryEntries.set(strategyId, { status, enabled });
}

function resetRegistry() {
  registryEntries = new Map();
  setRegistryStrategy('trend_continuation');
}

resetRegistry();

const priceFeed = {
  tickQuotes: () => ({
    ok: true,
    generatedAt: now,
    feed: { source: 'real_market_data', simulated: false, fallback: false },
    quotes: [
      { root: 'MNQ', symbol: 'MNQ', price: 20000, previousPrice: 19999, tickSize: 0.25, source: 'real_market_data', fallback: false },
      { root: 'MES', symbol: 'MES', price: 5000, previousPrice: 5001, tickSize: 0.25, source: 'real_market_data', fallback: false },
    ],
  }),
  getQuotes: () => ({
    ok: true,
    generatedAt: now,
    feed: { source: 'real_market_data', simulated: false, fallback: false },
    quotes: [
      { root: 'MNQ', symbol: 'MNQ', price: 20000, previousPrice: 19999, tickSize: 0.25, source: 'real_market_data', fallback: false },
      { root: 'MES', symbol: 'MES', price: 5000, previousPrice: 5001, tickSize: 0.25, source: 'real_market_data', fallback: false },
    ],
  }),
  getQuote: (symbol) => ({ root: symbol, symbol, price: symbol === 'MES' ? 5000 : 20000, previousPrice: 19999, tickSize: 0.25, source: 'real_market_data', fallback: false }),
};

const signalAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [],
  approvalService: {
    evaluateSignal: () => ({
      approved: true,
      strategyId: 'trend_continuation',
      strategyName: 'Trend Continuation',
      approvalReason: 'test_approved_signal',
    }),
  },
});

let signalProviderRuns = 0;
function mnqCanonicalSignal() {
  return {
    signalId: `mnq-provider-${signalTimestamp}`,
    strategyId: 'mnq_globex_momentum_v1',
    strategyName: 'MNQ Globex Momentum',
    family: 'futures_globex_momentum',
    strategyFamily: 'futures_globex_momentum',
    signalFamily: 'futures_globex_momentum',
    signalSubtype: 'GLOBEX_MOMENTUM',
    symbol: 'MNQ',
    originalSymbol: 'MNQ',
    market: 'futures',
    marketType: 'futures',
    direction: 'long',
    confidence: 0.72,
    entry: 20000,
    entryPrice: 20000,
    referencePrice: 20000,
    stopLossPct: 0.3,
    takeProfitPct: 0.6,
    riskReward: 2,
    timeframe: '1m',
    status: 'ready',
    signalStatus: 'ready',
    source: 'futures_provider_mnq_candles',
    signalSource: 'futures_provider_mnq_candles',
    dataSource: 'real_market_data',
    dataFreshness: 'LIVE',
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    candleTimestamp: signalTimestamp,
    createdAt: signalTimestamp,
    timestamp: signalTimestamp,
    strategyLogicVersion: 'mnq_globex_momentum_v1',
  };
}

function mnqCanonicalSignalAt(ts, direction = 'long') {
  return {
    ...mnqCanonicalSignal(),
    signalId: `mnq-provider-${ts}-${direction}`,
    direction,
    candleTimestamp: ts,
    createdAt: ts,
    timestamp: ts,
  };
}

const signalProvider = {
  getCanonicalSignals: () => {
    signalProviderRuns += 1;
    const signalInputs = [...signals, ...providerSignals];
    return {
      ok: true,
      signalInputs,
      signals: signalInputs,
      providerResults: providerSignals.length ? {
        mnq_globex_momentum_v1: {
          providerId: 'mnq_globex_momentum_v1',
          ok: true,
          signals: providerSignals.length,
          signalState: 'signal',
          direction: 'long',
          dataQuality: 'real',
          latestSignalTimestamp: signalTimestamp,
        },
      } : {},
      stats: {
        signalInputsRead: signalInputs.length,
        readerSignalsRead: signals.length,
        providerSignalsRead: providerSignals.length,
        providersEvaluated: providerSignals.length ? 1 : 0,
      },
    };
  },
};

const scanner = createFuturesPaperScannerService({
  storageService: storage,
  ledgerService: ledger,
  allowInternalSimulationForTests: true,
  priceFeedService: priceFeed,
  signalProviderService: signalProvider,
  signalAdapterService: signalAdapter,
  executionTargetReservationService: executionTargetReservations,
  strategyRegistryService: {
    canExecuteStrategy: (strategyId) => {
      const entry = registryEntries.get(strategyId);
      if (!entry) {
        return {
          allowed: false,
          blockedReason: 'strategy_not_in_execution_allowlist',
          strategyId,
          status: null,
          enabled: false,
          source: 'strategy_registry_execution_allowlist',
        };
      }
      const allowed = entry.enabled !== false && entry.status === 'active';
      return {
        allowed,
        blockedReason: allowed ? null : (entry.enabled === false ? 'strategy_disabled_in_registry' : 'strategy_not_active_in_registry'),
        strategyId,
        status: entry.status,
        enabled: entry.enabled !== false,
        source: 'strategy_registry_execution_allowlist',
      };
    },
  },
  allowlistService: {
    getPaperAllowlistStatus: () => ({
      allowlist: [{
        id: 'trend_continuation',
        name: 'Trend Continuation',
        readyForPaperRuntime: true,
        blockers: [],
      }, {
        id: 'blocked_allowlist_strategy',
        name: 'Blocked Allowlist Strategy',
        readyForPaperRuntime: false,
        blockers: ['manual_hold'],
      }, {
        id: 'narrow_breakout',
        name: 'Narrow Breakout',
        readyForPaperRuntime: true,
        blockers: [],
      }],
    }),
  },
  performanceService: {
    getTopStrategies: () => ({
      strategies: [{
        strategy_id: 'trend_continuation',
        strategy_name: 'Trend Continuation',
        score: 80,
        win_rate: 60,
        avg_pnl: 0.2,
        trades: 20,
      }, {
        strategy_id: 'blocked_allowlist_strategy',
        strategy_name: 'Blocked Allowlist Strategy',
        score: 70,
        win_rate: 55,
        avg_pnl: 0.1,
        trades: 12,
      }],
    }),
  },
  config: {
    cooldownMinutes: 1,
    scanHistoryLimit: 10,
    closedTradesLimit: 100,
    autoIntervalSeconds: 60,
    candidateMaxAgeMs: 120000,
  },
});

providerSignals = [mnqCanonicalSignal()];

function resetScenario() {
  scanner.resetScanner();
  executionTargetReservations.resetForTests();
  ledger.resetState();
  ledgerOpenCalls = 0;
  signals = [];
  providerSignals = [mnqCanonicalSignal()];
  signalProviderRuns = 0;
  resetRegistry();
}

function seedClosedRealTrade(strategyId, openedAt, closedAt) {
  const opened = ledger.openFuturesPaperPosition({
    now: openedAt,
    root: 'MNQ',
    symbol: 'MNQ',
    side: 'long',
    contracts: 1,
    entryPrice: 20000,
    stopLoss: 19900,
    takeProfit: 20200,
    strategyId,
    strategyName: 'Trend Continuation',
    entryReason: 'seed real signal trade',
    tradeType: 'trading_os_signal',
    signalSource: 'scanner',
    dataSource: 'real_market_data',
    usedRealStrategyLogic: true,
    usedFallbackPrice: false,
    excludedFromStats: false,
  });
  assert.equal(opened.ok, true);
  const closed = ledger.closeFuturesPaperPosition({
    now: closedAt,
    tradeId: opened.position.tradeId,
    exitPrice: 20100,
    exitReason: 'take_profit_hit',
  });
  assert.equal(closed.ok, true);
  return closed.trade;
}

const auto = scanner.setAutoSimulation({ enabled: true, intervalMs: 10000 });
assert.equal(auto.ok, false);
assert.equal(auto.error, 'internal_futures_simulation_disabled');
assert.equal(auto.code, 'internal_futures_simulation_retired');
assert.equal(auto.autoSimulation.enabled, false);
assert.equal(auto.mode, 'ibkr_paper');
assert.equal(auto.live_trading_enabled, false);
assert.equal(auto.broker_enabled, false);
assert.equal(auto.actions_allowed, false);
assert.equal(auto.can_place_orders, false);

let scan = scanner.runScannerOnce({ now });
assert.equal(scan.ok, true);
assert.equal(scan.scan.sessionMetadata.sessionId, 'europe');
assert.equal(scan.scan.sessionId, 'europe');
assert.equal(scan.scan.signalInputsRead, 1);
assert.equal(scan.scan.readerSignalsRead, 0);
assert.equal(scan.scan.providerSignalsRead, 1);
assert.equal(scan.scan.signalsMappedToFutures, 1);
assert.equal(scan.scan.canonicalPipelineCandidates, 0);
assert.equal(scan.candidates.length, 0);
assert.equal(scanner.getCandidates().totalCandidates, 0);
assert.equal(signalProviderRuns, 1);
assert.equal(scan.scan.signalProviderResults.mnq_globex_momentum_v1.signals, 1);
assert.equal(scan.scan.signalProviderResults.mnq_globex_momentum_v1.signalState, 'signal');
assert.equal(scan.scan.skippedStrategies.some((row) => (
  row.strategyId === 'mnq_globex_momentum_v1'
  && row.reason === 'strategy_not_in_execution_allowlist'
)), true);
assert.equal(ledger.getPositionsSummary().open.length, 0);
assert.equal(ledger.getPositionsSummary().closed.length, 0);
assert.equal(ledgerOpenCalls, 0);

signals = [{
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
  strategyLogicVersion: 'test-v1',
  createdAt: signalTimestamp,
}];

scan = scanner.runScannerOnce({ now });
assert.equal(scan.ok, true);
assert.equal(scan.scan.signalInputsRead, 2);
assert.equal(scan.scan.readerSignalsRead, 1);
assert.equal(scan.scan.providerSignalsRead, 1);
assert.equal(scan.scan.signalsMappedToFutures, 2);
assert.equal(scan.scan.canonicalPipelineCandidates, 1);
assert.equal(scan.candidates.length, 1);
assert.equal(scan.candidates.some((row) => row.strategyId === 'mnq_globex_momentum_v1'), false);
assert.equal(scanner.getCandidates().candidates.some((row) => row.strategyId === 'mnq_globex_momentum_v1'), false);
assert.equal(scan.candidates[0].symbol, 'MNQ');
assert.equal(scan.candidates[0].direction, 'long');
assert.equal(scan.candidates[0].stopLoss, 19900);
assert.equal(scan.candidates[0].takeProfit, 20200);
assert.equal(scan.candidates[0].usedRealStrategyLogic, true);
assert.equal(scan.candidates[0].executionTarget, 'ibkr_paper');
assert.equal(scan.candidates[0].executionSource, 'ibkr_paper');
assert.equal(scan.candidates[0].internalSimulationRetired, true);
assert.equal(scan.candidates[0].timestamp, signalTimestamp);
assert.equal(scan.candidates[0].sessionMetadata.sessionId, 'us_premarket');
assert.equal(scan.candidates[0].sessionId, 'us_premarket');
assert.equal(scan.candidates[0].rawSignalSummary.sessionMetadata.sessionId, 'us_premarket');
assert.equal(ledgerOpenCalls, 0);

const simulated = scanner.simulateCandidate({ now });
assert.equal(simulated.ok, false);
assert.equal(simulated.error, 'internal_futures_simulation_disabled');
assert.equal(simulated.code, 'internal_futures_simulation_retired');
assert.equal(ledgerOpenCalls, 0);
assert.equal(scanner.getCandidates().totalCandidates, 1);

resetScenario();
setRegistryStrategy('mnq_globex_momentum_v1');
scan = scanner.runScannerOnce({ now });
assert.equal(scan.ok, true);
assert.equal(scan.scan.signalInputsRead, 1);
assert.equal(scan.scan.readerSignalsRead, 0);
assert.equal(scan.scan.providerSignalsRead, 1);
assert.equal(scan.scan.signalsMappedToFutures, 1);
assert.equal(scan.scan.canonicalPipelineCandidates, 1);
assert.equal(scan.candidates.length, 1);
assert.equal(scan.candidates[0].strategyId, 'mnq_globex_momentum_v1');
assert.equal(scan.candidates[0].symbol, 'MNQ');
assert.equal(scan.candidates[0].direction, 'long');
assert.equal(scan.candidates[0].entryPrice, 20000);
assert.equal(scan.candidates[0].stopLoss, 19940);
assert.equal(scan.candidates[0].takeProfit, 20120);
assert.equal(scan.candidates[0].riskReward, 2);
assert.equal(scan.candidates[0].source, 'trading_os_signal_adapter');
assert.equal(scan.candidates[0].signalSource, 'futures_provider_mnq_candles');
assert.equal(scan.candidates[0].tradeType, 'canonical_signal');
assert.equal(scan.candidates[0].usedRealStrategyLogic, true);
assert.equal(scan.candidates[0].excludedFromStats, false);
assert.equal(scan.candidates[0].executionTarget, 'ibkr_paper');
assert.equal(scan.candidates[0].executionSource, 'ibkr_paper');
assert.equal(scan.candidates[0].internalSimulationRetired, true);
assert.equal(scanner.getCandidates().totalCandidates, 1);

providerSignals = [mnqCanonicalSignalAt('2026-07-06T12:50:00.000Z', 'short')];
scan = scanner.runScannerOnce({ now: '2026-07-06T12:50:30.000Z' });
assert.equal(scan.ok, true);
assert.equal(scan.scan.staleQueuedCandidatesPruned, 1);
assert.equal(scan.scan.canonicalPipelineCandidates, 1);
assert.equal(scan.candidates.length, 1);
assert.equal(scan.candidates[0].direction, 'short');
assert.equal(scan.candidates[0].signalTimestamp, '2026-07-06T12:50:00.000Z');
assert.equal(scanner.getCandidates().totalCandidates, 1);
assert.equal(scanner.getCandidates().candidates[0].candidateId, scan.candidates[0].candidateId);

const closedReal = seedClosedRealTrade(
  'trend_continuation',
  '2026-07-06T11:00:00.000Z',
  '2026-07-06T11:05:00.000Z',
);
assert.equal(closedReal.entrySession.sessionId, 'europe');
assert.equal(closedReal.exitSession.sessionId, 'europe');

const engine = ledger.openFuturesPaperPosition({
  now: '2026-07-06T11:06:00.000Z',
  root: 'MNQ',
  symbol: 'MNQ',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
  stopLoss: 19900,
  takeProfit: 20200,
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  entryReason: 'Engine test seed',
  tradeType: 'engine_test',
  signalSource: 'fallback_test',
  dataSource: 'simulated_fallback',
  usedRealStrategyLogic: false,
  usedFallbackPrice: true,
  excludedFromStats: true,
});
assert.equal(engine.ok, true);

const closedEngine = ledger.closeFuturesPaperPosition({
  now: '2026-07-06T11:07:00.000Z',
  tradeId: engine.position.tradeId,
  exitPrice: 19900,
  exitReason: 'stop_loss_hit',
});
assert.equal(closedEngine.ok, true);

const recent = ledger.getRecentClosedTrades({ limit: 10 });
assert.equal(recent.trades.length, 2);
assert.equal(recent.trades[0].tradeType, 'engine_test');
assert.equal(recent.trades[0].excludedFromStats, true);
assert.equal(recent.trades[1].tradeType, 'trading_os_signal');
assert.equal(recent.trades[1].usedRealStrategyLogic, true);

const status = scanner.getStrategyStatus({ now: '2026-07-06T11:08:00.000Z' });
const row = status.strategies.find((item) => item.strategyId === 'trend_continuation');
assert.equal(row.totalTradesAll, 2);
assert.equal(row.totalTradesRealSignals, 1);
assert.equal(row.testTrades, 1);
assert.equal(row.excludedTrades, 1);
assert.equal(row.winRateAll, 50);
assert.equal(row.winRateRealSignals, 100);
assert.equal(row.pnlRealSignals > 0, true);
assert.equal(row.pnlAll < row.pnlRealSignals, true);

resetScenario();
setRegistryStrategy('trend_continuation', 'paused', false);
signals = [{
  signalId: 'sig-qqq-paused',
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  symbol: 'QQQ',
  market: 'stocks',
  direction: 'long',
  confidence: 0.81,
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  timeframe: '2m',
  source: 'scanner',
  signalSource: 'scanner',
  dataSource: 'real_market_data',
  approved: true,
  strategyLogicVersion: 'test-v1',
  createdAt: '2026-07-06T11:06:00.000Z',
}];
const registryDeniedScan = scanner.runScannerOnce({ now: '2026-07-06T11:06:00.000Z' });
assert.equal(registryDeniedScan.ok, true);
assert.equal(registryDeniedScan.candidates.length, 0);
assert.equal(registryDeniedScan.scan.skippedStrategies.some((row) => row.reason === 'strategy_disabled_in_registry'), true);

resetScenario();
for (let i = 0; i < 9; i += 1) {
  const minute = String(i).padStart(2, '0');
  seedClosedRealTrade(
    'trend_continuation',
    `2026-07-05T09:${minute}:00.000Z`,
    `2026-07-05T09:${minute}:30.000Z`,
  );
}
signals = [{
  signalId: 'sig-qqq-nine',
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
  strategyLogicVersion: 'test-v1',
  createdAt: '2026-07-06T11:09:00.000Z',
}];
let nineScan = scanner.runScannerOnce({ now: '2026-07-06T11:09:00.000Z' });
assert.equal(nineScan.ok, true);
assert.equal(nineScan.candidates.length, 1);
assert.equal(nineScan.scan.blockedByCooldown.length, 0);
assert.equal(nineScan.scan.blockedByFamilyGate.length, 0);
let nineRow = scanner.getStrategyStatus({ now: '2026-07-06T11:09:00.000Z' }).strategies
  .find((item) => item.strategyId === 'trend_continuation');
assert.equal(nineRow.totalTradesAll, 9);
assert.equal(nineRow.canTradeNow, true);
assert.equal(nineRow.blockReason, null);

resetScenario();
for (let i = 0; i < 11; i += 1) {
  const minute = String(i).padStart(2, '0');
  seedClosedRealTrade(
    'trend_continuation',
    `2026-07-05T10:${minute}:00.000Z`,
    `2026-07-05T10:${minute}:30.000Z`,
  );
}
signals = [{
  signalId: 'sig-qqq-eleven',
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  symbol: 'QQQ',
  market: 'stocks',
  direction: 'long',
  confidence: 0.84,
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  timeframe: '2m',
  source: 'scanner',
  signalSource: 'scanner',
  dataSource: 'real_market_data',
  approved: true,
  strategyLogicVersion: 'test-v1',
  createdAt: '2026-07-06T11:20:00.000Z',
}];
let elevenScan = scanner.runScannerOnce({ now: '2026-07-06T11:20:00.000Z' });
assert.equal(elevenScan.ok, true);
assert.equal(elevenScan.candidates.length, 1);
assert.equal(elevenScan.scan.blockedByCooldown.length, 0);
assert.equal(elevenScan.scan.blockedByFamilyGate.length, 0);
let elevenRow = scanner.getStrategyStatus({ now: '2026-07-06T11:20:00.000Z' }).strategies
  .find((item) => item.strategyId === 'trend_continuation');
assert.equal(elevenRow.totalTradesAll, 11);
assert.equal(elevenRow.canTradeNow, true);
assert.equal(elevenRow.blockReason, null);
const elevenSimulated = scanner.simulateCandidate({ candidateId: elevenScan.candidates[0].candidateId, now: '2026-07-06T11:20:00.000Z' });
assert.equal(elevenSimulated.ok, false);
assert.equal(elevenSimulated.error, 'internal_futures_simulation_disabled');

resetScenario();
const hundredBase = new Date('2026-07-04T09:00:00.000Z').getTime();
for (let i = 0; i < 100; i += 1) {
  const openedAt = new Date(hundredBase + i * 60_000).toISOString();
  const closedAt = new Date(hundredBase + i * 60_000 + 30_000).toISOString();
  seedClosedRealTrade(
    'trend_continuation',
    openedAt,
    closedAt,
  );
}
signals = [{
  signalId: 'sig-qqq-hundred',
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  symbol: 'QQQ',
  market: 'stocks',
  direction: 'long',
  confidence: 0.9,
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  timeframe: '2m',
  source: 'scanner',
  signalSource: 'scanner',
  dataSource: 'real_market_data',
  approved: true,
  strategyLogicVersion: 'test-v1',
  createdAt: '2026-07-06T11:30:00.000Z',
}];
const hundredScan = scanner.runScannerOnce({ now: '2026-07-06T11:30:00.000Z' });
assert.equal(hundredScan.ok, true);
assert.equal(hundredScan.candidates.length, 1);
assert.equal(hundredScan.scan.skippedStrategies.some((row) => row.reason === 'strategy_disabled_in_registry'), false);
assert.equal(scanner.getStrategyStatus({ now: '2026-07-06T11:30:00.000Z' }).strategies.find((item) => item.strategyId === 'trend_continuation').totalTradesAll, 100);

const legacyTrade = ledger.openFuturesPaperPosition({
  now: '2026-07-05T08:00:00.000Z',
  root: 'MNQ',
  symbol: 'MNQ',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
  stopLoss: 19900,
  takeProfit: 20200,
  strategyId: 'legacy_strategy_not_allowlisted',
  strategyName: 'Legacy Strategy',
  entryReason: 'seed legacy',
  tradeType: 'trading_os_signal',
  signalSource: 'scanner',
  dataSource: 'real_market_data',
  usedRealStrategyLogic: true,
  usedFallbackPrice: false,
  excludedFromStats: false,
});
assert.equal(legacyTrade.ok, true);
const legacyClosed = ledger.closeFuturesPaperPosition({
  now: '2026-07-05T08:30:00.000Z',
  tradeId: legacyTrade.position.tradeId,
  exitPrice: 20100,
  exitReason: 'take_profit_hit',
});
assert.equal(legacyClosed.ok, true);
const legacyStatus = scanner.getStrategyStatus({ now: '2026-07-06T11:30:00.000Z' }).strategies
  .find((item) => item.strategyId === 'legacy_strategy_not_allowlisted');
assert.equal(legacyStatus.blockReason, 'not_in_paper_allowlist');

signals = [{
  signalId: 'sig-no-perf',
  strategyId: 'narrow_breakout',
  strategyName: 'Narrow Breakout',
  symbol: 'QQQ',
  market: 'stocks',
  direction: 'long',
  confidence: 0.77,
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  timeframe: '2m',
  source: 'scanner',
  signalSource: 'scanner',
  dataSource: 'real_market_data',
  approved: true,
  strategyLogicVersion: 'test-v1',
  createdAt: '2026-07-06T11:31:00.000Z',
}];
setRegistryStrategy('narrow_breakout');
const noPerfScan = scanner.runScannerOnce({ now: '2026-07-06T11:31:00.000Z' });
assert.equal(noPerfScan.ok, true);
const noPerfStatus = scanner.getStrategyStatus({ now: '2026-07-06T11:31:00.000Z' }).strategies
  .find((item) => item.strategyId === 'narrow_breakout');
assert.equal(noPerfStatus.blockReason, 'no_strategy_performance_data');

assert.equal(scanner.assertPaperOnly({ live_trading_enabled: true }), 'live_trading_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ broker_enabled: true }), 'broker_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ actions_allowed: true }), 'real_actions_are_not_allowed');
assert.equal(scanner.assertPaperOnly({ can_place_orders: true }), 'real_orders_are_not_allowed');
assert.equal(scanner.assertPaperOnly({ mode: 'live' }), 'mode_must_be_paper_only');

console.log('futuresPaperScannerService.test.js passed');
