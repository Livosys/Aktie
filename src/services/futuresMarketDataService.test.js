'use strict';

const assert = require('assert/strict');

const { createFuturesMarketDataService } = require('./futuresMarketDataService');

function fakeAdapter({ quotes = {}, bars = {}, connected = true } = {}) {
  return {
    started: false,
    start() { this.started = true; return Promise.resolve(true); },
    stop() {},
    isConnected: () => connected,
    getQuote(root) { return quotes[root] || null; },
    async fetchHistoricalBars({ root }) {
      return bars[root] || { ok: false, error: 'no_fixture', bars: [] };
    },
    async fetchAccountSummary() { return { ok: false, error: 'not_used', rows: [] }; },
    getStatus() {
      return {
        connected,
        host: '127.0.0.1',
        port: 4002,
        clientId: 955,
        serverVersion: 193,
        connectedAt: null,
        reconnectCount: 0,
        marketDataTypeLabel: 'realtime',
        managedAccounts: [],
        contracts: [],
        lastErrors: [],
        pacing: {},
      };
    },
  };
}

// ── 1. Default OFF = inert ───────────────────────────────────────────────────
delete process.env.IB_FUTURES_DATA_ENABLED;
const disabled = createFuturesMarketDataService({ adapter: fakeAdapter() });
assert.equal(disabled.isEnabled(), false, 'default ska vara disabled');
assert.equal(disabled.getQuote('MNQ'), null, 'disabled → ingen quote');
const disabledCandles = disabled.getCandles('MNQ', {});
assert.equal(disabledCandles.ok, false);
assert.equal(disabledCandles.error, 'ib_futures_data_disabled');

