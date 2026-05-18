'use strict';
const fs   = require('fs');
const path = require('path');

const ENABLED    = process.env.FEATURE_LOGGING_ENABLED === 'true';
const LOG_DIR    = path.resolve(__dirname, '../../data/feature-logs');
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ── Internals ─────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function todayPath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${date}.jsonl`);
}

function pruneOldLogs() {
  try {
    ensureDir();
    const cutoff = Date.now() - MAX_AGE_MS;
    fs.readdirSync(LOG_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .forEach((f) => {
        const ts = new Date(f.replace('.jsonl', '')).getTime();
        if (!isNaN(ts) && ts < cutoff) {
          fs.unlinkSync(path.join(LOG_DIR, f));
          console.log(`[FeatureLogger] Pruned: ${f}`);
        }
      });
  } catch (err) {
    console.warn('[FeatureLogger] Pruning failed:', err.message);
  }
}

function toEntry(result, group) {
  const tfs = result.threeFingerSpread || {};
  const eb  = result.elephantBar       || {};
  const cc  = result.colorChange       || {};
  const pb  = result.pullback          || {};

  return {
    timestamp:               new Date().toISOString(),
    symbol:                  result.symbol,
    price:                   result.price              ?? null,
    timeframe:               '2m',
    group:                   group                     || 'unknown',
    state:                   result.state              ?? null,
    signal:                  result.signal             ?? null,
    eventType:               result.eventType          ?? null,
    actionSv:                result.actionSv           ?? null,
    narrowType:              result.narrowType          ?? null,
    narrowScore:             result.narrowScore         ?? null,
    tradeScore:              result.tradeScore          ?? null,
    scoreLabel:              result.scoreLabel          ?? null,
    scores:                  result.scores             ?? null,
    scoreExplanationSv:      result.scoreExplanationSv ?? null,
    reasonSv:                result.reasonSv           ?? null,
    marketRegime:            result.marketRegime        ?? null,
    marketDirection:         result.marketDirection     ?? null,
    marketScore:             result.marketScore         ?? null,
    marketReasonSv:          result.marketReasonSv      ?? null,
    smaGapAtr:               result.smaGapAtr           ?? null,
    priceToZoneAtr:          result.priceToZoneAtr      ?? null,
    priceToSma20Atr:         result.priceToSma20Atr     ?? null,
    rangeCompression:        result.rangeCompression    ?? null,
    nr7:                     result.nr7                 ?? null,
    relVol20:                result.relVol20            ?? null,
    atrPct120:               result.atrPct120           ?? null,
    bbwPct120:               result.bbwPct120           ?? null,
    tfsActive:               tfs.active                || false,
    breakoutAlreadyOccurred: result.breakoutAlreadyOccurred || false,
    elephantBarActive:       eb.active                 || false,
    colorChangeActive:       cc.active                 || false,
    pullbackActive:          pb.active                 || false,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Appends one JSONL line per result to today's log file.
 * Silent on errors — never crashes the scanner.
 */
function logResults(results, group) {
  if (!ENABLED) return;
  if (!results || results.length === 0) return;
  try {
    ensureDir();
    const lines = results.map((r) => JSON.stringify(toEntry(r, group))).join('\n') + '\n';
    fs.appendFileSync(todayPath(), lines, 'utf8');
  } catch (err) {
    console.warn('[FeatureLogger] Write failed:', err.message);
  }
}

/**
 * Returns up to `limit` most-recent log entries (newest first).
 * Optionally filtered by symbol.
 */
function readLatest(symbolFilter, limit = 100) {
  const cap     = Math.max(1, Math.min(limit, 500));
  const entries = [];

  try {
    ensureDir();
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse(); // newest date first

    for (const file of files) {
      if (entries.length >= cap) break;
      try {
        const raw   = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        // Iterate from bottom of file — last-written = most recent
        for (let i = lines.length - 1; i >= 0; i--) {
          if (entries.length >= cap) break;
          try {
            const entry = JSON.parse(lines[i]);
            if (!symbolFilter || entry.symbol === symbolFilter) {
              entries.push(entry);
            }
          } catch { /* skip malformed lines */ }
        }
      } catch (fileErr) {
        console.warn(`[FeatureLogger] Read error in ${file}:`, fileErr.message);
      }
    }
  } catch (err) {
    console.warn('[FeatureLogger] readLatest failed:', err.message);
  }

  return entries;
}

// Prune old logs once at startup (only if logging is enabled)
if (ENABLED) {
  try { pruneOldLogs(); } catch (_) {}
}

module.exports = { logResults, readLatest };
