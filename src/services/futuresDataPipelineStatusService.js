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

function buildInstrumentStatus(root, marketDataService) {
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
    blockers,
  };
}

// Filsystem-scanning cachas (TTL 60s) så att desk-runtime/status-endpoints
// aldrig blir tyngre av växande candle-arkiv.
let statusCache = null; // {payload, atMs}
const STATUS_CACHE_TTL_MS = 60 * 1000;

function getStatus({ marketDataService = futuresMarketData.defaultFuturesMarketDataService, now = new Date(), fresh = false } = {}) {
  if (!fresh && statusCache && (Date.now() - statusCache.atMs) < STATUS_CACHE_TTL_MS) {
    return statusCache.payload;
  }
  const payload = buildStatus({ marketDataService, now });
  statusCache = { payload, atMs: Date.now() };
  return payload;
}

function buildStatus({ marketDataService = futuresMarketData.defaultFuturesMarketDataService, now = new Date() } = {}) {
  const instruments = {};
  for (const root of ROOTS) {
    try {
      instruments[root] = buildInstrumentStatus(root, marketDataService);
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
