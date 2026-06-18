'use strict';

const fs = require('fs');
const path = require('path');
const automationApprovalService = require('./automationApprovalService');
const strategyRuntimeMatrixService = require('./strategyRuntimeMatrixService');
const strategyIdNormalizer = require('./strategyIdNormalizerService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DATA_FILE = path.resolve(__dirname, '../../data/optimization/paper-candidates.jsonl');
const CACHE_TTL_MS = 20_000;
const DEFAULT_LIMIT = 50;

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

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function blockerMeta(code) {
  const map = {
    'scanner:not_connected': {
      label: 'Scannern är inte kopplad',
      explanation: 'Strategin finns som batch/replay-kandidat men kan inte få live scanner-signaler ännu.',
      nextStep: 'Koppla strategin till scanner/runtime innan den kan paper-testas.',
    },
    'paper_runtime:not_connected': {
      label: 'Paper runtime är inte kopplad',
      explanation: 'Kandidaten saknar aktiv paper-runtime-koppling i runtime-matrisen.',
      nextStep: 'Aktivera paper-runtime-koppling innan allowlist-godkännande.',
    },
    'paper_runtime:paused': {
      label: 'Paper runtime är pausad',
      explanation: 'Runtime finns men är tillfälligt pausad.',
      nextStep: 'Återaktivera paper runtime innan kandidaten kan godkännas.',
    },
    'paper_runtime:disabled': {
      label: 'Paper runtime är avstängd',
      explanation: 'Runtime är explicit avstängd i matrixen.',
      nextStep: 'Slå på paper runtime i runtime-matrisen innan godkännande.',
    },
    'paper_runtime:no_entry_rule': {
      label: 'Ingen entry-regel',
      explanation: 'Strategin har ingen entry-logik kopplad i runtime.',
      nextStep: 'Lägg till entry-regel eller runtime-koppling innan allowlist.',
    },
    'paper_runtime:partial': {
      label: 'Endast delvis runtime-koppling',
      explanation: 'Strategin är endast delvis kopplad i runtime-matrisen.',
      nextStep: 'Fullfölj runtime-kopplingen innan allowlist.',
    },
    'catalog_status:paused': {
      label: 'Strategin är pausad',
      explanation: 'Strategin är pausad i katalogen eller runtime-matrisen.',
      nextStep: 'Ta bort paus eller välj en aktiv strategi.',
    },
    'allowlist:max_reached': {
      label: 'Max antal godkända nått',
      explanation: 'Allowlist har nått sin manuella maxgräns.',
      nextStep: 'Ta bort en godkänd strategi innan du lägger till en ny.',
    },
    'allowlist:not_approved': {
      label: 'Inte godkänd ännu',
      explanation: 'Kandidaten är runtime-ready men ligger ännu inte på allowlist.',
      nextStep: 'Godkänn kandidaten manuellt när runtime är redo.',
    },
    'strategy:unknown_in_runtime_matrix': {
      label: 'Saknas i runtime-matrisen',
      explanation: 'Strategin finns i kandidatloggen men kunde inte matchas mot runtime-matrisen.',
      nextStep: 'Registrera strategin i runtime-matrisen innan den kan godkännas.',
    },
    'strategy_id:missing': {
      label: 'Saknar strategyId',
      explanation: 'Kandidaten har inget strategyId och kan därför inte matchas mot runtime.',
      nextStep: 'Spara kandidaten med strategyId innan allowlist-godkännande.',
    },
  };
  return map[code] || {
    label: code.replace(/[:_]/g, ' '),
    explanation: 'Det finns en blockerare i readiness-bedömningen.',
    nextStep: 'Granska runtime och allowlist innan nästa steg.',
  };
}

function normalizeStrategyId(raw) {
  const normalized = strategyIdNormalizer.normalizeStrategyId(raw);
  if (normalized?.status === 'canonical' || normalized?.status === 'legacy_alias') {
    return normalized.canonicalStrategyId || safeString(raw) || null;
  }
  return safeString(raw) || null;
}

function normalizeSource(source) {
  const raw = safeString(source, 'unknown').toLowerCase();
  if (raw.includes('ai_agent')) return 'ai_agent';
  if (raw.includes('replay')) return 'replay';
  if (raw.includes('batch')) return 'batch';
  return raw || 'unknown';
}

function buildBlockers(strategyId, candidate, row, approvals, runtimeBlockers = [], allowlistStatus = null) {
  const blockers = [];
  const seen = new Set();
  const push = (code) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    const meta = blockerMeta(code);
    blockers.push({ code, label: meta.label, explanation: meta.explanation, nextStep: meta.nextStep });
  };

  if (!strategyId) push('strategy_id:missing');
  if (!row) push('strategy:unknown_in_runtime_matrix');

  for (const code of runtimeBlockers) {
    push(code);
  }

  if (allowlistStatus === 'max_nått') push('allowlist:max_reached');
  if (allowlistStatus === 'not_approved' && !runtimeBlockers.length) push('allowlist:not_approved');

  const approvalReason = candidate.allowlistReason || '';
  if (/max/i.test(approvalReason)) push('allowlist:max_reached');
  if (/godkänd/i.test(approvalReason) && candidate.allowlistStatus === 'approved') {
    // no blocker
  }

  return blockers;
}

