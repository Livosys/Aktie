'use strict';

const fs   = require('fs');
const path = require('path');

const { loadCandles }     = require('../data/marketDataStore');
const { toScannerFormat } = require('../data/candleAggregator');
const { calcIndicators }  = require('../scanner/indicators');
const { calcMtf }         = require('../scanner/mtf');
const { calcMomentumContinuation } = require('../scanner/momentumContinuationEngine');
const { calcFakeoutProbability }   = require('../scanner/fakeoutProbabilityEngine');
const { calcLiquiditySweep }       = require('../scanner/liquiditySweepEngine');

const SIGNALS_DIR  = path.resolve(__dirname, '../../data/signals/history');
const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const OUTPUT_PATH  = path.resolve(__dirname, '../../data/signals/momentum-backtest.json');

const MIN_WINDOW = 30;
const MAX_WINDOW = 500;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function round(n, d = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const f = 10 ** d;
  return Math.round(Number(n) * f) / f;
}

function avg(arr) {
  const vals = arr.filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
  return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

function readJsonlDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const fp = path.join(dir, file);
    try {
      for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }
  return rows;
}

function uniqueBySignalId(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r?.signalId) continue;
    m.set(r.signalId, r);
  }
  return [...m.values()];
}

function datePad(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildCandleCache(signals) {
  const bySymbol = new Map();
  for (const s of signals) {
    if (!s.symbol) continue;
    const date = (s.candleTs || s.timestamp || '').slice(0, 10);
    if (!date) continue;
    const cur = bySymbol.get(s.symbol) || { start: date, end: date };
    if (date < cur.start) cur.start = date;
    if (date > cur.end) cur.end = date;
    bySymbol.set(s.symbol, cur);
  }

  const cache = {};
  for (const [symbol, range] of bySymbol.entries()) {
    const start = datePad(range.start, -5);
    const end   = datePad(range.end, 5);
    let raw = [];
    try { raw = loadCandles(symbol, start, end, '2m'); } catch { raw = []; }
    const candles = toScannerFormat(raw).filter((c) => c.t || c.ts);
    const tsIndex = new Map();
    candles.forEach((c, i) => {
      const key = c.t || c.ts;
      if (key && !tsIndex.has(key)) tsIndex.set(key, i);
    });
    cache[symbol] = { candles, tsIndex };
  }
  return cache;
}

function findCandleIndex(cacheEntry, ts) {
  if (!cacheEntry || !ts) return undefined;
  const exact = cacheEntry.tsIndex.get(ts);
  if (exact !== undefined) return exact;
  const target = new Date(ts).getTime();
  let bestIdx;
  let bestDiff = Infinity;
  cacheEntry.candles.forEach((c, i) => {
    const t = new Date(c.t || c.ts).getTime();
    const diff = Math.abs(t - target);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  return bestDiff <= 5 * 60 * 1000 ? bestIdx : undefined;
}

function aggregateCandles(candles, periodMinutes) {
  const buckets = new Map();
  for (const c of candles || []) {
    const ts = c.t || c.ts;
    if (!ts) continue;
    const d = new Date(ts);
    const min = d.getUTCMinutes();
    d.setUTCMinutes(min - (min % periodMinutes), 0, 0);
    const key = d.toISOString();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, bars]) => {
      const first = bars[0];
      const last  = bars[bars.length - 1];
      return {
        t: key, ts: key,
        o: first.o,
        h: Math.max(...bars.map((b) => b.h)),
        l: Math.min(...bars.map((b) => b.l)),
        c: last.c,
        v: bars.reduce((s, b) => s + (b.v || 0), 0),
      };
    });
}

function isHardBlocked(sig) {
  return sig.threeFingerSpreadActive === true ||
    sig.breakoutAlreadyOccurred === true ||
    sig.autoFilter?.blocked === true;
}

function attachMomentumFields(sig, candleCache) {
  const entry = candleCache[sig.symbol];
  const idx = findCandleIndex(entry, sig.candleTs || sig.timestamp);
  if (idx === undefined) return null;

  const start = Math.max(0, idx + 1 - MAX_WINDOW);
  const window = entry.candles.slice(start, idx + 1);
  if (window.length < MIN_WINDOW) return null;

  const indicators = calcIndicators(window);
  if (!indicators) return null;

  const candles5m  = aggregateCandles(window, 5);
  const candles15m = aggregateCandles(window, 15);
  const baseResult = {
    symbol: sig.symbol,
    price: sig.price || window[window.length - 1].c,
    sma20: indicators.sma20,
    atr14: sig.atr14 ?? indicators.atr14,
    relVol20: sig.relVol20 ?? indicators.relVol20,
    priceToZoneAtr: sig.priceToZoneAtr ?? null,
    signal: sig.signal,
    eventType: sig.eventType,
    tradeScore: sig.tradeScore ?? 0,
    marketRegime: sig.marketRegime ?? null,
    marketRegimeV2: sig.marketRegimeV2 ?? sig.marketRegime ?? null,
    threeFingerSpread: { active: sig.threeFingerSpreadActive === true },
    breakoutAlreadyOccurred: sig.breakoutAlreadyOccurred === true,
    autoFilter: { blocked: isHardBlocked(sig) },
    _candles2m: window,
  };

  const mtf = calcMtf(baseResult, candles5m, candles15m);
  const withMtf = { ...baseResult, ...mtf };
  const momentum = calcMomentumContinuation(withMtf);
  const fakeout = calcFakeoutProbability({ ...withMtf, ...momentum });
  const sweep = calcLiquiditySweep({ ...withMtf, ...momentum, ...fakeout });

  return {
    momentumContinuationScore: momentum.momentumContinuationScore,
    continuationQuality:      momentum.continuationQuality,
    fakeoutProbability:       fakeout.fakeoutProbability,
    fakeoutRiskLevel:         fakeout.fakeoutRiskLevel,
    liquiditySweepDetected:   sweep.liquiditySweepDetected,
    sweepDirection:           sweep.sweepDirection,
    sweepQuality:             sweep.sweepQuality,
    trapType:                 sweep.trapType,
    mtfAlignment:             mtf.mtfAlignment,
    marketRegimeV2:           baseResult.marketRegimeV2,
    momentumWatchMode:        momentum.momentumWatchMode,
    liquiditySweepWatchMode:  sweep.liquiditySweepDetected && ['strong', 'ok'].includes(sweep.sweepQuality) && !isHardBlocked(sig),
  };
}

function directionalMove(rec, horizon) {
  if (horizon === 10 && rec.move10 !== undefined) {
    if ((rec.signal || '').includes('SHORT')) return rec.move10 === null ? null : -rec.move10;
    return rec.move10;
  }
  if (horizon === 20 && rec.move20 !== undefined) {
    if ((rec.signal || '').includes('SHORT')) return rec.move20 === null ? null : -rec.move20;
    return rec.move20;
  }
  const o = rec[`outcome${horizon}`];
  if (!o) return null;
  if ((rec.signal || '').includes('SHORT')) return -(o.priceChangePct ?? 0);
  return o.priceChangePct ?? null;
}

function directionalMaxMove(rec) {
  if (rec.maxMoveUp !== undefined || rec.maxMoveDown !== undefined) {
    if ((rec.signal || '').includes('SHORT')) return rec.maxMoveDown ?? null;
    return rec.maxMoveUp ?? null;
  }
  const o = rec.outcome20 || rec.outcome10 || rec.outcome5;
  if (!o) return null;
  if ((rec.signal || '').includes('SHORT')) return o.maxMoveDown ?? null;
  return o.maxMoveUp ?? null;
}

function isDirected(rec) {
  return rec.success === true || rec.success === false;
}

function isFakeout(rec) {
  return rec.success === false && rec.failureReason === 'stopped_out';
}

function confidenceLevel(samples) {
  if (samples >= 500) return 'high';
  if (samples >= 100) return 'medium';
  if (samples >= 30)  return 'low';
  return 'insufficient';
}

function topBottom(records, key) {
  const by = new Map();
  for (const r of records) {
    const k = r[key] || 'UNKNOWN';
    const acc = by.get(k) || { key: k, n: 0, wins: 0 };
    acc.n++;
    if (r.success === true) acc.wins++;
    by.set(k, acc);
  }
  return [...by.values()]
    .filter((x) => x.n >= 3)
    .map((x) => ({ key: x.key, samples: x.n, winRate: round(x.wins / x.n) }))
    .sort((a, b) => b.winRate - a.winRate || b.samples - a.samples);
}

function summarizeBucket(records) {
  const rows = records.filter(isDirected);
  const samples = rows.length;
  if (!samples) {
    return {
      samples: 0, winRate: null, avgMove10: null, avgMove20: null,
      avgMaxMove: null, fakeoutRate: null, bestSymbols: [], worstSymbols: [],
      bestRegimes: [], worstRegimes: [], confidence: 'insufficient',
    };
  }

  const wins = rows.filter((r) => r.success === true).length;
  const fakeouts = rows.filter(isFakeout).length;
  const symbols = topBottom(rows, 'symbol');
  const regimes = topBottom(rows, 'marketRegimeV2');

  return {
    samples,
    wins,
    losses: samples - wins,
    winRate: round(wins / samples),
    avgMove10: avg(rows.map((r) => directionalMove(r, 10))),
    avgMove20: avg(rows.map((r) => directionalMove(r, 20))),
    avgMaxMove: avg(rows.map(directionalMaxMove)),
    fakeoutRate: round(fakeouts / samples),
    bestSymbols: symbols.slice(0, 5),
    worstSymbols: symbols.slice(-5).reverse(),
    bestRegimes: regimes.slice(0, 5),
    worstRegimes: regimes.slice(-5).reverse(),
    confidence: confidenceLevel(samples),
  };
}

function bucketMomentum(score) {
  if (score <= 30) return '0-30';
  if (score <= 50) return '31-50';
  if (score <= 70) return '51-70';
  return '71-100';
}

function bucketFakeout(score) {
  if (score <= 30) return '0-30';
  if (score <= 60) return '31-60';
  return '61-100';
}

function analyzeGroups(records, specs) {
  const out = {};
  for (const spec of specs) {
    out[spec.key] = {
      label: spec.label,
      ...summarizeBucket(records.filter(spec.match)),
    };
  }
  return out;
}

function findBest(obj) {
  return Object.entries(obj || {})
    .map(([key, v]) => ({ key, label: v.label || key, ...v }))
    .filter((v) => v.samples > 0 && v.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate || b.samples - a.samples)[0] || null;
}

function findWorst(obj) {
  return Object.entries(obj || {})
    .map(([key, v]) => ({ key, label: v.label || key, ...v }))
    .filter((v) => v.samples > 0 && v.winRate !== null)
    .sort((a, b) => a.winRate - b.winRate || b.samples - a.samples)[0] || null;
}

function buildConclusion({ global, momentum, fakeout, liquidity, combinations }) {
  const bestMomentum = findBest(momentum);
  const lowFakeout = fakeout['0-30'];
  const highFakeout = fakeout['61-100'];
  const sweep = liquidity.sweep_detected;
  const noSweep = liquidity.no_sweep;
  const bestCombo = findBest(combinations);

  let verdict = 'behöver mer data';
  const enough = global.samples >= 100;
  if (enough) {
    const momentumHelps = bestMomentum && bestMomentum.key === '71-100' && bestMomentum.winRate >= global.winRate;
    const fakeoutHelps = lowFakeout?.samples >= 30 && highFakeout?.samples >= 30 && lowFakeout.winRate >= highFakeout.winRate;
    if (momentumHelps && fakeoutHelps) verdict = 'hjälper';
    else if (bestCombo?.samples >= 30 && bestCombo.winRate >= global.winRate + 0.03) verdict = 'hjälper';
    else verdict = 'hjälper inte ännu';
  }

  const sweepText = sweep?.samples && noSweep?.samples
    ? `Liquidity sweeps ${sweep.winRate >= noSweep.winRate ? 'förbättrar' : 'förbättrar inte'} utfallet (${Math.round(sweep.winRate * 100)}% vs ${Math.round(noSweep.winRate * 100)}%).`
    : 'Liquidity sweep-data är för tunn ännu.';

  return {
    verdict,
    conclusionSv: `Momentum Intelligence ${verdict}. ${sweepText}`,
  };
}

function buildMomentumBacktest() {
  console.log('[MomentumBacktest] Building report...');
  const signals = uniqueBySignalId(readJsonlDir(SIGNALS_DIR));
  const outcomes = uniqueBySignalId(readJsonlDir(OUTCOMES_DIR));
  const outcomeById = new Map(outcomes.map((o) => [o.signalId, o]));
  const joinedSignals = signals.filter((s) => outcomeById.has(s.signalId));
  const candleCache = buildCandleCache(joinedSignals);

  const records = [];
  let skippedNoOutcome = 0;
  let skippedNoCandles = 0;
  for (const sig of signals) {
    const outcome = outcomeById.get(sig.signalId);
    if (!outcome) { skippedNoOutcome++; continue; }
    if (!isDirected(outcome)) continue;
    const mi = attachMomentumFields(sig, candleCache);
    if (!mi) { skippedNoCandles++; continue; }
    records.push({
      signalId: sig.signalId,
      timestamp: sig.timestamp,
      symbol: sig.symbol,
      eventType: sig.eventType,
      tradeScore: sig.tradeScore,
      signal: sig.signal,
      success: outcome.success,
      failureReason: outcome.failureReason,
      move10: outcome.outcome10?.priceChangePct ?? null,
      move20: outcome.outcome20?.priceChangePct ?? null,
      maxMoveUp: outcome.outcome20?.maxMoveUp ?? outcome.outcome10?.maxMoveUp ?? null,
      maxMoveDown: outcome.outcome20?.maxMoveDown ?? outcome.outcome10?.maxMoveDown ?? null,
      ...mi,
      marketRegimeV2: mi.marketRegimeV2 || sig.marketRegime || outcome.marketRegime || null,
    });
  }

  const momentum = analyzeGroups(records, [
    { key: '0-30', label: 'Momentum 0-30', match: (r) => bucketMomentum(r.momentumContinuationScore) === '0-30' },
    { key: '31-50', label: 'Momentum 31-50', match: (r) => bucketMomentum(r.momentumContinuationScore) === '31-50' },
    { key: '51-70', label: 'Momentum 51-70', match: (r) => bucketMomentum(r.momentumContinuationScore) === '51-70' },
    { key: '71-100', label: 'Momentum 71-100', match: (r) => bucketMomentum(r.momentumContinuationScore) === '71-100' },
  ]);

  const fakeout = analyzeGroups(records, [
    { key: '0-30', label: 'Fakeout 0-30', match: (r) => bucketFakeout(r.fakeoutProbability) === '0-30' },
    { key: '31-60', label: 'Fakeout 31-60', match: (r) => bucketFakeout(r.fakeoutProbability) === '31-60' },
    { key: '61-100', label: 'Fakeout 61-100', match: (r) => bucketFakeout(r.fakeoutProbability) === '61-100' },
  ]);

  const liquidity = analyzeGroups(records, [
    { key: 'sweep_detected', label: 'Sweep detected', match: (r) => r.liquiditySweepDetected === true },
    { key: 'no_sweep', label: 'No sweep', match: (r) => r.liquiditySweepDetected !== true },
    { key: 'bullish_sweep', label: 'Bullish sweep', match: (r) => r.sweepDirection === 'bullish' },
    { key: 'bearish_sweep', label: 'Bearish sweep', match: (r) => r.sweepDirection === 'bearish' },
    { key: 'reclaim_sweep', label: 'Reclaim sweep', match: (r) => r.trapType === 'trapped_sellers' },
    { key: 'failed_breakout', label: 'Failed breakout', match: (r) => r.trapType === 'trapped_buyers' },
    { key: 'liquidity_watch_mode', label: 'Liquidity WATCH_MODE', match: (r) => r.liquiditySweepWatchMode === true },
    { key: 'normal_watch', label: 'Normal WATCH', match: (r) => r.signal === 'LONG_WATCH' || r.signal === 'SHORT_WATCH' },
  ]);

  const combinations = analyzeGroups(records, [
    { key: 'high_momentum_low_fakeout', label: 'High momentum + low fakeout', match: (r) => r.momentumContinuationScore >= 71 && r.fakeoutProbability <= 30 },
    { key: 'high_momentum_high_fakeout', label: 'High momentum + high fakeout', match: (r) => r.momentumContinuationScore >= 71 && r.fakeoutProbability >= 61 },
    { key: 'low_momentum_high_fakeout', label: 'Low momentum + high fakeout', match: (r) => r.momentumContinuationScore <= 50 && r.fakeoutProbability >= 61 },
    { key: 'mtf_confirmed_high_momentum', label: 'MTF confirmed + high momentum', match: (r) => r.mtfAlignment === 'confirmed' && r.momentumContinuationScore >= 71 },
    { key: 'mtf_conflicting_high_momentum', label: 'MTF conflicting + high momentum', match: (r) => ['conflicting', 'full_conflict'].includes(r.mtfAlignment) && r.momentumContinuationScore >= 71 },
    { key: 'liquidity_sweep_low_fakeout', label: 'Liquidity sweep + low fakeout', match: (r) => r.liquiditySweepDetected && r.fakeoutProbability <= 30 },
    { key: 'liquidity_sweep_high_momentum', label: 'Liquidity sweep + high momentum', match: (r) => r.liquiditySweepDetected && r.momentumContinuationScore >= 71 },
  ]);

  const global = summarizeBucket(records);
  const summary = {
    bestMomentumBucket: findBest(momentum),
    worstFakeoutBucket: findWorst(fakeout),
    bestCombination: findBest(combinations),
    worstCombination: findWorst(combinations),
    liquiditySweepsImprove: liquidity.sweep_detected.samples > 0 && liquidity.no_sweep.samples > 0
      ? liquidity.sweep_detected.winRate > liquidity.no_sweep.winRate
      : null,
  };
  const conclusion = buildConclusion({ global, momentum, fakeout, liquidity, combinations });

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: {
      signals: signals.length,
      outcomes: outcomes.length,
      analyzed: records.length,
      skippedNoOutcome,
      skippedNoCandles,
    },
    global,
    momentum,
    fakeout,
    liquidity,
    combinations,
    summary,
    conclusion,
    sampleRecords: records.slice(0, 25),
  };

  ensureDir(path.dirname(OUTPUT_PATH));
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[MomentumBacktest] Saved ${records.length} analyzed records -> ${OUTPUT_PATH}`);
  return report;
}

function loadMomentumBacktest() {
  try {
    if (!fs.existsSync(OUTPUT_PATH)) return null;
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { buildMomentumBacktest, loadMomentumBacktest, OUTPUT_PATH };
