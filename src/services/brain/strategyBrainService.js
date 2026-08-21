'use strict';

// ── Strategy Brain ───────────────────────────────────────────────────────────
//
// Fattar beslut. Optimerar ingenting, muterar ingenting, kör ingenting.
//
// ── Skillnaden som gör den användbar ────────────────────────────────────────
//
// "Strategin är dålig" och "det saknas data här" ser likadana ut i en
// resultattabell och kräver rakt motsatta åtgärder. En strategi med 30 i
// Strategy Score efter fyra affärer i en enda marknadsregim är inte dålig —
// den är OKÄND, och att pensionera den vore att kasta bort något man aldrig
// mätt.
//
// Hjärnan skiljer därför alltid på de två, och när underlaget är tunt säger den
// det i stället för att fälla en dom.
//
// ── Prioritet på informationsvärde, inte på träffsäkerhet ───────────────────
//
// Ett replayjobb prioriteras efter hur mycket det LÄR OSS, inte efter hur bra
// resultatet väntas bli. Det är en viktig skillnad: sorterar man på förväntad
// träffsäkerhet kör man om det man redan vet och rör aldrig de hål som gör
// måtten opålitliga.
//
// Och det som redan står i AI Memory har informationsvärde NOLL. Ett jobb vars
// experiment redan finns går inte att lära sig något av, hur lockande resultatet
// än ser ut.
//
// ── Vad hjärnan aldrig gör ──────────────────────────────────────────────────
//
// Den föreslår retire, re-test, optimize, paper och live candidate. Den utför
// aldrig något av det. Rekommendationerna är data; besluten är någon annans.
//
// Deterministisk: ingen klocka utan att den skickas in, ingen slump, sorterade
// utdata. Samma indata ger samma rekommendation.

const lifecycle = require('../library/strategyLifecycle');
const promotionEngine = require('../library/promotionEngineService');
const retirementEngine = require('../library/retirementEngineService');
const confidenceScore = require('../score/confidenceScoreService');
const strategyScoreV1 = require('../score/strategyScoreV1Service');
const strategyDna = require('../dna/strategyDnaService');
const aiMemoryModule = require('../memory/aiMemoryService');
const marketIntelligence = require('../market/marketIntelligenceService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'strategy_brain',
});

const BRAIN_VERSION = 'strategy-brain-v1';

// Vad hjärnan får föreslå. Att listan är sluten är poängen: en rekommendation
// utanför den här mängden är en åtgärd ingen har godkänt att systemet ens
// tänker på.
const RECOMMENDATIONS = Object.freeze({
  RETEST: 're_test',
  OPTIMIZE: 'optimize',
  PAPER: 'paper',
  LIVE_CANDIDATE: 'live_candidate',
  RETIRE: 'retire',
  WAIT: 'wait',
});

const GAP_TYPES = Object.freeze({
  MARKET_DNA: 'missing_market_dna',
  REPLAY_PERIODS: 'missing_replay_periods',
  CONFIDENCE: 'missing_confidence',
  SAMPLE_SIZE: 'missing_sample_size',
  OUT_OF_SAMPLE: 'missing_out_of_sample',
  PAPER: 'missing_paper',
  LIVE: 'missing_live',
});

// Vad varje hål är VÄRT att fylla, i informationspoäng. Ett hål som gör alla
// andra mått opålitliga väger tyngst.
const GAP_WEIGHT = Object.freeze({
  missing_market_dna: 30,
  missing_sample_size: 25,
  missing_confidence: 20,
  missing_replay_periods: 12,
  missing_out_of_sample: 8,
  missing_paper: 4,
  missing_live: 1,
});

const THRESHOLDS = Object.freeze({
  minReplayRuns: 3,
  minOutOfSampleRuns: 2,
  minPaperTrades: 20,
  minLiveTrades: 1,
});

