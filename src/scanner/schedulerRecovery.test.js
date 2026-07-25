'use strict';

const assert = require('assert/strict');

const marketUniverse = require('../services/marketUniverseService');
const stockScheduler = require('./scheduler');
const cryptoScheduler = require('./cryptoScheduler');

async function verifyRecovery(label, runScan, getStatus) {
  const originalSymbolEnabledFor = marketUniverse.symbolEnabledFor;
  const originalWarn = console.warn;
  const warnings = [];
  let calls = 0;

  marketUniverse.symbolEnabledFor = () => {
    calls += 1;
    throw new Error(`${label}_forced_scanner_error_${calls}`);
  };
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await runScan();
    let status = getStatus();
    assert.equal(status.scanning, false, `${label} scanner latch must release after first failure`);
    assert.match(status.error, new RegExp(`${label}_forced_scanner_error_1`));

    await runScan();
    status = getStatus();
    assert.equal(status.scanning, false, `${label} scanner latch must release after repeated failure`);
    assert.match(status.error, new RegExp(`${label}_forced_scanner_error_2`));
    assert.equal(calls, 2, `${label} scanner must not skip the second run after recovery`);
    assert.equal(warnings.length, 2, `${label} scanner must log each unexpected failure`);
  } finally {
    stockScheduler.stopScheduler();
    cryptoScheduler.stopCryptoScheduler();
    marketUniverse.symbolEnabledFor = originalSymbolEnabledFor;
    console.warn = originalWarn;
  }
}

(async function run() {
  await verifyRecovery(
    'stock',
    stockScheduler._internal.runScan,
    stockScheduler.getScanStatus,
  );
  await verifyRecovery(
    'crypto',
    cryptoScheduler._internal.runCryptoScan,
    cryptoScheduler.getCryptoStatus,
  );
  console.log('schedulerRecovery.test.js passed');
})().catch((err) => {
  console.error('schedulerRecovery.test.js failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
