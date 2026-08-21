'use strict';

// ── AI Improvement Decision ──────────────────────────────────────────────────
//
// Evidenspolicyn svarar på EN fråga: håller bevisen för att befordra? Svaret är
// HISTORICALLY_VALIDATED_CANDIDATE, INSUFFICIENT_EVIDENCE eller
// REJECTED_BY_HISTORICAL_EVIDENCE, och det är ett omdöme om BEVISEN.
//
// Det svaret säger ingenting om vad fabriken ska GÖRA härnäst. En hypotes som
// inte blev kandidat kan ha lärt oss exakt var problemet sitter — och att låta
// den ligga död är att slänga bort ett svar som redan är betalt i beräkningstid.
//
// Den här modulen är därför ett ANDRA lager. Den läser policyns utfall som
// indata och beslutar vad AI ska göra: befordra, förbättra, vänta på mer data,
// eller lägga ned. Den ändrar aldrig en klassificering och skriver ingenting.
//
// ── De två sakerna hålls isär, och det är hela poängen ──────────────────────
//
//   evidensklassificering   ägs av researchEvidencePolicyService
//                           avgör candidate / insufficient / rejected
//                           65-procentsregeln finns INTE där och får inte
//                           smyga in där — den skulle bli en andra
//                           lönsamhetsgrind bredvid nettokravet
//
//   förbättringsbeslut      ägs av den här modulen
//                           avgör promote / improve / waiting / reject
//                           läser klassificeringen men kan aldrig ändra den
//
// Konkret konsekvens: en hypotes med negativt netto blir ALDRIG kandidat — det
// avgörs en nivå upp, av nettokravet i policyn. Den kan däremot mycket väl bli
// IMPROVE här, och det är skillnaden mellan "bevisen räckte inte" och "det
// finns inget mer att lära".
//
// ── Varför 65 ───────────────────────────────────────────────────────────────
//
// Strategy Score V1 går 0–100 och är projektets egen sammanvägning. 65 är en
// TRÖSKEL FÖR ATT AI SKA VILJA GÖRA OM, inte ett krav för lönsamhet: under 65
// finns det tillräckligt mycket kvar att hämta för att en ny generation ska
// vara värd sin körtid. Över 65 utan godkänd evidens är det data som saknas,
// inte design — då är svaret att köra mer, inte att bygga om.
//
// Tröskeln kan aldrig blockera en befordran. Är klassificeringen CANDIDATE blir
// beslutet PROMOTE oavsett poäng; annars hade 65 blivit just den lönsamhets-
// grind den inte får vara.
//
// Läser Strategy Library och en färdig klassificering. Skriver ingenting.

const policyModule = require('../research/researchEvidencePolicyService');

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'ai_improvement_decision',
});

const DECISION_VERSION = 'ai-improvement-decision-v1';

const DECISIONS = Object.freeze({
  PROMOTE: 'PROMOTE',
  IMPROVE: 'IMPROVE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  REJECT: 'REJECT',
  WAITING_FOR_MORE_DATA: 'WAITING_FOR_MORE_DATA',
});

// Under den här poängen vill AI göra om. Se modulhuvudet: tröskel för att
// FÖRBÄTTRA, aldrig ett krav för att vara lönsam.
const IMPROVEMENT_TRIGGER_SCORE = 65;

// Vad AI vill ändra, härlett ur VARFÖR bevisen inte höll. Varje nyckel är en
// reason som evidenspolicyn faktiskt kan returnera — inga påhittade orsaker.
const IMPROVEMENT_FOCUS = Object.freeze({
  gross_edge_holds_but_costs_are_not_carried: {
    focus: 'entry_and_execution',
    wants: 'Signalen finns — den bär bara inte sin kostnad. Nästa generation ska sänka '
      + 'kostnaden per affär (senare entry, färre affärer med lägre förväntat utfall), '
      + 'inte leta efter en ny signal.',
  },
  edge_present_but_below_policy_magnitude: {
    focus: 'parameters',
    wants: 'Tecknen är rätt men storleken bär inte. Nästa generation ska pröva strängare '
      + 'filter så att färre och tydligare lägen tas.',
  },
  sufficient_sample_shows_no_edge: {
    focus: 'hypothesis',
    wants: 'Underlaget räckte och visade ingen edge. Nästa steg är en ny hypotes ur samma '
      + 'evidens, inte en justering av den nuvarande.',
  },
  sample_below_policy_minimum: {
    focus: 'more_data',
    wants: 'Urvalet är för litet för att säga något. Nästa steg är fler körningar, inte en ändring.',
  },
  sign_test_not_measurable: {
    focus: 'bookkeeping',
    wants: 'Nettot saknas i underlaget, så teckentestet kunde inte köras. Nästa steg är att '
      + 'få kostnaden bokförd — hypotesen är inte prövad än.',
  },
});

