'use strict';

const assert = require('assert/strict');

const adapterModule = require('./ibFuturesDataAdapterService');

// ── 1. Ingen anslutning vid require ──────────────────────────────────────────
const adapter = adapterModule.createIbFuturesDataAdapterService({
  ibFactory: () => { throw new Error('ib_factory_should_not_be_called_on_require'); },
});
assert.equal(adapter.isStarted(), false, 'adapter får inte vara startad vid require');
assert.equal(adapter.isConnected(), false, 'adapter får inte vara ansluten vid require');

// getStatus fungerar utan anslutning och utan att skapa en.
const status = adapter.getStatus();
assert.equal(status.connected, false);
assert.equal(status.readOnly, true);
assert.equal(status.mode, 'paper_only');
assert.equal(status.actions_allowed, false);
assert.equal(status.can_place_orders, false);
assert.equal(status.live_trading_enabled, false);
assert.equal(status.broker_enabled, false);

// ── 2. Inga order-exports ────────────────────────────────────────────────────
const FORBIDDEN_EXPORTS = ['placeOrder', 'submitOrder', 'transmit', 'cancelOrder', 'reqIds', 'placeBracket', 'order'];
for (const key of Object.keys(adapter)) {
  for (const forbidden of FORBIDDEN_EXPORTS) {
    assert.equal(
      key.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `adapter-export "${key}" får inte vara ordersrelaterad`,
    );
  }
}

// ── 3. UTC-format för historical endDateTime ────────────────────────────────
assert.equal(
  adapterModule.toIbUtcDateTime(new Date('2026-07-15T20:19:37.000Z')),
  '20260715-20:19:37 UTC',
  'endDateTime ska vara yyyymmdd-hh:mm:ss UTC',
);
assert.equal(
  adapterModule.toIbUtcDateTime(new Date('2026-01-02T03:04:05.000Z')),
  '20260102-03:04:05 UTC',
);

// ── 4. Kontomaskering + paper/live-klassning ────────────────────────────────
assert.equal(adapterModule.maskAccountId('DUQ565596'), 'DU***596');
assert.equal(adapterModule.maskAccountId('U1234567'), 'U1***567');
assert.equal(adapterModule.maskAccountId(''), null);
assert.equal(adapterModule.classifyAccountId('DUQ565596'), 'paper');
assert.equal(adapterModule.classifyAccountId('DF123456'), 'paper');
assert.equal(adapterModule.classifyAccountId('U1234567'), 'live_or_unknown');
assert.equal(adapterModule.classifyAccountId(''), 'unknown');

// ── 5. Requests utan start() vägrar snällt (ingen implicit anslutning) ──────
(async () => {
  const r1 = await adapter.resolveContract('MNQ');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'ib_not_connected');
  const r2 = await adapter.fetchHistoricalBars({ root: 'MNQ' });
  assert.equal(r2.ok, false);
  const r3 = await adapter.fetchAccountSummary();
  assert.equal(r3.ok, false);
  assert.equal(adapter.isConnected(), false, 'requests får inte trigga anslutning utan start()');

  // ── 6. Connect-retry: misslyckad connect bokar backoff-reconnect ──────────
  let factoryCalls = 0;
  const failingAdapter = adapterModule.createIbFuturesDataAdapterService({
    connectTimeoutMs: 50,
    reconnectBaseMs: 30,
    roots: ['MNQ'],
    ibFactory: () => {
      factoryCalls += 1;
      return {
        on() {},
        once() {},
        connect() { /* svarar aldrig → timeout */ },
        disconnect() {},
        reqMarketDataType() {},
      };
    },
  });
  const ok = await failingAdapter.start();
  assert.equal(ok, false, 'start ska rapportera false när gatewayn inte svarar');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(factoryCalls >= 2, `reconnect med backoff förväntad (factoryCalls=${factoryCalls})`);
  failingAdapter.stop();
  const st = failingAdapter.getStatus();
  assert.ok(st.reconnectCount >= 1, 'reconnectCount ska räknas');

  console.log('ibFuturesDataAdapterService.test.js OK');
})().catch((err) => {
  console.error('TEST FAIL:', err.message);
  process.exit(1);
});
