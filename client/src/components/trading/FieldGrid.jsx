import React from 'react';
import { toneTokens } from './StatusBadge.jsx';

// ── Fältrutnät (Meridian) ────────────────────────────────────────────────────
//
// Rutnätet bar tidigare vikt 850 på värdet och 800 på etiketten. Två nästan
// maximala vikter bredvid varandra gör att ingenting sticker ut — allt skriker
// lika högt. Meridian sätter etiketten i data-snittets versaler på 9,5 px och
// låter värdet bära rubrikvikt 600. Skillnaden i uttryck gör hierarkin läsbar
// utan att något behöver bli större.
//
// Kolumnbeteendet är medvetet oförändrat: auto-fit på minst 160 px. Sidor som
// matar in tre respektive elva fält ska fortsätta bryta likadant som idag.
//
// Publikt API oförändrat: items[] med label, value, hint och tone.

export const FieldGrid = React.memo(function FieldGrid({ items = [] }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: 'var(--s4)',
    }}>
      {items.map((item) => {
        const style = item.tone ? toneTokens(item.tone) : null;
        return (
          <div key={item.label} style={{
            borderTop: '1px solid var(--border)',
            paddingTop: 'var(--s3)',
            minWidth: 0,
          }}>
            <div style={{
              fontFamily: 'var(--data)',
              color: 'var(--muted)',
              fontSize: 9.5,
              fontWeight: 400,
              textTransform: 'uppercase',
              letterSpacing: '.16em',
              marginBottom: 'var(--s2)',
            }}>
              {item.label}
            </div>
            <div style={{
              color: style ? style.fg : 'var(--text)',
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.3,
              letterSpacing: '-.005em',
              overflowWrap: 'anywhere',
            }}>
              {item.value}
            </div>
            {item.hint ? (
              <div style={{
                color: 'var(--muted)',
                fontSize: 12,
                marginTop: 'var(--s1)',
                lineHeight: 1.4,
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
