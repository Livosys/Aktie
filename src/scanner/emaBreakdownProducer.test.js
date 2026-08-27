'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const producer = require('./emaBreakdownProducer');

test('emaBreakdownProducer', async (t) => {
  await t.test('producer has correct contract', () => {
    assert.strictEqual(producer.producerId, 'ema_breakdown');
    assert.strictEqual(producer.signalFamily, 'EMA_BREAKDOWN');
    assert.deepStrictEqual(producer.supportedSubtypes, ['EMA_BREAKDOWN_DOWN']);
    assert(typeof producer.evaluate === 'function');
  });

  await t.test('valid EMA breakdown produces EMA_BREAKDOWN_DOWN', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert(signal !== null);
    assert.strictEqual(signal.signalFamily, 'EMA_BREAKDOWN');
    assert.strictEqual(signal.signalSubtype, 'EMA_BREAKDOWN_DOWN');
    assert.strictEqual(signal.direction, 'DOWN');
  });

  await t.test('price above EMA21 rejected', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: 101,
      },
      price: 101,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('price equal to EMA21 rejected', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: 100,
      },
      price: 100,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('EMA stack not broken (no downtrend) rejected', () => {
    const context = {
      result: {
        ema9: 102,
        ema21: 100,
        ema50: 98,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('bullish bias (UP) rejected', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'UP',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('neutral bias rejected', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'NEUTRAL',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('missing EMA9 with valid stack (EMA21 < EMA50) accepted', () => {
    const context = {
      result: {
        ema9: null,
        ema21: 100,
        ema50: 102,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert(signal !== null);
  });

  await t.test('missing EMA21 rejected', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: null,
        ema50: 102,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('missing EMA50 rejected', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: null,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('missing price/close rejected', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: null,
      },
      price: null,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('null context rejected', () => {
    const signal = producer.evaluate(null);
    assert.strictEqual(signal, null);
  });

  await t.test('non-object context rejected', () => {
    const signal = producer.evaluate('not an object');
    assert.strictEqual(signal, null);
  });

  await t.test('direction always SHORT', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal.direction, 'DOWN');
  });

  await t.test('signal has required fields', () => {
    const context = {
      result: {
        ema9: 98,
        ema21: 100,
        ema50: 102,
        close: 99,
      },
      price: 99,
      nextMoveBias: 'DOWN',
    };
    const signal = producer.evaluate(context);
    assert(signal.signalFamily);
    assert(signal.signalSubtype);
    assert(signal.direction);
    assert(signal.reasonSv);
    assert(signal.nextMoveBias);
  });
});
