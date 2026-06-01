'use strict';

const fs = require('fs');
const path = require('path');

const catalog = require('./daytradingStrategyCatalogService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
  paper_only: true,
});

const TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const EVENTS_FILE = path.resolve(__dirname, '../../data/paper-trading/events.jsonl');
const STATE_FILE = path.resolve(__dirname, '../../data/paper-trading/state.json');
const CONTROL_CONFIG_FILE = path.resolve(__dirname, '../../data/config/daytrading-control.json');
const WINDOW_HOURS = 48;

function allowEmaPaperTrades() {
  return String(process.env.PAPER_ALLOW_EMA || 'false').toLowerCase() === 'true';
}

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

  const runtimeStrategyId = strategyIdFromSignal(signal) || strategyIdFromKeywords(signal);
  if (runtimeStrategyId) {
    metadata.resolvedStrategyId = runtimeStrategyId;
    metadata.resolvedStrategyName = catalog.getStrategyById(runtimeStrategyId)?.name || runtimeStrategyId;
    metadata.strategyId = metadata.resolvedStrategyId;
    metadata.strategyName = metadata.resolvedStrategyName;
    metadata.mappingSource = 'runtime_inference';
    return metadata;
  }

  if (allowLegacyFallback && isRealTradeCandidateSignal(signal)) {
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
    strategy_id: signal.strategy_id || signal.strategyId || null,
    strategy_name: signal.strategy_name || signal.strategyName || null,
    nextMoveBias: signal.nextMoveBias || signal.direction || null,
  };
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

function runtimeEntry({
  raw_signal,
  strategy_id,
  strategy_family,
  runtime_status,
  direction = 'UNKNOWN',
  mapping_confidence = 'medium',
  can_create_paper_trade = false,
  market = 'all',
  comment_sv,
}) {
  const meta = strategyMeta(strategy_id);
  return {
    raw_signal,
    signal_subtype: raw_signal,
    ...meta,
    strategy_family,
    runtime_status,
    runtime_label: statusLabel(runtime_status),
    direction,
    mapping_confidence,
    can_create_paper_trade,
    can_create_paper_trade_label: canCreateLabel(can_create_paper_trade),
    entry_rule_implemented: can_create_paper_trade === true || can_create_paper_trade === 'partial',
    connected: true,
    market,
    comment_sv,
    ...SAFETY,
  };
}

