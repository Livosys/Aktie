'use strict';

const assert = require('assert/strict');

const { createIbPaperAccountSummaryService } = require('./ibPaperAccountSummaryService');

function fakeAdapter(rows, { ok = true, error = null, accountUpdates = null, onFetchAccountUpdates = null } = {}) {
  return {
    isConnected: () => true,
    async fetchAccountSummary() { return { ok, error, rows }; },
    async fetchAccountUpdatesSnapshot() {
      if (onFetchAccountUpdates) onFetchAccountUpdates();
      return accountUpdates || { ok: false, error: 'account_updates_not_configured', rows: [], portfolio: [] };
    },
  };
}

const paperRows = [
  { account: 'DUQ565596', tag: 'AccountType', value: 'INDIVIDUAL', currency: null },
  { account: 'DUQ565596', tag: 'NetLiquidation', value: '11014088.87', currency: 'SEK' },
  { account: 'DUQ565596', tag: 'TotalCashValue', value: '11007419.23', currency: 'SEK' },
  { account: 'DUQ565596', tag: 'AvailableFunds', value: '11014088.87', currency: 'SEK' },
  { account: 'DUQ565596', tag: 'BuyingPower', value: '73427259.11', currency: 'SEK' },
  { account: 'DUQ565596', tag: 'UnrealizedPnL', value: '0', currency: 'SEK' },
  { account: 'DUQ565596', tag: 'RealizedPnL', value: '0', currency: 'SEK' },
  { account: 'DUQ565596', tag: 'DailyPnL', value: '0', currency: 'SEK' },
];