const DEFAULT_FOCUS = Object.freeze({
  focus: 'exploration',
  wants: 'Strategin har ingen prövad evidens ännu. Nästa generation ska utforska '
    + 'parameterrymden för att skaffa ett första underlag.',
});

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

/**
 * Poängen beslutet läser.
 *
 * Strategy Score är förstahandsvalet: det är måttet på REPLAY-resultat, och det
 * är replay fabriken kör. Production Score räknas på verkliga paper-affärer och
 * används bara när replay ännu inte gett något — annars hade en strategi utan
 * replay sett obeprövad ut fast den handlat.
 */
function scoreOf(record) {
  const strategyScore = num(record?.strategyScore);
  if (strategyScore != null) return { value: strategyScore, source: 'strategyScore' };
  const productionScore = num(record?.productionScore);
  if (productionScore != null) return { value: productionScore, source: 'productionScore' };
  const confidence = num(record?.confidenceScore);
  if (confidence != null) return { value: confidence, source: 'confidenceScore' };
  return { value: null, source: null };
}

/** Finns det något att lära av? Utan mätta affärer finns ingen evidens att bygga på. */
function evidenceIsUsable(classification) {
  if (!classification) return false;
  const measured = classification.measured || {};
  return (num(measured.researchTrades) || 0) > 0 || (num(measured.validationTrades) || 0) > 0;
}

/**
 * Ett beslut för en strategi.
 *
 * @param {object}  record          biblioteksposten
 * @param {object} [classification] utfall från researchEvidencePolicyService.classify()
 * @returns {object} beslutet — rådgivande, utan behörighet
 */
function decideFor(record, classification = null) {
  const strategyId = text(record?.strategyId);
  const score = scoreOf(record);
  const outcome = text(classification?.outcome);
  const reason = text(classification?.reason);
  const usable = evidenceIsUsable(classification);
  const focus = (reason && IMPROVEMENT_FOCUS[reason]) || DEFAULT_FOCUS;

  const base = {
    strategyId,
    lifecycle: text(record?.lifecycle),
    parentDnaHash: text(record?.currentDnaHash),
    score: score.value,
    scoreSource: score.source,
    improvementTrigger: IMPROVEMENT_TRIGGER_SCORE,
    // Klassificeringen bärs vidare ORÖRD. Den här modulen får läsa den, aldrig
    // skriva om den — se modulhuvudet.
    evidence: outcome ? { outcome, reason, measured: classification.measured || null } : null,
  };

  // ── 1. Bevisen håller ────────────────────────────────────────────────────
  //
  // Ligger före poängtröskeln med flit. Skulle 65 kunna stoppa en befordran
  // vore den en lönsamhetsgrind, och det är precis vad den inte får vara.
  if (outcome === policyModule.OUTCOMES.CANDIDATE) {
    return {
      ...base,
      decision: DECISIONS.PROMOTE,
      why: 'Evidenspolicyn klassade hypotesen som historiskt validerad kandidat.',
      wants: null,
      nextStep: 'Befordran beslutas av en människa. Fabriken utför den inte.',
      learned: 'Hypotesen höll i både research- och valideringsperioden.',
    };
  }

  // ── 2. Redan nedlagd ─────────────────────────────────────────────────────
  //
  // Den ENDA vägen till REJECT. En svag strategi läggs aldrig ned för att den
  // inte blev kandidat — den skickas till förbättring. Nedläggning är ett
  // beslut som redan har fattats någon annanstans och som vi bara redovisar.
  if (record?.retired === true || text(record?.lifecycle) === 'retired') {
    return {
      ...base,
      decision: DECISIONS.REJECT,
      why: 'Strategin är redan pensionerad i Strategy Library.',
      wants: null,
      nextStep: 'Ingen ny generation planeras.',
      learned: reason ? `Sista klassificering: ${reason}.` : 'Ingen klassificerad evidens.',
    };
  }

  // ── 3. Bevisen räckte inte — men VARFÖR avgör vad AI gör ─────────────────
  if (outcome === policyModule.OUTCOMES.INSUFFICIENT || outcome === policyModule.OUTCOMES.REJECTED) {
    // Ett för litet urval eller ett teckentest som inte gick att köra är inte
    // ett besked om designen. Då saknas data, och svaret är att köra mer.
    const dataProblem = focus.focus === 'more_data' || focus.focus === 'bookkeeping';
    if (dataProblem) {
      return {
        ...base,
        decision: DECISIONS.WAITING_FOR_MORE_DATA,
        why: `Evidenspolicyn: ${reason}.`,
        wants: focus.wants,
        nextStep: 'Fler historiska körningar på samma hypotes.',
        learned: 'Ännu inget — underlaget räcker inte för ett omdöme.',
      };
    }
    if (usable) {
      return {
        ...base,
        decision: DECISIONS.IMPROVE,
        why: `Evidenspolicyn: ${reason}. Bevisen räcker inte för befordran, men de pekar ut vad som brister.`,
        wants: focus.wants,
        improvementFocus: focus.focus,
        nextStep: 'Ny DNA-generation ur samma evidens, sedan ny historisk research.',
        learned: learnedFrom(classification),
      };
    }
    return {
      ...base,
      decision: DECISIONS.INSUFFICIENT_EVIDENCE,
      why: `Evidenspolicyn: ${reason}. Ingen mätt affär att bygga vidare på.`,
      wants: null,
      nextStep: 'Kör hypotesen historiskt innan något beslut fattas.',
      learned: 'Ännu inget.',
    };
  }

  // ── 4. Ingen klassificering — här styr 65-procentsregeln ─────────────────
  //
  // Strategin har aldrig prövats mot policyn. Poängen är det enda vi har, och
  // den avgör om det är värt att bygga en ny generation eller att köra mer.
  if (score.value != null && score.value < IMPROVEMENT_TRIGGER_SCORE) {
    return {
      ...base,
      decision: DECISIONS.IMPROVE,
      why: `${score.source} ${score.value} ligger under förbättringströskeln ${IMPROVEMENT_TRIGGER_SCORE}.`,
      wants: DEFAULT_FOCUS.wants,
      improvementFocus: DEFAULT_FOCUS.focus,
      nextStep: 'Ny DNA-generation, sedan historisk research.',
      learned: 'Ingen klassificerad evidens ännu — poängen är enda underlaget.',
    };
  }

  return {
    ...base,
    decision: DECISIONS.WAITING_FOR_MORE_DATA,
    why: score.value == null
      ? 'Strategin har varken poäng eller klassificerad evidens.'
      : `${score.source} ${score.value} ligger på eller över ${IMPROVEMENT_TRIGGER_SCORE}, men ingen evidens är klassificerad.`,
    wants: null,
    nextStep: 'Kör hypotesen historiskt och klassificera resultatet.',
    learned: 'Ingen klassificerad evidens ännu.',
  };
}

