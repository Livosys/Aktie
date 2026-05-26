'use strict';
/**
 * Confidence Decay Engine
 *
 * Penalizes signals that stay static over consecutive scan ticks.
 * A "stale" signal (same state/eventType/narrowType for 5+ ticks) gets
 * a progressive score reduction — this prevents old setups from appearing
 * fresh when they have been sitting unchanged for 2-5+ minutes.
 *
 * Enrichment: adds `decayContext` to each result.
 * Score impact: subtracts decay penalty from tradeScore (max -8).
 * Hard-block safety caps re-applied after any adjustment.
 *
 * SAFETY CONTRACT: TFS→10, BOC→20, blocked→20 always enforced.
 */

const fs   = require('fs');
const path = require('path');

const DECAY_DIR     = path.resolve(__dirname, '../../data/signals/decay-state');
const CACHE_TTL_MS  = 25 * 1000;  // slightly under scan interval
const MAX_DECAY     = -8;
const STALE_START   = 5;   // ticks before decay begins
const DECAY_RATE    = -2;  // points per DECAY_STEP ticks
const DECAY_STEP    = 2;   // ticks between each penalty step

// Per-symbol in-memory cache { symbol → { state, loadedAt } }
const _cache = new Map();

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(DECAY_DIR)) fs.mkdirSync(DECAY_DIR, { recursive: true });
}

function decayFilePath(symbol) {
  return path.join(DECAY_DIR, `${symbol.toUpperCase()}.json`);
}

function loadDecayState(symbol) {
  const cached = _cache.get(symbol);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.state;
  try {
    const p = decayFilePath(symbol);
    if (!fs.existsSync(p)) { _cache.set(symbol, { state: null, loadedAt: Date.now() }); return null; }
    const state = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cache.set(symbol, { state, loadedAt: Date.now() });
    return state;
  } catch {
    return null;
  }
}

function saveDecayState(symbol, state) {
  ensureDir();
  try { fs.writeFileSync(decayFilePath(symbol), JSON.stringify(state), 'utf8'); } catch { /* non-fatal */ }
  _cache.set(symbol, { state, loadedAt: Date.now() });
}

// ── Hard-block caps ───────────────────────────────────────────────────────────

function applyHardCaps(result, score) {
  if (result?.autoFilter?.blocked)     score = Math.min(score, 20);
  if (result?.tfs?.active)             score = Math.min(score, 10);
  if (result?.breakoutAlreadyOccurred) score = Math.min(score, 20);
  return Math.max(0, Math.min(100, score));
}

// ── Signal fingerprint ────────────────────────────────────────────────────────

function fingerprint(result) {
  return [
    result.state         || '',
    result.eventType     || '',
    result.narrowType    || '',
    result.signal        || '',
  ].join('|');
}

// ── Apply Decay ───────────────────────────────────────────────────────────────

function applyConfidenceDecay(result) {
  if (!result?.symbol) return { ...result, decayContext: null };

  const symbol = result.symbol;
  // Only apply decay to actual trade signals
  if (!result.price || result.state === 'NO_TRADE') {
    return { ...result, decayContext: { stale: false, ticks: 0, penalty: 0 } };
  }

  try {
    const prev     = loadDecayState(symbol);
    const fp       = fingerprint(result);
    const now      = Date.now();

    let ticks      = 1;
    let firstSeen  = now;

    if (prev && prev.fingerprint === fp) {
      ticks     = (prev.ticks || 0) + 1;
      firstSeen = prev.firstSeen || now;
    }

    // Compute penalty
    let penalty = 0;
    if (ticks >= STALE_START) {
      const stepsOver = Math.floor((ticks - STALE_START) / DECAY_STEP);
      penalty = Math.max(MAX_DECAY, stepsOver * DECAY_RATE);
    }

    const stale = ticks >= STALE_START;
    const decayMinutes = Math.round((now - firstSeen) / 60000);

    // Save new state
    saveDecayState(symbol, { fingerprint: fp, ticks, firstSeen, lastSeen: now });

    // Apply penalty to tradeScore
    let finalScore = result.tradeScore;
    if (penalty < 0 && result.tradeScore > 0) {
      finalScore = applyHardCaps(result, result.tradeScore + penalty);
    }

    const decayContext = {
      stale,
      ticks,
      penalty,
      decayMinutes,
      explanationSv: stale
        ? `Signal oförändrad i ${ticks} tick${ticks !== 1 ? 's' : ''} (~${decayMinutes} min) — konfidens reducerad med ${Math.abs(penalty)} p.`
        : null,
    };

    return {
      ...result,
      tradeScore:   finalScore,
      decayContext,
    };
  } catch {
    return { ...result, decayContext: null };
  }
}

module.exports = { applyConfidenceDecay };
