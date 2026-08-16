'use strict';

// ── PriceFeed: Trading OS Data Abstraction Layer ─────────────────────────────
//
// Native Engine — scanner, evaluatorer, decision monitor, canonical adapter —
// får ALDRIG veta varifrån sina candles kommer. Den känner bara det här
// kontraktet. Replay, Batch, Paper och Live gör exakt samma anrop; det enda som
// skiljer dem åt är vilken implementation som skickas in och vilken klocka den
// får.
//
//   getCandles(root, { now, timeframe, limit }) -> {
//     candles[]      stängda candles, äldst först, aldrig efter `now`
//     openCandle     det ofullständiga candlet, eller null
//     source         härkomst
//     dataQuality    'ib' | 'missing' | ...
//     contract       { root, conId, localSymbol, expiry } | null
//     warnings[]
//   }
//
//   getQuote(root, now) -> quote | null
//
// Två regler som gör kontraktet meningsfullt i stället för dekorativt:
//
//   1. `now` skickas ALLTID in. En feed får aldrig läsa Date.now() själv —
//      då går den inte att replaya.
//   2. Ingen implementation får aggregera själv. Alla går via
//      candleWindow.buildCandleWindow, som i sin tur går via candleAggregator.
//
// Modulen är read-only och innehåller ingen handelslogik.

const REQUIRED_METHODS = Object.freeze(['getCandles', 'getQuote']);

const CANDLE_RESULT_FIELDS = Object.freeze([
  'candles', 'source', 'dataQuality', 'contract', 'warnings',
]);

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

/**
 * Kontrollerar att ett objekt uppfyller PriceFeed-kontraktet.
 * Returnerar { ok, errors } — kastar aldrig.
 */
function validatePriceFeed(feed) {
  const errors = [];
  if (!feed || typeof feed !== 'object') {
    return { ok: false, errors: ['feed_is_not_an_object'] };
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof feed[method] !== 'function') errors.push(`missing_method_${method}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Kontrollerar att ett getCandles-svar har rätt form.
 * Används av tester och av den paritetsverifiering som binder ihop feedarna.
 */
function validateCandleResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') {
    return { ok: false, errors: ['result_is_not_an_object'] };
  }
  for (const field of CANDLE_RESULT_FIELDS) {
    if (!(field in result)) errors.push(`missing_field_${field}`);
  }
  if (!Array.isArray(result.candles)) errors.push('candles_is_not_an_array');
  if (!Array.isArray(result.warnings)) errors.push('warnings_is_not_an_array');

  // Ett candle efter `now` betyder framtidsläckage och är det allvarligaste
  // fel en feed kan ha — resultatet blir oreproducerbart utan att något syns.
  if (Array.isArray(result.candles)) {
    for (const candle of result.candles) {
      if (candle && candle.isClosed === false) errors.push('open_candle_in_closed_list');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Kastar om feeden inte uppfyller kontraktet. För kompositionsrötter som vill
 * misslyckas högt i stället för att skicka in något halvfärdigt i motorn.
 */
function assertPriceFeed(feed, label = 'priceFeed') {
  const result = validatePriceFeed(feed);
  if (!result.ok) {
    throw new TypeError(`${label} uppfyller inte PriceFeed-kontraktet: ${result.errors.join(', ')}`);
  }
  return feed;
}

module.exports = {
  SAFETY,
  REQUIRED_METHODS,
  CANDLE_RESULT_FIELDS,
  validatePriceFeed,
  validateCandleResult,
  assertPriceFeed,
};
