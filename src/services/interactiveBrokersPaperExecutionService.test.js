'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-exec-'));
process.env.IB_PAPER_EXECUTION_DATA_DIR = tempDir;
process.env.IB_GATEWAY_HOST = '127.0.0.1';
process.env.IB_GATEWAY_PORT = '4002';

const svc = require('./interactiveBrokersPaperExecutionService');

function candidate(overrides = {}) {
  return {
    symbol: 'AAPL',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
    direction: 'short',
    entryPrice: 215.40,
    stopLossPrice: 215.62,
    takeProfit1: 214.97,
    takeProfit2: 214.54,
    confirmationText: 'CONFIRM PAPER TRADE',
    quantity: 1,
    ...overrides,
  };
}

function allowedOrderPreview(rows = []) {
  return {
    allowedCandidates: rows.map((row) => ({
      symbol: row.symbol,
      strategyId: row.strategyId,
    })),
  };
}

function readiness(overrides = {}) {
  return {
    ok: true,
    dryRun: true,
    status: 'reachable',
    gatewayReachable: true,
    host: '127.0.0.1',
    port: 4002,
    blockedReason: 'reachable_read_only_no_orders',
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    killSwitch: { active: false, reason: null, triggeredAt: null, updatedAt: null },
    lastExecution: null,
    lastExecutionResult: null,
    lastOrderIds: [],
    lastSyncAt: null,
    ...overrides,
  };
}

function trade(overrides = {}) {
  return {
    tradeId: `trade_${Math.random().toString(36).slice(2, 8)}`,
    symbol: 'AAPL',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
    direction: 'short',
    entryPrice: 215.40,
    stopLossPrice: 215.62,
    takeProfit1: 214.97,
    takeProfit2: 214.54,
    quantity: 1,
    result: 'OPEN',
    status: 'OPEN',
    openedAt: '2026-06-20T10:00:00.000Z',
    closedAt: null,
    orderIds: [1001, 1002, 1003],
    ...overrides,
  };
}

