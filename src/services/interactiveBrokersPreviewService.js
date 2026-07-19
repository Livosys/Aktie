'use strict';

// Interactive Brokers Paper read-only preview.
//
// This module reads the permanent execution runtime and the Futures Paper
// candidate pipeline. It never opens an IB socket, never submits, never queues
// orders and never reads legacy approval stores.

const crypto = require('crypto');

const ibPaperExecutionOrchestratorService = require('./ibPaperExecutionOrchestratorService');
const futuresPaperScannerService = require('./futuresPaperScannerService');
const strategyRegistryService = require('./strategyRegistryService');
const paperStrategyEntryContractService = require('./paperStrategyEntryContractService');
const ibPaperBrokerRiskService = require('./ibPaperBrokerRiskService');
const ibPaperExecutionAdapterService = require('./ibPaperExecutionAdapterService');
const futuresPaperQuoteSourceService = require('./futuresPaperQuoteSourceService');
const futuresMarketHoursService = require('./futuresMarketHoursService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const NEXT_PHASE_LOCKED = Object.freeze({
  paperOrderQueue: { locked: true, reason: 'submission_disabled' },
  brokerExecution: { locked: true, reason: 'shadow_mode_active' },
  liveTrading: { locked: true, reason: 'permanently_blocked_paper_only' },
  manualSafetyGateRequired: true,
});

const PREVIEW_LIMIT = 3;
const PAPER_PORT = 4002;
const DEFAULT_TIF = 'GTC';
const MAX_STOP_LOSS_PCT_FLOOR = 0.10;

function readFlag(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(raw);
}

function getFeatureFlags() {
  return {
    previewEnabled: readFlag('IB_PAPER_PREVIEW_ENABLED'),
    orderQueueEnabled: readFlag('IB_PAPER_ORDER_QUEUE_ENABLED'),
    executionEnabled: readFlag('IB_PAPER_EXECUTION_ENABLED'),
  };
}

