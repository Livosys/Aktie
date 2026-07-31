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

const STALE_ENTRY_FILL_GRACE_MS = 24 * 60 * 60 * 1000;

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

function upperText(value) {
  return String(value || '').trim().toUpperCase();
}

function intentDirectionSign(intent = {}) {
  const raw = upperText(intent.side || intent.action || intent.direction || intent.intent?.direction || intent.intent?.side);
  if (raw === 'BUY' || raw === 'BOT' || raw === 'LONG') return 1;
  if (raw === 'SELL' || raw === 'SLD' || raw === 'SHORT') return -1;
  return null;
}

function positionDirectionSign(position = {}) {
  const quantity = Number(position.position ?? position.signedQuantity ?? position.quantity);
  if (quantity > 0) return 1;
  if (quantity < 0) return -1;
  return null;
}

// Enbart kontraktsidentitet, utan riktning. En flatten ska jämföras så här:
// dess `direction` beskriver positionen den STÄNGDE, inte orderns sida, så en
// riktningsjämförelse skulle kunna släppa igenom en position som vänt.
function positionMatchesIntentContract(position = {}, intent = {}) {
  const intentConId = upperText(intent.conId || intent.intent?.conId || intent.contract?.conId);
  const positionConId = upperText(position.conId || position.contract?.conId);
  const intentLocalSymbol = upperText(intent.localSymbol || intent.intent?.localSymbol || intent.contract?.localSymbol);
  const positionLocalSymbol = upperText(position.localSymbol || position.contract?.localSymbol);
  const intentRoot = upperText(intent.root || intent.intent?.root || intent.symbol || intent.contract?.symbol);
  const positionRoot = upperText(position.root || position.symbol || position.contract?.symbol);
  return Boolean(
    (intentConId && positionConId && intentConId === positionConId)
    || (intentLocalSymbol && positionLocalSymbol && intentLocalSymbol === positionLocalSymbol)
    || (intentRoot && positionRoot && intentRoot === positionRoot)
  );
}

