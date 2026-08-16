'use strict';

const configService = require('./ibPaperExecutionConfigService');
const adapterModule = require('./ibFuturesDataAdapterService');
const marketHoursService = require('./futuresMarketHoursService');
const lifecycleIdentity = require('./futuresLifecycleIdentityService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  executionTarget: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  paper_trading_enabled: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'ib_paper_execution_guard',
});

function buildSafety(executionTarget = 'ibkr_paper') {
  return {
    ...configService.buildExecutionSafety(executionTarget),
    source: 'ib_paper_execution_guard',
  };
}

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

function accountClassificationForTarget(executionTarget) {
  return executionTarget === 'ibkr_live' ? 'live_or_unknown' : 'paper';
}

function accountMatchesTarget(row, executionTarget) {
  return row?.classification === accountClassificationForTarget(executionTarget);
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

function evaluateExecutionGuard({
  intent = {},
  candidate = {},
  contract = {},
  quote = null,
  accountSummary = null,
  adapterStatus = null,
  adapterVerification = null,
  brokerRisk = null,
  reconciliation = null,
  idempotency = null,
  session = null,
  now = new Date(),
  executionTarget = null,
} = {}) {
  const target = configService.normalizeExecutionTarget(executionTarget || intent.executionTarget || candidate.executionTarget || (String(intent.environment || '').toLowerCase() === 'live' ? 'ibkr_live' : 'ibkr_paper'));
  const expectedEnvironment = configService.getExpectedEnvironment(target);
  const candidateTarget = candidate.executionTarget ? configService.normalizeExecutionTarget(candidate.executionTarget) : null;
  const targetSafety = buildSafety(target);
  const flags = configService.getFlags({ executionTarget: target });
  const client = configService.getExecutionClientConfig({ executionTarget: target });
  const limits = configService.getPilotLimits({ executionTarget: target });
  const killSwitch = configService.readKillSwitch();
  const weekendCutoff = configService.getWeekendEntryCutoffConfig();
  const weekendWindow = marketHoursService.getWeekendEntryCutoffState(now, weekendCutoff);
  const checks = [];
  const root = normalizeRoot(intent.root || candidate.root || candidate.symbol || contract.root || quote?.root);
  const environment = String(intent.environment || expectedEnvironment).toLowerCase();
  const direction = String(intent.direction || candidate.direction || '').toLowerCase();
  const managed = classifyManagedAccounts(adapterStatus?.managedAccounts || []);
  const account = accountSummary?.account || null;
  const accountMasked = intent.paperAccountIdMasked || intent.liveAccountIdMasked || intent.accountIdMasked || account?.accountIdMasked || adapterVerification?.accountIdMasked || null;
  const targetAccountClass = accountClassificationForTarget(target);
  const adapterClass = adapterVerification?.classification || account?.classification || null;
  const wrongAccounts = target === 'ibkr_live' ? managed.paperAccounts : managed.liveOrUnknownAccounts;
  const targetAccounts = target === 'ibkr_live' ? managed.liveOrUnknownAccounts : managed.paperAccounts;
  const liveDetected = adapterVerification?.live_account_detected === true || managed.liveOrUnknownAccounts.length > 0 || accountSummary?.blocker === 'only_non_paper_accounts_visible_refusing';
  const accountVerified = adapterVerification?.ok === true
    && account?.classification === targetAccountClass
    && adapterClass === targetAccountClass
    && Boolean(accountMasked)
    && adapterVerification.accountIdMasked === accountMasked;
  const expectedMasked = target === 'ibkr_live'
    ? (client.expectedLiveAccountMasked || null)
    : (client.expectedPaperAccountMasked || null);

  addCheck(checks, 'execution_target_supported', target === 'ibkr_paper' || target === 'ibkr_live', 'execution_target_not_supported', { executionTarget: target });
  addCheck(checks, 'candidate_execution_target_matches', !candidateTarget || candidateTarget === target, target === 'ibkr_live' ? 'candidate_execution_target_not_ibkr_live' : 'candidate_execution_target_not_ibkr_paper', { candidateExecutionTarget: candidateTarget, executionTarget: target });
  addCheck(checks, `environment_${expectedEnvironment}`, environment === expectedEnvironment, target === 'ibkr_live' ? 'environment_not_live' : 'environment_not_paper', { environment, expectedEnvironment, executionTarget: target });
  addCheck(checks, 'gateway_expected_port', target === 'ibkr_live' ? Number(client.port) !== 4002 : Number(client.port) === 4002, 'wrong_gateway_port', { port: client.port, executionTarget: target });
  addCheck(checks, 'execution_feature_enabled', flags.executionEnabled === true, target === 'ibkr_live' ? 'ibkr_live_execution_disabled' : 'ibkr_paper_execution_disabled', { executionTarget: target });
  if (target === 'ibkr_live') {
    addCheck(checks, 'live_flags_enabled', flags.live_trading_enabled === true && flags.live_broker_enabled === true && flags.live_account_orders_allowed === true, 'live_feature_flag_disabled', {
      live_trading_enabled: flags.live_trading_enabled,
      live_broker_enabled: flags.live_broker_enabled,
      live_account_orders_allowed: flags.live_account_orders_allowed,
    });
    addCheck(checks, 'paper_account_blocked', wrongAccounts.length === 0, 'paper_account_detected_on_live_target', { paperAccountsMasked: wrongAccounts.map((row) => row.accountIdMasked) });
    addCheck(checks, 'live_account_verified', accountVerified === true, adapterVerification?.blocker || accountSummary?.blocker || 'live_account_not_verified', { accountIdMasked: accountMasked, classification: adapterClass });
  } else {
    addCheck(checks, 'live_flags_false', flags.live_trading_enabled === false && flags.live_broker_enabled === false && flags.live_order_submission_enabled === false && flags.live_account_orders_allowed === false, 'live_feature_flag_enabled');
    addCheck(checks, 'live_account_blocked', liveDetected !== true, 'live_account_detected', { liveAccountDetected: liveDetected, liveAccountsMasked: adapterVerification?.liveAccountsMasked || managed.liveOrUnknownAccounts.map((row) => row.accountIdMasked) });
    addCheck(checks, 'paper_account_verified', accountVerified === true, adapterVerification?.blocker || accountSummary?.blocker || 'paper_account_not_verified', { accountIdMasked: accountMasked });
  }
  addCheck(checks, 'expected_account_matches', !expectedMasked || expectedMasked === accountMasked, target === 'ibkr_live' ? 'live_account_mismatch' : 'paper_account_mismatch', { expectedAccountMasked: expectedMasked || null, accountIdMasked: accountMasked });
  addCheck(checks, 'symbol_allowlisted', limits.symbolAllowlist.includes(root), 'symbol_not_allowlisted', { root, allowlist: limits.symbolAllowlist });
  addCheck(checks, 'direction_valid', direction === 'long' || direction === 'short', 'direction_missing_or_invalid', { direction: direction || null });

  const contractValidation = validateContract(contract, root, now);
  checks.push(...contractValidation.checks);

  addCheck(checks, 'risk_approval_passed', brokerRisk?.allowed === true, brokerRisk?.blockedReason || 'broker_risk_blocked', { riskBlockers: brokerRisk?.blockers || [] });
  addCheck(checks, 'idempotency_key_present', Boolean(intent.idempotencyKey), 'idempotency_key_missing');
  addCheck(checks, 'idempotency_unused', idempotency?.duplicate !== true, 'duplicate_intent', { existingIntent: idempotency?.existing || null });
  addCheck(checks, 'candidate_age_observed', true, null, { ageMs: intent.ageMs ?? null, maxSubmitAgeMs: intent.maxSubmitAgeMs ?? null });
  addCheck(checks, 'system_not_paused', killSwitch.pauseNewEntries !== true, 'pause_new_entries_active', { pauseReason: killSwitch.reason || null });
  addCheck(checks, 'session_allows_order', session?.isMarketOpen === true && session?.closedReason == null, session?.closedReason || 'session_blocked', { sessionId: session?.sessionId || null });
  addCheck(checks, 'weekend_entry_window_observed', true, null, {
    weekendEntryCutoffEnabled: weekendCutoff.enabled === true,
    cutoffMinutes: weekendWindow.cutoffMinutes,
    minutesUntilWeeklyClose: weekendWindow.minutesUntilWeeklyClose,
    entryBlocked: weekendWindow.entryBlocked === true,
  });
  addCheck(checks, 'reconciliation_not_degraded', reconciliation?.degraded !== true, reconciliation?.blockedReason || 'reconciliation_degraded', { reconciliationStatus: reconciliation?.status || null });
  addCheck(checks, 'quote_not_simulated_or_delayed', quote?.simulated !== true && quote?.delayed !== true, 'quote_not_realtime_ibkr', { source: quote?.source || null });

  const blockers = checks.filter((check) => check.ok !== true).map((check) => check.blocker || check.code);
  const identity = lifecycleIdentity.mergeIdentity(intent, candidate);
  return {
    ok: true,
    allowed: blockers.length === 0,
    lifecycleId: identity.lifecycleId || null,
    candidateId: identity.candidateId || null,
    signalId: identity.signalId || null,
    intentId: identity.intentId || null,
    executionId: identity.executionId || null,
    tradeId: identity.tradeId || null,
    idempotencyKey: identity.idempotencyKey || null,
    blockers,
    blockedReason: blockers[0] || null,
    checks,
    executionTarget: target,
    environment: expectedEnvironment,
    verifiedPaperAccount: target === 'ibkr_paper' && accountVerified === true,
    verifiedLiveAccount: target === 'ibkr_live' && accountVerified === true,
    paperAccountIdMasked: target === 'ibkr_paper' ? accountMasked : null,
    liveAccountIdMasked: target === 'ibkr_live' ? accountMasked : null,
    liveAccountBlocked: target === 'ibkr_paper' ? liveDetected !== true : false,
    liveAccountDetected: target === 'ibkr_paper' ? liveDetected === true : targetAccounts.length > 0,
    paperAccountBlocked: target === 'ibkr_live' ? wrongAccounts.length === 0 : false,
    orderSubmissionMode: flags.orderSubmissionMode,
    generatedAt: nowIso(now),
    ...targetSafety,
  };
}

function evaluatePaperExecutionGuard(options = {}) {
  return evaluateExecutionGuard({ ...options, executionTarget: 'ibkr_paper' });
}

module.exports = {
  SAFETY,
  classifyManagedAccounts,
  validateContract,
  evaluateExecutionGuard,
  evaluatePaperExecutionGuard,
};
