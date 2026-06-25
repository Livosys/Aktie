'use strict';

/**
 * IB Paper one-shot execution.
 *
 * This service is intentionally separate from canonical execution-status and
 * from the preflight layer. It only executes a single manually approved IB
 * Paper order when all gates are green and the isolated one-shot feature flag
 * is enabled. It never touches live trading flags.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IBApi, EventName } = require('@stoqey/ib');

const paperTradingTruthService = require('./paperTradingTruthService');
const interactiveBrokersTradeBlueprintService = require('./interactiveBrokersTradeBlueprintService');
const interactiveBrokersPaperPreflightService = require('./interactiveBrokersPaperPreflightService');
const interactiveBrokersPaperProtectiveOrderService = require('./interactiveBrokersPaperProtectiveOrderService');
const interactiveBrokersPaperBracketSubmissionService = require('./interactiveBrokersPaperBracketSubmissionService');
const interactiveBrokersPaperOneShotArmService = require('./interactiveBrokersPaperOneShotArmService');

const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.resolve(process.env.IB_PAPER_ONE_SHOT_DATA_DIR || path.join(ROOT, 'data/interactive-brokers'));
const EXECUTIONS_FILE = path.join(DATA_DIR, 'paper-executions.jsonl');
const EVENTS_FILE = path.join(DATA_DIR, 'paper-execution-events.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'paper-execution-state.json');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const FEATURE_FLAG = 'IB_PAPER_ONE_SHOT_ENABLED';
const REQUIRED_EXECUTION_COMMANDS = [
  'FAS 4E EXECUTE FIRST IB PAPER ORDER',
  'KÖR FÖRSTA IB PAPER BRACKET ORDER NU',
];
const DEFAULT_CLIENT_ID = 1;
const DEFAULT_TIMEOUT_MS = 8000;
const REQUIRED_CONFIRMATION_PHRASE = 'CONFIRM PAPER TRADE';
const REQUIRED_SECOND_CONFIRMATION_PHRASE = 'CONFIRM FIRST IB PAPER ORDER';
const REAL_SUBMIT_AUDIT_ONLY = 'real_submit_audit_only';
const REAL_SUBMIT_GATE_READY_REQUIRES_FINAL_PHASE = 'real_submit_gate_ready_requires_final_phase_4g2d';
const REAL_SUBMIT_GATE_ACCOUNT_MISMATCH = 'real_submit_gate_account_mismatch';
const REAL_SUBMIT_GATE_BLUEPRINT_MISMATCH = 'real_submit_gate_blueprint_mismatch';
const REAL_SUBMIT_GATE_FINAL_COMMAND_MISSING = 'real_submit_gate_final_command_missing';
const REAL_SUBMIT_GATE_ACK_MISSING = 'real_submit_gate_ack_missing';
const REAL_SUBMIT_GATE_DUPLICATE_IDEMPOTENCY = 'real_submit_gate_duplicate_idempotency';
const REAL_SUBMIT_GATE_OPEN_ORDERS_PRESENT = 'real_submit_gate_open_orders_present';
const REAL_SUBMIT_GATE_POSITION_PRESENT = 'real_submit_gate_position_present';
const REAL_SUBMIT_GATE_SCOPE_MISMATCH = 'real_submit_gate_scope_mismatch';
const REAL_SUBMIT_GATE_NOT_OPEN = 'real_submit_gate_not_open';
const REAL_SUBMIT_GATE_MANUAL_USER_INITIATED_REQUIRED = 'manual_user_initiated_required';
const BRACKET_SUBMIT_PHASE_4G2_PREFIX = 'IBPAPER-BRACKET-4G2-';

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function appendJsonl(file, row) {
  ensureDataDir();
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeUpper(value) {
  return safeString(value).toUpperCase();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function readFeatureFlag() {
  const raw = safeLower(process.env[FEATURE_FLAG]);
  return ['true', '1', 'yes', 'on'].includes(raw);
}

function readConfig() {
  const host = safeString(process.env.IB_GATEWAY_HOST || '127.0.0.1') || '127.0.0.1';
  const portRaw = safeString(process.env.IB_GATEWAY_PORT);
  const clientIdRaw = safeString(process.env.IB_GATEWAY_CLIENT_ID);
  const timeoutRaw = safeString(process.env.IB_PAPER_ONE_SHOT_TIMEOUT_MS);
  return {
    enabled: readFeatureFlag(),
    host,
    port: portRaw && Number.isFinite(Number(portRaw)) ? Number(portRaw) : 4002,
    clientId: clientIdRaw && Number.isFinite(Number(clientIdRaw)) ? Number(clientIdRaw) : DEFAULT_CLIENT_ID,
    timeoutMs: timeoutRaw && Number.isFinite(Number(timeoutRaw)) ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS,
  };
}

function loadState() {
  ensureDataDir();
  const saved = readJson(STATE_FILE, {});
  return {
    idempotencyKeys: saved.idempotencyKeys && typeof saved.idempotencyKeys === 'object' ? saved.idempotencyKeys : {},
    executedBlueprintIds: saved.executedBlueprintIds && typeof saved.executedBlueprintIds === 'object' ? saved.executedBlueprintIds : {},
    attempts: Array.isArray(saved.attempts) ? saved.attempts : [],
    lastAttempt: saved.lastAttempt || null,
    lastSubmittedOrder: saved.lastSubmittedOrder || null,
    lastSyncAt: saved.lastSyncAt || null,
  };
}

function saveState(next) {
  writeJson(STATE_FILE, next);
}

function appendExecutionAttempt(row) {
  appendJsonl(EXECUTIONS_FILE, {
    ...row,
    paperOnly: true,
    accountMode: 'ib_paper',
    mode: 'paper_only',
    recordedAt: nowIso(),
  });
}

function appendExecutionEvent(row) {
  appendJsonl(EVENTS_FILE, {
    ...row,
    paperOnly: true,
    accountMode: 'ib_paper',
    mode: 'paper_only',
    recordedAt: nowIso(),
  });
}

function maskPaperAccountId(accountId) {
  const value = safeString(accountId);
  if (!value) return null;
  if (value.length <= 5) return value;
  return `${value.slice(0, 2)}****${value.slice(-3)}`;
}

function buildCheck(code, ok, severity, messageSv, source = null, blocker = null) {
  return {
    code,
    ok: ok === true,
    severity,
    messageSv,
    source,
    blocker: ok === true ? null : blocker || code,
  };
}

function resolveBlueprint(tradeBlueprint, selectedBlueprintId = null) {
  const blueprints = Array.isArray(tradeBlueprint?.blueprints) ? tradeBlueprint.blueprints : [];
  if (selectedBlueprintId) {
    return blueprints.find((row) => safeString(row?.blueprintId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.candidateId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.symbol) && safeString(row?.strategyId) && `${safeString(row.symbol)}:${safeString(row.strategyId)}` === safeString(selectedBlueprintId))
      || null;
  }
  return interactiveBrokersTradeBlueprintService._internal.selectManualReadyIbPaperBlueprint(tradeBlueprint || {})?.selectedBlueprint || null;
}

function buildAccountStatus(readiness = {}) {
  const managedAccounts = Array.isArray(readiness.managedAccounts) ? readiness.managedAccounts : [];
  const paperAccountId = safeString(readiness.paperAccountId) || managedAccounts.find((row) => safeString(row).startsWith('DU')) || null;
  const paperAccountVerified = readiness.paperAccountVerified === true;
  const selectedAccountExists = managedAccounts.length > 0;
  const selectedAccountMatchesPaper = paperAccountVerified && Boolean(paperAccountId) && managedAccounts.includes(paperAccountId);
  return {
    paperAccountVerified,
    paperAccountId,
    paperAccountIdMasked: maskPaperAccountId(paperAccountId),
    managedAccounts,
    selectedAccountExists,
    selectedAccountMatchesPaper,
  };
}

function buildRealSubmitGate({
  selectedBlueprint,
  preflight,
  bracketSubmissionPlan,
  bracketSubmissionPlanReady = false,
  bracketSubmissionRealSubmitEnabled = false,
  helperReady = false,
  bracketOrderCount = 0,
  entryOnlyBlocked = true,
  armStatus = null,
  executionCommand = '',
  idempotencyKey = '',
  body = {},
  state = loadState(),
  executionStatus = null,
  finalPhaseEnabled = false,
  manualUserInitiated = false,
  openRealSubmitGateForThisAttempt = false,
  runtimeBracketSubmitUnlocked = false,
}) {
  const account = preflight?.account || buildAccountStatus(preflight?.readiness || {});
  const blueprintId = safeString(selectedBlueprint?.blueprintId);
  const symbol = safeString(selectedBlueprint?.symbol);
  const strategyId = safeString(selectedBlueprint?.strategyId);
  const armSnapshot = armStatus?.currentArm || armStatus || null;
  const command = safeString(executionCommand || body?.executionCommand || body?.orderCommand || body?.finalExecutionCommand || '');
  const confirmationPhrase = safeString(body.confirmationPhrase || body.confirmationText || '');
  const secondConfirmationPhrase = safeString(body.secondConfirmationPhrase || '');
  const armConfirmationPhrase = safeString(body.armConfirmationPhrase || '');
  const ackPaperOnly = body.acknowledgePaperOnly === true;
  const ackNoLiveTrading = body.acknowledgeNoLiveTrading === true;
  const ackOneOrderOnly = body.acknowledgeOneOrderOnly === true;
  const ackBracketOrder = body.acknowledgeBracketOrder === true;
  const ackNoRetry = body.acknowledgeNoRetry === true;
  const manualInitiated = manualUserInitiated === true || body.manualUserInitiated === true;
  const openGateRequested = openRealSubmitGateForThisAttempt === true || body.openRealSubmitGateForThisAttempt === true;
  const duplicateIdempotency = Boolean(idempotencyKey && state.idempotencyKeys && state.idempotencyKeys[idempotencyKey]);
  const openOrdersPresent = Number(executionStatus?.openTradeCount || 0) > 0
    || (Array.isArray(executionStatus?.openTrades) && executionStatus.openTrades.length > 0);
  const positionsPresent = Number(executionStatus?.openPositionCount || 0) > 0
    || (Array.isArray(executionStatus?.openPositions) && executionStatus.openPositions.length > 0)
    || (Array.isArray(executionStatus?.positions) && executionStatus.positions.length > 0);
  const armActive = Boolean(armStatus?.armed === true || armSnapshot?.armed === true);
  const armExpired = Boolean(armStatus?.expired === true || armSnapshot?.expiredAt);
  const armUsed = Boolean(armStatus?.used === true || armSnapshot?.used === true);
  const armBlueprintMatches = !blueprintId || !safeString(armSnapshot?.blueprintId) || safeString(armSnapshot?.blueprintId) === blueprintId;
  const armIdempotencyMatches = !idempotencyKey || !safeString(armSnapshot?.idempotencyKey) || safeString(armSnapshot?.idempotencyKey) === idempotencyKey;
  const accountMatchesPaper = account.selectedAccountMatchesPaper === true;
  const commandApproved = REQUIRED_EXECUTION_COMMANDS.includes(command);
  const selectedBlueprintReady = selectedBlueprint?.blueprintReady === true && selectedBlueprint?.manualApprovalReady === true;
  const blueprintMatchesPreflight = !safeString(preflight?.selectedBlueprint?.blueprintId)
    || !blueprintId
    || safeString(preflight?.selectedBlueprint?.blueprintId) === blueprintId;
  const gateBlockers = [];

  if (helperReady !== true || bracketSubmissionPlanReady !== true || Number(bracketOrderCount || bracketSubmissionPlan?.orderCount || 0) !== 3 || entryOnlyBlocked !== true) {
    gateBlockers.push('protective_bracket_submission_required');
  } else if (accountMatchesPaper !== true) {
    gateBlockers.push(REAL_SUBMIT_GATE_ACCOUNT_MISMATCH);
  } else if (!blueprintId || !selectedBlueprintReady || !blueprintMatchesPreflight) {
    gateBlockers.push(REAL_SUBMIT_GATE_BLUEPRINT_MISMATCH);
  } else if (!commandApproved || !confirmationPhrase || !secondConfirmationPhrase || !armConfirmationPhrase) {
    gateBlockers.push(REAL_SUBMIT_GATE_FINAL_COMMAND_MISSING);
  } else if (!ackPaperOnly || !ackNoLiveTrading || !ackOneOrderOnly || !ackBracketOrder || !ackNoRetry) {
    gateBlockers.push(REAL_SUBMIT_GATE_ACK_MISSING);
  } else if (duplicateIdempotency) {
    gateBlockers.push(REAL_SUBMIT_GATE_DUPLICATE_IDEMPOTENCY);
  } else if (openOrdersPresent === true) {
    gateBlockers.push(REAL_SUBMIT_GATE_OPEN_ORDERS_PRESENT);
  } else if (positionsPresent === true) {
    gateBlockers.push(REAL_SUBMIT_GATE_POSITION_PRESENT);
  } else if (!armActive || armExpired || armUsed) {
    gateBlockers.push(armExpired ? 'one_shot_arm_expired' : 'one_shot_not_armed');
  } else if (!armBlueprintMatches) {
    gateBlockers.push(REAL_SUBMIT_GATE_BLUEPRINT_MISMATCH);
  } else if (!armIdempotencyMatches) {
    gateBlockers.push(REAL_SUBMIT_GATE_DUPLICATE_IDEMPOTENCY);
  } else if (!runtimeBracketSubmitUnlocked) {
    gateBlockers.push(REAL_SUBMIT_GATE_NOT_OPEN);
  }

  const gateReady = gateBlockers.length === 0
    && helperReady === true
    && bracketSubmissionPlanReady === true
    && Number(bracketOrderCount || bracketSubmissionPlan?.orderCount || 0) === 3
    && entryOnlyBlocked === true
    && runtimeBracketSubmitUnlocked === true
    && accountMatchesPaper === true
    && commandApproved === true
    && ackPaperOnly === true
    && ackNoLiveTrading === true
    && ackOneOrderOnly === true
    && ackBracketOrder === true
    && ackNoRetry === true
    && duplicateIdempotency === false
    && openOrdersPresent === false
    && positionsPresent === false
    && armActive === true
    && armExpired === false
    && armUsed === false
    && armBlueprintMatches === true
    && armIdempotencyMatches === true
    && blueprintMatchesPreflight === true
    && selectedBlueprintReady === true;

  const gateOpensRealSubmit = gateReady === true
    && finalPhaseEnabled === true
    && manualInitiated === true
    && openGateRequested === true;

  return {
    gateReady,
    gateSource: 'runtime_one_shot_real_submit_gate',
    gateScope: 'single_ib_paper_bracket_order',
    gateOpensRealSubmit,
    requiresFinalPhase: '4G-2D',
    account: account.paperAccountId || 'DUQ565596',
    symbol: symbol || null,
    strategyId: strategyId || null,
    idempotencyKey: idempotencyKey || null,
    manualUserInitiated: manualInitiated === true,
    openRealSubmitGateForThisAttempt: openGateRequested === true,
    expiresAt: armSnapshot?.expiresAt || null,
    blockers: gateReady ? [] : gateBlockers,
    blockedReason: gateReady
      ? (gateOpensRealSubmit ? null
        : (!manualInitiated ? REAL_SUBMIT_GATE_MANUAL_USER_INITIATED_REQUIRED
          : (!finalPhaseEnabled ? REAL_SUBMIT_GATE_READY_REQUIRES_FINAL_PHASE
            : (!openGateRequested ? REAL_SUBMIT_GATE_NOT_OPEN : REAL_SUBMIT_GATE_NOT_OPEN))))
      : (gateBlockers[0] || REAL_SUBMIT_GATE_NOT_OPEN),
  };
}

function buildReadinessChecks(readiness, config) {
  const gatewayReachable = readiness?.gatewayReachable === true;
  const paperPortConfigured = (safeString(config.host) === '127.0.0.1' || safeString(config.host) === 'localhost') && Number(config.port) === 4002;
  const ibApiVerified = readiness?.ibApiVerified === true;
  const paperAccountVerified = readiness?.paperAccountVerified === true;
  const paperModeVerified = readiness?.paperModeVerified === true || (ibApiVerified && paperAccountVerified);
  const sessionVerified = readiness?.sessionVerified === true || paperModeVerified;
  return {
    gatewayReachable,
    paperPortConfigured,
    ibApiVerified,
    paperAccountVerified,
    paperModeVerified,
    sessionVerified,
    blockedReason: !gatewayReachable
      ? 'ib_gateway_unreachable'
      : (!paperPortConfigured ? 'not_paper_mode_or_wrong_port'
        : (!ibApiVerified ? 'ib_api_not_verified'
          : (!paperAccountVerified ? 'paper_account_not_verified' : 'read_only_session_verified'))),
  };
}

function buildOneShotChecks({
  config,
  readinessChecks,
  preflight,
  selectedBlueprint,
  idempotencyKey,
  protectivePlanReady = false,
  protectiveOrderPathAvailable = false,
  protectiveExecutionReady = false,
  bracketSubmissionPlanReady = false,
  bracketSubmissionRealSubmitEnabled = false,
  helperReady = false,
  bracketOrderCount = 0,
  entryOnlyBlocked = true,
  bracketSubmissionPlan = null,
  armStatus = null,
  executionStatus = null,
  executionCommand = '',
  finalPhaseEnabled = false,
  manualUserInitiated = false,
  openRealSubmitGateForThisAttempt = false,
  body = {},
  state = {},
}) {
  const featureEnabled = config.enabled === true;
  const account = preflight?.account || buildAccountStatus(preflight?.readiness || {});
  const confirmationPhrase = safeString(body.confirmationPhrase || body.confirmationText || '');
  const secondConfirmationPhrase = safeString(body.secondConfirmationPhrase || '');
  const ackPaperOnly = body.acknowledgePaperOnly === true;
  const ackNoLiveTrading = body.acknowledgeNoLiveTrading === true;
  const ackOneOrderOnly = body.acknowledgeOneOrderOnly === true;
  const ackBracketOrder = body.acknowledgeBracketOrder === true;
  const ackNoRetry = body.acknowledgeNoRetry === true;
  const manualInitiated = manualUserInitiated === true || body.manualUserInitiated === true;
  const openGateRequested = openRealSubmitGateForThisAttempt === true || body.openRealSubmitGateForThisAttempt === true;
  const preflightReady = preflight?.readyForFirstPaperOrder === true;
  const duplicateIdempotency = Boolean(idempotencyKey && state.idempotencyKeys && state.idempotencyKeys[idempotencyKey]);
  const duplicateBlueprint = Boolean(selectedBlueprint?.blueprintId && state.executedBlueprintIds && state.executedBlueprintIds[selectedBlueprint.blueprintId]);
  const preflightBlueprintId = safeString(preflight?.selectedBlueprint?.blueprintId);
  const blueprintId = safeString(selectedBlueprint?.blueprintId);
  const blueprintMatchesPreflight = !preflightBlueprintId || !blueprintId || preflightBlueprintId === blueprintId;
  const manualApprovalReady = selectedBlueprint?.manualApprovalReady === true;
  const blueprintReady = selectedBlueprint?.blueprintReady === true;
  const accountMatchesPaper = account.selectedAccountMatchesPaper === true;
  const armSnapshot = armStatus?.currentArm || armStatus || null;
  const armActive = Boolean(armStatus?.armed === true || armSnapshot?.armed === true);
  const armExpired = Boolean(armStatus?.expired === true || armSnapshot?.expiredAt);
  const armUsed = Boolean(armStatus?.used === true || armSnapshot?.used === true);
  const armBlueprintMatches = !blueprintId || !safeString(armSnapshot?.blueprintId) || safeString(armSnapshot?.blueprintId) === blueprintId;
  const armIdempotencyMatches = !idempotencyKey || !safeString(armSnapshot?.idempotencyKey) || safeString(armSnapshot?.idempotencyKey) === idempotencyKey;
  const executionCommandApproved = REQUIRED_EXECUTION_COMMANDS.includes(safeString(executionCommand));
  const runtimeUnlocked = featureEnabled === true || armActive === true;
  const bracketPlanReady = bracketSubmissionPlanReady === true;
  const bracketRealSubmitEnabled = bracketSubmissionRealSubmitEnabled === true;
  const helperIsReady = helperReady === true;
  const bracketOrders = Number(bracketOrderCount || bracketSubmissionPlan?.orderCount || 0);
  const entryOnlyIsBlocked = entryOnlyBlocked === true;
  const realSubmitGate = buildRealSubmitGate({
    selectedBlueprint,
    preflight,
    bracketSubmissionPlan,
    bracketSubmissionPlanReady: bracketPlanReady,
    bracketSubmissionRealSubmitEnabled: bracketRealSubmitEnabled,
    helperReady: helperIsReady,
    bracketOrderCount: bracketOrders,
    entryOnlyBlocked: entryOnlyIsBlocked,
    armStatus,
    executionCommand,
    idempotencyKey,
    body,
    state,
    executionStatus,
    finalPhaseEnabled: finalPhaseEnabled === true,
    manualUserInitiated: manualUserInitiated === true || body.manualUserInitiated === true,
    openRealSubmitGateForThisAttempt: openRealSubmitGateForThisAttempt === true || body.openRealSubmitGateForThisAttempt === true,
    runtimeBracketSubmitUnlocked: Boolean(
      helperIsReady === true
      && bracketPlanReady === true
      && bracketOrders === 3
      && entryOnlyIsBlocked === true
      && executionCommandApproved === true
      && ackPaperOnly === true
      && ackNoLiveTrading === true
      && ackOneOrderOnly === true
      && ackBracketOrder === true
      && ackNoRetry === true
      && accountMatchesPaper === true
      && blueprintMatchesPreflight === true
      && armActive === true
      && armExpired === false
      && armUsed === false
      && armBlueprintMatches === true
      && armIdempotencyMatches === true
    ),
  });
  const runtimeBracketSubmitUnlocked = realSubmitGate.gateReady === true;
  const realSubmitForThisAttempt = Boolean(realSubmitGate.gateOpensRealSubmit === true);
  const realSubmitAuditOnlyBlocked = bracketRealSubmitEnabled === false && realSubmitGate.gateReady !== true;

  const checks = [
    buildCheck('paper_only_mode', SAFETY.mode === 'paper_only', 'hard', 'Läget är paper_only.', 'safety.mode', SAFETY.mode === 'paper_only' ? null : 'paper_only_mode'),
    buildCheck('actions_allowed_false', SAFETY.actions_allowed === false, 'hard', 'actions_allowed är false.', 'safety.actions_allowed', SAFETY.actions_allowed === false ? null : 'actions_allowed_true'),
    buildCheck('can_place_orders_false', SAFETY.can_place_orders === false, 'hard', 'can_place_orders är false.', 'safety.can_place_orders', SAFETY.can_place_orders === false ? null : 'can_place_orders_true'),
    buildCheck('live_trading_disabled', SAFETY.live_trading_enabled === false, 'hard', 'live_trading_enabled är false.', 'safety.live_trading_enabled', SAFETY.live_trading_enabled === false ? null : 'live_trading_enabled_true'),
    buildCheck('broker_disabled', SAFETY.broker_enabled === false, 'hard', 'broker_enabled är false.', 'safety.broker_enabled', SAFETY.broker_enabled === false ? null : 'broker_enabled_true'),
    buildCheck('one_shot_runtime_unlocked', runtimeUnlocked, 'hard', runtimeUnlocked ? 'One-shot är runtime-unlocked.' : 'One-shot är inte runtime-unlocked.', FEATURE_FLAG, runtimeUnlocked ? null : 'one_shot_runtime_unlock_not_connected'),
    buildCheck('gateway_reachable', readinessChecks.gatewayReachable === true, 'hard', readinessChecks.gatewayReachable === true ? 'Gateway TCP är nåbar.' : 'Gateway TCP är inte nåbar.', 'readiness.gatewayReachable', readinessChecks.gatewayReachable === true ? null : 'ib_gateway_unreachable'),
    buildCheck('ib_api_verified', readinessChecks.ibApiVerified === true, 'hard', readinessChecks.ibApiVerified === true ? 'IB API-sessionen är verifierad.' : 'IB API-sessionen är inte verifierad.', 'readiness.ibApiVerified', readinessChecks.ibApiVerified === true ? null : 'ib_api_not_verified'),
    buildCheck('paper_account_verified', readinessChecks.paperAccountVerified === true, 'hard', readinessChecks.paperAccountVerified === true ? 'Paper account är verifierat.' : 'Paper account är inte verifierat.', 'readiness.paperAccountVerified', readinessChecks.paperAccountVerified === true ? null : 'paper_account_not_verified'),
    buildCheck('paper_mode_verified', readinessChecks.paperModeVerified === true, 'hard', readinessChecks.paperModeVerified === true ? 'Paper mode är verifierat.' : 'Paper mode är inte verifierat.', 'readiness.paperModeVerified', readinessChecks.paperModeVerified === true ? null : 'paper_mode_not_verified'),
    buildCheck('session_verified', readinessChecks.sessionVerified === true, 'hard', readinessChecks.sessionVerified === true ? 'Sessionen är verifierad.' : 'Sessionen är inte verifierad.', 'readiness.sessionVerified', readinessChecks.sessionVerified === true ? null : 'session_not_verified'),
    buildCheck('selected_account_exists', account.selectedAccountExists === true, 'hard', account.selectedAccountExists === true ? 'Selected account finns.' : 'Selected account saknas.', 'readiness.managedAccounts', account.selectedAccountExists === true ? null : 'selected_account_missing'),
    buildCheck('selected_account_matches_paper', accountMatchesPaper === true, 'hard', accountMatchesPaper === true ? 'Selected account matchar paper-kontot.' : 'Selected account matchar inte paper-kontot.', 'readiness.managedAccounts', accountMatchesPaper === true ? null : 'paper_account_mismatch'),
    buildCheck('selected_blueprint_exists', Boolean(selectedBlueprint), 'hard', selectedBlueprint ? 'Selected blueprint finns.' : 'Selected blueprint saknas.', 'tradeBlueprint.selectedBlueprint', selectedBlueprint ? null : 'missing_blueprint'),
    buildCheck('selected_blueprint_manual_ready', blueprintReady === true && manualApprovalReady === true, 'hard', blueprintReady === true && manualApprovalReady === true ? 'Blueprinten är manual-ready.' : 'Blueprinten är inte manual-ready.', 'tradeBlueprint.selectedBlueprint', blueprintReady === true && manualApprovalReady === true ? null : 'selected_blueprint_not_manual_ready'),
    buildCheck('blueprint_ready', blueprintReady === true, 'hard', blueprintReady ? 'Blueprint är redo.' : 'Blueprint är inte redo.', 'tradeBlueprint.selectedBlueprint', blueprintReady === true ? null : 'blueprint_not_ready'),
    buildCheck('manual_approval_ready', manualApprovalReady === true, 'hard', manualApprovalReady ? 'Manual approval är redo.' : 'Manual approval är inte redo.', 'tradeBlueprint.manualApproval', manualApprovalReady === true ? null : 'manual_approval_not_ready'),
    buildCheck('blueprint_matches_preflight', blueprintMatchesPreflight === true, 'hard', blueprintMatchesPreflight ? 'Blueprinten matchar preflight.' : 'Blueprinten matchar inte preflight.', 'preflight.selectedBlueprint', blueprintMatchesPreflight === true ? null : 'blueprint_mismatch'),
    buildCheck('confirmation_phrase', confirmationPhrase === REQUIRED_CONFIRMATION_PHRASE, 'hard', confirmationPhrase === REQUIRED_CONFIRMATION_PHRASE ? 'Första bekräftelsefrasen matchar.' : 'Första bekräftelsefrasen saknas eller matchar inte.', 'request.confirmationPhrase', confirmationPhrase === REQUIRED_CONFIRMATION_PHRASE ? null : (confirmationPhrase ? 'manual_confirmation_mismatch' : 'manual_confirmation_required')),
    buildCheck('second_confirmation_phrase', secondConfirmationPhrase === REQUIRED_SECOND_CONFIRMATION_PHRASE, 'hard', secondConfirmationPhrase === REQUIRED_SECOND_CONFIRMATION_PHRASE ? 'Andra bekräftelsefrasen matchar.' : 'Andra bekräftelsefrasen saknas eller matchar inte.', 'request.secondConfirmationPhrase', secondConfirmationPhrase === REQUIRED_SECOND_CONFIRMATION_PHRASE ? null : (secondConfirmationPhrase ? 'second_confirmation_mismatch' : 'second_confirmation_required')),
    buildCheck('acknowledge_paper_only', ackPaperOnly === true, 'hard', ackPaperOnly ? 'Paper-only bekräftad.' : 'Paper-only måste bekräftas.', 'request.acknowledgePaperOnly', ackPaperOnly ? null : 'paper_only_ack_required'),
    buildCheck('acknowledge_no_live_trading', ackNoLiveTrading === true, 'hard', ackNoLiveTrading ? 'Ingen live trading bekräftad.' : 'Ingen live trading måste bekräftas.', 'request.acknowledgeNoLiveTrading', ackNoLiveTrading ? null : 'no_live_trading_ack_required'),
    buildCheck('acknowledge_one_order_only', ackOneOrderOnly === true, 'hard', ackOneOrderOnly ? 'Endast en order bekräftad.' : 'Endast en order måste bekräftas.', 'request.acknowledgeOneOrderOnly', ackOneOrderOnly ? null : 'one_order_only_ack_required'),
    buildCheck('acknowledge_bracket_order', ackBracketOrder === true, 'hard', ackBracketOrder ? 'Bracket-order bekräftad.' : 'Bracket-order måste bekräftas.', 'request.acknowledgeBracketOrder', ackBracketOrder ? null : 'bracket_order_ack_required'),
    buildCheck('acknowledge_no_retry', ackNoRetry === true, 'hard', ackNoRetry ? 'No-retry bekräftad.' : 'No-retry måste bekräftas.', 'request.acknowledgeNoRetry', ackNoRetry ? null : 'no_retry_ack_required'),
    buildCheck('idempotency_key_present', Boolean(idempotencyKey), 'hard', idempotencyKey ? 'Idempotency key finns.' : 'Idempotency key saknas.', 'request.idempotencyKey', idempotencyKey ? null : 'idempotency_key_required'),
    buildCheck('no_duplicate_idempotency', !duplicateIdempotency, 'hard', duplicateIdempotency ? 'Idempotency key är redan använd.' : 'Idempotency key är unik.', 'state.idempotencyKeys', duplicateIdempotency ? 'duplicate_order_request' : null),
    buildCheck('no_duplicate_blueprint_execution', !duplicateBlueprint, 'hard', duplicateBlueprint ? 'Blueprinten har redan exekverats.' : 'Blueprinten är inte tidigare exekverad.', 'state.executedBlueprintIds', duplicateBlueprint ? 'duplicate_blueprint_execution' : null),
    buildCheck('preflight_ready_directly_before_execution', preflightReady === true, 'hard', preflightReady ? 'Preflight passerade direkt före execution.' : 'Preflight passerade inte direkt före execution.', 'paperExecute/preflight', preflightReady === true ? null : (preflight?.blockedReason || 'preflight_not_ready')),
    buildCheck(
      'protective_plan_ready',
      protectivePlanReady === true,
      'hard',
      protectivePlanReady === true ? 'Protective plan är redo.' : 'Protective plan är inte redo.',
      'interactiveBrokersPaperProtectiveOrderService',
      protectivePlanReady === true ? null : 'protective_plan_not_ready',
    ),
    buildCheck(
      'protective_execution_ready',
      protectiveExecutionReady === true,
      'info',
      protectiveExecutionReady === true ? 'Protective/bracket submission är redo.' : 'Protective/bracket submission är inte redo ännu.',
      'interactiveBrokersPaperProtectiveOrderService',
      null,
    ),
    buildCheck(
      'bracket_submission_plan_ready',
      bracketPlanReady === true,
      'hard',
      bracketPlanReady === true ? 'Bracket submission-planen är redo.' : 'Bracket submission-planen är inte redo.',
      'interactiveBrokersPaperBracketSubmissionService',
      bracketPlanReady === true ? null : 'protective_bracket_submission_required',
    ),
    buildCheck(
      'bracket_order_count_three',
      bracketOrders === 3,
      'hard',
      bracketOrders === 3 ? 'Bracket-planen har tre legs.' : `Bracket-planen har ${bracketOrders} legs.`,
      'interactiveBrokersPaperBracketSubmissionService',
      bracketOrders === 3 ? null : 'entry_only_forbidden',
    ),
    buildCheck(
      'entry_only_blocked',
      entryOnlyIsBlocked === true,
      'hard',
      entryOnlyIsBlocked ? 'Entry-only är förbjudet.' : 'Entry-only är inte blockerat.',
      'interactiveBrokersPaperBracketSubmissionService',
      entryOnlyIsBlocked ? null : 'entry_only_forbidden',
    ),
    buildCheck(
      'real_submit_audit_only',
      realSubmitAuditOnlyBlocked !== true,
      'hard',
      realSubmitAuditOnlyBlocked === true
        ? 'Real submit är fortfarande låst i auditläge.'
        : 'Real submit-gaten är redo och väntar på final fas.',
      'interactiveBrokersPaperBracketSubmissionService',
      realSubmitAuditOnlyBlocked === true ? 'real_submit_audit_only' : null,
    ),
    buildCheck(
      'real_submit_gate_ready_requires_final_phase_4g2d',
      realSubmitForThisAttempt === true,
      'hard',
      realSubmitForThisAttempt === true
        ? 'Real submit är öppnad för denna attempt.'
        : (realSubmitGate.gateReady === true
          ? 'Real submit-gaten är redo men Fas 4G-2D saknas.'
          : 'Real submit-gaten är inte redo.'),
      'interactiveBrokersPaperOneShotExecutionService',
      realSubmitForThisAttempt === true ? null : (realSubmitGate.blockedReason || REAL_SUBMIT_GATE_READY_REQUIRES_FINAL_PHASE),
    ),
    buildCheck(
      'bracket_submission_helper_ready',
      helperIsReady === true,
      'info',
      helperIsReady ? '3-leg submit-helper är redo.' : '3-leg submit-helper är inte redo.',
      'interactiveBrokersPaperBracketSubmissionService',
      null,
    ),
    buildCheck(
      'protective_order_path_available',
      protectiveOrderPathAvailable === true,
      'hard',
      protectiveOrderPathAvailable === true
        ? 'Skyddsorder-path finns.'
        : 'Skyddsorder-path saknas och första IB Paper-order blockeras.',
      'interactiveBrokersPaperOneShotExecutionService',
      protectiveOrderPathAvailable === true ? null : 'protective_order_path_missing',
    ),
    buildCheck('one_shot_armed', armActive === true, 'hard', armActive ? 'One-shot är armat.' : 'One-shot är inte armat.', 'interactiveBrokersPaperOneShotArmService', armActive ? null : 'one_shot_not_armed'),
    buildCheck('one_shot_arm_not_expired', armExpired === false, 'hard', armExpired ? 'Arm har gått ut.' : 'Arm är aktiv.', 'interactiveBrokersPaperOneShotArmService', armExpired ? 'one_shot_arm_expired' : null),
    buildCheck('one_shot_arm_not_used', armUsed === false, 'hard', armUsed ? 'Arm har redan använts.' : 'Arm är oanvänd.', 'interactiveBrokersPaperOneShotArmService', armUsed ? 'one_shot_arm_already_used' : null),
    buildCheck('one_shot_arm_blueprint_match', armBlueprintMatches === true, 'hard', armBlueprintMatches ? 'Arm matchar blueprint.' : 'Arm matchar inte blueprint.', 'interactiveBrokersPaperOneShotArmService', armBlueprintMatches ? null : 'one_shot_arm_blueprint_mismatch'),
    buildCheck('one_shot_arm_idempotency_match', armIdempotencyMatches === true, 'hard', armIdempotencyMatches ? 'Arm matchar idempotency key.' : 'Arm matchar inte idempotency key.', 'interactiveBrokersPaperOneShotArmService', armIdempotencyMatches ? null : 'one_shot_arm_idempotency_mismatch'),
    buildCheck('fas4e_execution_command', executionCommandApproved === true, 'hard', executionCommandApproved ? 'Fas 4E-kommandot är verifierat.' : 'Fas 4E-kommandot saknas eller matchar inte.', 'request.executionCommand', executionCommandApproved ? null : (executionCommand ? 'fas4e_execution_command_mismatch' : 'awaiting_explicit_fas_4e_order_command')),
    buildCheck('manual_user_initiated', manualInitiated === true, 'hard', manualInitiated ? 'Manuell användarinitiering är verifierad.' : 'Manuell användarinitiering krävs.', 'request.manualUserInitiated', manualInitiated ? null : REAL_SUBMIT_GATE_MANUAL_USER_INITIATED_REQUIRED),
    buildCheck('open_real_submit_gate_for_this_attempt', openGateRequested === true, 'hard', openGateRequested ? 'Denna attempt öppnar real-submit-gaten.' : 'Real-submit-gaten öppnas inte för denna attempt.', 'request.openRealSubmitGateForThisAttempt', openGateRequested ? null : REAL_SUBMIT_GATE_NOT_OPEN),
    buildCheck('no_scheduler_or_retry', true, 'info', 'Ingen scheduler, loop eller retry används i denna väg.', 'routes/api.js', null),
    buildCheck('no_live_order_path', true, 'info', 'Ingen live-orderväg aktiveras.', 'routes/api.js', null),
    buildCheck('execution_mode_bracket_required', true, 'info', 'Entry-only är förbjudet; en komplett bracket-path krävs innan order kan skickas.', 'interactiveBrokersPaperOneShotExecutionService', null),
  ];

  return {
    checks,
    featureEnabled,
    account,
    preflightReady,
    duplicateIdempotency,
    duplicateBlueprint,
    blueprintMatchesPreflight,
    confirmationPhrase,
    secondConfirmationPhrase,
    ackPaperOnly,
    ackNoLiveTrading,
    ackOneOrderOnly,
    ackBracketOrder,
    ackNoRetry,
    idempotencyKey,
    manualUserInitiated: manualInitiated,
    openRealSubmitGateForThisAttempt: openGateRequested,
    runtimeBracketSubmitUnlocked,
    realSubmitForThisAttempt,
    explicitRealSubmitGate: realSubmitGate.gateReady === true,
    realSubmitGate,
    helperReady: helperIsReady,
  };
}

function buildAttemptSummary({
  selectedBlueprint,
  preflight,
  account,
  config,
  idempotencyKey,
  blockers,
  accepted,
  orderSent,
  executed,
  duplicate,
  ibOrderId = null,
  submitted = false,
  executedAt = null,
  nextRequiredAction = null,
  wouldSendOrder = false,
  bracketSubmissionPlanReady = false,
  bracketSubmissionRealSubmitEnabled = false,
  runtimeBracketSubmitUnlocked = false,
  realSubmitForThisAttempt = false,
  explicitRealSubmitGate = false,
  realSubmitGate = null,
  helperReady = false,
  bracketOrderCount = 0,
  entryOnlyBlocked = true,
  bracketSubmissionPlan = null,
  uiStatus = null,
  manualUserInitiated = false,
  openRealSubmitGateForThisAttempt = false,
}) {
  return {
    executionAttemptId: `ibpo_${stableHash(`${idempotencyKey || 'missing'}:${selectedBlueprint?.blueprintId || 'missing'}:${nowIso()}`).slice(0, 16)}`,
    idempotencyKey: idempotencyKey || null,
    blueprintId: selectedBlueprint?.blueprintId || null,
    candidateId: selectedBlueprint?.candidateId || null,
    timestamp: nowIso(),
    mode: 'paper_only',
    accountMode: 'ib_paper',
    paperAccountMasked: account?.paperAccountIdMasked || null,
    symbol: selectedBlueprint?.symbol || null,
    strategyId: selectedBlueprint?.strategyId || null,
    side: selectedBlueprint?.side || null,
    quantity: selectedBlueprint?.quantity ?? null,
    orderType: selectedBlueprint?.orderType || 'LMT',
    status: executed ? 'EXECUTED' : (submitted ? 'SUBMITTED' : 'BLOCKED'),
    accepted,
    orderSent,
    executed,
    submitted,
    ibOrderId,
    blockedReason: blockers[0] || null,
    blockers,
    duplicate,
    wouldSendOrder,
    readyForFirstPaperOrder: preflight?.readyForFirstPaperOrder === true,
    preflightOnly: false,
    dryRun: accepted !== true || orderSent !== true,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled,
    runtimeBracketSubmitUnlocked,
    realSubmitForThisAttempt,
    explicitRealSubmitGate: realSubmitGate.gateReady === true,
    realSubmitGate,
    helperReady,
    bracketOrderCount,
    entryOnlyBlocked,
    bracketSubmissionPlan,
    uiStatus,
    manualUserInitiated: manualUserInitiated === true,
    openRealSubmitGateForThisAttempt: openRealSubmitGateForThisAttempt === true,
    protectiveOrdersSubmitted: false,
    protectiveOrdersRequiredForFuture: true,
    executionLimitedFirstOrder: true,
    eventLogged: true,
    executedAt,
    nextRequiredAction: nextRequiredAction || 'Fas 4B kräver separat explicit godkännande innan ytterligare order kan skickas.',
    requiredFeatureFlag: FEATURE_FLAG,
    safety: { ...SAFETY },
    featureFlag: FEATURE_FLAG,
  };
}

async function connectAndGetNextOrderId(config, options = {}) {
  const client = options.client || new IBApi({
    host: config.host,
    port: config.port,
    maxReqPerSec: 10,
  });
  const timeoutMs = options.timeoutMs || config.timeoutMs || DEFAULT_TIMEOUT_MS;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { client.disconnect(); } catch (_) {}
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`ib_connect_timeout_after_${timeoutMs}ms`)), timeoutMs);
    const onError = (error, code) => {
      const message = error?.message || `IB error ${code || 'unknown'}`;
      finish(new Error(message));
    };

    client.once(EventName.nextValidId, (orderId) => {
      clearTimeout(timer);
      client.removeListener(EventName.error, onError);
      finish(null, Number(orderId));
    });
    client.once(EventName.connected, () => {
      try { client.reqIds(1); } catch (err) { finish(err); }
    });
    client.on(EventName.error, onError);
    try {
      client.connect(config.clientId);
    } catch (err) {
      clearTimeout(timer);
      finish(err);
    }
  });
}

async function submitOneShotOrder(selectedBlueprint, options = {}) {
  const allowRealSubmit = options.allowRealSubmit === true;
  const mockOnly = options.mockOnly === undefined ? !allowRealSubmit : options.mockOnly === true;
  const dryRun = options.dryRun === undefined ? !allowRealSubmit : options.dryRun === true;
  const bracketSubmissionPlan = options.bracketSubmissionPlan
    || options.submissionPlan
    || interactiveBrokersPaperBracketSubmissionService.buildBracketSubmissionPlan({
      now: options.now,
      truth: options.truth,
      executionStatus: options.executionStatus,
      tradeBlueprint: options.tradeBlueprint,
      readiness: options.readiness,
      blueprintId: selectedBlueprint?.blueprintId || options.blueprintId || null,
      selectedBlueprint,
      selectedBlueprintId: options.selectedBlueprintId || null,
      protectivePlan: options.protectivePlan || options.protectivePreflight || null,
      nextValidId: options.nextValidId,
    });
  const submissionPlan = bracketSubmissionPlan?.submissionPlan || bracketSubmissionPlan;
  const executionAttemptId = safeString(options.executionAttemptId || `ibbsg_${stableHash(`${submissionPlan?.groupId || 'missing'}:${options.idempotencyKey || 'missing'}:${nowIso(options.now || new Date())}`).slice(0, 16)}`);
  return await interactiveBrokersPaperBracketSubmissionService.submitBracketOrderGroup({
    ...options,
    selectedBlueprint,
    contract: options.contract || submissionPlan?.contract || submissionPlan?.entry?.contract || null,
    submissionPlan,
    allowRealSubmit,
    mockOnly,
    dryRun,
    simulateMockCalls: options.simulateMockCalls === true,
    accountMode: options.accountMode || selectedBlueprint?.accountMode || 'ib_paper',
    executionAttemptId,
    idempotencyKey: safeString(options.idempotencyKey || options.body?.idempotencyKey || ''),
    mode: 'audit_only',
  });
}

async function buildPaperOneShotExecution(options = {}) {
  const now = options.now || new Date();
  const truth = options.truth || await paperTradingTruthService.buildPaperTradingTruth({ now });
  const executionStatus = options.executionStatus || truth?.ibPaper?.executionStatus || await paperTradingTruthService.buildExecutionStatus({ now });
  const tradeBlueprint = options.tradeBlueprint || truth?.ibPaper?.tradeBlueprint || await interactiveBrokersTradeBlueprintService.getTradeBlueprint({
    now,
    readiness: truth?.ibPaper?.connectionReadiness || truth?.readiness || undefined,
    topStrategies: truth?.topStrategies,
  });
  const readiness = options.readiness || truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || null;
  const config = options.config || readConfig();
  const readinessChecks = buildReadinessChecks(readiness, config);
  const selectedBlueprint = options.selectedBlueprint || resolveBlueprint(tradeBlueprint, options.blueprintId || options.selectedBlueprintId || null);
  const protectivePlan = options.protectivePlan || interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: selectedBlueprint?.blueprintId || options.blueprintId || null,
    selectedBlueprint,
  });
  const protectivePlanReady = protectivePlan?.protectivePlanReady === true;
  const protectiveOrderPathAvailable = protectivePlan?.protectivePathAvailable === true;
  const protectiveExecutionReady = protectivePlan?.protectiveExecutionReady === true;
  const bracketSubmissionPlan = options.bracketSubmissionPlan || interactiveBrokersPaperBracketSubmissionService.buildBracketSubmissionPlan({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: selectedBlueprint?.blueprintId || options.blueprintId || null,
    selectedBlueprint,
    protectivePlan,
    nextValidId: options.nextValidId ?? readiness?.nextValidId ?? executionStatus?.readiness?.nextValidId ?? null,
  });
  const bracketSubmissionPlanReady = bracketSubmissionPlan?.bracketSubmissionPlanReady === true;
  let bracketSubmissionRealSubmitEnabled = bracketSubmissionPlan?.bracketSubmissionRealSubmitEnabled === true;
  const bracketOrderCount = Number(bracketSubmissionPlan?.orderCount || 0);
  const entryOnlyBlocked = bracketSubmissionPlan?.entryOnlyBlocked === true;
  let armStatus = options.armStatus || interactiveBrokersPaperOneShotArmService.getArmStatus({ now });
  const state = options.loadState ? options.loadState() : loadState();
  const idempotencyKey = safeString(options.idempotencyKey || options.body?.idempotencyKey || '');
  const preflight = options.preflight || await interactiveBrokersPaperPreflightService.buildPaperExecutionPreflight({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: selectedBlueprint?.blueprintId || options.blueprintId || null,
    selectedBlueprint,
    confirmationPhrase: options.confirmationPhrase || options.confirmationText || '',
  });
  const commandCandidate = options.executionCommand || options.body?.executionCommand || options.body?.orderCommand || options.body?.finalExecutionCommand || '';
  const armSnapshot = armStatus?.currentArm || armStatus || null;
  const armActive = Boolean(armStatus?.armed === true || armSnapshot?.armed === true);
  const armExpired = Boolean(armStatus?.expired === true || armSnapshot?.expiredAt);
  const armUsed = Boolean(armStatus?.used === true || armSnapshot?.used === true);
  const commandApproved = REQUIRED_EXECUTION_COMMANDS.includes(safeString(commandCandidate));
  const ackPaperOnly = options.body?.acknowledgePaperOnly === true;
  const ackNoLiveTrading = options.body?.acknowledgeNoLiveTrading === true;
  const ackOneOrderOnly = options.body?.acknowledgeOneOrderOnly === true;
  const ackBracketOrder = options.body?.acknowledgeBracketOrder === true;
  const ackNoRetry = options.body?.acknowledgeNoRetry === true;
  const accountMatchesPaper = preflight?.account?.selectedAccountMatchesPaper === true;
  const blueprintMatchesPreflight = !safeString(preflight?.selectedBlueprint?.blueprintId)
    || !safeString(selectedBlueprint?.blueprintId)
    || safeString(preflight?.selectedBlueprint?.blueprintId) === safeString(selectedBlueprint?.blueprintId);
  const armBlueprintMatches = !safeString(selectedBlueprint?.blueprintId)
    || !safeString(armSnapshot?.blueprintId)
    || safeString(armSnapshot?.blueprintId) === safeString(selectedBlueprint?.blueprintId);
  const armIdempotencyMatches = !idempotencyKey
    || !safeString(armSnapshot?.idempotencyKey)
    || safeString(armSnapshot?.idempotencyKey) === idempotencyKey;
  const selectedBlueprintManualReady = selectedBlueprint?.blueprintReady === true && selectedBlueprint?.manualApprovalReady === true;
  const finalPhaseEnabled = options.finalPhaseEnabled === true || options.body?.testHarnessFinalPhaseEnabled === true;
  let allowRealSubmit = Boolean(
    finalPhaseEnabled === true
    && options.body?.manualUserInitiated === true
    && options.body?.openRealSubmitGateForThisAttempt === true
    && selectedBlueprintManualReady === true
    && preflight?.readyForFirstPaperOrder === true
    && protectivePlanReady === true
    && bracketSubmissionPlanReady === true
    && bracketOrderCount === 3
    && entryOnlyBlocked === true
    && commandApproved === true
    && ackPaperOnly === true
    && ackNoLiveTrading === true
    && ackOneOrderOnly === true
    && ackBracketOrder === true
    && ackNoRetry === true
    && accountMatchesPaper === true
    && blueprintMatchesPreflight === true
    && armActive === true
    && armExpired === false
    && armUsed === false
    && armBlueprintMatches === true
    && armIdempotencyMatches === true
    && options.simulateMockCalls !== true
    && options.testHarnessSimulateMockCalls !== true
    && options.body?.testHarnessSimulateMockCalls !== true
  );
  const executionAttemptId = safeString(options.executionAttemptId || `ibpo_${stableHash(`${idempotencyKey || 'missing'}:${selectedBlueprint?.blueprintId || 'missing'}:${nowIso(now)}`).slice(0, 16)}`);
  const bracketSubmissionHelper = selectedBlueprint && bracketSubmissionPlanReady === true && protectivePlanReady === true
    ? await submitOneShotOrder(selectedBlueprint, {
      now,
      truth,
      executionStatus,
      tradeBlueprint,
      readiness,
      preflight,
      protectivePlan,
      bracketSubmissionPlan,
      armStatus,
      idempotencyKey,
      executionAttemptId,
      contract: bracketSubmissionPlan?.contract || selectedBlueprint?.contract || null,
      bracketSubmissionPlan: bracketSubmissionPlan?.submissionPlan || bracketSubmissionPlan,
      executionCommand: options.executionCommand || options.body?.executionCommand || options.body?.orderCommand || options.body?.finalExecutionCommand || '',
      body: options.body || options,
      allowRealSubmit,
      mockOnly: !allowRealSubmit,
      dryRun: !allowRealSubmit,
      simulateMockCalls: options.simulateMockCalls === true || options.testHarnessSimulateMockCalls === true || options.body?.testHarnessSimulateMockCalls === true,
      accountMode: selectedBlueprint?.accountMode || 'ib_paper',
    })
    : null;
  const helperReady = bracketSubmissionHelper?.helperReady === true;
  const mockPlaceOrderCalls = Array.isArray(bracketSubmissionHelper?.mockPlaceOrderCalls) ? bracketSubmissionHelper.mockPlaceOrderCalls : [];
  const mockProtectiveOrdersSubmitted = bracketSubmissionHelper?.mockProtectiveOrdersSubmitted === true;
  const mockOrderSent = bracketSubmissionHelper?.mockOrderSent === true;
  let submitted = bracketSubmissionHelper?.submitted === true || bracketSubmissionHelper?.accepted === true && bracketSubmissionHelper?.orderSent === true;
  let executed = bracketSubmissionHelper?.executed === true;
  let orderSent = bracketSubmissionHelper?.orderSent === true;
  let ibOrderId = bracketSubmissionHelper?.ibOrderId ?? null;
  let orderStatus = bracketSubmissionHelper?.orderStatus || null;
  let capturedStatuses = Array.isArray(bracketSubmissionHelper?.capturedStatuses) ? bracketSubmissionHelper.capturedStatuses : [];
  let wouldSendOrder = bracketSubmissionHelper?.wouldSendOrder === true;
  if (bracketSubmissionHelper?.bracketSubmissionRealSubmitEnabled === true) {
    bracketSubmissionRealSubmitEnabled = true;
  }
  const realSubmitGatePreview = buildRealSubmitGate({
    selectedBlueprint,
    preflight,
    bracketSubmissionPlan,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled,
    helperReady,
    bracketOrderCount,
    entryOnlyBlocked,
    armStatus,
    executionCommand: options.executionCommand || options.body?.executionCommand || options.body?.orderCommand || options.body?.finalExecutionCommand || '',
    idempotencyKey,
    body: options.body || options,
    state,
    executionStatus,
    finalPhaseEnabled,
    runtimeBracketSubmitUnlocked: Boolean(
      helperReady === true
      && bracketSubmissionPlanReady === true
      && Number(bracketOrderCount || bracketSubmissionPlan?.orderCount || 0) === 3
      && entryOnlyBlocked === true
      && (options.executionCommand || options.body?.executionCommand || options.body?.orderCommand || options.body?.finalExecutionCommand || '') !== ''
      && (options.body?.acknowledgePaperOnly === true)
      && (options.body?.acknowledgeNoLiveTrading === true)
      && (options.body?.acknowledgeOneOrderOnly === true)
      && (options.body?.acknowledgeBracketOrder === true)
      && (options.body?.acknowledgeNoRetry === true)
      && accountMatchesPaper === true
      && blueprintMatchesPreflight === true
      && armStatus?.armed === true
      && armStatus?.expired !== true
      && armStatus?.used !== true
      && armBlueprintMatches === true
      && armIdempotencyMatches === true
    ),
  });
  const uiStatus = bracketSubmissionHelper?.uiStatus
    || bracketSubmissionPlan?.uiStatus
    || protectivePlan?.uiStatus
    || {
      blockedReason: protectiveExecutionReady === true ? 'real_submit_audit_only' : 'protective_bracket_submission_required',
      userMessageSv: protectiveExecutionReady === true
        ? '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.'
        : 'Kan inte skicka order: komplett bracket-/skyddsorder saknas.',
      orderButtonLocked: true,
      orderSent: false,
      executed: false,
    };
  const uiStatusWithGate = realSubmitGatePreview.gateReady === true && realSubmitGatePreview.gateOpensRealSubmit !== true
    ? {
      ...uiStatus,
      blockedReason: realSubmitGatePreview.blockedReason || REAL_SUBMIT_GATE_READY_REQUIRES_FINAL_PHASE,
      userMessageSv: realSubmitGatePreview.blockedReason === REAL_SUBMIT_GATE_MANUAL_USER_INITIATED_REQUIRED
        ? '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Manuell användarinitiering krävs innan real submit kan öppnas.'
        : '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit väntar på manuell finalisering.',
      orderButtonLocked: true,
      orderSent: false,
      executed: false,
    }
    : uiStatus;
  const oneShotBundle = buildOneShotChecks({
    config,
    readinessChecks,
    preflight,
    selectedBlueprint,
    idempotencyKey,
    protectivePlanReady,
    protectiveOrderPathAvailable,
    protectiveExecutionReady,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled,
    helperReady,
    bracketOrderCount,
    entryOnlyBlocked,
      bracketSubmissionPlan,
      mockPlaceOrderCalls,
      mockProtectiveOrdersSubmitted,
      mockOrderSent,
      uiStatus: uiStatusWithGate,
      manualUserInitiated: options.body?.manualUserInitiated === true,
      openRealSubmitGateForThisAttempt: options.body?.openRealSubmitGateForThisAttempt === true,
      armStatus,
      executionStatus,
      finalPhaseEnabled,
    executionCommand: options.executionCommand || options.body?.executionCommand || options.body?.orderCommand || options.body?.finalExecutionCommand || '',
    body: options.body || options,
    state,
  });
  const oneShotChecks = Array.isArray(oneShotBundle.checks) ? oneShotBundle.checks : [];
  const hardFailedChecks = oneShotChecks.filter((check) => check.ok !== true && check.severity === 'hard');
  const warnings = oneShotChecks.filter((check) => check.ok === true && check.severity === 'warning');
  const passedChecks = oneShotChecks.filter((check) => check.ok === true).length;
  const failedHardChecks = hardFailedChecks.length;
  const duplicate = oneShotChecks.some((check) => check.code === 'no_duplicate_idempotency' && check.ok !== true) || oneShotChecks.some((check) => check.code === 'no_duplicate_blueprint_execution' && check.ok !== true);
  const blockerPriority = [
    'manual_confirmation_required',
    'manual_confirmation_mismatch',
    'second_confirmation_required',
    'second_confirmation_mismatch',
    'idempotency_key_required',
    'duplicate_order_request',
    'duplicate_blueprint_execution',
    'missing_blueprint',
    'selected_blueprint_not_manual_ready',
    'stale_blueprint',
    'preflight_not_ready',
    'blueprint_not_ready',
    'manual_approval_not_ready',
    'ib_gateway_unreachable',
    'not_paper_mode_or_wrong_port',
    'ib_api_not_verified',
    'paper_account_not_verified',
    'ib_paper_execution_disabled',
    'protective_bracket_submission_required',
    'entry_only_forbidden',
    'manual_user_initiated_required',
    'real_submit_audit_only',
    'real_submit_gate_ready_requires_final_phase_4g2d',
    'real_submit_gate_account_mismatch',
    'real_submit_gate_blueprint_mismatch',
    'real_submit_gate_final_command_missing',
    'real_submit_gate_ack_missing',
    'real_submit_gate_duplicate_idempotency',
    'real_submit_gate_open_orders_present',
    'real_submit_gate_position_present',
    'real_submit_gate_scope_mismatch',
    'real_submit_gate_not_open',
    'one_shot_runtime_unlock_not_connected',
    'protective_plan_not_ready',
    'protective_order_path_missing',
    'one_shot_not_armed',
    'one_shot_arm_expired',
    'one_shot_arm_blueprint_mismatch',
    'one_shot_arm_idempotency_mismatch',
    'one_shot_arm_already_used',
    'awaiting_explicit_fas_4e_order_command',
    'fas4e_execution_command_mismatch',
  ];
  const blockers = [...new Set([
    ...(Array.isArray(preflight?.blockers) ? preflight.blockers : []),
    ...hardFailedChecks.map((check) => check.blocker || check.code).filter(Boolean),
  ])].sort((a, b) => {
    const ai = blockerPriority.indexOf(a);
    const bi = blockerPriority.indexOf(b);
    const aScore = ai === -1 ? 100 + String(a).length : ai;
    const bScore = bi === -1 ? 100 + String(b).length : bi;
    return aScore - bScore;
  });
  const featureEnabled = config.enabled === true;
  const preflightReady = preflight?.readyForFirstPaperOrder === true;
  const runtimeUnlocked = featureEnabled === true || armStatus?.armed === true || armStatus?.currentArm?.armed === true;
  const runtimeBracketSubmitUnlocked = oneShotBundle.runtimeBracketSubmitUnlocked === true;
  const realSubmitForThisAttempt = oneShotBundle.realSubmitForThisAttempt === true;
  const accepted = runtimeUnlocked && blockers.length === 0 && preflightReady && Boolean(selectedBlueprint) && selectedBlueprintManualReady === true && bracketSubmissionPlanReady === true && realSubmitForThisAttempt === true;
  const readyForOneShotExecution = accepted;
  let nextRequiredAction = 'Fas 4B kräver separat explicit godkännande innan ytterligare order kan skickas.';

  if (helperReady !== true || !bracketSubmissionPlanReady || bracketOrderCount !== 3 || entryOnlyBlocked !== true) {
    if (!blockers.includes('protective_bracket_submission_required')) blockers.unshift('protective_bracket_submission_required');
    nextRequiredAction = 'Skydds/bracket-submission saknas. Entry-only är förbjudet tills en säker bracket-path finns.';
  } else if (realSubmitForThisAttempt !== true) {
    const gateBlocker = runtimeBracketSubmitUnlocked === true
      ? (realSubmitGatePreview.blockedReason || 'real_submit_not_enabled_for_this_attempt')
      : REAL_SUBMIT_AUDIT_ONLY;
    if (!blockers.includes(gateBlocker)) blockers.unshift(gateBlocker);
    nextRequiredAction = runtimeBracketSubmitUnlocked === true
      ? 'Helpern och armen är redo, men real submit är inte öppnad för denna attempt.'
      : 'Audit-only: real submit är fortfarande avstängd.';
  } else if (armStatus?.expired === true || armStatus?.currentArm?.expiredAt) {
    if (!blockers.includes('one_shot_arm_expired')) blockers.unshift('one_shot_arm_expired');
    nextRequiredAction = 'Armen har gått ut. Arma igen om en framtida Fas 4E ska köras.';
  } else if (!REQUIRED_EXECUTION_COMMANDS.includes(safeString(options.executionCommand || options.body?.executionCommand || options.body?.orderCommand || options.body?.finalExecutionCommand || ''))) {
    if (!blockers.includes('awaiting_explicit_fas_4e_order_command')) blockers.unshift('awaiting_explicit_fas_4e_order_command');
    nextRequiredAction = 'Fas 4E kräver separat explicit orderkommando innan någon order kan skickas.';
  }

  if (selectedBlueprint && selectedBlueprintManualReady !== true) {
    if (!blockers.includes('selected_blueprint_not_manual_ready')) blockers.unshift('selected_blueprint_not_manual_ready');
    nextRequiredAction = 'Selected blueprint är inte manual-ready. Välj canonical trade_blueprint innan one-shot kan öppnas.';
  }

  if (selectedBlueprintManualReady === true && runtimeBracketSubmitUnlocked === true && helperReady === true && (armStatus?.armed === true || armStatus?.currentArm?.armed === true)) {
    try {
      armStatus = interactiveBrokersPaperOneShotArmService.consumeArm({
        now,
        armId: armStatus?.armId || armStatus?.currentArm?.armId || null,
        blueprintId: selectedBlueprint?.blueprintId || null,
        idempotencyKey,
        reason: 'real_submit_not_enabled_for_this_attempt',
      });
    } catch (_) {
      // Best-effort only.
    }
  }

  if (selectedBlueprint && (submitted === true || orderSent === true || ibOrderId != null)) {
    const persistedState = {
      ...state,
      idempotencyKeys: {
        ...(state.idempotencyKeys || {}),
        [idempotencyKey || `ibpo_${executionAttemptId}`]: {
          executionAttemptId,
          blueprintId: selectedBlueprint.blueprintId,
          candidateId: selectedBlueprint.candidateId || null,
          timestamp: nowIso(now),
          status: orderStatus || (executed ? 'EXECUTED' : 'SUBMITTED'),
        },
      },
      executedBlueprintIds: {
        ...(state.executedBlueprintIds || {}),
        [selectedBlueprint.blueprintId]: {
          executionAttemptId,
          idempotencyKey: idempotencyKey || null,
          timestamp: nowIso(now),
          status: orderStatus || (executed ? 'EXECUTED' : 'SUBMITTED'),
        },
      },
      attempts: [
        ...(Array.isArray(state.attempts) ? state.attempts : []),
        {
          executionAttemptId,
          idempotencyKey: idempotencyKey || null,
          blueprintId: selectedBlueprint.blueprintId,
          candidateId: selectedBlueprint.candidateId || null,
          timestamp: nowIso(now),
          status: orderStatus || (executed ? 'EXECUTED' : 'SUBMITTED'),
          submitted,
          executed,
          orderSent,
          ibOrderId,
        },
      ].slice(-100),
      lastAttempt: {
        executionAttemptId,
        idempotencyKey: idempotencyKey || null,
        blueprintId: selectedBlueprint.blueprintId,
        timestamp: nowIso(now),
        status: orderStatus || (executed ? 'EXECUTED' : 'SUBMITTED'),
      },
      lastSubmittedOrder: {
        executionAttemptId,
        blueprintId: selectedBlueprint.blueprintId,
        ibOrderId,
        timestamp: nowIso(now),
        status: orderStatus || (executed ? 'EXECUTED' : 'SUBMITTED'),
      },
      lastSyncAt: nowIso(now),
    };
    saveState(persistedState);
    appendExecutionAttempt({
      executionAttemptId,
      idempotencyKey: idempotencyKey || null,
      blueprintId: selectedBlueprint.blueprintId,
      candidateId: selectedBlueprint.candidateId || null,
      timestamp: nowIso(now),
      mode: 'paper_only',
      accountMode: 'ib_paper',
      paperAccountMasked: preflight?.account?.paperAccountIdMasked || null,
      symbol: selectedBlueprint.symbol,
      strategyId: selectedBlueprint.strategyId,
      strategyName: selectedBlueprint.strategyName,
      side: selectedBlueprint.side,
      quantity: selectedBlueprint.quantity,
      orderType: selectedBlueprint.orderType || 'LMT',
      status: orderStatus || (executed ? 'EXECUTED' : 'SUBMITTED'),
      accepted: true,
      orderSent,
      executed,
      ibOrderId,
      blockedReason: null,
      blockers: [],
      duplicate: false,
      safety: SAFETY,
      submitted,
      preflightReady,
      bracketSubmissionPlanReady,
      bracketSubmissionRealSubmitEnabled,
      helperReady,
      runtimeBracketSubmitUnlocked,
    bracketOrderCount,
    entryOnlyBlocked,
    bracketSubmissionPlan,
      uiStatus: uiStatusWithGate,
      userMessageSv: uiStatusWithGate?.userMessageSv || null,
      orderButtonLocked: uiStatusWithGate?.orderButtonLocked === true,
    protectiveOrdersSubmitted: false,
      protectiveOrdersRequiredForFuture: true,
      executionLimitedFirstOrder: true,
      armId: armStatus?.armId || null,
      armArmed: armStatus?.armed === true,
    });
    appendExecutionEvent({
      type: 'paper_execution_attempt_success',
      executionAttemptId,
      blueprintId: selectedBlueprint.blueprintId,
      candidateId: selectedBlueprint.candidateId || null,
      timestamp: nowIso(now),
      orderSent,
      executed,
      ibOrderId,
      orderStatus,
      capturedStatuses,
    });
  } else {
    appendExecutionAttempt({
      executionAttemptId: executionAttemptId || `ibpo_${stableHash(`${idempotencyKey || 'missing'}:${selectedBlueprint?.blueprintId || 'missing'}:${nowIso(now)}`).slice(0, 16)}`,
      idempotencyKey: idempotencyKey || null,
      blueprintId: selectedBlueprint?.blueprintId || null,
      candidateId: selectedBlueprint?.candidateId || null,
      timestamp: nowIso(now),
      mode: 'paper_only',
      accountMode: 'ib_paper',
      paperAccountMasked: preflight?.account?.paperAccountIdMasked || null,
      symbol: selectedBlueprint?.symbol || null,
      strategyId: selectedBlueprint?.strategyId || null,
      strategyName: selectedBlueprint?.strategyName || null,
      side: selectedBlueprint?.side || null,
      quantity: selectedBlueprint?.quantity ?? null,
      orderType: selectedBlueprint?.orderType || 'LMT',
      status: 'BLOCKED',
      accepted: false,
      orderSent: false,
      executed: false,
      ibOrderId: null,
      blockedReason: blockers[0] || null,
      blockers,
      duplicate,
      safety: SAFETY,
      submitted: false,
      preflightReady,
      bracketSubmissionPlanReady,
      bracketSubmissionRealSubmitEnabled,
      helperReady,
      bracketOrderCount,
      entryOnlyBlocked,
      bracketSubmissionPlan,
      protectiveOrdersSubmitted: false,
      protectiveOrdersRequiredForFuture: true,
      executionLimitedFirstOrder: true,
      armId: armStatus?.armId || null,
      armArmed: armStatus?.armed === true,
    });
    appendExecutionEvent({
      type: 'paper_execution_blocked',
      executionAttemptId: executionAttemptId || null,
      blueprintId: selectedBlueprint?.blueprintId || null,
      candidateId: selectedBlueprint?.candidateId || null,
      timestamp: nowIso(now),
      blockedReason: blockers[0] || null,
      blockers,
      duplicate,
      preflightReady,
    });
  }

  const summaryChecks = [...preflight.checks, ...oneShotChecks];
  const summary = {
    totalChecks: summaryChecks.length,
    passedChecks: summaryChecks.filter((row) => row.ok === true).length,
    failedHardChecks: summaryChecks.filter((row) => row.ok !== true && row.severity === 'hard').length,
    warningChecks: summaryChecks.filter((row) => row.ok === true && row.severity === 'warning').length,
    readyForFirstPaperOrder: preflight.readyForFirstPaperOrder === true,
    readyForOneShotExecution,
    protectiveExecutionReady,
    helperReady,
    runtimeBracketSubmitUnlocked,
    realSubmitForThisAttempt,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled,
    bracketOrderCount,
    entryOnlyBlocked,
    accepted,
    duplicate,
    blockedReason: blockers[0] || preflight?.blockedReason || null,
    nextRequiredAction,
    explicitRealSubmitGate: oneShotBundle.realSubmitGate?.gateReady === true,
    realSubmitGate: oneShotBundle.realSubmitGate || realSubmitGatePreview,
  };

  const result = buildAttemptSummary({
    selectedBlueprint,
    preflight,
    account: preflight?.account || buildAccountStatus(readinessChecks),
    config,
    idempotencyKey,
    blockers,
    accepted,
    orderSent,
    executed,
    duplicate,
    ibOrderId,
    submitted,
    executedAt: executed ? nowIso(now) : null,
    nextRequiredAction,
    wouldSendOrder,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled,
    helperReady,
    runtimeBracketSubmitUnlocked,
    realSubmitForThisAttempt,
    explicitRealSubmitGate: oneShotBundle.realSubmitGate?.gateReady === true,
    realSubmitGate: oneShotBundle.realSubmitGate || realSubmitGatePreview,
    bracketOrderCount,
    entryOnlyBlocked,
    bracketSubmissionPlan,
      mockPlaceOrderCalls,
      mockProtectiveOrdersSubmitted,
      mockOrderSent,
      uiStatus: uiStatusWithGate,
      manualUserInitiated: options.body?.manualUserInitiated === true,
      openRealSubmitGateForThisAttempt: options.body?.openRealSubmitGateForThisAttempt === true,
  });

  return {
    ok: accepted,
    mode: 'paper_only',
    oneShotEnabled: config.enabled === true,
    featureFlag: FEATURE_FLAG,
    requiredFeatureFlag: FEATURE_FLAG,
    preflightOnly: false,
    dryRun: !orderSent,
    accepted,
    readyForFirstPaperOrder: preflight.readyForFirstPaperOrder === true,
    readyForOneShotExecution,
    protectiveExecutionReady,
    runtimeBracketSubmitUnlocked,
    protectivePlanReady,
    protectiveOrderPathAvailable,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled,
    bracketOrderCount,
    entryOnlyBlocked,
    bracketSubmissionPlan,
    protectivePlan,
    wouldSendOrder,
    orderSent,
    executed,
    submitted,
    duplicate,
    blockedReason: blockers[0] || preflight?.blockedReason || null,
    blockers,
    warnings: oneShotChecks.filter((check) => check.ok === true && check.severity === 'warning').map((check) => check.code),
    checks: summaryChecks,
    summary,
    uiStatus: uiStatusWithGate,
    userMessageSv: uiStatusWithGate?.userMessageSv || null,
    orderButtonLocked: uiStatusWithGate?.orderButtonLocked === true,
    executionAttemptId,
    idempotencyKey,
    selectedBlueprint: selectedBlueprint || preflight?.selectedBlueprint || null,
    preflight,
    manualApproval: preflight?.manualApproval || null,
    protectivePlan,
    armStatus,
    account: preflight?.account || buildAccountStatus(readinessChecks),
    readiness: readinessChecks,
    readinessStatus: readinessChecks.blockedReason === 'read_only_session_verified' ? 'verified' : (readinessChecks.gatewayReachable ? 'reachable' : 'blocked'),
    orderStatus: orderStatus || null,
    ibOrderId: ibOrderId || null,
    eventLogged: true,
    protectiveOrdersSubmitted: false,
    mockProtectiveOrdersSubmitted,
    mockOrderSent,
    mockPlaceOrderCalls,
    protectiveOrdersRequiredForFuture: true,
    executionLimitedFirstOrder: true,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled,
    helperReady,
    runtimeBracketSubmitUnlocked,
    realSubmitForThisAttempt,
    explicitRealSubmitGate: oneShotBundle.realSubmitGate?.gateReady === true,
    realSubmitGate: oneShotBundle.realSubmitGate || realSubmitGatePreview,
    bracketOrderCount,
    entryOnlyBlocked,
    bracketSubmissionPlan,
    nextRequiredAction,
    safety: { ...SAFETY },
    manualUserInitiated: options.body?.manualUserInitiated === true,
    openRealSubmitGateForThisAttempt: options.body?.openRealSubmitGateForThisAttempt === true,
    dataFiles: {
      executions: EXECUTIONS_FILE,
      events: EVENTS_FILE,
      state: STATE_FILE,
    },
  };
}

module.exports = {
  SAFETY,
  FEATURE_FLAG,
  REQUIRED_CONFIRMATION_PHRASE,
  REQUIRED_SECOND_CONFIRMATION_PHRASE,
  buildPaperOneShotExecution,
  _internal: {
    safeString,
    safeUpper,
    safeLower,
    safeNumber,
    round,
    stableHash,
    nowIso,
    ensureDataDir,
    readJson,
    writeJson,
    appendJsonl,
    readConfig,
    loadState,
    saveState,
    resolveBlueprint,
    buildAccountStatus,
    buildReadinessChecks,
    buildOneShotChecks,
    buildAttemptSummary,
    connectAndGetNextOrderId,
    submitOneShotOrder,
  },
};
