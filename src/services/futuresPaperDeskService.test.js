'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const accountSummaryModule = require('./ibPaperAccountSummaryService');
const brokerOrchestratorModule = require('./ibPaperExecutionOrchestratorService');
const strategyPerformanceModule = require('./futuresPaperStrategyPerformanceService');
const svc = require('./futuresPaperDeskService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-desk-'));
const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage, allowInternalSimulationForTests: true });
accountSvc.setFuturesPaperBalance({ startingBalanceSek: 375000 });
const ledgerSvc = require('./futuresPaperLedgerService').createFuturesPaperLedgerService({
  storageService: storage,
  accountService: accountSvc,
  allowInternalSimulationForTests: true,
});

const TEST_NOW = '2026-07-06T10:00:00.000Z';
const EMPTY_LEGACY_LEDGER = Object.freeze({
  account: null,
  positions: { open: [], closed: [], totalOpen: 0, totalClosed: 0 },
  openPositions: [],
  closedTrades: [],
  latestEvents: [],
});
const EMPTY_BROKER_RECONCILIATION = Object.freeze({
  ok: false,
  status: 'unknown',
  degraded: true,
  generatedAt: TEST_NOW,
  counts: { positions: 0, openOrders: 0, executions: 0, orderStatuses: 0 },
  positions: [],
  openOrders: [],
  executions: [],
  commissions: [],
});
const TEST_UNIVERSE = Object.freeze({
  groups: { mini_futures: { label_sv: 'Mini futures', enabled: true } },
  symbols: [
    { symbol: 'MNQ', marketGroup: 'mini_futures', enabled: true, test_only: true, risk_level: 'very_high' },
    { symbol: 'MES', marketGroup: 'mini_futures', enabled: false, test_only: true, risk_level: 'very_high' },
  ],
});
const EMPTY_SCANNER_RUNTIME = Object.freeze({
  scanner: { connected: false, lastScanAt: null, lastScanSummary: null, lastTickAt: null },
  autoSimulation: { enabled: false, intervalMs: null, timerActive: false, retired: true },
  candidateQueue: { connected: true, length: 0, candidates: [] },
  scanHistory: [],
  dataFeed: { source: 'test', simulated: false, fallback: false },
  quotes: [],
  engineConfig: { closedTradesLimit: 1 },
  statusReasons: [],
});
const EMPTY_STRATEGY_STATUS = Object.freeze({
  totalStrategies: 0,
  approvedStrategies: 0,
  tradableNow: 0,
  config: {},
  strategies: [],
});

function minimalRuntimeOptions(extra = {}) {
  return {
    now: TEST_NOW,
    legacyLedger: EMPTY_LEGACY_LEDGER,
    brokerReconciliation: EMPTY_BROKER_RECONCILIATION,
    universe: TEST_UNIVERSE,
    performance: { strategies: [] },
    paperStrategies: { strategies: [] },
    scannerRuntime: EMPTY_SCANNER_RUNTIME,
    strategyStatus: EMPTY_STRATEGY_STATUS,
    ...extra,
  };
}

ledgerSvc.openFuturesPaperPosition({
  now: '2026-07-06T10:00:00.000Z',
  root: 'MNQ',
  symbol: 'MNQH26',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  entryReason: 'Seed runtime position',
});

const runtime = svc.buildFuturesPaperDeskRuntime({
  now: '2026-07-06T10:00:00.000Z',
  legacyLedger: ledgerSvc.getFuturesPaperLedger({ limit: 20 }),
  ibAccount: {
    ok: true,
    status: 'ok',
    generatedAt: '2026-07-06T10:00:00.000Z',
    account: {
      accountIdMasked: 'DU***596',
      classification: 'paper',
      accountType: 'INDIVIDUAL',
      currency: 'USD',
      netLiquidation: 123456.78,
      totalCashValue: 120000,
      availableFunds: 99000,
      buyingPower: 396000,
      unrealizedPnl: 12.5,
      realizedPnl: 7.25,
      dailyPnl: 19.75,
      maintMarginReq: 5000,
      initMarginReq: 7500,
      cushion: 0.82,
      fullInitMarginReq: 7600,
      fullMaintMarginReq: 5100,
      excessLiquidity: 88000,
    },
  },
  brokerReconciliation: {
    ok: true,
    status: 'ok',
    degraded: false,
    newEntriesAllowed: true,
    generatedAt: '2026-07-06T10:00:00.000Z',
    counts: { positions: 1, openOrders: 1, executions: 1, orderStatuses: 1 },
    positions: [{
      accountMasked: 'DU***596',
      symbol: 'MNQ',
      localSymbol: 'MNQU6',
      conId: 793356225,
      expiry: '20260918',
      position: 1,
      avgCost: 20000,
      unrealizedPnl: 12.5,
      realizedPnl: 7.25,
    }],
    openOrders: [{
      orderId: 1001,
      order: { permId: 2001, orderRef: 'TOS-PAPER-fxp-test-entry', action: 'BUY', totalQuantity: 1, orderType: 'MKT' },
      contract: { symbol: 'MNQ', localSymbol: 'MNQU6', conId: 793356225 },
      state: 'Submitted',
    }],
    executions: [{
      orderId: 1001,
      permId: 2001,
      execId: 'exec-1',
      orderRef: 'TOS-PAPER-fxp-test-entry',
      strategyId: 'trend_continuation',
      candidateId: 'cand-1',
      conId: 793356225,
      localSymbol: 'MNQU6',
      side: 'BOT',
      shares: 1,
      price: 20000,
      receivedAt: '2026-07-06T10:00:00.000Z',
    }],
    orderStatuses: [{
      orderId: 1001,
      permId: 2001,
      ibStatus: 'Submitted',
      status: 'submitted',
      filled: 0,
      remaining: 1,
      avgFillPrice: null,
      lastFillPrice: null,
      updatedAt: '2026-07-06T10:00:00.000Z',
    }],
    commissions: [{ execId: 'exec-1', commission: 1.22, currency: 'USD', realizedPNL: 7.25 }],
    discrepancies: [],
  },
  universe: {
    groups: { mini_futures: { label_sv: 'Mini futures', enabled: true } },
    symbols: [
      { symbol: 'MNQ', marketGroup: 'mini_futures', enabled: true, test_only: true, risk_level: 'very_high' },
      { symbol: 'MES', marketGroup: 'mini_futures', enabled: false, test_only: true, risk_level: 'very_high' },
    ],
  },
  performance: {
    strategies: [
      { strategy_id: 'trend_continuation', strategy_name: 'Trend Continuation', win_rate: 58.2, avg_pnl: 0.12, score: 74, trades: 128, best_symbol: 'MNQ' },
      { strategy_id: 'pullback_reversal', strategy_name: 'Pullback Reversal', win_rate: 54.1, avg_pnl: 0.08, score: 69, trades: 96, best_symbol: 'MES' },
    ],
  },
  startingBalance: 250000,
});

