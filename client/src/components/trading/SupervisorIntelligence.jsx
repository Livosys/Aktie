import React, { useMemo } from 'react';
import { EMPTY_VALUE } from '../../utils/tradingFormatters.js';
import { getEventSummary } from '../../domain/EventDomain.js';
import {
  getSupervisorHealth,
  supervisorUnavailableField,
} from '../../domain/SupervisorDomain.js';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';
import { FieldGrid } from './FieldGrid.jsx';
import { MetricCard } from './MetricCard.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';

export const SupervisorIntelligence = React.memo(function SupervisorIntelligence({
  overview = {},
  liveActivity = null,
  replay = {},
  batches = {},
  allowlist = null,
  automationPlan = null,
  aiLatest = null,
  updatedAt = null,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
  waiting = false,
}) {
  const sections = useMemo(() => getSupervisorHealth({
    overview,
    liveActivity,
    replay,
    batches,
    allowlist,
    automationPlan,
    aiLatest,
    updatedAt,
  }), [aiLatest, allowlist, automationPlan, batches, liveActivity, overview, replay, updatedAt]);
  const eventSummary = useMemo(() => getEventSummary(eventStore.getAllEvents()), [eventStore]);
  const decisionCount = useMemo(() => decisionStore.getDecisions().length, [decisionStore]);

  return (
    <OverviewPanel
      eyebrow="Supervisor Intelligence"
      title="Trading OS Health"
      summary="Read-only health overview from existing Supervisor, activity, automation and AI status payloads."
      data-trading-event-count={eventSummary.total}
      data-decision-count={decisionCount}
    >
      {waiting ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
          Waiting for runtime...
        </div>
      ) : null}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 10,
        marginBottom: 12,
      }}>
        {sections.map((section) => (
          <MetricCard
            key={section.key}
            label={section.label}
            value={section.displayValue}
            hint={section.path || EMPTY_VALUE}
            tone={section.tone}
          />
        ))}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 12,
      }}>
        {sections.map((section) => (
          <div
            key={`${section.key}-detail`}
            style={{
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 8,
              padding: 12,
            }}
          >
            <div style={{
              color: 'var(--muted)',
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 0,
              marginBottom: 10,
            }}>
              {section.label}
            </div>
            <FieldGrid items={section.rows.length ? section.rows : [supervisorUnavailableField(section.label)]} />
          </div>
        ))}
      </div>
    </OverviewPanel>
  );
});
