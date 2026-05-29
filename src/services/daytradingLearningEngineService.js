'use strict';

/**
 * Daytrading Learning Engine v1
 * ------------------------------
 * Lär sig av paper trades, skippade signaler, risk blocks, sliders och
 * marknadsgrupper. HELT paper/test — kan aldrig lägga riktiga order.
 *
 * Säkerhetskontrakt (alltid):
 *   paper_only: true
 *   live_trading_enabled: false
 *   live_enabled: false
 *   actions_allowed: false
 *   can_place_orders: false
 *
 * Alla skriv-/läsoperationer är fail-safe: ett fel här får ALDRIG störa
 * scanner, paper trading eller någon annan loop.
 */

const fs = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  paper_only: true,
  live_trading_enabled: false,
  live_enabled: false,
  actions_allowed: false,
  can_place_orders: false,
});

// ── Filvägar ──────────────────────────────────────────────────────────────
const LEARNING_DIR = path.resolve(__dirname, '../../data/daytrading-learning');
const EVENTS_FILE = path.join(LEARNING_DIR, 'events.jsonl');
const SKIPPED_FILE = path.join(LEARNING_DIR, 'skipped-signals.jsonl');
const OUTCOMES_FILE = path.join(LEARNING_DIR, 'outcomes.jsonl');
const SUMMARY_FILE = path.join(LEARNING_DIR, 'latest-summary.json');

// Canonical trades-logg (delas med paper trading agenten)
const TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const PAPER_STATE_FILE = path.resolve(__dirname, '../../data/paper-trading/state.json');

const MAX_ROWS_PER_FILE = 50000; // trimma jsonl-filerna så de inte växer obegränsat
const MIN_TRADES_STRONG = 20;    // tröskel för strong/promising vs needs_more_data

// Risk-klass per marknadsgrupp (speglar marketUniverseService.RISK_CLASS_BY_GROUP)
const RISK_CLASS_BY_GROUP = Object.freeze({
  stocks: 'normal', nasdaq100: 'normal', sp500: 'normal', mag7: 'normal',
  omxs30: 'normal', swedish_stocks: 'normal', etf: 'normal', index: 'normal',
  crypto: 'high', leveraged_etf: 'high', commodities: 'high', forex: 'high',
  avanza_certificates: 'extreme', bull_certificates: 'extreme',
  bear_certificates: 'extreme', mini_futures: 'extreme',
  crypto_certificates: 'extreme',
});

const PRODUCT_TYPE_BY_GROUP = Object.freeze({
  stocks: 'equity', nasdaq100: 'nasdaq', sp500: 'equity', mag7: 'equity',
  etf: 'etf', crypto: 'crypto', leveraged_etf: 'leveraged_etf',
  avanza_certificates: 'certificate', bull_certificates: 'certificate',
  bear_certificates: 'certificate', mini_futures: 'mini_future',
  commodities: 'commodity', forex: 'forex', crypto_certificates: 'crypto_certificate',
});

// ── Lazy services (undvik circular deps + krascha aldrig vid import) ─────────
function lazyMarketUniverse() {
  try { return require('./marketUniverseService'); } catch { return null; }
}
function lazyDaytradingControl() {
  try { return require('./daytradingControlService'); } catch { return null; }
}
function lazyRuntimeConnector() {
  try { return require('./strategyRuntimeConnectorService'); } catch { return null; }
}

// ── Fil-helpers ─────────────────────────────────────────────────────────────
function ensureDir() {
  try {
    if (!fs.existsSync(LEARNING_DIR)) fs.mkdirSync(LEARNING_DIR, { recursive: true });
  } catch (err) {
    console.warn('[learning] could not create dir:', err.message);
  }
}

function safeReadJsonl(file) {
  try {
    if (!file || !fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return [];
    const rows = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { rows.push(JSON.parse(trimmed)); } catch { /* hoppa över trasig rad */ }
    }
    return rows;
  } catch (err) {
    console.warn('[learning] safeReadJsonl failed:', err.message);
    return [];
  }
}

function appendJsonl(file, event) {
  try {
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    // Lättviktig trimning: kontrollera storlek bara ibland.
    if (Math.random() < 0.02) trimFile(file);
    return true;
  } catch (err) {
    console.warn('[learning] appendJsonl failed:', err.message);
    return false;
  }
}

