'use strict';

/**
 * IB Paper FUTURES — front-month resolver (Fas 3.1, read-only).
 *
 * Resolves the ACTIVE front-month contract for the primary CME futures roots
 * (MES/MNQ/ES/NQ) via IB `reqContractDetails`. It NEVER guesses the contract
 * month — the month/localSymbol/conId come straight from IB, or the contract
 * stays unverified.
 *
 * HARD RULES:
 *   - Read-only. `reqContractDetails` is a pure query. No order/submit/arm.
 *   - GATED OFF by default via env IB_FUTURES_CONTRACT_DETAILS_ENABLED. When
 *     disabled (default) NOTHING connects to IB — the service returns a gated
 *     result and every contract stays contractMonthVerified=false.
 *   - Never touches IB_PAPER_SUBMIT_ROUTES_ENABLED or any submit path.
 *   - The live IB connector uses its OWN clientId (IB_FUTURES_CLIENT_ID) so it
 *     cannot collide with the read-only-state connection's clientId.
 *   - Front-month is chosen conservatively; a contract within the roll guard is
 *     flagged `near_expiry_roll` and must be verified before use (never rolled
 *     forward automatically = never guessed).
 *
 * The pure logic (selectFrontMonth / crossValidateSpec / buildResolvedContract /
 * resolveFrontMonthContracts) is connector-injectable so it is fully unit-tested
 * with mock IB data and no live dependency. `@stoqey/ib` is lazy-required only
 * inside the real connector, so tests run without node_modules.
 */

const { FUTURES_SPECS } = require('./interactiveBrokersFuturesContractService');

const CONTRACT_DETAILS_FLAG = 'IB_FUTURES_CONTRACT_DETAILS_ENABLED';
const CLIENT_ID_FLAG = 'IB_FUTURES_CLIENT_ID';
const DEFAULT_ROLL_GUARD_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function envEnabled() {
  return ['true', '1', 'yes', 'on'].includes(
    String(process.env[CONTRACT_DETAILS_FLAG] ?? '').trim().toLowerCase(),
  );
}

function safeNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an IB expiry string into a Date at the END of that day/month (UTC), so
 * a contract is only "expired" once its last trade day has fully passed.
 * Accepts "YYYYMMDD" (FUT lastTradeDateOrContractMonth) or "YYYYMM". IB Gateway
 * may append time + timezone ("20261218 08:30:00 US/Central") — the date is
 * always the first whitespace-separated token.
 * Returns null if unparseable — an unparseable expiry is never treated as valid.
 */
function parseExpiry(raw) {
  const s = String(raw ?? '').trim().split(/\s+/)[0];
  if (/^\d{8}$/.test(s)) {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    const d = Number(s.slice(6, 8));
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
  }
  if (/^\d{6}$/.test(s)) {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    if (m < 1 || m > 12) return null;
    // End of month.
    return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  }
  return null;
}

/**
 * Choose the active front month from a list of contractDetails rows.
 * Pure. Picks the earliest NON-expired expiry; flags near-expiry roll.
 */
function selectFrontMonth(rows, { now = new Date(), rollGuardDays = DEFAULT_ROLL_GUARD_DAYS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const parsed = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ row: r, expiry: parseExpiry(r?.lastTradeDateOrContractMonth) ?? parseExpiry(r?.contractMonth) }))
    .filter((x) => x.expiry instanceof Date && !Number.isNaN(x.expiry.getTime()));

  const active = parsed
    .filter((x) => x.expiry.getTime() >= nowMs)
    .sort((a, b) => a.expiry.getTime() - b.expiry.getTime());

  if (active.length === 0) {
    return { selected: null, reason: 'no_active_contract', daysToExpiry: null, nearExpiry: false };
  }
  const front = active[0];
  const daysToExpiry = Math.ceil((front.expiry.getTime() - nowMs) / DAY_MS);
  const nearExpiry = daysToExpiry <= rollGuardDays;
  return { selected: front.row, reason: 'front_selected', daysToExpiry, nearExpiry };
}

/**
 * Cross-validate the IB-resolved contract against the static Fas 1 spec so a
 * silently wrong contract can't slip through. Pure. Returns mismatch codes.
 */
