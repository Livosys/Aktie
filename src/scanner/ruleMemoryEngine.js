'use strict';
/**
 * Rule Memory Engine v1
 *
 * Reads historical signal + outcome data, groups by block reason, and detects
 * patterns where rules consistently blocked signals that continued strongly.
 * Marks those rules WATCH_MODE_NEEDED and saves to rule-memory.json.
 *
 * During live scans, applyRuleMemory() reads the cached file and adds a small
 * score boost + metadata to signals whose block reason matches a learned pattern.
 *
 * Safety contract:
 *   - Hard-blocked signals (autoFilter.blocked, TFS, breakoutAlreadyOccurred)
 *     receive NO score boost — only metadata is attached.
 *   - Boost is conservative: +3 (medium confidence) or +5 (high confidence).
 *   - action is never changed to BUY/SELL — only WATCH metadata is added.
 */

const fs   = require('fs');
const path = require('path');

const SIGNALS_DIR  = path.resolve(__dirname, '../../data/signals/history');
const OUTCOMES_DIR = path.resolve(__dirname, '../../data/signals/outcomes');
const MEMORY_PATH  = path.resolve(__dirname, '../../data/signals/rule-memory.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache     = null;
let _cacheTime = 0;

// ── File helpers ──────────────────────────────────────────────────────────────

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

// ── Defensive-signal detection (mirrors missedBreakoutFinder) ─────────────────

const WAIT_SIGNALS = new Set(['WAIT', 'WAIT_PULLBACK', 'NO_TRADE']);

function isDefensive(sig) {
  if (!sig) return false;
  if (WAIT_SIGNALS.has(sig.signal)) return true;
  if (sig.blocked === true)         return true;
  const combined = (
    (sig.actionSv  || '') + ' ' +
    (Array.isArray(sig.reasonSv) ? sig.reasonSv.join(' ') : (sig.reasonSv || ''))
  ).toLowerCase();
  if (combined.includes('jaga inte'))          return true;
  if (combined.includes('för långt från zon')) return true;
  return false;
}

// ── Reason normalisation ──────────────────────────────────────────────────────

function normalizeReason(reason) {
  if (!reason || typeof reason !== 'string') return '';
  return reason
    .replace(/\s*\([^)]*\)/g, '')            // strip (parenthetical content)
    .replace(/\s+[\d][\d.,]*\s*x?\s*$/i, '') // strip trailing numbers like "3.2x"
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

function extractKeywords(text) {
  const l = (text || '').toLowerCase();
  const kw = [];
  if (l.includes('sma'))                       kw.push('sma');
  if (l.includes('spread'))                    kw.push('spread');
  if (l.includes('volym'))                     kw.push('volym');
  if (l.includes('zon'))                       kw.push('zon');
  if (l.includes('trend'))                     kw.push('trend');
  if (l.includes('narrow') || l.includes('smalt')) kw.push('narrow');
  if (l.includes('gap'))                       kw.push('gap');
  if (l.includes('breakout') || l.includes('utbrott')) kw.push('breakout');
  if (l.includes('pris'))                      kw.push('pris');
  return kw;
}

// ── buildRuleMemory ───────────────────────────────────────────────────────────

function buildRuleMemory() {
  console.log('[RuleMemory] Building rule memory from history...');

  // 1. Index all signals by signalId
  const allSignals  = readJsonlDir(SIGNALS_DIR);
  const signalIndex = new Map();
  for (const sig of allSignals) {
    if (sig.signalId) signalIndex.set(sig.signalId, sig);
  }

  // 2. Process every outcome record
  const allOutcomes = readJsonlDir(OUTCOMES_DIR);
  const ruleMap     = new Map(); // reasonKey → accumulator

  for (const outcome of allOutcomes) {
    const fr = outcome.failureReason;
    if (fr === 'insufficient_data' || fr === 'market_closed') continue;

    const sig    = outcome.signalId ? signalIndex.get(outcome.signalId) : null;
    const merged = {
      ...outcome,
      ...(sig ? {
        actionSv:    sig.actionSv,
        reasonSv:    sig.reasonSv,
        blocked:     sig.blocked,
        marketRegime: sig.marketRegime || outcome.marketRegime,
      } : {}),
    };

    if (!isDefensive(merged)) continue;

    const reasons = Array.isArray(merged.reasonSv) ? merged.reasonSv
                  : (merged.reasonSv ? [merged.reasonSv] : []);
    if (reasons.length === 0) continue;

    const primaryReason = reasons[0].slice(0, 80).trim();
    const reasonKey     = normalizeReason(primaryReason);
    if (!reasonKey) continue;

    // Continuation metrics
    const o10      = outcome.outcome10 || {};
    const o20      = outcome.outcome20 || {};
    const moveUp10 = o10.maxMoveUp      || 0;
    const moveUp20 = o20.maxMoveUp      || 0;
    const chg10    = o10.priceChangePct || 0;
    const maxUp    = Math.max(moveUp10, moveUp20);
    const contStrength = Math.min(100, Math.round(maxUp * 20));

    if (!ruleMap.has(reasonKey)) {
      ruleMap.set(reasonKey, {
        reasonKey,
        primaryReason,
        count:           0,
        missedMoveCount: 0,
        strongMissCount: 0,
        totalCont:       0,
        maxCont:         0,
        totalMoved:      0,
        maxMoved:        0,
        maxMovedSym:     '',
        symbolsSet:      new Set(),
        regimesSet:      new Set(),
      });
    }

    const e = ruleMap.get(reasonKey);
    e.count++;
    e.totalCont += contStrength;
    if (contStrength > e.maxCont) e.maxCont = contStrength;

    const moved = Math.abs(chg10);
    e.totalMoved += moved;
    if (moved > e.maxMoved) { e.maxMoved = moved; e.maxMovedSym = merged.symbol || ''; }

    if (merged.symbol)       e.symbolsSet.add(merged.symbol);
    if (merged.marketRegime) e.regimesSet.add(merged.marketRegime);

    if (contStrength >= 40 || moveUp10 >= 0.5) e.missedMoveCount++;
    if (contStrength >= 60 && (moveUp10 >= 1.0 || moveUp20 >= 1.5)) e.strongMissCount++;
  }

  // 3. Derive per-rule stats and apply WATCH_MODE logic
  const rules = [];
  for (const [, e] of ruleMap) {
    if (e.count < 3) continue; // skip rules with too few samples

    const avgCont     = Math.round(e.totalCont   / e.count);
    const avgMoved    = Math.round((e.totalMoved  / e.count) * 100) / 100;
    const missRatio   = Math.round((e.missedMoveCount / e.count) * 100) / 100;
    const strongRatio = Math.round((e.strongMissCount / e.count) * 100) / 100;

    const confidence = e.count >= 20 ? 'high' : e.count >= 8 ? 'medium' : 'low';

    // WATCH_MODE requires at least medium confidence
    // Threshold: ≥30% of blocks had strong continuation, OR avg ≥55 + ≥50% had any continuation
    const watchModeRecommended = confidence !== 'low' && (
      strongRatio >= 0.30 ||
      (avgCont >= 55 && missRatio >= 0.50)
    );

    rules.push({
      reasonKey:           e.reasonKey,
      primaryReason:       e.primaryReason,
      count:               e.count,
      missedMoveCount:     e.missedMoveCount,
      strongMissCount:     e.strongMissCount,
      avgContinuation:     avgCont,
      maxContinuation:     e.maxCont,
      avgMoved,
      maxMoved:            Math.round(e.maxMoved    * 100) / 100,
      maxMovedSymbol:      e.maxMovedSym,
      missRatio,
      strongMissRatio:     strongRatio,
      confidence,
      watchModeRecommended,
      symbolsAffected:     [...e.symbolsSet],
      regimesAffected:     [...e.regimesSet],
      keywords:            extractKeywords(e.primaryReason),
    });
  }

  rules.sort((a, b) => b.count - a.count);

  const watchCount = rules.filter(r => r.watchModeRecommended).length;
  const memory     = {
    updatedAt:      new Date().toISOString(),
    totalRules:     rules.length,
    watchModeRules: watchCount,
    rules,
  };

  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2), 'utf8');
  console.log(`[RuleMemory] Saved ${rules.length} rules (${watchCount} WATCH_MODE) → ${MEMORY_PATH}`);
  return memory;
}

