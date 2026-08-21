import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aiStoryCannotContinue,
  aiStoryNoLearnings,
  aiStoryNoTests,
  aiStoryPaperStatus,
  aiStorySystemStatus,
  aiStoryTesting,
  aiStoryWaiting,
  aiStoryFactoryActivity,
} from './aiStoryService.js';

test('AI story service creates short Swedish status text', () => {
  assert.equal(aiStoryTesting('Momentum'), 'AI testar nu Momentum.');
  assert.equal(aiStoryWaiting('det saknas historik'), 'AI väntar eftersom det saknas historik.');
  assert.equal(aiStoryNoLearnings(), 'Inga nya lärdomar ännu.');
  assert.equal(aiStoryNoTests(), 'Inga tester pågår just nu.');
  assert.equal(aiStoryCannotContinue('historik saknas'), 'AI kunde inte fortsätta därför att historik saknas.');
});

test('AI story service summarizes paper and system state without mutating data', () => {
  const paper = aiStoryPaperStatus({
    strategyId: 'Momentum',
    result: 1250,
    approvalCount: 2,
    reason: 'väntar på granskning',
  });
  assert.ok(paper.headline);
  assert.ok(paper.why);
  assert.ok(paper.next);
  assert.equal(typeof paper.state, 'string');

  const system = aiStorySystemStatus({
    overallStatus: 'healthy',
    summarySv: 'Systemet mår bra.',
    components: [{ status: 'ON' }],
  });
  assert.ok(system.headline);
  assert.ok(system.subline);
  assert.ok(system.why);
  assert.ok(system.next);
});

test('aiStoryFactoryActivity items must have kind field (regression: localeCompare crash)', () => {
  // 2026-08-21: FactoryDashboardPage crashed with "Cannot read properties of undefined
  // (reading 'localeCompare')" when sorting items by kind. Root cause: aiStoryFactoryActivity
  // returned items without kind field. Fix: add kind: item.id.
  const snapshot = {
    latestRunningJob: {
      strategyId: 'test_strategy',
      started_at: '2026-08-21T10:00:00Z',
    },
    latestReplay: {
      row: {
        strategyId: 'test_strategy',
        result: 'PASS',
      },
      stamp: { value: '2026-08-21T10:05:00Z' },
    },
    candidateEntry: {
      row: { strategyId: 'test_strategy' },
      stamp: { value: '2026-08-21T10:10:00Z' },
    },
    paperEntry: {
      row: { strategyId: 'test_strategy' },
      stamp: { value: '2026-08-21T10:15:00Z' },
    },
    marketPeriod: {
      row: 'MNQ',
      stamp: { value: '2026-08-21T10:20:00Z' },
    },
    latestLearning: {
      row: { reason: 'test reason' },
      stamp: { value: '2026-08-21T10:25:00Z' },
    },
    latestImprovement: {
      row: { strategyId: 'test_strategy', reason: 'test' },
      stamp: { value: '2026-08-21T10:30:00Z' },
    },
    lastRefreshAt: '2026-08-21T10:30:00Z',
  };

  const items = aiStoryFactoryActivity(snapshot);

  // Every item must have both id and kind fields.
  for (const item of items) {
    assert.ok(item.id, `item missing id field: ${JSON.stringify(item)}`);
    assert.ok(item.kind !== undefined, `item missing kind field: ${JSON.stringify(item)}`);
    assert.equal(item.kind, item.id, `kind should match id for item ${item.id}`);
  }

  // Sorting by kind must not crash (the original crash happened here).
  const sorted = items.sort((a, b) => a.kind.localeCompare(b.kind));
  assert.ok(sorted.length > 0, 'sorted array should have items');

  // Empty/null snapshot should also not crash.
  const emptyItems = aiStoryFactoryActivity({});
  assert.ok(Array.isArray(emptyItems), 'empty snapshot returns array');
  assert.equal(emptyItems.length, 0, 'empty snapshot returns empty array');
});
