import React from 'react';
import { EMPTY_VALUE, fmtTime, textOrEmpty } from '../../utils/tradingFormatters.js';
import { toneTokens } from './StatusBadge.jsx';
import { DecisionBadge } from './DecisionBadge.jsx';

export const DecisionTimeline = React.memo(function DecisionTimeline({
  items = [],
  emptyText = EMPTY_VALUE,
}) {
  if (!Array.isArray(items) || !items.length) {
    return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{emptyText}</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {items.map((item, index) => {
        const tokens = toneTokens(item.color || 'neutral');
        return (
          <div key={item.decisionId || `${item.label || 'decision'}-${index}`} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', gap: 10 }}>
            <div style={{ position: 'relative', display: 'grid', justifyItems: 'center' }}>
              <span style={{ width: 12, height: 12, borderRadius: 999, border: `2px solid ${tokens.fg}`, background: tokens.bg, marginTop: 16, zIndex: 1 }} />
              {index < items.length - 1 ? (
                <span style={{ position: 'absolute', top: 32, bottom: -10, width: 1, background: 'var(--border)' }} />
              ) : null}
            </div>
            <div style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 8, padding: 12, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{textOrEmpty(item.label)}</strong>
                  <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>{fmtTime(item.timestamp)}</div>
                </div>
                <DecisionBadge label={item.status || EMPTY_VALUE} tone={item.color || 'neutral'} compact />
              </div>
              {item.reason ? <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, overflowWrap: 'anywhere' }}>{item.reason}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
});
