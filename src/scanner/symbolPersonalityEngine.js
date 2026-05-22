'use strict';
/**
 * Symbol Personality Engine v1
 *
 * Builds per-symbol behavioral profiles from historical outcomes + signals.
 * Each profile captures: win rate, continuation tendency, volatility level,
 * fakeout rate, best/worst regimes, best UTC hours, and a personality label.
 *
 * During live scans, applySymbolPersonality() reads the cached profile and
 * applies a small adaptive score adjustment + attaches personality metadata.
 *
 * Safety contract:
 *   Hard-blocked signals (TFS, breakoutAlreadyOccurred, autoFilter.blocked)
 *   receive NO score boost — only metadata is attached.
 *   Max adjustment: ±8 points.
 *   confidence = 'low' (< 100 outcomes) → adjustment = 0.
 */

const fs   = require('fs');
const path = require('path');

const SIGNALS_DIR   = path.resolve(__dirname, '../../data/signals/history');
const OUTCOMES_DIR  = path.resolve(__dirname, '../../data/signals/outcomes');
const PROFILES_PATH = path.resolve(__dirname, '../../data/signals/symbol-profiles.json');
const SUMMARY_PATH  = path.resolve(__dirname, '../../data/signals/learning-summary.json');
const CACHE_TTL_MS  = 5 * 60 * 1000;

const GLOBAL_WIN_RATE_FALLBACK = 0.5074;

let _cache     = null;
let _cacheTime = 0;

// ── File I/O ──────────────────────────────────────────────────────────────────

function readJsonlDir(dir) {
  if (!fs.existsSync(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); }
  catch { return []; }
  const records = [];
  for (const file of files) {
    try {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
    } catch { /* skip unreadable file */ }
  }
  return records;
}

