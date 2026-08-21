'use strict';

const candleAggregator = require('../../data/candleAggregator');
const futuresMarketHours = require('../futuresMarketHoursService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  readOnly: true,
  source: 'ib_historical_backfill_validator',
});

const FIELD_ALIASES = Object.freeze({
  ts: ['ts', 't', 'timestamp'],
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c'],
  volume: ['volume', 'v'],
  tradeCount: ['tradeCount', 'count'],
});

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function firstValue(row = {}, names = []) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return null;
}

function timestampInput(row = {}) {
  return firstValue(row, FIELD_ALIASES.ts)
    ?? row.epoch
    ?? row.time;
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const ms = n < 1e12 ? n * 1000 : n;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const ib = raw.match(/^(\d{4})(\d{2})(\d{2})[- ]+(\d{2}):(\d{2}):(\d{2})(?:\s+UTC)?$/i);
  if (ib) {
    return `${ib[1]}-${ib[2]}-${ib[3]}T${ib[4]}:${ib[5]}:${ib[6]}.000Z`;
  }
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function hasExplicitTimezone(value) {
  if (value == null || typeof value === 'number') return true;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return true;
  return /(?:Z|[+-]\d{2}:?\d{2}|\sUTC)$/i.test(raw);
}

function dateOnly(value) {
  const iso = toIso(value || '');
  return iso ? iso.slice(0, 10) : null;
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

function isCmeGlobexMinuteOpen(iso) {
  return futuresMarketHours.getCmeEquityIndexFuturesSessionState(iso).isOpen;
}

function expectedMinuteTimestamps(from, to, { session = 'cme_globex' } = {}) {
  const start = toIso(from);
  const end = toIso(to);
  if (!start || !end || start >= end) return [];
  const out = [];
  let cursor = start;
  while (cursor < end) {
    if (session !== 'cme_globex' || isCmeGlobexMinuteOpen(cursor)) out.push(cursor);
    cursor = addMinutes(cursor, 1);
  }
  return out;
}

function contractIdentity(row = {}) {
  const conId = text(row.conId);
  const localSymbol = text(row.localSymbol);
  const expiry = text(row.expiry || row.lastTradeDateOrContractMonth);
  const contractKey = text(row.contractKey);
  if (contractKey) return contractKey;
  if (conId || localSymbol || expiry) return [conId || 'no-conid', localSymbol || 'no-localSymbol', expiry || 'no-expiry'].join(':');
  return null;
}

function normalizeBar(row = {}) {
  const ts = toIso(timestampInput(row));
  if (!ts) return null;
  return {
    ...row,
    ts,
    t: ts,
    timestamp: ts,
    open: Number(firstValue(row, FIELD_ALIASES.open)),
    high: Number(firstValue(row, FIELD_ALIASES.high)),
    low: Number(firstValue(row, FIELD_ALIASES.low)),
    close: Number(firstValue(row, FIELD_ALIASES.close)),
    volume: Number(firstValue(row, FIELD_ALIASES.volume) ?? 0),
    tradeCount: firstValue(row, FIELD_ALIASES.tradeCount) == null ? null : Number(firstValue(row, FIELD_ALIASES.tradeCount)),
  };
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function sample(values, limit = 10) {
  return values.slice(0, limit);
}

function validateBars(rows = [], options = {}) {
  const session = options.session || 'cme_globex';
  const timezone = options.timezone || 'UTC';
  const from = toIso(options.from);
  const to = toIso(options.to);
  const expectedContract = contractIdentity(options.contract || {});
  const invalidRows = [];
  const missingPriceRows = [];
  const timestamps = [];
  const timezoneFailures = [];
  const sessionFailures = [];
  const outsideInterval = [];
  const physicalOrder = [];
  const identities = [];
  let previous = null;
  let monotonic = true;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rawTs = timestampInput(row);
    const ts = toIso(rawTs);
    if (!ts) {
      invalidRows.push({ index, reason: 'invalid_timestamp' });
      continue;
    }
    if (!hasExplicitTimezone(rawTs)) timezoneFailures.push({ index, timestamp: rawTs });
    if (timezone !== 'UTC' || !ts.endsWith('Z')) timezoneFailures.push({ index, timestamp: rawTs, normalized: ts });
    const normalized = normalizeBar(row);
    if (!normalized || !Number.isFinite(normalized.open) || !Number.isFinite(normalized.high)
      || !Number.isFinite(normalized.low) || !Number.isFinite(normalized.close)) {
      missingPriceRows.push({ index, timestamp: ts });
    }
    if (session === 'cme_globex' && !isCmeGlobexMinuteOpen(ts)) sessionFailures.push({ index, timestamp: ts });
    if ((from && ts < from) || (to && ts >= to)) outsideInterval.push({ index, timestamp: ts });
    if (previous && ts < previous) monotonic = false;
    previous = ts;
    physicalOrder.push(ts);
    timestamps.push(ts);
    const identity = contractIdentity(row);
    if (identity) identities.push(identity);
  }

  const counts = new Map();
  for (const ts of timestamps) counts.set(ts, (counts.get(ts) || 0) + 1);
  const duplicateTimestamps = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([timestamp, count]) => ({ timestamp, count }));
  const actualSet = new Set(timestamps);
  const expected = from && to ? expectedMinuteTimestamps(from, to, { session }) : [];
  const missing = expected.filter((ts) => !actualSet.has(ts));
  const uniqueIdentities = uniqueSorted(identities);
  const contractMismatches = expectedContract
    ? uniqueIdentities.filter((identity) => identity !== expectedContract)
    : [];

  const errors = [];
  if (invalidRows.length) errors.push('invalid_timestamp');
  if (missingPriceRows.length) errors.push('invalid_ohlc');
  if (duplicateTimestamps.length) errors.push('duplicate_timestamps');
  if (!monotonic) errors.push('non_monotonic_timeseries');
  if (timezoneFailures.length) errors.push('invalid_timezone');
  if (sessionFailures.length) errors.push('outside_cme_globex_session');
  if (outsideInterval.length) errors.push('outside_requested_interval');
  if (missing.length) errors.push('missing_expected_minutes');
  if (uniqueIdentities.length > 1) errors.push('multiple_contract_identities');
  if (contractMismatches.length) errors.push('contract_identity_mismatch');

  return {
    ok: errors.length === 0,
    errors,
    rowCount: rows.length,
    uniqueTimestampCount: actualSet.size,
    duplicateCount: duplicateTimestamps.reduce((sum, row) => sum + row.count - 1, 0),
    duplicateTimestamps: sample(duplicateTimestamps),
    monotonic,
    timezone: {
      expected: 'UTC',
      ok: timezoneFailures.length === 0,
      failures: sample(timezoneFailures),
    },
    session: {
      expected: session,
      ok: sessionFailures.length === 0,
      failures: sample(sessionFailures),
    },
    interval: {
      from,
      to,
      ok: outsideInterval.length === 0,
      outside: sample(outsideInterval),
      firstTimestamp: timestamps.length ? timestamps.slice().sort()[0] : null,
      lastTimestamp: timestamps.length ? timestamps.slice().sort().slice(-1)[0] : null,
    },
    gaps: {
      ok: missing.length === 0,
      expectedCount: expected.length,
      actualCount: actualSet.size,
      missingCount: missing.length,
      missing: sample(missing),
    },
    contract: {
      expected: expectedContract,
      identities: uniqueIdentities,
      ok: uniqueIdentities.length <= 1 && contractMismatches.length === 0,
      mismatches: contractMismatches,
    },
    candleCount: {
      timeframe: '1m',
      expected: expected.length || null,
      actual: actualSet.size,
      ok: expected.length ? actualSet.size === expected.length : true,
    },
    invalidRows: sample(invalidRows),
    missingPriceRows: sample(missingPriceRows),
    safety: SAFETY,
  };
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function candleValue(row = {}, field) {
  if (field === 'o') return numberOrNull(row.o ?? row.open);
  if (field === 'h') return numberOrNull(row.h ?? row.high);
  if (field === 'l') return numberOrNull(row.l ?? row.low);
  if (field === 'c') return numberOrNull(row.c ?? row.close);
  if (field === 'v') return numberOrNull(row.v ?? row.volume);
  return null;
}

function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= 1e-9;
}

function validateAggregation({ bars1m = [], candles2m = [] } = {}) {
  const expected = candleAggregator.aggregate1mTo2m(bars1m).filter((candle) => !candle.incomplete);
  const actualByTs = new Map();
  for (const row of candles2m) {
    const ts = toIso(timestampInput(row));
    if (ts) actualByTs.set(ts, row);
  }
  const expectedByTs = new Map(expected.map((row) => [row.ts, row]));
  const missing = [];
  const extra = [];
  const mismatches = [];

  for (const row of expected) {
    const actual = actualByTs.get(row.ts);
    if (!actual) {
      missing.push(row.ts);
      continue;
    }
    const fields = ['o', 'h', 'l', 'c', 'v'];
    const different = fields.filter((field) => !valuesEqual(candleValue(row, field), candleValue(actual, field)));
    if (different.length) {
      mismatches.push({
        timestamp: row.ts,
        fields: different,
        expected: { o: row.o, h: row.h, l: row.l, c: row.c, v: row.v },
        actual: {
          o: candleValue(actual, 'o'),
          h: candleValue(actual, 'h'),
          l: candleValue(actual, 'l'),
          c: candleValue(actual, 'c'),
          v: candleValue(actual, 'v'),
        },
      });
    }
  }
  for (const timestamp of actualByTs.keys()) {
    if (!expectedByTs.has(timestamp)) extra.push(timestamp);
  }
  const errors = [];
  if (missing.length) errors.push('missing_2m_candles');
  if (extra.length) errors.push('extra_2m_candles');
  if (mismatches.length) errors.push('aggregation_value_mismatch');

  return {
    ok: errors.length === 0,
    errors,
    identicalAggregation: errors.length === 0,
    source: 'candleAggregator.aggregate1mTo2m',
    expectedCount: expected.length,
    actualCount: actualByTs.size,
    missingCount: missing.length,
    extraCount: extra.length,
    mismatchCount: mismatches.length,
    missing: sample(missing),
    extra: sample(extra),
    mismatches: sample(mismatches, 5),
    safety: SAFETY,
  };
}

module.exports = {
  SAFETY,
  validateBars,
  validateAggregation,
  _internal: {
    toIso,
    dateOnly,
    contractIdentity,
    normalizeBar,
    expectedMinuteTimestamps,
    isCmeGlobexMinuteOpen,
  },
};
