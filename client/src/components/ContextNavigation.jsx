import React from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from './trading/index.js';
import { uiCopy, uiFactorySafeText } from '../services/uiTerminologyService.js';

const ROUTES = Object.freeze({
  factory: '/factory',
  factoryWork: '/factory?tab=arbetet',
  strategy: '/factory/library',
  test: '/factory/replay',
  decision: '/decision-journal',
  paper: '/futures-paper',
  approval: '/futures-paper?tab=godkannande',
  result: '/factory/replay',
  market: '/factory/market-dna',
});

function cleanValue(value) {
  const text = uiFactorySafeText(value);
  return text || '';
}

function addQuery(path, params = {}) {
  const [base, query = ''] = path.split('?');
  const search = new URLSearchParams(query);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${base}?${text}` : base;
}

export function contextHref(kind, context = {}) {
  const base = ROUTES[kind] || ROUTES.factory;
  if (kind === 'strategy') return addQuery(base, { strategy: context.strategyId });
  if (kind === 'test' || kind === 'result') {
    return addQuery(base, { test: context.testId || context.replayRunId, strategy: context.strategyId });
  }
  if (kind === 'decision') {
    return addQuery(base, {
      decision: context.decisionId,
      test: context.testId || context.replayRunId,
      strategy: context.strategyId,
    });
  }
  if (kind === 'paper' || kind === 'approval') return addQuery(base, { strategy: context.strategyId });
  if (kind === 'market') return addQuery(base, { market: context.marketId || context.marketDnaHash });
  return base;
}

export function contextAction(kind, context = {}, overrides = {}) {
  const copy = uiCopy('contextNavigation');
  const definition = copy.actions?.[kind] || {};
  return {
    id: overrides.id || kind,
    label: cleanValue(overrides.label || definition.label || copy.title),
    description: cleanValue(overrides.description || definition.description || copy.fallbackSummary),
    href: overrides.href || contextHref(kind, context),
    tone: overrides.tone || definition.tone || 'neutral',
    primary: overrides.primary === true,
  };
}

export default function ContextNavigation({
  eyebrow,
  title,
  summary,
  actions = [],
  compact = false,
}) {
  const copy = uiCopy('contextNavigation');
  const visibleActions = actions.length ? actions : [contextAction('factory')];

  return (
    <nav
      data-context-navigation
      aria-label={copy.ariaLabel}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        background: 'var(--surface)',
        padding: compact ? 'var(--s4)' : 'var(--s5)',
        display: 'grid',
        gap: 'var(--s4)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--data)',
            color: 'var(--muted)',
            fontSize: 9.5,
            fontWeight: 400,
            letterSpacing: '.16em',
            textTransform: 'uppercase',
          }}
        >
          {eyebrow || copy.eyebrow}
        </div>
        <strong style={{ display: 'block', fontFamily: 'var(--display)', fontSize: compact ? 16 : 18, marginTop: 'var(--s1)' }}>
          {title || copy.title}
        </strong>
        <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.45, margin: 'var(--s2) 0 0' }}>
          {summary || copy.summary}
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' }}>
        {visibleActions.map((action, index) => (
          <Link
            key={action.id || action.href || index}
            data-context-action={action.id || index}
            to={action.href || ROUTES.factory}
            className={action.primary ? 'm-btn m-btn-primary' : 'm-btn m-btn-ghost'}
            style={{
              alignItems: 'center',
              display: 'inline-flex',
              gap: 'var(--s2)',
              minHeight: 36,
              textDecoration: 'none',
            }}
            title={action.description}
          >
            <span>{action.label}</span>
            <StatusBadge tone={action.tone || 'neutral'} compact>{copy.eyebrow}</StatusBadge>
          </Link>
        ))}
      </div>
    </nav>
  );
}
