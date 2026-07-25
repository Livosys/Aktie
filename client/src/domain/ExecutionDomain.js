import { hasValue } from '../utils/tradingFormatters.js';
import {
  firstNumber,
  firstValue,
} from '../models/strategyViewModel.js';
import {
  orderSide,
  rootFromRow,
} from './OrderDomain.js';

export function getExecutions(source = {}) {
  if (Array.isArray(source)) return source.filter(Boolean);
  return [
    ...(Array.isArray(source.brokerFills) ? source.brokerFills : []),
    ...(Array.isArray(source.brokerExecutions) ? source.brokerExecutions : []),
    ...(Array.isArray(source.executions) ? source.executions : []),
    ...(Array.isArray(source.fills) ? source.fills : []),
  ].filter(Boolean);
}

export function getFillSummary(fill = {}, strategy = {}) {
  return {
    id: firstValue(fill.id, fill.execId, fill.executionId, fill.orderId, fill.orderRef),
    symbol: firstValue(rootFromRow(fill), strategy.symbol),
    localSymbol: firstValue(fill.localSymbol, fill.contract?.localSymbol),
    entry: firstNumber(fill.entry, fill.entryPrice, fill.entryFillPrice),
    exit: firstNumber(fill.exit, fill.exitPrice, fill.exitFillPrice),
    quantity: firstNumber(fill.quantity, fill.shares),
    commission: firstNumber(fill.commission),
    commissionCurrency: firstValue(fill.commissionCurrency, fill.currency),
    fillPrice: firstNumber(fill.fillPrice, fill.price),
    executionTime: firstValue(fill.executionTime, fill.time),
    localTimestamp: firstValue(fill.receivedAt, fill.updatedAt),
    brokerExecutionId: firstValue(fill.execId, fill.executionId),
    orderId: firstValue(fill.orderId, fill.ibOrderId, fill.permId),
    orderRef: firstValue(fill.orderRef),
    source: firstValue(fill.source, fill.executionSource),
    positionDirection: orderSide(firstValue(fill.positionDirection, fill.direction, fill.side, strategy.direction)),
    strategy,
  };
}

export function groupExecutions(executions = [], getKey = (execution) => execution.strategy?.strategyId || execution.orderId || execution.symbol) {
  const groups = new Map();
  for (const execution of executions) {
    const key = getKey(execution) || 'unknown';
    const rows = groups.get(key) || [];
    rows.push(execution);
    groups.set(key, rows);
  }
  return groups;
}

export function executionTimeline(executions = []) {
  return executions
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(a.executionTime || a.localTimestamp || a.time || '');
      const bTime = Date.parse(b.executionTime || b.localTimestamp || b.time || '');
      if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
      return bTime - aTime;
    });
}

export function executionSummary(executions = []) {
  const rows = getExecutions(executions);
  return {
    total: rows.length,
    hasExecutions: rows.length > 0,
    latest: executionTimeline(rows)[0] || null,
  };
}

export function stableFillKey(view = {}, index) {
  return [view.id, view.brokerExecutionId, view.orderId, view.orderRef, view.strategy?.strategyId].filter(hasValue).join('_') || `fill_${index}`;
}
