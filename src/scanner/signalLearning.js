'use strict';
const fs   = require('fs');
const path = require('path');
const { loadOutcomes } = require('./signalOutcomeAnalyzer');

const SUMMARY_PATH = path.resolve(__dirname, '../../data/signals/learning-summary.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function round(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function winRate(outcomes) {
  const withResult = outcomes.filter((o) => o.success !== null);
  if (withResult.length === 0) return null;
  const wins = withResult.filter((o) => o.success === true).length;
  return round(wins / withResult.length, 4);
}

function avgField(outcomes, field) {
  const vals = outcomes.map((o) => o[field]).filter((v) => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length, 4);
}

function avgNestedField(outcomes, horizon, field) {
  const key  = `outcome${horizon}`;
  const vals = outcomes
    .map((o) => o[key]?.[field])
    .filter((v) => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length, 4);
}

function groupBy(arr, key) {
  return arr.reduce((m, item) => {
    const k = item[key] || 'unknown';
    if (!m[k]) m[k] = [];
    m[k].push(item);
    return m;
  }, {});
}

function topByWinRate(grouped, minSamples = 3) {
  return Object.entries(grouped)
    .map(([k, arr]) => ({ key: k, samples: arr.length, winRate: winRate(arr) }))
    .filter((e) => e.samples >= minSamples && e.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate);
}

function scoreRangeAnalysis(outcomes) {
  const brackets = [
    { label: '0-20',  lo: 0,  hi: 20  },
    { label: '20-40', lo: 20, hi: 40  },
    { label: '40-60', lo: 40, hi: 60  },
    { label: '60-75', lo: 60, hi: 75  },
    { label: '75-100',lo: 75, hi: 100 },
  ];
  return brackets.map(({ label, lo, hi }) => {
    const slice = outcomes.filter((o) => o.tradeScore !== null && o.tradeScore >= lo && o.tradeScore < hi);
    return { range: label, samples: slice.length, winRate: winRate(slice) };
  }).filter((b) => b.samples > 0);
}

function commonFailureReasons(outcomes) {
  const failures = outcomes.filter((o) => o.success === false);
  const counts   = {};
  failures.forEach((o) => {
    const r = o.failureReason || 'unknown';
    counts[r] = (counts[r] || 0) + 1;
  });
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => ({ reason, count }));
}

// ── Avoid conditions ─────────────────────────────────────────────────────────

function deriveAvoidConditions(failures) {
  const avoid = [];

  // threeFingerSpread
  const tfsFailures = failures.filter((o) => {
    const sig = o; // outcome rows may not have threeFingerSpreadActive
    return false; // TODO: join with signals to check
  });

  // High priceToZoneAtr
  const highZone = failures.filter((o) => {
    // We don't have priceToZoneAtr in outcome — it's in the signal
    return false;
  });

  // Low tradeScore
  const lowScore = failures.filter((o) => o.tradeScore !== null && o.tradeScore < 30);
  if (lowScore.length > 2) avoid.push(`tradeScore < 30 (${lowScore.length} failures)`);

  return avoid;
}

// ── Build summary ─────────────────────────────────────────────────────────────

/**
 * Build learning summary from outcome files.
 *
 * @param {object} opts
 * @param {string}   opts.start   - "YYYY-MM-DD"
 * @param {string}   opts.end     - "YYYY-MM-DD"
 * @param {string[]} [opts.symbols]
 * @returns {object} summary
 */
function buildLearningSummary({ start, end, symbols }) {
  const allOutcomes = loadOutcomes(start, end, null);
  const filtered    = symbols && symbols.length > 0
    ? allOutcomes.filter((o) => symbols.includes(o.symbol))
    : allOutcomes;

  if (filtered.length === 0) {
    console.warn('[SignalLearning] No outcomes found for the given range');
    return {};
  }

  const summary = {
    _meta: {
      builtAt:  new Date().toISOString(),
      start,
      end,
      totalOutcomes: filtered.length,
    },
  };

  // ── Global stats ──────────────────────────────────────────────────────────
  summary._global = {
    samples:          filtered.length,
    overallWinRate:   winRate(filtered),
    avgMove5:         avgNestedField(filtered, 5,  'priceChangePct'),
    avgMoveUp5:       avgNestedField(filtered, 5,  'maxMoveUp'),
    avgMoveDown5:     avgNestedField(filtered, 5,  'maxMoveDown'),
    avgMove10:        avgNestedField(filtered, 10, 'priceChangePct'),
    scoreRanges:      scoreRangeAnalysis(filtered),
    byEventType:      topByWinRate(groupBy(filtered, 'eventType')),
    commonFailures:   commonFailureReasons(filtered),
  };

  // ── Per-symbol stats ──────────────────────────────────────────────────────
  const bySymbol = groupBy(filtered, 'symbol');

  for (const [symbol, outcomes] of Object.entries(bySymbol)) {
    const byEventType  = groupBy(outcomes, 'eventType');
    const bySignal     = groupBy(outcomes, 'signal');

    const bestEvent = topByWinRate(byEventType, 2);

    summary[symbol] = {
      samples:         outcomes.length,
      winRate:         winRate(outcomes),
      avgMove5:        avgNestedField(outcomes, 5,  'priceChangePct'),
      avgMove10:       avgNestedField(outcomes, 10, 'priceChangePct'),
      avgMoveUp5:      avgNestedField(outcomes, 5,  'maxMoveUp'),
      avgMoveDown5:    avgNestedField(outcomes, 5,  'maxMoveDown'),
      bestEventType:   bestEvent.length > 0 ? bestEvent[0].key    : null,
      bestEventWinRate:bestEvent.length > 0 ? bestEvent[0].winRate : null,
      scoreRanges:     scoreRangeAnalysis(outcomes),
      bySignal:        topByWinRate(bySignal, 1),
      byEventType:     topByWinRate(byEventType, 1),
      avoidWhen:       deriveAvoidConditions(outcomes.filter((o) => o.success === false)),
      commonFailures:  commonFailureReasons(outcomes),
    };
  }

  return summary;
}

/**
 * Build and persist learning summary to disk.
 */
function saveLearning({ start, end, symbols }) {
  const summary = buildLearningSummary({ start, end, symbols });

  try {
    ensureDir(path.dirname(SUMMARY_PATH));
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
    console.log('[SignalLearning] Saved learning-summary.json');
  } catch (err) {
    console.warn('[SignalLearning] Failed to save summary:', err.message);
  }

  return summary;
}

/**
 * Load the most recent learning summary from disk.
 */
function loadLearning() {
  try {
    if (!fs.existsSync(SUMMARY_PATH)) return null;
    return JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
  } catch (err) {
    console.warn('[SignalLearning] loadLearning failed:', err.message);
    return null;
  }
}

module.exports = { buildLearningSummary, saveLearning, loadLearning };
