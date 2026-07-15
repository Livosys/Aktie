'use strict';

const crypto = require('crypto');
const { IBApi, EventName, SecType, TimeInForce, OrderType } = require('@stoqey/ib');
const interactiveBrokersPaperBlueprintNormalizerService = require('./interactiveBrokersPaperBlueprintNormalizerService');

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

function readConfig() {
  const host = safeString(process.env.IB_GATEWAY_HOST || '127.0.0.1') || '127.0.0.1';
  const portRaw = safeString(process.env.IB_GATEWAY_PORT);
  const clientIdRaw = safeString(process.env.IB_GATEWAY_CLIENT_ID);
  const timeoutRaw = safeString(process.env.IB_PAPER_ONE_SHOT_TIMEOUT_MS);
  return {
    host,
    port: portRaw && Number.isFinite(Number(portRaw)) ? Number(portRaw) : 4002,
    clientId: clientIdRaw && Number.isFinite(Number(clientIdRaw)) ? Number(clientIdRaw) : DEFAULT_CLIENT_ID,
    timeoutMs: timeoutRaw && Number.isFinite(Number(timeoutRaw)) ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS,
  };
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const MAX_ORDER_COUNT = 3;
const DEFAULT_CLIENT_ID = 1;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TIF = 'DAY';
const REAL_SUBMIT_BLOCKER = 'real_submit_not_enabled_for_this_attempt';
const REAL_SUBMIT_AUDIT_ONLY_BLOCKER = 'real_submit_audit_only';
const LEGACY_SUBMIT_FLAG = 'IB_PAPER_LEGACY_SUBMIT_ENABLED';
const NEXT_VALID_ID_UNAVAILABLE = 'ib_next_valid_id_unavailable';
const ENTRY_ONLY_FORBIDDEN = 'entry_only_forbidden';

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

function legacySubmitEnabled() {
  return ['true', '1', 'yes', 'on'].includes(safeLower(process.env[LEGACY_SUBMIT_FLAG]));
}

function resolveBlueprint(tradeBlueprint, selectedBlueprintId = null) {
  const blueprints = Array.isArray(tradeBlueprint?.blueprints) ? tradeBlueprint.blueprints : [];
  if (selectedBlueprintId) {
    return blueprints.find((row) => safeString(row?.blueprintId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.candidateId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.symbol) && safeString(row?.strategyId) && `${safeString(row.symbol)}:${safeString(row.strategyId)}` === safeString(selectedBlueprintId))
      || null;
  }
  return tradeBlueprint?.selectedBlueprint || blueprints.find((row) => row?.manualApprovalReady === true) || blueprints.find((row) => row?.blueprintReady === true) || blueprints[0] || null;
}

function buildOrderContract(symbol, selectedBlueprint = {}) {
  return {
    symbol,
    secType: selectedBlueprint.secType || SecType.STK,
    exchange: selectedBlueprint.exchange || 'SMART',
    currency: selectedBlueprint.currency || 'USD',
    primaryExchange: selectedBlueprint.primaryExchange || undefined,
  };
}

function buildOrderRef(seed, suffix) {
  return `IBPP:${stableHash(`${seed}:${suffix}`).slice(0, 12)}`;
}

function createIbClient(config) {
  return new IBApi({
    host: config.host,
    port: config.port,
    maxReqPerSec: 10,
  });
}

async function connectAndGetNextOrderId(config, options = {}) {
  const client = options.client || createIbClient(config);
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
      clearTimeout(timer);
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

function normalizeBracketSide(side) {
  const raw = safeUpper(side);
  if (raw === 'BUY' || raw === 'SELL') return raw;
  return null;
}

function getExitSide(side) {
  if (side === 'BUY') return 'SELL';
  if (side === 'SELL') return 'BUY';
  return null;
}

function normalizeBracketSubmissionPresentationStatus(options = {}) {
  const helperReady = options.helperReady === true;
  const bracketSubmissionPlanReady = options.bracketSubmissionPlanReady === true;
  const bracketOrderCount = Number(options.bracketOrderCount || options.orderCount || 0);
  const entryOnlyBlocked = options.entryOnlyBlocked === true;
  const bracketSubmissionRealSubmitEnabled = options.bracketSubmissionRealSubmitEnabled === true;
  const protectiveExecutionReady = options.protectiveExecutionReady === true;
  const runtimeBracketSubmitUnlocked = options.runtimeBracketSubmitUnlocked === true;
  const realSubmitForThisAttempt = options.realSubmitForThisAttempt === true;
  const common = {
    helperReady,
    bracketSubmissionPlanReady,
    bracketOrderCount,
    entryOnlyBlocked,
    bracketSubmissionRealSubmitEnabled,
    protectiveExecutionReady,
    runtimeBracketSubmitUnlocked,
    realSubmitForThisAttempt,
    orderSent: false,
    executed: false,
    orderButtonLocked: true,
  };

  if (helperReady === true && bracketSubmissionPlanReady === true && bracketOrderCount === MAX_ORDER_COUNT && entryOnlyBlocked === true && bracketSubmissionRealSubmitEnabled !== true) {
    return {
      ...common,
      blockedReason: REAL_SUBMIT_AUDIT_ONLY_BLOCKER,
      userMessageSv: '3-leg bracket-helper är redo: Entry + Stop Loss + Take Profit. Riktig IB Paper-submit är fortfarande låst i auditläge.',
    };
  }

  if (helperReady !== true || bracketSubmissionPlanReady !== true || bracketOrderCount !== MAX_ORDER_COUNT || entryOnlyBlocked !== true) {
    return {
      ...common,
      blockedReason: 'protective_bracket_submission_required',
      userMessageSv: 'Kan inte skicka order: komplett bracket-/skyddsorder saknas.',
    };
  }

  return {
    ...common,
    blockedReason: REAL_SUBMIT_BLOCKER,
    userMessageSv: '3-leg bracket-plan är redo, men riktig IB Paper-submit är fortfarande låst tills arm, final command och phase gate är verifierade.',
  };
}

function buildLegPlan({
  entryOrderId,
  selectedBlueprint,
  quantity,
  entryReferencePrice,
  stopLoss,
  takeProfit,
  timeInForce,
}) {
  const side = normalizeBracketSide(selectedBlueprint?.side);
  const exitSide = getExitSide(side);
  const symbol = safeUpper(selectedBlueprint?.symbol);
  const orderSeed = `${selectedBlueprint?.blueprintId || symbol || 'missing'}:${entryOrderId || 'noid'}`;
  const entryOrder = {
    role: 'entry',
    orderId: entryOrderId,
    parentId: null,
    action: side,
    orderType: safeUpper(selectedBlueprint?.orderType || 'LMT') || 'LMT',
    quantity,
    lmtPrice: entryReferencePrice,
    auxPrice: null,
    tif: timeInForce,
    transmit: false,
    outsideRth: false,
    orderRef: buildOrderRef(orderSeed, 'entry'),
    contract: buildOrderContract(symbol, selectedBlueprint),
  };
	  const stopLossOrder = {
	    role: 'stop_loss',
	    orderId: entryOrderId + 2,
    parentId: entryOrderId,
    action: exitSide,
    orderType: 'STP',
    quantity,
    lmtPrice: null,
    auxPrice: stopLoss,
    tif: timeInForce,
	    transmit: true,
    outsideRth: false,
    orderRef: buildOrderRef(orderSeed, 'stopLoss'),
    contract: buildOrderContract(symbol, selectedBlueprint),
  };
	  const takeProfitOrder = {
	    role: 'take_profit',
	    orderId: entryOrderId + 1,
    parentId: entryOrderId,
    action: exitSide,
    orderType: 'LMT',
    quantity,
    lmtPrice: takeProfit,
    auxPrice: null,
    tif: timeInForce,
	    transmit: false,
    outsideRth: false,
    orderRef: buildOrderRef(orderSeed, 'takeProfit'),
    contract: buildOrderContract(symbol, selectedBlueprint),
  };

  return {
    groupId: `ibpp_${stableHash(orderSeed).slice(0, 16)}`,
    entry: entryOrder,
    stopLoss: stopLossOrder,
    takeProfit: takeProfitOrder,
	    orderIds: [entryOrder.orderId, takeProfitOrder.orderId, stopLossOrder.orderId],
    orderCount: 3,
    parentChildPlanExists: true,
	    transmitSequence: ['entry:false', 'takeProfit:false', 'stopLoss:true'],
    entryOnlyBlocked: true,
    mockOnly: true,
    dryRun: true,
    willSubmit: false,
    orderSent: false,
    executed: false,
    realSubmitEnabled: false,
  };
}

function buildChecks({
  selectedBlueprint,
  protectivePlan,
  orderModelVerified,
  nextValidId,
  submissionPlan,
  executionStatus,
}) {
  const symbol = safeUpper(selectedBlueprint?.symbol);
  const side = normalizeBracketSide(selectedBlueprint?.side);
  const direction = safeLower(selectedBlueprint?.direction);
  const entryReferencePrice = safeNumber(selectedBlueprint?.entryReferencePrice ?? selectedBlueprint?.entryPrice);
  const stopLoss = safeNumber(selectedBlueprint?.stopLoss ?? selectedBlueprint?.stopLossPrice);
  const takeProfit = safeNumber(selectedBlueprint?.takeProfit ?? selectedBlueprint?.takeProfit1);
  const quantity = Number(selectedBlueprint?.quantity || 0);
  const supportedMarket = safeString(selectedBlueprint?.marketGroup) === 'stock';
  const isCrypto = /USDT$/i.test(symbol) || safeString(selectedBlueprint?.marketGroup) === 'crypto';
  const isEtf = ['etf', 'leveraged_etf'].includes(safeString(selectedBlueprint?.marketGroup)) || symbol === 'QQQ';
  const isCfd = safeString(selectedBlueprint?.marketGroup) === 'cfd';
  const exitSide = getExitSide(side);
  const orderCount = Number(submissionPlan?.orderCount || 0);
  const parentId = submissionPlan?.entry?.orderId || null;
  const nextValidIdNumber = Number(nextValidId);
  const nextValidIdOk = Number.isFinite(nextValidIdNumber) && nextValidIdNumber > 0;
  const quantitiesMatch = Boolean(submissionPlan?.entry)
    && submissionPlan.entry.quantity === quantity
    && submissionPlan.stopLoss?.quantity === quantity
    && submissionPlan.takeProfit?.quantity === quantity;

  const checks = [
    buildCheck('paper_only_mode', SAFETY.mode === 'paper_only', 'hard', 'Läget är paper_only.', 'safety.mode', SAFETY.mode === 'paper_only' ? null : 'paper_only_mode'),
    buildCheck('actions_allowed_false', SAFETY.actions_allowed === false, 'hard', 'actions_allowed är false.', 'safety.actions_allowed', SAFETY.actions_allowed === false ? null : 'actions_allowed_true'),
    buildCheck('can_place_orders_false', SAFETY.can_place_orders === false, 'hard', 'can_place_orders är false.', 'safety.can_place_orders', SAFETY.can_place_orders === false ? null : 'can_place_orders_true'),
    buildCheck('live_trading_disabled', SAFETY.live_trading_enabled === false, 'hard', 'live_trading_enabled är false.', 'safety.live_trading_enabled', SAFETY.live_trading_enabled === false ? null : 'live_trading_enabled_true'),
    buildCheck('broker_disabled', SAFETY.broker_enabled === false, 'hard', 'broker_enabled är false.', 'safety.broker_enabled', SAFETY.broker_enabled === false ? null : 'broker_enabled_true'),
    buildCheck('selected_blueprint_exists', Boolean(selectedBlueprint), 'hard', selectedBlueprint ? 'Selected blueprint finns.' : 'Selected blueprint saknas.', 'tradeBlueprint.selectedBlueprint', selectedBlueprint ? null : 'missing_blueprint'),
    buildCheck('protective_plan_ready', protectivePlan?.protectivePlanReady === true, 'hard', protectivePlan?.protectivePlanReady === true ? 'Protective plan är redo.' : 'Protective plan är inte redo.', 'interactiveBrokersPaperProtectiveOrderService', protectivePlan?.protectivePlanReady === true ? null : (protectivePlan?.blockedReason || 'protective_plan_not_ready')),
    buildCheck('order_model_verified', orderModelVerified === true, 'hard', orderModelVerified ? 'IB ordermodellen är verifierad.' : 'IB ordermodellen är inte verifierad.', '@stoqey/ib', orderModelVerified === true ? null : 'ib_order_model_unverified'),
    buildCheck('next_valid_id_available', nextValidIdOk, 'hard', nextValidIdOk ? `nextValidId=${nextValidIdNumber}` : 'nextValidId saknas.', 'readOnlyGateway.nextValidId', nextValidIdOk ? null : NEXT_VALID_ID_UNAVAILABLE),
    buildCheck('entry_exists', entryReferencePrice > 0, 'hard', entryReferencePrice > 0 ? 'Entry finns.' : 'Entry saknas.', 'selectedBlueprint.entryReferencePrice', entryReferencePrice > 0 ? null : 'selected_blueprint_entry_missing'),
    buildCheck('stop_loss_exists', stopLoss > 0, 'hard', stopLoss > 0 ? 'Stop loss finns.' : 'Stop loss saknas.', 'selectedBlueprint.stopLoss', stopLoss > 0 ? null : 'selected_blueprint_stop_loss_missing'),
    buildCheck('take_profit_exists', takeProfit > 0, 'hard', takeProfit > 0 ? 'Take profit finns.' : 'Take profit saknas.', 'selectedBlueprint.takeProfit', takeProfit > 0 ? null : 'selected_blueprint_take_profit_missing'),
    buildCheck('side_valid', ['BUY', 'SELL'].includes(side), 'hard', ['BUY', 'SELL'].includes(side) ? 'Side är giltig.' : 'Side är ogiltig.', 'selectedBlueprint.side', ['BUY', 'SELL'].includes(side) ? null : 'selected_blueprint_side_missing'),
    buildCheck('direction_valid', ['long', 'short'].includes(direction), 'hard', ['long', 'short'].includes(direction) ? 'Riktningen är tydlig.' : 'Riktningen är oklar.', 'selectedBlueprint.direction', ['long', 'short'].includes(direction) ? null : 'unknown_direction'),
    buildCheck('supported_us_equity', Boolean(selectedBlueprint) && supportedMarket && !isCrypto && !isEtf && !isCfd && safeString(selectedBlueprint?.accountMode) === 'ib_paper', 'hard', (!isCrypto && !isEtf && !isCfd && supportedMarket && safeString(selectedBlueprint?.accountMode) === 'ib_paper') ? 'Symbolen är en tillåten US equity.' : 'Symbolen är inte tillåten i Fas 4G-2P.', 'selectedBlueprint.marketGroup', (!isCrypto && !isEtf && !isCfd && supportedMarket && safeString(selectedBlueprint?.accountMode) === 'ib_paper') ? null : 'selected_blueprint_unsupported_market_group'),
    buildCheck('crypto_blocked', !isCrypto, 'hard', !isCrypto ? 'Crypto är blockerat.' : 'Crypto är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isCrypto ? 'crypto_not_allowed_for_ib_paper_first_order' : null),
    buildCheck('etf_blocked_phase_1', !isEtf, 'hard', !isEtf ? 'ETF är inte vald.' : 'ETF är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isEtf ? 'etf_not_allowed_for_ib_paper_first_order' : null),
    buildCheck('cfd_blocked_phase_1', !isCfd, 'hard', !isCfd ? 'CFD är inte vald.' : 'CFD är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isCfd ? 'selected_blueprint_unsupported_market_group' : null),
    buildCheck('entry_action_matches_side', Boolean(submissionPlan?.entry) && submissionPlan.entry.action === side, 'hard', submissionPlan?.entry ? 'Entry action matchar.' : 'Entry saknas.', 'submissionPlan.entry', Boolean(submissionPlan?.entry) && submissionPlan.entry.action === side ? null : 'entry_only_forbidden'),
    buildCheck('stop_action_matches_exit', Boolean(submissionPlan?.stopLoss) && submissionPlan.stopLoss.action === exitSide, 'hard', submissionPlan?.stopLoss ? 'Stop loss action matchar.' : 'Stop loss saknas.', 'submissionPlan.stopLoss', Boolean(submissionPlan?.stopLoss) && submissionPlan.stopLoss.action === exitSide ? null : 'entry_only_forbidden'),
    buildCheck('take_profit_action_matches_exit', Boolean(submissionPlan?.takeProfit) && submissionPlan.takeProfit.action === exitSide, 'hard', submissionPlan?.takeProfit ? 'Take profit action matchar.' : 'Take profit saknas.', 'submissionPlan.takeProfit', Boolean(submissionPlan?.takeProfit) && submissionPlan.takeProfit.action === exitSide ? null : 'entry_only_forbidden'),
    buildCheck('order_count_three', orderCount === MAX_ORDER_COUNT, 'hard', orderCount === MAX_ORDER_COUNT ? 'Tre orderlegs finns.' : `Order count är ${orderCount}.`, 'submissionPlan.orderCount', orderCount === MAX_ORDER_COUNT ? null : 'entry_only_forbidden'),
    buildCheck('entry_transmit_false', submissionPlan?.entry?.transmit === false, 'hard', submissionPlan?.entry?.transmit === false ? 'Entry transmit=false.' : 'Entry transmit måste vara false.', 'submissionPlan.entry.transmit', submissionPlan?.entry?.transmit === false ? null : 'entry_only_forbidden'),
	    buildCheck('take_profit_transmit_false', submissionPlan?.takeProfit?.transmit === false, 'hard', submissionPlan?.takeProfit?.transmit === false ? 'Take profit transmit=false.' : 'Take profit transmit måste vara false.', 'submissionPlan.takeProfit.transmit', submissionPlan?.takeProfit?.transmit === false ? null : 'entry_only_forbidden'),
	    buildCheck('stop_loss_transmit_true', submissionPlan?.stopLoss?.transmit === true, 'hard', submissionPlan?.stopLoss?.transmit === true ? 'Stop loss transmit=true.' : 'Stop loss transmit måste vara true.', 'submissionPlan.stopLoss.transmit', submissionPlan?.stopLoss?.transmit === true ? null : 'entry_only_forbidden'),
    buildCheck('stop_parent_matches_entry', submissionPlan?.stopLoss?.parentId === parentId && parentId != null, 'hard', submissionPlan?.stopLoss ? 'Stop loss parentId matchar.' : 'Stop loss parentId saknas.', 'submissionPlan.stopLoss.parentId', submissionPlan?.stopLoss?.parentId === parentId && parentId != null ? null : 'entry_only_forbidden'),
    buildCheck('take_profit_parent_matches_entry', submissionPlan?.takeProfit?.parentId === parentId && parentId != null, 'hard', submissionPlan?.takeProfit ? 'Take profit parentId matchar.' : 'Take profit parentId saknas.', 'submissionPlan.takeProfit.parentId', submissionPlan?.takeProfit?.parentId === parentId && parentId != null ? null : 'entry_only_forbidden'),
    buildCheck('quantities_match', quantitiesMatch, 'hard', quantitiesMatch ? 'Quantities matchar alla legs.' : 'Quantities matchar inte alla legs.', 'submissionPlan.quantity', quantitiesMatch ? null : 'quantity_mismatch'),
    buildCheck('stop_loss_side_valid', direction === 'long' ? stopLoss < entryReferencePrice : direction === 'short' ? stopLoss > entryReferencePrice : false, 'hard', direction === 'long' ? 'Stop loss ligger under entry.' : direction === 'short' ? 'Stop loss ligger över entry.' : 'Stop loss-sidan kan inte valideras.', 'selectedBlueprint.stopLoss', direction === 'long' ? (stopLoss < entryReferencePrice ? null : 'invalid_stop_loss_side') : direction === 'short' ? (stopLoss > entryReferencePrice ? null : 'invalid_stop_loss_side') : 'invalid_stop_loss_side'),
    buildCheck('take_profit_side_valid', direction === 'long' ? takeProfit > entryReferencePrice : direction === 'short' ? takeProfit < entryReferencePrice : false, 'hard', direction === 'long' ? 'Take profit ligger över entry.' : direction === 'short' ? 'Take profit ligger under entry.' : 'Take profit-sidan kan inte valideras.', 'selectedBlueprint.takeProfit', direction === 'long' ? (takeProfit > entryReferencePrice ? null : 'invalid_take_profit_side') : direction === 'short' ? (takeProfit < entryReferencePrice ? null : 'invalid_take_profit_side') : 'invalid_take_profit_side'),
    buildCheck('entry_only_blocked', true, 'info', 'Entry-only är förbjudet.', 'policy', null),
    buildCheck('real_submit_disabled_phase_4f', true, 'info', 'Real submit är avstängd i Fas 4F.', 'phase', null),
  ];

  return checks;
}

function buildBracketSubmissionPlan(options = {}) {
  const now = options.now || new Date();
  const truth = options.truth || null;
  const executionStatus = options.executionStatus || truth?.ibPaper?.executionStatus || null;
  const tradeBlueprint = options.tradeBlueprint || truth?.ibPaper?.tradeBlueprint || null;
  const rawSelectedBlueprint = options.selectedBlueprint || resolveBlueprint(tradeBlueprint, options.blueprintId || options.selectedBlueprintId || null);
  const selectedBlueprint = interactiveBrokersPaperBlueprintNormalizerService.normalizeIbPaperSelectedBlueprint(rawSelectedBlueprint, {
    source: rawSelectedBlueprint?.source || options.selectedBlueprintSource || 'trade_blueprint',
  }).selectedBlueprint || rawSelectedBlueprint || null;
  const protectivePlan = options.protectivePlan || options.protectivePreflight || null;
  const readiness = options.readiness || truth?.ibPaper?.connectionReadiness || truth?.readiness || executionStatus?.readiness || null;
  const nextValidId = safeNumber(options.nextValidId ?? readiness?.nextValidId ?? executionStatus?.readiness?.nextValidId);
  const orderModelVerified = protectivePlan?.orderModelVerified === true || protectivePlan?.contractVerified === true || Boolean(SecType && TimeInForce && OrderType);
  const entryReferencePrice = safeNumber(selectedBlueprint?.entryReferencePrice ?? selectedBlueprint?.entryPrice);
  const stopLoss = safeNumber(selectedBlueprint?.stopLoss ?? selectedBlueprint?.stopLossPrice);
  const takeProfit = safeNumber(selectedBlueprint?.takeProfit ?? selectedBlueprint?.takeProfit1);
  const quantity = Number(selectedBlueprint?.quantity || 0);
  const quantityValid = quantity > 0;
  const planSeed = `${selectedBlueprint?.blueprintId || selectedBlueprint?.symbol || 'missing'}:${safeString(now.toISOString())}`;
  const createdAt = nowIso(now);
  const expiresAt = safeString(selectedBlueprint?.expiresAt) || createdAt;
  const protectivePlanReady = protectivePlan?.protectivePlanReady === true;
  const protectivePathAvailable = protectivePlan?.protectivePathAvailable === true;
  const entryOnlyBlocked = true;
  const realSubmitEnabled = false;
  const nextValidIdOk = Number.isFinite(nextValidId) && nextValidId > 0;
  const basePlan = {
    groupId: `ibbp_${stableHash(planSeed).slice(0, 16)}`,
    createdAt,
    expiresAt,
    staleAfterSeconds: Number(selectedBlueprint?.staleAfterSeconds || 600),
    blueprintId: selectedBlueprint?.blueprintId || null,
    candidateId: selectedBlueprint?.candidateId || null,
    symbol: safeUpper(selectedBlueprint?.symbol) || null,
    strategyId: safeString(selectedBlueprint?.strategyId) || null,
    strategyName: safeString(selectedBlueprint?.strategyName || selectedBlueprint?.strategyId || 'Unknown strategy'),
    side: normalizeBracketSide(selectedBlueprint?.side),
    direction: safeLower(selectedBlueprint?.direction) || 'unknown',
    accountMode: safeString(selectedBlueprint?.accountMode || 'ib_paper').toLowerCase() || 'ib_paper',
    quantity: quantityValid ? quantity : null,
    quantityStatus: safeString(selectedBlueprint?.quantityStatus) || (quantityValid ? 'calculated' : 'missing_quantity'),
    entryReferencePrice,
    stopLoss,
    takeProfit,
    takeProfit1: takeProfit,
    takeProfit2: safeNumber(selectedBlueprint?.takeProfit2),
    riskPct: safeNumber(selectedBlueprint?.riskPct),
    riskAmount: safeNumber(selectedBlueprint?.riskAmount),
    estimatedNotional: safeNumber(selectedBlueprint?.estimatedNotional),
    orderType: safeUpper(selectedBlueprint?.orderType || 'LMT') || 'LMT',
    timeInForce: safeUpper(selectedBlueprint?.timeInForce || DEFAULT_TIF) || DEFAULT_TIF,
    orderModelVerified,
    protectivePathAvailable,
    protectivePlanReady,
    protectiveExecutionReady: false,
    bracketSubmissionPlanReady: false,
    bracketSubmissionRealSubmitEnabled: realSubmitEnabled,
    entryOnlyBlocked,
    realSubmitEnabled,
    mockOnly: true,
    dryRun: true,
    willSubmit: false,
    orderSent: false,
    executed: false,
    entryOnlyForbidden: true,
    nextValidId: nextValidIdOk ? nextValidId : null,
    nextValidIdSource: nextValidIdOk ? (options.nextValidId != null ? 'input' : 'readiness') : null,
    submissionPlan: null,
    orderCount: 0,
    safety: { ...SAFETY },
    contract: selectedBlueprint?.symbol ? buildOrderContract(safeUpper(selectedBlueprint.symbol), selectedBlueprint) : null,
    blockers: [],
    warnings: [],
    checks: [],
  };

  let submissionPlan = null;
  if (quantityValid && nextValidIdOk && protectivePlanReady && orderModelVerified) {
    submissionPlan = {
      ...buildLegPlan({
        entryOrderId: nextValidId,
        selectedBlueprint,
        quantity,
        entryReferencePrice,
        stopLoss,
        takeProfit,
        timeInForce: safeUpper(selectedBlueprint?.timeInForce || DEFAULT_TIF) || DEFAULT_TIF,
      }),
      accountMode: 'ib_paper',
      mockOnly: true,
      dryRun: true,
      willSubmit: false,
      orderSent: false,
      executed: false,
      entryOnlyBlocked: true,
      realSubmitEnabled: false,
      protectiveOrdersSubmitted: false,
      protectiveOrdersRequiredForFuture: true,
      executionLimitedFirstOrder: true,
    };
    if (options.forceQuantityMismatch === true && submissionPlan.stopLoss) {
      submissionPlan.stopLoss = {
        ...submissionPlan.stopLoss,
        quantity: quantity + 1,
      };
    }
  }

  const checks = buildChecks({
    selectedBlueprint,
    protectivePlan,
    orderModelVerified,
    nextValidId,
    submissionPlan,
    executionStatus,
  });

  const hardFailedChecks = checks.filter((check) => check.ok !== true && check.severity === 'hard');
  const orderCount = submissionPlan && checks.every((check) => check.ok === true || check.severity === 'info') ? MAX_ORDER_COUNT : (options.forceEntryOnly === true ? 1 : 0);

  const bracketSubmissionPlanReady = hardFailedChecks.length === 0 && orderCount === MAX_ORDER_COUNT;
  const blockers = hardFailedChecks.map((check) => check.blocker || check.code).filter(Boolean);
  const blockedReason = bracketSubmissionPlanReady ? REAL_SUBMIT_BLOCKER : (blockers[0] || NEXT_VALID_ID_UNAVAILABLE);

  const summary = {
    totalChecks: checks.length,
    passedChecks: checks.filter((check) => check.ok === true).length,
    failedHardChecks: hardFailedChecks.length,
    warningChecks: checks.filter((check) => check.ok === true && check.severity === 'warning').length,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled: realSubmitEnabled,
    protectiveExecutionReady: false,
    orderCount,
    entryOnlyBlocked,
    blockedReason,
  };
  const uiStatus = normalizeBracketSubmissionPresentationStatus({
    helperReady: bracketSubmissionPlanReady === true,
    bracketSubmissionPlanReady: bracketSubmissionPlanReady === true,
    bracketOrderCount: orderCount,
    entryOnlyBlocked,
    bracketSubmissionRealSubmitEnabled: realSubmitEnabled,
    protectiveExecutionReady: false,
    runtimeBracketSubmitUnlocked: bracketSubmissionPlanReady === true,
  });

  if (options.forceEntryOnly === true) {
    const entryOnlyPlan = submissionPlan ? {
      ...submissionPlan,
      stopLoss: null,
      takeProfit: null,
      orderCount: 1,
      parentChildPlanExists: false,
      transmitSequence: ['entry:false'],
      entryOnlyBlocked: true,
      mockOnly: true,
      dryRun: true,
      willSubmit: false,
      orderSent: false,
      executed: false,
    } : null;
    return {
      ok: true,
      mode: 'paper_only',
      dryRun: true,
      mockOnly: true,
      protectivePathAvailable,
      protectivePlanReady,
      protectiveExecutionReady: false,
      bracketSubmissionPlanReady: false,
      bracketSubmissionRealSubmitEnabled: realSubmitEnabled,
      entryOnlyBlocked: true,
      orderCount: 1,
      blockedReason: ENTRY_ONLY_FORBIDDEN,
      blockers: [ENTRY_ONLY_FORBIDDEN],
      warnings: [],
      checks,
      userMessageSv: uiStatus.userMessageSv,
      orderButtonLocked: uiStatus.orderButtonLocked,
      uiStatus,
      submissionPlan: entryOnlyPlan,
      summary: {
        ...summary,
        bracketSubmissionPlanReady: false,
        protectiveExecutionReady: false,
        orderCount: 1,
        entryOnlyBlocked: true,
        blockedReason: ENTRY_ONLY_FORBIDDEN,
      },
      selectedBlueprint,
      truth,
      executionStatus,
      tradeBlueprint,
      protectivePlan,
      nextValidId: nextValidIdOk ? nextValidId : null,
      nextValidIdSource: nextValidIdOk ? (options.nextValidId != null ? 'input' : 'readiness') : null,
      contract: entryOnlyPlan?.entry?.contract || basePlan.contract,
      contractVerified: orderModelVerified,
      orderModelVerified,
      safety: { ...SAFETY },
      willSubmit: false,
      orderSent: false,
      executed: false,
      realSubmitEnabled,
      dataFiles: {
        mode: 'mock_only',
      },
      nextRequiredAction: 'Entry-only är förbjudet. En komplett bracket-plan krävs.',
    };
  }

  return {
    ok: true,
    mode: 'paper_only',
    dryRun: true,
    mockOnly: true,
    protectivePathAvailable,
    protectivePlanReady,
    protectiveExecutionReady: false,
    bracketSubmissionPlanReady,
    bracketSubmissionRealSubmitEnabled: realSubmitEnabled,
    entryOnlyBlocked,
    orderCount,
    blockedReason,
    blockers,
    warnings: [],
    checks,
    submissionPlan,
    summary,
    selectedBlueprint,
    truth,
    executionStatus,
    tradeBlueprint,
    protectivePlan,
    nextValidId: nextValidIdOk ? nextValidId : null,
    nextValidIdSource: nextValidIdOk ? (options.nextValidId != null ? 'input' : 'readiness') : null,
    contract: submissionPlan?.entry?.contract || basePlan.contract,
    contractVerified: orderModelVerified,
    orderModelVerified,
    safety: { ...SAFETY },
    willSubmit: false,
    orderSent: false,
    executed: false,
    realSubmitEnabled,
    dataFiles: {
      mode: 'mock_only',
    },
    nextRequiredAction: bracketSubmissionPlanReady
      ? 'Fas 4G kan i framtiden använda denna bracket-plan för verklig submit. Fas 4F håller real submit avstängd.'
      : `Åtgärda blockerarna och försök igen. Första blocker: ${blockedReason}.`,
    userMessageSv: uiStatus.userMessageSv,
    orderButtonLocked: uiStatus.orderButtonLocked,
    uiStatus,
  };
}

function buildBracketSubmissionPreflight(options = {}) {
  const plan = buildBracketSubmissionPlan(options);
  return {
    ok: true,
    mode: 'paper_only',
    preflightOnly: true,
    dryRun: true,
    mockOnly: true,
    accepted: plan.bracketSubmissionPlanReady === true,
    protectivePathAvailable: plan.protectivePathAvailable === true,
    protectivePlanReady: plan.protectivePlanReady === true,
    protectiveExecutionReady: plan.protectiveExecutionReady === true,
    bracketSubmissionPlanReady: plan.bracketSubmissionPlanReady === true,
    bracketSubmissionRealSubmitEnabled: plan.bracketSubmissionRealSubmitEnabled === true,
    entryOnlyBlocked: plan.entryOnlyBlocked === true,
    orderCount: plan.orderCount,
    blockedReason: plan.blockedReason || null,
    userMessageSv: plan.userMessageSv || null,
    orderButtonLocked: plan.orderButtonLocked === true,
    blockers: Array.isArray(plan.blockers) ? plan.blockers : [],
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    checks: Array.isArray(plan.checks) ? plan.checks : [],
    summary: plan.summary,
    submissionPlan: plan.submissionPlan,
    selectedBlueprint: plan.selectedBlueprint,
    truth: plan.truth,
    executionStatus: plan.executionStatus,
    tradeBlueprint: plan.tradeBlueprint,
    protectivePlan: plan.protectivePlan,
    safety: { ...SAFETY },
    orderModelVerified: plan.orderModelVerified === true,
    contractVerified: plan.contractVerified === true,
    nextRequiredAction: plan.nextRequiredAction,
    uiStatus: plan.uiStatus || null,
    note: 'Ingen order skickas i denna fas. Bracket-planen är endast en mock/plan för framtida Fas 4G.',
  };
}

function validateBracketSubmissionPlan(submissionPlan, options = {}) {
  const orderCount = Number(submissionPlan?.orderCount || 0);
  const entry = submissionPlan?.entry || null;
  const stopLoss = submissionPlan?.stopLoss || null;
  const takeProfit = submissionPlan?.takeProfit || null;
  const orderIds = Array.isArray(submissionPlan?.orderIds) ? submissionPlan.orderIds : [];
  const accountMode = safeLower(options.accountMode || submissionPlan?.accountMode || 'ib_paper');
  const executionAttemptId = safeString(options.executionAttemptId || submissionPlan?.executionAttemptId || '');
  const idempotencyKey = safeString(options.idempotencyKey || submissionPlan?.idempotencyKey || '');
  const contract = options.contract || submissionPlan?.contract || entry?.contract || null;
  const side = normalizeBracketSide(submissionPlan?.side || entry?.action);
  const exitSide = getExitSide(side);
  const direction = safeLower(submissionPlan?.direction || options.direction || '');
  const entryQuantity = Number(entry?.quantity || 0);
  const quantitiesMatch = Boolean(
    entry
    && stopLoss
    && takeProfit
    && entryQuantity > 0
    && stopLoss.quantity === entryQuantity
    && takeProfit.quantity === entryQuantity,
  );
  const contractSymbol = safeUpper(contract?.symbol || '');
  const expectedSymbol = safeUpper(submissionPlan?.symbol || entry?.contract?.symbol || '');
  const contractValid = Boolean(
    contract
    && contractSymbol
    && contractSymbol === expectedSymbol
    && safeUpper(contract?.secType || 'STK') === 'STK'
    && safeUpper(contract?.exchange || 'SMART') === 'SMART',
  );
  const executionAttemptIdValid = Boolean(executionAttemptId);
  const idempotencyKeyValid = Boolean(idempotencyKey);
  const rolesValid = Boolean(
    entry?.role === 'entry'
    && stopLoss?.role === 'stop_loss'
    && takeProfit?.role === 'take_profit',
  );
	  const transmitSequenceValid = Boolean(
	    entry?.transmit === false
	    && takeProfit?.transmit === false
	    && stopLoss?.transmit === true,
	  );
  const parentLinkValid = Boolean(
    stopLoss?.parentId === entry?.orderId
    && takeProfit?.parentId === entry?.orderId
    && entry?.orderId != null,
  );
  const actionSideValid = Boolean(
    entry?.action === side
    && stopLoss?.action === exitSide
    && takeProfit?.action === exitSide,
  );
  const stopLossSideValid = direction === 'long'
    ? safeNumber(stopLoss?.auxPrice) < safeNumber(entry?.lmtPrice)
    : direction === 'short'
      ? safeNumber(stopLoss?.auxPrice) > safeNumber(entry?.lmtPrice)
      : false;
  const takeProfitSideValid = direction === 'long'
    ? safeNumber(takeProfit?.lmtPrice) > safeNumber(entry?.lmtPrice)
    : direction === 'short'
      ? safeNumber(takeProfit?.lmtPrice) < safeNumber(entry?.lmtPrice)
      : false;
  const orderIdsValid = orderCount === MAX_ORDER_COUNT
    && orderIds.length === MAX_ORDER_COUNT
    && orderIds.every((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  const accountModeValid = accountMode === 'ib_paper';

  const checks = [
    buildCheck('submission_plan_present', Boolean(submissionPlan), 'hard', submissionPlan ? 'Submission plan finns.' : 'Submission plan saknas.', 'submissionPlan', submissionPlan ? null : 'protective_bracket_submission_required'),
    buildCheck('account_mode_ib_paper', accountModeValid, 'hard', accountModeValid ? 'Konto är ib_paper.' : 'Konto är inte ib_paper.', 'submissionPlan.accountMode', accountModeValid ? null : 'unsupported_account_mode'),
    buildCheck('order_count_three', orderCount === MAX_ORDER_COUNT, 'hard', orderCount === MAX_ORDER_COUNT ? 'Tre orderlegs finns.' : `Order count är ${orderCount}.`, 'submissionPlan.orderCount', orderCount === MAX_ORDER_COUNT ? null : 'entry_only_forbidden'),
    buildCheck('entry_exists', Boolean(entry), 'hard', entry ? 'Entry finns.' : 'Entry saknas.', 'submissionPlan.entry', entry ? null : 'missing_entry'),
    buildCheck('stop_loss_exists', Boolean(stopLoss), 'hard', stopLoss ? 'Stop loss finns.' : 'Stop loss saknas.', 'submissionPlan.stopLoss', stopLoss ? null : 'missing_stop_loss'),
    buildCheck('take_profit_exists', Boolean(takeProfit), 'hard', takeProfit ? 'Take profit finns.' : 'Take profit saknas.', 'submissionPlan.takeProfit', takeProfit ? null : 'missing_take_profit'),
    buildCheck('contract_valid', contractValid, 'hard', contractValid ? 'Contract är giltigt.' : 'Contract saknas eller matchar inte symbolen.', 'submissionPlan.contract', contractValid ? null : 'invalid_contract'),
    buildCheck('execution_attempt_id_present', executionAttemptIdValid, 'hard', executionAttemptIdValid ? 'executionAttemptId finns.' : 'executionAttemptId saknas.', 'submissionAttempt.executionAttemptId', executionAttemptIdValid ? null : 'execution_attempt_id_required'),
    buildCheck('idempotency_key_present', idempotencyKeyValid, 'hard', idempotencyKeyValid ? 'idempotencyKey finns.' : 'idempotencyKey saknas.', 'submissionAttempt.idempotencyKey', idempotencyKeyValid ? null : 'idempotency_key_required'),
    buildCheck('roles_valid', rolesValid, 'hard', rolesValid ? 'Orderrollerna stämmer.' : 'Orderrollerna stämmer inte.', 'submissionPlan.roles', rolesValid ? null : 'entry_only_forbidden'),
    buildCheck('entry_transmit_false', entry?.transmit === false, 'hard', entry?.transmit === false ? 'Entry transmit=false.' : 'Entry transmit måste vara false.', 'submissionPlan.entry.transmit', entry?.transmit === false ? null : 'invalid_transmit_sequence'),
	    buildCheck('take_profit_transmit_false', takeProfit?.transmit === false, 'hard', takeProfit?.transmit === false ? 'Take profit transmit=false.' : 'Take profit transmit måste vara false.', 'submissionPlan.takeProfit.transmit', takeProfit?.transmit === false ? null : 'invalid_transmit_sequence'),
	    buildCheck('stop_loss_transmit_true', stopLoss?.transmit === true, 'hard', stopLoss?.transmit === true ? 'Stop loss transmit=true.' : 'Stop loss transmit måste vara true.', 'submissionPlan.stopLoss.transmit', stopLoss?.transmit === true ? null : 'invalid_transmit_sequence'),
    buildCheck('stop_parent_matches_entry', parentLinkValid, 'hard', parentLinkValid ? 'ParentId-länkarna stämmer.' : 'ParentId-länkarna stämmer inte.', 'submissionPlan.parentId', parentLinkValid ? null : 'invalid_parent_link'),
    buildCheck('quantities_match', quantitiesMatch, 'hard', quantitiesMatch ? 'Quantities matchar.' : 'Quantities matchar inte.', 'submissionPlan.quantity', quantitiesMatch ? null : 'quantity_mismatch'),
    buildCheck('actions_match_side', actionSideValid, 'hard', actionSideValid ? 'Actions matchar side.' : 'Actions matchar inte side.', 'submissionPlan.action', actionSideValid ? null : 'entry_only_forbidden'),
    buildCheck('stop_loss_side_valid', stopLossSideValid, 'hard', stopLossSideValid ? 'Stop loss ligger på rätt sida.' : 'Stop loss ligger på fel sida.', 'submissionPlan.stopLoss.auxPrice', stopLossSideValid ? null : 'invalid_stop_loss_side'),
    buildCheck('take_profit_side_valid', takeProfitSideValid, 'hard', takeProfitSideValid ? 'Take profit ligger på rätt sida.' : 'Take profit ligger på fel sida.', 'submissionPlan.takeProfit.lmtPrice', takeProfitSideValid ? null : 'invalid_take_profit_side'),
    buildCheck('order_ids_valid', orderIdsValid, 'hard', orderIdsValid ? 'OrderId-serien är giltig.' : 'OrderId-serien är ogiltig.', 'submissionPlan.orderIds', orderIdsValid ? null : NEXT_VALID_ID_UNAVAILABLE),
    buildCheck('entry_only_blocked', submissionPlan?.entryOnlyBlocked === true, 'hard', submissionPlan?.entryOnlyBlocked === true ? 'Entry-only är blockerat.' : 'Entry-only är inte blockerat.', 'submissionPlan.entryOnlyBlocked', submissionPlan?.entryOnlyBlocked === true ? null : 'entry_only_forbidden'),
    buildCheck('no_live_flags_true', SAFETY.actions_allowed === false && SAFETY.can_place_orders === false && SAFETY.live_trading_enabled === false && SAFETY.broker_enabled === false, 'hard', 'Globala safety-flaggor är false.', 'safety', null),
  ];

  const hardFailedChecks = checks.filter((check) => check.ok !== true && check.severity === 'hard');
  const blockers = hardFailedChecks.map((check) => check.blocker || check.code).filter(Boolean);
  const helperReady = hardFailedChecks.length === 0 && orderCount === MAX_ORDER_COUNT && submissionPlan?.entryOnlyBlocked === true;
  const uiStatus = normalizeBracketSubmissionPresentationStatus({
    helperReady,
    bracketSubmissionPlanReady: helperReady,
    bracketOrderCount: orderCount,
    entryOnlyBlocked: submissionPlan?.entryOnlyBlocked === true,
    bracketSubmissionRealSubmitEnabled: false,
    protectiveExecutionReady: false,
    runtimeBracketSubmitUnlocked: helperReady === true,
  });
  return {
    ok: helperReady,
    helperReady,
    blockedReason: helperReady ? REAL_SUBMIT_AUDIT_ONLY_BLOCKER : 'protective_bracket_submission_required',
    userMessageSv: uiStatus.userMessageSv,
    orderButtonLocked: uiStatus.orderButtonLocked,
    blockers,
    checks,
    entryOnlyBlocked: submissionPlan?.entryOnlyBlocked === true,
    orderCount,
    accountMode,
    orderIds,
    rolesValid,
    transmitSequenceValid,
    parentLinkValid,
    quantitiesMatch,
    actionSideValid,
    stopLossSideValid,
    takeProfitSideValid,
    uiStatus,
  };
}

function createMockPlaceOrderResult({
  submissionPlan,
  executedOrder,
  index,
  simulatedCall,
}) {
  return {
    index,
    orderId: executedOrder?.orderId ?? null,
    role: executedOrder?.role || null,
    action: executedOrder?.action || null,
    transmit: executedOrder?.transmit === true,
    parentId: executedOrder?.parentId ?? null,
    quantity: executedOrder?.quantity ?? null,
    orderType: executedOrder?.orderType || null,
    orderRef: executedOrder?.orderRef || null,
    simulatedCall: simulatedCall === true,
    groupId: submissionPlan?.groupId || null,
  };
}

async function submitBracketOrderGroup(options = {}) {
  const submissionPlan = options.submissionPlan
    || buildBracketSubmissionPlan({
      now: options.now,
      truth: options.truth,
      executionStatus: options.executionStatus,
      tradeBlueprint: options.tradeBlueprint,
      readiness: options.readiness,
      blueprintId: options.blueprintId || options.selectedBlueprintId || null,
      selectedBlueprint: options.selectedBlueprint,
      selectedBlueprintId: options.selectedBlueprintId,
      protectivePlan: options.protectivePlan || options.protectivePreflight || null,
      nextValidId: options.nextValidId,
    });
  const allowRealSubmit = options.allowRealSubmit === true;
  const mockOnly = options.mockOnly === undefined ? !allowRealSubmit : options.mockOnly === true;
  const dryRun = options.dryRun === undefined ? !allowRealSubmit : options.dryRun === true;
  const simulateMockCalls = options.simulateMockCalls === true;
  const realSubmitRequested = allowRealSubmit === true && mockOnly !== true && dryRun !== true;
  const accountMode = safeLower(options.accountMode || submissionPlan?.accountMode || 'ib_paper');
  const executionAttemptId = safeString(options.executionAttemptId || '');
  const idempotencyKey = safeString(options.idempotencyKey || '');
  const contract = options.contract
    || submissionPlan?.contract
    || submissionPlan?.entry?.contract
    || buildOrderContract(safeUpper(submissionPlan?.symbol || options.selectedBlueprint?.symbol || 'UNKNOWN'));
  const validation = validateBracketSubmissionPlan(submissionPlan, {
    accountMode,
    direction: options.direction || options.selectedBlueprint?.direction || submissionPlan?.direction || null,
    executionAttemptId,
    idempotencyKey,
    contract,
  });
  const entryOnlyBlocked = submissionPlan?.entryOnlyBlocked === true;
  const orderCount = Number(submissionPlan?.orderCount || 0);
  const blockedReasonWhenReady = allowRealSubmit ? null : REAL_SUBMIT_AUDIT_ONLY_BLOCKER;
  const uiStatus = normalizeBracketSubmissionPresentationStatus({
    helperReady: validation.helperReady === true,
    bracketSubmissionPlanReady: validation.helperReady === true,
    bracketOrderCount: orderCount,
    entryOnlyBlocked: true,
    bracketSubmissionRealSubmitEnabled: false,
    protectiveExecutionReady: false,
    runtimeBracketSubmitUnlocked: allowRealSubmit === true,
    realSubmitForThisAttempt: allowRealSubmit === true,
  });

  const buildBlockedResponse = ({
    ok = false,
    blockedReason,
    blockers,
    helperReady = false,
    mockPlaceOrderCalls = [],
    incident = null,
    mockProtectiveOrdersSubmitted = false,
    mockOrderSent = false,
    realSubmitEnabled = false,
  }) => ({
    ok,
    accepted: false,
    helperReady,
    protectiveExecutionReady: false,
    bracketSubmissionPlanReady: validation.helperReady === true,
    bracketSubmissionRealSubmitEnabled: realSubmitEnabled === true,
    realSubmitEnabled: realSubmitEnabled === true,
    realSubmitActuallyExecuted: false,
    mockOnly,
    dryRun,
    orderCount: orderCount || Number(submissionPlan?.orderCount || 0),
    entryOnlyBlocked: true,
	    blockedReason: blockedReason === 'legacy_ibkr_submit_disabled' ? blockedReason : (helperReady === true ? uiStatus.blockedReason : blockedReason),
	    blockers: blockedReason === 'legacy_ibkr_submit_disabled' ? ['legacy_ibkr_submit_disabled'] : (helperReady === true ? [uiStatus.blockedReason] : blockers),
    checks: validation.checks || [],
    submissionPlan,
    orderSent: false,
    mockOrderSent,
    executed: false,
    submitted: false,
    orderButtonLocked: uiStatus.orderButtonLocked,
    userMessageSv: uiStatus.userMessageSv,
    eventLogged: true,
    mockPlaceOrderCalls,
    executionAttemptId,
    idempotencyKey,
    accountMode,
    safety: { ...SAFETY },
    nextRequiredAction: helperReady === true
      ? uiStatus.userMessageSv
      : 'En komplett bracket-plan krävs innan submission-helper kan användas.',
    realSubmitAttempted: false,
    protectiveOrdersSubmitted: false,
    mockProtectiveOrdersSubmitted,
    protectiveOrdersRequiredForFuture: true,
    executionLimitedFirstOrder: true,
    contract,
    incident,
    uiStatus,
  });

  if (validation.helperReady !== true) {
    return buildBlockedResponse({
      blockedReason: validation.blockedReason || 'protective_bracket_submission_required',
      blockers: validation.blockers || [],
      helperReady: false,
      mockPlaceOrderCalls: [],
      incident: null,
      mockProtectiveOrdersSubmitted: false,
    });
  }

	  if (allowRealSubmit === true && legacySubmitEnabled() !== true) {
		      return buildBlockedResponse({
		        ok: false,
		        blockedReason: 'legacy_ibkr_submit_disabled',
	        blockers: ['legacy_ibkr_submit_disabled'],
	        helperReady: true,
	        mockPlaceOrderCalls: [],
	        incident: null,
	        mockProtectiveOrdersSubmitted: false,
		        realSubmitEnabled: false,
		      });
	  }

	  if (realSubmitRequested === true) {
	    const config = options.config || readConfig();
    const client = options.ibClient || createIbClient(config);
	        const sequence = [
	          submissionPlan.entry,
	          submissionPlan.takeProfit,
	          submissionPlan.stopLoss,
	        ];
    const actualPlaceOrderCalls = [];

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          try { client.disconnect(); } catch (_) {}
          if (err) reject(err);
          else resolve();
        };
        const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => finish(new Error(`ib_placeorder_timeout_after_${timeoutMs}ms`)), timeoutMs);
        const onError = (error, code) => {
          const message = error?.message || `IB error ${code || 'unknown'}`;
          clearTimeout(timer);
          finish(new Error(message));
        };

        client.on(EventName.error, onError);
        client.once(EventName.connected, () => {
          try {
            for (const [index, order] of sequence.entries()) {
              actualPlaceOrderCalls.push(createMockPlaceOrderResult({
                submissionPlan,
                executedOrder: order,
                index: index + 1,
                simulatedCall: false,
              }));
              client.placeOrder(Number(order.orderId), contract, order);
            }
            clearTimeout(timer);
            appendExecutionAttempt({
              executionAttemptId,
              idempotencyKey: idempotencyKey || null,
              blueprintId: submissionPlan.blueprintId || null,
              candidateId: submissionPlan.candidateId || null,
              timestamp: nowIso(),
              mode: 'paper_only',
              accountMode: 'ib_paper',
              paperAccountMasked: null,
              symbol: submissionPlan.symbol || null,
              strategyId: submissionPlan.strategyId || null,
              strategyName: submissionPlan.strategyName || null,
              side: submissionPlan.side || null,
              quantity: submissionPlan.quantity || null,
              orderType: submissionPlan.orderType || 'LMT',
              status: 'SUBMITTED',
              accepted: true,
              orderSent: true,
              executed: false,
              ibOrderId: Number(sequence[0]?.orderId || null),
              blockedReason: null,
              blockers: [],
              duplicate: false,
              safety: SAFETY,
              submitted: true,
              preflightReady: true,
              bracketSubmissionPlanReady: true,
              bracketSubmissionRealSubmitEnabled: true,
              helperReady: true,
              runtimeBracketSubmitUnlocked: true,
              bracketOrderCount: MAX_ORDER_COUNT,
              entryOnlyBlocked: true,
              bracketSubmissionPlan: submissionPlan,
              userMessageSv: 'IB Paper bracket-submit skickad.',
              orderButtonLocked: true,
              protectiveOrdersSubmitted: false,
              protectiveOrdersRequiredForFuture: true,
              executionLimitedFirstOrder: true,
              armId: null,
              armArmed: false,
            });
            appendExecutionEvent({
              type: 'paper_execution_submitted',
              executionAttemptId,
              blueprintId: submissionPlan.blueprintId || null,
              candidateId: submissionPlan.candidateId || null,
              timestamp: nowIso(),
              orderSent: true,
              executed: false,
              ibOrderId: Number(sequence[0]?.orderId || null),
              orderStatus: 'SUBMITTED',
              capturedStatuses: [],
            });
            finish(null);
          } catch (err) {
            clearTimeout(timer);
            finish(err);
          }
        });
        try {
          client.connect(config.clientId);
        } catch (err) {
          clearTimeout(timer);
          finish(err);
        }
      });

      return {
        ok: true,
        accepted: true,
        helperReady: true,
        protectiveExecutionReady: false,
        bracketSubmissionPlanReady: true,
        bracketSubmissionRealSubmitEnabled: true,
        realSubmitEnabled: true,
        realSubmitActuallyExecuted: true,
        mockOnly: false,
        dryRun: false,
        orderCount: orderCount || MAX_ORDER_COUNT,
        entryOnlyBlocked: true,
        blockedReason: null,
        blockers: [],
        checks: validation.checks || [],
        submissionPlan,
        orderSent: true,
        mockOrderSent: false,
        executed: false,
        submitted: true,
        orderButtonLocked: true,
        userMessageSv: 'IB Paper bracket-submit skickad.',
        eventLogged: true,
        mockPlaceOrderCalls: actualPlaceOrderCalls,
        executionAttemptId,
        idempotencyKey,
        accountMode,
        safety: { ...SAFETY },
        nextRequiredAction: 'Ordergruppen är skickad till IB Paper-kontot.',
        realSubmitAttempted: true,
        protectiveOrdersSubmitted: false,
        mockProtectiveOrdersSubmitted: false,
        protectiveOrdersRequiredForFuture: true,
        executionLimitedFirstOrder: true,
        contract,
        incident: null,
        uiStatus: {
          ...uiStatus,
          blockedReason: null,
          userMessageSv: 'IB Paper bracket-submit skickad.',
          orderSent: true,
          executed: false,
          orderButtonLocked: true,
        },
      };
    } catch (err) {
      const failedCall = actualPlaceOrderCalls.length + 1;
      const blockedReason = `real_submit_call_${failedCall}_failed`;
      return buildBlockedResponse({
        ok: false,
        blockedReason,
        blockers: [blockedReason],
        helperReady: true,
        mockPlaceOrderCalls: actualPlaceOrderCalls,
        incident: {
          stage: `placeOrder_${failedCall}`,
          message: err?.message || 'real submit failed',
        },
        mockProtectiveOrdersSubmitted: false,
        mockOrderSent: actualPlaceOrderCalls.length > 0,
        realSubmitEnabled: true,
      });
    }
  }

	  const mockPlaceOrderCalls = [];
	  if (simulateMockCalls === true) {
	    const sequence = [
	      submissionPlan.entry,
	      submissionPlan.takeProfit,
	      submissionPlan.stopLoss,
	    ];
	    for (const [index, order] of sequence.entries()) {
	      const callInfo = createMockPlaceOrderResult({
	        submissionPlan,
	        executedOrder: order,
	        index: index + 1,
	        simulatedCall: true,
	      });
	      mockPlaceOrderCalls.push(callInfo);
	    }
    return buildBlockedResponse({
      blockedReason: blockedReasonWhenReady,
      blockers: blockedReasonWhenReady ? [blockedReasonWhenReady] : [],
      helperReady: true,
      mockPlaceOrderCalls,
      mockProtectiveOrdersSubmitted: true,
      mockOrderSent: true,
    });
  }

  return buildBlockedResponse({
    ok: true,
    blockedReason: blockedReasonWhenReady,
    blockers: blockedReasonWhenReady ? [blockedReasonWhenReady] : [],
    helperReady: true,
    mockPlaceOrderCalls: [],
    mockProtectiveOrdersSubmitted: false,
    mockOrderSent: false,
  });
}

module.exports = {
  SAFETY,
  MAX_ORDER_COUNT,
	  REAL_SUBMIT_BLOCKER,
	  REAL_SUBMIT_AUDIT_ONLY_BLOCKER,
	  LEGACY_SUBMIT_FLAG,
	  NEXT_VALID_ID_UNAVAILABLE,
  ENTRY_ONLY_FORBIDDEN,
  normalizeBracketSubmissionPresentationStatus,
  buildBracketSubmissionPlan,
  buildBracketSubmissionPreflight,
  submitBracketOrderGroup,
  _internal: {
    safeString,
    safeUpper,
    safeLower,
    safeNumber,
    nowIso,
    stableHash,
    buildCheck,
    resolveBlueprint,
    buildOrderContract,
    buildOrderRef,
    normalizeBracketSide,
    getExitSide,
    buildLegPlan,
    buildChecks,
    validateBracketSubmissionPlan,
    createMockPlaceOrderResult,
  },
};
