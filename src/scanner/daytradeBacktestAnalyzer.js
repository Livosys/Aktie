'use strict';

const fs = require('fs');
const path = require('path');
const { buildDaytradeSignal } = require('./daytradeSignalEngine');

const ROOT = path.resolve(__dirname, '../..');
const OUTCOMES_DIR = path.join(ROOT, 'data/signals/outcomes');
const FEATURE_DIR = path.join(ROOT, 'data/feature-logs');
const REPORT_PATH = path.join(ROOT, 'data/signals/daytrade-backtest.json');
const JOIN_WINDOW_MS = 90 * 1000;

function readJsonlDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const fileDate = file.replace('.jsonl', '');
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push({ _fileDate: fileDate, ...JSON.parse(line) }); } catch { /* skip */ }
    }
  }
  return rows;
}

function tsMs(row) {
  const raw = row?.timestamp || row?.candleTs || row?.lastUpdate;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function directionFromSignal(signal, fallback) {
  if (String(signal || '').startsWith('LONG')) return 'up';
  if (String(signal || '').startsWith('SHORT')) return 'down';
  if (fallback === 'bullish') return 'up';
  if (fallback === 'bearish') return 'down';
  return 'neutral';
}

function buildFeatureIndex(features) {
  const bySymbol = new Map();
  for (const f of features) {
    const ms = tsMs(f);
    if (!f.symbol || ms === null) continue;
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol).push({ ...f, _tsMs: ms });
  }
  for (const arr of bySymbol.values()) arr.sort((a, b) => a._tsMs - b._tsMs);
  return bySymbol;
}

function findFeature(index, outcome) {
  const arr = index.get(outcome.symbol) || [];
  const target = tsMs(outcome);
  if (target === null || !arr.length) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const f of arr) {
    const diff = Math.abs(f._tsMs - target);
    if (diff < bestDiff) {
      best = f;
      bestDiff = diff;
    }
    if (f._tsMs > target + JOIN_WINDOW_MS) break;
  }
  return best && bestDiff <= JOIN_WINDOW_MS ? best : null;
}

function hitStats(row, direction) {
  const o = row.outcome30 || row.outcome20 || row.outcome10 || row.outcome5 || {};
  const favorable = direction === 'down' ? o.maxMoveDown : direction === 'up' ? o.maxMoveUp : null;
  const adverse = direction === 'down' ? o.maxMoveUp : direction === 'up' ? o.maxMoveDown : null;
  return {
    favorableMovePct: num(favorable),
    adverseMovePct: num(adverse),
    hit1Pct: num(favorable) !== null && num(favorable) >= 1,
    hit2Pct: num(favorable) !== null && num(favorable) >= 2,
    hitTargetBand: num(favorable) !== null && num(favorable) >= 1 && num(favorable) <= 2,
    candlesAvail: o.candlesAvail ?? null,
  };
}

function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function pct(n, d) {
  if (!d) return null;
  return Math.round((n / d) * 1000) / 10;
}

function avg(arr) {
  const vals = arr.filter((v) => Number.isFinite(v));
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
}

function summarize(rows) {
  const n = rows.length;
  return {
    count: n,
    hit1PctRate: pct(rows.filter((r) => r.hit1Pct).length, n),
    hit2PctRate: pct(rows.filter((r) => r.hit2Pct).length, n),
    hitTargetBandRate: pct(rows.filter((r) => r.hitTargetBand).length, n),
    avgFavorableMovePct: avg(rows.map((r) => r.favorableMovePct)),
    avgAdverseMovePct: avg(rows.map((r) => r.adverseMovePct)),
    avgDaytradeScore: avg(rows.map((r) => r.daytradeScore)),
  };
}

function bucketBy(rows, fn) {
  const out = {};
  for (const row of rows) {
    const key = fn(row);
    if (!out[key]) out[key] = [];
    out[key].push(row);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, summarize(v)]));
}

function relVolBucket(v) {
  if (v === null || v === undefined) return 'unknown';
  if (v < 0.7) return '<0.70';
  if (v < 1.0) return '0.70-0.99';
  if (v < 1.3) return '1.00-1.29';
  if (v < 1.6) return '1.30-1.59';
  return '>=1.60';
}

function mtfBucket(row) {
  if (row.mtfAlignment) return row.mtfAlignment;
  if (row.daytradeDirection === 'up' && row.marketDirection === 'bullish') return 'market_aligned';
  if (row.daytradeDirection === 'down' && row.marketDirection === 'bearish') return 'market_aligned';
  if (row.daytradeDirection === 'up' && row.marketDirection === 'bearish') return 'market_conflict';
  if (row.daytradeDirection === 'down' && row.marketDirection === 'bullish') return 'market_conflict';
  return 'unknown';
}

