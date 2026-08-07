'use strict';

const crypto = require('crypto');

const configService = require('./ibPaperExecutionConfigService');
const adapterModule = require('./ibPaperExecutionAdapterService');
const intentServiceModule = require('./ibPaperExecutionIntentService');
const guardService = require('./ibPaperExecutionGuardService');
const brokerRiskService = require('./ibPaperBrokerRiskService');
const reconciliationModule = require('./ibPaperBrokerReconciliationService');
const futuresMarketDataService = require('./futuresMarketDataService');
const futuresPaperQuoteSourceService = require('./futuresPaperQuoteSourceService');
const futuresPaperScannerService = require('./futuresPaperScannerService');
const strategyRegistryService = require('./strategyRegistryService');
const canonicalExecutionRouter = require('./canonical/canonicalExecutionRouter');
const ibPaperAccountSummaryService = require('./ibPaperAccountSummaryService');
const futuresMarketHoursService = require('./futuresMarketHoursService');
const executionTargetReservationModule = require('./futuresPaperExecutionTargetReservationService');
const lifecycleIdentity = require('./futuresLifecycleIdentityService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'ib_paper_execution_orchestrator',
});
const DEFAULT_ACCOUNT_SUMMARY_REFRESH_TIMEOUT_MS = 8_000;

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeUpper(value) {
  return safeString(value).toUpperCase();
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sideFromCandidate(candidate = {}) {
  const raw = safeString(candidate.direction || candidate.side || candidate.entrySide || candidate.action).toLowerCase();
  if (['long', 'buy', 'bull', 'bullish', 'up'].includes(raw)) return 'long';
  if (['short', 'sell', 'bear', 'bearish', 'down'].includes(raw)) return 'short';
  return null;
}

  function candidateTimestamp(candidate = {}) {
    return candidate.signalTimestamp
      || candidate.timestamp
      || candidate.createdAt
      || candidate.candidateTimestamp
      || null;
  }

  function isSelectableQueueCandidate(candidate = {}) {
    const status = safeUpper(candidate.status || 'READY_WAITING_FOR_SIGNAL');
    return status === 'READY_WAITING_FOR_SIGNAL'
      && !candidate.claimedAt
      && !candidate.claimedBy
      && !candidate.consumedAt
      && !candidate.completedAt
      && !candidate.expiredAt;
  }

function ageMsFromTimestamp(ts, now = new Date()) {
  const parsed = Date.parse(ts || '');
  const current = new Date(now).getTime();
  if (!Number.isFinite(parsed) || !Number.isFinite(current)) return null;
  return Math.max(0, current - parsed);
}

function ageMsFromGeneratedAt(generatedAt, now = new Date()) {
  const parsed = Date.parse(generatedAt || '');
  const current = new Date(now).getTime();
  if (!Number.isFinite(parsed) || !Number.isFinite(current)) return null;
  return Math.max(0, current - parsed);
}

function withCacheAge(summary, now = new Date()) {
  if (!summary || typeof summary !== 'object') return summary;
  const explicitAge = safeNumber(summary.cacheAgeMs ?? summary.ageMs);
  const generatedAge = explicitAge == null ? ageMsFromGeneratedAt(summary.generatedAt, now) : null;
  return {
    ...summary,
    cacheAgeMs: explicitAge ?? generatedAge,
  };
}

const RUNTIME_ACCOUNT_FIELDS = Object.freeze([
  'netLiquidation',
  'totalCashValue',
  'availableFunds',
  'buyingPower',
  'realizedPnl',
  'unrealizedPnl',
  'dailyPnl',
  'maintMarginReq',
  'initMarginReq',
  'cushion',
]);

function mergeRuntimeAccountSummary(primary, supplemental, {
  now = new Date(),
  maxAgeMs = null,
} = {}) {
  const base = withCacheAge(primary, now);
  const extra = withCacheAge(supplemental, now);
  if (!base || base.ok !== true || !base.account) return extra || base;
  if (!extra || extra.ok !== true || !extra.account) return base;
  const baseAccountId = safeString(base.account.accountIdMasked);
  const extraAccountId = safeString(extra.account.accountIdMasked);
  if (baseAccountId && extraAccountId && baseAccountId !== extraAccountId) return base;
  const extraAgeMs = safeNumber(extra.cacheAgeMs ?? extra.ageMs) ?? ageMsFromGeneratedAt(extra.generatedAt, now);
  if (Number.isFinite(Number(maxAgeMs)) && extraAgeMs != null && extraAgeMs > Number(maxAgeMs)) return base;
  const account = { ...base.account };
  let enriched = false;
  for (const field of RUNTIME_ACCOUNT_FIELDS) {
    if (account[field] == null && extra.account[field] != null) {
      account[field] = extra.account[field];
      enriched = true;
    }
  }
  if (!enriched) return base;
  return {
    ...base,
    account,
    supplementalAccountSummarySource: extra.snapshotSource || extra.source || extra.supplementalAccountSummarySource || null,
    supplementalAccountSummaryGeneratedAt: extra.generatedAt || null,
  };
}

// IBKR känner inte till strategier. Broker-raderna (executions, open orders,
// orderStatuses) bär bara orderRef — och orderRef bär vårt executionId. Det är
// den enda bryggan tillbaka till intenten, som äger strategyId/candidateId.
//
// Attributionen görs här, vid den enda punkt där broker-raderna föds, så att
// varje konsument (API, dashboard, analytics, historik) ser samma strategyId
// som backend. Parsningen återanvänder reconciliation-tjänstens egen
// executionIdFromOrderRef — ingen egen kopia av formatet.
//
// Helt additiv: befintliga fält rörs aldrig, och en rad utan matchande intent
// får null i stället för att gissa. Ingen strategi-specifik logik.
function attributeBrokerRows(rows, intents) {
  if (!Array.isArray(rows) || !rows.length) return Array.isArray(rows) ? rows : [];
  const byExecutionId = new Map();
  for (const intent of Array.isArray(intents) ? intents : []) {
    const executionId = intent?.executionId || intent?.intent?.executionId;
    if (!executionId || byExecutionId.has(executionId)) continue;
    byExecutionId.set(executionId, intent);
  }
  return rows.map((row) => {
    const orderRef = reconciliationModule.orderRefOf(row);
    const executionId = reconciliationModule.executionIdFromOrderRef(orderRef);
    const intent = executionId ? byExecutionId.get(executionId) || null : null;
    const inner = intent?.intent || {};
    const identity = lifecycleIdentity.mergeIdentity(row, intent, inner);
    return {
      ...row,
      lifecycleId: row.lifecycleId || identity.lifecycleId || null,
      executionId: row.executionId || executionId || null,
      strategyId: row.strategyId || intent?.strategyId || inner.strategyId || null,
      candidateId: row.candidateId || intent?.candidateId || inner.candidateId || null,
      signalId: row.signalId || intent?.signalId || inner.signalId || null,
      intentId: row.intentId || intent?.intentId || inner.intentId || intent?.idempotencyKey || inner.idempotencyKey || null,
      idempotencyKey: row.idempotencyKey || intent?.idempotencyKey || inner.idempotencyKey || null,
    };
  });
}

function buildExecutionId(seed) {
  return `fxp_${crypto.createHash('sha256').update(String(seed || `${Date.now()}:${Math.random()}`)).digest('hex').slice(0, 16)}`;
}

function normalizeCandidate(input = {}) {
  const candidate = input && typeof input === 'object' ? input : {};
  const root = safeUpper(candidate.root || candidate.symbol || candidate.instrument);
  const strategyId = safeString(candidate.strategyId || candidate.strategy_id || candidate.canonicalStrategyId);
  const direction = sideFromCandidate(candidate);
  const signalTimestamp = candidateTimestamp(candidate);
  const signalSubtype = candidate.signalSubtype
    || candidate.signal_subtype
    || candidate.subtype
    || candidate.entrySubtype
    || candidate.patternSubtype
    || null;
  const signalStatus = candidate.signalStatus || candidate.signal_status || candidate.status || candidate.priority || null;
  const normalized = { ...candidate };

  if (!Object.prototype.hasOwnProperty.call(normalized, 'candidateId')) {
    normalized.candidateId = safeString(candidate.candidateId || candidate.id || candidate.eventId);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lifecycleId')) {
    normalized.lifecycleId = lifecycleIdentity.identityFrom(normalized).lifecycleId;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'signalId')) {
    normalized.signalId = safeString(candidate.signalId || candidate.originalSignalId);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'originalSignalId')) {
    normalized.originalSignalId = safeString(candidate.originalSignalId || candidate.signalId);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'signalStatus') && signalStatus != null) {
    normalized.signalStatus = signalStatus;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'signalSubtype') && signalSubtype != null) {
    normalized.signalSubtype = signalSubtype;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'signal_subtype') && signalSubtype != null) {
    normalized.signal_subtype = signalSubtype;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'subtype') && signalSubtype != null) {
    normalized.subtype = signalSubtype;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'dataFreshness')) {
    normalized.dataFreshness = candidate.dataFreshness || null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'market')) {
    normalized.market = candidate.market || null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'marketType')) {
    normalized.marketType = candidate.marketType || candidate.market || null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'sessionId')) {
    normalized.sessionId = candidate.sessionId || candidate.sessionMetadata?.sessionId || null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'session')) {
    normalized.session = candidate.session || candidate.sessionMetadata?.session || null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'sessionMetadata')) {
    normalized.sessionMetadata = candidate.sessionMetadata || null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'closedCandleConfirmed')) {
    const explicitClosedCandle = candidate.closedCandleConfirmed
      ?? candidate.hasClosedCandle
      ?? candidate.closedCandle
      ?? candidate.confirmation?.closedCandle
      ?? candidate.candleConfirmation?.closedCandle
      ?? candidate.bar?.closed;
    if (explicitClosedCandle !== undefined) {
      normalized.closedCandleConfirmed = explicitClosedCandle;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'latestCandleClosed')) {
    const explicitLatestCandleClosed = candidate.latestCandleClosed
      ?? candidate.closedCandleConfirmed
      ?? candidate.hasClosedCandle
      ?? candidate.closedCandle
      ?? candidate.confirmation?.closedCandle
      ?? candidate.candleConfirmation?.closedCandle
      ?? candidate.bar?.closed;
    if (explicitLatestCandleClosed !== undefined) {
      normalized.latestCandleClosed = explicitLatestCandleClosed;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'twoMinuteConfirmation')) {
    const explicitTwoMinute = candidate.twoMinuteConfirmation
      ?? candidate.twoMinuteConfirmed
      ?? candidate.confirmation?.twoMinuteConfirmed
      ?? candidate.confirmation?.twoMinuteConfirmation
      ?? candidate.timeframeAgreement?.confirmed;
    if (explicitTwoMinute !== undefined) {
      normalized.twoMinuteConfirmation = explicitTwoMinute;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'emaPullbackConfirmation')) {
    const explicitEmaPullback = candidate.emaPullbackConfirmation
      ?? candidate.emaReclaimConfirmed
      ?? candidate.pullbackReclaimConfirmed
      ?? candidate.reclaimConfirmed
      ?? candidate.confirmation?.emaPullbackConfirmed
      ?? candidate.confirmation?.emaReclaimConfirmed
      ?? candidate.confirmation?.pullbackReclaimConfirmed
      ?? candidate.confirmation?.reclaimConfirmed;
    if (explicitEmaPullback !== undefined) {
      normalized.emaPullbackConfirmation = explicitEmaPullback;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'vwapReclaimConfirmation')) {
    const explicitVwapReclaim = candidate.vwapReclaimConfirmation
      ?? candidate.vwapReclaimConfirmed
      ?? candidate.reclaimConfirmed
      ?? candidate.confirmation?.vwapReclaimConfirmed
      ?? candidate.confirmation?.reclaimConfirmed
      ?? candidate.vwapContext?.reclaimConfirmed;
    if (explicitVwapReclaim !== undefined) {
      normalized.vwapReclaimConfirmation = explicitVwapReclaim;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'volumeConfirmation')) {
    const explicitVolume = candidate.volumeConfirmation
      ?? candidate.volumeConfirmed
      ?? candidate.volumeExpansionConfirmed
      ?? candidate.confirmation?.volumeConfirmed
      ?? candidate.volumeContext?.confirmed
      ?? candidate.volumeContext?.expansionConfirmed;
    if (explicitVolume !== undefined) {
      normalized.volumeConfirmation = explicitVolume;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'confidence')) {
    normalized.confidence = candidate.confidence ?? null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'nextMoveBias')) {
    normalized.nextMoveBias = candidate.nextMoveBias || candidate.next_move_bias || direction;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'root') && root) {
    normalized.root = root;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'symbol') && root) {
    normalized.symbol = root;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'strategyId')) {
    normalized.strategyId = strategyId;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'direction') && direction) {
    normalized.direction = direction;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'signalTimestamp') && signalTimestamp) {
    normalized.signalTimestamp = signalTimestamp;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'candleTimestamp')) {
    normalized.candleTimestamp = candidate.candleTimestamp || candidate.barTimestamp || signalTimestamp;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'timestamp')) {
    normalized.timestamp = candidate.timestamp || signalTimestamp;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'createdAt')) {
    normalized.createdAt = candidate.createdAt || signalTimestamp;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'quantity')) {
    normalized.quantity = 1;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'orderType')) {
    normalized.orderType = safeUpper(candidate.orderType || candidate.entryOrderType || 'MKT');
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'limitPrice')) {
    normalized.limitPrice = safeNumber(candidate.limitPrice ?? candidate.entryLimitPrice);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'stopLossPrice')) {
    normalized.stopLossPrice = safeNumber(candidate.stopLossPrice ?? candidate.stopLoss ?? candidate.stop);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'takeProfitPrice')) {
    normalized.takeProfitPrice = safeNumber(candidate.takeProfitPrice ?? candidate.takeProfit ?? candidate.takeProfit1);
  }

  return normalized;
}

