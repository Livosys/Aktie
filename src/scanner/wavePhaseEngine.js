'use strict';

// Wave Phase Engine — works from flat scan result metrics (no candles2m needed)
// Uses: sma20, sma200, rsi14, atr14, slope20Atr, bbwPct120, atrPct120,
//       relVol20, priceToZoneAtr, positionCode, elephantBar, recentRange, nr7

function round2(n) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// ── Internal analysis ─────────────────────────────────────────────────────────

function getRsiState(rsi) {
  if (rsi === null || rsi === undefined) return 'neutral';
  if (rsi >= 70) return 'overbought';
  if (rsi >= 58) return 'bullish';
  if (rsi >= 42) return 'neutral';
  if (rsi >= 30) return 'bearish';
  return 'oversold';
}

function getDirection(price, sma20, sma200, slope20Atr) {
  if (!sma20 || !price) return 'neutral';
  const distAtr = sma20 > 0 ? (price - sma20) / (sma20 * 0.01) : 0; // rough % dist
  const slopeUp = slope20Atr !== null && slope20Atr > 0;
  const slopeDown = slope20Atr !== null && slope20Atr < 0;
  const priceAbove = price > sma20 * 1.001;
  const priceBelow = price < sma20 * 0.999;

  if (priceAbove && (slopeUp || !slopeDown)) return 'bullish';
  if (priceBelow && (slopeDown || !slopeUp)) return 'bearish';
  if (slopeUp && priceAbove) return 'bullish';
  if (slopeDown && priceBelow) return 'bearish';
  return 'neutral';
}

// ── Phase classification ──────────────────────────────────────────────────────

