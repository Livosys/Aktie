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

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  live_enabled: false,
  paper_only: true,
});

// The three known narrow strategies. These are the only strategy_id fallbacks
// we accept when strategy_family is missing from source data.
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
  return new Set(KNOWN_NARROW_IDS);
}

function narrowFamilyOf(row) {
  if (!row || typeof row !== 'object') return false;
  const fam = String(row.strategy_family || row.strategyFamily || '').trim().toLowerCase();
  return fam === 'narrow_state' ? 'narrow_state' : null;
}

function isNarrowRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (narrowFamilyOf(row) === 'narrow_state') return true;
  const id = String(row.strategy_id || row.strategyId || row.strategy || '').trim();
  return id ? KNOWN_NARROW_IDS.includes(id) : false;
}

function strategyIdOf(row) {
  const explicit = String(row.strategy_id || row.strategyId || row.strategy || '').trim();
  if (explicit) return explicit;
  if (narrowFamilyOf(row) === 'narrow_state') {
    return String(row.signalSubtype || row.signal_subtype || row.signalFamily || row.signal_family || row.familyLabel || row.family_label || '').trim() || 'unknown';
  }
  return 'unknown';
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

function scoreBandFromRow(row) {
  if (!row || typeof row !== 'object') return 'unknown';
  if (row.narrowScore != null) return narrowScoreBand(row.narrowScore);
  if (row.narrow_score != null) return narrowScoreBand(row.narrow_score);
  return 'unknown';
}

function confirmationShapeFromRow(row) {
  const value = row?.confirmationUsed || row?.confirmations || row?.confirmation_used || null;
  return normalizeConfirmations(value);
}

function normalizeConfirmationQualityValue(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'real' || v === 'heuristic' || v === 'missing') return v;
  if (v === 'true' || v === 'yes' || v === '1') return 'real';
  if (v === 'false' || v === '0') return 'missing';
  return 'missing';
}

function confirmationQualityFromRow(row) {
  const explicit = row?.confirmationQuality || row?.confirmation_quality || null;
  const base = { ema: 'missing', rsi: 'missing', vwap: 'missing', volume: 'missing', macd: 'missing' };
  if (explicit && typeof explicit === 'object') {
    for (const key of Object.keys(base)) {
      const value = explicit[key];
      if (value === true) base[key] = 'real';
      else if (value === false) base[key] = 'heuristic';
      else base[key] = normalizeConfirmationQualityValue(value);
    }
    return base;
  }

  const flags = confirmationShapeFromRow(row);
  for (const key of Object.keys(base)) {
    base[key] = flags[key] === null || flags[key] === undefined ? 'missing' : 'heuristic';
  }
  return base;
}

function evidenceQualityFromConfirmationQuality(quality = {}) {
  const values = Object.values(quality || {});
  const real = values.filter((value) => value === 'real').length;
  const heuristic = values.filter((value) => value === 'heuristic').length;
  if (real > 0 && heuristic > 0) return 'mixed';
  if (real > 0) return 'real';
  if (heuristic > 0) return 'heuristic';
  return 'insufficient_data';
}

function sourceWarningsForRow(row, source) {
  const warnings = [];
  const narrowScore = row?.narrowScore ?? row?.narrow_score ?? null;
  const regimeLabel = row?.regimeLabel ?? row?.regime_label ?? null;
  if (narrowScore == null) warnings.push(`missing_narrowScore:${source}`);
  if (regimeLabel == null) warnings.push(`missing_regimeLabel:${source}`);
  return warnings;
}

function summarizeMissingDataWarnings(records, rawSourceCounts) {
  const warnings = [];
  if (records.length === 0) warnings.push('no_narrow_state_data');
  const allNoScore = rawSourceCounts.paper + rawSourceCounts.batch + rawSourceCounts.replay > 0 && records.every((r) => r.narrowScore == null);
  if (allNoScore) warnings.push('missing_narrowScore');
  const allNoRegime = rawSourceCounts.paper + rawSourceCounts.batch + rawSourceCounts.replay > 0 && records.every((r) => r.regimeLabel == null);
  if (allNoRegime) warnings.push('missing_regimeLabel');
  return warnings;
}

