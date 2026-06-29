'use strict';

/**
 * Safety verification for the IB Paper preview / manual-approval phase.
 *
 * In-process assertions (no server required) proving:
 *   - safety flags stay false everywhere
 *   - realSubmitAllowed / placeOrderCalled / orderSent stay false; dryRun /
 *     mockOnly stay true in the execution preview
 *   - QQQ + crypto toggles change ONLY the preview allowlist
 *   - manual approval sends no order
 *   - a blueprint without a stop loss / without a verified direction is blocked
 *   - an unknown direction is blocked
 *
 * Run: node scripts/verifyIbPaperPreviewPhaseSafety.js
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const base = path.resolve(__dirname, '../src/services');
const directionResolver = require(path.join(base, 'interactiveBrokersDirectionResolverService'));
const assetToggles = require(path.join(base, 'interactiveBrokersPaperPreviewAssetToggleService'));
const manualApproval = require(path.join(base, 'interactiveBrokersPaperManualApprovalService'));
const executionPreview = require(path.join(base, 'interactiveBrokersPaperExecutionPreviewService'));
const planService = require(path.join(base, 'interactiveBrokersPaperMultiStrategyTestPlanService'));

let passed = 0;
const checks = [];
function check(name, fn) {
  try { fn(); passed += 1; checks.push(`  PASS - ${name}`); }
  catch (err) { checks.push(`  FAIL - ${name}: ${err.message}`); throw err; }
}

function assertSafetyAllFalse(safety, where) {
  assert.strictEqual(safety.actions_allowed, false, `${where}.actions_allowed`);
  assert.strictEqual(safety.can_place_orders, false, `${where}.can_place_orders`);
  assert.strictEqual(safety.live_trading_enabled, false, `${where}.live_trading_enabled`);
  assert.strictEqual(safety.broker_enabled, false, `${where}.broker_enabled`);
}

(async () => {
  // 1. Every new service exposes all-false safety.
  check('direction resolver safety all false', () => assertSafetyAllFalse(directionResolver.SAFETY, 'directionResolver'));
  check('asset toggle safety all false', () => assertSafetyAllFalse(assetToggles.SAFETY, 'assetToggles'));
  check('manual approval safety all false', () => assertSafetyAllFalse(manualApproval.SAFETY, 'manualApproval'));
  check('execution preview safety all false', () => assertSafetyAllFalse(executionPreview.SAFETY, 'executionPreview'));
  check('plan safety all false', () => assertSafetyAllFalse(planService.SAFETY, 'plan'));

  // 2. Execution preview keeps the dangerous fields safe.
  const preview = await executionPreview.buildPaperExecutionPreview({
    body: { symbol: 'QQQ', action: 'BUY', quantity: 1, orderType: 'MKT', dryRun: true, mockOnly: true },
  });
  check('preview dryRun true', () => assert.strictEqual(preview.dryRun, true));
  check('preview mockOnly true', () => assert.strictEqual(preview.mockOnly, true));
  check('preview wouldPlaceOrder false', () => assert.strictEqual(preview.wouldPlaceOrder, false));
  check('preview orderSent false', () => assert.strictEqual(preview.orderSent, false));
  check('preview placeOrderCalled false', () => assert.strictEqual(preview.placeOrderCalled, false));
  check('preview realSubmitAllowed false', () => assert.strictEqual(preview.realSubmitAllowed, false));
  check('preview safety all false', () => assertSafetyAllFalse(preview.safety, 'preview'));

  // 3. Asset toggles change ONLY the preview allowlist (use an isolated tmp file).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-safety-'));
  const tmpFile = path.join(tmpDir, 'toggles.json');
  const realRead = fs.readFileSync, realWrite = fs.writeFileSync, realMkdir = fs.mkdirSync;
  fs.readFileSync = (p, ...r) => (p === assetToggles.STATE_FILE ? realRead(tmpFile, ...r) : realRead(p, ...r));
  fs.writeFileSync = (p, ...r) => (p === assetToggles.STATE_FILE ? realWrite(tmpFile, ...r) : realWrite(p, ...r));
  fs.mkdirSync = (p, ...r) => (p === path.dirname(assetToggles.STATE_FILE) ? realMkdir(tmpDir, ...r) : realMkdir(p, ...r));
  try {
    const qqq = assetToggles.setAssetToggles({ asset: 'etfQqq', enabled: true });
    check('QQQ toggle only changes preview allowlist', () => {
      assert.strictEqual(qqq.paperPreviewAssetToggles.etfQqq, true);
      assert.strictEqual(qqq.brokerUnaffected, true);
      assert.strictEqual(qqq.liveTradingUnaffected, true);
      assertSafetyAllFalse(qqq.safety, 'qqqToggle');
    });
    const crypto = assetToggles.setAssetToggles({ asset: 'crypto', enabled: true });
    check('crypto toggle only changes preview allowlist + preview-only', () => {
      assert.strictEqual(crypto.paperPreviewAssetToggles.crypto, true);
      const c = crypto.assets.find((a) => a.key === 'crypto');
      assert.strictEqual(c.previewOnly, true);
      assert.strictEqual(c.submitEverAllowedThisPhase, false);
      assertSafetyAllFalse(crypto.safety, 'cryptoToggle');
    });
    check('dangerous keys in toggle body are ignored', () => {
      const v = assetToggles.setAssetToggles({ paperPreviewAssetToggles: { broker_enabled: true, live_trading_enabled: true } });
      assert.strictEqual(v.paperPreviewAssetToggles.broker_enabled, undefined);
      assertSafetyAllFalse(v.safety, 'rejected');
    });
  } finally {
    fs.readFileSync = realRead; fs.writeFileSync = realWrite; fs.mkdirSync = realMkdir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  // 4. Manual approval sends no order.
  const mtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-safety-ap-'));
  const mfile = path.join(mtmp, 'approval.json');
  const rr = fs.readFileSync, rw = fs.writeFileSync, rm = fs.mkdirSync;
  fs.readFileSync = (p, ...r) => (p === manualApproval.STATE_FILE ? rr(mfile, ...r) : rr(p, ...r));
  fs.writeFileSync = (p, ...r) => (p === manualApproval.STATE_FILE ? rw(mfile, ...r) : rw(p, ...r));
  fs.mkdirSync = (p, ...r) => (p === path.dirname(manualApproval.STATE_FILE) ? rm(mtmp, ...r) : rm(p, ...r));
  try {
    const ap = manualApproval.createManualApproval({ blueprintId: 'bp', symbol: 'AAPL', side: 'BUY' });
    check('manual approval ready but sends no order', () => {
      assert.strictEqual(ap.manualApprovalReady, true);
      assert.strictEqual(ap.realSubmitAllowed, false);
      assert.strictEqual(ap.submitRouteLocked, true);
      assert.strictEqual(ap.approvalScope, 'ib_paper_preview_only');
      assertSafetyAllFalse(ap.safety, 'approval');
    });
  } finally {
    fs.readFileSync = rr; fs.writeFileSync = rw; fs.mkdirSync = rm;
    try { fs.rmSync(mtmp, { recursive: true, force: true }); } catch (_) {}
  }

  // 5. Direction: unknown direction is blocked.
  check('unknown direction is blocked', () => {
    const r = directionResolver.resolveDirection({ symbol: 'AMD', strategyId: 'trend_continuation' });
    assert.strictEqual(r.direction, 'UNKNOWN');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.blocker, 'direction_not_verified');
  });

  // 6. Plan: blueprint without direction is blocked; without stop loss bracket is blocked.
  const enabledAssets = {
    getAssetToggles: () => ({ paperPreviewAssetToggles: { stocks: true, etfQqq: true, crypto: true }, assets: [] }),
    classifyCandidateAsset: () => ({ assetKey: 'stocks', label: 'Aktier', previewEnabled: true, previewOnly: false, submitEverAllowedThisPhase: false }),
  };
  const cfg = { ...planService.DEFAULT_LIMITS, enabled: true, includeEtf: true };
  check('plan blocks a candidate without verified direction', () => {
    const plan = planService.buildMultiStrategyTestPlan({
      assetToggleService: enabledAssets,
      tradeBlueprint: { blueprints: [{ blueprintId: 'x', symbol: 'AMD', strategyId: 'trend_continuation', quantity: 1, stopLoss: 100.1, takeProfit: 100.5, entryReferencePrice: 100, blockers: [] }] },
      readOnlyState: { account: 'DUQ565596', openOrders: [], positions: [], executions: [] },
      config: cfg,
    });
    const c = plan.candidates[0];
    assert.strictEqual(c.directionVerified, false);
    assert.ok(c.blockers.includes('direction_not_verified'));
    assert.strictEqual(c.allowed, false);
    assertSafetyAllFalse(plan.safety, 'plan');
  });
  check('plan blocks a candidate without stop loss (no bracket)', () => {
    const plan = planService.buildMultiStrategyTestPlan({
      assetToggleService: enabledAssets,
      tradeBlueprint: { blueprints: [{ blueprintId: 'y', symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short', side: 'SELL', direction: 'short', quantity: 1, stopLoss: null, takeProfit: 199.6, entryReferencePrice: 200, blockers: [] }] },
      readOnlyState: { account: 'DUQ565596', openOrders: [], positions: [], executions: [] },
      config: cfg,
    });
    const c = plan.candidates[0];
    assert.strictEqual(c.hasBracket, false);
    assert.ok(c.blockers.includes('bracket_required_missing'));
    assert.strictEqual(c.allowed, false);
  });

  console.log(checks.join('\n'));
  console.log(`\nIB Paper preview phase safety: ${passed} checks passed`);
})().catch((err) => {
  console.error(checks.join('\n'));
  console.error('\nSAFETY VERIFICATION FAILED:', err.message);
  process.exit(1);
});
