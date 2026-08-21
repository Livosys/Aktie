'use strict';

// Canonical contract identity and provenance rules shared by capture, backfill
// and read paths. This module deliberately does not choose a research roll.

const READINESS = Object.freeze({
  RESOLVED: 'RESOLVED',
  HISTORICAL_PROBED: 'HISTORICAL_PROBED',
  HISTORICAL_USABLE: 'HISTORICAL_USABLE',
  HISTORICAL_DEGRADED: 'HISTORICAL_DEGRADED',
  HISTORICAL_UNAVAILABLE: 'HISTORICAL_UNAVAILABLE',
  PROVENANCE_READY: 'PROVENANCE_READY',
  BACKFILL_READY: 'BACKFILL_READY',
});

const PROVENANCE = Object.freeze({
  EXACT: 'exact_provenance',
  MANIFEST_ONLY: 'manifest_only',
  AMBIGUOUS: 'ambiguous',
});

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function upper(value) { return String(value || '').trim().toUpperCase(); }

function expiryDate(contract = {}) {
  const raw = text(contract.expiry || contract.lastTradeDateOrContractMonth || contract.lastTradeDate);
  if (!raw) return null;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})?/);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3] || '01'}` : raw.slice(0, 10);
}

function canonicalContractKey(root, contract = {}) {
  const normalizedRoot = upper(root || contract.root || contract.symbol);
  const conId = text(contract.conId);
  const localSymbol = text(contract.localSymbol);
  const expiry = expiryDate(contract) || 'unknown-expiry';
  if (!normalizedRoot || (!conId && !localSymbol && !expiry)) return null;
  return [normalizedRoot, conId || localSymbol || 'unknown-conid', expiry].join(':');
}

function normalizeIdentity(root, contract = {}) {
  const normalizedRoot = upper(root || contract.root || contract.symbol);
  const expiry = expiryDate(contract);
  const contractKey = text(contract.contractKey) || canonicalContractKey(normalizedRoot, contract);
  const identity = {
    root: normalizedRoot || null,
    symbol: normalizedRoot || null,
    contractKey,
    conId: text(contract.conId),
    localSymbol: text(contract.localSymbol),
    expiry,
    lastTradeDateOrContractMonth: text(contract.lastTradeDateOrContractMonth || contract.lastTradeDate),
    tradingClass: text(contract.tradingClass) || normalizedRoot || null,
    exchange: text(contract.exchange) || 'CME',
    currency: text(contract.currency) || 'USD',
  };
  identity.exact = Boolean(identity.root && identity.contractKey
    && (identity.conId || identity.localSymbol)
    && identity.expiry);
  return identity;
}

function normalizeDate(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function normalizePeriod(root, contract = {}, { activeFrom, activeTo, availableFrom, availableTo, canonicalFrom, canonicalTo } = {}) {
  const identity = normalizeIdentity(root, contract);
  return {
    ...identity,
    expiry: identity.expiry,
    availableFrom: normalizeDate(availableFrom || contract.availableFrom || contract.observedFrom),
    availableTo: normalizeDate(availableTo || contract.availableTo || contract.observedTo),
    activeFrom: normalizeDate(activeFrom || contract.activeFrom),
    activeTo: normalizeDate(activeTo || contract.activeTo),
    canonicalFrom: normalizeDate(canonicalFrom || contract.canonicalFrom),
    canonicalTo: normalizeDate(canonicalTo || contract.canonicalTo),
    provenanceSource: text(contract.provenanceSource) || null,
    readiness: text(contract.readiness) || READINESS.RESOLVED,
    researchRollPeriod: contract.researchRollPeriod || null,
  };
}

function classifyProbe({ timestampComplete = false, volumeComplete = false, bars = 0, unavailable = false } = {}) {
  if (unavailable) return READINESS.HISTORICAL_UNAVAILABLE;
  if (!bars) return READINESS.HISTORICAL_PROBED;
  if (timestampComplete && volumeComplete) return READINESS.HISTORICAL_USABLE;
  return READINESS.HISTORICAL_DEGRADED;
}

function isBackfillReady(contract = {}) {
  const identity = normalizeIdentity(contract.root, contract);
  const period = normalizePeriod(contract.root, contract);
  return identity.exact
    && Boolean(period.activeFrom && period.activeTo)
    && period.activeFrom <= period.activeTo
    && period.readiness === READINESS.BACKFILL_READY
    && Boolean(period.provenanceSource);
}

function gateBackfill(contract = {}) {
  const identity = normalizeIdentity(contract.root, contract);
  const period = normalizePeriod(contract.root, contract);
  const errors = [];
  if (!identity.exact) errors.push('contract_provenance_unverified');
  if (!period.activeFrom || !period.activeTo) errors.push('contract_active_period_unverified');
  if (period.activeFrom && period.activeTo && period.activeFrom > period.activeTo) {
    errors.push('ambiguous_contract_period');
  }
  if (period.readiness !== READINESS.BACKFILL_READY) errors.push('contract_not_backfill_ready');
  if (!period.provenanceSource) errors.push('contract_provenance_source_required');
  return { ok: errors.length === 0, errors, identity, period };
}

function barIdentity(row = {}) {
  const timestamp = text(row.ts || row.t || row.timestamp);
  const contractKey = text(row.contractKey);
  return contractKey && timestamp ? `${contractKey}|${timestamp}` : null;
}

function provenanceQuality(row = {}) {
  if (barIdentity(row)) return PROVENANCE.EXACT;
  if (row.provenanceQuality === PROVENANCE.AMBIGUOUS) return PROVENANCE.AMBIGUOUS;
  return PROVENANCE.MANIFEST_ONLY;
}

module.exports = {
  READINESS,
  PROVENANCE,
  canonicalContractKey,
  normalizeIdentity,
  normalizePeriod,
  classifyProbe,
  isBackfillReady,
  gateBackfill,
  barIdentity,
  provenanceQuality,
  _internal: { text, upper, expiryDate, normalizeDate },
};
