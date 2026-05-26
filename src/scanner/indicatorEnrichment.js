'use strict';

const { sma, atr } = require('./indicators');

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = num(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeCandle(c) {
  const timestamp = c?.t || c?.ts || c?.timestamp || null;
  return {
    t: timestamp,
    ts: timestamp,
    o: num(c?.o ?? c?.open),
    h: num(c?.h ?? c?.high),
    l: num(c?.l ?? c?.low),
    c: num(c?.c ?? c?.close),
    v: num(c?.v ?? c?.volume),
  };
}

function normalizeCandles(candles) {
  return (candles || [])
    .map(normalizeCandle)
    .filter((c) => c.t && [c.o, c.h, c.l, c.c].every((v) => v !== null))
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

function ema(values, period) {
  const clean = (values || []).map(num).filter((v) => v !== null);
  if (clean.length < period) return null;
  const k = 2 / (period + 1);
  let value = clean.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < clean.length; i += 1) {
    value = clean[i] * k + value * (1 - k);
  }
  return value;
}

function calcVwap(candles) {
  const clean = normalizeCandles(candles);
  if (!clean.length) return null;
  const latestDay = clean[clean.length - 1].t.slice(0, 10);
  const session = clean.filter((c) => c.t.slice(0, 10) === latestDay && c.v !== null && c.v > 0);
  const source = session.length ? session : clean.filter((c) => c.v !== null && c.v > 0);
  if (!source.length) return null;
  const volume = source.reduce((sum, c) => sum + c.v, 0);
  if (!volume) return null;
  const pv = source.reduce((sum, c) => {
    const typical = (c.h + c.l + c.c) / 3;
    return sum + typical * c.v;
  }, 0);
  return pv / volume;
}

function calcRvol(candles, period = 20) {
  const clean = normalizeCandles(candles).filter((c) => c.v !== null && c.v > 0);
  if (clean.length < period + 1) return null;
  const current = clean[clean.length - 1].v;
  const prev = clean.slice(-(period + 1), -1);
  const avg = prev.reduce((sum, c) => sum + c.v, 0) / prev.length;
  if (!avg) return null;
  return current / avg;
}

function classifyVolumeState(rvol) {
  const v = num(rvol);
  if (v === null) return 'unknown';
  if (v < 0.7) return 'weak';
  if (v >= 1.3) return 'strong';
  return 'normal';
}

function computeCandleScore2m(candles) {
  const sorted = normalizeCandles(candles).slice(-5);
  if (!sorted.length) {
    return {
      greenCount5: 0,
      redCount5: 0,
      greenCount3: 0,
      redCount3: 0,
      netMovePct5: null,
      netMovePct3: null,
      higherHighsCount: 0,
      higherLowsCount: 0,
      volumeComment: 'Volym saknas',
      scoreDirection: 'unknown',
      reasonSv: '2m candles saknas för candle-score.',
    };
  }

  const last3 = sorted.slice(-3);
  const countGreen = (arr) => arr.filter((c) => c.c > c.o).length;
  const countRed = (arr) => arr.filter((c) => c.c < c.o).length;
  const netMovePct = (arr) => {
    const first = arr[0]?.c;
    const last = arr[arr.length - 1]?.c;
    if (!first || !last) return null;
    return round(((last - first) / first) * 100, 3);
  };

  let higherHighsCount = 0;
  let lowerHighsCount = 0;
  let higherLowsCount = 0;
  let lowerLowsCount = 0;
  let volumeUpCount = 0;
  let volumeDownCount = 0;

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].h > sorted[i - 1].h) higherHighsCount += 1;
    if (sorted[i].h < sorted[i - 1].h) lowerHighsCount += 1;
    if (sorted[i].l > sorted[i - 1].l) higherLowsCount += 1;
    if (sorted[i].l < sorted[i - 1].l) lowerLowsCount += 1;
    if (sorted[i].v !== null && sorted[i - 1].v !== null) {
      if (sorted[i].v > sorted[i - 1].v) volumeUpCount += 1;
      if (sorted[i].v < sorted[i - 1].v) volumeDownCount += 1;
    }
  }

  const greenCount5 = countGreen(sorted);
  const redCount5 = countRed(sorted);
  const greenCount3 = countGreen(last3);
  const redCount3 = countRed(last3);
  const netMovePct5 = netMovePct(sorted);
  const netMovePct3 = netMovePct(last3);
  const volumeComment = volumeUpCount > volumeDownCount
    ? 'Volymen ökar'
    : volumeDownCount > volumeUpCount
      ? 'Volymen sjunker'
      : 'Volymen är blandad';

  const bullish = greenCount3 >= 2 &&
    netMovePct3 > 0 &&
    netMovePct5 > 0 &&
    higherLowsCount >= 2 &&
    lowerHighsCount <= 1;
  const bearish = redCount3 >= 2 &&
    netMovePct3 < 0 &&
    netMovePct5 < 0 &&
    lowerHighsCount >= 2 &&
    lowerLowsCount >= 2;
  const scoreDirection = bullish ? 'bullish' : bearish ? 'bearish' : 'neutral';

  return {
    greenCount5,
    redCount5,
    greenCount3,
    redCount3,
    netMovePct5,
    netMovePct3,
    higherHighsCount,
    higherLowsCount,
    volumeComment,
    scoreDirection,
    reasonSv: scoreDirection === 'bullish'
      ? 'Senaste 2m candles lutar uppåt med positiv nettorörelse och stigande lows.'
      : scoreDirection === 'bearish'
        ? 'Senaste 2m candles lutar nedåt med negativ nettorörelse och fallande struktur.'
        : 'Senaste 2m candles ger ingen tydlig riktning.',
  };
}

