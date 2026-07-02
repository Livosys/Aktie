'use strict';

// ---------------------------------------------------------------------------
// Exit Reason Normalizer — READ-ONLY analysis/enrich helper
// ---------------------------------------------------------------------------
// Legacy static paper exits (checkExit/checkHardExit/checkTimeoutExit) write
// only `exitReason` (STOP_HIT / TARGET_HIT / TIMEOUT) and leave the modern
// triad (exitReasonCode / exitReasonSv / exitSource) null. Modern exit-engine
// exits write `exitReasonCode` (+ exitSource='exit_engine_v1'). When analyses
// bucket purely on `exitReasonCode`, all legacy exits collapse into a single
// misleading "None"/"default" bucket.
//
// This helper produces an ENRICHED COPY with additional analysis-only fields
// (normalizedExitReasonCode / normalizedExitSource / normalizedExitReasonLabel)
// so read-layer buckets are correct. It NEVER mutates the input, NEVER changes
// exit behaviour, and is not used by the exit engine or any close path.
// ---------------------------------------------------------------------------

const LEGACY_EXIT_REASON_MAP = Object.freeze({
  STOP_HIT: 'stop_hit',
  TARGET_HIT: 'target_hit',
  TIMEOUT: 'timeout',
});

const EXIT_REASON_LABELS = Object.freeze({
  stop_hit: 'Stop loss',
  target_hit: 'Target hit',
  timeout: 'Timeout',
  timeout_intelligence: 'Timeout (intelligence)',
  tightened_stop: 'Tightened stop',
  momentum_fade: 'Momentum fade',
  near_target_profit: 'Near target profit',
  near_target_pullback: 'Near target pullback',
  break_even: 'Break even',
  unknown: 'Okänd',
});

function nonEmpty(v) {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== '' && s.toLowerCase() !== 'none';
}

function labelFor(code) {
  if (EXIT_REASON_LABELS[code]) return EXIT_REASON_LABELS[code];
  if (!code || code === 'unknown') return EXIT_REASON_LABELS.unknown;
  return String(code)
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Returns a shallow enriched COPY of `trade`. Original exit fields are
// preserved untouched; only analysis-only `normalized*` fields are added.
function normalizeExitReasonFields(trade) {
  const t = trade && typeof trade === 'object' ? trade : {};

  const existingCode = nonEmpty(t.exitReasonCode) ? String(t.exitReasonCode).trim() : null;
  const legacyReason = nonEmpty(t.exitReason) ? String(t.exitReason).trim().toUpperCase() : null;

  let normalizedExitReasonCode;
  let normalizedExitSource;

  if (existingCode) {
    // Modern record already carries an explicit code — keep it and its source.
    normalizedExitReasonCode = existingCode;
    normalizedExitSource = nonEmpty(t.exitSource) ? String(t.exitSource) : 'exit_engine_v1';
  } else if (legacyReason && LEGACY_EXIT_REASON_MAP[legacyReason]) {
    // Legacy static exit (STOP_HIT / TARGET_HIT / TIMEOUT).
    normalizedExitReasonCode = LEGACY_EXIT_REASON_MAP[legacyReason];
    normalizedExitSource = 'legacy_static_exit';
  } else if (legacyReason && legacyReason.startsWith('EXIT_ENGINE_')) {
    // Defensive: engine exit whose code field was not persisted.
    normalizedExitReasonCode = legacyReason.replace(/^EXIT_ENGINE_/, '').toLowerCase() || 'unknown';
    normalizedExitSource = nonEmpty(t.exitSource) ? String(t.exitSource) : 'exit_engine_v1';
  } else {
    normalizedExitReasonCode = 'unknown';
    normalizedExitSource = nonEmpty(t.exitSource) ? String(t.exitSource) : 'unknown';
  }

  return {
    ...t,
    // Preserve original fields explicitly (present even if the source lacked them).
    exitReason: t.exitReason ?? null,
    exitReasonCode: t.exitReasonCode ?? null,
    exitReasonSv: t.exitReasonSv ?? null,
    exitSource: t.exitSource ?? null,
    // Analysis-only additions.
    normalizedExitReasonCode,
    normalizedExitSource,
    normalizedExitReasonLabel: labelFor(normalizedExitReasonCode),
  };
}

module.exports = {
  normalizeExitReasonFields,
  LEGACY_EXIT_REASON_MAP,
  EXIT_REASON_LABELS,
};