// ── Normalised narrow record ─────────────────────────────────────────────────
// A record can be a single trade (paper) or an aggregate (batch). `tradeCount`,
// `wins`, `losses`, `breakeven` make both granularities aggregate cleanly.
function normalizeNarrowRecord(row, source, overrides = {}) {
  const result = resultFromRow(row);
  const pnl = num(row.pnlPct ?? row.pnl_paper ?? row.pnl_percent ?? row.pnl);
  const strategyFamily = narrowFamilyOf(row);
  const narrowScore = num(row.narrowScore ?? row.narrow_score);
  const regimeLabel = row.regimeLabel ?? row.regime_label ?? null;
  const timestamp = row.closed_at || row.exitTime || row.exit_time || row.entryTime || row.opened_at || row.created_at || row.run_completed_at || row.createdAt || null;
  const record = {
    recordKind: overrides.recordKind || 'trade',
    source,
    strategy_id: strategyIdOf(row),
    strategy_family: strategyFamily || null,
    symbol: row.symbol ? String(row.symbol).toUpperCase() : null,
    timeframe: row.timeframe || row.tf || null,
    timestamp,
    narrowScore,
    narrowScoreBand: scoreBandFromRow(row),
    regimeLabel,
    breakoutType: row.breakoutType || row.breakout_type || null,
    fakeoutDetected: typeof (row.fakeoutDetected ?? row.fakeout_detected) === 'boolean' ? (row.fakeoutDetected ?? row.fakeout_detected) : null,
    meanReversionCandidate: typeof (row.meanReversionCandidate ?? row.mean_reversion_candidate) === 'boolean' ? (row.meanReversionCandidate ?? row.mean_reversion_candidate) : null,
    confirmationUsed: confirmationShapeFromRow(row),
    confirmationQuality: confirmationQualityFromRow(row),
    confirmationEvidenceQuality: evidenceQualityFromConfirmationQuality(confirmationQualityFromRow(row)),
    entryPrice: num(row.entryPrice ?? row.entry_price),
    exitPrice: num(row.exitPrice ?? row.exit_price),
    pnl_paper: pnl,
    pnlPercent: pnl,
    result,
    tradeCount: num(overrides.tradeCount) ?? 1,
    wins: num(overrides.wins) ?? (result === 'win' ? 1 : 0),
    losses: num(overrides.losses) ?? (result === 'loss' ? 1 : 0),
    breakeven: num(overrides.breakeven) ?? (result === 'breakeven' ? 1 : 0),
    maxAdverseExcursion: num(row.maxAdversePct ?? row.maxAdverseExcursion ?? row.max_adverse_excursion),
    maxFavorableExcursion: num(row.maxFavorablePct ?? row.maxFavorableExcursion ?? row.max_favorable_excursion),
    exitReason: row.exitReason || row.exit_reason || null,
    lessonTags: Array.isArray(row.lessonTags) ? row.lessonTags : [],
  };
  return { record, warnings: sourceWarningsForRow(row, source) };
}

