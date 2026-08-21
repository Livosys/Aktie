'use strict';

// ── AI Memory ────────────────────────────────────────────────────────────────
//
// Minnet av vad som redan är prövat. AI ska aldrig optimera blint — den ska
// fråga minnet först, och minnet ska kunna svara "det där har vi kört, resultatet
// finns i Strategy Library" utan att en enda replay startas.
//
// Minnet lagrar INTE text. Det lagrar experiment.
//
// ── Nyckeln är Market DNA, inte datum ───────────────────────────────────────
//
// Det här är hela skillnaden mellan ett minne och en logg.
//
// Ett experiment identifieras av:
//
//   Strategy DNA  ×  Parameter Hash  ×  Market DNA  ×  Replay Mode
//                 ×  Execution Model  ×  Version
//
// Perioden — de faktiska datumen — är INTE med. Den lagras som härkomst, men
// den identifierar ingenting. Två veckor med samma marknadsprofil är samma
// marknad, och att köra om samma strategi på den andra veckan vore att betala
// för ett svar vi redan har.
//
// Hade datum ingått i nyckeln skulle varje ny dag göra varje tidigare experiment
// oigenkännligt, minnet skulle aldrig träffa, och "fråga minnet först" hade
// varit en ceremoni utan verkan.
//
// Motsatsen är också värd att säga: två perioder med OLIKA marknadsprofil är
// olika experiment även om strategin är identisk. Det är därför Market DNA
// måste vara kvantiserat och inte en hash av råa mätvärden — se
// marketDnaService.
//
// ── Vad minnet kan svara på ─────────────────────────────────────────────────
//
//   Har vi testat detta?        hasExperiment / lookup
//   Var finns resultatet?        libraryRef till Strategy Library
//   Vilken mutation skapade det? lineage.mutationType
//   Vilken strategi var förälder? lineage.parent
//   Vilken marknad?             marketDnaHash + regimeKeys
//   Vilken period?              period (härkomst, inte identitet)
//   Vilken replaymodell?        replayMode + executionModel
//
// Append-only via den delade händelseloggen. Gallras aldrig.

const crypto = require('crypto');
const path = require('path');

const { createEventLog } = require('../../data/eventLog');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'ai_memory',
});

const MEMORY_VERSION = 'ai-memory-v1';
// Env-överstyrbar enligt samma mönster som STRATEGY_LIBRARY_EVENTS_FILE och
// STRATEGY_FAMILY_TREE_FILE. Utan den skrev en sandlådekörning sina
// experimentidentiteter i DRIFTENS minne även när biblioteket och släktträdet
// var omdirigerade — barnprocessen bygger sin recorder med default-minnet, och
// env var enda vägen in i den. Det inträffade 2026-08-19 (472 händelser).
const DEFAULT_EVENTS_FILE = path.resolve(
  process.env.AI_MEMORY_EVENTS_FILE
    || path.resolve(__dirname, '../../../data/ai-memory/experiments.jsonl'),
);

const EVENT_TYPES = Object.freeze({
  EXPERIMENT_RECORDED: 'EXPERIMENT_RECORDED',
  EXPERIMENT_SUPERSEDED: 'EXPERIMENT_SUPERSEDED',
  // ── Varför uteslutning och inte radering ───────────────────────────────────
  //
  // Loggen är append-only och gallras aldrig. Ett experiment som visar sig sakna
  // giltighet för lärande får därför inte tas bort — det får en händelse som
  // säger VARFÖR det inte gäller, och projektionen bär den vidare. Historiken
  // förblir läsbar, och den som undrar varför ett experiment inte längre
  // blockerar en körning kan se svaret i loggen i stället för att gissa.
  //
  // Uteslutning är inte samma sak som EXPERIMENT_SUPERSEDED. Supersede säger
  // "ett nyare experiment ersätter detta"; uteslutning säger "detta skulle
  // aldrig ha räknats som produktionskunskap".
  EXPERIMENT_EXCLUDED: 'EXPERIMENT_EXCLUDED',
});

