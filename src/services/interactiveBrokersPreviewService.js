'use strict';

// Interactive Brokers Paper — Phase 1 read-only / dry-run preview layer.
//
// This module is INTENTIONALLY inert. It exists only to *describe* what an
// Interactive Brokers Paper integration could look like in the future. It does
// NOT connect to any broker, does NOT submit, place, queue or simulate any
// order, and does NOT touch the internal paper trading flow in any way.
//
// It reads the already-approved strategy list from the existing read-only
// paper allowlist source (paperAllowlistService, which in turn reads
// automationApprovalService). It creates NO new approval logic and changes NO
// approval rules. If no approved strategies exist it returns an empty list —
// never an error.
//
// Safety is permanently locked: paper_only, no actions, no orders, no broker,
// no live trading. The feature flags below all default to OFF.

const paperAllowlistService = require('./paperAllowlistService');

// Permanent safety contract — identical to the rest of the paper-only stack.
// These values are frozen and must never become "true" in Phase 1.
const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Future phases are described here purely so the UI can show what is locked.
// NOTHING in this module can unlock them — there is no order/queue/broker code.
// Each future step requires explicit manual approval and a separate build.
const NEXT_PHASE_LOCKED = Object.freeze({
  paperOrderQueue: { locked: true, reason: 'not_implemented_phase_1' },
  brokerExecution: { locked: true, reason: 'not_implemented_phase_1' },
  liveTrading: { locked: true, reason: 'permanently_blocked_paper_only' },
  manualApprovalRequired: true,
});

// Feature flags. All OFF by default. Reading an env var can only ever turn a
// flag ON for *preview rendering* — it can NEVER enable order submission or a
// broker connection, because no such code exists in this module.
function readFlag(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(raw);
}

function getFeatureFlags() {
  return {
    previewEnabled: readFlag('IB_PAPER_PREVIEW_ENABLED'),
    orderQueueEnabled: readFlag('IB_PAPER_ORDER_QUEUE_ENABLED'),
    executionEnabled: readFlag('IB_PAPER_EXECUTION_ENABLED'),
  };
}

// Map the existing read-only allowlist rows into a minimal, IB-preview-shaped
// view. We expose ONLY already-approved strategies. No mutation, no new fields
// that imply execution.
//
// sourceStatus:
//   'ok'       — source read, at least one approved strategy
//   'empty'    — source read, but no approved strategies (not an error)
//   'degraded' — source missing/errored (still ok:true at the endpoint level)
function readApprovedStrategies() {
  let status;
  try {
    status = paperAllowlistService.getPaperAllowlistStatus();
  } catch (err) {
    // Defensive: never throw out of the preview. Treat as a degraded source.
    return {
      approvedStrategies: [],
      sourceAvailable: false,
      sourceStatus: 'degraded',
      sourceError: err.message || String(err),
    };
  }

  if (!status || !Array.isArray(status.allowlist)) {
    return {
      approvedStrategies: [],
      sourceAvailable: false,
      sourceStatus: 'degraded',
      sourceError: 'approval_allowlist_source_unavailable',
    };
  }

  const approvedStrategies = status.allowlist.map((row) => ({
    id: row.id,
    name: row.name || row.id,
    approvedForPaperTesting: row.approvedForPaperTesting === true,
    // Preview-only readiness hint. This reflects the INTERNAL paper-simulation
    // runtime readiness as reported by the existing allowlist — it never means
    // "ready to send an IB order".
    paperRuntimeReady: row.readyForPaperRuntime === true,
    runtimeConnectionStatus: row.runtimeConnectionStatus || 'unknown',
  }));

  return {
    approvedStrategies,
    sourceAvailable: true,
    sourceStatus: approvedStrategies.length === 0 ? 'empty' : 'ok',
    sourceError: null,
  };
}

// Build the canonical IB Paper status payload (Phase 1).
function getIbPaperStatus() {
  const flags = getFeatureFlags();
  const { approvedStrategies, sourceAvailable, sourceStatus, sourceError } = readApprovedStrategies();

  // blockedReason precedence: if the preview feature flag is off, that is the
  // governing reason. Otherwise, order sending is still blocked because Phase 1
  // never builds execution.
  const blockedReason = flags.previewEnabled
    ? 'execution_not_implemented_phase_1'
    : 'feature_flag_disabled';

  return {
    ok: true,
    dryRun: true,
    ibPaper: {
      enabled: false,
      previewEnabled: flags.previewEnabled,
      // orderQueueEnabled mirrors the env flag for transparency, but the queue
      // is ALWAYS blocked (see orderQueueBlocked) — no queue code exists.
      orderQueueEnabled: flags.orderQueueEnabled,
      executionEnabled: flags.executionEnabled,
    },
    safety: { ...SAFETY },
    // Hard, env-independent blocks. These never flip to false in Phase 1.
    orderSendingBlocked: true,
    orderQueueBlocked: true,
    executionBlocked: true,
    // Phase 1 can NEVER create an IB Paper order. This is hard-coded false.
    wouldCreateIbPaperOrder: false,
    blockedReason,
    nextPhaseLocked: { ...NEXT_PHASE_LOCKED },
    approvedStrategies,
    approvedStrategiesCount: approvedStrategies.length,
    approvedStrategiesSource: {
      available: sourceAvailable,
      status: sourceStatus,
      via: 'paperAllowlistService.getPaperAllowlistStatus',
    },
    // The internal paper trading flow is completely separate and untouched.
    internalPaperTradingUnaffected: true,
    sourceError: sourceError || undefined,
    note: 'Read-only Phase 1 preview. No broker connection, no order submission, '
      + 'no order queue, no execution. Internal paper trading is separate and '
      + 'unchanged.',
  };
}

// Approved-strategies-only preview endpoint. Returns an empty list (not an
// error) when nothing is approved, and a degraded status if the source is
// unavailable — always ok:true.
function getApprovedStrategiesPreview() {
  const flags = getFeatureFlags();
  const { approvedStrategies, sourceAvailable, sourceStatus, sourceError } = readApprovedStrategies();

  const explanation = sourceStatus === 'degraded'
    ? 'Approval/allowlist source is unavailable; showing empty list. This is not an error.'
    : (sourceStatus === 'empty'
      ? 'No strategies are approved yet in the existing approval/allowlist source.'
      : 'Only already-approved strategies are shown.');

  return {
    ok: true,
    dryRun: true,
    previewEnabled: flags.previewEnabled,
    degraded: sourceStatus === 'degraded',
    safety: { ...SAFETY },
    approvedStrategies,
    approvedStrategiesCount: approvedStrategies.length,
    approvedStrategiesSource: {
      available: sourceAvailable,
      status: sourceStatus,
      via: 'paperAllowlistService.getPaperAllowlistStatus',
    },
    // What *would* be eligible to preview as IB Paper signals in the future.
    // Still nothing is sent — this is purely descriptive.
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
    blockedReason: flags.previewEnabled ? 'execution_not_implemented_phase_1' : 'feature_flag_disabled',
    internalPaperTradingUnaffected: true,
    sourceError: sourceError || undefined,
    note: explanation + ' No new approval logic. No orders are created or sent.',
  };
}

module.exports = {
  SAFETY,
  NEXT_PHASE_LOCKED,
  getFeatureFlags,
  getIbPaperStatus,
  getApprovedStrategiesPreview,
};