function getConnectionConfig() {
  const host = String(process.env.IB_GATEWAY_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = String(process.env.IB_GATEWAY_PORT || '').trim();
  const clientIdRaw = String(process.env.IB_GATEWAY_CLIENT_ID || '').trim();
  const port = /^\d+$/.test(portRaw) ? Number(portRaw) : null;
  return {
    checkEnabled: readFlag('IB_CONNECTION_CHECK_ENABLED'),
    host,
    port,
    portConfigured: port !== null,
    clientIdConfigured: clientIdRaw !== '',
  };
}

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeUpper(value) {
  return safeString(value).toUpperCase();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function safeNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function addMinutes(now, minutes) {
  return new Date(new Date(now).getTime() + minutes * 60_000).toISOString();
}

function isPaperAccountId(accountId) {
  return /^DU/i.test(safeString(accountId));
}

function buildVerificationBase(cfg) {
  return {
    ok: true,
    dryRun: true,
    safety: { ...SAFETY },
    host: cfg.host,
    port: cfg.port,
    portConfigured: cfg.portConfigured,
    clientIdConfigured: cfg.clientIdConfigured,
    connectionCheckEnabled: cfg.checkEnabled,
    gatewayReachable: false,
    status: 'disabled',
    paperMode: 'unknown',
    paperModeVerified: false,
    ibApiVerified: false,
    paperAccountVerified: false,
    managedAccounts: [],
    managedAccountCount: 0,
    paperAccountId: null,
    sessionVerified: false,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
    internalPaperTradingUnaffected: true,
    passwordStored: false,
    note: 'Read-only readiness from the permanent execution runtime singleton. No orders are sent.',
  };
}

function buildVerificationResult(base, overrides = {}) {
  const managedAccounts = Array.isArray(overrides.managedAccounts)
    ? overrides.managedAccounts.filter(Boolean)
    : [];
  const paperAccountId = overrides.paperAccountId || managedAccounts.find(isPaperAccountId) || null;
  const ibApiVerified = overrides.ibApiVerified === true;
  const paperAccountVerified = overrides.paperAccountVerified === true;
  const sessionVerified = overrides.sessionVerified === true || (ibApiVerified && paperAccountVerified);
  const paperModeVerified = overrides.paperModeVerified === true || sessionVerified;

  return {
    ...base,
    ...overrides,
    managedAccounts,
    managedAccountCount: managedAccounts.length,
    paperAccountId,
    ibApiVerified,
    paperAccountVerified,
    sessionVerified,
    paperModeVerified,
    paperMode: paperModeVerified ? 'paper_only' : (overrides.paperMode || 'unknown'),
    status: overrides.status || (paperModeVerified ? 'verified' : base.status),
    blockedReason: overrides.blockedReason || (paperModeVerified ? 'read_only_session_verified' : base.blockedReason || 'ib_api_not_verified'),
  };
}

function getExecutionRuntimeReadinessSnapshot() {
  try {
    const orchestrator = ibPaperExecutionOrchestratorService.defaultIbPaperExecutionOrchestratorService;
    if (orchestrator && typeof orchestrator.getRuntimeReadinessSnapshot === 'function') {
      return orchestrator.getRuntimeReadinessSnapshot();
    }
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      blockedReason: 'execution_runtime_readiness_unavailable',
      error: err?.message || String(err),
    };
  }
  return null;
}

function buildConnectionSummary() {
  const cfg = getConnectionConfig();
  const base = {
    host: cfg.host,
    port: cfg.port,
    portConfigured: cfg.portConfigured,
    clientIdConfigured: cfg.clientIdConfigured,
    status: 'disabled',
    paperMode: 'unknown',
    paperModeVerified: false,
  };
  const runtime = getExecutionRuntimeReadinessSnapshot();
  if (runtime && runtime.ok !== false) {
    return {
      ...base,
      source: 'ib_paper_execution_runtime_singleton',
      host: runtime.host || base.host,
      port: runtime.port ?? base.port,
      connectionCheckEnabled: cfg.checkEnabled,
      gatewayReachable: runtime.gatewayReachable === true,
      status: runtime.status || (runtime.gatewayReachable ? 'reachable' : 'unreachable'),
      blockedReason: runtime.blockedReason || (runtime.gatewayReachable ? null : 'execution_runtime_not_ready'),
      paperMode: runtime.paperMode || 'unknown',
      paperModeVerified: runtime.paperModeVerified === true,
      ibApiVerified: runtime.ibApiVerified === true,
      paperAccountVerified: runtime.paperAccountVerified === true,
      sessionVerified: runtime.sessionVerified === true,
      runtimeState: runtime.runtimeState || null,
      nextValidId: runtime.nextValidId ?? null,
      managedAccountCount: runtime.managedAccountCount || 0,
      lastConnected: runtime.lastConnected || null,
      connectedSince: runtime.connectedSince || null,
      lastHeartbeat: runtime.lastHeartbeat || null,
      lastReconnect: runtime.lastReconnect || null,
      lastReadyAt: runtime.lastReadyAt || null,
      lastReconciliationAt: runtime.lastReconciliationAt || null,
      uptime: runtime.uptime ?? runtime.uptimeMs ?? null,
      uptimeMs: runtime.uptimeMs ?? null,
      runtimeLifecycle: runtime.runtimeLifecycle || null,
      runtimeLifecycleState: runtime.runtimeLifecycleState || null,
      reconnectCount: runtime.reconnectCount || 0,
    };
  }
  if (!cfg.checkEnabled) {
    return {
      ...base,
      connectionCheckEnabled: false,
      gatewayReachable: false,
      status: 'disabled',
      blockedReason: 'ib_connection_check_disabled',
    };
  }
  if (!cfg.portConfigured) {
    return {
      ...base,
      connectionCheckEnabled: true,
      gatewayReachable: false,
      status: 'not_configured',
      blockedReason: 'ib_gateway_not_configured',
    };
  }
  return {
    ...base,
    connectionCheckEnabled: true,
    gatewayReachable: null,
    status: 'runtime_pending',
    blockedReason: 'execution_runtime_not_ready',
  };
}

async function getConnectionReadiness() {
  const cfg = getConnectionConfig();
  const paperPortConfigured = (cfg.host === '127.0.0.1' || cfg.host === 'localhost') && Number(cfg.port) === PAPER_PORT;
  const base = {
    ok: true,
    dryRun: true,
    safety: { ...SAFETY },
    host: cfg.host,
    port: cfg.port,
    portConfigured: cfg.portConfigured,
    clientIdConfigured: cfg.clientIdConfigured,
    paperPortConfigured,
    status: 'disabled',
    paperMode: 'unknown',
    paperModeVerified: false,
    ibApiVerified: false,
    paperAccountVerified: false,
    managedAccounts: [],
    managedAccountCount: 0,
    paperAccountId: null,
    sessionVerified: false,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
    internalPaperTradingUnaffected: true,
    passwordStored: false,
    note: 'Read-only readiness. No login automation, no socket probe and no order submission.',
  };

  const runtime = getExecutionRuntimeReadinessSnapshot();
  if (!runtime || runtime.ok === false) {
    return {
      ...base,
      connectionCheckEnabled: cfg.checkEnabled,
      gatewayReachable: false,
      status: runtime?.status || 'error',
      blockedReason: runtime?.blockedReason || 'execution_runtime_readiness_unavailable',
      source: 'ib_paper_execution_runtime_singleton',
      error: runtime?.error || null,
    };
  }

  return {
    ...base,
    source: 'ib_paper_execution_runtime_singleton',
    host: runtime.host || base.host,
    port: runtime.port ?? base.port,
    connectionCheckEnabled: cfg.checkEnabled,
    gatewayReachable: runtime.gatewayReachable === true,
    status: runtime.status || (runtime.gatewayReachable ? 'reachable' : 'unreachable'),
    blockedReason: runtime.blockedReason || (runtime.gatewayReachable ? 'reachable_read_only_no_orders' : 'execution_runtime_not_ready'),
    paperMode: runtime.paperMode || 'unknown',
    paperModeVerified: runtime.paperModeVerified === true,
    ibApiVerified: runtime.ibApiVerified === true,
    paperAccountVerified: runtime.paperAccountVerified === true,
    managedAccounts: runtime.managedAccounts || [],
    managedAccountCount: runtime.managedAccountCount || 0,
    paperAccountId: runtime.paperAccountId || null,
    paperAccountIdMasked: runtime.paperAccountIdMasked || null,
    sessionVerified: runtime.sessionVerified === true,
    verificationMethod: runtime.verificationMethod || 'execution_runtime_singleton_956',
    nextValidId: runtime.nextValidId ?? null,
    runtimeState: runtime.runtimeState || null,
    lastConnected: runtime.lastConnected || null,
    connectedSince: runtime.connectedSince || null,
    lastHeartbeat: runtime.lastHeartbeat || null,
    lastReconnect: runtime.lastReconnect || null,
    lastReadyAt: runtime.lastReadyAt || null,
    lastReconciliationAt: runtime.lastReconciliationAt || null,
    uptime: runtime.uptime ?? runtime.uptimeMs ?? null,
    uptimeMs: runtime.uptimeMs ?? null,
    runtimeLifecycle: runtime.runtimeLifecycle || null,
    runtimeLifecycleState: runtime.runtimeLifecycleState || null,
    reconnectCount: runtime.reconnectCount || 0,
    error: runtime.error || null,
  };
}

function inferDirection(candidate = {}) {
  const explicit = safeLower(candidate.direction || candidate.nextMoveBias || candidate.side);
  if (explicit === 'long' || explicit === 'buy' || explicit === 'up' || explicit === 'bull' || explicit === 'bullish') return 'long';
  if (explicit === 'short' || explicit === 'sell' || explicit === 'down' || explicit === 'bear' || explicit === 'bearish') return 'short';
  return null;
}

function sideFromDirection(direction) {
  if (direction === 'long') return 'BUY';
  if (direction === 'short') return 'SELL';
  return null;
}

function stopLossPct({ entryPrice, stopLoss }) {
  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0) return null;
  return round((Math.abs(entry - stop) / entry) * 100, 4);
}