// Varför ett experiment inte gäller som produktionskunskap. Listan är sluten:
// en uteslutning utan en av dessa orsaker är en åsikt, inte ett faktum.
const EXCLUSION_REASONS = Object.freeze({
  // Kördes för att verifiera kedjan, inte för att producera kunskap.
  SANDBOX_VERIFICATION_ONLY: 'SANDBOX_VERIFICATION_ONLY',
  // Identiteten finns men resultatet gick inte att hitta i Strategy Library.
  ORPHANED: 'ORPHANED',
  // Härkomsten bryter mot kanonisk datapolicy (fel dataAccessMode, otillåten
  // sammanfogning av kontrakt, okänd period).
  NON_CANONICAL_PROVENANCE: 'NON_CANONICAL_PROVENANCE',
});

const LIBRARY_REF_FIELDS = Object.freeze([
  'source',
  'resultType',
  'strategyId',
  'libraryRunId',
  'eventType',
  'recordedAt',
]);

const REMOVED_RESULT_FIELDS = Object.freeze([
  'tradeCount',
  'sampleSize',
  'strategyScore',
  'executionScore',
  'confidenceScore',
  'marketClassification',
  'strategyPnlUsd',
  'winRate',
  'profitFactor',
  'expectancyUsd',
  'maxDrawdownUsd',
  'avgWinUsd',
  'avgLossUsd',
  'qualified',
  'band',
  'recoveryFactor',
  'sharpe',
  'sharpeAvailable',
]);

// ── Identitetens version ─────────────────────────────────────────────────────
//
// v1 saknade timeframe. Det var osynligt tills det inte var det: cykel 1 körde
// två hypoteser som deklarerar 5m på 2m av misstag, och eftersom timeframe inte
// ingick i nyckeln fick de FELAKTIGA och de RIKTIGA körningarna samma
// experimentidentitet. Minnet kunde därför inte skilja dem åt — 37 experiment
// spänner över båda passen — och den kontaminationen går inte att reda ut i
// efterhand.
//
// v2 lägger till två fält, och de svarar på olika frågor:
//
//   declaredTimeframe  vad hypotesen SÄGER att den kräver
//   executedTimeframe  vad replay FAKTISKT stegade i
//
// Båda behövs. Med bara den deklarerade hade felet ovan varit lika osynligt —
// det var ju just skillnaden mellan dem som var felet. Den exekverade hämtas
// därför ur körningens konfiguration och aldrig ur hypotesens metadata.
//
// ── Varför versionen HÄRLEDS ur specen ───────────────────────────────────────
//
// En spec som bär executedTimeframe är en v2-identitet; en utan är v1. Det gör
// att äldre anropare — optimeraren bygger sina specar utan timeframe — fortsätter
// fungera oförändrat i stället för att kasta, och att den som VILL ha v2 får det
// genom att lämna uppgiften. Skrivvägen (Strategy Library-recordern) lämnar den
// alltid, så nya experiment blir v2.
//
// ── Varför v2 aldrig faller tillbaka på v1 ───────────────────────────────────
//
// En v1-post kan inte svara på en fråga om timeframe — den vet inte vilken den
// kördes i. Att låta en v2-uppslagning träffa en v1-post hade därför blandat 2m
// och 5m igen, vilket är hela anledningen till att v2 finns. Följden är att
// cykel 1 och 2:s kunskap inte uppfyller ett v2-dubblettskydd. Det är rätt: den
// kunskapen ÄR tvetydig i den dimensionen.
const IDENTITY_VERSIONS = Object.freeze({
  V1: 'ai-memory-v1',
  V2: 'ai-memory-v2',
});

// Fälten som IDENTIFIERAR ett experiment. Ordningen är fast och listan är den
// enda sanningen om vad som gör två experiment till samma experiment.
const IDENTITY_FIELDS = Object.freeze([
  'strategyDnaHash',
  'parameterHash',
  'marketDnaHash',
  'replayMode',
  'executionModel',
  'strategyVersion',
]);

