'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT_DIR = path.resolve(__dirname, '../../data/futures-paper');

function resolveRootDirFromEnv() {
  const override = process.env.FUTURES_PAPER_DATA_DIR;
  if (typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  return DEFAULT_ROOT_DIR;
}

const ROOT_DIR = resolveRootDirFromEnv();
const FILES = Object.freeze({
  accountConfig: path.join(ROOT_DIR, 'account-config.json'),
  accountState: path.join(ROOT_DIR, 'account-state.json'),
  positions: path.join(ROOT_DIR, 'positions.json'),
  trades: path.join(ROOT_DIR, 'trades.jsonl'),
  events: path.join(ROOT_DIR, 'events.jsonl'),
  equityCurve: path.join(ROOT_DIR, 'equity-curve.jsonl'),
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function ensureDir(rootDir = ROOT_DIR) {
  fs.mkdirSync(rootDir, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return value;
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function appendJsonl(file, row) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function createFuturesPaperStorageService(options = {}) {
  const rootDir = options.rootDir || resolveRootDirFromEnv();
  const files = {
    accountConfig: path.join(rootDir, 'account-config.json'),
    accountState: path.join(rootDir, 'account-state.json'),
    positions: path.join(rootDir, 'positions.json'),
    trades: path.join(rootDir, 'trades.jsonl'),
    events: path.join(rootDir, 'events.jsonl'),
    equityCurve: path.join(rootDir, 'equity-curve.jsonl'),
  };

  function ensureRoot() {
    ensureDir(rootDir);
    return rootDir;
  }

  function ensureDefaults(defaultConfig, defaultState, defaultPositions = { open: [], closed: [], updatedAt: null }) {
    ensureRoot();
    if (!fs.existsSync(files.accountConfig)) writeJson(files.accountConfig, defaultConfig);
    if (!fs.existsSync(files.accountState)) writeJson(files.accountState, defaultState);
    if (!fs.existsSync(files.positions)) writeJson(files.positions, defaultPositions);
    if (!fs.existsSync(files.trades)) fs.writeFileSync(files.trades, '', 'utf8');
    if (!fs.existsSync(files.events)) fs.writeFileSync(files.events, '', 'utf8');
    if (!fs.existsSync(files.equityCurve)) fs.writeFileSync(files.equityCurve, '', 'utf8');
  }

  function readAccountConfig(fallback = null) {
    return readJson(files.accountConfig, fallback);
  }

  function readAccountState(fallback = null) {
    return readJson(files.accountState, fallback);
  }

  function writeAccountConfig(value) {
    return writeJson(files.accountConfig, value);
  }

  function writeAccountState(value) {
    return writeJson(files.accountState, value);
  }

  function readPositions(fallback = { open: [], closed: [], updatedAt: null }) {
    return readJson(files.positions, fallback);
  }

  function writePositions(value) {
    return writeJson(files.positions, value);
  }

  function appendEvent(row) {
    return appendJsonl(files.events, row);
  }

  function readTrades() {
    return readJsonl(files.trades);
  }

  function appendTrade(row) {
    return appendJsonl(files.trades, row);
  }

  function appendEquityCurve(row) {
    return appendJsonl(files.equityCurve, row);
  }

  return {
    rootDir,
    files,
    ensureRoot,
    ensureDefaults,
    readJson,
    readAccountConfig,
    readAccountState,
    writeAccountConfig,
    writeAccountState,
    readPositions,
    writePositions,
    readJsonl,
    appendEvent,
    readTrades,
    appendTrade,
    appendEquityCurve,
  };
}

const defaultFuturesPaperStorageService = createFuturesPaperStorageService();

module.exports = {
  DEFAULT_ROOT_DIR,
  ROOT_DIR,
  FILES,
  resolveRootDirFromEnv,
  nowIso,
  ensureDir,
  readJson,
  writeJson,
  readJsonl,
  appendJsonl,
  createFuturesPaperStorageService,
  defaultFuturesPaperStorageService,
};
