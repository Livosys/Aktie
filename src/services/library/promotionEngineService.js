'use strict';

// ── Promotion Engine ─────────────────────────────────────────────────────────
//
// Avgör när en strategi får flyttas ett steg. Den läser BARA Strategy Library
// och känner varken till AI, optimerare eller evolution. Det är avsiktligt: en
// befordringsregel som kan påverkas av en modell är en regel som en modell kan
// lära sig kringgå.
//
// Motorn FLYTTAR heller ingenting av sig själv. Den svarar på frågan "får den
// här strategin gå vidare, och varför inte?" och lämnar beslutet till den som
// frågar. `applyPromotion` finns för den som vill genomföra svaret, och den
// gör om utvärderingen innan den skriver.
//
// ── Två mått som måste vara överens ─────────────────────────────────────────
//
// Strategy Score säger hur bra strategin är. Confidence Score säger hur mycket
// vi vet om den. Grinden mot Candidate kräver BÅDA — det är hela anledningen
// till att Confidence finns som eget mått. En strategi med 90 i Strategy Score
// och 12 i Confidence har haft tur i ett smalt urval, och den ska inte komma
// vidare.
//
// Ren beräkning på inläst tillstånd: skriver bara via biblioteket, aldrig
// direkt till fil, aldrig till en broker.

const lifecycle = require('./strategyLifecycle');
const confidence = require('../score/confidenceScoreService');
const strategyScoreV1 = require('../score/strategyScoreV1Service');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'promotion_engine',
});

const ENGINE_VERSION = 'promotion-engine-v1';

// Kraven per övergång. Varje krav är en namngiven funktion så att ett nekande
// kan peka ut exakt vad som saknas — "not_ready" är ingen användbar dom.
const REQUIREMENTS = Object.freeze({
  // Draft → Testing: strategin behöver bara existera med känd identitet.
  [`${lifecycle.STAGES.DRAFT}->${lifecycle.STAGES.TESTING}`]: [
    { code: 'has_dna_hash', test: (r) => Boolean(r.currentDnaHash) },
    { code: 'has_version', test: (r) => Boolean(r.currentVersion) },
  ],

  // Testing → Learning: den har körts i replay och producerat affärer.
  [`${lifecycle.STAGES.TESTING}->${lifecycle.STAGES.LEARNING}`]: [
    { code: 'has_replay_runs', test: (r) => r.replayHistory.length >= 1 },
    {
      code: 'has_replay_trades',
      test: (r) => totalReplayTrades(r) >= 10,
      detail: (r) => ({ replayTrades: totalReplayTrades(r), required: 10 }),
    },
  ],

  // Learning → Candidate: DEN HÅRDA GRINDEN. Både kvalitet och kunskap.
  [`${lifecycle.STAGES.LEARNING}->${lifecycle.STAGES.CANDIDATE}`]: [
    {
      code: 'strategy_score_sufficient',
      test: (r) => (r.strategyScore ?? -1) >= 55,
      detail: (r) => ({ strategyScore: r.strategyScore, required: 55 }),
    },
    {
      code: 'confidence_score_sufficient',
      test: (r) => (r.confidenceScore ?? -1) >= confidence.CANDIDATE_CONFIDENCE_FLOOR,
      detail: (r) => ({
        confidenceScore: r.confidenceScore,
        required: confidence.CANDIDATE_CONFIDENCE_FLOOR,
      }),
    },
    {
      code: 'replay_sample_qualified',
      test: (r) => totalReplayTrades(r) >= strategyScoreV1.MIN_TRADES_FOR_RANKING,
      detail: (r) => ({
        replayTrades: totalReplayTrades(r),
        required: strategyScoreV1.MIN_TRADES_FOR_RANKING,
      }),
    },
    {
      code: 'tested_in_multiple_regimes',
      test: (r) => replayRegimes(r).length >= 2,
      detail: (r) => ({ regimes: replayRegimes(r), required: 2 }),
    },
  ],

  // Candidate → Paper: exekveringen måste vara mätt, inte bara logiken.
  [`${lifecycle.STAGES.CANDIDATE}->${lifecycle.STAGES.PAPER}`]: [
    {
      code: 'execution_score_measured',
      test: (r) => r.executionScore != null,
      detail: (r) => ({ executionScore: r.executionScore }),
    },
    {
      code: 'execution_score_not_prohibitive',
      test: (r) => (r.executionScore ?? -1) >= 40,
      detail: (r) => ({ executionScore: r.executionScore, required: 40 }),
    },
  ],

  // Paper → Monitoring: den har handlat i paper på riktigt.
  [`${lifecycle.STAGES.PAPER}->${lifecycle.STAGES.MONITORING}`]: [
    {
      code: 'has_paper_trades',
      test: (r) => r.paperHistory.length >= 20,
      detail: (r) => ({ paperTrades: r.paperHistory.length, required: 20 }),
    },
  ],

  // Monitoring → Approved: paper-resultatet håller, OCH en människa har sagt ja.
  [`${lifecycle.STAGES.MONITORING}->${lifecycle.STAGES.APPROVED}`]: [
    {
      code: 'production_score_sufficient',
      test: (r) => (r.productionScore ?? -1) >= 55,
      detail: (r) => ({ productionScore: r.productionScore, required: 55 }),
    },
    {
      code: 'paper_profitable',
      test: (r) => paperNetPnl(r) > 0,
      detail: (r) => ({ paperNetPnlUsd: paperNetPnl(r) }),
    },
    {
      // Ingen automatisk väg till Approved. Steget före Live kräver ett
      // mänskligt godkännande som ligger i loggen.
      code: 'human_approval_present',
      test: (r) => r.approvals.some((row) => row.decision === 'approved'),
      detail: (r) => ({ approvals: r.approvals.length }),
    },
  ],

  // Approved → Live: motorn säger aldrig ja. Live är ett människobeslut.
  [`${lifecycle.STAGES.APPROVED}->${lifecycle.STAGES.LIVE}`]: [
    {
      code: 'live_requires_explicit_human_release',
      test: () => false,
      detail: () => ({
        note: 'Promotion Engine befordrar aldrig till Live. Steget kräver ett uttryckligt beslut utanför motorn.',
      }),
    },
  ],
});

