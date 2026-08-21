'use strict';

// Futures Paper Strategy Approval — SEPARAT approval-lager för Futures Paper.
//
// Speglar eller muterar ALDRIG den vanliga Paper Trading-allowlisten
// (automationApprovalService / paperAllowlistService). Den canonical
// strategikatalogen (daytradingStrategyCatalogService) är fortsatt gemensam
// sanning för strategiernas REGLER — denna store äger endast godkännande-STATUS,
// testomgång (test-run), mutation-historik och kompatibilitet per strategi.
//
// Ingen statistik lagras här (den ägs av futuresPaperStrategyPerformanceService).
// paper_only. Ingen order, ingen broker, ingen live. Skapar aldrig en trade.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const catalogService = require('./daytradingStrategyCatalogService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');
const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const paperAllowlistService = require('./paperAllowlistService');
const strategyRegistryService = require('./strategyRegistryService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_strategy_approval',
});

const SCHEMA_VERSION = 2;
const DEFAULT_TEST_TARGET_TRADES = 10;

const STORE_FILE = path.resolve(
  process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE
    || path.resolve(__dirname, '../../data/futures-paper/strategy-approvals.json'),
);

// Bas-fallback om allowlisten inte kan läsas. Den verkliga migrationsseedningen
// är UNIONEN av allowlist + strategier med verkliga futures-trades (se
// computeMigrationUnion) och speglar dagens faktiska Futures-runtime.
const ALLOWLIST_FALLBACK_IDS = Object.freeze([
  'narrow_state_expansion_long',
  'ema_pullback_continuation',
  'vwap_volume_breakout_long',
]);

const MIGRATION_SOURCE = 'initial_migration_from_existing_futures_runtime';

// Kända dubletter → canonical ersättnings-id. Får aldrig godkännas.
const DUPLICATE_REPLACEMENTS = Object.freeze({
  narrow_state_fakeout_reversal: 'narrow_fakeout_reversal_v1',
});

const STATUS = Object.freeze({ APPROVED: 'approved', PAUSED: 'paused', REMOVED: 'removed' });

const COMPAT = Object.freeze({
  READY: 'READY',
  NEEDS_MAPPING: 'NEEDS_MAPPING',
  UNSUPPORTED: 'UNSUPPORTED',
  BLOCKED: 'BLOCKED',
});

const GATE_REASON = Object.freeze({
  NOT_APPROVED: 'futures_strategy_not_approved',
  PAUSED: 'futures_strategy_paused',
  REMOVED: 'futures_strategy_removed',
  NOT_READY: 'futures_strategy_not_ready',
  DUPLICATE: 'futures_strategy_duplicate',
  TARGET_COMPLETED: 'futures_test_target_completed',
  DEGRADED: 'futures_approval_state_degraded',
});

// Last-known-good in-memory state (mot store-/parsefel).
let _lastGoodStore = null;

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function canonicalId(rawId) {
  const requested = safeString(rawId);
  if (!requested) return null;
  try {
    const norm = strategyIdNormalizer.normalizeStrategyId(requested);
    if (norm && norm.canonicalStrategyId) return norm.canonicalStrategyId;
  } catch (err) { /* faller tillbaka på råvärdet */ }
  return requested;
}

// ── Ledger-läsning (read-only) ──────────────────────────────────────────────

let _closedCache = null;
let _closedAt = 0;
const CLOSED_TTL_MS = 3000;

// Map<canonicalStrategyId, string[] closedAt> — endast STÄNGDA futures-trades.
function closedTimestampsByStrategy() {
  const now = Date.now();
  if (_closedCache && (now - _closedAt) < CLOSED_TTL_MS) return _closedCache;
  const map = new Map();
  try {
    const positions = futuresPaperLedgerService.defaultFuturesPaperLedgerService.getFuturesPaperPositions();
    const closed = Array.isArray(positions.closedPositions) ? positions.closedPositions : [];
    for (const row of closed) {
      if (!row || row.status !== 'closed') continue;
      const id = canonicalId(row.strategyId);
      if (!id) continue;
      const arr = map.get(id) || [];
      arr.push(row.closedAt || null);
      map.set(id, arr);
    }
  } catch (err) { /* läsfel → tom räkning (ingen fabricerad progress) */ }
  _closedCache = map;
  _closedAt = now;
  return map;
}