function riskReward({ entryPrice, stopLoss, takeProfit }) {
  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  const target = Number(takeProfit);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0 || !Number.isFinite(target) || target <= 0) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return risk > 0 && reward > 0 ? round(reward / risk, 2) : null;
}

function candidateRoot(candidate = {}) {
  return safeUpper(candidate.root || candidate.futuresSymbol || candidate.symbol || candidate.instrument);
}

function buildContract(candidate = {}, quote = null) {
  const root = candidateRoot(candidate);
  return {
    root,
    conId: safeNumber(candidate.conId ?? candidate.contract?.conId ?? quote?.conId),
    localSymbol: safeString(candidate.localSymbol || candidate.contract?.localSymbol || quote?.localSymbol) || null,
    expiry: safeString(candidate.expiry || candidate.lastTradeDateOrContractMonth || candidate.contract?.expiry || quote?.expiry) || null,
    exchange: safeString(candidate.exchange || candidate.contract?.exchange || quote?.exchange) || 'CME',
    currency: safeString(candidate.currency || candidate.contract?.currency || quote?.currency) || 'USD',
    secType: 'FUT',
  };
}

function readRuntimeStatus(options = {}) {
  if (options.executionStatus) return options.executionStatus;
  const orchestrator = options.orchestrator || ibPaperExecutionOrchestratorService.defaultIbPaperExecutionOrchestratorService;
  if (orchestrator && typeof orchestrator.getCachedExecutionStatus === 'function') {
    return orchestrator.getCachedExecutionStatus();
  }
  return null;
}