// ── Kunskapsvärde ────────────────────────────────────────────────────────────
//
// Kunskapshålen ovan svarar på "vad har vi inte mätt". Det räcker inte som
// prioritering, och skälet syns i drift: efter registersynken har varje otestad
// strategi exakt samma hål, alltså exakt samma poäng. 21 varianter av åtta
// basstrategier hamnade på 98–100 poäng var, och ordningen mellan dem avgjordes
// av bokstavsordning. Fabriken körde då fyra varianter av samma basstrategi i
// följd innan den rörde nästa familj.
//
// Fyra saker till avgör hur mycket en körning faktiskt LÄR OSS, och alla fyra
// går att räkna ur data som redan finns:
//
//   osäkerhet   Spridningen i Strategy Score mellan körningar. Mätt i lagret:
//               narrow_state_expansion_long har 5 körningar med spridning 0,0 —
//               den är färdigmätt. narrow_breakout_short har 13 körningar med
//               spridning 33,8 — vi vet fortfarande inte vad den är värd.
//               Hålen är stängda för båda; bara den ena är förstådd.
//
//   avtagande   Varje ytterligare körning minskar osäkerheten mindre än den
//               förra. Samma kvadratrotsform som Confidence Score redan
//               använder för urvalsstorlek — den tionde affären lär oss mindre
//               än den andra.
//
//   täckning    Hur stor del av marknadens profiler strategin ännu inte sett.
//               marketIntelligenceService räknar redan ut det per strategi
//               (`untestedProfiles` av `profilesAvailable`) — värdet fanns, men
//               användes bara för att lista blinda fläckar, aldrig för att
//               prioritera. En strategi som sett två av femton profiler har mer
//               kvar att lära än en som sett fjorton, även när hålen är lika.
//
//   nyhet       En familj som redan prövats i tio körningar ger mindre ny
//               kunskap än en som aldrig rörts, även när hålen ser lika stora
//               ut. Familj = strategins ursprung i DNA:t, så alla varianter och
//               muterade genom av samma bas räknas som samma familj.
//
// Vikterna summerar till 1,0 så att skalan förblir 0–100 (Replay Queue klipper
// vid 100). Hålen väger tyngst med flit: modellen förfinar den befintliga
// prioriteringen, den ersätter den inte.
const KNOWLEDGE_WEIGHTS = Object.freeze({
  gap: 0.60,
  uncertainty: 0.15,
  coverage: 0.12,
  novelty: 0.07,
  systemic: 0.06,
});

// En standardavvikelse på 25 poäng i Strategy Score mellan körningar betyder i
// praktiken att vi inte vet vad strategin är värd. Mätta värden i lagret ligger
// mellan 0,0 och 40,6, så skalan träffar det spann som faktiskt förekommer.
const UNCERTAINTY_FULL_SCALE = 25;

// Under två körningar finns ingen spridning att mäta. Att inte veta är inte
// samma sak som att veta att det är osäkert — det första hanteras redan av
// kunskapshålen.
const MIN_RUNS_FOR_UNCERTAINTY = 2;

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function replayTrades(record) {
  return (record.replayHistory || []).reduce((total, row) => total + (Number(row.trades) || 0), 0);
}

function regimeKeysOf(run) {
  const raw = (Array.isArray(run.marketRegimeKeys) && run.marketRegimeKeys.length)
    ? run.marketRegimeKeys
    : [run.marketRegimeKey].filter(Boolean);
  return [...new Set(raw.flatMap((key) => String(key).split('+')).filter(Boolean))];
}

// ── osäkerhet och avtagande avkastning ───────────────────────────────────────

/**
 * Spridningen i Strategy Score mellan strategins replay-körningar.
 *
 * Läser det biblioteket redan bokfört. Ingen ny lagring, ingen ny beräkning av
 * resultaten själva — bara ett andra mått på dem.
 */
function scoreSpread(record) {
  const scores = (record.replayHistory || [])
    .map((row) => Number(row.strategyScore))
    .filter(Number.isFinite);
  if (scores.length < MIN_RUNS_FOR_UNCERTAINTY) {
    return { runs: scores.length, mean: null, stdDev: null };
  }
  const mean = scores.reduce((total, value) => total + value, 0) / scores.length;
  const variance = scores.reduce((total, value) => total + ((value - mean) ** 2), 0) / scores.length;
  return { runs: scores.length, mean: round(mean), stdDev: round(Math.sqrt(variance)) };
}

