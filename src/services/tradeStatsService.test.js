'use strict';

const assert = require('assert/strict');
const supervisorOverview = require('./supervisorOverviewService');

const overview = supervisorOverview.buildSupervisorOverview();

assert.equal(overview.mode, 'paper_only', 'research platform stays paper_only');
assert.equal(overview.actions_allowed, false, 'actions remain disabled');
assert.equal(overview.can_place_orders, false, 'orders remain disabled');
assert.equal(overview.live_trading_enabled, false, 'live trading remains disabled');
assert.equal(overview.broker_enabled, false, 'broker remains disabled');

console.log('Trade stats smoke test passed.');
