'use strict';

const { getLatestResults } = require('../scanner/scheduler');
const { getCryptoResults } = require('../scanner/cryptoScheduler');
const { buildDaytradeSignal } = require('../scanner/daytradeSignalEngine');
const setupPerformance = require('./setupPerformanceService');
const marketRegime = require('./marketRegimeService');
const paperTrading = require('../paperTrading/paperTradingAgent');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  can_create_trades: false,
  can_modify_risk: false,
  agent_mode: 'analysis_only',
  source: 'priority_engine_v1',
});

const STRATEGY_LABELS = {
  vwap_reclaim: 'VWAP reclaim',
  vwap_rejection: 'VWAP avvisning',
  ema_trend: 'EMA trend',
  ema_pullback: 'EMA pullback',
  narrow_state: 'Narrow State',
  breakout: 'Utbrott',
  momentum: 'Momentum',
  mean_reversion: 'Återgång',
  volume_spike: 'Volymtopp',
  vwap_momentum: 'VWAP momentum',
  vwap_rejection_short: 'VWAP short',
  opening_range_breakout: 'Opening Range',
  pullback_continuation: 'Pullback',
  mean_reversion_vwap: 'Återgång VWAP',
  volume_spike_momentum: 'Volym + momentum',
  index_trend_mode: 'Index trend',
  sector_confirmation: 'Sektorstöd',
  news_volatility_watch: 'Nyhetsvolatilitet',
};

const CRYPTO_SYMS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT']);
const INDEX_SYMS = new Set(['QQQ', 'SPY', 'IWM', 'DIA']);
const LEVERAGED = new Set(['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'UPRO', 'SPXU', 'FNGU', 'FNGD']);

function clamp(n, min = 0, max = 100) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function round(n, decimals = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}

function cleanValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return 0;
  if (Array.isArray(value)) return value.map(cleanValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, cleanValue(val)]));
  }
  return value;
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v == null) return [];
  return [v].filter(Boolean);
}

function getMarketGroup(signal = {}) {
  const sym = String(signal.symbol || '').toUpperCase();
  const market = String(signal.marketType || signal.market || '').toLowerCase();
  if (market === 'crypto' || CRYPTO_SYMS.has(sym) || sym.endsWith('USDT') || sym.endsWith('BTC')) return 'crypto';
  if (LEVERAGED.has(sym)) return 'leveraged_etf';
  if (INDEX_SYMS.has(sym) || market === 'etf') return 'index';
  if (market === 'nasdaq') return 'nasdaq';
  return 'stocks';
}

function signalToStrategyKey(signal = {}) {
  const f = String(signal.signalFamily || signal.family || signal.signal || '').toUpperCase();
  const s = String(signal.signalSubtype || signal.subtype || '').toUpperCase();
  if (f.includes('VWAP')) {
    if (s.includes('DOWN') || s.includes('REJECT') || String(signal.signal || '').startsWith('SHORT')) return 'vwap_rejection';
    return 'vwap_reclaim';
  }
  if (f.includes('EMA')) return s.includes('PULLBACK') ? 'ema_pullback' : 'ema_trend';
  if (f.includes('NARROW') || String(signal.state || '').includes('NARROW')) return 'narrow_state';
  if (f.includes('BREAKOUT')) return 'breakout';
  if (f.includes('MOMENTUM')) return 'momentum';
  if (f.includes('REVERSION') || f.includes('REVERSAL')) return 'mean_reversion';
  if (f.includes('PULLBACK')) return 'pullback_continuation';
  if (Number(signal.relVol20 || signal.relativeVolume || 0) >= 2) return 'volume_spike';
  return 'momentum';
}

function direction(signal = {}) {
  const raw = String(signal.signal || signal.nextMoveBias || signal.momentumBias || signal.direction || '').toUpperCase();
  if (raw.includes('SHORT') || raw.includes('DOWN') || raw.includes('BEAR')) return 'bearish';
  if (raw.includes('LONG') || raw.includes('UP') || raw.includes('BULL')) return 'bullish';
  return 'neutral';
}

function setupNeedle(signal = {}) {
  return [
    signal.signalSubtype,
    signal.signalFamily,
    signalToStrategyKey(signal),
    getMarketGroup(signal),
    signal.volumeState,
    signal.status,
  ].filter(Boolean).join(' ').toLowerCase();
}