assert.equal(runtime.ok, true);
assert.equal(runtime.mode, 'paper_only');
assert.equal(runtime.actions_allowed, false);
assert.equal(runtime.can_place_orders, false);
assert.equal(runtime.live_trading_enabled, false);
assert.equal(runtime.broker_enabled, false);
assert.equal(runtime.desk.focusMarkets[0], 'MNQ');
assert.equal(runtime.desk.focusMarkets[1], 'MES');
for (const field of [
  'source',
  'status',
  'accountIdMasked',
  'currency',
  'cash',
  'totalCashValue',
  'netLiquidation',
  'availableFunds',
  'buyingPower',
  'realizedPnl',
  'unrealizedPnl',
  'dailyPnl',
  'updatedAt',
  'stale',
  'degraded',
  'degradedReason',
  'blocker',
]) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.account, field), `runtime.account.${field} exists`);
}
assert.equal(runtime.account.source, 'ibkr_paper');
assert.equal(runtime.account.status, 'ok');
assert.equal(typeof runtime.account.stale, 'boolean');
assert.equal(typeof runtime.account.degraded, 'boolean');
assert.equal(runtime.account.accountIdMasked, 'DU***596');
assert.equal(runtime.account.classification, 'paper');
assert.equal(runtime.account.accountType, 'INDIVIDUAL');
assert.equal(runtime.account.currency, 'USD');
assert.equal(runtime.account.cash, 120000);
assert.equal(runtime.account.totalCashValue, 120000);
assert.equal(runtime.account.cash, runtime.account.totalCashValue, 'cash is a backward-compatible alias of totalCashValue');
assert.equal(runtime.account.netLiquidation, 123456.78);
assert.equal(runtime.account.availableFunds, 99000);
assert.equal(runtime.account.buyingPower, 396000);
assert.equal(runtime.account.unrealizedPnl, 12.5);
assert.equal(runtime.account.realizedPnl, 7.25);
assert.equal(runtime.account.dailyPnl, 19.75);
assert.equal(runtime.account.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.account.degradedReason, null);
assert.equal(runtime.account.blocker, null);
assert.equal(runtime.account.unavailableReason, null);
for (const field of [
  'initMarginReq',
  'maintMarginReq',
  'cushion',
  'fullInitMarginReq',
  'fullMaintMarginReq',
  'excessLiquidity',
  'updatedAt',
  'source',
]) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.margin, field), `runtime.margin.${field} exists`);
}
assert.equal(runtime.margin.source, 'ibkr_paper');
assert.equal(runtime.margin.initMarginReq, 7500);
assert.equal(runtime.margin.maintMarginReq, 5000);
assert.equal(runtime.margin.cushion, 0.82);
assert.equal(runtime.margin.fullInitMarginReq, 7600);
assert.equal(runtime.margin.fullMaintMarginReq, 5100);
assert.equal(runtime.margin.excessLiquidity, 88000);
assert.equal(runtime.margin.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.account.initMarginReq, runtime.margin.initMarginReq, 'account keeps margin alias');
assert.equal(runtime.account.maintMarginReq, runtime.margin.maintMarginReq, 'account keeps margin alias');
assert.equal(runtime.account.cushion, runtime.margin.cushion, 'account keeps margin alias');
assert.equal(runtime.legacyInternalSimulation.readOnly, true);
assert.equal(runtime.legacyInternalSimulation.legacySource, 'internal_legacy_simulation');
assert.equal(runtime.legacyInternalSimulation.positions.totalOpen, 1);
assert.equal(runtime.strategyPulse.length, 2);
assert.equal(runtime.strategyPulse[0].strategyId, 'trend_continuation');
// Katalogen exponerar nu MNQ/MES/NQ/ES.
assert.equal(runtime.instruments.length, 4);
assert.equal(runtime.instruments[0].symbol, 'MNQ');
assert.equal(runtime.instruments.map((row) => row.symbol).sort().join(','), 'ES,MES,MNQ,NQ');
const mnqInstrument = runtime.instruments.find((row) => row.symbol === 'MNQ');
assert.equal(mnqInstrument.pointValueUsd, 2);
assert.equal(mnqInstrument.commissionPerSideUsd, 1.22);
assert.equal(mnqInstrument.estRoundTripCostUsd, 2.44);
assert.equal(runtime.market.session, 'Globex');
assert.equal(runtime.market.sessionId, 'europe');
assert.equal(runtime.market.sessionLabel, 'Europe');
assert.equal(runtime.market.timezone, 'America/Chicago');
assert.equal(runtime.market.isRth, false);
assert.equal(runtime.market.isGlobex, true);
assert.equal(runtime.market.maintenanceWindow, '16:00-17:00 CT');
assert.equal(runtime.strategyOverviewMeta.totalStrategies, 33);
assert.equal(runtime.strategyOverview.length, 33);
assert.equal(runtime.strategyOverviewMeta.currentSession, 'Europe');
assert.equal(runtime.strategyOverviewMeta.marketOpen, true);
const overviewIds = runtime.strategyOverview.map((row) => row.strategyId);
assert.equal(new Set(overviewIds).size, 33, 'exactly 33 unique strategyIds');
for (const row of runtime.strategyOverview) {
  assert.ok(svc.PAPER_STATUSES.includes(row.paperStatus), `${row.strategyId} has allowed status (${row.paperStatus})`);
}
const trendOverview = runtime.strategyOverview.find((row) => row.strategyId === 'trend_continuation');
assert.ok(trendOverview, 'trend_continuation overview exists');
assert.equal(trendOverview.instrument, 'MNQ / MES');
assert.equal(trendOverview.currentSession, 'Europe');
// Ledgerns legacy-position ska inte göra aktiv runtime till ACTIVE_PAPER.
assert.notEqual(trendOverview.openPaperPosition?.symbol, 'MNQH26');
// Crypto-strategier saknar futures-mappning → synliga men NOT_APPLICABLE.
const cryptoOverview = runtime.strategyOverview.find((row) => row.strategyId === 'crypto_fast_momentum');
assert.ok(cryptoOverview, 'crypto strategy still visible');
assert.equal(cryptoOverview.paperStatus, 'NOT_APPLICABLE');
assert.equal(cryptoOverview.instrument, null);
assert.equal(cryptoOverview.canTradeNow, false);
assert.equal(cryptoOverview.mainBlocker, 'unsupported_futures_mapping');
assert.equal(runtime.account.currency, 'USD');
assert.equal(runtime.positions.totalOpen, 1);
assert.equal(runtime.openPositions.length, 1);
assert.equal(runtime.openPositions[0].source, 'ibkr_paper');
assert.equal(runtime.openPositions[0].localSymbol, 'MNQU6');
assert.equal(runtime.closedTrades.length, 1);
assert.equal(runtime.closedTrades[0].source, 'ibkr_paper');
assert.equal(runtime.brokerOrders.length, 1);
for (const field of [
  'status',
  'degraded',
  'newEntriesAllowed',
  'blockedReason',
  'counts',
  'updatedAt',
  'source',
]) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.broker, field), `runtime.broker.${field} exists`);
}
assert.equal(runtime.broker.status, 'ok');
assert.equal(runtime.broker.degraded, false);
assert.equal(runtime.broker.newEntriesAllowed, true);
assert.equal(runtime.broker.blockedReason, null);
assert.equal(runtime.broker.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.broker.source, 'ibkr_paper');
assert.equal(runtime.broker.counts.positions, 1);
assert.equal(runtime.broker.counts.openOrders, 1);
assert.equal(runtime.broker.counts.executions, 1);
assert.equal(runtime.broker.counts.fills, 1);
assert.equal(runtime.broker.counts.commissions, 1);
assert.equal(runtime.broker.counts.orderStatuses, 1);
assert.equal(runtime.broker.counts.discrepancies, 0);
assert.equal(runtime.broker.reconciliation, runtime.brokerReconciliation, 'broker.reconciliation aliases existing reconciliation snapshot');
for (const field of [
  'open',
  'completed',
  'statuses',
  'totalOpen',
  'totalCompleted',
  'updatedAt',
  'source',
]) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.orders, field), `runtime.orders.${field} exists`);
}
assert.equal(Array.isArray(runtime.orders.open), true);
assert.equal(Array.isArray(runtime.orders.completed), true);
assert.equal(Array.isArray(runtime.orders.statuses), true);
assert.deepEqual(runtime.orders.open, runtime.brokerOrders, 'orders.open matches brokerOrders alias');
assert.equal(runtime.orders.completed.length, 0);
assert.equal(runtime.orders.statuses.length, 1);
assert.equal(runtime.orders.totalOpen, 1);
assert.equal(runtime.orders.totalCompleted, 0);
assert.equal(runtime.orders.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.orders.source, 'ibkr_paper');
assert.equal(runtime.orders.open[0].orderId, 1001);
assert.equal(runtime.orders.open[0].permId, 2001);
assert.equal(runtime.orders.open[0].orderRef, 'TOS-PAPER-fxp-test-entry');
assert.equal(runtime.orders.open[0].accountMasked, null);
assert.equal(runtime.orders.open[0].conId, 793356225);
assert.equal(runtime.orders.open[0].localSymbol, 'MNQU6');
assert.equal(runtime.orders.open[0].symbol, 'MNQ');
assert.equal(runtime.orders.open[0].action, 'BUY');
assert.equal(runtime.orders.open[0].quantity, 1);
assert.equal(runtime.orders.open[0].orderType, 'MKT');
assert.equal(runtime.orders.open[0].limitPrice, null);
assert.equal(runtime.orders.open[0].stopPrice, null);
assert.equal(runtime.orders.open[0].source, 'ibkr_paper');
for (const field of ['items', 'count', 'updatedAt', 'source']) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.executions, field), `runtime.executions.${field} exists`);
}
assert.equal(Array.isArray(runtime.executions.items), true);
assert.deepEqual(runtime.executions.items, runtime.brokerExecutions, 'executions.items matches brokerExecutions alias');
assert.deepEqual(runtime.brokerFills, runtime.executions.items, 'brokerFills matches canonical executions items');
assert.equal(runtime.executions.count, 1);
assert.equal(runtime.executions.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.executions.source, 'ibkr_paper');
assert.equal(runtime.executions.items[0].id, 'exec-1');
assert.equal(runtime.executions.items[0].ibOrderId, 1001);
assert.equal(runtime.executions.items[0].orderId, 1001);
assert.equal(runtime.executions.items[0].permId, 2001);
assert.equal(runtime.executions.items[0].execId, 'exec-1');
assert.equal(runtime.executions.items[0].orderRef, 'TOS-PAPER-fxp-test-entry');
assert.equal(runtime.executions.items[0].strategyId, 'trend_continuation');
assert.equal(runtime.executions.items[0].candidateId, 'cand-1');
assert.equal(runtime.executions.items[0].conId, 793356225);
assert.equal(runtime.executions.items[0].localSymbol, 'MNQU6');
assert.equal(runtime.executions.items[0].side, 'BOT');
assert.equal(runtime.executions.items[0].quantity, 1);
assert.equal(runtime.executions.items[0].fillPrice, 20000);
assert.equal(runtime.executions.items[0].commission, 1.22);
assert.equal(runtime.executions.items[0].commissionCurrency, 'USD');
assert.equal(runtime.executions.items[0].realizedResult, 7.25);
assert.equal(runtime.executions.items[0].source, 'ibkr_paper');
for (const field of ['items', 'count', 'updatedAt', 'source']) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.commissions, field), `runtime.commissions.${field} exists`);
}
assert.equal(Array.isArray(runtime.commissions.items), true);
assert.deepEqual(runtime.commissions.items, runtime.brokerCommissions, 'commissions.items matches brokerCommissions alias');
assert.equal(runtime.commissions.count, 1);
assert.equal(runtime.commissions.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.commissions.source, 'ibkr_paper');
assert.equal(runtime.commissions.items[0].execId, 'exec-1');
assert.equal(runtime.commissions.items[0].commission, 1.22);
assert.equal(runtime.commissions.items[0].currency, 'USD');
assert.equal(runtime.commissions.items[0].realizedPNL, 7.25);
for (const field of [
  'portfolioValue',
  'marketValue',
  'openExposure',
  'openRisk',
  'portfolioPnl',
  'dailyPnl',
  'realizedPnl',
  'unrealizedPnl',
  'commission',
  'currency',
  'updatedAt',
  'source',
]) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.portfolio, field), `runtime.portfolio.${field} exists`);
}
assert.equal(runtime.portfolio.portfolioValue, 123456.78);
assert.equal(runtime.portfolio.marketValue, null);
assert.equal(runtime.portfolio.openExposure, null);
assert.equal(runtime.portfolio.openRisk, null);
assert.equal(runtime.portfolio.portfolioPnl, 19.75, 'portfolioPnl aggregates canonical account realized/unrealized PnL');
assert.equal(runtime.portfolio.dailyPnl, 19.75);
assert.equal(runtime.portfolio.realizedPnl, 7.25);
assert.equal(runtime.portfolio.unrealizedPnl, 12.5);
assert.equal(runtime.portfolio.commission, 1.22, 'commission aggregates canonical execution commissions');
assert.equal(runtime.portfolio.currency, 'USD');
assert.equal(runtime.portfolio.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.portfolio.source, 'ibkr_paper');
for (const field of ['context', 'strategy', 'portfolio', 'updatedAt', 'source']) {
  assert.ok(Object.prototype.hasOwnProperty.call(runtime.performance, field), `runtime.performance.${field} exists`);
}
assert.equal(runtime.performance.source, 'futuresPaperStrategyPerformanceService');
assert.equal(runtime.performance.updatedAt, '2026-07-06T10:00:00.000Z');
assert.equal(runtime.performance.context.performanceContext, 'ibkr_paper');
assert.equal(runtime.performance.context.executionSource, 'ibkr_paper');
assert.equal(runtime.performance.context.notRealMarketPerformance, false);
assert.equal(runtime.performance.context.legacySimulationExcluded, true);
assert.equal(runtime.performance.context.strategyCount, 1);
assert.equal(runtime.performance.context.minTradesForRateLeaders, strategyPerformanceModule.MIN_TRADES_FOR_RATE_LEADERS);
assert.equal(runtime.performance.context.minTradesForRatios, strategyPerformanceModule.MIN_TRADES_FOR_RATE_LEADERS);
assert.equal(Array.isArray(runtime.performance.strategy), true);
assert.equal(runtime.performance.strategy.length, 1);
const trendPerformance = runtime.performance.strategy[0];
for (const field of [
  'strategyId',
  'displayName',
  'tradeCount',
  'winRate',
  'profitFactor',
  'expectancy',
  'averageWin',
  'averageLoss',
  'largestWin',
  'largestLoss',
  'drawdown',
  'netPnl',
  'grossPnl',
  'commission',
]) {
  assert.ok(Object.prototype.hasOwnProperty.call(trendPerformance, field), `runtime.performance.strategy[].${field} exists`);
}
assert.equal(trendPerformance.strategyId, 'trend_continuation');
assert.equal(trendPerformance.displayName, 'Trend Continuation');
assert.equal(trendPerformance.tradeCount, 1);
assert.equal(trendPerformance.winRate, null, 'winRate remains null below the verified minimum trade threshold');
assert.equal(trendPerformance.profitFactor, null, 'profitFactor remains null below the verified minimum trade threshold');
assert.equal(trendPerformance.expectancy, null, 'expectancy remains null below the verified minimum trade threshold');
assert.equal(trendPerformance.averageWin, null);
assert.equal(trendPerformance.averageLoss, null);
assert.equal(trendPerformance.largestWin, 7.25);
assert.equal(trendPerformance.largestLoss, null);
assert.equal(trendPerformance.drawdown, null);
assert.equal(trendPerformance.netPnl, 7.25);
assert.equal(trendPerformance.grossPnl, 7.25);
assert.equal(trendPerformance.commission, 1.22);
assert.equal(runtime.performance.portfolio.portfolioValue, runtime.portfolio.portfolioValue);
assert.equal(runtime.performance.portfolio.portfolioPnl, runtime.portfolio.portfolioPnl);
assert.equal(runtime.performance.portfolio.marketValue, null);
assert.equal(runtime.performance.portfolio.openExposure, null);
assert.equal(runtime.performance.portfolio.openRisk, null);
assert.equal(runtime.performance.portfolio.currency, 'USD');
assert.equal(runtime.latestEvents.length, 0);

