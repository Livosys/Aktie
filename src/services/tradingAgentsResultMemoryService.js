'use strict';

// TradingAgents Result Memory v1
// Links TradingAgents analyses to paper/replay trade results and tracks accuracy.
// SAFETY: Never creates trades, modifies config, or writes to live state.
// actions_allowed=false, can_place_orders=false, live_trading_enabled=false always.

const redisService = require('./redisService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  result_memory_can_create_trades: false,
  result_memory_can_modify_risk: false,
  result_memory_can_modify_safety: false,
  result_memory_can_write_live_state: false,
});

const REDIS_KEYS = Object.freeze({
  outcome:    (id)  => `tradingagents:outcome:${id}`,
  outcomes:   (sym) => `tradingagents:outcomes:${sym}`,
  stats:      (sym) => `tradingagents:stats:${sym}`,
  lessons:    (sym) => `tradingagents:lessons:${sym}`,
  globalStats: 'tradingagents:stats:global',
  symbols: 'tradingagents:symbols',
});

const TTL = Object.freeze({
  outcome:    604800,  // 7 days
  outcomes:   86400,   // 24h
  stats:      300,
  lessons:    300,
  globalStats: 300,
  symbols:    86400,
});

const LINK_WINDOW_MS      = 10 * 60 * 1000;
const MAX_LESSONS         = 20;
const MAX_OUTCOMES        = 100;
const CORRECT_THRESHOLD   = 0.15;
const MISSED_THRESHOLD    = 0.30;

// ── In-memory fallback ────────────────────────────────────────────────────────

const memOutcomes    = new Map();  // analysis_id → outcome
const memSymbolIds   = new Map();  // symbol → string[]
const memLinkedIds   = new Set();  // linked trade ids
const memSymbols     = new Set();  // known symbols

