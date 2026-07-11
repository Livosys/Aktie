'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-strategy-approval-'));
process.env.PAPER_STRATEGY_APPROVALS_FILE = path.join(tmpDir, 'strategy-approvals.json');
fs.writeFileSync(process.env.PAPER_STRATEGY_APPROVALS_FILE, JSON.stringify({
  schemaVersion: 1,
  strategies: {},
  selectedByFamily: {},
  updatedAt: '2026-07-11T00:00:00.000Z',
}, null, 2));

const svc = require('./paperStrategyApprovalService');

function safety(result) {
  assert.equal(result.mode, 'paper_only');
  assert.equal(result.actions_allowed, false);
  assert.equal(result.can_place_orders, false);
  assert.equal(result.live_trading_enabled, false);
  assert.equal(result.broker_enabled, false);
}

function rowById(list, id) {
  return list.strategies.find((row) => row.strategyId === id);
}

function main() {
  svc.__resetLastKnownGood();

  const first = svc.listStrategies();
  safety(first);
  assert.equal(first.summary.approved, 0);
  assert.equal(first.summary.tradable, 0);

  const approvedNarrow = svc.approve('narrow_breakout', { source: 'test' });
  assert.equal(approvedNarrow.ok, true);
  assert.equal(approvedNarrow.status, 'approved');
  assert.equal(approvedNarrow.selectedStrategyId, 'narrow_breakout');
  safety(approvedNarrow);

  const afterFirst = svc.listStrategies();
  assert.ok(afterFirst.tradableStrategyIds.includes('narrow_breakout'));
  assert.equal(rowById(afterFirst, 'narrow_breakout').familySelection.tradable, true);

  const approvedFakeout = svc.approve('narrow_fakeout_reversal_v1', { source: 'test' });
  assert.equal(approvedFakeout.ok, true);
  assert.equal(approvedFakeout.previousSelectedStrategyId, 'narrow_breakout');

  const afterSecond = svc.listStrategies();
  const narrowBreakout = rowById(afterSecond, 'narrow_breakout');
  const fakeout = rowById(afterSecond, 'narrow_fakeout_reversal_v1');
  assert.equal(narrowBreakout.approval.status, 'approved');
  assert.equal(narrowBreakout.familySelection.selected, false);
  assert.equal(narrowBreakout.familySelection.tradable, false);
  assert.equal(narrowBreakout.familySelection.blocker, svc.GATE_REASON.FAMILY_NOT_SELECTED);
  assert.equal(fakeout.familySelection.selected, true);
  assert.equal(fakeout.familySelection.tradable, true);
  assert.deepEqual(afterSecond.tradableStrategyIds, ['narrow_fakeout_reversal_v1']);

  const blockedByFamily = svc.evaluatePaperApprovalGate({ strategyId: 'narrow_breakout' });
  assert.equal(blockedByFamily.allowed, false);
  assert.equal(blockedByFamily.blockedReason, svc.GATE_REASON.FAMILY_NOT_SELECTED);

  const allowedFakeout = svc.evaluatePaperApprovalGate({ strategyId: 'narrow_fakeout_reversal_v1' });
  assert.equal(allowedFakeout.allowed, true);

  const removed = svc.remove('narrow_fakeout_reversal_v1', { source: 'test' });
  assert.equal(removed.ok, true);
  assert.equal(removed.status, 'removed');
  const afterRemove = svc.listStrategies();
  assert.equal(rowById(afterRemove, 'narrow_fakeout_reversal_v1').approval.status, 'removed');
  assert.equal(svc.evaluatePaperApprovalGate({ strategyId: 'narrow_fakeout_reversal_v1' }).blockedReason, svc.GATE_REASON.REMOVED);
  assert.equal(afterRemove.tradableStrategyIds.length, 0);

  const notReady = svc.approve('crypto_momentum_scalper', { source: 'test' });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.code, 422);
  assert.match(notReady.reason, /^not_approvable_/);

  console.log('# paperStrategyApprovalService tests passed.');
}

main();