function tfDirectionFromCandles(candles) {
  const clean = normalizeCandles(candles);
  if (clean.length < 3) return 'unknown';
  const first = clean[0].c;
  const last = clean[clean.length - 1].c;
  const a = atr(clean, Math.min(14, clean.length - 1));
  if (!first || !last) return 'unknown';
  const move = last - first;
  const minMove = a ? a * 0.15 : first * 0.0004;
  if (move > minMove) return 'bullish';
  if (move < -minMove) return 'bearish';
  return 'neutral';
}

function deriveTimeframesFromCandles(candles2m) {
  const clean = normalizeCandles(candles2m);
  const tf2m = tfDirectionFromCandles(clean.slice(-3));
  const tf5m = tfDirectionFromCandles(clean.slice(-5));
  const tf10m = tfDirectionFromCandles(clean.slice(-10));
  const tf15m = tfDirectionFromCandles(clean.slice(-15));
  const tf30m = tfDirectionFromCandles(clean.slice(-30));
  const tf1h = tfDirectionFromCandles(clean.slice(-60));
  const values = [tf1h, tf30m, tf15m, tf10m, tf5m, tf2m];
  const bull = values.filter((v) => v === 'bullish').length;
  const bear = values.filter((v) => v === 'bearish').length;
  return {
    timeframeAgreement: { tf1h, tf30m, tf15m, tf10m, tf5m, tf2m },
    agreementCount: Math.max(bull, bear),
  };
}

function enrichIndicatorsFromCandles(base = {}, candles = []) {
  const clean = normalizeCandles(candles);
  const closes = clean.map((c) => c.c);
  const price = num(base.price ?? base.priceAtSignal ?? base.entryPrice ?? clean[clean.length - 1]?.c);
  const vwap = num(base.vwap) ?? calcVwap(clean);
  const rvol = num(base.rvol ?? base.relVol20) ?? calcRvol(clean);
  const vwapDistancePct = num(base.vwapDistancePct) ??
    (price !== null && vwap ? ((price - vwap) / vwap) * 100 : null);
  const tf = deriveTimeframesFromCandles(clean);

  return {
    ema9: round(num(base.ema9) ?? ema(closes, 9), 4),
    ema21: round(num(base.ema21) ?? ema(closes, 21), 4),
    ema50: round(num(base.ema50) ?? ema(closes, 50), 4),
    sma20: round(num(base.sma20) ?? sma(closes, 20), 4),
    sma50: round(num(base.sma50) ?? sma(closes, 50), 4),
    sma200: round(num(base.sma200) ?? sma(closes, 200), 4),
    vwap: round(vwap, 4),
    vwapDistancePct: round(vwapDistancePct, 4),
    rvol: round(rvol, 4),
    relVol20: round(num(base.relVol20) ?? rvol, 4),
    volumeState: base.volumeState || classifyVolumeState(rvol),
    atr14: round(num(base.atr14) ?? atr(clean, 14), 4),
    candleScore2m: base.candleScore2m || computeCandleScore2m(clean),
    timeframeAgreement: base.timeframeAgreement || base.timeframes || tf.timeframeAgreement,
    agreementCount: base.agreementCount ?? tf.agreementCount,
    tf2m: base.tf2m ?? base.tf2mDirection ?? base.timeframeAgreement?.tf2m ?? base.timeframes?.tf2m ?? tf.timeframeAgreement.tf2m,
    tf5m: base.tf5m ?? base.tf5mDirection ?? base.timeframeAgreement?.tf5m ?? base.timeframes?.tf5m ?? tf.timeframeAgreement.tf5m,
    tf10m: base.tf10m ?? base.timeframeAgreement?.tf10m ?? base.timeframes?.tf10m ?? tf.timeframeAgreement.tf10m,
    tf15m: base.tf15m ?? base.tf15mDirection ?? base.timeframeAgreement?.tf15m ?? base.timeframes?.tf15m ?? tf.timeframeAgreement.tf15m,
    tf30m: base.tf30m ?? base.timeframeAgreement?.tf30m ?? base.timeframes?.tf30m ?? tf.timeframeAgreement.tf30m,
    tf1h: base.tf1h ?? base.timeframeAgreement?.tf1h ?? base.timeframes?.tf1h ?? tf.timeframeAgreement.tf1h,
  };
}

module.exports = {
  calcRvol,
  calcVwap,
  classifyVolumeState,
  computeCandleScore2m,
  deriveTimeframesFromCandles,
  ema,
  enrichIndicatorsFromCandles,
  normalizeCandles,
};
