'use strict';

const SIGNAL_FAMILY_LABELS = {
  EMA_TREND_PULLBACK: 'EMA Trend-rekyl',
  VWAP_RECLAIM_REJECTION: 'VWAP Test/Reclaim',
  BREAKOUT_RETEST: 'Utbrott + återtest',
  NARROW_COMPRESSION: 'Ihoptryckt pris',
  LATE_MOVE_BLOCK: 'Sen rörelse',
  UNKNOWN: 'Oklassad',
};

const SIGNAL_SUBTYPE_LABELS = {
  EMA_PULLBACK_UP: 'EMA-rekyl uppåt',
  EMA_PULLBACK_DOWN: 'EMA-rekyl nedåt',
  VWAP_RECLAIM_UP: 'VWAP återtaget uppåt',
  VWAP_REJECTION_DOWN: 'VWAP avvisning nedåt',
  REGULAR_PULLBACK: 'Vanlig rekyl',
  NARROW_WAIT: 'Narrow vänteläge',
  NARROW_BULL_ENTRY: 'Narrow utbrott uppåt',
  NARROW_BEAR_ENTRY: 'Narrow utbrott nedåt',
  WIDE_REVERSAL_WATCH: 'Vändningsläge i sen rörelse',
  THREE_FINGER_SPREAD_AVOID: 'För utsträckt rörelse',
  UNKNOWN: 'Oklassad',
};

function normalizeKey(value) {
  return String(value || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
}

function signalFamilyLabel(value) {
  const key = normalizeKey(value);
  return SIGNAL_FAMILY_LABELS[key] || null;
}

function signalSubtypeLabel(value) {
  const key = normalizeKey(value);
  return SIGNAL_SUBTYPE_LABELS[key] || null;
}

function compactFailureReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (text.includes('2m') || text.includes('candle-score')) return '2m gav inte tydlig bekräftelse';
  if (text.includes('volym')) return 'volymen var svag';
  if (text.includes('gammal')) return 'data var gammal';
  if (text.includes('extrem')) return 'rörelsen var för utsträckt';
  if (text.includes('rekylzon') || text.includes('ema/vwap')) return 'priset låg inte rent i rekylzonen';
  if (text.includes('vwap')) return 'priset låg inte nära nog VWAP';
  if (text.includes('trendstöd') || text.includes('tidsramar')) return 'större tidsramar gav inte tillräckligt stöd';
  if (text.includes('riktningen')) return 'riktningen var inte tydlig';
  return String(reason || '').trim();
}

function signalFamilyDebugSummarySv(familyDebug, family) {
  const attempts = familyDebug?.attemptedFamilies;
  if (!attempts || typeof attempts !== 'object') return null;

  const key = normalizeKey(family);
  const sourceAttempts = key !== 'UNKNOWN' && attempts[key]
    ? [attempts[key]]
    : Object.values(attempts);

  const reasons = sourceAttempts
    .flatMap((attempt) => attempt?.failedReasons || [])
    .map(compactFailureReason)
    .filter(Boolean);

  const uniqueReasons = [...new Set(reasons)].slice(0, 3);
  if (!uniqueReasons.length) return null;

  if (key === 'UNKNOWN') {
    return `Signaltypen är oklassad eftersom ${uniqueReasons.join(' och ')}.`;
  }
  return `Klassningen bygger på att ${uniqueReasons.join(' och ')}.`;
}

module.exports = {
  signalFamilyLabel,
  signalSubtypeLabel,
  signalFamilyDebugSummarySv,
};
