'use strict';

// ── Research Evidence Ledger ─────────────────────────────────────────────────
//
// Bron mellan Strategy Library och Research Evidence Policy.
//
// Policyn är en ren funktion: den tar ett research-utfall, ett validation-utfall
// och dygnsrader, och svarar med en klassificering. Den läser inga filer och vet
// inte vad ett bibliotek är — det är därför den går att testa och därför den
// aldrig kan ge olika svar beroende på systemets tillstånd.
//
// Den här modulen gör det motsatta och bara det: läser bibliotekets rader för en
// hypotes, delar dem på research- och validationsperioden med hjälp av
// dataset-gränsen, och aggregerar dem till den form policyn väntar sig.
//
// ── Varför klassificeringen inte lagras ──────────────────────────────────────
//
// Utfallet härleds vid anrop i stället för att skrivas som en händelse. En
// lagrad dom hade kunnat säga något annat än evidensen den bygger på — och
// eftersom evidensen är append-only och växer för varje körning hade den domen
// varit inaktuell i samma stund nästa dygn bokfördes.
//
// Bibliotekets LIFECYCLE_TRANSITION används medvetet INTE. Den tillhör
// strategilivscykeln (draft → testing → … → paper → live), och en research-dom
// hör inte hemma på den axeln. Att skriva HISTORICALLY_VALIDATED_CANDIDATE som
// ett bibliotekssteg hade dragit in hypotesen på vägen mot Paper, vilket är
// exakt vad research-livscykelns grindar finns för att förhindra.
//
// ── Aggregering av profit factor ─────────────────────────────────────────────
//
// Profit factor går inte att summera över dygn. Den räknas om ur fält
// biblioteket redan bokför: winRate och trades ger antal vinnare och förlorare,
// avgWinUsd och avgLossUsd ger deras genomsnitt, och produkten är periodens
// bruttovinst respektive bruttoförlust. Inget nytt mäts.

const boundaryModule = require('./researchDatasetBoundaryService');
const calendar = require('../../data/tradingDayCalendar');
const policyModule = require('./researchEvidencePolicyService');
const hypothesisModule = require('./researchHypothesisService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  grants_runtime_eligibility: false,
  grants_paper_eligibility: false,
  source: 'research_evidence_ledger',
});

const PHASES = Object.freeze({ RESEARCH: 'research', VALIDATION: 'validation' });

