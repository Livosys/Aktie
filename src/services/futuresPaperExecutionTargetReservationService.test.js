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
    lifecycleId: 'life-race-1',
    candidateId: 'cand-race-1',
    executionTarget: 'ibkr_paper',
    strategyId: 'strategy_a',
    signalTimestamp: '2026-07-15T22:29:30.000Z',
  });
  assert.equal(first.ok, true);
  assert.equal(first.reserved, true);
  assert.equal(first.record.lifecycleId, 'life-race-1');

  const sameTarget = service.reserveExecutionTarget({
    candidateId: 'cand-race-1',
    executionTarget: 'ibkr_paper',
    strategyId: 'strategy_a',
    signalTimestamp: '2026-07-15T22:29:30.000Z',
  });
  assert.equal(sameTarget.ok, true);
  assert.equal(sameTarget.duplicate, true);
  assert.equal(sameTarget.record.lifecycleId, 'life-race-1');

  const missingLifecycle = service.reserveExecutionTarget({
    candidateId: 'cand-no-lifecycle',
    executionTarget: 'ibkr_paper',
    strategyId: 'strategy_a',
    signalTimestamp: '2026-07-15T22:29:30.000Z',
  });
  assert.equal(missingLifecycle.ok, true);
  assert.equal(missingLifecycle.record.lifecycleId, null);

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

  // --- sweepStaleReservations: age-based GC of orphaned reservation files ---
  // Unit: deterministically place two files of different age, sweep in isolation.
  const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-target-reservation-sweep-'));
  const sweepSvc = reservationModule.createFuturesPaperExecutionTargetReservationService({ dir: sweepDir });
  const now = new Date('2026-07-20T15:00:00.000Z');
  const stampFile = (name, iso) => fs.writeFileSync(
    path.join(sweepDir, name),
    `${JSON.stringify({ candidateId: name, executionTarget: 'ibkr_paper', reservedAt: iso, updatedAt: iso })}\n`,
  );
  stampFile('stale.json', new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()); // 3h old
  stampFile('recent.json', new Date(now.getTime() - 60 * 1000).toISOString());          // 1min old
  const swept = sweepSvc.sweepStaleReservations({ maxAgeMs: 2 * 60 * 60 * 1000, now });
  assert.equal(swept.scanned, 2);
  assert.equal(swept.removed, 1, 'exactly the stale reservation is removed');
  assert.equal(fs.existsSync(path.join(sweepDir, 'stale.json')), false, 'stale reservation deleted');
  assert.equal(fs.existsSync(path.join(sweepDir, 'recent.json')), true, 'recent reservation preserved');
  // Idempotent: a second sweep removes nothing more.
  assert.equal(sweepSvc.sweepStaleReservations({ maxAgeMs: 2 * 60 * 60 * 1000, now }).removed, 0, 'second sweep is a no-op');

  // Integration: reserving opportunistically GC's a pre-existing stale file, and
  // the reserve itself always succeeds (GC is non-fatal, off the decision path).
  const gcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-target-reservation-gc-'));
  const gcSvc = reservationModule.createFuturesPaperExecutionTargetReservationService({ dir: gcDir });
  fs.mkdirSync(gcDir, { recursive: true });
  fs.writeFileSync(
    path.join(gcDir, 'ancient.json'),
    `${JSON.stringify({ candidateId: 'ancient', executionTarget: 'ibkr_paper', reservedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })}\n`,
  );
  const gcReserve = gcSvc.reserveExecutionTarget({ candidateId: 'live-cand', executionTarget: 'ibkr_paper', now });
  assert.equal(gcReserve.reserved, true, 'reserve still succeeds while GC runs');
  assert.equal(gcReserve.record.lifecycleId, null, 'reservation does not synthesize lifecycleId from candidateId');
  assert.equal(fs.existsSync(path.join(gcDir, 'ancient.json')), false, 'opportunistic GC removed the ancient file');
  assert.ok(gcSvc.getReservation('live-cand'), 'new reservation persisted');

  console.log('futuresPaperExecutionTargetReservationService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
