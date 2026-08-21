'use strict';

// ── Strategy DNA ─────────────────────────────────────────────────────────────
//
// En strategis arvsmassa: tretton block som beskriver vad den gör, i en form
// som går att mutera utan att någon rör strategikoden.
//
// ── Varför DNA inte kan vara en handskriven tabell ──────────────────────────
//
// Frestelsen är att skriva ett genom per strategi för hand. Det vore en åttonde
// parallell strategilista, den skulle glida isär från koden första gången någon
// ändrade en parameter, och avvikelsen skulle vara tyst — mutationer räknade på
// ett genom som inte längre motsvarar det som körs.
//
// DNA HÄRLEDS därför:
//
//   registret            strategyId, version, ursprung, signalfamilj
//   DEFAULT_OPTIONS      strategins egna parametrar, som de står i koden
//   källfilen            vilka indikatorfamiljer den faktiskt använder
//
// Ändras koden ändras DNA:t. Det är hela poängen med en arvsmassa.
//
// ── Deklarerat, härlett, standard ───────────────────────────────────────────
//
// Varje block bär sin HÄRKOMST, och det är det som gör DNA:t ärligt:
//
//   declared  strategin har uttryckligen sagt det (DEFAULT_OPTIONS)
//   inferred  läst ur koden (anropar strategin calcVwap använder den VWAP)
//   default   schemats standardvärde — vi vet inte, vi antar
//
// Bara `declared`-block är MUTERBARA. En mutation på ett härlett block vore en
// mutation på en gissning, och en optimerare som får ändra gissningar optimerar
// mot sin egen okunskap. Ett härlett block beskriver; det styr inget.
//
// ── Hash ────────────────────────────────────────────────────────────────────
//
// Kanonisk serialisering: nycklar sorterade, tal normaliserade. Samma genom ger
// samma hash oavsett i vilken ordning fälten råkar skrivas — annars kan AI
// Memory inte känna igen ett experiment den redan kört.
//
// Ren modul: läser källfiler vid härledning, skriver aldrig, ingen klocka.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const registry = require('../strategyRegistryService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  source: 'strategy_dna',
});

const DNA_VERSION = 'strategy_dna_v1';

// De tretton blocken. Ordningen är fast och hashen sorterar ändå — listan finns
// för att ett genom ska gå att läsa och för att ett saknat block ska synas.
const DNA_BLOCKS = Object.freeze([
  'entry',
  'confirmation',
  'momentum',
  'trend',
  'vwap',
  'volume',
  'atr',
  'risk',
  'exit',
  'session',
  'time',
  'marketFilter',
  'activeBlocks',
]);

const PROVENANCE = Object.freeze({
  DECLARED: 'declared',
  INFERRED: 'inferred',
  DEFAULT: 'default',
});

// Vilka parametrar som hör till vilket block. Enda kopplingen mellan en
// strategis optionsnamn och arvsmassans struktur, och den är namnbaserad — en
// ny parameter som heter stopLossPct hamnar rätt utan att någon rör listan.
const OPTION_BLOCK_MAP = Object.freeze({
  stopLossPct: 'risk',
  minStopDistancePoints: 'risk',
  tickSize: 'risk',
  takeProfitR: 'exit',
  rewardMultiple: 'exit',
  minBodyPoints: 'entry',
  minBodyToRangeRatio: 'entry',
});

// Indikatoranrop → block. Används bara för att BESKRIVA vad koden gör.
const INDICATOR_SIGNATURES = Object.freeze({
  vwap: [/calcVwap/, /\bvwap\b/i],
  atr: [/\batr\s*\(/, /atrPct/],
  trend: [/\bema\s*\(/, /emaFast|emaSlow|sma200/],
  momentum: [/momentumStrategy/, /bodyToRange|minBodyPoints/],
  volume: [/volumeRatio|relativeVolume|\.volume\b/],
  confirmation: [/buildDecisionMonitor|classifySignalFamily/],
});

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

// Kanonisk form: sorterade nycklar hela vägen ned, tal som tal. Utan den kan
// två identiska genom serialiseras olika och därmed hasha olika.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonical(value[key]);
      return acc;
    }, {});
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(12)) : null;
  return value;
}

