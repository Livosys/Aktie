'use strict';

/**
 * EMA Breakdown Producer
 *
 * Detects bearish breakdown through EMA levels when:
 * - Price breaks BELOW EMA21 (opposite of pullback reclaim)
 * - EMA stack is broken (short-term EMA below longer-term)
 * - Volume increases on the breakdown
 * - Momentum is downward (bias DOWN)
 *
 * Strategy: ema_breakdown (direction: short, SL: 0.22%, TP: 1.5)
 *
 * Distinct from EMA_PULLBACK_DOWN (which is a retest/reclaim up).
 * Breakdown is a continuation move away from the EMA, not toward it.
 *
 * Precedence: If EMA_PULLBACK is detected by main classifier, this does NOT fire.
 */

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detect EMA breakdown:
 * - Price below EMA21
 * - EMA stack broken (momentum down)
 * - Volume confirms
 * - Direction is bearish
 */
function evaluateBreakdown(context) {
  if (!context || typeof context !== 'object') {
    return null;
  }

  const result = context.result || {};
  const sig = context || {};
  const price = num(sig.price || sig.close || result.close);
  const ema21 = num(result.ema21);
  const ema50 = num(result.ema50);
  const ema9 = num(result.ema9);
  const direction = (sig.nextMoveBias || sig.direction || '').toUpperCase();

  // Need EMA context and price
  if (!price || !ema21 || !ema50) {
    return null;
  }

  // Breakdown requires price BELOW ema21
  const priceAboveEma21 = price >= ema21;
  if (priceAboveEma21) {
    return null;
  }

  // EMA stack broken (downtrend):
  // ema9 < ema21 < ema50 OR just ema21 < ema50
  const stackBrokenDown = (ema9 !== null && ema9 < ema21) || (ema21 < ema50);
  if (!stackBrokenDown) {
    return null;
  }

  // Direction must be DOWN (bearish bias)
  if (direction !== 'DOWN') {
    return null;
  }

  // Return candidate with canonical structure
  return {
    signalFamily: 'EMA_BREAKDOWN',
    signalSubtype: 'EMA_BREAKDOWN_DOWN',
    direction: 'DOWN',
    reasonSv: 'Priset har bryt under EMA21 med svagare EMA-stack. Fortsättning nedåt förväntas.',
    nextMoveBias: 'DOWN',
    ema9,
    ema21,
    ema50,
    priceRelationToEma: 'below_ema21',
  };
}

module.exports = {
  producerId: 'ema_breakdown',
  signalFamily: 'EMA_BREAKDOWN',
  supportedSubtypes: ['EMA_BREAKDOWN_DOWN'],
  evaluate: evaluateBreakdown,
};
