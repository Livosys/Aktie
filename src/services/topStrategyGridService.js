'use strict';

const fs = require('fs');
const path = require('path');
const strategyBatchTest = require('./strategyBatchTestService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  paper_only: true,
  replay_mode: true,
  source: 'batch_test',
  live: false,
});

const DATA_DIR = path.resolve(__dirname, '../../data/strategy-batches');
const BATCHES_FILE = path.join(DATA_DIR, 'batches-v1.json');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const SUMMARY_FILE = path.join(DATA_DIR, 'top-strategy-grid-v1-summary.json');
const RUN_PREFIX = 'Top Strategy Parameter Grid v1';

const TARGET_STRATEGIES = Object.freeze([
  'narrow_state_expansion_long',
  'vwap_failed_breakout_short',
  'index_supported_momentum_long',
  'vwap_volume_breakout_long',
]);

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function resultLabel(score) {
  if (score >= 80) return 'Stark kandidat';
  if (score >= 60) return 'Lovande kandidat';
  if (score >= 40) return 'Svag till okej';
  return 'Svag kandidat';
}

function warningsFor(row) {
  const warnings = [];
  if ((row.trades_count || 0) < 25) warnings.push('För lite data för säker slutsats.');
  if ((row.timeout_rate || 0) >= 25) warnings.push('Hög timeout-rate.');
  if ((row.max_drawdown || 0) >= 1) warnings.push('Hög max drawdown.');
  if ((row.avg_pnl || 0) < 0) warnings.push('Negativ snitt-P/L.');
  return warnings;
}

function conclusionFor(row) {
  if ((row.trades_count || 0) < 25) {
    return `${row.strategy_id} har för lite data för säker slutsats på ${row.symbol} ${row.timeframe}.`;
  }
  if (row.score >= 60) {
    return `${row.strategy_id} fungerar bäst på ${row.timeframe} med stop loss ${row.stop_loss_pct}%, take profit ${row.take_profit_r}R och holding time ${row.holding_time_min} minuter. Resultatet är lovande men bör testas på fler dagar.`;
  }
  return `${row.strategy_id} visar blandade resultat. Den bör inte prioriteras förrän mer data finns.`;
}

function optimizationScore(row) {
  const trades = Number(row.trades_count) || 0;
  const winRate = Number(row.win_rate) || 0;
  const avgPnl = Number(row.avg_pnl) || 0;
  const timeoutRate = Number(row.timeout_rate) || 0;
  const drawdown = Math.abs(Number(row.max_drawdown) || 0);
  const rr = Number(row.take_profit_r) || 0;
  let score = 0;
  score += Math.min(32, winRate * 0.32);
  score += Math.max(-12, Math.min(24, avgPnl * 180));
  score += Math.min(14, trades * 0.35);
  score += Math.max(0, 14 - timeoutRate * 0.35);
  score += Math.max(0, 10 - drawdown * 8);
  score += Math.max(0, Math.min(6, rr * 3));
  if (trades < 10) score = Math.min(score, 39);
  else if (trades < 25) score = Math.min(score, 59);
  return Math.round(Math.max(0, Math.min(100, score)));
}

function normalizeRow(batch, result) {
  const trades = Number(result.trades) || 0;
  const timeoutRate = trades ? round(((Number(result.timeouts) || 0) / trades) * 100, 2) : 0;
  const row = {
    batch_id: result.batch_id || batch.id,
    batch_name: batch.name,
    run_type: batch.metadata?.run_type || (String(batch.name).includes('symbol_timeframe') ? 'symbol_timeframe' : 'parameter_grid'),
    strategy_id: result.strategy_id,
    strategy_name: result.strategy_name,
    symbol: result.symbol,
    market: result.market_group,
    timeframe: result.timeframe,
    stop_loss_pct: result.stop_loss,
    take_profit_r: result.take_profit,
    holding_time_min: result.holding_time,
    timeout_min: result.timeout,
    confidence: result.confidence_threshold,
    volume_requirement: result.volume_requirement,
    trades_count: trades,
    win_rate: round(result.win_rate, 2),
    avg_pnl: round(result.avg_pnl, 4),
    total_pnl: round(result.total_pnl, 4),
    timeout_rate: timeoutRate,
    max_drawdown: round(result.max_drawdown, 4),
    raw_score: result.score || 0,
    source: result.source || 'batch_test',
    mode: result.mode || 'paper_replay',
    live: result.live === true ? true : false,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
  };
  row.score = optimizationScore(row);
  row.result_label_sv = resultLabel(row.score);
  row.warnings_sv = warningsFor(row);
  row.conclusion_sv = conclusionFor(row);
  return row;
}

function loadGridBatches() {
  return readJson(BATCHES_FILE, [])
    .filter((batch) => String(batch.name || '').startsWith(RUN_PREFIX))
    .filter((batch) => TARGET_STRATEGIES.includes(batch.config?.strategy_ids?.[0] || batch.strategy_id))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

function loadRows() {
  const batches = loadGridBatches();
  const rows = [];
  for (const batch of batches) {
    const resultFile = path.join(RESULTS_DIR, `${batch.id}.json`);
    const results = readJson(resultFile, []);
    for (const result of results) rows.push(normalizeRow(batch, result));
  }
  return { batches, rows };
}

function bestBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key] ?? 'unknown';
    const prev = groups.get(value);
    if (!prev || row.score > prev.score) groups.set(value, row);
  }
  return [...groups.values()].sort((a, b) => b.score - a.score);
}

