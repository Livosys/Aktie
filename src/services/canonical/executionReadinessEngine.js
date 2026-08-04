'use strict';

// Execution Readiness Engine — den framtida ENDA komponent som avgör om en
// Canonical Signal får bli kandidat.
//
// Används inte av någon produktionsväg. Byggd för shadow-jämförelse.
//
// ── Om legacyAdvisory ────────────────────────────────────────────────────────
// Dagens beslut innehåller en statusgrind (paperStrategyEntryContractService
// :750-763) som läser producentens `signalStatus`/`priority`. Det fältet är
// förbjudet i Canonical Signal, eftersom det är ett exekveringsomdöme.
//
// Men FAS 5 kräver 100% beslutsidentitet innan routing ändras. Utan tillgång
// till statusvärdet är identitet omöjlig PER KONSTRUKTION — motorn skulle sakna
// den enda indata som fäller 100% av dagens TradingOS-blockeringar.
//
// Därför tar motorn emot statusen som en SEPARAT, uttryckligen namngiven och
// deprekerad parameter — aldrig som en del av signalen. Datamodellen förblir
// ren; beroendet blir synligt och mätbart i stället för inbakat.
//
// Att ta bort legacyAdvisory är ett EGET migrationssteg med EGEN mätning. Det
// får inte smygas in i shadow-fasen: den dagen ändras beteendet definitionellt.

const entryContracts = require('../paperStrategyEntryContractService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'execution_readiness_engine',
});

const ENGINE_VERSION = 'execution-readiness-v1';

