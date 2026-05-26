'use strict';

// TradingAgents v1 — Read-only AI research layer.
// can_place_orders=false and actions_allowed=false enforced on every code path.

const redisService  = require('./redisService');
const resultMemory  = require('./tradingAgentsResultMemoryService');

const SOURCE = 'tradingagents_v1';

const KEYS = Object.freeze({
  latestPrefix: 'tradingagents:latest:',
  status: 'tradingagents:status',
  narrative: 'tradingagents:narrative:latest',
});

const TTL = Object.freeze({ latest: 300, status: 60, narrative: 300 });

// In-memory fallback when Redis is unavailable
const memCache = new Map();

function nowIso() { return new Date().toISOString(); }
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

async function cacheGet(key) {
  try {
    const val = await redisService.getJson(key, null);
    if (val) return val;
  } catch (_) {}
  const entry = memCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  return null;
}

async function cacheSet(key, value, ttl) {
  try { await redisService.setJson(key, value, ttl); } catch (_) {}
  memCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

// ── Safety: normalise forbidden recommendations ───────────────────────────────

const FORBIDDEN_RECS = new Set([
  'BUY_NOW', 'SELL_NOW', 'EXECUTE', 'PLACE_ORDER',
  'MARKET_BUY', 'MARKET_SELL', 'ORDER', 'TRADE_NOW',
]);

const ALLOWED_RECS = new Set(['BUY', 'SELL', 'HOLD', 'OBSERVE']);

function safeRecommendation(raw) {
  const up = String(raw || '').toUpperCase().replace(/[\s-]/g, '_');
  if (FORBIDDEN_RECS.has(up)) return 'OBSERVE';
  if (ALLOWED_RECS.has(up)) return up;
  return 'OBSERVE';
}

// ── Context builder ───────────────────────────────────────────────────────────

function buildTradingAgentsContext(signalContext = {}) {
  const ctx = signalContext && typeof signalContext === 'object' ? signalContext : {};
  return {
    ok: true,
    source: SOURCE,
    adapter_mode: 'rule_based_v1',
    can_place_orders: false,
    symbol: String(ctx.symbol || 'UNKNOWN').toUpperCase(),
    market_group: String(ctx.market_group || ctx.marketGroup || 'UNKNOWN'),
    direction: String(ctx.direction || ctx.engine_signal || ctx.signal || 'UNKNOWN').toUpperCase(),
    price: ctx.price ?? null,
    confidence: num(ctx.confidence ?? ctx.final_confidence ?? ctx.confidenceScore ?? ctx.base_confidence, 0),
    score: num(ctx.score ?? ctx.gate_score ?? ctx.tradeScore ?? ctx.final_confidence, 0),
    gate_score: num(ctx.gate_score ?? ctx.tradeScore, 0),
    signal_type: String(ctx.signal_type || ctx.signalSubtype || ctx.eventType || 'unknown'),
    volume_state: String(ctx.volume_state || ctx.volumeState || 'normal').toLowerCase(),
    ema_alignment: String(ctx.ema_alignment || ctx.emaAlignment || 'unknown').toLowerCase(),
    compass_conflict: ctx.compassConflict === true || ctx.compass_conflict === true,
    state: String(ctx.state || 'unknown'),
    fakeout_rate: num(ctx.fakeout_rate ?? ctx.fakeoutRate ?? ctx.global_fakeout_rate, null),
    timeout_rate: num(ctx.timeout_rate ?? ctx.timeoutRate, null),
    spread_pct: num(ctx.spread_pct ?? ctx.spreadPct, null),
    kill_switch_active: ctx.kill_switch_active === true || ctx.killSwitch === true,
    risk_paused: ctx.risk_paused === true || ctx.riskPaused === true,
    replay_mode: ctx.replay_mode !== false,
    paper_only: ctx.paper_only !== false,
    // Pass-through fields from pipeline
    ai_agent: ctx.ai_agent || ctx.aiAgent || null,
    memory: ctx.memory || null,
    risk: ctx.risk || null,
    exit: ctx.exit || null,
    safety: ctx.safety || null,
    strategy_preset: ctx.strategy_preset || ctx.active_preset || null,
    win_rate: num(ctx.win_rate ?? ctx.winRate, null),
    timestamp: ctx.timestamp || nowIso(),
    note: 'TradingAgents adapter is read-only in v1 — research and risk context only.',
  };
}

// ── Bull case ────────────────────────────────────────────────────────────────

function buildBullCase(context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const items = [];

  const score = num(ctx.score ?? ctx.gate_score, 0);
  const confidence = num(ctx.confidence, 0);
  const signalType = String(ctx.signal_type || '').toUpperCase();
  const volumeState = String(ctx.volume_state || 'normal').toLowerCase();
  const ema = String(ctx.ema_alignment || '').toLowerCase();
  const state = String(ctx.state || '').toLowerCase();
  const dir = String(ctx.direction || '').toUpperCase();

  if (signalType.includes('VWAP_RECLAIM') || signalType.includes('RECLAIM')) {
    items.push('VWAP reclaim bekräftad — priset återtar nyckelnivå');
  }
  if (signalType.includes('VWAP_REJECTION') || signalType.includes('REJECTION')) {
    items.push('VWAP rejection — starka säljare vid motståndet');
  }
  if (score >= 80) {
    items.push(`Signalstyrka hög (score: ${score})`);
  } else if (score >= 68) {
    items.push(`Signalstyrka acceptabel (score: ${score})`);
  }
  if (['strong', 'high'].includes(volumeState)) {
    items.push('Starkt volymstöd — rörelsen backas av kapital');
  }
  if ((ema === 'bullish' && ['BUY', 'UP'].includes(dir)) || (ema === 'bearish' && ['SELL', 'DOWN'].includes(dir))) {
    items.push('EMA-trend stödjer signalriktningen');
  }
  if (/narrow|compression/.test(state)) {
    items.push('Marknad i komprimering — potential för utbrott');
  }
  if (/trend|momentum/.test(state)) {
    items.push('Trendläge bekräftat — momentum stödjer');
  }
  if (!ctx.compass_conflict) {
    items.push('Marknadskompassen i linje med signal');
  }
  const winRate = num(ctx.win_rate, null);
  if (winRate !== null && winRate > 55) {
    items.push(`Historisk win rate: ${winRate}%`);
  }
  if (confidence >= 70) {
    items.push(`Konfidenspoäng stark (${confidence})`);
  }

  return items.length ? items : ['Inga tydliga bullsignaler identifierade'];
}

// ── Bear case ────────────────────────────────────────────────────────────────

function buildBearCase(context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const items = [];

  const score = num(ctx.score ?? ctx.gate_score, 0);
  const confidence = num(ctx.confidence, 0);
  const volumeState = String(ctx.volume_state || 'normal').toLowerCase();
  const ema = String(ctx.ema_alignment || '').toLowerCase();
  const state = String(ctx.state || '').toLowerCase();
  const dir = String(ctx.direction || '').toUpperCase();

  if (['weak', 'low'].includes(volumeState)) {
    items.push('Svagt volymstöd — rörelsen saknar övertygelse');
  }
  if ((ema === 'bearish' && ['BUY', 'UP'].includes(dir)) || (ema === 'bullish' && ['SELL', 'DOWN'].includes(dir))) {
    items.push('EMA-konflikt — trenden motverkar signalriktningen');
  }
  if (ctx.compass_conflict) {
    items.push('Marknadskompassen i konflikt med signalriktning');
  }
  if (score < 55) {
    items.push(`Låg signalstyrka (score: ${score}) — hög risk för falskt utbrott`);
  }
  const fakeoutRate = num(ctx.fakeout_rate, null);
  if (fakeoutRate !== null && fakeoutRate > 60) {
    items.push(`Hög fakeout-risk detekterad (${fakeoutRate}%)`);
  }
  const timeoutRate = num(ctx.timeout_rate, null);
  if (timeoutRate !== null && timeoutRate > 65) {
    items.push(`Hög timeout-rate (${timeoutRate}%) — prismål nås sällan i tid`);
  }
  const spreadPct = num(ctx.spread_pct, null);
  if (spreadPct !== null && spreadPct > 0.2) {
    items.push(`Hög spread: ${spreadPct}% — äter in vinsten`);
  }
  if (confidence < 50) {
    items.push(`Låg konfidenspoäng (${confidence}) — osäker signal`);
  }
  if (/choppy|reversal|exhaustion/.test(state)) {
    items.push(`Marknadstillstånd (${state}) motverkar entries`);
  }
  const winRate = num(ctx.win_rate, null);
  if (winRate !== null && winRate < 45) {
    items.push(`Historisk win rate låg: ${winRate}%`);
  }

  return items.length ? items : ['Inga tydliga bearfaktorer identifierade'];
}

// ── Risk case ────────────────────────────────────────────────────────────────

function buildRiskCase(context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const items = [];

  if (ctx.kill_switch_active) {
    items.push('Kill switch aktiv — all handel är blockerad');
  }
  if (ctx.risk_paused) {
    items.push('Riskmotorn pausad — inga nya trades tillåts');
  }
  const spreadPct = num(ctx.spread_pct, null);
  if (spreadPct !== null && spreadPct > 0.15) {
    items.push(`Spread: ${spreadPct}% — kontrollera likviditet`);
  }
  if (ctx.replay_mode !== false) {
    items.push('Replay-isolation aktivt — alla resultat är simulerade');
  }
  if (ctx.paper_only !== false) {
    items.push('Paper-läge aktivt — inga riktiga ordrar');
  }
  const fakeoutRate = num(ctx.fakeout_rate, null);
  if (fakeoutRate !== null && fakeoutRate > 50) {
    items.push(`Fakeout-rate ${fakeoutRate}% — position sizing bör justeras`);
  }
  const risk = ctx.risk;
  if (risk && risk.config_max_trades && risk.blocks_today_count >= risk.config_max_trades) {
    items.push('Dagsgränsen för antal trades kan vara nådd');
  }
  const safety = ctx.safety;
  if (safety && !safety.overall_safe) {
    items.push('Execution Safety: systemet rapporterar osäkert läge');
  }
  if (!items.length) {
    items.push('Inga akuta riskfaktorer identifierade');
  }
  return items;
}

// ── Market narrative ─────────────────────────────────────────────────────────

function buildMarketNarrative(context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const confidence = num(ctx.confidence, 0);
  const score = num(ctx.score ?? ctx.gate_score, 0);
  const dir = String(ctx.direction || '').toUpperCase();
  const state = String(ctx.state || 'unknown').toLowerCase();
  const volumeState = String(ctx.volume_state || 'normal').toLowerCase();
  const symbol = String(ctx.symbol || '').toUpperCase();

  if (ctx.kill_switch_active || ctx.risk_paused) {
    return `${symbol}: Handel blockerad av säkerhetssystem. TradingAgents rekommenderar OBSERVE tills systemet återupptar.`;
  }

  const sentiment = confidence >= 70 ? 'stark' : confidence >= 55 ? 'måttlig' : 'svag';
  const momentum = ['strong', 'high'].includes(volumeState) ? 'bekräftas av hög volym' : 'volym är neutral';
  const stateDesc = /narrow|compression/.test(state) ? 'komprimering — möjligt utbrott förestår'
    : /trend|momentum/.test(state) ? 'pågående trend'
    : /choppy|reversal/.test(state) ? 'osäkert/reverserande läge'
    : `läge: ${state}`;

  if (dir === 'BUY' || dir === 'UP') {
    return `${symbol}: Bullish signal med ${sentiment} konfidens (${confidence}). ${stateDesc.charAt(0).toUpperCase() + stateDesc.slice(1)}, ${momentum}. Score: ${score}. TradingAgents bedömer uppsidescase som ${confidence >= 65 ? 'trovärdigt' : 'osäkert'}.`;
  }
  if (dir === 'SELL' || dir === 'DOWN') {
    return `${symbol}: Bearish signal med ${sentiment} konfidens (${confidence}). ${stateDesc.charAt(0).toUpperCase() + stateDesc.slice(1)}, ${momentum}. Score: ${score}. TradingAgents ser nedsidesrisk som ${confidence >= 65 ? 'trovärdig' : 'osäker'}.`;
  }
  return `${symbol}: Neutral signal. Konfidens: ${confidence}, score: ${score}. Marknaden befinner sig i ${stateDesc}. TradingAgents rekommenderar att avvakta tydligare riktning.`;
}

// ── Confidence adjustment ────────────────────────────────────────────────────

function computeConfidenceAdjustment(context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  let adj = 0;

  const signalType = String(ctx.signal_type || '').toUpperCase();
  const volumeState = String(ctx.volume_state || 'normal').toLowerCase();
  const ema = String(ctx.ema_alignment || '').toLowerCase();
  const dir = String(ctx.direction || '').toUpperCase();
  const score = num(ctx.score ?? ctx.gate_score, 0);

  if (signalType.includes('VWAP_RECLAIM') || signalType.includes('RECLAIM')) adj += 4;
  if (['strong', 'high'].includes(volumeState)) adj += 3;
  if ((ema === 'bullish' && ['BUY', 'UP'].includes(dir)) || (ema === 'bearish' && ['SELL', 'DOWN'].includes(dir))) adj += 3;
  if ((ema === 'bearish' && ['BUY', 'UP'].includes(dir)) || (ema === 'bullish' && ['SELL', 'DOWN'].includes(dir))) adj -= 8;
  if (ctx.compass_conflict) adj -= 6;
  if (['weak', 'low'].includes(volumeState)) adj -= 4;
  if (score < 55) adj -= 5;
  if (ctx.kill_switch_active) adj -= 15;
  if (ctx.risk_paused) adj -= 10;

  const fakeoutRate = num(ctx.fakeout_rate, null);
  if (fakeoutRate !== null && fakeoutRate > 70) adj -= 5;
  else if (fakeoutRate !== null && fakeoutRate > 55) adj -= 3;

  return clamp(Math.round(adj), -15, 10);
}

function mapConfidenceAdjustment(result = {}) {
  return num(result.confidence_adjustment ?? result.confidenceAdjustment, 0);
}

// ── Should block trade ───────────────────────────────────────────────────────

function shouldBlockTrade(result = {}) {
  return result.should_block_trade === true || result.shouldBlockTrade === true;
}

// ── Recommendation logic ─────────────────────────────────────────────────────

function computeRecommendation(context = {}, confidenceAdj = 0) {
  const ctx = context && typeof context === 'object' ? context : {};

  if (ctx.kill_switch_active || ctx.risk_paused) return 'OBSERVE';

  const baseConfidence = num(ctx.confidence, 0);
  const adjustedConfidence = baseConfidence + confidenceAdj;
  const dir = String(ctx.direction || '').toUpperCase();

  if (adjustedConfidence < 45) return 'HOLD';
  if (adjustedConfidence >= 60) {
    if (['BUY', 'UP'].includes(dir)) return 'BUY';
    if (['SELL', 'DOWN'].includes(dir)) return 'SELL';
  }
  if (adjustedConfidence >= 45 && adjustedConfidence < 60) return 'HOLD';
  return 'OBSERVE';
}

// ── Main analysis ────────────────────────────────────────────────────────────

async function analyzeWithTradingAgents(signalContext = {}) {
  const ctx = buildTradingAgentsContext(signalContext);
  const symbol = ctx.symbol;
  const cacheKey = `${KEYS.latestPrefix}${symbol}`;

  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  // Load historical lessons for this symbol and feed into context
  let lessonAdj = 0;
  const lessonRiskNotes = [];
  try {
    const { lessons } = await resultMemory.getTradingAgentsLessons(symbol);
    const recent = (lessons || []).slice(0, 5);
    const failCount = recent.filter((l) => l.outcome === 'incorrect').length;
    const winCount  = recent.filter((l) => l.outcome === 'correct' || l.outcome === 'risk_saved').length;
    if (failCount >= 2) {
      lessonAdj = -3;
      lessonRiskNotes.push(`Historik: ${failCount} av ${recent.length} senaste analyser var felaktiga för ${symbol}`);
    } else if (winCount >= 3) {
      lessonAdj = 2;
      lessonRiskNotes.push(`Historik: ${winCount} av ${recent.length} senaste analyser var korrekta för ${symbol}`);
    }
  } catch (_) {}

  const bull = buildBullCase(ctx);
  const bear = buildBearCase(ctx);
  const risk = buildRiskCase(ctx);
  const narrative = buildMarketNarrative(ctx);
  const baseAdj = computeConfidenceAdjustment(ctx);
  const confidenceAdj = clamp(baseAdj + lessonAdj, -15, 10);
  const rawRec = computeRecommendation(ctx, confidenceAdj);
  const recommendation = safeRecommendation(rawRec);
  const blockTrade = ctx.kill_switch_active || ctx.risk_paused || confidenceAdj <= -12;
  const warnings = [];
  if (ctx.kill_switch_active) warnings.push('kill_switch_active');
  if (ctx.risk_paused) warnings.push('risk_engine_paused');
  if (blockTrade && !ctx.kill_switch_active && !ctx.risk_paused) warnings.push('confidence_adjustment_triggered_block');
  if (lessonAdj !== 0) warnings.push(`lesson_adj:${lessonAdj > 0 ? '+' : ''}${lessonAdj}`);

  const analysisId = resultMemory.makeId();

  const result = {
    ok: true,
    source: SOURCE,
    mode: 'read_only',
    can_place_orders: false,
    actions_allowed: false,
    symbol,
    analysis_id: analysisId,
    recommendation,
    confidence_adjustment: confidenceAdj,
    bull_case: bull,
    bear_case: bear,
    risk_notes: [...risk, ...lessonRiskNotes],
    market_narrative: narrative,
    should_block_trade: blockTrade,
    warnings,
    timestamp: nowIso(),
    replay_mode: ctx.replay_mode,
    paper_only: ctx.paper_only,
  };

  await cacheSet(cacheKey, result, TTL.latest);
  await cacheSet(KEYS.narrative, { ok: true, symbol, narrative, timestamp: result.timestamp }, TTL.narrative);

  // Persist outcome stub for later linking with trade results (non-blocking)
  resultMemory.saveTradingAgentsOutcome({
    analysis_id:          analysisId,
    symbol,
    timestamp:            result.timestamp,
    recommendation,
    confidence_adjustment: confidenceAdj,
    bull_case:            bull,
    bear_case:            bear,
    risk_notes:           result.risk_notes,
    market_narrative:     narrative,
    should_block_trade:   blockTrade,
  }).catch(() => {});

  return result;
}

// ── Latest analysis per symbol ───────────────────────────────────────────────

async function getLatestAnalysis(symbol) {
  const sym = String(symbol || '').toUpperCase().slice(0, 20) || 'UNKNOWN';
  const cacheKey = `${KEYS.latestPrefix}${sym}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  return {
    ok: true,
    source: SOURCE,
    mode: 'read_only',
    can_place_orders: false,
    actions_allowed: false,
    symbol: sym,
    recommendation: 'OBSERVE',
    confidence_adjustment: 0,
    bull_case: [],
    bear_case: [],
    risk_notes: ['Ingen analysdata tillgänglig för denna symbol ännu.'],
    market_narrative: `Ingen analys cachad för ${sym}. Skicka en POST /api/tradingagents/analyze för att analysera.`,
    should_block_trade: false,
    warnings: ['no_cached_analysis'],
    timestamp: nowIso(),
  };
}

// ── Normalise decision ───────────────────────────────────────────────────────

function normalizeTradingAgentsDecision(decision = {}) {
  const rawRec = String(decision.recommendation || decision.action || decision.decision || '').toUpperCase();
  const recommendation = safeRecommendation(rawRec);
  const wasForbidden = FORBIDDEN_RECS.has(rawRec.replace(/[\s-]/g, '_'));
  const warnings = Array.isArray(decision.warnings) ? [...decision.warnings] : [];
  if (wasForbidden) warnings.push(`forbidden_recommendation_normalised:${rawRec}`);

  return {
    ok: true,
    source: SOURCE,
    recommendation,
    bull_case: Array.isArray(decision.bull_case) ? decision.bull_case : (decision.bullCase ? [decision.bullCase] : []),
    bear_case: Array.isArray(decision.bear_case) ? decision.bear_case : (decision.bearCase ? [decision.bearCase] : []),
    risk_notes: Array.isArray(decision.risk_notes) ? decision.risk_notes : (decision.riskNotes ? [decision.riskNotes] : []),
    market_narrative: decision.market_narrative || decision.marketNarrative || '',
    confidence_adjustment: clamp(num(decision.confidence_adjustment ?? decision.confidenceAdjustment, 0), -15, 10),
    should_block_trade: decision.should_block_trade === true || decision.shouldBlockTrade === true,
    can_place_orders: false,
    actions_allowed: false,
    warnings,
  };
}

// ── Pipeline mapping (for Strategy Lab integration) ──────────────────────────

function mapTradingAgentsRiskToPipeline(decision = {}) {
  const normalized = normalizeTradingAgentsDecision(decision);
  return {
    method: 'trading_agents',
    enabled: true,
    ok: true,
    passed: normalized.should_block_trade !== true,
    score_delta: normalized.confidence_adjustment,
    block: normalized.should_block_trade === true,
    reason: normalized.should_block_trade ? 'trading_agents_research_block' : normalized.recommendation === 'OBSERVE' ? 'trading_agents_observe' : 'trading_agents_neutral_or_positive',
    warnings: normalized.warnings || [],
    data: normalized,
  };
}

// ── Status ───────────────────────────────────────────────────────────────────

async function getTradingAgentsStatus() {
  const cached = await cacheGet(KEYS.status);
  if (cached) return cached;

  const result = {
    ok: true,
    source: SOURCE,
    version: 'v1',
    installed: false,
    enabled: true,
    mode: 'rule_based_v1',
    execution_enabled: false,
    can_place_orders: false,
    actions_allowed: false,
    live_trading_enabled: false,
    python_runtime_available: false,
    redis_keys: Object.values(KEYS),
    ttl: TTL,
    repository: 'https://github.com/tauricresearch/tradingagents',
    safety: {
      direct_trade_creation_allowed: false,
      output_role: 'research_commentary_confidence_risk_only',
      forbidden_recommendations: [...FORBIDDEN_RECS],
      allowed_recommendations: [...ALLOWED_RECS],
    },
    timestamp: nowIso(),
  };

  await cacheSet(KEYS.status, result, TTL.status);
  return result;
}

module.exports = {
  KEYS,
  buildTradingAgentsContext,
  analyzeWithTradingAgents,
  buildBullCase,
  buildBearCase,
  buildRiskCase,
  buildMarketNarrative,
  normalizeTradingAgentsDecision,
  mapConfidenceAdjustment,
  shouldBlockTrade,
  mapTradingAgentsRiskToPipeline,
  getTradingAgentsStatus,
  getLatestAnalysis,
};
