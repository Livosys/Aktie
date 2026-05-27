'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
});

const DATA_DIR = path.resolve(__dirname, '../../data/audit-trail');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const PAPER_TRADES_FILE = path.resolve(__dirname, '../../data/paper-trading/trades.jsonl');
const PAPER_STATE_FILE = path.resolve(__dirname, '../../data/paper-trading/state.json');
const MAX_EVENTS = 5000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const TRADE_TYPES = new Set(['PAPER_TRADE_OPENED', 'PAPER_TRADE_CLOSED']);
const CANDIDATE_TYPES = new Set(['SIGNAL_DETECTED', 'CANDIDATE_FOUND', 'CANDIDATE_EVALUATED']);
const BATCH_TYPES = new Set(['BATCH_CREATED', 'BATCH_STARTED', 'BATCH_PROGRESS', 'BATCH_COMPLETED', 'BATCH_PAUSED', 'BATCH_STOPPED']);
const BLOCKER_TYPES = new Set(['SAFETY_BLOCKED', 'RISK_BLOCKED']);

const TYPE_LABELS = Object.freeze({
  SYSTEM_SCAN: 'Systemscan',
  SIGNAL_DETECTED: 'Signal upptäckt',
  CANDIDATE_FOUND: 'Kandidat hittad',
  CANDIDATE_EVALUATED: 'Kandidat utvärderad',
  PAPER_TRADE_OPENED: 'Papertrade öppnad',
  PAPER_TRADE_CLOSED: 'Papertrade stängd',
  STRATEGY_TEST_CREATED: 'Strategitest skapat',
  STRATEGY_TEST_COMPLETED: 'Strategitest klart',
  BATCH_CREATED: 'Batch-test skapat',
  BATCH_STARTED: 'Batch-test startat',
  BATCH_PROGRESS: 'Batch-test uppdaterat',
  BATCH_COMPLETED: 'Batch-test klart',
  BATCH_PAUSED: 'Batch-test pausat',
  BATCH_STOPPED: 'Batch-test stoppat',
  PRIORITY_UPDATED: 'Prioritet uppdaterad',
  OPTIMIZATION_UPDATED: 'Optimering uppdaterad',
  SAFETY_BLOCKED: 'Safety stoppade signal',
  RISK_BLOCKED: 'Risk stoppade signal',
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) fs.closeSync(fs.openSync(EVENTS_FILE, 'a'));
}

function safeJson(value) {
  if (value == null) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return {};
  }
}

