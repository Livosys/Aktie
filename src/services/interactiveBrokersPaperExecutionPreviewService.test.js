'use strict';

const assert = require('assert/strict');
const previewSvc = require('./interactiveBrokersPaperExecutionPreviewService');
const bracketSvc = require('./interactiveBrokersPaperBracketSubmissionService');

const readiness = {
  ok: true,
  source: 'live_connection_readiness',
  gatewayReachable: true,
  ibApiVerified: true,
  paperAccountVerified: true,
  paperModeVerified: true,
  sessionVerified: true,
  paperAccountId: 'DUQ565596',
  managedAccounts: ['DUQ565596'],
  nextValidId: 101,
};

const selectedBlueprint = {
  blueprintId: 'bp-preview-only-1',
  candidateId: 'cand-preview-only-1',
  symbol: 'AAPL',
  strategyId: 'narrow_breakout',
  strategyName: 'Narrow Breakout',
  direction: 'long',
  side: 'BUY',
  quantity: 1,
  entryReferencePrice: 200,
  stopLoss: 199.7,
  takeProfit: 201,
  marketGroup: 'stock',
  account: 'DUQ565596',
  accountMode: 'ib_paper',
  stopLossPct: 0.15,
  riskReward: 3,
  riskPct: 1,
  riskAmount: 100,
  quantityStatus: 'calculated',
  estimatedNotional: 200,
  blueprintReady: true,
  manualApprovalReady: true,
  executionReady: false,
  expiresAt: '2026-06-25T23:59:00.000Z',
};

const executionStatus = {
  ok: true,
  executionEnabled: true,
  orderSendingBlocked: false,
  liveTradingEnabled: false,
  can_place_orders: false,
  actions_allowed: false,
  broker_enabled: false,
  blockers: [],
  blockedReason: null,
  readiness,
  dailyQuota: { used: 0, max: 3, remaining: 3 },
  openTrades: [],
  openTradeCount: 0,
  killSwitch: { active: false, reason: null },
  config: { enabled: true, host: '127.0.0.1', port: 4002, clientId: 1 },
};

const truth = {
  ok: true,
  mode: 'paper_only',
  topStrategies: {
    ok: true,
    topStrategies: [
      { rank: 1, strategyId: 'narrow_breakout', name: 'Narrow Breakout', readyForIbPaper: true },
    ],
  },
  ibPaper: {
    connectionReadiness: readiness,
    readiness,
    executionStatus,
  },
};

async function main() {
  let submitCalled = false;
  let placeOrderCalled = false;
  const originalSubmit = bracketSvc.submitBracketOrderGroup;
  bracketSvc.submitBracketOrderGroup = async () => {
    submitCalled = true;
    throw new Error('submitBracketOrderGroup must not be called by preview');
  };

  try {
    const result = await previewSvc.buildPaperExecutionPreview({
      now: '2026-06-25T13:55:00.000Z',
      body: {
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 1,
        selectedBlueprint,
        confirmationPhrase: 'CONFIRM PAPER TRADE',
      },
      deps: {
        buildPaperTradingTruth: async () => truth,
        buildExecutionStatus: async () => executionStatus,
        loadLiveIbPaperReadinessForPreflight: async () => readiness,
        getTradeBlueprint: async () => ({
          ok: true,
          selectedBlueprint,
          blueprints: [selectedBlueprint],
          manualApproval: { approvalStatus: 'waiting_for_user' },
        }),
      },
      placeOrder: () => {
        placeOrderCalled = true;
      },
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.orderSent, false);
    assert.equal(result.wouldPlaceOrder, false);
    assert.equal(result.placeOrderCalled, false);
    assert.equal(result.realSubmitAllowed, false);
    assert.equal(result.allowRealSubmit, false);
    assert.equal(result.finalGateArmCreated, false);
    assert.equal(result.submitFunctionCalled, false);
    assert.equal(submitCalled, false);
    assert.equal(placeOrderCalled, false);
    assert.equal(result.safety.actions_allowed, false);
    assert.equal(result.safety.can_place_orders, false);
    assert.equal(result.safety.live_trading_enabled, false);
    assert.equal(result.safety.broker_enabled, false);
    assert.equal(result.requestedOrder.formatValid, true);
  } finally {
    bracketSvc.submitBracketOrderGroup = originalSubmit;
  }
}

main()
  .then(() => {
    console.log('interactiveBrokersPaperExecutionPreviewService tests passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
