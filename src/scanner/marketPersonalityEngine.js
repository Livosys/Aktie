'use strict';
const fs   = require('fs');
const path = require('path');

const SIGNALS_DIR = path.resolve(__dirname, '../../data/signals');
const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache     = {};
let _cacheTime = {};

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function round(n, d = 1) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function avg(arr) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ── Core computation ──────────────────────────────────────────────────────────

function computePersonality(allResults, group) {
  const valid = allResults.filter(
    r => r.price !== null && r.state !== 'NO_TRADE' && (r.candleCount ?? 0) > 0
  );

  if (valid.length < 2) {
    return _emptyPersonality(group, 'Otillräckligt antal instrument för karaktärsanalys.');
  }

  const n = valid.length;

  // ── Raw counts ─────────────────────────────────────────────────────────────
  const breakoutOccurredCount = valid.filter(r => r.breakoutAlreadyOccurred).length;
  const tfsActiveCount        = valid.filter(r => r.threeFingerSpread?.active).length;
  const conflictingMtfCount   = valid.filter(r => ['conflicting', 'full_conflict'].includes(r.mtfAlignment)).length;
  const confirmedMtfCount     = valid.filter(r => r.mtfAlignment === 'confirmed').length;
  const alignedMtfCount       = valid.filter(r => ['confirmed', 'aligned'].includes(r.mtfAlignment)).length;
  const elephantBarCount      = valid.filter(r => r.elephantBar?.active).length;
  const highVolCount          = valid.filter(r => r.relVol20 != null && r.relVol20 >= 1.3).length;
  const weakVolCount          = valid.filter(r => r.relVol20 != null && r.relVol20 < 0.7).length;
  const triggeredCount        = valid.filter(r => ['LONG_TRIGGERED', 'SHORT_TRIGGERED'].includes(r.signal)).length;
  const narrowCount           = valid.filter(r => ['HIGH_QUALITY_NARROW', 'MEDIUM_NARROW'].includes(r.state)).length;
  const highScoreCount        = valid.filter(r => (r.tradeScore ?? 0) >= 50).length;
  const blockedCount          = valid.filter(r => r.autoFilter?.blocked === true).length;

  const avgAtrPct120 = avg(valid.map(r => r.atrPct120).filter(v => v != null));
  const avgRelVol20  = avg(valid.map(r => r.relVol20).filter(v => v != null));
  const avgScore     = avg(valid.map(r => r.tradeScore ?? 0));

  // Regime distribution
  const regimes       = valid.map(r => r.marketRegimeV2 || r.marketRegime || 'UNKNOWN');
  const panicCount    = regimes.filter(r => r === 'PANIC').length;
  const highVolReg    = regimes.filter(r => r === 'HIGH_VOLATILITY').length;
  const bullishReg    = regimes.filter(r => ['BULLISH_TREND', 'TREND_DAY_UP'].includes(r)).length;
  const bearishReg    = regimes.filter(r => ['BEARISH_TREND', 'TREND_DAY_DOWN'].includes(r)).length;
  const choppyCount   = regimes.filter(r => r === 'CHOPPY').length;
  const rangeCount    = regimes.filter(r => r === 'RANGE_DAY').length;
  const trendDayCount = regimes.filter(r => ['TREND_DAY_UP', 'TREND_DAY_DOWN'].includes(r)).length;

  // ── Composite scores (0–100) ──────────────────────────────────────────────

  const fakeoutRisk = Math.min(100, Math.round(
    (breakoutOccurredCount / n) * 35 +
    (conflictingMtfCount   / n) * 35 +
    (tfsActiveCount        / n) * 30
  ));

  const continuationProbability = Math.min(100, Math.round(
    (alignedMtfCount   / n) * 50 +
    (confirmedMtfCount / n) * 30 +
    (triggeredCount    / n) * 20
  ));

  const volatilityPressure = Math.min(100, Math.round(
    ((panicCount + highVolReg) / n) * 50 +
    (avgAtrPct120 != null ? Math.min(50, (avgAtrPct120 / 200) * 50) : 25)
  ));

  const trendPersistence = Math.min(100, Math.round(
    ((bullishReg + bearishReg) / n) * 60 +
    (confirmedMtfCount          / n) * 40
  ));

  const exhaustionLevel = Math.min(100, Math.round(
    (breakoutOccurredCount / n) * 45 +
    (conflictingMtfCount   / n) * 35 +
    (weakVolCount          / n) * 20
  ));

  const aggressionLevel = Math.min(100, Math.round(
    (elephantBarCount / n) * 40 +
    (highVolCount     / n) * 35 +
    (triggeredCount   / n) * 25
  ));

  const marketTrustScore = Math.min(100, Math.round(
    continuationProbability * 0.40 +
    (100 - fakeoutRisk)     * 0.35 +
    (100 - exhaustionLevel) * 0.25
  ));

  // ── Personality label ─────────────────────────────────────────────────────

  let personalityLabel;
  let personalitySv;

  if (panicCount >= n * 0.4 || (volatilityPressure >= 75 && bearishReg >= n * 0.5)) {
    personalityLabel = 'panic_trend_day';
    personalitySv    = 'Panikmarknad med stark riktning och hög volatilitet. Undvik att jaga rörelser.';
  } else if (fakeoutRisk >= 60) {
    personalityLabel = 'fakeout_heavy_day';
    personalitySv    = 'Marknaden genererar många fakeouts idag. Var extra försiktig med utbrott.';
  } else if (choppyCount >= n * 0.5 || (fakeoutRisk >= 40 && continuationProbability < 35)) {
    personalityLabel = 'choppy_trap_market';
    personalitySv    = 'Stökig marknad utan tydlig riktning. Hög risk för whipsaws och falska utbrott.';
  } else if (exhaustionLevel >= 60 && aggressionLevel < 40) {
    personalityLabel = 'exhaustion_environment';
    personalitySv    = 'Rörelsen visar tecken på utmattning. Minskat momentum och svag volym.';
  } else if (continuationProbability >= 55 && fakeoutRisk < 35 && aggressionLevel >= 35) {
    personalityLabel = 'continuation_environment';
    personalitySv    = 'Marknaden visar stark continuation-karaktär idag med låg fakeout-risk.';
  } else if (aggressionLevel >= 55 && volatilityPressure >= 40) {
    personalityLabel = 'momentum_heavy_day';
    personalitySv    = 'Stark momentumdag med hög aktivitet. Rörelserna är kraftfulla och volymstarka.';
  } else if (trendDayCount >= n * 0.5 && trendPersistence >= 60) {
    personalityLabel = 'trend_day';
    personalitySv    = 'Trenddag med tydlig riktning. Pullbacks ger möjligheter i trendriktning.';
  } else if ((narrowCount >= n * 0.5 || rangeCount >= n * 0.4) && aggressionLevel < 30) {
    personalityLabel = 'compression_day';
    personalitySv    = 'Marknaden komprimeras brett. Många instrument i narrow-läge — vänta på utbrott.';
  } else {
    personalityLabel = 'balanced_market';
    personalitySv    = 'Balanserad marknad utan utpräglad karaktär. Normal selektivitet gäller.';
  }

  return {
    computedAt:    new Date().toISOString(),
    group,
    symbolCount:   n,
    personalityLabel,
    personalitySv,
    marketTrustScore,
    continuationProbability,
    fakeoutRisk,
    volatilityPressure,
    trendPersistence,
    exhaustionLevel,
    aggressionLevel,
    raw: {
      breakoutOccurredCount,
      tfsActiveCount,
      conflictingMtfCount,
      confirmedMtfCount,
      alignedMtfCount,
      elephantBarCount,
      highVolCount,
      weakVolCount,
      triggeredCount,
      narrowCount,
      highScoreCount,
      blockedCount,
      avgAtrPct120: round(avgAtrPct120, 1),
      avgRelVol20:  round(avgRelVol20,  2),
      avgScore:     round(avgScore,     1),
      panicCount,
      highVolReg,
      bullishReg,
      bearishReg,
      choppyCount,
      rangeCount,
      trendDayCount,
    },
  };
}

