import React from 'react';
import { EMPTY_VALUE, fmtNumber, textOrEmpty } from '../../utils/tradingFormatters.js';
import { StatusBadge, statusTone } from './StatusBadge.jsx';

function sideTone(side) {
  const text = String(side || '').toLowerCase();
  if (text === 'long') return 'success';
  if (text === 'short') return 'danger';
  return 'neutral';
}

export const PositionHeader = React.memo(function PositionHeader({
  symbol,
  localSymbol,
  side,
  contracts,
  realtimeStatus,
  brokerStatus,
}) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      flexWrap: 'wrap',
      borderBottom: '1px solid var(--border)',
      paddingBottom: 12,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 26, lineHeight: 1, letterSpacing: 0 }}>{textOrEmpty(symbol)}</strong>
          <StatusBadge tone={sideTone(side)}>{textOrEmpty(side).toUpperCase()}</StatusBadge>
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6, overflowWrap: 'anywhere' }}>
          {textOrEmpty(localSymbol)} · contracts {contracts == null ? EMPTY_VALUE : fmtNumber(contracts)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <StatusBadge tone={statusTone(realtimeStatus)}>{textOrEmpty(realtimeStatus)}</StatusBadge>
        <StatusBadge tone={statusTone(brokerStatus)}>{textOrEmpty(brokerStatus)}</StatusBadge>
      </div>
    </div>
  );
});
