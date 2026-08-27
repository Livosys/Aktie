'use strict';

const assert = require('assert/strict');

const adapterModule = require('../src/services/__probeAdapter');

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
  const r4 = await adapter.fetchAccountUpdatesSnapshot();
  assert.equal(r4.ok, false);
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

  // ── 7. Reconnect-regression: resubscribe måste skicka reqMktData igen ─────
  // (FAS 18-fix: disconnected nollställer subscribed/reqId; utan det gör
  // subscribeQuote early-return och tick-strömmen fryser permanent.)
  const { EventEmitter } = require('events');
  const { EventName } = require('@stoqey/ib');
  const clients = [];
  function makeFakeIb() {
    const c = new EventEmitter();
    c.mktDataCalls = [];
    c.cancelCalls = [];
    c.contractDetailsCalls = 0;
    c.connect = () => {
      c.emit(EventName.server, 193);
      c.emit(EventName.nextValidId, 1);
    };
    c.disconnect = () => {};
    c.reqMarketDataType = () => {};
    c.reqMktData = (reqId) => { c.mktDataCalls.push(reqId); };
    c.cancelMktData = (reqId) => { c.cancelCalls.push(reqId); };
    c.reqContractDetails = (reqId) => {
      c.contractDetailsCalls += 1; try { throw new Error("CD"); } catch(e) { (global.__cdStacks ||= []).push({ client: c.__id, reqId, stack: e.stack.split("\n").slice(1,30).join("\n") }); }
      setImmediate(() => {
        c.emit(EventName.contractDetails, reqId, {
          contract: {
            conId: 42, localSymbol: 'MNQZ9', tradingClass: 'MNQ',
            lastTradeDateOrContractMonth: '20991218', exchange: 'CME',
            currency: 'USD', multiplier: 2,
          },
        });
        c.emit(EventName.contractDetailsEnd, reqId);
      });
    };
    c.__id = clients.length; clients.push(c);
    return c;
  }
  const waitFor = async (fn, label, timeoutMs = 2000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const rcAdapter = adapterModule.createIbFuturesDataAdapterService({
    reconnectBaseMs: 30,
    historicalPacingMs: 1,
    roots: ['MNQ'],
    ibFactory: makeFakeIb,
  });
  assert.equal(await rcAdapter.start(), true, 'start ska ansluta mot fake-IB');
  await waitFor(() => clients[0].mktDataCalls.length === 1, 'första reqMktData');
  const firstReqId = clients[0].mktDataCalls[0];
  clients[0].emit(EventName.tickPrice, firstReqId, 4, 100);
  assert.equal(rcAdapter.getQuote('MNQ').last, 100, 'tick före disconnect');

  // Disconnect → reconnect skapar ny klient som MÅSTE få ett nytt reqMktData.
  clients[0].emit(EventName.disconnected);
  await waitFor(() => clients.length >= 2 && clients[1].mktDataCalls.length === 1,
    'resubscribe på ny klient efter reconnect');
  const secondReqId = clients[1].mktDataCalls[0];
  assert.notEqual(secondReqId, firstReqId, 'ny subscription ska ha nytt reqId');
  assert.equal(clients[1].mktDataCalls.length, 1, 'exakt EN subscription per root på nya klienten');
  assert.equal(clients[1].cancelCalls.length, 0, 'ingen cancelMktData för död reqId på nya klienten');
  assert.equal(clients[1].contractDetailsCalls, 0, 'kontrakt ska komma ur cachen vid resubscribe');

  // Tickflödet återupptas på nya reqId:t — och gamla reqId:t är dött.
  clients[1].emit(EventName.tickPrice, secondReqId, 4, 200);
  assert.equal(rcAdapter.getQuote('MNQ').last, 200, 'tick efter reconnect ska flöda');
  clients[1].emit(EventName.tickPrice, firstReqId, 4, 999);
  assert.equal(rcAdapter.getQuote('MNQ').last, 200, 'gammalt reqId får inte uppdatera quotes');

  // Sena event från den GAMLA klienten får inte korrumpera nya sessionen.
  clients[0].emit(EventName.disconnected);
  clients[0].emit(EventName.error, new Error('stale socket'), 502, -1);
  assert.equal(rcAdapter.isConnected(), true, 'stale disconnected från gammal klient ska ignoreras');
  assert.equal(clients.length, 2, 'stale event får inte trigga extra reconnect');

  // Inga listener-läckor: handlers sitter på klient-instansen, en per event.
  for (const ev of [EventName.disconnected, EventName.tickPrice, EventName.error]) {
    assert.ok(clients[1].listenerCount(ev) <= 1, `max en listener för ${String(ev)}`);
  }

  // In-flight-dedupe: samtidiga subscribeQuote för samma root → en reqMktData.
  const dedupeClients = [];
  const dedupeAdapter = adapterModule.createIbFuturesDataAdapterService({
    reconnectBaseMs: 30,
    historicalPacingMs: 1,
    roots: [],
    ibFactory: () => { const c = makeFakeIb(); dedupeClients.push(c); return c; },
  });
  assert.equal(await dedupeAdapter.start(), true);
  const results = await Promise.all([
    dedupeAdapter.subscribeQuote('MNQ'),
    dedupeAdapter.subscribeQuote('MNQ'),
    dedupeAdapter.subscribeQuote('MNQ'),
  ]);
  assert.ok(results.every((r) => r.ok), 'alla samtidiga subscribe ska lyckas');
  assert.equal(dedupeClients[0].mktDataCalls.length, 1, 'samtidiga subscribe → exakt en reqMktData');
  assert.equal(dedupeClients[0].contractDetailsCalls, 1, 'samtidiga subscribe → exakt en contractDetails');
  rcAdapter.stop();
  dedupeAdapter.stop();

  // ── 8. AccountUpdates engångsläsning → accountvärden + portfolio, sedan cancel
  const accountClients = [];
  const accountAdapter = adapterModule.createIbFuturesDataAdapterService({
    historicalPacingMs: 1,
    roots: [],
    ibFactory: () => {
      const c = new EventEmitter();
      c.accountUpdateCalls = [];
      c.connect = () => {
        c.emit(EventName.server, 193);
        c.emit(EventName.managedAccounts, 'DUQ565596');
        c.emit(EventName.nextValidId, 1);
      };
      c.disconnect = () => {};
      c.reqMarketDataType = () => {};
      c.reqAccountUpdates = (subscribe, acctCode) => {
        c.accountUpdateCalls.push({ subscribe, acctCode });
        if (!subscribe) return;
        setImmediate(() => {
          c.emit(EventName.updateAccountValue, 'AccountType', 'INDIVIDUAL', '', 'DUQ565596');
          c.emit(EventName.updateAccountValue, 'NetLiquidation', '11063846.43', 'SEK', 'DUQ565596');
          c.emit(EventName.updateAccountValue, 'TotalCashValue', '11051965.69', 'SEK', 'DUQ565596');
          c.emit(EventName.updatePortfolio, {
            conId: 793356225,
            localSymbol: 'MNQU6',
            secType: 'FUT',
            symbol: 'MNQ',
            currency: 'USD',
            lastTradeDateOrContractMonth: '20260918',
          }, 1, 28608.1503906, 57216.3, 57247.11, -30.81, -344.94, 'DUQ565596');
          c.emit(EventName.accountDownloadEnd, 'DUQ565596');
        });
      };
      accountClients.push(c);
      return c;
    },
  });
  assert.equal(await accountAdapter.start(), true);
  const updates = await accountAdapter.fetchAccountUpdatesSnapshot({ accountId: 'DUQ565596', timeoutMs: 500 });
  assert.equal(updates.ok, true);
  assert.equal(updates.account, 'DUQ565596');
  assert.equal(updates.rows.length, 3);
  assert.equal(updates.rows.find((row) => row.tag === 'NetLiquidation').value, '11063846.43');
  assert.equal(updates.portfolio.length, 1);
  assert.equal(updates.portfolio[0].contract.localSymbol, 'MNQU6');
  assert.equal(updates.portfolio[0].unrealizedPNL, -30.81);
  assert.deepEqual(accountClients[0].accountUpdateCalls.map((call) => call.subscribe), [true, false]);
  accountAdapter.stop();

  console.log('ibFuturesDataAdapterService.test.js OK');
})().catch((err) => {
  console.error('TEST FAIL:', err.message);
  process.exit(1);
});

// (tillagd av proben — nås bara om assertionerna passerade)
