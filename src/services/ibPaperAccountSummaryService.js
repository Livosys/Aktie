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
  'DailyPnL',
  'MaintMarginReq',
  'InitMarginReq',
  'Cushion',
  'ExcessLiquidity',
  'FullInitMarginReq',
  'FullMaintMarginReq',
  'GrossPositionValue',
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

  function sumPortfolioField(portfolio = [], field) {
    const values = portfolio
      .map((row) => Number(row?.[field]))
      .filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0);
  }

  function ledgerCurrencyRank(currency, accountCurrency) {
    const normalized = String(currency || '').trim().toUpperCase();
    const preferred = String(accountCurrency || '').trim().toUpperCase();
    if (normalized === 'BASE') return 0;
    if (preferred && normalized === preferred) return 1;
    if (!normalized) return 2;
    return 3;
  }

  function pickLedgerValue(candidates = [], accountCurrency = null) {
    const ranked = candidates
      .map((candidate, index) => ({
        value: Number(candidate?.value),
        currency: candidate?.currency || null,
        index,
      }))
      .filter((candidate) => Number.isFinite(candidate.value))
      .sort((a, b) => (
        ledgerCurrencyRank(a.currency, accountCurrency) - ledgerCurrencyRank(b.currency, accountCurrency)
        || a.index - b.index
      ));
    return ranked.length ? ranked[0].value : null;
  }

  function sanitizePortfolioPositions(portfolio = []) {
    return portfolio.map((row) => ({
      accountMasked: adapterModule.maskAccountId(row?.account),
      accountClassification: adapterModule.classifyAccountId(row?.account),
      conId: row?.contract?.conId ?? null,
      localSymbol: row?.contract?.localSymbol || null,
      secType: row?.contract?.secType || null,
      symbol: row?.contract?.symbol || null,
      currency: row?.contract?.currency || null,
      exchange: row?.contract?.exchange || null,
      lastTradeDateOrContractMonth: row?.contract?.lastTradeDateOrContractMonth || null,
      position: row?.position ?? null,
      marketPrice: row?.marketPrice ?? null,
      marketValue: row?.marketValue ?? null,
      averageCost: row?.averageCost ?? null,
      avgCost: row?.averageCost ?? null,
      unrealizedPnl: row?.unrealizedPNL ?? null,
      realizedPnl: row?.realizedPNL ?? null,
      source: 'ibkr_paper_account_updates',
    }));
  }

  function buildSummaryFromRows(rowsInput = [], {
    snapshotSource = 'account_summary',
    accountSummaryBlocker = null,
    portfolio = [],
  } = {}) {
    const rawRows = Array.isArray(rowsInput) ? rowsInput : [];
    const selection = selectPaperAccount(rawRows);
    if (!selection.ok) {
      return buildBlocked(selection.blocker, {
        visibleAccounts: [...new Set(rawRows.map((r) => adapterModule.maskAccountId(r.account)))],
        accountSummaryBlocker,
        snapshotSource,
      });
    }
    const rows = rawRows.filter((r) => String(r.account || '').trim() === selection.accountId);
    const values = {};
    const ledgerCandidates = {
      RealizedPnL: [],
      UnrealizedPnL: [],
      DailyPnL: [],
    };
    let currency = null;
    let accountType = null;
    for (const row of rows) {
      if (row.tag === 'AccountType') { accountType = row.value; continue; }
      if (NUMERIC_TAGS.has(row.tag)) {
        const num = Number(row.value);
        values[row.tag] = Number.isFinite(num) ? num : null;
        if (row.currency && !currency && row.tag === 'NetLiquidation') currency = row.currency;
      }
      if (row.tag === '$LEDGER-RealizedPnL') {
        ledgerCandidates.RealizedPnL.push({ value: row.value, currency: row.currency });
      }
      if (row.tag === '$LEDGER-UnrealizedPnL') {
        ledgerCandidates.UnrealizedPnL.push({ value: row.value, currency: row.currency });
      }
      if (row.tag === '$LEDGER-FuturesPNL') {
        ledgerCandidates.DailyPnL.push({ value: row.value, currency: row.currency });
      }
    }
    if (values.RealizedPnL == null) values.RealizedPnL = pickLedgerValue(ledgerCandidates.RealizedPnL, currency);
    if (values.UnrealizedPnL == null) values.UnrealizedPnL = pickLedgerValue(ledgerCandidates.UnrealizedPnL, currency);
    if (values.DailyPnL == null) values.DailyPnL = pickLedgerValue(ledgerCandidates.DailyPnL, currency);
    if (values.UnrealizedPnL == null) values.UnrealizedPnL = sumPortfolioField(portfolio, 'unrealizedPNL');
    if (values.RealizedPnL == null) values.RealizedPnL = sumPortfolioField(portfolio, 'realizedPNL');
    if (values.GrossPositionValue == null) values.GrossPositionValue = sumPortfolioField(portfolio, 'marketValue');
    if (values.NetLiquidation == null) {
      return buildBlocked('net_liquidation_missing', { accountSummaryBlocker, snapshotSource });
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
        dailyPnl: values.DailyPnL ?? null,
        excessLiquidity: values.ExcessLiquidity ?? null,
        fullInitMarginReq: values.FullInitMarginReq ?? null,
        fullMaintMarginReq: values.FullMaintMarginReq ?? null,
        grossPositionValue: values.GrossPositionValue ?? null,
      },
      connected: adapter.isConnected(),
      generatedAt: nowIso(),
      snapshotSource,
      accountSummaryBlocker,
      portfolioPositions: sanitizePortfolioPositions(portfolio),
      ...SAFETY,
    };
  }

  function needsAccountUpdateCompletion(summary) {
    if (!summary?.ok || !summary.account) return false;
    return ['unrealizedPnl', 'realizedPnl', 'dailyPnl'].some((field) => summary.account[field] == null);
  }

  function mergeAccountUpdateCompletion(summary, updates) {
    if (!updates) return summary;
    if (!updates.ok || !updates.account) {
      return {
        ...summary,
        accountUpdatesBlocker: updates.accountUpdatesBlocker || updates.blocker || 'account_updates_snapshot_failed',
      };
    }
    const account = { ...summary.account };
    for (const field of [
      'unrealizedPnl',
      'realizedPnl',
      'dailyPnl',
      'grossPositionValue',
      'excessLiquidity',
      'fullInitMarginReq',
      'fullMaintMarginReq',
    ]) {
      if (account[field] == null && updates.account[field] != null) account[field] = updates.account[field];
    }
    return {
      ...summary,
      account,
      snapshotSource: 'account_summary_with_account_updates',
      accountUpdatesBlocker: null,
      accountUpdatesSnapshotSource: updates.snapshotSource || null,
      portfolioPositions: Array.isArray(updates.portfolioPositions) && updates.portfolioPositions.length
        ? updates.portfolioPositions
        : summary.portfolioPositions,
    };
  }

  async function fetchAccountUpdatesFallback(accountSummaryBlocker) {
    if (typeof adapter.fetchAccountUpdatesSnapshot !== 'function') return null;
    const result = await adapter.fetchAccountUpdatesSnapshot({ accountId: configuredAccount || null });
    if (!result.ok) {
      return buildBlocked(accountSummaryBlocker || 'account_summary_failed', {
        accountSummaryBlocker,
        accountUpdatesBlocker: result.error || 'account_updates_failed',
        connected: adapter.isConnected(),
        snapshotSource: 'account_summary_unavailable',
      });
    }
    const fallback = buildSummaryFromRows(result.rows, {
      snapshotSource: 'account_updates_fallback',
      accountSummaryBlocker,
      portfolio: result.portfolio || [],
    });
    if (fallback.ok) return fallback;
    return buildBlocked(accountSummaryBlocker || fallback.blocker || 'account_summary_failed', {
      accountSummaryBlocker,
      accountUpdatesBlocker: fallback.blocker || 'account_updates_snapshot_failed',
      connected: adapter.isConnected(),
      snapshotSource: 'account_updates_fallback_failed',
    });
  }

  async function fetchSummary() {
    if (!isEnabled()) return buildBlocked('ib_futures_data_disabled');
    const result = await adapter.fetchAccountSummary();
    const accountSummaryBlocker = result.ok ? null : (result.error || 'account_summary_failed');
    if (result.ok && Array.isArray(result.rows) && result.rows.length > 0) {
      const summary = buildSummaryFromRows(result.rows, { snapshotSource: 'account_summary' });
      if (summary.ok) {
        if (!needsAccountUpdateCompletion(summary)) return summary;
        const completion = await fetchAccountUpdatesFallback('pnl_fields_missing');
        return mergeAccountUpdateCompletion(summary, completion);
      }
      if (!['no_accounts_visible', 'net_liquidation_missing'].includes(summary.blocker)) return summary;
      const fallback = await fetchAccountUpdatesFallback(summary.blocker);
      return fallback || summary;
    }
    const fallback = await fetchAccountUpdatesFallback(accountSummaryBlocker);
    if (fallback) return fallback;
    if (!result.ok) {
      return buildBlocked(result.error || 'account_summary_failed', { connected: adapter.isConnected() });
    }
    return buildBlocked('account_summary_empty', { connected: adapter.isConnected() });
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
	          return summary.ok ? { ...summary, cached: false, cacheAgeMs: 0 } : summary;
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
