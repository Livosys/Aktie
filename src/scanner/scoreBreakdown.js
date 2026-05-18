'use strict';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }

/**
 * Engine v3 — Score Breakdown (steg 2)
 *
 * 6 strukturkomponenter:
 *   baseScore        20% — struktur (smaGapAtr, narrowType, slope200Atr)
 *   locationScore    20% — prisläge (priceToZoneAtr, priceToSma20Atr, extended)
 *   compressionScore 15% — kompression (rangeCompression, NR7, BBW, ATR-pct)
 *   triggerScore     20% — signalkvalitet (elephantBar, colorChange, signal, BOC)
 *   volumeScore      10% — volymbekräftelse (relVol20)
 *   riskScore        15% — riskbedömning (TFS, BOC, WIDE_AVOID, extended)
 *
 * Steg 2: marketCtx appliceras som flat justering på finalScore efter viktad summa.
 *   +5  om marknaden stödjer signalriktningen
 *   −10 om marknaden går emot signalriktningen
 *   −5  om CHOPPY
 *   −15 om HIGH_RISK (+ hårt tak 20)
 */
function calcScoreBreakdown(v2result, marketCtx) {
  const {
    state, signal, narrowType,
    smaGapAtr, priceToZoneAtr, slope200Atr,
    rangeCompression, nr7, bbwPct120, atrPct120,
    relVol20, positionLabelSv,
    price, sma20, atr14,
    longTrigger, shortTrigger,
    threeFingerSpread, elephantBar, colorChange, breakoutAlreadyOccurred,
  } = v2result || {};

  const tfs = threeFingerSpread || {};
  const eb  = elephantBar       || {};
  const cc  = colorChange       || {};
  const explanation = [];

  // ── Kortslutning: ingen data ──────────────────────────────────────────────
  if (!state || state === 'NO_TRADE') {
    return {
      scores: {
        baseScore: 0, locationScore: 0, compressionScore: 0,
        triggerScore: 0, volumeScore: 0, riskScore: 0,
        marketScore: marketCtx?.marketScore ?? 50,
        finalScore: 0,
      },
      scoreExplanationSv: ['Otillräcklig data — ingen score beräknad.'],
      finalScore: 0,
    };
  }

  // ── 1. Base Score (20%) ───────────────────────────────────────────────────
  let baseScore = 50;

  if (smaGapAtr !== null && smaGapAtr !== undefined) {
    if      (smaGapAtr <= 0.20) baseScore = 100;
    else if (smaGapAtr <= 0.40) baseScore = 80;
    else if (smaGapAtr <= 0.60) baseScore = 58;
    else if (smaGapAtr <= 1.00) baseScore = 38;
    else                        baseScore = 15;

    if (smaGapAtr > 0.40) {
      explanation.push(
        `Basen är svag — SMA20 och SMA200 är ${round(smaGapAtr, 2)} ATR ifrån varandra (bäst ≤ 0.40).`
      );
    }
  }

  if (narrowType === 'coil_flat') {
    baseScore = Math.min(100, baseScore + 15);
    explanation.push('Typ Coil/Flat — båda SMAs är flacka. Klassisk fjäder-setup.');
  } else if (narrowType === 'attack_200') {
    baseScore = Math.min(100, baseScore + 10);
    explanation.push('Typ Attack 200 — SMA20 rör sig mot SMA200. Möjlig kollision framåt.');
  }

  if (slope200Atr !== null && slope200Atr !== undefined) {
    if      (slope200Atr <= 0.08) baseScore = Math.min(100, baseScore + 8);
    else if (slope200Atr > 0.30)  baseScore = Math.max(0,   baseScore - 8);
  }

  // ── 2. Location Score (20%) ───────────────────────────────────────────────
  let locationScore = 50;
  const pl = positionLabelSv || '';
  const isExtended = pl.includes('För långt upp') || pl.includes('För långt ned');

  if (isExtended) {
    locationScore = 5;
    explanation.push('Priset är för långt från zonen. Vänta på pullback.');
  } else if (priceToZoneAtr !== null && priceToZoneAtr !== undefined) {
    if      (priceToZoneAtr <= 0.20) locationScore = 100;
    else if (priceToZoneAtr <= 0.50) locationScore = 82;
    else if (priceToZoneAtr <= 1.00) locationScore = 55;
    else if (priceToZoneAtr <= 2.00) locationScore = 25;
    else                             locationScore = 5;

    if (priceToZoneAtr > 1.00) {
      explanation.push(
        `Priset är ${round(priceToZoneAtr, 2)} ATR från zonen — för långt ifrån för bästa entry.`
      );
    }
  }

  if (!isExtended && price !== null && sma20 !== null && atr14 && atr14 > 0) {
    const p2s20 = Math.abs(price - sma20) / atr14;
    if (p2s20 <= 0.15) locationScore = Math.min(100, locationScore + 10);
  }

  // ── 3. Compression Score (15%) ────────────────────────────────────────────
  let compressionScore = 30;

  if (nr7 === true) {
    compressionScore = 95;
    explanation.push('NR7 — smalaste candle av senaste 7. Tydlig kompression.');
  } else if (rangeCompression !== null && rangeCompression !== undefined) {
    if      (rangeCompression <= 0.55) compressionScore = 90;
    else if (rangeCompression <= 0.75) compressionScore = 72;
    else if (rangeCompression <= 0.95) compressionScore = 52;
    else                               compressionScore = 22;
  }

  if (bbwPct120 !== null && bbwPct120 !== undefined && bbwPct120 <= 35) {
    compressionScore = Math.min(100, compressionScore + 12);
  }
  if (atrPct120 !== null && atrPct120 !== undefined && atrPct120 <= 45) {
    compressionScore = Math.min(100, compressionScore + 10);
  }

  // ── 4. Trigger Score (20%) ────────────────────────────────────────────────
  let triggerScore = 15;

  if (breakoutAlreadyOccurred) {
    triggerScore = 5;
    explanation.push('Utbrottet har redan hänt. Vänta på pullback och ny setup.');
  } else if (eb.active) {
    triggerScore = 88;
    explanation.push(`Elephant Bar ${eb.direction === 'bullish' ? 'uppåt' : 'nedåt'} — stark candle bekräftar utbrott.`);
  } else if (cc.active) {
    triggerScore = 72;
    explanation.push(`Färgbyte ${cc.direction === 'bullish' ? 'uppåt' : 'nedåt'} i narrow-zon.`);
  } else if (signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED') {
    triggerScore = 58;
  } else if (signal === 'LONG_WATCH' || signal === 'SHORT_WATCH') {
    triggerScore = 40;
  } else if (longTrigger !== null || shortTrigger !== null) {
    triggerScore = 28;
  } else {
    explanation.push('Ingen tydlig trigger aktiv just nu. Signal finns, men kvaliteten är för låg.');
  }

  // ── 5. Volume Score (10%) ─────────────────────────────────────────────────
  let volumeScore = 50;

  if (relVol20 !== null && relVol20 !== undefined) {
    if      (relVol20 >= 2.5) volumeScore = 100;
    else if (relVol20 >= 2.0) volumeScore = 90;
    else if (relVol20 >= 1.5) volumeScore = 78;
    else if (relVol20 >= 1.3) volumeScore = 65;
    else if (relVol20 >= 1.0) volumeScore = 52;
    else if (relVol20 >= 0.7) volumeScore = 38;
    else                      volumeScore = 15;

    if (relVol20 < 0.7) {
      explanation.push(
        `Volymen bekräftar inte en stark entry ännu (${round(relVol20, 2)}x medelvärde).`
      );
    }
  }

  // ── 6. Risk Score (15%) ───────────────────────────────────────────────────
  let riskScore = 70;

  if (tfs.active) {
    riskScore = 5;
    explanation.push('3-finger spread är aktiv. Jaga inte.');
  } else if (state === 'THREE_FINGER_SPREAD_AVOID') {
    riskScore = Math.min(riskScore, 8);
    if (!explanation.some((e) => e.includes('3-finger'))) {
      explanation.push('Läge: JAGA EJ — priset är för långt från SMA-zonen.');
    }
  } else if (breakoutAlreadyOccurred) {
    riskScore = Math.min(riskScore, 15);
  } else if (state === 'WIDE_AVOID') {
    riskScore = Math.min(riskScore, 15);
    explanation.push('Priset är för långt från zonen (WIDE_AVOID). Risken är för hög för entry.');
  } else if (isExtended) {
    riskScore = Math.min(riskScore, 20);
  } else if (priceToZoneAtr !== null && priceToZoneAtr !== undefined && priceToZoneAtr > 1.50) {
    riskScore = Math.min(riskScore, 38);
  }

  // ── Viktad summa (6 komponenter) ──────────────────────────────────────────
  const W = { base: 0.20, location: 0.20, compression: 0.15, trigger: 0.20, volume: 0.10, risk: 0.15 };
  let finalScore =
    baseScore        * W.base +
    locationScore    * W.location +
    compressionScore * W.compression +
    triggerScore     * W.trigger +
    volumeScore      * W.volume +
    riskScore        * W.risk;

  finalScore = clamp(Math.round(finalScore), 0, 100);

  // ── Hårda tak — strukturella ──────────────────────────────────────────────
  if (tfs.active || state === 'THREE_FINGER_SPREAD_AVOID') finalScore = Math.min(finalScore, 10);
  if (breakoutAlreadyOccurred)                              finalScore = Math.min(finalScore, 20);
  if (state === 'WIDE_AVOID')                               finalScore = Math.min(finalScore, 22);

  // ── Steg 2: Market Regime-justering ──────────────────────────────────────
  const mRegime = marketCtx?.marketRegime || 'UNKNOWN';
  const mDir    = marketCtx?.marketDirection || 'neutral';
  const mScore  = marketCtx?.marketScore ?? 50;

  const isLong  = signal === 'LONG_TRIGGERED'  || signal === 'LONG_WATCH';
  const isShort = signal === 'SHORT_TRIGGERED' || signal === 'SHORT_WATCH';

  if (mRegime !== 'UNKNOWN') {
    let marketAdj = 0;

    // Signalriktning vs marknad
    if (mDir === 'bearish' && isLong) {
      marketAdj -= 10;
      explanation.push('Marknaden går emot signalen — long i bearish marknad.');
    } else if (mDir === 'bullish' && isShort) {
      marketAdj -= 10;
      explanation.push('Marknaden går emot signalen — short i bullish marknad.');
    } else if (mDir === 'bullish' && isLong) {
      marketAdj += 5;
      explanation.push('Marknaden stödjer long just nu.');
    } else if (mDir === 'bearish' && isShort) {
      marketAdj += 5;
      explanation.push('Marknaden stödjer short just nu.');
    }

    // Regime-baserade justeringar
    if (mRegime === 'HIGH_RISK') {
      marketAdj -= 15;
      explanation.push('Marknaden i HIGH_RISK-läge — stor rörelse eller TFS på referenssymbol.');
    } else if (mRegime === 'CHOPPY') {
      marketAdj -= 5;
      explanation.push('Marknaden är stökig, därför sänks betyget.');
    }

    finalScore = clamp(Math.round(finalScore + marketAdj), 0, 100);

    // Hårt tak: HIGH_RISK blockerar höga scores
    if (mRegime === 'HIGH_RISK') finalScore = Math.min(finalScore, 20);
  }

  if (explanation.length === 0) {
    explanation.push('Inga tydliga signalförstärkningar eller varningar just nu.');
  }

  return {
    scores: {
      baseScore:        clamp(Math.round(baseScore),        0, 100),
      locationScore:    clamp(Math.round(locationScore),    0, 100),
      compressionScore: clamp(Math.round(compressionScore), 0, 100),
      triggerScore:     clamp(Math.round(triggerScore),     0, 100),
      volumeScore:      clamp(Math.round(volumeScore),      0, 100),
      riskScore:        clamp(Math.round(riskScore),        0, 100),
      marketScore:      clamp(Math.round(mScore),           0, 100),
      finalScore,
    },
    scoreExplanationSv: explanation.slice(0, 8),
    finalScore,
  };
}

module.exports = { calcScoreBreakdown };
