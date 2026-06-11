'use strict';

const assert = require('assert');
const gate = require('./paperApprovalGateService');

function run() {
  // ── resolveStrategyId maps canonical scanner candidates to strategy ids ─────
  const vwapShort = { signalFamily: 'VWAP_RECLAIM_REJECTION', signalSubtype: 'VWAP_REJECTION_DOWN', nextMoveBias: 'DOWN', market: 'stocks', symbol: 'NVDA' };
  const narrowLong = { signalFamily: 'NARROW_COMPRESSION', signalSubtype: 'NARROW_BULL_ENTRY', nextMoveBias: 'UP', symbol: 'AAPL' };
  const emaUp = { signalFamily: 'EMA_TREND_PULLBACK', signalSubtype: 'EMA_PULLBACK_UP', nextMoveBias: 'UP', symbol: 'MSFT' };
  const vwapLong = { signalFamily: 'VWAP_RECLAIM_REJECTION', signalSubtype: 'VWAP_RECLAIM_UP', nextMoveBias: 'UP', market: 'stocks', symbol: 'QQQ' };

  assert.equal(gate.resolveStrategyId(vwapShort), 'vwap_failed_breakout_short', 'vwap short maps');
  assert.equal(gate.resolveStrategyId(narrowLong), 'narrow_state_expansion_long', 'narrow bull maps');
  assert.equal(gate.resolveStrategyId(emaUp), 'ema_pullback_continuation', 'ema up maps');
  assert.equal(gate.resolveStrategyId(vwapLong), 'vwap_volume_breakout_long', 'vwap long maps');

  // ── approved-set membership decides accept/block, with a stable reason ───────
  const approvedSet = new Set(['vwap_failed_breakout_short', 'narrow_breakout', 'ema_pullback_continuation', 'narrow_state_expansion_long']);

  const d1 = gate.evaluateCandidate(vwapShort, { approvedSet });
  assert.equal(d1.approved, true, 'approved strategy accepted');
  assert.equal(d1.decision, 'accept');
  assert.equal(d1.blockedReason, null);
  assert.equal(d1.strategyId, 'vwap_failed_breakout_short');

  const d2 = gate.evaluateCandidate(vwapLong, { approvedSet });
  assert.equal(d2.approved, false, 'non-approved strategy blocked');
  assert.equal(d2.decision, 'block');
  assert.equal(d2.blockedReason, gate.NOT_APPROVED_REASON, 'stable blocked reason');

  const d3 = gate.evaluateCandidate(emaUp, { approvedSet });
  assert.equal(d3.approved, true, 'approved EMA accepted regardless of agent EMA pause');

  // ── unresolved / unknown candidate is fail-closed (blocked) ─────────────────
  const unknown = gate.evaluateCandidate({ symbol: 'X', signalSubtype: 'TOTALLY_UNKNOWN' }, { approvedSet });
  assert.equal(unknown.approved, false, 'unknown strategy is blocked, not accepted');
  assert.equal(unknown.blockedReason, gate.NOT_APPROVED_REASON);

  // ── safety stamp present and locked on every decision ───────────────────────
  for (const d of [d1, d2, d3, unknown]) {
    assert.equal(d.mode, 'paper_only');
    assert.equal(d.actions_allowed, false);
    assert.equal(d.can_place_orders, false);
    assert.equal(d.live_trading_enabled, false);
    assert.equal(d.broker_enabled, false);
  }

  // ── previewCandidates: dry-run summary, writes nothing ──────────────────────
  const preview = gate.previewCandidates([vwapShort, vwapLong, narrowLong, emaUp]);
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true, 'preview is a dry run');
  assert.equal(preview.mode, 'paper_only', 'safety mode stays paper_only');
  assert.equal(preview.total, 4);
  assert.equal(typeof preview.accepted, 'number');
  assert.equal(typeof preview.blocked, 'number');
  assert.equal(preview.accepted + preview.blocked, 4, 'every candidate classified');
  assert.equal(preview.can_place_orders, false);

  console.log('paperApprovalGateService.test.js: OK');
}

run();
