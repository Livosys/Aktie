'use strict';

const REQUIRED_ACCOUNT = 'DUQ565596';
const REQUIRED_ROOT = 'MES';
const REQUIRED_SIDE = 'BUY';
const REQUIRED_QUANTITY = 1;
const REQUIRED_ORDER_TYPE = 'LMT';
const REQUIRED_TIF = 'DAY';
const DEFAULT_ORDER_REF_PHASE = 'FAS4.3';
const DEFAULT_DISABLED_CAPABILITY = Symbol('futures-paper-submit-default-disabled');

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildOrderRef({ ticketId, root = REQUIRED_ROOT, account = REQUIRED_ACCOUNT } = {}) {
  return `${DEFAULT_ORDER_REF_PHASE}:${String(ticketId || '').trim()}:${root}:${account}`;
}

function buildFuturesContract(ticket = {}) {
  return {
    secType: 'FUT',
    symbol: REQUIRED_ROOT,
    localSymbol: ticket.localSymbol,
    conId: ticket.conId,
    exchange: ticket.exchange || 'CME',
    currency: ticket.currency || 'USD',
    lastTradeDateOrContractMonth: ticket.contractMonth,
  };
}

function buildFuturesLimitOrder({ ticket = {}, ticketId } = {}) {
  return {
    action: REQUIRED_SIDE,
    totalQuantity: REQUIRED_QUANTITY,
    orderType: REQUIRED_ORDER_TYPE,
    lmtPrice: safeNumber(ticket.limitPrice),
    tif: REQUIRED_TIF,
    account: REQUIRED_ACCOUNT,
    transmit: true,
    orderRef: buildOrderRef({ ticketId, root: REQUIRED_ROOT, account: REQUIRED_ACCOUNT }),
  };
}

async function submitFuturesPaperOrder({
  ibClient = null,
  nextValidIdProvider = null,
  ticket = null,
  ticketId = null,
  allowRealSubmit = false,
  capability = null,
  expectedCapability = DEFAULT_DISABLED_CAPABILITY,
} = {}) {
  if (allowRealSubmit !== true) {
    return {
      ok: false,
      accepted: false,
      submitted: false,
      placeOrderCalled: false,
      blocker: 'futures_real_submit_disabled',
    };
  }
  if (!expectedCapability || capability !== expectedCapability) {
    return {
      ok: false,
      accepted: false,
      submitted: false,
      placeOrderCalled: false,
      blocker: 'futures_real_submit_adapter_capability_missing',
    };
  }
  if (!ticket) {
    return {
      ok: false,
      accepted: false,
      submitted: false,
      placeOrderCalled: false,
      blocker: 'futures_real_submit_contract_not_verified',
    };
  }
  if (!ibClient || typeof ibClient.placeOrder !== 'function') {
    return {
      ok: false,
      accepted: false,
      submitted: false,
      placeOrderCalled: false,
      blocker: 'futures_real_submit_place_order_not_available',
    };
  }
  if (typeof nextValidIdProvider !== 'function') {
    return {
      ok: false,
      accepted: false,
      submitted: false,
      placeOrderCalled: false,
      blocker: 'futures_real_submit_next_valid_id_missing',
    };
  }

  const orderId = safeNumber(await nextValidIdProvider());
  if (orderId === null || orderId <= 0) {
    return {
      ok: false,
      accepted: false,
      submitted: false,
      placeOrderCalled: false,
      blocker: 'futures_real_submit_next_valid_id_missing',
    };
  }

  const contract = buildFuturesContract(ticket);
  const order = buildFuturesLimitOrder({ ticket, ticketId });
  const result = await ibClient.placeOrder(orderId, contract, order);
  return {
    ok: true,
    accepted: result?.accepted === true,
    status: result?.status || null,
    submitted: result?.accepted === true && ['Submitted', 'PreSubmitted'].includes(String(result?.status || '')),
    placeOrderCalled: true,
    orderId,
    permId: result?.permId || null,
    orderRef: order.orderRef,
    contract,
    order,
  };
}

function createFuturesPaperSubmitAdapter({ capability } = {}) {
  return {
    submitFuturesPaperOrder(opts = {}) {
      return submitFuturesPaperOrder({ ...opts, expectedCapability: capability || DEFAULT_DISABLED_CAPABILITY });
    },
  };
}

module.exports = {
  REQUIRED_ACCOUNT,
  REQUIRED_ROOT,
  REQUIRED_SIDE,
  REQUIRED_QUANTITY,
  REQUIRED_ORDER_TYPE,
  REQUIRED_TIF,
  buildOrderRef,
  buildFuturesContract,
  buildFuturesLimitOrder,
  submitFuturesPaperOrder,
  createFuturesPaperSubmitAdapter,
  _internal: { safeNumber },
};
