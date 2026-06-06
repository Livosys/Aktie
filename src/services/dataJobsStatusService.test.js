'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('./dataJobsStatusService');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'data-jobs-status-'));
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function appendJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

(async () => {
  const emptyRoot = tmpDir();
  const empty = svc.buildDataJobsStatus({
    importManifestFile: path.join(emptyRoot, 'missing-imports.jsonl'),
    backfillJobsFile: path.join(emptyRoot, 'missing-jobs.json'),
    marketDataRoot: path.join(emptyRoot, 'market-data'),
    alpacaDataService: { hasCredentials: () => false, isEnabled: () => false },
    dataCoverageExpansion: null,
    marketDataStore: { listSymbols: () => [] },
    eventLogService: { readRecentEvents: () => ({ ok: true, events: [] }) },
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.alpacaConfigured, false);
  assert.equal(empty.mode, 'paper_only');
  assert.equal(empty.actions_allowed, false);
  assert.equal(empty.can_place_orders, false);
  assert.equal(empty.live_trading_enabled, false);
  assert.equal(empty.broker_enabled, false);
  assert.equal(empty.message, 'Ingen tydlig datajobs-historik hittades ännu.');

  const root = tmpDir();
  const manifest = path.join(root, 'imports/alpaca-2m-imports.jsonl');
  const jobsFile = path.join(root, 'coverage/backfill-jobs-v1.json');
  const marketRoot = path.join(root, 'market-data');
  appendJsonl(manifest, [
    {
      symbol: 'MSFT',
      from: '2026-06-01',
      to: '2026-06-01',
      status: 'ok',
      candles_fetched: 200,
      candles_valid: 190,
      candles_written: 188,
      duplicates_skipped: 2,
      started_at: '2026-06-01T10:00:00.000Z',
      completed_at: '2026-06-01T10:00:02.000Z',
    },
  ]);
  writeJson(jobsFile, [
    {
      job_id: 'dc_backfill_1',
      status: 'completed',
      symbols: ['MSFT', 'QQQ'],
      timeframes: ['2m'],
      provider: 'alpaca',
      from_date: '2026-05-01',
      to_date: '2026-05-05',
      progress: { total: 2, completed: 2, failed: 0, pct: 100 },
      candles_downloaded: 500,
      created_at: '2026-06-01T09:00:00.000Z',
      started_at: '2026-06-01T09:01:00.000Z',
      completed_at: '2026-06-01T09:02:00.000Z',
      updated_at: '2026-06-01T09:02:00.000Z',
    },
  ]);
  appendJsonl(path.join(marketRoot, 'candles-2m/MSFT/2026-06-01.jsonl'), [
    { ts: '2026-06-01T13:30:00.000Z', o: 1, h: 2, l: 1, c: 2, v: 100 },
  ]);

  const ok = svc.buildDataJobsStatus({
    importManifestFile: manifest,
    backfillJobsFile: jobsFile,
    marketDataRoot: marketRoot,
    alpacaDataService: { hasCredentials: () => true, isEnabled: () => true },
    dataCoverageExpansion: {
      getProviderStatus: () => ({
        alpaca: { provider: 'alpaca', configured: true, enabled: true, ok: true },
        binance: { provider: 'binance', configured: true, enabled: true, ok: true },
      }),
    },
    marketDataStore: { listSymbols: () => ['MSFT'] },
    eventLogService: {
      readRecentEvents: () => ({
        ok: true,
        events: [{ event_id: 'e1', type: 'DATA_BACKFILL_COMPLETED', timestamp: '2026-06-01T09:02:00.000Z', source: 'data_coverage', message: 'Data backfill klar', symbol: 'MSFT' }],
      }),
    },
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.alpacaConfigured, true);
  assert.equal(ok.hourlyImport.candlesImported, 188);
  assert.equal(ok.hourlyImport.latestImport.durationMs, 2000);
  assert.equal(ok.weeklyBackfill.totalJobs, 1);
  assert.equal(ok.cacheStatus.cacheExists, true);
  assert.equal(ok.cacheStatus.symbolsCached, 1);
  assert.equal(ok.recentDataEvents.length, 1);
  assert.equal(ok.recentDataEvents[0].can_place_orders, false);

  const masked = svc.buildDataJobsStatus({
    importManifestFile: path.join(root, 'missing.jsonl'),
    backfillJobsFile: path.join(root, 'missing.json'),
    marketDataRoot: path.join(root, 'missing-market'),
    alpacaDataService: {
      hasCredentials: () => { throw new Error('ALPACA_API_SECRET_KEY=super-secret-token'); },
      isEnabled: () => true,
    },
    dataCoverageExpansion: null,
    marketDataStore: null,
    eventLogService: null,
  });
  assert.equal(masked.ok, false);
  assert.equal(masked.status, 'error');
  assert.equal(masked.can_place_orders, false);
  assert.ok(!JSON.stringify(masked).includes('super-secret-token'));
  assert.ok(!JSON.stringify(masked).includes('ALPACA_API_SECRET_KEY='));

  // Service surface is read-only: it exposes no import/backfill control methods.
  assert.equal(typeof svc.runImport, 'undefined');
  assert.equal(typeof svc.runBackfillJob, 'undefined');
  assert.equal(typeof svc.pauseBackfillJob, 'undefined');
  assert.equal(typeof svc.stopBackfillJob, 'undefined');

  console.log('# dataJobsStatusService tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