function sanitizeOrderPlan(orderPlan, accountMasked = null, identity = {}) {
  if (!orderPlan) return null;
  const identityFields = lifecycleIdentity.compact(identity);
  return {
    ...identityFields,
    environment: orderPlan.environment,
    contract: orderPlan.contract,
    entry: orderPlan.entry,
    stopLoss: orderPlan.stopLoss,
    takeProfit: orderPlan.takeProfit,
    ocaGroup: orderPlan.ocaGroup,
    transmitSequence: orderPlan.transmitSequence,
    protectiveModel: orderPlan.protectiveModel,
    accountMasked,
    paperOnly: true,
  };
}

function createIbPaperExecutionOrchestratorService(options = {}) {
  const adapter = options.adapter || adapterModule.defaultIbPaperExecutionAdapterService;
  const intentService = options.intentService || intentServiceModule.defaultIbPaperExecutionIntentService;
  const marketData = options.marketDataService || futuresMarketDataService.defaultFuturesMarketDataService;
  const quoteSource = options.quoteSourceService || futuresPaperQuoteSourceService.defaultFuturesPaperQuoteSourceService;
	  const scanner = options.scannerService || futuresPaperScannerService.defaultFuturesPaperScannerService;
		  const accountSummaryService = options.accountSummaryService || ibPaperAccountSummaryService.defaultIbPaperAccountSummaryService;
		  const strategyRegistry = options.strategyRegistryService || strategyRegistryService;
	  const executionRouter = options.executionRouterService || canonicalExecutionRouter;
	  const executionTargetReservations = options.executionTargetReservationService
	    || executionTargetReservationModule.defaultFuturesPaperExecutionTargetReservationService;
  const reconciliation = options.reconciliationService
    || reconciliationModule.createIbPaperBrokerReconciliationService({ adapter, intentService });
  const statusCacheTtlMs = Number(options.statusCacheTtlMs || 1_000);
  const accountSummaryRefreshTimeoutMs = Number.isFinite(Number(options.accountSummaryRefreshTimeoutMs))
    ? Math.max(1, Number(options.accountSummaryRefreshTimeoutMs))
    : DEFAULT_ACCOUNT_SUMMARY_REFRESH_TIMEOUT_MS;
  let statusCache = null;
  let statusInflight = null;

  function selectCandidate(candidateId = null, candidateInput = null) {
    if (candidateInput && typeof candidateInput === 'object') {
      return { candidate: normalizeCandidate(candidateInput), source: 'claimed_candidate' };
    }
    const queue = scanner.getCandidates();
    const rows = Array.isArray(queue.candidates) ? queue.candidates : [];
    const selectableRows = rows.filter(isSelectableQueueCandidate);
    const requestedId = safeString(candidateId);
    const candidate = requestedId
      ? selectableRows.find((row) => safeString(row.candidateId || row.id || row.eventId) === requestedId)
      : selectableRows[0];
    return candidate
      ? { candidate: normalizeCandidate(candidate), source: 'futures_candidate_queue' }
      : { candidate: null, source: requestedId ? 'candidate_id_not_found' : 'none' };
  }

  async function resolveContract(root) {
    if (!root) return { ok: false, error: 'root_missing' };
    if (!marketData.isEnabled()) return { ok: false, error: 'ib_futures_data_disabled' };
    return marketData.adapter.resolveContract(root);
  }

  function buildBlockedAccountSummary(blocker = 'paper_account_summary_not_ready') {
    return {
      ok: false,
      status: 'pending',
      blocker,
      account: null,
      generatedAt: nowIso(),
    };
  }

  function readRuntimeAccountSummary(now = new Date()) {
    const limits = configService.getPilotLimits();
    let adapterSummary = null;
    if (typeof adapter.getAccountSummary === 'function') {
      const summary = adapter.getAccountSummary();
      if (summary && typeof summary === 'object') adapterSummary = summary;
    }
    let cachedSummary = null;
    if (typeof accountSummaryService.getCachedSummary === 'function') {
      cachedSummary = accountSummaryService.getCachedSummary();
    }
    return mergeRuntimeAccountSummary(adapterSummary, cachedSummary, {
      now,
      maxAgeMs: limits.maxAccountSummaryAgeMs,
    });
  }

  async function readFreshRuntimeAccountSummary(adapterStatus = {}, now = new Date()) {
    let summary = readRuntimeAccountSummary(now);
    const limits = configService.getPilotLimits();
    const ageMs = safeNumber(summary?.cacheAgeMs);
    const stale = !summary || summary.ok !== true || summary.stale === true || ageMs == null || ageMs > limits.maxAccountSummaryAgeMs;
    const ready = adapterStatus.ready === true || adapterStatus.connectionState === 'READY';
    if (stale && ready && typeof adapter.refreshAccountSummary === 'function') {
      let timeoutHandle = null;
      try {
        const timeoutResult = { ok: false, timeout: true, blocker: 'runtime_account_summary_refresh_timeout' };
        const timeoutPromise = new Promise((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timeoutResult), accountSummaryRefreshTimeoutMs);
          if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
        });
        const refreshed = await Promise.race([adapter.refreshAccountSummary(), timeoutPromise]);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (refreshed?.timeout === true) {
          summary = withCacheAge(summary, now);
          if (summary && typeof summary === 'object') {
            summary = {
              ...summary,
              stale: true,
              degraded: true,
              degradedReason: 'runtime_account_summary_refresh_timeout_returning_cache',
            };
          } else {
            summary = buildBlockedAccountSummary('runtime_account_summary_refresh_timeout');
          }
          return summary;
        }
        summary = withCacheAge(refreshed, now);
      } catch (_) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        summary = withCacheAge(summary, now);
        if (summary && typeof summary === 'object') {
          summary = {
            ...summary,
            stale: true,
            degraded: true,
            degradedReason: 'runtime_account_summary_refresh_failed_returning_cache',
          };
        }
      }
    }
    return summary;
  }

  async function reconcileRuntime({ force = false } = {}) {
    const adapterStatus = adapter.getStatus();
    if (adapterStatus.ready !== true && adapterStatus.connectionState !== 'READY') {
      return reconciliation.getCachedReconciliation();
    }
    const snapshot = await reconciliation.reconcilePaperBroker({ force });
    if (typeof adapter.markReconciled === 'function') adapter.markReconciled();
    return snapshot;
  }

  async function startRuntime() {
    const flags = configService.getFlags();
    if (!flags.executionEnabled) {
      return { ok: false, error: 'ibkr_paper_execution_disabled', flags, ...SAFETY };
    }
    const connectionAttempt = typeof adapter.startPermanentRuntime === 'function'
      ? await adapter.startPermanentRuntime()
      : await adapter.connectPaperExecutionClient();
    if (connectionAttempt?.ready === true || connectionAttempt?.state === 'READY') {
      await reconcileRuntime({ force: true });
    }
    await buildExecutionStatus({ force: true });
    return { ok: connectionAttempt?.ok === true, connectionAttempt, flags, ...SAFETY };
  }

  function getRuntimeReadinessSnapshot() {
    if (typeof adapter.getConnectionReadinessSnapshot === 'function') {
      return adapter.getConnectionReadinessSnapshot();
    }
    const adapterStatus = typeof adapter.getStatus === 'function' ? adapter.getStatus() : {};
    const runtimeState = adapterStatus.connectionState || adapterStatus.state || (adapterStatus.connected ? 'CONNECTED' : 'DISCONNECTED');
    const managedAccounts = Array.isArray(adapterStatus.managedAccounts)
      ? adapterStatus.managedAccounts.map((row) => row?.accountIdMasked || row).filter(Boolean)
      : [];
    const ready = adapterStatus.ready === true || runtimeState === 'READY';
    return {
      ...SAFETY,
      ok: true,
      dryRun: true,
      source: 'ib_paper_execution_runtime_singleton',
      runtimeState,
      gatewayReachable: adapterStatus.connected === true || ready,
      status: ready ? 'verified' : String(runtimeState || 'DISCONNECTED').toLowerCase(),
      blockedReason: ready ? 'read_only_session_verified' : 'execution_runtime_not_ready',
      paperMode: ready ? 'paper_only' : 'unknown',
      paperModeVerified: ready,
      ibApiVerified: adapterStatus.nextValidIdReady === true,
      paperAccountVerified: ready,
      managedAccounts,
      managedAccountCount: managedAccounts.length,
      paperAccountId: null,
      sessionVerified: ready,
	      verificationMethod: 'execution_runtime_singleton_956',
	      nextValidId: adapterStatus.nextValidId ?? null,
	      lastConnected: adapterStatus.lastConnected || null,
      connectedSince: adapterStatus.connectedSince || adapterStatus.connectedAt || null,
      runtimeStartedAt: adapterStatus.runtimeStartedAt || null,
	      lastHeartbeat: adapterStatus.lastHeartbeat || null,
	      lastReconnect: adapterStatus.lastReconnect || null,
	      lastReadyAt: adapterStatus.lastReadyAt || null,
      lastReconciliationAt: adapterStatus.lastReconciliationAt || null,
      uptimeMs: adapterStatus.uptimeMs ?? null,
      uptime: adapterStatus.uptime ?? adapterStatus.uptimeMs ?? null,
      runtimeUptimeMs: adapterStatus.runtimeUptimeMs ?? adapterStatus.uptimeMs ?? null,
      connectionUptimeMs: adapterStatus.connectionUptimeMs ?? null,
      runtimeLifecycle: adapterStatus.runtimeLifecycle || null,
      runtimeLifecycleState: adapterStatus.runtimeLifecycleState || null,
	      reconnectCount: adapterStatus.reconnectCount || 0,
      orderSendingBlocked: true,
      wouldCreateIbPaperOrder: false,
      internalPaperTradingUnaffected: true,
      passwordStored: false,
    };
  }

	  function getCachedExecutionStatus() {
	    if (statusCache?.payload) {
	      return { ...statusCache.payload, cached: true, cacheAgeMs: Date.now() - statusCache.atMs };
	    }
	    const adapterStatus = typeof adapter.getStatus === 'function' ? adapter.getStatus() : {};
    const runtimeReadiness = getRuntimeReadinessSnapshot();
	    return {
	      ok: true,
	      generatedAt: nowIso(),
	      status: configService.getFlags().executionEnabled ? 'pending' : 'disabled',
	      runtimeState: adapterStatus.connectionState || adapterStatus.state || (adapterStatus.connected ? 'CONNECTED' : 'DISCONNECTED'),
	      executionRuntimeState: adapterStatus.connectionState || adapterStatus.state || (adapterStatus.connected ? 'CONNECTED' : 'DISCONNECTED'),
      runtimeReadiness,
      readiness: runtimeReadiness,
      connectionReadiness: runtimeReadiness,
	      executionClient: adapterStatus,
	      executionConnected: adapterStatus.ready === true || adapterStatus.connected === true,
	      nextValidId: adapterStatus.nextValidId ?? null,
	      nextValidIdReady: adapterStatus.nextValidIdReady === true,
	      managedAccounts: adapterStatus.managedAccounts || [],
	      managedAccountCount: adapterStatus.managedAccountCount ?? (Array.isArray(adapterStatus.managedAccounts) ? adapterStatus.managedAccounts.length : 0),
      connectedSince: adapterStatus.connectedSince || adapterStatus.connectedAt || runtimeReadiness.connectedSince || null,
      lastHeartbeat: adapterStatus.lastHeartbeat || runtimeReadiness.lastHeartbeat || null,
      lastReconnect: adapterStatus.lastReconnect || runtimeReadiness.lastReconnect || null,
      uptimeMs: adapterStatus.uptimeMs ?? runtimeReadiness.uptimeMs ?? null,
      uptime: adapterStatus.uptime ?? runtimeReadiness.uptime ?? adapterStatus.uptimeMs ?? null,
      reconnectCount: adapterStatus.reconnectCount ?? runtimeReadiness.reconnectCount ?? 0,
      runtimeLifecycle: adapterStatus.runtimeLifecycle || runtimeReadiness.runtimeLifecycle || null,
      runtimeLifecycleState: adapterStatus.runtimeLifecycleState || runtimeReadiness.runtimeLifecycleState || null,
	      ...SAFETY,
	    };
	  }

  async function buildExecutionStatus({ force = false } = {}) {
    const cachedAge = statusCache ? Date.now() - statusCache.atMs : null;
    if (!force && statusCache && cachedAge != null && cachedAge <= statusCacheTtlMs) {
      return { ...statusCache.payload, cached: true, cacheAgeMs: cachedAge };
    }
    if (!force && statusInflight) return statusInflight;
    statusInflight = (async () => {
	    const flags = configService.getFlags();
	    const connectionAttempt = null;
	    const adapterStatus = adapter.getStatus();
    const runtimeReadiness = getRuntimeReadinessSnapshot();
      const statusNow = new Date();
	    const runtimeAccountSummary = await readFreshRuntimeAccountSummary(adapterStatus, statusNow);
    const accountSummary = runtimeAccountSummary || buildBlockedAccountSummary();
    const accountOk = accountSummary?.ok === true;
    const verification = adapter.verifyPaperAccount(accountSummary?.account?.accountIdMasked || null);
    const rec = adapterStatus.ready === true || adapterStatus.connectionState === 'READY'
      ? await reconcileRuntime({ force: false })
      : reconciliation.getCachedReconciliation();
    const safety = configService.buildSafetyView();
    const brokerIntents = Array.isArray(rec.intents) ? rec.intents : [];
    const brokerOpenOrders = attributeBrokerRows(Array.isArray(rec.openOrders) ? rec.openOrders : [], brokerIntents);
    const brokerExecutions = attributeBrokerRows(Array.isArray(rec.executions) ? rec.executions : [], brokerIntents);
    const brokerPositions = Array.isArray(rec.positions) ? rec.positions : [];
    const brokerOrderStatuses = attributeBrokerRows(Array.isArray(rec.orderStatuses) ? rec.orderStatuses : [], brokerIntents);
    const brokerCommissions = typeof adapter.getCommissions === 'function' ? adapter.getCommissions() : [];
    const payload = {
      ok: true,
      generatedAt: nowIso(),
      status: !flags.executionEnabled ? 'disabled' : (flags.shadowMode ? 'shadow' : (flags.submissionEnabled ? 'pilot' : 'paused')),
	      runtimeState: adapterStatus.connectionState || adapterStatus.state || (adapterStatus.connected ? 'CONNECTED' : 'DISCONNECTED'),
	      executionRuntimeState: adapterStatus.connectionState || adapterStatus.state || (adapterStatus.connected ? 'CONNECTED' : 'DISCONNECTED'),
      runtimeReadiness,
      readiness: runtimeReadiness,
      connectionReadiness: runtimeReadiness,
	      flags,
      safety: {
        ...safety,
        verifiedPaperAccount: verification.ok === true && accountSummary?.ok === true,
        liveAccountBlocked: verification.live_account_detected !== true,
      },
      clientIds: configService.getExecutionClientConfig(),
	      executionClient: adapterStatus,
	      executionConnected: adapterStatus.ready === true || adapterStatus.connected === true,
	      nextValidId: adapterStatus.nextValidId ?? null,
	      nextValidIdReady: adapterStatus.nextValidIdReady === true,
	      managedAccounts: adapterStatus.managedAccounts || [],
	      managedAccountCount: adapterStatus.managedAccountCount ?? (Array.isArray(adapterStatus.managedAccounts) ? adapterStatus.managedAccounts.length : 0),
      connectedSince: adapterStatus.connectedSince || adapterStatus.connectedAt || runtimeReadiness.connectedSince || null,
      lastHeartbeat: adapterStatus.lastHeartbeat || runtimeReadiness.lastHeartbeat || null,
      lastReconnect: adapterStatus.lastReconnect || runtimeReadiness.lastReconnect || null,
      lastReadyAt: adapterStatus.lastReadyAt || runtimeReadiness.lastReadyAt || null,
      lastReconciliationAt: adapterStatus.lastReconciliationAt || runtimeReadiness.lastReconciliationAt || null,
      uptimeMs: adapterStatus.uptimeMs ?? runtimeReadiness.uptimeMs ?? null,
      uptime: adapterStatus.uptime ?? runtimeReadiness.uptime ?? adapterStatus.uptimeMs ?? null,
      runtimeUptimeMs: adapterStatus.runtimeUptimeMs ?? runtimeReadiness.runtimeUptimeMs ?? adapterStatus.uptimeMs ?? null,
      connectionUptimeMs: adapterStatus.connectionUptimeMs ?? runtimeReadiness.connectionUptimeMs ?? null,
      reconnectCount: adapterStatus.reconnectCount ?? runtimeReadiness.reconnectCount ?? 0,
      runtimeLifecycle: adapterStatus.runtimeLifecycle || runtimeReadiness.runtimeLifecycle || null,
      runtimeLifecycleState: adapterStatus.runtimeLifecycleState || runtimeReadiness.runtimeLifecycleState || null,
      account: {
        ok: accountOk,
        blocker: accountSummary?.blocker || verification.blocker || null,
        stale: accountSummary?.stale === true,
        degraded: accountOk !== true || accountSummary?.degraded === true || accountSummary?.stale === true,
        degradedReason: accountSummary?.degradedReason
          || (accountOk !== true ? (accountSummary?.blocker || verification.blocker || 'account_summary_unavailable') : null),
        accountIdMasked: accountSummary?.account?.accountIdMasked || verification.accountIdMasked || null,
        classification: accountSummary?.account?.classification || verification.classification || null,
        currency: accountSummary?.account?.currency || null,
        netLiquidation: accountSummary?.account?.netLiquidation ?? null,
        totalCashValue: accountSummary?.account?.totalCashValue ?? null,
        availableFunds: accountSummary?.account?.availableFunds ?? null,
        buyingPower: accountSummary?.account?.buyingPower ?? null,
        realizedPnl: accountSummary?.account?.realizedPnl ?? null,
        unrealizedPnl: accountSummary?.account?.unrealizedPnl ?? null,
        dailyPnl: accountSummary?.account?.dailyPnl ?? null,
        cacheAgeMs: accountSummary?.cacheAgeMs ?? ageMsFromGeneratedAt(accountSummary?.generatedAt, statusNow),
	        generatedAt: accountSummary?.generatedAt || null,
	      },
	      paperAccountVerified: verification.ok === true && accountOk === true,
	      verifiedPaperAccount: verification.ok === true && accountOk === true,
      liveAccountBlocked: verification.live_account_detected !== true,
      liveAccountDetected: verification.live_account_detected === true,
	      orderSubmissionMode: flags.orderSubmissionMode,
      orderSendingBlocked: true,
      wouldCreateIbPaperOrder: false,
      can_place_orders: false,
      actions_allowed: false,
	      paperBrokerExecutionEnabled: flags.executionEnabled,
      liveBrokerExecutionEnabled: false,
      reconciliation: {
        status: rec.status,
        degraded: rec.degraded === true,
        newEntriesAllowed: rec.newEntriesAllowed === true,
        blockedReason: rec.blockedReason || null,
        counts: rec.counts || {},
        discrepancies: rec.discrepancies || [],
        generatedAt: rec.generatedAt || null,
        openOrders: brokerOpenOrders,
        executions: brokerExecutions,
        positions: brokerPositions,
        orderStatuses: brokerOrderStatuses,
        commissions: brokerCommissions,
      },
      brokerOpenOrders,
      brokerOrders: brokerOpenOrders,
      brokerExecutions,
      brokerFills: brokerExecutions,
      brokerPositions,
      brokerOrderStatuses,
      brokerCommissions,
      killSwitch: configService.readKillSwitch(),
      connectionAttempt,
      ...SAFETY,
    };
    statusCache = { payload, atMs: Date.now() };
    return payload;
    })().finally(() => { statusInflight = null; });
    return statusInflight;
  }

  async function modifyOwnedProtectiveOrder({
    orderId,
    idempotencyKey = null,
    orderRef = null,
    orderPatch = {},
    reason = null,
  } = {}) {
    const wantedOrderId = Number(orderId);
    if (!Number.isInteger(wantedOrderId) || wantedOrderId <= 0) {
      return { ok: false, modified: false, blocker: 'order_id_required', ...SAFETY };
    }
    if (!reason) return { ok: false, modified: false, blocker: 'modify_reason_required', ...SAFETY };
    const patch = orderPatch && typeof orderPatch === 'object' ? orderPatch : {};
    const patchKeys = Object.keys(patch);
    if (patchKeys.length !== 1 || !['lmtPrice', 'auxPrice'].includes(patchKeys[0])) {
      return { ok: false, modified: false, blocker: 'modify_patch_field_not_allowed', ...SAFETY };
    }
    const status = await buildExecutionStatus({ force: true });
    const openOrders = Array.isArray(status.brokerOpenOrders) ? status.brokerOpenOrders : [];
    const openOrder = openOrders.find((row) => Number(row.orderId) === wantedOrderId
      || (orderRef && String(row.order?.orderRef || '') === String(orderRef)));
    if (!openOrder) return { ok: false, modified: false, blocker: 'order_not_open_at_adapter', orderId: wantedOrderId, ...SAFETY };
    const orderType = safeUpper(openOrder.order?.orderType || openOrder.orderType);
    if ((patchKeys[0] === 'lmtPrice' && orderType !== 'LMT') || (patchKeys[0] === 'auxPrice' && orderType !== 'STP')) {
      return { ok: false, modified: false, blocker: 'modify_patch_field_not_allowed_for_order_type', orderId: wantedOrderId, orderType, ...SAFETY };
    }
    const adapterVerification = adapter.verifyPaperAccount(status.account?.accountIdMasked || null);
    const guardDecision = {
      allowed: status.runtimeState === 'READY'
        && status.paperAccountVerified === true
        && adapterVerification.ok === true
        && status.liveAccountDetected !== true,
      environment: 'paper',
      verifiedPaperAccount: status.paperAccountVerified === true && adapterVerification.ok === true,
      liveAccountBlocked: status.liveAccountDetected !== true,
      checks: [
        { code: 'runtime_ready', ok: status.runtimeState === 'READY' },
        { code: 'paper_account_verified', ok: status.paperAccountVerified === true && adapterVerification.ok === true },
        { code: 'live_account_blocked', ok: status.liveAccountDetected !== true },
        { code: 'owned_order_open', ok: true },
      ],
      blockers: [],
    };
    if (guardDecision.allowed !== true) {
      const blocker = guardDecision.checks.find((check) => check.ok !== true)?.code || 'guard_not_passed';
      return { ok: false, modified: false, blocker, guard: guardDecision, ...SAFETY };
    }
    const result = await adapter.modifyPaperOrder({
      orderId: wantedOrderId,
      idempotencyKey,
      orderRef: orderRef || openOrder.order?.orderRef || null,
      orderPatch: patch,
      contract: openOrder.contract,
      guardDecision,
      verifiedAccount: adapterVerification,
      reason,
    });
    return {
      ...result,
      orderId: wantedOrderId,
      orderRef: orderRef || openOrder.order?.orderRef || null,
      orderType,
      orderPatch: patch,
      guard: guardDecision,
      ...SAFETY,
    };
  }

	  // EMERGENCY FLATTEN — R2. Speglar modifyOwnedProtectiveOrder: verifierar
	  // paper-konto + runtime READY, bygger guardDecision, delegerar till adapterns
	  // enda placeOrder-modul. Skapar ingen kandidat, rör ej canonical pipeline.
	  async function flattenOwnedPosition({ root = null, reason = null, audit = {} } = {}) {
	    if (!reason) return { ok: false, flattened: false, blocker: 'flatten_reason_required', ...SAFETY };
	    if (!root) return { ok: false, flattened: false, blocker: 'root_required', ...SAFETY };
	    const status = await buildExecutionStatus({ force: true });
	    const adapterVerification = adapter.verifyPaperAccount(status.account?.accountIdMasked || null);
	    const guardDecision = {
	      allowed: status.runtimeState === 'READY'
	        && status.paperAccountVerified === true
	        && adapterVerification.ok === true
	        && status.liveAccountDetected !== true,
	      environment: 'paper',
	      verifiedPaperAccount: status.paperAccountVerified === true && adapterVerification.ok === true,
	      liveAccountBlocked: status.liveAccountDetected !== true,
	      checks: [
	        { code: 'runtime_ready', ok: status.runtimeState === 'READY' },
	        { code: 'paper_account_verified', ok: status.paperAccountVerified === true && adapterVerification.ok === true },
	        { code: 'live_account_blocked', ok: status.liveAccountDetected !== true },
	      ],
	      blockers: [],
	    };
	    if (guardDecision.allowed !== true) {
	      const blocker = guardDecision.checks.find((check) => check.ok !== true)?.code || 'guard_not_passed';
	      return { ok: false, flattened: false, blocker, guard: guardDecision, ...SAFETY };
	    }
	    // Samma kontraktsupplösning som buildShadowExecution använder för entries,
	    // så att flatten-ordern bär symbol och expiry precis som en normal order.
	    // Misslyckas den faller adaptern tillbaka på positionsradens conId.
	    const flattenContract = await resolveContract(String(root).toUpperCase());
	    const result = await adapter.flattenOwnedPosition({
	      root: String(root).toUpperCase(),
	      reason,
	      verifiedAccount: adapterVerification,
	      audit,
	      contract: flattenContract.ok ? flattenContract.contract : null,
	    });
	    return { ...result, guard: guardDecision, ...SAFETY };
	  }

  async function buildShadowExecution({ candidateId = null, candidate = null, now = new Date(), actualSubmit = false } = {}) {
    const flags = configService.getFlags();
    const selected = selectCandidate(candidateId, candidate);
    if (!selected.candidate) {
      return {
        ok: true,
        status: 'READY_WAITING_FOR_SIGNAL',
        wouldSubmit: false,
        actualSubmit: false,
        blockedReason: 'no_strategy_candidate',
        message: 'Ingen legitim futures-kandidat finns i kön. Ingen falsk signal skapas.',
        orderSubmissionMode: flags.orderSubmissionMode,
        ...SAFETY,
      };
    }

    const selectedCandidate = selected.candidate;
    const selectedIdentity = lifecycleIdentity.identityFrom(selectedCandidate);
    const limits = configService.getPilotLimits();
	    const signalTimestamp = selectedCandidate.signalTimestamp || null;
	    const ageMs = ageMsFromTimestamp(signalTimestamp, now);
    const status = await buildExecutionStatus();
    const contractResult = await resolveContract(selectedCandidate.root);
    const quote = quoteSource.getQuote(selectedCandidate.root, now);
    const contract = contractResult.ok ? contractResult.contract : {
      root: selectedCandidate.root,
      conId: quote?.conId || null,
      localSymbol: quote?.localSymbol || null,
      expiry: quote?.expiry || null,
      exchange: quote?.exchange || 'CME',
      currency: quote?.currency || 'USD',
      secType: 'FUT',
    };
    const adapterVerification = adapter.verifyPaperAccount(status.account.accountIdMasked || null);
    const accountMasked = status.account.accountIdMasked || adapterVerification.accountIdMasked || null;
    const idempotencyKey = intentService.buildIdempotencyKey({
      strategyId: selectedCandidate.strategyId,
      root: selectedCandidate.root,
      conId: contract.conId,
      direction: selectedCandidate.direction,
      candidateId: selectedCandidate.candidateId,
      signalTimestamp,
      accountIdMasked: accountMasked,
      environment: 'paper',
    });
    const executionId = buildExecutionId(idempotencyKey || `${selectedCandidate.strategyId}:${selectedCandidate.candidateId}:${signalTimestamp}`);
    const intentId = idempotencyKey || null;
    const executionIdentity = lifecycleIdentity.mergeIdentity(selectedIdentity, {
      executionId,
      idempotencyKey,
      intentId,
    });
    const duplicate = idempotencyKey ? intentService.getIntent(idempotencyKey) : null;
		    const executionAllowlist = typeof strategyRegistry.canExecuteStrategy === 'function'
		      ? strategyRegistry.canExecuteStrategy(selectedCandidate.strategyId)
		      : { allowed: false, blockedReason: 'strategy_registry_execution_allowlist_unavailable', strategyId: selectedCandidate.strategyId, source: 'strategy_registry_execution_allowlist' };
		    const session = futuresMarketHoursService.getCmeEquityIndexFuturesSessionState(now);
	    // Canonical Signal → Execution Readiness Engine → Entry Contract (policy).
	    // Beslutet kommer från motorn; objektet behåller dagens fältnamn så att
	    // guard, execution-adapter och API-svar är oförändrade.
		    const entryContract = executionRouter.routeExecutionReadiness({
		      strategyId: selectedCandidate.strategyId,
		      candidate: selectedCandidate,
		      now,
	      marketContext: {
	        marketType: 'futures',
	        session: session.sessionId || null,
	        sessionId: session.sessionId || null,
	        isMarketOpen: session.isMarketOpen === true,
	      },
	    });
	    const rec = status.reconciliation?.degraded === true
	      ? status.reconciliation
	      : reconciliation.getCachedReconciliation();
    const brokerRisk = brokerRiskService.evaluateBrokerRisk({
      root: selectedCandidate.root,
      quantity: selectedCandidate.quantity,
      orderType: selectedCandidate.orderType,
      stopLossPrice: selectedCandidate.stopLossPrice,
      quote,
      openOrders: rec.openOrders || [],
      positions: rec.positions || [],
	      accountSummary: {
	        ok: status.account.ok === true,
	        generatedAt: status.account.generatedAt || null,
	        cacheAgeMs: status.account.cacheAgeMs,
	        account: {
	          accountIdMasked: status.account.accountIdMasked || null,
	          classification: status.account.classification || null,
	          realizedPnl: status.account.realizedPnl ?? null,
	          unrealizedPnl: status.account.unrealizedPnl ?? null,
	        },
	      },
      reconciliation: rec,
      now,
    });
    const intent = {
      lifecycleId: executionIdentity.lifecycleId || null,
      executionId,
      intentId,
      idempotencyKey,
      environment: 'paper',
      executionTarget: 'ibkr_paper',
      strategyId: selectedCandidate.strategyId,
      candidateId: selectedCandidate.candidateId || null,
      signalId: selectedCandidate.signalId || selectedCandidate.originalSignalId || null,
      root: selectedCandidate.root,
      direction: selectedCandidate.direction,
      quantity: selectedCandidate.quantity,
      orderType: selectedCandidate.orderType,
      signalTimestamp,
      ageMs,
      maxSubmitAgeMs: limits.maxIntentAgeMs,
      paperAccountIdMasked: accountMasked,
      source: selected.source,
    };
	    const guard = guardService.evaluatePaperExecutionGuard({
      intent,
      candidate: selectedCandidate,
      contract,
      quote,
      accountSummary: {
        ok: status.account.ok,
        account: {
          accountIdMasked: status.account.accountIdMasked,
          classification: status.account.classification,
        },
      },
      adapterStatus: status.executionClient,
      adapterVerification,
	      brokerRisk,
				      reconciliation: rec,
				      executionAllowlist,
					      entryContract,
      idempotency: { duplicate: Boolean(duplicate), existing: duplicate },
	      session,
	      now,
	    });
	    const orderPlan = adapter.buildOrderPlan({
      executionId,
      contract,
      side: selectedCandidate.direction,
	      quantity: selectedCandidate.quantity,
	      entryType: selectedCandidate.orderType,
	      limitPrice: selectedCandidate.limitPrice,
	      stopLossPrice: selectedCandidate.stopLossPrice,
	      takeProfitPrice: selectedCandidate.takeProfitPrice,
	      tif: 'GTC',
	      outsideRth: true,
	    });
	    const reservation = guard.allowed && idempotencyKey
	      ? executionTargetReservations.reserveExecutionTarget({
        lifecycleId: executionIdentity.lifecycleId || null,
        candidateId: selectedCandidate.candidateId,
        signalId: intent.signalId || null,
        intentId,
        executionId,
        idempotencyKey,
        executionTarget: 'ibkr_paper',
        strategyId: selectedCandidate.strategyId,
	        signalTimestamp,
	        status: 'ibkr_paper_reserved',
	        now,
	        metadata: {
	          lifecycleId: executionIdentity.lifecycleId || null,
	          executionId,
	          signalId: intent.signalId || null,
	          intentId,
	          idempotencyKey,
          root: selectedCandidate.root,
	          conId: contract.conId || null,
	        },
	      })
	      : { ok: false, skipped: true };
	    const effectiveGuard = reservation.ok || !guard.allowed ? guard : {
	      ...guard,
	      allowed: false,
	      blockedReason: reservation.blocker || 'execution_target_reservation_failed',
	      blockers: [reservation.blocker || 'execution_target_reservation_failed', ...(guard.blockers || [])],
	      checks: [
	        ...(guard.checks || []),
	        { code: 'execution_target_reserved', ok: false, blocker: reservation.blocker || 'execution_target_reservation_failed' },
	      ],
	    };
		    const intentCreate = effectiveGuard.allowed && idempotencyKey
		      ? intentService.createIntent({
	        idempotencyKey,
	        executionId,
	        intent: {
	          ...intent,
	          conId: contract.conId,
	          localSymbol: contract.localSymbol || null,
	          signalTimestamp,
		          orderType: selectedCandidate.orderType,
		          quantity: selectedCandidate.quantity,
	          executionTarget: 'ibkr_paper',
	        },
		      })
		      : { created: false, skipped: true };
		    const finalGuard = effectiveGuard.allowed && idempotencyKey && intentCreate.created !== true
		      ? {
		        ...effectiveGuard,
		        allowed: false,
		        blockedReason: intentCreate.duplicate ? 'duplicate_intent' : (intentCreate.error || 'intent_create_failed'),
		        blockers: [intentCreate.duplicate ? 'duplicate_intent' : (intentCreate.error || 'intent_create_failed'), ...(effectiveGuard.blockers || [])],
		        checks: [
		          ...(effectiveGuard.checks || []),
		          { code: 'intent_created_atomically', ok: false, blocker: intentCreate.duplicate ? 'duplicate_intent' : (intentCreate.error || 'intent_create_failed') },
		        ],
		      }
		      : effectiveGuard;
		    const executionEvidence = finalGuard.allowed && intentCreate.record
		      ? adapter.createExecutionEvidence({
		        guardDecision: finalGuard,
		        intentRecord: intentCreate.record,
		        orderPlan,
						        brokerRisk,
					        executionAllowlist,
					        entryContract,
	        reconciliation: rec,
	        verifiedAccount: adapterVerification,
	        now,
	      })
	      : null;
    const normalizedOrder = {
      lifecycleId: executionIdentity.lifecycleId || null,
      internalExecutionId: executionId,
      executionId,
      intentId,
      idempotencyKey,
      signalId: intent.signalId || null,
	      candidateId: selectedCandidate.candidateId || null,
	      strategyId: selectedCandidate.strategyId,
	      root: selectedCandidate.root,
      localSymbol: contract.localSymbol || null,
      conId: contract.conId || null,
      expiry: contract.expiry || null,
      accountMasked,
      action: orderPlan.entry.action,
	      quantity: selectedCandidate.quantity,
      orderType: orderPlan.entry.orderType,
      limitPrice: orderPlan.entry.lmtPrice ?? null,
      stopPrice: orderPlan.stopLoss.auxPrice ?? null,
      takeProfitPrice: orderPlan.takeProfit?.lmtPrice ?? null,
      parentId: null,
      ocaGroup: orderPlan.ocaGroup,
      tif: orderPlan.entry.tif,
      outsideRth: orderPlan.entry.outsideRth,
      transmit: orderPlan.entry.transmit,
      createdAt: nowIso(now),
      maxSubmitAge: limits.maxIntentAgeMs,
      riskSnapshot: brokerRisk,
      source: selected.source,
      paperOnly: true,
      orderRef: adapter.buildOrderRef(executionId, 'entry'),
		      executionTarget: 'ibkr_paper',
			      wouldSubmit: finalGuard.allowed === true,
		      actualSubmit: false,
	    };

	    if (intentCreate.created) {
	      intentService.updateStatus(idempotencyKey, flags.shadowMode || !actualSubmit ? 'shadow_logged' : 'guard_passed', {
	        orderRef: normalizedOrder.orderRef,
	        evidenceFingerprint: executionEvidence?.fingerprint || null,
	      });
	    }

    let submitResult = null;
	    if (actualSubmit === true) {
	      submitResult = await adapter.submitPaperOrder({
		        guardDecision: finalGuard,
	        intentRecord: intentCreate.record,
	        orderPlan,
	        verifiedAccount: adapterVerification,
		        executionEvidence,
						        brokerRisk,
					        executionAllowlist,
					        entryContract,
	        reconciliation: rec,
	        now,
	      });
      if (submitResult?.submitted && idempotencyKey) {
        intentService.updateStatus(idempotencyKey, 'submitted', {
          ibOrderId: submitResult.parentOrderId,
          orderRef: normalizedOrder.orderRef,
        });
      } else if (idempotencyKey && submitResult?.blocker) {
        intentService.updateStatus(idempotencyKey, 'reconciliation_required', { blocker: submitResult.blocker });
      }
    }

	    return {
	      ok: true,
		      status: finalGuard.allowed ? 'shadow_ready' : 'blocked',
		      wouldSubmit: finalGuard.allowed === true,
		      actualSubmit: submitResult?.submitted === true,
		      blockedReason: finalGuard.blockedReason || null,
		      blockers: finalGuard.blockers,
      candidate: selectedCandidate,
      lifecycleId: executionIdentity.lifecycleId || null,
      signalId: intent.signalId || null,
      intentId,
      contract,
	      quote,
	      accountMasked,
					      executionAllowlist,
				      entryContract,
      brokerRisk,
		      guard: finalGuard,
	      executionTargetReservation: reservation,
      intent: intentCreate.record || intent,
	      intentCreate,
	      executionEvidence: executionEvidence ? {
	        lifecycleId: executionIdentity.lifecycleId || null,
	        candidateId: executionIdentity.candidateId || null,
	        signalId: executionIdentity.signalId || null,
	        intentId: executionIdentity.intentId || null,
	        executionId,
	        idempotencyKey,
	        source: executionEvidence.source,
	        evidenceVersion: executionEvidence.evidenceVersion,
	        generatedAt: executionEvidence.generatedAt,
	        expiresAt: executionEvidence.expiresAt,
	        fingerprint: executionEvidence.fingerprint,
	      } : null,
      normalizedOrder,
      orderPlan: sanitizeOrderPlan(orderPlan, accountMasked, executionIdentity),
      submitResult,
      orderSubmissionMode: flags.orderSubmissionMode,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
	    selectCandidate,
      startRuntime,
      reconcileRuntime,
      getRuntimeReadinessSnapshot,
      getCachedExecutionStatus,
	    buildExecutionStatus,
    modifyOwnedProtectiveOrder,
    flattenOwnedPosition,
    buildShadowExecution,
    reconciliation,
  };
}

const defaultIbPaperExecutionOrchestratorService = createIbPaperExecutionOrchestratorService();

module.exports = {
  SAFETY,
  normalizeCandidate,
  createIbPaperExecutionOrchestratorService,
  defaultIbPaperExecutionOrchestratorService,
};
