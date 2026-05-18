'use strict';
const fs   = require('fs');
const path = require('path');

const SUMMARY_PATH = path.resolve(__dirname, '../../data/signals/learning-summary.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache     = null;
let _cacheTime = 0;

// ── Summary cache ─────────────────────────────────────────────────────────────

function loadSummary() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(SUMMARY_PATH)) { _cache = null; _cacheTime = now; return null; }
    _cache     = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
    _cacheTime = now;
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}

// ── Bucket helpers ────────────────────────────────────────────────────────────

function scoreRangeKey(score) {
  if (score <= 30) return '0-30';
  if (score <= 50) return '31-50';
  if (score <= 70) return '51-70';
  return '71-100';
}

function relVolBucket(relVol20) {
  if (relVol20 === null || relVol20 === undefined) return null;
  if (relVol20 < 0.7)  return 'weak_volume';
  if (relVol20 < 1.2)  return 'normal_volume';
  return 'strong_volume';
}

function priceToZoneBucket(priceToZoneAtr) {
  if (priceToZoneAtr === null || priceToZoneAtr === undefined) return null;
  if (priceToZoneAtr <= 0.5) return 'in_zone';
  if (priceToZoneAtr <= 1.0) return 'near_zone';
  return 'far_zone';
}

function rsiBucket(rsi14) {
  if (rsi14 === null || rsi14 === undefined) return null;
  if (rsi14 < 45)  return 'weak';
  if (rsi14 <= 55) return 'neutral';
  return 'strong';
}

// ── Confidence tier ───────────────────────────────────────────────────────────

function getConfidenceLevel(totalSamples) {
  if (totalSamples < 20)  return 'low';
  if (totalSamples < 100) return 'medium';
  return 'high';
}

function getMaxAdjustment(level) {
  if (level === 'low')    return 0;
  if (level === 'medium') return 5;
  return 10;
}

// ── Lookups ───────────────────────────────────────────────────────────────────

