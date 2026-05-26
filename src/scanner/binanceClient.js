'use strict';
const axios = require('axios');
const { withProviderRetry } = require('../providerStatus');

const BASE = 'https://api.binance.com/api/v3';

async function fetch1mBars(symbol, limit = 410) {
  const url = `${BASE}/klines`;
  const res = await withProviderRetry('binance', () => axios.get(url, {
    params: { symbol, interval: '1m', limit },
    timeout: 12000,
  }), { context: { symbol, endpoint: 'klines' } });

  return res.data.map((k) => ({
    t: new Date(k[0]).toISOString(),
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
}

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

module.exports = { fetch1mBars, aggregate1mTo2m };
