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

// Statusar där brokern förväntas ha något levande. Samma mängd styr BÅDE vad
// compareSnapshots flaggar och vad självläkningen får röra — de får aldrig
// glida isär, för då kan en intent antingen flaggas utan att kunna läkas eller
// läkas utan att någonsin ha flaggats.
const NON_TERMINAL_INTENT_STATUSES = Object.freeze([
  'submit_started',
  'submitted',
  'acknowledged',
  'partially_filled',
  'reconciliation_required',
  'unknown',
]);

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function orderRefOf(row = {}) {
  return row.orderRef || row.order?.orderRef || row.execution?.orderRef || null;
}

function executionIdFromOrderRef(ref) {
  const text = String(ref || '');
  if (text.startsWith('TOS-PAPER-')) return text.replace(/^TOS-PAPER-/, '').split('-')[0] || null;
  if (text.startsWith('TOS-LIVE-')) return text.replace(/^TOS-LIVE-/, '').split('-')[0] || null;
  return null;
}

function executionTargetFromOrderRef(ref) {
  const text = String(ref || '');
  if (text.startsWith('TOS-LIVE-')) return 'ibkr_live';
  if (text.startsWith('TOS-PAPER-')) return 'ibkr_paper';
  return null;
}

function buildSafety(executionTarget = 'ibkr_paper') {
  return {
    ...configService.buildExecutionSafety(executionTarget),
    source: 'ib_paper_broker_reconciliation',
  };
}

function intentExecutionTarget(intent = {}, fallback = 'ibkr_paper') {
  const raw = intent.executionTarget
    || intent.executionSource
    || intent.intent?.executionTarget
    || intent.intent?.executionSource
    || executionTargetFromOrderRef(orderRefOf(intent))
    || fallback;
  return configService.normalizeExecutionTarget(raw);
}

