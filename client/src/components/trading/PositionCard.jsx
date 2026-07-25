import React, { useMemo } from 'react';
import {
  EMPTY_VALUE,
  fmtAge,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTime,
  signedTone,
  textOrEmpty,
} from '../../utils/tradingFormatters.js';
import { getLatestEvent } from '../../domain/EventDomain.js';
import { getPositionSummary } from '../../domain/PositionDomain.js';
import { TRADING_EVENT_TYPES } from '../../models/tradingEventModel.js';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';
import { StatusBadge } from './StatusBadge.jsx';
import { PositionHeader } from './PositionHeader.jsx';
import { PositionMetrics } from './PositionMetrics.jsx';

export function normalizePositionMetrics(args = {}) {
  return getPositionSummary(args);
}

export const PositionCard = React.memo(function PositionCard({
  position,
  instrument,
  quote,
  brokerOrders = [],
  brokerOrdersAvailable = false,
  reconciliation,
  snapshotAt,
  currency = null,
  strategy = null,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
}) {
  const metrics = useMemo(() => normalizePositionMetrics({
    position,
    instrument,
    quote,
    brokerOrders,
    brokerOrdersAvailable,
    reconciliation,
    snapshotAt,
    currency,
    strategy,
  }), [brokerOrders, brokerOrdersAvailable, currency, instrument, position, quote, reconciliation, snapshotAt, strategy]);
  const eventContext = useMemo(() => {
    const positionEvent = eventStore.resolveEvent(position || {}, { eventType: TRADING_EVENT_TYPES.POSITION });
    const events = positionEvent.positionId ? eventStore.getEventsByPosition(positionEvent.positionId) : [];
    return {
      events,
      latestEvent: getLatestEvent(events),
      count: events.length,
    };
  }, [eventStore, position]);
  const decisionContext = useMemo(() => {
    const positionEvent = eventStore.resolveEvent(position || {}, { eventType: TRADING_EVENT_TYPES.POSITION });
    const decisions = positionEvent.positionId ? decisionStore.getDecisionsByPosition(positionEvent.positionId) : [];
    return {
      decisions,
      latestDecision: decisions[0] || null,
      count: decisions.length,
    };
  }, [decisionStore, eventStore, position]);

  const pnlTone = signedTone(metrics.currentPnl);
  const pointsTone = signedTone(metrics.points);

  return (
    <article data-trading-event-count={eventContext.count} data-decision-count={decisionContext.count} style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 16,
      boxShadow: 'var(--shadow-1, none)',
      display: 'grid',
      gap: 14,
      minWidth: 0,
    }}>
      <PositionHeader
        symbol={metrics.symbol}
        localSymbol={metrics.localSymbol}
        side={metrics.side}
        contracts={metrics.contracts}
        realtimeStatus={metrics.realtimeStatus}
        brokerStatus={metrics.brokerStatus}
      />
      <PositionMetrics
        primary={[
          { label: 'Current PnL', value: fmtMoney(metrics.currentPnl, currency, 2), tone: pnlTone },
          { label: 'Points', value: fmtNumber(metrics.points, 2), tone: pointsTone },
          { label: 'Ticks', value: fmtNumber(metrics.ticks, 0), tone: pointsTone },
          { label: 'PnL %', value: fmtPercent(metrics.pnlPct, 2), tone: pnlTone },
        ]}
        fields={[
          { label: 'Average Entry', value: fmtNumber(metrics.entryPrice, 2) },
          { label: 'Current Price', value: fmtNumber(metrics.currentPrice, 2) },
          { label: 'Market Value', value: fmtMoney(metrics.marketValue, currency, 2) },
          { label: 'Holding Time', value: fmtAge(metrics.holdingMs) },
          { label: 'Current Stop', value: fmtNumber(metrics.currentStop, 2) },
          { label: 'Current Target', value: fmtNumber(metrics.currentTarget, 2) },
          { label: 'Risk', value: fmtMoney(metrics.risk, currency, 2), tone: metrics.risk != null ? 'danger' : 'neutral' },
          { label: 'Reward', value: fmtMoney(metrics.reward, currency, 2), tone: metrics.reward != null ? 'success' : 'neutral' },
          { label: 'Risk / Reward', value: metrics.rr == null ? EMPTY_VALUE : `${fmtNumber(metrics.rr, 2)}R` },
          { label: 'Last Update', value: fmtTime(metrics.lastUpdate) },
          { label: 'Data Source', value: textOrEmpty(metrics.dataSource) },
          { label: 'Broker Orders', value: metrics.brokerOrdersAvailable ? fmtNumber(metrics.matchedOrderCount) : EMPTY_VALUE },
        ]}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <StatusBadge tone="info">tick {fmtNumber(metrics.tickSize, 2)}</StatusBadge>
        <StatusBadge tone="info">point value {fmtMoney(metrics.pointValue, currency, 2)}</StatusBadge>
      </div>
    </article>
  );
});
