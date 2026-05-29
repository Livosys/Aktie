'use strict';

/**
 * Agent Debate Engine v1
 * ----------------------
 * Regelbaserad research-/analysmotor. Ingen LLM, inga externa beroenden,
 * inga ordervägar. Output är rådgivande för paper/replay/batch.
 */

const SAFETY = Object.freeze({
  live: false,
  analysis_only: true,
  paper_only: true,
  actions_allowed: false,
  can_place_orders: false,
  can_modify_system: false,
  live_trading_enabled: false,
  live_enabled: false,
});

const ROLES = Object.freeze([
  'technical',
  'sentiment',
  'bull',
  'bear',
  'risk',
  'final_decision',
]);

const VERSION = 'agent_debate_engine_v1';
const SUPPORTED_DECISIONS = Object.freeze(['OBSERVE', 'WAIT', 'PAPER_LONG', 'PAPER_SHORT']);
const BLOCKED_ORDER_KEYS = new Set([
  'broker',
  'order',
  'execution',
  'place_order',
  'create_order',
  'buy_now',
  'sell_now',
  'trade_now',
]);
const IMPORTANT_DATA_FIELDS = Object.freeze(['confidence', 'volume_ratio', 'spread_estimate', 'volatility', 'rsi']);

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampNullable(value, min, max) {
  const n = numberOrNull(value);
  if (n == null) return null;
  return Math.max(min, Math.min(max, n));
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().slice(0, 32);
}

function normalizeDirection(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['up', 'long', 'bull', 'bullish', 'buy', 'paper_long', 'call'].includes(raw)) return 'UP';
  if (['down', 'short', 'bear', 'bearish', 'sell', 'paper_short', 'put'].includes(raw)) return 'DOWN';
  return 'NEUTRAL';
}

function boolTrue(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function hasBlockedOrderKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  for (const [key, val] of Object.entries(value)) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (BLOCKED_ORDER_KEYS.has(normalizedKey) && val !== false && val !== null && val !== undefined && val !== '') return true;
    if (val && typeof val === 'object' && hasBlockedOrderKey(val, depth + 1)) return true;
  }
  return false;
}

function hasLiveOrderIntent(input = {}) {
  const mode = String(input.mode || input.execution_mode || '').toLowerCase();
  const action = String(input.action || input.order_action || input.intent || '').toLowerCase();
  return hasBlockedOrderKey(input)
    || boolTrue(input.live)
    || boolTrue(input.live_enabled)
    || boolTrue(input.live_trading_enabled)
    || boolTrue(input.actions_allowed)
    || boolTrue(input.can_place_orders)
    || boolTrue(input.can_modify_system)
    || boolTrue(input.place_order)
    || boolTrue(input.create_order)
    || mode.includes('live')
    || /order|execute|broker|buy_now|sell_now|trade_now/.test(action);
}

function safeEnvelope(extra = {}) {
  return {
    ...extra,
    ...SAFETY,
  };
}

function normalizeAgentDecision(decision) {
  const normalized = String(decision || '').trim().toUpperCase();
  return SUPPORTED_DECISIONS.includes(normalized) ? normalized : 'OBSERVE';
}

function assertAnalysisOnly(output = {}) {
  const safe = { ...output };
  if (safe.final_decision) safe.final_decision = normalizeAgentDecision(safe.final_decision);
  return safeEnvelope(safe);
}

