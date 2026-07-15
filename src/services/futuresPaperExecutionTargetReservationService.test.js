'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reservationModule = require('./futuresPaperExecutionTargetReservationService');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-target-reservation-test-'));
  const service = reservationModule.createFuturesPaperExecutionTargetReservationService({ dir });

  const internalBlocked = service.reserveExecutionTarget({
    candidateId: 'cand-race-1',
    executionTarget: 'internal_simulation',
    strategyId: 'strategy_a',
    signalTimestamp: '2026-07-15T22:29:30.000Z',
  });
  assert.equal(internalBlocked.ok, false);
  assert.equal(internalBlocked.blocker, 'internal_futures_simulation_disabled');

  const first = service.reserveExecutionTarget({
    candidateId: 'cand-race-1',
    executionTarget: 'ibkr_paper',
    strategyId: 'strategy_a',
    signalTimestamp: '2026-07-15T22:29:30.000Z',
  });
  assert.equal(first.ok, true);
  assert.equal(first.reserved, true);

  const sameTarget = service.reserveExecutionTarget({
    candidateId: 'cand-race-1',
    executionTarget: 'ibkr_paper',
    strategyId: 'strategy_a',
    signalTimestamp: '2026-07-15T22:29:30.000Z',
  });
  assert.equal(sameTarget.ok, true);
  assert.equal(sameTarget.duplicate, true);

  const attempts = await Promise.all([
    Promise.resolve().then(() => service.reserveExecutionTarget({ candidateId: 'cand-race-2', executionTarget: 'internal_simulation' })),
    Promise.resolve().then(() => service.reserveExecutionTarget({ candidateId: 'cand-race-2', executionTarget: 'ibkr_paper' })),
  ]);
  const winners = attempts.filter((row) => row.ok && row.reserved);
  const losers = attempts.filter((row) => !row.ok && row.blocker === 'internal_futures_simulation_disabled');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);

  const reloaded = reservationModule.createFuturesPaperExecutionTargetReservationService({ dir });
  assert.equal(reloaded.getReservation('cand-race-1').executionTarget, 'ibkr_paper');

  console.log('futuresPaperExecutionTargetReservationService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
