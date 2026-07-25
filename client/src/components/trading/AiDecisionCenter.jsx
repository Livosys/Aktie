import React, { useMemo } from 'react';
import { EMPTY_STRATEGY_STORE, strategyDisplayName } from '../../stores/strategyStore.js';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';
import {
  EMPTY_VALUE,
  fmtTime,
  hasValue,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import {
  getAISummary,
  getAIStatusRows,
} from '../../domain/AIDomain.js';
import { getEventSummary } from '../../domain/EventDomain.js';
import { FieldGrid } from './FieldGrid.jsx';
import { OverviewPanel } from './OverviewPanel.jsx';
import { StatusBadge, statusTone } from './StatusBadge.jsx';
import {
  UNAVAILABLE,
  field,
  valueText,
} from './intelligenceUtils.js';

export const AiDecisionCenter = React.memo(function AiDecisionCenter({
  sources = {},
  strategyStore = EMPTY_STRATEGY_STORE,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
  waiting = false,
}) {
  const summary = useMemo(() => getAISummary(sources), [sources]);
  const eventSummary = useMemo(() => getEventSummary(eventStore.getAllEvents()), [eventStore]);
  const decisionCount = useMemo(() => decisionStore.getDecisions().length, [decisionStore]);
  const decision = summary.decision;
  const strategy = useMemo(() => (
    decision?.row ? strategyStore.resolveStrategy(decision.row) : null
  ), [decision, strategyStore]);
  const categories = summary.categories;
  const statuses = useMemo(() => getAIStatusRows(sources, (value) => (
    hasValue(value)
      ? <StatusBadge tone={statusTone(value)} compact>{textOrEmpty(value)}</StatusBadge>
      : UNAVAILABLE
  )), [sources]);

  return (
    <OverviewPanel
      eyebrow="AI Decision Center"
      title="Why Decisions Happened"
      summary="Only explicit fields from existing AI, learning and supervisor responses are rendered. Missing reasoning remains unavailable."
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
        gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        gap: 12,
        marginBottom: 12,
      }}>
        <div style={{
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          borderRadius: 8,
          padding: 12,
        }}>
          <div style={{
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 0,
            marginBottom: 10,
          }}>
            Strategy Link
          </div>
          <FieldGrid
            items={[
              field('Strategy', strategy ? strategyDisplayName(strategy, EMPTY_VALUE) : null, { fallback: UNAVAILABLE }),
              field('Strategy ID', strategy?.strategyId, { fallback: UNAVAILABLE }),
              field('Decision source', decision?.source, { fallback: UNAVAILABLE }),
              field('Title', decision?.row?.title || decision?.row?.name || decision?.row?.label, { fallback: UNAVAILABLE }),
              field('Reason', decision?.row?.reason || decision?.row?.message || decision?.row?.recommendation, { fallback: UNAVAILABLE }),
              field('Created', fmtTime(decision?.row?.createdAt || decision?.row?.timestamp), { fallback: UNAVAILABLE }),
            ]}
          />
        </div>

        <div style={{
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          borderRadius: 8,
          padding: 12,
        }}>
          <div style={{
            color: 'var(--muted)',
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 0,
            marginBottom: 10,
          }}>
            Source Status
          </div>
          <FieldGrid items={statuses.length ? statuses : [field('Sources', null, { fallback: UNAVAILABLE })]} />
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 10,
      }}>
        {categories.map((category) => (
          <div
            key={category.label}
            style={{
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              borderRadius: 8,
              padding: 12,
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>{category.label}</strong>
              <StatusBadge tone={category.rows.length ? 'info' : 'neutral'} compact>
                {category.rows.length ? `${category.rows.length} fields` : UNAVAILABLE}
              </StatusBadge>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {category.rows.length ? category.rows.map((row) => (
                <div key={`${category.label}-${row.hint}`} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, overflowWrap: 'anywhere' }}>
                    {valueText(row.value, EMPTY_VALUE)}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 3, overflowWrap: 'anywhere' }}>
                    {row.hint}
                  </div>
                </div>
              )) : (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>{UNAVAILABLE}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </OverviewPanel>
  );
});
