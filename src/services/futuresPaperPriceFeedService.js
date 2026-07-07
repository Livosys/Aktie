'use strict';

// Paper-only simulated fallback price source for MNQ/MES.
// Ingen riktig marknadsdata hämtas här — priserna är en intern random walk
// runt rimliga nivåer och är alltid märkta simulated/fallback.

const path = require('path');
const storageService = require('./futuresPaperStorageService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_price_feed',
});

const FEED_SOURCE = 'simulated_fallback';

const BASE_PRICES = Object.freeze({
  MNQ: { basePrice: 29900, tickSize: 0.25, maxDriftPct: 2.5, stepPct: 0.05 },
  MES: { basePrice: 7557, tickSize: 0.25, maxDriftPct: 2.5, stepPct: 0.04 },
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function roundToTick(value, tickSize) {
  const tick = Number(tickSize) || 0.25;
  return Math.round(Number(value) / tick) * tick;
}

function createDefaultFeedState(now = new Date()) {
  const state = { updatedAt: nowIso(now), quotes: {} };
  for (const [root, meta] of Object.entries(BASE_PRICES)) {
    state.quotes[root] = {
      root,
      price: meta.basePrice,
      previousPrice: meta.basePrice,
      updatedAt: nowIso(now),
    };
  }
  return state;
}

function createFuturesPaperPriceFeedService(options = {}) {
  const storage = options.storageService || storageService.defaultFuturesPaperStorageService;
  const stateFile = path.join(storage.rootDir, 'price-feed-state.json');
  const random = typeof options.random === 'function' ? options.random : Math.random;

  function readState() {
    const raw = storageService.readJson(stateFile, null);
    if (raw && raw.quotes && typeof raw.quotes === 'object') return raw;
    const fresh = createDefaultFeedState();
    storageService.writeJson(stateFile, fresh);
    return fresh;
  }

  function writeState(state) {
    return storageService.writeJson(stateFile, { ...state, updatedAt: nowIso() });
  }

  function stepQuote(root, quote, now = new Date()) {
    const meta = BASE_PRICES[root];
    if (!meta) return null;
    const current = Number(quote?.price) || meta.basePrice;
    // Random walk med mean reversion mot basnivån så priset håller sig rimligt.
    const step = current * (meta.stepPct / 100) * (random() * 2 - 1);
    const reversion = (meta.basePrice - current) * 0.01;
    let next = current + step + reversion;
    const maxDrift = meta.basePrice * (meta.maxDriftPct / 100);
    next = Math.min(meta.basePrice + maxDrift, Math.max(meta.basePrice - maxDrift, next));
    return {
      root,
      price: roundToTick(next, meta.tickSize),
      previousPrice: roundToTick(current, meta.tickSize),
      updatedAt: nowIso(now),
    };
  }

  function toQuoteView(quote, root) {
    const meta = BASE_PRICES[root] || {};
    return {
      root,
      symbol: root,
      price: Number(quote?.price) || meta.basePrice || null,
      previousPrice: Number(quote?.previousPrice) || null,
      tickSize: meta.tickSize || 0.25,
      updatedAt: quote?.updatedAt || null,
      source: FEED_SOURCE,
      simulated: true,
      fallback: true,
      note: 'Simulerat fallback-pris, inte riktig marknadsdata. Endast paper-simulation.',
    };
  }

  // Stega alla priser ett steg och returnera aktuella quotes.
  function tickQuotes(now = new Date()) {
    const state = readState();
    const nextQuotes = {};
    for (const root of Object.keys(BASE_PRICES)) {
      nextQuotes[root] = stepQuote(root, state.quotes[root], now);
    }
    writeState({ quotes: nextQuotes });
    return getQuotes(now, nextQuotes);
  }

  function getQuotes(now = new Date(), quotesOverride = null) {
    const quotes = quotesOverride || readState().quotes || {};
    const rows = Object.keys(BASE_PRICES).map((root) => toQuoteView(quotes[root], root));
    return {
      ok: true,
      generatedAt: nowIso(now),
      feed: {
        source: FEED_SOURCE,
        simulated: true,
        fallback: true,
        description: 'Simulerad fallback-feed för MNQ/MES. Ingen riktig MNQ/MES-marknadsdata är inkopplad.',
      },
      quotes: rows,
      ...SAFETY,
    };
  }

  function getQuote(root, now = new Date()) {
    const key = String(root || '').trim().toUpperCase();
    if (!BASE_PRICES[key]) return null;
    const state = readState();
    return toQuoteView(state.quotes[key], key);
  }

  function resetFeed(now = new Date()) {
    const fresh = createDefaultFeedState(now);
    storageService.writeJson(stateFile, fresh);
    return getQuotes(now, fresh.quotes);
  }

  return {
    SAFETY,
    FEED_SOURCE,
    BASE_PRICES,
    stateFile,
    tickQuotes,
    getQuotes,
    getQuote,
    resetFeed,
  };
}

const defaultFuturesPaperPriceFeedService = createFuturesPaperPriceFeedService();

module.exports = {
  SAFETY,
  FEED_SOURCE,
  BASE_PRICES,
  roundToTick,
  createDefaultFeedState,
  createFuturesPaperPriceFeedService,
  defaultFuturesPaperPriceFeedService,
};