function readCandidates(options = {}) {
  if (Array.isArray(options.candidates)) return options.candidates;
  const scanner = options.scannerService || futuresPaperScannerService.defaultFuturesPaperScannerService;
  const queue = scanner && typeof scanner.getCandidates === 'function'
    ? scanner.getCandidates()
    : { candidates: [] };
  return Array.isArray(queue.candidates) ? queue.candidates : [];
}

function readQuote(root, now, options = {}) {
  if (!root) return null;
  if (options.quotesByRoot && options.quotesByRoot[root]) return options.quotesByRoot[root];
  if (Array.isArray(options.quotes)) {
    const match = options.quotes.find((row) => safeUpper(row?.root || row?.symbol) === root);
    if (match) return match;
  }
  const source = options.quoteSourceService || futuresPaperQuoteSourceService.defaultFuturesPaperQuoteSourceService;
  return source && typeof source.getQuote === 'function' ? source.getQuote(root, now) : null;
}

function buildOrderPlan(adapter, candidate, contract, direction) {
  if (!adapter || typeof adapter.buildOrderPlan !== 'function') return null;
  const executionId = `preview_${stableHash(`${candidate.candidateId || candidate.id || ''}:${candidate.strategyId || ''}:${candidateRoot(candidate)}`).slice(0, 16)}`;
  return adapter.buildOrderPlan({
    executionId,
    contract,
    side: direction,
    quantity: safeNumber(candidate.quantity ?? candidate.contracts, 1),
    entryType: safeUpper(candidate.orderType || candidate.entryOrderType || 'MKT') || 'MKT',
    limitPrice: safeNumber(candidate.limitPrice ?? candidate.entryLimitPrice),
    stopLossPrice: safeNumber(candidate.stopLossPrice ?? candidate.stopLoss),
    takeProfitPrice: safeNumber(candidate.takeProfitPrice ?? candidate.takeProfit ?? candidate.takeProfit1),
    tif: DEFAULT_TIF,
    outsideRth: true,
  });
}

function summarizePlan(orderPlan) {
  if (!orderPlan) return { ok: false, blocker: 'bracket_plan_unavailable', orderCount: 0, transmitSequence: [] };
  const legs = [orderPlan.entry, orderPlan.takeProfit, orderPlan.stopLoss].filter(Boolean);
  const transmitSequence = Array.isArray(orderPlan.transmitSequence) ? orderPlan.transmitSequence : [];
  const ok = legs.length === 3
    && orderPlan.entry?.transmit === false
    && orderPlan.takeProfit?.transmit === false
    && orderPlan.stopLoss?.transmit === true
    && transmitSequence.join('|') === 'entry:false|takeProfit:false|stopLoss:true';
  return {
    ok,
    blocker: ok ? null : 'bracket_requires_entry_take_profit_stop_loss',
    orderCount: legs.length,
    transmitSequence,
    entry: orderPlan.entry || null,
    takeProfit: orderPlan.takeProfit || null,
    stopLoss: orderPlan.stopLoss || null,
    contract: orderPlan.contract || null,
    ocaGroup: orderPlan.ocaGroup || null,
  };
}