(async () => {
  // ── 1. Disabled → blocked, inga IB-anrop ───────────────────────────────────
  delete process.env.IB_FUTURES_DATA_ENABLED;
  const disabled = createIbPaperAccountSummaryService({
    adapter: { fetchAccountSummary() { throw new Error('should_not_be_called'); }, isConnected: () => false },
  });
  const disabledResult = await disabled.getSummary();
  assert.equal(disabledResult.status, 'blocked');
  assert.equal(disabledResult.blocker, 'ib_futures_data_disabled');

  // ── 2. Ett paper-konto → ok, maskerat id, NetLiquidation som huvudvärde ────
  const service = createIbPaperAccountSummaryService({ forceEnabled: true, adapter: fakeAdapter(paperRows) });
  const summary = await service.getSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.account.accountIdMasked, 'DU***596');
  assert.equal(String(summary.account.accountIdMasked).includes('Q5655'), false, 'konto-id får inte läcka');
  assert.equal(summary.account.classification, 'paper');
  assert.equal(summary.account.currency, 'SEK');
  assert.equal(summary.account.netLiquidation, 11014088.87);
  assert.equal(summary.account.totalCashValue, 11007419.23);
  assert.equal(summary.account.buyingPower, 73427259.11);
  assert.equal(summary.mode, 'paper_only');
  assert.equal(summary.can_place_orders, false);
  assert.equal(JSON.stringify(summary).includes('DUQ565596'), false, 'API-payloaden får aldrig innehålla omaskerat konto-id');
  assert.equal(summary.snapshotSource, 'account_summary');

  // Cache: andra läsningen markeras cached.
  const cachedRead = await service.getSummary();
  assert.equal(cachedRead.cached, true);
  const snapshot = service.getCachedSummary();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.cached, true);

  // ── 3. Endast livekonto synligt → VÄGRA ────────────────────────────────────
  const liveRows = paperRows.map((r) => ({ ...r, account: 'U7654321' }));
  const liveService = createIbPaperAccountSummaryService({ forceEnabled: true, adapter: fakeAdapter(liveRows) });
  const liveResult = await liveService.getSummary();
  assert.equal(liveResult.status, 'blocked');
  assert.equal(liveResult.blocker, 'only_non_paper_accounts_visible_refusing');
  assert.equal(liveResult.account, null, 'livekonto får aldrig exponeras');

  // ── 4. Flera paper-konton utan explicit config → blocker ──────────────────
  const multiRows = [...paperRows, ...paperRows.map((r) => ({ ...r, account: 'DUX111222' }))];
  const multiService = createIbPaperAccountSummaryService({ forceEnabled: true, adapter: fakeAdapter(multiRows) });
  const multiResult = await multiService.getSummary();
  assert.equal(multiResult.status, 'blocked');
  assert.equal(multiResult.blocker, 'multiple_paper_accounts_require_explicit_config');

  // Explicit konfigurerat paper-konto löser blockern.
  const configuredService = createIbPaperAccountSummaryService({
    forceEnabled: true,
    adapter: fakeAdapter(multiRows),
    configuredAccount: 'DUX111222',
  });
  const configuredResult = await configuredService.getSummary();
  assert.equal(configuredResult.ok, true);
  assert.equal(configuredResult.account.accountIdMasked, 'DU***222');

  // Konfigurerat LIVE-konto vägras alltid.
  const badConfigService = createIbPaperAccountSummaryService({
    forceEnabled: true,
    adapter: fakeAdapter(multiRows),
    configuredAccount: 'U7654321',
  });
  const badConfigResult = await badConfigService.getSummary();
  assert.equal(badConfigResult.status, 'blocked');
  assert.equal(badConfigResult.blocker, 'configured_account_is_not_paper');

  // ── 5. NetLiquidation saknas → blocker ─────────────────────────────────────
  const noNetRows = paperRows.filter((r) => r.tag !== 'NetLiquidation');
  const noNetService = createIbPaperAccountSummaryService({ forceEnabled: true, adapter: fakeAdapter(noNetRows) });
  const noNetResult = await noNetService.getSummary();
  assert.equal(noNetResult.blocker, 'net_liquidation_missing');

  // ── 6. IB-fel → blocked utan kastade fel ──────────────────────────────────
  const errService = createIbPaperAccountSummaryService({
    forceEnabled: true,
    adapter: fakeAdapter([], { ok: false, error: 'ib_not_connected' }),
  });
  const errResult = await errService.getSummary();
  assert.equal(errResult.status, 'blocked');
  assert.equal(errResult.blocker, 'ib_not_connected');

  // ── 7. AccountSummary timeout → bygg snapshot från verifierade AccountUpdates ─
  const fallbackRows = [
    { account: 'DUQ565596', tag: 'AccountType', value: 'INDIVIDUAL', currency: null },
    { account: 'DUQ565596', tag: 'NetLiquidation', value: '11063846.43', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'TotalCashValue', value: '11051965.69', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'AvailableFunds', value: '11002915.28', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'BuyingPower', value: '73352768.56', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'InitMarginReq', value: '60931.14', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'MaintMarginReq', value: '45400.75', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'Cushion', value: '0.995896', currency: null },
    { account: 'DUQ565596', tag: 'ExcessLiquidity', value: '11018445.68', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'FullInitMarginReq', value: '60931.14', currency: 'SEK' },
    { account: 'DUQ565596', tag: 'FullMaintMarginReq', value: '45400.75', currency: 'SEK' },
  ];
  const fallbackService = createIbPaperAccountSummaryService({
    forceEnabled: true,
    adapter: fakeAdapter([], {
      ok: false,
      error: 'timeout_after_15000ms',
      accountUpdates: {
        ok: true,
        rows: fallbackRows,
        portfolio: [
          {
            account: 'DUQ565596',
            contract: { conId: 793356225, symbol: 'MNQ', localSymbol: 'MNQU6', secType: 'FUT' },
            position: 1,
            unrealizedPNL: -30.81,
            realizedPNL: -344.94,
            marketValue: 57216.3,
            averageCost: 57247.11,
          },
        ],
      },
    }),
  });
  const fallbackResult = await fallbackService.getSummary();
  assert.equal(fallbackResult.ok, true);
  assert.equal(fallbackResult.snapshotSource, 'account_updates_fallback');
  assert.equal(fallbackResult.account.accountIdMasked, 'DU***596');
  assert.equal(fallbackResult.account.netLiquidation, 11063846.43);
  assert.equal(fallbackResult.account.totalCashValue, 11051965.69);
  assert.equal(fallbackResult.account.availableFunds, 11002915.28);
  assert.equal(fallbackResult.account.buyingPower, 73352768.56);
  assert.equal(fallbackResult.account.initMarginReq, 60931.14);
  assert.equal(fallbackResult.account.maintMarginReq, 45400.75);
  assert.equal(fallbackResult.account.excessLiquidity, 11018445.68);
  assert.equal(fallbackResult.account.fullInitMarginReq, 60931.14);
  assert.equal(fallbackResult.account.fullMaintMarginReq, 45400.75);
  assert.equal(fallbackResult.account.unrealizedPnl, -30.81);
  assert.equal(fallbackResult.account.realizedPnl, -344.94);
  assert.equal(fallbackResult.portfolioPositions.length, 1);
  assert.equal(fallbackResult.portfolioPositions[0].accountMasked, 'DU***596');
  assert.equal(fallbackResult.portfolioPositions[0].localSymbol, 'MNQU6');
  assert.equal(fallbackResult.portfolioPositions[0].position, 1);
  assert.equal(fallbackResult.portfolioPositions[0].unrealizedPnl, -30.81);
  assert.equal(JSON.stringify(fallbackResult).includes('DUQ565596'), false, 'fallback-payloaden får aldrig innehålla omaskerat konto-id');

  let fallbackCalls = 0;
  const summaryFirstService = createIbPaperAccountSummaryService({
    forceEnabled: true,
    adapter: fakeAdapter(paperRows, { onFetchAccountUpdates: () => { fallbackCalls += 1; } }),
  });
  const summaryFirst = await summaryFirstService.getSummary();
  assert.equal(summaryFirst.ok, true);
  assert.equal(summaryFirst.snapshotSource, 'account_summary');
  assert.equal(fallbackCalls, 0, 'AccountUpdates ska inte användas när AccountSummary innehåller PnL');

  let completionCalls = 0;
  const summaryWithoutPnlRows = paperRows.filter((row) => !['UnrealizedPnL', 'RealizedPnL', 'DailyPnL'].includes(row.tag));
  const summaryWithPnlCompletion = createIbPaperAccountSummaryService({
    forceEnabled: true,
    adapter: fakeAdapter(summaryWithoutPnlRows, {
      onFetchAccountUpdates: () => { completionCalls += 1; },
      accountUpdates: {
        ok: true,
        rows: [
          { account: 'DUQ565596', tag: 'AccountType', value: 'INDIVIDUAL', currency: null },
          { account: 'DUQ565596', tag: 'NetLiquidation', value: '999', currency: 'SEK' },
          { account: 'DUQ565596', tag: '$LEDGER-FuturesPNL', value: '498.18', currency: 'BASE' },
          { account: 'DUQ565596', tag: '$LEDGER-FuturesPNL', value: '52.52', currency: 'USD' },
          { account: 'DUQ565596', tag: '$LEDGER-RealizedPnL', value: '1066.27', currency: 'BASE' },
          { account: 'DUQ565596', tag: '$LEDGER-RealizedPnL', value: '112.40', currency: 'USD' },
          { account: 'DUQ565596', tag: '$LEDGER-UnrealizedPnL', value: '610.98', currency: 'BASE' },
          { account: 'DUQ565596', tag: '$LEDGER-UnrealizedPnL', value: '64.41', currency: 'USD' },
        ],
        portfolio: [],
      },
    }),
  });
  const completedPnl = await summaryWithPnlCompletion.getSummary();
  assert.equal(completedPnl.ok, true);
  assert.equal(completionCalls, 1);
  assert.equal(completedPnl.snapshotSource, 'account_summary_with_account_updates');
  assert.equal(completedPnl.account.netLiquidation, 11014088.87, 'AccountSummary ska fortsätta vara källa för NetLiquidation');
  assert.equal(completedPnl.account.realizedPnl, 1066.27);
  assert.equal(completedPnl.account.unrealizedPnl, 610.98);
  assert.equal(completedPnl.account.dailyPnl, 498.18);

  // ── 8. getCachedSummary utan snapshot → pending, inga IB-anrop ────────────
  const coldService = createIbPaperAccountSummaryService({
    forceEnabled: true,
    adapter: { fetchAccountSummary() { throw new Error('should_not_be_called'); }, isConnected: () => false },
  });
  const cold = coldService.getCachedSummary();
  assert.equal(cold.status, 'pending');

  console.log('ibPaperAccountSummaryService.test.js OK');
})().catch((err) => {
  console.error('TEST FAIL:', err.message);
  process.exit(1);
});
