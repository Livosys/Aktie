'use strict';

/**
 * Learning Connector
 * ==================
 *
 * Tunn brygga mellan testerna (scanner, paper, replay, batch, agenter) och
 * systemets befintliga learning-/minneshjärna. Den bygger INTE en ny hjärna.
 *
 * Ansvar:
 *   1. Ta emot råa events från alla källor och normalisera till ETT format.
 *   2. Tvinga alltid på safety-flaggor (aldrig live, aldrig order).
 *   3. Logga normaliserade events till en append-only logg + uppdatera status.
 *   4. Vidarebefordra (best-effort, fail-safe) till befintliga services:
 *        - strategyPerformanceService  (paper/replay/batch-resultat)
 *        - vectorMemoryService hanteras redan av paperTradingAgent
 *        - signalLearning / ruleMemoryEngine / learningEngine läses som källa
 *   5. Bygga learning-summary + strategy learning profiles för AI Summary/Lab.
 *
 * SÄKERHETSKONTRAKT:
 *   Connectorn får ALDRIG lägga en order. Varje event tvingas till
 *   live=false, paper_only=true, actions_allowed=false, can_place_orders=false.
 *   Saknas flaggorna läggs de till automatiskt i normalizeEvent().
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const eventLogService = require('./eventLogService');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR = path.resolve(__dirname, '../../data/learning-connector');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const SUMMARY_FILE = path.join(DATA_DIR, 'summary.json');

const MAX_EVENTS_RETAINED = 5000; // ringbuffert på disk
const MAX_ERRORS_RETAINED = 50;

// ── Safety (kan aldrig stängas av) ──────────────────────────────────────────────
const SAFETY = Object.freeze({
  live: false,
  paper_only: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
});

const VALID_SOURCES = new Set(['scanner', 'paper', 'replay', 'batch', 'agent']);

// ── Kända agenter (för Agent Health) ────────────────────────────────────────────
const KNOWN_AGENTS = [
  { agent_id: 'agent_reasoning', agent_name: 'Agent Reasoning (signalanalys)' },
  { agent_id: 'system_intelligence', agent_name: 'System Intelligence Agent' },
  { agent_id: 'ai_optimization', agent_name: 'AI Optimization Agent' },
  { agent_id: 'trading_agents', agent_name: 'TradingAgents Adapter' },
];

// ── Små hjälpare ────────────────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() { return new Date().toISOString(); }

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

const PRODUCT_TYPE_BY_GROUP = Object.freeze({
  stocks: 'equity',
  nasdaq100: 'nasdaq',
  etf: 'etf',
  crypto: 'crypto',
  leveraged_etf: 'leveraged_etf',
  avanza_certificates: 'certificate',
  bull_certificates: 'certificate',
  bear_certificates: 'certificate',
  mini_futures: 'mini_future',
  commodities: 'commodity',
  forex: 'forex',
  crypto_certificates: 'crypto_certificate',
});

const RISK_CLASS_BY_GROUP = Object.freeze({
  stocks: 'normal',
  nasdaq100: 'normal',
  etf: 'normal',
  crypto: 'high',
  leveraged_etf: 'high',
  avanza_certificates: 'extreme',
  bull_certificates: 'extreme',
  bear_certificates: 'extreme',
  mini_futures: 'extreme',
  commodities: 'high',
  forex: 'high',
  crypto_certificates: 'extreme',
});

function productTypeForGroup(groupId) {
  return PRODUCT_TYPE_BY_GROUP[String(groupId || '').toLowerCase()] || 'market';
}

function riskClassForGroup(groupId) {
  return RISK_CLASS_BY_GROUP[String(groupId || '').toLowerCase()] || 'normal';
}

function buildInstrumentSignalFields(raw = {}, marketGroup = 'unknown', pnlPct = null) {
  const symbol = raw.symbol || raw.traded_symbol || raw.tradedSymbol || null;
  const tradedSymbol = firstPresent(raw.traded_symbol, raw.tradedSymbol, symbol);
  const underlyingSymbol = firstPresent(
    raw.underlying_symbol,
    raw.underlyingSymbol,
    raw.underlying?.symbol,
    raw.signal_symbol,
    raw.signalSymbol,
    symbol,
  );
  const paperPnl = num(firstPresent(raw.paper_pnl_percent, raw.paperPnlPercent, raw.pnl_pct, raw.pnlPct, pnlPct));
  const underlyingMove = num(firstPresent(
    raw.underlying_move_percent,
    raw.underlyingMovePercent,
    raw.underlying?.move_percent,
    tradedSymbol === underlyingSymbol ? paperPnl : null,
  ));
  return {
    underlying_symbol: underlyingSymbol,
    underlying_market: firstPresent(raw.underlying_market, raw.underlyingMarket, raw.underlying?.market, raw.market, raw.market_group, raw.marketGroup, raw.marketType, marketGroup),
    underlying_signal_direction: normalizeDirection(firstPresent(raw.underlying_signal_direction, raw.underlyingSignalDirection, raw.direction, raw.nextMoveBias)),
    underlying_signal_strength: clampConfidence(firstPresent(raw.underlying_signal_strength, raw.underlyingSignalStrength, raw.confidence, raw.confidenceScore, raw.score)),
    traded_symbol: tradedSymbol,
    traded_instrument_type: firstPresent(raw.traded_instrument_type, raw.tradedInstrumentType, raw.instrument_type, raw.instrumentType, productTypeForGroup(marketGroup)),
    market_group: marketGroup,
    risk_class: firstPresent(raw.risk_class, raw.riskClass, riskClassForGroup(marketGroup)),
    leverage_factor: num(firstPresent(raw.leverage_factor, raw.leverageFactor, raw.leverage)),
    spread_estimate: num(firstPresent(raw.spread_estimate, raw.spreadEstimate, raw.spread_percent, raw.spreadPct)),
    tracking_quality: firstPresent(raw.tracking_quality, raw.trackingQuality),
    paper_pnl_percent: paperPnl,
    underlying_move_percent: underlyingMove,
  };
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const out = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    return out;
  } catch { return []; }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ── Status ──────────────────────────────────────────────────────────────────────
function emptyStatus() {
  return {
    connector_active: true,
    total_events: 0,
    by_source: { scanner: 0, paper: 0, replay: 0, batch: 0, agent: 0 },
    last_event_at: null,
    last_event_at_by_source: { scanner: null, paper: null, replay: null, batch: null, agent: null },
    agents: {},
    errors: [],
    updated_at: nowIso(),
  };
}

function loadStatus() {
  const s = readJson(STATUS_FILE, null);
  if (!s) return emptyStatus();
  // bakåtkompatibel fyllning
  return {
    ...emptyStatus(),
    ...s,
    by_source: { ...emptyStatus().by_source, ...(s.by_source || {}) },
    last_event_at_by_source: { ...emptyStatus().last_event_at_by_source, ...(s.last_event_at_by_source || {}) },
    agents: s.agents || {},
    errors: Array.isArray(s.errors) ? s.errors : [],
  };
}

function saveStatus(status) {
  status.updated_at = nowIso();
  writeJson(STATUS_FILE, status);
  return status;
}

function recordError(message, context = {}) {
  try {
    const status = loadStatus();
    status.errors = [{ at: nowIso(), message: String(message), context }, ...status.errors].slice(0, MAX_ERRORS_RETAINED);
    saveStatus(status);
  } catch { /* fail silent — en logger får aldrig krascha flödet */ }
}

