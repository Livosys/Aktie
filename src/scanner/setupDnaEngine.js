'use strict';
const fs   = require('fs');
const path = require('path');

const HISTORY_DIR  = path.resolve(__dirname, '../../data/signals/history');
const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKBACK_MS  = 60 * 24 * 60 * 60 * 1000; // 60 days
const SIM_THRESHOLD  = 50;   // min similarity to count as matched
const MIN_MATCHED    = 10;   // min matches for engine to activate
const MAX_STORED     = 50;   // max comparisons kept per signal
const TOP_SHOWN      = 10;   // topMatches array length

let _cache     = null;
let _cacheTime = 0;

// ── Bucket helpers ────────────────────────────────────────────────────────────

function scoreRangeKey(score) {
  if (score <= 30) return '0-30';
  if (score <= 50) return '31-50';
  if (score <= 70) return '51-70';
  return '71-100';
}

function relVolBucket(v) {
  if (v == null) return null;
  if (v < 0.7)   return 'weak';
  if (v < 1.2)   return 'normal';
  return 'strong';
}

function priceToZoneBucket(v) {
  if (v == null) return null;
  if (v <= 0.5)  return 'in_zone';
  if (v <= 1.0)  return 'near_zone';
  return 'far_zone';
}

function compressionBucket(v) {
  if (v == null) return null;
  if (v < 0.7)   return 'tight';
  if (v < 1.2)   return 'normal';
  return 'loose';
}

// ── Adjacency helpers ─────────────────────────────────────────────────────────

const SCORE_RANGE_ORDER = ['0-30', '31-50', '51-70', '71-100'];
const REL_VOL_ORDER     = ['weak', 'normal', 'strong'];
const PTZ_ORDER         = ['in_zone', 'near_zone', 'far_zone'];
const COMPRESS_ORDER    = ['tight', 'normal', 'loose'];

function adjacent(a, b, ord) {
  const ia = ord.indexOf(a);
  const ib = ord.indexOf(b);
  return ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1;
}

// Regime groups: signals in the same group get +5
const REGIME_GROUP = {
  BULLISH_TREND:  'bull', TREND_DAY_UP:   'bull',
  BEARISH_TREND:  'bear', TREND_DAY_DOWN: 'bear',
  HIGH_VOLATILITY:'vol',  PANIC:          'vol',
  CHOPPY:         'calm', RANGE_DAY:      'calm',
};

function regimeClose(a, b) {
  const ga = REGIME_GROUP[a], gb = REGIME_GROUP[b];
  return !!(ga && ga === gb);
}

// State groups
const STATE_GROUP = {
  HIGH_QUALITY_NARROW: 'narrow', MEDIUM_NARROW: 'narrow',
  REGULAR_TREND: 'trend',
  BREAKOUT_ALREADY_OCCURRED: 'breakout',
  WIDE_AVOID: 'avoid', THREE_FINGER_SPREAD_AVOID: 'avoid',
};

function stateClose(a, b) {
  const ga = STATE_GROUP[a], gb = STATE_GROUP[b];
  return !!(ga && ga === gb);
}

function narrowTypeClose(a, b) {
  // coil_flat ↔ attack_200 are "close" but not exact
  return !!(a && b && a !== 'none' && b !== 'none' && a !== b);
}

// ── Factor comparison — returns points (0 / 5 / 10) ──────────────────────────

function cmp(lv, hv, closeFn, adjacentFn) {
  if (lv == null || hv == null) return 0;
  if (lv === hv) return 10;
  if (closeFn   && closeFn(lv, hv))   return 5;
  if (adjacentFn && adjacentFn(lv, hv)) return 5;
  return 0;
}

// ── Historical data loader ─────────────────────────────────────────────────────