const blockedAccountRuntime = svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions({
  ibAccount: {
    ok: false,
    status: 'pending',
    blocker: 'no_account_snapshot_yet',
    generatedAt: TEST_NOW,
    account: null,
  },
}));
assert.equal(blockedAccountRuntime.account.source, 'ibkr_paper');
assert.equal(blockedAccountRuntime.account.status, 'pending');
assert.equal(blockedAccountRuntime.account.accountIdMasked, null);
assert.equal(blockedAccountRuntime.account.currency, null);
assert.equal(blockedAccountRuntime.account.cash, null);
assert.equal(blockedAccountRuntime.account.totalCashValue, null);
assert.equal(blockedAccountRuntime.account.netLiquidation, null);
assert.equal(blockedAccountRuntime.account.availableFunds, null);
assert.equal(blockedAccountRuntime.account.buyingPower, null);
assert.equal(blockedAccountRuntime.account.realizedPnl, null);
assert.equal(blockedAccountRuntime.account.unrealizedPnl, null);
assert.equal(blockedAccountRuntime.account.dailyPnl, null);
assert.equal(blockedAccountRuntime.account.classification, null);
assert.equal(blockedAccountRuntime.account.accountType, null);
assert.equal(blockedAccountRuntime.account.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.account.stale, false);
assert.equal(blockedAccountRuntime.account.degraded, true);
assert.equal(blockedAccountRuntime.account.degradedReason, null);
assert.equal(blockedAccountRuntime.account.blocker, 'no_account_snapshot_yet');
assert.equal(blockedAccountRuntime.account.unavailableReason, 'no_account_snapshot_yet');
assert.equal(blockedAccountRuntime.margin.initMarginReq, null);
assert.equal(blockedAccountRuntime.margin.maintMarginReq, null);
assert.equal(blockedAccountRuntime.margin.cushion, null);
assert.equal(blockedAccountRuntime.margin.fullInitMarginReq, null);
assert.equal(blockedAccountRuntime.margin.fullMaintMarginReq, null);
assert.equal(blockedAccountRuntime.margin.excessLiquidity, null);
assert.equal(blockedAccountRuntime.margin.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.margin.source, 'ibkr_paper');
assert.equal(blockedAccountRuntime.broker.status, 'unknown');
assert.equal(blockedAccountRuntime.broker.degraded, true);
assert.equal(blockedAccountRuntime.broker.newEntriesAllowed, false);
assert.equal(blockedAccountRuntime.broker.blockedReason, null);
assert.equal(blockedAccountRuntime.broker.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.broker.source, 'ibkr_paper');
assert.equal(blockedAccountRuntime.broker.counts.positions, 0);
assert.equal(blockedAccountRuntime.broker.counts.openOrders, 0);
assert.equal(blockedAccountRuntime.broker.counts.executions, 0);
assert.equal(blockedAccountRuntime.broker.counts.fills, 0);
assert.equal(blockedAccountRuntime.broker.counts.commissions, 0);
assert.equal(blockedAccountRuntime.broker.counts.orderStatuses, 0);
assert.equal(blockedAccountRuntime.broker.counts.discrepancies, 0);
assert.equal(Array.isArray(blockedAccountRuntime.orders.open), true);
assert.equal(Array.isArray(blockedAccountRuntime.orders.completed), true);
assert.equal(Array.isArray(blockedAccountRuntime.orders.statuses), true);
assert.equal(blockedAccountRuntime.orders.open.length, 0);
assert.equal(blockedAccountRuntime.orders.completed.length, 0);
assert.equal(blockedAccountRuntime.orders.statuses.length, 0);
assert.equal(blockedAccountRuntime.orders.totalOpen, 0);
assert.equal(blockedAccountRuntime.orders.totalCompleted, 0);
assert.equal(blockedAccountRuntime.orders.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.orders.source, 'ibkr_paper');
assert.equal(Array.isArray(blockedAccountRuntime.executions.items), true);
assert.equal(blockedAccountRuntime.executions.items.length, 0);
assert.equal(blockedAccountRuntime.executions.count, 0);
assert.equal(blockedAccountRuntime.executions.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.executions.source, 'ibkr_paper');
assert.equal(Array.isArray(blockedAccountRuntime.commissions.items), true);
assert.equal(blockedAccountRuntime.commissions.items.length, 0);
assert.equal(blockedAccountRuntime.commissions.count, 0);
assert.equal(blockedAccountRuntime.commissions.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.commissions.source, 'ibkr_paper');
assert.equal(blockedAccountRuntime.portfolio.portfolioValue, null);
assert.equal(blockedAccountRuntime.portfolio.marketValue, null);
assert.equal(blockedAccountRuntime.portfolio.openExposure, null);
assert.equal(blockedAccountRuntime.portfolio.openRisk, null);
assert.equal(blockedAccountRuntime.portfolio.portfolioPnl, null);
assert.equal(blockedAccountRuntime.portfolio.dailyPnl, null);
assert.equal(blockedAccountRuntime.portfolio.realizedPnl, null);
assert.equal(blockedAccountRuntime.portfolio.unrealizedPnl, null);
assert.equal(blockedAccountRuntime.portfolio.commission, null);
assert.equal(blockedAccountRuntime.portfolio.currency, null);
assert.equal(blockedAccountRuntime.portfolio.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.portfolio.source, 'ibkr_paper');
assert.equal(Array.isArray(blockedAccountRuntime.performance.strategy), true);
assert.equal(blockedAccountRuntime.performance.strategy.length, 0);
assert.equal(blockedAccountRuntime.performance.context.strategyCount, 0);
assert.equal(blockedAccountRuntime.performance.portfolio.portfolioValue, null);
assert.equal(blockedAccountRuntime.performance.portfolio.marketValue, null);
assert.equal(blockedAccountRuntime.performance.portfolio.openExposure, null);
assert.equal(blockedAccountRuntime.performance.portfolio.openRisk, null);
assert.equal(blockedAccountRuntime.performance.portfolio.portfolioPnl, null);
assert.equal(blockedAccountRuntime.performance.portfolio.dailyPnl, null);
assert.equal(blockedAccountRuntime.performance.portfolio.realizedPnl, null);
assert.equal(blockedAccountRuntime.performance.portfolio.unrealizedPnl, null);
assert.equal(blockedAccountRuntime.performance.portfolio.commission, null);
assert.equal(blockedAccountRuntime.performance.portfolio.currency, null);
assert.equal(blockedAccountRuntime.performance.updatedAt, TEST_NOW);
assert.equal(blockedAccountRuntime.performance.source, 'futuresPaperStrategyPerformanceService');

