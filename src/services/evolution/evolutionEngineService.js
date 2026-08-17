'use strict';

// ── Evolution Engine ─────────────────────────────────────────────────────────
//
// Skapar nytt DNA ur befintligt och bokför släktskapet. Ingenting mer.
//
// Den kör INGEN replay, optimerar ingenting och betygsätter ingenting. Den
// väljer förälder, mutation, gren och generation, bygger genomet och skriver in
// det i släktträdet. Vad genomet är VÄRT är en annan fråga, och den frågan
// besvaras av replay — inte här.
//
// ── Varför det är rätt att sluta här ────────────────────────────────────────
//
// Ett steg som både skapar och utvärderar blir omöjligt att granska: när ett
// dåligt resultat dyker upp går det inte att säga om mutationen var fel eller
// om utvärderingen var det. Genom att låta motorn bara producera DNA kan varje
// genom köras genom exakt samma replay-kedja som allt annat, och resultatet
// blir jämförbart med strategier som aldrig muterats.
//
// ── Föräldrar kommer ur registret och trädet, aldrig ur en lista ────────────
//
// Kandidatföräldrar är antingen registrerade strategiers genom (via
// strategyDnaService, som härleder dem ur registret) eller noder som redan
// finns i trädet. Ingen strategi nämns vid namn någonstans i den här modulen.
//
// Ren orkestrering: skriver bara via trädet, aldrig till broker, aldrig till
// marknaden.

const strategyDna = require('../dna/strategyDnaService');
const familyTreeModule = require('./strategyFamilyTreeService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'evolution_engine',
});

const ENGINE_VERSION = 'evolution-engine-v1';