function getRuntimeStrategyMap() {
  const emaAllowed = allowEmaPaperTrades();
  return [
    runtimeEntry({
      raw_signal: 'VWAP_RECLAIM_UP',
      strategy_id: 'vwap_volume_breakout_long',
      strategy_family: 'VWAP',
      runtime_status: 'active',
      direction: 'UP',
      mapping_confidence: 'high',
      can_create_paper_trade: true,
      market: 'stocks',
      comment_sv: 'Aktie/ETF-VWAP long är kopplad till paper-runtime.',
    }),
    runtimeEntry({
      raw_signal: 'VWAP_REJECTION_DOWN',
      strategy_id: 'vwap_failed_breakout_short',
      strategy_family: 'VWAP',
      runtime_status: 'active',
      direction: 'DOWN',
      mapping_confidence: 'high',
      can_create_paper_trade: true,
      market: 'stocks',
      comment_sv: 'Aktie/ETF-VWAP short är kopplad till paper-runtime.',
    }),
    runtimeEntry({
      raw_signal: 'VWAP_RECLAIM_UP',
      strategy_id: 'crypto_momentum_scalper',
      strategy_family: 'Crypto VWAP',
      runtime_status: 'partial',
      direction: 'UP',
      mapping_confidence: 'medium',
      can_create_paper_trade: 'partial',
      market: 'crypto',
      comment_sv: 'Krypto-VWAP sparas med rå VWAP-signal men katalogkopplas till Crypto Momentum Scalper.',
    }),
    runtimeEntry({
      raw_signal: 'VWAP_REJECTION_DOWN',
      strategy_id: 'crypto_momentum_scalper',
      strategy_family: 'Crypto VWAP',
      runtime_status: 'partial',
      direction: 'DOWN',
      mapping_confidence: 'medium',
      can_create_paper_trade: 'partial',
      market: 'crypto',
      comment_sv: 'Krypto-VWAP sparas med rå VWAP-signal men katalogkopplas till Crypto Momentum Scalper.',
    }),
    runtimeEntry({
      raw_signal: 'NARROW_WAIT',
      strategy_id: 'narrow_breakout',
      strategy_family: 'Narrow',
      runtime_status: 'partial',
      direction: 'UNKNOWN',
      mapping_confidence: 'medium',
      can_create_paper_trade: false,
      comment_sv: 'NARROW_WAIT är vänteläge och ska inte skapa paper trade.',
    }),
    runtimeEntry({
      raw_signal: 'NARROW_BULL_ENTRY',
      strategy_id: 'narrow_state_expansion_long',
      strategy_family: 'Narrow',
      runtime_status: 'partial',
      direction: 'UP',
      mapping_confidence: 'medium',
      can_create_paper_trade: 'partial',
      comment_sv: 'Narrow kan skapa paper trade endast när befintlig signal tydligt är bull/bear entry.',
    }),
    runtimeEntry({
      raw_signal: 'NARROW_BEAR_ENTRY',
      strategy_id: 'narrow_breakout',
      strategy_family: 'Narrow',
      runtime_status: 'partial',
      direction: 'DOWN',
      mapping_confidence: 'medium',
      can_create_paper_trade: 'partial',
      comment_sv: 'Narrow kan skapa paper trade endast när befintlig signal tydligt är bull/bear entry.',
    }),
    runtimeEntry({
      raw_signal: 'EMA_PULLBACK_UP',
      strategy_id: 'ema_pullback_continuation',
      strategy_family: 'EMA Pullback',
      runtime_status: emaAllowed ? 'active' : 'paused',
      direction: 'UP',
      mapping_confidence: 'high',
      can_create_paper_trade: emaAllowed,
      comment_sv: emaAllowed
        ? 'EMA är tillåten i paper-runtime eftersom PAPER_ALLOW_EMA=true.'
        : 'EMA är pausad i paper test. Sätt PAPER_ALLOW_EMA=true om den ska tillåtas.',
    }),
    runtimeEntry({
      raw_signal: 'EMA_PULLBACK_DOWN',
      strategy_id: 'ema_pullback_continuation',
      strategy_family: 'EMA Pullback',
      runtime_status: emaAllowed ? 'active' : 'paused',
      direction: 'DOWN',
      mapping_confidence: 'high',
      can_create_paper_trade: emaAllowed,
      comment_sv: emaAllowed
        ? 'EMA är tillåten i paper-runtime eftersom PAPER_ALLOW_EMA=true.'
        : 'EMA är pausad i paper test. Sätt PAPER_ALLOW_EMA=true om den ska tillåtas.',
    }),
    runtimeEntry({
      raw_signal: 'REGULAR_PULLBACK',
      strategy_id: 'trend_continuation',
      strategy_family: 'Pullback',
      runtime_status: 'partial',
      direction: 'UNKNOWN',
      mapping_confidence: 'low',
      can_create_paper_trade: false,
      comment_sv: 'REGULAR_PULLBACK ses i scanner men stoppas ofta av Jaga inte/Vänta och är inte paper-entry.',
    }),
  ];
}

function findMapEntry(signal = {}) {
  const raw = rawSignalOf(signal);
  const market = marketOf(signal);
  const direction = directionOf(signal);
  const map = getRuntimeStrategyMap();

  if ((raw === 'VWAP_RECLAIM_UP' || raw === 'VWAP_REJECTION_DOWN') && market === 'crypto') {
    return map.find((entry) => entry.raw_signal === raw && entry.market === 'crypto');
  }
  if (raw === 'VWAP_RECLAIM_UP' || raw === 'VWAP_REJECTION_DOWN') {
    return map.find((entry) => entry.raw_signal === raw && entry.market === 'stocks');
  }
  if (raw === 'NARROW_WAIT') return map.find((entry) => entry.raw_signal === 'NARROW_WAIT');
  if (String(raw).includes('NARROW') || upper(signal.signalFamily).includes('NARROW')) {
    if (direction === 'DOWN' || raw.includes('BEAR')) return map.find((entry) => entry.raw_signal === 'NARROW_BEAR_ENTRY');
    if (direction === 'UP' || raw.includes('BULL')) return map.find((entry) => entry.raw_signal === 'NARROW_BULL_ENTRY');
    return map.find((entry) => entry.raw_signal === 'NARROW_WAIT');
  }
  if (raw === 'EMA_PULLBACK_UP' || raw === 'EMA_PULLBACK_DOWN') {
    return map.find((entry) => entry.raw_signal === raw);
  }
  if (raw === 'REGULAR_PULLBACK') return map.find((entry) => entry.raw_signal === 'REGULAR_PULLBACK');
  return null;
}

