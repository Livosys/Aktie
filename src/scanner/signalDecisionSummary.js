'use strict';

const STATE_AVOID = new Set(['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID', 'BREAKOUT_ALREADY_OCCURRED', 'NO_TRADE']);
const CRYPTO_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT']);
const READY_THRESHOLD = 60;

function marketOf(result, fallbackGroup) {
  if (fallbackGroup === 'crypto') return 'crypto';
  const symbol = String(result?.symbol || '').toUpperCase();
  return symbol.endsWith('USDT') || CRYPTO_SYMBOLS.has(symbol) ? 'crypto' : 'stocks';
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fakeoutProbability(result) {
  const direct = finite(result?.fakeoutProbability);
  if (direct !== null) return direct;
  const text = (result?.scoreExplanationSv || []).join(' ');
  const match = text.match(/Fakeout-risk [^(]*\((\d+)\/100\)/i);
  return match ? Number(match[1]) : null;
}

function isConfidenceBlocked(result) {
  if (result?.autoFilter?.blocked === true) return true;
  if (result?.confidence?.label === 'Blockerad') return true;
  const text = [
    result?.autoFilter?.reasonSv,
    ...(result?.scoreExplanationSv || []),
  ].filter(Boolean).join(' ');
  return /Signal blockerad av Confidence Engine|hårt blockerad/i.test(text);
}

function hasWatchMode(result) {
  return !!(
    result?.watchMode ||
    result?.momentumWatchMode ||
    result?.liquiditySweepWatchMode ||
    result?.preMoveContext?.preMoveWatchMode
  );
}

function candidateScore(result) {
  return Math.max(
    result?.tradeScore ?? 0,
    result?.daytradeScore ?? 0,
    result?._decision?.signalScore ?? 0,
    result?.priorityScore ?? 0,
  );
}

function hasHardBlock(result, fakeoutHigh) {
  return (
    STATE_AVOID.has(result?.state) ||
    result?.threeFingerSpread?.active === true ||
    result?.tfs?.active === true ||
    result?.tfsActive === true ||
    result?.breakoutAlreadyOccurred === true ||
    fakeoutHigh
  );
}

function isWatchCandidate(result, score, watchMode) {
  return (
    watchMode ||
    score >= 20 ||
    ['Bevaka', 'Intressant'].includes(result?.daytradeStatus) ||
    candidateScore(result) >= 45
  );
}

function isDataStale(result, now) {
  const lastUpdate = result?.lastUpdate ? new Date(result.lastUpdate).getTime() : null;
  return Number.isFinite(lastUpdate) && now - lastUpdate > 10 * 60 * 1000;
}

function hasDataWarning(result, now = Date.now()) {
  if (!result?.price) return true;
  if (isDataStale(result, now)) return true;
  return finite(result?.candleCount) !== null && Number(result.candleCount) < 40;
}

function classifySignal(result, now = Date.now()) {
  if (hasDataWarning(result, now)) return 'DATA_WARNING';

  const score = result.tradeScore ?? 0;
  const cfBlocked = isConfidenceBlocked(result);
  const fakeout = fakeoutProbability(result);
  const fakeoutHigh = result.fakeoutRiskLevel === 'high' || (fakeout !== null && fakeout >= 70);
  const hardBlocked = hasHardBlock(result, fakeoutHigh);
  const watchMode = hasWatchMode(result);

  if (!cfBlocked && !hardBlocked && score >= 60) return 'READY';
  if (!hardBlocked && isWatchCandidate(result, score, watchMode)) return 'WATCH';
  if (cfBlocked || hardBlocked) return 'BLOCKED';
  return 'NO_SIGNAL';
}

function hardBlockers(result, now = Date.now()) {
  const out = [];
  const fakeout = fakeoutProbability(result);
  if (!result?.price) out.push('DATA: missing price');
  else if (isDataStale(result, now)) out.push('DATA: stale >10m');
  else if (finite(result?.candleCount) !== null && Number(result.candleCount) < 40) out.push('DATA: missing candles');
  if (result?.threeFingerSpread?.active === true || result?.tfs?.active === true || result?.tfsActive === true || result?.state === 'THREE_FINGER_SPREAD_AVOID') out.push('Three Finger Spread');
  if (result?.state === 'WIDE_AVOID') out.push('WIDE_AVOID');
  if (result?.state === 'NO_TRADE') out.push('NO_TRADE');
  if (result?.breakoutAlreadyOccurred === true || result?.state === 'BREAKOUT_ALREADY_OCCURRED') out.push('breakout already occurred');
  if (result?.fakeoutRiskLevel === 'high' || (fakeout !== null && fakeout >= 70)) out.push('fakeout high');
  return [...new Set(out)];
}

function softBlockers(result) {
  const out = [];
  const priceToZoneAtr = finite(result?.priceToZoneAtr);
  const relVol20 = finite(result?.relVol20);
  if (isConfidenceBlocked(result)) out.push('Confidence Engine');
  if (priceToZoneAtr !== null && priceToZoneAtr > 1.5) out.push('price extended');
  if (relVol20 !== null && relVol20 < 0.7) out.push('low liquidity');
  if (result?.marketRegimeV2 === 'HIGH_VOLATILITY' || result?.marketRegime === 'HIGH_VOLATILITY') out.push('market state filter');
  if (['CHOPPY', 'RANGE_DAY'].includes(result?.marketRegimeV2) || ['CHOPPY', 'RANGE_DAY'].includes(result?.marketRegime)) out.push('choppy market');
  if (['conflicting', 'full_conflict'].includes(result?.mtfAlignment)) out.push('MTF conflict');
  return [...new Set(out)];
}

function warnings(result) {
  const out = [];
  const fakeout = fakeoutProbability(result);
  if (result?.mtfAlignment === 'mixed') out.push('MTF mixed');
  if (fakeout !== null && fakeout >= 55 && fakeout < 70) out.push(`fakeout elevated ${fakeout}`);
  if (result?.decayContext?.stale) out.push('Signalens kvalitet har svalnat');
  if (Array.isArray(result?.daytradeWarnings)) {
    for (const warning of result.daytradeWarnings) {
      const text = String(warning || '').trim();
      if (!text) continue;
      if (/Signal blockerad av Confidence Engine|Three Finger Spread|autoFilter|Volymen är för låg|låg volym|Volymen räcker inte|price extended|Priset är för långt|Datan är gammal/i.test(text)) continue;
      out.push(text.length > 80 ? `${text.slice(0, 77)}...` : text);
      if (out.length >= 4) break;
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function capsApplied(result) {
  const out = [];
  let tfsCap = null;
  const confidenceBlockers = Array.isArray(result?.confidence?.blockers) ? result.confidence.blockers : [];
  for (const blocker of confidenceBlockers) {
    if (blocker?.hardCap !== null && blocker?.hardCap !== undefined) {
      if (blocker.reason === 'threeFingerSpread') {
        tfsCap = { rule: 'Three Finger Spread', cap: blocker.hardCap, source: 'Confidence Engine' };
      } else {
        out.push({
          rule: blocker.reason || 'confidence hard cap',
          cap: blocker.hardCap,
          source: 'Confidence Engine',
        });
      }
    }
  }
  if (result?.autoFilter?.blocked === true) {
    out.push({ rule: 'autoFilter.blocked', cap: 20, source: 'Learning Orchestrator safety cap' });
  }
  if (result?.threeFingerSpread?.active === true || result?.tfs?.active === true || result?.tfsActive === true) {
    tfsCap = {
      rule: 'Three Finger Spread',
      cap: tfsCap?.cap ?? 10,
      source: 'Confidence Engine + Learning Orchestrator',
      noteSv: 'Three Finger Spread cap 10, återapplicerad efter learning',
    };
  }
  if (result?.breakoutAlreadyOccurred === true) {
    out.push({ rule: 'breakout already occurred', cap: 20, source: 'Learning Orchestrator safety cap' });
  }
  if (tfsCap) out.unshift(tfsCap);
  return out;
}

function scoreLimiters(result) {
  const out = [];
  const confidenceBlockers = Array.isArray(result?.confidence?.blockers) ? result.confidence.blockers : [];
  for (const blocker of confidenceBlockers) {
    if (finite(blocker?.amount) !== null && Number(blocker.amount) < 0) {
      out.push({
        rule: blocker.reason || blocker.labelSv || 'confidence penalty',
        amount: Number(blocker.amount),
        source: 'Confidence Engine',
      });
    }
  }
  const adjustments = [
    ['MTF', result?.mtfAdjustment],
    ['momentum continuation', result?.momentumContinuationAdjustment],
    ['score calibration', result?.calibratedScoreAdjustment],
    ['fakeout DNA', result?.fakeoutScoreAdjustment],
    ['rule memory', result?.ruleMemory?.adjustment],
    ['adaptive edge', result?.adaptiveEdge?.adjustment],
    ['setup DNA', result?.setupDNA?.scoreAdjustment],
  ];
  for (const [rule, value] of adjustments) {
    const amount = finite(value);
    if (amount !== null && amount < 0) out.push({ rule, amount, source: 'learning/analysis' });
  }
  return out.sort((a, b) => a.amount - b.amount);
}

function buildReadyGap(result, status, now = Date.now()) {
  const tradeScore = result?.tradeScore ?? 0;
  const daytradeScore = result?.daytradeScore ?? null;
  const candidate = candidateScore(result);
  const hard = hardBlockers(result, now);
  const soft = softBlockers(result);
  const warn = warnings(result);
  const caps = capsApplied(result);
  const limiters = scoreLimiters(result);
  const missingScore = Math.max(0, READY_THRESHOLD - tradeScore);
  const rulesRemaining = hard.length + soft.length + (missingScore > 0 ? 1 : 0);
  const hardBlocked = hard.length > 0;
  return {
    symbol: result?.symbol,
    status,
    candidateScore: candidate,
    daytradeScore,
    tradeScore,
    readyThreshold: READY_THRESHOLD,
    missingScore,
    hardBlockers: hard,
    softBlockers: soft,
    warnings: warn,
    capsApplied: caps,
    biggestScoreLimiter: limiters[0] || null,
    rulesRemaining,
    label: status === 'READY'
      ? 'READY'
      : hardBlocked
        ? 'Hard block — ska inte jagas'
        : rulesRemaining <= 2
          ? 'Nära READY'
          : 'Soft block — bevaka om marknaden förbättras',
    closestToReadyRank: null,
  };
}

function compareReadyGap(a, b) {
  const ar = a.readyGap;
  const br = b.readyGap;
  return (
    ar.hardBlockers.length - br.hardBlockers.length ||
    br.tradeScore - ar.tradeScore ||
    ar.softBlockers.length - br.softBlockers.length ||
    br.candidateScore - ar.candidateScore ||
    ar.missingScore - br.missingScore
  );
}

function failedRules(result) {
  const out = [];
  const score = result?.tradeScore ?? 0;
  const baseScore = finite(result?.tradeScoreBeforeConfidence ?? result?.confidence?.baseTradeScore ?? result?.scores?.finalScore);
  const priceToZoneAtr = finite(result?.priceToZoneAtr);
  const relVol20 = finite(result?.relVol20);
  const fakeout = fakeoutProbability(result);
  const explanations = (result?.scoreExplanationSv || []).join(' ');
  const reasons = (result?.reasonSv || []).join(' ');

  if (isConfidenceBlocked(result)) out.push('Confidence Engine');
  if (result?.threeFingerSpread?.active === true || result?.tfsActive === true || result?.state === 'THREE_FINGER_SPREAD_AVOID') out.push('Three Finger Spread');
  if (priceToZoneAtr !== null && priceToZoneAtr > 1.5) out.push('price extended');
  if (['conflicting', 'full_conflict'].includes(result?.mtfAlignment) || /MTF.*(konflikt|går emot|varnar)/i.test(explanations)) out.push('MTF conflict');
  if (result?.fakeoutRiskLevel === 'high' || (fakeout !== null && fakeout >= 70)) out.push('fakeout risk');
  if (['CHOPPY', 'RANGE_DAY'].includes(result?.marketRegimeV2) || ['CHOPPY', 'RANGE_DAY'].includes(result?.marketRegime) || /choppy|stökig|sidled/i.test(`${explanations} ${reasons}`)) out.push('choppy market');
  if ((relVol20 !== null && relVol20 < 0.7) || /Volymen är för svag|Låg relVol/i.test(explanations)) out.push('low liquidity');
  if ((finite(result?.candleCount) !== null && Number(result.candleCount) < 40) || /Not enough|Otillräcklig data/i.test(`${result?.note || ''} ${explanations}`)) out.push('missing candles');
  if (result?.marketRegimeV2 === 'HIGH_VOLATILITY' || result?.marketRegime === 'HIGH_VOLATILITY' || /Marknaden är för skakig|Hög volatilitet/i.test(explanations)) out.push('market state filter');
  if (result?.breakoutAlreadyOccurred === true || result?.state === 'BREAKOUT_ALREADY_OCCURRED') out.push('breakout already occurred');
  if (result?.state === 'WIDE_AVOID') out.push('WIDE_AVOID state');
  if (result?.state === 'NO_TRADE') out.push('NO_TRADE state');
  if (score < 60 && baseScore !== null && baseScore >= 60) out.push('score lowered after initial pass');

  return [...new Set(out)];
}

function passedRules(result) {
  const fakeout = fakeoutProbability(result);
  return [
    !isConfidenceBlocked(result) && 'confidence',
    !STATE_AVOID.has(result?.state) && 'state',
    !(result?.threeFingerSpread?.active === true || result?.tfsActive === true) && 'noThreeFingerSpread',
    result?.breakoutAlreadyOccurred !== true && 'notAlreadyBrokenOut',
    !(result?.fakeoutRiskLevel === 'high' || (fakeout !== null && fakeout >= 70)) && 'fakeoutRisk',
    (result?.tradeScore ?? 0) >= 60 && 'score>=60',
  ].filter(Boolean);
}

function wouldBeReadyIfRelaxedRules(result, failed) {
  const score = result?.tradeScore ?? 0;
  const relaxed = [];
  if (score >= 60 && failed.length === 1) relaxed.push(`remove ${failed[0]}`);
  if (score >= 55 && failed.length === 0) relaxed.push('score threshold 55');
  if (score >= 55 && failed.length === 1) relaxed.push(`score threshold 55 + remove ${failed[0]}`);
  if (score >= 50 && failed.length <= 1) relaxed.push('READY_LITE');
  return relaxed;
}

function buildSignalDecisionSummary(results, options = {}) {
  const now = options.now || Date.now();
  const group = options.group || 'all';
  const rows = (results || []).map((result) => {
    const failed = failedRules(result);
    const status = classifySignal(result, now);
    const readyGap = buildReadyGap(result, status, now);
    return {
      symbol: result.symbol,
      market: marketOf(result, group),
      score: result.tradeScore ?? 0,
      status,
      candidateScore: readyGap.candidateScore,
      daytradeScore: readyGap.daytradeScore,
      tradeScore: readyGap.tradeScore,
      readyGap,
      passedRules: passedRules(result),
      failedRules: failed,
      finalReason: failed[0] || (status === 'READY' ? 'READY: score>=60 and no hard blockers' : 'No READY score'),
      wouldBeReadyIfRelaxedRules: wouldBeReadyIfRelaxedRules(result, failed),
      details: {
        state: result.state,
        signal: result.signal,
        mtfAlignment: result.mtfAlignment,
        fakeoutProbability: fakeoutProbability(result),
        relVol20: result.relVol20 ?? null,
        priceToZoneAtr: result.priceToZoneAtr ?? null,
        confidenceLabel: result.confidence?.label ?? null,
        confidenceBase: result.confidence?.baseTradeScore ?? null,
        confidenceFinal: result.confidence?.finalTradeScore ?? null,
        daytradeScore: result.daytradeScore ?? null,
        daytradeStatus: result.daytradeStatus ?? null,
        candidateScore: candidateScore(result),
      },
    };
  });
  [...rows].sort(compareReadyGap).forEach((row, idx) => {
    row.readyGap.closestToReadyRank = idx + 1;
  });
  return rows;
}

module.exports = {
  buildSignalDecisionSummary,
  classifySignal,
  failedRules,
  buildReadyGap,
};