const VERDICTS = Object.freeze({
  EXECUTABLE: 'EXECUTABLE',
  NOT_EXECUTABLE: 'NOT_EXECUTABLE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});

// Stabila reasonCodes, kategoriserade. Kolumn 2 anger vilken av dagens
// REASON_CODES den motsvarar — mappningen är shadow-jämförelsens nyckel.
const REASONS = Object.freeze({
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

// Motsvarighet mot dagens reasonCodes. Används enbart av shadow-jämförelsen.
const LEGACY_REASON_MAP = Object.freeze({
  entry_contract_missing: REASONS.STRUCTURE_MISSING_POLICY,
  invalid_strategy_subtype: REASONS.STRUCTURE_SUBTYPE_NOT_ALLOWED,
  invalid_strategy_direction: REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED,
  paper_entry_watch_only: REASONS.QUALITY_ADVISORY_WATCH,
  paper_entry_caution_only: REASONS.QUALITY_ADVISORY_CAUTION,
  paper_entry_status_not_ready: REASONS.QUALITY_ADVISORY_NOT_READY,
  stale_strategy_signal: REASONS.CONTEXT_DATA_STALE,
  missing_market_context: REASONS.STRUCTURE_MARKET_TYPE_MISMATCH,
  invalid_session: REASONS.STRUCTURE_SESSION_NOT_ALLOWED,
  missing_closed_candle_confirmation: REASONS.QUALITY_CLOSED_CANDLE_MISSING,
  missing_two_minute_confirmation: REASONS.QUALITY_TWO_MINUTE_MISSING,
  missing_ema_pullback_confirmation: REASONS.QUALITY_EMA_CONFIRMATION_MISSING,
  missing_vwap_reclaim_confirmation: REASONS.QUALITY_VWAP_CONFIRMATION_MISSING,
  missing_volume_confirmation: REASONS.QUALITY_VOLUME_BELOW_POLICY,
  late_extended_entry: REASONS.QUALITY_LATE_OR_EXTENDED,
});

const ADVISORY_WATCH = new Set(['watch', 'observe', 'observing']);
const ADVISORY_READY = new Set(['active', 'confirmed', 'entry', 'entry_ready', 'ready', 'queued', 'ready_waiting_for_signal']);
const STALE_FRESHNESS = new Set(['STALE', 'MARKET_CLOSED', 'DELAYED', 'MISSING', 'UNKNOWN']);

function lower(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function upper(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

// Policyn härleds ur dagens kontraktsregister. Det är avsiktligt: kalibreringen
// per strategi är redan i drift och verifierad, och motorn ska ärva den — inte
// uppfinna en ny. evidenceGapPolicy speglar dagens beteende ('permit'), där
// saknad mätning passerar tyst. Att växla den till 'block' är ett eget steg.
function policyForStrategy(strategyId) {
  const contract = entryContracts.getEntryContract(strategyId);
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

const SESSION_ALWAYS_OPEN = ['24_7', 'crypto_24_7'];
const SESSION_US_RTH_EQUIVALENTS = ['regular', 'rth', 'nyse', 'nasdaq', 'us_stocks'];

// Spegling av paperStrategyEntryContractService.js:346 (sessionAllowedByContract).
// En naiv strängjämförelse mot ETT sessionsfält ger fel svar: kontrakten är
// skrivna med aktie-vokabulär medan futures-kandidater bär CME:s 'globex' +
// 'us_rth'. Bryggan på raden nedan är det som gör att ett aktiekontrakt alls
// kan matcha en us_rth-kandidat.
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

function block(reason, detail, gaps) {
  return { verdict: VERDICTS.NOT_EXECUTABLE, reasonCode: reason, detail: detail || null, evidenceGaps: gaps };
}

// Kärnan. Ordningen följer dagens kontraktsutvärdering exakt — inte av lathet,
// utan för att reasonCode ska bli jämförbar rad för rad i shadow-läget. En
// omordnad grind ger samma allowed men annan reasonCode, och då går det inte
// att avgöra om en avvikelse är ofarlig.
function evaluate({ canonicalSignal, legacyAdvisory = null, now = new Date(), policy: policyOverride = null } = {}) {
  const signal = canonicalSignal || {};
  const ev = signal.evidence || {};
  const ctx = ev.context || {};
  const evidenceGaps = [];

  if (ev.extension?.level == null) evidenceGaps.push('extension_level_never_measured');
  if (ev.timeframes?.agreementCount == null) evidenceGaps.push('timeframe_agreement_never_measured');
  if (ev.volume?.rvol == null) evidenceGaps.push('volume_rvol_never_measured');

  const base = { engineVersion: ENGINE_VERSION, evaluatedAt: new Date(now).toISOString(), ...SAFETY };

  if (!signal.strategyId) {
    return { ...base, ...block(REASONS.STRUCTURE_MISSING_STRATEGY_ID, null, evidenceGaps), policyId: null };
  }

  const policy = policyOverride || policyForStrategy(signal.strategyId);
  if (!policy) {
    return { ...base, ...block(REASONS.STRUCTURE_MISSING_POLICY, null, evidenceGaps), policyId: null };
  }
  const withPolicy = { ...base, policyId: policy.policyId, policyVersion: policy.policyVersion };

  // 1. Struktur — subtyp
  if (!policy.allowedSubtypes.includes(upper(signal.signalSubtype))) {
    return { ...withPolicy, ...block(REASONS.STRUCTURE_SUBTYPE_NOT_ALLOWED, { observed: signal.signalSubtype }, evidenceGaps) };
  }
  // 2. Struktur — riktning
  if (!directionAllowed(policy, signal.direction)) {
    return { ...withPolicy, ...block(REASONS.STRUCTURE_DIRECTION_NOT_ALLOWED, { observed: signal.direction }, evidenceGaps) };
  }
  // 3. Producentomdöme (DEPREKERAT — se modulhuvudet)
  const advisory = lower(legacyAdvisory);
  if (ADVISORY_WATCH.has(advisory)) {
    return { ...withPolicy, ...block(REASONS.QUALITY_ADVISORY_WATCH, { advisory }, evidenceGaps) };
  }
  if (advisory === 'caution') {
    return { ...withPolicy, ...block(REASONS.QUALITY_ADVISORY_CAUTION, { advisory }, evidenceGaps) };
  }
  if (!ADVISORY_READY.has(advisory)) {
    return { ...withPolicy, ...block(REASONS.QUALITY_ADVISORY_NOT_READY, { advisory: advisory || null }, evidenceGaps) };
  }
  // 4. Färskhet
  if (policy.requiresFreshData) {
    const freshness = upper(ctx.dataFreshness || '');
    const age = ev.candle?.signalAgeMs;
    if (freshness && STALE_FRESHNESS.has(freshness)) {
      return { ...withPolicy, ...block(REASONS.CONTEXT_DATA_STALE, { dataFreshness: freshness }, evidenceGaps) };
    }
    if (age == null) {
      return { ...withPolicy, ...block(REASONS.CONTEXT_DATA_STALE, { missingSignalTimestamp: true }, evidenceGaps) };
    }
    if (age > policy.maxSignalAgeMs) {
      return { ...withPolicy, ...block(REASONS.CONTEXT_DATA_STALE, { signalAgeMs: age, maxSignalAgeMs: policy.maxSignalAgeMs }, evidenceGaps) };
    }
  }
  // 5. Marknadstyp och session
  if (policy.marketType === 'stocks' && signal.marketType !== 'stocks') {
    return { ...withPolicy, ...block(REASONS.STRUCTURE_MARKET_TYPE_MISMATCH, { observed: signal.marketType }, evidenceGaps) };
  }
  if (ctx.marketClosed === true) {
    return { ...withPolicy, ...block(REASONS.CONTEXT_MARKET_CLOSED, null, evidenceGaps) };
  }
  if (policy.requiresMarketOpen && !sessionAllowed(policy, signal)) {
    return { ...withPolicy, ...block(REASONS.STRUCTURE_SESSION_NOT_ALLOWED, { observed: ctx.session }, evidenceGaps) };
  }
  // 6. Stängd candle
  if (policy.requiresClosedCandle && ev.candle?.closedCandleConfirmed !== true) {
    return { ...withPolicy, ...block(REASONS.QUALITY_CLOSED_CANDLE_MISSING, null, evidenceGaps) };
  }
  // 7. Bekräftelser
  const observed = new Set(ev.confirmations || []);
  if (policy.requiredConfirmations.includes('two_minute_confirmation') && !observed.has('two_minute_confirmation')) {
    return { ...withPolicy, ...block(REASONS.QUALITY_TWO_MINUTE_MISSING, null, evidenceGaps) };
  }
  if (policy.requiresEmaContext && ctx.emaContextPresent !== true) {
    return { ...withPolicy, ...block(REASONS.QUALITY_EMA_CONFIRMATION_MISSING, { missingEmaContext: true }, evidenceGaps) };
  }
  if (policy.requiresEmaContext && ctx.trendIntact !== true) {
    return { ...withPolicy, ...block(REASONS.QUALITY_EMA_CONFIRMATION_MISSING, { brokenTrend: true }, evidenceGaps) };
  }
  if (policy.requiredConfirmations.includes('ema_pullback_reclaim') && !observed.has('ema_pullback_reclaim')) {
    return { ...withPolicy, ...block(REASONS.QUALITY_EMA_CONFIRMATION_MISSING, null, evidenceGaps) };
  }
  if (policy.requiresVwapContext && ctx.vwapContextPresent !== true) {
    return { ...withPolicy, ...block(REASONS.QUALITY_VWAP_CONFIRMATION_MISSING, { missingVwapContext: true }, evidenceGaps) };
  }
  if (policy.requiredConfirmations.includes('vwap_reclaim_confirmation') && !observed.has('vwap_reclaim_confirmation')) {
    return { ...withPolicy, ...block(REASONS.QUALITY_VWAP_CONFIRMATION_MISSING, null, evidenceGaps) };
  }
  if (policy.requiredConfirmations.includes('volume_confirmation') && !observed.has('volume_confirmation')) {
    return { ...withPolicy, ...block(REASONS.QUALITY_VOLUME_BELOW_POLICY, null, evidenceGaps) };
  }
  if (policy.volumePolicy && !observed.has('volume_confirmation')) {
    return { ...withPolicy, ...block(REASONS.QUALITY_VOLUME_BELOW_POLICY, { volumePolicy: policy.volumePolicy }, evidenceGaps) };
  }
  // 8. Sen/utsträckt entry
  if ((policy.lateEntryPolicy === 'block' || policy.extendedMovePolicy === 'block') && ctx.lateOrExtended === true) {
    return { ...withPolicy, ...block(REASONS.QUALITY_LATE_OR_EXTENDED, null, evidenceGaps) };
  }
  if (ctx.observationTextOnly === true) {
    return { ...withPolicy, ...block(REASONS.QUALITY_OBSERVATION_TEXT_ONLY, null, evidenceGaps) };
  }

  // Saknad mätning blockerar inte i dag. Under shadow rapporteras luckan men
  // verdict följer dagens beteende, så att identiteten kan mätas rent.
  if (evidenceGaps.length && policy.evidenceGapPolicy === 'block') {
    return { ...withPolicy, verdict: VERDICTS.INSUFFICIENT_EVIDENCE, reasonCode: `EVIDENCE_GAP:${evidenceGaps[0]}`, detail: { evidenceGaps }, evidenceGaps };
  }

  return { ...withPolicy, verdict: VERDICTS.EXECUTABLE, reasonCode: null, detail: null, evidenceGaps };
}

module.exports = {
  SAFETY,
  ENGINE_VERSION,
  VERDICTS,
  REASONS,
  LEGACY_REASON_MAP,
  policyForStrategy,
  evaluate,
};
