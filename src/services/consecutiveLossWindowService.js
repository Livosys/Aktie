'use strict';

// Shared, pure derivation of the trailing consecutive-loss streak, with an
// optional time window so the streak can "age out" over time instead of only
// resetting on a WIN. Used by BOTH the live paper entry-path
// (paperTradingAgent.buildRiskAccountState) and the risk-pause summary
// (paperRiskPauseSummaryService.buildConsecutiveLossState) so the two never
// diverge.
//
// READ-ONLY / paper-only analysis: it only counts existing closed trades. It
// places no orders, touches no broker, never auto-applies risk and never
// mutates pause/resume state. The pause threshold itself
// (max_consecutive_losses) lives in riskEngineService and is NOT touched here.
//
// mode:
//   'off'           (default) — count all trailing losses until a WIN. Exactly
//                   the historical behavior; inert until explicitly changed.
//   'daily'         — only count losses that closed on the current UTC day.
//   'rolling_hours' — only count losses within the last `windowHours`.

const VALID_MODES = new Set(['off', 'daily', 'rolling_hours']);
const DEFAULT_WINDOW_HOURS = 24;

function resolveMode(mode) {
  const m = String(mode || '').toLowerCase();
  return VALID_MODES.has(m) ? m : 'off';
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function startOfUtcDayMs(now) {
  const d = now instanceof Date ? now : new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Losses strictly before this ms are "aged out" and do not count.
// Returns null for 'off' (no boundary → identical to legacy behavior).
function windowBoundaryMs(mode, { windowHours, now = new Date() } = {}) {
  const m = resolveMode(mode);
  if (m === 'daily') return startOfUtcDayMs(now);
  if (m === 'rolling_hours') {
    const hours = Number.isFinite(Number(windowHours)) ? Math.max(0, Number(windowHours)) : DEFAULT_WINDOW_HOURS;
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    return nowMs - hours * 3600 * 1000;
  }
  return null; // 'off'
}

/**
 * Compute the trailing consecutive-loss streak.
 *
 * @param {Array} trades   closed trades (any shape; use accessors below)
 * @param {object} options
 * @param {'off'|'daily'|'rolling_hours'} [options.mode='off']
 * @param {number} [options.windowHours]   used only for 'rolling_hours'
 * @param {Date}   [options.now=new Date()]
 * @param {(t)=>string} [options.getResult] returns 'WIN'|'LOSS'|other
 * @param {(t)=>string} [options.getTime]   returns an ISO/date string or null
 * @returns {{ consecutive_losses: number, last_loss_at: (string|null) }}
 */
function computeConsecutiveLosses(trades, options = {}) {
  const {
    mode = 'off',
    windowHours,
    now = new Date(),
    getResult = (t) => (t && t.result) || null,
    getTime = (t) => (t && (t.ts || t.closed_at || t.exitTime || t.timestamp || t.entryTime || t.opened_at)) || null,
  } = options;

  const list = Array.isArray(trades) ? trades : [];
  const boundaryMs = windowBoundaryMs(mode, { windowHours, now });

  // Sort ascending by time (missing/invalid time sorts earliest), then walk
  // backwards from the newest trade — matches the legacy sort in both callers.
  const sorted = list
    .map((t) => ({ trade: t, ms: toMs(getTime(t)) }))
    .sort((a, b) => {
      const am = Number.isNaN(a.ms) ? -Infinity : a.ms;
      const bm = Number.isNaN(b.ms) ? -Infinity : b.ms;
      return am - bm;
    });

  let consecutiveLosses = 0;
  let lastLossAt = null;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const { trade, ms } = sorted[i];
    // Outside the window → age out (stop). Never triggers for 'off' (boundary null).
    if (boundaryMs !== null && (Number.isNaN(ms) || ms < boundaryMs)) break;
    const result = String(getResult(trade) || '').toUpperCase();
    if (result === 'LOSS') {
      consecutiveLosses += 1;
      if (!lastLossAt) lastLossAt = getTime(trade) || null;
      continue;
    }
    if (result === 'WIN') break;
    // TIMEOUT / BREAKEVEN / UNKNOWN → neither counts nor breaks (matches legacy).
  }

  return { consecutive_losses: consecutiveLosses, last_loss_at: lastLossAt };
}

module.exports = {
  VALID_MODES,
  DEFAULT_WINDOW_HOURS,
  resolveMode,
  startOfUtcDayMs,
  windowBoundaryMs,
  computeConsecutiveLosses,
};
