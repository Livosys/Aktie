'use strict';
/**
 * Regime Profile Engine v1
 *
 * Builds per-market-regime behavioral profiles from historical outcomes.
 * Each profile captures: win rate, fakeout rate, continuation tendency,
 * best/worst symbols, best event types, and a conservative score adjustment.
 *
 * During live scans, applyRegimeProfile() reads the cached profile and
 * applies a small adaptive score adjustment + attaches regime metadata.
 *
 * Safety contract:
 *   Hard-blocked signals (TFS, breakoutAlreadyOccurred, autoFilter.blocked)
 *   receive NO score boost — only metadata is attached.
 *   Max adjustment: ±5 points.
 *   confidence = 'low' (< 500 outcomes) → adjustment = 0.
 */

const fs   = require('fs');
const path = require('path');

const OUTCOMES_DIR    = path.resolve(__dirname, '../../data/signals/outcomes');
const PROFILES_PATH   = path.resolve(__dirname, '../../data/signals/regime-profiles.json');
const SUMMARY_PATH    = path.resolve(__dirname, '../../data/signals/learning-summary.json');
const CACHE_TTL_MS    = 5 * 60 * 1000;

const GLOBAL_WIN_RATE_FALLBACK = 0.5074;

const ALL_REGIMES = [
  'BULLISH_TREND',
  'BEARISH_TREND',
  'CHOPPY',
  'RANGE_DAY',
  'TREND_DAY_UP',
  'TREND_DAY_DOWN',
  'HIGH_VOLATILITY',
  'PANIC',
  'UNKNOWN',
];

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

function topN(rankArr, n) {
  return rankArr.slice(0, n).map(e => e.key);
}

// ── Swedish regime descriptions ───────────────────────────────────────────────

const REGIME_DESC_SV = {
  BULLISH_TREND:   'Stark upptrend',
  BEARISH_TREND:   'Stark nedtrend',
  CHOPPY:          'Hackig/sidleds marknad',
  RANGE_DAY:       'Range-dag (stöd/motstånd)',
  TREND_DAY_UP:    'Trendag uppåt',
  TREND_DAY_DOWN:  'Trendag nedåt',
  HIGH_VOLATILITY: 'Hög volatilitet',
  PANIC:           'Panikläge',
  UNKNOWN:         'Okänt marknadsläge',
};

const REGIME_INSIGHT_SV = {
  BULLISH_TREND:
    'Systemet har lärt sig att en stark upptrend ger lägre träffsäkerhet — signaler tenderar att komma för sent in i rörelsen.',
  BEARISH_TREND:
    'Systemet har lärt sig att en stark nedtrend historiskt ger bättre träffsäkerhet — kortsäljningssetups fungerar ofta bra.',
  CHOPPY:
    'Systemet har lärt sig att hackiga marknader är nära genomsnittet — varken bättre eller sämre.',
  RANGE_DAY:
    'Systemet har lärt sig att range-dagar ger något bättre träffsäkerhet — stöd/motstånd håller ofta.',
  TREND_DAY_UP:
    'Systemet har lärt sig att trendagar uppåt ger lägre träffsäkerhet — det är svårt att tajma setups mot den starka trenden.',
  TREND_DAY_DOWN:
    'Systemet har lärt sig att trendagar nedåt är nära genomsnittet.',
  HIGH_VOLATILITY:
    'Systemet har lärt sig att hög volatilitet ger sämre träffsäkerhet — prisrörelserna är oförutsägbara.',
  PANIC:
    'Systemet har lärt sig att paniklägen är nära genomsnittet men med hög spridning — var extra försiktig.',
  UNKNOWN:
    'Inget marknadsläge identifierat — standardbedömning.',
};

// ── Per-regime analysis ───────────────────────────────────────────────────────

function analyzeRegime(regime, outcomes, globalWinRate) {
  if (outcomes.length === 0) return null;

  const directed   = outcomes.filter(o => o.success !== null);
  const wins       = directed.filter(o => o.success === true);
  const failures   = directed.filter(o => o.success === false);
  const stoppedOut = failures.filter(o => o.failureReason === 'stopped_out');

  const winRate    = calcWinRate(outcomes);
  const fakeoutRate = failures.length > 0
    ? round(stoppedOut.length / failures.length)
    : null;

  // Continuation: avg price change at 10 candles
  const avgContinuation = avg(
    outcomes.map(o => o.outcome10?.priceChangePct).filter(v => v != null)
  );

  // Best symbols (min 20 samples, ranked by win rate)
  const bySymbol = {};
  for (const o of outcomes) {
    const s = o.symbol || 'unknown';
    if (!bySymbol[s]) bySymbol[s] = [];
    bySymbol[s].push(o);
  }
  const symbolRanked = Object.entries(bySymbol)
    .map(([s, arr]) => ({ key: s, samples: arr.length, winRate: calcWinRate(arr) }))
    .filter(e => e.samples >= 20 && e.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate);
  const bestSymbols  = topN(symbolRanked, 3);
  const worstSymbols = topN([...symbolRanked].reverse(), 2);

  // Best event types (min 15 samples)
  const byEvent = {};
  for (const o of outcomes) {
    const e = o.eventType || 'unknown';
    if (!byEvent[e]) byEvent[e] = [];
    byEvent[e].push(o);
  }
  const eventRanked = Object.entries(byEvent)
    .map(([e, arr]) => ({ key: e, samples: arr.length, winRate: calcWinRate(arr) }))
    .filter(e => e.key !== 'unknown' && e.samples >= 15 && e.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate);
  const bestEventTypes = topN(eventRanked, 3);

  // Confidence tier
  const confidence = outcomes.length >= 5000 ? 'high'
    : outcomes.length >= 500 ? 'medium'
    : 'low';

  // Score adjustment: asymmetric, conservative (factor 50 positive / 70 negative)
  let scoreAdjustment = 0;
  if (confidence !== 'low' && winRate !== null && globalWinRate !== null) {
    const delta  = winRate - globalWinRate;
    const factor = delta >= 0 ? 50 : 70;
    scoreAdjustment = Math.max(-5, Math.min(5, Math.round(delta * factor)));
  }

  const descSv    = REGIME_DESC_SV[regime]    || regime;
  const insightSv = REGIME_INSIGHT_SV[regime] || REGIME_INSIGHT_SV.UNKNOWN;

  return {
    regime,
    descSv,
    insightSv,
    samples: outcomes.length,
    wins:    wins.length,
    losses:  failures.length,
    winRate,
    fakeoutRate,
    avgContinuation,
    bestSymbols,
    worstSymbols,
    bestEventTypes,
    scoreAdjustment,
    confidence,
  };
}