function nowIso() { return new Date().toISOString(); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function makeId() { return `ta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

async function rGet(key) {
  try { return await redisService.getJson(key, null); } catch (_) { return null; }
}
async function rSet(key, value, ttl) {
  try { await redisService.setJson(key, value, ttl); } catch (_) {}
}

// ── Evaluate outcome rules ────────────────────────────────────────────────────

function evaluateTradingAgentsOutcome(analysis, tradeResult) {
  const rec     = String(analysis.recommendation || 'OBSERVE').toUpperCase();
  const pnl     = num(tradeResult.pnl_pct ?? tradeResult.pnlPct);
  const result  = String(tradeResult.result || '').toUpperCase();
  const loss    = result === 'LOSS' || pnl <= -CORRECT_THRESHOLD;
  const bigWin  = pnl >= MISSED_THRESHOLD;
  const blocked = analysis.should_block_trade === true;

  // Risk saved: agent recommended blocking + trade actually lost
  if (blocked && loss) {
    return {
      outcome: 'risk_saved',
      lesson: `AI:n varnade bra — riskvarning stämde, traden gick dåligt (P/L: ${pnl.toFixed(2)}%)`,
    };
  }

  if (rec === 'BUY') {
    if (pnl >= CORRECT_THRESHOLD) return { outcome: 'correct', lesson: `AI:n trodde rätt — BUY rekommendation stämde (P/L: +${pnl.toFixed(2)}%)` };
    if (pnl <= -CORRECT_THRESHOLD) return { outcome: 'incorrect', lesson: `AI:n trodde fel — BUY rekommendation, traden förlorade (P/L: ${pnl.toFixed(2)}%)` };
    return { outcome: 'neutral', lesson: `AI:n sa BUY, liten rörelse (P/L: ${pnl.toFixed(2)}%)` };
  }

  // SELL: price drop = correct (paper trade goes long, loses = SELL was right)
  if (rec === 'SELL') {
    if (pnl <= -CORRECT_THRESHOLD) return { outcome: 'correct', lesson: `AI:n trodde rätt — SELL rekommendation, priset föll (P/L: ${pnl.toFixed(2)}%)` };
    if (pnl >= CORRECT_THRESHOLD)  return { outcome: 'incorrect', lesson: `AI:n trodde fel — SELL rekommendation men priset steg (P/L: +${pnl.toFixed(2)}%)` };
    return { outcome: 'neutral', lesson: `AI:n sa SELL, liten rörelse (P/L: ${pnl.toFixed(2)}%)` };
  }

  if (rec === 'OBSERVE') {
    if (bigWin) return { outcome: 'missed_opportunity', lesson: `AI:n missade en chans — OBSERVE men traden vann tydligt (P/L: +${pnl.toFixed(2)}%)` };
    if (loss)   return { outcome: 'correct', lesson: `AI:n hade rätt att avvakta — OBSERVE, traden förlorade (P/L: ${pnl.toFixed(2)}%)` };
    return { outcome: 'neutral', lesson: `AI:n sa OBSERVE, liten rörelse (P/L: ${pnl.toFixed(2)}%)` };
  }

  if (rec === 'HOLD') {
    if (Math.abs(pnl) < CORRECT_THRESHOLD) return { outcome: 'correct', lesson: `AI:n rätt att vänta — HOLD, liten rörelse som förväntat (P/L: ${pnl.toFixed(2)}%)` };
    if (bigWin) return { outcome: 'missed_opportunity', lesson: `AI:n missade en chans — HOLD men traden vann tydligt (P/L: +${pnl.toFixed(2)}%)` };
    return { outcome: 'neutral', lesson: `AI:n sa HOLD (P/L: ${pnl.toFixed(2)}%)` };
  }

  return { outcome: 'neutral', lesson: 'Otillräckliga data för att bedöma resultatet' };
}

// ── Save analysis outcome stub ────────────────────────────────────────────────

async function saveTradingAgentsOutcome(input) {
  const id     = input.analysis_id || makeId();
  const symbol = String(input.symbol || 'UNKNOWN').toUpperCase();

  const outcome = {
    analysis_id: id,
    symbol,
    timestamp: input.timestamp || nowIso(),
    recommendation: input.recommendation || 'OBSERVE',
    confidence_adjustment: num(input.confidence_adjustment),
    bull_case: Array.isArray(input.bull_case) ? input.bull_case : [],
    bear_case: Array.isArray(input.bear_case) ? input.bear_case : [],
    risk_notes: Array.isArray(input.risk_notes) ? input.risk_notes : [],
    market_narrative: String(input.market_narrative || ''),
    should_block_trade: input.should_block_trade === true,
    linked_trade_id: null,
    trade_result: null,
    outcome: 'pending',
    lesson: null,
    ...SAFETY,
  };

  await rSet(REDIS_KEYS.outcome(id), outcome, TTL.outcome);

  // Update symbol index
  let ids = (await rGet(REDIS_KEYS.outcomes(symbol))) || memSymbolIds.get(symbol) || [];
  ids = [id, ...ids.filter((x) => x !== id)].slice(0, MAX_OUTCOMES);
  await rSet(REDIS_KEYS.outcomes(symbol), ids, TTL.outcomes);

  // Update known symbols list
  let syms = (await rGet(REDIS_KEYS.symbols)) || [...memSymbols];
  if (!syms.includes(symbol)) {
    syms = [symbol, ...syms].slice(0, 50);
    await rSet(REDIS_KEYS.symbols, syms, TTL.symbols);
  }

  // Memory fallback
  memOutcomes.set(id, outcome);
  memSymbolIds.set(symbol, ids);
  memSymbols.add(symbol);

  // Invalidate stats caches so next read recomputes
  await rSet(REDIS_KEYS.stats(symbol), null, 1);
  await rSet(REDIS_KEYS.globalStats, null, 1);

  return { ok: true, analysis_id: id, ...SAFETY };
}

// ── Link analysis to closed trade ────────────────────────────────────────────

async function linkAnalysisToTrade(analysisId, tradeId, tradeResult) {
  const stored = (await rGet(REDIS_KEYS.outcome(analysisId))) || memOutcomes.get(analysisId);
  if (!stored) return { ok: false, error: 'analysis_not_found' };

  const evaluation = evaluateTradingAgentsOutcome(stored, tradeResult);
  const updated = {
    ...stored,
    linked_trade_id: tradeId,
    trade_result: {
      pnl_pct:    num(tradeResult.pnl_pct ?? tradeResult.pnlPct),
      win:        tradeResult.win === true || String(tradeResult.result || '').toUpperCase() === 'WIN',
      exit_reason: tradeResult.exit_reason || tradeResult.exitReason || null,
      exit_source: tradeResult.exit_source || tradeResult.exitReasonCode || null,
    },
    outcome:      evaluation.outcome,
    lesson:       evaluation.lesson,
    evaluated_at: nowIso(),
    ...SAFETY,
  };

  await rSet(REDIS_KEYS.outcome(analysisId), updated, TTL.outcome);
  memOutcomes.set(analysisId, updated);
  memLinkedIds.add(tradeId);

  // Invalidate cached stats
  await rSet(REDIS_KEYS.stats(stored.symbol), null, 1);
  await rSet(REDIS_KEYS.globalStats, null, 1);
  await rSet(REDIS_KEYS.lessons(stored.symbol), null, 1);

  return { ok: true, analysis_id: analysisId, trade_id: tradeId, outcome: evaluation.outcome, lesson: evaluation.lesson, ...SAFETY };
}

// ── Load outcomes for symbol ──────────────────────────────────────────────────

async function getSymbolOutcomes(symbol) {
  const ids = (await rGet(REDIS_KEYS.outcomes(symbol))) || memSymbolIds.get(symbol) || [];
  const outcomes = [];
  for (const id of ids) {
    const o = (await rGet(REDIS_KEYS.outcome(id))) || memOutcomes.get(id);
    if (o) outcomes.push(o);
  }
  return outcomes;
}

// ── Compute stats from outcomes ───────────────────────────────────────────────

function computeStats(outcomes) {
  const evaluated    = outcomes.filter((o) => o.outcome !== 'pending');
  const correct      = evaluated.filter((o) => o.outcome === 'correct').length;
  const incorrect    = evaluated.filter((o) => o.outcome === 'incorrect').length;
  const neutral      = evaluated.filter((o) => o.outcome === 'neutral').length;
  const missed       = evaluated.filter((o) => o.outcome === 'missed_opportunity').length;
  const riskSaved    = evaluated.filter((o) => o.outcome === 'risk_saved').length;
  const total        = evaluated.length;
  const accuracy     = total > 0 ? Math.round(((correct + riskSaved) / total) * 100) : null;

  return {
    total_analyses: outcomes.length,
    total_evaluated: total,
    correct,
    incorrect,
    neutral,
    missed_opportunity: missed,
    risk_saved: riskSaved,
    accuracy_pct: accuracy,
    pending: outcomes.filter((o) => o.outcome === 'pending').length,
  };
}

// ── Stats per symbol ──────────────────────────────────────────────────────────

async function getTradingAgentsResultStats(symbol) {
  const sym    = String(symbol || '').toUpperCase();
  const cached = await rGet(REDIS_KEYS.stats(sym));
  if (cached && cached.total_analyses != null) {
    return { ok: true, symbol: sym, ...cached, ...SAFETY };
  }

  const outcomes = await getSymbolOutcomes(sym);
  const stats    = computeStats(outcomes);
  await rSet(REDIS_KEYS.stats(sym), stats, TTL.stats);
  return { ok: true, symbol: sym, ...stats, ...SAFETY };
}

// ── Global stats ──────────────────────────────────────────────────────────────

async function getTradingAgentsGlobalStats() {
  const cached = await rGet(REDIS_KEYS.globalStats);
  if (cached && cached.total_analyses != null) {
    return { ok: true, global: true, ...cached, ...SAFETY };
  }

  // Collect outcomes across all known symbols (Redis + memory)
  const syms = (await rGet(REDIS_KEYS.symbols)) || [...memSymbols];
  let allOutcomes = [];
  for (const sym of syms) {
    const outcomes = await getSymbolOutcomes(sym);
    allOutcomes = allOutcomes.concat(outcomes);
  }
  // Also include any in-memory outcomes not yet indexed by symbol
  for (const o of memOutcomes.values()) {
    if (!allOutcomes.find((x) => x.analysis_id === o.analysis_id)) {
      allOutcomes.push(o);
    }
  }

  const stats = computeStats(allOutcomes);
  await rSet(REDIS_KEYS.globalStats, stats, TTL.globalStats);
  return { ok: true, global: true, ...stats, ...SAFETY };
}

// ── Lessons ───────────────────────────────────────────────────────────────────

async function getTradingAgentsLessons(symbol) {
  const sym    = String(symbol || '').toUpperCase();
  const cached = await rGet(REDIS_KEYS.lessons(sym));
  if (Array.isArray(cached)) {
    return { ok: true, symbol: sym, lessons: cached, ...SAFETY };
  }

  const outcomes = await getSymbolOutcomes(sym);
  const lessons  = outcomes
    .filter((o) => o.lesson && o.outcome !== 'pending')
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, MAX_LESSONS)
    .map((o) => ({
      lesson:         o.lesson,
      outcome:        o.outcome,
      recommendation: o.recommendation,
      timestamp:      o.timestamp,
      pnl_pct:        o.trade_result?.pnl_pct ?? null,
    }));

  await rSet(REDIS_KEYS.lessons(sym), lessons, TTL.lessons);
  return { ok: true, symbol: sym, lessons, ...SAFETY };
}

// ── Auto-link: match pending analyses to closed paper trades ─────────────────

async function autoLinkClosedTrades(symbol) {
  let paperTrading;
  try { paperTrading = require('../paperTrading/paperTradingAgent'); } catch (_) { return; }

  const sym = String(symbol || '').toUpperCase();
  let closedTrades = [];
  try {
    const { trades } = paperTrading.getTrades();
    closedTrades = (trades || []).filter((t) =>
      (t.symbol || t.signalSymbol || '').toUpperCase() === sym &&
      t.result !== 'OPEN' &&
      t.pnlPct != null
    );
  } catch (_) { return; }

  if (!closedTrades.length) return;

  const ids = (await rGet(REDIS_KEYS.outcomes(sym))) || memSymbolIds.get(sym) || [];
  const pending = [];
  for (const id of ids) {
    const o = (await rGet(REDIS_KEYS.outcome(id))) || memOutcomes.get(id);
    if (o && o.outcome === 'pending' && !o.linked_trade_id) pending.push(o);
  }

  if (!pending.length) return;

  for (const trade of closedTrades) {
    const tradeId     = trade.tradeId || trade.id || String(trade.entryTime);
    if (memLinkedIds.has(tradeId)) continue;

    const entryMs = new Date(trade.entryTime || trade.timestamp).getTime();
    if (!entryMs) continue;

    const matchIdx = pending.findIndex((o) => {
      const analysisMs = new Date(o.timestamp).getTime();
      return Math.abs(analysisMs - entryMs) <= LINK_WINDOW_MS;
    });

    if (matchIdx !== -1) {
      const match = pending[matchIdx];
      pending.splice(matchIdx, 1); // remove to prevent double-linking same analysis
      await linkAnalysisToTrade(match.analysis_id, tradeId, {
        pnl_pct:     trade.pnlPct,
        win:         trade.result === 'WIN',
        result:      trade.result,
        exit_reason: trade.exitReason,
        exit_source: trade.exitReasonCode || trade.exitReason,
      });
    }
  }
}

// ── Build full result memory summary ─────────────────────────────────────────

async function buildResultMemorySummary(symbol) {
  const sym = String(symbol || '').toUpperCase();

  // Lazy link any new closed trades before building summary
  await autoLinkClosedTrades(sym);

  const [statsRes, lessonsRes, outcomes] = await Promise.all([
    getTradingAgentsResultStats(sym),
    getTradingAgentsLessons(sym),
    getSymbolOutcomes(sym),
  ]);

  const recentOutcomes = outcomes
    .filter((o) => o.outcome !== 'pending')
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 5)
    .map((o) => ({
      analysis_id:    o.analysis_id,
      recommendation: o.recommendation,
      outcome:        o.outcome,
      lesson:         o.lesson,
      timestamp:      o.timestamp,
      pnl_pct:        o.trade_result?.pnl_pct ?? null,
    }));

  return {
    ok: true,
    symbol: sym,
    stats:           statsRes,
    lessons:         lessonsRes.lessons.slice(0, 5),
    recent_outcomes: recentOutcomes,
    ...SAFETY,
  };
}

// ── Reset symbol data ─────────────────────────────────────────────────────────

async function resetTradingAgentsResultMemoryForSymbol(symbol) {
  const sym  = String(symbol || '').toUpperCase();
  const ids  = (await rGet(REDIS_KEYS.outcomes(sym))) || memSymbolIds.get(sym) || [];

  for (const id of ids) {
    await rSet(REDIS_KEYS.outcome(id), null, 1);
    memOutcomes.delete(id);
  }

  await rSet(REDIS_KEYS.outcomes(sym), [], 1);
  await rSet(REDIS_KEYS.stats(sym), null, 1);
  await rSet(REDIS_KEYS.lessons(sym), [], 1);
  await rSet(REDIS_KEYS.globalStats, null, 1);

  memSymbolIds.delete(sym);
  memSymbols.delete(sym);

  return { ok: true, symbol: sym, reset: true, deleted_count: ids.length, ...SAFETY };
}

module.exports = {
  SAFETY,
  REDIS_KEYS,
  makeId,
  evaluateTradingAgentsOutcome,
  saveTradingAgentsOutcome,
  linkAnalysisToTrade,
  getTradingAgentsResultStats,
  getTradingAgentsGlobalStats,
  getTradingAgentsLessons,
  buildResultMemorySummary,
  resetTradingAgentsResultMemoryForSymbol,
  autoLinkClosedTrades,
};