function findSetupStats(signal, setupData) {
  const setups = [
    ...(setupData?.topSetups || []),
    ...(setupData?.poorSetups || []),
    ...(setupData?.neutralSetups || []),
    ...(setupData?.setups || []),
  ];
  if (!setups.length) return null;
  const needle = setupNeedle(signal);
  return setups.find((s) => {
    const hay = `${s.setup_id || ''} ${s.label || ''} ${s.signal_subtype || ''} ${s.market_type || ''}`.toLowerCase();
    return hay && hay.split(/[^a-z0-9]+/).some((part) => part.length > 3 && needle.includes(part));
  }) || null;
}

function strategyWeight(strategyKey, regimeSummary) {
  const weights = regimeSummary?.strategyWeights?.weights || [];
  const row = weights.find((w) => w.key === strategyKey);
  return Number(row?.regimeAdj || 0);
}

function indexAlignment(signal, regimeSummary) {
  const bias = regimeSummary?.indexBias?.overall;
  const dir = direction(signal);
  if (!bias || dir === 'neutral') return 0;
  if ((bias === 'bullish' && dir === 'bullish') || (bias === 'bearish' && dir === 'bearish')) return 8;
  if ((bias === 'bullish' && dir === 'bearish') || (bias === 'bearish' && dir === 'bullish')) return -10;
  return -2;
}

function volumeScore(signal = {}) {
  const rv = Number(signal.relVol20 ?? signal.relativeVolume ?? signal.relVol ?? 1);
  const state = String(signal.volumeState || '').toLowerCase();
  if (state.includes('weak') || state.includes('low') || rv < 0.7) return -12;
  if (rv >= 2 || state.includes('strong')) return 10;
  if (rv >= 1.3) return 5;
  return 0;
}

function timeoutRisk(signal = {}, setupStats = null) {
  const timeoutRate = Number(setupStats?.ties || 0) / Math.max(1, Number(setupStats?.total_trades || 0));
  const hold = Number(signal.holdingMinutes || signal.maxHoldMinutes || signal.maxHoldTime || 0);
  const extension = String(signal.extensionLevel || '').toLowerCase();
  let score = 0;
  if (timeoutRate >= 0.45) score += 18;
  else if (timeoutRate >= 0.3) score += 10;
  if (hold >= 60) score += 6;
  if (extension === 'medium') score += 8;
  if (extension === 'extreme') score += 16;
  return clamp(score, 0, 35);
}

function blockerPenalty(signal = {}) {
  const hard = asArray(signal.hardBlockers).length;
  const soft = asArray(signal.softBlockers).length + asArray(signal.blockers).length;
  let penalty = hard * 18 + soft * 6;
  if (signal.twoMinuteConflict) penalty += 12;
  if (signal.dataFreshness && signal.dataFreshness !== 'LIVE') penalty += 8;
  return penalty;
}

function recentPerformanceAdjustment(setupStats = null, paperPerf = null) {
  let adj = 0;
  const wr = Number(setupStats?.win_rate);
  if (Number.isFinite(wr)) {
    if (wr >= 58 && Number(setupStats?.decisive || 0) >= 5) adj += 10;
    if (wr <= 40 && Number(setupStats?.decisive || 0) >= 3) adj -= 16;
  }
  const paperWr = Number(paperPerf?.winRate);
  if (Number.isFinite(paperWr)) {
    if (paperWr >= 0.55) adj += 2;
    if (paperWr < 0.4) adj -= 4;
  }
  return adj;
}

function detectStrategyFatigue(signal, setupStats = null, regimeSummary = null) {
  const strategyKey = signalToStrategyKey(signal);
  const perf = regimeSummary?.strategyPerformance?.byStrategy?.[strategyKey];
  const setupWeak = Number(setupStats?.win_rate) <= 40 && Number(setupStats?.decisive || 0) >= 3;
  const regimeWeak = perf?.winRate != null && perf.winRate < 35 && Number(perf.trades || 0) >= 5;
  if (setupWeak || regimeWeak) {
    return {
      active: true,
      text: `${STRATEGY_LABELS[strategyKey] || 'Strategin'} tappar styrka senaste perioden.`,
    };
  }
  return { active: false, text: null };
}

