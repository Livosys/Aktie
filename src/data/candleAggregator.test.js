'use strict';

const assert = require('assert/strict');

const {
  aggregate1mTo2m,
  filterClosedBars,
  filterComplete,
} = require('./candleAggregator');

function bar(ts, open, close, volume = 100) {
  return {
    ts,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume,
  };
}

function main() {
  const now = '2026-07-13T12:06:30.000Z';
  const bars = [
    bar('2026-07-13T12:00:00.000Z', 100, 100.2),
    bar('2026-07-13T12:01:00.000Z', 100.2, 100.4),
    bar('2026-07-13T12:02:00.000Z', 100.4, 100.6),
    bar('2026-07-13T12:03:00.000Z', 100.6, 100.8),
    bar('2026-07-13T12:04:00.000Z', 100.8, 101.0),
    bar('2026-07-13T12:05:00.000Z', 101.0, 101.2),
    bar('2026-07-13T12:06:00.000Z', 101.2, 101.4),
  ];

  const closedBars = filterClosedBars(bars, { now });
  assert.deepEqual(
    closedBars.map((entry) => entry.ts),
    [
      '2026-07-13T12:00:00.000Z',
      '2026-07-13T12:01:00.000Z',
      '2026-07-13T12:02:00.000Z',
      '2026-07-13T12:03:00.000Z',
      '2026-07-13T12:04:00.000Z',
      '2026-07-13T12:05:00.000Z',
    ],
    'current in-progress 1m bar is excluded before scanner aggregation',
  );

  const candles2m = aggregate1mTo2m(closedBars);
  assert.deepEqual(
    candles2m.map((entry) => [entry.ts, entry.incomplete]),
    [
      ['2026-07-13T12:00:00.000Z', false],
      ['2026-07-13T12:02:00.000Z', false],
      ['2026-07-13T12:04:00.000Z', false],
    ],
    'closed 1m input produces only complete 2m buckets',
  );
  assert.deepEqual(
    filterComplete(candles2m).map((entry) => entry.ts),
    [
      '2026-07-13T12:00:00.000Z',
      '2026-07-13T12:02:00.000Z',
      '2026-07-13T12:04:00.000Z',
    ],
  );

  const earlyNow = '2026-07-13T12:05:30.000Z';
  const earlyClosedBars = filterClosedBars(bars, { now: earlyNow });
  const earlyCandles2m = aggregate1mTo2m(earlyClosedBars);
  assert.deepEqual(
    earlyCandles2m.map((entry) => [entry.ts, entry.incomplete]),
    [
      ['2026-07-13T12:00:00.000Z', false],
      ['2026-07-13T12:02:00.000Z', false],
      ['2026-07-13T12:04:00.000Z', true],
    ],
    'a half-built 2m bucket remains marked incomplete if only one closed 1m bar exists',
  );
  assert.deepEqual(
    filterComplete(earlyCandles2m).map((entry) => entry.ts),
    [
      '2026-07-13T12:00:00.000Z',
      '2026-07-13T12:02:00.000Z',
    ],
    'scanner filterComplete removes half-built 2m buckets from producer inputs',
  );

  console.log('candleAggregator.test.js passed');
}

main();
