import React from 'react';

// ── Bärande yta (Meridian: Card) ─────────────────────────────────────────────
//
// Panelen ritade tidigare sitt utseende själv: radie 8, padding 16, rubrik 18 px,
// etikett 11 px med vikt 800. Inget av det gick att ändra från designsystemet.
// Nu kommer varje värde ur en token.
//
// Två sorters token används med flit:
//   · yt- och textfärger via de temaföljande aliasen (--surface, --text, --border,
//     --muted). I mörkt läge pekar de sedan etapp 1 rakt in i Meridian; i ljust
//     läge behåller de sin egen palett, så ljust läge fortsätter fungera.
//   · mått, radier och typsnitt via Meridians egna tokens (--s5, --r, --display,
//     --data). De är temaoberoende och ska vara identiska i båda lägena.
//
// Publikt API är oförändrat: tradingSectionStyle(extra), SectionHeader och
// OverviewPanel tar exakt samma props som tidigare.

export function tradingSectionStyle(extra = {}) {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r)',
    padding: 'var(--s5)',
    boxShadow: 'var(--elev-0)',
    ...extra,
  };
}

export function SectionHeader({ eyebrow, title, summary, action }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 'var(--s3)',
      alignItems: 'flex-start',
      flexWrap: 'wrap',
      marginBottom: 'var(--s4)',
    }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow ? (
          // Versal etikett i data-snittet. Bär kontext, aldrig innehåll.
          <div style={{
            fontFamily: 'var(--data)',
            color: 'var(--muted)',
            fontSize: 9.5,
            fontWeight: 400,
            textTransform: 'uppercase',
            letterSpacing: '.16em',
          }}>
            {eyebrow}
          </div>
        ) : null}
        <h2 style={{
          margin: 'var(--s1) 0 0',
          fontFamily: 'var(--display)',
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '-.01em',
          lineHeight: 1.25,
          textWrap: 'balance',
        }}>
          {title}
        </h2>
        {summary ? (
          <p style={{
            margin: 'var(--s2) 0 0',
            color: 'var(--muted)',
            fontSize: 13,
            lineHeight: 1.45,
          }}>
            {summary}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export const OverviewPanel = React.memo(function OverviewPanel({
  eyebrow,
  title,
  summary,
  children,
  ...sectionProps
}) {
  return (
    <section {...sectionProps} style={tradingSectionStyle({ minHeight: 0, ...(sectionProps.style || {}) })}>
      <SectionHeader eyebrow={eyebrow} title={title} summary={summary} />
      {children}
    </section>
  );
});
