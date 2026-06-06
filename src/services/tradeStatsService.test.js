'use strict';

const assert = require('assert/strict');
const stats = require('./tradeStatsService');

// ── 1. Classification: explicit results (case/variant tolerant) ───────────────
{
  assert.equal(stats.classifyResult({ result: 'WIN' }), 'win');
  assert.equal(stats.classifyResult({ result: 'loss' }), 'loss');
  assert.equal(stats.classifyResult({ result: 'TIMEOUT' }), 'timeout');
  assert.equal(stats.classifyResult({ result: 'Breakeven' }), 'breakeven');
  assert.equal(stats.classifyResult({ result: 'TP' }), 'win');
  assert.equal(stats.classifyResult({ result: 'SL' }), 'loss');
  assert.equal(stats.classifyResult({ result: '' }), 'unknown');
  assert.equal(stats.classifyResult({}), 'unknown');
}

// ── 2. Classification: pnl fallback only when explicitly allowed ──────────────
{
  // Without deriveFromPnl, a missing result stays unknown even with pnl.
  assert.equal(stats.classifyResult({ pnlPct: 0.5 }), 'unknown');
  // With deriveFromPnl, pnl sign decides.
  assert.equal(stats.classifyResult({ pnlPct: 0.5 }, { deriveFromPnl: true }), 'win');
  assert.equal(stats.classifyResult({ pnlPct: -0.5 }, { deriveFromPnl: true }), 'loss');
  assert.equal(stats.classifyResult({ pnlPct: 0 }, { deriveFromPnl: true }), 'breakeven');
}

// ── 3. THE HEADLINE: 203 WIN / 144 LOSS / 76 TIMEOUT → 48.0% vs 58.5% ─────────
// This reproduces the Fas 3 finding with synthetic data so the math is pinned.
{
  const rows = [];
  for (let i = 0; i < 203; i++) rows.push({ result: 'WIN', pnlPct: 0.3 });
  for (let i = 0; i < 144; i++) rows.push({ result: 'LOSS', pnlPct: -0.4 });
  for (let i = 0; i < 76; i++) rows.push({ result: 'TIMEOUT', pnlPct: -0.05 });

  const s = stats.computeStats(rows);
  assert.equal(s.totalTrades, 423);
  assert.equal(s.win, 203);
  assert.equal(s.loss, 144);
  assert.equal(s.timeout, 76);
  assert.equal(s.decisive, 347);

  // winRate = 203/423 = 47.99% (TIMEOUT counts against)
  assert.equal(s.winRate, 47.99);
  // decisiveWinRate = 203/347 = 58.5% (TIMEOUT excluded)
  assert.equal(s.decisiveWinRate, 58.5);
  // The gap is exactly the timeout share.
  assert.equal(s.timeoutRate, 17.97);
  assert.ok(s.winRate < s.decisiveWinRate, 'winRate must be lower than decisiveWinRate when timeouts exist');
}

// ── 4. compareMethodologies explains the difference ───────────────────────────
{
  const rows = [];
  for (let i = 0; i < 203; i++) rows.push({ result: 'WIN' });
  for (let i = 0; i < 144; i++) rows.push({ result: 'LOSS' });
  for (let i = 0; i < 76; i++) rows.push({ result: 'TIMEOUT' });

  const cmp = stats.compareMethodologies(rows);
  const byName = Object.fromEntries(cmp.methodologies.map((m) => [m.name, m]));
  assert.equal(byName.winRate.value, 47.99);
  assert.equal(byName.decisiveWinRate.value, 58.5);
  assert.match(cmp.difference_explained_sv, /76 TIMEOUT/);
  assert.equal(cmp.canonical.win, 203);
}

// ── 5. Grouping falls back to signalFamily when strategy_id is absent ─────────
{
  const rows = [
    { signalFamily: 'EMA_TREND_PULLBACK', result: 'WIN' },
    { signalFamily: 'EMA_TREND_PULLBACK', result: 'LOSS' },
    { strategy_id: 'narrow_breakout_v1', result: 'WIN' },
    { signalSubtype: 'odd', result: 'TIMEOUT' },
  ];
  const groups = stats.computeStatsByGroup(rows);
  const keys = groups.map((g) => g.key).sort();
  assert.deepEqual(keys, ['EMA_TREND_PULLBACK', 'narrow_breakout_v1', 'odd']);
  const ema = groups.find((g) => g.key === 'EMA_TREND_PULLBACK');
  assert.equal(ema.totalTrades, 2);
  assert.equal(ema.decisiveWinRate, 50);
}

// ── 6. Empty input is safe (no crash, null rates) ─────────────────────────────
{
  const s = stats.computeStats([]);
  assert.equal(s.totalTrades, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.decisiveWinRate, null);
}

// ── 7. SAFETY flags present and all false / paper_only ────────────────────────
{
  const s = stats.computeStats([{ result: 'WIN' }]);
  assert.equal(s.mode, 'paper_only');
  assert.equal(s.actions_allowed, false);
  assert.equal(s.can_place_orders, false);
  assert.equal(s.live_trading_enabled, false);
  assert.equal(s.broker_enabled, false);
}

// ── 8. Real paper-trades on disk stay internally consistent (soft check) ──────
{
  const real = stats.loadPaperTrades();
  if (real.length > 0) {
    const s = stats.computeStats(real);
    assert.equal(s.totalTrades, s.win + s.loss + s.timeout + s.breakeven + s.unknown);
    assert.equal(s.decisive, s.win + s.loss);
    if (s.timeout > 0 && s.decisive > 0) {
      assert.ok(s.winRate <= s.decisiveWinRate, 'with timeouts present, winRate <= decisiveWinRate');
    }
  }
}

console.log('# tradeStatsService tests passed.');
