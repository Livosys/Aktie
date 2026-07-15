'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const now = '2026-07-06T11:00:00.000Z';
const signalTimestamp = '2026-07-06T12:45:00.000Z';
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-scanner-'));
process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE = path.join(rootDir, 'futures-strategy-approvals.json');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService } = require('./futuresPaperLedgerService');
const { createFuturesPaperScannerService } = require('./futuresPaperScannerService');
const { createFuturesPaperExecutionTargetReservationService } = require('./futuresPaperExecutionTargetReservationService');
const approvalService = require('./futuresPaperStrategyApprovalService');
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
  signalReader: () => signals,
  approvalService: {
    evaluateSignal: () => ({
      approved: true,
      strategyId: 'trend_continuation',
      strategyName: 'Trend Continuation',
      approvalReason: 'test_approved_signal',
    }),
  },
});

let nativeProducerRuns = 0;
const nativeFuturesDiagnosticsProducer = {
  evaluate: ({ now: diagnosticNow }) => {
    nativeProducerRuns += 1;
    return {
      ok: true,
      strategyId: 'mnq_globex_momentum_v1',
      family: 'futures_globex_momentum',
      instrument: 'MNQ',
      producerType: 'futures_native',
      signalState: 'diagnostic_signal',
      direction: 'long',
      dryRun: true,
      diagnosticOnly: true,
      executionEnabled: false,
      wouldCreateCandidate: true,
      wouldOpenPosition: false,
      entryEligible: false,
      eligibleForPaperEntry: false,
      dataQuality: 'simulated',
      sessionId: 'europe',
      sessionLabel: 'Europe',
      sessionMetadata: {
        session: 'Globex',
        sessionId: 'europe',
        sessionLabel: 'Europe',
        exchangeTimezone: 'America/Chicago',
        isRth: false,
        isMarketOpen: true,
      },
      producerEvidence: {
        source: 'futures_native_mnq_candles',
        latestCandleTimestamp: signalTimestamp,
        closedCandlesUsed: 5,
      },
      diagnosticCandidatePreview: {
        strategyId: 'mnq_globex_momentum_v1',
        instrument: 'MNQ',
        direction: 'long',
        dryRun: true,
        diagnosticOnly: true,
        wouldOpenPosition: false,
        entryEligible: false,
      },
      timestamp: new Date(diagnosticNow).toISOString(),
      mode: 'paper_only',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
    };
  },
};

const scanner = createFuturesPaperScannerService({
  storageService: storage,
  ledgerService: ledger,
  allowInternalSimulationForTests: true,
  priceFeedService: priceFeed,
  signalAdapterService: signalAdapter,
  nativeFuturesDiagnosticsProducer,
  executionTargetReservationService: executionTargetReservations,
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
    engineTestMode: false,
  },
});

function resetScenario() {
  scanner.resetScanner();
  executionTargetReservations.resetForTests();
  ledger.resetState();
  ledgerOpenCalls = 0;
  signals = [];
  approvalService.__resetLastKnownGood();
  if (fs.existsSync(process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE)) {
    fs.unlinkSync(process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE);
  }
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

const approvalFile = process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE;
assert.equal(fs.existsSync(approvalFile), false);

let scan = scanner.runScannerOnce({ now });
assert.equal(scan.ok, true);
assert.equal(scan.scan.sessionMetadata.sessionId, 'europe');
assert.equal(scan.scan.sessionId, 'europe');
assert.equal(scan.scan.tradingOsSignalsRead, 0);
assert.equal(scan.scan.realSignalCandidates, 0);
assert.equal(scan.scan.engineTestCandidates, 0);
assert.equal(scan.candidates.length, 0);
assert.equal(scanner.getCandidates().totalCandidates, 0);
assert.equal(nativeProducerRuns, 1);
assert.equal(scan.scan.nativeFuturesDiagnostics.mnq_globex_momentum_v1.runs, 1);
assert.equal(scan.scan.nativeFuturesDiagnostics.mnq_globex_momentum_v1.signals, 1);
assert.equal(scan.scan.nativeFuturesDiagnostics.mnq_globex_momentum_v1.candidatesCreated, 0);
assert.equal(scan.scan.nativeFuturesDiagnostics.mnq_globex_momentum_v1.positionsOpened, 0);
assert.equal(scan.scan.nativeFuturesDiagnostics.mnq_globex_momentum_v1.result.wouldOpenPosition, false);
assert.equal(scan.scan.nativeFuturesDiagnostics.mnq_globex_momentum_v1.result.executionEnabled, false);
assert.equal(scan.scan.diagnosticProducerResults.mnq_globex_momentum_v1.signals, 1);
assert.equal(scan.scan.producerPreviews.mnq_globex_momentum_v1.strategyId, 'mnq_globex_momentum_v1');
assert.equal(scan.scan.producerPreviews.mnq_globex_momentum_v1.wouldOpenPosition, false);
assert.equal(scan.scan.producerPreviews.mnq_globex_momentum_v1.entryEligible, false);
const diagnosticHistory = scanner.readNativeFuturesDiagnosticsHistory();
assert.equal(diagnosticHistory.length, 1);
assert.equal(diagnosticHistory[0].strategyId, 'mnq_globex_momentum_v1');
assert.equal(diagnosticHistory[0].positionsOpened, 0);
assert.equal(diagnosticHistory[0].candidatesCreated, 0);
assert.equal(diagnosticHistory[0].wouldOpenPosition, false);
assert.equal(ledger.getPositionsSummary().open.length, 0);
assert.equal(ledger.getPositionsSummary().closed.length, 0);
assert.equal(ledgerOpenCalls, 0);
assert.equal(fs.existsSync(approvalFile), false);

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
assert.equal(scan.scan.tradingOsSignalsRead, 1);
assert.equal(scan.scan.signalsMappedToFutures, 1);
assert.equal(scan.scan.realSignalCandidates, 1);
assert.equal(scan.scan.engineTestCandidates, 0);
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
approvalService.ensureMigrated();
approvalService.approve('trend_continuation');
approvalService.pause('trend_continuation');
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
const approvalDeniedScan = scanner.runScannerOnce({ now: '2026-07-06T11:06:00.000Z' });
assert.equal(approvalDeniedScan.ok, true);
assert.equal(approvalDeniedScan.candidates.length, 0);
assert.equal(approvalDeniedScan.scan.skippedStrategies.some((row) => row.reason === 'futures_strategy_paused'), true);

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
approvalService.ensureMigrated();
approvalService.approve('trend_continuation');
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
approvalService.ensureMigrated();
approvalService.approve('trend_continuation');
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
assert.equal(hundredScan.scan.skippedStrategies.some((row) => row.reason === 'futures_strategy_paused'), false);
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
approvalService.approve('narrow_breakout');
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
