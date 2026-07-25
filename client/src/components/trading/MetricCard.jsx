import React from 'react';
import { toneTokens } from './StatusBadge.jsx';

export const MetricCard = React.memo(function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
}) {
  const style = toneTokens(tone);
  return (
    <div style={{
      border: `1px solid ${style.border}`,
      background: style.bg,
      borderRadius: 8,
      padding: '12px 14px',
      minHeight: 82,
      display: 'grid',
      gap: 8,
      alignContent: 'space-between',
    }}>
      <div style={{
        color: 'var(--muted)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0,
        fontWeight: 800,
      }}>
        {label}
      </div>
      <div style={{ color: style.fg, fontSize: 22, fontWeight: 900, lineHeight: 1.05 }}>
        {value}
      </div>
      {hint ? <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.35 }}>{hint}</div> : null}
    </div>
  );
});