function totalReplayTrades(record) {
  return (record.replayHistory || []).reduce((total, row) => total + (Number(row.trades) || 0), 0);
}

function replayRegimes(record) {
  // Prefer fine-grained marketRegimeKeys (e.g., 'up/normal', 'down/quiet');
  // fall back to coarse marketClassification (e.g., 'volatile_chop', 'range').
  //
  // Canonical gate counts UNIQUE regimes across all replays. A single run may
  // carry multiple marketRegimeKeys, e.g., ['down/normal', 'down/quiet'], so
  // the union captures all market conditions seen. Strategy with 1
  // marketClassification but 2+ marketRegimeKeys has seen 2+ regimes.
  return [...new Set((record.replayHistory || [])
    .flatMap((row) => {
      if (Array.isArray(row.marketRegimeKeys) && row.marketRegimeKeys.length) {
        return row.marketRegimeKeys;
      }
      return row.marketClassification ? [row.marketClassification] : [];
    })
    .filter((value) => value && value !== 'unknown'))];
}

function paperNetPnl(record) {
  return (record.paperHistory || [])
    .reduce((total, row) => total + (Number(row.realizedPnlUsd) || 0), 0);
}

/**
 * Får strategin gå ett steg framåt?
 *
 * @returns {object} beslut med varje krav utskrivet, uppfyllt eller ej
 */
function evaluatePromotion(record) {
  if (!record) return { ok: false, reason: 'unknown_strategy', ...SAFETY };
  const from = record.lifecycle;
  if (from === lifecycle.STAGES.RETIRED) {
    return {
      strategyId: record.strategyId, from, to: null, allowed: false,
      reason: 'retired_is_terminal', checks: [], engineVersion: ENGINE_VERSION, ...SAFETY,
    };
  }

  const to = lifecycle.nextStage(from);
  if (!to) {
    return {
      strategyId: record.strategyId, from, to: null, allowed: false,
      reason: 'no_further_stage', checks: [], engineVersion: ENGINE_VERSION, ...SAFETY,
    };
  }

  const rules = REQUIREMENTS[`${from}->${to}`] || [];
  const checks = rules.map((rule) => {
    const passed = rule.test(record) === true;
    return {
      code: rule.code,
      ok: passed,
      detail: rule.detail ? rule.detail(record) : null,
    };
  });
  const blockers = checks.filter((check) => !check.ok).map((check) => check.code);

  return {
    strategyId: record.strategyId,
    from,
    to,
    allowed: blockers.length === 0,
    blockers,
    blockedReason: blockers[0] || null,
    checks,
    engineVersion: ENGINE_VERSION,
    ...SAFETY,
  };
}

/** Utvärderar hela biblioteket. Read-only. */
function evaluateAll(library) {
  const rows = library.listStrategies().map(evaluatePromotion);
  return {
    ok: true,
    evaluated: rows.length,
    promotable: rows.filter((row) => row.allowed).map((row) => row.strategyId),
    rows,
    engineVersion: ENGINE_VERSION,
    ...SAFETY,
  };
}

/**
 * Genomför en befordran som utvärderingen tillåter.
 *
 * Utvärderar OM innan skrivning: mellan en läsning och en skrivning kan
 * tillståndet ha ändrats, och en befordran som bygger på ett gammalt svar är
 * precis den sortens fel ett revisionsspår inte kan reparera i efterhand.
 */
function applyPromotion(library, strategyId, { actor = 'promotion_engine' } = {}) {
  const record = library.getStrategy(strategyId);
  const decision = evaluatePromotion(record);
  if (!decision.allowed) return { ok: false, decision };

  const result = library.recordTransition({
    strategyId,
    to: decision.to,
    reason: `promotion_engine:${decision.from}->${decision.to}`,
    actor,
    // Bevisen som låg till grund sparas MED övergången, så att ett beslut går
    // att granska i efterhand utan att räkna om något.
    evidence: { checks: decision.checks, engineVersion: ENGINE_VERSION },
  });
  return { ok: result.ok === true, decision, transition: result };
}

module.exports = {
  SAFETY,
  ENGINE_VERSION,
  REQUIREMENTS,
  evaluatePromotion,
  evaluateAll,
  applyPromotion,
  _internal: { totalReplayTrades, replayRegimes, paperNetPnl },
};