// ── Event-normalisering (DEL 2) ─────────────────────────────────────────────────
/**
 * Normaliserar ett rått event till connectorns gemensamma format och tvingar
 * på safety-flaggor. Detta är den enda vägen in i loggen.
 */
function normalizeEvent(source, raw = {}) {
  const result = raw.result || {};
  const scenario = raw.scenario || {};
  const marketGroup = raw.market_group || raw.marketGroup || raw.market || raw.marketType || 'unknown';
  const instrumentFields = buildInstrumentSignalFields(raw, marketGroup, result.pnl_pct);
  const normalized = {
    event_id: raw.event_id || crypto.randomUUID(),
    source: VALID_SOURCES.has(source) ? source : 'scanner',
    mode: raw.mode || defaultModeForSource(source),
    event_type: raw.event_type || null,

    strategy_id: raw.strategy_id || raw.strategyId || null,
    strategy_name: raw.strategy_name || raw.strategyName || null,
    symbol: raw.symbol || null,
    market: raw.market || raw.market_group || raw.marketGroup || raw.marketType || 'unknown',
    market_group: marketGroup,
    timeframe: raw.timeframe || '2m',
    signal_type: raw.signal_type || raw.signalSubtype || raw.signalFamily || raw.signal || null,
    direction: normalizeDirection(raw.direction || raw.nextMoveBias),
    confidence: clampConfidence(raw.confidence ?? raw.confidenceScore ?? raw.score),

    result: {
      outcome: normalizeOutcome(result.outcome ?? raw.outcome),
      pnl_pct: num(result.pnl_pct ?? raw.pnl_pct ?? raw.pnlPct),
      max_drawdown_pct: num(result.max_drawdown_pct ?? raw.max_drawdown_pct ?? raw.maxDrawdown),
      duration_minutes: num(result.duration_minutes ?? raw.duration_minutes),
    },

    scenario: {
      market_regime: scenario.market_regime || raw.market_regime || raw.marketRegime || 'unknown',
      volatility: scenario.volatility || raw.volatility || 'unknown',
      volume_state: scenario.volume_state || raw.volume_state || raw.volumeState || 'unknown',
    },

    // valfria extrafält per källa (lagras men påverkar inte safety)
    extra: raw.extra || null,

    ...instrumentFields,

    timestamp: raw.timestamp || nowIso(),
    received_at: nowIso(),
    // SAFETY tvingas ALLTID på sist så inget event kan kringgå den
    ...SAFETY,
  };
  return normalized;
}