function normalizeContext(input = {}) {
  const symbol = normalizeSymbol(firstPresent(input.symbol, input.ticker, input.traded_symbol, input.underlying_symbol));
  const direction = normalizeDirection(firstPresent(
    input.underlying_signal_direction,
    input.direction,
    input.nextMoveBias,
    input.bias,
    input.signal,
  ));
  const confidenceScore = clampNullable(firstPresent(
    input.underlying_signal_strength,
    input.confidence,
    input.confidenceScore,
    input.tradeScore,
    input.signalScore,
    input.score,
  ), 0, 100);
  const volumeRatio = clampNullable(firstPresent(input.volume_ratio, input.volumeRatio, input.relativeVolume, input.volume_requirement), 0, 20);
  const spreadEstimate = clampNullable(firstPresent(input.spread_estimate, input.spreadEstimate, input.spread_percent, input.spreadPct), 0, 20);
  const volatility = clampNullable(firstPresent(input.volatility, input.volatility_score, input.atr_percent, input.atrPct), 0, 100);
  const rsiValue = numberOrNull(firstPresent(input.rsi, input.rsi14));
  const missingFields = new Set(Array.isArray(input.missing_fields) ? input.missing_fields.map(String) : []);
  if (confidenceScore == null) missingFields.add('confidence');
  if (volumeRatio == null) missingFields.add('volume_ratio');
  if (spreadEstimate == null) missingFields.add('spread_estimate');
  if (volatility == null) missingFields.add('volatility');
  if (rsiValue == null) missingFields.add('rsi');
  return {
    symbol,
    market_group: firstPresent(input.market_group, input.marketGroup, input.market, input.marketType, 'unknown'),
    timeframe: firstPresent(input.timeframe, input.tf, '2m'),
    direction,
    confidence_score: confidenceScore,
    signal_family: firstPresent(input.signalFamily, input.signal_family, input.strategy_id, input.setup, 'unknown'),
    price: firstPresent(input.price, input.last, input.close, input.currentPrice),
    volume_ratio: volumeRatio,
    spread_estimate: spreadEstimate,
    volatility,
    rsi: rsiValue,
    missing_fields: [...missingFields],
    risk_class: firstPresent(input.risk_class, input.riskClass, 'unknown'),
    raw: input,
  };
}

function missing(ctx, field) {
  return Array.isArray(ctx.missing_fields) && ctx.missing_fields.includes(field);
}

function importantMissingFields(ctx) {
  return (ctx.missing_fields || []).filter((field) => IMPORTANT_DATA_FIELDS.includes(field));
}

function confidencePenalty(missingCount) {
  if (missingCount <= 0) return 0;
  if (missingCount === 1) return 5;
  if (missingCount === 2) return 10;
  if (missingCount === 3) return 15;
  if (missingCount === 4) return 20;
  return 25;
}

function dataQuality(ctx) {
  const fields = importantMissingFields(ctx);
  return {
    status: fields.length ? 'partial' : 'complete',
    missing_fields: fields,
    message: fields.length ? 'Viss data saknas, därför är analysen mer osäker.' : 'Datakvaliteten är komplett för de viktigaste fälten.',
  };
}

function technicalAgent(ctx) {
  let score = ctx.confidence_score == null ? 50 : ctx.confidence_score;
  const reasons = [];
  if (ctx.confidence_score == null) reasons.push('Signalstyrka saknas.');
  if (ctx.direction === 'UP') reasons.push('Grundsignalen pekar uppåt.');
  if (ctx.direction === 'DOWN') reasons.push('Grundsignalen pekar nedåt.');
  if (ctx.direction === 'NEUTRAL') {
    score = Math.min(score, 45);
    reasons.push('Riktningen är neutral eller oklar.');
  }
  if (ctx.volume_ratio == null) {
    reasons.push('Volymdata saknas.');
  } else if (ctx.volume_ratio >= 1.5) {
    score += 8;
    reasons.push('Volymen stödjer rörelsen.');
  } else if (ctx.volume_ratio > 0 && ctx.volume_ratio < 0.8) {
    score -= 8;
    reasons.push('Volymen är svag.');
  }
  if (ctx.rsi == null) {
    reasons.push('RSI saknas.');
  } else if (ctx.rsi >= 78 || ctx.rsi <= 22) {
    score -= 6;
    reasons.push('RSI är i ett spänt läge.');
  }
  const finalScore = clamp(score, 0, 100);
  return {
    role: 'technical',
    bias: ctx.direction === 'UP' ? 'BULLISH' : ctx.direction === 'DOWN' ? 'BEARISH' : 'NEUTRAL',
    score: Math.round(finalScore),
    confidence: Math.round(finalScore),
    rationale_sv: reasons.join(' ') || 'Teknisk kontext saknas, neutral bedömning.',
  };
}

