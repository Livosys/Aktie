import React from 'react';
import { Link } from 'react-router-dom';
import {
  FieldGrid,
  MetricCard,
  OverviewPanel,
  StatusBadge,
} from '../trading/index.js';

// ── Startsidans tre bärande ytor, i Meridian ─────────────────────────────────
//
// Komponenterna heter fortfarande samma sak och tar samma props. Det som ändrats
// är vad de ÄR:
//
//   AIStatusPanel      → sidans hero. Två rader text som svarar på "vad händer"
//                        och "behöver jag göra något", plus varför och nästa steg.
//   ActionCenter       → zonen "Behöver dig". EN sak, aldrig en lista.
//   FactoryActivityFeed→ "Medan du var borta". Sammanfattningar, inte logg.
//
// Ingen av dem hämtar data och ingen av dem skriver. Alla knappar är länkar till
// vyer som redan finns.

const CARD_MAX_TEXT = '64ch';

// ── Hero ─────────────────────────────────────────────────────────────────────
//
// Produktens första intryck får inte vara ett tal. Det ska vara en mening.
// Rad ett säger vad AI:n gör, rad två säger om något krävs av dig — och den
// andra raden är dämpad, för det är den första som ska träffa ögat först.
export function AIStatusPanel({ status, copy }) {
  const text = copy.workflow.aiStatus;
  const hero = copy.today;

  return (
    <header
      data-ai-status-panel
      className="m-rise"
      style={{ marginBottom: 'var(--s7)' }}
    >
      <div className="m-eyebrow" style={{ marginBottom: 'var(--s4)' }}>
        {status.dateLine}
      </div>

      <h1 className="m-hero" style={{ maxWidth: '22ch' }}>
        {status.headline}
        <br />
        <span style={{ color: 'var(--muted)' }}>{status.subline}</span>
      </h1>

      <p className="m-body" style={{ marginTop: 'var(--s4)', maxWidth: CARD_MAX_TEXT }}>
        {status.why}
      </p>

      {/* Fjärde frågan — "vad blir nästa steg?" — besvaras alltid sist och
          alltid på samma plats, så den går att leta upp utan att läsa om. */}
      <div
        className="m-flex"
        style={{ marginTop: 'var(--s5)', gap: 'var(--s5)', alignItems: 'flex-start' }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="m-eyebrow">{text.next}</div>
          <div className="m-h3" style={{ marginTop: 'var(--s1)', maxWidth: '48ch' }}>{status.next}</div>
        </div>
        <StatusBadge tone={status.tone}>{status.state}</StatusBadge>
      </div>

      <div className="m-eyebrow" style={{ marginTop: 'var(--s4)' }}>{status.updatedAt}</div>
    </header>
  );
}

// ── Behöver dig ──────────────────────────────────────────────────────────────
//
// Den enda ytan i produkten som ställer ett krav på användaren, och den visar
// därför EN sak. En lista av krav är ingen prioritering — den lämnar över
// prioriteringen till läsaren, vilket är precis vad produkten ska slippa göra.
//
// Är listan tom skrivs det ut som ett besked. Frånvaro av larm är också
// information, och ska se ut som ett svar och inte som ett tomt utrymme.
export function ActionCenter({ actions, copy }) {
  const text = copy.workflow.actionCenter;
  const panel = copy.today.needsYou;
  // Only show user decision actions (approval/review), not system actions (tests, checks, imports)
  const userActionIds = ['approveStrategy', 'reviewPaper'];
  const action = Array.isArray(actions) ? actions.find((row) => row && userActionIds.includes(row.id)) : null;

  return (
    <section data-action-center style={{ marginBottom: 'var(--s7)' }}>
      <div className="m-between" style={{ marginBottom: 'var(--s4)' }}>
        <h2 className="m-h1">{panel.eyebrow}</h2>
        <span className="m-eyebrow">{action ? panel.counterOne : panel.counterNone}</span>
      </div>

      {action ? (
        <article
          data-action-center-item={action.id}
          className="m-card m-card-rail m-card-rail-brass"
        >
          <div className="m-card-head">
            <div>
              <div className="m-eyebrow">{text.priority}: {action.priorityLabel}</div>
              <h3 className="m-h2" style={{ marginTop: 'var(--s1)' }}>{action.title}</h3>
            </div>
            <StatusBadge tone={action.tone}>{action.priorityLabel}</StatusBadge>
          </div>

          <p className="m-body" style={{ maxWidth: CARD_MAX_TEXT }}>{action.explanation}</p>

          <div style={{ marginTop: 'var(--s4)' }}>
            <div className="m-eyebrow">{panel.why}</div>
            <p className="m-small" style={{ marginTop: 'var(--s1)', maxWidth: CARD_MAX_TEXT }}>{action.why}</p>
          </div>

          {/* Läsvy: knappen leder till den vy där handlingen redan går att göra.
              Kortet utför ingenting själv. */}
          <div className="m-flex" style={{ marginTop: 'var(--s5)' }}>
            <Link to={action.href} className="m-btn m-btn-primary">{action.button}</Link>
            <Link to="/decision-journal" className="m-btn m-btn-ghost">{panel.openJournal}</Link>
          </div>
        </article>
      ) : (
        <article className="m-card m-card-rail m-card-rail-green">
          <h3 className="m-h2">{panel.emptyTitle}</h3>
          <p className="m-body" style={{ marginTop: 'var(--s3)', maxWidth: CARD_MAX_TEXT }}>{panel.emptyBody}</p>
          <div className="m-flex" style={{ marginTop: 'var(--s5)' }}>
            <Link to="/decision-journal" className="m-btn m-btn-ghost">{panel.openJournal}</Link>
          </div>
        </article>
      )}
    </section>
  );
}

// ── Medan du var borta ───────────────────────────────────────────────────────
//
// Sammanfattningar, inte händelselogg. Varje rad är en mening om något som
// faktiskt betydde något, och leder till den vy där det går att granska.
export function FactoryActivityFeed({ items, copy }) {
  const panel = copy.today.recent;
  const rows = Array.isArray(items) ? items.slice(0, 5) : [];

  return (
    <section data-factory-activity-feed style={{ marginBottom: 'var(--s7)' }}>
      <div className="m-between" style={{ marginBottom: 'var(--s4)' }}>
        <h2 className="m-h1">{panel.eyebrow}</h2>
        <Link to="/decision-journal" className="m-btn m-btn-ghost m-btn-sm">{panel.openJournal} →</Link>
      </div>

      {rows.length ? (
        <div className="m-card">
          {rows.map((item) => (
            <Link
              key={item.id}
              to={item.href}
              data-factory-activity-item={item.kind}
              className="m-row"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <span className="m-row-time">{item.time}</span>
              <span className="m-row-body">
                <span className="m-h3" style={{ display: 'block', overflowWrap: 'anywhere' }}>{item.title}</span>
                <p style={{ overflowWrap: 'anywhere' }}>{item.detail}</p>
              </span>
              <StatusBadge tone={item.tone} compact>{item.badge}</StatusBadge>
            </Link>
          ))}
        </div>
      ) : (
        <div className="m-empty">
          <div className="m-empty-title">{panel.empty}</div>
          <div className="m-empty-body">{copy.states.noRecentActivity}</div>
        </div>
      )}
    </section>
  );
}

// ── Läget ────────────────────────────────────────────────────────────────────
//
// Tre kort som ingen behöver agera på. De svarar på "hur ligger det till" och
// har därför ingen guldskena — mässing betyder att AI:n vill något av dig, och
// den betydelsen håller bara om färgen används sparsamt.
//
// Varje kort har ETT tal i MetricCard och sina detaljer i FieldGrid, så samma
// två primitiver bär hela sektionen.
export function FactoryStateGrid({ state, copy }) {
  const panel = copy.today.state;

  return (
    <section data-factory-state style={{ marginBottom: 'var(--s7)' }}>
      <div className="m-between" style={{ marginBottom: 'var(--s4)' }}>
        <h2 className="m-h1">{panel.eyebrow}</h2>
        <StatusBadge tone={state.summaryTone}>{state.summaryLabel}</StatusBadge>
      </div>

      <div className="m-grid m-g3">
        {state.cards.map((card) => (
          <OverviewPanel
            key={card.key}
            data-factory-state-card={card.key}
            eyebrow={card.eyebrow}
            title={card.title}
            summary={card.summary}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}
          >
            <MetricCard label={card.metricLabel} value={card.metricValue} tone={card.tone} />
            {card.items.length ? <FieldGrid items={card.items} /> : null}
            <Link to={card.href} className="m-btn m-btn-sm" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
              {card.link}
            </Link>
          </OverviewPanel>
        ))}
      </div>
    </section>
  );
}

