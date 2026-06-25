'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paperTradingTruthService = require('./paperTradingTruthService');
const interactiveBrokersPaperPreflightService = require('./interactiveBrokersPaperPreflightService');
const interactiveBrokersPaperProtectiveOrderService = require('./interactiveBrokersPaperProtectiveOrderService');
const interactiveBrokersTradeBlueprintService = require('./interactiveBrokersTradeBlueprintService');

const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.resolve(process.env.IB_PAPER_ONE_SHOT_ARM_DATA_DIR || path.join(ROOT, 'data/interactive-brokers'));
const STATE_FILE = path.join(DATA_DIR, 'paper-one-shot-arm-state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'paper-one-shot-arm-events.jsonl');
const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 300;
const REQUIRED_CONFIRMATION_PHRASE = 'CONFIRM PAPER TRADE';
const REQUIRED_SECOND_CONFIRMATION_PHRASE = 'CONFIRM FIRST IB PAPER ORDER';
const REQUIRED_ARM_CONFIRMATION_PHRASE = 'ARM IB PAPER ONE SHOT';

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = value ? new Date(value) : new Date();
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
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

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireDashboardAuth(req, res) {
  const dashboardUser = process.env.DASHBOARD_USER;
  const dashboardPassword = process.env.DASHBOARD_PASSWORD;
  if (!dashboardUser || !dashboardPassword) {
    res.status(503).json({ ok: false, error: 'Dashboard auth not configured in .env', safety: SAFETY });
    return false;
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Scanner Dashboard"');
    res.status(401).send('Autentisering krävs');
    return false;
  }

  let reqUser = '';
  let reqPass = '';
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) throw new Error('no colon');
    reqUser = decoded.slice(0, colon);
    reqPass = decoded.slice(colon + 1);
  } catch (_) {
    res.set('WWW-Authenticate', 'Basic realm="Scanner Dashboard"');
    res.status(401).send('Ogiltigt format');
    return false;
  }

  const userOk = safeCompare(reqUser, dashboardUser);
  const passOk = safeCompare(reqPass, dashboardPassword);
  if (userOk && passOk) return true;

  res.set('WWW-Authenticate', 'Basic realm="Scanner Dashboard"');
  res.status(401).send('Felaktigt användarnamn eller lösenord');
  return false;
}

function maskPaperAccountId(accountId) {
  const value = safeString(accountId);
  if (!value) return null;
  if (value.length <= 5) return value;
  return `${value.slice(0, 2)}****${value.slice(-3)}`;
}

function normalizeState(saved = {}) {
  return {
    currentArm: saved.currentArm && typeof saved.currentArm === 'object' ? saved.currentArm : null,
    armsById: saved.armsById && typeof saved.armsById === 'object' ? saved.armsById : {},
    idempotencyKeys: saved.idempotencyKeys && typeof saved.idempotencyKeys === 'object' ? saved.idempotencyKeys : {},
    usedBlueprintIds: saved.usedBlueprintIds && typeof saved.usedBlueprintIds === 'object' ? saved.usedBlueprintIds : {},
    history: Array.isArray(saved.history) ? saved.history : [],
    lastArm: saved.lastArm || null,
    lastDisarm: saved.lastDisarm || null,
    lastExpire: saved.lastExpire || null,
    lastConsume: saved.lastConsume || null,
    lastSyncAt: saved.lastSyncAt || null,
  };
}

function loadState() {
  ensureDataDir();
  return normalizeState(readJson(STATE_FILE, {}));
}

function saveState(next) {
  writeJson(STATE_FILE, normalizeState(next));
}

function appendArmEvent(row) {
  appendJsonl(EVENTS_FILE, {
    ...row,
    mode: 'paper_only',
    paperOnly: true,
    accountMode: 'ib_paper',
    recordedAt: nowIso(),
  });
}

