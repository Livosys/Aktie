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
  // Pin multi-strategy mode OFF so these assertions are deterministic regardless
  // of ambient env. (@stoqey/ib auto-loads .env at require, which can set
  // IB_PAPER_MULTI_STRATEGY_TEST_MODE=true and otherwise widen the caps.)
  const SINGLE_MODE = { enabled: false, includeEtf: false };
  const preview = svc.getIbPaperOrderPreview({
    multiStrategy: SINGLE_MODE,
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

  // ── Allowed Nasdaq/US-stock candidates must outrank blocked crypto/unclear rows ──
  const approvedIndex = svc._internal.buildApprovedStrategyIndex();
  const approvedStrategyId = Array.from(approvedIndex.approved)[0] || 'narrow_breakout';
  const prioritized = svc.getIbPaperOrderPreview({
    multiStrategy: SINGLE_MODE,
    candidates: [
      candidate({ symbol: 'BTCUSDT', canonicalStrategyId: approvedStrategyId, strategyName: 'Approved Crypto', direction: 'long', score: 99, confidence: 99 }),
      candidate({ symbol: 'QQQ', canonicalStrategyId: approvedStrategyId, strategyName: 'Approved QQQ', direction: 'long', score: 98, confidence: 98 }),
      candidate({ symbol: 'AAPL', canonicalStrategyId: approvedStrategyId, strategyName: 'Approved AAPL', direction: 'long', score: 70, confidence: 70 }),
      candidate({ symbol: 'NVDA', canonicalStrategyId: approvedStrategyId, strategyName: 'Approved NVDA', direction: 'long', score: 69, confidence: 69 }),
    ],
  });
  assert.equal(prioritized.candidates.length, 3, 'prioritized preview still caps at 3');
  assert.equal(prioritized.candidates[0].symbol, 'AAPL', 'allowed US-stock should outrank blocked crypto/unclear');
  assert.equal(prioritized.candidates[0].allowedForIbPaperPreview, true);
  assert.equal(prioritized.candidates[1].symbol, 'NVDA', 'allowed US-stock should stay ahead of blocked rows');
  assert.equal(prioritized.candidates[1].allowedForIbPaperPreview, true);
  assert.equal(prioritized.candidates[2].allowedForIbPaperPreview, false, 'blocked rows are shown only after allowed candidates');

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
    multiStrategy: SINGLE_MODE,
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

function runDirectionTests() {
  const nd = svc._internal.normalizeIbPaperDirection;
  const tts = svc._internal.directionTokenToSide;

  // 1. direction=BUY -> BUY/long
  assert.equal(nd({ direction: 'BUY' }).normalizedDirection, 'BUY');
  assert.equal(nd({ direction: 'BUY' }).direction, 'long');
  // 2. side=SELL -> SELL/short
  assert.equal(nd({ side: 'SELL' }).normalizedDirection, 'SELL');
  assert.equal(nd({ side: 'SELL' }).direction, 'short');
  // 3. nextMoveBias=bullish -> BUY
  assert.equal(nd({ nextMoveBias: 'bullish' }).normalizedDirection, 'BUY');
  // 4. nextMoveBias=bearish -> SELL
  assert.equal(nd({ nextMoveBias: 'bearish' }).normalizedDirection, 'SELL');
  // 5. Swedish Kort/Sälj -> SELL
  assert.equal(nd({ side: 'Kort' }).normalizedDirection, 'SELL');
  assert.equal(nd({ action: 'Sälj' }).normalizedDirection, 'SELL');
  // 6. Swedish Lång/Köp -> BUY
  assert.equal(nd({ direction: 'Lång' }).normalizedDirection, 'BUY');
  assert.equal(nd({ action: 'Köp' }).normalizedDirection, 'BUY');
  // raw UP/DOWN tokens from runtime data
  assert.equal(nd({ runtimeDirection: 'UP' }).normalizedDirection, 'BUY');
  assert.equal(nd({ direction: 'DOWN' }).direction, 'short');
  // 7. conflicting fields -> unknown + ambiguous
  const conflict = nd({ direction: 'BUY', side: 'SELL' });
  assert.equal(conflict.normalizedDirection, null);
  assert.equal(conflict.direction, null);
  assert.equal(conflict.ambiguous, true);
  assert.equal(conflict.directionSource, 'conflict');
  // 8. missing direction -> unknown
  assert.equal(nd({}).direction, null);
  assert.equal(nd({}).ambiguous, false);
  // present-but-non-directional (UNCERTAIN) must NOT resolve
  assert.equal(nd({ nextMoveBias: 'UNCERTAIN' }).direction, null);
  // debug fields
  const dbg = nd({ nextMoveBias: 'UP' });
  assert.equal(dbg.directionSource, 'nextMoveBias');
  assert.deepEqual(dbg.rawDirectionFields, { nextMoveBias: 'UP' });
  // token helper
  assert.equal(tts('bullish'), 'BUY');
  assert.equal(tts('bearish'), 'SELL');
  assert.equal(tts('UNCERTAIN'), null);
  assert.equal(tts(''), null);
  assert.equal(tts({ decision: 'long' }), 'BUY');

  const approvedIndex = svc._internal.buildApprovedStrategyIndex();
  const approvedStrategyId = Array.from(approvedIndex.approved)[0] || 'narrow_breakout';

  // 9. AAPL/approved stock with a clear bullish field becomes allowed
  const allowedBull = svc._internal.buildOrderPreviewCandidate({
    candidateId: 'c', symbol: 'AAPL', canonicalStrategyId: approvedStrategyId,
    strategyName: 'Trend Continuation', nextMoveBias: 'bullish', confidence: 84,
  });
  assert.equal(allowedBull.direction, 'long', 'bullish field -> long');
  assert.equal(allowedBull.normalizedDirection, 'BUY');
  assert.equal(allowedBull.directionSource, 'nextMoveBias');
  assert.equal(allowedBull.allowedForIbPaperPreview, true, 'AAPL bullish approved stock should be allowed');
  assert.equal(allowedBull.wouldCreateIbPaperOrder, false);
  assert.equal(allowedBull.orderSendingBlocked, true);

  // gap-fill: no explicit field, direction comes from runtime index only
  const gapIdx = new Map([[`${approvedStrategyId}:AAPL`, { side: 'BUY' }]]);
  const gapfilled = svc._internal.buildOrderPreviewCandidate(
    { candidateId: 'c', symbol: 'AAPL', canonicalStrategyId: approvedStrategyId, strategyName: 'X', confidence: 70 },
    { approvedIndex, directionIndex: gapIdx },
  );
  assert.equal(gapfilled.direction, 'long', 'runtime index gap-fills direction');
  assert.equal(gapfilled.directionSource, 'runtimeDirection');
  assert.equal(gapfilled.allowedForIbPaperPreview, true);

  // explicit direction wins over a conflicting runtime hint (no false ambiguity)
  const explicitWins = svc._internal.buildOrderPreviewCandidate(
    { candidateId: 'c', symbol: 'AAPL', canonicalStrategyId: approvedStrategyId, strategyName: 'X', direction: 'short', confidence: 70 },
    { approvedIndex, directionIndex: new Map([[`${approvedStrategyId}:AAPL`, { side: 'BUY' }]]) },
  );
  assert.equal(explicitWins.direction, 'short', 'explicit candidate direction wins over runtime hint');
  assert.equal(explicitWins.directionAmbiguous, false);

  // conflicting explicit fields stay blocked
  const conflictRow = svc._internal.buildOrderPreviewCandidate({
    candidateId: 'c', symbol: 'AAPL', canonicalStrategyId: approvedStrategyId, strategyName: 'X',
    direction: 'BUY', side: 'SELL', confidence: 70,
  });
  assertBlocked(conflictRow, 'riktningen', 'conflicting direction must be blocked');
  assert.equal(conflictRow.directionAmbiguous, true);

  // 10. QQQ stays blocked when INCLUDE_ETF=false, even with a clear direction
  assertBlocked(svc._internal.buildOrderPreviewCandidate({
    candidateId: 'c', symbol: 'QQQ', canonicalStrategyId: approvedStrategyId, strategyName: 'X', nextMoveBias: 'bullish',
  }), 'QQQ', 'QQQ blocked when INCLUDE_ETF=false');

  // 11. Crypto stays blocked
  assertBlocked(svc._internal.buildOrderPreviewCandidate({
    candidateId: 'c', symbol: 'BTCUSDT', canonicalStrategyId: approvedStrategyId, strategyName: 'X', nextMoveBias: 'bullish',
  }), 'krypto', 'crypto blocked');

  // 12. No order-sending surface exists; allowed rows still never create an order
  assert.equal(typeof svc.placeOrder, 'undefined');
  assert.equal(typeof svc.cancelOrder, 'undefined');
  assert.equal(typeof svc.submitOrder, 'undefined');

  // 13. Safety permanently false
  assert.equal(svc.SAFETY.actions_allowed, false);
  assert.equal(svc.SAFETY.can_place_orders, false);
  assert.equal(svc.SAFETY.live_trading_enabled, false);
  assert.equal(svc.SAFETY.broker_enabled, false);

  console.log('interactiveBrokersPreviewService.test.js (direction): OK');
}

run();
runDirectionTests();
