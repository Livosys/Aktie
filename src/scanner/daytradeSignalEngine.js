'use strict';

const TARGET_MIN_PCT = 1;
const TARGET_MAX_PCT = 2;
const MIN_RELVOL_FOR_INTEREST = 1.3;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const f = 10 ** d;
  return Math.round(Number(v) * f) / f;
}

function finite(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function ageMinutes(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 60000);
}

function directionFromResult(r) {
  if (r?.momentumBias === 'bullish') return 'up';
  if (r?.momentumBias === 'bearish') return 'down';
  if (r?.signal?.startsWith('LONG')) return 'up';
  if (r?.signal?.startsWith('SHORT')) return 'down';
  if (r?.elephantBar?.direction === 'bullish') return 'up';
  if (r?.elephantBar?.direction === 'bearish') return 'down';
  if (r?.positionCode === 'above_both' || r?.positionCode === 'extended_above') return 'up';
  if (r?.positionCode === 'below_both' || r?.positionCode === 'extended_below') return 'down';
  if (r?.marketDirection === 'bullish') return 'up';
  if (r?.marketDirection === 'bearish') return 'down';
  return 'neutral';
}

function referencePrice(r, direction) {
  const price = finite(r?.price);
  if (!price || price <= 0) return null;

  const explicit = finite(r?.dayOpen ?? r?.open ?? r?.sessionOpen ?? r?.prevClose ?? r?.previousClose ?? r?.referencePrice);
  if (explicit && explicit > 0) return explicit;

  const trigger = direction === 'up' ? finite(r?.longTrigger) : direction === 'down' ? finite(r?.shortTrigger) : null;
  if (trigger && trigger > 0) return trigger;

  const sma20 = finite(r?.sma20);
  if (sma20 && sma20 > 0) return sma20;

  return null;
}

function currentMovePct(r, direction) {
  const price = finite(r?.price);
  const ref = referencePrice(r, direction);
  if (!price || !ref) return null;
  const rawPct = ((price - ref) / ref) * 100;
  if (direction === 'down') return round(-Math.abs(rawPct), 2);
  if (direction === 'up') return round(Math.abs(rawPct), 2);
  return round(rawPct, 2);
}

function buildTargetMove(direction, movePct) {
  const absMove = movePct === null ? null : Math.abs(movePct);
  const targetWindowOpen = direction !== 'neutral' && (absMove === null || absMove <= TARGET_MAX_PCT);
  let remainingToTargetPct = null;

  if (direction !== 'neutral' && absMove !== null) {
    const remainingAbs = Math.max(0, TARGET_MIN_PCT - absMove);
    remainingToTargetPct = round(direction === 'down' ? -remainingAbs : remainingAbs, 2);
  }

  return {
    direction,
    currentMovePct: movePct,
    targetMinPct: TARGET_MIN_PCT,
    targetMaxPct: TARGET_MAX_PCT,
    remainingToTargetPct,
    targetWindowOpen,
  };
}

function scoreMomentum(r, direction, reasons) {
  const m = finite(r?.momentumContinuationScore);
  const triggerScore = finite(r?.scores?.triggerScore);
  let score = m !== null
    ? (m / 100) * 25
    : triggerScore !== null
      ? (triggerScore / 100) * 20
      : (finite(r?.tradeScore) ?? 0) >= 60
        ? 14
        : 6;
  const alignedBias = (direction === 'up' && r?.momentumBias === 'bullish') ||
    (direction === 'down' && r?.momentumBias === 'bearish');
  if (alignedBias) score += 3;
  if (r?.elephantBarActive || r?.elephantBar?.active) score += 3;
  if (score >= 16) reasons.push(`Momentum visar tidig fart ${direction === 'down' ? 'nedåt' : 'uppåt'}`);
  return clamp(Math.round(score), 0, 25);
}

function scoreVolume(r, reasons, warnings) {
  const relVol = finite(r?.relVol20);
  if (relVol === null) {
    const volumeScore = finite(r?.scores?.volumeScore);
    return volumeScore !== null ? clamp(Math.round((volumeScore / 100) * 20), 0, 20) : 8;
  }
  let score;
  if (relVol >= 2.0) score = 20;
  else if (relVol >= 1.5) score = 17;
  else if (relVol >= 1.15) score = 14;
  else if (relVol >= 0.9) score = 10;
  else if (relVol >= 0.7) score = 6;
  else score = 2;

  if (relVol >= 1.0) reasons.push('Volymen stödjer rörelsen');
  if (relVol < 0.7) warnings.push('Volymen är för låg');
  return score;
}

