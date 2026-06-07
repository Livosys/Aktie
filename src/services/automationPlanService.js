'use strict';

// Read-only Automation Plan for Trading OS.
//
// This service ONLY reads existing runtime/result data and suggests which
// strategies would be the best future candidates for paper-only testing.
// It NEVER starts a batch, replay, paper trade, or order. It never mutates
// allowlists, risk, scheduler, broker or live-trading state. Safety is always
// locked to paper_only with every action flag false.

const strategyRuntimeMatrixService = require('./strategyRuntimeMatrixService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const MAX_RECOMMENDED = 4;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Build a plain evidence object from a runtime-matrix row. Read-only.
function buildEvidence(row) {
  const paper = row.paperSummary || {};
  const sim = row.simulationSummary || {};
  return {
    runtimeStatus: row.automaticStatus,
    paperRuntimeStatus: row.paperRuntimeStatus,
    scannerEnabled: row.scannerEnabled === true,
    paperTrades: num(paper.totalTrades) || 0,
    paperWinRate: num(paper.winRate),
    paperAvgPnl: num(paper.avgPnl),
    simTrades: num(sim.trades) || 0,
    simRuns: num(sim.runs) || 0,
    simWinRate: num(sim.winRate),
    simAvgPnl: num(sim.avgPnl),
    lastTested: row.lastTested || 'unknown',
  };
}

// Confidence reflects how much real evidence backs a candidate. It never
// implies readiness to trade — only how strong the read-only signal is.
function confidenceFor(row, evidence) {
  if (row.strongCandidate && evidence.paperTrades >= 10) return 'high';
  if (row.strongCandidate) return 'medium';
  if ((evidence.simTrades >= 30 || evidence.simRuns >= 3) && (num(evidence.simWinRate) || 0) >= 48) return 'medium';
  return 'low';
}

function warningsFor(row, evidence) {
  const warnings = [];
  if (evidence.paperTrades < 10) warnings.push('limited_paper_only_evidence');
  if (row.weakCandidate) warnings.push('mixed_results_paper_vs_simulation');
  for (const blocker of Array.isArray(row.blockers) ? row.blockers : []) {
    if (String(blocker).startsWith('missing_data:')) warnings.push(blocker);
  }
  if (row.paperRuntimeStatus === 'partial') warnings.push('paper_runtime_partial');
  if (!warnings.length) warnings.push('none');
  return [...new Set(warnings)];
}

function reasonFor(row, evidence) {
  const parts = [];
  if (row.automaticStatus === 'fullyAutomatic') parts.push('Scanner och paper-runtime är kopplade (fully automatic).');
  else if (row.automaticStatus === 'partlyAutomatic') parts.push('Delvis kopplad (partly automatic).');
  if (row.strongCandidate) parts.push('Stark resultatdata.');
  if (evidence.paperTrades >= 10 && (num(evidence.paperWinRate) || 0) >= 50) {
    parts.push(`Paper: ${evidence.paperWinRate}% vinst på ${evidence.paperTrades} trades.`);
  }
  if (evidence.simTrades >= 30 && (num(evidence.simWinRate) || 0) >= 50) {
    parts.push(`Simulering: ${evidence.simWinRate}% vinst på ${evidence.simTrades} trades.`);
  }
  if (!Array.isArray(row.blockers) || !row.blockers.length) parts.push('Inga aktiva blockers.');
  return parts.join(' ') || 'Lovande runtime- och resultatprofil.';
}

// A candidate is only eligible for the recommended list if it is genuinely
// connected and clean. This mirrors the brief: fullyAutomatic, not weak, not
// needing more data, no blockers.
function isRecommendable(row) {
  return row.automaticStatus === 'fullyAutomatic'
    && row.weakCandidate !== true
    && row.needsMoreData !== true
    && (!Array.isArray(row.blockers) || row.blockers.length === 0);
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function getAutomationPlan() {
  const matrix = strategyRuntimeMatrixService.getStrategyRuntimeMatrix();
  const rows = Array.isArray(matrix.strategies) ? matrix.strategies : [];

  const recommendedPaperCandidates = [];
  const promisingNeedsManualApproval = [];
  const blockedStrategies = [];
  const needsMoreData = [];
  const weakStrategies = [];

  // Precedence: blocked > recommended > promising-manual > weak > needs-data.
  // Each strategy lands in at most one bucket so the lists never overlap.
  const recommendedPool = [];

  for (const row of rows) {
    const base = { id: row.id, name: row.name || row.id };
    const evidence = buildEvidence(row);

    if (row.automaticStatus === 'pausedOrBlocked') {
      blockedStrategies.push({
        ...base,
        reason: (Array.isArray(row.blockers) && row.blockers[0]) || 'Pausad eller blockerad i runtime. Ska inte automatiseras ännu.',
      });
      continue;
    }

    if (isRecommendable(row)) {
      recommendedPool.push({
        ...base,
        reason: reasonFor(row, evidence),
        evidence,
        confidence: confidenceFor(row, evidence),
        warnings: warningsFor(row, evidence),
        nextStep: 'Manuell granskning, sedan ett enskilt paper-only replay efter godkännande. Inga tester startas automatiskt.',
      });
      continue;
    }

    // Strong but not cleanly recommendable: promising, requires manual approval.
    if (row.strongCandidate === true) {
      promisingNeedsManualApproval.push({
        ...base,
        reason: row.weakCandidate
          ? 'Stark paper-data men motstridig simulering. Lovande, men kräver manuell granskning.'
          : 'Stark resultatdata men ännu inte fullt kopplad (saknar data eller partial runtime). Kräver manuell granskning.',
        evidence,
        confidence: confidenceFor(row, evidence),
        warnings: warningsFor(row, evidence),
        nextStep: 'Samla mer paper-only/replay-data manuellt innan eventuellt godkännande.',
      });
      continue;
    }

    if (row.weakCandidate === true) {
      weakStrategies.push({
        ...base,
        reason: 'Svag kandidat: låg vinstprocent eller negativ avkastning i tillgänglig data. Sänk prioritet eller granska.',
      });
      continue;
    }

    if (row.needsMoreData === true) {
      needsMoreData.push({
        ...base,
        reason: 'Otillräcklig evidens. Behöver mer paper-only/replay-data innan den kan bedömas.',
      });
      continue;
    }

    // Remaining rows are stable manual-only strategies with no action needed.
  }

  // Rank the recommended pool by confidence, then evidence volume, then win rate.
  recommendedPool.sort((a, b) => {
    const conf = (CONFIDENCE_RANK[b.confidence] || 0) - (CONFIDENCE_RANK[a.confidence] || 0);
    if (conf !== 0) return conf;
    const trades = (b.evidence.paperTrades + b.evidence.simTrades) - (a.evidence.paperTrades + a.evidence.simTrades);
    if (trades !== 0) return trades;
    return (num(b.evidence.simWinRate) || 0) - (num(a.evidence.simWinRate) || 0);
  });

  recommendedPaperCandidates.push(...recommendedPool.slice(0, MAX_RECOMMENDED));
  // Any clean fully-automatic overflow beyond the cap is surfaced as promising,
  // never silently dropped.
  for (const overflow of recommendedPool.slice(MAX_RECOMMENDED)) {
    promisingNeedsManualApproval.push({
      id: overflow.id,
      name: overflow.name,
      reason: 'Ren fully-automatic kandidat utöver topp-4. Kan granskas manuellt senare.',
      evidence: overflow.evidence,
      confidence: overflow.confidence,
      warnings: overflow.warnings,
      nextStep: overflow.nextStep,
    });
  }

  return {
    ok: true,
    mode: 'dry_run',
    generated_at: new Date().toISOString(),
    source: '/api/strategies/runtime-matrix',
    summary: {
      total: rows.length,
      recommended: recommendedPaperCandidates.length,
      promisingNeedsManualApproval: promisingNeedsManualApproval.length,
      blocked: blockedStrategies.length,
      needsMoreData: needsMoreData.length,
      weak: weakStrategies.length,
    },
    recommendedPaperCandidates,
    promisingNeedsManualApproval,
    blockedStrategies,
    needsMoreData,
    weakStrategies,
    nextSafeStep: 'Detta är bara en plan. Inga tester startas automatiskt. Granska listan visuellt. Nästa säkra steg är att du manuellt väljer EN strategi för ett paper-only replay efter din egen granskning. Ingen broker, ingen live trading, inga riktiga order.',
    safety: SAFETY,
  };
}

module.exports = {
  SAFETY,
  getAutomationPlan,
};