function defaultModeForSource(source) {
  switch (source) {
    case 'paper': return 'paper';
    case 'replay': return 'replay';
    case 'batch': return 'batch';
    case 'agent': return 'lab_auto';
    default: return 'live_scan';
  }
}

function normalizeDirection(d) {
  const s = String(d || '').toLowerCase();
  if (['long', 'up', 'bull', 'buy'].includes(s)) return 'long';
  if (['short', 'down', 'bear', 'sell'].includes(s)) return 'short';
  return 'neutral';
}

function normalizeOutcome(o) {
  const s = String(o || '').toLowerCase();
  if (['win', 'won'].includes(s)) return 'win';
  if (['loss', 'lost', 'lose'].includes(s)) return 'loss';
  if (['flat', 'tie', 'timeout', 'breakeven'].includes(s)) return 'flat';
  return 'unknown';
}

// ── Kärnan: ta emot ett normaliserat event ──────────────────────────────────────
function appendEvent(source, raw) {
  try {
    const event = normalizeEvent(source, raw);
    ensureDir();
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
    trimEventsFileIfNeeded();

    const status = loadStatus();
    status.total_events += 1;
    status.by_source[event.source] = (status.by_source[event.source] || 0) + 1;
    status.last_event_at = event.received_at;
    status.last_event_at_by_source[event.source] = event.received_at;
    saveStatus(status);

    return { ok: true, event, ...SAFETY };
  } catch (err) {
    recordError(`appendEvent(${source}) failed: ${err.message}`);
    return { ok: false, error: err.message, ...SAFETY };
  }
}

