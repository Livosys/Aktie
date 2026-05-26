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
  THREE_FINGER_SPREAD_AVOID: 'För utsträckt rörelse',
  UNKNOWN: 'Oklassad',
};

const SIGNAL_FAMILY_DESCRIPTIONS = {
  EMA_TREND_PULLBACK: 'Priset ligger nära korta EMA-nivåer och 2m börjar stödja riktningen.',
  VWAP_RECLAIM_REJECTION: 'Priset testar VWAP och systemet bevakar om nivån håller eller avvisas.',
  BREAKOUT_RETEST: 'Priset har brutit ut och testar om nivån håller vid återtest.',
  NARROW_COMPRESSION: 'Priset är ihoptryckt och systemet väntar på tydligare rörelse.',
  LATE_MOVE_BLOCK: 'Rörelsen ser sen ut och systemet vill inte jaga ett utsträckt läge.',
  UNKNOWN: 'Systemet ser inget rent EMA- eller VWAP-läge just nu.',
};

const CALIBRATION_EDGE_LABELS = {
  strong: 'Stark historik',
  moderate: 'Lovande historik',
  neutral: 'Neutral historik',
  weak: 'Svag historik',
  unknown: 'Okänd historik',
};

const CALIBRATION_BIAS_LABELS = {
  raise_to_watch: 'Kan bevakas extra',
  raise_to_caution: 'Kan vara nära men försiktig',
  keep: 'Behåll nuvarande nivå',
  lower: 'Var försiktig',
};

function normalizeKey(value) {
  return String(value || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
}

function normalizeLowerKey(value) {
  return String(value || 'unknown').trim().toLowerCase() || 'unknown';
}

export function signalFamilyLabel(value) {
  const key = normalizeKey(value);
  return SIGNAL_FAMILY_LABELS[key] || key;
}

export function signalSubtypeLabel(value) {
  const key = normalizeKey(value);
  return SIGNAL_SUBTYPE_LABELS[key] || key;
}

export function signalFamilyDescription(value) {
  const key = normalizeKey(value);
  return SIGNAL_FAMILY_DESCRIPTIONS[key] || 'Systemet har klassat läget, men saknar en färdig svensk beskrivning.';
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
  return reason;
}

export function signalFamilyDebugReason(familyDebug, family) {
  const attempts = familyDebug?.attemptedFamilies;
  if (!attempts || typeof attempts !== 'object') return '';

  const key = normalizeKey(family);
  const sourceAttempts = key !== 'UNKNOWN' && attempts[key]
    ? [attempts[key]]
    : Object.values(attempts);

  const reasons = sourceAttempts
    .flatMap((attempt) => attempt?.failedReasons || [])
    .map(compactFailureReason)
    .filter(Boolean);

  const uniqueReasons = [...new Set(reasons)].slice(0, 3);
  if (!uniqueReasons.length) return '';

  if (key === 'UNKNOWN') {
    return `Signaltypen är oklassad eftersom ${uniqueReasons.join(' och ')}.`;
  }
  return `Klassningen bygger på att ${uniqueReasons.join(' och ')}.`;
}

export function signalFamilyTone(value) {
  return normalizeKey(value) === 'UNKNOWN' ? 'neutral' : 'classified';
}

export function calibrationEdgeLabel(value) {
  const key = normalizeLowerKey(value);
  return CALIBRATION_EDGE_LABELS[key] || CALIBRATION_EDGE_LABELS.unknown;
}

export function calibrationPriorityBiasLabel(value) {
  const key = normalizeLowerKey(value);
  return CALIBRATION_BIAS_LABELS[key] || CALIBRATION_BIAS_LABELS.keep;
}

export function calibrationEdgeTone(value) {
  const key = normalizeLowerKey(value);
  if (key === 'strong' || key === 'moderate') return 'strong';
  if (key === 'weak') return 'weak';
  if (key === 'neutral') return 'neutral';
  return 'unknown';
}

export function familyCalibrationMeta(hints = {}) {
  return {
    historicalEdge: normalizeLowerKey(hints.historicalEdge),
    edgeLabel: calibrationEdgeLabel(hints.historicalEdge),
    edgeTone: calibrationEdgeTone(hints.historicalEdge),
    reasonSv: hints.reasonSv || 'Ingen separat familjekalibrering används för den här kandidaten.',
    suggestedPriorityBias: normalizeLowerKey(hints.suggestedPriorityBias || 'keep'),
    priorityBiasLabel: calibrationPriorityBiasLabel(hints.suggestedPriorityBias),
    source: hints.source || 'Signal Family Calibration v2',
  };
}

export function signalFamilyMeta({ signalFamily, signalSubtype, signalFamilyReasonSv, familyDebug } = {}) {
  const family = normalizeKey(signalFamily);
  const subtype = normalizeKey(signalSubtype);
  return {
    family,
    subtype,
    familyLabel: signalFamilyLabel(family),
    subtypeLabel: signalSubtypeLabel(subtype),
    description: signalFamilyDescription(family),
    debugReason: signalFamilyDebugReason(familyDebug, family) || signalFamilyReasonSv || '',
    tone: signalFamilyTone(family),
  };
}
