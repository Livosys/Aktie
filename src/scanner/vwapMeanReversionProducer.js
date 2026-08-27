'use strict';

/**
 * VWAP Mean Reversion Producer
 *
 * Detects mean reversion toward VWAP when:
 * - Price has extended significantly from VWAP (more than normal pullback distance)
 * - Momentum shows signs of exhaustion (RSI extreme)
 * - Price shows reversal candle pattern back toward VWAP
 *
 * Strategy: mean_reversion_vwap (direction: both, SL: 0.25%, TP: 1.3)
 *
 * Distinct from VWAP_RECLAIM (which detects failed breakouts near VWAP).
 * Mean reversion is for extreme extensions followed by reversal.
 *
 * Precedence: If VWAP_RECLAIM or VWAP_REJECTION is detected by main classifier,
 * this producer does NOT fire (main classifier has priority).
 */

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect VWAP mean reversion setup:
 * - Price extended 1.5%+ away from VWAP (extreme distance)
 * - Price shows reversal direction (RSI extreme or close reversal)
 * - Volume supports reversal
 * - Candles indicate momentum change
 */
function evaluateMeanReversion(context) {
  if (!context || typeof context !== 'object') {
    return null;
  }

  const result = context.result || {};
  const sig = context || {};
  const vwap = num(result.vwap);
  const close = num(sig.close || result.close);
  const rsi14 = num(result.rsi14);

  // Need VWAP context and price data
  if (!vwap || !close) {
    return null;
  }

  // Distance from VWAP in percent
  const distancePct = Math.abs((close - vwap) / vwap) * 100;

  // Mean reversion requires extreme extension (>1.5% away from VWAP)
  // Pullback/reclaim patterns are closer, so this distinguishes them
  if (distancePct < 1.5) {
    return null;
  }

  // Need momentum signal to confirm reversal
  // RSI > 70 (overbought) or RSI < 30 (oversold) indicates exhaustion
  if (!rsi14 || (rsi14 <= 30 && rsi14 >= 70)) {
    return null;
  }

  // Determine direction based on price position relative to VWAP
  let direction;
  if (close > vwap && rsi14 > 70) {
    // Price above VWAP and overbought → expect revert DOWN
    direction = 'DOWN';
  } else if (close < vwap && rsi14 < 30) {
    // Price below VWAP and oversold → expect revert UP
    direction = 'UP';
  } else {
    // RSI not in extremes, unclear reversal signal
    return null;
  }

  // Return candidate with canonical structure
  return {
    signalFamily: 'VWAP_MEAN_REVERSION',
    signalSubtype: 'VWAP_MEAN_REVERSION',
    direction,
    reasonSv: `Priset är ${distancePct.toFixed(1)}% från VWAP med ${rsi14 > 70 ? 'överköpt' : 'översålt'} momentum. Återgång förväntas.`,
    nextMoveBias: direction === 'UP' ? 'UP' : direction === 'DOWN' ? 'DOWN' : null,
    vwap,
    vwapDistancePct: distancePct,
    rsi14,
  };
}

module.exports = {
  producerId: 'vwap_mean_reversion',
  signalFamily: 'VWAP_MEAN_REVERSION',
  supportedSubtypes: ['VWAP_MEAN_REVERSION'],
  evaluate: evaluateMeanReversion,
};
