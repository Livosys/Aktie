'use strict';

// ────────────────────────────────────────────────────────────────────────────
// Narrow Performance Learning Service (v1)
//
// A narrow, read-only analysis layer ON TOP of the existing result flows
// (paper trades, strategy batches, replay). It measures how the three
// Narrow State-first strategies actually perform and answers questions like
// "which narrow strategy works best", "which narrowScore band is strongest",
// and "does VWAP/volume/RSI confirmation help".
//
// IMPORTANT RULES (per project owner):
//   - Only strategy_family === "narrow_state" OR one of the three known narrow
//     strategy ids counts as narrow evidence. Old VWAP/other trades are never
//     counted as narrow_state.
//   - No fabricated history. When there is no narrow data yet, every function
//     returns a safe, empty, "needs_more_data" result — never a crash.
//
// SAFETY: analysis/measurement only. Never trades, never enables a broker,
// never enables live trading.
// ────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

let daytradingCatalog = null;
function lazyCatalog() {
  if (!daytradingCatalog) {
    try { daytradingCatalog = require('./daytradingStrategyCatalogService'); } catch (_) { daytradingCatalog = null; }
  }
  return daytradingCatalog;
}

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  live_enabled: false,
  paper_only: true,
});

// The three known narrow strategies (explicit fallback, never trust other ids).
const KNOWN_NARROW_IDS = Object.freeze([
  'narrow_breakout_v1',
  'narrow_fakeout_reversal_v1',
  'narrow_vwap_mean_reversion_v1',
]);

const FRIENDLY_NAMES = Object.freeze({
  narrow_breakout_v1: 'Breakout efter trång marknad',
  narrow_fakeout_reversal_v1: 'Falskt breakout och vändning',
  narrow_vwap_mean_reversion_v1: 'Återgång mot VWAP',
});

const DATA_DIR = path.resolve(process.env.NARROW_DATA_DIR || path.resolve(__dirname, '../../data'));
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trading', 'trades.jsonl');
const BATCH_RESULTS_DIR = path.join(DATA_DIR, 'strategy-batches', 'results');
const REPLAY_RUNS_DIR = path.join(DATA_DIR, 'replay', 'runs');

// ── helpers ──────────────────────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 4) {
  const n = num(v);
  if (n === null) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function narrowScoreBand(score) {
  const s = num(score);
  if (s === null) return 'unknown';
  if (s >= 80) return 'strong_compression';
  if (s >= 60) return 'confirmed_narrow';
  if (s >= 40) return 'weak_narrow';
  return 'not_narrow';
}

const BAND_RANGES = Object.freeze({
  not_narrow: '0-39',
  weak_narrow: '40-59',
  confirmed_narrow: '60-79',
  strong_compression: '80-100',
  unknown: 'n/a',
});

function narrowStrategyIdSet() {
  const ids = new Set(KNOWN_NARROW_IDS);
  const cat = lazyCatalog();
  if (cat && typeof cat.getCatalog === 'function') {
    try {
      const strategies = cat.getCatalog().strategies || [];
      for (const s of strategies) {
        if (s && s.family === 'narrow_state' && s.id) ids.add(String(s.id));
      }
    } catch (_) { /* fall back to known ids */ }
  }
  return ids;
}

function isNarrowRow(row, idSet) {
  if (!row || typeof row !== 'object') return false;
  const fam = String(row.strategy_family || row.strategyFamily || '').toLowerCase();
  if (fam === 'narrow_state') return true;
  const id = String(row.strategy_id || row.strategyId || row.strategy || '').trim();
  return id ? idSet.has(id) : false;
}

function strategyIdOf(row) {
  return String(row.strategy_id || row.strategyId || row.strategy || '').trim() || 'unknown';
}

