'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const strategyCatalog = require('./daytradingStrategyCatalogService');
const auditTrail = require('./auditTrailService');

const SAFETY = strategyCatalog.SAFETY;
const DATA_DIR = path.resolve(__dirname, '../../data/daytrading-strategies');
const RESULTS_FILE = path.join(DATA_DIR, 'results-v1.json');

function nowIso() { return new Date().toISOString(); }
function durationSeconds(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}
function durationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}
function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readResults() {
  try {
    if (!fs.existsSync(RESULTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}
function writeResults(results) {
  ensureDir();
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + '\n', 'utf8');
}
function safeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}
function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function maxDrawdownFromPnls(pnls) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const pnl of pnls) {
    equity += Number(pnl) || 0;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return round(maxDd, 3);
}

function normalizeResult(input = {}) {
  const strategy = strategyCatalog.getStrategyById(input.strategy_id || input.strategyId || input.id);
  if (!strategy) {
    const err = new Error('unknown_strategy_id');
    err.statusCode = 404;
    throw err;
  }

  const symbols = safeArray(input.symbols);
  const trades = Math.max(0, Math.round(Number(input.trades) || 0));
  const wins = Math.max(0, Math.round(Number(input.wins) || 0));
  const losses = Math.max(0, Math.round(Number(input.losses) || 0));
  const timeouts = Math.max(0, Math.round(Number(input.timeouts) || Math.max(0, trades - wins - losses)));
  const totalTrades = Math.max(trades, wins + losses + timeouts);
  const totalPnl = round(input.total_pnl ?? input.totalPnl ?? 0, 4);
  const avgPnl = totalTrades ? round(input.avg_pnl ?? input.avgPnl ?? (totalPnl / totalTrades), 4) : 0;
  const winRate = totalTrades ? round((wins / totalTrades) * 100, 2) : 0;
  const createdAt = input.test_created_at || input.created_at || nowIso();
  const startedAt = input.test_started_at || input.started_at || createdAt;
  const completedAt = input.test_completed_at || input.completed_at || nowIso();
  const runDuration = durationSeconds(startedAt, completedAt);
  const marketGroup = input.market_group || input.marketGroup || strategy.market_group;
  const tradedSymbol = firstPresent(input.traded_symbol, input.tradedSymbol, input.symbol, symbols[0]);
  const underlyingSymbol = firstPresent(input.underlying_symbol, input.underlyingSymbol, input.signal_symbol, input.signalSymbol, tradedSymbol);

  return {
    id: input.id || crypto.randomUUID(),
    created_at: createdAt,
    test_created_at: createdAt,
    test_started_at: startedAt,
    test_completed_at: completedAt,
    duration_seconds: runDuration,
    duration_label: durationLabel(runDuration),
    mode: 'paper_replay',
    source: input.source || (input.batch_id || input.batchId ? 'batch_test' : 'strategy_test'),
    live: false,
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    market_group: marketGroup,
    symbols,
    underlying_symbol: underlyingSymbol,
    underlying_market: firstPresent(input.underlying_market, input.underlyingMarket, marketGroup),
    underlying_signal_direction: firstPresent(input.underlying_signal_direction, input.underlyingSignalDirection, input.direction, strategy.direction),
    underlying_signal_strength: Number.isFinite(Number(input.underlying_signal_strength ?? input.underlyingSignalStrength ?? input.confidence ?? input.confidence_threshold))
      ? round(input.underlying_signal_strength ?? input.underlyingSignalStrength ?? input.confidence ?? input.confidence_threshold, 2)
      : null,
    traded_symbol: tradedSymbol,
    traded_instrument_type: firstPresent(input.traded_instrument_type, input.tradedInstrumentType, input.instrument_type, input.instrumentType),
    risk_class: firstPresent(input.risk_class, input.riskClass),
    leverage_factor: Number.isFinite(Number(input.leverage_factor ?? input.leverageFactor ?? input.leverage))
      ? round(input.leverage_factor ?? input.leverageFactor ?? input.leverage, 3)
      : null,
    spread_estimate: Number.isFinite(Number(input.spread_estimate ?? input.spreadEstimate ?? input.spread_percent ?? input.spreadPct))
      ? round(input.spread_estimate ?? input.spreadEstimate ?? input.spread_percent ?? input.spreadPct, 4)
      : null,
    tracking_quality: firstPresent(input.tracking_quality, input.trackingQuality),
    paper_pnl_percent: Number.isFinite(Number(input.paper_pnl_percent ?? input.paperPnlPercent ?? totalPnl))
      ? round(input.paper_pnl_percent ?? input.paperPnlPercent ?? totalPnl, 4)
      : null,
    underlying_move_percent: Number.isFinite(Number(input.underlying_move_percent ?? input.underlyingMovePercent))
      ? round(input.underlying_move_percent ?? input.underlyingMovePercent, 4)
      : null,
    timeframe: String(input.timeframe || strategy.default_timeframes[0] || '2m'),
    sl: round(input.sl ?? input.stop_loss ?? input.stopLoss ?? strategy.default_sl, 3),
    tp: round(input.tp ?? input.take_profit ?? input.takeProfit ?? strategy.default_tp, 3),
    holding_time: Math.max(1, Math.round(Number(input.holding_time ?? input.holdingTime ?? strategy.default_holding_time) || strategy.default_holding_time)),
    timeout: Math.max(1, Math.round(Number(input.timeout ?? strategy.default_holding_time) || strategy.default_holding_time)),
    confidence_threshold: clamp(input.confidence_threshold ?? input.confidenceThreshold ?? 65, 0, 100),
    volume_requirement: round(input.volume_requirement ?? input.volumeRequirement ?? 1.2, 2),
    cooldown: Math.max(0, Math.round(Number(input.cooldown) || 0)),
    max_trades_per_day: Math.max(1, Math.round(Number(input.max_trades_per_day ?? input.maxTradesPerDay ?? 5) || 5)),
    trades: totalTrades,
    wins,
    losses,
    timeouts,
    win_rate: winRate,
    avg_pnl: avgPnl,
    total_pnl: totalPnl,
    max_drawdown: round(input.max_drawdown ?? input.maxDrawdown ?? 0, 3),
    best_symbol: input.best_symbol || input.bestSymbol || symbols[0] || null,
    worst_symbol: input.worst_symbol || input.worstSymbol || symbols[symbols.length - 1] || null,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
  };
}

