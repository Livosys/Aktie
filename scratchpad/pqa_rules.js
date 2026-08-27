'use strict';
// Producer Quality Audit — READ-ONLY regelnedbrytning.
//
// Mäter på KANDIDATERNAS egna produktionsfält, dvs. produktionens egen
// nedskrivna bevisning. Ingen rekonstruktion av producentens indata (det
// försöket förkastades: arkivet saknar tidsramsfält och gav artefakter).
//
// Reglerna nedan är villkoren i confirmedEntryPromotion()
// (decisionMonitor.js:372-416) — den ENDA väg dessa tre subtyper kan nå
// 'active'/entry_ready, eftersom basstegen ger 'caution' så snart minst en
// soft blocker finns (decisionMonitor.js:508-512).
const fs = require('fs');

const TARGETS = {
  ema_pullback_continuation: 'EMA_PULLBACK_UP',
  vwap_volume_breakout_long: 'VWAP_RECLAIM_UP',
  narrow_state_expansion_long: 'NARROW_BULL_ENTRY',
};

const seen = new Map();
for (const line of fs.readFileSync('data/futures-paper/events.jsonl', 'utf8').split('\n')) {
  if (!line || !line.includes('FUTURES_SCANNER_CANDIDATES_ADDED')) continue;
  let e;
  try { e = JSON.parse(line); } catch (_) { continue; }
  if (e.type !== 'FUTURES_SCANNER_CANDIDATES_ADDED') continue;
  for (const c of e.candidates || []) {
    if (!TARGETS[c.strategyId]) continue;
    if (!seen.has(c.strategyId)) seen.set(c.strategyId, new Map());
    seen.get(c.strategyId).set(c.candidateId, c);
  }
}

// Gemensamma villkor + subtypsspecifika, i samma ordning som koden.
function rulesFor(sid, c) {
  const vol = String(c.volumeState || '').toLowerCase();
  const common = [
    ['bias måste vara UP', String(c.direction || '').toLowerCase() === 'long'],
    ['extensionLevel måste vara "none"', c.extensionLevel === 'none'],
    ['twoMinuteConfirmed', c.twoMinuteConfirmed === true],
    ['closedCandle bekräftad', c.closedCandleConfirmed === true],
    ['dataFreshness = LIVE', String(c.dataFreshness || '').toUpperCase() === 'LIVE'],
  ];
  if (sid === 'narrow_state_expansion_long') {
    return [...common, ['volym användbar (ej weak)', vol === 'normal' || vol === 'strong']];
  }
  if (sid === 'ema_pullback_continuation') {
    return [...common,
      ['trendIntact', c.trendIntact === true],
      ['EMA reclaim bekräftad', c.emaReclaimConfirmed === true],
      ['volym användbar (ej weak)', vol === 'normal' || vol === 'strong'],
    ];
  }
  return [...common,
    ['VWAP reclaim bekräftad', c.vwapReclaimConfirmed === true],
    ['close över VWAP', c.closeAboveVwap === true],
    ['volym STARK', vol === 'strong'],
  ];
}

for (const [sid, sub] of Object.entries(TARGETS)) {
  const all = [...(seen.get(sid) || new Map()).values()];
  // Kandidater utan bevisfält kan inte mätas regelvis — redovisas separat.
  const evid = all.filter((c) => c.extensionLevel != null || c.twoMinuteConfirmed != null);
  console.log('═'.repeat(76));
  console.log(`${sid}   (subtyp ${sub})`);
  console.log(`  kandidater totalt ${all.length}, med bevisfält ${evid.length}, utan ${all.length - evid.length}`);
  if (!evid.length) continue;

  const names = rulesFor(sid, evid[0]).map((r) => r[0]);
  const fails = names.map(() => 0);
  const soleFails = names.map(() => 0);
  let passAll = 0;

  for (const c of evid) {
    const res = rulesFor(sid, c).map((r) => r[1]);
    const failedIdx = res.map((ok, i) => (ok ? -1 : i)).filter((i) => i >= 0);
    failedIdx.forEach((i) => { fails[i] += 1; });
    if (failedIdx.length === 0) passAll += 1;
    if (failedIdx.length === 1) soleFails[failedIdx[0]] += 1;
  }

  console.log(`  ${'regel'.padEnd(34)} ${'blockerar'.padStart(10)} ${'%'.padStart(6)} ${'ensam'.padStart(7)} ${'kvar utan regeln'.padStart(17)}`);
  names.forEach((n, i) => {
    const pct = ((fails[i] / evid.length) * 100).toFixed(1);
    const remaining = passAll + soleFails[i];
    console.log(`  ${n.padEnd(34)} ${String(fails[i]).padStart(10)} ${pct.padStart(6)} ${String(soleFails[i]).padStart(7)} ${String(remaining).padStart(17)}`);
  });
  console.log(`  → passerar ALLA villkor idag: ${passAll}`);
}
