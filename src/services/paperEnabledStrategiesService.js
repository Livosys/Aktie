'use strict';

/**
 * Manual Paper Strategy List.
 *
 * Owns only the user-controlled Paper Trading enabled store. It never reads or
 * mutates the legacy approval/family-selection store, risk config, broker state
 * or historical trades. enabledForPaper means "may enter the paper pipeline";
 * all runtime, entry, risk and safety gates still apply after this decision.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const catalogService = require('./daytradingStrategyCatalogService');
const tradeStats = require('./tradeStatsService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const STORE_FILE = path.resolve(
  process.env.PAPER_ENABLED_STRATEGIES_FILE
    || path.resolve(__dirname, '../../data/paper-trading/enabled-strategies.json'),
);

const SCHEMA_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 200;

const INITIAL_ENABLED_STRATEGY_IDS = Object.freeze([
  'narrow_state_expansion_long',
  'ema_pullback_continuation',
  'vwap_volume_breakout_long',
]);

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function getCatalogStrategies() {
  try {
    return arr(catalogService.getCatalog().strategies).filter((row) => row && row.id);
  } catch (_) {
    return [];
  }
}

function canonicalCatalogIds() {
  return new Set(getCatalogStrategies().map((strategy) => strategy.id));
}

function isCanonicalStrategyId(strategyId) {
  const id = safeString(strategyId);
  return Boolean(id && canonicalCatalogIds().has(id));
}

function defaultStore() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: null,
    strategies: {},
    history: [],
  };
}

function defaultDisabledEntry() {
  return {
    enabled: false,
    enabledAt: null,
    enabledBy: null,
    disabledAt: null,
    disabledBy: null,
    note: null,
  };
}

function normalizeEntry(entry = {}) {
  return {
    enabled: entry.enabled === true,
    enabledAt: safeString(entry.enabledAt),
    enabledBy: safeString(entry.enabledBy),
    disabledAt: safeString(entry.disabledAt),
    disabledBy: safeString(entry.disabledBy),
    note: entry.note == null ? null : String(entry.note),
  };
}

function sanitizeStore(parsed) {
  const catalogIds = canonicalCatalogIds();
  const store = defaultStore();
  store.version = Number(parsed.version) || SCHEMA_VERSION;
  store.updatedAt = safeString(parsed.updatedAt);

  const invalidStrategyIds = [];
  const rawStrategies = parsed.strategies && typeof parsed.strategies === 'object'
    ? parsed.strategies
    : {};
  for (const [strategyId, entry] of Object.entries(rawStrategies)) {
    if (!catalogIds.has(strategyId)) {
      invalidStrategyIds.push(strategyId);
      continue;
    }
    store.strategies[strategyId] = normalizeEntry(entry);
  }

  store.history = arr(parsed.history)
    .map((entry) => ({
      strategyId: safeString(entry.strategyId),
      action: safeString(entry.action),
      source: safeString(entry.source) || 'manual',
      at: safeString(entry.at),
      note: entry.note == null ? undefined : String(entry.note),
    }))
    .filter((entry) => entry.strategyId && entry.action && entry.at);

  return { store, invalidStrategyIds };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readStoreRaw() {
  if (!fs.existsSync(STORE_FILE)) {
    return {
      status: 'missing',
      ok: false,
      degraded: true,
      store: defaultStore(),
      invalidStrategyIds: [],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'corrupt',
        ok: false,
        degraded: true,
        store: defaultStore(),
        invalidStrategyIds: [],
      };
    }
    const normalized = sanitizeStore(parsed);
    const degraded = normalized.invalidStrategyIds.length > 0
      || Number(parsed.version) !== SCHEMA_VERSION
      || !parsed.strategies
      || typeof parsed.strategies !== 'object';
    return {
      status: degraded ? 'degraded' : 'ok',
      ok: !degraded,
      degraded,
      ...normalized,
    };
  } catch (err) {
    return {
      status: 'corrupt',
      ok: false,
      degraded: true,
      error: err.message,
      store: defaultStore(),
      invalidStrategyIds: [],
    };
  }
}

function fsyncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) {
    // Directory fsync is best-effort across filesystems.
  }
}

function writeStoreAtomic(store, now = new Date()) {
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: SCHEMA_VERSION,
    updatedAt: nowIso(now),
    strategies: store.strategies && typeof store.strategies === 'object' ? store.strategies : {},
    history: arr(store.history),
  };
  const tmp = path.join(dir, `.enabled-strategies.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, STORE_FILE);
  fsyncDirectory(dir);
  return cloneJson(payload);
}

function currentEntry(store, strategyId) {
  const entry = store.strategies && store.strategies[strategyId];
  return entry && typeof entry === 'object' ? normalizeEntry(entry) : defaultDisabledEntry();
}

function stateFromEntry(strategyId, entry, storeStatus) {
  const normalized = normalizeEntry(entry || {});
  return {
    strategyId,
    known: isCanonicalStrategyId(strategyId),
    enabled: normalized.enabled === true,
    enabledAt: normalized.enabledAt,
    enabledBy: normalized.enabledBy,
    disabledAt: normalized.disabledAt,
    disabledBy: normalized.disabledBy,
    note: normalized.note,
    storeStatus,
    ...SAFETY,
  };
}

function getStore() {
  const raw = readStoreRaw();
  return {
    status: raw.status,
    ok: raw.ok,
    degraded: raw.degraded,
    store: cloneJson(raw.store),
    invalidStrategyIds: raw.invalidStrategyIds,
    error: raw.error || null,
    safety: SAFETY,
    ...SAFETY,
  };
}

function getAllStrategyStates() {
  const raw = readStoreRaw();
  const strategies = {};
  for (const strategy of getCatalogStrategies()) {
    strategies[strategy.id] = stateFromEntry(strategy.id, currentEntry(raw.store, strategy.id), raw.status);
  }
  return {
    status: raw.status,
    ok: raw.ok,
    degraded: raw.degraded,
    updatedAt: raw.store.updatedAt,
    total: Object.keys(strategies).length,
    enabled: Object.values(strategies).filter((row) => row.enabled).length,
    strategies,
    invalidStrategyIds: raw.invalidStrategyIds,
    safety: SAFETY,
    ...SAFETY,
  };
}

function getStrategyState(strategyId) {
  const id = safeString(strategyId);
  const raw = readStoreRaw();
  if (!id) {
    return {
      strategyId: null,
      known: false,
      enabled: false,
      storeStatus: raw.status,
      reason: 'missing_strategy_id',
      ...SAFETY,
    };
  }
  return stateFromEntry(id, currentEntry(raw.store, id), raw.status);
}

function isStrategyEnabled(strategyId) {
  return getStrategyState(strategyId).enabled === true;
}

function getHistory(options = {}) {
  const raw = readStoreRaw();
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.trunc(Number(options.limit)))
    : DEFAULT_HISTORY_LIMIT;
  const history = raw.store.history.slice(-limit).reverse();
  return {
    status: raw.status,
    ok: raw.ok,
    degraded: raw.degraded,
    total: raw.store.history.length,
    history,
    safety: SAFETY,
    ...SAFETY,
  };
}

function assertCanonicalMutationId(strategyId) {
  const id = safeString(strategyId);
  if (!id) {
    return { ok: false, code: 400, strategyId: null, reason: 'missing_strategy_id' };
  }
  if (!isCanonicalStrategyId(id)) {
    return { ok: false, code: 404, strategyId: id, reason: 'unknown_canonical_strategy' };
  }
  return { ok: true, strategyId: id };
}

function mutationSource(metadata = {}) {
  return safeString(metadata.source) || 'manual';
}

function mutate(strategyId, action, metadata = {}) {
  const validation = assertCanonicalMutationId(strategyId);
  if (!validation.ok) {
    return {
      ok: false,
      status: 'error',
      code: validation.code,
      changed: false,
      strategyId: validation.strategyId,
      reason: validation.reason,
      safety: SAFETY,
      ...SAFETY,
    };
  }

  const id = validation.strategyId;
  const wantEnabled = action === 'enable';
  const now = metadata.now ? new Date(metadata.now) : new Date();
  const source = mutationSource(metadata);
  const note = metadata.note == null ? null : String(metadata.note);

  const raw = readStoreRaw();
  const store = sanitizeStore(raw.store).store;
  const existing = currentEntry(store, id);
  if (existing.enabled === wantEnabled) {
    return {
      ok: true,
      status: raw.status === 'ok' ? 'ok' : 'degraded',
      code: 200,
      changed: false,
      strategyId: id,
      enabled: wantEnabled,
      reason: wantEnabled ? 'already_enabled' : 'already_disabled',
      safety: SAFETY,
      ...SAFETY,
    };
  }

  const entry = {
    ...existing,
    enabled: wantEnabled,
    note,
  };
  if (wantEnabled) {
    entry.enabledAt = nowIso(now);
    entry.enabledBy = source;
    entry.disabledAt = null;
    entry.disabledBy = null;
  } else {
    entry.disabledAt = nowIso(now);
    entry.disabledBy = source;
  }
  store.strategies[id] = entry;
  store.history.push({
    strategyId: id,
    action,
    source,
    at: nowIso(now),
    ...(note != null ? { note } : {}),
  });
  const written = writeStoreAtomic(store, now);

  return {
    ok: true,
    status: 'ok',
    code: 200,
    changed: true,
    strategyId: id,
    enabled: wantEnabled,
    storeUpdatedAt: written.updatedAt,
    reason: action,
    safety: SAFETY,
    ...SAFETY,
  };
}

function enableStrategy(strategyId, metadata) {
  return mutate(strategyId, 'enable', metadata);
}

function disableStrategy(strategyId, metadata) {
  return mutate(strategyId, 'disable', metadata);
}

function manualListControlsRuntime() {
  return String(process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED || 'false').toLowerCase() === 'true';
}

function longOnlyEnabled() {
  return String(process.env.PAPER_LONG_ONLY_ENABLED || 'true').toLowerCase() !== 'false';
}

function latestCandidateByStrategyId() {
  const map = new Map();
  const file = path.resolve(__dirname, '../../data/paper-trading/events.jsonl');
  try {
    if (!fs.existsSync(file)) return map;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch (_) { continue; }
      const strategyId = row.strategyId || row.resolvedStrategyId || row.canonicalStrategyId || row.strategy_id || null;
      if (!strategyId) continue;
      const at = row.timestamp || row.at || row.entryTime || row.opened_at || null;
      const previous = map.get(strategyId);
      if (!previous || String(at || '') > String(previous.at || '')) {
        map.set(strategyId, {
          at,
          type: row.type || null,
          candidateId: row.candidateId || row.candidate_id || null,
          symbol: row.symbol || null,
          signalSubtype: row.signalSubtype || row.setup || null,
          signalFamily: row.signalFamily || row.signal_family || null,
          marketRegime: row.marketRegime || row.market_regime || row.marketRegimeV2 || null,
          entryReady: row.entryReady ?? row.producerEntryReadiness?.entryReady ?? null,
          producerEntryReadiness: row.producerEntryReadiness || null,
          canonicalVerdict: row.canonicalVerdict || row.readiness?.verdict || null,
          reasonCode: row.reasonCode || row.readiness?.reasonCode || null,
          decision: row.decision || null,
          blockedReason: row.blockedReason || row.blockedReasonCode || null,
          blockedReasonCode: row.blockedReasonCode || null,
        });
      }
    }
  } catch (_) {
    return new Map();
  }
  return map;
}

function tradeStatsByStrategyId() {
  const stats = new Map();
  try {
    for (const trade of tradeStats.loadPaperTrades()) {
      const id = trade.resolvedStrategyId || trade.strategyId || trade.strategy_id || trade.canonicalStrategyId || null;
      if (!id) continue;
      if (!stats.has(id)) stats.set(id, { count: 0, wins: 0, losses: 0, pnlSum: 0, pnlCount: 0, latest: null });
      const stat = stats.get(id);
      stat.count += 1;
      if (trade.result === 'WIN') stat.wins += 1;
      if (trade.result === 'LOSS') stat.losses += 1;
      const pnl = Number(trade.pnlPct ?? trade.pnl ?? trade.pnlUsd ?? trade.realizedPnl);
      if (Number.isFinite(pnl)) {
        stat.pnlSum += pnl;
        stat.pnlCount += 1;
      }
      const at = trade.entryTime || trade.opened_at || trade.closed_at || null;
      if (at && (!stat.latest || String(at) > String(stat.latest.entryTime || ''))) {
        stat.latest = {
          entryTime: at,
          symbol: trade.symbol || null,
          direction: trade.direction || null,
          result: trade.result || null,
          pnlPct: Number.isFinite(pnl) ? pnl : null,
        };
      }
    }
  } catch (_) {
    return new Map();
  }
  return stats;
}

function lazy(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

function paperEligibilityFor({
  enabled,
  readinessRow,
  strategy,
  entryContractsEnabled = false,
  entryContractReady = false,
}) {
  if (!enabled) {
    return { paperEligibility: 'DISABLED_BY_USER', paperBlockedReason: 'paper_strategy_not_enabled' };
  }
  if (strategy.direction === 'short' && longOnlyEnabled()) {
    return { paperEligibility: 'BLOCKED', paperBlockedReason: 'long_only_short_strategy' };
  }
  if (readinessRow) {
    if (readinessRow.producerStatus && readinessRow.producerStatus !== 'ok') {
      return { paperEligibility: 'BLOCKED', paperBlockedReason: 'paper_strategy_enabled_but_no_producer' };
    }
    if (readinessRow.runtimeConnectorStatus && readinessRow.runtimeConnectorStatus !== 'active') {
      return { paperEligibility: 'BLOCKED', paperBlockedReason: 'paper_strategy_enabled_but_runtime_blocked' };
    }
    if (readinessRow.technicalReadiness && readinessRow.technicalReadiness !== 'READY') {
      return {
        paperEligibility: 'BLOCKED',
        paperBlockedReason: readinessRow.paperBlockedReason || 'paper_strategy_enabled_but_runtime_blocked',
      };
    }
  }
  if (entryContractsEnabled && !entryContractReady) {
    return {
      paperEligibility: 'BLOCKED',
      paperBlockedReason: 'paper_strategy_enabled_but_entry_contract_missing',
    };
  }
  return { paperEligibility: 'READY', paperBlockedReason: null };
}

function buildPaperStrategyList(options = {}) {
  const readinessService = lazy('./strategyReadinessService');
  let readinessRows = new Map();
  let readinessStatus = 'error';
  try {
    const readiness = readinessService && readinessService.getStrategyReadiness
      ? readinessService.getStrategyReadiness({ noCache: options.fresh === true })
      : null;
    readinessRows = new Map(arr(readiness && readiness.strategies).map((row) => [row.strategyId, row]));
    readinessStatus = readiness ? readiness.status || 'ok' : 'error';
  } catch (_) {
    readinessStatus = 'error';
  }

  const raw = readStoreRaw();
  const candidates = latestCandidateByStrategyId();
  const stats = tradeStatsByStrategyId();
  const entryContractService = lazy('./paperStrategyEntryContractService');
  const entryContractsEnabled = entryContractService && entryContractService.entryContractsEnabled
    ? entryContractService.entryContractsEnabled()
    : false;
  let entryContractDiagnostics = null;
  try {
    entryContractDiagnostics = entryContractService && entryContractService.buildEntryContractDiagnostics
      ? entryContractService.buildEntryContractDiagnostics({
        windowHours: options.entryContractWindowHours || 24,
      })
      : null;
  } catch (_) {
    entryContractDiagnostics = null;
  }
  const manualMode = manualListControlsRuntime();
  const catalogRows = getCatalogStrategies();
  const catalogStatus = catalogRows.length ? 'ok' : 'empty';

  const strategies = catalogRows.map((strategy) => {
    const entry = currentEntry(raw.store, strategy.id);
    const enabled = entry.enabled === true;
    const readinessRow = readinessRows.get(strategy.id) || null;
    const stat = stats.get(strategy.id) || null;
    const decided = stat ? stat.wins + stat.losses : 0;
    const technicalReadiness = readinessRow
      ? readinessRow.technicalReadiness || (readinessRow.readiness === 'READY_FOR_PAPER' ? 'READY' : readinessRow.readiness)
      : null;
    const entryContract = entryContractService && entryContractService.getEntryContract
      ? entryContractService.getEntryContract(strategy.id)
      : null;
    const eligibility = paperEligibilityFor({
      enabled,
      readinessRow,
      strategy,
      entryContractsEnabled,
      entryContractReady: Boolean(entryContract),
    });
    const contractDiag = entryContractDiagnostics?.byStrategyId?.[strategy.id] || null;

    return {
      strategyId: strategy.id,
      displayName: strategy.name || strategy.id,
      family: strategy.family || null,
      direction: strategy.direction || null,
      catalogStatus: strategy.status || null,
      enabledForPaper: enabled,
      enabledAt: entry.enabledAt,
      disabledAt: entry.disabledAt,
      manualSelectionStatus: enabled ? 'enabled' : 'disabled',
      technicalReadiness,
      readiness: readinessRow ? readinessRow.readiness : null,
      producerStatus: readinessRow ? readinessRow.producerStatus : null,
      producedSubtypes: readinessRow ? arr(readinessRow.producedSubtypes) : [],
      mappingStatus: readinessRow ? readinessRow.mappingStatus : null,
      runtimeConnectorStatus: readinessRow ? readinessRow.runtimeConnectorStatus : null,
      runtimeBlockedReason: readinessRow ? readinessRow.runtimeBlockedReason : null,
      replayEligibility: readinessRow ? readinessRow.replayEligibility : null,
      batchEligibility: readinessRow ? readinessRow.batchEligibility : null,
      paperEligibility: eligibility.paperEligibility,
      paperBlockedReason: eligibility.paperBlockedReason,
      missingComponents: readinessRow ? arr(readinessRow.missingComponents) : [],
      warnings: readinessRow ? arr(readinessRow.warnings) : [],
      legacyApprovalStatus: readinessRow ? (readinessRow.legacyApprovalStatus ?? readinessRow.approvalStatus ?? null) : null,
      legacySelectedInFamily: readinessRow ? (readinessRow.legacySelectedInFamily ?? readinessRow.selectedInFamily ?? null) : null,
      latestCandidate: candidates.get(strategy.id) || null,
      latestPaperTrade: stat ? stat.latest : null,
      paperTradeCount: stat ? stat.count : 0,
      winRate: decided > 0 ? Math.round((stat.wins / decided) * 1000) / 10 : null,
      avgPnl: stat && stat.pnlCount > 0 ? Math.round((stat.pnlSum / stat.pnlCount) * 10000) / 10000 : null,
      entryContractStatus: entryContract ? 'ready' : 'missing',
      entryContractReady: Boolean(entryContract),
      entryContractVersion: entryContract ? entryContract.version : null,
      entryContract: entryContract ? {
        version: entryContract.version,
        allowedSubtypes: arr(entryContract.allowedSubtypes),
        allowedStatuses: arr(entryContract.allowedStatuses),
        blockedStatuses: arr(entryContract.blockedStatuses),
        requiredConfirmations: arr(entryContract.requiredConfirmations),
        maxSignalAgeMs: entryContract.maxSignalAgeMs,
        requiresClosedCandle: entryContract.requiresClosedCandle === true,
        requiresMarketOpen: entryContract.requiresMarketOpen === true,
        allowedSessions: arr(entryContract.allowedSessions),
        lateEntryPolicy: entryContract.lateEntryPolicy,
        extendedMovePolicy: entryContract.extendedMovePolicy,
      } : null,
      entryContractDiagnostics: contractDiag,
      latestEntryContractBlock: contractDiag ? contractDiag.latestContractBlock : null,
      commonEntryContractBlocker: contractDiag ? contractDiag.commonBlocker : null,
      entryContractCandidateCount: contractDiag ? contractDiag.candidates : 0,
      entryContractPassCount: contractDiag ? contractDiag.contractPass : 0,
      entryContractBlockCount: contractDiag ? contractDiag.contractBlock : 0,
      timeoutRate: contractDiag ? contractDiag.timeoutRate : null,
      outcomeCounts: contractDiag ? {
        WIN: contractDiag.wins || 0,
        LOSS: contractDiag.losses || 0,
        TIMEOUT: contractDiag.timeouts || 0,
      } : { WIN: 0, LOSS: 0, TIMEOUT: 0 },
      avgMfe: contractDiag ? contractDiag.avgMfe : null,
      avgMae: contractDiag ? contractDiag.avgMae : null,
      safety: SAFETY,
      ...SAFETY,
    };
  });

  const enabledCount = strategies.filter((strategy) => strategy.enabledForPaper).length;
  const entryContractsReady = strategies.filter((strategy) => strategy.entryContractReady).length;
  return {
    status: catalogStatus === 'ok' && raw.status === 'ok' ? 'ok' : 'degraded',
    generatedAt: nowIso(),
    runtimeGateMode: manualMode ? 'manual' : 'legacy',
    manualListControlsRuntime: manualMode,
    entryContractsEnabled,
    entryContractVersion: entryContractService ? entryContractService.PAPER_ENTRY_CONTRACT_VERSION || null : null,
    summary: {
      total: strategies.length,
      enabled: enabledCount,
      disabled: strategies.length - enabledCount,
      ready: strategies.filter((strategy) => strategy.paperEligibility === 'READY').length,
      blocked: strategies.filter((strategy) => strategy.paperEligibility === 'BLOCKED').length,
      disabledByUser: strategies.filter((strategy) => strategy.paperEligibility === 'DISABLED_BY_USER').length,
      entryContractsReady,
      entryContractsMissing: strategies.length - entryContractsReady,
      entryContractPass: strategies.reduce((sum, strategy) => sum + (strategy.entryContractPassCount || 0), 0),
      entryContractBlock: strategies.reduce((sum, strategy) => sum + (strategy.entryContractBlockCount || 0), 0),
    },
    sources: {
      catalog: { status: catalogStatus },
      enabledStore: { status: raw.status },
      readiness: { status: readinessStatus },
      entryContracts: {
        status: entryContractService ? 'ok' : 'missing',
        diagnosticsStatus: entryContractDiagnostics ? entryContractDiagnostics.status : 'unavailable',
        since: entryContractDiagnostics ? entryContractDiagnostics.since : null,
      },
    },
    strategies,
    note_sv: 'Du väljer manuellt vilka strategier som får delta i Paper Trading. Aktivering innebär inte att en trade automatiskt öppnas; alla data-, entry-, risk- och säkerhetskontroller gäller fortfarande.',
    safety: SAFETY,
    ...SAFETY,
  };
}

function buildInitialStore(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const source = safeString(options.source) || 'manual_initial_migration';
  const enabledIds = new Set(arr(options.enabledStrategyIds).length
    ? options.enabledStrategyIds
    : INITIAL_ENABLED_STRATEGY_IDS);
  const store = defaultStore();
  store.updatedAt = nowIso(now);
  for (const strategy of getCatalogStrategies()) {
    const enabled = enabledIds.has(strategy.id);
    store.strategies[strategy.id] = {
      enabled,
      enabledAt: enabled ? nowIso(now) : null,
      enabledBy: enabled ? source : null,
      disabledAt: enabled ? null : nowIso(now),
      disabledBy: enabled ? null : source,
      note: 'manual_initial_migration',
    };
    store.history.push({
      strategyId: strategy.id,
      action: enabled ? 'enable' : 'disable',
      source,
      at: nowIso(now),
      note: 'manual_initial_migration',
    });
  }
  return store;
}

module.exports = {
  SAFETY,
  SCHEMA_VERSION,
  STORE_FILE,
  INITIAL_ENABLED_STRATEGY_IDS,
  getStore,
  getAllStrategyStates,
  getStrategyState,
  isStrategyEnabled,
  enableStrategy,
  disableStrategy,
  getHistory,
  manualListControlsRuntime,
  buildPaperStrategyList,
  buildInitialStore,
  _internal: {
    canonicalCatalogIds,
    readStoreRaw,
    writeStoreAtomic,
    sanitizeStore,
  },
};
