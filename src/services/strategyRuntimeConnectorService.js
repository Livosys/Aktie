'use strict';

const fs = require('fs');
const path = require('path');

const catalog = require('./daytradingStrategyCatalogService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  paper_only: true,
});

const TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const EVENTS_FILE = path.resolve(__dirname, '../../data/paper-trading/events.jsonl');
const STATE_FILE = path.resolve(__dirname, '../../data/paper-trading/state.json');
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

function strategyMeta(strategyId) {
  const strategy = catalog.getStrategyById(strategyId);
  return {
    strategy_id: strategyId,
    strategy_name: strategy?.name || strategyId,
  };
}

function statusLabel(status) {
  if (status === 'active') return 'Aktiv';
  if (status === 'partial') return 'Delvis';
  if (status === 'paused') return 'Pausad';
  if (status === 'needs_data') return 'Behöver mer data';
  return 'Ej kopplad';
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
    market,
    comment_sv,
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
  const entry = findMapEntry(signal);
  const raw = rawSignalOf(signal);
  if (entry) {
    return {
      ...entry,
      raw_strategy: raw,
      signal_subtype: raw,
      runtime_comment_sv: entry.comment_sv,
      source: 'strategy_runtime_connector_v1',
      ...SAFETY,
    };
  }
  return {
    raw_strategy: raw,
    signal_subtype: raw,
    strategy_id: null,
    strategy_name: null,
    strategy_family: upper(signal.signalFamily) || 'UNKNOWN',
    runtime_status: 'not_connected',
    runtime_label: statusLabel('not_connected'),
    mapping_confidence: 'low',
    can_create_paper_trade: false,
    can_create_paper_trade_label: 'nej',
    runtime_comment_sv: 'Ingen säker runtime-mapping finns. Strategin markeras som ej kopplad.',
    source: 'strategy_runtime_connector_v1',
    ...SAFETY,
  };
}

function enrichSignalWithStrategy(signal = {}) {
  const inferred = inferStrategyForSignal(signal);
  return {
    ...signal,
    strategy_id: signal.strategy_id || signal.strategyId || inferred.strategy_id,
    strategyId: signal.strategyId || signal.strategy_id || inferred.strategy_id,
    strategy_name: signal.strategy_name || signal.strategyName || inferred.strategy_name,
    strategyName: signal.strategyName || signal.strategy_name || inferred.strategy_name,
    strategy_family: signal.strategy_family || inferred.strategy_family,
    raw_strategy: signal.raw_strategy || inferred.raw_strategy,
    signal_subtype: signal.signal_subtype || inferred.signal_subtype,
    mapping_confidence: signal.mapping_confidence || inferred.mapping_confidence,
    runtime_status: signal.runtime_status || inferred.runtime_status,
    runtime_label: signal.runtime_label || inferred.runtime_label,
    runtime_comment_sv: signal.runtime_comment_sv || inferred.runtime_comment_sv,
    can_create_paper_trade: signal.can_create_paper_trade ?? inferred.can_create_paper_trade,
  };
}

function enrichPaperTradeWithStrategy(trade = {}) {
  const inferred = inferStrategyForSignal(trade);
  const strategyId = trade.strategy_id || trade.strategyId || inferred.strategy_id;
  const strategyName = trade.strategy_name || trade.strategyName || inferred.strategy_name;
  const raw = trade.raw_strategy || trade.signal_subtype || trade.signalSubtype || trade.strategy || inferred.raw_strategy;
  return {
    ...trade,
    strategy: trade.strategy || raw || strategyName || 'Paper-strategi',
    raw_strategy: raw || null,
    signal_subtype: trade.signal_subtype || trade.signalSubtype || raw || null,
    strategy_id: strategyId || null,
    strategyId: strategyId || null,
    strategy_name: strategyName || null,
    strategyName: strategyName || null,
    strategy_family: trade.strategy_family || inferred.strategy_family,
    mapping_confidence: trade.mapping_confidence || inferred.mapping_confidence,
    runtime_status: trade.runtime_status || inferred.runtime_status,
    runtime_label: trade.runtime_label || inferred.runtime_label,
    runtime_comment_sv: trade.runtime_comment_sv || inferred.runtime_comment_sv,
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

function baseRuntimeForStrategy(strategyId) {
  const entries = getRuntimeStrategyMap().filter((entry) => entry.strategy_id === strategyId);
  if (!entries.length) {
    return {
      runtime_status: 'not_connected',
      runtime_label: statusLabel('not_connected'),
      runtime_raw_signals: [],
      mapping_confidence: 'low',
      can_create_paper_trade: false,
      comment_sv: 'Finns i katalog/teststatistik men har ingen säker paper-runtime-koppling ännu.',
    };
  }
  const hasActive = entries.some((entry) => entry.runtime_status === 'active');
  const hasPaused = entries.some((entry) => entry.runtime_status === 'paused');
  const hasPartial = entries.some((entry) => entry.runtime_status === 'partial');
  const status = hasActive ? 'active' : hasPaused ? 'paused' : hasPartial ? 'partial' : entries[0].runtime_status;
  return {
    runtime_status: status,
    runtime_label: statusLabel(status),
    runtime_raw_signals: [...new Set(entries.map((entry) => entry.raw_signal))],
    mapping_confidence: entries.some((entry) => entry.mapping_confidence === 'high') ? 'high' : entries[0].mapping_confidence,
    can_create_paper_trade: entries.some((entry) => entry.can_create_paper_trade === true) ? true : entries.some((entry) => entry.can_create_paper_trade === 'partial') ? 'partial' : false,
    comment_sv: [...new Set(entries.map((entry) => entry.comment_sv).filter(Boolean))].join(' '),
  };
}

function getRuntimeStatusForStrategy(strategyId) {
  const { stats } = tradeStatsByStrategy();
  const base = baseRuntimeForStrategy(strategyId);
  const stat = stats.get(strategyId) || {};
  return {
    strategy_id: strategyId,
    ...base,
    paper_trades_48h: stat.paper_trades_48h || 0,
    last_paper_trade_at: stat.last_paper_trade_at || null,
    runtime_raw_signals: [...new Set([...(base.runtime_raw_signals || []), ...[...(stat.raw_signals || [])]])],
    ...SAFETY,
  };
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
      runtime_comment_sv: runtime.comment_sv,
      skip_reasons: topReasons(events, runtime.runtime_raw_signals),
      paper_trades_48h: stat.paper_trades_48h || runtime.paper_trades_48h || 0,
      last_paper_trade_at: stat.last_paper_trade_at || runtime.last_paper_trade_at || null,
      ...SAFETY,
    };
  });
  const summary = {
    total_catalog_strategies: strategies.length,
    runtime_active: strategies.filter((s) => s.runtime_status === 'active').length,
    runtime_partial: strategies.filter((s) => s.runtime_status === 'partial').length,
    runtime_paused: strategies.filter((s) => s.runtime_status === 'paused').length,
    runtime_not_connected: strategies.filter((s) => s.runtime_status === 'not_connected').length,
    paper_trades_48h: trades.length,
  };
  return {
    ok: true,
    paper_only: true,
    live_trading_enabled: false,
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
  inferStrategyForSignal,
  enrichSignalWithStrategy,
  enrichPaperTradeWithStrategy,
  getRuntimeStatusForStrategy,
  getStrategyRuntimeSummary,
};
