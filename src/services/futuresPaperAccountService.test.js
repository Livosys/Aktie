'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-account-'));
const storage = createFuturesPaperStorageService({ rootDir });
const retiredSvc = createFuturesPaperAccountService({ storageService: storage });

const blockedSet = retiredSvc.setFuturesPaperBalance({ startingBalanceSek: 500000 });
assert.equal(blockedSet.ok, false);
assert.equal(blockedSet.error, 'internal_futures_simulation_disabled');
assert.equal(blockedSet.code, 'internal_futures_simulation_retired');

const blockedReset = retiredSvc.resetFuturesPaperAccount({ reason: 'test_reset' });
assert.equal(blockedReset.ok, false);
assert.equal(blockedReset.error, 'internal_futures_simulation_disabled');
assert.equal(fs.existsSync(storage.files.accountState), false);
assert.equal(fs.existsSync(storage.files.equityCurve), false);

const retiredReadOnly = retiredSvc.getFuturesPaperAccount();
assert.equal(retiredReadOnly.ok, true);
assert.equal(retiredReadOnly.readOnly, true);
assert.equal(retiredReadOnly.legacySource, 'internal_legacy_simulation');
assert.equal(fs.existsSync(storage.files.accountState), false);
assert.equal(fs.existsSync(storage.files.equityCurve), false);

const svc = createFuturesPaperAccountService({ storageService: storage, allowInternalSimulationForTests: true });

const initial = svc.getFuturesPaperAccount();

assert.equal(initial.ok, true);
assert.equal(initial.mode, 'paper_only');
assert.equal(initial.readOnly, true);
assert.equal(initial.legacySource, 'internal_legacy_simulation');
assert.equal(initial.actions_allowed, false);
assert.equal(initial.can_place_orders, false);
assert.equal(initial.live_trading_enabled, false);
assert.equal(initial.broker_enabled, false);
assert.equal(initial.account.currency, 'SEK');
assert.equal(initial.account.startingBalanceSek, 250000);
assert.equal(initial.account.cashSek, 250000);
assert.equal(initial.account.equitySek, 250000);
assert.equal(initial.account.fxUsdSek, 10.5);

const setResult = svc.setFuturesPaperBalance({ startingBalanceSek: 500000 });
assert.equal(setResult.ok, true);
assert.equal(setResult.account.startingBalanceSek, 500000);
assert.equal(setResult.account.cashSek, 500000);
assert.equal(setResult.account.equitySek, 500000);
assert.equal(storage.readAccountConfig().startingBalanceSek, 500000);
assert.equal(svc.getFuturesPaperAccount().account.startingBalanceSek, 500000);

const resetResult = svc.resetFuturesPaperAccount({ reason: 'test_reset' });
assert.equal(resetResult.ok, true);
assert.equal(resetResult.account.startingBalanceSek, 500000);
assert.equal(resetResult.account.cashSek, 500000);
assert.equal(resetResult.account.equitySek, 500000);

const events = storage.readJsonl(storage.files.events);
assert.equal(events.length >= 2, true);
assert.equal(events[events.length - 2].type, 'FUTURES_ACCOUNT_SET_BALANCE');
assert.equal(events[events.length - 1].type, 'FUTURES_ACCOUNT_RESET');

const equityCurve = storage.readJsonl(storage.files.equityCurve);
assert.equal(equityCurve.length >= 2, true);

const fullAccount = svc.getFuturesPaperAccount();
assert.equal(Array.isArray(fullAccount.history.events), true);
assert.equal(Array.isArray(fullAccount.history.equityCurve), true);
assert.equal(fullAccount.history.events.length >= 2, true);
assert.equal(fullAccount.history.equityCurve.length >= 2, true);

const lightAccount = svc.getFuturesPaperAccount({ includeHistory: false });
assert.equal(lightAccount.ok, true);
assert.equal(lightAccount.account.startingBalanceSek, 500000);
assert.deepEqual(lightAccount.history, { events: [], equityCurve: [] });

const zeroHistoryAccount = svc.getFuturesPaperAccount({ historyLimit: 0 });
assert.equal(zeroHistoryAccount.ok, true);
assert.deepEqual(zeroHistoryAccount.history, { events: [], equityCurve: [] });

const limitedHistoryAccount = svc.getFuturesPaperAccount({ historyLimit: 1 });
assert.equal(limitedHistoryAccount.ok, true);
assert.equal(limitedHistoryAccount.history.events.length, 1);
assert.equal(limitedHistoryAccount.history.equityCurve.length, 1);

const invalid = svc.setFuturesPaperBalance({ startingBalanceSek: -1 });
assert.equal(invalid.ok, false);

console.log('futuresPaperAccountService.test.js passed');