function deterministicTestResult(input = {}) {
  const strategy = strategyCatalog.getStrategyById(input.strategy_id || input.strategyId || input.id);
  if (!strategy) {
    const err = new Error('unknown_strategy_id');
    err.statusCode = 404;
    throw err;
  }
  const marketGroup = input.market_group || input.marketGroup || strategy.market_group;
  const symbols = safeArray(input.symbols).length ? safeArray(input.symbols) : defaultSymbols(marketGroup);
  const timeframe = String(input.timeframe || strategy.default_timeframes[0] || '2m');
  const sl = clamp(input.sl ?? input.stop_loss ?? strategy.default_sl, 0.05, 5);
  const tp = clamp(input.tp ?? input.take_profit ?? strategy.default_tp, 0.2, 10);
  const holdingTime = Math.max(1, Math.round(Number(input.holding_time ?? strategy.default_holding_time) || strategy.default_holding_time));
  const timeout = Math.max(1, Math.round(Number(input.timeout ?? holdingTime) || holdingTime));
  const confidence = clamp(input.confidence_threshold ?? 65, 0, 100);
  const volume = clamp(input.volume_requirement ?? 1.2, 0.1, 10);

  const seed = `${strategy.id}|${symbols.join(',')}|${timeframe}|${sl}|${tp}|${holdingTime}|${timeout}|${confidence}|${volume}`;
  const hash = crypto.createHash('sha256').update(seed).digest();
  const rand = (idx) => hash[idx] / 255;
  const trades = Math.max(6, Math.round((symbols.length * 4) + rand(0) * 18));
  const baseEdge = 43
    + (strategy.active ? 3 : -4)
    + (volume >= 1.5 ? 4 : 0)
    + (confidence >= 70 ? 3 : confidence < 50 ? -4 : 0)
    + (tp >= 1.4 && tp <= 2.1 ? 3 : -2)
    + (holdingTime <= 12 ? 2 : holdingTime > 30 ? -3 : 0)
    + ((rand(1) - 0.5) * 18);
  const winRatePct = clamp(baseEdge, 18, 76);
  const wins = Math.round(trades * winRatePct / 100);
  const timeouts = Math.round(trades * clamp((timeout < holdingTime ? 0.18 : 0.08) + rand(2) * 0.18, 0.02, 0.35));
  const losses = Math.max(0, trades - wins - timeouts);
  const pnls = [];
  for (let i = 0; i < trades; i += 1) {
    if (i < wins) pnls.push(round(sl * tp * (0.65 + rand((i % 16) + 3) * 0.7), 4));
    else if (i < wins + losses) pnls.push(round(-sl * (0.75 + rand((i % 16) + 3) * 0.45), 4));
    else pnls.push(round((rand((i % 16) + 3) - 0.55) * sl * 0.35, 4));
  }
  const totalPnl = round(pnls.reduce((sum, v) => sum + v, 0), 4);
  const symbolPnls = symbols.map((symbol, idx) => ({
    symbol,
    pnl: round(totalPnl / symbols.length + (rand((idx % 16) + 4) - 0.5) * sl * 2, 4),
  }));
  const best = [...symbolPnls].sort((a, b) => b.pnl - a.pnl)[0];
  const worst = [...symbolPnls].sort((a, b) => a.pnl - b.pnl)[0];

  return normalizeResult({
    strategy_id: strategy.id,
    market_group: marketGroup,
    symbols,
    underlying_symbol: input.underlying_symbol || input.underlyingSymbol || input.signal_symbol || input.signalSymbol || symbols[0],
    underlying_market: input.underlying_market || input.underlyingMarket || marketGroup,
    underlying_signal_direction: input.underlying_signal_direction || input.underlyingSignalDirection || input.direction || strategy.direction,
    underlying_signal_strength: input.underlying_signal_strength ?? input.underlyingSignalStrength ?? input.confidence ?? confidence,
    traded_symbol: input.traded_symbol || input.tradedSymbol || input.symbol || symbols[0],
    traded_instrument_type: input.traded_instrument_type || input.tradedInstrumentType || input.instrument_type || input.instrumentType || null,
    risk_class: input.risk_class || input.riskClass || null,
    leverage_factor: input.leverage_factor ?? input.leverageFactor ?? input.leverage ?? null,
    spread_estimate: input.spread_estimate ?? input.spreadEstimate ?? input.spread_percent ?? input.spreadPct ?? null,
    tracking_quality: input.tracking_quality || input.trackingQuality || null,
    timeframe,
    sl,
    tp,
    holding_time: holdingTime,
    timeout,
    confidence_threshold: confidence,
    volume_requirement: volume,
    cooldown: input.cooldown,
    max_trades_per_day: input.max_trades_per_day,
    trades,
    wins,
    losses,
    timeouts,
    total_pnl: totalPnl,
    max_drawdown: maxDrawdownFromPnls(pnls),
    best_symbol: best?.symbol || symbols[0],
    worst_symbol: worst?.symbol || symbols[symbols.length - 1],
  });
}

