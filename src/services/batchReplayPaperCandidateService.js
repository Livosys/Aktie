'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const strategyBatchTest = require('./strategyBatchTestService');
const replayIntelligence = require('./replayIntelligenceService');
const automationApprovalService = require('./automationApprovalService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const CACHE_TTL_MS = 15_000;
const DEFAULT_LIMIT = 25;
const BATCH_RESULTS_DIR = path.resolve(__dirname, '../../data/strategy-batches/results');

let _cache = null;
let _cacheAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function stableId(seed) {
  return crypto.createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 20);
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function decisionPriority(decision) {
  if (decision === 'promote_to_paper') return 0;
  if (decision === 'watch') return 1;
  return 2;
}

function normalizeStrategyId(raw) {
  const normalized = strategyIdNormalizer.normalizeStrategyId(raw);
  if (!normalized) return null;
  if (normalized.status === 'canonical' || normalized.status === 'legacy_alias') {
    return normalized.canonicalStrategyId || null;
  }
  return null;
}

function buildAllowlistSnapshot(strategyId) {
  const approvals = automationApprovalService.getAutomationApprovals();
  const approvedIds = safeArray(approvals.approvedStrategyIds);
  const approvedCount = approvedIds.length;
  const maxApproved = safeNumber(approvals.maxApproved, automationApprovalService.MAX_APPROVED);

  if (!strategyId) {
    return {
      status: 'needs_strategy_id',
      reason: 'Saknar strategyId för allowlist-godkännande.',
      approvedCount,
      maxApproved,
      approvedStrategyIds: approvedIds,
    };
  }

  if (approvedIds.includes(strategyId)) {
    return {
      status: 'approved',
      reason: 'Strategin är redan godkänd i paper allowlist.',
      approvedCount,
      maxApproved,
      approvedStrategyIds: approvedIds,
    };
  }

  const preview = automationApprovalService.canApproveStrategy(strategyId, approvedIds);
  if (preview && preview.ok) {
    return {
      status: 'not_approved',
      reason: 'Strategin är inte godkänd ännu.',
      approvedCount,
      maxApproved,
      approvedStrategyIds: approvedIds,
    };
  }

  const reason = preview?.reason || 'Kan inte godkännas just nu.';
  return {
    status: /max/i.test(reason) ? 'max_nått' : 'nekad',
    reason,
    approvedCount,
    maxApproved,
    approvedStrategyIds: approvedIds,
  };
}

function scoreCandidate(metrics = {}) {
  const trades = Math.max(0, Math.round(safeNumber(metrics.trades, 0)));
  const winRate = safeNumber(metrics.winRate, 0);
  const totalPnlPct = safeNumber(metrics.totalPnlPct, 0);
  const avgPnlPct = safeNumber(metrics.avgPnlPct, 0);
  const maxDrawdownPct = Math.abs(safeNumber(metrics.maxDrawdownPct, 0));
  const pnlScore = Math.max(-15, Math.min(25, totalPnlPct * 2.5));
  const avgScore = Math.max(-10, Math.min(15, avgPnlPct * 25));
  const winScore = Math.max(0, Math.min(30, (winRate - 45) * 0.75));
  const drawdownPenalty = Math.max(0, Math.min(20, maxDrawdownPct * 1.5));
  const tradeBonus = Math.max(0, Math.min(25, trades * 1.5));
  const samplePenalty = trades < 5 ? 15 : 0;
  return clampScore(tradeBonus + pnlScore + avgScore + winScore - drawdownPenalty - samplePenalty + 20);
}

function explainCandidate(candidate) {
  const metrics = candidate.metrics || {};
  const parts = [];
  parts.push(candidate.recommendation?.decision === 'promote_to_paper' ? 'Promote till paper' : candidate.recommendation?.decision === 'watch' ? 'Watch' : 'Reject');
  parts.push(`${safeNumber(metrics.trades, 0)} trades`);
  parts.push(`WR ${safeNumber(metrics.winRate, 0)}%`);
  parts.push(`PnL ${safeNumber(metrics.totalPnlPct, 0)}%`);
  if (metrics.maxDrawdownPct != null) parts.push(`DD ${safeNumber(metrics.maxDrawdownPct, 0)}%`);
  return parts.join(' · ');
}

function buildRecommendation(metrics = {}) {
  const trades = Math.max(0, Math.round(safeNumber(metrics.trades, 0)));
  const score = scoreCandidate(metrics);
  const winRate = safeNumber(metrics.winRate, 0);
  const totalPnlPct = safeNumber(metrics.totalPnlPct, 0);
  const maxDrawdownPct = Math.abs(safeNumber(metrics.maxDrawdownPct, 0));

  if (trades <= 0) {
    return {
      decision: 'reject',
      reason: 'Inga trades registrerade - inte tillräcklig evidens för paper promotion.',
      confidence: 'low',
    };
  }

  if (trades < 5) {
    return {
      decision: score >= 55 ? 'watch' : 'reject',
      reason: 'För få trades för säker promotion. Kräver mer data.',
      confidence: 'low',
    };
  }

  if (score >= 70 && winRate >= 50 && totalPnlPct > 0 && maxDrawdownPct <= 8) {
    return {
      decision: 'promote_to_paper',
      reason: 'Tillräcklig datagrund, positiv PnL och rimlig drawdown.',
      confidence: trades >= 20 ? 'high' : 'medium',
    };
  }

  if (score >= 55 || totalPnlPct > 0 || winRate >= 50) {
    return {
      decision: 'watch',
      reason: 'Lovande, men kräver mer data innan promotion till paper allowlist.',
      confidence: trades >= 10 ? 'medium' : 'low',
    };
  }

  return {
    decision: 'reject',
    reason: 'Svag eller instabil prestation i batch/replay.',
    confidence: trades >= 10 ? 'medium' : 'low',
  };
}

function normalizeBatchResultToCandidate(batchRow = {}, batch = {}, compare = {}) {
  const rawStrategyId = safeString(batchRow.strategy_id || batchRow.strategyId);
  const strategyId = normalizeStrategyId(rawStrategyId) || rawStrategyId || null;
  const variantId = stableId({
    source: 'batch',
    batchId: batch.id,
    strategyId: rawStrategyId,
    symbol: batchRow.symbol || null,
    market_group: batchRow.market_group || null,
    stop_loss: batchRow.stop_loss ?? null,
    take_profit: batchRow.take_profit ?? null,
    holding_time: batchRow.holding_time ?? null,
    timeout: batchRow.timeout ?? null,
    confidence_threshold: batchRow.confidence_threshold ?? null,
    volume_requirement: batchRow.volume_requirement ?? null,
  });
  const metrics = {
    trades: safeNumber(batchRow.trades, 0) || 0,
    wins: safeNumber(batchRow.wins, 0) || 0,
    losses: safeNumber(batchRow.losses, 0) || 0,
    winRate: safeNumber(batchRow.win_rate, 0) || 0,
    avgPnlPct: safeNumber(batchRow.avg_pnl, 0) || 0,
    totalPnlPct: safeNumber(batchRow.total_pnl, 0) || 0,
    maxDrawdownPct: safeNumber(batchRow.max_drawdown, 0) || 0,
    score: safeNumber(batchRow.score, 0) || 0,
  };
  const recommendation = buildRecommendation(metrics);
  const allowlist = buildAllowlistSnapshot(strategyId);
  return {
    candidateId: stableId({ source: 'batch', sourceRunId: batch.id, variantId, strategyId: rawStrategyId || strategyId }),
    strategyId,
    strategyName: safeString(batchRow.strategy_name || batchRow.strategyName || strategyId || 'Okänd strategi'),
    displayName: `${safeString(batchRow.strategy_name || batchRow.strategyName || strategyId || 'Okänd strategi')}${batchRow.symbol ? ` · ${batchRow.symbol}` : ''}`,
    source: 'batch',
    sourceLabel: 'Batch-test',
    sourceRunId: batch.id || null,
    variantId,
    paperCandidate: true,
    allowlistStatus: allowlist.status,
    allowlistReason: allowlist.reason,
    allowlistSnapshot: allowlist,
    createdAt: batchRow.created_at || batch.batch_completed_at || batch.updated_at || nowIso(),
    testedConfig: {
      strategy_id: rawStrategyId || strategyId || null,
      symbol: batchRow.symbol || null,
      market_group: batchRow.market_group || null,
      timeframe: batchRow.timeframe || null,
      stop_loss: batchRow.stop_loss ?? null,
      take_profit: batchRow.take_profit ?? null,
      holding_time: batchRow.holding_time ?? null,
      timeout: batchRow.timeout ?? null,
      confidence_threshold: batchRow.confidence_threshold ?? null,
      volume_requirement: batchRow.volume_requirement ?? null,
      certificate_simulation_mode: batchRow.certificate_simulation_mode || null,
      date_from: batchRow.date_from || null,
      date_to: batchRow.date_to || null,
    },
    metrics: {
      ...metrics,
      score: scoreCandidate(metrics),
      tradesAnalyzed: metrics.trades,
    },
    recommendation,
    explanation: explainCandidate({
      metrics,
      recommendation,
    }),
    safety: SAFETY,
  };
}

function normalizeReplayResultToCandidate(session = {}, summary = null) {
  const cfg = safeObject(summary?.config) || safeObject(session.config) || {};
  const rawStrategyId = safeString(cfg.strategy_id || cfg.strategyId);
  const strategyId = normalizeStrategyId(rawStrategyId) || rawStrategyId || null;
  const trades = Math.max(0, Math.round(safeNumber(summary?.total_trades, 0) || 0));
  const wins = trades > 0 ? Math.round(trades * (safeNumber(summary?.win_rate, 0) / 100)) : 0;
  const losses = Math.max(0, trades - wins);
  const metrics = {
    trades,
    wins,
    losses,
    winRate: safeNumber(summary?.win_rate, 0) || 0,
    avgPnlPct: trades ? safeNumber(summary?.avg_pl_per_trade, 0) || 0 : 0,
    totalPnlPct: safeNumber(summary?.total_pl_pct, 0) || 0,
    maxDrawdownPct: safeNumber(summary?.max_drawdown, 0) || 0,
  };
  const recommendation = buildRecommendation(metrics);
  const variantId = stableId({
    source: 'replay',
    sessionId: session.id,
    timeframe: cfg.timeframe || null,
    speed: cfg.speed || null,
    risk_profile: cfg.risk_profile || null,
    use_agent_reasoning: cfg.use_agent_reasoning === true,
    use_memory_similarity: cfg.use_memory_similarity === true,
    use_risk_engine: cfg.use_risk_engine !== false,
    use_exit_engine: cfg.use_exit_engine === true,
    use_execution_safety: cfg.use_execution_safety === true,
  });
  const allowlist = buildAllowlistSnapshot(strategyId);
  return {
    candidateId: stableId({ source: 'replay', sourceRunId: session.id, variantId, strategyId: rawStrategyId || strategyId }),
    strategyId,
    strategyName: safeString(cfg.strategy_name || cfg.strategyName || strategyId || 'Replay-session'),
    displayName: strategyId ? `${strategyId} · Replay` : `Replay ${String(session.id || '').slice(-8)}`,
    source: 'replay',
    sourceLabel: 'Replay-session',
    sourceRunId: session.id || null,
    variantId,
    paperCandidate: true,
    allowlistStatus: allowlist.status,
    allowlistReason: allowlist.reason,
    allowlistSnapshot: allowlist,
    createdAt: session.createdAt || summary?.createdAt || nowIso(),
    testedConfig: cfg,
    metrics: {
      ...metrics,
      score: scoreCandidate(metrics),
      tradesAnalyzed: metrics.trades,
    },
    recommendation,
    explanation: explainCandidate({
      metrics,
      recommendation,
    }),
    safety: SAFETY,
  };
}

function loadBatchCandidates(limit = DEFAULT_LIMIT) {
  const batches = safeArray(strategyBatchTest.listBatchTests()?.batches)
    .filter((batch) => batch && (batch.progress?.completed || 0) > 0)
    .sort((a, b) => String(b.updated_at || b.batch_completed_at || b.created_at || '').localeCompare(String(a.updated_at || a.batch_completed_at || a.created_at || '')));
  const out = [];
  for (const batch of batches.slice(0, Math.max(1, Math.min(100, Number(limit) || DEFAULT_LIMIT)))) {
    try {
      const compare = strategyBatchTest.compareBatchResults(batch.id);
      if (!compare || compare.ok === false) continue;
      const row = compare.recommended_config
        || safeArray(compare.best_overall)[0]
        || safeArray(compare.best_per_strategy)[0]
        || null;
      if (!row) continue;
      out.push(normalizeBatchResultToCandidate(row, batch, compare));
    } catch (_) {
      // Read-only preview: skip broken batch files instead of failing the whole view.
    }
  }

  if (out.length === 0) {
    try {
      const files = fs.existsSync(BATCH_RESULTS_DIR)
        ? fs.readdirSync(BATCH_RESULTS_DIR).filter((name) => name.endsWith('.json')).sort().reverse()
        : [];
      for (const fileName of files.slice(0, Math.max(1, Math.min(100, Number(limit) || DEFAULT_LIMIT)))) {
        const fullPath = path.join(BATCH_RESULTS_DIR, fileName);
        try {
          const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          const rows = Array.isArray(raw) ? raw : [];
          if (!rows.length) continue;
          const bestRow = [...rows].sort((a, b) => safeNumber(b.score, -Infinity) - safeNumber(a.score, -Infinity))[0] || rows[0];
          const batchId = safeString(bestRow.batch_id || fileName.replace(/\.json$/i, ''));
          const batch = {
            id: batchId,
            name: batchId,
            status: 'completed',
            progress: { completed: rows.length },
            updated_at: bestRow.run_completed_at || bestRow.created_at || nowIso(),
            batch_completed_at: bestRow.run_completed_at || bestRow.created_at || nowIso(),
          };
          out.push(normalizeBatchResultToCandidate(bestRow, batch, { total_results: rows.length }));
        } catch (_) {
          // Skip malformed batch result files in the fallback path as well.
        }
      }
    } catch (_) {
      // Ignore fallback scan errors.
    }
  }
  return out;
}

function loadReplayCandidates(limit = DEFAULT_LIMIT) {
  const sessions = safeArray(replayIntelligence.listReplaySessions())
    .sort((a, b) => String(b.updatedAt || b.endedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.endedAt || a.createdAt || '')));
  const out = [];
  for (const session of sessions.slice(0, Math.max(1, Math.min(100, Number(limit) || DEFAULT_LIMIT)))) {
    const summary = safeObject(session.summary) || safeObject(session?.summary?.summary) || null;
    if (!summary) continue;
    if (!['completed', 'stopped', 'failed'].includes(String(summary.status || session.status || '').toLowerCase()) && !summary.total_trades) {
      continue;
    }
    out.push(normalizeReplayResultToCandidate(session, summary));
  }
  return out;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = candidate.candidateId || `${candidate.source}:${candidate.sourceRunId}:${candidate.variantId}:${candidate.strategyId || 'none'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function listBatchReplayCandidatePreview(limit = DEFAULT_LIMIT, force = false) {
  const n = Math.max(1, Math.min(100, Number(limit) || DEFAULT_LIMIT));
  const now = Date.now();
  if (!force && _cache && (now - _cacheAt) < CACHE_TTL_MS && _cache.limit === n) {
    return _cache.data;
  }

  const batchLimit = Math.max(1, Math.ceil(n / 2));
  const replayLimit = Math.max(1, n - batchLimit);
  const batchCandidates = loadBatchCandidates(batchLimit);
  const replayCandidates = loadReplayCandidates(replayLimit);
  const candidates = dedupeCandidates([...batchCandidates, ...replayCandidates])
    .sort((a, b) => {
      const ap = decisionPriority(a.recommendation?.decision);
      const bp = decisionPriority(b.recommendation?.decision);
      if (ap !== bp) return ap - bp;
      const as = safeNumber(a.metrics?.score, 0);
      const bs = safeNumber(b.metrics?.score, 0);
      if (as !== bs) return bs - as;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    })
    .slice(0, n);

  const sourceCounts = {
    batch: batchCandidates.length,
    replay: replayCandidates.length,
    total: candidates.length,
    promote_to_paper: candidates.filter((c) => c.recommendation?.decision === 'promote_to_paper').length,
    watch: candidates.filter((c) => c.recommendation?.decision === 'watch').length,
    reject: candidates.filter((c) => c.recommendation?.decision === 'reject').length,
  };

  const explanation = [
    'Batch och replay är read-only previewer.',
    'Ingen kandidat skapas automatiskt och ingen allowlist ändras här.',
    'Skapa kandidatappen append:ar bara till paper-candidates.jsonl.',
    `Källor: batch=${sourceCounts.batch}, replay=${sourceCounts.replay}.`,
  ].join(' ');

  const data = {
    ok: true,
    previewedAt: nowIso(),
    sourceCounts,
    candidates,
    explanation,
    safety: SAFETY,
  };
  _cache = { limit: n, data };
  _cacheAt = now;
  return data;
}

function findPreviewCandidate(candidateId, limit = DEFAULT_LIMIT) {
  const preview = listBatchReplayCandidatePreview(limit);
  return preview.candidates.find((row) => row.candidateId === candidateId
    || (row.sourceRunId && row.variantId && `${row.sourceRunId}:${row.variantId}` === candidateId)
    || (row.sourceRunId && row.variantId && row.source === 'batch' && row.strategyId && `${row.source}:${row.sourceRunId}:${row.strategyId}:${row.variantId}` === candidateId)
    || (row.sourceRunId && row.variantId && row.strategyId && `${row.sourceRunId}:${row.strategyId}:${row.variantId}` === candidateId)) || null;
}

module.exports = {
  SAFETY,
  listBatchReplayCandidatePreview,
  normalizeBatchResultToCandidate,
  normalizeReplayResultToCandidate,
  scoreCandidate,
  explainCandidate,
  findPreviewCandidate,
};