const accountUpdatesPositionRuntime = svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions({
  ibAccount: {
    ok: true,
    status: 'ok',
    generatedAt: TEST_NOW,
    account: {
      accountIdMasked: 'DU***596',
      classification: 'paper',
      currency: 'SEK',
      netLiquidation: 11063846.43,
    },
    portfolioPositions: [{
      accountMasked: 'DU***596',
      accountClassification: 'paper',
      conId: 793356225,
      symbol: 'MNQ',
      localSymbol: 'MNQU6',
      secType: 'FUT',
      position: 1,
      marketPrice: 28608.1503906,
      marketValue: 57216.3,
      avgCost: 57247.11,
      unrealizedPnl: -30.81,
      realizedPnl: -344.94,
      source: 'ibkr_paper_account_updates',
    }],
  },
}));
assert.equal(accountUpdatesPositionRuntime.positions.totalOpen, 1);
assert.equal(accountUpdatesPositionRuntime.positions.source, 'ibkr_paper_account_updates');
assert.equal(accountUpdatesPositionRuntime.openPositions.length, 1);
assert.equal(accountUpdatesPositionRuntime.brokerPositions.length, 1);
assert.equal(accountUpdatesPositionRuntime.openPositions[0].localSymbol, 'MNQU6');
assert.equal(accountUpdatesPositionRuntime.openPositions[0].quantity, 1);
assert.equal(accountUpdatesPositionRuntime.openPositions[0].signedQuantity, 1);

