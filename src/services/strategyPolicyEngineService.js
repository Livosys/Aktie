'use strict';

const STRATEGY_POLICY_ENGINE_VERSION = 'strategy-policy-engine-v1';
const PRODUCER_CONFIRMATION_VERSION = 'producer_confirmation_v1';
const READINESS_ENGINE_VERSION = 'execution-readiness-v1';

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'execution_readiness_engine',
});

const POLICY_ACTIONS = Object.freeze({
  ALLOW: 'ALLOW',
  WATCH: 'WATCH',
  CAUTION: 'CAUTION',
  BLOCK: 'BLOCK',
});

const READINESS_VERDICTS = Object.freeze({
  EXECUTABLE: 'EXECUTABLE',
  NOT_EXECUTABLE: 'NOT_EXECUTABLE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});

const READINESS_REASONS = Object.freeze({
  STRUCTURE_MISSING_POLICY: 'STRUCTURE_MISSING_POLICY',
  STRUCTURE_MISSING_STRATEGY_ID: 'STRUCTURE_MISSING_STRATEGY_ID',
  STRUCTURE_SUBTYPE_NOT_ALLOWED: 'STRUCTURE_SUBTYPE_NOT_ALLOWED',
  STRUCTURE_DIRECTION_NOT_ALLOWED: 'STRUCTURE_DIRECTION_NOT_ALLOWED',
  STRUCTURE_SESSION_NOT_ALLOWED: 'STRUCTURE_SESSION_NOT_ALLOWED',
  STRUCTURE_MARKET_TYPE_MISMATCH: 'STRUCTURE_MARKET_TYPE_MISMATCH',
  CONTEXT_MARKET_CLOSED: 'CONTEXT_MARKET_CLOSED',
  CONTEXT_DATA_STALE: 'CONTEXT_DATA_STALE',
  QUALITY_ADVISORY_WATCH: 'QUALITY_ADVISORY_WATCH',
  QUALITY_ADVISORY_CAUTION: 'QUALITY_ADVISORY_CAUTION',
  QUALITY_ADVISORY_NOT_READY: 'QUALITY_ADVISORY_NOT_READY',
  QUALITY_CLOSED_CANDLE_MISSING: 'QUALITY_CLOSED_CANDLE_MISSING',
  QUALITY_TWO_MINUTE_MISSING: 'QUALITY_TWO_MINUTE_MISSING',
  QUALITY_EMA_CONFIRMATION_MISSING: 'QUALITY_EMA_CONFIRMATION_MISSING',
  QUALITY_VWAP_CONFIRMATION_MISSING: 'QUALITY_VWAP_CONFIRMATION_MISSING',
  QUALITY_VOLUME_BELOW_POLICY: 'QUALITY_VOLUME_BELOW_POLICY',
  QUALITY_LATE_OR_EXTENDED: 'QUALITY_LATE_OR_EXTENDED',
  QUALITY_OBSERVATION_TEXT_ONLY: 'QUALITY_OBSERVATION_TEXT_ONLY',
});

const LEGACY_REASON_MAP = Object.freeze({
  entry_contract_missing: READINESS_REASONS.STRUCTURE_MISSING_POLICY,
  invalid_strategy_subtype: READINESS_REASONS.STRUCTURE_SUBTYPE_NOT_ALLOWED,
  invalid_strategy_direction: READINESS_REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED,
  paper_entry_watch_only: READINESS_REASONS.QUALITY_ADVISORY_WATCH,
  paper_entry_caution_only: READINESS_REASONS.QUALITY_ADVISORY_CAUTION,
  paper_entry_status_not_ready: READINESS_REASONS.QUALITY_ADVISORY_NOT_READY,
  stale_strategy_signal: READINESS_REASONS.CONTEXT_DATA_STALE,
  missing_market_context: READINESS_REASONS.STRUCTURE_MARKET_TYPE_MISMATCH,
  invalid_session: READINESS_REASONS.STRUCTURE_SESSION_NOT_ALLOWED,
  missing_closed_candle_confirmation: READINESS_REASONS.QUALITY_CLOSED_CANDLE_MISSING,
  missing_two_minute_confirmation: READINESS_REASONS.QUALITY_TWO_MINUTE_MISSING,
  missing_ema_pullback_confirmation: READINESS_REASONS.QUALITY_EMA_CONFIRMATION_MISSING,
  missing_vwap_reclaim_confirmation: READINESS_REASONS.QUALITY_VWAP_CONFIRMATION_MISSING,
  missing_volume_confirmation: READINESS_REASONS.QUALITY_VOLUME_BELOW_POLICY,
  late_extended_entry: READINESS_REASONS.QUALITY_LATE_OR_EXTENDED,
});

const ADVISORY_WATCH = Object.freeze(new Set(['watch', 'observe', 'observing']));
const ADVISORY_READY = Object.freeze(new Set(['active', 'confirmed', 'entry', 'entry_ready', 'ready', 'queued', 'ready_waiting_for_signal']));
const STALE_FRESHNESS = Object.freeze(new Set(['STALE', 'MARKET_CLOSED', 'DELAYED', 'MISSING', 'UNKNOWN']));
const SESSION_ALWAYS_OPEN = Object.freeze(['24_7', 'crypto_24_7']);
const SESSION_US_RTH_EQUIVALENTS = Object.freeze(['regular', 'rth', 'nyse', 'nasdaq', 'us_stocks']);

const PRODUCER_POLICY_METADATA = Object.freeze({
  priorityOrder: Object.freeze({ active: 0, caution: 1, watch: 2, wait: 3, avoid: 4 }),
  closedTwoMinuteCandleMinAgeMs: 115 * 1000,
  twoMinuteCandleMs: 2 * 60 * 1000,
  priceToZoneAtr: Object.freeze({
    softZone: 1.8,
    hardZone: 12.0,
    hardWithoutTwoMinute: 3.0,
  }),
  extensionAtr: Object.freeze({
    mild: 1.5,
    medium: 7.0,
    extreme: 12.0,
  }),
  recentMoveAtr: Object.freeze({
    mild: 2.0,
    medium: 3.2,
    extreme: 5.0,
  }),
  fatigueScore: Object.freeze({
    mild: 45,
    medium: 60,
    extreme: 75,
  }),
  threeFingerSpread: Object.freeze({
    superWidePriceToZoneAtr: 6.5,
    extremeMaxAgreementCount: 3,
    strongAlignedAgreementCount: 5,
  }),
  watchLayer: Object.freeze({
    minAgreementCount: 5,
    allowedExtensionLevels: Object.freeze(['mild', 'medium']),
  }),
  freshness: Object.freeze({
    cryptoMs: 20 * 60 * 1000,
    stockMs: 24 * 60 * 60 * 1000,
  }),
  volume: Object.freeze({
    usableRvol: 1.0,
    strongRvol: 1.2,
    weakRvol: 0.7,
    usableStates: Object.freeze(['normal']),
    strongStates: Object.freeze(['strong', 'high', 'elevated']),
  }),
});

const EXTENSION_TEXT = Object.freeze({
  none: null,
  mild: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
  medium: 'Rörelsen är långt gången. Vänta på rekyl eller tydligare 2m-bekräftelse.',
  extreme: 'Rörelsen är för långt gången — jaga inte.',
});

function lower(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function upper(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildEntryContractPolicy(contract) {
  if (!contract) return null;
  return {
    policyId: `contract:${contract.strategyId}`,
    policyVersion: contract.version,
    allowedSubtypes: contract.allowedSubtypes,
    allowedDirections: contract.allowedDirections,
    allowedSessions: contract.allowedSessions,
    requiredConfirmations: contract.requiredConfirmations,
    requiresFreshData: contract.requiresFreshData,
    maxSignalAgeMs: contract.maxSignalAgeMs,
    requiresClosedCandle: contract.requiresClosedCandle,
    requiresMarketOpen: contract.requiresMarketOpen,
    requiresEmaContext: contract.requiresEmaContext === true,
    requiresVwapContext: contract.requiresVwapContext === true,
    volumePolicy: contract.volumePolicy,
    marketType: contract.marketType || null,
    lateEntryPolicy: contract.lateEntryPolicy,
    extendedMovePolicy: contract.extendedMovePolicy,
    evidenceGapPolicy: 'permit',
  };
}

function directionAllowed(policy, direction) {
  const tokens = (policy.allowedDirections || []).map(upper);
  if (direction === 'LONG') return tokens.some((t) => ['LONG', 'UP', 'BUY', 'BULL', 'BULLISH'].includes(t));
  if (direction === 'SHORT') return tokens.some((t) => ['SHORT', 'DOWN', 'SELL', 'BEAR', 'BEARISH'].includes(t));
  return false;
}

function sessionAllowed(policy, signal) {
  const allowed = (policy.allowedSessions || []).map(lower);
  if (!allowed.length) return true;
  const observed = (signal.evidence?.context?.sessionTokens || []).map(lower).filter(Boolean);
  if (!observed.length) return true;
  if (observed.some((token) => allowed.includes(token))) return true;
  if (allowed.some((value) => SESSION_ALWAYS_OPEN.includes(value))) return true;
  const isUsRth = observed.includes('us_rth') || signal.evidence?.context?.isRth === true;
  if (isUsRth && allowed.some((value) => SESSION_US_RTH_EQUIVALENTS.includes(value))) return true;
  return false;
}

function blockReadiness(reason, detail, gaps) {
  return {
    verdict: READINESS_VERDICTS.NOT_EXECUTABLE,
    reasonCode: reason,
    detail: detail || null,
    evidenceGaps: gaps,
  };
}

function evaluateReadinessPolicy({
  canonicalSignal,
  legacyAdvisory = null,
  now = new Date(),
  policy = null,
} = {}) {
  const signal = canonicalSignal || {};
  const ev = signal.evidence || {};
  const ctx = ev.context || {};
  const evidenceGaps = [];

  if (ev.extension?.level == null) evidenceGaps.push('extension_level_never_measured');
  if (ev.timeframes?.agreementCount == null) evidenceGaps.push('timeframe_agreement_never_measured');
  if (ev.volume?.rvol == null) evidenceGaps.push('volume_rvol_never_measured');

  const base = {
    engineVersion: READINESS_ENGINE_VERSION,
    evaluatedAt: new Date(now).toISOString(),
    ...SAFETY,
  };

  if (!signal.strategyId) {
    return { ...base, ...blockReadiness(READINESS_REASONS.STRUCTURE_MISSING_STRATEGY_ID, null, evidenceGaps), policyId: null };
  }
  if (!policy) {
    return { ...base, ...blockReadiness(READINESS_REASONS.STRUCTURE_MISSING_POLICY, null, evidenceGaps), policyId: null };
  }
  const withPolicy = { ...base, policyId: policy.policyId, policyVersion: policy.policyVersion };

  if (!policy.allowedSubtypes.includes(upper(signal.signalSubtype))) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.STRUCTURE_SUBTYPE_NOT_ALLOWED, { observed: signal.signalSubtype }, evidenceGaps) };
  }
  if (!directionAllowed(policy, signal.direction)) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED, { observed: signal.direction }, evidenceGaps) };
  }

  const advisory = lower(legacyAdvisory);
  if (ADVISORY_WATCH.has(advisory)) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_ADVISORY_WATCH, { advisory }, evidenceGaps) };
  }
  if (advisory === 'caution') {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_ADVISORY_CAUTION, { advisory }, evidenceGaps) };
  }
  if (!ADVISORY_READY.has(advisory)) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_ADVISORY_NOT_READY, { advisory: advisory || null }, evidenceGaps) };
  }

  if (policy.requiresFreshData) {
    const freshness = upper(ctx.dataFreshness || '');
    const age = ev.candle?.signalAgeMs;
    if (freshness && STALE_FRESHNESS.has(freshness)) {
      return { ...withPolicy, ...blockReadiness(READINESS_REASONS.CONTEXT_DATA_STALE, { dataFreshness: freshness }, evidenceGaps) };
    }
    if (age == null) {
      return { ...withPolicy, ...blockReadiness(READINESS_REASONS.CONTEXT_DATA_STALE, { missingSignalTimestamp: true }, evidenceGaps) };
    }
    if (age > policy.maxSignalAgeMs) {
      return { ...withPolicy, ...blockReadiness(READINESS_REASONS.CONTEXT_DATA_STALE, { signalAgeMs: age, maxSignalAgeMs: policy.maxSignalAgeMs }, evidenceGaps) };
    }
  }

  if (policy.marketType === 'stocks' && signal.marketType !== 'stocks') {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.STRUCTURE_MARKET_TYPE_MISMATCH, { observed: signal.marketType }, evidenceGaps) };
  }
  if (ctx.marketClosed === true) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.CONTEXT_MARKET_CLOSED, null, evidenceGaps) };
  }
  if (policy.requiresMarketOpen && !sessionAllowed(policy, signal)) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.STRUCTURE_SESSION_NOT_ALLOWED, { observed: ctx.session }, evidenceGaps) };
  }

  if (policy.requiresClosedCandle && ev.candle?.closedCandleConfirmed !== true) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_CLOSED_CANDLE_MISSING, null, evidenceGaps) };
  }

  const observed = new Set(ev.confirmations || []);
  if (policy.requiredConfirmations.includes('two_minute_confirmation') && !observed.has('two_minute_confirmation')) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_TWO_MINUTE_MISSING, null, evidenceGaps) };
  }
  if (policy.requiresEmaContext && ctx.emaContextPresent !== true) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_EMA_CONFIRMATION_MISSING, { missingEmaContext: true }, evidenceGaps) };
  }
  if (policy.requiresEmaContext && ctx.trendIntact !== true) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_EMA_CONFIRMATION_MISSING, { brokenTrend: true }, evidenceGaps) };
  }
  if (policy.requiredConfirmations.includes('ema_pullback_reclaim') && !observed.has('ema_pullback_reclaim')) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_EMA_CONFIRMATION_MISSING, null, evidenceGaps) };
  }
  if (policy.requiresVwapContext && ctx.vwapContextPresent !== true) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_VWAP_CONFIRMATION_MISSING, { missingVwapContext: true }, evidenceGaps) };
  }
  if (policy.requiredConfirmations.includes('vwap_reclaim_confirmation') && !observed.has('vwap_reclaim_confirmation')) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_VWAP_CONFIRMATION_MISSING, null, evidenceGaps) };
  }
  if (policy.requiredConfirmations.includes('volume_confirmation') && !observed.has('volume_confirmation')) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_VOLUME_BELOW_POLICY, null, evidenceGaps) };
  }
  if (policy.volumePolicy && !observed.has('volume_confirmation')) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_VOLUME_BELOW_POLICY, { volumePolicy: policy.volumePolicy }, evidenceGaps) };
  }

  if ((policy.lateEntryPolicy === 'block' || policy.extendedMovePolicy === 'block') && ctx.lateOrExtended === true) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_LATE_OR_EXTENDED, null, evidenceGaps) };
  }
  if (ctx.observationTextOnly === true) {
    return { ...withPolicy, ...blockReadiness(READINESS_REASONS.QUALITY_OBSERVATION_TEXT_ONLY, null, evidenceGaps) };
  }

  if (evidenceGaps.length && policy.evidenceGapPolicy === 'block') {
    return {
      ...withPolicy,
      verdict: READINESS_VERDICTS.INSUFFICIENT_EVIDENCE,
      reasonCode: `EVIDENCE_GAP:${evidenceGaps[0]}`,
      detail: { evidenceGaps },
      evidenceGaps,
    };
  }

  return {
    ...withPolicy,
    verdict: READINESS_VERDICTS.EXECUTABLE,
    reasonCode: null,
    detail: null,
    evidenceGaps,
  };
}

