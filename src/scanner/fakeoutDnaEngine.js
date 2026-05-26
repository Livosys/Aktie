'use strict';
/**
 * Fakeout DNA Engine
 *
 * Learns what conditions precede fakeouts from historical outcomes.
 * Computes per-feature fakeout rates and applies a conservative score
 * penalty (max -6) when live signals match high-fakeout-risk patterns.
 *
 * Safety contract:
 *   Hard-blocked signals (TFS, BOC, autoFilter.blocked) → fakeoutAdjustment = 0.
 *   Max adjustment: ±6 points.
 *   Hard caps (TFS→10, BOC→20) re-applied after adjustment.
 */

const fs   = require('fs');
const path = require('path');

const SIGNALS_DIR  = path.resolve(__dirname, '../../data/signals/history');
const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const DNA_PATH     = path.resolve(__dirname, '../../data/signals/fakeout-dna.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

const GLOBAL_FAKEOUT_RATE_FALLBACK = 0.4927; // ≈ 1 − 0.5073

let _cache     = null;
let _cacheTime = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonlDir(dir) {
  if (!fs.existsSync(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); }
  catch { return []; }
  const records = [];
  for (const file of files) {
    try {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return records;
}

function round(n, d = 4) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function relVolBucket(v) {
  if (v == null) return null;
  if (v < 0.7)   return 'weak';
  if (v < 1.2)   return 'normal';
  return 'strong';
}

function rsiBucket(v) {
  if (v == null) return null;
  if (v < 35)    return 'oversold';
  if (v < 45)    return 'bearish';
  if (v <= 55)   return 'neutral';
  if (v <= 65)   return 'bullish';
  return 'overbought';
}

function priceToZoneBucket(v) {
  if (v == null) return null;
  if (v <= 0.5)  return 'in_zone';
  if (v <= 1.0)  return 'near_zone';
  return 'far_zone';
}

function narrowScoreBucket(v) {
  if (v == null)  return null;
  if (v >= 80)    return 'high';
  if (v >= 60)    return 'medium';
  if (v >= 40)    return 'low';
  return 'very_low';
}

// ── buildFakeoutDna ───────────────────────────────────────────────────────────

function buildFakeoutDna() {
  console.log('[FakeoutDNA] Building fakeout DNA from historical outcomes...');

  const allSignals  = readJsonlDir(SIGNALS_DIR);
  const signalIndex = new Map();
  for (const sig of allSignals) {
    if (sig.signalId) signalIndex.set(sig.signalId, sig);
  }

  const allOutcomes = readJsonlDir(OUTCOMES_DIR);

  const featureStats = {};

  function tally(name, value, isFakeout) {
    if (value == null || value === '' || value === 'UNKNOWN' || value === 'unknown') return;
    const key = `${name}::${value}`;
    if (!featureStats[key]) featureStats[key] = { feature: name, value: String(value), total: 0, fakeouts: 0 };
    featureStats[key].total++;
    if (isFakeout) featureStats[key].fakeouts++;
  }

  let totalDirected = 0;
  let totalFakeouts = 0;

  for (const outcome of allOutcomes) {
    if (outcome.success === null || outcome.success === undefined) continue;
    if (outcome.failureReason === 'insufficient_data' || outcome.failureReason === 'market_closed') continue;

    const isFakeout = outcome.success === false;
    totalDirected++;
    if (isFakeout) totalFakeouts++;

    // Features available directly in outcome record
    tally('marketRegime', outcome.marketRegime, isFakeout);
    tally('eventType',    outcome.eventType,    isFakeout);
    tally('signal',       outcome.signal,       isFakeout);
    tally('symbol',       outcome.symbol,       isFakeout);

    // Features from joined signal record
    const sig = outcome.signalId ? signalIndex.get(outcome.signalId) : null;
    if (sig) {
      tally('mtfAlignment',      sig.mtfAlignment,                     isFakeout);
      tally('relVolBucket',      relVolBucket(sig.relVol20),           isFakeout);
      tally('rsiBucket',         rsiBucket(sig.rsi14),                 isFakeout);
      tally('priceToZoneBucket', priceToZoneBucket(sig.priceToZoneAtr), isFakeout);
      tally('narrowType',        sig.narrowType,                       isFakeout);
      tally('state',             sig.state,                            isFakeout);
      tally('narrowScoreBucket', narrowScoreBucket(sig.narrowScore),   isFakeout);
      tally('elephantBar',       sig.elephantBar?.active ? 'active' : 'inactive', isFakeout);
    }
  }

  const globalFakeoutRate = totalDirected > 0
    ? totalFakeouts / totalDirected
    : GLOBAL_FAKEOUT_RATE_FALLBACK;

  const MIN_SAMPLES = 30;

  const features = Object.values(featureStats)
    .filter(f => f.total >= MIN_SAMPLES)
    .map(f => ({
      feature:     f.feature,
      value:       f.value,
      total:       f.total,
      fakeouts:    f.fakeouts,
      fakeoutRate: round(f.fakeouts / f.total),
      elevation:   round((f.fakeouts / f.total) - globalFakeoutRate),
    }))
    .sort((a, b) => b.elevation - a.elevation);

  // Build lookup keyed by feature::value for fast live matching
  const featureLookup = {};
  for (const f of features) {
    featureLookup[`${f.feature}::${f.value}`] = f;
  }

  const dna = {
    updatedAt:         new Date().toISOString(),
    totalDirected,
    totalFakeouts,
    globalFakeoutRate: round(globalFakeoutRate),
    minSamples:        MIN_SAMPLES,
    features,
    featureLookup,
  };

  fs.mkdirSync(path.dirname(DNA_PATH), { recursive: true });
  fs.writeFileSync(DNA_PATH, JSON.stringify(dna, null, 2), 'utf8');
  console.log(`[FakeoutDNA] Saved ${features.length} features, globalFakeoutRate=${round(globalFakeoutRate)}`);
  return { ok: true, features: features.length, globalFakeoutRate: round(globalFakeoutRate), totalDirected };
}

// ── loadFakeoutDna ────────────────────────────────────────────────────────────

function loadFakeoutDna() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(DNA_PATH)) { _cacheTime = now; return null; }
    _cache     = JSON.parse(fs.readFileSync(DNA_PATH, 'utf8'));
    _cacheTime = now;
    return _cache;
  } catch {
    return null;
  }
}

