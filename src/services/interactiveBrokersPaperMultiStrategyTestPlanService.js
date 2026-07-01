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
const setupBuilderService = require('./interactiveBrokersPaperSetupBuilderService');
const daytradingStrategyCatalogService = require('./daytradingStrategyCatalogService');
const { getLatestResults } = require('../scanner/scheduler');

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
const LIVE_PRICE_MAX_AGE_MS = 60_000;

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

function firstNumberWithSource(candidates = []) {
  for (const [source, value] of candidates) {
    const numeric = toNumber(value);
    if (numeric != null && numeric > 0) return { value: numeric, source };
  }
  return { value: null, source: null };
}

function isoTimestamp(value) {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function timestampMs(value) {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

function firstTimestamp(...values) {
  for (const value of values) {
    const iso = isoTimestamp(value);
    if (iso) return iso;
  }
  return null;
}

function oneMinuteBucket(value) {
  const ms = timestampMs(value);
  if (ms == null) return 'unknown';
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function putLivePrice(index, row = {}, source = 'unknown', fallbackTimestamp = null) {
  const symbol = safeUpper(row.symbol);
  const price = firstNumberWithSource([
    ['currentPrice', row.currentPrice],
    ['price', row.price],
    ['lastPrice', row.lastPrice],
    ['close', row.close],
    ['c', row.c],
    ['entryPrice', row.entryPrice],
  ]);
  if (!symbol || !(price.value > 0)) return;
  const timestamp = firstTimestamp(
    row.lastUpdate,
    row.updatedAt,
    row.latest2mTimestamp,
    row.timestamp,
    row.time,
    fallbackTimestamp,
  );
  index.set(symbol, {
    symbol,
    price: price.value,
    source: `${source}.${price.source}`,
    timestamp,
  });
}

function buildLivePriceIndex(input = {}) {
  const index = new Map();
  const scannerRows = Array.isArray(input.marketResults)
    ? input.marketResults
    : (() => {
      try { return Array.isArray(getLatestResults()) ? getLatestResults() : []; }
      catch (_) { return []; }
    })();
  for (const row of scannerRows) putLivePrice(index, row, 'scanner.getLatestResults');

  const snapshots = input.redisSnapshots || input.livePriceSnapshots || {};
  for (const [key, payload] of Object.entries(snapshots || {})) {
    if (!payload || typeof payload !== 'object') continue;
    if (payload.prices && typeof payload.prices === 'object') {
      for (const [symbol, price] of Object.entries(payload.prices)) {
        putLivePrice(index, { symbol, price, updatedAt: payload.updatedAt }, `redis.${key}`, payload.updatedAt);
      }
    }
    for (const row of toArray(payload.results)) {
      putLivePrice(index, row, `redis.${key}`, payload.updatedAt);
    }
  }

  for (const [symbol, value] of Object.entries(input.priceIndex || {})) {
    const row = value && typeof value === 'object'
      ? { symbol, ...value }
      : { symbol, price: value, updatedAt: input.now };
    putLivePrice(index, row, 'injected.priceIndex', input.now);
  }
  return index;
}

function resolveLivePrice(symbol, livePriceIndex) {
  return livePriceIndex instanceof Map ? livePriceIndex.get(safeUpper(symbol)) || null : null;
}

function buildStrategyRiskRuleIndex(input = {}) {
  const index = new Map();
  const injected = input.strategyRiskRules || input.riskRules || {};
  for (const [strategyId, rule] of Object.entries(injected || {})) {
    if (!strategyId || !rule) continue;
    index.set(String(strategyId), {
      strategyId: String(strategyId),
      stopLossPct: toNumber(rule.stopLossPct ?? rule.default_stop_loss_pct ?? rule.default_sl),
      takeProfitRMultiple: toNumber(rule.takeProfitRMultiple ?? rule.default_take_profit_r ?? rule.default_tp),
      source: rule.source || 'injected_strategy_risk_rules',
    });
  }

  let strategies = [];
  try { strategies = toArray(daytradingStrategyCatalogService.getCatalog()?.strategies); }
  catch (_) { strategies = []; }
  for (const strategy of strategies) {
    const strategyId = String(strategy.id || strategy.strategyId || '').trim();
    if (!strategyId || index.has(strategyId)) continue;
    index.set(strategyId, {
      strategyId,
      stopLossPct: toNumber(strategy.default_stop_loss_pct ?? strategy.default_sl),
      takeProfitRMultiple: toNumber(strategy.default_take_profit_r ?? strategy.default_tp),
      source: 'daytradingStrategyCatalogService',
    });
  }
  return index;
}

function resolveRiskRule(strategyId, strategyRiskRuleIndex) {
  return strategyRiskRuleIndex instanceof Map ? strategyRiskRuleIndex.get(String(strategyId || '').trim()) || null : null;
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
const STALE_MATERIALIZED_BRACKET_BLOCKERS = new Set([
  'missing_entry_price',
  'missing_stop_loss',
  'missing_take_profit',
  'bracket_required_missing',
  'stop_loss_too_small',
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

function dedupeKey(row = {}) {
  return [
    safeUpper(row.symbol),
    String(row.strategyId || row.strategy_id || '').trim(),
    safeUpper(row.side || row.resolvedDirection || row.direction),
    String(row.source || row.rawSource || 'unknown').trim(),
    oneMinuteBucket(row.timestamp || row.livePriceTimestamp || row.createdAt || row.latestActivityAt || row.lastUpdate),
  ].join('|');
}

function dedupeRank(row = {}) {
  let rank = 0;
  if (row.source === 'scanner' || row.rawSource === 'scanner') rank += 1;
  if (row.livePrice > 0) rank += 10;
  if (row.setupMaterialized === true) rank += 50;
  if (row.bracketReady === true) rank += 75;
  if (row.setupReady === true) rank += 100;
  return rank;
}

function dedupeCandidates(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    const key = row.dedupeKey || dedupeKey(row);
    const withKey = { ...row, dedupeKey: key };
    const existing = byKey.get(key);
    if (!existing || dedupeRank(withKey) > dedupeRank(existing)) byKey.set(key, withKey);
  }
  return Array.from(byKey.values());
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
    timestamp: candidate.timestamp || candidate.latestActivityAt || candidate.createdAt || candidate.lastUpdate || null,
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

function buildMaterializedStopDiagnostics({ bracket, materialization, config = {} }) {
  const entry = toNumber(bracket?.entryReferencePrice);
  const stop = toNumber(bracket?.stopLoss);
  const take = toNumber(bracket?.takeProfit);
  const minStopPct = toNumber(config.minStopLossPct ?? 0.10);
  const setupComplete = materialization?.setupMaterialized === true
    && materialization?.setup?.setupReady === true
    && bracket?.bracketReady === true
    && entry > 0
    && stop > 0
    && take > 0;
  const stopDistancePct = entry > 0 && stop > 0
    ? round((Math.abs(entry - stop) / entry) * 100, 4)
    : null;
  const stopPassesMin = setupComplete === true
    && stopDistancePct != null
    && minStopPct != null
    && stopDistancePct + 1e-6 >= minStopPct;

  return {
    setupComplete,
    materializedStopDistancePct: stopDistancePct,
    materializedStopMinPct: minStopPct,
    materializedStopPassesMin: stopPassesMin,
  };
}

function filterStaleMaterializedBracketBlockers(planBlockers, { bracket, materialization, config = {} } = {}) {
  const stopDiagnostics = buildMaterializedStopDiagnostics({ bracket, materialization, config });
  const staleBlockersFiltered = [];
  const filtered = [];

  for (const blocker of planBlockers) {
    if (!STALE_MATERIALIZED_BRACKET_BLOCKERS.has(blocker) || stopDiagnostics.setupComplete !== true) {
      filtered.push(blocker);
      continue;
    }
    if (blocker === 'stop_loss_too_small' && stopDiagnostics.materializedStopPassesMin !== true) {
      filtered.push(blocker);
      continue;
    }
    staleBlockersFiltered.push(blocker);
  }

  return {
    blockers: filtered,
    staleBlockersFiltered: [...new Set(staleBlockersFiltered)],
    materializedStopDistancePct: stopDiagnostics.materializedStopDistancePct,
    materializedStopMinPct: stopDiagnostics.materializedStopMinPct,
    materializedStopPassesMin: stopDiagnostics.materializedStopPassesMin,
  };
}

function buildSetupMaterialization({ blueprint, side, directionAllowed, symbol, strategyId, assetInfo, crypto, context }) {
  const now = context.now || new Date();
  const livePriceInfo = resolveLivePrice(symbol, context.livePriceIndex);
  const livePrice = toNumber(livePriceInfo?.price);
  const livePriceTimestamp = livePriceInfo?.timestamp || null;
  const livePriceAgeMs = livePriceTimestamp ? new Date(now).getTime() - new Date(livePriceTimestamp).getTime() : null;
  const riskRule = resolveRiskRule(strategyId, context.strategyRiskRuleIndex);
  const stopLossPct = toNumber(riskRule?.stopLossPct);
  const takeProfitRMultiple = toNumber(riskRule?.takeProfitRMultiple);
  const blockers = [];

  if (directionAllowed !== true || !['BUY', 'SELL'].includes(side)) blockers.push('direction_not_verified');
  if (!(livePrice > 0)) blockers.push('live_price_missing');
  if (!livePriceTimestamp) blockers.push('live_price_timestamp_missing');
  else if (!(livePriceAgeMs <= LIVE_PRICE_MAX_AGE_MS && livePriceAgeMs >= -5_000)) blockers.push('live_price_stale');
  if (!riskRule) blockers.push('risk_rule_missing');
  if (!(stopLossPct > 0)) blockers.push('stop_loss_rule_missing');
  if (!(takeProfitRMultiple > 0)) blockers.push('take_profit_rule_missing');

  const base = {
    setupMaterialized: false,
    setupMaterializationSource: null,
    livePrice: livePrice ?? null,
    livePriceSource: livePriceInfo?.source || null,
    livePriceTimestamp,
    livePriceAgeMs,
    riskRuleSource: riskRule?.source || null,
    stopLossPct: stopLossPct ?? null,
    takeProfitRMultiple: takeProfitRMultiple ?? null,
    setupMaterializationBlockers: [...new Set(blockers)],
    setup: null,
  };

  if (blockers.length > 0) return base;

  const setupSvc = context.setupBuilderService || setupBuilderService;
  const {
    entryPrice,
    entryReferencePrice,
    entry,
    plannedEntry,
    limitPrice,
    stopLoss,
    stopLossPrice,
    stop_loss,
    stop,
    sl,
    takeProfit,
    takeProfit1,
    take_profit,
    tp,
    target,
    targetPrice,
    ...candidateForRuleDerivation
  } = blueprint || {};
  const setup = setupSvc.buildSetup(
    {
      ...candidateForRuleDerivation,
      side,
      currentPrice: livePrice,
      price: livePrice,
      assetGroup: assetInfo.assetKey,
      isCrypto: crypto,
    },
    {
      includeEtf: context.config.includeEtf === true,
      allowRuleDerivedBracket: true,
      referencePrice: livePrice,
      stopLossPct,
      takeProfitRMultiple,
      quantity: 1,
    },
  );

  const setupBlockers = toArray(setup?.blockers);
  return {
    ...base,
    setupMaterialized: setup?.setupReady === true,
    setupMaterializationSource: setup?.setupReady === true ? 'live_price_plus_strategy_risk_rule' : null,
    setupMaterializationBlockers: [...new Set(setup?.setupReady === true ? [] : setupBlockers)],
    setup,
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
    config, enabled, submitRoutesEnabled, openOrderSymbols, positionSymbols, duplicateKeys,
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

  const explicitBracket = buildBracketDiagnostics(blueprint, side, config);
  const materialization = explicitBracket.bracketReady
    ? {
      setupMaterialized: false,
      setupMaterializationSource: 'candidate_explicit_bracket',
      livePrice: null,
      livePriceSource: null,
      livePriceTimestamp: null,
      livePriceAgeMs: null,
      riskRuleSource: null,
      stopLossPct: explicitBracket.stopLossPct,
      takeProfitRMultiple: null,
      setupMaterializationBlockers: [],
      setup: null,
    }
    : buildSetupMaterialization({
      blueprint,
      side,
      directionAllowed: directionResult.allowed === true,
      symbol,
      strategyId,
      assetInfo,
      crypto,
      context,
    });
  const materializedBlueprint = materialization.setupMaterialized === true
    ? {
      ...blueprint,
      entryReferencePrice: materialization.setup.entryPrice,
      entryPrice: materialization.setup.entryPrice,
      currentPrice: materialization.livePrice,
      stopLoss: materialization.setup.stopLossPrice,
      stopLossPrice: materialization.setup.stopLossPrice,
      takeProfit: materialization.setup.takeProfitPrice,
      takeProfit1: materialization.setup.takeProfitPrice,
      quantity: 1,
      stopLossPct: materialization.stopLossPct,
      side,
    }
    : blueprint;

  // Bracket required: candidate must carry or explicitly derive entry + stop +
  // take-profit. Missing pieces are exposed as diagnostics and stay blocked.
  const bracket = materialization.setupMaterialized === true
    ? {
      bracketReady: true,
      hasBracket: true,
      bracketSource: materialization.setupMaterializationSource,
      entryReferencePrice: materialization.setup.entryPrice,
      entryPriceSource: materialization.setup.diagnostics?.entryPriceSource || 'rule_reference_price',
      stopLoss: materialization.setup.stopLossPrice,
      stopLossSource: materialization.setup.diagnostics?.stopLossSource || `rule_stop_pct_${materialization.stopLossPct}`,
      takeProfit: materialization.setup.takeProfitPrice,
      takeProfitSource: materialization.setup.diagnostics?.takeProfitSource || `rule_take_r_${materialization.takeProfitRMultiple}`,
      stopLossPct: materialization.stopLossPct,
      bracketBlockers: [],
    }
    : explicitBracket;
  if (config.bracketRequired && !bracket.bracketReady) {
    planBlockers.push(...bracket.bracketBlockers, 'bracket_required_missing');
    planBlockers.push(...materialization.setupMaterializationBlockers);
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

  const staleBlockerDiagnostics = filterStaleMaterializedBracketBlockers(planBlockers, {
    bracket,
    materialization,
    config,
  });
  const blockers = [...new Set(staleBlockerDiagnostics.blockers)];
  const planningAllowed = blockers.length === 0;
  const allowed = planningAllowed
    && (materialization.setupMaterialized !== true || (enabled === true && submitRoutesEnabled === true));

  // Read-only setup-builder diagnostics. Purely additive: it never affects
  // `allowed`/`blockers`/counts. It reports whether this candidate could become
  // a VERIFIED trade setup (side + complete, valid bracket) without inventing
  // any value. Asset class is passed through so crypto/ETF gating stays aligned.
  const setupSvc = context.setupBuilderService || setupBuilderService;
  let setupBuilderView = null;
  try {
    const setup = materialization.setup || setupSvc.buildSetup(
      { ...materializedBlueprint, assetGroup: assetInfo.assetKey, isCrypto: crypto },
      { includeEtf: config.includeEtf === true },
    );
    setupBuilderView = {
      setupReady: setup.setupReady,
      side: setup.side,
      entryPrice: setup.entryPrice,
      stopLossPrice: setup.stopLossPrice,
      takeProfitPrice: setup.takeProfitPrice,
      quantity: setup.quantity,
      bracketReady: setup.bracketReady,
      blockers: setup.blockers,
      diagnostics: setup.diagnostics,
    };
  } catch (_) {
    setupBuilderView = null;
  }

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
    planningAllowed,
    blockers,
    staleBlockersFiltered: staleBlockerDiagnostics.staleBlockersFiltered,
    rawBlueprintBlockers: rawBlockers,
    wouldForceQuantity,
    originalQuantity: blueprint?.quantity ?? null,
    quantity: materialization.setupMaterialized === true ? 1 : (blueprint?.quantity ?? null),
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
    entryPrice: bracket.entryReferencePrice,
    stopLoss: bracket.stopLoss,
    stopLossPrice: bracket.stopLoss,
    takeProfit: bracket.takeProfit,
    takeProfitPrice: bracket.takeProfit,
    stopLossPct: bracket.stopLossPct ?? materialization.stopLossPct,
    takeProfitRMultiple: materialization.takeProfitRMultiple,
    materializedStopDistancePct: staleBlockerDiagnostics.materializedStopDistancePct,
    materializedStopMinPct: staleBlockerDiagnostics.materializedStopMinPct,
    materializedStopPassesMin: staleBlockerDiagnostics.materializedStopPassesMin,
    setupReady: setupBuilderView?.setupReady === true,
    setupMaterialized: materialization.setupMaterialized === true,
    setupMaterializationSource: materialization.setupMaterializationSource,
    livePrice: materialization.livePrice,
    livePriceSource: materialization.livePriceSource,
    livePriceTimestamp: materialization.livePriceTimestamp,
    livePriceAgeMs: materialization.livePriceAgeMs,
    riskRuleSource: materialization.riskRuleSource,
    setupMaterializationBlockers: materialization.setupMaterializationBlockers,
    dedupeKey: dedupeKey({
      ...blueprint,
      symbol,
      strategyId,
      side,
      direction: directionResult.direction,
      livePriceTimestamp: materialization.livePriceTimestamp,
    }),
    blueprintId: blueprint?.blueprintId || null,
    // Additive read-only diagnostics (does not affect allowed/blockers).
    setupBuilder: setupBuilderView,
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
    config, enabled, submitRoutesEnabled, openOrderSymbols, positionSymbols, duplicateKeys, perStrategyCounts, counters,
    directionResolver: input.directionResolver || directionResolverService,
    assetToggleService: input.assetToggleService || assetToggleService,
    setupBuilderService: input.setupBuilderService || setupBuilderService,
    livePriceIndex: input.livePriceIndex instanceof Map ? input.livePriceIndex : buildLivePriceIndex({ ...input, now }),
    strategyRiskRuleIndex: input.strategyRiskRuleIndex instanceof Map ? input.strategyRiskRuleIndex : buildStrategyRiskRuleIndex(input),
    now,
  };

  // Respect maxCandidates when surfacing the plan. Include blocked preview
  // candidates too, so the plan explains blockers instead of showing an empty
  // candidate list whenever trade-blueprint has no allowed blueprints.
  const consideredBlueprints = [...blueprints, ...fallbackCandidates].slice(0, config.maxCandidates);
  const candidates = dedupeCandidates(consideredBlueprints.map((bp) => classifyCandidate(bp, classificationContext)));

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
      // Read-only setup-builder rollup (watch-signal -> verified trade setup).
      setupBuilder: {
        evaluated: candidates.filter((c) => c.setupBuilder).length,
        setupReadyCount: candidates.filter((c) => c.setupBuilder && c.setupBuilder.setupReady).length,
        blockedCount: candidates.filter((c) => c.setupBuilder && !c.setupBuilder.setupReady).length,
      },
      setupMaterialization: {
        evaluated: candidates.length,
        materializedCount: candidates.filter((c) => c.setupMaterialized === true).length,
        blockedCount: candidates.filter((c) => c.setupMaterialized !== true).length,
        livePriceMaxAgeMs: LIVE_PRICE_MAX_AGE_MS,
      },
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