function defaultSymbols(marketGroup) {
  if (marketGroup === 'crypto') return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  if (marketGroup === 'index') return ['QQQ', 'SPY', 'IWM'];
  if (marketGroup === 'etf') return ['TQQQ', 'SQQQ', 'SOXL'];
  return ['AAPL', 'NVDA', 'TSLA', 'QQQ'];
}

function saveStrategyTestResult(input = {}) {
  const result = normalizeResult(input);
  const results = readResults();
  results.push(result);
  writeResults(results.slice(-1000));
  auditTrail.logAuditEvent({
    type: 'STRATEGY_TEST_CREATED',
    source: 'strategy_tests',
    symbol: result.symbols?.[0] || null,
    strategy_id: result.strategy_id,
    timestamp: result.test_created_at,
    message: `${result.strategy_name} test skapad`,
    details: { test_id: result.id, symbols: result.symbols, mode: result.mode },
  });
  auditTrail.logAuditEvent({
    type: 'STRATEGY_TEST_COMPLETED',
    source: 'strategy_tests',
    symbol: result.symbols?.[0] || null,
    strategy_id: result.strategy_id,
    timestamp: result.test_completed_at,
    message: `${result.strategy_name} testad${result.best_symbol ? ` på ${result.best_symbol}` : ''}`,
    details: {
      test_id: result.id,
      symbols: result.symbols,
      trades: result.trades,
      win_rate: result.win_rate,
      avg_pnl: result.avg_pnl,
      duration_seconds: result.duration_seconds,
      duration_label: result.duration_label,
    },
  });
  return { ok: true, result, ...SAFETY };
}

