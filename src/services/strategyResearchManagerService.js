'use strict';

/**
 * Strategy Research Manager — READ-ONLY research planner (dry_run).
 *
 * Decides WHAT the system should research next. It synthesizes existing
 * read-only sources into a single, deterministic-where-possible recommendation
 * set so the Supervisor / AI Analyst can explain the next safe research step.
 *
 * Inputs (all read-only, all fault-isolated):
 *   - marketRegimeDetectorService  → current market regime
 *   - automationPlanService        → strategy candidate buckets
 *   - paperAllowlistService        → which strategies are already allowed for paper
 *   - automationApprovalService    → approved/rejected strategy ids
 *   - tradeStatsService            → canonical paper-trade stats (stagnation signal)
 *
 * It RECOMMENDS only — it never:
 *   - trades, places orders, enables a broker or live trading
 *   - approves the paper allowlist automatically
 *   - mutates or replaces a strategy
 *   - starts a replay/batch/paper run
 *
 * A recommendation may only be flagged paperEligible when the strategy is ALREADY
 * on the approved paper allowlist. Everything else requires explicit user
 * approval and/or more replay/batch evidence first. Default mode is dry_run.
 *
 * paperEligible means ONLY "approved as a paper-only research candidate". It does
 * NOT mean the paper-simulation runtime is connected, and it never implies live
 * trading, a broker or real orders. Runtime connection is reported separately via
 * paperRuntimeReady / runtimeConnectionStatus, sourced from paperAllowlistService.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Safety stamp carried on every individual recommendation.
const REC_SAFETY = Object.freeze({
  paperOnly: true,
  canPlaceOrders: false,
  brokerEnabled: false,
});

const PRIORITY_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });
const MAX_RECOMMENDATIONS = 12;

function lazy(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function text(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  const out = String(v).trim();
  return out || fallback;
}

// Build a single recommendation in the fixed contract shape. Never trades.
function makeRecommendation({
  type,
  priority = 'low',
  strategyId = '',
  baseStrategy = '',
  proposedStrategy = '',
  reason = '',
  evidence = [],
  requiredBeforePaper = [],
  paperEligible = false,
  requiresUserApproval = true,
  paperRuntimeReady = false,
  runtimeConnectionStatus = 'unknown',
  blockedReason = '',
}) {
  const runtimeStatus = ['ready', 'pending', 'unknown'].includes(runtimeConnectionStatus)
    ? runtimeConnectionStatus
    : 'unknown';
  return {
    type,
    priority,
    strategyId: text(strategyId, ''),
    baseStrategy: text(baseStrategy, ''),
    proposedStrategy: text(proposedStrategy, ''),
    reason: text(reason, ''),
    evidence: arr(evidence).map((e) => text(e, '')).filter(Boolean),
    requiredBeforePaper: arr(requiredBeforePaper),
    // Hard safety invariant: a recommendation can never be paper-eligible while
    // it still requires user approval. This guarantees no auto-promotion path.
    paperEligible: paperEligible === true && requiresUserApproval === false,
    requiresUserApproval: requiresUserApproval !== false,
    // Paper-simulation runtime status — orthogonal to paperEligible. A strategy
    // can be an approved paper-only research candidate while its paper runtime is
    // still pending. Never implies broker/live trading.
    paperRuntimeReady: paperRuntimeReady === true,
    runtimeConnectionStatus: runtimeStatus,
    blockedReason: text(blockedReason, ''),
    safety: REC_SAFETY,
  };
}

function evidenceLines(evidence) {
  if (!evidence || typeof evidence !== 'object') return [];
  const lines = [];
  const p = num(evidence.paperTrades);
  const pwr = num(evidence.paperWinRate);
  if (p !== null) lines.push(`Paper: ${p} trades${pwr !== null ? ` (${pwr}% vinst)` : ''}.`);
  const s = num(evidence.simTrades);
  const swr = num(evidence.simWinRate);
  if (s !== null && s > 0) lines.push(`Simulering: ${s} trades${swr !== null ? ` (${swr}% vinst)` : ''}.`);
  if (evidence.lastTested && evidence.lastTested !== 'unknown') lines.push(`Senast testad: ${evidence.lastTested}.`);
  return lines;
}

// Deterministic order: highest priority first, then paper-eligible first, then
// strategyId alphabetical. Pure comparator, no randomness.
function compareRecommendations(a, b) {
  const pr = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
  if (pr !== 0) return pr;
  if (a.paperEligible !== b.paperEligible) return a.paperEligible ? -1 : 1;
  return String(a.strategyId).localeCompare(String(b.strategyId));
}

// Detect research stagnation from read-only signals only. Deterministic given
// the same plan summary + paper stats.
function detectStagnation({ planSummary, paperStats }) {
  const total = num(paperStats && paperStats.totalTrades);
  const avgPnl = num(paperStats && paperStats.avgPnl);
  const recommended = num(planSummary && planSummary.recommended) || 0;
  const promising = num(planSummary && planSummary.promisingNeedsManualApproval) || 0;

  if (total !== null && total === 0) {
    return { detected: true, reason: 'no_paper_results_yet' };
  }
  if (recommended === 0 && promising === 0) {
    return { detected: true, reason: 'no_clean_candidates' };
  }
  if (avgPnl !== null && avgPnl <= 0 && total !== null && total >= 20) {
    return { detected: true, reason: 'flat_or_negative_paper_pnl' };
  }
  return { detected: false, reason: null };
}

function nextActionText(top, stagnation) {
  if (!top) {
    return stagnation && stagnation.detected
      ? 'Samla mer paper/replay-data innan nästa forskningssteg.'
      : 'Ingen ny forskningsåtgärd krävs just nu. Fortsätt i paper-only.';
  }
  switch (top.type) {
    case 'paper_candidate':
      if (!top.paperEligible) {
        return `${top.strategyId} ser lovande ut men kräver ditt godkännande innan paper-only.`;
      }
      return top.paperRuntimeReady
        ? `${top.strategyId} är en godkänd paper-only research-kandidat och dess paper-simulation är aktiv. Inga riktiga order läggs.`
        : `${top.strategyId} är en godkänd paper-only research-kandidat, men paper-runtime-kopplingen är ännu inte aktiv.`;
    case 'run_replay':
      return `Kör en paper-only replay för ${top.strategyId} för att samla mer evidens.`;
    case 'run_batch':
      return `Kör en paper-only batch för ${top.strategyId} för att jämföra varianter.`;
    case 'collect_more_data':
      return `Samla mer data för ${top.strategyId} innan den kan bedömas.`;
    case 'pause_strategy':
      return `Pausa eller nedprioritera ${top.strategyId}: ${top.blockedReason || top.reason}.`;
    case 'continue_strategy':
      return `Fortsätt följa ${top.strategyId} i paper-only.`;
    default:
      return 'Granska forskningsrekommendationerna i Supervisor.';
  }
}

/**
 * Build the Strategy Research Manager output. Never throws — any failure
 * degrades into a safe object that still carries the safety contract.
 */
