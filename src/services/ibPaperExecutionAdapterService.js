'use strict';

// IBKR PAPER Execution Adapter (§6 i execution-masterprompten).
//
// Enda modulen i futures-flödet som får kalla placeOrder — och ENDAST mot
// ett verifierat IBKR PAPER-konto, med guard-beslut, feature flags och
// idempotens som förkrav. Live-vägar existerar inte:
//   - environment är hårdkodat 'paper'
//   - account måste vara guard-verifierat paper-konto (DU/DF + discovery)
//   - live-flaggor är frysta false-konstanter i ibPaperExecutionConfigService
//
// Ingen anslutning vid require. Egen clientId (IBKR_PAPER_EXECUTION_CLIENT_ID,
// default 956) separat från data (955), readiness (1) och prober (957).
//
// nextValidId-hantering: order-id:n allokeras ENBART från gatewayns färska
// nextValidId för denna klient och räknas upp lokalt per placeOrder inom
// samma session. Vid reconnect hämtas nytt nextValidId — inga antaganden.

const {
  IBApi, EventName, SecType, OrderAction, OrderType, TimeInForce,
} = require('@stoqey/ib');
const crypto = require('crypto');
const configService = require('./ibPaperExecutionConfigService');
const adapterModule = require('./ibFuturesDataAdapterService');
const guardService = require('./ibPaperExecutionGuardService');
const intentServiceModule = require('./ibPaperExecutionIntentService');
const lifecycleIdentity = require('./futuresLifecycleIdentityService');

const ENVIRONMENT = 'paper'; // hårdkodat — ingen kodväg kan sätta 'live'

const EXECUTION_SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: ENVIRONMENT,
  paper_trading_enabled: true,
  ...configService.LIVE_EXECUTION,
  paperOnly: true,
  source: 'ib_paper_execution_adapter',
});