function readJsonlFile(fp) {
  const out = [];
  const raw = fs.readFileSync(fp, 'utf8').split('\n');
  for (const line of raw) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function loadHistoricalData() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;

  try {
    const cutoff = now - LOOKBACK_MS;

    // Index outcomes by signalId
    const outcomes = {};
    if (fs.existsSync(OUTCOMES_DIR)) {
      for (const f of fs.readdirSync(OUTCOMES_DIR).sort()) {
        if (!f.endsWith('.jsonl')) continue;
        for (const o of readJsonlFile(path.join(OUTCOMES_DIR, f))) {
          if (o.signalId) outcomes[o.signalId] = o;
        }
      }
    }

    // Load history, join, filter
    const records = [];
    if (fs.existsSync(HISTORY_DIR)) {
      for (const f of fs.readdirSync(HISTORY_DIR).sort()) {
        if (!f.endsWith('.jsonl')) continue;
        for (const s of readJsonlFile(path.join(HISTORY_DIR, f))) {
          const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
          if (!ts || ts < cutoff) continue;
          const o = outcomes[s.signalId];
          if (!o) continue;
          if (o.success !== true && o.success !== false) continue; // skip non-directional

          records.push({
            signalId:    s.signalId,
            symbol:      s.symbol,
            date:        (s.timestamp || '').slice(0, 10),
            state:       s.state       || null,
            eventType:   s.eventType   || null,
            narrowType:  s.narrowType  || 'none',
            marketRegime: s.marketRegime || null,
            direction:   s.marketDirection || null,
            scoreRange:  scoreRangeKey(s.tradeScore ?? 0),
            relVol:      relVolBucket(s.relVol20),
            ptzBucket:   priceToZoneBucket(s.priceToZoneAtr),
            rcBucket:    compressionBucket(s.rangeCompression),
            tfs:         !!s.threeFingerSpreadActive,
            breakout:    !!s.breakoutAlreadyOccurred,
            success:     o.success,
            movePct:     o.outcome10?.priceChangePct ?? null,
          });
        }
      }
    }

    _cache = records;
    _cacheTime = now;
    console.log(`[SetupDNA] Loaded ${records.length} historical records`);
    return records;
  } catch (err) {
    console.warn('[SetupDNA] load error:', err.message);
    _cache = [];
    _cacheTime = Date.now();
    return [];
  }
}

// ── Live feature extraction ────────────────────────────────────────────────────

function liveFeatures(result) {
  return {
    symbol:      result.symbol,
    state:       result.state       || null,
    eventType:   result.eventType   || null,
    narrowType:  result.narrowType  || 'none',
    marketRegime: result.marketRegimeV2 || result.marketRegime || null,
    direction:   result.marketDirection || null,
    scoreRange:  scoreRangeKey(result.tradeScore ?? 0),
    relVol:      relVolBucket(result.relVol20),
    ptzBucket:   priceToZoneBucket(result.priceToZoneAtr),
    rcBucket:    compressionBucket(result.rangeCompression),
    tfs:         !!(result.threeFingerSpread?.active),
    breakout:    !!result.breakoutAlreadyOccurred,
  };
}

// ── Factor list (order matters for label mapping) ──────────────────────────────

const FACTOR_DEFS = [
  { key: 'symbol',      labelSv: 'Symbol',               closeFn: null,           adjFn: null },
  { key: 'eventType',   labelSv: 'Signaltyp',            closeFn: null,           adjFn: null },
  { key: 'narrowType',  labelSv: 'Narrow-typ',           closeFn: narrowTypeClose, adjFn: null },
  { key: 'state',       labelSv: 'Marknadsläge (state)', closeFn: stateClose,     adjFn: null },
  { key: 'marketRegime',labelSv: 'Marknadsregim',        closeFn: regimeClose,    adjFn: null },
  { key: 'scoreRange',  labelSv: 'Betygsnivå',           closeFn: null,           adjFn: (a,b) => adjacent(a, b, SCORE_RANGE_ORDER) },
  { key: 'relVol',      labelSv: 'Volym',                closeFn: null,           adjFn: (a,b) => adjacent(a, b, REL_VOL_ORDER) },
  { key: 'ptzBucket',   labelSv: 'Avstånd till zon',     closeFn: null,           adjFn: (a,b) => adjacent(a, b, PTZ_ORDER) },
  { key: 'rcBucket',    labelSv: 'Kompression',          closeFn: null,           adjFn: (a,b) => adjacent(a, b, COMPRESS_ORDER) },
  { key: 'direction',   labelSv: 'Riktning',             closeFn: null,           adjFn: null },
  { key: 'tfs',         labelSv: 'Three Finger Spread',  closeFn: null,           adjFn: null },
  { key: 'breakout',    labelSv: 'Redan brutet',         closeFn: null,           adjFn: null },
];

