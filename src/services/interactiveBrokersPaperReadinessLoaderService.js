'use strict';

const interactiveBrokersPreviewService = require('./interactiveBrokersPreviewService');

const EXPECTED_PAPER_ACCOUNT = 'DUQ565596';

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeReadinessSnapshot(readiness = {}, options = {}) {
  const expectedAccount = safeString(options.expectedAccount || EXPECTED_PAPER_ACCOUNT) || EXPECTED_PAPER_ACCOUNT;
  const managedAccounts = safeArray(readiness.managedAccounts)
    .map((row) => safeString(row))
    .filter(Boolean);
  const explicitSelectedAccount = safeString(readiness.selectedAccount || options.selectedAccount);
  const paperAccountId = safeString(readiness.paperAccountId)
    || managedAccounts.find((row) => /^DU/i.test(row))
    || null;
  const selectedAccount = explicitSelectedAccount
    || paperAccountId
    || managedAccounts.find((row) => row === expectedAccount)
    || (managedAccounts.length === 1 ? managedAccounts[0] : null)
    || null;
  const accountMatches = selectedAccount === expectedAccount
    || paperAccountId === expectedAccount
    || managedAccounts.includes(expectedAccount);
  const ibApiVerified = readiness.ibApiVerified === true;
  const paperAccountVerified = readiness.paperAccountVerified === true;
  const paperModeVerified = readiness.paperModeVerified === true || (ibApiVerified && paperAccountVerified && accountMatches);
  const gatewayReachable = readiness.gatewayReachable === true;
  const sessionVerified = readiness.sessionVerified === true || (ibApiVerified && paperAccountVerified && accountMatches);
  const blockers = [];

  if (!gatewayReachable) blockers.push('ib_gateway_unreachable');
  if (!ibApiVerified) blockers.push('ib_api_not_verified');
  if (!paperAccountVerified) blockers.push('paper_account_not_verified');
  if (!paperModeVerified) blockers.push('paper_mode_not_verified');
  if (!sessionVerified) blockers.push('session_not_verified');
  if (!selectedAccount) blockers.push('selected_account_missing');
  if (!accountMatches) blockers.push('paper_account_mismatch');

  return {
    source: options.source || 'live_connection_readiness',
    loadedAt: options.loadedAt || new Date().toISOString(),
    ok: options.ok !== false,
    gatewayReachable,
    ibApiVerified,
    paperAccountVerified,
    paperModeVerified,
    sessionVerified,
    paperAccountId,
    selectedAccount,
    managedAccounts,
    expectedAccount,
    accountMatches,
    blockedReason: options.blockedReason || readiness.blockedReason || blockers[0] || null,
    blockers,
    error: options.error || readiness.error || null,
    nextValidId: readiness.nextValidId ?? null,
    status: readiness.status || null,
    selectedAccountExists: Boolean(selectedAccount),
    selectedAccountMatchesPaper: accountMatches,
    liveReadinessLoaded: options.source === 'live_connection_readiness',
    staleTruthUsed: options.source === 'stale_truth_fallback',
    liveReadinessError: options.liveReadinessError || null,
  };
}

async function loadLiveIbPaperReadinessForPreflight(options = {}) {
  const expectedAccount = safeString(options.expectedAccount || EXPECTED_PAPER_ACCOUNT) || EXPECTED_PAPER_ACCOUNT;
  const staleReadiness = options.staleReadiness || options.readiness || null;
  const loadedAt = new Date().toISOString();
  const getConnectionReadiness = typeof options.getConnectionReadiness === 'function'
    ? options.getConnectionReadiness
    : interactiveBrokersPreviewService.getConnectionReadiness;

  try {
    const liveReadiness = options.liveReadiness || await getConnectionReadiness();
    if (!liveReadiness || typeof liveReadiness !== 'object') {
      throw new Error('live_connection_readiness_empty');
    }
    return normalizeReadinessSnapshot(liveReadiness, {
      expectedAccount,
      selectedAccount: options.selectedAccount,
      source: 'live_connection_readiness',
      loadedAt,
      ok: true,
    });
  } catch (err) {
    const liveReadinessError = err?.message || String(err);
    const fallback = normalizeReadinessSnapshot(staleReadiness || {}, {
      expectedAccount,
      selectedAccount: options.selectedAccount,
      source: 'stale_truth_fallback',
      loadedAt,
      ok: false,
      blockedReason: 'live_readiness_unavailable',
      error: liveReadinessError,
      liveReadinessError,
    });
    return {
      ...fallback,
      blockers: ['live_readiness_unavailable', ...fallback.blockers.filter((row) => row !== 'live_readiness_unavailable')],
      blockedReason: 'live_readiness_unavailable',
      liveReadinessLoaded: false,
      staleTruthUsed: Boolean(staleReadiness),
    };
  }
}

module.exports = {
  EXPECTED_PAPER_ACCOUNT,
  loadLiveIbPaperReadinessForPreflight,
  normalizeReadinessSnapshot,
  _internal: {
    safeString,
    safeArray,
  },
};