const staleAccountRuntime = svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions({
  ibAccount: {
    ok: true,
    status: 'ok',
    stale: true,
    degraded: true,
    degradedReason: 'live_fetch_timeout_returning_cache',
    generatedAt: TEST_NOW,
    account: {
      accountIdMasked: 'DU***596',
      classification: 'paper',
      currency: 'SEK',
      netLiquidation: 11057906.32,
    },
  },
}));
assert.equal(staleAccountRuntime.account.status, 'ok');
assert.equal(staleAccountRuntime.account.accountIdMasked, 'DU***596');
assert.equal(staleAccountRuntime.account.stale, true);
assert.equal(staleAccountRuntime.account.degraded, true);
assert.equal(staleAccountRuntime.account.degradedReason, 'live_fetch_timeout_returning_cache');
assert.equal(staleAccountRuntime.account.blocker, null);

const portfolioAggregationRuntime = svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions({
  ibAccount: {
    ok: true,
    status: 'ok',
    generatedAt: TEST_NOW,
    account: {
      accountIdMasked: 'DU***222',
      currency: 'USD',
      netLiquidation: 1000,
      totalCashValue: 900,
      realizedPnl: 5.5,
      unrealizedPnl: -2.25,
    },
  },
  brokerReconciliation: {
    ...EMPTY_BROKER_RECONCILIATION,
    ok: true,
    status: 'ok',
    degraded: false,
    generatedAt: '2026-07-06T10:05:00.000Z',
    counts: { positions: 0, openOrders: 0, executions: 2, orderStatuses: 0 },
    executions: [
      { orderId: 1002, execId: 'exec-2', shares: 1, price: 20001, receivedAt: TEST_NOW },
      { orderId: 1003, execId: 'exec-3', shares: 1, price: 20002, receivedAt: TEST_NOW },
    ],
    commissions: [
      { execId: 'exec-2', commission: 1.22, currency: 'USD' },
      { execId: 'exec-3', commission: 1.78, currency: 'USD' },
    ],
    orderStatuses: [],
    discrepancies: [],
  },
}));
assert.equal(portfolioAggregationRuntime.portfolio.portfolioValue, 1000);
assert.equal(portfolioAggregationRuntime.portfolio.portfolioPnl, 3.25);
assert.equal(portfolioAggregationRuntime.portfolio.dailyPnl, null);
assert.equal(portfolioAggregationRuntime.portfolio.commission, 3);
assert.equal(portfolioAggregationRuntime.portfolio.currency, 'USD');
assert.equal(portfolioAggregationRuntime.portfolio.updatedAt, '2026-07-06T10:05:00.000Z');
assert.equal(portfolioAggregationRuntime.portfolio.marketValue, null);
assert.equal(portfolioAggregationRuntime.portfolio.openExposure, null);
assert.equal(portfolioAggregationRuntime.portfolio.openRisk, null);

