'use strict';

const fs = require('fs');
const path = require('path');

const strategyRegistry = require('./strategyRegistryService');
const candidateLog = require('./candidateLogService');
const paperTrading = require('../paperTrading/paperTradingAgent');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  live_enabled: false,
  paper_only: true,
  mode: 'paper_only',
  broker_enabled: false,
});

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function strategyKey(row = {}) {
  return safeString(
    row.strategy_id ||
    row.strategyId ||
    row.resolvedStrategyId ||
    row.sourceStrategyId ||
    row.strategy ||
    row.strategy_name ||
    row.strategyName,
  );
}

function normalizeStatus(status) {
  return String(status || 'paper_only').toLowerCase();
}

function countCandidatesByStrategy(limit = 5000) {
  const rows = candidateLog.loadRecent(limit) || [];
  const counts = new Map();
  for (const row of rows) {
    const key = strategyKey(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function countPaperTradesByStrategy() {
  try {
    const trades = paperTrading.getTrades?.().trades || [];
    const counts = new Map();
    for (const trade of trades) {
      const key = strategyKey(trade);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  } catch (_) {
    return new Map();
  }
}

function confidenceForSample(sampleSize, status) {
  const normalizedStatus = normalizeStatus(status);
  if (sampleSize <= 0) return normalizedStatus === 'paused' || normalizedStatus === 'deprecated' ? 20 : 18;
  if (sampleSize < 10) return normalizedStatus === 'paused' || normalizedStatus === 'deprecated' ? 28 : 34;
  if (sampleSize < 30) return 52;
  if (sampleSize < 100) return 68;
  return 82;
}

function scoreFromData(strategy, sampleSize, perfScore, paperCount, candidateCount) {
  const status = normalizeStatus(strategy.status);
  const source = safeString(strategy.source) || 'internal';
  const summaryScore = safeNumber(strategy.performance_summary?.score);
  let score = safeNumber(perfScore, null);
  if (score == null) score = summaryScore != null ? summaryScore : 50;

  if (status === 'paused' || status === 'deprecated') score = Math.min(score, 35);
  if (status === 'watch') score -= 6;
  if (status === 'experimental') score -= 2;
  if (status === 'paper_only') score -= 4;
  if (source === 'tradingview') score += sampleSize > 0 ? 1 : 0;
  if (sampleSize === 0) score = status === 'paused' || status === 'deprecated' ? 20 : Math.max(38, score - 5);
  else if (sampleSize < 10) score -= 4;
  else if (sampleSize >= 50 && score >= 60) score += 4;
  if (paperCount > candidateCount && score < 60) score += 2;

  return clamp(Math.round(score), 0, 100);
}

function strengthsFor(strategy, sampleSize, perfScore) {
  const out = [];
  if (strategy.source === 'tradingview') out.push('Extern TradingView-strategi registrerad');
  if (strategy.source === 'internal') out.push('Intern katalogstrategi');
  if (strategy.supportsScanner === true) out.push('Har scannerkoppling');
  if (strategy.enabled !== false && strategy.status === 'active') out.push('Aktiv i registry');
  if (safeNumber(perfScore) != null) out.push('Har batch-/performance-data');
  if (sampleSize >= 10) out.push('Tillräckligt underlag för att börja jämföra');
  if (sampleSize >= 30) out.push('Hyfsat stabilt dataunderlag');
  return out.slice(0, 4);
}

function weaknessesFor(strategy, sampleSize) {
  const out = [];
  const status = normalizeStatus(strategy.status);
  if (status === 'paused') out.push('Pausad strategi');
  if (status === 'deprecated') out.push('Deprecated/arkiverad strategi');
  if (sampleSize === 0) out.push('Inget mätbart underlag ännu');
  else if (sampleSize < 10) out.push('Litet dataunderlag');
  if (status === 'paper_only' || status === 'watch' || status === 'experimental') out.push('Behöver replay/batch-test');
  const weakPerformance = safeNumber(strategy.performance_summary?.score);
  if (weakPerformance != null && weakPerformance < 45) out.push('Svag historisk trend');
  return out.slice(0, 4);
}

function recommendedActionFor(strategy, sampleSize, score, confidence) {
  const status = normalizeStatus(strategy.status);
  if (status === 'paused' || status === 'deprecated') {
    return 'Håll pausad/deprecated. Nya paper entries rekommenderas inte.';
  }
  if (sampleSize === 0) {
    return 'Kör replay och batch-test innan fler paper entries.';
  }
  if (sampleSize < 10) {
    return 'Kör replay/batch och samla mer paper-data.';
  }
  if (score < 45 || confidence < 40) {
    return 'Quarantine/replay. Lägg inte bort strategin, men testa försiktigt.';
  }
  if (sampleSize < 30) {
    return 'Kör replay/batch och samla mer data innan du ökar paper-trycket.';
  }
  if (score < 60) {
    return 'Håll paper-only och jämför mot andra strategier.';
  }
  return 'Behåll aktiv och fortsätt övervaka i paper/replay.';
}

function isPairedPausedOrDeprecated(strategy) {
  const status = normalizeStatus(strategy.status);
  return status === 'paused' || status === 'deprecated';
}

function isTopStrategy(strategy) {
  if (isPairedPausedOrDeprecated(strategy)) return false;
  return safeNumber(strategy.sample_size, 0) > 0 && safeNumber(strategy.confidence, 0) >= 50;
}

function isWeakStrategy(strategy) {
  if (isPairedPausedOrDeprecated(strategy)) return true;
  return safeNumber(strategy.score, 100) <= 45
    || safeNumber(strategy.confidence, 0) < 50
    || safeNumber(strategy.sample_size, 0) < 10
    || (Array.isArray(strategy.weaknesses) && strategy.weaknesses.length > 0);
}

function isUncertainStrategy(strategy) {
  return safeNumber(strategy.confidence, 0) < 50 || safeNumber(strategy.sample_size, 0) < 10;
}

function wantsReplayOrBatch(strategy) {
  const text = String(strategy.recommended_action || '').toLowerCase();
  return text.includes('replay') || text.includes('batch');
}

function sortByScoreDesc(a, b) {
  return b.score - a.score
    || b.confidence - a.confidence
    || b.sample_size - a.sample_size
    || String(a.strategy_id).localeCompare(String(b.strategy_id));
}

function sortByScoreAsc(a, b) {
  return a.score - b.score
    || a.confidence - b.confidence
    || a.sample_size - b.sample_size
    || String(a.strategy_id).localeCompare(String(b.strategy_id));
}

function sortByUncertaintyAsc(a, b) {
  return a.confidence - b.confidence
    || a.sample_size - b.sample_size
    || a.score - b.score
    || String(a.strategy_id).localeCompare(String(b.strategy_id));
}

function sortByNextTestPriority(a, b) {
  return a.sample_size - b.sample_size
    || a.confidence - b.confidence
    || a.score - b.score
    || String(a.strategy_id).localeCompare(String(b.strategy_id));
}

function buildStrategyScore(strategy, counts = {}, paperCounts = {}, perfLookup = new Map()) {
  const candidateCount = counts.get(strategy.strategy_id) || 0;
  const paperCount = paperCounts.get(strategy.strategy_id) || 0;
  const perf = perfLookup.get(strategy.strategy_id) || null;
  const performanceScore = safeNumber(perf?.score ?? strategy.performance_summary?.score, null);
  const performanceTrades = safeNumber(perf?.trades ?? strategy.performance_summary?.trades, 0) || 0;
  const sampleSize = Math.max(
    performanceTrades,
    candidateCount,
    paperCount,
    safeNumber(strategy.history_count, 0) || 0,
  );
  const score = scoreFromData(strategy, sampleSize, performanceScore, paperCount, candidateCount);
  const confidence = confidenceForSample(sampleSize, strategy.status);
  const strengths = strengthsFor(strategy, sampleSize, performanceScore);
  const weaknesses = weaknessesFor(strategy, sampleSize);
  return {
    strategy_id: strategy.strategy_id,
    source: strategy.source,
    status: strategy.status,
    score,
    confidence,
    sample_size: sampleSize,
    strengths,
    weaknesses,
    recommended_action: recommendedActionFor(strategy, sampleSize, score, confidence),
    paper_trades: paperCount,
    candidate_count: candidateCount,
    ...SAFETY,
  };
}

function createStrategyScoreService(options = {}) {
  const registry = options.registryService || strategyRegistry;
  const candidateLoader = typeof options.candidateLoader === 'function'
    ? options.candidateLoader
    : (limit = 5000) => candidateLog.loadRecent(limit);
  const paperTradeLoader = typeof options.paperTradeLoader === 'function'
    ? options.paperTradeLoader
    : () => (paperTrading.getTrades?.().trades || []);
  const perfLookup = options.performanceLookup instanceof Map
    ? options.performanceLookup
    : new Map((options.performanceRows || []).map((row) => [row.strategy_id, row]));

  function loadCounts() {
    const candidateCounts = new Map();
    const paperCounts = new Map();
    const candidates = candidateLoader(5000) || [];
    for (const row of candidates) {
      const key = strategyKey(row);
      if (!key) continue;
      candidateCounts.set(key, (candidateCounts.get(key) || 0) + 1);
    }
    const paperTrades = paperTradeLoader() || [];
    for (const row of paperTrades) {
      const key = strategyKey(row);
      if (!key) continue;
      paperCounts.set(key, (paperCounts.get(key) || 0) + 1);
    }
    return { candidateCounts, paperCounts };
  }

  function getStrategyScores() {
    const strategies = typeof registry.listStrategies === 'function' ? registry.listStrategies() : [];
    const { candidateCounts, paperCounts } = loadCounts();
    const scores = strategies
      .map((strategy) => buildStrategyScore(strategy, candidateCounts, paperCounts, perfLookup))
      .sort(sortByScoreDesc);
    const topStrategies = scores.filter(isTopStrategy).slice(0, 5);
    const weakStrategies = [...scores].filter(isWeakStrategy).sort(sortByScoreAsc).slice(0, 5);
    const uncertainStrategies = [...scores].filter(isUncertainStrategy).sort(sortByUncertaintyAsc).slice(0, 5);
    const tradingviewStrategies = scores.filter((row) => row.source === 'tradingview').sort(sortByScoreDesc).slice(0, 5);
    const internalStrategies = scores.filter((row) => row.source === 'internal').sort(sortByScoreDesc).slice(0, 5);
    const recommendedNextTests = scores
      .filter((row) => !isPairedPausedOrDeprecated(row) && wantsReplayOrBatch(row))
      .sort(sortByNextTestPriority)
      .slice(0, 5);
    const uncertainCount = scores.filter((row) => row.confidence < 50 || row.sample_size < 10).length;
    const latestBlocked = typeof registry.getStatus === 'function' ? registry.getStatus().latest_blocked_reason || null : null;
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      total_strategies: scores.length,
      scored_strategies: scores.length,
      uncertain_count: uncertainCount,
      latest_blocked_reason: latestBlocked,
      top_strategies: topStrategies,
      weak_strategies: weakStrategies,
      uncertain_strategies: uncertainStrategies,
      tradingview_strategies: tradingviewStrategies,
      internal_strategies: internalStrategies,
      recommended_next_tests: recommendedNextTests,
      top_scores: scores.slice(0, 5),
      weakest_scores: [...scores].reverse().slice(0, 5),
      strategies: scores,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  function getStrategyScore(strategyId) {
    const id = safeString(strategyId);
    if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };
    const result = getStrategyScores().strategies.find((row) => row.strategy_id === id);
    if (!result) return { ok: false, error: 'strategy_not_found', ...SAFETY };
    return { ok: true, strategy: result, ...SAFETY };
  }

  return {
    SAFETY,
    getStrategyScores,
    getStrategyScore,
  };
}

const defaultStrategyScoreService = createStrategyScoreService();

module.exports = {
  SAFETY,
  createStrategyScoreService,
  defaultStrategyScoreService,
};
