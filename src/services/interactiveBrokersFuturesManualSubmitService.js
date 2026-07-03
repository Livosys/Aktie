'use strict';

/**
 * IB Paper Futures — manual submit skeleton (FAS 4.1, NO REAL SUBMIT).
 *
 * This service wraps the existing futures order-ticket preview and adds the
 * future manual-submit response shape. It is intentionally non-executable:
 * no connector is called, no order is built beyond the preview ticket, and all
 * submit status fields stay false even if the reserved futures flag is enabled.
 */

const orderTicketService = require('./interactiveBrokersFuturesOrderTicketService');

const PHASE = 'FAS_4_1_SKELETON_NO_REAL_SUBMIT';
const FUTURES_SUBMIT_FLAG = orderTicketService.FUTURES_SUBMIT_FLAG;
const PAPER_SUBMIT_FLAG = 'IB_PAPER_SUBMIT_ROUTES_ENABLED';
const SAFETY = Object.freeze({ ...orderTicketService.SAFETY });

function envFlagEnabled(name, env = process.env) {
  return ['true', '1', 'yes', 'on'].includes(String(env[name] ?? '').trim().toLowerCase());
}

function unique(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))];
}

function hasText(value) {
  return String(value ?? '').trim() !== '';
}

function buildFuturesManualSubmitSkeleton(opts = {}) {
  const {
    preview = null,
    confirmationPhrase = null,
    env = process.env,
    now = new Date(),
  } = opts;

  const ticketPreview = preview && typeof preview === 'object' ? preview : {};
  const manualGate = ticketPreview.manualGate || {};
  const requiredPhrase = manualGate.requiredConfirmationPhrase || null;
  const providedPhrase = String(confirmationPhrase ?? '').trim();
  const confirmationPhraseProvided = hasText(confirmationPhrase);
  const confirmationPhraseMatched = requiredPhrase !== null && providedPhrase === requiredPhrase;

  const futuresSubmitFlagObserved = envFlagEnabled(FUTURES_SUBMIT_FLAG, env);
  const paperSubmitFlagObserved = envFlagEnabled(PAPER_SUBMIT_FLAG, env);

  const blockers = [
    ...(Array.isArray(ticketPreview.blockers) ? ticketPreview.blockers : []),
    'futures_submit_skeleton_only',
    'real_submit_not_implemented',
  ];

  if (!futuresSubmitFlagObserved) blockers.push('futures_submit_routes_disabled');
  if (!confirmationPhraseProvided) blockers.push('confirmation_phrase_missing');
  else if (!confirmationPhraseMatched) blockers.push('confirmation_phrase_mismatch');

  return {
    ok: true,
    readOnly: true,
    previewOnly: true,
    phase: PHASE,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    dryRun: true,
    wouldSubmit: false,
    submitted: false,
    placeOrderCalled: false,
    submitOrderCalled: false,
    cancelOrderCalled: false,
    futuresSubmitRoutesEnabled: false,
    submitRoutesEnabled: false,
    reservedFuturesSubmitFlagEnabled: futuresSubmitFlagObserved,
    paperSubmitRoutesEnabledObserved: paperSubmitFlagObserved,
    manualConfirmationRequired: true,
    readyForManualSubmit: false,
    confirmationPhraseRequired: true,
    confirmationPhraseProvided,
    confirmationPhraseMatched,
    requiredConfirmationPhrase: requiredPhrase,
    request: ticketPreview.request || null,
    ticket: ticketPreview.ticket || null,
    preview: ticketPreview,
    blockers: unique(blockers),
    safety: { ...SAFETY },
  };
}

module.exports = {
  PHASE,
  SAFETY,
  FUTURES_SUBMIT_FLAG,
  PAPER_SUBMIT_FLAG,
  buildFuturesManualSubmitSkeleton,
  _internal: {
    envFlagEnabled,
    unique,
  },
};
