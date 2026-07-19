'use strict';

const assert = require('assert');
const guard = require('./ibPaperExecutionGuardService');

process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
process.env.IBKR_PAPER_EXECUTION_SHADOW_MODE = 'true';
process.env.IBKR_PAPER_ORDER_SUBMISSION_ENABLED = 'false';

const base = {
  intent: {
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
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('stale_signal'));
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
	  assert.equal(result.allowed, false);
	  assert(result.blockers.includes('strategy_not_active_in_registry'));
	}

{
  const result = guard.evaluatePaperExecutionGuard({
    ...base,
    entryContract: { allowed: false, blockedReason: 'entry_contract_not_approved' },
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('entry_contract_not_approved'));
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

console.log('ibPaperExecutionGuardService.test.js passed');