function positionMatchesIntentExposure(position = {}, intent = {}) {
  if (!positionMatchesIntentContract(position, intent)) return false;
  const expectedSign = intentDirectionSign(intent);
  const positionSign = positionDirectionSign(position);
  if (expectedSign === null || positionSign === null) return true;
  return expectedSign === positionSign;
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

// Vilka executionId:n en position bevisligen tillhör, härlett ur brokerns egna
// skyddsordrar på samma kontrakt (deras orderRef bär executionId:t).
// Tom mängd = positionen går inte att tillskriva någon execution.
function positionAttributedExecutionIds(position = {}, openOrders = []) {
  const ids = new Set();
  const positionConId = upperText(position.conId || position.contract?.conId);
  const positionLocalSymbol = upperText(position.localSymbol || position.contract?.localSymbol);
  for (const order of openOrders) {
    const orderConId = upperText(order.contract?.conId ?? order.conId);
    const orderLocalSymbol = upperText(order.contract?.localSymbol || order.localSymbol);
    const sameContract = Boolean(
      (positionConId && orderConId && positionConId === orderConId)
      || (positionLocalSymbol && orderLocalSymbol && positionLocalSymbol === orderLocalSymbol),
    );
    if (!sameContract) continue;
    const executionId = executionIdFromOrderRef(orderRefOf(order));
    if (executionId) ids.add(String(executionId));
  }
  return ids;
}

function isOldEntryFillWithoutBrokerExposure(intent = {}, { nowMs, nonFlatPositions = [], openOrders = [] } = {}) {
  if (!intent.entryFilledAt) return false;
  const stillExposed = nonFlatPositions.some((position) => {
    if (!positionMatchesIntentExposure(position, intent)) return false;
    // positionMatchesIntentExposure jämför bara kontrakt + riktning. En position
    // som bevisligen ägs av en ANNAN execution är inte den här intentens
    // exponering, och ska inte hålla kvar den som oreconcilierad. Kan positionen
    // inte tillskrivas någon execution behålls det konservativa beteendet.
    const owners = positionAttributedExecutionIds(position, openOrders);
    if (owners.size > 0 && intent.executionId && !owners.has(String(intent.executionId))) return false;
    return true;
  });
  if (stillExposed) return false;
  const updatedMs = Date.parse(intent.updatedAt || intent.entryFilledAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - updatedMs >= STALE_ENTRY_FILL_GRACE_MS;
}

// En emergency flatten STÄNGER en position och har därför aldrig någon
// entry-fill — isOldEntryFillWithoutBrokerExposure() faller redan på sin första
// rad och kan strukturellt aldrig omfatta den. Fyllningsvägen kände tidigare
// inte igen '-flatten'-benet, så en flatten som faktiskt fylldes blev kvar på
// 'submitted' för alltid och degraderade reconciliation permanent — vilket
// blockerade varje ny entry. Adaptern sätter numera terminalstatus, men redan
// fastnade poster måste kunna läka.
//
// Beviset för att en flatten gjorde sitt jobb är att kontraktet den riktades mot
// är platt. Finns exponering kvar på kontraktet flaggas den fortfarande — då kan
// vi inte veta att stängningen gick igenom, och konservativt beteende gäller.
// OBS: intent-tjänsten normaliserar bort `kind` och `orderRef` när posten skapas
// — de finns bara på anropets payload, aldrig på den lagrade posten. Identifiera
// därför flatten via fält som bevisligen överlever: executionId ('emergency_
// flatten_<id>') och idempotencyKey ('flatten:<conId>:<execId>'). `kind` behålls
// först i kedjan för anropare som skickar posten in-memory.
const FLATTEN_EXECUTION_ID_PREFIX = 'emergency_flatten_';
const FLATTEN_IDEMPOTENCY_PREFIX = 'flatten:';

function isEmergencyFlattenIntent(intent = {}) {
  if (upperText(intent.kind) === 'EMERGENCY_FLATTEN') return true;
  if (String(intent.executionId || '').startsWith(FLATTEN_EXECUTION_ID_PREFIX)) return true;
  return String(intent.idempotencyKey || '').startsWith(FLATTEN_IDEMPOTENCY_PREFIX);
}

// Den lagrade posten har conId: null, men idempotencyKey bär kontraktet.
function flattenTargetConId(intent = {}) {
  const key = String(intent.idempotencyKey || '');
  if (!key.startsWith(FLATTEN_IDEMPOTENCY_PREFIX)) return null;
  return upperText(key.split(':')[1]) || null;
}

function isOldFlattenWithoutBrokerExposure(intent = {}, { nowMs, nonFlatPositions = [] } = {}) {
  if (!isEmergencyFlattenIntent(intent)) return false;
  const targetConId = flattenTargetConId(intent);
  const stillExposed = nonFlatPositions.some((position) => {
    if (positionMatchesIntentContract(position, intent)) return true;
    if (!targetConId) return false;
    return upperText(position.conId || position.contract?.conId) === targetConId;
  });
  if (stillExposed) return false;
  const updatedMs = Date.parse(intent.updatedAt || intent.submittedAt || intent.createdAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - updatedMs >= STALE_ENTRY_FILL_GRACE_MS;
}

function compareSnapshots({ intents = [], openOrders = [], executions = [], positions = [], orderStatuses = [], now = new Date() } = {}) {
  const local = buildLocalIndex(intents);
  const discrepancies = [];
  const nowMs = Date.parse(now);
  const nonFlatPositions = positions.filter((row) => Number(row.position || 0) !== 0);
  const terminalStatusByOrderId = new Map(
    orderStatuses
      .map((row) => [Number(row.orderId), String(row.status || row.ibStatus || '').toLowerCase()])
      .filter(([orderId, status]) => Number.isFinite(orderId) && ['cancelled', 'filled', 'inactive'].includes(status)),
  );
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
    if (!['submit_started', 'submitted', 'acknowledged', 'partially_filled', 'reconciliation_required', 'unknown'].includes(intent.status)) continue;
    const hasBrokerRef = (intent.orderRef && brokerRefs.has(intent.orderRef))
      || [...brokerRefs].some((ref) => executionIdFromOrderRef(ref) === intent.executionId);
    if (!hasBrokerRef && isOldEntryFillWithoutBrokerExposure(intent, { nowMs, nonFlatPositions, openOrders })) continue;
    if (!hasBrokerRef && isOldFlattenWithoutBrokerExposure(intent, { nowMs, nonFlatPositions })) continue;
    if (!hasBrokerRef && intent.status === 'submit_started') {
      discrepancies.push({ type: 'unknown_submit_state', executionId: intent.executionId, status: intent.status });
    } else if (!hasBrokerRef) {
      discrepancies.push({ type: 'internal_order_missing_at_ib', executionId: intent.executionId, status: intent.status });
    }
  }

  const activeStops = openOrders.filter((row) => {
    const orderType = String(row.order?.orderType || row.orderType || '').toUpperCase();
    const status = String(row.status || row.state || '').toLowerCase();
    return orderType === 'STP'
      && !['cancelled', 'filled', 'inactive'].includes(status)
      && !terminalStatusByOrderId.has(Number(row.orderId));
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
	    if (!adapter || adapterStatus?.connected !== true || adapterStatus?.nextValidIdReady !== true) {
	      const reason = adapterStatus?.connected === true && adapterStatus?.nextValidIdReady !== true
	        ? 'next_valid_id_not_ready'
	        : 'execution_client_not_connected';
	      const snapshot = {
	        ok: false,
	        status: flags.executionEnabled ? 'degraded' : 'disabled',
	        degraded: flags.executionEnabled === true,
	        newEntriesAllowed: false,
	        blockedReason: flags.executionEnabled ? reason : 'ibkr_paper_execution_disabled',
	        generatedAt: nowIso(),
        intents,
        openOrders: [],
        executions: [],
        positions: [],
	        discrepancies: flags.executionEnabled ? [{ type: 'stale_reconciliation', reason }] : [],
        counts: { intents: intents.length, openOrders: 0, executions: 0, positions: 0, orderStatuses: 0, activeStops: 0 },
        force,
        ...SAFETY,
      };
      lastSnapshot = snapshot;
      return snapshot;
    }

    const brokerReadResults = await Promise.allSettled([
      adapter.getOpenPaperOrders(),
      adapter.getPaperPositions(),
      adapter.getPaperExecutions(),
      typeof adapter.refreshAccountSummary === 'function'
        ? adapter.refreshAccountSummary()
        : (typeof adapter.getAccountSummary === 'function' ? adapter.getAccountSummary() : { ok: false, blocker: 'account_summary_unavailable' }),
    ]);
    const rejectedBrokerRead = brokerReadResults.find((result) => result.status === 'rejected');
    if (rejectedBrokerRead) throw rejectedBrokerRead.reason;
    const [
      openOrdersResult,
      positionsResult,
      executionsResult,
      accountSummaryResult,
    ] = brokerReadResults.map((result) => result.value);
	    const openOrders = openOrdersResult.orders || [];
	    const executions = executionsResult.executions || [];
	    const positions = positionsResult.positions || [];
	    const orderStatuses = adapter.getOrderStatuses ? adapter.getOrderStatuses() : [];
	    const compared = compareSnapshots({ intents, openOrders, executions, positions, orderStatuses });
	    const requestDiscrepancies = [];
	    if (openOrdersResult.ok !== true || openOrdersResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_open_orders_timeout', blocker: openOrdersResult.blocker || openOrdersResult.error || 'reconciliation_open_orders_timeout' });
	    if (executionsResult.ok !== true || executionsResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_executions_timeout', blocker: executionsResult.blocker || executionsResult.error || 'reconciliation_executions_timeout' });
	    if (positionsResult.ok !== true || positionsResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_positions_timeout', blocker: positionsResult.blocker || positionsResult.error || 'reconciliation_positions_timeout' });
	    if (accountSummaryResult.ok !== true || accountSummaryResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_account_summary_unavailable', blocker: accountSummaryResult.blocker || accountSummaryResult.error || 'reconciliation_account_summary_unavailable' });
	    const allDiscrepancies = [...requestDiscrepancies, ...compared.discrepancies];
	    const degraded = allDiscrepancies.length > 0;
	    const snapshot = {
	      ok: degraded !== true,
	      status: degraded ? 'degraded' : 'ok',
	      degraded,
	      newEntriesAllowed: degraded !== true,
	      blockedReason: degraded ? (allDiscrepancies[0]?.type || allDiscrepancies[0]?.blocker || 'broker_reconciliation_degraded') : null,
      generatedAt: nowIso(),
      intents,
      openOrders,
      executions,
      positions,
	      orderStatuses,
	      accountSummary: accountSummaryResult,
	      discrepancies: allDiscrepancies,
      counts: compared.counts,
      requestStatus: {
	        openOrders: { ok: openOrdersResult.ok === true, timedOut: openOrdersResult.timedOut === true },
	        executions: { ok: executionsResult.ok === true, timedOut: executionsResult.timedOut === true },
	        positions: { ok: positionsResult.ok === true, timedOut: positionsResult.timedOut === true },
	        accountSummary: { ok: accountSummaryResult.ok === true, timedOut: accountSummaryResult.timedOut === true },
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
	      newEntriesAllowed: false,
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