const IDENTITY_FIELDS_V2 = Object.freeze([
  ...IDENTITY_FIELDS,
  'declaredTimeframe',
  'executedTimeframe',
]);

const IDENTITY_FIELDS_BY_VERSION = Object.freeze({
  [IDENTITY_VERSIONS.V1]: IDENTITY_FIELDS,
  [IDENTITY_VERSIONS.V2]: IDENTITY_FIELDS_V2,
});

// En strategi som inte deklarerar någon timeframe har inte "okänd" timeframe —
// den har ingen. Skillnaden måste stå i nyckeln, annars kan ett saknat värde
// och ett medvetet frånvarande värde bli samma experiment.
const NO_DECLARED_TIMEFRAME = 'none';

/** v2 om specen bär den exekverade timeframen, annars v1. */
function identityVersionFor(spec = {}) {
  return text(spec.executedTimeframe) ? IDENTITY_VERSIONS.V2 : IDENTITY_VERSIONS.V1;
}

// Fält som lagras men INTE identifierar. Att period ligger här är hela poängen.
//
// requestedBy hör också hit och inte i identiteten: en manuell körning och en
// från evolutionen på samma DNA i samma marknad ÄR samma experiment. Låg
// beställaren i nyckeln skulle varje beställartyp få köra om allt en gång var,
// och minnet vore verkningslöst just när det behövs som mest.
const PROVENANCE_FIELDS = Object.freeze([
  'period',
  'symbols',
  'runId',
  'requestedBy',
  'regimeKeys',
]);

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * Nyckeln för ett experiment.
 *
 * Kastar hellre än gissar: ett experiment utan Market DNA går inte att
 * återanvända, och att tyst hasha ett `null` hade gjort alla sådana experiment
 * till samma experiment.
 */
function experimentKey(spec = {}, { version = null } = {}) {
  const identityVersion = version || identityVersionFor(spec);
  const fields = IDENTITY_FIELDS_BY_VERSION[identityVersion];
  if (!fields) throw new Error(`ai_memory_unknown_identity_version:${identityVersion}`);
  const missing = fields.filter((field) => !text(spec[field]));
  if (missing.length) {
    throw new Error(`ai_memory_incomplete_experiment_key:${missing.join(',')}`);
  }
  const identity = fields.map((field) => `${field}=${text(spec[field])}`).join('|');
  // Versionssträngen ÄR prefixet. v1-nycklar räknas därför ordagrant som förut
  // — samma fält, samma ordning, samma prefix — och cykel 1 och 2:s nycklar
  // står stilla oavsett vad som läggs till här efteråt.
  return sha(`${identityVersion}::${identity}`);
}

/** Exekveringsmodellen som ett stabilt namn: motor plus dess inställningar. */
function executionModelOf(fillEngineDescription = {}) {
  const engine = text(fillEngineDescription.engine) || 'unknown';
  const config = fillEngineDescription.config || {};
  const canonicalConfig = Object.keys(config).sort()
    .map((key) => `${key}=${config[key]}`)
    .join(',');
  return canonicalConfig ? `${engine}:${sha(canonicalConfig)}` : engine;
}

function normalizeLibraryRef(ref = null, spec = {}) {
  const raw = ref && typeof ref === 'object' ? ref : {};
  const libraryRunId = text(raw.libraryRunId || raw.runId || spec.libraryRunId || spec.runId);
  if (!libraryRunId) return null;
  const out = {
    source: text(raw.source) || 'strategy_library',
    resultType: text(raw.resultType) || 'replay',
    strategyId: text(raw.strategyId || spec.strategyId),
    libraryRunId,
    eventType: text(raw.eventType) || 'REPLAY_RECORDED',
    recordedAt: text(raw.recordedAt),
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value != null));
}

function libraryRefFromEvent(event = {}) {
  return normalizeLibraryRef(event.libraryRef, event)
    || normalizeLibraryRef({
      source: 'strategy_library',
      resultType: 'replay',
      strategyId: event.strategyId,
      libraryRunId: event.libraryRunId || event.runId,
      eventType: 'REPLAY_RECORDED',
      recordedAt: event.recordedAt,
    }, event);
}