function saveSimulatedStrategyTest(input = {}) {
  const result = deterministicTestResult(input);
  return saveStrategyTestResult(result);
}

function aggregate(results) {
  const byId = new Map();
  for (const row of results) {
    const id = row.strategy_id;
    if (!byId.has(id)) {
      byId.set(id, {
        strategy_id: id,
        strategy_name: row.strategy_name,
        market_group: row.market_group,
        runs: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        timeouts: 0,
        total_pnl: 0,
        max_drawdown: 0,
        markets: {},
        params: {},
        symbols: {},
        latest_result: null,
      });
    }
    const agg = byId.get(id);
    agg.runs += 1;
    agg.trades += row.trades || 0;
    agg.wins += row.wins || 0;
    agg.losses += row.losses || 0;
    agg.timeouts += row.timeouts || 0;
    agg.total_pnl += row.total_pnl || 0;
    agg.max_drawdown = Math.max(agg.max_drawdown, row.max_drawdown || 0);
    agg.latest_result = !agg.latest_result || String(row.created_at) > String(agg.latest_result.created_at) ? row : agg.latest_result;
    const mk = row.market_group || 'all';
    agg.markets[mk] = agg.markets[mk] || { market_group: mk, trades: 0, wins: 0, total_pnl: 0 };
    agg.markets[mk].trades += row.trades || 0;
    agg.markets[mk].wins += row.wins || 0;
    agg.markets[mk].total_pnl += row.total_pnl || 0;
    const pkey = `SL ${row.sl}% / TP ${row.tp}R / ${row.holding_time}m`;
    agg.params[pkey] = agg.params[pkey] || { label: pkey, trades: 0, wins: 0, total_pnl: 0, sl: row.sl, tp: row.tp, holding_time: row.holding_time };
    agg.params[pkey].trades += row.trades || 0;
    agg.params[pkey].wins += row.wins || 0;
    agg.params[pkey].total_pnl += row.total_pnl || 0;
    for (const sym of row.symbols || []) {
      agg.symbols[sym] = agg.symbols[sym] || { symbol: sym, runs: 0, total_pnl: 0 };
      agg.symbols[sym].runs += 1;
    }
    if (row.best_symbol) {
      agg.symbols[row.best_symbol] = agg.symbols[row.best_symbol] || { symbol: row.best_symbol, runs: 0, total_pnl: 0 };
      agg.symbols[row.best_symbol].total_pnl += Math.abs(row.avg_pnl || 0);
    }
    if (row.worst_symbol) {
      agg.symbols[row.worst_symbol] = agg.symbols[row.worst_symbol] || { symbol: row.worst_symbol, runs: 0, total_pnl: 0 };
      agg.symbols[row.worst_symbol].total_pnl -= Math.abs(row.avg_pnl || 0);
    }
  }

  return [...byId.values()].map((row) => {
    const winRate = row.trades ? round((row.wins / row.trades) * 100, 2) : 0;
    const avgPnl = row.trades ? round(row.total_pnl / row.trades, 4) : 0;
    const markets = Object.values(row.markets).map((m) => ({
      ...m,
      win_rate: m.trades ? round((m.wins / m.trades) * 100, 2) : 0,
      avg_pnl: m.trades ? round(m.total_pnl / m.trades, 4) : 0,
    })).sort((a, b) => b.avg_pnl - a.avg_pnl);
    const params = Object.values(row.params).map((p) => ({
      ...p,
      win_rate: p.trades ? round((p.wins / p.trades) * 100, 2) : 0,
      avg_pnl: p.trades ? round(p.total_pnl / p.trades, 4) : 0,
    })).sort((a, b) => b.avg_pnl - a.avg_pnl);
    const symbols = Object.values(row.symbols).sort((a, b) => b.total_pnl - a.total_pnl);
    return {
      ...row,
      total_pnl: round(row.total_pnl, 4),
      win_rate: winRate,
      avg_pnl: avgPnl,
      score: scoreStrategy({ ...row, win_rate: winRate, avg_pnl: avgPnl }),
      needs_more_data: row.trades < 30 || row.runs < 3,
      performance_badge: badgeFor(winRate, row.trades, avgPnl),
      best_market: markets[0] || null,
      best_params: params[0] || null,
      best_symbol: symbols[0]?.symbol || null,
      worst_symbol: symbols[symbols.length - 1]?.symbol || null,
      markets,
      params,
      symbols,
    };
  }).sort((a, b) => b.score - a.score);
}

