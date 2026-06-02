'use strict';

const {
  getRuntimeStrategyMap,
  resolveStrategyMetadata,
} = require('../services/strategyRuntimeConnectorService');

const SIGNAL_FAMILIES = new Set([
  'EMA_TREND_PULLBACK',
  'VWAP_RECLAIM_REJECTION',
  'BREAKOUT_RETEST',
  'NARROW_COMPRESSION',
  'LATE_MOVE_BLOCK',
  'UNKNOWN',
]);

const EMPTY_ATTEMPT = Object.freeze({
  matched: false,
  missing: [],
  failedReasons: [],
});

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function normalizeDir(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'up' || v === 'bullish' || v === 'long') return 'UP';
  if (v === 'down' || v === 'bearish' || v === 'short') return 'DOWN';
  return 'UNKNOWN';
}

function dirToTf(direction) {
  if (direction === 'UP') return 'bullish';
  if (direction === 'DOWN') return 'bearish';
  return 'unknown';
}

function deriveDirection(sig) {
  const direct = normalizeDir(sig.nextMoveBias || sig.direction);
  if (direct !== 'UNKNOWN') return direct;

  const signal = String(sig.signal || '');
  if (signal.startsWith('LONG')) return 'UP';
  if (signal.startsWith('SHORT')) return 'DOWN';

  const marketDirection = normalizeDir(sig.marketDirection);
  if (marketDirection !== 'UNKNOWN') return marketDirection;

  const tfValues = ['tf1h', 'tf30m', 'tf15m', 'tf10m', 'tf5m', 'tf2m']
    .map((key) => normalizeDir(sig[key] ?? sig.timeframeAgreement?.[key]))
    .filter((v) => v !== 'UNKNOWN');
  const up = tfValues.filter((v) => v === 'UP').length;
  const down = tfValues.filter((v) => v === 'DOWN').length;
  if (up > down) return 'UP';
  if (down > up) return 'DOWN';
  return 'UNKNOWN';
}

function candleDirection(candleScore2m) {
  return normalizeDir(candleScore2m?.scoreDirection);
}

function timeframe(sig, key) {
  return String(sig[key] ?? sig.timeframeAgreement?.[key] ?? sig.timeframes?.[key] ?? 'unknown').toLowerCase();
}

function hasFreshData(sig) {
  const freshness = String(sig.dataFreshness || '').toUpperCase();
  return freshness !== 'STALE';
}

function isExtreme(sig) {
  return String(sig.extensionLevel || '').toLowerCase() === 'extreme';
}

function hardBlockerCount(sig) {
  return asArray(sig.hardBlockers).length;
}

function priceValue(sig) {
  return num(sig.priceAtSignal ?? sig.entryPrice ?? sig.price ?? sig.close);
}

function pctDistance(price, level) {
  if (!price || !level) return null;
  return Math.abs(((price - level) / level) * 100);
}

function atrDistance(price, level, atr14) {
  if (!price || !level || !atr14) return null;
  return Math.abs(price - level) / atr14;
}

function isNearAnyPullbackLevel(sig) {
  const price = priceValue(sig);
  const atr14 = num(sig.atr14);
  const levels = [sig.ema21, sig.ema50, sig.vwap]
    .map(num)
    .filter((v) => v != null && v > 0);

  if (!levels.length) return true;
  if (!price) return false;

  return levels.some((level) => {
    const pct = pctDistance(price, level);
    const atr = atrDistance(price, level, atr14);
    return (pct != null && pct <= 0.8) || (atr != null && atr <= 1.2);
  });
}

function vwapDistance(sig) {
  if (sig.vwapDistancePct != null) return num(sig.vwapDistancePct);
  const price = priceValue(sig);
  const vwap = num(sig.vwap);
  if (!price || !vwap) return null;
  return ((price - vwap) / vwap) * 100;
}

function volumeIsUsable(sig) {
  const volumeState = String(sig.volumeState || '').toLowerCase();
  if (volumeState === 'very_low' || volumeState === 'low' || volumeState === 'weak') return false;
  const rvol = num(sig.rvol ?? sig.relVol20);
  return rvol == null || rvol >= 0.7;
}

