'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_STORAGE_ROOT = path.join(ROOT, 'data/candle-snapshots');
const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  read_only: true,
});

const fileStateCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isEnabled() {
  const raw = safeString(process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED).toLowerCase();
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function getStorageRoot() {
  return safeString(process.env.CANDLE_SNAPSHOT_RECORDER_DIR) || DEFAULT_STORAGE_ROOT;
}

function normalizeTimeframe(timeframe) {
  const tf = safeString(timeframe).toLowerCase();
  return ['1m', '2m'].includes(tf) ? tf : null;
}

function normalizeSource(source) {
  const value = safeString(source);
  return value || 'scanner';
}

function normalizeSymbol(symbol) {
  const value = safeString(symbol).toUpperCase();
  return value || null;
}

function normalizeRecordedAt(value) {
  return safeIso(value) || nowIso();
}

function normalizeCandle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candleTime = safeIso(raw.candleTime || raw.timestamp || raw.ts || raw.t || raw.time || raw.datetime || null);
  const open = safeNumber(raw.open ?? raw.o ?? raw.Open ?? null);
  const high = safeNumber(raw.high ?? raw.h ?? raw.High ?? null);
  const low = safeNumber(raw.low ?? raw.l ?? raw.Low ?? null);
  const close = safeNumber(raw.close ?? raw.c ?? raw.Close ?? null);
  const volume = safeNumber(raw.volume ?? raw.v ?? raw.Volume ?? null);

  if (!candleTime || open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    candleTime,
    open,
    high,
    low,
    close,
    volume,
  };
}

function filePathFor({ recordedAt, timeframe }) {
  const day = normalizeRecordedAt(recordedAt).slice(0, 10);
  return path.join(getStorageRoot(), day, `candles-${timeframe}.jsonl`);
}

function fileKey(filePath) {
  return path.resolve(filePath);
}

function loadFileState(filePath) {
  const key = fileKey(filePath);
  const cached = fileStateCache.get(key);
  if (cached?.loaded) return cached;

  const state = cached || {
    loaded: true,
    seen: new Set(),
    recordCount: 0,
    latestRecordedAt: null,
  };

  try {
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          const symbol = normalizeSymbol(record.symbol);
          const timeframe = normalizeTimeframe(record.timeframe);
          const candleTime = safeIso(record.candleTime);
          if (!symbol || !timeframe || !candleTime) continue;
          state.seen.add(`${symbol}|${timeframe}|${candleTime}`);
          state.recordCount += 1;
          const recordedAt = record.recordedAt || record.recorded_at || candleTime;
          if (!state.latestRecordedAt || String(recordedAt) > String(state.latestRecordedAt)) {
            state.latestRecordedAt = normalizeRecordedAt(recordedAt);
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    state.lastError = err?.message || String(err);
  }

  fileStateCache.set(key, state);
  return state;
}

function appendJsonl(filePath, lines) {
  if (!lines.length) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

function buildRecord({ recordedAt, source, symbol, timeframe, candle }) {
  return {
    recordedAt: normalizeRecordedAt(recordedAt),
    source: normalizeSource(source),
    symbol: normalizeSymbol(symbol),
    timeframe: normalizeTimeframe(timeframe),
    candleTime: candle.candleTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

function recordCandleSnapshots({ recordedAt, source, symbol, timeframe, candles }) {
  const enabled = isEnabled();
  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      wrote: 0,
      deduped: 0,
      invalid: 0,
      path: null,
      latestRecordedAt: null,
    };
  }

  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const inputCandles = Array.isArray(candles) ? candles : [];

  if (!normalizedSymbol || !normalizedTimeframe || !inputCandles.length) {
    return {
      ok: true,
      enabled: true,
      wrote: 0,
      deduped: 0,
      invalid: inputCandles.length ? 0 : 0,
      path: null,
      latestRecordedAt: null,
      reason: 'invalid_input',
    };
  }

  const targetPath = filePathFor({ recordedAt, timeframe: normalizedTimeframe });
  const state = loadFileState(targetPath);
  const lines = [];
  let wrote = 0;
  let deduped = 0;
  let invalid = 0;
  const batchRecordedAt = normalizeRecordedAt(recordedAt);

  for (const rawCandle of inputCandles) {
    const candle = normalizeCandle(rawCandle);
    if (!candle) {
      invalid += 1;
      continue;
    }
    const key = `${normalizedSymbol}|${normalizedTimeframe}|${candle.candleTime}`;
    if (state.seen.has(key)) {
      deduped += 1;
      continue;
    }
    state.seen.add(key);
    const record = buildRecord({
      recordedAt: batchRecordedAt,
      source,
      symbol: normalizedSymbol,
      timeframe: normalizedTimeframe,
      candle,
    });
    lines.push(JSON.stringify(record));
    wrote += 1;
    state.recordCount += 1;
    if (!state.latestRecordedAt || record.recordedAt > state.latestRecordedAt) {
      state.latestRecordedAt = record.recordedAt;
    }
  }

  try {
    appendJsonl(targetPath, lines);
    return {
      ok: true,
      enabled: true,
      wrote,
      deduped,
      invalid,
      path: targetPath,
      latestRecordedAt: state.latestRecordedAt,
    };
  } catch (err) {
    return {
      ok: false,
      enabled: true,
      wrote: 0,
      deduped,
      invalid,
      path: targetPath,
      error: err?.message || String(err),
    };
  }
}

function queueCandleSnapshots(payload) {
  if (!isEnabled()) {
    return {
      ok: true,
      enabled: false,
      queued: false,
    };
  }

  setImmediate(() => {
    try {
      recordCandleSnapshots(payload);
    } catch (err) {
      console.warn('[candle-snapshot-recorder] write failed:', err?.message || String(err));
    }
  });

  return {
    ok: true,
    enabled: true,
    queued: true,
  };
}

function readFileStats(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim());
    const stats = {
      filePath,
      records: 0,
      byTimeframe: {},
      latestRecordedAt: null,
      latestSymbols: [],
    };
    const symbolOrder = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const symbol = normalizeSymbol(record.symbol);
        const timeframe = normalizeTimeframe(record.timeframe);
        const recordedAt = normalizeRecordedAt(record.recordedAt || record.recorded_at || record.candleTime);
        if (!symbol || !timeframe) continue;
        stats.records += 1;
        stats.byTimeframe[timeframe] = (stats.byTimeframe[timeframe] || 0) + 1;
        if (!stats.latestRecordedAt || recordedAt > stats.latestRecordedAt) {
          stats.latestRecordedAt = recordedAt;
        }
        symbolOrder.push(symbol);
      } catch (_) {}
    }
    stats.latestSymbols = Array.from(new Set(symbolOrder.reverse())).slice(0, 5);
    return stats;
  } catch (_) {
    return null;
  }
}

