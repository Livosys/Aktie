import React, { useMemo } from 'react';
import { WAITING_BROKER, hasValue } from '../../utils/tradingFormatters.js';
import { getLatestEvent } from '../../domain/EventDomain.js';
import { EMPTY_DECISION_STORE } from '../../stores/decisionStore.js';
import { EMPTY_TRADING_EVENT_STORE } from '../../stores/tradingEventStore.js';
import { OrderCard } from './OrderCard.jsx';
import { statusTone, toneTokens } from './StatusBadge.jsx';
import {
  firstValue,
  normalizeOrderView,
  stableOrderKey,
} from './orderFillModel.js';

function statusKey(row = {}) {
  return firstValue(row.orderId, row.ibOrderId, row.permId, row.orderRef);
}

function statusMatchesOrder(status = {}, order = {}) {
  const ids = [
    order.orderId,
    order.ibOrderId,
    order.order?.orderId,
  ].filter(hasValue).map(String);
  const perms = [
    order.permId,
    order.order?.permId,
  ].filter(hasValue).map(String);
  if (hasValue(status.orderId) && ids.includes(String(status.orderId))) return true;
  if (hasValue(status.permId) && perms.includes(String(status.permId))) return true;
  return false;
}

function findOrderStatus(order, orderStatuses) {
  return orderStatuses.find((status) => statusMatchesOrder(status, order)) || null;
}

function rowTime(view = {}) {
  const ms = Date.parse(view.localTimestamp || view.brokerTimestamp || '');
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

function orderEventContext(view = {}, eventStore = EMPTY_TRADING_EVENT_STORE) {
  const ids = [
    view.id,
    view.brokerOrderId,
    view.orderRef,
  ].filter(hasValue);
  const events = uniqueEvents(ids.flatMap((id) => eventStore.getEventsByOrder(id)));
  return {
    events,
    latestEvent: getLatestEvent(events),
    count: events.length,
  };
}

function orderDecisionContext(view = {}, decisionStore = EMPTY_DECISION_STORE) {
  const ids = [
    view.id,
    view.brokerOrderId,
    view.orderRef,
  ].filter(hasValue);
  const decisions = uniqueEvents(ids.flatMap((id) => decisionStore.getDecisionsByOrder(id)));
  return {
    decisions,
    latestDecision: decisions[0] || null,
    count: decisions.length,
  };
}

export const OrderTimeline = React.memo(function OrderTimeline({
  orders = [],
  orderStatuses = [],
  strategyStore,
  strategyViewModelMaps,
  strategyContextMaps,
  eventStore = EMPTY_TRADING_EVENT_STORE,
  decisionStore = EMPTY_DECISION_STORE,
  reconciliation = null,
  snapshotAt = null,
  waiting = false,
}) {
  const views = useMemo(() => {
    const usedStatusKeys = new Set();
    const normalized = orders.map((order) => {
      const orderStatus = findOrderStatus(order, orderStatuses);
      const key = statusKey(orderStatus || {});
      if (key) usedStatusKeys.add(String(key));
      const view = normalizeOrderView({
        order,
        orderStatus,
        strategyStore,
        strategyContextMaps,
        strategyViewModelMaps,
        reconciliation,
        snapshotAt,
      });
      return {
        ...view,
        eventContext: orderEventContext(view, eventStore),
        decisionContext: orderDecisionContext(view, decisionStore),
      };
    });

    for (const status of orderStatuses) {
      const key = statusKey(status);
      if (key && usedStatusKeys.has(String(key))) continue;
      const view = normalizeOrderView({
        order: status,
        orderStatus: status,
        strategyStore,
        strategyContextMaps,
        strategyViewModelMaps,
        reconciliation,
        snapshotAt,
      });
      normalized.push({
        ...view,
        eventContext: orderEventContext(view, eventStore),
        decisionContext: orderDecisionContext(view, decisionStore),
      });
    }

    return normalized.sort((a, b) => rowTime(b) - rowTime(a));
  }, [decisionStore, eventStore, orderStatuses, orders, reconciliation, snapshotAt, strategyContextMaps, strategyStore, strategyViewModelMaps]);

  if (!views.length) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 13 }}>
        {waiting ? WAITING_BROKER : 'Inga orders i broker mirror.'}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {views.map((view, index) => {
        const tokens = toneTokens(statusTone(view.status));
        return (
          <div key={stableOrderKey(view, index)} style={{
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
            <OrderCard order={view} />
          </div>
        );
      })}
    </div>
  );
});
