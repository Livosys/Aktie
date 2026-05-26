'use strict';
/**
 * Historical Edge Engine
 *
 * Loads historical outcomes + signals, groups them by similarity,
 * and provides edge stats that can adjust live trade scores.
 *
 * Similarity hierarchy (most specific → broadest):
 *   full:   symbol + eventType + state + narrowType + scoreRange + direction
 *   mid:    symbol + eventType + direction
 *   broad:  eventType + scoreRange + direction   (cross-symbol)
 *   global: direction
 *
 * Score ranges: 0-30 | 31-50 | 51-70 | 71-100
 * Direction:    long | short | neutral
 * Confidence:   low (<10 samples) | medium (10-29) | high (30+)
 * Adjustment:   low→0, medium→max±5, high→max±10 (capped 0-100 on apply)
 */

const { loadOutcomes } = require('./signalOutcomeAnalyzer');
const { loadSignals }  = require('./historicalScanner');

const CACHE_TTL_MS   = 5 * 60 * 1000; // refresh every 5 min
const LOOKBACK_DAYS  = 90;             // scan 90 days back for edge data
const MIN_MATCH      = 5;              // minimum outcomes to consider a key valid

let _cache      = null;
let _cacheBuiltAt = 0;

// ── Utility ───────────────────────────────────────────────────────────────────

function round(n, d) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function scoreRange(score) {
  if (score === null || score === undefined) return 'unknown';
  const s = Number(score);
  if (s <= 30) return '0-30';
  if (s <= 50) return '31-50';
  if (s <= 70) return '51-70';
  return '71-100';
}

function direction(signal) {
  if (!signal) return 'neutral';
  const s = String(signal);
  if (s.includes('LONG') || s === 'WIDE_REVERSAL_WATCH') return 'long';
  if (s.includes('SHORT')) return 'short';
  return 'neutral';
}

function makeKeys(sym, et, st, nt, sr, dir) {
  return [
    `${sym}::${et}::${st}::${nt}::${sr}::${dir}`, // full
    `${sym}::${et}::${dir}`,                       // mid
    `${et}::${sr}::${dir}`,                        // broad
    dir,                                            // global
  ];
}

// ── Index builder ─────────────────────────────────────────────────────────────

