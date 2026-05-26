'use strict';

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(closes.length - (period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(candles.length - (period + 1));
  const trs = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function recentRange(candles, bars = 5) {
  if (candles.length < bars) return null;
  const slice = candles.slice(candles.length - bars);
  const high = Math.max(...slice.map((c) => c.h));
  const low = Math.min(...slice.map((c) => c.l));
  return { high, low, range: high - low };
}

function avgBarRange(candles, bars = 20) {
  if (candles.length < bars) return null;
  const slice = candles.slice(candles.length - bars);
  const total = slice.reduce((a, c) => a + (c.h - c.l), 0);
  return total / bars;
}

// Bollinger Band Width = (upper - lower) / middle = 4σ / SMA
function bbWidth(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  if (mean <= 0) return null;
  const variance = slice.reduce((a, x) => a + (x - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return (4 * stdDev) / mean;
}

// BBWidth now vs BBWidth from 120 bars ago, expressed as percentage
// <= 35 means current volatility is very compressed vs historical
function calcBbwPct120(closes) {
  if (closes.length < 140) return null;
  const bbwNow = bbWidth(closes.slice(-20), 20);
  const bbwOld = bbWidth(closes.slice(-140, -120), 20);
  if (bbwNow === null || bbwOld === null || bbwOld === 0) return null;
  return (bbwNow / bbwOld) * 100;
}

// Relative volume: last bar vol / avg vol of previous 20 bars
// TODO: replace with relVolTOD (same time-of-day across sessions) for more accuracy
function calcRelVol20(candles) {
  if (candles.length < 21) return null;
  const currVol = candles[candles.length - 1].v;
  if (!currVol || currVol <= 0) return null;
  const prev20 = candles.slice(-21, -1).map((c) => c.v).filter((v) => v > 0);
  if (prev20.length === 0) return null;
  const avg = prev20.reduce((a, b) => a + b, 0) / prev20.length;
  return avg > 0 ? currVol / avg : null;
}

function calcVwap(candles) {
  if (!candles || !candles.length) return null;
  const latestTs = candles[candles.length - 1]?.t || candles[candles.length - 1]?.ts;
  const latestDay = latestTs ? String(latestTs).slice(0, 10) : null;
  const session = latestDay
    ? candles.filter((c) => String(c.t || c.ts || '').slice(0, 10) === latestDay && c.v > 0)
    : candles.filter((c) => c.v > 0);
  const source = session.length ? session : candles.filter((c) => c.v > 0);
  const volume = source.reduce((sum, c) => sum + (c.v || 0), 0);
  if (!volume) return null;
  const pv = source.reduce((sum, c) => sum + (((c.h + c.l + c.c) / 3) * c.v), 0);
  return pv / volume;
}

// ATR14 now vs ATR14 from 120 bars ago, expressed as percentage
// <= 45 means current ATR is very compressed vs historical
function calcAtrPct120(candles) {
  if (candles.length < 136) return null; // 14+1 for ATR + 120 offset + buffer
  const atrNow = atr(candles, 14);
  const atrOld = atr(candles.slice(0, candles.length - 120), 14);
  if (!atrNow || !atrOld || atrOld === 0) return null;
  return (atrNow / atrOld) * 100;
}

function calcIndicators(candles2m) {
  if (!candles2m || candles2m.length < 20) return null;
  const closes = candles2m.map((c) => c.c);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const s20 = sma(closes, 20);
  const s50 = candles2m.length >= 50 ? sma(closes, 50) : null;
  const s200 = candles2m.length >= 200 ? sma(closes, 200) : null;
  const vw = calcVwap(candles2m);
  const price = candles2m[candles2m.length - 1]?.c;
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles2m, 14);
  const recent5 = recentRange(candles2m, 5);
  const avgRange20 = avgBarRange(candles2m, 20);
  const bbw20 = bbWidth(closes, 20);
  const bbwPct120 = calcBbwPct120(closes);
  const relVol20 = calcRelVol20(candles2m);
  const atrPct120 = calcAtrPct120(candles2m);
  const vwapDistancePct = vw && price ? ((price - vw) / vw) * 100 : null;
  return {
    ema9: e9,
    ema21: e21,
    ema50: e50,
    sma20: s20,
    sma50: s50,
    sma200: s200,
    vwap: vw,
    vwapDistancePct,
    rsi14,
    atr14,
    recent5,
    avgRange20,
    bbw20,
    bbwPct120,
    relVol20,
    atrPct120,
  };
}

module.exports = { calcIndicators, sma, ema, rsi, atr, recentRange, avgBarRange, bbWidth, calcVwap };
