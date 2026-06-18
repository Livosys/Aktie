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
function readApprovedStrategies() {
  let status;
  try {
    status = paperAllowlistService.getPaperAllowlistStatus();
  } catch (err) {
    // Defensive: never throw out of the preview. Treat as empty.
    return { approvedStrategies: [], sourceError: err.message || String(err) };
  }

  const rows = Array.isArray(status?.allowlist) ? status.allowlist : [];
  const approvedStrategies = rows.map((row) => ({
    id: row.id,
    name: row.name || row.id,
    approvedForPaperTesting: row.approvedForPaperTesting === true,
    // Preview-only readiness hint. This reflects the INTERNAL paper-simulation
    // runtime readiness as reported by the existing allowlist — it never means
    // "ready to send an IB order".
    paperRuntimeReady: row.readyForPaperRuntime === true,
    runtimeConnectionStatus: row.runtimeConnectionStatus || 'unknown',
  }));

  return { approvedStrategies, sourceError: null };
}

// Build the canonical IB Paper status payload (Phase 1).
function getIbPaperStatus() {
  const flags = getFeatureFlags();
  const { approvedStrategies, sourceError } = readApprovedStrategies();

  // blockedReason precedence: if the preview feature flag is off, that is the
  // governing reason. Otherwise, order sending is still blocked because Phase 1
  // never builds execution.
  let blockedReason;
  if (!flags.previewEnabled) {
    blockedReason = 'feature_flag_disabled';
  } else {
    // Preview rendering allowed, but order sending is permanently blocked here.
    blockedReason = 'execution_not_implemented_phase_1';
  }

  return {
    ok: true,
    dryRun: true,
    ibPaper: {
      enabled: false,
      previewEnabled: flags.previewEnabled,
      orderQueueEnabled: flags.orderQueueEnabled,
      executionEnabled: flags.executionEnabled,
    },
    safety: { ...SAFETY },
    approvedStrategies,
    approvedStrategiesCount: approvedStrategies.length,
    // Phase 1 can NEVER create an IB Paper order. This is hard-coded false.
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
    blockedReason,
    // The internal paper trading flow is completely separate and untouched.
    internalPaperTradingUnaffected: true,
    sourceError: sourceError || undefined,
    note: 'Read-only Phase 1 preview. No broker connection, no order submission, '
      + 'no order queue, no execution. Internal paper trading is separate and '
      + 'unchanged.',
  };
}

// Approved-strategies-only preview endpoint. Returns an empty list (not an
// error) when nothing is approved.
function getApprovedStrategiesPreview() {
  const flags = getFeatureFlags();
  const { approvedStrategies, sourceError } = readApprovedStrategies();

  return {
    ok: true,
    dryRun: true,
    previewEnabled: flags.previewEnabled,
    safety: { ...SAFETY },
    approvedStrategies,
    approvedStrategiesCount: approvedStrategies.length,
    // What *would* be eligible to preview as IB Paper signals in the future.
    // Still nothing is sent — this is purely descriptive.
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
    blockedReason: flags.previewEnabled ? 'execution_not_implemented_phase_1' : 'feature_flag_disabled',
    internalPaperTradingUnaffected: true,
    sourceError: sourceError || undefined,
    note: 'Only already-approved strategies are shown. No new approval logic. '
      + 'No orders are created or sent.',
  };
}

module.exports = {
  SAFETY,
  getFeatureFlags,
  getIbPaperStatus,
  getApprovedStrategiesPreview,
};
