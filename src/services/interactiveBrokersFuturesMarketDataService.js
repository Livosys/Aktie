'use strict';

/**
 * IB Paper FUTURES — market-data snapshot (Fas 3.2, read-only).
 *
 * Fetches a REAL price snapshot for resolved front-month futures contracts via
 * IB `reqMktData` (snapshot). Alpaca has no futures, so IB is the source.
 *
 * HARD RULES:
 *   - Read-only. reqMktData snapshot is a query. No order/submit/arm.
 *   - GATED OFF by default via env IB_FUTURES_MARKETDATA_ENABLED. When disabled
 *     (default) NOTHING connects to IB and no price is produced.
 *   - Never invents a price. If IB returns nothing, or the snapshot is stale,
 *     the price is treated as MISSING and blocker `no_futures_market_data`
 *     stays. Delayed/frozen data is clearly marked (priceType), never presented
 *     as realtime.
 *   - Only prices contracts that already have a VERIFIED conId (from Fas 3.1).
 *     Unverified contracts are skipped with `no_verified_contract`.
 *   - Never touches IB_PAPER_SUBMIT_ROUTES_ENABLED or any submit path. Own
 *     clientId (IB_FUTURES_MD_CLIENT_ID) so it can't collide with other conns.
 *
 * Pure core (pickPrice / classifyDataType / assessStaleness /
 * buildMarketDataResult / getMarketDataForContracts) is connector-injectable and
 * fully mock-tested; `@stoqey/ib` is lazy-required only in the real connector.
 */

const MARKETDATA_FLAG = 'IB_FUTURES_MARKETDATA_ENABLED';
const MD_CLIENT_ID_FLAG = 'IB_FUTURES_MD_CLIENT_ID';
const MD_TYPE_FLAG = 'IB_FUTURES_MD_TYPE'; // 1 realtime, 2 frozen, 3 delayed, 4 delayed-frozen
const DEFAULT_MAX_STALENESS_SECONDS = 60;

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// IB marketDataType → label. Realtime(1)/frozen(2)/delayed(3)/delayed-frozen(4).
const DATA_TYPE_LABEL = Object.freeze({ 1: 'realtime', 2: 'frozen', 3: 'delayed', 4: 'delayed_frozen' });

function envEnabled() {
  return ['true', '1', 'yes', 'on'].includes(
    String(process.env[MARKETDATA_FLAG] ?? '').trim().toLowerCase(),
  );
}

function safeNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classifyDataType(marketDataType) {
  return DATA_TYPE_LABEL[Number(marketDataType)] || 'unknown';
}

/**
 * Choose a usable price from collected ticks. Pure.
 * Priority: last → mid(bid,ask) → close. Returns null if none usable.
 */
function pickPrice(ticks = {}) {
  const last = safeNum(ticks.last);
  const bid = safeNum(ticks.bid);
  const ask = safeNum(ticks.ask);
  const close = safeNum(ticks.close);
  if (last !== null && last > 0) return { price: last, priceField: 'last', last, bid, ask, close };
  if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    return { price: Math.round(((bid + ask) / 2) * 1e6) / 1e6, priceField: 'mid', last, bid, ask, close };
  }
  if (close !== null && close > 0) return { price: close, priceField: 'close', last, bid, ask, close };
  return { price: null, priceField: null, last, bid, ask, close };
}

/**
 * Staleness of our snapshot (how long ago WE received it) — NOT the market
 * delay. Delayed data is fresh-at-fetch; its market-delay is priceType. Pure.
 */
function assessStaleness(receivedAt, now, maxStalenessSeconds = DEFAULT_MAX_STALENESS_SECONDS) {
  const recv = receivedAt ? new Date(receivedAt).getTime() : null;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (recv === null || Number.isNaN(recv)) return { stalenessSeconds: null, stale: true };
  const stalenessSeconds = Math.max(0, Math.round((nowMs - recv) / 1000));
  return { stalenessSeconds, stale: stalenessSeconds > maxStalenessSeconds };
}

/**
 * Assemble the market-data record for one contract. Pure.
 * `snapshot` = { ticks, marketDataType, receivedAt } or null; `error` = failure.
 */
