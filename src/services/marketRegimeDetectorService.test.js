'use strict';

const assert = require('assert/strict');
const detector = require('./marketRegimeDetectorService');

function assertSafety(s, label) {
  assert.deepEqual(s, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  }, `${label} safety exact match`);
}

function run() {
  const d = detector.buildMarketRegimeDetection();

  assert.ok(d && typeof d === 'object', 'returns an object');
  assert.ok(['ok', 'empty', 'degraded', 'error'].includes(d.status), 'status valid');
  assert.equal(d.source, 'marketRegimeService', 'source set');
  assert.ok(typeof d.detectedAt === 'string' && d.detectedAt.length > 0, 'detectedAt iso');
  assert.ok(Array.isArray(d.biasSummaryLines), 'biasSummaryLines array');
  assert.ok(Array.isArray(d.topStrategies), 'topStrategies array');
  assert.ok(Array.isArray(d.bottomStrategies), 'bottomStrategies array');
  assert.equal(typeof d.isChoppy, 'boolean', 'isChoppy boolean');
  assertSafety(d.safety, 'detection');
  // exported SAFETY constant must also be the canonical paper_only shape.
  assertSafety(detector.SAFETY, 'module');

  console.log('marketRegimeDetectorService.test.js: OK');
}

run();
