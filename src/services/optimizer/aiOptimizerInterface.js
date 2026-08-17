'use strict';

// ── AI Optimizer: kontraktet, inte motorn ────────────────────────────────────
//
// Optimeraren är INTE byggd. Den här filen definierar bara vad en optimerare
// måste kunna, så att den när den byggs inte kan ta någon av de genvägar som
// annars uppstår när ett gränssnitt uppfinns i efterhand.
//
// Fyra regler som är inbyggda i kontraktet:
//
//   1. En optimerare arbetar ENBART mot DNA. Den får ett genom och föreslår ett
//      annat. Den ser aldrig strategikod, och den får aldrig kunna ändra den.
//
//   2. Den måste FRÅGA MINNET FÖRST. propose() returnerar förslag; varje
//      förslag måste passera AI Memory innan det körs, och ett förslag som
//      redan finns i minnet ska besvaras ur minnet. Det är därför kontraktet
//      kräver att en optimerare kan ta emot `memoryLookup` — utan den kan den
//      inte fråga, och en optimerare som inte kan fråga kommer att köra om.
//
//   3. Den optimerar mot Strategy Edge, aldrig mot Executed Entry. Måttet
//      skickas in; optimeraren väljer det inte själv. En optimerare som får
//      välja sitt eget mått väljer det som ser bäst ut.
//
//   4. Den kör ingenting. propose() är ren: in ett genom och ett minne, ut
//      förslag. Replay startas av den som frågade, genom samma kedja som allt
//      annat.
//
// Ren modul: ingen IO, ingen klocka, inget tillstånd.

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'ai_optimizer_interface',
});

const INTERFACE_VERSION = 'ai-optimizer-interface-v1';

const REQUIRED_METHODS = Object.freeze(['propose', 'describe']);

// Måttet en optimerare får sikta på. Executed Entry finns MEDVETET inte med:
// att optimera mot verkliga fyllningar lär modellen kompensera för slumpmässig
// slippage i stället för att hitta edge.
const OPTIMIZATION_TARGETS = Object.freeze([
  'strategyScore',
  'strategyEdgePnl',
  'expectancy',
  'profitFactor',
]);

const FORBIDDEN_TARGETS = Object.freeze([
  'executedPnl',
  'executedEntry',
  'executionScore',
  'netPnl',
]);

const PROPOSAL_FIELDS = Object.freeze([
  'parentDnaHash',
  'changes',
  'mutationType',
  'rationale',
  'expectedTarget',
]);

function validateOptimizer(optimizer) {
  const errors = [];
  if (!optimizer || typeof optimizer !== 'object') {
    return { ok: false, errors: ['optimizer_is_not_an_object'] };
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof optimizer[method] !== 'function') errors.push(`missing_method_${method}`);
  }
  return { ok: errors.length === 0, errors };
}

function validateTarget(target) {
  if (FORBIDDEN_TARGETS.includes(target)) {
    return {
      ok: false,
      errors: [`forbidden_optimization_target:${target}`],
      // Skälet skrivs ut, för det är inte självklart: måttet finns, det går att
      // räkna, och det är just därför någon förr eller senare kommer att vilja
      // optimera mot det.
      reason: 'Exekveringens utfall får mätas men aldrig optimeras mot — annars '
        + 'lär sig modellen kompensera för slippage i stället för att hitta edge.',
    };
  }
  if (!OPTIMIZATION_TARGETS.includes(target)) {
    return { ok: false, errors: [`unknown_optimization_target:${target}`] };
  }
  return { ok: true, errors: [] };
}

function validateProposal(proposal) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object') {
    return { ok: false, errors: ['proposal_is_not_an_object'] };
  }
  for (const field of PROPOSAL_FIELDS) {
    if (!(field in proposal)) errors.push(`missing_field_${field}`);
  }
  if (proposal.changes && typeof proposal.changes !== 'object') errors.push('changes_must_be_an_object');
  if (proposal.changes && Object.keys(proposal.changes).length === 0) errors.push('changes_must_not_be_empty');
  // Ett förslag måste peka på ett genom, inte på en strategi. En optimerare som
  // föreslår "ändra momentumstrategin" har redan lämnat DNA-världen.
  if (proposal.strategyId) errors.push('proposal_must_target_dna_not_strategy_id');
  return { ok: errors.length === 0, errors };
}

/**
 * Kontrollen som måste ligga mellan optimerare och replay.
 *
 * Returnerar antingen ett svar ur minnet eller ett godkännande att köra. Den
 * här funktionen är hela regeln "AI får aldrig köra samma experiment två
 * gånger" — den finns här, i kontraktet, så att en framtida optimerare inte kan
 * byggas utan den.
 *
 * @param {object}   memory       aiMemoryService-instans
 * @param {object}   experimentSpec  identitet enligt AI Memory
 */
function gateThroughMemory(memory, experimentSpec) {
  const plan = memory.lookupOrPlan(experimentSpec);
  if (plan.cached) {
    return {
      run: false,
      reason: 'already_known',
      experimentKey: plan.experimentKey,
      result: plan.result,
      seenIn: plan.seenIn,
      ...SAFETY,
    };
  }
  return { run: true, reason: 'not_seen_before', experimentKey: plan.experimentKey, ...SAFETY };
}

function describeInterface() {
  return {
    interfaceVersion: INTERFACE_VERSION,
    implemented: false,
    note: 'Optimeraren är inte byggd. Kontraktet finns för att den ska byggas rätt.',
    requiredMethods: [...REQUIRED_METHODS],
    optimizationTargets: [...OPTIMIZATION_TARGETS],
    forbiddenTargets: [...FORBIDDEN_TARGETS],
    proposalFields: [...PROPOSAL_FIELDS],
    rules: [
      'Arbetar enbart mot DNA — ser aldrig strategikod.',
      'Måste passera AI Memory innan ett förslag körs.',
      'Optimerar mot Strategy Edge, aldrig mot exekveringens utfall.',
      'Kör ingenting själv; replay startas av den som frågade.',
    ],
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  INTERFACE_VERSION,
  REQUIRED_METHODS,
  OPTIMIZATION_TARGETS,
  FORBIDDEN_TARGETS,
  PROPOSAL_FIELDS,
  validateOptimizer,
  validateTarget,
  validateProposal,
  gateThroughMemory,
  describeInterface,
};