// ── AI tänker ────────────────────────────────────────────────────────────────
//
// Max tre kort, och de är medvetet inte likvärdiga: ett kunskapshål är ett
// annat slags påstående än en rekommendation. Därför bär de olika skenor —
// violett för det osäkra, turkos för det pågående.
//
// Ett kunskapshål formuleras som "det saknas data här", aldrig som "strategin
// är dålig". Skillnaden är hela poängen: den första meningen går att åtgärda.
export function FactoryBrainCards({ cards = [], copy }) {
  const panel = copy.today.brain;

  return (
    <section data-factory-brain style={{ marginBottom: 'var(--s7)' }}>
      <div className="m-between" style={{ marginBottom: 'var(--s4)' }}>
        <h2 className="m-h1">{panel.eyebrow}</h2>
      </div>

      {cards.length ? (
        <div className="m-grid m-g3">
          {cards.slice(0, 3).map((card) => (
            <article
              key={card.key}
              data-factory-brain-card={card.key}
              className={`m-card m-card-rail m-card-rail-${card.rail}`}
            >
              <div className="m-eyebrow">{card.eyebrow}</div>
              <h3 className="m-h2" style={{ marginTop: 'var(--s2)' }}>{card.title}</h3>
              <p className="m-small" style={{ marginTop: 'var(--s3)' }}>{card.body}</p>
            </article>
          ))}
        </div>
      ) : (
        <div className="m-empty">
          <div className="m-empty-title">{panel.empty}</div>
          <div className="m-empty-body">{copy.states.noNextActivity}</div>
        </div>
      )}
    </section>
  );
}
