'use strict';

/**
 * Approved-strategy gate for the paper-simulation runtime — READ-ONLY decision layer.
 *
 * The paper agent historically gated entries on signal family/subtype only. This
 * service adds the PRIMARY gate the supervisor actually wants: a scanner candidate
 * may only become a SIMULATED paper trade when its canonical strategyId is on the
 * approved allowlist (data/automation-approvals.json via automationApprovalService).
 *
 * Resolution of candidate → strategyId is delegated to strategyRuntimeConnectorService
 * (the single source of truth for that mapping), so this service never invents a
 * mapping of its own.
 *
 * Safety: paper-only. This service NEVER places an order, enables a broker, starts a
 * trade, mutates the allowlist, or approves a strategy. It only reads and decides.
 * Every emitted row carries the locked paper-only safety stamp.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Canonical blocked reason for non-approved strategies. Kept stable so the UI,
// event log and tests can rely on the exact string.
const NOT_APPROVED_REASON = 'not_in_approved_strategy_allowlist';

function lazy(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

// Read the approved strategy ids from the manual-approval store. Read-only; an
// error or missing file degrades to an empty list (fail-closed → nothing approved).
function getApprovedStrategyIds() {
  const svc = lazy('./automationApprovalService');
  try {
    const a = svc && typeof svc.getAutomationApprovals === 'function' ? svc.getAutomationApprovals() : null;
    return Array.isArray(a && a.approvedStrategyIds) ? a.approvedStrategyIds.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

// Resolve a scanner candidate to its canonical strategyId using the runtime
// connector's mapping. Falls back to any explicit id already on the candidate.
function resolveStrategyId(candidate = {}) {
  const conn = lazy('./strategyRuntimeConnectorService');
  try {
    if (conn && typeof conn.inferStrategyForSignal === 'function') {
      const r = conn.inferStrategyForSignal(candidate) || {};
      const id = r.strategy_id || r.strategyId || r.resolvedStrategyId || null;
      if (id) return id;
    }
  } catch (_) { /* fall through to explicit id */ }
  return candidate.strategyId || candidate.strategy_id || candidate.resolvedStrategyId || null;
}

function isApprovedStrategyId(strategyId, approvedSet) {
  if (!strategyId) return false;
  const set = approvedSet instanceof Set ? approvedSet : new Set(getApprovedStrategyIds());
  return set.has(strategyId);
}

/**
 * Decide whether one candidate may open a paper-only simulated trade.
 * Approved-allowlist is the PRIMARY gate. Returns a render-safe decision object;
 * never throws, never writes.
 */
function evaluateCandidate(candidate = {}, opts = {}) {
  const approvedSet = opts.approvedSet instanceof Set ? opts.approvedSet : new Set(getApprovedStrategyIds());
  const strategyId = resolveStrategyId(candidate);
  const approved = isApprovedStrategyId(strategyId, approvedSet);
  return {
    symbol: candidate.symbol || null,
    timeframe: candidate.timeframe || '2m',
    signalFamily: candidate.signalFamily || null,
    signalSubtype: candidate.signalSubtype || null,
    strategyId: strategyId || null,
    approved,
    decision: approved ? 'accept' : 'block',
    // Only set when blocked, so callers can log a precise, stable reason.
    blockedReason: approved ? null : NOT_APPROVED_REASON,
    ...SAFETY,
  };
}

/**
 * Dry-run preview over a list of candidates. Writes NOTHING. Shows, per candidate,
 * whether it would be accepted as an approved paper-only simulation or blocked,
 * with the resolved strategyId, symbol/timeframe and blockedReason.
 */
function previewCandidates(candidates = [], opts = {}) {
  const approvedStrategyIds = getApprovedStrategyIds();
  const approvedSet = new Set(approvedStrategyIds);
  const rows = (Array.isArray(candidates) ? candidates : [])
    .map((c) => evaluateCandidate(c, { approvedSet }));
  return {
    ok: true,
    // dryRun is a separate flag so it never collides with the safety `mode`
    // (paper_only) that the spread below stamps on every payload.
    dryRun: true,
    generatedAt: new Date().toISOString(),
    approvedStrategyIds,
    total: rows.length,
    accepted: rows.filter((r) => r.approved).length,
    blocked: rows.filter((r) => !r.approved).length,
    candidates: rows,
    note: 'Dry-run preview — writes nothing. Shows which live candidates WOULD be eligible as approved paper-only simulation. No broker, no live trading, no real orders.',
    source: 'paperApprovalGateService',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  NOT_APPROVED_REASON,
  getApprovedStrategyIds,
  resolveStrategyId,
  isApprovedStrategyId,
  evaluateCandidate,
  previewCandidates,
};
