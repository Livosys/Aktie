import {
  EMPTY_VALUE,
  WAITING_BROKER,
  boolText,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTime,
  hasValue,
  numberOrNull,
  signedTone,
  textOrEmpty,
} from '../utils/tradingFormatters.js';

export const WAITING_RUNTIME = 'Waiting for runtime...';
export const UNAVAILABLE = 'Unavailable';

export function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function sourcePayload(entry) {
  if (!entry) return null;
  if (entry.ok === true && isPlainObject(entry.data)) return entry.data;
  if (isPlainObject(entry.data) && !Object.prototype.hasOwnProperty.call(entry, 'ok')) return entry.data;
  return entry;
}

export function unwrapSources(sources = {}) {
  return Object.fromEntries(
    Object.entries(sources || {}).map(([key, value]) => [key, sourcePayload(value)]),
  );
}

export function valueAt(source = {}, path = '') {
  if (!path) return null;
  return String(path).split('.').reduce((current, part) => {
    if (!hasValue(part) || current == null) return null;
    if (Array.isArray(current)) {
      const index = Number(part);
      return Number.isInteger(index) ? current[index] : null;
    }
    return current[part];
  }, source);
}

export function firstPathValue(source = {}, paths = []) {
  for (const path of paths) {
    const value = valueAt(source, path);
    if (hasValue(value)) return { value, path };
  }
  return { value: null, path: null };
}

export function valueText(value, fallback = EMPTY_VALUE) {
  if (!hasValue(value)) return fallback;
  if (typeof value === 'boolean') return boolText(value);
  if (typeof value === 'number') return fmtNumber(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => valueText(item, '')).filter(Boolean).join(', ');
    return text || fallback;
  }
  if (isPlainObject(value)) {
    return textOrEmpty(
      value.title_sv
      || value.title
      || value.message_sv
      || value.message
      || value.reason
      || value.status
      || value.name
      || value.id,
    );
  }
  return textOrEmpty(value);
}

export function compactJsonValue(value) {
  if (!hasValue(value)) return EMPTY_VALUE;
  if (!isPlainObject(value) && !Array.isArray(value)) return valueText(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  } catch {
    return valueText(value);
  }
}

export function field(label, value, options = {}) {
  const {
    fallback = EMPTY_VALUE,
    hint = null,
    tone = null,
    format = null,
  } = options;
  return {
    label,
    value: format ? format(value) : valueText(value, fallback),
    rawValue: value,
    hint,
    tone,
  };
}

export function exposedFieldRows(source = {}, definitions = [], fallback = EMPTY_VALUE) {
  return definitions.map((definition) => {
    const { value, path } = firstPathValue(source, definition.paths || []);
    return {
      label: definition.label,
      value: definition.format ? definition.format(value) : valueText(value, fallback),
      rawValue: value,
      hint: definition.hint || path || null,
      tone: typeof definition.tone === 'function' ? definition.tone(value) : definition.tone,
    };
  });
}

export function numericTone(value) {
  const n = numberOrNull(value);
  if (n == null) return 'neutral';
  if (n > 0) return 'success';
  if (n < 0) return 'danger';
  return 'neutral';
}

export function moneyValue(value, currency = null, waiting = false) {
  if (hasValue(value)) return fmtMoney(value, currency);
  return waiting ? WAITING_BROKER : EMPTY_VALUE;
}

export function moneyText(value, currency = null, waiting = false) {
  if (waiting && !hasValue(value)) return WAITING_RUNTIME;
  return fmtMoney(value, currency);
}

export function percentText(value, digits = 2) {
  return fmtPercent(value, digits);
}

export function timeText(value) {
  return fmtTime(value);
}

export function hasAnyFieldValue(items = []) {
  return items.some((item) => hasValue(item.rawValue ?? item.value) && item.value !== EMPTY_VALUE && item.value !== UNAVAILABLE);
}

export function primitiveEntries(source = {}, { exclude = new Set(), limit = 18 } = {}) {
  if (!isPlainObject(source)) return [];
  const rows = [];
  for (const [key, value] of Object.entries(source)) {
    if (exclude.has(key) || !hasValue(value)) continue;
    if (isPlainObject(value) || Array.isArray(value)) continue;
    rows.push({ label: key, value: valueText(value), rawValue: value });
    if (rows.length >= limit) break;
  }
  return rows;
}

export function moneyField(label, source, path, currency = null, waiting = false, tone = null) {
  const { value } = firstPathValue(source, [path]);
  return field(label, value, {
    fallback: waiting ? WAITING_BROKER : EMPTY_VALUE,
    tone: tone || signedTone(value),
    hint: path,
    format: (raw) => moneyValue(raw, currency, waiting),
  });
}

export function numberField(label, source, path, waiting = false, tone = null) {
  const { value } = firstPathValue(source, [path]);
  return field(label, value, {
    fallback: waiting ? WAITING_BROKER : EMPTY_VALUE,
    tone: tone || numericTone(value),
    hint: path,
    format: (raw) => (hasValue(raw) ? fmtNumber(raw, 2) : (waiting ? WAITING_BROKER : EMPTY_VALUE)),
  });
}

export function rawField(label, source, paths, fallback = EMPTY_VALUE) {
  const { value, path } = firstPathValue(source, paths);
  return field(label, value, {
    fallback,
    hint: path || null,
    format: (raw) => raw && typeof raw === 'object' ? compactJsonValue(raw) : valueText(raw, fallback),
  });
}

export function collectMatchingFields(source = {}, matchers = [], {
  maxDepth = 6,
  maxRows = 4,
  prefix = '',
} = {}) {
  const rows = [];
  const visit = (value, path, depth) => {
    if (rows.length >= maxRows || depth > maxDepth || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 6).forEach((item, index) => visit(item, `${path}.${index}`, depth + 1));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (rows.length >= maxRows) return;
      const nextPath = path ? `${path}.${key}` : key;
      const keyMatches = matchers.some((matcher) => matcher.test(nextPath));
      if (keyMatches && hasValue(child)) {
        rows.push({
          label: key,
          value: compactJsonValue(child),
          rawValue: child,
          hint: prefix ? `${prefix}.${nextPath}` : nextPath,
        });
      }
      if (isPlainObject(child) || Array.isArray(child)) visit(child, nextPath, depth + 1);
    }
  };
  visit(source, '', 0);
  return rows;
}

export function timeField(label, value, hint = null) {
  return field(label, value, {
    hint,
    format: (raw) => fmtTime(raw),
  });
}
