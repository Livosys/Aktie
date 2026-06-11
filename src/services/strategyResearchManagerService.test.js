'use strict';

const assert = require('assert/strict');
const manager = require('./strategyResearchManagerService');
const { detectStagnation, compareRecommendations, makeRecommendation } = manager._internal;

function assertSafety(s, label) {
  assert.deepEqual(s, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  }, `${label} safety exact match`);
}

function testContract() {
  const r = manager.buildStrategyResearch();

  assert.ok(r && typeof r === 'object', 'returns object');
  assert.ok(['ok', 'empty', 'degraded', 'error'].includes(r.status), 'status valid');
  assert.equal(r.mode, 'dry_run', 'mode dry_run');
  assert.ok(typeof r.lastRun === 'string' && r.lastRun.length > 0, 'lastRun iso');
  assert.ok(Array.isArray(r.recommendations), 'recommendations array');
  assert.ok('topRecommendation' in r, 'topRecommendation present');
  assert.equal(typeof r.requiresApprovalCount, 'number', 'requiresApprovalCount number');
  assert.equal(typeof r.paperEligibleCount, 'number', 'paperEligibleCount number');
  assert.ok(Array.isArray(r.blockedReasons), 'blockedReasons array');
  assert.equal(typeof r.nextRecommendedAction, 'string', 'nextRecommendedAction string');
  assert.ok('stagnation' in r && typeof r.stagnation.detected === 'boolean', 'stagnation shape');
  assertSafety(r.safety, 'research');
  assertSafety(manager.SAFETY, 'module');

  // Every recommendation must carry the contract fields and a safe stamp.
  for (const rec of r.recommendations) {
    assert.ok(typeof rec.type === 'string' && rec.type, 'rec.type');
    assert.ok(['low', 'medium', 'high'].includes(rec.priority), 'rec.priority valid');
    assert.equal(typeof rec.requiresUserApproval, 'boolean', 'rec.requiresUserApproval boolean');
    assert.equal(typeof rec.paperEligible, 'boolean', 'rec.paperEligible boolean');
    assert.ok(Array.isArray(rec.evidence), 'rec.evidence array');
    assert.ok(Array.isArray(rec.requiredBeforePaper), 'rec.requiredBeforePaper array');
    assert.deepEqual(rec.safety, { paperOnly: true, canPlaceOrders: false, brokerEnabled: false }, 'rec.safety');
    // Hard invariant: never paper-eligible while approval is still required.
    if (rec.paperEligible) assert.equal(rec.requiresUserApproval, false, 'paperEligible implies no approval needed');
  }

  // Counts must be consistent with the list.
  assert.equal(r.paperEligibleCount, r.recommendations.filter((x) => x.paperEligible).length, 'paperEligibleCount consistent');
  assert.equal(r.requiresApprovalCount, r.recommendations.filter((x) => x.requiresUserApproval).length, 'requiresApprovalCount consistent');
}

function testPaperEligibilityInvariant() {
  // makeRecommendation must never let a paperEligible recommendation also
  // require approval — that is the core no-auto-promotion guard.
  const rec = makeRecommendation({
    type: 'paper_candidate',
    paperEligible: true,
    requiresUserApproval: true, // contradictory on purpose
    strategyId: 'x',
  });
  assert.equal(rec.paperEligible, false, 'contradictory paperEligible forced false');
}

function testStagnationDeterministic() {
  assert.deepEqual(
    detectStagnation({ planSummary: { recommended: 1, promisingNeedsManualApproval: 0 }, paperStats: { totalTrades: 0 } }),
    { detected: true, reason: 'no_paper_results_yet' },
    'no paper results',
  );
  assert.deepEqual(
    detectStagnation({ planSummary: { recommended: 0, promisingNeedsManualApproval: 0 }, paperStats: { totalTrades: 50, avgPnl: 1 } }),
    { detected: true, reason: 'no_clean_candidates' },
    'no clean candidates',
  );
  assert.deepEqual(
    detectStagnation({ planSummary: { recommended: 2, promisingNeedsManualApproval: 1 }, paperStats: { totalTrades: 30, avgPnl: -0.1 } }),
    { detected: true, reason: 'flat_or_negative_paper_pnl' },
    'flat/negative pnl',
  );
  assert.deepEqual(
    detectStagnation({ planSummary: { recommended: 2, promisingNeedsManualApproval: 1 }, paperStats: { totalTrades: 30, avgPnl: 0.5 } }),
    { detected: false, reason: null },
    'healthy',
  );
}

function testComparatorStable() {
  const a = makeRecommendation({ type: 'paper_candidate', priority: 'high', strategyId: 'b', paperEligible: true, requiresUserApproval: false });
  const b = makeRecommendation({ type: 'collect_more_data', priority: 'medium', strategyId: 'a' });
  assert.ok(compareRecommendations(a, b) < 0, 'high priority sorts first');
}

testContract();
testPaperEligibilityInvariant();
testStagnationDeterministic();
testComparatorStable();
console.log('strategyResearchManagerService.test.js: OK');
