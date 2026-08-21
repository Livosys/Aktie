'use strict';

// ── Executable Research Hypothesis ───────────────────────────────────────────
//
// Ett strategikoncept är inte en strategi. `low_volatility_breakout` finns i
// katalogen som ett NAMN och en mening ("Låg volatilitet -> breakout") — inte
// som en definition någon kan köra. Fjorton semantiska variabler är olösta, och
// föregående fas stannade korrekt: att välja värden åt dem, köra dem och sedan
// rapportera utfallet som kunskap om konceptet vore att uppfinna en strategi och
// kalla den forskning.
//
// Den här modulen löser det utan att bryta mot regeln. Skillnaden ligger i vad
// evidensen tillskrivs:
//
//   INTE:  "low_volatility_breakout ger 1,4 i profit factor"
//   UTAN:  "hypotes H001 av low_volatility_breakout — bbwPct120<=60,
//           20-bars range, relVol>=1,3 — ger 1,4 i profit factor på
//           research-perioden"
//
// H001 är en påstådd tolkning. Den kan förkastas utan att konceptet förkastas,
// och den kan överleva utan att konceptet därmed är validerat. Det är hela
// poängen med lagret: evidensen får en ägare som är exakt lika specifik som
// evidensen själv.
//
// ── Varje värde bär sin källa ───────────────────────────────────────────────
//
// Ingen parameter här är validerad. Varje enskilt värde är märkt
// HYPOTHESIS_ONLY och bär varifrån det kom — en befintlig indikatorprimitiv, en
// katalograd, en projektkonvention. Ett omärkt värde vore ett påstående utan
// avsändare, och det är precis den sortens tyst gissning fasen finns för att
// undvika.
//
// ── Vad hypotesen INTE får ──────────────────────────────────────────────────
//
// En hypotes får köras i Historical Replay och får skapa research evidence. Den
// får aldrig bli en Paper-signal, aldrig bli runtimeEligible och aldrig få
// Paper approval — oavsett hur bra siffrorna ser ut. Grindarna står i
// LIFECYCLE_GATES och läses av evaluatorn, inte av en kommentar.

const crypto = require('crypto');

const SAFETY = Object.freeze({
  readOnly: true,
  researchOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  real_orders_blocked: true,
  source: 'research_hypothesis',
});

const HYPOTHESIS_SCHEMA = 'executable-research-hypothesis-v1';

// ── Livscykel ────────────────────────────────────────────────────────────────
//
// Sju steg, och stegen är inte etiketter — de är grindar. Att en strategi står
// i ett visst steg avgör vad systemet får göra med den.
const LIFECYCLE = Object.freeze([
  'STRATEGY_CONCEPT',
  'RESEARCH_SPECIFICATION',
  'EXECUTABLE_RESEARCH_HYPOTHESIS',
  'HISTORICALLY_RESEARCHED',
  'HISTORICALLY_VALIDATED_CANDIDATE',
  'EXECUTABLE_RUNTIME_STRATEGY',
  'PAPER_ELIGIBLE',
]);

const LIFECYCLE_GATES = Object.freeze({
  // Ett namn och en mening. Ingenting går att köra.
  STRATEGY_CONCEPT: Object.freeze({
    replayAllowed: false, researchEvidenceAllowed: false, runtimeEligible: false, paperEligible: false,
  }),
  // Variablerna är kartlagda och märkta olösta. Fortfarande inget körbart.
  RESEARCH_SPECIFICATION: Object.freeze({
    replayAllowed: false, researchEvidenceAllowed: false, runtimeEligible: false, paperEligible: false,
  }),
  // En explicit, versionerad tolkning. Får köras historiskt — men bara där.
  EXECUTABLE_RESEARCH_HYPOTHESIS: Object.freeze({
    replayAllowed: true, researchEvidenceAllowed: true, runtimeEligible: false, paperEligible: false,
  }),
  // Har evidens från research-perioden. Ännu inte prövad mot validation.
  HISTORICALLY_RESEARCHED: Object.freeze({
    replayAllowed: true, researchEvidenceAllowed: true, runtimeEligible: false, paperEligible: false,
  }),
  // Överlevde validation på oberoende kontrakt. Fortfarande inte runtime:
  // steget dit är en implementation, inte en befordran.
  HISTORICALLY_VALIDATED_CANDIDATE: Object.freeze({
    replayAllowed: true, researchEvidenceAllowed: true, runtimeEligible: false, paperEligible: false,
  }),
  EXECUTABLE_RUNTIME_STRATEGY: Object.freeze({
    replayAllowed: true, researchEvidenceAllowed: true, runtimeEligible: true, paperEligible: false,
  }),
  PAPER_ELIGIBLE: Object.freeze({
    replayAllowed: true, researchEvidenceAllowed: true, runtimeEligible: true, paperEligible: true,
  }),
});