function scoreMtf(r, warnings, reasons) {
  const mtf = r?.mtfAlignment || 'neutral';
  if (mtf === 'confirmed') {
    reasons.push('Flera korta tidsramar håller med');
    return 20;
  }
  if (mtf === 'aligned') {
    reasons.push('Flera korta tidsramar håller med');
    return 16;
  }
  if (mtf === 'mixed') return 9;
  if (mtf === 'conflicting') {
    warnings.push('MTF-konflikt sänker signalen');
    return 3;
  }
  if (mtf === 'full_conflict') {
    warnings.push('Stark MTF-konflikt');
    return 0;
  }
  const mtfScore = finite(r?.mtfScore);
  if (mtfScore !== null) return clamp(Math.round((mtfScore / 100) * 20), 0, 20);
  if ((directionFromResult(r) === 'up' && r?.marketDirection === 'bullish') ||
      (directionFromResult(r) === 'down' && r?.marketDirection === 'bearish')) {
    return 12;
  }
  if ((directionFromResult(r) === 'up' && r?.marketDirection === 'bearish') ||
      (directionFromResult(r) === 'down' && r?.marketDirection === 'bullish')) {
    warnings.push('Marknadsriktningen går emot signalen');
    return 4;
  }
  return 8;
}

function scoreRisk(r, warnings) {
  const fakeout = finite(r?.fakeoutProbability);
  const highFakeout = r?.fakeoutRiskLevel === 'high' || (fakeout !== null && fakeout >= 70);
  if (highFakeout) {
    warnings.push('Risk för falsk rörelse är förhöjd');
    return 0;
  }
  if (r?.autoFilter?.blocked) {
    warnings.push(r.autoFilter.reasonSv || 'Signal blockerad av filter');
    return 2;
  }
  if (r?.tfsActive || r?.breakoutAlreadyOccurred) {
    warnings.push('Rörelsen kan redan vara sen eller utsträckt');
    return 3;
  }
  if (fakeout !== null) return clamp(Math.round(15 - (fakeout / 100) * 15), 0, 15);
  const riskScore = finite(r?.scores?.riskScore);
  if (riskScore !== null) return clamp(Math.round((riskScore / 100) * 15), 0, 15);
  return 9;
}

function scoreTrend(r, direction, reasons) {
  const price = finite(r?.price);
  const sma20 = finite(r?.sma20);
  const sma200 = finite(r?.sma200);
  let score = 4;
  if (price && sma20) {
    if (direction === 'up' && price > sma20) score += 3;
    if (direction === 'down' && price < sma20) score += 3;
  }
  if (price && sma200) {
    if (direction === 'up' && price > sma200) score += 3;
    if (direction === 'down' && price < sma200) score += 3;
  }
  if ((direction === 'up' && r?.marketDirection === 'bullish') ||
      (direction === 'down' && r?.marketDirection === 'bearish')) score += 2;
  if (score >= 8) reasons.push('Trenden stödjer riktningen');
  return clamp(score, 0, 10);
}

function scoreHistory(r, reasons) {
  const edge = r?.historicalEdge || {};
  const wr = finite(edge.winRate);
  const samples = finite(edge.sampleSize);
  const adjustment = finite(edge.adjustment) || 0;
  let score = 4;
  if (samples !== null && samples >= 30 && wr !== null) {
    if (wr >= 0.58) score = 10;
    else if (wr >= 0.53) score = 8;
    else if (wr >= 0.50) score = 6;
    else if (wr >= 0.45) score = 3;
    else score = 1;
  } else if (adjustment > 0) {
    score = 6;
  } else if ((r?.scoreExplanationSv || []).some((x) => /historik|historiska|träff/i.test(String(x)))) {
    score = 6;
  }
  if (score >= 6) reasons.push('Historiken ger visst stöd');
  return clamp(score, 0, 10);
}

