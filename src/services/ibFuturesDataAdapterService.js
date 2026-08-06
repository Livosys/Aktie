'use strict';

// READ-ONLY IB Futures Data Adapter (FAS 2 av FUTURES_DATA_LAYER.md).
//
// Enda modulen som pratar @stoqey/ib för FUTURES-MARKNADSDATA och read-only
// paper-account-summary. Absolut inga order-API:er: ingen placeOrder, ingen
// reqIds-för-order, ingen transmit, ingen cancel, ingen kontomutation.
//
// Hårda regler:
//   - Ingen anslutning startar vid require. start() måste kallas explicit
//     (server.js gör det endast när IB_FUTURES_DATA_ENABLED=true).
//   - Egen clientId (IB_FUTURES_DATA_CLIENT_ID, default 955) så att adaptern
//     aldrig krockar med readiness-checken (1) eller prober (957).
//   - Reconnect med backoff (aldrig aggressiv loop), request-timeouts och
//     pacing-guard (seriell kö med minsta paus) för historical requests.
//   - Front month löses alltid dynamiskt via reqContractDetails och cachas
//     med TTL — inga hårdkodade localSymbols/expiries.

const { IBApi, EventName } = require('@stoqey/ib');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  readOnly: true,
  source: 'ib_futures_data_adapter',
});

const DEFAULT_ROOTS = Object.freeze(['MNQ', 'MES', 'NQ', 'ES']);

const INFORMATIONAL_ERROR_CODES = new Set([2104, 2106, 2107, 2108, 2119, 2158]);

const MD_TYPE_LABELS = Object.freeze({ 1: 'realtime', 2: 'frozen', 3: 'delayed', 4: 'delayed_frozen' });

// Read-only account summary tags — inga mutationer, bara läsning.
const ACCOUNT_SUMMARY_TAGS = [
  'AccountType',
  'NetLiquidation',
  'TotalCashValue',
  'AvailableFunds',
  'BuyingPower',
  'UnrealizedPnL',
  'RealizedPnL',
  'MaintMarginReq',
  'InitMarginReq',
  'Cushion',
].join(',');

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

// IB historical endDateTime kräver explicit UTC-format (yyyymmdd-hh:mm:ss).
function toIbUtcDateTime(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    + ' UTC';
}

function maskAccountId(accountId) {
  const raw = String(accountId || '').trim();
  if (!raw) return null;
  if (raw.length <= 5) return `${raw.slice(0, 2)}***`;
  return `${raw.slice(0, 2)}***${raw.slice(-3)}`;
}

