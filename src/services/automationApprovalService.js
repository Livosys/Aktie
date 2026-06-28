'use strict';

// Manual Approval layer for Trading OS — paper-only, read/append-light.
//
// This service lets a human approve or reject strategies that the read-only
// Automation Plan proposes for FUTURE paper-only testing. Approving a strategy
// ONLY records the user's intent in a small local JSON file. It NEVER starts a
// batch, replay, paper trade or order, never mutates the allowlist, risk,
// scheduler, paper runtime, broker or live-trading state. Safety is always
// locked to paper_only with every action flag false.

const fs = require('fs');
const path = require('path');

const automationPlanService = require('./automationPlanService');
const strategyRuntimeMatrixService = require('./strategyRuntimeMatrixService');
const paperAllowlistConfigService = require('./paperAllowlistConfigService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const MAX_APPROVED = paperAllowlistConfigService.DEFAULT_MAX_APPROVED;
const DATA_FILE = path.resolve(__dirname, '../../data/automation-approvals.json');
const APPROVALS_CACHE_TTL_MS = 15_000;

let _approvalsCache = null;
let _approvalsCachedAt = 0;

// Default in-memory shape. The file is NOT created until the first approve/reject.
function defaultState() {
  return {
    mode: 'manual_approval',
    approvedStrategyIds: [],
    rejectedStrategyIds: [],
    history: [],
  };
}

// Read the persisted approval state. If the file does not exist yet, return the
// empty default WITHOUT creating the file. Corrupt files fall back to default.
function readState() {
  const state = defaultState();
  try {
    if (!fs.existsSync(DATA_FILE)) return state;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state.mode = typeof parsed.mode === 'string' ? parsed.mode : state.mode;
      state.approvedStrategyIds = Array.isArray(parsed.approvedStrategyIds) ? parsed.approvedStrategyIds.filter((x) => typeof x === 'string') : [];
      state.rejectedStrategyIds = Array.isArray(parsed.rejectedStrategyIds) ? parsed.rejectedStrategyIds.filter((x) => typeof x === 'string') : [];
      state.history = Array.isArray(parsed.history) ? parsed.history : [];
    }
  } catch (_) {
    return defaultState();
  }
  return state;
}

// Persist the approval state. Only ever called from approve/reject — and it
// only writes the approval list + history. Safety is re-stamped, never read
// back as a control flag. This touches no runtime, scheduler, risk or broker.
function writeState(state) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = {
    mode: 'manual_approval',
    approvedStrategyIds: state.approvedStrategyIds,
    rejectedStrategyIds: state.rejectedStrategyIds,
    history: state.history,
    safety: SAFETY,
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
}

function invalidateApprovalsCache() {
  _approvalsCache = null;
  _approvalsCachedAt = 0;
}

// Build a read-only snapshot of how a strategy currently looks across the
// runtime matrix and the automation plan, so approve/reject can reason safely.
function inspectStrategy(strategyId) {
  const matrix = strategyRuntimeMatrixService.getStrategyRuntimeMatrix();
  const rows = Array.isArray(matrix.strategies) ? matrix.strategies : [];
  const row = rows.find((r) => r.id === strategyId) || null;

  const plan = automationPlanService.getAutomationPlan();
  const recommendedIds = (plan.recommendedPaperCandidates || []).map((c) => c.id);
  const promisingIds = (plan.promisingNeedsManualApproval || []).map((c) => c.id);
  const blockedIds = (plan.blockedStrategies || []).map((c) => c.id);
  const weakIds = (plan.weakStrategies || []).map((c) => c.id);

  const blockers = row && Array.isArray(row.blockers) ? row.blockers : [];

  return {
    row,
    name: row ? (row.name || row.id) : strategyId,
    existsInMatrix: Boolean(row),
    existsInPlan: recommendedIds.includes(strategyId) || promisingIds.includes(strategyId)
      || blockedIds.includes(strategyId) || weakIds.includes(strategyId)
      || (plan.needsMoreData || []).some((c) => c.id === strategyId),
    isRecommended: recommendedIds.includes(strategyId),
    isPromising: promisingIds.includes(strategyId),
    isBlockedInPlan: blockedIds.includes(strategyId),
    isWeakInPlan: weakIds.includes(strategyId),
    isPausedOrBlocked: Boolean(row && row.automaticStatus === 'pausedOrBlocked'),
    blockers,
    hasBlockers: blockers.length > 0,
    isWeakCandidate: Boolean(row && row.weakCandidate === true),
  };
}

