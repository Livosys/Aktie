'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectCssAssetRefs,
  collectHtmlAssetRefs,
  collectJsAssetRefs,
  findActiveSimulatedFallback,
  findRuntimeFailed,
  findSimulatedFallback,
  isConnectionReady,
  verifyBuildAssets,
} = require('./verifyProductionRelease');

assert.deepEqual(
  collectHtmlAssetRefs('<script src="/assets/index-a.js"></script><link href="/assets/index-b.css" rel="stylesheet">'),
  ['assets/index-a.js', 'assets/index-b.css'],
);
assert.deepEqual(
  collectCssAssetRefs("body{background:url('/assets/bg.png')} .x{background:url(data:image/png;base64,abc)}"),
  ['assets/bg.png'],
);
assert.deepEqual(
  collectJsAssetRefs('const deps=["assets/DaytradingPage-a.js","/assets/shared-b.js"];'),
  ['assets/DaytradingPage-a.js', 'assets/shared-b.js'],
);

assert.deepEqual(findRuntimeFailed({ runtime: { runtimeState: 'FAILED' } }), ['$.runtime.runtimeState']);
assert.deepEqual(findSimulatedFallback({ feed: { perSymbolSources: { MNQ: 'simulated_fallback' } } }), ['$.feed.perSymbolSources.MNQ']);
assert.deepEqual(
  findActiveSimulatedFallback({
    legacyInternalSimulation: { closedTrades: [{ dataSource: 'simulated_fallback' }] },
    feed: { source: 'ibkr_realtime' },
  }),
  [],
);
assert.deepEqual(
  findActiveSimulatedFallback({ feed: { perSymbolSources: { MNQ: 'simulated_fallback' } } }),
  ['$.feed.perSymbolSources.MNQ'],
);

assert.equal(isConnectionReady({ runtimeState: 'READY', status: 'verified' }), true);
assert.equal(isConnectionReady({ status: 'verified', sessionVerified: true }), true);
assert.equal(isConnectionReady({ runtimeState: 'FAILED', status: 'unreachable' }), false);

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'release-verify-dist-'));
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), [
  '<!doctype html>',
  '<script type="module" src="/assets/index-a.js"></script>',
  '<link rel="stylesheet" href="/assets/index-b.css">',
].join('\n'));
fs.writeFileSync(path.join(dist, 'assets', 'index-a.js'), 'console.log("ok");');
fs.writeFileSync(path.join(dist, 'assets', 'index-b.css'), 'body{background:url(/assets/bg.png)}');
fs.writeFileSync(path.join(dist, 'assets', 'bg.png'), 'png');
assert.equal(verifyBuildAssets(dist).ok, true);

fs.writeFileSync(path.join(dist, 'assets', 'index-a.js'), 'const deps=["assets/lazy-a.js"];');
let missingAsset = verifyBuildAssets(dist);
assert.equal(missingAsset.ok, false);
assert.equal(missingAsset.failures.some((failure) => failure.code === 'missing_asset' && failure.ref === 'assets/lazy-a.js'), true);

fs.writeFileSync(path.join(dist, 'assets', 'lazy-a.js'), 'console.log("lazy");');
assert.equal(verifyBuildAssets(dist).ok, true);

fs.rmSync(path.join(dist, 'assets', 'bg.png'));
missingAsset = verifyBuildAssets(dist);
assert.equal(missingAsset.ok, false);
assert.equal(missingAsset.failures.some((failure) => failure.code === 'missing_css_asset'), true);

console.log('verifyProductionRelease.test.js OK');
