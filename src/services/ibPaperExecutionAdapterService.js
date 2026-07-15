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
const evidenceSecret = crypto.randomBytes(32).toString('hex');

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
  approval,
  entryContract,
  reconciliation,
  verifiedAccount,
} = {}) {
  return {
    evidenceVersion: EVIDENCE_VERSION,
    intent: {
      executionId: intentRecord?.executionId || null,
      idempotencyKey: intentRecord?.idempotencyKey || null,
      strategyId: intentRecord?.strategyId || null,
      candidateId: intentRecord?.candidateId || null,
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
    approval: {
      allowed: approval?.allowed === true || approval?.strategyApproved === true,
      source: approval?.source || approval?.approval?.source || null,
      strategyId: approval?.strategyId || intentRecord?.strategyId || null,
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

function approvalAllowed(evidence = {}) {
  return evidence?.allowed === true || evidence?.strategyApproved === true;
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
  checks.add(!tp || (Number.isInteger(tpQty) && tpQty === 1), 'take_profit_quantity_mismatch');
  checks.add(entryAction === OrderAction.BUY || entryAction === OrderAction.SELL, 'entry_action_invalid');
  checks.add(stopAction === expectedExit, 'stop_action_not_opposite_entry');
  checks.add(!tp || tpAction === expectedExit, 'take_profit_action_not_opposite_entry');
  checks.add([OrderType.MKT, OrderType.LMT].includes(String(entry.orderType || '').toUpperCase()), 'entry_order_type_not_allowed');
  checks.add(String(stop.orderType || '').toUpperCase() === OrderType.STP && Number.isFinite(Number(stop.auxPrice)), 'stop_loss_required');
  checks.add(!tp || (String(tp.orderType || '').toUpperCase() === OrderType.LMT && Number.isFinite(Number(tp.lmtPrice))), 'take_profit_invalid');
  checks.add(stopCount === 1, 'exactly_one_stop_required');
  checks.add(entry.transmit === false, 'entry_transmit_must_be_false');
  checks.add(!tp || tp.transmit === false, 'take_profit_transmit_must_be_false');
  checks.add(stop.transmit === true, 'stop_loss_must_be_final_transmit');
  checks.add(Array.isArray(orderPlan?.transmitSequence)
    && (tp
      ? orderPlan.transmitSequence.join('|') === 'entry:false|takeProfit:false|stopLoss:true'
      : orderPlan.transmitSequence.join('|') === 'entry:false|stopLoss:true'), 'bracket_transmit_sequence_invalid');
  checks.add(String(entry.orderRef || '').startsWith(ORDER_REF_PREFIX), 'entry_order_ref_invalid');
  checks.add(String(stop.orderRef || '').startsWith(ORDER_REF_PREFIX), 'stop_order_ref_invalid');
  checks.add(!tp || String(tp.orderRef || '').startsWith(ORDER_REF_PREFIX), 'take_profit_order_ref_invalid');
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
	  let reconnectCount = 0;
	  let submitInProgress = false;
	  const lastErrors = [];

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
      }
    });
    client.on(EventName.disconnected, () => {
      connected = false;
      connecting = false;
      nextOrderId = null; // aldrig återanvända gamla order-id efter disconnect
      logEvent('disconnected', {});
    });
    client.on(EventName.nextValidId, (orderId) => {
      nextOrderId = Number(orderId);
      logEvent('next_valid_id', { nextValidIdReady: nextOrderId != null });
    });
    client.on(EventName.managedAccounts, (accounts) => {
      managedAccounts = String(accounts || '').split(',').map((s) => s.trim()).filter(Boolean);
    });
    client.on(EventName.openOrder, (orderId, contract, order, orderState) => {
      openOrders.set(Number(orderId), {
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
          orderRef: order?.orderRef ?? null,
	          parentId: order?.parentId ?? null,
	          ocaGroup: order?.ocaGroup ?? null,
	          transmit: order?.transmit === true,
	          accountMasked: maskAccount(order?.account),
          permId: order?.permId ?? null,
        },
        state: orderState?.status ?? null,
        updatedAt: nowIso(),
      });
      logEvent('open_order', { orderId: Number(orderId), status: orderState?.status ?? null, orderRef: order?.orderRef ?? null });
    });
    client.on(EventName.openOrderEnd, () => {
      const entry = pending.get('openOrders');
      if (entry) { pending.delete('openOrders'); entry.resolve([...openOrders.values()]); }
    });
    client.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice) => {
      const normalized = normalizeIbStatus(status, filled, remaining);
      orderStatuses.set(Number(orderId), {
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
      logEvent('order_status', { orderId: Number(orderId), ibStatus: status, status: normalized, filled: Number(filled) || 0, remaining: Number(remaining) || 0 });
    });
    client.on(EventName.execDetails, (reqId, contract, execution) => {
      executions.push({
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
      });
      if (executions.length > 200) executions.shift();
      logEvent('exec_details', { execId: execution?.execId ?? null, orderId: execution?.orderId ?? null, price: execution?.price ?? null });
      const entry = pending.get(reqId);
      if (entry) entry.rows.push(executions[executions.length - 1]);
    });
    client.on(EventName.execDetailsEnd, (reqId) => {
      const entry = pending.get(reqId);
      if (entry) { pending.delete(reqId); entry.resolve(entry.rows); }
    });
    client.on(EventName.commissionReport, (report) => {
      commissions.push({
        execId: report?.execId ?? null,
        commission: report?.commission ?? null,
        currency: report?.currency ?? null,
        realizedPNL: (report?.realizedPNL != null && Math.abs(report.realizedPNL) < 1e300) ? report.realizedPNL : null,
        receivedAt: nowIso(),
      });
      if (commissions.length > 200) commissions.shift();
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
        entry.resolve([...positions.values()].filter((p) => p.position !== 0));
      }
    });
  }

  async function connectPaperExecutionClient() {
    const flags = flagsProvider();
    if (!flags.executionEnabled) {
      return { ok: false, error: 'ibkr_paper_execution_disabled' };
    }
    if (connected) return { ok: true, alreadyConnected: true };
    if (connecting) return { ok: false, error: 'connect_in_progress' };
    connecting = true;
    if (!ib) {
      ib = ibFactory(config);
      attachHandlers(ib);
    } else {
      reconnectCount += 1;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        connecting = false;
        recordError(null, `execution_connect_timeout_after_${config.connectTimeoutMs}ms`);
        resolve({ ok: false, error: 'connect_timeout' });
      }, config.connectTimeoutMs);
      ib.once(EventName.nextValidId, () => {
        clearTimeout(timer);
        connecting = false;
        connected = true;
        connectedAt = nowIso();
        resolve({ ok: true, nextValidIdReady: nextOrderId != null });
      });
      try {
        ib.connect();
      } catch (err) {
        clearTimeout(timer);
        connecting = false;
        recordError(null, err.message);
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function disconnect() {
    if (ib) { try { ib.disconnect(); } catch (_) { /* ok */ } }
    connected = false;
    connecting = false;
    nextOrderId = null;
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
	    approval,
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
	      approval,
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
	    approval,
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
	      approval,
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
	    const ibContract = {
	      conId: contract.conId,
	      exchange: contract.exchange || 'CME',
	      secType: SecType.FUT,
	      symbol: contract.root,
	      currency: contract.currency || 'USD',
	      localSymbol: contract.localSymbol || undefined,
	      expiry: contract.expiry || contract.lastTradeDateOrContractMonth || undefined,
	      lastTradeDateOrContractMonth: contract.expiry || contract.lastTradeDateOrContractMonth || undefined,
	    };
    const ocaGroup = `TOSP-${String(executionId).slice(-16)}`;
    const entry = {
      action,
      totalQuantity: quantity,
      orderType: entryType === 'LMT' ? OrderType.LMT : OrderType.MKT,
      ...(entryType === 'LMT' && limitPrice != null ? { lmtPrice: limitPrice } : {}),
      tif: TimeInForce[tif] || TimeInForce.GTC,
      outsideRth,
      transmit: false, // barnorder skickas före aktivering — sista i kedjan transmittar
      orderRef: buildOrderRef(executionId, 'entry'),
    };
    const stopLoss = {
      action: exitAction,
      totalQuantity: quantity,
	      orderType: OrderType.STP,
	      auxPrice: stopLossPrice,
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
	      lmtPrice: takeProfitPrice,
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
	    approval,
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
	    if (approvalAllowed(approval) !== true) return refusal('strategy_not_approved');
	    if (entryContractAllowed(entryContract) !== true) return refusal('entry_contract_not_approved');
	    if (brokerRisk?.allowed !== true) return refusal('broker_risk_blocked');
	    if (reconciliation?.degraded === true || reconciliation?.status !== 'ok') return refusal(reconciliation?.blockedReason || 'reconciliation_degraded');
	    const evidenceCheck = verifyExecutionEvidence({
	      executionEvidence,
	      guardDecision,
	      intentRecord,
	      orderPlan,
	      brokerRisk,
	      approval,
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
        logEvent('order_placed', { leg: leg.name, orderId, orderRef: leg.order.orderRef, transmit: leg.order.transmit, accountMasked: maskAccount(account) });
      }
	      nextOrderId = idCursor;
	      return { ok: true, submitted: true, parentOrderId: parentId, legs: placed, accountMasked: maskAccount(account), ...EXECUTION_SAFETY };
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
	    return intents.find((intent) => {
	      const ids = Array.isArray(intent.expectedOrderIds) ? intent.expectedOrderIds.map(Number) : [];
	      const refs = Array.isArray(intent.orderRefs) ? intent.orderRefs.map(String) : [intent.orderRef].filter(Boolean).map(String);
	      return (Number.isFinite(wantedId) && ids.includes(wantedId))
	        || (orderRef && refs.includes(String(orderRef)));
	    }) || null;
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
	      ...(existing.order || {}),
	      ...patch,
	      account: discovery.accountIdRawForSubmit,
	      transmit: existing.order?.transmit === true,
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
	        resolve({ ok: false, timedOut: true, blocker: 'reconciliation_executions_timeout', executions: executions.slice(-50) });
	      }, config.requestTimeoutMs);
      pending.set(reqId, {
        rows: [],
        resolve: (rows) => { clearTimeout(timer); resolve({ ok: true, executions: rows }); },
      });
      try { ib.reqExecutions(reqId, {}); } catch (err) {
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
    return {
      readObject: 'ib_paper_execution_adapter',
      environment: ENVIRONMENT,
      flags,
      connected,
      connecting,
      host: config.host,
      port: config.port,
      clientId: config.clientId,
      connectedAt,
	      reconnectCount,
	      nextValidIdReady: nextOrderId != null,
	      managedAccounts: managedAccounts.map((id) => ({
        accountIdMasked: maskAccount(id),
        classification: adapterModule.classifyAccountId(id),
      })),
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

  return {
    EXECUTION_SAFETY,
    config,
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
