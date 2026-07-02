'use strict';

// Read-only test for regularPullbackExitResearchService. Writes ONLY to an
// isolated os.tmpdir() fixture, never to repo data, never touches exit/trading.
// Run: node <thisfile>

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('./regularPullbackExitResearchService');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err.message}`); process.exitCode = 1; }
}

// ---- fixtures ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-exit-'));
const tradesFile = path.join(dir, 'trades.jsonl');
const candleRoot = path.join(dir, 'candle-snapshots');

const trades = [
  // S1: stop_hit REGULAR_PULLBACK, candle-MATCHED, never green
  { tradeId: 'S1', symbol: 'TSLA', marketType: 'stocks', direction: 'UP', signalSubtype: 'REGULAR_PULLBACK',
    paperOnly: true, result: 'LOSS', pnlPct: -0.20, duration_seconds: 170, entryPrice: 100,
    maxFavorablePct: -0.01, maxAdversePct: -0.20, exitReason: 'STOP_HIT',
    entryTime: '2026-06-29T14:00:10.000Z', exitTime: '2026-06-29T14:03:00.000Z' },
  // S2: stop_hit REGULAR_PULLBACK, UNMATCHED (old date, no candles)
  { tradeId: 'S2', symbol: 'TSLA', marketType: 'stocks', direction: 'DOWN', signalSubtype: 'REGULAR_PULLBACK',
    paperOnly: true, result: 'LOSS', pnlPct: -0.22, duration_seconds: 300, entryPrice: 90,
    maxFavorablePct: -0.03, maxAdversePct: -0.22, exitReason: 'STOP_HIT',
    entryTime: '2026-05-01T14:00:00.000Z', exitTime: '2026-05-01T14:05:00.000Z' },
  // S3: stop_hit REGULAR_PULLBACK, UNMATCHED (old date) -> pushes coverage < 60%
  { tradeId: 'S3', symbol: 'SOLUSDT', marketType: 'crypto', direction: 'DOWN', signalSubtype: 'REGULAR_PULLBACK',
    paperOnly: true, result: 'LOSS', pnlPct: -0.25, duration_seconds: 240, entryPrice: 10,
    maxFavorablePct: -0.05, maxAdversePct: -0.25, exitReason: 'STOP_HIT',
    entryTime: '2026-05-02T14:00:00.000Z', exitTime: '2026-05-02T14:04:00.000Z' },
  // T1: target_hit REGULAR_PULLBACK, candle-MATCHED, clean early winner
  { tradeId: 'T1', symbol: 'AMD', marketType: 'stocks', direction: 'UP', signalSubtype: 'REGULAR_PULLBACK',
    paperOnly: true, result: 'WIN', pnlPct: 0.25, duration_seconds: 110, entryPrice: 200,
    maxFavorablePct: 0.30, maxAdversePct: -0.02, exitReasonCode: 'target_hit',
    entryTime: '2026-06-29T14:00:10.000Z', exitTime: '2026-06-29T14:02:00.000Z' },
  // N1: NOT a REGULAR_PULLBACK -> must be excluded from population
  { tradeId: 'N1', symbol: 'QQQ', marketType: 'stocks', direction: 'UP', signalSubtype: 'NARROW_WAIT',
    paperOnly: true, result: 'WIN', pnlPct: 0.10, duration_seconds: 120, entryPrice: 400,
    exitReasonCode: 'target_hit', entryTime: '2026-06-29T14:00:00.000Z', exitTime: '2026-06-29T14:02:00.000Z' },
];
fs.writeFileSync(tradesFile, trades.map((t) => JSON.stringify(t)).join('\n') + '\n');

fs.mkdirSync(path.join(candleRoot, '2026-06-29'), { recursive: true });
const candles = [
  // TSLA (S1): favorable excursion tiny (<0.03) -> variant 1 aborts
  { symbol: 'TSLA', candleTime: '2026-06-29T14:00:00.000Z', open: 100, high: 100.02, low: 99.70, close: 99.90 },
  { symbol: 'TSLA', candleTime: '2026-06-29T14:01:00.000Z', open: 99.90, high: 99.95, low: 99.60, close: 99.70 },
  // AMD (T1): strong early favorable (>=0.05) -> abort must NOT fire, winner kept
  { symbol: 'AMD', candleTime: '2026-06-29T14:00:00.000Z', open: 200, high: 200.10, low: 199.90, close: 200.08 },
  { symbol: 'AMD', candleTime: '2026-06-29T14:01:00.000Z', open: 200.08, high: 200.20, low: 200.00, close: 200.15 },
];
fs.writeFileSync(path.join(candleRoot, '2026-06-29', 'candles-1m.jsonl'), candles.map((c) => JSON.stringify(c)).join('\n') + '\n');

const res = svc.buildRegularPullbackExitResearch({
  tradesFile, candleStorageRoot: candleRoot, now: '2026-06-29T15:00:00.000Z', cache: false,
});

check('payload is paper-only and read-only', () => {
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.mode, 'paper_only');
  assert.strictEqual(res.safety.read_only, true);
  assert.strictEqual(res.safety.can_place_orders, false);
  assert.strictEqual(res.safety.live_trading_enabled, false);
  assert.ok(/research only/i.test(res.note));
});

check('population = REGULAR_PULLBACK only (NARROW_WAIT excluded)', () => {
  assert.strictEqual(res.regularPullback.overview.n, 4); // S1,S2,S3,T1
  assert.strictEqual(res.regularPullback.overview.stopHit.n, 3);
  assert.strictEqual(res.regularPullback.overview.targetHit.n, 1);
});

check('buckets carry normalized codes with per-bucket stats', () => {
  const codes = res.regularPullback.buckets.map((b) => b.code);
  assert.ok(codes.includes('stop_hit'));
  assert.ok(codes.includes('target_hit'));
  const stop = res.regularPullback.buckets.find((b) => b.code === 'stop_hit');
  assert.strictEqual(stop.n, 3);
  assert.strictEqual(stop.winrate, 0); // stop_hit never wins
});

check('stopHitDiagnostics: never-green %, coverage, splits', () => {
  const d = res.regularPullback.stopHitDiagnostics;
  assert.strictEqual(d.n, 3);
  assert.strictEqual(d.pctNeverGreen, 100); // all three have maxFavorablePct <= 0
  assert.strictEqual(d.candleCoverage.matched, 1); // only S1 matched
  assert.strictEqual(d.candleCoverage.total, 3);
  assert.ok(d.byAsset.crypto.n >= 1 && d.byAsset['stock/ETF'].n >= 1);
  assert.ok(Array.isArray(d.topSymbols) && d.topSymbols.length >= 1);
});

check('timeAbort flagged NOT patch-ready + insufficient coverage', () => {
  const ta = res.regularPullback.timeAbort;
  assert.strictEqual(ta.patchReady, false);
  assert.strictEqual(ta.status, 'insufficient_coverage'); // 2 matched of 4 = 50% < 60
  assert.strictEqual(ta.coverage.stopHitMatched, 1);
  assert.strictEqual(ta.coverage.targetHitMatched, 1);
  assert.strictEqual(ta.variants.length, 2);
});

check('variant 1 reduces the matched stop_hit loss (research signal)', () => {
  const v1 = res.regularPullback.timeAbort.variants.find((v) => v.id === 'mfe_lt_0_03_by_1');
  // S1 recorded -0.20; abort-at-close(99.90) = -0.10 -> improvement +0.10
  assert.ok(Number.isFinite(v1.stopHitImprovement));
  assert.ok(v1.stopHitImprovement > 0, `expected >0, got ${v1.stopHitImprovement}`);
});

check('target_hit winner is NOT hurt by the abort', () => {
  for (const v of res.regularPullback.timeAbort.variants) {
    assert.strictEqual(v.targetHitWinnersHurt, 0, `variant ${v.id} hurt a winner`);
  }
});

check('windows expose 24h/3d/7d/all with overview+buckets', () => {
  for (const wk of ['24h', '3d', '7d', 'all']) {
    assert.ok(res.windows[wk], `missing window ${wk}`);
    assert.ok(res.windows[wk].overview);
    assert.ok(Array.isArray(res.windows[wk].buckets));
  }
  // 24h window excludes the May trades
  assert.strictEqual(res.windows['24h'].overview.n, 2); // S1 + T1
});

// cleanup fixture
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

console.log(`\nregularPullbackExitResearchService: ${passed} checks passed`);