function latestClosedCandleMeta(liveCandleDebug, now = new Date(), options = {}) {
  const candles = Array.isArray(liveCandleDebug?.candles) ? liveCandleDebug.candles : [];
  const sorted = candles
    .filter((c) => c && c.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const nowMs = new Date(now).getTime();
  const signalMs = options.signalTimestamp ? new Date(options.signalTimestamp).getTime() : NaN;
  let selected = null;

  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const candle = sorted[i];
    const startMs = candle?.timestamp ? new Date(candle.timestamp).getTime() : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) continue;
    if (Number.isFinite(signalMs) && startMs + 1000 < signalMs) continue;
    const explicitOpen = candle.incomplete === true || candle.closed === false;
    const explicitClosed = candle.incomplete === false || candle.closed === true || candle.complete === true;
    const closedByAge = nowMs - startMs >= PRODUCER_POLICY_METADATA.closedTwoMinuteCandleMinAgeMs;
    if (!explicitOpen && (explicitClosed || closedByAge)) {
      selected = { candle, startMs };
      break;
    }
  }

  const latest = selected?.candle || sorted[sorted.length - 1] || null;
  const latestMs = latest?.timestamp ? new Date(latest.timestamp).getTime() : NaN;
  const ageMs = Number.isFinite(latestMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - latestMs) : null;
  const closed = Boolean(selected);
  return {
    confirmed: closed,
    source: latest ? (liveCandleDebug.source || liveCandleDebug.debug?.sourceName || 'live_candle_cache') : 'missing_live_candle',
    latestTimestamp: latest?.timestamp || null,
    closedAt: selected ? new Date(selected.startMs + PRODUCER_POLICY_METADATA.twoMinuteCandleMs).toISOString() : null,
    ageMs,
    close: num(latest?.close),
    open: num(latest?.open),
    high: num(latest?.high),
    low: num(latest?.low),
    volume: num(latest?.volume),
    candleCount: candles.length,
    incomplete: latest?.incomplete === true,
  };
}

