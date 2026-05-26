'use strict';
/**
 * Market State Graph Engine
 *
 * Infers where each symbol is in the market cycle and tracks state transitions.
 * States: COMPRESSION | BREAKOUT | MOMENTUM | TREND | EXHAUSTION | REVERSAL | CHOPPY | UNKNOWN
 *
 * Per-symbol state history persisted to data/signals/state-graph/
 * Enrichment only — NEVER modifies tradeScore.
 */

const fs   = require('fs');
const path = require('path');

const STATE_DIR    = path.resolve(__dirname, '../../data/signals/state-graph');
const MAX_HISTORY  = 60;
const CACHE_TTL_MS = 30 * 1000;

const STATE = {
  COMPRESSION: 'COMPRESSION',
  BREAKOUT:    'BREAKOUT',
  MOMENTUM:    'MOMENTUM',
  TREND:       'TREND',
  EXHAUSTION:  'EXHAUSTION',
  REVERSAL:    'REVERSAL',
  CHOPPY:      'CHOPPY',
  UNKNOWN:     'UNKNOWN',
};

// Transition probabilities: from → { to: weight 0-100 }
const TRANSITION_MATRIX = {
  COMPRESSION: { BREAKOUT: 30, CHOPPY: 38, COMPRESSION: 22, MOMENTUM: 10 },
  BREAKOUT:    { MOMENTUM: 35, EXHAUSTION: 45, CHOPPY: 20 },
  MOMENTUM:    { TREND: 40, EXHAUSTION: 42, REVERSAL: 18 },
  TREND:       { EXHAUSTION: 50, REVERSAL: 30, TREND: 20 },
  EXHAUSTION:  { REVERSAL: 38, CHOPPY: 37, COMPRESSION: 25 },
  REVERSAL:    { COMPRESSION: 45, CHOPPY: 35, TREND: 20 },
  CHOPPY:      { COMPRESSION: 40, CHOPPY: 38, BREAKOUT: 22 },
  UNKNOWN:     { COMPRESSION: 40, CHOPPY: 40, UNKNOWN: 20 },
};

const STATE_SV = {
  COMPRESSION: 'Komprimering — marknaden bygger upp energi',
  BREAKOUT:    'Utbrott — aktiv rörelse pågår',
  MOMENTUM:    'Momentum — bekräftad rörelse med styrka',
  TREND:       'Trend — uthållig riktningsrörelse',
  EXHAUSTION:  'Utmattning — rörelseenergi avtar',
  REVERSAL:    'Vändning — riktningsändring pågår',
  CHOPPY:      'Choppig — motstridig och svårläst marknad',
  UNKNOWN:     'Okänd marknadsfas',
};

// Per-symbol in-memory cache { symbol → { history, loadedAt } }
const _cache = new Map();

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function stateFilePath(symbol) {
  return path.join(STATE_DIR, `${symbol.toUpperCase()}.json`);
}

function loadHistory(symbol) {
  const cached = _cache.get(symbol);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.history;
  try {
    const p = stateFilePath(symbol);
    if (!fs.existsSync(p)) { _cache.set(symbol, { history: [], loadedAt: Date.now() }); return []; }
    const history = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cache.set(symbol, { history, loadedAt: Date.now() });
    return history;
  } catch {
    _cache.set(symbol, { history: [], loadedAt: Date.now() });
    return [];
  }
}

function saveHistory(symbol, history) {
  ensureDir();
  const trimmed = history.slice(-MAX_HISTORY);
  try { fs.writeFileSync(stateFilePath(symbol), JSON.stringify(trimmed), 'utf8'); } catch { /* non-fatal */ }
  _cache.set(symbol, { history: trimmed, loadedAt: Date.now() });
}

// ── State Inference ───────────────────────────────────────────────────────────

function inferState(result) {
  const {
    breakoutAlreadyOccurred = false,
    eventType               = '',
    tradeScore              = 0,
    marketRegime            = '',
    narrowType              = '',
    narrowScore             = 0,
    relVol20                = 1,
    rsi14                   = 50,
    colorChange             = false,
    slope20Atr              = 0,
    mtfAlignment            = false,
    autoFilter,
    fatigueContext,
    preMoveContext,
  } = result;

  const fatigueScore        = fatigueContext?.fatigueScore   ?? 0;
  const compressionStrength = preMoveContext?.compressionStrength ?? 0;
  const regime = (marketRegime || '').toUpperCase();

  // EXHAUSTION — highest priority
  if (breakoutAlreadyOccurred || fatigueScore >= 68) {
    return { state: STATE.EXHAUSTION, confidence: breakoutAlreadyOccurred ? 90 : 72 };
  }

  // REVERSAL — color change + extreme RSI + slope reversal
  if (colorChange && (rsi14 > 78 || rsi14 < 22) && Math.abs(slope20Atr) > 0.25) {
    return { state: STATE.REVERSAL, confidence: 68 };
  }

  // BREAKOUT — fresh breakout event with volume
  const isBreakoutEvent = /breakout|attack_200|bull_break|bear_break|elephant/i.test(eventType);
  if (isBreakoutEvent && relVol20 >= 1.15 && !breakoutAlreadyOccurred) {
    const conf = Math.min(60 + (relVol20 - 1.15) * 40, 90);
    return { state: STATE.BREAKOUT, confidence: Math.round(conf) };
  }

  // MOMENTUM — high score + aligned MTF + volume
  if (tradeScore >= 70 && mtfAlignment && relVol20 >= 1.25) {
    return { state: STATE.MOMENTUM, confidence: Math.min(60 + tradeScore * 0.3, 90) };
  }

  // TREND — trending regime + above-average score
  const isTrendRegime = /BULLISH_TREND|BEARISH_TREND|TREND_DAY_UP|TREND_DAY_DOWN/.test(regime);
  if (isTrendRegime && tradeScore >= 50) {
    return { state: STATE.TREND, confidence: 62 + Math.min(tradeScore * 0.1, 15) };
  }

  // COMPRESSION — narrow patterns or high compression score
  const isNarrow = ['coil_flat', 'HIGH_QUALITY_NARROW', 'coil_pullback', 'attack_200'].includes(narrowType);
  if (compressionStrength >= 48 || (isNarrow && narrowScore >= 30)) {
    const conf = compressionStrength >= 48
      ? Math.min(50 + compressionStrength * 0.35, 85)
      : 55 + narrowScore * 0.4;
    return { state: STATE.COMPRESSION, confidence: Math.min(Math.round(conf), 85) };
  }

  // CHOPPY — choppy regime or blocked + low score
  const isChoppyRegime = /CHOPPY|RANGE_DAY/.test(regime);
  if (isChoppyRegime || (autoFilter?.blocked && tradeScore < 45)) {
    return { state: STATE.CHOPPY, confidence: 50 };
  }

  if (tradeScore < 30) return { state: STATE.CHOPPY, confidence: 42 };
  return { state: STATE.UNKNOWN, confidence: 28 };
}

