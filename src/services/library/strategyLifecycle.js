'use strict';

// ── Strategy Lifecycle ───────────────────────────────────────────────────────
//
// En strategi är inte kod. Den är ett objekt med ett liv, och livet har en
// riktning. Den här modulen äger den riktningen och ingenting annat: vilka steg
// som finns, vilka övergångar som är tillåtna, och varför en övergång nekas.
//
//   Draft → Testing → Learning → Candidate → Paper → Monitoring → Approved
//         → Live → Retired
//
// Två regler:
//
//   1. Ett steg i taget. Framåt till nästa, bakåt till föregående. Inga hopp.
//      Att låta en strategi gå från Learning direkt till Live vore att låta den
//      hoppa över exakt de steg som finns för att upptäcka att den inte borde.
//
//   2. Retired går att nå från VARJE steg. En strategi kan visa sig oduglig när
//      som helst, och då ska den kunna pensioneras utan att först vandra
//      framåt genom steg den inte förtjänar. Det är en uttryckligen deklarerad
//      övergång, inte ett kryphål.
//
// Retired är slutgiltigt. En pensionerad strategi tas aldrig bort — AI ska
// kunna läsa den — men den kommer inte tillbaka. Behövs den igen kommer den
// tillbaka som en ny version med ett eget liv. Att kunna återuppliva en
// strategi rakt in i Live vore den farligaste övergången i hela systemet.
//
// Ren modul: ingen IO, ingen klocka, inget tillstånd.

const SAFETY = Object.freeze({
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STAGES = Object.freeze({
  DRAFT: 'draft',
  TESTING: 'testing',
  LEARNING: 'learning',
  CANDIDATE: 'candidate',
  PAPER: 'paper',
  MONITORING: 'monitoring',
  APPROVED: 'approved',
  LIVE: 'live',
  RETIRED: 'retired',
});

// Ordningen ÄR livscykeln. Framåt och bakåt härleds ur den här listan i stället
// för att skrivas som en andra tabell som kan säga emot.
const STAGE_ORDER = Object.freeze([
  STAGES.DRAFT,
  STAGES.TESTING,
  STAGES.LEARNING,
  STAGES.CANDIDATE,
  STAGES.PAPER,
  STAGES.MONITORING,
  STAGES.APPROVED,
  STAGES.LIVE,
]);

const STAGE_LABELS_SV = Object.freeze({
  draft: 'Utkast',
  testing: 'Testas',
  learning: 'Lär sig',
  candidate: 'Kandidat',
  paper: 'Paper',
  monitoring: 'Övervakas',
  approved: 'Godkänd',
  live: 'Live',
  retired: 'Pensionerad',
});

const DIRECTIONS = Object.freeze({
  PROMOTION: 'promotion',
  DEMOTION: 'demotion',
  RETIREMENT: 'retirement',
});

function isStage(value) {
  return Object.values(STAGES).includes(value);
}

function indexOf(stage) {
  return STAGE_ORDER.indexOf(stage);
}

/** Nästa steg framåt, eller null när det inte finns något. */
function nextStage(stage) {
  const i = indexOf(stage);
  if (i === -1 || i === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[i + 1];
}

/** Föregående steg, eller null. */
function previousStage(stage) {
  const i = indexOf(stage);
  if (i <= 0) return null;
  return STAGE_ORDER[i - 1];
}

/** Alla övergångar som är tillåtna från ett steg. */
function allowedTransitions(stage) {
  if (stage === STAGES.RETIRED) return [];
  return [nextStage(stage), previousStage(stage), STAGES.RETIRED]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

/**
 * Får en strategi flyttas från `from` till `to`?
 *
 * Svaret är avsiktligt en förklaring och inte ett booleskt värde — ett nekande
 * som inte säger varför är oanvändbart i en revisionslogg.
 */
function validateTransition(from, to) {
  if (!isStage(from)) return { ok: false, reason: `unknown_stage_from:${from}` };
  if (!isStage(to)) return { ok: false, reason: `unknown_stage_to:${to}` };
  if (from === to) return { ok: false, reason: 'transition_to_same_stage' };
  if (from === STAGES.RETIRED) {
    return { ok: false, reason: 'retired_is_terminal' };
  }
  if (to === STAGES.RETIRED) {
    return { ok: true, direction: DIRECTIONS.RETIREMENT, steps: 1 };
  }

  const fromIndex = indexOf(from);
  const toIndex = indexOf(to);
  const steps = toIndex - fromIndex;
  if (steps === 1) return { ok: true, direction: DIRECTIONS.PROMOTION, steps: 1 };
  if (steps === -1) return { ok: true, direction: DIRECTIONS.DEMOTION, steps: 1 };
  return {
    ok: false,
    reason: steps > 0 ? `skips_stages:${steps}` : `skips_stages_backwards:${Math.abs(steps)}`,
    // Vilket steg som SKULLE varit lagligt — gör felet åtgärdbart.
    expected: steps > 0 ? nextStage(from) : previousStage(from),
  };
}

function describeStage(stage) {
  return {
    stage,
    label: STAGE_LABELS_SV[stage] || stage,
    index: indexOf(stage),
    terminal: stage === STAGES.RETIRED,
    next: nextStage(stage),
    previous: previousStage(stage),
    allowedTransitions: allowedTransitions(stage),
  };
}

module.exports = {
  SAFETY,
  STAGES,
  STAGE_ORDER,
  STAGE_LABELS_SV,
  DIRECTIONS,
  isStage,
  nextStage,
  previousStage,
  allowedTransitions,
  validateTransition,
  describeStage,
};
