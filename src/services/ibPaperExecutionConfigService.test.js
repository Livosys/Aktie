'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./ibPaperExecutionConfigService');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-paper-config-'));
const killSwitchFile = path.join(tmpDir, 'kill-switch.json');
const originalWarn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));

try {
  delete process.env.IBKR_EXECUTION_TARGET;
  delete process.env.IBKR_LIVE_EXECUTION_ENABLED;
  delete process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE;
  delete process.env.IBKR_LIVE_ORDER_SUBMISSION_ENABLED;
  delete process.env.IBKR_LIVE_BROKER_ENABLED;
  delete process.env.IBKR_LIVE_TRADING_ENABLED;
  delete process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED;

  process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
  process.env.IBKR_PAPER_EXECUTION_SHADOW_MODE = 'false';
  process.env.IBKR_PAPER_ORDER_SUBMISSION_ENABLED = 'true';
  process.env.IB_GATEWAY_PORT = '4002';

  const defaultFlags = config.getFlags();
  assert.equal(defaultFlags.executionTarget, 'ibkr_paper');
  assert.equal(defaultFlags.expectedEnvironment, 'paper');
  assert.equal(defaultFlags.executionEnabled, true);
  assert.equal(defaultFlags.submissionEnabled, true);
  assert.equal(defaultFlags.orderSubmissionMode, 'paper_pilot');
  assert.equal(defaultFlags.live_trading_enabled, false);
  assert.equal(defaultFlags.live_broker_enabled, false);
  assert.equal(defaultFlags.live_order_submission_enabled, false);
  assert.equal(defaultFlags.live_account_orders_allowed, false);

  const defaultClient = config.getExecutionClientConfig();
  assert.equal(defaultClient.executionTarget, 'ibkr_paper');
  assert.equal(defaultClient.expectedEnvironment, 'paper');
  assert.equal(defaultClient.port, 4002);

  process.env.IBKR_EXECUTION_TARGET = 'ibkr_live';
  let liveFlags = config.getFlags();
  assert.equal(liveFlags.executionTarget, 'ibkr_live');
  assert.equal(liveFlags.expectedEnvironment, 'live');
  assert.equal(liveFlags.executionEnabled, false);
  assert.equal(liveFlags.submissionEnabled, false);
  assert.equal(liveFlags.orderSubmissionMode, 'disabled');

  process.env.IBKR_LIVE_EXECUTION_ENABLED = 'true';
  process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE = 'false';
  process.env.IBKR_LIVE_ORDER_SUBMISSION_ENABLED = 'true';
  liveFlags = config.getFlags();
  assert.equal(liveFlags.executionEnabled, true);
  assert.equal(liveFlags.submissionEnabled, false);
  assert.equal(liveFlags.orderSubmissionMode, 'armed_but_submission_off');
  assert.equal(liveFlags.liveBrokerExecutionEnabled, false);

  process.env.IBKR_LIVE_BROKER_ENABLED = 'true';
  process.env.IBKR_LIVE_TRADING_ENABLED = 'true';
  process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED = 'true';
  process.env.IBKR_LIVE_GATEWAY_PORT = '4001';
  liveFlags = config.getFlags();
  assert.equal(liveFlags.submissionEnabled, true);
  assert.equal(liveFlags.orderSubmissionMode, 'live_pilot');
  assert.equal(liveFlags.liveBrokerExecutionEnabled, true);
  assert.equal(liveFlags.live_trading_enabled, true);
  assert.equal(liveFlags.live_broker_enabled, true);
  assert.equal(liveFlags.live_order_submission_enabled, true);
  assert.equal(liveFlags.live_account_orders_allowed, true);

  const liveClient = config.getExecutionClientConfig();
  assert.equal(liveClient.executionTarget, 'ibkr_live');
  assert.equal(liveClient.expectedEnvironment, 'live');
  assert.equal(liveClient.port, 4001);

  delete process.env.IBKR_EXECUTION_TARGET;
  delete process.env.IBKR_LIVE_EXECUTION_ENABLED;
  delete process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE;
  delete process.env.IBKR_LIVE_ORDER_SUBMISSION_ENABLED;
  delete process.env.IBKR_LIVE_BROKER_ENABLED;
  delete process.env.IBKR_LIVE_TRADING_ENABLED;
  delete process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED;
  delete process.env.IBKR_LIVE_GATEWAY_PORT;

  const missing = config._internal.readKillSwitchFile(killSwitchFile);
  assert.deepEqual(missing, { pauseNewEntries: false, reason: null, updatedAt: null });

  const written = config._internal.writeKillSwitchFile(killSwitchFile, true, 'test_pause');
  assert.equal(written.pauseNewEntries, true);
  assert.equal(written.reason, 'test_pause');
  assert.equal(fs.readFileSync(killSwitchFile, 'utf8').endsWith('\n'), false);

  const read = config._internal.readKillSwitchFile(killSwitchFile);
  assert.equal(read.pauseNewEntries, true);
  assert.equal(read.reason, 'test_pause');

  fs.writeFileSync(killSwitchFile, '{broken json', 'utf8');
  const corrupt = config._internal.readKillSwitchFile(killSwitchFile);
  assert.deepEqual(corrupt, {
    pauseNewEntries: true,
    reason: 'kill_switch_read_failed',
    updatedAt: null,
  });
  assert.equal(warnings.length, 1);

  console.log('ibPaperExecutionConfigService.test.js passed');
} finally {
  console.warn = originalWarn;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
