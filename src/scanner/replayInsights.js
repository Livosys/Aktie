'use strict';
const fs   = require('fs');
const path = require('path');

const REPLAY_DIR = path.resolve(__dirname, '../../data/replay/runs');

function round(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = (item[key] != null ? item[key] : 'unknown');
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

function avgScore(events) {
  const scores = events.map((e) => e.tradeScore).filter((s) => s != null);
  if (scores.length === 0) return null;
  return round(scores.reduce((a, b) => a + b, 0) / scores.length, 1);
}

/**
 * Build insights from replay events.
 * Saves to data/replay/runs/RUN_ID/insights.json.
 * Returns the insights object.
 */
async function buildInsights(runId, events, summary) {
  const outPath = path.join(REPLAY_DIR, runId, 'insights.json');

  if (!events || events.length === 0) {
    const empty = { runId, empty: true, builtAt: new Date().toISOString(), textInsights: ['Inga events att analysera.'] };
    try { fs.writeFileSync(outPath, JSON.stringify(empty, null, 2), 'utf8'); } catch (_) {}
    return empty;
  }

  // ── Per-symbol stats ───────────────────────────────────────────────────────
  const bySym = groupBy(events, 'symbol');
  const symbolStats = Object.entries(bySym).map(([sym, evts]) => {
    const tfsBlocked = evts.filter((e) => e.flags?.threeFingerSpread).length;
    const bocBlocked = evts.filter((e) => e.flags?.breakoutAlreadyOccurred).length;
    const hqnCount   = evts.filter((e) => e.state === 'HIGH_QUALITY_NARROW').length;
    const longTrig   = evts.filter((e) => e.signal?.includes('LONG')).length;
    const shortTrig  = evts.filter((e) => e.signal?.includes('SHORT')).length;
    const elephantBar = evts.filter((e) => e.flags?.elephantBar).length;
    const colorChg    = evts.filter((e) => e.flags?.colorChange).length;
    return {
      symbol: sym,
      events: evts.length,
      avgScore: avgScore(evts),
      hqnCount,
      tfsBlocked,
      bocBlocked,
      longTriggers:  longTrig,
      shortTriggers: shortTrig,
      elephantBar,
      colorChange: colorChg,
    };
  }).sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));

  // ── Signal frequency ───────────────────────────────────────────────────────
  const bySignal = groupBy(events, 'signal');
  const signalFreq = Object.entries(bySignal)
    .map(([signal, evts]) => ({ signal, count: evts.length, avgScore: avgScore(evts) }))
    .sort((a, b) => b.count - a.count);

  // ── State counts ───────────────────────────────────────────────────────────
  const byState = groupBy(events, 'state');
  const stateCounts = Object.entries(byState)
    .map(([state, evts]) => ({ state, count: evts.length }))
    .sort((a, b) => b.count - a.count);

  // ── Regime analysis ────────────────────────────────────────────────────────
  const byRegime = {};
  for (const e of events) {
    const regime = e.marketContext?.regime || 'UNKNOWN';
    if (!byRegime[regime]) byRegime[regime] = [];
    byRegime[regime].push(e);
  }
  const regimeStats = Object.entries(byRegime)
    .map(([regime, evts]) => ({
      regime,
      count: evts.length,
      avgScore: avgScore(evts),
      longSignals:  evts.filter((e) => e.signal?.includes('LONG')).length,
      shortSignals: evts.filter((e) => e.signal?.includes('SHORT')).length,
    }))
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));

  // ── Totals ─────────────────────────────────────────────────────────────────
  const tfsTotal  = events.filter((e) => e.flags?.threeFingerSpread).length;
  const bocTotal  = events.filter((e) => e.flags?.breakoutAlreadyOccurred).length;
  const hqnTotal  = events.filter((e) => e.state === 'HIGH_QUALITY_NARROW').length;
  const longTotal  = events.filter((e) => e.signal?.includes('LONG')).length;
  const shortTotal = events.filter((e) => e.signal?.includes('SHORT')).length;

  // ── Swedish text insights ──────────────────────────────────────────────────
  const textInsights = [];

  const best  = symbolStats[0] || null;
  const worst = symbolStats[symbolStats.length - 1] || null;

  if (best) {
    textInsights.push(`${best.symbol} hade flest intressanta lägen (snittbetyg ${best.avgScore ?? '–'}).`);
  }
  if (worst && worst.symbol !== best?.symbol) {
    textInsights.push(`${worst.symbol} hade lägst snittbetyg (${worst.avgScore ?? '–'}).`);
  }

  const mostTfsBlocked = [...symbolStats].sort((a, b) => b.tfsBlocked - a.tfsBlocked)[0];
  if (mostTfsBlocked && mostTfsBlocked.tfsBlocked > 1) {
    textInsights.push(`${mostTfsBlocked.symbol} blockerades ofta av 3-finger spread (${mostTfsBlocked.tfsBlocked} gånger).`);
  }

  const bestRegime = regimeStats.find((r) => r.regime !== 'UNKNOWN' && r.count >= 3);
  if (bestRegime) {
    textInsights.push(`Flest starka signaler kom under ${bestRegime.regime} (snittbetyg ${bestRegime.avgScore ?? '–'}).`);
  }

  if (tfsTotal > 0) {
    textInsights.push(`Totalt blockerades ${tfsTotal} tillfällen av 3-finger spread.`);
  }
  if (bocTotal > 0) {
    textInsights.push(`${bocTotal} gånger hade utbrottet redan hänt (BREAKOUT_ALREADY_OCCURRED).`);
  }
  if (hqnTotal > 0) {
    textInsights.push(`${hqnTotal} tillfällen med HIGH_QUALITY_NARROW — starka setup-lägen.`);
  }

  const weakSignals = events.filter((e) => (e.tradeScore ?? 0) < 30).length;
  if (weakSignals > events.length * 0.4) {
    textInsights.push('Många signaler var svaga eftersom priset låg för långt från zonen.');
  }

  if (longTotal > shortTotal * 2) {
    textInsights.push('Perioden dominerades av long-signaler.');
  } else if (shortTotal > longTotal * 2) {
    textInsights.push('Perioden dominerades av short-signaler.');
  }

  const insights = {
    runId,
    builtAt:     new Date().toISOString(),
    textInsights,
    symbolStats,
    signalFreq,
    stateCounts,
    regimeStats,
    totals: {
      events:       events.length,
      tfsBlocked:   tfsTotal,
      bocBlocked:   bocTotal,
      hqnCount:     hqnTotal,
      longTriggers:  longTotal,
      shortTriggers: shortTotal,
    },
  };

  try {
    fs.writeFileSync(outPath, JSON.stringify(insights, null, 2), 'utf8');
  } catch (err) {
    console.warn('[ReplayInsights] Failed to save insights:', err.message);
  }

  return insights;
}

/**
 * Load saved insights for a run.
 */
function loadInsights(runId) {
  const p = path.join(REPLAY_DIR, runId, 'insights.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) {
    console.warn('[ReplayInsights] loadInsights error:', err.message);
    return null;
  }
}

module.exports = { buildInsights, loadInsights };
