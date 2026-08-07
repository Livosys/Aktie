'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const now = '2026-07-06T11:00:00.000Z';
const signalTimestamp = '2026-07-06T12:45:00.000Z';
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-scanner-'));

function lifecycleIdFromSignalId(signalId) {
  return `signal_lifecycle_${crypto.createHash('sha1').update(String(signalId)).digest('hex').slice(0, 24)}`;
}

function withSignalLifecycle(signal = {}) {
  if (!signal || typeof signal !== 'object') return signal;
  if (signal.lifecycleId) return signal;
  const signalId = signal.signalId || signal.signal_id || signal.id || null;
  return signalId ? { ...signal, lifecycleId: lifecycleIdFromSignalId(signalId) } : signal;
}

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

// Entry contracts injiceras explicit. Utan stub läser scannern den riktiga
// tjänsten, som i sin tur läser PAPER_ENTRY_CONTRACTS_ENABLED ur process.env —
// och @stoqey/ib drar in dotenv vid import, så testet skulle tyst ärva prod-.env
// och bli miljöberoende. Stubben håller testet hermetiskt.
let entryContractIds = new Set();

function resetEntryContracts() {
  entryContractIds = new Set(['trend_continuation', 'mnq_globex_momentum_v1']);
}

resetEntryContracts();

const entryContractService = {
  entryContractsEnabled: () => true,
  getEntryContract: (strategyId) => (entryContractIds.has(strategyId)
    ? { strategyId, version: 'paper_entry_contract_test' }
    : null),
};

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
    const signalInputs = [...signals, ...providerSignals].map(withSignalLifecycle);
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
  entryContractService,
  strategyRegistryService: {
    getStatus: () => ({
      strategies: [...registryEntries.entries()].map(([strategyId, entry]) => ({
        strategy_id: strategyId,
        strategy_name: strategyId,
        status: entry.status,
        enabled: entry.enabled,
      })),
    }),
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
  resetEntryContracts();
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
assert.equal(scan.candidates[0].signalId, 'sig-qqq-long-1');
assert.equal(scan.candidates[0].lifecycleId, lifecycleIdFromSignalId('sig-qqq-long-1'));
assert.notEqual(scan.candidates[0].lifecycleId, scan.candidates[0].candidateId);
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
assert.equal(scan.candidates[0].lifecycleId, lifecycleIdFromSignalId(`mnq-provider-${signalTimestamp}`));
assert.notEqual(scan.candidates[0].lifecycleId, scan.candidates[0].candidateId);
assert.equal(scanner.getCandidates().totalCandidates, 1);
const registryStatusRow = scanner.getStrategyStatus({ now }).strategies.find((item) => item.strategyId === 'mnq_globex_momentum_v1');
assert.equal(registryStatusRow.approved, true);
assert.equal(registryStatusRow.source, 'strategy_registry_execution_allowlist');

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

// Entry contract-grinden i antagningen: kön har en plats per rot och orchestratorn
// läser alltid köns första kandidat. En strategi utan entry contract kan aldrig
// passera orchestratorns kontraktsgrind, så den får inte ta platsen från en
// kontrakterad strategi.
const contractGateSignal = {
  signalId: 'sig-no-contract-1',
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
};

resetScenario();
providerSignals = [];
signals = [contractGateSignal];
entryContractIds.delete('trend_continuation');
const noContractScan = scanner.runScannerOnce({ now });
assert.equal(noContractScan.ok, true);
assert.equal(noContractScan.candidates.length, 0);
assert.equal(scanner.getCandidates().totalCandidates, 0);
assert.equal(
  noContractScan.scan.skippedStrategies.some((row) => row.strategyId === 'trend_continuation'
    && row.reason === 'entry_contract_missing'),
  true,
);

// Samma signal med kontrakt på plats ska däremot köas — grinden får inte blockera brett.
resetScenario();
providerSignals = [];
signals = [contractGateSignal];
const withContractScan = scanner.runScannerOnce({ now });
assert.equal(withContractScan.ok, true);
assert.equal(withContractScan.candidates.length, 1);
assert.equal(withContractScan.candidates[0].strategyId, 'trend_continuation');

resetScenario();

assert.equal(scanner.assertPaperOnly({ live_trading_enabled: true }), 'live_trading_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ broker_enabled: true }), 'broker_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ actions_allowed: true }), 'real_actions_are_not_allowed');
assert.equal(scanner.assertPaperOnly({ can_place_orders: true }), 'real_orders_are_not_allowed');
assert.equal(scanner.assertPaperOnly({ mode: 'live' }), 'mode_must_be_paper_only');