function withoutResultFields(row = {}) {
  const clean = { ...row };
  delete clean.result;
  for (const field of REMOVED_RESULT_FIELDS) delete clean[field];
  if (clean.libraryRef && typeof clean.libraryRef === 'object') {
    clean.libraryRef = Object.fromEntries(Object.entries(clean.libraryRef)
      .filter(([field]) => LIBRARY_REF_FIELDS.includes(field)));
  }
  return clean;
}

function blankRecord(key) {
  return {
    experimentKey: key,
    identity: null,
    provenance: [],
    libraryRef: null,
    lineage: null,
    recordedAt: null,
    firstSeenAt: null,
    observations: 0,
    superseded: false,
    supersededBy: null,
    excluded: false,
    exclusion: null,
    identityVersion: null,
  };
}

/**
 * Får experimentet räknas som kunskap systemet redan äger?
 *
 * Det här är den enda definitionen, och både dubblettskyddet och de lärande
 * konsumenterna läser den. Ett uteslutet experiment får aldrig hindra en
 * legitim körning — det var hela poängen med att kunna utesluta.
 */
function validForLearning(record) {
  return Boolean(record && record.libraryRef && !record.excluded && !record.superseded);
}

function applyEvent(record, event) {
  const next = { ...record };
  next.observations += 1;
  next.recordedAt = event.recordedAt;
  if (!next.firstSeenAt) next.firstSeenAt = event.recordedAt;

  if (event.type === EVENT_TYPES.EXPERIMENT_RECORDED) {
    next.identity = event.identity || next.identity;
    // Poster skrivna före versioneringen bär inget fält. De ÄR v1 — det är
    // exakt vad frånvaron betyder — och att härleda det här är bättre än att
    // skriva om historiken för att göra den självbeskrivande.
    next.identityVersion = text(event.identityVersion) || next.identityVersion || IDENTITY_VERSIONS.V1;
    next.lineage = event.lineage || next.lineage;
    // Referensen från FÖRSTA observationen behålls. Resultatet ägs av Strategy
    // Library; Memory pekar bara på var svaret finns. En andra inspelning är en
    // upprepning, inte en revidering.
    if (!next.libraryRef) next.libraryRef = libraryRefFromEvent(event);
    next.provenance = [...next.provenance, {
      at: event.at,
      recordedAt: event.recordedAt,
      ...Object.fromEntries(PROVENANCE_FIELDS.map((field) => [field, event[field] ?? null])),
    }];
  }

  if (event.type === EVENT_TYPES.EXPERIMENT_SUPERSEDED) {
    next.superseded = true;
    next.supersededBy = text(event.supersededBy);
  }

  if (event.type === EVENT_TYPES.EXPERIMENT_EXCLUDED) {
    next.excluded = true;
    next.exclusion = {
      reason: text(event.reason),
      detail: text(event.detail),
      evidence: event.evidence ?? null,
      at: event.recordedAt,
    };
  }
  return next;
}