/**
 * Hur mycket osäkerhet EN körning till kan väntas ta bort, 0–100.
 *
 * Osäkerheten själv gånger den avtagande avkastningen. En strategi med
 * spridning 0 ger noll oavsett antal körningar; en med hög spridning och få
 * körningar ger mest. Det är precis den strategi som är värd att köra igen.
 */
function uncertaintyValue(spread) {
  if (spread.stdDev == null || spread.runs < MIN_RUNS_FOR_UNCERTAINTY) return 0;
  const normalized = Math.min(1, spread.stdDev / UNCERTAINTY_FULL_SCALE);
  const diminishing = 1 / Math.sqrt(spread.runs);
  return round(normalized * diminishing * 100);
}

/**
 * Familjen en strategi tillhör.
 *
 * DNA:ts originStrategyId, som alla varianter och muterade genom av samma bas
 * delar. Utan den räknas `narrow_breakout__fast` och `narrow_breakout__patient`
 * som två oberoende kunskapskällor, vilket de inte är.
 */
function familyOf(strategyId, dna) {
  return dna?.originStrategyId || strategyId;
}

/**
 * DNA för en strategi biblioteket känner men DNA-populationen inte listar.
 *
 * Gäller muterade genom: de finns i släktträdet, inte i registret, och saknades
 * därför i `listStrategyDna()`. Utan uppslaget blev varje genom sin EGEN familj
 * med nyhetsvärde 100 — mätt i en femcykelskörning låste fabriken sig då fast
 * vid samma genom två cykler i rad. Genomet hör till sin förälders familj.
 */
