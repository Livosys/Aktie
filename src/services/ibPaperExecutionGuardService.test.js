'use strict';

const assert = require('assert');
const guard = require('./ibPaperExecutionGuardService');
const configService = require('./ibPaperExecutionConfigService');

process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
process.env.IBKR_PAPER_EXECUTION_SHADOW_MODE = 'true';
process.env.IBKR_PAPER_ORDER_SUBMISSION_ENABLED = 'false';

configService.readKillSwitch = () => ({ pauseNewEntries: false, reason: null, updatedAt: null });

const base = {
  intent: {
    lifecycleId: 'life-guard-1',
    candidateId: 'cand-guard-1',
    signalId: 'sig-guard-1',
    intentId: 'intent-guard-1',
    executionId: 'exec-guard-1',
    environment: 'paper',
    root: 'MNQ',
    direction: 'long',
    strategyId: 'ema_pullback_continuation',
    idempotencyKey: 'idem-1',
    ageMs: 1000,
    maxSubmitAgeMs: 120000,
    paperAccountIdMasked: 'DU***596',
  },
  candidate: { root: 'MNQ', direction: 'long' },
  contract: {
    root: 'MNQ',
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    conId: 793356225,
    localSymbol: 'MNQU6',
    expiry: '20260918',
  },
  quote: { source: 'ibkr_realtime', simulated: false, delayed: false },
  accountSummary: { ok: true, account: { accountIdMasked: 'DU***596', classification: 'paper' } },
  adapterStatus: { managedAccounts: [{ accountIdMasked: 'DU***596', classification: 'paper' }], port: 4002 },
  adapterVerification: { ok: true, accountIdMasked: 'DU***596', classification: 'paper', live_account_detected: false },
  brokerRisk: { allowed: true, blockers: [] },
  reconciliation: { degraded: false, status: 'ok' },
  executionAllowlist: {
    allowed: true,
    strategyId: 'ema_pullback_continuation',
    status: 'active',
    enabled: true,
    source: 'strategy_registry_execution_allowlist',
  },
  entryContract: { allowed: true },
  idempotency: { duplicate: false },
  session: { isMarketOpen: true, closedReason: null, sessionId: 'overnight' },
  now: new Date('2026-07-15T22:30:00.000Z'),
};

{
  const result = guard.evaluatePaperExecutionGuard(base);
  assert.equal(result.allowed, true);
  assert.equal(result.lifecycleId, 'life-guard-1');
  assert.equal(result.candidateId, 'cand-guard-1');
  assert.equal(result.signalId, 'sig-guard-1');
  assert.equal(result.intentId, 'intent-guard-1');
  assert.equal(result.executionId, 'exec-guard-1');
  assert.equal(result.idempotencyKey, 'idem-1');
  assert.equal(result.verifiedPaperAccount, true);
  assert.equal(result.liveAccountBlocked, true);
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    intent: {
      ...base.intent,
      strategyId: 'mnq_globex_momentum_v1',
    },
    candidate: {
      ...base.candidate,
      strategyId: 'mnq_globex_momentum_v1',
    },
    executionAllowlist: {
      allowed: true,
      strategyId: 'mnq_globex_momentum_v1',
      status: 'active',
      enabled: true,
      source: 'strategy_registry_execution_allowlist',
    },
  });
  assert.equal(result.allowed, true);
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    adapterStatus: { managedAccounts: [{ accountIdMasked: 'U***123', classification: 'live_or_unknown' }] },
    adapterVerification: { ok: false, blocker: 'live_account_detected', live_account_detected: true, liveAccountsMasked: ['U***123'] },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('live_account_detected'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    contract: { ...base.contract, secType: 'CONTFUT', localSymbol: 'MNQCONT' },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('contract_not_fut') || result.blockers.includes('continuous_contract_not_orderable'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    intent: { ...base.intent, environment: 'live' },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('environment_not_paper'));
}

{
  process.env.IBKR_PAPER_EXECUTION_ENABLED = 'false';
  const result = guard.evaluatePaperExecutionGuard(base);
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('ibkr_paper_execution_disabled'));
  process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
}