function getStatus() {
  const enabled = isEnabled();
  const storageRoot = getStorageRoot();
  const today = new Date().toISOString().slice(0, 10);
  const todayDir = path.join(storageRoot, today);
  const todayStats = {
    date: today,
    records: 0,
    byTimeframe: { '1m': 0, '2m': 0 },
    latestRecordedAt: null,
    latestSymbols: [],
  };

  try {
    if (fs.existsSync(todayDir)) {
      const files = fs.readdirSync(todayDir).filter((name) => /^candles-(1m|2m)\.jsonl$/.test(name));
      const symbolOrder = [];
      for (const file of files) {
        const timeframe = file.includes('candles-1m') ? '1m' : '2m';
        const stats = readFileStats(path.join(todayDir, file));
        if (!stats) continue;
        todayStats.records += stats.records;
        todayStats.byTimeframe[timeframe] += stats.records;
        if (!todayStats.latestRecordedAt || (stats.latestRecordedAt && stats.latestRecordedAt > todayStats.latestRecordedAt)) {
          todayStats.latestRecordedAt = stats.latestRecordedAt;
        }
        symbolOrder.push(...stats.latestSymbols);
      }
      todayStats.latestSymbols = Array.from(new Set(symbolOrder)).slice(0, 5);
    }
  } catch (_) {}

  let latestRecordedAt = null;
  const recentFiles = [];
  try {
    if (fs.existsSync(storageRoot)) {
      const days = fs.readdirSync(storageRoot).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
      for (const day of days) {
        const dayDir = path.join(storageRoot, day);
        const files = fs.readdirSync(dayDir).filter((name) => /^candles-(1m|2m)\.jsonl$/.test(name)).sort();
        for (const file of files) {
          const stats = readFileStats(path.join(dayDir, file));
          if (!stats) continue;
          if (!latestRecordedAt || (stats.latestRecordedAt && stats.latestRecordedAt > latestRecordedAt)) {
            latestRecordedAt = stats.latestRecordedAt;
          }
          if (recentFiles.length < 5) {
            recentFiles.push({
              date: day,
              timeframe: file.includes('candles-1m') ? '1m' : '2m',
              records: stats.records,
              latestRecordedAt: stats.latestRecordedAt,
            });
          }
        }
      }
    }
  } catch (_) {}

  return {
    ok: true,
    enabled,
    readOnly: true,
    storagePath: storageRoot,
    safety: SAFETY,
    latestRecordedAt,
    today: todayStats,
    recentFiles,
  };
}

module.exports = {
  SAFETY,
  isEnabled,
  getStorageRoot,
  normalizeCandle,
  recordCandleSnapshots,
  queueCandleSnapshots,
  getStatus,
};