const performanceAggregationRuntime = svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions({
  ibAccount: {
    ok: true,
    status: 'ok',
    generatedAt: TEST_NOW,
    account: {
      accountIdMasked: 'DU***333',
      currency: 'USD',
      netLiquidation: 2000,
      totalCashValue: 1900,
      realizedPnl: 100,
      unrealizedPnl: -15,
    },
  },
  brokerReconciliation: {
    ...EMPTY_BROKER_RECONCILIATION,
    ok: true,
    status: 'ok',
    degraded: false,
    generatedAt: '2026-07-06T10:06:00.000Z',
    counts: { positions: 0, openOrders: 0, executions: 5, orderStatuses: 0 },
    executions: [
      { orderId: 1004, execId: 'exec-4', strategyId: 'trend_continuation', shares: 1, price: 20003, receivedAt: TEST_NOW },
      { orderId: 1005, execId: 'exec-5', strategyId: 'trend_continuation', shares: 1, price: 20004, receivedAt: TEST_NOW },
      { orderId: 1006, execId: 'exec-6', strategyId: 'trend_continuation', shares: 1, price: 20005, receivedAt: TEST_NOW },
      { orderId: 1007, execId: 'exec-7', strategyId: 'trend_continuation', shares: 1, price: 20006, receivedAt: TEST_NOW },
      { orderId: 1008, execId: 'exec-8', strategyId: 'trend_continuation', shares: 1, price: 20007, receivedAt: TEST_NOW },
    ],
    commissions: [
      { execId: 'exec-4', commission: 2.5, currency: 'USD', realizedPNL: 125 },
      { execId: 'exec-5', commission: 2.5, currency: 'USD', realizedPNL: -25 },
      { execId: 'exec-6', commission: 2.5, currency: 'USD', realizedPNL: 75 },
      { execId: 'exec-7', commission: 2.5, currency: 'USD', realizedPNL: -50 },
      { execId: 'exec-8', commission: 2.5, currency: 'USD', realizedPNL: 25 },
    ],
    orderStatuses: [],
    discrepancies: [],
  },
}));
const mixedPerformance = performanceAggregationRuntime.performance.strategy.find((row) => row.strategyId === 'trend_continuation');
assert.ok(mixedPerformance, 'mixed performance row exists');
assert.equal(mixedPerformance.tradeCount, 5);
assert.equal(mixedPerformance.winRate, 60);
assert.equal(mixedPerformance.profitFactor, 3);
assert.equal(mixedPerformance.expectancy, 30);
// (125 + 75 + 25) / 3 vinnare
assert.equal(mixedPerformance.averageWin, 75);
// (-25 + -50) / 2 förlorare
assert.equal(mixedPerformance.averageLoss, -37.5);
assert.equal(mixedPerformance.largestWin, 125);
assert.equal(mixedPerformance.largestLoss, -50);
// equity 125 → 100 → 175 → 125 → 150, peak 175 ⇒ största fall 50
assert.equal(mixedPerformance.drawdown, 50);
assert.equal(mixedPerformance.netPnl, 150);
assert.equal(mixedPerformance.grossPnl, 150);
assert.equal(mixedPerformance.commission, 12.5);
assert.equal(performanceAggregationRuntime.performance.portfolio.portfolioValue, 2000);
assert.equal(performanceAggregationRuntime.performance.portfolio.portfolioPnl, 85);
assert.equal(performanceAggregationRuntime.performance.portfolio.dailyPnl, null);
assert.equal(performanceAggregationRuntime.performance.portfolio.commission, 12.5);
assert.equal(performanceAggregationRuntime.performance.portfolio.currency, 'USD');
assert.equal(performanceAggregationRuntime.performance.updatedAt, '2026-07-06T10:06:00.000Z');

function buildPerformanceContractRuntime({ execId, execution = {}, commissions = [] }) {
  return svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions({
    ibAccount: {
      ok: true,
      status: 'ok',
      generatedAt: TEST_NOW,
      account: {
        accountIdMasked: 'DU***444',
        currency: 'USD',
        netLiquidation: 3000,
        totalCashValue: 2900,
      },
    },
    brokerReconciliation: {
      ...EMPTY_BROKER_RECONCILIATION,
      ok: true,
      status: 'ok',
      degraded: false,
      generatedAt: '2026-07-06T10:07:00.000Z',
      counts: { positions: 0, openOrders: 0, executions: 1, orderStatuses: 0 },
      executions: [{
        orderId: 1100,
        execId,
        strategyId: 'trend_continuation',
        shares: 1,
        price: 20008,
        receivedAt: TEST_NOW,
        ...execution,
      }],
      commissions,
      orderStatuses: [],
      discrepancies: [],
    },
  }));
}

const missingCommissionRuntime = buildPerformanceContractRuntime({
  execId: 'exec-missing-commission',
  execution: { realizedPnl: 42 },
  commissions: [],
});
const missingCommissionPerformance = missingCommissionRuntime.performance.strategy[0];
assert.equal(missingCommissionPerformance.strategyId, 'trend_continuation');
assert.equal(missingCommissionPerformance.commission, null);
assert.equal(missingCommissionPerformance.netPnl, 42);
assert.equal(missingCommissionPerformance.grossPnl, 42);
assert.equal(missingCommissionPerformance.largestWin, 42);
assert.equal(missingCommissionPerformance.largestLoss, null);

const missingRealizedPnlRuntime = buildPerformanceContractRuntime({
  execId: 'exec-missing-realized-pnl',
  commissions: [{ execId: 'exec-missing-realized-pnl', commission: 1.25, currency: 'USD' }],
});
assert.equal(missingRealizedPnlRuntime.executions.count, 1);
assert.equal(missingRealizedPnlRuntime.closedTrades.length, 0);
assert.equal(missingRealizedPnlRuntime.recentClosedTrades.length, 0);
assert.equal(missingRealizedPnlRuntime.performance.strategy.length, 0);
assert.equal(missingRealizedPnlRuntime.portfolio.commission, 1.25);

const missingCommissionAndRealizedPnlRuntime = buildPerformanceContractRuntime({
  execId: 'exec-missing-commission-and-realized-pnl',
  commissions: [],
});
assert.equal(missingCommissionAndRealizedPnlRuntime.executions.count, 1);
assert.equal(missingCommissionAndRealizedPnlRuntime.closedTrades.length, 0);
assert.equal(missingCommissionAndRealizedPnlRuntime.recentClosedTrades.length, 0);
assert.equal(missingCommissionAndRealizedPnlRuntime.performance.strategy.length, 0);

