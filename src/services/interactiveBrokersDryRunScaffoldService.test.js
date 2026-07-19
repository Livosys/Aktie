'use strict';

const assert = require('assert/strict');
const scaffoldSvc = require('./interactiveBrokersDryRunScaffoldService');

async function run() {
  const readyCandidate = {
    symbol: 'MNQ',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    direction: 'long',
    marketGroup: 'futures',
    allowedForIbPaperPreview: true,
    blockers: [],
    reasonSv: 'Read-only pipeline ready.',
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
  };
  const blockedCandidate = {
    symbol: 'MNQ',
    strategyId: 'disabled_strategy',
    strategyName: 'Disabled Strategy',
    direction: 'long',
    marketGroup: 'futures',
    allowedForIbPaperPreview: false,
    blockers: ['strategy_not_in_execution_allowlist'],
    reasonSv: 'Blockerad: strategy_not_in_execution_allowlist',
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
  };
  const orderPreview = {
    ok: true,
    mode: 'preview_only',
    candidates: [readyCandidate, blockedCandidate],
    allowedCandidates: [readyCandidate],
    blockedCandidates: [blockedCandidate],
    summary: {
      totalScanned: 2,
      allowedCandidates: 1,
      blockedCandidates: 1,
    },
  };

  const scaffold = await scaffoldSvc.buildDryRunExecutionScaffold({
    orderPreview,
    readiness: {
      ok: true,
      dryRun: true,
      status: 'reachable',
      gatewayReachable: true,
      blockedReason: 'reachable_read_only_no_orders',
    },
    registryPreview: {
      ok: true,
      registryStrategyCount: 5,
      registryStrategies: Array.from({ length: 5 }, (_, index) => ({ strategy_id: `strategy_${index}`, status: 'active', enabled: true })),
    },
  });

  assert.equal(scaffold.ok, true);
  assert.equal(scaffold.dryRun, true);
  assert.equal(scaffold.mode, 'dry_run_execution_scaffold');
  assert.equal(scaffold.phase, 'scaffold_only');
  assert.equal(scaffold.executionEnabled, false);
  assert.equal(scaffold.orderQueueEnabled, false);
  assert.equal(scaffold.liveTradingEnabled, false);
  assert.equal(scaffold.orderSendingBlocked, true);
  assert.equal(scaffold.wouldCreateIbPaperOrder, false);
  assert.ok(Array.isArray(scaffold.steps));
  assert.equal(scaffold.steps.length, 4);
  assert.equal(scaffold.summary.allowedCount, orderPreview.allowedCandidates.length);
  assert.equal(scaffold.summary.blockedCount, orderPreview.blockedCandidates.length);
  assert.equal(scaffold.summary.registryStrategyCount, 5);
  assert.ok(Array.isArray(scaffold.candidateBlueprints));
  assert.equal(scaffold.candidateBlueprints.length, 2);
  assert.equal(scaffold.primaryCandidate.symbol, 'MNQ');
  assert.equal(scaffold.primaryCandidate.wouldCreateIbPaperOrder, false);
  assert.equal(scaffold.primaryCandidate.orderSendingBlocked, true);

  for (const step of scaffold.steps) {
    assert.equal(step.executionEnabled, false);
    assert.equal(step.orderQueueEnabled, false);
    assert.equal(step.liveTradingEnabled, false);
    assert.equal(step.orderSendingBlocked, true);
    assert.equal(step.wouldCreateIbPaperOrder, false);
  }

  console.log('interactiveBrokersDryRunScaffoldService.test.js: OK');
}

run();
