const REQUIRED_ACCOUNT = 'DUQ565596';
const REQUIRED_ACCOUNT_MODE = 'ib_paper';
const REQUIRED_STOP_LOSS_MIN_PCT = 0.10;
const ETF_SYMBOLS = new Set(['QQQ', 'SPY', 'IWM', 'DIA', 'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'UVXY']);
const STOCK_MARKET_GROUPS = new Set(['stock', 'stocks', 'equity', 'equities', 'us_stock', 'us_stocks', 'us_equity', 'us_equities', 'mag7', 'nasdaq100']);

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeUpper(value) {
  return safeString(value).toUpperCase();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function inferMarketGroup(symbol, candidate = {}) {
  const normalizedSymbol = safeUpper(symbol || candidate.symbol);
  const rawMarketGroup = safeLower(candidate.marketGroup || candidate.market_group || candidate.group || candidate.market || candidate.marketType || candidate.assetClass || candidate.secType);
  const rawAssetClass = safeUpper(candidate.assetClass || candidate.secType || candidate.securityType);
  if (/USDT$/i.test(normalizedSymbol) || rawMarketGroup === 'crypto' || rawAssetClass === 'CRYPTO') return 'crypto';
  if (rawMarketGroup === 'etf' || rawMarketGroup === 'etfs' || rawMarketGroup === 'leveraged_etf' || rawMarketGroup === 'leveraged_etfs' || ETF_SYMBOLS.has(normalizedSymbol)) return 'etf';
  if (rawMarketGroup === 'cfd' || rawAssetClass === 'CFD') return 'cfd';
  if (STOCK_MARKET_GROUPS.has(rawMarketGroup) || rawAssetClass === 'STK') return 'stock';
  if (!rawMarketGroup && /^[A-Z]{1,5}([.-][A-Z])?$/.test(normalizedSymbol)) return 'stock';
  return rawMarketGroup || null;
}

function computeRiskFields(candidate = {}) {
  const entryPrice = safeNumber(candidate.entryPrice ?? candidate.entryReferencePrice ?? candidate.entry ?? candidate.plannedEntry ?? candidate.limitPrice ?? candidate.currentPrice);
  const stopLoss = safeNumber(candidate.stopLoss ?? candidate.stopLossPrice ?? candidate.stop ?? candidate.sl);
  const takeProfit = safeNumber(candidate.takeProfit ?? candidate.takeProfit1 ?? candidate.tp ?? candidate.tp1 ?? candidate.target ?? candidate.targetPrice);
  const explicitStopLossPct = safeNumber(candidate.stopLossPct ?? candidate.stopLossDistancePct);
  const explicitRiskReward = safeNumber(candidate.riskReward ?? candidate.riskRewardRatio);
  const stopLossPct = explicitStopLossPct && explicitStopLossPct > 0
    ? round(explicitStopLossPct, 4)
    : (entryPrice > 0 && stopLoss > 0 ? round((Math.abs(entryPrice - stopLoss) / entryPrice) * 100, 4) : null);
  const riskReward = explicitRiskReward && explicitRiskReward > 0
    ? round(explicitRiskReward, 2)
    : (entryPrice > 0 && stopLoss > 0 && takeProfit > 0 && Math.abs(stopLoss - entryPrice) > 0
      ? round(Math.abs(takeProfit - entryPrice) / Math.abs(stopLoss - entryPrice), 2)
      : null);
  return { entryPrice, stopLoss, takeProfit, stopLossPct, riskReward };
}

function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return false;
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= new Date(now).getTime();
}

function normalizeBlueprintCandidate(candidate, { fallbackAccount = REQUIRED_ACCOUNT } = {}) {
  if (!candidate) return null;

  const symbol = safeUpper(candidate.symbol);
  const strategyId = safeString(candidate.strategyId);
  const strategyName = safeString(candidate.strategyName || strategyId || 'Unknown strategy');
  const side = safeUpper(
    candidate.side
    || (safeString(candidate.direction).toLowerCase() === 'short' ? 'SELL' : safeString(candidate.direction).toLowerCase() === 'long' ? 'BUY' : '')
  );
  const quantity = safeNumber(candidate.quantity);
  const { entryPrice, stopLoss, takeProfit, stopLossPct, riskReward } = computeRiskFields(candidate);
  const accountMode = safeString(candidate.accountMode || REQUIRED_ACCOUNT_MODE).toLowerCase() || REQUIRED_ACCOUNT_MODE;
  const account = safeString(candidate.account || fallbackAccount || REQUIRED_ACCOUNT);
  const blueprintId = safeString(candidate.blueprintId || candidate.candidateId || (symbol && strategyId ? `${symbol}:${strategyId}` : ''));
  const marketGroup = inferMarketGroup(symbol, candidate);
  const assetClass = marketGroup === 'crypto' ? 'CRYPTO' : marketGroup === 'etf' ? 'ETF' : marketGroup === 'cfd' ? 'CFD' : 'STK';
  const secType = marketGroup === 'cfd' ? 'CFD' : 'STK';
  const exchange = marketGroup === 'crypto' ? safeUpper(candidate.exchange) || null : safeUpper(candidate.exchange || 'SMART') || 'SMART';
  const currency = safeUpper(candidate.currency || 'USD') || 'USD';
  const primaryExchange = safeUpper(candidate.primaryExchange || 'NASDAQ') || 'NASDAQ';

  const complete = Boolean(
    blueprintId
    && symbol
    && strategyId
    && ['BUY', 'SELL'].includes(side)
    && Number.isFinite(quantity) && quantity > 0
    && Number.isFinite(entryPrice)
    && Number.isFinite(stopLoss)
    && Number.isFinite(takeProfit)
    && marketGroup
    && accountMode === REQUIRED_ACCOUNT_MODE
    && account === REQUIRED_ACCOUNT
  );

  if (!complete) return null;

  return {
    blueprintId,
    candidateId: safeString(candidate.candidateId) || null,
    symbol,
    strategyId,
    strategyName,
    side,
    quantity,
    entryPrice,
    stopLoss,
    takeProfit,
    marketGroup,
    assetClass,
    secType,
    currency,
    exchange,
    primaryExchange,
    stopLossPct,
    riskReward,
    accountMode,
    account,
    direction: safeString(candidate.direction || (side === 'SELL' ? 'short' : 'long')) || null,
    entryReferencePrice: entryPrice,
    takeProfit1: takeProfit,
    takeProfit2: safeNumber(candidate.takeProfit2),
    riskPct: safeNumber(candidate.riskPct),
    riskAmount: safeNumber(candidate.riskAmount),
    expiresAt: safeString(candidate.expiresAt) || null,
    blueprintReady: candidate.blueprintReady === true || candidate.readyForFutureIbPaper === true,
    manualApprovalReady: candidate.manualApprovalReady === true,
    executionReady: candidate.executionReady === true,
    source: safeString(candidate.source) || null,
  };
}

function pickCandidate(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeBlueprintCandidate(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function extractTradeBlueprintCandidate(tradeBlueprint) {
  if (!tradeBlueprint) return null;
  return pickCandidate(
    tradeBlueprint.selectedBlueprint,
    tradeBlueprint.manualApproval?.selectedBlueprint,
    Array.isArray(tradeBlueprint.blueprints)
      ? tradeBlueprint.blueprints.find((row) => row?.selected === true || row?.manualApprovalReady === true || row?.blueprintReady === true)
      : null,
    Array.isArray(tradeBlueprint.blueprints) ? tradeBlueprint.blueprints[0] : null,
  );
}

function extractProtectiveCandidate(protectivePreflight) {
  if (!protectivePreflight) return null;
  return pickCandidate(
    protectivePreflight.selectedBlueprint,
    protectivePreflight.plan?.selectedBlueprint,
    protectivePreflight.protectiveOrderPlan?.selectedBlueprint,
    protectivePreflight.bracketSubmissionPlan?.selectedBlueprint,
    {
      ...(protectivePreflight.plan || {}),
      account: protectivePreflight.account?.paperAccountId || protectivePreflight.account?.paperAccountIdMasked || REQUIRED_ACCOUNT,
    },
  );
}

function extractPaperPreflightCandidate(paperPreflightResult) {
  if (!paperPreflightResult) return null;
  return pickCandidate(
    paperPreflightResult.selectedBlueprint,
    paperPreflightResult.manualApproval?.selectedBlueprint,
  );
}

function extractPreviewScaffoldCandidate(preview, scaffold) {
  return pickCandidate(
    preview?.selectedBlueprint,
    preview?.primaryCandidate,
    preview?.topCandidate,
    preview?.candidates?.[0],
    preview?.approvedStrategies?.[0],
    scaffold?.primaryCandidate,
    scaffold?.selectedBlueprint,
    scaffold?.candidateBlueprints?.[0],
  );
}

function isManualReadyTradeBlueprint(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const blockers = new Set(Array.isArray(candidate.blockers) ? candidate.blockers : []);
  const blueprintId = safeString(candidate.blueprintId);
  const side = safeUpper(
    candidate.side
    || (safeString(candidate.direction).toLowerCase() === 'short' ? 'SELL' : safeString(candidate.direction).toLowerCase() === 'long' ? 'BUY' : '')
  );
  const quantity = safeNumber(candidate.quantity);
  const stopLossPct = safeNumber(candidate.stopLossPct ?? candidate.stopLossDistancePct);
  const accountMode = safeString(candidate.accountMode || REQUIRED_ACCOUNT_MODE).toLowerCase();
  return Boolean(
    blueprintId
    && candidate.blueprintReady === true
    && candidate.manualApprovalReady === true
    && accountMode === REQUIRED_ACCOUNT_MODE
    && ['BUY', 'SELL'].includes(side)
    && Number.isFinite(quantity) && quantity > 0
    && Number.isFinite(stopLossPct) && stopLossPct >= REQUIRED_STOP_LOSS_MIN_PCT
    && !blockers.has('not_top_3_strategy')
    && !blockers.has('stop_loss_too_small')
  );
}

function resolveStableSelectedIbPaperBlueprint({
  tradeBlueprint = null,
  canonicalTruth = null,
  preview = null,
  scaffold = null,
  paperPreflightResult = null,
  protectivePreflight = null,
  lastStableSelectedBlueprint = null,
  tradeBlueprintLoadStatus = 'idle',
  tradeBlueprintLoadError = null,
  now = new Date(),
} = {}) {
  const truthCandidate = pickCandidate(
    canonicalTruth?.ibPaper?.selectedBlueprint,
    canonicalTruth?.ibPaper?.manualApproval?.selectedBlueprint,
    canonicalTruth?.ibPaper?.tradeBlueprint?.selectedBlueprint,
  );
  const tradeBlueprintCandidate = extractTradeBlueprintCandidate(tradeBlueprint);
  const paperPreflightCandidate = extractPaperPreflightCandidate(paperPreflightResult);
  const protectiveCandidate = extractProtectiveCandidate(protectivePreflight);
  const previewCandidate = extractPreviewScaffoldCandidate(preview, scaffold);
  const lastStableCandidate = normalizeBlueprintCandidate(lastStableSelectedBlueprint);

  const currentTruth = truthCandidate || null;
  const protectiveMatchesCurrentTruth = protectiveCandidate
    && (!currentTruth
      || (safeString(protectiveCandidate.symbol) === safeString(currentTruth.symbol)
        && safeString(protectiveCandidate.strategyId) === safeString(currentTruth.strategyId)
        && safeUpper(protectiveCandidate.side) === safeUpper(currentTruth.side)
        && Number(protectiveCandidate.quantity || 0) === Number(currentTruth.quantity || 0)
        && Number(protectiveCandidate.entryPrice || 0) === Number(currentTruth.entryPrice || 0)
        && Number(protectiveCandidate.stopLoss || 0) === Number(currentTruth.stopLoss || 0)
        && Number(protectiveCandidate.takeProfit || 0) === Number(currentTruth.takeProfit || 0)));

  const lastStableMatchesCurrent = lastStableCandidate
    && !isExpired(lastStableCandidate.expiresAt, now)
    && (!currentTruth
      || (safeString(lastStableCandidate.symbol) === safeString(currentTruth.symbol)
        && safeString(lastStableCandidate.strategyId) === safeString(currentTruth.strategyId)
        && safeUpper(lastStableCandidate.side) === safeUpper(currentTruth.side)
        && Number(lastStableCandidate.quantity || 0) === Number(currentTruth.quantity || 0)
        && Number(lastStableCandidate.entryPrice || 0) === Number(currentTruth.entryPrice || 0)
        && Number(lastStableCandidate.stopLoss || 0) === Number(currentTruth.stopLoss || 0)
        && Number(lastStableCandidate.takeProfit || 0) === Number(currentTruth.takeProfit || 0)));

  let source = 'none';
  let blueprint = null;
  let safetyStatus = 'blocked';
  let selectedBlueprintId = null;
  let idempotencyKey = null;
  let blockers = [];
  let safeForBracketPreview = false;

  const tradeBlueprintAvailable = Boolean(tradeBlueprintCandidate);
  const tradeBlueprintReady = Boolean(
    tradeBlueprint?.selectedBlueprint?.blueprintReady === true
    && tradeBlueprint?.selectedBlueprint?.manualApprovalReady === true
  );

  if (tradeBlueprintAvailable) {
    source = 'trade_blueprint';
    blueprint = normalizeBlueprintCandidate(tradeBlueprint?.selectedBlueprint || tradeBlueprintCandidate);
    selectedBlueprintId = blueprint?.blueprintId || null;
    safeForBracketPreview = Boolean(blueprint);
    safetyStatus = tradeBlueprintReady ? 'manual_ready' : 'blocked';
    blockers = tradeBlueprintReady ? [] : ['selected_blueprint_not_manual_ready'];
  } else if (protectiveCandidate && protectiveMatchesCurrentTruth) {
    source = 'protective_preflight';
    blueprint = protectiveCandidate;
    safetyStatus = 'preview_only';
    selectedBlueprintId = blueprint?.blueprintId || null;
    safeForBracketPreview = Boolean(blueprint);
    blockers = ['selected_blueprint_fallback_not_safe_for_submit'];
  } else if (paperPreflightCandidate) {
    source = 'paper_preflight';
    blueprint = paperPreflightCandidate;
    safetyStatus = 'preview_only';
    selectedBlueprintId = blueprint?.blueprintId || null;
    safeForBracketPreview = Boolean(blueprint);
  } else if (previewCandidate) {
    source = 'preview_scaffold';
    blueprint = previewCandidate;
    safetyStatus = 'preview_only';
    selectedBlueprintId = blueprint?.blueprintId || null;
    safeForBracketPreview = Boolean(blueprint);
  } else if (lastStableMatchesCurrent) {
    source = 'last_stable';
    blueprint = lastStableCandidate;
    safetyStatus = 'preview_only';
    selectedBlueprintId = blueprint?.blueprintId || null;
    safeForBracketPreview = Boolean(blueprint);
  }

  const safeForDisplay = Boolean(blueprint);
  const safeForArm = tradeBlueprintReady === true;
  const safeForSubmit = false;
  const isFallback = safeForDisplay && source !== 'trade_blueprint';
  if (!safeForDisplay) {
    safetyStatus = 'blocked';
  }

  return {
    source,
    blueprint,
    isFallback,
    safeForDisplay,
    safeForBracketPreview,
    safeForArm,
    safeForSubmit,
    safetyStatus,
    blockedReason: blockers[0] || null,
    blockers,
    selectedBlueprintId,
    idempotencyKey,
    tradeBlueprintLoadStatus,
    tradeBlueprintLoadError,
    loadStatus: tradeBlueprintLoadStatus,
    loadError: tradeBlueprintLoadError,
    displayLabel: blueprint ? `${blueprint.symbol} · ${blueprint.strategyName || blueprint.strategyId}` : 'none',
  };
}

export {
  REQUIRED_ACCOUNT,
  REQUIRED_ACCOUNT_MODE,
  normalizeBlueprintCandidate,
  resolveStableSelectedIbPaperBlueprint,
};

export default {
  REQUIRED_ACCOUNT,
  REQUIRED_ACCOUNT_MODE,
  normalizeBlueprintCandidate,
  resolveStableSelectedIbPaperBlueprint,
};
