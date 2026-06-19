'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersPreviewService');

function candidate(overrides = {}) {
  return {
    candidateId: 'cand-1',
    symbol: 'AAPL',
    canonicalStrategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    setup: 'NARROW_BULL_ENTRY',
    source: 'scanner',
    score: 71,
    confidence: 84,
    ...overrides,
  };
}

function assertBlocked(row, expectedSubstring, message) {
  assert.equal(row.allowedForIbPaperPreview, false, message || 'candidate should be blocked');
  assert.ok(Array.isArray(row.blockers), 'blockers is an array');
  assert.ok(row.blockers.some((item) => String(item).toLowerCase().includes(String(expectedSubstring).toLowerCase())), `expected blocker containing "${expectedSubstring}"`);
  assert.equal(row.wouldCreateIbPaperOrder, false, 'wouldCreateIbPaperOrder stays false');
  assert.equal(row.orderSendingBlocked, true, 'orderSendingBlocked stays true');
}

function run() {
  // ── The public endpoint/service surface is always preview_only and hard-blocked ──
  const preview = svc.getIbPaperOrderPreview({
    candidates: [
      candidate({ symbol: 'AAPL', canonicalStrategyId: 'narrow_breakout', direction: 'long' }),
      candidate({ symbol: 'META', canonicalStrategyId: 'trend_continuation', direction: 'long', setup: 'REGULAR_PULLBACK' }),
      candidate({ symbol: 'NVDA', canonicalStrategyId: 'narrow_state_expansion_long', direction: 'long' }),
      candidate({ symbol: 'MSFT', canonicalStrategyId: 'ema_pullback_continuation', direction: 'short' }),
    ],
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.mode, 'preview_only');
  assert.equal(preview.maxPerDay, 3);
  assert.equal(preview.cryptoBlocked, true);
  assert.equal(preview.etfBlocked, true);
  assert.equal(preview.qqqBlocked, true);
  assert.equal(preview.executionEnabled, false);
  assert.equal(preview.orderQueueEnabled, false);
  assert.equal(preview.brokerExecutionEnabled, false);
  assert.equal(preview.liveTradingEnabled, false);
  assert.equal(preview.orderSendingBlocked, true);
  assert.equal(preview.wouldCreateIbPaperOrder, false);
  assert.ok(Array.isArray(preview.candidates));
  assert.equal(preview.candidates.length, 3, 'visible list caps at 3');
  assert.equal(preview.summary.totalCandidates, 3);
  assert.equal(preview.summary.allowedCandidates, 3);
  assert.equal(preview.summary.blockedCandidates, 0);
  assert.ok(preview.summary.noteSv.includes('Tre kandidater'));

  for (const row of preview.candidates) {
    assert.equal(row.allowedForIbPaperPreview, true, 'allowed row stays allowed');
    assert.equal(row.wouldCreateIbPaperOrder, false, 'allowed row still never creates order');
    assert.equal(row.orderSendingBlocked, true, 'allowed row still blocks order sending');
    assert.equal(typeof row.reasonSv, 'string');
    assert.ok(row.reasonSv.length > 0);
  }

  // ── Crypto is blocked even when the strategy itself is approved ─────────────
  const crypto = svc._internal.buildOrderPreviewCandidate(candidate({
    symbol: 'BTCUSDT',
    canonicalStrategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    setup: 'NARROW_BULL_ENTRY',
    direction: 'long',
  }));
  assertBlocked(crypto, 'krypto', 'crypto candidate must be blocked');

  // ── QQQ / ETF are blocked in this phase ────────────────────────────────────
  const qqq = svc._internal.buildOrderPreviewCandidate(candidate({
    symbol: 'QQQ',
    canonicalStrategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    direction: 'long',
    setup: 'NARROW_BULL_ENTRY',
  }));
  assertBlocked(qqq, 'QQQ', 'QQQ candidate must be blocked');

  const etf = svc._internal.buildOrderPreviewCandidate(candidate({
    symbol: 'SPY',
    canonicalStrategyId: 'trend_continuation',
    strategyName: 'Trend Continuation',
    direction: 'long',
    setup: 'REGULAR_PULLBACK',
  }));
  assertBlocked(etf, 'ETF', 'ETF candidate must be blocked');

  // ── Unapproved strategy is blocked ─────────────────────────────────────────
  const unapproved = svc._internal.buildOrderPreviewCandidate(candidate({
    symbol: 'AAPL',
    canonicalStrategyId: 'totally_new_strategy',
    strategyName: 'Totally New',
    direction: 'long',
    setup: 'NARROW_BULL_ENTRY',
  }));
  assertBlocked(unapproved, 'godkänd', 'unapproved strategy must be blocked');

  // ── Missing / unclear direction is blocked ─────────────────────────────────
  const missingDirection = svc._internal.buildOrderPreviewCandidate(candidate({
    symbol: 'META',
    canonicalStrategyId: 'trend_continuation',
    strategyName: 'Trend Continuation',
    setup: 'REGULAR_PULLBACK',
    direction: null,
  }));
  assertBlocked(missingDirection, 'riktningen', 'missing direction must be blocked');

  // ── max 3 candidates is enforced even if more are provided ─────────────────
  const capped = svc.getIbPaperOrderPreview({
    candidates: [
      candidate({ symbol: 'AAPL', canonicalStrategyId: 'narrow_breakout', direction: 'long' }),
      candidate({ symbol: 'META', canonicalStrategyId: 'trend_continuation', direction: 'long' }),
      candidate({ symbol: 'NVDA', canonicalStrategyId: 'narrow_state_expansion_long', direction: 'long' }),
      candidate({ symbol: 'MSFT', canonicalStrategyId: 'ema_pullback_continuation', direction: 'short' }),
      candidate({ symbol: 'GOOGL', canonicalStrategyId: 'vwap_failed_breakout_short', direction: 'short' }),
    ],
  });
  assert.equal(capped.candidates.length, 3, 'preview list capped at 3');
  assert.equal(capped.executionEnabled, false);
  assert.equal(capped.orderQueueEnabled, false);
  assert.equal(capped.brokerExecutionEnabled, false);
  assert.equal(capped.liveTradingEnabled, false);
  assert.equal(capped.orderSendingBlocked, true);
  assert.equal(capped.wouldCreateIbPaperOrder, false);

  console.log('interactiveBrokersPreviewService.test.js: OK');
}

run();
