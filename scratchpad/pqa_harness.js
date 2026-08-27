'use strict';
// Producer Quality Audit — READ-ONLY. Kör den RIKTIGA buildDecisionMonitor på
// arkiverade signalrader och jämför mot observerad status, för att först
// validera att harnessen är trogen innan några regelsiffror tas på allvar.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildDecisionMonitor } = require('../src/scanner/decisionMonitor');

const SUB = new Set(['EMA_PULLBACK_UP', 'EMA_PULLBACK_DOWN', 'VWAP_RECLAIM_UP', 'NARROW_BULL_ENTRY']);
const dir = 'data/signals/history';
const rows = [];
for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith('.jsonl') || f.slice(0, 10) < '2026-07-07') continue;
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let s;
    try { s = JSON.parse(line); } catch (_) { continue; }
    if (SUB.has(s.signalSubtype)) rows.push(s);
  }
}
console.log('arkiverade signaler av intresse:', rows.length);

// marketClosed=false så sessionen inte maskerar regelutfallet.
const dm = buildDecisionMonitor({
  stockResults: rows,
  cryptoResults: [],
  liveCandleDebugBySymbol: {},
  stockFeedStatus: null,
});
const cands = Array.isArray(dm?.candidates) ? dm.candidates : [];
console.log('rekonstruerade kandidater:', cands.length);
if (!cands.length) {
  console.log('nycklar i dm:', Object.keys(dm || {}));
  process.exit(0);
}
const c0 = cands[0];
console.log('\nexempel:', JSON.stringify({
  symbol: c0.symbol, signalSubtype: c0.signalSubtype, signal: c0.signal,
  priority: c0.priority, status: c0.status, entryReady: c0.entryReady,
  extensionLevel: c0.extensionLevel, agreementCount: c0.agreementCount,
  hardBlockers: c0.hardBlockers, softBlockers: c0.softBlockers,
  blockers: c0.blockers, missingConfirmations: c0.missingConfirmations,
}, null, 1));

const byPrio = {};
for (const c of cands) byPrio[c.priority || 'null'] = (byPrio[c.priority || 'null'] || 0) + 1;
console.log('\nrekonstruerad priority-fördelning:', JSON.stringify(byPrio));
