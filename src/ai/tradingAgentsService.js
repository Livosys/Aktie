'use strict';

const redis = require('../services/redisService');

const CACHE_TTL_SECONDS = 10 * 60;

function clamp(n, min, max) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function safeText(value) {
  return String(value || '')
    .replace(/\bköp\b/gi, 'titta manuellt')
    .replace(/\bsälj\b/gi, 'titta manuellt')
    .replace(/buy/gi, 'manual review')
    .replace(/sell/gi, 'manual review')
    .slice(0, 500);
}

function directionFromCandidate(candidate) {
  const raw = String(candidate?.nextMoveBias || candidate?.direction || '').toUpperCase();
  if (raw === 'UP' || raw === 'DOWN') return raw;
  return 'UNCERTAIN';
}

function technicalAgent(candidate, candles = []) {
  const agreement = Number(candidate?.agreementCount || 0);
  const tf2m = candidate?.tf2m || candidate?.timeframeAgreement?.tf2m || 'unknown';
  const extension = candidate?.extensionLevel || 'none';
  const candleCount = Array.isArray(candles) ? candles.length : 0;
  const parts = [
    `${candidate?.signalFamily || 'NO_SIGNAL'} ${candidate?.signalSubtype || ''}`.trim(),
    `status ${candidate?.status || 'unknown'}`,
    `timeframe-stöd ${agreement}/6`,
    `2m ${tf2m}`,
    `extension ${extension}`,
  ];
  if (candleCount) parts.push(`${candleCount} senaste candles finns`);
  return safeText(parts.join(', ') + '.');
}

function newsSentimentAgent(candidate) {
  const marketType = candidate?.marketType || candidate?.market || 'unknown';
  return safeText(`Ingen extern nyhetsmodell körs i v1. Sentiment hålls neutral för ${marketType}.`);
}

function bullAgent(candidate) {
  const supports = [
    Number(candidate?.agreementCount || 0) >= 4 ? 'flera tidsramar stödjer riktningen' : null,
    candidate?.volumeState === 'strong' ? 'volymen är stark' : null,
    candidate?.dataFreshness === 'LIVE' ? 'data är live' : null,
    candidate?.status === 'watch' || candidate?.status === 'caution' ? 'regelmotorn har satt bevakningsbart läge' : null,
  ].filter(Boolean);
  return safeText(supports.length ? supports.join(', ') + '.' : 'Bull case är svagt eftersom få stödjande faktorer är tydliga.');
}

function bearAgent(candidate) {
  const warnings = [
    ...asArray(candidate?.hardBlockers),
    ...asArray(candidate?.softBlockers),
    candidate?.twoMinuteConflict ? '2m-konflikt' : null,
    candidate?.extensionLevel && candidate.extensionLevel !== 'none' ? `rörelsen är ${candidate.extensionLevel}` : null,
    candidate?.dataFreshness && candidate.dataFreshness !== 'LIVE' ? `dataFreshness=${candidate.dataFreshness}` : null,
    candidate?.volumeState && !['normal', 'strong'].includes(String(candidate.volumeState).toLowerCase()) ? `volumeState=${candidate.volumeState}` : null,
  ].filter(Boolean);
  return safeText(warnings.length ? warnings.slice(0, 5).join(', ') + '.' : 'Bear case saknar tydliga blockerare i aktuell snapshot.');
}

function riskAgent(candidate) {
  let adjustment = 0;
  const riskNotes = [];
  const hardBlockers = asArray(candidate?.hardBlockers);
  const softBlockers = asArray(candidate?.softBlockers);

  if (hardBlockers.length) {
    adjustment -= 15;
    riskNotes.push('Hårda blockerare finns.');
  }
  if (softBlockers.length) {
    adjustment -= Math.min(10, softBlockers.length * 3);
    riskNotes.push('Mjuka varningar finns.');
  }
  if (candidate?.twoMinuteConflict) {
    adjustment -= 8;
    riskNotes.push('2m-bilden säger emot.');
  }
  if (candidate?.extensionLevel === 'medium') {
    adjustment -= 4;
    riskNotes.push('Rörelsen är delvis utsträckt.');
  }
  if (candidate?.extensionLevel === 'extreme') {
    adjustment -= 12;
    riskNotes.push('Rörelsen är extremt utsträckt.');
  }
  if (candidate?.volumeState === 'strong') {
    adjustment += 4;
    riskNotes.push('Stark volym minskar viss osäkerhet.');
  }
  if (Number(candidate?.agreementCount || 0) >= 5) {
    adjustment += 3;
    riskNotes.push('Flera tidsramar stödjer signalen.');
  }
  if (candidate?.dataFreshness && candidate.dataFreshness !== 'LIVE') {
    adjustment -= 10;
    riskNotes.push('Data är inte live.');
  }

  const shouldBlockTrade =
    hardBlockers.length > 0 ||
    candidate?.dataFreshness === 'STALE' ||
    candidate?.extensionLevel === 'extreme';

  return {
    confidence_adjustment: clamp(adjustment, -25, 15),
    risk_notes: safeText(riskNotes.length ? riskNotes.join(' ') : 'Riskläget är neutralt i den lokala agentmodellen.'),
    should_block_trade: shouldBlockTrade,
  };
}

function finalCommentaryAgent(candidate, risk, direction) {
  const base = `Fast engine är primär beslutsmotor. Agentlagret ger endast förklaring, riskflagga och confidence-justering för ${candidate?.symbol || 'symbolen'}.`;
  const riskText = risk.should_block_trade
    ? 'Riskagenten föreslår blockering eller manuell väntan.'
    : 'Riskagenten föreslår ingen extra blockering.';
  return safeText(`${base} Riktning från fast engine: ${direction}. ${riskText}`);
}

function buildAgentAnalysis({ candidate, candles = [], source = 'local_mock' }) {
  const symbol = String(candidate?.symbol || '').toUpperCase();
  const direction = directionFromCandidate(candidate);
  const risk = riskAgent(candidate || {});
  const analysis = {
    symbol,
    direction,
    technical_view: technicalAgent(candidate || {}, candles),
    bull_case: bullAgent(candidate || {}),
    bear_case: bearAgent(candidate || {}),
    risk_notes: risk.risk_notes,
    confidence_adjustment: risk.confidence_adjustment,
    final_commentary: finalCommentaryAgent(candidate || {}, risk, direction),
    should_block_trade: risk.should_block_trade,
    timestamp: new Date().toISOString(),
    mode: source,
    agent_roles: ['Technical Agent', 'News/Sentiment Agent', 'Bull Agent', 'Bear Agent', 'Risk Agent', 'Final Commentary Agent'],
    sentiment_view: newsSentimentAgent(candidate || {}),
  };
  return analysis;
}

async function analyzeSignal({ candidate, candles = [], source = 'local_mock', cache = true }) {
  const analysis = buildAgentAnalysis({ candidate, candles, source });
  if (cache && analysis.symbol) {
    await redis.setJson(`agent:analysis:${analysis.symbol}`, analysis, CACHE_TTL_SECONDS);
    await redis.setJson('agent:latest-analysis', analysis, CACHE_TTL_SECONDS);
    await redis.addStream('agent:analysis-stream', analysis, 100);
    await redis.publish('agent:analysis', analysis);
  }
  return analysis;
}

async function getLatestAnalysis(fallback = null) {
  return redis.getJson('agent:latest-analysis', fallback);
}

module.exports = {
  analyzeSignal,
  buildAgentAnalysis,
  getLatestAnalysis,
};