function emptyBlock(name) {
  return { block: name, provenance: PROVENANCE.DEFAULT, mutable: false, values: {} };
}

function blankGenome() {
  return Object.fromEntries(DNA_BLOCKS.map((name) => [name, emptyBlock(name)]));
}

// Läser strategins källfil. Samma konvention som biblioteket använder för sin
// kod-hash: filen som deklarerar STRATEGY_ID är strategins fil.
function readStrategySource(strategyId, dir = path.resolve(__dirname, '..')) {
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!/^nativeFutures.*StrategyService\.js$/.test(file) || file.includes('.test.')) continue;
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      if (content.includes(`STRATEGY_ID = '${strategyId}'`)) return content;
    }
  } catch (_) { /* saknad källfil ger ett genom utan härledda block */ }
  return null;
}

/**
 * Härleder DNA för en registrerad strategi.
 *
 * @param {object} descriptor  från registry.listNativeStrategies()
 */
function deriveStrategyDna(descriptor, { source = null } = {}) {
  const strategyId = text(descriptor?.strategyId || descriptor?.strategy_id || descriptor?.id);
  if (!strategyId) return null;
  const code = source !== null ? source : readStrategySource(strategyId);
  const genome = blankGenome();

  // ── deklarerade parametrar ────────────────────────────────────────────────
  const defaultOptions = descriptor?.defaultOptions || descriptor?.default_options || {};
  for (const [key, value] of Object.entries(defaultOptions)) {
    const blockName = OPTION_BLOCK_MAP[key] || 'entry';
    const block = genome[blockName];
    block.values[key] = value;
    block.provenance = PROVENANCE.DECLARED;
    // Bara det strategin själv deklarerar får muteras.
    block.mutable = true;
  }

  // ── härledda egenskaper ───────────────────────────────────────────────────
  if (code) {
    for (const [blockName, patterns] of Object.entries(INDICATOR_SIGNATURES)) {
      const uses = patterns.some((pattern) => pattern.test(code));
      if (!uses) continue;
      const block = genome[blockName];
      block.values.used = true;
      // Ett redan deklarerat block behåller sin härkomst; ett härlett block
      // beskriver bara och får aldrig muteras.
      if (block.provenance === PROVENANCE.DEFAULT) {
        block.provenance = PROVENANCE.INFERRED;
        block.mutable = false;
      }
    }
  }

  // ── signaltaxonomi ────────────────────────────────────────────────────────
  if (descriptor.targetSignalFamily || descriptor.targetSignalSubtype) {
    genome.confirmation.values.signalFamily = descriptor.targetSignalFamily || null;
    genome.confirmation.values.signalSubtype = descriptor.targetSignalSubtype || null;
    genome.confirmation.provenance = PROVENANCE.DECLARED;
    // Taxonomin är en identitet, inte en ratt. Den muteras aldrig.
    genome.confirmation.mutable = false;
  }

  // ── aktiva block ──────────────────────────────────────────────────────────
  // Härlett fält, inte ett eget block med egna värden: vilka block som faktiskt
  // bär något. Gör en tom arvsmassa synlig i stället för att se komplett ut.
  genome.activeBlocks.values.blocks = DNA_BLOCKS
    .filter((name) => name !== 'activeBlocks')
    .filter((name) => Object.keys(genome[name].values).length > 0);
  genome.activeBlocks.provenance = PROVENANCE.INFERRED;
  genome.activeBlocks.mutable = false;

  return finalizeDna({
    strategyId,
    strategyVersion: descriptor.strategyVersion || descriptor.strategy_version || null,
    originStrategyId: descriptor.originStrategyId || descriptor.origin_strategy_id || null,
    genome,
    lineage: { parent: null, generation: 0, mutationType: null, branch: 'root', rootStrategyId: strategyId },
  });
}