// Märkningen. Ett värde utan den här stämpeln får inte finnas i en hypotes.
const VALUE_MARKINGS = Object.freeze({
  HYPOTHESIS_ONLY: 'HYPOTHESIS_ONLY',
  // Reserverad. Sätts först när historisk evidens finns — aldrig här.
  VALIDATED: 'VALIDATED',
});

// Vilken forskningscykel en hypotes tillhör. Cykel 1 är avslutad och behålls
// oförändrad — dess evidens skulle bli oläsbar om hypoteserna ändrades i
// efterhand. Cykel 2 är en NY uppsättning, inte en revidering.
const CYCLES = Object.freeze({ ONE: 'cycle1', TWO: 'cycle2' });

const VARIABLE_STATUS = Object.freeze({
  HYPOTHESIZED: 'HYPOTHESIZED',
  NOT_TESTABLE_WITH_CURRENT_DATA: 'NOT_TESTABLE_WITH_CURRENT_DATA',
  FIXED_RESEARCH_CONSTANT: 'FIXED_RESEARCH_CONSTANT',
});

// Prefixet gör läckage synligt. Ett research-id som dyker upp i paper, i
// approvals eller i en runtime-lista går inte att missa i en logg.
const RESEARCH_ID_PREFIX = 'research__';

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * Hypotesens identitet.
 *
 * Hashen räknas på SEMANTIKEN — signalregler, entry, exit, timeframe, session,
 * rötter — och inte på beskrivande fält som rationale eller källtext. Två
 * hypoteser med samma regler ÄR samma hypotes även om någon skrivit om
 * motiveringen, och det är den egenskapen som gör att AI Memory kan känna igen
 * ett redan kört experiment.
 */
function hypothesisHash(semantics) {
  return sha(`${HYPOTHESIS_SCHEMA}::${canonicalJson(semantics)}`);
}

function value(v, source, { status = VARIABLE_STATUS.HYPOTHESIZED } = {}) {
  return Object.freeze({
    value: v,
    marking: VALUE_MARKINGS.HYPOTHESIS_ONLY,
    status,
    source,
  });
}

// ── Källor ───────────────────────────────────────────────────────────────────
//
// Alla tre är befintliga i projektet. Inget värde här är hämtat utifrån.
const SOURCES = Object.freeze({
  INDICATOR_PRIMITIVE: 'src/scanner/indicators.js (befintlig native futures indicator-primitiv)',
  CATALOG_DEFAULT: 'daytradingStrategyCatalogService default_options (katalogens deklarerade förval)',
  CATALOG_SIGNAL_DIGEST: 'daytradingStrategyCatalogService signalDigest (katalogens egen konceptbeskrivning)',
  ENGINE_CONVENTION: 'nativeReplayEngineService DEFAULTS (befintlig motorkonvention)',
  // Cykel 2:s egna värden kommer inte ur en katalog utan ur cykel 1:s mätning.
  // Det gör dem inte validerade — de är fortfarande HYPOTHESIS_ONLY — men de
  // har en starkare härkomst än en förlaga någon skrev en gång.
  CYCLE1_MEASUREMENT: 'AI Factory Historical Research Cycle 1 (2026-08-20), mätt på 218 exact-contract trading days',
});

