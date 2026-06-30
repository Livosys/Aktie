'use strict';

/**
 * IB Paper Multi-Strategy Test Plan (READ-ONLY).
 *
 * Purpose: describe what "IB Paper Multi-Strategy Test Mode" allows, and classify
 * the current IB Paper candidates as allowed/blocked under the mode's guards.
 *
 * Hard guarantees:
 *   - This module NEVER sends, arms, cancels, or queues an order. It calls no
 *     placeOrder/cancelOrder and opens no broker connection.
 *   - It does NOT touch internal paper trading (paperTradingAgent /
 *     paperTradingRuntimeService).
 *   - It only reuses already-fetched read-only IB Paper data (trade-blueprint +
 *     execution-status + paper-readonly-state + config) and reports a plan.
 *   - The mode is gated OFF by default via IB_PAPER_MULTI_STRATEGY_TEST_MODE and
 *     submit stays gated by the independent IB_PAPER_SUBMIT_ROUTES_ENABLED hard
 *     gate. Neither flag is changed here.
 */

const configService = require('./interactiveBrokersPaperMultiStrategyConfigService');
const directionResolverService = require('./interactiveBrokersDirectionResolverService');
const assetToggleService = require('./interactiveBrokersPaperPreviewAssetToggleService');

const MODE = 'ib_paper_multi_strategy_test_plan';
const MODE_FLAG = configService.MODE_FLAG;
const SUBMIT_ROUTES_FLAG = configService.SUBMIT_ROUTES_FLAG;
const ETF_FLAG = configService.ETF_FLAG;
const DEFAULT_ACCOUNT = 'DUQ565596';

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

// Reported limits (kept for back-compat with consumers reading DEFAULT_LIMITS).
const DEFAULT_LIMITS = configService.DEFAULT_LIMITS;

