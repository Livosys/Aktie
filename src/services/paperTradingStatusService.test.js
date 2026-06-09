'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./paperTradingStatusService');

function writeTrades(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function assertSafety(obj) {
  assert.equal(obj.mode, 'paper_only');
  assert.equal(obj.actions_allowed, false);
  assert.equal(obj.can_place_orders, false);
  assert.equal(obj.live_trading_enabled, false);
  assert.equal(obj.broker_enabled, false);
}

(async () => {
  // ── empty: missing file → empty, never crash ────────────────────────────────
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-empty-'));
  const empty = svc.buildPaperTradingStatus({ tradesFile: path.join(emptyDir, 'missing.jsonl') });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.emptyReason, 'no_paper_trades');
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.recentPaperTrades, []);
  assert.deepEqual(empty.latestPaperTrade, {});
  assertSafety(empty);
  assertSafety(empty.summary);
  assert.ok(empty.allowlist && typeof empty.allowlist === 'object');
  assert.equal(empty.summary.latestPaperTradeId, null);
  assert.ok(typeof empty.summary.allowlistApprovedCount === 'number');

  // ── ok: real-shaped trades, newest-first selection + normalization ──────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-runs-'));
  const file = path.join(dir, 'trades.jsonl');
  writeTrades(file, [
    {
      tradeId: 'pt_old_001', symbol: 'AAPL', marketType: 'stocks', direction: 'UP',
      entryTime: '2026-05-30T13:00:00.000Z', entryPrice: 100,
      entryReasonSv: 'VWAP-återtagning med stark volym.',
      signalFamily: 'VWAP_RECLAIM_REJECTION', signalSubtype: 'VWAP_RECLAIM_UP',
      strategy_id: 'vwap_volume_breakout_long', strategyName: 'VWAP Volume Breakout Long',
      exitTime: '2026-05-30T13:10:00.000Z', exitPrice: 100.4, exitReason: 'TARGET_HIT',
      pnlPct: 0.4, result: 'WIN', mode: 'paper',
    },
    {
      tradeId: 'pt_new_002', symbol: 'BTCUSDT', marketType: 'crypto', direction: 'UP',
      entryTime: '2026-06-01T17:51:00.000Z', entryPrice: 71779,
      entryReasonSv: 'Rörelsen har gått en bit. Bevaka rekyl.',
      signalFamily: 'VWAP_RECLAIM_REJECTION', signalSubtype: 'VWAP_RECLAIM_UP',
      strategy_id: 'vwap_volume_breakout_long', strategyName: 'VWAP Volume Breakout Long',
      exitTime: '2026-06-01T17:59:00.000Z', exitPrice: 71643, exitReason: 'STOP_HIT',
      pnlPct: -0.19, result: 'LOSS', mode: 'paper',
    },
  ]);

  const ok = svc.buildPaperTradingStatus({ tradesFile: file });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.emptyReason, null);
  assert.equal(ok.count, 2);
  // newest-first: BTCUSDT (Jun 1) before AAPL (May 30)
  assert.equal(ok.latestPaperTrade.id, 'pt_new_002');
  assert.equal(ok.recentPaperTrades[0].symbol, 'BTCUSDT');
  assert.equal(ok.recentPaperTrades[1].symbol, 'AAPL');

  const latest = ok.latestPaperTrade;
  assert.equal(latest.status, 'completed');
  assert.equal(latest.timeframe, '2m');
  assert.equal(latest.strategyLabel, 'VWAP Volume Breakout Long');
  assert.equal(latest.result, 'LOSS');
  assert.equal(latest.pnl, -0.19);
  assert.equal(latest.exitReason, 'STOP_HIT');
  assert.ok(latest.entryReason && latest.entryReason.length > 0);
  assert.ok(/stopp/i.test(latest.lesson)); // loss + STOP_HIT
  assert.equal(latest.winRate, null);
  assert.equal(latest.paperOnly, true);
  assertSafety(latest);

  // win row derives a target lesson
  const winRow = ok.recentPaperTrades.find((t) => t.id === 'pt_old_001');
  assert.ok(/mål/i.test(winRow.lesson));

  // summary mirrors tradeStatsService math
  assert.equal(ok.summary.totalTrades, 2);
  assert.equal(ok.summary.win, 1);
  assert.equal(ok.summary.loss, 1);
  assert.equal(ok.summary.winRate, 50);
  assert.ok(ok.summary.avgPnl !== null);
  assert.ok(ok.summary.bestStrategy && ok.summary.bestStrategy.strategy === 'vwap_volume_breakout_long');
  assert.ok(ok.allowlist && typeof ok.allowlist === 'object');
  assert.equal(ok.summary.latestPaperTradeId, 'pt_new_002');
  assert.ok(typeof ok.summary.allowlistApprovedCount === 'number');
  assert.ok(typeof ok.summary.allowlistRejectedCount === 'number');
  assertSafety(ok);
  assertSafety(ok.summary);

  // ── open trade → status 'simulated' ─────────────────────────────────────────
  const openFile = path.join(dir, 'open.jsonl');
  writeTrades(openFile, [
    { tradeId: 'pt_open_1', symbol: 'QQQ', entryTime: '2026-06-02T14:00:00.000Z', entryPrice: 400, entryReasonSv: 'Test', mode: 'paper' },
  ]);
  const openStatus = svc.buildPaperTradingStatus({ tradesFile: openFile });
  assert.equal(openStatus.recentPaperTrades[0].status, 'simulated');

  // ── corrupt lines are skipped, valid ones survive (no crash) ────────────────
  const mixedFile = path.join(dir, 'mixed.jsonl');
  fs.writeFileSync(mixedFile, '{not json\n' + JSON.stringify({ tradeId: 'pt_ok', symbol: 'MSFT', entryTime: '2026-06-03T10:00:00.000Z', exitTime: '2026-06-03T10:05:00.000Z', result: 'WIN', pnlPct: 0.3, mode: 'paper' }) + '\n', 'utf8');
  const mixed = svc.buildPaperTradingStatus({ tradesFile: mixedFile });
  assert.equal(mixed.status, 'ok');
  assert.equal(mixed.count, 1);

  // ── supervisor summary mirrors latest + safety, no full list ────────────────
  const sup = svc.buildSupervisorPaperSummary({ tradesFile: file });
  assert.equal(sup.count, 2);
  assert.equal(sup.latestPaperTrade.id, 'pt_new_002');
  assert.equal(sup.summary.winRate, 50);
  assert.equal(sup.recentPaperTrades, undefined);
  assert.ok(sup.allowlist && typeof sup.allowlist === 'object');
  assert.ok(sup.summary.latestPaperTradeId === 'pt_new_002');
  assertSafety(sup);

  // empty supervisor summary → latestPaperTrade null, not crash
  const supEmpty = svc.buildSupervisorPaperSummary({ tradesFile: path.join(emptyDir, 'missing.jsonl') });
  assert.equal(supEmpty.latestPaperTrade, null);
  assert.equal(supEmpty.count, 0);
  assert.equal(supEmpty.emptyReason, 'no_paper_trades');
  assertSafety(supEmpty);

  // cleanup
  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('paperTradingStatusService.test.js: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
