'use strict';
/**
 * Self-Healing Rule Engine
 *
 * Tracks rolling win rate per rule (eventType × regime) and detects
 * when rules degrade over recent 14-day windows vs historical baseline.
 *
 * Output: data/signals/rule-health.json
 *
 * Safety contract:
 *   - Never auto-changes any hard rule.
 *   - Only produces alerts / degradation flags for the Machine page.
 *   - No live-scan pipeline step — read-only report.
 */

const fs   = require('fs');
const path = require('path');

const OUTCOMES_DIR  = path.resolve(__dirname, '../../data/signals/outcomes');
const HEALTH_PATH   = path.resolve(__dirname, '../../data/signals/rule-health.json');
const CACHE_TTL_MS  = 5 * 60 * 1000;

const RECENT_WINDOW_DAYS    = 14;
const HISTORICAL_WINDOW_DAYS = 90;
const GLOBAL_WIN_RATE_FALLBACK = 0.5073;
const DEGRADATION_THRESHOLD  = 0.08;  // 8% below historical → degrading
const IMPROVEMENT_THRESHOLD  = 0.08;  // 8% above historical → improving
const MIN_RECENT_SAMPLES     = 8;
const MIN_HISTORICAL_SAMPLES = 30;

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
    // Date is embedded in filename: YYYY-MM-DD.jsonl
    const fileDate = file.replace('.jsonl', '');
    try {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { records.push({ _fileDate: fileDate, ...JSON.parse(line) }); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return records;
}

function round(n, d = 4) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function outcomeDate(outcome) {
  // _fileDate is injected by readJsonlDir; fallback: parse from signalId
  if (outcome._fileDate) return outcome._fileDate;
  const sid = outcome.signalId || '';
  const match = sid.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

// ── buildRuleHealth ───────────────────────────────────────────────────────────

function buildRuleHealth() {
  console.log('[SelfHealingRule] Building rule health report...');

  const allOutcomes = readJsonlDir(OUTCOMES_DIR);
  const directed    = allOutcomes.filter(
    o => o.success !== null && o.success !== undefined &&
         o.failureReason !== 'insufficient_data' &&
         o.failureReason !== 'market_closed'
  );

  const recentCutoff     = daysAgo(RECENT_WINDOW_DAYS);
  const historicalCutoff = daysAgo(HISTORICAL_WINDOW_DAYS);

  // Calculate global stats
  const globalWinRate = directed.length > 0
    ? directed.filter(o => o.success === true).length / directed.length
    : GLOBAL_WIN_RATE_FALLBACK;

  // ── Accumulate per-rule stats ─────────────────────────────────────────────

  const ruleMap = new Map(); // ruleKey → { historical, recent }

  function getRuleEntry(key, label) {
    if (!ruleMap.has(key)) {
      ruleMap.set(key, {
        ruleKey: key,
        label,
        historical: { total: 0, wins: 0 },
        recent:     { total: 0, wins: 0 },
      });
    }
    return ruleMap.get(key);
  }

  function tally(key, label, isWin, isRecent) {
    const e = getRuleEntry(key, label);
    if (isRecent) {
      e.recent.total++;
      if (isWin) e.recent.wins++;
    }
    e.historical.total++;
    if (isWin) e.historical.wins++;
  }

  for (const o of directed) {
    const date  = outcomeDate(o);
    if (date < historicalCutoff) continue;

    const isWin    = o.success === true;
    const isRecent = date >= recentCutoff;
    const et       = o.eventType || 'UNKNOWN';
    const regime   = o.marketRegime || 'UNKNOWN';
    const sym      = o.symbol       || 'UNKNOWN';

    // eventType rule
    tally(`eventType::${et}`, et, isWin, isRecent);

    // regime rule
    tally(`regime::${regime}`, regime, isWin, isRecent);

    // symbol rule
    tally(`symbol::${sym}`, sym, isWin, isRecent);

    // combined eventType × regime
    tally(`et_regime::${et}::${regime}`, `${et} @ ${regime}`, isWin, isRecent);
  }

  // ── Derive health per rule ─────────────────────────────────────────────────

  const rules = [];

  for (const [, e] of ruleMap) {
    if (e.historical.total < MIN_HISTORICAL_SAMPLES) continue;
    if (e.recent.total < MIN_RECENT_SAMPLES) continue;

    const historicalWinRate = e.historical.wins / e.historical.total;
    const recentWinRate     = e.recent.wins     / e.recent.total;
    const drift             = recentWinRate - historicalWinRate;

    let status;
    if (drift <= -DEGRADATION_THRESHOLD)   status = 'degrading';
    else if (drift >= IMPROVEMENT_THRESHOLD) status = 'improving';
    else                                   status = 'stable';

    let alertSv = null;
    if (status === 'degrading') {
      const pct = Math.abs(Math.round(drift * 100));
      alertSv = `"${e.label}" presterar ${pct}% sämre de senaste ${RECENT_WINDOW_DAYS} dagarna (${Math.round(recentWinRate * 100)}% vs ${Math.round(historicalWinRate * 100)}% historiskt).`;
    } else if (status === 'improving') {
      const pct = Math.abs(Math.round(drift * 100));
      alertSv = `"${e.label}" presterar ${pct}% bättre de senaste ${RECENT_WINDOW_DAYS} dagarna (${Math.round(recentWinRate * 100)}% vs ${Math.round(historicalWinRate * 100)}% historiskt).`;
    }

    rules.push({
      ruleKey:            e.ruleKey,
      label:              e.label,
      status,
      drift:              round(drift),
      recentWinRate:      round(recentWinRate),
      historicalWinRate:  round(historicalWinRate),
      recentSamples:      e.recent.total,
      historicalSamples:  e.historical.total,
      alertSv,
    });
  }

  // Sort: degrading first, then by absolute drift
  rules.sort((a, b) => {
    const aScore = a.status === 'degrading' ? -a.drift : a.status === 'improving' ? a.drift : -999;
    const bScore = b.status === 'degrading' ? -b.drift : b.status === 'improving' ? b.drift : -999;
    return bScore - aScore;
  });

  const degradingCount  = rules.filter(r => r.status === 'degrading').length;
  const improvingCount  = rules.filter(r => r.status === 'improving').length;
  const stableCount     = rules.filter(r => r.status === 'stable').length;

  const health = {
    updatedAt:          new Date().toISOString(),
    recentWindowDays:   RECENT_WINDOW_DAYS,
    historicalWindowDays: HISTORICAL_WINDOW_DAYS,
    globalWinRate:      round(globalWinRate),
    totalDirected:      directed.length,
    totalRules:         rules.length,
    degradingCount,
    improvingCount,
    stableCount,
    rules,
  };

  fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_PATH, JSON.stringify(health, null, 2), 'utf8');
  console.log(`[SelfHealingRule] Saved ${rules.length} rules (${degradingCount} degrading, ${improvingCount} improving) → ${HEALTH_PATH}`);
  return { ok: true, totalRules: rules.length, degradingCount, improvingCount };
}

// ── loadRuleHealth ────────────────────────────────────────────────────────────

function loadRuleHealth() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(HEALTH_PATH)) { _cacheTime = now; return null; }
    _cache     = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8'));
    _cacheTime = now;
    return _cache;
  } catch {
    return null;
  }
}

module.exports = { buildRuleHealth, loadRuleHealth };