function buildTopStrategyIds(truth) {
  return Array.isArray(truth?.topStrategies?.topStrategies)
    ? truth.topStrategies.topStrategies.map((row) => safeString(row?.strategyId)).filter(Boolean)
    : [];
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

function expireArmIfNeeded(options = {}) {
  const now = toDate(options.now);
  const state = options.state || loadState();
  const currentArm = state.currentArm;
  if (!currentArm || currentArm.armed !== true || currentArm.used === true || currentArm.disarmedAt || currentArm.expiredAt) {
    return { state, expired: false, currentArm };
  }

  const expiresAtMs = new Date(currentArm.expiresAt || 0).getTime();
  if (!Number.isFinite(expiresAtMs) || now.getTime() <= expiresAtMs) {
    return { state, expired: false, currentArm };
  }

  const expiredArm = {
    ...currentArm,
    armed: false,
    expiredAt: nowIso(now),
    blockedReason: 'one_shot_arm_expired',
  };
  const next = {
    ...state,
    currentArm: expiredArm,
    armsById: {
      ...(state.armsById || {}),
      [expiredArm.armId]: expiredArm,
    },
    lastExpire: {
      armId: expiredArm.armId,
      blueprintId: expiredArm.blueprintId || null,
      timestamp: nowIso(now),
      reason: 'one_shot_arm_expired',
    },
    lastSyncAt: nowIso(now),
  };
  saveState(next);
  appendArmEvent({
    type: 'one_shot_arm_expired',
    armId: expiredArm.armId,
    blueprintId: expiredArm.blueprintId || null,
    candidateId: expiredArm.candidateId || null,
    idempotencyKey: expiredArm.idempotencyKey || null,
    expiresAt: expiredArm.expiresAt || null,
    expiredAt: expiredArm.expiredAt,
  });
  return { state: next, expired: true, currentArm: expiredArm };
}

function buildArmSnapshot(currentArm, extra = {}) {
  if (!currentArm) {
    return {
      armed: false,
      armId: null,
      createdAt: null,
      expiresAt: null,
      ttlSeconds: null,
      blueprintId: null,
      candidateId: null,
      symbol: null,
      strategyId: null,
      side: null,
      quantity: null,
      idempotencyKey: null,
      paperAccountMasked: null,
      preflightSnapshot: null,
      protectiveSnapshot: null,
      used: false,
      usedAt: null,
      disarmedAt: null,
      expiredAt: null,
      blockedReason: extra.blockedReason || 'one_shot_arm_not_armed',
      mode: 'paper_only',
      safety: { ...SAFETY },
    };
  }
  return {
    armed: currentArm.armed === true,
    armId: currentArm.armId || null,
    createdAt: currentArm.createdAt || null,
    expiresAt: currentArm.expiresAt || null,
    ttlSeconds: currentArm.ttlSeconds ?? null,
    blueprintId: currentArm.blueprintId || null,
    candidateId: currentArm.candidateId || null,
    symbol: currentArm.symbol || null,
    strategyId: currentArm.strategyId || null,
    side: currentArm.side || null,
    quantity: currentArm.quantity ?? null,
    idempotencyKey: currentArm.idempotencyKey || null,
    paperAccountMasked: currentArm.paperAccountMasked || null,
    preflightSnapshot: currentArm.preflightSnapshot || null,
    protectiveSnapshot: currentArm.protectiveSnapshot || null,
    used: currentArm.used === true,
    usedAt: currentArm.usedAt || null,
    disarmedAt: currentArm.disarmedAt || null,
    expiredAt: currentArm.expiredAt || null,
    blockedReason: currentArm.blockedReason || extra.blockedReason || null,
    mode: 'paper_only',
    safety: { ...SAFETY },
  };
}

function buildStatusResponse({ state, currentArm, expired = false, blockedReason = null, nextRequiredAction = null } = {}) {
  const snapshot = buildArmSnapshot(currentArm, { blockedReason });
  return {
    ok: true,
    mode: 'paper_only',
    armed: snapshot.armed === true,
    armId: snapshot.armId,
    currentArm: snapshot,
    expired,
    used: snapshot.used === true,
    usedAt: snapshot.usedAt,
    disarmedAt: snapshot.disarmedAt,
    expiredAt: snapshot.expiredAt,
    blockedReason: snapshot.blockedReason || blockedReason || null,
    nextRequiredAction: nextRequiredAction || (snapshot.armed ? 'Fas 4E kräver separat explicit orderkommando.' : 'Ingen aktiv arm finns.'),
    stateFile: STATE_FILE,
    eventsFile: EVENTS_FILE,
    safety: { ...SAFETY },
  };
}

function getArmStatus(options = {}) {
  const now = toDate(options.now);
  const loaded = expireArmIfNeeded({ now, state: options.state || loadState() });
  const currentArm = loaded.currentArm || loaded.state.currentArm || null;
  return buildStatusResponse({
    state: loaded.state,
    currentArm,
    expired: loaded.expired === true,
    blockedReason: currentArm?.blockedReason || (loaded.expired ? 'one_shot_arm_expired' : (currentArm?.armed === true ? null : 'one_shot_arm_not_armed')),
    nextRequiredAction: currentArm?.armed === true
      ? 'Fas 4E kräver separat explicit orderkommando.'
      : (loaded.expired ? 'Arm har gått ut. Kör arm igen om en ny fas ska öppnas.' : 'Ingen aktiv arm finns.'),
  });
}

function buildEligibilityChecks({
  truth,
  executionStatus,
  preflight,
  protectivePlan,
  selectedBlueprint,
  readiness,
  body = {},
  idempotencyKey = '',
  ttlSeconds = DEFAULT_TTL_SECONDS,
  requestedTtlSeconds = null,
  state = loadState(),
  now = new Date(),
}) {
  const account = preflight?.account || buildAccountStatus(readiness || truth?.ibPaper?.connectionReadiness || truth?.readiness || {});
  const confirmationPhrase = safeString(body.confirmationPhrase || '');
  const secondConfirmationPhrase = safeString(body.secondConfirmationPhrase || '');
  const armConfirmationPhrase = safeString(body.armConfirmationPhrase || '');
  const ackPaperOnly = body.acknowledgePaperOnly === true;
  const ackNoLiveTrading = body.acknowledgeNoLiveTrading === true;
  const ackOneOrderOnly = body.acknowledgeOneOrderOnly === true;
  const requestedTtl = Number(requestedTtlSeconds ?? ttlSeconds ?? DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
  const ttl = Math.min(Math.max(requestedTtl, 1), MAX_TTL_SECONDS);
  const clamped = ttl !== requestedTtl;
  const expiredState = expireArmIfNeeded({ now, state });
  const activeArm = expiredState.state.currentArm;
  const currentArmIdempotency = safeString(activeArm?.idempotencyKey);
  const currentArmBlueprintId = safeString(activeArm?.blueprintId);
  const blueprintId = safeString(selectedBlueprint?.blueprintId);
  const blueprintMatchesSelected = !body.blueprintId || !blueprintId || safeString(body.blueprintId) === blueprintId;
  const preflightReady = preflight?.readyForFirstPaperOrder === true;
  const protectivePathAvailable = protectivePlan?.protectivePathAvailable === true;
  const protectivePlanReady = protectivePlan?.protectivePlanReady === true;
  const orderModelVerified = protectivePlan?.orderModelVerified === true || protectivePlan?.contractVerified === true;
  const topStrategyIds = buildTopStrategyIds(truth);
  const strategyId = safeString(selectedBlueprint?.strategyId);
  const strategyInTop3 = Boolean(strategyId) && topStrategyIds.includes(strategyId);
  const selectedBlueprintReady = selectedBlueprint?.blueprintReady === true;
  const manualApprovalReady = selectedBlueprint?.manualApprovalReady === true;
  const stale = !selectedBlueprint || !selectedBlueprint.expiresAt || new Date(selectedBlueprint.expiresAt).getTime() < now.getTime();
  const duplicateIdempotency = Boolean(idempotencyKey && state.idempotencyKeys && state.idempotencyKeys[idempotencyKey]);
  const usedBlueprint = Boolean(blueprintId && state.usedBlueprintIds && state.usedBlueprintIds[blueprintId]);
  const activeArmExists = Boolean(activeArm && activeArm.armed === true && !activeArm.used && !activeArm.disarmedAt && !activeArm.expiredAt);
  const armMatchesBlueprint = !activeArmExists || !blueprintId || safeString(activeArm.blueprintId) === blueprintId;
  const armMatchesIdempotency = !activeArmExists || !idempotencyKey || safeString(activeArm.idempotencyKey) === idempotencyKey;

  const checks = [
    { code: 'paper_only_mode', ok: SAFETY.mode === 'paper_only', severity: 'hard', messageSv: 'Läget är paper_only.', source: 'safety.mode', blocker: SAFETY.mode === 'paper_only' ? null : 'paper_only_mode' },
    { code: 'actions_allowed_false', ok: SAFETY.actions_allowed === false, severity: 'hard', messageSv: 'actions_allowed är false.', source: 'safety.actions_allowed', blocker: SAFETY.actions_allowed === false ? null : 'actions_allowed_true' },
    { code: 'can_place_orders_false', ok: SAFETY.can_place_orders === false, severity: 'hard', messageSv: 'can_place_orders är false.', source: 'safety.can_place_orders', blocker: SAFETY.can_place_orders === false ? null : 'can_place_orders_true' },
    { code: 'live_trading_disabled', ok: SAFETY.live_trading_enabled === false, severity: 'hard', messageSv: 'live_trading_enabled är false.', source: 'safety.live_trading_enabled', blocker: SAFETY.live_trading_enabled === false ? null : 'live_trading_enabled_true' },
    { code: 'broker_disabled', ok: SAFETY.broker_enabled === false, severity: 'hard', messageSv: 'broker_enabled är false.', source: 'safety.broker_enabled', blocker: SAFETY.broker_enabled === false ? null : 'broker_enabled_true' },
    { code: 'selected_blueprint_exists', ok: Boolean(selectedBlueprint), severity: 'hard', messageSv: selectedBlueprint ? 'Selected blueprint finns.' : 'Selected blueprint saknas.', source: 'tradeBlueprint.selectedBlueprint', blocker: selectedBlueprint ? null : 'missing_blueprint' },
    { code: 'selected_blueprint_manual_ready', ok: selectedBlueprintReady === true && manualApprovalReady === true, severity: 'hard', messageSv: selectedBlueprintReady === true && manualApprovalReady === true ? 'Blueprinten är manual-ready.' : 'Blueprinten är inte manual-ready.', source: 'tradeBlueprint.selectedBlueprint', blocker: selectedBlueprintReady === true && manualApprovalReady === true ? null : 'selected_blueprint_not_manual_ready' },
    { code: 'blueprint_id_matches', ok: blueprintMatchesSelected, severity: 'hard', messageSv: blueprintMatchesSelected ? 'BlueprintId matchar selected blueprint.' : 'BlueprintId matchar inte selected blueprint.', source: 'request.blueprintId', blocker: blueprintMatchesSelected ? null : 'blueprint_mismatch' },
    { code: 'blueprint_not_stale', ok: !stale, severity: 'hard', messageSv: !stale ? 'Blueprint är färsk.' : 'Blueprint har blivit stale.', source: 'selectedBlueprint.expiresAt', blocker: !stale ? null : 'stale_blueprint' },
    { code: 'preflight_ready', ok: preflightReady, severity: 'hard', messageSv: preflightReady ? 'Preflight är redo.' : 'Preflight är inte redo.', source: 'paperExecute/preflight', blocker: preflightReady ? null : 'preflight_not_ready' },
    { code: 'protective_path_available', ok: protectivePathAvailable, severity: 'hard', messageSv: protectivePathAvailable ? 'Skyddsplanen finns.' : 'Skyddsplanen saknas.', source: 'interactiveBrokersPaperProtectiveOrderService', blocker: protectivePathAvailable ? null : 'protective_order_path_missing' },
    { code: 'protective_plan_ready', ok: protectivePlanReady, severity: 'hard', messageSv: protectivePlanReady ? 'Skyddsplanen är redo.' : 'Skyddsplanen är inte redo.', source: 'interactiveBrokersPaperProtectiveOrderService', blocker: protectivePlanReady ? null : 'protective_plan_not_ready' },
    { code: 'order_model_verified', ok: orderModelVerified, severity: 'hard', messageSv: orderModelVerified ? 'Ordermodellen är verifierad.' : 'Ordermodellen är inte verifierad.', source: '@stoqey/ib', blocker: orderModelVerified ? null : 'ib_order_model_unverified' },
    { code: 'ib_api_verified', ok: readiness?.ibApiVerified === true, severity: 'hard', messageSv: readiness?.ibApiVerified === true ? 'IB API-sessionen är verifierad.' : 'IB API-sessionen är inte verifierad.', source: 'interactiveBrokersPreviewService.verifyPaperSession', blocker: readiness?.ibApiVerified === true ? null : 'ib_api_not_verified' },
    { code: 'paper_account_verified', ok: readiness?.paperAccountVerified === true, severity: 'hard', messageSv: readiness?.paperAccountVerified === true ? 'Paper account är verifierat.' : 'Paper account är inte verifierat.', source: 'interactiveBrokersPreviewService.verifyPaperSession', blocker: readiness?.paperAccountVerified === true ? null : 'paper_account_not_verified' },
    { code: 'paper_mode_verified', ok: readiness?.paperModeVerified === true, severity: 'hard', messageSv: readiness?.paperModeVerified === true ? 'Paper mode är verifierat.' : 'Paper mode är inte verifierat.', source: 'interactiveBrokersPreviewService.verifyPaperSession', blocker: readiness?.paperModeVerified === true ? null : 'paper_mode_not_verified' },
    { code: 'session_verified', ok: readiness?.sessionVerified === true, severity: 'hard', messageSv: readiness?.sessionVerified === true ? 'Sessionen är verifierad.' : 'Sessionen är inte verifierad.', source: 'interactiveBrokersPreviewService.verifyPaperSession', blocker: readiness?.sessionVerified === true ? null : 'session_not_verified' },
    { code: 'selected_account_exists', ok: account.selectedAccountExists === true, severity: 'hard', messageSv: account.selectedAccountExists ? 'Selected account finns.' : 'Selected account saknas.', source: 'readiness.managedAccounts', blocker: account.selectedAccountExists ? null : 'selected_account_missing' },
    { code: 'selected_account_matches_paper', ok: account.selectedAccountMatchesPaper === true, severity: 'hard', messageSv: account.selectedAccountMatchesPaper ? 'Selected account matchar paper-kontot.' : 'Selected account matchar inte paper-kontot.', source: 'readiness.managedAccounts', blocker: account.selectedAccountMatchesPaper ? null : 'paper_account_mismatch' },
    { code: 'confirmation_phrase', ok: confirmationPhrase === REQUIRED_CONFIRMATION_PHRASE, severity: 'hard', messageSv: confirmationPhrase === REQUIRED_CONFIRMATION_PHRASE ? 'Första bekräftelsefrasen matchar.' : 'Första bekräftelsefrasen saknas eller matchar inte.', source: 'request.confirmationPhrase', blocker: confirmationPhrase === REQUIRED_CONFIRMATION_PHRASE ? null : (confirmationPhrase ? 'manual_confirmation_mismatch' : 'manual_confirmation_required') },
    { code: 'second_confirmation_phrase', ok: secondConfirmationPhrase === REQUIRED_SECOND_CONFIRMATION_PHRASE, severity: 'hard', messageSv: secondConfirmationPhrase === REQUIRED_SECOND_CONFIRMATION_PHRASE ? 'Andra bekräftelsefrasen matchar.' : 'Andra bekräftelsefrasen saknas eller matchar inte.', source: 'request.secondConfirmationPhrase', blocker: secondConfirmationPhrase === REQUIRED_SECOND_CONFIRMATION_PHRASE ? null : (secondConfirmationPhrase ? 'second_confirmation_mismatch' : 'second_confirmation_required') },
    { code: 'arm_confirmation_phrase', ok: armConfirmationPhrase === REQUIRED_ARM_CONFIRMATION_PHRASE, severity: 'hard', messageSv: armConfirmationPhrase === REQUIRED_ARM_CONFIRMATION_PHRASE ? 'Arm-frasen matchar.' : 'Arm-frasen saknas eller matchar inte.', source: 'request.armConfirmationPhrase', blocker: armConfirmationPhrase === REQUIRED_ARM_CONFIRMATION_PHRASE ? null : (armConfirmationPhrase ? 'arm_confirmation_mismatch' : 'arm_confirmation_required') },
    { code: 'acknowledge_paper_only', ok: ackPaperOnly === true, severity: 'hard', messageSv: ackPaperOnly ? 'Paper-only bekräftad.' : 'Paper-only måste bekräftas.', source: 'request.acknowledgePaperOnly', blocker: ackPaperOnly ? null : 'paper_only_ack_required' },
    { code: 'acknowledge_no_live_trading', ok: ackNoLiveTrading === true, severity: 'hard', messageSv: ackNoLiveTrading ? 'Ingen live trading bekräftad.' : 'Ingen live trading måste bekräftas.', source: 'request.acknowledgeNoLiveTrading', blocker: ackNoLiveTrading ? null : 'no_live_trading_ack_required' },
    { code: 'acknowledge_one_order_only', ok: ackOneOrderOnly === true, severity: 'hard', messageSv: ackOneOrderOnly ? 'Endast en order bekräftad.' : 'Endast en order måste bekräftas.', source: 'request.acknowledgeOneOrderOnly', blocker: ackOneOrderOnly ? null : 'one_order_only_ack_required' },
    { code: 'idempotency_key_present', ok: Boolean(idempotencyKey), severity: 'hard', messageSv: idempotencyKey ? 'Idempotency key finns.' : 'Idempotency key saknas.', source: 'request.idempotencyKey', blocker: idempotencyKey ? null : 'idempotency_key_required' },
    { code: 'idempotency_key_unique', ok: !duplicateIdempotency, severity: 'hard', messageSv: duplicateIdempotency ? 'Idempotency key är redan använd.' : 'Idempotency key är unik.', source: 'state.idempotencyKeys', blocker: duplicateIdempotency ? 'duplicate_order_request' : null },
    { code: 'blueprint_not_already_used', ok: true, severity: 'info', messageSv: usedBlueprint ? 'Blueprinten har använts tidigare, men ny manuell arm tillåts för ny attempt.' : 'Blueprinten är inte tidigare använd.', source: 'state.usedBlueprintIds', blocker: null },
    { code: 'no_active_arm_mismatch', ok: !activeArmExists || armMatchesBlueprint, severity: 'hard', messageSv: armMatchesBlueprint ? 'Aktiv arm matchar blueprint.' : 'Aktiv arm matchar inte blueprint.', source: 'state.currentArm', blocker: armMatchesBlueprint ? null : 'one_shot_arm_blueprint_mismatch' },
    { code: 'no_active_arm_idempotency_mismatch', ok: !activeArmExists || armMatchesIdempotency, severity: 'hard', messageSv: armMatchesIdempotency ? 'Aktiv arm matchar idempotency key.' : 'Aktiv arm matchar inte idempotency key.', source: 'state.currentArm', blocker: armMatchesIdempotency ? null : 'one_shot_arm_idempotency_mismatch' },
    { code: 'no_active_arm_used', ok: !activeArmExists || activeArm.used !== true, severity: 'hard', messageSv: activeArm?.used === true ? 'Aktiv arm har redan använts.' : 'Aktiv arm är oanvänd.', source: 'state.currentArm', blocker: activeArm?.used === true ? 'one_shot_arm_already_used' : null },
    { code: 'ttl_seconds_valid', ok: ttl <= MAX_TTL_SECONDS, severity: 'hard', messageSv: ttl <= MAX_TTL_SECONDS ? 'ttlSeconds är giltig.' : 'ttlSeconds överstiger max.', source: 'request.ttlSeconds', blocker: ttl <= MAX_TTL_SECONDS ? null : 'ttl_seconds_too_large' },
    { code: 'no_live_flags_true', ok: SAFETY.actions_allowed === false && SAFETY.can_place_orders === false && SAFETY.live_trading_enabled === false && SAFETY.broker_enabled === false, severity: 'hard', messageSv: 'Globala live-flaggor är false.', source: 'safety', blocker: null },
    { code: 'no_order_send', ok: true, severity: 'info', messageSv: 'Arm skickar aldrig order.', source: 'interactiveBrokersPaperOneShotArmService', blocker: null },
  ];

  const hardFailedChecks = checks.filter((check) => check.ok !== true && check.severity === 'hard');
  const blockers = [...new Set(hardFailedChecks.map((check) => check.blocker || check.code).filter(Boolean))];
  const warnings = [];
  if (clamped) warnings.push('ttl_clamped_to_300');

  return {
    now,
    ttl,
    clamped,
    account,
    checks,
    blockers,
    warnings,
    hardFailedChecks,
    selectedBlueprint,
    blueprintId,
    activeArm,
    duplicateIdempotency,
    usedBlueprint,
    preflightReady,
    protectivePathAvailable,
    protectivePlanReady,
    orderModelVerified,
    readiness,
    executionStatus,
    truth,
  };
}

function buildArmResponse({
  accepted,
  armed,
  armRecord,
  blockedReason,
  blockers = [],
  warnings = [],
  checks = [],
  nextRequiredAction = null,
  currentArm = null,
  expired = false,
  disarmed = false,
  consumed = false,
  reason = null,
  truth = null,
  executionStatus = null,
  tradeBlueprint = null,
  preflight = null,
  protectivePlan = null,
  safety = SAFETY,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  clamped = false,
  account = null,
} = {}) {
  return {
    ok: true,
    mode: 'paper_only',
    accepted: accepted === true,
    armed: armed === true,
    armId: armRecord?.armId || currentArm?.armId || null,
    expiresAt: armRecord?.expiresAt || currentArm?.expiresAt || null,
    ttlSeconds,
    ttlClamped: clamped === true,
    orderSent: false,
    executed: false,
    used: currentArm?.used === true || consumed === true,
    usedAt: currentArm?.usedAt || null,
    disarmedAt: currentArm?.disarmedAt || null,
    expiredAt: currentArm?.expiredAt || null,
    blockedReason: blockedReason || null,
    blockers: Array.isArray(blockers) ? blockers : [],
    warnings: Array.isArray(warnings) ? warnings : [],
    checks: Array.isArray(checks) ? checks : [],
    currentArm: buildArmSnapshot(armRecord || currentArm, { blockedReason }),
    preflightSnapshot: preflight ? {
      readyForFirstPaperOrder: preflight.readyForFirstPaperOrder === true,
      totalChecks: preflight.summary?.totalChecks ?? preflight.checks?.length ?? 0,
      failedHardChecks: preflight.summary?.failedHardChecks ?? 0,
    } : null,
    protectiveSnapshot: protectivePlan ? {
      protectivePathAvailable: protectivePlan.protectivePathAvailable === true,
      protectivePlanReady: protectivePlan.protectivePlanReady === true,
      orderModelVerified: protectivePlan.orderModelVerified === true,
    } : null,
    account: account || null,
    selectedBlueprint: armRecord?.selectedBlueprint || currentArm?.selectedBlueprint || null,
    nextRequiredAction: nextRequiredAction || (armed ? 'Fas 4E kräver separat explicit orderkommando.' : 'Ingen aktiv arm finns.'),
    consumed: consumed === true,
    disarmed: disarmed === true,
    expired: expired === true,
    reason: reason || null,
    truth,
    executionStatus,
    tradeBlueprint,
    safety: { ...safety },
    dataFiles: {
      state: STATE_FILE,
      events: EVENTS_FILE,
    },
  };
}

function armOneShot(options = {}) {
  const now = toDate(options.now);
  const truth = options.truth || null;
  const executionStatus = options.executionStatus || truth?.ibPaper?.executionStatus || null;
  const tradeBlueprint = options.tradeBlueprint || truth?.ibPaper?.tradeBlueprint || null;
  const readiness = options.readiness || truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || null;
  const preflight = options.preflight || null;
  const protectivePlan = options.protectivePlan || null;
  const canonicalSelection = interactiveBrokersTradeBlueprintService._internal.selectManualReadyIbPaperBlueprint(tradeBlueprint || {});
  const selectedBlueprint = options.selectedBlueprint || resolveBlueprint(tradeBlueprint, options.blueprintId || options.selectedBlueprintId || null);
  const selectedBlueprintReady = selectedBlueprint?.blueprintReady === true;
  const manualApprovalReady = selectedBlueprint?.manualApprovalReady === true;
  const selectedBlueprintIsSafe = Boolean(
    selectedBlueprint?.blueprintId
    && selectedBlueprintReady === true
    && manualApprovalReady === true
    && canonicalSelection?.selectedBlueprintId
    && safeString(selectedBlueprint.blueprintId) === safeString(canonicalSelection.selectedBlueprintId)
    && safeString(selectedBlueprint.accountMode || 'ib_paper').toLowerCase() === 'ib_paper'
    && selectedBlueprint.source !== 'protective_preflight'
    && selectedBlueprint.fallback !== true
  );
  if (!selectedBlueprintIsSafe) {
    return buildArmResponse({
      accepted: false,
      armed: false,
      armRecord: null,
      blockedReason: 'selected_blueprint_not_safe_for_arm',
      blockers: ['selected_blueprint_not_safe_for_arm'],
      warnings: [],
      checks: [],
      nextRequiredAction: 'Välj canonical manual-ready trade_blueprint innan arm kan skapas.',
      currentArm: null,
      truth,
      executionStatus,
      tradeBlueprint,
      preflight,
      protectivePlan,
      safety: SAFETY,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      clamped: false,
      account: buildAccountStatus(readiness),
    });
  }
  const idempotencyKey = safeString(options.idempotencyKey || options.body?.idempotencyKey || '');
  const ttlSecondsRaw = safeNumber(options.ttlSeconds ?? options.body?.ttlSeconds ?? DEFAULT_TTL_SECONDS) ?? DEFAULT_TTL_SECONDS;
  const ttlSeconds = Math.min(Math.max(Math.round(ttlSecondsRaw), 1), MAX_TTL_SECONDS);
  const body = options.body || options;
  const readyPreflight = preflight || interactiveBrokersPaperPreflightService.buildPaperExecutionPreflight({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: selectedBlueprint?.blueprintId || options.blueprintId || options.selectedBlueprintId || null,
    confirmationPhrase: body.confirmationPhrase || '',
  });
  const readyProtectivePlan = protectivePlan || interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: selectedBlueprint?.blueprintId || options.blueprintId || options.selectedBlueprintId || null,
    selectedBlueprint,
  });
  const state = expireArmIfNeeded({ now, state: options.loadState ? options.loadState() : loadState() }).state;
  const eligibility = buildEligibilityChecks({
    truth,
    executionStatus,
    preflight: readyPreflight,
    protectivePlan: readyProtectivePlan,
    selectedBlueprint,
    readiness,
    body,
    idempotencyKey,
    ttlSeconds,
    requestedTtlSeconds: ttlSecondsRaw,
    state,
    now,
  });

  const { checks, blockers, warnings, hardFailedChecks, account, ttl, clamped } = eligibility;
  const accepted = blockers.length === 0
    && Boolean(selectedBlueprint)
    && selectedBlueprintReady === true
    && manualApprovalReady === true
    && readyPreflight?.readyForFirstPaperOrder === true
    && readyProtectivePlan?.protectivePlanReady === true;
  const currentArm = state.currentArm && state.currentArm.armed === true && !state.currentArm.used && !state.currentArm.disarmedAt && !state.currentArm.expiredAt ? state.currentArm : null;
  const armId = `ibpa_${stableHash(`${selectedBlueprint?.blueprintId || 'missing'}:${idempotencyKey || 'missing'}:${nowIso(now)}`).slice(0, 16)}`;
  const armRecord = accepted ? {
    armed: true,
    armId,
    createdAt: nowIso(now),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    ttlSeconds: ttl,
    blueprintId: selectedBlueprint.blueprintId || null,
    candidateId: selectedBlueprint.candidateId || null,
    symbol: selectedBlueprint.symbol || null,
    strategyId: selectedBlueprint.strategyId || null,
    side: selectedBlueprint.side || null,
    quantity: selectedBlueprint.quantity ?? null,
    idempotencyKey,
    paperAccountMasked: account.paperAccountIdMasked || null,
    preflightSnapshot: {
      readyForFirstPaperOrder: readyPreflight?.readyForFirstPaperOrder === true,
      totalChecks: readyPreflight?.summary?.totalChecks ?? readyPreflight?.checks?.length ?? 0,
      failedHardChecks: readyPreflight?.summary?.failedHardChecks ?? 0,
    },
    protectiveSnapshot: {
      protectivePathAvailable: readyProtectivePlan?.protectivePathAvailable === true,
      protectivePlanReady: readyProtectivePlan?.protectivePlanReady === true,
      orderModelVerified: readyProtectivePlan?.orderModelVerified === true,
    },
    used: false,
    usedAt: null,
    disarmedAt: null,
    expiredAt: null,
    mode: 'paper_only',
    selectedBlueprint,
    safety: { ...SAFETY },
    confirmationPhrase: body.confirmationPhrase || null,
    secondConfirmationPhrase: body.secondConfirmationPhrase || null,
    armConfirmationPhrase: body.armConfirmationPhrase || null,
  } : null;

  let nextState = state;
  let disarmed = false;
  if (accepted && armRecord) {
    nextState = {
      ...state,
      currentArm: armRecord,
      armsById: {
        ...(state.armsById || {}),
        [armId]: armRecord,
      },
      idempotencyKeys: {
        ...(state.idempotencyKeys || {}),
        [idempotencyKey]: {
          armId,
          blueprintId: armRecord.blueprintId,
          candidateId: armRecord.candidateId || null,
          timestamp: nowIso(now),
          status: 'ARMED',
        },
      },
      lastArm: {
        armId,
        blueprintId: armRecord.blueprintId,
        candidateId: armRecord.candidateId || null,
        timestamp: nowIso(now),
        status: 'ARMED',
      },
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          type: 'one_shot_arm_armed',
          armId,
          blueprintId: armRecord.blueprintId,
          candidateId: armRecord.candidateId || null,
          timestamp: nowIso(now),
          ttlSeconds: ttl,
        },
      ].slice(-100),
      lastSyncAt: nowIso(now),
    };
    saveState(nextState);
    appendArmEvent({
      type: 'one_shot_arm_armed',
      armId,
      blueprintId: armRecord.blueprintId,
      candidateId: armRecord.candidateId || null,
      idempotencyKey,
      ttlSeconds: ttl,
      expiresAt: armRecord.expiresAt,
      paperAccountMasked: armRecord.paperAccountMasked,
      preflightSnapshot: armRecord.preflightSnapshot,
      protectiveSnapshot: armRecord.protectiveSnapshot,
    });
  } else {
    appendArmEvent({
      type: 'one_shot_arm_blocked',
      armId,
      blueprintId: selectedBlueprint?.blueprintId || null,
      candidateId: selectedBlueprint?.candidateId || null,
      idempotencyKey: idempotencyKey || null,
      blockedReason: blockers[0] || 'one_shot_arm_not_ready',
      blockers,
      ttlSeconds: ttl,
      clamped,
    });
  }

  return buildArmResponse({
    accepted,
    armed: accepted,
    armRecord,
    blockedReason: accepted ? null : (blockers[0] || 'one_shot_arm_not_ready'),
    blockers,
    warnings,
    checks,
    nextRequiredAction: accepted
      ? 'Fas 4E kräver separat explicit orderkommando.'
      : `Åtgärda blockerarna och arma igen. Första blocker: ${blockers[0] || 'one_shot_arm_not_ready'}.`,
    currentArm,
    truth,
    executionStatus,
    tradeBlueprint,
    preflight: readyPreflight,
    protectivePlan: readyProtectivePlan,
    safety: SAFETY,
    ttlSeconds: ttl,
    clamped,
    account,
  });
}

