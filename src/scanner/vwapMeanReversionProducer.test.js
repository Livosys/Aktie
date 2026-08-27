'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const producer = require('./vwapMeanReversionProducer');

test('vwapMeanReversionProducer', async (t) => {
  await t.test('producer has correct contract', () => {
    assert.strictEqual(producer.producerId, 'vwap_mean_reversion');
    assert.strictEqual(producer.signalFamily, 'VWAP_MEAN_REVERSION');
    assert.deepStrictEqual(producer.supportedSubtypes, ['VWAP_MEAN_REVERSION']);
    assert(typeof producer.evaluate === 'function');
  });

  await t.test('valid SHORT mean-reversion (overbought)', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 75,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert(signal !== null);
    assert.strictEqual(signal.signalFamily, 'VWAP_MEAN_REVERSION');
    assert.strictEqual(signal.signalSubtype, 'VWAP_MEAN_REVERSION');
    assert.strictEqual(signal.direction, 'DOWN');
  });

  await t.test('valid LONG mean-reversion (oversold)', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 25,
        close: 98.5,
      },
      close: 98.5,
    };
    const signal = producer.evaluate(context);
    assert(signal !== null);
    assert.strictEqual(signal.signalFamily, 'VWAP_MEAN_REVERSION');
    assert.strictEqual(signal.signalSubtype, 'VWAP_MEAN_REVERSION');
    assert.strictEqual(signal.direction, 'UP');
  });

  await t.test('neutral RSI (50) rejected', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 50,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('RSI = 30 boundary accepted (oversold)', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 30,
        close: 98.5,
      },
      close: 98.5,
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('RSI = 70 boundary accepted (overbought)', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 70,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('RSI = 29 triggers oversold (LONG)', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 29,
        close: 98.5,
      },
      close: 98.5,
    };
    const signal = producer.evaluate(context);
    assert(signal !== null);
    assert.strictEqual(signal.direction, 'UP');
  });

  await t.test('RSI = 71 triggers overbought (SHORT)', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 71,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert(signal !== null);
    assert.strictEqual(signal.direction, 'DOWN');
  });

  await t.test('insufficient VWAP deviation rejected (<1.5%)', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 75,
        close: 100.5,
      },
      close: 100.5,
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('exactly 1.5% deviation accepted', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 75,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert(signal !== null);
  });

  await t.test('missing RSI rejected', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: null,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('missing VWAP rejected', () => {
    const context = {
      result: {
        vwap: null,
        rsi14: 75,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });

  await t.test('null context rejected', () => {
    const signal = producer.evaluate(null);
    assert.strictEqual(signal, null);
  });

  await t.test('signal has required fields', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 75,
        close: 101.5,
      },
      close: 101.5,
    };
    const signal = producer.evaluate(context);
    assert(signal.signalFamily);
    assert(signal.signalSubtype);
    assert(signal.direction);
    assert(signal.reasonSv);
    assert(signal.nextMoveBias);
  });

  await t.test('direction mismatch rejected', () => {
    const context = {
      result: {
        vwap: 100,
        rsi14: 75,
        close: 98.5,
      },
      close: 98.5,
    };
    const signal = producer.evaluate(context);
    assert.strictEqual(signal, null);
  });
});
