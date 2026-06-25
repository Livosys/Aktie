'use strict';

/**
 * IB Paper execution preflight.
 *
 * Read-only control chain that checks whether a future manually approved IB
 * Paper order would be eligible. It never places orders, never calls submit,
 * never transmits and never changes safety state.
 */

const paperTradingTruthService = require('./paperTradingTruthService');
const interactiveBrokersPaperProtectiveOrderService = require('./interactiveBrokersPaperProtectiveOrderService');
const interactiveBrokersPaperBracketSubmissionService = require('./interactiveBrokersPaperBracketSubmissionService');
const interactiveBrokersPaperReadinessLoaderService = require('./interactiveBrokersPaperReadinessLoaderService');
const interactiveBrokersPaperBlueprintNormalizerService = require('./interactiveBrokersPaperBlueprintNormalizerService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const REQUIRED_CONFIRMATION_PHRASE = 'CONFIRM PAPER TRADE';
const EXPECTED_PAPER_ACCOUNT = 'DUQ565596';
const REQUIRED_STOP_LOSS_MIN_PCT = 0.10;
const SUPPORTED_US_EQUITY_MARKET_GROUPS = new Set(['stock', 'stocks', 'equity', 'us_stock', 'us_equity', 'mag7', 'nasdaq100']);
const BLOCKED_ETF_MARKET_GROUPS = new Set(['etf', 'leveraged_etf']);

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function safeNumber(value, fallback = null) {
  if (value === '' || value == null) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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

function normalizeBlueprintList(tradeBlueprint) {
  return safeArray(tradeBlueprint?.blueprints);
}

function resolveBlueprint(tradeBlueprint, selectedBlueprintId = null) {
  const blueprints = normalizeBlueprintList(tradeBlueprint);
  if (selectedBlueprintId) {
    const match = blueprints.find((row) => safeString(row?.blueprintId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.candidateId) === safeString(selectedBlueprintId))
      || blueprints.find((row) => safeString(row?.symbol) && safeString(row?.strategyId) && `${safeString(row.symbol)}:${safeString(row.strategyId)}` === safeString(selectedBlueprintId));
    return match || null;
  }
  return tradeBlueprint?.selectedBlueprint || blueprints.find((row) => row?.manualApprovalReady === true) || blueprints.find((row) => row?.blueprintReady === true) || blueprints[0] || null;
}

function normalizeMarketGroup(symbol, rawMarketGroup, assetClass = null) {
  const marketGroup = safeString(rawMarketGroup).toLowerCase();
  const normalizedAssetClass = safeString(assetClass).toUpperCase();
  const normalizedSymbol = safeString(symbol).toUpperCase();

  if (/USDT$/i.test(normalizedSymbol) || marketGroup === 'crypto' || normalizedAssetClass === 'CRYPTO') {
    return 'crypto';
  }
  if (marketGroup === 'cfd' || normalizedAssetClass === 'CFD') {
    return 'cfd';
  }
  if (BLOCKED_ETF_MARKET_GROUPS.has(marketGroup) || normalizedSymbol === 'QQQ' || normalizedSymbol === 'SPY') {
    return marketGroup || 'etf';
  }
  if (SUPPORTED_US_EQUITY_MARKET_GROUPS.has(marketGroup)) {
    return 'stock';
  }
  if (!marketGroup && normalizedSymbol && normalizedAssetClass !== 'CRYPTO') {
    return 'stock';
  }
  return marketGroup || null;
}

function normalizePreflightQuantity(candidate = {}, fallbackQuantity = null) {
  const rawQuantity = safeString(candidate.quantity || candidate.shares || candidate.calculatedQuantity || candidate.orderQuantity || fallbackQuantity || '');
  const quantity = Number(rawQuantity);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function normalizeStopLossPct({ direction, entryPrice, stopLoss, stopLossPct }) {
  const explicit = Number(stopLossPct);
  if (Number.isFinite(explicit) && explicit > 0) {
    return round(explicit, 4);
  }
  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0) return null;
  const pct = (Math.abs(entry - stop) / entry) * 100;
  return Number.isFinite(pct) && pct > 0 ? round(pct, 4) : null;
}

function normalizeRiskReward({ entryPrice, stopLoss, takeProfit, riskReward }) {
  const explicit = Number(riskReward);
  if (Number.isFinite(explicit) && explicit > 0) {
    return round(explicit, 2);
  }
  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  const target = Number(takeProfit);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0 || !Number.isFinite(target) || target <= 0) {
    return null;
  }
  const risk = Math.abs(stop - entry);
  const reward = Math.abs(target - entry);
  if (!(risk > 0) || !(reward > 0)) return null;
  return round(reward / risk, 2);
}

function buildNormalizedSelectedBlueprint(candidate, { expectedAccount = EXPECTED_PAPER_ACCOUNT, source = 'trade_blueprint' } = {}) {
  const normalized = interactiveBrokersPaperBlueprintNormalizerService.normalizeIbPaperSelectedBlueprint(candidate, {
    expectedAccount,
    source,
  });
  return {
    source,
    selectedBlueprint: normalized.selectedBlueprint,
    validForPreflight: normalized.validForPreflight === true,
    missingFields: normalized.missingFields || [],
    normalizationWarnings: normalized.normalizationWarnings || [],
    blockersFromBlueprint: normalized.blockers || [],
    symbol: normalized.symbol || null,
    side: normalized.side || null,
    quantity: normalized.quantity ?? null,
    marketGroup: normalized.marketGroup || null,
    assetClass: normalized.assetClass || null,
    secType: normalized.secType || null,
    currency: normalized.currency || null,
    exchange: normalized.exchange || null,
    primaryExchange: normalized.primaryExchange || null,
    entryPrice: normalized.entryPrice ?? null,
    stopLoss: normalized.stopLoss ?? null,
    takeProfit: normalized.takeProfit ?? null,
    stopLossPct: normalized.stopLossPct ?? null,
    riskReward: normalized.riskReward ?? null,
    fallback: normalized.fallback === true,
  };
}

function getProtectiveSelectedBlueprintCandidate(protectivePreflight = {}) {
  return protectivePreflight?.selectedBlueprint
    || protectivePreflight?.plan?.selectedBlueprint
    || protectivePreflight?.protectiveOrderPlan?.selectedBlueprint
    || protectivePreflight?.bracketSubmissionPlan?.selectedBlueprint
    || protectivePreflight?.plan
    || null;
}

function getTradeBlueprintSelectedBlueprintCandidate(tradeBlueprint = {}) {
  return tradeBlueprint?.selectedBlueprint
    || tradeBlueprint?.manualApproval?.selectedBlueprint
    || (Array.isArray(tradeBlueprint?.blueprints)
      ? tradeBlueprint.blueprints.find((row) => row?.selected === true || row?.manualApprovalReady === true || row?.blueprintReady === true) || tradeBlueprint.blueprints[0] || null
      : null);
}

function getTruthSelectedBlueprintCandidate(truth = {}) {
  return truth?.ibPaper?.selectedBlueprint
    || truth?.ibPaper?.manualApproval?.selectedBlueprint
    || truth?.ibPaper?.tradeBlueprint?.selectedBlueprint
    || truth?.selectedBlueprint
    || null;
}

function getPreviewSelectedBlueprintCandidate(preview = {}, scaffold = {}) {
  return preview?.selectedBlueprint
    || preview?.primaryCandidate
    || preview?.topCandidate
    || preview?.candidates?.[0]
    || preview?.approvedStrategies?.[0]
    || scaffold?.primaryCandidate
    || scaffold?.selectedBlueprint
    || scaffold?.candidateBlueprints?.[0]
    || null;
}

function buildIbPaperSelectedBlueprintForPreflight({
  truth = null,
  tradeBlueprint = null,
  protectivePreflight = null,
  preview = null,
  scaffold = null,
  expectedAccount = EXPECTED_PAPER_ACCOUNT,
} = {}) {
  const candidates = [
    { source: 'trade_blueprint', candidate: getTradeBlueprintSelectedBlueprintCandidate(tradeBlueprint) },
    { source: 'protective_preflight', candidate: getProtectiveSelectedBlueprintCandidate(protectivePreflight) },
    { source: 'truth_selected', candidate: getTruthSelectedBlueprintCandidate(truth) },
    { source: 'preview', candidate: getPreviewSelectedBlueprintCandidate(preview, scaffold) },
  ];

  for (const row of candidates) {
    const normalized = buildNormalizedSelectedBlueprint(row.candidate, { expectedAccount, source: row.source });
    if (normalized.validForPreflight === true) {
      return normalized;
    }
  }

  for (const row of candidates) {
    const normalized = buildNormalizedSelectedBlueprint(row.candidate, { expectedAccount, source: row.source });
    if (normalized.selectedBlueprint) {
      return normalized;
    }
  }

  return {
    source: 'none',
    selectedBlueprint: null,
    validForPreflight: false,
    missingFields: ['selected_blueprint_missing'],
    normalizationWarnings: [],
    blockersFromBlueprint: ['selected_blueprint_missing'],
  };
}

function buildIbPaperReadOnlySessionVerificationSnapshot(readiness = {}, options = {}) {
  const expectedAccount = safeString(options.expectedAccount || 'DUQ565596') || 'DUQ565596';
  const managedAccounts = safeArray(readiness.managedAccounts)
    .map((row) => safeString(row))
    .filter(Boolean);
  const paperAccountId = safeString(readiness.paperAccountId) || managedAccounts.find((row) => safeString(row).startsWith('DU')) || null;
  const ibApiVerified = readiness.ibApiVerified === true;
  const paperAccountVerified = readiness.paperAccountVerified === true;
  const paperModeVerified = readiness.paperModeVerified === true || (ibApiVerified && paperAccountVerified);
  const fallbackSelectedAccount = managedAccounts.find((row) => safeString(row) === expectedAccount)
    || (managedAccounts.length === 1 ? managedAccounts[0] : null);
  const selectedAccount = safeString(options.selectedAccount)
    || paperAccountId
    || fallbackSelectedAccount
    || null;
  const accountMatches = [selectedAccount, paperAccountId, ...managedAccounts].some((row) => safeString(row) === expectedAccount);
  const gatewayReachable = readiness.gatewayReachable === true;
  const sessionVerified = readiness.sessionVerified === true || (ibApiVerified && paperAccountVerified && accountMatches);
  const blockers = safeArray(readiness.blockers).filter(Boolean);

  if (!gatewayReachable) blockers.push('ib_gateway_unreachable');
  if (!ibApiVerified) blockers.push('ib_api_not_verified');
  if (!paperAccountVerified) blockers.push('paper_account_not_verified');
  if (!paperModeVerified) blockers.push('paper_mode_not_verified');
  if (!sessionVerified) blockers.push('session_not_verified');
  if (!selectedAccount) blockers.push('selected_account_missing');
  if (!accountMatches) blockers.push('paper_account_mismatch');

  return {
    source: readiness.source || options.source || 'connection_readiness',
    loadedAt: readiness.loadedAt || null,
    ok: readiness.ok !== false,
    gatewayReachable,
    ibApiVerified,
    paperAccountVerified,
    paperModeVerified,
    sessionVerified,
    paperAccountId: paperAccountId || null,
    selectedAccount,
    managedAccounts,
    expectedAccount,
    accountMatches,
    blockedReason: readiness.blockedReason || blockers[0] || null,
    blockers,
    error: readiness.error || null,
    liveReadinessLoaded: readiness.liveReadinessLoaded === true,
    staleTruthUsed: readiness.staleTruthUsed === true,
    liveReadinessError: readiness.liveReadinessError || null,
    nextValidId: readiness.nextValidId ?? null,
    selectedAccountExists: Boolean(selectedAccount),
    selectedAccountMatchesPaper: accountMatches,
    paperAccountIdMasked: maskPaperAccountId(paperAccountId),
  };
}

function buildAccountStatus(readiness = {}, options = {}) {
  return buildIbPaperReadOnlySessionVerificationSnapshot(readiness, options);
}

function buildExecutionGateChecks({ selectedBlueprint, executionStatus }) {
  const killSwitchActive = executionStatus?.killSwitch?.active === true;
  const openTradeCount = Number(executionStatus?.openTradeCount || safeArray(executionStatus?.openTrades).length || 0);
  const dailyQuota = executionStatus?.dailyQuota || { used: 0, max: 3, remaining: 3 };
  const dailyQuotaOk = Number(dailyQuota.used || 0) < Number(dailyQuota.max || 3);
  const maxOpenTradesOk = openTradeCount < 3;
  const referenceBlueprint = selectedBlueprint || executionStatus?.selectedBlueprint || null;
  const duplicateCandidate = Boolean(referenceBlueprint && safeString(referenceBlueprint.symbol) && safeString(referenceBlueprint.strategyId)
    && safeArray(executionStatus?.openTrades).some((row) => safeString(row.symbol) === safeString(referenceBlueprint.symbol)
      && safeString(row.strategyId) === safeString(referenceBlueprint.strategyId)));

  return [
    buildCheck('daily_quota_not_reached', dailyQuotaOk, 'hard', `Daglig kvot är ${dailyQuota.used || 0}/${dailyQuota.max || 3}.`, 'executionStatus.dailyQuota', dailyQuotaOk ? null : 'daily_quota_reached'),
    buildCheck('max_open_trades_not_reached', maxOpenTradesOk, 'hard', `Öppna trades är ${openTradeCount}/3.`, 'executionStatus.openTrades', maxOpenTradesOk ? null : 'max_open_trades_reached'),
    buildCheck('duplicate_candidate', !duplicateCandidate, 'hard', duplicateCandidate ? 'Samma symbol/strategi är redan aktiv.' : 'Ingen duplicerad kandidat hittades.', 'executionStatus.openTrades', duplicateCandidate ? 'duplicate_candidate' : null),
    buildCheck('kill_switch_inactive', killSwitchActive !== true, 'hard', killSwitchActive ? 'Kill switch är aktiv.' : 'Kill switch är inaktiv.', 'executionStatus.killSwitch', killSwitchActive ? 'kill_switch_active' : null),
    buildCheck('drawdown_protection_ok', true, 'info', 'Drawdown-protection är read-only och blockar inte preflight i Fas 4A.', 'executionStatus.killSwitch', null),
    buildCheck('consecutive_losses_protection_ok', true, 'info', 'Consecutive-losses skydd är redan representerat via kill switch read-only.', 'executionStatus.killSwitch', null),
    buildCheck('strategy_lock_ok', !duplicateCandidate, 'hard', duplicateCandidate ? 'Strategilås eller duplicate candidate blockerar första ordern.' : 'Strategilås är okej.', 'executionStatus.openTrades', duplicateCandidate ? 'strategy_lock_active' : null),
    buildCheck('symbol_lock_ok', !duplicateCandidate, 'hard', duplicateCandidate ? 'Symbollås eller duplicate candidate blockerar första ordern.' : 'Symbollås är okej.', 'executionStatus.openTrades', duplicateCandidate ? 'symbol_lock_active' : null),
  ];
}

function buildBlueprintChecks({ selectedBlueprint, truth, tradeBlueprint, readiness, executionStatus, confirmationText, now = new Date() }) {
  const topStrategies = safeArray(truth?.topStrategies?.topStrategies);
  const topStrategyIds = topStrategies.map((row) => safeString(row?.strategyId)).filter(Boolean);
  const paperReadyTop3 = topStrategies.filter((row) => row?.readyForIbPaper === true);
  const account = buildAccountStatus(readiness);
  const nowMs = new Date(now).getTime();
  const createdAtMs = new Date(selectedBlueprint?.createdAt || 0).getTime();
  const expiresAtMs = new Date(selectedBlueprint?.expiresAt || 0).getTime();
  const isStale = Number.isFinite(expiresAtMs) ? nowMs > expiresAtMs : true;
  const quantityStatus = safeString(selectedBlueprint?.quantityStatus);
  const quantityCalculated = quantityStatus === 'calculated' && Number(selectedBlueprint?.quantity || 0) > 0;
  const riskPct = Number(selectedBlueprint?.riskPct);
  const riskAmount = selectedBlueprint?.riskAmount;
  const entryReferencePrice = Number(selectedBlueprint?.entryReferencePrice || selectedBlueprint?.entryPrice || 0);
  const stopLoss = Number(selectedBlueprint?.stopLoss || selectedBlueprint?.stopLossPrice || 0);
  const takeProfit = Number(selectedBlueprint?.takeProfit || selectedBlueprint?.takeProfit1 || 0);
  const stopLossPct = Number(selectedBlueprint?.stopLossPct || selectedBlueprint?.stopLossDistancePct || 0);
  const riskReward = Number(selectedBlueprint?.riskReward || selectedBlueprint?.riskRewardRatio || 0);
  const symbol = safeString(selectedBlueprint?.symbol);
  const strategyId = safeString(selectedBlueprint?.strategyId);
  const strategyApproved = Boolean(strategyId) && Boolean(safeArray(tradeBlueprint?.blueprints).find((row) => safeString(row?.strategyId) === strategyId && row?.blueprintReady === true));
  const strategyInTop3 = topStrategyIds.includes(strategyId) || Number(selectedBlueprint?.top3Rank || 0) > 0;
  const accountMode = safeString(selectedBlueprint?.accountMode) === 'ib_paper';
  const marketGroup = safeString(selectedBlueprint?.marketGroup);
  const supportedMarket = ['stock', 'stocks', 'equity', 'us_stock', 'us_equity', 'mag7', 'nasdaq100'].includes(marketGroup);
  const isCrypto = /USDT$/i.test(symbol) || marketGroup === 'crypto' || safeString(selectedBlueprint?.assetClass).toUpperCase() === 'CRYPTO';
  const isEtf = ['etf', 'leveraged_etf'].includes(marketGroup) || symbol === 'QQQ' || symbol === 'SPY';
  const isCfd = marketGroup === 'cfd' || safeString(selectedBlueprint?.assetClass).toUpperCase() === 'CFD';
  const marketBlocker = isCrypto
    ? 'crypto_not_allowed_for_ib_paper_first_order'
    : isEtf
      ? 'etf_not_allowed_for_ib_paper_first_order'
      : !marketGroup
        ? 'selected_blueprint_market_group_missing'
        : 'selected_blueprint_unsupported_market_group';
  const manualApproval = tradeBlueprint?.manualApproval || truth?.ibPaper?.manualApproval || null;
  const confirmationInput = safeString(confirmationText);
  const confirmationRequired = safeString(manualApproval?.requiredConfirmationPhrase || REQUIRED_CONFIRMATION_PHRASE);
  const noLivePaths = true;

  return {
    checks: [
      buildCheck('paper_only_mode', SAFETY.mode === 'paper_only', 'hard', 'Läget är paper_only.', 'safety.mode', SAFETY.mode === 'paper_only' ? null : 'paper_only_mode'),
      buildCheck('actions_allowed_false', SAFETY.actions_allowed === false, 'hard', 'actions_allowed är false.', 'safety.actions_allowed', SAFETY.actions_allowed === false ? null : 'actions_allowed_true'),
      buildCheck('can_place_orders_false', SAFETY.can_place_orders === false, 'hard', 'can_place_orders är false.', 'safety.can_place_orders', SAFETY.can_place_orders === false ? null : 'can_place_orders_true'),
      buildCheck('live_trading_disabled', SAFETY.live_trading_enabled === false, 'hard', 'live_trading_enabled är false.', 'safety.live_trading_enabled', SAFETY.live_trading_enabled === false ? null : 'live_trading_enabled_true'),
      buildCheck('broker_disabled', SAFETY.broker_enabled === false, 'hard', 'broker_enabled är false.', 'safety.broker_enabled', SAFETY.broker_enabled === false ? null : 'broker_enabled_true'),
      buildCheck('phase_4a_order_sending_disabled', true, 'info', 'Order sending är fortsatt blockerat i Fas 4A.', 'phase', null),
      buildCheck('no_live_order_path_active', noLivePaths === true, 'info', 'Ingen live-orderväg är aktiv i denna fas.', 'routes/api.js', null),
      buildCheck('live_readiness_available', account.source !== 'stale_truth_fallback', 'hard', account.source !== 'stale_truth_fallback' ? 'Live readiness lästes från connection-readiness.' : 'Live readiness kunde inte läsas.', 'interactiveBrokersPreviewService.getConnectionReadiness', account.source !== 'stale_truth_fallback' ? null : 'live_readiness_unavailable'),
      buildCheck('gateway_reachable', account.gatewayReachable === true, 'hard', account.gatewayReachable === true ? 'Gateway TCP är nåbar.' : 'Gateway TCP är inte nåbar.', 'interactiveBrokersPreviewService.getConnectionReadiness', account.gatewayReachable === true ? null : 'ib_gateway_unreachable'),
      buildCheck('ib_api_verified', account.ibApiVerified === true, 'hard', account.ibApiVerified === true ? 'IB API-sessionen är verifierad.' : 'IB API-sessionen är inte verifierad.', 'interactiveBrokersPreviewService.verifyPaperSession', account.ibApiVerified === true ? null : 'ib_api_not_verified'),
      buildCheck('paper_account_verified', account.paperAccountVerified === true, 'hard', account.paperAccountVerified === true ? 'Paper account är verifierat.' : 'Paper account är inte verifierat.', 'interactiveBrokersPreviewService.verifyPaperSession', account.paperAccountVerified === true ? null : 'paper_account_not_verified'),
      buildCheck('paper_mode_verified', account.paperModeVerified === true, 'hard', account.paperModeVerified === true ? 'Paper mode är verifierat.' : 'Paper mode är inte verifierat.', 'interactiveBrokersPreviewService.verifyPaperSession', account.paperModeVerified === true ? null : 'paper_mode_not_verified'),
      buildCheck('session_verified', account.sessionVerified === true, 'hard', account.sessionVerified === true ? 'Sessionen är verifierad.' : 'Sessionen är inte verifierad.', 'interactiveBrokersPreviewService.verifyPaperSession', account.sessionVerified === true ? null : 'session_not_verified'),
      buildCheck('selected_account_exists', account.selectedAccountExists === true, 'hard', account.selectedAccountExists === true ? 'Selected account finns.' : 'Selected account saknas.', 'readiness.managedAccounts', account.selectedAccountExists === true ? null : 'selected_account_missing'),
      buildCheck('selected_account_matches_paper', account.selectedAccountMatchesPaper === true, 'hard', account.selectedAccountMatchesPaper === true ? 'Selected account matchar paper-kontot.' : 'Selected account matchar inte paper-kontot.', 'readiness.managedAccounts', account.selectedAccountMatchesPaper === true ? null : 'paper_account_mismatch'),
      buildCheck('account_positions_readable', true, 'info', 'Positions/account-läsning är read-only och används som informationssignal i denna fas.', 'executionStatus.openTrades', null),
      buildCheck('open_orders_readable', true, 'info', 'Open orders-läsning är read-only och används som informationssignal i denna fas.', 'executionStatus.openTrades', null),
      buildCheck('selected_blueprint_exists', Boolean(selectedBlueprint), 'hard', selectedBlueprint ? 'Selected blueprint finns.' : 'Selected blueprint saknas.', 'tradeBlueprint.selectedBlueprint', selectedBlueprint ? null : 'missing_blueprint'),
      buildCheck('blueprint_id_valid', Boolean(selectedBlueprint?.blueprintId), 'hard', selectedBlueprint?.blueprintId ? 'BlueprintId är giltigt.' : 'BlueprintId saknas.', 'selectedBlueprint.blueprintId', selectedBlueprint?.blueprintId ? null : 'missing_blueprint'),
      buildCheck('blueprint_not_stale', !isStale, 'hard', !isStale ? 'Blueprint är färsk.' : 'Blueprint har blivit stale.', 'selectedBlueprint.expiresAt', !isStale ? null : 'stale_blueprint'),
      buildCheck('symbol_exists', Boolean(symbol), 'hard', symbol ? `Symbol: ${symbol}` : 'Symbol saknas.', 'selectedBlueprint.symbol', symbol ? null : 'selected_blueprint_symbol_missing'),
      buildCheck('supported_us_equity', Boolean(symbol) && accountMode && supportedMarket && !isCrypto && !isEtf && !isCfd, 'hard', (!isCrypto && !isEtf && !isCfd && supportedMarket && accountMode) ? 'Symbolen är en tillåten US equity.' : 'Symbolen är inte tillåten i Fas 4A.', 'selectedBlueprint.marketGroup', (!isCrypto && !isEtf && !isCfd && supportedMarket && accountMode) ? null : marketBlocker),
      buildCheck('crypto_blocked', !isCrypto, 'hard', !isCrypto ? 'Crypto är blockerat.' : 'Crypto är blockerat i Fas 4A.', 'selectedBlueprint.marketGroup', isCrypto ? 'crypto_not_allowed_for_ib_paper_first_order' : null),
      buildCheck('etf_blocked_phase_1', !isEtf, 'hard', !isEtf ? 'ETF är inte vald.' : 'ETF är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isEtf ? 'etf_not_allowed_for_ib_paper_first_order' : null),
      buildCheck('cfd_blocked_phase_1', !isCfd, 'hard', !isCfd ? 'CFD är inte vald.' : 'CFD är blockerat i denna fas.', 'selectedBlueprint.marketGroup', isCfd ? 'selected_blueprint_unsupported_market_group' : null),
      buildCheck('qqq_blocked', safeString(selectedBlueprint?.symbol) !== 'QQQ', 'hard', safeString(selectedBlueprint?.symbol) !== 'QQQ' ? 'QQQ är inte vald.' : 'QQQ är blockerat i denna fas.', 'selectedBlueprint.symbol', safeString(selectedBlueprint?.symbol) === 'QQQ' ? 'etf_not_allowed_for_ib_paper_first_order' : null),
      buildCheck('strategy_in_top3', strategyInTop3 === true, 'hard', strategyInTop3 === true ? 'Strategin är i top 3.' : 'Strategin är inte i top 3.', 'topStrategies.topStrategies', strategyInTop3 === true ? null : 'not_top_3_strategy'),
      buildCheck('strategy_approved', strategyApproved === true, 'hard', strategyApproved === true ? 'Strategin är godkänd.' : 'Strategin är inte godkänd.', 'tradeBlueprint.blueprints', strategyApproved === true ? null : 'unapproved_strategy'),
      buildCheck('strategy_mapped', Boolean(strategyId), 'hard', strategyId ? 'StrategyId finns.' : 'StrategyId saknas.', 'selectedBlueprint.strategyId', strategyId ? null : 'unmapped_strategy'),
      buildCheck('direction_clear', ['long', 'short'].includes(safeString(selectedBlueprint?.direction)), 'hard', ['long', 'short'].includes(safeString(selectedBlueprint?.direction)) ? 'Riktningen är tydlig.' : 'Riktningen är oklar.', 'selectedBlueprint.direction', ['long', 'short'].includes(safeString(selectedBlueprint?.direction)) ? null : 'unknown_direction'),
      buildCheck('side_resolved', ['BUY', 'SELL'].includes(safeString(selectedBlueprint?.side)), 'hard', ['BUY', 'SELL'].includes(safeString(selectedBlueprint?.side)) ? 'Side är resolvat.' : 'Side kunde inte resolvas.', 'selectedBlueprint.side', ['BUY', 'SELL'].includes(safeString(selectedBlueprint?.side)) ? null : 'selected_blueprint_side_missing'),
      buildCheck('entry_exists', entryReferencePrice > 0, 'hard', entryReferencePrice > 0 ? 'Entry reference price finns.' : 'Entry saknas.', 'selectedBlueprint.entryReferencePrice', entryReferencePrice > 0 ? null : 'selected_blueprint_entry_missing'),
      buildCheck('stop_loss_exists', stopLoss > 0, 'hard', stopLoss > 0 ? 'Stop loss finns.' : 'Stop loss saknas.', 'selectedBlueprint.stopLoss', stopLoss > 0 ? null : 'selected_blueprint_stop_loss_missing'),
      buildCheck('take_profit_exists', takeProfit > 0, 'hard', takeProfit > 0 ? 'Take profit finns.' : 'Take profit saknas.', 'selectedBlueprint.takeProfit', takeProfit > 0 ? null : 'selected_blueprint_take_profit_missing'),
      buildCheck('stop_loss_min_pct_ok', Number.isFinite(stopLossPct) && stopLossPct + 1e-6 >= 0.10, 'hard', Number.isFinite(stopLossPct) && stopLossPct + 1e-6 >= 0.10 ? 'Stop loss är minst 0,10 %.' : 'Stop loss är för liten.', 'selectedBlueprint.stopLossPct', Number.isFinite(stopLossPct) && stopLossPct + 1e-6 >= 0.10 ? null : 'stop_loss_too_small'),
      buildCheck('risk_reward_ok', Number.isFinite(riskReward) && riskReward > 0, 'hard', Number.isFinite(riskReward) && riskReward > 0 ? 'Risk/reward är giltig.' : 'Risk/reward saknas eller är ogiltig.', 'selectedBlueprint.riskReward', Number.isFinite(riskReward) && riskReward > 0 ? null : 'invalid_risk_reward'),
      buildCheck('quantity_calculated', quantityCalculated, 'hard', quantityCalculated ? 'Quantity är kalkylerad.' : 'Quantity saknas.', 'selectedBlueprint.quantityStatus', quantityCalculated ? null : (quantityStatus === 'missing_risk_config' ? 'missing_risk_config' : 'selected_blueprint_quantity_missing')),
      buildCheck('risk_pct_exists', Number.isFinite(riskPct), 'hard', Number.isFinite(riskPct) ? 'riskPct finns.' : 'riskPct saknas.', 'selectedBlueprint.riskPct', Number.isFinite(riskPct) ? null : 'missing_risk_config'),
      buildCheck('risk_amount_exists', riskAmount != null || quantityCalculated, 'info', riskAmount != null ? 'riskAmount finns.' : 'riskAmount saknas men är tillåtet som läsbar preflight i Fas 4A.', 'selectedBlueprint.riskAmount', null),
      buildCheck('estimated_notional_exists', Number(selectedBlueprint?.estimatedNotional || 0) > 0, 'info', Number(selectedBlueprint?.estimatedNotional || 0) > 0 ? 'estimatedNotional finns.' : 'estimatedNotional saknas.', 'selectedBlueprint.estimatedNotional', null),
      ...buildExecutionGateChecks({ selectedBlueprint, executionStatus }),
      buildCheck('manual_confirmation_phrase', confirmationInput === confirmationRequired, 'hard', confirmationInput === confirmationRequired ? 'Bekräftelsefrasen matchar.' : 'Bekräftelsefrasen saknas eller matchar inte.', 'request.confirmationPhrase', confirmationInput === confirmationRequired ? null : (confirmationInput ? 'manual_confirmation_mismatch' : 'manual_confirmation_required')),
      buildCheck('manual_approval_status_ready', ['waiting_for_user', 'ready_for_future_execution', 'preflight_accepted'].includes(safeString(manualApproval?.approvalStatus)), 'hard', ['waiting_for_user', 'ready_for_future_execution', 'preflight_accepted'].includes(safeString(manualApproval?.approvalStatus)) ? `approvalStatus=${manualApproval?.approvalStatus || 'unknown'}` : 'approvalStatus är inte redo.', 'tradeBlueprint.manualApproval', ['waiting_for_user', 'ready_for_future_execution', 'preflight_accepted'].includes(safeString(manualApproval?.approvalStatus)) ? null : 'manual_approval_not_ready'),
      buildCheck('user_confirmation_present', confirmationInput === confirmationRequired, 'info', confirmationInput === confirmationRequired ? 'User confirmation finns.' : 'User confirmation saknas.', 'request.confirmationPhrase', null),
      buildCheck('post_auth_respected', true, 'info', 'Eventuell POST-auth kontrolleras av befintlig router-/middleware-konfiguration.', 'routes/api.js', null),
      buildCheck('execution_feature_disabled_phase_4a', true, 'info', 'Execution-funktionen är fortsatt avstängd i Fas 4A.', 'interactiveBrokersPaperExecutionService', null),
      buildCheck('no_place_order_called', true, 'info', 'placeOrder anropas inte i preflight.', 'interactiveBrokersPaperPreflightService', null),
      buildCheck('no_submit_order_called', true, 'info', 'submitOrder anropas inte i preflight.', 'interactiveBrokersPaperPreflightService', null),
      buildCheck('transmit_never_true', true, 'info', 'transmit sätts aldrig till true i preflight.', 'interactiveBrokersPaperPreflightService', null),
      buildCheck('order_sent_false', true, 'info', 'orderSent är false i preflight.', 'interactiveBrokersPaperPreflightService', null),
      buildCheck('executed_false', true, 'info', 'executed är false i preflight.', 'interactiveBrokersPaperPreflightService', null),
    ],
    account,
    topStrategies: topStrategies.slice(0, 3),
    paperReadyTop3Count: paperReadyTop3.length,
    manualApproval,
    confirmationText: confirmationInput,
    stale: isStale,
    quantityCalculated,
    topStrategyIds,
  };
}

async function buildPaperExecutionPreflight(options = {}) {
  const now = options.now || new Date();
  const truth = options.truth || await paperTradingTruthService.buildPaperTradingTruth({ now });
  const tradeBlueprint = options.tradeBlueprint || truth?.ibPaper?.tradeBlueprint || null;
  const executionStatus = options.executionStatus || truth?.ibPaper?.executionStatus || null;
  const staleReadiness = options.readiness || truth?.ibPaper?.connectionReadiness || truth?.ibPaper?.readiness || executionStatus?.readiness || null;
  const readiness = options.liveReadinessSnapshot || (!options.liveReadiness && staleReadiness?.source === 'live_connection_readiness' ? staleReadiness : await interactiveBrokersPaperReadinessLoaderService.loadLiveIbPaperReadinessForPreflight({
    expectedAccount: options.expectedAccount || EXPECTED_PAPER_ACCOUNT,
    selectedAccount: options.selectedAccount,
    staleReadiness,
    liveReadiness: options.liveReadiness,
    getConnectionReadiness: options.getConnectionReadiness,
  }));
  const protectivePreflight = options.protectivePreflight || interactiveBrokersPaperProtectiveOrderService.buildProtectivePreflightResponse({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    blueprintId: options.blueprintId || options.selectedBlueprintId || null,
    selectedBlueprint: options.selectedBlueprint || null,
  });
  const normalizedBlueprintVerification = buildIbPaperSelectedBlueprintForPreflight({
    truth,
    tradeBlueprint,
    protectivePreflight,
    preview: options.preview || truth?.ibPaper?.preview || null,
    scaffold: options.scaffold || truth?.ibPaper?.scaffold || null,
    expectedAccount: options.expectedAccount || EXPECTED_PAPER_ACCOUNT,
  });
  const selectedBlueprint = normalizedBlueprintVerification.selectedBlueprint || null;
  const requestedConfirmation = safeString(options.confirmationPhrase || options.confirmationText || options.confirmText || '');

  const { checks, account, topStrategies, paperReadyTop3Count, manualApproval } = buildBlueprintChecks({
    selectedBlueprint,
    truth,
    tradeBlueprint,
    readiness,
    executionStatus,
    confirmationText: requestedConfirmation,
    now,
  });

  const hardFailedChecks = checks.filter((check) => check.ok !== true && check.severity === 'hard');
  const passedChecks = checks.filter((check) => check.ok === true).length;
  const failedHardChecks = hardFailedChecks.length;
  const blockers = [...new Set(hardFailedChecks.map((check) => check.blocker || check.code).filter(Boolean))];
  const accepted = requestedConfirmation === REQUIRED_CONFIRMATION_PHRASE && blockers.length === 0 && Boolean(selectedBlueprint);
  const readyForFirstPaperOrder = accepted;
  const blockedReason = blockers[0] || null;
  const protectivePlan = protectivePreflight;
  const bracketSubmission = interactiveBrokersPaperBracketSubmissionService.buildBracketSubmissionPreflight({
    now,
    truth,
    executionStatus,
    tradeBlueprint,
    readiness,
    selectedBlueprint,
    protectivePlan: protectivePlan.summary ? {
      protectivePathAvailable: protectivePlan.protectivePathAvailable === true,
      protectivePlanReady: protectivePlan.protectivePlanReady === true,
      orderModelVerified: protectivePlan.orderModelVerified === true,
      contractVerified: protectivePlan.contractVerified === true,
      blockedReason: protectivePlan.blockedReason || null,
      blockers: safeArray(protectivePlan.blockers),
      warnings: safeArray(protectivePlan.warnings),
      plan: protectivePlan.plan || null,
      summary: protectivePlan.summary || null,
      selectedBlueprint: protectivePlan.selectedBlueprint || selectedBlueprint || null,
      account: protectivePlan.account || null,
      readinessVerification: protectivePlan.readinessVerification || null,
      checks: safeArray(protectivePlan.checks),
    } : protectivePlan,
    nextValidId: readiness?.nextValidId ?? executionStatus?.readiness?.nextValidId ?? null,
  });
  const nextRequiredAction = readyForFirstPaperOrder
    ? 'Fas 4B kräver separat explicit godkännande innan någon IB Paper-order skickas.'
    : (blockers.length > 0
      ? `Åtgärda blockerarna och kör preflight igen. Första blocker: ${blockers[0]}.`
      : 'Kör preflight med exakt CONFIRM PAPER TRADE.');
  const selectedBlueprintSummary = selectedBlueprint ? {
    blueprintId: selectedBlueprint.blueprintId || null,
    candidateId: selectedBlueprint.candidateId || null,
    symbol: selectedBlueprint.symbol || null,
    strategyId: selectedBlueprint.strategyId || null,
    strategyName: selectedBlueprint.strategyName || null,
    top3Rank: selectedBlueprint.top3Rank || null,
    top3Source: selectedBlueprint.top3Source || null,
    direction: selectedBlueprint.direction || null,
    side: selectedBlueprint.side || null,
    entryType: selectedBlueprint.entryType || null,
    entryReferencePrice: selectedBlueprint.entryReferencePrice ?? null,
    stopLoss: selectedBlueprint.stopLoss ?? null,
    takeProfit: selectedBlueprint.takeProfit ?? null,
    takeProfit1: selectedBlueprint.takeProfit1 ?? null,
    takeProfit2: selectedBlueprint.takeProfit2 ?? null,
    riskReward: selectedBlueprint.riskReward ?? null,
    stopLossPct: selectedBlueprint.stopLossPct ?? null,
    minStopLossPct: selectedBlueprint.minStopLossPct ?? null,
    riskPct: selectedBlueprint.riskPct ?? null,
    riskAmount: selectedBlueprint.riskAmount ?? null,
    quantity: selectedBlueprint.quantity ?? null,
    quantityStatus: selectedBlueprint.quantityStatus || null,
    estimatedNotional: selectedBlueprint.estimatedNotional ?? null,
    currency: selectedBlueprint.currency || null,
    accountMode: selectedBlueprint.accountMode || 'ib_paper',
    marketGroup: selectedBlueprint.marketGroup || null,
    assetClass: selectedBlueprint.assetClass || null,
    exchange: selectedBlueprint.exchange || null,
    currency: selectedBlueprint.currency || null,
    tif: selectedBlueprint.tif || selectedBlueprint.timeInForce || null,
    orderType: selectedBlueprint.orderType || null,
    timeInForce: selectedBlueprint.timeInForce || null,
    readiness: selectedBlueprint.readiness || null,
    blueprintReady: selectedBlueprint.blueprintReady === true,
    manualApprovalReady: selectedBlueprint.manualApprovalReady === true,
    executionReady: false,
    blockers: safeArray(selectedBlueprint.blockers),
    warnings: safeArray(selectedBlueprint.warnings),
    blockedReason,
    wouldCreateOrder: false,
    wouldSendOrder: false,
    requiresManualApproval: true,
    orderSendingBlocked: true,
    safety: { ...SAFETY },
  } : null;

  const response = {
    ok: true,
    mode: 'paper_only',
    phase: 'preflight_only',
    preflightOnly: true,
    dryRun: true,
    accepted,
    readyForFirstPaperOrder,
    wouldSendOrder: false,
    orderSent: false,
    executed: false,
    executionReady: false,
    orderSendingBlocked: true,
    blockedReason,
    nextRequiredAction,
    selectedBlueprint: selectedBlueprintSummary,
    account,
    checks,
    blockers,
    warnings: checks.filter((check) => check.ok === true && (check.severity === 'warning' || check.severity === 'info')).map((check) => check.code),
    manualApproval,
    summary: {
      totalChecks: checks.length,
      passedChecks,
      failedHardChecks,
      warningChecks: checks.filter((check) => check.severity === 'warning').length,
      readyForFirstPaperOrder,
      blockedReason,
      top3ReadyCount: paperReadyTop3Count,
    },
    protectivePathAvailable: protectivePlan.protectivePathAvailable === true,
    protectivePlanReady: protectivePlan.protectivePlanReady === true,
    protectiveOrderChecks: protectivePlan.checks,
    protectiveOrderPlan: protectivePlan.plan,
    protectiveBlockers: protectivePlan.blockers,
    protectiveWarnings: protectivePlan.warnings,
    protectiveSummary: protectivePlan.summary,
    protectiveAccount: protectivePlan.account,
    protectiveOrderModelVerified: protectivePlan.orderModelVerified === true,
    protectiveNextRequiredAction: protectivePlan.nextRequiredAction,
    bracketSubmissionPlanReady: bracketSubmission.bracketSubmissionPlanReady === true,
    bracketSubmissionRealSubmitEnabled: bracketSubmission.bracketSubmissionRealSubmitEnabled === true,
    bracketOrderCount: bracketSubmission.orderCount || 0,
    entryOnlyBlocked: bracketSubmission.entryOnlyBlocked === true,
    bracketBlockedReason: bracketSubmission.blockedReason || null,
    userMessageSv: bracketSubmission.userMessageSv || null,
    orderButtonLocked: bracketSubmission.orderButtonLocked === true,
    bracketSubmissionPlan: bracketSubmission.submissionPlan || null,
    bracketSummary: bracketSubmission.summary || null,
    bracketChecks: bracketSubmission.checks || [],
    bracketNextRequiredAction: bracketSubmission.nextRequiredAction || null,
    uiStatus: bracketSubmission.uiStatus || null,
    readinessSource: readiness.source || null,
    liveReadinessLoaded: readiness.liveReadinessLoaded === true || readiness.source === 'live_connection_readiness',
    staleTruthUsed: readiness.staleTruthUsed === true || readiness.source === 'stale_truth_fallback',
    selectedBlueprintVerification: {
      ...normalizedBlueprintVerification,
      source: normalizedBlueprintVerification.source,
      selectedBlueprint: normalizedBlueprintVerification.selectedBlueprint,
      blockersFromBlueprint: normalizedBlueprintVerification.blockersFromBlueprint,
    },
    sessionVerification: account,
    readinessVerification: account,
    safety: { ...SAFETY },
    truth,
    tradeBlueprint,
    executionStatus,
    requestedConfirmationPhrase: requestedConfirmation || null,
    confirmationRequiredPhrase: REQUIRED_CONFIRMATION_PHRASE,
  };

  return response;
}

module.exports = {
  SAFETY,
  REQUIRED_CONFIRMATION_PHRASE,
  maskPaperAccountId,
  buildPaperExecutionPreflight,
  _internal: {
    safeString,
    safeArray,
    safeIso,
    buildCheck,
    normalizeBlueprintList,
    resolveBlueprint,
    normalizeMarketGroup,
    normalizePreflightQuantity,
    normalizeStopLossPct,
    normalizeRiskReward,
    buildNormalizedSelectedBlueprint,
    buildIbPaperSelectedBlueprintForPreflight,
    buildAccountStatus,
    buildIbPaperReadOnlySessionVerificationSnapshot,
    buildExecutionGateChecks,
    buildBlueprintChecks,
  },
};
