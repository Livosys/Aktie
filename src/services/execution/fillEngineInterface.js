'use strict';

// ── FillEngine: kontraktet för hur en order blir en affär ────────────────────
//
// Native Engine slutar vid en validerad canonical signal med entry, stop och
// target. Vad som därefter HÄNDER med den ordern är en helt annan fråga, och
// den frågan har olika svar beroende på var man kör:
//
//   HistoricalFill   replay: barer, härledd spread, modellerad latens
//   PaperFill        IBKR paper: riktiga fills från brokern
//   IbLiveFill       live: riktiga fills med riktiga pengar
//   MonteCarloFill   osäkerhetsanalys: samma order, många utfall
//
// Alla fyra implementerar det här kontraktet. Replay kan byta motor utan att
// Native Engine ändras — och Fill Engine får ALDRIG kunna påverka en signal.
// Den tar emot en order som redan är beslutad.
//
// Två begrepp som hålls isär genom hela kedjan:
//
//   expectedPrice   priset strategin fattade sitt beslut på. AI optimerar mot
//                   DETTA. Annars lär den sig kompensera för slumpmässig
//                   slippage i stället för att hitta edge.
//   executedPrice   priset ordern faktiskt fylldes på. Mäts separat och blir
//                   Execution Score.
//
// Ren modul: ingen IO, inget nätverk, ingen klocka, ingen broker.

const ORDER_TYPES = Object.freeze(['market', 'limit', 'stop', 'stopLimit']);
const SIDES = Object.freeze(['buy', 'sell']);

const FILL_STATUS = Object.freeze({
  FILLED: 'filled',
  PARTIAL: 'partial',
  NO_FILL: 'no_fill',
  REJECTED: 'rejected',
});

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const REQUIRED_METHODS = Object.freeze(['fill', 'describe']);

// En order som en fill engine kan ta emot. Fälten är avsiktligt broker-nära
// så att samma struktur duger för både simulering och riktig exekvering.
const ORDER_FIELDS = Object.freeze([
  'orderId', 'symbol', 'side', 'type', 'quantity', 'expectedPrice', 'timestamp',
]);

const FILL_RESULT_FIELDS = Object.freeze([
  'status', 'orderId', 'fills', 'filledQuantity', 'requestedQuantity',
  'expectedPrice', 'executedPrice', 'priceDifference', 'fillDelayMs',
  'slippage', 'spread', 'executionCost', 'reason', 'engine',
]);

function validateOrder(order) {
  const errors = [];
  if (!order || typeof order !== 'object') return { ok: false, errors: ['order_is_not_an_object'] };
  if (!order.orderId) errors.push('missing_orderId');
  if (!order.symbol) errors.push('missing_symbol');
  if (!SIDES.includes(order.side)) errors.push(`invalid_side:${order.side}`);
  if (!ORDER_TYPES.includes(order.type)) errors.push(`invalid_type:${order.type}`);
  if (!(Number(order.quantity) > 0)) errors.push('quantity_must_be_positive');
  if (!order.timestamp) errors.push('missing_timestamp');
  if (order.type === 'limit' && !(Number(order.limitPrice) > 0)) errors.push('limit_requires_limitPrice');
  if (order.type === 'stop' && !(Number(order.stopPrice) > 0)) errors.push('stop_requires_stopPrice');
  if (order.type === 'stopLimit') {
    if (!(Number(order.stopPrice) > 0)) errors.push('stopLimit_requires_stopPrice');
    if (!(Number(order.limitPrice) > 0)) errors.push('stopLimit_requires_limitPrice');
  }
  return { ok: errors.length === 0, errors };
}

function validateFillEngine(engine) {
  const errors = [];
  if (!engine || typeof engine !== 'object') return { ok: false, errors: ['engine_is_not_an_object'] };
  for (const method of REQUIRED_METHODS) {
    if (typeof engine[method] !== 'function') errors.push(`missing_method_${method}`);
  }
  return { ok: errors.length === 0, errors };
}

function validateFillResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') return { ok: false, errors: ['result_is_not_an_object'] };
  for (const field of FILL_RESULT_FIELDS) {
    if (!(field in result)) errors.push(`missing_field_${field}`);
  }
  if (!Object.values(FILL_STATUS).includes(result.status)) errors.push(`invalid_status:${result.status}`);
  if (!Array.isArray(result.fills)) errors.push('fills_is_not_an_array');
  if (result.status === FILL_STATUS.FILLED && result.filledQuantity !== result.requestedQuantity) {
    errors.push('filled_status_requires_full_quantity');
  }
  if (result.status === FILL_STATUS.NO_FILL && result.filledQuantity !== 0) {
    errors.push('no_fill_status_requires_zero_quantity');
  }
  return { ok: errors.length === 0, errors };
}

function assertFillEngine(engine, label = 'fillEngine') {
  const result = validateFillEngine(engine);
  if (!result.ok) {
    throw new TypeError(`${label} uppfyller inte FillEngine-kontraktet: ${result.errors.join(', ')}`);
  }
  return engine;
}

// Tomt resultat i kontraktets form. Används av motorer som avvisar en order,
// så att en avvisning aldrig saknar fält en rapport förväntar sig.
function emptyResult(order = {}, { status = FILL_STATUS.NO_FILL, reason = null, engine = 'unknown' } = {}) {
  return {
    status,
    orderId: order.orderId || null,
    fills: [],
    filledQuantity: 0,
    requestedQuantity: Number(order.quantity) || 0,
    expectedPrice: Number(order.expectedPrice) || null,
    executedPrice: null,
    priceDifference: null,
    fillDelayMs: null,
    slippage: null,
    spread: null,
    executionCost: null,
    reason,
    engine,
  };
}

module.exports = {
  SAFETY,
  ORDER_TYPES,
  SIDES,
  FILL_STATUS,
  REQUIRED_METHODS,
  ORDER_FIELDS,
  FILL_RESULT_FIELDS,
  validateOrder,
  validateFillEngine,
  validateFillResult,
  assertFillEngine,
  emptyResult,
};