// ── Fast research-exit ───────────────────────────────────────────────────────
//
// Broker Risk kräver stop loss (ibPaperBrokerRiskService: stop_loss_required).
// En helt neutral exit — stopLoss=null, takeProfit=null, allt stängs på
// window_end — är därför INTE körbar utan att ändra en modul som också styr
// paper och live. Det ändrar vi inte.
//
// I stället pinnas exiten till katalogens EGNA deklarerade förval för konceptet
// och hålls IDENTISK för samtliga hypoteser i samma batch. Konsekvensen ska
// sägas rakt ut: batchen mäter RELATIV signalkvalitet mellan hypoteser under en
// konstant exit. Den mäter inte absolut handelsbarhet, och exit-parametrarna är
// inte prövade — de är konstanthållna. Se DEL B4: exit-optimering ligger utanför
// den här experimentfamiljen.
function fixedResearchExit(catalogDefaults) {
  return Object.freeze({
    stopLossPct: value(catalogDefaults.stopLossPct, SOURCES.CATALOG_DEFAULT, {
      status: VARIABLE_STATUS.FIXED_RESEARCH_CONSTANT,
    }),
    takeProfitR: value(catalogDefaults.takeProfitR, SOURCES.CATALOG_DEFAULT, {
      status: VARIABLE_STATUS.FIXED_RESEARCH_CONSTANT,
    }),
    holdingTimeMin: value(catalogDefaults.holdingTimeMin, SOURCES.CATALOG_DEFAULT, {
      status: VARIABLE_STATUS.FIXED_RESEARCH_CONSTANT,
    }),
    policy: 'fixed_catalog_exit_constant_across_batch',
  });
}

const CATALOG_DEFAULTS = Object.freeze({
  low_volatility_breakout: Object.freeze({ stopLossPct: 0.18, takeProfitR: 1.9, holdingTimeMin: 16 }),
  volume_spike_momentum: Object.freeze({ stopLossPct: 0.2, takeProfitR: 1.6, holdingTimeMin: 7 }),
});

// ── Hypotesrymden ────────────────────────────────────────────────────────────
//
// Liten och avgränsad, enligt DEL B4. Sex hypoteser per koncept, alla i
// SIGNALdimensionerna. Att pröva fjorton variabler samtidigt hade inte gett
// fjorton svar — det hade gett ett moln utan förklaringsvärde.
//
// Varje hypotes ändrar FÅ saker mot H001, så en skillnad i utfall går att
// tillskriva något.

const LOW_VOLATILITY_BREAKOUT_HYPOTHESES = Object.freeze([
  { id: 'H001', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 20, volumeThreshold: 1.3, timeframe: '2m', session: 'full_window',
    rationale: 'Referenshypotes: katalogens signalDigest low_volatility_regime|tight_range|range_break läst rakt av mot befintliga primitiver.' },
  { id: 'H002', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 40, compressionWindow: 20, volumeThreshold: 1.3, timeframe: '2m', session: 'full_window',
    rationale: 'Hårdare kompressionskrav. Isolerar om "låg volatilitet" måste vara extremt låg för att breakouten ska bära.' },
  { id: 'H003', volatilityEstimator: 'atr_pct_120', compressionThreshold: 60, compressionWindow: 20, volumeThreshold: 1.3, timeframe: '2m', session: 'full_window',
    rationale: 'Byter volatilitetsestimator mot ATR-percentil. Isolerar om valet av estimator spelar roll.' },
  { id: 'H004', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 40, volumeThreshold: 1.3, timeframe: '2m', session: 'full_window',
    rationale: 'Dubbelt range-fönster. Isolerar hur "tight range" ska mätas.' },
  { id: 'H005', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 20, volumeThreshold: 1.0, timeframe: '2m', session: 'full_window',
    rationale: 'Volymbekräftelsen avstängd i praktiken. Isolerar om volymkravet bidrar eller bara minskar urvalet.' },
  { id: 'H006', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 20, volumeThreshold: 1.3, timeframe: '5m', session: 'full_window',
    rationale: 'Samma regler på 5m — katalogens egen timeframeFocus för konceptet.' },
]);

