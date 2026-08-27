'use strict';
// FAS 16 — READ-ONLY replay av produktionsbeslutet.
//
// VIKTIGT: den körande prod-processen startade 2026-08-06T13:15:59Z, medan
// src/services/ibPaperExecutionOrchestratorService.js skrevs om 16:19 samma dag.
// Prod kör alltså HEAD-versionen av normalizeCandidate, inte arbetsträdets.
// Därför reimplementeras HEAD:s normalizeCandidate exakt här (git show
// HEAD:src/services/ibPaperExecutionOrchestratorService.js:100-140).
//
// Mätfällor: (1) klockan fryses, (2) marketContext speglas från
// ibPaperExecutionOrchestratorService.js:844-849.

require('dotenv').config();
const fs = require('fs');
const router = require('../src/services/canonical/canonicalExecutionRouter');

const MODE = process.env.MODE || 'head'; // head | worktree
const worktreeNormalize = require('../src/services/ibPaperExecutionOrchestratorService').normalizeCandidate;

function safeString(v) { return v == null ? '' : String(v).trim(); }
function safeUpper(v) { return safeString(v).toUpperCase(); }
function safeNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function sideFromCandidate(c = {}) {
  const raw = safeString(c.direction || c.side || c.entrySide || c.action).toLowerCase();
  if (['long', 'buy', 'bull', 'bullish', 'up'].includes(raw)) return 'long';
  if (['short', 'sell', 'bear', 'bearish', 'down'].includes(raw)) return 'short';
  return null;
}
function candidateTimestamp(c = {}) {
  return c.signalTimestamp || c.timestamp || c.createdAt || c.candidateTimestamp || null;
}

// EXAKT kopia av HEAD:s normalizeCandidate (produktionsversionen).
function headNormalizeCandidate(input = {}) {
  const candidate = input && typeof input === 'object' ? input : {};
  const root = safeUpper(candidate.root || candidate.symbol || candidate.instrument);
  const strategyId = safeString(candidate.strategyId || candidate.strategy_id || candidate.canonicalStrategyId);
  const direction = sideFromCandidate(candidate);
  const signalTimestamp = candidateTimestamp(candidate);
  const signalSubtype = candidate.signalSubtype || candidate.signal_subtype || candidate.subtype
    || candidate.entrySubtype || candidate.patternSubtype || null;
  const signalStatus = candidate.signalStatus || candidate.signal_status || candidate.status || candidate.priority || null;
  return {
    candidateId: safeString(candidate.candidateId || candidate.id || candidate.eventId),
    originalSignalId: safeString(candidate.originalSignalId || candidate.signalId),
    status: signalStatus,
    signalStatus,
    signalSubtype,
    signal_subtype: signalSubtype,
    subtype: signalSubtype,
    dataFreshness: candidate.dataFreshness || null,
    market: candidate.market || null,
    marketType: candidate.marketType || candidate.market || null,
    sessionId: candidate.sessionId || candidate.sessionMetadata?.sessionId || null,
    session: candidate.session || candidate.sessionMetadata?.session || null,
    sessionMetadata: candidate.sessionMetadata || null,
    closedCandleConfirmed: candidate.closedCandleConfirmed === true || candidate.hasClosedCandle === true,
    latestCandleClosed: candidate.latestCandleClosed === true || candidate.closedCandleConfirmed === true || candidate.hasClosedCandle === true,
    twoMinuteConfirmation: candidate.twoMinuteConfirmation === true,
    emaPullbackConfirmation: candidate.emaPullbackConfirmation === true,
    vwapReclaimConfirmation: candidate.vwapReclaimConfirmation === true,
    volumeConfirmation: candidate.volumeConfirmation === true,
    confidence: candidate.confidence ?? null,
    nextMoveBias: candidate.nextMoveBias || candidate.next_move_bias || direction,
    root,
    symbol: root,
    strategyId,
    direction,
    signalTimestamp,
    candleTimestamp: candidate.candleTimestamp || candidate.barTimestamp || signalTimestamp,
    timestamp: candidate.timestamp || signalTimestamp,
    createdAt: candidate.createdAt || signalTimestamp,
    quantity: 1,
    orderType: safeUpper(candidate.orderType || candidate.entryOrderType || 'MKT'),
    limitPrice: safeNumber(candidate.limitPrice ?? candidate.entryLimitPrice),
    stopLossPrice: safeNumber(candidate.stopLossPrice ?? candidate.stopLoss ?? candidate.stop),
    takeProfitPrice: safeNumber(candidate.takeProfitPrice ?? candidate.takeProfit ?? candidate.takeProfit1),
  };
}

const normalize = MODE === 'worktree' ? worktreeNormalize : headNormalizeCandidate;

const DAYS = (process.env.DAYS || '2026-08-06').split(',');
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const OFFSET = Number(process.env.OFFSET || 30000);

const lines = fs.readFileSync(`${__dirname}/../data/futures-paper/events.jsonl`, 'utf8').split('\n');
const seen = new Set();
const cands = [];
for (const l of lines) {
  if (!l) continue;
  let e; try { e = JSON.parse(l); } catch (_) { continue; }
  const ts = String(e.timestamp || '');
  if (!DAYS.some((d) => ts.startsWith(d))) continue;
  if (e.type !== 'FUTURES_SCANNER_CANDIDATES_ADDED') continue;
  for (const c of (e.candidates || [])) {
    if (ONLY.length && !ONLY.includes(c.strategyId)) continue;
    if (seen.has(c.candidateId)) continue;
    seen.add(c.candidateId);
    cands.push({ addedAt: ts, candidate: c });
  }
}

const realNow = Date.now;
const out = [];
for (const row of cands) {
  const c = row.candidate;
  const sess = c.sessionMetadata || c.signalSessionMetadata || {};
  const frozen = Date.parse(c.signalTimestamp || c.timestamp || c.createdAt || row.addedAt) + OFFSET;
  const now = new Date(frozen);
  Date.now = () => frozen;
  let d;
  try {
    const n = normalize(c);
    d = router.routeExecutionReadiness({
      strategyId: n.strategyId,
      candidate: n,
      now,
      marketContext: {
        marketType: 'futures',
        session: sess.sessionId || null,
        sessionId: sess.sessionId || null,
        isMarketOpen: sess.isMarketOpen === true,
      },
    });
  } catch (err) {
    d = { allowed: false, reasonCode: 'REPLAY_ERROR:' + err.message };
  } finally { Date.now = realNow; }
  out.push({
    addedAt: row.addedAt,
    candidateId: c.candidateId,
    strategyId: c.strategyId,
    signalStatus: c.signalStatus,
    signalSubtype: c.signalSubtype,
    direction: c.direction,
    originalSymbol: c.originalSymbol,
    producerEntryReady: c.producerEntryReadiness ? c.producerEntryReadiness.entryReady === true : null,
    producerStatus: c.producerEntryReadiness ? c.producerEntryReadiness.status : null,
    allowed: d.allowed === true,
    reasonCode: d.reasonCode || null,
    verdict: d.readiness?.verdict || null,
  });
}

const agg = {};
for (const r of out) {
  const k = `${r.strategyId} | ${r.allowed ? 'ALLOWED' : r.reasonCode}`;
  agg[k] = (agg[k] || 0) + 1;
}
console.log(`=== MODE=${MODE} DAYS=${DAYS} kandidater=${out.length} OFFSET=${OFFSET}ms ===`);
for (const k of Object.keys(agg).sort()) console.log(String(agg[k]).padStart(4), k);
if (process.env.DUMP) { console.log('\n--- alla ---'); for (const r of out) console.log(JSON.stringify(r)); }
