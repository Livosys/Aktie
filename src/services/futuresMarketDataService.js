'use strict';

// Gemensam Futures Market Data Service (FAS 2 av FUTURES_DATA_LAYER.md).
//
// ENDA normala datakällan för futures-quotes/candles i Trading OS:
//   IB Gateway → ibFuturesDataAdapterService → denna service →
//   Futures Paper / 33 strategier / Replay / Batch / Pine.
//
// Read-only mot IB. Importerar ALDRIG order-, ledger-, approval- eller
// riskkod. Flagga: IB_FUTURES_DATA_ENABLED (default false = helt inert,
// ingen anslutning vid require).

const adapterModule = require('./ibFuturesDataAdapterService');
const candleAggregator = require('../data/candleAggregator');
const candleWindow = require('../data/candleWindow');
const marketDataStore = require('../data/marketDataStore');
const futuresContractCatalog = require('./futuresContractCatalogService');
const futuresMarketHours = require('./futuresMarketHoursService');
const contractProvenance = require('./backfill/canonicalContractProvenanceService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  readOnly: true,
  source: 'futures_market_data_service',
});

// Candle-universum = det vi paper-handlar (micro-kontrakten).
// NQ/ES hålls som quote-/index-context utan exponerad candle-pipeline.
const CANDLE_ROOTS = Object.freeze(['MNQ', 'MES']);
const QUOTE_ROOTS = Object.freeze(['MNQ', 'MES', 'NQ', 'ES']);
const SUPPORTED_TIMEFRAMES = Object.freeze(['1m', '2m', '5m']);
const QUOTE_FRESH_MS = 120 * 1000;
const MAX_BARS_1M = 4000;

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function contractKeyFor(root, contract = {}) {
  return contractProvenance.canonicalContractKey(root, contract);
}

// Tidsramarna bor i candleWindow, som live-feeden och den historiska feeden delar.
const timeframeMinutes = candleWindow.timeframeMinutes;

