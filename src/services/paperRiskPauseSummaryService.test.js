'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./paperRiskPauseSummaryService');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-risk-pause-'));
const tradesFile = path.join(tmpDir, 'trades.jsonl');
const eventsFile = path.join(tmpDir, 'events.jsonl');
const riskReviewStateFile = path.join(tmpDir, 'risk-review-state.json');

const now = new Date('2026-06-18T15:00:00.000Z');
const lines = [
  { tradeId: 't1', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:00:00.000Z' },
  { tradeId: 't2', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:10:00.000Z' },
  { tradeId: 't3', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:20:00.000Z' },
  { tradeId: 't4', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:30:00.000Z' },
  { eventId: 'e1', type: 'GATE_ALLOWED', symbol: 'AAPL', strategy_id: 'trend_continuation', timestamp: '2026-06-18T14:10:00.000Z' },
  { eventId: 'e2', type: 'TRADE_OPENED', symbol: 'AAPL', strategy_id: 'trend_continuation', timestamp: '2026-06-18T14:12:00.000Z' },
  { eventId: 'e3', type: 'RISK_PAUSE_TRIGGERED', symbol: 'AAPL', strategy_id: 'trend_continuation', reason: 'Systempaus — consecutive_losses_limit.', timestamp: '2026-06-18T14:20:00.000Z' },
  { eventId: 'e4', type: 'GATE_ALLOWED', symbol: 'MSFT', strategy_id: 'ema_pullback_continuation', timestamp: '2026-06-18T14:40:00.000Z' },
];

fs.writeFileSync(tradesFile, lines.slice(0, 4).map((row) => JSON.stringify(row)).join('\n') + '\n');
fs.writeFileSync(eventsFile, lines.slice(4).map((row) => JSON.stringify(row)).join('\n') + '\n');
fs.writeFileSync(riskReviewStateFile, JSON.stringify({
  paperOnly: true,
  resumedAt: '2026-06-18T14:45:00.000Z',
  resumedBy: 'manual',
  reason: 'Manual risk review accepted. Resume paper testing.',
  previousConsecutiveLosses: 4,
  previousPauseReason: 'consecutive_losses_limit',
  maxAgeMinutes: 60,
  expiresAt: '2026-06-18T15:45:00.000Z',
  latestAuditEvent: {
    type: 'PAPER_RISK_REVIEW_RESUMED',
    timestamp: '2026-06-18T14:45:00.000Z',
  },
}, null, 2) + '\n');

async function main() {
  const result = await svc.buildPaperRiskPauseSummary({
    files: { trades: tradesFile, events: eventsFile, riskReviewState: riskReviewStateFile },
    now,
    riskConfig: {
      pause_after_consecutive_losses: true,
      max_consecutive_losses: 4,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'paper_only');
  assert.equal(result.actions_allowed, false);
  assert.equal(result.can_place_orders, false);

  assert.equal(result.summary.active, false);
  assert.equal(result.summary.pause_trading, false);
  assert.equal(result.summary.pause_reason, null);
  assert.equal(result.summary.consecutive_losses, 4);
  assert.equal(result.summary.max_consecutive_losses, 4);
  assert.equal(result.summary.pause_after_consecutive_losses, false);
  assert.equal(result.summary.consecutive_loss_pause_removed_for_ordinary_paper, true);
  assert.equal(result.summary.latest_risk_pause_event.symbol, 'AAPL');
  assert.equal(result.summary.latest_risk_pause_event.strategy_id, 'trend_continuation');
  assert.equal(result.summary.latest_risk_pause_event.type, 'RISK_PAUSE_TRIGGERED');
  assert.equal(result.summary.risk_review.active, true);
  assert.equal(result.summary.effective_pause_trading, false);
  assert.equal(result.summary.resume_override_active, true);

  const inactive = await svc.buildPaperRiskPauseSummary({
    files: { trades: tradesFile, events: eventsFile },
    now,
    riskConfig: {
      pause_after_consecutive_losses: false,
      max_consecutive_losses: 4,
    },
  });

  assert.equal(inactive.summary.active, false);
  assert.equal(inactive.summary.pause_trading, false);
  assert.equal(inactive.summary.pause_reasons.length, 0);
  assert.equal(inactive.summary.consecutive_losses, 4);

  console.log('# paperRiskPauseSummaryService tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
