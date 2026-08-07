'use strict';

// Producentadaptrar — råsignal ⇒ Canonical Signal.
//
// Adaptern är avsiktligt tunn och gör EN sak: extraherar fakta. Den fattar
// aldrig ett beslut och den ändrar aldrig sin producent.
//
// Faktaextraktionen delegerar till de predikat som redan används av
// paperStrategyEntryContractService (exponerade via _internal). Det är
// medvetet: varje egen omtolkning av "är 2m bekräftad?" skulle införa drift
// mot dagens beslut, och drift är precis vad shadow-läget ska mäta bort.
// Predikat som inte är exporterade speglas nedan med kommentar om källraden.

const entryContracts = require('../paperStrategyEntryContractService');
const lifecycleIdentity = require('../futuresLifecycleIdentityService');
const { createCanonicalSignal } = require('./canonicalSignal');

const H = entryContracts._internal;

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'canonical_signal_adapter',
});

function lower(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function upper(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

// Spegling av paperStrategyEntryContractService.js:301 (subtypeOf)
function subtypeOf(candidate = {}) {
  return upper(candidate.signalSubtype || candidate.signal_subtype || candidate.setup
    || candidate.raw_strategy || candidate.eventType || candidate.strategy || '') || null;
}

// Spegling av paperStrategyEntryContractService.js:292 (strategyIdOf)
function strategyIdOf(row = {}) {
  return row.strategyId || row.strategy_id || row.resolvedStrategyId
    || row.sourceStrategyId || row.canonicalStrategyId || null;
}

// Spegling av paperStrategyEntryContractService.js:305 (marketTypeOf)
function marketTypeOf(candidate = {}, marketContext = {}) {
  const symbol = upper(candidate.symbol);
  const market = lower(candidate.marketType || candidate.market || candidate.marketGroup
    || candidate.market_group || marketContext.marketType || marketContext.market || '');
  if (market === 'crypto' || market.includes('crypto') || symbol.endsWith('USDT')) return 'crypto';
  if (market === 'stocks' || market === 'stock' || market.includes('stocks') || market.includes('equity')) return 'stocks';
  return market || 'stocks';
}

// Spegling av paperStrategyEntryContractService.js:553 (hasEmaContext)
function hasEmaContext(candidate = {}) {
  if (candidate.emaContext && typeof candidate.emaContext === 'object') {
    return candidate.emaContext.hasContext !== false;
  }
  return Boolean(candidate.emaFast != null || candidate.emaSlow != null || candidate.emaAlignment != null
    || candidate.emaRelation != null || candidate.priceVsEma != null || candidate.trendDirection != null);
}

// Spegling av paperStrategyEntryContractService.js:592 (hasVwapContext)
function hasVwapContext(candidate = {}) {
  if (candidate.vwapContext && typeof candidate.vwapContext === 'object') {
    return candidate.vwapContext.hasContext !== false;
  }
  return Boolean(candidate.vwap != null || candidate.vwapDistancePct != null || candidate.priceVsVwap != null
    || candidate.closeAboveVwap != null || candidate.vwapReclaimConfirmed != null);
}

// Spegling av paperStrategyEntryContractService.js:567 (trendIsIntact)
function trendIsIntact(candidate = {}) {
  const explicit = [candidate.trendIntact, candidate.emaContext?.trendIntact, candidate.emaTrendIntact]
    .find((v) => v === true || v === false);
  if (explicit != null) return explicit;
  const trend = upper(candidate.trendDirection || candidate.emaContext?.trendDirection || candidate.emaTrend || '');
  if (!trend) return true;
  return ['UP', 'LONG', 'BUY', 'BULL', 'BULLISH', 'UPTREND'].includes(trend);
}

function directionOf(candidate = {}) {
  const raw = upper(candidate.direction || candidate.nextMoveBias || candidate.next_move_bias || '');
  if (['LONG', 'UP', 'BUY', 'BULL', 'BULLISH'].includes(raw)) return 'LONG';
  if (['SHORT', 'DOWN', 'SELL', 'BEAR', 'BEARISH'].includes(raw)) return 'SHORT';
  return null;
}

// Spegling av paperStrategyEntryContractService.js:313 (sessionOf)
function sessionOf(candidate = {}, marketContext = {}) {
  return lower(candidate.session || candidate.marketSession || candidate.market_session
    || marketContext.session || marketContext.marketSession || '') || null;
}

// Spegling av paperStrategyEntryContractService.js:332 (observedSessionTokens).
// Grinden jämför mot HELA mängden, inte mot ett fält.
function sessionTokensOf(candidate = {}, marketContext = {}) {
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

// Gemensam evidensextraktion. Volympolicyn påverkar hasVolumeConfirmation, så
// den läses per strategi ur kontraktet i stället för att hårdkodas här.
function buildEvidenceFrom(candidate, { now, extensionMeasure, marketContext = {} }) {
  const strategyId = strategyIdOf(candidate);
  const contract = strategyId ? entryContracts.getEntryContract(strategyId) : null;
  const volumePolicy = contract?.volumePolicy || 'normal_or_strong';

  const twoMinute = H.hasTwoMinuteConfirmation(candidate);
  const closedCandle = H.hasClosedCandleConfirmation(candidate);
  const emaPullback = H.hasEmaPullbackConfirmation(candidate);
  const vwapReclaim = H.hasVwapReclaimConfirmation(candidate);
  const volumeOk = H.hasVolumeConfirmation(candidate, volumePolicy);
  const age = H.signalAgeMs(candidate, now);

  const confirmations = [];
  if (twoMinute) confirmations.push('two_minute_confirmation');
  if (closedCandle) confirmations.push('closed_candle_confirmation');
  if (emaPullback) confirmations.push('ema_pullback_reclaim');
  if (vwapReclaim) confirmations.push('vwap_reclaim_confirmation');
  if (volumeOk) confirmations.push('volume_confirmation');

  const extensionValue = extensionMeasure === 'price_to_zone_atr'
    ? candidate.extensionMeta?.priceToZoneAtr
    : null;

  return {
    extension: {
      measure: extensionMeasure,
      value: extensionValue,
      level: candidate.extensionLevel || candidate.extensionMeta?.level || null,
    },
    volume: {
      rvol: candidate.rvol ?? candidate.relVol20 ?? candidate.volumeContext?.rvol,
      state: candidate.volumeState || candidate.volumeContext?.state,
    },
    timeframes: {
      tf2m: candidate.tf2m || candidate.timeframes?.tf2m || candidate.timeframeAgreement?.tf2m,
      agreementCount: candidate.agreementCount ?? candidate.timeframes?.agreementCount,
    },
    candle: {
      closedCandleConfirmed: closedCandle,
      candleTimestamp: candidate.candleTimestamp || candidate.signalTimestamp,
      signalAgeMs: age.signalAgeMs,
    },
    confirmations,
    context: {
      dataFreshness: candidate.dataFreshness,
      session: sessionOf(candidate, marketContext),
      sessionTokens: sessionTokensOf(candidate, marketContext),
      isRth: candidate.isRth === true ? true : (candidate.isRth === false ? false : null),
      marketClosed: candidate.marketClosed === true || upper(candidate.dataFreshness || '') === 'MARKET_CLOSED',
      emaContextPresent: hasEmaContext(candidate),
      vwapContextPresent: hasVwapContext(candidate),
      trendIntact: trendIsIntact(candidate),
      lateOrExtended: H.isLateOrExtended(candidate),
      observationTextOnly: H.textLooksObservationOnly(candidate),
    },
  };
}

function baseFrom(candidate, { producerId, producerType, extensionMeasure, now, marketContext = {} }) {
  const identity = lifecycleIdentity.identityFrom(candidate);
  return createCanonicalSignal({
    lifecycleId: identity.lifecycleId,
    signalId: candidate.signalId || candidate.originalSignalId,
    producerId,
    producerType,
    strategyId: strategyIdOf(candidate),
    signalFamily: candidate.signalFamily || candidate.strategyFamily || candidate.family,
    signalSubtype: subtypeOf(candidate),
    direction: directionOf(candidate),
    symbol: candidate.symbol || candidate.futuresSymbol,
    marketType: marketTypeOf(candidate, marketContext),
    signalTimestamp: candidate.signalTimestamp || candidate.candleTimestamp || candidate.timestamp,
    entry: candidate.entryPrice ?? candidate.entry ?? candidate.referencePrice,
    stopLoss: candidate.stopLoss,
    takeProfit: candidate.takeProfit,
    evidence: buildEvidenceFrom(candidate, { now, extensionMeasure, marketContext }),
    metadata: {
      timeframe: candidate.timeframe,
      dataSource: candidate.dataSource,
      sourceCandidateId: candidate.candidateId,
      originalSymbol: candidate.originalSymbol,
      generatedAt: now,
    },
  });
}

// TradingOS — extension är positionell: |pris − mitt(SMA20,SMA200)| / ATR14
function tradingOsCanonicalAdapter(candidate = {}, { now = new Date(), marketContext = {} } = {}) {
  return baseFrom(candidate, {
    producerId: 'tradingos_decision_monitor',
    producerType: 'tradingos_decision_monitor',
    extensionMeasure: 'price_to_zone_atr',
    now,
    marketContext,
  });
}

// Native futures — extension är lokal: latestRange / avgRange. Producenten
// exponerar inte värdet på kandidaten i dag, därför value = null och level =
// null. Det är avsiktligt: motorn ska se "aldrig mätt", inte "godkänt".
function nativeCanonicalAdapter(candidate = {}, { now = new Date(), marketContext = {} } = {}) {
  return baseFrom(candidate, {
    producerId: candidate.strategyId || 'futures_native',
    producerType: 'futures_native',
    extensionMeasure: 'latest_range_multiple',
    now,
    marketContext,
  });
}

function replayCanonicalAdapter(candidate = {}, { now = new Date(), marketContext = {} } = {}) {
  return baseFrom(candidate, {
    producerId: 'replay',
    producerType: 'replay',
    extensionMeasure: 'price_to_zone_atr',
    now,
    marketContext,
  });
}

function batchCanonicalAdapter(candidate = {}, { now = new Date(), marketContext = {} } = {}) {
  return baseFrom(candidate, {
    producerId: 'batch',
    producerType: 'batch',
    extensionMeasure: 'price_to_zone_atr',
    now,
    marketContext,
  });
}

function pineCanonicalAdapter(candidate = {}, { now = new Date(), marketContext = {} } = {}) {
  return baseFrom(candidate, {
    producerId: 'pine',
    producerType: 'pine',
    extensionMeasure: 'price_to_zone_atr',
    now,
    marketContext,
  });
}

// Väljer adapter på producentens egen märkning. Okänd producent ⇒ null, aldrig
// en gissning: en felaktigt vald adapter ger fel extension-mått.
function adapterFor(candidate = {}) {
  const type = lower(candidate.producerType || candidate.signalSource || candidate.source || '');
  if (type.includes('futures_native')) return nativeCanonicalAdapter;
  if (type.includes('replay')) return replayCanonicalAdapter;
  if (type.includes('batch')) return batchCanonicalAdapter;
  if (type.includes('pine')) return pineCanonicalAdapter;
  if (type.includes('trading_os') || type.includes('tradingos')) return tradingOsCanonicalAdapter;
  return null;
}

module.exports = {
  SAFETY,
  tradingOsCanonicalAdapter,
  nativeCanonicalAdapter,
  replayCanonicalAdapter,
  batchCanonicalAdapter,
  pineCanonicalAdapter,
  adapterFor,
  _internal: { subtypeOf, strategyIdOf, marketTypeOf, directionOf, hasEmaContext, hasVwapContext, trendIsIntact, sessionOf, sessionTokensOf },
};
