'use strict';

// ── Research Evidence Policy ─────────────────────────────────────────────────
//
// Vad som krävs för att en research hypothesis ska klassas som validerad
// kandidat, otillräckligt bevisad eller förkastad.
//
// Fram till nu har `thresholdsStatus` stått på `not_decided`, och det var rätt:
// att hitta på ett promotionkrav mitt i en pågående cykel hade varit att flytta
// målstolpen efter att man sett resultatet. Två cykler är körda, ingen kandidat
// överlevde, och policyn skrivs nu FÖRE nästa cykel — vilket är den enda
// tidpunkt då den kan skrivas ärligt.
//
// ── Inga nya mått ────────────────────────────────────────────────────────────
//
// Varje storhet policyn läser räknas redan av tradeLedgerService.summarizeTrades
// och bokförs redan av strategyLibraryRecorderService per körning:
//
//   trades, winRate, profitFactor, strategyPnlUsd, netPnlUsd, expectancyUsd,
//   maxDrawdownUsd, avgWinUsd, avgLossUsd, recoveryFactor
//
// Robusthetsmåtten är AGGREGERINGAR över de per-dygnsrader biblioteket redan
// har — inte nya mätningar. Ett hypotesutfall består av 119 respektive 99
// dagsrader, och frågan "kom hela edgen från tre dagar?" besvaras genom att
// summera dem, inte genom att mäta något nytt.
//
// ── Tre sorters gränser ──────────────────────────────────────────────────────
//
// Varje tröskel bär sin HÄRKOMST i koden, och skillnaden är avsiktlig: den som
// läser policyn om ett år ska kunna se vilka tal som härleddes ur systemet och
// vilka som var ett omdöme.
//
//   PROJECT_DERIVED  Talet finns redan i kodbasen och styr redan beslut på
//                    andra ställen. Att välja ett annat tal här hade gjort
//                    research-lagret oense med resten av systemet.
//
//   HUMAN_APPROVED   Talet saknar förlaga i koden och godkändes uttryckligen
//                    av en människa 2026-08-20. Se APPROVAL.
//
//   SIGN_TEST        Ingen vald nivå alls, utan en definition — "tjänade
//                    pengar", "över break-even".
//
// Policyn rapporterar sig som `approved` först när noll trösklar står som
// PROPOSED. Statusen räknas ur trösklarna, inte ur en handskriven sträng, så
// den kan aldrig påstå sig vara beslutad medan något väntar.
//
// Ett teckentest är ingen tröskel. "Nettot är positivt" och "profit factor över
// 1" är definitioner av att tjäna respektive förlora pengar, inte valda nivåer.

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  // Policyn KLASSIFICERAR. Den aktiverar ingenting: en validerad kandidat är
  // fortfarande inte runtime och fortfarande inte Paper — se
  // researchHypothesisService.LIFECYCLE_GATES.
  grants_runtime_eligibility: false,
  grants_paper_eligibility: false,
  source: 'research_evidence_policy',
});

// ── Policyns version ─────────────────────────────────────────────────────────
//
// v1 behandlade varje negativt tecken lika: netto <= 0 med tillräckligt urval
// gav FÖRKASTAD, oavsett om signalen hade edge eller inte.
//
// Cykel 1 och 2 visade vad det kostar. SJU hypoteser hade profit factor över 1 i
// BÅDA perioderna — signalen bar alltså både in-sample och out-of-sample — men
// negativt netto, eftersom courtaget är fast 2,44 USD per affär och
// exekveringskostnaden åt resten. Alla sju kallades förkastade, och därmed
// slängdes slutsatsen "den här signalen har edge, kostnaden bär den inte" bort
// tillsammans med hypotesen.
//
// Det är två olika svar, och de leder till olika arbete: det ena betyder "sök
// vidare någon annanstans", det andra "signalen finns, angrip kostnaden". Cykel
// 2 bevisade dessutom att den andra vägen är verklig — pullback-entryn sänkte
// exekveringskostnaden från 5,44 till 1,69 USD per affär.
//
// v2 ändrar INTE vad som får befordras. Nettokravet står kvar oförändrat: en
// hypotes som förlorar pengar blir aldrig kandidat. Det som ändras är vad ett
// misslyckande KALLAS när bruttoedgen finns kvar — otillräckligt bevisad i
// stället för förkastad.
//
// v1 finns kvar därför att cykel 1 och 2:s domar avkunnades under den. Att räkna
// om dem i efterhand hade varit att ändra ett protokoll.
const POLICY_VERSIONS = Object.freeze({
  V1: 'research-evidence-policy-v1',
  V2: 'research-evidence-policy-v2',
});