{
  process.env.IB_GATEWAY_PORT = '4001';
  const result = guard.evaluatePaperExecutionGuard(base);
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('wrong_gateway_port'));
  process.env.IB_GATEWAY_PORT = '4002';
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    adapterVerification: { ok: false, blocker: 'paper_account_not_verified', live_account_detected: false },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('paper_account_not_verified'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    adapterVerification: { ok: false, blocker: 'multiple_paper_accounts', live_account_detected: false },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('multiple_paper_accounts'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    intent: { ...base.intent, ageMs: 180000, maxSubmitAgeMs: 120000 },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('stale_signal'), false);
  const ageCheck = result.checks.find((c) => c.code === 'candidate_age_observed');
  assert.equal(ageCheck.ok, true);
  assert.equal(ageCheck.ageMs, 180000);
  assert.equal(ageCheck.maxSubmitAgeMs, 120000);
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    quote: { source: 'ibkr_realtime', simulated: true, delayed: false },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('quote_not_realtime_ibkr'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    quote: { source: 'ibkr_delayed', simulated: false, delayed: true },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('quote_not_realtime_ibkr'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    contract: { ...base.contract, expiry: '20240119' },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('contract_expired_or_invalid'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    executionAllowlist: {
      allowed: false,
      blockedReason: 'strategy_not_active_in_registry',
      strategyId: 'ema_pullback_continuation',
      status: 'paper_only',
      enabled: true,
      source: 'strategy_registry_execution_allowlist',
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('strategy_not_active_in_registry'), false);
  assert.equal(result.checks.some((check) => check.code === 'strategy_execution_allowlist_passed'), false);
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    entryContract: { allowed: false, blockedReason: 'entry_contract_not_approved' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('entry_contract_not_approved'), false);
  assert.equal(result.checks.some((check) => check.code === 'entry_contract_passed'), false);
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    brokerRisk: { allowed: false, blockedReason: 'broker_risk_blocked', blockers: ['stale_quote'] },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('broker_risk_blocked'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    reconciliation: { degraded: true, status: 'degraded', blockedReason: 'orphan_protective_order' },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('orphan_protective_order'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    idempotency: { duplicate: true, existing: { executionId: 'fxp_existing' } },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('duplicate_intent'));
}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    session: { isMarketOpen: false, closedReason: 'maintenance_break', sessionId: 'maintenance' },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('maintenance_break'));
}

{
  process.env.IBKR_EXECUTION_TARGET = 'ibkr_live';
  process.env.IBKR_LIVE_EXECUTION_ENABLED = 'true';
  process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE = 'true';
  process.env.IBKR_LIVE_ORDER_SUBMISSION_ENABLED = 'false';
  process.env.IBKR_LIVE_BROKER_ENABLED = 'true';
  process.env.IBKR_LIVE_TRADING_ENABLED = 'true';
  process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED = 'true';
  process.env.IBKR_LIVE_GATEWAY_PORT = '4001';
  const result = guard.evaluateExecutionGuard({
    ...base,
    executionTarget: 'ibkr_live',
    intent: {
      ...base.intent,
      environment: 'live',
      executionTarget: 'ibkr_live',
      liveAccountIdMasked: 'U***123',
      paperAccountIdMasked: null,
    },
    accountSummary: { ok: true, account: { accountIdMasked: 'U***123', classification: 'live_or_unknown' } },
    adapterStatus: { managedAccounts: [{ accountIdMasked: 'U***123', classification: 'live_or_unknown' }], port: 4001 },
    adapterVerification: { ok: true, accountIdMasked: 'U***123', classification: 'live_or_unknown', live_account_detected: true },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.executionTarget, 'ibkr_live');
  assert.equal(result.environment, 'live');
  assert.equal(result.verifiedLiveAccount, true);
  assert.equal(result.paperAccountBlocked, true);
  assert.equal(result.paperOnly, false);
  assert.equal(result.live_trading_enabled, true);
  const mismatchedCandidate = guard.evaluateExecutionGuard({
    ...base,
    executionTarget: 'ibkr_live',
    intent: {
      ...base.intent,
      environment: 'live',
      executionTarget: 'ibkr_live',
      liveAccountIdMasked: 'U***123',
      paperAccountIdMasked: null,
    },
    candidate: { ...base.candidate, executionTarget: 'ibkr_paper' },
    accountSummary: { ok: true, account: { accountIdMasked: 'U***123', classification: 'live_or_unknown' } },
    adapterStatus: { managedAccounts: [{ accountIdMasked: 'U***123', classification: 'live_or_unknown' }], port: 4001 },
    adapterVerification: { ok: true, accountIdMasked: 'U***123', classification: 'live_or_unknown', live_account_detected: true },
  });
  assert.equal(mismatchedCandidate.allowed, false);
  assert(mismatchedCandidate.blockers.includes('candidate_execution_target_not_ibkr_live'));
  delete process.env.IBKR_EXECUTION_TARGET;
  delete process.env.IBKR_LIVE_EXECUTION_ENABLED;
  delete process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE;
  delete process.env.IBKR_LIVE_ORDER_SUBMISSION_ENABLED;
  delete process.env.IBKR_LIVE_BROKER_ENABLED;
  delete process.env.IBKR_LIVE_TRADING_ENABLED;
  delete process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED;
  delete process.env.IBKR_LIVE_GATEWAY_PORT;
}

{
  process.env.IBKR_EXECUTION_TARGET = 'ibkr_live';
  process.env.IBKR_LIVE_EXECUTION_ENABLED = 'true';
  process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE = 'true';
  process.env.IBKR_LIVE_BROKER_ENABLED = 'false';
  process.env.IBKR_LIVE_TRADING_ENABLED = 'false';
  process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED = 'false';
  process.env.IBKR_LIVE_GATEWAY_PORT = '4001';
  const result = guard.evaluateExecutionGuard({
    ...base,
    executionTarget: 'ibkr_live',
    intent: {
      ...base.intent,
      environment: 'live',
      executionTarget: 'ibkr_live',
      liveAccountIdMasked: 'U***123',
      paperAccountIdMasked: null,
    },
    accountSummary: { ok: true, account: { accountIdMasked: 'U***123', classification: 'live_or_unknown' } },
    adapterStatus: { managedAccounts: [{ accountIdMasked: 'U***123', classification: 'live_or_unknown' }], port: 4001 },
    adapterVerification: { ok: true, accountIdMasked: 'U***123', classification: 'live_or_unknown', live_account_detected: true },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('live_feature_flag_disabled'));
  delete process.env.IBKR_EXECUTION_TARGET;
  delete process.env.IBKR_LIVE_EXECUTION_ENABLED;
  delete process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE;
  delete process.env.IBKR_LIVE_BROKER_ENABLED;
  delete process.env.IBKR_LIVE_TRADING_ENABLED;
  delete process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED;
  delete process.env.IBKR_LIVE_GATEWAY_PORT;
}

{
  process.env.IBKR_EXECUTION_TARGET = 'ibkr_live';
  process.env.IBKR_LIVE_EXECUTION_ENABLED = 'true';
  process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE = 'true';
  process.env.IBKR_LIVE_BROKER_ENABLED = 'true';
  process.env.IBKR_LIVE_TRADING_ENABLED = 'true';
  process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED = 'true';
  process.env.IBKR_LIVE_GATEWAY_PORT = '4001';
  const result = guard.evaluateExecutionGuard({
    ...base,
    executionTarget: 'ibkr_live',
    intent: {
      ...base.intent,
      environment: 'live',
      executionTarget: 'ibkr_live',
      liveAccountIdMasked: 'U***123',
      paperAccountIdMasked: null,
    },
    accountSummary: { ok: true, account: { accountIdMasked: 'U***123', classification: 'live_or_unknown' } },
    adapterStatus: { managedAccounts: [{ accountIdMasked: 'DU***596', classification: 'paper' }], port: 4001 },
    adapterVerification: { ok: false, blocker: 'paper_account_detected_on_live_target', accountIdMasked: 'DU***596', classification: 'paper' },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('paper_account_detected_on_live_target'));
  delete process.env.IBKR_EXECUTION_TARGET;
  delete process.env.IBKR_LIVE_EXECUTION_ENABLED;
  delete process.env.IBKR_LIVE_EXECUTION_SHADOW_MODE;
  delete process.env.IBKR_LIVE_BROKER_ENABLED;
  delete process.env.IBKR_LIVE_TRADING_ENABLED;
  delete process.env.IBKR_LIVE_ACCOUNT_ORDERS_ALLOWED;
  delete process.env.IBKR_LIVE_GATEWAY_PORT;
}

// ── Weekend entry window observability ───────────────────────────────────────
// CDT (UTC-5): CME:s veckostängning fredag 16:00 CT = 21:00 UTC.
// Helgfönstret loggas men blockerar inte execution.
{
  // Fredag 14:29 CT = 91 min före stängning → utanför fönstret, entry tillåts.
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    now: new Date('2026-07-31T19:29:00.000Z'),
    session: { isMarketOpen: true, closedReason: null, sessionId: 'us_rth' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('weekend_entry_cutoff'), false);
  const check = result.checks.find((c) => c.code === 'weekend_entry_window_observed');
  assert.equal(check.ok, true);
  assert.equal(check.minutesUntilWeeklyClose, 91);
  assert.equal(check.cutoffMinutes, 90);
  assert.equal(check.entryBlocked, false);
}

{
  // Fredag 15:02 CT = 58 min före stängning — exakt tidpunkten då
  // fxp_1d7d8c85a6922fd6 öppnades. Fönstret observeras men blockerar inte.
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    now: new Date('2026-07-31T20:02:30.000Z'),
    session: { isMarketOpen: true, closedReason: null, sessionId: 'us_rth' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('weekend_entry_cutoff'), false);
  const check = result.checks.find((c) => c.code === 'weekend_entry_window_observed');
  assert.equal(check.ok, true);
  assert.equal(check.blocker, null);
  assert.equal(check.minutesUntilWeeklyClose, 58);
  assert.equal(check.cutoffMinutes, 90);
  assert.equal(check.entryBlocked, true);
}

{
  // Exakt på gränsen: fredag 14:30 CT = 90 min → fönstret observeras.
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    now: new Date('2026-07-31T19:30:00.000Z'),
    session: { isMarketOpen: true, closedReason: null, sessionId: 'us_rth' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('weekend_entry_cutoff'), false);
  const check = result.checks.find((c) => c.code === 'weekend_entry_window_observed');
  assert.equal(check.entryBlocked, true);
  assert.equal(check.minutesUntilWeeklyClose, 90);
}

{
  // Övriga handelsdagar är opåverkade: torsdag 15:02 CT, samma klockslag.
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    now: new Date('2026-07-30T20:02:30.000Z'),
    session: { isMarketOpen: true, closedReason: null, sessionId: 'us_rth' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('weekend_entry_cutoff'), false);
  const check = result.checks.find((c) => c.code === 'weekend_entry_window_observed');
  assert.equal(check.minutesUntilWeeklyClose, null);
  assert.equal(check.entryBlocked, false);
}

{
  // Söndagens återöppning 17:01 CT — entries släpps direkt.
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    now: new Date('2026-08-02T22:01:30.000Z'),
    session: { isMarketOpen: true, closedReason: null, sessionId: 'overnight' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('weekend_entry_cutoff'), false);
}

{
  // Grinden går att stänga av via env utan att röra någon annan check.
  process.env.FUTURES_WEEKEND_ENTRY_CUTOFF_ENABLED = 'false';
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    now: new Date('2026-07-31T20:02:30.000Z'),
    session: { isMarketOpen: true, closedReason: null, sessionId: 'us_rth' },
  });
  delete process.env.FUTURES_WEEKEND_ENTRY_CUTOFF_ENABLED;
  assert.equal(result.allowed, true);
  const check = result.checks.find((c) => c.code === 'weekend_entry_window_observed');
  assert.equal(check.ok, true);
  assert.equal(check.weekendEntryCutoffEnabled, false);
  assert.equal(check.entryBlocked, true);
}

{
  // Fönstrets bredd styrs av env.
  process.env.FUTURES_WEEKEND_ENTRY_CUTOFF_MINUTES = '30';
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    now: new Date('2026-07-31T20:02:30.000Z'),
    session: { isMarketOpen: true, closedReason: null, sessionId: 'us_rth' },
  });
  delete process.env.FUTURES_WEEKEND_ENTRY_CUTOFF_MINUTES;
  assert.equal(result.allowed, true, '58 min kvar ligger utanför ett 30-minutersfönster');
}

// ── (7) Signalålder loggas men blockerar inte execution ──
// 48114 ms är den ålder en verklig 2m-kandidat hade i produktion 2026-08-03
// när åldern räknas från candle-stängning i stället för candle-öppning
// (observerad: öppning 13:30:00Z, stängning 13:32:00Z, sedd 13:32:48Z).
// Före ändringen såg guarden 168114 ms och blockerade med stale_signal.
{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    intent: { ...base.intent, ageMs: 48114, maxSubmitAgeMs: 120000 },
  });
  assert.equal(result.allowed, true, '2m-kandidat mätt från stängning ska passera');
  assert.equal(result.blockers.includes('stale_signal'), false);
  const ageCheck = result.checks.find((c) => c.code === 'candidate_age_observed');
  assert.equal(ageCheck.ok, true);
  assert.equal(ageCheck.ageMs, 48114);
  assert.equal(ageCheck.maxSubmitAgeMs, 120000);
}

// Motprovet: samma kandidat mätt från candle-öppning (48114 + 120000) ska
// fortfarande bära åldersdata, men inte blockeras av Production.
{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    intent: { ...base.intent, ageMs: 168114, maxSubmitAgeMs: 120000 },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.blockers.includes('stale_signal'), false);
  const ageCheck = result.checks.find((c) => c.code === 'candidate_age_observed');
  assert.equal(ageCheck.ok, true);
  assert.equal(ageCheck.ageMs, 168114);
  assert.equal(ageCheck.maxSubmitAgeMs, 120000);
}

// Gränsfallet: exakt maxSubmitAgeMs ska passera och åldern ska loggas.
{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    intent: { ...base.intent, ageMs: 120000, maxSubmitAgeMs: 120000 },
  });
  assert.equal(result.blockers.includes('stale_signal'), false);
  const ageCheck = result.checks.find((c) => c.code === 'candidate_age_observed');
  assert.equal(ageCheck.ageMs, 120000);
  assert.equal(ageCheck.maxSubmitAgeMs, 120000);
}

console.log('ibPaperExecutionGuardService.test.js passed');
