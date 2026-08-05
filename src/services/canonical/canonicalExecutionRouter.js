'use strict';

// Canonical Execution Router — den ENDA vägen från producentsignal till
// exekveringsbeslut.
//
// FAS 8. Före detta steg fanns beslutet i paperStrategyEntryContractService
// .evaluatePaperEntryContract() och varje exekveringsväg anropade den direkt.
// Nu gäller:
//
//   Producent
//     → Canonical Signal        (canonicalSignalAdapters)
//     → Execution Readiness Engine (executionReadinessEngine)   ← BESLUTET
//     → Entry Contract          (policy + version, via motorn)
//     → Guard
//     → Intent
//     → IBKR
//
// Entry Contract ligger kvar i kedjan men är inte längre beslutsfattare: den
// är policykälla. Motorn läser kontraktet via policyForStrategy() och ärver
// dess kalibrering oförändrad. Ingen kontraktsregel har ändrats.
//
// ── Bakåtkompatibel yta ──────────────────────────────────────────────────────
// Nedströms (guard, execution-adapter, API-svar) läser exakt tre fält ur
// beslutet: `allowed`, `entryContractVersion` och `reasonCode`
// (ibPaperExecutionAdapterService.js:227-229). Routern behåller dessa med
// oförändrade värdemängder, så att migreringen inte kan ändra ett enda
// nedströmsbeteende:
//
//   allowed             ← motorns verdict === EXECUTABLE
//   reasonCode          ← motorns reasonCode ÖVERSATT tillbaka till dagens kod
//   entryContractVersion← kontraktets version (oförändrad konstant)
//
// Den kanoniska sanningen exponeras parallellt under `readiness`. Att låta
// `reasonCode` byta värdemängd vore en observerbar ändring utan mätning bakom
// sig, och kravet är noll nya reasonCode-avvikelser.

const adapters = require('./canonicalSignalAdapters');
const engine = require('./executionReadinessEngine');
const entryContracts = require('../paperStrategyEntryContractService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'canonical_execution_router',
});

const ROUTER_VERSION = 'canonical-execution-router-v1';

// Invers av motorns LEGACY_REASON_MAP. Mappningen är injektiv (15 legacy-koder
// → 15 skilda canonical-koder), så inversen är entydig och byggs härifrån i
// stället för att dubbleras för hand.
const CANONICAL_TO_LEGACY_REASON = Object.freeze(
  Object.entries(engine.LEGACY_REASON_MAP).reduce((acc, [legacy, canonical]) => {
    acc[canonical] = legacy;
    return acc;
  }, {}),
);

// Tre canonical-koder saknar motsvarighet i dagens kodregister
// (STRUCTURE_MISSING_STRATEGY_ID, CONTEXT_MARKET_CLOSED,
// QUALITY_OBSERVATION_TEXT_ONLY). Ingen av dem har någonsin observerats i
// produktion. Inträffar de exponeras canonical-koden rakt av — att uppfinna en
// legacy-kod som aldrig funnits vore att dölja en ny händelse.
function legacyReasonFor(canonicalReason) {
  if (!canonicalReason) return null;
  return CANONICAL_TO_LEGACY_REASON[canonicalReason] || canonicalReason;
}

// Producentupplösning. adapterFor() vägrar medvetet gissa och ger null för en
// omärkt producent. Historiskt (2026-07-07/08) emitterade futures_paper_scanner
// 9 kandidater helt utan producentmärkning; samtliga blockerades av både gammal
// och ny väg. Shadow-harnessen har hela tiden mätt dem som TradingOS, och det
// är den upplösningen som är verifierad 2718/2718. Routern behåller därför
// exakt den — och rapporterar att den föll tillbaka, så att en omärkt producent
// syns i stället för att tyst få ett godtyckligt extension-mått.
function resolveAdapter(candidate) {
  const resolved = adapters.adapterFor(candidate);
  if (resolved) return { adapter: resolved, fallback: false };
  return { adapter: adapters.tradingOsCanonicalAdapter, fallback: true };
}

// Producentens exekveringsomdöme (signalStatus/priority). Identisk härledning
// som orchestratorns normalizeCandidate:105 och kontraktets :750 gör i dag.
// Motorn tar emot det som uttryckligen deprekerad parameter — se
// executionReadinessEngine.js:8-22. Att avveckla det är ett eget migrationssteg.
function legacyAdvisoryOf(candidate = {}) {
  return candidate.signalStatus || candidate.entryStatus || candidate.status || candidate.priority || '';
}

/**
 * Enda exekveringsbeslutet i systemet.
 *
 * @returns {object} beslut med bakåtkompatibel yta + `readiness` + `canonicalSignal`
 */
function routeExecutionReadiness({
  strategyId = null,
  candidate = {},
  now = new Date(),
  marketContext = {},
} = {}) {
  const resolvedStrategyId = strategyId
    || adapters._internal.strategyIdOf(candidate)
    || null;

  const { adapter, fallback } = resolveAdapter(candidate);
  const canonicalSignal = adapter(candidate, { now, marketContext });

  // Adaptern härleder strategyId ur kandidaten. Anropar någon routern med ett
  // explicit strategyId (orchestratorn gör det) ska motorn se det värdet —
  // annars kan policyvalet skilja sig från det anroparen tror att den frågar om.
  const signalForEngine = resolvedStrategyId && canonicalSignal.strategyId !== resolvedStrategyId
    ? { ...canonicalSignal, strategyId: resolvedStrategyId }
    : canonicalSignal;

  const readiness = engine.evaluate({
    canonicalSignal: signalForEngine,
    legacyAdvisory: legacyAdvisoryOf(candidate),
    now,
  });

  const allowed = readiness.verdict === engine.VERDICTS.EXECUTABLE;
  const reasonCode = allowed ? null : legacyReasonFor(readiness.reasonCode);

  return {
    // ── Bakåtkompatibel yta (oförändrade värdemängder) ──────────────────────
    allowed,
    strategyId: resolvedStrategyId,
    reason: reasonCode,
    reasonCode,
    entryContractVersion: entryContracts.PAPER_ENTRY_CONTRACT_VERSION,

    // ── Kanonisk sanning ────────────────────────────────────────────────────
    decisionSource: 'execution_readiness_engine',
    routerVersion: ROUTER_VERSION,
    readiness: {
      verdict: readiness.verdict,
      reasonCode: readiness.reasonCode,
      detail: readiness.detail || null,
      engineVersion: readiness.engineVersion,
      policyId: readiness.policyId || null,
      evidenceGaps: readiness.evidenceGaps || [],
      producerType: signalForEngine.producerType || null,
      producerFallback: fallback,
    },
    canonicalSignal: signalForEngine,

    safety: SAFETY,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  ROUTER_VERSION,
  CANONICAL_TO_LEGACY_REASON,
  routeExecutionReadiness,
  _internal: { resolveAdapter, legacyAdvisoryOf, legacyReasonFor },
};