const POLICY_VERSION = POLICY_VERSIONS.V2;

const ORIGIN = Object.freeze({
  PROJECT_DERIVED: 'PROJECT_DERIVED',
  // Fanns ingen förlaga i koden och godkändes av en människa. Skiljs från
  // PROJECT_DERIVED med flit: den som läser policyn om ett år ska kunna se
  // vilka tal som härleddes ur systemet och vilka som var ett omdöme.
  HUMAN_APPROVED: 'HUMAN_APPROVED',
  // Kvar i vokabulären. Att ta bort den hade gjort det omöjligt att lägga till
  // en ny ogodkänd tröskel utan att först ändra policyns typer.
  PROPOSED: 'PROPOSED',
  SIGN_TEST: 'SIGN_TEST',
});

// Godkännandet av de fyra trösklar som saknade förlaga i koden.
const APPROVAL = Object.freeze({
  approvedAt: '2026-08-20',
  approvedBy: 'human_operator',
  scope: Object.freeze(['minTradingDays', 'minEdgeRetention', 'maxTopDayShare', 'minPositiveDayShare']),
  note: 'Värdena är oförändrade från förslaget. Ingen av dem band utfallet i cykel 1 eller 2 — '
    + 'de är godkända men fortfarande obeprövade mot verkligt material.',
});

const OUTCOMES = Object.freeze({
  CANDIDATE: 'HISTORICALLY_VALIDATED_CANDIDATE',
  INSUFFICIENT: 'INSUFFICIENT_EVIDENCE',
  REJECTED: 'REJECTED_BY_HISTORICAL_EVIDENCE',
});

function threshold(value, origin, rationale, source = null) {
  return Object.freeze({ value, origin, rationale, source });
}

const THRESHOLDS = Object.freeze({
  // ── urvalets storlek ──────────────────────────────────────────────────────
  minTrades: threshold(30, ORIGIN.PROJECT_DERIVED,
    'strategyScoreService.confidenceForSample behandlar under 30 affärer som lågt förtroende (52) och 30 som första användbara steget. '
    + 'learningConnectorService vägrar avge något omdöme alls under 10. En befordringsgrind ska använda det strängare av projektets två egna golv.',
    'src/services/strategyScoreService.js:83, src/services/learningConnectorService.js:488'),

  minTradingDays: threshold(20, ORIGIN.HUMAN_APPROVED,
    'Affärer räcker inte: 40 affärer på tre dagar är tre observationer av marknaden, inte 40. '
    + 'Kravet är att edgen ska ha visat sig under minst 20 skilda handelsdagar av research-periodens 119. '
    + 'Talet har ingen förlaga i koden och godkändes av en människa 2026-08-20.'),

  // ── research måste visa en edge ───────────────────────────────────────────
  researchProfitFactor: threshold(1.4, ORIGIN.PROJECT_DERIVED,
    'learningConnectorService befordrar vid profit factor >= 1.4. Ett lägre krav här hade betytt att research-lagret '
    + 'godkänner något som learning-lagret sedan vägrar befordra — två delar av samma system med olika svar på samma fråga.',
    'src/services/learningConnectorService.js:489'),

  researchNetPositive: threshold(0, ORIGIN.SIGN_TEST,
    'Nettot efter exekveringskostnad och courtage måste vara positivt. Detta är inte en nivå utan definitionen av att ha tjänat pengar. '
    + 'Cykel 1 och 2 producerade sex hypoteser med profit factor över 1 vars netto var negativt.'),

  // ── validation måste hålla ────────────────────────────────────────────────
  validationProfitFactor: threshold(1.25, ORIGIN.PROJECT_DERIVED,
    'researchScoreService.scoreProfitFactor har sin andra bandgräns vid 1.25 — projektets egen första nivå som räknas som '
    + 'meningsfullt över break-even. Out-of-sample får vara svagare än in-sample men inte marginell.',
    'src/services/researchScoreService.js:70'),

  validationNetPositive: threshold(0, ORIGIN.SIGN_TEST,
    'Samma teckentest på valideringsperioden. En hypotes vars out-of-sample-netto är negativt har inte visat att den bär sin egen kostnad.'),

  // ── försämring mellan perioderna ──────────────────────────────────────────
  minEdgeRetention: threshold(0.5, ORIGIN.HUMAN_APPROVED,
    'Mäts på edgen ÖVER break-even, alltså (PF - 1), inte på PF. Skillnaden är avgörande: 1.40 -> 1.20 ser ut som ett fall på 14 % '
    + 'men är en halvering av edgen. Kravet är att minst 50 % av research-edgen finns kvar i validation. '
    + 'Talet har ingen förlaga i koden och godkändes av en människa 2026-08-20.'),

  // ── drawdown ──────────────────────────────────────────────────────────────
  minRecoveryFactor: threshold(1.0, ORIGIN.SIGN_TEST,
    'recoveryFactor = resultat / största drawdown, ett mått biblioteket redan bokför per körning. Kravet 1.0 betyder att periodens '
    + 'resultat minst ska motsvara dess värsta nedgång. Under 1 tjänade hypotesen mindre än den som mest låg back — '
    + 'det är en gränsdragning i tecken, inte en vald nivå.'),

  // ── koncentration och robusthet ───────────────────────────────────────────
  maxTopDayShare: threshold(0.35, ORIGIN.HUMAN_APPROVED,
    'Andelen av periodens BRUTTOVINST som kommer från den enskilt bästa handelsdagen. Kommer mer än 35 % från en dag är resultatet '
    + 'en händelse, inte en edge. Räknas ur biblioteksrader som redan finns. Talet har ingen förlaga i koden och godkändes av en människa 2026-08-20.'),

  minPositiveDayShare: threshold(0.4, ORIGIN.HUMAN_APPROVED,
    'Andelen handelsdagar med positivt resultat. En hypotes som förlorar fyra dagar av fem och räddas av den femte är inte robust, '
    + 'oavsett vad summan säger. Talet har ingen förlaga i koden och godkändes av en människa 2026-08-20.'),
});

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
 * @param {boolean|null} passed  null = kunde inte mätas
 */
