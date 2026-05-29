'use strict';
/**
 * AI Optimization Agent v1
 *
 * Analyzes historical paper trading data and replay runs to suggest
 * better parameter configurations. READ-ONLY — never places orders,
 * never modifies live config, never bypasses Risk Engine or Safety.
 */

const fs   = require('fs');
const path = require('path');
const strategyPerformance = require('./strategyPerformanceService');
const strategyBatchTest = require('./strategyBatchTestService');
const topStrategyGrid = require('./topStrategyGridService');

// ── Safety constants ──────────────────────────────────────────────────────────
const SAFETY = Object.freeze({
  actions_allowed:        false,
  can_place_orders:       false,
  live_trading_enabled:   false,
  agent_mode:             'analysis_only',
});

// ── Paths ─────────────────────────────────────────────────────────────────────
const TRADES_PATH   = path.join(__dirname, '../../data/paper-trading/trades.jsonl');
const STATE_PATH    = path.join(__dirname, '../../data/paper-trading/state.json');
const RUNS_DIR      = path.join(__dirname, '../../data/replay/runs');
const OPT_DIR       = path.join(__dirname, '../../data/optimization');
const OPT_SNAP_PATH = path.join(OPT_DIR, 'latest.json');

// Ensure optimization dir exists
if (!fs.existsSync(OPT_DIR)) fs.mkdirSync(OPT_DIR, { recursive: true });

