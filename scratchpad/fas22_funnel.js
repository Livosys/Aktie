'use strict';
// FAS 22 — READ-ONLY tratt-analys. Implementerar ingenting.
//
// Lager: Producer → Candidate → producerEntryReadiness → signalStatus →
//        Canonical Readiness → Entry Contract → Guard
//
// Mätfällor som hanteras:
//  1. Kandidater återutsänds varje scan → dedupliceras på candidateId.
//  2. Klockan fryses till kandidatens signalTimestamp, annars blir varje
//     historisk kandidat stale och alla faller på samma sak.
//  3. marketContext speglas från ibPaperExecutionOrchestratorService.js:874-884.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const orch = require('../src/services/ibPaperExecutionOrchestratorService');
const router = require('../src/services/canonical/canonicalExecutionRouter');
const hours = require('../src/services/futuresMarketHoursService');

const TARGETS = [
  'ema_pullback_continuation',
  'vwap_volume_breakout_long',
  'narrow_state_expansion_long',
];
// Referens: den enda strategin som faktiskt handlar.
const REFERENCE = 'mnq_globex_momentum_v1';

// ── Lager 1: producentens signaler ──────────────────────────────────────────
const SUBTYPE_TO_STRATEGY = {
  EMA_PULLBACK_UP: 'ema_pullback_continuation',
  EMA_PULLBACK_DOWN: 'ema_pullback_continuation',
  VWAP_RECLAIM_UP: 'vwap_volume_breakout_long',
  NARROW_BULL_ENTRY: 'narrow_state_expansion_long',
};
const producedBySubtype = {};
const histDir = 'data/signals/history';
for (const file of fs.readdirSync(histDir).sort()) {
  if (!file.endsWith('.jsonl')) continue;
  const day = file.replace('.jsonl', '');
  if (day < '2026-07-07') continue;
  for (const line of fs.readFileSync(path.join(histDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    let s;
    try { s = JSON.parse(line); } catch (_) { continue; }
    const sub = s.signalSubtype;
    if (!SUBTYPE_TO_STRATEGY[sub]) continue;
    const sid = SUBTYPE_TO_STRATEGY[sub];
    producedBySubtype[sid] = producedBySubtype[sid] || {};
    producedBySubtype[sid][sub] = (producedBySubtype[sid][sub] || 0) + 1;
  }
}

// ── Lager 2: kandidater, deduplicerade ──────────────────────────────────────
const byStrategy = new Map();
for (const line of fs.readFileSync('data/futures-paper/events.jsonl', 'utf8').split('\n')) {
  if (!line || !line.includes('FUTURES_SCANNER_CANDIDATES_ADDED')) continue;
  let e;
  try { e = JSON.parse(line); } catch (_) { continue; }
  if (e.type !== 'FUTURES_SCANNER_CANDIDATES_ADDED') continue;
  for (const c of e.candidates || []) {
    const sid = c.strategyId;
    if (!TARGETS.includes(sid) && sid !== REFERENCE) continue;
    if (!byStrategy.has(sid)) byStrategy.set(sid, new Map());
    const m = byStrategy.get(sid);
    // Behåll den instans som kom längst: rangordna på signalStatus.
    const PRIO = { entry_ready: 0, ready: 0, confirmed: 0, active: 0, caution: 1, watch: 2, wait: 3, avoid: 4 };
    const prev = m.get(c.candidateId);
    if (!prev || (PRIO[c.signalStatus] ?? 9) < (PRIO[prev.signalStatus] ?? 9)) {
      m.set(c.candidateId, c);
    }
  }
}

const realNow = Date.now;
const out = [];

for (const sid of [...TARGETS, REFERENCE]) {
  const cands = [...(byStrategy.get(sid) || new Map()).values()];
  const status = {};
  const producerReady = { true: 0, false: 0, null: 0 };
  const contractTally = {};
  const readinessTally = {};

  for (const c of cands) {
    status[c.signalStatus || 'null'] = (status[c.signalStatus || 'null'] || 0) + 1;
    const er = c.entryReady;
    producerReady[er === true ? 'true' : (er === false ? 'false' : 'null')] += 1;

    const frozen = Date.parse(c.signalTimestamp || c.timestamp || c.createdAt);
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
      // Guarden avgör godkännande på `allowed` (ibPaperExecutionGuardService.js:91-96),
      // inte `approved`. Fel fält här gav 2123 falska 'unknown' för mnq_globex.
      const key = contract.allowed === true ? 'APPROVED' : (contract.reasonCode || 'unknown');
      contractTally[key] = (contractTally[key] || 0) + 1;
      const rk = contract.readiness?.reasonCode || contract.readiness?.verdict || 'n/a';
      readinessTally[rk] = (readinessTally[rk] || 0) + 1;
    } catch (err) {
      contractTally[`THREW:${err.message}`] = (contractTally[`THREW:${err.message}`] || 0) + 1;
    } finally {
      Date.now = realNow;
    }
  }

  out.push({ sid, produced: producedBySubtype[sid] || {}, candidates: cands.length, status, producerReady, readinessTally, contractTally });
}

for (const r of out) {
  console.log('═'.repeat(78));
  console.log(r.sid);
  const prodTot = Object.values(r.produced).reduce((a, b) => a + b, 0);
  console.log(`  1. Producer               ${prodTot} signaler  ${JSON.stringify(r.produced)}`);
  console.log(`  2. Candidates (unika)     ${r.candidates}`);
  console.log(`  3. producerEntryReadiness entryReady=true:${r.producerReady.true}  false:${r.producerReady.false}  saknas:${r.producerReady.null}`);
  console.log(`  4. signalStatus           ${JSON.stringify(r.status)}`);
  console.log('  5. Canonical Readiness');
  for (const [k, v] of Object.entries(r.readinessTally).sort((a, b) => b[1] - a[1])) console.log(`       ${String(v).padStart(5)}  ${k}`);
  console.log('  6. Entry Contract');
  for (const [k, v] of Object.entries(r.contractTally).sort((a, b) => b[1] - a[1])) console.log(`       ${String(v).padStart(5)}  ${k}`);
  const approved = r.contractTally.APPROVED || 0;
  console.log(`  7. Guard                  ${approved} kandidater skulle nå guarden`);
}