function _emptyPersonality(group, personalitySv) {
  return {
    computedAt:              new Date().toISOString(),
    group,
    symbolCount:             0,
    personalityLabel:        'insufficient_data',
    personalitySv,
    marketTrustScore:        50,
    continuationProbability: 50,
    fakeoutRisk:             50,
    volatilityPressure:      50,
    trendPersistence:        50,
    exhaustionLevel:         50,
    aggressionLevel:         50,
    raw:                     {},
  };
}

// ── File persistence ──────────────────────────────────────────────────────────

function personalityPath(group) {
  return path.join(SIGNALS_DIR, `market-personality-${group}.json`);
}

function computeAndSavePersonality(allResults, group) {
  try {
    const personality = computePersonality(allResults, group);
    ensureDir(SIGNALS_DIR);
    fs.writeFileSync(personalityPath(group), JSON.stringify(personality, null, 2), 'utf8');
    const key = group || 'stocks';
    _cache[key]     = personality;
    _cacheTime[key] = Date.now();
    return personality;
  } catch (err) {
    console.warn(`[MarketPersonality] Save failed (${group}):`, err.message);
    return null;
  }
}

function loadPersonality(group) {
  const now = Date.now();
  const key = group || 'stocks';
  if (_cache[key] && now - (_cacheTime[key] || 0) < CACHE_TTL_MS) return _cache[key];
  try {
    const p = personalityPath(key);
    if (!fs.existsSync(p)) { _cacheTime[key] = now; return null; }
    _cache[key]     = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cacheTime[key] = now;
    return _cache[key];
  } catch {
    return null;
  }
}

module.exports = { computeAndSavePersonality, loadPersonality, computePersonality };
