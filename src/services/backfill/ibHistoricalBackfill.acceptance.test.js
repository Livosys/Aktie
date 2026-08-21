'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const candleAggregator = require('../../data/candleAggregator');
const planner = require('./ibHistoricalBackfillPlanner');
const validator = require('./ibHistoricalBackfillValidator');
const { createIbHistoricalBackfillManifest } = require('./ibHistoricalBackfillManifest');
const { createIbHistoricalBackfillProgressTracker } = require('./ibHistoricalBackfillProgressTracker');
const { createIbHistoricalBackfillService } = require('./ibHistoricalBackfillService');
const { READINESS } = require('./canonicalContractProvenanceService');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-backfill-'));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function barsForOpenMinutes(from, to, base = 1000) {
  return validator._internal.expectedMinuteTimestamps(from, to).map((timestamp, index) => ({
    timestamp,
    open: base + index * 0.25,
    high: base + index * 0.25 + 1,
    low: base + index * 0.25 - 1,
    close: base + index * 0.25 + 0.5,
    volume: 10 + index,
    tradeCount: 1,
  }));
}

function fakeDownloader(barsBySegmentId, calls) {
  return {
    SAFETY: { readOnly: true, can_place_orders: false },
    async start() { return { ok: true }; },
    async fetchHistoricalBars(request) {
      calls.push(request);
      const bars = barsBySegmentId.get(request.segmentId) || barsBySegmentId.get(`${request.root}:${request.date}`) || [];
      return { ok: true, bars };
    },
  };
}

function attachSegmentIds(plan) {
  return {
    ...plan,
    segments: plan.segments.map((segment) => ({
      ...segment,
      request: { ...segment.request, segmentId: segment.id },
    })),
  };
}

function ready(contract) {
  return {
    ...contract,
    readiness: READINESS.BACKFILL_READY,
    provenanceSource: 'IBKR_CONTRACT_DETAILS_AND_HISTORICAL_PROBE',
  };
}