function disarmOneShot(options = {}) {
  const now = toDate(options.now);
  const loaded = expireArmIfNeeded({ now, state: options.loadState ? options.loadState() : loadState() });
  const state = loaded.state;
  const currentArm = state.currentArm;
  const requestedArmId = safeString(options.armId || options.body?.armId || '');
  if (!currentArm || currentArm.armed !== true) {
    appendArmEvent({
      type: 'one_shot_arm_disarm_noop',
      armId: requestedArmId || null,
      reason: safeString(options.reason || options.body?.reason || 'manual_cancel') || 'manual_cancel',
    });
    return buildArmResponse({
      accepted: true,
      armed: false,
      blockedReason: 'one_shot_arm_not_armed',
      blockers: [],
      warnings: [],
      checks: [],
      nextRequiredAction: 'Ingen aktiv arm fanns att avbryta.',
      currentArm: currentArm || null,
      reason: safeString(options.reason || options.body?.reason || 'manual_cancel') || 'manual_cancel',
      safety: SAFETY,
    });
  }

  const disarmedArm = {
    ...currentArm,
    armed: false,
    disarmedAt: nowIso(now),
    blockedReason: 'one_shot_arm_disarmed',
  };
  const next = {
    ...state,
    currentArm: disarmedArm,
    armsById: {
      ...(state.armsById || {}),
      [disarmedArm.armId]: disarmedArm,
    },
    lastDisarm: {
      armId: disarmedArm.armId,
      blueprintId: disarmedArm.blueprintId || null,
      timestamp: nowIso(now),
      reason: safeString(options.reason || options.body?.reason || 'manual_cancel') || 'manual_cancel',
    },
    history: [
      ...(Array.isArray(state.history) ? state.history : []),
      {
        type: 'one_shot_arm_disarmed',
        armId: disarmedArm.armId,
        blueprintId: disarmedArm.blueprintId || null,
        timestamp: nowIso(now),
      },
    ].slice(-100),
    lastSyncAt: nowIso(now),
  };
  saveState(next);
  appendArmEvent({
    type: 'one_shot_arm_disarmed',
    armId: disarmedArm.armId,
    blueprintId: disarmedArm.blueprintId || null,
    candidateId: disarmedArm.candidateId || null,
    reason: safeString(options.reason || options.body?.reason || 'manual_cancel') || 'manual_cancel',
    disarmedAt: disarmedArm.disarmedAt,
  });
  return buildArmResponse({
    accepted: true,
    armed: false,
    armRecord: disarmedArm,
    blockedReason: null,
    blockers: [],
    warnings: [],
    checks: [],
    currentArm: disarmedArm,
    disarmed: true,
    reason: safeString(options.reason || options.body?.reason || 'manual_cancel') || 'manual_cancel',
    nextRequiredAction: 'Ingen aktiv arm finns.',
    safety: SAFETY,
  });
}