async function main() {
  const baseReadiness = readiness();
  const baseOrderPreview = allowedOrderPreview([
    { symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short' },
    { symbol: 'MSFT', strategyId: 'ema_pullback_continuation' },
  ]);
  const verifiedReadiness = readiness({
    status: 'verified',
    blockedReason: 'read_only_session_verified',
    ibApiVerified: true,
    paperAccountVerified: true,
    paperModeVerified: true,
    sessionVerified: true,
    paperAccountId: 'DUQ565596',
    managedAccounts: ['DUQ565596'],
    managedAccountCount: 1,
  });

  process.env.IB_PAPER_EXECUTION_ENABLED = 'false';
  const disabledStatus = await svc.getExecutionStatus({
    readiness: baseReadiness,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(disabledStatus.executionEnabled, false, 'disabled by default');
  assert.equal(disabledStatus.orderSendingBlocked, true, 'blocked when flag is off');
  assert.equal(disabledStatus.liveTradingEnabled, false, 'live trading stays false');
  assert.equal(disabledStatus.can_place_orders, false, 'can_place_orders stays false');
  assert.equal(disabledStatus.actions_allowed, false, 'actions_allowed stays false');
  assert.equal(disabledStatus.blockedReason, 'ib_paper_execution_disabled', 'disabled reason is explicit');
  assert.equal(disabledStatus.safety.live_trading_enabled, false, 'safety flag remains false');

  const disabledSubmit = await svc.submitPaperOrder(candidate(), {
    readiness: baseReadiness,
    orderPreview: baseOrderPreview,
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(disabledSubmit.executionEnabled, false, 'submission disabled when flag is off');
  assert.equal(disabledSubmit.orderSendingBlocked, true, 'submission blocked when flag is off');
  assert.equal(disabledSubmit.blockedReason, 'ib_paper_execution_disabled', 'submission blocked reason is explicit');
  assert.equal(disabledSubmit.submitted, false, 'no order is submitted when flag is off');
  assert.equal(disabledSubmit.liveTradingEnabled, false, 'no live trading in blocked response');

  process.env.IB_PAPER_EXECUTION_ENABLED = 'true';

  const allowedSubmit = await svc.submitPaperOrder(candidate(), {
    readiness: verifiedReadiness,
    orderPreview: baseOrderPreview,
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(allowedSubmit.ok, true);
  assert.equal(allowedSubmit.executionEnabled, true);
  assert.equal(allowedSubmit.orderSendingBlocked, true, 'skipBroker keeps order sending blocked for tests');
  assert.equal(allowedSubmit.submitted, false, 'skipBroker does not submit');
  assert.equal(allowedSubmit.blockedReason, null, 'verified readiness should not block the dry-run');
  assert.equal(allowedSubmit.safety.live_trading_enabled, false, 'live trading safety stays false');
	  assert.equal(allowedSubmit.safety.actions_allowed, false, 'actions safety stays false');
	  assert.equal(allowedSubmit.safety.can_place_orders, false, 'order safety stays false');

	  let legacyPlaceOrderCalls = 0;
	  const legacyBlocked = await svc.submitPaperOrder(candidate(), {
	    readiness: verifiedReadiness,
	    orderPreview: baseOrderPreview,
	    readTrades: () => [],
	    loadState: () => state(),
	    client: {
	      placeOrder() { legacyPlaceOrderCalls += 1; },
	      disconnect() {},
	    },
	  });
	  assert.equal(legacyBlocked.submitted, false, 'legacy submit remains blocked');
	  assert.equal(legacyBlocked.blockedReason, 'legacy_ibkr_submit_disabled');
	  assert.equal(legacyPlaceOrderCalls, 0, 'legacy placeOrder is not reached');

  const cryptoBlocked = await svc.submitPaperOrder(candidate({
    symbol: 'BTCUSDT',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
  }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'BTCUSDT', strategyId: 'vwap_failed_breakout_short' }]),
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(cryptoBlocked.submitted, false);
  assert.equal(cryptoBlocked.blockedReason, 'symbol_not_allowed');

  const qqqBlocked = await svc.submitPaperOrder(candidate({
    symbol: 'QQQ',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
  }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'QQQ', strategyId: 'vwap_failed_breakout_short' }]),
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(qqqBlocked.submitted, false);
  assert.equal(qqqBlocked.blockedReason, 'symbol_not_allowed');

  const etfBlocked = await svc.submitPaperOrder(candidate({
    symbol: 'SPY',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
  }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'SPY', strategyId: 'vwap_failed_breakout_short' }]),
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(etfBlocked.submitted, false);
  assert.equal(etfBlocked.blockedReason, 'symbol_not_allowed');

  const unapprovedStrategy = await svc.submitPaperOrder(candidate({
    strategyId: 'unapproved_strategy',
    strategyName: 'Unapproved Strategy',
  }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short' }]),
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(unapprovedStrategy.submitted, false);
  assert.equal(unapprovedStrategy.blockedReason, 'strategy_not_approved_or_not_allowed');

  const missingStop = await svc.submitPaperOrder(candidate({ stopLossPrice: null }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short' }]),
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(missingStop.submitted, false);
  assert.equal(missingStop.blockedReason, 'missing_stop_loss');

  const stopBelowMin = await svc.submitPaperOrder(candidate({ stopLossPrice: 215.50 }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short' }]),
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(stopBelowMin.submitted, false);
  assert.equal(stopBelowMin.blockedReason, 'stop_loss_below_minimum');

  const missingTp = await svc.submitPaperOrder(candidate({ takeProfit1: null }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short' }]),
    skipBroker: true,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(missingTp.submitted, false);
  assert.equal(missingTp.blockedReason, 'missing_take_profit');

  const today = new Date().toISOString().slice(0, 10);
  const dailyQuotaBlocked = await svc.submitPaperOrder(candidate({
    symbol: 'MSFT',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
  }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'MSFT', strategyId: 'ema_pullback_continuation' }]),
    skipBroker: true,
    readTrades: () => [
	      trade({ tradeId: 't1', symbol: 'AAPL', strategyId: 's1', openedAt: `${today}T09:00:00.000Z`, result: 'CLOSED', closedAt: `${today}T10:00:00.000Z` }),
	      trade({ tradeId: 't2', symbol: 'MSFT', strategyId: 's2', openedAt: `${today}T09:30:00.000Z`, result: 'CLOSED', closedAt: `${today}T10:30:00.000Z` }),
	      trade({ tradeId: 't3', symbol: 'NVDA', strategyId: 's3', openedAt: `${today}T11:00:00.000Z`, result: 'CLOSED', closedAt: `${today}T12:00:00.000Z` }),
    ],
    loadState: () => state(),
  });
  assert.equal(dailyQuotaBlocked.submitted, false);
  assert.equal(dailyQuotaBlocked.blockedReason, 'max_3_trades_per_day_reached');

  const openQuotaBlocked = await svc.submitPaperOrder(candidate({
    symbol: 'MSFT',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
  }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'MSFT', strategyId: 'ema_pullback_continuation' }]),
    skipBroker: true,
    readTrades: () => [
      trade({ tradeId: 'o1', symbol: 'AAPL', strategyId: 'o1', openedAt: '2026-06-19T09:00:00.000Z', result: 'OPEN', status: 'OPEN' }),
      trade({ tradeId: 'o2', symbol: 'MSFT', strategyId: 'o2', openedAt: '2026-06-19T09:30:00.000Z', result: 'OPEN', status: 'OPEN' }),
      trade({ tradeId: 'o3', symbol: 'NVDA', strategyId: 'o3', openedAt: '2026-06-19T11:00:00.000Z', result: 'OPEN', status: 'OPEN' }),
    ],
    loadState: () => state(),
  });
  assert.equal(openQuotaBlocked.submitted, false);
  assert.equal(openQuotaBlocked.blockedReason, 'max_open_trades_reached');

  const singletonBlocked = await svc.submitPaperOrder(candidate({
    symbol: 'MSFT',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
  }), {
    readiness: baseReadiness,
    orderPreview: allowedOrderPreview([{ symbol: 'MSFT', strategyId: 'ema_pullback_continuation' }]),
    skipBroker: true,
    readTrades: () => [
      trade({ tradeId: 's1', symbol: 'MSFT', strategyId: 'ema_pullback_continuation', openedAt: '2026-06-19T09:00:00.000Z', result: 'OPEN', status: 'OPEN' }),
    ],
    loadState: () => state(),
  });
  assert.equal(singletonBlocked.submitted, false);
  assert.equal(singletonBlocked.blockedReason, 'one_trade_per_strategy_active');

  const killSwitchBlocked = await svc.submitPaperOrder(candidate({
    symbol: 'AAPL',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
  }), {
    readiness: baseReadiness,
    orderPreview: baseOrderPreview,
    skipBroker: true,
    readTrades: () => [
      trade({ tradeId: 'l1', result: 'LOSS', closedAt: '2026-06-20T12:00:00.000Z', openedAt: '2026-06-20T11:00:00.000Z' }),
      trade({ tradeId: 'l2', result: 'LOSS', closedAt: '2026-06-20T13:00:00.000Z', openedAt: '2026-06-20T12:00:00.000Z' }),
      trade({ tradeId: 'l3', result: 'LOSS', closedAt: '2026-06-20T14:00:00.000Z', openedAt: '2026-06-20T13:00:00.000Z' }),
    ],
    loadState: () => state({ killSwitch: { active: false, reason: null, triggeredAt: null, updatedAt: null } }),
  });
  assert.equal(killSwitchBlocked.submitted, false);
  assert.equal(killSwitchBlocked.blockedReason, 'kill_switch_active');
  assert.equal(svc.calculateLossStreak([
    trade({ tradeId: 'l1', result: 'LOSS', closedAt: '2026-06-20T12:00:00.000Z' }),
    trade({ tradeId: 'l2', result: 'LOSS', closedAt: '2026-06-20T13:00:00.000Z' }),
    trade({ tradeId: 'l3', result: 'LOSS', closedAt: '2026-06-20T14:00:00.000Z' }),
  ]), true, 'three closed losses trigger the kill switch');

  const status = await svc.getExecutionStatus({
    readiness: baseReadiness,
    readTrades: () => [],
    loadState: () => state(),
  });
  assert.equal(status.executionEnabled, true);
  assert.equal(status.orderSendingBlocked, true);
  assert.equal(status.liveTradingEnabled, false);
  assert.equal(status.can_place_orders, false);
  assert.equal(status.actions_allowed, false);
  assert.equal(status.gatewayReachable, true);
  assert.equal(status.ibApiVerified, false);
  assert.equal(status.paperAccountVerified, false);
  assert.equal(status.blockedReason, 'ib_api_not_verified');
  assert.ok(status.blockers.includes('ib_api_not_verified'));
  assert.ok(status.blockers.includes('paper_account_not_verified'));

  const bracket = svc.buildBracketOrders(candidate(), 9001);
  assert.equal(bracket.parentOrder.orderType, 'LMT', 'parent entry must be a limit order');
  assert.equal(bracket.takeProfitOrder.orderType, 'LMT', 'take profit must be a limit order');
  assert.equal(bracket.stopLossOrder.orderType, 'STP', 'stop loss must be a stop order');
  assert.notEqual(bracket.parentOrder.orderType, 'MKT', 'no market order without stop');

  const serverSource = fs.readFileSync(path.join('/var/www/nasdaq-scanner-prod', 'server.js'), 'utf8');
	  assert.match(serverSource, /app\.use\('\/api', apiLimiter, requireTradingOsApiAuth, requireTradingOsCsrf, apiRouter\)/, 'API mutations stay behind existing auth and CSRF middleware');
  const routeSource = fs.readFileSync(path.join('/var/www/nasdaq-scanner-prod', 'src/routes/api.js'), 'utf8');
  [
    "router.post('/interactive-brokers/paper-execute'",
    "router.post('/interactive-brokers/paper-execute/arm'",
    "router.get('/interactive-brokers/paper-execute/arm-status'",
    "router.get('/interactive-brokers/paper-execute/final-gate-status'",
    "router.post('/interactive-brokers/paper-execute/protective-preflight'",
    "router.post('/interactive-brokers/paper-execute/submit'",
  ].forEach((needle) => {
    assert.ok(routeSource.includes(needle), `${needle} is production-mounted`);
  });
  assert.match(routeSource, /defaultIbPaperExecutionOrchestratorService\.buildShadowExecution/, 'paper-execute submit facade uses the runtime singleton orchestrator');
  assert.doesNotMatch(routeSource, /interactiveBrokersPaperOneShotExecutionService/, 'production paper-execute route does not mount the deprecated one-shot submit service');

  console.log('interactiveBrokersPaperExecutionService.test.js: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
