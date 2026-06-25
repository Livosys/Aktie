'use strict';

const EXPECTED_PAPER_ACCOUNT = 'DUQ565596';
const FRESH_PRELIGHT_MAX_AGE_MS = 30_000;

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildReadinessBlockers(snapshot = {}) {
  const blockers = [];
  if (snapshot.stale === true) blockers.push('preflight_session_snapshot_stale');
  if (snapshot.source === 'stale_truth_fallback' && snapshot.liveReadinessLoaded === false) blockers.push('live_readiness_unavailable');
  if (snapshot.gatewayReachable !== true && snapshot.source !== 'preflight_session_snapshot_verified') blockers.push('ib_gateway_unreachable');
  if (!snapshot.selectedAccount) blockers.push('selected_account_missing');
  else if (snapshot.accountMatches !== true) blockers.push('paper_account_mismatch');
  if (snapshot.accountMatches === true && snapshot.ibApiVerified !== true) blockers.push('ib_api_not_verified');
  if (snapshot.paperAccountVerified !== true) blockers.push('paper_account_not_verified');
  if (snapshot.paperModeVerified !== true) blockers.push('paper_mode_not_verified');
  if (snapshot.sessionVerified !== true) blockers.push('session_not_verified');
  return blockers;
}

function normalizeIbPaperReadinessSnapshot(input = {}, options = {}) {
  const expectedAccount = safeString(options.expectedAccount || input.expectedAccount || EXPECTED_PAPER_ACCOUNT) || EXPECTED_PAPER_ACCOUNT;
  const managedAccounts = safeArray(input.managedAccounts).map((row) => safeString(row)).filter(Boolean);
  const rawSelectedAccount = safeString(options.selectedAccount || input.selectedAccount);
  const paperAccountId = safeString(input.paperAccountId) || managedAccounts.find((row) => /^DU/i.test(row)) || null;
  const selectedAccount = rawSelectedAccount || paperAccountId || managedAccounts.find((row) => row === expectedAccount) || (managedAccounts.length === 1 ? managedAccounts[0] : null) || null;
  const accountMatches = Boolean(selectedAccount) && (selectedAccount === expectedAccount || paperAccountId === expectedAccount || managedAccounts.includes(expectedAccount));
  const gatewayReachable = input.gatewayReachable === true;
  const hasExplicitIbApiVerified = input.ibApiVerified === true || input.apiVerified === true || input.paperAccountVerified === true || gatewayReachable;
  const sessionVerified = input.sessionVerified === true || (accountMatches && (hasExplicitIbApiVerified || gatewayReachable || input.paperModeVerified === true));
  const allowDerived = options.allowDerivedReadiness !== false;
  const derivedFromVerifiedSession = allowDerived && sessionVerified === true && accountMatches === true;
  const ibApiVerified = input.ibApiVerified === true || (derivedFromVerifiedSession && (options.source === 'preflight_session_snapshot_verified' || options.allowDerivedReadiness === true));
  const paperAccountVerified = input.paperAccountVerified === true || derivedFromVerifiedSession;
  const paperModeVerified = input.paperModeVerified === true || (derivedFromVerifiedSession && paperAccountVerified === true);
  const normalizedGatewayReachable = gatewayReachable || (derivedFromVerifiedSession && options.source === 'preflight_session_snapshot_verified');
  const loadedAt = safeString(input.loadedAt) || safeString(options.loadedAt) || null;
  const ageMs = safeNumber(input.ageMs ?? options.ageMs);
  const stale = input.stale === true || (Number.isFinite(ageMs) ? ageMs > FRESH_PRELIGHT_MAX_AGE_MS : false);
  const source = safeString(options.source || input.source || 'connection_readiness') || 'connection_readiness';
  const sourceDetail = safeString(options.sourceDetail || input.sourceDetail || (derivedFromVerifiedSession ? 'derived_from_verified_session' : source === 'live_connection_readiness' ? 'live_connection_readiness' : 'preflight_session_snapshot')) || null;
  const blockers = buildReadinessBlockers({
    source,
    stale,
    gatewayReachable: normalizedGatewayReachable,
    ibApiVerified,
    paperAccountVerified,
    paperModeVerified,
    sessionVerified,
    selectedAccount,
    accountMatches,
  });

  return {
    source,
    sourceDetail,
    ok: input.ok !== false,
    gatewayReachable: normalizedGatewayReachable,
    ibApiVerified,
    paperAccountVerified,
    paperModeVerified,
    sessionVerified,
    selectedAccount,
    paperAccountId: paperAccountId || expectedAccount || null,
    managedAccounts,
    expectedAccount,
    accountMatches,
    blockedReason: input.blockedReason || blockers[0] || null,
    blockers,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    loadedAt,
    stale,
    liveReadinessLoaded: input.liveReadinessLoaded === true || source === 'live_connection_readiness',
    staleTruthUsed: input.staleTruthUsed === true || source === 'stale_truth_fallback',
    liveReadinessError: input.liveReadinessError || null,
    nextValidId: input.nextValidId ?? null,
    selectedAccountExists: Boolean(selectedAccount),
    selectedAccountMatchesPaper: accountMatches,
    error: input.error || null,
  };
}