function filterIntentsForExecutionTarget(intents = [], executionTarget = 'ibkr_paper') {
  const target = configService.normalizeExecutionTarget(executionTarget);
  return (Array.isArray(intents) ? intents : [])
    .filter((intent) => intentExecutionTarget(intent, 'ibkr_paper') === target);
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

// Har intenten kvar exponering som bevisligen är DESS egen?
//
// Generaliserar de två specialfallen ovan till en enda regel. Kontraktsmatchning
// ensam räcker inte — den kan inte skilja "positionen den här intenten gäller"
// från "en helt annan position på samma kontrakt", och eftersom MNQ är enda
// roten som handlas matchar i praktiken allt. Attributionen ur skyddsordrarnas
// orderRef avgör saken: en position som bevisligen ägs av en ANNAN execution är
// inte den här intentens exponering.
//
// Går positionen inte att tillskriva någon execution vet vi ingenting — då
// räknas den som exponering. Konservativt beteende är alltid default.
function intentHasAttributableExposure(intent = {}, { nonFlatPositions = [], openOrders = [] } = {}) {
  const targetConId = flattenTargetConId(intent);
  return nonFlatPositions.some((position) => {
    const sameContract = positionMatchesIntentContract(position, intent)
      || Boolean(targetConId && upperText(position.conId || position.contract?.conId) === targetConId);
    if (!sameContract) return false;
    const owners = positionAttributedExecutionIds(position, openOrders);
    if (owners.size === 0) return true;
    if (!intent.executionId) return true;
    return owners.has(String(intent.executionId));
  });
}

// Reconciliation har hittills bara KUNNAT beskriva ett problem, aldrig avsluta
// det: compareSnapshots är ren och reconcilePaperBroker läser intents utan att
// någonsin skriva. Terminalstatus sätts uteslutande av adapterns event-vägar
// (orderStatus, execDetails, IB-fel). Missas eventet — processen nere, benet
// okänt, gateway borta — finns ingen väg tillbaka: IB:s reqExecutions svarar
// bara med INNEVARANDE handelsdag, så beviset åldras ur brokerns svar och
// intenten blir en permanent orphan som degraderar varje ny entry.
//
// Det här är den saknade vägen. Den är generell — ingen kännedom om strategi,
// kind eller orderben — och vilar på fyra bevis som ALLA måste hålla:
//   1. intenten är icke-terminal (exakt samma mängd compareSnapshots flaggar)
//   2. ingen order- eller execution-ref hos brokern pekar på den
//   3. den är äldre än brokerns bevisfönster (STALE_ENTRY_FILL_GRACE_MS)
//   4. ingen kvarvarande exponering kan tillskrivas just den intenten
//
// Anroparen lägger till ett femte krav som inte kan uttryckas här: att
// broker-läsningen faktiskt lyckades. Absence of evidence får bara räknas som
// evidence of absence när svaret är komplett.
function findResolvableStaleIntents({
  intents = [],
  openOrders = [],
  executions = [],
  positions = [],
  now = new Date(),
} = {}) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  const nonFlatPositions = positions.filter((row) => Number(row.position || 0) !== 0);
  const brokerRefs = new Set([
    ...openOrders.map(orderRefOf).filter(Boolean),
    ...executions.map(orderRefOf).filter(Boolean),
  ]);

  return intents.filter((intent) => {
    if (!NON_TERMINAL_INTENT_STATUSES.includes(intent.status)) return false;
    const hasBrokerRef = (intent.orderRef && brokerRefs.has(intent.orderRef))
      || [...brokerRefs].some((ref) => executionIdFromOrderRef(ref) === intent.executionId);
    if (hasBrokerRef) return false;
    const updatedMs = Date.parse(intent.updatedAt || intent.submittedAt || intent.entryFilledAt || intent.createdAt);
    if (!Number.isFinite(updatedMs)) return false;
    if (nowMs - updatedMs < STALE_ENTRY_FILL_GRACE_MS) return false;
    return !intentHasAttributableExposure(intent, { nonFlatPositions, openOrders });
  });
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
    if (!NON_TERMINAL_INTENT_STATUSES.includes(intent.status)) continue;
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
  const executionTarget = configService.normalizeExecutionTarget(options.executionTarget || configService.getActiveExecutionTarget());
  const environment = configService.getExpectedEnvironment(executionTarget);
  const safety = buildSafety(executionTarget);
  let lastSnapshot = null;

  async function reconcilePaperBroker({ force = false } = {}) {
    const flags = configService.getFlags({ executionTarget });
    const adapterStatus = adapter?.getStatus ? adapter.getStatus() : null;
    const intents = filterIntentsForExecutionTarget(intentService.listIntents({ limit: 250 }), executionTarget);
	    if (!adapter || adapterStatus?.connected !== true || adapterStatus?.nextValidIdReady !== true) {
	      const reason = adapterStatus?.connected === true && adapterStatus?.nextValidIdReady !== true
	        ? 'next_valid_id_not_ready'
	        : 'execution_client_not_connected';
	      const snapshot = {
	        ok: false,
	        status: flags.executionEnabled ? 'degraded' : 'disabled',
	        degraded: flags.executionEnabled === true,
	        newEntriesAllowed: false,
	        blockedReason: flags.executionEnabled
          ? reason
          : (executionTarget === 'ibkr_live' ? 'ibkr_live_execution_disabled' : 'ibkr_paper_execution_disabled'),
	        generatedAt: nowIso(),
        intents,
        openOrders: [],
        executions: [],
        positions: [],
	        discrepancies: flags.executionEnabled ? [{ type: 'stale_reconciliation', reason }] : [],
        counts: { intents: intents.length, openOrders: 0, executions: 0, positions: 0, orderStatuses: 0, activeStops: 0 },
        force,
        executionTarget,
        environment,
        ...safety,
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
	    const requestDiscrepancies = [];
	    if (openOrdersResult.ok !== true || openOrdersResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_open_orders_timeout', blocker: openOrdersResult.blocker || openOrdersResult.error || 'reconciliation_open_orders_timeout' });
	    if (executionsResult.ok !== true || executionsResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_executions_timeout', blocker: executionsResult.blocker || executionsResult.error || 'reconciliation_executions_timeout' });
	    if (positionsResult.ok !== true || positionsResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_positions_timeout', blocker: positionsResult.blocker || positionsResult.error || 'reconciliation_positions_timeout' });
	    if (accountSummaryResult.ok !== true || accountSummaryResult.timedOut === true) requestDiscrepancies.push({ type: 'reconciliation_account_summary_unavailable', blocker: accountSummaryResult.blocker || accountSummaryResult.error || 'reconciliation_account_summary_unavailable' });

	    // Femte beviset (se findResolvableStaleIntents): läk ALDRIG på ett
	    // ofullständigt broker-svar. Är någon läsning trasig eller avkortad
	    // betyder frånvaro av en order ingenting — då är den enda säkra
	    // slutsatsen att vi inte vet, och intenten ska stå kvar som avvikelse.
	    const healed = [];
	    if (requestDiscrepancies.length === 0 && typeof intentService.updateStatus === 'function') {
	      for (const intent of findResolvableStaleIntents({ intents, openOrders, executions, positions })) {
	        // 'expired', inte 'filled'/'cancelled': vi kan bevisa att ordern inte
	        // längre lever hos brokern, men inte hur den slutade. Att gissa utfall
	        // vore att hitta på handelshistorik.
	        const result = intentService.updateStatus(intent.idempotencyKey, 'expired', {
	          blocker: 'broker_evidence_window_elapsed',
	          resolvedBy: 'reconciliation_self_heal',
	          resolvedAt: nowIso(),
	          previousStatus: intent.status,
	        });
	        if (result?.ok) healed.push({ executionId: intent.executionId, previousStatus: intent.status });
	      }
	    }
	    // Läkta poster måste läsas om innan jämförelsen, annars flaggar
	    // compareSnapshots dem en sista gång på en status som inte längre gäller.
	    const effectiveIntents = healed.length
      ? filterIntentsForExecutionTarget(intentService.listIntents({ limit: 250 }), executionTarget)
      : intents;
	    const compared = compareSnapshots({ intents: effectiveIntents, openOrders, executions, positions, orderStatuses });
	    const allDiscrepancies = [...requestDiscrepancies, ...compared.discrepancies];
	    const degraded = allDiscrepancies.length > 0;
	    const snapshot = {
	      ok: degraded !== true,
	      status: degraded ? 'degraded' : 'ok',
	      degraded,
	      newEntriesAllowed: degraded !== true,
	      blockedReason: degraded ? (allDiscrepancies[0]?.type || allDiscrepancies[0]?.blocker || 'broker_reconciliation_degraded') : null,
      generatedAt: nowIso(),
      intents: effectiveIntents,
      healedIntents: healed,
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
      executionTarget,
      environment,
      ...safety,
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
      executionTarget,
      environment,
      ...safety,
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
  NON_TERMINAL_INTENT_STATUSES,
  STALE_ENTRY_FILL_GRACE_MS,
  orderRefOf,
  executionIdFromOrderRef,
  executionTargetFromOrderRef,
  intentExecutionTarget,
  filterIntentsForExecutionTarget,
  intentHasAttributableExposure,
  findResolvableStaleIntents,
  compareSnapshots,
  createIbPaperBrokerReconciliationService,
};
