'use strict';

const fs = require('fs');
const path = require('path');
const strategyCatalog = require('./daytradingStrategyCatalogService');

const SAFETY = strategyCatalog.SAFETY;
const DATA_DIR = path.resolve(__dirname, '../../data/daytrading-strategies');
const RESULTS_FILE = path.join(DATA_DIR, 'results-v1.json');

function nowIso() { return new Date().toISOString(); }
function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function safeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
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
  readResults,
  getStrategyPerformance,
  getTopStrategies,
  getWorstStrategies,
  compareStrategies,
  getStrategyDetails,
  getSignalPerformanceBadge,
};
