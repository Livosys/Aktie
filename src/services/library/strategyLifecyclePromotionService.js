'use strict';

/**
 * Strategy Lifecycle Promotion Service
 *
 * Drives the canonical lifecycle progression:
 * DRAFT → TESTING → LEARNING → CANDIDATE → PAPER
 *
 * Uses promotionEngineService to evaluate readiness, then applies transitions.
 * This is the mechanism that actually moves strategies forward when gates pass.
 */

const promotionEngine = require('./promotionEngineService');

const SAFETY = Object.freeze({
  readOnly: false,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'strategy_lifecycle_promotion_service',
});

/**
 * Promote all strategies that pass their current stage gates.
 *
 * @param {object} library - Strategy Library instance
 * @returns {object} promotion results
 */
function promoteReadyStrategies(library) {
  if (!library || typeof library.listStrategies !== 'function') {
    return { ok: false, reason: 'library_not_provided', promoted: [] };
  }

  const results = {
    ok: true,
    evaluated: 0,
    promoted: [],
    failures: [],
    ...SAFETY,
  };

  const allStrategies = library.listStrategies();

  for (const strategy of allStrategies) {
    results.evaluated++;

    // Get canonical evaluation
    const evaluation = promotionEngine.evaluatePromotion(strategy);

    // If this strategy can move forward, apply the transition
    if (evaluation.allowed && evaluation.to) {
      try {
        const transitionResult = promotionEngine.applyPromotion(
          library,
          strategy.strategyId,
          { actor: 'lifecycle_promotion_service' }
        );

        if (transitionResult.ok) {
          results.promoted.push({
            strategyId: strategy.strategyId,
            from: evaluation.from,
            to: evaluation.to,
            transitionId: transitionResult.transition?.event?.id,
          });
        } else {
          results.failures.push({
            strategyId: strategy.strategyId,
            reason: transitionResult.decision?.blockedReason || 'unknown',
            message: 'promotion_already_applied_or_invalid_state',
          });
        }
      } catch (err) {
        results.failures.push({
          strategyId: strategy.strategyId,
          reason: 'exception',
          message: err && err.message ? err.message : String(err),
        });
      }
    }
  }

  return results;
}

/**
 * Evaluate a single strategy's readiness (read-only).
 *
 * @param {object} library
 * @param {string} strategyId
 * @returns {object} evaluation result
 */
function evaluateStrategyReadiness(library, strategyId) {
  if (!library) return { ok: false, reason: 'library_not_provided' };
  const strategy = library.getStrategy(strategyId);
  if (!strategy) return { ok: false, reason: 'strategy_not_found' };
  return promotionEngine.evaluatePromotion(strategy);
}

module.exports = {
  SAFETY,
  promoteReadyStrategies,
  evaluateStrategyReadiness,
};
