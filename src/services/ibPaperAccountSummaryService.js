'use strict';

// Read-only IB PAPER account summary (FAS 8 i masteruppdraget).
//
// Läser ENDAST kontovärden (NetLiquidation m.fl.) från IB Gateway via den
// read-only dataadaptern. Ingen kontomutation, ingen order, ingen risk.
//
// Kontoval:
//   - ENDAST paper/demo-konton (id som börjar med DU/DF) får användas.
//   - Ett livekonto väljs ALDRIG automatiskt. Om inget entydigt paper-konto
//     kan identifieras blockeras kontosynkningen med tydlig orsak.
//   - Fullständigt konto-id skrivs aldrig i API-svar eller loggar — endast
//     maskerad form (DU***596).
//
// IB NetLiquidation är källan för rubriken "Paper-kontosaldo" i Futures
// Paper-UI:t. Den interna simulerade Futures Paper-PnL:en hålls helt separat
// (futuresPaperAccountService) och blandas aldrig in i IB-värdena.

const adapterModule = require('./ibFuturesDataAdapterService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  readOnly: true,
  source: 'ib_paper_account_summary',
});

const NUMERIC_TAGS = new Set([
  'NetLiquidation',
  'TotalCashValue',
  'AvailableFunds',
  'BuyingPower',
  'UnrealizedPnL',
  'RealizedPnL',
  'MaintMarginReq',
  'InitMarginReq',
  'Cushion',
]);

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function createIbPaperAccountSummaryService(options = {}) {
  const adapter = options.adapter || adapterModule.defaultIbFuturesDataAdapterService;
  const cacheTtlMs = Number(options.cacheTtlMs || 60 * 1000);
  // Explicit konfigurerat paper-konto (om flera paper-konton finns).
  const configuredAccount = String(options.configuredAccount || process.env.IB_PAPER_ACCOUNT_ID || '').trim().toUpperCase();

  let cache = null; // {summary, fetchedAtMs}
  let inflight = null;

  function isEnabled() {
    return envBool('IB_FUTURES_DATA_ENABLED', false) || options.forceEnabled === true;
  }

  // Välj paper-konto ur summary-raderna. Returnerar {ok, accountId?, blocker?}.
  function selectPaperAccount(rows = []) {
    const accountIds = [...new Set(rows.map((r) => String(r.account || '').trim()).filter(Boolean))];
    const paperAccounts = accountIds.filter((id) => adapterModule.classifyAccountId(id) === 'paper');
    const nonPaper = accountIds.filter((id) => adapterModule.classifyAccountId(id) !== 'paper');
    if (configuredAccount) {
      if (adapterModule.classifyAccountId(configuredAccount) !== 'paper') {
        return { ok: false, blocker: 'configured_account_is_not_paper' };
      }
      if (!accountIds.includes(configuredAccount)) {
        return { ok: false, blocker: 'configured_paper_account_not_found' };
      }
      return { ok: true, accountId: configuredAccount };
    }
    if (paperAccounts.length === 1) return { ok: true, accountId: paperAccounts[0] };
    if (paperAccounts.length > 1) {
      return { ok: false, blocker: 'multiple_paper_accounts_require_explicit_config' };
    }
    if (nonPaper.length) return { ok: false, blocker: 'only_non_paper_accounts_visible_refusing' };
    return { ok: false, blocker: 'no_accounts_visible' };
  }

  function buildBlocked(blocker, extra = {}) {
    return {
      ok: false,
      status: 'blocked',
      blocker,
      account: null,
      generatedAt: nowIso(),
      ...extra,
      ...SAFETY,
    };
  }

  async function fetchSummary() {
    if (!isEnabled()) return buildBlocked('ib_futures_data_disabled');
    const result = await adapter.fetchAccountSummary();
    if (!result.ok) {
      return buildBlocked(result.error || 'account_summary_failed', { connected: adapter.isConnected() });
    }
    const selection = selectPaperAccount(result.rows);
    if (!selection.ok) {
      return buildBlocked(selection.blocker, {
        visibleAccounts: [...new Set(result.rows.map((r) => adapterModule.maskAccountId(r.account)))],
      });
    }
    const rows = result.rows.filter((r) => String(r.account || '').trim() === selection.accountId);
    const values = {};
    let currency = null;
    let accountType = null;
    for (const row of rows) {
      if (row.tag === 'AccountType') { accountType = row.value; continue; }
      if (NUMERIC_TAGS.has(row.tag)) {
        const num = Number(row.value);
        values[row.tag] = Number.isFinite(num) ? num : null;
        if (row.currency && !currency && row.tag === 'NetLiquidation') currency = row.currency;
      }
    }
    if (values.NetLiquidation == null) {
      return buildBlocked('net_liquidation_missing');
    }
    return {
      ok: true,
      status: 'ok',
      blocker: null,
      account: {
        accountIdMasked: adapterModule.maskAccountId(selection.accountId),
        classification: 'paper',
        accountType: accountType || null,
        currency: currency || 'USD',
        netLiquidation: values.NetLiquidation,
        totalCashValue: values.TotalCashValue ?? null,
        availableFunds: values.AvailableFunds ?? null,
        buyingPower: values.BuyingPower ?? null,
        unrealizedPnl: values.UnrealizedPnL ?? null,
        realizedPnl: values.RealizedPnL ?? null,
        maintMarginReq: values.MaintMarginReq ?? null,
        initMarginReq: values.InitMarginReq ?? null,
        cushion: values.Cushion ?? null,
      },
      connected: adapter.isConnected(),
      generatedAt: nowIso(),
      ...SAFETY,
    };
  }

  // Hämta med cache. UI-endpoints använder denna — aldrig direkta IB-anrop
  // per browser-request. maxAgeMs styr hur gammal cache som accepteras.
  async function getSummary({ maxAgeMs = cacheTtlMs } = {}) {
    if (!isEnabled()) return buildBlocked('ib_futures_data_disabled');
    const age = cache ? Date.now() - cache.fetchedAtMs : null;
    if (cache && age != null && age <= maxAgeMs) {
      return { ...cache.summary, cached: true, cacheAgeMs: age };
    }
    if (!inflight) {
      inflight = fetchSummary()
        .then((summary) => {
          if (summary.ok) cache = { summary, fetchedAtMs: Date.now() };
          return summary;
        })
        .finally(() => { inflight = null; });
    }
    try {
      return await inflight;
    } catch (err) {
      return buildBlocked(err.message);
    }
  }

  // Senast kända snapshot utan att trigga nya IB-anrop (för desk-runtime).
  function getCachedSummary() {
    if (!isEnabled()) return buildBlocked('ib_futures_data_disabled');
    if (!cache) {
      return { ...buildBlocked('no_account_snapshot_yet'), status: 'pending' };
    }
    const age = Date.now() - cache.fetchedAtMs;
    return {
      ...cache.summary,
      cached: true,
      cacheAgeMs: age,
      stale: age > 5 * 60 * 1000,
    };
  }

  function resetCacheForTests() {
    cache = null;
    inflight = null;
  }

  return {
    SAFETY,
    isEnabled,
    getSummary,
    getCachedSummary,
    selectPaperAccount,
    resetCacheForTests,
  };
}

const defaultIbPaperAccountSummaryService = createIbPaperAccountSummaryService();

module.exports = {
  SAFETY,
  createIbPaperAccountSummaryService,
  defaultIbPaperAccountSummaryService,
};
