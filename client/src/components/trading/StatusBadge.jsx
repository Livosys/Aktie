import React from 'react';
import { statusTone } from '../../domain/StrategyDomain.js';

// ── Badge (Meridian) ─────────────────────────────────────────────────────────
//
// Tonerna bar tidigare sina egna rgba-literaler, vilket gjorde dem omöjliga att
// styra från designsystemet — en färgändring krävde en kodändring. Nu pekar
// varje ton på de temaföljande tokens som etapp 1 kopplade in i Meridian:
// i mörkt läge ger de mässing, turkos, grönt och rött ur paletten, i ljust läge
// den befintliga ljusa paletten.
//
// Formen är Meridians: rektangel med 5 px radie, inte pillerform. Pillret läser
// som ett filter man kan klicka på; badgen är en avläsning.
//
// Publikt API oförändrat: toneTokens(tone) returnerar samma { bg, fg, border },
// samma tonnycklar och samma alias (good/bad/warn/blue).

export function toneTokens(tone = 'neutral') {
  const normalized = {
    good: 'success',
    bad: 'danger',
    warn: 'warning',
    blue: 'info',
  }[tone] || tone;

  const tones = {
    neutral: { bg: 'var(--surface-2)',  fg: 'var(--text)',    border: 'var(--border)' },
    success: { bg: 'var(--green-dim)',  fg: 'var(--success)', border: 'var(--green-border)' },
    warning: { bg: 'var(--yellow-dim)', fg: 'var(--warning)', border: 'var(--yellow-border)' },
    danger:  { bg: 'var(--red-dim)',    fg: 'var(--danger)',  border: 'var(--red-border)' },
    info:    { bg: 'var(--blue-dim)',   fg: 'var(--blue)',    border: 'var(--blue-border)' },
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
        gap: 'var(--s1)',
        height: compact ? 19 : 21,
        padding: compact ? '0 7px' : '0 8px',
        borderRadius: 'var(--r-badge)',
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: style.fg,
        fontFamily: 'var(--data)',
        fontSize: 9.5,
        fontWeight: 400,
        letterSpacing: '.09em',
        textTransform: 'uppercase',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        flex: 'none',
      }}
    >
      {children}
    </span>
  );
});

export const StatusRail = React.memo(function StatusRail({ items = [] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)', alignItems: 'center' }}>
      {items.map((item) => (
        <StatusBadge key={item.label} tone={item.tone || 'neutral'}>
          {item.label}: {item.value}
        </StatusBadge>
      ))}
    </div>
  );
});
