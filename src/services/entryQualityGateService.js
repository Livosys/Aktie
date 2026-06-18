'use strict';

const QUALITY_PASSTHRU_LIMIT = 0.02;
const QUALITY_DIRECT_ADVERSE_LIMIT = 0.03;
const CHOPPY_NEARBY_BLOCKED_LIMIT = 2;

function text(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeTradeLike(trade = {}) {
  const raw = trade.raw || trade;
  const tradeStats = trade.tradeStats || {
    mfePct: num(raw.mfePct ?? raw.maxFavorablePct ?? raw.max_favorable_pct ?? null),
    maePct: num(raw.maePct ?? raw.maxAdversePct ?? raw.max_adverse_pct ?? null),
    highestPriceDuringTrade: num(raw.highestPriceDuringTrade ?? raw.highest_price_during_trade ?? null),
    lowestPriceDuringTrade: num(raw.lowestPriceDuringTrade ?? raw.lowest_price_during_trade ?? null),
    stopLoss: num(raw.stopLoss ?? raw.stop_loss ?? raw.stopPct ?? raw.stop_pct ?? null),
    takeProfit: num(raw.takeProfit ?? raw.take_profit ?? raw.targetPct ?? raw.target_pct ?? null),
  };

  return {
    tradeId: text(trade.tradeId || raw.tradeId || raw.id || raw.signalId || null),
    symbol: text(trade.symbol || raw.symbol || null),
    strategyId: text(trade.strategyId || trade.strategy_id || raw.strategyId || raw.strategy_id || raw.canonicalStrategyId || raw.canonical_strategy_id || raw.resolvedStrategyId || raw.resolved_strategy_id || raw.setup || null),
    setup: text(trade.setup || raw.setup || raw.entrySetup || raw.entry_setup || null),
    result: text(trade.result || raw.result || raw.outcome || null, 'unknown'),
    pnlPct: num(trade.pnlPct ?? raw.pnlPct ?? raw.pnl_pct ?? raw.pnl),
    openedAt: text(trade.openedAt || raw.openedAt || raw.opened_at || null),
    closedAt: text(trade.closedAt || raw.closedAt || raw.closed_at || null),
    tradeStats,
    raw,
  };
}

function pushMissing(bucket, ...fields) {
  for (const field of fields) {
    if (field) bucket.add(field);
  }
}

function evidenceText(...parts) {
  return parts.map((part) => text(part, '')).filter(Boolean).join(' | ');
}

function isLateEntryHint(reasonText) {
  const value = String(reasonText || '').toLowerCase();
  return /rörelsen har gått en bit|rorelsen har gatt en bit|bevaka rekyl|ny 2m-bekräftelse|ny 2m-bekraftelse|2m[- ]bekräftelse|2m[- ]bekraftelse|extended|late entry|sent entry/.test(value);
}

function isTwoMinuteHint(reasonText) {
  const value = String(reasonText || '').toLowerCase();
  return /2m|two minute|two-minute|bekräftelse|bekraftelse|confirmation/.test(value);
}

function isStopRelated(exitReasonText, exitTypeText) {
  const value = evidenceText(exitReasonText, exitTypeText).toLowerCase();
  return /stop_hit|stop_loss|trailing_stop|tightened_stop|break_even|breakeven|stop/i.test(value);
}

function isBlockedLikeEvent(event = {}) {
  const value = evidenceText(event.type, event.reason, event.status, event.blockedReason, event.blocked_reason, event.message).toLowerCase();
  return /block|blocked|skip|skipp|allowlist|candidate_filter|reject|choppy|hold/.test(value);
}

function buildRecommendation(type, title, description) {
  return {
    type,
    title,
    description,
    safeActionOnly: true,
  };
}

function finalizeCheck({ status, reason, evidence, missingFields }) {
  return {
    status,
    reason,
    evidence,
    missingFields: unique(missingFields),
  };
}

function buildEntryQualityGate({ trade = {}, explanation = {}, events = [] } = {}) {
  const normalizedTrade = normalizeTradeLike(trade);
  const raw = normalizedTrade.raw || trade || {};
  const entry = explanation.entry || {};
  const exit = explanation.exit || {};
  const diagnosis = explanation.diagnosis || {};
  const nearbyEvents = Array.isArray(explanation.nearbyEvents)
    ? explanation.nearbyEvents
    : Array.isArray(events)
      ? events
      : [];
  const tradeStats = explanation.tradeStats || diagnosis.tradeStats || normalizedTrade.tradeStats || {};
  const result = String(normalizedTrade.result || raw.result || '').trim().toUpperCase();
  const missing = new Set();
  const recommendations = [];

  const entryReason = text(
    raw.entryReason
    || raw.entryReasonSv
    || raw.entry_reason
    || entry.reason
    || entry.explanation
    || null,
  );
  const statusAtEntry = text(
    raw.statusAtEntry
    || raw.runtime_status
    || raw.runtimeStatus
    || entry.status
    || null,
    'unknown',
  );
  const nextMoveBias = text(raw.nextMoveBias || raw.bias || entry.bias || null, 'unknown');
  const confidenceScore = num(raw.confidenceScore ?? raw.gateScore ?? entry.confidence ?? null);
  const gateScore = num(raw.gateScore ?? raw.confidenceScore ?? entry.signalStrength ?? null);
  const gateThreshold = num(raw.gateThreshold ?? raw.gateDecision?.threshold ?? null);
  const setup = text(normalizedTrade.setup || entry.setup || null, 'unknown');
  const mfePct = num(tradeStats.mfePct ?? raw.mfePct ?? raw.maxFavorablePct ?? raw.max_favorable_pct ?? null);
  const maePct = num(tradeStats.maePct ?? raw.maePct ?? raw.maxAdversePct ?? raw.max_adverse_pct ?? null);
  const stopLoss = num(tradeStats.stopLoss ?? raw.stopLoss ?? raw.stop_loss ?? raw.stopPct ?? raw.stop_pct ?? null);
  const takeProfit = num(tradeStats.takeProfit ?? raw.takeProfit ?? raw.take_profit ?? raw.targetPct ?? raw.target_pct ?? null);
  const exitReason = text(raw.exitReason || raw.exitReasonCode || exit.reason || exit.explanation || null, '');
  const exitReasonCode = text(raw.exitReasonCode || exit.reason || null, '');
  const exitType = text(exit.exitType || raw.exitType || null, 'unknown');
  const exitSource = text(raw.exitSource || exit.exitSource || null, 'unknown');
  const nearbyBlockedCount = nearbyEvents.filter((event) => isBlockedLikeEvent(event)).length;
  const nearbyRelevantCount = nearbyEvents.length;

  const lateReasonHint = isLateEntryHint(evidenceText(entryReason, setup, raw.entryReasonSv, raw.entryReason, entry.reason));
  const twoMinuteHint = isTwoMinuteHint(evidenceText(entryReason, setup, raw.entryReasonSv, raw.entryReason, entry.reason));
  const cautionHint = String(statusAtEntry || '').toLowerCase() === 'caution';
  const lossHint = result === 'LOSS';
  const extendedHint = Number.isFinite(mfePct) && Math.abs(mfePct) <= QUALITY_PASSTHRU_LIMIT && Number.isFinite(maePct) && maePct < 0;
  const adverseDirectHint = Number.isFinite(maePct) && maePct < 0 && (!Number.isFinite(mfePct) || Math.abs(mfePct) <= QUALITY_PASSTHRU_LIMIT);
  const stopHit = isStopRelated(exitReason, exitType);
  const stopLossTight = Number.isFinite(stopLoss) && Number.isFinite(maePct) && Math.abs(maePct) >= stopLoss;
  const stopHasMove = Number.isFinite(mfePct) && mfePct > 0;

  if (!entryReason) pushMissing(missing, 'entryReason');
  if (!statusAtEntry || statusAtEntry === 'unknown') pushMissing(missing, 'statusAtEntry');
  if (!Number.isFinite(confidenceScore)) pushMissing(missing, 'confidenceScore');
  if (!Number.isFinite(gateScore)) pushMissing(missing, 'gateScore');
  if (!Number.isFinite(gateThreshold) && raw.gateThreshold == null) pushMissing(missing, 'gateThreshold');
  if (!Number.isFinite(mfePct)) pushMissing(missing, 'maxFavorablePct', 'mfePct');
  if (!Number.isFinite(maePct)) pushMissing(missing, 'maxAdversePct', 'maePct');
  if (!Number.isFinite(stopLoss)) pushMissing(missing, 'stopLoss');
  if (!Number.isFinite(takeProfit)) pushMissing(missing, 'takeProfit');
  if (!exitReason) pushMissing(missing, 'exitReason');
  if (!exitReasonCode) pushMissing(missing, 'exitReasonCode');
  if (!exitSource || exitSource === 'unknown') pushMissing(missing, 'exitSource');
  if (!nearbyRelevantCount) pushMissing(missing, 'nearbyEvents');

  const lateEntryEvidence = {
    entryReason,
    statusAtEntry,
    setup,
    nextMoveBias,
    confidenceScore,
    gateScore,
    gateThreshold,
    maxFavorablePct: mfePct,
    maxAdversePct: maePct,
  };
  let lateEntry = finalizeCheck({
    status: 'pass',
    reason: 'Entry ser inte sent utifrån tillgänglig loggning.',
    evidence: lateEntryEvidence,
    missingFields: [],
  });
  if (lateReasonHint && cautionHint && lossHint) {
    lateEntry = finalizeCheck({
      status: 'warn',
      reason: 'Entry togs sent efter att rörelsen redan hade gått en bit.',
      evidence: lateEntryEvidence,
      missingFields: [],
    });
  } else if (lateReasonHint || cautionHint || extendedHint) {
    lateEntry = finalizeCheck({
      status: 'warn',
      reason: lateReasonHint
        ? 'Entry togs efter att rörelsen redan hade gått en bit.'
        : cautionHint
          ? 'Status vid entry var caution, vilket talar för att entryn var sen eller osäker.'
          : 'Trade gick nästan aldrig i rätt riktning, vilket kan tyda på sen entry eller svag bekräftelse.',
      evidence: lateEntryEvidence,
      missingFields: [],
    });
  } else if (!entryReason && !Number.isFinite(confidenceScore) && !Number.isFinite(mfePct) && !Number.isFinite(maePct)) {
    lateEntry = finalizeCheck({
      status: 'unknown',
      reason: 'Data saknas för att bedöma om entry var sen.',
      evidence: lateEntryEvidence,
      missingFields: ['entryReason', 'confidenceScore', 'maxFavorablePct', 'maxAdversePct'],
    });
  }
  if (lateEntry.status !== 'pass') {
    recommendations.push(buildRecommendation(
      'replay_test',
      'Replay: late-entry-filter',
      'Blockera eller sänk confidence när rörelsen redan är extended och ingen ny bekräftelse finns.',
    ));
  }

  const twoMinuteEvidence = {
    entryReason,
    statusAtEntry,
    result,
    setup,
    maxFavorablePct: mfePct,
    maxAdversePct: maePct,
  };
  let twoMinuteConfirmation = finalizeCheck({
    status: 'pass',
    reason: 'Inga tydliga tecken på att en extra 2m-bekräftelse behövdes.',
    evidence: twoMinuteEvidence,
    missingFields: [],
  });
  if (twoMinuteHint && cautionHint && lossHint) {
    twoMinuteConfirmation = finalizeCheck({
      status: 'warn',
      reason: 'Trade såg ut att behöva ny 2m-bekräftelse men slutade som LOSS.',
      evidence: twoMinuteEvidence,
      missingFields: [],
    });
  } else if (twoMinuteHint || (cautionHint && lossHint)) {
    twoMinuteConfirmation = finalizeCheck({
      status: 'warn',
      reason: twoMinuteHint
        ? 'Entrytexten nämner ny 2m-bekräftelse, så det är värt att testa en striktare bekräftelsemodell.'
        : 'Status vid entry var caution och traden blev LOSS, vilket talar för att en extra 2m-bekräftelse kan vara nyttig.',
      evidence: twoMinuteEvidence,
      missingFields: [],
    });
  } else if (!entryReason && !Number.isFinite(confidenceScore) && !Number.isFinite(mfePct) && !Number.isFinite(maePct)) {
    twoMinuteConfirmation = finalizeCheck({
      status: 'unknown',
      reason: 'Data saknas för att bedöma behovet av 2m-bekräftelse.',
      evidence: twoMinuteEvidence,
      missingFields: ['entryReason', 'statusAtEntry'],
    });
  }
  if (twoMinuteConfirmation.status !== 'pass') {
    recommendations.push(buildRecommendation(
      'replay_test',
      'Replay: kräva 2m-confirmation',
      'Kräv ny 2m-confirmation när statusAtEntry=caution och rörelsen redan är extended.',
    ));
  }

  const stopFitEvidence = {
    exitReason,
    exitReasonCode,
    exitType,
    exitSource,
    maxFavorablePct: mfePct,
    maxAdversePct: maePct,
    stopLoss,
    takeProfit,
  };
  let stopFit = finalizeCheck({
    status: 'pass',
    reason: 'Stop loss ser inte ut att vara huvudproblemet i denna trade.',
    evidence: stopFitEvidence,
    missingFields: [],
  });
  if (stopHit && stopHasMove && lossHint) {
    stopFit = finalizeCheck({
      status: 'warn',
      reason: 'Traden var plus en stund men stoppades senare; testa trailing eller tidigare exit.',
      evidence: stopFitEvidence,
      missingFields: [],
    });
  } else if (stopHit && stopLossTight && adverseDirectHint && lossHint) {
    stopFit = finalizeCheck({
      status: 'warn',
      reason: 'Traden gick nästan direkt emot; problemet kan vara entry eller marknad, inte bara stop loss.',
      evidence: stopFitEvidence,
      missingFields: [],
    });
  } else if (stopHit) {
    stopFit = finalizeCheck({
      status: 'warn',
      reason: 'Exit ser ut som stop_loss/STOP_HIT, så stop-profilen bör testas i replay.',
      evidence: stopFitEvidence,
      missingFields: [],
    });
  } else if (!stopHit && !Number.isFinite(stopLoss) && !Number.isFinite(maePct) && !Number.isFinite(mfePct) && !exitReason) {
    stopFit = finalizeCheck({
      status: 'unknown',
      reason: 'Data saknas för att bedöma stop loss-passform.',
      evidence: stopFitEvidence,
      missingFields: ['stopLoss', 'takeProfit', 'exitReason', 'maxFavorablePct', 'maxAdversePct'],
    });
  }
  if (stopFit.status !== 'pass') {
    recommendations.push(
      buildRecommendation(
        'replay_test',
        'Replay: nuvarande stop',
        'Jämför nuvarande stop mot samma entry-regel för att se om stopfrekvensen är rimlig.',
      ),
      buildRecommendation(
        'replay_test',
        'Replay: bredare ATR-stop',
        'Testa en lite bredare ATR-baserad stop, men håll koll på större drawdown.',
      ),
      buildRecommendation(
        'replay_test',
        'Replay: tidigare exit vid snabb MFE-falloff',
        'Testa tidigare exit om MFE faller tillbaka snabbt efter första impulsen.',
      ),
    );
  }

  const choppyEvidence = {
    statusAtEntry,
    gateScore,
    gateThreshold,
    setup,
    maxFavorablePct: mfePct,
    maxAdversePct: maePct,
    nearbyBlockedCount,
    nearbyRelevantCount,
  };
  let choppyMarket = finalizeCheck({
    status: 'pass',
    reason: 'Inga tydliga tecken på choppy marknad i tillgänglig loggning.',
    evidence: choppyEvidence,
    missingFields: [],
  });
  if (nearbyRelevantCount === 0 && !Number.isFinite(mfePct) && !Number.isFinite(maePct) && !cautionHint) {
    choppyMarket = finalizeCheck({
      status: 'unknown',
      reason: 'Data saknas för att bedöma om marknaden var ryckig.',
      evidence: choppyEvidence,
      missingFields: ['nearbyEvents', 'maxFavorablePct', 'maxAdversePct', 'statusAtEntry'],
    });
  } else if (nearbyBlockedCount >= CHOPPY_NEARBY_BLOCKED_LIMIT) {
    choppyMarket = finalizeCheck({
      status: 'warn',
      reason: 'Många närliggande blocked events tyder på en ryckig eller osäker miljö.',
      evidence: choppyEvidence,
      missingFields: [],
    });
  } else if (cautionHint && lossHint) {
    choppyMarket = finalizeCheck({
      status: 'warn',
      reason: 'Status vid entry var caution och traden blev LOSS, vilket ofta sammanfaller med choppy marknad.',
      evidence: choppyEvidence,
      missingFields: [],
    });
  } else if (Number.isFinite(mfePct) && Math.abs(mfePct) <= QUALITY_PASSTHRU_LIMIT && Number.isFinite(maePct) && Math.abs(maePct) >= QUALITY_DIRECT_ADVERSE_LIMIT) {
    choppyMarket = finalizeCheck({
      status: 'warn',
      reason: 'Traden fick nästan ingen positiv rörelse men gick snabbt emot, vilket liknar choppy miljö.',
      evidence: choppyEvidence,
      missingFields: [],
    });
  } else if (nearbyRelevantCount >= 4) {
    choppyMarket = finalizeCheck({
      status: 'warn',
      reason: 'Det fanns flera närliggande events runt traden, vilket kan indikera ryckig marknad eller mycket filterbrus.',
      evidence: choppyEvidence,
      missingFields: [],
    });
  }
  if (choppyMarket.status !== 'pass') {
    recommendations.push(buildRecommendation(
      'replay_test',
      'Replay: choppy-market filter',
      'Sänk confidence eller blockera REGULAR_PULLBACK i choppy miljöer innan detta blir en real ändring.',
    ));
  }

  if (!entryReason || !statusAtEntry || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || !Number.isFinite(mfePct) || !Number.isFinite(maePct)) {
    recommendations.push(buildRecommendation(
      'logging_improvement',
      'Logga entry/exit-metrik bättre',
      'Logga entryReason, statusAtEntry, stopLoss, takeProfit, mfePct och maePct för mer träffsäker analys.',
    ));
  }

  const checks = {
    lateEntry,
    twoMinuteConfirmation,
    stopFit,
    choppyMarket,
  };

  const statusWeights = { pass: 10, warn: -9, fail: -18, unknown: 0 };
  const statuses = Object.values(checks).map((check) => check.status);
  const meaningfulStatuses = statuses.filter((status) => status !== 'unknown');
  let score = meaningfulStatuses.length ? 60 : 0;
  for (const status of statuses) {
    score += statusWeights[status] || 0;
  }
  if (result === 'LOSS') score -= 4;
  if (result === 'WIN') score += 4;
  if (meaningfulStatuses.length === 0) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  let entryQuality = 'unknown';
  if (meaningfulStatuses.length) {
    if (score >= 75) entryQuality = 'good';
    else if (score >= 45) entryQuality = 'caution';
    else entryQuality = 'bad';
  }

  if (entryQuality !== 'unknown') {
    recommendations.push(
      buildRecommendation(
        'paper_test',
        'Paper-testa entry-quality-förslag',
        'Testa föreslagen entry-logik i paper eller replay innan något används bredare.',
      ),
    );
  }

  return {
    ok: true,
    entryQuality,
    score,
    checks,
    recommendations: unique(recommendations.map((rec) => JSON.stringify(rec))).map((item) => JSON.parse(item)),
    missingFields: unique(Array.from(missing)),
  };
}

module.exports = {
  buildEntryQualityGate,
  _internal: {
    normalizeTradeLike,
    isLateEntryHint,
    isTwoMinuteHint,
    isStopRelated,
    isBlockedLikeEvent,
  },
};