function check(id, passed, actual, limit, note = null) {
  return {
    id,
    passed: passed === true,
    // Skiljer "mätt och underkänd" från "gick inte att mäta". Båda hindrar en
    // befordran, men bara den första är ett nej. Se utfallsordningen nedan.
    measurable: passed !== null,
    actual: round(actual),
    limit,
    note,
  };
}

/**
 * Robusthet ur per-dygnsraderna.
 *
 * @param {Array<{strategyPnlUsd: number}>} dailyRows  biblioteksrader, en per dygn
 */
function robustnessOf(dailyRows = []) {
  const rows = dailyRows.map((row) => num(row.strategyPnlUsd)).filter((v) => v != null);
  if (!rows.length) {
    // Aldrig "godkänd för att den inte gick att mäta". En kontroll som inte
    // kunde köras är en kontroll som inte är uppfylld.
    return { available: false, tradingDays: 0, positiveDayShare: null, topDayShare: null };
  }
  const positives = rows.filter((v) => v > 0);
  const grossWin = positives.reduce((total, v) => total + v, 0);
  const best = positives.length ? Math.max(...positives) : 0;
  return {
    available: true,
    tradingDays: rows.length,
    positiveDayShare: round(positives.length / rows.length),
    // Delas noll ut på noll bruttovinst finns ingen vinst att koncentrera —
    // och då faller hypotesen ändå på teckentestet ovan.
    topDayShare: grossWin > 0 ? round(best / grossWin) : null,
  };
}

/**
 * Klassificerar en hypotes mot policyn.
 *
 * @param {object} input
 * @param {object} input.research    summarizeTrades-utfall för research-perioden
 * @param {object} input.validation  samma för validation-perioden
 * @param {Array}  [input.researchDailyRows]    biblioteksrader per dygn
 * @param {Array}  [input.validationDailyRows]
 * @returns {{outcome: string, checks: Array, ...}}
 */
