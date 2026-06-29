'use strict';

/**
 * IB Paper — Manual Approval Layer (preview-only).
 *
 * A separate, explicit gate the user can set AFTER a direction is verified and a
 * blueprint is ready. It records a local approval state with a scope and a short
 * expiry. It is the human "yes, this preview looks right" — it is NOT an order.
 *
 * Hard guarantees:
 *   - Creating/clearing an approval NEVER sends, arms, queues or cancels an
 *     order, never opens a broker connection, never changes any safety flag.
 *   - The approval scope is permanently 'ib_paper_preview_only'. It can raise
 *     paperSubmitReadiness in the preview, but realSubmitAllowed stays false and
 *     submit routes stay hard-gated by IB_PAPER_SUBMIT_ROUTES_ENABLED.
 *   - Approvals expire (default 10 minutes) so a stale approval can never linger.
 */

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STATE_FILE = path.resolve(__dirname, '../../data/ib-paper-trading/manual-approval-state.json');
const APPROVAL_SCOPE = 'ib_paper_preview_only';
const DEFAULT_TTL_MINUTES = 10;

function nowMs(now) {
  return now ? new Date(now).getTime() : Date.now();
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeRaw(payload) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function emptyView(now) {
  return {
    ok: true,
    mode: 'ib_paper_manual_approval',
    manualApprovalReady: false,
    approvedByUser: false,
    approvedAt: null,
    expiresAt: null,
    expired: false,
    secondsRemaining: 0,
    approvalScope: APPROVAL_SCOPE,
    blueprintId: null,
    // submit can NEVER be reached from here.
    realSubmitAllowed: false,
    submitRouteLocked: true,
    nextStep: 'manual_paper_submit_phase_required',
    safety: { ...SAFETY },
  };
}

function viewFromState(state, now) {
  if (!state || !state.approvedAt || !state.expiresAt) return emptyView(now);
  const t = nowMs(now);
  const exp = new Date(state.expiresAt).getTime();
  const expired = !Number.isFinite(exp) || t >= exp;
  const secondsRemaining = expired ? 0 : Math.max(0, Math.round((exp - t) / 1000));
  return {
    ok: true,
    mode: 'ib_paper_manual_approval',
    manualApprovalReady: !expired && state.approvedByUser === true,
    approvedByUser: state.approvedByUser === true && !expired,
    approvedAt: state.approvedAt,
    expiresAt: state.expiresAt,
    expired,
    secondsRemaining,
    approvalScope: APPROVAL_SCOPE,
    blueprintId: state.blueprintId || null,
    symbol: state.symbol || null,
    side: state.side || null,
    realSubmitAllowed: false,
    submitRouteLocked: true,
    nextStep: 'manual_paper_submit_phase_required',
    safety: { ...SAFETY },
  };
}

/** Read-only: current approval state (auto-expiring). */
function getManualApproval(options = {}) {
  return viewFromState(readRaw(), options.now);
}

/**
 * Create a manual approval for a given blueprint. Records approvedByUser=true,
 * approvalScope='ib_paper_preview_only', approvedAt + expiresAt. NEVER submits.
 */
function createManualApproval(input = {}) {
  const now = input.now ? new Date(input.now) : new Date();
  const ttlMinutes = Number(input.ttlMinutes) > 0 ? Number(input.ttlMinutes) : DEFAULT_TTL_MINUTES;
  const approvedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const state = {
    approvedByUser: true,
    approvalScope: APPROVAL_SCOPE,
    approvedAt,
    expiresAt,
    ttlMinutes,
    blueprintId: input.blueprintId ? String(input.blueprintId) : null,
    symbol: input.symbol ? String(input.symbol).toUpperCase() : null,
    side: ['BUY', 'SELL'].includes(String(input.side).toUpperCase()) ? String(input.side).toUpperCase() : null,
    // Persist the safe invariants for auditability.
    realSubmitAllowed: false,
    orderSent: false,
    placeOrderCalled: false,
  };
  const persisted = writeRaw(state);
  const view = viewFromState(persisted ? state : readRaw(), now);
  return { ...view, persisted, created: persisted, ttlMinutes };
}

/** Clear/revoke any current approval. */
function clearManualApproval(options = {}) {
  writeRaw(null);
  return { ...emptyView(options.now), cleared: true };
}

module.exports = {
  SAFETY,
  STATE_FILE,
  APPROVAL_SCOPE,
  DEFAULT_TTL_MINUTES,
  getManualApproval,
  createManualApproval,
  clearManualApproval,
  _internal: { readRaw, writeRaw, viewFromState, emptyView },
};