// ── buildRegimeProfiles ───────────────────────────────────────────────────────

/**
 * Build and save regime-profiles.json from all historical outcomes.
 * Called from Auto Machine pipeline (step 5d) and POST /history/update-learning.
 *
 * @returns {{ totalRegimes, highConfRegimes, bestRegime, worstRegime }}
 */
function buildRegimeProfiles() {
  console.log('[RegimeProfile] Building regime profiles...');

  const rawOutcomes = readJsonlDir(OUTCOMES_DIR);
  console.log(`[RegimeProfile] Loaded ${rawOutcomes.length} outcomes`);

  const globalWinRate = loadGlobalWinRate();

  // Group outcomes by marketRegime
  const byRegime = {};
  for (const o of rawOutcomes) {
    const regime = o.marketRegime || 'UNKNOWN';
    if (!byRegime[regime]) byRegime[regime] = [];
    byRegime[regime].push(o);
  }

  const regimes = {};
  for (const regime of ALL_REGIMES) {
    const arr = byRegime[regime] || [];
    if (arr.length === 0) continue;
    const profile = analyzeRegime(regime, arr, globalWinRate);
    if (profile) regimes[regime] = profile;
  }

  const allProfiles    = Object.values(regimes);
  const totalRegimes   = allProfiles.length;
  const highConfRegimes = allProfiles.filter(p => p.confidence === 'high').length;

  const ranked     = allProfiles.filter(p => p.winRate !== null).sort((a, b) => b.winRate - a.winRate);
  const bestRegime = ranked[0]?.regime ?? null;
  const worstRegime = ranked[ranked.length - 1]?.regime ?? null;

  const profiles = {
    updatedAt:     new Date().toISOString(),
    globalWinRate,
    totalRegimes,
    highConfRegimes,
    bestRegime,
    worstRegime,
    regimes,
  };

  try {
    fs.mkdirSync(path.dirname(PROFILES_PATH), { recursive: true });
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), 'utf8');
    console.log(`[RegimeProfile] Saved ${totalRegimes} regime profiles (${highConfRegimes} high-conf) → ${PROFILES_PATH}`);
    if (bestRegime)  console.log(`[RegimeProfile] Bästa regime: ${bestRegime} (${round(regimes[bestRegime]?.winRate * 100, 1)}% win rate)`);
    if (worstRegime) console.log(`[RegimeProfile] Sämsta regime: ${worstRegime} (${round(regimes[worstRegime]?.winRate * 100, 1)}% win rate)`);
  } catch (err) {
    console.warn('[RegimeProfile] Failed to save profiles:', err.message);
  }

  return { totalRegimes, highConfRegimes, bestRegime, worstRegime };
}

// ── loadRegimeProfiles (5-min cache) ──────────────────────────────────────────

function loadRegimeProfiles() {
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

// ── applyRegimeProfile (live scanner step) ────────────────────────────────────

/**
 * Apply regime profile adjustment to a live scan result.
 * Uses result.marketRegimeV2 to look up the current regime profile.
 * Never throws — returns result unchanged on any error.
 */
function applyRegimeProfile(result) {
  try {
    return _apply(result);
  } catch (err) {
    console.warn('[RegimeProfile] applyRegimeProfile error:', err.message);
    return { ...result, regimeProfile: null };
  }
}

function _apply(result) {
  const profiles = loadRegimeProfiles();
  if (!profiles || !profiles.regimes) {
    return { ...result, regimeProfile: null };
  }

  const regime  = result.marketRegimeV2 || 'UNKNOWN';
  const profile = profiles.regimes[regime];

  if (!profile || profile.confidence === 'low') {
    return { ...result, regimeProfile: null };
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
    const msg = `Regime Memory: ${profile.descSv} ${dir} betyget ${Math.abs(adjustment)}p (historisk win rate ${round(profile.winRate * 100, 1)}%)`;
    if (!explanation.includes(msg)) explanation.push(msg);
  }

  return {
    ...result,
    tradeScore:         newScore,
    scoreExplanationSv: explanation,
    regimeProfile: {
      regime,
      descSv:          profile.descSv,
      insightSv:       profile.insightSv,
      winRate:         profile.winRate,
      fakeoutRate:     profile.fakeoutRate,
      avgContinuation: profile.avgContinuation,
      scoreAdjustment: adjustment,
      confidence:      profile.confidence,
      bestSymbols:     profile.bestSymbols,
      bestEventTypes:  profile.bestEventTypes,
      samples:         profile.samples,
    },
  };
}

module.exports = { buildRegimeProfiles, loadRegimeProfiles, applyRegimeProfile };
