'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./filePersistenceService');

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
  return writeJsonAtomic(file, value);
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

/**
 * De SISTA `limit` raderna i en JSONL-fil, utan att läsa resten.
 *
 * Händelseloggen för futures-paper är 136 MB på 31 000 rader. Både
 * kontovyn och ledgern läste hela filen och tog sedan `.slice(-20)` — samma
 * svar, men 30 sekunders JSON.parse per läsning, och de gjordes fyra gånger
 * per bygge av Handelstest-vyn. Det var hela orsaken till att den vyn tog
 * över två minuter att bygga.
 *
 * Läser bakifrån i block tills tillräckligt många radbrytningar hittats.
 * Identiskt resultat med readJsonl(file).slice(-limit) — trasiga rader
 * hoppas över på samma sätt.
 */
function readJsonlTail(file, limit) {
  const wanted = Math.max(0, Math.floor(Number(limit) || 0));
  if (!wanted) return [];
  let fd = null;
  try {
    if (!fs.existsSync(file)) return [];
    const size = fs.statSync(file).size;
    if (!size) return [];
    fd = fs.openSync(file, 'r');

    // Blocket växer tills det rymmer så många rader vi vill ha, eller tills
    // hela filen är läst. Startgissningen är generös; en rad här är stor.
    let block = 256 * 1024;
    let text = '';
    let start = size;
    while (start > 0) {
      start = Math.max(0, size - block);
      const length = size - start;
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, start);
      text = buffer.toString('utf8');
      // En rad mer än vi behöver: den första raden i blocket kan vara avhuggen
      // och kastas därför bort så länge vi inte står vid filens början.
      const newlines = (text.match(/\n/g) || []).length;
      if (newlines > wanted || start === 0) break;
      block *= 4;
    }

    let lines = text.split('\n');
    if (start > 0) lines = lines.slice(1);
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-wanted)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* stängd redan */ } }
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
    readJsonlTail,
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
  readJsonlTail,
  appendJsonl,
  createFuturesPaperStorageService,
  defaultFuturesPaperStorageService,
};