/** Räknar hash och sammanfattning. Enda stället en DNA-hash uppstår. */
function finalizeDna(dna) {
  const canonicalGenome = canonical(
    Object.fromEntries(DNA_BLOCKS.map((name) => [name, dna.genome[name]?.values || {}])),
  );
  const serialized = JSON.stringify(canonicalGenome);
  const mutableBlocks = DNA_BLOCKS.filter((name) => dna.genome[name]?.mutable === true);

  return {
    ...dna,
    dnaHash: sha(`${DNA_VERSION}::${serialized}`),
    // Parametrarnas egen hash. Två genom som skiljer sig bara i muterbara
    // värden delar struktur men inte parameterHash — det är den AI Memory
    // använder för att skilja en mutation från en annan.
    parameterHash: sha(`${DNA_VERSION}::params::${JSON.stringify(canonical(parametersOf(dna.genome)))}`),
    blocks: DNA_BLOCKS,
    mutableBlocks,
    declaredBlocks: DNA_BLOCKS.filter((name) => dna.genome[name]?.provenance === PROVENANCE.DECLARED),
    inferredBlocks: DNA_BLOCKS.filter((name) => dna.genome[name]?.provenance === PROVENANCE.INFERRED),
    canonical: canonicalGenome,
    version: DNA_VERSION,
    ...SAFETY,
  };
}

/** Alla muterbara värden som en platt karta blocknamn.parameter → värde. */
function parametersOf(genome) {
  const out = {};
  for (const name of DNA_BLOCKS) {
    const block = genome[name];
    if (!block || block.mutable !== true) continue;
    for (const [key, value] of Object.entries(block.values)) out[`${name}.${key}`] = value;
  }
  return out;
}

/**
 * Muterar ett genom.
 *
 * Endast muterbara block. En mutation som pekar på ett härlett eller
 * standardblock AVVISAS med skäl — den skulle ändra en beskrivning av koden
 * utan att koden ändrades, och nästa härledning skulle skriva tillbaka den.
 *
 * @param {object} dna      genom att utgå från
 * @param {object} changes  { 'risk.stopLossPct': 0.3, ... }
 */
function mutateStrategyDna(dna, changes = {}, { mutationType = 'parameter', branch = null } = {}) {
  const rejected = [];
  const applied = {};
  const genome = JSON.parse(JSON.stringify(dna.genome));

  for (const [path_, value] of Object.entries(changes)) {
    const [blockName, key] = String(path_).split('.');
    const block = genome[blockName];
    if (!block) { rejected.push({ path: path_, reason: `unknown_block:${blockName}` }); continue; }
    if (block.mutable !== true) {
      rejected.push({ path: path_, reason: `block_not_mutable:${blockName}:${block.provenance}` });
      continue;
    }
    if (!(key in block.values)) {
      rejected.push({ path: path_, reason: `unknown_parameter:${path_}` });
      continue;
    }
    if (typeof value !== typeof block.values[key]) {
      rejected.push({ path: path_, reason: `type_mismatch:${path_}` });
      continue;
    }
    block.values[key] = value;
    applied[path_] = value;
  }

  if (!Object.keys(applied).length) {
    return { ok: false, reason: 'no_applicable_changes', rejected, dna: null };
  }

  const mutated = finalizeDna({
    strategyId: dna.strategyId,
    strategyVersion: dna.strategyVersion,
    originStrategyId: dna.originStrategyId,
    genome,
    lineage: {
      parent: dna.dnaHash,
      generation: (dna.lineage?.generation ?? 0) + 1,
      mutationType,
      branch: branch || dna.lineage?.branch || 'root',
      rootStrategyId: dna.lineage?.rootStrategyId || dna.strategyId,
    },
  });

  return { ok: true, dna: mutated, applied, rejected, parent: dna.dnaHash };
}