/** Den mening som svarar på "vad lärde sig AI?" ur de mätta talen. */
function learnedFrom(classification) {
  const m = classification?.measured || {};
  const rPf = num(m.researchProfitFactor);
  const vPf = num(m.validationProfitFactor);
  const rNet = num(m.researchNetPnlUsd);
  const parts = [];
  if (rPf != null) parts.push(`research PF ${rPf}`);
  if (vPf != null) parts.push(`validation PF ${vPf}`);
  if (rNet != null) parts.push(`research netto ${rNet} USD`);
  if (m.researchTrades != null) parts.push(`${m.researchTrades} research-affärer`);
  return parts.length ? parts.join(', ') : 'Bevisen mättes men bar inga jämförbara tal.';
}

/**
 * Beslut för en hel population.
 *
 * @param {object[]} records          biblioteksposter
 * @param {Map|object} [classifications] strategyId → klassificering
 */
function decideAll(records = [], classifications = null) {
  const lookup = classifications instanceof Map
    ? classifications
    : new Map(Object.entries(classifications || {}));
  return records
    .map((record) => decideFor(record, lookup.get(text(record?.strategyId)) || null))
    .sort((a, b) => String(a.strategyId).localeCompare(String(b.strategyId)));
}

/** Hur besluten fördelar sig. */
function summarize(decisions = []) {
  const counts = Object.fromEntries(Object.values(DECISIONS).map((key) => [key, 0]));
  for (const row of decisions) {
    if (counts[row.decision] != null) counts[row.decision] += 1;
  }
  return {
    total: decisions.length,
    counts,
    needsImprovement: decisions.filter((row) => row.decision === DECISIONS.IMPROVE).length,
  };
}

/** Beslutslagret som det ska stå i en rapport. */
function describe() {
  return {
    decisionVersion: DECISION_VERSION,
    decisions: Object.values(DECISIONS),
    improvementTriggerScore: IMPROVEMENT_TRIGGER_SCORE,
    separation: {
      evidenceClassification: {
        owner: 'researchEvidencePolicyService',
        decides: Object.values(policyModule.OUTCOMES),
        note: 'Kan aldrig ändras härifrån. Negativt netto blir aldrig kandidat — det avgörs av policyns nettokrav.',
      },
      improvementDecision: {
        owner: 'aiImprovementDecisionService',
        decides: Object.values(DECISIONS),
        note: `${IMPROVEMENT_TRIGGER_SCORE} är en tröskel för att vilja göra om, inte en lönsamhetsgrind. `
          + 'Den kan aldrig blockera en PROMOTE.',
      },
    },
    grantsNothing: 'rådgivning endast — ingen runtime-behörighet, ingen Paper-behörighet, ingen orderväg',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  DECISION_VERSION,
  DECISIONS,
  IMPROVEMENT_TRIGGER_SCORE,
  IMPROVEMENT_FOCUS,
  decideFor,
  decideAll,
  summarize,
  describe,
  _internal: { scoreOf, evidenceIsUsable, learnedFrom },
};
