'use strict';
const https = require('https');

const BINANCE_BASE = 'https://api.binance.com/api/v3/klines';

// Binance interval mapping: our timeframe strings → Binance interval param
const INTERVAL_MAP = {
  '1m':   '1m',
  '1Min': '1m',
  '2m':   '2m',
  '2Min': '2m',
};

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            let parsed;
            try { parsed = JSON.parse(body); } catch { parsed = {}; }
            reject(new Error(`Binance API error (HTTP ${res.statusCode}): ${parsed.msg || body.slice(0, 200)}`));
          } else {
            resolve(JSON.parse(body));
          }
        } catch (e) {
          reject(new Error(`Binance response parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch klines (candlestick data) from Binance public API.
 *
 * @param {object} opts
 * @param {string} opts.symbol    - e.g. "BTCUSDT"
 * @param {string} opts.interval  - "1m" | "2m" | "1Min" | "2Min"
 * @param {string} opts.start     - "YYYY-MM-DD" or ISO datetime
 * @param {string} opts.end       - "YYYY-MM-DD" or ISO datetime
 * @param {number} [opts.limit]   - candles per request (max 1000, default 1000)
 * @returns {Promise<Array>}      - normalized bars
 */
async function fetchBinanceKlines({ symbol, interval = '1m', start, end, limit = 1000 }) {
  if (!symbol || !start || !end) {
    throw new Error('fetchBinanceKlines requires symbol, start, and end');
  }

  const binanceInterval = INTERVAL_MAP[interval] || interval;
  const pageLimit       = Math.min(Math.max(1, limit), 1000);

  const startMs = new Date(start.length === 10 ? start + 'T00:00:00Z' : start).getTime();
  const endMs   = new Date(end.length   === 10 ? end   + 'T23:59:59Z' : end  ).getTime();

  const allBars = [];
  let cursor    = startMs;
  const MAX_PAGES = 200;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BINANCE_BASE}?symbol=${encodeURIComponent(symbol)}&interval=${binanceInterval}&startTime=${cursor}&endTime=${endMs}&limit=${pageLimit}`;

    let raw;
    try {
      raw = await fetchJson(url);
    } catch (err) {
      throw new Error(`Binance fetch failed for ${symbol}: ${err.message}`);
    }

    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const k of raw) {
      // Binance kline: [openTime, open, high, low, close, volume, closeTime, ...]
      const openTime  = k[0];
      const closeTime = k[6];
      const ts        = new Date(openTime).toISOString();
      allBars.push({
        ts,
        t:      ts,
        open:   parseFloat(k[1]),
        o:      parseFloat(k[1]),
        high:   parseFloat(k[2]),
        h:      parseFloat(k[2]),
        low:    parseFloat(k[3]),
        l:      parseFloat(k[3]),
        close:  parseFloat(k[4]),
        c:      parseFloat(k[4]),
        volume: parseFloat(k[5]),
        v:      parseFloat(k[5]),
        source:    'binance',
        symbol,
        timeframe: interval,
        _closeTime: closeTime,
      });
    }

    if (raw.length < pageLimit) break;

    // Advance cursor past the last bar's close time
    const lastCloseTime = raw[raw.length - 1][6];
    cursor = lastCloseTime + 1;

    if (cursor > endMs) break;

    await delay(200);
  }

  return allBars;
}

module.exports = { fetchBinanceKlines };