const MAX_RAW_SCORE = FACTOR_DEFS.length * 10; // 120

// ── Similarity ────────────────────────────────────────────────────────────────

function similarity(live, hist) {
  let raw = 0;
  const perFactor = [];
  for (const fd of FACTOR_DEFS) {
    const pts = cmp(live[fd.key], hist[fd.key], fd.closeFn, fd.adjFn);
    raw += pts;
    perFactor.push({ key: fd.key, pts });
  }
  return {
    score: Math.min(100, Math.round((raw / MAX_RAW_SCORE) * 100)),
    perFactor,
  };
}

// ── DNA core computation ───────────────────────────────────────────────────────

function computeDNA(result, records) {
  const live = liveFeatures(result);

  const matches = [];
  for (const hist of records) {
    const { score, perFactor } = similarity(live, hist);
    if (score < SIM_THRESHOLD) continue;
    matches.push({ hist, score, perFactor });
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, MAX_STORED);

  const matchedSetups = top.length;
  if (matchedSetups < MIN_MATCHED) {
    return {
      enabled:         false,
      similarityScore: top.length > 0 ? top[0].score : 0,
      matchedSetups,
      winRate:         null,
      avgMove:         null,
      avgFailMove:     null,
      strongestFactors:[],
      weakestFactors:  [],
      historicalBias:  'neutral',
      summarySv:       'För lite liknande historik ännu.',
      topMatches:      [],
    };
  }

  // Avg similarity of top matches
  const avgSim = Math.round(top.reduce((s, m) => s + m.score, 0) / top.length);

  // Win rate
  const wins   = top.filter(m => m.hist.success === true);
  const losses = top.filter(m => m.hist.success === false);
  const winRate = top.length > 0
    ? round(wins.length / top.length, 3)
    : null;

  // Avg move
  const winMoves  = wins.map(m => m.hist.movePct).filter(v => v != null);
  const lossMoves = losses.map(m => m.hist.movePct).filter(v => v != null);
  const avgMove     = winMoves.length  > 0 ? round(winMoves.reduce((s,v)=>s+v,0)  / winMoves.length,  4) : null;
  const avgFailMove = lossMoves.length > 0 ? round(lossMoves.reduce((s,v)=>s+v,0) / lossMoves.length, 4) : null;

  // Factor analysis: which factors matched most often among top matches
  const factorHits = {};
  for (const fd of FACTOR_DEFS) factorHits[fd.key] = 0;
  for (const m of top) {
    for (const f of m.perFactor) {
      if (f.pts > 0) factorHits[f.key]++;
    }
  }
  const factorRates = FACTOR_DEFS.map(fd => ({
    key: fd.key, label: fd.labelSv, rate: factorHits[fd.key] / top.length,
  })).sort((a, b) => b.rate - a.rate);

  const strongestFactors = factorRates.filter(f => f.rate >= 0.70).map(f => f.label);
  const weakestFactors   = factorRates.filter(f => f.rate < 0.30).map(f => f.label);

  // Historical bias: direction of winning matches
  const bullWins = wins.filter(m => m.hist.direction === 'bullish').length;
  const bearWins = wins.filter(m => m.hist.direction === 'bearish').length;
  let historicalBias = 'neutral';
  if (wins.length > 0) {
    if (bullWins / wins.length > 0.6) historicalBias = 'bullish';
    else if (bearWins / wins.length > 0.6) historicalBias = 'bearish';
  }

  // Top matches for API
  const topMatches = top.slice(0, TOP_SHOWN).map(m => ({
    signalId:    m.hist.signalId,
    symbol:      m.hist.symbol,
    date:        m.hist.date,
    similarity:  m.score,
    outcome:     m.hist.success,
    movePct:     m.hist.movePct,
    marketRegime: m.hist.marketRegime,
  }));

  // Summary
  let summarySv;
  if (avgSim > 70 && winRate !== null && winRate >= 0.65) {
    summarySv = 'Detta setup liknar tidigare vinnare.';
  } else if (winRate !== null && winRate < 0.45) {
    summarySv = 'Liknande setups har fungerat svagt historiskt.';
  } else if (historicalBias !== 'neutral') {
    summarySv = `Historiken visar stark ${historicalBias === 'bullish' ? 'bullish' : 'bearish'} bias.`;
  } else {
    summarySv = 'Historiken visar blandat resultat för liknande setups.';
  }

  return {
    enabled:         true,
    similarityScore: avgSim,
    matchedSetups,
    winRate,
    avgMove,
    avgFailMove,
    strongestFactors,
    weakestFactors,
    historicalBias,
    summarySv,
    topMatches,
  };
}