function deriveAllowlistStatus(candidate, approvals, canApproveResult) {
  const approvedIds = new Set(safeArray(approvals.approvedStrategyIds));
  if (candidate.strategyId && approvedIds.has(candidate.strategyId)) {
    return 'approved';
  }
  if (canApproveResult && canApproveResult.ok) return 'not_approved';
  const reason = safeString(canApproveResult && canApproveResult.reason, candidate.allowlistReason || '');
  if (/max/i.test(reason)) return 'max_nått';
  if (/block|blocker|paus|paused|not_connected|saknas/i.test(reason)) return 'nekad';
  return candidate.allowlistStatus || 'not_approved';
}

function buildReadiness(candidate, matrixMap, approvals) {
  const rawStrategyId = safeString(candidate.strategyId);
  const strategyId = normalizeStrategyId(rawStrategyId);
  const row = strategyId ? (matrixMap.get(strategyId) || null) : null;
  const approvedIds = safeArray(approvals.approvedStrategyIds);
  const alreadyApproved = strategyId ? approvedIds.includes(strategyId) : false;
  const canApproveResult = strategyId ? automationApprovalService.canApproveStrategy(strategyId, approvedIds) : { ok: false, reason: 'strategy_id missing' };
  const runtimeBlockers = safeArray(row && row.blockers);
  const scannerConnected = Boolean(row && row.scannerEnabled !== false && !runtimeBlockers.includes('scanner:not_connected'));
  const runtimeReady = Boolean(
    row
    && row.catalogPaperSupported !== false
    && row.paperRuntimeStatus === 'active'
    && row.automaticStatus !== 'pausedOrBlocked'
    && runtimeBlockers.length === 0
  );
  const allowlistStatus = alreadyApproved
    ? 'approved'
    : deriveAllowlistStatus(candidate, approvals, canApproveResult);
  const paperRunnable = Boolean(scannerConnected && runtimeReady);
  const blockers = buildBlockers(strategyId, candidate, row, approvals, runtimeBlockers, allowlistStatus)
    .filter((blocker) => !(alreadyApproved && blocker.code === 'allowlist:not_approved'));
  let nextAction = 'connect_to_scanner_runtime';
  if (!strategyId) {
    nextAction = 'add_strategy_id_metadata';
  } else if (runtimeBlockers.includes('scanner:not_connected')) {
    nextAction = 'connect_to_scanner_runtime';
  } else if (runtimeBlockers.length > 0) {
    nextAction = 'resolve_runtime_blockers';
  } else if (alreadyApproved) {
    nextAction = 'paper_trade_test';
  } else if (runtimeReady) {
    nextAction = canApproveResult.ok ? 'add_to_paper_allowlist' : 'resolve_allowlist_gate';
  }

  return {
    candidateId: candidate.candidateId || candidate.recommendationId || candidate.id,
    strategyId: strategyId || null,
    displayName: candidate.displayName || candidate.strategyName || strategyId || 'Okänd kandidat',
    source: normalizeSource(candidate.source),
    sourceRunId: candidate.sourceRunId || null,
    variantId: candidate.variantId || null,
    allowlistStatus,
    runtimeReady,
    paperRunnable,
    scannerConnected,
    alreadyApproved,
    canApprove: Boolean((canApproveResult && canApproveResult.ok) || alreadyApproved),
    canApproveReason: (canApproveResult?.ok || alreadyApproved) ? null : safeString(canApproveResult?.reason, 'Kan inte godkännas just nu.'),
    blockers,
    nextAction,
    safety: SAFETY,
    runtime: row ? {
      paperRuntimeStatus: row.paperRuntimeStatus || 'unknown',
      automaticStatus: row.automaticStatus || 'unknown',
      manualLabTestSupported: Boolean(row.manualLabTestSupported),
      catalogPaperSupported: Boolean(row.catalogPaperSupported),
      requiredData: safeArray(row.requiredData),
      lastTested: row.lastTested || null,
      resultSummary: row.resultSummary || null,
      paperSummary: row.paperSummary || null,
      simulationSummary: row.simulationSummary || null,
    } : null,
    candidate: {
      tradeCount: candidate.tradeCount ?? candidate.metrics?.trades ?? null,
      overallScore: candidate.overallScore ?? candidate.metrics?.score ?? null,
      recommendation: candidate.recommendation || null,
      sourceLabel: candidate.sourceLabel || null,
      sourceKind: candidate.sourceKind || null,
      reason: candidate.reason || null,
    },
  };
}

