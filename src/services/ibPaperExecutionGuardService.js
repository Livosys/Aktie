'use strict';

const configService = require('./ibPaperExecutionConfigService');
const adapterModule = require('./ibFuturesDataAdapterService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  paper_trading_enabled: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'ib_paper_execution_guard',
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function addCheck(checks, code, ok, blocker, detail = {}) {
  checks.push({
    code,
    ok: ok === true,
    blocker: ok === true ? null : blocker,
    ...detail,
  });
}

function maskAccount(accountId) {
  return adapterModule.maskAccountId(accountId);
}

function classifyManagedAccounts(rows = []) {
  const accounts = rows.map((row) => {
    if (typeof row === 'string') {
      return { accountIdMasked: maskAccount(row), classification: adapterModule.classifyAccountId(row) };
    }
    return {
      accountIdMasked: row.accountIdMasked || maskAccount(row.accountId || row.account),
      classification: row.classification || adapterModule.classifyAccountId(row.accountId || row.account || ''),
    };
  }).filter((row) => row.accountIdMasked);
  return {
    accounts,
    paperAccounts: accounts.filter((row) => row.classification === 'paper'),
    liveOrUnknownAccounts: accounts.filter((row) => row.classification !== 'paper'),
  };
}

function normalizeRoot(value) {
  return String(value || '').trim().toUpperCase();
}

function expiryIsValid(expiry, now = new Date()) {
  const raw = String(expiry || '').slice(0, 8);
  if (!/^\d{8}$/.test(raw)) return false;
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const expiryDate = Date.UTC(y, m - 1, d, 23, 59, 59);
  return Number.isFinite(expiryDate) && expiryDate >= new Date(now).getTime();
}

function validateContract(contract = {}, root, now = new Date()) {
  const normalizedRoot = normalizeRoot(root || contract.root || contract.symbol);
  const checks = [];
  const localSymbol = String(contract.localSymbol || '').toUpperCase();
  const secType = String(contract.secType || '').toUpperCase();
  const exchange = String(contract.exchange || '').toUpperCase();
  const currency = String(contract.currency || '').toUpperCase();
  const expiry = contract.expiry || contract.lastTradeDateOrContractMonth || null;
  addCheck(checks, 'contract_present', Boolean(contract), 'contract_missing');
  addCheck(checks, 'contract_is_future', secType === 'FUT', 'contract_not_fut', { secType });
  addCheck(checks, 'contract_exchange_cme', exchange === 'CME', 'contract_wrong_exchange', { exchange });
  addCheck(checks, 'contract_currency_usd', currency === 'USD', 'contract_wrong_currency', { currency });
  addCheck(checks, 'contract_has_conid', Number.isFinite(Number(contract.conId)) && Number(contract.conId) > 0, 'contract_conid_missing', { conId: contract.conId ?? null });
  addCheck(checks, 'contract_has_local_symbol', Boolean(localSymbol), 'contract_local_symbol_missing', { localSymbol: localSymbol || null });
  addCheck(checks, 'contract_root_matches_allowlist', localSymbol.startsWith(normalizedRoot) || String(contract.root || '').toUpperCase() === normalizedRoot, 'contract_root_mismatch', { root: normalizedRoot, localSymbol: localSymbol || null });
  addCheck(checks, 'contract_expiry_valid', expiryIsValid(expiry, now), 'contract_expired_or_invalid', { expiry });
  addCheck(checks, 'not_continuous_future', secType !== 'CONTFUT' && !/CONT/i.test(localSymbol), 'continuous_contract_not_orderable', { secType, localSymbol: localSymbol || null });
  return {
    ok: checks.every((check) => check.ok),
    checks,
    blockers: checks.filter((check) => check.ok !== true).map((check) => check.blocker || check.code),
  };
}

function entryContractApproved(evidence = {}) {
  return evidence?.allowed === true
    || evidence?.entryContractApproved === true
    || evidence?.entryContract?.allowed === true
    || evidence?.paperEntryContract?.allowed === true;
}

function strategyExecutionAllowed(evidence = {}) {
  return evidence?.allowed === true
    || evidence?.executionAllowed === true
    || evidence?.strategyExecutionAllowed === true
    || evidence?.executionAllowlist?.allowed === true;
}

function evaluatePaperExecutionGuard({
  intent = {},
  candidate = {},
  contract = {},
  quote = null,
  accountSummary = null,
  adapterStatus = null,
  adapterVerification = null,
  brokerRisk = null,
  reconciliation = null,
  executionAllowlist = null,
  entryContract = null,
  idempotency = null,
  session = null,
  now = new Date(),
} = {}) {
  const flags = configService.getFlags();
  const client = configService.getExecutionClientConfig();
  const limits = configService.getPilotLimits();
  const killSwitch = configService.readKillSwitch();
  const checks = [];
  const root = normalizeRoot(intent.root || candidate.root || candidate.symbol || contract.root || quote?.root);
  const environment = String(intent.environment || 'paper').toLowerCase();
  const direction = String(intent.direction || candidate.direction || '').toLowerCase();
  const managed = classifyManagedAccounts(adapterStatus?.managedAccounts || []);
  const account = accountSummary?.account || null;
  const accountMasked = intent.paperAccountIdMasked || intent.accountIdMasked || account?.accountIdMasked || adapterVerification?.accountIdMasked || null;
  const liveDetected = adapterVerification?.live_account_detected === true || managed.liveOrUnknownAccounts.length > 0 || accountSummary?.blocker === 'only_non_paper_accounts_visible_refusing';
  const accountVerified = adapterVerification?.ok === true
    && account?.classification === 'paper'
    && Boolean(accountMasked)
    && adapterVerification.accountIdMasked === accountMasked;
  const expectedMasked = client.expectedPaperAccountMasked || null;
  const strategyGate = executionAllowlist;

  addCheck(checks, 'environment_paper', environment === 'paper', 'environment_not_paper', { environment });
  addCheck(checks, 'gateway_paper_port', Number(client.port) === 4002, 'wrong_gateway_port', { port: client.port });
  addCheck(checks, 'paper_feature_enabled', flags.executionEnabled === true, 'ibkr_paper_execution_disabled');
  addCheck(checks, 'live_flags_false', flags.live_trading_enabled === false && flags.live_broker_enabled === false && flags.live_order_submission_enabled === false && flags.live_account_orders_allowed === false, 'live_feature_flag_enabled');
  addCheck(checks, 'live_account_blocked', liveDetected !== true, 'live_account_detected', { liveAccountDetected: liveDetected, liveAccountsMasked: adapterVerification?.liveAccountsMasked || managed.liveOrUnknownAccounts.map((row) => row.accountIdMasked) });
  addCheck(checks, 'paper_account_verified', accountVerified === true, adapterVerification?.blocker || accountSummary?.blocker || 'paper_account_not_verified', { accountIdMasked: accountMasked });
  addCheck(checks, 'expected_account_matches', !expectedMasked || expectedMasked === accountMasked, 'paper_account_mismatch', { expectedPaperAccountMasked: expectedMasked || null, accountIdMasked: accountMasked });
  addCheck(checks, 'symbol_allowlisted', limits.symbolAllowlist.includes(root), 'symbol_not_allowlisted', { root, allowlist: limits.symbolAllowlist });
  addCheck(checks, 'direction_valid', direction === 'long' || direction === 'short', 'direction_missing_or_invalid', { direction: direction || null });

  const contractValidation = validateContract(contract, root, now);
  checks.push(...contractValidation.checks);

	  addCheck(checks, 'strategy_execution_allowlist_passed', strategyExecutionAllowed(strategyGate), strategyGate?.blockedReason || 'strategy_not_in_execution_allowlist', {
    strategyId: intent.strategyId || candidate.strategyId || null,
    registryStatus: strategyGate?.status || null,
    registryEnabled: strategyGate?.enabled ?? null,
    allowlistSource: strategyGate?.source || null,
  });
	  addCheck(checks, 'entry_contract_passed', entryContractApproved(entryContract), entryContract?.reasonCode || entryContract?.blockedReason || 'entry_contract_not_approved');
  addCheck(checks, 'risk_approval_passed', brokerRisk?.allowed === true, brokerRisk?.blockedReason || 'broker_risk_blocked', { riskBlockers: brokerRisk?.blockers || [] });
  addCheck(checks, 'idempotency_key_present', Boolean(intent.idempotencyKey), 'idempotency_key_missing');
  addCheck(checks, 'idempotency_unused', idempotency?.duplicate !== true, 'duplicate_intent', { existingIntent: idempotency?.existing || null });
	  addCheck(checks, 'candidate_fresh', Number.isFinite(Number(intent.ageMs)) && Number.isFinite(Number(intent.maxSubmitAgeMs)) && intent.ageMs <= intent.maxSubmitAgeMs, 'stale_signal', { ageMs: intent.ageMs ?? null, maxSubmitAgeMs: intent.maxSubmitAgeMs ?? null });
  addCheck(checks, 'system_not_paused', killSwitch.pauseNewEntries !== true, 'pause_new_entries_active', { pauseReason: killSwitch.reason || null });
  addCheck(checks, 'session_allows_order', session?.isMarketOpen === true && session?.closedReason == null, session?.closedReason || 'session_blocked', { sessionId: session?.sessionId || null });
  addCheck(checks, 'reconciliation_not_degraded', reconciliation?.degraded !== true, reconciliation?.blockedReason || 'reconciliation_degraded', { reconciliationStatus: reconciliation?.status || null });
  addCheck(checks, 'quote_not_simulated_or_delayed', quote?.simulated !== true && quote?.delayed !== true, 'quote_not_realtime_ibkr', { source: quote?.source || null });

  const blockers = checks.filter((check) => check.ok !== true).map((check) => check.blocker || check.code);
  return {
    ok: true,
    allowed: blockers.length === 0,
    blockers,
    blockedReason: blockers[0] || null,
    checks,
    environment: 'paper',
    verifiedPaperAccount: accountVerified === true,
    paperAccountIdMasked: accountMasked,
    liveAccountBlocked: liveDetected !== true,
    liveAccountDetected: liveDetected === true,
    orderSubmissionMode: flags.orderSubmissionMode,
    generatedAt: nowIso(now),
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  classifyManagedAccounts,
  validateContract,
  evaluatePaperExecutionGuard,
};