function calculatePriorityScore(signal, context = {}) {
  const setupStats = context.setupStats || findSetupStats(signal, context.setupPerformance);
  const strategyKey = signalToStrategyKey(signal);
  const pulse = clamp(signal._pulseScore ?? signal.pulseScore ?? signal.tradeScore ?? signal.confidenceScore ?? signal.score ?? 45);
  const weight = strategyWeight(strategyKey, context.marketRegime);
  const vol = volumeScore(signal);
  const alignment = indexAlignment(signal, context.marketRegime);
  const timeout = timeoutRisk(signal, setupStats);
  const blockers = blockerPenalty(signal);
  const ai = clamp((Number(signal.aiAnalysis?.confidence ?? signal.agentScore ?? signal.confidenceScore ?? 0) - 50) / 5, -6, 8);
  const history = recentPerformanceAdjustment(setupStats, context.paperPerformance);
  const fakeoutPenalty = Number(signal.fakeoutProbability || 0) >= 70 ? 12 : Number(signal.fakeoutProbability || 0) >= 55 ? 6 : 0;
  const consistency = Number(signal.agreementCount || 0) >= 4 ? 5 : Number(signal.agreementCount || 0) <= 1 ? -4 : 0;

  const score = pulse * 0.58
    + 25
    + weight * 0.65
    + vol
    + alignment
    + ai
    + history
    + consistency
    - timeout
    - blockers
    - fakeoutPenalty;

  return round(clamp(score), 0);
}

function buildMarketContext(signal, context = {}) {
  const setupStats = context.setupStats || findSetupStats(signal, context.setupPerformance);
  const strategyKey = signalToStrategyKey(signal);
  const weight = strategyWeight(strategyKey, context.marketRegime);
  const timeout = timeoutRisk(signal, setupStats);
  const alignment = indexAlignment(signal, context.marketRegime);
  const vol = volumeScore(signal);
  const fatigue = detectStrategyFatigue(signal, setupStats, context.marketRegime);
  return {
    regimeFit: weight >= 8 ? 'stark' : weight <= -8 ? 'svag' : 'neutral',
    indexConfirmation: alignment > 0 ? 'marknaden stödjer' : alignment < -5 ? 'marknaden stödjer inte' : 'blandad',
    volatilityState: context.marketRegime?.volatilityLabelSv || 'okänd volatilitet',
    strategyStrength: setupStats?.category === 'top' || weight >= 8 ? 'strategin fungerar bra' : setupStats?.category === 'poor' || setupStats?.category === 'pause' || fatigue.active ? 'strategin fungerar dåligt' : 'neutral',
    timeoutRisk: timeout >= 18 ? 'hög' : timeout >= 9 ? 'medium' : 'låg',
    historicalConsistency: Number(setupStats?.decisive || 0) >= 5 ? `${setupStats.win_rate ?? '–'}% historik` : 'för lite data',
    strategyKey,
    strategyLabel: STRATEGY_LABELS[strategyKey] || strategyKey,
    marketGroup: getMarketGroup(signal),
    direction: direction(signal),
    strategyWeight: weight,
    timeoutRiskScore: timeout,
    fatigue,
  };
}

function buildPriorityReasons(signal, context = {}) {
  const setupStats = context.setupStats || findSetupStats(signal, context.setupPerformance);
  const ctx = buildMarketContext(signal, { ...context, setupStats });
  const positive = [];
  const negative = [];

  if (ctx.regimeFit === 'stark') positive.push('Strategin passar marknadsläget');
  if (ctx.regimeFit === 'svag') negative.push('Svag match mot marknadsläget');
  if (ctx.indexConfirmation === 'marknaden stödjer') positive.push('Marknaden stödjer riktningen');
  if (ctx.indexConfirmation === 'marknaden stödjer inte') negative.push('Svag indexriktning');
  if (volumeScore(signal) >= 8) positive.push('Stark volym');
  if (volumeScore(signal) <= -8) negative.push('Svag volym');
  if (ctx.timeoutRisk === 'låg') positive.push('Låg timeout-risk');
  if (ctx.timeoutRisk === 'hög') negative.push('Hög timeout-risk');
  if (setupStats?.category === 'top') positive.push('Historiskt stark setup');
  if (setupStats?.category === 'poor' || setupStats?.category === 'pause') negative.push('Strategin fungerar dåligt historiskt');
  if (Number(signal.aiAnalysis?.confidence ?? signal.agentScore ?? 0) >= 70) positive.push('AI confidence hög');
  if (Number(signal.fakeoutProbability || 0) >= 60) negative.push('Fakeout-risk');
  if (blockerPenalty(signal) >= 12) negative.push('Blockers väger ned signalen');
  if (ctx.fatigue.active) negative.push(ctx.fatigue.text);

  if (!positive.length) positive.push('Bevakningsbar signal');
  return { positive, negative, context: ctx };
}

function detectLowQualitySignals(ranked = []) {
  return ranked.filter((item) => {
    const c = item.marketContext || {};
    return item.priorityScore < 45
      || c.timeoutRisk === 'hög'
      || c.strategyStrength === 'strategin fungerar dåligt'
      || item.reasons.negative.length >= 3;
  });
}