// ── loadRuleMemory (with 5-min cache) ─────────────────────────────────────────

function loadRuleMemory() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(MEMORY_PATH)) { _cache = null; _cacheTime = now; return null; }
    _cache     = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
    _cacheTime = now;
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}

// ── Match live signal against stored WATCH_MODE rules ─────────────────────────

function matchWatchRule(signalReasons, watchRules) {
  const reasonText = (Array.isArray(signalReasons) ? signalReasons.join(' ') : (signalReasons || ''));
  const normLive   = normalizeReason(reasonText.slice(0, 80));
  const liveKws    = extractKeywords(reasonText);

  let bestMatch = null;
  let bestScore = 0;

  for (const rule of watchRules) {
    let score = 0;

    // Substring match on normalized text (bidirectional)
    if (normLive && rule.reasonKey) {
      if (normLive.includes(rule.reasonKey) || rule.reasonKey.includes(normLive)) score += 10;
    }

    // Keyword overlap
    const overlap = liveKws.filter(k => (rule.keywords || []).includes(k)).length;
    score += overlap * 3;

    if (score > bestScore) { bestScore = score; bestMatch = rule; }
  }

  return bestScore >= 3 ? bestMatch : null;
}

// ── applyRuleMemory (live scanner step) ───────────────────────────────────────

