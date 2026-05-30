'use strict';

const fs = require('fs');
const path = require('path');

const redisService = require('./redisService');
const replayIntelligenceService = require('./replayIntelligenceService');

const CACHE_KEY = 'exit:calibration';
const RECENT_CACHE_KEY = 'exit:calibration:recent';
const CACHE_TTL_SECONDS = 30 * 60;
const DATA_DIR = path.resolve(__dirname, '../../data/exit-calibration');
const CALIBRATION_FILE = path.join(DATA_DIR, 'calibration.json');
const RECENT_FILE = path.join(DATA_DIR, 'recent.json');
const PAPER_TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const MIN_REASON_SAMPLE = 2;
const MEANINGFUL_DELTA = 0.02;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function pct(part, total) {
  return total ? round((part / total) * 100, 2) : 0;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeResult(result, pnl, reason) {
  const raw = String(result || '').toLowerCase();
  const exit = String(reason || '').toLowerCase();
  if (raw.includes('timeout') || raw === 'tie' || exit.includes('timeout')) return 'timeout';
  if (raw.includes('win')) return 'win';
  if (raw.includes('loss')) return 'loss';
  if (Number.isFinite(pnl)) {
    if (pnl > 0) return 'win';
    if (pnl < 0) return 'loss';
  }
  return 'timeout';
}

function inferVersion(row = {}) {
  const direct = row.version || row.ruleVersion || row.paperRulesVersion || row.rule_version || row.paper_rules_version;
  if (direct) return String(direct).toLowerCase();
  const riskProfile = String(row.riskProfileName || row.risk_profile_name || '');
  const match = riskProfile.match(/(?:^|_)v([123])(?:_|$)/i);
  if (match) return `v${match[1]}`;
  const source = String(row.exitSource || row.exit_source || row.source || '');
  const sourceMatch = source.match(/v([123])/i);
  return sourceMatch ? `v${sourceMatch[1]}` : 'unknown';
}

function inferMarketGroup(row = {}) {
  if (row.marketGroup || row.market_group) return String(row.marketGroup || row.market_group);
  const marketType = String(row.marketType || row.market_type || '').toLowerCase();
  const symbol = String(row.symbol || '').toUpperCase();
  if (symbol.endsWith('USDT') || marketType === 'crypto') return 'CRYPTO';
  if (marketType === 'stocks' || marketType === 'stock') return 'US_STOCKS';
  return 'UNKNOWN';
}

function inferSignalType(row = {}) {
  return String(
    row.signalSubtype ||
    row.signal_subtype ||
    row.signalFamily ||
    row.signal_family ||
    row.engine_signal ||
    row.direction ||
    'unknown'
  );
}

function inferExitReason(row = {}) {
  return String(
    row.exitReasonCode ||
    row.exit_reason_code ||
    row.exitReason ||
    row.exit_reason ||
    'unknown'
  ).toLowerCase();
}

function isExitEnginePaperTrade(row = {}) {
  return row.exitSource === 'exit_engine_v1' ||
    row.exit_source === 'exit_engine_v1' ||
    String(row.exitReason || '').startsWith('EXIT_ENGINE_');
}

function baselineFromReplayEvent(event) {
  const pnl = asNumber(event.baseline_pnl_pct);
  if (pnl == null) return null;
  const reason = String(event.baseline_exit_reason || 'unknown').toLowerCase();
  return {
    source: 'replay_baseline',
    session_id: event.session_id,
    timestamp: event.timestamp,
    symbol: event.symbol || 'UNKNOWN',
    signal_type: inferSignalType(event),
    market_group: inferMarketGroup(event),
    exit_reason_code: reason,
    version: inferVersion(event),
    pnl_pct: pnl,
    result: normalizeResult(event.baseline_outcome, pnl, reason),
    hold_minutes: asNumber(event.baseline_hold_minutes),
  };
}

function actualFromReplayEvent(event) {
  const pnl = asNumber(event.simulated_pnl_pct);
  if (pnl == null || event.baseline_pnl_pct == null) return null;
  const reason = inferExitReason(event);
  const baselinePnl = asNumber(event.baseline_pnl_pct);
  const delta = baselinePnl == null ? 0 : pnl - baselinePnl;
  return {
    source: 'replay_exit_engine',
    session_id: event.session_id,
    timestamp: event.timestamp,
    symbol: event.symbol || 'UNKNOWN',
    signal_type: inferSignalType(event),
    market_group: inferMarketGroup(event),
    exit_reason_code: reason,
    version: inferVersion(event),
    pnl_pct: pnl,
    baseline_pnl_pct: baselinePnl,
    pnl_delta_pct: round(delta),
    result: normalizeResult(event.outcome, pnl, reason),
    baseline_result: normalizeResult(event.baseline_outcome, baselinePnl, event.baseline_exit_reason),
    hold_minutes: asNumber(event.hold_minutes),
    baseline_hold_minutes: asNumber(event.baseline_hold_minutes),
    action: event.exit_engine_action || null,
    reason: event.exit_engine_reason || event.reason || null,
    exit_engine_enabled: event.exit_engine_enabled === true,
  };
}

function rowFromPaperTrade(trade) {
  const pnl = asNumber(trade.pnlPct ?? trade.pnl_pct);
  if (pnl == null) return null;
  const reason = inferExitReason(trade);
  const isEngine = isExitEnginePaperTrade(trade);
  return {
    source: isEngine ? 'paper_exit_engine' : 'paper_legacy',
    trade_id: trade.tradeId || trade.trade_id || null,
    timestamp: trade.exitTime || trade.exit_time || trade.entryTime || trade.entry_time || null,
    symbol: trade.symbol || 'UNKNOWN',
    signal_type: inferSignalType(trade),
    market_group: inferMarketGroup(trade),
    exit_reason_code: reason,
    version: inferVersion(trade),
    pnl_pct: pnl,
    result: normalizeResult(trade.result, pnl, reason),
    hold_minutes: asNumber(trade.holdMinutes ?? trade.hold_minutes),
    max_favorable_pct: asNumber(trade.maxFavorablePct ?? trade.max_favorable_pct),
    max_adverse_pct: asNumber(trade.maxAdversePct ?? trade.max_adverse_pct),
    target_pct: asNumber(trade.targetPct ?? trade.target_pct),
    stop_pct: asNumber(trade.stopPct ?? trade.stop_pct),
    exit_engine_enabled: isEngine,
  };
}

function summarizeRows(rows) {
  const wins = rows.filter((row) => row.result === 'win').length;
  const losses = rows.filter((row) => row.result === 'loss').length;
  const timeouts = rows.filter((row) => row.result === 'timeout' || String(row.exit_reason_code).includes('timeout')).length;
  const totalPnl = rows.reduce((sum, row) => sum + (Number(row.pnl_pct) || 0), 0);
  return {
    trades: rows.length,
    wins,
    losses,
    timeouts,
    timeout_rate: pct(timeouts, rows.length),
    avg_pl_pct: rows.length ? round(totalPnl / rows.length) : 0,
    total_pl_pct: round(totalPnl),
  };
}

function addGroupRow(map, key, row, paired = false) {
  const groupKey = key || 'unknown';
  if (!map[groupKey]) {
    map[groupKey] = {
      key: groupKey,
      trades: 0,
      wins: 0,
      losses: 0,
      timeouts: 0,
      total_pl_pct: 0,
      baseline_total_pl_pct: 0,
      delta_total_pct: 0,
      improved_exits: 0,
      worsened_exits: 0,
      saved_winners: 0,
      early_exits: 0,
      missed_bigger_winners: 0,
      near_target_pullbacks_saved: 0,
    };
  }
  const g = map[groupKey];
  const pnl = Number(row.pnl_pct) || 0;
  const baseline = Number(row.baseline_pnl_pct);
  const delta = Number(row.pnl_delta_pct);
  g.trades += 1;
  g.total_pl_pct += pnl;
  if (row.result === 'win') g.wins += 1;
  if (row.result === 'loss') g.losses += 1;
  if (row.result === 'timeout' || String(row.exit_reason_code).includes('timeout')) g.timeouts += 1;
  if (paired && Number.isFinite(baseline)) {
    g.baseline_total_pl_pct += baseline;
    g.delta_total_pct += Number.isFinite(delta) ? delta : pnl - baseline;
    if (pnl > baseline + MEANINGFUL_DELTA) g.improved_exits += 1;
    if (baseline > pnl + MEANINGFUL_DELTA) g.worsened_exits += 1;
    if (row.baseline_result !== 'win' && row.result === 'win') g.saved_winners += 1;
    if (isEarlyExit(row)) g.early_exits += 1;
    if (isMissedBiggerWinner(row)) g.missed_bigger_winners += 1;
    if (row.exit_reason_code === 'near_target_pullback' && pnl > baseline + MEANINGFUL_DELTA) g.near_target_pullbacks_saved += 1;
  }
}

function finalizeGroupMap(map) {
  return Object.values(map)
    .map((g) => ({
      ...g,
      total_pl_pct: round(g.total_pl_pct),
      baseline_total_pl_pct: round(g.baseline_total_pl_pct),
      avg_pl_pct: g.trades ? round(g.total_pl_pct / g.trades) : 0,
      baseline_avg_pl_pct: g.trades ? round(g.baseline_total_pl_pct / g.trades) : 0,
      avg_pl_change_pct: g.trades ? round(g.delta_total_pct / g.trades) : 0,
      timeout_rate: pct(g.timeouts, g.trades),
      win_rate: pct(g.wins, g.trades),
    }))
    .sort((a, b) => b.trades - a.trades || b.avg_pl_change_pct - a.avg_pl_change_pct);
}

function buildGroups(rows, paired = false) {
  const bySymbol = {};
  const bySignalType = {};
  const byMarketGroup = {};
  const byExitReasonCode = {};
  const byVersion = {};
  for (const row of rows) {
    addGroupRow(bySymbol, row.symbol, row, paired);
    addGroupRow(bySignalType, row.signal_type, row, paired);
    addGroupRow(byMarketGroup, row.market_group, row, paired);
    addGroupRow(byExitReasonCode, row.exit_reason_code, row, paired);
    addGroupRow(byVersion, row.version, row, paired);
  }
  return {
    by_symbol: finalizeGroupMap(bySymbol),
    by_signal_type: finalizeGroupMap(bySignalType),
    by_market_group: finalizeGroupMap(byMarketGroup),
    by_exit_reason_code: finalizeGroupMap(byExitReasonCode),
    by_version: finalizeGroupMap(byVersion),
  };
}

function isEarlyExit(row) {
  const reason = String(row.exit_reason_code || '');
  const baseline = Number(row.baseline_pnl_pct);
  const pnl = Number(row.pnl_pct);
  if (!Number.isFinite(baseline) || !Number.isFinite(pnl)) return false;
  return ['near_target_profit', 'near_target_pullback', 'trailing_stop', 'break_even', 'momentum_fade', 'tightened_stop'].includes(reason) &&
    pnl > 0 &&
    baseline > pnl + MEANINGFUL_DELTA;
}

function isMissedBiggerWinner(row) {
  const baseline = Number(row.baseline_pnl_pct);
  const pnl = Number(row.pnl_pct);
  if (!Number.isFinite(baseline) || !Number.isFinite(pnl)) return false;
  return baseline > pnl + MEANINGFUL_DELTA;
}

function buildRecommendations({ groups, pairedRows, liveAfter }) {
  const recs = [];
  const add = (message, impact, basis, severity = 'info') => {
    if (message && !recs.some((r) => r.message === message)) {
      recs.push({ message, impact: round(impact), basis, severity });
    }
  };

  for (const row of groups.by_symbol) {
    if (row.trades < MIN_REASON_SAMPLE) continue;
    if (row.avg_pl_change_pct > MEANINGFUL_DELTA) {
      const bestReason = groups.by_exit_reason_code.find((r) => r.trades >= MIN_REASON_SAMPLE && r.avg_pl_change_pct > 0);
      add(`${bestReason?.key || 'exit_engine'} förbättrar ${row.key}`, row.avg_pl_change_pct, `${row.trades} replay-jämförelser`);
    }
  }

  for (const reason of groups.by_exit_reason_code) {
    if (reason.trades < MIN_REASON_SAMPLE) continue;
    if (reason.avg_pl_change_pct > MEANINGFUL_DELTA) {
      const symbol = topSymbolForReason(pairedRows, reason.key);
      add(`${reason.key} förbättrar ${symbol}`, reason.avg_pl_change_pct, `${reason.trades} exits`);
    }
    if (reason.avg_pl_change_pct < -MEANINGFUL_DELTA && reason.early_exits > 0) {
      add(`${reason.key} tar vinst för tidigt`, reason.avg_pl_change_pct, `${reason.early_exits} tidiga exits`, 'warning');
    }
    if (reason.key === 'near_target_profit' && (reason.avg_pl_change_pct < -MEANINGFUL_DELTA || reason.missed_bigger_winners > 0)) {
      const symbol = topSymbolForReason(pairedRows, 'near_target_profit');
      add(`near_target_profit tar vinst för tidigt på ${symbol}`, reason.avg_pl_change_pct, `${reason.missed_bigger_winners} missade större vinnare`, 'warning');
    }
    if (reason.key === 'trailing_stop' && (reason.avg_pl_change_pct < -MEANINGFUL_DELTA || reason.missed_bigger_winners > reason.improved_exits)) {
      add('trailing_stop behöver större avstånd', reason.avg_pl_change_pct, `${reason.trades} exits, ${reason.missed_bigger_winners} missade större vinnare`, 'warning');
    }
    if (['break_even', 'tightened_stop'].includes(reason.key) && (reason.avg_pl_change_pct < -MEANINGFUL_DELTA || reason.missed_bigger_winners > reason.improved_exits)) {
      add('break_even tajtar stop för ofta', reason.avg_pl_change_pct, `${reason.trades} exits`, 'warning');
    }
    if (reason.key === 'timeout_intelligence' && reason.avg_pl_change_pct > MEANINGFUL_DELTA) {
      const symbol = topSymbolForReason(pairedRows, 'timeout_intelligence');
      add(`timeout_intelligence förbättrar ${symbol}`, reason.avg_pl_change_pct, `${reason.trades} exits`);
    }
  }

  for (const market of groups.by_market_group) {
    if (market.trades >= MIN_REASON_SAMPLE && /mixed/i.test(market.key) && market.timeouts > market.wins) {
      add('target bör sänkas i MIXED market', market.avg_pl_change_pct, `${market.timeouts} timeouts i ${market.key}`, 'warning');
    }
  }

  const liveMissed = liveAfter.filter((row) => Number(row.max_favorable_pct) > Number(row.pnl_pct) + MEANINGFUL_DELTA);
  if (liveMissed.length >= 3) {
    add('live exits lämnar ofta vinst på bordet', -round(liveMissed.length / Math.max(1, liveAfter.length), 4), `${liveMissed.length} paper trades med högre MFE`, 'warning');
  }

  if (!recs.length) {
    add('Behåll Exit Engine v1 men samla fler exits före parameterändring', 0, 'För få tydliga negativa kluster ännu');
  }
  return recs.slice(0, 10);
}

function topSymbolForReason(rows, reason) {
  const counts = {};
  for (const row of rows) {
    if (row.exit_reason_code !== reason) continue;
    counts[row.symbol] = (counts[row.symbol] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'UNKNOWN';
}

function pickBestWorstReason(groups) {
  const eligible = groups.by_exit_reason_code.filter((row) => row.trades >= MIN_REASON_SAMPLE);
  const sorted = [...eligible].sort((a, b) => b.avg_pl_change_pct - a.avg_pl_change_pct);
  return {
    best_exit_reason: sorted[0] || null,
    worst_exit_reason: sorted[sorted.length - 1] || null,
  };
}

function loadReplayEvents() {
  const sessions = replayIntelligenceService.listReplaySessions();
  const events = [];
  for (const session of sessions) {
    for (const event of replayIntelligenceService.getReplayEvents(session.id)) {
      events.push(event);
    }
  }
  return { sessions, events };
}

function collectRows() {
  const paperTrades = readJsonl(PAPER_TRADES_FILE).map(rowFromPaperTrade).filter(Boolean);
  const { sessions, events } = loadReplayEvents();
  const pairedEvents = events.filter((event) => event.baseline_pnl_pct != null && event.simulated_pnl_pct != null);
  const baselineRows = pairedEvents.map(baselineFromReplayEvent).filter(Boolean);
  const actualRows = pairedEvents.map(actualFromReplayEvent).filter(Boolean);
  const liveBeforeRows = paperTrades.filter((row) => row.exit_engine_enabled !== true);
  const liveAfterRows = paperTrades.filter((row) => row.exit_engine_enabled === true);
  return {
    sessions,
    events,
    pairedEvents,
    baselineRows,
    actualRows,
    paperTrades,
    liveBeforeRows,
    liveAfterRows,
  };
}

function buildRecent(actualRows, recommendations) {
  const recentExits = [...actualRows]
    .filter((row) => row.exit_engine_enabled === true || row.source === 'replay_exit_engine')
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, 50);
  return {
    ok: true,
    generatedAt: nowIso(),
    count: recentExits.length,
    recent_exits: recentExits,
    recommendations: recommendations.slice(0, 5),
    cache_key: RECENT_CACHE_KEY,
  };
}

async function rebuildCalibration() {
  const {
    sessions,
    events,
    pairedEvents,
    baselineRows,
    actualRows,
    paperTrades,
    liveBeforeRows,
    liveAfterRows,
  } = collectRows();

  const before = summarizeRows(baselineRows);
  const after = summarizeRows(actualRows);
  const liveBefore = summarizeRows(liveBeforeRows);
  const liveAfter = summarizeRows(liveAfterRows);
  const groups = buildGroups(actualRows, true);
  const pairedTotal = actualRows.length;
  const improved = actualRows.filter((row) => Number(row.pnl_pct) > Number(row.baseline_pnl_pct) + MEANINGFUL_DELTA);
  const worsened = actualRows.filter((row) => Number(row.baseline_pnl_pct) > Number(row.pnl_pct) + MEANINGFUL_DELTA);
  const savedWinners = actualRows.filter((row) => row.baseline_result !== 'win' && row.result === 'win');
  const earlyExits = actualRows.filter(isEarlyExit);
  const missedBiggerWinners = actualRows.filter(isMissedBiggerWinner);
  const nearTargetPullbacksSaved = actualRows.filter((row) => row.exit_reason_code === 'near_target_pullback' && Number(row.pnl_delta_pct) > MEANINGFUL_DELTA);
  const nearTargetSaved = actualRows.filter((row) => ['near_target_profit', 'near_target_pullback'].includes(row.exit_reason_code) && Number(row.pnl_delta_pct) > MEANINGFUL_DELTA);
  const bestWorst = pickBestWorstReason(groups);
  const recommendations = buildRecommendations({ groups, pairedRows: actualRows, liveAfter: liveAfterRows });

  const calibration = {
    ok: true,
    generatedAt: nowIso(),
    cache_key: CACHE_KEY,
    recent_cache_key: RECENT_CACHE_KEY,
    source: {
      replay_sessions: sessions.length,
      replay_events: events.length,
      replay_paired_comparisons: pairedEvents.length,
      paper_trades: paperTrades.length,
      paper_before_exit_engine: liveBeforeRows.length,
      paper_after_exit_engine: liveAfterRows.length,
      primary_comparison: 'replay baseline_pnl_pct vs simulated_pnl_pct',
      fallback_comparison: 'paper trades before/after exitSource=exit_engine_v1',
    },
    overall: {
      before,
      after,
      timeout_reduction: Math.max(0, before.timeouts - after.timeouts),
      timeout_reduction_pct: before.timeouts ? round(((before.timeouts - after.timeouts) / before.timeouts) * 100, 2) : 0,
      avg_pl_change_pct: pairedTotal ? round((after.total_pl_pct - before.total_pl_pct) / pairedTotal) : 0,
      wins_before: before.wins,
      losses_before: before.losses,
      timeouts_before: before.timeouts,
      wins_after: after.wins,
      losses_after: after.losses,
      timeouts_after: after.timeouts,
      near_target_pullbacks_saved: nearTargetPullbacksSaved.length,
      saved_winners: savedWinners.length,
      near_target_saved: nearTargetSaved.length,
      early_exits: earlyExits.length,
      missed_bigger_winners: missedBiggerWinners.length,
      exits_improved_pl: improved.length,
      exits_worsened_pl: worsened.length,
      improved_pl_total_pct: round(improved.reduce((sum, row) => sum + Number(row.pnl_delta_pct), 0)),
      worsened_pl_total_pct: round(worsened.reduce((sum, row) => sum + Math.abs(Number(row.pnl_delta_pct)), 0)),
    },
    live_before_after: {
      before: liveBefore,
      after: liveAfter,
      timeout_reduction: Math.max(0, liveBefore.timeouts - liveAfter.timeouts),
      timeout_reduction_pct: liveBefore.timeouts ? round(((liveBefore.timeouts - liveAfter.timeouts) / liveBefore.timeouts) * 100, 2) : 0,
      avg_pl_change_pct: round(liveAfter.avg_pl_pct - liveBefore.avg_pl_pct),
    },
    groups,
    exit_reasons: groups.by_exit_reason_code,
    ...bestWorst,
    recommendations,
    examples: {
      early_exits: earlyExits.slice(0, 20),
      missed_bigger_winners: missedBiggerWinners.slice(0, 20),
      improved_exits: improved.slice(0, 20),
      worsened_exits: worsened.slice(0, 20),
      saved_winners: savedWinners.slice(0, 20),
    },
    storage: {
      redis_keys: [CACHE_KEY, RECENT_CACHE_KEY],
      calibration_file: CALIBRATION_FILE,
      recent_file: RECENT_FILE,
    },
  };

  const recent = buildRecent(actualRows, recommendations);
  writeJson(CALIBRATION_FILE, calibration);
  writeJson(RECENT_FILE, recent);
  await redisService.setJson(CACHE_KEY, calibration, CACHE_TTL_SECONDS);
  await redisService.setJson(RECENT_CACHE_KEY, recent, CACHE_TTL_SECONDS);
  return calibration;
}

async function getCalibration(options = {}) {
  if (!options.force) {
    const cached = await redisService.getJson(CACHE_KEY, null);
    if (cached) return { ...cached, cache: { hit: true, source: 'redis_or_memory' } };
    const disk = readJson(CALIBRATION_FILE, null);
    if (disk) return { ...disk, cache: { hit: true, source: 'disk' } };
  }
  const rebuilt = await rebuildCalibration();
  return { ...rebuilt, cache: { hit: false, source: 'rebuilt' } };
}

async function getRecentCalibration(options = {}) {
  if (!options.force) {
    const cached = await redisService.getJson(RECENT_CACHE_KEY, null);
    if (cached) return { ...cached, cache: { hit: true, source: 'redis_or_memory' } };
    const disk = readJson(RECENT_FILE, null);
    if (disk) return { ...disk, cache: { hit: true, source: 'disk' } };
  }
  const calibration = await getCalibration({ force: options.force });
  const recent = readJson(RECENT_FILE, null) || buildRecent(calibration.examples?.improved_exits || [], calibration.recommendations || []);
  return { ...recent, cache: { hit: false, source: 'rebuilt' } };
}

module.exports = {
  CACHE_KEY,
  RECENT_CACHE_KEY,
  getCalibration,
  getRecentCalibration,
  rebuildCalibration,
};