function openStrategyIds() {
  const ids = new Set();
  try {
    const positions = futuresPaperLedgerService.defaultFuturesPaperLedgerService.getFuturesPaperPositions();
    for (const row of (positions.openPositions || [])) {
      const id = canonicalId(row.strategyId);
      if (id) ids.add(id);
    }
  } catch (err) { /* noop */ }
  return ids;
}

function allowlistIds() {
  try {
    const status = paperAllowlistService.getPaperAllowlistStatus();
    return (status.allowlist || []).map((r) => canonicalId(r.id || r.strategy_id)).filter(Boolean);
  } catch (err) {
    return [...ALLOWLIST_FALLBACK_IDS];
  }
}

function canExecuteFromRegistry(id) {
  try {
    return strategyRegistryService.canExecuteStrategy(id).allowed === true;
  } catch (err) {
    return false;
  }
}

// Union av strategier som FAKTISKT deltar i dagens Futures-runtime:
// allowlist ∪ strategier med stängda futures-trades ∪ öppna positioner,
// filtrerat genom execution allowlist så historik aldrig reaktiverar strategier.
function computeMigrationUnion({ allowlist = null, tradedIds = null, openIds = null } = {}) {
  const set = new Set();
  for (const id of (allowlist || allowlistIds())) if (id) set.add(id);
  const traded = tradedIds || [...closedTimestampsByStrategy().keys()];
  for (const id of traded) if (id) set.add(id);
  const opens = openIds || [...openStrategyIds()];
  for (const id of opens) if (id) set.add(id);
  return [...set].filter(canExecuteFromRegistry).sort();
}

// ── Persistens (atomisk skrivning: tempfil → fsync → rename) ────────────────

function defaultStore() {
  return { schemaVersion: SCHEMA_VERSION, strategies: {}, updatedAt: null };
}

// Läser store och skiljer på saknad fil (normal → seed) och trasig fil (degraded).
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
        updatedAt: parsed.updatedAt || null,
      },
    };
  } catch (err) {
    return { status: 'error' };
  }
}

// Bakåtkompatibel enkel läsning (används av tester/inspektion).
function readStore() {
  const raw = readStoreRaw();
  if (raw.status === 'ok') return raw.store;
  return null;
}

