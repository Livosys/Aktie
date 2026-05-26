'use strict';

/**
 * Score Calibration Engine v1
 *
 * Problem: historical audit shows score 71–80 has win rate ~50.4% — barely above
 * global average despite carrying a "high" nominal score. Scores 41–70 actually
 * outperform most. This engine corrects those discrepancies conservatively.
 *
 * buildScoreCalibration():
 *   Reads all outcomes/*.jsonl (directed signals only, success !== null).
 *   Builds per-bucket stats for: scoreRange, (scoreRange+regime),
 *   (scoreRange+symbol), (scoreRange+symbol+regime), and a full
 *   (scoreRange+symbol+regime+eventType) combination.
 *   Saves to data/signals/score-calibration.json.
 *
 * applyScoreCalibration(result):
 *   Reads cached calibration, finds best matching bucket via waterfall:
 *     full → mid → broad → global scoreRange
 *   Applies a conservative score adjustment (max ±6).
 *
 * Safety contract:
 *   - Hard-blocked signals (autoFilter.blocked, TFS, breakoutAlreadyOccurred)
 *     receive NO score change — only metadata attached.
 *   - Boost requires samples ≥ 100 AND winRate ≥ globalWinRate + 3%.
 *   - Penalty for any bucket with winRate < globalWinRate − 3%.
 *   - High-score buckets (71+) penalised if winRate < globalWinRate + 3%
 *     (they are supposed to be the best setups).
 *   - Max adjustment: ±6 points.
 */

const fs   = require('fs');
const path = require('path');

