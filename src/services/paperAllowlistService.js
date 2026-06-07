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
    return {
      id,
      name: row ? (row.name || id) : id,
      approvedForPaperTesting: true,
      paperRuntimeActive: row ? Boolean(row.paperRuntimeActive) : false,
      automaticStatus: row ? (row.automaticStatus || 'unknown') : 'unknown',
      hasBlockers: row ? (Array.isArray(row.blockers) && row.blockers.length > 0) : false,
      blockers: row ? (row.blockers || []) : [],
      readyForPaperRuntime: row
        ? (Boolean(row.paperRuntimeActive) && (!row.blockers || row.blockers.length === 0))
        : false,
    };
  });

  const readyCount = allowlist.filter((s) => s.readyForPaperRuntime).length;
  const pendingCount = allowlist.filter((s) => !s.readyForPaperRuntime).length;

  return {
    ok: true,
    totalApproved: allowlist.length,
    readyForPaperRuntime: readyCount,
    pendingRuntimeConnection: pendingCount,
    allowlist,
    note: 'Read-only. This does not start any tests or connect paper runtime automatically.',
    safety: SAFETY,
  };
}

module.exports = {
  SAFETY,
  getPaperAllowlistStatus,
};