// ── (6) Färskhetsgrinden end-to-end för en 2m-kandidat ──────────────────────
// Åldern ska mätas från candle-STÄNGNING. Med öppningssemantik är en 2m-candle
// redan exakt candidateMaxAgeMs (120000) gammal i den sekund den stänger, och
// varje kandidat prunas därför oavsett hur snabb pipelinen är.
// Tidsintervallen nedan är de i produktion observerade (48 s efter stängning).
const FRESH_OPEN = '2026-07-06T12:44:00.000Z';
const FRESH_CLOSE = '2026-07-06T12:46:00.000Z';
const FRESH_SCAN_1 = '2026-07-06T12:46:48.000Z';   // stängning + 48 s
const FRESH_SCAN_2 = '2026-07-06T12:47:48.000Z';   // stängning + 108 s

// Kontrollräkning som dokumenterar varför testet finns:
assert.equal(Date.parse(FRESH_CLOSE) - Date.parse(FRESH_OPEN), 120000);
assert.ok(Date.parse(FRESH_SCAN_2) - Date.parse(FRESH_OPEN) > 120000, 'öppningssemantik skulle prunas');
assert.ok(Date.parse(FRESH_SCAN_2) - Date.parse(FRESH_CLOSE) <= 120000, 'stängningssemantik ska överleva');

const freshSignal = {
  signalId: 'sig-2m-freshness-e2e',
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  signalSubtype: 'EMA_PULLBACK_UP',
  symbol: 'QQQ',
  market: 'stocks',
  direction: 'long',
  confidence: 0.78,
  entry: 500,
  stopLoss: 497.5,
  takeProfit: 505,
  riskReward: 2,
  timeframe: '2m',
  source: 'scanner',
  signalSource: 'scanner',
  dataSource: 'real_market_data',
  strategyLogicVersion: 'test-v1',
  closedCandleConfirmed: true,
  latestCandleClosed: true,
  timestamp: FRESH_OPEN,
  candleTimestamp: FRESH_OPEN,
  candleClosedAt: FRESH_CLOSE,
  signalTimestamp: FRESH_CLOSE,
};

resetScenario();
providerSignals = [];
signals = [freshSignal];

const freshScan1 = scanner.runScannerOnce({ now: FRESH_SCAN_1 });
assert.equal(freshScan1.ok, true);
assert.equal(freshScan1.candidates.length, 1);
assert.equal(freshScan1.candidates[0].strategyId, 'trend_continuation');
assert.equal(freshScan1.candidates[0].signalTimestamp, FRESH_CLOSE);
assert.equal(freshScan1.candidates[0].candleTimestamp, FRESH_OPEN);

// Nästa scan kör pruneStaleQueuedCandidates mot kön. Kandidaten ska överleva.
const freshScan2 = scanner.runScannerOnce({ now: FRESH_SCAN_2 });
assert.equal(freshScan2.ok, true);
assert.equal(freshScan2.scan.staleQueuedCandidatesPruned, 0);
assert.equal(scanner.getCandidates().totalCandidates, 1);
assert.equal(scanner.getCandidates().candidates[0].signalTimestamp, FRESH_CLOSE);