function getMaxApproved() {
  try {
    const config = paperAllowlistConfigService.getPaperAllowlistConfig();
    const value = Number(config && config.maxApproved);
    if (Number.isInteger(value) && value >= paperAllowlistConfigService.MIN_APPROVED && value <= paperAllowlistConfigService.HARD_MAX_APPROVED) {
      return value;
    }
  } catch (_) {
    // Fall through to the default below.
  }
  return MAX_APPROVED;
}

// Validate whether a strategy may be approved. Returns { ok, reason }.
// Approval only records intent; these rules keep the recorded list sane and
// aligned with the read-only plan. They never touch trading state.
function canApprove(strategyId, currentApproved) {
  const info = inspectStrategy(strategyId);

  if (!info.existsInMatrix && !info.existsInPlan) {
    return { ok: false, reason: 'Strategin finns inte i runtime matrix eller automation plan.' };
  }
  // Safety gates — these stay hard blocks. They protect against approving a
  // strategy that is paused/blocked in the runtime or carries active blockers.
  if (info.isPausedOrBlocked || info.isBlockedInPlan) {
    return { ok: false, reason: 'Strategin är pausad eller blockerad i runtime och kan inte godkännas.' };
  }
  if (info.hasBlockers) {
    return { ok: false, reason: `Strategin har aktiva blockers (${info.blockers.join(', ')}) och kan inte godkännas.` };
  }
  const maxApproved = getMaxApproved();
  if (!currentApproved.includes(strategyId) && currentApproved.length >= maxApproved) {
    return { ok: false, reason: `Max ${maxApproved} godkända strategier. Avvisa en innan du godkänner en ny.` };
  }
  // "Weak" is an advisory quality signal, NOT a safety gate. A human manually
  // approving a paper-only candidate is an explicit override of that signal, so
  // it no longer blocks approval — but we surface it as a warning. This is the
  // case that lets manually-surfaced batch/AI candidates (e.g. weak-in-plan
  // strategies) be added to the paper allowlist. Still paper-only; no orders.
  const weak = (info.isWeakCandidate || info.isWeakInPlan) && !info.isPromising;
  return {
    ok: true,
    reason: weak ? 'Approved manually (weak strategy override, paper-only)' : 'Approved from Automation Plan',
    warning: weak ? 'Strategin är klassad som svag i automation plan — godkänd manuellt för paper-only test.' : null,
    info,
  };
}

function approveStrategy(input = {}) {
  const strategyId = typeof input.strategyId === 'string' ? input.strategyId.trim() : '';
  if (!strategyId) return { ok: false, error: 'strategyId krävs.', safety: SAFETY };

  // Optional candidate context — echoed back so the caller can reconcile the
  // exact candidate it approved. Allowlist itself is keyed by strategyId only.
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim() : null;
  const source = typeof input.source === 'string' ? input.source.trim() : null;
  const candidateId = typeof input.candidateId === 'string' ? input.candidateId.trim() : null;
  const timeframe = typeof input.timeframe === 'string' ? input.timeframe.trim() : null;

  const state = readState();
  const alreadyApproved = state.approvedStrategyIds.includes(strategyId);
  const check = canApprove(strategyId, state.approvedStrategyIds);
  if (!check.ok) {
    return {
      ok: false,
      approved: false,
      error: check.reason,
      blockedReason: check.reason,
      strategyId,
      symbol,
      source,
      candidateId,
      timeframe,
      allowlistStatus: alreadyApproved ? 'approved' : 'not_approved',
      safety: SAFETY,
    };
  }

  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'Manual approval from supervisor';

  // Idempotent: approving an already-approved strategy is a no-op success.
  state.rejectedStrategyIds = state.rejectedStrategyIds.filter((id) => id !== strategyId);
  if (!state.approvedStrategyIds.includes(strategyId)) {
    state.approvedStrategyIds.push(strategyId);
  }
  state.history.unshift({
    strategyId,
    symbol: symbol || undefined,
    candidateSource: source || undefined,
    candidateId: candidateId || undefined,
    timeframe: timeframe || undefined,
    action: 'approved',
    reason,
    createdAt: new Date().toISOString(),
    source: 'manual_approval',
  });
  state.history = state.history.slice(0, 200);
  writeState(state);
  invalidateApprovalsCache();

  return {
    ok: true,
    approved: true,
    deduped: alreadyApproved,
    strategyId,
    symbol,
    source,
    candidateId,
    timeframe,
    action: 'approved',
    reason,
    allowlistStatus: 'approved',
    ...(check.warning ? { warning: check.warning } : {}),
    safety: SAFETY,
  };
}