function buildLookups(summary) {
  if (!summary) return null;

  const overallWR   = summary.overallWinRate || 0.51;
  const worstThresh = overallWR - 0.02;
  const MIN_SAMPLES = 20;

  function deriveWorst(byObj) {
    return new Set(
      Object.entries(byObj || {})
        .filter(([, v]) => v.winRate !== null && v.winRate !== undefined && v.winRate < worstThresh && (v.samples || 0) >= MIN_SAMPLES)
        .map(([k]) => k)
    );
  }

  return {
    totalSamples:         summary.totalSignals || 0,
    bestSymbolKeys:       new Set((summary.bestSymbols       || []).map(e => e.key)),
    bestEventTypeKeys:    new Set((summary.bestEventTypes    || []).map(e => e.key)),
    bestMarketRegimeKeys: new Set((summary.bestMarketRegimes || []).map(e => e.key)),
    bestScoreRangeKeys:   new Set((summary.bestScoreRanges   || []).map(e => e.key)),
    bestHourKeys:         new Set((summary.bestHours         || []).map(e => e.key)),
    worstMarketRegimeKeys: deriveWorst(summary.byMarketRegime),
    worstEventTypeKeys:    deriveWorst(summary.byEventType),
    worstScoreRangeKeys:   deriveWorst(summary.byScoreRange),
    worstHourKeys:         deriveWorst(summary.byHour),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function round(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function _disabledEdge(summarySv) {
  return {
    enabled:         false,
    sampleSize:      0,
    confidence:      'low',
    edgeScore:       null,
    adjustment:      0,
    finalScore:      null,
    matchedFactors:  {},
    positiveFactors: [],
    negativeFactors: [],
    summarySv,
  };
}

// ── Core logic ────────────────────────────────────────────────────────────────

function _apply(result) {
  const summary = loadSummary();

  if (!summary) {
    return {
      ...result,
      tradeScoreBeforeAdaptive: result.tradeScore ?? null,
      adaptiveEdge: _disabledEdge('För lite historik ännu.'),
    };
  }

  const lookups        = buildLookups(summary);
  const totalSamples   = lookups.totalSamples;
  const confidence     = getConfidenceLevel(totalSamples);
  const maxAdj         = getMaxAdjustment(confidence);

  const {
    symbol, marketRegimeV2, eventType, relVol20, priceToZoneAtr, rsi14,
    threeFingerSpread, breakoutAlreadyOccurred, autoFilter,
  } = result;

  const baseScore  = result.tradeScore ?? 0;
  const tfsActive  = threeFingerSpread?.active === true;
  const currentHour = String(new Date().getUTCHours());
  const srKey      = scoreRangeKey(baseScore);

  // ── matchedFactors ────────────────────────────────────────────────────────
  const matchedFactors = {
    symbol:            symbol           || null,
    narrowType:        result.narrowType || null,
    state:             result.state      || null,
    eventType:         eventType         || null,
    marketRegime:      marketRegimeV2    || null,
    scoreRange:        srKey,
    hour:              currentHour,
    relVolBucket:      relVolBucket(relVol20),
    priceToZoneBucket: priceToZoneBucket(priceToZoneAtr),
    rsiBucket:         rsiBucket(rsi14),
  };

  // ── Positive factors ──────────────────────────────────────────────────────
  const positiveFactors = [];

  if (symbol && lookups.bestSymbolKeys.has(symbol)) {
    positiveFactors.push({ factor: 'symbol', labelSv: `${symbol} presterar historiskt bra.` });
  }
  if (eventType && lookups.bestEventTypeKeys.has(eventType)) {
    positiveFactors.push({ factor: 'eventType', labelSv: `${eventType}-lägen har god träffsäkerhet.` });
  }
  if (marketRegimeV2 && lookups.bestMarketRegimeKeys.has(marketRegimeV2)) {
    positiveFactors.push({ factor: 'marketRegime', labelSv: `Marknadsläget (${marketRegimeV2}) stödjer historiskt bra resultat.` });
  }
  if (lookups.bestScoreRangeKeys.has(srKey)) {
    positiveFactors.push({ factor: 'scoreRange', labelSv: `Score-intervallet ${srKey} fungerar bra historiskt.` });
  }
  if (lookups.bestHourKeys.has(currentHour)) {
    positiveFactors.push({ factor: 'hour', labelSv: `Timme ${currentHour} UTC är historiskt stark.` });
  }
  if (relVol20 !== null && relVol20 !== undefined && relVol20 >= 1.0) {
    positiveFactors.push({ factor: 'relVolBucket', labelSv: `Volymen är god (${round(relVol20)}x snitt).` });
  }
  if (priceToZoneAtr !== null && priceToZoneAtr !== undefined && priceToZoneAtr <= 0.5) {
    positiveFactors.push({ factor: 'priceToZoneBucket', labelSv: 'Priset är nära zonen.' });
  }

  // ── Negative factors ──────────────────────────────────────────────────────
  const negativeFactors = [];

  if (marketRegimeV2 && lookups.worstMarketRegimeKeys.has(marketRegimeV2)) {
    negativeFactors.push({ factor: 'marketRegime', labelSv: `Marknadsläget (${marketRegimeV2}) är historiskt svagt.` });
  }
  if (eventType && lookups.worstEventTypeKeys.has(eventType)) {
    negativeFactors.push({ factor: 'eventType', labelSv: `${eventType}-lägen presterar svagt historiskt.` });
  }
  if (lookups.worstScoreRangeKeys.has(srKey)) {
    negativeFactors.push({ factor: 'scoreRange', labelSv: `Score-intervallet ${srKey} är historiskt svagt.` });
  }
  if (lookups.worstHourKeys.has(currentHour)) {
    negativeFactors.push({ factor: 'hour', labelSv: `Timme ${currentHour} UTC är historiskt svag.` });
  }
  if (relVol20 !== null && relVol20 !== undefined && relVol20 < 0.7) {
    negativeFactors.push({ factor: 'relVolBucket', labelSv: `Volymen är svag (${round(relVol20)}x snitt).` });
  }
  if (priceToZoneAtr !== null && priceToZoneAtr !== undefined && priceToZoneAtr > 1.5) {
    negativeFactors.push({ factor: 'priceToZoneBucket', labelSv: 'Priset är för långt från zonen.' });
  }
  if (tfsActive) {
    negativeFactors.push({ factor: 'threeFingerSpread', labelSv: 'Three Finger Spread aktiv — priset är för utsträckt.' });
  }
  if (breakoutAlreadyOccurred) {
    negativeFactors.push({ factor: 'breakoutAlreadyOccurred', labelSv: 'Rörelsen har redan börjat.' });
  }

  // ── Edge score & adjustment ───────────────────────────────────────────────
  const posCount     = positiveFactors.length;
  const negCount     = negativeFactors.length;
  const totalFactors = posCount + negCount;

  // edgeScore 0-100, 50 = neutral
  const edgeScore = totalFactors === 0
    ? 50
    : Math.round(50 + ((posCount - negCount) / totalFactors) * 50);

  const rawRatio  = totalFactors === 0 ? 0 : (posCount - negCount) / totalFactors;
  const rawAdj    = Math.round(rawRatio * maxAdj);
  const adjustment = confidence === 'low' ? 0 : clamp(rawAdj, -maxAdj, maxAdj);

  let finalScore = clamp(baseScore + adjustment, 0, 100);

  // ── Hard caps (re-apply after adjustment) ─────────────────────────────────
  if (autoFilter?.blocked === true) finalScore = Math.min(finalScore, 20);
  if (tfsActive)                    finalScore = Math.min(finalScore, 10);
  if (breakoutAlreadyOccurred)      finalScore = Math.min(finalScore, 20);

  // ── Swedish summary ───────────────────────────────────────────────────────
  let summarySv;
  if (confidence === 'low') {
    summarySv = 'För lite historik för adaptiv justering.';
  } else if (adjustment > 0) {
    const hasVolOrRegime = positiveFactors.some(f => f.factor === 'relVolBucket' || f.factor === 'marketRegime');
    summarySv = hasVolOrRegime
      ? 'Volymen och marknadsläget matchar tidigare vinnande setups.'
      : 'Adaptive Edge höjer betyget eftersom historiken stödjer flera faktorer.';
  } else if (adjustment < 0) {
    summarySv = 'Adaptive Edge sänker betyget eftersom liknande lägen ofta varit svaga.';
  } else {
    summarySv = 'Historiken ger ingen tydlig fördel eller nackdel för detta läge.';
  }

  // ── scoreExplanationSv ────────────────────────────────────────────────────
  const existing = result.scoreExplanationSv || [];
  const newExpl  = [...existing];

  let explMsg = null;
  if (confidence === 'low') {
    explMsg = 'För lite historik för adaptiv justering.';
  } else if (adjustment > 0) {
    const hasVolOrRegime = positiveFactors.some(f => f.factor === 'relVolBucket' || f.factor === 'marketRegime');
    explMsg = hasVolOrRegime
      ? 'Volymen och marknadsläget matchar tidigare vinnande setups.'
      : 'Adaptive Edge höjer betyget eftersom historiken stödjer flera faktorer.';
  } else if (adjustment < 0) {
    explMsg = 'Adaptive Edge sänker betyget eftersom liknande lägen ofta varit svaga.';
  }
  if (explMsg && !newExpl.includes(explMsg)) newExpl.push(explMsg);

  return {
    ...result,
    tradeScoreBeforeAdaptive: baseScore,
    tradeScore:         finalScore,
    signalScore:        finalScore,
    scoreExplanationSv: newExpl,
    adaptiveEdge: {
      enabled:         true,
      sampleSize:      totalSamples,
      confidence,
      edgeScore,
      adjustment,
      finalScore,
      matchedFactors,
      positiveFactors,
      negativeFactors,
      summarySv,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply Adaptive Edge Engine to a live scan result (after Confidence Engine).
 *
 * Reads learning-summary.json (cached 5 min) and computes:
 *   result.tradeScoreBeforeAdaptive — tradeScore before this step
 *   result.tradeScore               — updated with adaptive adjustment
 *   result.adaptiveEdge             — full adaptive metadata
 *
 * Safe: never throws.
 */
function applyAdaptiveEdge(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[AdaptiveEdge] error:', err.message);
    return {
      ...result,
      tradeScoreBeforeAdaptive: result.tradeScore ?? null,
      adaptiveEdge: _disabledEdge('Fel i Adaptive Edge-beräkning.'),
    };
  }
}

module.exports = { applyAdaptiveEdge };