function buildIndex(outcomes, signalMap) {
  const index = {};

  for (const o of outcomes) {
    const sig = signalMap.get(o.signalId) || {};
    const dir = direction(o.signal);
    const sr  = scoreRange(o.tradeScore);
    const et  = o.eventType  || sig.eventType  || 'unknown';
    const st  = o.state      || sig.state      || 'unknown';
    const nt  = o.narrowType || sig.narrowType || 'none';
    const sym = o.symbol;

    for (const key of makeKeys(sym, et, st, nt, sr, dir)) {
      if (!index[key]) index[key] = [];
      index[key].push(o);
    }
  }

  return index;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function calcEdgeStats(outcomes) {
  if (!outcomes || outcomes.length === 0) return null;

  const withResult = outcomes.filter((o) => o.success !== null);
  const wins       = withResult.filter((o) => o.success === true);
  const wr         = withResult.length > 0 ? wins.length / withResult.length : null;

  function avgN(n, field) {
    const key  = `outcome${n}`;
    const vals = outcomes
      .map((o) => o[key]?.[field])
      .filter((v) => v != null && !isNaN(v));
    if (vals.length === 0) return null;
    return round(vals.reduce((a, b) => a + b, 0) / vals.length, 4);
  }

  const horizons = [3, 5, 10, 20, 30].filter((n) =>
    outcomes.some((o) => o[`outcome${n}`] != null)
  );

  return {
    samples:      outcomes.length,
    withResult:   withResult.length,
    winRate:      wr !== null ? round(wr, 4) : null,
    avgMove5:     avgN(5,  'priceChangePct'),
    avgMove10:    avgN(10, 'priceChangePct'),
    avgMove20:    avgN(20, 'priceChangePct'),
    avgMoveUp5:   avgN(5,  'maxMoveUp'),
    avgMoveDown5: avgN(5,  'maxMoveDown'),
    bestHorizon:  horizons.length > 0 ? `${horizons[horizons.length - 1]}` : null,
  };
}

function calcConfidenceAndAdjustment(stats) {
  const { samples, winRate } = stats;

  if (samples < 10 || winRate === null) {
    return { confidence: 'low', adjustment: 0 };
  }

  const maxAdj = samples >= 30 ? 10 : 5;

  let adj;
  if (winRate >= 0.65) adj = maxAdj;
  else if (winRate >= 0.60) adj = Math.round(maxAdj * 0.7);
  else if (winRate >= 0.55) adj = Math.round(maxAdj * 0.4);
  else if (winRate >= 0.50) adj = Math.round(maxAdj * 0.1);
  else if (winRate >= 0.45) adj = -Math.round(maxAdj * 0.2);
  else if (winRate >= 0.40) adj = -Math.round(maxAdj * 0.5);
  else adj = -maxAdj;

  return {
    confidence: samples >= 30 ? 'high' : 'medium',
    adjustment: adj,
  };
}

function buildSummarySv(stats, conf) {
  const { samples, winRate } = stats;
  const { confidence, adjustment } = conf;
  const wrPct = winRate !== null ? Math.round(winRate * 100) : null;

  if (confidence === 'low') {
    return samples > 0
      ? `Historiken är för liten för säker slutsats (${samples} signaler).`
      : 'Historiken är för liten för säker slutsats (0 signaler).';
  }

  const parts = [];

  if (wrPct >= 60) {
    parts.push(`Liknande signaler har fungerat bra tidigare (${wrPct}% träff).`);
  } else if (wrPct >= 50) {
    parts.push(`Liknande signaler har haft okej träffsäkerhet (${wrPct}%).`);
  } else if (wrPct >= 40) {
    parts.push(`Liknande signaler har ofta varit svaga tidigare (${wrPct}% träff).`);
  } else {
    parts.push(`Liknande signaler har ofta misslyckats (${wrPct}% träff).`);
  }

  if (adjustment > 0) parts.push(`Historiken höjer betyget med ${adjustment} poäng.`);
  else if (adjustment < 0) parts.push(`Historiken sänker betyget med ${Math.abs(adjustment)} poäng.`);

  parts.push(`Baserat på ${samples} liknande signaler.`);

  return parts.join(' ');
}

// ── Cache ─────────────────────────────────────────────────────────────────────

function isStale() {
  return !_cache || (Date.now() - _cacheBuiltAt) > CACHE_TTL_MS;
}

function buildCache() {
  const end   = new Date().toISOString().slice(0, 10);
  const d     = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const start = d.toISOString().slice(0, 10);

  try {
    const outcomes  = loadOutcomes(start, end, null);
    const signals   = loadSignals(start, end, null);
    const signalMap = new Map(signals.map((s) => [s.signalId, s]));
    const index     = buildIndex(outcomes, signalMap);
    const symbols   = [...new Set(outcomes.map((o) => o.symbol))];

    _cache = { index, signalMap, outcomes, symbols, start, end };
    _cacheBuiltAt = Date.now();

    if (outcomes.length > 0) {
      console.log(
        `[HistoricalEdge] Cache built — ${outcomes.length} outcomes, ${signals.length} signals (${start} → ${end})`
      );
    }
  } catch (err) {
    console.warn('[HistoricalEdge] Cache build failed:', err.message);
    _cache = { index: {}, signalMap: new Map(), outcomes: [], symbols: [], start, end };
    _cacheBuiltAt = Date.now();
  }
}

function ensureCache() {
  if (isStale()) buildCache();
}

// ── Fallback ──────────────────────────────────────────────────────────────────

function fallbackEdge(reason) {
  return {
    sampleSize:   0,
    winRate:      null,
    avgMove5:     null,
    avgMove10:    null,
    avgMove20:    null,
    avgMoveUp5:   null,
    avgMoveDown5: null,
    bestHorizon:  null,
    confidence:   'low',
    adjustment:   0,
    matchLevel:   null,
    summarySv:    'Historiken är för liten för säker slutsats (0 signaler).',
    _reason:      reason,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get historical edge stats for a live scanner result.
 */
function getEdge(liveResult) {
  ensureCache();
  if (!_cache) return fallbackEdge('no_cache');

  const { signal, eventType, state, narrowType, tradeScore, symbol } = liveResult || {};
  const dir = direction(signal);
  const sr  = scoreRange(tradeScore);
  const et  = eventType  || 'unknown';
  const st  = state      || 'unknown';
  const nt  = narrowType || 'none';
  const sym = symbol;

  const keys = makeKeys(sym, et, st, nt, sr, dir);
  const levelLabels = ['full', 'mid', 'broad', 'global'];

  let matchedOutcomes = null;
  let matchLevel      = null;

  for (let i = 0; i < keys.length; i++) {
    const bucket = _cache.index[keys[i]];
    if (bucket && bucket.length >= MIN_MATCH) {
      matchedOutcomes = bucket;
      matchLevel      = levelLabels[i];
      break;
    }
  }

  if (!matchedOutcomes) return fallbackEdge('no_match');

  const stats = calcEdgeStats(matchedOutcomes);
  if (!stats) return fallbackEdge('no_stats');

  const conf = calcConfidenceAndAdjustment(stats);

  return {
    sampleSize:   stats.samples,
    winRate:      stats.winRate,
    avgMove5:     stats.avgMove5,
    avgMove10:    stats.avgMove10,
    avgMove20:    stats.avgMove20,
    avgMoveUp5:   stats.avgMoveUp5,
    avgMoveDown5: stats.avgMoveDown5,
    bestHorizon:  stats.bestHorizon,
    confidence:   conf.confidence,
    adjustment:   conf.adjustment,
    matchLevel,
    summarySv:    buildSummarySv(stats, conf),
  };
}

/**
 * Apply historical edge to a live result.
 * - Adds historicalEdge, tradeScoreBeforeHistoricalEdge, tradeScoreAfterHistoricalEdge
 * - Adjusts tradeScore (and signalScore) if confidence is not 'low'
 * - Enriches scoreExplanationSv with a history line
 */
function applyHistoricalEdge(result) {
  const edge   = getEdge(result);
  const before = result.tradeScore ?? 0;

  let after = before;
  if (edge.confidence !== 'low' && edge.adjustment !== 0) {
    after = Math.max(0, Math.min(100, before + edge.adjustment));
  }

  const explanation = [...(result.scoreExplanationSv || [])];

  if (edge.confidence !== 'low') {
    explanation.push(edge.summarySv);
  } else if (edge.sampleSize > 0) {
    explanation.push('Historiken är för liten för säker slutsats.');
  }

  return {
    ...result,
    tradeScoreBeforeHistoricalEdge: before,
    tradeScore:                     after,
    tradeScoreAfterHistoricalEdge:  after,
    signalScore:                    after,
    historicalEdge:                 edge,
    scoreExplanationSv:             explanation,
  };
}

/**
 * Get edge breakdown for one symbol (all outcome groups).
 */
function getEdgeForSymbol(symbol) {
  ensureCache();
  if (!_cache) return { symbol, outcomeCount: 0, stats: null };

  const outcomes = _cache.outcomes.filter((o) => o.symbol === symbol);
  const stats    = calcEdgeStats(outcomes);
  const conf     = stats ? calcConfidenceAndAdjustment(stats) : null;

  return {
    symbol,
    outcomeCount: outcomes.length,
    stats,
    confidence: conf?.confidence ?? 'low',
    adjustment: conf?.adjustment ?? 0,
  };
}

/**
 * Full edge summary across all symbols.
 */
function getEdgeSummary() {
  ensureCache();
  if (!_cache) return { ok: false, symbols: [] };

  const perSymbol = _cache.symbols.map((sym) => getEdgeForSymbol(sym));

  return {
    ok:       true,
    builtAt:  new Date(_cacheBuiltAt).toISOString(),
    lookback: { start: _cache.start, end: _cache.end },
    total:    _cache.outcomes.length,
    signals:  _cache.signalMap.size,
    symbols:  perSymbol,
  };
}

/**
 * Force cache refresh — call after running hunt-signals + analyze.
 */
function invalidateCache() {
  _cacheBuiltAt = 0;
  _cache        = null;
  console.log('[HistoricalEdge] Cache invalidated');
}

module.exports = {
  getEdge,
  applyHistoricalEdge,
  getEdgeForSymbol,
  getEdgeSummary,
  invalidateCache,
};
