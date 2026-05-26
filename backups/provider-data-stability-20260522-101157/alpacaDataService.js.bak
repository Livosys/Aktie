'use strict';
const axios = require('axios');

// Uses same credentials as alpacaClient.js (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY)
// New env vars:
//   ALPACA_ENABLED=true|false  (default: true — set false to disable all Alpaca calls)
//   ALPACA_DATA_BASE_URL       (default: https://data.alpaca.markets/v2)

const DEFAULT_BASE = 'https://data.alpaca.markets/v2';

function dataBase() {
  return (process.env.ALPACA_DATA_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

function isEnabled() {
  // Default true — only disable if explicitly set to 'false'
  return process.env.ALPACA_ENABLED !== 'false';
}

function hasCredentials() {
  return !!(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

function headers() {
  return {
    'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY,
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch historical bars from Alpaca Markets API.
 *
 * @param {object} opts
 * @param {string} opts.symbol      - e.g. "AAPL", "NVDA"
 * @param {string} opts.timeframe   - "1Min" | "2Min" (Alpaca supports both)
 * @param {string} opts.start       - ISO date "YYYY-MM-DD" or datetime
 * @param {string} opts.end         - ISO date "YYYY-MM-DD" or datetime
 * @param {number} [opts.limit]     - bars per page (max 10000, default 1000)
 * @returns {Promise<Array>}        - normalized bars
 */
async function fetchAlpacaBars({ symbol, timeframe = '1Min', start, end, limit = 1000 }) {
  if (!isEnabled()) {
    throw new Error('ALPACA_ENABLED=false — Alpaca data service is disabled');
  }
  if (!hasCredentials()) {
    throw new Error(
      'Alpaca API credentials missing (set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in .env)'
    );
  }
  if (!symbol || !start || !end) {
    throw new Error('fetchAlpacaBars requires symbol, start, and end');
  }

  const feed = process.env.ALPACA_DATA_FEED || 'iex';
  const url  = `${dataBase()}/stocks/${encodeURIComponent(symbol)}/bars`;

  const params = {
    timeframe,
    start,
    end,
    limit:      Math.min(Math.max(1, limit), 10000),
    feed,
    adjustment: 'raw',
    sort:       'asc',
  };

  const allBars   = [];
  let nextToken   = undefined;
  const MAX_PAGES = 50; // safety ceiling

  for (let page = 0; page < MAX_PAGES; page++) {
    const reqParams = { ...params };
    if (nextToken) reqParams.page_token = nextToken;

    let res;
    try {
      res = await axios.get(url, {
        headers: headers(),
        params:  reqParams,
        timeout: 20000,
      });
    } catch (err) {
      const status = err?.response?.status;
      const msg    = err?.response?.data?.message || err?.response?.data?.error || err.message || 'unknown';
      throw new Error(`Alpaca API error (HTTP ${status || 'network'}): ${msg}`);
    }

    const bars = res.data.bars || [];
    allBars.push(...bars);

    nextToken = res.data.next_page_token;
    if (!nextToken) break;

    // Respect rate limits: ~200 req/min on free tier
    if (page > 0 && page % 5 === 0) await delay(500);
    else await delay(80);
  }

  // Normalize to a consistent shape
  return allBars.map((b) => ({
    ts:        b.t,
    open:      b.o,
    high:      b.h,
    low:       b.l,
    close:     b.c,
    volume:    b.v,
    // Short aliases expected by indicators.js / narrowState.js
    t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
    source:    'alpaca',
    symbol,
    timeframe,
  }));
}

/**
 * Fetch 1Min bars and return them (raw).
 * If the caller wants 2Min, they should aggregate with candleAggregator.
 */
async function fetch1MinBars(symbol, start, end, limit = 1000) {
  return fetchAlpacaBars({ symbol, timeframe: '1Min', start, end, limit });
}

module.exports = { fetchAlpacaBars, fetch1MinBars, isEnabled, hasCredentials };
