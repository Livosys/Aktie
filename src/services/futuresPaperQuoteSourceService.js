'use strict';

// Composite quote-källa för Futures Paper.
//
// Prioritet: riktiga IB-quotes (futuresMarketDataService) när flaggan är på
// och quoten är färsk — annars den befintliga simulerade fallback-feeden,
// alltid med ärlig source-märkning per quote. Simulerad data presenteras
// ALDRIG som IB-data och vice versa.
//
// Interfacet är avsiktligt identiskt med futuresPaperPriceFeedService
// (tickQuotes/getQuotes/getQuote) plus getCandles för producers, så att
// scannern kan byta källa utan att ändra sin logik.

const futuresMarketData = require('./futuresMarketDataService');
const simulatedFeed = require('./futuresPaperPriceFeedService');
const futuresMarketHours = require('./futuresMarketHoursService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_quote_source',
});

const SOURCE_IB_REALTIME = 'ibkr_realtime';
const SOURCE_IB_DELAYED = 'ibkr_delayed';
const SOURCE_SIMULATED = 'simulated_fallback';

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function createFuturesPaperQuoteSourceService(options = {}) {
  const marketData = options.marketDataService || futuresMarketData.defaultFuturesMarketDataService;
  const fallback = options.fallbackFeedService || simulatedFeed.defaultFuturesPaperPriceFeedService;
  const roots = options.roots || Object.keys(simulatedFeed.BASE_PRICES);

  function ibQuoteView(root, now = new Date()) {
    if (!marketData.isEnabled()) return null;
    const quote = marketData.getQuote(root, now);
    if (!quote) return null;
    const price = quote.last ?? ((quote.bid != null && quote.ask != null) ? (quote.bid + quote.ask) / 2 : quote.close);
    if (price == null) return null;
    const freshMs = marketData.QUOTE_FRESH_MS || 120000;
    const isStale = quote.staleAgeMs == null || quote.staleAgeMs > freshMs;
    if (isStale) {
      // Under maintenance/stängd marknad finns ingen färsk tick — sista
      // riktiga IB-priset (tydligt märkt stale) är då ärligare än en
      // simulerad random walk. Under öppen marknad → ärlig fallback.
      const session = futuresMarketHours.getCmeEquityIndexFuturesSessionState(now);
      if (session.isOpen || quote.staleAgeMs == null) return null;
    }
    const delayed = quote.source?.delayed === true || quote.marketDataTypeLabel === 'delayed' || quote.marketDataTypeLabel === 'delayed_frozen';
    return {
      root,
      symbol: root,
      price,
      previousPrice: quote.close ?? null,
      bid: quote.bid ?? null,
      ask: quote.ask ?? null,
      spread: quote.spread ?? null,
      volume: quote.volume ?? null,
      tickSize: quote.tickSize ?? 0.25,
      localSymbol: quote.localSymbol || null,
      conId: quote.conId || null,
      expiry: quote.expiry || null,
      exchange: quote.exchange || 'CME',
      currency: quote.currency || 'USD',
      updatedAt: quote.updatedAt,
      staleAgeMs: quote.staleAgeMs,
      stale: isStale,
      source: delayed ? SOURCE_IB_DELAYED : SOURCE_IB_REALTIME,
      simulated: false,
      fallback: false,
      delayed,
      note: delayed
        ? 'IB-quote i delayed-läge (prenumeration/datatyp), inte realtid.'
        : 'Riktig IB realtidsquote (CME).',
    };
  }

  function buildQuoteRows(now = new Date(), { tickSimulated = false } = {}) {
    // Fallback-quotes hämtas i ETT anrop (tick eller läs) och används endast
    // för de roots där IB-quoten saknas/är stale.
    let fallbackRows = null;
    function fallbackRow(root) {
      if (!fallbackRows) {
        const result = tickSimulated ? fallback.tickQuotes(now) : fallback.getQuotes(now);
        fallbackRows = new Map((result.quotes || []).map((q) => [q.root, q]));
      }
      return fallbackRows.get(root) || null;
    }
    return roots.map((root) => ibQuoteView(root, now) || fallbackRow(root)).filter(Boolean);
  }

  function summarizeFeed(rows) {
    const sources = new Set(rows.map((row) => row.source));
    const allIb = rows.length > 0 && [...sources].every((s) => s === SOURCE_IB_REALTIME || s === SOURCE_IB_DELAYED);
    const anyIb = [...sources].some((s) => s === SOURCE_IB_REALTIME || s === SOURCE_IB_DELAYED);
    let source;
    if (allIb) source = sources.has(SOURCE_IB_DELAYED) ? SOURCE_IB_DELAYED : SOURCE_IB_REALTIME;
    else if (anyIb) source = 'mixed_ibkr_and_simulated';
    else source = SOURCE_SIMULATED;
    return {
      source,
      simulated: !anyIb,
      fallback: !allIb,
      provider: anyIb ? 'ibkr' : 'simulated',
      perSymbolSources: Object.fromEntries(rows.map((row) => [row.root, row.source])),
      description: allIb
        ? 'Riktiga IB-quotes (CME) för MNQ/MES/NQ/ES via read-only IB-dataadapter.'
        : (anyIb
          ? 'Blandad feed: IB-quotes där de är färska, simulerad fallback för övriga.'
          : 'Simulerad fallback-feed för MNQ/MES. Ingen riktig MNQ/MES-marknadsdata är inkopplad.'),
    };
  }

  function getQuotes(now = new Date()) {
    const rows = buildQuoteRows(now, { tickSimulated: false });
    return {
      ok: true,
      generatedAt: nowIso(now),
      feed: summarizeFeed(rows),
      quotes: rows,
      ...SAFETY,
    };
  }

  // tickQuotes: IB-quotes strömmar in via adaptern (ingen stegning behövs).
  // Endast den simulerade reserven stegas — och bara för roots utan IB-data.
  function tickQuotes(now = new Date()) {
    const rows = buildQuoteRows(now, { tickSimulated: true });
    return {
      ok: true,
      generatedAt: nowIso(now),
      feed: summarizeFeed(rows),
      quotes: rows,
      ...SAFETY,
    };
  }

  function getQuote(root, now = new Date()) {
    const key = String(root || '').trim().toUpperCase();
    if (!roots.includes(key)) return null;
    return ibQuoteView(key, now) || fallback.getQuote(key, now);
  }

  // Producer-interface: riktiga IB-candles när datalagret är på.
  // Utan IB-data returneras tom lista med ärlig source (ingen syntetisk candle).
  function getCandles(root, { now = new Date(), timeframe = '1m', limit = 50 } = {}) {
    if (!marketData.isEnabled()) {
      return { candles: [], source: SOURCE_SIMULATED, dataQuality: 'missing_real_candles', contract: null, warnings: ['ib_futures_data_disabled'] };
    }
    const result = marketData.getCandles(root, { timeframe, limit, now });
    if (!result.ok) {
      return { candles: [], source: 'ib_unavailable', dataQuality: 'missing', contract: null, warnings: [result.error].filter(Boolean) };
    }
    return {
      candles: result.candles,
      openCandle: result.openCandle,
      source: 'ib_historical',
      dataQuality: result.candles.length ? 'ib' : 'missing',
      contract: result.candles.length ? {
        root,
        conId: result.candles[result.candles.length - 1]?.conId || null,
        localSymbol: result.candles[result.candles.length - 1]?.localSymbol || null,
        expiry: result.candles[result.candles.length - 1]?.expiry || null,
      } : null,
      warnings: [],
    };
  }

  function getFeedStatus(now = new Date()) {
    const rows = buildQuoteRows(now, { tickSimulated: false });
    return { ...summarizeFeed(rows), generatedAt: nowIso(now), quotes: rows.length };
  }

  return {
    SAFETY,
    SOURCE_IB_REALTIME,
    SOURCE_IB_DELAYED,
    SOURCE_SIMULATED,
    getQuotes,
    tickQuotes,
    getQuote,
    getCandles,
    getFeedStatus,
  };
}

const defaultFuturesPaperQuoteSourceService = createFuturesPaperQuoteSourceService();

module.exports = {
  SAFETY,
  SOURCE_IB_REALTIME,
  SOURCE_IB_DELAYED,
  SOURCE_SIMULATED,
  createFuturesPaperQuoteSourceService,
  defaultFuturesPaperQuoteSourceService,
};
