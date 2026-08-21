import React from 'react';
import { Link } from 'react-router-dom';
import {
  OverviewPanel,
  StatusBadge,
} from '../trading/index.js';

// ── Fabrikens resa ───────────────────────────────────────────────────────────
//
// Tidslinjen visar HELA vägen för det senaste arbetet: från importerad historik
// till Paper Trading. Pipelinen ovanför svarar på "hur går det till"; den här
// listan svarar på "vad hände faktiskt, och i vilken ordning".
//
// Varje rad leder till den vy där steget går att granska. Ingen rad utför något.

const ICON_SIZE = 32;

export default function FactoryTimeline({ items = [], emptyItems = [], copy }) {
  const text = copy.workflow.timeline;
  const visibleItems = items.length ? items : emptyItems;

  return (
    <section data-factory-timeline style={{ marginBottom: 'var(--s7)' }}>
      <OverviewPanel
        eyebrow={copy.readOnly}
        title={text.title}
        summary={text.subtitle}
      >
        {visibleItems.length ? (
          <div>
            {visibleItems.map((item) => (
              <Link
                key={item.id}
                to={item.href}
                data-factory-timeline-event={item.kind}
                className="m-row"
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: ICON_SIZE,
                    height: ICON_SIZE,
                    flex: 'none',
                    borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                    color: 'var(--muted)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                  }}
                >
                  {item.icon}
                </span>

                <span className="m-row-body">
                  <span className="m-h3" style={{ display: 'block', overflowWrap: 'anywhere' }}>{item.title}</span>
                  <p style={{ overflowWrap: 'anywhere' }}>{item.description}</p>
                  <span className="m-eyebrow" style={{ display: 'block', marginTop: 'var(--s2)' }}>{item.time}</span>
                </span>

                <StatusBadge tone={item.tone} compact>{item.status}</StatusBadge>
              </Link>
            ))}
          </div>
        ) : (
          <div className="m-empty">
            <div className="m-empty-title">{text.empty}</div>
            <div className="m-empty-body">{text.missing.tests}</div>
          </div>
        )}
      </OverviewPanel>
    </section>
  );
}
