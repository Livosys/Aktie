'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService } = require('./futuresPaperLedgerService');
const { createFuturesPaperScannerService } = require('./futuresPaperScannerService');
const { createFuturesTradingOsSignalAdapterService } = require('./futuresTradingOsSignalAdapterService');

const now = '2026-07-06T11:00:00.000Z';
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-scanner-'));
const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage });
const ledger = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc });
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

const scanner = createFuturesPaperScannerService({
  storageService: storage,
  ledgerService: ledger,
  priceFeedService: priceFeed,
  signalAdapterService: signalAdapter,
  allowlistService: {
    getPaperAllowlistStatus: () => ({
      allowlist: [{
        id: 'trend_continuation',
        name: 'Trend Continuation',
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
      }],
    }),
  },
  config: {
    maxTradesPerStrategy: 10,
    cooldownMinutes: 1,
    scanHistoryLimit: 10,
    closedTradesLimit: 100,
    autoIntervalSeconds: 60,
    engineTestMode: false,
  },
});

const auto = scanner.setAutoSimulation({ enabled: true, intervalMs: 10000 });
assert.equal(auto.ok, true);
assert.equal(auto.autoSimulation.enabled, true);
assert.equal(auto.mode, 'paper_only');
assert.equal(auto.live_trading_enabled, false);
assert.equal(auto.broker_enabled, false);
assert.equal(auto.actions_allowed, false);
assert.equal(auto.can_place_orders, false);

let scan = scanner.runScannerOnce({ now });
assert.equal(scan.ok, true);
assert.equal(scan.scan.tradingOsSignalsRead, 0);
assert.equal(scan.scan.realSignalCandidates, 0);
assert.equal(scan.scan.engineTestCandidates, 0);
assert.equal(scan.candidates.length, 0);
assert.equal(scanner.getCandidates().totalCandidates, 0);

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
  createdAt: now,
}];

scan = scanner.runScannerOnce({ now });
assert.equal(scan.ok, true);
assert.equal(scan.scan.tradingOsSignalsRead, 1);
assert.equal(scan.scan.signalsMappedToFutures, 1);
assert.equal(scan.scan.realSignalCandidates, 1);
assert.equal(scan.scan.engineTestCandidates, 0);
assert.equal(scan.candidates.length, 1);
assert.equal(scan.candidates[0].symbol, 'MNQ');
assert.equal(scan.candidates[0].direction, 'long');
assert.equal(scan.candidates[0].stopLoss, 19900);
assert.equal(scan.candidates[0].takeProfit, 20200);
assert.equal(scan.candidates[0].usedRealStrategyLogic, true);

const simulated = scanner.simulateCandidate({ now });
assert.equal(simulated.ok, true);
assert.equal(simulated.position.symbol, 'MNQ');
assert.equal(simulated.position.side, 'long');
assert.equal(simulated.position.tradeType, 'trading_os_signal');
assert.equal(simulated.position.signalSource, 'scanner');
assert.equal(simulated.position.dataSource, 'real_market_data');
assert.equal(simulated.position.usedRealStrategyLogic, true);
assert.equal(simulated.position.excludedFromStats, false);
assert.equal(simulated.position.originalSignalId, 'sig-qqq-long-1');
assert.equal(simulated.position.mappedFuturesSymbol, 'MNQ');

const closedReal = ledger.closeFuturesPaperPosition({
  now: '2026-07-06T11:05:00.000Z',
  tradeId: simulated.position.tradeId,
  exitPrice: 20100,
  exitReason: 'take_profit_hit',
});
assert.equal(closedReal.ok, true);

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

assert.equal(scanner.assertPaperOnly({ live_trading_enabled: true }), 'live_trading_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ broker_enabled: true }), 'broker_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ actions_allowed: true }), 'real_actions_are_not_allowed');
assert.equal(scanner.assertPaperOnly({ can_place_orders: true }), 'real_orders_are_not_allowed');
assert.equal(scanner.assertPaperOnly({ mode: 'live' }), 'mode_must_be_paper_only');

console.log('futuresPaperScannerService.test.js passed');
