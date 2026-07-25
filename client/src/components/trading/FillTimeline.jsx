import React, { useMemo } from 'react';
import { WAITING_BROKER, hasValue } from '../../utils/tradingFormatters.js';
import { getLatestEvent } from '../../domain/EventDomain.js';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';
import { FillCard } from './FillCard.jsx';
import { statusTone, toneTokens } from './StatusBadge.jsx';
import {
  normalizeFillView,
  stableFillKey,
} from './orderFillModel.js';

function rowTime(view = {}) {
  const ms = Date.parse(view.executionTime || view.localTimestamp || '');
  return Number.isFinite(ms) ? ms : 0;
}

function uniqueEvents(events = []) {
  const seen = new Set();
  return events.filter((event, index) => {
    const key = event?.eventId || `${event?.eventType || 'event'}-${event?.timestamp || index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fillEventContext(view = {}, eventStore = EMPTY_TRADING_EVENT_STORE) {
  const executionIds = [
    view.id,
    view.brokerExecutionId,
  ].filter(hasValue);
  const orderIds = [
    view.orderId,
    view.orderRef,
  ].filter(hasValue);
  const events = uniqueEvents([
    ...executionIds.flatMap((id) => eventStore.getEventsByExecution(id)),
    ...orderIds.flatMap((id) => eventStore.getEventsByOrder(id)),
  ]);
  return {
    events,
    latestEvent: getLatestEvent(events),
    count: events.length,
  };
}

function fillDecisionContext(view = {}, decisionStore = EMPTY_DECISION_STORE) {
  const orderIds = [
    view.orderId,
    view.orderRef,
  ].filter(hasValue);
  const decisions = uniqueEvents(orderIds.flatMap((id) => decisionStore.getDecisionsByOrder(id)));
  return {
    decisions,
    latestDecision: decisions[0] || null,
    count: decisions.length,
  };
}

export const FillTimeline = React.memo(function FillTimeline({
  fills = [],
  strategyStore,
  strategyViewModelMaps,
  strategyContextMaps,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
  waiting = false,
}) {
  const views = useMemo(() => fills
    .map((fill) => {
      const view = normalizeFillView({ fill, strategyContextMaps, strategyStore, strategyViewModelMaps });
      return {
        ...view,
        eventContext: fillEventContext(view, eventStore),
        decisionContext: fillDecisionContext(view, decisionStore),
      };
    })
    .sort((a, b) => rowTime(b) - rowTime(a)), [decisionStore, eventStore, fills, strategyContextMaps, strategyStore, strategyViewModelMaps]);

  if (!views.length) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 13 }}>
        {waiting ? WAITING_BROKER : 'Inga brokerfills i reconciliation mirror.'}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {views.map((view, index) => {
        const tokens = toneTokens(statusTone(view.strategy?.runtimeState));
        return (
          <div key={stableFillKey(view, index)} style={{
            display: 'grid',
            gridTemplateColumns: '22px minmax(0, 1fr)',
            gap: 10,
          }}>
            <div style={{ position: 'relative', display: 'grid', justifyItems: 'center' }}>
              <span style={{
                width: 12,
                height: 12,
                borderRadius: 999,
                border: `2px solid ${tokens.fg}`,
                background: tokens.bg,
                marginTop: 18,
                zIndex: 1,
              }} />
              {index < views.length - 1 ? (
                <span style={{
                  position: 'absolute',
                  top: 34,
                  bottom: -12,
                  width: 1,
                  background: 'var(--border)',
                }} />
              ) : null}
            </div>
            <FillCard fill={view} />
          </div>
        );
      })}
    </div>
  );
});