function evaluateEmaTrendPullback(sig, direction) {
  const missing = [];
  const failedReasons = [];
  const state = String(sig.state || sig.narrowState || '').toUpperCase();
  const narrowType = String(sig.narrowType || '').toLowerCase();
  const eventType = String(sig.eventType || sig.signalSubtype || '').toUpperCase();
  const narrowContext =
    state === 'HIGH_QUALITY_NARROW' ||
    state === 'MEDIUM_NARROW' ||
    narrowType === 'coil_flat' ||
    narrowType === 'attack_200' ||
    eventType === 'NARROW_WAIT' ||
    eventType === 'BULLISH_COLOR_CHANGE' ||
    eventType === 'BEARISH_COLOR_CHANGE' ||
    eventType === 'BULLISH_ELEPHANT_BREAKOUT' ||
    eventType === 'BEARISH_ELEPHANT_BREAKDOWN';

  if (direction !== 'UP' && direction !== 'DOWN') failedReasons.push('Riktningen är inte tydlig.');
  if (!hasFreshData(sig)) failedReasons.push('Data är gammal.');
  if (isExtreme(sig)) failedReasons.push('Rörelsen är markerad som extrem.');
  if (hardBlockerCount(sig) > 1) failedReasons.push('Fler än en hård blockerare finns.');
  if (narrowContext) failedReasons.push('Narrow-kontext ska klassas som NARROW_COMPRESSION, inte EMA-rekyl.');

  ['ema21', 'ema50'].forEach((key) => {
    if (num(sig[key]) == null) missing.push(key);
  });
  if (!priceValue(sig)) missing.push('price');
  if (direction !== 'UP' && direction !== 'DOWN') {
    return { ...EMPTY_ATTEMPT, missing, failedReasons };
  }
  const tfDir = dirToTf(direction);
  const majorTrendCount = ['tf1h', 'tf30m', 'tf15m']
    .filter((key) => timeframe(sig, key) === tfDir).length;
  const supportingTrendCount = ['tf10m', 'tf5m']
    .filter((key) => timeframe(sig, key) === tfDir).length;
  const agreementCount = num(sig.agreementCount) ?? 0;
  const trendAligned = majorTrendCount >= 2 || (majorTrendCount >= 1 && agreementCount >= 5) || (majorTrendCount >= 1 && supportingTrendCount >= 1);

  const tf2mAligned = timeframe(sig, 'tf2m') === tfDir;
  const candleAligned = candleDirection(sig.candleScore2m) === direction;
  const historicalPullback =
    sig.eventType === 'REGULAR_PULLBACK' &&
    (String(sig.signal || '').startsWith('LONG') || String(sig.signal || '').startsWith('SHORT'));
  const shortSideConfirms = tf2mAligned || candleAligned || historicalPullback;
  const nearPullbackLevel = isNearAnyPullbackLevel(sig);

  if (!trendAligned) failedReasons.push('Större tidsramar ger inte tillräckligt trendstöd.');
  if (!shortSideConfirms) failedReasons.push('Kort 2m-bekräftelse saknas.');
  if (!nearPullbackLevel) failedReasons.push('Priset är inte i rekylzon nära EMA/VWAP.');

  return {
    matched: missing.length === 0 && failedReasons.length === 0,
    missing,
    failedReasons,
    details: {
      majorTrendCount,
      supportingTrendCount,
      agreementCount,
      tf2mAligned,
      candleAligned,
      historicalPullback,
      nearPullbackLevel,
    },
  };
}

function strategyMetadataFromExplicitMapping(strategyId, sourceStrategyName = null) {
  if (!strategyId) return null;
  return {
    sourceStrategyId: strategyId,
    sourceStrategyName,
    strategyId,
    strategyName: sourceStrategyName,
    resolvedStrategyId: strategyId,
    resolvedStrategyName: sourceStrategyName,
    mappingSource: 'explicit',
  };
}