// ── Score adjustment ───────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function round(n, d = 2) {
  if (n == null || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function calcAdjustment(dna, result) {
  if (!dna.enabled) return 0;

  const { similarityScore, winRate, historicalBias } = dna;
  const liveDir  = result.marketDirection;
  let adj = 0;

  // Rule 1/2: similarity + win rate boost (rule 2 supersedes rule 1)
  if (similarityScore > 80 && winRate >= 0.75) {
    adj += 10;
  } else if (similarityScore > 70 && winRate >= 0.65) {
    adj += 5;
  }

  // Rule 3: weak similarity penalty
  if (similarityScore < 40) adj -= 5;

  // Rules 4/5: directional conflict
  if (historicalBias === 'bearish' && liveDir === 'bullish') adj -= 5;
  if (historicalBias === 'bullish' && liveDir === 'bearish') adj -= 5;

  return adj;
}

function applyHardCaps(score, result) {
  const tfs     = !!(result.threeFingerSpread?.active);
  const breakout = !!result.breakoutAlreadyOccurred;
  const blocked  = !!(result.autoFilter?.blocked);
  let s = score;
  if (blocked)  s = Math.min(s, 20);
  if (tfs)      s = Math.min(s, 10);
  if (breakout) s = Math.min(s, 20);
  return s;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Apply Setup DNA Engine to a live scan result (after Adaptive Edge).
 *
 * Reads/joins history + outcomes (cached 5 min), computes similarity, adjusts tradeScore.
 *
 * Adds:
 *   result.tradeScoreBeforeDNA — score entering this step
 *   result.setupDNA            — full DNA metadata
 *   result.tradeScore          — updated with DNA adjustment
 *
 * Safe: never throws.
 */
function applySetupDNA(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[SetupDNA] error:', err.message);
    return {
      ...result,
      tradeScoreBeforeDNA: result.tradeScore ?? null,
      setupDNA: {
        enabled: false, similarityScore: 0, matchedSetups: 0,
        winRate: null, avgMove: null, avgFailMove: null,
        strongestFactors: [], weakestFactors: [],
        historicalBias: 'neutral', summarySv: 'Fel i Setup DNA-beräkning.',
        topMatches: [], adjustment: 0, finalScore: result.tradeScore ?? 0,
      },
    };
  }
}

function _apply(result) {
  const records   = loadHistoricalData();
  const baseScore = result.tradeScore ?? 0;

  const dna = computeDNA(result, records);
  const adj = calcAdjustment(dna, result);

  let finalScore = clamp(baseScore + adj, 0, 100);
  finalScore = applyHardCaps(finalScore, result);

  // scoreExplanationSv
  const existing = result.scoreExplanationSv || [];
  const newExpl  = [...existing];
  if (dna.enabled && adj !== 0) {
    const msg = adj > 0
      ? 'Setup DNA: liknande historiska setups har fungerat bra.'
      : 'Setup DNA: liknande historiska setups har fungerat svagt.';
    if (!newExpl.includes(msg)) newExpl.push(msg);
  }

  return {
    ...result,
    tradeScoreBeforeDNA:  baseScore,
    tradeScore:           finalScore,
    signalScore:          finalScore,
    scoreExplanationSv:   newExpl,
    setupDNA: {
      ...dna,
      adjustment: adj,
      finalScore,
    },
  };
}

module.exports = { applySetupDNA };
