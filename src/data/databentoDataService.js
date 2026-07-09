'use strict';

const axios = require('axios');
const { withProviderRetry } = require('../providerStatus');

// ── Databento historical data client (READ-ONLY market data) ──────────────────
// Fetches CME Globex OHLCV-1m bars for US micro futures (MNQ/MES) to backfill the
// replay candle store. This client NEVER places orders, touches a broker, or
// enables live trading — it only reads historical bars.
//
// INERT BY DEFAULT: DATABENTO_ENABLED must be explicitly 'true' AND
// DATABENTO_API_KEY must be set, otherwise every fetch throws before any network
// call is made. No credentials are required to load or unit-test this module.
//
// Env:
//   DATABENTO_ENABLED    'true' to enable (default: false/disabled)
//   DATABENTO_API_KEY    Databento API key (HTTP Basic username, empty password)
//   DATABENTO_DATASET    default 'GLBX.MDP3' (CME Globex)
//   DATABENTO_BASE_URL   default 'https://hist.databento.com/v0'

const DEFAULT_BASE = 'https://hist.databento.com/v0';
const DEFAULT_DATASET = 'GLBX.MDP3';
const SCHEMA = 'ohlcv-1m';
const PRICE_SCALE = 1e9;   // Databento prices are int64 fixed-point (× 1e-9).
const NS_PER_MS = 1_000_000n;

// Internal root symbol -> Databento continuous front-month (by volume) symbol.
const ROOT_TO_CONTINUOUS = Object.freeze({
  MNQ: 'MNQ.v.0',
  MES: 'MES.v.0',
});

function dataBase() {
  return (process.env.DATABENTO_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

function dataset() {
  return process.env.DATABENTO_DATASET || DEFAULT_DATASET;
}

// Default DISABLED — opposite of the Alpaca client. Must be explicitly 'true'.
function isEnabled() {
  return String(process.env.DATABENTO_ENABLED || '').toLowerCase() === 'true';
}

function hasCredentials() {
  return !!process.env.DATABENTO_API_KEY;
}

function rootToContinuous(root) {
  const key = String(root || '').trim().toUpperCase();
  return ROOT_TO_CONTINUOUS[key] || null;
}

function continuousToRoot(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) return '';
  // 'MNQ.V.0' -> 'MNQ'
  return s.split('.')[0] || s;
}

// Prices are int64 scaled by 1e-9. Divide to get the real price.
function scalePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n / PRICE_SCALE : null;
}

// ts_event is int64 NANOSECONDS (~1.7e18 for current dates), which exceeds
// Number.MAX_SAFE_INTEGER — use BigInt so no precision is lost before ÷ 1e6.
function nsToIso(ns) {
  if (ns === null || ns === undefined || ns === '') return null;
  try {
    const big = typeof ns === 'bigint'
      ? ns
      : BigInt(typeof ns === 'number' ? Math.trunc(ns) : String(ns).trim());
    const ms = Number(big / NS_PER_MS);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  } catch (_) {
    const n = Number(ns);
    return Number.isFinite(n) ? new Date(Math.round(n / 1e6)).toISOString() : null;
  }
}

// Normalize one Databento OHLCV record into the store bar shape { t, o, h, l, c, v }.
// Accepts flat records ({ ts_event, open, ... }) or nested header ({ hd: { ts_event } }).
function normalizeDatabentoRecord(rec = {}, symbol) {
  const tsEventNs = rec.ts_event !== undefined && rec.ts_event !== null
    ? rec.ts_event
    : (rec.hd ? rec.hd.ts_event : null);
  const ts = nsToIso(tsEventNs);
  const o = scalePrice(rec.open);
  const h = scalePrice(rec.high);
  const l = scalePrice(rec.low);
  const c = scalePrice(rec.close);
  const vNum = Number(rec.volume);
  const v = Number.isFinite(vNum) ? vNum : 0;
  return {
    ts,
    t: ts,
    o, h, l, c, v,
    open: o, high: h, low: l, close: c, volume: v,
    source: 'databento',
    symbol: continuousToRoot(symbol) || symbol,
    timeframe: '1m',
  };
}

function normalizeDatabentoRecords(records = [], symbol) {
  const list = Array.isArray(records) ? records : [];
  return list
    .map((r) => normalizeDatabentoRecord(r, symbol))
    .filter((b) => b.ts
      && Number.isFinite(b.o) && Number.isFinite(b.h)
      && Number.isFinite(b.l) && Number.isFinite(b.c));
}

// Databento get_range (encoding=json) returns newline-delimited JSON records.
// Also tolerate an already-parsed array or a single object.
function parseRecords(data) {
  if (Array.isArray(data)) return data;
  if (typeof data === 'string') {
    return data
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  }
  if (data && typeof data === 'object') return [data];
  return [];
}

/**
 * Fetch historical OHLCV-1m bars for a US micro future root (MNQ/MES).
 * Always returns normalized 1-minute bars; the import service aggregates to 2m.
 * Throws (before any network call) when disabled or missing credentials.
 */
async function fetchDatabentoBars({ symbol, timeframe = '1Min', start, end }) {
  if (!isEnabled()) {
    throw new Error('DATABENTO_ENABLED is not true — Databento data service is disabled');
  }
  if (!hasCredentials()) {
    throw new Error('Databento API key missing (set DATABENTO_API_KEY in .env)');
  }
  if (!symbol || !start || !end) {
    throw new Error('fetchDatabentoBars requires symbol, start, and end');
  }
  const continuous = rootToContinuous(symbol);
  if (!continuous) {
    throw new Error(`No Databento continuous-contract mapping for symbol ${symbol}`);
  }

  const url = `${dataBase()}/timeseries.get_range`;
  const params = {
    dataset: dataset(),
    schema: SCHEMA,
    stype_in: 'continuous',
    symbols: continuous,
    start,
    end,
    encoding: 'json',
  };

  let res;
  try {
    res = await withProviderRetry('databento', () => axios.get(url, {
      params,
      auth: { username: process.env.DATABENTO_API_KEY, password: '' },
      timeout: 20000,
      responseType: 'text',
    }), { context: { symbol, endpoint: 'timeseries.get_range' } });
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.detail || err?.response?.data?.message || err.message || 'unknown';
    throw new Error(`Databento API error (HTTP ${status || 'network'}): ${msg}`);
  }

  return normalizeDatabentoRecords(parseRecords(res.data), symbol);
}

module.exports = {
  fetchDatabentoBars,
  isEnabled,
  hasCredentials,
  rootToContinuous,
  continuousToRoot,
  scalePrice,
  nsToIso,
  normalizeDatabentoRecord,
  normalizeDatabentoRecords,
  parseRecords,
  ROOT_TO_CONTINUOUS,
};
