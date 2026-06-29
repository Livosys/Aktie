'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate state to a tmp dir by pointing the module's STATE_FILE via a fresh
// require + monkey-patch. The service resolves STATE_FILE at load time, so we
// load it, then override the module-internal path by re-pointing through fs.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-asset-toggle-'));
const tmpFile = path.join(tmpDir, 'preview-asset-toggles.json');

// Load fresh.
const modPath = require.resolve('./interactiveBrokersPaperPreviewAssetToggleService');
delete require.cache[modPath];
const svc = require('./interactiveBrokersPaperPreviewAssetToggleService');

// The service uses an internal readState/writeState bound to its own STATE_FILE.
// We test behaviour through the public API but redirect the file by stubbing
// fs.readFileSync / writeFileSync for the service's path only.
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realMkdir = fs.mkdirSync;
fs.readFileSync = function patched(p, ...rest) {
  if (p === svc.STATE_FILE) return realRead(tmpFile, ...rest);
  return realRead(p, ...rest);
};
fs.writeFileSync = function patched(p, ...rest) {
  if (p === svc.STATE_FILE) return realWrite(tmpFile, ...rest);
  return realWrite(p, ...rest);
};
fs.mkdirSync = function patched(p, ...rest) {
  if (p === path.dirname(svc.STATE_FILE)) return realMkdir(tmpDir, ...rest);
  return realMkdir(p, ...rest);
};

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok - ${name}`); }

function cleanup() {
  fs.readFileSync = realRead;
  fs.writeFileSync = realWrite;
  fs.mkdirSync = realMkdir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

try {
  test('defaults: stocks ON, etfQqq OFF, crypto OFF', () => {
    const v = svc.getAssetToggles();
    assert.strictEqual(v.paperPreviewAssetToggles.stocks, true);
    assert.strictEqual(v.paperPreviewAssetToggles.etfQqq, false);
    assert.strictEqual(v.paperPreviewAssetToggles.crypto, false);
  });

  test('enabling QQQ/ETF only changes the preview allowlist', () => {
    const v = svc.setAssetToggles({ asset: 'etfQqq', enabled: true });
    assert.strictEqual(v.paperPreviewAssetToggles.etfQqq, true);
    assert.strictEqual(v.brokerUnaffected, true);
    assert.strictEqual(v.liveTradingUnaffected, true);
    assert.strictEqual(v.canPlaceOrdersUnaffected, true);
    assert.strictEqual(v.actionsAllowedUnaffected, true);
    assert.strictEqual(v.safety.broker_enabled, false);
    assert.strictEqual(v.safety.live_trading_enabled, false);
    assert.strictEqual(v.safety.can_place_orders, false);
    assert.strictEqual(v.safety.actions_allowed, false);
  });

  test('enabling crypto only changes the preview allowlist and stays preview-only', () => {
    const v = svc.setAssetToggles({ asset: 'crypto', enabled: true });
    assert.strictEqual(v.paperPreviewAssetToggles.crypto, true);
    const crypto = v.assets.find((a) => a.key === 'crypto');
    assert.strictEqual(crypto.previewOnly, true);
    assert.strictEqual(crypto.submitEverAllowedThisPhase, false);
    assert.strictEqual(v.safety.broker_enabled, false);
  });

  test('every asset reports submitEverAllowedThisPhase=false', () => {
    const v = svc.getAssetToggles();
    for (const a of v.assets) assert.strictEqual(a.submitEverAllowedThisPhase, false);
  });

  test('unknown/dangerous keys in body are ignored, never applied', () => {
    const v = svc.setAssetToggles({
      paperPreviewAssetToggles: { stocks: false, broker_enabled: true, live_trading_enabled: true },
    });
    assert.strictEqual(v.paperPreviewAssetToggles.stocks, false);
    assert.ok(v.rejectedKeys.includes('broker_enabled'));
    assert.ok(v.rejectedKeys.includes('live_trading_enabled'));
    // No such field exists on toggles; safety stays false.
    assert.strictEqual(v.safety.broker_enabled, false);
    assert.strictEqual(v.paperPreviewAssetToggles.broker_enabled, undefined);
  });

  test('classifyCandidateAsset maps QQQ -> etfQqq and respects toggle', () => {
    svc.setAssetToggles({ paperPreviewAssetToggles: { stocks: true, etfQqq: true, crypto: false } });
    const qqq = svc.classifyCandidateAsset({ symbol: 'QQQ', marketGroup: 'etf' });
    assert.strictEqual(qqq.assetKey, 'etfQqq');
    assert.strictEqual(qqq.previewEnabled, true);
    assert.strictEqual(qqq.submitEverAllowedThisPhase, false);
    const btc = svc.classifyCandidateAsset({ symbol: 'BTCUSDT', marketGroup: 'crypto' });
    assert.strictEqual(btc.assetKey, 'crypto');
    assert.strictEqual(btc.previewEnabled, false);
  });

  console.log(`\ninteractiveBrokersPaperPreviewAssetToggleService: ${passed} tests passed`);
} finally {
  cleanup();
}
