'use strict';

// ── GoldSigma Engine ──────────────────────────────────────────────────────────
// Strategy: EMA 9/39/81 pullback
// Timeframe: 5m | Assets: XAUUSD + any trending asset
// Long: close > EMA81, EMA9 > EMA39, low touches EMA9, green candle, volume > avg
// Short: close < EMA81, EMA9 < EMA39, high touches EMA9, red candle, volume > avg
// SL: 1% | TP: 2% | Backtest: +48% (2020-2026)

const { ema } = require('./indicators');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mode: 'paper_only',
});

const TOUCH_THRESHOLD_PCT = 0.003;

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function calcRelVol(candles, period = 20) {
  if (!candles || candles.length < period + 1) return null;
  const recent = candles[candles.length - 1];
  const slice = candles.slice(candles.length - period - 1, candles.length - 1);
  const avgVol = slice.reduce((a, c) => a + (c.v || 0), 0) / period;
  if (avgVol === 0) return null;
  return (recent.v || 0) / avgVol;
}

function applyGoldSigma(candles) {
  if (!candles || candles.length < 90) {
    return {
      goldSigma: {
        active: false,
        signal: 'none',
        reason: 'Insufficient candles (need 90+)',
        ...SAFETY,
      },
    };
  }

  const closes = candles.map((c) => c.c);
  const last = candles[candles.length - 1];

  const ema9  = ema(closes, 9);
  const ema39 = ema(closes, 39);
  const ema81 = ema(closes, 81);

  if (ema9 === null || ema39 === null || ema81 === null) {
    return {
      goldSigma: {
        active: false,
        signal: 'none',
        reason: 'EMA calculation failed',
        ...SAFETY,
      },
    };
  }

  const close  = last.c;
  const open   = last.o;
  const high   = last.h;
  const low    = last.l;
  const isGreen = close > open;
  const isRed   = close < open;

  const relVol = calcRelVol(candles, 20);
  const hasVolume = relVol !== null && relVol >= 1.0;

  const touchThreshold = close * TOUCH_THRESHOLD_PCT;
  const lowTouchesEma9  = Math.abs(low - ema9) <= touchThreshold || low <= ema9;
  const highTouchesEma9 = Math.abs(high - ema9) <= touchThreshold || high >= ema9;

  const longSignal  = close > ema81 && ema9 > ema39 && lowTouchesEma9  && isGreen && hasVolume;
  const shortSignal = close < ema81 && ema9 < ema39 && highTouchesEma9 && isRed   && hasVolume;

  const signal = longSignal ? 'long' : shortSignal ? 'short' : 'none';
  const active = signal !== 'none';

  let confidence = 0;
  if (active) {
    confidence = 60;
    if (relVol >= 1.5) confidence += 15;
    if (relVol >= 2.0) confidence += 10;
    const ema9dist = Math.abs(close - ema9) / close;
    if (ema9dist < 0.001) confidence += 10;
    if (longSignal && close > ema39) confidence += 5;
    confidence = Math.min(100, confidence);
  }

  return {
    goldSigma: {
      active,
      signal,
      confidence,
      strategy: 'gold_sigma',
      label: 'GoldSigma',
      timeframe: '5m',
      ema9:  round(ema9, 2),
      ema39: round(ema39, 2),
      ema81: round(ema81, 2),
      close: round(close, 2),
      relVol: round(relVol || 0, 2),
      stopLossPct: 1.0,
      targetPct: 2.0,
      ...SAFETY,
    },
  };
}

module.exports = { applyGoldSigma, SAFETY };