const originalGetCachedSummary = accountSummaryModule.defaultIbPaperAccountSummaryService.getCachedSummary;
const originalGetSummary = accountSummaryModule.defaultIbPaperAccountSummaryService.getSummary;
let cachedSummaryCalls = 0;
accountSummaryModule.defaultIbPaperAccountSummaryService.getCachedSummary = () => {
  cachedSummaryCalls += 1;
  return {
    ok: true,
    status: 'ok',
    generatedAt: TEST_NOW,
    account: {
      accountIdMasked: 'DU***111',
      classification: 'paper',
      accountType: 'INDIVIDUAL',
      currency: 'USD',
      netLiquidation: 111,
      totalCashValue: 100,
      availableFunds: 90,
      buyingPower: 360,
      realizedPnl: 2,
      unrealizedPnl: 3,
      initMarginReq: 10,
      maintMarginReq: 5,
      cushion: 0.9,
    },
  };
};
accountSummaryModule.defaultIbPaperAccountSummaryService.getSummary = () => {
  throw new Error('buildFuturesPaperDeskRuntime must not call getSummary');
};
try {
  const cachedRuntime = svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions());
  assert.equal(cachedSummaryCalls, 1);
  assert.equal(cachedRuntime.account.accountIdMasked, 'DU***111');
  assert.equal(cachedRuntime.account.netLiquidation, 111);
  assert.equal(cachedRuntime.account.dailyPnl, null, 'dailyPnl remains null when cached IB account does not produce it');
  assert.equal(cachedRuntime.margin.initMarginReq, 10);
  assert.equal(cachedRuntime.margin.fullInitMarginReq, null);
} finally {
  accountSummaryModule.defaultIbPaperAccountSummaryService.getCachedSummary = originalGetCachedSummary;
  accountSummaryModule.defaultIbPaperAccountSummaryService.getSummary = originalGetSummary;
}

const originalGetCachedReconciliation = brokerOrchestratorModule.defaultIbPaperExecutionOrchestratorService
  .reconciliation.getCachedReconciliation;
const originalReconcilePaperBroker = brokerOrchestratorModule.defaultIbPaperExecutionOrchestratorService
  .reconciliation.reconcilePaperBroker;
let cachedReconciliationCalls = 0;
brokerOrchestratorModule.defaultIbPaperExecutionOrchestratorService.reconciliation.getCachedReconciliation = () => {
  cachedReconciliationCalls += 1;
  return {
    ok: true,
    status: 'ok',
    degraded: false,
    newEntriesAllowed: true,
    generatedAt: TEST_NOW,
    counts: { positions: 0, openOrders: 0, executions: 0, orderStatuses: 0 },
    positions: [],
    openOrders: [],
    executions: [],
    commissions: [],
    orderStatuses: [],
    discrepancies: [],
  };
};
brokerOrchestratorModule.defaultIbPaperExecutionOrchestratorService.reconciliation.reconcilePaperBroker = () => {
  throw new Error('buildFuturesPaperDeskRuntime must not reconcile broker from runtime');
};
try {
  const cachedBrokerRuntimeOptions = minimalRuntimeOptions();
  delete cachedBrokerRuntimeOptions.brokerReconciliation;
  const cachedBrokerRuntime = svc.buildFuturesPaperDeskRuntime(cachedBrokerRuntimeOptions);
  assert.equal(cachedReconciliationCalls, 1);
  assert.equal(cachedBrokerRuntime.broker.status, 'ok');
  assert.equal(cachedBrokerRuntime.orders.open.length, 0);
  assert.equal(cachedBrokerRuntime.executions.count, 0);
  assert.equal(cachedBrokerRuntime.commissions.count, 0);
} finally {
  brokerOrchestratorModule.defaultIbPaperExecutionOrchestratorService.reconciliation.getCachedReconciliation = originalGetCachedReconciliation;
  brokerOrchestratorModule.defaultIbPaperExecutionOrchestratorService.reconciliation.reconcilePaperBroker = originalReconcilePaperBroker;
}

const originalGetPerformance = strategyPerformanceModule.getPerformance;
const originalReadBrokerExecutions = strategyPerformanceModule.readBrokerExecutions;
strategyPerformanceModule.getPerformance = () => {
  throw new Error('buildFuturesPaperDeskRuntime must not call getPerformance');
};
strategyPerformanceModule.readBrokerExecutions = () => {
  throw new Error('buildFuturesPaperDeskRuntime must not read broker executions from performance service');
};
try {
  const canonicalPerformanceRuntime = svc.buildFuturesPaperDeskRuntime(minimalRuntimeOptions({
    brokerReconciliation: {
      ...EMPTY_BROKER_RECONCILIATION,
      ok: true,
      status: 'ok',
      degraded: false,
      executions: [{ orderId: 1006, execId: 'exec-6', strategyId: 'trend_continuation', shares: 1, price: 20005, receivedAt: TEST_NOW }],
      commissions: [{ execId: 'exec-6', commission: 1, currency: 'USD', realizedPNL: 10 }],
    },
  }));
  assert.equal(canonicalPerformanceRuntime.performance.strategy.length, 1);
  assert.equal(canonicalPerformanceRuntime.performance.strategy[0].strategyId, 'trend_continuation');
} finally {
  strategyPerformanceModule.getPerformance = originalGetPerformance;
  strategyPerformanceModule.readBrokerExecutions = originalReadBrokerExecutions;
}

const pnlLong = svc.calcFuturesPnl({
  entryPrice: 20000,
  exitPrice: 20001,
  direction: 'long',
  contracts: 2,
  tickSize: 0.25,
  tickValueUsd: 0.50,
  fxRateUsdSek: 10.5,
  commissionsUsd: 1,
});

assert.equal(pnlLong.points, 1);
assert.equal(pnlLong.ticks, 4);
assert.equal(pnlLong.grossPnlUsd, 4);
assert.equal(pnlLong.netPnlUsd, 3);
assert.equal(pnlLong.netPnlSek, 31.5);

const pnlShort = svc.calcFuturesPnl({
  entryPrice: 5000,
  exitPrice: 4999,
  direction: 'short',
  contracts: 1,
  tickSize: 0.25,
  tickValueUsd: 1.25,
});

assert.equal(pnlShort.points, 1);
assert.equal(pnlShort.ticks, 4);
assert.equal(pnlShort.grossPnlUsd, 5);
assert.equal(pnlShort.netPnlUsd, 5);

// ---------------------------------------------------------------------------
// buildCanonicalStrategyOverview: sessionklassning, ACTIVE_PAPER-krav,
// canTradeNow-krav och robusthet vid saknade producer-/datarader.
// ---------------------------------------------------------------------------

const openRthSession = {
  isMarketOpen: true,
  session: 'Globex',
  sessionId: 'us_rth',
  sessionLabel: 'US RTH',
};
const openEuropeSession = {
  isMarketOpen: true,
  session: 'Globex',
  sessionId: 'europe',
  sessionLabel: 'Europe',
};
const maintenanceSession = {
  isMarketOpen: false,
  session: 'Globex',
  sessionId: 'maintenance_break',
  sessionLabel: 'Maintenance Break',
  closedReason: 'daily_maintenance',
};

function readyPaperRow(strategyId, extra = {}) {
  return {
    strategyId,
    paperEligibility: 'READY',
    readiness: 'READY_FOR_PAPER',
    producerStatus: 'ok',
    runtimeConnectorStatus: 'active',
    entryContractStatus: 'ready',
    approved: true,
    approvalStatus: 'approved',
    entryContract: {
      requiresMarketOpen: true,
      allowedSessions: ['regular', 'rth'],
    },
    ...extra,
  };
}

