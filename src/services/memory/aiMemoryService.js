'use strict';

// ── AI Memory ────────────────────────────────────────────────────────────────
//
// Minnet av vad som redan är prövat. AI ska aldrig optimera blint — den ska
// fråga minnet först, och minnet ska kunna svara "det där har vi kört, så här
// gick det" utan att en enda replay startas.
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
//   Hur gick det?               resultatet i posten
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
const DEFAULT_EVENTS_FILE = path.resolve(__dirname, '../../../data/ai-memory/experiments.jsonl');

const EVENT_TYPES = Object.freeze({
  EXPERIMENT_RECORDED: 'EXPERIMENT_RECORDED',
  EXPERIMENT_SUPERSEDED: 'EXPERIMENT_SUPERSEDED',
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

// Fält som lagras men INTE identifierar. Att period ligger här är hela poängen.
const PROVENANCE_FIELDS = Object.freeze([
  'period',
  'symbols',
  'runId',
  'regimeKeys',
  'marketClassification',
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
function experimentKey(spec = {}) {
  const missing = IDENTITY_FIELDS.filter((field) => !text(spec[field]));
  if (missing.length) {
    throw new Error(`ai_memory_incomplete_experiment_key:${missing.join(',')}`);
  }
  const identity = IDENTITY_FIELDS.map((field) => `${field}=${text(spec[field])}`).join('|');
  return sha(`${MEMORY_VERSION}::${identity}`);
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

function blankRecord(key) {
  return {
    experimentKey: key,
    identity: null,
    provenance: [],
    result: null,
    lineage: null,
    recordedAt: null,
    firstSeenAt: null,
    observations: 0,
    superseded: false,
    supersededBy: null,
  };
}

function applyEvent(record, event) {
  const next = { ...record };
  next.observations += 1;
  next.recordedAt = event.recordedAt;
  if (!next.firstSeenAt) next.firstSeenAt = event.recordedAt;

  if (event.type === EVENT_TYPES.EXPERIMENT_RECORDED) {
    next.identity = event.identity || next.identity;
    next.lineage = event.lineage || next.lineage;
    // Resultatet från FÖRSTA observationen behålls. Ett experiment är
    // deterministiskt — samma DNA, samma marknadsprofil, samma modell ger
    // samma svar — så en andra inspelning är en upprepning, inte en revidering.
    // Att låta den skriva över hade dolt att någon körde om i onödan.
    if (!next.result) next.result = event.result || null;
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

  function listExperiments() {
    return [...project().values()];
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
   * @returns {{cached: true, experimentKey, result, ...}}   redan känt
   *          {{cached: false, experimentKey, spec}}         måste köras
   */
  function lookupOrPlan(spec = {}) {
    const key = experimentKey(spec);
    const existing = project().get(key);
    if (existing && existing.result) {
      return {
        cached: true,
        experimentKey: key,
        result: existing.result,
        lineage: existing.lineage,
        // Var det setts förut. Gör det synligt att svaret kommer från en annan
        // period med samma marknadsprofil.
        seenIn: existing.provenance.map((row) => row.period).filter(Boolean),
        observations: existing.observations,
        firstSeenAt: existing.firstSeenAt,
        ...SAFETY,
      };
    }
    return { cached: false, experimentKey: key, spec, ...SAFETY };
  }

  /**
   * Skriver ett experiment.
   *
   * Idempotent i den meningen att en upprepning inte ändrar resultatet — den
   * lägger till en observation. Loggen visar då att samma experiment kördes två
   * gånger, vilket är information och inte något som ska döljas.
   */
  function recordExperiment(spec = {}, result = null, { lineage = null, at = null } = {}) {
    const key = experimentKey(spec);
    const identity = Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, text(spec[field])]));
    const provenance = Object.fromEntries(PROVENANCE_FIELDS.map((field) => [field, spec[field] ?? null]));
    const event = log.append(key, EVENT_TYPES.EXPERIMENT_RECORDED, {
      identity, result, lineage, ...provenance, at,
    });
    return { ok: true, experimentKey: key, event, ...SAFETY };
  }

  function supersede(key, supersededBy, { reason = null, at = null } = {}) {
    return log.append(key, EVENT_TYPES.EXPERIMENT_SUPERSEDED, { supersededBy, reason, at });
  }

  function getHistory(key) {
    return log.historyFor(key);
  }

  function getAuditTrail(query = {}) {
    return log.auditTrail(query);
  }

  /** Alla experiment för ett givet genom, oavsett marknad. */
  function experimentsForDna(strategyDnaHash) {
    const hash = text(strategyDnaHash);
    return listExperiments().filter((row) => row.identity?.strategyDnaHash === hash);
  }

  /** Alla experiment i en given marknadsprofil, oavsett strategi. */
  function experimentsForMarket(marketDnaHash) {
    const hash = text(marketDnaHash);
    return listExperiments().filter((row) => row.identity?.marketDnaHash === hash);
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
      log: log.stats(),
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    MEMORY_VERSION,
    EVENT_TYPES,
    IDENTITY_FIELDS,
    eventsFile: log.file,
    experimentKey,
    executionModelOf,
    lookupOrPlan,
    findExperiment,
    hasExperiment,
    recordExperiment,
    supersede,
    listExperiments,
    experimentsForDna,
    experimentsForMarket,
    getHistory,
    getAuditTrail,
    getStatus,
    _internal: { log, project, applyEvent, blankRecord },
  };
}

module.exports = {
  SAFETY,
  MEMORY_VERSION,
  EVENT_TYPES,
  IDENTITY_FIELDS,
  PROVENANCE_FIELDS,
  DEFAULT_EVENTS_FILE,
  experimentKey,
  executionModelOf,
  createAiMemory,
  defaultAiMemory: createAiMemory(),
};
