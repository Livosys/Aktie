'use strict';

// Canonical Signal — ren marknadsbeskrivning.
//
// En Canonical Signal säger vad marknaden gör. Den säger ALDRIG vad systemet
// får göra. Exekveringsbeslutet ägs uteslutande av executionReadinessEngine.
//
// Modulen är avsiktligt utan sidoeffekter och importeras i dag av ingen
// produktionsväg — den byggs för shadow-migreringen och aktiveras separat.

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'canonical_signal',
});

const CANONICAL_SIGNAL_VERSION = 'canonical-signal-v1';

// Fält som en producent aldrig får sätta. Samtliga är exekveringsomdömen och
// hör hemma i readiness-motorn. Listan är normativ: validateCanonicalSignal
// underkänner en signal som bär något av dem.
const FORBIDDEN_FIELDS = Object.freeze([
  'ready',
  'priority',
  'signalStatus',
  'status',
  'watch',
  'wait',
  'avoid',
  'caution',
  'executionStatus',
  'approved',
  'canTrade',
  'entryReady',
  'producerEntryReadiness',
  'registryGatePending',
  'executionGate',
]);

const REQUIRED_FIELDS = Object.freeze([
  'signalId',
  'producerId',
  'producerType',
  'strategyId',
  'signalFamily',
  'signalSubtype',
  'direction',
  'symbol',
  'marketType',
  'signalTimestamp',
]);

const PRODUCER_TYPES = Object.freeze([
  'tradingos_decision_monitor',
  'futures_native',
  'replay',
  'batch',
  'pine',
]);

const DIRECTIONS = Object.freeze(['LONG', 'SHORT']);

// Namngivna extension-mått. Att måttet namnges är inte kosmetiskt: TradingOS
// och native futures använder båda ordet "extension" om två helt olika
// mätningar (positionell distans till SMA-zonen respektive senaste candlens
// spann mot snittet). Utan measure kollapsar de till samma fält med olika
// betydelse — vilket är exakt dagens defekt.
const EXTENSION_MEASURES = Object.freeze([
  'price_to_zone_atr',      // |pris − mitt(SMA20,SMA200)| / ATR14  (TradingOS)
  'latest_range_multiple',  // latestRange / avgRange               (native futures)
]);

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

// OBS: Number(null) === 0 och Number('') === 0. Utan den explicita null-vakten
// blir "aldrig mätt" tyst till 0 — vilket är exakt den skillnad modellen finns
// till för att bevara. Upptäckt av canonicalSignalAdapters.test.js.
function numberOrNull(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function boolOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

// Evidence bär fakta, aldrig omdömen. Varje gren är obligatoriskt NÄRVARANDE
// men får vara tom — motorn måste kunna skilja "mätt och OK" från "aldrig
// mätt", annars tolkas frånvaro tyst som godkänt.
function buildEvidence(input = {}) {
  const extension = input.extension || {};
  const volume = input.volume || {};
  const timeframes = input.timeframes || {};
  const candle = input.candle || {};

  return {
    extension: {
      measure: textOrNull(extension.measure),
      value: numberOrNull(extension.value),
      level: textOrNull(extension.level),
    },
    volume: {
      rvol: numberOrNull(volume.rvol),
      state: textOrNull(volume.state),
    },
    timeframes: {
      tf2m: textOrNull(timeframes.tf2m),
      agreementCount: numberOrNull(timeframes.agreementCount),
    },
    candle: {
      closedCandleConfirmed: boolOrNull(candle.closedCandleConfirmed),
      candleTimestamp: textOrNull(candle.candleTimestamp),
      signalAgeMs: numberOrNull(candle.signalAgeMs),
    },
    // Observerade bekräftelsetokens. Tom lista betyder "inga observerade",
    // null betyder "aldrig utvärderat".
    confirmations: Array.isArray(input.confirmations) ? [...input.confirmations] : null,
    // Kontextflaggor som readiness-motorn behöver men som inte är omdömen.
    context: {
      dataFreshness: textOrNull(input.context?.dataFreshness),
      session: textOrNull(input.context?.session),
      // Sessionen är INTE ett enda fält. Kontraktsgrinden jämför mot en
      // mängd av upp till nio källor (candidate.session, sessionId,
      // sessionMetadata.*, marketContext.*). En enda sträng tappar bort
      // CME:s us_rth-token och ger fel beslut för aktiekontrakt.
      sessionTokens: Array.isArray(input.context?.sessionTokens) ? [...input.context.sessionTokens] : null,
      isRth: boolOrNull(input.context?.isRth),
      marketClosed: boolOrNull(input.context?.marketClosed),
      emaContextPresent: boolOrNull(input.context?.emaContextPresent),
      vwapContextPresent: boolOrNull(input.context?.vwapContextPresent),
      trendIntact: boolOrNull(input.context?.trendIntact),
      lateOrExtended: boolOrNull(input.context?.lateOrExtended),
      observationTextOnly: boolOrNull(input.context?.observationTextOnly),
    },
  };
}

function createCanonicalSignal(input = {}) {
  return {
    canonicalVersion: CANONICAL_SIGNAL_VERSION,
    lifecycleId: textOrNull(input.lifecycleId),
    signalId: textOrNull(input.signalId),
    producerId: textOrNull(input.producerId),
    producerType: textOrNull(input.producerType),
    strategyId: textOrNull(input.strategyId),
    signalFamily: textOrNull(input.signalFamily),
    signalSubtype: textOrNull(input.signalSubtype),
    direction: textOrNull(input.direction) ? String(input.direction).toUpperCase() : null,
    symbol: textOrNull(input.symbol),
    marketType: textOrNull(input.marketType),
    signalTimestamp: textOrNull(input.signalTimestamp),
    entry: numberOrNull(input.entry),
    stopLoss: numberOrNull(input.stopLoss),
    takeProfit: numberOrNull(input.takeProfit),
    evidence: buildEvidence(input.evidence || {}),
    metadata: {
      timeframe: textOrNull(input.metadata?.timeframe),
      dataSource: textOrNull(input.metadata?.dataSource),
      sourceCandidateId: textOrNull(input.metadata?.sourceCandidateId),
      originalSymbol: textOrNull(input.metadata?.originalSymbol),
      generatedAt: nowIso(input.metadata?.generatedAt || new Date()),
    },
    ...SAFETY,
  };
}

// Validering är avsiktligt strikt på två punkter: obligatoriska fakta måste
// finnas, och förbjudna omdömesfält får inte förekomma. strategyId = null är
// ett FEL, inte ett tillstånd — dagens missing_strategy_id uppstår just för att
// null tolereras hela vägen ned till scannern.
function validateCanonicalSignal(signal = {}) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (signal[field] == null || signal[field] === '') errors.push(`missing_required_field:${field}`);
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(signal, field)) errors.push(`forbidden_field:${field}`);
  }
  if (signal.direction != null && !DIRECTIONS.includes(signal.direction)) {
    errors.push(`invalid_direction:${signal.direction}`);
  }
  if (signal.producerType != null && !PRODUCER_TYPES.includes(signal.producerType)) {
    errors.push(`invalid_producer_type:${signal.producerType}`);
  }
  const measure = signal.evidence?.extension?.measure;
  if (measure != null && !EXTENSION_MEASURES.includes(measure)) {
    errors.push(`invalid_extension_measure:${measure}`);
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SAFETY,
  CANONICAL_SIGNAL_VERSION,
  FORBIDDEN_FIELDS,
  REQUIRED_FIELDS,
  PRODUCER_TYPES,
  EXTENSION_MEASURES,
  createCanonicalSignal,
  validateCanonicalSignal,
  buildEvidence,
};
