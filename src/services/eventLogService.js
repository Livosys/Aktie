'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
});

const DATA_DIR = path.resolve(__dirname, '../../data/events');
const EVENTS_FILE = path.join(DATA_DIR, 'trading-events.jsonl');
const MAX_RECENT_EVENTS = 100;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function safeClone(value) {
  if (value == null) return {};
  if (Array.isArray(value) || typeof value !== 'object') return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
  } catch (_) {
    return {};
  }
}

function safeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `evt_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function isIsoDate(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time);
}

function normalizeSource(value) {
  const source = String(value || 'scanner').toLowerCase();
  if (['scanner', 'market_gate', 'paper_trading', 'batch', 'learning'].includes(source)) return source;
  return 'scanner';
}

function normalizeMarket(value, symbol = null) {
  const raw = String(value || '').toLowerCase();
  const upperSymbol = String(symbol || '').toUpperCase();
  if (upperSymbol.endsWith('USDT')) return 'crypto';
  if (raw.includes('crypto')) return 'crypto';
  if (raw.includes('nasdaq')) return 'nasdaq';
  if (raw.includes('stock') || raw === 'equity' || raw === 'stocks') return 'stocks';
  if (raw === 'crypto' || raw === 'stocks' || raw === 'nasdaq') return raw;
  if (raw.includes('etf') || raw.includes('index')) return 'stocks';
  return 'unknown';
}

function normalizeDirection(value) {
  const raw = String(value || '').toUpperCase();
  if (raw === 'UP' || raw === 'LONG' || raw === 'BUY') return 'UP';
  if (raw === 'DOWN' || raw === 'SHORT' || raw === 'SELL') return 'DOWN';
  return 'NONE';
}

function normalizeDecision(value, eventType) {
  const raw = String(value || '').toLowerCase();
  if (['allowed', 'blocked', 'observe_only', 'paper_opened', 'paper_closed', 'no_trade'].includes(raw)) return raw;
  switch (String(eventType || '').toLowerCase()) {
    case 'signal.detected':
    case 'strategy.matched':
    case 'market_gate.observe_only':
      return 'observe_only';
    case 'market_gate.allowed':
      return 'allowed';
    case 'market_gate.blocked':
      return 'blocked';
    case 'paper_trade.opened':
      return 'paper_opened';
    case 'paper_trade.closed':
      return 'paper_closed';
    case 'paper_trade.skipped':
    case 'batch.started':
    case 'batch.completed':
    case 'learning.summary_created':
      return 'no_trade';
    default:
      return 'no_trade';
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stripValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return String(value);
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function normalizeEvent(input = {}) {
  const eventType = String(firstPresent(input.event_type, input.type, 'signal.detected')).trim() || 'signal.detected';
  const timestamp = isIsoDate(input.timestamp) ? new Date(input.timestamp).toISOString() : nowIso();
  const source = normalizeSource(firstPresent(input.source, input.origin, 'scanner'));
  const metadata = safeClone(firstPresent(input.metadata, input.details, input.extra, {}));
  const symbol = stripValue(firstPresent(input.symbol, input.ticker, null));
  const rawSignal = stripValue(firstPresent(
    input.raw_signal,
    input.rawSignal,
    input.signalSubtype,
    input.signal_subtype,
    input.signalFamily,
    input.signal_family,
    input.signal,
    input.strategy,
    input.strategy_id,
    input.strategyId,
  ));
  const strategy = stripValue(firstPresent(
    input.strategy,
    input.strategy_id,
    input.strategyId,
    input.strategy_name,
    input.strategyName,
  ));
  const market = normalizeMarket(firstPresent(input.market, input.marketType, input.market_group, input.marketGroup, input.group), symbol);
  const direction = normalizeDirection(firstPresent(input.direction, input.nextMoveBias, input.bias));
  const score = toNumber(firstPresent(input.score, input.tradeScore, input.signalScore, input.confidenceScore, input.gateScore, input.win_rate));
  const threshold = toNumber(firstPresent(input.threshold, input.gateThreshold, input.allowThreshold, input.confidence_threshold));
  const event = {
    event_id: stripValue(firstPresent(input.event_id, input.eventId, safeId())),
    event_type: eventType,
    timestamp,
    source,
    symbol,
    market,
    timeframe: stripValue(firstPresent(input.timeframe, input.tf, null)),
    raw_signal: rawSignal,
    direction,
    strategy,
    score,
    decision: normalizeDecision(input.decision, eventType),
    reason: stripValue(firstPresent(input.reason, input.reasonSv, input.message, null)),
    threshold,
    paper: input.paper === true,
    live: false,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    metadata: {
      ...metadata,
      source_event_type: input.type || null,
    },
  };

  return event;
}

function appendEvent(input = {}) {
  try {
    ensureDir();
    const event = normalizeEvent(input);
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
    return { ok: true, event, ...SAFETY };
  } catch (err) {
    console.warn('[event-log] append failed:', err.message);
    return { ok: false, error: err.message, ...SAFETY };
  }
}

function readRecentEvents(limit = MAX_RECENT_EVENTS) {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return { ok: true, count: 0, events: [], ...SAFETY };
    const parsed = fs.readFileSync(EVENTS_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    const count = parsed.length;
    const capped = parsed.slice(-Math.max(1, Math.min(MAX_RECENT_EVENTS, Number(limit) || MAX_RECENT_EVENTS))).reverse();
    return { ok: true, count, events: capped, ...SAFETY };
  } catch (err) {
    return { ok: false, error: err.message, count: 0, events: [], ...SAFETY };
  }
}

module.exports = {
  SAFETY,
  EVENTS_FILE,
  appendEvent,
  readRecentEvents,
  normalizeEvent,
};
