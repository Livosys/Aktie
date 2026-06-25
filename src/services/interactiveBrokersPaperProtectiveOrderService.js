'use strict';

const crypto = require('crypto');
const { SecType, TimeInForce, OrderType, LimitOrder, StopOrder } = require('@stoqey/ib');

const paperTradingTruthService = require('./paperTradingTruthService');
const interactiveBrokersPaperBracketSubmissionService = require('./interactiveBrokersPaperBracketSubmissionService');
const interactiveBrokersPaperReadinessNormalizerService = require('./interactiveBrokersPaperReadinessNormalizerService');
const interactiveBrokersPaperBlueprintNormalizerService = require('./interactiveBrokersPaperBlueprintNormalizerService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const REQUIRED_STOP_LOSS_MIN_PCT = 0.10;

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

function safeUpper(value) {
  return safeString(value).toUpperCase();
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

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
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
  return tradeBlueprint?.selectedBlueprint || blueprints.find((row) => row?.manualApprovalReady === true) || blueprints.find((row) => row?.blueprintReady === true) || blueprints[0] || null;
}

function buildAccountStatus(readiness = {}) {
  const normalized = interactiveBrokersPaperReadinessNormalizerService.normalizeIbPaperReadinessSnapshot(readiness || {}, {
    source: readiness?.source || 'connection_readiness',
    sourceDetail: readiness?.sourceDetail || undefined,
    ok: readiness?.ok !== false,
    loadedAt: readiness?.loadedAt || undefined,
    ageMs: readiness?.ageMs ?? undefined,
    blockedReason: readiness?.blockedReason || undefined,
    error: readiness?.error || undefined,
    liveReadinessError: readiness?.liveReadinessError || undefined,
    selectedAccount: readiness?.selectedAccount || undefined,
    expectedAccount: readiness?.expectedAccount || 'DUQ565596',
    allowDerivedReadiness: true,
  });
  const managedAccounts = Array.isArray(normalized.managedAccounts) ? normalized.managedAccounts : [];
  const paperAccountId = safeString(normalized.paperAccountId) || managedAccounts.find((row) => safeString(row).startsWith('DU')) || null;
  const selectedAccount = safeString(normalized.selectedAccount) || paperAccountId || (managedAccounts.length === 1 ? managedAccounts[0] : null);
  return {
    source: normalized.source || 'connection_readiness',
    sourceDetail: normalized.sourceDetail || null,
    loadedAt: normalized.loadedAt || null,
    ok: normalized.ok !== false,
    gatewayReachable: normalized.gatewayReachable === true,
    ibApiVerified: normalized.ibApiVerified === true,
    paperAccountVerified: normalized.paperAccountVerified === true,
    paperModeVerified: normalized.paperModeVerified === true,
    sessionVerified: normalized.sessionVerified === true,
    paperAccountId,
    selectedAccount: selectedAccount || null,
    paperAccountIdMasked: paperAccountId ? `${paperAccountId.slice(0, 2)}****${paperAccountId.slice(-3)}` : null,
    managedAccounts,
    expectedAccount: normalized.expectedAccount || 'DUQ565596',
    accountMatches: normalized.accountMatches === true,
    selectedAccountExists: Boolean(selectedAccount),
    selectedAccountMatchesPaper: normalized.accountMatches === true,
    blockedReason: normalized.blockedReason || null,
    blockers: Array.isArray(normalized.blockers) ? normalized.blockers : [],
    error: normalized.error || null,
    ageMs: normalized.ageMs ?? null,
    stale: normalized.stale === true,
    liveReadinessLoaded: normalized.liveReadinessLoaded === true || normalized.source === 'live_connection_readiness',
    staleTruthUsed: normalized.staleTruthUsed === true || normalized.source === 'stale_truth_fallback',
    liveReadinessError: normalized.liveReadinessError || null,
    nextValidId: normalized.nextValidId ?? null,
  };
}

function normalizeSide(side) {
  const raw = safeUpper(side);
  if (raw === 'BUY' || raw === 'SELL') return raw;
  return null;
}

function getExitAction(side) {
  return side === 'BUY' ? 'SELL' : side === 'SELL' ? 'BUY' : null;
}

function buildContract(symbol, selectedBlueprint = {}) {
  return {
    symbol,
    exchange: selectedBlueprint.exchange || 'SMART',
    currency: selectedBlueprint.currency || 'USD',
    secType: selectedBlueprint.secType || SecType.STK,
    primaryExchange: selectedBlueprint.primaryExchange || undefined,
  };
}

function buildOrderTemplates(plan) {
  const entryAction = plan.side;
  const exitAction = getExitAction(plan.side);
  const quantity = Number(plan.quantity || 0);
  const entryTemplate = new LimitOrder(entryAction, plan.entryReferencePrice, quantity, false);
  entryTemplate.orderType = plan.entryOrderType;
  entryTemplate.tif = plan.timeInForce;
  entryTemplate.transmit = false;
  entryTemplate.outsideRth = false;
  entryTemplate.orderRef = plan.orderRefEntry;

  const stopTemplate = new StopOrder(exitAction, plan.stopLoss, quantity, true, plan.parentOrderId || 0, plan.timeInForce);
  stopTemplate.orderType = OrderType.STP;
  stopTemplate.tif = plan.timeInForce;
  stopTemplate.transmit = false;
  stopTemplate.orderRef = plan.orderRefStop;

  const takeProfitTemplate = new LimitOrder(exitAction, plan.takeProfit, quantity, false);
  takeProfitTemplate.orderType = OrderType.LMT;
  takeProfitTemplate.tif = plan.timeInForce;
  takeProfitTemplate.transmit = true;
  takeProfitTemplate.orderRef = plan.orderRefTakeProfit;

  return {
    entryTemplate,
    stopTemplate,
    takeProfitTemplate,
  };
}

function buildProtectiveOrderPlan(options = {}) {
  const now = options.now || new Date();
  const truth = options.truth || null;
  const tradeBlueprint = options.tradeBlueprint || truth?.ibPaper?.tradeBlueprint || null;
  const readiness = options.readinessSnapshot || options.readiness || truth?.ibPaper?.connectionReadiness || truth?.readiness || null;
  const executionStatus = options.executionStatus || truth?.ibPaper?.executionStatus || null;
  const account = buildAccountStatus(readiness);
  const rawSelectedBlueprint = options.selectedBlueprint || resolveBlueprint(tradeBlueprint, options.blueprintId || options.selectedBlueprintId || null);
  const selectedBlueprintNormalization = interactiveBrokersPaperBlueprintNormalizerService.normalizeIbPaperSelectedBlueprint(rawSelectedBlueprint, {
    source: rawSelectedBlueprint?.source || options.selectedBlueprintSource || 'trade_blueprint',
  });
  const selectedBlueprint = selectedBlueprintNormalization.selectedBlueprint || rawSelectedBlueprint || null;
  const topStrategies = Array.isArray(truth?.topStrategies?.topStrategies) ? truth.topStrategies.topStrategies : [];
  const topStrategyIds = topStrategies.map((row) => safeString(row?.strategyId)).filter(Boolean);
  const topStrategySet = new Set(topStrategyIds);
  const nowMs = new Date(now).getTime();
  const createdAt = nowIso(now);
  const expiresAt = safeString(selectedBlueprint?.expiresAt) || new Date(nowMs + 10 * 60 * 1000).toISOString();
  const expiresAtMs = new Date(expiresAt).getTime();
  const isStale = !Number.isFinite(expiresAtMs) || nowMs > expiresAtMs;
  const accountMode = safeString(selectedBlueprint?.accountMode || 'ib_paper').toLowerCase();
  const symbol = safeUpper(selectedBlueprint?.symbol);
  const strategyId = safeString(selectedBlueprint?.strategyId);
  const strategyName = safeString(selectedBlueprint?.strategyName || strategyId || 'Unknown strategy');
  const direction = safeLower(selectedBlueprint?.direction);
  const side = normalizeSide(selectedBlueprint?.side);
  const exitAction = getExitAction(side);
  const quantity = Number(selectedBlueprint?.quantity || 0);
  const quantityStatus = safeString(selectedBlueprint?.quantityStatus);
  const quantityCalculated = quantityStatus === 'calculated' && quantity > 0;
  const entryReferencePrice = safeNumber(selectedBlueprint?.entryReferencePrice ?? selectedBlueprint?.entryPrice);
  const stopLoss = safeNumber(selectedBlueprint?.stopLoss ?? selectedBlueprint?.stopLossPrice);
  const takeProfit1 = safeNumber(selectedBlueprint?.takeProfit1 ?? selectedBlueprint?.takeProfit);
  const takeProfit2 = safeNumber(selectedBlueprint?.takeProfit2);
  const stopLossPct = safeNumber(selectedBlueprint?.stopLossPct ?? selectedBlueprint?.stopLossDistancePct);
  const riskReward = safeNumber(selectedBlueprint?.riskReward ?? selectedBlueprint?.riskRewardRatio);
  const orderType = safeUpper(selectedBlueprint?.orderType || 'LMT') || 'LMT';
  const timeInForce = safeUpper(selectedBlueprint?.timeInForce || 'DAY') || 'DAY';
  const marketGroup = safeString(selectedBlueprint?.marketGroup);
  const isCrypto = /USDT$/i.test(symbol) || marketGroup === 'crypto';
  const isEtf = ['etf', 'leveraged_etf'].includes(marketGroup) || symbol === 'QQQ';
  const isCfd = marketGroup === 'cfd';
  const supportedMarket = marketGroup === 'stock';
  const orderModelVerified = options.forceOrderModelVerified === false
    ? false
    : Boolean(SecType && TimeInForce && OrderType && LimitOrder && StopOrder);

  const plan = {
    groupId: `ibpp_${stableHash(`${selectedBlueprint?.blueprintId || 'missing'}:${symbol || 'unknown'}:${strategyId || 'unknown'}:${createdAt}`).slice(0, 16)}`,
    blueprintId: selectedBlueprint?.blueprintId || null,
    candidateId: selectedBlueprint?.candidateId || null,
    createdAt,
    expiresAt,
    staleAfterSeconds: 600,
    symbol: symbol || null,
    marketGroup: marketGroup || null,
    strategyId: strategyId || null,
    strategyName,
    direction: direction || 'unknown',
    side,
    actionLabelSv: side === 'BUY' ? 'Lång' : side === 'SELL' ? 'Kort' : 'Okänd',
    accountMode: accountMode === 'ib_paper' ? 'ib_paper' : accountMode,
    quantity,
    quantityStatus: quantityCalculated ? 'calculated' : (quantityStatus || 'blocked'),
    entryReferencePrice,
    stopLossPrice: stopLoss,
    takeProfitPrice: takeProfit1,
    takeProfit: takeProfit1,
    takeProfit1,
    takeProfit2,
    stopLossPct,
    riskReward,
    orderType,
    timeInForce,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    stopLossOrder: null,
    takeProfitOrder: null,
    transmitSequence: [],
    parentChildPlanExists: false,
    protectiveOrdersSubmitted: false,
    dryRun: true,
    willSubmit: false,
    orderModelVerified,
    contract: symbol ? buildContract(symbol, selectedBlueprint) : null,
    orderRefs: {
      entry: null,
      stopLoss: null,
      takeProfit: null,
    },
    safety: { ...SAFETY },
  };

  const blockers = [];
  const warnings = [];
  const checks = [];

  checks.push(buildCheck('paper_only_mode', SAFETY.mode === 'paper_only', 'hard', 'Läget är paper_only.', 'safety.mode', SAFETY.mode === 'paper_only' ? null : 'paper_only_mode'));
  checks.push(buildCheck('actions_allowed_false', SAFETY.actions_allowed === false, 'hard', 'actions_allowed är false.', 'safety.actions_allowed', SAFETY.actions_allowed === false ? null : 'actions_allowed_true'));
  checks.push(buildCheck('can_place_orders_false', SAFETY.can_place_orders === false, 'hard', 'can_place_orders är false.', 'safety.can_place_orders', SAFETY.can_place_orders === false ? null : 'can_place_orders_true'));
  checks.push(buildCheck('live_trading_disabled', SAFETY.live_trading_enabled === false, 'hard', 'live_trading_enabled är false.', 'safety.live_trading_enabled', SAFETY.live_trading_enabled === false ? null : 'live_trading_enabled_true'));
  checks.push(buildCheck('broker_disabled', SAFETY.broker_enabled === false, 'hard', 'broker_enabled är false.', 'safety.broker_enabled', SAFETY.broker_enabled === false ? null : 'broker_enabled_true'));
  checks.push(buildCheck('no_live_order_path', true, 'info', 'Ingen live-orderväg används i protective plan.', 'routes/api.js', null));
  checks.push(buildCheck('gateway_reachable', account.gatewayReachable === true, 'hard', account.gatewayReachable === true ? 'Gateway TCP är nåbar.' : 'Gateway TCP är inte nåbar.', 'interactiveBrokersPreviewService.getConnectionReadiness', account.gatewayReachable === true ? null : 'ib_gateway_unreachable'));
  checks.push(buildCheck('ib_api_verified', account.ibApiVerified === true, 'hard', account.ibApiVerified === true ? 'IB API-sessionen är verifierad.' : 'IB API-sessionen är inte verifierad.', 'interactiveBrokersPreviewService.verifyPaperSession', account.ibApiVerified === true ? null : 'ib_api_not_verified'));
  checks.push(buildCheck('paper_account_verified', account.paperAccountVerified === true, 'hard', account.paperAccountVerified === true ? 'Paper account är verifierat.' : 'Paper account är inte verifierat.', 'interactiveBrokersPreviewService.verifyPaperSession', account.paperAccountVerified === true ? null : 'paper_account_not_verified'));
  checks.push(buildCheck('paper_mode_verified', account.paperModeVerified === true, 'hard', account.paperModeVerified === true ? 'Paper mode är verifierat.' : 'Paper mode är inte verifierat.', 'interactiveBrokersPreviewService.verifyPaperSession', account.paperModeVerified === true ? null : 'paper_mode_not_verified'));
  checks.push(buildCheck('session_verified', account.sessionVerified === true, 'hard', account.sessionVerified === true ? 'Sessionen är verifierad.' : 'Sessionen är inte verifierad.', 'interactiveBrokersPreviewService.verifyPaperSession', account.sessionVerified === true ? null : 'session_not_verified'));
  checks.push(buildCheck('selected_account_exists', account.selectedAccountExists === true, 'hard', account.selectedAccountExists === true ? 'Selected account finns.' : 'Selected account saknas.', 'readiness.managedAccounts', account.selectedAccountExists === true ? null : 'selected_account_missing'));
  checks.push(buildCheck('selected_account_matches_paper', account.selectedAccountMatchesPaper === true, 'hard', account.selectedAccountMatchesPaper === true ? 'Selected account matchar paper-kontot.' : 'Selected account matchar inte paper-kontot.', 'readiness.managedAccounts', account.selectedAccountMatchesPaper === true ? null : 'paper_account_mismatch'));
  checks.push(buildCheck('preflight_snapshot_fresh', account.source !== 'preflight_session_snapshot_verified' || account.stale !== true, 'hard', account.source !== 'preflight_session_snapshot_verified' || account.stale !== true ? 'Readiness-snapshoten är färsk.' : 'Preflight snapshot är för gammal.', 'readinessVerification', account.source === 'preflight_session_snapshot_verified' && account.stale === true ? 'preflight_session_snapshot_stale' : null));
  checks.push(buildCheck('live_readiness_available', account.source !== 'stale_truth_fallback', 'hard', account.source !== 'stale_truth_fallback' ? 'Live readiness lästes från connection-readiness.' : 'Live readiness kunde inte läsas.', 'interactiveBrokersPreviewService.getConnectionReadiness', account.source !== 'stale_truth_fallback' ? null : 'live_readiness_unavailable'));
  checks.push(buildCheck('selected_blueprint_exists', Boolean(selectedBlueprint), 'hard', selectedBlueprint ? 'Selected blueprint finns.' : 'Selected blueprint saknas.', 'tradeBlueprint.selectedBlueprint', selectedBlueprint ? null : 'missing_blueprint'));
  checks.push(buildCheck('blueprint_id_valid', Boolean(selectedBlueprint?.blueprintId), 'hard', selectedBlueprint?.blueprintId ? 'BlueprintId är giltigt.' : 'BlueprintId saknas.', 'selectedBlueprint.blueprintId', selectedBlueprint?.blueprintId ? null : 'missing_blueprint'));
  checks.push(buildCheck('blueprint_not_stale', !isStale, 'hard', !isStale ? 'Blueprint är färsk.' : 'Blueprint har blivit stale.', 'selectedBlueprint.expiresAt', !isStale ? null : 'stale_blueprint'));
  checks.push(buildCheck('account_mode_ib_paper', accountMode === 'ib_paper', 'hard', accountMode === 'ib_paper' ? 'accountMode=ib_paper.' : 'accountMode är inte ib_paper.', 'selectedBlueprint.accountMode', accountMode === 'ib_paper' ? null : 'unsupported_account_mode'));
  checks.push(buildCheck('symbol_exists', Boolean(symbol), 'hard', symbol ? `Symbol: ${symbol}` : 'Symbol saknas.', 'selectedBlueprint.symbol', symbol ? null : 'selected_blueprint_symbol_missing'));
  checks.push(buildCheck('supported_us_equity', Boolean(symbol) && accountMode === 'ib_paper' && supportedMarket && !isCrypto && !isEtf && !isCfd, 'hard', (!isCrypto && !isEtf && !isCfd && supportedMarket && accountMode === 'ib_paper') ? 'Symbolen är en tillåten US equity.' : 'Symbolen är inte tillåten i Fas 4G-2P.', 'selectedBlueprint.marketGroup', (!isCrypto && !isEtf && !isCfd && supportedMarket && accountMode === 'ib_paper') ? null : 'selected_blueprint_unsupported_market_group'));
  checks.push(buildCheck('crypto_blocked', !isCrypto, 'hard', !isCrypto ? 'Crypto är blockerat.' : 'Crypto är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isCrypto ? 'crypto_not_allowed_for_ib_paper_first_order' : null));
  checks.push(buildCheck('etf_blocked_phase_1', !isEtf, 'hard', !isEtf ? 'ETF är inte vald.' : 'ETF är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isEtf ? 'etf_not_allowed_for_ib_paper_first_order' : null));
  checks.push(buildCheck('cfd_blocked_phase_1', !isCfd, 'hard', !isCfd ? 'CFD är inte vald.' : 'CFD är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isCfd ? 'selected_blueprint_unsupported_market_group' : null));
  checks.push(buildCheck('strategy_in_top3', Boolean(strategyId) && topStrategySet.has(strategyId), 'hard', topStrategySet.has(strategyId) ? 'Strategin är i top 3.' : 'Strategin är inte i top 3.', 'topStrategies.topStrategies', topStrategySet.has(strategyId) ? null : 'not_top_3_strategy'));
  checks.push(buildCheck('strategy_approved', Boolean(strategyId) && Array.isArray(tradeBlueprint?.blueprints) && tradeBlueprint.blueprints.some((row) => safeString(row?.strategyId) === strategyId && row?.blueprintReady === true), 'hard', Array.isArray(tradeBlueprint?.blueprints) && tradeBlueprint.blueprints.some((row) => safeString(row?.strategyId) === strategyId && row?.blueprintReady === true) ? 'Strategin är godkänd.' : 'Strategin är inte godkänd.', 'tradeBlueprint.blueprints', Array.isArray(tradeBlueprint?.blueprints) && tradeBlueprint.blueprints.some((row) => safeString(row?.strategyId) === strategyId && row?.blueprintReady === true) ? null : 'unapproved_strategy'));
  checks.push(buildCheck('strategy_mapped', Boolean(strategyId), 'hard', strategyId ? 'StrategyId finns.' : 'StrategyId saknas.', 'selectedBlueprint.strategyId', strategyId ? null : 'unmapped_strategy'));
  checks.push(buildCheck('direction_clear', ['long', 'short'].includes(direction), 'hard', ['long', 'short'].includes(direction) ? 'Riktningen är tydlig.' : 'Riktningen är oklar.', 'selectedBlueprint.direction', ['long', 'short'].includes(direction) ? null : 'unknown_direction'));
  checks.push(buildCheck('side_resolved', ['BUY', 'SELL'].includes(side), 'hard', ['BUY', 'SELL'].includes(side) ? 'Side är resolvat.' : 'Side kunde inte resolvas.', 'selectedBlueprint.side', ['BUY', 'SELL'].includes(side) ? null : 'selected_blueprint_side_missing'));
  checks.push(buildCheck('entry_exists', entryReferencePrice > 0, 'hard', entryReferencePrice > 0 ? 'Entry finns.' : 'Entry saknas.', 'selectedBlueprint.entryReferencePrice', entryReferencePrice > 0 ? null : 'selected_blueprint_entry_missing'));
  checks.push(buildCheck('stop_loss_exists', stopLoss > 0, 'hard', stopLoss > 0 ? 'Stop loss finns.' : 'Stop loss saknas.', 'selectedBlueprint.stopLoss', stopLoss > 0 ? null : 'selected_blueprint_stop_loss_missing'));
  checks.push(buildCheck('take_profit_exists', takeProfit1 > 0, 'hard', takeProfit1 > 0 ? 'Take profit finns.' : 'Take profit saknas.', 'selectedBlueprint.takeProfit', takeProfit1 > 0 ? null : 'selected_blueprint_take_profit_missing'));
  checks.push(buildCheck('stop_loss_side_valid', direction === 'long' ? stopLoss < entryReferencePrice : direction === 'short' ? stopLoss > entryReferencePrice : false, 'hard', direction === 'long' ? 'Stop loss ligger under entry.' : direction === 'short' ? 'Stop loss ligger över entry.' : 'Stop loss-sidan kan inte valideras.', 'selectedBlueprint.stopLoss', direction === 'long' ? (stopLoss < entryReferencePrice ? null : 'invalid_stop_loss_side') : direction === 'short' ? (stopLoss > entryReferencePrice ? null : 'invalid_stop_loss_side') : 'invalid_stop_loss_side'));
  checks.push(buildCheck('take_profit_side_valid', direction === 'long' ? takeProfit1 > entryReferencePrice : direction === 'short' ? takeProfit1 < entryReferencePrice : false, 'hard', direction === 'long' ? 'Take profit ligger över entry.' : direction === 'short' ? 'Take profit ligger under entry.' : 'Take profit-sidan kan inte valideras.', 'selectedBlueprint.takeProfit', direction === 'long' ? (takeProfit1 > entryReferencePrice ? null : 'invalid_take_profit_side') : direction === 'short' ? (takeProfit1 < entryReferencePrice ? null : 'invalid_take_profit_side') : 'invalid_take_profit_side'));
  checks.push(buildCheck('quantity_valid', quantity > 0, 'hard', quantity > 0 ? 'Quantity är giltig.' : 'Quantity saknas.', 'selectedBlueprint.quantity', quantity > 0 ? null : 'selected_blueprint_quantity_missing'));
  checks.push(buildCheck('quantity_matches_all_legs', quantity > 0 && quantity === Number(selectedBlueprint?.quantity || 0), 'hard', quantity > 0 ? 'Quantity matchar alla legs.' : 'Quantity saknas.', 'selectedBlueprint.quantity', quantity > 0 ? null : 'selected_blueprint_quantity_missing'));
  checks.push(buildCheck('risk_reward_reasonable', Number.isFinite(riskReward) && riskReward >= 1, 'hard', Number.isFinite(riskReward) && riskReward >= 1 ? 'Risk/reward är rimlig.' : 'Risk/reward är inte rimlig.', 'selectedBlueprint.riskReward', Number.isFinite(riskReward) && riskReward >= 1 ? null : 'invalid_risk_reward'));
  checks.push(buildCheck('stop_loss_min_pct_ok', Number.isFinite(stopLossPct) && stopLossPct >= REQUIRED_STOP_LOSS_MIN_PCT, 'hard', Number.isFinite(stopLossPct) && stopLossPct >= REQUIRED_STOP_LOSS_MIN_PCT ? 'Stop loss är minst 0,10 %.' : 'Stop loss är för liten.', 'selectedBlueprint.stopLossPct', Number.isFinite(stopLossPct) && stopLossPct >= REQUIRED_STOP_LOSS_MIN_PCT ? null : 'stop_loss_too_small'));
  checks.push(buildCheck('order_model_verified', orderModelVerified, 'hard', orderModelVerified ? 'IB ordermodell och bibliotekskontrakt är verifierade.' : 'IB ordermodell kunde inte verifieras.', '@stoqey/ib', orderModelVerified ? null : 'ib_order_model_unverified'));
  checks.push(buildCheck('no_live_flags_true', SAFETY.actions_allowed === false && SAFETY.can_place_orders === false && SAFETY.live_trading_enabled === false && SAFETY.broker_enabled === false, 'hard', 'Globala live-flaggor är false.', 'safety', null));
  checks.push(buildCheck('no_real_submit', true, 'info', 'Denna service skickar aldrig order.', 'interactiveBrokersPaperProtectiveOrderService', null));

  const hardFailedChecks = checks.filter((check) => check.ok !== true && check.severity === 'hard');
  for (const check of hardFailedChecks) {
    if (check.blocker) blockers.push(check.blocker);
  }
  if (account.source === 'stale_truth_fallback' && !blockers.includes('live_readiness_unavailable')) {
    blockers.unshift('live_readiness_unavailable');
  }
  if (entryReferencePrice > 0 && stopLoss > 0 && takeProfit1 > 0 && side && quantity > 0) {
    const exit = getExitAction(side);
    const entryOrderType = orderType === 'MKT' ? 'MKT' : 'LMT';
    const orderRefs = {
      entry: `IBPP:${stableHash(`${selectedBlueprint?.blueprintId || 'missing'}:entry:${createdAt}`).slice(0, 12)}`,
      stopLoss: `IBPP:${stableHash(`${selectedBlueprint?.blueprintId || 'missing'}:sl:${createdAt}`).slice(0, 12)}`,
      takeProfit: `IBPP:${stableHash(`${selectedBlueprint?.blueprintId || 'missing'}:tp:${createdAt}`).slice(0, 12)}`,
    };
    const { entryTemplate, stopTemplate, takeProfitTemplate } = buildOrderTemplates({
      side,
      entryReferencePrice,
      stopLoss,
      takeProfit: takeProfit1,
      quantity,
      entryOrderType,
      timeInForce,
      orderRefEntry: orderRefs.entry,
      orderRefStop: orderRefs.stopLoss,
      orderRefTakeProfit: orderRefs.takeProfit,
    });
    plan.entry = {
      role: 'entry',
      orderType: entryOrderType,
      action: side,
      quantity,
      transmit: false,
      parentIdRequired: false,
      orderRef: orderRefs.entry,
      template: {
        action: safeString(entryTemplate.action || side),
        lmtPrice: entryTemplate.lmtPrice ?? null,
        orderType: entryTemplate.orderType || entryOrderType,
        tif: entryTemplate.tif || timeInForce,
        transmit: false,
      },
    };
    plan.stopLoss = {
      role: 'stop_loss',
      orderType: 'STP',
      action: exit,
      quantity,
      stopPrice: stopLoss,
      parentIdRequired: true,
      transmit: false,
      orderRef: orderRefs.stopLoss,
      template: {
        action: safeString(stopTemplate.action || exit),
        auxPrice: stopTemplate.auxPrice ?? stopLoss,
        orderType: stopTemplate.orderType || 'STP',
        tif: stopTemplate.tif || timeInForce,
        transmit: false,
      },
    };
    plan.takeProfit = {
      role: 'take_profit',
      orderType: 'LMT',
      action: exit,
      quantity,
      limitPrice: takeProfit1,
      parentIdRequired: true,
      transmit: true,
      orderRef: orderRefs.takeProfit,
      template: {
        action: safeString(takeProfitTemplate.action || exit),
        lmtPrice: takeProfitTemplate.lmtPrice ?? takeProfit1,
        orderType: takeProfitTemplate.orderType || 'LMT',
        tif: takeProfitTemplate.tif || timeInForce,
        transmit: true,
      },
    };
    plan.stopLossOrder = plan.stopLoss;
    plan.takeProfitOrder = plan.takeProfit;
    plan.transmitSequence = ['entry:false', 'stopLoss:false', 'takeProfit:true'];
    plan.parentChildPlanExists = true;
    plan.orderRefs = orderRefs;
  }

  const protectivePlanReady = hardFailedChecks.length === 0 && orderModelVerified && Boolean(plan.entry) && Boolean(plan.stopLoss) && Boolean(plan.takeProfit) && plan.parentChildPlanExists === true;
  const protectivePathAvailable = protectivePlanReady;
  const protectiveExecutionReady = protectivePlanReady;
  const blockedReason = blockers[0] || null;
  const executionBlockedReason = !protectivePlanReady
    ? (blockedReason || 'protective_plan_not_ready')
    : 'real_submit_audit_only';

  if (!protectivePlanReady && !blockers.includes('protective_plan_not_ready')) {
    blockers.unshift(blockedReason || 'protective_plan_not_ready');
  }

  return {
    ok: true,
    mode: 'paper_only',
    preflightOnly: true,
    dryRun: true,
    protectivePathAvailable,
    protectivePlanReady,
    protectiveExecutionReady,
    blockedReason: executionBlockedReason,
    blockers,
    warnings,
    checks,
    selectedBlueprint,
    selectedBlueprintNormalization,
    account,
    readinessVerification: account,
    plan: protectivePlanReady ? plan : {
      ...plan,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      protectiveOrdersSubmitted: false,
      willSubmit: false,
      protectiveExecutionReady,
    },
    summary: {
      totalChecks: checks.length,
      passedChecks: checks.filter((row) => row.ok === true).length,
      failedHardChecks: hardFailedChecks.length,
      warningChecks: checks.filter((row) => row.ok === true && row.severity === 'warning').length,
      protectivePathAvailable,
      protectivePlanReady,
      protectiveExecutionReady,
      blockedReason: executionBlockedReason,
    },
    safety: { ...SAFETY },
    executionStatus,
    tradeBlueprint,
    truth,
    contract: plan.contract,
    contractVerified: orderModelVerified,
    orderModelVerified,
    createdAt,
    expiresAt,
    requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
  };
}

function buildProtectivePreflightResponse(options = {}) {
  const planResult = buildProtectiveOrderPlan(options);
  const bracketPlan = interactiveBrokersPaperBracketSubmissionService.buildBracketSubmissionPreflight({
    now: options.now,
    truth: options.truth,
    executionStatus: options.executionStatus,
    tradeBlueprint: options.tradeBlueprint,
    readiness: options.readiness,
    selectedBlueprint: planResult.selectedBlueprint,
    protectivePlan: planResult,
    nextValidId: options.nextValidId ?? options.readiness?.nextValidId ?? options.executionStatus?.readiness?.nextValidId ?? null,
  });
  const helperReady = bracketPlan.helperReady === true || bracketPlan.bracketSubmissionPlanReady === true;
  const ready = planResult.protectivePlanReady === true && bracketPlan.bracketSubmissionPlanReady === true && helperReady === true;
  const selectedBlueprint = planResult.selectedBlueprint || null;
  const transmitSequence = Array.isArray(planResult.plan?.transmitSequence)
    ? planResult.plan.transmitSequence.join(' \u2192 ')
    : null;
  const realSubmitGate = {
    gateReady: ready,
    gateSource: 'protective_preflight_readiness',
    gateScope: 'single_ib_paper_bracket_order',
    gateOpensRealSubmit: false,
    requiresFinalPhase: '4G-2D',
    blockedReason: ready ? 'real_submit_audit_only' : (planResult.blockedReason || bracketPlan.blockedReason || 'protective_plan_not_ready'),
    blockers: ready ? [] : Array.from(new Set([
      ...(Array.isArray(planResult.blockers) ? planResult.blockers : []),
      ...(Array.isArray(bracketPlan.blockers) ? bracketPlan.blockers : []),
    ].filter(Boolean))),
  };
  return {
    ok: true,
    mode: 'paper_only',
    preflightOnly: true,
    dryRun: true,
    orderSent: false,
    executed: false,
    accepted: ready,
    protectivePathAvailable: planResult.protectivePathAvailable === true,
    protectivePlanReady: planResult.protectivePlanReady === true,
    protectiveExecutionReady: planResult.protectiveExecutionReady === true,
    blockedReason: ready ? null : (planResult.blockedReason || bracketPlan.blockedReason || null),
    blockers: ready ? [] : Array.from(new Set([
      ...(Array.isArray(planResult.blockers) ? planResult.blockers : []),
      ...(Array.isArray(bracketPlan.blockers) ? bracketPlan.blockers : []),
    ].filter(Boolean))),
    warnings: Array.isArray(planResult.warnings) ? planResult.warnings : [],
    checks: Array.isArray(planResult.checks) ? planResult.checks : [],
    summary: planResult.summary,
    plan: planResult.plan,
    bracketSubmissionPlanReady: bracketPlan.bracketSubmissionPlanReady === true,
    bracketSubmissionRealSubmitEnabled: bracketPlan.bracketSubmissionRealSubmitEnabled === true,
    helperReady,
    bracketOrderCount: bracketPlan.orderCount || 0,
    entryOnlyBlocked: bracketPlan.entryOnlyBlocked === true,
    bracketBlockedReason: bracketPlan.blockedReason || null,
    userMessageSv: bracketPlan.userMessageSv || null,
    orderButtonLocked: bracketPlan.orderButtonLocked === true,
    bracketSubmissionPlan: bracketPlan.submissionPlan || null,
    bracketSummary: bracketPlan.summary || null,
    bracketChecks: bracketPlan.checks || [],
    uiStatus: bracketPlan.uiStatus || null,
    selectedBlueprint,
    selectedBlueprintVerification: selectedBlueprint ? {
      source: selectedBlueprint.source || 'trade_blueprint',
      symbol: selectedBlueprint.symbol || null,
      side: selectedBlueprint.side || null,
      quantity: selectedBlueprint.quantity ?? null,
      entryPrice: selectedBlueprint.entryPrice ?? selectedBlueprint.entryReferencePrice ?? null,
      stopLoss: selectedBlueprint.stopLoss ?? selectedBlueprint.stopLossPrice ?? null,
      takeProfit: selectedBlueprint.takeProfit ?? selectedBlueprint.takeProfit1 ?? null,
      marketGroup: selectedBlueprint.marketGroup || null,
      assetClass: selectedBlueprint.assetClass || null,
      secType: selectedBlueprint.secType || null,
      currency: selectedBlueprint.currency || null,
      exchange: selectedBlueprint.exchange || null,
      primaryExchange: selectedBlueprint.primaryExchange || null,
      stopLossPct: selectedBlueprint.stopLossPct ?? null,
      riskReward: selectedBlueprint.riskReward ?? null,
      blockers: planResult.selectedBlueprintNormalization?.blockers || [],
    } : null,
    account: planResult.account,
    accountId: planResult.account?.paperAccountId || planResult.account?.selectedAccount || null,
    readinessVerification: planResult.readinessVerification || planResult.account,
    readinessSource: planResult.account?.source || null,
    liveReadinessLoaded: planResult.account?.liveReadinessLoaded === true,
    staleTruthUsed: planResult.account?.staleTruthUsed === true,
    safety: { ...SAFETY },
    orderModelVerified: planResult.orderModelVerified === true,
    contractVerified: planResult.contractVerified === true,
    transmitSequence,
    parentChild: planResult.plan?.parentChildPlanExists === true,
    realSubmitGate,
    nextRequiredAction: planResult.protectivePlanReady === true
      ? 'Skyddsplanen är redo för framtida IB Paper one-shot, men order sending är fortfarande låst.'
      : `Åtgärda blockerarna och kör preflight igen. Första blocker: ${planResult.blockedReason || 'protective_plan_not_ready'}.`,
    note: 'Ingen order skickas i denna fas.',
  };
}

module.exports = {
  SAFETY,
  REQUIRED_STOP_LOSS_MIN_PCT,
  buildProtectiveOrderPlan,
  buildProtectivePreflightResponse,
  _internal: {
    safeString,
    safeNumber,
    safeLower,
    safeUpper,
    round,
    stableHash,
    nowIso,
    buildCheck,
    resolveBlueprint,
    buildAccountStatus,
    normalizeSide,
    getExitAction,
    buildContract,
    buildOrderTemplates,
  },
};