// Mutationstyper motorn känner till. Namnen beskriver AVSIKTEN, inte
// implementationen — det är avsikten AI senare ska kunna resonera om, och det
// är den som gör en gren begriplig i efterhand.
const MUTATION_TYPES = Object.freeze({
  PARAMETER: 'parameter',        // ett värde justeras
  RISK_TIGHTEN: 'risk_tighten',  // snävare stop
  RISK_LOOSEN: 'risk_loosen',    // vidare stop
  EXIT_EXTEND: 'exit_extend',    // längre target
  EXIT_SHORTEN: 'exit_shorten',  // kortare target
  ENTRY_STRICTEN: 'entry_stricten',
  ENTRY_RELAX: 'entry_relax',
});

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function createEvolutionEngine(options = {}) {
  const dnaService = options.dnaService || strategyDna;
  const tree = options.familyTree || familyTreeModule.defaultStrategyFamilyTree;

  /**
   * Alla genom som kan tjäna som förälder.
   *
   * Registrerade strategiers genom PLUS trädets egna noder. Pensionerade noder
   * räknas inte: en gren som stängts ska inte kunna få nya barn bakvägen.
   */
  function listParentCandidates() {
    const registered = dnaService.listStrategyDna().map((dna) => ({
      dnaHash: dna.dnaHash,
      strategyId: dna.strategyId,
      generation: 0,
      branch: 'root',
      source: 'registry',
      retired: false,
      dna,
    }));
    const registeredHashes = new Set(registered.map((row) => row.dnaHash));
    const evolved = tree.listNodes()
      .filter((node) => !registeredHashes.has(node.dnaHash))
      .map((node) => ({
        dnaHash: node.dnaHash,
        strategyId: node.strategyId,
        generation: node.generation,
        branch: node.branch,
        source: 'tree',
        retired: node.retired,
        dna: null,
      }));
    return [...registered, ...evolved].filter((row) => !row.retired);
  }

  /** Ser till att en registrerad strategis genom finns som rot i trädet. */
  function seedRegisteredStrategies() {
    const created = [];
    for (const dna of dnaService.listStrategyDna()) {
      const result = tree.addNode({
        dnaHash: dna.dnaHash,
        parent: null,
        mutationType: null,
        branch: 'root',
        rootStrategyId: dna.strategyId,
        strategyId: dna.strategyId,
        parameterHash: dna.parameterHash,
      });
      if (result.ok && !result.alreadyPresent) created.push(dna.strategyId);
    }
    return { ok: true, created, nodes: tree.listNodes().length, ...SAFETY };
  }

  /**
   * Skapar ett nytt genom ur en förälder.
   *
   * @param {object}  parentDna   genom att utgå från
   * @param {object}  changes     { 'risk.stopLossPct': 0.3 }
   * @param {string}  mutationType
   * @param {string} [branch]     ny gren, annars ärvs förälderns
   */
  function evolve({ parentDna, changes = {}, mutationType = MUTATION_TYPES.PARAMETER, branch = null } = {}) {
    if (!parentDna?.dnaHash) return { ok: false, reason: 'parent_dna_required' };
    if (!Object.values(MUTATION_TYPES).includes(mutationType)) {
      return { ok: false, reason: `unknown_mutation_type:${mutationType}` };
    }
    const parentNode = tree.getNode(parentDna.dnaHash);
    if (parentNode?.retired) {
      // En pensionerad gren får inte få nya barn. Annars kan en återvändsgränd
      // återuppstå utan att någon fattat ett beslut om det.
      return { ok: false, reason: 'parent_is_retired', parent: parentDna.dnaHash };
    }

    const mutation = dnaService.mutateStrategyDna(parentDna, changes, { mutationType, branch });
    if (!mutation.ok) {
      return { ok: false, reason: mutation.reason, rejected: mutation.rejected };
    }

    // Föräldern måste finnas i trädet innan barnet skrivs in, annars kan
    // generationen inte härledas.
    if (!parentNode?.createdAt) {
      tree.addNode({
        dnaHash: parentDna.dnaHash,
        parent: parentDna.lineage?.parent || null,
        mutationType: parentDna.lineage?.mutationType || null,
        branch: parentDna.lineage?.branch || 'root',
        rootStrategyId: parentDna.lineage?.rootStrategyId || parentDna.strategyId,
        strategyId: parentDna.strategyId,
        parameterHash: parentDna.parameterHash,
      });
    }

    const added = tree.addNode({
      dnaHash: mutation.dna.dnaHash,
      parent: parentDna.dnaHash,
      mutationType,
      branch: text(branch) || parentDna.lineage?.branch || 'root',
      rootStrategyId: parentDna.lineage?.rootStrategyId || parentDna.strategyId,
      // Ett muterat genom är INTE en registrerad strategi. Det får inget
      // strategyId förrän någon registrerar det som kod.
      strategyId: null,
      parameterHash: mutation.dna.parameterHash,
      mutation: { changes: mutation.applied, diff: dnaService.diffStrategyDna(parentDna, mutation.dna) },
    });
    if (!added.ok) return { ok: false, reason: added.reason };

    return {
      ok: true,
      dna: mutation.dna,
      node: added.node,
      // Generationen kommer från TRÄDET, inte från genomet: trädet härleder den
      // ur föräldern och är därmed den enda som kan räkna rätt när samma genom
      // nås via flera vägar.
      generation: added.node.generation,
      applied: mutation.applied,
      rejected: mutation.rejected,
      engineVersion: ENGINE_VERSION,
      ...SAFETY,
    };
  }

  /** Genomet plus hela dess släkt, för granskning. */
  function describeLineage(dnaHash) {
    const node = tree.getNode(dnaHash);
    if (!node) return null;
    return {
      node,
      ancestry: tree.ancestryOf(dnaHash),
      children: tree.childrenOf(dnaHash),
      descendants: tree.descendantsOf(dnaHash),
      branch: node.branch,
      generation: node.generation,
      rootStrategyId: node.rootStrategyId,
      ...SAFETY,
    };
  }

  function getStatus() {
    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      parentCandidates: listParentCandidates().length,
      tree: tree.getStatus(),
      mutationTypes: Object.values(MUTATION_TYPES),
      // Motorn skapar bara DNA. Den kör ingenting.
      capabilities: {
        createsDna: true,
        storesLineage: true,
        runsReplay: false,
        optimizes: false,
        scoresStrategies: false,
      },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    ENGINE_VERSION,
    MUTATION_TYPES,
    seedRegisteredStrategies,
    listParentCandidates,
    evolve,
    describeLineage,
    getStatus,
    familyTree: tree,
  };
}

module.exports = {
  SAFETY,
  ENGINE_VERSION,
  MUTATION_TYPES,
  createEvolutionEngine,
};
