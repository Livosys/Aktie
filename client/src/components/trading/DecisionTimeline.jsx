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
    <div style={{ display: 'grid', gap: 'var(--s3)' }}>
      {items.map((item, index) => {
        const tokens = toneTokens(item.color || 'neutral');
        return (
          <div key={item.decisionId || `${item.label || 'decision'}-${index}`} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', gap: 'var(--s3)' }}>
            <div style={{ position: 'relative', display: 'grid', justifyItems: 'center' }}>
              {/* Punkten är rund med flit — den är en tidpunkt, inte en yta.
                  Allt annat i systemet har rektangulära radier. */}
              <span style={{ width: 11, height: 11, borderRadius: '50%', border: `2px solid ${tokens.fg}`, background: tokens.bg, marginTop: 'var(--s5)', zIndex: 1 }} />
              {index < items.length - 1 ? (
                <span style={{ position: 'absolute', top: 40, bottom: 'calc(var(--s3) * -1)', width: 1, background: 'var(--border)' }} />
              ) : null}
            </div>
            <div style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--r)', padding: 'var(--s4)', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 600, letterSpacing: '-.01em', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{textOrEmpty(item.label)}</strong>
                  <div style={{ fontFamily: 'var(--data)', color: 'var(--muted)', fontSize: 11, marginTop: 'var(--s1)' }}>{fmtTime(item.timestamp)}</div>
                </div>
                <DecisionBadge label={item.status || EMPTY_VALUE} tone={item.color || 'neutral'} compact />
              </div>
              {item.reason ? <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 'var(--s3)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{item.reason}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
});
