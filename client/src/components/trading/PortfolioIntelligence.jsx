import React, { useMemo } from 'react';
import { getEventSummary } from '../../domain/EventDomain.js';
import { getAccountSummary } from '../../domain/PortfolioDomain.js';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';
import { FieldGrid } from './FieldGrid.jsx';
import { MetricCard } from './MetricCard.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';

export const PortfolioIntelligence = React.memo(function PortfolioIntelligence({
  account = {},
  portfolio = {},
  reconciliation = {},
  currency = null,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
  waiting = false,
}) {
  const accountSummary = useMemo(() => getAccountSummary({
    account,
    portfolio,
    reconciliation,
    currency,
    waiting,
  }), [account, currency, portfolio, reconciliation, waiting]);
  const eventSummary = useMemo(() => getEventSummary(eventStore.getAllEvents()), [eventStore]);
  const decisionCount = useMemo(() => decisionStore.getDecisions().length, [decisionStore]);

  return (
    <OverviewPanel
      eyebrow="Portfolio Intelligence"
      title="Account, PnL, Margin and Exposure"
      summary="Broker and portfolio values are rendered only when the existing frontend snapshots expose them."
      data-trading-event-count={eventSummary.total}
      data-decision-count={decisionCount}
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 10,
        marginBottom: 12,
      }}>
        {accountSummary.topMetrics.map((metric) => (
          <MetricCard
            key={metric.label}
            label={metric.label}
            value={metric.value}
            hint={metric.hint}
            tone={metric.tone}
          />
        ))}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 12,
      }}>
        {accountSummary.groups.map((group) => (
          <div
            key={group.title}
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
              {group.title}
            </div>
            <FieldGrid items={group.rows} />
          </div>
        ))}
      </div>
    </OverviewPanel>
  );
});
