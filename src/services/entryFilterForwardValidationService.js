'use strict';

// ---------------------------------------------------------------------------
// Entry-Filter Forward Validation (read-only, observe-only, gate stays OFF)
// ---------------------------------------------------------------------------
// Goal:
//   Validate the "skip caution + REGULAR_PULLBACK" entry filter GOING FORWARD.
//   We tag each closed paper trade with a wouldSkip flag (observation only — no
//   trade is blocked, no gate is read or activated) and measure whether the
//   historical edge of skipping that cohort actually holds out-of-sample on
//   trades that close AFTER a chosen cutoff.
//
// Why this is safe / read-only:
//   - Pure function of data/paper-trading/trades.jsonl. Only fs/path required.
//   - Never reads or sets PAPER_ENTRY_QUALITY_GATE_ENABLED — the gate is
//     irrelevant here; this never blocks anything. mode stays paper_only.
//   - Never writes trades/state/config/env, never places orders.
//   - Deterministic + idempotent: the wouldSkip label is a pure function of
//     recorded fields, so no state needs to be persisted — re-running later
//     automatically includes newly-closed trades (that is the "forward" part).
//
// wouldSkip semantics are kept IDENTICAL to the entryQualityComparison
// "skip_caution_regular_pullback" profile so results are directly comparable:
//     wouldSkip = isCaution && isRegularPullback
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  read_only: true,
  observe_only: true,
  blocks_entries: false,
  reads_or_sets_gate: false,
});

const DATA_DIR = path.resolve(__dirname, '../../data');
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trading/trades.jsonl');

// minimum cohort size before we issue a forward verdict
const MIN_FORWARD_COHORT = 10;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

