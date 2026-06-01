'use strict';

const { buildSignalFamilyDebug, classifySignalFamily } = require('./signalFamilyClassifier');
const { buildCryptoSignalContext } = require('../services/strategyRuntimeConnectorService');
const {
  signalFamilyDebugSummarySv,
  signalFamilyLabel,
  signalSubtypeLabel,
} = require('./signalFamilyLabels');

function deriveTimeframes(result) {
  const tf2m = result.tf2mDirection || 'neutral';
  const tf5m = result.tf5mDirection || result.mtf5m?.direction || 'neutral';
  const tf15m = result.tf15mDirection || result.mtf15m?.direction || 'neutral';

  // tf10m: blend of 5m + 15m — only directional if they agree
  const tf10m = (tf5m === tf15m && tf5m !== 'neutral') ? tf5m : 'neutral';

  // tf30m: derive from slope20Atr (medium-term momentum) + price vs sma20
  let tf30m = 'neutral';
  if (result.slope20Atr != null) {
    if (result.slope20Atr > 0.3) tf30m = 'bullish';
    else if (result.slope20Atr < -0.3) tf30m = 'bearish';
  } else if (result.price && result.sma20) {
    tf30m = result.price > result.sma20 ? 'bullish' : 'bearish';
  }

  // tf1h: derive from sma20 vs sma200 relationship (long-term context)
  let tf1h = 'neutral';
  const regime = result.marketRegimeV2 || '';
  if (regime.includes('BULL') || regime.includes('TREND_DAY_UP')) {
    tf1h = 'bullish';
  } else if (regime.includes('BEAR') || regime.includes('TREND_DAY_DOWN')) {
    tf1h = 'bearish';
  } else if (result.sma20 != null && result.sma200 != null) {
    tf1h = result.sma20 > result.sma200 ? 'bullish' : 'bearish';
  }

  return { tf1h, tf30m, tf15m, tf10m, tf5m, tf2m };
}

function computeCandleScore2m(candles) {
  const sorted = (candles || [])
    .filter((c) => c && c.timestamp)
    .map((c) => ({
      timestamp: c.timestamp,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-5);

  if (!sorted.length) {
    return {
      greenCount5: 0,
      redCount5: 0,
      greenCount3: 0,
      redCount3: 0,
      netMovePct5: null,
      netMovePct3: null,
      higherHighsCount: 0,
      higherLowsCount: 0,
      volumeComment: 'Volym saknas',
      scoreDirection: 'unknown',
      reasonSv: '2m candles saknas för candle-score.',
    };
  }

  const last3 = sorted.slice(-3);
  const green = (arr) => arr.filter((c) => c.close > c.open).length;
  const red = (arr) => arr.filter((c) => c.close < c.open).length;
  const netMovePct = (arr) => {
    const first = arr[0]?.close;
    const last = arr[arr.length - 1]?.close;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
    return Number((((last - first) / first) * 100).toFixed(3));
  };

  let higherHighsCount = 0;
  let lowerHighsCount = 0;
  let higherLowsCount = 0;
  let lowerLowsCount = 0;
  let volumeUpCount = 0;
  let volumeDownCount = 0;

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].high > sorted[i - 1].high) higherHighsCount += 1;
    if (sorted[i].high < sorted[i - 1].high) lowerHighsCount += 1;
    if (sorted[i].low > sorted[i - 1].low) higherLowsCount += 1;
    if (sorted[i].low < sorted[i - 1].low) lowerLowsCount += 1;
    if (Number.isFinite(sorted[i].volume) && Number.isFinite(sorted[i - 1].volume)) {
      if (sorted[i].volume > sorted[i - 1].volume) volumeUpCount += 1;
      if (sorted[i].volume < sorted[i - 1].volume) volumeDownCount += 1;
    }
  }

  const greenCount5 = green(sorted);
  const redCount5 = red(sorted);
  const greenCount3 = green(last3);
  const redCount3 = red(last3);
  const netMovePct5 = netMovePct(sorted);
  const netMovePct3 = netMovePct(last3);
  const volumeComment = volumeUpCount > volumeDownCount
    ? 'Volymen ökar'
    : volumeDownCount > volumeUpCount
      ? 'Volymen sjunker'
      : 'Volymen är blandad';

  const bullish = greenCount3 >= 2 &&
    netMovePct3 > 0 &&
    netMovePct5 > 0 &&
    higherLowsCount >= 2 &&
    lowerHighsCount <= 1;
  const bearish = redCount3 >= 2 &&
    netMovePct3 < 0 &&
    netMovePct5 < 0 &&
    lowerHighsCount >= 2 &&
    lowerLowsCount >= 2;
  const scoreDirection = bullish ? 'bullish' : bearish ? 'bearish' : 'neutral';
  const reasonSv = scoreDirection === 'bullish'
    ? 'Senaste 2m candles lutar uppåt med positiv nettorörelse och stigande lows.'
    : scoreDirection === 'bearish'
      ? 'Senaste 2m candles lutar nedåt med negativ nettorörelse och fallande struktur.'
      : 'Senaste 2m candles ger ingen tydlig riktning.';

  return {
    greenCount5,
    redCount5,
    greenCount3,
    redCount3,
    netMovePct5,
    netMovePct3,
    higherHighsCount,
    higherLowsCount,
    volumeComment,
    scoreDirection,
    reasonSv,
  };
}

function computeNextMoveBias(result, dirs, context = {}) {
  const state = result.stateGraph?.currentState || 'UNKNOWN';
  const vals = Object.values(dirs);
  const bullCount = vals.filter(v => v === 'bullish').length;
  const bearCount = vals.filter(v => v === 'bearish').length;
  const tf2m = dirs.tf2m || 'neutral';
  const marketType = context.marketType || result._market || result.market;
  const staleData = context.staleData === true;
  const candleScore2m = context.candleScore2m || null;
  const candleDirection = candleScore2m?.scoreDirection || 'unknown';
  const bullishCandleOk = candleDirection === 'bullish' || candleDirection === 'unknown';
  const bearishCandleOk = candleDirection === 'bearish' || candleDirection === 'unknown';

  if (tf2m === 'neutral' || tf2m === 'unknown') return 'UNCERTAIN';

  if (marketType === 'crypto' && !staleData) {
    if (tf2m === 'bullish' && bullCount >= 5 && bullishCandleOk) return 'UP';
    if (tf2m === 'bearish' && bearCount >= 5 && bearishCandleOk) return 'DOWN';
    if (tf2m === 'bullish' && candleDirection === 'bearish') return 'UNCERTAIN';
    if (tf2m === 'bearish' && candleDirection === 'bullish') return 'UNCERTAIN';
  }

  if (state === 'COMPRESSION') return 'UNCERTAIN';
  if (state === 'EXHAUSTION') return result.signal?.includes('SHORT') ? 'DOWN' : 'UNCERTAIN';

  if (tf2m !== 'bullish' && bullCount >= 4) return 'UNCERTAIN';
  if (tf2m !== 'bearish' && bearCount >= 4) return 'UNCERTAIN';
  if (bullCount >= 4) return 'UP';
  if (bearCount >= 4) return 'DOWN';
  if (tf2m === 'bullish' && bullCount - bearCount >= 2) return 'UP';
  if (tf2m === 'bearish' && bearCount - bullCount >= 2) return 'DOWN';
  return 'UNCERTAIN';
}

