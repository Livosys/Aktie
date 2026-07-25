import React from 'react';
import { statusTone } from '../../domain/StrategyDomain.js';

export function toneTokens(tone = 'neutral') {
  const normalized = {
    good: 'success',
    bad: 'danger',
    warn: 'warning',
    blue: 'info',
  }[tone] || tone;

  const tones = {
    neutral: { bg: 'var(--surface-2)', fg: 'var(--text)', border: 'var(--border)' },
    success: { bg: 'rgba(34,197,94,0.12)', fg: 'var(--success)', border: 'rgba(34,197,94,0.30)' },
    warning: { bg: 'rgba(245,158,11,0.12)', fg: 'var(--warning)', border: 'rgba(245,158,11,0.30)' },
    danger: { bg: 'rgba(239,68,68,0.12)', fg: 'var(--danger)', border: 'rgba(239,68,68,0.30)' },
    info: { bg: 'rgba(59,130,246,0.12)', fg: 'var(--accent)', border: 'rgba(59,130,246,0.30)' },
  };
  return tones[normalized] || tones.neutral;
}

export { statusTone };

export const StatusBadge = React.memo(function StatusBadge({
  tone = 'neutral',
  children,
  compact = false,
  title,
}) {
  const style = toneTokens(tone);
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: compact ? '3px 7px' : '4px 9px',
        borderRadius: 999,
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: style.fg,
        fontSize: compact ? 10.5 : 11,
        fontWeight: 800,
        lineHeight: 1.2,
        letterSpacing: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
});

export const StatusRail = React.memo(function StatusRail({ items = [] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {items.map((item) => (
        <StatusBadge key={item.label} tone={item.tone || 'neutral'}>
          {item.label}: {item.value}
        </StatusBadge>
      ))}
    </div>
  );
});