function crossValidateSpec(selected, staticSpec) {
  const mismatches = [];
  if (!selected || !staticSpec) return mismatches;
  const selMult = safeNum(selected.multiplier);
  const selTick = safeNum(selected.minTick);
  if (selMult !== null && staticSpec.multiplier != null && selMult !== staticSpec.multiplier) {
    mismatches.push(`multiplier(${selMult}!=${staticSpec.multiplier})`);
  }
  if (selTick !== null && staticSpec.minTick != null && selTick !== staticSpec.minTick) {
    mismatches.push(`minTick(${selTick}!=${staticSpec.minTick})`);
  }
  const selClass = selected.tradingClass ? String(selected.tradingClass).toUpperCase() : null;
  if (selClass && staticSpec.tradingClass && selClass !== String(staticSpec.tradingClass).toUpperCase()) {
    mismatches.push(`tradingClass(${selClass}!=${staticSpec.tradingClass})`);
  }
  return mismatches;
}

/**
 * Assemble the resolved contract record for one root. Pure.
 * `resolution` = output of selectFrontMonth; `error` = per-root fetch failure.
 */
function buildResolvedContract(staticSpec, resolution, { error = null } = {}) {
  const base = {
    root: staticSpec.root,
    symbol: staticSpec.root,
    secType: staticSpec.secType,
    exchange: staticSpec.exchange,
    currency: staticSpec.currency,
    tradingClass: staticSpec.tradingClass,
    multiplier: staticSpec.multiplier,
    minTick: staticSpec.minTick,
    preferredFirstTest: staticSpec.preferredFirstTest === true,
    // Resolved (from IB) — null until verified.
    conId: null,
    localSymbol: null,
    lastTradeDateOrContractMonth: null,
    contractMonth: null,
    daysToExpiry: null,
    contractMonthVerified: false,
    detailBlockers: [],
  };

  if (error) {
    return { ...base, detailBlockers: ['contract_details_unavailable'], error: String(error) };
  }
  if (!resolution || !resolution.selected) {
    return { ...base, detailBlockers: ['contract_details_unavailable'], error: resolution?.reason || 'no_active_contract' };
  }

  const sel = resolution.selected;
  const validation = crossValidateSpec(sel, staticSpec);
  const detailBlockers = [];
  if (validation.length > 0) detailBlockers.push('contract_spec_mismatch');
  if (resolution.nearExpiry) detailBlockers.push('near_expiry_roll');

  return {
    ...base,
    conId: sel.conId != null ? sel.conId : null,
    localSymbol: sel.localSymbol || null,
    lastTradeDateOrContractMonth: sel.lastTradeDateOrContractMonth || null,
    contractMonth: sel.contractMonth || (sel.lastTradeDateOrContractMonth ? String(sel.lastTradeDateOrContractMonth).slice(0, 6) : null),
    daysToExpiry: resolution.daysToExpiry,
    // Verified means: IB returned a real, cross-valid front month. Spec mismatch
    // downgrades verification (do not trust a contract that disagrees with spec).
    contractMonthVerified: validation.length === 0,
    specMismatches: validation,
    detailBlockers,
  };
}

function gatedContract(staticSpec) {
  return {
    root: staticSpec.root,
    symbol: staticSpec.root,
    secType: staticSpec.secType,
    exchange: staticSpec.exchange,
    currency: staticSpec.currency,
    tradingClass: staticSpec.tradingClass,
    multiplier: staticSpec.multiplier,
    minTick: staticSpec.minTick,
    preferredFirstTest: staticSpec.preferredFirstTest === true,
    conId: null,
    localSymbol: null,
    lastTradeDateOrContractMonth: null,
    contractMonth: null,
    daysToExpiry: null,
    contractMonthVerified: false,
    detailBlockers: ['contract_details_disabled'],
  };
}

/**
 * Resolve front-month contracts for all roots. Connector-injectable & async.
 *
 * @param {object}  opts
 * @param {boolean} opts.enabled     - gate; when false NOTHING connects to IB.
 * @param {object}  opts.connector   - { fetchContractDetails(spec) => rows[], close?() }
 * @param {Date}    opts.now
 * @param {number}  opts.rollGuardDays
 * @param {Array}   opts.specs       - defaults to Fas 1 FUTURES_SPECS
 */
