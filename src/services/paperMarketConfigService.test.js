'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./paperMarketConfigService');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-market-config-'));
const file = path.join(tmpDir, 'market-config.json');

let config = svc.readPaperMarketConfig({ dataFile: file });
assert.equal(config.ok, true);
assert.equal(config.cryptoPaperEnabled, false);
assert.equal(config.equityPaperEnabled, true);
assert.equal(config.nearMissLearningEnabled, true);
assert.equal(config.nearMissLearningMargin, 5);

let result = svc.updatePaperMarketConfig({ cryptoPaperEnabled: false, updatedBy: 'manual' }, { dataFile: file });
assert.equal(result.ok, true);
assert.equal(result.changed, true);
assert.equal(result.cryptoPaperEnabled, false);
assert.equal(result.equityPaperEnabled, true);
assert.equal(result.nearMissLearningEnabled, true);

result = svc.updatePaperMarketConfig({ equityPaperEnabled: false, updatedBy: 'manual' }, { dataFile: file });
assert.equal(result.ok, true);
assert.equal(result.changed, true);
assert.equal(result.cryptoPaperEnabled, false);
assert.equal(result.equityPaperEnabled, false);

result = svc.updatePaperMarketConfig({ nearMissLearningEnabled: false, nearMissLearningMargin: 4, updatedBy: 'manual' }, { dataFile: file });
assert.equal(result.ok, true);
assert.equal(result.changed, true);
assert.equal(result.nearMissLearningEnabled, false);
assert.equal(result.nearMissLearningMargin, 4);

assert.equal(svc.isCryptoSymbol('BTCUSDT'), true);
assert.equal(svc.isCryptoSymbol('ETHUSDT'), true);
assert.equal(svc.isCryptoSymbol('QQQ'), false);

assert.equal(svc.getPaperMarketForSymbol('BTCUSDT'), 'crypto');
assert.equal(svc.getPaperMarketForSymbol('QQQ'), 'equity');

assert.equal(svc.isPaperMarketEnabled('BTCUSDT', { cryptoPaperEnabled: false, equityPaperEnabled: true }), false);
assert.equal(svc.isPaperMarketEnabled('AAPL', { cryptoPaperEnabled: true, equityPaperEnabled: false }), false);
assert.equal(svc.getPaperMarketGateDecision('BTCUSDT', { cryptoPaperEnabled: false, equityPaperEnabled: true }).blockedReason, 'paper_crypto_disabled_by_user');
assert.equal(svc.getPaperMarketGateDecision('QQQ', { cryptoPaperEnabled: true, equityPaperEnabled: false }).blockedReason, 'paper_equities_disabled_by_user');

assert.equal(svc.getPaperMarketGateDecision('BTCUSDT', { cryptoPaperEnabled: true, equityPaperEnabled: true }).allowed, true);
assert.equal(svc.getPaperMarketGateDecision('QQQ', { cryptoPaperEnabled: true, equityPaperEnabled: true }).allowed, true);

console.log('# paperMarketConfigService tests passed.');
