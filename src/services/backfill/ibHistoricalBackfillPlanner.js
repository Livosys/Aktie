'use strict';

const crypto = require('crypto');
const futuresMarketHours = require('../futuresMarketHoursService');
const contractProvenance = require('./canonicalContractProvenanceService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  readOnly: true,
  source: 'ib_historical_backfill_planner',
});

const PLANNER_VERSION = 'ib-historical-backfill-planner-v2';
const SUPPORTED_ROOTS = Object.freeze(['MES', 'MNQ']);
const DEFAULT_CHUNK_DAYS = 1;
const IB_EXPIRED_FUTURES_HISTORY_LIMIT_YEARS = 2;
const IB_HISTORICAL_BAR_SIZE = '1 min';
const IB_HISTORICAL_DURATION = '1 D';

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = canonical(value[key]);
    return acc;
  }, {});
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function dateOnly(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function compactIbDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})?/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3] || '01'}`;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function minDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function datesInRange(from, to) {
  const out = [];
  let cursor = from;
  while (cursor && cursor <= to) {
    // Friday and Saturday labels have no complete CME equity-index Globex
    // window: Friday 17:00 CT starts the weekly close, while Saturday is
    // closed. Sunday labels remain valid because their window starts Sunday
    // 17:00 CT.
    const weekday = new Date(`${cursor}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 5 && weekday !== 6) out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

function tradingDayWindowForDate(date) {
  return futuresMarketHours.getCanonicalTradingDayWindow(date);
}

function expiryDate(contract = {}) {
  return dateOnly(contract.expiry)
    || compactIbDate(contract.expiry)
    || compactIbDate(contract.lastTradeDateOrContractMonth)
    || compactIbDate(contract.lastTradeDate);
}

function yearsBefore(date, years) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function contractKey(contract = {}) {
  return contractProvenance.canonicalContractKey(contract.root || contract.symbol, contract);
}

function normalizeContract(root, raw = {}, { from, to, nowDate, singleContract = false } = {}) {
  const expiry = expiryDate(raw);
  const activeFrom = dateOnly(raw.activeFrom || raw.from || raw.startDate || raw.firstDate)
    || (singleContract ? from : null);
  const declaredActiveTo = dateOnly(raw.activeTo || raw.to || raw.endDate || raw.lastDate)
    || (singleContract ? to : null);
  // A trading-day label starts at 17:00 CT. An expiry on YYYY-MM-DD can
  // therefore provide bars for the trading day labelled YYYY-MM-DD minus one,
  // but never for a window that starts at the expiry date's 17:00 CT boundary.
  const lastTradingDay = expiry ? addDays(expiry, -1) : null;
  const activeTo = minDate(declaredActiveTo, lastTradingDay);
  const isExpired = expiry ? expiry < nowDate : false;
  const includeExpired = raw.includeExpired === true || isExpired;
  const key = contractKey({ ...raw, root });

  const contract = {
    root,
    symbol: root,
    secType: 'FUT',
    exchange: text(raw.exchange) || 'CME',
    currency: text(raw.currency) || 'USD',
    conId: text(raw.conId),
    localSymbol: text(raw.localSymbol),
    tradingClass: text(raw.tradingClass) || root,
    expiry,
    lastTradeDateOrContractMonth: text(raw.lastTradeDateOrContractMonth || raw.lastTradeDate) || null,
    multiplier: text(raw.multiplier) || null,
    includeExpired,
    contractKey: key,
    availableFrom: dateOnly(raw.availableFrom || raw.observedFrom),
    availableTo: dateOnly(raw.availableTo || raw.observedTo),
    canonicalFrom: activeFrom,
    canonicalTo: activeTo,
    provenanceSource: text(raw.provenanceSource),
    readiness: text(raw.readiness) || contractProvenance.READINESS.RESOLVED,
    researchRollPeriod: raw.researchRollPeriod || null,
  };

  const errors = [];
  if (!contract.conId && !contract.localSymbol && !contract.lastTradeDateOrContractMonth) {
    errors.push('contract_identity_required');
  }
  if (!activeFrom || !activeTo) errors.push('explicit_contract_active_window_required');
  if (activeFrom && activeTo && activeFrom > activeTo) errors.push('contract_active_window_reversed');
  if (isExpired && expiry < yearsBefore(nowDate, IB_EXPIRED_FUTURES_HISTORY_LIMIT_YEARS)) {
    errors.push('ib_expired_future_history_older_than_two_years');
  }
  const gate = contractProvenance.gateBackfill({
    ...contract,
    root,
    activeFrom,
    activeTo,
    provenanceSource: contract.provenanceSource,
    readiness: contract.readiness,
  });
  for (const error of gate.errors) {
    if (!errors.includes(error)) errors.push(error);
  }

  return {
    ok: errors.length === 0,
    errors,
    root,
    contract,
    contractKey: key,
    activeFrom: maxDate(activeFrom, from),
    activeTo: minDate(activeTo, to),
    expired: isExpired,
  };
}

