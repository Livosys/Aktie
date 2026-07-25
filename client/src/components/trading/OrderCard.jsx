import React, { useMemo } from 'react';
import {
  EMPTY_VALUE,
  fmtNumber,
  fmtTime,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { strategyDisplayName } from '../../stores/strategyStore.js';
import { FieldGrid } from './FieldGrid.jsx';
import { StatusBadge, statusTone, toneTokens } from './StatusBadge.jsx';
import { StrategyContextPanel } from './StrategyContextPanel.jsx';

export const OrderCard = React.memo(function OrderCard({
  order,
}) {
  const status = order?.statusLabel || EMPTY_VALUE;
  const tone = statusTone(order?.status);
  const tokens = toneTokens(tone);
  const symbol = textOrEmpty(order?.localSymbol || order?.symbol);
  const items = useMemo(() => [
    { label: 'Symbol', value: symbol },
    { label: 'Side', value: textOrEmpty(order?.side), tone: order?.side === 'Sell' || order?.side === 'Short' ? 'danger' : (order?.side === 'Buy' || order?.side === 'Long' ? 'success' : 'neutral') },
    { label: 'Quantity', value: fmtNumber(order?.quantity) },
    { label: 'Order type', value: textOrEmpty(order?.orderType) },
    { label: 'Limit price', value: fmtNumber(order?.limitPrice, 2) },
    { label: 'Stop price', value: fmtNumber(order?.stopPrice, 2) },
    { label: 'Filled quantity', value: fmtNumber(order?.filledQuantity) },
    { label: 'Remaining quantity', value: fmtNumber(order?.remainingQuantity) },
    { label: 'Average fill price', value: fmtNumber(order?.averageFillPrice, 2) },
    { label: 'Order status', value: <StatusBadge tone={tone} compact>{status}</StatusBadge> },
    { label: 'Broker timestamp', value: fmtTime(order?.brokerTimestamp) },
    { label: 'Local timestamp', value: fmtTime(order?.localTimestamp) },
    { label: 'Broker order ID', value: textOrEmpty(order?.brokerOrderId) },
    { label: 'Order ref', value: textOrEmpty(order?.orderRef) },
    { label: 'Source', value: textOrEmpty(order?.source) },
    { label: 'Strategy', value: strategyDisplayName(order?.strategy, EMPTY_VALUE) },
  ], [
    order?.averageFillPrice,
    order?.brokerOrderId,
    order?.brokerTimestamp,
    order?.filledQuantity,
    order?.limitPrice,
    order?.localTimestamp,
    order?.orderRef,
    order?.orderType,
    order?.quantity,
    order?.remainingQuantity,
    order?.side,
    order?.source,
    order?.stopPrice,
    order?.strategy?.strategyId,
    order?.strategy?.strategyName,
    status,
    symbol,
    tone,
  ]);

  return (
    <article data-trading-event-count={order?.eventContext?.count || 0} data-decision-count={order?.decisionContext?.count || 0} style={{
      border: `1px solid ${tokens.border}`,
      borderLeft: `4px solid ${tokens.fg}`,
      background: 'var(--surface)',
      borderRadius: 8,
      padding: 14,
      display: 'grid',
      gap: 12,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}>
            Strategy order lifecycle
          </div>
          <div style={{
            color: 'var(--text)',
            fontSize: 22,
            fontWeight: 900,
            lineHeight: 1.1,
            marginTop: 4,
            overflowWrap: 'anywhere',
          }}>
            {symbol}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <StatusBadge tone={tone}>{status}</StatusBadge>
          <StatusBadge tone="neutral">{textOrEmpty(order?.side)}</StatusBadge>
        </div>
      </div>
      <StrategyContextPanel strategy={order?.strategy || null} />
      <FieldGrid items={items} />
    </article>
  );
});