function classifyEmaTrendPullback(sig, direction) {
  const attempt = evaluateEmaTrendPullback(sig, direction);
  if (!attempt.matched) return null;

  const subtype = direction === 'UP' ? 'EMA_PULLBACK_UP' : 'EMA_PULLBACK_DOWN';
  const inferred = resolveStrategyMetadata(
    {
      ...sig,
      signalFamily: 'EMA_TREND_PULLBACK',
      signalSubtype: subtype,
      eventType: subtype,
    },
    { allowLegacyFallback: true },
  );
  const strategyId = inferred?.resolvedStrategyId || inferred?.strategyId || null;
  const metadata = strategyMetadataFromExplicitMapping(strategyId, inferred?.resolvedStrategyName || inferred?.strategyName || null);

  return {
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: subtype,
    direction,
    reasonSv: direction === 'UP'
      ? 'Trend-rekyl upptäckt. Riktningen lutar uppåt, men vänta på tydlig 2m-bekräftelse.'
      : 'Trend-rekyl upptäckt. Riktningen lutar nedåt, men vänta på tydlig 2m-bekräftelse.',
    ...metadata,
  };
}

function evaluateVwapReclaimRejection(sig, direction) {
  const missing = [];
  const failedReasons = [];
  if (direction !== 'UP' && direction !== 'DOWN') failedReasons.push('Riktningen är inte tydlig.');
  if (!hasFreshData(sig)) failedReasons.push('Data är gammal.');
  if (isExtreme(sig)) failedReasons.push('Rörelsen är markerad som extrem.');
  if (!volumeIsUsable(sig)) failedReasons.push('Volymen är för svag.');
  if (!num(sig.vwap)) missing.push('vwap');
  if (!priceValue(sig)) missing.push('price');
  const distance = vwapDistance(sig);
  if (distance == null) missing.push('vwapDistancePct');
  else if (Math.abs(distance) > 0.45) failedReasons.push('Priset är inte nära nog VWAP.');

  const tfDir = dirToTf(direction);
  const tf2mAligned = timeframe(sig, 'tf2m') === tfDir;
  const candleAligned = candleDirection(sig.candleScore2m) === direction;
  if (direction === 'UP' || direction === 'DOWN') {
    if (!tf2mAligned && !candleAligned) failedReasons.push('2m eller candle-score bekräftar inte riktningen.');
  }

  return {
    matched: missing.length === 0 && failedReasons.length === 0,
    missing,
    failedReasons,
    details: {
      distancePct: distance,
      priceVsVwap: distance == null ? 'unknown' : distance >= 0 ? 'above' : 'below',
      tf2mAligned,
      candleAligned,
      volumeUsable: volumeIsUsable(sig),
    },
  };
}

function classifyVwapReclaimRejection(sig, direction) {
  const attempt = evaluateVwapReclaimRejection(sig, direction);
  if (!attempt.matched) return null;

  return {
    signalFamily: 'VWAP_RECLAIM_REJECTION',
    signalSubtype: direction === 'UP' ? 'VWAP_RECLAIM_UP' : 'VWAP_REJECTION_DOWN',
    direction,
    reasonSv: 'Priset testar dagens VWAP. Bevaka om nivån håller.',
  };
}

function buildSignalFamilyDebug(sig = {}) {
  const direction = deriveDirection(sig);
  const ema = evaluateEmaTrendPullback(sig, direction);
  const vwap = evaluateVwapReclaimRejection(sig, direction);
  return {
    direction,
    attemptedFamilies: {
      EMA_TREND_PULLBACK: {
        matched: ema.matched,
        missing: ema.missing || [],
        failedReasons: ema.failedReasons || [],
        details: ema.details || {},
      },
      VWAP_RECLAIM_REJECTION: {
        matched: vwap.matched,
        missing: vwap.missing || [],
        failedReasons: vwap.failedReasons || [],
        details: vwap.details || {},
      },
    },
  };
}