function classifyPhase(params) {
  const {
    price, sma20, sma200, rsi14, atr14,
    bbwPct120, atrPct120, relVol20,
    rangeCompression, nr7, slope20Atr,
    smaGapAtr, elephantBar, threeFingerSpread,
    breakoutAlreadyOccurred, positionCode, recentRange,
  } = params;

  const distSma20Atr = (sma20 && atr14 && atr14 > 0) ? (price - sma20) / atr14 : null;
  const distSma200Atr = (sma200 && atr14 && atr14 > 0) ? (price - sma200) / atr14 : null;

  const direction = getDirection(price, sma20, sma200, slope20Atr);
  const rsiState = getRsiState(rsi14);

  const compressed = (bbwPct120 !== null && bbwPct120 <= 60) ||
                     (atrPct120 !== null && atrPct120 <= 60);
  const slightlyCompressed = (bbwPct120 !== null && bbwPct120 <= 80) ||
                              (atrPct120 !== null && atrPct120 <= 80);
  const atrExpanding = atrPct120 !== null && atrPct120 > 100;

  const priceNearSma20 = distSma20Atr !== null && Math.abs(distSma20Atr) <= 1.0;
  const priceExtended = distSma20Atr !== null && Math.abs(distSma20Atr) >= 3.0;
  const priceVeryExtended = distSma20Atr !== null && Math.abs(distSma20Atr) >= 4.5;
  const priceMidExtended = distSma20Atr !== null && Math.abs(distSma20Atr) >= 2.0;

  const strongVol = relVol20 !== null && relVol20 >= 1.4;
  const normalVol = relVol20 !== null && relVol20 >= 0.8;

  const rsiExtreme = rsiState === 'overbought' || rsiState === 'oversold';
  const rsiBullish = rsiState === 'bullish' || rsiState === 'overbought';
  const rsiBearish = rsiState === 'bearish' || rsiState === 'oversold';
  const rsiNeutral = rsiState === 'neutral';

  const slopeStrong = slope20Atr !== null && Math.abs(slope20Atr) >= 0.3;
  const slopeModerate = slope20Atr !== null && Math.abs(slope20Atr) >= 0.1;
  const slopeFlat = slope20Atr !== null && Math.abs(slope20Atr) < 0.1;
  const slopeUp = slope20Atr !== null && slope20Atr > 0;
  const slopeDown = slope20Atr !== null && slope20Atr < 0;

  const eBar = elephantBar || {};
  const recentImpulse = eBar.active || (recentRange && atr14 && recentRange / atr14 > 1.2);
  const impulseStrength = eBar.active
    ? (eBar.rangeMultiple || 1.0)
    : (recentRange && atr14 && atr14 > 0 ? round2(recentRange / atr14) : null);

  const inZone = positionCode === 'in_zone';
  const extendedAbove = positionCode === 'extended_above';
  const extendedBelow = positionCode === 'extended_below';

  const reasons = [];

  // ── COMPRESSION ──────────────────────────────────────────────────────────────
  if (compressed && !recentImpulse && (priceNearSma20 || inZone)) {
    if (bbwPct120 !== null && bbwPct120 <= 60)
      reasons.push(`BBWidth ${Math.round(bbwPct120)}% av historisk nivå — komprimerad.`);
    if (atrPct120 !== null && atrPct120 <= 60)
      reasons.push(`ATR ${Math.round(atrPct120)}% av historisk — låg volatilitet.`);
    if (nr7) reasons.push('NR7 — smalaste range på 7 bars, extrem kompression.');
    reasons.push('Priset nära SMA20 — laddar inför breakout.');
    if (!strongVol) reasons.push('Volymen är normal/låg — ingen breakout-trigger ännu.');

    const conf = 30 + (bbwPct120 !== null && bbwPct120 <= 50 ? 20 : 10) +
                 (nr7 ? 15 : 0) + (priceNearSma20 ? 15 : 0);
    return build('COMPRESSION', 'neutral', Math.min(conf, 85), null, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrPct120, relVol20, reasons);
  }

  // ── EXHAUSTION_RISK ───────────────────────────────────────────────────────────
  if (priceExtended && rsiExtreme) {
    const absD = distSma20Atr !== null ? Math.abs(distSma20Atr).toFixed(1) : '?';
    reasons.push(`Priset ${absD}x ATR från SMA20 — mycket utsträckt.`);
    if (rsiState === 'overbought') reasons.push(`RSI ${Math.round(rsi14)} — överköpt.`);
    if (rsiState === 'oversold') reasons.push(`RSI ${Math.round(rsi14)} — översåld.`);
    if (eBar.active) reasons.push(`Stor candle (${(eBar.rangeMultiple || 0).toFixed(1)}x ATR) — exhaustion-signal.`);
    if (strongVol) reasons.push(`Hög volym (${relVol20.toFixed(2)}x) — möjlig klimaxrörelse.`);
    const dirStr = direction === 'bullish' ? 'uppgångs' : 'nedgångs';
    reasons.push(`Lång ${dirStr}trend utan pullback ökar reversalrisk.`);

    const conf = (priceVeryExtended ? 30 : 20) + (rsiExtreme ? 25 : 10) + (strongVol ? 15 : 5);
    return build('EXHAUSTION_RISK', direction, Math.min(conf + 15, 85), 5, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrPct120, relVol20, reasons);
  }

  // ── PULLBACK_CORRECTION ───────────────────────────────────────────────────────
  if (slopeModerate && priceNearSma20 && rsiNeutral && !compressed) {
    const slopeDir = slopeUp ? 'uppåt' : 'nedåt';
    reasons.push(`SMA20 lutar ${slopeDir} (slope ${round2(slope20Atr)}) — trend finns.`);
    reasons.push(`Priset är tillbaka nära SMA20 (${distSma20Atr > 0 ? '+' : ''}${round2(distSma20Atr)}x ATR).`);
    if (rsiNeutral) reasons.push(`RSI ${Math.round(rsi14)} — svalnade, trend inte bruten.`);
    if (!strongVol) reasons.push('Låg/normal volym under korrektionen — hälsosamt pullback.');

    const conf = (slopeStrong ? 25 : 15) + 20 + (rsiNeutral ? 15 : 0) + (normalVol ? 10 : 0);
    const probWave = slopeStrong ? 4 : 2;
    return build('PULLBACK_CORRECTION', direction, Math.min(conf + 5, 80), probWave, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrPct120, relVol20, reasons);
  }

  // ── IMPULSE_START ─────────────────────────────────────────────────────────────
  if ((slightlyCompressed || nr7) && strongVol && recentImpulse && !priceNearSma20) {
    reasons.push('Priset bryter ut från komprimerad zon med ökad volym.');
    if (bbwPct120 !== null) reasons.push(`BBWidth ${Math.round(bbwPct120)}% av historisk — volatilitet expanderar.`);
    if (relVol20) reasons.push(`Volym ${relVol20.toFixed(2)}x medel — breakout-bekräftelse.`);
    if (eBar.active) reasons.push(`Elephant bar (${(eBar.rangeMultiple || 0).toFixed(1)}x ATR) — stark initiell rörelse.`);
    if (distSma20Atr !== null)
      reasons.push(distSma20Atr > 0
        ? `Priset bryter upp (+${round2(distSma20Atr)}x ATR från SMA20).`
        : `Priset bryter ned (${round2(distSma20Atr)}x ATR från SMA20).`);

    const conf = (strongVol ? 25 : 10) + (eBar.active ? 20 : 10) + (nr7 ? 15 : 5);
    return build('IMPULSE_START', direction, Math.min(conf + 10, 80), 1, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrPct120, relVol20, reasons);
  }

  // ── IMPULSE_CONTINUATION ─────────────────────────────────────────────────────
  if (slopeModerate && !priceExtended && !priceNearSma20) {
    const bullCont = direction === 'bullish' && (rsiBullish || slopeStrong) && slopeUp;
    const bearCont = direction === 'bearish' && (rsiBearish || slopeStrong) && slopeDown;

    if (bullCont || bearCont) {
      const slopeDir = slopeUp ? 'uppåt' : 'nedåt';
      reasons.push(`Tydlig trend ${slopeDir} — SMA20 slope ${round2(slope20Atr)}.`);
      const rsiVal = rsi14 !== null ? Math.round(rsi14) : '?';
      reasons.push(`RSI ${rsiVal} — momentum fortsätter i trendriktnig.`);
      const d = distSma20Atr !== null ? `${distSma20Atr > 0 ? '+' : ''}${round2(distSma20Atr)}x ATR` : '?';
      reasons.push(`Priset håller ${direction === 'bullish' ? 'ovanför' : 'under'} SMA20 (${d}).`);
      if (breakoutAlreadyOccurred)
        reasons.push('Breakout bekräftad — continuation-läge. Entry kan vara sent om du missade impulsen.');

      const conf = (slopeStrong ? 25 : 15) + (rsiBullish || rsiBearish ? 15 : 5) + (normalVol ? 10 : 0);
      const probWave = priceMidExtended ? 5 : 3;
      return build('IMPULSE_CONTINUATION', direction, Math.min(conf + 15, 85), probWave, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrPct120, relVol20, reasons);
    }
  }

  // Relaxed continuation: strong slope but RSI mixed
  if (slopeStrong && !priceExtended && direction !== 'neutral') {
    reasons.push(`Stark SMA20-lutning (slope ${round2(slope20Atr)}) — trenden håller.`);
    const d = distSma20Atr !== null ? `${distSma20Atr > 0 ? '+' : ''}${round2(distSma20Atr)}x ATR` : '?';
    reasons.push(`Priset ${direction === 'bullish' ? 'ovanför' : 'under'} SMA20 (${d}).`);

    return build('IMPULSE_CONTINUATION', direction, 50, 3, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrPct120, relVol20, reasons);
  }

  // ── CHOPPY_UNKNOWN ────────────────────────────────────────────────────────────
  reasons.push('Ingen tydlig fas identifierad — marknaden är odefinierad.');
  if (rsiNeutral) reasons.push(`RSI ${rsi14 !== null ? Math.round(rsi14) : '?'} — mitt i intervallet, ingen styrka.`);
  if (!slopeModerate) reasons.push('SMA20 lutar knappt — sidledes rörelse.');

  return build('CHOPPY_UNKNOWN', direction, 20, null, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrPct120, relVol20, reasons);
}

