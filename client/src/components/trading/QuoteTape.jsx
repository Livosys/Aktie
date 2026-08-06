import React from 'react';
import {
  EMPTY_VALUE,
  WAITING_BROKER,
  fmtAge,
  fmtNumber,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { StatusBadge } from './StatusBadge.jsx';

export const QuoteTape = React.memo(function QuoteTape({ quotes = [], waiting = false, limit = 4 }) {
  if (!quotes.length) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45 }}>
        {waiting ? WAITING_BROKER : EMPTY_VALUE}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {quotes.slice(0, limit).map((quote, index) => {
        const row = quote && typeof quote === 'object' ? quote : {};
        const symbol = row.root || row.symbol || row.localSymbol || `quote_${index + 1}`;
        const stale = row.stale === true || row.delayed === true || row.fallback === true || row.simulated === true;
        const freshness = row.staleAgeMs != null
          ? `age ${fmtAge(row.staleAgeMs)}`
          : (hasValue(row.updatedAt) ? `updated ${fmtTime(row.updatedAt)}` : `age ${EMPTY_VALUE}`);
        return (
          <div key={`${symbol}_${row.localSymbol || row.conId || index}`} style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(54px, 0.9fr) minmax(78px, 1fr) minmax(92px, 1.2fr)',
            gap: 10,
            alignItems: 'center',
            borderTop: '1px solid var(--border)',
            paddingTop: 8,
          }}>
            <strong style={{ fontSize: 14 }}>{symbol}</strong>
            <span style={{ fontSize: 15, fontWeight: 850 }}>{fmtNumber(row.price ?? row.last, 2)}</span>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <StatusBadge tone={stale ? 'warning' : 'success'}>{row.source || row.provider || EMPTY_VALUE}</StatusBadge>
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 12, gridColumn: '1 / -1' }}>
              {textOrEmpty(row.localSymbol)} · bid {fmtNumber(row.bid, 2)} / ask {fmtNumber(row.ask, 2)} · {freshness}
            </span>
          </div>
        );
      })}
    </div>
  );
});