function loadGlobalWinRate() {
  try {
    if (!fs.existsSync(SUMMARY_PATH)) return GLOBAL_WIN_RATE_FALLBACK;
    const s = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
    return s.overallWinRate ?? GLOBAL_WIN_RATE_FALLBACK;
  } catch {
    return GLOBAL_WIN_RATE_FALLBACK;
  }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function round(n, d = 4) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function avg(arr) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function calcWinRate(outcomes) {
  const directed = outcomes.filter(o => o.success !== null);
  if (directed.length === 0) return null;
  return round(directed.filter(o => o.success === true).length / directed.length);
}

function groupBy(arr, keyFn) {
  const map = {};
  for (const item of arr) {
    const k = keyFn(item) || 'unknown';
    if (!map[k]) map[k] = [];
    map[k].push(item);
  }
  return map;
}

// ── Signal enrichment ─────────────────────────────────────────────────────────

function enrichWithSignals(outcomes, signalIndex) {
  return outcomes.map(o => {
    const sig = o.signalId ? signalIndex.get(o.signalId) : null;
    return {
      ...o,
      _priceToZoneAtr: o._priceToZoneAtr ?? sig?.priceToZoneAtr ?? null,
      _relVol20:       o._relVol20       ?? o.relVol20 ?? sig?.relVol20 ?? null,
      _smaGapAtr:      o._smaGapAtr      ?? sig?.smaGapAtr ?? null,
    };
  });
}

// ── Personality labels ────────────────────────────────────────────────────────

const PERSONALITY_LABELS_SV = {
  momentum_volatile: 'Rör sig snabbt med hög volatilitet — kräver stark volymkonfirmation.',
  trending_reliable: 'Stabil och pålitlig — trend-signaler fungerar ofta bra.',
  fakeout_prone:     'Hög andel fakeouts — var försiktig med signaler under tröskeln.',
  range_bound:       'Tenderar till sidledsrörelse — vänta på tydligare riktning.',
  crypto_momentum:   'Krypto 24/7 — rör sig snabbt med externa katalysatorer.',
  general:           'Generell symbol utan tydlig personlighetsprofil.',
};

function classifyPersonality({ symbol, winRate, fakeoutRate, avgMaxUp10, avgMove10, volatilityLevel }) {
  if (symbol && (symbol.endsWith('USDT') || symbol.endsWith('/USD'))) {
    return 'crypto_momentum';
  }
  if (winRate !== null && winRate < 0.47) {
    return 'fakeout_prone';
  }
  if (fakeoutRate !== null && fakeoutRate > 0.45) {
    return 'fakeout_prone';
  }
  if (winRate !== null && winRate > 0.53 && volatilityLevel === 'high' && avgMaxUp10 !== null && avgMaxUp10 > 1.2) {
    return 'momentum_volatile';
  }
  if (winRate !== null && winRate > 0.52 && (fakeoutRate === null || fakeoutRate < 0.35)) {
    return 'trending_reliable';
  }
  if (avgMove10 !== null && Math.abs(avgMove10) < 0.25) {
    return 'range_bound';
  }
  return 'general';
}

// ── Optimal priceToZoneAtr sweet spot ─────────────────────────────────────────

const PTZ_BUCKETS = [
  { key: '0.0-0.25', lo: 0,    hi: 0.25 },
  { key: '0.25-0.5', lo: 0.25, hi: 0.5  },
  { key: '0.5-1.0',  lo: 0.5,  hi: 1.0  },
  { key: '1.0-1.5',  lo: 1.0,  hi: 1.5  },
  { key: '1.5+',     lo: 1.5,  hi: 999  },
];

function findOptimalPriceToZone(outcomes) {
  const withPtz = outcomes.filter(o => o._priceToZoneAtr !== null && o._priceToZoneAtr !== undefined);
  if (withPtz.length < 20) return null;

  let best = null;
  let bestWR = 0;

  for (const b of PTZ_BUCKETS) {
    const slice = withPtz.filter(o => o._priceToZoneAtr >= b.lo && o._priceToZoneAtr < b.hi);
    if (slice.length < 20) continue;
    const wr = calcWinRate(slice);
    if (wr !== null && wr > bestWR) {
      bestWR = wr;
      best   = { bucket: b.key, winRate: wr, samples: slice.length };
    }
  }
  return best;
}

// ── Per-symbol analysis ───────────────────────────────────────────────────────

function analyzeSymbol(symbol, outcomes, globalWinRate) {
  if (outcomes.length === 0) return null;

  const directed   = outcomes.filter(o => o.success !== null);
  const wins       = directed.filter(o => o.success === true);
  const failures   = directed.filter(o => o.success === false);
  const stoppedOut = failures.filter(o => o.failureReason === 'stopped_out');
  const fakeoutRate = failures.length > 0 ? round(stoppedOut.length / failures.length) : null;
  const winRate     = calcWinRate(outcomes);

  function avgOutcomeField(n, field) {
    return avg(outcomes.map(o => o[`outcome${n}`]?.[field]).filter(v => v != null));
  }

  const avgMove5    = avgOutcomeField(5,  'priceChangePct');
  const avgMove10   = avgOutcomeField(10, 'priceChangePct');
  const avgMove20   = avgOutcomeField(20, 'priceChangePct');
  const avgMaxUp5   = avgOutcomeField(5,  'maxMoveUp');
  const avgMaxUp10  = avgOutcomeField(10, 'maxMoveUp');
  const avgMaxDown5 = avgOutcomeField(5,  'maxMoveDown');

  // Volatility level based on average max up-move in 10 candles
  let volatilityLevel = 'normal';
  if (avgMaxUp10 !== null) {
    if      (avgMaxUp10 >= 2.0) volatilityLevel = 'extreme';
    else if (avgMaxUp10 >= 1.2) volatilityLevel = 'high';
    else if (avgMaxUp10 >= 0.6) volatilityLevel = 'normal';
    else                        volatilityLevel = 'low';
  }

  // Best/worst regimes (min 20 samples per regime)
  const byRegime      = groupBy(outcomes, o => o.marketRegime || 'UNKNOWN');
  const regimeRanked  = Object.entries(byRegime)
    .map(([regime, arr]) => ({ regime, samples: arr.length, winRate: calcWinRate(arr) }))
    .filter(e => e.samples >= 20 && e.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate);
  const bestRegimes   = regimeRanked.slice(0, 3).map(e => e.regime);
  const worstRegimes  = regimeRanked.slice(-2).map(e => e.regime).reverse();

  // Best UTC hours (min 10 samples)
  const byHour       = groupBy(outcomes, o => {
    const ts = o.timestamp || o.candleTs;
    return ts ? String(new Date(ts).getUTCHours()) : null;
  });
  const hourRanked   = Object.entries(byHour)
    .map(([h, arr]) => ({ hour: parseInt(h, 10), samples: arr.length, winRate: calcWinRate(arr) }))
    .filter(e => !isNaN(e.hour) && e.samples >= 10 && e.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate);
  const bestHours    = hourRanked.slice(0, 3).map(e => e.hour);

  // Best event types (min 10 samples)
  const byEvent      = groupBy(outcomes, o => o.eventType || 'unknown');
  const eventRanked  = Object.entries(byEvent)
    .map(([evt, arr]) => ({ evt, samples: arr.length, winRate: calcWinRate(arr) }))
    .filter(e => e.evt !== 'unknown' && e.samples >= 10 && e.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate);
  const bestEventTypes = eventRanked.slice(0, 3).map(e => e.evt);

  // Optimal priceToZoneAtr bucket
  const optimalPriceToZone = findOptimalPriceToZone(outcomes);

  // Personality classification
  const personality  = classifyPersonality({ symbol, winRate, fakeoutRate, avgMaxUp10, avgMove10, volatilityLevel });
  const personalitySv = PERSONALITY_LABELS_SV[personality] || PERSONALITY_LABELS_SV.general;

  // Confidence tiers
  const confidence   = outcomes.length >= 500 ? 'high' : outcomes.length >= 100 ? 'medium' : 'low';

  // Asymmetric adjustment: penalize weak symbols harder than boosting strong ones
  let scoreAdjustment = 0;
  if (confidence !== 'low' && winRate !== null && globalWinRate !== null) {
    const delta  = winRate - globalWinRate;
    const factor = delta >= 0 ? 40 : 60;
    scoreAdjustment = Math.max(-8, Math.min(8, Math.round(delta * factor)));
  }

  return {
    symbol,
    samples:     outcomes.length,
    wins:        wins.length,
    losses:      failures.length,
    winRate,
    fakeoutRate,
    continuationProfile: {
      avgMove5,
      avgMove10,
      avgMove20,
      avgMaxUp5,
      avgMaxUp10,
      avgMaxDown5,
    },
    volatilityLevel,
    bestRegimes,
    worstRegimes,
    bestHours,
    bestEventTypes,
    optimalPriceToZone,
    personality,
    personalitySv,
    scoreAdjustment,
    confidence,
  };
}

// ── buildSymbolProfiles ───────────────────────────────────────────────────────

/**
 * Build and save symbol-profiles.json from all historical outcomes.
 * Called from Auto Machine pipeline (step 5c) and POST /history/update-learning.
 *
 * @returns {{ totalSymbols, highConfSymbols, watchSymbols, strongSymbols }}
 */
function buildSymbolProfiles() {
  console.log('[SymbolPersonality] Building symbol profiles...');

  const rawOutcomes = readJsonlDir(OUTCOMES_DIR);
  const rawSignals  = readJsonlDir(SIGNALS_DIR);

  console.log(`[SymbolPersonality] Loaded ${rawOutcomes.length} outcomes, ${rawSignals.length} signals`);

  const signalIndex = new Map(rawSignals.map(s => [s.signalId, s]));
  const outcomes    = enrichWithSignals(rawOutcomes, signalIndex);
  const globalWinRate = loadGlobalWinRate();

  const bySymbol = groupBy(outcomes, o => o.symbol);
  const symbols  = {};

  for (const [symbol, symOutcomes] of Object.entries(bySymbol)) {
    const profile = analyzeSymbol(symbol, symOutcomes, globalWinRate);
    if (profile) symbols[symbol] = profile;
  }

  const allProfiles     = Object.values(symbols);
  const totalSymbols    = allProfiles.length;
  const highConfSymbols = allProfiles.filter(p => p.confidence === 'high').length;
  const watchSymbols    = allProfiles.filter(p => p.scoreAdjustment <= -2).map(p => p.symbol);
  const strongSymbols   = allProfiles.filter(p => p.scoreAdjustment >= 2).map(p => p.symbol);

  const profiles = {
    updatedAt:    new Date().toISOString(),
    globalWinRate,
    totalSymbols,
    highConfSymbols,
    watchSymbols,
    strongSymbols,
    symbols,
  };

  try {
    fs.mkdirSync(path.dirname(PROFILES_PATH), { recursive: true });
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), 'utf8');
    console.log(`[SymbolPersonality] Saved ${totalSymbols} profiles (${highConfSymbols} high-conf) → ${PROFILES_PATH}`);
    if (watchSymbols.length > 0)  console.log(`[SymbolPersonality] Svaga symboler: ${watchSymbols.join(', ')}`);
    if (strongSymbols.length > 0) console.log(`[SymbolPersonality] Starka symboler: ${strongSymbols.join(', ')}`);
  } catch (err) {
    console.warn('[SymbolPersonality] Failed to save profiles:', err.message);
  }

  return { totalSymbols, highConfSymbols, watchSymbols, strongSymbols };
}

