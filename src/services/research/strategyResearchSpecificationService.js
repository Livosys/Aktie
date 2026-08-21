'use strict';

// Read-only research specification builder. This is deliberately not a
// producer, optimizer, scheduler, or persistence layer. It describes what is
// known and what still needs evidence before executable strategy code exists.

const evidencePolicy = require('./researchEvidencePolicyService');
const catalogService = require('../daytradingStrategyCatalogService');
const blueprintService = require('../tradingViewTestBlueprintService');
const marketDataCoverage = require('../../data/marketDataCoverage');
const marketDataStore = require('../../data/marketDataStore');
const futuresSessions = require('../futuresMarketHoursService');

const SPEC_VERSION = 'strategy-research-spec-v1';
const STRATEGY_IDS = Object.freeze([
  'low_volatility_breakout',
  'volume_spike_momentum',
]);

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  real_orders_blocked: true,
  paper_only: true,
});

const STATUS = 'RESEARCH_SPECIFIED';

function text(value, fallback = null) {
  if (value == null) return fallback;
  const result = String(value).trim();
  return result || fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function source(file, line, kind, note = null) {
  return Object.freeze({ file, line, kind, ...(note ? { note } : {}) });
}

function unresolved(parameter, sourceRef, rationale, extra = {}) {
  return {
    parameter,
    classification: 'RESEARCH_REQUIRED',
    source: sourceRef,
    candidateValues: [],
    allowedRange: null,
    resolved: false,
    rationale,
    ...extra,
  };
}

function catalogHypothesis(parameter, values, sourceRef, rationale, extra = {}) {
  return {
    parameter,
    classification: 'RESEARCH_REQUIRED',
    source: sourceRef,
    candidateValues: clone(values),
    allowedRange: null,
    resolved: false,
    rationale,
    hypothesisOnly: true,
    ...extra,
  };
}

function conceptFor(strategy) {
  return {
    market: text(strategy.market_group || strategy.market, 'all'),
    direction: text(strategy.direction, 'both'),
    family: text(strategy.family),
    timeframes: Array.isArray(strategy.default_timeframes) ? [...strategy.default_timeframes] : [],
    rules: Array.isArray(strategy.signal_rules) ? [...strategy.signal_rules] : [],
    runtimeSignal: strategy.runtime_signals?.[0]?.raw_signal || null,
  };
}

function commonVariables(strategy) {
  const id = strategy.id;
  const catalogSource = source('src/services/daytradingStrategyCatalogService.js', id === 'low_volatility_breakout' ? 1380 : 930, 'catalog_metadata');
  const sessionSource = source('src/services/futuresMarketHoursService.js', 1, 'canonical_session_model');
  return [
    catalogHypothesis('timeframe', strategy.default_timeframes || [], catalogSource,
      'Katalogen föreslår tidsramar, men deras Futures-researchkvalitet är inte validerad.'),
    unresolved('session', sessionSource,
      'Canonical sessioner finns, men ingen av strategierna anger vilken session som gäller.'),
    unresolved('staleLimit', source('src/data/marketDataCoverage.js', 1, 'canonical_data_coverage'),
      'Datatäckning och freshness finns centralt, men ingen strategispecifik stale-gräns är beslutad.'),
    unresolved('entryModel', source('src/services/paperStrategyEntryContractService.js', 1, 'paper_entry_contract'),
      'Signalbar-close, nästa bar, stop-entry och retest är inte valda för dessa concepts.'),
    unresolved('entryPrice', source('src/services/paperStrategyEntryContractService.js', 1, 'paper_entry_contract'),
      'Exakt prisfält och timing för entry saknas.'),
    unresolved('invalidation', catalogSource,
      'Ingen verifierad regel beskriver när signalen blir ogiltig före entry.'),
    catalogHypothesis('stop', [strategy.default_sl], catalogSource,
      'Katalogvärdet bevaras som hypotes; enheten och precedence är inte verifierade.', { unit: null }),
    catalogHypothesis('target', [strategy.default_tp], catalogSource,
      'Katalogvärdet bevaras som hypotes; R-definition och precedence är inte verifierade.', { unit: null }),
    catalogHypothesis('holdingTime', [strategy.default_holding_time], catalogSource,
      'Katalogvärdet bevaras som hypotes; time-stop semantics är inte verifierad.', { unit: null }),
    unresolved('exitPrecedence', source('src/services/strategyPerformanceService.js', 165, 'synthetic_test_engine'),
      'Ingen körbar Futures-exit definierar precedence mellan stop, target och time-stop.'),
  ];
}

function strategyVariables(strategy) {
  const id = strategy.id;
  const blueprintSource = source('src/services/tradingViewTestBlueprintService.js', 123, 'generic_pine_pseudomap',
    'Illustrativ mapping; inte en Futures-evaluator.');
  if (id === 'low_volatility_breakout') {
    return [
      unresolved('volatilityEstimator', source('src/services/marketRegimeService.js', 346, 'market_regime_primitive'),
        'Low-volatility concept saknar vald estimator och threshold.', {
          candidateValues: ['market_regime', 'atr14'],
          candidateValuesAreHypotheses: true,
        }),
      catalogHypothesis('compressionWindow', [20], source('src/services/tradingViewTestBlueprintService.js', 296, 'generic_pine_pseudomap'),
        '20-bars finns i den generiska blueprintens range-primitiv men är inte strategi-evidens.'),
      catalogHypothesis('breakoutRule', ['close_through_range_high_low'], source('src/services/tradingViewTestBlueprintService.js', 111, 'generic_pine_pseudomap'),
        'Blueprinten beskriver en möjlig range-break, men close-through och nivådefinition är inte beslutade.'),
      unresolved('volumeRule', source('src/services/tradingViewTestBlueprintService.js', 106, 'generic_pine_pseudomap'),
        'Volume expansion finns som concept men lookback och threshold saknas.', {
          candidateValues: ['volume_sma20', 'relVol20'],
          candidateValuesAreHypotheses: true,
        }),
    ];
  }
  return [
    catalogHypothesis('relativeVolumeSource', ['relVol20'], source('src/scanner/decisionMonitor.js', 225, 'runtime_observation_field'),
      'relVol20 finns som runtime-observationsfält, men strategy threshold är inte verifierad.'),
    catalogHypothesis('relativeVolumeThreshold', [2.0], source('src/services/tradingViewTestBlueprintService.js', 123, 'generic_pine_pseudomap'),
      '2.0 finns endast i generisk Pine-pseudomapping och får inte användas som runtime-default.'),
    catalogHypothesis('priceExpansionMeasure', ['abs_body_over_atr14'], source('src/services/tradingViewTestBlueprintService.js', 124, 'generic_pine_pseudomap'),
      'ATR14 och body-mått är en möjlig hypotes, men expansion threshold är inte validerad.'),
    unresolved('priceExpansionThreshold', source('src/services/tradingViewTestBlueprintService.js', 124, 'generic_pine_pseudomap'),
      'Den generiska 0.5-multiplikatorn är inte Futures-strategibevis.'),
    unresolved('spreadMeasure', source('src/services/daytradingStrategyCatalogService.js', 930, 'catalog_concept'),
      'spread_not_extreme saknar källa, fält och maxgräns.'),
    catalogHypothesis('followThroughRule', ['close_over_previous_close'], blueprintSource,
      'Blueprinten anger close > close[1], men detta är inte verifierad strategy-runtime.'),
  ];
}

function historicalCoverage({ coverageService = marketDataCoverage, dataStore = marketDataStore } = {}) {
  const roots = ['MNQ', 'MES'];
  const dates = Object.fromEntries(roots.map((root) => [root, coverageService.listDates(root, { dataStore, source: 'ib' })]));
  const completeDays = coverageService.listCompleteDays({
    roots,
    throughUtcTime: '15:00',
    minBars: 600,
    dataStore,
    source: 'ib',
  });
  const latestDate = completeDays[0] || null;
  const volumeAvailable = Object.fromEntries(roots.map((root) => {
    const rows = latestDate ? dataStore.loadRawBars(root, latestDate, latestDate, 'ib') : [];
    const sample = rows.find((row) => row && row.volume != null);
    return [root, Boolean(sample)];
  }));
  // ── Två läsvägar, två datamängder ─────────────────────────────────────────
  //
  // marketDataStore.loadRawBars läser rotkatalogen OCH kontraktskatalogerna när
  // ingen contractKey anges, men BARA den angivna kontraktskatalogen när en
  // anges. Dygn som bara finns på rotnivå syns därför i en rotläsning men
  // försvinner i en kontraktsspecifik läsning.
  //
  // Mätt: MNQ har 218 kontraktspartitionerade dygn och 13 dygn på rotnivå,
  // varav 4 (2026-08-07, -14, -18, -19) saknar motsvarighet i
  // kontraktskatalogen. Summan blir 222 vid rotläsning och 218 vid
  // kontraktsläsning. Ett experiment måste veta vilken av dem det kördes på,
  // annars går identiteten inte att reproducera.
  const contractPartitionedDays = Object.fromEntries(roots.map((root) => {
    const perContract = typeof dataStore.listAvailableContractDates === 'function'
      ? dataStore.listAvailableContractDates(root, 'ib')
      : null;
    return [root, perContract ? [...new Set(Object.values(perContract).flat())].sort() : null];
  }));

  const dayCount = completeDays.length;
  return {
    source: 'ibkr',
    sourceType: 'real_imported_market_data',
    roots,
    dates,
    calendarDateCount: Math.max(...roots.map((root) => dates[root].length), 0),
    completeTradingDays: completeDays,
    completeTradingDayCount: dayCount,
    // Vilka dygn som faktiskt är kontraktspartitionerade. null när lagret inte
    // kan svara — aldrig en gissning.
    contractPartitionedDays,
    resolutions: { raw: ['1m'], derived: ['2m'], otherDerivedVerified: [] },
    volumeAvailable,
    // En tidsseparerad split KRÄVER tillräckligt många dygn för att båda
    // halvorna ska bära ett omdöme. Räknas, hårdkodas inte.
    outOfSampleSplitAvailable: dayCount >= 60,
    // Elva månader är inte flera år. Räknas ur spannet i stället för att
    // påstås.
    multiYearCoverage: spansMultipleYears(completeDays),
    sufficientForValidatedStrategy: false,
    limitation: dayCount
      ? `${dayCount} kompletta gemensamma trading days (${completeDays[completeDays.length - 1]} → ${completeDays[0]}) `
        + 'räcker för initial historisk research men är inte bevis för långsiktig generalisering. '
        + 'Ingen oberoende flerårig out-of-sample-period finns.'
      : 'Inga kompletta gemensamma trading days i lagret.',
  };
}

/** Täcker dygnen mer än 24 månader? Annars är "multi-year" ett påstående. */
function spansMultipleYears(days = []) {
  if (days.length < 2) return false;
  const first = Date.parse(days[days.length - 1]);
  const last = Date.parse(days[0]);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  return (last - first) / (365.25 * 24 * 60 * 60 * 1000) >= 2;
}

function validationRequirements() {
  return {
    minimumHistoricalEvidence: null,
    minimumRegimeCoverage: null,
    outOfSampleRequired: true,
    paperEvidenceRequired: true,
    requiredMetrics: ['sampleSize', 'drawdown', 'scoreStability', 'uncertainty', 'marketDna', 'session'],
    // ── Trösklarna är inte längre obeslutade, men inte heller godkända ────────
    //
    // Fram till cykel 2 stod detta på 'not_decided', och det var rätt: att hitta
    // på ett promotionkrav mitt i en pågående cykel hade varit att flytta
    // målstolpen efter att man sett resultatet.
    //
    // Nu FINNS en policy, skriven mellan två cykler och inte under någon.
    // Statusen läses ur policyn själv i stället för att stå här som en sträng —
    // en handskriven status hade kunnat påstå 'approved' medan fyra av
    // trösklarna fortfarande väntade på en människa.
    thresholdsStatus: evidencePolicy.describePolicy().status,
    thresholdsPolicyVersion: evidencePolicy.POLICY_VERSION,
    pendingHumanDecisions: evidencePolicy.listPendingHumanDecisions().map((row) => row.name),
    note: 'Befintliga Library/ledger-mått återanvänds; researchEvidencePolicyService äger klassificeringen.',
  };
}

function buildSpecification(strategyId, options = {}) {
  const strategy = catalogService.getStrategyById(strategyId);
  if (!strategy || !STRATEGY_IDS.includes(strategyId)) {
    throw new Error(`unknown_research_strategy:${strategyId}`);
  }
  const blueprint = blueprintService.defaultTradingViewTestBlueprintService
    .getTradingViewTestBlueprint(strategyId)?.blueprint || null;
  const coverage = options.includeCoverage === false ? null : historicalCoverage(options);
  return {
    schema: SPEC_VERSION,
    strategyId,
    status: STATUS,
    executable: false,
    runtimeEligible: false,
    concept: conceptFor(strategy),
    knownRules: [...conceptFor(strategy).rules],
    researchVariables: [...commonVariables(strategy), ...strategyVariables(strategy)],
    canonicalSessions: Object.keys(futuresSessions.SESSION_IDS).map((key) => futuresSessions.SESSION_IDS[key]),
    blueprint: blueprint ? {
      source: 'tradingViewTestBlueprintService',
      syntheticOrPseudo: true,
      pineScriptPossible: blueprint.pineScriptPossible === true,
    } : null,
    historicalData: coverage,
    validationRequirements: validationRequirements(),
    unresolvedBusinessDecisions: [
      'volatility/volume thresholds',
      'compression/range windows',
      'session selection',
      'stale and invalidation semantics',
      'entry model and entry price',
      'exit units and precedence',
      'minimum evidence thresholds',
    ],
    nextAction: 'collect_real_historical_evidence_without_runtime_activation',
    ...SAFETY,
  };
}

function buildSpecifications(options = {}) {
  return STRATEGY_IDS.map((id) => buildSpecification(id, options));
}

function buildResearchWorkItem(specification, { memory = null } = {}) {
  const unresolvedParameters = specification.researchVariables
    .filter((variable) => variable.resolved !== true)
    .map((variable) => variable.parameter);
  return {
    strategyId: specification.strategyId,
    status: 'BLOCKED_UNTIL_EXECUTABLE_IDENTITY',
    canSchedule: false,
    duplicateCheck: 'deferred_until_strategy_dna_market_dna_execution_model_replay_mode_are_known',
    // aiMemoryService exponerar lookupOrPlan, inte checkBeforeRun. Kontrollen
    // letade efter ett metodnamn som aldrig funnits och svarade därför alltid
    // false — även med ett fullt fungerande minne inkopplat.
    memoryAvailable: Boolean(memory && typeof memory.lookupOrPlan === 'function'),
    unresolvedParameters,
    reason: 'AI Memory identity cannot be formed before the research specification is executable and versioned.',
    safety: SAFETY,
  };
}

/**
 * Arbetsordern för en EXECUTABLE RESEARCH HYPOTHESIS.
 *
 * Skillnaden mot buildResearchWorkItem ovan är hela poängen med hypoteslagret.
 * Konceptet är fortfarande blockerat — dess fjorton variabler är olösta och
 * ingen har löst dem. Hypotesen är en explicit, versionerad TOLKNING av samma
 * koncept, och den har allt en experimentidentitet kräver: Strategy DNA,
 * parameterhash, replayläge, exekveringsmodell, version, kontrakt och period.
 *
 * Därför kan den schemaläggas — och därför kan AI Memory hindra att den körs
 * två gånger.
 *
 * Ingenting här gör hypotesen körbar i runtime eller behörig för Paper. Det
 * avgörs av grindarna i researchHypothesisService, som speglas oförändrade i
 * svaret.
 */
function buildHypothesisWorkItem(hypothesis, { memory = null, split = null } = {}) {
  const memoryAvailable = Boolean(memory && typeof memory.lookupOrPlan === 'function');
  const identity = {
    strategyId: hypothesis.researchStrategyId,
    conceptStrategyId: hypothesis.strategyId,
    hypothesisId: hypothesis.hypothesisId,
    hypothesisVersion: hypothesis.hypothesisVersion,
    hypothesisHash: hypothesis.hypothesisHash,
    researchSpecVersion: hypothesis.researchSpecVersion,
    timeframe: hypothesis.semantics.timeframe,
    session: hypothesis.semantics.session,
    roots: hypothesis.semantics.roots,
    dataAccessMode: split ? split.dataAccessMode : 'exact_contract',
    researchContracts: split ? split.research.contracts : null,
    researchPeriod: split ? [split.research.from, split.research.to] : null,
    validationContracts: split ? split.validation.contracts : null,
    validationPeriod: split ? [split.validation.from, split.validation.to] : null,
  };
  // Market DNA räknas per körning och kan därför inte stå här. Det är också
  // rätt: identiteten är komplett när ALLT UTOM marknaden är känt, och
  // marknaden avgörs av vilken dag jobbet får.
  const missing = Object.entries(identity)
    .filter(([, value]) => value == null)
    .map(([key]) => key);

  return {
    strategyId: hypothesis.researchStrategyId,
    status: missing.length ? 'BLOCKED_UNTIL_EXECUTABLE_IDENTITY' : 'EXECUTABLE_RESEARCH_HYPOTHESIS',
    canSchedule: missing.length === 0 && memoryAvailable,
    duplicateCheck: memoryAvailable ? 'ai_memory_experiment_key' : 'unavailable_without_ai_memory',
    memoryAvailable,
    identity,
    missingIdentityFields: missing,
    gates: hypothesis.gates,
    runtimeEligible: false,
    paperEligible: false,
    reason: missing.length
      ? 'hypothesis identity is incomplete'
      : 'hypothesis is versioned and executable in historical replay only',
    safety: SAFETY,
  };
}

module.exports = {
  SPEC_VERSION,
  STATUS,
  STRATEGY_IDS,
  SAFETY,
  buildSpecification,
  buildSpecifications,
  buildResearchWorkItem,
  buildHypothesisWorkItem,
  historicalCoverage,
};
