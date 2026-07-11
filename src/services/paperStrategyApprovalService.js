'use strict';

// Paper Trading Strategy Approval — SEPARAT approval-lager för vanlig Paper.
//
// Muterar ALDRIG Futures Paper, futures-strategier, futures-storage eller
// runtime. Detta lager äger endast vanlig Paper Trading-status:
// approval/removed, family selection och runtime-kompatibilitet.
//
// Trading är fortsatt paper_only. Ingen broker, ingen live, inga riktiga order.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const catalogService = require('./daytradingStrategyCatalogService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');
const strategyRuntimeMatrixService = require('./strategyRuntimeMatrixService');
const automationApprovalService = require('./automationApprovalService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'paper_strategy_approval',
});

const SCHEMA_VERSION = 1;
const STORE_FILE = path.resolve(
  process.env.PAPER_STRATEGY_APPROVALS_FILE
    || path.resolve(__dirname, '../../data/paper-trading/strategy-approvals.json'),
);

const MIGRATION_SOURCE = 'initial_migration_from_automation_approvals';

const STATUS = Object.freeze({
  APPROVED: 'approved',
  PAUSED: 'paused',
  REMOVED: 'removed',
});

const COMPAT = Object.freeze({
  READY: 'READY',
  NEEDS_MAPPING: 'NEEDS_MAPPING',
  UNSUPPORTED: 'UNSUPPORTED',
  BLOCKED: 'BLOCKED',
});

const GATE_REASON = Object.freeze({
  NOT_APPROVED: 'paper_strategy_not_approved',
  PAUSED: 'paper_strategy_paused',
  REMOVED: 'paper_strategy_removed',
  NOT_READY: 'paper_strategy_not_ready',
  FAMILY_NOT_SELECTED: 'paper_strategy_family_not_selected',
  DEGRADED: 'paper_approval_state_degraded',
});

const SUPPORTED_MARKETS = new Set([
  'all',
  'stocks',
  'stock',
  'equity',
  'equities',
  'etf',
  'index',
  'nasdaq100',
  'leveraged_etf',
  'crypto',
]);

let _lastGoodStore = null;

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalId(rawId) {
  const requested = safeString(rawId);
  if (!requested) return null;
  try {
    const norm = strategyIdNormalizer.normalizeStrategyId(requested);
    if (norm && norm.canonicalStrategyId) return norm.canonicalStrategyId;
  } catch (_) { /* fall back to raw */ }
  return requested;
}

function defaultStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    strategies: {},
    selectedByFamily: {},
    updatedAt: null,
  };
}

function readStoreRaw() {
  if (!fs.existsSync(STORE_FILE)) return { status: 'missing' };
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.strategies !== 'object') {
      return { status: 'error' };
    }
    return {
      status: 'ok',
      store: {
        schemaVersion: Number(parsed.schemaVersion) || SCHEMA_VERSION,
        strategies: parsed.strategies || {},
        selectedByFamily: parsed.selectedByFamily && typeof parsed.selectedByFamily === 'object'
          ? parsed.selectedByFamily
          : {},
        updatedAt: parsed.updatedAt || null,
      },
    };
  } catch (_) {
    return { status: 'error' };
  }
}

function readStore() {
  const raw = readStoreRaw();
  return raw.status === 'ok' ? raw.store : null;
}