// Och motprovet: samma signal utan bekräftad stängning behåller öppningen och
// prunas precis som före ändringen.
resetScenario();
providerSignals = [];
signals = [{
  ...freshSignal,
  signalId: 'sig-2m-freshness-unconfirmed',
  closedCandleConfirmed: false,
  latestCandleClosed: false,
  candleClosedAt: null,
  signalTimestamp: FRESH_OPEN,
}];
const staleScan1 = scanner.runScannerOnce({ now: FRESH_SCAN_1 });
assert.equal(staleScan1.candidates.length, 1);
assert.equal(staleScan1.candidates[0].signalTimestamp, FRESH_OPEN);
const staleScan2 = scanner.runScannerOnce({ now: FRESH_SCAN_2 });
assert.equal(staleScan2.scan.staleQueuedCandidatesPruned, 1);
const stalePruneEvent = storage.readJsonl(storage.files.events)
  .filter((row) => row.type === 'FUTURES_SCANNER_STALE_CANDIDATES_PRUNED')
  .at(-1);
assert.equal(stalePruneEvent.candidates[0].lifecycleId, lifecycleIdFromSignalId('sig-2m-freshness-unconfirmed'));
assert.notEqual(stalePruneEvent.candidates[0].lifecycleId, stalePruneEvent.candidates[0].candidateId);
assert.equal(stalePruneEvent.candidates[0].signalId, 'sig-2m-freshness-unconfirmed');

resetScenario();

// Skip-räknarna för riktning ska synas i scan-posten, alltså i det som
// persisteras till scan-history och skickas vidare av /futures-paper/runtime
// och /futures-paper/scan-history. Reader-signaler (decisionMonitor) bär
// nextMoveBias men aldrig direction/side, så det är biaset som avgör utfallet.
function readerShapedSignal(signalToken, nextMoveBias) {
  return {
    signalId: `sig-reader-${signalToken}-${nextMoveBias}`,
    strategyId: 'trend_continuation',
    strategyName: 'Trend Continuation',
    symbol: 'QQQ',
    market: 'stocks',
    signal: signalToken,
    nextMoveBias,
    confidence: 0.7,
    entry: 500,
    stopLoss: 497.5,
    takeProfit: 505,
    riskReward: 2,
    timeframe: '2m',
    dataSource: 'real_market_data',
    createdAt: signalTimestamp,
    timestamp: signalTimestamp,
  };
}

resetScenario();
providerSignals = [];
signals = [
  readerShapedSignal('LONG_TRIGGERED', 'UNCERTAIN'),  // riktning fanns -> veto
  readerShapedSignal('SHORT_WATCH', 'UNCERTAIN'),     // riktning fanns -> veto
  readerShapedSignal('WAIT', 'UNCERTAIN'),            // ingen riktning alls
];
const directionScan = scanner.runScannerOnce({ now: '2026-07-06T11:40:00.000Z' }).scan;

assert.equal(directionScan.signalsSkippedDirectionVetoed, 2);
assert.equal(directionScan.signalsSkippedNoDirection, 1);
assert.equal(directionScan.signalsSkippedOther, 3);

// De befintliga räknarna behåller sin betydelse och sina värden.
assert.equal(directionScan.signalsSkippedNoMapping, 0);
assert.equal(directionScan.signalsSkippedNoRisk, 0);
assert.equal(directionScan.signalsMappedToFutures, 0);
assert.equal(directionScan.candidatesCreated, 0);

assert.equal(directionScan.signalsSkippedNoEntryPrice, 0);

// De tre nya är en FULLSTÄNDIG uppdelning av signalsSkippedOther, inte ett
// tillägg till den. adaptSignal kan bara skippa på fyra orsaker, och två har
// egna hinkar, så summan ska gå jämnt ut — alltid, inte bara här.
function assertOtherBucketCloses(scan) {
  assert.equal(
    scan.signalsSkippedNoDirection
      + scan.signalsSkippedDirectionVetoed
      + scan.signalsSkippedNoEntryPrice,
    scan.signalsSkippedOther,
  );
}
assertOtherBucketCloses(directionScan);