function safeUpper(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function safeLower(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function firstNumberWithSource(candidates = []) {
  for (const [source, value] of candidates) {
    const numeric = toNumber(value);
    if (numeric != null && numeric > 0) return { value: numeric, source };
  }
  return { value: null, source: null };
}

function sideFor(blueprint) {
  if (blueprint?.side) return safeUpper(blueprint.side);
  const dirUpper = safeUpper(blueprint?.direction);
  if (dirUpper === 'BUY' || dirUpper === 'SELL') return dirUpper;
  const dir = safeLower(blueprint?.direction);
  if (dir === 'short') return 'SELL';
  if (dir === 'long') return 'BUY';
  return null;
}

// Legacy "first IB Paper order" one-shot lock blockers that are relaxed *for
// planning* under multi-strategy mode. These are NOT safety blockers.
const RELAXABLE_BLOCKERS = new Set(['not_top_3_strategy']);
const ETF_BLOCKERS = new Set([
  'etf_not_allowed_for_ib_paper_first_order',
  'qqq_not_allowed_for_ib_paper_first_order',
]);
const CRYPTO_BLOCKERS = new Set([
  'crypto_not_allowed_for_ib_paper_first_order',
]);

function normalizeBlocker(blocker) {
  const raw = String(blocker || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;
  if (raw === 'direction_not_verified' || lower.includes('riktningen kunde inte verifieras')) return 'direction_not_verified';
  if (raw === 'unknown_market_group' || lower.includes('okänd marknadsgrupp')) return 'unknown_market_group';
  if (raw === 'symbol_missing' || lower.includes('saknar symbol')) return 'symbol_missing';
  if (raw === 'qqq_etf_blocked') return raw;
  if (raw === 'crypto_blocked') return raw;
  if (ETF_BLOCKERS.has(raw) || CRYPTO_BLOCKERS.has(raw)) return raw;
  if (lower.includes('qqq') || lower.includes('etf')) return 'qqq_etf_blocked';
  if (lower.includes('krypto') || lower.includes('crypto')) return 'crypto_blocked';
  if (lower.includes('strategin är inte godkänd') || lower.includes('allowlist')) return 'strategy_not_approved';
  return raw;
}

function candidateKey(row = {}) {
  return [
    safeUpper(row.symbol),
    String(row.strategyId || row.strategy_id || '').trim(),
    safeUpper(row.side || row.direction),
  ].join('|');
}

function normalizePreviewCandidate(candidate = {}) {
  const rawBlockers = toArray(candidate.blockers || candidate.multiStrategyBlockers)
    .map(normalizeBlocker)
    .filter(Boolean);
  const symbol = safeUpper(candidate.symbol);
  const normalizedSymbol = symbol && symbol !== '–' && symbol !== '-' ? symbol : null;
  return {
    ...candidate,
    symbol: normalizedSymbol,
    strategyId: candidate.strategyId || candidate.strategy_id || null,
    strategyName: candidate.strategyName || candidate.strategy_name || candidate.strategyId || null,
    direction: candidate.normalizedDirection || candidate.direction || null,
    side: sideFor(candidate),
    blockers: rawBlockers,
    marketGroup: candidate.normalizedMarketGroup || candidate.marketGroup || null,
    market_group: candidate.normalizedMarketGroup || candidate.marketGroup || null,
    rawSource: candidate.source || 'preview_order_candidate',
    source: candidate.source || 'preview_order_candidate',
    directionSource: candidate.directionSource || null,
    directionConfidence: candidate.directionConfidence || null,
    rawDirectionFields: candidate.rawDirectionFields || {},
    normalizedDirection: candidate.normalizedDirection || null,
    directionAmbiguous: candidate.directionAmbiguous === true,
    previewCandidate: true,
    previewAllowed: candidate.allowedForIbPaperPreview === true,
    price: candidate.price ?? null,
    currentPrice: candidate.currentPrice ?? null,
    entryPrice: candidate.entryPrice ?? null,
    entryReferencePrice: candidate.entryReferencePrice ?? null,
    stopLoss: candidate.stopLoss ?? candidate.stopLossPrice ?? null,
    takeProfit: candidate.takeProfit ?? candidate.takeProfit1 ?? null,
    stopLossPct: candidate.stopLossPct ?? candidate.stop_loss_pct ?? null,
    takeProfitPct: candidate.takeProfitPct ?? candidate.take_profit_pct ?? null,
  };
}

function isCryptoCandidate(blueprint) {
  const group = safeLower(blueprint?.marketGroup || blueprint?.market_group || blueprint?.group);
  if (group === 'crypto') return true;
  const symbol = safeUpper(blueprint?.symbol);
  if (symbol.endsWith('USDT') || symbol.endsWith('USDC')) return true;
  return toArray(blueprint?.blockers).some((b) => CRYPTO_BLOCKERS.has(String(b)));
}

function buildBracketDiagnostics(blueprint, side, config = {}) {
  const entry = firstNumberWithSource([
    ['entryReferencePrice', blueprint?.entryReferencePrice],
    ['entryPrice', blueprint?.entryPrice],
    ['currentPrice', blueprint?.currentPrice],
    ['price', blueprint?.price],
    ['lastPrice', blueprint?.lastPrice],
  ]);
  const explicitStop = firstNumberWithSource([
    ['stopLoss', blueprint?.stopLoss],
    ['stopLossPrice', blueprint?.stopLossPrice],
  ]);
  const explicitTake = firstNumberWithSource([
    ['takeProfit', blueprint?.takeProfit],
    ['takeProfit1', blueprint?.takeProfit1],
  ]);
  const stopPct = firstNumberWithSource([
    ['stopLossPct', blueprint?.stopLossPct],
    ['stopLossDistancePct', blueprint?.stopLossDistancePct],
  ]);
  const takePct = firstNumberWithSource([
    ['takeProfitPct', blueprint?.takeProfitPct],
    ['takeProfitDistancePct', blueprint?.takeProfitDistancePct],
  ]);

  let stop = explicitStop.value;
  let stopSource = explicitStop.source;
  let take = explicitTake.value;
  let takeSource = explicitTake.source;
  if (!(stop > 0) && entry.value > 0 && stopPct.value > 0 && (side === 'BUY' || side === 'SELL')) {
    stop = side === 'BUY'
      ? round(entry.value * (1 - (stopPct.value / 100)), 2)
      : round(entry.value * (1 + (stopPct.value / 100)), 2);
    stopSource = stopPct.source;
  }
  if (!(take > 0) && entry.value > 0 && takePct.value > 0 && (side === 'BUY' || side === 'SELL')) {
    take = side === 'BUY'
      ? round(entry.value * (1 + (takePct.value / 100)), 2)
      : round(entry.value * (1 - (takePct.value / 100)), 2);
    takeSource = takePct.source;
  }

  const blockers = [];
  if (!(entry.value > 0)) blockers.push('missing_entry_price');
  if (!(stop > 0)) blockers.push('missing_stop_loss');
  if (!(take > 0)) blockers.push('missing_take_profit');
  const minStopLossPct = toNumber(config.minStopLossPct ?? 0.10);
  const actualStopLossPct = entry.value > 0 && stop > 0
    ? round((Math.abs(entry.value - stop) / entry.value) * 100, 4)
    : stopPct.value;
  if (actualStopLossPct != null && minStopLossPct != null && actualStopLossPct + 1e-6 < minStopLossPct) {
    blockers.push('stop_loss_too_small');
  }

  return {
    bracketReady: blockers.length === 0,
    hasBracket: blockers.length === 0,
    bracketSource: blockers.length === 0 ? 'candidate_fields' : null,
    entryReferencePrice: entry.value,
    entryPriceSource: entry.source,
    stopLoss: stop,
    stopLossSource: stopSource,
    takeProfit: take,
    takeProfitSource: takeSource,
    stopLossPct: actualStopLossPct,
    bracketBlockers: [...new Set(blockers)],
  };
}

function hasBracket(blueprint) {
  return buildBracketDiagnostics(blueprint, sideFor(blueprint)).bracketReady === true;
}

// Build the set of "symbol|strategyId|side" keys that were traded within the
// duplicate-guard window. Sources are read-only IB Paper history rows.
function buildDuplicateKeySet(rows, windowMinutes, now) {
  const cutoff = new Date(now).getTime() - (Number(windowMinutes) || 0) * 60_000;
  const keys = new Set();
  for (const row of toArray(rows)) {
    const ts = row?.openedAt || row?.opened_at || row?.timestamp || row?.time || row?.closedAt;
    const t = ts ? new Date(ts).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    const symbol = safeUpper(row?.symbol);
    const strategyId = String(row?.strategyId || row?.strategy_id || '').trim();
    const side = sideFor(row);
    if (symbol && strategyId && side) keys.add(`${symbol}|${strategyId}|${side}`);
  }
  return keys;
}

function classifyCandidate(blueprint, context) {
  const {
    config, openOrderSymbols, positionSymbols, duplicateKeys,
    perStrategyCounts, counters,
  } = context;
  const symbol = safeUpper(blueprint?.symbol) || null;
  const strategyId = String(blueprint?.strategyId || '').trim() || null;

  // Direction resolver — the authoritative BUY/SELL/BLOCKED/UNKNOWN decision.
  // A candidate whose direction is not verifiable is blocked (never guessed).
  const directionResolver = context.directionResolver || directionResolverService;
  const directionResult = directionResolver.resolveDirection(blueprint || {});
  const side = directionResult.side || sideFor(blueprint);
  const direction = directionResult.longShort || safeLower(blueprint?.direction) || 'unknown';

  const rawBlockers = toArray(blueprint?.blockers).map(normalizeBlocker).filter(Boolean);

  // Residual blueprint blockers that still apply under the plan.
  const planBlockers = [];
  for (const blocker of rawBlockers) {
    if (RELAXABLE_BLOCKERS.has(blocker)) continue;               // relaxed for planning
    if ((ETF_BLOCKERS.has(blocker) || blocker === 'qqq_etf_blocked') && config.includeEtf) continue; // ETF/QQQ allowed
    if (CRYPTO_BLOCKERS.has(blocker) || blocker === 'crypto_blocked') continue; // re-added below uniformly
    planBlockers.push(blocker);
  }

  // Direction must be verified (BUY/SELL). UNKNOWN/BLOCKED -> blocked, never guessed.
  if (!directionResult.allowed) {
    planBlockers.push(directionResult.blocker || 'direction_not_verified');
  }
  if (!symbol) planBlockers.push('symbol_missing');

  // Asset activation toggle: a candidate's asset class must be preview-enabled.
  const assetSvc = context.assetToggleService || assetToggleService;
  let assetInfo = { assetKey: 'stocks', previewEnabled: true, previewOnly: false, submitEverAllowedThisPhase: false, label: 'Aktier' };
  try { assetInfo = assetSvc.classifyCandidateAsset(blueprint || {}); } catch (_) { /* keep default */ }
  if (assetInfo.previewEnabled !== true) {
    planBlockers.push('asset_preview_disabled');
  }

  // Crypto is ALWAYS blocked from submit under multi-strategy mode (preview-only).
  const crypto = isCryptoCandidate(blueprint);
  if (config.cryptoBlocked && crypto) planBlockers.push('crypto_not_allowed');

  // Bracket required: candidate must carry or explicitly derive entry + stop +
  // take-profit. Missing pieces are exposed as diagnostics and stay blocked.
  const bracket = buildBracketDiagnostics(blueprint, side, config);
  if (config.bracketRequired && !bracket.bracketReady) {
    planBlockers.push(...bracket.bracketBlockers, 'bracket_required_missing');
  }

  // Entry-only must stay blocked. This is a safety invariant; if the guard were
  // ever off, every candidate is blocked rather than allowed entry-only.
  const wouldBlockEntryOnly = config.entryOnlyBlocked === true;
  if (!wouldBlockEntryOnly) planBlockers.push('entry_only_guard_disabled');

  // Quantity must be forceable to exactly 1.
  const wouldForceQuantity = config.forceQuantity;
  if (wouldForceQuantity !== 1) planBlockers.push('quantity_cannot_be_forced_to_1');

  // Open order / position guard.
  const openOrderConflict = Boolean(symbol && openOrderSymbols.has(symbol));
  const positionConflict = Boolean(symbol && positionSymbols.has(symbol));
  if (config.openOrderPositionGuard) {
    if (openOrderConflict) planBlockers.push('open_order_conflict');
    if (positionConflict) planBlockers.push('position_conflict');
  }

  // Duplicate guard: same symbol+strategy+side within the window.
  const duplicateConflict = Boolean(symbol && strategyId && side && duplicateKeys.has(`${symbol}|${strategyId}|${side}`));
  if (duplicateConflict) planBlockers.push('duplicate_trade_in_window');

  // Per-strategy daily cap (seeded + hypothetical accounting).
  let perStrategyCapReached = false;
  if (strategyId) {
    const used = perStrategyCounts.get(strategyId) || 0;
    if (used >= config.perStrategyDailyCap) perStrategyCapReached = true;
    else perStrategyCounts.set(strategyId, used + 1);
  }
  if (perStrategyCapReached) planBlockers.push('per_strategy_daily_cap_reached');

  // Global daily cap (seeded + hypothetical accounting).
  let globalCapReached = false;
  if (counters.global >= config.globalDailyCap) globalCapReached = true;
  else counters.global += 1;
  if (globalCapReached) planBlockers.push('global_daily_cap_reached');

  const blockers = [...new Set(planBlockers)];
  const allowed = blockers.length === 0;

  return {
    symbol,
    strategyId,
    strategyName: blueprint?.strategyName || strategyId || null,
    side,
    direction,
    source: blueprint?.source || 'trade_blueprint',
    rawSource: blueprint?.rawSource || blueprint?.source || 'trade_blueprint',
    resolvedDirection: directionResult.direction,
    normalizedDirection: blueprint?.normalizedDirection || directionResult.direction || null,
    directionVerified: directionResult.allowed === true,
    directionBlocker: directionResult.blocker || null,
    directionSource: directionResult.source || null,
    directionConfidence: blueprint?.directionConfidence || directionResult.confidence || null,
    rawDirectionFields: blueprint?.rawDirectionFields || {},
    directionReasonSv: directionResult.reasonSv || null,
    confidence: directionResult.confidence || null,
    assetGroup: assetInfo.assetKey,
    marketGroup: blueprint?.normalizedMarketGroup || blueprint?.marketGroup || blueprint?.market_group || null,
    assetLabel: assetInfo.label,
    assetPreviewEnabled: assetInfo.previewEnabled === true,
    assetPreviewOnly: assetInfo.previewOnly === true,
    allowed,
    blockers,
    rawBlueprintBlockers: rawBlockers,
    wouldForceQuantity,
    originalQuantity: blueprint?.quantity ?? null,
    wouldRequireBracket: config.bracketRequired === true,
    wouldBlockEntryOnly,
    bracketReady: bracket.bracketReady,
    bracketSource: bracket.bracketSource,
    entryPriceSource: bracket.entryPriceSource,
    stopLossSource: bracket.stopLossSource,
    takeProfitSource: bracket.takeProfitSource,
    bracketBlockers: bracket.bracketBlockers,
    hasBracket: bracket.hasBracket,
    isCrypto: crypto,
    openOrderConflict,
    positionConflict,
    // Back-compat: combined flag used by earlier UI/tests.
    openOrderPositionConflict: openOrderConflict || positionConflict,
    duplicateConflict,
    perStrategyCapReached,
    globalCapReached,
    entryReferencePrice: bracket.entryReferencePrice,
    stopLoss: bracket.stopLoss,
    takeProfit: bracket.takeProfit,
    stopLossPct: bracket.stopLossPct,
    blueprintId: blueprint?.blueprintId || null,
  };
}

/**
 * Pure builder. All inputs are injected so this is trivially testable and has
 * zero side effects. Pass already-fetched read-only payloads.
 *
 * @param {object} input
 * @param {object} input.tradeBlueprint   getTradeBlueprint output (candidates).
 * @param {object} [input.executionStatus] paper execution-status (daily quota + trades for seeding/dup guard).
 * @param {object} [input.readOnlyState]  paper-readonly-state (open orders / positions / executions).
 * @param {object} [input.config]         override config (defaults to env-resolved config).
 * @param {Date|string|number} [input.now] reference time for the duplicate window.
 */
function buildMultiStrategyTestPlan(input = {}) {
  const config = input.config || configService.getIbPaperMultiStrategyConfig();
  const enabled = config.enabled === true;
  const submitRoutesEnabled = configService.readFlag(SUBMIT_ROUTES_FLAG);
  const now = input.now ? new Date(input.now) : new Date();

  const tradeBlueprint = input.tradeBlueprint || {};
  const executionStatus = input.executionStatus || {};
  const readOnlyState = input.readOnlyState || {};

  const blueprints = toArray(tradeBlueprint.blueprints);
  const previewCandidates = toArray(input.previewCandidates).length > 0
    ? toArray(input.previewCandidates)
    : toArray(tradeBlueprint?.orderPreview?.candidates);
  const normalizedPreviewCandidates = previewCandidates.map(normalizePreviewCandidate);
  const blueprintKeys = new Set(blueprints.map(candidateKey));
  const fallbackCandidates = normalizedPreviewCandidates.filter((row) => !blueprintKeys.has(candidateKey(row)));

  const openOrders = toArray(readOnlyState.openOrders);
  const positions = toArray(readOnlyState.positions);
  const executions = toArray(readOnlyState.executions);
  const openOrderSymbols = new Set(openOrders.map((row) => safeUpper(row?.symbol)).filter(Boolean));
  const positionSymbols = new Set(positions.map((row) => safeUpper(row?.symbol)).filter(Boolean));

  // Read-only IB Paper history used for the duplicate guard + cap seeding.
  const historyRows = [
    ...toArray(executionStatus.openTrades),
    ...toArray(executionStatus.closedTrades),
    ...executions,
  ];
  const duplicateKeys = buildDuplicateKeySet(historyRows, config.duplicateGuardMinutes, now);

  // Seed caps from real history when available; never over-block on missing data.
  const counters = { global: 0 };
  const seedGlobal = toNumber(executionStatus?.dailyQuota?.used);
  if (seedGlobal != null && seedGlobal >= 0) counters.global = seedGlobal;
  const perStrategyCounts = new Map();
  const today = now.toISOString().slice(0, 10);
  for (const row of [...toArray(executionStatus.openTrades), ...toArray(executionStatus.closedTrades)]) {
    const openedDay = String(row?.openedAt || row?.opened_at || '').slice(0, 10);
    if (openedDay !== today) continue;
    const sid = String(row?.strategyId || row?.strategy_id || '').trim();
    if (!sid) continue;
    perStrategyCounts.set(sid, (perStrategyCounts.get(sid) || 0) + 1);
  }

  const classificationContext = {
    config, openOrderSymbols, positionSymbols, duplicateKeys, perStrategyCounts, counters,
    directionResolver: input.directionResolver || directionResolverService,
    assetToggleService: input.assetToggleService || assetToggleService,
  };

  // Respect maxCandidates when surfacing the plan. Include blocked preview
  // candidates too, so the plan explains blockers instead of showing an empty
  // candidate list whenever trade-blueprint has no allowed blueprints.
  const consideredBlueprints = [...blueprints, ...fallbackCandidates].slice(0, config.maxCandidates);
  const candidates = consideredBlueprints.map((bp) => classifyCandidate(bp, classificationContext));

  const allowedCount = candidates.filter((c) => c.allowed).length;
  const blockedCount = candidates.length - allowedCount;

  // Asset toggle snapshot + direction summary (read-only views for the UI).
  let assetToggles = null;
  try { assetToggles = (input.assetToggleService || assetToggleService).getAssetToggles(); }
  catch (_) { assetToggles = null; }
  const directionSummary = {
    buy: candidates.filter((c) => c.resolvedDirection === 'BUY').length,
    sell: candidates.filter((c) => c.resolvedDirection === 'SELL').length,
    unknown: candidates.filter((c) => c.resolvedDirection === 'UNKNOWN').length,
    blocked: candidates.filter((c) => c.resolvedDirection === 'BLOCKED').length,
    verified: candidates.filter((c) => c.directionVerified === true).length,
  };

  // Top-level blockers that prevent ANY submit right now (gating/safety reasons).
  const currentBlockers = [];
  if (!enabled) currentBlockers.push('multi_strategy_test_mode_disabled');
  if (!submitRoutesEnabled) currentBlockers.push('submit_routes_disabled');
  currentBlockers.push('phase_2_no_auto_submit');

  const account = String(readOnlyState.account || DEFAULT_ACCOUNT) || DEFAULT_ACCOUNT;
  const readiness = tradeBlueprint.readiness || executionStatus.readinessProfile || {};
  const paperAccountVerified = readiness?.paperAccountVerified === true;
  const ibApiVerified = readiness?.ibApiVerified === true;
  const dailyQuota = executionStatus.dailyQuota || null;

  const limits = {
    maxCandidates: config.maxCandidates,
    globalDailyCap: config.globalDailyCap,
    perStrategyDailyCap: config.perStrategyDailyCap,
    forceQuantity: config.forceQuantity,
    bracketRequired: config.bracketRequired,
    entryOnlyBlocked: config.entryOnlyBlocked,
    openOrderPositionGuard: config.openOrderPositionGuard,
    duplicateGuardMinutes: config.duplicateGuardMinutes,
    includeEtf: config.includeEtf,
    cryptoBlocked: config.cryptoBlocked,
  };

  return {
    ok: true,
    readOnly: true,
    enabled,
    mode: MODE,
    modeFlag: MODE_FLAG,
    submitRoutesEnabled,
    etfAllowed: config.includeEtf,
    cryptoBlocked: config.cryptoBlocked,
    assetToggles: assetToggles ? assetToggles.paperPreviewAssetToggles : null,
    assetToggleAssets: assetToggles ? assetToggles.assets : [],
    directionSummary,
    note: 'Detta är endast en read-only IB Paper-testplan. Den skickar inga order. '
      + 'Faktiska IB Paper-orders kräver en separat manuell submit-process.',
    limits,
    counts: {
      candidateCount: candidates.length,
      allowedCount,
      blockedCount,
    },
    ibState: {
      account,
      paperAccountVerified,
      ibApiVerified,
      openOrdersCount: openOrders.length,
      positionsCount: positions.length,
      executionsCount: executions.length,
      dailyQuotaUsed: dailyQuota ? dailyQuota.used : null,
      dailyQuotaMax: dailyQuota ? dailyQuota.max : null,
    },
    summary: {
      totalCandidates: candidates.length,
      allowedCount,
      blockedCount,
      wouldAllowMore: candidates.length > 0 && blockedCount < candidates.length,
    },
    diagnostics: {
      candidateSource: blueprints.length > 0
        ? (fallbackCandidates.length > 0 ? 'trade_blueprint+order_preview_candidates' : 'trade_blueprint')
        : 'order_preview_candidates',
      tradeBlueprintCount: blueprints.length,
      previewCandidateCount: previewCandidates.length,
      fallbackCandidateCount: fallbackCandidates.length,
      emptyReason: candidates.length === 0 ? 'no_trade_blueprints_or_preview_candidates' : null,
    },
    currentBlockers: [...new Set(currentBlockers)],
    candidates,
    safety: { ...SAFETY },
  };
}

module.exports = {
  MODE,
  MODE_FLAG,
  SUBMIT_ROUTES_FLAG,
  ETF_FLAG,
  DEFAULT_ACCOUNT,
  DEFAULT_LIMITS,
  SAFETY,
  buildMultiStrategyTestPlan,
  _internal: { classifyCandidate, buildDuplicateKeySet, hasBracket, buildBracketDiagnostics, isCryptoCandidate, RELAXABLE_BLOCKERS },
};