// ── Data loaders ──────────────────────────────────────────────────────────────
function loadTrades() {
  try {
    if (!fs.existsSync(TRADES_PATH)) return [];
    const raw = fs.readFileSync(TRADES_PATH, 'utf8');
    return raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function loadReplayRuns() {
  try {
    if (!fs.existsSync(RUNS_DIR)) return [];
    const dirs = fs.readdirSync(RUNS_DIR);
    const runs = [];
    for (const d of dirs) {
      const summaryPath = path.join(RUNS_DIR, d, 'summary.json');
      if (fs.existsSync(summaryPath)) {
        try {
          const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
          runs.push(s);
        } catch {}
      }
    }
    return runs;
  } catch { return []; }
}

// ── Core statistics helpers ───────────────────────────────────────────────────
function stats(trades) {
  if (!trades.length) return null;
  const wins     = trades.filter(t => t.result === 'WIN').length;
  const losses   = trades.filter(t => t.result === 'LOSS').length;
  const timeouts = trades.filter(t => t.result === 'TIMEOUT').length;
  const pnls     = trades.map(t => t.pnlPct || 0);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const avgPnl   = totalPnl / trades.length;
  const winRate  = wins / trades.length;
  const timeoutRate = timeouts / trades.length;

  // drawdown: worst single trade
  const minPnl = Math.min(...pnls);

  // consistency: std dev of pnl
  const mean = avgPnl;
  const variance = pnls.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / pnls.length;
  const stdDev = Math.sqrt(variance);

  return {
    n: trades.length, wins, losses, timeouts,
    winRate: +winRate.toFixed(4),
    winRatePct: +(winRate * 100).toFixed(1),
    timeoutRate: +timeoutRate.toFixed(4),
    timeoutRatePct: +(timeoutRate * 100).toFixed(1),
    avgPnl: +avgPnl.toFixed(4),
    totalPnl: +totalPnl.toFixed(4),
    bestPnl: +Math.max(...pnls).toFixed(4),
    worstPnl: +minPnl.toFixed(4),
    stdDev: +stdDev.toFixed(4),
  };
}

function holdMinutes(trade) {
  if (!trade.entryTime || !trade.exitTime) return null;
  try {
    const e = new Date(trade.entryTime).getTime();
    const x = new Date(trade.exitTime).getTime();
    return (x - e) / 60000;
  } catch { return null; }
}

// ── Optimization Score ────────────────────────────────────────────────────────
// Score 0–100 ranking a parameter set's quality
function computeOptimizationScore(st) {
  if (!st || st.n < 3) return 0;
  let s = 0;

  // Winrate (max 35 pts)
  s += Math.min(35, st.winRatePct * 0.35);

  // Avg PnL (max 25 pts) — scale: 0.1% avg = 25 pts
  s += Math.min(25, Math.max(0, st.avgPnl * 250));

  // Low timeout rate (max 20 pts) — 0% timeout = 20 pts
  s += Math.max(0, 20 - st.timeoutRatePct * 0.4);

  // Consistency / low std dev (max 10 pts) — std dev < 0.1 = 10 pts
  s += Math.max(0, 10 - st.stdDev * 50);

  // Sample size bonus (max 10 pts) — 50+ trades = 10 pts
  s += Math.min(10, st.n * 0.2);

  return Math.round(Math.max(0, Math.min(100, s)));
}

// ── 1. Stop Loss Analysis ─────────────────────────────────────────────────────
function suggestStopLossImprovements(trades) {
  const buckets = [
    { label: 'Tight (<0.15%)',  lo: 0,    hi: 0.15,  key: 'tight' },
    { label: 'Medium (0.15-0.20%)', lo: 0.15, hi: 0.20, key: 'medium' },
    { label: 'Wide (>0.20%)',   lo: 0.20, hi: 999,   key: 'wide' },
  ];

  const results = buckets.map(b => {
    const subset = trades.filter(t => {
      const sl = t.stopPct || 0;
      return sl >= b.lo && sl < b.hi;
    });
    const st = stats(subset);
    return {
      label: b.label,
      key: b.key,
      stats: st,
      score: st ? computeOptimizationScore(st) : 0,
    };
  }).filter(r => r.stats && r.stats.n >= 3);

  const best    = [...results].sort((a, b) => b.score - a.score)[0];
  const worst   = [...results].sort((a, b) => a.score - b.score)[0];

  let recommendation = '';
  if (best?.key === 'tight') {
    recommendation = 'Tight stop loss visar bäst resultat. Prova att hålla SL under 0.15% för krypto-signaler.';
  } else if (best?.key === 'medium') {
    recommendation = 'Medium stop loss (0.15–0.20%) ger bäst balans mellan win rate och risk/reward.';
  } else if (best?.key === 'wide') {
    recommendation = 'Wide stop loss är ovanligt bra — kontrollera att det inte beror på volatile marknad.';
  }

  if (worst?.key === 'wide' && worst?.stats?.timeoutRatePct > 50) {
    recommendation += ' Wide SL orsakar för många timeouts — minska.';
  }

  return {
    buckets: results,
    bestKey: best?.key || null,
    worstKey: worst?.key || null,
    recommendation,
    ...SAFETY,
  };
}

// ── 2. Holding Time Analysis ──────────────────────────────────────────────────
function suggestHoldingTimeImprovements(trades) {
  const buckets = [
    { label: 'Kort (0–5 min)',     lo: 0,  hi: 5  },
    { label: 'Medium-kort (5–10 min)', lo: 5,  hi: 10 },
    { label: 'Medium (10–15 min)', lo: 10, hi: 15 },
    { label: 'Lång (15–25 min)',   lo: 15, hi: 25 },
    { label: 'Mycket lång (25+ min)', lo: 25, hi: 999 },
  ];

  const results = buckets.map(b => {
    const subset = trades.filter(t => {
      const m = holdMinutes(t);
      return m !== null && m >= b.lo && m < b.hi;
    });
    const st = stats(subset);
    return {
      label: b.label,
      minMin: b.lo,
      maxMin: b.hi === 999 ? null : b.hi,
      stats: st,
      score: st ? computeOptimizationScore(st) : 0,
    };
  }).filter(r => r.stats && r.stats.n >= 2);

  const best  = [...results].sort((a, b) => b.score - a.score)[0];

  // Timeout analysis
  const timeoutTrades = trades.filter(t => t.result === 'TIMEOUT');
  const avgTimeoutHold = timeoutTrades.length > 0
    ? timeoutTrades.reduce((a, t) => a + (holdMinutes(t) || 0), 0) / timeoutTrades.length
    : null;

  const recommendations = [];
  if (best) {
    recommendations.push(`Bästa hålltid: ${best.label} (${best.stats.winRatePct}% win rate).`);
  }
  if (avgTimeoutHold !== null) {
    recommendations.push(`Snitt hålltid för timeouts: ${avgTimeoutHold.toFixed(1)} min — trade-timeout kan justeras.`);
  }

  // Check if short trades win much more
  const shortSt = results.find(r => r.minMin === 0);
  const longSt  = results.find(r => r.minMin >= 15);
  if (shortSt && longSt && shortSt.stats && longSt.stats) {
    const diff = shortSt.stats.winRatePct - longSt.stats.winRatePct;
    if (diff > 20) {
      recommendations.push(`Korta trades (0–5 min) vinner ${diff.toFixed(0)}% oftare än långa — undvik att hålla för länge.`);
    }
  }

  return {
    buckets: results,
    bestRange: best ? { min: best.minMin, max: best.maxMin } : null,
    avgTimeoutHoldMin: avgTimeoutHold ? +avgTimeoutHold.toFixed(1) : null,
    recommendations,
    ...SAFETY,
  };
}

// ── 3. Exit Analysis ──────────────────────────────────────────────────────────
function suggestExitImprovements(trades) {
  const exitGroups = {};
  for (const t of trades) {
    const er = t.exitReason || 'UNKNOWN';
    if (!exitGroups[er]) exitGroups[er] = [];
    exitGroups[er].push(t);
  }

  const exitResults = Object.entries(exitGroups).map(([reason, ts]) => {
    const st = stats(ts);
    const category = reason.startsWith('EXIT_ENGINE') ? 'Motor'
      : reason === 'TARGET_HIT' ? 'Vinstmål'
      : reason === 'STOP_HIT'   ? 'Stop Loss'
      : reason === 'TIMEOUT'    ? 'Timeout'
      : 'Övrigt';
    return {
      reason,
      reasonSv: exitReasonSv(reason),
      category,
      stats: st,
      score: st ? computeOptimizationScore(st) : 0,
    };
  }).filter(r => r.stats && r.stats.n >= 2)
    .sort((a, b) => b.score - a.score);

  const best  = exitResults[0];
  const worst = exitResults[exitResults.length - 1];

  const timeoutCount = (exitGroups['TIMEOUT'] || []).length;
  const total = trades.length;
  const timeoutPct = total > 0 ? (timeoutCount / total * 100).toFixed(1) : 0;

  const recommendations = [];
  if (parseFloat(timeoutPct) > 40) {
    recommendations.push(`⚠️ Timeout-rate ${timeoutPct}% är för hög. Minska maxHoldMinutes eller använd dynamisk exit.`);
  }
  if (best) {
    recommendations.push(`Bästa exit: ${best.reasonSv} — ${best.stats.winRatePct}% win rate.`);
  }

  // Exit engine vs manual
  const motorExits = trades.filter(t => (t.exitReason || '').startsWith('EXIT_ENGINE'));
  const manualExits = trades.filter(t => !(t.exitReason || '').startsWith('EXIT_ENGINE'));
  const motorSt = stats(motorExits);
  const manualSt = stats(manualExits);

  return {
    byReason: exitResults,
    timeoutCount,
    timeoutPct: parseFloat(timeoutPct),
    motorExitStats: motorSt,
    manualExitStats: manualSt,
    recommendations,
    ...SAFETY,
  };
}

function exitReasonSv(reason) {
  const map = {
    'TARGET_HIT':                        'Vinstmål nått',
    'STOP_HIT':                          'Stop loss träffad',
    'TIMEOUT':                           'Timeout',
    'EXIT_ENGINE_TIMEOUT_INTELLIGENCE':  'Motor: timeout+intelligens',
    'EXIT_ENGINE_TIGHTENED_STOP':        'Motor: åtstramad stop',
    'EXIT_ENGINE_TARGET_HIT':            'Motor: vinstmål nått',
    'EXIT_ENGINE_MOMENTUM_FADE':         'Motor: momentum försvann',
    'EXIT_ENGINE_NEAR_TARGET_PROFIT':    'Motor: nära vinstmål',
  };
  return map[reason] || reason.replace(/_/g, ' ').toLowerCase();
}

// ── 4. Signal Combinations Analysis ──────────────────────────────────────────
function suggestSignalCombinations(trades) {
  // Group by signalFamily + volumeState combinations
  const combos = {};
  for (const t of trades) {
    const fam = t.signalFamily || 'unknown';
    const vol = t.volumeState || 'unknown';
    const dir = t.direction || 'unknown';
    const key = `${fam}|${vol}`;
    if (!combos[key]) combos[key] = { fam, vol, dir, trades: [] };
    combos[key].trades.push(t);
  }

  const comboResults = Object.entries(combos).map(([key, { fam, vol, trades: ts }]) => {
    const st = stats(ts);
    return {
      key,
      signalFamily: fam,
      signalFamilySv: signalFamilySv(fam),
      volumeState: vol,
      label: `${signalFamilySv(fam)} + ${volumeSv(vol)}`,
      stats: st,
      score: st ? computeOptimizationScore(st) : 0,
    };
  }).filter(r => r.stats && r.stats.n >= 3)
    .sort((a, b) => b.score - a.score);

  const best  = comboResults.slice(0, 3);
  const worst = [...comboResults].sort((a, b) => a.score - b.score).slice(0, 2);

  // Family standalone
  const byFamily = {};
  for (const t of trades) {
    const f = t.signalFamily || 'unknown';
    if (!byFamily[f]) byFamily[f] = [];
    byFamily[f].push(t);
  }
  const familyResults = Object.entries(byFamily).map(([fam, ts]) => {
    const st = stats(ts);
    return {
      signalFamily: fam,
      signalFamilySv: signalFamilySv(fam),
      stats: st,
      score: st ? computeOptimizationScore(st) : 0,
    };
  }).filter(r => r.stats).sort((a, b) => b.score - a.score);

  return {
    byCombination: comboResults.slice(0, 10),
    byFamily: familyResults,
    bestCombinations: best,
    weakCombinations: worst,
    ...SAFETY,
  };
}

function signalFamilySv(fam) {
  const map = {
    'VWAP_RECLAIM_REJECTION': 'VWAP återtagning/avvisning',
    'EMA_TREND_PULLBACK':     'EMA trend + rekyl',
    'NARROW_STATE_BREAKOUT':  'Narrow state utbrott',
    'MOMENTUM_CONTINUATION':  'Momentum fortsättning',
    'LIQUIDITY_SWEEP':        'Likviditetsfälla',
  };
  return map[fam] || fam.replace(/_/g, ' ');
}

function volumeSv(v) {
  const map = { strong:'stark volym', moderate:'normal volym', weak:'svag volym', very_strong:'mycket stark volym' };
  return map[v] || v;
}

// ── 5. Market Type Analysis ───────────────────────────────────────────────────
function analyzeMarketTypes(trades) {
  const byMarket = {};
  for (const t of trades) {
    const m = t.marketType || 'unknown';
    if (!byMarket[m]) byMarket[m] = [];
    byMarket[m].push(t);
  }

  const marketResults = Object.entries(byMarket).map(([market, ts]) => {
    const st = stats(ts);
    // Best exit reason for this market
    const exitReasons = {};
    ts.forEach(t => {
      const r = t.exitReason || 'unknown';
      exitReasons[r] = (exitReasons[r] || 0) + 1;
    });
    const bestExit = Object.entries(exitReasons).sort((a, b) => b[1] - a[1])[0]?.[0];

    // Avg hold time
    const holds = ts.map(holdMinutes).filter(v => v !== null);
    const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;

    return {
      market,
      marketSv: marketSv(market),
      stats: st,
      score: st ? computeOptimizationScore(st) : 0,
      mostCommonExit: bestExit ? exitReasonSv(bestExit) : null,
      avgHoldMin: avgHold ? +avgHold.toFixed(1) : null,
    };
  }).filter(r => r.stats).sort((a, b) => b.score - a.score);

  const recommendations = [];
  const stocksResult = marketResults.find(r => r.market === 'stocks');
  const cryptoResult = marketResults.find(r => r.market === 'crypto');

  if (stocksResult && cryptoResult) {
    const diff = stocksResult.stats.winRatePct - cryptoResult.stats.winRatePct;
    if (diff > 15) {
      recommendations.push(`Aktier vinner ${diff.toFixed(0)}% oftare än krypto. Prioritera aktie-signaler.`);
    }
    if (cryptoResult.stats.timeoutRatePct > stocksResult.stats.timeoutRatePct + 20) {
      recommendations.push(`Krypto har ${(cryptoResult.stats.timeoutRatePct - stocksResult.stats.timeoutRatePct).toFixed(0)}% fler timeouts — justera hålltid för krypto separat.`);
    }
  }

  return { markets: marketResults, recommendations, ...SAFETY };
}

function marketSv(m) {
  const map = { crypto:'Krypto', stocks:'Aktier', nasdaq:'Nasdaq', etf:'ETF', index:'Index' };
  return map[m] || m;
}

// ── 6. Confidence Threshold Analysis ─────────────────────────────────────────
function analyzeConfidenceThresholds(trades) {
  const buckets = [
    { label: 'Låg (0–40)',      lo: 0,  hi: 40  },
    { label: 'Medium (40–60)',  lo: 40, hi: 60  },
    { label: 'Hög (60–80)',     lo: 60, hi: 80  },
    { label: 'Mycket hög (80+)',lo: 80, hi: 999 },
  ];

  const results = buckets.map(b => {
    const subset = trades.filter(t => {
      const c = t.confidenceScore || 0;
      return c >= b.lo && c < b.hi;
    });
    const st = stats(subset);
    return {
      label: b.label,
      lo: b.lo, hi: b.hi === 999 ? null : b.hi,
      stats: st,
      score: st ? computeOptimizationScore(st) : 0,
    };
  }).filter(r => r.stats && r.stats.n >= 3);

  const best = [...results].sort((a, b) => b.score - a.score)[0];

  const recommendations = [];
  if (best) {
    recommendations.push(`Bästa styrketröskell: ${best.label} — sätter ${best.stats.winRatePct}% win rate.`);
  }

  // Check if high confidence is actually worse (surprising)
  const highConf = results.find(r => r.lo === 80);
  const medConf  = results.find(r => r.lo === 40);
  if (highConf && medConf && medConf.score > highConf.score) {
    recommendations.push('Medel-styrka (40–60) presterar bättre än hög styrka (80+) — troligen tar systemet för tidiga entries vid hög confidence.');
  }

  return { buckets: results, bestRange: best ? { lo: best.lo, hi: best.hi } : null, recommendations, ...SAFETY };
}

// ── 7. Compare Parameter Sets / Top Configurations ───────────────────────────
function rankBestConfigurations(trades) {
  // Build configs based on actual combinations in data
  const configs = [];

  // Config 1: VWAP + Strong volume + short hold + tight target
  const c1 = trades.filter(t =>
    t.signalFamily === 'VWAP_RECLAIM_REJECTION' &&
    t.volumeState === 'strong' &&
    (holdMinutes(t) || 99) <= 12 &&
    (t.targetPct || 0) <= 0.20
  );
  if (c1.length >= 3) {
    const st = stats(c1);
    configs.push({
      id: 'c1',
      label: 'VWAP + Stark volym + Kort hålltid + Tight target',
      params: { signalFamily: 'VWAP återtagning', volumeState: 'Stark', maxHold: '≤12 min', target: '≤0.20%' },
      stats: st,
      score: computeOptimizationScore(st),
    });
  }

  // Config 2: VWAP + Strong volume + 12m hold
  const c2 = trades.filter(t =>
    t.signalFamily === 'VWAP_RECLAIM_REJECTION' &&
    t.volumeState === 'strong' &&
    t.maxHoldMinutes === 12
  );
  if (c2.length >= 3) {
    const st = stats(c2);
    configs.push({
      id: 'c2',
      label: 'VWAP + Stark volym + 12 min maxhåll',
      params: { signalFamily: 'VWAP återtagning', volumeState: 'Stark', maxHold: '12 min' },
      stats: st,
      score: computeOptimizationScore(st),
    });
  }

  // Config 3: Stocks only
  const c3 = trades.filter(t => t.marketType === 'stocks');
  if (c3.length >= 3) {
    const st = stats(c3);
    configs.push({
      id: 'c3',
      label: 'Aktier (alla parametrar)',
      params: { market: 'Aktier' },
      stats: st,
      score: computeOptimizationScore(st),
    });
  }

  // Config 4: TARGET_HIT exits
  const c4 = trades.filter(t => t.exitReason === 'TARGET_HIT' || t.exitReason === 'EXIT_ENGINE_TARGET_HIT');
  if (c4.length >= 2) {
    const st = stats(c4);
    configs.push({
      id: 'c4',
      label: 'Vinstmål-exit (alla typer)',
      params: { exit: 'TARGET_HIT' },
      stats: st,
      score: computeOptimizationScore(st),
    });
  }

  // Config 5: Short hold time (0-8m)
  const c5 = trades.filter(t => (holdMinutes(t) || 99) <= 8);
  if (c5.length >= 3) {
    const st = stats(c5);
    configs.push({
      id: 'c5',
      label: 'Kort hålltid (0–8 min)',
      params: { maxHold: '0–8 min' },
      stats: st,
      score: computeOptimizationScore(st),
    });
  }

  // Config 6: EMA Trend pullback (to detect weakness)
  const c6 = trades.filter(t => t.signalFamily === 'EMA_TREND_PULLBACK');
  if (c6.length >= 3) {
    const st = stats(c6);
    configs.push({
      id: 'c6',
      label: 'EMA Trend + Rekyl (svag konfiguration)',
      params: { signalFamily: 'EMA rekyl' },
      stats: st,
      score: computeOptimizationScore(st),
    });
  }

  return configs.sort((a, b) => b.score - a.score);
}

function detectWeakConfigurations(trades) {
  const configs = rankBestConfigurations(trades);
  return configs.filter(c => c.score < 30).map(c => ({
    ...c,
    warning: buildWeakWarning(c),
  }));
}

function buildWeakWarning(config) {
  if (!config.stats) return 'Otillräcklig data.';
  const { winRatePct, timeoutRatePct, avgPnl } = config.stats;
  if (timeoutRatePct > 60) return `${timeoutRatePct}% timeout-rate — för lång hålltid eller för svag signal.`;
  if (winRatePct < 20) return `${winRatePct}% win rate — undvik denna kombination.`;
  if (avgPnl < -0.05) return `Negativ snitt-P/L (${avgPnl.toFixed(3)}%) — kapitalförlust.`;
  return 'Låg poäng — behöver förbättras.';
}

// ── 8. Recommendations Engine ─────────────────────────────────────────────────
function buildRecommendations(trades) {
  const recs = { green: [], yellow: [], red: [] };

  if (!trades.length) {
    recs.yellow.push('Ingen handelsdata tillgänglig ännu. Kör paper trading för att samla data.');
    return recs;
  }

  const totalTimeouts = trades.filter(t => t.result === 'TIMEOUT').length;
  const timeoutPct = totalTimeouts / trades.length * 100;

  // === GREEN: proven wins ===
  const stockTrades = trades.filter(t => t.marketType === 'stocks');
  if (stockTrades.length >= 5) {
    const st = stats(stockTrades);
    if (st.winRatePct > 50) {
      recs.green.push(`Prioritera aktie-signaler — ${st.winRatePct}% win rate (${st.n} trades)`);
    }
  }

  const shortHold = trades.filter(t => (holdMinutes(t) || 99) <= 8);
  if (shortHold.length >= 5) {
    const st = stats(shortHold);
    if (st.winRatePct > 50) {
      recs.green.push(`Korta hålltider (0–8 min) vinner ${st.winRatePct}% — använd tight target + snabb exit`);
    }
  }

  const tightTarget = trades.filter(t => (t.targetPct || 1) <= 0.20);
  if (tightTarget.length >= 5) {
    const st = stats(tightTarget);
    if (st.winRatePct > 45) {
      recs.green.push(`Tight target (≤0.20%) ger ${st.winRatePct}% win rate — fortsätt med detta`);
    }
  }

  const vwapTrades = trades.filter(t => t.signalFamily === 'VWAP_RECLAIM_REJECTION' && t.volumeState === 'strong');
  if (vwapTrades.length >= 10) {
    const st = stats(vwapTrades);
    if (st.winRatePct > 40) {
      recs.green.push(`VWAP + Stark volym är kärn-kombinationen — ${st.winRatePct}% WR på ${st.n} trades`);
    }
  }

  // === YELLOW: needs more data or mixed results ===
  if (timeoutPct > 30 && timeoutPct <= 50) {
    recs.yellow.push(`${timeoutPct.toFixed(0)}% timeout-rate — överväg att minska maxHoldMinutes`);
  }

  const medConf = trades.filter(t => t.confidenceScore >= 40 && t.confidenceScore < 60);
  const hiConf  = trades.filter(t => t.confidenceScore >= 80);
  if (medConf.length >= 5 && hiConf.length >= 5) {
    const mSt = stats(medConf);
    const hSt = stats(hiConf);
    if (mSt.avgPnl > hSt.avgPnl) {
      recs.yellow.push(`Medium-styrka (40–60) ger bättre snitt-PnL än hög styrka (80+) — sänk confidence-tröskeln något`);
    }
  }

  const emaTrades = trades.filter(t => t.signalFamily === 'EMA_TREND_PULLBACK');
  if (emaTrades.length >= 3) {
    const st = stats(emaTrades);
    if (st.winRatePct < 30) {
      recs.yellow.push(`EMA Trend+Rekyl presterar svagt (${st.winRatePct}% WR) — behöver mer data eller annan approach`);
    }
  }

  // === RED: proven weak ===
  if (timeoutPct > 50) {
    recs.red.push(`KRITISK: ${timeoutPct.toFixed(0)}% av trades slutar i timeout — systemet håller positioner för länge`);
  }

  const wideSL = trades.filter(t => (t.stopPct || 0) > 0.20);
  if (wideSL.length >= 5) {
    const st = stats(wideSL);
    if (st.winRatePct < 20) {
      recs.red.push(`Wide stop loss (>0.20%) ger bara ${st.winRatePct}% WR — undvik bred SL`);
    }
  }

  const wideTarget = trades.filter(t => (t.targetPct || 0) >= 0.4);
  if (wideTarget.length >= 5) {
    const st = stats(wideTarget);
    if (st.winRatePct < 20) {
      recs.red.push(`Stora vinstmål (≥0.4%) nås bara ${st.winRatePct}% av gångerna — sänk target`);
    }
  }

  const longHold = trades.filter(t => (holdMinutes(t) || 0) >= 15);
  if (longHold.length >= 5) {
    const st = stats(longHold);
    if (st.winRatePct < 15) {
      recs.red.push(`Lång hålltid (15+ min) vinner bara ${st.winRatePct}% — stoppa hellre tidigt`);
    }
  }

  return recs;
}

function buildBestStrategyByMarket(strategies) {
  const best = {};
  for (const strategy of strategies) {
    for (const market of strategy.markets || []) {
      const key = market.market_group || 'all';
      const current = best[key];
      const candidate = {
        strategy_id: strategy.strategy_id,
        strategy_name: strategy.strategy_name,
        market_group: key,
        win_rate: market.win_rate,
        avg_pnl: market.avg_pnl,
        trades: market.trades,
        score: strategy.score,
      };
      if (!current || candidate.avg_pnl > current.avg_pnl || candidate.score > current.score) best[key] = candidate;
    }
  }
  return best;
}

function buildBestFieldByStrategy(strategies, field) {
  return strategies.reduce((acc, strategy) => {
    const best = (strategy.params || [])[0];
    if (best) {
      acc[strategy.strategy_id] = {
        strategy_name: strategy.strategy_name,
        [field]: best[field],
        label: best.label,
        win_rate: best.win_rate,
        avg_pnl: best.avg_pnl,
        trades: best.trades,
      };
    }
    return acc;
  }, {});
}

function buildBestExitByStrategy(strategies) {
  return strategies.reduce((acc, strategy) => {
    const best = (strategy.params || [])[0];
    if (best) {
      acc[strategy.strategy_id] = {
        strategy_name: strategy.strategy_name,
        sl: best.sl,
        tp: best.tp,
        holding_time: best.holding_time,
        label: best.label,
        avg_pnl: best.avg_pnl,
        trades: best.trades,
      };
    }
    return acc;
  }, {});
}

function buildBatchOptimizationSummary(batchComparison) {
  if (!batchComparison?.ok || !batchComparison.batch?.id) {
    return {
      latestBatch: {},
      recommendations: ['Inga batch-resultat ännu. Kör Batch-test i Trading Lab för att optimera strategier.'],
      ...strategyBatchTest.SAFETY,
    };
  }
  const best = batchComparison.recommended_config?.strategy_id ? batchComparison.recommended_config : null;
  const bestSl = batchComparison.by_stop_loss?.[0] || null;
  const bestTp = batchComparison.by_take_profit?.[0] || null;
  const bestHold = batchComparison.by_holding_time?.[0] || null;
  const bestConf = batchComparison.by_confidence?.[0] || null;
  const pauseCandidates = (batchComparison.best_per_strategy || [])
    .filter((row) => row.trades >= 25 && (row.win_rate < 40 || row.avg_pnl < 0 || row.score < 35));
  const needsMoreData = batchComparison.needs_more_data || [];
  const recommendations = [];

  if (best) recommendations.push(`Bästa batch-kombination: ${best.strategy_name} ${best.symbol}, SL ${best.stop_loss}%, TP ${best.take_profit}R, ${best.holding_time}m, confidence ${best.confidence_threshold}.`);
  if (bestSl) recommendations.push(`Bästa SL i batch: ${bestSl.key}% (${bestSl.avg_score} score).`);
  if (bestTp) recommendations.push(`Bästa TP i batch: ${bestTp.key}R (${bestTp.avg_score} score).`);
  if (bestHold) recommendations.push(`Bästa hålltid i batch: ${bestHold.key} min (${bestHold.avg_score} score).`);
  if (bestConf) recommendations.push(`Bästa confidence i batch: ${bestConf.key} (${bestConf.avg_score} score).`);
  if (pauseCandidates.length) recommendations.push(`${pauseCandidates.length} strategier bör pausas eller testas om med snävare parametrar.`);
  if (needsMoreData.length) recommendations.push(`${needsMoreData.length} kombinationer behöver mer data.`);

  return {
    latestBatch: {
      id: batchComparison.batch.id,
      name: batchComparison.batch.name,
      status: batchComparison.batch.status,
      progress: batchComparison.batch.progress,
    },
    bestStrategy: best ? { strategy_id: best.strategy_id, strategy_name: best.strategy_name, score: best.score } : {},
    bestStopLoss: bestSl || {},
    bestTakeProfit: bestTp || {},
    bestHoldingTime: bestHold || {},
    bestConfidence: bestConf || {},
    pauseCandidates,
    needsMoreData,
    recommendations,
    ...strategyBatchTest.SAFETY,
  };
}

function buildTopStrategyGridAdvice(gridSummary) {
  if (!gridSummary?.ok || !gridSummary.combination_count) {
    return {
      bestOverall: {},
      bestPerStrategy: [],
      recommendations: ['Inga top-grid-resultat ännu. Kör Top Strategy Parameter Grid för de bästa nya strategierna.'],
      ...topStrategyGrid.SAFETY,
    };
  }
  const bestOverall = gridSummary.best_overall?.[0] || {};
  const needsMoreData = (gridSummary.best_per_strategy || []).filter((row) => (row.best?.trades_count || 0) < 25);
  const pauseCandidates = (gridSummary.best_per_strategy || []).filter((row) => row.best && row.best.score < 40);
  const recommendations = [...(gridSummary.recommendations || [])];
  if (needsMoreData.length) recommendations.push(`${needsMoreData.length} top-strategier behöver fler trades innan slutsats.`);
  if (pauseCandidates.length) recommendations.push(`${pauseCandidates.length} top-strategier bör pausas i optimering tills bättre parametrar hittas.`);
  return {
    bestOverall,
    bestPerStrategy: gridSummary.best_per_strategy || [],
    bestSymbols: gridSummary.by_symbol || [],
    bestTimeframes: gridSummary.by_timeframe || [],
    needsMoreData,
    pauseCandidates,
    recommendations,
    note_sv: gridSummary.note_sv,
    ...topStrategyGrid.SAFETY,
  };
}

// ── 9. Full Optimization Summary ──────────────────────────────────────────────
function buildOptimizationSummary() {
  const trades = loadTrades();
  const runs   = loadReplayRuns();

  const overallStats = stats(trades);
  const overallScore = overallStats ? computeOptimizationScore(overallStats) : 0;

  const slAnalysis     = suggestStopLossImprovements(trades);
  const holdAnalysis   = suggestHoldingTimeImprovements(trades);
  const exitAnalysis   = suggestExitImprovements(trades);
  const comboAnalysis  = suggestSignalCombinations(trades);
  const marketAnalysis = analyzeMarketTypes(trades);
  const confAnalysis   = analyzeConfidenceThresholds(trades);
  const topConfigs     = rankBestConfigurations(trades);
  const weakConfigs    = detectWeakConfigurations(trades);
  const recommendations = buildRecommendations(trades);
  const daytradingStrategies = strategyPerformance.getStrategyPerformance();
  const batchComparison = strategyBatchTest.getLatestBatchComparison();
  const topGridSummary = topStrategyGrid.getSummary();

  const summary = {
    generatedAt: new Date().toISOString(),
    tradeCount: trades.length,
    replayRunCount: runs.length,
    overallStats,
    overallScore,
    stopLoss:     slAnalysis,
    holdingTime:  holdAnalysis,
    exits:        exitAnalysis,
    combinations: comboAnalysis,
    markets:      marketAnalysis,
    confidence:   confAnalysis,
    topConfigs,
    weakConfigs,
    recommendations,
    daytradingStrategies: {
      bestStrategy: daytradingStrategies.strategies?.[0] || null,
      bestByMarket: buildBestStrategyByMarket(daytradingStrategies.strategies || []),
      bestHoldingTimeByStrategy: buildBestFieldByStrategy(daytradingStrategies.strategies || [], 'holding_time'),
      bestExitByStrategy: buildBestExitByStrategy(daytradingStrategies.strategies || []),
      pauseCandidates: (daytradingStrategies.strategies || []).filter((s) => s.trades >= 30 && (s.win_rate < 40 || s.avg_pnl < 0)),
      needsMoreData: daytradingStrategies.needs_more_data || [],
      ...strategyPerformance.SAFETY,
    },
    strategyBatchTesting: buildBatchOptimizationSummary(batchComparison),
    topStrategyGrid: buildTopStrategyGridAdvice(topGridSummary),
    ...SAFETY,
  };

  // Persist snapshot
  try {
    fs.writeFileSync(OPT_SNAP_PATH, JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('[opt-agent] Failed to write snapshot:', err.message);
  }

  return summary;
}

// ── 10. Status endpoint ───────────────────────────────────────────────────────
function getOptimizationStatus() {
  const trades = loadTrades();
  const runs   = loadReplayRuns();

  let lastRun = null;
  if (fs.existsSync(OPT_SNAP_PATH)) {
    try {
      const snap = JSON.parse(fs.readFileSync(OPT_SNAP_PATH, 'utf8'));
      lastRun = snap.generatedAt;
    } catch {}
  }

  return {
    ok: true,
    tradeCount: trades.length,
    replayRunCount: runs.length,
    hasSnapshot: fs.existsSync(OPT_SNAP_PATH),
    lastRunAt: lastRun,
    dataAdequacy: trades.length >= 30 ? 'good' : trades.length >= 10 ? 'limited' : 'insufficient',
    dataAdequacySv: trades.length >= 30 ? 'Tillräcklig data' : trades.length >= 10 ? 'Begränsad data' : 'För lite data',
    ...SAFETY,
  };
}

// ── 11. Cached summary (rebuilt every 5 min) ──────────────────────────────────
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function getCachedSummary() {
  if (!_cache || Date.now() - _cacheTime > CACHE_TTL) {
    _cache = buildOptimizationSummary();
    _cacheTime = Date.now();
  }
  return _cache;
}

// ── 13. Recommended Config — concrete parameter values derived from data ──────
function signalFamilyToToggleKey(family) {
  const map = {
    'VWAP_RECLAIM_REJECTION': 'vwap_reclaim',
    'EMA_TREND_PULLBACK':     'ema_pullback',
    'NARROW_STATE_BREAKOUT':  'narrow_state',
    'MOMENTUM_CONTINUATION':  'momentum',
    'LIQUIDITY_SWEEP':        'volume_spike',
  };
  return map[family] || null;
}

function getRecommendedConfig() {
  const trades = loadTrades();
  if (!trades.length) {
    return { changes: [], tradeCount: 0, hasEnoughData: false, ...SAFETY };
  }

  const slAna   = suggestStopLossImprovements(trades);
  const holdAna = suggestHoldingTimeImprovements(trades);
  const confAna = analyzeConfidenceThresholds(trades);
  const comboAna= suggestSignalCombinations(trades);
  const exitAna = suggestExitImprovements(trades);

  const changes = [];

  // ── Stop Loss ──
  const bestSlBucket = slAna.buckets?.find(b => b.key === slAna.bestKey);
  if (bestSlBucket && slAna.bestKey === 'tight') {
    changes.push({
      id: 'sl_tight',
      type: 'param',
      key: 'stop_loss',
      label: 'Stop Loss',
      unit: '%',
      recommendedValue: 0.12,
      rationale: `Tight SL (<0.15%) ger ${bestSlBucket.stats.winRatePct}% win rate (${bestSlBucket.stats.n} trades) vs wide SL bara ${slAna.buckets.find(b=>b.key==='wide')?.stats?.winRatePct||'?'}%`,
      impact: 'high',
      category: 'param',
    });
  } else if (bestSlBucket && slAna.bestKey === 'medium') {
    changes.push({
      id: 'sl_medium',
      type: 'param',
      key: 'stop_loss',
      label: 'Stop Loss',
      unit: '%',
      recommendedValue: 0.18,
      rationale: `Medium SL (0.15–0.20%) ger ${bestSlBucket.stats.winRatePct}% win rate`,
      impact: 'medium',
      category: 'param',
    });
  }

  // ── Holding Time ──
  const bestHold = holdAna.buckets?.[0];
  if (bestHold?.maxMin !== null && bestHold?.maxMin !== undefined && bestHold.stats) {
    const suggestedHold = bestHold.maxMin ?? 8;
    changes.push({
      id: 'hold_shorten',
      type: 'param',
      key: 'holding_time',
      label: 'Hålltid',
      unit: 'min',
      recommendedValue: suggestedHold,
      rationale: `${bestHold.label} ger ${bestHold.stats.winRatePct}% WR — längre trades tappar kraftigt`,
      impact: 'high',
      category: 'param',
    });
    // Timeout should match holding time
    if (holdAna.avgTimeoutHoldMin && holdAna.avgTimeoutHoldMin > suggestedHold) {
      changes.push({
        id: 'timeout_match',
        type: 'param',
        key: 'timeout',
        label: 'Timeout',
        unit: 'min',
        recommendedValue: suggestedHold,
        rationale: `Matcha timeout med hålltid (${suggestedHold} min) — snitt timeout-hålltid är ${holdAna.avgTimeoutHoldMin} min`,
        impact: 'medium',
        category: 'param',
      });
    }
  }

  // ── Confidence Threshold ──
  const bestConf = confAna.buckets?.[0];
  if (bestConf?.lo !== undefined && bestConf.stats) {
    const hi = bestConf.hi ?? bestConf.lo + 20;
    const midpoint = Math.round((bestConf.lo + hi) / 2);
    changes.push({
      id: 'conf_threshold',
      type: 'param',
      key: 'confidence_threshold',
      label: 'Styrketröskell',
      unit: '/100',
      recommendedValue: midpoint,
      rationale: `${bestConf.label} ger bäst snitt P/L (${(bestConf.stats.avgPnl*100).toFixed(3)}%)`,
      impact: 'medium',
      category: 'param',
    });
  }

  // ── Disable weak signal combinations ──
  const weakFamilies = (comboAna.byFamily || []).filter(
    f => f.stats && f.stats.winRatePct < 20 && f.stats.n >= 5
  );
  for (const fam of weakFamilies) {
    const toggleKey = signalFamilyToToggleKey(fam.signalFamily);
    if (toggleKey) {
      changes.push({
        id: `toggle_off_${toggleKey}`,
        type: 'toggle',
        key: toggleKey,
        label: fam.signalFamilySv,
        unit: '',
        recommendedValue: false,
        rationale: `${fam.signalFamilySv}: bara ${fam.stats.winRatePct}% WR på ${fam.stats.n} trades`,
        impact: 'medium',
        category: 'toggle',
      });
    }
  }

  // ── Exit recommendations ──
  const timeoutPct = exitAna.timeoutPct || 0;
  if (timeoutPct > 40) {
    changes.push({
      id: 'exit_time_off',
      type: 'exit',
      key: 'time_exit',
      label: 'Tidsbaserad exit',
      unit: '',
      recommendedValue: false,
      rationale: `${timeoutPct.toFixed(0)}% timeout-rate — tidsbaserad exit orsakar de flesta timeouts`,
      impact: 'high',
      category: 'exit',
    });
    changes.push({
      id: 'exit_trailing_on',
      type: 'exit',
      key: 'trailing_stop',
      label: 'Trailing Stop',
      unit: '',
      recommendedValue: true,
      rationale: 'Ersätt tidsbaserad exit med trailing stop — låser in vinst istället för att stänga på tid',
      impact: 'medium',
      category: 'exit',
    });
  }

  // Best exit type
  const bestExit = (exitAna.byReason || []).find(r => r.stats?.winRatePct === 100 || r.stats?.score >= 80);
  if (bestExit?.reason === 'TARGET_HIT' || bestExit?.reason === 'EXIT_ENGINE_TARGET_HIT') {
    changes.push({
      id: 'exit_profit_on',
      type: 'exit',
      key: 'profit_target',
      label: 'Vinstmål',
      unit: '',
      recommendedValue: true,
      rationale: `Vinstmål-exit har ${bestExit.stats.winRatePct}% WR (${bestExit.stats.n} trades) — alltid på`,
      impact: 'high',
      category: 'exit',
    });
  }

  // Sort: high impact first
  const impactOrder = { high: 0, medium: 1, low: 2 };
  changes.sort((a, b) => (impactOrder[a.impact] ?? 2) - (impactOrder[b.impact] ?? 2));

  return {
    changes,
    tradeCount: trades.length,
    hasEnoughData: trades.length >= 10,
    generatedAt: new Date().toISOString(),
    ...SAFETY,
  };
}

// ── 12. Parameter comparison helper ──────────────────────────────────────────
function compareParameterSets() {
  const trades = loadTrades();
  return {
    stopLoss:    suggestStopLossImprovements(trades),
    holdingTime: suggestHoldingTimeImprovements(trades),
    exits:       suggestExitImprovements(trades),
    confidence:  analyzeConfidenceThresholds(trades),
    ...SAFETY,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Core analysis
  analyzeOptimizationCandidates:   () => { const t = loadTrades(); return { trades: t.length, ...stats(t), ...SAFETY }; },
  compareParameterSets,
  rankBestConfigurations:          () => rankBestConfigurations(loadTrades()),
  detectWeakConfigurations:        () => detectWeakConfigurations(loadTrades()),
  suggestExitImprovements:         () => suggestExitImprovements(loadTrades()),
  getRecommendedConfig,
  suggestHoldingTimeImprovements:  () => suggestHoldingTimeImprovements(loadTrades()),
  suggestStopLossImprovements:     () => suggestStopLossImprovements(loadTrades()),
  suggestSignalCombinations:       () => suggestSignalCombinations(loadTrades()),
  buildOptimizationSummary,
  getCachedSummary,
  getOptimizationStatus,
  SAFETY,
};