function applyRuleMemory(result) {
  const memory = loadRuleMemory();
  if (!memory || !memory.rules || memory.rules.length === 0) {
    return { ...result, ruleMemoryMatch: null };
  }

  const reasons = Array.isArray(result.reasonSv) ? result.reasonSv
                : (result.reasonSv ? [result.reasonSv] : []);

  if (reasons.length === 0) return { ...result, ruleMemoryMatch: null };

  const watchRules = memory.rules.filter(r => r.watchModeRecommended);
  if (watchRules.length === 0) return { ...result, ruleMemoryMatch: null };

  const matched = matchWatchRule(reasons, watchRules);
  if (!matched) return { ...result, ruleMemoryMatch: null };

  // Hard-blocked: report match but do NOT boost score
  const isHardBlocked =
    result.autoFilter?.blocked      === true ||
    result.threeFingerSpread?.active === true ||
    result.breakoutAlreadyOccurred   === true;

  let learnedRuleAdjustment = 0;
  if (!isHardBlocked) {
    if      (matched.confidence === 'high')   learnedRuleAdjustment = 5;
    else if (matched.confidence === 'medium') learnedRuleAdjustment = 3;
  }

  const watchModeReason =
    `Systemet lärde sig: "${matched.primaryReason}" blockerade ${matched.count} signaler` +
    ` — i ${matched.missedMoveCount} fall fortsatte rörelsen (snitt styrka ${matched.avgContinuation}).` +
    ' Bevaka, inte köp direkt.';

  const newScore = Math.min(100, (result.tradeScore ?? 0) + learnedRuleAdjustment);

  const newExpl = [...(result.scoreExplanationSv || [])];
  if (learnedRuleAdjustment > 0) {
    const msg = `Rule Memory: liknande blockering har historiskt fortsatt starkt (+${learnedRuleAdjustment} pts).`;
    if (!newExpl.includes(msg)) newExpl.push(msg);
  }

  return {
    ...result,
    tradeScore:         newScore,
    scoreExplanationSv: newExpl,
    ruleMemoryMatch: {
      matched:              true,
      ruleKey:              matched.reasonKey,
      primaryReason:        matched.primaryReason,
      watchModeRecommended: true,
      confidence:           matched.confidence,
      avgContinuation:      matched.avgContinuation,
      missedMoveCount:      matched.missedMoveCount,
      totalCount:           matched.count,
      strongMissRatio:      matched.strongMissRatio,
    },
    watchModeReason,
    learnedRuleAdjustment,
    ruleMemoryConfidence: matched.confidence,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { buildRuleMemory, loadRuleMemory, applyRuleMemory };
