'use strict';

// ---------------------------------------------------------------------------
// Candle Snapshot Read Service — READ-ONLY
// ---------------------------------------------------------------------------
// Loads recorded 1m/2m candle snapshots (written by candleSnapshotRecorder) for
// analysis/coverage use. Pure filesystem read: NEVER writes, NEVER records,
// NEVER touches the trading path, exit engine, or runtime state.
//
// Layout read (matches candleSnapshotRecorderService):
//   <storageRoot>/<YYYY-MM-DD>/candles-<timeframe>.jsonl
// Each line: { symbol, candleTime, open, high, low, close, ... }
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { readJsonlTail } = require('./readOnlyJsonlTailService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  read_only: true,
});

const DEFAULT_STORAGE_ROOT = path.resolve(__dirname, '../../data/candle-snapshots');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_MS = 60_000;

function resolveStorageRoot(override) {
  if (override) return String(override);
  if (process.env.CANDLE_SNAPSHOT_RECORDER_DIR) return String(process.env.CANDLE_SNAPSHOT_RECORDER_DIR);
  return DEFAULT_STORAGE_ROOT;
}

function tsOf(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// List available day directories (sorted ascending), optionally clipped to a
// [sinceMs, untilMs] window so we only ever read the days we need.
function listDays(storageRoot, { sinceMs = null, untilMs = null } = {}) {
  let entries;
  try { entries = fs.readdirSync(storageRoot, { withFileTypes: true }); }
  catch (_) { return []; }
  const days = entries
    .filter((e) => e.isDirectory() && DAY_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  if (sinceMs == null && untilMs == null) return days;
  // Keep a day if its UTC span could overlap the requested window (± a day of slack).
  return days.filter((d) => {
    const dayStart = Date.parse(`${d}T00:00:00.000Z`);
    const dayEnd = dayStart + 86_400_000;
    if (sinceMs != null && dayEnd < sinceMs - 86_400_000) return false;
    if (untilMs != null && dayStart > untilMs + 86_400_000) return false;
    return true;
  });
}

// Load candles into a Map<symbol, sorted [{t,o,h,l,c}]>. Deduped by
// symbol|candleTime. Bounded per-file via readJsonlTail.
function loadSeries(options = {}) {
  const timeframe = options.timeframe === '2m' ? '2m' : '1m';
  const storageRoot = resolveStorageRoot(options.storageRoot);
  const symbolFilter = Array.isArray(options.symbols) && options.symbols.length
    ? new Set(options.symbols) : null;
  const sinceMs = options.sinceMs != null ? Number(options.sinceMs) : null;
  const untilMs = options.untilMs != null ? Number(options.untilMs) : null;
  const maxBytesPerFile = options.maxBytesPerFile || 16 * 1024 * 1024;

  const warnings = [];
  let partial = false;
  const days = listDays(storageRoot, { sinceMs, untilMs });
  const bySymbol = new Map();
  const seen = new Set();

  for (const day of days) {
    const file = path.join(storageRoot, day, `candles-${timeframe}.jsonl`);
    const tail = readJsonlTail(file, { maxBytes: maxBytesPerFile, maxLines: 200_000 });
    if (tail.partial) partial = true;
    if (tail.warnings && tail.warnings.length) warnings.push(...tail.warnings);
    for (const c of tail.rows) {
      const symbol = c.symbol;
      if (!symbol) continue;
      if (symbolFilter && !symbolFilter.has(symbol)) continue;
      const t = tsOf(c.candleTime);
      if (t == null) continue;
      if (sinceMs != null && t < sinceMs - MINUTE_MS) continue;
      if (untilMs != null && t > untilMs + MINUTE_MS) continue;
      const key = `${symbol}|${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const o = num(c.open); const h = num(c.high); const l = num(c.low); const cl = num(c.close);
      if (o == null || h == null || l == null || cl == null) continue;
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
      bySymbol.get(symbol).push({ t, o, h, l, c: cl });
    }
  }
  for (const arr of bySymbol.values()) arr.sort((a, b) => a.t - b.t);

  return { bySymbol, days, timeframe, storageRoot, partial, warnings };
}

// Coverage span across all loaded symbols.
function coverageSpan(bySymbol) {
  let firstMs = null; let lastMs = null; const symbols = [];
  for (const [sym, arr] of bySymbol.entries()) {
    if (!arr.length) continue;
    symbols.push(sym);
    if (firstMs == null || arr[0].t < firstMs) firstMs = arr[0].t;
    if (lastMs == null || arr[arr.length - 1].t > lastMs) lastMs = arr[arr.length - 1].t;
  }
  return { firstMs, lastMs, symbols };
}

// Slice a symbol's series to candles whose minute falls in [fromMs, toMs].
function sliceSeries(series, fromMs, toMs) {
  if (!Array.isArray(series) || !series.length) return [];
  const a = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS;
  const b = Math.floor(toMs / MINUTE_MS) * MINUTE_MS;
  return series.filter((c) => c.t >= a && c.t <= b);
}

module.exports = {
  SAFETY,
  DEFAULT_STORAGE_ROOT,
  MINUTE_MS,
  resolveStorageRoot,
  listDays,
  loadSeries,
  coverageSpan,
  sliceSeries,
};