function writeStoreAtomic(store) {
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    strategies: store.strategies || {},
    selectedByFamily: store.selectedByFamily || {},
    updatedAt: nowIso(),
  };
  const tmp = path.join(dir, `.paper-strategy-approvals.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, STORE_FILE);
  return payload;
}

function getCatalogStrategy(id) {
  try { return catalogService.getStrategyById(id); } catch (_) { return null; }
}

function getCatalogStrategies() {
  try {
    const catalog = catalogService.getCatalog();
    return arr(catalog && catalog.strategies);
  } catch (_) {
    return [];
  }
}

function getRuntimeRows() {
  try {
    const matrix = strategyRuntimeMatrixService.getStrategyRuntimeMatrix();
    return arr(matrix && matrix.strategies);
  } catch (_) {
    return [];
  }
}

function runtimeMap() {
  const map = new Map();
  for (const row of getRuntimeRows()) {
    const id = row && (row.id || row.strategy_id);
    if (id) map.set(id, row);
  }
  return map;
}

function strategyFamilyKey(id, catalogStrategy = null) {
  const strategy = catalogStrategy || getCatalogStrategy(id);
  const family = safeString(strategy && strategy.family);
  return family ? family.toLowerCase() : `__strategy__:${id}`;
}

function publicFamily(id, catalogStrategy = null) {
  const strategy = catalogStrategy || getCatalogStrategy(id);
  return safeString(strategy && strategy.family);
}

function readLegacyApprovedIds() {
  try {
    const approvals = automationApprovalService.getAutomationApprovals();
    return arr(approvals && approvals.approvedStrategyIds).map(canonicalId).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function pushHistory(entry, id, { previousStatus, newStatus, action, source, reason, now }) {
  entry.history = arr(entry.history);
  entry.history.unshift({
    timestamp: nowIso(now),
    strategyId: id,
    previousStatus: previousStatus || null,
    newStatus: newStatus || null,
    action,
    source: source || 'api',
    reason: reason || null,
  });
  entry.history = entry.history.slice(0, 200);
}

function makeEntry(id, { status, source, now = new Date(), history = [] }) {
  return {
    status,
    source,
    approvedAt: status === STATUS.APPROVED ? nowIso(now) : null,
    pausedAt: status === STATUS.PAUSED ? nowIso(now) : null,
    removedAt: status === STATUS.REMOVED ? nowIso(now) : null,
    updatedAt: nowIso(now),
    history,
  };
}

function buildMigrationSeedStore(now = new Date()) {
  const store = defaultStore();
  for (const id of readLegacyApprovedIds()) {
    if (!id || store.strategies[id]) continue;
    const catalogStrategy = getCatalogStrategy(id);
    const familyKey = strategyFamilyKey(id, catalogStrategy);
    store.strategies[id] = makeEntry(id, {
      status: STATUS.APPROVED,
      source: MIGRATION_SOURCE,
      now,
      history: [{
        timestamp: nowIso(now),
        strategyId: id,
        previousStatus: null,
        newStatus: STATUS.APPROVED,
        action: 'migrate',
        source: MIGRATION_SOURCE,
        reason: 'seed_existing_paper_automation_approval',
      }],
    });
    if (!store.selectedByFamily[familyKey]) {
      store.selectedByFamily[familyKey] = id;
    }
  }
  return store;
}

function loadStore(now = new Date()) {
  const raw = readStoreRaw();
  if (raw.status === 'ok') {
    _lastGoodStore = raw.store;
    return { store: raw.store, degraded: false, migrated: false };
  }
  if (raw.status === 'missing') {
    const seed = buildMigrationSeedStore(now);
    const written = writeStoreAtomic(seed);
    const store = {
      schemaVersion: written.schemaVersion,
      strategies: written.strategies,
      selectedByFamily: written.selectedByFamily,
      updatedAt: written.updatedAt,
    };
    _lastGoodStore = store;
    return { store, degraded: false, migrated: true };
  }
  if (_lastGoodStore) return { store: _lastGoodStore, degraded: true, migrated: false };
  return { store: defaultStore(), degraded: true, migrated: false };
}

function computeCompatibility(id, catalogStrategy = null, runtimeRow = null) {
  const strategy = catalogStrategy || getCatalogStrategy(id);
  const row = runtimeRow || runtimeMap().get(id) || null;
  const blockingReasons = [];

  if (!strategy) {
    return {
      compatibility: COMPAT.UNSUPPORTED,
      runtimeStatus: 'unknown',
      automaticStatus: 'unknown',
      paperRuntimeReady: false,
      blockers: ['unknown_strategy_id'],
      blockingReasons: ['unknown_strategy_id'],
    };
  }

  const catalogStatus = String(strategy.status || strategy.catalog_status || 'active').toLowerCase();
  if (strategy.enabled === false || catalogStatus === 'paused' || catalogStatus === 'deprecated') {
    blockingReasons.push('catalog_status_paused');
  }

  const market = String(strategy.market || strategy.market_group || 'unknown').toLowerCase();
  if (market !== 'unknown' && !SUPPORTED_MARKETS.has(market)) {
    blockingReasons.push('unsupported_paper_market');
  }

  if (strategy.supportsPaper === false) {
    blockingReasons.push('catalog_supports_paper_false');
  }

  const runtimeStatus = row ? (row.paperRuntimeStatus || row.runtime_status || 'unknown') : 'unknown';
  const blockers = row && Array.isArray(row.blockers) ? row.blockers.filter(Boolean) : [];
  if (!row) blockingReasons.push('runtime_matrix_missing');
  else if (runtimeStatus !== 'active') blockingReasons.push(`paper_runtime:${runtimeStatus}`);
  for (const blocker of blockers) blockingReasons.push(String(blocker));

  let compatibility = COMPAT.READY;
  if (blockingReasons.includes('unsupported_paper_market') || blockingReasons.includes('catalog_supports_paper_false')) {
    compatibility = COMPAT.UNSUPPORTED;
  } else if (blockingReasons.includes('catalog_status_paused')) {
    compatibility = COMPAT.BLOCKED;
  } else if (!row || runtimeStatus !== 'active') {
    compatibility = COMPAT.NEEDS_MAPPING;
  } else if (blockers.length > 0) {
    compatibility = COMPAT.BLOCKED;
  }

  return {
    compatibility,
    runtimeStatus,
    automaticStatus: row ? (row.automaticStatus || 'unknown') : 'unknown',
    paperRuntimeReady: compatibility === COMPAT.READY,
    blockers,
    blockingReasons,
  };
}

function selectedIdForFamily(store, id, catalogStrategy = null) {
  const key = strategyFamilyKey(id, catalogStrategy);
  return store.selectedByFamily ? (store.selectedByFamily[key] || null) : null;
}

function buildStrategyView(id, { store, degraded, runtimeRowsById = null }) {
  const catalogStrategy = getCatalogStrategy(id);
  const runtimeRow = runtimeRowsById ? runtimeRowsById.get(id) : null;
  const entry = (store.strategies || {})[id] || null;
  const compat = computeCompatibility(id, catalogStrategy, runtimeRow);
  const family = publicFamily(id, catalogStrategy);
  const familyKey = strategyFamilyKey(id, catalogStrategy);
  const selectedStrategyId = selectedIdForFamily(store, id, catalogStrategy);
  const selected = selectedStrategyId === id;
  const approvalStatus = entry ? entry.status : null;
  const tradable = approvalStatus === STATUS.APPROVED && selected && compat.compatibility === COMPAT.READY && !degraded;
  let blocker = null;
  if (degraded) blocker = GATE_REASON.DEGRADED;
  else if (!entry || !approvalStatus) blocker = GATE_REASON.NOT_APPROVED;
  else if (approvalStatus === STATUS.REMOVED) blocker = GATE_REASON.REMOVED;
  else if (approvalStatus === STATUS.PAUSED) blocker = GATE_REASON.PAUSED;
  else if (approvalStatus === STATUS.APPROVED && !selected) blocker = GATE_REASON.FAMILY_NOT_SELECTED;
  else if (compat.compatibility !== COMPAT.READY) blocker = GATE_REASON.NOT_READY;

  return {
    strategyId: id,
    displayName: (catalogStrategy && catalogStrategy.name) || id,
    family,
    direction: (catalogStrategy && catalogStrategy.direction) || null,
    market: (catalogStrategy && (catalogStrategy.market || catalogStrategy.market_group)) || null,
    catalogStatus: (catalogStrategy && (catalogStrategy.status || catalogStrategy.catalog_status)) || 'unknown',
    approval: {
      status: approvalStatus,
      source: entry ? entry.source : null,
      approvedAt: entry ? entry.approvedAt : null,
      pausedAt: entry ? entry.pausedAt : null,
      removedAt: entry ? entry.removedAt : null,
      degraded: Boolean(degraded),
    },
    familySelection: {
      family,
      familyKey,
      selected,
      selectedStrategyId,
      tradable,
      blocker,
    },
    compatibility: {
      compatibility: compat.compatibility,
      paperRuntimeReady: compat.paperRuntimeReady,
      runtimeStatus: compat.runtimeStatus,
      automaticStatus: compat.automaticStatus,
      blockers: compat.blockers,
      blockingReasons: compat.blockingReasons,
    },
  };
}

function familySelectionsFromStrategies(strategies) {
  const groups = new Map();
  for (const s of strategies) {
    const key = s.familySelection && s.familySelection.familyKey;
    if (!key) continue;
    const group = groups.get(key) || {
      family: s.familySelection.family,
      familyKey: key,
      selectedStrategyId: s.familySelection.selectedStrategyId,
      tradableStrategyId: null,
      strategyIds: [],
      approvedStrategyIds: [],
      removedStrategyIds: [],
    };
    group.strategyIds.push(s.strategyId);
    if (s.approval && s.approval.status === STATUS.APPROVED) group.approvedStrategyIds.push(s.strategyId);
    if (s.approval && s.approval.status === STATUS.REMOVED) group.removedStrategyIds.push(s.strategyId);
    if (s.familySelection && s.familySelection.tradable) group.tradableStrategyId = s.strategyId;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => String(a.family || a.familyKey).localeCompare(String(b.family || b.familyKey)));
}

function listStrategies() {
  const { store, degraded } = loadStore();
  const rowsById = runtimeMap();
  const ids = new Set();
  for (const s of getCatalogStrategies()) if (s && s.id) ids.add(s.id);
  for (const id of Object.keys(store.strategies || {})) ids.add(id);
  const strategies = [...ids].sort().map((id) => buildStrategyView(id, { store, degraded, runtimeRowsById: rowsById }));
  const familySelections = familySelectionsFromStrategies(strategies);
  const tradableStrategyIds = strategies
    .filter((row) => row.familySelection && row.familySelection.tradable)
    .map((row) => row.strategyId);
  const approvedStrategyIds = strategies
    .filter((row) => row.approval && row.approval.status === STATUS.APPROVED)
    .map((row) => row.strategyId);
  const removedStrategyIds = strategies
    .filter((row) => row.approval && row.approval.status === STATUS.REMOVED)
    .map((row) => row.strategyId);

  return {
    status: degraded ? 'degraded' : 'ok',
    ok: !degraded,
    readOnly: true,
    generatedAt: nowIso(),
    schemaVersion: SCHEMA_VERSION,
    degraded: Boolean(degraded),
    count: strategies.length,
    summary: {
      total: strategies.length,
      approved: approvedStrategyIds.length,
      removed: removedStrategyIds.length,
      tradable: tradableStrategyIds.length,
      ready: strategies.filter((row) => row.compatibility && row.compatibility.compatibility === COMPAT.READY).length,
      families: familySelections.length,
    },
    approvedStrategyIds,
    removedStrategyIds,
    tradableStrategyIds,
    familySelections,
    strategies,
    ...SAFETY,
  };
}

function getStrategy(rawId) {
  const id = canonicalId(rawId);
  if (!id) return null;
  const { store, degraded } = loadStore();
  if (!getCatalogStrategy(id) && !(store.strategies || {})[id]) return null;
  return buildStrategyView(id, { store, degraded, runtimeRowsById: runtimeMap() });
}

function mutate(rawId, action, { source = 'api', now = new Date() } = {}) {
  const id = canonicalId(rawId);
  if (!id) return { ok: false, code: 404, changed: false, reason: 'unknown_strategy_id', ...SAFETY };

  const loaded = loadStore(now);
  if (loaded.degraded) {
    return { ok: false, code: 503, changed: false, strategyId: id, reason: GATE_REASON.DEGRADED, degraded: true, ...SAFETY };
  }

  const store = loaded.store;
  const catalogStrategy = getCatalogStrategy(id);
  if (!catalogStrategy && action !== 'remove') {
    return { ok: false, code: 404, changed: false, strategyId: id, reason: 'unknown_strategy_id', ...SAFETY };
  }

  const existing = store.strategies[id] || null;
  const previousStatus = existing ? existing.status : null;
  const familyKey = strategyFamilyKey(id, catalogStrategy);

  if (action === 'approve' || action === 'resume') {
    if (!catalogStrategy) return { ok: false, code: 404, changed: false, strategyId: id, reason: 'unknown_strategy_id', ...SAFETY };
    const compat = computeCompatibility(id, catalogStrategy);
    if (compat.compatibility !== COMPAT.READY) {
      return {
        ok: false,
        code: 422,
        changed: false,
        strategyId: id,
        reason: `not_approvable_${compat.compatibility.toLowerCase()}`,
        compatibility: compat.compatibility,
        blockingReasons: compat.blockingReasons,
        ...SAFETY,
      };
    }
    const entry = existing || makeEntry(id, { status: STATUS.APPROVED, source, now, history: [] });
    entry.status = STATUS.APPROVED;
    entry.source = source;
    entry.approvedAt = nowIso(now);
    entry.pausedAt = null;
    entry.removedAt = null;
    entry.updatedAt = nowIso(now);
    pushHistory(entry, id, {
      previousStatus,
      newStatus: STATUS.APPROVED,
      action,
      source,
      reason: action === 'approve' ? 'approved_and_selected_for_family' : 'resumed_and_selected_for_family',
      now,
    });
    store.strategies[id] = entry;
    const previousSelectedStrategyId = store.selectedByFamily[familyKey] || null;
    store.selectedByFamily[familyKey] = id;
    writeStoreAtomic(store);
    return {
      ok: true,
      code: 200,
      changed: previousStatus !== STATUS.APPROVED || previousSelectedStrategyId !== id,
      strategyId: id,
      status: STATUS.APPROVED,
      familyKey,
      selectedStrategyId: id,
      previousSelectedStrategyId,
      reason: 'approved',
      ...SAFETY,
    };
  }

  if (action === 'pause') {
    if (!existing) return { ok: false, code: 404, changed: false, strategyId: id, reason: 'not_in_paper_approval_store', ...SAFETY };
    if (existing.status === STATUS.PAUSED) return { ok: true, code: 200, changed: false, strategyId: id, status: STATUS.PAUSED, reason: 'already_paused', ...SAFETY };
    if (existing.status === STATUS.REMOVED) return { ok: false, code: 409, changed: false, strategyId: id, reason: 'cannot_pause_removed', ...SAFETY };
    existing.status = STATUS.PAUSED;
    existing.pausedAt = nowIso(now);
    existing.updatedAt = nowIso(now);
    if (store.selectedByFamily[familyKey] === id) delete store.selectedByFamily[familyKey];
    pushHistory(existing, id, { previousStatus, newStatus: STATUS.PAUSED, action, source, reason: 'paused', now });
    writeStoreAtomic(store);
    return { ok: true, code: 200, changed: true, strategyId: id, status: STATUS.PAUSED, reason: 'paused', ...SAFETY };
  }

  if (action === 'remove') {
    const entry = existing || makeEntry(id, { status: STATUS.REMOVED, source, now, history: [] });
    entry.status = STATUS.REMOVED;
    entry.source = source;
    entry.pausedAt = null;
    entry.removedAt = nowIso(now);
    entry.updatedAt = nowIso(now);
    if (store.selectedByFamily[familyKey] === id) delete store.selectedByFamily[familyKey];
    pushHistory(entry, id, { previousStatus, newStatus: STATUS.REMOVED, action, source, reason: 'removed', now });
    store.strategies[id] = entry;
    writeStoreAtomic(store);
    return {
      ok: true,
      code: 200,
      changed: previousStatus !== STATUS.REMOVED,
      strategyId: id,
      status: STATUS.REMOVED,
      reason: previousStatus === STATUS.REMOVED ? 'already_removed' : 'removed',
      ...SAFETY,
    };
  }

  return { ok: false, code: 400, changed: false, reason: 'unknown_action', ...SAFETY };
}

const approve = (id, opts) => mutate(id, 'approve', opts);
const pause = (id, opts) => mutate(id, 'pause', opts);
const resume = (id, opts) => mutate(id, 'resume', opts);
const remove = (id, opts) => mutate(id, 'remove', opts);

function evaluatePaperApprovalGate({ strategyId } = {}) {
  const id = canonicalId(strategyId);
  if (!id) return { allowed: false, blockedReason: GATE_REASON.NOT_APPROVED, strategyId: null, ...SAFETY };
  let loaded;
  try {
    loaded = loadStore();
  } catch (_) {
    loaded = _lastGoodStore ? { store: _lastGoodStore, degraded: true } : { store: defaultStore(), degraded: true };
  }
  const store = loaded.store || defaultStore();
  const degraded = Boolean(loaded.degraded);
  const entry = (store.strategies || {})[id] || null;
  const catalogStrategy = getCatalogStrategy(id);
  const compat = computeCompatibility(id, catalogStrategy);
  const selected = selectedIdForFamily(store, id, catalogStrategy) === id;

  if (degraded) return { allowed: false, blockedReason: GATE_REASON.DEGRADED, strategyId: id, degraded, ...SAFETY };
  if (!entry) return { allowed: false, blockedReason: GATE_REASON.NOT_APPROVED, strategyId: id, degraded, ...SAFETY };
  if (entry.status === STATUS.REMOVED) return { allowed: false, blockedReason: GATE_REASON.REMOVED, strategyId: id, degraded, ...SAFETY };
  if (entry.status === STATUS.PAUSED) return { allowed: false, blockedReason: GATE_REASON.PAUSED, strategyId: id, degraded, ...SAFETY };
  if (entry.status !== STATUS.APPROVED) return { allowed: false, blockedReason: GATE_REASON.NOT_APPROVED, strategyId: id, degraded, ...SAFETY };
  if (!selected) return { allowed: false, blockedReason: GATE_REASON.FAMILY_NOT_SELECTED, strategyId: id, selectedStrategyId: selectedIdForFamily(store, id, catalogStrategy), degraded, ...SAFETY };
  if (compat.compatibility !== COMPAT.READY) {
    return { allowed: false, blockedReason: GATE_REASON.NOT_READY, strategyId: id, compatibility: compat.compatibility, blockingReasons: compat.blockingReasons, degraded, ...SAFETY };
  }
  return { allowed: true, blockedReason: null, strategyId: id, degraded, ...SAFETY };
}

function getTradableStrategyIds() {
  return listStrategies().tradableStrategyIds || [];
}

function getAllowlistStatus() {
  const list = listStrategies();
  const allowlist = (list.strategies || [])
    .filter((row) => row.approval && row.approval.status === STATUS.APPROVED)
    .map((row) => ({
      id: row.strategyId,
      name: row.displayName,
      approvedForPaperTesting: true,
      approvalStatus: row.approval.status,
      removed: false,
      family: row.family,
      selectedForFamily: row.familySelection.selected,
      selectedStrategyId: row.familySelection.selectedStrategyId,
      tradable: row.familySelection.tradable,
      blocker: row.familySelection.blocker,
      paperRuntimeActive: row.compatibility.runtimeStatus === 'active',
      paperRuntimeStatus: row.compatibility.runtimeStatus,
      automaticStatus: row.compatibility.automaticStatus,
      hasBlockers: arr(row.compatibility.blockers).length > 0,
      blockers: row.compatibility.blockers || [],
      readyForPaperRuntime: row.compatibility.paperRuntimeReady === true,
      paperRuntimeReady: row.compatibility.paperRuntimeReady === true,
      runtimeConnectionStatus: row.compatibility.paperRuntimeReady === true ? 'ready' : 'pending',
    }));
  const readyCount = allowlist.filter((row) => row.readyForPaperRuntime).length;
  const tradableCount = allowlist.filter((row) => row.tradable).length;
  const pendingCount = allowlist.filter((row) => !row.readyForPaperRuntime || !row.tradable).length;
  return {
    ok: !list.degraded,
    totalApproved: allowlist.length,
    readyForPaperRuntime: readyCount,
    pendingRuntimeConnection: pendingCount,
    tradableCount,
    approvedStrategyIds: allowlist.map((row) => row.id),
    tradableStrategyIds: list.tradableStrategyIds || [],
    removedStrategyIds: list.removedStrategyIds || [],
    familySelections: list.familySelections || [],
    paperRuntimeReady: tradableCount > 0,
    runtimeConnectionStatus: allowlist.length === 0 ? 'unknown' : (pendingCount === 0 ? 'ready' : (tradableCount === 0 ? 'pending' : 'partial')),
    allowlist,
    note: 'Read-only projection of ordinary Paper Trading strategy approvals. Separate from Futures Paper. Tradable requires approved + selected family + READY runtime.',
    safety: SAFETY,
    ...SAFETY,
  };
}

function __resetLastKnownGood() {
  _lastGoodStore = null;
}

module.exports = {
  SAFETY,
  SCHEMA_VERSION,
  STORE_FILE,
  STATUS,
  COMPAT,
  GATE_REASON,
  MIGRATION_SOURCE,
  readStore,
  readStoreRaw,
  loadStore,
  buildMigrationSeedStore,
  computeCompatibility,
  listStrategies,
  getStrategy,
  approve,
  pause,
  resume,
  remove,
  evaluatePaperApprovalGate,
  getTradableStrategyIds,
  getAllowlistStatus,
  __resetLastKnownGood,
};