function buildOrderPreviewCandidate(candidate = {}, context = {}) {
  const now = context.now || new Date();
  const root = candidateRoot(candidate);
  const strategyId = safeString(candidate.strategyId || candidate.strategy_id || candidate.canonicalStrategyId);
  const direction = inferDirection(candidate);
  const side = sideFromDirection(direction);
  const quantity = safeNumber(candidate.quantity ?? candidate.contracts, 1);
  const quote = context.quote || readQuote(root, now, context);
  const contract = buildContract(candidate, quote);
  const registry = context.strategyRegistryService || strategyRegistryService;
  const executionAllowlist = registry && typeof registry.canExecuteStrategy === 'function'
    ? registry.canExecuteStrategy(strategyId)
    : { allowed: false, blockedReason: 'strategy_registry_execution_allowlist_unavailable', strategyId };
  const session = futuresMarketHoursService.getCmeEquityIndexFuturesSessionState(now);
  const entryContract = (context.entryContractService || paperStrategyEntryContractService).evaluatePaperEntryContract({
    strategyId,
    candidate: {
      ...candidate,
      root,
      symbol: root,
      direction,
      side,
    },
    now,
    marketContext: {
      marketType: 'futures',
      session: session.sessionId || null,
      sessionId: session.sessionId || null,
      isMarketOpen: session.isMarketOpen === true,
    },
  });
  const runtimeStatus = context.executionStatus || null;
  const rec = runtimeStatus?.reconciliation || context.reconciliation || {};
  const accountSummary = runtimeStatus?.account ? {
    ok: runtimeStatus.account.ok === true,
    generatedAt: runtimeStatus.account.generatedAt || null,
    cacheAgeMs: runtimeStatus.account.cacheAgeMs,
    account: runtimeStatus.account,
  } : context.accountSummary || null;
  const brokerRisk = (context.brokerRiskService || ibPaperBrokerRiskService).evaluateBrokerRisk({
    root,
    quantity,
    orderType: candidate.orderType || 'MKT',
    stopLossPrice: candidate.stopLossPrice ?? candidate.stopLoss,
    quote,
    openOrders: rec.openOrders || runtimeStatus?.brokerOpenOrders || [],
    positions: rec.positions || runtimeStatus?.brokerPositions || [],
    accountSummary,
    reconciliation: rec,
    now,
  });
  const adapter = context.adapter || ibPaperExecutionAdapterService.defaultIbPaperExecutionAdapterService;
  const orderPlan = buildOrderPlan(adapter, candidate, contract, direction);
  const bracket = summarizePlan(orderPlan);
  const blockers = [
    strategyId ? null : 'strategy_id_missing',
    root ? null : 'root_missing',
    direction ? null : 'direction_missing_or_invalid',
    side ? null : 'side_missing',
    executionAllowlist.allowed === true ? null : (executionAllowlist.blockedReason || 'strategy_not_in_execution_allowlist'),
    entryContract.allowed === true ? null : (entryContract.reasonCode || entryContract.blockedReason || 'entry_contract_not_approved'),
    brokerRisk.allowed === true ? null : (brokerRisk.blockedReason || 'broker_risk_blocked'),
    bracket.ok === true ? null : bracket.blocker,
  ].filter(Boolean);
  const allowedForIbPaperPreview = blockers.length === 0;
  const entryPrice = safeNumber(candidate.entryPrice ?? candidate.referencePrice ?? quote?.price ?? quote?.last);
  const stopLoss = safeNumber(candidate.stopLossPrice ?? candidate.stopLoss);
  const takeProfit = safeNumber(candidate.takeProfitPrice ?? candidate.takeProfit ?? candidate.takeProfit1);
  const createdAt = safeString(candidate.createdAt || candidate.timestamp || nowIso(now));
  const expiresAt = safeString(candidate.expiresAt) || addMinutes(createdAt, 10);
  const blueprintId = safeString(candidate.blueprintId)
    || `ibpb_${stableHash(`${candidate.candidateId || ''}:${root}:${strategyId}:${createdAt}`).slice(0, 16)}`;

  return {
    ok: true,
    mode: 'preview_only',
    source: 'execution_runtime_pipeline_preview',
    candidateId: safeString(candidate.candidateId || candidate.id || candidate.eventId) || null,
    blueprintId,
    createdAt,
    expiresAt,
    staleAfterSeconds: 600,
    symbol: root || null,
    root: root || null,
    marketGroup: 'futures',
    assetClass: 'FUT',
    secType: 'FUT',
    exchange: contract.exchange || 'CME',
    primaryExchange: contract.exchange || 'CME',
    currency: contract.currency || 'USD',
    strategyId,
    strategyName: safeString(candidate.strategyName || candidate.strategy_name || strategyId) || null,
    direction,
    side,
    entryType: candidate.orderType || 'MKT',
    orderType: candidate.orderType || 'MKT',
    timeInForce: DEFAULT_TIF,
    entryReferencePrice: entryPrice,
    entryPrice,
    stopLoss,
    stopLossPrice: stopLoss,
    takeProfit,
    takeProfit1: takeProfit,
    takeProfit2: null,
    stopLossPct: safeNumber(candidate.stopLossPct) ?? stopLossPct({ entryPrice, stopLoss }),
    minStopLossPct: MAX_STOP_LOSS_PCT_FLOOR,
    stopLossDistancePct: safeNumber(candidate.stopLossPct) ?? stopLossPct({ entryPrice, stopLoss }),
    riskReward: safeNumber(candidate.riskReward) ?? riskReward({ entryPrice, stopLoss, takeProfit }),
    riskRewardRatio: safeNumber(candidate.riskReward) ?? riskReward({ entryPrice, stopLoss, takeProfit }),
    riskPct: safeNumber(candidate.riskPct, 0),
    riskAmount: safeNumber(candidate.riskAmount),
    quantity,
    quantityStatus: quantity > 0 ? 'calculated' : 'missing_quantity',
    estimatedNotional: entryPrice && quantity ? round(entryPrice * quantity, 2) : null,
    accountMode: 'ib_paper',
    allowedForIbPaperPreview,
    blueprintReady: allowedForIbPaperPreview,
    executionReady: allowedForIbPaperPreview,
    runtimeReady: context.runtimeReady === true,
    readyForFutureIbPaper: allowedForIbPaperPreview,
    wouldCreateOrder: false,
    wouldSendOrder: false,
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
    previewOnly: true,
    blockedExecution: allowedForIbPaperPreview !== true,
    blockedReason: blockers[0] || null,
    blockers,
    reasonSv: allowedForIbPaperPreview
      ? 'Kandidaten passerar read-only pipeline-preview. Ingen order skickas.'
      : `Blockerad: ${blockers.join(', ')}`,
    executionAllowlist,
    entryContract,
    risk: brokerRisk,
    brokerRisk,
    bracket,
    orderPlan,
    contract,
    quote,
    safety: { ...SAFETY },
  };
}

