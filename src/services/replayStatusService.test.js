'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./replayStatusService');

function writeRun(runsDir, runId, summary) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary), 'utf8');
}

(async () => {
  // ── empty: no runs dir ──────────────────────────────────────────────────────
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-empty-'));
  const empty = svc.buildReplayStatus({ runsDir: path.join(emptyDir, 'missing') });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.emptyReason, 'no_replay_runs');
  assert.equal(empty.totalReplayTests, 0);
  assert.equal(empty.latestReplay, null);

  // safety flags are always present and locked off
  for (const s of [empty]) {
    assert.equal(s.mode, 'paper_only');
    assert.equal(s.actions_allowed, false);
    assert.equal(s.can_place_orders, false);
    assert.equal(s.live_trading_enabled, false);
    assert.equal(s.broker_enabled, false);
  }

  // ── ok: two runs, newest-first selection ────────────────────────────────────
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-runs-'));
  writeRun(runsDir, 'run_aaa_001', {
    runId: 'run_aaa_001',
    start: '2026-05-15',
    end: '2026-05-17',
    symbols: ['AAPL'],
    mode: 'scan_only',
    totalCandles: 199,
    totalEvents: 2,
    avgTradeScore: 59,
    signalsByType: { LONG_WATCH: 2 },
    bestSymbols: [{ symbol: 'AAPL', avgScore: 59, events: 2 }],
    worstSymbols: [{ symbol: 'AAPL', avgScore: 59, events: 2 }],
    createdAt: '2026-05-18T07:19:59.664Z',
  });
  writeRun(runsDir, 'run_zzz_999', {
    runId: 'run_zzz_999',
    start: '2026-06-05',
    end: '2026-06-06',
    symbols: ['NVDA', 'TSLA', 'QQQ'],
    mode: 'scan_only',
    totalCandles: 1574,
    totalEvents: 47,
    avgTradeScore: 54.1,
    signalsByType: { SHORT_WATCH: 22, LONG_WATCH: 20 },
    bestSymbols: [{ symbol: 'QQQ', avgScore: 68, events: 1 }],
    worstSymbols: [{ symbol: 'AAPL', avgScore: 50, events: 10 }],
    createdAt: '2026-06-06T08:06:16.289Z',
  });

  const ok = svc.buildReplayStatus({ runsDir });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.totalReplayTests, 2);
  // listRunIds sorts reverse → run_zzz_999 is newest
  assert.equal(ok.latestReplay.runId, 'run_zzz_999');
  assert.equal(ok.latestReplay.timeframe, '2m');
  assert.equal(ok.latestReplay.replayMode, 'scan_only');
  assert.equal(ok.latestReplay.totalEvents, 47);
  assert.equal(ok.latestResult.avgTradeScore, 54.1);
  assert.equal(ok.latestResult.bestSymbol.symbol, 'QQQ');
  assert.deepEqual(ok.timeframes, ['2m']);
  assert.equal(ok.earliestPeriod, '2026-05-15');
  assert.equal(ok.latestPeriod, '2026-06-06');
  assert.ok(ok.symbols.includes('AAPL') && ok.symbols.includes('NVDA'));
  assert.ok(ok.summary && typeof ok.summary === 'object');
  assert.equal(ok.summary.status, 'ok');
  assert.equal(ok.summary.replayCount, 2);
  assert.equal(ok.summary.latestRunId, 'run_zzz_999');
  assert.equal(ok.summary.latestTimeframe, '2m');
  // never trades
  assert.equal(ok.can_place_orders, false);
  assert.equal(ok.live_trading_enabled, false);
  assert.equal(ok.broker_enabled, false);

  // ── degraded: unreadable summary alongside good ones ────────────────────────
  const badDir = path.join(runsDir, 'run_bad_000');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'summary.json'), '{ not valid json', 'utf8');
  const degraded = svc.buildReplayStatus({ runsDir });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.unreadableRuns, 1);
  assert.equal(degraded.totalReplayTests, 2);
  assert.equal(degraded.emptyReason, 'replay_runs_degraded');
  assert.equal(degraded.summary.status, 'degraded');
  assert.equal(degraded.summary.replayCount, 2);

  // ── supervisor summary mirrors latest + safety ──────────────────────────────
  const sup = svc.buildSupervisorReplaySummary({ runsDir });
  assert.equal(sup.totalReplayTests, 2);
  assert.equal(sup.latestReplay.runId, 'run_zzz_999');
  assert.equal(sup.broker_enabled, false);
  assert.deepEqual(sup.timeframes, ['2m']);
  assert.equal(sup.summary.replayCount, 2);
  assert.equal(sup.summary.latestRunId, 'run_zzz_999');

  // cleanup
  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(runsDir, { recursive: true, force: true });

  console.log('replayStatusService.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
