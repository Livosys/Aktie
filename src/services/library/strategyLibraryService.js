'use strict';

// ── Strategy Library ─────────────────────────────────────────────────────────
//
// Den permanenta posten för varje strategi. Replay skriver hit. Paper skriver
// hit. Live skriver hit. Ingen annan lagring finns.
//
// ── Varför en händelselogg och inte en tabell ────────────────────────────────
//
// Kravet är att historik ALDRIG får skrivas över. En tabell med aktuellt
// tillstånd bryter mot det per konstruktion: varje uppdatering raderar det som
// stod där innan. Biblioteket lagrar därför bara händelser, i den ordning de
// inträffade, och det aktuella tillståndet räknas fram genom att vika ihop dem.
// Det som en gång skrivits kan inte ändras — bara följas av en ny händelse.
//
// Det ger revisionsspåret gratis: hela kravlistan (replay, paper, promotion,
// retirement, approval, DNA, scores) är samma logg läst med olika filter.
//
// ── Varför inte auditTrailService ────────────────────────────────────────────
//
// Den finns och används på andra ställen, men den gallrar: MAX_EVENTS 5000 och
// fjorton dygns retention. För ett revisionsspår som ska följa en strategi från
// den dag den skapades till den dag den pensioneras är gallring detsamma som
// att skriva över historik. Loggen här gallras aldrig.
//
// ── Varför Library inte är ännu en strategilista ─────────────────────────────
//
// Biblioteket UPPFINNER inga strategier. Det seedas ur Strategy Registry, som
// är och förblir den enda listan över vilken kod som finns. Registret svarar på
// "vilka strategier existerar", biblioteket på "hur har det gått för dem". En
// nyregistrerad strategi får sin post automatiskt vid nästa synk.
//
// Skrivning är append-only till JSONL. Läsning är en ren fold.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const lifecycle = require('./strategyLifecycle');
const nativeRegistry = require('../nativeFuturesStrategyRegistryService');
const strategyDna = require('../dna/strategyDnaService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'strategy_library',
});

const DEFAULT_EVENTS_FILE = path.resolve(__dirname, '../../../data/strategy-library/events.jsonl');
const LIBRARY_VERSION = 'strategy-library-v1';

const EVENT_TYPES = Object.freeze({
  REGISTERED: 'STRATEGY_REGISTERED',
  LIFECYCLE_TRANSITION: 'LIFECYCLE_TRANSITION',
  REPLAY_RECORDED: 'REPLAY_RECORDED',
  PAPER_RECORDED: 'PAPER_RECORDED',
  LIVE_RECORDED: 'LIVE_RECORDED',
  SCORE_UPDATED: 'SCORE_UPDATED',
  DNA_UPDATED: 'DNA_UPDATED',
  MARKET_DNA_UPDATED: 'MARKET_DNA_UPDATED',
  APPROVAL_RECORDED: 'APPROVAL_RECORDED',
  RETIRED: 'RETIRED',
  VERSION_CHANGED: 'VERSION_CHANGED',
});

const SCORE_TYPES = Object.freeze({
  STRATEGY: 'strategyScore',
  EXECUTION: 'executionScore',
  CONFIDENCE: 'confidenceScore',
  PRODUCTION: 'productionScore',
});

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

// Strategins DNA beräknas INTE här — lika lite som marknadens.
//
// Biblioteket räknade tidigare en egen hash ur registerbeskrivningen plus
// källfilen. Det var rätt så länge ingen DNA-modul fanns. När strategyDnaService
// kom fanns det plötsligt TVÅ hashar för samma sak, och två svar på "har
// strategin ändrats" är i praktiken noll svar: förr eller senare pekar de åt
// olika håll och ingen vet vilken som gäller.
//
// Biblioteket tar emot hashen och lagrar den. Vad ett strategi-DNA ÄR avgörs på
// ett enda ställe.

// Marknads-DNA beräknas INTE här. Biblioteket lagrar vad det får; vad ett
// marknads-DNA är avgörs av marketDnaService.
//
// Tidigare hashade den här modulen klassificeringsetiketterna ("range",
// "trend_up") och kallade resultatet market DNA. Det var för trubbigt för att
// bära namnet — två helt olika sidledes-dagar fick samma hash — och det lade
// dessutom en marknadsmodell i en bokföringsmodul.

// ── tom post ─────────────────────────────────────────────────────────────────

