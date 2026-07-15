'use strict';

const assert = require('assert/strict');

const { createIbPaperAccountSummaryService } = require('./ibPaperAccountSummaryService');

function fakeAdapter(rows, { ok = true, error = null } = {}) {
  return {
    isConnected: () => true,
    async fetchAccountSummary() { return { ok, error, rows }; },
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

  // ── 7. getCachedSummary utan snapshot → pending, inga IB-anrop ────────────
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