const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const CAL_PATH     = path.resolve(__dirname, '../../data/signals/score-calibration.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache     = null;
let _cacheTime = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreRangeBucket(score) {
  const s = Math.round(score ?? 0);
  if (s <= 20)  return '0-20';
  if (s <= 40)  return '21-40';
  if (s <= 50)  return '41-50';
  if (s <= 60)  return '51-60';
  if (s <= 70)  return '61-70';
  if (s <= 80)  return '71-80';
  return '81-100';
}

function round(n, d = 4) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function avg(arr) {
  const vals = arr.filter((v) => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function readJsonlDir(dir) {
  if (!fs.existsSync(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); }
  catch { return []; }
  const records = [];
  for (const file of files) {
    try {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return records;
}

// ── Adjustment formula ────────────────────────────────────────────────────────

const HIGH_BUCKETS    = new Set(['71-80', '81-100']);
const MIN_SAMPLES_ADJ = 50;   // minimum to consider any adjustment
const MIN_SAMPLES_BOOST = 100; // minimum for a positive adjustment
const BOOST_THRESHOLD   = 0.03; // +3% above global WR needed for boost
const PENALTY_THRESHOLD = 0.03; // -3% below global WR triggers penalty
const HIGH_BOOST_NEEDED = 0.03; // high-score buckets need +3% above global WR to avoid penalty
const ADJ_FACTOR        = 50;   // multiplier: delta * 50, capped at ±6

function calcRecommendedAdj(scoreRange, winRate, globalWinRate, samples) {
  if (winRate === null || samples < MIN_SAMPLES_ADJ) return 0;

  const delta = winRate - globalWinRate;

  // Boost: winRate meaningfully above global AND enough data
  if (delta >= BOOST_THRESHOLD && samples >= MIN_SAMPLES_BOOST) {
    return Math.min(6, Math.round(delta * ADJ_FACTOR));
  }

  // High-score penalty: 71+ buckets that don't substantially outperform the global WR
  if (HIGH_BUCKETS.has(scoreRange) && delta < HIGH_BOOST_NEEDED) {
    return Math.max(-6, Math.round((delta - HIGH_BOOST_NEEDED) * ADJ_FACTOR));
  }

  // General penalty: any bucket significantly below global
  if (delta <= -PENALTY_THRESHOLD) {
    return Math.max(-6, Math.round(delta * ADJ_FACTOR));
  }

  return 0;
}

function confidenceLevel(samples) {
  if (samples >= 500)  return 'high';
  if (samples >= 100)  return 'medium';
  if (samples >= 50)   return 'low';
  return 'insufficient';
}

// ── Accumulator helpers ───────────────────────────────────────────────────────

function newAcc() {
  return { n: 0, wins: 0, losses: 0, fakeouts: 0, moves10: [], moves20: [] };
}

function addOutcome(acc, rec) {
  if (rec.success === null || rec.success === undefined) return; // undirected
  acc.n++;
  if (rec.success === true)  acc.wins++;
  if (rec.success === false) {
    acc.losses++;
    if (rec.failureReason === 'stopped_out') acc.fakeouts++;
  }
  const m10 = rec.outcome10?.priceChangePct;
  const m20 = rec.outcome20?.priceChangePct;
  if (m10 !== null && m10 !== undefined) acc.moves10.push(m10);
  if (m20 !== null && m20 !== undefined) acc.moves20.push(m20);
}

function finalizeBucket(acc, scoreRange, globalWinRate) {
  const { n, wins, losses, fakeouts, moves10, moves20 } = acc;
  if (n === 0) return null;
  const winRate    = round(wins / n);
  const fakeoutRate = losses > 0 ? round(fakeouts / losses) : null;
  const avgMove10  = avg(moves10);
  const avgMove20  = avg(moves20);
  const conf       = confidenceLevel(n);
  const adj        = scoreRange
    ? calcRecommendedAdj(scoreRange, winRate, globalWinRate, n)
    : 0;
  return { samples: n, wins, losses, winRate, fakeoutRate, avgMove10, avgMove20, confidence: conf, recommendedAdjustment: adj };
}

// ── buildScoreCalibration ─────────────────────────────────────────────────────

function buildScoreCalibration() {
  console.log('[ScoreCalibration] Building score calibration...');

  const allOutcomes = readJsonlDir(OUTCOMES_DIR);
  console.log(`[ScoreCalibration] Loaded ${allOutcomes.length} outcomes`);

  // Global directed win rate (needed for adjustment formula)
  let globalWins = 0; let globalN = 0;
  for (const rec of allOutcomes) {
    if (rec.success === null || rec.success === undefined) continue;
    globalN++;
    if (rec.success === true) globalWins++;
  }
  const globalWinRate = globalN > 0 ? round(globalWins / globalN) : 0.5073;

  // Accumulators for each slice
  const bySR                 = {}; // key: scoreRange
  const bySRRegime           = {}; // key: `${sr}|${regime}`
  const bySRSymbol           = {}; // key: `${sr}|${symbol}`
  const bySRSymbolRegime     = {}; // key: `${sr}|${symbol}|${regime}`
  const byFull               = {}; // key: `${sr}|${symbol}|${regime}|${eventType}`

  function getOrCreate(map, key) {
    if (!map[key]) map[key] = newAcc();
    return map[key];
  }

  for (const rec of allOutcomes) {
    if (rec.success === null || rec.success === undefined) continue;

    const score     = rec.tradeScore;
    if (score === null || score === undefined) continue;

    const sr        = scoreRangeBucket(score);
    const symbol    = rec.symbol      || null;
    const regime    = rec.marketRegime || null;
    const eventType = rec.eventType   || null;

    addOutcome(getOrCreate(bySR, sr), rec);
    if (regime)                         addOutcome(getOrCreate(bySRRegime,       `${sr}|${regime}`),              rec);
    if (symbol)                         addOutcome(getOrCreate(bySRSymbol,        `${sr}|${symbol}`),              rec);
    if (symbol && regime)               addOutcome(getOrCreate(bySRSymbolRegime,  `${sr}|${symbol}|${regime}`),    rec);
    if (symbol && regime && eventType)  addOutcome(getOrCreate(byFull,            `${sr}|${symbol}|${regime}|${eventType}`), rec);
  }

  // Finalize all buckets
  function finalizeMap(map) {
    const out = {};
    for (const [key, acc] of Object.entries(map)) {
      const parts     = key.split('|');
      const scoreRange = parts[0];
      const bucket    = finalizeBucket(acc, scoreRange, globalWinRate);
      if (bucket) out[key] = bucket;
    }
    return out;
  }

  const calibration = {
    updatedAt:            new Date().toISOString(),
    globalWinRate,
    totalDirectedSignals: globalN,
    byScoreRange:         finalizeMap(bySR),
    byScoreRangeRegime:   finalizeMap(bySRRegime),
    byScoreRangeSymbol:   finalizeMap(bySRSymbol),
    byScoreRangeSymbolRegime: finalizeMap(bySRSymbolRegime),
    byFull:               finalizeMap(byFull),
  };

  const adjSummary = Object.entries(calibration.byScoreRange)
    .map(([k, v]) => `${k}: n=${v.samples} wr=${(v.winRate * 100).toFixed(1)}% adj=${v.recommendedAdjustment}`)
    .join(', ');
  console.log(`[ScoreCalibration] Global buckets: ${adjSummary}`);

  try {
    fs.mkdirSync(path.dirname(CAL_PATH), { recursive: true });
    fs.writeFileSync(CAL_PATH, JSON.stringify(calibration, null, 2), 'utf8');
    console.log(`[ScoreCalibration] Saved → ${CAL_PATH}`);
  } catch (err) {
    console.warn('[ScoreCalibration] Failed to save:', err.message);
  }

  return calibration;
}

// ── loadScoreCalibration (5-min cache) ────────────────────────────────────────

function loadScoreCalibration() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(CAL_PATH)) { _cache = null; _cacheTime = now; return null; }
    _cache     = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
    _cacheTime = now;
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}

// ── Bucket matching ───────────────────────────────────────────────────────────

function findBucket(calibration, sr, symbol, regime, eventType) {
  const MIN_SAMPLES = 50;

  // Full: scoreRange + symbol + regime + eventType
  if (symbol && regime && eventType) {
    const key    = `${sr}|${symbol}|${regime}|${eventType}`;
    const bucket = calibration.byFull?.[key];
    if (bucket && bucket.samples >= MIN_SAMPLES && bucket.confidence !== 'insufficient') {
      return { bucket, matchLevel: 'full', key };
    }
  }

  // Mid: scoreRange + symbol + regime
  if (symbol && regime) {
    const key    = `${sr}|${symbol}|${regime}`;
    const bucket = calibration.byScoreRangeSymbolRegime?.[key];
    if (bucket && bucket.samples >= MIN_SAMPLES) {
      return { bucket, matchLevel: 'mid', key };
    }
  }

  // Broad: scoreRange + regime
  if (regime) {
    const key    = `${sr}|${regime}`;
    const bucket = calibration.byScoreRangeRegime?.[key];
    if (bucket && bucket.samples >= MIN_SAMPLES) {
      return { bucket, matchLevel: 'broad', key };
    }
  }

  // Global scoreRange fallback
  const bucket = calibration.byScoreRange?.[sr] || null;
  return { bucket, matchLevel: 'global', key: sr };
}

// ── applyScoreCalibration ─────────────────────────────────────────────────────

function applyScoreCalibration(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[ScoreCalibration] applyScoreCalibration error:', err.message);
    return { ...result, scoreCalibration: null };
  }
}

function _apply(result) {
  const calibration = loadScoreCalibration();

  if (!calibration) {
    return {
      ...result,
      scoreCalibration: { enabled: false, reason: 'Ingen kalibreringsdata ännu.' },
    };
  }

  const { symbol, marketRegimeV2, eventType } = result;
  const score  = result.tradeScore ?? 0;
  const sr     = scoreRangeBucket(score);

  const { bucket, matchLevel, key } = findBucket(
    calibration, sr, symbol || null, marketRegimeV2 || null, eventType || null
  );

  if (!bucket) {
    return {
      ...result,
      scoreCalibration: { enabled: false, reason: 'Ingen matchande kalibreringsbucket.' },
    };
  }

  // Hard-block safety
  const isHardBlocked =
    result.autoFilter?.blocked       === true ||
    result.threeFingerSpread?.active === true ||
    result.breakoutAlreadyOccurred   === true;

  const rawAdj = bucket.recommendedAdjustment ?? 0;
  const adj    = isHardBlocked ? 0 : rawAdj;

  // Build explanation
  let explanationSv;
  if (isHardBlocked && rawAdj !== 0) {
    explanationSv = `Kalibrering: (justering ${rawAdj > 0 ? '+' : ''}${rawAdj}p nollställd — signal är hårt blockerad)`;
  } else if (adj > 0) {
    explanationSv = `Kalibrering: liknande signaler i ${sr}-intervallet har ${(bucket.winRate * 100).toFixed(1)}% win rate. Score +${adj}.`;
  } else if (adj < 0) {
    explanationSv = `Kalibrering: liknande ${sr}-signaler i ${matchLevel !== 'global' ? 'denna regime ' : ''}har bara ${(bucket.winRate * 100).toFixed(1)}% win rate. Score ${adj}.`;
  } else {
    explanationSv = `Kalibrering: ${sr}-signaler har ${(bucket.winRate * 100).toFixed(1)}% win rate (nära snittet). Ingen justering.`;
  }

  const newScore = adj !== 0
    ? Math.max(0, Math.min(100, score + adj))
    : score;

  // Append to score explanation if adjustment was made
  const scoreExpl = [...(result.scoreExplanationSv || [])];
  if (adj !== 0 && !scoreExpl.includes(explanationSv)) {
    scoreExpl.push(explanationSv);
  }

  return {
    ...result,
    tradeScore:                 newScore,
    signalScore:                newScore,
    scoreExplanationSv:         scoreExpl,
    calibratedScoreAdjustment:  adj,
    calibrationConfidence:      bucket.confidence,
    calibrationExplanationSv:   explanationSv,
    scoreCalibration: {
      enabled:           true,
      scoreRange:        sr,
      matchLevel,
      bucketKey:         key,
      originalScore:     score,
      adjustment:        adj,
      calibratedScore:   newScore,
      bucketWinRate:     bucket.winRate,
      bucketSamples:     bucket.samples,
      confidence:        bucket.confidence,
      fakeoutRate:       bucket.fakeoutRate,
      avgMove10:         bucket.avgMove10,
      explanationSv,
    },
  };
}

module.exports = { buildScoreCalibration, loadScoreCalibration, applyScoreCalibration };
