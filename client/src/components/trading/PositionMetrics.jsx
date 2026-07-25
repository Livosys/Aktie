import React from 'react';
import { toneTokens } from './StatusBadge.jsx';
import { FieldGrid } from './FieldGrid.jsx';

export const PositionMetrics = React.memo(function PositionMetrics({
  primary = [],
  fields = [],
}) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
        gap: 10,
      }}>
        {primary.map((metric) => {
          const style = toneTokens(metric.tone || 'neutral');
          return (
            <div key={metric.label} style={{
              borderTop: `2px solid ${style.border}`,
              paddingTop: 8,
              minWidth: 0,
            }}>
              <div style={{
                color: 'var(--muted)',
                fontSize: 11,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: 0,
              }}>
                {metric.label}
              </div>
              <div style={{
                color: style.fg,
                fontSize: 23,
                fontWeight: 900,
                lineHeight: 1.08,
                marginTop: 5,
                overflowWrap: 'anywhere',
              }}>
                {metric.value}
              </div>
              {metric.hint ? (
                <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.35, marginTop: 4 }}>
                  {metric.hint}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <FieldGrid items={fields} />
    </div>
  );
});
