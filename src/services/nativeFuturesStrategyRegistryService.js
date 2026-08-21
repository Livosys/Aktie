'use strict';

/**
 * nativeFuturesStrategyRegistryService — READ-ONLY register över de native
 * futures-strategierna och deras koppling till legacy-katalogen.
 *
 * Varje migrerad strategi deklarerar själv sitt ursprung via ORIGIN_STRATEGY_ID.
 * Det här registret läser den deklarationen i stället för att duplicera den i en
 * handskriven tabell, så kopplingen kan aldrig glida isär från koden.
 *
 * Registret handlar inte, utvärderar inga signaler och ändrar inget tillstånd.
 * Det finns för att observability-lagret ska kunna svara på frågan "vilken
 * legacy-strategi är det här native-id:t?" — vilket behövs eftersom trades,
 * intents och broker-order stämplas med native-id medan strategiöversikten,
 * approvals och performance är nycklade på legacy-id.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'native_futures_strategy_registry',
});

// DEN ENDA listan över native futures-strategier i systemet.
//
// Tidigare fanns den två gånger: här, och som NATIVE_STRATEGY_EVALUATORS inuti
// nativeFuturesSignalProvider. Två listor över samma sak glider förr eller
// senare isär — och konsekvensen hade varit tyst: en strategi som körs i paper
// men inte syns i registret, eller tvärtom. Providern läser numera härifrån,
// vilket också är det som gör att Replay kan köra utan att känna till en enda
// strategi. Registrera en modul här och den dyker upp i BÅDA.
const STRATEGY_MODULES = Object.freeze([
  require('./nativeFuturesMomentumStrategyService'),
  require('./nativeFuturesNarrowStateExpansionStrategyService'),
  require('./nativeFuturesEmaPullbackContinuationStrategyService'),
  require('./nativeFuturesVwapVolumeBreakoutStrategyService'),
  require('./nativeFuturesVwapFailedBreakoutShortStrategyService'),
  require('./nativeFuturesTrendContinuationStrategyService'),
  require('./nativeFuturesNarrowBreakoutShortStrategyService'),
  require('./nativeFuturesNarrowFakeoutReversalStrategyService'),
]);

function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function describe(strategyModule) {
  const strategyId = text(strategyModule?.STRATEGY_ID);
  if (!strategyId) return null;
  const originStrategyId = text(strategyModule?.ORIGIN_STRATEGY_ID);
  return Object.freeze({
    strategyId,
    strategyVersion: text(strategyModule?.STRATEGY_VERSION),
    // null = native från början (ingen legacy-förlaga att spegla tillbaka mot).
    originStrategyId,
    migrated: originStrategyId != null,
    targetSignalFamily: text(strategyModule?.TARGET_SIGNAL_FAMILY),
    targetSignalSubtype: text(strategyModule?.TARGET_SIGNAL_SUBTYPE),
    // Strategins egna parametrar, som de står i koden. Underlaget för Strategy
    // DNA:s muterbara block — så att ingen handskriven parametertabell behöver
    // finnas vid sidan av strategierna.
    defaultOptions: Object.freeze({ ...(strategyModule?.DEFAULT_OPTIONS || {}) }),
  });
}

const DESCRIPTORS = Object.freeze(STRATEGY_MODULES.map(describe).filter(Boolean));

// ── evaluators ───────────────────────────────────────────────────────────────
//
// Varje strategimodul exporterar exakt en `evaluate*`-funktion, men under sitt
// eget namn (evaluateNativeFuturesMomentumStrategy, ...). Konventionen läses
// här i stället för att varje anropare importerar de åtta namnen för hand.
//
// Hittas noll eller flera kastar modulen vid inläsning. En strategi som tyst
// hoppas över är den värsta av de tänkbara utgångarna: paper och replay skulle
// då köra olika uppsättningar utan att någonting rapporterade det.
function resolveEvaluator(strategyModule) {
  const keys = Object.keys(strategyModule || {})
    .filter((key) => key.startsWith('evaluate') && typeof strategyModule[key] === 'function');
  const strategyId = text(strategyModule?.STRATEGY_ID) || '(okänd modul)';
  if (keys.length !== 1) {
    throw new Error(
      `${strategyId}: en strategimodul måste exportera exakt en evaluate*-funktion, hittade ${keys.length} (${keys.join(', ') || 'inga'})`,
    );
  }
  return strategyModule[keys[0]];
}

const EVALUATORS = Object.freeze(
  STRATEGY_MODULES
    .filter((strategyModule) => text(strategyModule?.STRATEGY_ID))
    .map((strategyModule) => Object.freeze({
      strategyId: text(strategyModule.STRATEGY_ID),
      evaluate: resolveEvaluator(strategyModule),
    })),
);

const BY_STRATEGY_ID = new Map(DESCRIPTORS.map((row) => [row.strategyId, row]));

// Ett legacy-id kan i princip bära flera native-implementationer. Det gör det
// inte idag, men kartan är en lista så att en framtida andra implementation
// syns som en tvetydighet i stället för att tyst skriva över den första.
const BY_ORIGIN_STRATEGY_ID = (() => {
  const map = new Map();
  for (const row of DESCRIPTORS) {
    if (!row.originStrategyId) continue;
    const bucket = map.get(row.originStrategyId) || [];
    bucket.push(row);
    map.set(row.originStrategyId, bucket);
  }
  for (const [key, bucket] of map) map.set(key, Object.freeze(bucket));
  return map;
})();

// ── Registrerade varianter ───────────────────────────────────────────────────
//
// Strategy Registry innehåller 166 strategier. Åtta av dem har kod. Resten är
// inte andra strategier — de är samma åtta körda med andra tal: katalogens
// variantexpansion (balanced/fast/patient/volatile) och deras kanoniska
// förlagor.
//
// Vägen dit saknades. Providern anropade evaluate(snapshot, { now }) och
// strategins egna DEFAULT_OPTIONS var det enda som någonsin nådde fram.
// Genomet som Strategy DNA räknar fram ur registret stannade i registret, och
// 158 registrerade parameteruppsättningar kunde därför aldrig köras.
//
// Här kopplas kedjan ihop:
//
//   Strategy Registry → Strategy DNA → defaultOptions → evaluate()
//
// Strategilogiken är oförändrad. Modulen får sina egna optionsnamn ifyllda med
// registrets värden i stället för med sina inbyggda.
//
// ── Varför variantens id är REGISTRETS id ────────────────────────────────────
//
// En variant körs som `ema_pullback_continuation__fast`, inte som ett tredje
// påhittat id. Det är namnet resten av systemet redan känner: registret, DNA,
// biblioteket, hjärnan och godkännandet är alla nycklade på det. Ett eget
// namnrum hade varit motsatsen till att koppla ihop kedjan.

// Vilken modul som äger vilket native-id. Behövs för att läsa modulens
// DEFAULT_OPTIONS — bara de nycklar strategin själv deklarerar får fyllas i.
const MODULE_BY_STRATEGY_ID = new Map(
  STRATEGY_MODULES
    .filter((strategyModule) => text(strategyModule?.STRATEGY_ID))
    .map((strategyModule) => [text(strategyModule.STRATEGY_ID), strategyModule]),
);

function moduleOptionKeys(strategyModule) {
  return Object.keys(strategyModule?.DEFAULT_OPTIONS || {});
}

/**
 * Strategins parametrar, hämtade ur genomet.
 *
 * Genomets nycklar är blockprefixade (`risk.stopLossPct`); strategin känner
 * bara det korta namnet. Prefixet skalas av här. Endast nycklar strategin
 * FAKTISKT deklarerar släpps igenom — resten av genomet är beskrivning
 * (familjenamn, marknadsetikett, variantnamn) och hade blivit tyst skräp i
 * settings-objektet. Endast ändliga tal passerar: en parameter som inte är ett
 * tal är inte en parameter.
 */
