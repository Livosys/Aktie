'use strict';

const redisService = require('./redisService');
const vectorMemoryService = require('./vectorMemoryService');

const CACHE_TTL_SECONDS = 15 * 60;
const LATEST_KEY = 'agent:latest_analysis';
const LEGACY_LATEST_KEY = 'agent:latest-analysis';
const SOURCE = 'rule_based_v1';
const BLOCKING_RISK_FLAGS = new Set([
  'low_liquidity',
  'extreme_volatility',
  'bad_data',
  'market_closed',
  'missing_core_indicators',
]);

let memoryLatestAnalysis = null;
const memoryBySymbol = new Map();

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clampNumber(n, min, max) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(min, Math.min(max, num));
}

function symbolKey(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getConfidence(signalContext = {}) {
  return numberOrNull(
    signalContext.confidence ??
    signalContext.confidenceScore ??
    signalContext.score ??
    signalContext.gate?.confidenceScore
  );
}

function getDirection(signalContext = {}) {
  const direction = String(
    signalContext.direction ||
    signalContext.nextMoveBias ||
    signalContext.bias ||
    ''
  ).trim().toUpperCase();
  if (direction === 'UP' || direction === 'DOWN') return direction;
  return 'UNCERTAIN';
}

function text(value, fallback = 'okänd') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

function safeSentence(value) {
  return String(value || '')
    .replace(/\bköp\b/gi, 'titta manuellt')
    .replace(/\bsälj\b/gi, 'titta manuellt')
    .replace(/\bbuy\b/gi, 'manual review')
    .replace(/\bsell\b/gi, 'manual review')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function collectRiskFlags(signalContext = {}) {
  const flags = new Set();
  const volumeState = lower(signalContext.volumeState || signalContext.volume?.state || signalContext.volume?.volumeState);
  const dataFreshness = lower(signalContext.dataFreshness || signalContext.feedStatus || signalContext.gate?.dataFreshness);
  const extension = lower(signalContext.extensionLevel || signalContext.indicators?.extensionLevel || signalContext.gate?.extensionLevel);
  const state = lower(signalContext.state);
  const volatility = lower(signalContext.volatilityState || signalContext.indicators?.volatilityState);
  const hardBlockers = asArray(signalContext.hardBlockers || signalContext.gate?.hardBlockers);
  const softBlockers = asArray(signalContext.softBlockers || signalContext.gate?.softBlockers);
  const blockersText = [...hardBlockers, ...softBlockers].join(' ').toLowerCase();
  const indicators = signalContext.indicators && typeof signalContext.indicators === 'object'
    ? signalContext.indicators
    : {};

  if (volumeState && ['low', 'weak', 'very_low', 'thin'].includes(volumeState)) flags.add('low_liquidity');
  if (/liquidity|likvid|thin|low volume|svag volym/.test(blockersText)) flags.add('low_liquidity');
  if (extension === 'extreme' || volatility === 'extreme' || /extreme volatility|extrem volatilitet/.test(blockersText)) flags.add('extreme_volatility');
  if (['stale', 'delayed', 'bad', 'unknown'].includes(dataFreshness) || /bad data|stale|data/.test(blockersText)) flags.add('bad_data');
  if (signalContext.marketClosed === true || dataFreshness === 'market_closed' || /market closed|marknaden.*stängd|session/.test(blockersText)) flags.add('market_closed');

  const hasMeaningfulIndicators = Object.values(indicators).some((value) => {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    return true;
  });
  const hasCoreIndicators =
    hasMeaningfulIndicators ||
    !!signalContext.tf2m ||
    !!signalContext.signalFamily ||
    !!signalContext.signalSubtype ||
    signalContext.gate?.gateScore != null;
  if (!hasCoreIndicators) flags.add('missing_core_indicators');

  if (state === 'wide' && extension && extension !== 'none') flags.add('extended_move');
  if (signalContext.twoMinuteConflict === true || /2m.*conflict|2m.*konflikt/.test(blockersText)) flags.add('two_minute_conflict');
  if (hardBlockers.length > 0) flags.add('hard_blockers_present');

  return Array.from(flags);
}

function buildTechnicalView(signalContext = {}) {
  const symbol = text(signalContext.symbol, 'Symbolen');
  const direction = getDirection(signalContext);
  const score = numberOrNull(signalContext.score ?? signalContext.priorityScore ?? signalContext.gate?.gateScore);
  const confidence = getConfidence(signalContext);
  const state = text(signalContext.state || signalContext.marketState || signalContext.narrowState);
  const family = text(signalContext.signalFamily || signalContext.indicators?.signalFamily, 'ingen namngiven signalfamilj');
  const subtype = text(signalContext.signalSubtype || signalContext.indicators?.signalSubtype, '');
  const volumeState = text(signalContext.volumeState || signalContext.volume?.state || signalContext.volume?.volumeState);
  const parts = [
    `${symbol} har riktning ${direction} från fast engine.`,
    `Signalbilden är ${family}${subtype ? `/${subtype}` : ''}.`,
    `State är ${state} och volymbilden är ${volumeState}.`,
  ];
  if (score != null) parts.push(`Score är ${score}.`);
  if (confidence != null) parts.push(`Konfidens är ${confidence}.`);
  return safeSentence(parts.join(' '));
}

function buildBullCase(signalContext = {}) {
  const supports = [];
  const confidence = getConfidence(signalContext);
  const agreement = numberOrNull(signalContext.agreementCount || signalContext.indicators?.agreementCount);
  const volumeState = lower(signalContext.volumeState || signalContext.volume?.state || signalContext.volume?.volumeState);
  const status = lower(signalContext.status || signalContext.gate?.status);
  const freshness = lower(signalContext.dataFreshness || signalContext.gate?.dataFreshness);

  if (confidence != null && confidence >= 65) supports.push('konfidensen är hög i regelmotorn');
  if (agreement != null && agreement >= 4) supports.push('flera tidsramar stödjer riktningen');
  if (volumeState === 'strong') supports.push('volymen är stark');
  if (['active', 'watch', 'caution'].includes(status)) supports.push('gate-läget är bevakningsbart');
  if (freshness === 'live') supports.push('datan är live');
  if (signalContext.marketPersonality?.trendFriendly === true) supports.push('marknadspersonligheten stödjer trend');

  return safeSentence(supports.length
    ? `Bull-case: ${supports.join(', ')}.`
    : 'Bull-case är begränsat eftersom få förstärkande faktorer är tydliga i signalcontext.');
}

function buildBearCase(signalContext = {}) {
  const warnings = [];
  const confidence = getConfidence(signalContext);
  const volumeState = lower(signalContext.volumeState || signalContext.volume?.state || signalContext.volume?.volumeState);
  const extension = lower(signalContext.extensionLevel || signalContext.indicators?.extensionLevel);
  const freshness = lower(signalContext.dataFreshness || signalContext.gate?.dataFreshness);

  warnings.push(...asArray(signalContext.hardBlockers || signalContext.gate?.hardBlockers).slice(0, 3));
  warnings.push(...asArray(signalContext.softBlockers || signalContext.gate?.softBlockers).slice(0, 3));
  if (confidence != null && confidence < 45) warnings.push('konfidensen är låg');
  if (['low', 'weak', 'very_low'].includes(volumeState)) warnings.push('volymen är svag');
  if (signalContext.twoMinuteConflict === true) warnings.push('2m-bilden säger emot');
  if (extension && extension !== 'none') warnings.push(`rörelsen är ${extension}`);
  if (freshness && freshness !== 'live') warnings.push(`dataFreshness=${freshness}`);

  return safeSentence(warnings.length
    ? `Bear-case: ${warnings.slice(0, 6).join(', ')}.`
    : 'Bear-case saknar tydliga extra varningar utöver ordinarie gate-logik.');
}

function buildRiskView(signalContext = {}) {
  const riskFlags = collectRiskFlags(signalContext);
  let adjustment = 0;

  if (riskFlags.includes('missing_core_indicators')) adjustment -= 10;
  if (riskFlags.includes('bad_data')) adjustment -= 12;
  if (riskFlags.includes('market_closed')) adjustment -= 15;
  if (riskFlags.includes('low_liquidity')) adjustment -= 8;
  if (riskFlags.includes('extreme_volatility')) adjustment -= 14;
  if (riskFlags.includes('two_minute_conflict')) adjustment -= 7;
  if (riskFlags.includes('hard_blockers_present')) adjustment -= 10;
  if (riskFlags.includes('extended_move')) adjustment -= 4;

  const volumeState = lower(signalContext.volumeState || signalContext.volume?.state || signalContext.volume?.volumeState);
  const confidence = getConfidence(signalContext);
  const agreement = numberOrNull(signalContext.agreementCount || signalContext.indicators?.agreementCount);
  const freshness = lower(signalContext.dataFreshness || signalContext.gate?.dataFreshness);
  if (volumeState === 'strong') adjustment += 4;
  if (confidence != null && confidence >= 70) adjustment += 3;
  if (agreement != null && agreement >= 5) adjustment += 3;
  if (freshness === 'live' && !riskFlags.includes('bad_data')) adjustment += 1;

  const blockingFlags = riskFlags.filter((flag) => BLOCKING_RISK_FLAGS.has(flag));
  const shouldBlockTrade = blockingFlags.length > 0;
  const riskNotes = riskFlags.length
    ? `Riskflaggor: ${riskFlags.join(', ')}. ${shouldBlockTrade ? 'Minst en flagga är blockerande.' : 'Ingen flagga är blockerande i v1.'}`
    : 'Inga tydliga riskflaggor hittades i agentens regelbaserade kontroll.';

  return {
    risk_notes: safeSentence(riskNotes),
    confidence_adjustment: clamp(adjustment, -15, 10),
    risk_flags: riskFlags,
    should_block_trade: shouldBlockTrade,
  };
}

function memoryRiskFlags(memorySummary = {}) {
  const flags = [];
  const sampleSize = Number(memorySummary.sample_size || 0);
  const winRate = Number(memorySummary.win_rate);
  const avgMae = Math.abs(Number(memorySummary.avg_mae_pct || 0));
  const avgMove = Math.abs(Number(memorySummary.avg_move_15m_pct || 0));

  if (sampleSize >= 20 && Number.isFinite(winRate) && winRate < 35) {
    flags.push('bad_historical_setup');
  }
  if (sampleSize >= 10 && avgMae >= Math.max(0.6, avgMove * 1.5)) {
    flags.push('historical_high_drawdown');
  }
  return flags;
}

function memoryMayBlockTrade(memorySummary = {}, flags = [], signalContext = {}) {
  const sampleSize = Number(memorySummary.sample_size || 0);
  const winRate = Number(memorySummary.win_rate);
  const avgMae = Math.abs(Number(memorySummary.avg_mae_pct || 0));
  const expectedTarget = Math.abs(Number(
    signalContext.targetPct ??
    signalContext.paper?.targetPct ??
    signalContext.gate?.targetPct ??
    0.4
  ));
  return sampleSize >= 30 &&
    Number.isFinite(winRate) &&
    winRate < 30 &&
    avgMae > Math.max(0.6, expectedTarget * 1.5) &&
    flags.includes('bad_historical_setup');
}

function buildFinalCommentary(agentParts = {}) {
  const symbol = text(agentParts.symbol, 'symbolen');
  const direction = text(agentParts.direction, 'UNCERTAIN');
  const blockText = agentParts.should_block_trade
    ? 'Agenten föreslår blockering på grund av blockerande riskflagga.'
    : 'Agenten föreslår ingen extra blockering.';
  const memoryText = agentParts.memory_summary?.memory_warning
    ? ` Minnet varnar: ${agentParts.memory_summary.memory_warning}`
    : '';
  return safeSentence(`Fast engine är fortsatt enda källa för handelsbeslut. För ${symbol} är riktningen ${direction}; agenten justerar bara förklaring, risk och confidence. ${blockText}${memoryText}`);
}

async function cacheAnalysis(analysis) {
  memoryLatestAnalysis = analysis;
  if (analysis.symbol) memoryBySymbol.set(analysis.symbol, analysis);

  try {
    const okLatest = await redisService.setJson(LATEST_KEY, analysis, CACHE_TTL_SECONDS);
    const okLegacy = await redisService.setJson(LEGACY_LATEST_KEY, analysis, CACHE_TTL_SECONDS);
    const okSymbol = analysis.symbol
      ? await redisService.setJson(`agent:analysis:${analysis.symbol}`, analysis, CACHE_TTL_SECONDS)
      : true;
    if (!okLatest || !okSymbol || !okLegacy) {
      console.warn('[agent-reasoning] Redis cache misslyckades, använder memory fallback');
    }
  } catch (err) {
    console.warn('[agent-reasoning] Redis cache misslyckades:', err.message);
  }
}

async function analyzeSignal(signalContext = {}) {
  const context = signalContext && typeof signalContext === 'object' ? signalContext : {};
  const symbol = symbolKey(context.symbol);
  const direction = getDirection(context);
  console.log(`[agent-reasoning] kör analys för ${symbol || 'UNKNOWN'} ${direction}`);

  const technicalView = buildTechnicalView(context);
  const bullCase = buildBullCase(context);
  const bearCase = buildBearCase(context);
  const risk = buildRiskView(context);
  let memoryResult = null;
  try {
    memoryResult = await vectorMemoryService.findSimilarSetups(context, { limit: 25 });
  } catch (err) {
    console.warn(`[agent-reasoning] memory fallback for ${symbol || 'UNKNOWN'}:`, err.message);
  }
  const memorySummary = memoryResult?.summary || {
    sample_size: 0,
    win_rate: null,
    avg_move_15m_pct: null,
    avg_mfe_pct: null,
    avg_mae_pct: null,
    memory_confidence_adjustment: 0,
    memory_warning: null,
  };
  const safeMemoryAdjustment = clamp(
    memorySummary.memory_confidence_adjustment,
    memorySummary.sample_size < 10 ? -1 : -10,
    memorySummary.sample_size < 10 ? 1 : 8
  );
  const memoryFlags = memoryRiskFlags(memorySummary);
  const riskFlags = Array.from(new Set([...risk.risk_flags, ...memoryFlags]));
  const memoryShouldBlock = memoryMayBlockTrade(memorySummary, memoryFlags, context);
  const combinedAdjustment = clamp(
    clampNumber(risk.confidence_adjustment, -15, 10) + safeMemoryAdjustment,
    -15,
    10
  );
  const base = {
    ok: true,
    symbol,
    direction,
    timestamp: nowIso(),
    technical_view: technicalView,
    bull_case: bullCase,
    bear_case: bearCase,
    risk_notes: risk.risk_notes,
    base_confidence_adjustment: risk.confidence_adjustment,
    memory_confidence_adjustment: safeMemoryAdjustment,
    confidence_adjustment: combinedAdjustment,
    risk_flags: riskFlags,
    should_block_trade: risk.should_block_trade || memoryShouldBlock,
    memory_should_block_trade: memoryShouldBlock,
    memory_summary: memorySummary,
    memory_matches: (memoryResult?.matches || []).slice(0, 5),
    memory_provider: memoryResult?.provider || vectorMemoryService.PROVIDER,
    memory_storage_provider: memoryResult?.storage_provider || null,
    memory_warning: memorySummary.memory_warning,
    source: `${SOURCE}+memory_v1`,
  };
  const analysis = {
    ...base,
    final_commentary: buildFinalCommentary(base),
  };

  await cacheAnalysis(analysis);
  return analysis;
}

async function getLatestAnalysis(fallback = null) {
  try {
    const analysis = await redisService.getJson(LATEST_KEY, null);
    if (analysis) return analysis;
    const legacy = await redisService.getJson(LEGACY_LATEST_KEY, null);
    if (legacy) return legacy;
  } catch (err) {
    console.warn('[agent-reasoning] Redis läsning misslyckades, använder fallback:', err.message);
  }
  if (memoryLatestAnalysis) {
    console.log('[agent-reasoning] fallback används för senaste analys');
    return memoryLatestAnalysis;
  }
  return fallback;
}

async function getAnalysisForSymbol(symbol, fallback = null) {
  const normalized = symbolKey(symbol);
  if (!normalized) return fallback;
  try {
    const analysis = await redisService.getJson(`agent:analysis:${normalized}`, null);
    if (analysis) return analysis;
  } catch (err) {
    console.warn(`[agent-reasoning] Redis läsning misslyckades för ${normalized}, använder fallback:`, err.message);
  }
  if (memoryBySymbol.has(normalized)) {
    console.log(`[agent-reasoning] fallback används för ${normalized}`);
    return memoryBySymbol.get(normalized);
  }
  return fallback;
}

function isBlockingRisk(analysis) {
  if (analysis?.memory_should_block_trade === true) return true;
  return analysis?.should_block_trade === true &&
    asArray(analysis.risk_flags).some((flag) => BLOCKING_RISK_FLAGS.has(flag));
}

module.exports = {
  analyzeSignal,
  buildTechnicalView,
  buildBullCase,
  buildBearCase,
  buildRiskView,
  buildFinalCommentary,
  getLatestAnalysis,
  getAnalysisForSymbol,
  isBlockingRisk,
  BLOCKING_RISK_FLAGS: Array.from(BLOCKING_RISK_FLAGS),
  CACHE_TTL_SECONDS,
  LATEST_KEY,
};