function blankRecord(strategyId) {
  return {
    strategyId,
    executionStrategyId: null,
    originStrategyId: null,
    nativeStrategyId: null,
    currentVersion: null,
    lifecycle: lifecycle.STAGES.DRAFT,
    created: null,
    lastUpdated: null,
    owner: null,
    currentDnaHash: null,
    currentMarketDnaHash: null,
    replayHistory: [],
    paperHistory: [],
    liveHistory: [],
    promotionHistory: [],
    retirementHistory: [],
    executionScore: null,
    strategyScore: null,
    confidenceScore: null,
    productionScore: null,
    approvals: [],
    // Härlett, för läsbarhet — aldrig lagrat som egen sanning.
    retired: false,
    eventCount: 0,
  };
}

// ── fold ─────────────────────────────────────────────────────────────────────
//
// Varje händelse LÄGGER TILL. Ingen gren här tar bort eller ersätter ett
// historikfält; scores och hashar pekar ut det senast kända värdet medan
// vägen dit ligger kvar i loggen.

function applyEvent(record, event) {
  const next = { ...record };
  const at = event.at;
  next.eventCount += 1;
  // lastUpdated är när posten senast ÄNDRADES, alltså skrivtiden. Att använda
  // `at` här hade fått en inläsning av gammal historik att se ut som om posten
  // gick bakåt i tiden.
  next.lastUpdated = event.recordedAt || at;
  if (!next.created) next.created = at;

  switch (event.type) {
    case EVENT_TYPES.REGISTERED:
      next.executionStrategyId = text(event.executionStrategyId) ?? next.executionStrategyId;
      next.originStrategyId = text(event.originStrategyId) ?? next.originStrategyId;
      next.nativeStrategyId = text(event.nativeStrategyId) ?? next.nativeStrategyId;
      next.currentVersion = text(event.version) ?? next.currentVersion;
      next.owner = text(event.owner) ?? next.owner;
      next.created = text(event.created) || next.created || at;
      break;

    case EVENT_TYPES.VERSION_CHANGED:
      next.currentVersion = text(event.version) ?? next.currentVersion;
      break;

    case EVENT_TYPES.LIFECYCLE_TRANSITION:
      next.lifecycle = event.to;
      next.promotionHistory = [...next.promotionHistory, {
        at,
        from: event.from,
        to: event.to,
        direction: event.direction,
        reason: text(event.reason),
        actor: text(event.actor),
        evidence: event.evidence || null,
      }];
      break;

    case EVENT_TYPES.RETIRED:
      next.lifecycle = lifecycle.STAGES.RETIRED;
      next.retired = true;
      next.retirementHistory = [...next.retirementHistory, {
        at,
        reason: text(event.reason),
        fromStage: event.from,
        lastStrategyScore: num(event.lastStrategyScore),
        lastExecutionScore: num(event.lastExecutionScore),
        lastConfidenceScore: num(event.lastConfidenceScore),
        lastProductionScore: num(event.lastProductionScore),
        lastMarketDnaHash: text(event.lastMarketDnaHash),
        lastDnaHash: text(event.lastDnaHash),
        actor: text(event.actor),
      }];
      break;

    case EVENT_TYPES.REPLAY_RECORDED:
      next.replayHistory = [...next.replayHistory, {
        at,
        runId: text(event.runId),
        mode: text(event.mode),
        from: text(event.from),
        to: text(event.to),
        trades: num(event.trades),
        winRate: num(event.winRate),
        strategyPnlUsd: num(event.strategyPnlUsd),
        strategyScore: num(event.strategyScore),
        executionScore: num(event.executionScore),
        marketClassification: text(event.marketClassification),
        // Market DNA för perioden körningen gjordes i. Den grova regimnyckeln
        // är den som räknas när man frågar "hur många regimer"; det fina
        // avtrycket är det som matchar mot liknande perioder.
        // Entydig regim, eller null när körningen spände över flera.
        marketRegimeKey: text(event.marketRegimeKey),
        // Hela mängden regimer körningen täckte. Det är den som räknas när man
        // frågar vad strategin HAR sett.
        marketRegimeKeys: Array.isArray(event.marketRegimeKeys)
          ? event.marketRegimeKeys.map(text).filter(Boolean)
          : (text(event.marketRegimeKey) ? [text(event.marketRegimeKey)] : []),
        marketDnaHash: text(event.marketDnaHash),
        qualified: event.qualified === true,
      }];
      break;

    case EVENT_TYPES.PAPER_RECORDED:
      next.paperHistory = [...next.paperHistory, {
        at,
        tradeId: text(event.tradeId),
        openedAt: text(event.openedAt),
        closedAt: text(event.closedAt),
        symbol: text(event.symbol),
        direction: text(event.direction),
        realizedPnlUsd: num(event.realizedPnlUsd),
        exitReason: text(event.exitReason),
      }];
      break;

    case EVENT_TYPES.LIVE_RECORDED:
      next.liveHistory = [...next.liveHistory, {
        at,
        tradeId: text(event.tradeId),
        openedAt: text(event.openedAt),
        closedAt: text(event.closedAt),
        symbol: text(event.symbol),
        direction: text(event.direction),
        realizedPnlUsd: num(event.realizedPnlUsd),
        exitReason: text(event.exitReason),
      }];
      break;

    case EVENT_TYPES.SCORE_UPDATED:
      if (Object.values(SCORE_TYPES).includes(event.scoreType)) {
        next[event.scoreType] = num(event.value);
      }
      break;

    case EVENT_TYPES.DNA_UPDATED:
      next.currentDnaHash = text(event.dnaHash);
      break;

    case EVENT_TYPES.MARKET_DNA_UPDATED:
      next.currentMarketDnaHash = text(event.marketDnaHash);
      break;

    case EVENT_TYPES.APPROVAL_RECORDED:
      next.approvals = [...next.approvals, {
        at,
        decision: text(event.decision),
        approvedBy: text(event.approvedBy),
        stage: text(event.stage),
        note: text(event.note),
      }];
      break;

    default:
      // Okänd händelsetyp räknas men ändrar inget. Att kasta här hade gjort en
      // framtida händelsetyp till ett läsfel för hela biblioteket.
      break;
  }
  return next;
}