const VOLUME_SPIKE_MOMENTUM_HYPOTHESES = Object.freeze([
  { id: 'H001', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 0.8, followThrough: 'close_beyond_previous_close', timeframe: '2m', session: 'full_window',
    rationale: 'Referenshypotes: katalogens signalDigest relative_volume_spike|fast_price_expansion läst rakt av.' },
  { id: 'H002', relativeVolumeThreshold: 3.0, priceExpansionThreshold: 0.8, followThrough: 'close_beyond_previous_close', timeframe: '2m', session: 'full_window',
    rationale: 'Hårdare volymspik. Isolerar om spiken måste vara extrem.' },
  { id: 'H003', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 1.5, followThrough: 'close_beyond_previous_close', timeframe: '2m', session: 'full_window',
    rationale: 'Hårdare priceexpansion. Isolerar om rörelsen måste vara stor relativt ATR.' },
  { id: 'H004', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 0.8, followThrough: 'none', timeframe: '2m', session: 'full_window',
    rationale: 'Follow-through-kravet borttaget. Isolerar om bekräftelsen bidrar.' },
  { id: 'H005', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 0.8, followThrough: 'close_beyond_previous_close', timeframe: '2m', session: 'us_open_only',
    rationale: 'Endast första två timmarna. Volymspikar är sessionsberoende; isolerar sessionsvariabeln.' },
  { id: 'H006', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 0.8, followThrough: 'close_beyond_previous_close', timeframe: '5m', session: 'full_window',
    rationale: 'Samma regler på 5m. Isolerar timeframe-variabeln.' },
]);

// ── Cykel 2 ──────────────────────────────────────────────────────────────────
//
// Cykel 1 gav fyra mätta svar, och cykel 2 följer dem i stället för att bredda:
//
//   · follow-through bar noll information (0 av 145 avvisade) → borttagen helt
//   · sessionen 13:30–15:30Z var enda filtret som förbättrade i BÅDA perioderna
//     → fast för samtliga VSM-hypoteser, inte längre en variabel
//   · courtaget är konstant 2,44 USD/affär; EXEKVERINGSkostnaden varierar
//     (2,50–3,76 på research, 4,50–6,18 på validation) → entry timing blir
//     den nya dimensionen
//   · för LVB är det BREAKOUT-kvalificeringen som stryper flödet, inte
//     kompressionen: 8,5 % av barerna passerar bbwPct120<=60, men bara 8,1 % av
//     DEM bryter sitt 20-barsintervall. Volymfiltret tar bort 18 % och är
//     därmed nästan verkningslöst.
//
// Inga breda grid searchar. Varje hypotes ändrar EN sak mot sin referens, så en
// skillnad i utfall går att tillskriva något.