function listPaperCandidateReadiness(limit = DEFAULT_LIMIT, force = false) {
  const n = Math.max(1, Math.min(200, Number(limit) || DEFAULT_LIMIT));
  const now = Date.now();
  if (!force && _cache && (now - _cacheAt) < CACHE_TTL_MS && _cache.limit === n) {
    return _cache.data;
  }

  const candidates = readJsonl(DATA_FILE).reverse().slice(0, n);
  const matrix = strategyRuntimeMatrixService.getStrategyRuntimeMatrix();
  const matrixMap = new Map((matrix.strategies || []).map((row) => [row.id || row.strategy_id, row]).filter(([id]) => id));
  const approvals = automationApprovalService.getAutomationApprovals();
  const items = candidates.map((candidate) => buildReadiness(candidate, matrixMap, approvals));
  const summary = {
    total: items.length,
    runtimeReady: items.filter((row) => row.runtimeReady).length,
    paperRunnable: items.filter((row) => row.paperRunnable).length,
    scannerConnected: items.filter((row) => row.scannerConnected).length,
    alreadyApproved: items.filter((row) => row.alreadyApproved).length,
    canApprove: items.filter((row) => row.canApprove).length,
    blocked: items.filter((row) => !row.runtimeReady).length,
  };
  const blockerCounts = items.reduce((acc, row) => {
    for (const blocker of row.blockers || []) {
      acc[blocker.code] = (acc[blocker.code] || 0) + 1;
    }
    return acc;
  }, {});

  const data = {
    ok: true,
    previewedAt: nowIso(),
    summary,
    blockerCounts,
    candidates: items,
    explanation: 'Read-only runtime readiness. Ingen mutering, ingen auto-approve, inga orders.',
    safety: SAFETY,
  };

  _cache = { limit: n, data };
  _cacheAt = now;
  return data;
}

module.exports = {
  SAFETY,
  listPaperCandidateReadiness,
};
