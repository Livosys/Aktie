'use strict';

const fs = require('fs');
const path = require('path');

const catalogService = require('./daytradingStrategyCatalogService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const PAPER_ENTRY_CONTRACT_VERSION = 'paper_entry_contract_v1';

const EVENTS_FILE = path.resolve(
  process.env.PAPER_ENTRY_CONTRACT_EVENTS_FILE
    || path.resolve(__dirname, '../../data/paper-trading/events.jsonl'),
);
const TRADES_FILE = path.resolve(
  process.env.PAPER_ENTRY_CONTRACT_TRADES_FILE
    || path.resolve(__dirname, '../../data/paper-trading/trades.jsonl'),
);

const REASON_CODES = Object.freeze({
  STATUS_NOT_READY: 'paper_entry_status_not_ready',
  WATCH_ONLY: 'paper_entry_watch_only',
  CAUTION_ONLY: 'paper_entry_caution_only',
  MISSING_REQUIRED_CONFIRMATION: 'missing_required_confirmation',
  MISSING_TWO_MINUTE: 'missing_two_minute_confirmation',
  MISSING_CLOSED_CANDLE: 'missing_closed_candle_confirmation',
  STALE_SIGNAL: 'stale_strategy_signal',
  INVALID_SUBTYPE: 'invalid_strategy_subtype',
  INVALID_DIRECTION: 'invalid_strategy_direction',
  LATE_EXTENDED_ENTRY: 'late_extended_entry',
  MISSING_VOLUME: 'missing_volume_confirmation',
  MISSING_VWAP_RECLAIM: 'missing_vwap_reclaim_confirmation',
  MISSING_EMA_PULLBACK: 'missing_ema_pullback_confirmation',
  MISSING_MARKET_CONTEXT: 'missing_market_context',
  INVALID_SESSION: 'invalid_session',
  CONTRACT_MISSING: 'entry_contract_missing',
});

const ENTRY_CONTRACT_BLOCK_REASONS = new Set(Object.values(REASON_CODES));

const OBSERVATION_STATUSES = new Set(['watch', 'caution', 'wait', 'avoid', 'no_trade', 'observe', 'observing']);
const WATCH_STATUSES = new Set(['watch', 'observe', 'observing']);
const WAIT_STATUSES = new Set(['wait', 'avoid', 'no_trade']);
const READY_STATUSES = new Set(['active', 'confirmed', 'entry', 'entry_ready', 'ready']);
const LONG_DIRECTIONS = new Set(['UP', 'LONG', 'BUY', 'BULL', 'BULLISH']);
const SHORT_DIRECTIONS = new Set(['DOWN', 'SHORT', 'SELL', 'BEAR', 'BEARISH']);
const STALE_FRESHNESS = new Set(['STALE', 'MARKET_CLOSED', 'DELAYED', 'MISSING', 'UNKNOWN']);
const VOLUME_OK_STATES = new Set(['normal', 'strong', 'high', 'elevated']);
const VOLUME_STRONG_STATES = new Set(['strong', 'high', 'elevated']);
const EXTENDED_LEVELS = new Set(['mild', 'medium', 'extreme', 'late', 'extended']);

const CONTRACTS = Object.freeze({
  narrow_state_expansion_long: Object.freeze({
    strategyId: 'narrow_state_expansion_long',
    version: PAPER_ENTRY_CONTRACT_VERSION,
    status: 'ready',
    allowedSubtypes: Object.freeze(['NARROW_BULL_ENTRY']),
    allowedDirections: Object.freeze(['LONG', 'UP']),
    allowedStatuses: Object.freeze(['active', 'confirmed', 'entry', 'entry_ready', 'ready']),
    blockedStatuses: Object.freeze(['watch', 'caution', 'wait', 'avoid', 'no_trade']),
    requiredConfirmations: Object.freeze(['two_minute_confirmation', 'closed_candle_confirmation']),
    requiresFreshData: true,
    maxSignalAgeMs: 180000,
    requiresClosedCandle: true,
    requiresMarketOpen: false,
    allowedSessions: Object.freeze(['24_7', 'crypto_24_7', 'regular', 'rth', 'nyse', 'nasdaq', 'us_stocks']),
    lateEntryPolicy: 'block',
    extendedMovePolicy: 'block',
    volumePolicy: 'normal_or_strong',
  }),
  ema_pullback_continuation: Object.freeze({
    strategyId: 'ema_pullback_continuation',
    version: PAPER_ENTRY_CONTRACT_VERSION,
    status: 'ready',
    allowedSubtypes: Object.freeze(['EMA_PULLBACK_UP']),
    allowedDirections: Object.freeze(['LONG', 'UP']),
    allowedStatuses: Object.freeze(['active', 'confirmed', 'entry', 'entry_ready', 'ready']),
    blockedStatuses: Object.freeze(['watch', 'caution', 'wait', 'avoid', 'no_trade']),
    requiredConfirmations: Object.freeze(['ema_pullback_reclaim', 'closed_candle_confirmation']),
    requiresFreshData: true,
    maxSignalAgeMs: 180000,
    requiresClosedCandle: true,
    requiresMarketOpen: false,
    allowedSessions: Object.freeze(['24_7', 'crypto_24_7', 'regular', 'rth', 'nyse', 'nasdaq', 'us_stocks']),
    lateEntryPolicy: 'block',
    extendedMovePolicy: 'block',
    volumePolicy: 'normal_or_strong',
    requiresEmaContext: true,
  }),
  vwap_volume_breakout_long: Object.freeze({
    strategyId: 'vwap_volume_breakout_long',
    version: PAPER_ENTRY_CONTRACT_VERSION,
    status: 'ready',
    allowedSubtypes: Object.freeze(['VWAP_RECLAIM_UP']),
    allowedDirections: Object.freeze(['LONG', 'UP']),
    allowedStatuses: Object.freeze(['active', 'confirmed', 'entry', 'entry_ready', 'ready']),
    blockedStatuses: Object.freeze(['watch', 'caution', 'wait', 'avoid', 'no_trade']),
    requiredConfirmations: Object.freeze(['vwap_reclaim_confirmation', 'closed_candle_confirmation', 'volume_confirmation']),
    requiresFreshData: true,
    maxSignalAgeMs: 180000,
    requiresClosedCandle: true,
    requiresMarketOpen: true,
    allowedSessions: Object.freeze(['regular', 'rth', 'nyse', 'nasdaq', 'us_stocks']),
    lateEntryPolicy: 'block',
    extendedMovePolicy: 'block',
    volumePolicy: 'strong_or_confirmed',
    requiresVwapContext: true,
    marketType: 'stocks',
  }),
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function entryContractsEnabled() {
  return String(process.env.PAPER_ENTRY_CONTRACTS_ENABLED || 'false').toLowerCase() === 'true';
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
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

function getEntryContract(strategyId) {
  const id = safeString(strategyId);
  if (!id || !CONTRACTS[id]) return null;
  return clone(CONTRACTS[id]);
}

function listEntryContracts() {
  return Object.keys(CONTRACTS).sort().map((id) => getEntryContract(id));
}

function getCatalogStrategies() {
  try {
    return arr(catalogService.getCatalog().strategies).filter((row) => row && row.id);
  } catch (_) {
    return [];
  }
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
  if (tokens.some((token) => SHORT_DIRECTIONS.has(token))) return true;

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
  if (tokens.some((token) => LONG_DIRECTIONS.has(token))) return true;
  const subtype = subtypeOf(candidate);
  return subtype === 'NARROW_BULL_ENTRY' || subtype === 'EMA_PULLBACK_UP' || subtype === 'VWAP_RECLAIM_UP';
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

function hasTwoMinuteConfirmation(candidate = {}) {
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
    if (VOLUME_STRONG_STATES.has(state)) return true;
  } else if (VOLUME_OK_STATES.has(state)) {
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
  return LONG_DIRECTIONS.has(trend) || trend === 'UPTREND';
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
  if (EXTENDED_LEVELS.has(level) && level !== 'none') return true;
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

function baseDecision(contract, candidate, now, marketContext) {
  return {
    allowed: false,
    strategyId: contract?.strategyId || safeString(strategyIdOf(candidate)),
    reason: null,
    reasonCode: null,
    entryContractVersion: PAPER_ENTRY_CONTRACT_VERSION,
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
      generatedAt: nowIso(now),
      symbol: candidate?.symbol || null,
      marketType: marketTypeOf(candidate, marketContext),
      session: sessionOf(candidate, marketContext) || null,
      status: lower(candidate?.status || candidate?.priority || ''),
      signalSubtype: subtypeOf(candidate) || null,
      nextMoveBias: upper(candidate?.nextMoveBias || candidate?.next_move_bias || candidate?.direction || ''),
      confidenceScore: candidate?.confidenceScore ?? null,
      dataFreshness: candidate?.dataFreshness || null,
      extensionLevel: candidate?.extensionLevel || candidate?.extensionMeta?.level || null,
      twoMinuteConfirmed: hasTwoMinuteConfirmation(candidate),
      closedCandleConfirmed: hasClosedCandleConfirmation(candidate),
      volumeConfirmed: null,
      signalAgeMs: null,
      requiredConfirmations: contract ? arr(contract.requiredConfirmations) : [],
      confirmationObserved: [],
    },
    safety: SAFETY,
    ...SAFETY,
  };
}

function block(decision, reasonCode, checkKey, evidence = {}) {
  if (checkKey && decision.checks[checkKey] !== 'blocked') decision.checks[checkKey] = 'blocked';
  decision.allowed = false;
  decision.reason = reasonCode;
  decision.reasonCode = reasonCode;
  decision.evidence = { ...decision.evidence, ...evidence };
  return decision;
}

function pass(decision, checkKey, evidence = {}) {
  if (checkKey) decision.checks[checkKey] = 'pass';
  decision.evidence = { ...decision.evidence, ...evidence };
  return decision;
}

function evaluatePaperEntryContract({ strategyId, candidate = {}, now = new Date(), marketContext = {} } = {}) {
  const id = safeString(strategyId) || safeString(strategyIdOf(candidate));
  const contract = getEntryContract(id);
  const decision = baseDecision(contract, candidate, now, marketContext);

  if (!contract) {
    return block(decision, REASON_CODES.CONTRACT_MISSING, 'contract');
  }

  const subtype = subtypeOf(candidate);
  if (!contract.allowedSubtypes.includes(subtype)) {
    return block(decision, REASON_CODES.INVALID_SUBTYPE, 'subtype', { observedSubtype: subtype || null });
  }
  pass(decision, 'subtype', { observedSubtype: subtype });

  if (hasShortIntent(candidate) || !hasLongDirection(candidate)) {
    return block(decision, REASON_CODES.INVALID_DIRECTION, 'direction', {
      directionTokens: directionTokens(candidate),
      shortIntentObserved: hasShortIntent(candidate),
    });
  }
  pass(decision, 'direction', { directionTokens: directionTokens(candidate) });

  const status = lower(candidate.status || candidate.priority || '');
  if (WATCH_STATUSES.has(status)) {
    return block(decision, REASON_CODES.WATCH_ONLY, 'status', { observedStatus: status });
  }
  if (status === 'caution') {
    return block(decision, REASON_CODES.CAUTION_ONLY, 'status', { observedStatus: status });
  }
  if (!READY_STATUSES.has(status)) {
    const code = WAIT_STATUSES.has(status) || OBSERVATION_STATUSES.has(status)
      ? REASON_CODES.STATUS_NOT_READY
      : REASON_CODES.STATUS_NOT_READY;
    return block(decision, code, 'status', { observedStatus: status || null });
  }
  pass(decision, 'status', { observedStatus: status });

  const freshness = upper(candidate.dataFreshness || '');
  const age = signalAgeMs(candidate, now);
  decision.evidence.signalAgeMs = age.signalAgeMs;
  if (contract.requiresFreshData) {
    if (freshness && STALE_FRESHNESS.has(freshness)) {
      return block(decision, REASON_CODES.STALE_SIGNAL, 'freshness', { dataFreshness: freshness, signalAgeMs: age.signalAgeMs });
    }
    if (age.signalAgeMs == null) {
      return block(decision, REASON_CODES.STALE_SIGNAL, 'freshness', { missingSignalTimestamp: true });
    }
    if (age.signalAgeMs > contract.maxSignalAgeMs) {
      return block(decision, REASON_CODES.STALE_SIGNAL, 'freshness', { signalAgeMs: age.signalAgeMs, maxSignalAgeMs: contract.maxSignalAgeMs });
    }
  }
  pass(decision, 'freshness', { signalAgeMs: age.signalAgeMs, signalAgeSource: age.source, maxSignalAgeMs: contract.maxSignalAgeMs });

  const marketType = marketTypeOf(candidate, marketContext);
  const session = sessionOf(candidate, marketContext);
  if (contract.marketType === 'stocks' && marketType !== 'stocks') {
    return block(decision, REASON_CODES.MISSING_MARKET_CONTEXT, 'session', { requiredMarketType: 'stocks', observedMarketType: marketType });
  }
  if (candidate.marketClosed === true || upper(candidate.dataFreshness || '') === 'MARKET_CLOSED') {
    return block(decision, REASON_CODES.INVALID_SESSION, 'session', { marketClosed: true, dataFreshness: candidate.dataFreshness || null });
  }
  if (contract.requiresMarketOpen && session && !contract.allowedSessions.includes(session)) {
    return block(decision, REASON_CODES.INVALID_SESSION, 'session', { observedSession: session, allowedSessions: contract.allowedSessions });
  }
  pass(decision, 'session', { observedSession: session || null, observedMarketType: marketType });

  if (contract.requiresClosedCandle && !hasClosedCandleConfirmation(candidate)) {
    return block(decision, REASON_CODES.MISSING_CLOSED_CANDLE, 'candle');
  }
  pass(decision, 'candle', { closedCandleConfirmed: hasClosedCandleConfirmation(candidate) });

  const observedConfirmations = [];
  if (hasTwoMinuteConfirmation(candidate)) observedConfirmations.push('two_minute_confirmation');
  if (hasClosedCandleConfirmation(candidate)) observedConfirmations.push('closed_candle_confirmation');
  if (hasEmaPullbackConfirmation(candidate)) observedConfirmations.push('ema_pullback_reclaim');
  if (hasVwapReclaimConfirmation(candidate)) observedConfirmations.push('vwap_reclaim_confirmation');
  if (hasVolumeConfirmation(candidate, contract.volumePolicy)) observedConfirmations.push('volume_confirmation');
  decision.evidence.confirmationObserved = observedConfirmations;

  if (contract.requiredConfirmations.includes('two_minute_confirmation') && !hasTwoMinuteConfirmation(candidate)) {
    return block(decision, REASON_CODES.MISSING_TWO_MINUTE, 'confirmation', { requiredConfirmation: 'two_minute_confirmation' });
  }
  if (contract.requiresEmaContext && !hasEmaContext(candidate)) {
    return block(decision, REASON_CODES.MISSING_EMA_PULLBACK, 'confirmation', { missingEmaContext: true });
  }
  if (contract.requiresEmaContext && !trendIsIntact(candidate)) {
    return block(decision, REASON_CODES.MISSING_EMA_PULLBACK, 'confirmation', { brokenTrend: true });
  }
  if (contract.requiredConfirmations.includes('ema_pullback_reclaim') && !hasEmaPullbackConfirmation(candidate)) {
    return block(decision, REASON_CODES.MISSING_EMA_PULLBACK, 'confirmation', { requiredConfirmation: 'ema_pullback_reclaim' });
  }
  if (contract.requiresVwapContext && !hasVwapContext(candidate)) {
    return block(decision, REASON_CODES.MISSING_VWAP_RECLAIM, 'confirmation', { missingVwapContext: true });
  }
  if (contract.requiredConfirmations.includes('vwap_reclaim_confirmation') && !hasVwapReclaimConfirmation(candidate)) {
    return block(decision, REASON_CODES.MISSING_VWAP_RECLAIM, 'confirmation', { requiredConfirmation: 'vwap_reclaim_confirmation' });
  }
  if (contract.requiredConfirmations.includes('volume_confirmation') && !hasVolumeConfirmation(candidate, contract.volumePolicy)) {
    return block(decision, REASON_CODES.MISSING_VOLUME, 'volume', { requiredConfirmation: 'volume_confirmation' });
  }
  if (contract.volumePolicy && !hasVolumeConfirmation(candidate, contract.volumePolicy)) {
    return block(decision, REASON_CODES.MISSING_VOLUME, 'volume', { volumePolicy: contract.volumePolicy });
  }
  pass(decision, 'confirmation', { confirmationObserved: observedConfirmations });
  pass(decision, 'volume', { volumeConfirmed: hasVolumeConfirmation(candidate, contract.volumePolicy) });

  if ((contract.lateEntryPolicy === 'block' || contract.extendedMovePolicy === 'block') && isLateOrExtended(candidate)) {
    return block(decision, REASON_CODES.LATE_EXTENDED_ENTRY, 'lateEntry');
  }
  if (textLooksObservationOnly(candidate)) {
    return block(decision, REASON_CODES.WATCH_ONLY, 'lateEntry', { observationTextFallback: true });
  }
  pass(decision, 'lateEntry', { lateOrExtended: false });

  decision.allowed = true;
  decision.reason = null;
  decision.reasonCode = null;
  return decision;
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function timeOf(row = {}) {
  return row.timestamp || row.entryTime || row.opened_at || row.closed_at || row.exitTime || row.at || null;
}

function parseTime(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function emptyDiagnostics(strategyId) {
  return {
    strategyId,
    candidates: 0,
    contractPass: 0,
    contractBlock: 0,
    blockReasons: {},
    latestContractBlock: null,
    commonBlocker: null,
    trades: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    timeoutRate: null,
    avgMfe: null,
    avgMae: null,
    latestTrade: null,
  };
}

function avg(nums) {
  const values = nums.map(Number).filter(Number.isFinite);
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Math.round(value * (10 ** digits)) / (10 ** digits) : null;
}

function buildEntryContractDiagnostics(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const sinceMs = Number.isFinite(Number(options.sinceMs))
    ? Number(options.sinceMs)
    : now.getTime() - (Number(options.windowHours || 24) * 60 * 60 * 1000);
  const strategyIds = new Set([
    ...getCatalogStrategies().map((row) => row.id),
    ...Object.keys(CONTRACTS),
  ]);
  const byStrategy = new Map([...strategyIds].map((id) => [id, emptyDiagnostics(id)]));

  for (const row of readJsonl(EVENTS_FILE)) {
    const time = parseTime(timeOf(row));
    if (time == null || time < sinceMs) continue;
    const id = strategyIdOf(row);
    if (!id) continue;
    if (!byStrategy.has(id)) byStrategy.set(id, emptyDiagnostics(id));
    const diag = byStrategy.get(id);
    diag.candidates += 1;
    const reason = row.reasonCode || row.blockedReasonCode || row.blockedReason || null;
    const isContractEvent = row.entryContractVersion || ENTRY_CONTRACT_BLOCK_REASONS.has(reason);
    if (isContractEvent && row.decision !== 'allowed') {
      diag.contractBlock += 1;
      if (reason) diag.blockReasons[reason] = (diag.blockReasons[reason] || 0) + 1;
      if (!diag.latestContractBlock || String(row.timestamp || '') > String(diag.latestContractBlock.at || '')) {
        diag.latestContractBlock = {
          at: row.timestamp || null,
          symbol: row.symbol || null,
          signalSubtype: row.signalSubtype || null,
          status: row.status || null,
          reasonCode: reason,
          signalAgeMs: row.signalAgeMs ?? row.entryContractEvidence?.signalAgeMs ?? null,
          evidence: row.entryContractEvidence || null,
        };
      }
    } else if (row.entryContractDecision === 'pass' || row.entryContractAllowed === true) {
      diag.contractPass += 1;
    }
  }

  for (const trade of readJsonl(TRADES_FILE)) {
    const time = parseTime(trade.entryTime || trade.opened_at);
    if (time == null || time < sinceMs) continue;
    const id = strategyIdOf(trade);
    if (!id) continue;
    if (!byStrategy.has(id)) byStrategy.set(id, emptyDiagnostics(id));
    const diag = byStrategy.get(id);
    diag.trades += 1;
    const result = upper(trade.result || trade.exitReason || '');
    if (result.includes('WIN')) diag.wins += 1;
    else if (result.includes('LOSS')) diag.losses += 1;
    else if (result.includes('TIMEOUT')) diag.timeouts += 1;
    if (!diag.latestTrade || String(trade.entryTime || trade.opened_at || '') > String(diag.latestTrade.entryTime || '')) {
      diag.latestTrade = {
        tradeId: trade.tradeId || null,
        entryTime: trade.entryTime || trade.opened_at || null,
        symbol: trade.symbol || null,
        signalSubtype: trade.signalSubtype || trade.signal_subtype || null,
        statusAtEntry: trade.statusAtEntry || null,
        result: trade.result || null,
        exitReason: trade.exitReason || null,
        mfePct: trade.mfePct ?? trade.maxFavorablePct ?? null,
        maePct: trade.maePct ?? trade.maxAdversePct ?? null,
      };
    }
  }

  for (const diag of byStrategy.values()) {
    const ranked = Object.entries(diag.blockReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    diag.commonBlocker = ranked[0] ? { reasonCode: ranked[0][0], count: ranked[0][1] } : null;
    diag.timeoutRate = diag.trades > 0 ? round((diag.timeouts / diag.trades) * 100, 2) : null;
    const trades = readJsonl(TRADES_FILE).filter((trade) => {
      const time = parseTime(trade.entryTime || trade.opened_at);
      return time != null && time >= sinceMs && strategyIdOf(trade) === diag.strategyId;
    });
    diag.avgMfe = round(avg(trades.map((trade) => trade.mfePct ?? trade.maxFavorablePct)));
    diag.avgMae = round(avg(trades.map((trade) => trade.maePct ?? trade.maxAdversePct)));
  }

  return {
    status: 'ok',
    generatedAt: nowIso(now),
    since: new Date(sinceMs).toISOString(),
    windowHours: Math.round(((now.getTime() - sinceMs) / 36_000)) / 100,
    byStrategyId: Object.fromEntries([...byStrategy.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    safety: SAFETY,
    ...SAFETY,
  };
}

function contractSummaryForStrategy(strategy = {}, diagnostics = null) {
  const contract = getEntryContract(strategy.id || strategy.strategyId);
  const diag = diagnostics && diagnostics.byStrategyId ? diagnostics.byStrategyId[strategy.id || strategy.strategyId] : null;
  return {
    strategyId: strategy.id || strategy.strategyId || null,
    displayName: strategy.name || strategy.displayName || strategy.strategyId || strategy.id || null,
    family: strategy.family || null,
    direction: strategy.direction || null,
    status: contract ? 'ready' : 'missing',
    entryContractReady: Boolean(contract),
    entryContractVersion: contract ? contract.version : null,
    contract: contract ? {
      version: contract.version,
      allowedSubtypes: arr(contract.allowedSubtypes),
      allowedStatuses: arr(contract.allowedStatuses),
      blockedStatuses: arr(contract.blockedStatuses),
      requiredConfirmations: arr(contract.requiredConfirmations),
      maxSignalAgeMs: contract.maxSignalAgeMs,
      requiresClosedCandle: contract.requiresClosedCandle === true,
      requiresMarketOpen: contract.requiresMarketOpen === true,
      allowedSessions: arr(contract.allowedSessions),
      lateEntryPolicy: contract.lateEntryPolicy,
      extendedMovePolicy: contract.extendedMovePolicy,
    } : null,
    diagnostics: diag || emptyDiagnostics(strategy.id || strategy.strategyId || null),
    safety: SAFETY,
    ...SAFETY,
  };
}

function buildEntryContractsResponse(options = {}) {
  const diagnostics = buildEntryContractDiagnostics(options);
  const strategies = getCatalogStrategies().map((strategy) => contractSummaryForStrategy(strategy, diagnostics));
  const ready = strategies.filter((row) => row.entryContractReady).length;
  return {
    status: 'ok',
    generatedAt: nowIso(options.now || new Date()),
    entryContractsEnabled: entryContractsEnabled(),
    entryContractVersion: PAPER_ENTRY_CONTRACT_VERSION,
    summary: {
      totalStrategies: strategies.length,
      ready,
      missing: strategies.length - ready,
      contractPass: strategies.reduce((sum, row) => sum + (row.diagnostics?.contractPass || 0), 0),
      contractBlock: strategies.reduce((sum, row) => sum + (row.diagnostics?.contractBlock || 0), 0),
      trades: strategies.reduce((sum, row) => sum + (row.diagnostics?.trades || 0), 0),
    },
    strategies,
    diagnostics: {
      since: diagnostics.since,
      windowHours: diagnostics.windowHours,
    },
    safety: SAFETY,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  PAPER_ENTRY_CONTRACT_VERSION,
  REASON_CODES,
  ENTRY_CONTRACT_BLOCK_REASONS,
  entryContractsEnabled,
  getEntryContract,
  listEntryContracts,
  evaluatePaperEntryContract,
  buildEntryContractDiagnostics,
  buildEntryContractsResponse,
  _internal: {
    CONTRACTS,
    hasTwoMinuteConfirmation,
    hasClosedCandleConfirmation,
    hasVolumeConfirmation,
    hasEmaPullbackConfirmation,
    hasVwapReclaimConfirmation,
    isLateOrExtended,
    signalAgeMs,
    textLooksObservationOnly,
  },
};
