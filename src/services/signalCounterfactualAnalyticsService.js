'use strict';

const path = require('path');

const { loadCandles: defaultLoadCandles } = require('../data/marketDataStore');
const signalIntelligenceLabService = require('./signalIntelligenceLabService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const HORIZON_MINUTES = [5, 10, 15, 30, 60];
const MAX_HORIZON_MINUTES = Math.max(...HORIZON_MINUTES);

const SAFETY = Object.freeze({
  ...signalIntelligenceLabService.SAFETY,
  counterfactual_only: true,
  model: 'historical_price_replay',
  rr_model: 'first_touch_conservative_same_candle',
  writes_allowed: false,
});

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timeMs(value) {
  const iso = toIso(value);
  return iso ? new Date(iso).getTime() : null;
}

function ymd(value) {
  return toIso(value)?.slice(0, 10) || null;
}

function addDays(value, days) {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function addMinutesMs(ms, minutes) {
  return ms + minutes * 60 * 1000;
}

function asNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n == null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function average(values) {
  const nums = values.map(asNumber).filter((value) => value != null);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return round((numerator / denominator) * 100, 1);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeSymbol(value) {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeStrategyId(value) {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : null;
}

function normalizeBlocker(value) {
  const text = normalizeText(value);
  if (!text) return null;
  return text
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || null;
}

function directionOf(record = {}) {
  const text = [
    record.direction,
    record.signalSubtype,
    record.signalFamily,
    record.signalId,
    record.strategyId,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\b(long|up|buy|bullish)\b/.test(text) || text.includes('_long')) return 'long';
  if (/\b(short|down|sell|bearish)\b/.test(text) || text.includes('_short')) return 'short';
  return null;
}

function normalizeCandle(row = {}) {
  const timestamp = toIso(row.timestamp || row.ts || row.t || row.candleTime);
  const open = asNumber(row.open ?? row.o);
  const high = asNumber(row.high ?? row.h);
  const low = asNumber(row.low ?? row.l);
  const close = asNumber(row.close ?? row.c);
  if (!timestamp || open == null || high == null || low == null || close == null) return null;
  return {
    timestamp,
    ms: timeMs(timestamp),
    open,
    high,
    low,
    close,
    volume: asNumber(row.volume ?? row.v),
    incomplete: row.incomplete === true,
    source: row.source || null,
  };
}

function dedupeCandles(candles) {
  const byTs = new Map();
  for (const candle of candles) {
    const normalized = normalizeCandle(candle);
    if (!normalized || !Number.isFinite(normalized.ms)) continue;
    if (normalized.incomplete) continue;
    byTs.set(normalized.timestamp, normalized);
  }
  return [...byTs.values()].sort((a, b) => a.ms - b.ms);
}

function trueRange(candle, previous) {
  if (!previous) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previous.close),
    Math.abs(candle.low - previous.close),
  );
}

function deriveAtr(candles, blockMs, period = 14) {
  const before = candles.filter((candle) => candle.ms < blockMs);
  if (before.length < 4) return null;
  const start = Math.max(1, before.length - period);
  const ranges = [];
  for (let i = start; i < before.length; i += 1) {
    ranges.push(trueRange(before[i], before[i - 1]));
  }
  return average(ranges);
}

function favorableMove(direction, entryPrice, candle) {
  return direction === 'short' ? entryPrice - candle.low : candle.high - entryPrice;
}

function adverseMove(direction, entryPrice, candle) {
  return direction === 'short' ? candle.high - entryPrice : entryPrice - candle.low;
}

function closeMove(direction, entryPrice, candle) {
  return direction === 'short' ? entryPrice - candle.close : candle.close - entryPrice;
}

function firstTouch(slice, direction, entryPrice, riskUnit) {
  if (!riskUnit || riskUnit <= 0 || !slice.length) {
    return {
      expectedR: null,
      firstHit: 'insufficient_risk',
      stopHit: false,
      targetHitR1: false,
      targetHitR2: false,
      targetHitR3: false,
      ambiguous: false,
    };
  }

  const touches = {
    stopHit: false,
    targetHitR1: false,
    targetHitR2: false,
    targetHitR3: false,
    firstStopAt: null,
    firstTargetAt: null,
  };
  for (const candle of slice) {
    const favorable = favorableMove(direction, entryPrice, candle);
    const adverse = adverseMove(direction, entryPrice, candle);
    if (adverse >= riskUnit && !touches.stopHit) {
      touches.stopHit = true;
      touches.firstStopAt = candle.timestamp;
    }
    if (favorable >= riskUnit && !touches.targetHitR1) {
      touches.targetHitR1 = true;
      touches.firstTargetAt = candle.timestamp;
    }
    if (favorable >= riskUnit * 2) touches.targetHitR2 = true;
    if (favorable >= riskUnit * 3) touches.targetHitR3 = true;
  }

  for (const candle of slice) {
    const favorable = favorableMove(direction, entryPrice, candle);
    const adverse = adverseMove(direction, entryPrice, candle);
    const stopHit = adverse >= riskUnit;
    const hitR3 = favorable >= riskUnit * 3;
    const hitR2 = favorable >= riskUnit * 2;
    const hitR1 = favorable >= riskUnit;

    if (stopHit && (hitR1 || hitR2 || hitR3)) {
      return {
        expectedR: -1,
        firstHit: 'ambiguous_stop_and_target_same_candle',
        ...touches,
        firstStopAt: touches.firstStopAt || candle.timestamp,
        firstTargetAt: touches.firstTargetAt || candle.timestamp,
        ambiguous: true,
      };
    }
    if (stopHit) {
      return {
        expectedR: -1,
        firstHit: 'stop',
        ...touches,
        ambiguous: false,
      };
    }
    if (hitR3) {
      return {
        expectedR: 3,
        firstHit: 'target_r3',
        ...touches,
        ambiguous: false,
      };
    }
    if (hitR2) {
      return {
        expectedR: 2,
        firstHit: 'target_r2',
        ...touches,
        ambiguous: false,
      };
    }
    if (hitR1) {
      return {
        expectedR: 1,
        firstHit: 'target_r1',
        ...touches,
        ambiguous: false,
      };
    }
  }

  const last = slice[slice.length - 1];
  return {
    expectedR: round(closeMove(direction, entryPrice, last) / riskUnit, 4),
    firstHit: 'horizon_close',
    ...touches,
    ambiguous: false,
  };
}

function summarizeHorizon(slice, direction, entryPrice, atr, riskUnit) {
  if (!slice.length) {
    return {
      dataStatus: 'missing_candles',
      candles: 0,
      mfe: null,
      mae: null,
      mfeAtr: null,
      maeAtr: null,
      closeMove: null,
      closeMoveAtr: null,
      expectedR: null,
      win: null,
      loss: null,
      stopHit: false,
      targetHitR1: false,
      targetHitR2: false,
      targetHitR3: false,
      ambiguous: false,
    };
  }

  const favorableMoves = slice.map((candle) => favorableMove(direction, entryPrice, candle));
  const adverseMoves = slice.map((candle) => adverseMove(direction, entryPrice, candle));
  const mfe = Math.max(...favorableMoves);
  const mae = Math.max(...adverseMoves);
  const last = slice[slice.length - 1];
  const move = closeMove(direction, entryPrice, last);
  const hit = firstTouch(slice, direction, entryPrice, riskUnit);

  return {
    dataStatus: 'ok',
    candles: slice.length,
    from: slice[0].timestamp,
    to: last.timestamp,
    mfe: round(mfe, 4),
    mae: round(mae, 4),
    mfePct: round((mfe / entryPrice) * 100, 4),
    maePct: round((mae / entryPrice) * 100, 4),
    mfeAtr: atr ? round(mfe / atr, 4) : null,
    maeAtr: atr ? round(mae / atr, 4) : null,
    closeMove: round(move, 4),
    closeMovePct: round((move / entryPrice) * 100, 4),
    closeMoveAtr: atr ? round(move / atr, 4) : null,
    expectedR: hit.expectedR,
    win: hit.expectedR == null ? null : hit.expectedR > 0,
    loss: hit.expectedR == null ? null : hit.expectedR < 0,
    ...hit,
  };
}

function riskUnitFor(record, entryPrice, atr) {
  const stopLoss = asNumber(record.metrics?.stopLoss);
  if (stopLoss != null && entryPrice != null) {
    const distance = Math.abs(entryPrice - stopLoss);
    const ratio = entryPrice ? distance / entryPrice : Infinity;
    if (distance > 0 && ratio < 0.2) {
      return { unit: distance, source: 'record_stop_loss', stopLoss };
    }
  }
  const takeProfit = asNumber(record.metrics?.takeProfit);
  const riskReward = asNumber(record.metrics?.riskReward);
  if (takeProfit != null && riskReward && riskReward > 0 && entryPrice != null) {
    const unit = Math.abs(takeProfit - entryPrice) / riskReward;
    const ratio = entryPrice ? unit / entryPrice : Infinity;
    if (unit > 0 && ratio < 0.2) {
      return { unit, source: 'record_take_profit_rr', takeProfit, riskReward };
    }
  }
  if (atr && atr > 0) return { unit: atr, source: 'derived_atr14', atr };
  return { unit: null, source: 'missing_risk_unit' };
}

function classifyBlockerGroup(code) {
  const text = normalizeBlocker(code) || 'unknown';
  if (text.includes('extended') || text.includes('price_to_zone') || text.includes('three_finger')) return 'extended_move';
  if (text.includes('late') || text.includes('stale') || text.includes('freshness') || text.includes('age') || text.includes('delay')) return 'late_entry';
  if (text.includes('fatigue') || text.includes('exhaust')) return 'fatigue';
  if (text.includes('wait') || text.includes('watch')) return 'watch';
  if (text.includes('caution')) return 'caution';
  if (text.includes('regime') || text.includes('choppy') || text.includes('market_direction')) return 'market_regime';
  if (text.includes('volume') || text.includes('rvol')) return 'volume';
  if (text.includes('vwap')) return 'VWAP';
  if (text.includes('ema')) return 'EMA';
  if (text.includes('session') || text.includes('market_closed') || text.includes('rth') || text.includes('globex')) return 'session';
  if (text.includes('max_open') || text.includes('position')) return 'capacity';
  if (text.includes('ibkr') || text.includes('broker') || text.includes('order') || text.includes('execution')) return 'execution';
  if (text.includes('strategy') || text.includes('allowlist') || text.includes('active')) return 'strategy';
  return text;
}

function blockerCodes(record) {
  const codes = (record.blockers || []).map((blocker) => normalizeBlocker(blocker.code)).filter(Boolean);
  return [...new Set(codes)];
}

function blockerGroups(record) {
  return [...new Set(blockerCodes(record).map(classifyBlockerGroup))];
}

function applyRecordFilters(records, query = {}) {
  const strategyId = normalizeStrategyId(query.strategyId || query.strategy);
  const symbol = normalizeSymbol(query.symbol);
  const blocker = normalizeBlocker(query.blocker);
  return records.filter((record) => {
    if (strategyId && strategyId !== 'all' && record.strategyId !== strategyId) return false;
    if (symbol && record.symbol !== symbol && record.originalSymbol !== symbol) return false;
    if (blocker && blocker !== 'all') {
      const codes = blockerCodes(record);
      const groups = codes.map(classifyBlockerGroup);
      if (!codes.includes(blocker) && !groups.includes(blocker)) return false;
    }
    return true;
  });
}

function symbolCandidates(record = {}) {
  return [...new Set([
    normalizeSymbol(record.symbol),
    normalizeSymbol(record.originalSymbol),
  ].filter(Boolean))];
}

function loadCandlesForRecord(record, blockAt, loadCandles, cache) {
  const symbols = symbolCandidates(record);
  const start = ymd(addDays(blockAt, -1));
  const end = ymd(addDays(blockAt, 1));
  const entryPrice = asNumber(record.metrics?.price ?? record.metrics?.entryPrice ?? record.metrics?.referencePrice);
  const candidates = [];

  for (const symbol of symbols) {
    const key = `${symbol}|${start}|${end}`;
    if (!cache.has(key)) {
      let candles = [];
      try {
        candles = dedupeCandles(loadCandles(symbol, start, end, '2m') || []);
      } catch (_) {
        candles = [];
      }
      cache.set(key, candles);
    }
    const candles = cache.get(key);
    if (!candles.length) continue;
    const blockMs = timeMs(blockAt);
    const firstFuture = candles.find((candle) => candle.ms > blockMs);
    const distance = firstFuture && entryPrice
      ? Math.abs(firstFuture.close - entryPrice) / Math.max(Math.abs(entryPrice), 1)
      : Infinity;
    candidates.push({ symbol, candles, distance });
  }

  if (!candidates.length) return { symbol: symbols[0] || null, candles: [], dataStatus: 'missing_candles' };
  candidates.sort((a, b) => a.distance - b.distance);
  return { ...candidates[0], dataStatus: 'ok' };
}

function primaryBlocker(record, blockPoint) {
  if (!record.blockers?.length) return null;
  if (blockPoint === 'last') return record.blockers[record.blockers.length - 1];
  return record.blockers[0];
}

function assessRecord(record, options) {
  const {
    loadCandles,
    candleCache,
    blockPoint,
  } = options;
  const blocker = primaryBlocker(record, blockPoint);
  const blockedAt = toIso(blocker?.at || record.firstBlocker?.at || record.lastBlocker?.at || record.lastSeenAt);
  const direction = directionOf(record);
  const entryPrice = asNumber(record.metrics?.price ?? record.metrics?.entryPrice ?? record.metrics?.referencePrice);
  const codes = blockerCodes(record);
  const groups = blockerGroups(record);

  const base = {
    signalKey: record.signalKey,
    lifecycleId: record.lifecycleId,
    candidateId: record.candidateId,
    signalId: record.signalId,
    intentId: record.intentId,
    executionId: record.executionId,
    idempotencyKey: record.idempotencyKey,
    tradeId: record.tradeId,
    symbol: record.symbol,
    originalSymbol: record.originalSymbol,
    strategyId: record.strategyId,
    direction,
    blockedAt,
    primaryBlocker: blocker ? { code: blocker.code, label: blocker.label, at: blocker.at, stage: blocker.stage } : null,
    blockerCodes: codes,
    blockerGroups: groups,
    lifecycleStatus: record.status,
    entryPrice,
    dataStatus: 'pending',
    risk: null,
    horizons: {},
    max: null,
    expectedR: null,
    verdict: null,
  };

  if (!blockedAt) return { ...base, dataStatus: 'missing_block_time' };
  if (!direction) return { ...base, dataStatus: 'missing_direction' };
  if (entryPrice == null || entryPrice <= 0) return { ...base, dataStatus: 'missing_entry_price' };

  const loaded = loadCandlesForRecord(record, blockedAt, loadCandles, candleCache);
  if (!loaded.candles.length) return { ...base, symbolUsed: loaded.symbol, dataStatus: 'missing_candles' };

  const blockMs = timeMs(blockedAt);
  const maxEnd = addMinutesMs(blockMs, MAX_HORIZON_MINUTES);
  const future = loaded.candles.filter((candle) => candle.ms > blockMs && candle.ms <= maxEnd);
  if (!future.length) return { ...base, symbolUsed: loaded.symbol, dataStatus: 'missing_future_candles' };

  const explicitAtr = asNumber(record.metrics?.atr);
  const atr = explicitAtr || deriveAtr(loaded.candles, blockMs, 14);
  const risk = riskUnitFor(record, entryPrice, atr);
  const horizons = {};
  for (const minutes of HORIZON_MINUTES) {
    const endMs = addMinutesMs(blockMs, minutes);
    const slice = future.filter((candle) => candle.ms <= endMs);
    horizons[minutes] = summarizeHorizon(slice, direction, entryPrice, atr, risk.unit);
  }
  const max = horizons[MAX_HORIZON_MINUTES];
  const expectedR = max?.expectedR ?? null;

  return {
    ...base,
    dataStatus: 'ok',
    symbolUsed: loaded.symbol,
    candleCount: future.length,
    firstCandleAt: future[0]?.timestamp || null,
    lastCandleAt: future[future.length - 1]?.timestamp || null,
    entryPrice: round(entryPrice, 4),
    risk: {
      ...risk,
      unit: round(risk.unit, 4),
      atr: round(atr, 4),
      explicitAtr: explicitAtr != null,
    },
    horizons,
    max,
    expectedR,
    stopHit: max?.stopHit === true,
    targetHitR1: max?.targetHitR1 === true,
    targetHitR2: max?.targetHitR2 === true,
    targetHitR3: max?.targetHitR3 === true,
    ambiguous: max?.ambiguous === true,
    verdict: expectedR == null ? 'unknown' : (expectedR > 0 ? 'blocked_good_trade' : 'blocked_bad_trade'),
  };
}

function horizonAggregate(rows, minutes) {
  const ok = rows.map((row) => row.horizons?.[minutes]).filter((horizon) => horizon?.dataStatus === 'ok');
  return {
    samples: ok.length,
    averageMfe: round(average(ok.map((row) => row.mfe)), 4),
    averageMae: round(average(ok.map((row) => row.mae)), 4),
    averageMfeAtr: round(average(ok.map((row) => row.mfeAtr)), 3),
    averageMaeAtr: round(average(ok.map((row) => row.maeAtr)), 3),
    winRate: pct(ok.filter((row) => row.win === true).length, ok.length),
    lossRate: pct(ok.filter((row) => row.loss === true).length, ok.length),
    expectedRR: round(average(ok.map((row) => row.expectedR)), 3),
  };
}

function blockerVerdict(row, minSamples) {
  if (row.analyzed < minSamples) return 'insufficient_data';
  if (row.expectedRR <= 0 && row.lossRate >= 55) return 'protective';
  if (row.expectedRR >= 0.5 && row.winRate >= 55) return 'overblocking';
  return 'mixed';
}

function summarizeBlockerGroups(assessments, minSamples) {
  const memberships = [];
  for (const assessment of assessments) {
    const groups = assessment.blockerGroups.length ? assessment.blockerGroups : ['unknown_blocker'];
    for (const group of groups) memberships.push({ group, assessment });
  }
  const total = memberships.length;
  const byGroup = new Map();
  for (const row of memberships) {
    if (!byGroup.has(row.group)) byGroup.set(row.group, []);
    byGroup.get(row.group).push(row.assessment);
  }

  return [...byGroup.entries()].map(([group, rows]) => {
    const ok = rows.filter((row) => row.dataStatus === 'ok' && row.expectedR != null);
    const summary = {
      blocker: group,
      label: group,
      count: rows.length,
      pct: pct(rows.length, total),
      analyzed: ok.length,
      missingData: rows.length - ok.length,
      averageMfe: round(average(ok.map((row) => row.max?.mfe)), 4),
      averageMae: round(average(ok.map((row) => row.max?.mae)), 4),
      averageMfeAtr: round(average(ok.map((row) => row.max?.mfeAtr)), 3),
      averageMaeAtr: round(average(ok.map((row) => row.max?.maeAtr)), 3),
      winRate: pct(ok.filter((row) => row.expectedR > 0).length, ok.length),
      lossRate: pct(ok.filter((row) => row.expectedR < 0).length, ok.length),
      expectedRR: round(average(ok.map((row) => row.expectedR)), 3),
      stopHitRate: pct(ok.filter((row) => row.stopHit).length, ok.length),
      targetR1Rate: pct(ok.filter((row) => row.targetHitR1).length, ok.length),
      targetR2Rate: pct(ok.filter((row) => row.targetHitR2).length, ok.length),
      targetR3Rate: pct(ok.filter((row) => row.targetHitR3).length, ok.length),
      blockedGoodTrades: ok.filter((row) => row.expectedR >= 1).length,
      blockedBadTrades: ok.filter((row) => row.expectedR <= 0).length,
      horizons: Object.fromEntries(HORIZON_MINUTES.map((minutes) => [minutes, horizonAggregate(ok, minutes)])),
      examples: ok
        .sort((a, b) => Math.abs(b.expectedR || 0) - Math.abs(a.expectedR || 0))
        .slice(0, 8)
        .map((row) => ({
          signalKey: row.signalKey,
          lifecycleId: row.lifecycleId,
          candidateId: row.candidateId,
          signalId: row.signalId,
          intentId: row.intentId,
          executionId: row.executionId,
          idempotencyKey: row.idempotencyKey,
          tradeId: row.tradeId,
          symbol: row.originalSymbol || row.symbol,
          symbolUsed: row.symbolUsed,
          strategyId: row.strategyId,
          blockedAt: row.blockedAt,
          expectedR: row.expectedR,
          mfeAtr: row.max?.mfeAtr,
          maeAtr: row.max?.maeAtr,
          verdict: row.verdict,
        })),
    };
    summary.verdict = blockerVerdict(summary, minSamples);
    return summary;
  }).sort((a, b) => {
    if (a.verdict !== b.verdict) {
      const rank = { overblocking: 0, protective: 1, mixed: 2, insufficient_data: 3 };
      return (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9);
    }
    return b.analyzed - a.analyzed;
  });
}

function summarizeExactBlockers(assessments) {
  const memberships = [];
  for (const assessment of assessments) {
    for (const code of assessment.blockerCodes) memberships.push({ code, assessment });
  }
  const total = memberships.length;
  const byCode = new Map();
  for (const row of memberships) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push(row.assessment);
  }
  return [...byCode.entries()].map(([code, rows]) => {
    const ok = rows.filter((row) => row.dataStatus === 'ok' && row.expectedR != null);
    return {
      blocker: code,
      group: classifyBlockerGroup(code),
      count: rows.length,
      pct: pct(rows.length, total),
      analyzed: ok.length,
      expectedRR: round(average(ok.map((row) => row.expectedR)), 3),
      winRate: pct(ok.filter((row) => row.expectedR > 0).length, ok.length),
      lossRate: pct(ok.filter((row) => row.expectedR < 0).length, ok.length),
      averageMfeAtr: round(average(ok.map((row) => row.max?.mfeAtr)), 3),
      averageMaeAtr: round(average(ok.map((row) => row.max?.maeAtr)), 3),
    };
  }).sort((a, b) => b.count - a.count);
}

function compactAssessment(row) {
  return {
    signalKey: row.signalKey,
    lifecycleId: row.lifecycleId,
    candidateId: row.candidateId,
    signalId: row.signalId,
    intentId: row.intentId,
    executionId: row.executionId,
    idempotencyKey: row.idempotencyKey,
    tradeId: row.tradeId,
    symbol: row.symbol,
    originalSymbol: row.originalSymbol,
    symbolUsed: row.symbolUsed,
    strategyId: row.strategyId,
    direction: row.direction,
    blockedAt: row.blockedAt,
    primaryBlocker: row.primaryBlocker,
    blockerGroups: row.blockerGroups,
    dataStatus: row.dataStatus,
    entryPrice: row.entryPrice,
    risk: row.risk,
    expectedR: row.expectedR,
    stopHit: row.stopHit,
    targetHitR1: row.targetHitR1,
    targetHitR2: row.targetHitR2,
    targetHitR3: row.targetHitR3,
    verdict: row.verdict,
    max: row.max,
  };
}

function createSignalCounterfactualAnalyticsService(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const now = options.now || (() => new Date());
  const loadCandles = options.loadCandles || defaultLoadCandles;
  const lifecycleService = options.signalIntelligenceService || signalIntelligenceLabService.createSignalIntelligenceLabService({
    dataDir,
    now,
  });
  const defaultLimit = options.defaultLimit || 500;

  function buildAssessments(query = {}) {
    const limit = clampInt(query.limit, defaultLimit, 1, 3000);
    const blockPoint = String(query.blockPoint || 'first').toLowerCase() === 'last' ? 'last' : 'first';
    const dataset = lifecycleService.loadDataset(query);
    const blocked = applyRecordFilters(dataset.records, query)
      .filter((record) => record.blockers?.length)
      .filter((record) => String(query.includeTraded || '') === '1' || !record.flags?.hasTrade)
      .slice(0, limit);
    const candleCache = new Map();
    const assessments = blocked.map((record) => assessRecord(record, {
      loadCandles,
      candleCache,
      blockPoint,
    }));
    return {
      load: dataset.load,
      sourceStatus: dataset.sourceStatus,
      assessments,
      candleCacheEntries: candleCache.size,
      blockPoint,
    };
  }

  function buildOverview(query = {}) {
    const minSamples = clampInt(query.minSamples, 3, 1, 100);
    const dataset = buildAssessments(query);
    const assessments = dataset.assessments;
    const ok = assessments.filter((row) => row.dataStatus === 'ok' && row.expectedR != null);
    const groups = summarizeBlockerGroups(assessments, minSamples);
    const exactBlockers = summarizeExactBlockers(assessments);
    const protective = groups.filter((row) => row.verdict === 'protective');
    const overblocking = groups.filter((row) => row.verdict === 'overblocking');

    return {
      ...SAFETY,
      generatedAt: dataset.load.generatedAt,
      load: {
        ...dataset.load,
        blockPoint: dataset.blockPoint,
        horizons: HORIZON_MINUTES,
        minSamples,
      },
      summary: {
        blockedSignals: assessments.length,
        analyzed: ok.length,
        missingData: assessments.length - ok.length,
        dataCoveragePct: pct(ok.length, assessments.length),
        blockedGoodTrades: ok.filter((row) => row.expectedR >= 1).length,
        blockedBadTrades: ok.filter((row) => row.expectedR <= 0).length,
        averageExpectedRR: round(average(ok.map((row) => row.expectedR)), 3),
        averageMfeAtr: round(average(ok.map((row) => row.max?.mfeAtr)), 3),
        averageMaeAtr: round(average(ok.map((row) => row.max?.maeAtr)), 3),
        protectiveBlockers: protective.length,
        overblockingBlockers: overblocking.length,
      },
      horizons: Object.fromEntries(HORIZON_MINUTES.map((minutes) => [minutes, horizonAggregate(ok, minutes)])),
      blockerGroups: groups,
      exactBlockers,
      savesUsFromBadTrades: protective,
      blocksGoodTrades: overblocking,
      recentSignals: assessments.slice(0, clampInt(query.signalLimit, 120, 1, 1000)).map(compactAssessment),
      sourceStatus: dataset.sourceStatus,
      candleCacheEntries: dataset.candleCacheEntries,
    };
  }

  function getSignal(signalKeyOrId, query = {}) {
    const id = normalizeText(signalKeyOrId);
    const dataset = buildAssessments({ ...query, limit: query.limit || 3000 });
    const assessment = dataset.assessments.find((row) => (
      row.signalKey === id
      || row.lifecycleId === id
      || row.candidateId === id
      || row.signalId === id
      || row.intentId === id
      || row.executionId === id
      || row.idempotencyKey === id
      || row.tradeId === id
    ));
    if (!assessment) {
      return {
        ...SAFETY,
        ok: false,
        error: 'counterfactual_signal_not_found',
        signalKey: id,
        generatedAt: dataset.load.generatedAt,
      };
    }
    return {
      ...SAFETY,
      generatedAt: dataset.load.generatedAt,
      signal: assessment,
    };
  }

  return {
    SAFETY,
    HORIZON_MINUTES,
    buildAssessments,
    buildOverview,
    getSignal,
    _internals: {
      classifyBlockerGroup,
      directionOf,
      summarizeHorizon,
      firstTouch,
      deriveAtr,
      normalizeCandle,
      riskUnitFor,
    },
  };
}

const defaultService = createSignalCounterfactualAnalyticsService();

module.exports = {
  SAFETY,
  HORIZON_MINUTES,
  createSignalCounterfactualAnalyticsService,
  buildOverview: (...args) => defaultService.buildOverview(...args),
  getSignal: (...args) => defaultService.getSignal(...args),
};