// ── loadSymbolProfiles (5-min cache) ──────────────────────────────────────────

function loadSymbolProfiles() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(PROFILES_PATH)) { _cache = null; _cacheTime = now; return null; }
    _cache     = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    _cacheTime = now;
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}

// ── applySymbolPersonality (live scanner step) ────────────────────────────────

/**
 * Apply symbol personality adjustment to a live scan result.
 * Reads cached symbol-profiles.json (no disk I/O if cache is fresh).
 * Never throws — returns result unchanged on any error.
 */
function applySymbolPersonality(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[SymbolPersonality] applySymbolPersonality error:', err.message);
    return { ...result, symbolPersonality: null };
  }
}

function _apply(result) {
  const profiles = loadSymbolProfiles();
  if (!profiles || !profiles.symbols) {
    return { ...result, symbolPersonality: null };
  }

  const profile = profiles.symbols[result.symbol];
  if (!profile || profile.confidence === 'low') {
    return { ...result, symbolPersonality: null };
  }

  // Hard-blocked: attach metadata only, never boost score
  const isHardBlocked =
    result.autoFilter?.blocked       === true ||
    result.threeFingerSpread?.active === true ||
    result.breakoutAlreadyOccurred   === true;

  const adjustment = isHardBlocked ? 0 : profile.scoreAdjustment;
  const newScore   = Math.max(0, Math.min(100, (result.tradeScore ?? 0) + adjustment));

  const explanation = [...(result.scoreExplanationSv || [])];
  if (adjustment !== 0) {
    const dir = adjustment > 0 ? 'höjer' : 'sänker';
    const msg = `Symbol Memory: ${result.symbol} ${dir} betyget ${Math.abs(adjustment)}p (${profile.personalitySv})`;
    if (!explanation.includes(msg)) explanation.push(msg);
  }

  return {
    ...result,
    tradeScore:         newScore,
    scoreExplanationSv: explanation,
    symbolPersonality: {
      personality:     profile.personality,
      personalitySv:   profile.personalitySv,
      confidence:      profile.confidence,
      winRate:         profile.winRate,
      volatilityLevel: profile.volatilityLevel,
      fakeoutRate:     profile.fakeoutRate,
      scoreAdjustment: adjustment,
      bestRegimes:     profile.bestRegimes,
      worstRegimes:    profile.worstRegimes,
    },
  };
}

module.exports = { buildSymbolProfiles, loadSymbolProfiles, applySymbolPersonality };
