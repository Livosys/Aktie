'use strict';

const assert = require('assert/strict');
const svc = require('./strategyRuntimeMatrixService');

(() => {
  const matrix = svc.getStrategyRuntimeMatrix();
  assert.equal(matrix.ok, true);
  assert.ok(['ok', 'empty', 'degraded'].includes(matrix.status), 'matrix status valid');
  assert.equal(matrix.source, 'strategyRuntimeMatrixService');
  assert.ok(matrix.safety && typeof matrix.safety === 'object');
  assert.equal(matrix.safety.mode, 'paper_only');
  assert.equal(matrix.safety.actions_allowed, false);
  assert.equal(matrix.safety.can_place_orders, false);
  assert.equal(matrix.safety.live_trading_enabled, false);
  assert.equal(matrix.safety.broker_enabled, false);
  assert.ok(matrix.summary && typeof matrix.summary === 'object');
  assert.equal(matrix.summary.source, 'strategyRuntimeMatrixService');
  assert.ok(['ok', 'empty'].includes(matrix.summary.status));
  assert.ok(typeof matrix.summary.message === 'string');
  assert.equal(matrix.summary.paperOnly, true);
  assert.equal(matrix.summary.total, Array.isArray(matrix.strategies) ? matrix.strategies.length : 0);
  assert.ok(matrix.summary.activeStrategies >= 0);
  assert.ok(matrix.summary.inactiveStrategies >= 0);
  assert.ok(matrix.summary.needsMoreData >= 0);
  if (Array.isArray(matrix.strategies) && matrix.strategies.length) {
    const first = matrix.strategies[0];
    assert.ok(first.id || first.strategy_id, 'strategy id present');
    assert.ok(Object.prototype.hasOwnProperty.call(first, 'automaticStatus'), 'automaticStatus present');
    assert.ok(Object.prototype.hasOwnProperty.call(first, 'needsMoreData'), 'needsMoreData present');
    assert.ok(Object.prototype.hasOwnProperty.call(first, 'recommendation'), 'recommendation present');
  }
  console.log('# strategyRuntimeMatrixService tests passed.');
  process.exit(0);
})();