function getIbPaperOrderPreview(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const runtimeStatus = readRuntimeStatus(options);
  const readiness = options.readiness || getExecutionRuntimeReadinessSnapshot();
  const runtimeReady = readiness?.runtimeState === 'READY' || readiness?.status === 'verified' || runtimeStatus?.ready === true;
  const rawCandidates = readCandidates(options);
  const classified = rawCandidates
    .map((candidate) => buildOrderPreviewCandidate(candidate, {
      ...options,
      now,
      executionStatus: runtimeStatus,
      readiness,
      runtimeReady,
    }))
    .sort((a, b) => {
      if (a.allowedForIbPaperPreview !== b.allowedForIbPaperPreview) return a.allowedForIbPaperPreview ? -1 : 1;
      return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
    });
  const allowedCandidates = classified.filter((row) => row.allowedForIbPaperPreview);
  const blockedCandidates = classified.filter((row) => !row.allowedForIbPaperPreview);
  const visibleAllowedCandidates = allowedCandidates.slice(0, PREVIEW_LIMIT);
  const visibleBlockedCandidates = blockedCandidates.slice(0, Math.max(0, PREVIEW_LIMIT - visibleAllowedCandidates.length));
  const visibleCandidates = [...visibleAllowedCandidates, ...visibleBlockedCandidates];

  return {
    ok: true,
    mode: 'preview_only',
    source: 'execution_runtime_pipeline_preview',
    maxPerDay: PREVIEW_LIMIT,
    executionEnabled: runtimeStatus?.executionEnabled === true,
    orderQueueEnabled: false,
    brokerExecutionEnabled: runtimeStatus?.paperBrokerExecutionEnabled === true || runtimeStatus?.executionEnabled === true,
    liveTradingEnabled: false,
    orderSendingBlocked: true,
    wouldCreateIbPaperOrder: false,
    requiredStopLossMinPct: MAX_STOP_LOSS_PCT_FLOOR,
    stopLossPolicy: 'Minst 0.10 % krav kontrolleras via Entry Contract/Risk/Bracket pipeline.',
    readiness,
    runtimeStatus: runtimeStatus ? {
      status: runtimeStatus.status || null,
      ready: runtimeStatus.ready === true,
      executionConnected: runtimeStatus.executionConnected === true,
      nextValidId: runtimeStatus.nextValidId ?? null,
      paperAccountVerified: runtimeStatus.paperAccountVerified === true,
      reconciliation: runtimeStatus.reconciliation || null,
    } : null,
    candidates: visibleCandidates,
    visibleCandidates,
    allowedCandidates,
    blockedCandidates,
    allCandidates: classified,
    generatedAt: nowIso(now),
    summary: {
      totalCandidates: classified.length,
      totalScanned: classified.length,
      allowedCandidates: allowedCandidates.length,
      blockedCandidates: blockedCandidates.length,
      allowedVisibleCount: visibleAllowedCandidates.length,
      blockedVisibleCount: visibleBlockedCandidates.length,
      availableAllowedCandidates: allowedCandidates.length,
      availableBlockedCandidates: blockedCandidates.length,
      previewSource: 'futuresPaperScannerService.getCandidates',
      pipeline: ['execution_runtime', 'strategy_registry', 'risk', 'entry_contract', 'bracket_plan'],
    },
    safety: { ...SAFETY },
  };
}

