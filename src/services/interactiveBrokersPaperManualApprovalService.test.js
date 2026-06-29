'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-manual-approval-'));
const tmpFile = path.join(tmpDir, 'manual-approval-state.json');

const svc = require('./interactiveBrokersPaperManualApprovalService');

const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realMkdir = fs.mkdirSync;
fs.readFileSync = (p, ...rest) => (p === svc.STATE_FILE ? realRead(tmpFile, ...rest) : realRead(p, ...rest));
fs.writeFileSync = (p, ...rest) => (p === svc.STATE_FILE ? realWrite(tmpFile, ...rest) : realWrite(p, ...rest));
fs.mkdirSync = (p, ...rest) => (p === path.dirname(svc.STATE_FILE) ? realMkdir(tmpDir, ...rest) : realMkdir(p, ...rest));

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }
function cleanup() {
  fs.readFileSync = realRead; fs.writeFileSync = realWrite; fs.mkdirSync = realMkdir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

try {
  test('no approval by default', () => {
    svc.clearManualApproval();
    const v = svc.getManualApproval();
    assert.strictEqual(v.manualApprovalReady, false);
    assert.strictEqual(v.approvedByUser, false);
    assert.strictEqual(v.realSubmitAllowed, false);
    assert.strictEqual(v.submitRouteLocked, true);
  });

  test('createManualApproval sets ready=true, scope preview-only, never submit', () => {
    const v = svc.createManualApproval({ blueprintId: 'bp1', symbol: 'aapl', side: 'BUY' });
    assert.strictEqual(v.manualApprovalReady, true);
    assert.strictEqual(v.approvedByUser, true);
    assert.strictEqual(v.approvalScope, 'ib_paper_preview_only');
    assert.strictEqual(v.blueprintId, 'bp1');
    assert.strictEqual(v.symbol, 'AAPL');
    assert.strictEqual(v.side, 'BUY');
    assert.strictEqual(v.realSubmitAllowed, false);
    assert.strictEqual(v.safety.broker_enabled, false);
    assert.strictEqual(v.safety.live_trading_enabled, false);
    assert.strictEqual(v.nextStep, 'manual_paper_submit_phase_required');
  });

  test('approval expires after the TTL window', () => {
    const base = new Date('2026-06-29T10:00:00.000Z');
    svc.createManualApproval({ blueprintId: 'bp2', now: base, ttlMinutes: 10 });
    const within = svc.getManualApproval({ now: new Date(base.getTime() + 5 * 60_000) });
    assert.strictEqual(within.manualApprovalReady, true);
    assert.ok(within.secondsRemaining > 0);
    const after = svc.getManualApproval({ now: new Date(base.getTime() + 11 * 60_000) });
    assert.strictEqual(after.manualApprovalReady, false);
    assert.strictEqual(after.expired, true);
    assert.strictEqual(after.secondsRemaining, 0);
  });

  test('clearManualApproval revokes the approval', () => {
    svc.createManualApproval({ blueprintId: 'bp3' });
    const cleared = svc.clearManualApproval();
    assert.strictEqual(cleared.manualApprovalReady, false);
    assert.strictEqual(cleared.cleared, true);
    assert.strictEqual(svc.getManualApproval().manualApprovalReady, false);
  });

  console.log(`\ninteractiveBrokersPaperManualApprovalService: ${passed} tests passed`);
} finally {
  cleanup();
}