// ── Build result ──────────────────────────────────────────────────────────────

function build(phase, _dir, confidence, probableWave, direction, distSma20Atr, distSma200Atr, impulseStrength, rsiState, atrExpansion, volumeSupport, reasonsSv) {
  const metrics = {
    impulseStrength: round2(impulseStrength),
    correctionDepth: null,
    trendSlope: null,
    rsiState,
    distanceFromSma20: round2(distSma20Atr),
    distanceFromSma200: round2(distSma200Atr),
    atrExpansion: round2(atrExpansion),
    volumeSupport: round2(volumeSupport),
  };

  return {
    phase,
    direction,
    confidence: Math.round(Math.max(0, Math.min(100, confidence))),
    probableWave: probableWave || null,
    continuationBias: getContinuationBias(phase, direction),
    exhaustionRisk: getExhaustionRisk(phase, distSma20Atr, rsiState),
    pullbackRisk: getPullbackRisk(phase, distSma20Atr),
    summarySv: buildSummary(phase, direction, probableWave),
    reasonsSv,
    metrics,
  };
}

function getContinuationBias(phase, dir) {
  if (['IMPULSE_CONTINUATION', 'IMPULSE_START', 'PULLBACK_CORRECTION'].includes(phase))
    return dir === 'bullish' ? 'up' : dir === 'bearish' ? 'down' : 'none';
  return 'none';
}

