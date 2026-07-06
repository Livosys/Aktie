'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-storage-'));
const storage = createFuturesPaperStorageService({ rootDir });

storage.ensureDefaults(
  { currency: 'SEK', startingBalanceSek: 250000, fxUsdSek: 10.5 },
  { currency: 'SEK', startingBalanceSek: 250000, cashSek: 250000, equitySek: 250000, updatedAt: '2026-07-06T00:00:00.000Z' }
);

assert.equal(fs.existsSync(storage.files.accountConfig), true);
assert.equal(fs.existsSync(storage.files.accountState), true);
assert.equal(fs.existsSync(storage.files.positions), true);
assert.equal(fs.existsSync(storage.files.trades), true);
assert.equal(fs.existsSync(storage.files.events), true);
assert.equal(fs.existsSync(storage.files.equityCurve), true);

const config = storage.readAccountConfig();
const state = storage.readAccountState();

assert.equal(config.startingBalanceSek, 250000);
assert.equal(state.equitySek, 250000);

storage.writeAccountConfig({ currency: 'SEK', startingBalanceSek: 500000, fxUsdSek: 10.75, updatedAt: '2026-07-06T11:00:00.000Z' });
storage.writeAccountState({ currency: 'SEK', startingBalanceSek: 500000, cashSek: 500000, equitySek: 500000, updatedAt: '2026-07-06T11:00:00.000Z' });
storage.writePositions({ open: [{ tradeId: 't-1' }], closed: [], updatedAt: '2026-07-06T11:00:00.000Z' });
storage.appendEvent({ eventId: 'evt-1', type: 'TEST', timestamp: '2026-07-06T11:00:00.000Z' });
storage.appendTrade({ tradeId: 'trade-1', type: 'CLOSED_TRADE', timestamp: '2026-07-06T11:00:00.000Z' });
storage.appendEquityCurve({ timestamp: '2026-07-06T11:00:00.000Z', equitySek: 500000 });

assert.equal(storage.readAccountConfig().startingBalanceSek, 500000);
assert.equal(storage.readAccountState().equitySek, 500000);
assert.equal(storage.readPositions().open.length, 1);
assert.equal(storage.readJsonl(storage.files.events).length, 1);
assert.equal(storage.readTrades().length, 1);
assert.equal(storage.readJsonl(storage.files.equityCurve).length, 1);

console.log('futuresPaperStorageService.test.js passed');