// ── Cycle Position ────────────────────────────────────────────────────────────

function getCyclePosition(history, currentState) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].state === currentState) count++;
    else break;
  }
  if (count <= 2) return 'early';
  if (count <= 5) return 'mid';
  return 'late';
}

// ── Expected Next State ───────────────────────────────────────────────────────

function getTransitions(currentState, cyclePosition) {
  const base = { ...(TRANSITION_MATRIX[currentState] || TRANSITION_MATRIX.UNKNOWN) };

  if (cyclePosition === 'late' && base[currentState]) {
    const boost = Object.entries(base)
      .filter(([k]) => k !== currentState)
      .sort((a, b) => b[1] - a[1])[0];
    if (boost) {
      base[boost[0]] = Math.min(100, boost[1] + 15);
      base[currentState] = Math.max(0, base[currentState] - 15);
    }
  }

  const expectedNextState = Object.entries(base).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';
  return { expectedNextState, transitionProbabilities: base };
}

// ── Actionable Insight ────────────────────────────────────────────────────────

function buildInsight(state, cyclePosition, prevState) {
  if (state === STATE.COMPRESSION) {
    if (cyclePosition === 'late') return 'Lång komprimering — utbrott eller breakdown nära.';
    if (cyclePosition === 'mid')  return 'Komprimering pågår — vänta på trigger.';
    return 'Ny komprimering — energi byggs upp.';
  }
  if (state === STATE.BREAKOUT) {
    if (cyclePosition === 'early') return 'Tidigt utbrott — bevaka om momentum bekräftas.';
    if (cyclePosition === 'mid')   return 'Utbrott pågår — följ med om volymen håller.';
    return 'Sent utbrott — fakeout-risk ökar.';
  }
  if (state === STATE.MOMENTUM) {
    if (cyclePosition === 'early') return 'Tidigt momentum — starkaste fasen för entries.';
    if (cyclePosition === 'mid')   return 'Momentum håller — continuation trolig.';
    return 'Sent momentum — utmattning börjar synas.';
  }
  if (state === STATE.TREND) {
    if (cyclePosition === 'late') return 'Sen trend — utmattning trolig, skärp stoploss.';
    return 'Trend håller — följ med på pullbacks.';
  }
  if (state === STATE.EXHAUSTION)  return 'Utmattning — undvik nya positioner, vänta på reset.';
  if (state === STATE.REVERSAL)    return 'Vändning pågår — hög risk att gå mot trenden.';
  if (state === STATE.CHOPPY)      return 'Choppig marknad — högt brus, låg edge.';
  return STATE_SV[state] || '';
}

// ── Main Apply Function ───────────────────────────────────────────────────────

function applyStateGraph(result) {
  if (!result?.symbol) return { ...result, stateGraph: null };

  try {
    const symbol  = result.symbol;
    const history = loadHistory(symbol);

    const { state, confidence } = inferState(result);
    const prevEntry  = history[history.length - 1] ?? null;
    const prevState  = prevEntry?.state ?? null;

    let barsSinceTransition = 1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].state === state) barsSinceTransition++;
      else break;
    }

    const cyclePosition = getCyclePosition(history, state);
    const { expectedNextState, transitionProbabilities } = getTransitions(state, cyclePosition);

    // Persist
    saveHistory(symbol, [...history, { state, confidence: Math.round(confidence), ts: Date.now() }]);

    const stateGraph = {
      currentState:           state,
      stateConfidence:        Math.round(confidence),
      prevState,
      barsSinceTransition,
      cyclePosition,
      expectedNextState,
      transitionProbabilities,
      actionableInsight:      buildInsight(state, cyclePosition, prevState),
      explanationSv:          STATE_SV[state],
    };

    return { ...result, stateGraph };
  } catch {
    return { ...result, stateGraph: null };
  }
}

module.exports = { applyStateGraph, STATE };