function detectHighFocusSignals(ranked = []) {
  return ranked.filter((item) => (
    item.priorityScore >= 72
    && item.marketContext.timeoutRisk !== 'hög'
    && item.reasons.negative.length <= 2
  ));
}

function clusterKey(item = {}) {
  const c = item.marketContext || {};
  return `${c.marketGroup}:${c.direction}:${c.strategyKey}`;
}

function applyDiversity(ranked = [], maxPerCluster = 2) {
  const counts = new Map();
  const selected = [];
  const overflow = [];
  for (const item of ranked) {
    const key = clusterKey(item);
    const count = counts.get(key) || 0;
    counts.set(key, count + 1);
    if (count < maxPerCluster) selected.push(item);
    else overflow.push(item);
  }
  const clusters = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => {
      const sample = ranked.find((item) => clusterKey(item) === key);
      return {
        key,
        count,
        label: `${count} liknande ${sample?.marketContext?.strategyLabel || 'signal'}-signaler upptäckta.`,
        strategy: sample?.marketContext?.strategyLabel || null,
        marketGroup: sample?.marketContext?.marketGroup || null,
        direction: sample?.marketContext?.direction || null,
      };
    });
  return { selected, overflow, clusters };
}

function normalizeSignal(signal = {}, context = {}) {
  const setupStats = findSetupStats(signal, context.setupPerformance);
  const priorityScore = calculatePriorityScore(signal, { ...context, setupStats });
  const reasons = buildPriorityReasons(signal, { ...context, setupStats });
  const marketContext = reasons.context;
  const strategyKey = marketContext.strategyKey;
  return {
    symbol: signal.symbol || 'UNKNOWN',
    signalFamily: signal.signalFamily || signal.eventType || signal.signal || 'Signal',
    signalSubtype: signal.signalSubtype || null,
    strategyKey,
    strategyLabel: marketContext.strategyLabel,
    direction: marketContext.direction,
    marketGroup: marketContext.marketGroup,
    priorityScore,
    pulseScore: signal._pulseScore ?? signal.pulseScore ?? signal.tradeScore ?? signal.confidenceScore ?? signal.score ?? null,
    tradeScore: signal.tradeScore ?? signal.score ?? null,
    status: signal.status || signal.priority || null,
    volumeState: signal.volumeState || null,
    relVol20: signal.relVol20 ?? null,
    fakeoutProbability: signal.fakeoutProbability ?? null,
    priorityReasons: reasons,
    reasons,
    marketContext,
  };
}

async function loadContext(options = {}) {
  const rawSignals = options.signals || [
    ...(getLatestResults() || []),
    ...(getCryptoResults() || []),
  ].map((signal) => ({ ...signal, ...buildDaytradeSignal(signal) }));
  const [setupData, regimeSummary] = await Promise.all([
    options.setupPerformance ? Promise.resolve(options.setupPerformance) : setupPerformance.getPerformance(false).catch(() => null),
    Promise.resolve(options.marketRegime || marketRegime.buildRegimeSummary(false)),
  ]);
  let paperPerformance = options.paperPerformance || null;
  try { if (!paperPerformance) paperPerformance = paperTrading.getPerformance(); } catch (_) {}
  return { signals: rawSignals, setupPerformance: setupData, marketRegime: regimeSummary, paperPerformance };
}

async function rankSignals(options = {}) {
  const context = await loadContext(options);
  const ranked = (context.signals || [])
    .filter((signal) => signal && signal.symbol)
    .map((signal) => normalizeSignal(signal, context))
    .sort((a, b) => b.priorityScore - a.priorityScore || String(a.symbol).localeCompare(String(b.symbol)));
  const diversity = applyDiversity(ranked, options.maxPerCluster || 2);
  return {
    ok: true,
    computedAt: new Date().toISOString(),
    count: ranked.length,
    ranked,
    diversified: diversity.selected,
    clusters: diversity.clusters,
    hiddenSimilar: diversity.overflow.length,
    marketContext: buildMarketContextSummary(context.marketRegime),
    ...SAFETY,
  };
}

function buildTopFocusList(ranked = [], limit = 3) {
  const focus = detectHighFocusSignals(ranked);
  const primary = applyDiversity(focus, 1).selected.slice(0, limit);
  if (primary.length > 0) return primary;

  const fallback = ranked.filter((item) => (
    item.priorityScore >= 50
    && item.marketContext.timeoutRisk !== 'hög'
    && item.reasons.negative.length <= 3
  ));
  return applyDiversity(fallback, 1).selected.slice(0, limit);
}

