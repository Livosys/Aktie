'use strict';
const fs   = require('fs');
const path = require('path');

const ALPACA_ROOT    = path.resolve(__dirname, '../../data/market-data/alpaca');
const BINANCE_ROOT   = path.resolve(__dirname, '../../data/market-data/binance');
// Shared 2m candle store (used by both Alpaca and Binance going forward)
const CANDLES_2M_ROOT = path.resolve(__dirname, '../../data/market-data/candles-2m');

// Legacy alias — code that hasn't been updated still uses DATA_ROOT
const DATA_ROOT = ALPACA_ROOT;

// ── Path helpers ──────────────────────────────────────────────────────────────

function rawDir(symbol, source = 'alpaca') {
  const root = source === 'binance' ? BINANCE_ROOT : ALPACA_ROOT;
  return path.join(root, 'raw', symbol);
}
function candles2mDir(symbol) { return path.join(CANDLES_2M_ROOT, symbol); }
// Legacy Alpaca-only 2m path — kept for backward-compat reads
function legacyCandles2mDir(symbol) { return path.join(ALPACA_ROOT, 'candles-2m', symbol); }

function dirForTimeframe(symbol, timeframe) {
  return timeframe === 'raw' ? rawDir(symbol) : candles2mDir(symbol);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function filePath(dir, date) { return path.join(dir, `${date}.jsonl`); }

// ── JSONL read / write ────────────────────────────────────────────────────────

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  try {
    return fs.readFileSync(fp, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function timestampMs(row = {}) {
  const raw = row.ts || row.t || row.timestamp;
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeTimestamp(row = {}) {
  const ms = timestampMs(row);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeStoredCandle(row = {}) {
  const ts = normalizeTimestamp(row);
  if (!ts) return null;
  return { ...row, ts, t: ts };
}

function dedupeByTimestamp(rows = []) {
  const merged = new Map();
  for (const row of rows) {
    const normalized = normalizeStoredCandle(row);
    if (!normalized) continue;
    merged.set(normalized.ts, normalized);
  }
  return [...merged.values()].sort((a, b) => timestampMs(a) - timestampMs(b));
}

function writeSorted(fp, bars) {
  const sorted = dedupeByTimestamp(bars);

  try {
    const lines = sorted.map((b) => JSON.stringify(b)).join('\n') + '\n';
    fs.writeFileSync(fp, lines, 'utf8');
    return sorted.length;
  } catch (err) {
    console.warn(`[MarketDataStore] Write failed (${fp}):`, err.message);
    return 0;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save raw 1m bars for a symbol/date.
 * Merges with existing file to avoid duplicates.
 * @param {string} source - 'alpaca' | 'binance' (default 'alpaca')
 * Returns number of bars written, or -1 on error.
 */
function saveRawBars(symbol, date, bars, source = 'alpaca') {
  try {
    const dir = rawDir(symbol, source);
    ensureDir(dir);
    const fp       = filePath(dir, date);
    const existing = readJsonl(fp);
    return writeSorted(fp, [...existing, ...bars]);
  } catch (err) {
    console.warn(`[MarketDataStore] saveRawBars(${symbol}, ${date}):`, err.message);
    return -1;
  }
}

/**
 * Save 2m candles for a symbol/date to the shared candles-2m store.
 * Also mirrors to legacy alpaca/candles-2m path so existing code keeps working.
 * Returns number of candles written, or -1 on error.
 */
function saveCandles2m(symbol, date, bars) {
  try {
    const dir = candles2mDir(symbol);
    ensureDir(dir);
    const fp       = filePath(dir, date);
    const existing = readJsonl(fp);
    return writeSorted(fp, [...existing, ...bars]);
  } catch (err) {
    console.warn(`[MarketDataStore] saveCandles2m(${symbol}, ${date}):`, err.message);
    return -1;
  }
}

/**
 * Load candles for a symbol across a date range.
 * For '2m' timeframe: checks new shared path first, falls back to legacy alpaca/candles-2m/.
 *
 * @param {string} symbol
 * @param {string} start     - "YYYY-MM-DD"
 * @param {string} end       - "YYYY-MM-DD"
 * @param {string} timeframe - "raw" | "2m"  (default "2m")
 * @returns {Array} sorted bars
 */
function loadCandles(symbol, start, end, timeframe = '2m') {
  const dates = getDatesInRange(start, end);
  const all   = [];

  for (const date of dates) {
    let bars = [];
    if (timeframe === '2m') {
      const newPath    = filePath(candles2mDir(symbol), date);
      const legacyPath = filePath(legacyCandles2mDir(symbol), date);
      if (fs.existsSync(newPath)) {
        bars = readJsonl(newPath);
      } else if (fs.existsSync(legacyPath)) {
        bars = readJsonl(legacyPath);
      }
    } else {
      bars = readJsonl(filePath(dirForTimeframe(symbol, timeframe), date));
    }
    all.push(...bars);
  }

  return dedupeByTimestamp(all);
}

/**
 * Check whether any data exists for a symbol/date/timeframe.
 */
function hasData(symbol, date, timeframe = '2m') {
  if (timeframe === '2m') {
    const newPath    = filePath(candles2mDir(symbol), date);
    const legacyPath = filePath(legacyCandles2mDir(symbol), date);
    if (fs.existsSync(newPath)    && readJsonl(newPath).length    > 0) return true;
    if (fs.existsSync(legacyPath) && readJsonl(legacyPath).length > 0) return true;
    return false;
  }
  const fp = filePath(dirForTimeframe(symbol, timeframe), date);
  return fs.existsSync(fp) && readJsonl(fp).length > 0;
}

function readdirDates(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace('.jsonl', ''))
      .sort();
  } catch { return []; }
}

/**
 * List all dates that have data for a symbol.
 * 2m: merges shared + legacy paths (deduped, sorted).
 * raw: merges alpaca + binance raw paths.
 * @returns {{ raw: string[], '2m': string[] }}
 */
function listAvailableDates(symbol) {
  const raw2m   = readdirDates(candles2mDir(symbol));
  const legacy2m = readdirDates(legacyCandles2mDir(symbol));
  const merged2m = [...new Set([...raw2m, ...legacy2m])].sort();

  const rawAlpaca  = readdirDates(rawDir(symbol, 'alpaca'));
  const rawBinance = readdirDates(rawDir(symbol, 'binance'));
  const mergedRaw  = [...new Set([...rawAlpaca, ...rawBinance])].sort();

  return { raw: mergedRaw, '2m': merged2m };
}

/**
 * List all symbols that have any market data stored.
 * Checks: shared 2m, legacy alpaca 2m, alpaca raw, binance raw.
 */
function listSymbols() {
  const symbols = new Set();
  const dirs = [
    CANDLES_2M_ROOT,
    path.join(ALPACA_ROOT,  'candles-2m'),
    path.join(ALPACA_ROOT,  'raw'),
    path.join(BINANCE_ROOT, 'raw'),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      try { fs.readdirSync(dir).forEach((s) => symbols.add(s)); } catch { /* ignore */ }
    }
  }
  return [...symbols].sort();
}

/**
 * Count candles for a symbol/date/timeframe.
 * For 2m: checks shared path first, then legacy.
 */
function countCandles(symbol, date, timeframe = '2m') {
  if (timeframe === '2m') {
    const newPath    = filePath(candles2mDir(symbol), date);
    const legacyPath = filePath(legacyCandles2mDir(symbol), date);
    if (fs.existsSync(newPath))    return readJsonl(newPath).length;
    if (fs.existsSync(legacyPath)) return readJsonl(legacyPath).length;
    return 0;
  }
  const fp = filePath(dirForTimeframe(symbol, timeframe), date);
  return readJsonl(fp).length;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function getDatesInRange(start, end) {
  const dates = [];
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end   + 'T00:00:00Z');
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

module.exports = {
  saveRawBars,
  saveCandles2m,
  loadCandles,
  hasData,
  listAvailableDates,
  listSymbols,
  countCandles,
  getDatesInRange,
  _internal: {
    normalizeTimestamp,
    dedupeByTimestamp,
  },
};
