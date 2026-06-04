'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createManualTestQueueService } = require('./manualTestQueueService');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-test-queue-'));
const queueFile = path.join(tmpDir, 'manual-test-queue.jsonl');

const queue = createManualTestQueueService({ queueFile });

{
  const added = queue.addFromRecommendation({
    strategy_id: 'TV_E2E_SUPERVISOR_TEST_V1',
    test_type: 'replay',
    priority: 10,
    reason: 'Testing queue',
    suggested_scope: 'Small scope',
    expected_learning_value: 'High',
    safety_note: 'Read-only',
  });

  assert.equal(added.ok, true, 'add ok');
  assert.equal(added.item.status, 'pending', 'item pending');
  assert.equal(added.item.mode, 'paper_only', 'paper only');
  assert.equal(added.actions_allowed, false, 'safety actions');

  const statusAfterAdd = queue.getStatus();
  assert.equal(statusAfterAdd.summary.pending, 1, 'pending count');
  assert.equal(statusAfterAdd.summary.completed, 0, 'completed count');
  assert.equal(statusAfterAdd.summary.cancelled, 0, 'cancelled count');
  assert.equal(statusAfterAdd.summary.failed, 0, 'failed count');
  assert.equal(statusAfterAdd.items.length, 1, 'one item');
  assert.equal(statusAfterAdd.items[0].strategy_id, 'TV_E2E_SUPERVISOR_TEST_V1', 'strategy id');
  assert.equal(statusAfterAdd.items[0].source, 'planner', 'source planner');

  const cancelled = queue.cancelQueueItem(added.item.id);
  assert.equal(cancelled.ok, true, 'cancel ok');
  assert.equal(cancelled.cancelled, true, 'cancelled flag');
  assert.equal(cancelled.item.status, 'cancelled', 'cancelled status');
  assert.equal(cancelled.actions_allowed, false, 'cancel safety');

  const cancelledAgain = queue.cancelQueueItem(added.item.id);
  assert.equal(cancelledAgain.ok, false, 'second cancel rejected');
  assert.equal(cancelledAgain.error, 'queue_item_not_pending', 'second cancel error');

  const statusAfterCancel = queue.getStatus();
  assert.equal(statusAfterCancel.summary.pending, 0, 'pending zero');
  assert.equal(statusAfterCancel.summary.cancelled, 1, 'cancelled one');
  assert.equal(statusAfterCancel.items[0].status, 'cancelled', 'current status cancelled');
}

{
  const duplicateSeed = queue.addFromRecommendation({
    strategy_id: 'TV_DUPLICATE_TEST',
    test_type: 'history_review',
    suggested_scope: 'same scope',
    reason: 'seed',
  });
  assert.equal(duplicateSeed.ok, true, 'duplicate seed added');

  const duplicate = queue.addFromRecommendation({
    strategy_id: 'TV_DUPLICATE_TEST',
    test_type: 'history_review',
    suggested_scope: 'same scope',
    reason: 'duplicate should not be added',
  });
  assert.equal(duplicate.ok, true, 'duplicate add ok');
  assert.equal(duplicate.duplicate, true, 'duplicate flagged');
  assert.equal(duplicate.item.id, duplicateSeed.item.id, 'duplicate returns existing item');

  const invalid = queue.addFromRecommendation({
    strategy_id: 'TV_E2E_SUPERVISOR_TEST_V1',
    test_type: 'execute_now',
  });
  assert.equal(invalid.ok, false, 'invalid add rejected');
  assert.equal(invalid.error, 'invalid_test_type', 'invalid test type error');
}

{
  const longStrategyId = 'X'.repeat(200);
  const longText = 'Y'.repeat(600);
  const bounded = queue.addFromRecommendation({
    strategy_id: longStrategyId,
    test_type: 'paper_observation',
    reason: longText,
    suggested_scope: longText,
    expected_learning_value: longText,
    safety_note: longText,
  });
  assert.equal(bounded.ok, true, 'bounded add ok');
  assert.equal(bounded.item.strategy_id.length <= 120, true, 'strategy id bounded');
  assert.equal(bounded.item.reason.length <= 500, true, 'reason bounded');
  assert.equal(bounded.item.suggested_scope.length <= 500, true, 'scope bounded');
  assert.equal(bounded.item.expected_learning_value.length <= 500, true, 'learning bounded');
  assert.equal(bounded.item.safety_note.length <= 500, true, 'safety bounded');
}

{
  const limitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-test-queue-limit-'));
  const limitQueue = createManualTestQueueService({ queueFile: path.join(limitDir, 'manual-test-queue.jsonl') });
  for (let i = 0; i < 25; i += 1) {
    const result = limitQueue.addFromRecommendation({
      strategy_id: `TV_LIMIT_${i}`,
      test_type: 'replay',
      suggested_scope: `scope-${i}`,
    });
    assert.equal(result.ok, true, `seed ${i} added`);
  }
  const overflow = limitQueue.addFromRecommendation({
    strategy_id: 'TV_LIMIT_OVERFLOW',
    test_type: 'replay',
    suggested_scope: 'scope-overflow',
  });
  assert.equal(overflow.ok, false, 'overflow rejected');
  assert.equal(overflow.error, 'manual_test_queue_pending_limit_reached', 'limit error');
}

{
  const status = queue.getStatus();
  assert.equal(Array.isArray(status.pending_items), true, 'pending_items present');
  assert.equal(Array.isArray(status.recent_items), true, 'recent_items present');
}

console.log('Manual test queue tests passed.');