function sentimentAgent() {
  return {
    role: 'sentiment',
    bias: 'NEUTRAL',
    score: 50,
    confidence: 0,
    rationale_sv: 'Sentiment är avstängt i Fas 1. Regelmotorn använder neutral sentiment-stub.',
  };
}

function bullAgent(ctx, technical) {
  const strength = technical.bias === 'BULLISH'
    ? clamp(technical.score + (ctx.volume_ratio != null && ctx.volume_ratio >= 1.5 ? 6 : 0), 0, 100)
    : clamp(35 + ((ctx.confidence_score ?? 50) / 5), 0, 55);
  return {
    role: 'bull',
    case_strength: Math.round(strength),
    thesis_sv: technical.bias === 'BULLISH'
      ? `Bull-case finns: riktning och teknisk styrka stödjer fortsatt uppgång i paper-test.${missing(ctx, 'volume_ratio') ? ' Volymdata saknas, så caset är mer osäkert.' : ''}`
      : 'Bull-case är svagt eftersom grundriktningen inte är tydligt uppåt.',
  };
}

function bearAgent(ctx, technical) {
  let strength = technical.bias === 'BEARISH' ? technical.score : 35;
  if (ctx.spread_estimate != null && ctx.spread_estimate >= 0.3) strength += 8;
  if (ctx.volatility != null && ctx.volatility >= 4) strength += 8;
  if (ctx.confidence_score != null && ctx.confidence_score < 55) strength += 10;
  const missingText = [
    missing(ctx, 'spread_estimate') ? 'Spread saknas.' : null,
    missing(ctx, 'volatility') ? 'Volatilitet saknas.' : null,
  ].filter(Boolean).join(' ');
  return {
    role: 'bear',
    case_strength: Math.round(clamp(strength, 0, 100)),
    thesis_sv: technical.bias === 'BEARISH'
      ? `Bear-case finns: riktning och teknisk styrka stödjer fortsatt nedgång i paper-test. ${missingText}`.trim()
      : `Bear-case bygger främst på risk, spread, volatilitet eller svag signalstyrka. ${missingText}`.trim(),
  };
}

function riskAgent(ctx) {
  const flags = [];
  const missingImportant = importantMissingFields(ctx);
  const riskClass = String(ctx.risk_class || '').toLowerCase();
  if (['high', 'very_high', 'extreme'].includes(riskClass)) flags.push('risk_class_high');
  if (ctx.spread_estimate != null && ctx.spread_estimate >= 0.3) flags.push('spread_high');
  if (ctx.volatility != null && ctx.volatility >= 4) flags.push('volatility_high');
  if (ctx.confidence_score != null && ctx.confidence_score < 55) flags.push('confidence_low');
  if (missingImportant.length) flags.push('missing_market_data');
  const level = flags.length >= 2 ? 'high' : flags.length === 1 || missingImportant.length ? 'medium' : 'low';
  const mainRisk = missingImportant.length
    ? 'Viss marknadsdata saknas, därför är bedömningen mer osäker.'
    : flags.length
      ? 'Riskflaggor finns i signalen.'
      : 'Inga tydliga riskflaggor i den data som skickades in.';
  return {
    role: 'risk',
    risk_level: level,
    main_risk: mainRisk,
    flags,
    missing_fields: missingImportant,
    allow_paper_observation: true,
    allow_live_order: false,
    rationale_sv: `${mainRisk} Endast observation/paper.`,
  };
}

