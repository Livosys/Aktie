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
        const symbol = quote.root || quote.symbol || quote.localSymbol || `quote_${index + 1}`;
        const stale = quote.stale === true || quote.delayed === true || quote.fallback === true || quote.simulated === true;
        const freshness = quote.staleAgeMs != null
          ? `age ${fmtAge(quote.staleAgeMs)}`
          : (hasValue(quote.updatedAt) ? `updated ${fmtTime(quote.updatedAt)}` : `age ${EMPTY_VALUE}`);
        return (
          <div key={`${symbol}_${quote.localSymbol || quote.conId || index}`} style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(54px, 0.9fr) minmax(78px, 1fr) minmax(92px, 1.2fr)',
            gap: 10,
            alignItems: 'center',
            borderTop: '1px solid var(--border)',
            paddingTop: 8,
          }}>
            <strong style={{ fontSize: 14 }}>{symbol}</strong>
            <span style={{ fontSize: 15, fontWeight: 850 }}>{fmtNumber(quote.price ?? quote.last, 2)}</span>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <StatusBadge tone={stale ? 'warning' : 'success'}>{quote.source || quote.provider || EMPTY_VALUE}</StatusBadge>
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 12, gridColumn: '1 / -1' }}>
              {textOrEmpty(quote.localSymbol)} · bid {fmtNumber(quote.bid, 2)} / ask {fmtNumber(quote.ask, 2)} · {freshness}
            </span>
          </div>
        );
      })}
    </div>
  );
});
