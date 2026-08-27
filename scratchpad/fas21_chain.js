'use strict';
// FAS 21 — READ-ONLY kedjegenomgång.
// Canonical Signal → Execution Readiness → Router → Entry Contract, körd på
// VERKLIGA kandidater ur events.jsonl.
//
// Två mätfällor som måste hanteras (annars mäts fel sak):
//  1. Klockan fryses till kandidatens skapandetid — annars blir varje historisk
//     kandidat stale och alla faller på samma sak.
//  2. marketContext speglas exakt från ibPaperExecutionOrchestratorService.js:874-884.
require('dotenv').config();
const fs = require('fs');
const orch = require('../src/services/ibPaperExecutionOrchestratorService');
const router = require('../src/services/canonical/canonicalExecutionRouter');
const hours = require('../src/services/futuresMarketHoursService');
const registry = require('../src/services/strategyRegistryService');

const TARGET = process.env.SID || 'ema_pullback_continuation';
const DAY = process.env.DAY || '2026-08-06';

const rows = [];
for (const line of fs.readFileSync('data/futures-paper/events.jsonl', 'utf8').split('\n')) {
  if (!line || !line.includes(TARGET) || !line.includes(DAY)) continue;
  let e;
  try { e = JSON.parse(line); } catch (_) { continue; }
  if (e.type !== 'FUTURES_SCANNER_CANDIDATES_ADDED') continue;
  if (!String(e.timestamp || '').startsWith(DAY)) continue;
  for (const c of e.candidates || []) {
    if (c.strategyId === TARGET) rows.push({ addedAt: e.timestamp, c });
  }
}

console.log(`strategi: ${TARGET}   dag: ${DAY}   kandidater: ${rows.length}`);

const gate = registry.canExecuteStrategy(TARGET);
console.log(`registry.canExecuteStrategy → allowed=${gate.allowed} ${gate.blockedReason || ''}`);

const realNow = Date.now;
const tally = new Map();
const samples = new Map();

for (const { addedAt, c } of rows) {
  const frozen = Date.parse(c.signalTimestamp || c.timestamp || addedAt);
  Date.now = () => frozen;
  try {
    const now = new Date(frozen);
    const n = orch.normalizeCandidate(c);
    const session = hours.getCmeEquityIndexFuturesSessionState(now);
    const contract = router.routeExecutionReadiness({
      strategyId: n.strategyId,
      candidate: n,
      now,
      marketContext: {
        marketType: 'futures',
        session: session.sessionId || null,
        sessionId: session.sessionId || null,
        isMarketOpen: session.isMarketOpen === true,
      },
    });
    const reason = contract.approved === true
      ? 'APPROVED'
      : (contract.reasonCode || contract.blockedReason || 'unknown');
    tally.set(reason, (tally.get(reason) || 0) + 1);
    if (!samples.has(reason)) samples.set(reason, { addedAt, n, contract });
  } catch (err) {
    const k = `THREW:${err.message}`;
    tally.set(k, (tally.get(k) || 0) + 1);
  } finally {
    Date.now = realNow;
  }
}

console.log('\nEntry Contract-utfall:');
for (const [reason, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${reason}`);
}

const first = [...samples.entries()].sort((a, b) => tally.get(b[0]) - tally.get(a[0]))[0];
if (first) {
  const [reason, { addedAt, n, contract }] = first;
  console.log(`\nStörsta blockeraren: ${reason}`);
  console.log('  addedAt:', addedAt);
  console.log('  normaliserad kandidat:', JSON.stringify({
    candidateId: n.candidateId, strategyId: n.strategyId, direction: n.direction,
    root: n.root, signalStatus: n.signalStatus, signalTimestamp: n.signalTimestamp,
    entryPrice: n.entryPrice, stopLossPrice: n.stopLossPrice, takeProfitPrice: n.takeProfitPrice,
    quantity: n.quantity, orderType: n.orderType, closedCandleConfirmed: n.closedCandleConfirmed,
  }, null, 1));
  console.log('  entryContract:', JSON.stringify(contract, null, 1).slice(0, 1400));
}