(async () => {
  const contract = ready({
    root: 'MNQ',
    conId: '793356225',
    localSymbol: 'MNQU6',
    expiry: '2026-09-18',
    lastTradeDateOrContractMonth: '20260918',
    activeFrom: '2026-08-17',
    activeTo: '2026-08-17',
  });
  const input = {
    runId: 'ib_backfill_acceptance_001',
    correlationId: 'corr_acceptance_001',
    symbols: ['MNQ'],
    from: '2026-08-17',
    to: '2026-08-17',
    contractsBySymbol: { MNQ: [contract] },
    now: '2026-08-18',
  };
  const planA = planner.buildPlan(input);
  const planB = planner.buildPlan(input);
  assert.equal(planA.ok, true);
  assert.deepEqual(planA, planB, 'same input must produce an identical backfill plan');
  assert.equal(planA.provider, 'ibkr');
  assert.deepEqual(planA.disallowedProviders, ['alpaca', 'databento']);
  assert.equal(planA.segments[0].request.from, '2026-08-17T22:00:00.000Z');
  assert.equal(planA.segments[0].request.to, '2026-08-18T22:00:00.000Z');
  assert.equal(planA.segments[0].request.endDateTime, planA.segments[0].request.to);
  assert.equal(planA.segments[0].request.duration, '1 D');
  assert.equal(planA.segments[0].request.useRth, 0);
  assert.equal(planA.segments[0].request.exchangeTimezone, 'America/Chicago');

  const oldExpired = planner.buildPlan({
    symbols: ['MNQ'],
    from: '2023-01-03',
    to: '2023-01-03',
    contractsBySymbol: {
      MNQ: [{
        conId: '1',
        localSymbol: 'MNQH3',
        expiry: '2023-03-17',
        activeFrom: '2023-01-03',
        activeTo: '2023-01-03',
      }],
    },
    now: '2026-08-18',
  });
  assert.equal(oldExpired.ok, false);
  assert.equal(oldExpired.reason, 'ib_expired_future_history_older_than_two_years');

  const outsideActiveWindow = planner.buildPlan({
    symbols: ['MNQ'],
    from: '2026-01-01',
    to: '2026-01-02',
    contractsBySymbol: {
      MNQ: [{
        ...ready({ ...contract,
        activeFrom: '2025-12-17',
        activeTo: '2025-12-18',
        includeExpired: true,
        }),
      }],
    },
    now: '2026-08-18',
  });
  assert.equal(outsideActiveWindow.ok, false);
  assert.equal(outsideActiveWindow.reason, 'contract_active_window_no_overlap');

  const expiryBoundary = planner.buildPlan({
    symbols: ['MNQ'],
    from: '2025-12-19',
    to: '2025-12-19',
    contractsBySymbol: {
      MNQ: [{
        ...ready({ ...contract,
        expiry: '2025-12-19',
        activeFrom: '2025-12-18',
        activeTo: '2025-12-19',
        }),
      }],
    },
    now: '2026-08-18',
  });
  assert.equal(expiryBoundary.ok, false);
  assert.equal(expiryBoundary.reason, 'contract_active_window_no_overlap');

  const tmp = mkTmp();
  const marketDataRoot = path.join(tmp, 'market-data');
  const manifest = createIbHistoricalBackfillManifest({ file: path.join(tmp, 'manifest.jsonl') });
  const progress = createIbHistoricalBackfillProgressTracker({ file: path.join(tmp, 'progress.jsonl') });
  const plan = attachSegmentIds(planA);
  const segment = plan.segments[0];
  const bars = barsForOpenMinutes(segment.request.from, segment.request.to);
  assert.equal(bars.length, 1380, 'canonical weekday has 23 hours of open Globex minutes');
  const calls = [];
  const bySegment = new Map([[segment.id, bars]]);
  const service = createIbHistoricalBackfillService({
    marketDataRoot,
    manifest,
    progress,
    downloader: fakeDownloader(bySegment, calls),
    now: () => new Date('2026-08-18T12:00:00.000Z'),
  });

  const firstRun = await service.runBackfill(plan);
  assert.equal(firstRun.ok, true);
  assert.equal(firstRun.status, 'completed');
  assert.equal(calls.length, 1, 'one downloader call is expected for one segment');

  const rawFile = service.files.rawFileFor('MNQ', '2026-08-17', segment.contractKey);
  const candlesFile = service.files.candles2mFileFor('MNQ', '2026-08-17', segment.contractKey);
  const rawRows = readJsonl(rawFile);
  const candleRows = readJsonl(candlesFile);
  assert.equal(rawRows.length, bars.length, 'raw 1m rows are appended once');
  assert.equal(rawRows.every((row) => row.source === 'ib' && row.provider === 'ibkr'), true);
  assert.equal(rawRows.every((row) => row.contractKey === segment.contractKey), true);
  assert.equal(candleRows.every((row) => row.tradingDay === segment.date), true);
  assert.equal(candleRows.length, candleAggregator.aggregate1mTo2m(rawRows).filter((row) => !row.incomplete).length);

  const rawValidation = validator.validateBars(rawRows, {
    from: segment.request.from,
    to: segment.request.to,
    contract: { ...contract, contractKey: segment.contractKey },
  });
  assert.equal(rawValidation.ok, true);
  const aggregationValidation = validator.validateAggregation({ bars1m: rawRows, candles2m: candleRows });
  assert.equal(aggregationValidation.ok, true);
  assert.equal(aggregationValidation.identicalAggregation, true);
  assert.equal(aggregationValidation.source, 'candleAggregator.aggregate1mTo2m');

  const secondRun = await service.runBackfill(plan);
  assert.equal(secondRun.ok, true);
  assert.equal(secondRun.status, 'completed');
  assert.equal(calls.length, 1, 'completed segment must not be downloaded again');
  assert.equal(readJsonl(rawFile).length, rawRows.length, 'rerun must not duplicate raw rows');
  assert.equal(readJsonl(candlesFile).length, candleRows.length, 'rerun must not duplicate 2m rows');

  const progressState = service.getProgress(plan.runId);
  assert.equal(progressState.status, 'completed');
  assert.deepEqual(progressState.completedSegmentIds, [segment.id]);
  assert.equal(readJsonl(manifest.file).every((event) => event.runId === plan.runId), true);

  const pausePlan = attachSegmentIds(planner.buildPlan({
    runId: 'ib_backfill_acceptance_pause',
    symbols: ['MNQ'],
    from: '2026-08-18',
    to: '2026-08-18',
    contractsBySymbol: {
      MNQ: [{
        ...ready({ ...contract,
        activeFrom: '2026-08-18',
        activeTo: '2026-08-18',
        }),
      }],
    },
    now: '2026-08-18',
  }));
  const pauseSegment = pausePlan.segments[0];
  bySegment.set(pauseSegment.id, barsForOpenMinutes(pauseSegment.request.from, pauseSegment.request.to, 2000));
  service.pause(pausePlan.runId);
  const paused = await service.tick(pausePlan);
  assert.equal(paused.status, 'paused');
  service.resume(pausePlan.runId);
  const resumed = await service.runBackfill(pausePlan);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, 'completed');

  const conflictingPlan = attachSegmentIds(planner.buildPlan({
    runId: 'ib_backfill_acceptance_contract_conflict',
    symbols: ['MNQ'],
    from: '2026-08-17',
    to: '2026-08-17',
    contractsBySymbol: {
      MNQ: [{
        root: 'MNQ',
        conId: '999999999',
        localSymbol: 'MNQZ6',
        expiry: '2026-12-18',
        activeFrom: '2026-08-17',
        activeTo: '2026-08-17',
        readiness: READINESS.BACKFILL_READY,
        provenanceSource: 'IBKR_CONTRACT_DETAILS_AND_HISTORICAL_PROBE',
      }],
    },
    now: '2026-08-18',
  }));
  bySegment.set(conflictingPlan.segments[0].id, barsForOpenMinutes(
    conflictingPlan.segments[0].request.from,
    conflictingPlan.segments[0].request.to,
    3000,
  ));
  const conflict = await service.tick(conflictingPlan);
  assert.equal(conflict.ok, true, 'different contract identities must coexist in separate files');
  const conflictingRawFile = service.files.rawFileFor('MNQ', '2026-08-17', conflictingPlan.segments[0].contractKey);
  assert.equal(readJsonl(rawFile).length, rawRows.length, 'first contract must remain unchanged');
  assert.equal(readJsonl(conflictingRawFile).length, bars.length, 'second contract must be preserved separately');

  console.log('ibHistoricalBackfill.acceptance.test.js OK');
})().catch((err) => {
  console.error('TEST FAIL:', err.stack || err.message);
  process.exit(1);
});
