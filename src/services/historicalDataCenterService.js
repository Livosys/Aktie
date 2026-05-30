'use strict';

const fs = require('fs');
const path = require('path');
const redisService = require('./redisService');
const marketUniverse = require('./marketUniverseService');

const ROOT = path.resolve(__dirname, '../..');
const DATA_ROOT = path.join(ROOT, 'data');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  read_only: true,
});

const STORAGE_PATHS = Object.freeze([
  { key: 'market_data', label: 'Market data', rel: 'data/market-data' },
  { key: 'signals_history', label: 'Historiska signaler', rel: 'data/signals/history' },
  { key: 'signals_outcomes', label: 'Signalutfall', rel: 'data/signals/outcomes' },
  { key: 'signal_memory', label: 'Signalminne / AI lessons', rel: 'data/signal-memory' },
  { key: 'paper_trading', label: 'Låtsastrading', rel: 'data/paper-trading' },
  { key: 'audit_trail', label: 'Audit trail', rel: 'data/audit-trail' },
  { key: 'replay', label: 'Replay', rel: 'data/replay' },
  { key: 'replay_intelligence', label: 'Replay Intelligence', rel: 'data/replay-intelligence' },
  { key: 'strategy_batches', label: 'Batch tester', rel: 'data/strategy-batches' },
  { key: 'strategy_tests', label: 'Strategitester', rel: 'data/daytrading-strategies' },
  { key: 'feature_logs', label: 'Feature logs', rel: 'data/feature-logs' },
  { key: 'daily_intelligence', label: 'Daglig intelligens', rel: 'data/daily-intelligence' },
]);

let cache = null;
let cacheAt = 0;
const CACHE_MS = 15_000;

function nowIso() {
  return new Date().toISOString();
}

function abs(rel) {
  return path.join(ROOT, rel);
}

function exists(fp) {
  try { return fs.existsSync(fp); } catch (_) { return false; }
}

function statSafe(fp) {
  try { return fs.statSync(fp); } catch (_) { return null; }
}

