'use strict';

/**
 * Micro Move Engine — separate analysis layer (never modifies tradeScore).
 *
 * Reads micro-move-analysis.json (built by microMoveAnalyzer) and classifies
 * live signals as MICRO_MOVE_READY when:
 *   - tradeScore is in [15, 38] (weak/borderline blocked)
 *   - No Three Finger Spread active
 *   - eventType has historically hit +0.25% at high rates even when blocked
 */

const fs   = require('fs');
const path = require('path');

const ANALYSIS_PATH = path.resolve(__dirname, '../../data/signals/micro-move-analysis.json');
const CACHE_TTL_MS  = 30 * 60 * 1000; // reload every 30 min

let _cache     = null;
let _cacheTime = 0;

function loadAnalysis() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(ANALYSIS_PATH)) { _cache = null; _cacheTime = now; return null; }
    _cache     = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
    _cacheTime = now;
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}

function round(n, d = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const f = 10 ** d;
  return Math.round(Number(n) * f) / f;
}

/**
 * Compute a fast scalp score 0-100 for a live signal based on backtest data.
 */
function calcFastScalpScore(hit025Rate, hit050Rate, avgTime025) {
  if (hit025Rate === null) return 0;
  let score = Math.round(hit025Rate * 60); // max 60 points
  score += Math.round((hit050Rate ?? 0) * 20); // max 20 points
  // Time bonus: faster = better (within 10 min = max bonus, 30 min = 0)
  if (avgTime025 !== null) {
    const timeBonus = Math.max(0, Math.round((30 - avgTime025) / 30 * 20));
    score += timeBonus;
  }
  return Math.min(100, Math.max(0, score));
}

/**
 * Apply Micro Move Engine enrichment to a single scan result.
 * Adds `result.microMove` — never touches tradeScore or existing fields.
 */
function applyMicroMove(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[MicroMoveEngine] error:', err.message);
    return { ...result, microMove: null };
  }
}

function _apply(result) {
  const analysis = loadAnalysis();
  const score    = result.tradeScore ?? 0;
  const tfs      = result.threeFingerSpread?.active === true || result.threeFingerSpreadActive === true;
  const evt      = result.eventType || null;

  if (!analysis || !evt) {
    return { ...result, microMove: null };
  }

  const criteria   = analysis.microMoveReadyCriteria || {};
  const minScore   = criteria.scoreRange?.[0] ?? 15;
  const maxScore   = criteria.scoreRange?.[1] ?? 38;
  const minHit025  = criteria.minHit025Rate   ?? 0.40;

  // Look up eventType stats from backtest
  const evtStats = (analysis.byEventType || []).find((e) => e.eventType === evt) || null;
  const hit025Rate = evtStats?.blockedHit025Rate ?? null;
  const hit050Rate = evtStats?.blockedHit050Rate ?? null;
  const avgTime025 = evtStats?.blockedAvgTime025 ?? null;

  // Classify
  const inScoreRange = score >= minScore && score <= maxScore;
  const hasEdge      = hit025Rate !== null && hit025Rate >= minHit025;
  const isMicroReady = inScoreRange && !tfs && hasEdge;

  const fastScalpScore = calcFastScalpScore(hit025Rate, hit050Rate, avgTime025);

  let readyReason = null;
  if (isMicroReady) {
    readyReason = `${evt} når +0.25% i ${Math.round((hit025Rate ?? 0) * 100)}% av fallen. Score ${score} → liten snabb rörelse möjlig.`;
  } else if (tfs) {
    readyReason = 'TFS aktiv — för utsträckt även för micro-move.';
  } else if (!inScoreRange && score > maxScore) {
    readyReason = null; // normal signal, no micro note needed
  } else if (hit025Rate !== null && hit025Rate < minHit025) {
    readyReason = `${evt} når +0.25% i bara ${Math.round((hit025Rate ?? 0) * 100)}% av fallen — ej tillräcklig edge.`;
  }

  return {
    ...result,
    microMove: {
      signal:         isMicroReady ? 'MICRO_MOVE_READY' : null,
      ready:          isMicroReady,
      readyReason,
      hit025Rate:     round(hit025Rate, 4),
      hit050Rate:     round(hit050Rate, 4),
      avgMin025:      avgTime025,
      fastScalpScore,
      scoreInRange:   inScoreRange,
      noTFS:          !tfs,
    },
  };
}

module.exports = { applyMicroMove };
