'use strict';
const axios = require('axios');

const DATA_BASE = 'https://data.alpaca.markets/v2';

function headers() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY,
  };
}

/**
 * Fetch recent 1-minute bars for a symbol going back enough days
 * to build at least 200 2-minute candles (= 400 1-minute bars).
 * Uses a start date 7 calendar days back to ensure coverage across weekends.
 * Paginates if needed to collect up to maxBars bars.
 */
async function fetch1mBars(symbol, maxBars = 1000) {
  const feed = process.env.ALPACA_DATA_FEED || 'iex';
  const url = `${DATA_BASE}/stocks/${symbol}/bars`;

  // Start 7 calendar days back to cover weekends and holidays
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const startISO = start.toISOString().split('T')[0];

  const params = {
    timeframe: '1Min',
    limit: 1000,
    feed,
    adjustment: 'raw',
    start: startISO,
    sort: 'asc',
  };

  const allBars = [];
  let nextToken = undefined;

  for (let page = 0; page < 3; page++) {
    const reqParams = { ...params };
    if (nextToken) reqParams.page_token = nextToken;

    const res = await axios.get(url, { headers: headers(), params: reqParams, timeout: 12000 });
    const bars = res.data.bars || [];
    allBars.push(...bars);

    nextToken = res.data.next_page_token;
    if (!nextToken || allBars.length >= maxBars) break;
  }

  // Keep only the most recent maxBars bars
  const slice = allBars.slice(-maxBars);
  return slice.map((b) => ({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
}

/**
 * Fetch latest trade/quote for a symbol.
 * Returns { price, timestamp }
 */
async function fetchLatestTrade(symbol) {
  const feed = process.env.ALPACA_DATA_FEED || 'iex';
  const url = `${DATA_BASE}/stocks/${symbol}/trades/latest`;
  const res = await axios.get(url, { headers: headers(), params: { feed }, timeout: 8000 });
  const trade = res.data.trade;
  return { price: trade.p, timestamp: trade.t };
}

/**
 * Aggregate 1-minute bars into 2-minute bars.
 * Pairs bars in chronological order: bar[0]+bar[1] → candle[0], etc.
 */
function aggregate1mTo2m(bars1m) {
  const candles = [];
  for (let i = 0; i + 1 < bars1m.length; i += 2) {
    const a = bars1m[i];
    const b = bars1m[i + 1];
    candles.push({
      t: a.t,
      o: a.o,
      h: Math.max(a.h, b.h),
      l: Math.min(a.l, b.l),
      c: b.c,
      v: a.v + b.v,
    });
  }
  return candles;
}

module.exports = { fetch1mBars, fetchLatestTrade, aggregate1mTo2m };
