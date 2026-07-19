'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPineResearchStore } = require('./pineResearchStoreService');
const loop = require('./pineResearchLoopService');
const testRunService = require('./pineResearchTestRunService');
const aiEvaluation = require('./pineResearchAiEvaluationService');
const csvImport = require('./tradingViewCsvImportService');
const comparison = require('./pineResearchComparisonService');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pine-research-flow-'));
}

async function main() {
  const root = tempDir();
  try {
    const store = createPineResearchStore({ rootDir: root });
    const emptyDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pine-research-data-'));
    const pilot = loop.ensureOrbPilot(store);
    const version = pilot.versions.find((item) => item.pineVersionId === 'opening_range_breakout_v3_short_only') || pilot.versions[0];

    const plan = testRunService.createTestPlan(version);
    assert.equal(plan.safety.actions_allowed, false);
    assert.ok(plan.plans.length > 0);
    assert.ok(plan.plans.every((run) => ['blocked', 'planned'].includes(run.status)));
    assert.ok(plan.plans.some((run) => run.parityStatus === 'certified'), 'ORB parity adapter certifies internal_preview plans');
    assert.ok(plan.plans.every((run) => Array.isArray(run.parityMatrix)));

    // Certified parity does not run anything by itself: with no historical
    // data available every run must block on data readiness, never fabricate.
    const runResult = testRunService.runTestPlan(version, { store, maxTests: 2, dataRootDir: emptyDataRoot });
    assert.equal(runResult.status, 'blocked');
    assert.ok(runResult.testRuns.every((run) => run.status === 'blocked'));
    assert.ok(runResult.testRuns.every((run) => run.tradeCount === 0));
    assert.ok(runResult.testRuns.every((run) => !run.resultArtifact));

    const preview = testRunService.previewSingleTestRun(version, { symbol: 'MNQ', timeframe: '5m', dataRootDir: emptyDataRoot });
    assert.equal(preview.candidateId, version.candidateId);
    assert.equal(preview.pineVersionId, version.pineVersionId);
    assert.equal(preview.symbol, 'MNQ');
    assert.equal(preview.timeframe, '5m');
    assert.equal(preview.parityStatus, 'certified');
    assert.equal(preview.dataStatus, 'missing');
    assert.equal(preview.wouldRun, false);
    assert.ok(String(preview.blockedReason || '').includes('bars_in_shared_candle_store'));
    assert.equal(preview.unsupportedRules.length, 0);

    const batchPreview = testRunService.previewSingleTestRun(version, { engine: 'batch', symbol: 'MNQ', timeframe: '5m', dataRootDir: emptyDataRoot });
    assert.equal(batchPreview.parityStatus, 'blocked');
    assert.equal(batchPreview.wouldRun, false);
    assert.ok(batchPreview.unsupportedRules.includes('engine support'));
    fs.rmSync(emptyDataRoot, { recursive: true, force: true });

    const validJson = JSON.stringify({
      verdict: 'needs_improvement',
      score: 64,
      strengths: ['Short trades have lower drawdown in the available summaries.'],
      weaknesses: ['No certified Pine parity exists yet.'],
      dataQualityWarnings: ['Internal parity is blocked.'],
      overfitWarnings: ['Results are not broad enough yet.'],
      recommendedChanges: [{ field: 'direction', operation: 'set', value: 'short_only', reason: 'Short side should be isolated first.' }],
      nextAction: 'create_child_version',
      confidence: 0.78,
    });
    const evalResult = await aiEvaluation.runEvaluation({
      store,
      pineVersionId: version.pineVersionId,
      providerCall: async () => validJson,
    });
    assert.equal(evalResult.ok, true);
    assert.equal(evalResult.evaluation.nextAction, 'create_child_version');
    assert.equal(evalResult.evaluation.recommendedChanges[0].field, 'direction');

    const child = loop.createChildVersion(store, version, evalResult.evaluation);
    assert.equal(child.status, 'draft');
    assert.equal(child.parentVersionId, version.pineVersionId);
    assert.notEqual(child.status, 'candidate');
    assert.equal(child.reviewStatus, 'needs_human_review');

    const malformed = await aiEvaluation.runEvaluation({
      store,
      pineVersionId: version.pineVersionId,
      providerCall: async () => 'not-json',
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.status, 'provider_response_invalid');
    assert.equal(malformed.schemaValid, false);
    assert.equal(malformed.providerResultValid, false);

    const failed = await aiEvaluation.runEvaluation({
      store,
      pineVersionId: version.pineVersionId,
      providerCall: async () => { throw new Error('AI_API_KEY_missing'); },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 'provider_error');

    const deterministic = await aiEvaluation.runEvaluation({
      store,
      pineVersionId: version.pineVersionId,
      providerMode: 'deterministic',
    });
    assert.equal(deterministic.status, 'deterministic');
    assert.equal(deterministic.evaluation.modelProvider, 'deterministic_fallback');

    const tradesCsv = [
      'Entry Time,Exit Time,Type,Profit,Commission,Drawdown',
      '2025-01-02 09:45,2025-01-02 10:15,Long,120,4,25',
      '2025-01-03 09:50,2025-01-03 10:20,Short,-40,4,30',
    ].join('\n');
    const imported = csvImport.importTradingViewCsv({
      store,
      pineVersionId: version.pineVersionId,
      symbol: 'MNQ',
      timeframe: '5m',
      tradesCsv,
    });
    assert.equal(imported.status, 'imported');
    assert.equal(imported.validation.tradingViewMetrics.tradeCount, 2);
    assert.equal(imported.validation.tradingViewMetrics.netPnl, 80);

    const internal = store.saveTestRun({
      candidateId: version.candidateId,
      pineVersionId: version.pineVersionId,
      engine: 'internal_preview',
      symbol: 'MNQ',
      timeframe: '5m',
      status: 'completed',
      parityStatus: 'supported',
      metrics: { tradeCount: 2, netPnl: 76, winRate: 50, profitFactor: 2.8, maxDrawdown: 35, commission: 8 },
      tradeCount: 2,
    });
    const compared = comparison.compareTradingViewValidation({
      store,
      validationId: imported.validation.validationId,
      internalTestRunId: internal.testRunId,
    });
    assert.equal(compared.ok, true);
    assert.ok(['minor_differences', 'major_differences', 'matched'].includes(compared.validation.validationStatus));

    const budgeted = await loop.runRound(store, {
      candidateId: pilot.candidate.candidateId,
      pineVersionId: version.pineVersionId,
      maxVersionsPerStrategy: 1,
    });
    assert.equal(budgeted.ok, false);
    assert.equal(budgeted.blockedReason, 'max_versions_per_strategy_reached');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('pineResearchFactoryFlow.test.js passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