function volumeEvidence(result = {}, metadata = PRODUCER_POLICY_METADATA) {
  const state = lower(result.volumeState);
  const rvol = num(result.rvol ?? result.relVol20);
  const strong = metadata.volume.strongStates.includes(state) || (rvol != null && rvol >= metadata.volume.strongRvol);
  const usable = strong || metadata.volume.usableStates.includes(state) || (rvol != null && rvol >= metadata.volume.usableRvol);
  return {
    state: state || 'unknown',
    rvol,
    strong,
    usable,
    source: rvol != null ? 'relative_volume' : state !== 'unknown' ? 'volume_state' : 'missing_volume_context',
  };
}

function buildEmaContext(result = {}, signalSubtype, bias, twoMinuteConfirmed, closedCandle) {
  const price = num(result.price);
  const ema21 = num(result.ema21);
  const ema50 = num(result.ema50);
  const ema9 = num(result.ema9);
  const latestClose = closedCandle.close;
  const close = latestClose != null ? latestClose : price;
  const hasContext = price != null && ema21 != null && ema50 != null;
  const priceAboveEma21 = hasContext && close >= ema21;
  const emaStackLong = ema21 >= ema50 || (ema9 != null && ema9 >= ema21);
  const trendIntact = hasContext && priceAboveEma21 && emaStackLong && upper(bias) === 'UP';
  const reclaimConfirmed = signalSubtype === 'EMA_PULLBACK_UP'
    && trendIntact
    && twoMinuteConfirmed === true
    && closedCandle.confirmed === true;
  return {
    hasContext,
    trendIntact,
    reclaimConfirmed,
    trendDirection: trendIntact ? 'UP' : hasContext ? 'UNKNOWN' : null,
    relation: priceAboveEma21 ? 'above_ema21' : hasContext ? 'below_ema21' : null,
    price,
    latestClose: close,
    ema9,
    ema21,
    ema50,
    source: hasContext ? 'ema_indicators_and_closed_2m_candle' : 'missing_ema_indicators',
  };
}

function buildVwapContext(result = {}, signalSubtype, bias, twoMinuteConfirmed, closedCandle) {
  const price = num(result.price);
  const vwap = num(result.vwap);
  const distancePct = num(result.vwapDistancePct);
  const latestClose = closedCandle.close;
  const close = latestClose != null ? latestClose : price;
  const hasContext = vwap != null && close != null;
  const closeAboveVwap = hasContext && close >= vwap;
  const reclaimConfirmed = signalSubtype === 'VWAP_RECLAIM_UP'
    && closeAboveVwap
    && upper(bias) === 'UP'
    && twoMinuteConfirmed === true
    && closedCandle.confirmed === true;
  return {
    hasContext,
    reclaimConfirmed,
    closeAboveVwap,
    priceVsVwap: closeAboveVwap ? 'above' : hasContext ? 'below' : null,
    price,
    latestClose: close,
    vwap,
    distancePct,
    source: hasContext ? 'vwap_indicator_and_closed_2m_candle' : 'missing_vwap_indicator',
  };
}

function directionFromBias(bias) {
  if (bias === 'UP') return 'bullish';
  if (bias === 'DOWN') return 'bearish';
  return null;
}

function hasTwoMinuteConfirmation(dirs = {}, bias) {
  if (!['bullish', 'bearish'].includes(dirs.tf2m)) return false;
  const dir = directionFromBias(bias);
  if (!dir) return true;
  return dirs.tf2m === dir;
}

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

function classifyExtension(result = {}, bias, dirs = {}, agreementCount = 0, metadata = PRODUCER_POLICY_METADATA) {
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
    priceToZoneAtr >= metadata.extensionAtr.extreme
    || fatigueScore >= metadata.fatigueScore.extreme
    || (highFakeout && priceToZoneAtr >= metadata.extensionAtr.medium)
    || (breakout && !twoMinuteConfirmed)
    || (!twoMinuteConfirmed && recentMoveAtr >= metadata.recentMoveAtr.extreme)
    || (
      tfsSuperWide
      && priceToZoneAtr >= metadata.threeFingerSpread.superWidePriceToZoneAtr
      && agreementCount <= metadata.threeFingerSpread.extremeMaxAgreementCount
      && !alignedFastFrames
    )
  ) {
    level = 'extreme';
  } else if (
    priceToZoneAtr >= metadata.extensionAtr.medium
    || fatigueScore >= metadata.fatigueScore.medium
    || breakout
    || (recentMoveAtr >= metadata.recentMoveAtr.medium && !(alignedFastFrames && agreementCount >= metadata.threeFingerSpread.strongAlignedAgreementCount))
    || (tfsActive && !(alignedFastFrames && agreementCount >= metadata.threeFingerSpread.strongAlignedAgreementCount))
  ) {
    level = 'medium';
  } else if (
    priceToZoneAtr >= metadata.extensionAtr.mild
    || recentMoveAtr >= metadata.recentMoveAtr.mild
    || fatigueScore >= metadata.fatigueScore.mild
    || tfsActive
  ) {
    level = 'mild';
  }

  if (priceToZoneAtr >= metadata.extensionAtr.mild) reasons.push(`priceToZoneAtr=${priceToZoneAtr.toFixed(2)}`);
  if (recentMoveAtr >= metadata.recentMoveAtr.mild) reasons.push(`recentMoveAtr=${recentMoveAtr.toFixed(2)}`);
  if (fatigueScore >= metadata.fatigueScore.mild) reasons.push(`fatigueScore=${fatigueScore}`);
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

function evaluateExtensionPolicy(strategyId, extensionEvidence = {}) {
  const level = lower(extensionEvidence.extensionLevel || extensionEvidence.level || 'none');
  const action = level === 'extreme'
    ? POLICY_ACTIONS.BLOCK
    : level === 'medium'
      ? POLICY_ACTIONS.WATCH
      : level === 'mild'
        ? POLICY_ACTIONS.CAUTION
        : POLICY_ACTIONS.ALLOW;
  return {
    strategyId: strategyId || null,
    action,
    extensionEvidence,
    policyEngineVersion: STRATEGY_POLICY_ENGINE_VERSION,
  };
}

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

function candleScoreOpposesTf2m(dirs = {}, candleScore2m) {
  const scoreDirection = candleScore2m?.scoreDirection || 'unknown';
  return (dirs.tf2m === 'bullish' && scoreDirection === 'bearish')
    || (dirs.tf2m === 'bearish' && scoreDirection === 'bullish');
}

