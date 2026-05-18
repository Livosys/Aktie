'use strict';
const fs   = require('fs');
const path = require('path');

const SUMMARY_PATH = path.resolve(__dirname, '../../data/signals/learning-summary.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // reload every 5 minutes

let _cache     = null;
let _cacheTime = 0;

// ── Learning summary cache ────────────────────────────────────────────────────

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

function buildLookups(summary) {
  if (!summary) return null;
  return {
    regimes:    new Map((summary.bestMarketRegimes || []).map(e => [e.key, e])),
    symbols:    new Map((summary.bestSymbols       || []).map(e => [e.key, e])),
    eventTypes: new Map((summary.bestEventTypes    || []).map(e => [e.key, e])),
    scoreRanges:new Map((summary.bestScoreRanges   || []).map(e => [e.key, e])),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(n, d = 1) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function scoreRangeKey(score) {
  if (score <= 30) return '0-30';
  if (score <= 50) return '31-50';
  if (score <= 70) return '51-70';
  return '71-100';
}

// Returns boost amount based on win rate, scaled to maxBoost.
function lookupBoost(entry, maxBoost) {
  if (!entry || entry.winRate === null) return 0;
  const wr = entry.winRate;
  if (wr >= 0.56) return maxBoost;
  if (wr >= 0.53) return Math.round(maxBoost * 0.65);
  if (wr >= 0.51) return Math.round(maxBoost * 0.35);
  return 0;
}

const REGIME_SV = {
  BULLISH_TREND:  'Stark upptrend',
  BEARISH_TREND:  'Stark nedtrend',
  CHOPPY:         'Stökig marknad',
  RANGE_DAY:      'Sidledsdag',
  TREND_DAY_UP:   'Trenddag uppåt',
  TREND_DAY_DOWN: 'Trenddag nedåt',
  HIGH_VOLATILITY:'Hög volatilitet',
  PANIC:          'Panikmarknad',
  UNKNOWN:        'Okänt läge',
};

function regimeSv(r) { return REGIME_SV[r] || r || 'Okänt'; }

// ── Label ─────────────────────────────────────────────────────────────────────

function calcLabel(finalScore, forceBlocked) {
  if (forceBlocked) return 'Blockerad';
  if (finalScore >= 70) return 'Mycket stark';
  if (finalScore >= 55) return 'Stark';
  if (finalScore >= 40) return 'Bevaka';
  if (finalScore >= 25) return 'Svag';
  return 'Blockerad';
}

// ── Boosters ──────────────────────────────────────────────────────────────────

function calcBoosters(result, lookups, baseScore) {
  const boosters = [];
  if (!lookups) return boosters;

  const { symbol, marketRegimeV2, eventType, relVol20, priceToZoneAtr } = result;

  // 1. Market regime
  const regimeEntry = lookups.regimes.get(marketRegimeV2);
  const regimeBoost = lookupBoost(regimeEntry, 10);
  if (regimeBoost > 0) {
    boosters.push({
      reason:   'marketRegime',
      labelSv:  `${regimeSv(marketRegimeV2)} har historiskt bra träffsäkerhet (${(regimeEntry.winRate * 100).toFixed(0)}%).`,
      amount:   regimeBoost,
    });
  }

  // 2. Symbol
  const symEntry  = lookups.symbols.get(symbol);
  const symBoost  = lookupBoost(symEntry, 8);
  if (symBoost > 0) {
    boosters.push({
      reason:   'symbol',
      labelSv:  `${symbol} presterar bra historiskt (${(symEntry.winRate * 100).toFixed(0)}% win rate).`,
      amount:   symBoost,
    });
  }

  // 3. Event type
  const evtEntry  = lookups.eventTypes.get(eventType);
  const evtBoost  = lookupBoost(evtEntry, 8);
  if (evtBoost > 0) {
    boosters.push({
      reason:  'eventType',
      labelSv: `${eventType}-lägen fungerar bra historiskt (${(evtEntry.winRate * 100).toFixed(0)}%).`,
      amount:  evtBoost,
    });
  }

  // 4. Score range
  const rangeKey   = scoreRangeKey(baseScore);
  const rangeEntry = lookups.scoreRanges.get(rangeKey);
  const rangeBoost = lookupBoost(rangeEntry, 8);
  if (rangeBoost > 0) {
    boosters.push({
      reason:  'scoreRange',
      labelSv: `Score ${rangeKey} har historiskt ${(rangeEntry.winRate * 100).toFixed(0)}% träffsäkerhet.`,
      amount:  rangeBoost,
    });
  }

  // 5. Strong volume
  if (relVol20 !== null && relVol20 >= 1.0) {
    boosters.push({
      reason:  'strongVolume',
      labelSv: `Volymen är god (${round(relVol20)}x snitt).`,
      amount:  5,
    });
  }

  // 6. Price near zone
  if (priceToZoneAtr !== null && priceToZoneAtr <= 0.5) {
    boosters.push({
      reason:  'nearZone',
      labelSv: 'Priset är nära rätt zon.',
      amount:  5,
    });
  }

  return boosters;
}

// ── Blockers / Penalties ──────────────────────────────────────────────────────

function calcBlockers(result, baseScore) {
  const blockers = [];
  const { marketRegimeV2, relVol20, priceToZoneAtr, threeFingerSpread, breakoutAlreadyOccurred } = result;
  const tfsActive = threeFingerSpread?.active === true;

  // 1. Weak volume
  if (relVol20 !== null && relVol20 < 0.7) {
    blockers.push({ reason: 'weakVolume',       labelSv: 'Volymen är för svag.',                          amount: -15,  hardCap: null });
  }

  // 2. High volatility
  if (marketRegimeV2 === 'HIGH_VOLATILITY') {
    blockers.push({ reason: 'highVolatility',   labelSv: 'Marknaden är för skakig.',                      amount: -20,  hardCap: null });
  }

  // 3. Price too far from zone
  if (priceToZoneAtr !== null && priceToZoneAtr > 1.5) {
    blockers.push({ reason: 'farFromZone',      labelSv: 'Priset är för långt från rätt zon.',            amount: -20,  hardCap: null });
  }

  // 4. Three Finger Spread → hard cap 10
  if (tfsActive) {
    blockers.push({ reason: 'threeFingerSpread',labelSv: 'Priset är för långt ifrån. Jaga inte.',         amount: null, hardCap: 10  });
  }

  // 5. Breakout already occurred → hard cap 20
  if (breakoutAlreadyOccurred) {
    blockers.push({ reason: 'breakoutAlready',  labelSv: 'Rörelsen har redan börjat.',                    amount: null, hardCap: 20  });
  }

  return blockers;
}

// ── Auto filter ───────────────────────────────────────────────────────────────

function calcAutoFilter({ label, tfsActive, breakoutAlreadyOccurred, marketRegimeV2, relVol20, priceToZoneAtr, finalTradeScore, baseScore }) {
  const reasons  = [];
  let severity   = 'none';

  if (label === 'Blockerad') {
    reasons.push('Signal blockerad av Confidence Engine.');
    severity = 'block';
  }
  if (tfsActive) {
    reasons.push('Three Finger Spread aktiv — priset är för utsträckt, jaga inte.');
    severity = 'block';
  }
  if (breakoutAlreadyOccurred) {
    reasons.push('Rörelsen har redan börjat — för sent att jaga.');
    if (severity !== 'block') severity = 'warn';
  }
  if (marketRegimeV2 === 'HIGH_VOLATILITY' && relVol20 !== null && relVol20 < 0.7) {
    reasons.push('Hög volatilitet kombinerat med svag volym — farlig kombination.');
    severity = 'block';
  }
  if (priceToZoneAtr !== null && priceToZoneAtr > 1.5 && baseScore < 50) {
    reasons.push('Priset är för långt från zonen och betyget är svagt.');
    if (severity !== 'block') severity = 'warn';
  }

  const blocked = reasons.length > 0;
  return {
    blocked,
    reasonSv: blocked ? reasons.join(' ') : null,
    severity,
  };
}

// ── Swedish reasons for scoreExplanationSv ────────────────────────────────────

function buildReasonsSv(boosters, blockers) {
  const sv = [];
  const hasBlocker  = blockers.some(b => b.amount !== null);
  const hasBooster  = boosters.length > 0;

  if (hasBooster && !hasBlocker) sv.push('Historiken stödjer detta läge.');

  for (const b of blockers) {
    if (b.labelSv && !sv.includes(b.labelSv)) sv.push(b.labelSv);
  }

  // Volume-specific positional message
  const volBlocker = blockers.find(b => b.reason === 'weakVolume');
  const volBooster = boosters.find(b => b.reason === 'strongVolume');
  if (!volBlocker && !volBooster) {} // silent when neutral
  if (volBlocker && !sv.includes('Volymen är för svag.')) sv.push('Volymen är för svag.');

  const nearBooster = boosters.find(b => b.reason === 'nearZone');
  if (nearBooster) sv.push('Priset är nära rätt zon.');

  const farBlocker = blockers.find(b => b.reason === 'farFromZone');
  if (farBlocker && !sv.includes('Priset är för långt från zonen.')) sv.push('Priset är för långt från zonen.');

  return sv;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Apply Confidence Engine to a live scan result.
 *
 * Reads learning-summary.json (cached 5 min) and computes:
 *   result.confidence   — { baseTradeScore, confidenceScore, adjustment, finalTradeScore, label, reasonsSv, blockers, boosters }
 *   result.autoFilter   — { blocked, reasonSv, severity }
 *   result.tradeScore   — updated to finalTradeScore
 *   result.tradeScoreBeforeConfidence — original
 *
 * Safe: never throws; returns result unchanged on any error.
 */
function applyConfidenceEngine(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[ConfidenceEngine] error:', err.message);
    return {
      ...result,
      tradeScoreBeforeConfidence: result.tradeScore ?? null,
      confidence:  _emptyConfidence(result.tradeScore),
      autoFilter:  { blocked: false, reasonSv: null, severity: 'none' },
    };
  }
}

function _apply(result) {
  const summary  = loadSummary();
  const lookups  = buildLookups(summary);
  const baseScore = result.tradeScore ?? 0;

  const { threeFingerSpread, breakoutAlreadyOccurred, marketRegimeV2, relVol20 } = result;
  const tfsActive = threeFingerSpread?.active === true;

  // ── Compute adjustments ───────────────────────────────────────────────────
  const boosters = calcBoosters(result, lookups, baseScore);
  const blockers = calcBlockers(result, baseScore);

  const boostSum  = boosters.reduce((s, b) => s + b.amount, 0);
  const penaltySum = blockers.filter(b => b.amount !== null).reduce((s, b) => s + b.amount, 0);
  const adjustment = boostSum + penaltySum;

  const confidenceScore = clamp(baseScore + adjustment, 0, 100);

  // ── Hard caps ─────────────────────────────────────────────────────────────
  let finalTradeScore = confidenceScore;
  if (tfsActive)               finalTradeScore = Math.min(finalTradeScore, 10);
  if (breakoutAlreadyOccurred) finalTradeScore = Math.min(finalTradeScore, 20);

  // ── Blocked flag for label ─────────────────────────────────────────────────
  const forceBlocked = baseScore < 30 && relVol20 !== null && relVol20 < 0.7;
  const label        = calcLabel(finalTradeScore, forceBlocked || tfsActive);

  // ── Swedish reasons ───────────────────────────────────────────────────────
  const reasonsSv        = buildReasonsSv(boosters, blockers);
  const existingExpl     = result.scoreExplanationSv || [];
  const newExpl          = [...existingExpl];
  for (const r of reasonsSv) {
    if (!newExpl.includes(r)) newExpl.push(r);
  }

  // ── Auto filter ───────────────────────────────────────────────────────────
  const autoFilter = calcAutoFilter({
    label, tfsActive, breakoutAlreadyOccurred, marketRegimeV2, relVol20,
    priceToZoneAtr: result.priceToZoneAtr,
    finalTradeScore,
    baseScore,
  });

  return {
    ...result,
    tradeScoreBeforeConfidence: baseScore,
    tradeScore:         finalTradeScore,
    signalScore:        finalTradeScore,
    scoreExplanationSv: newExpl,
    confidence: {
      baseTradeScore:  baseScore,
      confidenceScore,
      adjustment,
      finalTradeScore,
      label,
      reasonsSv,
      blockers,
      boosters,
    },
    autoFilter,
  };
}

function _emptyConfidence(baseTradeScore) {
  const score = baseTradeScore ?? 0;
  return {
    baseTradeScore:  score,
    confidenceScore: score,
    adjustment:      0,
    finalTradeScore: score,
    label:           calcLabel(score, false),
    reasonsSv:       [],
    blockers:        [],
    boosters:        [],
  };
}

module.exports = { applyConfidenceEngine };
