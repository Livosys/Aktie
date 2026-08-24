'use strict';

/**
 * Trailing Profit Lock Service — v4
 *
 * Manages trailing profit protection for Paper trades.
 * - Monitors maxUnrealizedPnlSek per execution
 * - Calculates trailing floor (MFE - 500 SEK)
 * - Modifies broker protective stops via canonical execution
 * - Enforces monotonic rule (LONG: stop up only, SHORT: stop down only)
 * - Persists MFE state across restarts
 */

const TRAILING_ACTIVATION_SEK = 500;
const TRAILING_GAP_SEK = 500;
const BASE_POSITION_SEK = 10_000; // Conservative default for qty=1

function buildSafety() {
  return {
    mode: 'trailing_profit_lock',
    paperOnly: true,
    environment: 'paper',
    source: 'trailing_profit_lock_service',
  };
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundTickPrice(price, tickSize) {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return null;
  return Math.round(price / tickSize) * tickSize;
}

/**
 * Calculate PnL in SEK from PnL percentage and base position
 */
function calcPnlSek(pnlPct) {
  if (!Number.isFinite(pnlPct)) return 0;
  return (pnlPct / 100) * BASE_POSITION_SEK;
}

/**
 * Calculate price equivalent of SEK amount
 * price = entry + (sekAmount / positionSize) * entry
 */
function priceFromSekPnl(entrPrice, sekAmount, direction = 'long', qty = 1) {
  if (!Number.isFinite(entrPrice) || !Number.isFinite(sekAmount) || qty !== 1) return null;

  const pnlPct = (sekAmount / BASE_POSITION_SEK) * 100;
  const rawPrice = entrPrice + (entrPrice * pnlPct / 100);

  return direction === 'short' ? entrPrice - (entrPrice * pnlPct / 100) : rawPrice;
}

/**
 * Evaluate if a trade needs trailing stop modification
 * Returns: { needsModify, newStopPrice, reason }
 */
function evaluateTrailingStopModification({
  trade = {},
  currentPrice = null,
  executionContext = {},
}) {
  if (!trade || !Number.isFinite(currentPrice)) {
    return { needsModify: false, reason: 'invalid_inputs', ...buildSafety() };
  }

  const entryPrice = safeNumber(trade.entryPrice);
  const direction = String(trade.direction || 'long').toLowerCase();
  const qty = trade.tradeQuantity || 1;
  const tickSize = safeNumber(executionContext.tickSize) || 0.01;

  if (!Number.isFinite(entryPrice) || qty !== 1 || !['long', 'short'].includes(direction)) {
    return { needsModify: false, reason: 'invalid_trade_context', ...buildSafety() };
  }

  // Calculate current PnL
  const pnlPct = direction === 'long'
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;

  const pnlSek = calcPnlSek(pnlPct);

  // Check if trail should be activated
  if (pnlSek < TRAILING_ACTIVATION_SEK) {
    return {
      needsModify: false,
      reason: 'below_activation_threshold',
      pnlSek,
      threshold: TRAILING_ACTIVATION_SEK,
      ...buildSafety(),
    };
  }

  // Update MFE (monotonic: only increases)
  const previousMfe = safeNumber(trade.maxUnrealizedPnlSek) || 0;
  const newMfe = Math.max(previousMfe, pnlSek);

  if (newMfe !== previousMfe) {
    trade.maxUnrealizedPnlSek = newMfe;
    trade.trailingProfitFloorSek = newMfe - TRAILING_GAP_SEK;
    trade.lastTrailUpdateAt = new Date().toISOString();
  }

  const floor = trade.trailingProfitFloorSek || (newMfe - TRAILING_GAP_SEK);

  // Calculate target stop price from floor
  const targetStopPrice = priceFromSekPnl(entryPrice, floor, direction, qty);
  if (!Number.isFinite(targetStopPrice)) {
    return {
      needsModify: false,
      reason: 'invalid_stop_calculation',
      ...buildSafety(),
    };
  }

  const roundedStopPrice = roundTickPrice(targetStopPrice, tickSize);

  // Check monotonic rule
  const currentStop = safeNumber(trade.stopPrice) || (direction === 'long' ? entryPrice * 0.997 : entryPrice * 1.003);
  const shouldModify = direction === 'long'
    ? roundedStopPrice > currentStop  // LONG: stop must move UP
    : roundedStopPrice < currentStop; // SHORT: stop must move DOWN

  return {
    needsModify: shouldModify,
    reason: shouldModify ? 'trailing_floor_improved' : 'no_improvement_needed',
    currentPrice,
    entryPrice,
    direction,
    pnlPct,
    pnlSek,
    maxUnrealizedSek: newMfe,
    floorSek: floor,
    currentStopPrice: currentStop,
    calculatedStopPrice: targetStopPrice,
    roundedStopPrice,
    tickSize,
    ...buildSafety(),
  };
}

/**
 * Build modification patch for broker stop order
 */
function buildStopOrderPatch(direction, newStopPrice) {
  if (!Number.isFinite(newStopPrice) || !['long', 'short'].includes(direction)) {
    return null;
  }
  // STOP orders use auxPrice for stop level
  return { auxPrice: Math.round(newStopPrice * 100) / 100 };
}

/**
 * Format log entry for trail modification
 */
function formatTrailLog({
  executionId = null,
  tradeId = null,
  strategyId = null,
  symbol = null,
  direction = null,
  entry = null,
  current = null,
  maxUnrealizedSek = null,
  floorSek = null,
  oldStopPrice = null,
  newStopPrice = null,
  brokerStopOrderId = null,
  success = false,
  reason = null,
}) {
  return {
    type: 'TRAILING_PROFIT_LOCK_MODIFICATION',
    executionId,
    tradeId,
    strategyId,
    symbol,
    direction,
    prices: {
      entry,
      current,
      oldStop: oldStopPrice,
      newStop: newStopPrice,
    },
    trail: {
      maxUnrealizedSek,
      floorSek,
      gapSek: TRAILING_GAP_SEK,
    },
    brokerStopOrderId,
    success,
    reason,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  TRAILING_ACTIVATION_SEK,
  TRAILING_GAP_SEK,
  BASE_POSITION_SEK,

  evaluateTrailingStopModification,
  buildStopOrderPatch,
  formatTrailLog,
  calcPnlSek,
  priceFromSekPnl,
  roundTickPrice,
  buildSafety,
};
