'use strict';

// ---------------------------------------------------------------------------
// Milder Exit Replay (read-only, approximation)
// ---------------------------------------------------------------------------
// Purpose:
//   Compare the CURRENT recorded paper-trade exits (exit_engine_v1) against a
//   set of *milder* exit profiles, to understand whether trades are being
//   closed too early.
//
// This module is STRICTLY read-only:
//   - It reads the current paper-trade stats source by default.
//   - It never writes trades, state, config or env.
//   - It never imports order/broker/execution code.
//   - It is pure: running it many times produces the same result, no side
//     effects. Only fs/path are required.
//
// IMPORTANT — this is an APPROXIMATION, not an exact bar-by-bar replay.
//   The local market-data store does NOT contain 2m candles for the trade
//   windows (verified empty), so we cannot reconstruct the true price path.
//   Instead we reconstruct each trade's outcome from fields that ARE recorded:
//       maxFavorablePct (MFE), maxAdversePct (MAE),
//       targetPct, stopPct, pnlPct, exitReasonCode, duration_seconds.
//   Modeling assumption (stated explicitly): for trailing/break-even logic we
//   assume the favorable peak (MFE) occurred before the final retrace
//   ("favorable-arc" assumption). For trades that went adverse-first this is
//   optimistic; such ambiguous trades (MFE>=target AND MAE<=-stop) are counted
//   and a conservative lower-bound total is reported alongside.
//
//   Durations are NOT re-simulated (we have no bars) — duration metrics reflect
//   the RECORDED durations and are shown only as context, never as the result.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const tradeStats = require('./tradeStatsService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  read_only: true,
  replay_mode: true,
  changes_runtime_default: false,
});

const DATA_DIR = path.resolve(__dirname, '../../data');
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trading/trades.jsonl');

// --- Profile definitions -----------------------------------------------------
// breakEvenArmPct      : favorable % required before a trailing/BE stop arms.
//                        Higher than the current engine (~0.12%) = milder.
// trailingGiveBackPct  : how far below the favorable peak the trailing stop
//                        sits once armed. Larger = more room to breathe.
// nearTargetCapture    : fraction of target that counts as a "near target"
//                        take-profit (1.0 = only full target captures).
// allowExtendedHold    : if true, time/other exits that were still favorable
//                        are kept (no early timeout penalty modelled).
const PROFILES = Object.freeze({
  baseline: {
    id: 'baseline',
    kind: 'recorded',
    label: 'baseline (recorded exit_engine_v1)',
    description: 'Faktiskt registrerat utfall från closed trades. Ingen simulering.',
  },
  mild_exit_v1: {
    id: 'mild_exit_v1',
    kind: 'sim',
    label: 'mild_exit_v1',
    description: 'Vänta längre innan tightened/break-even stop, mildare momentum-fade, låt trade gå vidare om MFE positiv.',
    breakEvenArmPct: 0.18,
    trailingGiveBackPct: 0.12,
    nearTargetCapture: 1.0,
    allowExtendedHold: false,
  },
  mild_exit_v2: {
    id: 'mild_exit_v2',
    kind: 'sim',
    label: 'mild_exit_v2',
    description: 'Som v1 men längre max-hold och near-target stänger inte lika tidigt (fångar 85% av target).',
    breakEvenArmPct: 0.20,
    trailingGiveBackPct: 0.15,
    nearTargetCapture: 0.85,
    allowExtendedHold: true,
  },
  entry_filtered_plus_mild_exit: {
    id: 'entry_filtered_plus_mild_exit',
    kind: 'sim_filtered',
    base: 'mild_exit_v1',
    label: 'entry_filtered_plus_mild_exit',
    description: 'mild_exit_v1 men exkluderar caution + REGULAR_PULLBACK (read-only entry-filter / "require 2m confirmation"-proxy).',
  },
});