function inputContractsForRoot(input = {}, root) {
  const byRoot = input.contractsBySymbol || input.contractsByRoot || {};
  const direct = Array.isArray(byRoot[root]) ? byRoot[root] : null;
  if (direct) return direct;
  if (Array.isArray(input.contractSegments)) {
    return input.contractSegments.filter((row) => upper(row.root || row.symbol) === root);
  }
  if (Array.isArray(input.contracts)) {
    return input.contracts.filter((row) => upper(row.root || row.symbol) === root);
  }
  if (input.contract && upper(input.contract.root || input.contract.symbol || root) === root) {
    return [input.contract];
  }
  return [];
}

function buildPlan(input = {}) {
  const from = dateOnly(input.from || input.start);
  const to = dateOnly(input.to || input.end);
  const nowDate = dateOnly(input.now) || new Date().toISOString().slice(0, 10);
  const roots = (Array.isArray(input.symbols) && input.symbols.length ? input.symbols : ['MNQ', 'MES'])
    .map(upper)
    .filter(Boolean);
  const chunkDays = Math.max(1, Math.min(DEFAULT_CHUNK_DAYS, Number(input.chunkDays) || DEFAULT_CHUNK_DAYS));

  const blockers = [];
  if (!from || !to) blockers.push({ reason: 'date_range_required' });
  if (from && to && from > to) blockers.push({ reason: 'date_range_reversed', from, to });
  const unsupported = roots.filter((root) => !SUPPORTED_ROOTS.includes(root));
  for (const root of unsupported) blockers.push({ root, reason: 'unsupported_futures_root' });

  const normalizedInput = canonical({
    from,
    to,
    roots,
    chunkDays,
    contractsBySymbol: input.contractsBySymbol || input.contractsByRoot || null,
    contractSegments: input.contractSegments || input.contracts || input.contract || null,
    nowDate,
  });
  const runId = text(input.runId) || `ib_backfill_${sha(stableStringify(normalizedInput)).slice(0, 20)}`;
  const correlationId = text(input.correlationId) || runId;

  if (blockers.length) {
    return {
      ok: false,
      reason: blockers[0].reason,
      plannerVersion: PLANNER_VERSION,
      runId,
      correlationId,
      blockers,
      segments: [],
      deterministic: true,
      ...SAFETY,
    };
  }

  const segments = [];
  const contractSegments = [];
  for (const root of roots) {
    const rawContracts = inputContractsForRoot(input, root);
    if (!rawContracts.length) {
      blockers.push({ root, reason: 'contract_segments_required' });
      continue;
    }

    const normalized = rawContracts.map((contract) => normalizeContract(root, contract, {
      from,
      to,
      nowDate,
      singleContract: rawContracts.length === 1,
    }));
    for (const row of normalized) {
      for (const error of row.errors) blockers.push({ root, contractKey: row.contractKey, reason: error });
      if (row.ok && row.activeFrom > row.activeTo) {
        blockers.push({
          root,
          contractKey: row.contractKey,
          reason: 'contract_active_window_no_overlap',
          requestedFrom: from,
          requestedTo: to,
          activeFrom: row.activeFrom,
          activeTo: row.activeTo,
        });
      }
    }

    const ownersByDate = new Map();
    for (const row of normalized.filter((entry) => entry.ok)) {
      if (row.activeFrom > row.activeTo) continue;
      contractSegments.push(row);
      for (const date of datesInRange(row.activeFrom, row.activeTo)) {
        const existing = ownersByDate.get(date);
        if (existing && existing.contractKey !== row.contractKey) {
          blockers.push({
            root,
            date,
            reason: 'ambiguous_contract_ownership',
            legacyReason: 'contract_segments_overlap',
            contracts: [existing.contractKey, row.contractKey].sort(),
          });
          continue;
        }
        ownersByDate.set(date, row);
      }
    }

    for (const date of [...ownersByDate.keys()].sort()) {
      const owner = ownersByDate.get(date);
      const window = tradingDayWindowForDate(date);
      if (!window) {
        blockers.push({ root, date, reason: 'canonical_trading_day_window_invalid' });
        continue;
      }
      const request = {
        root,
        contract: owner.contract,
        contractKey: owner.contractKey,
        date,
        from: window.startUtc,
        to: window.endUtc,
        endDateTime: window.endUtc,
        duration: IB_HISTORICAL_DURATION,
        barSize: IB_HISTORICAL_BAR_SIZE,
        whatToShow: 'TRADES',
        useRth: 0,
        includeExpired: owner.contract.includeExpired === true,
        session: 'cme_globex',
        timezone: 'UTC',
        exchangeTimezone: window.timezone,
        tradingDayWindow: window,
      };
      segments.push({
        id: `ibseg_${sha(stableStringify(request)).slice(0, 20)}`,
        runId,
        correlationId,
        symbol: root,
        root,
        date,
        contractKey: owner.contractKey,
        contract: owner.contract,
        activeFrom: owner.activeFrom,
        activeTo: owner.activeTo,
        readiness: owner.contract.readiness,
        provenanceSource: owner.contract.provenanceSource,
        request,
      });
    }
  }

  const sortedSegments = segments.sort((a, b) => String(a.root).localeCompare(String(b.root))
    || String(a.date).localeCompare(String(b.date))
    || String(a.contractKey).localeCompare(String(b.contractKey)));

  return {
    ok: blockers.length === 0,
    reason: blockers.length ? blockers[0].reason : null,
    plannerVersion: PLANNER_VERSION,
    runId,
    correlationId,
    deterministic: true,
    provider: 'ibkr',
    disallowedProviders: ['alpaca', 'databento'],
    roots,
    from,
    to,
    chunkDays,
    barSize: IB_HISTORICAL_BAR_SIZE,
    duration: IB_HISTORICAL_DURATION,
    session: 'cme_globex',
    timezone: 'UTC',
    exchangeTimezone: futuresMarketHours.CME_EQUITY_INDEX_TIMEZONE,
    segments: sortedSegments,
    contractSegments: contractSegments
      .sort((a, b) => String(a.root).localeCompare(String(b.root))
        || String(a.activeFrom).localeCompare(String(b.activeFrom)))
      .map((row) => ({
        root: row.root,
        contractKey: row.contractKey,
        activeFrom: row.activeFrom,
        activeTo: row.activeTo,
        availableFrom: row.contract.availableFrom,
        availableTo: row.contract.availableTo,
        canonicalFrom: row.contract.canonicalFrom,
        canonicalTo: row.contract.canonicalTo,
        provenanceSource: row.contract.provenanceSource,
        readiness: row.contract.readiness,
        expired: row.expired,
        includeExpired: row.contract.includeExpired === true,
      })),
    blockers,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  PLANNER_VERSION,
  SUPPORTED_ROOTS,
  DEFAULT_CHUNK_DAYS,
  IB_EXPIRED_FUTURES_HISTORY_LIMIT_YEARS,
  IB_HISTORICAL_BAR_SIZE,
  IB_HISTORICAL_DURATION,
  buildPlan,
  contractKey,
  expiryDate,
  _internal: {
    canonical,
    stableStringify,
    dateOnly,
    datesInRange,
    tradingDayWindowForDate,
    normalizeContract,
    yearsBefore,
  },
};