function buildTwoMinuteConflict(dirs = {}, candleScore2m) {
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

function isStockMarket(marketType) {
  return ['stock', 'stocks'].includes(String(marketType || '').toLowerCase());
}

function isDataStale(timestamp, marketType, metadata = PRODUCER_POLICY_METADATA) {
  if (!timestamp) return true;
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return true;
  const maxAge = marketType === 'crypto' ? metadata.freshness.cryptoMs : metadata.freshness.stockMs;
  return Date.now() - t > maxAge;
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

function buildDecisionText(result, bias, agreementCount, dirs, blockersMeta, extensionMeta) {
  const score = Math.max(result.tradeScore || 0, result.daytradeScore || 0);
  const signal = result.signal || 'NO_SIGNAL';
  const state = result.stateGraph?.currentState || 'UNKNOWN';
  const hasHardBlock = blockersMeta.hardBlockers.length > 0;
  const hasOnlySoftBlockers = !hasHardBlock && blockersMeta.softBlockers.length > 0;
  const twoMinuteConfirmed = blockersMeta.twoMinuteConfirmed;
  const highAgreement = agreementCount >= 5;
  const enoughAgreement = agreementCount >= 4;

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

  if (state === 'EXHAUSTION') {
    return { text: 'Rörelsen är för långt gången — jaga inte.', priority: 'avoid' };
  }

  if (!twoMinuteConfirmed) {
    return {
      text: '2m bekräftar inte rörelsen ännu.',
      priority: signal === 'LONG_TRIGGERED' || signal === 'SHORT_TRIGGERED' ? 'watch' : 'wait',
    };
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

  if (score >= 50) {
    return { text: 'Bevaka. Läget är nära men behöver mer stöd.', priority: 'watch' };
  }

  if (score >= 35) {
    return { text: 'Vänta. Potential finns men bekräftelse saknas.', priority: 'wait' };
  }

  return { text: 'Vänta. Systemet ser inget tydligt läge.', priority: 'wait' };
}

function qualifiesForWatchLayer({ staleData, hardBlockers, agreementCount, dirs, candleScore2m, extensionMeta }, metadata = PRODUCER_POLICY_METADATA) {
  if (staleData) return false;
  if (hardBlockers.length) return false;
  if (agreementCount < metadata.watchLayer.minAgreementCount) return false;
  if (!['bullish', 'bearish'].includes(dirs.tf2m)) return false;
  if (!metadata.watchLayer.allowedExtensionLevels.includes(extensionMeta?.level)) return false;
  if (candleScoreOpposesTf2m(dirs, candleScore2m)) return false;
  return true;
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
    const canAllowWatch = agreementCount >= 5
      && dirs.tf2m === 'bearish'
      && candleDir !== 'bullish'
      && noHardBlockers;
    const bearishRegime = ['BEARISH_TREND', 'PANIC'].includes(String(marketRegime || '').toUpperCase());
    return {
      historicalEdge: canAllowWatch && bearishRegime ? 'strong' : canAllowWatch ? 'neutral' : 'unknown',
      reasonSv: 'EMA-rekyl nedåt har fungerat bättre än EMA-rekyl uppåt i senaste mätningen.',
      suggestedPriorityBias: canAllowWatch && priority === 'wait' ? 'raise_to_watch' : 'keep',
      source,
    };
  }

  if (signalSubtype === 'EMA_PULLBACK_UP') {
    const requirementsOk = volumeOk
      && candleDir !== 'bearish'
      && !isMediumOrExtremeExtension(extensionLevel);
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

function buildBlockers(result, dirs, bias, agreementCount, marketType, timestamp, extensionMeta, twoMinuteConflictMeta, context = {}, metadata = PRODUCER_POLICY_METADATA) {
  const hardBlockers = [];
  const softBlockers = [];
  const twoMinuteConfirmed = hasTwoMinuteConfirmation(dirs, bias);
  const priceToZoneAtr = Number(result.priceToZoneAtr);
  const marketClosed = context.marketClosed === true;
  const staleData = marketClosed
    ? false
    : typeof context.staleData === 'boolean'
      ? context.staleData
      : isDataStale(timestamp, marketType, metadata);

  if (staleData && marketType === 'crypto') hardBlockers.push('Data är gammal');
  else if (staleData) softBlockers.push('Data är gammal');

  if (!twoMinuteConfirmed) softBlockers.push('2m saknar bekräftelse');
  if (twoMinuteConflictMeta?.twoMinuteConflict) softBlockers.push('Senaste 2m-candles säger emot riktningen');
  if (result.fakeoutRiskLevel === 'high') hardBlockers.push('Risken för falskt utbrott är hög');
  const hardPriceExtension = priceToZoneAtr >= metadata.priceToZoneAtr.hardZone
    || (!twoMinuteConfirmed && priceToZoneAtr >= metadata.priceToZoneAtr.hardWithoutTwoMinute);

  if (hardPriceExtension) {
    hardBlockers.push('Priset är för långt från bra nivå — jaga inte');
  } else if (result.threeFingerSpread?.active || priceToZoneAtr >= metadata.priceToZoneAtr.softZone) {
    softBlockers.push('Priset är lite långt från bra nivå');
  }

  if (extensionMeta?.level === 'extreme') {
    hardBlockers.push('Rörelsen är för långt gången — jaga inte');
  } else if (extensionMeta?.level === 'medium') {
    softBlockers.push('Rörelsen är långt gången');
  } else if (extensionMeta?.level === 'mild') {
    softBlockers.push('Rörelsen har gått en bit');
  }

  if ((result.relVol20 || 1) < metadata.volume.weakRvol) softBlockers.push('Volymen är svag');
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
    staleData: marketClosed ? false : staleData,
  };
}

function buildPlainExplanation(result, { priority, bias, agreementCount, dirs, hardBlockers, softBlockers }, metadata = PRODUCER_POLICY_METADATA) {
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
  if (result.priceToZoneAtr >= metadata.priceToZoneAtr.hardZone) against.push('Priset är för långt från bra nivå.');
  else if (result.priceToZoneAtr >= metadata.priceToZoneAtr.softZone) against.push('Priset är lite långt från bra nivå.');
  if ((result.relVol20 || 1) < metadata.volume.weakRvol) against.push('Volymen är svag.');
  if (result.fakeoutRiskLevel === 'high') against.push('Risken för falskt utbrott är hög.');
  blockers.forEach((b) => { if (b && !against.includes(b)) against.push(b); });
  if (!against.length) against.push('Ingen stor varning syns just nu.');

  const missing = [];
  if (!twoMinuteConfirmed) missing.push('Tydlig 2m-bekräftelse.');
  if (agreementCount < 4) missing.push('Mer stöd från 1h, 30m, 15m, 10m och 5m.');
  if ((result.relVol20 || 1) < metadata.volume.weakRvol) missing.push('Starkare volym.');
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

function buildProducerConfirmation({
  result,
  signalSubtype,
  signalFamily,
  priority,
  bias,
  timeframes,
  blockersMeta,
  extensionMeta,
  liveCandleDebug,
  marketType,
  marketClosed,
  dataFreshness,
  timestamp,
  candleScore2m,
}) {
  const twoMinuteConfirmed = blockersMeta.twoMinuteConfirmed === true;
  const closedCandle = latestClosedCandleMeta(liveCandleDebug, new Date(), { signalTimestamp: timestamp });
  const signalTimestamp = closedCandle.confirmed && closedCandle.closedAt ? closedCandle.closedAt : timestamp;
  const volume = volumeEvidence(result);
  const emaContext = buildEmaContext(result, signalSubtype, bias, twoMinuteConfirmed, closedCandle);
  const vwapContext = buildVwapContext(result, signalSubtype, bias, twoMinuteConfirmed, closedCandle);
  const observed = [];
  const missing = [];
  const blockers = [];

  if (twoMinuteConfirmed) observed.push('two_minute_confirmation');
  else missing.push('two_minute_confirmation');
  if (closedCandle.confirmed) observed.push('closed_candle_confirmation');
  else missing.push('closed_candle_confirmation');
  if (volume.strong) observed.push('volume_confirmation');

  if (signalSubtype === 'EMA_PULLBACK_UP') {
    if (emaContext.reclaimConfirmed) observed.push('ema_pullback_reclaim');
    else missing.push(emaContext.hasContext ? 'ema_pullback_reclaim' : 'ema_context');
  }
  if (signalSubtype === 'VWAP_RECLAIM_UP') {
    if (vwapContext.reclaimConfirmed) observed.push('vwap_reclaim_confirmation');
    else missing.push(vwapContext.hasContext ? 'vwap_reclaim_confirmation' : 'vwap_context');
    if (!volume.strong) missing.push('volume_confirmation');
  }

  if (marketClosed) blockers.push('market_closed');
  if (dataFreshness !== 'LIVE') blockers.push('data_not_live');
  if (extensionMeta?.level && extensionMeta.level !== 'none') blockers.push('extended_move');
  if (['watch', 'caution', 'wait', 'avoid'].includes(lower(priority))) blockers.push(`status_${priority}`);

  const entryReady = blockers.length === 0
    && missing.length === 0
    && ['active', 'confirmed', 'entry', 'entry_ready', 'ready'].includes(lower(priority));

  return {
    version: PRODUCER_CONFIRMATION_VERSION,
    strategySubtype: signalSubtype || null,
    signalFamily: signalFamily || null,
    status: priority || null,
    entryReady,
    confirmationObserved: [...new Set(observed)],
    missingConfirmations: [...new Set(missing)],
    blockers: [...new Set(blockers)],
    evidence: {
      generatedAt: new Date().toISOString(),
      signalTimestamp: signalTimestamp || null,
      marketType,
      marketClosed: marketClosed === true,
      dataFreshness,
      nextMoveBias: bias,
      timeframes,
      tf2m: timeframes?.tf2m || null,
      twoMinuteConfirmed,
      closedCandle,
      volume,
      emaContext,
      vwapContext,
      extensionLevel: extensionMeta?.level || null,
      extensionReasons: extensionMeta?.reasons || [],
      candleScore2m,
    },
  };
}

function confirmedEntryPromotion({
  signalSubtype,
  priority,
  marketType,
  dataFreshness,
  marketClosed,
  bias,
  hardBlockers,
  extensionMeta,
  twoMinuteConflict,
  producerEvidence,
}) {
  if (!['watch', 'caution', 'wait'].includes(lower(priority))) return null;
  if (marketClosed === true || dataFreshness !== 'LIVE') return null;
  if (upper(bias) !== 'UP') return null;
  if ((hardBlockers || []).length > 0) return null;
  if (extensionMeta?.level && extensionMeta.level !== 'none') return null;
  if (twoMinuteConflict === true) return null;
  if (producerEvidence?.twoMinuteConfirmed !== true) return null;
  if (producerEvidence?.closedCandle?.confirmed !== true) return null;

  const volume = producerEvidence.volume || {};
  if (signalSubtype === 'NARROW_BULL_ENTRY') {
    if (volume.usable !== true) return null;
    return 'Entry bekräftad: 2m och stängd candle bekräftar utbrottet.';
  }

  if (signalSubtype === 'EMA_PULLBACK_UP') {
    const emaContext = producerEvidence.emaContext || {};
    if (emaContext.trendIntact !== true || emaContext.reclaimConfirmed !== true) return null;
    if (volume.usable !== true) return null;
    return 'Entry bekräftad: priset har reclaimat EMA med stängd 2m-candle.';
  }

  if (signalSubtype === 'VWAP_RECLAIM_UP') {
    if (!isStockMarket(marketType)) return null;
    const vwapContext = producerEvidence.vwapContext || {};
    if (vwapContext.reclaimConfirmed !== true || vwapContext.closeAboveVwap !== true) return null;
    if (volume.strong !== true) return null;
    return 'Entry bekräftad: priset har reclaimat VWAP med stark volym och stängd 2m-candle.';
  }

  return null;
}

const ENTRY_OBSERVATION_STATUSES = Object.freeze(new Set(['watch', 'caution', 'wait', 'avoid', 'no_trade', 'observe', 'observing']));
const ENTRY_WATCH_STATUSES = Object.freeze(new Set(['watch', 'observe', 'observing']));
const ENTRY_WAIT_STATUSES = Object.freeze(new Set(['wait', 'avoid', 'no_trade']));
const ENTRY_READY_STATUSES = Object.freeze(new Set(['active', 'confirmed', 'entry', 'entry_ready', 'ready', 'queued', 'ready_waiting_for_signal']));
const ENTRY_LONG_DIRECTIONS = Object.freeze(new Set(['UP', 'LONG', 'BUY', 'BULL', 'BULLISH']));
const ENTRY_SHORT_DIRECTIONS = Object.freeze(new Set(['DOWN', 'SHORT', 'SELL', 'BEAR', 'BEARISH']));
const ENTRY_VOLUME_OK_STATES = Object.freeze(new Set(['normal', 'strong', 'high', 'elevated']));
const ENTRY_VOLUME_STRONG_STATES = Object.freeze(new Set(['strong', 'high', 'elevated']));
const ENTRY_EXTENDED_LEVELS = Object.freeze(new Set(['mild', 'medium', 'extreme', 'late', 'extended']));

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function strategyIdOf(row = {}) {
  return row.strategyId
    || row.strategy_id
    || row.resolvedStrategyId
    || row.sourceStrategyId
    || row.canonicalStrategyId
    || null;
}

function subtypeOf(candidate = {}) {
  return upper(candidate.signalSubtype || candidate.signal_subtype || candidate.setup || candidate.raw_strategy || candidate.eventType || candidate.strategy || '');
}

function marketTypeOf(candidate = {}, marketContext = {}) {
  const symbol = upper(candidate.symbol);
  const market = lower(candidate.marketType || candidate.market || candidate.marketGroup || candidate.market_group || marketContext.marketType || marketContext.market || '');
  if (market === 'crypto' || market.includes('crypto') || symbol.endsWith('USDT')) return 'crypto';
  if (market === 'stocks' || market === 'stock' || market.includes('stocks') || market.includes('equity')) return 'stocks';
  return market || 'stocks';
}

function sessionOf(candidate = {}, marketContext = {}) {
  return lower(
    candidate.session
    || candidate.marketSession
    || candidate.market_session
    || marketContext.session
    || marketContext.marketSession
    || '',
  );
}

function observedSessionTokens(candidate = {}, marketContext = {}) {
  return [...new Set([
    candidate.session,
    candidate.sessionId,
    candidate.marketSession,
    candidate.market_session,
    candidate.sessionMetadata?.session,
    candidate.sessionMetadata?.sessionId,
    marketContext.session,
    marketContext.sessionId,
    marketContext.marketSession,
  ].map((value) => lower(value)).filter(Boolean))];
}

function sessionAllowedByContract(contract, candidate = {}, marketContext = {}) {
  const allowed = arr(contract.allowedSessions).map((value) => lower(value));
  if (!allowed.length) return true;
  const observed = observedSessionTokens(candidate, marketContext);
  if (!observed.length) return true;
  if (observed.some((token) => allowed.includes(token))) return true;
  if (allowed.some((value) => SESSION_ALWAYS_OPEN.includes(value))) return true;
  const isUsRth = observed.includes('us_rth') || candidate.isRth === true;
  if (isUsRth && allowed.some((value) => SESSION_US_RTH_EQUIVALENTS.includes(value))) return true;
  return false;
}

function directionTokens(candidate = {}) {
  return [
    candidate.nextMoveBias,
    candidate.next_move_bias,
    candidate.direction,
    candidate.tradeDirection,
    candidate.entryDirection,
    candidate.side,
    candidate.orderSide,
    candidate.entrySide,
  ].map(upper).filter(Boolean);
}

function hasShortIntent(candidate = {}) {
  const tokens = directionTokens(candidate);
  if (tokens.some((token) => ENTRY_SHORT_DIRECTIONS.has(token))) return true;

  const fields = [
    candidate.signalSubtype,
    candidate.signal_subtype,
    candidate.setup,
    candidate.setupType,
    candidate.eventType,
    candidate.signal,
    candidate.raw_strategy,
  ];
  for (const value of fields) {
    const token = upper(value);
    if (!token) continue;
    if (['NARROW_BEAR_ENTRY', 'EMA_PULLBACK_DOWN', 'VWAP_REJECTION_DOWN', 'REJECTION_DOWN', 'BREAKDOWN', 'BEAR', 'SHORT'].includes(token)) return true;
    if (token.includes('NARROW_BEAR_ENTRY') || token.includes('EMA_PULLBACK_DOWN') || token.includes('VWAP_REJECTION_DOWN')) return true;
    if (token.includes('REJECTION_DOWN') || token.includes('BREAKDOWN')) return true;
    if (/(^|[_\s-])BEAR($|[_\s-])/.test(token) || /(^|[_\s-])SHORT($|[_\s-])/.test(token)) return true;
  }
  return false;
}

function hasLongDirection(candidate = {}) {
  const tokens = directionTokens(candidate);
  if (tokens.some((token) => ENTRY_LONG_DIRECTIONS.has(token))) return true;
  const subtype = subtypeOf(candidate);
  return subtype === 'NARROW_BULL_ENTRY' || subtype === 'EMA_PULLBACK_UP' || subtype === 'VWAP_RECLAIM_UP';
}

function contractAllowsObservedDirection(contract = {}, candidate = {}) {
  const allowedDirections = arr(contract.allowedDirections).map(upper);
  const allowsLong = allowedDirections.some((token) => ENTRY_LONG_DIRECTIONS.has(token));
  const allowsShort = allowedDirections.some((token) => ENTRY_SHORT_DIRECTIONS.has(token));
  const longObserved = hasLongDirection(candidate);
  const shortObserved = hasShortIntent(candidate);
  const disallowedLongObserved = longObserved && !allowsLong;
  const disallowedShortObserved = shortObserved && !allowsShort;
  return {
    allowed: !disallowedLongObserved
      && !disallowedShortObserved
      && ((longObserved && allowsLong) || (shortObserved && allowsShort)),
    allowsLong,
    allowsShort,
    longObserved,
    shortObserved,
    disallowedLongObserved,
    disallowedShortObserved,
    directionTokens: directionTokens(candidate),
  };
}

function boolAt(obj, keys) {
  for (const key of keys) {
    const parts = key.split('.');
    let cur = obj;
    for (const part of parts) {
      cur = cur && typeof cur === 'object' ? cur[part] : undefined;
    }
    if (cur === true) return true;
    if (cur === false) return false;
  }
  return null;
}

function textAt(obj, keys) {
  for (const key of keys) {
    const parts = key.split('.');
    let cur = obj;
    for (const part of parts) {
      cur = cur && typeof cur === 'object' ? cur[part] : undefined;
    }
    const text = safeString(cur);
    if (text) return text;
  }
  return null;
}

function extractSignalTimestamp(candidate = {}) {
  const explicit = textAt(candidate, [
    'signalTimestamp',
    'signal_time',
    'signalTime',
    'candleTimestamp',
    'barTimestamp',
    'timestamp',
    'createdAt',
    'lastUpdate',
    'updatedAt',
    'candle.timestamp',
    'bar.timestamp',
  ]);
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return { at: explicit, ms: parsed, source: 'field' };
  }
  const signalId = safeString(candidate.signalId);
  if (signalId) {
    const match = signalId.match(/(20\d{2}-\d{2}-\d{2}T[0-9:.]+Z)/);
    if (match) {
      const parsed = Date.parse(match[1]);
      if (Number.isFinite(parsed)) return { at: match[1], ms: parsed, source: 'signalId' };
    }
  }
  return { at: null, ms: null, source: null };
}

function signalAgeMs(candidate = {}, now = new Date()) {
  const ageSeconds = finiteNumber(candidate.dataAgeSeconds ?? candidate.signalAgeSeconds ?? candidate.scanAgeSeconds);
  if (ageSeconds != null) return { signalAgeMs: Math.max(0, ageSeconds * 1000), source: 'age_seconds' };
  const ageMs = finiteNumber(candidate.signalAgeMs ?? candidate.dataAgeMs ?? candidate.scanAgeMs);
  if (ageMs != null) return { signalAgeMs: Math.max(0, ageMs), source: 'age_ms' };
  const timestamp = extractSignalTimestamp(candidate);
  if (timestamp.ms != null) {
    const nowMs = new Date(now).getTime();
    if (Number.isFinite(nowMs)) return { signalAgeMs: Math.max(0, nowMs - timestamp.ms), source: timestamp.source, signalTimestamp: timestamp.at };
  }
  return { signalAgeMs: null, source: null, signalTimestamp: null };
}

function hasEntryTwoMinuteConfirmation(candidate = {}) {
  const explicit = boolAt(candidate, [
    'twoMinuteConfirmed',
    'twoMinuteConfirmation',
    'twoMinuteConfirmation.confirmed',
    'candleConfirmation.twoMinuteConfirmed',
    'extensionMeta.twoMinuteConfirmed',
    'confirmation.twoMinuteConfirmed',
  ]);
  if (explicit != null) return explicit;

  const bias = upper(candidate.nextMoveBias || candidate.direction);
  const expected = bias === 'DOWN' ? 'bearish' : bias === 'UP' ? 'bullish' : null;
  const tf2m = lower(candidate.tf2m || candidate.timeframes?.tf2m || candidate.timeframeAgreement?.tf2m);
  if (expected && tf2m) return tf2m === expected;

  const status = lower(candidate.twoMinuteConfirmationStatus || candidate.confirmation?.twoMinuteStatus);
  if (status) return ['confirmed', 'pass', 'ok', 'aligned'].includes(status);
  return false;
}

function hasClosedCandleConfirmation(candidate = {}) {
  const explicit = boolAt(candidate, [
    'closedCandleConfirmed',
    'closedCandle',
    'candleClosed',
    'barClosed',
    'isClosedCandle',
    'latestCandleClosed',
    'confirmation.closedCandle',
    'candle.closed',
    'bar.closed',
  ]);
  if (explicit != null) return explicit;
  const state = lower(candidate.candleState || candidate.barState || candidate.candle?.state || candidate.bar?.state);
  if (state) return ['closed', 'complete', 'confirmed'].includes(state);
  return false;
}

function hasVolumeConfirmation(candidate = {}, policy = 'normal_or_strong') {
  const explicit = boolAt(candidate, [
    'volumeConfirmed',
    'volumeConfirmation',
    'volumeExpansionConfirmed',
    'volumeContext.confirmed',
    'volumeContext.expansionConfirmed',
    'confirmation.volumeConfirmed',
  ]);
  if (explicit != null) return explicit;
  const state = lower(candidate.volumeState || candidate.volume_state || candidate.volumeContext?.state);
  if (policy === 'strong_or_confirmed') {
    if (ENTRY_VOLUME_STRONG_STATES.has(state)) return true;
  } else if (ENTRY_VOLUME_OK_STATES.has(state)) {
    return true;
  }
  const rvol = finiteNumber(candidate.rvol ?? candidate.relVol20 ?? candidate.relativeVolume ?? candidate.volumeContext?.rvol ?? candidate.volumeContext?.relativeVolume);
  if (rvol != null) return policy === 'strong_or_confirmed' ? rvol >= 1.2 : rvol >= 1.0;
  return false;
}

function hasEmaContext(candidate = {}) {
  if (candidate.emaContext && typeof candidate.emaContext === 'object') {
    return candidate.emaContext.hasContext !== false;
  }
  return Boolean(
    candidate.emaFast != null
    || candidate.emaSlow != null
    || candidate.emaAlignment != null
    || candidate.emaRelation != null
    || candidate.priceVsEma != null
    || candidate.trendDirection != null
  );
}

function trendIsIntact(candidate = {}) {
  const explicit = boolAt(candidate, ['trendIntact', 'emaContext.trendIntact', 'emaTrendIntact']);
  if (explicit != null) return explicit;
  const trend = upper(candidate.trendDirection || candidate.emaContext?.trendDirection || candidate.emaTrend || '');
  if (!trend) return true;
  return ENTRY_LONG_DIRECTIONS.has(trend) || trend === 'UPTREND';
}

function hasEmaPullbackConfirmation(candidate = {}) {
  const explicit = boolAt(candidate, [
    'emaPullbackConfirmed',
    'emaReclaimConfirmed',
    'pullbackReclaimConfirmed',
    'reclaimConfirmed',
    'emaContext.pullbackConfirmed',
    'emaContext.reclaimConfirmed',
    'confirmation.emaPullbackConfirmed',
    'confirmation.reclaimConfirmed',
  ]);
  if (explicit != null) return explicit;
  const relation = lower(candidate.emaRelation || candidate.priceVsEma || candidate.emaContext?.relation || '');
  if (relation) return relation.includes('reclaim') || relation.includes('above') || relation.includes('support');
  return false;
}

function hasVwapContext(candidate = {}) {
  if (candidate.vwapContext && typeof candidate.vwapContext === 'object') {
    return candidate.vwapContext.hasContext !== false;
  }
  return Boolean(
    candidate.vwap != null
    || candidate.vwapDistancePct != null
    || candidate.priceVsVwap != null
    || candidate.closeAboveVwap != null
    || candidate.vwapReclaimConfirmed != null
  );
}

function hasVwapReclaimConfirmation(candidate = {}) {
  const explicit = boolAt(candidate, [
    'vwapReclaimConfirmed',
    'vwapContext.reclaimConfirmed',
    'confirmation.vwapReclaimConfirmed',
    'reclaimConfirmed',
  ]);
  if (explicit === false) return false;
  const closeAbove = boolAt(candidate, [
    'closeAboveVwap',
    'vwapContext.closeAboveVwap',
    'confirmation.closeAboveVwap',
  ]);
  if (explicit === true && closeAbove !== false) return true;
  if (closeAbove === true) return true;
  const relation = lower(candidate.priceVsVwap || candidate.vwapContext?.priceVsVwap || '');
  if (relation) return relation.includes('above') || relation.includes('reclaim');
  const distance = finiteNumber(candidate.vwapDistancePct ?? candidate.vwapContext?.distancePct);
  return distance != null && distance >= 0;
}

function isLateOrExtended(candidate = {}) {
  const explicit = boolAt(candidate, [
    'lateEntry',
    'lateMove',
    'extendedMove',
    'breakoutAlreadyOccurred',
    'extensionMeta.lateMove',
  ]);
  if (explicit === true) return true;
  const level = lower(candidate.extensionLevel || candidate.extensionMeta?.level);
  if (ENTRY_EXTENDED_LEVELS.has(level) && level !== 'none') return true;
  const entryDistance = finiteNumber(candidate.entryDistancePct ?? candidate.distanceFromTriggerPct ?? candidate.vwapContext?.distancePct);
  return entryDistance != null && Math.abs(entryDistance) > 0.6;
}

function observationText(candidate = {}) {
  return [
    candidate.entryReasonSv,
    candidate.entryReason,
    candidate.decisionTextSv,
    candidate.reasonSv,
    candidate.reason,
    candidate.primaryReason,
    candidate.simpleExplanationTextSv,
  ].filter(Boolean).join(' ');
}

function textLooksObservationOnly(candidate = {}) {
  const text = lower(observationText(candidate));
  if (!text) return false;
  return /\b(bevaka|v[aä]nta|watch|monitor|observe|observation)\b/.test(text)
    || text.includes('ny 2m')
    || text.includes('2m-bekr')
    || text.includes('rekyl');
}

function entryNowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function baseEntryContractDecision(contract, candidate, now, marketContext, { entryContractVersion, safety }) {
  return {
    allowed: false,
    strategyId: contract?.strategyId || safeString(strategyIdOf(candidate)),
    reason: null,
    reasonCode: null,
    entryContractVersion,
    checks: {
      contract: contract ? 'pass' : 'blocked',
      subtype: 'pending',
      direction: 'pending',
      status: 'pending',
      confirmation: 'pending',
      freshness: 'pending',
      candle: 'pending',
      session: 'pending',
      volume: 'pending',
      lateEntry: 'pending',
    },
    evidence: {
      generatedAt: entryNowIso(now),
      symbol: candidate?.symbol || null,
      marketType: marketTypeOf(candidate, marketContext),
      session: sessionOf(candidate, marketContext) || null,
      status: lower(candidate?.signalStatus || candidate?.entryStatus || candidate?.status || candidate?.priority || ''),
      signalSubtype: subtypeOf(candidate) || null,
      nextMoveBias: upper(candidate?.nextMoveBias || candidate?.next_move_bias || candidate?.direction || ''),
      confidenceScore: candidate?.confidenceScore ?? null,
      dataFreshness: candidate?.dataFreshness || null,
      extensionLevel: candidate?.extensionLevel || candidate?.extensionMeta?.level || null,
      twoMinuteConfirmed: hasEntryTwoMinuteConfirmation(candidate),
      closedCandleConfirmed: hasClosedCandleConfirmation(candidate),
      volumeConfirmed: null,
      signalAgeMs: null,
      requiredConfirmations: contract ? arr(contract.requiredConfirmations) : [],
      confirmationObserved: [],
    },
    safety,
    ...safety,
  };
}

function blockEntryContract(decision, reasonCode, checkKey, evidence = {}) {
  if (checkKey && decision.checks[checkKey] !== 'blocked') decision.checks[checkKey] = 'blocked';
  decision.allowed = false;
  decision.reason = reasonCode;
  decision.reasonCode = reasonCode;
  decision.evidence = { ...decision.evidence, ...evidence };
  return decision;
}

function passEntryContract(decision, checkKey, evidence = {}) {
  if (checkKey) decision.checks[checkKey] = 'pass';
  decision.evidence = { ...decision.evidence, ...evidence };
  return decision;
}

function evaluateEntryContractPolicy({
  strategyId,
  candidate = {},
  now = new Date(),
  marketContext = {},
  contract = null,
  reasonCodes,
  entryContractVersion,
  safety,
} = {}) {
  const decision = baseEntryContractDecision(contract, candidate, now, marketContext, {
    entryContractVersion,
    safety,
  });

  if (!contract) {
    return blockEntryContract(decision, reasonCodes.CONTRACT_MISSING, 'contract');
  }

  const subtype = subtypeOf(candidate);
  if (!contract.allowedSubtypes.includes(subtype)) {
    return blockEntryContract(decision, reasonCodes.INVALID_SUBTYPE, 'subtype', { observedSubtype: subtype || null });
  }
  passEntryContract(decision, 'subtype', { observedSubtype: subtype });

  const directionDecision = contractAllowsObservedDirection(contract, candidate);
  if (!directionDecision.allowed) {
    return blockEntryContract(decision, reasonCodes.INVALID_DIRECTION, 'direction', {
      directionTokens: directionDecision.directionTokens,
      shortIntentObserved: directionDecision.shortObserved,
      longIntentObserved: directionDecision.longObserved,
      allowedDirections: contract.allowedDirections,
    });
  }
  passEntryContract(decision, 'direction', {
    directionTokens: directionDecision.directionTokens,
    shortIntentObserved: directionDecision.shortObserved,
    longIntentObserved: directionDecision.longObserved,
    allowedDirections: contract.allowedDirections,
  });

  const status = lower(candidate.signalStatus || candidate.entryStatus || candidate.status || candidate.priority || '');
  if (ENTRY_WATCH_STATUSES.has(status)) {
    return blockEntryContract(decision, reasonCodes.WATCH_ONLY, 'status', { observedStatus: status });
  }
  if (status === 'caution') {
    return blockEntryContract(decision, reasonCodes.CAUTION_ONLY, 'status', { observedStatus: status });
  }
  if (!ENTRY_READY_STATUSES.has(status)) {
    const code = ENTRY_WAIT_STATUSES.has(status) || ENTRY_OBSERVATION_STATUSES.has(status)
      ? reasonCodes.STATUS_NOT_READY
      : reasonCodes.STATUS_NOT_READY;
    return blockEntryContract(decision, code, 'status', { observedStatus: status || null });
  }
  passEntryContract(decision, 'status', { observedStatus: status });

  const freshness = upper(candidate.dataFreshness || '');
  const age = signalAgeMs(candidate, now);
  decision.evidence.signalAgeMs = age.signalAgeMs;
  if (contract.requiresFreshData) {
    if (freshness && STALE_FRESHNESS.has(freshness)) {
      return blockEntryContract(decision, reasonCodes.STALE_SIGNAL, 'freshness', { dataFreshness: freshness, signalAgeMs: age.signalAgeMs });
    }
    if (age.signalAgeMs == null) {
      return blockEntryContract(decision, reasonCodes.STALE_SIGNAL, 'freshness', { missingSignalTimestamp: true });
    }
    if (age.signalAgeMs > contract.maxSignalAgeMs) {
      return blockEntryContract(decision, reasonCodes.STALE_SIGNAL, 'freshness', { signalAgeMs: age.signalAgeMs, maxSignalAgeMs: contract.maxSignalAgeMs });
    }
  }
  passEntryContract(decision, 'freshness', { signalAgeMs: age.signalAgeMs, signalAgeSource: age.source, maxSignalAgeMs: contract.maxSignalAgeMs });

  const marketType = marketTypeOf(candidate, marketContext);
  const session = sessionOf(candidate, marketContext);
  if (contract.marketType === 'stocks' && marketType !== 'stocks') {
    return blockEntryContract(decision, reasonCodes.MISSING_MARKET_CONTEXT, 'session', { requiredMarketType: 'stocks', observedMarketType: marketType });
  }
  if (candidate.marketClosed === true || upper(candidate.dataFreshness || '') === 'MARKET_CLOSED') {
    return blockEntryContract(decision, reasonCodes.INVALID_SESSION, 'session', { marketClosed: true, dataFreshness: candidate.dataFreshness || null });
  }
  if (contract.requiresMarketOpen && !sessionAllowedByContract(contract, candidate, marketContext)) {
    return blockEntryContract(decision, reasonCodes.INVALID_SESSION, 'session', {
      observedSession: session,
      observedSessions: observedSessionTokens(candidate, marketContext),
      allowedSessions: contract.allowedSessions,
    });
  }
  passEntryContract(decision, 'session', { observedSession: session || null, observedMarketType: marketType });

  if (contract.requiresClosedCandle && !hasClosedCandleConfirmation(candidate)) {
    return blockEntryContract(decision, reasonCodes.MISSING_CLOSED_CANDLE, 'candle');
  }
  passEntryContract(decision, 'candle', { closedCandleConfirmed: hasClosedCandleConfirmation(candidate) });

  const observedConfirmations = [];
  if (hasEntryTwoMinuteConfirmation(candidate)) observedConfirmations.push('two_minute_confirmation');
  if (hasClosedCandleConfirmation(candidate)) observedConfirmations.push('closed_candle_confirmation');
  if (hasEmaPullbackConfirmation(candidate)) observedConfirmations.push('ema_pullback_reclaim');
  if (hasVwapReclaimConfirmation(candidate)) observedConfirmations.push('vwap_reclaim_confirmation');
  if (hasVolumeConfirmation(candidate, contract.volumePolicy)) observedConfirmations.push('volume_confirmation');
  decision.evidence.confirmationObserved = observedConfirmations;

  if (contract.requiredConfirmations.includes('two_minute_confirmation') && !hasEntryTwoMinuteConfirmation(candidate)) {
    return blockEntryContract(decision, reasonCodes.MISSING_TWO_MINUTE, 'confirmation', { requiredConfirmation: 'two_minute_confirmation' });
  }
  if (contract.requiresEmaContext && !hasEmaContext(candidate)) {
    return blockEntryContract(decision, reasonCodes.MISSING_EMA_PULLBACK, 'confirmation', { missingEmaContext: true });
  }
  if (contract.requiresEmaContext && !trendIsIntact(candidate)) {
    return blockEntryContract(decision, reasonCodes.MISSING_EMA_PULLBACK, 'confirmation', { brokenTrend: true });
  }
  if (contract.requiredConfirmations.includes('ema_pullback_reclaim') && !hasEmaPullbackConfirmation(candidate)) {
    return blockEntryContract(decision, reasonCodes.MISSING_EMA_PULLBACK, 'confirmation', { requiredConfirmation: 'ema_pullback_reclaim' });
  }
  if (contract.requiresVwapContext && !hasVwapContext(candidate)) {
    return blockEntryContract(decision, reasonCodes.MISSING_VWAP_RECLAIM, 'confirmation', { missingVwapContext: true });
  }
  if (contract.requiredConfirmations.includes('vwap_reclaim_confirmation') && !hasVwapReclaimConfirmation(candidate)) {
    return blockEntryContract(decision, reasonCodes.MISSING_VWAP_RECLAIM, 'confirmation', { requiredConfirmation: 'vwap_reclaim_confirmation' });
  }
  if (contract.requiredConfirmations.includes('volume_confirmation') && !hasVolumeConfirmation(candidate, contract.volumePolicy)) {
    return blockEntryContract(decision, reasonCodes.MISSING_VOLUME, 'volume', { requiredConfirmation: 'volume_confirmation' });
  }
  if (contract.volumePolicy && !hasVolumeConfirmation(candidate, contract.volumePolicy)) {
    return blockEntryContract(decision, reasonCodes.MISSING_VOLUME, 'volume', { volumePolicy: contract.volumePolicy });
  }
  passEntryContract(decision, 'confirmation', { confirmationObserved: observedConfirmations });
  passEntryContract(decision, 'volume', { volumeConfirmed: hasVolumeConfirmation(candidate, contract.volumePolicy) });

  if ((contract.lateEntryPolicy === 'block' || contract.extendedMovePolicy === 'block') && isLateOrExtended(candidate)) {
    return blockEntryContract(decision, reasonCodes.LATE_EXTENDED_ENTRY, 'lateEntry');
  }
  if (textLooksObservationOnly(candidate)) {
    return blockEntryContract(decision, reasonCodes.WATCH_ONLY, 'lateEntry', { observationTextFallback: true });
  }
  passEntryContract(decision, 'lateEntry', { lateOrExtended: false });

  decision.allowed = true;
  decision.reason = null;
  decision.reasonCode = null;
  return decision;
}

const entryContract = Object.freeze({
  safeString,
  upper,
  lower,
  arr,
  finiteNumber,
  clone,
  strategyIdOf,
  subtypeOf,
  marketTypeOf,
  sessionOf,
  observedSessionTokens,
  sessionAllowedByContract,
  directionTokens,
  contractAllowsObservedDirection,
  signalAgeMs,
  hasTwoMinuteConfirmation: hasEntryTwoMinuteConfirmation,
  hasClosedCandleConfirmation,
  hasVolumeConfirmation,
  hasEmaContext,
  trendIsIntact,
  hasEmaPullbackConfirmation,
  hasVwapContext,
  hasVwapReclaimConfirmation,
  isLateOrExtended,
  textLooksObservationOnly,
  evaluateEntryContractPolicy,
});

module.exports = {
  STRATEGY_POLICY_ENGINE_VERSION,
  PRODUCER_CONFIRMATION_VERSION,
  READINESS_ENGINE_VERSION,
  SAFETY,
  POLICY_ACTIONS,
  VERDICTS: READINESS_VERDICTS,
  REASONS: READINESS_REASONS,
  LEGACY_REASON_MAP,
  PRODUCER_POLICY_METADATA,
  buildEntryContractPolicy,
  entryContract,
  directionAllowed,
  sessionAllowed,
  evaluateReadinessPolicy,
  evaluateExtensionPolicy,
  latestClosedCandleMeta,
  volumeEvidence,
  buildEmaContext,
  buildVwapContext,
  hasTwoMinuteConfirmation,
  classifyExtension,
  applyExtensionGuard,
  candleScoreOpposesTf2m,
  buildTwoMinuteConflict,
  blockerLabel,
  uniqueLabels,
  isStockMarket,
  isDataStale,
  buildDecisionText,
  qualifiesForWatchLayer,
  buildFamilyCalibrationHints,
  applyFamilyCalibrationPriority,
  updateExplanationConclusion,
  buildBlockers,
  buildPlainExplanation,
  buildProducerConfirmation,
  confirmedEntryPromotion,
};
