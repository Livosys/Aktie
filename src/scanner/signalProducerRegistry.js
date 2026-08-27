'use strict';

/**
 * signalProducerRegistry — Modular signal producer registration system
 *
 * Allows new signal producers to be registered without modifying the central
 * classifySignalFamily() logic. Producers follow a simple contract and must
 * return canonical signal objects if they detect their pattern, or null.
 *
 * Existing producers (EMA pullback, VWAP reclaim, narrow fakeout) remain
 * embedded in classifySignalFamily() for backward compatibility.
 * New producers register here and are invoked as secondary checks.
 */

// Registry of extended producers
const EXTENDED_PRODUCERS = new Map();

/**
 * Producer contract:
 * {
 *   producerId: string (unique),
 *   signalFamily: string,
 *   supportedSubtypes: string[],
 *   evaluate(context) → candidate object or null
 * }
 *
 * Context contains:
 * {
 *   snapshot,
 *   result (indicators),
 *   price,
 *   close,
 *   direction (UP/DOWN/UNKNOWN),
 *   now
 * }
 *
 * Must return: { signalSubtype, direction, ... } or null
 * Canonical fields required by native evaluators must be present.
 */

function registerProducer(producer) {
  if (!producer || !producer.producerId) {
    throw new Error('Producer must have producerId');
  }
  if (EXTENDED_PRODUCERS.has(producer.producerId)) {
    throw new Error(`Producer ${producer.producerId} already registered`);
  }
  EXTENDED_PRODUCERS.set(producer.producerId, producer);
}

function getProducer(producerId) {
  return EXTENDED_PRODUCERS.get(producerId);
}

function listProducers() {
  return Array.from(EXTENDED_PRODUCERS.values());
}

/**
 * Try extended producers in order. Return first match or null.
 * Safe to call after main classifier—extended producers should not
 * overlap with existing producible subtypes.
 */
function evaluateExtendedProducers(context) {
  for (const producer of EXTENDED_PRODUCERS.values()) {
    if (!producer.evaluate) continue;
    try {
      const result = producer.evaluate(context);
      if (result && typeof result === 'object') {
        return result;
      }
    } catch (err) {
      // Producer errors fail closed—do not produce signal
      continue;
    }
  }
  return null;
}

module.exports = {
  registerProducer,
  getProducer,
  listProducers,
  evaluateExtendedProducers,
};