function classify({
  research = null, validation = null, researchDailyRows = [], validationDailyRows = [],
  policyVersion = POLICY_VERSION,
} = {}) {
  if (!Object.values(POLICY_VERSIONS).includes(policyVersion)) {
    throw new Error(`unknown_research_evidence_policy_version:${policyVersion}`);
  }
  const checks = [];
  const T = THRESHOLDS;

  const rTrades = num(research?.trades) ?? 0;
  const vTrades = num(validation?.trades) ?? 0;
  const rPf = num(research?.profitFactor);
  const vPf = num(validation?.profitFactor);
  const rNet = num(research?.netPnlUsd);
  const vNet = num(validation?.netPnlUsd);
  const rDd = num(research?.maxDrawdownUsd);
  const vDd = num(validation?.maxDrawdownUsd);

  const rRobust = robustnessOf(researchDailyRows);
  const vRobust = robustnessOf(validationDailyRows);

  // ── steg 1: räcker underlaget? ────────────────────────────────────────────
  checks.push(check('research_min_trades', rTrades >= T.minTrades.value, rTrades, T.minTrades.value));
  checks.push(check('validation_min_trades', vTrades >= T.minTrades.value, vTrades, T.minTrades.value));
  checks.push(check('research_min_trading_days',
    rRobust.available && rRobust.tradingDays >= T.minTradingDays.value,
    rRobust.tradingDays, T.minTradingDays.value,
    rRobust.available ? null : 'per-dygnsrader saknas — kontrollen kunde inte köras'));

  const sampleChecks = checks.filter((row) => row.id.includes('min_trades') || row.id.includes('trading_days'));
  const sampleOk = sampleChecks.every((row) => row.passed);

  // ── steg 2: teckentest — visar bevisen en edge eller inte? ────────────────
  const MISSING = 'värdet saknas i underlaget — kontrollen kunde inte köras';
  const signChecks = [
    check('research_profit_factor_above_one', rPf == null ? null : rPf > 1, rPf, 1, rPf == null ? MISSING : null),
    check('research_net_positive', rNet == null ? null : rNet > T.researchNetPositive.value,
      rNet, T.researchNetPositive.value, rNet == null ? MISSING : null),
    check('validation_profit_factor_above_one', vPf == null ? null : vPf > 1, vPf, 1, vPf == null ? MISSING : null),
    check('validation_net_positive', vNet == null ? null : vNet > T.validationNetPositive.value,
      vNet, T.validationNetPositive.value, vNet == null ? MISSING : null),
  ];
  checks.push(...signChecks);
  const signMeasurable = signChecks.every((row) => row.measurable);
  const signOk = signChecks.every((row) => row.passed);

  // ── steg 3: magnitudkrav ──────────────────────────────────────────────────
  const rRecovery = (rDd != null && rDd > 0 && rNet != null) ? rNet / rDd : null;
  const vRecovery = (vDd != null && vDd > 0 && vNet != null) ? vNet / vDd : null;
  const retention = (rPf != null && vPf != null && rPf > 1)
    ? (vPf - 1) / (rPf - 1)
    : null;

  const magnitudeChecks = [
    check('research_profit_factor', rPf != null && rPf >= T.researchProfitFactor.value, rPf, T.researchProfitFactor.value),
    check('validation_profit_factor', vPf != null && vPf >= T.validationProfitFactor.value, vPf, T.validationProfitFactor.value),
    check('edge_retention', retention != null && retention >= T.minEdgeRetention.value, retention, T.minEdgeRetention.value),
    check('research_recovery_factor', rRecovery != null && rRecovery >= T.minRecoveryFactor.value, rRecovery, T.minRecoveryFactor.value),
    check('validation_recovery_factor', vRecovery != null && vRecovery >= T.minRecoveryFactor.value, vRecovery, T.minRecoveryFactor.value),
    check('research_top_day_share', rRobust.topDayShare != null && rRobust.topDayShare <= T.maxTopDayShare.value,
      rRobust.topDayShare, T.maxTopDayShare.value,
      rRobust.available ? null : 'per-dygnsrader saknas — kontrollen kunde inte köras'),
    check('research_positive_day_share', rRobust.positiveDayShare != null && rRobust.positiveDayShare >= T.minPositiveDayShare.value,
      rRobust.positiveDayShare, T.minPositiveDayShare.value,
      rRobust.available ? null : 'per-dygnsrader saknas — kontrollen kunde inte köras'),
  ];
  checks.push(...magnitudeChecks);
  const magnitudeOk = magnitudeChecks.every((row) => row.passed);

  // ── utfall ────────────────────────────────────────────────────────────────
  //
  // Ordningen är inte godtycklig. Ett litet urval får aldrig leda till
  // FÖRKASTAD: att förkasta en hypotes man inte mätte tillräckligt är att
  // kasta bort en möjlig sanning och kalla det ett resultat. Först när
  // underlaget räcker får ett negativt tecken betyda förkastad.
  let outcome;
  let reason;
  if (!sampleOk) {
    outcome = OUTCOMES.INSUFFICIENT;
    reason = 'sample_below_policy_minimum';
  } else if (!signMeasurable) {
    // Samma princip som för urvalet, en nivå ned: ett teckentest som inte gick
    // att köra är inte ett negativt tecken. Äldre biblioteksrader saknar
    // netPnlUsd, och att låta den luckan betyda FÖRKASTAD hade förvandlat en
    // bokföringsbrist till en dom över hypotesen.
    outcome = OUTCOMES.INSUFFICIENT;
    reason = 'sign_test_not_measurable';
  } else if (!signOk) {
    // ── Skiljer "ingen edge" från "edge som inte bär sin kostnad" ───────────
    //
    // Profit factor mäts på strategy edge, före exekveringskostnad och
    // courtage; nettot är efter. En hypotes som håller PF över 1 i BÅDA
    // perioderna men går back på nettot har visat att signalen fungerar och att
    // kostnaden äter den. Det är inte samma sak som att signalen inte finns,
    // och att kalla det förkastat slänger bort ett svar.
    //
    // Den blir ändå aldrig kandidat: nettokravet står kvar bland teckentesten
    // och en hypotes som förlorar pengar passerar inte grinden.
    const grossEdgeHolds = rPf != null && vPf != null && rPf > 1 && vPf > 1;
    const onlyNetFailed = signChecks
      .filter((row) => !row.passed)
      .every((row) => row.id.endsWith('_net_positive'));

    if (policyVersion === POLICY_VERSIONS.V2 && grossEdgeHolds && onlyNetFailed) {
      outcome = OUTCOMES.INSUFFICIENT;
      reason = 'gross_edge_holds_but_costs_are_not_carried';
    } else {
      outcome = OUTCOMES.REJECTED;
      reason = 'sufficient_sample_shows_no_edge';
    }
  } else if (!magnitudeOk) {
    // Tecknen är positiva men storleken bär inte. Hypotesen kan vara verklig —
    // bevisen räcker bara inte för att befordra den.
    outcome = OUTCOMES.INSUFFICIENT;
    reason = 'edge_present_but_below_policy_magnitude';
  } else {
    outcome = OUTCOMES.CANDIDATE;
    reason = 'all_policy_checks_passed';
  }

  return {
    policyVersion,
    outcome,
    reason,
    checks,
    failed: checks.filter((row) => !row.passed).map((row) => row.id),
    measured: {
      researchTrades: rTrades,
      validationTrades: vTrades,
      researchProfitFactor: rPf,
      validationProfitFactor: vPf,
      researchNetPnlUsd: rNet,
      validationNetPnlUsd: vNet,
      edgeRetention: round(retention),
      researchRecoveryFactor: round(rRecovery),
      validationRecoveryFactor: round(vRecovery),
      researchRobustness: rRobust,
      validationRobustness: vRobust,
    },
    ...SAFETY,
  };
}