function getIbPaperStatus() {
  const flags = getFeatureFlags();
  const registry = strategyRegistryService.getStatus();
  const executableStrategies = (registry.strategies || []).filter((row) => (
    row.enabled !== false && row.status === 'active'
  ));
  const blockedReason = flags.previewEnabled ? 'shadow_mode_read_only' : 'feature_flag_disabled';

  return {
    ok: true,
    dryRun: true,
    ibPaper: {
      enabled: false,
      previewEnabled: flags.previewEnabled,
      orderQueueEnabled: flags.orderQueueEnabled,
      executionEnabled: flags.executionEnabled,
    },
    safety: { ...SAFETY },
    orderSendingBlocked: true,
    orderQueueBlocked: true,
    executionBlocked: true,
    wouldCreateIbPaperOrder: false,
    blockedReason,
    nextPhaseLocked: { ...NEXT_PHASE_LOCKED },
    connection: buildConnectionSummary(),
    registryStrategies: executableStrategies,
    registryStrategyCount: executableStrategies.length,
    registrySource: 'strategyRegistryService.getStatus',
    internalPaperTradingUnaffected: true,
    note: 'Read-only IB Paper preview sourced from Strategy Registry and the execution runtime singleton.',
  };
}

function getApprovedStrategiesPreview() {
  const flags = getFeatureFlags();
  const registry = strategyRegistryService.getStatus();
  const executableStrategies = (registry.strategies || []).filter((row) => (
    row.enabled !== false && row.status === 'active'
  ));

  return {
    ok: true,
    dryRun: true,
    previewEnabled: flags.previewEnabled,
    degraded: registry.ok === false,
    safety: { ...SAFETY },
    registryStrategies: executableStrategies,
    registryStrategyCount: executableStrategies.length,
    registrySource: 'strategyRegistryService.getStatus',
    wouldCreateIbPaperOrder: false,
    orderSendingBlocked: true,
    blockedReason: flags.previewEnabled ? 'shadow_mode_read_only' : 'feature_flag_disabled',
    internalPaperTradingUnaffected: true,
    note: 'Legacy strategy approval is retired for execution. This endpoint shows Strategy Registry execution allowlist state only.',
  };
}

module.exports = {
  SAFETY,
  NEXT_PHASE_LOCKED,
  getFeatureFlags,
  getConnectionConfig,
  getConnectionReadiness,
  getIbPaperStatus,
  getApprovedStrategiesPreview,
  getIbPaperOrderPreview,
  _internal: {
    safeUpper,
    safeLower,
    isPaperAccountId,
    buildVerificationBase,
    buildVerificationResult,
    inferDirection,
    buildOrderPreviewCandidate,
    summarizePlan,
  },
};
