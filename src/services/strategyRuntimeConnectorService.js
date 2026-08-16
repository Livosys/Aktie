'use strict';

const fs = require('fs');
const path = require('path');

const catalog = require('./daytradingStrategyCatalogService');
const tradeStats = require('./tradeStatsService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
  paper_only: true,
});

const RUNTIME_PARTIAL_MISSING_CRYPTO_SIGNAL_CONTEXT = 'runtime_partial_missing_crypto_signal_context';
const RUNTIME_PARTIAL_MISSING_CRYPTO_SIGNAL_CONTEXT_SV = 'Runtime partial — saknar crypto signal context.';

const EVENTS_FILE = path.resolve(__dirname, '../../data/paper-trading/events.jsonl');
const STATE_FILE = path.resolve(__dirname, '../../data/paper-trading/state.json');
const CONTROL_CONFIG_FILE = path.resolve(__dirname, '../../data/config/daytrading-control.json');
const NARROW_STATE_GRAPH_DIR = path.resolve(__dirname, '../../data/signals/state-graph');
const WINDOW_HOURS = 48;

function nowMs() {
  return Date.now();
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readControlConfig() {
  const saved = readJson(CONTROL_CONFIG_FILE, {});
  return {
    strategies: saved && typeof saved.strategies === 'object' ? saved.strategies : {},
  };
}

function parseTime(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function timeOf(row = {}) {
  return row.opened_at || row.entryTime || row.timestamp || row.ts || row.created_at || row.closed_at || null;
}

function withinWindow(row = {}, hours = WINDOW_HOURS) {
  const time = parseTime(timeOf(row));
  return time != null && nowMs() - time <= hours * 60 * 60 * 1000;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function rawSignalOf(input = {}) {
  return upper(
    input.raw_strategy ||
    input.signal_subtype ||
    input.signalSubtype ||
    input.strategy ||
    input.eventType ||
    input.signal ||
    input.signalFamily ||
    'UNKNOWN',
  );
}

function firstTextValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function normalizeStrategyId(value) {
  const text = firstTextValue(value);
  return text || null;
}

function isSystemInfoSignal(signal = {}) {
  const raw = upper(rawSignalOf(signal));
  const status = upper(signal.status || signal.decision || signal.blockerMode || signal.discoveryMode || '');
  const eventType = upper(signal.eventType || signal.type || '');
  const reason = upper(signal.reasonSv || signal.reason || signal.comment_sv || signal.runtime_comment_sv || '');
  return (
    ['MARKET_CLOSED', 'AGENT_STARTED', 'AGENT_READY', 'HEARTBEAT', 'SYSTEM_INFO', 'INFO'].includes(raw) ||
    ['MARKET_CLOSED', 'AGENT_STARTED', 'AGENT_READY', 'HEARTBEAT'].includes(eventType) ||
    status === 'VÄNTA' ||
    status === 'WAIT' ||
    status === 'WÄNTA' ||
    status === 'Vänta'.toUpperCase() ||
    reason.includes('MARKET CLOSED') ||
    reason.includes('AGENT STARTED') ||
    reason.includes('VÄNTA')
  );
}

function isRealTradeCandidateSignal(signal = {}) {
  if (isSystemInfoSignal(signal)) return false;
  const raw = rawSignalOf(signal);
  return Boolean(
    raw &&
    raw !== 'UNKNOWN' &&
    raw !== 'VÄNTA' &&
    raw !== 'WAIT' &&
    raw !== 'MARKET_CLOSED' &&
    raw !== 'AGENT_STARTED'
  );
}

// FAS C mapping-fix: signaler som ALDRIG får mappas till en strategi.
// Returnerar en stabil blocked_reason_code, eller null när signalen är
// mappningsbar. UNKNOWN/NO_TRADE/LATE_MOVE_BLOCK är brus-/blocksignaler,
// och crypto-VWAP saknar eget strategy contract (crypto_momentum_scalper får
// bara matchas av sitt verifierade contract: REGULAR_PULLBACK + full context).
function nonMappableSignalReason(signal = {}, raw = rawSignalOf(signal)) {
  const family = upper(signal.signalFamily || '');
  if (raw === 'NO_TRADE') return 'no_trade_signal';
  if (raw === 'LATE_MOVE_BLOCK' || family === 'LATE_MOVE_BLOCK') return 'late_move_block';
  if (raw === 'UNKNOWN') return 'unknown_signal_mapping';
  const isCrypto = marketOf(signal) === 'crypto' || String(signal.symbol || '').toUpperCase().endsWith('USDT');
  if (isCrypto && (raw === 'VWAP_RECLAIM_UP' || raw === 'VWAP_REJECTION_DOWN')) {
    return cryptoSignalContextOf(signal)
      ? 'unknown_signal_mapping'
      : 'runtime_partial_missing_crypto_signal_context';
  }
  return null;
}

function resolveStrategyMetadata(signal = {}, options = {}) {
  const allowLegacyFallback = options.allowLegacyFallback !== false;
  const raw = rawSignalOf(signal);
  const sourceStrategyId = normalizeStrategyId(
    signal.sourceStrategyId ||
    signal.sourceStrategyID ||
    null,
  );
  const explicitStrategyId = normalizeStrategyId(
    sourceStrategyId ||
    signal.strategyId ||
    signal.strategy_id ||
    signal.setupId ||
    null,
  );
  const sourceStrategyName = firstTextValue(
    signal.sourceStrategyName,
    signal.strategyLabel,
    null,
  );
  const metadata = {
    sourceStrategyId,
    sourceStrategyName,
    resolvedStrategyId: null,
    resolvedStrategyName: null,
    strategyId: null,
    strategyName: null,
    mappingSource: 'unknown',
    raw_strategy: raw,
    signal_subtype: raw,
  };

  const exactRuntimeEntry = findMapEntry(signal);
  if (exactRuntimeEntry?.strategy_id) {
    metadata.resolvedStrategyId = exactRuntimeEntry.strategy_id;
    metadata.resolvedStrategyName = catalog.getStrategyById(exactRuntimeEntry.strategy_id)?.name || exactRuntimeEntry.strategy_id;
    metadata.strategyId = metadata.resolvedStrategyId;
    metadata.strategyName = metadata.resolvedStrategyName;
    metadata.mappingSource = 'runtime_map';
    return metadata;
  }

  if (explicitStrategyId) {
    metadata.resolvedStrategyId = explicitStrategyId;
    metadata.resolvedStrategyName = sourceStrategyName || catalog.getStrategyById(explicitStrategyId)?.name || explicitStrategyId;
    metadata.strategyId = metadata.resolvedStrategyId;
    metadata.strategyName = metadata.resolvedStrategyName;
    metadata.mappingSource = 'explicit';
    return metadata;
  }

  if (isSystemInfoSignal(signal)) {
    return metadata;
  }

  // FAS C: brus-/blocksignaler och contract-lösa crypto-VWAP-signaler får
  // aldrig nå keyword-/legacy-inferensen — de förblir omappade med stabil
  // reason så att runtime blockerar ärligt i stället för att felattribuera.
  const nonMappableReasonCode = nonMappableSignalReason(signal, raw);
  if (nonMappableReasonCode) {
    metadata.nonMappableReasonCode = nonMappableReasonCode;
    return metadata;
  }

  const runtimeStrategyId =
    exactRuntimeEntry?.strategy_id ||
    strategyIdFromSignal(signal);
  if (runtimeStrategyId) {
    metadata.resolvedStrategyId = runtimeStrategyId;
    metadata.resolvedStrategyName = catalog.getStrategyById(runtimeStrategyId)?.name || runtimeStrategyId;
    metadata.strategyId = metadata.resolvedStrategyId;
    metadata.strategyName = metadata.resolvedStrategyName;
    metadata.mappingSource = 'runtime_inference';
    return metadata;
  }

  if (allowLegacyFallback && !hasSpecificRuntimeSubtype(signal) && isRealTradeCandidateSignal(signal)) {
    const catalogStrategy = catalog.inferStrategyForSignal(signal);
    if (catalogStrategy?.id) {
      metadata.resolvedStrategyId = catalogStrategy.id;
      metadata.resolvedStrategyName = catalogStrategy.name || catalog.getStrategyById(catalogStrategy.id)?.name || catalogStrategy.id;
      metadata.strategyId = metadata.resolvedStrategyId;
      metadata.strategyName = metadata.resolvedStrategyName;
      metadata.mappingSource = 'legacy_fallback';
    }
  }

  return metadata;
}

function marketOf(input = {}) {
  const symbol = upper(input.symbol);
  const market = String(input.marketType || input.market || input.marketGroup || input.market_group || '').toLowerCase();
  if (market === 'crypto' || symbol.endsWith('USDT')) return 'crypto';
  if (market.includes('crypto')) return 'crypto';
  return market || 'stocks';
}

function directionOf(input = {}) {
  const direct = upper(input.direction || input.nextMoveBias);
  if (direct === 'UP' || direct === 'LONG' || direct === 'BUY') return 'UP';
  if (direct === 'DOWN' || direct === 'SHORT' || direct === 'SELL') return 'DOWN';
  return 'UNKNOWN';
}

function cryptoSignalContextOf(signal = {}) {
  return signal.crypto_signal_context || signal.crypto_context || null;
}

function buildCryptoSignalContext(signal = {}) {
  if (marketOf(signal) !== 'crypto') return null;

  const signalSubtypeRaw = upper(signal.signalSubtype || signal.signal_subtype || signal.eventType || '');
  const signalSubtype = signal.signalSubtype || signal.signal_subtype
    || (signalSubtypeRaw === 'REGULAR_PULLBACK' ? 'REGULAR_PULLBACK' : 'UNKNOWN');
  const signalFamily = signal.signalFamily || signal.signal_family || null;

  return {
    symbol: upper(signal.symbol) || null,
    market: 'crypto',
    marketType: signal.marketType || signal.market || 'crypto',
    marketGroup: signal.marketGroup || signal.market_group || signal.market || 'crypto',
    signal: signal.signal || signal.status || null,
    eventType: signal.eventType || null,
    signalFamily,
    signalSubtype,
    marketRegime: signal.marketRegime || signal.marketRegimeV2 || null,
    daytradeStatus: signal.daytradeStatus || null,
    daytradeDirection: signal.daytradeDirection || null,
    daytradeRisk: signal.daytradeRisk || null,
    volumeState: signal.volumeState || null,
    rvol: signal.rvol ?? signal.relVol20 ?? null,
    signalScore: signal.signalScore ?? null,
    tradeScore: signal.tradeScore ?? null,
    marketScore: signal.marketScore ?? null,
    marketScoreV2: signal.marketScoreV2 ?? null,
    marketContext: signal.marketContext || null,
    momentumContinuationContext: signal.momentumContinuationContext || null,
    stateGraph: signal.stateGraph || null,
    narrow_state_data: signal.narrow_state_data || signal.stateGraph || null,
    strategy_id: signal.strategy_id || signal.strategyId || null,
    strategy_name: signal.strategy_name || signal.strategyName || null,
    nextMoveBias: signal.nextMoveBias || signal.direction || null,
  };
}

function getCurrentScannerRows() {
  try {
    const scheduler = require('../scanner/scheduler');
    const cryptoScheduler = require('../scanner/cryptoScheduler');
    return [
      ...(typeof scheduler.getLatestResults === 'function' ? scheduler.getLatestResults() || [] : []),
      ...(typeof cryptoScheduler.getCryptoResults === 'function' ? cryptoScheduler.getCryptoResults() || [] : []),
    ];
  } catch (_) {
    return [];
  }
}

function normalizedStrategyIdFromRow(row = {}) {
  return row.resolvedStrategyId || row.strategyId || row.strategy_id || row.sourceStrategyId || row.setupId || null;
}

function rowHasNarrowStateData(row = {}) {
  return row.narrow_state_data != null || row.stateGraph != null || row.narrowState != null;
}

const NARROW_STATE_CACHE_TTL_MS = 60 * 1000;
let narrowStatePresenceCache = { loadedAt: 0, present: false };

function hasPersistedNarrowStateData() {
  const now = Date.now();
  if (now - narrowStatePresenceCache.loadedAt < NARROW_STATE_CACHE_TTL_MS) return narrowStatePresenceCache.present;
  let present = false;
  try {
    if (fs.existsSync(NARROW_STATE_GRAPH_DIR)) {
      const entries = fs.readdirSync(NARROW_STATE_GRAPH_DIR).filter((file) => file.endsWith('.json'));
      for (const file of entries) {
        const fullPath = path.join(NARROW_STATE_GRAPH_DIR, file);
        const stat = fs.statSync(fullPath);
        if (stat.size > 0) {
          present = true;
          break;
        }
      }
    }
  } catch (_) {
    present = false;
  }
  narrowStatePresenceCache = { loadedAt: now, present };
  return present;
}

function narrowStateDataPresentForStrategy(strategyId, rows = null) {
  const target = String(strategyId || '').toLowerCase();
  if (!target) return false;
  const sourceRows = rows || getCurrentScannerRows();
  if (sourceRows.some((row) => String(normalizedStrategyIdFromRow(row) || '').toLowerCase() === target && rowHasNarrowStateData(row))) return true;
  if (!missingDataForStrategy({ id: target }).includes('narrow_state_data')) return false;
  return hasPersistedNarrowStateData();
}

function cryptoSignalContextPresentForStrategy(strategyId, rows = null) {
  const target = String(strategyId || '').toLowerCase();
  if (!target) return false;

  const strategy = catalog.getStrategyById(target);
  const isCryptoStrategy = Boolean(
    strategy && (
      String(strategy.market_group || '').toLowerCase() === 'crypto'
      || String(strategy.market || '').toLowerCase() === 'crypto'
      || String(strategy.id || '').toLowerCase().startsWith('crypto_')
    ),
  );
  if (!isCryptoStrategy) return false;

  const sourceRows = rows || getCurrentScannerRows();
  return sourceRows.some((row) => {
    const rowStrategyId = String(normalizedStrategyIdFromRow(row) || '').toLowerCase();
    if (rowStrategyId !== target) return false;
    return Boolean(cryptoSignalContextOf(row));
  });
}

function strategyMeta(strategyId) {
  const strategy = catalog.getStrategyById(strategyId);
  return {
    strategy_id: strategyId,
    strategy_name: strategy?.name || strategyId,
  };
}

function statusLabel(status) {
  if (status === 'active') return 'Kan köra paper trades';
  if (status === 'partial') return 'Delvis kopplad';
  if (status === 'paused') return 'Pausad';
  if (status === 'disabled') return 'Av';
  if (status === 'no_entry_rule') return 'Saknar entry-regel';
  if (status === 'needs_data') return 'Behöver mer data';
  if (status === 'not_connected') return 'Ej kopplad';
  return 'Okänd';
}

function canCreateLabel(value) {
  if (value === true) return 'ja';
  if (value === 'partial') return 'delvis';
  return 'nej';
}

function runtimeSignalsForStrategyRecord(strategy = {}) {
  return Array.isArray(strategy.runtime_signals)
    ? strategy.runtime_signals.filter((signal) => signal && signal.raw_signal)
    : [];
}

function runtimeMapStatusFor(strategy = {}, signal = {}) {
  if (signal.runtime_status) return signal.runtime_status;
  if (strategy.active === false || DISABLED_RUNTIME_STRATEGY_IDS.has(strategy.id)) return 'disabled';
  if (PARTIAL_RUNTIME_STRATEGY_IDS.has(strategy.id)) return 'partial';
  return 'active';
}

function runtimeEntryFromMetadata(strategy = {}, signal = {}) {
  const rawSignal = upper(signal.raw_signal || signal.signal_subtype);
  if (!strategy.id || !rawSignal) return null;
  const runtimeStatus = runtimeMapStatusFor(strategy, signal);
  const canCreate = signal.can_create_paper_trade ?? (runtimeStatus === 'active');
  const meta = strategyMeta(strategy.id);
  return {
    raw_signal: rawSignal,
    signal_subtype: rawSignal,
    signal_family: signal.signal_family || null,
    ...meta,
    strategy_family: signal.signal_family || strategy.engines_used?.[0] || strategy.market_label || strategy.family || strategy.market_group || 'UNKNOWN',
    runtime_status: runtimeStatus,
    runtime_label: statusLabel(runtimeStatus),
    direction: upper(signal.direction || strategy.direction || 'UNKNOWN'),
    mapping_confidence: signal.mapping_confidence || 'medium',
    can_create_paper_trade: canCreate,
    can_create_paper_trade_label: canCreateLabel(canCreate),
    entry_rule_implemented: canCreate === true || canCreate === 'partial',
    connected: true,
    market: String(signal.market || strategy.market_group || strategy.market || 'all').toLowerCase(),
    narrow_state_data: null,
    comment_sv: signal.comment_sv || null,
    ...SAFETY,
  };
}

function getRuntimeStrategyMap() {
  return (catalog.getCatalog().strategies || [])
    .flatMap((strategy) => runtimeSignalsForStrategyRecord(strategy)
      .filter((signal) => signal.routing_enabled !== false)
      .map((signal) => runtimeEntryFromMetadata(strategy, signal)))
    .filter(Boolean);
}

function explicitRuntimeSubtypeOf(signal = {}) {
  return upper(
    signal.signalSubtype ||
    signal.signal_subtype ||
    signal.eventType ||
    signal.raw_signal ||
    signal.raw_strategy ||
    '',
  );
}

function hasSpecificRuntimeSubtype(signal = {}) {
  const subtype = explicitRuntimeSubtypeOf(signal);
  return Boolean(subtype && !['UNKNOWN', 'NO_TRADE', 'WAIT', 'VÄNTA', 'MARKET_CLOSED'].includes(subtype));
}

const INDEX_KINSHIP_MARKETS = new Set(['stock', 'stocks', 'equity', 'equities', 'index', 'indices', 'etf', 'etfs', 'future', 'futures']);
const MNQ_INDEX_FUTURES_SYMBOLS = new Set(['MNQ', 'NQ', 'NASDAQ', 'NASDAQ100', 'NAS100']);

function marketMatches(entryMarket, signalMarket, signalObject = {}) {
  const entry = String(entryMarket || 'all').toLowerCase();
  const signal = String(signalMarket || 'stocks').toLowerCase();
  if (entry === 'all') return true;
  if (entry === signal) return true;
  if (entry === 'index_kinship') {
    return INDEX_KINSHIP_MARKETS.has(signal);
  }
  if (entry === 'mnq_index_kinship') {
    if (!INDEX_KINSHIP_MARKETS.has(signal)) return false;
    if (signal === 'future' || signal === 'futures') {
      return MNQ_INDEX_FUTURES_SYMBOLS.has(upper(signalObject.symbol || signalObject.futuresSymbol || signalObject.rootSymbol));
    }
    return true;
  }
  if (entry === 'stocks') return signal !== 'crypto' && signal !== 'futures';
  return false;
}

function directionMatches(entryDirection, signalDirection) {
  const entry = upper(entryDirection || 'UNKNOWN');
  const signal = upper(signalDirection || 'UNKNOWN');
  if (entry === 'BOTH' || entry === 'UNKNOWN') return true;
  if (signal === 'UNKNOWN') return entry === 'UNKNOWN' || entry === 'BOTH';
  return entry === signal;
}

function chooseBestMapEntry(entries = [], direction = 'UNKNOWN') {
  if (!entries.length) return null;
  const signalDirection = upper(direction || 'UNKNOWN');
  return entries.find((entry) => upper(entry.direction) === signalDirection)
    || entries.find((entry) => ['UNKNOWN', 'BOTH'].includes(upper(entry.direction)))
    || entries[0];
}

function findMapEntry(signal = {}) {
  const raw = rawSignalOf(signal);
  const market = marketOf(signal);
  const direction = directionOf(signal);
  const map = getRuntimeStrategyMap();

  const exact = map.filter((entry) => entry.raw_signal === raw && marketMatches(entry.market, market, signal));
  if (exact.length) return chooseBestMapEntry(exact, direction);

  if (hasSpecificRuntimeSubtype(signal)) return null;

  const family = upper(signal.signalFamily || signal.signal_family || '');
  if (!family) return null;
  return chooseBestMapEntry(
    map.filter((entry) => upper(entry.signal_family) === family
      && marketMatches(entry.market, market, signal)
      && directionMatches(entry.direction, direction)),
    direction,
  );
}

function nonPaperEntryOverrideFor(entry = null) {
  if (!entry || entry.can_create_paper_trade !== false) return null;
  const raw = upper(entry.raw_signal || entry.signal_subtype);
  const code = raw === 'REGULAR_PULLBACK'
    ? 'setup_not_paper_entry'
    : `${raw.toLowerCase()}_not_paper_entry`;
  const reason = raw === 'REGULAR_PULLBACK'
    ? 'REGULAR_PULLBACK är inte en paper-entry-setup (setup_not_paper_entry).'
    : raw === 'NARROW_WAIT'
      ? 'NARROW_WAIT är ett vänteläge och inte en paper-entry-setup.'
      : `${raw} är inte en paper-entry-setup (${code}).`;
  return {
    can_create_paper_trade: false,
    can_create_paper_trade_label: canCreateLabel(false),
    blocked_reason_code: code,
    reason_sv: reason,
    skip_reason_sv: reason,
  };
}

function exactNonPaperEntryOverrideForSignal(signal = {}, raw = rawSignalOf(signal)) {
  let mapEntry = null;
  try { mapEntry = findMapEntry(signal); } catch (_) { mapEntry = null; }
  if (!mapEntry || mapEntry.raw_signal !== raw) return null;
  return nonPaperEntryOverrideFor(mapEntry);
}

function inferStrategyForSignal(signal = {}) {
  let raw = 'UNKNOWN';
  let strategyId = null;
  try {
    raw = rawSignalOf(signal);
    const metadata = resolveStrategyMetadata(signal, { allowLegacyFallback: true });
    strategyId = metadata.resolvedStrategyId;
    if (!strategyId) {
      // FAS C: stabil blocked_reason_code för omappade signaler så att
      // canCreatePaperTradeForSignal och eventloggen kan blockera ärligt.
      const unmappedReasonCode = metadata.nonMappableReasonCode || 'unknown_signal_mapping';
      const unmappedReasonSv = unmappedReasonCode === 'no_trade_signal'
        ? 'NO_TRADE är en brussignal och mappas aldrig till en strategi.'
        : unmappedReasonCode === 'late_move_block'
          ? 'LATE_MOVE_BLOCK är en blocksignal och mappas aldrig till en strategi.'
          : unmappedReasonCode === 'runtime_partial_missing_crypto_signal_context'
            ? 'Crypto-VWAP saknar strategy-specifikt crypto signal context — ingen fallback-mapping.'
            : 'Ingen säker runtime-mapping finns. Strategin markeras som ej kopplad.';
      return {
        raw_strategy: raw,
        signal_subtype: raw,
        strategy_id: null,
        strategy_name: null,
        strategy_family: upper(signal.signalFamily) || 'UNKNOWN',
        mapping_source: metadata.mappingSource,
        sourceStrategyId: metadata.sourceStrategyId,
        sourceStrategyName: metadata.sourceStrategyName,
        resolvedStrategyId: metadata.resolvedStrategyId,
        resolvedStrategyName: metadata.resolvedStrategyName,
        mappingSource: metadata.mappingSource,
        runtime_status: 'not_connected',
        runtime_label: statusLabel('not_connected'),
        mapping_confidence: 'low',
        can_create_paper_trade: false,
        can_create_paper_trade_label: 'nej',
        connected: false,
        entry_rule_implemented: false,
        enabled_by_user: false,
        blocked_reason_code: unmappedReasonCode,
        skip_reason_sv: unmappedReasonSv,
        reason_sv: unmappedReasonSv,
        runtime_comment_sv: unmappedReasonSv,
        comment_sv: unmappedReasonSv,
        crypto_signal_context: cryptoSignalContextOf(signal),
        crypto_context: cryptoSignalContextOf(signal),
        source: 'strategy_runtime_connector_v2',
        ...SAFETY,
      };
    }
  } catch (_) {
    strategyId = null;
  }
  const cryptoContext = cryptoSignalContextOf(signal);
  const metadata = resolveStrategyMetadata(signal, { allowLegacyFallback: true });
  const cryptoMomentumEligible =
    strategyId === 'crypto_momentum_scalper' &&
    !!cryptoContext &&
    (raw === 'REGULAR_PULLBACK' || upper(signal.signalSubtype || signal.signal_subtype || signal.eventType || '') === 'REGULAR_PULLBACK');

  if (strategyId) {
    const runtime = baseRuntimeForStrategy(strategyId, readControlConfig().strategies?.[strategyId] || {});
    if (cryptoMomentumEligible) {
      return {
        strategy_id: strategyId,
        strategyId: strategyId,
        strategy_name: catalog.getStrategyById(strategyId)?.name || runtime.strategy_name || strategyId,
        strategyName: catalog.getStrategyById(strategyId)?.name || runtime.strategy_name || strategyId,
        strategy_family: catalog.getStrategyById(strategyId)?.engines_used?.[0] || runtime.strategy_family || catalog.getStrategyById(strategyId)?.market_label || catalog.getStrategyById(strategyId)?.market_group || 'UNKNOWN',
        sourceStrategyId: metadata.sourceStrategyId,
        sourceStrategyName: metadata.sourceStrategyName,
        resolvedStrategyId: metadata.resolvedStrategyId || strategyId,
        resolvedStrategyName: metadata.resolvedStrategyName || catalog.getStrategyById(strategyId)?.name || runtime.strategy_name || strategyId,
        mappingSource: metadata.mappingSource,
        ...runtime,
        runtime_status: 'active',
        runtime_label: statusLabel('active'),
        can_create_paper_trade: true,
        can_create_paper_trade_label: canCreateLabel(true),
        entry_rule_implemented: true,
        connected: true,
        missing_data: [],
        reason_sv: 'Ready: crypto context present for paper/replay/batch only.',
        skip_reason_sv: null,
        runtime_comment_sv: 'Crypto-context finns i signalen. Strategin kan nu utvärderas i paper/replay/batch.',
        comment_sv: 'Crypto-context finns i signalen. Strategin kan nu utvärderas i paper/replay/batch.',
        raw_strategy: raw,
        signal_subtype: raw,
        mapping_source: metadata.mappingSource,
        source: 'strategy_runtime_connector_v2',
        crypto_signal_context: cryptoContext,
        crypto_context: cryptoContext,
        ...SAFETY,
      };
    }
    const strategy = catalog.getStrategyById(strategyId);
    // Exact per-signal flags in the runtime map win over strategy-level runtime:
    // setups marked can_create_paper_trade:false must not open paper trades just
    // because their target strategy is active or explicitly approved.
    const setupNotPaperEntry = exactNonPaperEntryOverrideForSignal(signal, raw);
    return {
      strategy_id: strategyId,
      strategyId: strategyId,
      strategy_name: strategy?.name || runtime.strategy_name || strategyId,
      strategyName: strategy?.name || runtime.strategy_name || strategyId,
      strategy_family: strategy?.engines_used?.[0] || runtime.strategy_family || strategy?.market_label || strategy?.market_group || 'UNKNOWN',
      sourceStrategyId: metadata.sourceStrategyId,
      sourceStrategyName: metadata.sourceStrategyName,
      resolvedStrategyId: metadata.resolvedStrategyId || strategyId,
      resolvedStrategyName: metadata.resolvedStrategyName || strategy?.name || runtime.strategy_name || strategyId,
      mappingSource: metadata.mappingSource,
      ...runtime,
      ...(setupNotPaperEntry || {}),
      raw_strategy: raw,
      signal_subtype: raw,
      mapping_source: metadata.mappingSource,
      runtime_comment_sv: runtime.runtime_comment_sv || runtime.comment_sv,
      comment_sv: runtime.runtime_comment_sv || runtime.comment_sv,
      crypto_signal_context: cryptoContext,
      crypto_context: cryptoContext,
      source: 'strategy_runtime_connector_v2',
      ...SAFETY,
    };
  }
  let entry = null;
  try {
    entry = findMapEntry(signal);
  } catch (_) {
    entry = null;
  }
  if (entry) {
    const runtime = baseRuntimeForStrategy(entry.strategy_id, readControlConfig().strategies?.[entry.strategy_id] || {});
    if (entry.strategy_id === 'crypto_momentum_scalper' && cryptoMomentumEligible) {
      return {
        ...entry,
        ...runtime,
        runtime_status: 'active',
        runtime_label: statusLabel('active'),
        can_create_paper_trade: true,
        can_create_paper_trade_label: canCreateLabel(true),
        entry_rule_implemented: true,
        connected: true,
        missing_data: [],
        reason_sv: 'Ready: crypto context present for paper/replay/batch only.',
        skip_reason_sv: null,
        runtime_comment_sv: 'Crypto-context finns i signalen. Strategin kan nu utvärderas i paper/replay/batch.',
        comment_sv: 'Crypto-context finns i signalen. Strategin kan nu utvärderas i paper/replay/batch.',
        raw_strategy: raw,
        signal_subtype: raw,
        crypto_signal_context: cryptoContext,
        crypto_context: cryptoContext,
        source: 'strategy_runtime_connector_v2',
        ...SAFETY,
      };
    }
    return {
      ...entry,
      ...runtime,
      ...(nonPaperEntryOverrideFor(entry) || {}),
      raw_strategy: raw,
      signal_subtype: raw,
      runtime_comment_sv: runtime.runtime_comment_sv || runtime.comment_sv || entry.comment_sv,
      comment_sv: runtime.runtime_comment_sv || runtime.comment_sv || entry.comment_sv,
      crypto_signal_context: cryptoContext,
      crypto_context: cryptoContext,
      source: 'strategy_runtime_connector_v2',
      ...SAFETY,
    };
  }
  return {
    raw_strategy: raw,
    signal_subtype: raw,
    strategy_id: null,
    strategyId: null,
    strategy_name: null,
    strategyName: null,
    strategy_family: upper(signal.signalFamily) || 'UNKNOWN',
    sourceStrategyId: metadata.sourceStrategyId,
    sourceStrategyName: metadata.sourceStrategyName,
    resolvedStrategyId: null,
    resolvedStrategyName: null,
    mappingSource: metadata.mappingSource,
    runtime_status: 'not_connected',
    runtime_label: statusLabel('not_connected'),
    mapping_confidence: 'low',
    can_create_paper_trade: false,
    can_create_paper_trade_label: 'nej',
    connected: false,
    entry_rule_implemented: false,
    enabled_by_user: false,
    runtime_comment_sv: 'Ingen säker runtime-mapping finns. Strategin markeras som ej kopplad.',
    comment_sv: 'Ingen säker runtime-mapping finns. Strategin markeras som ej kopplad.',
    crypto_signal_context: cryptoContext,
    crypto_context: cryptoContext,
    source: 'strategy_runtime_connector_v2',
    ...SAFETY,
  };
}

function enrichSignalWithStrategy(signal = {}) {
  const metadata = resolveStrategyMetadata(signal, { allowLegacyFallback: true });
  const inferred = inferStrategyForSignal(signal);
  return {
    ...signal,
    sourceStrategyId: signal.sourceStrategyId || metadata.sourceStrategyId || null,
    sourceStrategyName: signal.sourceStrategyName || metadata.sourceStrategyName || null,
    resolvedStrategyId: signal.resolvedStrategyId || signal.strategyId || signal.strategy_id || metadata.resolvedStrategyId || inferred.resolvedStrategyId || inferred.strategy_id || null,
    resolvedStrategyName: signal.resolvedStrategyName || signal.strategyName || signal.strategy_name || metadata.resolvedStrategyName || inferred.resolvedStrategyName || inferred.strategy_name || null,
    mappingSource: signal.mappingSource || metadata.mappingSource || (signal.strategyId || signal.strategy_id || signal.setupId || signal.sourceStrategyId || metadata.resolvedStrategyId ? 'explicit' : null) || inferred.mappingSource || inferred.mapping_source || 'unknown',
    strategy_id: signal.strategy_id || signal.strategyId || metadata.strategyId || inferred.strategy_id || metadata.resolvedStrategyId || null,
    strategyId: signal.strategyId || signal.strategy_id || metadata.strategyId || inferred.strategy_id || metadata.resolvedStrategyId || null,
    strategy_name: signal.strategy_name || signal.strategyName || metadata.strategyName || inferred.strategy_name || metadata.resolvedStrategyName || null,
    strategyName: signal.strategyName || signal.strategy_name || metadata.strategyName || inferred.strategy_name || metadata.resolvedStrategyName || null,
    strategy_family: signal.strategy_family || inferred.strategy_family,
    raw_strategy: signal.raw_strategy || inferred.raw_strategy,
    signal_subtype: signal.signal_subtype || inferred.signal_subtype,
    mapping_confidence: signal.mapping_confidence || inferred.mapping_confidence,
    runtime_status: signal.runtime_status || inferred.runtime_status,
    runtime_label: signal.runtime_label || inferred.runtime_label,
    runtime_comment_sv: signal.runtime_comment_sv || inferred.runtime_comment_sv,
    can_create_paper_trade: signal.can_create_paper_trade ?? inferred.can_create_paper_trade,
    crypto_signal_context: signal.crypto_signal_context || inferred.crypto_signal_context || null,
    crypto_context: signal.crypto_context || inferred.crypto_context || null,
    narrow_state_data: signal.narrow_state_data || signal.stateGraph || inferred.narrow_state_data || inferred.stateGraph || null,
  };
}

function enrichPaperTradeWithStrategy(trade = {}) {
  const metadata = resolveStrategyMetadata(trade, { allowLegacyFallback: true });
  let inferred = null;
  try {
    inferred = inferStrategyForSignal(trade);
  } catch (_) {
    inferred = {
      strategy_id: null,
      strategy_name: null,
      strategy_family: 'UNKNOWN',
      raw_strategy: rawSignalOf(trade),
      signal_subtype: rawSignalOf(trade),
      mapping_confidence: 'low',
      runtime_status: 'not_connected',
      runtime_label: statusLabel('not_connected'),
      runtime_comment_sv: 'Runtime-mapping kunde inte läsas.',
      can_create_paper_trade: false,
      connected: false,
      entry_rule_implemented: false,
      ...SAFETY,
    };
  }
  const strategyId = trade.resolvedStrategyId || trade.strategy_id || trade.strategyId || metadata.resolvedStrategyId || inferred.strategy_id;
  const strategyName = trade.resolvedStrategyName || trade.strategy_name || trade.strategyName || metadata.resolvedStrategyName || inferred.strategy_name;
  const raw = trade.raw_strategy || trade.signal_subtype || trade.signalSubtype || trade.strategy || inferred.raw_strategy;
  return {
    ...trade,
    strategy: trade.strategy || raw || strategyName || 'Paper-strategi',
    raw_strategy: raw || null,
    signal_subtype: trade.signal_subtype || trade.signalSubtype || raw || null,
    strategy_id: trade.strategy_id || trade.strategyId || metadata.strategyId || strategyId || null,
    strategyId: trade.strategyId || trade.strategy_id || metadata.strategyId || strategyId || null,
    strategy_name: strategyName || null,
    strategyName: strategyName || null,
    sourceStrategyId: trade.sourceStrategyId || metadata.sourceStrategyId || null,
    sourceStrategyName: trade.sourceStrategyName || metadata.sourceStrategyName || null,
    resolvedStrategyId: trade.resolvedStrategyId || trade.strategyId || trade.strategy_id || metadata.resolvedStrategyId || strategyId || null,
    resolvedStrategyName: trade.resolvedStrategyName || trade.strategyName || trade.strategy_name || metadata.resolvedStrategyName || strategyName || null,
    mappingSource: trade.mappingSource || metadata.mappingSource || (trade.strategyId || trade.strategy_id || trade.setupId || trade.sourceStrategyId ? 'explicit' : null) || inferred.mappingSource || inferred.mapping_source || 'unknown',
    strategy_family: trade.strategy_family || inferred.strategy_family,
    mapping_confidence: trade.mapping_confidence || inferred.mapping_confidence,
  runtime_status: trade.runtime_status || inferred.runtime_status,
  runtime_label: trade.runtime_label || inferred.runtime_label,
  runtime_comment_sv: trade.runtime_comment_sv || inferred.runtime_comment_sv,
  can_create_paper_trade: trade.can_create_paper_trade ?? inferred.can_create_paper_trade,
  crypto_signal_context: trade.crypto_signal_context || inferred.crypto_signal_context || null,
  crypto_context: trade.crypto_context || inferred.crypto_context || null,
  connected: trade.connected ?? inferred.connected ?? false,
  enabled_by_user: trade.enabled_by_user ?? inferred.enabled_by_user ?? false,
  entry_rule_implemented: trade.entry_rule_implemented ?? inferred.entry_rule_implemented ?? false,
  };
}

function topReasons(rows, rawSignals) {
  const allowed = new Set((rawSignals || []).map(upper));
  const counts = {};
  for (const row of rows) {
    const raw = rawSignalOf(row);
    if (allowed.size && !allowed.has(raw)) continue;
    const reason = row.reasonSv || row.reason || row.type || 'Okänd stopporsak';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));
}

function tradeStatsByStrategy() {
  const trades = tradeStats.loadPaperTrades()
    .filter((trade) => withinWindow(trade))
    .map(enrichPaperTradeWithStrategy);
  const stats = new Map();
  const rawCounts = new Map();
  for (const trade of trades) {
    const raw = rawSignalOf(trade);
    rawCounts.set(raw, (rawCounts.get(raw) || 0) + 1);
    const id = trade.strategy_id || 'not_connected';
    const row = stats.get(id) || { paper_trades_48h: 0, last_paper_trade_at: null, raw_signals: new Set() };
    row.paper_trades_48h += 1;
    row.raw_signals.add(raw);
    const ts = timeOf(trade);
    if (ts && (!row.last_paper_trade_at || String(ts) > String(row.last_paper_trade_at))) row.last_paper_trade_at = ts;
    stats.set(id, row);
  }
  return { trades, stats, rawCounts };
}

const PARTIAL_RUNTIME_STRATEGY_IDS = new Set([
  'opening_range_breakout',
  'opening_range_fakeout',
  'opening_range_retest_long',
  'index_supported_momentum_long',
  'index_confirmed_long',
  'index_confirmed_short',
  'crypto_momentum_scalper',
  'narrow_breakout',
  'narrow_state_expansion_long',
  'narrow_state_fakeout_reversal',
  'narrow_fakeout_reversal_v1',
  'news_volatility_watch',
]);

const DISABLED_RUNTIME_STRATEGY_IDS = new Set(['crypto_fast_momentum']);

function strategyRulesOf(strategy = {}) {
  return new Set((strategy.signal_rules || []).map((rule) => String(rule || '').toLowerCase()));
}

function runtimeRawSignalsForStrategy(strategyId) {
  const strategy = catalog.getStrategyById(strategyId);
  return [...new Set(runtimeSignalsForStrategyRecord(strategy)
    .filter((signal) => signal.profile_signal !== false)
    .map((signal) => upper(signal.raw_signal || signal.signal_subtype))
    .filter(Boolean))];
}

function requiredDataForStrategy(strategy = {}) {
  const rules = strategyRulesOf(strategy);
  const required = new Set(['price', 'volume']);
  if ([...rules].some((rule) => rule.includes('vwap'))) {
    required.add('vwap');
    required.add('momentum');
  }
  if ([...rules].some((rule) => rule.includes('ema'))) {
    required.add('ema');
    required.add('momentum');
  }
  if ([...rules].some((rule) => rule.includes('narrow'))) {
    required.add('narrow_state_data');
  }
  if ([...rules].some((rule) => rule.includes('opening_range'))) {
    required.add('opening_range_data');
    required.add('market_open_session');
  }
  if ([...rules].some((rule) => rule.includes('qqq_or_spy') || rule.includes('market_compass') || rule.includes('index_'))) {
    required.add('index_confirmation_data');
    required.add('market_compass');
  }
  if ([...rules].some((rule) => rule.includes('support_') || rule.includes('resistance_'))) {
    required.add('support_resistance_data');
  }
  if ([...rules].some((rule) => rule.includes('low_volatility') || rule.includes('high_volatility'))) {
    required.add('volatility_regime');
  }
  if ([...rules].some((rule) => rule.includes('opening_gap'))) {
    required.add('opening_gap');
    required.add('prior_close');
    required.add('open_price');
  }
  if ([...rules].some((rule) => rule.includes('news'))) {
    required.add('news_feed');
    required.add('spread');
  }
  if (strategy.market_group === 'crypto' || String(strategy.id || '').startsWith('crypto_')) {
    required.add('crypto_context');
  }
  if ([...rules].some((rule) => rule.includes('trend'))) {
    required.add('trend_context');
  }
  return [...required];
}

function missingDataForStrategy(strategy = {}) {
  switch (strategy.id) {
    case 'opening_range_breakout':
    case 'opening_range_fakeout':
    case 'opening_range_retest_long':
      return ['opening_range_data'];
    case 'index_supported_momentum_long':
    case 'index_confirmed_long':
    case 'index_confirmed_short':
      return ['index_confirmation_data'];
    case 'crypto_momentum_scalper':
      return ['crypto_signal_context'];
    case 'narrow_breakout':
    case 'narrow_state_expansion_long':
    case 'narrow_state_fakeout_reversal':
    case 'narrow_fakeout_reversal_v1':
      return ['narrow_state_data'];
    case 'news_volatility_watch':
      return ['news_feed'];
    default:
      return [];
  }
}

function blockedReasonCodeForRuntime(strategy, runtimeStatus, missingData = []) {
  if (!strategy || runtimeStatus === 'not_connected') return 'runtime_not_connected';
  if (runtimeStatus === 'disabled') return 'runtime_disabled';
  if (runtimeStatus === 'partial') {
    if (missingData.includes('crypto_signal_context')) return RUNTIME_PARTIAL_MISSING_CRYPTO_SIGNAL_CONTEXT;
    return 'runtime_partial_missing_data';
  }
  return null;
}

function reasonForStrategy(strategy, runtimeStatus, missingData = null) {
  if (!strategy) return 'Strategin saknar runtime-metadata.';
  if (runtimeStatus === 'disabled') return 'Strategin är avstängd av användaren.';
  if (runtimeStatus === 'partial') {
    const missing = Array.isArray(missingData) ? missingData : missingDataForStrategy(strategy);
    if (missing.includes('crypto_signal_context')) return RUNTIME_PARTIAL_MISSING_CRYPTO_SIGNAL_CONTEXT_SV;
    return `Partial: missing ${missing.join(', ')}.`;
  }
  return `Ready: ${strategy.name || strategy.id} entry available for paper/replay/batch only.`;
}

function runtimeProfileForStrategy(strategyId, savedConfig = {}) {
  const strategy = catalog.getStrategyById(strategyId);
  if (!strategy) {
    return {
      strategy_id: strategyId,
      strategy_name: strategyId,
      strategy_family: 'UNKNOWN',
      market: 'all',
      direction: 'UNKNOWN',
      runtime_status_before: 'not_connected',
      runtime_status_after: 'not_connected',
      runtime_status: 'not_connected',
      runtime_label: statusLabel('not_connected'),
      narrow_state_data_present: false,
      runtime_raw_signals: [],
      required_data: [],
      missing_data: ['strategy_catalog'],
      reason_sv: 'Strategin finns inte i katalogen.',
      skip_reason_sv: 'Strategin finns inte i katalogen.',
      runtime_comment_sv: 'Strategin finns inte i katalogen.',
      comment_sv: 'Strategin finns inte i katalogen.',
      mapping_confidence: 'low',
      can_create_paper_trade: false,
      can_create_paper_trade_label: canCreateLabel(false),
      entry_rule_implemented: false,
      connected: false,
      enabled_by_user: false,
      ...SAFETY,
    };
  }

  const enabledByUser = savedConfig.enabled_by_user ?? savedConfig.active ?? strategy.active ?? true;
  const runtimeStatusBefore = enabledByUser === false
    ? 'disabled'
    : DISABLED_RUNTIME_STRATEGY_IDS.has(strategyId)
      ? 'disabled'
      : PARTIAL_RUNTIME_STRATEGY_IDS.has(strategyId)
        ? 'partial'
        : 'active';
  const narrowStateDataPresent = narrowStateDataPresentForStrategy(strategyId);
  const cryptoSignalContextPresent = cryptoSignalContextPresentForStrategy(strategyId);
  const runtimeStatusAfter = runtimeStatusBefore === 'partial' && (narrowStateDataPresent || cryptoSignalContextPresent)
    ? 'active'
    : runtimeStatusBefore;
  const canCreate = runtimeStatusAfter === 'active';
  const rawSignals = runtimeRawSignalsForStrategy(strategyId);
  const requiredData = requiredDataForStrategy(strategy);
  const missingData = runtimeStatusAfter === 'partial' ? missingDataForStrategy(strategy) : [];
  const reasonSv = reasonForStrategy(strategy, runtimeStatusAfter, missingData);
  const blockedReasonCode = blockedReasonCodeForRuntime(strategy, runtimeStatusAfter, missingData);
  const strategyFamily = strategy.engines_used?.[0] || strategy.market_label || strategy.market_group || 'UNKNOWN';
  const mappingConfidence = runtimeStatusAfter === 'active' ? 'high' : runtimeStatusAfter === 'partial' ? 'medium' : 'low';

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name || strategy.id,
    strategy_family: strategyFamily,
    market: strategy.market_group || strategy.market || 'all',
    direction: strategy.direction || 'UNKNOWN',
    runtime_status_before: runtimeStatusBefore,
    runtime_status_after: runtimeStatusAfter,
    runtime_status: runtimeStatusAfter,
    runtime_label: statusLabel(runtimeStatusAfter),
    narrow_state_data_present: narrowStateDataPresent,
    crypto_signal_context_present: cryptoSignalContextPresent,
    runtime_raw_signals: rawSignals,
    required_data: requiredData,
    missing_data: missingData,
    blocked_reason_code: blockedReasonCode,
    blockedReasonCode,
    reason_sv: reasonSv,
    skip_reason_sv: runtimeStatusAfter === 'partial' ? reasonSv : null,
    runtime_comment_sv: reasonSv,
    comment_sv: reasonSv,
    mapping_confidence: mappingConfidence,
    can_create_paper_trade: canCreate,
    can_create_paper_trade_label: canCreateLabel(canCreate),
    entry_rule_implemented: runtimeStatusAfter !== 'disabled',
    connected: true,
    enabled_by_user: enabledByUser === true,
    profile_source: 'strategy_runtime_connector_v2',
    ...SAFETY,
  };
}

function runtimeProfileSnapshot(strategyId, savedConfig = {}, statsMap = null) {
  const profile = runtimeProfileForStrategy(strategyId, savedConfig);
  // Reuse a precomputed stats map when the caller already built one
  // (e.g. getStrategyRuntimeSummary loops over the whole catalog), instead
  // of re-parsing the large trades file once per strategy.
  const stats = statsMap || tradeStatsByStrategy().stats;
  const stat = stats.get(strategyId) || {};
  return {
    ...profile,
    paper_trades_48h: stat.paper_trades_48h || 0,
    last_paper_trade_at: stat.last_paper_trade_at || null,
    runtime_raw_signals: [...new Set([...(profile.runtime_raw_signals || []), ...[...(stat.raw_signals || [])]])],
    ...SAFETY,
  };
}

function strategyIdFromSignal(signal = {}) {
  const rawStrategy = String(signal.strategy_id || signal.strategyId || signal.strategy || signal.preset || signal.runtime_strategy || signal.strategyName || signal.strategy_name || '').trim();
  if (!rawStrategy) return null;
  if (catalog.getStrategyById(rawStrategy)) return rawStrategy;
  const strategies = catalog.getCatalog().strategies || [];
  const byName = strategies.find((strategy) => String(strategy.name || '').toLowerCase() === rawStrategy.toLowerCase());
  return byName?.id || null;
}

function baseRuntimeForStrategy(strategyId, savedConfig = {}) {
  const profile = runtimeProfileForStrategy(strategyId, savedConfig);
  if (profile.runtime_status === 'not_connected') {
    const enabledByUser = savedConfig.enabled_by_user ?? savedConfig.active ?? true;
    return {
      runtime_status: enabledByUser ? 'no_entry_rule' : 'disabled',
      runtime_label: statusLabel(enabledByUser ? 'no_entry_rule' : 'disabled'),
      runtime_raw_signals: [],
      required_data: [],
      missing_data: [],
      reason_sv: enabledByUser ? 'Strategin finns inte i katalogen.' : 'Strategin är avstängd av användaren.',
      skip_reason_sv: enabledByUser ? 'Strategin finns inte i katalogen.' : 'Strategin är avstängd av användaren.',
      runtime_comment_sv: enabledByUser ? 'Strategin finns inte i katalogen.' : 'Strategin är avstängd av användaren.',
      mapping_confidence: 'low',
      can_create_paper_trade: false,
      can_create_paper_trade_label: canCreateLabel(false),
      entry_rule_implemented: false,
      connected: false,
      enabled_by_user: enabledByUser === true,
      ...SAFETY,
    };
  }
  return profile;
}

function getRuntimeStatusForStrategy(strategyId, statsMap = null) {
  const savedConfig = readControlConfig().strategies?.[strategyId] || {};
  return runtimeProfileSnapshot(strategyId, savedConfig, statsMap);
}

function canCreatePaperTradeForSignal(signal = {}) {
  try {
    const inferred = inferStrategyForSignal(signal);
    const allowed = inferred.enabled_by_user === true
      && inferred.connected === true
      && inferred.entry_rule_implemented === true
      && inferred.runtime_status === 'active'
      && inferred.can_create_paper_trade === true;
    const reason = allowed ? null : inferred.skip_reason_sv || inferred.reason_sv || `runtime_status=${inferred.runtime_status}`;
    const blockedReasonCode = allowed ? null : inferred.blocked_reason_code || null;
    return {
      ok: true,
      allowed,
      strategy: inferred,
      reason,
      reason_sv: reason,
      reasonSv: reason,
      blocked_reason_code: blockedReasonCode,
      blockedReasonCode,
      ...SAFETY,
    };
  } catch (err) {
    return {
      ok: false,
      allowed: false,
      strategy: null,
      reason: `runtime_mapping_error:${err.message || String(err)}`,
      ...SAFETY,
    };
  }
}

function getStrategyRuntimeSummary() {
  const catalogRows = catalog.getCatalog().strategies || [];
  const { trades, stats } = tradeStatsByStrategy();
  const events = readJsonl(EVENTS_FILE).filter((row) => withinWindow(row));
  const strategies = catalogRows.map((strategy) => {
    const runtime = getRuntimeStatusForStrategy(strategy.id, stats);
    const stat = stats.get(strategy.id) || {};
    return {
      ...strategy,
      ...runtime,
      runtime_comment_sv: runtime.runtime_comment_sv || runtime.reason_sv,
      skip_reasons: topReasons(events, runtime.runtime_raw_signals),
      paper_trades_48h: stat.paper_trades_48h || runtime.paper_trades_48h || 0,
      last_paper_trade_at: stat.last_paper_trade_at || runtime.last_paper_trade_at || null,
      ...SAFETY,
    };
  });
  const unknownSignals = new Set(
    trades
      .filter((trade) => trade.connected === false || !trade.strategy_id)
      .map(rawSignalOf),
  );
  const summary = {
    total_catalog_strategies: strategies.length,
    runtime_active: strategies.filter((s) => s.runtime_status === 'active').length,
    runtime_partial: strategies.filter((s) => s.runtime_status === 'partial').length,
    runtime_paused: strategies.filter((s) => s.runtime_status === 'paused').length,
    runtime_not_connected: strategies.filter((s) => s.runtime_status === 'not_connected').length,
    runtime_disabled: strategies.filter((s) => s.runtime_status === 'disabled').length,
    runtime_no_entry_rule: strategies.filter((s) => s.runtime_status === 'no_entry_rule').length,
    runtime_connected: strategies.filter((s) => s.connected === true).length,
    enabled_by_user: strategies.filter((s) => s.enabled_by_user === true).length,
    disabled_by_user: strategies.filter((s) => s.enabled_by_user === false).length,
    needs_data: strategies.filter((s) => s.runtime_status === 'needs_data').length,
    not_connected_unknown: unknownSignals.size,
    can_create_paper_trade_count: strategies.filter((s) => s.can_create_paper_trade === true).length,
    paper_trades_48h: trades.length,
  };
  summary.connected = summary.runtime_connected;
  summary.active = summary.runtime_active;
  summary.partial = summary.runtime_partial;
  summary.paused = summary.runtime_paused;
  summary.no_entry_rule = summary.runtime_no_entry_rule;
  return {
    ok: true,
    paper_only: true,
    live_trading_enabled: false,
    live_enabled: false,
    actions_allowed: false,
    can_place_orders: false,
    window_hours: WINDOW_HOURS,
    summary,
    strategies,
  };
}

module.exports = {
  SAFETY,
  getRuntimeStrategyMap,
  resolveStrategyMetadata,
  inferStrategyForSignal,
  enrichSignalWithStrategy,
  enrichPaperTradeWithStrategy,
  getRuntimeStatusForStrategy,
  getStrategyRuntimeSummary,
  canCreatePaperTradeForSignal,
  buildCryptoSignalContext,
  _internal: {
    cryptoSignalContextPresentForStrategy,
    narrowStateDataPresentForStrategy,
  },
};