// Räknarna finns även när ingen signal faller på riktning — annars kan en
// dashboard inte skilja "noll" från "fältet saknas".
resetScenario();
const baselineScan = scanner.runScannerOnce({ now: '2026-07-06T11:41:00.000Z' }).scan;
assert.equal(baselineScan.signalsSkippedDirectionVetoed, 0);
assert.equal(baselineScan.signalsSkippedNoDirection, 0);
assert.equal(baselineScan.signalsSkippedNoEntryPrice, 0);
assertOtherBucketCloses(baselineScan);

// Och de överlever vägen ut till scan-history, som är det API:erna läser.
const historyEntry = scanner.getScanHistory().scans[0];
assert.ok(Object.prototype.hasOwnProperty.call(historyEntry, 'signalsSkippedDirectionVetoed'));
assert.ok(Object.prototype.hasOwnProperty.call(historyEntry, 'signalsSkippedNoDirection'));
assert.ok(Object.prototype.hasOwnProperty.call(historyEntry, 'signalsSkippedNoEntryPrice'));

// no_futures_entry_price kräver att MNQ-quoten saknas. Egen scanner med egen
// storage så att den delade stubben och det delade tillståndet lämnas orörda.
const noQuoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-noquote-'));
const noQuoteStorage = createFuturesPaperStorageService({ rootDir: noQuoteRoot });
const noQuoteAccount = createFuturesPaperAccountService({
  storageService: noQuoteStorage,
  allowInternalSimulationForTests: true,
});
const noQuoteLedger = createFuturesPaperLedgerService({
  storageService: noQuoteStorage,
  accountService: noQuoteAccount,
  allowInternalSimulationForTests: true,
});
const noQuoteInputs = [
  readerShapedSignal('LONG_TRIGGERED', 'UP'),      // riktning ok -> faller på pris
  readerShapedSignal('WAIT', 'UNCERTAIN'),         // ingen riktning
  readerShapedSignal('SHORT_TRIGGERED', 'UNCERTAIN'), // veto
];
const noQuoteScanner = createFuturesPaperScannerService({
  storageService: noQuoteStorage,
  ledgerService: noQuoteLedger,
  allowInternalSimulationForTests: true,
  priceFeedService: {
    tickQuotes: () => ({
      ok: true,
      feed: { source: 'real_market_data', simulated: false, fallback: false },
      quotes: [],
    }),
  },
  signalProviderService: {
    getCanonicalSignals: () => ({
      ok: true,
      signalInputs: noQuoteInputs,
      signals: noQuoteInputs,
      providerResults: {},
      stats: {
        signalInputsRead: noQuoteInputs.length,
        readerSignalsRead: noQuoteInputs.length,
        providerSignalsRead: 0,
        providersEvaluated: 0,
      },
    }),
  },
  entryContractService,
  strategyRegistryService: { canExecuteStrategy: () => ({ allowed: true }) },
});
const noQuoteScan = noQuoteScanner.runScannerOnce({ now: '2026-07-06T11:42:00.000Z' }).scan;
assert.equal(noQuoteScan.signalsSkippedNoEntryPrice, 1);
assert.equal(noQuoteScan.signalsSkippedNoDirection, 1);
assert.equal(noQuoteScan.signalsSkippedDirectionVetoed, 1);
assert.equal(noQuoteScan.signalsSkippedOther, 3);
assertOtherBucketCloses(noQuoteScan);

