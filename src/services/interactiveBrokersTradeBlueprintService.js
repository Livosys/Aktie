'use strict';

/**
 * IB Paper Trade Blueprint
 *
 * Read-only planning layer that turns existing IB preview candidates into a
 * theoretical trade blueprint. It never places orders, never queues orders,
 * never opens a broker connection and never changes safety state.
 */

const interactiveBrokersPreviewService = require('./interactiveBrokersPreviewService');
const interactiveBrokersPaperBlueprintNormalizerService = require('./interactiveBrokersPaperBlueprintNormalizerService');
const interactiveBrokersPaperMultiStrategyConfigService = require('./interactiveBrokersPaperMultiStrategyConfigService');
const { getLatestResults } = require('../scanner/scheduler');
const redisService = require('./redisService');
const riskEngineService = require('./riskEngineService');
const crypto = require('crypto');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const REQUIRED_STOP_LOSS_MIN_PCT = 0.10;
const ORDER_SENDING_BLOCKED_REASON = 'blueprint_only_no_execution';

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function safeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function selectManualReadyIbPaperBlueprint(tradeBlueprintResponse = {}) {
  const blueprints = Array.isArray(tradeBlueprintResponse?.blueprints) ? tradeBlueprintResponse.blueprints : [];
  const selected = blueprints.find((row) => {
    const blueprintId = safeString(row?.blueprintId);
    const accountMode = safeString(row?.accountMode || 'ib_paper').toLowerCase();
    const side = safeUpper(row?.side || (safeString(row?.direction).toLowerCase() === 'short' ? 'SELL' : safeString(row?.direction).toLowerCase() === 'long' ? 'BUY' : ''));
    const quantity = safeNumber(row?.quantity);
    const stopLossPct = safeNumber(row?.stopLossPct ?? row?.stopLossDistancePct);
    const blockers = Array.isArray(row?.blockers) ? row.blockers : [];
    const top3Rank = Number(row?.top3Rank || 0) || null;
    return Boolean(
      blueprintId
      && row?.blueprintReady === true
      && row?.manualApprovalReady === true
      && accountMode === 'ib_paper'
      && ['BUY', 'SELL'].includes(side)
      && Number.isFinite(quantity) && quantity > 0
      && Number.isFinite(stopLossPct) && stopLossPct >= REQUIRED_STOP_LOSS_MIN_PCT
      && !blockers.includes('not_top_3_strategy')
      && !blockers.includes('stop_loss_too_small')
      && (top3Rank === null || top3Rank <= 3)
    );
  }) || null;

  if (!selected) {
    return {
      selectedBlueprint: null,
      selectedBlueprintId: null,
      selectedBlueprintSource: null,
      safeForDisplay: false,
      safeForBracketPreview: false,
      safeForArm: false,
      safeForSubmit: false,
      safetyStatus: 'blocked',
      fallback: false,
      blockedReason: 'no_manual_ready_trade_blueprint',
      blockers: ['no_manual_ready_trade_blueprint'],
      idempotencyKey: null,
    };
  }

  return {
    selectedBlueprint: selected,
    selectedBlueprintId: selected.blueprintId || null,
    selectedBlueprintSource: 'trade_blueprint',
    safeForDisplay: true,
    safeForBracketPreview: true,
    safeForArm: true,
    safeForSubmit: false,
    safetyStatus: 'manual_ready',
    fallback: false,
    blockedReason: null,
    blockers: [],
    idempotencyKey: null,
  };
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function addMinutes(now, minutes) {
  return new Date(new Date(now).getTime() + (Number(minutes) || 0) * 60_000).toISOString();
}

async function buildPriceIndex(options = {}) {
  const index = new Map();
  const rows = Array.isArray(options.marketResults)
    ? options.marketResults
    : Array.isArray(getLatestResults())
      ? getLatestResults()
      : [];

  for (const row of rows) {
    const symbol = safeUpper(row?.symbol);
    const price = safeNumber(
      row?.currentPrice
      ?? row?.price
      ?? row?.lastPrice
      ?? row?.close
      ?? row?.c
      ?? row?.entryPrice,
    );
    if (symbol && price != null && price > 0) {
      index.set(symbol, price);
    }
  }

  for (const [symbol, price] of Object.entries(options.priceIndex || {})) {
    const normalized = safeUpper(symbol);
    const numeric = safeNumber(price);
    if (normalized && numeric != null && numeric > 0) {
      index.set(normalized, numeric);
    }
  }

  if (options.skipRedis !== true) {
    const persistedSources = [
      ['prices:stocks:latest', 'prices'],
      ['scan:stocks:latest', 'results'],
      ['prices:nasdaq:latest', 'prices'],
      ['scan:nasdaq:latest', 'results'],
    ];
    for (const [key, field] of persistedSources) {
      try {
        const payload = await redisService.getJson(key, null);
        const sourceRows = field === 'prices'
          ? Object.entries(payload?.prices || {}).map(([symbol, price]) => ({ symbol, price }))
          : Array.isArray(payload?.results)
            ? payload.results
            : [];
        for (const row of sourceRows) {
          const symbol = safeUpper(row?.symbol);
          const price = safeNumber(
            row?.currentPrice
            ?? row?.price
            ?? row?.lastPrice
            ?? row?.close
            ?? row?.c
            ?? row?.entryPrice,
          );
          if (symbol && price != null && price > 0) {
            index.set(symbol, price);
          }
        }
      } catch (_) {
        // Read-only fallback: ignore cache read failures.
      }
    }
  }

  return index;
}

function resolveCurrentPrice(candidate, priceIndex) {
  const symbol = safeUpper(candidate?.symbol);
  const direct = safeNumber(
    candidate?.currentPrice
    ?? candidate?.price
    ?? candidate?.lastPrice
    ?? candidate?.entryPrice,
  );
  if (direct != null && direct > 0) return direct;
  if (symbol && priceIndex.has(symbol)) return priceIndex.get(symbol);
  return null;
}

function classifyMarket(candidate = {}) {
  const marketGroup = safeLower(candidate.marketGroup || candidate.market_group || candidate.group);
  const symbol = safeUpper(candidate.symbol);
  return {
    isCrypto: marketGroup === 'crypto',
    isEtf: marketGroup === 'etf' || marketGroup === 'leveraged_etf',
    isCfd: marketGroup === 'cfd',
    isQqq: symbol === 'QQQ',
    isKnown: Boolean(marketGroup),
  };
}

function buildQuantityDetails({ entryReferencePrice, stopLossPct, riskConfig, direction, estimatedNotionalFallback = null }) {
  if (!riskConfig || typeof riskConfig !== 'object') {
    return {
      quantity: null,
      quantityStatus: 'missing_risk_config',
      riskPct: null,
      riskAmount: null,
      riskAmountCurrency: 'SEK',
      estimatedNotional: estimatedNotionalFallback,
      warnings: ['missing_risk_config'],
      quantityBlockers: ['missing_risk_config'],
    };
  }
  if (!(entryReferencePrice > 0)) {
    return {
      quantity: null,
      quantityStatus: 'missing_entry',
      riskPct: Number(riskConfig.risk_per_trade_pct) || null,
      riskAmount: null,
      riskAmountCurrency: 'SEK',
      estimatedNotional: null,
      warnings: ['missing_entry'],
      quantityBlockers: ['missing_entry'],
    };
  }
  if (!(stopLossPct > 0)) {
    return {
      quantity: null,
      quantityStatus: 'missing_stop_loss',
      riskPct: Number(riskConfig.risk_per_trade_pct) || null,
      riskAmount: null,
      riskAmountCurrency: 'SEK',
      estimatedNotional: null,
      warnings: ['missing_stop_loss'],
      quantityBlockers: ['missing_stop_loss'],
    };
  }

  let sizing = null;
  try {
    sizing = riskEngineService.calculatePositionSize(
      {
        symbol: 'IB_PAPER',
        price: entryReferencePrice,
        stop_loss_pct: stopLossPct,
        target_pct: stopLossPct * 2,
        direction,
      },
      {
        balance: riskConfig.account_balance,
        equity: riskConfig.account_balance,
        daily_trades: 0,
        consecutive_losses: 0,
        open_positions: [],
        _riskConfig: riskConfig,
      },
      riskConfig,
    );
  } catch (_) {
    sizing = null;
  }

  const units = Number(sizing?.position_size_units);
  const quantity = Number.isFinite(units) && units > 0 ? Math.max(1, Math.floor(units)) : null;
  const quantityStatus = quantity ? 'calculated' : 'blocked';
  const estimatedNotional = quantity ? round(quantity * entryReferencePrice, 2) : estimatedNotionalFallback;

  return {
    quantity,
    quantityStatus,
    riskPct: Number(riskConfig.risk_per_trade_pct) || null,
    riskAmount: sizing?.risk_amount_sek ?? null,
    riskAmountCurrency: 'SEK',
    estimatedNotional,
    warnings: Array.isArray(sizing?.warnings) ? sizing.warnings : [],
    quantityBlockers: quantity ? [] : ['missing_quantity'],
  };
}

function buildExecutionDisabledBlockers(readinessProfile = {}) {
  const blockers = ['ib_paper_execution_disabled', 'order_sending_disabled_phase_3'];
  if (readinessProfile.gatewayReachable !== true) blockers.push('ib_gateway_unreachable');
  if (readinessProfile.paperPortConfigured !== true) blockers.push('not_paper_mode_or_wrong_port');
  if (readinessProfile.ibApiVerified !== true) blockers.push('ib_api_not_verified');
  if (readinessProfile.paperAccountVerified !== true) blockers.push('paper_account_not_verified');
  return [...new Set(blockers)];
}

function buildBlueprint(candidate = {}, priceIndex, context = {}) {
  const now = context.now || new Date();
  const createdAt = nowIso(now);
  const expiresAt = addMinutes(now, 10);
  const staleAfterSeconds = 600;
  const symbol = safeUpper(candidate.symbol) || null;
  const strategyId = String(candidate.strategyId || candidate.canonicalStrategyId || '').trim() || null;
  const strategyName = String(candidate.strategyName || strategyId || 'Unknown strategy').trim();
  const direction = safeLower(candidate.direction);
  const market = classifyMarket(candidate);
  const currentPrice = resolveCurrentPrice(candidate, priceIndex);
  const approvedIndex = context.approvedIndex || null;
  const readinessProfile = context.readinessProfile || {};
  const topStrategyIds = Array.isArray(context.topStrategyIds) ? context.topStrategyIds : [];
  const topStrategyOrder = Array.isArray(context.topStrategyOrder) ? context.topStrategyOrder : topStrategyIds;
  const strategyApproved = Boolean(approvedIndex?.approved?.has(strategyId));
  const inTop3 = topStrategyIds.length === 0 ? true : topStrategyIds.includes(strategyId);
  const top3Rank = inTop3 && strategyId
    ? (Number(context.topStrategyRanks?.[strategyId]) || (topStrategyOrder.indexOf(strategyId) >= 0 ? topStrategyOrder.indexOf(strategyId) + 1 : null))
    : null;
  const entryReferencePrice = currentPrice > 0 ? round(currentPrice, 2) : null;
  const stopLossPrice = entryReferencePrice && direction === 'long'
    ? round(entryReferencePrice * 0.999, 2)
    : entryReferencePrice && direction === 'short'
      ? round(entryReferencePrice * 1.001, 2)
      : null;
  const takeProfit1 = entryReferencePrice && direction === 'long'
    ? round(entryReferencePrice * 1.002, 2)
    : entryReferencePrice && direction === 'short'
      ? round(entryReferencePrice * 0.998, 2)
      : null;
  const takeProfit2 = entryReferencePrice && direction === 'long'
    ? round(entryReferencePrice * 1.004, 2)
    : entryReferencePrice && direction === 'short'
      ? round(entryReferencePrice * 0.996, 2)
      : null;
  const stopLossPct = entryReferencePrice && stopLossPrice
    ? round((Math.abs(entryReferencePrice - stopLossPrice) / entryReferencePrice) * 100, 4)
    : null;
  const riskReward = entryReferencePrice && stopLossPrice && takeProfit1
    ? round(Math.abs(takeProfit1 - entryReferencePrice) / Math.abs(entryReferencePrice - stopLossPrice), 2)
    : null;
  const marketGroup = interactiveBrokersPaperBlueprintNormalizerService.inferMarketGroupForIbPaperSymbol(symbol, candidate);
  const contractFields = interactiveBrokersPaperBlueprintNormalizerService.normalizeIbPaperContractFields(symbol, marketGroup, candidate);

  // Multi-strategy test mode (default OFF -> unchanged). When ON, the legacy
  // "first IB Paper order" one-shot lock (not_top_3) is relaxed for planning, and
  // ETF/QQQ may be allowed when INCLUDE_ETF=true. Crypto stays blocked. None of
  // this enables submit — manualApprovalReady/blueprintReady gates are unchanged.
  const multi = context.multiStrategy || interactiveBrokersPaperMultiStrategyConfigService.getIbPaperMultiStrategyConfig();
  const multiEnabled = multi.enabled === true;
  const etfAllowed = multiEnabled && multi.includeEtf === true;

  const previewBlockers = [];
  if (!strategyId) previewBlockers.push('unmapped_strategy');
  if (!strategyApproved) previewBlockers.push('unapproved_strategy');
  if (!inTop3 && !multiEnabled) previewBlockers.push('not_top_3_strategy');
  if (direction !== 'long' && direction !== 'short') previewBlockers.push('unknown_direction');
  if (marketGroup === 'crypto') previewBlockers.push('crypto_not_allowed_for_ib_paper_first_order');
  if (marketGroup === 'etf' && !etfAllowed) previewBlockers.push('etf_not_allowed_for_ib_paper_first_order');
  if (marketGroup === 'cfd') previewBlockers.push('selected_blueprint_unsupported_market_group');
  if (marketGroup && !['stock', 'crypto', 'etf', 'cfd'].includes(marketGroup)) previewBlockers.push('selected_blueprint_unsupported_market_group');
  if (!(entryReferencePrice > 0)) previewBlockers.push('missing_entry');
  if (!(stopLossPrice > 0)) previewBlockers.push('missing_stop_loss');
  if (!(takeProfit1 > 0)) previewBlockers.push('missing_take_profit');
  if (stopLossPct != null && stopLossPct < REQUIRED_STOP_LOSS_MIN_PCT) previewBlockers.push('stop_loss_too_small');
  if (!(riskReward > 0)) previewBlockers.push('invalid_risk_reward');

  const quantityDetails = buildQuantityDetails({
    entryReferencePrice,
    stopLossPct,
    riskConfig: context.riskConfig || null,
    direction,
    estimatedNotionalFallback: entryReferencePrice ? round(entryReferencePrice, 2) : null,
  });
  const quantity = quantityDetails.quantity;
  const quantityStatus = quantityDetails.quantityStatus;
  const quantityBlockers = quantityDetails.quantityBlockers || [];
  const riskPct = quantityDetails.riskPct;
  const riskAmount = quantityDetails.riskAmount;
  const estimatedNotional = quantityDetails.estimatedNotional;
  const warnings = [...new Set([
    ...quantityDetails.warnings,
    quantityDetails.quantityStatus === 'calculated' ? null : quantityDetails.quantityStatus,
  ].filter(Boolean))];

  const blueprintReady = previewBlockers.length === 0;
  const manualApprovalReady = blueprintReady && quantityStatus === 'calculated';
  const executionBlockers = [...new Set([
    ...previewBlockers,
    ...quantityBlockers,
    ...buildExecutionDisabledBlockers(readinessProfile),
  ].filter(Boolean))];
  const executionReady = false;

  const readiness = blueprintReady
    ? (manualApprovalReady ? 'manual_approval_ready' : 'blueprint_ready')
    : 'blocked';
  const blockers = [...new Set([...previewBlockers, ...executionBlockers])];
  const blockedReason = blockers[0] || null;
  const readyForFutureIbPaper = blueprintReady;
  const side = direction === 'short' ? 'SELL' : direction === 'long' ? 'BUY' : null;
  const actionLabelSv = direction === 'short' ? 'Kort' : direction === 'long' ? 'Lång' : 'Okänd';
  const blueprintId = String(candidate.blueprintId || `ibpb_${stableHash(`${symbol || 'unknown'}:${strategyId || 'unknown'}:${createdAt}`).slice(0, 16)}`);
  const candidateId = String(candidate.candidateId || candidate.eventId || candidate.id || `${symbol || 'unknown'}:${strategyId || 'unknown'}`);
  const accountMode = 'ib_paper';
  const orderType = 'LMT';
  const timeInForce = 'DAY';

  return {
    blueprintId,
    candidateId,
    createdAt,
    expiresAt,
    staleAfterSeconds,
    symbol,
    marketGroup,
    assetClass: contractFields.assetClass,
    secType: contractFields.secType,
    exchange: contractFields.exchange,
    primaryExchange: contractFields.primaryExchange,
    strategyId,
    strategyName,
    top3Rank,
    top3Source: context.top3Source || 'interactiveBrokersPreviewService.getIbPaperOrderPreview',
    direction: direction || 'unknown',
    currentPrice: entryReferencePrice,
    side,
    actionLabelSv,
    entryType: 'limit',
    entryReferencePrice,
    entryPrice: entryReferencePrice,
    stopLoss: stopLossPrice,
    stopLossPrice,
    stopLossPct,
    minStopLossPct: REQUIRED_STOP_LOSS_MIN_PCT,
    stopLossDistancePct: stopLossPct,
    takeProfit: takeProfit1,
    takeProfit1,
    takeProfit2,
    riskReward,
    riskRewardRatio: riskReward,
    requiredStopLossMinPct: REQUIRED_STOP_LOSS_MIN_PCT,
    riskPct,
    riskAmount,
    riskAmountCurrency: quantityDetails.riskAmountCurrency,
    quantity,
    quantityStatus,
    estimatedNotional,
    currency: contractFields.currency || 'USD',
    accountMode,
    orderType,
    timeInForce,
    blueprintReady,
    manualApprovalReady,
    executionReady,
    readiness,
    readyForFutureIbPaper,
    wouldCreateOrder: false,
    wouldSendOrder: false,
    orderSendingBlocked: true,
    requiresManualApproval: true,
    blueprintOnly: true,
    executionEnabled: false,
    orderQueueEnabled: false,
    brokerExecutionEnabled: false,
    liveTradingEnabled: false,
    blockedReason,
    blockers,
    warnings,
    approvedForPaperTesting: candidate.approvedForPaperTesting === true,
    previewOnly: true,
    safety: { ...SAFETY },
    createdFrom: context.source || 'interactiveBrokersPreviewService.getIbPaperOrderPreview',
  };
}

async function getTradeBlueprint(options = {}) {
  let riskConfig = null;
  try {
    riskConfig = options.riskConfig || await riskEngineService.getRiskConfig();
  } catch (_) {
    riskConfig = null;
  }
  let readiness = null;
  try {
    readiness = options.readiness || await interactiveBrokersPreviewService.getConnectionReadiness();
  } catch (_) {
    readiness = null;
  }
  const orderPreview = options.orderPreview || interactiveBrokersPreviewService.getIbPaperOrderPreview({
    candidates: options.candidates,
    now: options.now,
  });
  const priceIndex = await buildPriceIndex(options);
  const topStrategies = Array.isArray(options.topStrategies?.topStrategies) ? options.topStrategies.topStrategies : [];
  const topStrategyIds = topStrategies.map((row) => row?.strategyId).filter(Boolean);
  const topStrategyRanks = Object.fromEntries(topStrategies.map((row) => [row.strategyId, row.rank]));
  const allowedCandidates = Array.isArray(orderPreview?.allowedCandidates)
    ? orderPreview.allowedCandidates
    : Array.isArray(orderPreview?.candidates)
      ? orderPreview.candidates.filter((candidate) => candidate?.allowedForIbPaperPreview === true)
    : [];
  const approvedIndex = interactiveBrokersPreviewService._internal.buildApprovedStrategyIndex();
  const blueprints = allowedCandidates.map((candidate) => buildBlueprint(candidate, priceIndex, {
    now: options.now || new Date(),
    riskConfig,
    approvedIndex,
    readinessProfile: readiness,
    topStrategyIds,
    topStrategyOrder: topStrategyIds,
    topStrategyRanks,
    top3Source: options.top3Source || 'paperTradingTruthService.buildTopStrategySelector',
    source: 'interactiveBrokersTradeBlueprintService.getTradeBlueprint',
  }));
  const blueprintReadyCount = blueprints.filter((row) => row.blueprintReady === true).length;
  const manualApprovalReadyCount = blueprints.filter((row) => row.manualApprovalReady === true).length;
  const executionReadyCount = blueprints.filter((row) => row.executionReady === true).length;
  const readyCount = blueprintReadyCount;
  const blockedCount = blueprints.length - blueprintReadyCount;
  const selectedBlueprint = blueprints.find((row) => row.manualApprovalReady === true)
    || blueprints.find((row) => row.blueprintReady === true)
    || blueprints[0]
    || null;
  const manualReadySelection = selectManualReadyIbPaperBlueprint({ blueprints });
  const canonicalSelectedBlueprint = manualReadySelection.selectedBlueprint;
  const pendingBlueprints = blueprints.filter((row) => row.blueprintReady === true);

  return {
    ok: true,
    dryRun: true,
    mode: 'trade_blueprint',
    executionEnabled: false,
    orderQueueEnabled: false,
    brokerExecutionEnabled: false,
    liveTradingEnabled: false,
    orderSendingBlocked: true,
    wouldCreateOrder: false,
    requiredStopLossMinPct: REQUIRED_STOP_LOSS_MIN_PCT,
    safety: { ...SAFETY },
    readiness,
    connectionReadiness: readiness,
    readinessVerified: Boolean(readiness?.gatewayReachable === true && readiness?.ibApiVerified === true && readiness?.paperAccountVerified === true),
    orderPreview,
    blueprints,
    blueprintsCount: blueprints.length,
    selectedBlueprint: canonicalSelectedBlueprint,
    selectedBlueprintId: canonicalSelectedBlueprint?.blueprintId || null,
    selectedBlueprintSource: canonicalSelectedBlueprint ? 'trade_blueprint' : null,
    selectedBlueprintSafety: manualReadySelection,
    previewBlueprint: selectedBlueprint,
    previewBlueprintId: selectedBlueprint?.blueprintId || null,
    previewBlueprintSource: selectedBlueprint ? 'interactiveBrokersTradeBlueprintService.getTradeBlueprint' : null,
    manualApproval: {
      requiredConfirmationPhrase: 'CONFIRM PAPER TRADE',
      confirmationEntered: false,
      approvalStatus: canonicalSelectedBlueprint
        ? 'waiting_for_user'
        : (blueprints.length > 0 ? 'blocked' : 'not_available'),
      blockers: canonicalSelectedBlueprint?.blockers || [],
      warnings: canonicalSelectedBlueprint?.warnings || [],
      createdAt: canonicalSelectedBlueprint?.createdAt || null,
      expiresAt: canonicalSelectedBlueprint?.expiresAt || null,
      pendingBlueprints,
      selectedBlueprint: canonicalSelectedBlueprint,
      safety: { ...SAFETY },
    },
    summary: {
      totalCandidates: blueprints.length,
    readyCount,
    blockedCount,
    blueprintReadyCount,
    manualApprovalReadyCount,
    executionReadyCount,
      readinessVerified: Boolean(readiness?.ibApiVerified === true && readiness?.paperAccountVerified === true),
      approvedStrategyCount: Number(orderPreview?.source?.approvedStrategyCount ?? 0),
      allowedCandidateCount: Array.isArray(orderPreview?.allowedCandidates) ? orderPreview.allowedCandidates.length : 0,
      priceSource: Array.isArray(options.marketResults) ? 'injected_market_results' : 'scanner.getLatestResults',
      candidateSource: 'interactiveBrokersPreviewService.getIbPaperOrderPreview',
    },
    source: {
      candidateSource: 'interactiveBrokersPreviewService.getIbPaperOrderPreview',
      priceSource: Array.isArray(options.marketResults) ? 'injected_market_results' : 'scanner.getLatestResults',
      safety: { ...SAFETY },
    },
    note: 'Trade Blueprint is read-only. No order is created or sent. Execution remains blocked.',
  };
}

module.exports = {
  SAFETY,
  REQUIRED_STOP_LOSS_MIN_PCT,
  getTradeBlueprint,
  _internal: {
    safeUpper,
    safeLower,
    safeNumber,
    round,
    stableHash,
    nowIso,
    addMinutes,
    buildPriceIndex,
    resolveCurrentPrice,
    classifyMarket,
    buildQuantityDetails,
    buildBlueprint,
    selectManualReadyIbPaperBlueprint,
  },
};