// Redo strategi, tillåten session, ingen position → READY_WAITING_FOR_SIGNAL.
const readyOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [],
});
assert.equal(readyOverview.totalStrategies, 33);
assert.equal(new Set(readyOverview.strategies.map((row) => row.strategyId)).size, 33);
const readyTrend = readyOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(readyTrend.paperStatus, 'READY_WAITING_FOR_SIGNAL');
assert.equal(readyTrend.canTradeNow, true);
assert.equal(readyTrend.marketOpen, true);
assert.equal(readyTrend.mainBlocker, null);

// ACTIVE_PAPER kräver faktisk öppen position — och gäller då även i underhållsfönster.
const activeOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T22:30:00.000Z',
  session: maintenanceSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [{ strategyId: 'trend_continuation', id: 'pos-1', symbol: 'MNQH26', direction: 'long' }],
  scannerStrategies: [],
});
const activeTrend = activeOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(activeTrend.paperStatus, 'ACTIVE_PAPER');
assert.equal(activeTrend.canTradeNow, false, 'canTradeNow false i stängd session även med öppen position');

// Stängd session (maintenance) utan position → SESSION_CLOSED + canTradeNow false.
const closedOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T22:30:00.000Z',
  session: maintenanceSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [],
});
const closedTrend = closedOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(closedTrend.paperStatus, 'SESSION_CLOSED');
assert.equal(closedTrend.canTradeNow, false);
assert.equal(closedTrend.mainBlocker, 'daily_maintenance');

// Öppen marknad men otillåten session (rth-kontrakt under Europe) → SESSION_CLOSED.
const wrongSessionOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T08:00:00.000Z',
  session: openEuropeSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [],
});
const wrongSessionTrend = wrongSessionOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(wrongSessionTrend.paperStatus, 'SESSION_CLOSED');
assert.equal(wrongSessionTrend.canTradeNow, false);
assert.equal(wrongSessionTrend.sessionAllowed, false);
assert.equal(wrongSessionTrend.mainBlocker, 'session_not_allowed_for_strategy');

// Kontrakt utan requiresMarketOpen upprätthåller inte sessionslistan (speglar entry contract-gaten).
const sessionFreeTrend = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T08:00:00.000Z',
  session: openEuropeSession,
  paperStrategies: {
    strategies: [readyPaperRow('trend_continuation', {
      entryContract: { requiresMarketOpen: false, allowedSessions: ['regular', 'rth'] },
    })],
  },
  openPositions: [],
  scannerStrategies: [],
}).strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(sessionFreeTrend.paperStatus, 'READY_WAITING_FOR_SIGNAL');
assert.equal(sessionFreeTrend.canTradeNow, true);

// Saknad producer/data-rad → strategin försvinner INTE, den klassas som blockerad.
const emptyOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: { strategies: [] },
  openPositions: [],
  scannerStrategies: [],
});
assert.equal(emptyOverview.totalStrategies, 33);
assert.equal(new Set(emptyOverview.strategies.map((row) => row.strategyId)).size, 33);
const emptyTrend = emptyOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(emptyTrend.paperStatus, 'PRODUCER_NOT_IMPLEMENTED');
const emptyCrypto = emptyOverview.strategies.find((row) => row.strategyId === 'crypto_fast_momentum');
assert.equal(emptyCrypto.paperStatus, 'NOT_APPLICABLE');
// Alla blockerade rader ska ha en explicit blockerare (fallback per status vid behov).
for (const row of emptyOverview.strategies) {
  if (!row.canTradeNow && row.paperStatus !== 'ACTIVE_PAPER') {
    assert.ok(row.mainBlocker, `${row.strategyId} (${row.paperStatus}) saknar mainBlocker`);
  }
}

// Scanner-cooldown/family-gate → TRADE_CAP_BLOCKED.
const cooldownTrend = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [{
    strategyId: 'trend_continuation',
    canTradeNow: false,
    cooldownActive: true,
    blockReason: 'strategy_cooldown_active',
  }],
}).strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(cooldownTrend.paperStatus, 'TRADE_CAP_BLOCKED');
assert.equal(cooldownTrend.canTradeNow, false);

// Riskskäl → RISK_BLOCKED.
const riskTrend = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: {
    strategies: [readyPaperRow('trend_continuation', { paperBlockedReason: 'risk_pause_triggered' })],
  },
  openPositions: [],
  scannerStrategies: [],
}).strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(riskTrend.paperStatus, 'RISK_BLOCKED');
assert.equal(riskTrend.canTradeNow, false);

// Ej godkänd → APPROVAL_BLOCKED; saknat entry contract → ENTRY_CONTRACT_BLOCKED;
// inaktiv runtime-connector → DATA_BLOCKED; replay-only → REPLAY_ONLY.
const variantOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: {
    strategies: [
      readyPaperRow('trend_continuation', { approved: false, approvalStatus: 'not_approved' }),
      readyPaperRow('gap_fade', { entryContractStatus: 'missing', entryContract: null }),
      readyPaperRow('support_bounce', { runtimeConnectorStatus: 'blocked' }),
      readyPaperRow('narrow_breakout', { readiness: 'READY_FOR_REPLAY' }),
    ],
  },
  openPositions: [],
  scannerStrategies: [],
});
const variantById = new Map(variantOverview.strategies.map((row) => [row.strategyId, row]));
assert.equal(variantById.get('trend_continuation').paperStatus, 'APPROVAL_BLOCKED');
assert.equal(variantById.get('gap_fade').paperStatus, 'ENTRY_CONTRACT_BLOCKED');
assert.equal(variantById.get('support_bounce').paperStatus, 'DATA_BLOCKED');
assert.equal(variantById.get('narrow_breakout').paperStatus, 'REPLAY_ONLY');
for (const row of variantOverview.strategies) {
  assert.ok(svc.PAPER_STATUSES.includes(row.paperStatus), `variant ${row.strategyId} status ${row.paperStatus}`);
  assert.equal(row.canTradeNow === true && row.marketOpen !== true, false, 'canTradeNow kräver öppen/tillåten session');
}

// sessionAllowedForStrategy: futures-session ↔ kontraktsvokabulär.
assert.equal(svc.sessionAllowedForStrategy('us_rth', { requiresMarketOpen: true, allowedSessions: ['rth'] }), true);
assert.equal(svc.sessionAllowedForStrategy('europe', { requiresMarketOpen: true, allowedSessions: ['rth'] }), false);
assert.equal(svc.sessionAllowedForStrategy('europe', { requiresMarketOpen: true, allowedSessions: ['24_7'] }), true);
assert.equal(svc.sessionAllowedForStrategy('europe', { requiresMarketOpen: false, allowedSessions: ['rth'] }), true);
assert.equal(svc.sessionAllowedForStrategy('overnight', null), true);
assert.equal(svc.sessionAllowedForStrategy('us_rth', { requiresMarketOpen: true, allowedSessions: [] }), true);

console.log('futuresPaperDeskService.test.js passed');
