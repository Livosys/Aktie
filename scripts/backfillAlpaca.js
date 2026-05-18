#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { fetchAlpacaBars, isEnabled, hasCredentials } = require('../src/data/alpacaDataService');
const { saveRawBars, saveCandles2m }                 = require('../src/data/marketDataStore');
const { aggregate1mTo2m, filterComplete }            = require('../src/data/candleAggregator');

// ── Config from args or defaults ──────────────────────────────────────────────

const args = process.argv.slice(2);

const SYMBOLS = (args[0] ? args[0].split(',') : ['AAPL', 'NVDA', 'TSLA']).map((s) => s.trim());
const START   = args[1] || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const END     = args[2] || new Date().toISOString().slice(0, 10);

console.log('=== Alpaca Backfill ===');
console.log(`Symbols  : ${SYMBOLS.join(', ')}`);
console.log(`Range    : ${START} → ${END}`);
console.log(`Enabled  : ${isEnabled()}`);
console.log(`Auth OK  : ${hasCredentials()}`);
console.log('');

if (!isEnabled()) {
  console.error('ERROR: ALPACA_ENABLED=false — set it to true in .env to run backfill');
  process.exit(1);
}
if (!hasCredentials()) {
  console.error('ERROR: ALPACA_API_KEY_ID or ALPACA_API_SECRET_KEY missing in .env');
  process.exit(1);
}

async function backfill() {
  for (const symbol of SYMBOLS) {
    console.log(`\n[${symbol}] Fetching 1Min bars ${START} → ${END}…`);

    let bars;
    try {
      bars = await fetchAlpacaBars({ symbol, timeframe: '1Min', start: START, end: END, limit: 10000 });
    } catch (err) {
      console.error(`[${symbol}] FETCH ERROR: ${err.message}`);
      continue;
    }

    if (!bars || bars.length === 0) {
      console.warn(`[${symbol}] No bars returned — market may have been closed or symbol invalid`);
      continue;
    }

    console.log(`[${symbol}] Received ${bars.length} 1m bars`);

    // Group by date
    const byDate = {};
    for (const bar of bars) {
      const date = (bar.ts || '').slice(0, 10);
      if (!date) continue;
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(bar);
    }

    for (const [date, dateBars] of Object.entries(byDate).sort()) {
      const rawSaved = saveRawBars(symbol, date, dateBars);
      const candles  = filterComplete(aggregate1mTo2m(dateBars));
      const c2mSaved = saveCandles2m(symbol, date, candles);
      console.log(`  ${date}: ${rawSaved} raw bars, ${c2mSaved} 2m candles`);
    }
  }

  console.log('\nBackfill complete.');
}

backfill().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