function writeStoreAtomic(store) {
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { schemaVersion: SCHEMA_VERSION, strategies: store.strategies || {}, updatedAt: nowIso() };
  const tmp = path.join(dir, `.strategy-approvals.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, STORE_FILE);
  return payload;
}

// ── Test-run ────────────────────────────────────────────────────────────────

function makeTestRun(strategyId, { now = new Date(), baselineClosedTrades = 0 } = {}) {
  const startedAt = nowIso(now);
  return {
    runId: `${strategyId}-${Date.parse(startedAt)}`,
    startedAt,
    baselineClosedTrades: Number.isFinite(baselineClosedTrades) ? baselineClosedTrades : 0,
    completedAt: null,
  };
}

function makeEntry(strategyId, { status, source, now = new Date(), baselineClosedTrades = 0, history = [] }) {
  return {
    status,
    source,
    testTargetTrades: DEFAULT_TEST_TARGET_TRADES,
    testRun: makeTestRun(strategyId, { now, baselineClosedTrades }),
    approvedAt: status === STATUS.APPROVED ? nowIso(now) : null,
    pausedAt: status === STATUS.PAUSED ? nowIso(now) : null,
    removedAt: status === STATUS.REMOVED ? nowIso(now) : null,
    updatedAt: nowIso(now),
    history,
  };
}

// Aktuell testprogress: räknar ENDAST trades stängda efter testRun.startedAt.
function computeCurrentTest(id, entry, closedTs = null) {
  const timestamps = (closedTs || closedTimestampsByStrategy()).get(id) || [];
  const total = timestamps.length;
  const target = (entry && Number(entry.testTargetTrades)) || DEFAULT_TEST_TARGET_TRADES;
  const startedAt = entry && entry.testRun ? entry.testRun.startedAt : null;
  let currentClosed = 0;
  if (startedAt) {
    const startMs = Date.parse(startedAt);
    currentClosed = timestamps.filter((ts) => {
      const m = Date.parse(ts || '');
      return Number.isFinite(m) && Number.isFinite(startMs) && m >= startMs;
    }).length;
  }
  const currentTestStatus = currentClosed >= target ? 'completed' : 'in_progress';
  return {
    currentTestClosedTrades: Math.min(currentClosed, target),
    currentTestTargetTrades: target,
    currentTestRemainingTrades: Math.max(0, target - currentClosed),
    currentTestStatus,
    totalHistoricalClosedTrades: total,
    testRunId: entry && entry.testRun ? entry.testRun.runId : null,
    testRunStartedAt: startedAt,
    baselineClosedTrades: entry && entry.testRun ? entry.testRun.baselineClosedTrades : null,
  };
}

// ── Migration (idempotent, union av dagens faktiska Futures-runtime) ─────────

function buildMigrationSeedStore(now = new Date()) {
  const store = defaultStore();
  const closedTs = closedTimestampsByStrategy();
  const union = computeMigrationUnion();
  for (const id of union) {
    const baseline = (closedTs.get(id) || []).length;
    store.strategies[id] = makeEntry(id, {
      status: STATUS.APPROVED,
      source: MIGRATION_SOURCE,
      now,
      baselineClosedTrades: baseline,
      history: [{
        timestamp: nowIso(now),
        strategyId: id,
        previousStatus: null,
        newStatus: STATUS.APPROVED,
        action: 'migrate',
        source: MIGRATION_SOURCE,
        reason: 'seed_existing_futures_runtime',
      }],
    });
  }
  return store;
}

// Returnerar { store, degraded, migrated }.
//  - fil saknas → seed union + skriv (migrated:true)
//  - fil ok → använd (uppdaterar last-known-good)
//  - fil trasig → last-known-good eller in-memory seed, degraded:true (INGEN skrivning)
function loadStore(now = new Date()) {
  const raw = readStoreRaw();
  if (raw.status === 'ok') {
    _lastGoodStore = raw.store;
    return { store: raw.store, degraded: false, migrated: false };
  }
  if (raw.status === 'missing') {
    const seed = buildMigrationSeedStore(now);
    const written = writeStoreAtomic(seed);
    const store = { schemaVersion: written.schemaVersion, strategies: written.strategies, updatedAt: written.updatedAt };
    _lastGoodStore = store;
    return { store, degraded: false, migrated: true };
  }
  // status === 'error' → degraded: last-known-good, annars in-memory seed. Skriv INTE.
  if (_lastGoodStore) return { store: _lastGoodStore, degraded: true, migrated: false };
  return { store: buildMigrationSeedStore(now), degraded: true, migrated: false };
}

// Bakåtkompatibelt namn.
function ensureMigrated(now = new Date()) {
  return loadStore(now);
}

// ── Kompatibilitet (evidensbaserad, read-only) ──────────────────────────────

function getCatalogStrategy(id) {
  try { return catalogService.getStrategyById(id); } catch (err) { return null; }
}

function getRegistryStrategy(id) {
  try {
    return strategyRegistryService.getStrategy(id) || null;
  } catch (err) {
    return null;
  }
}

/**
 * Registret nycklat på KANONISKT id.
 *
 * ── Varför den kanoniska raden måste vinna ─────────────────────────────────
 *
 * Flera registerrader normaliseras till samma kanoniska id: den kanoniska
 * strategin plus dess parametervarianter (`__fast`, `__patient`, `__volatile`).
 * Kartan skrevs tidigare i listordning, så den SISTA varianten skrev över den
 * kanoniska raden.
 *
 * Varianterna är interna och står inte i execution allowlist. Den kanoniska
 * strategin bedömdes därför på en variants egenskaper — `registry_managed:
 * false` — och blockerades med `strategy_not_in_execution_allowlist`. Effekten
 * var total: INGEN strategi kunde nå READY, och godkännandevyn visade 0 av 145
 * som körbara trots att tre var allowlistade och producerverifierade.
 *
 * En exakt id-träff vinner alltid. En variant får bara fylla en tom plats.
 */
function registryStrategiesById() {
  try {
    const status = strategyRegistryService.getStatus();
    const map = new Map();
    for (const row of (status.strategies || [])) {
      const rawId = safeString(row.strategy_id || row.strategyId || row.id);
      const id = canonicalId(rawId);
      if (!id) continue;
      const isCanonicalRow = rawId === id;
      if (isCanonicalRow || !map.has(id)) map.set(id, row);
    }
    return map;
  } catch (err) {
    return new Map();
  }
}

function registryStrategyIds(registryMap = null) {
  const map = registryMap || registryStrategiesById();
  return [...map.keys()];
}

function registryFuturesRoots(strategy = {}) {
  const tokens = new Set([
    strategy.strategy_id,
    strategy.strategyId,
    strategy.strategy_name,
    ...(Array.isArray(strategy.market_regime_tags) ? strategy.market_regime_tags : []),
  ].join(' ').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  return ['MNQ', 'MES', 'NQ', 'ES'].filter((root) => tokens.has(root));
}

function symbolMappingFor(market) {
  const m = String(market || '').toLowerCase();
  if (m === 'crypto') return { status: 'unsupported', roots: [] };
  if (m === 'stocks' || m === 'index' || m === 'all') return { status: 'supported', roots: ['MNQ', 'MES'] };
  return { status: 'unknown', roots: [] };
}

function computeCompatibility(id, catalogStrategy, closedTs = null, registryStrategyOverride = undefined) {
  const strategy = catalogStrategy || getCatalogStrategy(id);
  const registryStrategy = registryStrategyOverride === undefined ? getRegistryStrategy(id) : registryStrategyOverride;
  const blockingReasons = [];
  let canonicalReplacementId = null;

  if (!strategy) {
    if (registryStrategy) {
      const roots = registryFuturesRoots(registryStrategy);
      const active = registryStrategy.status === 'active' && registryStrategy.enabled !== false;
      const hasEntryRules = Array.isArray(registryStrategy.entry_rules) && registryStrategy.entry_rules.length > 0;
      const hasExitRules = Array.isArray(registryStrategy.exit_rules) && registryStrategy.exit_rules.length > 0;
      if (!active) blockingReasons.push('strategy_registry_not_active');
      if (!roots.length) blockingReasons.push('unverified_symbol_mapping');
      if (!hasEntryRules || !hasExitRules) blockingReasons.push('no_risk_mapping');
      return {
        compatibility: active && roots.length && hasEntryRules && hasExitRules ? COMPAT.READY : COMPAT.NEEDS_MAPPING,
        producerStatus: active ? 'verified' : 'missing',
        producerEvidence: active ? 'strategy_registry_execution_allowlist' : null,
        adapterStatus: roots.length ? 'supported' : 'unknown',
        riskMappingStatus: hasEntryRules && hasExitRules ? 'supported' : 'missing',
        symbolMappingStatus: roots.length ? 'supported' : 'unknown',
        roots,
        blockingReasons,
        canonicalReplacementId: null,
      };
    }
    return {
      compatibility: COMPAT.UNSUPPORTED, producerStatus: 'unknown', producerEvidence: null,
      adapterStatus: 'unknown', riskMappingStatus: 'unknown', symbolMappingStatus: 'unknown',
      roots: [], blockingReasons: ['unknown_strategy_id'], canonicalReplacementId: null,
    };
  }

  const status = strategy.status || strategy.catalog_status;
  const isPaused = status === 'paused' || status === 'deprecated' || strategy.enabled === false;
  const registryExecution = registryStrategy
    ? strategyRegistryService.canExecuteStrategy(registryStrategy)
    : null;

  const timestamps = closedTs || closedTimestampsByStrategy();
  const isScannerEmitter = strategy.supportsScanner === true;
  const hasClosedTrades = ((timestamps.get(id) || []).length) > 0;
  let producerEvidence = null;
  if (isScannerEmitter && hasClosedTrades) producerEvidence = 'both';
  else if (isScannerEmitter) producerEvidence = 'scanner_emitter';
  else if (hasClosedTrades) producerEvidence = 'closed_trades';
  const producerStatus = producerEvidence ? 'verified' : 'missing';

  const sym = symbolMappingFor(strategy.market || strategy.market_group);
  const adapterStatus = sym.status === 'supported' ? 'supported' : (sym.status === 'unknown' ? 'unknown' : 'unsupported');
  const symbolMappingStatus = sym.status;
  const hasSl = strategy.default_sl != null || strategy.default_stop_loss_pct != null;
  const hasTp = strategy.default_tp != null || strategy.default_take_profit_r != null;
  const riskMappingStatus = hasSl && hasTp ? 'supported' : 'missing';
  const directionMappable = ['long', 'short', 'both'].includes(String(strategy.direction || '').toLowerCase());
  const isDuplicate = Object.prototype.hasOwnProperty.call(DUPLICATE_REPLACEMENTS, id);
  if (isDuplicate) canonicalReplacementId = DUPLICATE_REPLACEMENTS[id];

  let compatibility;
  if (isDuplicate) { compatibility = COMPAT.NEEDS_MAPPING; blockingReasons.push('duplicate_strategy'); }
  else if (registryExecution && registryExecution.allowed !== true) { compatibility = COMPAT.BLOCKED; blockingReasons.push(registryExecution.blockedReason || 'strategy_not_in_execution_allowlist'); }
  else if (isPaused) { compatibility = COMPAT.BLOCKED; blockingReasons.push('catalog_status_paused'); }
  else if (symbolMappingStatus === 'unsupported') { compatibility = COMPAT.UNSUPPORTED; blockingReasons.push('no_safe_futures_mapping'); }
  else if (symbolMappingStatus === 'unknown') { compatibility = COMPAT.NEEDS_MAPPING; blockingReasons.push('unverified_symbol_mapping'); }
  else if (producerStatus === 'missing') { compatibility = COMPAT.NEEDS_MAPPING; blockingReasons.push('no_verified_signal_producer'); }
  else if (riskMappingStatus === 'missing') { compatibility = COMPAT.NEEDS_MAPPING; blockingReasons.push('no_risk_mapping'); }
  else if (!directionMappable) { compatibility = COMPAT.NEEDS_MAPPING; blockingReasons.push('no_direction_mapping'); }
  else compatibility = COMPAT.READY;

  return {
    compatibility, producerStatus, producerEvidence, adapterStatus, riskMappingStatus,
    symbolMappingStatus, roots: sym.roots, blockingReasons, canonicalReplacementId,
  };
}

// ── Publik läsning ──────────────────────────────────────────────────────────

function buildStrategyView(id, { store, closedTs, degraded, registryMap = null }) {
  const catalogStrategy = getCatalogStrategy(id);
  const registryStrategy = registryMap ? registryMap.get(id) || null : getRegistryStrategy(id);
  const entry = store.strategies[id] || null;
  const compatibility = computeCompatibility(id, catalogStrategy, closedTs, registryStrategy);
  const registryExecution = registryStrategy
    ? strategyRegistryService.canExecuteStrategy(registryStrategy)
    : null;
  const registryApproved = !entry && registryExecution?.allowed === true;
  const currentTest = computeCurrentTest(id, entry, closedTs);
  return {
    strategyId: id,
    displayName: (catalogStrategy && catalogStrategy.name) || registryStrategy?.strategy_name || id,
    family: (catalogStrategy && catalogStrategy.family) || null,
    direction: (catalogStrategy && catalogStrategy.direction) || null,
    market: (catalogStrategy && (catalogStrategy.market || catalogStrategy.market_group)) || (registryStrategy ? 'futures' : null),
    catalogStatus: (catalogStrategy && (catalogStrategy.status || catalogStrategy.catalog_status)) || registryStrategy?.status || 'unknown',
    signalRules: (catalogStrategy && Array.isArray(catalogStrategy.signal_rules)) ? [...catalogStrategy.signal_rules] : (Array.isArray(registryStrategy?.entry_rules) ? [...registryStrategy.entry_rules] : []),
    approval: {
      status: entry ? entry.status : (registryApproved ? STATUS.APPROVED : null),
      source: entry ? entry.source : (registryApproved ? 'strategy_registry_execution_allowlist' : null),
      approvedAt: entry ? entry.approvedAt : (registryApproved ? registryStrategy.updated_at || registryStrategy.created_at || null : null),
      pausedAt: entry ? entry.pausedAt : null,
      removedAt: entry ? entry.removedAt : null,
      degraded: Boolean(degraded),
    },
    compatibility: {
      compatibility: compatibility.compatibility,
      producerStatus: compatibility.producerStatus,
      producerEvidence: compatibility.producerEvidence,
      adapterStatus: compatibility.adapterStatus,
      riskMappingStatus: compatibility.riskMappingStatus,
      symbolMappingStatus: compatibility.symbolMappingStatus,
      roots: compatibility.roots,
      allowedRoots: compatibility.roots,
      blockingReasons: compatibility.blockingReasons,
      canonicalReplacementId: compatibility.canonicalReplacementId,
    },
    currentTest,
  };
}

function listStrategies() {
  const { store, degraded } = loadStore();
  const closedTs = closedTimestampsByStrategy();
  const registryMap = registryStrategiesById();
  const ids = new Set();
  try {
    const catalog = catalogService.getCatalog();
    for (const s of (catalog.strategies || [])) if (s && s.id) ids.add(s.id);
  } catch (err) { /* katalogfel → visa åtminstone store-poster */ }
  for (const id of registryStrategyIds(registryMap)) ids.add(id);
  for (const id of Object.keys(store.strategies || {})) ids.add(id);

  const strategies = [];
  for (const id of ids) {
    try { strategies.push(buildStrategyView(id, { store, closedTs, degraded, registryMap })); }
    catch (err) { strategies.push({ strategyId: id, error: true, errorMessage: safeString(err && err.message) || 'strategy_view_failed', ...SAFETY }); }
  }
  return {
    status: 'ok', readOnly: true, generatedAt: nowIso(), schemaVersion: SCHEMA_VERSION,
    degraded: Boolean(degraded), count: strategies.length, strategies, ...SAFETY,
  };
}

function getStrategy(rawId) {
  const id = canonicalId(rawId);
  if (!id) return null;
  const { store, degraded } = loadStore();
  const known = getCatalogStrategy(id) || store.strategies[id] || getRegistryStrategy(id);
  if (!known) return null;
  return buildStrategyView(id, { store, closedTs: closedTimestampsByStrategy(), degraded });
}

// ── Mutationer (idempotenta, atomiska, startar ny testomgång vid approve) ────

function pushHistory(entry, id, { previousStatus, newStatus, action, source, reason, now }) {
  entry.history = Array.isArray(entry.history) ? entry.history : [];
  entry.history.push({
    timestamp: nowIso(now), strategyId: id, previousStatus: previousStatus || null,
    newStatus: newStatus || null, action, source: source || 'api', reason: reason || null,
  });
}

function mutate(rawId, action, { source = 'api', now = new Date() } = {}) {
  const id = canonicalId(rawId);
  if (!id) return { ok: false, code: 404, changed: false, reason: 'unknown_strategy_id', ...SAFETY };

  const catalogStrategy = getCatalogStrategy(id);
  const loaded = loadStore(now);
  // Vid degraderat state (trasig store) vägras mutationer — skriv aldrig över
  // en potentiellt återställningsbar korrupt fil.
  if (loaded.degraded) {
    return { ok: false, code: 503, changed: false, strategyId: id, reason: GATE_REASON.DEGRADED, degraded: true, ...SAFETY };
  }
  const store = loaded.store;
  const existing = store.strategies[id] || null;
  const previousStatus = existing ? existing.status : null;

  if (action === 'approve') {
    const closedTs = closedTimestampsByStrategy();
    const baseline = (closedTs.get(id) || []).length;
    if (!catalogStrategy) return { ok: false, code: 404, changed: false, reason: 'unknown_strategy_id', ...SAFETY };
    if (existing && existing.status === STATUS.APPROVED) {
      return { ok: true, code: 200, changed: false, strategyId: id, status: STATUS.APPROVED, reason: 'already_approved', ...SAFETY };
    }
    const compat = computeCompatibility(id, catalogStrategy, closedTs, getRegistryStrategy(id));
    if (compat.compatibility !== COMPAT.READY) {
      return {
        ok: false, code: 422, changed: false, strategyId: id,
        reason: compat.canonicalReplacementId ? 'duplicate_strategy' : `not_approvable_${compat.compatibility.toLowerCase()}`,
        compatibility: compat.compatibility, blockingReasons: compat.blockingReasons,
        canonicalReplacementId: compat.canonicalReplacementId, ...SAFETY,
      };
    }
    // Ny approve (eller re-approve efter paus/borttag) → NY testomgång, 0/target.
    const entry = existing || makeEntry(id, { status: STATUS.APPROVED, source, now, baselineClosedTrades: baseline, history: [] });
    entry.status = STATUS.APPROVED;
    entry.source = source;
    entry.testTargetTrades = entry.testTargetTrades || DEFAULT_TEST_TARGET_TRADES;
    entry.testRun = makeTestRun(id, { now, baselineClosedTrades: baseline });
    entry.approvedAt = nowIso(now);
    entry.pausedAt = null;
    entry.removedAt = null;
    entry.updatedAt = nowIso(now);
    pushHistory(entry, id, { previousStatus, newStatus: STATUS.APPROVED, action: 'approve', source, reason: 'approved_new_test_run', now });
    store.strategies[id] = entry;
    writeStoreAtomic(store);
    return { ok: true, code: 200, changed: true, strategyId: id, status: STATUS.APPROVED, reason: 'approved', testRunId: entry.testRun.runId, ...SAFETY };
  }

  if (action === 'pause') {
    if (!existing) return { ok: false, code: 404, changed: false, strategyId: id, reason: 'not_in_futures_approval_store', ...SAFETY };
    if (existing.status === STATUS.PAUSED) return { ok: true, code: 200, changed: false, strategyId: id, status: STATUS.PAUSED, reason: 'already_paused', ...SAFETY };
    if (existing.status === STATUS.REMOVED) return { ok: false, code: 409, changed: false, strategyId: id, reason: 'cannot_pause_removed', ...SAFETY };
    existing.status = STATUS.PAUSED;
    existing.pausedAt = nowIso(now);
    existing.updatedAt = nowIso(now);
    pushHistory(existing, id, { previousStatus, newStatus: STATUS.PAUSED, action: 'pause', source, reason: 'paused', now });
    writeStoreAtomic(store);
    return { ok: true, code: 200, changed: true, strategyId: id, status: STATUS.PAUSED, reason: 'paused', ...SAFETY };
  }

  if (action === 'resume') {
    if (!existing) return { ok: false, code: 404, changed: false, strategyId: id, reason: 'not_in_futures_approval_store', ...SAFETY };
    if (existing.status === STATUS.APPROVED) return { ok: true, code: 200, changed: false, strategyId: id, status: STATUS.APPROVED, reason: 'already_approved', ...SAFETY };
    if (existing.status !== STATUS.PAUSED) return { ok: false, code: 409, changed: false, strategyId: id, reason: `cannot_resume_from_${existing.status}`, ...SAFETY };
    // Resume behåller pågående testomgång (ingen reset).
    existing.status = STATUS.APPROVED;
    existing.pausedAt = null;
    existing.updatedAt = nowIso(now);
    pushHistory(existing, id, { previousStatus, newStatus: STATUS.APPROVED, action: 'resume', source, reason: 'resumed', now });
    writeStoreAtomic(store);
    return { ok: true, code: 200, changed: true, strategyId: id, status: STATUS.APPROVED, reason: 'resumed', ...SAFETY };
  }

  if (action === 'remove') {
    if (!existing) return { ok: false, code: 404, changed: false, strategyId: id, reason: 'not_in_futures_approval_store', ...SAFETY };
    if (existing.status === STATUS.REMOVED) return { ok: true, code: 200, changed: false, strategyId: id, status: STATUS.REMOVED, reason: 'already_removed', ...SAFETY };
    existing.status = STATUS.REMOVED;
    existing.removedAt = nowIso(now);
    existing.updatedAt = nowIso(now);
    pushHistory(existing, id, { previousStatus, newStatus: STATUS.REMOVED, action: 'remove', source, reason: 'removed', now });
    writeStoreAtomic(store);
    return { ok: true, code: 200, changed: true, strategyId: id, status: STATUS.REMOVED, reason: 'removed', ...SAFETY };
  }

  return { ok: false, code: 400, changed: false, reason: 'unknown_action', ...SAFETY };
}

const approve = (id, opts) => mutate(id, 'approve', opts);
const pause = (id, opts) => mutate(id, 'pause', opts);
const resume = (id, opts) => mutate(id, 'resume', opts);
const remove = (id, opts) => mutate(id, 'remove', opts);

// ── Gate i signalvägen (last-known-good, INGEN generell fail-open) ───────────
function evaluateFuturesApprovalGate({ strategyId, closedTs = null } = {}) {
  const id = canonicalId(strategyId);
  if (!id) return { allowed: false, blockedReason: GATE_REASON.NOT_APPROVED, strategyId: null };

  let loaded;
  try {
    loaded = loadStore();
  } catch (err) {
    // Katastrofalt fel utan last-known-good → blockera (aldrig allow-all).
    loaded = _lastGoodStore
      ? { store: _lastGoodStore, degraded: true }
      : { store: null, degraded: true };
  }
  const degraded = Boolean(loaded.degraded);
  const store = loaded.store;

  const compat = computeCompatibility(id, null, closedTs);
  if (compat.compatibility === COMPAT.NEEDS_MAPPING && compat.canonicalReplacementId) {
    return { allowed: false, blockedReason: GATE_REASON.DUPLICATE, strategyId: id, canonicalReplacementId: compat.canonicalReplacementId, degraded };
  }

  const entry = store && store.strategies ? (store.strategies[id] || null) : null;
  if (!entry) {
    // Ingen post: vid degraderat state markeras det explicit; annars ej godkänd.
    return { allowed: false, blockedReason: degraded ? GATE_REASON.DEGRADED : GATE_REASON.NOT_APPROVED, strategyId: id, degraded };
  }
  if (entry.status === STATUS.PAUSED) return { allowed: false, blockedReason: GATE_REASON.PAUSED, strategyId: id, degraded };
  if (entry.status === STATUS.REMOVED) return { allowed: false, blockedReason: GATE_REASON.REMOVED, strategyId: id, degraded };
  if (entry.status !== STATUS.APPROVED) return { allowed: false, blockedReason: GATE_REASON.NOT_APPROVED, strategyId: id, degraded };
  if (compat.compatibility !== COMPAT.READY) return { allowed: false, blockedReason: GATE_REASON.NOT_READY, strategyId: id, compatibility: compat.compatibility, degraded };

  const currentTest = computeCurrentTest(id, entry, closedTs);
  if (currentTest.currentTestStatus === 'completed') {
    return { allowed: false, blockedReason: GATE_REASON.TARGET_COMPLETED, strategyId: id, currentTest, degraded };
  }
  return { allowed: true, blockedReason: null, strategyId: id, degraded };
}

// Testhjälp: nollställ last-known-good (så degraderade tester blir deterministiska).
function __resetLastKnownGood() { _lastGoodStore = null; }

module.exports = {
  SAFETY, SCHEMA_VERSION, DEFAULT_TEST_TARGET_TRADES, STORE_FILE, STATUS, COMPAT, GATE_REASON,
  ALLOWLIST_FALLBACK_IDS, MIGRATION_SOURCE, DUPLICATE_REPLACEMENTS,
  // interna/test
  readStore, readStoreRaw, ensureMigrated, loadStore, buildMigrationSeedStore, computeMigrationUnion,
  computeCompatibility, computeCurrentTest, closedTimestampsByStrategy, __resetLastKnownGood,
  // publikt
  listStrategies, getStrategy, approve, pause, resume, remove, evaluateFuturesApprovalGate,
};
