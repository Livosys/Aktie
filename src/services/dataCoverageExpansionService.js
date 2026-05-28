'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchAlpacaBars, isEnabled: alpacaEnabled, hasCredentials: alpacaHasCredentials } = require('../data/alpacaDataService');
const { fetchBinanceKlines } = require('../data/binanceDataService');
const { aggregate1mTo2m, filterComplete } = require('../data/candleAggregator');
const marketUniverse = require('./marketUniverseService');
const auditTrail = require('./auditTrailService');

const ROOT = path.resolve(__dirname, '../..');
const DATA_ROOT = path.join(ROOT, 'data');
const JOB_DIR = path.join(DATA_ROOT, 'data-coverage');
const JOBS_FILE = path.join(JOB_DIR, 'backfill-jobs-v1.json');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  read_only: false,
  ingestion_only: true,
  can_modify_trading_config: false,
});

const LIMITS = Object.freeze({
  maxSymbolsPerJob: 50,
  maxDaysPerJob: 60,
  maxTimeframesPerJob: 3,
  maxActiveJobs: 1,
  providerCallDelayMs: 350,
});

const PRIORITY_SYMBOLS = Object.freeze([
  'QQQ', 'SPY', 'IWM', 'DIA',
  'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD', 'META', 'GOOGL', 'AMZN',
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT',
]);

const MARKET_GROUPS = Object.freeze(['crypto', 'stocks', 'index', 'etf', 'nasdaq100', 'sp500', 'mag7']);
const CRYPTO_HINTS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'BNBUSDT', 'ADAUSDT']);
const runningJobs = new Map();