function buildMarketDataResult(contract, snapshot, { now = new Date(), maxStalenessSeconds = DEFAULT_MAX_STALENESS_SECONDS, error = null } = {}) {
  const base = {
    root: contract.root,
    symbol: contract.symbol || contract.root,
    conId: contract.conId != null ? contract.conId : null,
    localSymbol: contract.localSymbol || null,
    price: null,
    priceField: null,
    priceType: null,
    bid: null,
    ask: null,
    last: null,
    close: null,
    receivedAt: null,
    stalenessSeconds: null,
    stale: true,
    hasUsablePrice: false,
    marketDataBlockers: [],
  };

  // Cannot price a contract without a verified conId.
  if (contract.conId == null || contract.contractMonthVerified !== true) {
    return { ...base, marketDataBlockers: ['no_verified_contract', 'no_futures_market_data'] };
  }
  if (error) {
    return { ...base, marketDataBlockers: ['market_data_unavailable', 'no_futures_market_data'], error: String(error) };
  }
  if (!snapshot) {
    return { ...base, marketDataBlockers: ['no_futures_market_data'] };
  }

  const picked = pickPrice(snapshot.ticks);
  const priceType = classifyDataType(snapshot.marketDataType);
  const { stalenessSeconds, stale } = assessStaleness(snapshot.receivedAt, now, maxStalenessSeconds);
  const hasUsablePrice = picked.price !== null && !stale;

  const blockers = [];
  if (picked.price === null) blockers.push('no_futures_market_data');
  else if (stale) blockers.push('stale_market_data', 'no_futures_market_data');
  // Delayed/frozen price is usable but flagged so downstream never treats it as realtime.
  if (picked.price !== null && (priceType === 'delayed' || priceType === 'delayed_frozen' || priceType === 'frozen')) {
    blockers.push('delayed_market_data');
  }

  return {
    ...base,
    price: picked.price,
    priceField: picked.priceField,
    priceType,
    bid: picked.bid,
    ask: picked.ask,
    last: picked.last,
    close: picked.close,
    receivedAt: snapshot.receivedAt ? new Date(snapshot.receivedAt).toISOString() : null,
    stalenessSeconds,
    stale,
    hasUsablePrice,
    marketDataBlockers: blockers,
  };
}

function gatedResult(contracts, generatedAt) {
  return {
    ok: true,
    readOnly: true,
    enabled: false,
    gated: true,
    source: 'gated_no_ib_query',
    note: `Marknadsdata är gated OFF (${MARKETDATA_FLAG} != true). Ingen IB-anslutning; inget pris hämtas.`,
    generatedAt,
    prices: (Array.isArray(contracts) ? contracts : []).map((c) => ({
      root: c.root,
      symbol: c.symbol || c.root,
      conId: c.conId != null ? c.conId : null,
      localSymbol: c.localSymbol || null,
      price: null,
      priceType: null,
      hasUsablePrice: false,
      marketDataBlockers: ['market_data_disabled', 'no_futures_market_data'],
    })),
    safety: { ...SAFETY },
  };
}

/**
 * Fetch market-data snapshots for a list of (Fas 3.1-resolved) contracts.
 * Connector-injectable & async.
 *
 * @param {object}   opts
 * @param {boolean}  opts.enabled
 * @param {object}   opts.connector - { fetchSnapshot(contract) => {ticks,marketDataType,receivedAt}, close?() }
 * @param {Array}    opts.contracts - resolved contracts (need conId + contractMonthVerified)
 * @param {Date}     opts.now
 * @param {number}   opts.maxStalenessSeconds
 */
async function getMarketDataForContracts(opts = {}) {
  const {
    enabled,
    connector = null,
    contracts = [],
    now = new Date(),
    maxStalenessSeconds = DEFAULT_MAX_STALENESS_SECONDS,
  } = opts;
  const isEnabled = enabled === undefined ? envEnabled() : enabled === true;
  const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString();

  if (!isEnabled) {
    return gatedResult(contracts, generatedAt);
  }
  if (!connector || typeof connector.fetchSnapshot !== 'function') {
    throw new Error('getMarketDataForContracts: enabled but no connector.fetchSnapshot provided');
  }

  const prices = [];
  try {
    for (const contract of contracts) {
      // Skip contracts without a verified conId — never fetch/guess a price for them.
      if (contract.conId == null || contract.contractMonthVerified !== true) {
        prices.push(buildMarketDataResult(contract, null, { now, maxStalenessSeconds }));
        continue;
      }
      try {
        const snapshot = await connector.fetchSnapshot(contract);
        prices.push(buildMarketDataResult(contract, snapshot, { now, maxStalenessSeconds }));
      } catch (err) {
        prices.push(buildMarketDataResult(contract, null, { now, maxStalenessSeconds, error: err?.message || String(err) }));
      }
    }
  } finally {
    if (connector && typeof connector.close === 'function') {
      try { await connector.close(); } catch (_) { /* best-effort */ }
    }
  }

  return {
    ok: true,
    readOnly: true,
    enabled: true,
    gated: false,
    source: 'ib_reqMktData',
    note: 'Snapshot via IB reqMktData (read-only). Delayed/frozen märks; stale/saknat pris blockeras.',
    generatedAt,
    maxStalenessSeconds,
    prices,
    safety: { ...SAFETY },
  };
}

