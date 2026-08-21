'use strict';

// Read-only status för den gemensamma futures-datapipelinen:
// IB → futuresMarketDataService → marketDataStore → Replay/Batch/Pine.
//
// Rapporterar per instrument vilken historik som faktiskt finns i den
// gemensamma storen (samma candles som Replay/Batch läser), aktuellt
// kontrakt/manifest och tydliga blockers när data saknas. Ingen datahämtning
// triggas härifrån — endast läsning av det som redan importerats.

const marketDataStore = require('../data/marketDataStore');
const futuresMarketData = require('./futuresMarketDataService');
const { buildIbHistoricalDatasetManifest } = require('./backfill/ibHistoricalDatasetManifestService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  readOnly: true,
  source: 'futures_data_pipeline_status',
});

const ROOTS = Object.freeze(['MNQ', 'MES']);

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function buildInstrumentStatus(root, marketDataService, { includeDataset = true } = {}) {
  const dates = marketDataStore.listAvailableDates(root);
  const dates2m = dates['2m'] || [];
  const datesRaw = dates.raw || [];
  const manifest = typeof marketDataStore.loadIbImportManifest === 'function'
    ? marketDataStore.loadIbImportManifest(root)
    : null;
  let candleCount2m = 0;
  if (dates2m.length) {
    const coverage = marketDataStore.hasCandlesInRange(root, dates2m[0], dates2m[dates2m.length - 1], '2m');
    candleCount2m = coverage.candleCount;
  }
  const live = marketDataService.isEnabled() ? marketDataService.getCandles(root, { timeframe: '2m', limit: 5 }) : null;
  const blockers = [];
  if (!dates2m.length) blockers.push('no_2m_candles_in_store');
  if (!manifest) blockers.push('no_ib_import_manifest');
  return {
    root,
    store: {
      dates2m: dates2m.length,
      firstDate2m: dates2m[0] || null,
      lastDate2m: dates2m[dates2m.length - 1] || null,
      candleCount2m,
      datesRaw1m: datesRaw.length,
      firstDateRaw1m: datesRaw[0] || null,
      lastDateRaw1m: datesRaw[datesRaw.length - 1] || null,
    },
    manifest: manifest ? {
      contract: manifest.contract || null,
      dates: (manifest.dates || []).length,
      importedAt: manifest.importedAt || null,
      provider: manifest.provider || null,
    } : null,
    liveLayer: live && live.ok ? {
      closedCandles2m: live.count,
      latestClosedTimestamp: live.latestClosedTimestamp,
    } : null,
    replayReady: dates2m.length > 0,
    batchReady: dates2m.length > 0,
    // Datasetmanifestet är en FULLSTÄNDIG revision av arkivet: det läser varje
    // rå bar för varje dygn, grupperar om dem per handelsdag och validerar
    // varje dygn — och läser sedan varje kontraktsfil en gång till. Mätt 70
    // sekunder per rot, alltså 141 sekunder synkron CPU för bägge.
    //
    // Handelstest-vyn behöver det inte: den läser bara .replay och .batch, och
    // de avgörs av en kataloglistning. Den bad ändå om manifestet vid varje
    // bygge, och det var hela orsaken till att vyn tog över två minuter och
    // blockerade servern för alla andra under tiden.
    dataset: includeDataset ? buildIbHistoricalDatasetManifest({ roots: [root] }).roots[0] : null,
    datasetIncluded: includeDataset === true,
    blockers,
  };
}

// Filsystem-scanning cachas så att desk-runtime/status-endpoints aldrig blir
// tyngre av växande candle-arkiv.
//
// De två formerna cachas var för sig. Den lätta (utan datasetmanifest) byggs
// på millisekunder och håller 60 sekunder. Den tunga byggs på minuter och fick
// tidigare samma 60 sekunder — en TTL kortare än byggtiden, vilket innebar att
// den byggdes om nästan varje gång den efterfrågades.
const statusCache = new Map(); // includeDataset -> {payload, atMs}
const STATUS_CACHE_TTL_MS = 60 * 1000;
const DATASET_CACHE_TTL_MS = 15 * 60 * 1000;

function getStatus({
  marketDataService = futuresMarketData.defaultFuturesMarketDataService,
  now = new Date(),
  fresh = false,
  includeDataset = true,
} = {}) {
  const key = includeDataset ? 'with_dataset' : 'light';
  const ttl = includeDataset ? DATASET_CACHE_TTL_MS : STATUS_CACHE_TTL_MS;
  const hit = statusCache.get(key);
  if (!fresh && hit && (Date.now() - hit.atMs) < ttl) return hit.payload;
  const payload = buildStatus({ marketDataService, now, includeDataset });
  statusCache.set(key, { payload, atMs: Date.now() });
  return payload;
}

function buildStatus({
  marketDataService = futuresMarketData.defaultFuturesMarketDataService,
  now = new Date(),
  includeDataset = true,
} = {}) {
  const instruments = {};
  for (const root of ROOTS) {
    try {
      instruments[root] = buildInstrumentStatus(root, marketDataService, { includeDataset });
    } catch (err) {
      instruments[root] = { root, error: err.message, replayReady: false, batchReady: false, blockers: ['status_error'] };
    }
  }
  const replayScopeEnabled = envBool('REPLAY_FUTURES_SCOPE_ENABLED', false);
  const allReplayReady = ROOTS.every((root) => instruments[root]?.replayReady === true);
  return {
    ok: true,
    generatedAt: nowIso(now),
    ibDataLayer: marketDataService.getStatusSummary(now),
    instruments,
    replay: {
      futuresScopeEnabled: replayScopeEnabled,
      dataReady: allReplayReady,
      ready: replayScopeEnabled && allReplayReady,
      blocker: !allReplayReady
        ? 'missing_candles_in_store'
        : (!replayScopeEnabled ? 'replay_futures_scope_flag_off' : null),
    },
    batch: {
      dataReady: allReplayReady,
      ready: allReplayReady,
      blocker: allReplayReady ? null : 'missing_candles_in_store',
      note: 'Batch för futures kräver candles i den gemensamma storen. Syntetiska batch-resultat ersätts i separat fas.',
    },
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  ROOTS,
  getStatus,
};