function nowIso() { return new Date().toISOString(); }
function todayIso() { return nowIso().slice(0, 10); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function safeArray(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (value == null || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}
function uniqueSymbols(value) {
  return [...new Set(safeArray(value).map((s) => s.toUpperCase()))].filter(Boolean);
}
function normalizeTimeframe(tf) {
  const raw = String(tf || '2m').trim();
  const lower = raw.toLowerCase();
  if (lower === '1min') return '1m';
  if (lower === '2min') return '2m';
  if (lower === '5min') return '5m';
  if (lower === '15min') return '15m';
  if (['1m', '2m', '5m', '15m', '30m', '1h'].includes(lower)) return lower;
  return lower;
}
function normalizeTimeframes(value) {
  const arr = safeArray(value).length ? safeArray(value) : ['2m'];
  return [...new Set(arr.map(normalizeTimeframe))];
}
function parseDate(value, fallback) {
  const raw = value || fallback;
  const d = new Date(`${String(raw).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : fallback;
}
function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
function safeJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, val) => {
    if (typeof val === 'number' && !Number.isFinite(val)) return 0;
    if (val === undefined || val === null) return '';
    return val;
  }));
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
  fs.writeFileSync(file, JSON.stringify(safeJson(value), null, 2) + '\n', 'utf8');
}
function listDir(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}
function countJsonlLines(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    const buf = fs.readFileSync(file);
    if (!buf.length) return 0;
    let lines = 0;
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) lines += 1;
    return buf[buf.length - 1] === 10 ? lines : lines + 1;
  } catch (_) {
    return 0;
  }
}
function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}
function writeJsonlDedup(file, candles) {
  const merged = new Map();
  for (const row of readJsonl(file)) {
    const ts = row.timestamp || row.ts || row.t;
    if (ts) merged.set(ts, row);
  }
  for (const row of candles) {
    const ts = row.timestamp || row.ts || row.t;
    if (ts) merged.set(ts, row);
  }
  const sorted = [...merged.values()].sort((a, b) => String(a.timestamp || a.ts || a.t).localeCompare(String(b.timestamp || b.ts || b.t)));
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, sorted.map((row) => JSON.stringify(row)).join('\n') + (sorted.length ? '\n' : ''), 'utf8');
  return sorted.length;
}
function getUniverse() {
  const u = marketUniverse.getUniverse();
  const symbols = Array.isArray(u.symbols) ? u.symbols : [];
  const bySymbol = Object.fromEntries(symbols.map((row) => [String(row.symbol || '').toUpperCase(), row]));
  return { groups: u.groups || {}, symbols, bySymbol };
}
function inferMarketGroup(symbol, bySymbol = {}) {
  const known = bySymbol[symbol];
  if (known?.marketGroup || known?.group) return known.marketGroup || known.group;
  if (CRYPTO_HINTS.has(symbol) || /USDT$/.test(symbol)) return 'crypto';
  if (['QQQ', 'SPY', 'IWM', 'DIA'].includes(symbol)) return 'index';
  if (['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA'].includes(symbol)) return 'etf';
  return 'stocks';
}
function providerFor(symbol, marketGroup, requested) {
  if (requested && requested !== 'auto') return requested;
  if (marketGroup === 'crypto' || /USDT$/.test(symbol)) return 'binance';
  if (['stocks', 'index', 'etf', 'nasdaq100', 'sp500', 'mag7'].includes(marketGroup)) return 'alpaca';
  return 'missing_provider';
}
function providerStatusFor(provider) {
  if (provider === 'binance') return { provider, configured: true, enabled: true, ok: true, message_sv: 'Provider redo.' };
  if (provider === 'alpaca') {
    const enabled = alpacaEnabled();
    const configured = alpacaHasCredentials();
    return {
      provider,
      configured,
      enabled,
      ok: enabled && configured,
      message_sv: !enabled || !configured ? 'Provider saknar nyckel.' : 'Provider redo.',
    };
  }
  return { provider: provider || 'missing_provider', configured: false, enabled: false, ok: false, message_sv: 'Provider saknar nyckel.' };
}
function candleDirsFor(symbol, timeframe, marketGroup) {
  const tf = normalizeTimeframe(timeframe);
  const existing = [
    path.join(DATA_ROOT, 'market-data', `candles-${tf}`, symbol),
    tf === '2m' ? path.join(DATA_ROOT, 'market-data', 'alpaca', 'candles-2m', symbol) : null,
  ].filter(Boolean);
  const fallback = path.join(DATA_ROOT, 'market-data', marketGroup || 'custom', symbol, tf);
  return { primary: existing[0] || fallback, fallback };
}
function sourceRawDir(symbol, provider) {
  return path.join(DATA_ROOT, 'market-data', provider === 'binance' ? 'binance' : 'alpaca', 'raw', symbol);
}
function dateFile(dir, date) {
  return path.join(dir, `${date}.jsonl`);
}
function scanSymbolFiles(symbol, marketGroup) {
  const out = {
    symbol,
    market_group: marketGroup,
    candles_count: 0,
    first_candle_at: '',
    last_candle_at: '',
    days: new Set(),
    timeframes: {},
  };
  const roots = ['2m', '5m', '15m', '30m', '1h'].map((tf) => ({ tf, dir: candleDirsFor(symbol, tf, marketGroup).primary }))
    .concat([
      { tf: 'raw_alpaca', dir: sourceRawDir(symbol, 'alpaca') },
      { tf: 'raw_binance', dir: sourceRawDir(symbol, 'binance') },
    ]);
  for (const root of roots) {
    const files = listDir(root.dir).filter((f) => f.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.name));
    if (!files.length) continue;
    out.timeframes[root.tf] = out.timeframes[root.tf] || { days_covered: 0, candles_count: 0 };
    for (const file of files) {
      const date = file.name.replace('.jsonl', '');
      const fp = path.join(root.dir, file.name);
      const n = countJsonlLines(fp);
      out.timeframes[root.tf].days_covered += 1;
      out.timeframes[root.tf].candles_count += n;
      if (!root.tf.startsWith('raw')) {
        out.days.add(date);
        out.candles_count += n;
        if (!out.first_candle_at || date < out.first_candle_at) out.first_candle_at = date;
        if (!out.last_candle_at || date > out.last_candle_at) out.last_candle_at = date;
      }
    }
  }
  return out;
}
function qualityFor(daysCovered, candlesCount) {
  if (daysCovered >= 20 && candlesCount >= 1000) return { data_quality: 'good', label_sv: 'Bra data', score: 90 };
  if (daysCovered >= 7 && candlesCount >= 500) return { data_quality: 'medium', label_sv: 'Lite data', score: 65 };
  if (daysCovered > 0 || candlesCount > 0) return { data_quality: 'weak', label_sv: 'Lite data', score: 35 };
  return { data_quality: 'missing', label_sv: 'Saknar data', score: 0 };
}
function buildCoverageRow(symbolInput) {
  const symbol = String(symbolInput || '').toUpperCase();
  const universe = getUniverse();
  const marketGroup = inferMarketGroup(symbol, universe.bySymbol);
  const scanned = scanSymbolFiles(symbol, marketGroup);
  const daysCovered = scanned.days.size;
  const spanDays = scanned.first_candle_at && scanned.last_candle_at ? daysBetween(scanned.first_candle_at, scanned.last_candle_at) : 0;
  const missingDays = Math.max(0, spanDays - daysCovered);
  const q = qualityFor(daysCovered, scanned.candles_count);
  const provider = providerFor(symbol, marketGroup);
  const providerStatus = providerStatusFor(provider);
  const providerMissing = !providerStatus.ok && scanned.candles_count === 0;
  const dataQuality = providerMissing ? 'missing_provider' : q.data_quality;
  const label = providerMissing ? 'Provider saknas' : q.label_sv;
  const replayReady = daysCovered >= 3 && scanned.candles_count >= 200;
  const batchReady = daysCovered >= 10 && scanned.candles_count >= 500;
  const aiReady = daysCovered >= 10 && scanned.candles_count >= 500;
  const reason = providerMissing
    ? 'Provider saknar nyckel.'
    : q.data_quality === 'good'
      ? 'Redo för replay och batch-test.'
      : scanned.candles_count > 0
        ? 'För lite historik. Behöver backfill.'
        : 'Saknar historik. Behöver backfill.';
  return {
    symbol,
    market_group: marketGroup,
    candles_count: scanned.candles_count,
    first_candle_at: scanned.first_candle_at,
    last_candle_at: scanned.last_candle_at,
    days_covered: daysCovered,
    missing_days: missingDays,
    coverage_score: providerMissing ? 0 : q.score,
    data_quality: dataQuality,
    status_sv: label,
    usable_for_replay: replayReady,
    usable_for_batch: batchReady,
    usable_for_ai_learning: aiReady,
    provider,
    provider_status: providerStatus,
    timeframes: scanned.timeframes,
    reason,
    ...SAFETY,
  };
}
function allCoverageRows() {
  const universe = getUniverse();
  const symbols = new Set([
    ...Object.keys(universe.bySymbol),
    ...PRIORITY_SYMBOLS,
  ]);
  const marketDataRoot = path.join(DATA_ROOT, 'market-data');
  for (const tfDir of listDir(marketDataRoot).filter((d) => d.isDirectory() && d.name.startsWith('candles-'))) {
    for (const symDir of listDir(path.join(marketDataRoot, tfDir.name)).filter((d) => d.isDirectory())) symbols.add(symDir.name.toUpperCase());
  }
  for (const provider of ['alpaca', 'binance']) {
    const rawRoot = path.join(marketDataRoot, provider, 'raw');
    for (const symDir of listDir(rawRoot).filter((d) => d.isDirectory())) symbols.add(symDir.name.toUpperCase());
  }
  return [...symbols].filter(Boolean).sort().map(buildCoverageRow);
}
function getCoverageStatus() {
  const symbols = allCoverageRows();
  const total = symbols.length;
  const readyReplay = symbols.filter((s) => s.usable_for_replay).length;
  const readyBatch = symbols.filter((s) => s.usable_for_batch).length;
  const missing = symbols.filter((s) => s.data_quality === 'missing' || s.data_quality === 'missing_provider').length;
  const score = total ? Math.round(symbols.reduce((sum, s) => sum + s.coverage_score, 0) / total) : 0;
  return {
    ok: true,
    generated_at: nowIso(),
    total_coverage_score: score,
    symbols_total: total,
    symbols_ready_for_replay: readyReplay,
    symbols_ready_for_batch: readyBatch,
    symbols_ready_for_ai_learning: symbols.filter((s) => s.usable_for_ai_learning).length,
    symbols_missing_data: missing,
    symbols_good_data: symbols.filter((s) => s.data_quality === 'good').length,
    symbols_weak_data: symbols.filter((s) => ['medium', 'weak'].includes(s.data_quality)).length,
    active_backfill_jobs: listBackfillJobs().jobs.filter((j) => j.status === 'running').length,
    provider_status: getProviderStatus(),
    ...SAFETY,
  };
}
function getMissingSymbols() {
  const symbols = allCoverageRows().filter((s) => ['weak', 'medium', 'missing', 'missing_provider'].includes(s.data_quality));
  return { ok: true, count: symbols.length, symbols, ...SAFETY };
}
function getAllSymbolCoverage() {
  const symbols = allCoverageRows().sort((a, b) => b.coverage_score - a.coverage_score || a.symbol.localeCompare(b.symbol));
  return { ok: true, count: symbols.length, symbols, ...SAFETY };
}
function getSymbolCoverage(symbol) {
  return { ok: true, coverage: buildCoverageRow(symbol), ...SAFETY };
}
function marketLabel(groupId, groups) {
  return groups[groupId]?.label_sv || groups[groupId]?.label || groupId;
}
function getMarketCoverage() {
  const universe = getUniverse();
  const rows = allCoverageRows();
  const markets = MARKET_GROUPS.map((groupId) => {
    const groupRows = rows.filter((row) => row.market_group === groupId || (
      groupId === 'nasdaq100' && ['NVDA', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'QQQ'].includes(row.symbol)
    ) || (
      groupId === 'sp500' && ['SPY', 'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA'].includes(row.symbol)
    ) || (
      groupId === 'mag7' && ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN'].includes(row.symbol)
    ));
    const sorted = [...groupRows].sort((a, b) => b.coverage_score - a.coverage_score);
    return {
      market_group: groupId,
      label_sv: marketLabel(groupId, universe.groups),
      symbols_count: groupRows.length,
      good_count: groupRows.filter((s) => s.data_quality === 'good').length,
      weak_count: groupRows.filter((s) => ['medium', 'weak'].includes(s.data_quality)).length,
      missing_count: groupRows.filter((s) => s.data_quality === 'missing' || s.data_quality === 'missing_provider').length,
      total_candles: groupRows.reduce((sum, s) => sum + s.candles_count, 0),
      coverage_score: groupRows.length ? Math.round(groupRows.reduce((sum, s) => sum + s.coverage_score, 0) / groupRows.length) : 0,
      best_symbols: sorted.slice(0, 5).map((s) => ({ symbol: s.symbol, coverage_score: s.coverage_score, days_covered: s.days_covered })),
      worst_symbols: sorted.slice(-5).reverse().map((s) => ({ symbol: s.symbol, coverage_score: s.coverage_score, days_covered: s.days_covered, reason: s.reason })),
      ...SAFETY,
    };
  });
  return { ok: true, markets, ...SAFETY };
}
function scorePriority(row, index) {
  let score = 100 - Math.min(70, row.coverage_score);
  if (index !== -1) score += 70 - index;
  if (['QQQ', 'SPY', 'IWM', 'DIA'].includes(row.symbol)) score += 40;
  if (['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD', 'META', 'GOOGL', 'AMZN'].includes(row.symbol)) score += 30;
  if (['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT'].includes(row.symbol)) score += 25;
  if (row.data_quality === 'missing_provider') score -= 80;
  return Math.round(score);
}
function prioritizeDataBackfill() {
  const rows = allCoverageRows();
  const priority = rows
    .filter((row) => row.data_quality !== 'good')
    .map((row) => {
      const idx = PRIORITY_SYMBOLS.indexOf(row.symbol);
      const targetDays = row.market_group === 'crypto' ? 45 : 30;
      return {
        symbol: row.symbol,
        market_group: row.market_group,
        current_days: row.days_covered,
        current_candles: row.candles_count,
        data_quality: row.data_quality,
        status_sv: row.status_sv,
        provider: providerFor(row.symbol, row.market_group),
        priority_score: scorePriority(row, idx),
        suggested_from_date: addDays(todayIso(), -targetDays),
        suggested_to_date: todayIso(),
        reason: row.reason,
        ...SAFETY,
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score || a.symbol.localeCompare(b.symbol));
  return { ok: true, plan: priority, count: priority.length, ...SAFETY };
}
function activeJobCount() {
  return loadJobs().filter((job) => job.status === 'running').length;
}
function loadJobs() {
  const rows = readJson(JOBS_FILE, []);
  return Array.isArray(rows) ? rows : [];
}
function saveJobs(jobs) {
  writeJson(JOBS_FILE, jobs.slice(0, 200));
}
function saveJob(job) {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.job_id === job.job_id);
  if (idx >= 0) jobs[idx] = job;
  else jobs.unshift(job);
  saveJobs(jobs);
  return job;
}
function getJob(jobId) {
  return loadJobs().find((job) => job.job_id === jobId) || null;
}
function normalizeBackfillInput(input = {}) {
  const planSymbols = prioritizeDataBackfill().plan.slice(0, 10).map((row) => row.symbol);
  const symbols = uniqueSymbols(input.symbols || input.symbol || planSymbols);
  const timeframes = normalizeTimeframes(input.timeframes || input.timeframe || ['2m']);
  const toDate = parseDate(input.to_date || input.toDate || input.end || input.end_date, todayIso());
  const fromDate = parseDate(input.from_date || input.fromDate || input.start || input.start_date, addDays(toDate, -29));
  const universe = getUniverse();
  const firstGroup = input.market_group || input.marketGroup || (symbols[0] ? inferMarketGroup(symbols[0], universe.bySymbol) : 'custom');
  const requestedProvider = input.provider || 'auto';
  const provider = requestedProvider === 'auto' ? 'auto' : providerFor(symbols[0] || '', firstGroup, requestedProvider);
  return {
    symbols,
    market_group: firstGroup,
    timeframe: timeframes[0] || '2m',
    timeframes,
    from_date: fromDate,
    to_date: toDate,
    provider,
  };
}
function validateBackfillSafety(input = {}) {
  const normalized = normalizeBackfillInput(input);
  const errors = {};
  if (input.actions_allowed === true || input.can_place_orders === true || input.live_trading_enabled === true || input.mode === 'live') {
    errors.safety = 'live_trading_not_allowed';
  }
  if (normalized.symbols.length < 1) errors.symbols = 'required';
  if (normalized.symbols.length > LIMITS.maxSymbolsPerJob) errors.symbols = `max_${LIMITS.maxSymbolsPerJob}`;
  if (daysBetween(normalized.from_date, normalized.to_date) > LIMITS.maxDaysPerJob) errors.date_range = `max_${LIMITS.maxDaysPerJob}_days`;
  if (normalized.timeframes.length > LIMITS.maxTimeframesPerJob) errors.timeframes = `max_${LIMITS.maxTimeframesPerJob}`;
  if (activeJobCount() >= LIMITS.maxActiveJobs) errors.active_jobs = 'max_active_jobs';
  return {
    ok: Object.keys(errors).length === 0,
    input: normalized,
    errors,
    message_sv: Object.keys(errors).length ? 'Backfill-jobbet är för stort. Minska antal symboler eller dagar.' : 'Backfill-jobbet är säkert.',
    limits: LIMITS,
    ...SAFETY,
  };
}
function createBackfillPlan(input = {}) {
  const validation = validateBackfillSafety(input);
  if (!validation.ok) return { ok: false, error: validation.message_sv, errors: validation.errors, limits: LIMITS, ...SAFETY };
  const cfg = validation.input;
  const createdAt = nowIso();
  const totalSteps = cfg.symbols.length * cfg.timeframes.length;
  const job = {
    job_id: `dc_backfill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    symbols: cfg.symbols,
    market_group: cfg.market_group,
    timeframe: cfg.timeframe,
    timeframes: cfg.timeframes,
    from_date: cfg.from_date,
    to_date: cfg.to_date,
    provider: cfg.provider,
    status: 'created',
    progress: { total: totalSteps, completed: 0, failed: 0, pct: 0 },
    candles_downloaded: 0,
    errors: [],
    started_at: '',
    completed_at: '',
    created_at: createdAt,
    updated_at: createdAt,
    ...SAFETY,
  };
  saveJob(job);
  auditTrail.logAuditEvent({ type: 'DATA_BACKFILL_CREATED', source: 'data_coverage', timestamp: createdAt, message: 'Data backfill skapad', details: { job_id: job.job_id, symbols: job.symbols, timeframes: job.timeframes, provider: job.provider } });
  return { ok: true, job, ...SAFETY };
}
function normalizeCandle(bar, symbol, timeframe, provider) {
  const timestamp = bar.timestamp || bar.ts || bar.t;
  return {
    symbol,
    timeframe,
    timestamp,
    ts: timestamp,
    t: timestamp,
    open: Number(bar.open ?? bar.o),
    high: Number(bar.high ?? bar.h),
    low: Number(bar.low ?? bar.l),
    close: Number(bar.close ?? bar.c),
    volume: Number(bar.volume ?? bar.v ?? 0),
    provider,
    downloaded_at: nowIso(),
  };
}
function groupByDate(candles) {
  const byDate = {};
  for (const candle of candles) {
    const date = String(candle.timestamp || candle.ts || '').slice(0, 10);
    if (!date) continue;
    byDate[date] = byDate[date] || [];
    byDate[date].push(candle);
  }
  return byDate;
}
async function fetchProviderCandles(symbol, timeframe, fromDate, toDate, provider) {
  const status = providerStatusFor(provider);
  if (!status.ok) {
    const err = new Error(status.message_sv || 'Provider saknar nyckel.');
    err.safeMessageSv = status.message_sv || 'Provider saknar nyckel.';
    throw err;
  }
  if (provider === 'binance') {
    if (timeframe === '2m') {
      const raw = await fetchBinanceKlines({ symbol, interval: '1m', start: fromDate, end: toDate, limit: 1000 });
      return filterComplete(aggregate1mTo2m(raw));
    }
    return fetchBinanceKlines({ symbol, interval: timeframe, start: fromDate, end: toDate, limit: 1000 });
  }
  if (provider === 'alpaca') {
    if (timeframe === '2m') {
      const raw = await fetchAlpacaBars({ symbol, timeframe: '1Min', start: fromDate, end: toDate, limit: 10000 });
      return filterComplete(aggregate1mTo2m(raw));
    }
    const alpacaTf = timeframe === '1m' ? '1Min' : timeframe === '5m' ? '5Min' : timeframe === '15m' ? '15Min' : timeframe === '30m' ? '30Min' : timeframe === '1h' ? '1Hour' : '1Min';
    return fetchAlpacaBars({ symbol, timeframe: alpacaTf, start: fromDate, end: toDate, limit: 10000 });
  }
  const err = new Error('Provider saknar nyckel.');
  err.safeMessageSv = 'Provider saknar nyckel.';
  throw err;
}
function saveCandles(symbol, marketGroup, timeframe, provider, bars) {
  const candles = bars.map((bar) => normalizeCandle(bar, symbol, timeframe, provider)).filter((c) => c.timestamp && Number.isFinite(c.close));
  const byDate = groupByDate(candles);
  let saved = 0;
  const dir = candleDirsFor(symbol, timeframe, marketGroup).primary;
  for (const [date, rows] of Object.entries(byDate)) {
    const before = countJsonlLines(dateFile(dir, date));
    const after = writeJsonlDedup(dateFile(dir, date), rows);
    saved += Math.max(0, after - before);
  }
  return saved;
}
function updateProgress(job) {
  const total = Math.max(1, Number(job.progress.total) || 1);
  job.progress.pct = Math.round(((job.progress.completed + job.progress.failed) / total) * 100);
  job.updated_at = nowIso();
}
async function executeJob(jobId) {
  let job = getJob(jobId);
  if (!job) return;
  const runState = runningJobs.get(jobId);
  for (const symbol of job.symbols) {
    for (const timeframe of job.timeframes) {
      job = getJob(jobId) || job;
      if (runState?.stop || job.status === 'stopped') {
        job.status = 'stopped';
        job.completed_at = nowIso();
        saveJob(job);
        runningJobs.delete(jobId);
        return;
      }
      if (runState?.pause || job.status === 'paused') {
        job.status = 'paused';
        saveJob(job);
        runningJobs.delete(jobId);
        return;
      }
      try {
        const universe = getUniverse();
        const marketGroup = inferMarketGroup(symbol, universe.bySymbol);
        const provider = providerFor(symbol, marketGroup, job.provider);
        const bars = await fetchProviderCandles(symbol, timeframe, job.from_date, job.to_date, provider);
        const saved = saveCandles(symbol, marketGroup, timeframe, provider, bars);
        job.candles_downloaded += saved;
        job.progress.completed += 1;
        auditTrail.logAuditEvent({ type: 'DATA_BACKFILL_PROGRESS', source: 'data_coverage', timestamp: nowIso(), symbol, message: `Data backfill uppdaterad för ${symbol}`, details: { job_id: job.job_id, timeframe, candles_downloaded: job.candles_downloaded, saved } });
      } catch (err) {
        job.progress.failed += 1;
        job.errors.push({ symbol, timeframe, message: err.safeMessageSv || simplifyProviderError(err), at: nowIso() });
        if (/Provider saknar nyckel/i.test(err.safeMessageSv || err.message || '')) {
          job.status = 'failed';
          job.completed_at = nowIso();
          updateProgress(job);
          saveJob(job);
          auditTrail.logAuditEvent({ type: 'DATA_BACKFILL_FAILED', source: 'data_coverage', timestamp: nowIso(), symbol, message: 'Data backfill misslyckades', details: { job_id: job.job_id, error: 'Provider saknar nyckel.' } });
          runningJobs.delete(jobId);
          return;
        }
      }
      updateProgress(job);
      saveJob(job);
      await delay(LIMITS.providerCallDelayMs);
    }
  }
  job.status = job.errors.length && job.progress.completed === 0 ? 'failed' : 'completed';
  job.completed_at = nowIso();
  updateProgress(job);
  saveJob(job);
  auditTrail.logAuditEvent({ type: job.status === 'completed' ? 'DATA_BACKFILL_COMPLETED' : 'DATA_BACKFILL_FAILED', source: 'data_coverage', timestamp: job.completed_at, message: job.status === 'completed' ? 'Data backfill klar' : 'Data backfill misslyckades', details: { job_id: job.job_id, candles_downloaded: job.candles_downloaded, errors: job.errors.length } });
  auditTrail.logAuditEvent({ type: 'DATA_COVERAGE_UPDATED', source: 'data_coverage', timestamp: nowIso(), message: 'Data coverage uppdaterad', details: { job_id: job.job_id } });
  runningJobs.delete(jobId);
}
function simplifyProviderError(err) {
  const msg = String(err?.message || '');
  if (/credential|api key|secret|forbidden|unauthorized|ALPACA/i.test(msg)) return 'Provider saknar nyckel.';
  if (/rate/i.test(msg)) return 'Provider rate limit. Försök senare.';
  if (/timeout/i.test(msg)) return 'Provider svarade inte i tid.';
  return 'Provider kunde inte hämta historik.';
}
function runBackfillJob(jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: 'backfill_job_not_found', ...SAFETY };
  if (job.status === 'running') return { ok: true, job, message_sv: 'Jobbet kör redan.', ...SAFETY };
  if (activeJobCount() >= LIMITS.maxActiveJobs) return { ok: false, error: 'max_active_jobs', message_sv: 'Max ett aktivt backfill-jobb åt gången.', limits: LIMITS, ...SAFETY };
  job.status = 'running';
  job.started_at = job.started_at || nowIso();
  job.completed_at = '';
  job.updated_at = nowIso();
  saveJob(job);
  runningJobs.set(jobId, { pause: false, stop: false });
  auditTrail.logAuditEvent({ type: 'DATA_BACKFILL_STARTED', source: 'data_coverage', timestamp: job.started_at, message: 'Data backfill startad', details: { job_id: job.job_id } });
  executeJob(jobId).catch((err) => {
    const latest = getJob(jobId) || job;
    latest.status = 'failed';
    latest.errors = [...(latest.errors || []), { message: simplifyProviderError(err), at: nowIso() }];
    latest.completed_at = nowIso();
    saveJob(latest);
    runningJobs.delete(jobId);
  });
  return { ok: true, job, ...SAFETY };
}
function pauseBackfillJob(jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: 'backfill_job_not_found', ...SAFETY };
  const state = runningJobs.get(jobId);
  if (state) state.pause = true;
  job.status = 'paused';
  job.updated_at = nowIso();
  saveJob(job);
  return { ok: true, job, ...SAFETY };
}
function stopBackfillJob(jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: 'backfill_job_not_found', ...SAFETY };
  const state = runningJobs.get(jobId);
  if (state) state.stop = true;
  job.status = 'stopped';
  job.completed_at = nowIso();
  job.updated_at = nowIso();
  saveJob(job);
  return { ok: true, job, ...SAFETY };
}
function getBackfillStatus(jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, error: 'backfill_job_not_found', ...SAFETY };
  return { ok: true, job, ...SAFETY };
}
function listBackfillJobs() {
  return { ok: true, jobs: loadJobs(), limits: LIMITS, ...SAFETY };
}
function getProviderStatus() {
  return {
    alpaca: providerStatusFor('alpaca'),
    binance: providerStatusFor('binance'),
    finnhub: providerStatusFor('finnhub'),
    polygon: providerStatusFor('polygon'),
    crypto: providerStatusFor('binance'),
  };
}

module.exports = {
  SAFETY,
  LIMITS,
  getCoverageStatus,
  getAllSymbolCoverage,
  getMissingSymbols,
  getSymbolCoverage,
  getMarketCoverage,
  prioritizeDataBackfill,
  createBackfillPlan,
  runBackfillJob,
  pauseBackfillJob,
  stopBackfillJob,
  getBackfillStatus,
  listBackfillJobs,
  validateBackfillSafety,
  getProviderStatus,
  _internal: { writeJsonlDedup, saveCandles, normalizeBackfillInput, buildCoverageRow },
};
