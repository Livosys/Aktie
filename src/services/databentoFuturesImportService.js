'use strict';

const fs = require('fs');
const path = require('path');

const marketDataStore = require('../data/marketDataStore');
const { aggregate1mTo2m, filterComplete } = require('../data/candleAggregator');
const {
  fetchDatabentoBars,
  isEnabled,
  hasCredentials,
} = require('../data/databentoDataService');

// ── Databento futures backfill (READ-ONLY historical market data) ─────────────
// Backfills the replay candle store (candles-2m/<SYMBOL>/) for US micro futures
// MNQ/MES via Databento. Mirrors alpacaHistorical2mImportService but:
//   - fetches OHLCV-1m and aggregates to 2m (Databento schema is 1m),
//   - iterates CALENDAR dates (CME Globex trades ~23h/day Sun–Fri), not weekdays.
//
// INERT BY DEFAULT: buildPlan/runImport only ever perform a dry-run unless the
// caller passes execute:true AND DATABENTO_ENABLED=true AND credentials exist.
// It never places orders, touches a broker, or enables live trading.

const DEFAULT_MANIFEST = path.resolve(__dirname, '../../data/market-data/imports/databento-2m-imports.jsonl');
const DEFAULT_SYMBOLS = ['MNQ', 'MES'];

const SAFETY = {
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function assertValidConfig({ from, to, symbols }) {
  const warnings = [];
  if (!isDate(from)) warnings.push('invalid_from_date');
  if (!isDate(to)) warnings.push('invalid_to_date');
  if (isDate(from) && isDate(to) && from > to) warnings.push('from_after_to');
  if (!Array.isArray(symbols) || symbols.length === 0) warnings.push('no_symbols');
  return warnings;
}

function normalizeCandleTimestamp(ts) {
  if (ts == null) return null;
  const ms = typeof ts === 'number'
    ? (ts < 1e12 ? ts * 1000 : ts)
    : new Date(ts).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeBar(bar = {}, symbol) {
  const ts = normalizeCandleTimestamp(bar.ts || bar.t || bar.timestamp);
  const open = bar.open !== undefined ? bar.open : bar.o;
  const high = bar.high !== undefined ? bar.high : bar.h;
  const low = bar.low !== undefined ? bar.low : bar.l;
  const close = bar.close !== undefined ? bar.close : bar.c;
  const volume = bar.volume !== undefined ? bar.volume : bar.v;
  return {
    ts,
    t: ts,
    o: Number(open),
    h: Number(high),
    l: Number(low),
    c: Number(close),
    v: Number(volume),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    incomplete: false,
    source: 'databento_2m_from_1m',
    symbol,
    timeframe: '2m',
  };
}

function isValidCandle(candle = {}) {
  const ts = candle.ts || candle.t;
  const values = [candle.o, candle.h, candle.l, candle.c, candle.v];
  if (!ts || Number.isNaN(Date.parse(ts))) return false;
  if (!values.every((n) => Number.isFinite(Number(n)))) return false;
  if (Number(candle.o) <= 0 || Number(candle.h) <= 0 || Number(candle.l) <= 0 || Number(candle.c) <= 0) return false;
  if (Number(candle.v) < 0) return false;
  if (Number(candle.h) < Math.max(Number(candle.o), Number(candle.c), Number(candle.l))) return false;
  if (Number(candle.l) > Math.min(Number(candle.o), Number(candle.c), Number(candle.h))) return false;
  return new Date(ts).getUTCMinutes() % 2 === 0;
}

function dedupeCandlesByTimestamp(candles = []) {
  const byTs = new Map();
  let duplicateCount = 0;
  for (const candle of candles) {
    const ts = normalizeCandleTimestamp(candle.ts || candle.t || candle.timestamp);
    if (!ts) continue;
    const normalized = { ...candle, ts, t: ts };
    if (byTs.has(ts)) duplicateCount += 1;
    byTs.set(ts, normalized);
  }
  return {
    candles: [...byTs.values()].sort((a, b) => new Date(a.ts) - new Date(b.ts)),
    duplicateCount,
  };
}

function groupByDate(candles = []) {
  const byDate = {};
  for (const candle of candles) {
    const date = String(candle.ts || candle.t || '').slice(0, 10);
    if (!date) continue;
    byDate[date] = byDate[date] || [];
    byDate[date].push(candle);
  }
  return byDate;
}

// CME Globex trades ~23h/day Sunday evening–Friday. Use calendar dates (all days)
// so we never drop weekend/overnight sessions the way a weekday filter would.
function calendarDatesInRange(from, to) {
  const dates = [];
  if (!isDate(from) || !isDate(to)) return dates;
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function mergeStats(existingCount, incomingCount, finalCount) {
  const written = Math.max(0, Number(finalCount || 0) - Number(existingCount || 0));
  return {
    candles_written: written,
    duplicates_skipped: Math.max(0, Number(incomingCount || 0) - written),
  };
}

function countDuplicateTimestamps(candles = []) {
  const seen = new Set();
  let duplicates = 0;
  for (const candle of candles) {
    const ts = normalizeCandleTimestamp(candle.ts || candle.t || candle.timestamp);
    if (!ts) continue;
    if (seen.has(ts)) duplicates += 1;
    else seen.add(ts);
  }
  return duplicates;
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

// Fetch 1m bars from Databento and aggregate to complete 2m candles.
async function fetchCandles2m(symbol, from, to, deps) {
  const bars = await deps.fetchDatabentoBars({ symbol, timeframe: '1Min', start: from, end: to });
  const candles = filterComplete(aggregate1mTo2m(bars)).map((bar) => normalizeBar(bar, symbol));
  return {
    sourceTimeframe: 'ohlcv-1m',
    fallbackUsed: false,
    rawFetched: bars.length,
    candles,
    warnings: bars.length ? [] : ['no_bars_returned'],
  };
}

function buildPlan(input = {}, deps = {}) {
  const args = {
    execute: !!input.execute,
    from: input.from || '2024-01-01',
    to: input.to || todayIso(),
    symbols: input.symbols && input.symbols.length ? input.symbols : DEFAULT_SYMBOLS,
  };
  args.symbols = [...new Set(args.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];

  const enabled = deps.isEnabled ? deps.isEnabled() : isEnabled();
  const configured = deps.hasCredentials ? deps.hasCredentials() : hasCredentials();
  const warnings = assertValidConfig(args);
  if (!enabled) warnings.push('DATABENTO_ENABLED_not_true');
  if (!configured) warnings.push('databento_credentials_missing');

  return {
    provider: 'databento',
    dataset: process.env.DATABENTO_DATASET || 'GLBX.MDP3',
    schema: 'ohlcv-1m',
    aggregation: '1m_aggregate_to_2m',
    continuousSymbology: 'front_month_by_volume (<ROOT>.v.0)',
    dryRun: !args.execute,
    executed: false,
    from: args.from,
    to: args.to,
    symbols: args.symbols,
    symbolCount: args.symbols.length,
    destination: 'data/market-data/candles-2m/<SYMBOL>/<YYYY-MM-DD>.jsonl',
    manifest: 'data/market-data/imports/databento-2m-imports.jsonl',
    databento: {
      enabled,
      configured,
      env: ['DATABENTO_ENABLED', 'DATABENTO_API_KEY', 'DATABENTO_DATASET', 'DATABENTO_BASE_URL'],
    },
    warnings,
    safety: { ...SAFETY },
  };
}

async function runImport(input = {}, deps = {}) {
  const resolved = {
    fetchDatabentoBars,
    isEnabled,
    hasCredentials,
    countCandles: marketDataStore.countCandles,
    saveCandles2m: marketDataStore.saveCandles2m,
    loadCandles: marketDataStore.loadCandles,
    manifestFile: DEFAULT_MANIFEST,
    ...deps,
  };
  const plan = buildPlan(input, resolved);
  const result = {
    ok: plan.warnings.length === 0,
    dryRun: plan.dryRun,
    executed: false,
    mode: 'historical_market_data_import',
    plan,
    results: [],
    safety: { ...SAFETY },
  };

  // Never fetch or write on a dry-run or when the plan has blocking warnings.
  if (plan.dryRun || plan.warnings.length > 0) return result;

  for (const symbol of plan.symbols) {
    const startedAt = new Date().toISOString();
    try {
      const fetched = await fetchCandles2m(symbol, plan.from, plan.to, resolved);
      const valid = fetched.candles.filter(isValidCandle);
      const deduped = dedupeCandlesByTimestamp(valid);
      const uniqueValid = deduped.candles;
      const invalidCandlesFiltered = fetched.candles.length - valid.length;
      const byDate = groupByDate(uniqueValid);
      let candlesWritten = 0;
      let duplicatesSkipped = deduped.duplicateCount;
      let loaderCandles = 0;

      for (const [date, candles] of Object.entries(byDate).sort()) {
        const before = resolved.countCandles(symbol, date, '2m');
        resolved.saveCandles2m(symbol, date, candles);
        const after = resolved.countCandles(symbol, date, '2m');
        const stats = mergeStats(before, candles.length, after);
        candlesWritten += stats.candles_written;
        duplicatesSkipped += stats.duplicates_skipped;
        const loaded = resolved.loadCandles(symbol, date, date, '2m');
        loaderCandles += loaded.length - countDuplicateTimestamps(loaded);
      }

      const datesWithCandles = new Set(Object.keys(byDate));
      const missingCalendarDays = calendarDatesInRange(plan.from, plan.to).filter((date) => !datesWithCandles.has(date));
      const row = {
        symbol,
        from: plan.from,
        to: plan.to,
        provider: 'databento',
        sourceTimeframe: fetched.sourceTimeframe,
        candles_fetched: fetched.rawFetched,
        candles_valid: uniqueValid.length,
        candles_written: candlesWritten,
        duplicates_skipped: duplicatesSkipped,
        invalid_candles_filtered: invalidCandlesFiltered,
        missing_calendar_days: missingCalendarDays.length,
        first_timestamp: uniqueValid[0]?.ts || null,
        last_timestamp: uniqueValid[uniqueValid.length - 1]?.ts || null,
        loader_candles_after_write: loaderCandles,
        warnings: fetched.warnings,
        status: 'ok',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        safety: { ...SAFETY },
      };
      appendJsonl(resolved.manifestFile, row);
      result.results.push(row);
    } catch (err) {
      const row = {
        symbol,
        from: plan.from,
        to: plan.to,
        provider: 'databento',
        status: 'error',
        error: err.message,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        safety: { ...SAFETY },
      };
      appendJsonl(resolved.manifestFile, row);
      result.results.push(row);
      result.ok = false;
    }
  }

  result.executed = true;
  return result;
}

module.exports = {
  DEFAULT_SYMBOLS,
  SAFETY,
  buildPlan,
  runImport,
  _internal: {
    todayIso,
    isDate,
    assertValidConfig,
    normalizeCandleTimestamp,
    normalizeBar,
    isValidCandle,
    dedupeCandlesByTimestamp,
    groupByDate,
    calendarDatesInRange,
    mergeStats,
    countDuplicateTimestamps,
    fetchCandles2m,
    appendJsonl,
  },
};