function mergeLiveAndPreflightReadiness({
  liveSnapshot = null,
  preflightSnapshot = null,
  expectedAccount = EXPECTED_PAPER_ACCOUNT,
  maxPreflightAgeMs = FRESH_PRELIGHT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  const nowMs = Number.isFinite(Number(now))
    ? Number(now)
    : (() => {
        const parsed = new Date(now).getTime();
        return Number.isFinite(parsed) ? parsed : Date.now();
      })();
  const liveNormalized = liveSnapshot ? normalizeIbPaperReadinessSnapshot(liveSnapshot, {
    expectedAccount,
    source: safeString(liveSnapshot.source) || 'live_connection_readiness',
    sourceDetail: safeString(liveSnapshot.sourceDetail) || 'live_connection_readiness',
    loadedAt: liveSnapshot.loadedAt || new Date(nowMs).toISOString(),
    allowDerivedReadiness: false,
  }) : null;

  const preflightAgeMs = safeNumber(preflightSnapshot?.ageMs)
    ?? (() => {
      const loadedAt = safeString(preflightSnapshot?.loadedAt || preflightSnapshot?.generatedAt || preflightSnapshot?.createdAt);
      if (!loadedAt) return null;
      const parsed = new Date(loadedAt).getTime();
      return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
    })();

  const preflightFresh = preflightSnapshot
    && (preflightAgeMs === null || preflightAgeMs <= maxPreflightAgeMs);
  const preflightNormalized = preflightSnapshot ? normalizeIbPaperReadinessSnapshot(preflightSnapshot, {
    expectedAccount,
    source: 'preflight_session_snapshot_verified',
    sourceDetail: 'derived_from_verified_session',
    loadedAt: preflightSnapshot.loadedAt || preflightSnapshot.generatedAt || new Date(nowMs).toISOString(),
    ageMs: preflightAgeMs,
    allowDerivedReadiness: true,
  }) : null;

  if (liveNormalized?.ibApiVerified === true && liveNormalized?.paperAccountVerified === true && liveNormalized?.sessionVerified === true && liveNormalized?.accountMatches === true) {
    return {
      ...liveNormalized,
      source: 'live_connection_readiness',
      sourceDetail: liveNormalized.sourceDetail || 'live_connection_readiness',
      stale: false,
      ageMs: liveNormalized.ageMs ?? null,
      blockedReason: liveNormalized.blockedReason || null,
      blockers: buildReadinessBlockers(liveNormalized).filter(Boolean),
    };
  }

  if (preflightNormalized && preflightFresh && preflightNormalized.sessionVerified === true && preflightNormalized.accountMatches === true) {
    const derived = normalizeIbPaperReadinessSnapshot({
      ...preflightNormalized,
      ibApiVerified: preflightNormalized.ibApiVerified === true || preflightNormalized.sessionVerified === true,
      paperAccountVerified: preflightNormalized.paperAccountVerified === true || preflightNormalized.sessionVerified === true,
      paperModeVerified: preflightNormalized.paperModeVerified === true || preflightNormalized.sessionVerified === true,
      gatewayReachable: preflightNormalized.gatewayReachable === true || preflightNormalized.sessionVerified === true,
      source: 'preflight_session_snapshot_verified',
      sourceDetail: 'derived_from_verified_session',
      stale: false,
      ageMs: preflightAgeMs,
    }, {
      expectedAccount,
      source: 'preflight_session_snapshot_verified',
      sourceDetail: 'derived_from_verified_session',
      loadedAt: preflightNormalized.loadedAt || new Date(nowMs).toISOString(),
      ageMs: preflightAgeMs,
      allowDerivedReadiness: true,
    });
    return {
      ...derived,
      source: 'preflight_session_snapshot_verified',
      sourceDetail: 'derived_from_verified_session',
      stale: false,
      ageMs: preflightAgeMs,
      blockers: buildReadinessBlockers(derived).filter(Boolean),
      blockedReason: null,
    };
  }

  if (preflightNormalized && preflightFresh && preflightNormalized.sessionVerified === true && preflightNormalized.accountMatches !== true) {
    return {
      ...preflightNormalized,
      source: 'preflight_session_snapshot_verified',
      sourceDetail: 'derived_from_verified_session',
      stale: false,
      ageMs: preflightAgeMs,
      blockers: buildReadinessBlockers(preflightNormalized).filter(Boolean),
      blockedReason: preflightNormalized.accountMatches === false ? 'paper_account_mismatch' : preflightNormalized.blockedReason || 'preflight_session_snapshot_stale',
    };
  }

  if (preflightNormalized && preflightFresh) {
    return {
      ...preflightNormalized,
      source: 'preflight_session_snapshot_verified',
      sourceDetail: preflightNormalized.sourceDetail || null,
      stale: false,
      ageMs: preflightAgeMs,
      blockers: buildReadinessBlockers(preflightNormalized).filter(Boolean),
      blockedReason: preflightNormalized.blockedReason || buildReadinessBlockers(preflightNormalized)[0] || null,
    };
  }

  if (preflightSnapshot && !preflightFresh) {
    const staleSnapshot = normalizeIbPaperReadinessSnapshot(preflightSnapshot, {
      expectedAccount,
      source: 'preflight_session_snapshot_verified',
      sourceDetail: 'derived_from_verified_session',
      loadedAt: preflightSnapshot.loadedAt || preflightSnapshot.generatedAt || new Date(nowMs).toISOString(),
      ageMs: preflightAgeMs,
      allowDerivedReadiness: true,
    });
    return {
      ...staleSnapshot,
      source: 'preflight_session_snapshot_verified',
      sourceDetail: staleSnapshot.sourceDetail || 'derived_from_verified_session',
      stale: true,
      ageMs: preflightAgeMs,
      blockedReason: 'preflight_session_snapshot_stale',
      blockers: ['preflight_session_snapshot_stale', ...buildReadinessBlockers(staleSnapshot).filter((row) => row !== 'preflight_session_snapshot_stale')],
    };
  }

  if (liveNormalized) {
    return {
      ...liveNormalized,
      blockedReason: liveNormalized.blockedReason || 'live_readiness_unavailable',
      blockers: buildReadinessBlockers(liveNormalized).filter(Boolean),
    };
  }

  return {
    source: 'preflight_session_snapshot_verified',
    sourceDetail: 'derived_from_verified_session',
    ok: false,
    gatewayReachable: false,
    ibApiVerified: false,
    paperAccountVerified: false,
    paperModeVerified: false,
    sessionVerified: false,
    selectedAccount: null,
    paperAccountId: null,
    managedAccounts: [],
    expectedAccount,
    accountMatches: false,
    blockedReason: 'live_readiness_unavailable',
    blockers: ['live_readiness_unavailable'],
    ageMs: null,
    loadedAt: new Date(nowMs).toISOString(),
    stale: true,
    liveReadinessLoaded: false,
    staleTruthUsed: true,
    liveReadinessError: null,
    nextValidId: null,
    selectedAccountExists: false,
    selectedAccountMatchesPaper: false,
    error: 'live_readiness_unavailable',
  };
}

module.exports = {
  EXPECTED_PAPER_ACCOUNT,
  FRESH_PRELIGHT_MAX_AGE_MS,
  normalizeIbPaperReadinessSnapshot,
  mergeLiveAndPreflightReadiness,
  buildReadinessBlockers,
  _internal: {
    safeString,
    safeArray,
    safeNumber,
  },
};
