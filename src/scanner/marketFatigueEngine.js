'use strict';

function round(n, d = 1) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Market Fatigue Engine
 *
 * Detects when a move or setup is showing exhaustion / diminishing continuation quality.
 * Uses only existing scan result fields — no extra data fetches.
 *
 * Output: fatigueContext {
 *   fatigueScore           0-100  (higher = more tired)
 *   exhaustionProbability  0-1
 *   continuationDecay      'none'|'mild'|'moderate'|'severe'
 *   fatigueReasons         string[]
 *   explanationSv          string
 * }
 *
 * Safety: does NOT modify tradeScore.
 * Enrichment only — the UI and orchestrator decide how to surface this.
 */
function applyMarketFatigue(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[MarketFatigue] error:', err.message);
    return { ...result, fatigueContext: null };
  }
}

function _apply(result) {
  const {
    breakoutAlreadyOccurred,
    threeFingerSpread,
    relVol20,
    rsi14,
    atrPct120,
    priceToZoneAtr,
    positionCode,
    elephantBar,
    mtfAlignment,
    slope20Atr,
  } = result;

  const fatigueReasons = [];
  let fatigueScore = 0;

  // ── Extension / overextension ─────────────────────────────────────────────
  if (breakoutAlreadyOccurred) {
    fatigueScore += 35;
    fatigueReasons.push('Rörelsen har redan börjat — för sent för optimal entry.');
  }

  if (threeFingerSpread?.active) {
    const extra = threeFingerSpread.strength === 'super_wide' ? 30 : 20;
    fatigueScore += extra;
    fatigueReasons.push(`Three Finger Spread (${threeFingerSpread.strength || 'normal'}) — priset är kraftigt utsträckt.`);
  }

  if (positionCode === 'extended_above' || positionCode === 'extended_below') {
    fatigueScore += 18;
    fatigueReasons.push('Priset är klart utanför SMA-zonen — extension synlig.');
  } else if (priceToZoneAtr != null && priceToZoneAtr > 2.5) {
    fatigueScore += 14;
    fatigueReasons.push(`Priset är ${round(priceToZoneAtr, 1)} ATR från zonen — extremt utsträckt.`);
  }

  // ── Volume deterioration ──────────────────────────────────────────────────
  if (relVol20 != null) {
    if      (relVol20 < 0.55) { fatigueScore += 22; fatigueReasons.push(`Volymen mycket svag (${round(relVol20, 2)}x snitt) — rörelsen saknar intresse.`); }
    else if (relVol20 < 0.70) { fatigueScore += 14; fatigueReasons.push(`Volymen svag (${round(relVol20, 2)}x snitt).`); }
    else if (relVol20 < 0.85) { fatigueScore += 7; }
  }

  // ── RSI extremes ──────────────────────────────────────────────────────────
  if (rsi14 != null) {
    if      (rsi14 > 82 || rsi14 < 18) { fatigueScore += 22; fatigueReasons.push(`RSI ${round(rsi14, 1)} — extremt läge, hög reversals-risk.`); }
    else if (rsi14 > 74 || rsi14 < 26) { fatigueScore += 12; fatigueReasons.push(`RSI ${round(rsi14, 1)} — nära extrem, försiktig med continuation.`); }
    else if (rsi14 > 68 || rsi14 < 32) { fatigueScore += 6; }
  }

  // ── MTF conflict (momentum weakening across timeframes) ──────────────────
  if      (mtfAlignment === 'full_conflict')  { fatigueScore += 20; fatigueReasons.push('Fullständig MTF-konflikt — alla tidsramar pekar mot varandra.'); }
  else if (mtfAlignment === 'conflicting')    { fatigueScore += 14; fatigueReasons.push('MTF-konflikt — längre tidsramar ifrågasätter riktningen.'); }
  else if (mtfAlignment === 'mixed')          { fatigueScore += 6; }

  // ── ATR extreme expansion (often marks end of a move) ────────────────────
  if (atrPct120 != null && atrPct120 > 160) {
    fatigueScore += 12;
    fatigueReasons.push(`ATR ${round(atrPct120, 0)}:e percentilen — förhöjd volatilitet, rörelsen kan vara i slutfasen.`);
  }

  // ── Elephant bar in extended position ─────────────────────────────────────
  if (elephantBar?.active && (positionCode === 'extended_above' || positionCode === 'extended_below')) {
    fatigueScore += 14;
    fatigueReasons.push('Elephant Bar i utsträckt position — risk för key reversal.');
  }

  // ── SMA slope collapse ────────────────────────────────────────────────────
  if (slope20Atr != null && slope20Atr > 0 && slope20Atr < 0.06) {
    fatigueScore += 7;
    fatigueReasons.push('SMA20-lutning har planat ut — rörelsen tappar riktningsstyrka.');
  }

  const finalFatigue        = clamp(fatigueScore, 0, 100);
  const exhaustionProbability = round(finalFatigue / 100, 2);

  let continuationDecay;
  if      (finalFatigue >= 70) continuationDecay = 'severe';
  else if (finalFatigue >= 50) continuationDecay = 'moderate';
  else if (finalFatigue >= 30) continuationDecay = 'mild';
  else                          continuationDecay = 'none';

  // ── Swedish explanation ───────────────────────────────────────────────────
  let explanationSv;
  if (finalFatigue >= 70) {
    explanationSv = `Stark utmattning (${finalFatigue}/100). ${fatigueReasons[0] || 'Rörelsen har troligen nått sin topp.'} Vänta på reset.`;
  } else if (finalFatigue >= 50) {
    explanationSv = `Måttlig utmattning (${finalFatigue}/100). ${fatigueReasons[0] || 'Svaghetstecken syns.'} Försiktighet rekommenderas.`;
  } else if (finalFatigue >= 30) {
    explanationSv = `Mild utmattning (${finalFatigue}/100). Bevaka om tecknen förstärks.`;
  } else {
    explanationSv = 'Ingen påtaglig utmattning. Rörelsekapacitet intakt.';
  }

  return {
    ...result,
    fatigueContext: {
      fatigueScore:          finalFatigue,
      exhaustionProbability,
      continuationDecay,
      fatigueReasons:        fatigueReasons.slice(0, 4),
      explanationSv,
    },
  };
}

module.exports = { applyMarketFatigue };
