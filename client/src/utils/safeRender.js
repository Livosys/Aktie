import React from 'react';

// Render-safety helpers — guarantee that an object/array/null never reaches the
// DOM as a raw React child (which throws Minified React error #31). Pure
// presentation utilities: no API calls, no trading logic, no side effects.

export const BAND_LABELS = {
  confirmed_narrow: 'Bekräftad narrow',
  weak_narrow: 'Svag narrow',
  strong_compression: 'Stark kompression',
  not_narrow: 'Inte narrow',
};

// Object-safe numeric formatter — an object/array never reaches the DOM.
export function num(v, suffix = '') {
  if (v === null || v === undefined || typeof v === 'object') return '—';
  if (typeof v === 'number' && !Number.isFinite(v)) return '—';
  return `${v}${suffix}`;
}

export function fmtPct(v, dec = 1) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return null;
  return `${n.toFixed(dec).replace('.', ',')} %`;
}

export function fmtSignedPct(v, dec = 2) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return null;
  return `${n >= 0 ? '+' : ''}${n.toFixed(dec).replace('.', ',')} %`;
}

// Render a {band, scoreRange, winRate, avgPnl}-shaped object as human text, e.g.
// "Bekräftad narrow · Win rate 52,7 % · Avg +0,08 %".
export function formatBand(b) {
  if (!b || typeof b !== 'object') return safeString(b);
  const parts = [BAND_LABELS[b.band] || (typeof b.band === 'string' ? b.band : 'Narrow')];
  if (typeof b.scoreRange === 'string') parts.push(`score ${b.scoreRange}`);
  const wr = fmtPct(b.winRate, 1);
  if (wr) parts.push(`Win rate ${wr}`);
  const ap = fmtSignedPct(b.avgPnl, 2);
  if (ap) parts.push(`Avg ${ap}`);
  return parts.join(' · ');
}

// Convert any value to a safe display string — never returns an object/array.
export function safeString(value, fallback = 'Saknas') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nej';
  if (Array.isArray(value)) {
    const joined = value.map((v) => safeString(v, '')).filter(Boolean).join(', ');
    return joined || fallback;
  }
  if (typeof value === 'object') {
    if ('band' in value || 'scoreRange' in value || ('winRate' in value && 'avgPnl' in value)) return formatBand(value);
    const id = value.strategy_id || value.strategyId || value.id || value.key || value.name || value.label;
    if (id && typeof id !== 'object') return String(id);
    return 'Detaljer finns';
  }
  return fallback;
}

// Guarantees a React-safe child: any object/array is formatted, never rendered
// raw. Written with createElement so this stays a plain .js module (no JSX).
export function SafeText({ value, fallback = 'Saknas' }) {
  return React.createElement(React.Fragment, null, safeString(value, fallback));
}
