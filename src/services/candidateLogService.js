'use strict';
const fs   = require('fs');
const path = require('path');
const auditTrail = require('./auditTrailService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  agent_mode: 'config_only',
});

const LOG_FILE = path.resolve(__dirname, '../../data/signals/candidates.jsonl');

function ensureDir() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function logCandidate(entry) {
  ensureDir();
  const detectedAt = entry.detected_at || entry.detectedAt || entry.ts || new Date().toISOString();
  const evaluatedAt = entry.evaluated_at || entry.evaluatedAt || new Date().toISOString();
  const paperTradeCreatedAt = entry.paperTradeCreated || entry.paper_trade_created_at || entry.paperTradeCreatedAt
    ? (entry.paper_trade_created_at || entry.paperTradeCreatedAt || evaluatedAt)
    : null;
  const sourceStrategyId = entry.sourceStrategyId || null;
  const resolvedStrategyId = entry.resolvedStrategyId || entry.strategyId || entry.strategy_id || sourceStrategyId || null;
  const strategyId = entry.strategyId || entry.strategy_id || sourceStrategyId || resolvedStrategyId || null;
  const mappingSource = entry.mappingSource || (sourceStrategyId ? 'explicit' : 'unknown');
  const line = JSON.stringify({
    ts: detectedAt,
    detected_at: detectedAt,
    evaluated_at: evaluatedAt,
    paper_trade_created_at: paperTradeCreatedAt,
    symbol:              entry.symbol,
    marketGroup:         entry.marketGroup,
    strategyName:        entry.strategyName,
    blockerMode:         entry.blockerMode,
    discoveryMode:       entry.discoveryMode,
    score:               entry.score,
    signal:              entry.signal,
    reasons:             entry.reasons             ?? [],
    warnings:            entry.warnings            ?? [],
    wouldHaveBeenBlockedBy: entry.wouldHaveBeenBlockedBy ?? [],
    paperTradeCreated:   entry.paperTradeCreated   ?? false,
    setupId:             entry.setupId,
    indexBias:           entry.indexBias,
    volumeState:         entry.volumeState,
    exitProfile:         entry.exitProfile,
    sourceStrategyId,
    sourceStrategyName:  entry.sourceStrategyName || entry.strategyName || entry.strategy_name || null,
    strategyId,
    strategy_id:         strategyId,
    resolvedStrategyId,
    resolvedStrategyName: entry.resolvedStrategyName || entry.strategyName || entry.strategy_name || null,
    mappingSource,
  });
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  auditTrail.logAuditEvent({
    type: 'CANDIDATE_FOUND',
    source: 'candidate_log',
    timestamp: detectedAt,
    symbol: entry.symbol,
    strategy_id: strategyId || null,
    message: entry.symbol ? `Kandidat hittad för ${entry.symbol}` : 'Kandidat hittad',
    details: {
      score: entry.score,
      signal: entry.signal,
      marketGroup: entry.marketGroup,
      setupId: entry.setupId,
      sourceStrategyId,
      strategyId,
      resolvedStrategyId,
      mappingSource,
    },
  });
  auditTrail.logAuditEvent({
    type: 'CANDIDATE_EVALUATED',
    source: 'candidate_log',
    timestamp: evaluatedAt,
    symbol: entry.symbol,
    strategy_id: strategyId || null,
    message: entry.symbol ? `Kandidat utvärderad för ${entry.symbol}` : 'Kandidat utvärderad',
    details: {
      score: entry.score,
      blockerMode: entry.blockerMode,
      warnings: entry.warnings || [],
      wouldHaveBeenBlockedBy: entry.wouldHaveBeenBlockedBy || [],
      sourceStrategyId,
      strategyId,
      resolvedStrategyId,
      mappingSource,
    },
  });
}

function readLines(maxLines) {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    return lines.slice(-maxLines);
  } catch (_) {
    return [];
  }
}

function parseLines(lines) {
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

function loadRecent(n = 200) {
  const lines = readLines(n);
  return parseLines(lines).reverse();
}

function getStats() {
  const entries = parseLines(readLines(5000));
  const total = entries.length;
  const paperCreated = entries.filter(e => e.paperTradeCreated).length;
  const discoveryModeCount = entries.filter(e => e.discoveryMode).length;
  const conversionRate = total > 0 ? parseFloat(((paperCreated / total) * 100).toFixed(2)) : 0;

  const groupMap  = {};
  const stratMap  = {};
  const blockerMap = {};

  for (const e of entries) {
    if (e.marketGroup) {
      groupMap[e.marketGroup] = (groupMap[e.marketGroup] || 0) + 1;
    }
    if (e.strategyName) {
      stratMap[e.strategyName] = (stratMap[e.strategyName] || 0) + 1;
    }
    if (Array.isArray(e.wouldHaveBeenBlockedBy)) {
      for (const b of e.wouldHaveBeenBlockedBy) {
        blockerMap[b] = (blockerMap[b] || 0) + 1;
      }
    }
  }

  const byGroup = Object.entries(groupMap).map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count);

  const byStrategy = Object.entries(stratMap).map(([strategy, count]) => ({ strategy, count }))
    .sort((a, b) => b.count - a.count);

  const topBlockers = Object.entries(blockerMap).map(([blocker, count]) => ({ blocker, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total,
    paperCreated,
    discoveryModeCount,
    conversionRate,
    byGroup,
    byStrategy,
    topBlockers,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  logCandidate,
  loadRecent,
  getStats,
};
