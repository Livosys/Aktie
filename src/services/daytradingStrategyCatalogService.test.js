'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daytrading-catalog-'));
const catalogStateFile = path.join(testRoot, 'daytrading-strategy-catalog.jsonl');
process.env.DAYTRADING_STRATEGY_CATALOG_FILE = catalogStateFile;

const catalog = require('./daytradingStrategyCatalogService');

function resetState() {
  fs.writeFileSync(catalogStateFile, '', 'utf8');
}

function assertSafety(result, label) {
  assert.equal(result.actions_allowed, false, `${label}: actions_allowed`);
  assert.equal(result.can_place_orders, false, `${label}: can_place_orders`);
  assert.equal(result.live_trading_enabled, false, `${label}: live_trading_enabled`);
  assert.equal(result.paper_only, true, `${label}: paper_only`);
}

resetState();

{
  const status = catalog.getStatus();
  assert.equal(status.ok, true, 'status ok');
  assertSafety(status, 'status');
  assert.ok(status.total_strategies > 0, 'catalog has strategies');
  assert.ok(status.active_strategies > 0, 'catalog has active strategies');
}

{
  const created = catalog.registerTradingViewStrategy('TV_CATALOG_TEST', {
    strategy_name: 'TV Catalog Test',
    description: 'Auto registered tradingview strategy',
    recommended_tests: ['paper_forward', 'replay_comparison'],
    known_weaknesses: ['needs more data'],
    learning_notes: ['initial import'],
  });
  assert.equal(created.ok, true, 'register ok');
  assert.equal(created.created, true, 'register created');
  assert.equal(created.strategy.source, 'tradingview', 'register source');
  assert.equal(created.strategy.status, 'paper_only', 'register status');
  assert.equal(created.strategy.enabled, true, 'register enabled');
  assert.equal(created.strategy.mode, 'paper_only', 'register mode');
  assert.deepEqual(created.strategy.recommended_tests, ['paper_forward', 'replay_comparison'], 'register recommended_tests');
  assert.deepEqual(created.strategy.known_weaknesses, ['needs more data'], 'register weaknesses');
  assert.deepEqual(created.strategy.learning_notes, ['initial import'], 'register learning_notes');

  const listed = catalog.getStrategyById('TV_CATALOG_TEST');
  assert.equal(listed.source, 'tradingview', 'listed source');
  assert.equal(listed.status, 'paper_only', 'listed status');

  const paused = catalog.pauseStrategy('TV_CATALOG_TEST', 'under review');
  assert.equal(paused.ok, true, 'pause ok');
  assert.equal(paused.strategy.enabled, false, 'pause enabled false');
  assert.equal(paused.strategy.status, 'paused', 'pause status');
  assert.equal(paused.strategy.disabled_reason, 'under review', 'pause reason');
  assert.ok(paused.strategy.disabled_at, 'pause disabled_at');

  const activated = catalog.activateStrategy('TV_CATALOG_TEST');
  assert.equal(activated.ok, true, 'activate ok');
  assert.equal(activated.strategy.enabled, true, 'activate enabled');
  assert.equal(activated.strategy.status, 'paper_only', 'activate returns paper_only for tv');
  assert.equal(activated.strategy.disabled_reason, null, 'activate clears reason');
  assert.equal(activated.strategy.disabled_at, null, 'activate clears timestamp');

  const deprecated = catalog.deprecateStrategy('TV_CATALOG_TEST', 'obsolete');
  assert.equal(deprecated.ok, true, 'deprecate ok');
  assert.equal(deprecated.strategy.enabled, false, 'deprecate enabled false');
  assert.equal(deprecated.strategy.status, 'deprecated', 'deprecate status');
  assert.equal(deprecated.strategy.disabled_reason, 'obsolete', 'deprecate reason');
  assert.ok(deprecated.strategy.disabled_at, 'deprecate disabled_at');

  const status = catalog.getStatus();
  assert.equal(status.tradingview_strategies >= 1, true, 'status tradingview count');
  assert.equal(status.paused_strategies >= 0, true, 'status paused count');
  assert.equal(status.deprecated_strategies >= 1, true, 'status deprecated count');
  assert.equal(status.latest_tradingview_strategy.strategy_id, 'TV_CATALOG_TEST', 'status latest tradingview');
  assertSafety(status, 'status after lifecycle');
}

{
  const internal = catalog.getStrategyById('vwap_momentum_long');
  assert.equal(internal.source, 'internal', 'internal source preserved');
  assert.equal(internal.enabled, true, 'internal enabled preserved');
  assert.equal(internal.status, 'active', 'internal active preserved');
}

console.log('Daytrading strategy catalog tests passed.');
