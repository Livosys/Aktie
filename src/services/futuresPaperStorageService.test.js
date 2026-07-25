'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = require.resolve('./futuresPaperStorageService');
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '../../data/futures-paper');
const ORIGINAL_ENV = process.env.FUTURES_PAPER_DATA_DIR;
const tempDirs = [];

function tempDir(prefix = 'futures-paper-storage-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function setEnv(value) {
  if (value === undefined) delete process.env.FUTURES_PAPER_DATA_DIR;
  else process.env.FUTURES_PAPER_DATA_DIR = value;
}

function loadStorage(value) {
  setEnv(value);
  delete require.cache[MODULE_PATH];
  return require('./futuresPaperStorageService');
}

function restoreEnv() {
  setEnv(ORIGINAL_ENV);
  delete require.cache[MODULE_PATH];
}

function assertDefaultFiles(files, rootDir) {
  assert.equal(files.accountConfig, path.join(rootDir, 'account-config.json'));
  assert.equal(files.accountState, path.join(rootDir, 'account-state.json'));
  assert.equal(files.positions, path.join(rootDir, 'positions.json'));
  assert.equal(files.trades, path.join(rootDir, 'trades.jsonl'));
  assert.equal(files.events, path.join(rootDir, 'events.jsonl'));
  assert.equal(files.equityCurve, path.join(rootDir, 'equity-curve.jsonl'));
}

try {
  // A + D: default root is unchanged when env is missing or whitespace.
  let mod = loadStorage(undefined);
  assert.equal(mod.DEFAULT_ROOT_DIR, DEFAULT_ROOT_DIR);
  assert.equal(mod.ROOT_DIR, DEFAULT_ROOT_DIR);
  assert.equal(mod.defaultFuturesPaperStorageService.rootDir, DEFAULT_ROOT_DIR);
  assertDefaultFiles(mod.FILES, DEFAULT_ROOT_DIR);
  assertDefaultFiles(mod.defaultFuturesPaperStorageService.files, DEFAULT_ROOT_DIR);

  mod = loadStorage('   \t  ');
  assert.equal(mod.ROOT_DIR, DEFAULT_ROOT_DIR);
  assert.equal(mod.defaultFuturesPaperStorageService.rootDir, DEFAULT_ROOT_DIR);

  // B: absolute env root sends default storage writes only to that directory.
  const envRoot = tempDir('futures-paper-storage-env-');
  const prodMarker = path.join(DEFAULT_ROOT_DIR, 'env-isolation-marker.json');
  assert.equal(fs.existsSync(prodMarker), false);

  mod = loadStorage(envRoot);
  assert.equal(mod.ROOT_DIR, envRoot);
  assert.equal(mod.defaultFuturesPaperStorageService.rootDir, envRoot);
  assertDefaultFiles(mod.FILES, envRoot);

  const envStorage = mod.defaultFuturesPaperStorageService;
  envStorage.ensureDefaults(
    { currency: 'SEK', startingBalanceSek: 250000, fxUsdSek: 10.5 },
    { currency: 'SEK', startingBalanceSek: 250000, cashSek: 250000, equitySek: 250000, updatedAt: '2026-07-06T00:00:00.000Z' },
  );
  mod.writeJson(path.join(envStorage.rootDir, 'env-isolation-marker.json'), { ok: true });
  assert.equal(fs.existsSync(path.join(envRoot, 'account-config.json')), true);
  assert.equal(fs.existsSync(path.join(envRoot, 'account-state.json')), true);
  assert.equal(fs.existsSync(path.join(envRoot, 'positions.json')), true);
  assert.equal(fs.existsSync(path.join(envRoot, 'trades.jsonl')), true);
  assert.equal(fs.existsSync(path.join(envRoot, 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(envRoot, 'equity-curve.jsonl')), true);
  assert.equal(fs.existsSync(path.join(envRoot, 'env-isolation-marker.json')), true);
  assert.equal(fs.existsSync(prodMarker), false);

  // C: relative env root is normalized with path.resolve.
  const relativeRoot = `tmp/futures-paper-storage-relative-${process.pid}`;
  mod = loadStorage(relativeRoot);
  assert.equal(mod.ROOT_DIR, path.resolve(relativeRoot));
  assert.equal(mod.defaultFuturesPaperStorageService.rootDir, path.resolve(relativeRoot));

  // Explicit rootDir instances still isolate writes from each other.
  const firstRoot = tempDir('futures-paper-storage-a-');
  const secondRoot = tempDir('futures-paper-storage-b-');
  mod = loadStorage(undefined);
  const first = mod.createFuturesPaperStorageService({ rootDir: firstRoot });
  const second = mod.createFuturesPaperStorageService({ rootDir: secondRoot });

  first.ensureDefaults(
    { currency: 'SEK', startingBalanceSek: 250000, fxUsdSek: 10.5 },
    { currency: 'SEK', startingBalanceSek: 250000, cashSek: 250000, equitySek: 250000, updatedAt: '2026-07-06T00:00:00.000Z' },
  );
  second.ensureDefaults(
    { currency: 'SEK', startingBalanceSek: 100000, fxUsdSek: 10.25 },
    { currency: 'SEK', startingBalanceSek: 100000, cashSek: 100000, equitySek: 100000, updatedAt: '2026-07-06T00:00:00.000Z' },
  );

  first.writeAccountConfig({ currency: 'SEK', startingBalanceSek: 500000, fxUsdSek: 10.75, updatedAt: '2026-07-06T11:00:00.000Z' });
  first.writeAccountState({ currency: 'SEK', startingBalanceSek: 500000, cashSek: 500000, equitySek: 500000, updatedAt: '2026-07-06T11:00:00.000Z' });
  first.writePositions({ open: [{ tradeId: 't-1' }], closed: [], updatedAt: '2026-07-06T11:00:00.000Z' });
  first.appendEvent({ eventId: 'evt-1', type: 'TEST', timestamp: '2026-07-06T11:00:00.000Z' });
  first.appendTrade({ tradeId: 'trade-1', type: 'CLOSED_TRADE', timestamp: '2026-07-06T11:00:00.000Z' });
  first.appendEquityCurve({ timestamp: '2026-07-06T11:00:00.000Z', equitySek: 500000 });

  second.writeAccountConfig({ currency: 'SEK', startingBalanceSek: 75000, fxUsdSek: 10.1, updatedAt: '2026-07-06T12:00:00.000Z' });
  second.writePositions({ open: [{ tradeId: 't-2' }], closed: [], updatedAt: '2026-07-06T12:00:00.000Z' });

  assert.equal(first.readAccountConfig().startingBalanceSek, 500000);
  assert.equal(first.readAccountState().equitySek, 500000);
  assert.equal(first.readPositions().open[0].tradeId, 't-1');
  assert.equal(first.readJsonl(first.files.events).length, 1);
  assert.equal(first.readTrades().length, 1);
  assert.equal(first.readJsonl(first.files.equityCurve).length, 1);

  assert.equal(second.readAccountConfig().startingBalanceSek, 75000);
  assert.equal(second.readPositions().open[0].tradeId, 't-2');
  assert.equal(second.readJsonl(second.files.events).length, 0);
  assert.equal(second.readTrades().length, 0);
  assert.deepEqual(fs.readdirSync(firstRoot).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(fs.readdirSync(secondRoot).filter((name) => name.endsWith('.tmp')), []);
} finally {
  restoreEnv();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('futuresPaperStorageService.test.js passed');
