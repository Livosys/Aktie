import React from 'react';
import { toneTokens } from './StatusBadge.jsx';

// ── Metric (Meridian) ────────────────────────────────────────────────────────
//
// Två saker ändras utöver tokens, båda direkt ur designrapporten:
//
// 1. Siffran står nu ÖVER etiketten, inte under. "Tabulära siffror, etikett
//    under, aldrig tvärtom." Ögat ska träffa värdet först och etiketten som
//    förklaring — inte leta rubrik innan det får sitt tal.
//
// 2. Kortet tonar inte längre hela sin bakgrund efter tone. Ytan är neutral och
//    tonen sitter på värdet. Det gör att fyra metrics bredvid varandra läses som
//    en rad mätare i stället för fyra olika larmnivåer, och det håller mässing
//    sällsynt — färgen betyder något bara så länge den används sparsamt.
//
// Talet sätts i data-snittet med tabulära siffror, så kolumner inte hoppar när
// värden uppdateras.
//
// Publikt API oförändrat: label, value, hint, tone.

export const MetricCard = React.memo(function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
}) {
  const style = toneTokens(tone);
  return (
    <div style={{
      border: '1px solid var(--border)',
      background: 'var(--surface)',
      borderRadius: 'var(--r)',
      padding: 'var(--s4)',
      minHeight: 82,
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--s1)',
      justifyContent: 'center',
      minWidth: 0,
    }}>
      <div style={{
        fontFamily: 'var(--data)',
        fontWeight: 400,
        fontSize: 23,
        letterSpacing: '-.04em',
        lineHeight: 1.1,
        fontVariantNumeric: 'tabular-nums',
        color: tone === 'neutral' ? 'var(--text)' : style.fg,
        overflowWrap: 'anywhere',
      }}>
        {value}
      </div>
      <div style={{
        color: 'var(--muted)',
        fontSize: 12,
        lineHeight: 1.35,
      }}>
        {label}
      </div>
      {hint ? (
        <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.35 }}>{hint}</div>
      ) : null}
    </div>
  );
});
