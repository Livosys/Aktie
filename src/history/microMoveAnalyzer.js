'use strict';

const fs   = require('fs');
const path = require('path');

const SIGNALS_DIR  = path.resolve(__dirname, '../../data/signals/history');
const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const OUTPUT_PATH  = path.resolve(__dirname, '../../data/signals/micro-move-analysis.json');

const HORIZONS = [3, 5, 10, 20, 30]; // 2m candles
const HIT025_THRESHOLD = 0.25;
const HIT050_THRESHOLD = 0.50;

// A "ready" eventType must have blocked_hit025Rate >= this
const MICRO_READY_MIN_025 = 0.40;
// Score window for MICRO_MOVE_READY classification
const MICRO_READY_SCORE_MIN = 15;
const MICRO_READY_SCORE_MAX = 38;

function round(n, d = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const f = 10 ** d;
  return Math.round(Number(n) * f) / f;
}

function avg(arr) {
  const vals = arr.filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
  return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 4) : null;
}

function readJsonlDir(dir, days = 30) {
  if (!fs.existsSync(dir)) return [];
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const dateStr = file.replace('.jsonl', '');
    if (dateStr < cutoff) continue;
    const fp = path.join(dir, file);
    try {
      for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* skip unreadable */ }
  }
  return rows;
}

function isLong(signal) {
  return (signal || '').includes('LONG') || signal === 'LONG_TRIGGERED';
}

// ── Per-signal micro metrics ──────────────────────────────────────────────────

function calcMicroMetrics(signal, outcomeIsLong) {
  let hit025 = false, hit050 = false;
  let time025 = null, time050 = null;
  let maxAdverse = 0;

  for (const h of HORIZONS) {
    const oc = signal[`outcome${h}`];
    if (!oc) continue;
    const maxFav = outcomeIsLong ? (oc.maxMoveUp ?? 0) : (oc.maxMoveDown ?? 0);
    const maxAdv = outcomeIsLong ? (oc.maxMoveDown ?? 0) : (oc.maxMoveUp ?? 0);

    if (!hit025 && maxFav >= HIT025_THRESHOLD) { hit025 = true; time025 = h * 2; } // minutes
    if (!hit050 && maxFav >= HIT050_THRESHOLD) { hit050 = true; time050 = h * 2; }
    maxAdverse = Math.max(maxAdverse, maxAdv);
  }

  return { hit025, hit050, time025, time050, maxAdverse: round(maxAdverse, 4) };
}

// ── Blocked reason ────────────────────────────────────────────────────────────

function classifyBlockReason(sig) {
  const score  = sig.tradeScore ?? 0;
  const relVol = sig.relVol20   ?? null;
  const ptz    = sig.priceToZoneAtr ?? null;
  const tfs    = sig.threeFingerSpreadActive === true;

  if (tfs)                                   return 'tfs';
  if (relVol !== null && relVol < 0.7)       return 'weakVolume';
  if (ptz    !== null && ptz    > 1.5)       return 'farFromZone';
  if (score  <= 10)                          return 'veryLowScore';
  return 'lowScore';
}