function inferStrategyForSignal(signal = {}) {
  let raw = 'UNKNOWN';
  let strategyId = null;
  try {
    raw = rawSignalOf(signal);
    const metadata = resolveStrategyMetadata(signal, { allowLegacyFallback: true });
    strategyId = metadata.resolvedStrategyId;
    if (!strategyId) {
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
        runtime_comment_sv: 'Ingen säker runtime-mapping finns. Strategin markeras som ej kopplad.',
        comment_sv: 'Ingen säker runtime-mapping finns. Strategin markeras som ej kopplad.',
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
  const trades = readJsonl(TRADES_FILE)
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
  'news_volatility_watch',
]);

const DISABLED_RUNTIME_STRATEGY_IDS = new Set(['crypto_fast_momentum']);

function strategyRulesOf(strategy = {}) {
  return new Set((strategy.signal_rules || []).map((rule) => String(rule || '').toLowerCase()));
}

function runtimeRawSignalsForStrategy(strategyId) {
  switch (strategyId) {
    case 'vwap_momentum_long':
    case 'vwap_volume_breakout_long':
      return ['VWAP_RECLAIM_UP'];
    case 'vwap_rejection_short':
    case 'vwap_failed_breakout_short':
      return ['VWAP_REJECTION_DOWN'];
    case 'opening_range_breakout':
      return ['OPENING_RANGE_BREAKOUT_UP', 'OPENING_RANGE_BREAKOUT_DOWN'];
    case 'opening_range_fakeout':
      return ['OPENING_RANGE_FAKEOUT_UP', 'OPENING_RANGE_FAKEOUT_DOWN'];
    case 'opening_range_retest_long':
      return ['OPENING_RANGE_RETEST_LONG'];
    case 'ema_pullback_continuation':
      return ['EMA_PULLBACK_UP', 'EMA_PULLBACK_DOWN'];
    case 'ema_breakdown':
      return ['EMA_BREAKDOWN_DOWN'];
    case 'narrow_breakout':
      return ['NARROW_BULL_ENTRY', 'NARROW_BEAR_ENTRY'];
    case 'narrow_state_expansion_long':
      return ['NARROW_BULL_ENTRY'];
    case 'narrow_state_fakeout_reversal':
      return ['NARROW_FAKEOUT'];
    case 'volume_spike_momentum':
      return ['VOLUME_SPIKE_MOMENTUM'];
    case 'volume_spike_continuation':
      return ['VOLUME_SPIKE_CONTINUATION'];
    case 'pullback_to_vwap_long':
      return ['VWAP_PULLBACK_LONG'];
    case 'trend_exhaustion_short':
      return ['TREND_EXHAUSTION_SHORT'];
    case 'index_supported_momentum_long':
      return ['INDEX_SUPPORTED_MOMENTUM_LONG'];
    case 'mean_reversion_vwap':
      return ['VWAP_MEAN_REVERSION'];
    case 'trend_continuation':
      return ['TREND_CONTINUATION_UP', 'TREND_CONTINUATION_DOWN'];
    case 'support_bounce':
      return ['SUPPORT_BOUNCE_LONG'];
    case 'resistance_rejection':
      return ['RESISTANCE_REJECTION_SHORT'];
    case 'index_confirmed_long':
      return ['INDEX_CONFIRMED_LONG'];
    case 'index_confirmed_short':
      return ['INDEX_CONFIRMED_SHORT'];
    case 'crypto_momentum_scalper':
      return ['CRYPTO_MOMENTUM_SCALPER'];
    case 'low_volatility_breakout':
      return ['LOW_VOLATILITY_BREAKOUT'];
    case 'high_volatility_reversal':
      return ['HIGH_VOLATILITY_REVERSAL'];
    case 'gap_continuation':
      return ['GAP_CONTINUATION_UP', 'GAP_CONTINUATION_DOWN'];
    case 'gap_fade':
      return ['GAP_FADE_UP', 'GAP_FADE_DOWN'];
    case 'news_volatility_watch':
      return ['NEWS_VOLATILITY_WATCH'];
    default:
      return [];
  }
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
      return ['narrow_state_data'];
    case 'news_volatility_watch':
      return ['news_feed'];
    default:
      return [];
  }
}