/** Skillnaden mellan två genom, som en läsbar lista. */
function diffStrategyDna(a, b) {
  const left = parametersOf(a.genome);
  const right = parametersOf(b.genome);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => ({ path: key, from: left[key] ?? null, to: right[key] ?? null }));
}

/**
 * DNA för samtliga registrerade strategier.
 *
 * Populationen kommer ur registret. Ingen lista här.
 */
// ── Två register, en population ──────────────────────────────────────────────
//
// Strategy Registry svarar på "vilka strategier är registrerade". Native
// Futures Strategy Registry svarar på "vilka strategier har kod som går att
// köra". Populationen är unionen, och den distinktionen fick reella följder:
//
// Biblioteket — och därmed Strategy Brain — är nycklat på BÅDA namnrymderna.
// Hjärnan väljer alltså regelbundet ut ett native-id, medan DNA-populationen
// bara innehöll katalogens id:n. Evolution Engine slog upp föräldern i
// populationen, hittade ingenting, och hoppade över steget med
// `parent_dna_not_found` — varje gång. Ingen mutation har någonsin skapats.
//
// Vid id-krock vinner native-descriptorn. Den bär exakt de parametrar
// evaluatorn läser, medan katalograden dessutom bär beskrivande fält
// (familjenamn, marknadsetikett). Att mutera en marknadsetikett är inte en
// mutation, och muterbarheten avgörs av vilken descriptor genomet härleds ur.
function nativeRegistryModule() {
  // Lat require: native-registret hämtar i sin tur Strategy Registry, som
  // hämtar katalogen. En cirkulär require vid inläsning hade gett en
  // halvfärdig modul åt den som råkade laddas först.
  return require('../nativeFuturesStrategyRegistryService');
}

// includeNative styr om native-registret räknas med. Den enda anroparen som
// stänger av det är native-registret självt när det bygger sin varianttabell:
// varianternas parametrar HÄRLEDS ur katalogen, och ett native-uppslag där
// hade bett tabellen om sig själv.
function populationDescriptors(registryService, includeNative) {
  const catalog = typeof registryService.listStrategies === 'function'
    ? registryService.listStrategies()
    : (typeof registryService.listNativeStrategies === 'function' ? registryService.listNativeStrategies() : []);

  const byId = new Map();
  for (const descriptor of catalog) {
    const id = text(descriptor?.strategyId || descriptor?.strategy_id || descriptor?.id);
    if (id) byId.set(id, descriptor);
  }

  if (includeNative) {
    for (const descriptor of nativeRegistryModule().listNativeStrategies({ includeVariants: true })) {
      if (descriptor?.strategyId) byId.set(descriptor.strategyId, descriptor);
    }
  }

  return [...byId.values()];
}

function listStrategyDna({ registryService = registry, includeNative = true } = {}) {
  return populationDescriptors(registryService, includeNative !== false)
    .map((descriptor) => deriveStrategyDna(descriptor))
    .filter(Boolean);
}

function getStrategyDna(strategyId, { registryService = registry, includeNative = true } = {}) {
  if (includeNative !== false) {
    const native = nativeRegistryModule().getNativeStrategy(strategyId);
    if (native) return deriveStrategyDna(native);
  }
  const descriptor = typeof registryService.getStrategy === 'function'
    ? registryService.getStrategy(strategyId)
    : (typeof registryService.getNativeStrategy === 'function' ? registryService.getNativeStrategy(strategyId) : null);
  return descriptor ? deriveStrategyDna(descriptor) : null;
}

module.exports = {
  SAFETY,
  DNA_VERSION,
  DNA_BLOCKS,
  PROVENANCE,
  OPTION_BLOCK_MAP,
  deriveStrategyDna,
  mutateStrategyDna,
  diffStrategyDna,
  listStrategyDna,
  getStrategyDna,
  parametersOf,
  _internal: { canonical, finalizeDna, readStrategySource, blankGenome },
};