function trimFile(file) {
  try {
    const rows = safeReadJsonl(file);
    if (rows.length > MAX_ROWS_PER_FILE) {
      const kept = rows.slice(-MAX_ROWS_PER_FILE);
      fs.writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
  } catch (err) {
    console.warn('[learning] trimFile failed:', err.message);
  }
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── Små util ────────────────────────────────────────────────────────────────
function makeId() {
  return `le_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso() { return new Date().toISOString(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v, d = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function pct(part, total) {
  if (!total) return 0;
  return round((part / total) * 100, 2);
}

function baseEnvelope(type, source) {
  return {
    id: makeId(),
    timestamp: nowIso(),
    type,
    source: source || 'daytrading_learning',
    ...SAFETY,
  };
}

// ── Marknads-/riskhjälp ─────────────────────────────────────────────────────
function resolveMarketGroup(symbol, fallbackGroup) {
  const mu = lazyMarketUniverse();
  if (mu && typeof mu.getGroupForSymbol === 'function') {
    try {
      const g = mu.getGroupForSymbol(symbol, fallbackGroup);
      if (g) return g;
    } catch { /* ignore */ }
  }
  if (fallbackGroup) {
    const fg = String(fallbackGroup).toLowerCase();
    if (RISK_CLASS_BY_GROUP[fg]) return fg;
  }
  // sista fallback från symbol
  if (String(symbol || '').toUpperCase().endsWith('USDT')) return 'crypto';
  return fallbackGroup || 'unknown';
}

function riskClassForGroup(groupId) {
  if (!groupId) return 'unknown';
  return RISK_CLASS_BY_GROUP[String(groupId).toLowerCase()] || 'normal';
}

function productTypeForGroup(groupId) {
  if (!groupId) return 'unknown';
  return PRODUCT_TYPE_BY_GROUP[String(groupId).toLowerCase()] || 'market';
}

/**
 * Hämtar aktuell config (sliders/kontroller). Helt fail-safe — returnerar
 * null-fält om något saknas istället för att krascha.
 */
function buildConfigSnapshot(extra = {}) {
  const snap = {
    min_score: null,
    min_confidence: null,
    max_risk_class: null,
    max_trades_per_hour: null,
    cooldown_minutes: null,
    max_spread_percent: null,
    max_leverage: null,
    enabled_for_paper: null,
    enabled_for_scanner: null,
    strategy_enabled_by_user: null,
    market_group_enabled_for_paper: null,
    market_group_enabled_for_scanner: null,
  };
  try {
    const dc = lazyDaytradingControl();
    if (dc && typeof dc.getMarketControls === 'function') {
      const filters = dc.getMarketControls()?.filters || {};
      snap.min_score = num(filters.min_score);
      snap.min_confidence = num(filters.min_confidence);
      snap.max_risk_class = filters.max_risk_class ?? null;
      snap.max_trades_per_hour = num(filters.max_trades_per_hour);
      snap.cooldown_minutes = num(filters.cooldown_minutes);
      snap.max_spread_percent = num(filters.max_spread_percent);
      snap.max_leverage = num(filters.max_leverage);
    }
  } catch { /* ignore */ }
  try {
    const mu = lazyMarketUniverse();
    if (extra.market_group && mu && typeof mu.groupEnabledFor === 'function') {
      snap.market_group_enabled_for_paper = mu.groupEnabledFor(extra.market_group, 'paper');
      snap.market_group_enabled_for_scanner = mu.groupEnabledFor(extra.market_group, 'scanner');
    }
  } catch { /* ignore */ }
  // Tillåt anroparen att överlagra med kända värden
  if (extra.enabled_for_paper != null) snap.enabled_for_paper = extra.enabled_for_paper;
  if (extra.enabled_for_scanner != null) snap.enabled_for_scanner = extra.enabled_for_scanner;
  if (extra.strategy_enabled_by_user != null) snap.strategy_enabled_by_user = extra.strategy_enabled_by_user;
  snap.market_group_enabled_for_paper = snap.market_group_enabled_for_paper ?? (extra.market_group_enabled_for_paper ?? null);
  snap.market_group_enabled_for_scanner = snap.market_group_enabled_for_scanner ?? (extra.market_group_enabled_for_scanner ?? null);
  return snap;
}

function configKey(snap) {
  if (!snap) return 'unknown';
  const parts = [
    `score${snap.min_score ?? '-'}`,
    `conf${snap.min_confidence ?? '-'}`,
    `risk${snap.max_risk_class ?? '-'}`,
    `cool${snap.cooldown_minutes ?? '-'}`,
    `spread${snap.max_spread_percent ?? '-'}`,
    `lev${snap.max_leverage ?? '-'}`,
  ];
  return parts.join('|');
}

// ── Normalisering ───────────────────────────────────────────────────────────
function normalizeOutcome(result) {
  const r = String(result || '').toUpperCase();
  if (r === 'WIN') return 'win';
  if (r === 'LOSS' || r === 'LOSE') return 'loss';
  if (r === 'TIMEOUT') return 'timeout';
  if (r === 'OPEN') return 'open';
  if (r === 'BREAKEVEN' || r === 'BE') return 'breakeven';
  return 'unknown';
}

function classifySkipCategory(input) {
  // input kan ha skip_category, skip_reason, type (paper-event-typ) eller blocked_by
  const explicit = String(input.skip_category || '').toLowerCase();
  const KNOWN = new Set([
    'low_confidence', 'cooldown', 'market_closed', 'disabled_by_user',
    'no_entry_rule', 'paused', 'missing_data', 'risk_block', 'spread_too_high',
    'max_trades_limit', 'wait', 'do_not_chase', 'unknown',
  ]);
  if (KNOWN.has(explicit)) return explicit;

  const type = String(input.type || input.event_type || '').toUpperCase();
  const reason = String(input.skip_reason || input.reason || input.reasonSv || '').toLowerCase();
  const blockedBy = String(input.blocked_by || '').toLowerCase();

  if (type === 'RISK_BLOCKED' || type === 'RISK_PAUSE_TRIGGERED' || blockedBy === 'risk_engine' || /risk/.test(reason)) return 'risk_block';
  if (type === 'SAFETY_BLOCKED' || blockedBy === 'execution_safety') return 'risk_block';
  if (type === 'MAX_TRADES_REACHED' || /max.*trade|max antal/.test(reason)) return 'max_trades_limit';
  if (type === 'MARKET_CONTROL_PAPER_DISABLED' || /avstängd|disabled/.test(reason)) return 'disabled_by_user';
  if (type === 'GATE_OBSERVE_ONLY' || /observerar|observe/.test(reason)) return 'wait';
  if (type === 'COOLDOWN_ACTIVE' || /cooldown|paus efter/.test(reason)) return 'cooldown';
  if (type === 'DUPLICATE_SIGNAL') return 'wait';
  if (/marknaden är stängd|market closed/.test(reason)) return 'market_closed';
  if (/data var inte färsk|missing.*data|datafreshness/.test(reason)) return 'missing_data';
  if (/pausad|paused/.test(reason)) return 'paused';
  if (/saknar entry|no.*entry|entry-regel/.test(reason)) return 'no_entry_rule';
  if (/spread/.test(reason)) return 'spread_too_high';
  if (/för långt gången|jaga inte|do not chase|chase/.test(reason)) return 'do_not_chase';
  if (/svag|för svag|low.*conf|konfidens/.test(reason)) return 'low_confidence';
  if (/vänta|wait/.test(reason)) return 'wait';
  return 'unknown';
}

function blockedByFromCategory(category, input) {
  if (input.blocked_by) return input.blocked_by;
  switch (category) {
    case 'risk_block': return 'risk_engine';
    case 'max_trades_limit': return 'paper_agent';
    case 'disabled_by_user': return 'market_control';
    case 'no_entry_rule':
    case 'paused':
    case 'disabled_by_user': return 'strategy_runtime';
    case 'market_closed':
    case 'missing_data': return 'data_layer';
    default: return 'paper_agent';
  }
}

// ── Record-funktioner (fail-safe write path) ────────────────────────────────

/** STEG 3 — signal_detected */
function recordSignalEvent(event = {}) {
  try {
    const symbol = event.symbol || null;
    const market_group = event.market_group || resolveMarketGroup(symbol, event.market || event.marketGroup);
    const row = {
      ...baseEnvelope('signal_detected', event.source || 'scanner'),
      symbol,
      market: event.market || event.marketType || null,
      market_group,
      risk_class: event.risk_class || riskClassForGroup(market_group),
      strategy_id: event.strategy_id || event.strategyId || null,
      strategy_name: event.strategy_name || event.strategyName || null,
      raw_strategy: event.raw_strategy || event.signalFamily || null,
      signal_subtype: event.signal_subtype || event.signalSubtype || null,
      direction: event.direction || event.nextMoveBias || null,
      confidence: num(event.confidence ?? event.confidenceScore),
      score: num(event.score ?? event.tradeScore ?? event.gateScore),
      price: num(event.price),
      volume: event.volume ?? event.volumeState ?? null,
      runtime_status: event.runtime_status || null,
      enabled_by_user: event.enabled_by_user ?? null,
      entry_rule_implemented: event.entry_rule_implemented ?? null,
      enabled_for_paper: event.enabled_for_paper ?? null,
      enabled_for_scanner: event.enabled_for_scanner ?? null,
      config_snapshot: event.config_snapshot || buildConfigSnapshot({ market_group }),
      scanner_context: event.scanner_context || null,
    };
    return appendJsonl(EVENTS_FILE, row);
  } catch (err) {
    console.warn('[learning] recordSignalEvent failed:', err.message);
    return false;
  }
}

/** STEG 4 — signal_skipped */
function recordSkippedSignal(event = {}) {
  try {
    const symbol = event.symbol || null;
    const market_group = event.market_group || resolveMarketGroup(symbol, event.market || event.marketGroup);
    const skip_category = classifySkipCategory(event);
    const row = {
      ...baseEnvelope('signal_skipped', event.source || 'paper_agent'),
      symbol,
      market: event.market || event.marketType || null,
      market_group,
      risk_class: event.risk_class || riskClassForGroup(market_group),
      strategy_id: event.strategy_id || event.strategyId || null,
      strategy_name: event.strategy_name || event.strategyName || null,
      raw_strategy: event.raw_strategy || event.signalFamily || null,
      signal_subtype: event.signal_subtype || event.signalSubtype || null,
      direction: event.direction || event.nextMoveBias || null,
      confidence: num(event.confidence ?? event.confidenceScore),
      score: num(event.score ?? event.tradeScore ?? event.gateScore),
      skip_reason: event.skip_reason || event.reasonSv || event.reason || null,
      skip_category,
      blocked_by: blockedByFromCategory(skip_category, event),
      runtime_status: event.runtime_status || null,
      enabled_by_user: event.enabled_by_user ?? null,
      entry_rule_implemented: event.entry_rule_implemented ?? null,
      enabled_for_paper: event.enabled_for_paper ?? null,
      enabled_for_scanner: event.enabled_for_scanner ?? null,
      config_snapshot: event.config_snapshot || buildConfigSnapshot({ market_group }),
      scanner_context: event.scanner_context || null,
    };
    return appendJsonl(SKIPPED_FILE, row);
  } catch (err) {
    console.warn('[learning] recordSkippedSignal failed:', err.message);
    return false;
  }
}

/** STEG 5 — paper_trade_opened */
function recordPaperTradeOpened(trade = {}) {
  try {
    const symbol = trade.symbol || null;
    const market_group = trade.market_group || resolveMarketGroup(symbol, trade.marketGroup || trade.marketType);
    const row = {
      ...baseEnvelope('paper_trade_opened', 'paper_agent'),
      trade_id: trade.tradeId || trade.trade_id || null,
      symbol,
      market: trade.marketType || trade.market || null,
      market_group,
      risk_class: trade.risk_class || riskClassForGroup(market_group),
      strategy_id: trade.strategy_id || trade.strategyId || null,
      strategy_name: trade.strategy_name || trade.strategyName || null,
      strategy_family: trade.strategy_family || trade.strategyFamily || null,
      raw_strategy: trade.raw_strategy || trade.signalFamily || null,
      signal_subtype: trade.signal_subtype || trade.signalSubtype || null,
      direction: trade.direction || trade.nextMoveBias || null,
      entry_price: num(trade.entryPrice ?? trade.entry_price),
      confidence: num(trade.confidenceScore ?? trade.confidence),
      score: num(trade.score ?? trade.gateScore),
      runtime_status: trade.runtime_status || null,
      mapping_confidence: num(trade.mapping_confidence ?? trade.mappingConfidence),
      enabled_by_user: trade.enabled_by_user ?? null,
      entry_rule_implemented: trade.entry_rule_implemented ?? null,
      enabled_for_paper: trade.enabled_for_paper ?? null,
      enabled_for_scanner: trade.enabled_for_scanner ?? null,
      config_snapshot: trade.config_snapshot || buildConfigSnapshot({ market_group }),
      scanner_context: trade.scanner_context || null,
    };
    return appendJsonl(OUTCOMES_FILE, row);
  } catch (err) {
    console.warn('[learning] recordPaperTradeOpened failed:', err.message);
    return false;
  }
}

/** STEG 6 — paper_trade_closed */
function recordPaperTradeClosed(trade = {}, exit = null) {
  try {
    const symbol = trade.symbol || null;
    const market_group = trade.market_group || resolveMarketGroup(symbol, trade.marketGroup || trade.marketType);
    const result = exit?.result || trade.result || null;
    const pnlPct = num(exit?.pnlPct ?? trade.pnlPct ?? trade.pnl_percent);
    const row = {
      ...baseEnvelope('paper_trade_closed', 'paper_agent'),
      trade_id: trade.tradeId || trade.trade_id || null,
      symbol,
      market: trade.marketType || trade.market || null,
      market_group,
      risk_class: trade.risk_class || riskClassForGroup(market_group),
      strategy_id: trade.strategy_id || trade.strategyId || null,
      strategy_name: trade.strategy_name || trade.strategyName || null,
      strategy_family: trade.strategy_family || trade.strategyFamily || null,
      raw_strategy: trade.raw_strategy || trade.signalFamily || null,
      signal_subtype: trade.signal_subtype || trade.signalSubtype || null,
      direction: trade.direction || trade.nextMoveBias || null,
      entry_price: num(trade.entryPrice ?? trade.entry_price),
      exit_price: num(exit?.exitPrice ?? trade.exitPrice ?? trade.exit_price),
      pnl: num(trade.pnl ?? (pnlPct != null && trade.riskPositionSizeSek != null ? (pnlPct / 100) * trade.riskPositionSizeSek : null)),
      pnl_percent: pnlPct,
      status: result,
      outcome: normalizeOutcome(result),
      exit_reason: exit?.exitReasonCode || exit?.exitReason || trade.exitReasonCode || trade.exitReason || null,
      duration_seconds: num(trade.duration_seconds),
      confidence: num(trade.confidenceScore ?? trade.confidence),
      score: num(trade.score ?? trade.gateScore),
      runtime_status: trade.runtime_status || null,
      config_snapshot: trade.config_snapshot || buildConfigSnapshot({ market_group }),
    };
    return appendJsonl(OUTCOMES_FILE, row);
  } catch (err) {
    console.warn('[learning] recordPaperTradeClosed failed:', err.message);
    return false;
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function emptyAgg(key, label) {
  return {
    key, label,
    trades: 0, closed: 0, open: 0,
    wins: 0, losses: 0, timeout: 0, breakeven: 0,
    win_rate: 0, avg_pl: 0, total_pl: 0, best_pl: null, worst_pl: null,
    skipped: 0, _skipReasons: {},
    confidence: 0, _confSum: 0, _confN: 0,
    status: 'unknown',
  };
}

function bumpTrade(agg, trade) {
  agg.trades += 1;
  const outcome = normalizeOutcome(trade.result ?? trade.outcome);
  if (outcome === 'open') { agg.open += 1; return; }
  agg.closed += 1;
  if (outcome === 'win') agg.wins += 1;
  else if (outcome === 'loss') agg.losses += 1;
  else if (outcome === 'timeout') agg.timeout += 1;
  else if (outcome === 'breakeven') agg.breakeven += 1;
  const pnl = num(trade.pnlPct ?? trade.pnl_percent);
  if (pnl != null) {
    agg.total_pl = round(agg.total_pl + pnl, 4);
    if (agg.best_pl == null || pnl > agg.best_pl) agg.best_pl = round(pnl, 4);
    if (agg.worst_pl == null || pnl < agg.worst_pl) agg.worst_pl = round(pnl, 4);
  }
  const conf = num(trade.confidenceScore ?? trade.confidence);
  if (conf != null) { agg._confSum += conf; agg._confN += 1; }
}

function bumpSkip(agg, skip) {
  agg.skipped += 1;
  const cat = skip.skip_category || classifySkipCategory(skip);
  agg._skipReasons[cat] = (agg._skipReasons[cat] || 0) + 1;
}

function finalizeAgg(agg) {
  agg.win_rate = pct(agg.wins, agg.closed);
  agg.avg_pl = agg.closed ? round(agg.total_pl / agg.closed, 4) : 0;
  agg.confidence = agg._confN ? round(agg._confSum / agg._confN, 1) : 0;
  const reasons = Object.entries(agg._skipReasons).sort((a, b) => b[1] - a[1]);
  agg.top_skip_reason = reasons.length ? reasons[0][0] : null;
  agg.status = classifyStatus(agg);
  delete agg._skipReasons;
  delete agg._confSum;
  delete agg._confN;
  return agg;
}

function classifyStatus(agg) {
  const skipRate = (agg.skipped + agg.trades) > 0 ? agg.skipped / (agg.skipped + agg.trades) : 0;
  if (agg.closed < MIN_TRADES_STRONG) {
    if (agg.closed === 0 && agg.skipped > 0) return 'needs_more_data';
    return 'needs_more_data';
  }
  // Tillräckligt med data
  if (agg.avg_pl < 0 && agg.closed >= MIN_TRADES_STRONG) {
    if (agg.avg_pl <= -0.15 || agg.win_rate < 35) return 'avoid';
    return 'weak';
  }
  if (skipRate > 0.85) return 'needs_review';
  if (agg.win_rate >= 55 && agg.avg_pl > 0) return 'strong';
  if (agg.win_rate >= 45 && agg.avg_pl >= 0) return 'promising';
  return 'weak';
}

function aggregateBy(trades, skipped, keyFn, labelFn) {
  const map = new Map();
  const ensure = (key, label) => {
    if (!map.has(key)) map.set(key, emptyAgg(key, label));
    return map.get(key);
  };
  for (const t of trades) {
    const key = keyFn(t);
    if (key == null || key === '') continue;
    bumpTrade(ensure(String(key), labelFn ? labelFn(t, key) : String(key)), t);
  }
  for (const s of skipped) {
    const key = keyFn(s);
    if (key == null || key === '') continue;
    bumpSkip(ensure(String(key), labelFn ? labelFn(s, key) : String(key)), s);
  }
  return Array.from(map.values())
    .map(finalizeAgg)
    .sort((a, b) => (b.closed - a.closed) || (b.avg_pl - a.avg_pl));
}

const strategyKey = (r) => r.strategy_id || r.strategyId || r.strategy_name || r.strategyName || 'unmapped';
const strategyLabel = (r, key) => r.strategy_name || r.strategyName || key;
const rawSignalKey = (r) => r.signal_subtype || r.signalSubtype || r.raw_strategy || r.signalFamily || r.signalSubtype || 'unknown';
const marketGroupKey = (r) => r.market_group || resolveMarketGroup(r.symbol, r.marketGroup || r.marketType) || 'unknown';
const riskClassKey = (r) => r.risk_class || riskClassForGroup(marketGroupKey(r)) || 'unknown';
const symbolKey = (r) => r.symbol || 'unknown';

function aggregateByStrategy(trades, skipped) { return aggregateBy(trades, skipped, strategyKey, strategyLabel); }
function aggregateByRawSignal(trades, skipped) { return aggregateBy(trades, skipped, rawSignalKey); }
function aggregateByMarketGroup(trades, skipped) {
  return aggregateBy(trades, skipped, marketGroupKey, (r, key) => {
    const pt = productTypeForGroup(key);
    return `${key}${pt && pt !== 'market' ? ` (${pt})` : ''}`;
  });
}
function aggregateByRiskClass(trades, skipped) { return aggregateBy(trades, skipped, riskClassKey); }
function aggregateBySymbol(trades, skipped) { return aggregateBy(trades, skipped, symbolKey); }
function aggregateByConfig(trades, skipped) {
  return aggregateBy(
    trades, skipped,
    (r) => (r.config_snapshot ? configKey(r.config_snapshot) : null),
    (r, key) => key,
  );
}

function aggregateSkipReasons(skipped) {
  const map = {};
  for (const s of skipped) {
    const cat = s.skip_category || classifySkipCategory(s);
    map[cat] = (map[cat] || 0) + 1;
  }
  return Object.entries(map)
    .map(([key, count]) => ({ key, count, share: pct(count, skipped.length) }))
    .sort((a, b) => b.count - a.count);
}

// ── Summary ─────────────────────────────────────────────────────────────────

function withinWindow(row, sinceMs) {
  if (!sinceMs) return true;
  const ts = row.timestamp || row.exitTime || row.closed_at || row.entryTime || row.opened_at;
  if (!ts) return true; // behåll rader utan tidsstämpel
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return true;
  return t >= sinceMs;
}

/**
 * Bygger learning summary från canonical trades.jsonl (closed trades),
 * skipped-signals.jsonl och outcomes.jsonl. Helt fail-safe.
 */
function buildLearningSummary(options = {}) {
  const hours = num(options.hours) || 48;
  const limit = num(options.limit) || 200;
  const sinceMs = Date.now() - hours * 3600 * 1000;

  let closedTrades = [];
  let skipped = [];
  let outcomeRows = [];
  let openTradesCount = 0;

  try {
    closedTrades = safeReadJsonl(TRADES_FILE).filter((r) => withinWindow(r, sinceMs));
  } catch { closedTrades = []; }
  try {
    skipped = safeReadJsonl(SKIPPED_FILE).filter((r) => withinWindow(r, sinceMs));
  } catch { skipped = []; }
  try {
    outcomeRows = safeReadJsonl(OUTCOMES_FILE).filter((r) => withinWindow(r, sinceMs));
  } catch { outcomeRows = []; }
  try {
    const state = safeReadJson(PAPER_STATE_FILE, {});
    openTradesCount = Array.isArray(state.openTrades) ? state.openTrades.length : 0;
  } catch { openTradesCount = 0; }

  // Enrich varje trade med market_group/risk_class om saknas (canonical trades
  // saknar dessa kanoniska fält).
  const trades = closedTrades.map((t) => {
    const mg = t.market_group || resolveMarketGroup(t.symbol, t.marketGroup || t.marketType);
    return { ...t, market_group: mg, risk_class: t.risk_class || riskClassForGroup(mg) };
  });

  const closedCount = trades.filter((t) => normalizeOutcome(t.result ?? t.outcome) !== 'open').length;
  const wins = trades.filter((t) => normalizeOutcome(t.result ?? t.outcome) === 'win').length;
  const losses = trades.filter((t) => normalizeOutcome(t.result ?? t.outcome) === 'loss').length;
  const timeout = trades.filter((t) => normalizeOutcome(t.result ?? t.outcome) === 'timeout').length;
  const pnls = trades.map((t) => num(t.pnlPct ?? t.pnl_percent)).filter((v) => v != null);
  const totalPl = round(pnls.reduce((a, b) => a + b, 0), 4);
  const avgPl = pnls.length ? round(totalPl / pnls.length, 4) : 0;
  const bestPl = pnls.length ? round(Math.max(...pnls), 4) : 0;
  const worstPl = pnls.length ? round(Math.min(...pnls), 4) : 0;
  const riskBlocks = skipped.filter((s) => (s.skip_category || classifySkipCategory(s)) === 'risk_block').length;

  const byStrategy = aggregateByStrategy(trades, skipped);
  const byRawSignal = aggregateByRawSignal(trades, skipped);
  const byMarketGroup = aggregateByMarketGroup(trades, skipped);
  const byRiskClass = aggregateByRiskClass(trades, skipped);
  const bySymbol = aggregateBySymbol(trades, skipped);
  // Config-learning: canonical trades saknar config_snapshot, så vi använder
  // våra egna stängda outcome-rader (som sparar config_snapshot) + skipped.
  const closedOutcomes = outcomeRows.filter((r) => r.type === 'paper_trade_closed' && r.config_snapshot);
  const byConfig = aggregateByConfig(closedOutcomes.length ? closedOutcomes : trades, skipped);
  const skipReasons = aggregateSkipReasons(skipped);

  // Bästa/sämsta strategi: bara mappade strategier med stängda trades.
  const ranked = byStrategy.filter((s) => s.closed > 0 && s.key !== 'unmapped' && s.key !== 'unknown');
  const bestStrategy = pickBest(ranked);
  const worstStrategy = pickWorst(ranked);
  const bestMarketGroup = pickBest(byMarketGroup.filter((g) => g.closed > 0));
  const bestRiskClass = pickBest(byRiskClass.filter((g) => g.closed > 0));
  const needsMoreData = byStrategy.filter((s) => s.status === 'needs_more_data').length;

  const summary = {
    trades_total: trades.length,
    closed_trades: closedCount,
    open_trades: openTradesCount,
    wins,
    losses,
    timeout,
    win_rate: pct(wins, closedCount),
    avg_pl: avgPl,
    total_pl: totalPl,
    best_pl: bestPl,
    worst_pl: worstPl,
    skipped_total: skipped.length,
    risk_blocks_total: riskBlocks,
    best_strategy: bestStrategy ? { key: bestStrategy.key, label: bestStrategy.label, win_rate: bestStrategy.win_rate, avg_pl: bestStrategy.avg_pl, closed: bestStrategy.closed } : null,
    worst_strategy: worstStrategy ? { key: worstStrategy.key, label: worstStrategy.label, win_rate: worstStrategy.win_rate, avg_pl: worstStrategy.avg_pl, closed: worstStrategy.closed } : null,
    best_market_group: bestMarketGroup ? { key: bestMarketGroup.key, label: bestMarketGroup.label, win_rate: bestMarketGroup.win_rate, avg_pl: bestMarketGroup.avg_pl, closed: bestMarketGroup.closed } : null,
    best_risk_class: bestRiskClass ? { key: bestRiskClass.key, label: bestRiskClass.label, win_rate: bestRiskClass.win_rate, avg_pl: bestRiskClass.avg_pl, closed: bestRiskClass.closed } : null,
    needs_more_data_count: needsMoreData,
  };

  const result = {
    ok: true,
    ...SAFETY,
    generated_at: nowIso(),
    window: { hours },
    summary,
    by_strategy: byStrategy.slice(0, limit),
    by_raw_signal: byRawSignal.slice(0, limit),
    by_market_group: byMarketGroup.slice(0, limit),
    by_risk_class: byRiskClass.slice(0, limit),
    by_symbol: bySymbol.slice(0, limit),
    by_config: byConfig.slice(0, limit),
    skip_reasons: skipReasons,
  };

  // Persistera senaste summary (best-effort)
  try {
    ensureDir();
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch (err) {
    console.warn('[learning] could not persist summary:', err.message);
  }

  return result;
}

function pickBest(rows) {
  if (!rows.length) return null;
  // Prioritera tillräcklig data, sortera på avg_pl sedan win_rate.
  const sorted = [...rows].sort((a, b) => {
    const ea = a.closed >= MIN_TRADES_STRONG ? 1 : 0;
    const eb = b.closed >= MIN_TRADES_STRONG ? 1 : 0;
    if (ea !== eb) return eb - ea;
    if (b.avg_pl !== a.avg_pl) return b.avg_pl - a.avg_pl;
    return b.win_rate - a.win_rate;
  });
  return sorted[0];
}

function pickWorst(rows) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => {
    if (a.avg_pl !== b.avg_pl) return a.avg_pl - b.avg_pl;
    return a.win_rate - b.win_rate;
  });
  return sorted[0];
}

/**
 * getLearningSummary — säker wrapper som aldrig kastar. Returnerar en tom
 * fallback-struktur om något går fel.
 */
function getLearningSummary(options = {}) {
  try {
    return buildLearningSummary(options);
  } catch (err) {
    console.warn('[learning] getLearningSummary failed:', err.message);
    return {
      ok: false,
      error: err.message,
      ...SAFETY,
      generated_at: nowIso(),
      window: { hours: num(options.hours) || 48 },
      summary: {
        trades_total: 0, closed_trades: 0, open_trades: 0,
        wins: 0, losses: 0, timeout: 0, win_rate: 0,
        avg_pl: 0, total_pl: 0, best_pl: 0, worst_pl: 0,
        skipped_total: 0, risk_blocks_total: 0,
        best_strategy: null, worst_strategy: null,
        best_market_group: null, best_risk_class: null,
        needs_more_data_count: 0,
      },
      by_strategy: [], by_raw_signal: [], by_market_group: [],
      by_risk_class: [], by_symbol: [], by_config: [], skip_reasons: [],
    };
  }
}

module.exports = {
  SAFETY,
  recordSignalEvent,
  recordSkippedSignal,
  recordPaperTradeOpened,
  recordPaperTradeClosed,
  buildLearningSummary,
  getLearningSummary,
  aggregateByStrategy,
  aggregateByMarketGroup,
  aggregateByRiskClass,
  aggregateByRawSignal,
  aggregateBySymbol,
  aggregateByConfig,
  aggregateSkipReasons,
  safeReadJsonl,
  appendJsonl,
  // exporterade hjälpfunktioner (test/återanvändning)
  resolveMarketGroup,
  riskClassForGroup,
  buildConfigSnapshot,
  classifySkipCategory,
  normalizeOutcome,
};
