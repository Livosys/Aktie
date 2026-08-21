import React from 'react';
import { Link } from 'react-router-dom';
import {
  FieldGrid,
  OverviewPanel,
  StatusBadge,
} from '../trading/index.js';

// ── Arbetet ──────────────────────────────────────────────────────────────────
//
// Sex begripliga steg ersätter fem interna system. Numreringen är inte dekor:
// stegen ÄR en ordning, och ett resultat i steg 3 betyder ingenting om steg 1
// inte har körts. Därför får varje kort sitt stegnummer.
//
// Sidan visar inga jobb-id, körningsnummer, könamn eller versionshashar. Den
// som vill se maskineriet går till Labs; den som vill förstå arbetet stannar
// här.
//
// Läsvy: ingen knapp på sidan startar, pausar eller avbryter något.

const RAIL_BY_STATE = Object.freeze({
  running: 'teal',
  waiting: 'violet',
  needsYou: 'brass',
  done: 'green',
  failed: 'red',
  idle: '',
});

export default function FactoryWorkPipeline({ pipeline, copy }) {
  const text = copy.pipeline;

  return (
    <div data-factory-work-pipeline className="m-rise">
      <header style={{ marginBottom: 'var(--s6)' }}>
        <div className="m-eyebrow" style={{ marginBottom: 'var(--s2)' }}>{text.eyebrow}</div>
        <h1 className="m-h1">{pipeline.headline}</h1>
        <p className="m-body" style={{ marginTop: 'var(--s2)', maxWidth: '64ch' }}>{text.subtitle}</p>
      </header>

      <section className="m-grid m-g3" style={{ marginBottom: 'var(--s7)' }}>
        {pipeline.steps.map((step, index) => {
          const rail = RAIL_BY_STATE[step.state] || '';
          return (
            <article
              key={step.key}
              data-factory-pipeline-step={step.key}
              className={`m-card${rail ? ` m-card-rail m-card-rail-${rail}` : ''}`}
            >
              <div className="m-between" style={{ marginBottom: 'var(--s3)' }}>
                <span className="m-eyebrow">{text.stepLabel} {index + 1}</span>
                <StatusBadge tone={step.tone} compact>{step.status}</StatusBadge>
              </div>

              {/* Talet först, etiketten under — ett tal utan omdöme är inte färdigt. */}
              <div className="m-num" style={{ fontSize: 26, letterSpacing: '-.05em', lineHeight: 1.1 }}>
                {step.count}
              </div>
              <div className="m-small" style={{ marginTop: 'var(--s1)' }}>{step.unit}</div>

              <h2 className="m-h2" style={{ marginTop: 'var(--s4)' }}>{step.title}</h2>
              <p className="m-small" style={{ marginTop: 'var(--s2)' }}>{step.body}</p>

              {step.detail ? (
                <p className="m-small" style={{ marginTop: 'var(--s3)', color: 'var(--text)' }}>{step.detail}</p>
              ) : null}
            </article>
          );
        })}
      </section>

      <section className="m-grid m-g2" style={{ marginBottom: 'var(--s6)' }}>
        <OverviewPanel
          data-factory-pipeline-learned
          eyebrow={text.learned.eyebrow}
          title={pipeline.learned.title}
          summary={pipeline.learned.summary}
        >
          {pipeline.learned.rows.length ? (
            <div>
              {pipeline.learned.rows.map((row) => (
                <div key={row.id} className="m-row">
                  <span className="m-row-body">
                    <span className="m-h3" style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.title}</span>
                    <p style={{ overflowWrap: 'anywhere' }}>{row.detail}</p>
                  </span>
                  <StatusBadge tone={row.tone} compact>{row.badge}</StatusBadge>
                </div>
              ))}
            </div>
          ) : (
            <div className="m-empty">
              <div className="m-empty-title">{text.learned.empty}</div>
              <div className="m-empty-body">{copy.states.noLearnings}</div>
            </div>
          )}
        </OverviewPanel>

        <OverviewPanel
          data-factory-pipeline-attention
          eyebrow={text.attention.eyebrow}
          title={pipeline.attention.title}
          summary={pipeline.attention.summary}
        >
          {pipeline.attention.rows.length ? (
            <div>
              {pipeline.attention.rows.map((row) => (
                <div key={row.id} className="m-row">
                  <span className="m-row-body">
                    <span className="m-h3" style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.title}</span>
                    <p style={{ overflowWrap: 'anywhere' }}>{row.detail}</p>
                  </span>
                  <StatusBadge tone={row.tone} compact>{row.badge}</StatusBadge>
                </div>
              ))}
            </div>
          ) : (
            <div className="m-empty">
              <div className="m-empty-title">{text.attention.empty}</div>
              <div className="m-empty-body">{copy.states.noFailures}</div>
            </div>
          )}
        </OverviewPanel>
      </section>

      <section style={{ marginBottom: 'var(--s6)' }}>
        <OverviewPanel
          data-factory-pipeline-capacity
          eyebrow={pipeline.capacity.eyebrow}
          title={pipeline.capacity.title}
          summary={pipeline.capacity.summary}
        >
          <FieldGrid items={pipeline.capacity.items} />
          <div className="m-meter" style={{ marginTop: 'var(--s4)' }}>
            <div className="m-meter-fill" style={{ width: pipeline.capacity.fill }} />
          </div>
        </OverviewPanel>
      </section>

      {/* Sidans egentliga budskap står sist, som en lugnande upplysning och
          inte som en varning. */}
      <div className="m-hint">
        <span className="m-hint-icon" aria-hidden="true">i</span>
        <p>
          {text.closeHint}{' '}
          <Link to="/decision-journal" style={{ color: 'var(--text)' }}>
            {copy.today.recent.openJournal}
          </Link>
        </p>
      </div>
    </div>
  );
}