/** Trösklarna som ännu inte är godkända av en människa. */
function listPendingHumanDecisions() {
  return Object.entries(THRESHOLDS)
    .filter(([, row]) => row.origin === ORIGIN.PROPOSED)
    .map(([name, row]) => ({ name, value: row.value, rationale: row.rationale }));
}

/** Policyn som den ska stå i en specifikation eller rapport. */
function describePolicy() {
  return {
    policyVersion: POLICY_VERSION,
    outcomes: Object.values(OUTCOMES),
    // Så länge något förslag är ogodkänt är policyn föreslagen, inte beslutad.
    status: listPendingHumanDecisions().length ? 'proposed_pending_human_approval' : 'approved',
    thresholds: Object.fromEntries(Object.entries(THRESHOLDS)
      .map(([name, row]) => [name, { value: row.value, origin: row.origin, source: row.source, rationale: row.rationale }])),
    pendingHumanDecisions: listPendingHumanDecisions(),
    approval: APPROVAL,
    metricsUsed: [
      'trades', 'profitFactor', 'netPnlUsd', 'maxDrawdownUsd',
      'recoveryFactor (netPnlUsd / maxDrawdownUsd)',
      'strategyPnlUsd per handelsdag (aggregerad ur befintliga biblioteksrader)',
    ],
    grantsNothing: 'klassificering endast — ingen runtime-behörighet, ingen Paper-behörighet',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  POLICY_VERSION,
  POLICY_VERSIONS,
  APPROVAL,
  ORIGIN,
  OUTCOMES,
  THRESHOLDS,
  classify,
  robustnessOf,
  describePolicy,
  listPendingHumanDecisions,
};