function dnaFor(strategyId, dnaByStrategy, dnaService) {
  const known = dnaByStrategy.get(strategyId);
  if (known) return known;
  try {
    return dnaService.getStrategyDna(strategyId) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Hur outforskad familjen är, 0–100.
 *
 * Avtagande i familjens totala antal körningar: 0 körningar ger 100, 9 ger 10.
 * Det är den term som sprider arbetet över basstrategier i stället för att
 * mala igenom varianterna av en enda.
 */
function noveltyValue(familyRuns) {
  return round(100 / (1 + Math.max(0, Number(familyRuns) || 0)));
}

/**
 * Hur stor del av marknaden strategin ännu inte sett, 0–100.
 *
 * Räknas på REGIMTÄCKNINGEN, inte på profiltäckningen. Skälet är mätt: för en
 * strategi med nio prövade profiler rapporterar marketIntelligence samtidigt
 * `profilesTested: 9`, `profilesAvailable: 15` och `untestedProfiles: 15` —
 * summan går inte ihop, eftersom replay-radernas `marketDnaHash` är en
 * SAMMANSLAGEN hash för hela körningsfönstret medan katalogens profiler är
 * hashar per dygn. De två mängderna kan aldrig överlappa, så profilmåttet är
 * alltid 100 och skiljer ingenting åt.
 *
 * `regimeCoveragePct` jämförs mot samma regimlista den räknas ur och stämmer.
 * Den används därför tills profilhasharna talar samma språk.
 *
 * Saknas raden är svaret 100: en strategi vi inte har någon täckningsuppgift
 * om har per definition allt kvar att se.
 */
function coverageValue(intelligenceRow) {
  const covered = Number(intelligenceRow?.regimeCoveragePct);
  if (!Number.isFinite(covered)) return 100;
  return round(Math.max(0, Math.min(100, 100 - covered)));
}

// ── kunskapshål ──────────────────────────────────────────────────────────────

/**
 * Vad vi INTE vet om en strategi.
 *
 * Varje hål bär sin storlek och sitt värde, så att prioriteringen kan räknas
 * ur dem utan att någon gissar.
 */
function findKnowledgeGaps(record, { availableRegimes = [], intelligenceRow = null } = {}) {
  const gaps = [];
  const trades = replayTrades(record);
  const runs = (record.replayHistory || []).length;
  const seenRegimes = intelligenceRow
    ? intelligenceRow.regimesTested
    : [...new Set((record.replayHistory || []).flatMap(regimeKeysOf))];
  const missingRegimes = availableRegimes.filter((key) => !seenRegimes.includes(key));

  if (missingRegimes.length) {
    gaps.push({
      type: GAP_TYPES.MARKET_DNA,
      detail: { missing: missingRegimes.sort(), tested: seenRegimes.length, available: availableRegimes.length },
      // Hur stor andel av marknaden vi inte sett. Ett hål på fem av sex regimer
      // är fem gånger så mycket värt att fylla som ett på en.
      magnitude: availableRegimes.length ? missingRegimes.length / availableRegimes.length : 1,
    });
  }

  if (trades < strategyScoreV1.MIN_TRADES_FOR_RANKING) {
    gaps.push({
      type: GAP_TYPES.SAMPLE_SIZE,
      detail: { trades, required: strategyScoreV1.MIN_TRADES_FOR_RANKING },
      magnitude: 1 - (trades / strategyScoreV1.MIN_TRADES_FOR_RANKING),
    });
  }

  const confidence = Number(record.confidenceScore);
  if (!Number.isFinite(confidence) || confidence < confidenceScore.CANDIDATE_CONFIDENCE_FLOOR) {
    const current = Number.isFinite(confidence) ? confidence : 0;
    gaps.push({
      type: GAP_TYPES.CONFIDENCE,
      detail: { confidenceScore: Number.isFinite(confidence) ? confidence : null, floor: confidenceScore.CANDIDATE_CONFIDENCE_FLOOR },
      magnitude: 1 - (current / confidenceScore.CANDIDATE_CONFIDENCE_FLOOR),
    });
  }

  if (runs < THRESHOLDS.minReplayRuns) {
    gaps.push({
      type: GAP_TYPES.REPLAY_PERIODS,
      detail: { runs, required: THRESHOLDS.minReplayRuns },
      magnitude: 1 - (runs / THRESHOLDS.minReplayRuns),
    });
  }

  // Out-of-sample: körningar i marknadsprofiler strategin inte redan mätts i.
  // Utan flera distinkta profiler är varje resultat in-sample per definition.
  const distinctProfiles = new Set((record.replayHistory || []).map((row) => row.marketDnaHash).filter(Boolean)).size;
  if (distinctProfiles < THRESHOLDS.minOutOfSampleRuns) {
    gaps.push({
      type: GAP_TYPES.OUT_OF_SAMPLE,
      detail: { distinctMarketProfiles: distinctProfiles, required: THRESHOLDS.minOutOfSampleRuns },
      magnitude: 1 - (distinctProfiles / THRESHOLDS.minOutOfSampleRuns),
    });
  }

  const paperTrades = (record.paperHistory || []).length;
  if (paperTrades < THRESHOLDS.minPaperTrades) {
    gaps.push({
      type: GAP_TYPES.PAPER,
      detail: { paperTrades, required: THRESHOLDS.minPaperTrades },
      magnitude: 1 - (paperTrades / THRESHOLDS.minPaperTrades),
    });
  }

  if ((record.liveHistory || []).length < THRESHOLDS.minLiveTrades) {
    gaps.push({
      type: GAP_TYPES.LIVE,
      detail: { liveTrades: (record.liveHistory || []).length },
      magnitude: 1,
    });
  }

  return gaps.map((gap) => ({
    ...gap,
    magnitude: round(Math.max(0, Math.min(1, gap.magnitude)), 3),
    weight: GAP_WEIGHT[gap.type],
    // Poängen ett hål bidrar med: dess vikt gånger hur stort det är.
    informationValue: round(GAP_WEIGHT[gap.type] * Math.max(0, Math.min(1, gap.magnitude)), 2),
  })).sort((a, b) => b.informationValue - a.informationValue);
}

// ── rekommendation ───────────────────────────────────────────────────────────

/**
 * Vad bör hända med den här strategin?
 *
 * Ordningen är avsiktlig: kunskapshål prövas FÖRE dom. En strategi kan aldrig
 * rekommenderas för pensionering så länge det finns en rimlig förklaring till
 * dess dåliga siffror som heter "vi har inte mätt den".
 */
function recommendFor(record, gaps, { promotion, retirement }) {
  const trades = replayTrades(record);
  const sampleGap = gaps.find((gap) => gap.type === GAP_TYPES.SAMPLE_SIZE);
  const marketGap = gaps.find((gap) => gap.type === GAP_TYPES.MARKET_DNA);
  const confidenceGap = gaps.find((gap) => gap.type === GAP_TYPES.CONFIDENCE);

  if (record.lifecycle === lifecycle.STAGES.RETIRED) {
    return { action: RECOMMENDATIONS.WAIT, reason: 'retired', motivation: 'Strategin är pensionerad.' };
  }

  // 1. Vet vi för lite? Då är det data som saknas, inte kvalitet.
  if (sampleGap || marketGap) {
    return {
      action: RECOMMENDATIONS.RETEST,
      reason: sampleGap ? 'insufficient_sample' : 'untested_market_regimes',
      motivation: sampleGap
        ? `${trades} affärer räcker inte för ett omdöme (${strategyScoreV1.MIN_TRADES_FOR_RANKING} krävs). Kör fler perioder.`
        : `Aldrig prövad i ${marketGap.detail.missing.join(', ')}. Resultatet säger inget om de marknaderna.`,
    };
  }

  // 2. Underlaget håller men vi vet ändå för lite om spridningen.
  if (confidenceGap) {
    return {
      action: RECOMMENDATIONS.RETEST,
      reason: 'low_confidence',
      motivation: `Confidence ${record.confidenceScore ?? 0} under golvet ${confidenceScore.CANDIDATE_CONFIDENCE_FLOOR}. `
        + 'Underlaget finns men är för smalt i tid eller regim.',
    };
  }

  // 3. NU först får ett dåligt resultat betyda något.
  if (retirement.shouldRetire) {
    return {
      action: RECOMMENDATIONS.RETIRE,
      reason: retirement.primaryReason,
      motivation: `Underlaget håller och resultatet är svagt: ${retirement.primaryReason}. `
        + 'Förslag — pensionering beslutas av människa.',
    };
  }

  if (promotion.allowed) {
    const action = promotion.to === lifecycle.STAGES.PAPER ? RECOMMENDATIONS.PAPER
      : promotion.to === lifecycle.STAGES.LIVE ? RECOMMENDATIONS.LIVE_CANDIDATE
        : RECOMMENDATIONS.OPTIMIZE;
    return {
      action,
      reason: `ready_for_${promotion.to}`,
      motivation: `Alla krav för ${promotion.to} är uppfyllda.`,
    };
  }

  // 4. Kvaliteten är mätt och medelmåttig. Då är det parametrarna som ska röras.
  if ((record.strategyScore ?? 0) < 55) {
    return {
      action: RECOMMENDATIONS.OPTIMIZE,
      reason: 'measured_but_weak',
      motivation: `Strategy Score ${record.strategyScore} på ett underlag som håller. `
        + 'Kvaliteten är mätt — nästa steg är parametrarna, inte mer data.',
    };
  }

  return {
    action: RECOMMENDATIONS.WAIT,
    reason: promotion.blockedReason || 'no_action_needed',
    motivation: promotion.blockedReason
      ? `Väntar på: ${promotion.blockedReason}.`
      : 'Inget hål och ingen invändning.',
  };
}

// ── priority engine ──────────────────────────────────────────────────────────

/**
 * Varför just det här jobbet.
 *
 * Den tyngsta signalen namnges, inte alla fyra. En motivering som räknar upp
 * allt förklarar ingenting — designrapportens copy-princip är att varje siffra
 * ska bära ett omdöme, inte tvärtom.
 */
function motivationFor(row, components) {
  const ranked = [
    { key: 'gap', value: components.gap * KNOWLEDGE_WEIGHTS.gap },
    { key: 'uncertainty', value: components.uncertainty * KNOWLEDGE_WEIGHTS.uncertainty },
    { key: 'coverage', value: components.coverage * KNOWLEDGE_WEIGHTS.coverage },
    { key: 'novelty', value: components.novelty * KNOWLEDGE_WEIGHTS.novelty },
    { key: 'systemic', value: components.systemic * KNOWLEDGE_WEIGHTS.systemic },
  ].sort((a, b) => b.value - a.value);

  switch (ranked[0].key) {
    case 'uncertainty':
      return `Resultaten svänger ${row.scoreSpread?.stdDev} poäng mellan ${row.scoreSpread?.runs} körningar — `
        + 'hålen är stängda men vi vet ändå inte vad strategin är värd.';
    case 'coverage':
      return `Har sett ${row.coverage}% av marknadens profiler ännu inte — störst outforskad marknadsyta.`;
    case 'novelty':
      return `Familjen ${row.family} har bara ${row.familyRuns} körningar — minst utforskade familjen just nu.`;
    case 'systemic':
      return 'Ingen strategi har prövats i den här marknadsregimen.';
    default:
      return `Fyller ${row.gaps.length} kunskapshål, tyngst: ${row.gaps[0]?.type || 'inget'}.`;
  }
}

/**
 * Replayjobb sorterade på informationsvärde.
 *
 * Ett jobb vars experiment redan finns i AI Memory får värdet NOLL. Det är hela
 * kopplingen till minnet: hjärnan föreslår aldrig en körning vars svar redan är
 * känt.
 */
function buildReplayPriority({
  strategies,
  availableRegimes,
  memory,
  executionModel,
  replayMode,
  systemUntestedRegimes = [],
}) {
  const jobs = [];
  const systemUntested = new Set(systemUntestedRegimes);

  // ── minnet läses EN gång ───────────────────────────────────────────────────
  //
  // Uppslaget låg tidigare inuti den inre loopen: `memory.listExperiments()`
  // per jobb, och varje anrop läser hela experimentloggen från disk. Med åtta
  // strategier märktes det inte. Med 178 bibliotekstrategier blir det 967
  // filläsningar per analys, och mätt stod de för ~1,8 s av 2,5 s.
  //
  // Samma svar, en läsning. Indexet är (dnaHash, replayMode) → mängden regimer
  // experimentet redan täcker, vilket är exakt den fråga loopen ställer.
  const knownRegimesByDna = new Map();
  if (memory && typeof memory.listExperiments === 'function') {
    // validForLearning: ett uteslutet experiment är inte kunskap fabriken äger.
    // Räknades det med skulle en sandlådekörning kunna få en regim att se
    // täckt ut och därmed stjäla prioritet från riktigt arbete.
    for (const experiment of memory.listExperiments({ validForLearning: true })) {
      const dnaHash = experiment.identity?.strategyDnaHash;
      if (!dnaHash || experiment.identity?.replayMode !== replayMode) continue;
      if (!knownRegimesByDna.has(dnaHash)) knownRegimesByDna.set(dnaHash, new Set());
      const bucket = knownRegimesByDna.get(dnaHash);
      for (const provenance of experiment.provenance || []) {
        for (const key of provenance.regimeKeys || []) bucket.add(key);
      }
    }
  }

  for (const row of strategies) {
    const missing = row.gaps.find((gap) => gap.type === GAP_TYPES.MARKET_DNA)?.detail?.missing || [];
    // Ett jobb per otestad regim: det är den minsta enhet som fyller ett hål.
    const targets = missing.length ? missing : ['any'];

    for (const regimeKey of targets) {
      const alreadyKnown = Boolean(row.dnaHash)
        && (knownRegimesByDna.get(row.dnaHash)?.has(regimeKey) === true);

      // De fyra signalerna, var för sig på skalan 0–100 så att de går att
      // jämföra och att motiveringen går att skriva ut i klartext.
      const components = {
        gap: round(row.gaps.reduce((total, gap) => total + gap.informationValue, 0)),
        uncertainty: row.uncertainty,
        coverage: row.coverage,
        novelty: row.novelty,
        systemic: regimeKey !== 'any' && systemUntested.has(regimeKey) ? 100 : 0,
      };
      const informationGain = alreadyKnown ? 0 : round(
        (components.gap * KNOWLEDGE_WEIGHTS.gap)
        + (components.uncertainty * KNOWLEDGE_WEIGHTS.uncertainty)
        + (components.coverage * KNOWLEDGE_WEIGHTS.coverage)
        + (components.novelty * KNOWLEDGE_WEIGHTS.novelty)
        + (components.systemic * KNOWLEDGE_WEIGHTS.systemic),
      );

      jobs.push({
        strategyId: row.strategyId,
        dnaHash: row.dnaHash,
        targetRegime: regimeKey,
        replayMode,
        executionModel,
        informationGain,
        // Bakåtkompatibelt fält: den systemiska termen som eget värde.
        systemicInformationGain: alreadyKnown ? 0 : round(components.systemic * KNOWLEDGE_WEIGHTS.systemic),
        knowledgeValue: {
          components,
          weights: KNOWLEDGE_WEIGHTS,
          family: row.family,
          familyRuns: row.familyRuns,
          scoreSpread: row.scoreSpread,
        },
        alreadyKnown,
        gapsAddressed: row.gaps.map((gap) => gap.type),
        // Skälet skrivs ut. En prioritering utan motivering går inte att
        // ifrågasätta, och då blir den snart en sanning ingen granskar.
        motivation: alreadyKnown
          ? 'Experimentet finns redan i AI Memory — ingen ny kunskap.'
          : motivationFor(row, components),
      });
    }
  }

  // Deterministisk sortering: informationsvärde först, sedan namn. Utan
  // sekundärnyckeln kan två jobb med samma värde byta plats mellan körningar,
  // och då är rekommendationen inte reproducerbar.
  return jobs.sort((a, b) => b.informationGain - a.informationGain
    || String(a.strategyId).localeCompare(String(b.strategyId))
    || String(a.targetRegime).localeCompare(String(b.targetRegime)));
}

// ── hjärnan ──────────────────────────────────────────────────────────────────

function createStrategyBrain(options = {}) {
  const memory = options.memory || aiMemoryModule.defaultAiMemory;
  const intelligence = options.intelligence || marketIntelligence;
  const dnaService = options.dnaService || strategyDna;

  /**
   * @param {object} library    strategyLibraryService-instans
   * @param {object} [catalog]  DNA-katalog; byggs annars ur lagret
   * @param {Date}   [now]      klockan skickas in — hjärnan äger ingen
   */
  function analyze({ library, catalog = null, now = new Date(), replayMode = 'strategy', executionModel = 'simulated_fill' } = {}) {
    const intel = intelligence.buildMarketIntelligence({ library, catalog });
    const availableRegimes = Object.keys(intel.market.regimeCounts || {}).sort();
    const intelByStrategy = new Map(intel.strategies.map((row) => [row.strategyId, row]));
    const dnaByStrategy = new Map(dnaService.listStrategyDna().map((dna) => [dna.strategyId, dna]));

    const records = library.listStrategies();

    // Familjens totala erfarenhet räknas EN gång för alla strategier. Utan
    // det här steget vet en variant inget om att dess syskon redan körts, och
    // fabriken mal igenom hela familjen innan den rör nästa.
    const familyRunsByFamily = new Map();
    for (const record of records) {
      const family = familyOf(record.strategyId, dnaFor(record.strategyId, dnaByStrategy, dnaService));
      familyRunsByFamily.set(family, (familyRunsByFamily.get(family) || 0) + (record.replayHistory || []).length);
    }

    const strategies = records.map((record) => {
      const gaps = findKnowledgeGaps(record, {
        availableRegimes,
        intelligenceRow: intelByStrategy.get(record.strategyId) || null,
      });
      const promotion = promotionEngine.evaluatePromotion(record);
      const retirement = retirementEngine.evaluateRetirement(record, { now });
      const recommendation = recommendFor(record, gaps, { promotion, retirement });
      const dna = dnaFor(record.strategyId, dnaByStrategy, dnaService);
      const family = familyOf(record.strategyId, dna);
      const spread = scoreSpread(record);
      const intelRow = intelByStrategy.get(record.strategyId) || null;

      return {
        strategyId: record.strategyId,
        dnaHash: dna?.dnaHash || record.currentDnaHash || null,
        family,
        familyRuns: familyRunsByFamily.get(family) || 0,
        scoreSpread: spread,
        uncertainty: uncertaintyValue(spread),
        novelty: noveltyValue(familyRunsByFamily.get(family) || 0),
        coverage: coverageValue(intelRow),
        lifecycle: record.lifecycle,
        strategyScore: record.strategyScore,
        confidenceScore: record.confidenceScore,
        executionScore: record.executionScore,
        productionScore: record.productionScore,
        replayRuns: (record.replayHistory || []).length,
        replayTrades: replayTrades(record),
        paperTrades: (record.paperHistory || []).length,
        liveTrades: (record.liveHistory || []).length,
        regimesTested: intelByStrategy.get(record.strategyId)?.regimesTested || [],
        blindSpots: intelByStrategy.get(record.strategyId)?.blindSpots || [],
        gaps,
        knowledgeScore: round(100 - gaps.reduce((total, gap) => total + gap.informationValue, 0)),
        recommendation,
        promotion: { to: promotion.to, allowed: promotion.allowed, blockers: promotion.blockers || [] },
        retirementSuggested: retirement.shouldRetire === true,
      };
    }).sort((a, b) => String(a.strategyId).localeCompare(String(b.strategyId)));

    const priority = buildReplayPriority({
      strategies,
      availableRegimes,
      memory,
      executionModel,
      replayMode,
      systemUntestedRegimes: intel.market.untestedByAnyone,
    });

    return {
      ok: true,
      brainVersion: BRAIN_VERSION,
      generatedFor: new Date(now).toISOString(),
      market: {
        availableRegimes,
        regimeCounts: intel.market.regimeCounts,
        untestedByAnyone: intel.market.untestedByAnyone,
        periods: intel.market.periods,
      },
      strategies,
      // Nästa körning: det jobb som lär oss mest.
      nextReplay: priority.find((job) => job.informationGain > 0) || null,
      priority,
      memory: memory.getStatus(),
      recommendations: summarizeRecommendations(strategies),
      // Hjärnan föreslår. Den utför aldrig.
      capabilities: {
        recommends: true,
        mutates: false,
        optimizes: false,
        runsReplay: false,
        retires: false,
      },
      ...SAFETY,
    };
  }

  function summarizeRecommendations(strategies) {
    const byAction = {};
    for (const row of strategies) {
      const action = row.recommendation.action;
      if (!byAction[action]) byAction[action] = [];
      byAction[action].push(row.strategyId);
    }
    return byAction;
  }

  function knowledgeGaps({ library, catalog = null, now = new Date() } = {}) {
    const analysis = analyze({ library, catalog, now });
    return {
      ok: true,
      byStrategy: analysis.strategies.map((row) => ({
        strategyId: row.strategyId,
        knowledgeScore: row.knowledgeScore,
        gaps: row.gaps,
      })),
      // Hål som gäller HELA systemet, inte en enskild strategi.
      systemic: {
        regimesNoStrategyHasSeen: analysis.market.untestedByAnyone,
        strategiesNeverRun: analysis.strategies.filter((row) => row.replayRuns === 0).map((row) => row.strategyId),
        strategiesWithoutPaper: analysis.strategies.filter((row) => row.paperTrades === 0).map((row) => row.strategyId),
        strategiesWithoutLive: analysis.strategies.filter((row) => row.liveTrades === 0).map((row) => row.strategyId),
      },
      gapTypes: GAP_TYPES,
      gapWeights: GAP_WEIGHT,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    BRAIN_VERSION,
    RECOMMENDATIONS,
    GAP_TYPES,
    analyze,
    knowledgeGaps,
  };
}

module.exports = {
  SAFETY,
  BRAIN_VERSION,
  RECOMMENDATIONS,
  GAP_TYPES,
  GAP_WEIGHT,
  THRESHOLDS,
  KNOWLEDGE_WEIGHTS,
  UNCERTAINTY_FULL_SCALE,
  createStrategyBrain,
  findKnowledgeGaps,
  buildReplayPriority,
  _internal: {
    recommendFor, replayTrades, regimeKeysOf,
    scoreSpread, uncertaintyValue, noveltyValue, coverageValue, familyOf,
  },
};
