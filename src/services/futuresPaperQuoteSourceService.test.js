'use strict';

const assert = require('assert/strict');

const { createFuturesPaperQuoteSourceService } = require('./futuresPaperQuoteSourceService');

function fakeMarketData({ enabled = true, quotes = {}, candles = null, freshMs = 120000 } = {}) {
  return {
    QUOTE_FRESH_MS: freshMs,
    isEnabled: () => enabled,
    getQuote: (root) => quotes[root] || null,
    getCandles: (root, opts) => candles ? candles(root, opts) : { ok: false, error: 'no_fixture', candles: [], openCandle: null },
  };
}

function fakeFallback() {
  const mk = (root) => ({
    root, symbol: root, price: 1000, previousPrice: 999, tickSize: 0.25,
    updatedAt: new Date().toISOString(), source: 'simulated_fallback', simulated: true, fallback: true,
  });
  return {
    tickQuotes: () => ({ quotes: ['MNQ', 'MES', 'NQ', 'ES'].map(mk) }),
    getQuotes: () => ({ quotes: ['MNQ', 'MES', 'NQ', 'ES'].map(mk) }),
    getQuote: (root) => mk(root),
  };
}

const ibQuote = (root, { staleAgeMs = 1000, delayed = false } = {}) => ({
  instrument: root, root, localSymbol: `${root}U6`, conId: 42, expiry: '20260918',
  exchange: 'CME', currency: 'USD', last: 29700, bid: 29699.75, ask: 29700.25,
  close: 29650, spread: 0.5, volume: 999, tickSize: 0.25,
  marketDataType: delayed ? 3 : 1, marketDataTypeLabel: delayed ? 'delayed' : 'realtime',
  updatedAt: new Date(Date.now() - staleAgeMs).toISOString(), staleAgeMs,
  source: { provider: 'ibkr', delayed },
});

// En vardagstid när Globex är ÖPPEN (onsdag 14:00 UTC = 09:00 CT, US RTH).
const OPEN_NOW = new Date('2026-07-15T14:00:00.000Z');
// Lördag = marknaden stängd.
const CLOSED_NOW = new Date('2026-07-18T14:00:00.000Z');

// ── 1. IB färsk → ibkr_realtime, aldrig simulated-flaggad ────────────────────
const ibService = createFuturesPaperQuoteSourceService({
  marketDataService: fakeMarketData({ quotes: { MNQ: ibQuote('MNQ'), MES: ibQuote('MES'), NQ: ibQuote('NQ'), ES: ibQuote('ES') } }),
  fallbackFeedService: fakeFallback(),
});
const ibFeed = ibService.getQuotes(OPEN_NOW);
assert.equal(ibFeed.feed.source, 'ibkr_realtime');
assert.equal(ibFeed.feed.simulated, false);
assert.equal(ibFeed.quotes.length, 4);
for (const q of ibFeed.quotes) {
  assert.equal(q.simulated, false);
  assert.equal(q.source, 'ibkr_realtime');
  assert.equal(q.localSymbol, `${q.root}U6`);
  assert.ok(q.bid != null && q.ask != null && q.spread != null, 'bid/ask/spread ska följa med');
}
assert.equal(ibFeed.mode, 'paper_only');
assert.equal(ibFeed.can_place_orders, false);

// ── 2. IB delayed → märks ibkr_delayed (aldrig realtime) ─────────────────────
const delayedService = createFuturesPaperQuoteSourceService({
  marketDataService: fakeMarketData({ quotes: { MNQ: ibQuote('MNQ', { delayed: true }) } }),
  fallbackFeedService: fakeFallback(),
});
const delayedQuote = delayedService.getQuote('MNQ', OPEN_NOW);
assert.equal(delayedQuote.source, 'ibkr_delayed');
assert.equal(delayedQuote.delayed, true);

// ── 3. IB stale under ÖPPEN marknad → ärlig simulerad fallback ───────────────
const staleOpenService = createFuturesPaperQuoteSourceService({
  marketDataService: fakeMarketData({ quotes: { MNQ: ibQuote('MNQ', { staleAgeMs: 10 * 60 * 1000 }) } }),
  fallbackFeedService: fakeFallback(),
});
const staleOpenQuote = staleOpenService.getQuote('MNQ', OPEN_NOW);
assert.equal(staleOpenQuote.source, 'simulated_fallback', 'stale IB-quote under öppen marknad → fallback');
assert.equal(staleOpenQuote.simulated, true);

// ── 4. IB stale under STÄNGD marknad → sista riktiga pris, märkt stale ──────
const staleClosedService = createFuturesPaperQuoteSourceService({
  marketDataService: fakeMarketData({ quotes: { MNQ: ibQuote('MNQ', { staleAgeMs: 10 * 60 * 1000 }) } }),
  fallbackFeedService: fakeFallback(),
});
const staleClosedQuote = staleClosedService.getQuote('MNQ', CLOSED_NOW);
assert.equal(staleClosedQuote.source, 'ibkr_realtime', 'stängd marknad → behåll sista riktiga IB-pris');
assert.equal(staleClosedQuote.stale, true, 'ska vara tydligt märkt stale');
assert.equal(staleClosedQuote.simulated, false);

// ── 5. Blandad feed → mixed-label ────────────────────────────────────────────
const mixedService = createFuturesPaperQuoteSourceService({
  marketDataService: fakeMarketData({ quotes: { MNQ: ibQuote('MNQ') } }),
  fallbackFeedService: fakeFallback(),
});
const mixedFeed = mixedService.getQuotes(OPEN_NOW);
assert.equal(mixedFeed.feed.source, 'mixed_ibkr_and_simulated');
assert.equal(mixedFeed.feed.fallback, true);
assert.equal(mixedFeed.feed.perSymbolSources.MNQ, 'ibkr_realtime');
assert.equal(mixedFeed.feed.perSymbolSources.MES, 'simulated_fallback');

// ── 6. IB avstängd → allt simulerad fallback (som idag) ──────────────────────
const disabledService = createFuturesPaperQuoteSourceService({
  marketDataService: fakeMarketData({ enabled: false }),
  fallbackFeedService: fakeFallback(),
});
const disabledFeed = disabledService.getQuotes(OPEN_NOW);
assert.equal(disabledFeed.feed.source, 'simulated_fallback');
assert.equal(disabledFeed.feed.simulated, true);

// Candles utan IB → tom lista med ärlig källa (aldrig syntetiska candles).
const disabledCandles = disabledService.getCandles('MNQ', { now: OPEN_NOW });
assert.equal(disabledCandles.candles.length, 0);
assert.ok(disabledCandles.warnings.includes('ib_futures_data_disabled'));

// ── 7. Candles med IB → vidarebefordras med contract ─────────────────────────
const candleService = createFuturesPaperQuoteSourceService({
  marketDataService: fakeMarketData({
    quotes: {},
    candles: () => ({
      ok: true,
      candles: [{ timestamp: '2026-07-15T13:58:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, isClosed: true, conId: 42, localSymbol: 'MNQU6', expiry: '20260918', dataSource: 'ib' }],
      openCandle: null,
      count: 1,
    }),
  }),
  fallbackFeedService: fakeFallback(),
});
const candleResult = candleService.getCandles('MNQ', { now: OPEN_NOW });
assert.equal(candleResult.candles.length, 1);
assert.equal(candleResult.source, 'ib_historical');
assert.equal(candleResult.contract.localSymbol, 'MNQU6');

console.log('futuresPaperQuoteSourceService.test.js OK');