const EVIDENCE_VERSION = 1;
const ORDER_REF_PREFIX = 'TOS-PAPER-';
const CONNECTION_STATES = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED',
});
const RUNTIME_LIFECYCLE_STEPS = Object.freeze(['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'READY', 'HEARTBEAT', 'IDLE']);
const ACCOUNT_SUMMARY_TAGS = 'AccountType,NetLiquidation,TotalCashValue,AvailableFunds,BuyingPower,RealizedPnL,UnrealizedPnL,MaintMarginReq,InitMarginReq,Cushion';
const evidenceSecret = crypto.randomBytes(32).toString('hex');
const TERMINAL_ORDER_STATUSES = new Set(['filled', 'cancelled', 'inactive']);

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

// IB orderRef (§15): kort, icke-känsligt internt id.
function buildOrderRef(executionId, leg = 'entry') {
  const shortId = String(executionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-20);
  return `TOS-PAPER-${shortId}-${leg}`.slice(0, 48);
}

// Normaliserade IB-orderstatusar (§16). En status som inte finns här
// mappas till 'unknown' — aldrig till en fill.
const IB_STATUS_MAP = Object.freeze({
  PendingSubmit: 'pending_submit',
  PreSubmitted: 'pre_submitted',
  Submitted: 'submitted',
  ApiPending: 'pending_submit',
  PendingCancel: 'pending_cancel',
  Cancelled: 'cancelled',
  ApiCancelled: 'cancelled',
  Filled: 'filled',
  Inactive: 'inactive',
});
const TERMINAL_ORDER_REJECT_ERROR_CODES = new Set([110, 201, 321]);
const TERMINAL_ORDER_CANCEL_ERROR_CODES = new Set([202]);

function normalizeIbStatus(status, filled = 0, remaining = null) {
  const mapped = IB_STATUS_MAP[String(status || '')] || 'unknown';
  if (mapped === 'submitted' && Number(filled) > 0 && Number(remaining) > 0) return 'partially_filled';
  return mapped;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function hmac(value) {
  return crypto.createHmac('sha256', evidenceSecret).update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function priceTickSizeForRoot(root) {
  const upper = String(root || '').toUpperCase();
  if (['MNQ', 'MES', 'NQ', 'ES'].includes(upper)) return 0.25;
  return 0.01;
}

function roundPriceToTick(value, tickSize = 0.01) {
  const price = Number(value);
  const tick = Number(tickSize);
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return value;
  const decimals = Math.max(0, String(tick).split('.')[1]?.length || 0);
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

function contractFingerprint(contract = {}) {
  return sha256({
    conId: Number(contract.conId) || null,
    localSymbol: String(contract.localSymbol || '').toUpperCase(),
    symbol: String(contract.symbol || contract.root || '').toUpperCase(),
    secType: String(contract.secType || '').toUpperCase(),
    exchange: String(contract.exchange || '').toUpperCase(),
    currency: String(contract.currency || '').toUpperCase(),
    expiry: String(contract.expiry || contract.lastTradeDateOrContractMonth || ''),
  });
}

function orderPlanFingerprint(orderPlan = {}) {
  return sha256({
    environment: orderPlan.environment || null,
    contract: {
      conId: Number(orderPlan.contract?.conId) || null,
      localSymbol: String(orderPlan.contract?.localSymbol || '').toUpperCase(),
      symbol: String(orderPlan.contract?.symbol || orderPlan.contract?.root || '').toUpperCase(),
      secType: String(orderPlan.contract?.secType || '').toUpperCase(),
      exchange: String(orderPlan.contract?.exchange || '').toUpperCase(),
      currency: String(orderPlan.contract?.currency || '').toUpperCase(),
    },
    entry: {
      action: orderPlan.entry?.action || null,
      totalQuantity: orderPlan.entry?.totalQuantity ?? null,
      orderType: orderPlan.entry?.orderType || null,
      lmtPrice: orderPlan.entry?.lmtPrice ?? null,
      tif: orderPlan.entry?.tif || null,
      outsideRth: orderPlan.entry?.outsideRth === true,
      transmit: orderPlan.entry?.transmit === true,
      orderRef: orderPlan.entry?.orderRef || null,
    },
    takeProfit: orderPlan.takeProfit ? {
      action: orderPlan.takeProfit.action || null,
      totalQuantity: orderPlan.takeProfit.totalQuantity ?? null,
      orderType: orderPlan.takeProfit.orderType || null,
      lmtPrice: orderPlan.takeProfit.lmtPrice ?? null,
      tif: orderPlan.takeProfit.tif || null,
      outsideRth: orderPlan.takeProfit.outsideRth === true,
      transmit: orderPlan.takeProfit.transmit === true,
      orderRef: orderPlan.takeProfit.orderRef || null,
    } : null,
    stopLoss: {
      action: orderPlan.stopLoss?.action || null,
      totalQuantity: orderPlan.stopLoss?.totalQuantity ?? null,
      orderType: orderPlan.stopLoss?.orderType || null,
      auxPrice: orderPlan.stopLoss?.auxPrice ?? null,
      tif: orderPlan.stopLoss?.tif || null,
      outsideRth: orderPlan.stopLoss?.outsideRth === true,
      transmit: orderPlan.stopLoss?.transmit === true,
      orderRef: orderPlan.stopLoss?.orderRef || null,
    },
    ocaGroup: orderPlan.ocaGroup || null,
    transmitSequence: orderPlan.transmitSequence || [],
  });
}

function buildEvidencePayload({
  guardDecision,
  intentRecord,
  orderPlan,
  brokerRisk,
  executionAllowlist,
  entryContract,
  reconciliation,
  verifiedAccount,
} = {}) {
  return {
    evidenceVersion: EVIDENCE_VERSION,
    intent: {
      lifecycleId: intentRecord?.lifecycleId || null,
      executionId: intentRecord?.executionId || null,
      intentId: intentRecord?.intentId || intentRecord?.idempotencyKey || null,
      idempotencyKey: intentRecord?.idempotencyKey || null,
      strategyId: intentRecord?.strategyId || null,
      candidateId: intentRecord?.candidateId || null,
      signalId: intentRecord?.signalId || null,
      root: intentRecord?.root || null,
	      direction: intentRecord?.direction || null,
	      executionTarget: intentRecord?.executionTarget || null,
	    },
    orderPlanFingerprint: orderPlanFingerprint(orderPlan),
    contractFingerprint: contractFingerprint(orderPlan?.contract || {}),
    guard: {
      allowed: guardDecision?.allowed === true,
      environment: guardDecision?.environment || null,
      verifiedPaperAccount: guardDecision?.verifiedPaperAccount === true,
      liveAccountBlocked: guardDecision?.liveAccountBlocked === true,
      blockedReason: guardDecision?.blockedReason || null,
      checks: (guardDecision?.checks || []).map((check) => ({ code: check.code, ok: check.ok === true, blocker: check.blocker || null })),
    },
    brokerRisk: {
      allowed: brokerRisk?.allowed === true,
      blockedReason: brokerRisk?.blockedReason || null,
      checks: (brokerRisk?.checks || []).map((check) => ({ code: check.code, ok: check.ok === true, blocker: check.blocker || null })),
    },
    executionAllowlist: {
      allowed: executionAllowlistAllowed(executionAllowlist),
      source: executionAllowlist?.source || executionAllowlist?.executionAllowlist?.source || null,
      strategyId: executionAllowlist?.strategyId || intentRecord?.strategyId || null,
      status: executionAllowlist?.status || null,
      enabled: executionAllowlist?.enabled ?? null,
    },
    entryContract: {
      allowed: entryContract?.allowed === true || entryContract?.entryContractApproved === true,
      version: entryContract?.entryContractVersion || entryContract?.version || null,
      reasonCode: entryContract?.reasonCode || null,
    },
    reconciliation: {
      degraded: reconciliation?.degraded === true,
      status: reconciliation?.status || null,
      blockedReason: reconciliation?.blockedReason || null,
      counts: reconciliation?.counts || {},
    },
    verifiedAccount: {
      ok: verifiedAccount?.ok === true,
      accountIdMasked: verifiedAccount?.accountIdMasked || null,
      classification: verifiedAccount?.classification || null,
    },
  };
}

function isGuardVerifiedPaper(guardDecision) {
  return guardDecision
    && guardDecision.allowed === true
    && guardDecision.environment === ENVIRONMENT
    && guardDecision.verifiedPaperAccount === true
    && guardDecision.liveAccountBlocked === true;
}

function executionAllowlistAllowed(evidence = {}) {
  return evidence?.allowed === true
    || evidence?.executionAllowed === true
    || evidence?.strategyExecutionAllowed === true
    || evidence?.executionAllowlist?.allowed === true;
}

function entryContractAllowed(evidence = {}) {
  return evidence?.allowed === true || evidence?.entryContractApproved === true;
}

function createBlockers() {
  const blockers = [];
  return {
    add(ok, blocker) {
      if (ok !== true) blockers.push(blocker);
    },
    list() { return blockers.filter(Boolean); },
  };
}

function validateOrderPlanForSubmit(orderPlan, { intentRecord = null, verifiedAccount = null, now = new Date() } = {}) {
  const checks = createBlockers();
  const limits = configService.getPilotLimits();
  const root = String(intentRecord?.root || orderPlan?.contract?.symbol || '').toUpperCase();
  const contractValidation = guardService.validateContract({
    ...(orderPlan?.contract || {}),
    expiry: orderPlan?.contract?.expiry || orderPlan?.contract?.lastTradeDateOrContractMonth || intentRecord?.expiry || null,
    root,
  }, root, now);
  const entry = orderPlan?.entry || {};
  const stop = orderPlan?.stopLoss || {};
  const tp = orderPlan?.takeProfit || null;
  const entryQty = entry.totalQuantity;
  const stopQty = stop.totalQuantity;
  const tpQty = tp?.totalQuantity;
  const entryAction = String(entry.action || '').toUpperCase();
  const stopAction = String(stop.action || '').toUpperCase();
  const tpAction = String(tp?.action || '').toUpperCase();
  const expectedExit = entryAction === OrderAction.BUY ? OrderAction.SELL : OrderAction.BUY;
  const stopCount = [stop].filter((leg) => String(leg?.orderType || '').toUpperCase() === OrderType.STP).length;

  checks.add(orderPlan?.environment === ENVIRONMENT, 'environment_not_paper');
  checks.add(limits.symbolAllowlist.includes(root), 'symbol_not_allowlisted');
  for (const blocker of contractValidation.blockers || []) checks.add(false, blocker);
  checks.add(Number.isInteger(entryQty) && entryQty === 1, 'quantity_must_be_exactly_one');
  checks.add(Number.isInteger(stopQty) && stopQty === 1, 'stop_quantity_mismatch');
  checks.add(Boolean(tp), 'take_profit_required');
  checks.add(Number.isInteger(tpQty) && tpQty === 1, 'take_profit_quantity_mismatch');
  checks.add(entryAction === OrderAction.BUY || entryAction === OrderAction.SELL, 'entry_action_invalid');
  checks.add(stopAction === expectedExit, 'stop_action_not_opposite_entry');
  checks.add(!tp || tpAction === expectedExit, 'take_profit_action_not_opposite_entry');
  checks.add([OrderType.MKT, OrderType.LMT].includes(String(entry.orderType || '').toUpperCase()), 'entry_order_type_not_allowed');
  checks.add(String(stop.orderType || '').toUpperCase() === OrderType.STP && Number.isFinite(Number(stop.auxPrice)), 'stop_loss_required');
  checks.add(String(tp?.orderType || '').toUpperCase() === OrderType.LMT && Number.isFinite(Number(tp?.lmtPrice)), 'take_profit_invalid');
  checks.add(stopCount === 1, 'exactly_one_stop_required');
  checks.add(entry.transmit === false, 'entry_transmit_must_be_false');
  checks.add(tp?.transmit === false, 'take_profit_transmit_must_be_false');
  checks.add(stop.transmit === true, 'stop_loss_must_be_final_transmit');
  checks.add(Array.isArray(orderPlan?.transmitSequence)
    && orderPlan.transmitSequence.join('|') === 'entry:false|takeProfit:false|stopLoss:true', 'bracket_transmit_sequence_invalid');
  checks.add(String(entry.orderRef || '').startsWith(ORDER_REF_PREFIX), 'entry_order_ref_invalid');
  checks.add(String(stop.orderRef || '').startsWith(ORDER_REF_PREFIX), 'stop_order_ref_invalid');
  checks.add(String(tp?.orderRef || '').startsWith(ORDER_REF_PREFIX), 'take_profit_order_ref_invalid');
  checks.add(Boolean(orderPlan?.ocaGroup), 'oca_group_missing');
  checks.add(verifiedAccount?.classification === 'paper' && verifiedAccount?.ok === true, 'paper_account_not_verified');

  const blockers = checks.list();
  return {
    ok: blockers.length === 0,
    blockers,
    blockedReason: blockers[0] || null,
    contractFingerprint: contractFingerprint(orderPlan?.contract || {}),
    orderPlanFingerprint: orderPlanFingerprint(orderPlan || {}),
  };
}

function createIbPaperExecutionAdapterService(options = {}) {
  const config = {
    host: options.host || process.env.IB_GATEWAY_HOST || '127.0.0.1',
    port: Number(options.port || process.env.IB_GATEWAY_PORT || 4002),
    clientId: Number(options.clientId || envInt('IBKR_PAPER_EXECUTION_CLIENT_ID', 956)),
    connectTimeoutMs: Number(options.connectTimeoutMs || 12000),
    requestTimeoutMs: Number(options.requestTimeoutMs || 20000),
    heartbeatMs: Number(options.heartbeatMs || 15_000),
    reconnectBaseDelayMs: Number(options.reconnectBaseDelayMs || 1_000),
    reconnectMaxDelayMs: Number(options.reconnectMaxDelayMs || 30_000),
  };
	  const flagsProvider = options.flagsProvider || configService.getFlags;
	  const ibFactory = options.ibFactory || ((cfg) => new IBApi({ host: cfg.host, port: cfg.port, clientId: cfg.clientId }));
	  const intentService = options.intentService || intentServiceModule.defaultIbPaperExecutionIntentService;

	  let ib = null;
  let connected = false;
  let connecting = false;
  let nextOrderId = null; // sätts ENDAST av nextValidId-eventet
  let managedAccounts = [];
  let connectedAt = null;
  let runtimeStartedAt = null;
  let lastConnected = null;
  let lastHeartbeat = null;
  let lastReconnect = null;
  let lastReadyAt = null;
  let lastReconciliationAt = null;
  let lastNextValidId = null;
  let reconnectCount = 0;
  let submitInProgress = false;
  const lastErrors = [];
  let connectionState = CONNECTION_STATES.DISCONNECTED;
  let lastLifecycleStep = CONNECTION_STATES.DISCONNECTED;
  let permanentRuntime = false;
  let connectPromise = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let accountSummarySnapshot = null;
  let reqSeq = Number(config.clientId) * 1000;

  // Event-speglar (read-only state för reconciliation/UI).
  const openOrders = new Map(); // orderId -> {order, contract, status}
  const orderStatuses = new Map(); // orderId -> normaliserad status
  const executions = []; // senaste execDetails
  const commissions = []; // senaste commissionReports
  const positions = new Map(); // account:conId -> position
  const eventLog = []; // senaste orderhändelser (ring)

  const pending = new Map(); // reqId/marker -> resolver för list-requests
  let orderEventListeners = [];

	  function logEvent(type, payload = {}) {
	    eventLog.push({ type, at: nowIso(), ...payload });
	    if (eventLog.length > 200) eventLog.shift();
    for (const listener of orderEventListeners) {
      try { listener({ type, at: nowIso(), ...payload }); } catch (_) { /* isolerat */ }
    }
  }

	  function recordError(code, message, reqId) {
	    lastErrors.push({ at: nowIso(), code: Number(code) || null, message: String(message || ''), reqId: reqId ?? null });
	    if (lastErrors.length > 25) lastErrors.shift();
	  }

	  function isTerminalOrderRejectError(code, message = '') {
	    return TERMINAL_ORDER_REJECT_ERROR_CODES.has(Number(code))
	      || /order\s+rejected|minimum price variation|read-?only mode|api interface currently in read-?only/i.test(String(message || ''));
	  }

	  function isTerminalOrderCancelError(code, message = '') {
	    return TERMINAL_ORDER_CANCEL_ERROR_CODES.has(Number(code))
	      || /order\s+cancelled|order\s+canceled/i.test(String(message || ''));
	  }

	  function legFromOrderRef(ref = '') {
	    const text = String(ref || '');
	    if (text.endsWith('-entry')) return 'entry';
	    if (text.endsWith('-takeProfit')) return 'takeProfit';
	    if (text.endsWith('-stopLoss')) return 'stopLoss';
	    // Nödstängningen lägger sin order på ett fjärde ben ('-flatten'). Utan det
	    // här fallet blev leg=null och fyllningsvägarna nedan kastade eventet tyst,
	    // så en flatten som FAKTISKT fylldes fastnade på 'submitted' för alltid och
	    // degraderade reconciliation permanent.
	    if (text.endsWith('-flatten')) return 'flatten';
	    return null;
	  }

	  function orderRefForOwnedOrder(orderId, owned = {}) {
	    const open = openOrders.get(Number(orderId));
	    if (open?.order?.orderRef) return open.order.orderRef;
	    const ids = Array.isArray(owned.expectedOrderIds) ? owned.expectedOrderIds.map(Number) : [];
	    const refs = Array.isArray(owned.orderRefs) ? owned.orderRefs.map(String) : [];
	    const index = ids.indexOf(Number(orderId));
	    return index >= 0 ? refs[index] || null : owned.orderRef || null;
	  }

	  function findOwnedIntentForExecId(execId) {
	    const wanted = String(execId || '').trim();
	    if (!wanted) return null;
	    return intentService.listIntents({ limit: 500 }).find((intent) => (
	      String(intent?.entryExecId || '') === wanted
	      || String(intent?.filledExecId || '') === wanted
	    )) || null;
	  }

	  function persistExecutionDetails(contract, execution) {
	    const owned = findOwnedIntentForOrder({
	      orderId: execution?.orderId,
	      orderRef: execution?.orderRef,
	    });
	    if (!owned?.idempotencyKey) return null;
	    const orderRef = execution?.orderRef || orderRefForOwnedOrder(execution?.orderId, owned);
	    const leg = legFromOrderRef(orderRef);
	    const price = numberOrNull(execution?.price);
	    const quantity = numberOrNull(execution?.shares);
	    const patch = { reconciliationRequired: false };
	    if (leg === 'entry') {
	      patch.entryExecId = execution?.execId || null;
	      patch.entryExecutionTime = execution?.time || null;
	      patch.entrySide = execution?.side || null;
	      patch.entryQuantity = quantity;
	      if (price !== null) patch.entryFilledPrice = price;
	    } else if (leg === 'takeProfit' || leg === 'stopLoss' || leg === 'flatten') {
	      // En flatten-fill ÄR en exit-fill: positionen stängs. Samma terminalstatus
	      // som TP/SL, annars saknar intenten terminalstatus och flaggas för evigt.
	      patch.filledLeg = leg;
	      patch.filledExecId = execution?.execId || null;
	      patch.filledExecutionTime = execution?.time || null;
	      patch.filledSide = execution?.side || null;
	      patch.filledQuantity = quantity;
	      if (price !== null) patch.filledPrice = price;
	    } else {
	      return null;
	    }
	    if (contract?.conId != null && owned.conId == null) patch.conId = contract.conId;
	    return intentService.updateStatus(
	      owned.idempotencyKey,
	      leg === 'entry' ? (owned.status || 'submitted') : 'filled',
	      patch,
	    );
	  }

	  function handleFilledOrderStatus({ orderId, avgFillPrice = null, lastFillPrice = null } = {}) {
	    const owned = findOwnedIntentForOrder({ orderId });
	    if (!owned?.idempotencyKey) return null;
	    const orderRef = orderRefForOwnedOrder(orderId, owned);
	    const leg = legFromOrderRef(orderRef);
	    const price = numberOrNull(lastFillPrice) ?? numberOrNull(avgFillPrice);
	    // 'flatten' hör hit: nödstängningens fill är en exit-fill som ska ge
	    // terminalstatus. Utan den föll den ur alla grenar och returnerade null.
	    if (leg === 'takeProfit' || leg === 'stopLoss' || leg === 'flatten') {
	      const result = intentService.updateStatus(owned.idempotencyKey, 'filled', {
	        reconciliationRequired: false,
	        filledOrderId: Number(orderId),
	        filledLeg: leg,
	        filledAt: nowIso(),
	        filledPrice: price,
	        filledAvgPrice: numberOrNull(avgFillPrice),
	        filledLastPrice: numberOrNull(lastFillPrice),
	      });
	      logEvent('intent_exit_filled_by_ib', {
	        executionId: owned.executionId || null,
	        orderId: Number(orderId),
	        leg,
	        price,
	      });
	      return result;
	    }
	    if (leg === 'entry') {
	      const result = intentService.updateStatus(owned.idempotencyKey, owned.status || 'submitted', {
	        reconciliationRequired: false,
	        entryFilledOrderId: Number(orderId),
	        entryFilledAt: nowIso(),
	        entryFilledPrice: price,
	        entryAvgFillPrice: numberOrNull(avgFillPrice),
	        entryLastFillPrice: numberOrNull(lastFillPrice),
	      });
	      logEvent('intent_entry_filled_by_ib', {
	        executionId: owned.executionId || null,
	        orderId: Number(orderId),
	        price,
	      });
	      return result;
	    }
	    return null;
	  }

	  function handleTerminalOrderError({ code, message, reqId } = {}) {
	    const orderId = Number(reqId);
	    if (!Number.isFinite(orderId)) return null;
	    const owned = findOwnedIntentForOrder({ orderId });
	    if (!owned?.idempotencyKey) return null;
	    if (isTerminalOrderRejectError(code, message)) {
	      const result = intentService.updateStatus(owned.idempotencyKey, 'rejected', {
	        blocker: 'ibkr_order_rejected',
	        ibErrorCode: Number(code) || null,
	        ibErrorMessage: String(message || ''),
	        rejectedOrderId: orderId,
	        rejectedReason: String(message || ''),
	        reconciliationRequired: false,
	      });
	      logEvent('intent_rejected_by_ib', {
	        executionId: owned.executionId || null,
	        orderId,
	        code: Number(code) || null,
	      });
	      return result;
	    }
	    if (isTerminalOrderCancelError(code, message)) {
	      const orderRef = orderRefForOwnedOrder(orderId, owned);
	      const leg = legFromOrderRef(orderRef);
	      if (leg === 'takeProfit' || leg === 'stopLoss') {
	        const result = intentService.updateStatus(owned.idempotencyKey, owned.status || 'submitted', {
	          ibErrorCode: Number(code) || null,
	          ibErrorMessage: String(message || ''),
	          protectiveOrderCancelledId: orderId,
	          protectiveOrderCancelReason: String(message || ''),
	          reconciliationRequired: false,
	        });
	        logEvent('protective_order_cancelled_by_ib', {
	          executionId: owned.executionId || null,
	          orderId,
	          leg,
	          code: Number(code) || null,
	        });
	        return result;
	      }
	      const result = intentService.updateStatus(owned.idempotencyKey, 'cancelled', {
	        blocker: 'ibkr_order_cancelled',
	        ibErrorCode: Number(code) || null,
	        ibErrorMessage: String(message || ''),
	        cancelledOrderId: orderId,
	        cancelReason: String(message || ''),
	        reconciliationRequired: false,
	      });
	      logEvent('intent_cancelled_by_ib', {
	        executionId: owned.executionId || null,
	        orderId,
	        code: Number(code) || null,
	      });
	      return result;
	    }
	    return null;
	  }

  function setRuntimeLifecycleStep(step, reason = null, extra = {}) {
    if (!RUNTIME_LIFECYCLE_STEPS.includes(step)) return;
    if (lastLifecycleStep === step) return;
    const from = lastLifecycleStep;
    lastLifecycleStep = step;
    logEvent('runtime_lifecycle', { from, to: step, reason, ...extra });
  }

  function setConnectionState(nextState, reason = null, extra = {}) {
    if (!CONNECTION_STATES[nextState]) return;
    if (RUNTIME_LIFECYCLE_STEPS.includes(nextState)) {
      setRuntimeLifecycleStep(nextState, reason, extra);
    }
    if (connectionState === nextState) return;
    const from = connectionState;
    connectionState = nextState;
    logEvent('state_transition', { from, to: nextState, reason, ...extra });
  }

  function nextReqId() {
    reqSeq += 1;
    if (reqSeq > 2_000_000_000) reqSeq = Number(config.clientId) * 1000;
    return reqSeq;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      lastHeartbeat = nowIso();
      if (connectionState === CONNECTION_STATES.READY) {
        setRuntimeLifecycleStep('HEARTBEAT', 'heartbeat_tick');
      }
      logEvent('heartbeat', {
        state: connectionState,
        connected,
        nextValidIdReady: nextOrderId != null,
        managedAccountsReady: managedAccounts.length > 0,
      });
      if (connectionState === CONNECTION_STATES.READY) {
        setRuntimeLifecycleStep('IDLE', 'heartbeat_complete');
      }
      if (permanentRuntime && !connecting && (!connected || !ib)) {
        scheduleReconnect('heartbeat_not_connected');
      }
    }, config.heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function scheduleReconnect(reason = 'disconnected') {
    if (!permanentRuntime) return;
    if (reconnectTimer || connecting) return;
    setConnectionState(CONNECTION_STATES.RECONNECTING, reason);
    const delayMs = Math.min(config.reconnectMaxDelayMs, config.reconnectBaseDelayMs * (1 + reconnectCount));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      lastReconnect = nowIso();
      connectPaperExecutionClient({ reason: 'reconnect' }).catch((err) => {
        recordError(null, `reconnect_failed: ${err.message || String(err)}`);
      });
    }, delayMs);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function handleDisconnect(reason = 'disconnected') {
    connected = false;
    connecting = false;
    connectPromise = null;
    nextOrderId = null; // aldrig återanvända gamla order-id efter disconnect
    accountSummarySnapshot = null;
    connectedAt = null;
    ib = null;
    for (const [, entry] of pending.entries()) {
      try { entry.resolve?.([]); } catch (_) { /* ignore */ }
    }
    pending.clear();
    logEvent(reason, {});
    if (permanentRuntime) scheduleReconnect(reason);
    else setConnectionState(CONNECTION_STATES.DISCONNECTED, reason);
  }

  function maskAccount(id) {
    return adapterModule.maskAccountId(id);
  }

  function attachHandlers(client) {
    client.on(EventName.error, (err, code, reqId) => {
      const message = err instanceof Error ? err.message : String(err);
      const numCode = Number(code);
      if (![2104, 2106, 2107, 2108, 2119, 2158].includes(numCode)) {
        recordError(numCode, message, reqId);
	        logEvent('ib_error', { code: numCode || null, message, reqId: reqId ?? null });
	        handleTerminalOrderError({ code: numCode, message, reqId });
	      }
	    });
    client.on(EventName.connected, () => {
      connected = true;
      connectedAt = nowIso();
      lastConnected = nowIso();
      logEvent('socket_connected', { host: config.host, port: config.port, clientId: config.clientId });
      setConnectionState(CONNECTION_STATES.CONNECTED, 'socket_connected');
    });
	    client.on(EventName.disconnected, () => {
	      handleDisconnect('disconnected');
	    });
    if (EventName.connectionClosed) {
      client.on(EventName.connectionClosed, () => {
        logEvent('connectionClosed', { clientId: config.clientId });
        handleDisconnect('connection_closed');
      });
    }
	    client.on(EventName.nextValidId, (orderId) => {
	      nextOrderId = Number(orderId);
      lastNextValidId = nextOrderId;
	      logEvent('next_valid_id', { nextValidIdReady: nextOrderId != null, nextValidId: nextOrderId });
	    });
	    client.on(EventName.managedAccounts, (accounts) => {
	      managedAccounts = String(accounts || '').split(',').map((s) => s.trim()).filter(Boolean);
      logEvent('managed_accounts', { count: managedAccounts.length, accountsMasked: managedAccounts.map(maskAccount) });
	    });
    client.on(EventName.openOrder, (orderId, contract, order, orderState) => {
      const normalizedOpenStatus = normalizeIbStatus(orderState?.status);
      const owned = findOwnedIntentForOrder({ orderId: Number(orderId), orderRef: order?.orderRef });
      const identity = lifecycleIdentity.mergeIdentity(owned, owned?.intent);
      if (TERMINAL_ORDER_STATUSES.has(normalizedOpenStatus)) {
        openOrders.delete(Number(orderId));
        logEvent('open_order_terminal', { ...identity, orderId: Number(orderId), status: orderState?.status ?? null, orderRef: order?.orderRef ?? null });
        return;
      }
      openOrders.set(Number(orderId), {
        ...identity,
        orderId: Number(orderId),
        contract: {
          conId: contract?.conId ?? null,
          localSymbol: contract?.localSymbol ?? null,
          secType: contract?.secType ?? null,
          symbol: contract?.symbol ?? null,
          exchange: contract?.exchange ?? null,
          currency: contract?.currency ?? null,
          expiry: contract?.expiry ?? contract?.lastTradeDateOrContractMonth ?? null,
          lastTradeDateOrContractMonth: contract?.lastTradeDateOrContractMonth ?? contract?.expiry ?? null,
        },
        order: {
          action: order?.action ?? null,
          totalQuantity: order?.totalQuantity ?? null,
          orderType: order?.orderType ?? null,
          lmtPrice: order?.lmtPrice ?? null,
          auxPrice: order?.auxPrice ?? null,
          tif: order?.tif ?? null,
          outsideRth: order?.outsideRth === true,
          orderRef: order?.orderRef ?? null,
	          parentId: order?.parentId ?? null,
	          ocaGroup: order?.ocaGroup ?? null,
	          ocaType: order?.ocaType ?? null,
	          transmit: order?.transmit === true,
	          accountMasked: maskAccount(order?.account),
          permId: order?.permId ?? null,
        },
        state: orderState?.status ?? null,
        updatedAt: nowIso(),
      });
      logEvent('open_order', { ...identity, orderId: Number(orderId), status: orderState?.status ?? null, orderRef: order?.orderRef ?? null });
    });
    client.on(EventName.openOrderEnd, () => {
      const entry = pending.get('openOrders');
      if (entry) {
        pending.delete('openOrders');
        const rows = [...openOrders.values()];
        logEvent('openOrders_callback', { count: rows.length });
        entry.resolve(rows);
      }
    });
    client.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice) => {
      const normalized = normalizeIbStatus(status, filled, remaining);
      const owned = findOwnedIntentForOrder({ orderId: Number(orderId) });
      const identity = lifecycleIdentity.mergeIdentity(owned, owned?.intent);
      orderStatuses.set(Number(orderId), {
        ...identity,
        orderId: Number(orderId),
        ibStatus: status,
        status: normalized,
        filled: Number(filled) || 0,
        remaining: Number(remaining) || 0,
        avgFillPrice: Number(avgFillPrice) || null,
        lastFillPrice: Number(lastFillPrice) || null,
        permId: permId ?? null,
        parentId: parentId ?? null,
        updatedAt: nowIso(),
      });
      if (TERMINAL_ORDER_STATUSES.has(normalized)) {
        openOrders.delete(Number(orderId));
      } else if (openOrders.has(Number(orderId))) {
        const row = openOrders.get(Number(orderId));
        openOrders.set(Number(orderId), { ...row, state: status, updatedAt: nowIso() });
      }
      if (normalized === 'filled') {
        handleFilledOrderStatus({ orderId: Number(orderId), avgFillPrice, lastFillPrice });
      }
      logEvent('order_status', { ...identity, orderId: Number(orderId), ibStatus: status, status: normalized, filled: Number(filled) || 0, remaining: Number(remaining) || 0 });
    });
    client.on(EventName.execDetails, (reqId, contract, execution) => {
      const owned = findOwnedIntentForOrder({
        orderId: execution?.orderId,
        orderRef: execution?.orderRef,
      });
      const identity = lifecycleIdentity.mergeIdentity(owned, owned?.intent);
      const row = {
        ...identity,
        execId: execution?.execId ?? null,
        orderId: execution?.orderId ?? null,
        permId: execution?.permId ?? null,
        accountMasked: maskAccount(execution?.acctNumber),
        conId: contract?.conId ?? null,
        localSymbol: contract?.localSymbol ?? null,
        side: execution?.side ?? null,
        shares: execution?.shares ?? null,
        price: execution?.price ?? null,
        orderRef: execution?.orderRef ?? null,
        time: execution?.time ?? null,
        receivedAt: nowIso(),
      };
      executions.push(row);
      if (executions.length > 200) executions.shift();
      persistExecutionDetails(contract, execution);
      logEvent('exec_details', { ...identity, execId: execution?.execId ?? null, orderId: execution?.orderId ?? null, price: execution?.price ?? null });
      const entry = pending.get(reqId);
      if (entry) entry.rows.push(executions[executions.length - 1]);
    });
    client.on(EventName.execDetailsEnd, (reqId) => {
      const entry = pending.get(reqId);
      if (entry) {
        pending.delete(reqId);
        logEvent('executions_callback', { reqId, count: entry.rows.length });
        entry.resolve(entry.rows);
      }
    });
    client.on(EventName.commissionReport, (report) => {
      const row = {
        execId: report?.execId ?? null,
        commission: report?.commission ?? null,
        currency: report?.currency ?? null,
        realizedPNL: (report?.realizedPNL != null && Math.abs(report.realizedPNL) < 1e300) ? report.realizedPNL : null,
        receivedAt: nowIso(),
      };
      commissions.push(row);
      if (commissions.length > 200) commissions.shift();
      const owned = findOwnedIntentForExecId(row.execId);
      if (owned?.idempotencyKey) {
        const isExit = String(owned.filledExecId || '') === String(row.execId || '');
        const isEntry = String(owned.entryExecId || '') === String(row.execId || '');
        const patch = isExit
          ? {
              filledCommission: numberOrNull(row.commission),
              filledCommissionCurrency: row.currency || null,
              filledRealizedPNL: numberOrNull(row.realizedPNL),
            }
          : isEntry
            ? {
                entryCommission: numberOrNull(row.commission),
                entryCommissionCurrency: row.currency || null,
              }
            : null;
        if (patch) intentService.updateStatus(owned.idempotencyKey, owned.status || 'submitted', patch);
      }
      logEvent('commission', { execId: report?.execId ?? null, commission: report?.commission ?? null });
    });
    client.on(EventName.position, (account, contract, pos, avgCost) => {
      const key = `${account}:${contract?.conId}`;
      positions.set(key, {
        accountMasked: maskAccount(account),
        accountClassification: adapterModule.classifyAccountId(account),
        conId: contract?.conId ?? null,
        localSymbol: contract?.localSymbol ?? null,
        secType: contract?.secType ?? null,
        symbol: contract?.symbol ?? null,
        position: Number(pos) || 0,
        avgCost: Number(avgCost) || null,
        updatedAt: nowIso(),
      });
    });
    client.on(EventName.positionEnd, () => {
      const entry = pending.get('positions');
      if (entry) {
        pending.delete('positions');
        try { client.cancelPositions(); } catch (_) { /* engångsläsning */ }
        const rows = [...positions.values()].filter((p) => p.position !== 0);
        logEvent('positions_callback', { count: rows.length });
        entry.resolve(rows);
      }
    });
	  }

  function buildAccountSummarySnapshot(rows = []) {
    const rawRows = Array.isArray(rows) ? rows : [];
    const accountIds = [...new Set(rawRows.map((row) => String(row.account || '').trim()).filter(Boolean))];
    const paperAccounts = accountIds.filter((id) => adapterModule.classifyAccountId(id) === 'paper');
    const selectedAccount = paperAccounts[0] || accountIds[0] || managedAccounts.find((id) => adapterModule.classifyAccountId(id) === 'paper') || null;
    const selectedRows = selectedAccount ? rawRows.filter((row) => String(row.account || '').trim() === selectedAccount) : rawRows;
    const values = {};
    let currency = null;
    let accountType = null;
    for (const row of selectedRows) {
      if (row.tag === 'AccountType') accountType = row.value;
      const num = Number(row.value);
      if (Number.isFinite(num)) values[row.tag] = num;
      if (row.currency && row.tag === 'NetLiquidation') currency = row.currency;
    }
    const classification = selectedAccount ? adapterModule.classifyAccountId(selectedAccount) : null;
    const ok = Boolean(selectedAccount && classification === 'paper' && selectedRows.length > 0);
    return {
      ok,
      status: ok ? 'ok' : 'blocked',
      blocker: ok ? null : 'paper_account_summary_not_ready',
      generatedAt: nowIso(),
      account: ok ? {
        accountIdMasked: maskAccount(selectedAccount),
        classification,
        accountType: accountType || null,
        currency: currency || 'USD',
        netLiquidation: values.NetLiquidation ?? null,
        totalCashValue: values.TotalCashValue ?? null,
        availableFunds: values.AvailableFunds ?? null,
        buyingPower: values.BuyingPower ?? null,
        realizedPnl: values.RealizedPnL ?? null,
        unrealizedPnl: values.UnrealizedPnL ?? null,
        maintMarginReq: values.MaintMarginReq ?? null,
        initMarginReq: values.InitMarginReq ?? null,
        cushion: values.Cushion ?? null,
      } : null,
      rows: rawRows.map((row) => ({
        accountMasked: maskAccount(row.account),
        tag: row.tag,
        value: row.value,
        currency: row.currency || null,
      })),
      visibleAccounts: accountIds.map(maskAccount),
      ...EXECUTION_SAFETY,
    };
  }

  async function refreshAccountSummary() {
    if (!connected || !ib) return { ok: false, blocker: 'execution_client_not_connected' };
    const reqId = nextReqId();
    return new Promise((resolve) => {
      const rows = [];
      let settled = false;
      const cleanup = () => {
        ib.off(EventName.accountSummary, onSummary);
        ib.off(EventName.accountSummaryEnd, onEnd);
        try { ib.cancelAccountSummary(reqId); } catch (_) { /* ignore */ }
      };
      const finish = (snapshot) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        accountSummarySnapshot = snapshot;
        logEvent('accountSummary_callback', {
          ok: snapshot?.ok === true,
          rowCount: Array.isArray(snapshot?.rows) ? snapshot.rows.length : 0,
          blocker: snapshot?.blocker || null,
        });
        resolve(snapshot);
      };
      const onSummary = (id, account, tag, value, currency) => {
        if (Number(id) !== reqId) return;
        rows.push({ account, tag, value, currency });
      };
      const onEnd = (id) => {
        if (Number(id) !== reqId) return;
        finish(buildAccountSummarySnapshot(rows));
      };
      const timer = setTimeout(() => {
        recordError(null, 'account_summary_timeout');
        logEvent('timeout', { operation: 'accountSummary', timeoutMs: config.requestTimeoutMs });
        finish({
          ok: false,
          status: 'timeout',
          blocker: 'account_summary_timeout',
          generatedAt: nowIso(),
          rows: rows.map((row) => ({ accountMasked: maskAccount(row.account), tag: row.tag, value: row.value, currency: row.currency || null })),
          ...EXECUTION_SAFETY,
        });
      }, config.requestTimeoutMs);
      ib.on(EventName.accountSummary, onSummary);
      ib.on(EventName.accountSummaryEnd, onEnd);
      try { ib.reqAccountSummary(reqId, 'All', ACCOUNT_SUMMARY_TAGS); } catch (err) {
        finish({ ok: false, status: 'error', blocker: err.message || 'account_summary_failed', generatedAt: nowIso(), rows: [], ...EXECUTION_SAFETY });
      }
    });
  }

  async function primeReadyState() {
    const accountSummary = await refreshAccountSummary();
    const positionsResult = await getPaperPositions();
    const executionsResult = await getPaperExecutions();
    const ready = accountSummary.ok === true
      && positionsResult.ok === true
      && executionsResult.ok === true
      && nextOrderId != null
      && managedAccounts.length > 0;
    if (ready) {
      lastReadyAt = nowIso();
      setConnectionState(CONNECTION_STATES.READY, 'nextValidId_managedAccounts_accountSummary_positions_executions_ready', {
        accountSummaryRows: accountSummary.rows?.length || 0,
        positionsRows: positionsResult.positions?.length || 0,
        executionsRows: executionsResult.executions?.length || 0,
      });
      logEvent('READY', {
        nextValidIdReady: nextOrderId != null,
        managedAccountsReady: managedAccounts.length > 0,
        accountSummaryReady: accountSummary.ok === true,
        positionsReady: positionsResult.ok === true,
        executionsReady: executionsResult.ok === true,
      });
      return { ok: true, accountSummary, positions: positionsResult.positions || [], executions: executionsResult.executions || [] };
    }
    setConnectionState(CONNECTION_STATES.DEGRADED, 'ready_sequence_incomplete', {
      accountSummaryOk: accountSummary.ok === true,
      positionsOk: positionsResult.ok === true,
      executionsOk: executionsResult.ok === true,
      nextValidIdReady: nextOrderId != null,
      managedAccountsReady: managedAccounts.length > 0,
    });
    return {
      ok: false,
      error: accountSummary.blocker || positionsResult.blocker || positionsResult.error || executionsResult.blocker || executionsResult.error || 'ready_sequence_incomplete',
      accountSummary,
      positions: positionsResult.positions || [],
      executions: executionsResult.executions || [],
    };
  }

	  async function connectPaperExecutionClient(options = {}) {
	    logEvent('startExecutionClient', { reason: options.reason || 'connect_requested', clientId: config.clientId });
	    const flags = flagsProvider();
	    if (!flags.executionEnabled) {
      setConnectionState(CONNECTION_STATES.DISCONNECTED, 'ibkr_paper_execution_disabled');
	      return { ok: false, error: 'ibkr_paper_execution_disabled' };
	    }
    if (connectionState === CONNECTION_STATES.READY && connected && nextOrderId != null) {
      return { ok: true, alreadyConnected: true, state: connectionState, nextValidIdReady: true };
    }
    if (connectPromise) return connectPromise;
	    connecting = true;
    setConnectionState(
      options.reason === 'reconnect' ? CONNECTION_STATES.RECONNECTING : CONNECTION_STATES.CONNECTING,
      options.reason || 'connect_requested',
    );
    if (options.reason === 'reconnect') reconnectCount += 1;
    startHeartbeat();
    clearReconnectTimer();
	    if (!ib) {
	      logEvent('new IBApi client', { host: config.host, port: config.port, clientId: config.clientId });
	      ib = ibFactory(config);
	      attachHandlers(ib);
	    } else if (options.reason !== 'reconnect') {
	      reconnectCount += 1;
	    }
	    connectPromise = new Promise((resolve) => {
      const client = ib;
      let nextValidIdReady = nextOrderId != null;
      let managedAccountsReady = managedAccounts.length > 0;
      const cleanup = () => {
        client.off(EventName.nextValidId, onNextValidId);
        client.off(EventName.managedAccounts, onManagedAccounts);
        client.off(EventName.error, onConnectError);
      };
      const finish = async (baseResult) => {
        clearTimeout(timer);
        cleanup();
        connecting = false;
        if (baseResult.ok !== true) {
          connectPromise = null;
          try { client.disconnect(); } catch (_) { /* ignore */ }
          if (ib === client) ib = null;
          setConnectionState(CONNECTION_STATES.FAILED, baseResult.error || 'connect_failed');
          if (permanentRuntime) scheduleReconnect(baseResult.error || 'connect_failed');
          resolve(baseResult);
          return;
        }
        connected = true;
        connectedAt = connectedAt || nowIso();
        lastConnected = nowIso();
        const readyResult = await primeReadyState();
        connectPromise = null;
        resolve({
          ok: readyResult.ok === true,
          nextValidIdReady: nextOrderId != null,
          managedAccountsReady: managedAccounts.length > 0,
          state: connectionState,
          ready: readyResult.ok === true,
          error: readyResult.ok === true ? null : readyResult.error,
        });
      };
      const maybeFinish = () => {
        if (nextValidIdReady && managedAccountsReady) {
          finish({ ok: true });
        }
      };
      const onNextValidId = (orderId) => {
        nextOrderId = Number(orderId);
        lastNextValidId = nextOrderId;
        nextValidIdReady = nextOrderId != null;
        maybeFinish();
      };
      const onManagedAccounts = (accounts) => {
        managedAccounts = String(accounts || '').split(',').map((s) => s.trim()).filter(Boolean);
        managedAccountsReady = managedAccounts.length > 0;
        maybeFinish();
      };
      const onConnectError = (err, code) => {
        const message = err instanceof Error ? err.message : String(err || `IB error ${code || 'unknown'}`);
        recordError(Number(code) || null, message);
      };
	      const timer = setTimeout(() => {
	        recordError(null, `execution_connect_timeout_after_${config.connectTimeoutMs}ms`);
	        logEvent('timeout', { operation: 'connect', timeoutMs: config.connectTimeoutMs, clientId: config.clientId });
	        finish({ ok: false, error: 'connect_timeout' });
	      }, config.connectTimeoutMs);
      client.on(EventName.nextValidId, onNextValidId);
      client.on(EventName.managedAccounts, onManagedAccounts);
      client.on(EventName.error, onConnectError);
	      try {
	        logEvent('connect(host,4002,956)', { host: config.host, port: config.port, clientId: config.clientId });
	        client.connect(config.clientId);
	      } catch (err) {
	        recordError(null, err.message);
	        logEvent('exception', { operation: 'connect', message: err.message || String(err) });
	        finish({ ok: false, error: err.message });
	      }
	    });
    return connectPromise;
	  }

  async function startPermanentRuntime() {
    permanentRuntime = true;
    runtimeStartedAt = runtimeStartedAt || nowIso();
    startHeartbeat();
    return connectPaperExecutionClient({ reason: 'runtime_start' });
  }

	  function disconnect() {
    logEvent('disconnect', { reason: 'manual_disconnect', clientId: config.clientId });
    permanentRuntime = false;
    clearReconnectTimer();
    stopHeartbeat();
    if (ib) { try { ib.disconnect(); } catch (_) { /* ok */ } }
    connected = false;
    connecting = false;
    nextOrderId = null;
    connectedAt = null;
    ib = null;
    connectPromise = null;
    setConnectionState(CONNECTION_STATES.DISCONNECTED, 'manual_disconnect');
	  }

	  // Verifiera paper-konto via DENNA klients account discovery (§7-bevis 1).
	  function verifyPaperAccount(expectedMaskedAccount = null) {
    const paperAccounts = managedAccounts.filter((id) => adapterModule.classifyAccountId(id) === 'paper');
    const liveAccounts = managedAccounts.filter((id) => adapterModule.classifyAccountId(id) !== 'paper');
    if (liveAccounts.length > 0) {
      return {
        ok: false,
        blocker: 'live_account_detected',
        live_account_detected: true,
        liveAccountsMasked: liveAccounts.map(maskAccount),
      };
    }
    if (paperAccounts.length !== 1) {
      return { ok: false, blocker: paperAccounts.length === 0 ? 'paper_account_not_verified' : 'multiple_paper_accounts', live_account_detected: false };
    }
    const masked = maskAccount(paperAccounts[0]);
    if (expectedMaskedAccount && masked !== expectedMaskedAccount) {
      return { ok: false, blocker: 'account_mismatch_with_expected', live_account_detected: false };
    }
	    return { ok: true, accountIdMasked: masked, accountIdRawForSubmit: paperAccounts[0], classification: 'paper', live_account_detected: false };
	  }

		  function createExecutionEvidence({
			    guardDecision,
			    intentRecord,
			    orderPlan,
			    brokerRisk,
		    executionAllowlist,
			    entryContract,
		    reconciliation,
		    verifiedAccount,
	    now = new Date(),
	    maxAgeMs = configService.getPilotLimits().maxIntentAgeMs,
	  } = {}) {
	    const generatedAt = nowIso(now);
	    const expiresAt = nowIso(new Date(new Date(now).getTime() + maxAgeMs));
	    const payload = buildEvidencePayload({
	      guardDecision,
				      intentRecord,
				      orderPlan,
				      brokerRisk,
				      executionAllowlist,
				      entryContract,
		      reconciliation,
		      verifiedAccount,
	    });
	    const fingerprint = sha256(payload);
	    return {
	      source: 'ib_paper_execution_orchestrator',
	      evidenceVersion: EVIDENCE_VERSION,
	      generatedAt,
	      expiresAt,
	      fingerprint,
	      signature: hmac({ fingerprint, generatedAt, expiresAt, evidenceVersion: EVIDENCE_VERSION }),
	    };
	  }

	  function verifyExecutionEvidence({
	    executionEvidence,
		    guardDecision,
			    intentRecord,
				    orderPlan,
				    brokerRisk,
		    executionAllowlist,
				    entryContract,
		    reconciliation,
	    verifiedAccount,
	    now = new Date(),
	  } = {}) {
	    if (!executionEvidence || typeof executionEvidence !== 'object') return { ok: false, blocker: 'execution_evidence_missing' };
	    if (executionEvidence.source !== 'ib_paper_execution_orchestrator') return { ok: false, blocker: 'execution_evidence_source_invalid' };
	    if (Number(executionEvidence.evidenceVersion) !== EVIDENCE_VERSION) return { ok: false, blocker: 'execution_evidence_version_invalid' };
	    const expiresMs = Date.parse(executionEvidence.expiresAt || '');
	    if (!Number.isFinite(expiresMs) || expiresMs < new Date(now).getTime()) return { ok: false, blocker: 'execution_evidence_expired' };
	    const payload = buildEvidencePayload({
	      guardDecision,
				      intentRecord,
				      orderPlan,
				      brokerRisk,
		      executionAllowlist,
				      entryContract,
		      reconciliation,
		      verifiedAccount,
	    });
	    const fingerprint = sha256(payload);
	    if (fingerprint !== executionEvidence.fingerprint) return { ok: false, blocker: 'execution_evidence_fingerprint_mismatch', expectedFingerprint: fingerprint };
	    const expectedSignature = hmac({
	      fingerprint,
	      generatedAt: executionEvidence.generatedAt,
	      expiresAt: executionEvidence.expiresAt,
	      evidenceVersion: EVIDENCE_VERSION,
	    });
	    if (expectedSignature !== executionEvidence.signature) return { ok: false, blocker: 'execution_evidence_signature_invalid' };
	    return { ok: true, fingerprint, payload };
	  }

  // Bygg exakt IB-orderpayload (§11) — ren funktion, skickar inget.
  // ENDA källan för IB-kontraktet i utgående ordrar. Både buildOrderPlan och
  // flattenOwnedPosition går genom den — en handbyggd variant i flatten skickade
  // tidigare tomma symbol- och expiry-fält, och IB agerade då inte på ordern
  // (varken fill, orderStatus eller felkod). Rör inte fälten var för sig här.
  function buildIbContract(contract = {}) {
    const root = String(contract.root || contract.symbol || '').toUpperCase();
    const expiry = contract.expiry || contract.lastTradeDateOrContractMonth || undefined;
    return {
      conId: contract.conId,
      exchange: contract.exchange || 'CME',
      secType: SecType.FUT,
      symbol: root || contract.root,
      currency: contract.currency || 'USD',
      localSymbol: contract.localSymbol || undefined,
      expiry,
      lastTradeDateOrContractMonth: expiry,
    };
  }

  function buildOrderPlan({
    executionId,
    contract, // {conId, localSymbol, expiry, exchange, currency, root}
    side, // 'long' | 'short'
    quantity,
    entryType = 'MKT',
    limitPrice = null,
    stopLossPrice,
    takeProfitPrice = null,
    tif = 'GTC',
    outsideRth = true, // Globex-instrument handlas utanför RTH per sessionsregel
  }) {
    const action = String(side).toLowerCase() === 'short' ? OrderAction.SELL : OrderAction.BUY;
    const exitAction = action === OrderAction.BUY ? OrderAction.SELL : OrderAction.BUY;
    const root = String(contract.root || contract.symbol || '').toUpperCase();
    const tickSize = priceTickSizeForRoot(root);
    const normalizedLimitPrice = limitPrice != null ? roundPriceToTick(limitPrice, tickSize) : null;
    const normalizedStopLossPrice = roundPriceToTick(stopLossPrice, tickSize);
    const normalizedTakeProfitPrice = takeProfitPrice != null ? roundPriceToTick(takeProfitPrice, tickSize) : null;
	    const ibContract = buildIbContract(contract);
    const ocaGroup = `TOSP-${String(executionId).slice(-16)}`;
    const entry = {
      action,
      totalQuantity: quantity,
      orderType: entryType === 'LMT' ? OrderType.LMT : OrderType.MKT,
      ...(entryType === 'LMT' && normalizedLimitPrice != null ? { lmtPrice: normalizedLimitPrice } : {}),
      tif: TimeInForce[tif] || TimeInForce.GTC,
      outsideRth,
      transmit: false, // barnorder skickas före aktivering — sista i kedjan transmittar
      orderRef: buildOrderRef(executionId, 'entry'),
    };
    const stopLoss = {
      action: exitAction,
      totalQuantity: quantity,
	      orderType: OrderType.STP,
	      auxPrice: normalizedStopLossPrice,
	      tif: TimeInForce.GTC,
	      outsideRth,
	      transmit: true, // sista ordern i kedjan transmittar allt
	      ocaGroup,
	      ocaType: 1,
	      orderRef: buildOrderRef(executionId, 'stopLoss'),
	    };
    const takeProfit = takeProfitPrice != null ? {
      action: exitAction,
      totalQuantity: quantity,
	      orderType: OrderType.LMT,
	      lmtPrice: normalizedTakeProfitPrice,
	      tif: TimeInForce.GTC,
	      outsideRth,
	      transmit: false,
	      ocaGroup,
	      ocaType: 1,
	      orderRef: buildOrderRef(executionId, 'takeProfit'),
    } : null;
    return {
      environment: ENVIRONMENT,
      contract: ibContract,
      entry,
      stopLoss,
      takeProfit,
      ocaGroup,
	      transmitSequence: takeProfit
	        ? ['entry:false', 'takeProfit:false', 'stopLoss:true']
	        : ['entry:false', 'stopLoss:true'],
      protectiveModel: 'exakt en primär stop per position; TP/SL i samma OCA-grupp (ocaType 1) så att fill på den ena avbryter den andra',
    };
  }

  // FAKTISK SUBMIT — enda placeOrder-vägen. Vägrar hårt utan fullständiga bevis.
	  async function submitPaperOrder({
	    guardDecision,
	    intentRecord,
	    orderPlan,
			    verifiedAccount,
			    executionEvidence,
			    brokerRisk,
			    executionAllowlist,
			    entryContract,
		    reconciliation,
	    now = new Date(),
	  }) {
	    const flags = flagsProvider();
	    const refusal = (blocker) => ({ ok: false, submitted: false, blocker, ...EXECUTION_SAFETY });
	    if (!flags.executionEnabled) return refusal('ibkr_paper_execution_disabled');
	    if (flags.shadowMode) return refusal('shadow_mode_active_no_submit');
	    if (!flags.submissionEnabled) return refusal('paper_order_submission_disabled');
	    if (flags.live_trading_enabled !== false || flags.live_broker_enabled !== false || flags.live_order_submission_enabled !== false || flags.live_account_orders_allowed !== false) return refusal('live_feature_flag_enabled');
	    if (!isGuardVerifiedPaper(guardDecision)) return refusal('guard_not_passed');
	    if (!intentRecord || !intentRecord.idempotencyKey) return refusal('intent_record_missing');
		    if (!verifiedAccount || verifiedAccount.ok !== true || verifiedAccount.classification !== 'paper') {
		      return refusal('paper_account_not_verified');
		    }
			    if (intentRecord.executionTarget !== 'ibkr_paper') return refusal('execution_target_not_ibkr_paper');
				    if (executionAllowlistAllowed(executionAllowlist) !== true) return refusal('strategy_not_in_execution_allowlist');
			    if (entryContractAllowed(entryContract) !== true) return refusal('entry_contract_not_approved');
	    if (brokerRisk?.allowed !== true) return refusal('broker_risk_blocked');
	    if (reconciliation?.degraded === true || reconciliation?.status !== 'ok') return refusal(reconciliation?.blockedReason || 'reconciliation_degraded');
	    const evidenceCheck = verifyExecutionEvidence({
	      executionEvidence,
	      guardDecision,
			      intentRecord,
			      orderPlan,
			      brokerRisk,
			      executionAllowlist,
			      entryContract,
	      reconciliation,
	      verifiedAccount,
	      now,
	    });
	    if (!evidenceCheck.ok) return refusal(evidenceCheck.blocker);
	    const planValidation = validateOrderPlanForSubmit(orderPlan, { intentRecord, verifiedAccount, now });
	    if (!planValidation.ok) return refusal(planValidation.blockedReason || 'order_plan_invalid');
	    // Dubbelkolla mot DENNA klients discovery — kontot måste synas här också.
	    const discovery = verifyPaperAccount(verifiedAccount.accountIdMasked);
	    if (!discovery.ok) return refusal(discovery.blocker);
	    if (!connected || nextOrderId == null) return refusal('execution_client_not_ready');
	    if (!orderPlan || orderPlan.environment !== ENVIRONMENT) return refusal('environment_not_paper');
	    if (orderPlan.contract?.secType !== SecType.FUT) return refusal('contract_not_fut');
	    if (submitInProgress) return refusal('submit_in_progress');

	    const account = discovery.accountIdRawForSubmit;
    const submitIdentity = lifecycleIdentity.mergeIdentity(intentRecord, intentRecord?.intent);
	    const parentId = nextOrderId;
	    let idCursor = nextOrderId;
	    const legs = [
	      { name: 'entry', order: { ...orderPlan.entry, account } },
	      ...(orderPlan.takeProfit ? [{ name: 'takeProfit', order: { ...orderPlan.takeProfit, account, parentId } }] : []),
	      { name: 'stopLoss', order: { ...orderPlan.stopLoss, account, parentId } },
	    ];
	    const expectedOrderIds = legs.map((_, index) => parentId + index);
	    const expectedBracketLegs = legs.map((leg, index) => ({
	      leg: leg.name,
	      orderId: expectedOrderIds[index],
	      orderRef: leg.order.orderRef,
	      transmit: leg.order.transmit === true,
	    }));
	    const submitStarted = intentService.updateStatus(intentRecord.idempotencyKey, 'submit_started', {
	      submitStartedAt: nowIso(now),
	      orderRef: orderPlan.entry.orderRef,
	      orderRefs: legs.map((leg) => leg.order.orderRef),
	      expectedAccountMasked: maskAccount(account),
	      expectedOrderIds,
	      expectedBracketLegs,
	      parentOrderId: parentId,
	      contractFingerprint: planValidation.contractFingerprint,
	      evidenceFingerprint: executionEvidence.fingerprint,
	      side: orderPlan.entry.action,
	      quantity: 1,
	    });
	    if (!submitStarted.ok) return refusal('submit_started_persist_failed');
	    const placed = [];
	    try {
	      submitInProgress = true;
	      for (const leg of legs) {
	        const orderId = idCursor;
	        idCursor += 1;
	        ib.placeOrder(orderId, orderPlan.contract, leg.order);
        placed.push({ leg: leg.name, orderId, orderRef: leg.order.orderRef, transmit: leg.order.transmit });
        logEvent('order_placed', { ...submitIdentity, leg: leg.name, orderId, orderRef: leg.order.orderRef, transmit: leg.order.transmit, accountMasked: maskAccount(account) });
      }
	      nextOrderId = idCursor;
	      return { ok: true, submitted: true, ...submitIdentity, parentOrderId: parentId, legs: placed, accountMasked: maskAccount(account), ...EXECUTION_SAFETY };
	    } catch (err) {
	      recordError(null, `submit_failed: ${err.message}`);
	      intentService.updateStatus(intentRecord.idempotencyKey, 'reconciliation_required', {
	        blocker: 'submit_exception',
	        reconciliationRequired: true,
	        expectedOrderIds,
	        expectedBracketLegs,
	      });
	      return { ok: false, submitted: placed.length > 0, blocker: 'submit_exception', error: err.message, legs: placed, reconciliationRequired: true, ...EXECUTION_SAFETY };
	    } finally {
	      submitInProgress = false;
	    }
	  }

	  function findOwnedIntentForOrder({ orderId, idempotencyKey = null, orderRef = null } = {}) {
	    const wantedId = Number(orderId);
	    const intents = idempotencyKey ? [intentService.getIntent(idempotencyKey)].filter(Boolean) : intentService.listIntents({ limit: 500 });
	    // orderRef bär executionId och är unik per intent. orderId är det INTE: IBKR
	    // nollställer nextValidId vid gateway-omstart, så samma id ligger på flera
	    // historiska intents. Matchas ref och id i samma villkor vinner den intent som
	    // råkar sorteras först — t.ex. en gammal intent som just rörts av självläkningen
	    // — och fillen skrivs på fel trade. Ref är därför bevis, id bara fallback.
	    const orderRefText = orderRef == null ? null : String(orderRef);
	    const matchesOrderRef = (intent) => {
	      if (!orderRefText) return false;
	      const refs = Array.isArray(intent.orderRefs) ? intent.orderRefs.map(String) : [intent.orderRef].filter(Boolean).map(String);
	      return refs.includes(orderRefText);
	    };
	    const matchesOrderId = (intent) => {
	      if (!Number.isFinite(wantedId)) return false;
	      const ids = Array.isArray(intent.expectedOrderIds) ? intent.expectedOrderIds.map(Number) : [];
	      return ids.includes(wantedId);
	    };
	    return intents.find(matchesOrderRef) || intents.find(matchesOrderId) || null;
	  }

		  async function cancelPaperOrder({ orderId, idempotencyKey = null, orderRef = null, verifiedAccount = null, reason = null, audit = {} } = {}) {
	    const flags = flagsProvider();
	    if (!flags.executionEnabled) return { ok: false, blocker: 'ibkr_paper_execution_disabled' };
	    if (flags.shadowMode) return { ok: false, blocker: 'shadow_mode_active_no_cancel' };
	    if (!flags.submissionEnabled) return { ok: false, blocker: 'paper_order_submission_disabled' };
	    if (flags.live_trading_enabled !== false || flags.live_broker_enabled !== false || flags.live_order_submission_enabled !== false || flags.live_account_orders_allowed !== false) return { ok: false, blocker: 'live_feature_flag_enabled' };
	    if (!reason) return { ok: false, blocker: 'cancellation_reason_required' };
	    if (!verifiedAccount || verifiedAccount.ok !== true || verifiedAccount.classification !== 'paper') return { ok: false, blocker: 'paper_account_not_verified' };
	    const discovery = verifyPaperAccount(verifiedAccount.accountIdMasked);
	    if (!discovery.ok) return { ok: false, blocker: discovery.blocker };
	    if (!connected) return { ok: false, blocker: 'execution_client_not_ready' };
		    const owned = findOwnedIntentForOrder({ orderId, idempotencyKey, orderRef });
		    if (!owned) return { ok: false, blocker: 'order_not_owned_by_ibkr_paper_execution' };
		    if (owned.expectedAccountMasked && owned.expectedAccountMasked !== maskAccount(discovery.accountIdRawForSubmit)) return { ok: false, blocker: 'order_account_mismatch' };
		    const open = openOrders.get(Number(orderId));
		    if (!open) return { ok: false, blocker: 'order_not_open_at_adapter' };
		    if (owned.contractFingerprint && contractFingerprint(open.contract || {}) !== owned.contractFingerprint) return { ok: false, blocker: 'order_contract_mismatch' };
		    const effectiveRef = orderRef || open?.order?.orderRef || owned.orderRef || null;
		    if (!String(effectiveRef || '').startsWith(ORDER_REF_PREFIX)) return { ok: false, blocker: 'order_ref_not_owned' };
	    try {
	      ib.cancelOrder(Number(orderId));
	      logEvent('cancel_requested', { orderId: Number(orderId), orderRef: effectiveRef, reason: String(reason), audit });
	      intentService.updateStatus(owned.idempotencyKey, 'reconciliation_required', {
	        blocker: 'cancel_requested',
	        cancelReason: String(reason),
	        cancelOrderId: Number(orderId),
	      });
	      return { ok: true, orderId: Number(orderId), orderRef: effectiveRef, accountMasked: maskAccount(discovery.accountIdRawForSubmit) };
	    } catch (err) {
	      return { ok: false, error: err.message };
	    }
	  }

	  // EMERGENCY FLATTEN — R2. Stänger en ÖPPEN, ägd paper-position på ett
	  // allowlist:at root (MNQ/MES) med EN stängande MKT-order via samma enda
	  // placeOrder-väg. Avbryter först ägda skyddsben (OCA) så closen inte
	  // slåss mot bracketen. Gate:ad EXAKT som submit/cancel (inert tills armad,
	  // owned-only, paper-verifierad). Skapar INGEN entry, rör ej candidate/pipeline.
	  async function flattenOwnedPosition({ root = null, reason = null, verifiedAccount = null, audit = {}, contract: resolvedContract = null } = {}) {
	    const flags = flagsProvider();
	    if (!flags.executionEnabled) return { ok: false, flattened: false, blocker: 'ibkr_paper_execution_disabled', ...EXECUTION_SAFETY };
	    if (flags.shadowMode) return { ok: false, flattened: false, blocker: 'shadow_mode_active_no_flatten', ...EXECUTION_SAFETY };
	    if (!flags.submissionEnabled) return { ok: false, flattened: false, blocker: 'paper_order_submission_disabled', ...EXECUTION_SAFETY };
	    if (flags.live_trading_enabled !== false || flags.live_broker_enabled !== false || flags.live_order_submission_enabled !== false || flags.live_account_orders_allowed !== false) return { ok: false, flattened: false, blocker: 'live_feature_flag_enabled', ...EXECUTION_SAFETY };
	    if (!reason) return { ok: false, flattened: false, blocker: 'flatten_reason_required', ...EXECUTION_SAFETY };
	    if (!verifiedAccount || verifiedAccount.ok !== true || verifiedAccount.classification !== 'paper') return { ok: false, flattened: false, blocker: 'paper_account_not_verified', ...EXECUTION_SAFETY };
	    const discovery = verifyPaperAccount(verifiedAccount.accountIdMasked);
	    if (!discovery.ok) return { ok: false, flattened: false, blocker: discovery.blocker, ...EXECUTION_SAFETY };
	    if (!connected || nextOrderId == null) return { ok: false, flattened: false, blocker: 'execution_client_not_ready', ...EXECUTION_SAFETY };
	    if (submitInProgress) return { ok: false, flattened: false, blocker: 'submit_in_progress', ...EXECUTION_SAFETY };
	    const allowlist = configService.getPilotLimits().symbolAllowlist;
	    const normRoot = String(root || '').trim().toUpperCase();
	    if (!allowlist.includes(normRoot)) return { ok: false, flattened: false, blocker: 'symbol_not_allowlisted', root: normRoot, allowlist, ...EXECUTION_SAFETY };

	    const posResult = await getPaperPositions();
	    if (posResult.ok !== true) return { ok: false, flattened: false, blocker: posResult.blocker || 'positions_unavailable', ...EXECUTION_SAFETY };
	    const acctMasked = maskAccount(discovery.accountIdRawForSubmit);
	    const pos = (posResult.positions || []).find((p) => p.accountMasked === acctMasked
	      && Number(p.position) !== 0
	      && String(p.symbol || '').toUpperCase() === normRoot);
	    if (!pos) return { ok: true, flattened: false, alreadyFlat: true, root: normRoot, accountMasked: acctMasked, ...EXECUTION_SAFETY };
	    const signed = Number(pos.position);
	    const qty = Math.abs(signed);
	    // Hård säkerhetsgräns: en emergency-flatten lägger aldrig en storleks-order
	    // utanför pilotens rimliga intervall (skydd mot felläst position → jätte-order).
	    const maxFlattenQty = Math.max(1, Number(configService.getPilotLimits().maxOpenPositions) || 1) + 3;
	    if (!Number.isInteger(qty) || qty < 1 || qty > maxFlattenQty) {
	      return { ok: false, flattened: false, blocker: 'flatten_quantity_out_of_range', position: signed, maxFlattenQty, note: 'manual_flatten_required', ...EXECUTION_SAFETY };
	    }
	    const closeSide = signed > 0 ? OrderAction.SELL : OrderAction.BUY;
	    if (!pos.conId || !pos.localSymbol) return { ok: false, flattened: false, blocker: 'position_contract_incomplete', ...EXECUTION_SAFETY };

	    // 1) Avbryt ägda skyddsben (OCA) för DENNA position så closen inte slåss mot bracketen.
	    const cancelledLegs = [];
	    for (const [oid, o] of openOrders) {
	      const ref = String(o?.order?.orderRef || '');
	      if (ref.startsWith(ORDER_REF_PREFIX) && Number(o?.contract?.conId) === Number(pos.conId)) {
	        try { ib.cancelOrder(Number(oid)); cancelledLegs.push(Number(oid)); logEvent('flatten_cancel_leg', { orderId: Number(oid), orderRef: ref }); } catch (err) { recordError(Number(oid), `flatten_cancel_leg_failed: ${err.message}`); }
	      }
	    }

	    // 2) Lägg EN stängande MKT-order via samma enda placeOrder-väg. Owned orderRef + registrerad intent → reconciliation-ren.
	    const execId = `emergency_flatten_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
	    const orderRef = `${ORDER_REF_PREFIX}${execId}-flatten`;
	    const idempotencyKey = `flatten:${pos.conId}:${execId}`;
	    // Positionsraden är sanningen om VAD vi äger (conId/localSymbol/symbol).
	    // Expiry finns bara i det upplösta kontraktet, och får bara lånas därifrån
	    // när det beskriver samma kontrakt — annars vore det en annan kontraktsmånad.
	    const sameContract = resolvedContract && Number(resolvedContract.conId) === Number(pos.conId);
	    const contract = buildIbContract({
	      conId: Number(pos.conId),
	      localSymbol: pos.localSymbol,
	      symbol: pos.symbol || normRoot,
	      root: normRoot,
	      exchange: sameContract ? resolvedContract.exchange : undefined,
	      currency: sameContract ? resolvedContract.currency : undefined,
	      expiry: sameContract
	        ? (resolvedContract.expiry || resolvedContract.lastTradeDateOrContractMonth)
	        : undefined,
	    });
	    const account = discovery.accountIdRawForSubmit;
	    const closingOrder = { action: closeSide, orderType: OrderType.MKT, totalQuantity: qty, account, orderRef, tif: TimeInForce.DAY, transmit: true, outsideRth: true };
	    const orderId = nextOrderId;
	    try {
	      intentService.createIntent({ idempotencyKey, executionId: execId, intent: { executionId: execId, idempotencyKey, orderRef, root: normRoot, direction: closeSide === 'SELL' ? 'long' : 'short', executionTarget: 'ibkr_paper', kind: 'emergency_flatten', status: 'submit_started', paperAccountIdMasked: acctMasked, expectedOrderIds: [orderId], orderRefs: [orderRef] } });
	    } catch (_) { /* intent-registrering får aldrig blockera en nödstängning */ }
	    try {
	      ib.placeOrder(orderId, contract, closingOrder);
	      nextOrderId = orderId + 1;
	      try { intentService.updateStatus(idempotencyKey, 'submitted', { submittedAt: nowIso(), expectedOrderIds: [orderId], orderRefs: [orderRef], side: closeSide, quantity: qty }); } catch (_) { /* noop */ }
	      logEvent('emergency_flatten_placed', { orderId, orderRef, root: normRoot, side: closeSide, quantity: qty, cancelledLegs, reason: String(reason), audit });
	      return { ok: true, flattened: true, root: normRoot, side: closeSide, quantity: qty, orderId, orderRef, cancelledLegs, accountMasked: acctMasked, ...EXECUTION_SAFETY };
	    } catch (err) {
	      recordError(null, `emergency_flatten_failed: ${err.message}`);
	      try { intentService.updateStatus(idempotencyKey, 'reconciliation_required', { blocker: 'flatten_place_exception' }); } catch (_) { /* noop */ }
	      return { ok: false, flattened: false, blocker: 'flatten_place_exception', error: err.message, cancelledLegs, ...EXECUTION_SAFETY };
	    }
	  }

	  async function modifyPaperOrder({ orderId, orderPatch, contract, guardDecision, verifiedAccount, idempotencyKey = null, orderRef = null, reason = null } = {}) {
	    const flags = flagsProvider();
	    const refusal = (blocker) => ({ ok: false, modified: false, blocker, ...EXECUTION_SAFETY });
		    if (!flags.executionEnabled) return refusal('ibkr_paper_execution_disabled');
		    if (flags.shadowMode) return refusal('shadow_mode_active_no_modify');
		    if (!flags.submissionEnabled) return refusal('paper_order_submission_disabled');
		    if (flags.live_trading_enabled !== false || flags.live_broker_enabled !== false || flags.live_order_submission_enabled !== false || flags.live_account_orders_allowed !== false) return refusal('live_feature_flag_enabled');
	    if (!isGuardVerifiedPaper(guardDecision)) return refusal('guard_not_passed');
    if (!verifiedAccount || verifiedAccount.ok !== true || verifiedAccount.classification !== 'paper') return refusal('paper_account_not_verified');
    const discovery = verifyPaperAccount(verifiedAccount.accountIdMasked);
    if (!discovery.ok) return refusal(discovery.blocker);
	    if (!connected || nextOrderId == null) return refusal('execution_client_not_ready');
	    const existing = openOrders.get(Number(orderId));
	    if (!existing) return refusal('order_not_open_at_adapter');
	    if (!contract || contract.secType !== SecType.FUT) return refusal('contract_not_fut');
	    if (!reason) return refusal('modify_reason_required');
		    const owned = findOwnedIntentForOrder({ orderId, idempotencyKey, orderRef: orderRef || existing.order?.orderRef });
		    if (!owned) return refusal('order_not_owned_by_ibkr_paper_execution');
		    if (owned.expectedAccountMasked && owned.expectedAccountMasked !== maskAccount(discovery.accountIdRawForSubmit)) return refusal('order_account_mismatch');
		    if (owned.contractFingerprint && contractFingerprint(contract || {}) !== owned.contractFingerprint) return refusal('order_contract_mismatch');
		    if (existing.contract && contractFingerprint(existing.contract) !== contractFingerprint(contract || {})) return refusal('order_contract_mismatch');
		    if (!String(existing.order?.orderRef || orderRef || '').startsWith(ORDER_REF_PREFIX)) return refusal('order_ref_not_owned');
	    const patch = orderPatch && typeof orderPatch === 'object' ? orderPatch : {};
	    const keys = Object.keys(patch);
	    const orderType = String(existing.order?.orderType || '').toUpperCase();
	    const allowedKeys = orderType === OrderType.STP ? ['auxPrice'] : (orderType === OrderType.LMT ? ['lmtPrice'] : []);
	    if (!keys.length || keys.some((key) => !allowedKeys.includes(key))) return refusal('modify_patch_field_not_allowed');
	    const nextOrder = {
	      orderId: Number(orderId),
	      action: existing.order?.action,
	      totalQuantity: existing.order?.totalQuantity,
	      orderType,
	      ...(orderType === OrderType.LMT ? { lmtPrice: patch.lmtPrice } : {}),
	      ...(orderType === OrderType.STP ? { auxPrice: patch.auxPrice } : {}),
	      ...(existing.order?.tif ? { tif: existing.order.tif } : {}),
	      outsideRth: existing.order?.outsideRth === true,
	      ...(existing.order?.parentId != null ? { parentId: existing.order.parentId } : {}),
	      ...(existing.order?.ocaGroup ? { ocaGroup: existing.order.ocaGroup, ocaType: existing.order?.ocaType || 1 } : {}),
	      ...(existing.order?.orderRef ? { orderRef: existing.order.orderRef } : {}),
	      account: discovery.accountIdRawForSubmit,
	      transmit: true,
	    };
    try {
      ib.placeOrder(Number(orderId), contract, nextOrder);
      logEvent('modify_requested', { orderId: Number(orderId), orderRef: nextOrder.orderRef || null });
      return { ok: true, modified: true, orderId: Number(orderId), accountMasked: maskAccount(discovery.accountIdRawForSubmit), ...EXECUTION_SAFETY };
    } catch (err) {
      recordError(null, `modify_failed: ${err.message}`);
      return { ok: false, modified: false, blocker: 'modify_exception', error: err.message, reconciliationRequired: true, ...EXECUTION_SAFETY };
    }
  }

	  async function getOpenPaperOrders() {
	    if (!connected) return { ok: false, error: 'not_connected', orders: [] };
	    return new Promise((resolve) => {
	      const timer = setTimeout(() => {
	        pending.delete('openOrders');
	        recordError(null, 'reconciliation_open_orders_timeout');
	        logEvent('timeout', { operation: 'openOrders', timeoutMs: config.requestTimeoutMs });
	        resolve({ ok: false, timedOut: true, blocker: 'reconciliation_open_orders_timeout', orders: [...openOrders.values()] });
	      }, config.requestTimeoutMs);
      pending.set('openOrders', {
        resolve: (rows) => { clearTimeout(timer); resolve({ ok: true, orders: rows }); },
      });
      try { ib.reqAllOpenOrders(); } catch (err) {
        clearTimeout(timer);
        pending.delete('openOrders');
        resolve({ ok: false, error: err.message, orders: [] });
      }
    });
  }

	  async function getPaperExecutions() {
	    if (!connected) return { ok: false, error: 'not_connected', executions: [] };
	    const reqId = Math.floor(Date.now() / 1000) % 100000;
	    return new Promise((resolve) => {
	      const timer = setTimeout(() => {
	        pending.delete(reqId);
	        recordError(null, 'reconciliation_executions_timeout');
	        logEvent('timeout', { operation: 'executions', timeoutMs: config.requestTimeoutMs, reqId });
	        resolve({ ok: false, timedOut: true, blocker: 'reconciliation_executions_timeout', executions: executions.slice(-50) });
	      }, config.requestTimeoutMs);
      pending.set(reqId, {
        rows: [],
        resolve: (rows) => { clearTimeout(timer); resolve({ ok: true, executions: rows }); },
      });
	      try { ib.reqExecutions(reqId, { clientId: config.clientId }); } catch (err) {
	        clearTimeout(timer);
	        pending.delete(reqId);
	        resolve({ ok: false, error: err.message, executions: [] });
	      }
    });
  }

	  async function getPaperPositions() {
	    if (!connected) return { ok: false, error: 'not_connected', positions: [] };
	    return new Promise((resolve) => {
	      const timer = setTimeout(() => {
	        pending.delete('positions');
	        recordError(null, 'reconciliation_positions_timeout');
	        logEvent('timeout', { operation: 'positions', timeoutMs: config.requestTimeoutMs });
	        resolve({ ok: false, timedOut: true, blocker: 'reconciliation_positions_timeout', positions: [...positions.values()].filter((p) => p.position !== 0) });
	      }, config.requestTimeoutMs);
      pending.set('positions', {
        resolve: (rows) => { clearTimeout(timer); resolve({ ok: true, positions: rows }); },
      });
      try { ib.reqPositions(); } catch (err) {
        clearTimeout(timer);
        pending.delete('positions');
        resolve({ ok: false, error: err.message, positions: [] });
      }
    });
  }

  function onOrderEvent(listener) {
    if (typeof listener === 'function') orderEventListeners.push(listener);
    return () => { orderEventListeners = orderEventListeners.filter((l) => l !== listener); };
  }

	  function getStatus() {
	    const flags = flagsProvider();
    const uptimeMs = runtimeStartedAt ? Math.max(0, Date.now() - Date.parse(runtimeStartedAt)) : null;
    const connectionUptimeMs = connectedAt ? Math.max(0, Date.now() - Date.parse(connectedAt)) : null;
	    return {
	      readObject: 'ib_paper_execution_adapter',
	      environment: ENVIRONMENT,
	      flags,
      state: connectionState,
      connectionState,
      ready: connectionState === CONNECTION_STATES.READY,
	      connected,
	      connecting,
	      host: config.host,
	      port: config.port,
	      clientId: config.clientId,
	      connectedAt,
      connectedSince: connectedAt,
      runtimeStartedAt,
      lastConnected,
      lastHeartbeat,
      lastReconnect,
      lastReadyAt,
      lastReconciliationAt,
      uptimeMs,
      uptime: uptimeMs,
      runtimeUptimeMs: uptimeMs,
      connectionUptimeMs,
      reconnecting: connectionState === CONNECTION_STATES.RECONNECTING,
      runtimeLifecycle: {
        expected: RUNTIME_LIFECYCLE_STEPS,
        current: lastLifecycleStep,
        connectionState,
        connectedSince: connectedAt,
        lastHeartbeat,
        lastReconnect,
        uptimeMs,
        reconnectCount,
      },
      runtimeLifecycleState: lastLifecycleStep,
	      reconnectCount,
	      nextValidIdReady: nextOrderId != null,
      nextValidId: nextOrderId ?? lastNextValidId,
      lastNextValidId,
      managedAccountsReady: managedAccounts.length > 0,
      managedAccountCount: managedAccounts.length,
	      managedAccounts: managedAccounts.map((id) => ({
	        accountIdMasked: maskAccount(id),
	        classification: adapterModule.classifyAccountId(id),
	      })),
      accountSummary: accountSummarySnapshot ? {
        ok: accountSummarySnapshot.ok === true,
        status: accountSummarySnapshot.status || null,
        blocker: accountSummarySnapshot.blocker || null,
        account: accountSummarySnapshot.account || null,
        generatedAt: accountSummarySnapshot.generatedAt || null,
        rowCount: Array.isArray(accountSummarySnapshot.rows) ? accountSummarySnapshot.rows.length : 0,
      } : null,
	      openOrdersCount: openOrders.size,
	      executionsCount: executions.length,
	      positionsCount: [...positions.values()].filter((p) => p.position !== 0).length,
      orderStatusesTracked: orderStatuses.size,
      lastErrors: lastErrors.slice(-10),
      recentEvents: eventLog.slice(-20),
      noLiveOrderCapability: 'environment är hårdkodat paper; live-flaggor är frysta false-konstanter; submit kräver guard + verifierat DU/DF-konto + flaggor.',
      ...EXECUTION_SAFETY,
	    };
	  }

  function getAccountSummary() {
    if (accountSummarySnapshot) return accountSummarySnapshot;
    return {
      ok: false,
      status: 'pending',
      blocker: 'paper_account_summary_not_ready',
      account: null,
      generatedAt: nowIso(),
      ...EXECUTION_SAFETY,
    };
  }

  function getConnectionReadinessSnapshot() {
    const paperAccounts = managedAccounts.filter((id) => adapterModule.classifyAccountId(id) === 'paper');
    const liveAccounts = managedAccounts.filter((id) => adapterModule.classifyAccountId(id) !== 'paper');
    const paperAccountId = paperAccounts[0] || null;
    const ibApiVerified = nextOrderId != null;
    const paperAccountVerified = paperAccounts.length === 1 && liveAccounts.length === 0;
    const sessionVerified = connectionState === CONNECTION_STATES.READY && ibApiVerified && paperAccountVerified;
    const gatewayReachable = connected || connectionState === CONNECTION_STATES.CONNECTED || connectionState === CONNECTION_STATES.READY || connectionState === CONNECTION_STATES.DEGRADED;
    const uptimeMs = runtimeStartedAt ? Math.max(0, Date.now() - Date.parse(runtimeStartedAt)) : null;
    const connectionUptimeMs = connectedAt ? Math.max(0, Date.now() - Date.parse(connectedAt)) : null;
    const blockedReason = sessionVerified
      ? 'read_only_session_verified'
      : (!gatewayReachable ? 'ib_gateway_unreachable'
        : (!ibApiVerified ? 'ib_api_not_verified'
          : (!paperAccountVerified ? 'paper_account_not_verified' : 'ready_sequence_incomplete')));
    return {
      ok: true,
      dryRun: true,
      safety: { ...EXECUTION_SAFETY },
      source: 'ib_paper_execution_runtime_singleton',
      runtimeState: connectionState,
      host: config.host,
      port: config.port,
      portConfigured: Number.isFinite(Number(config.port)),
      clientIdConfigured: true,
      paperPortConfigured: (config.host === '127.0.0.1' || config.host === 'localhost') && Number(config.port) === 4002,
      connectionCheckEnabled: true,
      gatewayReachable,
      status: sessionVerified ? 'verified' : (gatewayReachable ? 'reachable' : 'unreachable'),
      blockedReason,
      paperMode: paperAccountVerified ? 'paper_only' : 'unknown',
      paperModeVerified: sessionVerified,
      ibApiVerified,
      paperAccountVerified,
      managedAccounts,
      managedAccountCount: managedAccounts.length,
      managedAccountsMasked: managedAccounts.map(maskAccount),
      paperAccountId,
      paperAccountIdMasked: paperAccountId ? maskAccount(paperAccountId) : null,
      sessionVerified,
      verificationMethod: 'execution_runtime_singleton_956',
      nextValidId: nextOrderId ?? lastNextValidId,
      lastConnected,
      connectedSince: connectedAt,
      runtimeStartedAt,
      lastHeartbeat,
      lastReconnect,
      lastReadyAt,
      lastReconciliationAt,
      uptimeMs,
      uptime: uptimeMs,
      runtimeUptimeMs: uptimeMs,
      connectionUptimeMs,
      runtimeLifecycle: {
        expected: RUNTIME_LIFECYCLE_STEPS,
        current: lastLifecycleStep,
        connectionState,
        connectedSince: connectedAt,
        lastHeartbeat,
        lastReconnect,
        uptimeMs,
        reconnectCount,
      },
      runtimeLifecycleState: lastLifecycleStep,
      reconnectCount,
      orderSendingBlocked: true,
      wouldCreateIbPaperOrder: false,
      internalPaperTradingUnaffected: true,
      passwordStored: false,
    };
  }

  return {
	    EXECUTION_SAFETY,
	    config,
      CONNECTION_STATES,
      startPermanentRuntime,
	    connectPaperExecutionClient,
	    disconnect,
		    verifyPaperAccount,
	    createExecutionEvidence,
	    verifyExecutionEvidence,
	    buildOrderPlan,
    buildOrderRef,
    normalizeIbStatus,
    submitPaperOrder,
    cancelPaperOrder,
    modifyPaperOrder,
    flattenOwnedPosition,
    getOpenPaperOrders,
    getPaperOrderStatus: (orderId) => {
      if (orderId == null) return null;
      return orderStatuses.get(Number(orderId)) || null;
    },
    getPaperExecutions,
    getPaperPositions,
    getPaperPnL: () => ({
      ok: true,
      source: 'commission_reports_and_position_snapshots',
      realizedPnl: commissions.reduce((sum, row) => sum + (Number(row.realizedPNL) || 0), 0),
      commissions: commissions.slice(-50),
      positions: [...positions.values()].filter((p) => p.position !== 0),
      ...EXECUTION_SAFETY,
    }),
	    onOrderEvent,
	    getStatus,
      getAccountSummary,
      refreshAccountSummary,
      getConnectionReadinessSnapshot,
      markReconciled: () => { lastReconciliationAt = nowIso(); },
	    isConnected: () => connected,
    getOrderStatuses: () => [...orderStatuses.values()],
    getCommissions: () => commissions.slice(-50),
  };
}

const defaultIbPaperExecutionAdapterService = createIbPaperExecutionAdapterService();

module.exports = {
  EXECUTION_SAFETY,
  ENVIRONMENT,
  IB_STATUS_MAP,
  normalizeIbStatus,
  buildOrderRef,
  createIbPaperExecutionAdapterService,
  defaultIbPaperExecutionAdapterService,
};
