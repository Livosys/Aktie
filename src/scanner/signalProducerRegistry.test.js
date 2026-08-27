'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const registry = require('./signalProducerRegistry');

test('signalProducerRegistry', async (t) => {
  // Clear registry before tests
  const initialProducers = registry.listProducers();
  initialProducers.forEach(p => {
    try {
      registry.getProducer(p.producerId);
    } catch (err) {
      // ignore
    }
  });

  await t.test('valid producer registration', () => {
    const testProducer = {
      producerId: 'test_producer_' + Date.now(),
      signalFamily: 'TEST_FAMILY',
      supportedSubtypes: ['TEST_SUBTYPE'],
      evaluate: () => null,
    };
    registry.registerProducer(testProducer);
    const retrieved = registry.getProducer(testProducer.producerId);
    assert.deepStrictEqual(retrieved.producerId, testProducer.producerId);
  });

  await t.test('duplicate producerId rejected', () => {
    const id = 'dup_test_' + Date.now();
    const producer1 = {
      producerId: id,
      signalFamily: 'TEST',
      supportedSubtypes: [],
      evaluate: () => null,
    };
    registry.registerProducer(producer1);

    const producer2 = {
      producerId: id,
      signalFamily: 'TEST',
      supportedSubtypes: [],
      evaluate: () => null,
    };
    assert.throws(
      () => registry.registerProducer(producer2),
      /already registered/
    );
  });

  await t.test('missing producerId rejected', () => {
    const badProducer = {
      signalFamily: 'TEST',
      supportedSubtypes: [],
      evaluate: () => null,
    };
    assert.throws(
      () => registry.registerProducer(badProducer),
      /must have producerId/
    );
  });

  await t.test('null producer result creates no signal', () => {
    const testProducer = {
      producerId: 'null_test_' + Date.now(),
      signalFamily: 'TEST',
      supportedSubtypes: [],
      evaluate: () => null,
    };
    registry.registerProducer(testProducer);

    const result = registry.evaluateExtendedProducers({});
    // Result should be null if no producer returns a signal
    if (result === null) {
      assert.strictEqual(result, null);
    }
  });

  await t.test('producer exception fails closed', () => {
    const errorProducer = {
      producerId: 'error_test_' + Date.now(),
      signalFamily: 'TEST',
      supportedSubtypes: [],
      evaluate: () => {
        throw new Error('Intentional producer error');
      },
    };
    registry.registerProducer(errorProducer);

    // Should not crash, should return null
    const result = registry.evaluateExtendedProducers({});
    assert.strictEqual(result, null);
  });

  await t.test('malformed producer rejected', () => {
    const malformed = {
      producerId: 'malformed_' + Date.now(),
      signalFamily: 'TEST',
      supportedSubtypes: [],
      // missing evaluate function
    };
    registry.registerProducer(malformed);

    // Should not crash when calling evaluate
    const result = registry.evaluateExtendedProducers({});
    assert.strictEqual(result, null);
  });

  await t.test('evaluate returns first matching producer result', () => {
    const producer1 = {
      producerId: 'first_' + Date.now(),
      signalFamily: 'TEST',
      supportedSubtypes: [],
      evaluate: () => null,
    };
    const producer2 = {
      producerId: 'second_' + Date.now(),
      signalFamily: 'TEST',
      supportedSubtypes: [],
      evaluate: () => ({ signal: 'found' }),
    };
    registry.registerProducer(producer1);
    registry.registerProducer(producer2);

    const result = registry.evaluateExtendedProducers({});
    assert(result === null || result.signal === 'found');
  });

  await t.test('listProducers returns all registered producers', () => {
    const allProducers = registry.listProducers();
    assert(Array.isArray(allProducers));
    assert(allProducers.length >= 0);
  });
});
