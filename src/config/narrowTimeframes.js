'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Narrow Timeframe Standard (Goal 7)
//
// Central, single source of truth for the Narrow State-first timeframe standard.
// The new default is 1m / 2m / 5m / 10m for short daytrading-focused learning.
// 15m is NO LONGER a default — it stays available only as a legacy/optional tf.
//
// HONESTY RULE: the system must never fabricate candle data. A timeframe counts
// as "available" only when there is REAL candle data the batch loader can serve
// correctly for it. Today marketDataStore.loadCandles only correctly serves the
// 2m store (passing other timeframes silently returns mislabeled 2m bars), so
// detection treats 2m as the safe runnable base and reports the rest as missing
// — distinguishing "present on disk but not wired into the loader" (e.g. 5m/15m)
// from "absent, would need import/aggregation" (e.g. 1m/10m).
// ────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// Current standard for Narrow State-first learning (autopilot / batch / replay).
// FOCUSED ON 2m for now: it is the only timeframe that is stably available and
// loadable today, which keeps the first Narrow State learning runs simple and
// stable (no missing-timeframe noise). 1m/5m/10m are kept as optional future
// timeframes and can be promoted once their data sources are fully wired.
const NARROW_DEFAULT_TIMEFRAMES = Object.freeze(['2m']);

// Optional future timeframes — NOT default yet, not shown as "missing" in the
// standard plan. 1m needs a clean source, 5m needs loader wiring, 10m needs
// aggregation from 2m. See detectNarrowTimeframeAvailability for status.
const OPTIONAL_FUTURE_TIMEFRAMES = Object.freeze(['1m', '5m', '10m']);

// 15m is intentionally NOT a default. Kept here as optional/legacy only.
const LEGACY_OPTIONAL_TIMEFRAMES = Object.freeze(['15m']);

// The timeframe the batch loader (marketDataStore.loadCandles) can serve today
// with a real, distinct dataset. Everything else is either present-but-unwired
// or absent. 'raw' is ~1m but irregular, so it is not treated as a clean 1m.
const LOADER_RUNNABLE_TIMEFRAMES = Object.freeze(['2m']);

// Base data dir (env-overridable so tests can isolate). Mirrors the layout used
// by marketDataStore: <data>/market-data/candles-<tf>/<SYMBOL>/<date>.jsonl
function dataRoot() {
  return path.resolve(process.env.NARROW_DATA_DIR || path.resolve(__dirname, '../../data'));
}

function candleDirFor(timeframe) {
  return path.join(dataRoot(), 'market-data', `candles-${timeframe}`);
}

// Does a given timeframe have at least one real candle date-file for any of the
// requested symbols? (Read-only, never creates anything, never fakes.)
function timeframeHasDataOnDisk(timeframe, symbols) {
  const base = candleDirFor(timeframe);
  let exists = false;
  for (const raw of symbols || []) {
    const symbol = String(raw || '').trim().toUpperCase();
    if (!symbol) continue;
    const dir = path.join(base, symbol);
    try {
      if (!fs.existsSync(dir)) continue;
      const hit = fs.readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      if (hit) { exists = true; break; }
    } catch (_) { /* ignore unreadable dir */ }
  }
  return exists;
}

// Honest availability report for the requested timeframes.
//
// Returns:
//   requested        — the timeframes we want (defaults to the new standard)
//   available         — timeframes the batch can safely RUN today (loader-served + on disk)
//   missing           — requested timeframes that are NOT safely runnable
//   presentNotWired   — real candle data exists on disk but loader does not expose it
//   absent            — no candle source at all (needs import/aggregation)
//   aggregatable      — timeframes that could be cleanly aggregated from a base tf
//   warnings          — machine-readable notes (e.g. missing_timeframe:1m)
//   details           — per-timeframe status for display/reporting
function detectNarrowTimeframeAvailability(symbols, requested = NARROW_DEFAULT_TIMEFRAMES) {
  const req = (Array.isArray(requested) && requested.length ? requested : NARROW_DEFAULT_TIMEFRAMES)
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  const has2mOnDisk = timeframeHasDataOnDisk('2m', symbols);
  const details = {};
  const available = [];
  const missing = [];
  const presentNotWired = [];
  const absent = [];
  const aggregatable = [];
  const warnings = [];

  for (const tf of req) {
    const onDisk = timeframeHasDataOnDisk(tf, symbols);
    const loaderSupported = LOADER_RUNNABLE_TIMEFRAMES.includes(tf);
    const runnable = onDisk && loaderSupported;

    let status;
    if (runnable) {
      status = 'available';
      available.push(tf);
    } else if (onDisk && !loaderSupported) {
      // Real data exists (e.g. candles-5m / candles-15m) but loadCandles only
      // serves 2m, so running it would mislabel 2m as this tf. Not safe yet.
      status = 'present_not_wired';
      presentNotWired.push(tf);
      missing.push(tf);
      warnings.push(`timeframe_present_not_wired:${tf}`);
    } else {
      // No candle source for this tf at all.
      status = 'absent';
      absent.push(tf);
      missing.push(tf);
      warnings.push(`missing_timeframe:${tf}`);
      // 10m can be cleanly aggregated from 2m (5×2m); 5m cannot from 2m alone.
      if (tf === '10m' && has2mOnDisk) { aggregatable.push(tf); }
    }
    details[tf] = { status, onDisk, loaderSupported, runnable };
  }

  // Safety net: the autopilot must always have a runnable base. 2m is the known
  // working timeframe; if detection found nothing runnable, fall back to 2m so
  // plans stay valid. (This selects a timeframe — it never fabricates candles;
  // the batch still logs missing_candles at run time if 2m data is truly absent.)
  if (!available.length) {
    available.push('2m');
    if (missing.includes('2m')) {
      const i = missing.indexOf('2m');
      if (i >= 0) missing.splice(i, 1);
    }
    warnings.push('no_runnable_timeframe_detected_defaulting_2m');
    details['2m'] = details['2m'] || { status: 'default_fallback', onDisk: has2mOnDisk, loaderSupported: true, runnable: has2mOnDisk };
  }

  return {
    requested: req,
    available,
    missing,
    presentNotWired,
    absent,
    aggregatable,
    warnings,
    details,
  };
}

module.exports = {
  NARROW_DEFAULT_TIMEFRAMES,
  OPTIONAL_FUTURE_TIMEFRAMES,
  LEGACY_OPTIONAL_TIMEFRAMES,
  LOADER_RUNNABLE_TIMEFRAMES,
  detectNarrowTimeframeAvailability,
  timeframeHasDataOnDisk,
};
