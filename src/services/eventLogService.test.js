'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const { createEventLogService } = require('./eventLogService');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-rotation-'));
const dataDir = path.join(tmpRoot, 'events');
const eventsFile = path.join(dataDir, 'trading-events.jsonl');
const archiveDir = path.join(dataDir, 'archive');

const published = [];
const warnings = [];
const rotationTimes = [
  new Date('2026-06-04T08:45:00.000Z'),
  new Date('2026-06-04T08:45:01.000Z'),
  new Date('2026-06-04T08:45:02.000Z'),
];
let rotationTimeIndex = 0;

const service = createEventLogService({
  dataDir,
  eventsFile,
  archiveDir,
  rotationThresholdBytes: 64,
  maxArchives: 2,
  now: () => rotationTimes[Math.min(rotationTimeIndex, rotationTimes.length - 1)],
  kafkaEventProducer: {
    publishEvent(event) {
      published.push(event);
      return Promise.resolve({ ok: true });
    },
    getStatus() {
      return { kafka_enabled: false, kafka_connected: false };
    },
  },
  logger: {
    warn(...args) {
      warnings.push(args.join(' '));
    },
  },
});

function writeOversizedSeed(label) {
  fs.mkdirSync(dataDir, { recursive: true });
  const seed = {
    event_id: `${label}-seed`,
    event_type: 'signal.detected',
    timestamp: '2026-06-04T08:00:00.000Z',
    source: 'scanner',
    symbol: 'MSFT',
    market: 'stocks',
    metadata: { pad: 'x'.repeat(256) },
  };
  fs.writeFileSync(eventsFile, `${JSON.stringify(seed)}\n`, 'utf8');
}

{
  const emptyRead = service.readRecentEvents();
  assert.equal(emptyRead.ok, true, 'empty read ok');
  assert.equal(emptyRead.count, 0, 'empty read count');
  assert.equal(emptyRead.events.length, 0, 'empty read events');

  const appendResult = service.appendEvent({
    event_type: 'signal.detected',
    strategy_id: 'ROTATE_ONE',
    symbol: 'AAPL',
    source: 'scanner',
    timestamp: '2026-06-04T08:45:00.000Z',
  });
  assert.equal(appendResult.ok, true, 'initial append ok');
  assert.equal(published.length, 1, 'initial append published');
  assert.ok(fs.existsSync(eventsFile), 'events file created');

  const initialRead = service.readRecentEvents();
  assert.equal(initialRead.ok, true, 'initial read ok');
  assert.equal(initialRead.count, 1, 'initial read count');
  assert.equal(initialRead.events[0].strategy, 'ROTATE_ONE', 'initial read latest event');
}

for (let i = 0; i < 3; i += 1) {
  writeOversizedSeed(`rotation-${i}`);
  rotationTimeIndex = i;
  const result = service.appendEvent({
    event_type: 'signal.detected',
    strategy_id: `ROTATE_${i}`,
    symbol: 'MSFT',
    source: 'scanner',
    timestamp: rotationTimes[i].toISOString(),
  });
  assert.equal(result.ok, true, `rotation ${i}: append ok`);
}

{
  const archives = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((name) => name.startsWith('trading-events-') && name.endsWith('.jsonl'))
    : [];

  assert.equal(archives.length, 2, 'retains latest two archives');
  assert.ok(fs.existsSync(eventsFile), 'events file recreated after rotation');

  const current = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(current.length, 1, 'current file has latest event only');
  assert.equal(current[0].strategy, 'ROTATE_2', 'current file latest strategy');

  const recent = service.readRecentEvents();
  assert.equal(recent.ok, true, 'post-rotation read ok');
  assert.equal(recent.count, 1, 'post-rotation read count');
  assert.equal(recent.events[0].strategy, 'ROTATE_2', 'post-rotation latest event');
  assert.equal(warnings.length, 0, 'no warnings on successful rotation');
}

console.log('Event log rotation tests passed.');