function statusFromScore(score) {
  if (score >= 75) return 'Bekräftad';
  if (score >= 60) return 'Intressant';
  if (score >= 40) return 'Bevaka';
  return 'Undvik';
}

function capStatus(status, maxStatus) {
  const order = ['Undvik', 'Bevaka', 'Intressant', 'Bekräftad'];
  if (status === 'Hög risk') return status;
  return order.indexOf(status) > order.indexOf(maxStatus) ? maxStatus : status;
}

function riskLabel(r, scoreRiskComponent) {
  if (r?.fakeoutRiskLevel === 'high' || (finite(r?.fakeoutProbability) ?? 0) >= 70) return 'high';
  if (r?.autoFilter?.blocked || scoreRiskComponent <= 5) return 'high';
  if (scoreRiskComponent <= 10) return 'medium';
  return 'low';
}

function buildDaytradeSignal(input) {
  const r = input || {};
  const reasons = [];
  const warnings = [];
  const direction = directionFromResult(r);
  const movePct = currentMovePct(r, direction);
  const targetMove = buildTargetMove(direction, movePct);

  const stale = r?.daytradeIgnoreStale !== true &&
    (r?.decayContext?.stale === true || (ageMinutes(r?.lastUpdate) ?? 0) > 10);
  if (stale) warnings.push('Datan är gammal');

  const momentum = scoreMomentum(r, direction, reasons);
  const volume = scoreVolume(r, reasons, warnings);
  const mtf = scoreMtf(r, warnings, reasons);
  const risk = scoreRisk(r, warnings);
  const trend = scoreTrend(r, direction, reasons);
  const history = scoreHistory(r, reasons);

  const components = { momentum, volume, mtf, risk, trend, history };
  let daytradeScore = clamp(momentum + volume + mtf + risk + trend + history, 0, 100);

  if (['conflicting', 'full_conflict'].includes(r?.mtfAlignment)) {
    daytradeScore = clamp(daytradeScore - (r.mtfAlignment === 'full_conflict' ? 12 : 8), 0, 100);
  }

  const absMove = movePct === null ? null : Math.abs(movePct);
  const isTooLate = absMove !== null && absMove > TARGET_MAX_PCT;
  const isEarlyMove = absMove !== null && absMove >= 0.3 && absMove <= 0.8 && momentum >= 15 && volume >= 10;

  if (isEarlyMove) reasons.push('Rörelsen är tidig i målzonen');
  if (isTooLate) warnings.push('Rörelsen kan redan vara sen');
  if (direction === 'neutral') warnings.push('Riktningen är inte tydlig');
  if ((direction === 'up' && r?.signal?.startsWith('SHORT')) ||
      (direction === 'down' && r?.signal?.startsWith('LONG'))) {
    warnings.push('Daytrade-riktningen skiljer sig från Narrow-signalen');
  }

  const highFakeout = r?.fakeoutRiskLevel === 'high' || (finite(r?.fakeoutProbability) ?? 0) >= 70;
  const relVolForCap = finite(r?.relVol20);
  const weakVolume = (relVolForCap ?? 1) < 0.7;
  const insufficientVolumeForInterest = relVolForCap !== null && relVolForCap < MIN_RELVOL_FOR_INTEREST;

  let daytradeStatus = statusFromScore(daytradeScore);
  if (highFakeout) daytradeStatus = daytradeScore >= 60 ? 'Hög risk' : capStatus(daytradeStatus, 'Bevaka');
  if (insufficientVolumeForInterest) {
    if (!weakVolume) warnings.push('Volymen räcker inte för bekräftad daytrade-signal');
    daytradeStatus = capStatus(daytradeStatus, 'Bevaka');
  }
  if (stale) daytradeStatus = 'Undvik';
  if (isTooLate && daytradeStatus === 'Bekräftad') daytradeStatus = 'Intressant';

  return {
    daytradeScore,
    daytradeStatus,
    daytradeDirection: direction,
    daytradeRisk: riskLabel(r, risk),
    isEarlyMove,
    isTooLate,
    targetMove,
    daytradeReasons: [...new Set(reasons)].slice(0, 6),
    daytradeWarnings: [...new Set(warnings)].slice(0, 6),
    components,
  };
}

module.exports = { buildDaytradeSignal };