// IB paper/demo-konton börjar med DU (eller DF för FA-demo). Livekonton gör
// aldrig det — klassningen används för att VÄGRA välja livekonton.
function classifyAccountId(accountId) {
  const raw = String(accountId || '').trim().toUpperCase();
  if (!raw) return 'unknown';
  if (raw.startsWith('DU') || raw.startsWith('DF')) return 'paper';
  return 'live_or_unknown';
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function createIbFuturesDataAdapterService(options = {}) {
  const config = {
    host: options.host || process.env.IB_GATEWAY_HOST || '127.0.0.1',
    port: Number(options.port || process.env.IB_GATEWAY_PORT || 4002),
    clientId: Number(options.clientId || envInt('IB_FUTURES_DATA_CLIENT_ID', 955)),
    connectTimeoutMs: Number(options.connectTimeoutMs || 12000),
    requestTimeoutMs: Number(options.requestTimeoutMs || 30000),
    historicalPacingMs: Number(options.historicalPacingMs || 2500),
    reconnectBaseMs: Number(options.reconnectBaseMs || 5000),
    reconnectMaxMs: Number(options.reconnectMaxMs || 5 * 60 * 1000),
    contractCacheTtlMs: Number(options.contractCacheTtlMs || 6 * 60 * 60 * 1000),
    marketDataType: Number(options.marketDataType || envInt('IB_FUTURES_MD_TYPE', 1)),
    // En explicit angiven lista respekteras som den är — även tom. Tidigare föll
    // en tom array igenom till DEFAULT_ROOTS, så `roots: []` betydde i praktiken
    // "alla fyra": start() prenumererade på MNQ/MES/NQ/ES och löste ett kontrakt
    // per rot. Bara en utelämnad `roots` ska ge standarduppsättningen.
    roots: Array.isArray(options.roots) ? options.roots.slice() : DEFAULT_ROOTS.slice(),
  };
  const ibFactory = options.ibFactory || ((cfg) => new IBApi({ host: cfg.host, port: cfg.port, clientId: cfg.clientId }));

  let ib = null;
  let started = false;
  let connected = false;
  let connecting = false;
  let stopRequested = false;
  let reconnectTimer = null;
  let reconnectCount = 0;
  let reconnectDelayMs = config.reconnectBaseMs;
  let connectedAt = null;
  let serverVersion = null;
  let managedAccounts = [];
  let currentMarketDataType = null;
  let nextReqId = 41000;

  const lastErrors = []; // ring buffer {at, code, message, reqId}
  const pending = new Map(); // reqId -> {kind, rows, done, timer, extra}
  const quoteState = new Map(); // root -> quote cache
  const quoteReqByReqId = new Map(); // reqId -> root
  const quoteSubscribeInFlight = new Map(); // root -> pågående subscribe-promise
  const contractCache = new Map(); // root -> {contract, resolvedAt, all}

  // Seriell pacing-kö för historical/contract/account-requests.
  let requestChain = Promise.resolve();
  let lastPacedRequestAt = 0;

  function recordError(code, message, reqId) {
    lastErrors.push({ at: nowIso(), code: Number(code) || null, message: String(message || ''), reqId: reqId ?? null });
    if (lastErrors.length > 25) lastErrors.shift();
  }

  function track(reqId, kind, { timeoutMs = config.requestTimeoutMs, onTimeoutResult = null } = {}) {
    return new Promise((resolve) => {
      const entry = {
        kind,
        rows: [],
        done: (result) => {
          clearTimeout(entry.timer);
          pending.delete(reqId);
          resolve(result);
        },
      };
      entry.timer = setTimeout(() => {
        entry.done(onTimeoutResult || { ok: false, error: `timeout_after_${timeoutMs}ms`, timedOut: true, rows: entry.rows });
      }, timeoutMs);
      pending.set(reqId, entry);
    });
  }

  function clearAllPending(reason) {
    for (const [reqId, entry] of [...pending.entries()]) {
      entry.done({ ok: false, error: reason, rows: entry.rows });
      pending.delete(reqId);
    }
  }

  function scheduleReconnect() {
    if (stopRequested || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, config.reconnectMaxMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectCount += 1;
      connectOnce().catch(() => {});
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function attachHandlers(client) {
    client.on(EventName.error, (err, code, reqId) => {
      if (client !== ib) return; // sent event från gammal, ersatt klient
      const message = err instanceof Error ? err.message : String(err);
      const numCode = Number(code);
      const informational = INFORMATIONAL_ERROR_CODES.has(numCode);
      const entry = pending.get(reqId);
      if (entry && !informational) {
        entry.done({ ok: false, error: message, code: numCode || null, rows: entry.rows });
        return;
      }
      if (!informational) recordError(numCode, message, reqId);
      // Socketfel utan aktiv request → tappa anslutningen och boka reconnect.
      if (!connected && !connecting && !stopRequested) scheduleReconnect();
    });
    client.on(EventName.disconnected, () => {
      if (client !== ib) return; // sent event från gammal, ersatt klient
      const wasConnected = connected;
      connected = false;
      connecting = false;
      clearAllPending('ib_disconnected');
      // Reconnect skapar en NY IBApi-klient — streaming-subscriptions dör med
      // socketen. Utan nollställning här gör subscribeQuote() early-return
      // (alreadySubscribed) och reqMktData skickas aldrig på nya klienten →
      // permanent frusen tick-ström.
      for (const [, state] of quoteState) {
        if (state.reqId != null) quoteReqByReqId.delete(state.reqId);
        state.reqId = null;
        state.subscribed = false;
      }
      if (wasConnected && !stopRequested) {
        recordError(null, 'ib_disconnected');
        scheduleReconnect();
      }
    });
    client.on(EventName.managedAccounts, (accounts) => {
      managedAccounts = String(accounts || '').split(',').map((s) => s.trim()).filter(Boolean);
    });
    client.on(EventName.marketDataType, (reqId, mdType) => {
      currentMarketDataType = mdType;
      const root = quoteReqByReqId.get(reqId);
      if (root && quoteState.has(root)) quoteState.get(root).marketDataType = mdType;
    });
    client.on(EventName.tickPrice, (reqId, field, value) => {
      const root = quoteReqByReqId.get(reqId);
      if (!root) return;
      const q = quoteState.get(root);
      if (!q || !(value > 0)) return;
      // 1/66=bid 2/67=ask 4/68=last 9/75=close (66-76 = delayed-varianter)
      if (field === 4 || field === 68) q.last = value;
      else if (field === 1 || field === 66) q.bid = value;
      else if (field === 2 || field === 67) q.ask = value;
      else if (field === 9 || field === 75) q.close = value;
      else return;
      if (field >= 66 && field <= 76) q.sawDelayedField = true;
      q.updatedAt = Date.now();
    });
    client.on(EventName.tickSize, (reqId, field, value) => {
      const root = quoteReqByReqId.get(reqId);
      if (!root) return;
      const q = quoteState.get(root);
      if (!q || !(value >= 0)) return;
      // 8/74 = dagsvolym
      if (field === 8 || field === 74) {
        q.volume = value;
        q.updatedAt = Date.now();
      }
    });
    client.on(EventName.contractDetails, (reqId, details) => {
      const entry = pending.get(reqId);
      if (entry) entry.rows.push(details);
    });
    client.on(EventName.contractDetailsEnd, (reqId) => {
      const entry = pending.get(reqId);
      if (entry) entry.done({ ok: true, rows: entry.rows });
    });
    client.on(EventName.historicalData, (reqId, time, open, high, low, close, volume, count) => {
      const entry = pending.get(reqId);
      if (!entry) return;
      if (String(time).startsWith('finished')) {
        entry.done({ ok: true, rows: entry.rows });
        return;
      }
      entry.rows.push({ time, open, high, low, close, volume, count });
    });
    client.on(EventName.accountSummary, (reqId, account, tag, value, currency) => {
      const entry = pending.get(reqId);
      if (entry) entry.rows.push({ account, tag, value, currency });
    });
    client.on(EventName.accountSummaryEnd, (reqId) => {
      const entry = pending.get(reqId);
      if (entry) entry.done({ ok: true, rows: entry.rows });
    });
  }

  function connectOnce() {
    if (connected || connecting || stopRequested) return Promise.resolve(connected);
    connecting = true;
    ib = ibFactory(config);
    attachHandlers(ib);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        connecting = false;
        recordError(null, `ib_connect_timeout_after_${config.connectTimeoutMs}ms`);
        try { ib.disconnect(); } catch (_) { /* ignore */ }
        scheduleReconnect();
        resolve(false);
      }, config.connectTimeoutMs);
      ib.once(EventName.nextValidId, () => {
        // nextValidId används ENBART som "handshake klar"-signal — aldrig för order.
        clearTimeout(timer);
        connecting = false;
        connected = true;
        connectedAt = nowIso();
        reconnectDelayMs = config.reconnectBaseMs;
        try { ib.reqMarketDataType(config.marketDataType); } catch (_) { /* ignore */ }
        resubscribeQuotes();
        resolve(true);
      });
      ib.once(EventName.server, (version) => { serverVersion = version; });
      try {
        ib.connect();
      } catch (err) {
        clearTimeout(timer);
        connecting = false;
        recordError(null, err.message);
        scheduleReconnect();
        resolve(false);
      }
    });
  }

  function resubscribeQuotes() {
    for (const root of config.roots) {
      subscribeQuote(root).catch(() => {});
    }
  }

  async function pacedRequest(fn) {
    const run = async () => {
      const sinceLast = Date.now() - lastPacedRequestAt;
      if (sinceLast < config.historicalPacingMs) {
        await new Promise((r) => {
          const t = setTimeout(r, config.historicalPacingMs - sinceLast);
          if (t.unref) t.unref();
        });
      }
      lastPacedRequestAt = Date.now();
      return fn();
    };
    const next = requestChain.then(run, run);
    requestChain = next.catch(() => {});
    return next;
  }

  async function ensureConnected() {
    if (connected) return true;
    if (!started) return false;
    return connectOnce();
  }

  async function resolveContract(root, { forceRefresh = false } = {}) {
    const key = String(root || '').trim().toUpperCase();
    if (!key) return { ok: false, error: 'invalid_root' };
    const cached = contractCache.get(key);
    if (!forceRefresh && cached && (Date.now() - cached.resolvedAtMs) < config.contractCacheTtlMs) {
      return { ok: true, cached: true, ...cached };
    }
    if (!(await ensureConnected())) return { ok: false, error: 'ib_not_connected' };
    return pacedRequest(async () => {
      const reqId = nextReqId++;
      const promise = track(reqId, 'contractDetails');
      try {
        ib.reqContractDetails(reqId, { symbol: key, secType: 'FUT', exchange: 'CME', currency: 'USD' });
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const result = await promise;
      if (!result.ok || !result.rows.length) {
        return { ok: false, error: result.error || 'no_contract_details', code: result.code || null };
      }
      const contracts = result.rows
        .map((d) => ({ details: d, contract: d.contract || d }))
        .filter((row) => row.contract && row.contract.lastTradeDateOrContractMonth)
        .sort((a, b) => String(a.contract.lastTradeDateOrContractMonth)
          .localeCompare(String(b.contract.lastTradeDateOrContractMonth)));
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const frontRow = contracts.find((row) => String(row.contract.lastTradeDateOrContractMonth).slice(0, 8) >= today)
        || contracts[0];
      if (!frontRow) return { ok: false, error: 'no_valid_contract' };
      const c = frontRow.contract;
      const entry = {
        contract: {
          root: key,
          conId: c.conId,
          localSymbol: c.localSymbol || null,
          tradingClass: c.tradingClass || frontRow.details?.contract?.tradingClass || null,
          expiry: String(c.lastTradeDateOrContractMonth || '').slice(0, 8) || null,
          lastTradeDateOrContractMonth: c.lastTradeDateOrContractMonth || null,
          exchange: c.exchange || 'CME',
          currency: c.currency || 'USD',
          secType: 'FUT',
          multiplier: c.multiplier || frontRow.details?.contract?.multiplier || null,
        },
        contractCount: contracts.length,
        resolvedAt: nowIso(),
        resolvedAtMs: Date.now(),
      };
      contractCache.set(key, entry);
      return { ok: true, cached: false, ...entry };
    });
  }

  function subscribeQuote(root) {
    const key = String(root || '').trim().toUpperCase();
    // In-flight-dedupe: samtidiga anrop för samma root (t.ex. resubscribe efter
    // reconnect parallellt med refresh-loopen) får dela en subscription i
    // stället för att skicka dubbla reqMktData.
    const inFlight = quoteSubscribeInFlight.get(key);
    if (inFlight) return inFlight;
    const promise = doSubscribeQuote(key)
      .finally(() => { quoteSubscribeInFlight.delete(key); });
    quoteSubscribeInFlight.set(key, promise);
    return promise;
  }

  async function doSubscribeQuote(key) {
    const resolved = await resolveContract(key);
    if (!resolved.ok) return resolved;
    if (!(await ensureConnected())) return { ok: false, error: 'ib_not_connected' };
    const existing = quoteState.get(key);
    if (existing && existing.subscribed && existing.conId === resolved.contract.conId && connected) {
      return { ok: true, alreadySubscribed: true };
    }
    // Avsluta ev. gammal subscription (t.ex. efter rollover till ny conId).
    if (existing && existing.reqId != null) {
      try { ib.cancelMktData(existing.reqId); } catch (_) { /* ignore */ }
      quoteReqByReqId.delete(existing.reqId);
    }
    const reqId = nextReqId++;
    const state = {
      root: key,
      reqId,
      conId: resolved.contract.conId,
      contract: resolved.contract,
      last: existing?.last ?? null,
      bid: existing?.bid ?? null,
      ask: existing?.ask ?? null,
      close: existing?.close ?? null,
      volume: existing?.volume ?? null,
      marketDataType: existing?.marketDataType ?? null,
      sawDelayedField: false,
      updatedAt: existing?.updatedAt ?? null,
      subscribed: true,
      subscribedAt: nowIso(),
    };
    quoteState.set(key, state);
    quoteReqByReqId.set(reqId, key);
    try {
      // Streaming (snapshot=false) read-only marknadsdata — inga order-fält.
      ib.reqMktData(reqId, {
        conId: resolved.contract.conId,
        exchange: resolved.contract.exchange,
        secType: 'FUT',
        symbol: key,
        currency: resolved.contract.currency,
      }, '', false, false);
    } catch (err) {
      state.subscribed = false;
      return { ok: false, error: err.message };
    }
    return { ok: true };
  }

  function getQuote(root) {
    const key = String(root || '').trim().toUpperCase();
    const q = quoteState.get(key);
    if (!q) return null;
    const updatedAtMs = q.updatedAt || null;
    return {
      root: key,
      conId: q.conId,
      localSymbol: q.contract?.localSymbol || null,
      expiry: q.contract?.expiry || null,
      exchange: q.contract?.exchange || null,
      currency: q.contract?.currency || null,
      last: q.last,
      bid: q.bid,
      ask: q.ask,
      close: q.close,
      volume: q.volume,
      spread: (q.bid != null && q.ask != null) ? Number((q.ask - q.bid).toFixed(4)) : null,
      marketDataType: q.marketDataType,
      marketDataTypeLabel: MD_TYPE_LABELS[q.marketDataType] || 'unknown',
      delayed: q.sawDelayedField === true || q.marketDataType === 3 || q.marketDataType === 4,
      updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
      staleAgeMs: updatedAtMs ? Date.now() - updatedAtMs : null,
      connected,
    };
  }

  async function fetchHistoricalBars({ root, barSize = '1 min', duration = '1 D', endDateTime = null, useRth = 0 } = {}) {
    const key = String(root || '').trim().toUpperCase();
    const resolved = await resolveContract(key);
    if (!resolved.ok) return { ok: false, error: resolved.error || 'contract_unresolved', bars: [] };
    if (!(await ensureConnected())) return { ok: false, error: 'ib_not_connected', bars: [] };
    return pacedRequest(async () => {
      const reqId = nextReqId++;
      const promise = track(reqId, 'historical');
      const end = endDateTime instanceof Date ? toIbUtcDateTime(endDateTime) : (endDateTime || '');
      try {
        // formatDate=2 → epoch-sekunder; keepUpToDate=false → endast stängda data.
        ib.reqHistoricalData(reqId, {
          conId: resolved.contract.conId,
          exchange: resolved.contract.exchange,
          secType: 'FUT',
          symbol: key,
          currency: resolved.contract.currency,
        }, end, duration, barSize, 'TRADES', useRth, 2, false);
      } catch (err) {
        return { ok: false, error: err.message, bars: [] };
      }
      const result = await promise;
      return {
        ok: result.ok === true,
        error: result.ok ? null : (result.error || 'historical_failed'),
        code: result.code || null,
        timedOut: result.timedOut === true,
        contract: resolved.contract,
        barSize,
        duration,
        bars: (result.rows || []).map((row) => ({
          epoch: Number(row.time),
          timestamp: Number.isFinite(Number(row.time)) ? new Date(Number(row.time) * 1000).toISOString() : null,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
          tradeCount: Number.isFinite(Number(row.count)) ? Number(row.count) : null,
        })).filter((b) => b.timestamp),
      };
    });
  }

  async function fetchAccountSummary() {
    if (!(await ensureConnected())) return { ok: false, error: 'ib_not_connected', rows: [] };
    return pacedRequest(async () => {
      const reqId = nextReqId++;
      const promise = track(reqId, 'accountSummary', { timeoutMs: 15000 });
      try {
        ib.reqAccountSummary(reqId, 'All', ACCOUNT_SUMMARY_TAGS);
      } catch (err) {
        return { ok: false, error: err.message, rows: [] };
      }
      const result = await promise;
      // Avsluta prenumerationen direkt — vi vill ha en engångsläsning.
      try { ib.cancelAccountSummary(reqId); } catch (_) { /* ignore */ }
      return { ok: result.ok === true, error: result.ok ? null : (result.error || 'account_summary_failed'), rows: result.rows || [] };
    });
  }

  async function fetchAccountUpdatesSnapshot({ accountId = null, timeoutMs = 15000 } = {}) {
    if (!(await ensureConnected())) return { ok: false, error: 'ib_not_connected', rows: [], portfolio: [] };
    return pacedRequest(async () => {
      const requestedAccount = String(accountId || '').trim().toUpperCase();
      const selectedAccount = requestedAccount
        || managedAccounts.find((id) => classifyAccountId(id) === 'paper')
        || managedAccounts[0]
        || '';
      if (!selectedAccount) return { ok: false, error: 'no_accounts_visible', rows: [], portfolio: [] };
      return new Promise((resolve) => {
        const rows = [];
        const portfolio = [];
        const accountTimes = [];
        let settled = false;
        const accountKey = String(selectedAccount).trim().toUpperCase();
        const matchesAccount = (value) => {
          const raw = String(value || '').trim();
          return !raw || raw.toUpperCase() === accountKey;
        };
        const cleanup = () => {
          ib.off(EventName.updateAccountValue, onAccountValue);
          ib.off(EventName.updatePortfolio, onPortfolio);
          ib.off(EventName.updateAccountTime, onAccountTime);
          ib.off(EventName.accountDownloadEnd, onDownloadEnd);
          try { ib.reqAccountUpdates(false, selectedAccount); } catch (_) { /* ignore */ }
        };
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(result);
        };
        const onAccountValue = (key, value, currency, accountName) => {
          if (!matchesAccount(accountName)) return;
          rows.push({
            account: accountName || selectedAccount,
            tag: key,
            value,
            currency: currency || null,
          });
        };
        const onPortfolio = (contract, position, marketPrice, marketValue, averageCost, unrealizedPNL, realizedPNL, accountName) => {
          if (!matchesAccount(accountName)) return;
          portfolio.push({
            account: accountName || selectedAccount,
            contract: contract ? {
              conId: contract.conId ?? null,
              localSymbol: contract.localSymbol || null,
              secType: contract.secType || null,
              symbol: contract.symbol || null,
              currency: contract.currency || null,
              exchange: contract.exchange || null,
              lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth || null,
              multiplier: contract.multiplier || null,
            } : null,
            position: numberOrNull(position),
            marketPrice: numberOrNull(marketPrice),
            marketValue: numberOrNull(marketValue),
            averageCost: numberOrNull(averageCost),
            unrealizedPNL: numberOrNull(unrealizedPNL),
            realizedPNL: numberOrNull(realizedPNL),
          });
        };
        const onAccountTime = (timeStamp) => {
          accountTimes.push(timeStamp);
        };
        const onDownloadEnd = (accountName) => {
          if (!matchesAccount(accountName)) return;
          finish({
            ok: rows.length > 0 || portfolio.length > 0,
            error: rows.length > 0 || portfolio.length > 0 ? null : 'account_updates_empty',
            account: selectedAccount,
            rows,
            portfolio,
            accountTime: accountTimes[accountTimes.length - 1] || null,
          });
        };
        const timer = setTimeout(() => {
          finish({
            ok: false,
            error: `timeout_after_${timeoutMs}ms`,
            timedOut: true,
            account: selectedAccount,
            rows,
            portfolio,
            accountTime: accountTimes[accountTimes.length - 1] || null,
          });
        }, timeoutMs);
        ib.on(EventName.updateAccountValue, onAccountValue);
        ib.on(EventName.updatePortfolio, onPortfolio);
        ib.on(EventName.updateAccountTime, onAccountTime);
        ib.on(EventName.accountDownloadEnd, onDownloadEnd);
        try {
          ib.reqAccountUpdates(true, selectedAccount);
        } catch (err) {
          finish({ ok: false, error: err.message, rows: [], portfolio: [] });
        }
      });
    });
  }

  async function start() {
    stopRequested = false;
    if (started) return ensureConnected();
    started = true;
    const ok = await connectOnce();
    if (ok) {
      for (const root of config.roots) {
        // Contract + streaming quotes för alla konfigurerade roots.
        // Fel per root är isolerade — en trasig symbol fäller inte de andra.
        subscribeQuote(root).catch(() => {});
      }
    }
    return ok;
  }

  function stop() {
    stopRequested = true;
    started = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearAllPending('adapter_stopped');
    for (const [, state] of quoteState) {
      if (state.reqId != null && connected) {
        try { ib.cancelMktData(state.reqId); } catch (_) { /* ignore */ }
      }
      state.subscribed = false;
    }
    if (ib) { try { ib.disconnect(); } catch (_) { /* ignore */ } }
    connected = false;
    connecting = false;
  }

  function getStatus() {
    return {
      readOnly: true,
      started,
      connected,
      connecting,
      host: config.host,
      port: config.port,
      clientId: config.clientId,
      serverVersion,
      connectedAt,
      reconnectCount,
      nextReconnectDelayMs: connected ? null : reconnectDelayMs,
      marketDataTypeRequested: config.marketDataType,
      marketDataTypeCurrent: currentMarketDataType,
      marketDataTypeLabel: MD_TYPE_LABELS[currentMarketDataType] || null,
      managedAccounts: managedAccounts.map((id) => ({
        accountIdMasked: maskAccountId(id),
        classification: classifyAccountId(id),
      })),
      contracts: [...contractCache.entries()].map(([root, entry]) => ({
        root,
        ...entry.contract,
        contractCount: entry.contractCount,
        resolvedAt: entry.resolvedAt,
      })),
      pendingRequests: pending.size,
      lastErrors: lastErrors.slice(-10),
      pacing: { minIntervalMs: config.historicalPacingMs, lastPacedRequestAt: lastPacedRequestAt ? new Date(lastPacedRequestAt).toISOString() : null },
      noOrderCapability: 'Adaptern exporterar inga ordermetoder. Endast contract/market data/historical/account-summary-läsning.',
      ...SAFETY,
    };
  }

  // Endast för account-servicen: rå (omaskerad) kontolista för paper-klassning.
  // Får ALDRIG exponeras i API-responser eller loggar.
  function listManagedAccountsUnmasked() {
    return managedAccounts.slice();
  }

  return {
    SAFETY,
    config,
    start,
    stop,
    getStatus,
    resolveContract,
    subscribeQuote,
    getQuote,
    fetchHistoricalBars,
    fetchAccountSummary,
    fetchAccountUpdatesSnapshot,
    listManagedAccountsUnmasked,
    maskAccountId,
    classifyAccountId,
    isConnected: () => connected,
    isStarted: () => started,
  };
}

const defaultIbFuturesDataAdapterService = createIbFuturesDataAdapterService();

module.exports = {
  SAFETY,
  DEFAULT_ROOTS,
  ACCOUNT_SUMMARY_TAGS,
  toIbUtcDateTime,
  maskAccountId,
  classifyAccountId,
  createIbFuturesDataAdapterService,
  defaultIbFuturesDataAdapterService,
};
