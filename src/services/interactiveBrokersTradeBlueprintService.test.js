'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersTradeBlueprintService');

function previewCandidate(overrides = {}) {
  return {
    blueprintId: 'ibpb-ready',
    candidateId: 'cand-1',
    symbol: 'MNQ',
    root: 'MNQ',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    direction: 'long',
    side: 'BUY',
    marketGroup: 'futures',
    assetClass: 'FUT',
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    quantity: 1,
    quantityStatus: 'calculated',
    entryReferencePrice: 23000,
    entryPrice: 23000,
    stopLoss: 22980,
    takeProfit: 23040,
    riskReward: 2,
    riskPct: 0.25,
    allowedForIbPaperPreview: true,
    blueprintReady: true,
    executionReady: true,
    wouldCreateOrder: false,
    wouldSendOrder: false,
    orderSendingBlocked: true,
    bracket: {
      ok: true,
      orderCount: 3,
      transmitSequence: ['entry:false', 'takeProfit:false', 'stopLoss:true'],
    },
    blockers: [],
    ...overrides,
  };
}

async function run() {
  const result = await svc.getTradeBlueprint({
    executionPreview: {
      ok: true,
      source: 'execution_runtime_pipeline_preview',
      executionEnabled: false,
      brokerExecutionEnabled: false,
      readiness: {
        gatewayReachable: true,
        ibApiVerified: true,
        paperAccountVerified: true,
      },
      allCandidates: [
        previewCandidate(),
        previewCandidate({
          blueprintId: 'ibpb-native-mnq',
          candidateId: 'cand-native-mnq',
          strategyId: 'mnq_globex_momentum_v1',
          strategyName: 'MNQ Globex Momentum',
        }),
        previewCandidate({
          blueprintId: 'ibpb-blocked',
          candidateId: 'cand-2',
          strategyId: 'disabled_strategy',
          allowedForIbPaperPreview: false,
          blueprintReady: false,
          executionReady: false,
          blockedReason: 'strategy_not_in_execution_allowlist',
          blockers: ['strategy_not_in_execution_allowlist'],
        }),
      ],
      summary: { previewSource: 'futuresPaperScannerService.getCandidates' },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'trade_blueprint');
  assert.equal(result.source, 'execution_runtime_pipeline');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.orderQueueEnabled, false);
  assert.equal(result.brokerExecutionEnabled, false);
  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.orderSendingBlocked, true);
  assert.equal(result.wouldCreateOrder, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'manualApproval'), false);
  assert.equal(result.blueprints.length, 3);
  assert.equal(result.summary.totalCandidates, 3);
  assert.equal(result.summary.blueprintReadyCount, 2);
  assert.equal(result.summary.executionReadyCount, 2);
  assert.equal(result.summary.blockedCount, 1);
  assert.deepEqual(result.summary.pipeline, ['execution_runtime', 'strategy_registry', 'risk', 'entry_contract', 'bracket_plan']);

  const selected = result.selectedBlueprint;
  assert.ok(selected, 'expected selected pipeline-ready blueprint');
  assert.equal(selected.blueprintId, 'ibpb-ready');
  assert.equal(selected.source, 'execution_runtime_pipeline');
  assert.equal(selected.blueprintReady, true);
  assert.equal(selected.executionReady, true);
  assert.equal(selected.bracketPlanReady, true);
  assert.equal(selected.wouldCreateOrder, false);
  assert.equal(selected.wouldSendOrder, false);
  assert.equal(selected.wouldCreateIbPaperOrder, false);
  assert.equal(selected.orderSendingBlocked, true);
  assert.equal(Object.prototype.hasOwnProperty.call(selected, 'manualApprovalReady'), false);
  assert.equal(result.selectedBlueprintSource, 'execution_runtime_pipeline');
  assert.equal(result.selectedBlueprintSafety.safeForArm, true);
  assert.equal(result.selectedBlueprintSafety.safeForSubmit, false);
  assert.equal(result.selectedBlueprintSafety.safetyStatus, 'pipeline_ready_read_only');

  const blocked = result.blueprints.find((row) => row.strategyId === 'disabled_strategy');
  assert.equal(blocked.blueprintReady, false);
  assert.equal(blocked.executionReady, false);
  assert.equal(blocked.blockedReason, 'strategy_not_in_execution_allowlist');
  assert.ok(blocked.blockers.includes('strategy_not_in_execution_allowlist'));

  const native = result.blueprints.find((row) => row.strategyId === 'mnq_globex_momentum_v1');
  assert.ok(native, 'expected native MNQ blueprint from same preview pipeline');
  assert.equal(native.blueprintReady, true);
  assert.equal(native.executionReady, true);
  assert.equal(native.source, 'execution_runtime_pipeline');

  const empty = await svc.getTradeBlueprint({
    executionPreview: {
      ok: true,
      allCandidates: [],
      readiness: {},
      summary: { previewSource: 'test' },
    },
  });
  assert.equal(empty.selectedBlueprint, null);
  assert.equal(empty.selectedBlueprintSafety.blockedReason, 'no_execution_pipeline_ready_blueprint');

  console.log('interactiveBrokersTradeBlueprintService.test.js: OK');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