function buildStrategyResearch() {
  const lastRun = new Date().toISOString();
  const regimeDetector = lazy('./marketRegimeDetectorService');
  const planService = lazy('./automationPlanService');
  const allowlistService = lazy('./paperAllowlistService');
  const tradeStats = lazy('./tradeStatsService');

  const fail = (message) => ({
    ok: false,
    status: 'error',
    mode: 'dry_run',
    lastRun,
    marketRegime: null,
    stagnation: { detected: false, reason: null },
    recommendations: [],
    topRecommendation: null,
    requiresApprovalCount: 0,
    paperEligibleCount: 0,
    paperRuntimeReadyCount: 0,
    runtimeConnectionStatus: 'unknown',
    blockedReasons: [],
    nextRecommendedAction: '',
    message,
    source: 'strategyResearchManagerService',
    safety: SAFETY,
  });

  try {
    // ── read-only inputs (each isolated) ──────────────────────────────────────
    let marketRegime = null;
    try {
      marketRegime = regimeDetector && typeof regimeDetector.buildMarketRegimeDetection === 'function'
        ? regimeDetector.buildMarketRegimeDetection()
        : null;
    } catch (_) { marketRegime = null; }

    let plan = null;
    try {
      plan = planService && typeof planService.getAutomationPlan === 'function'
        ? planService.getAutomationPlan()
        : null;
    } catch (_) { plan = null; }

    let allowlist = null;
    try {
      allowlist = allowlistService && typeof allowlistService.getPaperAllowlistStatus === 'function'
        ? allowlistService.getPaperAllowlistStatus()
        : null;
    } catch (_) { allowlist = null; }

    let paperStats = null;
    try {
      paperStats = tradeStats && typeof tradeStats.buildPaperTradeStats === 'function'
        ? tradeStats.buildPaperTradeStats()
        : null;
    } catch (_) { paperStats = null; }

    if (!plan) {
      return {
        ...fail('Automation plan kunde inte läsas — ingen forskningsrekommendation kunde byggas.'),
        status: 'empty',
        marketRegime,
      };
    }

    // Per-strategy allowlist rows, keyed by id. approvedForPaperTesting === true
    // is the ONLY path to paperEligible; the row's runtimeConnectionStatus /
    // readyForPaperRuntime tells us, separately, whether the paper-simulation
    // runtime is actually connected. Approval is read, never written.
    const allowRowById = new Map(
      arr(allowlist && allowlist.allowlist)
        .filter((row) => row && row.id)
        .map((row) => [row.id, row]),
    );
    const approvedForPaperIds = new Set(
      [...allowRowById.values()]
        .filter((row) => row.approvedForPaperTesting === true)
        .map((row) => row.id),
    );

    const recommendations = [];

    // 1. Recommended paper candidates (approved paper-only research candidates).
    for (const c of arr(plan.recommendedPaperCandidates).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const allowRow = allowRowById.get(c.id) || null;
      const onAllowlist = approvedForPaperIds.has(c.id);
      const runtimeReady = Boolean(allowRow && allowRow.readyForPaperRuntime);
      const runtimeStatus = allowRow
        ? (allowRow.runtimeConnectionStatus || (runtimeReady ? 'ready' : 'pending'))
        : 'unknown';
      let reason;
      if (onAllowlist) {
        reason = runtimeReady
          ? 'Godkänd paper-only research-kandidat. Paper-simulationens runtime är aktiv (paper-only, ingen broker eller live trading).'
          : 'Godkänd för paper-only research, men paper-runtime-kopplingen är ännu inte aktiv.';
      } else {
        reason = `Lovande paper-only research-kandidat men ännu inte på paper-allowlist. ${text(c.reason, '')}`.trim();
      }
      recommendations.push(makeRecommendation({
        type: 'paper_candidate',
        priority: 'high',
        strategyId: c.id,
        baseStrategy: c.id,
        reason,
        evidence: evidenceLines(c.evidence),
        // Already-approved → eligible as a paper-only research candidate. If the
        // runtime is not yet connected, that is surfaced separately (not a
        // user-approval gate). Not-approved requires explicit user approval first.
        requiredBeforePaper: onAllowlist
          ? (runtimeReady ? [] : ['paper_runtime_connection'])
          : ['user_approval'],
        paperEligible: onAllowlist,
        requiresUserApproval: !onAllowlist,
        paperRuntimeReady: runtimeReady,
        runtimeConnectionStatus: runtimeStatus,
        blockedReason: onAllowlist ? '' : 'not_on_paper_allowlist',
      }));
    }

    // 2. Promising — strong data but not cleanly connected. Needs more evidence.
    for (const c of arr(plan.promisingNeedsManualApproval).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      recommendations.push(makeRecommendation({
        type: 'run_replay',
        priority: 'medium',
        strategyId: c.id,
        baseStrategy: c.id,
        reason: text(c.reason, 'Lovande men kräver mer replay/batch-evidens innan godkännande.'),
        evidence: evidenceLines(c.evidence),
        requiredBeforePaper: ['replay', 'batch', 'user_approval'],
        paperEligible: false,
        requiresUserApproval: true,
        blockedReason: 'needs_more_evidence',
      }));
    }

    // 3. Needs more data.
    for (const c of arr(plan.needsMoreData).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      recommendations.push(makeRecommendation({
        type: 'collect_more_data',
        priority: 'medium',
        strategyId: c.id,
        baseStrategy: c.id,
        reason: text(c.reason, 'Otillräcklig evidens. Behöver mer paper/replay-data.'),
        requiredBeforePaper: ['replay', 'batch', 'user_approval'],
        paperEligible: false,
        requiresUserApproval: true,
        blockedReason: 'insufficient_data',
      }));
    }

    // 4. Weak strategies → deprioritize.
    for (const c of arr(plan.weakStrategies).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      recommendations.push(makeRecommendation({
        type: 'pause_strategy',
        priority: 'low',
        strategyId: c.id,
        baseStrategy: c.id,
        reason: text(c.reason, 'Svag kandidat: låg vinstprocent eller negativ avkastning.'),
        requiredBeforePaper: ['user_approval'],
        paperEligible: false,
        requiresUserApproval: true,
        blockedReason: 'weak_results',
      }));
    }

    // 5. Blocked strategies → must not be automated yet.
    for (const c of arr(plan.blockedStrategies).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      recommendations.push(makeRecommendation({
        type: 'pause_strategy',
        priority: 'low',
        strategyId: c.id,
        baseStrategy: c.id,
        reason: text(c.reason, 'Pausad eller blockerad i runtime. Ska inte automatiseras ännu.'),
        requiredBeforePaper: ['unblock', 'user_approval'],
        paperEligible: false,
        requiresUserApproval: true,
        blockedReason: 'blocked_in_runtime',
      }));
    }

    recommendations.sort(compareRecommendations);
    const trimmed = recommendations.slice(0, MAX_RECOMMENDATIONS);

    const planSummary = plan.summary || {};
    const stagnation = detectStagnation({ planSummary, paperStats });
    const topRecommendation = trimmed[0] || null;
    const requiresApprovalCount = trimmed.filter((r) => r.requiresUserApproval).length;
    const paperEligibleCount = trimmed.filter((r) => r.paperEligible).length;
    const paperRuntimeReadyCount = trimmed.filter((r) => r.paperRuntimeReady).length;
    const runtimeConnectionStatus = allowlist && typeof allowlist.runtimeConnectionStatus === 'string'
      ? allowlist.runtimeConnectionStatus
      : 'unknown';
    const blockedReasons = [...new Set(trimmed.map((r) => r.blockedReason).filter(Boolean))];

    let status = 'ok';
    if (!trimmed.length) status = 'empty';

    return {
      ok: true,
      status,
      mode: 'dry_run',
      lastRun,
      marketRegime,
      stagnation,
      recommendations: trimmed,
      topRecommendation,
      requiresApprovalCount,
      paperEligibleCount,
      paperRuntimeReadyCount,
      runtimeConnectionStatus,
      blockedReasons,
      nextRecommendedAction: nextActionText(topRecommendation, stagnation),
      planSummary: {
        total: num(planSummary.total) || 0,
        recommended: num(planSummary.recommended) || 0,
        promisingNeedsManualApproval: num(planSummary.promisingNeedsManualApproval) || 0,
        blocked: num(planSummary.blocked) || 0,
        needsMoreData: num(planSummary.needsMoreData) || 0,
        weak: num(planSummary.weak) || 0,
      },
      message: 'Forskningsplan byggd read-only. Inga tester startas och inga order kan läggas.',
      source: 'strategyResearchManagerService',
      safety: SAFETY,
    };
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  }
}

module.exports = {
  SAFETY,
  buildStrategyResearch,
  // exported for tests
  _internal: {
    detectStagnation,
    compareRecommendations,
    makeRecommendation,
    nextActionText,
  },
};
