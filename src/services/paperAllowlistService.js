'use strict';

// Paper Allowlist — read-only status layer.
//
// Reads the approved strategy list from automationApprovalService and presents
// it as a structured allowlist for future paper-only runtime integration.
// This service NEVER starts tests, changes runtime, enables broker or live
// trading. It only reads and reports. Safety is always paper_only.

const automationApprovalService = require('./automationApprovalService');
const strategyRuntimeMatrixService = require('./strategyRuntimeMatrixService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function getPaperAllowlistStatus() {
  const approvals = automationApprovalService.getAutomationApprovals();
  const matrix = strategyRuntimeMatrixService.getStrategyRuntimeMatrix();
  const matrixMap = {};
  for (const s of (matrix.strategies || [])) {
    matrixMap[s.id] = s;
  }

  const allowlist = approvals.approvedStrategyIds.map((id) => {
    const row = matrixMap[id] || null;
    // The runtime matrix exposes the PAPER (simulation) runtime via
    // `paperRuntimeStatus` ('active' | 'partial' | 'disabled' | ...). An earlier
    // version read a non-existent `row.paperRuntimeActive` field, which forced
    // readyForPaperRuntime to always be 0 even when the paper-simulation runtime
    // was genuinely active. Derive it from the real field instead. This is the
    // paper-simulation runtime only — never broker, live trading or real orders.
    const hasBlockers = row ? (Array.isArray(row.blockers) && row.blockers.length > 0) : false;
    const paperRuntimeActive = row ? row.paperRuntimeStatus === 'active' : false;
    const readyForPaperRuntime = paperRuntimeActive && !hasBlockers;
    return {
      id,
      name: row ? (row.name || id) : id,
      approvedForPaperTesting: true,
      paperRuntimeActive,
      paperRuntimeStatus: row ? (row.paperRuntimeStatus || 'unknown') : 'unknown',
      automaticStatus: row ? (row.automaticStatus || 'unknown') : 'unknown',
      hasBlockers,
      blockers: row ? (row.blockers || []) : [],
      readyForPaperRuntime,
      // Explicit, unambiguous runtime fields so callers never have to infer
      // "is the paper-simulation runtime connected?" from approval status.
      paperRuntimeReady: readyForPaperRuntime,
      runtimeConnectionStatus: !row ? 'unknown' : (readyForPaperRuntime ? 'ready' : 'pending'),
    };
  });

  const readyCount = allowlist.filter((s) => s.readyForPaperRuntime).length;
  const pendingCount = allowlist.filter((s) => !s.readyForPaperRuntime).length;
  const overallRuntimeStatus = allowlist.length === 0
    ? 'unknown'
    : (pendingCount === 0 ? 'ready' : (readyCount === 0 ? 'pending' : 'partial'));

  return {
    ok: true,
    totalApproved: allowlist.length,
    readyForPaperRuntime: readyCount,
    pendingRuntimeConnection: pendingCount,
    // Top-level paper-simulation runtime readiness. paper-only; never broker/live.
    paperRuntimeReady: readyCount > 0,
    runtimeConnectionStatus: overallRuntimeStatus,
    allowlist,
    note: 'Read-only. Reflects the paper-simulation runtime only — never broker or live trading. This does not start any tests or connect anything automatically.',
    safety: SAFETY,
  };
}

module.exports = {
  SAFETY,
  getPaperAllowlistStatus,
};