function createFuturesMarketDataService(options = {}) {
  const adapter = options.adapter || adapterModule.defaultIbFuturesDataAdapterService;
  const store = options.marketDataStore || marketDataStore;
  const refreshIntervalMs = Number(options.refreshIntervalMs || envInt('IB_FUTURES_REFRESH_SECONDS', 60) * 1000);
  const backfillDays = Number(options.backfillDays || envInt('IB_FUTURES_BACKFILL_DAYS', 2));
  const persistEnabled = options.persistEnabled != null
    ? options.persistEnabled !== false
    : envBool('IB_FUTURES_PERSIST_ENABLED', true);

  let started = false;
  let refreshTimer = null;
  let startedAt = null;

  // root -> { bars1m: [{epoch,timestamp,open,high,low,close,volume,tradeCount}],
  //           lastRefreshAt, lastRefreshOk, lastError, backfillDone, persistedDates:Set }
  const candleState = new Map();

  function isEnabled() {
    return envBool('IB_FUTURES_DATA_ENABLED', false) || options.forceEnabled === true;
  }

  function getCandleState(root) {
    const key = String(root || '').trim().toUpperCase();
    if (!candleState.has(key)) {
      candleState.set(key, {
        root: key,
        bars1m: [],
        lastRefreshAt: null,
        lastRefreshOk: null,
        lastError: null,
        backfillDone: false,
        lastPersistAt: null,
      });
    }
    return candleState.get(key);
  }

  function mergeBars(state, incoming = [], contract = {}) {
    if (!incoming.length) return 0;
    const identity = contractProvenance.normalizeIdentity(state.root, contract);
    const byIdentityAndEpoch = new Map(state.bars1m.map((b) => [
      `${b.contractKey || identity.contractKey || 'unknown'}|${b.epoch}`,
      b,
    ]));
    let added = 0;
    for (const bar of incoming) {
      if (!Number.isFinite(bar.epoch)) continue;
      const enriched = {
        ...bar,
        contractKey: identity.contractKey,
        conId: identity.conId,
        localSymbol: identity.localSymbol,
        expiry: identity.expiry,
      };
      const key = `${identity.contractKey || 'unknown'}|${bar.epoch}`;
      if (!byIdentityAndEpoch.has(key)) added += 1;
      byIdentityAndEpoch.set(key, enriched);
    }
    state.bars1m = [...byIdentityAndEpoch.values()].sort((a, b) => a.epoch - b.epoch);
    if (state.bars1m.length > MAX_BARS_1M) {
      state.bars1m = state.bars1m.slice(state.bars1m.length - MAX_BARS_1M);
    }
    return added;
  }

  // Persistens till Trading OS databuss (marketDataStore, source 'ib') så att
  // Replay/Batch/Pine läser SAMMA candles som live-desken.
  function persistBars(root, contract) {
    if (!persistEnabled) return;
    const state = getCandleState(root);
    const currentIdentity = contractProvenance.normalizeIdentity(root, { ...contract, contractKey: contractKeyFor(root, contract) });
    if (!currentIdentity.exact) {
      state.lastError = 'current_capture_contract_provenance_unverified';
      return;
    }
    const byPartition = new Map();
    for (const bar of state.bars1m) {
      const date = String(bar.timestamp).slice(0, 10);
      const identity = contractProvenance.normalizeIdentity(root, { ...contract, ...bar });
      if (!identity.exact) {
        state.lastError = 'current_capture_contract_provenance_unverified';
        continue;
      }
      const partition = `${identity.contractKey}|${date}`;
      if (!byPartition.has(partition)) byPartition.set(partition, { identity, date, bars: [] });
      const session = futuresMarketHours.buildFuturesSessionMetadata(bar.timestamp);
      byPartition.get(partition).bars.push({
        ts: bar.timestamp,
        t: bar.timestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume ?? 0,
        tradeCount: bar.tradeCount ?? null,
        source: 'ib',
        provider: 'ibkr',
        root,
        symbol: root,
        contractKey: identity.contractKey,
        conId: identity.conId,
        localSymbol: identity.localSymbol,
        expiry: identity.expiry,
        tradingDay: session?.tradingDay || null,
        session: session?.sessionId || null,
        provenanceQuality: contractProvenance.PROVENANCE.EXACT,
      });
    }
    for (const { identity, date, bars } of byPartition.values()) {
      try {
        const rawSaved = store.saveRawBars(root, date, bars, 'ib', { contractKey: identity.contractKey });
        if (rawSaved === -1) throw new Error('contract_provenance_store_rejected');
        const closed1m = candleAggregator.filterClosedBars(bars, { timeframeMs: 60 * 1000 });
        const agg2m = candleAggregator.aggregate1mTo2m(closed1m)
          .filter((c) => !c.incomplete)
          .map((c) => ({
            ...c,
            root,
            symbol: root,
            contractKey: identity.contractKey,
            conId: identity.conId,
            localSymbol: identity.localSymbol,
            expiry: identity.expiry,
            tradingDay: futuresMarketHours.buildFuturesSessionMetadata(c.ts)?.tradingDay || null,
            session: futuresMarketHours.buildFuturesSessionMetadata(c.ts)?.sessionId || null,
            provenanceQuality: contractProvenance.PROVENANCE.EXACT,
            provider: 'ibkr',
          }));
        if (agg2m.length) {
          const candlesSaved = store.saveCandles2m(root, date, agg2m, { contractKey: identity.contractKey });
          if (candlesSaved === -1) throw new Error('contract_provenance_candle_store_rejected');
        }
      } catch (err) {
        state.lastError = `persist_failed: ${err.message}`;
      }
    }
    state.lastPersistAt = nowIso();
    try {
      if (typeof store.saveIbImportManifest === 'function') {
        store.saveIbImportManifest(root, {
          root,
          contract: contract || null,
      dates: [...new Set([...byPartition.values()].map((entry) => entry.date))].sort(),
          barCount1m: state.bars1m.length,
          importedAt: nowIso(),
          provider: 'ibkr',
        });
      }
    } catch (_) { /* manifest är best effort */ }
  }

  async function refreshRoot(root, { duration = '1800 S', persist = true } = {}) {
    const state = getCandleState(root);
    try {
      const result = await adapter.fetchHistoricalBars({ root, barSize: '1 min', duration });
      state.lastRefreshAt = nowIso();
      if (!result.ok) {
        state.lastRefreshOk = false;
        state.lastError = result.error || 'historical_failed';
        return { ok: false, error: state.lastError };
      }
      mergeBars(state, result.bars, result.contract || {});
      state.lastRefreshOk = true;
      state.lastError = null;
      if (persist && CANDLE_ROOTS.includes(String(root || '').trim().toUpperCase())) {
        persistBars(root, result.contract);
      }
      return { ok: true, bars: result.bars.length };
    } catch (err) {
      state.lastRefreshAt = nowIso();
      state.lastRefreshOk = false;
      state.lastError = err.message;
      return { ok: false, error: err.message };
    }
  }

  async function backfillRoot(root, options = {}) {
    const state = getCandleState(root);
    const result = await refreshRoot(root, { duration: `${Math.max(1, backfillDays)} D`, ...options });
    if (result.ok) state.backfillDone = true;
    return result;
  }

  async function refreshAllOnce() {
    const results = {};
    for (const root of QUOTE_ROOTS) {
      const state = getCandleState(root);
      const persist = CANDLE_ROOTS.includes(root);
      results[root] = state.backfillDone
        ? await refreshRoot(root, { persist })
        : await backfillRoot(root, { persist });
    }
    return results;
  }

  async function start() {
    if (!isEnabled()) return { ok: false, error: 'ib_futures_data_disabled' };
    if (started) return { ok: true, alreadyStarted: true };
    started = true;
    startedAt = nowIso();
    const adapterOk = await adapter.start();
    if (!adapterOk) return { ok: false, error: 'ib_adapter_connection_failed', adapterStatus: adapter.getStatus() };
    // Initial backfill — MUST complete before scheduler starts querying candles (60s startup delay is not enough).
    await refreshAllOnce().catch(() => {});
    // löpande refresh. Fel isoleras per instrument.
    refreshTimer = setInterval(() => {
      refreshAllOnce().catch(() => {});
    }, refreshIntervalMs);
    if (refreshTimer.unref) refreshTimer.unref();
    return { ok: true };
  }

  function stop() {
    started = false;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  // Härkomst- och kvalitetsformen delas med candleWindow, så att en quote och
  // ett candle aldrig kan beskriva sin källa på olika sätt.
  const buildSourceMeta = candleWindow.buildSourceMeta;

  const buildQuality = candleWindow.buildQuality;
  const DATA_SAFETY = candleWindow.DATA_SAFETY;

  function getQuote(root, now = new Date()) {
    if (!isEnabled()) return null;
    const raw = adapter.getQuote(root);
    if (!raw) return null;
    const catalogMeta = futuresContractCatalog.getContract(root) || {};
    const reasons = [];
    if (raw.staleAgeMs == null || raw.staleAgeMs > QUOTE_FRESH_MS) reasons.push('stale_quote');
    if (!raw.conId) reasons.push('contract_unresolved');
    if (raw.last == null && raw.bid == null && raw.close == null) reasons.push('no_price');
    if (!raw.connected) reasons.push('ib_disconnected');
    return {
      instrument: raw.root,
      root: raw.root,
      symbol: raw.root,
      localSymbol: raw.localSymbol,
      conId: raw.conId,
      expiry: raw.expiry,
      exchange: raw.exchange,
      currency: raw.currency,
      last: raw.last,
      bid: raw.bid,
      ask: raw.ask,
      close: raw.close,
      spread: raw.spread,
      volume: raw.volume,
      tickSize: catalogMeta.tickSize ?? 0.25,
      marketDataType: raw.marketDataType,
      marketDataTypeLabel: raw.marketDataTypeLabel,
      updatedAt: raw.updatedAt,
      staleAgeMs: raw.staleAgeMs,
      generatedAt: nowIso(now),
      source: buildSourceMeta(raw, 'realtime'),
      quality: buildQuality({
        staleAgeMs: raw.staleAgeMs,
        timestampValid: raw.updatedAt != null,
        contractValid: Boolean(raw.conId),
        volumeValid: raw.volume != null,
        reasons,
      }),
      safety: DATA_SAFETY,
    };
  }

  function getLatestHistoricalQuote(root, { now = new Date() } = {}) {
    const key = String(root || '').trim().toUpperCase();
    if (!isEnabled() || !QUOTE_ROOTS.includes(key)) return null;
    const state = getCandleState(key);
    const latest = state.bars1m[state.bars1m.length - 1] || null;
    if (!latest || latest.close == null || !latest.timestamp) return null;
    const contractInfo = adapter.getQuote(key) || {};
    const catalogMeta = futuresContractCatalog.getContract(key) || {};
    const nowMs = new Date(now).getTime();
    const tsMs = new Date(latest.timestamp).getTime();
    const staleAgeMs = Number.isFinite(nowMs) && Number.isFinite(tsMs)
      ? Math.max(0, nowMs - tsMs)
      : null;
    return {
      instrument: key,
      root: key,
      symbol: key,
      localSymbol: contractInfo.localSymbol || null,
      conId: contractInfo.conId || null,
      expiry: contractInfo.expiry || null,
      exchange: contractInfo.exchange || 'CME',
      currency: contractInfo.currency || 'USD',
      last: latest.close,
      bid: null,
      ask: null,
      close: latest.close,
      spread: null,
      volume: latest.volume ?? null,
      tickSize: catalogMeta.tickSize ?? 0.25,
      marketDataType: null,
      marketDataTypeLabel: 'historical',
      updatedAt: latest.timestamp,
      staleAgeMs,
      generatedAt: nowIso(now),
      source: buildSourceMeta({ delayed: false }, 'historical'),
      quality: buildQuality({
        staleAgeMs,
        timestampValid: true,
        contractValid: Boolean(contractInfo.conId),
        closedCandleValid: true,
        volumeValid: latest.volume != null,
        reasons: contractInfo.conId ? [] : ['contract_unresolved'],
      }),
      safety: DATA_SAFETY,
    };
  }

  function isQuoteFresh(root, now = new Date()) {
    const raw = adapter.getQuote(root);
    if (!raw || !raw.updatedAt) return false;
    const age = new Date(now).getTime() - new Date(raw.updatedAt).getTime();
    return age >= 0 ? age <= QUOTE_FRESH_MS : false;
  }

  // normalizeBar bor numera i candleWindow, dit både live-feeden och den
  // historiska feeden går. Den lokala kopian är borttagen med flit: två
  // radformare för samma rad är två datamodeller.

  // Closed candles + max ETT tydligt öppet candle per timeframe.
  function getCandles(root, { timeframe = '1m', limit = 500, now = new Date() } = {}) {
    const key = String(root || '').trim().toUpperCase();
    const minutes = timeframeMinutes(timeframe);
    if (!minutes) return { ok: false, error: `unsupported_timeframe_${timeframe}`, candles: [], openCandle: null };
    if (!isEnabled()) return { ok: false, error: 'ib_futures_data_disabled', candles: [], openCandle: null };
    if (!CANDLE_ROOTS.includes(key)) {
      return { ok: false, error: 'candles_not_tracked_for_root', root: key, candles: [], openCandle: null };
    }
    const state = getCandleState(key);
    const contractInfo = adapter.getQuote(key) || {};
    const contract = {
      conId: contractInfo.conId || null,
      localSymbol: contractInfo.localSymbol || null,
      expiry: contractInfo.expiry || null,
      exchange: contractInfo.exchange || 'CME',
      currency: contractInfo.currency || 'USD',
    };
    const bars1m = state.bars1m.map((b) => ({
      ts: b.timestamp, t: b.timestamp,
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume, tradeCount: b.tradeCount,
    }));

    // Fönstret byggs av candleWindow — exakt samma funktion som den historiska
    // feeden anropar. Ingen egen aggregering, ingen egen stängningsregel.
    const window = candleWindow.buildCandleWindow({ root: key, bars1m, timeframe, limit, now, contract });
    return {
      ...window,
      lastRefreshAt: state.lastRefreshAt,
      lastError: state.lastError,
    };
  }

  // Jämför lokal 1m→Nm-aggregering mot IB:s direkta bars (verifiering/tester).
  async function verifyAggregationAgainstIb(root, { barSize = '2 mins', timeframe = '2m', sample = 20 } = {}) {
    const local = getCandles(root, { timeframe, limit: sample + 5 });
    const ib = await adapter.fetchHistoricalBars({ root, barSize, duration: '3600 S' });
    if (!local.ok || !ib.ok) {
      return { ok: false, error: local.ok ? ib.error : local.error };
    }
    const ibByTs = new Map(ib.bars.map((b) => [b.timestamp, b]));
    let compared = 0;
    let mismatches = 0;
    const diffs = [];
    for (const candle of local.candles.slice(-sample)) {
      const ibBar = ibByTs.get(candle.timestamp);
      if (!ibBar) continue;
      compared += 1;
      const closeDiff = Math.abs(Number(candle.close) - Number(ibBar.close));
      const highDiff = Math.abs(Number(candle.high) - Number(ibBar.high));
      const lowDiff = Math.abs(Number(candle.low) - Number(ibBar.low));
      if (closeDiff > 0.0001 || highDiff > 0.0001 || lowDiff > 0.0001) {
        mismatches += 1;
        diffs.push({ timestamp: candle.timestamp, closeDiff, highDiff, lowDiff });
      }
    }
    return { ok: true, root, timeframe, compared, mismatches, matchRate: compared ? (compared - mismatches) / compared : null, diffs: diffs.slice(0, 5) };
  }

  function getStatus(now = new Date()) {
    const adapterStatus = adapter.getStatus();
    const quotes = {};
    for (const root of QUOTE_ROOTS) {
      const q = getQuote(root, now) || getLatestHistoricalQuote(root, { now });
      quotes[root] = q ? {
        localSymbol: q.localSymbol,
        conId: q.conId,
        expiry: q.expiry,
        last: q.last,
        bid: q.bid,
        ask: q.ask,
        spread: q.spread,
        volume: q.volume,
        marketDataTypeLabel: q.marketDataTypeLabel,
        updatedAt: q.updatedAt,
        staleAgeMs: q.staleAgeMs,
        quality: q.quality,
      } : null;
    }
    const candles = {};
    for (const root of CANDLE_ROOTS) {
      const state = getCandleState(root);
      const summary = {};
      for (const timeframe of SUPPORTED_TIMEFRAMES) {
        const c = getCandles(root, { timeframe, limit: 10, now });
        summary[timeframe] = {
          ok: c.ok,
          closedCount: c.ok ? c.count : 0,
          latestClosedTimestamp: c.ok ? c.latestClosedTimestamp : null,
          hasOpenCandle: c.ok ? Boolean(c.openCandle) : false,
        };
      }
      candles[root] = {
        bars1mInMemory: state.bars1m.length,
        firstBarTimestamp: state.bars1m[0]?.timestamp || null,
        latestBarTimestamp: state.bars1m[state.bars1m.length - 1]?.timestamp || null,
        backfillDone: state.backfillDone,
        lastRefreshAt: state.lastRefreshAt,
        lastRefreshOk: state.lastRefreshOk,
        lastError: state.lastError,
        lastPersistAt: state.lastPersistAt,
        timeframes: summary,
      };
    }
    return {
      ok: true,
      enabled: isEnabled(),
      started,
      startedAt,
      generatedAt: nowIso(now),
      refreshIntervalMs,
      backfillDays,
      persistEnabled,
      adapter: {
        connected: adapterStatus.connected,
        host: adapterStatus.host,
        port: adapterStatus.port,
        clientId: adapterStatus.clientId,
        serverVersion: adapterStatus.serverVersion,
        connectedAt: adapterStatus.connectedAt,
        reconnectCount: adapterStatus.reconnectCount,
        marketDataTypeLabel: adapterStatus.marketDataTypeLabel,
        managedAccounts: adapterStatus.managedAccounts,
        contracts: adapterStatus.contracts,
        lastErrors: adapterStatus.lastErrors,
        pacing: adapterStatus.pacing,
      },
      quotes,
      candles,
      ...SAFETY,
    };
  }

  // Kompakt status för desk-runtime (får aldrig bli tung).
  function getStatusSummary(now = new Date()) {
    if (!isEnabled()) {
      return { enabled: false, started: false, connected: false, source: 'disabled' };
    }
    const adapterStatus = adapter.getStatus();
    const mnq = getQuote('MNQ', now);
    const mes = getQuote('MES', now);
    return {
      enabled: true,
      started,
      connected: adapterStatus.connected,
      marketDataTypeLabel: adapterStatus.marketDataTypeLabel,
      reconnectCount: adapterStatus.reconnectCount,
      mnqStaleAgeMs: mnq?.staleAgeMs ?? null,
      mesStaleAgeMs: mes?.staleAgeMs ?? null,
      mnqLocalSymbol: mnq?.localSymbol ?? null,
      mesLocalSymbol: mes?.localSymbol ?? null,
      source: adapterStatus.connected ? 'ibkr' : 'ibkr_disconnected',
    };
  }

  return {
    SAFETY,
    CANDLE_ROOTS,
    QUOTE_ROOTS,
    SUPPORTED_TIMEFRAMES,
    QUOTE_FRESH_MS,
    isEnabled,
    start,
    stop,
    isStarted: () => started,
    refreshAllOnce,
    // Exponerade så att en anropare kan ladda barer UTAN att skriva till
    // marknadsdatalagret (persist: false). Paritetstestet kräver det, och
    // backfill-tjänsten behöver samma ingång.
    refreshRoot,
    backfillRoot,
    getQuote,
    getLatestHistoricalQuote,
    isQuoteFresh,
    getCandles,
    getStatus,
    getStatusSummary,
    verifyAggregationAgainstIb,
    adapter,
  };
}

const defaultFuturesMarketDataService = createFuturesMarketDataService();

module.exports = {
  SAFETY,
  CANDLE_ROOTS,
  QUOTE_ROOTS,
  SUPPORTED_TIMEFRAMES,
  createFuturesMarketDataService,
  defaultFuturesMarketDataService,
};
