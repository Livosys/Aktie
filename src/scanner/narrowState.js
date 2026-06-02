'use strict';
const { sma, recentRange } = require('./indicators');

function round(n, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Position Code ─────────────────────────────────────────────────────────────

const POSITION_LABELS_SV = {
  above_both:     'Ovanför båda linjerna',
  below_both:     'Under båda linjerna',
  in_zone:        'I zonen',
  extended_above: 'För långt upp från zonen',
  extended_below: 'För långt ned från zonen',
};

function calcPositionCode(price, sma20, sma200, priceToZoneAtr) {
  if (!sma200) {
    if (price > sma20) return priceToZoneAtr > 1.5 ? 'extended_above' : 'above_both';
    return priceToZoneAtr > 1.5 ? 'extended_below' : 'below_both';
  }
  const smaHigh = Math.max(sma20, sma200);
  const smaLow  = Math.min(sma20, sma200);
  if (price >= smaLow && price <= smaHigh) return 'in_zone';
  if (price > smaHigh) return priceToZoneAtr > 1.5 ? 'extended_above' : 'above_both';
  return priceToZoneAtr > 1.5 ? 'extended_below' : 'below_both';
}

// ── 3 Finger Spread ───────────────────────────────────────────────────────────

function calcThreeFingerSpread({ price, sma20, sma200, atr14 }) {
  if (!sma20 || !sma200 || !atr14 || atr14 === 0) {
    return { active: false, direction: 'none', strength: 'none', priceToSma20Atr: null, sma20ToSma200Atr: null, message: 'Insufficient data' };
  }

  const p2s20 = Math.abs(price - sma20) / atr14;
  const s20s200 = Math.abs(sma20 - sma200) / atr14;

  const bullish = price > sma20 && sma20 > sma200 && p2s20 > 1.5 && s20s200 > 1.5;
  const bearish = price < sma20 && sma20 < sma200 && p2s20 > 1.5 && s20s200 > 1.5;

  if (!bullish && !bearish) {
    return { active: false, direction: 'none', strength: 'none', priceToSma20Atr: round(p2s20, 2), sma20ToSma200Atr: round(s20s200, 2), message: 'No spread detected' };
  }

  const superWide = p2s20 > 2.0 && s20s200 > 2.0;
  const wide = p2s20 > 1.8 || s20s200 > 1.8;
  const strength = superWide ? 'super_wide' : wide ? 'wide' : 'normal';
  const direction = bullish ? 'bullish' : 'bearish';

  return {
    active: true,
    direction,
    strength,
    priceToSma20Atr: round(p2s20, 2),
    sma20ToSma200Atr: round(s20s200, 2),
    message: `3 Finger Spread ${direction} (${strength}) — jaga inte`,
  };
}

// ── Elephant Bar ──────────────────────────────────────────────────────────────

function calcElephantBar(candles2m, avgRange20, atr14, relVol20) {
  if (!candles2m || candles2m.length < 1 || !avgRange20 || avgRange20 === 0) {
    return { active: false, direction: 'none', rangeMultiple: null, bodyPercent: null, closeQuality: 'middle', volConfirm: false, message: 'Insufficient data' };
  }

  const c = candles2m[candles2m.length - 1];
  const barRange = c.h - c.l;
  const bodySize = Math.abs(c.c - c.o);
  const rangeMultiple = barRange / avgRange20;
  const bodyPercent = barRange > 0 ? bodySize / barRange : 0;

  const closeNearHigh = c.c >= c.l + 0.75 * barRange;
  const closeNearLow  = c.c <= c.l + 0.25 * barRange;
  const closeQuality = closeNearHigh ? 'near_high' : closeNearLow ? 'near_low' : 'middle';

  // Spec: range >= max(1.8 * avgRange20, 1.5 * ATR14)
  const minRange = (atr14 && atr14 > 0) ? Math.max(1.8 * avgRange20, 1.5 * atr14) : 1.8 * avgRange20;
  const isLargeEnough = barRange >= minRange;

  // Volume confirm: relVol20 >= 1.30 (fallback since relVolTOD not yet implemented)
  // TODO: replace relVol20 with relVolTOD (same-time-of-day baseline across sessions)
  const volConfirm = relVol20 !== null && relVol20 >= 1.30;

  const bullish = c.c > c.o && isLargeEnough && bodyPercent >= 0.6 && closeNearHigh;
  const bearish = c.c < c.o && isLargeEnough && bodyPercent >= 0.6 && closeNearLow;

  if (!bullish && !bearish) {
    return { active: false, direction: 'none', rangeMultiple: round(rangeMultiple, 2), bodyPercent: round(bodyPercent, 2), closeQuality, volConfirm, message: 'No elephant bar' };
  }

  const direction = bullish ? 'bullish' : 'bearish';
  return {
    active: true,
    direction,
    rangeMultiple: round(rangeMultiple, 2),
    bodyPercent: round(bodyPercent, 2),
    closeQuality,
    volConfirm,
    message: `Elephant Bar ${direction} — ${round(rangeMultiple, 1)}x avg range${volConfirm ? ' + vol' : ''}`,
  };
}

// ── Color Change ──────────────────────────────────────────────────────────────

function calcColorChange(candles2m, metrics, narrowType) {
  if (!candles2m || candles2m.length < 2) return { active: false, direction: 'none' };
  const prev = candles2m[candles2m.length - 2];
  const curr = candles2m[candles2m.length - 1];

  const nearZone = metrics ? (metrics.priceToSma20Atr <= 0.35 || metrics.priceToZoneAtr <= 0.50) : false;
  const goodSetup = narrowType === 'coil_flat' || narrowType === 'attack_200';
  if (!nearZone || !goodSetup) return { active: false, direction: 'none' };

  const prevBodyHigh = Math.max(prev.o, prev.c);
  const prevBodyLow  = Math.min(prev.o, prev.c);

  if (prev.c < prev.o && curr.c > curr.o) {
    const bullEngulf = curr.c > prevBodyHigh && curr.o < prevBodyLow;
    const closeAbovePrevHigh = curr.c > prev.h;
    if (bullEngulf || closeAbovePrevHigh) return { active: true, direction: 'bullish' };
  }

  if (prev.c > prev.o && curr.c < curr.o) {
    const bearEngulf = curr.c < prevBodyLow && curr.o > prevBodyHigh;
    const closeBelowPrevLow = curr.c < prev.l;
    if (bearEngulf || closeBelowPrevLow) return { active: true, direction: 'bearish' };
  }

  return { active: false, direction: 'none' };
}

// ── Pullback ──────────────────────────────────────────────────────────────────

function calcPullback(metrics, rsi14) {
  if (!metrics) return { active: false, direction: 'none' };
  const { priceToZoneAtr, slope20Atr } = metrics;
  if (priceToZoneAtr <= 0.40 && slope20Atr !== null && slope20Atr > 0.15) {
    const dir = rsi14 !== null ? (rsi14 >= 50 ? 'bullish' : 'bearish') : 'none';
    return { active: true, direction: dir };
  }
  return { active: false, direction: 'none' };
}

// ── Narrow Metrics (v2) ───────────────────────────────────────────────────────

function calcNarrowMetrics(candles2m, indicators) {
  const { sma20, sma200, atr14 } = indicators;
  if (!atr14 || atr14 === 0 || !sma20) return null;

  const closes = candles2m.map((c) => c.c);
  const n = closes.length;
  const price = candles2m[n - 1].c;

  const zoneMid = sma200 !== null ? (sma20 + sma200) / 2 : sma20;
  const priceToZoneAtr = Math.abs(price - zoneMid) / atr14;
  const smaGapAtr = sma200 !== null ? Math.abs(sma20 - sma200) / atr14 : null;
  const priceToSma20Atr = Math.abs(price - sma20) / atr14;

  let slope20Atr = null;
  if (n >= 25) {
    const s20ago = sma(closes.slice(0, n - 5), 20);
    if (s20ago !== null) slope20Atr = Math.abs(sma20 - s20ago) / atr14;
  }

  let slope200Atr = null;
  if (sma200 !== null && n >= 220) {
    const s200ago = sma(closes.slice(0, n - 20), 200);
    if (s200ago !== null) slope200Atr = Math.abs(sma200 - s200ago) / atr14;
  }

  let rangeCompression = null;
  if (n >= 65) {
    const last5 = candles2m.slice(n - 5).map((c) => c.h - c.l);
    const prev60 = candles2m.slice(n - 65, n - 5).map((c) => c.h - c.l);
    const med60 = median(prev60);
    if (med60 > 0) rangeCompression = median(last5) / med60;
  }

  let nr7 = false;
  if (n >= 7) {
    const last7 = candles2m.slice(n - 7).map((c) => c.h - c.l);
    nr7 = last7[6] === Math.min(...last7);
  }

  return { zoneMid, priceToZoneAtr, smaGapAtr, priceToSma20Atr, slope20Atr, slope200Atr, rangeCompression, nr7 };
}

// ── Narrow Type ───────────────────────────────────────────────────────────────

function calcNarrowType(metrics) {
  if (!metrics) return 'none';
  const { smaGapAtr, priceToZoneAtr, slope20Atr, slope200Atr, rangeCompression, nr7 } = metrics;
  if (smaGapAtr === null) return 'none';

  const baseOk = smaGapAtr <= 0.40 && priceToZoneAtr <= 0.50;
  const slope200Ok = slope200Atr === null || slope200Atr <= 0.15;
  if (!baseOk || !slope200Ok) return 'none';

  const slope20Flat = slope20Atr === null || slope20Atr <= 0.30;
  const compressed = (rangeCompression !== null && rangeCompression <= 0.85) || nr7;
  if (slope20Flat && compressed) return 'coil_flat';

  const slope20Rising = slope20Atr !== null && slope20Atr > 0.30;
  const compressedLoose = (rangeCompression !== null && rangeCompression <= 1.00) || nr7;
  if (slope20Rising && compressedLoose) return 'attack_200';

  return 'none';
}

// ── Narrow Score ──────────────────────────────────────────────────────────────

function calcNarrowScore(metrics, narrowType, rsi14, atrPct120, bbwPct120) {
  if (!metrics) return 0;
  const { smaGapAtr, priceToZoneAtr, slope20Atr, slope200Atr, rangeCompression, nr7 } = metrics;

  let score = 0;
  if (smaGapAtr !== null && smaGapAtr <= 0.40) score += 25;
  if (priceToZoneAtr <= 0.50) score += 20;
  if (slope200Atr !== null && slope200Atr <= 0.15) score += 15;
  if (slope20Atr === null || slope20Atr <= 0.30 || narrowType === 'attack_200') score += 15;

  // Compression check — includes ATR and BBW percentile if available
  const compressionOk =
    (rangeCompression !== null && rangeCompression <= 0.85) ||
    nr7 ||
    (atrPct120 !== null && atrPct120 <= 45) ||
    (bbwPct120 !== null && bbwPct120 <= 35);
  if (compressionOk) score += 15;

  if (rsi14 !== null && rsi14 >= 40 && rsi14 <= 60) score += 10;

  return Math.min(100, score);
}

// ── Breakout Already Occurred ─────────────────────────────────────────────────

// structurePass = SMAs close together (smaGapAtr <= 0.40)
// breakout = price already > 0.50 ATR past longTrigger OR < 0.50 ATR below shortTrigger
function calcBreakoutOccurred(metrics, price, longTrigger, shortTrigger, atr14) {
  if (!metrics || metrics.smaGapAtr === null || !atr14 || atr14 === 0) return false;
  const structurePass = metrics.smaGapAtr <= 0.40;
  if (!structurePass || metrics.priceToZoneAtr <= 1.00) return false;
  if (longTrigger !== null && price > longTrigger + 0.50 * atr14) return true;
  if (shortTrigger !== null && price < shortTrigger - 0.50 * atr14) return true;
  return false;
}

// ── Trade Score ───────────────────────────────────────────────────────────────

function calcTradeScore({ narrowScore, metrics, state, rsi14, position, elephantBar, threeFingerSpread, breakoutAlreadyOccurred, price, longTrigger, shortTrigger }) {
  let score = narrowScore;
  const trendDir = position > 0 ? 'bullish' : position < 0 ? 'bearish' : 'none';

  if (elephantBar.active && elephantBar.direction === trendDir && trendDir !== 'none') score += 20;

  // Breakout trigger confirm
  if (longTrigger !== null && position >= 0 && price > longTrigger) score += 15;
  else if (shortTrigger !== null && position <= 0 && price < shortTrigger) score += 15;

  if (rsi14 !== null) {
    if (trendDir === 'bullish' && rsi14 > 50) score += 10;
    else if (trendDir === 'bearish' && rsi14 < 50) score += 10;
  }
  if (threeFingerSpread.active) score -= 30;
  if (breakoutAlreadyOccurred) score -= 30;
  if (state === 'WIDE_AVOID' || state === 'THREE_FINGER_SPREAD_AVOID') score -= 25;
  if (metrics && metrics.priceToZoneAtr > 1.0) score -= 15;

  return Math.max(0, Math.min(100, score));
}

function scoreLabel(score) {
  if (score >= 60) return 'Strong';
  if (score >= 35) return 'Watch';
  if (score >= 15) return 'Weak';
  return 'Avoid';
}

// ── Event Type ────────────────────────────────────────────────────────────────

function deriveEventType({ state, signal, position, threeFingerSpread, elephantBar, colorChange, breakoutAlreadyOccurred }) {
  if (breakoutAlreadyOccurred) return 'BREAKOUT_ALREADY_OCCURRED';

  if (threeFingerSpread.active) {
    const oppDir = threeFingerSpread.direction === 'bullish' ? 'bearish' : 'bullish';
    if (elephantBar.active && elephantBar.direction === oppDir) return 'WIDE_REVERSAL_WATCH';
    return 'THREE_FINGER_SPREAD_AVOID';
  }

  if (state === 'HIGH_QUALITY_NARROW' || state === 'MEDIUM_NARROW') {
    if (elephantBar.active && elephantBar.direction === 'bullish' && position >= 0) return 'BULLISH_ELEPHANT_BREAKOUT';
    if (elephantBar.active && elephantBar.direction === 'bearish' && position <= 0) return 'BEARISH_ELEPHANT_BREAKDOWN';
    if (colorChange.active && colorChange.direction === 'bullish') return 'BULLISH_COLOR_CHANGE';
    if (colorChange.active && colorChange.direction === 'bearish') return 'BEARISH_COLOR_CHANGE';
    return 'NARROW_WAIT';
  }

  if (state === 'REGULAR_TREND') {
    if (elephantBar.active && elephantBar.direction === 'bullish') return 'BULLISH_ELEPHANT_BREAKOUT';
    if (elephantBar.active && elephantBar.direction === 'bearish') return 'BEARISH_ELEPHANT_BREAKDOWN';
    if (signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED' || signal === 'WAIT_PULLBACK') {
      return 'REGULAR_PULLBACK';
    }
    return 'NO_TRADE';
  }

  if (state === 'WIDE_AVOID' || state === 'THREE_FINGER_SPREAD_AVOID') return 'THREE_FINGER_SPREAD_AVOID';

  return 'NO_TRADE';
}

// ── Action & Reason (svenska) ─────────────────────────────────────────────────

function deriveActionSv(state, eventType, breakoutAlreadyOccurred, threeFingerSpread) {
  if (threeFingerSpread.active) return 'Priset är för långt ifrån. Jaga inte.';
  if (breakoutAlreadyOccurred) return 'Utbrottet har redan hänt. Vänta på ny setup.';
  if (state === 'HIGH_QUALITY_NARROW') {
    if (eventType === 'BULLISH_ELEPHANT_BREAKOUT') return 'Bevaka long över trigger';
    if (eventType === 'BEARISH_ELEPHANT_BREAKDOWN') return 'Bevaka short under trigger';
    if (eventType === 'BULLISH_COLOR_CHANGE') return 'Färgbyte uppåt i narrow-zon. Bevaka long.';
    if (eventType === 'BEARISH_COLOR_CHANGE') return 'Färgbyte nedåt i narrow-zon. Bevaka short.';
    return 'Bra ihoptryckt läge. Vänta på tydlig breakout.';
  }
  if (state === 'MEDIUM_NARROW') return 'Okej narrow-läge. Vänta på bättre bekräftelse.';
  if (state === 'WIDE_AVOID' || state === 'THREE_FINGER_SPREAD_AVOID') return 'Priset är för långt ifrån. Jaga inte.';
  if (state === 'REGULAR_TREND') return 'Vanlig trend. Ingen perfekt setup just nu.';
  return 'Ingen handel möjlig.';
}

function deriveReasonSv(state, narrowType, metrics, rsi14, breakoutAlreadyOccurred, threeFingerSpread, colorChange) {
  const r = [];

  if (threeFingerSpread.active) {
    r.push('Priset är mer än 1.5 ATR från SMA20 — för långt ifrån.');
    r.push('SMA20 är också långt från SMA200 — ingen bra entry-zon.');
    return r;
  }

  if (breakoutAlreadyOccurred) {
    r.push('SMA20 och SMA200 är nära — zonen var bra.');
    r.push('Priset har brutit mer än 1 ATR från zonen.');
    r.push('Vänta tills priset pullbackar till zonen igen.');
    return r;
  }

  if (metrics) {
    const { smaGapAtr, priceToZoneAtr, slope200Atr, rangeCompression, nr7 } = metrics;
    if (smaGapAtr !== null) {
      r.push(smaGapAtr <= 0.40
        ? `SMA-gap ${round(smaGapAtr, 2)} ATR — SMAs är nära varandra.`
        : `SMA-gap ${round(smaGapAtr, 2)} ATR — för brett för bästa setup.`);
    }
    r.push(priceToZoneAtr <= 0.50
      ? `Pris ${round(priceToZoneAtr, 2)} ATR från zonen — nära.`
      : `Pris ${round(priceToZoneAtr, 2)} ATR från zonen — lite för långt.`);
    if (nr7) r.push('NR7 — smalaste candle av senaste 7. Tydlig kompression.');
    else if (rangeCompression !== null && rangeCompression <= 0.85) r.push(`Kompression ${round(rangeCompression, 2)}x — candlarna krymper.`);
    if (narrowType === 'coil_flat') r.push('Typ Coil/Flat — båda SMAs är flacka, klassisk fjäder.');
    else if (narrowType === 'attack_200') r.push('Typ Attack 200 — SMA20 rör sig mot SMA200, möjlig kollision.');
  }

  if (colorChange.active) {
    r.push(colorChange.direction === 'bullish'
      ? 'Färgbyte uppåt — grön candle engulfar röd i zonen.'
      : 'Färgbyte nedåt — röd candle engulfar grön i zonen.');
  }

  if (rsi14 !== null) {
    if (rsi14 >= 40 && rsi14 <= 60) r.push(`RSI ${round(rsi14, 1)} — neutral, bra för vänta-läge.`);
    else if (rsi14 > 70) r.push(`RSI ${round(rsi14, 1)} — överköpt, försiktig med long.`);
    else if (rsi14 < 30) r.push(`RSI ${round(rsi14, 1)} — översålt, försiktig med short.`);
  }

  if (state === 'WIDE_AVOID') r.push('Priset är för långt från SMA-zonen.');
  if (r.length === 0) r.push('Ingen tydlig setup just nu.');

  return r.slice(0, 5);
}

// ── Main classifier ───────────────────────────────────────────────────────────

function classifyNarrowState({ symbol, price, candles2m, indicators, lastUpdate }) {
  const {
    ema9, ema21, ema50, sma20, sma50, sma200, vwap, vwapDistancePct,
    rsi14, atr14, recent5, avgRange20, bbw20, bbwPct120, relVol20, atrPct120,
  } = indicators;

  if (!sma20 || !atr14 || !recent5) {
    return makeResult(symbol, price, 'NO_TRADE', 0, null, null, indicators, lastUpdate, 'Insufficient indicator data');
  }

  // ── Zone (8-bar) for triggers — per spec ──────────────────────────────────
  const zone8 = recentRange(candles2m, 8);
  const tick = 0.01;
  const longTrigger  = zone8 ? round(zone8.high + Math.max(0.05 * atr14, tick * 2), 2) : null;
  const shortTrigger = zone8 ? round(zone8.low  - Math.max(0.05 * atr14, tick * 2), 2) : null;
  const target1Long  = longTrigger  ? round(longTrigger  + atr14 * 1.0, 2) : null;
  const target2Long  = longTrigger  ? round(longTrigger  + atr14 * 2.0, 2) : null;
  const target1Short = shortTrigger ? round(shortTrigger - atr14 * 1.0, 2) : null;
  const target2Short = shortTrigger ? round(shortTrigger - atr14 * 2.0, 2) : null;
  const invalidationLong  = zone8 ? round(zone8.low  - atr14 * 0.15, 2) : null;
  const invalidationShort = zone8 ? round(zone8.high + atr14 * 0.15, 2) : null;

  const smaGap = sma200 !== null ? Math.abs(sma20 - sma200) : null;
  const smaGapPct = sma200 !== null && price > 0 ? (smaGap / price) * 100 : null;

  const smaHigh = sma200 !== null ? Math.max(sma20, sma200) : sma20;
  const smaLow  = sma200 !== null ? Math.min(sma20, sma200) : sma20;

  let position = 0;
  if (price >= smaLow && price <= smaHigh) {
    position = 0;
  } else if (price > smaHigh) {
    const distPct = ((price - smaHigh) / price) * 100;
    if (distPct < 0.35) position = 1;
    else if (distPct < 0.80) position = 2;
    else position = 3;
  } else {
    const distPct = ((smaLow - price) / price) * 100;
    if (distPct < 0.35) position = -1;
    else if (distPct < 0.80) position = -2;
    else position = -3;
  }

  const compressionRatio = recent5.range / atr14;
  const isTightCompression = compressionRatio < 0.4;
  const isCompressed       = compressionRatio < 0.7;

  // ── V2 metrics ────────────────────────────────────────────────────────────
  const metrics              = calcNarrowMetrics(candles2m, indicators);
  const narrowType           = calcNarrowType(metrics);
  const narrowScore          = calcNarrowScore(metrics, narrowType, rsi14, atrPct120, bbwPct120);

  // ── Position code ─────────────────────────────────────────────────────────
  const priceToZoneAtrVal = metrics ? metrics.priceToZoneAtr : (sma200 ? Math.abs(price - (sma20 + sma200) / 2) / atr14 : 0);
  const positionCode = calcPositionCode(price, sma20, sma200, priceToZoneAtrVal);
  const positionLabelSv = POSITION_LABELS_SV[positionCode] || positionCode;

  // ── Signals ───────────────────────────────────────────────────────────────
  const threeFingerSpread    = calcThreeFingerSpread({ price, sma20, sma200, atr14 });
  const elephantBar          = calcElephantBar(candles2m, avgRange20, atr14, relVol20);
  const colorChange          = calcColorChange(candles2m, metrics, narrowType);
  const pullback             = calcPullback(metrics, rsi14);
  const breakoutAlreadyOccurred = calcBreakoutOccurred(metrics, price, longTrigger, shortTrigger, atr14);

  // ── State assignment ──────────────────────────────────────────────────────
  let state;
  let confidence;

  if (threeFingerSpread.active) {
    state = 'THREE_FINGER_SPREAD_AVOID';
    confidence = 10;
  } else if (breakoutAlreadyOccurred) {
    state = 'BREAKOUT_ALREADY_OCCURRED';
    confidence = 20;
  } else if (narrowScore >= 80) {
    state = 'HIGH_QUALITY_NARROW';
    confidence = 90;
  } else if (narrowScore >= 60) {
    state = 'MEDIUM_NARROW';
    confidence = 55;
  } else {
    const smaMedium = smaGapPct !== null && smaGapPct < 1.50;
    if (sma200 === null) {
      if (isTightCompression && Math.abs(price - sma20) / price < 0.003) {
        state = 'MEDIUM_NARROW'; confidence = 35;
      } else {
        state = 'NO_TRADE'; confidence = 0;
      }
    } else if (smaMedium && Math.abs(position) <= 2) {
      state = 'REGULAR_TREND';
      confidence = Math.abs(position) <= 1 && isCompressed ? 40 : 30;
    } else if (Math.abs(position) <= 2) {
      state = 'REGULAR_TREND';
      confidence = 25;
    } else {
      state = 'WIDE_AVOID';
      confidence = 10;
    }
  }

  if (rsi14 !== null) {
    if ((state === 'HIGH_QUALITY_NARROW' || state === 'MEDIUM_NARROW') && rsi14 > 42 && rsi14 < 58) {
      confidence = Math.min(100, confidence + 5);
    }
    if (state === 'WIDE_AVOID' && (rsi14 > 75 || rsi14 < 25)) {
      confidence = Math.min(100, confidence + 8);
    }
  }
  if (isTightCompression && state !== 'WIDE_AVOID' && state !== 'NO_TRADE' &&
      state !== 'THREE_FINGER_SPREAD_AVOID' && state !== 'BREAKOUT_ALREADY_OCCURRED') {
    confidence = Math.min(100, confidence + 5);
  }

  // ── Signal ────────────────────────────────────────────────────────────────
  let signal = 'WAIT';
  if (['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID', 'NO_TRADE', 'BREAKOUT_ALREADY_OCCURRED'].includes(state)) {
    signal = 'NO_TRADE';
  } else if (position === 0) {
    signal = 'WAIT';
  } else if (position === 1 && (state === 'HIGH_QUALITY_NARROW' || state === 'MEDIUM_NARROW')) {
    signal = 'LONG_WATCH';
  } else if (position === 1 && state === 'REGULAR_TREND') {
    signal = 'LONG_TRIGGERED';
  } else if (position === -1 && (state === 'HIGH_QUALITY_NARROW' || state === 'MEDIUM_NARROW')) {
    signal = 'SHORT_WATCH';
  } else if (position === -1 && state === 'REGULAR_TREND') {
    signal = 'SHORT_TRIGGERED';
  } else if (position >= 2 || position <= -2) {
    signal = 'WAIT_PULLBACK';
  }

  if (threeFingerSpread.active && signal !== 'NO_TRADE') signal = 'WAIT';

  // ── Event type ────────────────────────────────────────────────────────────
  const eventType = deriveEventType({ state, signal, position, threeFingerSpread, elephantBar, colorChange, breakoutAlreadyOccurred });

  if (eventType === 'BULLISH_ELEPHANT_BREAKOUT' && !threeFingerSpread.active) signal = 'LONG_TRIGGERED';
  if (eventType === 'BEARISH_ELEPHANT_BREAKDOWN' && !threeFingerSpread.active) signal = 'SHORT_TRIGGERED';
  if (eventType === 'WIDE_REVERSAL_WATCH') signal = 'WIDE_REVERSAL_WATCH';

  // ── Scores ────────────────────────────────────────────────────────────────
  const tradeScore = calcTradeScore({ narrowScore, metrics, state, rsi14, position, elephantBar, threeFingerSpread, breakoutAlreadyOccurred, price, longTrigger, shortTrigger });
  const signalScore = tradeScore;
  const slabel = scoreLabel(tradeScore);

  // ── Swedish text ──────────────────────────────────────────────────────────
  const actionSv = deriveActionSv(state, eventType, breakoutAlreadyOccurred, threeFingerSpread);
  const reasonSv = deriveReasonSv(state, narrowType, metrics, rsi14, breakoutAlreadyOccurred, threeFingerSpread, colorChange);

  return {
    symbol,
    price: round(price, 2),
    state,
    position,
    positionCode,
    positionLabelSv,
    signal,
    confidence,
    ema9:    ema9    ? round(ema9,    4) : null,
    ema21:   ema21   ? round(ema21,   4) : null,
    ema50:   ema50   ? round(ema50,   4) : null,
    sma20:   sma20   ? round(sma20,   2) : null,
    sma50:   sma50   ? round(sma50,   2) : null,
    sma200:  sma200  ? round(sma200,  2) : null,
    vwap:    vwap    ? round(vwap,    4) : null,
    vwapDistancePct: vwapDistancePct !== null ? round(vwapDistancePct, 4) : null,
    smaGap:  smaGap  ? round(smaGap,  4) : null,
    smaGapPct: smaGapPct ? round(smaGapPct, 3) : null,
    rsi14:   rsi14   ? round(rsi14,   1) : null,
    atr14:   atr14   ? round(atr14,   4) : null,
    recentHigh: recent5 ? round(recent5.high,  2) : null,
    recentLow:  recent5 ? round(recent5.low,   2) : null,
    recentRange: recent5 ? round(recent5.range, 4) : null,
    zoneHigh:   zone8 ? round(zone8.high, 2) : null,
    zoneLow:    zone8 ? round(zone8.low,  2) : null,
    compressionRatio: round(compressionRatio, 3),
    longTrigger,
    shortTrigger,
    invalidationLong,
    invalidationShort,
    target1Long,
    target2Long,
    target1Short,
    target2Short,
    candleCount: candles2m.length,
    lastUpdate,
    note: null,
    // ── V2 fields ──
    narrowType,
    narrowScore,
    tradeScore,
    signalScore,
    scoreLabel: slabel,
    breakoutAlreadyOccurred,
    actionSv,
    reasonSv,
    priceToZoneAtr:    metrics ? round(metrics.priceToZoneAtr, 2) : null,
    smaGapAtr:         metrics && metrics.smaGapAtr !== null ? round(metrics.smaGapAtr, 2) : null,
    zoneMid:           metrics ? round(metrics.zoneMid, 2) : null,
    rangeCompression:  metrics && metrics.rangeCompression !== null ? round(metrics.rangeCompression, 3) : null,
    nr7:               metrics ? metrics.nr7 : false,
    slope20Atr:        metrics && metrics.slope20Atr !== null ? round(metrics.slope20Atr, 3) : null,
    slope200Atr:       metrics && metrics.slope200Atr !== null ? round(metrics.slope200Atr, 3) : null,
    bbw20:             bbw20 !== null ? round(bbw20, 4) : null,
    bbwPct120:         bbwPct120 !== null ? round(bbwPct120, 1) : null,
    relVol20:          relVol20 !== null ? round(relVol20, 2) : null,
    atrPct120:         atrPct120 !== null ? round(atrPct120, 1) : null,
    threeFingerSpread,
    elephantBar,
    colorChange,
    pullback,
    eventType,
  };
}

function makeResult(symbol, price, state, confidence, longTrigger, shortTrigger, indicators, lastUpdate, note) {
  const tfs = { active: false, direction: 'none', strength: 'none', priceToSma20Atr: null, sma20ToSma200Atr: null, message: 'Insufficient data' };
  const eb  = { active: false, direction: 'none', rangeMultiple: null, bodyPercent: null, closeQuality: 'middle', volConfirm: false, message: 'Insufficient data' };
  const cc  = { active: false, direction: 'none' };
  const pb  = { active: false, direction: 'none' };
  return {
    symbol,
    price: price ? round(price, 2) : null,
    state,
    position: null,
    positionCode: 'in_zone',
    positionLabelSv: 'I zonen',
    signal: 'NO_TRADE',
    confidence,
    ema9:    indicators?.ema9   ? round(indicators.ema9,   4) : null,
    ema21:   indicators?.ema21  ? round(indicators.ema21,  4) : null,
    ema50:   indicators?.ema50  ? round(indicators.ema50,  4) : null,
    sma20:   indicators?.sma20  ? round(indicators.sma20,  2) : null,
    sma50:   indicators?.sma50  ? round(indicators.sma50,  2) : null,
    sma200:  indicators?.sma200 ? round(indicators.sma200, 2) : null,
    vwap:    indicators?.vwap   ? round(indicators.vwap,   4) : null,
    vwapDistancePct: indicators?.vwapDistancePct !== null && indicators?.vwapDistancePct !== undefined
      ? round(indicators.vwapDistancePct, 4)
      : null,
    smaGap: null, smaGapPct: null,
    rsi14:   indicators?.rsi14  ? round(indicators.rsi14,  1) : null,
    atr14:   indicators?.atr14  ? round(indicators.atr14,  4) : null,
    recentHigh: null, recentLow: null, recentRange: null,
    zoneHigh: null, zoneLow: null,
    compressionRatio: null,
    longTrigger, shortTrigger,
    invalidationLong: null, invalidationShort: null,
    target1Long: null, target2Long: null, target1Short: null, target2Short: null,
    candleCount: 0,
    lastUpdate,
    note,
    narrowType: 'none',
    narrowScore: 0,
    tradeScore: 0,
    signalScore: 0,
    scoreLabel: 'Avoid',
    breakoutAlreadyOccurred: false,
    actionSv: 'Ingen handel möjlig.',
    reasonSv: ['Otillräcklig data för analys.'],
    priceToZoneAtr: null,
    smaGapAtr: null,
    zoneMid: null,
    rangeCompression: null,
    nr7: false,
    slope20Atr: null,
    slope200Atr: null,
    bbw20: null,
    bbwPct120: null,
    relVol20: null,
    atrPct120: null,
    threeFingerSpread: tfs,
    elephantBar: eb,
    colorChange: cc,
    pullback: pb,
    eventType: 'NO_TRADE',
  };
}

module.exports = { classifyNarrowState };
