'use strict';

// Regression tests for the manual paper-allowlist approval chain.
//
// Covers the two bugs fixed in this change:
//   A) Candidates surfaced from AI Agent / Batch must be approvable (they flow
//      into the same /automation/approvals/approve action).
//   B) A strategy classed "weak" in the automation plan must NOT be a hard block
//      for MANUAL paper-only approval — but real safety gates (blockers,
//      paused/blocked, max count, paper-only) must stay enforced.
//
// Everything here is paper-only. No order, broker or live-trading path exists.

const assert = require('assert/strict');
const fs = require('fs');

// --- Virtualize the approvals data file so the real prod state is untouched ---
const VIRTUAL = new Map();
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realExists = fs.existsSync;
const realMkdir = fs.mkdirSync;
const APPROVALS_RE = /automation-approvals\.json$/;

fs.readFileSync = (p, ...rest) => (APPROVALS_RE.test(String(p)) ? VIRTUAL.get(String(p)) : realRead(p, ...rest));
fs.writeFileSync = (p, data, ...rest) => {
  if (APPROVALS_RE.test(String(p))) { VIRTUAL.set(String(p), data); return undefined; }
  return realWrite(p, data, ...rest);
};
fs.existsSync = (p, ...rest) => (APPROVALS_RE.test(String(p)) ? VIRTUAL.has(String(p)) : realExists(p, ...rest));
fs.mkdirSync = (p, ...rest) => (APPROVALS_RE.test(String(p)) ? undefined : realMkdir(p, ...rest));

// --- Stub the read-only inputs the approval gate reasons over -----------------
const matrixSvc = require('./strategyRuntimeMatrixService');
const planSvc = require('./automationPlanService');
const configSvc = require('./paperAllowlistConfigService');

let MATRIX = { strategies: [] };
let PLAN = {};
let MAX_APPROVED = 4;

matrixSvc.getStrategyRuntimeMatrix = () => MATRIX;
planSvc.getAutomationPlan = () => PLAN;
const realConfig = configSvc.getPaperAllowlistConfig;
configSvc.getPaperAllowlistConfig = () => ({ ...realConfig.call(configSvc), maxApproved: MAX_APPROVED });

const svc = require('./automationApprovalService');

function row(id, extra = {}) {
  return { id, name: id, blockers: [], ...extra };
}

function setWorld() {
  MATRIX = {
    strategies: [
      row('narrow_state_expansion_long', { weakCandidate: true }),
      row('trend_continuation'),
      row('narrow_fakeout_reversal_v1'),
      row('blocked_one', { blockers: ['needs_more_data'] }),
      row('paused_one', { automaticStatus: 'pausedOrBlocked' }),
    ],
  };
  PLAN = {
    recommendedPaperCandidates: [{ id: 'trend_continuation' }, { id: 'narrow_fakeout_reversal_v1' }],
    promisingNeedsManualApproval: [],
    blockedStrategies: [],
    weakStrategies: [{ id: 'narrow_state_expansion_long' }],
    needsMoreData: [],
  };
  MAX_APPROVED = 4;
  VIRTUAL.clear();
}

function assertSafetyLocked(result, label) {
  const s = result.safety || {};
  assert.equal(s.mode, 'paper_only', `${label}: mode must be paper_only`);
  assert.equal(s.actions_allowed, false, `${label}: actions_allowed must be false`);
  assert.equal(s.can_place_orders, false, `${label}: can_place_orders must be false`);
  assert.equal(s.live_trading_enabled, false, `${label}: live_trading_enabled must be false`);
  assert.equal(s.broker_enabled, false, `${label}: broker_enabled must be false`);
}

let passed = 0;
function test(name, fn) {
  setWorld();
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// B) Weak strategy is approvable (the core fix) and carries a warning.
test('weak strategy can be approved manually with a warning', () => {
  const check = svc.canApproveStrategy('narrow_state_expansion_long', []);
  assert.equal(check.ok, true);
  assert.ok(check.warning, 'weak approval should surface a warning');
});

// 2) The three named candidates all approve cleanly.
test('narrow_state_expansion_long / trend_continuation / narrow_fakeout_reversal_v1 approve', () => {
  for (const id of ['narrow_state_expansion_long', 'trend_continuation', 'narrow_fakeout_reversal_v1']) {
    const result = svc.approveStrategy({ strategyId: id, symbol: 'AAPL', source: 'batch' });
    assert.equal(result.ok, true, `${id} should approve`);
    assert.equal(result.approved, true, `${id} approved flag`);
    assert.equal(result.allowlistStatus, 'approved', `${id} allowlistStatus`);
    assertSafetyLocked(result, id);
  }
  const approvals = svc.getAutomationApprovals();
  for (const id of ['narrow_state_expansion_long', 'trend_continuation', 'narrow_fakeout_reversal_v1']) {
    assert.ok(approvals.approvedStrategyIds.includes(id), `${id} persisted in allowlist`);
  }
});

// 6) Success response echoes candidate context.
test('approve echoes strategyId/symbol/source and returns paper allowlistStatus', () => {
  const result = svc.approveStrategy({ strategyId: 'trend_continuation', symbol: 'AMZN', source: 'ai_agent', candidateId: 'abc123', timeframe: '2m' });
  assert.equal(result.strategyId, 'trend_continuation');
  assert.equal(result.symbol, 'AMZN');
  assert.equal(result.source, 'ai_agent');
  assert.equal(result.candidateId, 'abc123');
  assert.equal(result.timeframe, '2m');
  assert.equal(result.allowlistStatus, 'approved');
});

// Safety gate preserved: active blockers still block.
test('strategy with active blockers is rejected (safety gate preserved)', () => {
  const result = svc.approveStrategy({ strategyId: 'blocked_one' });
  assert.equal(result.ok, false);
  assert.equal(result.approved, false);
  assert.match(result.error, /blocker/i);
  assertSafetyLocked(result, 'blocked_one');
});

// Safety gate preserved: paused/blocked-in-runtime still blocks.
test('paused/blocked strategy is rejected (safety gate preserved)', () => {
  const result = svc.approveStrategy({ strategyId: 'paused_one' });
  assert.equal(result.ok, false);
  assert.match(result.error, /pausad eller blockerad/i);
});

// 4) Invalid candidate gives a clear error without crashing.
test('unknown strategy returns a clear error, no crash', () => {
  const result = svc.approveStrategy({ strategyId: 'does_not_exist' });
  assert.equal(result.ok, false);
  assert.match(result.error, /finns inte/i);
  assert.equal(result.allowlistStatus, 'not_approved');
});

// 5) Missing strategyId is handled.
test('missing strategyId returns a clear error', () => {
  const result = svc.approveStrategy({});
  assert.equal(result.ok, false);
  assert.match(result.error, /strategyId/i);
});

// Max-approved gate still enforced.
test('max approved gate still enforced', () => {
  MAX_APPROVED = 1;
  const first = svc.approveStrategy({ strategyId: 'trend_continuation' });
  assert.equal(first.ok, true);
  const second = svc.approveStrategy({ strategyId: 'narrow_fakeout_reversal_v1' });
  assert.equal(second.ok, false);
  assert.match(second.error, /Max 1/);
});

console.log(`\nautomationApprovalService.paperAllowlist.test.js: ${passed} passed`);
