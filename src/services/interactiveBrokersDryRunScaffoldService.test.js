'use strict';

const assert = require('assert/strict');
const previewSvc = require('./interactiveBrokersPreviewService');
const scaffoldSvc = require('./interactiveBrokersDryRunScaffoldService');

async function run() {
  const orderPreview = previewSvc.getIbPaperOrderPreview({
    candidates: [
      {
        symbol: 'AAPL',
        canonicalStrategyId: 'vwap_failed_breakout_short',
        strategyName: 'VWAP Failed Breakout Short',
        direction: 'short',
        source: 'scanner',
        score: 91,
        confidence: 88,
      },
      {
        symbol: 'QQQ',
        canonicalStrategyId: 'narrow_breakout',
        strategyName: 'Narrow Breakout',
        direction: 'long',
        source: 'scanner',
        score: 80,
        confidence: 80,
      },
    ],
  });

  const scaffold = await scaffoldSvc.buildDryRunExecutionScaffold({
    orderPreview,
    readiness: {
      ok: true,
      dryRun: true,
      status: 'reachable',
      gatewayReachable: true,
      blockedReason: 'reachable_read_only_no_orders',
    },
    approvedStrategiesPreview: previewSvc.getApprovedStrategiesPreview(),
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
  assert.equal(scaffold.summary.approvedStrategyCount, 5);
  assert.ok(Array.isArray(scaffold.candidateBlueprints));
  assert.equal(scaffold.candidateBlueprints.length, 2);
  assert.equal(scaffold.primaryCandidate.symbol, 'AAPL');
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