function scoreCategory(tradeScore) {
  if (tradeScore <= 20) return 'BLOCKED';
  if (tradeScore <= 40) return 'WEAK';
  return 'READY';
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

function emptyBucket(label) {
  return { label, samples: 0, hit025: 0, hit050: 0, times025: [], times050: [], adverses: [] };
}

function finalizeBucket(b) {
  return {
    label:       b.label,
    samples:     b.samples,
    hit025Rate:  b.samples ? round(b.hit025 / b.samples, 4) : null,
    hit050Rate:  b.samples ? round(b.hit050 / b.samples, 4) : null,
    hit025Count: b.hit025,
    hit050Count: b.hit050,
    avgTime025:  avg(b.times025),
    avgTime050:  avg(b.times050),
    avgAdverse:  avg(b.adverses),
  };
}

function addToBucket(b, m) {
  b.samples++;
  if (m.hit025) { b.hit025++; if (m.time025) b.times025.push(m.time025); }
  if (m.hit050) { b.hit050++; if (m.time050) b.times050.push(m.time050); }
  b.adverses.push(m.maxAdverse);
}

// ── Main builder ──────────────────────────────────────────────────────────────

function buildMicroMoveAnalysis() {
  console.log('[MicroMoveAnalyzer] Building report...');

  const signals  = readJsonlDir(SIGNALS_DIR, 30);
  const outcomes = readJsonlDir(OUTCOMES_DIR, 30);

  // Build lookups
  const sigById = new Map(signals.map((s) => [s.signalId, s]));
  const outById = new Map(outcomes.map((o) => [o.signalId, o]));

  // Only use outcomes that have a matching signal and outcome data
  const joined = [];
  for (const [id, oc] of outById.entries()) {
    if (!oc.outcome3 && !oc.outcome5 && !oc.outcome10) continue;
    const sig = sigById.get(id) || {};
    joined.push({ ...sig, ...oc }); // outcome fields win for tradeScore
  }

  console.log(`[MicroMoveAnalyzer] Joined ${joined.length} signals (signals: ${signals.length}, outcomes: ${outcomes.length})`);

  // ── Aggregate buckets ─────────────────────────────────────────────────────
  const byCat = {
    READY:   emptyBucket('Redo (score >40)'),
    WEAK:    emptyBucket('Svag (21–40)'),
    BLOCKED: emptyBucket('Blockerad (≤20)'),
  };

  const byEventType = new Map();
  const byRegime    = new Map();
  const byBlockReason = {
    tfs:          emptyBucket('Three Finger Spread'),
    weakVolume:   emptyBucket('Svag volym'),
    farFromZone:  emptyBucket('För långt från zon'),
    veryLowScore: emptyBucket('Extremt låg score'),
    lowScore:     emptyBucket('Låg score'),
  };

  const global = emptyBucket('Alla signaler');

  for (const rec of joined) {
    const long  = isLong(rec.signal);
    const m     = calcMicroMetrics(rec, long);
    const cat   = scoreCategory(rec.tradeScore ?? 0);
    const evt   = rec.eventType || 'UNKNOWN';
    const regime = rec.marketRegime || rec.marketRegimeV2 || 'UNKNOWN';

    addToBucket(global, m);
    addToBucket(byCat[cat], m);

    // By event type (separate buckets for all vs blocked)
    if (!byEventType.has(evt)) {
      byEventType.set(evt, {
        all:     emptyBucket(evt),
        blocked: emptyBucket(evt + ' (blockerad)'),
        weak:    emptyBucket(evt + ' (svag)'),
        ready:   emptyBucket(evt + ' (redo)'),
      });
    }
    const etBuckets = byEventType.get(evt);
    addToBucket(etBuckets.all, m);
    if (cat === 'BLOCKED') addToBucket(etBuckets.blocked, m);
    if (cat === 'WEAK')    addToBucket(etBuckets.weak, m);
    if (cat === 'READY')   addToBucket(etBuckets.ready, m);

    // By regime
    if (!byRegime.has(regime)) byRegime.set(regime, emptyBucket(regime));
    addToBucket(byRegime.get(regime), m);

    // Block reasons (only for blocked/weak)
    if (cat === 'BLOCKED') {
      const reason = classifyBlockReason(rec);
      addToBucket(byBlockReason[reason], m);
    }
  }

  // ── Identify MICRO_MOVE_READY event types ─────────────────────────────────
  const readyEventTypes = [];
  const eventTypeStats  = [];

  for (const [evt, buckets] of byEventType.entries()) {
    const fb = finalizeBucket(buckets.blocked);
    const fa = finalizeBucket(buckets.all);
    const fw = finalizeBucket(buckets.weak);
    const fr = finalizeBucket(buckets.ready);

    const isMicroReady = fb.samples >= 20 && (fb.hit025Rate ?? 0) >= MICRO_READY_MIN_025;
    if (isMicroReady) readyEventTypes.push(evt);

    eventTypeStats.push({
      eventType:         evt,
      allSamples:        fa.samples,
      allHit025Rate:     fa.hit025Rate,
      allHit050Rate:     fa.hit050Rate,
      blockedSamples:    fb.samples,
      blockedHit025Rate: fb.hit025Rate,
      blockedHit050Rate: fb.hit050Rate,
      blockedAvgTime025: fb.avgTime025,
      weakSamples:       fw.samples,
      weakHit025Rate:    fw.hit025Rate,
      readySamples:      fr.samples,
      readyHit025Rate:   fr.hit025Rate,
      microMoveReady:    isMicroReady,
    });
  }

  eventTypeStats.sort((a, b) => (b.blockedHit025Rate ?? 0) - (a.blockedHit025Rate ?? 0) || b.blockedSamples - a.blockedSamples);

  // ── Regime stats ──────────────────────────────────────────────────────────
  const regimeStats = [...byRegime.entries()]
    .map(([regime, b]) => ({ regime, ...finalizeBucket(b) }))
    .sort((a, b) => (b.hit025Rate ?? 0) - (a.hit025Rate ?? 0) || b.samples - a.samples);

  // ── Fast scalp opportunities: blocked + high 025 rate + fast time ─────────
  const fastScalp = eventTypeStats
    .filter((e) => e.blockedSamples >= 15 && (e.blockedHit025Rate ?? 0) >= 0.35 && e.blockedAvgTime025 !== null && e.blockedAvgTime025 <= 40)
    .slice(0, 10)
    .map((e) => ({
      eventType:  e.eventType,
      samples:    e.blockedSamples,
      hit025Rate: e.blockedHit025Rate,
      hit050Rate: e.blockedHit050Rate,
      avgMin025:  e.blockedAvgTime025,
    }));

  // ── Blocked but profitable summary ───────────────────────────────────────
  const blockedStats   = finalizeBucket(byCat.BLOCKED);
  const globalStats    = finalizeBucket(global);
  const readyStats     = finalizeBucket(byCat.READY);
  const weakStats      = finalizeBucket(byCat.WEAK);

  const missedOpportunities025 = blockedStats.hit025Count ?? 0;
  const missedOpportunities050 = blockedStats.hit050Count ?? 0;

  // ── Which blockers are most aggressive? ──────────────────────────────────
  const blockReasonStats = Object.entries(byBlockReason).map(([key, b]) => ({
    reason:     key,
    ...finalizeBucket(b),
  })).sort((a, b) => (b.hit025Rate ?? 0) - (a.hit025Rate ?? 0));

  // ── Comparison: READY vs BLOCKED vs MICRO_MOVE_READY ─────────────────────
  // MICRO_MOVE_READY subset: blocked signals where eventType is in readyEventTypes
  const mmrBucket = emptyBucket('Micro Move Ready');
  for (const rec of joined) {
    const cat = scoreCategory(rec.tradeScore ?? 0);
    const score = rec.tradeScore ?? 0;
    const tfs = rec.threeFingerSpreadActive === true;
    const evt = rec.eventType || 'UNKNOWN';
    if (cat === 'BLOCKED' && !tfs && score >= MICRO_READY_SCORE_MIN && score <= MICRO_READY_SCORE_MAX && readyEventTypes.includes(evt)) {
      addToBucket(mmrBucket, calcMicroMetrics(rec, isLong(rec.signal)));
    }
  }

  const comparison = {
    READY:            readyStats,
    WEAK:             weakStats,
    BLOCKED:          blockedStats,
    MICRO_MOVE_READY: finalizeBucket(mmrBucket),
  };

  // ── Recommendations ───────────────────────────────────────────────────────
  const recommendations = [];
  if ((blockedStats.hit025Rate ?? 0) >= 0.20) {
    recommendations.push(`${Math.round((blockedStats.hit025Rate ?? 0) * 100)}% av blockerade signaler når +0.25% — stor miss-potential.`);
  }
  if (readyEventTypes.length > 0) {
    recommendations.push(`${readyEventTypes.length} eventtyper är MICRO_MOVE_READY: ${readyEventTypes.slice(0, 3).join(', ')}${readyEventTypes.length > 3 ? '...' : ''}.`);
  }
  const bestBlockReason = blockReasonStats.find((b) => b.samples >= 20);
  if (bestBlockReason) {
    recommendations.push(`Blocker '${bestBlockReason.reason}' stoppar signaler med ${Math.round((bestBlockReason.hit025Rate ?? 0) * 100)}% sannolikhet för +0.25%.`);
  }
  if (fastScalp.length > 0) {
    recommendations.push(`${fastScalp.length} snabba scalp-möjligheter identifierade (snitt ${round(fastScalp[0].avgMin025, 1)} min till +0.25%).`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    days: 30,
    source: {
      signals:       signals.length,
      outcomes:      outcomes.length,
      joined:        joined.length,
    },
    global:             globalStats,
    byCategory:         comparison,
    blockedProfitable: {
      totalBlocked:           blockedStats.samples,
      hit025Count:            missedOpportunities025,
      hit050Count:            missedOpportunities050,
      hit025Rate:             blockedStats.hit025Rate,
      hit050Rate:             blockedStats.hit050Rate,
      missedOpportunities025,
      missedOpportunities050,
    },
    byEventType:        eventTypeStats.slice(0, 40),
    byBlockReason:      blockReasonStats,
    byRegime:           regimeStats,
    fastScalpOpportunities: fastScalp,
    microMoveReadyCriteria: {
      minHit025Rate:    MICRO_READY_MIN_025,
      scoreRange:       [MICRO_READY_SCORE_MIN, MICRO_READY_SCORE_MAX],
      minSamples:       20,
      noTFS:            true,
    },
    readyEventTypes,
    recommendations,
  };

  try {
    const dir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[MicroMoveAnalyzer] Report saved → ${OUTPUT_PATH}`);
  } catch (err) {
    console.warn('[MicroMoveAnalyzer] Could not save report:', err.message);
  }

  return report;
}

function loadMicroMoveAnalysis() {
  if (!fs.existsSync(OUTPUT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { buildMicroMoveAnalysis, loadMicroMoveAnalysis };