// ── applyFakeoutDna ───────────────────────────────────────────────────────────

// Per-feature weights: higher = more predictive of fakeout
const FEATURE_WEIGHTS = {
  mtfAlignment:      2.0,
  marketRegime:      1.5,
  relVolBucket:      1.5,
  eventType:         1.3,
  priceToZoneBucket: 1.2,
  rsiBucket:         1.0,
  narrowType:        1.0,
  state:             0.9,
  elephantBar:       0.8,
  narrowScoreBucket: 0.8,
  signal:            0.7,
  symbol:            0.5,
};

function applyFakeoutDna(result) {
  try {
    return _applyDna(result);
  } catch (err) {
    console.warn('[FakeoutDNA] apply error:', err.message);
    return { ...result, fakeoutDna: null };
  }
}

function _applyDna(result) {
  const dna = loadFakeoutDna();
  if (!dna || !dna.featureLookup) {
    return { ...result, fakeoutDna: null };
  }

  const globalRate = dna.globalFakeoutRate ?? GLOBAL_FAKEOUT_RATE_FALLBACK;

  // Extract live features from current result
  const liveFeatures = {
    mtfAlignment:      result.mtfAlignment,
    relVolBucket:      relVolBucket(result.relVol20),
    rsiBucket:         rsiBucket(result.rsi14),
    priceToZoneBucket: priceToZoneBucket(result.priceToZoneAtr),
    narrowType:        result.narrowType,
    state:             result.state,
    symbol:            result.symbol,
    marketRegime:      result.marketRegimeV2 || result.marketRegime,
    eventType:         result.eventType,
    elephantBar:       result.elephantBar?.active ? 'active' : 'inactive',
    narrowScoreBucket: narrowScoreBucket(result.narrowScore),
    signal:            result.signal,
  };

  let weightedElevation = 0;
  let totalWeight       = 0;
  const matchedFeatures = [];

  for (const [featureName, featureValue] of Object.entries(liveFeatures)) {
    if (featureValue == null) continue;
    const key   = `${featureName}::${featureValue}`;
    const entry = dna.featureLookup[key];
    if (!entry) continue;

    const weight = FEATURE_WEIGHTS[featureName] || 1.0;
    weightedElevation += entry.elevation * weight;
    totalWeight       += weight;

    if (Math.abs(entry.elevation) >= 0.025) {
      matchedFeatures.push({
        feature:     entry.feature,
        value:       entry.value,
        fakeoutRate: entry.fakeoutRate,
        elevation:   entry.elevation,
        samples:     entry.total,
      });
    }
  }

  const avgElevation = totalWeight > 0 ? weightedElevation / totalWeight : 0;

  // Map elevation to 0-100 score: elevation 0 → 50, ±0.20 → 90/10
  const rawScore = 50 + (avgElevation * 200);
  const fakeoutProbabilityScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  matchedFeatures.sort((a, b) => Math.abs(b.elevation) - Math.abs(a.elevation));

  let fakeoutRisk;
  if      (fakeoutProbabilityScore >= 70) fakeoutRisk = 'high';
  else if (fakeoutProbabilityScore >= 55) fakeoutRisk = 'elevated';
  else if (fakeoutProbabilityScore >= 45) fakeoutRisk = 'normal';
  else                                    fakeoutRisk = 'low';

  // ── Score adjustment (conservative, with hard-block safety) ──────────────
  const isHardBlocked =
    result.autoFilter?.blocked       === true ||
    result.threeFingerSpread?.active  === true ||
    result.breakoutAlreadyOccurred    === true;

  let fakeoutAdjustment = 0;
  if (!isHardBlocked) {
    if      (fakeoutProbabilityScore >= 72) fakeoutAdjustment = -6;
    else if (fakeoutProbabilityScore >= 62) fakeoutAdjustment = -4;
    else if (fakeoutProbabilityScore >= 55) fakeoutAdjustment = -2;
    else if (fakeoutProbabilityScore <= 30) fakeoutAdjustment = +3;
    else if (fakeoutProbabilityScore <= 38) fakeoutAdjustment = +1;
  }

  let newScore = Math.max(0, Math.min(100, (result.tradeScore ?? 0) + fakeoutAdjustment));

  // Re-apply hard caps
  if (result.threeFingerSpread?.active) newScore = Math.min(newScore, 10);
  if (result.breakoutAlreadyOccurred)   newScore = Math.min(newScore, 20);
  if (result.autoFilter?.blocked)       newScore = Math.min(newScore, 20);

  const newExpl = [...(result.scoreExplanationSv || [])];
  if (fakeoutAdjustment !== 0) {
    const msg = fakeoutAdjustment < 0
      ? `Fakeout DNA: hög fakeout-risk i historiken (${fakeoutAdjustment} pts).`
      : `Fakeout DNA: låg fakeout-risk i historiken (+${fakeoutAdjustment} pts).`;
    if (!newExpl.includes(msg)) newExpl.push(msg);
  }

  // ── Swedish explanation ───────────────────────────────────────────────────
  const topBad  = matchedFeatures.filter(f => f.elevation > 0.03).slice(0, 2);
  const topGood = matchedFeatures.filter(f => f.elevation < -0.03).slice(0, 1);
  let explanationSv;

  if (fakeoutProbabilityScore >= 70) {
    const reason = topBad.length > 0
      ? `Drivs av ${topBad[0].feature}=${topBad[0].value} (${Math.round(topBad[0].fakeoutRate * 100)}% fakeouts).`
      : '';
    explanationSv = `Hög fakeout-risk (${fakeoutProbabilityScore}/100). ${reason}`.trim();
  } else if (fakeoutProbabilityScore >= 55) {
    explanationSv = `Förhöjd fakeout-risk (${fakeoutProbabilityScore}/100). Var försiktig med aggressiv entry.`;
  } else if (fakeoutProbabilityScore <= 35) {
    explanationSv = `Låg fakeout-risk (${fakeoutProbabilityScore}/100). Liknande setups har låg fakeout-historia.`;
  } else {
    explanationSv = `Normal fakeout-risk (${fakeoutProbabilityScore}/100). Historiken ger ingen tydlig varning.`;
  }

  return {
    ...result,
    tradeScore:         newScore,
    signalScore:        newScore,
    scoreExplanationSv: newExpl,
    fakeoutDna: {
      fakeoutProbabilityScore,
      fakeoutRisk,
      fakeoutAdjustment,
      matchedFeatures:   matchedFeatures.slice(0, 5),
      globalFakeoutRate: globalRate,
      explanationSv,
    },
  };
}

module.exports = { buildFakeoutDna, loadFakeoutDna, applyFakeoutDna };
