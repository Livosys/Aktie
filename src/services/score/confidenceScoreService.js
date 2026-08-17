'use strict';

// ── Confidence Score ─────────────────────────────────────────────────────────
//
// Strategy Score svarar på "hur bra ÄR strategin?".
// Confidence Score svarar på "hur mycket VET vi om den?".
//
// De två får aldrig blandas ihop, för de kan peka åt rakt motsatta håll och det
// är just då svaret betyder något. En strategi med tolv affärer under en enda
// eftermiddag i en enda marknadsregim kan ha perfekt Strategy Score och nästan
// ingenting bakom sig. Att slå ihop måtten skulle dölja exakt den situationen —
// och det är den situationen som förstör riktiga pengar.
//
// Fem faktorer, var och en ett svar på "hur skulle den här strategin kunna lura
// oss?":
//
//   trades       Ett litet urval kan se ut som vad som helst.
//   regimes      En trendföljare i en trendande vecka bevisar ingenting om
//                strategin — bara om veckan.
//   months       Kalendertid fångar sådant som antal affärer inte gör:
//                säsong, kontraktsrullning, förändrad volatilitetsregim.
//   stability    Ett bra snitt kan vara en enda lysande period och tre usla.
//                Här mäts spridningen MELLAN perioder, inte inom dem.
//   outOfSample  Resultat på data strategin inte formats efter. Den enda
//                faktorn som är svår att lura sig själv med.
//
// Confidence räknas på Strategy Edge, precis som Strategy Score — exekveringens
// bidrag hör hemma i Execution Score och skulle här bara vara brus.
//
// Ren beräkning: ingen IO, ingen klocka.

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const SCORE_VERSION = 'confidence_score_v1';

const CONFIDENCE_MAX = Object.freeze({
  trades: 30,
  regimes: 20,
  months: 15,
  stability: 20,
  outOfSample: 15,
});

// Full poäng vid dessa nivåer. Grova med flit — en finare kalibrering kräver
// utfall att mäta emot, och att gissa exakt nu vore att låtsas veta mer än vi
// gör.
const TARGETS = Object.freeze({
  trades: 100,
  regimes: 3,
  months: 3,
  outOfSampleTrades: 30,
});

// Under den här nivån är strategin inte tillräckligt känd för att bli Candidate,
// hur bra Strategy Score än ser ut. Det är hela poängen med måttet.
const CANDIDATE_CONFIDENCE_FLOOR = 40;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function monthKey(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 7) : null;
}

/**
 * Spridning mellan perioder, som 0–1 där 1 är helt jämnt.
 *
 * Mäts på andelen vinnande affärer per månad. En strategi som gör +100 en
 * månad och -100 nästa har samma snitt som en som gör 0 båda — men de är inte
 * samma strategi, och det är skillnaden det här måttet finns för att fånga.
 */
function periodStability(buckets) {
  const rates = [...buckets.values()]
    .filter((rows) => rows.length >= 3)
    .map((rows) => rows.filter((row) => Number(row.strategyPnlUsd) > 0).length / rows.length);
  if (rates.length < 2) return { value: null, periods: rates.length };

  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((total, rate) => total + (rate - mean) ** 2, 0) / rates.length;
  const stdDev = Math.sqrt(variance);
  // 0 spridning = 1,0. En standardavvikelse på 0,35 i träffsäkerhet mellan
  // månader räknas som helt instabilt.
  return { value: clamp(1 - (stdDev / 0.35), 0, 1), periods: rates.length, stdDev: round(stdDev, 4), meanWinRate: round(mean, 4) };
}

/**
 * @param {object[]} trades          stängda affärer med strategyPnlUsd och closedAt
 * @param {object}   context
 * @param {string[]} [context.marketClassifications]  regimer strategin prövats i
 * @param {object[]} [context.outOfSampleTrades]      affärer på data den inte formats efter
 */
function calculateConfidenceScore(trades = [], context = {}) {
  const scored = trades.filter((row) => num(row.strategyPnlUsd) != null);
  const components = {};

  if (!scored.length) {
    return {
      total: 0,
      components: Object.fromEntries(Object.keys(CONFIDENCE_MAX).map((k) => [k, 0])),
      max: { ...CONFIDENCE_MAX },
      band: 'unknown',
      evidence: { trades: 0, regimes: 0, months: 0, outOfSampleTrades: 0 },
      meetsCandidateFloor: false,
      candidateFloor: CANDIDATE_CONFIDENCE_FLOOR,
      reason: 'no_trades',
      version: SCORE_VERSION,
      ...SAFETY,
    };
  }

  // ── urvalsstorlek ─────────────────────────────────────────────────────────
  // Kvadratroten: de första affärerna lär oss mest, och den hundrade lär oss
  // mindre än den tionde. En linjär skala hade gjort 50 affärer till "halva
  // sanningen", vilket överskattar vad 50 affärer säger.
  components.trades = round(
    CONFIDENCE_MAX.trades * clamp(Math.sqrt(scored.length / TARGETS.trades), 0, 1),
  );

  // ── marknadsregimer ───────────────────────────────────────────────────────
  const regimes = new Set(
    (context.marketClassifications || [])
      .filter(Boolean)
      .filter((value) => value !== 'unknown'),
  );
  components.regimes = round(
    CONFIDENCE_MAX.regimes * clamp(regimes.size / TARGETS.regimes, 0, 1),
  );

  // ── kalendertid ───────────────────────────────────────────────────────────
  const buckets = new Map();
  for (const row of scored) {
    const key = monthKey(row.closedAt || row.openedAt);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  components.months = round(
    CONFIDENCE_MAX.months * clamp(buckets.size / TARGETS.months, 0, 1),
  );

  // ── stabilitet mellan perioder ────────────────────────────────────────────
  const stability = periodStability(buckets);
  // Går stabiliteten inte att mäta ges NOLL, inte halva poängen. Att inte veta
  // är inte samma sak som att veta att det är medelbra.
  components.stability = stability.value == null
    ? 0
    : round(CONFIDENCE_MAX.stability * stability.value);

  // ── out-of-sample ─────────────────────────────────────────────────────────
  const oos = (context.outOfSampleTrades || []).filter((row) => num(row.strategyPnlUsd) != null);
  components.outOfSample = round(
    CONFIDENCE_MAX.outOfSample * clamp(oos.length / TARGETS.outOfSampleTrades, 0, 1),
  );

  const total = round(Object.values(components).reduce((a, b) => a + b, 0));

  return {
    total,
    components,
    max: { ...CONFIDENCE_MAX },
    band: total >= 70 ? 'well_understood'
      : total >= 40 ? 'partially_understood'
        : total >= 15 ? 'thin' : 'unknown',
    evidence: {
      trades: scored.length,
      regimes: regimes.size,
      regimeList: [...regimes].sort(),
      months: buckets.size,
      monthList: [...buckets.keys()].sort(),
      outOfSampleTrades: oos.length,
      periodStability: stability,
    },
    // Grinden mot Candidate. Promotion Engine läser den; måttet avgör inte
    // självt, men utan den kan ingen strategi bli Candidate.
    meetsCandidateFloor: total >= CANDIDATE_CONFIDENCE_FLOOR,
    candidateFloor: CANDIDATE_CONFIDENCE_FLOOR,
    reason: null,
    version: SCORE_VERSION,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  SCORE_VERSION,
  CONFIDENCE_MAX,
  TARGETS,
  CANDIDATE_CONFIDENCE_FLOOR,
  calculateConfidenceScore,
  _internal: { periodStability, monthKey },
};