function aggregate(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key] ?? 'unknown';
    if (!groups.has(value)) groups.set(value, { key: value, runs: 0, trades_count: 0, wins: 0, total_pnl: 0, score_sum: 0 });
    const g = groups.get(value);
    g.runs += 1;
    g.trades_count += row.trades_count || 0;
    g.wins += Math.round((row.trades_count || 0) * (row.win_rate || 0) / 100);
    g.total_pnl += row.total_pnl || 0;
    g.score_sum += row.score || 0;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    win_rate: g.trades_count ? round((g.wins / g.trades_count) * 100, 2) : 0,
    avg_pnl: g.trades_count ? round(g.total_pnl / g.trades_count, 4) : 0,
    avg_score: g.runs ? round(g.score_sum / g.runs, 2) : 0,
  })).sort((a, b) => b.avg_score - a.avg_score);
}

function strategySummary(strategyId, rows) {
  const strategyRows = rows.filter((row) => row.strategy_id === strategyId);
  const best = [...strategyRows].sort((a, b) => b.score - a.score)[0] || null;
  const worst = [...strategyRows].sort((a, b) => a.score - b.score)[0] || null;
  const bestSymbols = bestBy(strategyRows, 'symbol');
  const bestTimeframes = aggregate(strategyRows, 'timeframe');
  const bestStopLoss = aggregate(strategyRows, 'stop_loss_pct')[0] || null;
  const bestTakeProfit = aggregate(strategyRows, 'take_profit_r')[0] || null;
  const bestHoldingTime = aggregate(strategyRows, 'holding_time_min')[0] || null;
  const needsMoreData = strategyRows.filter((row) => row.trades_count < 25);
  const conclusion = best
    ? best.conclusion_sv
    : `${strategyId} saknar grid-resultat.`;
  return {
    strategy_id: strategyId,
    strategy_name: best?.strategy_name || strategyId,
    runs: strategyRows.length,
    best,
    worst,
    best_symbol: bestSymbols[0]?.symbol || null,
    best_timeframe: bestTimeframes[0]?.key || null,
    best_stop_loss: bestStopLoss,
    best_take_profit: bestTakeProfit,
    best_holding_time: bestHoldingTime,
    needs_more_data_count: needsMoreData.length,
    conclusion_sv: conclusion,
  };
}

function buildRecommendations(summary) {
  const recommendations = [];
  const best = summary.best_overall?.[0] || null;
  if (best) {
    recommendations.push(`Prioritera ${best.strategy_name} på ${best.symbol} ${best.timeframe}: SL ${best.stop_loss_pct}%, TP ${best.take_profit_r}R, holding ${best.holding_time_min} min, confidence ${best.confidence}.`);
  }
  for (const row of summary.best_per_strategy || []) {
    if (row.best?.score >= 60) {
      recommendations.push(`${row.strategy_name}: testa vidare med ${row.best.timeframe}, SL ${row.best.stop_loss_pct}%, TP ${row.best.take_profit_r}R och volymkrav ${row.best.volume_requirement}.`);
    } else {
      recommendations.push(`${row.strategy_name}: blandat resultat, prioritera inte förrän fler dagar har testats.`);
    }
  }
  const weak = summary.weak_combinations || [];
  if (weak.length) recommendations.push(`Undvik lägsta gridkombinationerna tills mer data finns: ${weak.slice(0, 3).map((r) => `${r.strategy_name} ${r.symbol} ${r.timeframe}`).join(', ')}.`);
  return recommendations;
}

function buildSummary({ persist = false } = {}) {
  const { batches, rows } = loadRows();
  const completedBatches = batches.filter((b) => b.status === 'completed');
  const bestOverall = [...rows].sort((a, b) => b.score - a.score).slice(0, 20);
  const weak = [...rows].sort((a, b) => a.score - b.score).slice(0, 20);
  const bestPerStrategy = TARGET_STRATEGIES.map((id) => strategySummary(id, rows));
  const summary = {
    ok: true,
    generated_at: new Date().toISOString(),
    run_prefix: RUN_PREFIX,
    target_strategies: [...TARGET_STRATEGIES],
    batch_count: batches.length,
    completed_batch_count: completedBatches.length,
    combination_count: rows.length,
    simulated_trades_count: rows.reduce((sum, row) => sum + (row.trades_count || 0), 0),
    best_overall: bestOverall,
    best_per_strategy: bestPerStrategy,
    weak_combinations: weak,
    by_symbol: aggregate(rows, 'symbol'),
    by_timeframe: aggregate(rows, 'timeframe'),
    by_stop_loss: aggregate(rows, 'stop_loss_pct'),
    by_take_profit: aggregate(rows, 'take_profit_r'),
    by_holding_time: aggregate(rows, 'holding_time_min'),
    by_timeout: aggregate(rows, 'timeout_min'),
    by_confidence: aggregate(rows, 'confidence'),
    by_volume_requirement: aggregate(rows, 'volume_requirement'),
    recommendations: [],
    note_sv: 'Detta är testresultat, inte live trading.',
    ...SAFETY,
  };
  summary.recommendations = buildRecommendations(summary);
  if (persist) writeJson(SUMMARY_FILE, summary);
  return summary;
}

function getSummary() {
  const cached = readJson(SUMMARY_FILE, null);
  if (cached?.ok) return { ...cached, ...SAFETY };
  return buildSummary();
}

module.exports = {
  SAFETY,
  RUN_PREFIX,
  TARGET_STRATEGIES,
  buildSummary,
  getSummary,
};