const fairnessBase = new Date('2026-07-06T11:50:00.000Z');
const fairnessCandidates = [
  { lifecycleId: 'life-mnq', candidateId: 'cand-mnq', signalId: 'sig-mnq', strategyId: 'mnq_globex_momentum_v1', symbol: 'MNQ', futuresSymbol: 'MNQ', signalTimestamp: '2026-07-06T11:50:00.000Z', timestamp: '2026-07-06T11:50:00.000Z', createdAt: '2026-07-06T11:50:00.000Z', status: 'READY_WAITING_FOR_SIGNAL' },
  { candidateId: 'cand-ema', strategyId: 'ema_pullback_continuation', symbol: 'MNQ', futuresSymbol: 'MNQ', signalTimestamp: '2026-07-06T11:51:00.000Z', timestamp: '2026-07-06T11:51:00.000Z', createdAt: '2026-07-06T11:51:00.000Z', status: 'READY_WAITING_FOR_SIGNAL' },
  { candidateId: 'cand-vwap', strategyId: 'vwap_volume_breakout_long', symbol: 'MNQ', futuresSymbol: 'MNQ', signalTimestamp: '2026-07-06T11:52:00.000Z', timestamp: '2026-07-06T11:52:00.000Z', createdAt: '2026-07-06T11:52:00.000Z', status: 'READY_WAITING_FOR_SIGNAL' },
  { candidateId: 'cand-narrow', strategyId: 'narrow_state_expansion_long', symbol: 'MNQ', futuresSymbol: 'MNQ', signalTimestamp: '2026-07-06T11:53:00.000Z', timestamp: '2026-07-06T11:53:00.000Z', createdAt: '2026-07-06T11:53:00.000Z', status: 'READY_WAITING_FOR_SIGNAL' },
];
fs.writeFileSync(
  path.join(rootDir, 'candidates.json'),
  `${JSON.stringify({ candidates: fairnessCandidates, updatedAt: fairnessBase.toISOString() }, null, 2)}\n`,
  'utf8',
);
scanner.resetScanner();
fs.writeFileSync(path.join(rootDir, 'candidate-archive.jsonl'), '', 'utf8');
fs.writeFileSync(
  path.join(rootDir, 'candidates.json'),
  `${JSON.stringify({ candidates: fairnessCandidates, updatedAt: fairnessBase.toISOString() }, null, 2)}\n`,
  'utf8',
);
const claimedOrder = [];
for (let i = 0; i < fairnessCandidates.length; i += 1) {
  const claim = scanner.claimCandidateForIbkrPaper({
    now: new Date(fairnessBase.getTime() + i * 1000),
    claimedBy: 'scanner_fairness_test',
  });
  assert.equal(claim.claimed, true, `claim ${i} should succeed`);
  assert.equal(claim.candidate.claimedBy, 'scanner_fairness_test');
  assert.equal(claim.candidate.consumedAt != null, true);
  claimedOrder.push(claim.candidate.strategyId);
  const completed = scanner.completeClaimedCandidate({
    candidate: claim.candidate,
    now: new Date(fairnessBase.getTime() + i * 1000 + 1),
    completedBy: 'scanner_fairness_test',
    details: i === 0 ? {
      intentId: 'intent-mnq',
      executionId: 'exec-mnq',
      idempotencyKey: 'idem-mnq',
    } : {},
  });
  assert.equal(completed.completed, true, `complete ${i} should succeed`);
  assert.equal(completed.candidate.completedAt != null, true);
}
assert.deepEqual(claimedOrder, [
  'mnq_globex_momentum_v1',
  'ema_pullback_continuation',
  'vwap_volume_breakout_long',
  'narrow_state_expansion_long',
]);
assert.equal(scanner.getCandidates().totalCandidates, 0);
assert.equal(
  fs.readFileSync(path.join(rootDir, 'candidate-archive.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length,
  4,
);
const queueEvents = storage.readJsonl(storage.files.events);
const claimedMnq = queueEvents.find((row) => row.type === 'FUTURES_QUEUE_CANDIDATE_CLAIMED' && row.candidateId === 'cand-mnq');
const completedMnq = queueEvents.find((row) => row.type === 'FUTURES_QUEUE_CANDIDATE_COMPLETED' && row.candidateId === 'cand-mnq');
assert.equal(claimedMnq.lifecycleId, 'life-mnq');
assert.equal(claimedMnq.signalId, 'sig-mnq');
assert.equal(completedMnq.lifecycleId, 'life-mnq');
assert.equal(completedMnq.signalId, 'sig-mnq');
assert.equal(completedMnq.intentId, 'intent-mnq');
assert.equal(completedMnq.executionId, 'exec-mnq');
assert.equal(completedMnq.idempotencyKey, 'idem-mnq');

resetScenario();

console.log('futuresPaperScannerService.test.js passed');