function finalDecision(ctx, technical, bull, bear, risk) {
  const edge = bull.case_strength - bear.case_strength;
  const missingImportant = importantMissingFields(ctx);
  let decision = 'OBSERVE';
  if (risk.risk_level === 'high') {
    decision = 'WAIT';
  } else if (ctx.direction === 'UP' && technical.score >= 68 && edge >= 12) {
    decision = 'PAPER_LONG';
  } else if (ctx.direction === 'DOWN' && technical.score >= 68 && edge <= -12) {
    decision = 'PAPER_SHORT';
  } else if (technical.score >= 55) {
    decision = 'WAIT';
  }
  const confidenceScore = clamp(
    decision === 'OBSERVE' ? Math.min(technical.score, 45)
      : decision === 'WAIT' ? Math.min(technical.score, 65)
        : technical.score,
    0,
    100,
  );
  const adjustedConfidenceScore = clamp(confidenceScore - confidencePenalty(missingImportant.length), 0, 100);
  const uncertaintyText = missingImportant.length
    ? ` Viss data saknas (${missingImportant.join(', ')}), därför är analysen mer osäker.`
    : '';
  return {
    final_decision: normalizeAgentDecision(decision),
    confidence: Number((adjustedConfidenceScore / 100).toFixed(2)),
    confidence_score: Math.round(adjustedConfidenceScore),
    rationale_sv: `${decision} är rådgivande. Teknisk score ${technical.score}, bull ${bull.case_strength}, bear ${bear.case_strength}, risk ${risk.risk_level}.${uncertaintyText} Inga order får skickas.`,
  };
}

function analyzeSignal(input = {}) {
  if (hasLiveOrderIntent(input)) {
    return assertAnalysisOnly({
      ok: false,
      error: 'live_or_order_intent_blocked',
      message: 'Agent Debate Engine är analysis_only och avvisar live/order-intent.',
      source: 'agent_debate_engine',
      mode: 'analysis_only',
      generated_at: nowIso(),
    });
  }
  const ctx = normalizeContext(input);
  if (!ctx.symbol) {
    return assertAnalysisOnly({
      ok: false,
      error: 'symbol_required',
      message: 'symbol krävs för analys.',
      source: 'agent_debate_engine',
      mode: 'analysis_only',
      generated_at: nowIso(),
    });
  }
  const technical = technicalAgent(ctx);
  const sentiment = sentimentAgent(ctx);
  const bull = bullAgent(ctx, technical);
  const bear = bearAgent(ctx, technical);
  const risk = riskAgent(ctx);
  const final = finalDecision(ctx, technical, bull, bear, risk);
  return assertAnalysisOnly({
    ok: true,
    source: 'agent_debate_engine',
    version: VERSION,
    mode: 'analysis_only',
    symbol: ctx.symbol,
    market_group: ctx.market_group,
    timeframe: ctx.timeframe,
    signal: {
      direction: ctx.direction,
      confidence_score: ctx.confidence_score,
      signal_family: ctx.signal_family,
    },
    missing_fields: ctx.missing_fields,
    data_quality: dataQuality(ctx),
    data_quality_warning: ctx.missing_fields.length ? 'Viss data saknas, så analysen är mer osäker.' : null,
    final_decision: final.final_decision,
    confidence: final.confidence,
    confidence_score: final.confidence_score,
    agents: { technical, sentiment, bull, bear, risk },
    rationale_sv: final.rationale_sv,
    generated_at: nowIso(),
  });
}

function getStatus() {
  return assertAnalysisOnly({
    ok: true,
    source: 'agent_debate_engine',
    version: VERSION,
    mode: 'analysis_only',
    enabled: true,
    llm_enabled: false,
    external_dependencies: [],
    roles: ROLES,
    supported_decisions: SUPPORTED_DECISIONS,
    generated_at: nowIso(),
  });
}

module.exports = {
  SAFETY,
  VERSION,
  getStatus,
  analyzeSignal,
  hasLiveOrderIntent,
  normalizeAgentDecision,
  assertAnalysisOnly,
};