function createStrategyLibrary(options = {}) {
  const eventsFile = options.eventsFile || DEFAULT_EVENTS_FILE;
  const registry = options.registry || nativeRegistry;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  // DNA-beräkningen injiceras. Standard är den enda riktiga: strategyDnaService.
  const dnaHashFor = typeof options.dnaHashFor === 'function'
    ? options.dnaHashFor
    : (descriptor) => strategyDna.deriveStrategyDna(descriptor)?.dnaHash || null;

  function ensureDir() {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  }

  function readEvents() {
    try {
      if (!fs.existsSync(eventsFile)) return [];
      return fs.readFileSync(eventsFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
        .filter((row) => row && row.strategyId && row.type);
    } catch (_) {
      return [];
    }
  }

  /**
   * Skriver en händelse. Enda skrivvägen som finns.
   *
   * Ingen befintlig rad ändras någonsin — filen öppnas i append-läge.
   */
  function append(strategyId, type, payload = {}) {
    const id = text(strategyId);
    if (!id) throw new Error('strategy_library_requires_strategy_id');
    if (!Object.values(EVENT_TYPES).includes(type)) {
      throw new Error(`strategy_library_unknown_event_type:${type}`);
    }
    // ── två tider, och de är inte samma sak ────────────────────────────────
    //
    // `at`          när det som händelsen beskriver INTRÄFFADE. En paper-affär
    //               som stängdes i juli bär juli, även om den läses in i
    //               augusti.
    // `recordedAt`  när biblioteket FICK VETA det. Sätts alltid av klockan här
    //               och kan aldrig skrivas över av den som anropar.
    //
    // Skillnaden upptäcktes när revisionsspåret visade sig vara osorterat: en
    // inläsning av gammal historik la juli-händelser efter augusti-händelser i
    // filen. Ett revisionsspår måste kunna svara på båda frågorna, och den
    // ordning som räknas för revisionen är den senare — den är monoton, för
    // filen skrivs bara i slutet.
    //
    // Payloaden spreds tidigare sist och skrev då över den beräknade tiden med
    // sitt eget `at: null`. Identitetsfälten sätts därför efter payloaden.
    const recordedAt = new Date(clock()).toISOString();
    const event = {
      ...payload,
      at: new Date(payload.at || recordedAt).toISOString(),
      recordedAt,
      strategyId: id,
      type,
    };
    ensureDir();
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  function project(events) {
    const byStrategy = new Map();
    for (const event of events) {
      const current = byStrategy.get(event.strategyId) || blankRecord(event.strategyId);
      byStrategy.set(event.strategyId, applyEvent(current, event));
    }
    return byStrategy;
  }

  function listStrategies() {
    return [...project(readEvents()).values()]
      .sort((a, b) => String(a.strategyId).localeCompare(String(b.strategyId)));
  }

  function getStrategy(strategyId) {
    return project(readEvents()).get(text(strategyId)) || null;
  }

  /** Hela loggen för en strategi, kronologiskt. Revisionsspåret. */
  function getHistory(strategyId, { types = null } = {}) {
    const id = text(strategyId);
    return readEvents()
      .filter((event) => event.strategyId === id)
      .filter((event) => !types || types.includes(event.type));
  }

  /**
   * Hela loggen, oavsett strategi.
   *
   * Ordningen är filens, alltså `recordedAt` — den ordning biblioteket fick
   * veta sakerna. Den är monoton eftersom filen bara skrivs i slutet. Sortera
   * på `at` i stället om du vill se när sakerna inträffade; de två ordningarna
   * skiljer sig när gammal historik läses in.
   */
  function getAuditTrail({ since = null, types = null, limit = null } = {}) {
    const sinceMs = since ? Date.parse(since) : null;
    let rows = readEvents();
    if (Number.isFinite(sinceMs)) {
      rows = rows.filter((e) => Date.parse(e.recordedAt || e.at) >= sinceMs);
    }
    if (types) rows = rows.filter((e) => types.includes(e.type));
    return limit ? rows.slice(-Math.abs(limit)) : rows;
  }

  // ── synk från registret ────────────────────────────────────────────────────
  //
  // Biblioteket får sin population härifrån. En strategi som finns i registret
  // men saknar post får en; en post som redan finns lämnas ifred så att dess
  // historik aldrig skrivs om. Idempotent: kör så ofta du vill.
  function syncFromRegistry() {
    const existing = project(readEvents());
    const descriptors = registry.listNativeStrategies();
    const created = [];
    const dnaChanged = [];

    for (const descriptor of descriptors) {
      const record = existing.get(descriptor.strategyId);
      const dnaHash = dnaHashFor(descriptor);

      if (!record) {
        append(descriptor.strategyId, EVENT_TYPES.REGISTERED, {
          executionStrategyId: descriptor.strategyId,
          nativeStrategyId: descriptor.strategyId,
          originStrategyId: descriptor.originStrategyId,
          version: descriptor.strategyVersion,
          owner: 'trading_os',
        });
        append(descriptor.strategyId, EVENT_TYPES.DNA_UPDATED, { dnaHash });
        created.push(descriptor.strategyId);
        continue;
      }

      // Koden har ändrats sedan sist. Ny händelse, aldrig en överskrivning —
      // den gamla hashen ligger kvar i loggen och går att följa.
      if (record.currentDnaHash !== dnaHash) {
        append(descriptor.strategyId, EVENT_TYPES.DNA_UPDATED, {
          dnaHash, previousDnaHash: record.currentDnaHash,
        });
        dnaChanged.push(descriptor.strategyId);
      }
      if (descriptor.strategyVersion && record.currentVersion !== descriptor.strategyVersion) {
        append(descriptor.strategyId, EVENT_TYPES.VERSION_CHANGED, {
          version: descriptor.strategyVersion, previousVersion: record.currentVersion,
        });
      }
    }

    return {
      registryStrategies: descriptors.length,
      created,
      dnaChanged,
      total: project(readEvents()).size,
    };
  }

  // ── skrivningar ───────────────────────────────────────────────────────────

  function recordTransition({ strategyId, to, reason = null, actor = 'system', evidence = null, at = null }) {
    const record = getStrategy(strategyId);
    const from = record?.lifecycle || lifecycle.STAGES.DRAFT;
    const check = lifecycle.validateTransition(from, to);
    if (!check.ok) {
      return { ok: false, from, to, reason: check.reason, expected: check.expected || null };
    }
    if (to === lifecycle.STAGES.RETIRED) {
      return { ok: false, from, to, reason: 'use_retire_for_retirement' };
    }
    const event = append(strategyId, EVENT_TYPES.LIFECYCLE_TRANSITION, {
      from, to, direction: check.direction, reason, actor, evidence, at,
    });
    return { ok: true, from, to, direction: check.direction, event };
  }

  function retire({ strategyId, reason, actor = 'system', at = null }) {
    const record = getStrategy(strategyId);
    if (!record) return { ok: false, reason: 'unknown_strategy' };
    const from = record.lifecycle;
    const check = lifecycle.validateTransition(from, lifecycle.STAGES.RETIRED);
    if (!check.ok) return { ok: false, from, reason: check.reason };

    // Pensioneringen bevarar det sista kända tillståndet i själva händelsen, så
    // att posten går att läsa utan att räkna om något.
    const event = append(strategyId, EVENT_TYPES.RETIRED, {
      from,
      reason: reason || 'unspecified',
      lastStrategyScore: record.strategyScore,
      lastExecutionScore: record.executionScore,
      lastConfidenceScore: record.confidenceScore,
      lastProductionScore: record.productionScore,
      lastDnaHash: record.currentDnaHash,
      lastMarketDnaHash: record.currentMarketDnaHash,
      actor,
      at,
    });
    return { ok: true, from, event };
  }

  function recordScore({ strategyId, scoreType, value, detail = null, at = null }) {
    if (!Object.values(SCORE_TYPES).includes(scoreType)) {
      throw new Error(`strategy_library_unknown_score_type:${scoreType}`);
    }
    const previous = getStrategy(strategyId)?.[scoreType] ?? null;
    return append(strategyId, EVENT_TYPES.SCORE_UPDATED, {
      scoreType, value: num(value), previous, detail, at,
    });
  }

  function recordReplayRun(payload = {}) {
    return append(payload.strategyId, EVENT_TYPES.REPLAY_RECORDED, payload);
  }

  function recordPaperTrade(payload = {}) {
    return append(payload.strategyId, EVENT_TYPES.PAPER_RECORDED, payload);
  }

  function recordLiveTrade(payload = {}) {
    return append(payload.strategyId, EVENT_TYPES.LIVE_RECORDED, payload);
  }

  /**
   * @param {string}   marketDnaHash  sammanslaget avtryck från marketDnaService
   * @param {string[]} [profiles]     de fina profilerna bakom det
   * @param {string[]} [regimeKeys]   de grova regimerna bakom det
   */
  function recordMarketDna({ strategyId, marketDnaHash, profiles = [], regimeKeys = [], at = null }) {
    const hash = text(marketDnaHash);
    if (!hash) return null;
    const previous = getStrategy(strategyId)?.currentMarketDnaHash ?? null;
    // Oförändrat DNA ger ingen händelse. En logg som fylls med identiska rader
    // gör de verkliga förändringarna omöjliga att se.
    if (previous === hash) return null;
    return append(strategyId, EVENT_TYPES.MARKET_DNA_UPDATED, {
      marketDnaHash: hash, previousMarketDnaHash: previous, profiles, regimeKeys, at,
    });
  }

  function recordApproval({ strategyId, decision, approvedBy, stage = null, note = null, at = null }) {
    return append(strategyId, EVENT_TYPES.APPROVAL_RECORDED, {
      decision, approvedBy, stage, note, at,
    });
  }

  function getStatus() {
    const rows = listStrategies();
    const byStage = {};
    for (const row of rows) byStage[row.lifecycle] = (byStage[row.lifecycle] || 0) + 1;
    return {
      ok: true,
      libraryVersion: LIBRARY_VERSION,
      eventsFile,
      strategies: rows.length,
      events: readEvents().length,
      byStage,
      retired: rows.filter((row) => row.retired).length,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    EVENT_TYPES,
    SCORE_TYPES,
    LIBRARY_VERSION,
    eventsFile,
    syncFromRegistry,
    listStrategies,
    getStrategy,
    getHistory,
    getAuditTrail,
    recordTransition,
    retire,
    recordScore,
    recordReplayRun,
    recordPaperTrade,
    recordLiveTrade,
    recordMarketDna,
    recordApproval,
    getStatus,
    _internal: { readEvents, append, project, applyEvent, blankRecord },
  };
}

module.exports = {
  SAFETY,
  DEFAULT_EVENTS_FILE,
  LIBRARY_VERSION,
  EVENT_TYPES,
  SCORE_TYPES,
  createStrategyLibrary,

  defaultStrategyLibrary: createStrategyLibrary(),
};