function readJson(file, fallback) {
  try {
    if (!exists(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonl(file, limit = Infinity) {
  try {
    if (!exists(file)) return [];
    const rows = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const slice = Number.isFinite(limit) ? lines.slice(-limit) : lines;
    for (const line of slice) {
      try { rows.push(JSON.parse(line)); } catch (_) {}
    }
    return rows;
  } catch (_) {
    return [];
  }
}

function countJsonlLines(file) {
  try {
    if (!exists(file)) return 0;
    const buf = fs.readFileSync(file);
    if (!buf.length) return 0;
    let lines = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 10) lines += 1;
    }
    return buf[buf.length - 1] === 10 ? lines : lines + 1;
  } catch (_) {
    return 0;
  }
}

function listDir(dir) {
  try {
    if (!exists(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function walkFiles(dir, predicate = () => true) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of listDir(current)) {
      const fp = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fp);
      else if (entry.isFile() && predicate(fp, entry.name)) out.push(fp);
    }
  }
  return out;
}

function folderStats(dir) {
  let bytes = 0;
  let files = 0;
  let latestMtime = null;
  if (!exists(dir)) return { exists: false, bytes: 0, files: 0, latest_mtime: null };

  for (const file of walkFiles(dir)) {
    const st = statSafe(file);
    if (!st) continue;
    files += 1;
    bytes += st.size;
    const iso = st.mtime.toISOString();
    if (!latestMtime || iso > latestMtime) latestMtime = iso;
  }
  return { exists: true, bytes, files, latest_mtime: latestMtime };
}

function addDate(range, value) {
  if (!value) return;
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const firstKey = Object.prototype.hasOwnProperty.call(range, 'first_date') ? 'first_date' : 'first';
  const latestKey = Object.prototype.hasOwnProperty.call(range, 'latest_date') ? 'latest_date' : 'latest';
  if (!range[firstKey] || date < range[firstKey]) range[firstKey] = date;
  if (!range[latestKey] || date > range[latestKey]) range[latestKey] = date;
}

function inferMarketGroup(symbol, universeBySymbol = {}) {
  const known = universeBySymbol[symbol];
  if (known?.marketGroup || known?.group) return known.marketGroup || known.group;
  if (/USDT$/.test(symbol)) return 'crypto';
  if (['QQQ', 'SPY', 'DIA', 'IWM'].includes(symbol)) return 'index';
  if (['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA'].includes(symbol)) return 'leveraged_etf';
  return 'stocks';
}

function ensureSymbol(map, symbol, universeBySymbol = {}) {
  const key = String(symbol || '').trim().toUpperCase();
  if (!key) return null;
  if (!map.has(key)) {
    const uni = universeBySymbol[key] || {};
    map.set(key, {
      symbol: key,
      market_group: inferMarketGroup(key, universeBySymbol),
      enabled: uni.enabled === true,
      paused: uni.paused === true,
      first_date: null,
      latest_date: null,
      raw_days: 0,
      candles_2m_days: 0,
      candles_2m_count: 0,
      total_candle_count: 0,
      file_count: 0,
      bytes: 0,
      timeframes: {},
      sources: {},
    });
  }
  return map.get(key);
}

function toneForSymbol(row) {
  const days = row.candles_2m_days || 0;
  const candles = row.candles_2m_count || 0;
  if (days >= 10 && candles >= 500) return 'green';
  if (days > 0 || candles > 0 || row.raw_days > 0) return 'yellow';
  return 'red';
}

function SwedishTone(tone) {
  if (tone === 'green') return 'Bra data';
  if (tone === 'yellow') return 'Lite data';
  return 'Saknar data';
}

function scanMarketData(universeBySymbol) {
  const symbolMap = new Map();
  const globalRange = { first: null, latest: null };
  const roots = [
    { source: 'shared', timeframe: '2m', dir: abs('data/market-data/candles-2m') },
    { source: 'shared', timeframe: '5m', dir: abs('data/market-data/candles-5m') },
    { source: 'shared', timeframe: '15m', dir: abs('data/market-data/candles-15m') },
    { source: 'shared', timeframe: '30m', dir: abs('data/market-data/candles-30m') },
    { source: 'shared', timeframe: '1h', dir: abs('data/market-data/candles-1h') },
    { source: 'alpaca', timeframe: '2m', dir: abs('data/market-data/alpaca/candles-2m') },
    { source: 'alpaca', timeframe: 'raw', dir: abs('data/market-data/alpaca/raw') },
    { source: 'binance', timeframe: 'raw', dir: abs('data/market-data/binance/raw') },
  ];

  for (const root of roots) {
    for (const entry of listDir(root.dir)) {
      if (!entry.isDirectory()) continue;
      const symbol = entry.name.toUpperCase();
      const row = ensureSymbol(symbolMap, symbol, universeBySymbol);
      if (!row) continue;
      const dir = path.join(root.dir, entry.name);
      const files = listDir(dir)
        .filter((f) => f.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.name))
        .map((f) => f.name)
        .sort();
      if (!files.length) continue;

      const tfKey = root.timeframe === 'raw' ? `raw_${root.source}` : root.timeframe;
      row.timeframes[tfKey] = row.timeframes[tfKey] || { days: 0, candles: 0, bytes: 0, files: 0 };
      row.sources[root.source] = row.sources[root.source] || { files: 0, bytes: 0 };

      for (const file of files) {
        const date = file.replace('.jsonl', '');
        const fp = path.join(dir, file);
        const st = statSafe(fp);
        const bytes = st?.size || 0;
        const lines = countJsonlLines(fp);
        addDate(row, date);
        addDate(globalRange, date);
        row.file_count += 1;
        row.bytes += bytes;
        row.sources[root.source].files += 1;
        row.sources[root.source].bytes += bytes;
        row.timeframes[tfKey].days += 1;
        row.timeframes[tfKey].files += 1;
        row.timeframes[tfKey].bytes += bytes;
        row.timeframes[tfKey].candles += lines;
        if (root.timeframe === 'raw') row.raw_days += 1;
        else {
          row.total_candle_count += lines;
          if (root.timeframe === '2m') {
            row.candles_2m_days += 1;
            row.candles_2m_count += lines;
          }
        }
      }
    }
  }

  const symbols = Array.from(symbolMap.values()).map((row) => ({
    ...row,
    tone: toneForSymbol(row),
    status_sv: SwedishTone(toneForSymbol(row)),
  })).sort((a, b) => b.candles_2m_count - a.candles_2m_count || a.symbol.localeCompare(b.symbol));

  return { symbols, range: globalRange };
}

function countJsonlInDir(rel) {
  return walkFiles(abs(rel), (fp) => fp.endsWith('.jsonl')).reduce((sum, file) => sum + countJsonlLines(file), 0);
}

function scanReplay() {
  const runsDir = abs('data/replay/runs');
  const summaries = walkFiles(runsDir, (fp, name) => name === 'summary.json')
    .map((file) => readJson(file, null))
    .filter(Boolean);
  const sessions = readJson(abs('data/replay-intelligence/sessions/index.json'), []);
  const intelligenceSummaries = walkFiles(abs('data/replay-intelligence/summary'), (fp) => fp.endsWith('.json'))
    .map((file) => readJson(file, null))
    .filter(Boolean);
  const bySymbol = new Map();
  let totalCandles = 0;
  let totalEvents = 0;
  const range = { first: null, latest: null };

  for (const summary of summaries) {
    totalCandles += Number(summary.totalCandles || summary.total_candles || 0) || 0;
    totalEvents += Number(summary.totalEvents || summary.total_events || 0) || 0;
    addDate(range, summary.start || summary.started_at || summary.createdAt);
    addDate(range, summary.end || summary.completed_at || summary.createdAt);
    for (const sym of summary.symbols || []) {
      const key = String(sym).toUpperCase();
      bySymbol.set(key, (bySymbol.get(key) || 0) + 1);
    }
    for (const item of summary.bestSymbols || summary.worstSymbols || []) {
      const key = String(item.symbol || '').toUpperCase();
      if (key) bySymbol.set(key, (bySymbol.get(key) || 0) + Number(item.events || 1));
    }
  }

  for (const summary of intelligenceSummaries) {
    totalEvents += Number(summary.events_total || summary.total_events || summary.count || 0) || 0;
    addDate(range, summary.started_at || summary.created_at || summary.createdAt || summary.timestamp);
    addDate(range, summary.completed_at || summary.updated_at || summary.timestamp);
    for (const row of summary.by_symbol || summary.symbols || []) {
      const key = String(row.symbol || row).toUpperCase();
      if (key) bySymbol.set(key, (bySymbol.get(key) || 0) + Number(row.count || row.events || 1));
    }
  }

  return {
    runs: summaries.length,
    sessions: Array.isArray(sessions) ? sessions.length : intelligenceSummaries.length,
    replay_candles: totalCandles,
    replay_events: totalEvents,
    first_date: range.first,
    latest_date: range.latest,
    top_replayed_symbols: Array.from(bySymbol.entries())
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    coverage_sv: totalCandles > 0
      ? `${summaries.length} replay-runs med ${totalCandles.toLocaleString('sv-SE')} candles`
      : 'Ingen replay coverage hittad',
  };
}

function scanPaperTrading() {
  const trades = readJsonl(abs('data/paper-trading/trades.jsonl'));
  const state = readJson(abs('data/paper-trading/state.json'), {});
  const openTrades = Array.isArray(state.openTrades) ? state.openTrades : [];
  const bySymbol = new Map();
  const range = { first: null, latest: null };
  for (const trade of [...trades, ...openTrades]) {
    const symbol = String(trade.symbol || '').toUpperCase();
    if (symbol) bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + 1);
    addDate(range, trade.entryTime || trade.opened_at || trade.timestamp);
    addDate(range, trade.exitTime || trade.closed_at || trade.entryTime);
  }
  return {
    total: trades.length + openTrades.length,
    closed: trades.length,
    open: openTrades.length,
    first_date: range.first,
    latest_date: range.latest,
    top_traded_symbols: Array.from(bySymbol.entries())
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

function scanStrategyCoverage() {
  const strategyTests = readJson(abs('data/daytrading-strategies/results-v1.json'), []);
  const batches = readJson(abs('data/strategy-batches/batches-v1.json'), []);
  const batchResultFiles = walkFiles(abs('data/strategy-batches/results'), (fp) => fp.endsWith('.json'));
  let batchResultRows = 0;
  const byStrategy = new Map();
  const bySymbol = new Map();
  const range = { first: null, latest: null };

  function addStrategy(row) {
    const sid = String(row.strategy_id || row.strategyId || 'unknown');
    byStrategy.set(sid, (byStrategy.get(sid) || 0) + 1);
    const symbols = Array.isArray(row.symbols) ? row.symbols : [row.symbol || row.best_symbol].filter(Boolean);
    for (const symbol of symbols) {
      const key = String(symbol || '').toUpperCase();
      if (key) bySymbol.set(key, (bySymbol.get(key) || 0) + 1);
    }
    addDate(range, row.created_at || row.test_created_at || row.batch_created_at);
    addDate(range, row.completed_at || row.test_completed_at || row.batch_completed_at || row.updated_at);
  }

  for (const row of Array.isArray(strategyTests) ? strategyTests : []) addStrategy(row);
  for (const row of Array.isArray(batches) ? batches : []) addStrategy(row);
  for (const file of batchResultFiles) {
    const rows = readJson(file, []);
    if (Array.isArray(rows)) {
      batchResultRows += rows.length;
      for (const row of rows) addStrategy(row);
    }
  }

  return {
    strategy_tests: Array.isArray(strategyTests) ? strategyTests.length : 0,
    batch_tests: Array.isArray(batches) ? batches.length : 0,
    batch_result_rows: batchResultRows,
    unique_strategies: byStrategy.size,
    symbols_tested: bySymbol.size,
    first_date: range.first,
    latest_date: range.latest,
    top_strategies: Array.from(byStrategy.entries()).map(([strategy_id, count]) => ({ strategy_id, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    top_symbols: Array.from(bySymbol.entries()).map(([symbol, count]) => ({ symbol, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    coverage_sv: byStrategy.size
      ? `${byStrategy.size} strategier testade över ${bySymbol.size} symboler`
      : 'Ingen strategy coverage hittad',
  };
}

function countSignalMemoryLessons() {
  const memory = readJson(abs('data/signal-memory/signal_memory.json'), []);
  if (Array.isArray(memory)) return memory.length;
  if (memory && typeof memory === 'object') {
    if (Array.isArray(memory.items)) return memory.items.length;
    if (Array.isArray(memory.signals)) return memory.signals.length;
    return Object.keys(memory).length;
  }
  return 0;
}

function scanMarkets(symbols, universe) {
  const groups = universe.groups || {};
  const byMarket = new Map();
  for (const row of symbols) {
    const key = row.market_group || 'unknown';
    if (!byMarket.has(key)) {
      byMarket.set(key, {
        market_group: key,
        label_sv: groups[key]?.label_sv || groups[key]?.label || key,
        symbol_count: 0,
        candles_2m_count: 0,
        total_candle_count: 0,
        bytes: 0,
        good_symbols: 0,
        weak_symbols: 0,
        missing_symbols: 0,
      });
    }
    const market = byMarket.get(key);
    market.symbol_count += 1;
    market.candles_2m_count += row.candles_2m_count || 0;
    market.total_candle_count += row.total_candle_count || 0;
    market.bytes += row.bytes || 0;
    if (row.tone === 'green') market.good_symbols += 1;
    else if (row.tone === 'yellow') market.weak_symbols += 1;
    else market.missing_symbols += 1;
  }
  return Array.from(byMarket.values()).sort((a, b) => b.total_candle_count - a.total_candle_count || b.bytes - a.bytes);
}

function scanMissing(symbolsWithData, universe) {
  const dataMap = new Map(symbolsWithData.map((row) => [row.symbol, row]));
  const allUniverseSymbols = Array.isArray(universe.symbols) ? universe.symbols : [];
  const missing = [];
  for (const item of allUniverseSymbols) {
    const symbol = String(item.symbol || '').toUpperCase();
    if (!symbol || dataMap.has(symbol)) continue;
    missing.push({
      symbol,
      market_group: item.marketGroup || item.group || 'unknown',
      enabled: item.enabled === true,
      reason_sv: item.data_status === 'needs_provider' || item.placeholder
        ? 'Saknar datakälla eller verifierad symbol'
        : 'Ingen historik hittad i storage',
      tone: 'red',
      status_sv: 'Saknar data',
    });
  }
  const weak = symbolsWithData
    .filter((row) => row.tone === 'yellow')
    .map((row) => ({
      symbol: row.symbol,
      market_group: row.market_group,
      enabled: row.enabled,
      reason_sv: 'Lite historik eller få 2m-candles',
      tone: 'yellow',
      status_sv: 'Lite data',
    }));
  return {
    symbols_missing: missing.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.symbol.localeCompare(b.symbol)),
    symbols_weak: weak.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.symbol.localeCompare(b.symbol)),
    enabled_missing_count: missing.filter((row) => row.enabled).length,
    total_missing_count: missing.length,
    weak_count: weak.length,
  };
}

function scanStorage() {
  const paths = STORAGE_PATHS.map((item) => {
    const full_path = abs(item.rel);
    return {
      ...item,
      full_path,
      ...folderStats(full_path),
    };
  });
  const totalBytes = paths.reduce((sum, row) => sum + row.bytes, 0);
  const totalFiles = paths.reduce((sum, row) => sum + row.files, 0);
  return { paths, total_bytes: totalBytes, total_files: totalFiles };
}

async function buildDataCenter(options = {}) {
  if (!options.force && cache && Date.now() - cacheAt < CACHE_MS) return cache;

  const universe = marketUniverse.getUniverse();
  const universeBySymbol = Object.fromEntries((universe.symbols || []).map((item) => [String(item.symbol || '').toUpperCase(), item]));
  const marketData = scanMarketData(universeBySymbol);
  const replay = scanReplay();
  const paper = scanPaperTrading();
  const strategy = scanStrategyCoverage();
  const storage = scanStorage();
  const redisUsage = redisService.usage ? await redisService.usage() : redisService.status();
  const memory = process.memoryUsage();
  const globalRange = { first: null, latest: null };

  [marketData.range, replay, paper, strategy].forEach((source) => {
    addDate(globalRange, source.first || source.first_date);
    addDate(globalRange, source.latest || source.latest_date);
  });

  const signalsCount = countJsonlInDir('data/signals/history');
  const outcomesCount = countJsonlInDir('data/signals/outcomes');
  const featureLogCount = countJsonlInDir('data/feature-logs');
  const auditEvents = countJsonlLines(abs('data/audit-trail/events.jsonl'));
  const candidates = countJsonlLines(abs('data/signals/candidates.jsonl'));
  const aiLessons = countSignalMemoryLessons();
  const markets = scanMarkets(marketData.symbols, universe);
  const missing = scanMissing(marketData.symbols, universe);

  const counts = {
    replay_candles: replay.replay_candles,
    replay_events: replay.replay_events,
    paper_trades: paper.total,
    audit_events: auditEvents,
    batch_tests: strategy.batch_tests,
    strategy_tests: strategy.strategy_tests,
    strategy_batch_result_rows: strategy.batch_result_rows,
    signals: signalsCount,
    signal_outcomes: outcomesCount,
    candidates,
    ai_lessons: aiLessons,
    feature_log_rows: featureLogCount,
    symbols_with_history: marketData.symbols.length,
    markets_with_data: markets.filter((row) => row.total_candle_count > 0 || row.bytes > 0).length,
  };

  const goodSymbols = marketData.symbols.filter((row) => row.tone === 'green').length;
  const weakSymbols = marketData.symbols.filter((row) => row.tone === 'yellow').length;
  const totalKnown = marketData.symbols.length + missing.total_missing_count;
  const coveragePct = totalKnown ? Math.round((goodSymbols / totalKnown) * 100) : 0;
  const healthTone = coveragePct >= 60 ? 'green' : coveragePct >= 25 || weakSymbols > 0 ? 'yellow' : 'red';

  const result = {
    ok: true,
    generated_at: nowIso(),
    safety: SAFETY,
    ...SAFETY,
    counts,
    date_range: {
      first_date: globalRange.first,
      latest_date: globalRange.latest,
    },
    health: {
      tone: healthTone,
      coverage_pct: coveragePct,
      good_symbols: goodSymbols,
      weak_symbols: weakSymbols,
      missing_symbols: missing.total_missing_count,
      message_sv: healthTone === 'green'
        ? 'Historiken ser bra ut.'
        : healthTone === 'yellow'
          ? 'Det finns historik, men flera symboler behöver mer data.'
          : 'Mycket historik saknas.',
    },
    symbols: marketData.symbols,
    markets,
    missing,
    storage,
    redis_usage: redisUsage,
    memory_usage: {
      rss_bytes: memory.rss,
      heap_total_bytes: memory.heapTotal,
      heap_used_bytes: memory.heapUsed,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
    },
    replay_coverage: replay,
    strategy_coverage: strategy,
    top_traded_symbols: paper.top_traded_symbols,
    top_replayed_symbols: replay.top_replayed_symbols,
    data_sources: {
      market_data_paths: [
        'data/market-data/candles-2m',
        'data/market-data/candles-5m',
        'data/market-data/candles-15m',
        'data/market-data/candles-30m',
        'data/market-data/candles-1h',
        'data/market-data/alpaca/raw',
        'data/market-data/binance/raw',
      ],
      signal_paths: ['data/signals/history', 'data/signals/outcomes', 'data/signal-memory'],
      replay_paths: ['data/replay/runs', 'data/replay-intelligence'],
      trading_paths: ['data/paper-trading', 'data/strategy-batches', 'data/daytrading-strategies'],
      audit_paths: ['data/audit-trail', 'data/signals/candidates.jsonl'],
    },
  };

  cache = result;
  cacheAt = Date.now();
  return result;
}

function pickSummary(data) {
  return {
    ok: true,
    generated_at: data.generated_at,
    safety: data.safety,
    ...SAFETY,
    counts: data.counts,
    date_range: data.date_range,
    health: data.health,
    markets: data.markets,
    replay_coverage: data.replay_coverage,
    strategy_coverage: data.strategy_coverage,
    top_traded_symbols: data.top_traded_symbols,
    top_replayed_symbols: data.top_replayed_symbols,
    data_sources: data.data_sources,
    redis_usage: data.redis_usage,
    memory_usage: data.memory_usage,
  };
}

async function getStatus(options) {
  const data = await buildDataCenter(options);
  return {
    ok: true,
    generated_at: data.generated_at,
    safety: data.safety,
    ...SAFETY,
    counts: data.counts,
    date_range: data.date_range,
    health: data.health,
    redis_usage: data.redis_usage,
    memory_usage: data.memory_usage,
  };
}

async function getSummary(options) {
  return pickSummary(await buildDataCenter(options));
}

async function getSymbols(options) {
  const data = await buildDataCenter(options);
  return { ok: true, generated_at: data.generated_at, symbols: data.symbols, count: data.symbols.length, ...SAFETY };
}

async function getStorage(options) {
  const data = await buildDataCenter(options);
  return { ok: true, generated_at: data.generated_at, storage: data.storage, ...SAFETY };
}

async function getCoverage(options) {
  const data = await buildDataCenter(options);
  return {
    ok: true,
    generated_at: data.generated_at,
    health: data.health,
    markets: data.markets,
    symbols: data.symbols,
    replay_coverage: data.replay_coverage,
    strategy_coverage: data.strategy_coverage,
    ...SAFETY,
  };
}

async function getMissing(options) {
  const data = await buildDataCenter(options);
  return { ok: true, generated_at: data.generated_at, missing: data.missing, ...SAFETY };
}

module.exports = {
  SAFETY,
  buildDataCenter,
  getStatus,
  getSummary,
  getSymbols,
  getStorage,
  getCoverage,
  getMissing,
};