function normalizeBatchRow(row) {
  const trades = num(row.trades) || 0;
  const wins = num(row.wins) || 0;
  const losses = num(row.losses) || 0;
  const breakeven = Math.max(0, trades - wins - losses);
  const avgPnl = num(row.avg_pnl ?? row.avgPnl);
  const totalPnl = num(row.total_pnl ?? row.totalPnl);
  const base = normalizeNarrowRecord(row, 'batch', {
    recordKind: 'aggregate',
    tradeCount: trades,
    wins,
    losses,
    breakeven,
  });
  return {
    ...base.record,
    narrowScore: num(row.narrowScore ?? row.narrow_score),
    narrowScoreBand: scoreBandFromRow(row),
    regimeLabel: row.regimeLabel ?? row.regime_label ?? null,
    confirmationUsed: confirmationShapeFromRow(row),
    confirmationQuality: confirmationQualityFromRow(row),
    confirmationEvidenceQuality: evidenceQualityFromConfirmationQuality(confirmationQualityFromRow(row)),
    pnl_paper: avgPnl,
    pnlPercent: avgPnl,
    avgPnl,
    totalPnl,
    result: trades > 0 ? (wins > losses ? 'win' : losses > wins ? 'loss' : 'breakeven') : 'unknown',
    timestamp: row.created_at || row.run_completed_at || row.run_created_at || row.date_to || null,
    maxAdverseExcursion: num(row.max_drawdown ?? row.maxDrawdown) !== null ? -Math.abs(num(row.max_drawdown ?? row.maxDrawdown)) : null,
    maxFavorableExcursion: null,
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

function readPaperRecords() {
  const rows = safeReadJsonlLines(PAPER_TRADES_FILE);
  const out = [];
  const warnings = [];
  for (const row of rows) {
    if (!isNarrowRow(row)) continue;
    const { record, warnings: rowWarnings } = normalizeNarrowRecord(row, 'paper');
    out.push(record);
    warnings.push(...rowWarnings);
  }
  return { records: out, warnings };
}

// Content fingerprint for a normalized batch row. Two rows with the same
// strategy/symbol/timeframe AND identical result numbers are the SAME evidence
// (e.g. a deterministic batch re-run over the same candle window). We count each
// unique fingerprint once so repeated identical tests never inflate the dataset.
function batchRowFingerprint(n) {
  return [
    String(n.strategy_id || ''),
    String(n.symbol || ''),
    String(n.timeframe || ''),
    n.tradeCount ?? '',
    n.wins ?? '',
    n.losses ?? '',
    n.avgPnl ?? '',
    n.totalPnl ?? '',
    n.narrowScore ?? '',
  ].join('|');
}

function readBatchRecords() {
  const out = [];
  const warnings = [];
  const seen = new Set();
  let duplicatesSkipped = 0;
  try {
    if (!fs.existsSync(BATCH_RESULTS_DIR)) return { records: out, warnings, duplicatesSkipped };
    const files = fs.readdirSync(BATCH_RESULTS_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const data = safeReadJson(path.join(BATCH_RESULTS_DIR, f), []);
      const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
      for (const row of rows) {
        if (!isNarrowRow(row)) continue;
        if (num(row.trades) <= 0) continue;
        const normalized = normalizeBatchRow(row);
        // Dedupe identical batch evidence (no duplicate tests in the learning set).
        const fp = batchRowFingerprint(normalized);
        if (seen.has(fp)) { duplicatesSkipped += 1; continue; }
        seen.add(fp);
        out.push(normalized);
        warnings.push(...sourceWarningsForRow(row, 'batch'));
      }
    }
  } catch (_) { /* ignore */ }
  if (duplicatesSkipped > 0) warnings.push(`duplicate_batch_rows_skipped:${duplicatesSkipped}`);
  return { records: out, warnings, duplicatesSkipped };
}

function readReplayRecords() {
  // Current replay events are signal-classification events without strategy
  // attribution or P/L, so they do not count as narrow strategy outcomes.
  // We only pick up replay events that explicitly carry a narrow strategy_id
  // AND a result/pnl — ready for when replay starts emitting strategy outcomes.
  const out = [];
  const warnings = [];
  try {
    if (!fs.existsSync(REPLAY_RUNS_DIR)) return { records: out, warnings };
    const runs = fs.readdirSync(REPLAY_RUNS_DIR).filter((d) => d.startsWith('run_'));
    for (const run of runs) {
      const eventsFile = path.join(REPLAY_RUNS_DIR, run, 'events.jsonl');
      const rows = safeReadJsonlLines(eventsFile);
      for (const row of rows) {
        const hasStrategy = isNarrowRow(row);
        const hasOutcome = row.result != null || row.pnl != null || row.pnlPct != null;
        if (hasStrategy && hasOutcome) {
          const { record, warnings: rowWarnings } = normalizeNarrowRecord(row, 'replay', { recordKind: 'trade' });
          out.push(record);
          warnings.push(...rowWarnings);
        }
      }
    }
  } catch (_) { /* ignore */ }
  return { records: out, warnings };
}

function collectNarrowRecords() {
  const paper = readPaperRecords();
  const batch = readBatchRecords();
  const replay = readReplayRecords();
  const records = [...paper.records, ...batch.records, ...replay.records];
  const warnings = [...paper.warnings, ...batch.warnings, ...replay.warnings];
  warnings.push(...summarizeMissingDataWarnings(records, {
    paper: paper.records.length,
    batch: batch.records.length,
    replay: replay.records.length,
  }));
  return {
    records,
    warnings: [...new Set(warnings)],
    sourceCounts: { paper: paper.records.length, batch: batch.records.length, replay: replay.records.length },
    duplicateBatchRowsSkipped: batch.duplicatesSkipped || 0,
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
  if (!trades || trades < 1) return 'needs_more_data';
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

function emptyRankings() {
  return KNOWN_NARROW_IDS.map((id) => finalizeStrat(emptyStratAgg(id)));
}

function bumpKeyed(map, key, wins, losses, trades, pnl) {
  if (!key) return;
  const cur = map.get(key) || { key, trades: 0, wins: 0, losses: 0, pnlSum: 0, pnlCount: 0 };
  cur.trades += trades; cur.wins += wins; cur.losses += losses;
  if (pnl !== null) { cur.pnlSum += pnl * (trades || 1); cur.pnlCount += (trades || 1); }
  map.set(key, cur);
}

function rankNarrowStrategies(records) {
  if (!records.length) return emptyRankings();
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
  if (!records.length) {
    return ['not_narrow', 'weak_narrow', 'confirmed_narrow', 'strong_compression'].map((band) => ({
      band,
      scoreRange: BAND_RANGES[band],
      trades: 0,
      winRate: null,
      avgPnl: null,
      bestStrategy: null,
      recommendation: 'För lite data ännu. Samla fler narrow_state-resultat innan slutsats.',
    }));
  }
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
  if (!records.length) {
    return ['ema', 'rsi', 'vwap', 'volume', 'macd'].map((confirmation) => ({
      confirmation,
      withConfirmation: { trades: 0, winRate: null, avgPnl: null },
      withoutConfirmation: { trades: 0, winRate: null, avgPnl: null },
      qualityCounts: { real: 0, heuristic: 0, missing: 0 },
      confirmationEvidenceQuality: 'insufficient_data',
      impact: 'insufficient_data',
    }));
  }
  const keys = ['ema', 'rsi', 'vwap', 'volume', 'macd'];
  return keys.map((key) => {
    const withC = { trades: 0, wins: 0, losses: 0, pnlSum: 0, pnlCount: 0, weightedTrades: 0, weightedWins: 0, weightedLosses: 0, weightedPnlSum: 0, weightedPnlCount: 0 };
    const without = { trades: 0, wins: 0, losses: 0, pnlSum: 0, pnlCount: 0, weightedTrades: 0, weightedWins: 0, weightedLosses: 0, weightedPnlSum: 0, weightedPnlCount: 0 };
    const qualityCounts = { real: 0, heuristic: 0, missing: 0 };
    for (const r of records) {
      const flag = r.confirmationUsed ? r.confirmationUsed[key] : null;
      if (flag === null || flag === undefined) continue; // unknown → not counted
      const quality = r.confirmationQuality?.[key] || (r.confirmationQuality ? 'missing' : 'heuristic');
      if (qualityCounts[quality] !== undefined) qualityCounts[quality] += 1;
      const bucket = flag ? withC : without;
      const tc = r.tradeCount || 0;
      const qualityWeight = quality === 'real' ? 1 : quality === 'heuristic' ? 0.35 : 0;
      const weightedTrades = tc * qualityWeight;
      const weightedPnlCount = weightedTrades > 0 ? weightedTrades : 0;
      bucket.trades += tc; bucket.wins += r.wins || 0; bucket.losses += r.losses || 0;
      bucket.weightedTrades += weightedTrades;
      bucket.weightedWins += (r.wins || 0) * qualityWeight;
      bucket.weightedLosses += (r.losses || 0) * qualityWeight;
      if (r.pnlPercent !== null) { bucket.pnlSum += r.pnlPercent * (tc || 1); bucket.pnlCount += (tc || 1); }
      if (r.pnlPercent !== null && weightedPnlCount > 0) { bucket.weightedPnlSum += r.pnlPercent * weightedPnlCount; bucket.weightedPnlCount += weightedPnlCount; }
    }
    const fmt = (b) => ({
      trades: b.trades,
      qualityWeightedTrades: round(b.weightedTrades, 1),
      winRate: b.weightedTrades ? round((b.weightedWins / b.weightedTrades) * 100, 1) : (b.trades ? round((b.wins / b.trades) * 100, 1) : null),
      avgPnl: b.weightedPnlCount ? round(b.weightedPnlSum / b.weightedPnlCount, 4) : (b.pnlCount ? round(b.pnlSum / b.pnlCount, 4) : null),
    });
    const a = fmt(withC); const b = fmt(without);
    const evidenceQuality = qualityCounts.real > 0 && qualityCounts.heuristic > 0
      ? 'mixed'
      : qualityCounts.real > 0
        ? 'real'
        : qualityCounts.heuristic > 0
          ? 'heuristic'
          : 'insufficient_data';
    let impact = 'insufficient_data';
    const evidenceWeight = evidenceQuality === 'real' ? 1 : evidenceQuality === 'mixed' ? 0.75 : evidenceQuality === 'heuristic' ? 0.35 : 0;
    if (a.qualityWeightedTrades >= 5 && b.qualityWeightedTrades >= 5 && a.winRate !== null && b.winRate !== null && evidenceWeight > 0) {
      const diff = (a.winRate - b.winRate) * evidenceWeight;
      const threshold = evidenceQuality === 'real' ? 3.5 : evidenceQuality === 'mixed' ? 2.5 : 5;
      impact = diff >= threshold ? 'positive' : diff <= -threshold ? 'negative' : 'neutral';
    }
    return { confirmation: key, withConfirmation: a, withoutConfirmation: b, qualityCounts, confirmationEvidenceQuality: evidenceQuality, impact };
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
    source: sourceCounts.batch > 0 ? 'batch' : (sourceCounts.replay > 0 ? 'replay' : 'paper'),
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
  const { records, warnings, sourceCounts, duplicateBatchRowsSkipped } = collectNarrowRecords();
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
    const qualityWeight = (quality) => (quality === 'real' ? 1 : quality === 'mixed' ? 0.75 : quality === 'heuristic' ? 0.35 : 0);
    const top = positives.sort((a, b) => {
      const scoreA = ((a.withConfirmation.winRate ?? 0) - (a.withoutConfirmation.winRate ?? 0)) * qualityWeight(a.confirmationEvidenceQuality);
      const scoreB = ((b.withConfirmation.winRate ?? 0) - (b.withoutConfirmation.winRate ?? 0)) * qualityWeight(b.confirmationEvidenceQuality);
      return scoreB - scoreA;
    })[0];
    return { confirmation: top.confirmation, impact: top.impact, withWinRate: top.withConfirmation.winRate, withoutWinRate: top.withoutConfirmation.winRate, evidenceQuality: top.confirmationEvidenceQuality };
  })();
  const dataConfidence = confidenceFromTrades(totalTrades);
  const status = totalTrades === 0 ? 'needs_more_data' : (dataConfidence === 'high' ? 'ready' : 'low_confidence');

  return {
    summary: {
      status,
      totalTrades,
      strategiesCompared: ranked.length,
      bestStrategy,
      worstStrategy,
      bestScoreBand,
      strongestConfirmation,
      dataConfidence,
      sourceCounts,
      duplicateBatchRowsSkipped: duplicateBatchRowsSkipped || 0,
      message: totalTrades === 0
        ? 'Systemet har ännu för lite Narrow State-data för säker slutsats.'
        : (dataConfidence === 'high' ? 'Tillräckligt med data för första slutsatser.' : 'Begränsad data - tolka resultaten försiktigt.'),
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
    status: full.summary.status,
    message: full.summary.message,
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
