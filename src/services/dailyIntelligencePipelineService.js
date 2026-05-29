'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fetchAlpacaBars, isEnabled: alpacaEnabled, hasCredentials } = require('../data/alpacaDataService');
const { fetchBinanceKlines } = require('../data/binanceDataService');
const { saveRawBars, saveCandles2m, loadCandles, countCandles, getDatesInRange } = require('../data/marketDataStore');
const { aggregate1mTo2m, aggregateBars, filterComplete } = require('../data/candleAggregator');
const { runReplay } = require('../scanner/replayEngine');
const paperTrading = require('../paperTrading/paperTradingAgent');
const daytradingCatalog = require('./daytradingStrategyCatalogService');
const strategyPerformance = require('./strategyPerformanceService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  paper_only: true,
  replay_mode: true,
});

const DATA_DIR = path.resolve(__dirname, '../../data/daily-intelligence');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const DEFAULT_SYMBOLS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'QQQ', 'SPY'];
const REPLAY_SYMBOLS = ['NVDA', 'TSLA', 'AAPL', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TIMEFRAMES = ['1m', '2m', '5m', '15m', '30m', '1h', '1D'];
const BATCH_TIMEFRAMES = ['2m', '5m', '15m'];
const STOP_LOSSES = [0.15, 0.20, 0.30];
const TAKE_PROFITS = [1.2, 1.5, 2.0];
const HOLDING_TIMES = [5, 8, 15];
const CONFIDENCE = [60, 65, 70];
const VOLUME_REQUIREMENTS = [1.0, 1.2, 1.5];
const MAX_DAILY_BATCH_RUNS = 486;

let running = false;
let lockStartedAt = null;
let timer = null;
let nextRunAt = null;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() { return new Date().toISOString(); }
function todayIso() { return nowIso().slice(0, 10); }
function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function durationSeconds(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}
function safeArray(value) {
  return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined && v !== '') : [];
}
function cleanValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.map(cleanValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, cleanValue(val)]));
  }
  return value;
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(cleanValue(value), null, 2) + '\n', 'utf8');
}
function appendRun(run) {
  ensureDir(RUNS_DIR);
  writeJson(path.join(RUNS_DIR, `${run.run_id}.json`), run);
  writeJson(LATEST_FILE, run);
}
function defaultConfig() {
  return {
    enabled: (process.env.DAILY_PIPELINE_ENABLED || 'false').toLowerCase() === 'true',
    cron: process.env.DAILY_PIPELINE_CRON || '0 2 * * *',
    timezone: process.env.DAILY_PIPELINE_TIMEZONE || 'Europe/Stockholm',
    auto_replay: (process.env.DAILY_PIPELINE_AUTO_REPLAY || 'true').toLowerCase() !== 'false',
    auto_batch: (process.env.DAILY_PIPELINE_AUTO_BATCH || 'true').toLowerCase() !== 'false',
    collect_paper: (process.env.DAILY_PIPELINE_COLLECT_PAPER || 'true').toLowerCase() !== 'false',
    send_notifications: (process.env.DAILY_PIPELINE_SEND_NOTIFICATIONS || 'false').toLowerCase() === 'true',
    allow_live_trading: false,
  };
}
function readConfig() {
  return { ...defaultConfig(), ...readJson(CONFIG_FILE, {}) };
}
function saveConfig(patch) {
  const cfg = { ...readConfig(), ...patch, allow_live_trading: false, send_notifications: false };
  writeJson(CONFIG_FILE, cfg);
  nextRunAt = cfg.enabled ? computeNextRunAt(cfg) : null;
  return cfg;
}
function isCrypto(symbol) {
  return String(symbol || '').toUpperCase().endsWith('USDT');
}
function previousBusinessDay(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function parseCronHourMinute(cron) {
  const parts = String(cron || '0 2 * * *').trim().split(/\s+/);
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  return {
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 2,
  };
}
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  return parts;
}
function computeNextRunAt(config = readConfig()) {
  const { hour, minute } = parseCronHourMinute(config.cron);
  const tz = config.timezone || 'Europe/Stockholm';
  const now = new Date();
  const p = zonedParts(now, tz);
  let candidateUtc = new Date(Date.UTC(p.year, p.month - 1, p.day, hour, minute, 0));
  const offsetNow = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - now.getTime();
  candidateUtc = new Date(candidateUtc.getTime() - offsetNow);
  if (candidateUtc <= now) candidateUtc = new Date(candidateUtc.getTime() + 24 * 60 * 60 * 1000);
  return candidateUtc.toISOString();
}
function writeJsonl(file, rows) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
function saveCandlesTimeframe(symbol, timeframe, date, candles) {
  if (timeframe === '2m') return saveCandles2m(symbol, date, candles);
  const dir = path.resolve(__dirname, `../../data/market-data/candles-${timeframe}`, symbol);
  const fp = path.join(dir, `${date}.jsonl`);
  const existing = readJsonl(fp);
  const seen = new Set();
  const merged = [...existing, ...candles]
    .sort((a, b) => String(a.ts || a.t).localeCompare(String(b.ts || b.t)))
    .filter((bar) => {
      const key = bar.ts || bar.t;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  writeJsonl(fp, merged);
  return merged.length;
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

async function fetchSymbolData(symbol, date) {
  const source = isCrypto(symbol) ? 'binance' : 'alpaca';
  const warnings = [];
  const unsupported = [];
  let rawBars = [];
  if (source === 'alpaca') {
    if (!alpacaEnabled() || !hasCredentials()) {
      return { symbol, source, status: 'missing', raw_bars: 0, candles_loaded: 0, warnings: ['Datakälla saknar stöd eller credentials'], unsupported_timeframes: TIMEFRAMES.filter((tf) => tf !== '1m') };
    }
    rawBars = await fetchAlpacaBars({ symbol, timeframe: '1Min', start: date, end: date, limit: 10000 });
  } else {
    rawBars = await fetchBinanceKlines({ symbol, interval: '1m', start: date, end: date, limit: 1000 });
  }
  if (!rawBars.length) {
    warnings.push('Ingen prisdata');
    return { symbol, source, status: 'missing', raw_bars: 0, candles_loaded: 0, warnings, unsupported_timeframes: [] };
  }
  saveRawBars(symbol, date, rawBars, source);
  const byTf = { '1m': rawBars.length };
  const derived = {
    '2m': filterComplete(aggregate1mTo2m(rawBars)),
    '5m': filterComplete(aggregateBars(rawBars, 5)),
    '15m': filterComplete(aggregateBars(rawBars, 15)),
    '30m': filterComplete(aggregateBars(rawBars, 30)),
    '1h': filterComplete(aggregateBars(rawBars, 60)),
  };
  for (const [tf, candles] of Object.entries(derived)) {
    byTf[tf] = saveCandlesTimeframe(symbol, tf, date, candles);
  }
  unsupported.push('1D');
  warnings.push('Datakälla saknar stöd: 1D');
  const candlesLoaded = Object.values(byTf).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return { symbol, source, status: 'ok', raw_bars: rawBars.length, candles_loaded: candlesLoaded, by_timeframe: byTf, warnings, unsupported_timeframes: unsupported };
}

async function fetchDailyMarketData(ctx) {
  const symbols = ctx.symbols || DEFAULT_SYMBOLS;
  const date = ctx.date;
  const bySymbol = {};
  const warnings = [];
  let symbolsLoaded = 0;
  let candlesLoaded = 0;
  for (const symbol of symbols) {
    try {
      const row = await fetchSymbolData(symbol, date);
      bySymbol[symbol] = row;
      if (row.status === 'ok') symbolsLoaded += 1;
      candlesLoaded += Number(row.candles_loaded) || 0;
      warnings.push(...safeArray(row.warnings).map((w) => `${symbol}: ${w}`));
    } catch (err) {
      bySymbol[symbol] = { symbol, status: 'error', error: err.message, warnings: ['Ingen prisdata'] };
      warnings.push(`${symbol}: ${err.message || 'Ingen prisdata'}`);
    }
  }
  return {
    status: symbolsLoaded > 0 ? 'ok' : 'missing',
    symbols_requested: symbols.length,
    symbols_loaded: symbolsLoaded,
    candles_loaded: candlesLoaded,
    timeframes_requested: TIMEFRAMES,
    warnings,
    by_symbol: bySymbol,
    conclusion_sv: symbolsLoaded > 0 ? `${symbolsLoaded} av ${symbols.length} symboler hade prisdata.` : 'Ingen prisdata.',
  };
}

function verifyHistoricalData(ctx) {
  const symbols = ctx.symbols || DEFAULT_SYMBOLS;
  const date = ctx.date;
  const bySymbol = {};
  const warnings = [];
  let okCount = 0;
  for (const symbol of symbols) {
    const candles2m = countCandles(symbol, date, '2m');
    bySymbol[symbol] = { symbol, date, candles_2m: candles2m, status: candles2m > 0 ? 'ok' : 'missing' };
    if (candles2m > 0) okCount += 1;
    else warnings.push(`${symbol}: Ingen prisdata`);
  }
  return {
    status: okCount > 0 ? 'ok' : 'missing',
    symbols_verified: symbols.length,
    symbols_with_data: okCount,
    warnings,
    by_symbol: bySymbol,
  };
}

async function runAutoReplay(ctx, dataFetch) {
  if (ctx.config.auto_replay === false) return { status: 'disabled', conclusion_sv: 'Auto Replay är avstängt.' };
  const symbols = REPLAY_SYMBOLS.filter((symbol) => dataFetch.by_symbol?.[symbol]?.status === 'ok');
  if (!symbols.length) return { status: 'missing_data', conclusion_sv: 'Ingen replay körd. Ingen prisdata.' };
  const replay = await runReplay({ symbols, start: ctx.date, end: ctx.date, mode: 'scan_only' });
  const summary = replay.summary || {};
  return {
    status: 'completed',
    session_id: replay.runId,
    symbols,
    date_from: ctx.date,
    date_to: ctx.date,
    risk_profile: 'normal',
    start_capital: 100000,
    max_trades: 50,
    speed: 'instant',
    agent_enabled: true,
    memory_enabled: true,
    risk_engine_v2: true,
    exit_engine_v1: true,
    execution_safety_v1: true,
    candles_total: summary.totalCandles || 0,
    events_total: summary.totalEvents || 0,
    trades_total: 0,
    win_rate: null,
    pnl: null,
    max_drawdown: null,
    risk_blocks: 0,
    exit_improvements: 0,
    agent_adjustments: 0,
    memory_adjustments: 0,
    data_status: summary.totalCandles > 0 ? 'ok' : 'missing',
    conclusion_sv: summary.totalEvents > 0
      ? `Replay hittade ${summary.totalEvents} händelser på ${symbols.length} symboler.`
      : 'Replay kördes men hittade inga simulerade trade-händelser.',
  };
}

function activeStrategyIds() {
  const perf = strategyPerformance.getTopStrategies(2).strategies || [];
  const fromPerf = perf.map((s) => s.strategy_id).filter(Boolean);
  if (fromPerf.length) return fromPerf.slice(0, 2);
  const catalog = daytradingCatalog.getCatalog().strategies || [];
  return catalog.filter((s) => s.active !== false).slice(0, 2).map((s) => s.id);
}
function scoreBatchRow(row) {
  const wr = row.win_rate || 0;
  const pnl = row.avg_pnl || 0;
  const trades = row.trades || 0;
  return Math.max(0, Math.min(100, Math.round(wr * 0.55 + pnl * 12 + Math.min(20, trades))));
}
async function runAutoBatchTests(ctx, dataFetch) {
  if (ctx.config.auto_batch === false) return { status: 'disabled', conclusion_sv: 'Auto Batch-test är avstängt.' };
  const symbols = DEFAULT_SYMBOLS.filter((symbol) => dataFetch.by_symbol?.[symbol]?.status === 'ok');
  if (!symbols.length) return { status: 'missing_data', conclusion_sv: 'Ingen batch körd. Ingen prisdata.' };
  const strategies = activeStrategyIds();
  const batchId = `daily_batch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const combinationsTotal = strategies.length * symbols.length * BATCH_TIMEFRAMES.length * STOP_LOSSES.length * TAKE_PROFITS.length * HOLDING_TIMES.length * CONFIDENCE.length * VOLUME_REQUIREMENTS.length;
  const topResults = [];
  let completed = 0;
  batchLoop:
  for (const strategyId of strategies) {
    for (const symbol of symbols) {
      for (const timeframe of BATCH_TIMEFRAMES) {
        for (const stopLoss of STOP_LOSSES) {
          for (const takeProfit of TAKE_PROFITS) {
            for (const holdingTime of HOLDING_TIMES) {
              for (const confidence of CONFIDENCE) {
                for (const volume of VOLUME_REQUIREMENTS) {
                  const saved = strategyPerformance.saveSimulatedStrategyTest({
                    strategy_id: strategyId,
                    symbols: [symbol],
                    market_group: isCrypto(symbol) ? 'crypto' : 'stocks',
                    timeframe,
                    sl: stopLoss,
                    tp: takeProfit,
                    holding_time: holdingTime,
                    timeout: holdingTime,
                    confidence_threshold: confidence,
                    volume_requirement: volume,
                    mode: 'paper_replay',
                    actions_allowed: false,
                    can_place_orders: false,
                    live_trading_enabled: false,
                  });
                  completed += 1;
                  const result = saved.result || {};
                  const row = {
                    strategy_id: result.strategy_id,
                    strategy_name: result.strategy_name,
                    symbol,
                    timeframe,
                    stop_loss: stopLoss,
                    take_profit: takeProfit,
                    holding_time: holdingTime,
                    confidence_threshold: confidence,
                    volume_requirement: volume,
                    trades: result.trades || 0,
                    win_rate: result.win_rate || 0,
                    avg_pnl: result.avg_pnl || 0,
                    score: scoreBatchRow(result),
                  };
                  topResults.push(row);
                  if (completed >= MAX_DAILY_BATCH_RUNS) break batchLoop;
                }
              }
            }
          }
        }
      }
    }
  }
  topResults.sort((a, b) => b.score - a.score);
  const weakResults = [...topResults].sort((a, b) => a.score - b.score).slice(0, 10);
  const best = topResults[0] || {};
  return {
    status: 'completed',
    batch_id: batchId,
    combinations_total: combinationsTotal,
    completed_total: completed,
    best_strategy: best.strategy_name || 'För lite data',
    best_symbol: best.symbol || 'För lite data',
    best_score: best.score || 0,
    best_win_rate: best.win_rate || 0,
    best_avg_pnl: best.avg_pnl || 0,
    top_results: topResults.slice(0, 10),
    weak_results: weakResults,
    conclusion_sv: best.strategy_name
      ? `${best.strategy_name} fungerade bäst på ${best.symbol}. ${completed} av ${combinationsTotal} kombinationer kördes i säker dagsbatch.`
      : 'Ingen batch körd.',
  };
}

function normalizePct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) <= 1 ? round(n * 100, 2) : round(n, 2);
}
function collectPaperTradingSummary() {
  const perf = paperTrading.getPerformance();
  const trades = paperTrading.getTrades();
  const allTrades = safeArray(trades.trades);
  const today = todayIso();
  const todayTrades = allTrades.filter((t) => String(t.entryTime || t.opened_at || t.created_at || '').startsWith(today));
  const closed = allTrades.filter((t) => t.result !== 'OPEN');
  const latestTrade = allTrades[0] || null;
  const bySubtype = Object.entries(perf.bySignalSubtype || {}).map(([key, v]) => ({
    key,
    trades: v.trades || 0,
    win_rate: v.trades ? round(((v.wins || 0) / v.trades) * 100, 2) : 0,
    avg_pnl: v.trades ? round((v.pnlSum || 0) / v.trades, 2) : 0,
  })).sort((a, b) => b.avg_pnl - a.avg_pnl);
  const totalPnl = closed.reduce((sum, t) => sum + (Number(t.pnlPct) || 0), 0);
  return {
    status: 'active',
    total_trades: perf.totalTrades || allTrades.length || 0,
    trades_today: todayTrades.length,
    win_rate: normalizePct(perf.winRate),
    avg_pnl: normalizePct(perf.avgPnlPct),
    total_pnl: round(totalPnl, 2),
    timeout_rate: perf.totalTrades ? round(((perf.timeouts || 0) / perf.totalTrades) * 100, 2) : null,
    best_strategy: bySubtype[0]?.key || 'För lite data',
    weakest_strategy: bySubtype[bySubtype.length - 1]?.key || 'För lite data',
    latest_trade: latestTrade ? {
      symbol: latestTrade.symbol || '',
      result: latestTrade.result || '',
      pnl: normalizePct(latestTrade.pnlPct),
      time: latestTrade.exitTime || latestTrade.entryTime || '',
    } : null,
    open_positions: perf.openTrades || trades.openCount || 0,
    closed_positions: trades.closedCount || closed.length || 0,
    conclusion_sv: allTrades.length ? `${todayTrades.length} låtsastrades idag, total win rate ${normalizePct(perf.winRate) ?? 'för lite data'}%.` : 'Inga låtsastrades ännu.',
  };
}

function runAiAgentSummary(replay, batch, paper, dataFetch) {
  const recommended = [];
  const avoid = [];
  const bestMarkets = [];
  const dataWarnings = safeArray(dataFetch.warnings).slice(0, 8);
  if (batch.best_strategy && batch.best_strategy !== 'För lite data') recommended.push(batch.best_strategy);
  if (batch.weak_results?.[0]?.strategy_name) avoid.push(batch.weak_results[0].strategy_name);
  if (batch.best_symbol && batch.best_symbol !== 'För lite data') bestMarkets.push(batch.best_symbol);
  const main = [
    batch.best_strategy && batch.best_symbol ? `${batch.best_strategy} fungerade bäst på ${batch.best_symbol}.` : '',
    replay.events_total ? `Replay hittade ${replay.events_total} händelser.` : 'Replay gav för lite data.',
    dataWarnings.length ? `${dataWarnings.length} datavarningar finns.` : '',
  ].filter(Boolean).join(' ');
  return {
    main_conclusion_sv: main || 'För lite data för tydlig slutsats.',
    recommended_strategies: recommended,
    strategies_to_avoid: avoid,
    best_markets: bestMarkets,
    data_warnings: dataWarnings,
    risk_warnings: ['Live trading är avstängt.', 'Batch och replay är endast analys.'],
    next_test_plan: ['Verifiera saknade prisdata.', 'Kör ny replay efter nästa handelsdag.', 'Jämför tight stop loss mot längre hålltid.'],
  };
}

function saveDailyResultSummary(run) {
  appendRun(run);
  return { status: 'saved', file: LATEST_FILE };
}

async function runPipeline(options = {}) {
  if (running && lockStartedAt && Date.now() - new Date(lockStartedAt).getTime() < LOCK_TIMEOUT_MS) {
    return { ok: false, error: 'Daglig pipeline kör redan.', ...SAFETY };
  }
  running = true;
  lockStartedAt = nowIso();
  const startedAt = lockStartedAt;
  const config = readConfig();
  const date = options.date || previousBusinessDay();
  const ctx = { config, date, symbols: DEFAULT_SYMBOLS };
  const warnings = [];
  const errors = [];
  const run = {
    ok: true,
    run_id: `daily_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    date,
    pipeline_status: 'running',
    started_at: startedAt,
    last_run_at: startedAt,
    completed_at: null,
    duration_seconds: 0,
    data_fetch: { status: 'pending', warnings: [] },
    verify_historical_data: { status: 'pending', warnings: [] },
    replay: { status: 'pending', conclusion_sv: 'Ingen replay körd' },
    batch: { status: 'pending', conclusion_sv: 'Ingen batch körd' },
    paper: { status: 'pending', conclusion_sv: 'Inga låtsastrades ännu' },
    ai_summary: { main_conclusion_sv: 'För lite data', recommended_strategies: [], strategies_to_avoid: [], next_test_plan: [] },
    safety: SAFETY,
    warnings,
    errors,
    safety_confirmed: true,
  };
  try {
    try { run.data_fetch = await fetchDailyMarketData(ctx); warnings.push(...safeArray(run.data_fetch.warnings)); } catch (err) { errors.push(`data_fetch: ${err.message}`); run.data_fetch = { status: 'error', warnings: [err.message], conclusion_sv: 'Ingen prisdata' }; }
    try { run.verify_historical_data = verifyHistoricalData(ctx); warnings.push(...safeArray(run.verify_historical_data.warnings)); } catch (err) { errors.push(`verify: ${err.message}`); run.verify_historical_data = { status: 'error', warnings: [err.message] }; }
    try { run.replay = await runAutoReplay(ctx, run.data_fetch); } catch (err) { errors.push(`replay: ${err.message}`); run.replay = { status: 'error', conclusion_sv: 'Ingen replay körd' }; }
    try { run.batch = await runAutoBatchTests(ctx, run.data_fetch); } catch (err) { errors.push(`batch: ${err.message}`); run.batch = { status: 'error', conclusion_sv: 'Ingen batch körd' }; }
    try { run.paper = ctx.config.collect_paper === false ? { status: 'disabled', conclusion_sv: 'Paper summary är avstängd.' } : collectPaperTradingSummary(); } catch (err) { errors.push(`paper: ${err.message}`); run.paper = { status: 'error', conclusion_sv: 'Inga låtsastrades ännu' }; }
    try { run.ai_summary = runAiAgentSummary(run.replay, run.batch, run.paper, run.data_fetch); } catch (err) { errors.push(`ai_summary: ${err.message}`); }
    run.pipeline_status = errors.length ? 'completed_with_warnings' : 'completed';
  } finally {
    run.completed_at = nowIso();
    run.duration_seconds = durationSeconds(run.started_at, run.completed_at);
    run.error_count = errors.length;
    run.data_fetch_status = run.data_fetch.status;
    run.replay_status = run.replay.status;
    run.batch_status = run.batch.status;
    run.paper_summary_status = run.paper.status;
    run.ai_summary_status = run.ai_summary?.main_conclusion_sv ? 'completed' : 'missing';
    run.save_status = saveDailyResultSummary(run);
    running = false;
    lockStartedAt = null;
    nextRunAt = config.enabled ? computeNextRunAt(config) : null;
  }
  return cleanValue({ ok: true, ...run, ...SAFETY });
}

function latestSummary() {
  const latest = readJson(LATEST_FILE, null);
  if (!latest) {
    return cleanValue({
      ok: true,
      date: todayIso(),
      pipeline_status: 'not_run',
      last_run_at: '',
      data_fetch: { status: 'missing', symbols_requested: DEFAULT_SYMBOLS.length, symbols_loaded: 0, candles_loaded: 0, warnings: ['Ingen prisdata'] },
      replay: { status: 'missing', session_id: '', events_total: 0, trades_total: 0, win_rate: '', pnl: '', conclusion_sv: 'Ingen replay körd' },
      batch: { status: 'missing', batch_id: '', combinations_total: 0, best_strategy: 'Ingen batch körd', best_symbol: 'För lite data', best_score: 0, best_win_rate: '', best_avg_pnl: '', conclusion_sv: 'Ingen batch körd' },
      paper: { status: 'missing', trades_today: 0, total_trades: 0, win_rate: '', avg_pnl: '', open_positions: 0, conclusion_sv: 'Inga låtsastrades ännu' },
      ai_summary: { main_conclusion_sv: 'För lite data', recommended_strategies: [], strategies_to_avoid: [], next_test_plan: [] },
      safety: SAFETY,
      ...SAFETY,
    });
  }
  return cleanValue({ ok: true, ...latest, safety: SAFETY, ...SAFETY });
}

function recentRuns(limit = 10) {
  ensureDir(RUNS_DIR);
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, Math.min(Number(limit) || 10, 50));
  return cleanValue({ ok: true, runs: files.map((f) => readJson(path.join(RUNS_DIR, f), null)).filter(Boolean), count: files.length, ...SAFETY });
}

function status() {
  const cfg = readConfig();
  return cleanValue({
    ok: true,
    enabled: cfg.enabled,
    scheduler_active: timer !== null,
    daily_pipeline_running: running,
    lock_started_at: lockStartedAt,
    last_run_at: latestSummary().last_run_at || '',
    next_run_at: cfg.enabled ? (nextRunAt || computeNextRunAt(cfg)) : '',
    config: cfg,
    latest: latestSummary(),
    ...SAFETY,
  });
}

function enable() {
  const cfg = saveConfig({ enabled: true, allow_live_trading: false, send_notifications: false });
  startScheduler();
  return status();
}
function disable() {
  saveConfig({ enabled: false, allow_live_trading: false, send_notifications: false });
  nextRunAt = null;
  return status();
}
function schedulerTick() {
  const cfg = readConfig();
  if (!cfg.enabled) return;
  if (!nextRunAt) nextRunAt = computeNextRunAt(cfg);
  if (new Date(nextRunAt).getTime() <= Date.now()) {
    nextRunAt = computeNextRunAt(cfg);
    runPipeline({ trigger: 'scheduler' }).catch((err) => console.warn('[DailyPipeline] scheduled run failed:', err.message));
  }
}
function startScheduler() {
  const cfg = readConfig();
  nextRunAt = cfg.enabled ? computeNextRunAt(cfg) : null;
  if (timer) return;
  timer = setInterval(schedulerTick, 60 * 1000);
  console.log(`[DailyPipeline] Scheduler ${cfg.enabled ? 'armed' : 'disabled'}; next=${nextRunAt || 'none'}`);
}

module.exports = {
  SAFETY,
  DEFAULT_SYMBOLS,
  TIMEFRAMES,
  fetchDailyMarketData,
  verifyHistoricalData,
  runAutoReplay,
  runAutoBatchTests,
  collectPaperTradingSummary,
  runAiAgentSummary,
  saveDailyResultSummary,
  runPipeline,
  latestSummary,
  recentRuns,
  status,
  enable,
  disable,
  startScheduler,
};
