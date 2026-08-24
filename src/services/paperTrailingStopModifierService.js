'use strict';

/**
 * Paper Trailing Stop Modifier Service
 *
 * Bridges trailing profit lock calculations to IBKR Paper protective stop modifications.
 * - Validates ownership (executionId, orderRef, qty=1, paperOnly)
 * - Modifies stops when trailing floor improves
 * - Enforces monotonic rule (LONG up, SHORT down)
 * - Logs all modifications to audit trail
 * - Paper-only safety gates
 */

const trailingService = require('./trailingProfitLockService');

function buildSafety() {
  return {
    mode: 'paper_trailing_stop_modifier',
    paperOnly: true,
    environment: 'paper',
    source: 'paper_trailing_stop_modifier_service',
  };
}

/**
 * Validate that we can safely modify this trade's protective stop
 */
function validateOwnership({
  trade = {},
  executionContext = {},
}) {
  const checks = {
    paperOnly: trade.paperOnly === true,
    hasExecutionId: Boolean(trade.executionId || executionContext.executionId),
    hasTradeId: Boolean(trade.tradeId),
    qtyIsOne: (trade.tradeQuantity || 1) === 1,
    directionValid: ['long', 'short'].includes(String(trade.direction || '').toLowerCase()),
    hasStopOrderId: Number.isInteger(Number(executionContext.stopOrderId)),
    hasOrderRef: Boolean(executionContext.orderRef || `TOS-PAPER-${trade.executionId}-stopLoss`),
  };

  const allValid = Object.values(checks).every(v => v === true);

  return {
    valid: allValid,
    checks,
    blockers: Object.entries(checks)
      .filter(([, value]) => value !== true)
      .map(([key]) => key),
    ...buildSafety(),
  };
}

/**
 * Prepare modification patch (if needed)
 */
function prepareModificationPatch({
  trade = {},
  currentPrice = null,
  executionContext = {},
  previousStopPrice = null,
}) {
  const validation = validateOwnership({ trade, executionContext });
  if (!validation.valid) {
    return {
      shouldModify: false,
      reason: `ownership_validation_failed: ${validation.blockers.join(',')}`,
      validation,
      ...buildSafety(),
    };
  }

  // Use trailing service to evaluate
  const trailEval = trailingService.evaluateTrailingStopModification({
    trade,
    currentPrice,
    executionContext,
  });

  if (!trailEval.needsModify) {
    return {
      shouldModify: false,
      reason: trailEval.reason,
      trailEval,
      ...buildSafety(),
    };
  }

  // Check monotonic rule
  const direction = String(trade.direction || 'long').toLowerCase();
  const currentStop = previousStopPrice || trailEval.currentStopPrice || 0;
  const newStop = trailEval.roundedStopPrice;

  const monotonic = direction === 'long'
    ? newStop > currentStop
    : newStop < currentStop;

  if (!monotonic) {
    return {
      shouldModify: false,
      reason: `monotonic_rule_violated: ${direction} stop would move wrong direction`,
      direction,
      currentStop,
      newStop,
      ...buildSafety(),
    };
  }

  // Check idempotency: don't resend same stop
  const idempotent = Math.abs(newStop - currentStop) > 0.01; // Allow small rounding
  if (!idempotent) {
    return {
      shouldModify: false,
      reason: 'idempotent_check: stop price unchanged from last modification',
      ...buildSafety(),
    };
  }

  const patch = trailingService.buildStopOrderPatch(direction, newStop);

  return {
    shouldModify: true,
    patch,
    newStopPrice: newStop,
    trailEval,
    validation,
    direction,
    ...buildSafety(),
  };
}

/**
 * Execute broker stop modification (requires orchestrator)
 * Returns { ok, modified, reason, ... } compatible with modifyOwnedProtectiveOrder
 */
async function executeStopModification({
  trade = {},
  currentPrice = null,
  executionContext = {},
  orchestrator = null, // ibPaperExecutionOrchestratorService
  onEvent = null, // callback for logging
}) {
  if (!orchestrator || typeof orchestrator.modifyOwnedProtectiveOrder !== 'function') {
    return {
      ok: false,
      modified: false,
      reason: 'orchestrator_unavailable',
      ...buildSafety(),
    };
  }

  const prep = prepareModificationPatch({
    trade,
    currentPrice,
    executionContext,
    previousStopPrice: trade.lastTrailStopPrice,
  });

  if (!prep.shouldModify) {
    return {
      ok: true,
      modified: false,
      reason: prep.reason,
      ...buildSafety(),
    };
  }

  const executionId = trade.executionId || executionContext.executionId;
  const stopOrderId = executionContext.stopOrderId;
  const orderRef = executionContext.orderRef || `TOS-PAPER-${executionId}-stopLoss`;

  try {
    const result = await orchestrator.modifyOwnedProtectiveOrder({
      orderId: stopOrderId,
      orderRef,
      orderPatch: prep.patch,
      reason: `trailing_profit_lock_v4_floor_${prep.trailEval.floorSek?.toFixed(0)}_sek`,
      idempotencyKey: `trail_${executionId}_${Date.now()}`,
    });

    // Update trade state
    if (result.ok || result.modified) {
      trade.lastTrailStopPrice = prep.newStopPrice;
      trade.lastTrailUpdateAt = new Date().toISOString();
    }

    // Log modification
    if (typeof onEvent === 'function') {
      onEvent({
        type: 'TRAILING_PROFIT_LOCK_MODIFICATION',
        executionId,
        tradeId: trade.tradeId,
        strategyId: trade.strategyId,
        symbol: trade.symbol,
        direction: prep.direction,
        qty: trade.tradeQuantity || 1,
        maxUnrealizedSek: prep.trailEval.maxUnrealizedSek,
        trailingGapSek: 500,
        floorSek: prep.trailEval.floorSek,
        currentPrice,
        oldStopPrice: prep.trailEval.currentStopPrice,
        newStopPrice: prep.newStopPrice,
        brokerOrderId: stopOrderId,
        brokerOrderRef: orderRef,
        brokerResult: result,
        success: result.ok || result.modified,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      ...result,
      modified: result.ok || result.modified,
      executionId,
      stopPrice: prep.newStopPrice,
      ...buildSafety(),
    };
  } catch (err) {
    if (typeof onEvent === 'function') {
      onEvent({
        type: 'TRAILING_PROFIT_LOCK_MODIFICATION_ERROR',
        executionId,
        tradeId: trade.tradeId,
        error: err?.message,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      ok: false,
      modified: false,
      reason: `orchestrator_call_failed: ${err?.message}`,
      error: err,
      ...buildSafety(),
    };
  }
}

module.exports = {
  validateOwnership,
  prepareModificationPatch,
  executeStopModification,
  buildSafety,
};