function scoreStrategy(row) {
  const sample = Math.min(20, (row.trades || 0) * 0.4);
  const wr = Math.max(0, Math.min(45, (row.win_rate || 0) * 0.45));
  const pnl = Math.max(-20, Math.min(25, (row.avg_pnl || 0) * 180));
  const dd = Math.max(-15, -Math.abs(row.max_drawdown || 0) * 12);
  return Math.round(Math.max(0, Math.min(100, sample + wr + pnl + dd + 25)));
}

function badgeFor(winRate, trades, avgPnl) {
  if (!trades || trades < 10) return { label: 'Behöver mer data', tone: 'neutral' };
  if (winRate >= 55 && avgPnl >= 0) return { label: 'Fungerar bra historiskt', tone: 'good' };
  if (winRate < 40 || avgPnl < 0) return { label: 'Fungerar dåligt historiskt', tone: 'bad' };
  return { label: 'Blandad historik', tone: 'mixed' };
}

function getStrategyPerformance() {
  const results = readResults();
  const strategies = aggregate(results);
  return {
    ok: true,
    generated_at: nowIso(),
    count: strategies.length,
    results_count: results.length,
    strategies,
    needs_more_data: strategies.filter((s) => s.needs_more_data),
    ...SAFETY,
  };
}

function getTopStrategies(limit = 5) {
  const strategies = getStrategyPerformance().strategies
    .filter((s) => s.trades > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { ok: true, strategies, count: strategies.length, ...SAFETY };
}

function getWorstStrategies(limit = 5) {
  const strategies = getStrategyPerformance().strategies
    .filter((s) => s.trades > 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
  return { ok: true, strategies, count: strategies.length, ...SAFETY };
}

function compareStrategies(ids = []) {
  const selectedIds = safeArray(ids);
  const all = getStrategyPerformance().strategies;
  const strategies = selectedIds.length ? all.filter((s) => selectedIds.includes(s.strategy_id)) : all.slice(0, 6);
  return {
    ok: true,
    strategies,
    winner: strategies.length ? [...strategies].sort((a, b) => b.score - a.score)[0] : null,
    compared_count: strategies.length,
    ...SAFETY,
  };
}

function getStrategyDetails(strategyId) {
  const strategy = strategyCatalog.getStrategyById(strategyId);
  if (!strategy) return { ok: false, error: 'unknown_strategy_id', ...SAFETY };
  const results = readResults().filter((r) => r.strategy_id === strategy.id);
  const performance = aggregate(results)[0] || null;
  return {
    ok: true,
    strategy,
    performance,
    results,
    result_count: results.length,
    ...SAFETY,
  };
}

function resetStrategyResults(strategyId) {
  const before = readResults();
  const after = before.filter((r) => r.strategy_id !== strategyId);
  writeResults(after);
  return { ok: true, removed: before.length - after.length, strategy_id: strategyId, ...SAFETY };
}

function getSignalPerformanceBadge(strategyId) {
  const perf = getStrategyDetails(strategyId).performance;
  if (!perf) {
    return {
      strategy_id: strategyId,
      win_rate: null,
      trades: 0,
      score: 50,
      badge: { label: 'Behöver mer data', tone: 'neutral' },
      priority_adjustment: 0,
      message: 'Denna strategi behöver mer data.',
    };
  }
  const adjustment = perf.performance_badge.tone === 'good' ? 8 : perf.performance_badge.tone === 'bad' ? -10 : 0;
  return {
    strategy_id: strategyId,
    win_rate: perf.win_rate,
    trades: perf.trades,
    score: perf.score,
    badge: perf.performance_badge,
    priority_adjustment: adjustment,
    message: perf.performance_badge.tone === 'good'
      ? 'Denna strategi fungerar bra historiskt.'
      : perf.performance_badge.tone === 'bad'
        ? 'Denna strategi fungerar dåligt historiskt.'
        : 'Denna strategi har blandad eller begränsad historik.',
  };
}

module.exports = {
  SAFETY,
  saveStrategyTestResult,
  saveSimulatedStrategyTest,
  getStrategyPerformance,
  getTopStrategies,
  getWorstStrategies,
  compareStrategies,
  getStrategyDetails,
  resetStrategyResults,
  getSignalPerformanceBadge,
};
