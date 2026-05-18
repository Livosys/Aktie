#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { analyzeOutcomes } = require('../src/scanner/signalOutcomeAnalyzer');
const { saveLearning }    = require('../src/scanner/signalLearning');

const args = process.argv.slice(2);

const SYMBOLS = args[0] ? args[0].split(',').map((s) => s.trim()) : [];
const START   = args[1] || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const END     = args[2] || new Date().toISOString().slice(0, 10);

console.log('=== Signal Outcome Analyzer ===');
console.log(`Symbols : ${SYMBOLS.length > 0 ? SYMBOLS.join(', ') : 'all'}`);
console.log(`Range   : ${START} → ${END}`);
console.log('');

async function main() {
  // Step 1: Analyze outcomes
  console.log('Step 1: Analyzing signal outcomes…');
  const outcomeSummary = await analyzeOutcomes({ symbols: SYMBOLS, start: START, end: END });
  console.log(`  Processed: ${outcomeSummary.processed}, Skipped: ${outcomeSummary.skipped}`);

  // Step 2: Build and save learning summary
  console.log('\nStep 2: Building learning summary…');
  const learningSummary = saveLearning({ start: START, end: END, symbols: SYMBOLS });

  const symbolKeys = Object.keys(learningSummary).filter((k) => !k.startsWith('_'));
  console.log(`  Summary covers ${symbolKeys.length} symbol(s): ${symbolKeys.join(', ')}`);

  for (const sym of symbolKeys) {
    const s = learningSummary[sym];
    console.log(`\n  ${sym}: ${s.samples} samples, winRate=${s.winRate ?? 'n/a'}`);
    if (s.bestEventType) console.log(`    Best event: ${s.bestEventType} (${s.bestEventWinRate})`);
    if (s.commonFailures && s.commonFailures.length > 0) {
      console.log(`    Common failures: ${s.commonFailures.map((f) => f.reason).join(', ')}`);
    }
  }

  console.log('\nDone. learning-summary.json saved.');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