function consumeArm(options = {}) {
  const now = toDate(options.now);
  const loaded = expireArmIfNeeded({ now, state: options.loadState ? options.loadState() : loadState() });
  const state = loaded.state;
  const currentArm = state.currentArm;
  const requestedArmId = safeString(options.armId || options.body?.armId || '');
  const requestedBlueprintId = safeString(options.blueprintId || options.body?.blueprintId || currentArm?.blueprintId || '');
  const requestedIdempotencyKey = safeString(options.idempotencyKey || options.body?.idempotencyKey || currentArm?.idempotencyKey || '');

  if (!currentArm || currentArm.armed !== true || currentArm.used === true || currentArm.disarmedAt || currentArm.expiredAt) {
    return buildArmResponse({
      accepted: false,
      armed: false,
      blockedReason: currentArm?.expiredAt ? 'one_shot_arm_expired' : 'one_shot_not_armed',
      currentArm: currentArm || null,
      reason: 'consume_blocked',
      safety: SAFETY,
    });
  }
  if (requestedArmId && requestedArmId !== currentArm.armId) {
    return buildArmResponse({
      accepted: false,
      armed: true,
      blockedReason: 'one_shot_arm_id_mismatch',
      currentArm,
      reason: 'consume_blocked',
      safety: SAFETY,
    });
  }
  if (requestedBlueprintId && requestedBlueprintId !== safeString(currentArm.blueprintId)) {
    return buildArmResponse({
      accepted: false,
      armed: true,
      blockedReason: 'one_shot_arm_blueprint_mismatch',
      currentArm,
      reason: 'consume_blocked',
      safety: SAFETY,
    });
  }
  if (requestedIdempotencyKey && requestedIdempotencyKey !== safeString(currentArm.idempotencyKey)) {
    return buildArmResponse({
      accepted: false,
      armed: true,
      blockedReason: 'one_shot_arm_idempotency_mismatch',
      currentArm,
      reason: 'consume_blocked',
      safety: SAFETY,
    });
  }

  const consumedArm = {
    ...currentArm,
    armed: false,
    used: true,
    usedAt: nowIso(now),
    disarmedAt: nowIso(now),
    blockedReason: 'one_shot_arm_consumed',
  };
  const next = {
    ...state,
    currentArm: consumedArm,
    armsById: {
      ...(state.armsById || {}),
      [consumedArm.armId]: consumedArm,
    },
    usedBlueprintIds: {
      ...(state.usedBlueprintIds || {}),
      [consumedArm.blueprintId]: {
        armId: consumedArm.armId,
        usedAt: consumedArm.usedAt,
        idempotencyKey: consumedArm.idempotencyKey || null,
      },
    },
    lastConsume: {
      armId: consumedArm.armId,
      blueprintId: consumedArm.blueprintId || null,
      timestamp: consumedArm.usedAt,
      reason: safeString(options.reason || options.body?.reason || 'consume_once') || 'consume_once',
    },
    history: [
      ...(Array.isArray(state.history) ? state.history : []),
      {
        type: 'one_shot_arm_consumed',
        armId: consumedArm.armId,
        blueprintId: consumedArm.blueprintId || null,
        timestamp: consumedArm.usedAt,
      },
    ].slice(-100),
    lastSyncAt: nowIso(now),
  };
  saveState(next);
  appendArmEvent({
    type: 'one_shot_arm_consumed',
    armId: consumedArm.armId,
    blueprintId: consumedArm.blueprintId || null,
    candidateId: consumedArm.candidateId || null,
    idempotencyKey: consumedArm.idempotencyKey || null,
    usedAt: consumedArm.usedAt,
  });
  return buildArmResponse({
    accepted: true,
    armed: false,
    armRecord: consumedArm,
    consumed: true,
    currentArm: consumedArm,
    nextRequiredAction: 'Arm har konsumerats och kan inte användas igen.',
    safety: SAFETY,
  });
}

module.exports = {
  SAFETY,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  REQUIRED_CONFIRMATION_PHRASE,
  REQUIRED_SECOND_CONFIRMATION_PHRASE,
  REQUIRED_ARM_CONFIRMATION_PHRASE,
  requireDashboardAuth,
  loadState,
  saveState,
  expireArmIfNeeded,
  getArmStatus,
  armOneShot,
  disarmOneShot,
  consumeArm,
  _internal: {
    nowIso,
    ensureDataDir,
    readJson,
    writeJson,
    appendJsonl,
    safeString,
    safeNumber,
    safeLower,
    stableHash,
    safeCompare,
    maskPaperAccountId,
    normalizeState,
    buildTopStrategyIds,
    resolveBlueprint,
    buildAccountStatus,
    buildArmSnapshot,
    buildStatusResponse,
    buildEligibilityChecks,
  },
};