// Entrymodellen mätt på 314 spikar över 30 research-dagar:
//   nästa bars stängning ligger i genomsnitt +0,79 punkter I signalens riktning
//   → att bara vänta KOSTAR edge och prövas därför inte
//   bar +2 ligger på −0,14 → rörelsen är slut
//   retracering >=25 % av spikkroppen inom 3 barer: 74,8 % av spikarna
//   retracering >=50 %: 64,3 %
// Ett bättre INSTIEGSPRIS finns alltså, men bara bakåt — inte genom att vänta.
const VOLUME_SPIKE_MOMENTUM_CYCLE2 = Object.freeze([
  { id: 'H101', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 0.8, followThrough: 'none',
    entryModel: 'signal_bar_close', timeframe: '2m', session: 'us_open_only',
    rationale: 'Referens för cykel 2: cykel 1:s bästa hypotes (H005) med follow-through borttagen, eftersom regeln mättes till noll informationsvärde.' },
  { id: 'H102', relativeVolumeThreshold: 2.5, priceExpansionThreshold: 0.8, followThrough: 'none',
    entryModel: 'signal_bar_close', timeframe: '2m', session: 'us_open_only',
    rationale: 'Hårdare volymkrav. Courtaget är fast per affär, så färre och bättre affärer är en väg till kostnadsöverlevnad som inte rör exekveringen.' },
  { id: 'H103', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 1.2, followThrough: 'none',
    entryModel: 'signal_bar_close', timeframe: '2m', session: 'us_open_only',
    rationale: 'Större prisexpansion. Isolerar om en större förväntad rörelse bär den fasta kostnaden bättre.' },
  { id: 'H104', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 0.8, followThrough: 'none',
    entryModel: 'pullback_fraction_of_spike_body', pullbackFraction: 0.25, pullbackWindowBars: 3,
    timeframe: '2m', session: 'us_open_only',
    rationale: 'Entry timing: gå in när priset återvänt 25 % av spikkroppen i stället för att jaga spikens stängning. Mätt fyllnadsgrad 74,8 %.' },
  { id: 'H105', relativeVolumeThreshold: 2.0, priceExpansionThreshold: 0.8, followThrough: 'none',
    entryModel: 'pullback_fraction_of_spike_body', pullbackFraction: 0.50, pullbackWindowBars: 3,
    timeframe: '2m', session: 'us_open_only',
    rationale: 'Djupare retracering ger bättre pris men färre tillfällen. Mätt fyllnadsgrad 64,3 %.' },
]);

// Breakout-kvalificeringarnas täthet, mätt på de 406 barer av 4 800 som
// passerar bbwPct120<=60:
//   close bortom high/low(20)      33  =  8,1 %   (cykel 1:s regel)
//   close bortom CLOSE-range(20)   78  = 19,2 %
//   close inom 0,15 ATR av (20)    53  = 13,1 %
//   close bortom high/low(10)      54  = 13,3 %
// atrPct120<=60 i cykel 1 passerade 0,6 % av alla barer mot bbw:s 8,5 % — de
// två måtten har inte samma skala, så H003 prövade ett mycket strängare
// regimfilter i stället för frågan "spelar estimatorn roll". Percentilen som
// ger SAMMA selektivitet som bbw<=60 är atrPct120<=89, och det är den siffran
// cykel 2 använder.
//
// Referensen är cykel 1:s H001 och står MEDVETET inte med här. Samma regler ger
// samma hypothesisHash — en H101 med identisk semantik hade varit samma hypotes
// under ett annat namn, och att köra den igen hade betalat compute för ett svar
// som redan finns (98 affärer, PF 0,530 på research).
const LOW_VOLATILITY_BREAKOUT_CYCLE2 = Object.freeze([
  { id: 'H102', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 20,
    breakoutRule: 'close_beyond_rolling_close_range', volumeThreshold: 1.3, timeframe: '2m', session: 'full_window',
    rationale: 'Intervallet mäts på stängningar i stället för på high/low. Mätt 2,4 gånger tätare — den enskilt största täthetsvinsten.' },
  { id: 'H103', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 10,
    breakoutRule: 'close_beyond_rolling_range_of_window', volumeThreshold: 1.3, timeframe: '2m', session: 'full_window',
    rationale: 'Kortare intervall. Cykel 1 visade att ett BREDARE fönster gav färre brott (40 bars: 18 mot 20 bars 33), så riktningen prövas åt andra hållet.' },
  { id: 'H104', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 20,
    breakoutRule: 'close_within_atr_tolerance_of_range', breakoutToleranceAtr: 0.15, volumeThreshold: 1.3,
    timeframe: '2m', session: 'full_window',
    rationale: 'Tolerans i stället för strikt olikhet: en exakt gräns på tickdata är godtycklig. Mätt 1,6 gånger tätare.' },
  { id: 'H105', volatilityEstimator: 'atr_pct_120', compressionThreshold: 89, compressionWindow: 20,
    breakoutRule: 'close_beyond_rolling_range_of_window', volumeThreshold: 1.3, timeframe: '2m', session: 'full_window',
    rationale: 'Estimatorfrågan som cykel 1:s H003 inte lyckades ställa: atrPct120 vid den tröskel som ger samma selektivitet som bbwPct120<=60.' },
  { id: 'H106', volatilityEstimator: 'bbw_pct_120', compressionThreshold: 60, compressionWindow: 20,
    breakoutRule: 'close_beyond_rolling_range_of_window', volumeThreshold: null, timeframe: '2m', session: 'full_window',
    rationale: 'Volymbekräftelsen helt borttagen. Cykel 1 mätte att den bara tar bort 18 % — hypotesen prövar om den bidrar med något alls.' },
]);

