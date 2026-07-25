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