function rejectStrategy(input = {}) {
  const strategyId = typeof input.strategyId === 'string' ? input.strategyId.trim() : '';
  if (!strategyId) return { ok: false, error: 'strategyId krävs.', safety: SAFETY };

  const info = inspectStrategy(strategyId);
  if (!info.existsInMatrix && !info.existsInPlan) {
    return { ok: false, error: 'Strategin finns inte i runtime matrix eller automation plan.', strategyId, safety: SAFETY };
  }

  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'Manual reject from supervisor';

  const state = readState();
  state.approvedStrategyIds = state.approvedStrategyIds.filter((id) => id !== strategyId);
  if (!state.rejectedStrategyIds.includes(strategyId)) {
    state.rejectedStrategyIds.push(strategyId);
  }
  state.history.unshift({
    strategyId,
    action: 'rejected',
    reason,
    createdAt: new Date().toISOString(),
    source: 'manual_approval',
  });
  state.history = state.history.slice(0, 200);
  writeState(state);
  invalidateApprovalsCache();

  return { ok: true, strategyId, action: 'rejected', reason, safety: SAFETY };
}

// Read-only status. Cross-references approvals against the live runtime matrix
// and automation plan so the UI can flag drift (blockers appeared, no longer
// recommended, etc). Never mutates anything.
function getAutomationApprovals() {
  const now = Date.now();
  if (_approvalsCache && (now - _approvalsCachedAt) < APPROVALS_CACHE_TTL_MS) {
    return _approvalsCache;
  }

  const state = readState();
  const config = paperAllowlistConfigService.getPaperAllowlistConfig();
  const recommended = [];
  const recommendedIds = new Set();

  const approved = state.approvedStrategyIds;
  const approvedStillInMatrix = [];
  const approvedWithBlockers = [];
  const approvedNoLongerRecommended = approved.filter((id) => !recommendedIds.has(id));

  // Recommended candidates the user has not yet acted on.
  const waitingForApproval = recommended
    .filter((c) => !approved.includes(c.id) && !state.rejectedStrategyIds.includes(c.id))
    .map((c) => ({ id: c.id, name: c.name, confidence: c.confidence, reason: c.reason }));

  _approvalsCache = {
    ok: true,
    mode: state.mode,
    maxApproved: getMaxApproved(),
    hardMaxApproved: paperAllowlistConfigService.HARD_MAX_APPROVED,
    minApproved: paperAllowlistConfigService.MIN_APPROVED,
    approvedCount: approved.length,
    approvedStrategyIds: approved,
    rejectedStrategyIds: state.rejectedStrategyIds,
    history: state.history,
    approvedStillInMatrix,
    approvedWithBlockers,
    approvedNoLongerRecommended,
    waitingForApproval,
    partial: true,
    warnings: ['automation_plan_skipped_for_fast_read_only_approvals', 'runtime_matrix_skipped_for_fast_read_only_approvals'],
    ...(config.warning ? { configWarning: config.warning } : {}),
    note: 'Detta startar inga tester. Det sparar bara ditt godkännande för framtida paper-only testing.',
    safety: SAFETY,
  };
  _approvalsCachedAt = now;

  return _approvalsCache;
}

function getAutomationApprovalsConfig() {
  return paperAllowlistConfigService.getPaperAllowlistConfig();
}

module.exports = {
  SAFETY,
  MAX_APPROVED,
  getMaxApproved,
  getAutomationApprovalsConfig,
  getAutomationApprovals,
  canApproveStrategy: canApprove,
  approveStrategy,
  rejectStrategy,
};
