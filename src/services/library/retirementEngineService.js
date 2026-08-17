'use strict';

// ── Retirement Engine ────────────────────────────────────────────────────────
//
// En strategi tas aldrig bort. Den pensioneras.
//
// Skillnaden är inte semantisk. En raderad strategi tar med sig svaret på
// frågan "varför slutade vi använda den?", och det är precis den frågan AI
// senare ska kunna ställa. Pensioneringen bevarar därför tillståndet i
// själva händelsen: datum, orsak, sista Strategy Score, sista Execution Score,
// sista Confidence Score, sista Production Score och sista market DNA.
//
// Motorn pensionerar ingenting av sig själv. Den FÖRESLÅR, med skäl, och den
// som frågar avgör. Att låta en automat plocka bort strategier ur produktion
// utan mänskligt beslut vore att bygga in en tyst felkälla i systemets minne.
//
// Skäl som föreslås:
//
//   persistent_underperformance  låg Strategy Score på ett underlag som håller
//   execution_prohibitive        logiken kan vara bra, men den går inte att
//                                exekvera till ett pris som lämnar något kvar
//   paper_losses                 verkligt paper-resultat är negativt över tid
//   superseded_by_version        DNA-hashen har ändrats så många gånger att
//                                posten inte längre beskriver samma strategi
//   stalled                      ingen aktivitet på länge — varken replay,
//                                paper eller live
//
// Ren beräkning på inläst tillstånd. Skriver bara via biblioteket.

const lifecycle = require('./strategyLifecycle');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  source: 'retirement_engine',
});

const ENGINE_VERSION = 'retirement-engine-v1';

const RETIREMENT_REASONS = Object.freeze({
  UNDERPERFORMANCE: 'persistent_underperformance',
  EXECUTION_PROHIBITIVE: 'execution_prohibitive',
  PAPER_LOSSES: 'paper_losses',
  SUPERSEDED: 'superseded_by_version',
  STALLED: 'stalled',
  MANUAL: 'manual_decision',
});

const THRESHOLDS = Object.freeze({
  minTradesBeforeJudging: 30,
  failingStrategyScore: 25,
  prohibitiveExecutionScore: 40,
  paperLossUsd: -500,
  stalledDays: 90,
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function replayTrades(record) {
  return (record.replayHistory || []).reduce((total, row) => total + (Number(row.trades) || 0), 0);
}

function paperNetPnl(record) {
  return (record.paperHistory || [])
    .reduce((total, row) => total + (Number(row.realizedPnlUsd) || 0), 0);
}

function lastActivityAt(record) {
  const stamps = [
    ...(record.replayHistory || []).map((row) => row.at),
    ...(record.paperHistory || []).map((row) => row.at),
    ...(record.liveHistory || []).map((row) => row.at),
  ].map((value) => Date.parse(value || '')).filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * Bör strategin pensioneras?
 *
 * @returns {object} förslag med skäl och bevis — aldrig en åtgärd
 */
function evaluateRetirement(record, { now = new Date() } = {}) {
  if (!record) return { ok: false, reason: 'unknown_strategy', ...SAFETY };
  if (record.lifecycle === lifecycle.STAGES.RETIRED) {
    return {
      strategyId: record.strategyId,
      shouldRetire: false,
      alreadyRetired: true,
      reasons: [],
      retiredAt: record.retirementHistory.at(-1)?.at || null,
      engineVersion: ENGINE_VERSION,
      ...SAFETY,
    };
  }

  const reasons = [];
  const trades = replayTrades(record);
  const paperTrades = (record.paperHistory || []).length;
  const nowMs = new Date(now).getTime();

  // Ett dåligt betyg på ett tunt underlag är inget betyg. Dom faller bara när
  // det finns tillräckligt bakom den.
  if (trades >= THRESHOLDS.minTradesBeforeJudging
      && num(record.strategyScore) != null
      && record.strategyScore < THRESHOLDS.failingStrategyScore) {
    reasons.push({
      reason: RETIREMENT_REASONS.UNDERPERFORMANCE,
      detail: { strategyScore: record.strategyScore, replayTrades: trades, threshold: THRESHOLDS.failingStrategyScore },
    });
  }

  if (num(record.executionScore) != null
      && record.executionScore < THRESHOLDS.prohibitiveExecutionScore
      && trades >= THRESHOLDS.minTradesBeforeJudging) {
    reasons.push({
      reason: RETIREMENT_REASONS.EXECUTION_PROHIBITIVE,
      detail: { executionScore: record.executionScore, threshold: THRESHOLDS.prohibitiveExecutionScore },
    });
  }

  const paperPnl = paperNetPnl(record);
  if (paperTrades >= THRESHOLDS.minTradesBeforeJudging && paperPnl <= THRESHOLDS.paperLossUsd) {
    reasons.push({
      reason: RETIREMENT_REASONS.PAPER_LOSSES,
      detail: { paperNetPnlUsd: paperPnl, paperTrades, threshold: THRESHOLDS.paperLossUsd },
    });
  }

  const lastActivity = lastActivityAt(record);
  if (lastActivity != null) {
    const days = Math.floor((nowMs - lastActivity) / (24 * 60 * 60 * 1000));
    if (days >= THRESHOLDS.stalledDays) {
      reasons.push({
        reason: RETIREMENT_REASONS.STALLED,
        detail: { daysSinceLastActivity: days, threshold: THRESHOLDS.stalledDays },
      });
    }
  }

  return {
    strategyId: record.strategyId,
    lifecycle: record.lifecycle,
    // FÖRSLAG. Motorn pensionerar aldrig själv.
    shouldRetire: reasons.length > 0,
    alreadyRetired: false,
    reasons,
    primaryReason: reasons[0]?.reason || null,
    evidence: {
      strategyScore: record.strategyScore,
      executionScore: record.executionScore,
      confidenceScore: record.confidenceScore,
      productionScore: record.productionScore,
      replayTrades: trades,
      paperTrades,
      paperNetPnlUsd: paperPnl,
      lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
      currentMarketDnaHash: record.currentMarketDnaHash,
    },
    engineVersion: ENGINE_VERSION,
    ...SAFETY,
  };
}

function evaluateAll(library, { now = new Date() } = {}) {
  const rows = library.listStrategies().map((record) => evaluateRetirement(record, { now }));
  return {
    ok: true,
    evaluated: rows.length,
    suggested: rows.filter((row) => row.shouldRetire).map((row) => row.strategyId),
    alreadyRetired: rows.filter((row) => row.alreadyRetired).map((row) => row.strategyId),
    rows,
    engineVersion: ENGINE_VERSION,
    ...SAFETY,
  };
}

/**
 * Genomför en pensionering.
 *
 * Kräver ett uttryckligt skäl. En pensionering utan skäl är precis den post AI
 * senare inte kan lära sig något av.
 */
function applyRetirement(library, strategyId, { reason, actor = 'retirement_engine', now = new Date() } = {}) {
  if (!reason) return { ok: false, reason: 'retirement_requires_reason' };
  const record = library.getStrategy(strategyId);
  if (!record) return { ok: false, reason: 'unknown_strategy' };
  const assessment = evaluateRetirement(record, { now });
  const result = library.retire({ strategyId, reason, actor });
  return { ok: result.ok === true, assessment, retirement: result };
}

module.exports = {
  SAFETY,
  ENGINE_VERSION,
  RETIREMENT_REASONS,
  THRESHOLDS,
  evaluateRetirement,
  evaluateAll,
  applyRetirement,
  _internal: { replayTrades, paperNetPnl, lastActivityAt },
};
