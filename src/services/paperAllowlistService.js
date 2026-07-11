'use strict';

// Paper Allowlist — read-only status layer.
//
// Reads the approved strategy list from automationApprovalService and presents
// it as a structured allowlist for future paper-only runtime integration.
// This service NEVER starts tests, changes runtime, enables broker or live
// trading. It only reads and reports. Safety is always paper_only.

const paperStrategyApprovalService = require('./paperStrategyApprovalService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STATUS_CACHE_TTL_MS = 30_000;
let _statusCache = null;
let _statusCachedAt = 0;

function getPaperAllowlistStatus() {
  const now = Date.now();
  if (_statusCache && (now - _statusCachedAt) < STATUS_CACHE_TTL_MS) {
    return _statusCache;
  }

  _statusCache = {
    ...paperStrategyApprovalService.getAllowlistStatus(),
    note: 'Read-only. Reflects ordinary Paper Trading strategy approvals and paper-simulation runtime only — never broker or live trading. Separate from Futures Paper.',
    safety: SAFETY,
  };
  _statusCachedAt = now;

  return _statusCache;
}

module.exports = {
  SAFETY,
  getPaperAllowlistStatus,
};