function classifySignalFamily(sig = {}) {
  const direction = deriveDirection(sig);
  const state = String(sig.state || sig.narrowState || '').toUpperCase();
  const eventType = String(sig.eventType || sig.signalSubtype || '').toUpperCase();
  const narrowType = String(sig.narrowType || '').toLowerCase();

  const signalType = String(sig.signalSubtype || sig.eventType || '').toUpperCase();
  if (signalType === 'REGULAR_PULLBACK') {
    const runtimeEntry = getRuntimeStrategyMap().find((entry) => entry.raw_signal === 'REGULAR_PULLBACK');
    const strategyId = runtimeEntry?.strategy_id || 'trend_continuation';
    const strategyName = runtimeEntry?.strategy_name || null;
    return {
      signalFamily: 'REGULAR_PULLBACK',
      signalSubtype: 'REGULAR_PULLBACK',
      direction,
      reasonSv: 'Vanlig rekyl identifierad som stabil familj.',
      ...strategyMetadataFromExplicitMapping(strategyId, strategyName),
    };
  }

  const isNarrowContext =
    state === 'HIGH_QUALITY_NARROW' ||
    state === 'MEDIUM_NARROW' ||
    narrowType === 'coil_flat' ||
    narrowType === 'attack_200' ||
    eventType === 'NARROW_WAIT' ||
    eventType === 'BULLISH_COLOR_CHANGE' ||
    eventType === 'BEARISH_COLOR_CHANGE' ||
    eventType === 'BULLISH_ELEPHANT_BREAKOUT' ||
    eventType === 'BEARISH_ELEPHANT_BREAKDOWN';

  if (isNarrowContext) {
    const subtype =
      eventType === 'NARROW_WAIT'
        ? 'NARROW_WAIT'
        : direction === 'UP'
          ? 'NARROW_BULL_ENTRY'
          : direction === 'DOWN'
            ? 'NARROW_BEAR_ENTRY'
            : 'NARROW_WAIT';

    const inferred = resolveStrategyMetadata(
      {
        ...sig,
        signalFamily: 'NARROW_COMPRESSION',
        signalSubtype: subtype,
        eventType: subtype,
      },
      { allowLegacyFallback: true },
    );
    const strategyId = inferred?.resolvedStrategyId || inferred?.strategyId || null;
    const metadata = strategyMetadataFromExplicitMapping(strategyId, inferred?.resolvedStrategyName || inferred?.strategyName || null);

    return {
      signalFamily: 'NARROW_COMPRESSION',
      signalSubtype: subtype,
      direction,
      reasonSv: direction === 'UP'
        ? 'Ihoptryckt pris upptäckt. Riktningen lutar uppåt, men vänta på tydlig 2m-bekräftelse.'
        : direction === 'DOWN'
          ? 'Ihoptryckt pris upptäckt. Riktningen lutar nedåt, men vänta på tydlig 2m-bekräftelse.'
          : 'Ihoptryckt pris upptäckt. Vänta på tydlig 2m-bekräftelse.',
      ...metadata,
    };
  }

  const vwap = classifyVwapReclaimRejection(sig, direction);
  if (vwap) return vwap;

  const ema = classifyEmaTrendPullback(sig, direction);
  if (ema) return ema;

  if (
    state === 'WIDE_AVOID' ||
    state === 'THREE_FINGER_SPREAD_AVOID' ||
    eventType === 'WIDE_REVERSAL_WATCH' ||
    eventType === 'THREE_FINGER_SPREAD_AVOID'
  ) {
    return {
      signalFamily: 'LATE_MOVE_BLOCK',
      signalSubtype: eventType === 'WIDE_REVERSAL_WATCH' ? 'WIDE_REVERSAL_WATCH' : 'THREE_FINGER_SPREAD_AVOID',
      direction,
      reasonSv: eventType === 'WIDE_REVERSAL_WATCH'
        ? 'Rörelsen är sen och en möjlig vändning kan vara på gång.'
        : 'Priset är för långt ifrån. Jaga inte.',
    };
  }

  if (SIGNAL_FAMILIES.has(sig.signalFamily) && sig.signalFamily !== 'UNKNOWN') {
    return {
      signalFamily: sig.signalFamily,
      signalSubtype: sig.signalSubtype || 'UNKNOWN',
      direction,
      reasonSv: sig.signalFamilyReasonSv || null,
    };
  }

  return {
    signalFamily: 'UNKNOWN',
    signalSubtype: sig.signalSubtype || sig.eventType || 'UNKNOWN',
    direction,
    reasonSv: null,
  };
}

module.exports = {
  SIGNAL_FAMILIES,
  buildSignalFamilyDebug,
  classifySignalFamily,
};