// Variabler som inte går att pröva med den historik som finns. De ska stå
// KVAR i hypotesen som uttryckligen otestbara — att tyst utelämna dem hade
// gjort en reducerad hypotes oskiljbar från en fullständig.
const NOT_TESTABLE = Object.freeze({
  low_volatility_breakout: Object.freeze([]),
  volume_spike_momentum: Object.freeze([
    Object.freeze({
      variable: 'spreadMeasure',
      status: VARIABLE_STATUS.NOT_TESTABLE_WITH_CURRENT_DATA,
      evidence: 'historiska barer bär ts,t,open,high,low,close,volume,tradeCount,source,conId,localSymbol,expiry — ingen bid, ask eller spread',
      // Konsekvensen, uttryckligen: spread_not_extreme är en GRIND, inte en
      // signalgenerator. Att ta bort den gör hypotesen mer tillåtande än
      // konceptet, aldrig mindre. Utfallet är därför en undre gräns med känd
      // riktning på felet: verklig exekvering i breda spreadar är sämre än vad
      // den här hypotesen visar.
      semanticConsequence: 'reduced_hypothesis_is_strictly_more_permissive_than_concept',
      syntheticSpreadFromOhlc: 'refused_not_canonical_policy',
    }),
  ]),
});

const CONCEPTS = Object.freeze({
  low_volatility_breakout: Object.freeze({
    concept: Object.freeze(['low_volatility_regime', 'tight_range', 'range_break', 'volume_expansion']),
    researchSpecVersion: 'strategy-research-spec-v1',
    hypotheses: Object.freeze({
      [CYCLES.ONE]: LOW_VOLATILITY_BREAKOUT_HYPOTHESES,
      [CYCLES.TWO]: LOW_VOLATILITY_BREAKOUT_CYCLE2,
    }),
  }),
  volume_spike_momentum: Object.freeze({
    concept: Object.freeze(['relative_volume_spike', 'fast_price_expansion', 'spread_not_extreme', 'follow_through_required']),
    researchSpecVersion: 'strategy-research-spec-v1',
    hypotheses: Object.freeze({
      [CYCLES.ONE]: VOLUME_SPIKE_MOMENTUM_HYPOTHESES,
      [CYCLES.TWO]: VOLUME_SPIKE_MOMENTUM_CYCLE2,
    }),
  }),
});

const STRATEGY_IDS = Object.freeze(Object.keys(CONCEPTS));

/** Sessionfönstren, uttryckta i UTC-minuter. Inga andra finns. */
const SESSIONS = Object.freeze({
  full_window: Object.freeze({ fromUtc: '13:00', toUtc: '17:00' }),
  us_open_only: Object.freeze({ fromUtc: '13:30', toUtc: '15:30' }),
});

