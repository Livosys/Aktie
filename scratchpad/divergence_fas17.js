'use strict';
// FAS 17 / FAS 2 — divergensanalys: EMA / VWAP / NARROW mot mnq_globex_momentum_v1.
// READ-ONLY. Kör arbetsträdets kod (det som ska deployas).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const orch = require('../src/services/ibPaperExecutionOrchestratorService');
const router = require('../src/services/canonical/canonicalExecutionRouter');
const registry = require('../src/services/strategyRegistryService');
const configService = require('../src/services/ibPaperExecutionConfigService');
const intentService = require('../src/services/ibPaperExecutionIntentService').defaultIbPaperExecutionIntentService;

const TARGETS = ['mnq_globex_momentum_v1', 'ema_pullback_continuation', 'vwap_volume_breakout_long', 'narrow_state_expansion_long'];
const DAYS = (process.env.DAYS || '2026-08-06').split(',');

const lines = fs.readFileSync(path.join(__dirname, '../data/futures-paper/events.jsonl'), 'utf8').split('\n');
const bySt = new Map();
for (const l of lines) {
  if (!l) continue;
  let e; try { e = JSON.parse(l); } catch (_) { continue; }
  if (e.type !== 'FUTURES_SCANNER_CANDIDATES_ADDED') continue;
  if (!DAYS.some((d) => String(e.timestamp || '').startsWith(d))) continue;
  for (const c of (e.candidates || [])) {
    if (!TARGETS.includes(c.strategyId)) continue;
    if (!bySt.has(c.strategyId)) bySt.set(c.strategyId, []);
    bySt.get(c.strategyId).push({ addedAt: e.timestamp, c });
  }
}

const limits = configService.getPilotLimits();
console.log('maxIntentAgeMs =', limits.maxIntentAgeMs, '| symbolAllowlist =', limits.symbolAllowlist.join(','));
console.log('');

const realNow = Date.now;
for (const sid of TARGETS) {
  const rows = bySt.get(sid) || [];
  console.log('══════════════════════════════════════════════════════════════');
  console.log(sid, '— kandidater:', rows.length);
  if (!rows.length) { console.log('  (inga)'); continue; }

  // registry-grinden
  const gate = registry.canExecuteStrategy(sid);
  console.log('  registry.canExecuteStrategy →', gate.allowed, gate.blockedReason || '');

  // ta den "bästa" kandidaten (högst signalStatus-prio) för fältjämförelse
  const PRIO = { active: 0, ready: 0, confirmed: 0, entry_ready: 0, caution: 1, watch: 2, wait: 3, avoid: 4 };
  const best = rows.slice().sort((a, b) => (PRIO[a.c.signalStatus] ?? 9) - (PRIO[b.c.signalStatus] ?? 9))[0];
  const c = best.c;
  const n = orch.normalizeCandidate(c);

  // ålder vid orchestrator-anropet (scan-tid ≈ addedAt)
  const ageMs = Date.parse(best.addedAt) - Date.parse(c.signalTimestamp || c.timestamp || c.createdAt);

  const idem = intentService.buildIdempotencyKey({
    strategyId: n.strategyId, root: n.root, conId: 793356225, direction: n.direction,
    candidateId: n.candidateId, signalTimestamp: n.signalTimestamp, accountIdMasked: 'DU***596', environment: 'paper',
  });

  const sess = c.sessionMetadata || {};
  const frozen = Date.parse(c.signalTimestamp) + Math.max(ageMs, 0);
  Date.now = () => frozen;
  let d;
  try {
    d = router.routeExecutionReadiness({
      strategyId: n.strategyId, candidate: n, now: new Date(frozen),
      marketContext: { marketType: 'futures', session: sess.sessionId || null, sessionId: sess.sessionId || null, isMarketOpen: sess.isMarketOpen === true },
    });
  } catch (err) { d = { allowed: false, reasonCode: 'ERR:' + err.message }; }
  finally { Date.now = realNow; }

  const F = (k, v) => console.log('   ', String(k).padEnd(30), v);
  console.log('  — bästa kandidat', c.candidateId, '@', best.addedAt);
  F('signalStatus', c.signalStatus);
  F('signalSubtype', c.signalSubtype);
  F('direction → guard direction_valid', `${n.direction} → ${n.direction === 'long' || n.direction === 'short'}`);
  F('root → symbol_allowlisted', `${n.root} → ${limits.symbolAllowlist.includes(n.root)}`);
  F('candidateId', n.candidateId ? 'OK' : 'SAKNAS');
  F('strategyId (normalized)', n.strategyId || 'SAKNAS');
  F('signalTimestamp', n.signalTimestamp);
  F('ageMs vid scan → candidate_fresh', `${ageMs} → ${ageMs <= limits.maxIntentAgeMs}`);
  F('idempotencyKey', idem ? 'OK' : 'SAKNAS');
  F('quantity / orderType', `${n.quantity} / ${n.orderType}`);
  F('stopLossPrice / takeProfit', `${n.stopLossPrice} / ${n.takeProfitPrice}`);
  F('closedCandleConfirmed', n.closedCandleConfirmed);
  F('twoMinuteConfirmation', JSON.stringify(n.twoMinuteConfirmation));
  F('emaPullbackConfirmation', JSON.stringify(n.emaPullbackConfirmation));
  F('vwapReclaimConfirmation', JSON.stringify(n.vwapReclaimConfirmation));
  F('volumeConfirmation', JSON.stringify(n.volumeConfirmation));
  F('ROUTER verdict', `${d.allowed} ${d.reasonCode || ''}`);

  // fördelning över alla kandidater
  const agg = {};
  for (const r of rows) {
    const nn = orch.normalizeCandidate(r.c);
    const ss = r.c.sessionMetadata || {};
    const fz = Date.parse(r.c.signalTimestamp) + 30000;
    Date.now = () => fz;
    let dd; try {
      dd = router.routeExecutionReadiness({ strategyId: nn.strategyId, candidate: nn, now: new Date(fz),
        marketContext: { marketType: 'futures', session: ss.sessionId || null, sessionId: ss.sessionId || null, isMarketOpen: ss.isMarketOpen === true } });
    } catch (err) { dd = { allowed: false, reasonCode: 'ERR' }; } finally { Date.now = realNow; }
    const k = dd.allowed ? 'ALLOWED' : dd.reasonCode;
    agg[k] = (agg[k] || 0) + 1;
  }
  console.log('  — routerutfall alla:', JSON.stringify(agg));
}
