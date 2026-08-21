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
const optimizerModule = require('../optimizer/aiOptimizerService');

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
  const optimizer = options.optimizer || optimizerModule.defaultAiOptimizerService;

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
      // ── Fanns genomet redan? ─────────────────────────────────────────────
      //
      // Trädet svarar `alreadyPresent` när samma arvsmassa nås en andra gång.
      // Flaggan kastades tidigare bort här, och då blev ett genom som redan
      // fanns oskiljaktigt från ett nyskapat hela vägen upp: fabriken
      // rapporterade "1 nytt genom", schemalade en replay för det, och
      // upprepade det varje cykel. Mätt: 24 "skapade" genom gav 1 ny nod.
      //
      // Ett genom som redan fanns är inget nytt experiment. Det måste synas.
      alreadyPresent: added.alreadyPresent === true,
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

  /**
   * Använder Optimizer för att få DNA-förslag, men Evolution äger den
   * permanenta mutationen och släktträdet. Cacheträffar från AI Memory skapar
   * ingen nod.
   */
  /**
   * Hur många gånger varje parameterväg redan muterats i förälderns släkt.
   *
   * Räknas över hela släkten — föräldern uppåt till roten och allt nedåt — så
   * att en väg som prövats i en systergren inte räknas som outforskad. Det är
   * hela underlaget för att optimeraren ska kunna välja den parameter minst är
   * känt om, i stället för den som råkar sorteras först i bokstavsordning.
   */
  function exploredParameterPaths(dnaHash) {
    const counts = {};
    const nodes = [...tree.ancestryOf(dnaHash), ...tree.descendantsOf(dnaHash)];
    for (const node of nodes) {
      for (const path_ of Object.keys(node?.mutation?.changes || {})) {
        counts[path_] = (counts[path_] || 0) + 1;
      }
    }
    return counts;
  }

  function createOptimizedDnaCandidates({
    parentDna,
    context = {},
    target = 'strategyScore',
    maxCandidates = optimizerModule.DEFAULT_MAX_CANDIDATES,
    branch = 'optimizer',
    libraryRecord = null,
    // ── Räkna utan att skriva ────────────────────────────────────────────────
    //
    // Att fråga "vad skulle evolutionen föreslå här?" krävde tidigare att man
    // faktiskt körde den, och då skrevs noderna i släktträdet som sidoeffekt.
    // Elva genom hamnade i driftens träd på det sättet under en verifiering.
    //
    // Med persist: false byggs samma förslag med samma hashar, men ingenting
    // läggs till i trädet. Det är vägen diagnostik och granskning ska ta.
    persist = true,
  } = {}) {
    if (!parentDna?.dnaHash) return { ok: false, reason: 'parent_dna_required', ...SAFETY };
    const plan = optimizer.propose({
      parentDna,
      context,
      target,
      maxCandidates,
      libraryRecord,
      // Trädet är motorns egendom, och det är enda stället som vet vilka
      // parametrar som redan prövats i den här släkten. Optimeraren får svaret
      // som ett faktum i stället för att själv slå upp lineage — annars hade
      // gränsen mellan "föreslår DNA" och "äger släktträdet" suddats ut.
      exploredPaths: exploredParameterPaths(parentDna.dnaHash),
    });
    if (!plan.ok) return { ...plan, engineVersion: ENGINE_VERSION, ...SAFETY };

    const created = [];
    // Genom som redan låg i släktträdet. De är varken nya eller fel — de är
    // förslag som ledde till en arvsmassa vi redan har. Skiljs från `created`
    // därför att bara det som FAKTISKT är nytt får utlösa en ny replay.
    const alreadyInTree = [];
    const existingExperiments = [];
    const rejected = [];

    for (const proposal of plan.proposals || []) {
      if (proposal.status === 'existing_experiment') {
        existingExperiments.push(proposal);
        continue;
      }
      if (proposal.status !== 'new_dna_proposal') {
        rejected.push(proposal);
        continue;
      }
      const evolved = persist
        ? evolve({ parentDna, changes: proposal.changes, mutationType: proposal.mutationType, branch })
        : previewEvolve({ parentDna, changes: proposal.changes, mutationType: proposal.mutationType, branch });
      if (evolved.ok) {
        const row = {
          proposal,
          dna: evolved.dna,
          node: evolved.node,
          generation: evolved.generation,
          applied: evolved.applied,
          rejected: evolved.rejected,
          alreadyPresent: evolved.alreadyPresent === true,
        };
        if (evolved.alreadyPresent) alreadyInTree.push(row);
        else created.push(row);
      } else {
        rejected.push({ ...proposal, status: 'rejected_by_evolution', reason: evolved.reason, rejected: evolved.rejected || [] });
      }
    }

    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      optimizerVersion: plan.optimizerVersion,
      parentDnaHash: parentDna.dnaHash,
      created,
      alreadyInTree,
      existingExperiments,
      rejected,
      // Sant bara när cykeln faktiskt tillförde arvsmassa. Fabriken använder
      // det för att avgöra om en ny replay är motiverad — ett genom som redan
      // fanns är inget nytt experiment.
      addedNewGenome: persist && created.length > 0,
      // Sant när ingenting skrevs. Den som läser resultatet ska kunna se att
      // det är ett förslag och inte ett faktum i trädet.
      persisted: persist === true,
      winner: null,
      optimizerAskedMemoryBeforeDna: plan.memoryAskedBeforeDna === true,
      schedulerSelectsExperiments: true,
      queueExecutesJobs: true,
      replayEngineKnown: false,
      ...SAFETY,
    };
  }

  // ── Att kunna bygga vidare på sina egna resultat ────────────────────────────
  //
  // Motorn muterade bara REGISTRERADE genom, alltså generation 0. Varje strategi
  // har en handfull muterbara parametrar, och `valuePair` ger två steg per
  // parameter — sammanlagt åtta enstegsmutationer från roten. När de åtta fanns
  // i trädet var familjen slut: varje ny cykel föreslog samma åtta, fick dem
  // tillbaka som redan existerande, och tillförde ingenting. Evolutionen kunde
  // aldrig nå generation 2.
  //
  // Det som saknades var en väg tillbaka från en trädnod till ett fullständigt
  // genom. Ett genom går inte att härleda ur nodens parametrar — samma
  // parameteruppsättning ger en ANNAN hash än den noden bär, och lineage hade
  // brutits. Det måste byggas som det en gång byggdes: rotens genom plus de
  // ackumulerade ändringarna, i ordning. Då stämmer hashen exakt.

  /** Ett trädnods genom, återskapat ur roten. Null om det inte går att bygga. */
  function dnaForNode(dnaHash) {
    const node = tree.getNode(text(dnaHash));
    if (!node?.createdAt) return null;
    const ancestry = [...tree.ancestryOf(node.dnaHash), node];
    const rootNode = ancestry[0];
    if (!rootNode) return null;

    const rootDna = dnaService.listStrategyDna().find((row) => row.dnaHash === rootNode.dnaHash);
    if (!rootDna) return null;
    if (node.dnaHash === rootDna.dnaHash) return rootDna;

    let current = rootDna;
    for (const step of ancestry.slice(1)) {
      const changes = step?.mutation?.changes;
      if (!changes) return null;
      const mutated = dnaService.mutateStrategyDna(current, changes, {
        mutationType: step.mutationType || MUTATION_TYPES.PARAMETER,
        branch: step.branch || null,
      });
      if (!mutated.ok) return null;
      current = mutated.dna;
    }
    // Bygget måste landa på nodens egen hash. Gör det inte det är genomet inte
    // det noden beskriver, och att använda det hade förfalskat släktskapet.
    return current.dnaHash === node.dnaHash ? current : null;
  }

  /**
   * Föräldern som är värd att mutera härnäst inom en familj.
   *
   * Den nod som har FÄRRAST barn, alltså den minst utforskade. Roten vinner så
   * länge den har outforskade steg kvar; när den är uttömd tar dess barn över,
   * och evolutionen fortsätter ned i generationerna i stället för att stanna.
   *
   * Pensionerade noder räknas inte — en stängd gren får inte få nya barn.
   */
  function nextParentFor(rootDnaHash, { scoreOf = null } = {}) {
    const rootHash = text(rootDnaHash);
    if (!rootHash) return null;
    const candidates = [tree.getNode(rootHash), ...tree.descendantsOf(rootHash)]
      .filter((node) => node?.createdAt && node.retired !== true);
    if (!candidates.length) return null;

    // ── Bevis före utforskning, när bevis finns ──────────────────────────────
    //
    // Utan `scoreOf` väljs den minst utforskade noden. Det är rätt så länge
    // ingenting är MÄTT: att bygga vidare på ett genom man inte vet något om är
    // inte ett val, det är en gissning.
    //
    // Så fort ett genom har evidens ändras frågan. Då är det bästa uppmätta
    // genomet den rimliga föräldern — det är hela poängen med evolution, att
    // nästa generation utgår från det som visat sig fungera i stället för att
    // sprida sig jämnt över allt.
    //
    // Poängsättaren INJICERAS. Motorn får inte känna till Strategy Library:
    // den skapar DNA och bokför släktskap, och ett steg som också läser
    // resultat hade blandat ihop "vad är släkt med vad" med "vad var bra".
    const scores = new Map();
    if (typeof scoreOf === 'function') {
      for (const node of candidates) {
        let value = null;
        try { value = scoreOf(node); } catch (_) { value = null; }
        if (Number.isFinite(Number(value))) scores.set(node.dnaHash, Number(value));
      }
    }

    const scored = candidates
      .map((node) => ({
        node,
        children: tree.childrenOf(node.dnaHash).filter((child) => child.retired !== true).length,
        score: scores.has(node.dnaHash) ? scores.get(node.dnaHash) : null,
      }))
      .sort((a, b) => {
        // Uppmätta genom går före omätta. Bland de uppmätta vinner det bästa.
        if (a.score != null && b.score != null && a.score !== b.score) return b.score - a.score;
        if (a.score != null && b.score == null) return -1;
        if (a.score == null && b.score != null) return 1;
        // Därefter minst utforskad, grundast, och sist hashen — så att valet är
        // deterministiskt och går att räkna om i efterhand.
        return a.children - b.children
          || a.node.generation - b.node.generation
          || String(a.node.dnaHash).localeCompare(String(b.node.dnaHash));
      });

    for (const row of scored) {
      const dna = dnaForNode(row.node.dnaHash);
      if (dna) return dna;
    }
    return null;
  }

  /**
   * Som evolve(), men skriver inte.
   *
   * Bygger genomet och slår upp om trädet redan har det, utan att lägga till
   * något. Hasharna blir identiska med vad evolve() hade producerat — det är
   * samma mutateStrategyDna som räknar dem — så ett förslag går att jämföra
   * med ett faktiskt skapat genom.
   */
  function previewEvolve({ parentDna, changes = {}, mutationType = MUTATION_TYPES.PARAMETER, branch = null } = {}) {
    if (!parentDna?.dnaHash) return { ok: false, reason: 'parent_dna_required' };
    if (!Object.values(MUTATION_TYPES).includes(mutationType)) {
      return { ok: false, reason: `unknown_mutation_type:${mutationType}` };
    }
    if (tree.getNode(parentDna.dnaHash)?.retired) {
      return { ok: false, reason: 'parent_is_retired', parent: parentDna.dnaHash };
    }
    const mutation = dnaService.mutateStrategyDna(parentDna, changes, { mutationType, branch });
    if (!mutation.ok) return { ok: false, reason: mutation.reason, rejected: mutation.rejected };

    const existing = tree.getNode(mutation.dna.dnaHash);
    const parentNode = tree.getNode(parentDna.dnaHash);
    return {
      ok: true,
      dna: mutation.dna,
      // Noden är en FÖRHANDSVISNING när genomet inte redan finns. Den är inte
      // skriven någonstans och får inte behandlas som om den vore det.
      node: existing || {
        dnaHash: mutation.dna.dnaHash,
        parent: parentDna.dnaHash,
        generation: (parentNode?.generation ?? 0) + 1,
        preview: true,
      },
      alreadyPresent: Boolean(existing?.createdAt),
      generation: existing?.generation ?? ((parentNode?.generation ?? 0) + 1),
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
        usesOptimizer: true,
        runsReplay: false,
        ownsOptimization: false,
        selectsWinner: false,
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
    previewEvolve,
    createOptimizedDnaCandidates,
    dnaForNode,
    nextParentFor,
    describeLineage,
    getStatus,
    familyTree: tree,
    _internal: { exploredParameterPaths },
  };
}

module.exports = {
  SAFETY,
  ENGINE_VERSION,
  MUTATION_TYPES,
  createEvolutionEngine,
};