function createAiMemory(options = {}) {
  const log = createEventLog({
    file: options.eventsFile || DEFAULT_EVENTS_FILE,
    keyField: 'experimentKey',
    eventTypes: Object.values(EVENT_TYPES),
    now: options.now,
    label: 'ai_memory',
  });

  function project() {
    return log.project(blankRecord, applyEvent);
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.validForLearning] endast experiment som gäller
   *        som produktionskunskap. Utan flaggan returneras HELA sanningen,
   *        uteslutna inräknade — en revision ska kunna se allt som skrivits.
   */
  function listExperiments({ validForLearning: onlyValid = false } = {}) {
    const rows = [...project().values()];
    return onlyValid ? rows.filter(validForLearning) : rows;
  }

  /** @returns {object|null} posten, eller null om experimentet är okänt */
  function findExperiment(spec) {
    const key = typeof spec === 'string' ? spec : experimentKey(spec);
    return project().get(key) || null;
  }

  function hasExperiment(spec) {
    return findExperiment(spec) != null;
  }

  /**
   * Den enda vägen AI får ta innan ett experiment körs.
   *
   * @returns {{cached: true, experimentKey, libraryRef, ...}} redan känt
   *          {{cached: false, experimentKey, spec}}           måste köras
   */
  function lookupOrPlan(spec = {}) {
    const identityVersion = identityVersionFor(spec);
    const key = experimentKey(spec, { version: identityVersion });
    const existing = project().get(key);
    // validForLearning, inte bara libraryRef: ett uteslutet eller ersatt
    // experiment är inte ett svar systemet får återanvända, och att låta det
    // svara "cached" hade permanent låst ute den riktiga körningen.
    if (validForLearning(existing)) {
      return {
        cached: true,
        experimentKey: key,
        libraryRef: existing.libraryRef,
        lineage: existing.lineage,
        // Var det setts förut. Gör det synligt att svaret kommer från en annan
        // period med samma marknadsprofil.
        seenIn: existing.provenance.map((row) => row.period).filter(Boolean),
        observations: existing.observations,
        firstSeenAt: existing.firstSeenAt,
        identityVersion,
        ...SAFETY,
      };
    }
    return {
      cached: false,
      experimentKey: key,
      identityVersion,
      spec,
      // Synligt att posten finns men inte gäller. Utan detta hade en
      // reconciliation sett ut som om minnet tappat experimentet.
      excluded: existing?.excluded === true,
      exclusion: existing?.exclusion || null,
      ...SAFETY,
    };
  }

  /**
   * Skriver ett experiment.
   *
   * Idempotent i den meningen att en upprepning inte ändrar referensen — den
   * lägger till en observation. Resultatet skrivs aldrig hit; Strategy Library
   * är enda persistenta resultatsanning.
   */
  function recordExperiment(spec = {}, libraryRef = null, { lineage = null, at = null } = {}) {
    const key = experimentKey(spec);
    const ref = normalizeLibraryRef(libraryRef, spec);
    if (!ref) throw new Error('ai_memory_requires_library_ref');
    // Var experimentet redan känt? Anroparen ska kunna se att den körde något
    // den hade kunnat slå upp — det är den enda vägen till att upptäcka att
    // någon inte frågar minnet först.
    const alreadyKnown = validForLearning(project().get(key));
    const identityVersion = identityVersionFor(spec);
    const fields = IDENTITY_FIELDS_BY_VERSION[identityVersion];
    const identity = Object.fromEntries(fields.map((field) => [field, text(spec[field])]));
    const provenance = Object.fromEntries(PROVENANCE_FIELDS.map((field) => [field, spec[field] ?? null]));
    const event = log.append(key, EVENT_TYPES.EXPERIMENT_RECORDED, {
      identity, identityVersion, libraryRef: ref, lineage, ...provenance, at,
    });
    return { ok: true, experimentKey: key, alreadyKnown, identityVersion, event, ...SAFETY };
  }

  function supersede(key, supersededBy, { reason = null, at = null } = {}) {
    return log.append(key, EVENT_TYPES.EXPERIMENT_SUPERSEDED, { supersededBy, reason, at });
  }

  /**
   * Utesluter ett experiment ur produktionskunskapen utan att radera något.
   *
   * @param {string} key      experimentKey
   * @param {string} reason   ett värde ur EXCLUSION_REASONS
   * @param {object} [options] detail = fritext, evidence = maskinläsbart underlag
   */
  function exclude(key, reason, { detail = null, evidence = null, at = null } = {}) {
    const experiment = text(key);
    if (!experiment) throw new Error('ai_memory_exclude_requires_key');
    if (!Object.values(EXCLUSION_REASONS).includes(reason)) {
      throw new Error(`ai_memory_unknown_exclusion_reason:${reason}`);
    }
    if (!project().get(experiment)) {
      // Att utesluta något som aldrig skrivits vore att skapa en post ur en
      // annullering. Loggen ska bara kunna berätta om det som faktiskt hänt.
      throw new Error(`ai_memory_unknown_experiment:${experiment}`);
    }
    return log.append(experiment, EVENT_TYPES.EXPERIMENT_EXCLUDED, { reason, detail, evidence, at });
  }

  function getHistory(key) {
    return log.historyFor(key).map(withoutResultFields);
  }

  function getAuditTrail(query = {}) {
    return log.auditTrail(query).map(withoutResultFields);
  }

  /** Alla experiment för ett givet genom, oavsett marknad. */
  function experimentsForDna(strategyDnaHash, { includeExcluded = false } = {}) {
    const hash = text(strategyDnaHash);
    return listExperiments({ validForLearning: !includeExcluded })
      .filter((row) => row.identity?.strategyDnaHash === hash);
  }

  /** Alla experiment i en given marknadsprofil, oavsett strategi. */
  function experimentsForMarket(marketDnaHash, { includeExcluded = false } = {}) {
    const hash = text(marketDnaHash);
    return listExperiments({ validForLearning: !includeExcluded })
      .filter((row) => row.identity?.marketDnaHash === hash);
  }

  function getStatus() {
    const rows = listExperiments();
    return {
      ok: true,
      memoryVersion: MEMORY_VERSION,
      experiments: rows.length,
      observations: rows.reduce((total, row) => total + row.observations, 0),
      // Skillnaden mellan de två talen är hur många körningar som var
      // upprepningar. Ett växande gap betyder att någon inte frågar minnet.
      repeats: rows.reduce((total, row) => total + Math.max(0, row.observations - 1), 0),
      distinctDna: new Set(rows.map((row) => row.identity?.strategyDnaHash).filter(Boolean)).size,
      distinctMarkets: new Set(rows.map((row) => row.identity?.marketDnaHash).filter(Boolean)).size,
      superseded: rows.filter((row) => row.superseded).length,
      excluded: rows.filter((row) => row.excluded).length,
      // Fördelningen per identitetsversion. Gör en tyst tillbakagång till v1
      // synlig: skulle skrivvägen sluta lämna executedTimeframe syns det som
      // att v1-talet börjar växa igen.
      byIdentityVersion: rows.reduce((out, row) => {
        const key = row.identityVersion || IDENTITY_VERSIONS.V1;
        out[key] = (out[key] || 0) + 1;
        return out;
      }, {}),
      validForLearning: rows.filter(validForLearning).length,
      log: log.stats(),
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    MEMORY_VERSION,
    EVENT_TYPES,
    IDENTITY_VERSIONS,
    IDENTITY_FIELDS,
    IDENTITY_FIELDS_V2,
    NO_DECLARED_TIMEFRAME,
    identityVersionFor,
    LIBRARY_REF_FIELDS,
    REMOVED_RESULT_FIELDS,
    eventsFile: log.file,
    experimentKey,
    executionModelOf,
    normalizeLibraryRef,
    lookupOrPlan,
    findExperiment,
    hasExperiment,
    recordExperiment,
    supersede,
    exclude,
    validForLearning,
    listExperiments,
    experimentsForDna,
    experimentsForMarket,
    getHistory,
    getAuditTrail,
    getStatus,
    EXCLUSION_REASONS,
    _internal: { log, project, applyEvent, blankRecord, libraryRefFromEvent, withoutResultFields },
  };
}

module.exports = {
  SAFETY,
  MEMORY_VERSION,
  EVENT_TYPES,
  EXCLUSION_REASONS,
  IDENTITY_VERSIONS,
  IDENTITY_FIELDS_V2,
  IDENTITY_FIELDS_BY_VERSION,
  NO_DECLARED_TIMEFRAME,
  identityVersionFor,
  IDENTITY_FIELDS,
  PROVENANCE_FIELDS,
  LIBRARY_REF_FIELDS,
  REMOVED_RESULT_FIELDS,
  DEFAULT_EVENTS_FILE,
  experimentKey,
  executionModelOf,
  normalizeLibraryRef,
  createAiMemory,
  defaultAiMemory: createAiMemory(),
};