function buildWatchlist(ranked = [], limit = 8) {
  const list = ranked.filter((item) => (
    item.priorityScore >= 50
    && item.priorityScore < 72
    && item.marketContext.timeoutRisk !== 'hög'
    && !buildTopFocusList(ranked, 3).some((focus) => focus.symbol === item.symbol)
  ));
  return applyDiversity(list, 2).selected.slice(0, limit);
}

function buildAvoidList(ranked = [], limit = 8) {
  return detectLowQualitySignals(ranked)
    .sort((a, b) => a.priorityScore - b.priorityScore)
    .slice(0, limit);
}

function buildMarketContextSummary(regimeSummary = {}) {
  return {
    regime: regimeSummary?.regime || null,
    regimeLabelSv: regimeSummary?.regimeLabelSv || 'Okänt marknadsläge',
    riskEnvLabelSv: regimeSummary?.riskEnvLabelSv || null,
    volatilityLabelSv: regimeSummary?.volatilityLabelSv || null,
    indexBias: regimeSummary?.indexBias || null,
    topStrategies: (regimeSummary?.strategyWeights?.topStrategies || []).slice(0, 3).map((key) => ({
      key,
      label: STRATEGY_LABELS[key] || key,
    })),
    weakStrategies: (regimeSummary?.strategyWeights?.bottomStrategies || []).slice(0, 3).map((key) => ({
      key,
      label: STRATEGY_LABELS[key] || key,
    })),
  };
}

function buildInsights(topFocus, watchlist, avoid, clusters, marketContext) {
  const insights = [];
  if (marketContext?.topStrategies?.[0]) insights.push(`${marketContext.topStrategies[0].label} prioriteras just nu.`);
  if (topFocus?.[0]) insights.push(`${topFocus[0].symbol} är högsta fokus med Priority Score ${topFocus[0].priorityScore}.`);
  if (avoid?.some((item) => item.marketContext.timeoutRisk === 'hög')) insights.push('Timeout-risk är hög i flera svaga signaler.');
  if (avoid?.some((item) => item.marketContext.strategyStrength === 'strategin fungerar dåligt')) insights.push('Minst en strategi fungerar dåligt i nuvarande marknad.');
  if (clusters?.[0]) insights.push(clusters[0].label);
  if (!insights.length) insights.push('Systemet väntar på tydligare signaldata.');
  return insights;
}

async function buildPrioritySummary(options = {}) {
  const rankedResult = await rankSignals(options);
  const ranked = rankedResult.ranked;
  const topFocus = buildTopFocusList(ranked, 3);
  const watchlist = buildWatchlist(ranked, 8);
  const avoid = buildAvoidList(ranked, 8);
  const summary = {
    ok: true,
    computedAt: rankedResult.computedAt,
    totalSignals: ranked.length,
    topFocus,
    watchlist,
    avoid,
    clusters: rankedResult.clusters,
    hiddenSimilar: rankedResult.hiddenSimilar,
    marketContext: rankedResult.marketContext,
    insights: buildInsights(topFocus, watchlist, avoid, rankedResult.clusters, rankedResult.marketContext),
    ranked: rankedResult.diversified.slice(0, 20),
    ...SAFETY,
  };
  return cleanValue(summary);
}

async function buildTopFocusResponse() {
  const summary = await buildPrioritySummary();
  return cleanValue({ ok: true, count: summary.topFocus.length, signals: summary.topFocus, ...SAFETY });
}

async function buildWatchlistResponse() {
  const summary = await buildPrioritySummary();
  return cleanValue({ ok: true, count: summary.watchlist.length, signals: summary.watchlist, ...SAFETY });
}

async function buildAvoidResponse() {
  const summary = await buildPrioritySummary();
  return cleanValue({ ok: true, count: summary.avoid.length, signals: summary.avoid, ...SAFETY });
}

async function buildMarketContextResponse() {
  const summary = await buildPrioritySummary();
  return cleanValue({ ok: true, marketContext: summary.marketContext, clusters: summary.clusters, insights: summary.insights, ...SAFETY });
}

module.exports = {
  SAFETY,
  rankSignals,
  calculatePriorityScore,
  buildPriorityReasons,
  detectLowQualitySignals,
  detectHighFocusSignals,
  buildTopFocusList,
  buildWatchlist,
  buildAvoidList,
  buildPrioritySummary,
  buildTopFocusResponse,
  buildWatchlistResponse,
  buildAvoidResponse,
  buildMarketContextResponse,
};
