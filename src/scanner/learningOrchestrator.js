'use strict';
/**
 * Learning Orchestrator
 *
 * Central layer that collects score adjustments proposed by multiple
 * learning engines (AdaptiveEdge, FakeoutDna, ScoreCalibration, SetupDNA,
 * RuleMemory) and resolves conflicts before a final tradeScore is committed.
 *
 * Resolution strategy:
 *   1. Sum all signed adjustments.
 *   2. Clamp total to ±ORCHESTRATOR_MAX_TOTAL (default: 15).
 *   3. If engines disagree in direction (mixed +/−), scale down by CONFLICT_SCALE.
 *   4. Apply hard-block safety caps AFTER adjustment.
 *   5. Never auto-changes hard rules — enrichment only.
 *
 * SAFETY CONTRACT:
 *   TFS.active          → tradeScore capped at 10 (re-applied)
 *   breakoutAlreadyOcc  → tradeScore capped at 20 (re-applied)
 *   autoFilter.blocked  → tradeScore capped at 20 (re-applied)
 */

const ORCHESTRATOR_MAX_TOTAL = 15;
const CONFLICT_SCALE         = 0.6;  // scale down when engines disagree

// Engines whose adjustments we collect.
// key matches the field name on result that contains { adjustment } or { adj }
const ENGINE_MAP = [
  { field: 'adaptiveEdge',      adjKey: 'adjustment',    weight: 1.0, name: 'AdaptiveEdge' },
  { field: 'fakeoutDna',        adjKey: 'adjustment',    weight: 1.0, name: 'FakeoutDNA' },
  { field: 'scoreCalibration',  adjKey: 'adjustment',    weight: 0.8, name: 'ScoreCalibration' },
  { field: 'setupDna',          adjKey: 'scoreAdjustment', weight: 0.9, name: 'SetupDNA' },
  { field: 'ruleMemory',        adjKey: 'adjustment',    weight: 0.7, name: 'RuleMemory' },
];

// ── Hard-block caps (must be re-applied after every adjustment) ───────────────

function applyHardCaps(result, score) {
  if (result?.autoFilter?.blocked)         score = Math.min(score, 20);
  if (result?.threeFingerSpread?.active || result?.tfs?.active) score = Math.min(score, 10);
  if (result?.breakoutAlreadyOccurred)     score = Math.min(score, 20);
  return Math.max(0, Math.min(100, score));
}

// ── Orchestrate ───────────────────────────────────────────────────────────────

function orchestrateScores(result) {
  if (!result) return result;

  // Collect proposals
  const proposals = [];
  for (const { field, adjKey, weight, name } of ENGINE_MAP) {
    const engine = result[field];
    if (!engine) continue;
    const raw = engine[adjKey];
    if (raw == null || isNaN(raw) || raw === 0) continue;
    proposals.push({ name, adj: raw * weight });
  }

  if (proposals.length === 0) {
    return { ...result, orchestrator: { enabled: false, adjustments: [], totalAdj: 0 } };
  }

  const totalRaw = proposals.reduce((s, p) => s + p.adj, 0);

  // Conflict detection: any engines pointing opposite direction?
  const hasPositive = proposals.some(p => p.adj > 0);
  const hasNegative = proposals.some(p => p.adj < 0);
  const hasConflict = hasPositive && hasNegative;

  let totalAdj = totalRaw;
  if (hasConflict) totalAdj *= CONFLICT_SCALE;

  // Clamp total adjustment
  totalAdj = Math.max(-ORCHESTRATOR_MAX_TOTAL, Math.min(ORCHESTRATOR_MAX_TOTAL, totalAdj));
  totalAdj = Math.round(totalAdj);

  // Base score: use the most upstream pre-adjustment score available
  const baseScore =
    result.tradeScoreBeforeAdaptive ??
    result.tradeScoreBeforeConfidence ??
    result.tradeScore ?? 0;

  const rawFinal   = baseScore + totalAdj;
  const finalScore = applyHardCaps(result, Math.round(rawFinal));

  const orchestrator = {
    enabled:       true,
    baseScore,
    totalAdj,
    hasConflict,
    conflictScale: hasConflict ? CONFLICT_SCALE : 1,
    adjustments:   proposals.map(p => ({ name: p.name, adj: Math.round(p.adj * 10) / 10 })),
    finalScore,
  };

  return {
    ...result,
    tradeScore:   finalScore,
    orchestrator,
  };
}

module.exports = { orchestrateScores };
