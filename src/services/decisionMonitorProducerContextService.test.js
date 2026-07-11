'use strict';

const assert = require('assert/strict');

const svc = require('./decisionMonitorProducerContextService');

function main() {
  const stockSnapshots = new Map();
  const cryptoSnapshots = new Map();
  const stockReader = (symbol, timeframe) => stockSnapshots.get(`${symbol}:${timeframe}`) || null;
  const cryptoReader = (symbol, timeframe) => cryptoSnapshots.get(`${symbol}:${timeframe}`) || null;

  stockSnapshots.set('AAPL:1m', {
    symbol: 'AAPL',
    marketType: 'stock',
    timeframe: '1m',
    sourceName: 'stock_1m_fixture',
    updatedAt: '2026-07-11T18:05:00.000Z',
    candles: [
      { timestamp: '2026-07-11T18:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5, volume: 100 },
      { timestamp: '2026-07-11T18:01:00.000Z', open: 100.5, high: 101.2, low: 100.3, close: 101, volume: 120 },
      { timestamp: '2026-07-11T18:02:00.000Z', open: 101, high: 101.4, low: 100.8, close: 101.2, volume: 80 },
    ],
  });

  const from1m = svc.readLiveCandleDebug({
    symbol: 'AAPL',
    marketType: 'stock',
    timeframe: '2m',
    limit: 5,
    stockReader,
    cryptoReader,
    now: new Date('2026-07-11T18:05:00.000Z'),
  });

  assert.equal(from1m.ok, true);
  assert.equal(from1m.source, 'stock_1m_fixture_aggregated_to_2m');
  assert.equal(from1m.candles.length, 1, 'incomplete final 1m bucket is filtered out');
  assert.equal(from1m.latestTimestamp, '2026-07-11T18:00:00.000Z');
  assert.equal(from1m.dataAgeSeconds, 300);

  cryptoSnapshots.set('BTCUSDT:2m', {
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    timeframe: '2m',
    sourceName: 'crypto_2m_fixture',
    updatedAt: '2026-07-11T18:05:00.000Z',
    candles: [
      { timestamp: '2026-07-11T18:00:00.000Z', open: 100, high: 101, low: 99, close: 100.8, volume: 1000 },
      { timestamp: '2026-07-11T18:02:00.000Z', open: 100.8, high: 101.5, low: 100.7, close: 101.2, volume: 1300 },
    ],
  });

  const map = svc.buildLiveCandleDebugMap([
    { symbol: 'AAPL', _market: 'stock' },
    { symbol: 'BTCUSDT', _market: 'crypto' },
  ], { stockReader, cryptoReader }, { now: new Date('2026-07-11T18:05:00.000Z') });

  assert.equal(map.AAPL.ok, true);
  assert.equal(map.BTCUSDT.ok, true);
  assert.equal(map.BTCUSDT.source, 'crypto_2m_fixture');

  console.log('decisionMonitorProducerContextService.test.js passed');
}

main();
