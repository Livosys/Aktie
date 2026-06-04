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

  const statusAfterCancel = queue.getStatus();
  assert.equal(statusAfterCancel.summary.pending, 0, 'pending zero');
  assert.equal(statusAfterCancel.summary.cancelled, 1, 'cancelled one');
  assert.equal(statusAfterCancel.items[0].status, 'cancelled', 'current status cancelled');
}

{
  const invalid = queue.addFromRecommendation({
    strategy_id: 'TV_E2E_SUPERVISOR_TEST_V1',
    test_type: 'execute_now',
  });
  assert.equal(invalid.ok, false, 'invalid add rejected');
  assert.equal(invalid.error, 'invalid_test_type', 'invalid test type error');
}

console.log('Manual test queue tests passed.');
