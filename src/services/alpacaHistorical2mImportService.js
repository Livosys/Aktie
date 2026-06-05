'use strict';

const fs = require('fs');
const path = require('path');

const { fetchAlpacaBars, isEnabled, hasCredentials } = require('../data/alpacaDataService');
const marketDataStore = require('../data/marketDataStore');
const { aggregate1mTo2m, filterComplete } = require('../data/candleAggregator');

const DEFAULT_SYMBOLS = ['MSFT', 'QQQ', 'TSLA', 'AAPL', 'NVDA', 'META', 'AMZN', 'AMD'];
const DEFAULT_MANIFEST = path.resolve(__dirname, '../../data/market-data/imports/alpaca-2m-imports.jsonl');
const SAFETY = {
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv = []) {
  const out = {
    execute: false,
    from: null,
    to: null,
    symbols: DEFAULT_SYMBOLS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') out.execute = true;
    else if (arg === '--from') out.from = argv[++i];
    else if (arg === '--to') out.to = argv[++i];
    else if (arg === '--symbols') out.symbols = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  out.from = out.from || '2024-01-01';
  out.to = out.to || todayIso();
  out.symbols = [...new Set(out.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  return out;
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function assertValidConfig({ from, to, symbols }) {
  const warnings = [];
  if (!isDate(from)) warnings.push('invalid_from_date');
  if (!isDate(to)) warnings.push('invalid_to_date');
  if (isDate(from) && isDate(to) && from > to) warnings.push('from_after_to');
  if (!symbols.length) warnings.push('no_symbols');
  return warnings;
}

function normalizeBar(bar = {}, symbol, timeframe = '2Min') {
  const ts = bar.ts || bar.t || bar.timestamp;
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
    source: timeframe === '2Min' ? 'alpaca_2m' : 'aggregated_1m',
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

function businessDatesInRange(from, to) {
  const dates = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
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

function shouldFallbackTo1Min(err) {
  const msg = String(err?.message || err || '');
  return /timeframe|2min|2Min|invalid|unsupported/i.test(msg);
}

async function fetchCandles2m(symbol, from, to, deps) {
  try {
    const bars = await deps.fetchAlpacaBars({ symbol, timeframe: '2Min', start: from, end: to, limit: 10000 });
    return {
      sourceTimeframe: '2Min',
      fallbackUsed: false,
      rawFetched: bars.length,
      candles: bars.map((bar) => normalizeBar(bar, symbol, '2Min')),
      warnings: [],
    };
  } catch (err) {
    if (!shouldFallbackTo1Min(err)) throw err;
    const bars = await deps.fetchAlpacaBars({ symbol, timeframe: '1Min', start: from, end: to, limit: 10000 });
    return {
      sourceTimeframe: '1Min',
      fallbackUsed: true,
      rawFetched: bars.length,
      candles: filterComplete(aggregate1mTo2m(bars)).map((bar) => normalizeBar(bar, symbol, '1Min')),
      warnings: ['fallback_1Min_aggregated_to_2m'],
    };
  }
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function buildPlan(input = {}, deps = {}) {
  const args = {
    execute: !!input.execute,
    from: input.from || '2024-01-01',
    to: input.to || todayIso(),
    symbols: input.symbols && input.symbols.length ? input.symbols : DEFAULT_SYMBOLS,
  };
  args.symbols = [...new Set(args.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const alpacaEnabled = deps.isEnabled ? deps.isEnabled() : isEnabled();
  const alpacaConfigured = deps.hasCredentials ? deps.hasCredentials() : hasCredentials();
  const warnings = assertValidConfig(args);
  if (!alpacaEnabled) warnings.push('ALPACA_ENABLED=false');
  if (!alpacaConfigured) warnings.push('alpaca_credentials_missing');
  return {
    provider: 'alpaca',
    sourceTimeframePreferred: '2Min',
    fallback: '1Min_aggregate_to_2m_if_2Min_unsupported',
    dryRun: !args.execute,
    executed: false,
    from: args.from,
    to: args.to,
    symbols: args.symbols,
    symbolCount: args.symbols.length,
    destination: 'data/market-data/candles-2m/<SYMBOL>/<YYYY-MM-DD>.jsonl',
    manifest: 'data/market-data/imports/alpaca-2m-imports.jsonl',
    alpaca: {
      enabled: alpacaEnabled,
      configured: alpacaConfigured,
      env: ['ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY', 'ALPACA_ENABLED', 'ALPACA_DATA_BASE_URL', 'ALPACA_DATA_FEED'],
    },
    warnings,
    safety: { ...SAFETY },
  };
}

async function runImport(input = {}, deps = {}) {
  const resolved = {
    fetchAlpacaBars,
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

  if (plan.dryRun || plan.warnings.length > 0) return result;

  for (const symbol of plan.symbols) {
    const startedAt = new Date().toISOString();
    try {
      const fetched = await fetchCandles2m(symbol, plan.from, plan.to, resolved);
      const normalized = fetched.candles.map((c) => normalizeBar(c, symbol, fetched.sourceTimeframe));
      const valid = normalized.filter(isValidCandle);
      const invalidCandlesFiltered = normalized.length - valid.length;
      const byDate = groupByDate(valid);
      let candlesWritten = 0;
      let duplicatesSkipped = 0;
      let loaderCandles = 0;

      for (const [date, candles] of Object.entries(byDate).sort()) {
        const before = resolved.countCandles(symbol, date, '2m');
        resolved.saveCandles2m(symbol, date, candles);
        const after = resolved.countCandles(symbol, date, '2m');
        const stats = mergeStats(before, candles.length, after);
        candlesWritten += stats.candles_written;
        duplicatesSkipped += stats.duplicates_skipped;
        loaderCandles += resolved.loadCandles(symbol, date, date, '2m').length;
      }

      const datesWithCandles = new Set(Object.keys(byDate));
      const missingBusinessDays = businessDatesInRange(plan.from, plan.to).filter((date) => !datesWithCandles.has(date));
      const row = {
        symbol,
        from: plan.from,
        to: plan.to,
        sourceTimeframe: fetched.sourceTimeframe,
        fallbackUsed: fetched.fallbackUsed,
        candles_fetched: fetched.rawFetched,
        candles_valid: valid.length,
        candles_written: candlesWritten,
        duplicates_skipped: duplicatesSkipped,
        invalid_candles_filtered: invalidCandlesFiltered,
        missing_business_days: missingBusinessDays.length,
        first_timestamp: valid[0]?.ts || null,
        last_timestamp: valid[valid.length - 1]?.ts || null,
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
  parseArgs,
  buildPlan,
  runImport,
  _internal: {
    normalizeBar,
    isValidCandle,
    groupByDate,
    businessDatesInRange,
    mergeStats,
    shouldFallbackTo1Min,
  },
};