function readEvents() {
  try {
    ensureDir();
    return fs.readFileSync(EVENTS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readPaperOpenTrades() {
  try {
    if (!fs.existsSync(PAPER_STATE_FILE)) return [];
    const state = JSON.parse(fs.readFileSync(PAPER_STATE_FILE, 'utf8'));
    return Array.isArray(state.openTrades) ? state.openTrades : [];
  } catch (_) {
    return [];
  }
}

function writeEvents(events) {
  ensureDir();
  fs.writeFileSync(EVENTS_FILE, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), 'utf8');
}

function cleanEvents(events) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return (events || [])
    .filter((event) => {
      const ts = new Date(event.timestamp).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .slice(-MAX_EVENTS);
}

function defaultMessage(type, event = {}) {
  const label = TYPE_LABELS[type] || String(type || 'Aktivitet').replace(/_/g, ' ');
  return event.symbol ? `${label} för ${event.symbol}` : label;
}

function normalizeEvent(input = {}) {
  const type = String(input.type || 'SYSTEM_SCAN').toUpperCase();
  return {
    event_id: input.event_id || input.eventId || `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    timestamp: input.timestamp || nowIso(),
    type,
    source: input.source || 'system',
    symbol: input.symbol || null,
    strategy_id: input.strategy_id || input.strategyId || null,
    message: input.message || defaultMessage(type, input),
    details: safeJson(input.details || {}),
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
  };
}

function logAuditEvent(event) {
  try {
    const row = normalizeEvent(event);
    const rows = cleanEvents([...readEvents(), row]);
    writeEvents(rows);
    return { ok: true, event: row, ...SAFETY };
  } catch (err) {
    return { ok: false, error: err.message, ...SAFETY };
  }
}

function filteredEvents(filters = {}) {
  const limit = Math.max(1, Math.min(500, Number(filters.limit || filters.n || 100) || 100));
  const type = filters.type ? String(filters.type).toUpperCase() : null;
  const symbol = filters.symbol ? String(filters.symbol).toUpperCase() : null;
  const source = filters.source ? String(filters.source).toLowerCase() : null;
  const batchId = filters.batch_id || filters.batchId || null;
  const category = filters.category || null;
  let rows = readEvents();

  if (type) rows = rows.filter((event) => event.type === type);
  if (symbol) rows = rows.filter((event) => String(event.symbol || '').toUpperCase() === symbol);
  if (source) rows = rows.filter((event) => String(event.source || '').toLowerCase() === source);
  if (batchId) rows = rows.filter((event) => event.details?.batch_id === batchId || event.details?.batchId === batchId);
  if (category === 'trades') rows = rows.filter((event) => TRADE_TYPES.has(event.type));
  if (category === 'candidates') rows = rows.filter((event) => CANDIDATE_TYPES.has(event.type));
  if (category === 'batches') rows = rows.filter((event) => BATCH_TYPES.has(event.type));
  if (category === 'blockers') rows = rows.filter((event) => BLOCKER_TYPES.has(event.type));

  return rows
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
}

function response(events) {
  return { ok: true, count: events.length, events, ...SAFETY };
}

function tradeDurationSeconds(trade = {}) {
  const start = trade.opened_at || trade.entryTime;
  const end = trade.closed_at || trade.exitTime || trade.last_update_at || trade.entryTime;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}

function tradeDurationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function paperTradeFallbackEvents(limit = 100) {
  const closed = readJsonl(PAPER_TRADES_FILE);
  const open = readPaperOpenTrades();
  const events = [];
  for (const trade of open) {
    const ts = trade.opened_at || trade.entryTime;
    if (!ts) continue;
    events.push(normalizeEvent({
      event_id: `paper_open_${trade.tradeId || ts}`,
      timestamp: ts,
      type: 'PAPER_TRADE_OPENED',
      source: 'paper_trading',
      symbol: trade.symbol,
      strategy_id: trade.signalSubtype || trade.signalFamily || null,
      message: trade.symbol ? `Papertrade öppnad för ${trade.symbol}` : 'Papertrade öppnad',
      details: { trade_id: trade.tradeId || null, status: trade.result || 'OPEN', duration_seconds: tradeDurationSeconds(trade), duration_label: tradeDurationLabel(tradeDurationSeconds(trade)) },
    }));
  }
  for (const trade of closed) {
    const openedAt = trade.opened_at || trade.entryTime;
    const closedAt = trade.closed_at || trade.exitTime;
    if (openedAt) {
      events.push(normalizeEvent({
        event_id: `paper_open_${trade.tradeId || openedAt}`,
        timestamp: openedAt,
        type: 'PAPER_TRADE_OPENED',
        source: 'paper_trading',
        symbol: trade.symbol,
        strategy_id: trade.signalSubtype || trade.signalFamily || null,
        message: trade.symbol ? `Papertrade öppnad för ${trade.symbol}` : 'Papertrade öppnad',
        details: { trade_id: trade.tradeId || null, status: 'OPEN' },
      }));
    }
    if (closedAt) {
      const seconds = tradeDurationSeconds(trade);
      const pnl = Number(trade.pnlPct);
      const suffix = Number.isFinite(pnl) ? ` ${pnl >= 0 ? '+' : ''}${Math.round(pnl * 100) / 100}%` : '';
      events.push(normalizeEvent({
        event_id: `paper_closed_${trade.tradeId || closedAt}`,
        timestamp: closedAt,
        type: 'PAPER_TRADE_CLOSED',
        source: 'paper_trading',
        symbol: trade.symbol,
        strategy_id: trade.signalSubtype || trade.signalFamily || null,
        message: trade.symbol ? `Papertrade stängd för ${trade.symbol}${suffix}` : `Papertrade stängd${suffix}`,
        details: { trade_id: trade.tradeId || null, result: trade.result || null, pnl_pct: Number.isFinite(pnl) ? pnl : null, duration_seconds: seconds, duration_label: tradeDurationLabel(seconds) },
      }));
    }
  }
  return events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, limit);
}

function mergeEvents(primary = [], fallback = [], limit = 100) {
  const byId = new Map();
  for (const event of [...primary, ...fallback]) {
    if (!event) continue;
    const key = event.event_id || `${event.type}|${event.timestamp}|${event.symbol || ''}|${event.message || ''}`;
    if (!byId.has(key)) byId.set(key, event);
  }
  return [...byId.values()]
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
}

function getRecentAuditEvents(filters = {}) {
  return response(filteredEvents(filters));
}

function getTradeAuditEvents(filters = {}) {
  const limit = Math.max(1, Math.min(500, Number(filters.limit || filters.n || 100) || 100));
  const events = filteredEvents({ ...filters, category: 'trades' });
  return response(mergeEvents(events, paperTradeFallbackEvents(limit), limit));
}

function getCandidateAuditEvents(filters = {}) {
  return response(filteredEvents({ ...filters, category: 'candidates' }));
}

function getBatchAuditEvents(filters = {}) {
  return response(filteredEvents({ ...filters, category: 'batches' }));
}

function getAuditStatus() {
  const events = readEvents();
  const latest = events[events.length - 1] || null;
  return {
    ok: true,
    storage: EVENTS_FILE,
    event_count: events.length,
    latest_event_at: latest?.timestamp || null,
    max_events: MAX_EVENTS,
    max_age_days: 14,
    status: 'paper_replay_audit_only',
    ...SAFETY,
  };
}

function minutesAgo(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

function buildActivitySummary() {
  const events = filteredEvents({ limit: 500 });
  const now = Date.now();
  const min15 = now - 15 * 60 * 1000;
  const today = nowIso().slice(0, 10);
  const findLatest = (types) => events.find((event) => types.includes(event.type)) || null;
  const lastScan = findLatest(['SYSTEM_SCAN']);
  const tradeEvents = mergeEvents(events.filter((event) => TRADE_TYPES.has(event.type)), paperTradeFallbackEvents(100), 500);
  const lastTrade = tradeEvents.find((event) => ['PAPER_TRADE_OPENED', 'PAPER_TRADE_CLOSED'].includes(event.type)) || null;
  const recentCandidates = events.filter((event) => CANDIDATE_TYPES.has(event.type) && new Date(event.timestamp).getTime() >= min15).length;
  const recentTrades = tradeEvents.filter((event) => TRADE_TYPES.has(event.type) && new Date(event.timestamp).getTime() >= min15).length;
  const batchesToday = events.filter((event) => BATCH_TYPES.has(event.type) && String(event.timestamp).startsWith(today)).length;
  const latestByType = {
    signal: findLatest(['SIGNAL_DETECTED']),
    candidate: findLatest(['CANDIDATE_FOUND', 'CANDIDATE_EVALUATED']),
    paper_trade_opened: tradeEvents.find((event) => event.type === 'PAPER_TRADE_OPENED') || null,
    paper_trade_closed: tradeEvents.find((event) => event.type === 'PAPER_TRADE_CLOSED') || null,
    batch: findLatest(['BATCH_COMPLETED', 'BATCH_STARTED', 'BATCH_CREATED', 'BATCH_PAUSED', 'BATCH_STOPPED']),
    blocker: findLatest(['SAFETY_BLOCKED', 'RISK_BLOCKED']),
  };

  return {
    ok: true,
    status_label: 'Systemet jobbar',
    last_scan_at: lastScan?.timestamp || null,
    last_scan_seconds_ago: lastScan ? Math.max(0, Math.floor((now - new Date(lastScan.timestamp).getTime()) / 1000)) : null,
    candidates_last_15m: recentCandidates,
    trades_last_15m: recentTrades,
    batches_today: batchesToday,
    latest_trade_at: lastTrade?.timestamp || null,
    latest_trade_minutes_ago: lastTrade ? minutesAgo(new Date(lastTrade.timestamp).getTime()) : null,
    no_activity_message: recentTrades === 0 ? 'Inga nya trades ännu. Systemet väntar på bättre signaler.' : '',
    latest: latestByType,
    recent: events.slice(0, 30),
    ...SAFETY,
  };
}

function cleanupOldAuditEvents() {
  const before = readEvents();
  const after = cleanEvents(before);
  writeEvents(after);
  return { ok: true, removed: before.length - after.length, kept: after.length, ...SAFETY };
}

module.exports = {
  SAFETY,
  TYPE_LABELS,
  logAuditEvent,
  getRecentAuditEvents,
  getTradeAuditEvents,
  getCandidateAuditEvents,
  getBatchAuditEvents,
  getAuditStatus,
  buildActivitySummary,
  cleanupOldAuditEvents,
};
