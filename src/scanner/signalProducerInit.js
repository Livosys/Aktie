'use strict';

/**
 * Initialize extended signal producers
 * Called once at scanner startup to register modular producers
 */

const registry = require('./signalProducerRegistry');
const vwapMeanReversionProducer = require('./vwapMeanReversionProducer');
const emaBreakdownProducer = require('./emaBreakdownProducer');

function initializeProducers() {
  try {
    registry.registerProducer(vwapMeanReversionProducer);
  } catch (err) {
    console.error('Failed to register vwapMeanReversionProducer:', err.message);
  }

  try {
    registry.registerProducer(emaBreakdownProducer);
  } catch (err) {
    console.error('Failed to register emaBreakdownProducer:', err.message);
  }
}

module.exports = { initializeProducers };
