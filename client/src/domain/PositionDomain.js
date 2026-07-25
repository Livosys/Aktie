import {
  EMPTY_VALUE,
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';
import {
  firstNumber,
  firstValue,
} from '../models/strategyViewModel.js';

export function positionRoot(position = {}) {
  return String(position.root || position.symbol || position.localSymbol || '').trim().toUpperCase();
}

export function stablePositionKey(position = {}, index) {
  const parts = [
    position.id,
    position.accountMasked,
    position.account,
    position.conId,
    position.localSymbol,
    positionRoot(position),
    position.signedQuantity ?? position.quantity,
  ].filter(hasValue);
  return parts.length ? parts.join('_') : `position_${index}`;
}

export function inferSide(position = {}) {
  const explicit = String(position.side || position.direction || '').trim().toLowerCase();
  if (explicit === 'long' || explicit === 'short') return explicit;
  const signed = numberOrNull(position.signedQuantity ?? position.position);
  if (signed > 0) return 'long';
  if (signed < 0) return 'short';
  return null;
}

export function isLong(position = {}) {
  return inferSide(position) === 'long';
}

export function isShort(position = {}) {
  return inferSide(position) === 'short';
}

export function isFlat(position = {}) {
  const quantity = firstNumber(position.quantity, position.signedQuantity, position.position);
  return quantity === 0;
}

export function hasOpenPosition(position = {}) {
  const quantity = firstNumber(position.quantity, position.signedQuantity, position.position);
  return quantity != null && quantity !== 0;
}

export function orderMatchesPosition(order = {}, position = {}) {
  const positionConId = firstValue(position.conId, position.contract?.conId);
  const orderConId = firstValue(order.conId, order.contract?.conId);
  if (hasValue(positionConId) && hasValue(orderConId) && String(positionConId) === String(orderConId)) return true;

  const positionLocal = String(firstValue(position.localSymbol, position.contract?.localSymbol) || '').toUpperCase();
  const orderLocal = String(firstValue(order.localSymbol, order.contract?.localSymbol) || '').toUpperCase();
  if (positionLocal && orderLocal && positionLocal === orderLocal) return true;

  const root = positionRoot(position);
  const orderRoot = String(order.root || order.symbol || order.contract?.symbol || '').toUpperCase();
  return Boolean(root && orderRoot && root === orderRoot);
}

export function selectStop(position = {}, orders = []) {
  const direct = firstNumber(
    position.currentStop,
    position.currentStopPrice,
    position.stopLossPrice,
    position.stopLoss,
    position.stopPrice,
    position.protectiveStopPrice,
  );
  if (direct != null) return direct;
  const stopOrder = orders.find((order) => firstNumber(order.stopPrice, order.auxPrice, order.order?.auxPrice) != null);
  return stopOrder ? firstNumber(stopOrder.stopPrice, stopOrder.auxPrice, stopOrder.order?.auxPrice) : null;
}

export function selectTarget(position = {}, orders = []) {
  const direct = firstNumber(
    position.currentTarget,
    position.currentTargetPrice,
    position.takeProfitPrice,
    position.takeProfit,
    position.targetPrice,
  );
  if (direct != null) return direct;
  const targetOrder = orders.find((order) => (
    firstNumber(order.limitPrice, order.lmtPrice, order.order?.lmtPrice) != null
    && firstNumber(order.stopPrice, order.auxPrice, order.order?.auxPrice) == null
  ));
  return targetOrder ? firstNumber(targetOrder.limitPrice, targetOrder.lmtPrice, targetOrder.order?.lmtPrice) : null;
}

export function computeSignedPoints({ side, entryPrice, currentPrice }) {
  if (!side || entryPrice == null || currentPrice == null) return null;
  return side === 'short' ? entryPrice - currentPrice : currentPrice - entryPrice;
}

export function getHoldingTime(openedAt, lastUpdate) {
  const start = Date.parse(openedAt || '');
  const end = Date.parse(lastUpdate || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function getPositionExposure(position = {}, instrument = null, quote = null) {
  return firstNumber(position.marketValue, position.marketValueUsd, position.marketValueSek, position.marketValueUsdNet, instrument?.marketValue, quote?.marketValue);
}

export function getPositionSummary({
  position = {},
  instrument = null,
  quote = null,
  brokerOrders = [],
  brokerOrdersAvailable = false,
  reconciliation = null,
  snapshotAt = null,
  currency = null,
  strategy = null,
} = {}) {
  const matchingOrders = brokerOrders.filter((order) => orderMatchesPosition(order, position));
  const side = inferSide(position);
  const contracts = firstNumber(position.quantity, Math.abs(numberOrNull(position.signedQuantity) ?? NaN), Math.abs(numberOrNull(position.position) ?? NaN));
  const entryPrice = firstNumber(position.entryPrice, position.averageEntry, position.averageCost, position.avgCost);
  const currentPrice = firstNumber(position.currentPrice, position.marketPrice, quote?.price, quote?.last);
  const currentPnl = firstNumber(position.currentPnl, position.unrealizedPnl, position.unrealizedPnlUsd, position.pnl);
  const pointValue = firstNumber(position.pointValueUsd, instrument?.pointValueUsd, instrument?.contractSize);
  const tickSize = firstNumber(position.tickSize, instrument?.tickSize, quote?.tickSize);
  const points = firstNumber(position.points, position.unrealizedPoints);
  const ticks = firstNumber(position.ticks, position.unrealizedTicks);
  const marketValue = getPositionExposure(position, instrument, quote);
  const pnlPct = firstNumber(position.pnlPct, position.unrealizedPnlPct);
  const currentStop = selectStop(position, matchingOrders);
  const currentTarget = selectTarget(position, matchingOrders);
  const risk = firstNumber(position.risk, position.riskUsd);
  const reward = firstNumber(position.reward, position.rewardUsd);
  const rr = firstNumber(position.riskReward, position.rr);
  const openedAt = firstValue(position.openedAt, position.entryTime, position.entryTimestamp, position.opened_at);
  const lastUpdate = firstValue(position.reconciliationTimestamp, position.updatedAt, quote?.updatedAt, reconciliation?.generatedAt, snapshotAt);
  const holdingMs = getHoldingTime(openedAt, lastUpdate);
  const realtimeStatus = position.uncertain === true
    ? 'uncertain'
    : (quote?.stale === true
      ? 'stale quote'
      : (quote?.fallback === true || quote?.simulated === true
        ? 'degraded feed'
        : (currentPrice != null ? 'live' : EMPTY_VALUE)));
  const brokerStatus = firstValue(position.brokerStatus, position.protectiveOrderStatus, position.status, reconciliation?.status);
  const dataSource = [
    firstValue(position.source, position.executionSource),
    quote?.source,
  ].filter(hasValue).join(' / ') || EMPTY_VALUE;

  return {
    symbol: firstValue(position.root, position.symbol, quote?.root, quote?.symbol),
    localSymbol: firstValue(position.localSymbol, quote?.localSymbol),
    side,
    contracts,
    entryPrice,
    currentPrice,
    currentPnl,
    pnlPct,
    points,
    ticks,
    marketValue,
    holdingMs,
    currentStop,
    currentTarget,
    risk,
    reward,
    rr,
    realtimeStatus,
    brokerStatus,
    lastUpdate,
    dataSource,
    tickSize,
    pointValue,
    matchedOrderCount: matchingOrders.length,
    brokerOrdersAvailable,
    currency,
    strategy,
  };
}