function signalSemanticsFor(strategyId, row) {
  if (strategyId === 'low_volatility_breakout') {
    return {
      kind: 'compression_range_break',
      volatilityEstimator: row.volatilityEstimator,
      compressionThreshold: row.compressionThreshold,
      compressionWindow: row.compressionWindow,
      // Cykel 1 hade bara en breakout-regel och skrev den som en konstant.
      // Cykel 2 gör den till en variabel — det var den som ströp flödet.
      breakoutRule: row.breakoutRule || 'close_beyond_rolling_range_of_window',
      // null = ingen volymbekräftelse alls. Skilj det från 1.0, som är ett
      // krav som råkar släppa igenom nästan allt.
      volumeRule: row.volumeThreshold == null ? 'none' : 'rel_vol_20_at_or_above_threshold',
      volumeThreshold: row.volumeThreshold ?? null,
      direction: 'both',
      // Nya fält läggs till ENDAST när de bär ett värde. Ett fält som alltid
      // finns med — även som null — ändrar hashen för varje äldre hypotes.
      ...(row.breakoutToleranceAtr == null ? {} : { breakoutToleranceAtr: row.breakoutToleranceAtr }),
    };
  }
  return {
    kind: 'relative_volume_expansion',
    relativeVolumeSource: 'rel_vol_20',
    relativeVolumeThreshold: row.relativeVolumeThreshold,
    priceExpansionMeasure: 'abs_body_over_atr14',
    priceExpansionThreshold: row.priceExpansionThreshold,
    followThroughRule: row.followThrough,
    direction: 'both',
    // Samma regel som ovan: entrymodellen skrivs bara ut när den avviker från
    // motorns förval, så cykel 1:s semantik är byte-identisk med före.
    ...(row.entryModel && row.entryModel !== 'signal_bar_close'
      ? {
        entryModel: row.entryModel,
        pullbackFraction: row.pullbackFraction,
        pullbackWindowBars: row.pullbackWindowBars,
      }
      : {}),
  };
}

function variableSourcesFor(strategyId, row) {
  const common = {
    timeframe: value(row.timeframe, SOURCES.ENGINE_CONVENTION),
    session: value(row.session, SOURCES.ENGINE_CONVENTION),
  };
  if (strategyId === 'low_volatility_breakout') {
    return Object.freeze({
      ...common,
      volatilityEstimator: value(row.volatilityEstimator, SOURCES.INDICATOR_PRIMITIVE),
      compressionThreshold: value(row.compressionThreshold, SOURCES.INDICATOR_PRIMITIVE),
      compressionWindow: value(row.compressionWindow, SOURCES.CATALOG_SIGNAL_DIGEST),
      breakoutRule: value(row.breakoutRule || 'close_beyond_rolling_range_of_window',
        row.breakoutRule ? SOURCES.CYCLE1_MEASUREMENT : SOURCES.CATALOG_SIGNAL_DIGEST),
      volumeThreshold: value(row.volumeThreshold ?? null, SOURCES.INDICATOR_PRIMITIVE),
    });
  }
  return Object.freeze({
    ...common,
    relativeVolumeSource: value('rel_vol_20', SOURCES.INDICATOR_PRIMITIVE),
    relativeVolumeThreshold: value(row.relativeVolumeThreshold, SOURCES.CATALOG_SIGNAL_DIGEST),
    priceExpansionMeasure: value('abs_body_over_atr14', SOURCES.INDICATOR_PRIMITIVE),
    priceExpansionThreshold: value(row.priceExpansionThreshold, SOURCES.INDICATOR_PRIMITIVE),
    followThroughRule: value(row.followThrough, SOURCES.CATALOG_SIGNAL_DIGEST),
    entryModel: value(row.entryModel || 'signal_bar_close',
      row.entryModel && row.entryModel !== 'signal_bar_close'
        ? SOURCES.CYCLE1_MEASUREMENT : SOURCES.ENGINE_CONVENTION),
  });
  // variableSources ingår inte i hashen (bara semantics gör det), så en ny
  // källrad här kan aldrig flytta en befintlig identitet.
}