// Number(null) är 0 och Number('') är 0. Utan den första raden blir ett SAKNAT
// värde till ett uppmätt nollresultat — ett bibliotek utan netPnlUsd hade
// rapporterat "nettot var noll" i stället för "nettot är okänt", och policyn
// hade förkastat en hypotes på grund av en bokföringsbrist.
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 3) {
  const n = num(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/**
 * Vilken period en dygnsrad tillhör.
 *
 * Raden bär sitt replay-fönster i `from`, som är RTH-datumet — alltså
 * handelsdagens etikett plus ett dygn (se researchDatasetBoundaryService). Vi
 * jämför därför mot RTH-datumen och inte mot handelsdagarna.
 */
function phaseIndex(split) {
  const index = new Map();
  for (const day of split.research.days) index.set(calendar.rthDateFor(day), PHASES.RESEARCH);
  for (const day of split.validation.days) index.set(calendar.rthDateFor(day), PHASES.VALIDATION);
  return index;
}

/** Bruttovinst och bruttoförlust för en dygnsrad, ur fält som redan bokförs. */
function grossOf(row) {
  const trades = num(row.trades) || 0;
  const winRate = num(row.winRate);
  if (!trades || winRate == null) return { grossWin: 0, grossLoss: 0 };
  const wins = Math.round((winRate / 100) * trades);
  const losses = trades - wins;
  return {
    grossWin: wins * (num(row.avgWinUsd) || 0),
    grossLoss: losses * (num(row.avgLossUsd) || 0),
  };
}

/**
 * Slår ihop dygnsrader till ett periodutfall i summarizeTrades form.
 *
 * maxDrawdownUsd räknas på DYGNSUPPLÖSNING: en resultatkurva byggd av dagarnas
 * netto, och dess största fall från topp till botten. Det är medvetet ett annat
 * tal än ledgerns maxDrawdownUsd, som mäts per affär inom en körning — ett
 * flerdygnsfall går inte att härleda ur enskilda dygns maxima. Upplösningen
 * står i svaret så ingen läsare kan förväxla de två.
 */
function aggregateDailyRows(rows = []) {
  const ordered = [...rows].sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
  let trades = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let netPnlUsd = 0;
  let strategyPnlUsd = 0;
  let peak = 0;
  let equity = 0;
  let maxDrawdownUsd = 0;
  let netAvailable = ordered.length > 0;

  for (const row of ordered) {
    trades += num(row.trades) || 0;
    const gross = grossOf(row);
    grossWin += gross.grossWin;
    grossLoss += gross.grossLoss;
    strategyPnlUsd += num(row.strategyPnlUsd) || 0;
    const net = num(row.netPnlUsd);
    // netPnlUsd bokfördes inte av äldre körningar. Att tyst falla tillbaka på
    // strategyPnlUsd hade gjort ett bruttoresultat till ett nettoresultat och
    // därmed låtit en hypotes som inte bär sin kostnad se ut att göra det.
    if (net == null) netAvailable = false;
    netPnlUsd += net || 0;
    equity += net ?? (num(row.strategyPnlUsd) || 0);
    if (equity > peak) peak = equity;
    if (peak - equity > maxDrawdownUsd) maxDrawdownUsd = peak - equity;
  }

  return {
    trades,
    strategyPnlUsd: round(strategyPnlUsd, 2),
    netPnlUsd: netAvailable ? round(netPnlUsd, 2) : null,
    netAvailable,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? null : 0),
    maxDrawdownUsd: round(maxDrawdownUsd, 2),
    drawdownResolution: 'trading_day',
    days: ordered.length,
  };
}

/**
 * Lägger på kostnadsuppgift som återförts i efterhand.
 *
 * Backfillen används ENDAST när dygnsraderna saknar netto. Finns nettot redan
 * per dygn är dygnssumman den bättre källan — den följer automatiskt med när
 * fler dygn bokförs, medan en periodpost är låst till den period den skrevs för.
 *
 * Antalet affärer måste stämma. Gör det inte täcker backfillen en annan
 * uppsättning körningar än de rader som lästes, och då är den inte ett svar på
 * frågan som ställdes.
 */
function withCostBackfill(aggregate, backfill = null) {
  if (aggregate.netAvailable) return { ...aggregate, netSource: 'daily_rows' };
  if (!backfill) return { ...aggregate, netSource: null };
  const net = num(backfill.netPnlUsd);
  if (net == null) return { ...aggregate, netSource: null };
  if (num(backfill.trades) !== aggregate.trades) {
    return { ...aggregate, netSource: null, netBackfillRejected: 'trade_count_mismatch' };
  }
  return {
    ...aggregate,
    netPnlUsd: net,
    executionCostUsd: num(backfill.executionCostUsd),
    commissionUsd: num(backfill.commissionUsd),
    netAvailable: true,
    netSource: 'period_backfill',
    netResolution: 'period',
  };
}

/**
 * Bibliotekets replay-rader för en research-hypotes, uppdelade på period.
 *
 * @param {string} strategyId
 * @param {object} [options]
 * @param {object} [options.library]
 * @param {object} [options.split]
 */
/**
 * Körningar som AI Memory har uteslutit ur produktionskunskapen.
 *
 * Reconciliation-händelserna bär redan `libraryRunId` i sitt underlag, så
 * minnet VET vilka biblioteksrader som inte får räknas — och att inte fråga det
 * hade betytt att biblioteket klassificerar på evidens som minnet redan
 * förkastat.
 *
 * Det är inte hypotetiskt: cykel 1:s första research-pass körde två hypoteser i
 * fel timeframe. De experimenten uteslöts som NON_CANONICAL_PROVENANCE, men
 * deras biblioteksrader ligger kvar — och utan den här spärren summerades de
 * ihop med hypotesens riktiga rader till en blandning av två timeframes.
 *
 * Nyckeln är PARET strategi och körning, aldrig körningen ensam. En körning
 * omfattar samtliga hypoteser i passet, och att utesluta på runId hade tagit
 * bort hela passet för alla — inklusive de hypoteser som kördes korrekt.
 */
function excludedRunKey(strategyId, runId) {
  return `${strategyId}|${runId}`;
}

function excludedRunKeys(memory) {
  const mem = memory || require('../memory/aiMemoryService').defaultAiMemory;
  if (typeof mem.listExperiments !== 'function') return new Set();
  const out = new Set();
  for (const row of mem.listExperiments()) {
    if (!row.excluded) continue;
    const strategyId = row.exclusion?.evidence?.strategyId || row.libraryRef?.strategyId;
    if (!strategyId) continue;
    // Härkomsten bär VARJE körning experimentet observerats i, inte bara den
    // första. libraryRef pekar per konstruktion bara ut den första — den är en
    // referens till var svaret finns, inte en förteckning över körningar — och
    // att läsa den ensam hade lämnat kvar alla dagar utom en av en utesluten
    // körningsserie.
    for (const provenance of row.provenance || []) {
      if (provenance.runId) out.add(excludedRunKey(String(strategyId), String(provenance.runId)));
    }
    const first = row.exclusion?.evidence?.libraryRunId;
    if (first) out.add(excludedRunKey(String(strategyId), String(first)));
  }
  return out;
}

function collectEvidence(strategyId, {
  library = null, split = null, memory = null, excludedRuns = null, timeframe = null,
} = {}) {
  const lib = library || require('../library/strategyLibraryService').defaultStrategyLibrary;
  const activeSplit = split || boundaryModule.buildSplit();
  const index = phaseIndex(activeSplit);
  const excluded = excludedRuns || excludedRunKeys(memory);

  const rows = typeof lib.getAuditTrail === 'function'
    ? lib.getAuditTrail({ strategyId })
    : [];

  const byPhase = { [PHASES.RESEARCH]: [], [PHASES.VALIDATION]: [] };
  const costBackfill = { [PHASES.RESEARCH]: null, [PHASES.VALIDATION]: null };
  for (const row of rows) {
    if (row.strategyId !== strategyId) continue;

    // Kostnadsuppgift återförd i efterhand. Egen typ, egen upplösning — den
    // räknas ALDRIG som ännu en körning, bara som det som saknades i dem.
    if (row.type === 'REPLAY_COST_BACKFILLED') {
      const phase = String(row.phase || '');
      if (costBackfill[phase] === null) costBackfill[phase] = row;
      continue;
    }

    if (row.type !== 'REPLAY_RECORDED') continue;
    if (excluded.has(excludedRunKey(strategyId, String(row.runId || '')))) continue;
    // En rad från en annan timeframe än den hypotesen deklarerar är inte dess
    // evidens. Kontrollen kräver att BÅDA sidor är kända: äldre rader saknar
    // fältet, och att tolka det som "fel timeframe" hade kastat bort giltig
    // historik i stället för att skydda den.
    if (timeframe && row.timeframe && row.timeframe !== timeframe) continue;
    const date = String(row.from || '').slice(0, 10);
    const phase = index.get(date);
    // En rad utanför splitten hör inte till någon period och räknas inte.
    // Tyst inkludering hade blandat perioderna och gjort valideringen värdelös.
    if (!phase) continue;
    byPhase[phase].push(row);
  }
  return { ...byPhase, costBackfill };
}

/**
 * Klassificerar en research-hypotes ur bibliotekets evidens.
 *
 * @returns {object} policyns svar, plus underlaget den byggde på
 */
function classifyHypothesis(strategyId, { library = null, split = null, memory = null, excludedRuns = null, policy = policyModule } = {}) {
  if (!hypothesisModule.isResearchStrategyId(strategyId)) {
    throw new Error(`not_a_research_hypothesis:${strategyId}`);
  }
  const declaredTimeframe = hypothesisModule.getHypothesis(strategyId)?.semantics?.timeframe || null;
  const evidence = collectEvidence(strategyId, {
    library, split, memory, excludedRuns, timeframe: declaredTimeframe,
  });
  const research = withCostBackfill(
    aggregateDailyRows(evidence[PHASES.RESEARCH]), evidence.costBackfill?.[PHASES.RESEARCH],
  );
  const validation = withCostBackfill(
    aggregateDailyRows(evidence[PHASES.VALIDATION]), evidence.costBackfill?.[PHASES.VALIDATION],
  );

  const verdict = policy.classify({
    research,
    validation,
    researchDailyRows: evidence[PHASES.RESEARCH],
    validationDailyRows: evidence[PHASES.VALIDATION],
  });

  return {
    strategyId,
    ...verdict,
    aggregates: { research, validation },
    // Saknas netto i underlaget kan nettokravet inte prövas ärligt. Det syns i
    // svaret i stället för att gömmas i ett godkänt teckentest.
    netEvidenceComplete: research.netAvailable && validation.netAvailable,
    netSource: { research: research.netSource, validation: validation.netSource },
    ...SAFETY,
  };
}

/** Klassificerar samtliga hypoteser som förekommer i en körning. */
function classifyRecordedRun(recordedStrategyIds = [], options = {}) {
  const ids = [...new Set(recordedStrategyIds.filter(hypothesisModule.isResearchStrategyId))];
  if (!ids.length) return [];
  // Splitten byggs EN gång för hela körningen; den läser lagrets index och
  // kostar en katalogläsning per rot.
  const split = options.split || boundaryModule.buildSplit();
  // Uteslutningarna läses EN gång för hela körningen; listan är densamma för
  // alla hypoteser och kostar en projektion av experimentloggen.
  const excludedRuns = options.excludedRuns || excludedRunKeys(options.memory);
  return ids.map((id) => {
    try {
      return classifyHypothesis(id, { ...options, split, excludedRuns });
    } catch (error) {
      return { strategyId: id, outcome: null, error: error.message, ...SAFETY };
    }
  });
}

module.exports = {
  SAFETY,
  PHASES,
  aggregateDailyRows,
  collectEvidence,
  classifyHypothesis,
  classifyRecordedRun,
  _internal: { grossOf, phaseIndex, excludedRunKeys, excludedRunKey, withCostBackfill },
};