function computeConfidence(result, agreementCount) {
  const base = Math.max(result.tradeScore || 0, result.daytradeScore || 0);
  const tfBonus = Math.min(agreementCount * 4, 20);
  const riskPenalty = result.fakeoutRiskLevel === 'high' ? 15 : 0;
  return Math.max(0, Math.min(100, base + tfBonus - riskPenalty));
}

const BIAS_LABEL = {
  UP: { sv: 'Uppåt', icon: '▲' },
  DOWN: { sv: 'Nedåt', icon: '▼' },
  NEUTRAL: { sv: 'Neutral', icon: '→' },
  UNCERTAIN: { sv: 'Osäker', icon: '?' },
};

function buildDecisionText(result, bias, agreementCount, dirs, blockersMeta, extensionMeta) {
  const score = Math.max(result.tradeScore || 0, result.daytradeScore || 0);
  const signal = result.signal || 'NO_SIGNAL';
  const state = result.stateGraph?.currentState || 'UNKNOWN';
  const hasHardBlock = blockersMeta.hardBlockers.length > 0;
  const hasOnlySoftBlockers = !hasHardBlock && blockersMeta.softBlockers.length > 0;
  const twoMinuteConfirmed = blockersMeta.twoMinuteConfirmed;
  const highAgreement = agreementCount >= 5;
  const enoughAgreement = agreementCount >= 4;

  // Compression — potential setup forming
  if (state === 'COMPRESSION') {
    return { text: 'Setup nära. Vänta på tydlig 2m-bekräftelse.', priority: 'watch' };
  }

  if (hasHardBlock || result.fakeoutRiskLevel === 'high') {
    return {
      text: extensionMeta?.level === 'extreme'
        ? 'Rörelsen är för långt gången — jaga inte.'
        : 'Jaga inte. Risken eller avståndet är för högt just nu.',
      priority: 'avoid',
    };
  }

  // Exhaustion state
  if (state === 'EXHAUSTION') {
    return { text: 'Rörelsen är för långt gången — jaga inte.', priority: 'avoid' };
  }

  if (!twoMinuteConfirmed) {
    return { text: '2m bekräftar inte rörelsen ännu.', priority: signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED' ? 'watch' : 'wait' };
  }

  if (state === 'CHOPPY' && highAgreement) {
    return {
      text: 'Flera tidsramar håller med, men marknaden är ryckig.',
      priority: hasOnlySoftBlockers ? 'caution' : 'watch',
    };
  }

  if (agreementCount <= 2 || state === 'CHOPPY') {
    return { text: 'Vänta. Tidsramarna håller inte med.', priority: 'wait' };
  }

  if ((signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED') && enoughAgreement && bias !== 'UNCERTAIN') {
    return hasOnlySoftBlockers
      ? { text: 'Nära, men försiktig. 2m bekräftar och större tidsramar ger stöd, men varningar finns.', priority: 'caution' }
      : { text: 'Titta manuellt. 2m bekräftar och större trend håller med.', priority: 'active' };
  }

  if (twoMinuteConfirmed && enoughAgreement && hasOnlySoftBlockers) {
    return {
      text: 'Riktningen lutar uppåt, men rörelsen har redan gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
      priority: 'watch',
    };
  }

  // Near-ready setup
  if (score >= 50) {
    return { text: 'Bevaka. Läget är nära men behöver mer stöd.', priority: 'watch' };
  }

  // Decent potential
  if (score >= 35) {
    return { text: 'Vänta. Potential finns men bekräftelse saknas.', priority: 'wait' };
  }

  return { text: 'Vänta. Systemet ser inget tydligt läge.', priority: 'wait' };
}

const PRIORITY_ORDER = { active: 0, caution: 1, watch: 2, wait: 3, avoid: 4 };
const PRICE_SOFT_ZONE_ATR = 1.8;
const PRICE_HARD_ZONE_ATR = 12.0;
const PRICE_HARD_WITHOUT_2M_ATR = 3.0;
const EXTENSION_MILD_ATR = 1.5;
const EXTENSION_MEDIUM_ATR = 7.0;
const EXTENSION_EXTREME_ATR = 12.0;
const RECENT_MOVE_MILD_ATR = 2.0;
const RECENT_MOVE_MEDIUM_ATR = 3.2;
const RECENT_MOVE_EXTREME_ATR = 5.0;
const FRESH_CRYPTO_MS = 20 * 60 * 1000;
const FRESH_STOCK_MS = 24 * 60 * 60 * 1000;

function calcRecentMoveAtr(result, bias) {
  const price = Number(result.price);
  const atr = Number(result.atr14);
  if (!Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return false;

  const recentLow = Number(result.recentLow);
  const recentHigh = Number(result.recentHigh);
  if (bias === 'UP' && Number.isFinite(recentLow)) return Math.max(0, (price - recentLow) / atr);
  if (bias === 'DOWN' && Number.isFinite(recentHigh)) return Math.max(0, (recentHigh - price) / atr);

  const fromLow = Number.isFinite(recentLow) ? Math.max(0, (price - recentLow) / atr) : 0;
  const fromHigh = Number.isFinite(recentHigh) ? Math.max(0, (recentHigh - price) / atr) : 0;
  return Math.max(fromLow, fromHigh);
}

function classifyExtension(result, bias, dirs, agreementCount) {
  const priceToZoneAtrRaw = Number(result.priceToZoneAtr);
  const priceToZoneAtr = Number.isFinite(priceToZoneAtrRaw) ? priceToZoneAtrRaw : 0;
  const recentMoveAtrRaw = calcRecentMoveAtr(result, bias);
  const recentMoveAtr = Number.isFinite(recentMoveAtrRaw) ? recentMoveAtrRaw : 0;
  const fatigueScore = Number(result.fatigueContext?.fatigueScore || 0);
  const tfsActive = result.threeFingerSpread?.active === true;
  const tfsSuperWide = result.threeFingerSpread?.strength === 'super_wide';
  const twoMinuteConfirmed = hasTwoMinuteConfirmation(dirs, bias);
  const alignedFastFrames = dirs.tf2m !== 'neutral' && dirs.tf2m === dirs.tf5m && dirs.tf5m === dirs.tf10m;
  const highFakeout = result.fakeoutRiskLevel === 'high';
  const breakout = result.breakoutAlreadyOccurred === true;

  let level = 'none';
  const reasons = [];

  if (
    priceToZoneAtr >= EXTENSION_EXTREME_ATR ||
    fatigueScore >= 75 ||
    (highFakeout && priceToZoneAtr >= EXTENSION_MEDIUM_ATR) ||
    (breakout && !twoMinuteConfirmed) ||
    (!twoMinuteConfirmed && recentMoveAtr >= RECENT_MOVE_EXTREME_ATR) ||
    (tfsSuperWide && priceToZoneAtr >= 6.5 && agreementCount <= 3 && !alignedFastFrames)
  ) {
    level = 'extreme';
  } else if (
    priceToZoneAtr >= EXTENSION_MEDIUM_ATR ||
    fatigueScore >= 60 ||
    breakout ||
    (recentMoveAtr >= RECENT_MOVE_MEDIUM_ATR && !(alignedFastFrames && agreementCount >= 5)) ||
    (tfsActive && !(alignedFastFrames && agreementCount >= 5))
  ) {
    level = 'medium';
  } else if (
    priceToZoneAtr >= EXTENSION_MILD_ATR ||
    recentMoveAtr >= RECENT_MOVE_MILD_ATR ||
    fatigueScore >= 45 ||
    tfsActive
  ) {
    level = 'mild';
  }

  if (priceToZoneAtr >= EXTENSION_MILD_ATR) reasons.push(`priceToZoneAtr=${priceToZoneAtr.toFixed(2)}`);
  if (recentMoveAtr >= RECENT_MOVE_MILD_ATR) reasons.push(`recentMoveAtr=${recentMoveAtr.toFixed(2)}`);
  if (fatigueScore >= 45) reasons.push(`fatigueScore=${fatigueScore}`);
  if (breakout) reasons.push('breakoutAlreadyOccurred');
  if (tfsActive) reasons.push(`threeFingerSpread=${result.threeFingerSpread?.strength || 'active'}`);

  return {
    level,
    reasons,
    priceToZoneAtr,
    recentMoveAtr,
    fatigueScore,
    twoMinuteConfirmed,
    alignedFastFrames,
  };
}

const EXTENSION_TEXT = {
  none: null,
  mild: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
  medium: 'Rörelsen är långt gången. Vänta på rekyl eller tydligare 2m-bekräftelse.',
  extreme: 'Rörelsen är för långt gången — jaga inte.',
};

function applyExtensionGuard({ decisionTextSv, priority, extensionMeta }) {
  if (!extensionMeta || extensionMeta.level === 'none') {
    return { decisionTextSv, priority, lateMove: false };
  }

  const level = extensionMeta.level;
  const cappedPriority = level === 'extreme'
    ? 'avoid'
    : level === 'mild' && priority === 'active'
      ? 'caution'
    : level === 'medium' && ['active', 'caution', 'watch'].includes(priority)
      ? 'wait'
      : priority;

  return {
    decisionTextSv: EXTENSION_TEXT[level] || decisionTextSv,
    priority: cappedPriority,
    lateMove: true,
    extensionLevel: level,
  };
}

function makeSignalId(symbol, timestamp) {
  if (!symbol || !timestamp) return null;
  return `${symbol}_${new Date(timestamp).toISOString()}`;
}

function latestTimestamp(result) {
  return result.timestamp || result.candleTs || result.latest2mTimestamp || result.lastUpdate || null;
}

function blockerLabel(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('fakeout')) return 'Risken för falskt utbrott är hög';
  if (s.includes('senaste 2m-candles säger emot')) return 'Senaste 2m-candles säger emot riktningen';
  if (s.includes('gått en bit')) return 'Rörelsen har gått en bit';
  if (s.includes('för långt gången')) return 'Rörelsen är för långt gången — jaga inte';
  if (s.includes('långt gången')) return 'Rörelsen är långt gången';
  if (s.includes('lite långt')) return 'Priset är lite långt från bra nivå';
  if (s.includes('pris') || s.includes('price') || s.includes('wide') || s.includes('breakout')) return 'Priset är för långt från bra nivå — jaga inte';
  if (s.includes('likvid') || s.includes('vol')) return 'Volymen är svag';
  if (s.includes('mtf') || s.includes('conflict')) return 'Större trend håller inte med';
  if (s.includes('2m')) return '2m saknar bekräftelse';
  if (s.includes('gammal') || s.includes('stale')) return 'Data är gammal';
  if (s.includes('feed')) return 'Stock feed verkar osäker';
  if (s.includes('chopp') || s.includes('ryckig')) return 'Marknaden är ryckig';
  if (s.includes('auto') || s.includes('confidence') || s.includes('reglerna')) return 'Reglerna blockerar läget';
  return raw;
}

function uniqueLabels(labels) {
  return [...new Set(labels.filter(Boolean).map(blockerLabel))];
}

function directionFromBias(bias) {
  if (bias === 'UP') return 'bullish';
  if (bias === 'DOWN') return 'bearish';
  return null;
}

function hasTwoMinuteConfirmation(dirs, bias) {
  if (!['bullish', 'bearish'].includes(dirs.tf2m)) return false;
  const dir = directionFromBias(bias);
  if (!dir) return true;
  return dirs.tf2m === dir;
}

function candleScoreOpposesTf2m(dirs, candleScore2m) {
  const scoreDirection = candleScore2m?.scoreDirection || 'unknown';
  return (dirs.tf2m === 'bullish' && scoreDirection === 'bearish') ||
    (dirs.tf2m === 'bearish' && scoreDirection === 'bullish');
}

function buildTwoMinuteConflict(dirs, candleScore2m) {
  const scoreDirection = candleScore2m?.scoreDirection || 'unknown';
  if (dirs.tf2m === 'bullish' && scoreDirection === 'bearish') {
    return {
      twoMinuteConflict: true,
      twoMinuteConflictType: 'bullish_tf_bearish_candles',
      twoMinuteConflictSv: 'Större tidsramar håller med, men senaste 2m-candles säger emot.',
    };
  }
  if (dirs.tf2m === 'bearish' && scoreDirection === 'bullish') {
    return {
      twoMinuteConflict: true,
      twoMinuteConflictType: 'bearish_tf_bullish_candles',
      twoMinuteConflictSv: 'Större tidsramar håller med, men senaste 2m-candles säger emot.',
    };
  }
  return {
    twoMinuteConflict: false,
    twoMinuteConflictType: null,
    twoMinuteConflictSv: null,
  };
}

function qualifiesForWatchLayer({ staleData, hardBlockers, agreementCount, dirs, candleScore2m, extensionMeta }) {
  if (staleData) return false;
  if (hardBlockers.length) return false;
  if (agreementCount < 5) return false;
  if (!['bullish', 'bearish'].includes(dirs.tf2m)) return false;
  if (!['mild', 'medium'].includes(extensionMeta?.level)) return false;
  if (candleScoreOpposesTf2m(dirs, candleScore2m)) return false;
  return true;
}

function isDataStale(timestamp, marketType) {
  if (!timestamp) return true;
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return true;
  const maxAge = marketType === 'crypto' ? FRESH_CRYPTO_MS : FRESH_STOCK_MS;
  return Date.now() - t > maxAge;
}

function isStockMarket(marketType) {
  return ['stock', 'stocks'].includes(String(marketType || '').toLowerCase());
}

function normalizeVolumeState(value) {
  return String(value || 'unknown').toLowerCase();
}

function isNormalOrStrongVolume(volumeState) {
  return ['normal', 'strong'].includes(normalizeVolumeState(volumeState));
}

function isNoneOrMildExtension(extensionLevel) {
  return ['none', 'mild'].includes(String(extensionLevel || 'unknown').toLowerCase());
}

function isMediumOrExtremeExtension(extensionLevel) {
  return ['medium', 'extreme'].includes(String(extensionLevel || 'unknown').toLowerCase());
}

function candleDirection(candleScore2m) {
  return candleScore2m?.scoreDirection || 'unknown';
}

function isLowFamilyCalibrationRisk({ fakeoutRiskLevel, twoMinuteConflict, candleScore2m }) {
  if (fakeoutRiskLevel === 'high') return false;
  if (twoMinuteConflict) return false;
  return candleDirection(candleScore2m) !== 'bearish';
}

function buildFamilyCalibrationHints({
  marketType,
  signalFamily,
  signalSubtype,
  staleData,
  volumeState,
  extensionLevel,
  hardBlockers,
  agreementCount,
  dirs,
  candleScore2m,
  fakeoutRiskLevel,
  twoMinuteConflict,
  marketRegime,
  priority,
}) {
  const source = 'Signal Family Calibration v2';
  const cleanHardBlockers = hardBlockers || [];
  const candleDir = candleDirection(candleScore2m);
  const volumeOk = isNormalOrStrongVolume(volumeState);
  const extensionOk = isNoneOrMildExtension(extensionLevel);
  const noHardBlockers = cleanHardBlockers.length === 0;

  const base = {
    historicalEdge: 'unknown',
    reasonSv: 'Ingen separat familjekalibrering används för den här kandidaten.',
    suggestedPriorityBias: 'keep',
    source,
  };

  if (isStockMarket(marketType) && signalSubtype === 'VWAP_RECLAIM_UP') {
    const qualifies = !staleData && volumeOk && extensionOk && noHardBlockers;
    if (!qualifies) {
      return {
        historicalEdge: 'neutral',
        reasonSv: 'VWAP återtaget uppåt i aktier är historiskt starkare, men här saknas färsk data, volymstöd eller tillräckligt låg extension.',
        suggestedPriorityBias: 'keep',
        source,
      };
    }

    return {
      historicalEdge: 'strong',
      reasonSv: 'VWAP återtaget uppåt har historiskt varit en starkare setup i aktier. Bevaka om 2m fortsätter hålla nivån.',
      suggestedPriorityBias: priority === 'wait'
        ? 'raise_to_watch'
        : priority === 'watch' && isLowFamilyCalibrationRisk({ fakeoutRiskLevel, twoMinuteConflict, candleScore2m })
          ? 'raise_to_caution'
          : 'keep',
      source,
    };
  }

  if (marketType === 'crypto' && signalFamily === 'VWAP_RECLAIM_REJECTION') {
    return {
      historicalEdge: (!volumeOk || isMediumOrExtremeExtension(extensionLevel)) ? 'weak' : 'neutral',
      reasonSv: 'VWAP-lägen i crypto har varit svagare i senaste mätningen. Systemet väntar på tydligare 2m-stöd.',
      suggestedPriorityBias: 'keep',
      source,
    };
  }

  if (signalSubtype === 'EMA_PULLBACK_DOWN') {
    const canAllowWatch = agreementCount >= 5 &&
      dirs.tf2m === 'bearish' &&
      candleDir !== 'bullish' &&
      noHardBlockers;
    const bearishRegime = ['BEARISH_TREND', 'PANIC'].includes(String(marketRegime || '').toUpperCase());
    return {
      historicalEdge: canAllowWatch && bearishRegime ? 'strong' : canAllowWatch ? 'neutral' : 'unknown',
      reasonSv: 'EMA-rekyl nedåt har fungerat bättre än EMA-rekyl uppåt i senaste mätningen.',
      suggestedPriorityBias: canAllowWatch && priority === 'wait' ? 'raise_to_watch' : 'keep',
      source,
    };
  }

  if (signalSubtype === 'EMA_PULLBACK_UP') {
    const requirementsOk = volumeOk &&
      candleDir !== 'bearish' &&
      !isMediumOrExtremeExtension(extensionLevel);
    return requirementsOk
      ? {
          historicalEdge: 'neutral',
          reasonSv: 'EMA-rekyl uppåt kräver starkare volym, 2m-stöd och låg extension i senaste mätningen.',
          suggestedPriorityBias: 'keep',
          source,
        }
      : {
          historicalEdge: 'weak',
          reasonSv: 'EMA-rekyl uppåt var svagare i senaste mätningen och kräver starkare volym, 2m-stöd och lägre extension.',
          suggestedPriorityBias: 'lower',
          source,
        };
  }

  return base;
}

function applyFamilyCalibrationPriority({ priority, decisionTextSv, familyCalibrationHints }) {
  if (!familyCalibrationHints) return { priority, decisionTextSv };
  if (priority === 'avoid') return { priority, decisionTextSv };

  const reasonSv = familyCalibrationHints.reasonSv || decisionTextSv;
  switch (familyCalibrationHints.suggestedPriorityBias) {
    case 'raise_to_watch':
      return priority === 'wait'
        ? { priority: 'watch', decisionTextSv: reasonSv }
        : { priority, decisionTextSv };
    case 'raise_to_caution':
      return priority === 'watch'
        ? { priority: 'caution', decisionTextSv: reasonSv }
        : { priority, decisionTextSv };
    case 'lower':
      return ['active', 'caution', 'watch'].includes(priority)
        ? { priority: 'wait', decisionTextSv: 'EMA-rekyl uppåt kräver starkare volym och tydligare 2m-stöd. Systemet väntar.' }
        : { priority, decisionTextSv };
    default:
      return { priority, decisionTextSv };
  }
}

function updateExplanationConclusion(explanationSv, priority) {
  if (!explanationSv) return;
  explanationSv.conclusion = priority === 'active'
    ? 'Titta manuellt. Jaga inte rörelsen om priset redan stuckit.'
    : priority === 'caution'
      ? 'Nära, men försiktig. Vänta på bättre bekräftelse.'
      : priority === 'watch'
        ? 'Bevaka. Läget kan bli intressant om 2m bekräftar.'
        : priority === 'avoid'
          ? 'Jaga inte rörelsen.'
          : 'Vänta.';
}

function buildBlockers(result, dirs, bias, agreementCount, marketType, timestamp, extensionMeta, twoMinuteConflictMeta, context = {}) {
  const hardBlockers = [];
  const softBlockers = [];
  const twoMinuteConfirmed = hasTwoMinuteConfirmation(dirs, bias);
  const priceToZoneAtr = Number(result.priceToZoneAtr);
  const alignedFastFrames = dirs.tf2m !== 'neutral' && dirs.tf2m === dirs.tf5m && dirs.tf5m === dirs.tf10m;
  const marketClosed = context.marketClosed === true;
  const staleData = marketClosed ? false : isDataStale(timestamp, marketType);

  if (staleData && marketType === 'crypto') hardBlockers.push('Data är gammal');
  else if (staleData) softBlockers.push('Data är gammal');

  if (!twoMinuteConfirmed) softBlockers.push('2m saknar bekräftelse');
  if (twoMinuteConflictMeta?.twoMinuteConflict) softBlockers.push('Senaste 2m-candles säger emot riktningen');
  if (result.fakeoutRiskLevel === 'high') hardBlockers.push('Risken för falskt utbrott är hög');
  const hardPriceExtension = priceToZoneAtr >= PRICE_HARD_ZONE_ATR ||
    (!twoMinuteConfirmed && priceToZoneAtr >= PRICE_HARD_WITHOUT_2M_ATR);

  if (hardPriceExtension) {
    hardBlockers.push('Priset är för långt från bra nivå — jaga inte');
  } else if (result.threeFingerSpread?.active || priceToZoneAtr >= PRICE_SOFT_ZONE_ATR) {
    softBlockers.push('Priset är lite långt från bra nivå');
  }

  if (extensionMeta?.level === 'extreme') {
    hardBlockers.push('Rörelsen är för långt gången — jaga inte');
  } else if (extensionMeta?.level === 'medium') {
    softBlockers.push('Rörelsen är långt gången');
  } else if (extensionMeta?.level === 'mild') {
    softBlockers.push('Rörelsen har gått en bit');
  }

  if ((result.relVol20 || 1) < 0.7) softBlockers.push('Volymen är svag');
  if (result.stateGraph?.currentState === 'CHOPPY') {
    softBlockers.push(agreementCount >= 5 ? 'Marknaden är ryckig trots bra timeframe-stöd' : 'Marknaden är ryckig');
  }
  if (result.mtfStatus === 'CONFLICT') softBlockers.push('Större trend håller inte med');

  if (result.autoFilter?.blocked && hardBlockers.length + softBlockers.length === 0) {
    softBlockers.push('Reglerna blockerar läget');
  }

  return {
    hardBlockers: uniqueLabels(hardBlockers),
    softBlockers: uniqueLabels(softBlockers),
    twoMinuteConfirmed,
    staleData,
  };
}

function buildPlainExplanation(result, { priority, bias, agreementCount, dirs, hardBlockers, softBlockers }) {
  const state = result.stateGraph?.currentState || result.state || 'okänt';
  const signal = result.signal || 'NO_SIGNAL';
  const score = Math.max(result.tradeScore || 0, result.daytradeScore || 0);
  const twoMinuteConfirmed = hasTwoMinuteConfirmation(dirs, bias);
  const largerTrendSupports = agreementCount >= 4 && bias !== 'UNCERTAIN';
  const blockers = [...hardBlockers, ...softBlockers].map(blockerLabel);

  const sees = signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED'
    ? 'Systemet ser en aktiv rörelse på 2m.'
    : state === 'COMPRESSION'
      ? 'Systemet ser ett ihoptryckt läge som kan börja röra sig.'
      : `Systemet ser ${state.toLowerCase()} och väntar på tydligare signal.`;

  const pro = [];
  if (largerTrendSupports) pro.push('Större trend håller med.');
  if (twoMinuteConfirmed) pro.push('2m visar riktning.');
  if (score >= 50) pro.push('Poängen är tillräckligt nära för bevakning.');
  if (!pro.length) pro.push('Det finns visst stöd, men inget tydligt läge ännu.');

  const against = [];
  if (!twoMinuteConfirmed) against.push('2m saknar bekräftelse.');
  if (result.priceToZoneAtr >= PRICE_HARD_ZONE_ATR) against.push('Priset är för långt från bra nivå.');
  else if (result.priceToZoneAtr >= PRICE_SOFT_ZONE_ATR) against.push('Priset är lite långt från bra nivå.');
  if ((result.relVol20 || 1) < 0.7) against.push('Volymen är svag.');
  if (result.fakeoutRiskLevel === 'high') against.push('Risken för falskt utbrott är hög.');
  blockers.forEach((b) => { if (b && !against.includes(b)) against.push(b); });
  if (!against.length) against.push('Ingen stor varning syns just nu.');

  const missing = [];
  if (!twoMinuteConfirmed) missing.push('Tydlig 2m-bekräftelse.');
  if (agreementCount < 4) missing.push('Mer stöd från 1h, 30m, 15m, 10m och 5m.');
  if ((result.relVol20 || 1) < 0.7) missing.push('Starkare volym.');
  if (!missing.length) missing.push('Inget avgörande saknas, men kontrollera grafen manuellt.');

  const conclusion = priority === 'active'
    ? 'Titta manuellt. Jaga inte rörelsen om priset redan stuckit.'
    : priority === 'caution'
      ? 'Nära, men försiktig. Vänta på bättre bekräftelse.'
      : priority === 'watch'
        ? 'Bevaka. Läget kan bli intressant om 2m bekräftar.'
        : priority === 'avoid'
          ? 'Jaga inte rörelsen.'
          : 'Vänta.';

  return {
    sees,
    pro: pro.slice(0, 3),
    against: against.slice(0, 3),
    missing: missing.slice(0, 3),
    conclusion,
  };
}

function buildCandidate(result, options = {}) {
  const timestamp = latestTimestamp(result);
  const marketType = result._market || result.market || (CRYPTO_SUFFIX.test(result.symbol) ? 'crypto' : 'stocks');
  const stockFeedStatus = options.stockFeedStatus || null;
  const marketClosed = isStockMarket(marketType) && stockFeedStatus?.status === 'MARKET_CLOSED';
  const staleData = marketClosed ? false : isDataStale(timestamp, marketType);
  const dataFreshness = marketClosed ? 'MARKET_CLOSED' : staleData ? 'STALE' : 'LIVE';
  const liveCandleDebug = options.liveCandleDebugBySymbol?.[result.symbol] || null;
  const candleScore2m = computeCandleScore2m(liveCandleDebug?.candles || []);
  let dirs = deriveTimeframes(result);
  if (staleData) {
    dirs = {
      tf1h: 'unknown',
      tf30m: 'unknown',
      tf15m: 'unknown',
      tf10m: 'unknown',
      tf5m: 'unknown',
      tf2m: 'unknown',
    };
  }
  const vals = Object.values(dirs);
  const bullCount = vals.filter(v => v === 'bullish').length;
  const bearCount = vals.filter(v => v === 'bearish').length;
  const primaryDir = bullCount > bearCount ? 'bullish' : bearCount > bullCount ? 'bearish' : 'neutral';
  const agreementCount = primaryDir !== 'neutral'
    ? vals.filter(v => v === primaryDir).length
    : 0;

  let bias = marketClosed
    ? 'UNCERTAIN'
    : computeNextMoveBias(result, dirs, { marketType, staleData, candleScore2m });
  const confidenceScore = computeConfidence(result, agreementCount);
  if (bias === 'UP' && dirs.tf2m !== 'bullish') bias = 'UNCERTAIN';
  if (bias === 'DOWN' && dirs.tf2m !== 'bearish') bias = 'UNCERTAIN';

  const extensionMeta = classifyExtension(result, bias, dirs, agreementCount);
  const twoMinuteConflictMeta = buildTwoMinuteConflict(dirs, candleScore2m);
  const blockersMeta = buildBlockers(result, dirs, bias, agreementCount, marketType, timestamp, extensionMeta, twoMinuteConflictMeta, { marketClosed });
  const initialDecision = buildDecisionText(result, bias, agreementCount, dirs, blockersMeta, extensionMeta);
  const guardedDecision = applyExtensionGuard({
    decisionTextSv: initialDecision.text,
    priority: initialDecision.priority,
    extensionMeta,
  });
  let decisionTextSv = guardedDecision.decisionTextSv;
  let priority = guardedDecision.priority;

  const hardBlockers = [...blockersMeta.hardBlockers];
  const softBlockers = [...blockersMeta.softBlockers];
  const watchLayerCandidate = qualifiesForWatchLayer({
    staleData,
    hardBlockers,
    agreementCount,
    dirs,
    candleScore2m,
    extensionMeta,
  });

  if (hardBlockers.length) {
    priority = 'avoid';
  } else if (extensionMeta.level === 'medium' && priority === 'avoid') {
    priority = 'wait';
  } else if (priority === 'active' && (!blockersMeta.twoMinuteConfirmed || blockersMeta.staleData)) {
    priority = 'watch';
  }

  if (priority === 'wait' && watchLayerCandidate) {
    priority = 'watch';
    decisionTextSv = 'Flera tidsramar håller med, men 2m-styrkan är inte tillräckligt tydlig. Bevaka ny 2m-bekräftelse.';
  }

  if (priority !== 'avoid' && candleScoreOpposesTf2m(dirs, candleScore2m)) {
    priority = 'wait';
    decisionTextSv = twoMinuteConflictMeta.twoMinuteConflict
      ? 'Större tidsramar håller med, men senaste 2m-candles säger emot. Vänta på ny 2m-bekräftelse.'
      : '2m bekräftar inte rörelsen ännu.';
  }

  if (priority === 'avoid') {
    decisionTextSv = 'Rörelsen är för långt gången — jaga inte.';
  } else if (twoMinuteConflictMeta.twoMinuteConflict && priority === 'wait') {
    decisionTextSv = 'Större tidsramar håller med, men senaste 2m-candles säger emot. Vänta på ny 2m-bekräftelse.';
  } else if (!blockersMeta.twoMinuteConfirmed) {
    decisionTextSv = '2m bekräftar inte rörelsen ännu.';
  }

  if (marketClosed) {
    if (priority === 'active' || priority === 'caution') priority = 'watch';
    decisionTextSv = 'Marknaden är stängd. Visar senaste handelspass, inte en livebedömning.';
  }

  const signalId = result.signalId || makeSignalId(result.symbol, timestamp);
  const explanationSv = buildPlainExplanation(result, { priority, bias, agreementCount, dirs, hardBlockers, softBlockers });
  if (twoMinuteConflictMeta.twoMinuteConflict) {
    explanationSv.sees = 'Systemet ser trendstöd, men den kortaste 2m-rörelsen har försvagats.';
    explanationSv.against = [
      'Senaste 2m-candles säger emot riktningen.',
      ...explanationSv.against.filter((x) => x !== 'Senaste 2m-candles säger emot riktningen.'),
    ].slice(0, 3);
    explanationSv.missing = [
      'Ny 2m-bekräftelse.',
      ...explanationSv.missing.filter((x) => x !== 'Ny 2m-bekräftelse.'),
    ].slice(0, 3);
    explanationSv.conclusion = 'Vänta. Stark större bild, men kort signal saknas.';
  }
  const timeframes = {
    tf1h: dirs.tf1h,
    tf30m: dirs.tf30m,
    tf15m: dirs.tf15m,
    tf10m: dirs.tf10m,
    tf5m: dirs.tf5m,
    tf2m: dirs.tf2m,
  };
  const cleanHardBlockers = uniqueLabels(hardBlockers);
  const cleanSoftBlockers = uniqueLabels(softBlockers);
  const blockers = uniqueLabels([...cleanHardBlockers, ...cleanSoftBlockers]);
  const fakeoutRiskLevel = result.fakeoutRiskLevel || 'low';
  const familyInput = {
    ...result,
    marketType,
    price: result.price,
    status: priority,
    priority,
    confidenceScore,
    nextMoveBias: bias,
    extensionLevel: extensionMeta.level,
    dataFreshness: marketClosed ? 'STALE' : dataFreshness,
    dataAgeSeconds: result.dataAgeSeconds ?? null,
    fakeoutRiskLevel,
    hardBlockers: cleanHardBlockers,
    softBlockers: cleanSoftBlockers,
    candleScore2m,
    twoMinuteConflict: twoMinuteConflictMeta.twoMinuteConflict,
    timeframeAgreement: timeframes,
    tf1h: timeframes.tf1h,
    tf30m: timeframes.tf30m,
    tf15m: timeframes.tf15m,
    tf10m: timeframes.tf10m,
    tf5m: timeframes.tf5m,
    tf2m: timeframes.tf2m,
    agreementCount,
    vwapDistancePct: result.vwapDistancePct,
    rvol: result.rvol ?? result.relVol20,
    volumeState: result.volumeState,
  };
  const familyClassification = classifySignalFamily(familyInput);
  const familyDebug = options.familyDebug ? buildSignalFamilyDebug(familyInput) : null;
  const signalFamily = familyClassification.signalFamily;
  const signalSubtype = result.signalSubtype || familyClassification.signalSubtype || 'UNKNOWN';
  const priorityBeforeFamilyCalibration = priority;
  const decisionTextBeforeFamilyCalibration = decisionTextSv;
  const familyCalibrationHints = buildFamilyCalibrationHints({
    marketType,
    signalFamily,
    signalSubtype,
    staleData,
    volumeState: result.volumeState || 'unknown',
    extensionLevel: extensionMeta.level,
    hardBlockers: cleanHardBlockers,
    agreementCount,
    dirs,
    candleScore2m,
    fakeoutRiskLevel,
    twoMinuteConflict: twoMinuteConflictMeta.twoMinuteConflict,
    marketRegime: result.marketRegimeV2 || result.marketRegime,
    priority,
  });
  const calibratedDecision = applyFamilyCalibrationPriority({
    priority,
    decisionTextSv,
    familyCalibrationHints,
  });
  priority = calibratedDecision.priority;
  decisionTextSv = calibratedDecision.decisionTextSv;
  const priorityChangedByFamilyCalibration = priority !== priorityBeforeFamilyCalibration;
  if (priorityChangedByFamilyCalibration) {
    updateExplanationConclusion(explanationSv, priority);
  }
  if (marketClosed) {
    if (priority === 'active' || priority === 'caution') priority = 'watch';
    decisionTextSv = 'Marknaden är stängd. Visar senaste handelspass, inte en livebedömning.';
    explanationSv.sees = 'Aktiemarknaden är stängd. Systemet visar senaste handelspass.';
    explanationSv.against = [
      'Ingen livebedömning görs när aktiemarknaden är stängd.',
      ...explanationSv.against.filter((x) => x !== 'Ingen livebedömning görs när aktiemarknaden är stängd.'),
    ].slice(0, 3);
    explanationSv.missing = [
      'Vänta tills marknaden öppnar och dataflödet är live.',
      ...explanationSv.missing.filter((x) => x !== 'Vänta tills marknaden öppnar och dataflödet är live.'),
    ].slice(0, 3);
    updateExplanationConclusion(explanationSv, priority);
  }
  const primaryReason =
    marketClosed ? decisionTextSv :
    cleanHardBlockers[0] ||
    cleanSoftBlockers[0] ||
    (Array.isArray(explanationSv.sees) ? explanationSv.sees[0] : explanationSv.sees) ||
    decisionTextSv ||
    'Systemet väntar på tydligare bekräftelse.';

  return {
    symbol: result.symbol,
    market: marketType,
    price: result.price,
    strategyId: result.strategyId || result.strategy_id || result.setupId || result.sourceStrategyId || null,
    strategy_id: result.strategy_id || result.strategyId || result.setupId || result.sourceStrategyId || null,
    strategyName: result.strategyName || result.strategy_name || null,
    strategy_name: result.strategy_name || result.strategyName || null,
    sourceStrategyId: result.sourceStrategyId || null,
    sourceStrategyName: result.sourceStrategyName || null,
    resolvedStrategyId: result.resolvedStrategyId || result.strategyId || result.strategy_id || result.setupId || null,
    resolvedStrategyName: result.resolvedStrategyName || result.strategyName || result.strategy_name || null,
    mappingSource: result.mappingSource || (result.sourceStrategyId || result.strategyId || result.strategy_id || result.setupId ? 'explicit' : 'unknown'),
    ema9: result.ema9 ?? null,
    ema21: result.ema21 ?? null,
    ema50: result.ema50 ?? null,
    sma20: result.sma20 ?? null,
    sma50: result.sma50 ?? null,
    sma200: result.sma200 ?? null,
    vwap: result.vwap ?? null,
    vwapDistancePct: result.vwapDistancePct ?? null,
    rvol: result.rvol ?? result.relVol20 ?? null,
    volumeState: result.volumeState || 'unknown',
    atr14: result.atr14 ?? null,
    marketRegime: result.marketRegimeV2 || result.marketRegime || null,
    dataFreshness,
    dataAgeSeconds: marketClosed ? stockFeedStatus?.ageSeconds ?? result.dataAgeSeconds ?? null : result.dataAgeSeconds ?? null,
    marketClosed,
    stockFeedStatus: marketClosed ? {
      status: stockFeedStatus.status,
      latestTimestamp: stockFeedStatus.latestTimestamp || stockFeedStatus.lastUpdated || null,
      ageSeconds: stockFeedStatus.ageSeconds ?? null,
      reasonSv: stockFeedStatus.messageSv || 'Marknaden stängd — senaste aktiedata från senaste handelspass.',
    } : null,
    signal: result.signal || 'NO_SIGNAL',
    signalFamily,
    signalSubtype,
    familyLabelSv: signalFamilyLabel(signalFamily),
    subtypeLabelSv: signalSubtypeLabel(signalSubtype),
    signalFamilyReasonSv: familyClassification.reasonSv,
    familyDebugSummarySv: signalFamilyDebugSummarySv(familyDebug, signalFamily),
    ...(familyDebug ? { familyDebug } : {}),
    tradeScore: result.tradeScore || 0,
    daytradeScore: result.daytradeScore || 0,
    confidenceScore,
    nextMoveBias: bias,
    nextMoveBiasLabel: BIAS_LABEL[bias] || BIAS_LABEL.UNCERTAIN,
    decisionTextSv,
    status: priority,
    priority,
    statusBeforeFamilyCalibration: priorityBeforeFamilyCalibration,
    priorityBeforeFamilyCalibration,
    decisionTextBeforeFamilyCalibration,
    priorityChangedByFamilyCalibration,
    familyCalibrationHints,
    primaryReason,
    agreementCount,
    tf1h: timeframes.tf1h,
    tf30m: timeframes.tf30m,
    tf15m: timeframes.tf15m,
    tf10m: timeframes.tf10m,
    tf5m: timeframes.tf5m,
    tf2m: timeframes.tf2m,
    timeframeAgreement: timeframes,
    timeframes,
    stateGraph: {
      state: result.stateGraph?.currentState || 'UNKNOWN',
      explanationSv: result.stateGraph?.explanationSv || '',
      actionableInsight: result.stateGraph?.actionableInsight || '',
    },
    blockers,
    hardBlockers: cleanHardBlockers,
    softBlockers: cleanSoftBlockers,
    riskLevel: fakeoutRiskLevel,
    fakeoutRiskLevel,
    lateMove: guardedDecision.lateMove,
    extensionLevel: extensionMeta.level,
    extensionMeta,
    preMoveContext: result.preMoveContext || null,
    fatigueContext: result.fatigueContext || null,
    crypto_signal_context: result.crypto_signal_context || null,
    crypto_context: result.crypto_context || null,
    explanationSv,
    simpleExplanationSv: explanationSv,
    simpleExplanationTextSv: twoMinuteConflictMeta.twoMinuteConflict
      ? 'Systemet ser trendstöd, men den kortaste 2m-rörelsen har försvagats.'
      : null,
    twoMinuteConflict: twoMinuteConflictMeta.twoMinuteConflict,
    twoMinuteConflictType: twoMinuteConflictMeta.twoMinuteConflictType,
    twoMinuteConflictSv: twoMinuteConflictMeta.twoMinuteConflictSv,
    timestamp,
    signalTimestamp: timestamp,
    lastUpdate: result.lastUpdate || null,
    timeframe: '2m',
    marketType,
    signalId,
    candleScore2m,
  };
}

const CRYPTO_SUFFIX = /USDT$|BUSD$|USD$|BTC$|ETH$/i;

function tagMarket(results, market) {
  return (results || []).map((r) => {
    const tagged = { ...r, _market: market };
    const cryptoContext = buildCryptoSignalContext(tagged);
    if (!cryptoContext) return tagged;
    return {
      ...tagged,
      crypto_signal_context: cryptoContext,
      crypto_context: cryptoContext,
    };
  });
}

function buildDecisionMonitor({ stockResults, cryptoResults, liveCandleDebugBySymbol = {}, familyDebug = false, stockFeedStatus = null }) {
  const tagged = [
    ...tagMarket(stockResults, 'stocks'),
    ...tagMarket(cryptoResults, 'crypto'),
  ];
  const allResults = tagged;
  if (!allResults.length) {
    return {
      ok: true,
      candidates: [],
      summary: {
        total: 0,
        active: 0,
        caution: 0,
        watch: 0,
        wait: 0,
        avoid: 0,
        statusCounts: { active: 0, caution: 0, watch: 0, wait: 0, avoid: 0 },
        blockers: {},
        topBlockers: [],
        hardBlockerCount: 0,
        softBlockerCount: 0,
        twoMinuteConfirmedCount: 0,
        staleOrUnknownCount: 0,
        mildExtensionCount: 0,
        mediumExtensionCount: 0,
        extremeExtensionCount: 0,
        isMostlyAvoid: false,
        strictnessMessageSv: null,
      },
    };
  }

  const candidates = allResults
    .map((result) => buildCandidate(result, { liveCandleDebugBySymbol, familyDebug, stockFeedStatus }))
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 5;
      const pb = PRIORITY_ORDER[b.priority] ?? 5;
      if (pa !== pb) return pa - pb;
      return b.confidenceScore - a.confidenceScore;
    });

  const summary = candidates.reduce((acc, c) => {
    acc.total++;
    acc[c.priority] = (acc[c.priority] || 0) + 1;
    acc.statusCounts[c.status] = (acc.statusCounts[c.status] || 0) + 1;
    acc.hardBlockerCount += (c.hardBlockers || []).length;
    acc.softBlockerCount += (c.softBlockers || []).length;
    if (hasTwoMinuteConfirmation(c.timeframes || {}, c.nextMoveBias)) acc.twoMinuteConfirmedCount++;
    if ((c.blockers || []).some(b => /Data är gammal|Stock feed/.test(b))) acc.staleOrUnknownCount++;
    if (c.extensionLevel === 'mild') acc.mildExtensionCount++;
    if (c.extensionLevel === 'medium') acc.mediumExtensionCount++;
    if (c.extensionLevel === 'extreme') acc.extremeExtensionCount++;
    for (const blocker of [...(c.hardBlockers || []), ...(c.softBlockers || [])]) {
      const label = blockerLabel(blocker);
      acc.blockers[label] = (acc.blockers[label] || 0) + 1;
    }
    return acc;
  }, {
    total: 0,
    active: 0,
    caution: 0,
    watch: 0,
    wait: 0,
    avoid: 0,
    statusCounts: { active: 0, caution: 0, watch: 0, wait: 0, avoid: 0 },
    blockers: {},
    hardBlockerCount: 0,
    softBlockerCount: 0,
    twoMinuteConfirmedCount: 0,
    staleOrUnknownCount: 0,
    mildExtensionCount: 0,
    mediumExtensionCount: 0,
    extremeExtensionCount: 0,
  });

  summary.topBlockers = Object.entries(summary.blockers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => ({ label, count }));
  summary.isMostlyAvoid = summary.total >= 4 && summary.avoid / summary.total >= 0.75;
  summary.strictnessMessageSv = summary.isMostlyAvoid
    ? 'Systemet är försiktigt just nu eftersom de flesta signaler är för utsträckta eller saknar 2m-bekräftelse.'
    : null;

  return { ok: true, candidates, summary };
}

module.exports = { buildDecisionMonitor };
