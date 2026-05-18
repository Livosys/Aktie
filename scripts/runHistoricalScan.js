#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { runHistoricalScan } = require('../src/scanner/historicalScanner');

const args = process.argv.slice(2);

const SYMBOLS = (args[0] ? args[0].split(',') : ['AAPL', 'NVDA', 'TSLA']).map((s) => s.trim());
const START   = args[1] || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const END     = args[2] || new Date().toISOString().slice(0, 10);

console.log('=== Historical Scanner ===');
console.log(`Symbols : ${SYMBOLS.join(', ')}`);
console.log(`Range   : ${START} → ${END}`);
console.log('');

async function main() {
  const summary = await runHistoricalScan({ symbols: SYMBOLS, start: START, end: END });

  console.log('\n=== Summary ===');
  for (const [symbol, stats] of Object.entries(summary)) {
    if (stats.error) {
      console.error(`${symbol}: ERROR — ${stats.error}`);
    } else if (stats.warning) {
      console.warn(`${symbol}: ${stats.candlesLoaded} candles, ${stats.signalsSaved} signals (${stats.warning})`);
    } else {
      console.log(`${symbol}: ${stats.candlesLoaded} candles loaded → ${stats.signalsSaved} signals saved`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
