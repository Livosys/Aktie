'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('./liveActivityService');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'live-activity-'));
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function appendJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

(async () => {
  const emptyRoot = tmpDir();
  const empty = svc.buildLiveActivity({
    limit: 50,
    files: {
      autopilotHistory: path.join(emptyRoot, 'missing-autopilot.jsonl'),
      learningEvents: path.join(emptyRoot, 'missing-learning.jsonl'),
      aiEvents: path.join(emptyRoot, 'missing-ai.jsonl'),
      batchFile: path.join(emptyRoot, 'missing-batches.json'),
      batchResultsDir: path.join(emptyRoot, 'missing-results'),
      eventLog: path.join(emptyRoot, 'missing-events.jsonl'),
    },
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.count, 0);
  assert.equal(empty.mode, 'paper_only');
  assert.equal(empty.actions_allowed, false);
  assert.equal(empty.can_place_orders, false);
  assert.equal(empty.live_trading_enabled, false);
  assert.equal(empty.broker_enabled, false);

  const root = tmpDir();
  const files = {
    autopilotHistory: path.join(root, 'autopilot.jsonl'),
    learningEvents: path.join(root, 'learning.jsonl'),
    aiEvents: path.join(root, 'ai.jsonl'),
    batchFile: path.join(root, 'batches.json'),
    batchResultsDir: path.join(root, 'results'),
    eventLog: path.join(root, 'events.jsonl'),
  };
  appendJsonl(files.autopilotHistory, [
    { timestamp: '2026-06-01T10:00:00.000Z', event: 'plan_created', planId: 'p1', strategy_id: 'narrow_breakout_v1', symbols: ['MSFT'], timeframes: ['2m'], status: 'planned' },
  ]);
  appendJsonl(files.learningEvents, [
    { event_id: 'l1', source: 'batch', mode: 'batch', strategy_id: 'narrow_breakout_v1', symbol: 'MSFT', timeframe: '2m', paper_pnl_percent: 0.2, timestamp: '2026-06-01T10:02:00.000Z' },
  ]);
  appendJsonl(files.aiEvents, [
    { timestamp: '2026-06-01T10:03:00.000Z', eventType: 'analyst.disabled', provider: 'disabled', status: 'disabled', outputSummary: { summaryPreview: 'AI disabled' } },
  ]);
  writeJson(files.batchFile, [
    { id: 'b1', name: 'Batch 1', status: 'completed', config: { symbols: ['MSFT'], timeframes: ['2m'] }, updated_at: '2026-06-01T10:01:00.000Z', paper_only: true },
  ]);
  writeJson(path.join(files.batchResultsDir, 'b1.json'), [
    { event_id: 'r1', type: 'batch.result', strategy_id: 'narrow_breakout_v1', symbol: 'MSFT', timeframe: '2m', timestamp: '2026-06-01T10:01:30.000Z', paper_pnl_percent: 0.1 },
  ]);
  appendJsonl(files.eventLog, [
    { event_id: 'e1', event_type: 'DATA_BACKFILL_COMPLETED', timestamp: '2026-06-01T09:59:00.000Z', source: 'learning', message: 'Data backfill klar', symbol: 'MSFT' },
  ]);

  const ok = svc.buildLiveActivity({ limit: 3, files });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.count, 3);
  assert.equal(ok.events[0].timestamp, '2026-06-01T10:03:00.000Z');
  assert.equal(ok.events[0].type, 'ai');
  assert.equal(ok.events[0].can_place_orders, false);
  assert.ok(ok.events.some((event) => event.type === 'learning'));
  assert.equal(ok.sources.length, 6);

  const maxed = svc.buildLiveActivity({ limit: 999, files });
  assert.ok(maxed.count <= 200);
  assert.equal(svc._internal.limitFromQuery(999), 200);
  assert.equal(svc._internal.limitFromQuery('bad'), 50);

  const normalized = svc._internal.normalizeEvent({
    timestamp: '2026-06-01T11:00:00.000Z',
    event: 'run_completed',
    strategy_id: 's1',
    symbols: ['QQQ'],
    timeframes: ['2m'],
  }, 'autopilot');
  assert.equal(normalized.type, 'autopilot');
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.paperOnly, true);
  assert.equal(normalized.live_trading_enabled, false);
  // New normalized fields: displayTime, result and Swedish labels.
  assert.equal(normalized.title, 'Test klart');
  assert.ok(typeof normalized.displayTime === 'string' && normalized.displayTime.length > 0);
  assert.ok('result' in normalized);

  const withResult = svc._internal.normalizeEvent({
    timestamp: '2026-06-01T11:05:00.000Z',
    event: 'batch.completed',
    strategy_id: 's2',
    win_rate: 60,
    paper_pnl_percent: 0.4,
  }, 'batch');
  assert.equal(withResult.title, 'Batchtest klart');
  assert.ok(withResult.result.includes('P/L +0.4%'));
  assert.ok(withResult.result.includes('Träff 60%'));
  assert.equal(svc._internal.svLabel('dry_run'), 'Säker testkörning');
  assert.equal(svc._internal.svLabel('unknown_event'), null);
  assert.equal(svc._internal.resultFor({}), null);
  assert.equal(svc._internal.displayTimeFor(null), null);

  const brokenRoot = tmpDir();
  const brokenFiles = {
    autopilotHistory: path.join(brokenRoot, 'autopilot.jsonl'),
    learningEvents: path.join(brokenRoot, 'missing-learning.jsonl'),
    aiEvents: path.join(brokenRoot, 'missing-ai.jsonl'),
    batchFile: path.join(brokenRoot, 'broken-batches.json'),
    batchResultsDir: path.join(brokenRoot, 'missing-results'),
    eventLog: path.join(brokenRoot, 'missing-events.jsonl'),
  };
  fs.writeFileSync(brokenFiles.autopilotHistory, '{"timestamp":"2026-06-01T10:00:00.000Z","event":"plan_created"}\n{broken\n', 'utf8');
  fs.writeFileSync(brokenFiles.batchFile, '{not-json', 'utf8');
  const degraded = svc.buildLiveActivity({ limit: 20, files: brokenFiles });
  assert.equal(degraded.status, 'degraded');
  assert.ok(degraded.warnings.length >= 1);
  assert.equal(degraded.can_place_orders, false);

  console.log('# liveActivityService tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
