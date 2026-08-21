export const EMPTY_VALUE = '—';
export const WAITING_BROKER = 'Hämtar brokerdata...';

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

export function textOrEmpty(value) {
  return hasValue(value) ? String(value) : EMPTY_VALUE;
}

export function fmtNumber(value, digits = 0) {
  const n = numberOrNull(value);
  if (n == null) return EMPTY_VALUE;
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function fmtMoney(value, currency = null, digits = 0) {
  const n = numberOrNull(value);
  if (n == null) return EMPTY_VALUE;
  if (!hasValue(currency)) return fmtNumber(n, digits);
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function fmtPercent(value, digits = 2) {
  const n = numberOrNull(value);
  if (n == null) return EMPTY_VALUE;
  return `${fmtNumber(n, digits)}%`;
}

export function fmtTime(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return EMPTY_VALUE;
  return new Date(ms).toLocaleString('sv-SE');
}

export function fmtAge(ms) {
  const n = numberOrNull(ms);
  if (n == null || n < 0) return EMPTY_VALUE;
  if (n < 1000) return '<1 s';
  if (n < 60_000) return `${Math.round(n / 1000)} s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)} min`;
  if (n < 86_400_000) return `${Math.round(n / 3_600_000)} h`;
  return `${Math.round(n / 86_400_000)} d`;
}

export function boolText(value) {
  if (value === true) return 'Ja';
  if (value === false) return 'Nej';
  return EMPTY_VALUE;
}

export function boolTone(value, { trueTone = 'success', falseTone = 'warning' } = {}) {
  if (value === true) return trueTone;
  if (value === false) return falseTone;
  return 'neutral';
}

export function countOrEmpty(value, available) {
  return available ? fmtNumber(value) : EMPTY_VALUE;
}

export function moneyOrWaiting(value, currency, waiting) {
  if (waiting && !hasValue(value)) return WAITING_BROKER;
  return fmtMoney(value, currency);
}

export function valueOrEmpty(value) {
  return hasValue(value) ? value : EMPTY_VALUE;
}

export function fmtCount(value) {
  return hasValue(value) ? fmtNumber(value) : EMPTY_VALUE;
}

export function fmtSignedNumber(value, digits = 2) {
  const n = numberOrNull(value);
  if (n == null) return EMPTY_VALUE;
  return `${n > 0 ? '+' : ''}${fmtNumber(n, digits)}`;
}

export function snapshotHint({ waiting = false, fallback = EMPTY_VALUE } = {}) {
  if (waiting) return WAITING_BROKER;
  return fallback || EMPTY_VALUE;
}

export function signedTone(value) {
  const n = numberOrNull(value);
  if (n == null) return 'neutral';
  if (n > 0) return 'success';
  if (n < 0) return 'danger';
  return 'neutral';
}