// --- low-level helpers -------------------------------------------------------
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function median(values) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function avg(values) {
  const a = values.filter((v) => Number.isFinite(v));
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

// --- normalize a recorded trade into the minimal shape we simulate -----------
function normalizeTrade(raw = {}) {
  const subtype = raw.signalSubtype || raw.signal_subtype || raw.strategy || null;
  return {
    tradeId: raw.tradeId || raw.id || null,
    symbol: raw.symbol || null,
    direction: raw.direction || null,
    statusAtEntry: raw.statusAtEntry || null,
    strategy: raw.strategy || null,
    signalFamily: raw.signalFamily || null,
    subtype,
    exitReason: raw.exitReason || null,
    exitReasonCode: raw.exitReasonCode || null,
    exitSource: raw.exitSource || null,
    realizedPnl: num(raw.pnlPct ?? raw.pnl_pct ?? raw.pnl ?? raw.pnlUsd ?? raw.realizedPnl),
    mfe: num(raw.maxFavorablePct ?? raw.mfePct ?? raw.max_favorable_pct),
    mae: num(raw.maxAdversePct ?? raw.maePct ?? raw.max_adverse_pct),
    target: num(raw.targetPct ?? raw.takeProfit ?? raw.take_profit ?? raw.target_pct),
    stop: num(raw.stopPct ?? raw.stopLoss ?? raw.stop_loss ?? raw.stop_pct),
    durationSec: num(raw.duration_seconds),
    exitTime: raw.exitTime || raw.closed_at || null,
  };
}

function loadClosedTrades(file = null) {
  const rows = file ? readJsonl(file) : tradeStats.loadPaperTrades();
  return rows
    .map(normalizeTrade)
    // require the fields the approximation depends on
    .filter((t) => t.realizedPnl !== null && t.mfe !== null && t.mae !== null && t.target !== null && t.stop !== null);
}

// --- classify a RECORDED exit into a coarse bucket (for baseline) ------------
function recordedBucket(t) {
  const code = String(t.exitReasonCode || '').toLowerCase();
  const reason = String(t.exitReason || '').toLowerCase();
  if (/target/.test(code) || /target/.test(reason) || /near_target/.test(code)) return 'target';
  if (/stop_hit/.test(reason) || code === 'stop' || /\bstop\b/.test(reason)) {
    // tightened_stop / break_even are engine BE exits, not raw stops
    if (/tightened|break_even/.test(code)) return 'breakeven';
    return 'stop';
  }
  if (/tightened|break_even/.test(code)) return 'breakeven';
  if (/momentum_fade/.test(code)) return 'trail_profit';
  if (/timeout/.test(code) || /timeout/.test(reason)) return 'time_other';
  return 'time_other';
}

// A trade is "engine-managed early exit" if exit_engine_v1 actively tightened,
// went to break-even, faded momentum, or timed out. These are the ONLY trades a
// milder exit profile would have changed — genuine target hits and raw stop hits
// would happen identically under a milder profile (same hard target/stop), so we
// leave those at their recorded pnl (avoids unfairly capping gap-through winners).
function isEngineManagedEarlyExit(trade) {
  if (trade.exitSource !== 'exit_engine_v1') return false;
  const bucket = recordedBucket(trade);
  return bucket === 'breakeven' || bucket === 'trail_profit' || bucket === 'time_other';
}

// --- core approximation: simulate one trade under one profile ----------------
// Returns { pnl, bucket, ambiguous, repriced }
function simulateTradeUnderProfile(trade, profileId) {
  const prof = PROFILES[profileId];
  if (!prof) throw new Error(`unknown profile: ${profileId}`);

  if (prof.kind === 'recorded') {
    return { pnl: trade.realizedPnl, bucket: recordedBucket(trade), ambiguous: false, repriced: false };
  }

  // Milder profiles only re-price engine-managed early exits; everything else
  // (real target hits, raw stop hits) keeps its recorded outcome.
  if (!isEngineManagedEarlyExit(trade)) {
    return { pnl: trade.realizedPnl, bucket: recordedBucket(trade), ambiguous: false, repriced: false };
  }

  const params = prof.kind === 'sim_filtered' ? PROFILES[prof.base] : prof;
  const mfe = trade.mfe;
  const mae = trade.mae;
  const target = trade.target;
  const stop = trade.stop;
  const fav = Math.max(0, mfe); // favorable excursion used for arming logic

  // Ambiguity flag: both a full target and a full stop were touchable; ordering
  // (which came first) is unknown under the favorable-arc assumption.
  const ambiguous = fav >= target && mae <= -stop;

  // 1. (Near) target capture
  const nearTargetLevel = target * params.nearTargetCapture;
  if (target > 0 && fav >= nearTargetLevel) {
    // milder hold captures at least what the engine took, never less.
    if (fav >= target) return { pnl: round(Math.max(target, trade.realizedPnl)), bucket: 'target', ambiguous, repriced: true };
    return { pnl: round(Math.max(nearTargetLevel, trade.realizedPnl)), bucket: 'near_target', ambiguous, repriced: true };
  }

  // 2. Trailing / break-even armed
  if (fav >= params.breakEvenArmPct) {
    const trailExit = fav - params.trailingGiveBackPct;
    const exitLevel = Math.max(trailExit, 0); // break-even floor: never give back below entry once armed
    if (exitLevel <= 0 && mae <= -stop) {
      return { pnl: round(-stop), bucket: 'stop', ambiguous, repriced: true };
    }
    return { pnl: round(exitLevel), bucket: exitLevel > 0.0001 ? 'trail_profit' : 'breakeven', ambiguous, repriced: true };
  }

  // 3. Not armed -> driven by adverse side
  if (mae <= -stop) {
    return { pnl: round(-stop), bucket: 'stop', ambiguous, repriced: true };
  }

  // 4. Neither target, BE-arm, nor stop reached -> trade ends by time/other.
  //    We cannot extrapolate beyond observed excursions, so keep recorded pnl.
  //    v2 (allowExtendedHold) keeps a still-favorable trade as-is too.
  return { pnl: trade.realizedPnl, bucket: 'time_other', ambiguous, repriced: true };
}

// caution + REGULAR_PULLBACK cohort predicate (the weak entry cohort)
function isCautionRegularPullback(t) {
  return t.statusAtEntry === 'caution'
    && (t.subtype === 'REGULAR_PULLBACK' || t.signalFamily === 'REGULAR_PULLBACK' || t.strategy === 'REGULAR_PULLBACK');
}
function isWatchRegularPullback(t) {
  return t.statusAtEntry === 'watch'
    && (t.subtype === 'REGULAR_PULLBACK' || t.signalFamily === 'REGULAR_PULLBACK' || t.strategy === 'REGULAR_PULLBACK');
}
function isNarrowWait(t) {
  return t.subtype === 'NARROW_WAIT' || t.strategy === 'NARROW_WAIT';
}

// --- metrics over a set of simulated rows ({trade, sim}) ---------------------
function maxDrawdownProxy(rows) {
  // equity curve in exit-time order; max peak-to-trough of cumulative pnl
  const ordered = [...rows].sort((a, b) => {
    const ta = a.trade.exitTime ? Date.parse(a.trade.exitTime) : 0;
    const tb = b.trade.exitTime ? Date.parse(b.trade.exitTime) : 0;
    return ta - tb;
  });
  let cum = 0; let peak = 0; let maxDd = 0;
  for (const r of ordered) {
    cum += (r.sim.pnl || 0);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return round(maxDd, 4);
}

function summarize(rows) {
  const n = rows.length;
  const pnls = rows.map((r) => r.sim.pnl);
  const wins = rows.filter((r) => r.sim.pnl > 0).length;
  const durs = rows.map((r) => r.trade.durationSec);
  const targetLike = rows.filter((r) => r.sim.bucket === 'target' || r.sim.bucket === 'near_target').length;
  const stopLike = rows.filter((r) => r.sim.bucket === 'stop').length;
  return {
    trades: n,
    winrate: n ? round(100 * wins / n, 1) : 0,
    avgPnl: round(avg(pnls), 4),
    medianPnl: round(median(pnls), 4),
    totalPnl: round(pnls.reduce((s, v) => s + (v || 0), 0), 4),
    medianDurationSec: round(median(durs), 0),
    pctUnder5min: n ? round(100 * durs.filter((d) => d !== null && d < 300).length / n, 1) : 0,
    pctTargetLike: n ? round(100 * targetLike / n, 1) : 0,
    pctStopLike: n ? round(100 * stopLike / n, 1) : 0,
    maxDrawdownProxy: maxDrawdownProxy(rows),
    repricedTrades: rows.filter((r) => r.sim.repriced).length,
    ambiguousTrades: rows.filter((r) => r.sim.ambiguous).length,
    // conservative lower bound: ambiguous full-target captures re-priced to -stop
    totalPnlConservative: round(rows.reduce((s, r) => {
      if (r.sim.ambiguous && r.sim.bucket === 'target') return s - (r.trade.stop || 0);
      return s + (r.sim.pnl || 0);
    }, 0), 4),
  };
}

function bucketCounts(rows) {
  const out = {};
  for (const r of rows) out[r.sim.bucket] = (out[r.sim.bucket] || 0) + 1;
  return out;
}

// --- run a full comparison ---------------------------------------------------
function runComparison(options = {}) {
  const file = options.file || null;
  const trades = loadClosedTrades(file);

  const profileOrder = ['baseline', 'mild_exit_v1', 'mild_exit_v2', 'entry_filtered_plus_mild_exit'];

  const simulateSet = (profileId) => {
    const prof = PROFILES[profileId];
    let set = trades;
    if (prof.kind === 'sim_filtered') {
      set = trades.filter((t) => !isCautionRegularPullback(t));
    }
    return set.map((t) => ({ trade: t, sim: simulateTradeUnderProfile(t, profileId) }));
  };

  const profiles = {};
  for (const id of profileOrder) {
    const rows = simulateSet(id);
    profiles[id] = {
      id,
      label: PROFILES[id].label,
      description: PROFILES[id].description,
      summary: summarize(rows),
      buckets: bucketCounts(rows),
      rows,
    };
  }

  // diff vs baseline
  const base = profiles.baseline.summary;
  for (const id of profileOrder) {
    const s = profiles[id].summary;
    profiles[id].diffVsBaseline = {
      trades: s.trades - base.trades,
      winrate: round(s.winrate - base.winrate, 1),
      avgPnl: round(s.avgPnl - base.avgPnl, 4),
      totalPnl: round(s.totalPnl - base.totalPnl, 4),
      medianPnl: round(s.medianPnl - base.medianPnl, 4),
    };
  }

  // cohort breakdowns (avgPnl per profile per cohort)
  const cohorts = {
    'caution+REGULAR_PULLBACK': isCautionRegularPullback,
    'watch+REGULAR_PULLBACK': isWatchRegularPullback,
    'NARROW_WAIT': isNarrowWait,
    'TARGET_HIT-like (recorded)': (t) => recordedBucket(t) === 'target',
    'NEAR_TARGET_PROFIT (recorded)': (t) => /near_target_profit/i.test(String(t.exitReasonCode || '')),
  };
  const cohortBreakdown = {};
  for (const [name, pred] of Object.entries(cohorts)) {
    cohortBreakdown[name] = {};
    for (const id of profileOrder) {
      const rows = profiles[id].rows.filter((r) => pred(r.trade));
      cohortBreakdown[name][id] = rows.length
        ? { trades: rows.length, winrate: summarize(rows).winrate, avgPnl: summarize(rows).avgPnl, totalPnl: summarize(rows).totalPnl }
        : { trades: 0, winrate: 0, avgPnl: 0, totalPnl: 0 };
    }
  }

  // generic dimension breakdown (baseline vs mild_exit_v1) by a key
  const dimensionBreakdown = (keyFn) => {
    const keys = new Set(trades.map(keyFn).map((k) => k ?? '(null)'));
    const out = {};
    for (const k of keys) {
      out[k] = {};
      for (const id of profileOrder) {
        const rows = profiles[id].rows.filter((r) => (keyFn(r.trade) ?? '(null)') === k);
        const s = summarize(rows);
        out[k][id] = { trades: s.trades, winrate: s.winrate, avgPnl: s.avgPnl, totalPnl: s.totalPnl };
      }
    }
    return out;
  };

  return {
    safety: SAFETY,
    dataSource: file || 'tradeStatsService.loadPaperTrades',
    replayType: 'APPROXIMATION (closed-trade MFE/MAE based) — NOT exact bar replay (no 2m candles available for trade windows)',
    totalClosedTrades: trades.length,
    missingFieldsNote: 'exitProfile, entryQualityScore/Warnings, wouldRequire2mConfirmation, absolute stopLoss/takeProfit, riskReward, marketState/regime/timeframe are NOT logged; approximation uses targetPct/stopPct + MFE/MAE.',
    profileOrder,
    profiles,
    cohortBreakdown,
    byStatusAtEntry: dimensionBreakdown((t) => t.statusAtEntry),
    bySubtype: dimensionBreakdown((t) => t.subtype),
    byStrategy: dimensionBreakdown((t) => t.strategy),
    byExitReasonCode: dimensionBreakdown((t) => t.exitReasonCode),
    byExitSource: dimensionBreakdown((t) => t.exitSource),
  };
}

// --- pretty text report ------------------------------------------------------
function formatReport(result) {
  const L = [];
  const p = (s = '') => L.push(s);
  const pad = (s, w) => String(s).padStart(w);
  const padr = (s, w) => String(s).padEnd(w);

  p('============================================================');
  p(' MILDER EXIT REPLAY — read-only approximation');
  p('============================================================');
  p(`Datakälla:        ${result.dataSource}`);
  p(`Replay-typ:       ${result.replayType}`);
  p(`Closed trades:    ${result.totalClosedTrades}`);
  p(`Saknade fält:     ${result.missingFieldsNote}`);
  p(`Safety:           mode=${result.safety.mode} actions_allowed=${result.safety.actions_allowed} can_place_orders=${result.safety.can_place_orders} live=${result.safety.live_trading_enabled} broker=${result.safety.broker_enabled}`);
  p('');

  // main comparison table
  p('--- HUVUDTABELL: baseline vs mild_exit_v1 vs mild_exit_v2 vs entry_filtered_plus_mild_exit ---');
  const cols = ['metric', ...result.profileOrder];
  p(cols.map((c, i) => i === 0 ? padr(c, 22) : pad(c.replace('entry_filtered_plus_mild_exit', 'entry+mild'), 14)).join(''));
  const metricRow = (label, fn) => {
    p([padr(label, 22), ...result.profileOrder.map((id) => pad(fn(result.profiles[id].summary), 14))].join(''));
  };
  metricRow('trades', (s) => s.trades);
  metricRow('winrate %', (s) => s.winrate);
  metricRow('avgPnl %', (s) => s.avgPnl);
  metricRow('medianPnl %', (s) => s.medianPnl);
  metricRow('totalPnl %', (s) => s.totalPnl);
  metricRow('totalPnl(consv) %', (s) => s.totalPnlConservative);
  metricRow('medianDur (s)', (s) => s.medianDurationSec);
  metricRow('under 5min %', (s) => s.pctUnder5min);
  metricRow('target-like %', (s) => s.pctTargetLike);
  metricRow('stop-like %', (s) => s.pctStopLike);
  metricRow('maxDD proxy %', (s) => s.maxDrawdownProxy);
  metricRow('repriced trades', (s) => s.repricedTrades);
  metricRow('ambiguous trades', (s) => s.ambiguousTrades);
  p('');
  p('Diff mot baseline (totalPnl% / avgPnl% / winrate pp):');
  for (const id of result.profileOrder) {
    if (id === 'baseline') continue;
    const d = result.profiles[id].diffVsBaseline;
    p(`  ${padr(id, 32)} totalPnl ${pad(d.totalPnl, 8)}  avgPnl ${pad(d.avgPnl, 8)}  winrate ${pad(d.winrate, 6)}  (trades Δ ${d.trades})`);
  }
  p('');

  // special cohorts
  p('--- SÄRSKILDA KOHORTER (avgPnl% | winrate% | n) per profil ---');
  for (const [name, byProf] of Object.entries(result.cohortBreakdown)) {
    p(`  ${name}:`);
    for (const id of result.profileOrder) {
      const c = byProf[id];
      p(`     ${padr(id, 32)} n=${pad(c.trades, 4)}  avgPnl ${pad(c.avgPnl, 8)}  win ${pad(c.winrate, 6)}  total ${pad(c.totalPnl, 8)}`);
    }
  }
  p('');

  // breakdowns baseline vs mild_exit_v1
  const dimTable = (title, dim) => {
    p(`--- ${title} (baseline -> mild_exit_v1, avgPnl% | n) ---`);
    const entries = Object.entries(dim).sort((a, b) => (b[1].baseline.trades) - (a[1].baseline.trades));
    for (const [k, byProf] of entries) {
      const b = byProf.baseline; const m = byProf.mild_exit_v1;
      p(`   ${padr(k, 26)} n=${pad(b.trades, 4)}  baseline ${pad(b.avgPnl, 8)} -> v1 ${pad(m.avgPnl, 8)}  (win ${b.winrate}->${m.winrate})`);
    }
    p('');
  };
  dimTable('statusAtEntry', result.byStatusAtEntry);
  dimTable('subtype', result.bySubtype);
  dimTable('strategy', result.byStrategy);
  dimTable('exitReasonCode', result.byExitReasonCode);
  dimTable('exitSource', result.byExitSource);

  return L.join('\n');
}

module.exports = {
  SAFETY,
  PROFILES,
  loadClosedTrades,
  normalizeTrade,
  recordedBucket,
  simulateTradeUnderProfile,
  isCautionRegularPullback,
  isWatchRegularPullback,
  isNarrowWait,
  summarize,
  runComparison,
  formatReport,
  PAPER_TRADES_FILE,
};