function buildRecommendation(rows) {
  const ge60 = rows.filter((r) => r.daytradeScore >= 60);
  const ge75 = rows.filter((r) => r.daytradeScore >= 75);
  const byVol = bucketBy(rows.filter((r) => r.daytradeScore >= 60), (r) => relVolBucket(r.relVol20));
  const byMtf = bucketBy(rows.filter((r) => r.daytradeScore >= 60), mtfBucket);

  const rec = [];
  if (ge60.length < 30) rec.push('Urvalet för daytradeScore >= 60 är litet. Kalibrera försiktigt.');
  if (ge75.length < 10) rec.push('Urvalet för daytradeScore >= 75 är mycket litet. Använd 75 som observationsnivå tills mer data finns.');

  const lowVol = byVol['<0.70'];
  const normalVol = byVol['1.00-1.29'];
  const solidVol = byVol['1.30-1.59'];
  const highVol = byVol['>=1.60'];
  if (lowVol && normalVol && lowVol.hit1PctRate < normalVol.hit1PctRate) {
    rec.push('Behåll lågvolym-cap vid relVol20 < 0.70.');
  }
  if (normalVol && (solidVol || highVol)) {
    const betterVolRate = Math.max(solidVol?.hit1PctRate ?? 0, highVol?.hit1PctRate ?? 0);
    if (normalVol.hit1PctRate < betterVolRate) {
      rec.push('Kalibrering: kräv relVol20 >= 1.30 för Intressant/Bekräftad daytrade-status.');
    }
  }

  const mtfConflict = byMtf.market_conflict || byMtf.conflicting || byMtf.full_conflict;
  const mtfAligned = byMtf.market_aligned || byMtf.aligned || byMtf.confirmed;
  if (mtfConflict && mtfAligned && mtfConflict.hit1PctRate < mtfAligned.hit1PctRate) {
    rec.push('Behåll tydligt avdrag för MTF/marknadskonflikt.');
  }

  rec.push('Stale-data kan inte backtestas från historiska outcomes eftersom historiska signaler inte har decayContext; behåll nuvarande stale override tills live-data ackumulerats.');
  return rec;
}

function buildDaytradeBacktest() {
  const outcomes = readJsonlDir(OUTCOMES_DIR);
  const features = readJsonlDir(FEATURE_DIR);
  const featureIndex = buildFeatureIndex(features);
  const rows = [];
  let joined = 0;

  for (const outcome of outcomes) {
    const direction = directionFromSignal(outcome.signal, outcome.marketDirection);
    if (direction === 'neutral') continue;
    const feature = findFeature(featureIndex, outcome);
    if (feature) joined++;
    const input = {
      ...outcome,
      ...(feature || {}),
      price: feature?.price ?? outcome.entryPrice,
      lastUpdate: outcome.timestamp,
      marketDirection: feature?.marketDirection ?? outcome.marketDirection,
      signal: outcome.signal,
      eventType: outcome.eventType,
      relVol20: feature?.relVol20 ?? outcome.relVol20,
      daytradeIgnoreStale: true,
    };
    const signal = buildDaytradeSignal(input);
    const hit = hitStats(outcome, signal.daytradeDirection || direction);
    rows.push({
      symbol: outcome.symbol,
      timestamp: outcome.timestamp,
      signal: outcome.signal,
      state: outcome.state,
      eventType: outcome.eventType,
      marketDirection: input.marketDirection,
      relVol20: input.relVol20 ?? null,
      mtfAlignment: input.mtfAlignment ?? null,
      daytradeScore: signal.daytradeScore,
      daytradeStatus: signal.daytradeStatus,
      daytradeDirection: signal.daytradeDirection,
      components: signal.components,
      ...hit,
      joinedFeatureLog: !!feature,
    });
  }

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: {
      outcomes: outcomes.length,
      featureLogs: features.length,
      evaluated: rows.length,
      joinedFeatureLogs: joined,
      horizon: 'outcome30 when available, otherwise outcome20/10/5',
    },
    thresholds: {
      ge60: summarize(rows.filter((r) => r.daytradeScore >= 60)),
      ge75: summarize(rows.filter((r) => r.daytradeScore >= 75)),
      allDirectional: summarize(rows),
    },
    byVolumeBucket: bucketBy(rows.filter((r) => r.daytradeScore >= 60), (r) => relVolBucket(r.relVol20)),
    byMtfBucket: bucketBy(rows.filter((r) => r.daytradeScore >= 60), mtfBucket),
    byStatus: bucketBy(rows, (r) => r.daytradeStatus),
    recommendationSv: buildRecommendation(rows),
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (require.main === module) {
  const report = buildDaytradeBacktest();
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { buildDaytradeBacktest, REPORT_PATH };