function buildHypothesis(strategyId, row, cycle = CYCLES.ONE) {
  const concept = CONCEPTS[strategyId];
  if (!concept) throw new Error(`unknown_research_strategy:${strategyId}`);
  const exit = fixedResearchExit(CATALOG_DEFAULTS[strategyId]);
  const signal = signalSemanticsFor(strategyId, row);

  // Semantiken — och BARA den — går in i hashen.
  // cykeln står MEDVETET inte här. Den är härkomst, inte semantik — och hade
  // den ingått skulle varje cykel-1-hash ha ändrats när cykel 2 lades till,
  // vilket hade gjort cykel 1:s redan bokförda experimentidentiteter
  // oigenkännliga för AI Memory.
  const semantics = {
    strategyId,
    signal,
    entry: { model: 'market_on_signal_bar_close', priceSource: 'signal_bar_close' },
    exit: {
      policy: exit.policy,
      stopLossPct: exit.stopLossPct.value,
      takeProfitR: exit.takeProfitR.value,
      holdingTimeMin: exit.holdingTimeMin.value,
    },
    timeframe: row.timeframe,
    session: row.session,
    roots: ['MES', 'MNQ'],
    notTestable: (NOT_TESTABLE[strategyId] || []).map((r) => r.variable),
  };
  const hash = hypothesisHash(semantics);

  return Object.freeze({
    schema: HYPOTHESIS_SCHEMA,
    strategyId,
    cycle,
    researchSpecVersion: concept.researchSpecVersion,
    hypothesisId: row.id,
    hypothesisVersion: 'v1',
    hypothesisHash: hash,
    // Id:t som replay, biblioteket och AI Memory ser. Bär prefix, koncept och
    // hypotesnummer — läsbart utan uppslagning och omöjligt att förväxla med en
    // runtime-strategi. Cykeln behöver inte stå i id:t: numren är disjunkta
    // (H0xx i cykel 1, H1xx i cykel 2), så id:t förblir stabilt om en hypotes
    // någon gång skulle behöva refereras över cykelgränsen.
    researchStrategyId: `${RESEARCH_ID_PREFIX}${strategyId}__${row.id}`,
    concept: concept.concept,
    semantics,
    signal,
    session: SESSIONS[row.session],
    exit,
    variableSources: variableSourcesFor(strategyId, row),
    notTestable: NOT_TESTABLE[strategyId] || [],
    rationale: row.rationale,
    status: 'EXECUTABLE_RESEARCH_HYPOTHESIS',
    gates: LIFECYCLE_GATES.EXECUTABLE_RESEARCH_HYPOTHESIS,
    researchOnly: true,
    executable: false,
    runtimeEligible: false,
    paperEligible: false,
    ...SAFETY,
  });
}

/**
 * @param {string|null} strategyId  begränsa till ett koncept
 * @param {object} [options]
 * @param {string|null} [options.cycle]  begränsa till en forskningscykel
 */
function listHypotheses(strategyId = null, { cycle = null } = {}) {
  const ids = strategyId ? [strategyId] : STRATEGY_IDS;
  const cycles = cycle ? [cycle] : Object.values(CYCLES);
  for (const name of cycles) {
    if (!Object.values(CYCLES).includes(name)) throw new Error(`unknown_research_cycle:${name}`);
  }
  const out = [];
  for (const id of ids) {
    const concept = CONCEPTS[id];
    if (!concept) throw new Error(`unknown_research_strategy:${id}`);
    for (const name of cycles) {
      for (const row of concept.hypotheses[name] || []) out.push(buildHypothesis(id, row, name));
    }
  }
  return out;
}

function getHypothesis(researchStrategyId) {
  const id = text(researchStrategyId);
  return listHypotheses().find((row) => row.researchStrategyId === id) || null;
}

function isResearchStrategyId(strategyId) {
  return typeof strategyId === 'string' && strategyId.startsWith(RESEARCH_ID_PREFIX);
}

/** Grindarna för ett livscykelsteg. Kastar hellre än gissar. */
function gatesFor(stage) {
  const gates = LIFECYCLE_GATES[text(stage)];
  if (!gates) throw new Error(`unknown_research_lifecycle_stage:${stage}`);
  return gates;
}

module.exports = {
  SAFETY,
  HYPOTHESIS_SCHEMA,
  CYCLES,
  LIFECYCLE,
  LIFECYCLE_GATES,
  VALUE_MARKINGS,
  VARIABLE_STATUS,
  RESEARCH_ID_PREFIX,
  SESSIONS,
  SOURCES,
  STRATEGY_IDS,
  CATALOG_DEFAULTS,
  hypothesisHash,
  listHypotheses,
  getHypothesis,
  isResearchStrategyId,
  gatesFor,
  _internal: { canonicalJson, buildHypothesis, CONCEPTS, NOT_TESTABLE },
};