async function resolveFrontMonthContracts(opts = {}) {
  const {
    enabled,
    connector = null,
    now = new Date(),
    rollGuardDays = DEFAULT_ROLL_GUARD_DAYS,
    specs = FUTURES_SPECS,
  } = opts;
  const isEnabled = enabled === undefined ? envEnabled() : enabled === true;
  const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString();

  if (!isEnabled) {
    return {
      ok: true,
      readOnly: true,
      enabled: false,
      gated: true,
      source: 'gated_no_ib_query',
      note: `Front-month resolver är gated OFF (${CONTRACT_DETAILS_FLAG} != true). Ingen IB-anslutning görs; kontraktsmånad overifierad.`,
      generatedAt,
      contracts: specs.map(gatedContract),
      safety: { ...SAFETY },
    };
  }

  if (!connector || typeof connector.fetchContractDetails !== 'function') {
    throw new Error('resolveFrontMonthContracts: enabled but no connector.fetchContractDetails provided');
  }

  const contracts = [];
  try {
    for (const spec of specs) {
      try {
        const rows = await connector.fetchContractDetails(spec);
        const resolution = selectFrontMonth(rows, { now, rollGuardDays });
        contracts.push(buildResolvedContract(spec, resolution));
      } catch (err) {
        contracts.push(buildResolvedContract(spec, null, { error: err?.message || String(err) }));
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
    source: 'ib_reqContractDetails',
    note: 'Front-month resolvad via IB reqContractDetails (read-only). Verifierad endast vid ren spec-match.',
    generatedAt,
    rollGuardDays,
    contracts,
    safety: { ...SAFETY },
  };
}

/**
 * Real IB connector (lazy-requires @stoqey/ib). Read-only reqContractDetails.
 * Own clientId. Not exercised by unit tests (gated OFF + injected mock).
 * One short-lived connection per fetch: connect → query → cleanup → disconnect.
 */
function createIbContractDetailsConnector(overrides = {}) {
  const host = String(overrides.host || process.env.IB_GATEWAY_HOST || '127.0.0.1');
  const port = Number(overrides.port || process.env.IB_GATEWAY_PORT || 4002);
  const clientId = Number(overrides.clientId || process.env[CLIENT_ID_FLAG] || 0);
  const timeoutMs = Number(overrides.timeoutMs || 15000);

  async function fetchContractDetails(spec) {
    // Lazy require so unit tests never need @stoqey/ib.
    const { IBApi, EventName } = require('@stoqey/ib');
    return await new Promise((resolve, reject) => {
      const client = new IBApi({ host, port, clientId });
      const rows = [];
      let settled = false;
      const reqId = 1;

      const cleanup = () => {
        try { client.removeAllListeners(EventName.connected); } catch (_) {}
        try { client.removeAllListeners(EventName.error); } catch (_) {}
        try { client.removeAllListeners(EventName.contractDetails); } catch (_) {}
        try { client.removeAllListeners(EventName.contractDetailsEnd); } catch (_) {}
        try { client.disconnect(); } catch (_) {}
      };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (err) reject(err); else resolve(rows);
      };
      const timer = setTimeout(() => finish(new Error(`reqContractDetails timeout for ${spec.root}`)), timeoutMs);

      client.on(EventName.error, (err, code) => {
        // Ignore benign informational codes; fail on real errors.
        if (code && Number(code) >= 2100 && Number(code) < 2200) return;
        finish(err instanceof Error ? err : new Error(String(err)));
      });
      client.on(EventName.contractDetails, (_reqId, details) => {
        const c = details?.contract || {};
        rows.push({
          conId: c.conId ?? null,
          localSymbol: c.localSymbol ?? null,
          lastTradeDateOrContractMonth: c.lastTradeDateOrContractMonth ?? null,
          contractMonth: details?.contractMonth ?? null,
          tradingClass: c.tradingClass ?? null,
          multiplier: c.multiplier ?? null,
          minTick: details?.minTick ?? null,
          marketName: details?.marketName ?? null,
        });
      });
      client.on(EventName.contractDetailsEnd, () => finish(null));
      client.on(EventName.connected, () => {
        try {
          client.reqContractDetails(reqId, {
            symbol: spec.root,
            secType: spec.secType,
            exchange: spec.exchange,
            currency: spec.currency,
            includeExpired: false,
          });
        } catch (err) {
          finish(err);
        }
      });

      try { client.connect(); } catch (err) { finish(err); }
    });
  }

  return { fetchContractDetails, close: async () => {} };
}

/** Convenience: env-gated resolve using the real IB connector when enabled. */
async function getFrontMonthContracts(opts = {}) {
  const enabled = opts.enabled === undefined ? envEnabled() : opts.enabled === true;
  const connector = enabled ? (opts.connector || createIbContractDetailsConnector(opts)) : null;
  return resolveFrontMonthContracts({ ...opts, enabled, connector });
}

module.exports = {
  SAFETY,
  CONTRACT_DETAILS_FLAG,
  envEnabled,
  resolveFrontMonthContracts,
  getFrontMonthContracts,
  createIbContractDetailsConnector,
  _internal: {
    parseExpiry,
    selectFrontMonth,
    crossValidateSpec,
    buildResolvedContract,
    gatedContract,
  },
};
