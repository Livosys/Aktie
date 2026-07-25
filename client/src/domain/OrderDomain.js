import {
  EMPTY_VALUE,
  hasValue,
} from '../utils/tradingFormatters.js';
import {
  firstNumber,
  firstValue,
} from '../models/strategyViewModel.js';

export function rootFromRow(row = {}) {
  return String(row.root || row.symbol || row.localSymbol || row.contract?.symbol || '').trim().toUpperCase();
}

export function orderSide(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'BUY' || text === 'BOT') return 'Buy';
  if (text === 'SELL' || text === 'SLD') return 'Sell';
  if (text === 'LONG') return 'Long';
  if (text === 'SHORT') return 'Short';
  return hasValue(value) ? String(value) : EMPTY_VALUE;
}

export function lifecycleStatus(rawStatus, intentStatus = null) {
  const raw = String(firstValue(rawStatus, intentStatus, '') || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!raw) return null;
  if (['intent_created', 'guard_passed', 'shadow_logged', 'pending', 'api_pending', 'presubmitted', 'pre_submitted'].includes(raw)) return 'pending';
  if (['submit_started', 'submitted'].includes(raw)) return 'submitted';
  if (['acknowledged', 'accepted', 'api_accepted'].includes(raw)) return 'accepted';
  if (['working', 'open', 'active'].includes(raw)) return 'working';
  if (['partiallyfilled', 'partially_filled', 'partial'].includes(raw)) return 'partially_filled';
  if (['filled', 'complete', 'completed'].includes(raw)) return 'filled';
  if (['cancelled', 'canceled', 'inactive', 'expired'].includes(raw)) return 'cancelled';
  if (['rejected', 'error', 'failed'].includes(raw)) return 'rejected';
  return raw;
}

export function lifecycleLabel(status) {
  const labels = {
    pending: 'Pending',
    submitted: 'Submitted',
    accepted: 'Accepted',
    working: 'Working',
    partially_filled: 'Partially Filled',
    filled: 'Filled',
    cancelled: 'Cancelled',
    rejected: 'Rejected',
  };
  return labels[status] || (status ? String(status) : EMPTY_VALUE);
}

export function isWorking(order = {}) {
  return lifecycleStatus(order.status || order.state || order.statusLabel) === 'working';
}

export function isFilled(order = {}) {
  return lifecycleStatus(order.status || order.state || order.statusLabel) === 'filled';
}

export function isSubmitted(order = {}) {
  return lifecycleStatus(order.status || order.state || order.statusLabel) === 'submitted';
}

export function isCancelled(order = {}) {
  return lifecycleStatus(order.status || order.state || order.statusLabel) === 'cancelled';
}

export function isRejected(order = {}) {
  return lifecycleStatus(order.status || order.state || order.statusLabel) === 'rejected';
}

export function getOrderLifecycle(order = {}, orderStatus = null, strategy = {}) {
  const status = lifecycleStatus(firstValue(orderStatus?.status, order.status, order.state, orderStatus?.ibStatus), strategy.intentStatus);
  return {
    status,
    label: lifecycleLabel(status),
    isWorking: status === 'working',
    isFilled: status === 'filled',
    isSubmitted: status === 'submitted',
    isCancelled: status === 'cancelled',
    isRejected: status === 'rejected',
  };
}

export function getOrderSummary({
  order = {},
  orderStatus = null,
  strategy = {},
  reconciliation = null,
  snapshotAt = null,
} = {}) {
  const lifecycle = getOrderLifecycle(order, orderStatus, strategy);
  const filledQuantity = firstNumber(order.filledQuantity, order.filled, orderStatus?.filled);
  const remainingQuantity = firstNumber(order.remainingQuantity, order.remaining, orderStatus?.remaining);
  const quantity = firstNumber(order.quantity, order.totalQuantity, order.order?.totalQuantity, filledQuantity != null && remainingQuantity != null ? filledQuantity + remainingQuantity : null);

  return {
    id: firstValue(order.id, order.orderId, orderStatus?.orderId, order.permId, order.orderRef),
    symbol: firstValue(rootFromRow(order), rootFromRow(orderStatus), strategy.symbol),
    localSymbol: firstValue(order.localSymbol, order.contract?.localSymbol),
    side: orderSide(firstValue(order.action, order.side, strategy.direction)),
    quantity,
    orderType: firstValue(order.orderType, order.order?.orderType),
    limitPrice: firstNumber(order.limitPrice, order.lmtPrice, order.order?.lmtPrice),
    stopPrice: firstNumber(order.stopPrice, order.auxPrice, order.order?.auxPrice),
    filledQuantity,
    remainingQuantity,
    averageFillPrice: firstNumber(order.avgFillPrice, order.averageFillPrice, orderStatus?.avgFillPrice),
    status: lifecycle.status,
    statusLabel: lifecycle.label,
    lifecycle,
    brokerTimestamp: firstValue(order.brokerTimestamp, order.ibTimestamp, order.time),
    localTimestamp: firstValue(order.updatedAt, order.receivedAt, orderStatus?.updatedAt, reconciliation?.generatedAt, snapshotAt),
    brokerOrderId: firstValue(order.orderId, order.ibOrderId, orderStatus?.orderId, order.permId, orderStatus?.permId),
    orderRef: firstValue(order.orderRef, order.order?.orderRef, strategy.orderRef),
    source: firstValue(order.source, order.executionSource),
    strategy,
  };
}

export function getOrderDisplayState(order = {}) {
  const lifecycle = getOrderLifecycle(order, null, order.strategy || {});
  return {
    status: lifecycle.status,
    label: lifecycle.label,
    side: orderSide(order.side || order.action),
  };
}

export function stableOrderKey(view = {}, index) {
  return [view.id, view.brokerOrderId, view.orderRef, view.strategy?.strategyId].filter(hasValue).join('_') || `order_${index}`;
}
