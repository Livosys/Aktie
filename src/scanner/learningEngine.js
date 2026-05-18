'use strict';
const fs   = require('fs');
const path = require('path');

const OUTCOMES_DIR   = path.resolve(__dirname, '../../data/signals/outcomes');
const SIGNALS_DIR    = path.resolve(__dirname, '../../data/signals/history');
const SUMMARY_PATH   = path.resolve(__dirname, '../../data/signals/learning-summary.json');

// ── File I/O ──────────────────────────────────────────────────────────────────

function readJsonlDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const records = [];
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); }
  catch { return []; }

  for (const file of files) {
    try {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { /* skip bad lines */ }
      }
    } catch { /* skip unreadable files */ }
  }
  return records;
}

function loadAllOutcomes() { return readJsonlDir(OUTCOMES_DIR); }
function loadAllSignals()  { return readJsonlDir(SIGNALS_DIR);  }

function buildSignalIndex(signals) {
  const idx = new Map();
  for (const sig of signals) {
    if (sig.signalId) idx.set(sig.signalId, sig);
  }
  return idx;
}

function enrichOutcomes(outcomes, signalIndex) {
  return outcomes.map(o => {
    const sig = o.signalId ? signalIndex.get(o.signalId) : null;
    return {
      ...o,
      _threeFingerSpread:  sig?.threeFingerSpreadActive ?? null,
      _breakoutAlready:    sig?.breakoutAlreadyOccurred ?? null,
      _priceToZoneAtr:     sig?.priceToZoneAtr          ?? null,
      _smaGapAtr:          sig?.smaGapAtr               ?? null,
      // relVol20 may exist on the outcome directly (new records) or need signal join (old records)
      _relVol20:           o.relVol20 ?? sig?.relVol20 ?? null,
    };
  });
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function round(n, d = 4) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function pct(n) { return round(n, 4); }

function calcWinRate(outcomes) {
  const directed = outcomes.filter(o => o.success !== null);
  if (directed.length === 0) return null;
  const wins = directed.filter(o => o.success === true).length;
  return pct(wins / directed.length);
}

function avg(arr) {
  const vals = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function avgOutcome(outcomes, horizon, field) {
  const key = `outcome${horizon}`;
  return avg(outcomes.map(o => o[key]?.[field]));
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

function rankByWinRate(grouped, minSamples = 5) {
  return Object.entries(grouped)
    .map(([key, arr]) => ({
      key,
      samples:    arr.length,
      winRate:    calcWinRate(arr),
      avgMove10:  avgOutcome(arr, 10, 'priceChangePct'),
    }))
    .filter(e => e.samples >= minSamples && e.winRate !== null)
    .sort((a, b) => b.winRate - a.winRate);
}

// ── Dimension analyzers ───────────────────────────────────────────────────────

function analyzeBySymbol(outcomes) {
  const bySymbol = groupBy(outcomes, o => o.symbol);
  const result   = {};

  for (const [sym, arr] of Object.entries(bySymbol)) {
    const directed    = arr.filter(o => o.success !== null);
    const wins        = directed.filter(o => o.success === true);
    const losses      = directed.filter(o => o.success === false);
    const byEvent     = groupBy(arr, o => o.eventType);
    const eventRanked = rankByWinRate(byEvent, 2);

    result[sym] = {
      samples:         arr.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         calcWinRate(arr),
      avgMove3:        avgOutcome(arr, 3,  'priceChangePct'),
      avgMove5:        avgOutcome(arr, 5,  'priceChangePct'),
      avgMove10:       avgOutcome(arr, 10, 'priceChangePct'),
      avgMove20:       avgOutcome(arr, 20, 'priceChangePct'),
      avgTradeScore:   avg(arr.map(o => o.tradeScore)),
      bestEventType:   eventRanked[0]?.key  ?? null,
      worstEventType:  eventRanked[eventRanked.length - 1]?.key ?? null,
    };
  }
  return result;
}

function analyzeByNarrowType(outcomes) {
  const TYPES = ['coil_flat', 'attack_200', 'none'];
  const result = {};

  for (const t of TYPES) {
    const arr = outcomes.filter(o => (o.narrowType || 'none') === t);
    result[t] = {
      samples:   arr.length,
      winRate:   calcWinRate(arr),
      avgMove10: avgOutcome(arr, 10, 'priceChangePct'),
    };
  }
  return result;
}

function analyzeByState(outcomes) {
  const STATES = [
    'HIGH_QUALITY_NARROW',
    'MEDIUM_NARROW',
    'REGULAR_TREND',
    'WIDE_AVOID',
    'THREE_FINGER_SPREAD_AVOID',
    'BREAKOUT_ALREADY_OCCURRED',
    'NO_TRADE',
  ];
  const byState = groupBy(outcomes, o => o.state || 'unknown');
  const result  = {};

  const allStates = new Set([...STATES, ...Object.keys(byState)]);
  for (const state of allStates) {
    const arr  = byState[state] || [];
    if (arr.length === 0) continue;
    const directed = arr.filter(o => o.success !== null);
    const fails    = directed.filter(o => o.success === false);
    result[state] = {
      samples:     arr.length,
      winRate:     calcWinRate(arr),
      failureRate: directed.length > 0 ? pct(fails.length / directed.length) : null,
      avgMove10:   avgOutcome(arr, 10, 'priceChangePct'),
    };
  }
  return result;
}

function analyzeByEventType(outcomes) {
  const byEvent = groupBy(outcomes, o => o.eventType || 'unknown');
  const result  = {};

  for (const [evt, arr] of Object.entries(byEvent)) {
    result[evt] = {
      samples:   arr.length,
      winRate:   calcWinRate(arr),
      avgMove10: avgOutcome(arr, 10, 'priceChangePct'),
    };
  }
  return result;
}

function analyzeByHour(outcomes) {
  const result = {};

  for (const o of outcomes) {
    const ts = o.timestamp || o.candleTs;
    if (!ts) continue;
    const hour = String(new Date(ts).getUTCHours());
    if (!result[hour]) result[hour] = [];
    result[hour].push(o);
  }

  const out = {};
  for (const [h, arr] of Object.entries(result)) {
    out[h] = {
      samples:   arr.length,
      winRate:   calcWinRate(arr),
      avgMove10: avgOutcome(arr, 10, 'priceChangePct'),
    };
  }
  return out;
}

function analyzeByMarketRegime(outcomes) {
  const REGIMES = [
    'BULLISH_TREND', 'BEARISH_TREND', 'TREND_DAY_UP', 'TREND_DAY_DOWN',
    'CHOPPY', 'RANGE_DAY', 'HIGH_VOLATILITY', 'PANIC', 'UNKNOWN',
  ];
  const byRegime = groupBy(outcomes, o => o.marketRegime || 'UNKNOWN');
  const result   = {};

  const allRegimes = new Set([...REGIMES, ...Object.keys(byRegime)]);
  for (const regime of allRegimes) {
    const arr = byRegime[regime] || [];
    if (arr.length === 0) continue;
    result[regime] = {
      samples:   arr.length,
      winRate:   calcWinRate(arr),
      avgMove10: avgOutcome(arr, 10, 'priceChangePct'),
    };
  }
  return result;
}

function analyzeByScoreRange(outcomes) {
  const RANGES = [
    { label: '0-30',   lo: 0,  hi: 30  },
    { label: '31-50',  lo: 31, hi: 50  },
    { label: '51-70',  lo: 51, hi: 70  },
    { label: '71-100', lo: 71, hi: 100 },
  ];
  const result = {};

  for (const { label, lo, hi } of RANGES) {
    const arr = outcomes.filter(o => o.tradeScore !== null && o.tradeScore >= lo && o.tradeScore <= hi);
    result[label] = {
      samples:   arr.length,
      winRate:   calcWinRate(arr),
      avgMove10: avgOutcome(arr, 10, 'priceChangePct'),
    };
  }
  return result;
}

function analyzeFailureReasons(outcomes) {
  const failures = outcomes.filter(o => o.success === false);
  const total    = failures.length;
  if (total === 0) return { totalFailures: 0, reasons: [] };

  // From failureReason field (already on outcome)
  const stoppedOut      = failures.filter(o => o.failureReason === 'stopped_out').length;
  const noFollowThrough = failures.filter(o => o.failureReason === 'no_follow_through').length;

  // From joined/outcome fields
  const lowTradeScore  = failures.filter(o => o.tradeScore !== null && o.tradeScore < 30).length;
  const choppyMarket   = failures.filter(o => o.marketRegime === 'CHOPPY').length;
  const threeFingerSpr = failures.filter(o => o._threeFingerSpread === true).length;
  const breakoutAlrd   = failures.filter(o => o._breakoutAlready === true).length;
  const farFromZone    = failures.filter(o => o._priceToZoneAtr !== null && o._priceToZoneAtr > 1.5).length;
  const weakVolume     = failures.filter(o => o._relVol20 !== null && o._relVol20 < 0.7).length;
  const noTrigger      = outcomes.filter(o => o.success === null).length;

  const rawReasons = [
    { reason: 'stopped_out',           labelSv: 'Stop-loss träffad',                     count: stoppedOut },
    { reason: 'no_follow_through',     labelSv: 'Prisrörelse uteblev',                   count: noFollowThrough },
    { reason: 'low_tradeScore',        labelSv: 'Lågt tradeScore (<30)',                  count: lowTradeScore },
    { reason: 'choppy_market',         labelSv: 'Stökig marknad (CHOPPY)',                count: choppyMarket },
    { reason: 'weak_volume',           labelSv: 'Svag volym (relVol20 < 0.7)',            count: weakVolume },
    { reason: 'three_finger_spread',   labelSv: 'Three Finger Spread aktivt',             count: threeFingerSpr },
    { reason: 'breakout_already',      labelSv: 'Breakout redan skett',                  count: breakoutAlrd },
    { reason: 'price_too_far_zone',    labelSv: 'Pris för långt från zonen (>1.5 ATR)',  count: farFromZone },
  ].filter(r => r.count > 0)
   .sort((a, b) => b.count - a.count)
   .map(r => ({ ...r, pct: round((r.count / total) * 100, 1) }));

  return { totalFailures: total, noTriggerSignals: noTrigger, reasons: rawReasons };
}

// ── Swedish insights ──────────────────────────────────────────────────────────

const REGIME_SV = {
  BULLISH_TREND:  'Stark upptrend',
  BEARISH_TREND:  'Stark nedtrend',
  CHOPPY:         'Stökig marknad',
  RANGE_DAY:      'Sidledsdag',
  TREND_DAY_UP:   'Trenddag uppåt',
  TREND_DAY_DOWN: 'Trenddag nedåt',
  HIGH_VOLATILITY:'Hög volatilitet',
  PANIC:          'Panikmarknad',
  BULLISH:        'Upptrend',
  BEARISH:        'Nedtrend',
  UNKNOWN:        'Okänt läge',
};

const NARROW_SV = {
  coil_flat:  'Coil Flat',
  attack_200: 'Attack 200',
  none:       'Ingen narrow-typ',
};

function buildInsightsSv({ bySymbol, byNarrowType, byHour, byMarketRegime, byScoreRange, failureAnalysis, overallWinRate }) {
  const insights = [];
  const fmtPct = v => v !== null ? `${(v * 100).toFixed(0)}%` : '–';

  // Symbol insights
  const symRanked = Object.entries(bySymbol)
    .filter(([, v]) => v.samples >= 10 && v.winRate !== null)
    .sort(([, a], [, b]) => b.winRate - a.winRate);

  if (symRanked.length > 0) {
    const [sym, s] = symRanked[0];
    insights.push(`${sym} har bäst träffsäkerhet — ${fmtPct(s.winRate)} win rate på ${s.samples} signaler.`);
  }
  if (symRanked.length > 1) {
    const [sym, s] = symRanked[symRanked.length - 1];
    insights.push(`${sym} har sämst träffsäkerhet — ${fmtPct(s.winRate)} win rate. Undvik svaga setups.`);
  }

  // NarrowType insights
  const narrowRanked = Object.entries(byNarrowType)
    .filter(([, v]) => v.samples >= 5 && v.winRate !== null)
    .sort(([, a], [, b]) => b.winRate - a.winRate);

  if (narrowRanked.length >= 2) {
    const [best, bS]  = narrowRanked[0];
    const [worst, wS] = narrowRanked[narrowRanked.length - 1];
    const bLabel = NARROW_SV[best]  || best;
    const wLabel = NARROW_SV[worst] || worst;
    insights.push(`${bLabel} (${fmtPct(bS.winRate)}) fungerar bättre än ${wLabel} (${fmtPct(wS.winRate)}) just nu.`);
  } else if (narrowRanked.length === 1) {
    const [t, s] = narrowRanked[0];
    insights.push(`${NARROW_SV[t] || t} har ${fmtPct(s.winRate)} win rate av ${s.samples} signaler.`);
  }

  // Hour insights
  const hourRanked = Object.entries(byHour)
    .filter(([, v]) => v.samples >= 5 && v.winRate !== null)
    .sort(([, a], [, b]) => b.winRate - a.winRate);

  if (hourRanked.length >= 3) {
    const topHours = hourRanked.slice(0, 3)
      .map(([h, s]) => `${h.padStart(2, '0')}:xx (${fmtPct(s.winRate)})`).join(', ');
    insights.push(`Bästa timmarna (UTC): ${topHours}.`);
  }
  if (hourRanked.length >= 2) {
    const [worstH, wHS] = hourRanked[hourRanked.length - 1];
    insights.push(`Sämsta timmen (UTC) är ${worstH.padStart(2, '0')}:xx med ${fmtPct(wHS.winRate)} win rate — handla försiktigt.`);
  }

  // Market regime insights
  const regimeRanked = Object.entries(byMarketRegime)
    .filter(([k, v]) => k !== 'UNKNOWN' && k !== 'unknown' && v.samples >= 5 && v.winRate !== null)
    .sort(([, a], [, b]) => b.winRate - a.winRate);

  if (regimeRanked.length >= 1) {
    const [regime, rs] = regimeRanked[0];
    insights.push(`${REGIME_SV[regime] || regime} ger bäst träffsäkerhet — ${fmtPct(rs.winRate)} win rate (${rs.samples} signaler).`);
  }
  if (regimeRanked.length >= 2) {
    const [regime, rs] = regimeRanked[regimeRanked.length - 1];
    insights.push(`${REGIME_SV[regime] || regime} ger fler falska signaler (${fmtPct(rs.winRate)} win rate).`);
  }

  // CHOPPY-specific
  const choppy = byMarketRegime['CHOPPY'];
  if (choppy && choppy.samples >= 3 && choppy.winRate !== null && choppy.winRate < 0.50) {
    insights.push(`CHOPPY-marknad ger fler falska signaler — undvik trading i stökiga dagar.`);
  }

  // Score range insights
  const highScore = byScoreRange['71-100'];
  const midScore  = byScoreRange['51-70'];
  const lowScore  = byScoreRange['0-30'];

  if (highScore?.winRate !== null && lowScore?.winRate !== null) {
    if (highScore.winRate > lowScore.winRate + 0.05) {
      insights.push(`TradeScore över 71 ger ${fmtPct(highScore.winRate)} win rate vs ${fmtPct(lowScore.winRate)} för score 0–30. Prioritera höga scores.`);
    } else {
      insights.push(`Score-skillnaden är liten — win rate är ${fmtPct(highScore.winRate)} vid score 71–100 och ${fmtPct(lowScore.winRate)} vid 0–30.`);
    }
  }
  if (midScore?.samples >= 10 && midScore?.winRate !== null) {
    insights.push(`Score 51–70: ${fmtPct(midScore.winRate)} win rate på ${midScore.samples} signaler — en bra mellannivå.`);
  }

  // Failure insights
  if (failureAnalysis.reasons.length > 0) {
    const top = failureAnalysis.reasons[0];
    insights.push(`Vanligaste misslyckandeanledning: ${top.labelSv} (${top.count} fall, ${top.pct}% av förluster).`);
  }
  const weakVolReason = failureAnalysis.reasons.find(r => r.reason === 'weak_volume');
  if (weakVolReason && weakVolReason.pct >= 10) {
    insights.push(`Svag volym (relVol20 < 0.7) bidrar till ${weakVolReason.pct}% av förluster — undvik signaler med låg volymkonfirmation.`);
  }
  if (failureAnalysis.totalFailures > 0 && failureAnalysis.noTriggerSignals > 0) {
    const nonDir = failureAnalysis.noTriggerSignals;
    insights.push(`${nonDir} signaler var icke-direktionella (WAIT/NEUTRAL) och räknas inte in i win rate.`);
  }

  // Overall summary
  if (overallWinRate !== null) {
    const opinion = overallWinRate >= 0.55
      ? 'över förväntan'
      : overallWinRate >= 0.50
        ? 'marginellt bättre än slump'
        : 'under 50% — granska setups';
    insights.push(`Total win rate: ${fmtPct(overallWinRate)} — ${opinion}.`);
  }

  return insights;
}

// ── Top/bottom lists ──────────────────────────────────────────────────────────

function topEntries(obj, n, sortKey = 'winRate') {
  return Object.entries(obj)
    .filter(([, v]) => v.samples >= 5 && v[sortKey] !== null)
    .sort(([, a], [, b]) => b[sortKey] - a[sortKey])
    .slice(0, n)
    .map(([key, v]) => ({ key, ...v }));
}

function bottomEntries(obj, n, sortKey = 'winRate') {
  return Object.entries(obj)
    .filter(([, v]) => v.samples >= 5 && v[sortKey] !== null)
    .sort(([, a], [, b]) => a[sortKey] - b[sortKey])
    .slice(0, n)
    .map(([key, v]) => ({ key, ...v }));
}

// ── Main engine ───────────────────────────────────────────────────────────────

/**
 * Run the Learning Engine v1.
 * Reads all outcomes + signals from disk, builds full statistical summary,
 * saves to data/signals/learning-summary.json.
 *
 * @returns {object} the learning summary
 */
function runLearningEngine() {
  console.log('[LearningEngine] Starting v1...');

  const rawOutcomes = loadAllOutcomes();
  const rawSignals  = loadAllSignals();

  console.log(`[LearningEngine] Loaded ${rawOutcomes.length} outcomes, ${rawSignals.length} signals`);

  const signalIndex = buildSignalIndex(rawSignals);
  const outcomes    = enrichOutcomes(rawOutcomes, signalIndex);

  if (outcomes.length === 0) {
    const empty = buildEmptySummary();
    saveSummary(empty);
    return empty;
  }

  // Build all dimensions
  const bySymbol       = analyzeBySymbol(outcomes);
  const byNarrowType   = analyzeByNarrowType(outcomes);
  const byState        = analyzeByState(outcomes);
  const byEventType    = analyzeByEventType(outcomes);
  const byHour         = analyzeByHour(outcomes);
  const byMarketRegime = analyzeByMarketRegime(outcomes);
  const byScoreRange   = analyzeByScoreRange(outcomes);
  const failureAnalysis = analyzeFailureReasons(outcomes);

  const overallWinRate = calcWinRate(outcomes);
  const totalSignals   = rawSignals.length;
  const totalOutcomes  = rawOutcomes.length;

  // Rankings
  const bestSymbols        = topEntries(bySymbol, 5);
  const worstSymbols       = bottomEntries(bySymbol, 3);
  const bestNarrowTypes    = topEntries(byNarrowType, 3);
  const bestEventTypes     = topEntries(byEventType, 5);
  const bestHours          = topEntries(byHour, 5);
  const bestMarketRegimes  = topEntries(byMarketRegime, 5);
  const bestScoreRanges    = Object.entries(byScoreRange)
    .filter(([, v]) => v.samples > 0 && v.winRate !== null)
    .sort(([, a], [, b]) => b.winRate - a.winRate)
    .map(([key, v]) => ({ key, ...v }));

  const insightsSv = buildInsightsSv({
    bySymbol, byNarrowType, byHour, byMarketRegime, byScoreRange, failureAnalysis, overallWinRate,
  });

  const summary = {
    updatedAt:             new Date().toISOString(),
    totalSignals,
    totalOutcomes,
    overallWinRate,

    // Full dimension maps
    bySymbol,
    byNarrowType,
    byState,
    byEventType,
    byHour,
    byMarketRegime,
    byScoreRange,
    failureAnalysis,

    // Ranked lists for quick consumption
    bestSymbols,
    worstSymbols,
    bestNarrowTypes,
    bestEventTypes,
    bestHours,
    bestMarketRegimes,
    bestScoreRanges,
    commonFailureReasons: failureAnalysis.reasons,

    // Swedish narrative
    insightsSv,
  };

  saveSummary(summary);

  const directional = outcomes.filter(o => o.success !== null).length;
  console.log(`[LearningEngine] Done — ${totalOutcomes} outcomes, ${directional} directional, win rate ${overallWinRate !== null ? (overallWinRate * 100).toFixed(1) + '%' : 'n/a'}`);
  console.log(`[LearningEngine] Insights:\n${insightsSv.map(s => '  · ' + s).join('\n')}`);

  return summary;
}

function buildEmptySummary() {
  return {
    updatedAt:             new Date().toISOString(),
    totalSignals:          0,
    totalOutcomes:         0,
    overallWinRate:        null,
    bySymbol:              {},
    byNarrowType:          {},
    byState:               {},
    byEventType:           {},
    byHour:                {},
    byMarketRegime:        {},
    byScoreRange:          {},
    failureAnalysis:       { totalFailures: 0, noTriggerSignals: 0, reasons: [] },
    bestSymbols:           [],
    worstSymbols:          [],
    bestNarrowTypes:       [],
    bestEventTypes:        [],
    bestHours:             [],
    bestMarketRegimes:     [],
    bestScoreRanges:       [],
    commonFailureReasons:  [],
    insightsSv:            ['Ingen data tillgänglig ännu — kör backfill, hunt-signals och analyze först.'],
  };
}

function saveSummary(summary) {
  try {
    const dir = path.dirname(SUMMARY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
    console.log('[LearningEngine] Saved learning-summary.json');
  } catch (err) {
    console.warn('[LearningEngine] Failed to save summary:', err.message);
  }
}

/**
 * Load the most recent learning summary from disk.
 * Returns null if not found.
 */
function loadLearningSummary() {
  try {
    if (!fs.existsSync(SUMMARY_PATH)) return null;
    return JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
  } catch (err) {
    console.warn('[LearningEngine] loadLearningSummary failed:', err.message);
    return null;
  }
}

module.exports = { runLearningEngine, loadLearningSummary };
