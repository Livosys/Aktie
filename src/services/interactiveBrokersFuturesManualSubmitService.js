'use strict';

/**
 * IB Paper Futures — mock submit preflight (FAS 4.2, NO REAL SUBMIT).
 *
 * This service wraps the existing futures order-ticket preview and models the
 * final manual-submit preflight with ticket TTL, phrase binding, idempotency and
 * read-only account/order-state gates. It never calls an IB connector and never
 * submits an order; even a fully green mock preflight returns wouldSubmit=false.
 */

const orderTicketService = require('./interactiveBrokersFuturesOrderTicketService');

const PHASE = 'FAS_4_2_MOCK_PREFLIGHT_NO_REAL_SUBMIT';
const LEGACY_PHASE = 'FAS_4_1_SKELETON_NO_REAL_SUBMIT';
const FUTURES_SUBMIT_FLAG = orderTicketService.FUTURES_SUBMIT_FLAG;
const PAPER_SUBMIT_FLAG = 'IB_PAPER_SUBMIT_ROUTES_ENABLED';
const REQUIRED_ACCOUNT = orderTicketService.REQUIRED_ACCOUNT;
const MAX_LIMIT_OFFSET_TICKS = orderTicketService.MAX_LIMIT_OFFSET_TICKS;
const MAX_LIMIT_DEVIATION_PCT = orderTicketService.MAX_LIMIT_DEVIATION_PCT;
const DEFAULT_TTL_MS = 60_000;
const SAFETY = Object.freeze({ ...orderTicketService.SAFETY });

function envFlagEnabled(name, env = process.env) {
  return ['true', '1', 'yes', 'on'].includes(String(env[name] ?? '').trim().toLowerCase());
}

function unique(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))];
}

function hasText(value) {
  return String(value ?? '').trim() !== '';
}

function asDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function defaultIdGenerator() {
  return `fut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultNonceGenerator() {
  return `nonce_${Math.random().toString(36).slice(2, 14)}`;
}

function ticketBinding(ticket, requiredPhrase, nonce) {
  return JSON.stringify({
    phrase: requiredPhrase || null,
    nonce: nonce || null,
    account: ticket?.account || null,
    root: ticket?.root || null,
    side: ticket?.side || null,
    quantity: ticket?.quantity ?? null,
    orderType: ticket?.orderType || null,
    timeInForce: ticket?.timeInForce || null,
    limitPrice: ticket?.limitPrice ?? null,
    referencePrice: ticket?.referencePrice ?? null,
    minTick: ticket?.minTick ?? null,
    conId: ticket?.conId ?? null,
    localSymbol: ticket?.localSymbol || null,
    contractMonth: ticket?.contractMonth || null,
  });
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

function normalizeReadOnlyState(input) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    account: String(state.account || REQUIRED_ACCOUNT),
    orderCapable: state.orderCapable === true,
    openOrders: Array.isArray(state.openOrders) ? state.openOrders : [],
    positions: Array.isArray(state.positions) ? state.positions : [],
    executions: Array.isArray(state.executions) ? state.executions : [],
    safety: state.safety || SAFETY,
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

function priceWithinTolerance(ticket, currentTicket) {
  const limit = safeNumber(ticket?.limitPrice);
  const currentRef = safeNumber(currentTicket?.referencePrice);
  const tick = safeNumber(currentTicket?.minTick ?? ticket?.minTick);
  if (limit === null || currentRef === null || tick === null || tick <= 0 || currentRef <= 0) return false;
  const offsetTicks = Math.abs(limit - currentRef) / tick;
  const deviationPct = (Math.abs(limit - currentRef) / currentRef) * 100;
  return offsetTicks <= MAX_LIMIT_OFFSET_TICKS + 1e-6
    && deviationPct <= MAX_LIMIT_DEVIATION_PCT + 1e-9;
}

function compareCurrentPreview(ticket, currentPreview) {
  const blockers = [];
  if (!currentPreview) return blockers;
  const currentTicket = currentPreview.ticket || {};
  if (ticket?.conId !== currentTicket.conId) blockers.push('contract_changed', 'con_id_mismatch');
  if (ticket?.localSymbol !== currentTicket.localSymbol) blockers.push('contract_changed', 'local_symbol_mismatch');
  if (ticket?.contractMonth !== currentTicket.contractMonth) blockers.push('contract_month_mismatch');
  if (!priceWithinTolerance(ticket, currentTicket)) blockers.push('price_changed_beyond_tolerance');
  return blockers;
}

function buildFuturesManualSubmitSkeleton(opts = {}) {
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
    ticketId: rawTicketId = null,
    nonce: rawNonce = null,
  } = opts;

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const ticketPreview = preview && typeof preview === 'object' ? preview : {};
  const ticket = ticketPreview.ticket || null;
  const manualGate = ticketPreview.manualGate || {};
  const requiredPhrase = manualGate.requiredConfirmationPhrase || null;
  const providedPhrase = String(confirmationPhrase ?? '').trim();
  const confirmationPhraseProvided = hasText(confirmationPhrase);
  const confirmationPhraseMatched = requiredPhrase !== null && providedPhrase === requiredPhrase;

  const ticketId = hasText(rawTicketId) ? String(rawTicketId).trim() : idGenerator();
  const nonce = hasText(rawNonce) ? String(rawNonce).trim() : nonceGenerator();
  const store = ticketStore || createMemoryTicketStore();
  const existingTicket = typeof store.get === 'function' ? store.get(ticketId) : null;
  const createdAt = existingTicket?.createdAt || nowDate.toISOString();
  const expiresAt = existingTicket?.expiresAt || new Date(nowMs + Number(ttlMs || DEFAULT_TTL_MS)).toISOString();
  const expiresAtDate = asDate(expiresAt);

  const futuresSubmitFlagObserved = envFlagEnabled(FUTURES_SUBMIT_FLAG, env);
  const paperSubmitFlagObserved = envFlagEnabled(PAPER_SUBMIT_FLAG, env);
  const ro = normalizeReadOnlyState(readOnlyState);

  const binding = ticketBinding(ticket, requiredPhrase, nonce);
  const previewBlockers = (Array.isArray(ticketPreview.blockers) ? ticketPreview.blockers : [])
    .filter((b) => futuresSubmitFlagObserved || b !== 'futures_submit_routes_disabled');
  const blockers = [
    ...previewBlockers,
    'mock_preflight_only',
    'real_submit_not_implemented',
    'no_real_ib_submit_in_phase_4_2',
  ];

  if (!futuresSubmitFlagObserved) blockers.push('futures_submit_routes_disabled');
  if (!confirmationPhraseProvided) blockers.push('confirmation_phrase_missing');
  else if (!confirmationPhraseMatched) blockers.push('confirmation_phrase_mismatch');

  if (expiresAtDate === null || expiresAtDate.getTime() <= nowMs) blockers.push('ticket_expired', 'stale_ticket');
  if (existingTicket?.consumed === true) blockers.push('duplicate_submit_blocked', 'ticket_already_submitted');
  if (existingTicket?.nonce && existingTicket.nonce !== nonce) blockers.push('ticket_binding_mismatch');
  if (existingTicket?.binding && existingTicket.binding !== binding) blockers.push('ticket_binding_mismatch', 'stale_ticket');

  if (ro.account !== REQUIRED_ACCOUNT) blockers.push('account_mismatch');
  if (ro.orderCapable === true) blockers.push('order_capable_true_unexpected');
  if (ro.openOrders.length > 0) blockers.push('open_orders_present');
  if (ro.positions.length > 0) blockers.push('positions_present');
  if (ro.executions.length > 0) blockers.push('recent_executions_present');
  if (!safetyLocked(ro.safety) || !safetyLocked(SAFETY)) blockers.push('safety_state_changed');

  blockers.push(...compareCurrentPreview(ticket, currentPreview));

  const hardBlockers = new Set([
    'mock_preflight_only',
    'real_submit_not_implemented',
    'no_real_ib_submit_in_phase_4_2',
    'futures_submit_routes_disabled',
    'futures_submit_routes_not_implemented',
  ]);
  const uniqueBlockers = unique(blockers);
  const mockPreflightReady = confirmationPhraseMatched
    && uniqueBlockers.every((b) => hardBlockers.has(b));

  if (!existingTicket && typeof store.set === 'function') {
    store.set(ticketId, { ticketId, nonce, createdAt, expiresAt, binding, consumed: false });
  }
  if (mockPreflightReady && typeof store.markConsumed === 'function') {
    store.markConsumed(ticketId, { consumedAt: nowDate.toISOString(), binding, nonce, expiresAt });
  }

  return {
    ok: true,
    readOnly: true,
    previewOnly: true,
    phase: PHASE,
    legacyPhase: LEGACY_PHASE,
    generatedAt: nowDate.toISOString(),
    dryRun: true,
    wouldSubmit: false,
    submitted: false,
    placeOrderCalled: false,
    submitOrderCalled: false,
    cancelOrderCalled: false,
    realSubmitAvailable: false,
    futuresSubmitRoutesEnabled: false,
    submitRoutesEnabled: false,
    reservedFuturesSubmitFlagEnabled: futuresSubmitFlagObserved,
    paperSubmitRoutesEnabledObserved: paperSubmitFlagObserved,
    manualConfirmationRequired: true,
    readyForManualSubmit: false,
    mockPreflightReady,
    readyForMockSubmit: mockPreflightReady,
    confirmationPhraseRequired: true,
    confirmationPhraseProvided,
    confirmationPhraseMatched,
    requiredConfirmationPhrase: requiredPhrase,
    ticketId,
    nonce,
    createdAt,
    expiresAt,
    request: ticketPreview.request || null,
    ticket,
    preview: ticketPreview,
    preflight: {
      account: ro.account,
      orderCapable: ro.orderCapable,
      openOrdersCount: ro.openOrders.length,
      positionsCount: ro.positions.length,
      executionsCount: ro.executions.length,
      currentPreviewChecked: !!currentPreview,
      ticketBindingChecked: true,
      idempotencyChecked: true,
      ttlMs: Number(ttlMs || DEFAULT_TTL_MS),
    },
    blockers: uniqueBlockers,
    safety: { ...SAFETY },
  };
}

module.exports = {
  PHASE,
  LEGACY_PHASE,
  SAFETY,
  FUTURES_SUBMIT_FLAG,
  PAPER_SUBMIT_FLAG,
  DEFAULT_TTL_MS,
  buildFuturesManualSubmitSkeleton,
  createMemoryTicketStore,
  _internal: {
    envFlagEnabled,
    unique,
    ticketBinding,
    compareCurrentPreview,
    priceWithinTolerance,
    normalizeReadOnlyState,
  },
};
