'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const automationApprovalService = require('./automationApprovalService');
const learningConnector = require('./learningConnectorService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DATA_FILE = path.resolve(__dirname, '../../data/optimization/paper-candidates.jsonl');
const MAX_RETAINED = 500;
const CACHE_TTL_MS = 10_000;

let _cache = null;
let _cacheAt = 0;

function ensureDir() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

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

function readLines() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // Skip malformed lines. The log must stay append-only and resilient.
    }
  }
  return out;
}

function readAll() {
  return parseLines(readLines());
}

function writeAll(rows) {
  ensureDir();
  fs.writeFileSync(
    DATA_FILE,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`,
    'utf8',
  );
}

function trimIfNeeded() {
  const rows = readAll();
  if (rows.length <= MAX_RETAINED) return;
  writeAll(rows.slice(-MAX_RETAINED));
}

function stableId(seed) {
  return crypto.createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 20);
}

function normalizeChanges(changes) {
  return safeArray(changes).map((change) => ({
    id: safeString(change.id),
    key: safeString(change.key),
    label: safeString(change.label),
    type: safeString(change.type),
    impact: safeString(change.impact),
    recommendedValue: change.recommendedValue,
    rationale: safeString(change.rationale),
  })).filter((change) => change.id || change.key || change.label);
}

function buildAllowlistSnapshot(strategyId) {
  const approvals = automationApprovalService.getAutomationApprovals();
  const approvedIds = safeArray(approvals.approvedStrategyIds);
  const approvedCount = approvedIds.length;
  const maxApproved = safeNumber(approvals.maxApproved, automationApprovalService.MAX_APPROVED);

  if (!strategyId) {
    return {
      status: 'needs_strategy_id',
      reason: 'Saknar strategyId för att kunna kontrollera allowlist.',
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

  if (typeof automationApprovalService.canApproveStrategy === 'function') {
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

  return {
    status: 'not_approved',
    reason: 'Strategin är inte godkänd ännu.',
    approvedCount,
    maxApproved,
    approvedStrategyIds: approvedIds,
  };
}

function decorateCandidate(candidate) {
  const allowlist = buildAllowlistSnapshot(candidate.strategyId);
  return {
    ...candidate,
    allowlist,
  };
}

function buildCandidateRecord(input = {}) {
  const recommendationId = safeString(input.recommendationId) || stableId({
    strategyId: safeString(input.strategyId),
    source: safeString(input.source, 'ai_agent_batch_recommendation'),
    selectedChanges: normalizeChanges(input.selectedChanges),
    tradeCount: safeNumber(input.tradeCount, null),
    replayRunCount: safeNumber(input.replayRunCount, null),
    overallScore: safeNumber(input.overallScore, null),
  });

  const createdAt = nowIso();
  const appliedConfig = safeObject(input.appliedConfig);
  const candidate = {
    id: recommendationId,
    recommendationId,
    strategyId: safeString(input.strategyId),
    strategyName: safeString(input.strategyName) || null,
    source: safeString(input.source, 'ai_agent_batch_recommendation'),
    sourceKind: safeString(input.sourceKind, 'optimization'),
    sourceLabel: safeString(input.sourceLabel, 'AI-agent rekommendation'),
    paperCandidate: true,
    allowlistStatus: 'not_approved',
    allowlistReason: 'Strategin är inte godkänd ännu.',
    createdAt,
    updatedAt: createdAt,
    reason: safeString(input.reason, 'manual_apply_from_ai_agent'),
    tradeCount: safeNumber(input.tradeCount, null),
    replayRunCount: safeNumber(input.replayRunCount, null),
    overallScore: safeNumber(input.overallScore, null),
    confidence: safeNumber(input.confidence, null),
    dataVolume: safeNumber(input.dataVolume, null),
    selectedChanges: normalizeChanges(input.selectedChanges),
    appliedConfig,
    appliedConfigHash: appliedConfig ? stableId(appliedConfig) : null,
    summarySnapshot: safeObject(input.summarySnapshot),
    safety: SAFETY,
  };

  const allowlist = buildAllowlistSnapshot(candidate.strategyId);
  candidate.allowlistStatus = allowlist.status;
  candidate.allowlistReason = allowlist.reason;
  candidate.allowlistSnapshot = allowlist;
  return candidate;
}

function appendCandidate(candidate) {
  ensureDir();
  const rows = readAll();
  rows.push(candidate);
  writeAll(rows);
  trimIfNeeded();
  _cache = null;
  _cacheAt = 0;
  return candidate;
}

function recordPaperCandidate(input = {}) {
  const strategyId = safeString(input.strategyId);
  if (!strategyId) {
    return { ok: false, error: 'strategyId krävs för paper-testkandidat.', ...SAFETY };
  }

  if (input.live_trading_enabled === true || input.can_place_orders === true || input.actions_allowed === true || input.broker_enabled === true) {
    return { ok: false, error: 'paper_candidate_is_paper_only', ...SAFETY };
  }

  const candidate = buildCandidateRecord(input);
  const existing = loadRecent(500).find((row) => row.recommendationId === candidate.recommendationId);
  if (existing) {
    return {
      ok: true,
      changed: false,
      deduped: true,
      candidate: decorateCandidate(existing),
      ...SAFETY,
    };
  }

  appendCandidate(candidate);

  try {
    learningConnector.recordAgentFinding({
      agent_id: 'ai_optimization',
      agent_name: 'AI Optimization Agent',
      finding_type: 'paper_candidate_applied',
      recommendation: `Paper-testkandidat sparad för ${candidate.strategyId}${candidate.reason ? ` · ${candidate.reason}` : ''}`,
      affected_strategy: candidate.strategyId,
      affected_symbol: null,
      confidence: candidate.confidence,
      output_used: true,
    });
  } catch (_) {
    // Best-effort only. The candidate itself is already safely persisted.
  }

  return {
    ok: true,
    changed: true,
    candidate: decorateCandidate(candidate),
    ...SAFETY,
  };
}

function loadRecent(limit = 50) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const rows = readAll().reverse().slice(0, n).map(decorateCandidate);
  return rows;
}

function getPaperCandidateStatus(limit = 50) {
  const recent = loadRecent(limit);
  const latest = recent[0] || null;
  const approvals = automationApprovalService.getAutomationApprovals();
  return {
    ok: true,
    count: recent.length,
    latest,
    candidates: recent,
    approvedCount: approvals.approvedCount,
    maxApproved: approvals.maxApproved,
    safety: SAFETY,
  };
}

module.exports = {
  SAFETY,
  recordPaperCandidate,
  loadRecent,
  getPaperCandidateStatus,
};
