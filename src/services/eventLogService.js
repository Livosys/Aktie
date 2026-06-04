'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kafkaEventProducer = require('./kafkaEventProducerService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
});

const DATA_DIR = path.resolve(__dirname, '../../data/events');
const EVENTS_FILE = path.join(DATA_DIR, 'trading-events.jsonl');
const MAX_RECENT_EVENTS = 100;
const DEFAULT_ROTATION_THRESHOLD_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 10;

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
  if (['scanner', 'market_gate', 'paper_trading', 'batch', 'learning', 'tradingview'].includes(source)) return source;
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

function formatArchiveTimestamp(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}${minutes}${seconds}`;
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

// The append-only events log can grow to hundreds of MB. Parsing the whole file
// on every call (only to return the last MAX_RECENT_EVENTS lines) blocks the event
// loop for seconds and spikes memory — fatal when callers fan out per strategy.
// We only ever return the tail, so read just the tail bytes of the file.
const RECENT_EVENTS_TAIL_BYTES = 512 * 1024;

function createEventLogService(options = {}) {
  const dataDir = options.dataDir || DATA_DIR;
  const eventsFile = options.eventsFile || path.join(dataDir, 'trading-events.jsonl');
  const archiveDir = options.archiveDir || path.join(dataDir, 'archive');
  const rotationThresholdBytes = Number.isFinite(Number(options.rotationThresholdBytes))
    ? Number(options.rotationThresholdBytes)
    : DEFAULT_ROTATION_THRESHOLD_BYTES;
  const maxArchives = Number.isFinite(Number(options.maxArchives))
    ? Math.max(1, Number(options.maxArchives))
    : DEFAULT_MAX_ARCHIVES;
  const producer = options.kafkaEventProducer || kafkaEventProducer;
  const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : console;
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function ensureServiceDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function ensureArchiveDir() {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  function rotateIfNeeded() {
    try {
      if (!fs.existsSync(eventsFile)) return false;
      const { size } = fs.statSync(eventsFile);
      if (!Number.isFinite(size) || size <= rotationThresholdBytes) return false;

      ensureArchiveDir();
      const baseArchiveName = `trading-events-${formatArchiveTimestamp(now())}.jsonl`;
      let archivePath = path.join(archiveDir, baseArchiveName);
      let suffix = 1;
      while (fs.existsSync(archivePath)) {
        archivePath = path.join(archiveDir, baseArchiveName.replace('.jsonl', `-${suffix}.jsonl`));
        suffix += 1;
      }

      try {
        fs.renameSync(eventsFile, archivePath);
      } catch (err) {
        logger.warn('[event-log] rotation failed:', err?.message || err);
        return false;
      }

      fs.closeSync(fs.openSync(eventsFile, 'a'));

      try {
        const archiveFiles = fs.readdirSync(archiveDir)
          .filter((name) => /^trading-events-\d{4}-\d{2}-\d{2}T\d{6}\.jsonl$/.test(name))
          .map((name) => {
            const fullPath = path.join(archiveDir, name);
            return {
              name,
              path: fullPath,
              mtime: fs.statSync(fullPath).mtimeMs,
            };
          })
          .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));

        for (const file of archiveFiles.slice(maxArchives)) {
          try {
            fs.unlinkSync(file.path);
          } catch (err) {
            logger.warn('[event-log] archive cleanup failed:', err?.message || err);
          }
        }
      } catch (err) {
        logger.warn('[event-log] archive retention failed:', err?.message || err);
      }

      return true;
    } catch (err) {
      logger.warn('[event-log] rotation failed:', err?.message || err);
      return false;
    }
  }

  function appendEvent(input = {}) {
    try {
      ensureServiceDir();
      rotateIfNeeded();
      const event = normalizeEvent(input);
      fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
      try {
        Promise.resolve(producer.publishEvent(event)).catch((err) => {
          logger.warn('[event-log] kafka publish failed:', err?.message || err);
        });
      } catch (err) {
        logger.warn('[event-log] kafka publish failed:', err.message);
      }
      return { ok: true, event, ...SAFETY };
    } catch (err) {
      logger.warn('[event-log] append failed:', err.message);
      return { ok: false, error: err.message, ...SAFETY };
    }
  }

  function readRecentEvents(limit = MAX_RECENT_EVENTS) {
    try {
      if (!fs.existsSync(eventsFile)) return { ok: true, count: 0, events: [], ...SAFETY };
      const cap = Math.max(1, Math.min(MAX_RECENT_EVENTS, Number(limit) || MAX_RECENT_EVENTS));

      const { size } = fs.statSync(eventsFile);
      const start = Math.max(0, size - RECENT_EVENTS_TAIL_BYTES);
      let raw;
      const fd = fs.openSync(eventsFile, 'r');
      try {
        const length = size - start;
        const buffer = Buffer.allocUnsafe(length);
        fs.readSync(fd, buffer, 0, length, start);
        raw = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      if (start > 0) {
        const nl = raw.indexOf('\n');
        raw = nl >= 0 ? raw.slice(nl + 1) : '';
      }

      const parsed = raw
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
      const capped = parsed.slice(-cap).reverse();
      return { ok: true, count: parsed.length, events: capped, ...SAFETY };
    } catch (err) {
      return { ok: false, error: err.message, count: 0, events: [], ...SAFETY };
    }
  }

  function getStatus() {
    return {
      jsonl_enabled: true,
      ...producer.getStatus(),
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    EVENTS_FILE: eventsFile,
    appendEvent,
    getStatus,
    readRecentEvents,
    normalizeEvent,
    rotateIfNeeded,
  };
}

const defaultEventLogService = createEventLogService();

function appendEvent(input = {}) {
  return defaultEventLogService.appendEvent(input);
}

function getStatus() {
  return defaultEventLogService.getStatus();
}

function readRecentEvents(limit = MAX_RECENT_EVENTS) {
  return defaultEventLogService.readRecentEvents(limit);
}

module.exports = {
  SAFETY,
  EVENTS_FILE,
  createEventLogService,
  appendEvent,
  getStatus,
  readRecentEvents,
  normalizeEvent,
  rotateIfNeeded: () => defaultEventLogService.rotateIfNeeded(),
};
