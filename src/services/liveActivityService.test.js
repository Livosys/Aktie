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
      replayRunsDir: path.join(emptyRoot, 'missing-replay-runs'),
      paperTradesFile: path.join(emptyRoot, 'missing-paper-trades.jsonl'),
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
    replayRunsDir: path.join(root, 'replay-runs'),
    paperTradesFile: path.join(root, 'paper-trades.jsonl'),
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
  // Replay run summary — read-only source. Dated earliest so feed ordering is stable.
  writeJson(path.join(files.replayRunsDir, 'run_test_001', 'summary.json'), {
    runId: 'run_test_001', start: '2026-05-30', end: '2026-06-01', symbols: ['MSFT', 'QQQ'],
    mode: 'scan_only', totalCandles: 200, totalEvents: 5, avgTradeScore: 57,
    bestSymbols: [{ symbol: 'QQQ', avgScore: 62, events: 2 }], createdAt: '2026-06-01T09:58:00.000Z',
  });
  // Finished paper trade — read-only source. Dated earliest so feed ordering is stable.
  appendJsonl(files.paperTradesFile, [
    { tradeId: 'pt_test_1', symbol: 'MSFT', strategy_id: 'vwap_volume_breakout_long', strategyName: 'VWAP Volume Breakout Long', entryTime: '2026-06-01T09:50:00.000Z', exitTime: '2026-06-01T09:57:00.000Z', entryReasonSv: 'VWAP-test', exitReason: 'TARGET_HIT', pnlPct: 0.4, result: 'WIN', mode: 'paper' },
  ]);

  const ok = svc.buildLiveActivity({ limit: 3, files });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.count, 3);
  // The newest finished paper trade is pinned to the very top of the feed.
  assert.equal(ok.events[0].type, 'paper');
  assert.equal(ok.events[0].pinned, true);
  assert.equal(ok.events[0].timestamp, '2026-06-01T09:57:00.000Z');
  assert.equal(ok.events[0].can_place_orders, false);
  // The rest of the feed still follows newest-first below the pin.
  assert.ok(ok.events.some((event) => event.type === 'ai'));
  assert.ok(ok.events.some((event) => event.type === 'learning'));
  assert.equal(ok.sources.length, 8);
  assert.ok(ok.summary && typeof ok.summary === 'object');
  assert.equal(ok.summary.totalEvents, 3);
  assert.equal(ok.summary.sourceCount, 8);
  assert.equal(ok.summary.pinnedPaperCount, 1);
  assert.ok(ok.summary.countsBySource.paper >= 1);
  assert.ok(Array.isArray(ok.summary.sourceBreakdown));
  // Replay run summaries surface as read-only "Replaytest klart" events.
  const replaySource = ok.sources.find((s) => s.name === 'replay');
  assert.ok(replaySource && replaySource.count === 1);
  const allEvents = svc.buildLiveActivity({ limit: 50, files }).events;
  const replayEvent = allEvents.find((e) => e.type === 'replay');
  assert.ok(replayEvent && replayEvent.title === 'Replaytest klart');
  assert.equal(replayEvent.can_place_orders, false);
  assert.equal(replayEvent.timeframe, '2m');
  // Finished paper trades surface as read-only "Låtsastest klart" events.
  const paperSource = ok.sources.find((s) => s.name === 'paper');
  assert.ok(paperSource && paperSource.count === 1);
  const paperEvent = allEvents.find((e) => e.type === 'paper');
  assert.ok(paperEvent && paperEvent.title === 'Låtsastest klart');
  assert.equal(paperEvent.symbol, 'MSFT');
  assert.equal(paperEvent.timeframe, '2m');
  assert.equal(paperEvent.can_place_orders, false);
  assert.equal(paperEvent.paperOnly, true);
  assert.equal(paperEvent.pinned, true);
  assert.equal(allEvents[0].type, 'paper'); // pinned to the very top
  assert.ok(paperEvent.result && paperEvent.result.includes('P/L +0.4%'));
  const overviewSummary = svc.buildSupervisorLiveActivitySummary({ files, limit: 50, eventLimit: 5 });
  assert.ok(overviewSummary.summary && typeof overviewSummary.summary === 'object');
  assert.ok(overviewSummary.count >= 7);
  assert.equal(overviewSummary.summary.totalEvents, overviewSummary.count);
  assert.ok(Array.isArray(overviewSummary.sourceBreakdown));
  assert.ok(overviewSummary.latestEvents.length <= 5);
  assert.equal(overviewSummary.latestEvents[0].type, 'paper');
  assert.equal(typeof overviewSummary.message, 'string');

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
    replayRunsDir: path.join(brokenRoot, 'missing-replay-runs'),
    paperTradesFile: path.join(brokenRoot, 'missing-paper-trades.jsonl'),
    eventLog: path.join(brokenRoot, 'missing-events.jsonl'),
  };
  fs.writeFileSync(brokenFiles.autopilotHistory, '{"timestamp":"2026-06-01T10:00:00.000Z","event":"plan_created"}\n{broken\n', 'utf8');
  fs.writeFileSync(brokenFiles.batchFile, '{not-json', 'utf8');
  const degraded = svc.buildLiveActivity({ limit: 20, files: brokenFiles });
  assert.equal(degraded.status, 'degraded');
  assert.ok(degraded.warnings.length >= 1);
  assert.equal(degraded.can_place_orders, false);
  assert.ok(degraded.summary && degraded.summary.status === 'degraded');
  assert.ok(Array.isArray(degraded.summary.warnings));

  // ── pinPaperTrades: newest paper trades are pinned to the top of the feed ────
  const mk = (id, ts, source) => ({ id, timestamp: ts, type: source === 'paper' ? 'paper' : 'system', source });
  // 5 newest = non-paper; 2 paper trades are older and would be buried by time.
  const synthetic = [
    mk('s1', '2026-06-06T10:00:00.000Z', 'system_events'),
    mk('s2', '2026-06-06T09:00:00.000Z', 'system_events'),
    mk('s3', '2026-06-06T08:00:00.000Z', 'system_events'),
    mk('s4', '2026-06-06T07:00:00.000Z', 'system_events'),
    mk('s5', '2026-06-06T06:00:00.000Z', 'system_events'),
    mk('p1', '2026-06-01T17:00:00.000Z', 'paper'),
    mk('p2', '2026-06-01T16:00:00.000Z', 'paper'),
  ];
  const pinnedFeed = svc._internal.pinPaperTrades(synthetic, 5);
  assert.equal(pinnedFeed.length, 5);
  // The two newest paper trades are pinned to the very top, newest-first, flagged.
  assert.equal(pinnedFeed[0].id, 'p1');
  assert.equal(pinnedFeed[0].pinned, true);
  assert.equal(pinnedFeed[1].id, 'p2');
  assert.equal(pinnedFeed[1].pinned, true);
  // The rest below the pins stays newest-first and is never duplicated.
  assert.equal(pinnedFeed[2].id, 's1');
  assert.equal(pinnedFeed.filter((e) => e.id === 'p1').length, 1);
  // Pins never dominate a small feed (at most half the slots).
  const tiny = svc._internal.pinPaperTrades(synthetic, 2);
  assert.equal(tiny.filter((e) => e.pinned).length, 1);
  assert.equal(tiny[0].id, 'p1');
  // No paper trades → feed returned untouched, newest-first.
  const noPaper = svc._internal.pinPaperTrades([mk('a', '2026-06-06T10:00:00.000Z', 'ai')], 5);
  assert.equal(noPaper[0].id, 'a');
  assert.ok(!noPaper[0].pinned);

  console.log('# liveActivityService tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
