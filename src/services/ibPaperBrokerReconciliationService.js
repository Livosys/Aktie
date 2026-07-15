'use strict';

const configService = require('./ibPaperExecutionConfigService');
const intentServiceModule = require('./ibPaperExecutionIntentService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'ib_paper_broker_reconciliation',
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function orderRefOf(row = {}) {
  return row.orderRef || row.order?.orderRef || row.execution?.orderRef || null;
}

function executionIdFromOrderRef(ref) {
  const text = String(ref || '');
  if (!text.startsWith('TOS-PAPER-')) return null;
  return text.replace(/^TOS-PAPER-/, '').split('-')[0] || null;
}

function buildLocalIndex(intents = []) {
  const byExecutionId = new Map();
  const byOrderRef = new Map();
  for (const intent of intents) {
    if (intent.executionId) byExecutionId.set(String(intent.executionId), intent);
    if (intent.orderRef) byOrderRef.set(String(intent.orderRef), intent);
  }
  return { byExecutionId, byOrderRef };
}

function compareSnapshots({ intents = [], openOrders = [], executions = [], positions = [], orderStatuses = [] } = {}) {
  const local = buildLocalIndex(intents);
  const discrepancies = [];
  const brokerOrderRefs = new Set(openOrders.map(orderRefOf).filter(Boolean));
  const brokerExecutionRefs = new Set(executions.map(orderRefOf).filter(Boolean));
  const brokerRefs = new Set([...brokerOrderRefs, ...brokerExecutionRefs]);

  for (const ref of brokerRefs) {
    const executionId = executionIdFromOrderRef(ref);
    const match = local.byOrderRef.get(ref) || (executionId ? local.byExecutionId.get(executionId) : null);
    if (!match) {
      discrepancies.push({ type: 'ib_order_missing_locally', orderRef: ref });
    }
  }

  for (const intent of intents) {
    if (!['submitted', 'acknowledged', 'partially_filled'].includes(intent.status)) continue;
    const hasBrokerRef = (intent.orderRef && brokerRefs.has(intent.orderRef))
      || [...brokerRefs].some((ref) => executionIdFromOrderRef(ref) === intent.executionId);
    if (!hasBrokerRef) {
      discrepancies.push({ type: 'internal_order_missing_at_ib', executionId: intent.executionId, status: intent.status });
    }
  }

  const nonFlatPositions = positions.filter((row) => Number(row.position || 0) !== 0);
  const activeStops = openOrders.filter((row) => {
    const orderType = String(row.order?.orderType || row.orderType || '').toUpperCase();
    const status = String(row.status || row.state || '').toLowerCase();
    return orderType === 'STP' && !['cancelled', 'filled'].includes(status);
  });
  if (nonFlatPositions.length > 0 && activeStops.length === 0) {
    discrepancies.push({ type: 'unprotected_position', positions: nonFlatPositions.length });
  }
  if (activeStops.length > nonFlatPositions.length && nonFlatPositions.length === 0) {
    discrepancies.push({ type: 'orphan_protective_order', activeStops: activeStops.length });
  }

  const duplicateIntentKeys = new Set();
  const seenKeys = new Set();
  for (const intent of intents) {
    if (!intent.idempotencyKey) continue;
    if (seenKeys.has(intent.idempotencyKey)) duplicateIntentKeys.add(intent.idempotencyKey);
    seenKeys.add(intent.idempotencyKey);
  }
  for (const key of duplicateIntentKeys) {
    discrepancies.push({ type: 'duplicate_intent', idempotencyKey: key });
  }

  return {
    discrepancies,
    counts: {
      intents: intents.length,
      openOrders: openOrders.length,
      executions: executions.length,
      positions: nonFlatPositions.length,
      orderStatuses: orderStatuses.length,
      activeStops: activeStops.length,
    },
  };
}

function createIbPaperBrokerReconciliationService(options = {}) {
  const adapter = options.adapter;
  const intentService = options.intentService || intentServiceModule.defaultIbPaperExecutionIntentService;
  let lastSnapshot = null;

  async function reconcilePaperBroker({ force = false } = {}) {
    const flags = configService.getFlags();
    const adapterStatus = adapter?.getStatus ? adapter.getStatus() : null;
    const intents = intentService.listIntents({ limit: 250 });
    if (!adapter || adapterStatus?.connected !== true) {
      const snapshot = {
        ok: false,
        status: flags.executionEnabled ? 'degraded' : 'disabled',
        degraded: flags.executionEnabled === true,
        blockedReason: flags.executionEnabled ? 'execution_client_not_connected' : 'ibkr_paper_execution_disabled',
        generatedAt: nowIso(),
        intents,
        openOrders: [],
        executions: [],
        positions: [],
        discrepancies: flags.executionEnabled ? [{ type: 'stale_reconciliation', reason: 'execution_client_not_connected' }] : [],
        counts: { intents: intents.length, openOrders: 0, executions: 0, positions: 0, orderStatuses: 0, activeStops: 0 },
        force,
        ...SAFETY,
      };
      lastSnapshot = snapshot;
      return snapshot;
    }

    const [openOrdersResult, executionsResult, positionsResult] = await Promise.all([
      adapter.getOpenPaperOrders(),
      adapter.getPaperExecutions(),
      adapter.getPaperPositions(),
    ]);
    const openOrders = openOrdersResult.orders || [];
    const executions = executionsResult.executions || [];
    const positions = positionsResult.positions || [];
    const orderStatuses = adapter.getOrderStatuses ? adapter.getOrderStatuses() : [];
    const compared = compareSnapshots({ intents, openOrders, executions, positions, orderStatuses });
    const degraded = compared.discrepancies.length > 0
      || openOrdersResult.ok !== true
      || executionsResult.ok !== true
      || positionsResult.ok !== true;
    const snapshot = {
      ok: true,
      status: degraded ? 'degraded' : 'ok',
      degraded,
      blockedReason: degraded ? (compared.discrepancies[0]?.type || 'broker_reconciliation_degraded') : null,
      generatedAt: nowIso(),
      intents,
      openOrders,
      executions,
      positions,
      orderStatuses,
      discrepancies: compared.discrepancies,
      counts: compared.counts,
      requestStatus: {
        openOrders: { ok: openOrdersResult.ok === true, timedOut: openOrdersResult.timedOut === true },
        executions: { ok: executionsResult.ok === true, timedOut: executionsResult.timedOut === true },
        positions: { ok: positionsResult.ok === true, timedOut: positionsResult.timedOut === true },
      },
      force,
      ...SAFETY,
    };
    lastSnapshot = snapshot;
    return snapshot;
  }

  function getCachedReconciliation() {
    if (lastSnapshot) return lastSnapshot;
    return {
      ok: false,
      status: 'unknown',
      degraded: true,
      blockedReason: 'reconciliation_not_run',
      generatedAt: nowIso(),
      discrepancies: [{ type: 'stale_reconciliation', reason: 'reconciliation_not_run' }],
      counts: { intents: 0, openOrders: 0, executions: 0, positions: 0, orderStatuses: 0, activeStops: 0 },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    compareSnapshots,
    reconcilePaperBroker,
    getCachedReconciliation,
  };
}

module.exports = {
  SAFETY,
  orderRefOf,
  executionIdFromOrderRef,
  compareSnapshots,
  createIbPaperBrokerReconciliationService,
};