function optionsFromDna(dnaService, registryStrategyId, allowedKeys, registryService = null) {
  if (!allowedKeys.length) return null;
  // includeNative: false är inte en detalj. Strategy DNA slår annars upp
  // native-strategier först, och det uppslaget bygger den här tabellen — en
  // oändlig rekursion. Varianten härleds per definition ur katalograden.
  const dna = dnaService.getStrategyDna(registryStrategyId, {
    ...(registryService ? { registryService } : {}),
    includeNative: false,
  });
  if (!dna || !dna.genome) return null;
  const parameters = dnaService.parametersOf(dna.genome) || {};
  const options = {};
  for (const [key, value] of Object.entries(parameters)) {
    const short = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
    if (!allowedKeys.includes(short)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    options[short] = value;
  }
  return Object.keys(options).length ? options : null;
}

/** Skiljer variantens parametrar sig från modulens egna? */
function sameOptions(options, defaults = {}) {
  return Object.entries(options).every(([key, value]) => defaults[key] === value);
}

/**
 * Evaluator som kör basmodulen med variantens parametrar.
 *
 * Identiteten stämplas om av registret, inte av modulen. Utan omstämplingen
 * hade varje variant returnerat basens strategyId, och eftersom signal-id
 * härleds ur strategyId hade alla varianter fått IDENTISKA signal-id — replay
 * dedupliserar på signalId och hade tyst kört bort alla utom den första.
 * Varianterna hade då sett ut att köra utan att göra det.
 */
function boundEvaluator(evaluate, strategyId, strategyVersion, options) {
  return (snapshot, context = {}) => {
    const decision = evaluate(snapshot, { ...options, ...context });
    if (!decision || typeof decision !== 'object') return decision;
    return { ...decision, strategyId, strategyVersion };
  };
}

// Byggd en gång per process och sedan cachad. Att läsa registret och genomet
// kostar ~200 ms (166 strategier, källfilerna läses för kod-hashen) och
// providern anropas en gång per bar — utan cachen hade en replay-dag betalat
// den kostnaden tusentals gånger.
let variantCache = null;

function buildVariantTable() {
  // Lat require: registret och DNA hämtar i sin tur katalogen, och en cirkulär
  // require vid inläsning hade gett en halvfärdig modul åt den som råkade
  // laddas först.
  const registryService = require('./strategyRegistryService');
  const dnaService = require('./dna/strategyDnaService');

  const byOrigin = new Map();
  for (const row of registryService.listStrategies()) {
    const origin = text(row.origin_strategy_id || row.originStrategyId);
    if (!origin) continue;
    const bucket = byOrigin.get(origin) || [];
    bucket.push(row);
    byOrigin.set(origin, bucket);
  }

  const descriptors = [];
  const evaluators = [];
  for (const base of DESCRIPTORS) {
    if (!base.originStrategyId) continue;
    const strategyModule = MODULE_BY_STRATEGY_ID.get(base.strategyId);
    if (!strategyModule) continue;
    const allowedKeys = moduleOptionKeys(strategyModule);
    const evaluate = resolveEvaluator(strategyModule);

    for (const row of byOrigin.get(base.originStrategyId) || []) {
      const registryStrategyId = text(row.strategy_id || row.strategyId);
      const variantId = text(row.variant_id || row.variantId);
      if (!registryStrategyId || !variantId) continue;
      // Den kanoniska raden ÄR strategin som redan körs. Att ta med den hade
      // gett två evaluators med samma beteende och samma signal-id.
      if (variantId === 'canonical' || registryStrategyId === base.originStrategyId) continue;
      if (row.enabled === false) continue;

      const options = optionsFromDna(dnaService, registryStrategyId, allowedKeys, registryService);
      // Ingen parameter ur genomet = ingen skillnad mot basen. En sådan
      // "variant" hade bara varit en dubblett med annat namn.
      if (!options) continue;
      // Samma tal som basen är också en dubblett — katalogens `balanced`-profil
      // multiplicerar med 1,00 och landar därför exakt på förlagan. Två
      // evaluators med identiskt beteende men olika id ger två signaler på
      // samma läge, och replay hade räknat båda som riktiga affärer.
      if (sameOptions(options, strategyModule.DEFAULT_OPTIONS)) continue;

      const strategyVersion = `${base.strategyVersion || 'native'}:${variantId}`;
      descriptors.push(Object.freeze({
        strategyId: registryStrategyId,
        strategyVersion,
        originStrategyId: base.originStrategyId,
        migrated: true,
        targetSignalFamily: base.targetSignalFamily,
        targetSignalSubtype: base.targetSignalSubtype,
        defaultOptions: Object.freeze({ ...base.defaultOptions, ...options }),
        // Varianten är inte en egen implementation. Den pekar tillbaka på den
        // modul vars kod den kör, så att ingen läsare tror att det finns 36
        // strategifiler.
        baseStrategyId: base.strategyId,
        variantId,
      }));
      evaluators.push(Object.freeze({
        strategyId: registryStrategyId,
        evaluate: boundEvaluator(evaluate, registryStrategyId, strategyVersion, options),
      }));
    }
  }

  return {
    descriptors: Object.freeze(descriptors),
    evaluators: Object.freeze(evaluators),
    byStrategyId: new Map(descriptors.map((row) => [row.strategyId, row])),
  };
}

function variantTable() {
  if (!variantCache) variantCache = buildVariantTable();
  return variantCache;
}

// ── Muterade genom ───────────────────────────────────────────────────────────
//
// Evolution Engine skapar nya genom och bokför dem i släktträdet. Motorn
// deklarerar själv sin avsikt i returvärdet: `schedulerSelectsExperiments:
// true, queueExecutesJobs: true`. Vägen dit fanns inte — ett genom i trädet
// hade ingen evaluator, och kunde därför aldrig prövas. Evolutionen
// producerade föräldralösa noder.
//
// Ett muterat genom är inte en ny strategi. Det är rotstrategins kod körd med
// ackumulerade parameterändringar, alltså exakt samma mekanism som en
// registrerad variant. Den återanvänds här.
//
// Id:t bär genomets hash eftersom hashen ÄR genomets identitet: samma
// parameteruppsättning ger samma id oavsett hur många gånger den skapas, och
// AI Memory kan därmed känna igen experimentet.
const EVOLVED_ID_SEPARATOR = '@';

// Taket finns för att replay stegar synkront: varje genom kostar ~1,44 s per
// fyratimmarsfönster, och släktträdet växer med varje fabrikscykel. Utan tak
// hade körtiden vuxit obegränsat. Nyast först — de senaste generationerna är
// de som ännu inte har svar.
const EVOLVED_LIMIT = Math.max(0, Number(process.env.NATIVE_EVOLVED_STRATEGY_LIMIT) || 24);

let evolvedCache = null;

/** Ackumulerade parameterändringar från roten ned till noden. */
function evolvedOptionsFor(tree, node, baseOptions, allowedKeys) {
  const options = { ...baseOptions };
  let touched = false;
  for (const ancestor of tree.ancestryOf(node.dnaHash)) {
    const changes = ancestor?.mutation?.changes;
    if (!changes) continue;
    for (const [key, value] of Object.entries(changes)) {
      const short = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
      if (!allowedKeys.includes(short)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      options[short] = value;
      touched = true;
    }
  }
  return touched ? options : null;
}

/**
 * Ett genom som körbar strategi, eller null.
 *
 * Null betyder alltid något konkret: roten saknar kod, eller mutationen ändrade
 * ingenting strategin faktiskt läser. Ett genom utan läsbar ändring är inget
 * att pröva — det finns kvar i trädet, det körs bara inte.
 */
function evolvedStrategyFor(tree, node) {
  const rootId = text(node?.rootStrategyId || node?.strategyId);
  if (!rootId) return null;
  // Roten måste vara en strategi som går att köra — bas eller registrerad
  // variant. Ett genom vars rot saknar kod är ett genom utan kropp.
  const base = BY_STRATEGY_ID.get(rootId) || variantTable().byStrategyId.get(rootId);
  if (!base) return null;
  const strategyModule = MODULE_BY_STRATEGY_ID.get(base.baseStrategyId || base.strategyId);
  if (!strategyModule) return null;

  const allowedKeys = moduleOptionKeys(strategyModule);
  const options = evolvedOptionsFor(tree, node, base.defaultOptions, allowedKeys);
  if (!options || sameOptions(options, base.defaultOptions)) return null;

  const strategyId = `${rootId}${EVOLVED_ID_SEPARATOR}${node.dnaHash}`;
  const strategyVersion = `${base.strategyVersion || 'native'}:g${node.generation}`;
  return {
    descriptor: Object.freeze({
      strategyId,
      strategyVersion,
      originStrategyId: base.originStrategyId,
      migrated: base.migrated === true,
      targetSignalFamily: base.targetSignalFamily,
      targetSignalSubtype: base.targetSignalSubtype,
      defaultOptions: Object.freeze({ ...options }),
      baseStrategyId: base.baseStrategyId || base.strategyId,
      rootStrategyId: rootId,
      dnaHash: node.dnaHash,
      generation: node.generation,
      branch: node.branch || null,
      mutationType: node.mutationType || null,
    }),
    evaluator: Object.freeze({
      strategyId,
      evaluate: boundEvaluator(resolveEvaluator(strategyModule), strategyId, strategyVersion, options),
    }),
  };
}

function tableFrom(built) {
  const descriptors = built.map((row) => row.descriptor);
  return {
    descriptors: Object.freeze(descriptors),
    evaluators: Object.freeze(built.map((row) => row.evaluator)),
    byStrategyId: new Map(descriptors.map((row) => [row.strategyId, row])),
  };
}

function familyTree() {
  return require('./evolution/strategyFamilyTreeService').defaultStrategyFamilyTree;
}

function runnableGenomeNodes(tree) {
  return tree.listNodes().filter((node) => node.retired !== true && node.generation > 0 && node.parent);
}

function buildEvolvedTable() {
  if (EVOLVED_LIMIT === 0) return tableFrom([]);
  const tree = familyTree();
  const candidates = runnableGenomeNodes(tree)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, EVOLVED_LIMIT);
  return tableFrom(candidates.map((node) => evolvedStrategyFor(tree, node)).filter(Boolean));
}

// ── Genom som körningen UTTRYCKLIGEN har bett om ─────────────────────────────
//
// evolvedTable() tar de EVOLVED_LIMIT nyaste genomen. Taket finns av ett gott
// skäl — varje genom kostar ~1,44 s per fönster och trädet växer med varje
// fabrikscykel — men det gör listan till ett urval, inte ett löfte.
//
// Ett replay-jobb som skapades FÖR ett visst genom kan därför missa just det
// genomet: det räcker att 24 nyare genom hunnit skapas, eller att taket är
// noll. Körningen blir då ett svar på en annan fråga än den som ställdes, och
// evidensen skrivs mot en strategi som aldrig prövades.
//
// Ett uttryckligen begärt genom går därför förbi taket. Antalet är litet och
// styrs av den som schemalade jobbet, inte av trädets tillväxt.
function evolvedTableForHashes(hashes = []) {
  const wanted = new Set(hashes.map((hash) => text(hash)).filter(Boolean));
  if (!wanted.size) return tableFrom([]);
  const tree = familyTree();
  const nodes = runnableGenomeNodes(tree).filter((node) => wanted.has(text(node.dnaHash)));
  return tableFrom(nodes.map((node) => evolvedStrategyFor(tree, node)).filter(Boolean));
}

/**
 * Vad som hände med varje begärt genom. Ett genom som INTE gick att köra ska
 * synas som ett svar, inte som en tyst utebliven rad — en körning som tror sig
 * ha prövat ett genom den aldrig laddade är den farligaste sortens resultat.
 */
function describeRequestedGenomes(hashes = []) {
  const tree = familyTree();
  const byHash = new Map(runnableGenomeNodes(tree).map((node) => [text(node.dnaHash), node]));
  return hashes.map((raw) => {
    const dnaHash = text(raw);
    const node = dnaHash ? byHash.get(dnaHash) : null;
    if (!node) return { dnaHash, loaded: false, reason: 'genome_not_in_family_tree' };
    const built = evolvedStrategyFor(tree, node);
    if (!built) return { dnaHash, loaded: false, reason: 'genome_has_no_readable_change_or_root' };
    return {
      dnaHash,
      loaded: true,
      strategyId: built.descriptor.strategyId,
      rootStrategyId: built.descriptor.rootStrategyId,
      generation: built.descriptor.generation,
    };
  });
}

// Cachad för processens livstid, precis som varianttabellen. Replay körs i en
// egen barnprocess som startar om per körning, så den ser alltid ett färskt
// träd; serverprocessen använder inte den här listan för att handla.
function evolvedTable() {
  if (!evolvedCache) evolvedCache = buildEvolvedTable();
  return evolvedCache;
}

// ── Research-hypoteser ───────────────────────────────────────────────────────
//
// En executable research hypothesis är varken en modul, en variant eller ett
// muterat genom. Den är en EXPLICIT TOLKNING av ett strategikoncept som ännu
// inte har någon implementation — versionerad, källmärkt och avsedd att kunna
// förkastas utan att konceptet förkastas.
//
// Den ligger i registret av ett enda skäl: Native Replay hämtar alla evaluators
// härifrån, och en research-evaluator som inte fanns här hade krävt en andra
// väg in i motorn. Två vägar in i samma motor är hur ett parallellt system
// börjar.
//
// Grinden är flaggan. includeResearch är av som standard, precis som
// includeVariants och includeEvolved, och paper-vägen anropar utan flaggor.
// Hypoteserna kan därför inte nå Paper ens av misstag — och skulle en signal
// ändå läcka bär varje beslut researchOnly: true och paperEligible: false i
// nyttolasten, så läckan syns i innehållet och inte bara i id:t.
function researchModule() {
  // Lat require: modulen läser strategimodulerna som den här filen också äger.
  return require('./research/researchHypothesisEvaluatorService');
}

/**
 * Strategierna som registrerade enheter.
 *
 * Utan argument: de åtta modulerna, precis som förut. Med includeVariants
 * dessutom varje registrerad parameteruppsättning av dem.
 */
function listNativeStrategies({
  includeVariants = false, includeEvolved = false, includeResearch = false, includeBase = true,
  researchCycle = null,
  // Genom som körningen uttryckligen begärt. Går förbi EVOLVED_LIMIT — se
  // evolvedTableForHashes.
  genomeHashes = [],
} = {}) {
  const requested = genomeHashes.length ? evolvedTableForHashes(genomeHashes) : null;
  if (!requested && includeBase && !includeVariants && !includeEvolved && !includeResearch) return DESCRIPTORS;
  return dedupeById([
    ...(includeBase ? DESCRIPTORS : []),
    ...(includeVariants ? variantTable().descriptors : []),
    ...(includeEvolved ? evolvedTable().descriptors : []),
    ...(requested ? requested.descriptors : []),
    ...(includeResearch ? researchModule().listResearchDescriptors({ cycle: researchCycle }) : []),
  ]);
}

// Ett uttryckligen begärt genom kan redan ha kommit med via evolvedTable().
// Utan den här skulle det då köras TVÅ gånger, och båda körningarna skrivas in
// som separata affärer på samma strategi.
function dedupeById(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = text(row?.strategyId);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Strategierna som utvärderingsbara enheter, i registreringsordning.
 *
 * Det här är den enda vägen till en native-evaluator. Signal-providern (och
 * därmed både Paper och Replay) itererar över den här listan — ingen anropare
 * får importera en strategimodul direkt för att köra den.
 *
 * Utan argument returneras de åtta modulerna, oförändrat. Paper-vägen anropar
 * så och beter sig därför exakt som förut. Replay ber uttryckligen om
 * varianterna — kompositionsroten avgör, inte motorn.
 *
 * @returns {ReadonlyArray<{strategyId: string, evaluate: Function}>}
 */
// includeBase = false finns för EN sak: en research-batch ska kunna köras
// isolerad, så att varje affär i körningen tillhör en hypotes. Blandades de åtta
// produktionsstrategierna in i samma körning hade deras resultat skrivits in i
// biblioteket som en bieffekt av ett researchuppdrag — och en researchkörning
// får inte tyst producera produktionsevidens.
function listStrategyEvaluators({
  includeVariants = false, includeEvolved = false, includeResearch = false, includeBase = true,
  // Vilken forskningscykel som ska köras. null = samtliga. En avslutad cykels
  // hypoteser ska inte betala compute i en ny cykels batch — och deras evidens
  // ska inte skrivas om av en körning som inte handlar om dem.
  researchCycle = null,
  // Genom som körningen uttryckligen begärt. Går förbi EVOLVED_LIMIT.
  genomeHashes = [],
} = {}) {
  const requested = genomeHashes.length ? evolvedTableForHashes(genomeHashes) : null;
  if (!requested && includeBase && !includeVariants && !includeEvolved && !includeResearch) return EVALUATORS;
  return dedupeById([
    ...(includeBase ? EVALUATORS : []),
    ...(includeVariants ? variantTable().evaluators : []),
    ...(includeEvolved ? evolvedTable().evaluators : []),
    ...(requested ? requested.evaluators : []),
    ...(includeResearch ? researchModule().listResearchEvaluators({ cycle: researchCycle }) : []),
  ]);
}

/** Familj/subtyp för ett native-id. Det är den enda kopplingen som finns. */
function signalTaxonomyFor(strategyId) {
  const row = getNativeStrategy(strategyId);
  return {
    signalFamily: row?.targetSignalFamily || null,
    signalSubtype: row?.targetSignalSubtype || null,
  };
}

// Snabbvägen är de åtta modulerna. Varianttabellen konsulteras bara för id som
// bär variantsuffixet, så vanliga uppslag aldrig betalar för att den byggs.
function isVariantStrategyId(id) {
  return typeof id === 'string' && id.includes('__');
}

function isEvolvedStrategyId(id) {
  return typeof id === 'string' && id.includes(EVOLVED_ID_SEPARATOR);
}

function getNativeStrategy(strategyId) {
  const id = text(strategyId);
  const base = BY_STRATEGY_ID.get(id);
  if (base) return base;
  // Research-hypoteser slås upp på prefixet, före variant- och genomtabellerna.
  // Utan det uppslaget saknar en hypotes Strategy DNA, och utan DNA kan AI
  // Memory inte bilda en experimentidentitet — dubblettskyddet hade då varit
  // verkningslöst för precis det arbete fasen finns för.
  if (require('./research/researchHypothesisService').isResearchStrategyId(id)) {
    return researchModule().getResearchDescriptor(id);
  }
  if (isEvolvedStrategyId(id)) return evolvedTable().byStrategyId.get(id) || null;
  return isVariantStrategyId(id) ? (variantTable().byStrategyId.get(id) || null) : null;
}

function isNativeStrategyId(strategyId) {
  const id = text(strategyId);
  if (BY_STRATEGY_ID.has(id)) return true;
  // En research-hypotes är körbar av samma motor och bokförs i samma bibliotek,
  // så id:t måste gå att lösa upp här. Att den INTE är en runtime-strategi
  // avgörs av grindarna (researchOnly, runtimeEligible, paperEligible) och av
  // att paper-vägen aldrig ber om includeResearch — inte av att biblioteket
  // vägrar känna igen namnet. Ett resultat utan ägare hade varit sämre.
  if (require('./research/researchHypothesisService').isResearchStrategyId(id)) {
    return researchModule().getResearchDescriptor(id) != null;
  }
  if (isEvolvedStrategyId(id)) return evolvedTable().byStrategyId.has(id);
  return isVariantStrategyId(id) ? variantTable().byStrategyId.has(id) : false;
}

/** Native-id → legacy-id. null när id:t inte är native eller saknar förlaga. */
function originStrategyIdFor(strategyId) {
  return getNativeStrategy(strategyId)?.originStrategyId || null;
}

/** Legacy-id → native-descriptorer. Tom lista när strategin inte är migrerad. */
function nativeStrategiesForOrigin(originStrategyId) {
  return BY_ORIGIN_STRATEGY_ID.get(text(originStrategyId)) || [];
}

/**
 * Den enda native-implementationen av ett legacy-id, eller null när strategin
 * inte är migrerad ELLER när flera implementationer gör svaret tvetydigt.
 * Tvetydighet löses aldrig genom gissning.
 */
function soleNativeStrategyForOrigin(originStrategyId) {
  const rows = nativeStrategiesForOrigin(originStrategyId);
  return rows.length === 1 ? rows[0] : null;
}

module.exports = {
  SAFETY,
  listNativeStrategies,
  listStrategyEvaluators,
  signalTaxonomyFor,
  getNativeStrategy,
  isNativeStrategyId,
  originStrategyIdFor,
  nativeStrategiesForOrigin,
  soleNativeStrategyForOrigin,
  describeRequestedGenomes,
  _internal: {
    // Varianttabellen är cachad för processens livstid. Tester som byter
    // registerinnehåll måste kunna nolla den; drift har inget behov av det.
    resetVariantCache() { variantCache = null; evolvedCache = null; },
    optionsFromDna,
    evolvedOptionsFor,
    EVOLVED_ID_SEPARATOR,
    EVOLVED_LIMIT,
  },
};