(async () => {
  const disabledStart = await disabled.start();
  assert.equal(disabledStart.ok, false, 'start ska vägra när flaggan är av');

  // ── 2. Quote-normalisering (MNQ + MES) ─────────────────────────────────────
  const freshQuote = (root, last) => ({
    root,
    conId: 1000 + last,
    localSymbol: `${root}U6`,
    expiry: '20260918',
    exchange: 'CME',
    currency: 'USD',
    last,
    bid: last - 0.25,
    ask: last + 0.25,
    close: last - 10,
    volume: 12345,
    spread: 0.5,
    marketDataType: 1,
    marketDataTypeLabel: 'realtime',
    delayed: false,
    updatedAt: new Date().toISOString(),
    staleAgeMs: 500,
    connected: true,
  });
  const service = createFuturesMarketDataService({
    forceEnabled: true,
    persistEnabled: false,
    adapter: fakeAdapter({
      quotes: { MNQ: freshQuote('MNQ', 29700), MES: freshQuote('MES', 7600) },
    }),
  });

  const mnq = service.getQuote('MNQ');
  assert.equal(mnq.instrument, 'MNQ');
  assert.equal(mnq.localSymbol, 'MNQU6');
  assert.equal(mnq.expiry, '20260918');
  assert.equal(mnq.currency, 'USD');
  assert.equal(mnq.source.provider, 'ibkr');
  assert.equal(mnq.source.simulated, false, 'IB-quote får aldrig märkas simulated');
  assert.equal(mnq.source.realTime, true);
  assert.equal(mnq.quality.status, 'ok');
  assert.equal(mnq.safety.readOnly, true);
  assert.equal(mnq.safety.can_place_orders, false);
  assert.equal(mnq.safety.actions_allowed, false);
  const mes = service.getQuote('MES');
  assert.equal(mes.instrument, 'MES');
  assert.equal(mes.tickSize, 0.25);

  // Stale quote → degraded quality med reason.
  const staleService = createFuturesMarketDataService({
    forceEnabled: true,
    persistEnabled: false,
    adapter: fakeAdapter({
      quotes: {
        MNQ: {
          ...freshQuote('MNQ', 29700),
          staleAgeMs: 10 * 60 * 1000,
          updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      },
    }),
  });
  const staleQuote = staleService.getQuote('MNQ');
  assert.equal(staleQuote.quality.status, 'degraded');
  assert.ok(staleQuote.quality.reasons.includes('stale_quote'));
  assert.equal(staleService.isQuoteFresh('MNQ'), false);

  // Delayed quote → source.mode delayed, realTime false.
  const delayedService = createFuturesMarketDataService({
    forceEnabled: true,
    persistEnabled: false,
    adapter: fakeAdapter({
      quotes: { MNQ: { ...freshQuote('MNQ', 29700), delayed: true, marketDataType: 3, marketDataTypeLabel: 'delayed' } },
    }),
  });
  const delayedQuote = delayedService.getQuote('MNQ');
  assert.equal(delayedQuote.source.mode, 'delayed');
  assert.equal(delayedQuote.source.realTime, false);
  assert.equal(delayedQuote.source.simulated, false);

  // ── 3. Candles: backfill, 1m/2m/5m, open vs closed ─────────────────────────
  // 12 hela minuter + en bar i "nu"-minuten (öppen).
  const nowDate = new Date();
  nowDate.setUTCSeconds(30, 0);
  const nowMs = nowDate.getTime();
  const minuteStart = (offset) => {
    const d = new Date(nowMs);
    d.setUTCSeconds(0, 0);
    return new Date(d.getTime() - offset * 60 * 1000);
  };
  // Justera så första baren ligger på jämn 10-minutersgräns för stabil 2m/5m-bucketing.
  const mkBar = (offsetMin, base) => {
    const ts = minuteStart(offsetMin);
    return {
      epoch: Math.floor(ts.getTime() / 1000),
      timestamp: ts.toISOString(),
      open: base, high: base + 2, low: base - 2, close: base + 1,
      volume: 100 + offsetMin,
      tradeCount: 10,
    };
  };
  const bars = [];
  for (let i = 12; i >= 0; i -= 1) bars.push(mkBar(i, 29700 + i));
  const candleService = createFuturesMarketDataService({
    forceEnabled: true,
    persistEnabled: false,
    refreshIntervalMs: 60 * 60 * 1000,
    adapter: fakeAdapter({
      quotes: { MNQ: freshQuote('MNQ', 29700) },
      bars: { MNQ: { ok: true, contract: { conId: 1, localSymbol: 'MNQU6', expiry: '20260918', exchange: 'CME', currency: 'USD' }, bars } },
    }),
  });
  await candleService.refreshAllOnce();

  const c1m = candleService.getCandles('MNQ', { timeframe: '1m', limit: 100, now: nowDate });
  assert.equal(c1m.ok, true);
  assert.equal(c1m.count, 12, `12 stängda 1m-candles förväntade (fick ${c1m.count})`);
  assert.ok(c1m.openCandle, 'nuvarande minut ska vara öppet candle');
  assert.equal(c1m.openCandle.isClosed, false);
  assert.equal(c1m.candles.every((c) => c.isClosed === true), true, 'alla returnerade candles ska vara stängda');
  assert.equal(c1m.candles[0].dataSource, 'ib');
  assert.equal(c1m.candles[0].source.simulated, false);
  assert.equal(c1m.candles[0].volume != null, true, 'volume ska följa med');
  assert.equal(c1m.candles[0].tradeCount, 10, 'tradeCount ska följa med');
  // Contract-metadata hämtas från adapterns lösta quote-kontrakt.
  assert.equal(c1m.candles[0].conId, 30700, 'contract-metadata ska följa datan');
  assert.equal(c1m.candles[0].localSymbol, 'MNQU6');
  const latestHistoricalQuote = candleService.getLatestHistoricalQuote('MNQ', { now: nowDate });
  assert.equal(latestHistoricalQuote.source.historical, true);
  assert.equal(latestHistoricalQuote.source.simulated, false);
  assert.equal(latestHistoricalQuote.last, bars[bars.length - 1].close);
  assert.equal(latestHistoricalQuote.localSymbol, 'MNQU6');

  const c2m = candleService.getCandles('MNQ', { timeframe: '2m', limit: 100, now: nowDate });
  assert.equal(c2m.ok, true);
  assert.ok(c2m.count >= 5, `minst 5 stängda 2m-candles (fick ${c2m.count})`);
  for (const candle of c2m.candles) {
    const startMs = new Date(candle.timestamp).getTime();
    assert.ok(startMs + 2 * 60 * 1000 <= nowMs, '2m-candle får inte vara stängd innan perioden passerat');
  }

  const c5m = candleService.getCandles('MNQ', { timeframe: '5m', limit: 100, now: nowDate });
  assert.equal(c5m.ok, true);
  assert.ok(c5m.count >= 1, `minst 1 stängd 5m-candle (fick ${c5m.count})`);

  // Ej stödd timeframe + ej spårad root.
  assert.equal(candleService.getCandles('MNQ', { timeframe: '3m' }).ok, false);
  assert.equal(candleService.getCandles('NQ', { timeframe: '1m' }).ok, false, 'NQ är quote-context, inte candle-root');

  // ── 4. Status ────────────────────────────────────────────────────────────
  const statusPayload = candleService.getStatus(nowDate);
  assert.equal(statusPayload.enabled, true);
  assert.equal(statusPayload.adapter.connected, true);
  assert.ok(statusPayload.candles.MNQ.bars1mInMemory >= 13);
  assert.equal(statusPayload.mode, 'paper_only');
  const summary = candleService.getStatusSummary(nowDate);
  assert.equal(summary.connected, true);
  assert.equal(summary.source, 'ibkr');

  console.log('futuresMarketDataService.test.js OK');
})().catch((err) => {
  console.error('TEST FAIL:', err.message);
  process.exit(1);
});
