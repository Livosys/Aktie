'use strict';

const assert = require('assert/strict');

const svc = require('./interactiveBrokersPaperReadinessNormalizerService');

function preflightSnapshot(overrides = {}) {
  return {
    source: 'preflight_session_snapshot_verified',
    loadedAt: '2026-06-22T08:29:00.000Z',
    sessionVerified: true,
    selectedAccount: 'DUQ565596',
    paperAccountId: 'DUQ565596',
    accountMatches: true,
    managedAccounts: ['DUQ565596'],
    ...overrides,
  };
}

function liveSnapshot(overrides = {}) {
  return {
    source: 'live_connection_readiness',
    loadedAt: '2026-06-22T08:28:50.000Z',
    gatewayReachable: true,
    ibApiVerified: true,
    paperAccountVerified: true,
    paperModeVerified: true,
    sessionVerified: true,
    selectedAccount: 'DUQ565596',
    paperAccountId: 'DUQ565596',
    managedAccounts: ['DUQ565596'],
    accountMatches: true,
    ...overrides,
  };
}

async function main() {
  const live = svc.normalizeIbPaperReadinessSnapshot(liveSnapshot(), { expectedAccount: 'DUQ565596' });
  assert.equal(live.source, 'live_connection_readiness');
  assert.equal(live.ibApiVerified, true);
  assert.equal(live.paperAccountVerified, true);
  assert.equal(live.sessionVerified, true);
  assert.equal(live.blockedReason, null);
  assert.deepEqual(live.blockers, []);

  const mergedLiveWins = svc.mergeLiveAndPreflightReadiness({
    liveSnapshot: liveSnapshot(),
    preflightSnapshot: preflightSnapshot(),
    expectedAccount: 'DUQ565596',
    maxPreflightAgeMs: 30000,
    now: new Date('2026-06-22T08:29:30.000Z').getTime(),
  });
  assert.equal(mergedLiveWins.source, 'live_connection_readiness');
  assert.equal(mergedLiveWins.ibApiVerified, true);
  assert.equal(mergedLiveWins.paperAccountVerified, true);
  assert.equal(mergedLiveWins.sessionVerified, true);
  assert.equal(mergedLiveWins.accountMatches, true);
  assert.deepEqual(mergedLiveWins.blockers, []);

  const mergedPreflightWins = svc.mergeLiveAndPreflightReadiness({
    liveSnapshot: liveSnapshot({ ok: false, gatewayReachable: false, ibApiVerified: false, paperAccountVerified: false, paperModeVerified: false, sessionVerified: false, source: 'stale_truth_fallback', blockedReason: 'live_readiness_unavailable' }),
    preflightSnapshot: preflightSnapshot({
      ibApiVerified: false,
      paperAccountVerified: false,
      paperModeVerified: false,
      gatewayReachable: false,
      ageMs: 1000,
    }),
    expectedAccount: 'DUQ565596',
    maxPreflightAgeMs: 30000,
    now: new Date('2026-06-22T08:29:30.000Z').getTime(),
  });
  assert.equal(mergedPreflightWins.source, 'preflight_session_snapshot_verified');
  assert.equal(mergedPreflightWins.sourceDetail, 'derived_from_verified_session');
  assert.equal(mergedPreflightWins.ibApiVerified, true);
  assert.equal(mergedPreflightWins.paperAccountVerified, true);
  assert.equal(mergedPreflightWins.sessionVerified, true);
  assert.equal(mergedPreflightWins.accountMatches, true);
  assert.equal(mergedPreflightWins.blockedReason, null);
  assert.equal(mergedPreflightWins.stale, false);

  const derivedFromSession = svc.normalizeIbPaperReadinessSnapshot(preflightSnapshot({
    ibApiVerified: false,
    paperAccountVerified: false,
    gatewayReachable: false,
    selectedAccount: 'DUQ565596',
    paperAccountId: 'DUQ565596',
    accountMatches: true,
  }), { source: 'preflight_session_snapshot_verified', expectedAccount: 'DUQ565596', allowDerivedReadiness: true });
  assert.equal(derivedFromSession.ibApiVerified, true);
  assert.equal(derivedFromSession.paperAccountVerified, true);
  assert.equal(derivedFromSession.sessionVerified, true);
  assert.equal(derivedFromSession.blockers.includes('ib_api_not_verified'), false);

  const stalePreflight = svc.mergeLiveAndPreflightReadiness({
    liveSnapshot: liveSnapshot({ ok: false, gatewayReachable: false, ibApiVerified: false, paperAccountVerified: false, paperModeVerified: false, sessionVerified: false, source: 'stale_truth_fallback', blockedReason: 'live_readiness_unavailable' }),
    preflightSnapshot: preflightSnapshot({
      loadedAt: '2026-06-22T08:28:00.000Z',
      ibApiVerified: false,
      paperAccountVerified: false,
      gatewayReachable: false,
    }),
    expectedAccount: 'DUQ565596',
    maxPreflightAgeMs: 1000,
    now: new Date('2026-06-22T08:29:30.000Z').getTime(),
  });
  assert.equal(stalePreflight.blockedReason, 'preflight_session_snapshot_stale');
  assert.equal(stalePreflight.stale, true);
  assert.ok(stalePreflight.blockers.includes('preflight_session_snapshot_stale'));

  const wrongAccount = svc.normalizeIbPaperReadinessSnapshot(preflightSnapshot({
    selectedAccount: 'DUQ111111',
    paperAccountId: 'DUQ111111',
    accountMatches: false,
    managedAccounts: ['DUQ111111'],
  }), { source: 'preflight_session_snapshot_verified', expectedAccount: 'DUQ565596', allowDerivedReadiness: true });
  assert.equal(wrongAccount.blockedReason, 'paper_account_mismatch');
  assert.ok(wrongAccount.blockers.includes('paper_account_mismatch'));

  const missingAccount = svc.normalizeIbPaperReadinessSnapshot(preflightSnapshot({
    selectedAccount: null,
    paperAccountId: null,
    managedAccounts: [],
    accountMatches: false,
  }), { source: 'preflight_session_snapshot_verified', expectedAccount: 'DUQ565596', allowDerivedReadiness: true });
  assert.equal(missingAccount.blockedReason, 'selected_account_missing');
  assert.ok(missingAccount.blockers.includes('selected_account_missing'));

  console.log('interactiveBrokersPaperReadinessNormalizerService.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
