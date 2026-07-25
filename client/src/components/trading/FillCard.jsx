import React, { useMemo } from 'react';
import {
  EMPTY_VALUE,
  fmtMoney,
  fmtNumber,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { strategyDisplayName } from '../../stores/strategyStore.js';
import { FieldGrid } from './FieldGrid.jsx';
import { StatusBadge, statusTone, toneTokens } from './StatusBadge.jsx';
import { StrategyContextPanel } from './StrategyContextPanel.jsx';

function formatCommission(value, currency) {
  if (!hasValue(value)) return EMPTY_VALUE;
  if (hasValue(currency)) return fmtMoney(value, currency, 2);
  return fmtNumber(value, 2);
}

export const FillCard = React.memo(function FillCard({
  fill,
}) {
  const directionTone = fill?.positionDirection === 'Sell' || fill?.positionDirection === 'Short'
    ? 'danger'
    : (fill?.positionDirection === 'Buy' || fill?.positionDirection === 'Long' ? 'success' : 'neutral');
  const tokens = toneTokens(directionTone);
  const symbol = textOrEmpty(fill?.localSymbol || fill?.symbol);
  const items = useMemo(() => [
    { label: 'Symbol', value: symbol },
    { label: 'Entry', value: fmtNumber(fill?.entry, 2) },
    { label: 'Exit', value: fmtNumber(fill?.exit, 2) },
    { label: 'Quantity', value: fmtNumber(fill?.quantity) },
    { label: 'Commission', value: formatCommission(fill?.commission, fill?.commissionCurrency) },
    { label: 'Fill price', value: fmtNumber(fill?.fillPrice, 2) },
    { label: 'Execution time', value: fmtTime(fill?.executionTime) },
    { label: 'Local timestamp', value: fmtTime(fill?.localTimestamp) },
    { label: 'Broker execution ID', value: textOrEmpty(fill?.brokerExecutionId) },
    { label: 'Order ID', value: textOrEmpty(fill?.orderId) },
    { label: 'Order ref', value: textOrEmpty(fill?.orderRef) },
    { label: 'Strategy', value: strategyDisplayName(fill?.strategy, EMPTY_VALUE) },
    { label: 'Position direction', value: textOrEmpty(fill?.positionDirection), tone: directionTone },
    { label: 'Source', value: textOrEmpty(fill?.source) },
  ], [
    directionTone,
    fill?.brokerExecutionId,
    fill?.commission,
    fill?.commissionCurrency,
    fill?.entry,
    fill?.executionTime,
    fill?.exit,
    fill?.fillPrice,
    fill?.localTimestamp,
    fill?.orderId,
    fill?.orderRef,
    fill?.positionDirection,
    fill?.quantity,
    fill?.source,
    fill?.strategy?.strategyId,
    fill?.strategy?.strategyName,
    symbol,
  ]);

  return (
    <article data-trading-event-count={fill?.eventContext?.count || 0} data-decision-count={fill?.decisionContext?.count || 0} style={{
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
            Strategy fill
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
          <StatusBadge tone={directionTone}>{textOrEmpty(fill?.positionDirection)}</StatusBadge>
          <StatusBadge tone={statusTone(fill?.strategy?.runtimeState)}>{textOrEmpty(fill?.strategy?.runtimeState)}</StatusBadge>
        </div>
      </div>
      <StrategyContextPanel strategy={fill?.strategy || null} />
      <FieldGrid items={items} />
    </article>
  );
});
