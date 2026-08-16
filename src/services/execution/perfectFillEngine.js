'use strict';

// ── PerfectFillEngine ────────────────────────────────────────────────────────
//
// Fyller varje order omedelbart till expectedPrice. Ingen slippage, ingen
// spread, ingen latens, aldrig en utebliven fill.
//
// Den här motorn är INTE en förenkling som slunkit igenom — den är
// referenspunkten. Skillnaden mellan en körning med den här motorn och samma
// körning med SimulatedFillEngine ÄR execution cost. Utan en perfekt baslinje
// går Strategy Edge inte att skilja från Execution Edge, och då kan AI:n inte
// avgöra om en strategi är dålig eller om utförandet är dåligt.
//
// Den uppfyller också acceptanskravet "replay fungerar utan Fill Model": att
// köra utan fyllningsmodell är detsamma som att köra med den här.

const iface = require('./fillEngineInterface');

const ENGINE = 'perfect_fill';

function createPerfectFillEngine() {
  function fill(order) {
    const validation = iface.validateOrder(order);
    if (!validation.ok) {
      return iface.emptyResult(order, {
        status: iface.FILL_STATUS.REJECTED,
        reason: validation.errors.join(','),
        engine: ENGINE,
      });
    }

    const price = Number(order.expectedPrice);
    if (!(price > 0)) {
      return iface.emptyResult(order, {
        status: iface.FILL_STATUS.REJECTED,
        reason: 'expected_price_missing',
        engine: ENGINE,
      });
    }

    const quantity = Number(order.quantity);
    return {
      status: iface.FILL_STATUS.FILLED,
      orderId: order.orderId,
      fills: [{ price, quantity, timestamp: order.timestamp, delayMs: 0 }],
      filledQuantity: quantity,
      requestedQuantity: quantity,
      expectedPrice: price,
      executedPrice: price,
      priceDifference: 0,
      fillDelayMs: 0,
      slippage: 0,
      spread: 0,
      executionCost: 0,
      reason: null,
      engine: ENGINE,
    };
  }

  function describe() {
    return {
      engine: ENGINE,
      deterministic: true,
      simulates: [],
      note: 'Referensmotor. Fyller till expectedPrice utan kostnad — baslinjen som execution cost mäts mot.',
      ...iface.SAFETY,
    };
  }

  return { fill, describe };
}

module.exports = {
  ENGINE,
  createPerfectFillEngine,
  defaultPerfectFillEngine: createPerfectFillEngine(),
};
