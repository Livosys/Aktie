'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const modulePath = require.resolve('./candleSnapshotRecorderService');

function loadService() {
  delete require.cache[modulePath];
  return require('./candleSnapshotRecorderService');
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-snapshot-recorder-'));
  const previous = {
    enabled: process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED,
    dir: process.env.CANDLE_SNAPSHOT_RECORDER_DIR,
  };
  process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED = 'true';
  process.env.CANDLE_SNAPSHOT_RECORDER_DIR = dir;
  try {
    return fn({ dir, previous });
  } finally {
    if (previous.enabled === undefined) delete process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED;
    else process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED = previous.enabled;
    if (previous.dir === undefined) delete process.env.CANDLE_SNAPSHOT_RECORDER_DIR;
    else process.env.CANDLE_SNAPSHOT_RECORDER_DIR = previous.dir;
    delete require.cache[modulePath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function testNormalizeCandle() {
  const svc = loadService();
  const normalized = svc.normalizeCandle({
    ts: '2026-06-28T12:00:00.000Z',
    o: 100,
    h: 101,
    l: 99,
    c: 100.5,
    v: 123,
  });
  assert.deepEqual(normalized, {
    candleTime: '2026-06-28T12:00:00.000Z',
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 123,
  });
  assert.equal(svc.normalizeCandle({ ts: '2026-06-28T12:00:00.000Z', o: 100 }), null);
}

function testDisabledModeWritesNothing() {
  const previous = process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED;
  delete process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED;
  delete require.cache[modulePath];
  const svc = require('./candleSnapshotRecorderService');
  const result = svc.recordCandleSnapshots({
    source: 'scanner',
    symbol: 'AAPL',
    timeframe: '2m',
    candles: [{ ts: '2026-06-28T12:00:00.000Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
  });
  assert.equal(result.enabled, false);
  if (previous === undefined) delete process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED;
  else process.env.CANDLE_SNAPSHOT_RECORDER_ENABLED = previous;
}

function testAppendAndDedupe() {
  withTempDir(({ dir }) => {
    const svc = loadService();
    const payload = {
      source: 'scanner',
      symbol: 'AAPL',
      timeframe: '2m',
      candles: [
        { ts: '2026-06-28T12:00:00.000Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
        { ts: '2026-06-28T12:02:00.000Z', o: 1.5, h: 2.1, l: 1.4, c: 2, v: 11 },
      ],
    };
    const first = svc.recordCandleSnapshots(payload);
    assert.equal(first.ok, true);
    assert.equal(first.wrote, 2);
    const filePath = path.join(dir, '2026-06-28', 'candles-2m.jsonl');
    assert.equal(fs.existsSync(filePath), true);
    const rows = readLines(filePath);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].symbol, 'AAPL');
    assert.equal(rows[0].timeframe, '2m');
    assert.equal(rows[0].source, 'scanner');

    const second = svc.recordCandleSnapshots(payload);
    assert.equal(second.wrote, 0);
    assert.equal(second.deduped, 2);
    assert.equal(readLines(filePath).length, 2);
  });
}

function testInvalidCandleIgnored() {
  withTempDir(() => {
    const svc = loadService();
    const result = svc.recordCandleSnapshots({
      source: 'scanner',
      symbol: 'AAPL',
      timeframe: '2m',
      candles: [
        { ts: '2026-06-28T12:00:00.000Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
        { ts: '2026-06-28T12:02:00.000Z', o: 1.5, h: 2.1, l: 1.4 },
      ],
    });
    assert.equal(result.wrote, 1);
    assert.equal(result.invalid, 1);
  });
}

function testWriteErrorDoesNotThrow() {
  withTempDir(({ dir }) => {
    const svc = loadService();
    const originalAppend = fs.appendFileSync;
    fs.appendFileSync = () => {
      throw new Error('simulated write failure');
    };
    try {
      const result = svc.recordCandleSnapshots({
        source: 'scanner',
        symbol: 'AAPL',
        timeframe: '2m',
        candles: [{ ts: '2026-06-28T12:00:00.000Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
      });
      assert.equal(result.ok, false);
      assert.equal(result.enabled, true);
      assert.equal(result.path, path.join(dir, '2026-06-28', 'candles-2m.jsonl'));
    } finally {
      fs.appendFileSync = originalAppend;
    }
  });
}

function testSeparate1mAnd2mFiles() {
  withTempDir(({ dir }) => {
    const svc = loadService();
    svc.recordCandleSnapshots({
      source: 'scanner',
      symbol: 'AAPL',
      timeframe: '1m',
      candles: [{ ts: '2026-06-28T12:00:00.000Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
    });
    svc.recordCandleSnapshots({
      source: 'scanner',
      symbol: 'AAPL',
      timeframe: '2m',
      candles: [{ ts: '2026-06-28T12:00:00.000Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
    });
    assert.equal(fs.existsSync(path.join(dir, '2026-06-28', 'candles-1m.jsonl')), true);
    assert.equal(fs.existsSync(path.join(dir, '2026-06-28', 'candles-2m.jsonl')), true);
  });
}

function testQueueIsBestEffort() {
  withTempDir(() => {
    const svc = loadService();
    const result = svc.queueCandleSnapshots({
      source: 'scanner',
      symbol: 'AAPL',
      timeframe: '2m',
      candles: [{ ts: '2026-06-28T12:00:00.000Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }],
    });
    assert.equal(result.queued, true);
  });
}

function main() {
  testNormalizeCandle();
  testDisabledModeWritesNothing();
  testAppendAndDedupe();
  testInvalidCandleIgnored();
  testWriteErrorDoesNotThrow();
  testSeparate1mAnd2mFiles();
  testQueueIsBestEffort();
  console.log('candleSnapshotRecorderService.test.js: all assertions passed');
}

main();
