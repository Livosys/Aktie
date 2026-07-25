import React from 'react';
import { toneTokens } from './StatusBadge.jsx';

export const FieldGrid = React.memo(function FieldGrid({ items = [] }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: 10,
    }}>
      {items.map((item) => {
        const style = item.tone ? toneTokens(item.tone) : null;
        return (
          <div key={item.label} style={{ borderTop: '1px solid var(--border)', paddingTop: 9, minWidth: 0 }}>
            <div style={{
              color: 'var(--muted)',
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 0,
              marginBottom: 5,
            }}>
              {item.label}
            </div>
            <div style={{
              color: style ? style.fg : 'var(--text)',
              fontSize: 16,
              fontWeight: 850,
              lineHeight: 1.25,
              overflowWrap: 'anywhere',
            }}>
              {item.value}
            </div>
            {item.hint ? (
              <div style={{
                color: 'var(--muted)',
                fontSize: 12,
                marginTop: 4,
                lineHeight: 1.35,
                overflowWrap: 'anywhere',
              }}>
                {item.hint}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});
