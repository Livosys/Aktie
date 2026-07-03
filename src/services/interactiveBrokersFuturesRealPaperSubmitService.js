'use strict';

const orderTicketService = require('./interactiveBrokersFuturesOrderTicketService');
const paperSubmitAdapter = require('./interactiveBrokersFuturesPaperSubmitAdapter');

const PHASE = 'FAS_4_3A_REAL_PAPER_SUBMIT_ADAPTER_FLAGS_OFF';
const FUTURES_SUBMIT_FLAG = orderTicketService.FUTURES_SUBMIT_FLAG;
const REAL_SUBMIT_FLAG = 'IB_FUTURES_REAL_PAPER_SUBMIT_ENABLED';
const PAPER_SUBMIT_FLAG = 'IB_PAPER_SUBMIT_ROUTES_ENABLED';
const FIRST_SYMBOL_FLAG = 'IB_FUTURES_FIRST_REAL_SUBMIT_SYMBOL';
const FIRST_QTY_FLAG = 'IB_FUTURES_FIRST_REAL_SUBMIT_QTY';
const FIRST_ACCOUNT_FLAG = 'IB_FUTURES_FIRST_REAL_SUBMIT_ACCOUNT';
const REQUIRE_REALTIME_FLAG = 'IB_FUTURES_FIRST_REAL_SUBMIT_REQUIRE_REALTIME';

const REQUIRED_ACCOUNT = orderTicketService.REQUIRED_ACCOUNT;
const REQUIRED_ROOT = 'MES';
const REQUIRED_SIDE = 'BUY';
const REQUIRED_QUANTITY = 1;
const REQUIRED_ORDER_TYPE = 'LMT';
const REQUIRED_TIF = 'DAY';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_PRICE_MAX_AGE_MS = 30_000;
const SAFETY = Object.freeze({ ...orderTicketService.SAFETY });
const REAL_SUBMIT_CAPABILITY = Symbol('futures-real-paper-submit-service-capability');
const defaultAdapter = paperSubmitAdapter.createFuturesPaperSubmitAdapter({ capability: REAL_SUBMIT_CAPABILITY });

function envFlagEnabled(name, env = process.env) {
  return ['true', '1', 'yes', 'on'].includes(String(env[name] ?? '').trim().toLowerCase());
}

function unique(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))];
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasText(value) {
  return String(value ?? '').trim() !== '';
}

function asDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function defaultIdGenerator() {
  return `fut_real_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultNonceGenerator() {
  return `nonce_${Math.random().toString(36).slice(2, 14)}`;
}

function createMemoryTicketStore() {
  const rows = new Map();
  return {
    get(ticketId) {
      return rows.get(ticketId) || null;
    },
    set(ticketId, value) {
      rows.set(ticketId, { ...(value || {}) });
      return rows.get(ticketId);
    },
    markConsumed(ticketId, value = {}) {
      const current = rows.get(ticketId) || {};
      rows.set(ticketId, { ...current, ...value, consumed: true, consumedAt: value.consumedAt || new Date().toISOString() });
      return rows.get(ticketId);
    },
  };
}

function safetyLocked(safety) {
  return !!safety
    && safety.mode === 'paper_only'
    && safety.actions_allowed === false
    && safety.can_place_orders === false
    && safety.live_trading_enabled === false
    && safety.broker_enabled === false;
}

function normalizeReadOnlyState(input) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    ok: state.ok === true,
    connected: state.connected === true,
    sessionVerified: state.sessionVerified === true || state.connected === true,
    paperAccountVerified: state.paperAccountVerified === false ? false : (state.paperAccountVerified === true || String(state.account || '') === REQUIRED_ACCOUNT),
    account: String(state.account || ''),
    managedAccounts: Array.isArray(state.managedAccounts) ? state.managedAccounts : [],
    orderCapable: state.orderCapable === true,
    openOrders: Array.isArray(state.openOrders) ? state.openOrders : [],
    positions: Array.isArray(state.positions) ? state.positions : [],
    executions: Array.isArray(state.executions) ? state.executions : [],
    safety: state.safety || SAFETY,
  };
}

function priceIsTickAligned(price, minTick) {
  const p = safeNumber(price);
  const t = safeNumber(minTick);
  if (p === null || t === null || t <= 0) return false;
  const ratio = p / t;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

function priceWithinTolerance(ticket, currentTicket) {
  const limit = safeNumber(ticket?.limitPrice);
  const ref = safeNumber(currentTicket?.referencePrice ?? currentTicket?.price ?? ticket?.referencePrice);
  const tick = safeNumber(currentTicket?.minTick ?? ticket?.minTick);
  if (limit === null || ref === null || tick === null || ref <= 0 || tick <= 0) return false;
  const offsetTicks = Math.abs(limit - ref) / tick;
  const deviationPct = (Math.abs(limit - ref) / ref) * 100;
  return offsetTicks <= orderTicketService.MAX_LIMIT_OFFSET_TICKS + 1e-6
    && deviationPct <= orderTicketService.MAX_LIMIT_DEVIATION_PCT + 1e-9;
}

function shortToken(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
}

function buildRealPaperConfirmationPhrase({ ticket, ticketId, nonce }) {
  return [
    'REAL',
    'PAPER',
    'FUTURES',
    REQUIRED_SIDE,
    String(REQUIRED_QUANTITY),
    REQUIRED_ROOT,
    REQUIRED_ORDER_TYPE,
    String(ticket?.limitPrice),
    REQUIRED_TIF,
    REQUIRED_ACCOUNT,
    ticket?.localSymbol,
    'CONID',
    String(ticket?.conId),
    'TICKET',
    shortToken(ticketId),
    'NONCE',
    shortToken(nonce),
  ].join(' ');
}

function ticketBinding({ ticket, requiredPhrase, ticketId, nonce }) {
  return JSON.stringify({
    phrase: requiredPhrase,
    ticketId,
    nonce,
    account: ticket?.account,
    root: ticket?.root,
    side: ticket?.side,
    quantity: ticket?.quantity,
    orderType: ticket?.orderType,
    timeInForce: ticket?.timeInForce,
    limitPrice: ticket?.limitPrice,
    localSymbol: ticket?.localSymbol,
    conId: ticket?.conId,
    contractMonth: ticket?.contractMonth,
  });
}

function envGateBlockers(env, requireRealtime) {
  const blockers = [];
  if (!envFlagEnabled(FUTURES_SUBMIT_FLAG, env)) blockers.push('futures_real_submit_disabled');
  if (!envFlagEnabled(REAL_SUBMIT_FLAG, env)) blockers.push('futures_real_submit_not_armed');
  if (String(env[FIRST_SYMBOL_FLAG] || '').trim().toUpperCase() !== REQUIRED_ROOT) blockers.push('futures_real_submit_symbol_not_mes');
  if (safeNumber(env[FIRST_QTY_FLAG]) !== REQUIRED_QUANTITY) blockers.push('futures_real_submit_qty_not_one');
  if (String(env[FIRST_ACCOUNT_FLAG] || '').trim() !== REQUIRED_ACCOUNT) blockers.push('futures_real_submit_wrong_account');
  if (requireRealtime && envFlagEnabled(REQUIRE_REALTIME_FLAG, env) !== true) blockers.push('futures_real_submit_realtime_required');
  return blockers;
}

function previewGateBlockers(preview, requireRealtime, nowDate, priceMaxAgeMs, currentPreview) {
  const blockers = [];
  const ticket = preview?.ticket || {};
  if (!currentPreview) blockers.push('futures_real_submit_current_preview_missing');
  const previewBlockers = new Set(Array.isArray(preview?.blockers) ? preview.blockers : []);
  const blockerMap = {
    account_mismatch: 'futures_real_submit_wrong_account',
    symbol_blocked_initial_version: 'futures_real_submit_symbol_not_mes',
    symbol_not_allowed: 'futures_real_submit_symbol_not_mes',
    quantity_not_exactly_one: 'futures_real_submit_qty_not_one',
    order_type_not_allowed: 'futures_real_submit_order_type_not_lmt',
    contract_not_found: 'futures_real_submit_contract_not_verified',
    contract_not_verified: 'futures_real_submit_contract_not_verified',
    no_usable_price: 'futures_real_submit_no_usable_price',
    min_tick_unknown: 'futures_real_submit_min_tick_unknown',
    limit_price_missing: 'futures_real_submit_limit_price_missing',
    limit_price_not_tick_aligned: 'futures_real_submit_limit_price_not_tick_aligned',
    limit_price_out_of_tolerance: 'futures_real_submit_price_out_of_tolerance',
    safety_state_changed: 'futures_real_submit_global_safety_changed',
  };
  for (const blocker of previewBlockers) {
    if (blockerMap[blocker]) blockers.push(blockerMap[blocker]);
  }
  if (ticket.account !== REQUIRED_ACCOUNT) blockers.push('futures_real_submit_wrong_account');
  if (ticket.root !== REQUIRED_ROOT) blockers.push('futures_real_submit_symbol_not_mes');
  if (ticket.side !== REQUIRED_SIDE) blockers.push('futures_real_submit_side_not_buy');
  if (ticket.quantity !== REQUIRED_QUANTITY) blockers.push('futures_real_submit_qty_not_one');
  if (ticket.orderType !== REQUIRED_ORDER_TYPE) blockers.push('futures_real_submit_order_type_not_lmt');
  if (ticket.timeInForce !== REQUIRED_TIF) blockers.push('futures_real_submit_tif_not_day');
  if (!ticket.localSymbol || !ticket.conId || !ticket.contractMonth) blockers.push('futures_real_submit_contract_not_verified');
  if (safeNumber(ticket.minTick) === null || safeNumber(ticket.minTick) <= 0) blockers.push('futures_real_submit_min_tick_unknown');
  if (safeNumber(ticket.limitPrice) === null) blockers.push('futures_real_submit_limit_price_missing');
  if (!priceIsTickAligned(ticket.limitPrice, ticket.minTick)) blockers.push('futures_real_submit_limit_price_not_tick_aligned');
  if (safeNumber(ticket.referencePrice) === null || ticket.referencePrice <= 0) blockers.push('futures_real_submit_no_usable_price');
  if (requireRealtime && ticket.referencePriceType !== 'realtime') blockers.push('futures_real_submit_delayed_data_blocked');

  const generatedAt = asDate(preview?.generatedAt);
  if (generatedAt === null || nowDate.getTime() - generatedAt.getTime() > priceMaxAgeMs) {
    blockers.push('futures_real_submit_price_stale');
  }

  if (currentPreview) {
    const currentTicket = currentPreview.ticket || {};
    if (ticket.conId !== currentTicket.conId) blockers.push('futures_real_submit_contract_mismatch', 'futures_real_submit_con_id_mismatch');
    if (ticket.localSymbol !== currentTicket.localSymbol) blockers.push('futures_real_submit_contract_mismatch', 'futures_real_submit_local_symbol_mismatch');
    if (ticket.contractMonth !== currentTicket.contractMonth) blockers.push('futures_real_submit_contract_mismatch', 'futures_real_submit_contract_month_mismatch');
    if (!priceWithinTolerance(ticket, currentTicket)) blockers.push('futures_real_submit_price_out_of_tolerance');
  }
  return blockers;
}

function readOnlyGateBlockers(readOnlyState) {
  const ro = normalizeReadOnlyState(readOnlyState);
  const blockers = [];
  if (ro.account !== REQUIRED_ACCOUNT) blockers.push('futures_real_submit_wrong_account');
  if (!ro.managedAccounts.includes(REQUIRED_ACCOUNT)) blockers.push('futures_real_submit_managed_account_missing');
  if (ro.connected !== true || ro.sessionVerified !== true) blockers.push('futures_real_submit_gateway_not_verified');
  if (ro.paperAccountVerified !== true) blockers.push('futures_real_submit_paper_account_not_verified');
  if (ro.orderCapable === true) blockers.push('futures_real_submit_order_capable_true_unexpected');
  if (ro.openOrders.length > 0) blockers.push('futures_real_submit_open_orders_present');
  if (ro.positions.length > 0) blockers.push('futures_real_submit_positions_present');
  if (ro.executions.length > 0) blockers.push('futures_real_submit_recent_executions_present');
  if (!safetyLocked(ro.safety) || !safetyLocked(SAFETY)) blockers.push('futures_real_submit_global_safety_changed');
  return { ro, blockers };
}

function adapterBlocker(adapter) {
  return adapter && typeof adapter.submitFuturesPaperOrder === 'function'
    ? null
    : 'futures_real_submit_place_order_not_available';
}

async function buildFuturesRealPaperSubmitResponse(opts = {}) {
  const {
    preview = null,
    currentPreview = null,
    confirmationPhrase = null,
    readOnlyState = null,
    ticketStore = null,
    idGenerator = defaultIdGenerator,
    nonceGenerator = defaultNonceGenerator,
    env = process.env,
    now = new Date(),
    ttlMs = DEFAULT_TTL_MS,
    priceMaxAgeMs = DEFAULT_PRICE_MAX_AGE_MS,
    ticketId: rawTicketId = null,
    nonce: rawNonce = null,
    adapter = defaultAdapter,
    requireRealtime = opts.requireRealtime !== undefined ? opts.requireRealtime === true : true,
  } = opts;

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const ticketPreview = preview && typeof preview === 'object' ? preview : {};
  const ticket = ticketPreview.ticket || {};
  const ticketId = hasText(rawTicketId) ? String(rawTicketId).trim() : idGenerator();
  const nonce = hasText(rawNonce) ? String(rawNonce).trim() : nonceGenerator();
  const store = ticketStore || createMemoryTicketStore();
  const existingTicket = typeof store.get === 'function' ? store.get(ticketId) : null;
  const createdAt = existingTicket?.createdAt || nowDate.toISOString();
  const expiresAt = existingTicket?.expiresAt || new Date(nowMs + Number(ttlMs || DEFAULT_TTL_MS)).toISOString();
  const expiresAtDate = asDate(expiresAt);
  const requiredConfirmationPhrase = buildRealPaperConfirmationPhrase({ ticket, ticketId, nonce });
  const confirmationPhraseProvided = hasText(confirmationPhrase);
  const confirmationPhraseMatched = confirmationPhraseProvided && String(confirmationPhrase).trim() === requiredConfirmationPhrase;
  const binding = ticketBinding({ ticket, requiredPhrase: requiredConfirmationPhrase, ticketId, nonce });
  const { ro, blockers: readOnlyBlockers } = readOnlyGateBlockers(readOnlyState);

  const blockers = [
    ...envGateBlockers(env, requireRealtime),
    ...previewGateBlockers(ticketPreview, requireRealtime, nowDate, Number(priceMaxAgeMs || DEFAULT_PRICE_MAX_AGE_MS), currentPreview),
    ...readOnlyBlockers,
  ];
  const adapterMissing = adapterBlocker(adapter);
  if (adapterMissing) blockers.push(adapterMissing);
  if (!confirmationPhraseProvided) blockers.push('futures_real_submit_confirmation_missing');
  else if (!confirmationPhraseMatched) blockers.push('futures_real_submit_confirmation_mismatch');
  if (expiresAtDate === null || expiresAtDate.getTime() <= nowMs) blockers.push('futures_real_submit_ticket_expired');
  if (existingTicket?.consumed === true) blockers.push('futures_real_submit_duplicate_ticket');
  if (existingTicket?.nonce && existingTicket.nonce !== nonce) blockers.push('futures_real_submit_confirmation_mismatch');
  if (existingTicket?.binding && existingTicket.binding !== binding) blockers.push('futures_real_submit_confirmation_mismatch');

  let uniqueBlockers = unique(blockers);
  let adapterResult = null;
  let placeOrderCalled = false;
  let submitted = false;

  const readyForRealPaperSubmit = uniqueBlockers.length === 0;
  if (!existingTicket && typeof store.set === 'function') {
    store.set(ticketId, { ticketId, nonce, createdAt, expiresAt, binding, consumed: false });
  }

  if (readyForRealPaperSubmit) {
    adapterResult = await adapter.submitFuturesPaperOrder({
      ticket,
      ticketId,
      allowRealSubmit: true,
      capability: REAL_SUBMIT_CAPABILITY,
      nextValidIdProvider: opts.nextValidIdProvider,
      ibClient: opts.ibClient,
    });
    placeOrderCalled = adapterResult?.placeOrderCalled === true;
    if (adapterResult?.blocker) uniqueBlockers = unique([...uniqueBlockers, adapterResult.blocker]);
    if (adapterResult?.accepted === true && ['Submitted', 'PreSubmitted'].includes(String(adapterResult.status || ''))) {
      submitted = true;
      if (typeof store.markConsumed === 'function') store.markConsumed(ticketId, { consumedAt: nowDate.toISOString(), binding, nonce, expiresAt });
    } else if (!adapterResult?.blocker) {
      uniqueBlockers = unique([...uniqueBlockers, 'futures_real_submit_uncertain_submit_state']);
    }
  }

  const orderRef = paperSubmitAdapter.buildOrderRef({ ticketId, root: REQUIRED_ROOT, account: REQUIRED_ACCOUNT });
  return {
    ok: uniqueBlockers.length === 0 || submitted,
    readOnly: submitted !== true,
    previewOnly: submitted !== true,
    phase: PHASE,
    generatedAt: nowDate.toISOString(),
    safetyDryRun: submitted !== true,
    dryRun: submitted !== true,
    wouldSubmit: false,
    submitted,
    placeOrderCalled,
    submitOrderCalled: false,
    cancelOrderCalled: false,
    realSubmitAvailable: false,
    realPaperSubmitEnabled: envFlagEnabled(REAL_SUBMIT_FLAG, env),
    reservedFuturesSubmitFlagEnabled: envFlagEnabled(FUTURES_SUBMIT_FLAG, env),
    paperSubmitRoutesEnabledObserved: envFlagEnabled(PAPER_SUBMIT_FLAG, env),
    futuresSubmitRoutesEnabled: false,
    submitRoutesEnabled: false,
    adapterReady: adapterMissing === null,
    readyForRealPaperSubmit: submitted === true,
    readOnlyVerificationRecommended: submitted === true || uniqueBlockers.includes('futures_real_submit_uncertain_submit_state'),
    noRetry: true,
    noCancel: true,
    manualConfirmationRequired: true,
    confirmationPhraseRequired: true,
    confirmationPhraseProvided,
    confirmationPhraseMatched,
    requiredConfirmationPhrase,
    ticketId,
    nonce,
    createdAt,
    expiresAt,
    request: ticketPreview.request || null,
    ticket,
    preflight: {
      account: ro.account,
      managedAccounts: ro.managedAccounts,
      gatewayVerified: ro.connected === true && ro.sessionVerified === true,
      paperAccountVerified: ro.paperAccountVerified === true,
      orderCapable: ro.orderCapable,
      openOrdersCount: ro.openOrders.length,
      positionsCount: ro.positions.length,
      executionsCount: ro.executions.length,
      requireRealtime,
      priceMaxAgeMs: Number(priceMaxAgeMs || DEFAULT_PRICE_MAX_AGE_MS),
      currentPreviewChecked: !!currentPreview,
      ticketBindingChecked: true,
      idempotencyChecked: true,
    },
    adapterResultSummary: adapterResult ? {
      accepted: adapterResult.accepted === true,
      status: adapterResult.status || null,
      orderId: adapterResult.orderId || null,
      permId: adapterResult.permId || null,
      orderRef: adapterResult.orderRef || orderRef,
      placeOrderCalled: adapterResult.placeOrderCalled === true,
    } : null,
    audit: {
      ticketId,
      orderRef,
      account: REQUIRED_ACCOUNT,
      root: ticket.root || null,
      localSymbol: ticket.localSymbol || null,
      conId: ticket.conId || null,
      side: ticket.side || null,
      quantity: ticket.quantity ?? null,
      orderType: ticket.orderType || null,
      tif: ticket.timeInForce || null,
      limitPrice: ticket.limitPrice ?? null,
      phase: PHASE,
      blockers: uniqueBlockers,
      submitted,
      timestamp: nowDate.toISOString(),
      adapterResultSummary: adapterResult ? {
        accepted: adapterResult.accepted === true,
        status: adapterResult.status || null,
        orderId: adapterResult.orderId || null,
      } : null,
      noRetry: true,
      noCancel: true,
    },
    blockers: uniqueBlockers,
    safety: { ...SAFETY },
  };
}

module.exports = {
  PHASE,
  SAFETY,
  FUTURES_SUBMIT_FLAG,
  REAL_SUBMIT_FLAG,
  PAPER_SUBMIT_FLAG,
  FIRST_SYMBOL_FLAG,
  FIRST_QTY_FLAG,
  FIRST_ACCOUNT_FLAG,
  REQUIRE_REALTIME_FLAG,
  DEFAULT_TTL_MS,
  DEFAULT_PRICE_MAX_AGE_MS,
  REQUIRED_ACCOUNT,
  REQUIRED_ROOT,
  REQUIRED_SIDE,
  REQUIRED_QUANTITY,
  REQUIRED_ORDER_TYPE,
  REQUIRED_TIF,
  buildFuturesRealPaperSubmitResponse,
  buildRealPaperConfirmationPhrase,
  createMemoryTicketStore,
  _internal: {
    envFlagEnabled,
    unique,
    safeNumber,
    safetyLocked,
    normalizeReadOnlyState,
    priceIsTickAligned,
    priceWithinTolerance,
    ticketBinding,
  },
};
