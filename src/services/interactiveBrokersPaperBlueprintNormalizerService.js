'use strict';

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const REQUIRED_STOP_LOSS_MIN_PCT = 0.10;
const STOCK_MARKET_GROUPS = new Set(['stock', 'stocks', 'equity', 'equities', 'us_stock', 'us_stocks', 'us_equity', 'us_equities', 'mag7', 'nasdaq100']);
const ETF_SYMBOLS = new Set(['QQQ', 'SPY', 'IWM', 'DIA', 'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'UVXY']);
const ETF_MARKET_GROUPS = new Set(['etf', 'etfs', 'leveraged_etf', 'leveraged_etfs']);
const NASDAQ_PRIMARY_SYMBOLS = new Set(['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'META', 'AMZN', 'NFLX', 'GOOGL', 'GOOG', 'QQQ']);

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

function firstNumber(...values) {
  for (const value of values) {
    const n = safeNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function normalizeSide(input = {}) {
  const raw = safeUpper(input.side || input.action);
  if (raw === 'BUY' || raw === 'SELL') return raw;
  const direction = safeLower(input.direction || input.tradeDirection || input.bias);
  if (['long', 'buy', 'up'].includes(direction)) return 'BUY';
  if (['short', 'sell', 'down'].includes(direction)) return 'SELL';
  return null;
}

function inferMarketGroupForIbPaperSymbol(symbol, input = {}) {
  const normalizedSymbol = safeUpper(symbol || input.symbol || input.ticker);
  const rawMarketGroup = safeLower(input.marketGroup || input.market_group || input.group || input.market || input.marketType || input.assetClass || input.secType);
  const rawAssetClass = safeUpper(input.assetClass || input.securityType || input.secType);

  if (/USDT$/i.test(normalizedSymbol) || rawMarketGroup === 'crypto' || rawAssetClass === 'CRYPTO') {
    return 'crypto';
  }
  if (ETF_MARKET_GROUPS.has(rawMarketGroup) || ETF_SYMBOLS.has(normalizedSymbol)) {
    return 'etf';
  }
  if (rawMarketGroup === 'cfd' || rawAssetClass === 'CFD') {
    return 'cfd';
  }
  if (STOCK_MARKET_GROUPS.has(rawMarketGroup) || rawAssetClass === 'STK') {
    return 'stock';
  }
  if (!rawMarketGroup && /^[A-Z]{1,5}([.-][A-Z])?$/.test(normalizedSymbol)) {
    return 'stock';
  }
  return rawMarketGroup || null;
}

function normalizeIbPaperContractFields(symbol, marketGroup, input = {}) {
  const normalizedSymbol = safeUpper(symbol || input.symbol);
  const normalizedMarketGroup = safeLower(marketGroup);
  if (normalizedMarketGroup === 'crypto') {
    return {
      assetClass: 'CRYPTO',
      secType: safeUpper(input.secType) || 'CRYPTO',
      currency: safeUpper(input.currency || 'USD') || 'USD',
      exchange: safeUpper(input.exchange) || null,
      primaryExchange: safeUpper(input.primaryExchange) || null,
    };
  }
  if (normalizedMarketGroup === 'cfd') {
    return {
      assetClass: 'CFD',
      secType: 'CFD',
      currency: safeUpper(input.currency || 'USD') || 'USD',
      exchange: safeUpper(input.exchange || 'SMART') || 'SMART',
      primaryExchange: safeUpper(input.primaryExchange) || null,
    };
  }
  return {
    assetClass: normalizedMarketGroup === 'etf' ? 'ETF' : 'STK',
    secType: 'STK',
    currency: safeUpper(input.currency || 'USD') || 'USD',
    exchange: safeUpper(input.exchange || 'SMART') || 'SMART',
    primaryExchange: safeUpper(input.primaryExchange || (NASDAQ_PRIMARY_SYMBOLS.has(normalizedSymbol) ? 'NASDAQ' : 'NASDAQ')) || 'NASDAQ',
  };
}

function computeIbPaperRiskFields(input = {}) {
  const entryPrice = firstNumber(input.entryPrice, input.entryReferencePrice, input.entry, input.plannedEntry, input.limitPrice, input.currentPrice, input.price);
  const stopLoss = firstNumber(input.stopLoss, input.stopLossPrice, input.stop, input.sl);
  const takeProfit = firstNumber(input.takeProfit, input.takeProfit1, input.tp, input.tp1, input.target, input.targetPrice);
  const explicitStopLossPct = safeNumber(input.stopLossPct ?? input.stopLossDistancePct);
  const explicitRiskReward = safeNumber(input.riskReward ?? input.riskRewardRatio);
  const stopLossPct = explicitStopLossPct && explicitStopLossPct > 0
    ? round(explicitStopLossPct, 4)
    : (entryPrice > 0 && stopLoss > 0 ? round((Math.abs(entryPrice - stopLoss) / entryPrice) * 100, 4) : null);
  const riskReward = explicitRiskReward && explicitRiskReward > 0
    ? round(explicitRiskReward, 2)
    : (entryPrice > 0 && stopLoss > 0 && takeProfit > 0 && Math.abs(stopLoss - entryPrice) > 0
      ? round(Math.abs(takeProfit - entryPrice) / Math.abs(stopLoss - entryPrice), 2)
      : null);
  return {
    entryPrice,
    entryReferencePrice: entryPrice,
    stopLoss,
    stopLossPrice: stopLoss,
    takeProfit,
    takeProfit1: takeProfit,
    stopLossPct,
    riskReward,
    riskRewardRatio: riskReward,
  };
}

function buildMissingBlocker(field) {
  return `selected_blueprint_${field}_missing`;
}

function normalizeIbPaperSelectedBlueprint(input, options = {}) {
  const source = safeString(input?.source || options.source || 'trade_blueprint') || 'trade_blueprint';
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      validForPreflight: false,
      selectedBlueprint: null,
      source,
      fallback: source === 'last_stable',
      missingFields: ['selected_blueprint'],
      blockers: ['selected_blueprint_missing'],
      safety: { ...SAFETY },
    };
  }

  const symbol = safeUpper(input.symbol || input.ticker);
  const strategyId = safeString(input.strategyId || input.canonicalStrategyId);
  const strategyName = safeString(input.strategyName || input.name || strategyId || 'Unknown strategy');
  const side = normalizeSide(input);
  const direction = safeLower(input.direction || (side === 'SELL' ? 'short' : side === 'BUY' ? 'long' : ''));
  const quantity = firstNumber(input.quantity, input.shares, input.calculatedQuantity, input.orderQuantity);
  const risk = computeIbPaperRiskFields(input);
  const marketGroup = inferMarketGroupForIbPaperSymbol(symbol, input);
  const contract = normalizeIbPaperContractFields(symbol, marketGroup, input);
  const accountMode = safeLower(input.accountMode || options.accountMode || 'ib_paper') || 'ib_paper';
  const account = safeString(input.account || options.account || options.expectedAccount || 'DUQ565596') || 'DUQ565596';
  const quantityStatus = safeString(input.quantityStatus || (quantity > 0 ? 'calculated' : 'missing_quantity')) || (quantity > 0 ? 'calculated' : 'missing_quantity');

  const missingFields = [];
  if (!symbol) missingFields.push('symbol');
  if (!side) missingFields.push('side');
  if (!(quantity > 0)) missingFields.push('quantity');
  if (!(risk.entryPrice > 0)) missingFields.push('entry');
  if (!(risk.stopLoss > 0)) missingFields.push('stop_loss');
  if (!(risk.takeProfit > 0)) missingFields.push('take_profit');
  if (!marketGroup) missingFields.push('market_group');

  const blockers = missingFields.map(buildMissingBlocker);
  if (marketGroup === 'crypto') blockers.push('crypto_not_allowed_for_ib_paper_first_order');
  if (marketGroup === 'etf') blockers.push('etf_not_allowed_for_ib_paper_first_order');
  if (marketGroup && !['stock', 'crypto', 'etf', 'cfd'].includes(marketGroup)) blockers.push('selected_blueprint_unsupported_market_group');
  if (marketGroup === 'cfd') blockers.push('selected_blueprint_unsupported_market_group');
  if (!(risk.stopLossPct != null && risk.stopLossPct + 1e-6 >= REQUIRED_STOP_LOSS_MIN_PCT)) blockers.push('stop_loss_too_small');
  if (!(risk.riskReward != null && risk.riskReward > 0)) blockers.push('invalid_risk_reward');

  const normalized = {
    ...input,
    blueprintId: safeString(input.blueprintId || input.candidateId || (symbol && strategyId ? `${symbol}:${strategyId}` : '')) || null,
    candidateId: safeString(input.candidateId || input.eventId || input.id) || null,
    symbol: symbol || null,
    strategyId: strategyId || null,
    strategyName,
    direction: direction || null,
    side: side || null,
    quantity: quantity ?? null,
    accountMode,
    account,
    marketGroup,
    assetClass: contract.assetClass,
    secType: contract.secType,
    currency: contract.currency,
    exchange: contract.exchange,
    primaryExchange: contract.primaryExchange,
    ...risk,
    riskPct: safeNumber(input.riskPct),
    riskAmount: safeNumber(input.riskAmount),
    estimatedNotional: safeNumber(input.estimatedNotional),
    quantityStatus,
    quantityCalculated: quantity > 0 && quantityStatus === 'calculated',
    orderType: safeUpper(input.orderType || 'LMT') || 'LMT',
    timeInForce: safeUpper(input.timeInForce || input.tif || 'DAY') || 'DAY',
    tif: safeUpper(input.tif || input.timeInForce || 'DAY') || 'DAY',
    source,
    fallback: source === 'last_stable',
    safety: input.safety || { ...SAFETY },
  };

  const validForPreflight = blockers.length === 0 && accountMode === 'ib_paper';
  return {
    ...normalized,
    ok: validForPreflight,
    validForPreflight,
    selectedBlueprint: normalized,
    missingFields,
    blockers: [...new Set(blockers)],
    normalizationWarnings: [],
    fallback: source === 'last_stable',
  };
}

module.exports = {
  SAFETY,
  REQUIRED_STOP_LOSS_MIN_PCT,
  inferMarketGroupForIbPaperSymbol,
  normalizeIbPaperContractFields,
  computeIbPaperRiskFields,
  normalizeIbPaperSelectedBlueprint,
  _internal: {
    safeString,
    safeUpper,
    safeLower,
    safeNumber,
    round,
    normalizeSide,
    buildMissingBlocker,
  },
};