function reasonForStrategy(strategy, runtimeStatus) {
  if (!strategy) return 'Strategin saknar runtime-metadata.';
  if (runtimeStatus === 'disabled') return 'Strategin är avstängd av användaren.';
  if (runtimeStatus === 'partial') {
    const missing = missingDataForStrategy(strategy);
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
      runtime_status: 'not_connected',
      runtime_label: statusLabel('not_connected'),
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
  const runtimeStatus = enabledByUser === false
    ? 'disabled'
    : DISABLED_RUNTIME_STRATEGY_IDS.has(strategyId)
      ? 'disabled'
      : PARTIAL_RUNTIME_STRATEGY_IDS.has(strategyId)
        ? 'partial'
        : 'active';
  const canCreate = runtimeStatus === 'active';
  const rawSignals = runtimeRawSignalsForStrategy(strategyId);
  const requiredData = requiredDataForStrategy(strategy);
  const missingData = runtimeStatus === 'partial' ? missingDataForStrategy(strategy) : [];
  const reasonSv = reasonForStrategy(strategy, runtimeStatus);
  const strategyFamily = strategy.engines_used?.[0] || strategy.market_label || strategy.market_group || 'UNKNOWN';
  const mappingConfidence = runtimeStatus === 'active' ? 'high' : runtimeStatus === 'partial' ? 'medium' : 'low';

  return {
    strategy_id: strategy.id,
    strategy_name: strategy.name || strategy.id,
    strategy_family: strategyFamily,
    market: strategy.market_group || strategy.market || 'all',
    direction: strategy.direction || 'UNKNOWN',
    runtime_status: runtimeStatus,
    runtime_label: statusLabel(runtimeStatus),
    runtime_raw_signals: rawSignals,
    required_data: requiredData,
    missing_data: missingData,
    reason_sv: reasonSv,
    skip_reason_sv: runtimeStatus === 'partial' ? reasonSv : null,
    runtime_comment_sv: reasonSv,
    comment_sv: reasonSv,
    mapping_confidence: mappingConfidence,
    can_create_paper_trade: canCreate,
    can_create_paper_trade_label: canCreateLabel(canCreate),
    entry_rule_implemented: runtimeStatus !== 'disabled',
    connected: true,
    enabled_by_user: enabledByUser === true,
    profile_source: 'strategy_runtime_connector_v2',
    ...SAFETY,
  };
}

function runtimeProfileSnapshot(strategyId, savedConfig = {}) {
  const profile = runtimeProfileForStrategy(strategyId, savedConfig);
  const { stats } = tradeStatsByStrategy();
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

function strategyIdFromKeywords(signal = {}) {
  const rawSignal = upper(rawSignalOf(signal));
  const signalSubtype = upper(signal.signalSubtype || signal.signal_subtype || '');
  const signalFamily = upper(signal.signalFamily || '');
  const eventType = upper(signal.eventType || '');
  const direction = directionOf(signal);
  const market = marketOf(signal);
  const symbol = String(signal.symbol || '').toUpperCase();
  const raw = (market === 'crypto' || symbol.endsWith('USDT'))
    ? [rawSignal, signalSubtype, eventType].filter(Boolean).join(' ')
    : [rawSignal, signalFamily, signalSubtype, eventType].filter(Boolean).join(' ');

  if (raw.includes('VWAP')) {
    if (market === 'crypto' || symbol.endsWith('USDT')) {
      if (rawSignal === 'VWAP_REJECTION_DOWN' || signalSubtype === 'VWAP_REJECTION_DOWN') {
        return 'vwap_failed_breakout_short';
      }
      if (rawSignal === 'VWAP_RECLAIM_UP' || signalSubtype === 'VWAP_RECLAIM_UP') {
        return 'vwap_volume_breakout_long';
      }
      if (raw.includes('RECLAIM') || raw.includes('BREAKOUT') || raw.includes('MOMENTUM')) {
        return 'vwap_volume_breakout_long';
      }
      if (raw.includes('REJECTION') || raw.includes('FAIL')) {
        return 'vwap_failed_breakout_short';
      }
    }
    if (raw.includes('MEAN_REVERSION') || raw.includes('REVERSION')) return 'mean_reversion_vwap';
    if (raw.includes('PULLBACK')) return 'pullback_to_vwap_long';
    if (raw.includes('REJECTION') || raw.includes('FAIL')) return 'vwap_rejection_short';
    if (raw.includes('MOMENTUM') || raw.includes('BREAKOUT') || raw.includes('RECLAIM')) {
      return direction === 'DOWN' ? 'vwap_rejection_short' : 'vwap_momentum_long';
    }
  }

  if (market === 'crypto' || symbol.endsWith('USDT')) {
    if (raw.includes('FAST_MOMENTUM')) return 'crypto_fast_momentum';
    return 'crypto_momentum_scalper';
  }

  if (raw.includes('VOLUME_SPIKE')) {
    return raw.includes('CONTINUATION') ? 'volume_spike_continuation' : 'volume_spike_momentum';
  }
  if (raw.includes('EMA')) {
    return raw.includes('BREAKDOWN') || direction === 'DOWN'
      ? 'ema_breakdown'
      : 'ema_pullback_continuation';
  }
  if (raw.includes('OPENING_RANGE')) {
    if (raw.includes('RETEST')) return 'opening_range_retest_long';
    if (raw.includes('FAKEOUT') || raw.includes('FAIL')) return 'opening_range_fakeout';
    return 'opening_range_breakout';
  }
  if (raw.includes('INDEX')) {
    if (raw.includes('SUPPORTED') || raw.includes('LONG') || direction === 'UP') return 'index_supported_momentum_long';
    if (raw.includes('SHORT') || direction === 'DOWN') return 'index_confirmed_short';
    return direction === 'UP' ? 'index_confirmed_long' : 'index_confirmed_short';
  }
  if (raw.includes('NEWS')) return 'news_volatility_watch';
  if (raw.includes('GAP')) return raw.includes('FADE') || direction === 'DOWN' ? 'gap_fade' : 'gap_continuation';
  if (raw.includes('SUPPORT')) return 'support_bounce';
  if (raw.includes('RESISTANCE')) return 'resistance_rejection';
  if (raw.includes('VOLATILITY')) return raw.includes('HIGH') || raw.includes('REVERSAL') ? 'high_volatility_reversal' : 'low_volatility_breakout';
  if (raw.includes('TREND')) return raw.includes('EXHAUST') || raw.includes('WEAK') ? 'trend_exhaustion_short' : 'trend_continuation';
  if (raw.includes('BREAKOUT')) return 'low_volatility_breakout';
  return null;
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

function getRuntimeStatusForStrategy(strategyId) {
  const savedConfig = readControlConfig().strategies?.[strategyId] || {};
  return runtimeProfileSnapshot(strategyId, savedConfig);
}

function canCreatePaperTradeForSignal(signal = {}) {
  try {
    const inferred = inferStrategyForSignal(signal);
    const allowed = inferred.enabled_by_user === true
      && inferred.connected === true
      && inferred.entry_rule_implemented === true
      && inferred.runtime_status === 'active'
      && inferred.can_create_paper_trade === true;
    return {
      ok: true,
      allowed,
      strategy: inferred,
      reason: allowed ? null : inferred.skip_reason_sv || inferred.reason_sv || `runtime_status=${inferred.runtime_status}`,
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
    const runtime = getRuntimeStatusForStrategy(strategy.id);
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
};
