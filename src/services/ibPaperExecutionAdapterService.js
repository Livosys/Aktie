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
const configService = require('./ibPaperExecutionConfigService');
const adapterModule = require('./ibFuturesDataAdapterService');

const ENVIRONMENT = 'paper'; // hårdkodat — ingen kodväg kan sätta 'live'

const EXECUTION_SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: ENVIRONMENT,
  paper_trading_enabled: true,
  ...configService.LIVE_EXECUTION,
  paperOnly: true,
  source: 'ib_paper_execution_adapter',
});

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

function isGuardVerifiedPaper(guardDecision) {
  return guardDecision
    && guardDecision.allowed === true
    && guardDecision.environment === ENVIRONMENT
    && guardDecision.verifiedPaperAccount === true
    && guardDecision.liveAccountBlocked === true;
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

  let ib = null;
  let connected = false;
  let connecting = false;
  let nextOrderId = null; // sätts ENDAST av nextValidId-eventet
  let managedAccounts = [];
  let connectedAt = null;
  let reconnectCount = 0;
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
      logEvent('next_valid_id', { orderId: nextOrderId });
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
        resolve({ ok: true, nextOrderId });
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
      transmit: takeProfitPrice == null, // sista ordern i kedjan transmittar allt
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
      transmit: true,
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
        ? ['entry:false', 'stopLoss:false', 'takeProfit:true']
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
  }) {
    const flags = flagsProvider();
    const refusal = (blocker) => ({ ok: false, submitted: false, blocker, ...EXECUTION_SAFETY });
    if (!flags.executionEnabled) return refusal('ibkr_paper_execution_disabled');
    if (flags.shadowMode) return refusal('shadow_mode_active_no_submit');
    if (!flags.submissionEnabled) return refusal('paper_order_submission_disabled');
    if (!guardDecision || guardDecision.allowed !== true) return refusal('guard_not_passed');
    if (!intentRecord || !intentRecord.idempotencyKey) return refusal('intent_record_missing');
    if (!verifiedAccount || verifiedAccount.ok !== true || verifiedAccount.classification !== 'paper') {
      return refusal('paper_account_not_verified');
    }
    // Dubbelkolla mot DENNA klients discovery — kontot måste synas här också.
    const discovery = verifyPaperAccount(verifiedAccount.accountIdMasked);
    if (!discovery.ok) return refusal(discovery.blocker);
    if (!connected || nextOrderId == null) return refusal('execution_client_not_ready');
    if (!orderPlan || orderPlan.environment !== ENVIRONMENT) return refusal('environment_not_paper');
    if (orderPlan.contract?.secType !== SecType.FUT) return refusal('contract_not_fut');

    const account = discovery.accountIdRawForSubmit;
    const parentId = nextOrderId;
    let idCursor = nextOrderId;
    const legs = [
      { name: 'entry', order: { ...orderPlan.entry, account } },
      { name: 'stopLoss', order: { ...orderPlan.stopLoss, account, parentId } },
      ...(orderPlan.takeProfit ? [{ name: 'takeProfit', order: { ...orderPlan.takeProfit, account, parentId } }] : []),
    ];
    const placed = [];
    try {
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
      return { ok: false, submitted: placed.length > 0, blocker: 'submit_exception', error: err.message, legs: placed, reconciliationRequired: true, ...EXECUTION_SAFETY };
    }
  }

  async function cancelPaperOrder(orderId) {
    const flags = flagsProvider();
    if (!flags.executionEnabled) return { ok: false, blocker: 'ibkr_paper_execution_disabled' };
    if (flags.shadowMode) return { ok: false, blocker: 'shadow_mode_active_no_cancel' };
    if (!flags.submissionEnabled) return { ok: false, blocker: 'paper_order_submission_disabled' };
    if (!connected) return { ok: false, blocker: 'execution_client_not_ready' };
    try {
      ib.cancelOrder(Number(orderId));
      logEvent('cancel_requested', { orderId: Number(orderId) });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function modifyPaperOrder({ orderId, orderPatch, contract, guardDecision, verifiedAccount } = {}) {
    const flags = flagsProvider();
    const refusal = (blocker) => ({ ok: false, modified: false, blocker, ...EXECUTION_SAFETY });
    if (!flags.executionEnabled) return refusal('ibkr_paper_execution_disabled');
    if (flags.shadowMode) return refusal('shadow_mode_active_no_modify');
    if (!flags.submissionEnabled) return refusal('paper_order_submission_disabled');
    if (!isGuardVerifiedPaper(guardDecision)) return refusal('guard_not_passed');
    if (!verifiedAccount || verifiedAccount.ok !== true || verifiedAccount.classification !== 'paper') return refusal('paper_account_not_verified');
    const discovery = verifyPaperAccount(verifiedAccount.accountIdMasked);
    if (!discovery.ok) return refusal(discovery.blocker);
    if (!connected || nextOrderId == null) return refusal('execution_client_not_ready');
    const existing = openOrders.get(Number(orderId));
    if (!existing) return refusal('order_not_open_at_adapter');
    if (!contract || contract.secType !== SecType.FUT) return refusal('contract_not_fut');
    const nextOrder = {
      ...(existing.order || {}),
      ...(orderPatch || {}),
      account: discovery.accountIdRawForSubmit,
      transmit: orderPatch?.transmit === true,
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
        resolve({ ok: true, timedOut: true, orders: [...openOrders.values()] });
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
        resolve({ ok: true, timedOut: true, executions: executions.slice(-50) });
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
        resolve({ ok: true, timedOut: true, positions: [...positions.values()].filter((p) => p.position !== 0) });
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
      nextOrderId,
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
