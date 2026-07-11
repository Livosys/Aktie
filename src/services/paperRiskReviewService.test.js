'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pauseSummaryService = require('./paperRiskPauseSummaryService');
const reviewService = require('./paperRiskReviewService');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-risk-review-'));
const tradesFile = path.join(tmpDir, 'trades.jsonl');
const eventsFile = path.join(tmpDir, 'events.jsonl');
const stateFile = path.join(tmpDir, 'risk-review-state.json');

const now = new Date('2026-06-18T15:00:00.000Z');
const trades = [
  { tradeId: 't1', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:00:00.000Z' },
  { tradeId: 't2', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:10:00.000Z' },
  { tradeId: 't3', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:20:00.000Z' },
  { tradeId: 't4', symbol: 'AAPL', strategy_id: 'trend_continuation', result: 'LOSS', closed_at: '2026-06-18T13:30:00.000Z' },
];
const events = [
  { eventId: 'e1', type: 'GATE_ALLOWED', symbol: 'AAPL', strategy_id: 'trend_continuation', timestamp: '2026-06-18T14:10:00.000Z' },
  { eventId: 'e2', type: 'RISK_PAUSE_TRIGGERED', symbol: 'AAPL', strategy_id: 'trend_continuation', reason: 'Systempaus — consecutive_losses_limit.', timestamp: '2026-06-18T14:20:00.000Z' },
];

fs.writeFileSync(tradesFile, trades.map((row) => JSON.stringify(row)).join('\n') + '\n');
fs.writeFileSync(eventsFile, events.map((row) => JSON.stringify(row)).join('\n') + '\n');

async function main() {
  const currentSummary = await pauseSummaryService.buildPaperRiskPauseSummary({
    files: { trades: tradesFile, events: eventsFile, riskReviewState: stateFile },
    riskConfig: {
      pause_after_consecutive_losses: true,
      max_consecutive_losses: 4,
    },
    now,
  });

  assert.equal(currentSummary.summary.pause_trading, false);
  assert.equal(currentSummary.summary.risk_review.active, false);

  const service = reviewService.createPaperRiskReviewService({
    files: { events: eventsFile, riskReviewState: stateFile },
  });

  const result = await service.resumePaperTesting({
    confirmPaperOnly: true,
    reason: 'Manual risk review accepted. Resume paper testing.',
  }, {
    currentSummary,
    riskConfig: {
      pause_after_consecutive_losses: true,
      max_consecutive_losses: 4,
    },
    now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'risk_pause_not_active');
  assert.equal(result.mode, 'paper_only');
  assert.equal(result.actions_allowed, false);
  assert.equal(result.can_place_orders, false);
  assert.equal(result.summary.summary.pause_trading, false);
  assert.equal(result.summary.summary.effective_pause_trading, false);

  const state = service.getPaperRiskReviewState({ now });
  assert.equal(state.active, false);
  assert.equal(service.isPaperReviewActive({ now }), false);

  const rejected = await service.resumePaperTesting({
    confirmPaperOnly: true,
    reason: 'Manual risk review accepted. Resume paper testing.',
    live_trading_enabled: true,
  }, { currentSummary });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'invalid_request');

  console.log('# paperRiskReviewService tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