function getExhaustionRisk(phase, distSma20, rsiState) {
  if (phase === 'EXHAUSTION_RISK') return 'high';
  if (distSma20 !== null && Math.abs(distSma20) >= 3.0) return 'medium';
  if (rsiState === 'overbought' || rsiState === 'oversold') return 'medium';
  return 'low';
}

function getPullbackRisk(phase, distSma20) {
  if (phase === 'EXHAUSTION_RISK') return 'high';
  if (phase === 'IMPULSE_CONTINUATION' && distSma20 !== null && Math.abs(distSma20) >= 2.5) return 'medium';
  return 'low';
}

function buildSummary(phase, direction, probableWave) {
  const dirSv = direction === 'bullish' ? 'uppåt' : direction === 'bearish' ? 'nedåt' : 'sidledes';
  switch (phase) {
    case 'COMPRESSION':
      return 'Priset samlar energi. Ingen tydlig riktning. Vänta på breakout med volym.';
    case 'IMPULSE_START':
      return `Breakout påbörjad ${dirSv}. Volym bekräftar. Möjlig Wave 1 — vänta på pullback för entry.`;
    case 'IMPULSE_CONTINUATION':
      if (probableWave === 5)
        return `Trenden ${dirSv} fortsätter men är utsträckt — kan vara Wave 5. Entry riskfyllt.`;
      return `Trenden ${dirSv} fortsätter (trolig Wave 3). Entry kan vara sent — vänta på pullback eller ny trigger.`;
    case 'PULLBACK_CORRECTION':
      return `Pullback mot SMA20 — möjlig Wave ${probableWave === 4 ? '4' : '2'}. Trend intakt. Bevaka för ny entry.`;
    case 'EXHAUSTION_RISK':
      return `Rörelsen ${dirSv} är stark men överutsträckt. Hög exhaustion-risk. Undvik sena entries.`;
    default:
      return 'Ingen tydlig fas. Vänta på klarhet.';
  }
}

// ── Public ────────────────────────────────────────────────────────────────────

function applyWavePhase(result) {
  const {
    symbol, price, sma20, sma200, rsi14, atr14,
    bbwPct120, atrPct120, relVol20, bbw20,
    rangeCompression, nr7, slope20Atr, slope200Atr,
    smaGapAtr, smaGapPct, positionCode, recentRange,
    elephantBar, threeFingerSpread, breakoutAlreadyOccurred,
  } = result;

  if (!price || !sma20 || !atr14) {
    return {
      ...result,
      waveContext: {
        phase: 'CHOPPY_UNKNOWN', direction: 'neutral', confidence: 0,
        probableWave: null, continuationBias: 'none',
        exhaustionRisk: 'low', pullbackRisk: 'low',
        summarySv: 'Otillräcklig data för Wave-analys.',
        reasonsSv: ['Saknar pris, SMA20 eller ATR14.'],
        metrics: {
          impulseStrength: null, correctionDepth: null, trendSlope: null,
          rsiState: 'neutral', distanceFromSma20: null, distanceFromSma200: null,
          atrExpansion: null, volumeSupport: null,
        },
      },
    };
  }

  const waveContext = classifyPhase({
    price, sma20, sma200, rsi14, atr14,
    bbwPct120, atrPct120, relVol20, bbw20,
    rangeCompression, nr7, slope20Atr, slope200Atr,
    smaGapAtr, smaGapPct, positionCode, recentRange,
    elephantBar, threeFingerSpread, breakoutAlreadyOccurred,
  });

  return { ...result, waveContext };
}

module.exports = { applyWavePhase };