/**
 * Real IB market-data connector (lazy-requires @stoqey/ib). Read-only snapshot.
 * Own clientId. Not exercised by unit tests (gated OFF + injected mock).
 */
function createIbMarketDataConnector(overrides = {}) {
  const host = String(overrides.host || process.env.IB_GATEWAY_HOST || '127.0.0.1');
  const port = Number(overrides.port || process.env.IB_GATEWAY_PORT || 4002);
  const clientId = Number(overrides.clientId || process.env[MD_CLIENT_ID_FLAG] || 0);
  const mdType = Number(overrides.marketDataType || process.env[MD_TYPE_FLAG] || 3); // default delayed
  const timeoutMs = Number(overrides.timeoutMs || 15000);

  // Map realtime + delayed tick types onto {bid,ask,last,close}.
  const TICK = { BID: 1, ASK: 2, LAST: 4, CLOSE: 9, D_BID: 66, D_ASK: 67, D_LAST: 68, D_CLOSE: 75 };

  async function fetchSnapshot(contract) {
    const { IBApi, EventName } = require('@stoqey/ib');
    return await new Promise((resolve, reject) => {
      const client = new IBApi({ host, port, clientId });
      const ticks = { bid: null, ask: null, last: null, close: null };
      let dataType = mdType;
      let settled = false;
      const reqId = 1;

      const cleanup = () => {
        for (const ev of ['connected', 'error', 'marketDataType', 'tickPrice', 'tickSnapshotEnd']) {
          try { client.removeAllListeners(EventName[ev]); } catch (_) {}
        }
        try { client.disconnect(); } catch (_) {}
      };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (err) reject(err);
        else resolve({ ticks, marketDataType: dataType, receivedAt: new Date().toISOString() });
      };
      const timer = setTimeout(() => finish(new Error(`reqMktData timeout for ${contract.root}`)), timeoutMs);

      client.on(EventName.error, (err, code) => {
        if (code && Number(code) >= 2100 && Number(code) < 2200) return; // benign info
        finish(err instanceof Error ? err : new Error(String(err)));
      });
      client.on(EventName.marketDataType, (_reqId, type) => { dataType = type; });
      client.on(EventName.tickPrice, (_reqId, field, price) => {
        const f = Number(field);
        const p = safeNum(price);
        if (p === null) return;
        if (f === TICK.BID || f === TICK.D_BID) ticks.bid = p;
        else if (f === TICK.ASK || f === TICK.D_ASK) ticks.ask = p;
        else if (f === TICK.LAST || f === TICK.D_LAST) ticks.last = p;
        else if (f === TICK.CLOSE || f === TICK.D_CLOSE) ticks.close = p;
      });
      client.on(EventName.tickSnapshotEnd, () => finish(null));
      client.on(EventName.connected, () => {
        try {
          if (typeof client.reqMarketDataType === 'function') client.reqMarketDataType(mdType);
          client.reqMktData(reqId, {
            conId: contract.conId,
            symbol: contract.root,
            secType: contract.secType || 'FUT',
            exchange: contract.exchange || 'CME',
            currency: contract.currency || 'USD',
            localSymbol: contract.localSymbol || undefined,
          }, '', true /* snapshot */, false, []);
        } catch (err) {
          finish(err);
        }
      });

      try { client.connect(); } catch (err) { finish(err); }
    });
  }

  return { fetchSnapshot, close: async () => {} };
}

/** Convenience: env-gated fetch using the real IB connector when enabled. */
async function getMarketData(opts = {}) {
  const enabled = opts.enabled === undefined ? envEnabled() : opts.enabled === true;
  const connector = enabled ? (opts.connector || createIbMarketDataConnector(opts)) : null;
  return getMarketDataForContracts({ ...opts, enabled, connector });
}

module.exports = {
  SAFETY,
  MARKETDATA_FLAG,
  envEnabled,
  getMarketDataForContracts,
  getMarketData,
  createIbMarketDataConnector,
  _internal: {
    classifyDataType,
    pickPrice,
    assessStaleness,
    buildMarketDataResult,
    gatedResult,
  },
};
