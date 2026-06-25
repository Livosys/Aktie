'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersTradeBlueprintService');

function candidate(overrides = {}) {
  return {
    symbol: 'AAPL',
    strategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    direction: 'short',
    marketGroup: 'stocks',
    allowedForIbPaperPreview: true,
    ...overrides,
  };
}

async function run() {
  const verifiedReadiness = {
    ok: true,
    dryRun: true,
    status: 'verified',
    gatewayReachable: true,
    host: '127.0.0.1',
    port: 4002,
    portConfigured: true,
    clientIdConfigured: true,
    paperMode: 'paper_only',
    paperModeVerified: true,
    ibApiVerified: true,
    paperAccountVerified: true,
    paperAccountId: 'DUQ565596',
    managedAccounts: ['DUQ565596'],
    managedAccountCount: 1,
    sessionVerified: true,
    blockedReason: 'read_only_session_verified',
  };
  const result = await svc.getTradeBlueprint({
    skipRedis: true,
    readiness: verifiedReadiness,
    topStrategies: {
      topStrategies: [
        { strategyId: 'vwap_failed_breakout_short', rank: 1 },
        { strategyId: 'ema_pullback_continuation', rank: 2 },
      ],
    },
    orderPreview: {
      allowedCandidates: [
        candidate({ symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short', strategyName: 'VWAP Failed Breakout Short', direction: 'short' }),
        candidate({ symbol: 'MSFT', strategyId: 'ema_pullback_continuation', strategyName: 'EMA Pullback Continuation', direction: 'long' }),
      ],
      source: { approvedStrategyCount: 5 },
    },
    priceIndex: {
      AAPL: 215.40,
      MSFT: 300.00,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'trade_blueprint');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.orderQueueEnabled, false);
  assert.equal(result.brokerExecutionEnabled, false);
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.orderSendingBlocked, true);
  assert.equal(result.wouldCreateOrder, false);
  assert.equal(result.requiredStopLossMinPct, 0.10);
  assert.ok(Array.isArray(result.blueprints));
  assert.equal(result.blueprints.length, 2);
  assert.equal(result.summary.totalCandidates, 2);
  assert.equal(result.summary.blueprintReadyCount, 2);
  assert.equal(result.summary.manualApprovalReadyCount, 2);
  assert.equal(result.summary.executionReadyCount, 0);
  assert.equal(result.summary.blockedCount, 0);

  const short = result.blueprints.find((row) => row.symbol === 'AAPL');
  assert.ok(short, 'expected AAPL short blueprint');
  assert.equal(short.blueprintReady, true);
  assert.equal(short.manualApprovalReady, true);
  assert.equal(short.executionReady, false);
  assert.equal(short.blueprintId.startsWith('ibpb_'), true);
  assert.equal(short.accountMode, 'ib_paper');
  assert.equal(short.orderType, 'LMT');
  assert.equal(short.timeInForce, 'DAY');
  assert.equal(short.direction, 'short');
  assert.equal(short.entryReferencePrice, 215.4);
  assert.equal(short.stopLoss, 215.62);
  assert.equal(short.takeProfit1, 214.97);
  assert.equal(short.takeProfit2, 214.54);
  assert.equal(short.stopLossPct, 0.1021);
  assert.equal(short.riskReward, 1.95);
  assert.equal(short.requiredStopLossMinPct, 0.10);
  assert.equal(short.readyForFutureIbPaper, true);
  assert.equal(short.wouldCreateOrder, false);
  assert.equal(short.wouldSendOrder, false);
  assert.equal(short.orderSendingBlocked, true);
  assert.equal(short.executionEnabled, false);
  assert.equal(short.blueprintOnly, true);
  assert.equal(short.quantityStatus, 'calculated');
  assert.equal(short.quantity > 0, true);
  assert.equal(short.quantityBlockers?.length || 0, 0);
  assert.equal(short.blockedReason, 'ib_paper_execution_disabled');
  assert.ok(short.blockers.includes('ib_paper_execution_disabled'));
  assert.ok(short.blockers.includes('order_sending_disabled_phase_3'));
  assert.equal(short.blockers.includes('ib_api_not_verified'), false);
  assert.equal(short.blockers.includes('paper_account_not_verified'), false);
  assert.equal(result.selectedBlueprintId, short.blueprintId);
  assert.equal(result.selectedBlueprintSource, 'trade_blueprint');
  assert.equal(result.selectedBlueprintSafety.safeForArm, true);
  assert.equal(result.selectedBlueprintSafety.safeForSubmit, false);
  assert.equal(result.selectedBlueprintSafety.safetyStatus, 'manual_ready');

  const long = result.blueprints.find((row) => row.symbol === 'MSFT');
  assert.ok(long, 'expected MSFT long blueprint');
  assert.equal(long.direction, 'long');
  assert.equal(long.entryReferencePrice, 300.0);
  assert.equal(long.stopLoss, 299.7);
  assert.equal(long.takeProfit1, 300.6);
  assert.equal(long.takeProfit2, 301.2);
  assert.equal(long.stopLossPct, 0.1);
  assert.equal(long.riskReward, 2.0);
  assert.equal(long.readyForFutureIbPaper, true);
  assert.equal(long.wouldCreateOrder, false);
  assert.equal(long.orderSendingBlocked, true);
  assert.equal(long.executionEnabled, false);
  assert.equal(long.blueprintReady, true);
  assert.equal(long.manualApprovalReady, true);
  assert.equal(long.executionReady, false);
  assert.equal(long.blockers.includes('ib_api_not_verified'), false);
  assert.equal(long.blockers.includes('paper_account_not_verified'), false);

  const blocked = await svc.getTradeBlueprint({
    skipRedis: true,
    readiness: verifiedReadiness,
    orderPreview: {
      allowedCandidates: [
        candidate({
          symbol: 'AAPL',
          strategyId: 'vwap_failed_breakout_short',
          strategyName: 'VWAP Failed Breakout Short',
          direction: 'short',
        }),
      ],
      source: { approvedStrategyCount: 1 },
    },
    priceIndex: {},
  });

  assert.equal(blocked.blueprints.length, 1);
  assert.equal(blocked.blueprints[0].blueprintReady, false);
  assert.equal(blocked.blueprints[0].manualApprovalReady, false);
  assert.equal(blocked.blueprints[0].executionReady, false);
  assert.equal(blocked.blueprints[0].wouldCreateOrder, false);
  assert.equal(blocked.blueprints[0].orderSendingBlocked, true);
  assert.equal(blocked.blueprints[0].executionEnabled, false);
  assert.ok(blocked.blueprints[0].blockedReason.includes('missing_entry'));
  assert.equal(blocked.selectedBlueprintId, null);
  assert.equal(blocked.selectedBlueprint, null);
  assert.equal(blocked.previewBlueprintId, blocked.blueprints[0].blueprintId);
  assert.equal(blocked.selectedBlueprintSafety.blockedReason, 'no_manual_ready_trade_blueprint');

  console.log('interactiveBrokersTradeBlueprintService.test.js: OK');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