function lower(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v, d = 4) { const n = Number(v); if (!Number.isFinite(n)) return 0; const f = 10 ** d; return Math.round(n * f) / f; }
function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function avg(arr) { const a = arr.filter((x) => Number.isFinite(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function tsOf(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }

// --- derive the entry signals we flag on (mirrors entryQualityComparison) -----
function deriveSignals(raw = {}) {
  const statusAtEntry = lower(raw.statusAtEntry ?? raw.runtime_status ?? raw.runtimeStatus ?? '') || 'unknown';
  const setupBlob = [
    raw.setup, raw.signalSubtype, raw.signalFamily, raw.signal_subtype,
    raw.subtypeLabelSv, raw.familyLabelSv, raw.strategyName, raw.strategy_name, raw.strategy,
  ].map(lower).join(' ');
  const isRegularPullback = /regular_pullback|regular pullback|trend continuation|rekyl/.test(setupBlob);
  const isNarrowWait = /narrow_wait/.test(setupBlob);
  const result = String(raw.result ?? raw.outcome ?? '').trim().toUpperCase() || 'UNKNOWN';
  const pnlPct = num(raw.pnlPct ?? raw.pnl_pct ?? raw.pnl);
  const isCaution = statusAtEntry === 'caution';
  return {
    symbol: String(raw.symbol || '').toUpperCase() || null,
    strategy: String(raw.strategyName || raw.strategy_name || raw.strategy || 'unknown'),
    statusAtEntry,
    isCaution,
    isRegularPullback,
    isNarrowWait,
    // primary forward-validation flag:
    wouldSkip: isCaution && isRegularPullback,
    // secondary observational flag (worst cohort, not the validated one):
    wouldSkipNarrowWait: isNarrowWait,
    pnlPct,
    isWin: result === 'WIN' ? true : (result === 'LOSS' ? false : (pnlPct != null ? pnlPct > 0 : false)),
    durationSec: num(raw.duration_seconds),
    entryTs: tsOf(raw.entryTime || raw.opened_at),
    exitTs: tsOf(raw.exitTime || raw.closed_at),
    entryTime: raw.entryTime || raw.opened_at || null,
  };
}

function loadSignals(file = PAPER_TRADES_FILE) {
  return readJsonl(file).map(deriveSignals).filter((s) => s.pnlPct !== null);
}

// --- metrics over a set of signals -------------------------------------------
function summarize(signals) {
  const n = signals.length;
  const pnls = signals.map((s) => s.pnlPct);
  const durs = signals.map((s) => s.durationSec);
  const wins = signals.filter((s) => s.isWin).length;
  return {
    count: n,
    winrate: n ? round(100 * wins / n, 1) : 0,
    avgPnl: round(avg(pnls), 4),
    medianPnl: round(median(pnls), 4),
    totalPnl: round(pnls.reduce((a, b) => a + (b || 0), 0), 4),
    medianDurationSec: round(median(durs), 0),
    pctUnder5min: n ? round(100 * durs.filter((d) => d !== null && d < 300).length / n, 1) : 0,
  };
}

// --- evaluate one window of trades against the wouldSkip flag -----------------
function evaluateWindow(signals, label, flagKey = 'wouldSkip') {
  const flagged = signals.filter((s) => s[flagKey]);   // would be skipped
  const kept = signals.filter((s) => !s[flagKey]);      // would remain
  const all = summarize(signals);
  const keptSummary = summarize(kept);
  const flaggedSummary = summarize(flagged);

  // Net effect of ACTING on the flag = kept-only vs all.
  const netEffect = {
    winrateDelta: round(keptSummary.winrate - all.winrate, 1),
    avgPnlDelta: round(keptSummary.avgPnl - all.avgPnl, 4),
    totalPnlForgone: round(flaggedSummary.totalPnl, 4), // pnl removed by skipping (negative = good to skip)
    tradesRemoved: flagged.length,
  };

  // Forward verdict: does the flagged cohort actually underperform kept here?
  let verdict;
  if (flagged.length < MIN_FORWARD_COHORT) {
    verdict = `OTILLRÄCKLIG DATA (flaggade=${flagged.length} < ${MIN_FORWARD_COHORT}) — fortsätt ackumulera`;
  } else {
    const worseAvg = flaggedSummary.avgPnl < keptSummary.avgPnl;
    const worseWin = flaggedSummary.winrate < keptSummary.winrate;
    if (worseAvg && worseWin) verdict = 'BEKRÄFTAD — flaggade trades är sämre på både avgPnl och winrate';
    else if (worseAvg || worseWin) verdict = 'DELVIS — flaggade sämre på ett av två mått';
    else verdict = 'EJ BEKRÄFTAD — flaggade trades är INTE sämre i detta fönster';
  }

  return { label, flagKey, all, kept: keptSummary, flagged: flaggedSummary, netEffect, verdict };
}

// --- main entry: split into historical vs forward window ---------------------
function runForwardValidation(options = {}) {
  const file = options.file || PAPER_TRADES_FILE;
  const signals = loadSignals(file);

  // cutoff: default = start of current UTC day. Trades whose ENTRY is >= cutoff
  // form the forward window. Pass options.since (ISO) to freeze a start point.
  let cutoffTs;
  if (options.since) {
    cutoffTs = tsOf(options.since);
    if (cutoffTs == null) throw new Error(`invalid --since: ${options.since}`);
  } else {
    const now = new Date();
    cutoffTs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  }

  const forward = signals.filter((s) => s.entryTs != null && s.entryTs >= cutoffTs);
  const historical = signals.filter((s) => s.entryTs == null || s.entryTs < cutoffTs);

  return {
    safety: SAFETY,
    dataSource: file,
    note: 'OBSERVE-ONLY: wouldSkip flaggar men blockerar inget. Gaten (PAPER_ENTRY_QUALITY_GATE_ENABLED) varken läses eller sätts. Forward-validering = mät om flaggans historiska edge håller på trades som öppnats efter cutoff.',
    cutoffIso: new Date(cutoffTs).toISOString(),
    totalTrades: signals.length,
    flagDefinition: 'wouldSkip = statusAtEntry==caution AND setup matchar REGULAR_PULLBACK (identisk med skip_caution_regular_pullback)',
    windows: {
      historical: evaluateWindow(historical, `HISTORIK (entry < ${new Date(cutoffTs).toISOString()})`),
      forward: evaluateWindow(forward, `FORWARD (entry >= ${new Date(cutoffTs).toISOString()})`),
      allTime: evaluateWindow(signals, 'ALL-TIME (referens)'),
    },
    // secondary observed flag (NARROW_WAIT) on all-time, for context only
    secondaryNarrowWait: evaluateWindow(signals, 'ALL-TIME NARROW_WAIT (sekundär observation)', 'wouldSkipNarrowWait'),
  };
}

// --- per-entry forward PREVIEW (runtime, observe-only, gate stays OFF) --------
// Pure function of entry-time fields (no pnl needed). Produces the additive
// `entryQualityForwardPreview` record attached to every NEW paper trade.
//
// HARD GUARANTEES (never change):
//   - gateEnabled = false  → PAPER_ENTRY_QUALITY_GATE_ENABLED is never read/set.
//   - runtimeBlocked = false → this NEVER blocks, skips or delays a trade.
//   - additive only → the caller keeps opening the trade exactly as before; this
//     just annotates it for observability/forward measurement.
function evaluateEntryForwardPreview(raw = {}, opts = {}) {
  const statusAtEntry = lower(
    raw.statusAtEntry ?? raw.status ?? raw.runtime_status ?? raw.runtimeStatus ?? '',
  ) || 'unknown';
  const setupBlob = [
    raw.setup, raw.signalSubtype, raw.signalFamily, raw.signal_subtype,
    raw.subtypeLabelSv, raw.familyLabelSv, raw.strategyName, raw.strategy_name, raw.strategy,
  ].map(lower).join(' ');
  const isRegularPullback = /regular_pullback|regular pullback|trend continuation|rekyl/.test(setupBlob);
  const isNarrowWait = /narrow_wait/.test(setupBlob);
  const isCaution = statusAtEntry === 'caution';
  const evaluatedAt = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();

  // Neutral default: nothing flagged, never blocks.
  const preview = {
    enabled: true,
    gateEnabled: false,     // gate stays OFF — observe-only
    runtimeBlocked: false,  // ALWAYS false
    wouldAvoidByEntryFilter: false,
    wouldSkipByEntryFilter: false,
    wouldRequire2mConfirmation: false,
    reasonCode: null,
    reasonSv: null,
    cohort: null,
    severity: null,
    evaluatedAt,
  };

  // NARROW_WAIT: weakest cohort in fresh data → flag avoid/skip, but DO NOT block.
  if (isNarrowWait) {
    preview.wouldAvoidByEntryFilter = true;
    preview.wouldSkipByEntryFilter = true;
    preview.reasonCode = 'narrow_wait_underperforms_forward_validation';
    preview.reasonSv = 'NARROW_WAIT har varit svag i färsk data. Detta är bara analys; traden stoppas inte.';
    preview.cohort = 'narrow_wait';
    preview.severity = 'high';
    return preview;
  }

  // caution + REGULAR_PULLBACK: fresh data does NOT justify blocking → neutral
  // monitor only. Never skip/avoid, never require 2m confirmation by default.
  if (isCaution && isRegularPullback) {
    preview.reasonCode = 'caution_regular_pullback_monitor_only';
    preview.reasonSv = 'Färsk data motiverar inte blockering just nu. Detta bevakas bara.';
    preview.cohort = 'caution_regular_pullback';
    preview.wouldRequire2mConfirmation = false;
    preview.severity = 'low';
    return preview;
  }

  // Everything else: unflagged, neutral.
  preview.cohort = 'unflagged';
  return preview;
}

// --- text report -------------------------------------------------------------
function formatReport(result) {
  const L = [];
  const p = (s = '') => L.push(s);
  const padr = (s, w) => String(s).padEnd(w);
  const pad = (s, w) => String(s).padStart(w);

  p('============================================================');
  p(' ENTRY-FILTER FORWARD VALIDATION — observe-only, gate OFF');
  p('============================================================');
  p(`Datakälla:    ${result.dataSource}`);
  p(`Flagga:       ${result.flagDefinition}`);
  p(`Cutoff:       ${result.cutoffIso}  (forward = entry >= cutoff)`);
  p(`Trades totalt:${result.totalTrades}`);
  p(`Safety:       mode=${result.safety.mode} actions_allowed=${result.safety.actions_allowed} can_place_orders=${result.safety.can_place_orders} blocks_entries=${result.safety.blocks_entries} reads_or_sets_gate=${result.safety.reads_or_sets_gate}`);
  p(`Obs:          ${result.note}`);
  p('');

  const block = (w) => {
    p(`--- ${w.label} ---`);
    p(`   ${padr('cohort', 12)} ${pad('n', 5)} ${pad('win%', 7)} ${pad('avgPnl%', 9)} ${pad('medPnl%', 9)} ${pad('totPnl%', 9)} ${pad('medDur(s)', 10)} ${pad('u5min%', 7)}`);
    const row = (name, s) => p(`   ${padr(name, 12)} ${pad(s.count, 5)} ${pad(s.winrate, 7)} ${pad(s.avgPnl, 9)} ${pad(s.medianPnl, 9)} ${pad(s.totalPnl, 9)} ${pad(s.medianDurationSec, 10)} ${pad(s.pctUnder5min, 7)}`);
    row('ALL', w.all);
    row('KEPT', w.kept);
    row('wouldSkip', w.flagged);
    p(`   Net effekt av att skippa: winrate ${w.netEffect.winrateDelta >= 0 ? '+' : ''}${w.netEffect.winrateDelta}pp, avgPnl ${w.netEffect.avgPnlDelta >= 0 ? '+' : ''}${w.netEffect.avgPnlDelta}, bortskippad totalPnl ${w.netEffect.totalPnlForgone} (negativ = bra att skippa), trades bort ${w.netEffect.tradesRemoved}`);
    p(`   VERDICT: ${w.verdict}`);
    p('');
  };

  block(result.windows.historical);
  block(result.windows.forward);
  block(result.windows.allTime);
  block(result.secondaryNarrowWait);

  return L.join('\n');
}

module.exports = {
  SAFETY,
  PAPER_TRADES_FILE,
  MIN_FORWARD_COHORT,
  deriveSignals,
  loadSignals,
  summarize,
  evaluateWindow,
  evaluateEntryForwardPreview,
  runForwardValidation,
  formatReport,
};