function resultFromRow(row) {
  const r = String(row.result || row.outcome || '').toLowerCase();
  if (['win', 'won', 'tp', 'target'].includes(r)) return 'win';
  if (['loss', 'lost', 'sl', 'stop'].includes(r)) return 'loss';
  if (['breakeven', 'be', 'flat'].includes(r)) return 'breakeven';
  // Derive from pnl if explicit result missing
  const pnl = num(row.pnlPct ?? row.pnl_percent ?? row.pnlPercent ?? row.pnl_paper ?? row.pnl);
  if (pnl !== null) {
    if (pnl > 0.01) return 'win';
    if (pnl < -0.01) return 'loss';
    return 'breakeven';
  }
  return 'unknown';
}

function safeReadJsonlLines(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// ── Normalised narrow record ─────────────────────────────────────────────────
// A record can be a single trade (paper) or an aggregate (batch). `tradeCount`,
// `wins`, `losses`, `breakeven` make both granularities aggregate cleanly.
function normalizePaperTrade(row) {
  const result = resultFromRow(row);
  const pnl = num(row.pnlPct ?? row.pnl_paper ?? row.pnl);
  return {
    recordKind: 'trade',
    source: 'paper',
    strategy_id: strategyIdOf(row),
    strategy_family: 'narrow_state',
    symbol: row.symbol ? String(row.symbol).toUpperCase() : null,
    timeframe: row.timeframe || row.tf || null,
    timestamp: row.closed_at || row.exitTime || row.entryTime || row.opened_at || null,
    narrowScore: num(row.narrowScore),
    narrowScoreBand: narrowScoreBand(row.narrowScore),
    regimeLabel: row.regimeLabel || null,
    breakoutType: row.breakoutType || null,
    fakeoutDetected: typeof row.fakeoutDetected === 'boolean' ? row.fakeoutDetected : null,
    meanReversionCandidate: typeof row.meanReversionCandidate === 'boolean' ? row.meanReversionCandidate : null,
    confirmationUsed: normalizeConfirmations(row.confirmationUsed || row.confirmations),
    entryPrice: num(row.entryPrice),
    exitPrice: num(row.exitPrice),
    pnl_paper: pnl,
    pnlPercent: pnl,
    result,
    tradeCount: 1,
    wins: result === 'win' ? 1 : 0,
    losses: result === 'loss' ? 1 : 0,
    breakeven: result === 'breakeven' ? 1 : 0,
    maxAdverseExcursion: num(row.maxAdversePct ?? row.maxAdverseExcursion),
    maxFavorableExcursion: num(row.maxFavorablePct ?? row.maxFavorableExcursion),
    exitReason: row.exitReason || null,
    lessonTags: Array.isArray(row.lessonTags) ? row.lessonTags : [],
  };
}

function normalizeBatchRow(row) {
  const trades = num(row.trades) || 0;
  const wins = num(row.wins) || 0;
  const losses = num(row.losses) || 0;
  const breakeven = Math.max(0, trades - wins - losses);
  const avgPnl = num(row.avg_pnl);
  const totalPnl = num(row.total_pnl);
  return {
    recordKind: 'aggregate',
    source: 'batch',
    strategy_id: strategyIdOf(row),
    strategy_family: 'narrow_state',
    symbol: row.symbol ? String(row.symbol).toUpperCase() : null,
    timeframe: row.timeframe || null,
    timestamp: row.created_at || row.date_to || null,
    narrowScore: null, // batch tests a date range, not a single narrowScore
    narrowScoreBand: 'unknown',
    regimeLabel: null,
    breakoutType: null,
    fakeoutDetected: null,
    meanReversionCandidate: null,
    confirmationUsed: normalizeConfirmations(null),
    entryPrice: null,
    exitPrice: null,
    pnl_paper: avgPnl,
    pnlPercent: avgPnl,
    result: trades > 0 ? (wins > losses ? 'win' : losses > wins ? 'loss' : 'breakeven') : 'unknown',
    tradeCount: trades,
    wins,
    losses,
    breakeven,
    avgPnl,
    totalPnl,
    maxAdverseExcursion: num(row.max_drawdown) !== null ? -Math.abs(num(row.max_drawdown)) : null,
    maxFavorableExcursion: null,
    exitReason: null,
    lessonTags: [],
  };
}

function normalizeConfirmations(c) {
  const base = { ema: null, rsi: null, vwap: null, volume: null, macd: null };
  if (!c || typeof c !== 'object') return base;
  for (const k of Object.keys(base)) {
    if (typeof c[k] === 'boolean') base[k] = c[k];
  }
  return base;
}

// ── Source readers (all robust, never throw) ─────────────────────────────────

function readPaperRecords(idSet) {
  const rows = safeReadJsonlLines(PAPER_TRADES_FILE);
  return rows.filter((r) => isNarrowRow(r, idSet)).map(normalizePaperTrade);
}

function readBatchRecords(idSet) {
  const out = [];
  try {
    if (!fs.existsSync(BATCH_RESULTS_DIR)) return out;
    const files = fs.readdirSync(BATCH_RESULTS_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const data = safeReadJson(path.join(BATCH_RESULTS_DIR, f), []);
      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        if (isNarrowRow(row, idSet) && num(row.trades) > 0) out.push(normalizeBatchRow(row));
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

function readReplayRecords(idSet) {
  // Current replay events are signal-classification events without strategy
  // attribution or P/L, so they do not count as narrow strategy outcomes.
  // We only pick up replay events that explicitly carry a narrow strategy_id
  // AND a result/pnl — ready for when replay starts emitting strategy outcomes.
  const out = [];
  try {
    if (!fs.existsSync(REPLAY_RUNS_DIR)) return out;
    const runs = fs.readdirSync(REPLAY_RUNS_DIR).filter((d) => d.startsWith('run_'));
    for (const run of runs) {
      const eventsFile = path.join(REPLAY_RUNS_DIR, run, 'events.jsonl');
      const rows = safeReadJsonlLines(eventsFile);
      for (const row of rows) {
        const hasStrategy = isNarrowRow(row, idSet);
        const hasOutcome = row.result != null || row.pnl != null || row.pnlPct != null;
        if (hasStrategy && hasOutcome) {
          out.push({ ...normalizePaperTrade(row), source: 'replay', recordKind: 'trade' });
        }
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

function collectNarrowRecords() {
  const idSet = narrowStrategyIdSet();
  const warnings = [];
  const paper = readPaperRecords(idSet);
  const batch = readBatchRecords(idSet);
  const replay = readReplayRecords(idSet);
  const records = [...paper, ...batch, ...replay];
  if (records.length === 0) warnings.push('no_narrow_state_data');
  const withScore = records.filter((r) => r.narrowScore !== null).length;
  if (records.length > 0 && withScore === 0) warnings.push('missing_narrow_score');
  const withConfirm = records.filter((r) => Object.values(r.confirmationUsed).some((v) => v !== null)).length;
  if (records.length > 0 && withConfirm === 0) warnings.push('missing_confirmation_data');
  return {
    records,
    warnings,
    sourceCounts: { paper: paper.length, batch: batch.length, replay: replay.length },
  };
}

// ── Confidence & verdict ─────────────────────────────────────────────────────

function confidenceFromTrades(n) {
  if (n >= 30) return 'high';
  if (n >= 10) return 'medium';
  if (n >= 1) return 'low';
  return 'none';
}

function verdictFor({ trades, winRate, avgPnl }) {
  if (!trades || trades < 1) return 'unknown';
  if (trades < 10) return 'needs_more_data';
  if (avgPnl !== null && avgPnl <= -0.15) return 'avoid_for_now';
  if (winRate !== null && winRate < 35) return 'weak';
  if (winRate !== null && winRate >= 50 && (avgPnl === null || avgPnl >= 0)) return 'promising';
  if (winRate !== null && winRate >= 45) return 'promising';
  return 'weak';
}

// ── Ranking ──────────────────────────────────────────────────────────────────

function emptyStratAgg(id) {
  return {
    strategy_id: id,
    name: FRIENDLY_NAMES[id] || id,
    trades: 0, wins: 0, losses: 0, breakeven: 0,
    _grossWin: 0, _grossLoss: 0, _pnlSum: 0, _pnlCount: 0,
    _maeSum: 0, _maeCount: 0, _mfeSum: 0, _mfeCount: 0,
    _bySymbol: new Map(), _byTimeframe: new Map(), _byBand: new Map(),
  };
}

function bumpKeyed(map, key, wins, losses, trades, pnl) {
  if (!key) return;
  const cur = map.get(key) || { key, trades: 0, wins: 0, losses: 0, pnlSum: 0, pnlCount: 0 };
  cur.trades += trades; cur.wins += wins; cur.losses += losses;
  if (pnl !== null) { cur.pnlSum += pnl * (trades || 1); cur.pnlCount += (trades || 1); }
  map.set(key, cur);
}

function rankNarrowStrategies(records) {
  const byStrat = new Map();
  for (const r of records) {
    const id = r.strategy_id;
    if (!byStrat.has(id)) byStrat.set(id, emptyStratAgg(id));
    const a = byStrat.get(id);
    const tc = r.tradeCount || 0;
    a.trades += tc;
    a.wins += r.wins || 0;
    a.losses += r.losses || 0;
    a.breakeven += r.breakeven || 0;
    const pnl = r.pnlPercent;
    if (pnl !== null) {
      a._pnlSum += pnl * (tc || 1); a._pnlCount += (tc || 1);
      if (pnl > 0) a._grossWin += pnl * (r.wins || (pnl > 0 ? 1 : 0));
      if (pnl < 0) a._grossLoss += Math.abs(pnl) * (r.losses || (pnl < 0 ? 1 : 0));
    }
    if (r.maxAdverseExcursion !== null) { a._maeSum += r.maxAdverseExcursion; a._maeCount += 1; }
    if (r.maxFavorableExcursion !== null) { a._mfeSum += r.maxFavorableExcursion; a._mfeCount += 1; }
    bumpKeyed(a._bySymbol, r.symbol, r.wins || 0, r.losses || 0, tc, pnl);
    bumpKeyed(a._byTimeframe, r.timeframe, r.wins || 0, r.losses || 0, tc, pnl);
    bumpKeyed(a._byBand, r.narrowScoreBand !== 'unknown' ? r.narrowScoreBand : null, r.wins || 0, r.losses || 0, tc, pnl);
  }

  const rankings = [...byStrat.values()].map((a) => finalizeStrat(a, records));
  // Sort: more evidence + better win rate first
  rankings.sort((x, y) => {
    const ev = { high: 3, medium: 2, low: 1, none: 0 };
    if (ev[y.confidence] !== ev[x.confidence]) return ev[y.confidence] - ev[x.confidence];
    if ((y.winRate ?? -1) !== (x.winRate ?? -1)) return (y.winRate ?? -1) - (x.winRate ?? -1);
    return (y.avgPnl ?? -999) - (x.avgPnl ?? -999);
  });
  return rankings;
}

function pickBestKeys(map, n = 3) {
  return [...map.values()]
    .filter((v) => v.trades >= 1)
    .map((v) => ({ key: v.key, trades: v.trades, winRate: v.trades ? round((v.wins / v.trades) * 100, 1) : null, avgPnl: v.pnlCount ? round(v.pnlSum / v.pnlCount, 4) : null }))
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))
    .slice(0, n);
}

function worstKeys(map, n = 3) {
  return [...map.values()]
    .filter((v) => v.trades >= 1)
    .map((v) => ({ key: v.key, trades: v.trades, winRate: v.trades ? round((v.wins / v.trades) * 100, 1) : null, avgPnl: v.pnlCount ? round(v.pnlSum / v.pnlCount, 4) : null }))
    .sort((a, b) => (a.winRate ?? 999) - (b.winRate ?? 999))
    .slice(0, n);
}

function finalizeStrat(a) {
  const trades = a.trades;
  const winRate = trades ? round((a.wins / trades) * 100, 1) : null;
  const avgPnl = a._pnlCount ? round(a._pnlSum / a._pnlCount, 4) : null;
  const totalPnl = a._pnlCount ? round(a._pnlSum, 4) : null;
  const profitFactor = a._grossLoss > 0 ? round(a._grossWin / a._grossLoss, 3) : (a._grossWin > 0 ? null : null);
  const bands = pickBestKeys(a._byBand, 4);
  return {
    strategy_id: a.strategy_id,
    name: a.name,
    trades,
    wins: a.wins,
    losses: a.losses,
    breakeven: a.breakeven,
    winRate,
    avgPnl,
    totalPnl,
    profitFactor,
    avgMaxAdverseExcursion: a._maeCount ? round(a._maeSum / a._maeCount, 4) : null,
    avgMaxFavorableExcursion: a._mfeCount ? round(a._mfeSum / a._mfeCount, 4) : null,
    bestSymbols: pickBestKeys(a._bySymbol),
    worstSymbols: worstKeys(a._bySymbol),
    bestTimeframes: pickBestKeys(a._byTimeframe),
    worstTimeframes: worstKeys(a._byTimeframe),
    bestNarrowScoreBand: bands[0]?.key || null,
    worstNarrowScoreBand: worstKeys(a._byBand, 1)[0]?.key || null,
    confidence: confidenceFromTrades(trades),
    verdict: verdictFor({ trades, winRate, avgPnl }),
  };
}

// ── Score-band analysis ──────────────────────────────────────────────────────

function analyzeNarrowScoreBands(records) {
  const order = ['not_narrow', 'weak_narrow', 'confirmed_narrow', 'strong_compression'];
  const byBand = new Map();
  for (const r of records) {
    const band = r.narrowScoreBand;
    if (!order.includes(band)) continue; // skip 'unknown'
    if (!byBand.has(band)) byBand.set(band, { band, scoreRange: BAND_RANGES[band], trades: 0, wins: 0, losses: 0, _pnlSum: 0, _pnlCount: 0, _byStrat: new Map() });
    const b = byBand.get(band);
    const tc = r.tradeCount || 0;
    b.trades += tc; b.wins += r.wins || 0; b.losses += r.losses || 0;
    if (r.pnlPercent !== null) { b._pnlSum += r.pnlPercent * (tc || 1); b._pnlCount += (tc || 1); }
    bumpKeyed(b._byStrat, r.strategy_id, r.wins || 0, r.losses || 0, tc, r.pnlPercent);
  }
  return order
    .filter((band) => byBand.has(band))
    .map((band) => {
      const b = byBand.get(band);
      const winRate = b.trades ? round((b.wins / b.trades) * 100, 1) : null;
      const avgPnl = b._pnlCount ? round(b._pnlSum / b._pnlCount, 4) : null;
      const best = pickBestKeys(b._byStrat, 1)[0];
      return {
        band,
        scoreRange: b.scoreRange,
        trades: b.trades,
        winRate,
        avgPnl,
        bestStrategy: best ? { strategy_id: best.key, name: FRIENDLY_NAMES[best.key] || best.key, winRate: best.winRate } : null,
        recommendation: b.trades < 10
          ? 'För lite data — samla fler tester i detta band.'
          : (avgPnl !== null && avgPnl > 0 ? 'Lovande band — prioritera fler tester här.' : 'Svagt resultat hittills — undvik tills mer data finns.'),
      };
    });
}

// ── Confirmation impact ──────────────────────────────────────────────────────

function analyzeConfirmations(records) {
  const keys = ['ema', 'rsi', 'vwap', 'volume', 'macd'];
  return keys.map((key) => {
    const withC = { trades: 0, wins: 0, losses: 0, pnlSum: 0, pnlCount: 0 };
    const without = { trades: 0, wins: 0, losses: 0, pnlSum: 0, pnlCount: 0 };
    for (const r of records) {
      const flag = r.confirmationUsed ? r.confirmationUsed[key] : null;
      if (flag === null || flag === undefined) continue; // unknown → not counted
      const bucket = flag ? withC : without;
      const tc = r.tradeCount || 0;
      bucket.trades += tc; bucket.wins += r.wins || 0; bucket.losses += r.losses || 0;
      if (r.pnlPercent !== null) { bucket.pnlSum += r.pnlPercent * (tc || 1); bucket.pnlCount += (tc || 1); }
    }
    const fmt = (b) => ({ trades: b.trades, winRate: b.trades ? round((b.wins / b.trades) * 100, 1) : null, avgPnl: b.pnlCount ? round(b.pnlSum / b.pnlCount, 4) : null });
    const a = fmt(withC); const b = fmt(without);
    let impact = 'insufficient_data';
    if (a.trades >= 10 && b.trades >= 10 && a.winRate !== null && b.winRate !== null) {
      const diff = a.winRate - b.winRate;
      impact = diff >= 5 ? 'positive' : diff <= -5 ? 'negative' : 'neutral';
    }
    return { confirmation: key, withConfirmation: a, withoutConfirmation: b, impact };
  });
}

// ── Recommended next test ────────────────────────────────────────────────────

function recommendNextNarrowTest(rankings, scoreBands, confirmations, sourceCounts) {
  const safety = { live_trading_enabled: false, can_place_orders: false };
  const totalTrades = rankings.reduce((s, r) => s + r.trades, 0);

  if (totalTrades === 0) {
    return {
      title: 'Samla första Narrow State-data',
      reason: 'Det finns ännu inga narrow_state-resultat. Kör replay eller batch på de tre narrow-strategierna för att börja mäta.',
      strategy_id: 'narrow_breakout_v1',
      source: 'replay',
      priority: 'high',
      suggestedFilters: { narrowScoreBand: 'strong_compression', symbols: [], timeframes: ['2m'], confirmations: ['vwap', 'volume'] },
      safety,
    };
  }

  // Prefer the strategy with the least evidence to balance the dataset.
  const leastEvidence = [...rankings].sort((a, b) => a.trades - b.trades)[0];
  const strongBand = scoreBands.find((b) => b.band === 'strong_compression' && b.trades >= 10);
  const positiveConfirm = confirmations.find((c) => c.impact === 'positive');

  if (leastEvidence && leastEvidence.confidence !== 'high') {
    return {
      title: `Samla mer data för "${leastEvidence.name}"`,
      reason: `${leastEvidence.name} har bara ${leastEvidence.trades} tester (${leastEvidence.confidence} datatillit). Kör fler replay/batch innan slutsats.`,
      strategy_id: leastEvidence.strategy_id,
      source: sourceCounts.batch >= sourceCounts.paper ? 'batch' : 'replay',
      priority: 'medium',
      suggestedFilters: {
        narrowScoreBand: strongBand ? 'strong_compression' : 'confirmed_narrow',
        symbols: leastEvidence.bestSymbols.map((s) => s.key).filter(Boolean).slice(0, 3),
        timeframes: leastEvidence.bestTimeframes.map((t) => t.key).filter(Boolean).slice(0, 2),
        confirmations: positiveConfirm ? [positiveConfirm.confirmation] : ['vwap', 'volume'],
      },
      safety,
    };
  }

  const best = rankings[0];
  return {
    title: `Verifiera "${best.name}" i bästa läget`,
    reason: positiveConfirm
      ? `${best.name} ser bäst ut. ${positiveConfirm.confirmation.toUpperCase()}-bekräftelse verkar hjälpa — testa fler sådana setups.`
      : `${best.name} ser bäst ut hittills. Kör fler tester för att bekräfta.`,
    strategy_id: best.strategy_id,
    source: 'paper',
    priority: 'low',
    suggestedFilters: {
      narrowScoreBand: best.bestNarrowScoreBand || 'confirmed_narrow',
      symbols: best.bestSymbols.map((s) => s.key).filter(Boolean).slice(0, 3),
      timeframes: best.bestTimeframes.map((t) => t.key).filter(Boolean).slice(0, 2),
      confirmations: positiveConfirm ? [positiveConfirm.confirmation] : [],
    },
    safety,
  };
}

// ── Top-level summary ────────────────────────────────────────────────────────

function buildNarrowPerformanceSummary() {
  const { records, warnings, sourceCounts } = collectNarrowRecords();
  const rankings = rankNarrowStrategies(records);
  const scoreBands = analyzeNarrowScoreBands(records);
  const confirmations = analyzeConfirmations(records);
  const recommendedNextTest = recommendNextNarrowTest(rankings, scoreBands, confirmations, sourceCounts);

  const totalTrades = rankings.reduce((s, r) => s + r.trades, 0);
  const ranked = rankings.filter((r) => r.trades >= 1);
  const bestStrategy = ranked.length
    ? (() => { const b = rankings[0]; return { strategy_id: b.strategy_id, name: b.name, winRate: b.winRate, avgPnl: b.avgPnl, trades: b.trades, verdict: b.verdict }; })()
    : null;
  const worstStrategy = ranked.length
    ? (() => { const w = [...ranked].sort((a, b) => (a.winRate ?? 999) - (b.winRate ?? 999))[0]; return { strategy_id: w.strategy_id, name: w.name, winRate: w.winRate, avgPnl: w.avgPnl, trades: w.trades, verdict: w.verdict }; })()
    : null;
  const bestScoreBand = (() => {
    const eligible = scoreBands.filter((b) => b.trades >= 10);
    if (!eligible.length) return null;
    const top = [...eligible].sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))[0];
    return { band: top.band, scoreRange: top.scoreRange, winRate: top.winRate, avgPnl: top.avgPnl };
  })();
  const strongestConfirmation = (() => {
    const positives = confirmations.filter((c) => c.impact === 'positive');
    if (!positives.length) return null;
    const top = positives.sort((a, b) => (b.withConfirmation.winRate ?? 0) - (a.withConfirmation.winRate ?? 0))[0];
    return { confirmation: top.confirmation, impact: top.impact, withWinRate: top.withConfirmation.winRate, withoutWinRate: top.withoutConfirmation.winRate };
  })();
  const dataConfidence = confidenceFromTrades(totalTrades);

  return {
    summary: {
      totalTrades,
      strategiesCompared: ranked.length,
      bestStrategy,
      worstStrategy,
      bestScoreBand,
      strongestConfirmation,
      dataConfidence,
      sourceCounts,
      message: totalTrades === 0
        ? 'Systemet har ännu för lite Narrow State-data för säker slutsats.'
        : (dataConfidence === 'high' ? 'Tillräckligt med data för första slutsatser.' : 'Begränsad data — tolka resultaten försiktigt.'),
    },
    rankings,
    scoreBands,
    confirmations,
    recommendedNextTest,
    warnings,
    generatedAt: new Date().toISOString(),
    ...SAFETY,
  };
}

// Compact view for the Supervisor endpoint (non-breaking additive fields).
function buildSupervisorNarrowLearning() {
  const full = buildNarrowPerformanceSummary();
  return {
    bestStrategy: full.summary.bestStrategy,
    worstStrategy: full.summary.worstStrategy,
    bestScoreBand: full.summary.bestScoreBand,
    strongestConfirmation: full.summary.strongestConfirmation,
    dataConfidence: full.summary.dataConfidence,
    totalNarrowTrades: full.summary.totalTrades,
    recommendedNextTest: full.recommendedNextTest,
  };
}

module.exports = {
  SAFETY,
  KNOWN_NARROW_IDS,
  narrowScoreBand,
  narrowStrategyIdSet,
  collectNarrowRecords,
  rankNarrowStrategies,
  analyzeNarrowScoreBands,
  analyzeConfirmations,
  recommendNextNarrowTest,
  buildNarrowPerformanceSummary,
  buildSupervisorNarrowLearning,
};
