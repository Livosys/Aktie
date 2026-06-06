'use strict';

/**
 * Read-only replay status service.
 *
 * Inspects the replay run summaries written by the replay engine
 * (data/replay/runs/<runId>/summary.json) and turns them into a compact,
 * render-safe status. It NEVER starts a replay, never schedules one, never
 * places orders and never enables a broker. Pure read of existing files.
 *
 * Replay in this system is a paper/scan-only simulation over historical 2m
 * candles. Summaries therefore carry signal/score outcomes, not live trades.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_RUNS_DIR = path.join(ROOT, 'data/replay/runs');

// The replay engine scans 2m candles; summaries do not carry a timeframe field.
const REPLAY_TIMEFRAME = '2m';
// Cap how many run summaries we read so the endpoint stays cheap even if the
// runs directory grows large over time.
const MAX_RUNS_READ = 200;

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso() { return new Date().toISOString(); }
function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined && v !== '') : [value].filter(Boolean);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function safeError(err) {
  const msg = String(err?.message || err || 'unknown_error');
  if (/key|token|secret|password|credential|authorization/i.test(msg)) return 'Källa kunde inte läsas utan att visa hemligheter.';
  return msg.slice(0, 180);
}
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listRunIds(runsDir) {
  try {
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir)
      .filter((d) => /^run_/.test(d))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

function topSymbol(list) {
  const first = arr(list)[0];
  if (!first || typeof first !== 'object') return null;
  return {
    symbol: first.symbol || null,
    avgScore: num(first.avgScore),
    events: num(first.events),
  };
}

function normalizeRun(summary, runId) {
  if (!summary || typeof summary !== 'object') return null;
  const symbols = arr(summary.symbols);
  return {
    runId: summary.runId || runId || null,
    createdAt: summary.createdAt || null,
    period: { from: summary.start || null, to: summary.end || null },
    // Named replayMode (not mode) so the SAFETY.mode='paper_only' flag below is
    // never shadowed. Replay runs are scan_only/with_outcomes simulations.
    replayMode: summary.mode || 'scan_only',
    timeframe: REPLAY_TIMEFRAME,
    timeframeSource: 'replay_engine_default_2m',
    symbols,
    symbolCount: symbols.length,
    totalCandles: num(summary.totalCandles),
    totalEvents: num(summary.totalEvents),
    avgTradeScore: num(summary.avgTradeScore),
    signalsByType: summary.signalsByType && typeof summary.signalsByType === 'object' ? summary.signalsByType : {},
    bestSymbol: topSymbol(summary.bestSymbols),
    worstSymbol: topSymbol(summary.worstSymbols),
    // Replay is a paper/scan simulation — there is no live outcome to report.
    outcome: num(summary.avgTradeScore) !== null ? `Snittbetyg ${num(summary.avgTradeScore)}` : null,
    ...SAFETY,
  };
}

function buildReplayStatus(options = {}) {
  const runsDir = options.runsDir || DEFAULT_RUNS_DIR;
  try {
    const runIds = listRunIds(runsDir).slice(0, MAX_RUNS_READ);
    const runs = [];
    let unreadable = 0;
    for (const runId of runIds) {
      const summary = readJson(path.join(runsDir, runId, 'summary.json'));
      const normalized = normalizeRun(summary, runId);
      if (normalized) runs.push(normalized); else unreadable += 1;
    }

    if (!runs.length) {
      return {
        ok: true,
        status: runIds.length ? 'degraded' : 'empty',
        totalReplayTests: 0,
        latestReplay: null,
        latestCompletedReplay: null,
        latestResult: null,
        recentReplays: [],
        symbols: [],
        timeframes: [],
        earliestPeriod: null,
        latestPeriod: null,
        runsDirExists: fs.existsSync(runsDir),
        unreadableRuns: unreadable,
        source: 'data/replay/runs',
        updatedAt: nowIso(),
        message: runIds.length
          ? 'Replay-körningar finns men kunde inte läsas.'
          : 'Ingen replayhistorik hittades ännu.',
        ...SAFETY,
      };
    }

    // runIds come newest-first; keep that order for "latest".
    const latest = runs[0];
    const latestCompleted = runs.find((r) => r.totalEvents !== null && r.createdAt) || latest;
    const symbols = [...new Set(runs.flatMap((r) => r.symbols))].sort();
    const froms = runs.map((r) => r.period.from).filter(Boolean).sort();
    const tos = runs.map((r) => r.period.to).filter(Boolean).sort();

    return {
      ok: true,
      status: unreadable ? 'degraded' : 'ok',
      totalReplayTests: runs.length,
      latestReplay: latest,
      latestCompletedReplay: latestCompleted,
      latestResult: latest ? {
        runId: latest.runId,
        createdAt: latest.createdAt,
        period: latest.period,
        symbols: latest.symbols,
        timeframe: latest.timeframe,
        totalEvents: latest.totalEvents,
        avgTradeScore: latest.avgTradeScore,
        bestSymbol: latest.bestSymbol,
        outcome: latest.outcome,
        ...SAFETY,
      } : null,
      recentReplays: runs.slice(0, 10),
      symbols,
      timeframes: [REPLAY_TIMEFRAME],
      earliestPeriod: froms[0] || null,
      latestPeriod: tos[tos.length - 1] || null,
      runsDirExists: true,
      unreadableRuns: unreadable,
      source: 'data/replay/runs',
      updatedAt: nowIso(),
      message: `${runs.length} replay-körningar lästa (read-only, scan/paper).`,
      ...SAFETY,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      totalReplayTests: 0,
      latestReplay: null,
      latestCompletedReplay: null,
      latestResult: null,
      recentReplays: [],
      symbols: [],
      timeframes: [],
      earliestPeriod: null,
      latestPeriod: null,
      source: 'data/replay/runs',
      updatedAt: nowIso(),
      message: safeError(err),
      ...SAFETY,
    };
  }
}

function buildSupervisorReplaySummary(options = {}) {
  const full = buildReplayStatus(options);
  return {
    status: full.status,
    totalReplayTests: full.totalReplayTests,
    latestReplay: full.latestReplay ? {
      runId: full.latestReplay.runId,
      createdAt: full.latestReplay.createdAt,
      period: full.latestReplay.period,
      symbols: full.latestReplay.symbols,
      timeframe: full.latestReplay.timeframe,
      totalEvents: full.latestReplay.totalEvents,
      avgTradeScore: full.latestReplay.avgTradeScore,
      bestSymbol: full.latestReplay.bestSymbol,
      outcome: full.latestReplay.outcome,
    } : null,
    latestResult: full.latestResult,
    symbols: full.symbols,
    timeframes: full.timeframes,
    earliestPeriod: full.earliestPeriod,
    latestPeriod: full.latestPeriod,
    updatedAt: full.updatedAt,
    message: full.message,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  REPLAY_TIMEFRAME,
  buildReplayStatus,
  buildSupervisorReplaySummary,
  _internal: {
    normalizeRun,
    listRunIds,
    topSymbol,
    safeError,
  },
};
