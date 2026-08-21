'use strict';

const fs = require('fs');
const path = require('path');
const { defaultIbPaperExecutionIntentService } = require('./ibPaperExecutionIntentService');

const MAX_NEW_PAPER_TRADES_PER_DAY = 100;
const DEFAULT_DIR = path.resolve(__dirname, '../../data/futures-paper/ibkr-execution');
const ACCEPTED_INTENT_STATUSES = new Set(['submitted', 'acknowledged', 'partially_filled', 'filled']);

function chicagoParts(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', minute: '2-digit',
  }).formatToParts(new Date(value));
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

function tradingDayKey(value = new Date()) {
  const p = chicagoParts(value);
  const date = new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  if (Number(p.hour) < 17) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function createFuturesPaperDailyTradeCapService(options = {}) {
  const dir = options.dir || DEFAULT_DIR;
  const reservationsFile = path.join(dir, 'daily-entry-reservations.jsonl');
  const intentService = options.intentService || defaultIbPaperExecutionIntentService;
  const maxTrades = Math.min(
    Math.max(1, Number(options.maxTrades || MAX_NEW_PAPER_TRADES_PER_DAY)),
    MAX_NEW_PAPER_TRADES_PER_DAY,
  );

  function reservationRows() {
    return readJsonl(reservationsFile);
  }

  function acceptedIntentRows() {
    const intents = typeof intentService.listIntents === 'function'
      ? intentService.listIntents({ limit: 100000 })
      : [];
    return intents.filter((row) => row.executionTarget !== 'ibkr_live' && ACCEPTED_INTENT_STATUSES.has(row.status));
  }

  function acceptedKeys(day) {
    const keys = new Set();
    for (const row of reservationRows()) {
      if (row.tradingDay === day && row.idempotencyKey) keys.add(row.idempotencyKey);
    }
    for (const row of acceptedIntentRows()) {
      if (tradingDayKey(row.createdAt || row.updatedAt) === day && row.idempotencyKey) keys.add(row.idempotencyKey);
    }
    return keys;
  }

  function status(now = new Date()) {
    const day = tradingDayKey(now);
    const count = acceptedKeys(day).size;
    return {
      tradingDay: day,
      tradesToday: count,
      maxTradesToday: maxTrades,
      remainingTradesToday: Math.max(0, maxTrades - count),
      limitReached: count >= maxTrades,
    };
  }

  function withLock(fn) {
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, '.daily-entry-cap.lock');
    let fd;
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { fd = fs.openSync(lock, 'wx'); break; } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      if (fd == null) return { ok: false, blockedReason: 'daily_cap_lock_unavailable' };
      return fn();
    } finally {
      if (fd != null) fs.closeSync(fd);
      try { fs.unlinkSync(lock); } catch (_) { /* lock already gone */ }
    }
  }

  function reserve({ idempotencyKey, strategyId, canonicalStrategyId, now = new Date() } = {}) {
    if (!idempotencyKey) return { ok: false, blockedReason: 'daily_cap_requires_idempotency_key' };
    return withLock(() => {
      const day = tradingDayKey(now);
      const keys = acceptedKeys(day);
      if (keys.has(idempotencyKey)) return { ok: true, duplicate: true, ...status(now) };
      if (keys.size >= maxTrades) return { ok: false, blockedReason: 'daily_paper_trade_limit_reached', ...status(now) };
      fs.appendFileSync(reservationsFile, `${JSON.stringify({
        idempotencyKey,
        strategyId: strategyId || null,
        canonicalStrategyId: canonicalStrategyId || null,
        tradingDay: day,
        reservedAt: new Date(now).toISOString(),
        source: 'futures_paper_execution',
      })}\n`, 'utf8');
      return { ok: true, reserved: true, ...status(now) };
    });
  }

  return { MAX_NEW_PAPER_TRADES_PER_DAY: maxTrades, tradingDayKey, status, reserve, _internal: { acceptedKeys, reservationRows } };
}

const defaultFuturesPaperDailyTradeCapService = createFuturesPaperDailyTradeCapService();

module.exports = {
  MAX_NEW_PAPER_TRADES_PER_DAY,
  tradingDayKey,
  createFuturesPaperDailyTradeCapService,
  defaultFuturesPaperDailyTradeCapService,
};