function trimEventsFileIfNeeded() {
  try {
    const events = readJsonl(EVENTS_FILE);
    if (events.length <= MAX_EVENTS_RETAINED) return;
    const kept = events.slice(-MAX_EVENTS_RETAINED);
    fs.writeFileSync(EVENTS_FILE, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  } catch { /* fail silent */ }
}

// ── Vidarebefordran till befintliga services (best-effort, fail-safe) ────────────
function forwardToStrategyPerformance(payload = {}) {
  try {
    // lazy require för att undvika cirkulära beroenden
    const strategyCatalog = require('./daytradingStrategyCatalogService');
    if (!payload.strategy_id || !strategyCatalog.getStrategyById(payload.strategy_id)) return; // okänd strategi → hoppa
    const strategyPerformance = require('./strategyPerformanceService');
    const marketGroup = firstPresent(payload.market_group, payload.marketGroup, payload.market, payload.marketType, 'unknown');
    const instrumentFields = buildInstrumentSignalFields(
      payload,
      marketGroup,
      firstPresent(payload.paper_pnl_percent, payload.paperPnlPercent, payload.total_pnl, payload.avg_pnl),
    );
    strategyPerformance.saveStrategyTestResult({
      ...payload,
      ...instrumentFields,
    });
  } catch (err) {
    recordError(`forwardToStrategyPerformance failed: ${err.message}`, { strategy_id: payload.strategy_id });
  }
}

// ── DEL 3: Paper trading ─────────────────────────────────────────────────────────
function recordPaperTradeEvent(raw = {}) {
  const isClosed = String(raw.event_type || '').toLowerCase() === 'closed';
  const evt = appendEvent('paper', {
    ...raw,
    mode: 'paper',
    result: {
      outcome: raw.outcome,
      pnl_pct: raw.pnl_pct ?? raw.pnlPct,
      max_drawdown_pct: raw.max_drawdown_pct ?? raw.maxAdversePct,
      duration_minutes: raw.duration_minutes,
    },
  });

  // Endast STÄNGDA trades matar strategiprestanda (en stängd trade = 1 trade)
  if (isClosed && evt.ok && raw.strategy_id) {
    const outcome = normalizeOutcome(raw.outcome);
    const pnl = num(raw.pnl_pct ?? raw.pnlPct, 0);
    forwardToStrategyPerformance({
      strategy_id: raw.strategy_id,
      source: 'paper_trading',
      symbols: raw.symbol ? [raw.symbol] : [],
      timeframe: raw.timeframe || '2m',
      trades: 1,
      wins: outcome === 'win' ? 1 : 0,
      losses: outcome === 'loss' ? 1 : 0,
      timeouts: outcome === 'flat' ? 1 : 0,
      total_pnl: pnl,
      avg_pnl: pnl,
      max_drawdown: Math.abs(num(raw.max_drawdown_pct ?? raw.maxAdversePct, 0)),
    });
  }
  return evt;
}

// ── DEL 4: Replay ─────────────────────────────────────────────────────────────
function recordReplayResult(raw = {}) {
  // Dedup per replay-session (en session matar bara learning en gång)
  const sessionId = raw.session_id || raw.replay_session_id || raw.event_id;
  if (sessionId && alreadyRecorded('replay', sessionId)) {
    return { ok: true, deduped: true, ...SAFETY };
  }

  const outcome = num(raw.pnl_pct) == null
    ? 'unknown'
    : num(raw.pnl_pct) > 0 ? 'win' : num(raw.pnl_pct) < 0 ? 'loss' : 'flat';

  const evt = appendEvent('replay', {
    ...raw,
    event_id: sessionId || undefined,
    mode: 'replay',
    result: {
      outcome: raw.outcome || outcome,
      pnl_pct: raw.pnl_pct,
      max_drawdown_pct: raw.max_drawdown_pct,
      duration_minutes: raw.duration_minutes,
    },
    extra: {
      replay_window: raw.replay_window || null,
      win_rate: num(raw.win_rate),
      total_trades: num(raw.total_trades),
      session_id: sessionId || null,
    },
  });

  // Replay matar research/learning-score via strategiprestanda men ALDRIG live.
  if (evt.ok && raw.strategy_id && num(raw.total_trades)) {
    const trades = Math.max(1, Math.round(num(raw.total_trades) || 0));
    const winRate = num(raw.win_rate, 0);
    const wins = Math.round(trades * (winRate / 100));
    forwardToStrategyPerformance({
      strategy_id: raw.strategy_id,
      source: 'replay',
      symbols: raw.symbol ? [raw.symbol] : [],
      timeframe: raw.timeframe || '2m',
      trades,
      wins,
      losses: Math.max(0, trades - wins),
      timeouts: 0,
      total_pnl: num(raw.pnl_pct, 0),
      avg_pnl: trades ? round(num(raw.pnl_pct, 0) / trades, 4) : 0,
      max_drawdown: Math.abs(num(raw.max_drawdown_pct, 0)),
    });
  }
  return evt;
}

// ── DEL 5: Batch ─────────────────────────────────────────────────────────────
function recordBatchResult(raw = {}) {
  const batchId = raw.batch_id || raw.batchId || raw.event_id;
  if (batchId && alreadyRecorded('batch', batchId)) {
    return { ok: true, deduped: true, ...SAFETY };
  }

  const recommendation = batchRecommendation(raw);
  const winRate = num(raw.win_rate);

  const evt = appendEvent('batch', {
    ...raw,
    event_id: batchId || undefined,
    mode: 'batch',
    result: {
      outcome: winRate == null ? 'unknown' : winRate >= 50 ? 'win' : 'loss',
      pnl_pct: num(raw.avg_return),
      max_drawdown_pct: num(raw.max_drawdown),
      duration_minutes: null,
    },
    extra: {
      batch_id: batchId || null,
      parameter_set: raw.parameter_set || null,
      total_tests: num(raw.total_tests),
      win_rate: winRate,
      avg_return: num(raw.avg_return),
      profit_factor: num(raw.profit_factor),
      best_market_regime: raw.best_market_regime || null,
      worst_market_regime: raw.worst_market_regime || null,
      recommendation, // promote | keep | demote | pause_candidate — ALDRIG auto-applicerad
    },
  });
  return { ...evt, recommendation };
}

/**
 * Batch ger en REKOMMENDATION, slår aldrig på/av strategier automatiskt.
 */
function batchRecommendation(raw) {
  const winRate = num(raw.win_rate);
  const pf = num(raw.profit_factor);
  const total = num(raw.total_tests, 0);
  if (total < 10 || winRate == null) return 'keep';
  if (winRate >= 58 && (pf == null || pf >= 1.4)) return 'promote';
  if (winRate < 40 || (pf != null && pf < 0.9)) return 'pause_candidate';
  if (winRate < 47) return 'demote';
  return 'keep';
}

// ── DEL 6: Agenter ─────────────────────────────────────────────────────────────
function recordAgentFinding(raw = {}) {
  const agentId = raw.agent_id || 'unknown_agent';
  const evt = appendEvent('agent', {
    ...raw,
    mode: 'lab_auto',
    strategy_id: raw.affected_strategy || raw.strategy_id || null,
    symbol: raw.affected_symbol || raw.symbol || null,
    confidence: raw.confidence,
    signal_type: raw.finding_type || null,
    extra: {
      agent_id: agentId,
      agent_name: raw.agent_name || agentId,
      finding_type: raw.finding_type || null,
      recommendation: raw.recommendation || null,
      affected_strategy: raw.affected_strategy || null,
      affected_symbol: raw.affected_symbol || null,
      evidence: raw.evidence || null,
    },
  });

  // Agent Health-uppdatering
  try {
    const status = loadStatus();
    const prev = status.agents[agentId] || {};
    status.agents[agentId] = {
      agent_id: agentId,
      agent_name: raw.agent_name || prev.agent_name || agentId,
      exists: true,
      runs: true,
      gives_output: true,
      output_used: raw.output_used ?? prev.output_used ?? true,
      findings_count: (prev.findings_count || 0) + 1,
      last_finding_at: nowIso(),
      last_error: raw.error || prev.last_error || null,
    };
    saveStatus(status);
  } catch (err) {
    recordError(`agent health update failed: ${err.message}`, { agent_id: agentId });
  }
  return evt;
}

// ── DEL 1/scanner ─────────────────────────────────────────────────────────────
function recordSignalEvent(raw = {}) {
  return appendEvent('scanner', { ...raw, mode: raw.mode || 'live_scan' });
}

// ── Dedup-hjälp ────────────────────────────────────────────────────────────────
function alreadyRecorded(source, id) {
  if (!id) return false;
  try {
    const events = readJsonl(EVENTS_FILE);
    return events.some((e) => e.source === source && (e.event_id === id || e.extra?.session_id === id || e.extra?.batch_id === id));
  } catch { return false; }
}

// ── Aggregering per strategi ─────────────────────────────────────────────────────
function aggregateEventsByStrategy(events) {
  const byStrategy = new Map();
  for (const e of events) {
    const sid = e.strategy_id || '__unknown__';
    if (!byStrategy.has(sid)) {
      byStrategy.set(sid, {
        strategy_id: e.strategy_id || null,
        total_signals: 0,
        paper_trades: 0,
        replay_tests: 0,
        batch_tests: 0,
        agent_findings: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        pnl_sum: 0,
        pnl_count: 0,
        last_updated: null,
      });
    }
    const a = byStrategy.get(sid);
    if (e.source === 'scanner') a.total_signals += 1;
    if (e.source === 'paper') {
      a.total_signals += 1;
      if (String(e.event_type).toLowerCase() === 'closed') a.paper_trades += 1;
    }
    if (e.source === 'replay') a.replay_tests += 1;
    if (e.source === 'batch') a.batch_tests += 1;
    if (e.source === 'agent') a.agent_findings += 1;

    const oc = e.result?.outcome;
    if (oc === 'win') a.wins += 1;
    else if (oc === 'loss') a.losses += 1;
    else if (oc === 'flat') a.flats += 1;

    const pnl = num(e.result?.pnl_pct);
    if (pnl != null) { a.pnl_sum += pnl; a.pnl_count += 1; }

    if (!a.last_updated || String(e.received_at) > String(a.last_updated)) a.last_updated = e.received_at;
  }
  return byStrategy;
}

// ── DEL: bygg learning-summary ───────────────────────────────────────────────────
function buildLearningSummary() {
  try {
    const events = readJsonl(EVENTS_FILE);
    const bySource = { scanner: 0, paper: 0, replay: 0, batch: 0, agent: 0 };
    let wins = 0; let losses = 0; let flats = 0; let pnlSum = 0; let pnlCount = 0;
    const regimeCounts = {};
    for (const e of events) {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
      const oc = e.result?.outcome;
      if (oc === 'win') wins += 1; else if (oc === 'loss') losses += 1; else if (oc === 'flat') flats += 1;
      const pnl = num(e.result?.pnl_pct);
      if (pnl != null) { pnlSum += pnl; pnlCount += 1; }
      const r = e.scenario?.market_regime || 'unknown';
      regimeCounts[r] = (regimeCounts[r] || 0) + 1;
    }
    const resolved = wins + losses;

    // Läs in befintlig kärn-hjärna (rör den inte — bara referens för AI Summary)
    let coreLearning = null;
    try { coreLearning = require('../scanner/learningEngine').loadLearningSummary(); } catch { coreLearning = null; }

    const summary = {
      _meta: { builtAt: nowIso(), source: 'learning_connector', total_events: events.length },
      ...SAFETY,
      connector: {
        total_events: events.length,
        by_source: bySource,
        win_rate: resolved ? round((wins / resolved) * 100, 2) : null,
        wins,
        losses,
        flats,
        avg_pnl_pct: pnlCount ? round(pnlSum / pnlCount, 4) : null,
        by_market_regime: regimeCounts,
      },
      strategies_count: aggregateEventsByStrategy(events).size,
      core_learning_present: !!coreLearning,
      core_learning_meta: coreLearning ? (coreLearning._meta || { updatedAt: coreLearning.updatedAt || null }) : null,
    };

    writeJson(SUMMARY_FILE, summary);
    eventLogService.appendEvent({
      event_type: 'learning.summary_created',
      source: 'learning',
      timestamp: nowIso(),
      symbol: null,
      market: 'unknown',
      timeframe: null,
      raw_signal: 'LEARNING_SUMMARY',
      direction: 'NONE',
      strategy: null,
      score: summary.connector?.win_rate ?? null,
      decision: 'no_trade',
      reason: 'learning summary created',
      threshold: null,
      paper: true,
      metadata: {
        total_events: events.length,
        connector: summary.connector,
        strategies_count: summary.strategies_count,
        core_learning_present: summary.core_learning_present,
      },
    });
    return summary;
  } catch (err) {
    recordError(`buildLearningSummary failed: ${err.message}`);
    return { ok: false, error: err.message, ...SAFETY };
  }
}

function loadLatestSummary() {
  return readJson(SUMMARY_FILE, null);
}

// ── DEL 7: Strategy Learning Profile ─────────────────────────────────────────────
function buildProfileFromParts(strategy, runtime, perf, agg) {
  const totalSignals = agg?.total_signals || 0;
  const paperTrades = agg?.paper_trades || 0;
  const replayTests = agg?.replay_tests || 0;
  const batchTests = agg?.batch_tests || 0;

  // Prestanda: föredra strategyPerformance (batch/lab/paper), annars connector-aggregat
  const resolved = (agg?.wins || 0) + (agg?.losses || 0);
  const connectorWinRate = resolved ? round(((agg.wins || 0) / resolved) * 100, 2) : null;
  const winRate = perf?.win_rate != null ? perf.win_rate : connectorWinRate;
  const avgPnl = perf?.avg_pnl != null ? perf.avg_pnl : (agg?.pnl_count ? round(agg.pnl_sum / agg.pnl_count, 4) : null);
  const profitFactor = computeProfitFactor(agg);
  const confidenceScore = perf?.score != null ? perf.score : null;

  const totalEvidence = totalSignals + paperTrades + replayTests + batchTests;
  const learningScore = computeLearningScore({ winRate, avgPnl, totalEvidence, runtimeActive: runtime?.runtime_status === 'active' });
  const recommendation = computeRecommendation({ winRate, totalEvidence, runtime, learningScore });

  return {
    strategy_id: strategy?.id || agg?.strategy_id || null,
    strategy_name: strategy?.name || runtime?.strategy_name || null,
    status: runtime?.runtime_status || 'unknown',
    runtime_active: runtime?.runtime_status === 'active',
    scanner_enabled: !!runtime?.connected,
    paper_enabled: runtime?.can_create_paper_trade === true,
    replay_enabled: true, // replay/batch är alltid tillgängliga i research-läge
    batch_enabled: true,
    total_signals: totalSignals,
    paper_trades: paperTrades,
    replay_tests: replayTests,
    batch_tests: batchTests,
    agent_findings: agg?.agent_findings || 0,
    win_rate: winRate,
    avg_pnl: avgPnl,
    profit_factor: profitFactor,
    confidence_score: confidenceScore,
    learning_score: learningScore,
    recommendation,
    last_updated: agg?.last_updated || runtime?.last_paper_trade_at || null,
    ...SAFETY,
  };
}

function computeProfitFactor(agg) {
  if (!agg || !agg.pnl_count) return null;
  // approximation från outcome-räkning saknas; använd null om inte beräkningsbar
  return null;
}

function computeLearningScore({ winRate, avgPnl, totalEvidence, runtimeActive }) {
  // 0–100. Tunn heuristik — ingen ny hjärna, bara en sammanvägning.
  let score = 25;
  if (winRate != null) score += Math.max(-25, Math.min(45, (winRate - 50) * 1.2 + 20));
  if (avgPnl != null) score += Math.max(-15, Math.min(20, avgPnl * 60));
  score += Math.min(15, totalEvidence * 0.3);
  if (runtimeActive) score += 5;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function computeRecommendation({ winRate, totalEvidence, runtime, learningScore }) {
  if (totalEvidence < 5 || winRate == null) return 'not_enough_data';
  if (winRate < 40) return 'pause';
  if (totalEvidence < 20) return 'test_more';
  if (runtime?.runtime_status === 'active' && learningScore >= 55) return 'active';
  if (learningScore >= 50) return 'watch';
  return 'test_more';
}

function getStrategyLearningProfile(strategyId) {
  try {
    const strategyCatalog = require('./daytradingStrategyCatalogService');
    const runtimeConnector = require('./strategyRuntimeConnectorService');
    const strategyPerformance = require('./strategyPerformanceService');

    const strategy = strategyCatalog.getStrategyById(strategyId);
    if (!strategy) return { ok: false, error: 'unknown_strategy_id', ...SAFETY };

    let runtime = null;
    try { runtime = runtimeConnector.getRuntimeStatusForStrategy(strategyId); } catch { runtime = null; }
    let perf = null;
    try { perf = strategyPerformance.getStrategyDetails(strategyId)?.performance || null; } catch { perf = null; }

    const events = readJsonl(EVENTS_FILE);
    const agg = aggregateEventsByStrategy(events).get(strategyId) || null;

    return { ok: true, profile: buildProfileFromParts(strategy, runtime, perf, agg), ...SAFETY };
  } catch (err) {
    recordError(`getStrategyLearningProfile failed: ${err.message}`, { strategyId });
    return { ok: false, error: err.message, ...SAFETY };
  }
}

function getAllStrategyLearningProfiles() {
  try {
    const strategyCatalog = require('./daytradingStrategyCatalogService');
    const runtimeConnector = require('./strategyRuntimeConnectorService');
    const strategyPerformance = require('./strategyPerformanceService');

    const catalog = strategyCatalog.getCatalog().strategies || [];
    const events = readJsonl(EVENTS_FILE);
    const aggMap = aggregateEventsByStrategy(events);

    let perfMap = new Map();
    try {
      const perf = strategyPerformance.getStrategyPerformance();
      for (const p of (perf.strategies || [])) perfMap.set(p.strategy_id, p);
    } catch { perfMap = new Map(); }

    const profiles = catalog.map((strategy) => {
      let runtime = null;
      try { runtime = runtimeConnector.getRuntimeStatusForStrategy(strategy.id); } catch { runtime = null; }
      const perf = perfMap.get(strategy.id) || null;
      const agg = aggMap.get(strategy.id) || null;
      return buildProfileFromParts(strategy, runtime, perf, agg);
    });

    return { ok: true, count: profiles.length, strategies: profiles, ...SAFETY };
  } catch (err) {
    recordError(`getAllStrategyLearningProfiles failed: ${err.message}`);
    return { ok: false, error: err.message, strategies: [], ...SAFETY };
  }
}

// ── DEL 8: Connector status ──────────────────────────────────────────────────────
function getConnectorStatus() {
  const status = loadStatus();
  const agents = KNOWN_AGENTS.map((a) => ({
    ...a,
    ...(status.agents[a.agent_id] || { exists: true, runs: false, gives_output: false, output_used: false, findings_count: 0, last_finding_at: null, last_error: null }),
  }));
  return {
    ok: true,
    connector_active: status.connector_active !== false,
    sources_connected: {
      scanner: status.by_source.scanner > 0,
      paper: status.by_source.paper > 0,
      replay: status.by_source.replay > 0,
      batch: status.by_source.batch > 0,
      agents: status.by_source.agent > 0,
    },
    paper_connected: status.by_source.paper > 0,
    replay_connected: status.by_source.replay > 0,
    batch_connected: status.by_source.batch > 0,
    agents_connected: status.by_source.agent > 0,
    total_events: status.total_events,
    events_by_source: status.by_source,
    last_event_at: status.last_event_at,
    last_event_at_by_source: status.last_event_at_by_source,
    agents,
    errors: status.errors.slice(0, 10),
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  KNOWN_AGENTS,
  // record (write)
  recordSignalEvent,
  recordPaperTradeEvent,
  recordReplayResult,
  recordBatchResult,
  recordAgentFinding,
  // build / read
  buildLearningSummary,
  loadLatestSummary,
  getStrategyLearningProfile,
  getAllStrategyLearningProfiles,
  getConnectorStatus,
  // intern (exporteras för test)
  normalizeEvent,
};
