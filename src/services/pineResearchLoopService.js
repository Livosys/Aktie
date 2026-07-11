'use strict';

const model = require('./pineResearchModelService');
const generator = require('./pineScriptGeneratorService');
const validator = require('./pineScriptValidationService');
const testRunService = require('./pineResearchTestRunService');
const aiEvaluationService = require('./pineResearchAiEvaluationService');

const DEFAULT_BUDGET = Object.freeze({
  maxVersionsPerStrategy: 12,
  maxTestsPerRound: 18,
  maxRuntimeMs: 30000,
  maxParallelTests: 2,
  cooldownMs: 60000,
  minTradeCount: 10,
  maxAllowedDrawdown: 5000,
  maxConsecutiveLosses: 8,
  dedupeEnabled: true,
});

function budget(input = {}) {
  return {
    maxVersionsPerStrategy: Math.max(1, Math.min(25, Number(input.maxVersionsPerStrategy || DEFAULT_BUDGET.maxVersionsPerStrategy))),
    maxTestsPerRound: Math.max(1, Math.min(100, Number(input.maxTestsPerRound || DEFAULT_BUDGET.maxTestsPerRound))),
    maxRuntimeMs: Math.max(1000, Math.min(120000, Number(input.maxRuntimeMs || DEFAULT_BUDGET.maxRuntimeMs))),
    maxParallelTests: Math.max(1, Math.min(4, Number(input.maxParallelTests || DEFAULT_BUDGET.maxParallelTests))),
    cooldownMs: Math.max(0, Math.min(3600000, Number(input.cooldownMs ?? DEFAULT_BUDGET.cooldownMs))),
    minTradeCount: Math.max(0, Number(input.minTradeCount ?? DEFAULT_BUDGET.minTradeCount)),
    maxAllowedDrawdown: Math.max(0, Number(input.maxAllowedDrawdown ?? DEFAULT_BUDGET.maxAllowedDrawdown)),
    maxConsecutiveLosses: Math.max(0, Number(input.maxConsecutiveLosses ?? DEFAULT_BUDGET.maxConsecutiveLosses)),
    dedupeEnabled: input.dedupeEnabled !== false,
  };
}

function orbCandidate() {
  return model.normalizeCandidate({
    candidateId: 'candidate_opening_range_breakout_001',
    baseStrategyId: 'opening_range_breakout',
    strategyName: 'Opening Range Breakout',
    hypothesis: 'Opening range breakout variants can be compared safely across MNQ/MES and 1m/5m/15m before any human promotion.',
    generationSource: 'pilot',
    status: 'draft',
  });
}

function orbVersionInputs(candidate = orbCandidate()) {
  const base = {
    candidateId: candidate.candidateId,
    baseStrategyId: candidate.baseStrategyId,
    generationSource: 'pilot',
    symbolRoots: ['MNQ', 'MES'],
    timeframes: ['1m', '5m', '15m'],
    sessionRules: { timezone: 'America/New_York', session: '0930-1600' },
    entryRules: { family: 'opening_range_breakout' },
    exitRules: { forcedClose: true },
    riskRules: { commission: 2, slippage: 1 },
  };
  return [
    ['opening_range_breakout_v1_baseline', 'v1_baseline', 'Baseline ORB with both directions.', { direction: 'both', openingRangeMinutes: 30, entryMode: 'breakout', stopMode: 'range', riskReward: 1.5 }],
    ['opening_range_breakout_v2_long_only', 'v2_long_only', 'Long-only ORB variant.', { direction: 'long_only', openingRangeMinutes: 30, entryMode: 'breakout', stopMode: 'range', riskReward: 1.5 }],
    ['opening_range_breakout_v3_short_only', 'v3_short_only', 'Short-only ORB variant.', { direction: 'short_only', openingRangeMinutes: 30, entryMode: 'breakout', stopMode: 'range', riskReward: 1.5 }],
    ['opening_range_breakout_v4_opening_range_15m', 'v4_opening_range_15m', '15 minute opening range variant.', { direction: 'both', openingRangeMinutes: 15, entryMode: 'breakout', stopMode: 'range', riskReward: 1.5 }],
    ['opening_range_breakout_v5_opening_range_30m', 'v5_opening_range_30m', '30 minute opening range variant.', { direction: 'both', openingRangeMinutes: 30, entryMode: 'breakout', stopMode: 'range', riskReward: 1.5 }],
    ['opening_range_breakout_v6_retest_entry', 'v6_retest_entry', 'Retest entry after opening range breakout.', { direction: 'both', openingRangeMinutes: 30, entryMode: 'retest', stopMode: 'range', riskReward: 1.5 }],
    ['opening_range_breakout_v7_volume_filter', 'v7_volume_filter', 'Volume confirmation filter added.', { direction: 'both', openingRangeMinutes: 30, entryMode: 'breakout', stopMode: 'range', riskReward: 1.5, volumeFilterEnabled: true, volumeMultiplier: 1.4 }],
    ['opening_range_breakout_v8_fixed_stop', 'v8_fixed_stop', 'Fixed stop distance variant.', { direction: 'both', openingRangeMinutes: 30, entryMode: 'breakout', stopMode: 'fixed_points', stopValue: 20, riskReward: 1.5 }],
    ['opening_range_breakout_v9_range_stop', 'v9_range_stop', 'Range stop with EMA filter.', { direction: 'both', openingRangeMinutes: 30, entryMode: 'breakout', stopMode: 'range', riskReward: 2, emaFilterEnabled: true, emaLength: 50 }],
  ].map(([pineVersionId, version, changeSummary, parameters]) => model.normalizeVersion({
    ...base,
    pineVersionId,
    version,
    name: version,
    parameters,
    direction: parameters.direction,
    changeSummary,
    status: 'draft',
  }));
}

function ensureOrbPilot(store) {
  const candidate = store.saveCandidate(orbCandidate());
  const versions = orbVersionInputs(candidate).map((versionInput) => {
    const existing = store.findById('versions', versionInput.pineVersionId);
    if (existing) return existing;
    const generated = generator.generatePineVersion(versionInput);
    const validated = validator.validatePineVersion(generated);
    return store.saveVersion(validated, { dedupe: false });
  });
  store.appendEvent({ type: 'pilot.ensure_orb', id: candidate.candidateId, at: model.nowIso(), details: { versions: versions.length } });
  return model.withSafety({ ok: true, candidate, versions });
}

function selectVersion(store, candidateId) {
  const versions = store.list('versions', { candidateId });
  return versions.find((version) => ['draft', 'generated', 'ready_for_test'].includes(version.status)) || versions[0] || null;
}

function applyRecommendedChanges(parent, evaluation) {
  const parameters = { ...(parent.parameters || {}) };
  for (const change of evaluation.recommendedChanges || []) {
    if (!model.CHANGE_FIELD_WHITELIST.includes(change.field)) continue;
    if (change.operation === 'set') parameters[change.field] = change.value;
    if (change.operation === 'enable') parameters[change.field] = true;
    if (change.operation === 'disable') parameters[change.field] = false;
    if (change.operation === 'increase') parameters[change.field] = Number(parameters[change.field] || 0) + Number(change.value || 1);
    if (change.operation === 'decrease') parameters[change.field] = Number(parameters[change.field] || 0) - Number(change.value || 1);
  }
  return model.defaultParameters(parameters);
}

function createChildVersion(store, parent, evaluation) {
  const parameters = applyRecommendedChanges(parent, evaluation);
  const child = model.normalizeVersion({
    candidateId: parent.candidateId,
    baseStrategyId: parent.baseStrategyId,
    version: `${parent.version}_child_${model.shortHash({ parameters, parent: parent.pineVersionId }, 6)}`,
    name: `${parent.name || parent.version} child`,
    parameters,
    symbolRoots: parent.symbolRoots,
    timeframes: parent.timeframes,
    sessionRules: parent.sessionRules,
    entryRules: parent.entryRules,
    exitRules: parent.exitRules,
    riskRules: parent.riskRules,
    direction: parameters.direction,
    parentVersionId: parent.pineVersionId,
    generationSource: evaluation.modelProvider === 'deterministic_fallback' ? 'deterministic_fallback' : 'openai',
    changeSummary: (evaluation.recommendedChanges || []).map((change) => `${change.field}:${change.operation}`).join(', ') || 'AI evaluation requested a child draft.',
    status: 'draft',
    compileStatus: 'not_checked',
  });
  return store.saveVersion(child);
}

function previewLoop(store, options = {}) {
  const cfg = budget(options.budget || options);
  const candidateId = options.candidateId || store.list('candidates')[0]?.candidateId;
  const candidate = candidateId ? store.findById('candidates', candidateId) : null;
  const version = options.pineVersionId ? store.findById('versions', options.pineVersionId) : (candidate ? selectVersion(store, candidate.candidateId) : null);
  const testPlan = version ? testRunService.createTestPlan(version, { maxTests: cfg.maxTestsPerRound }) : null;
  return model.withSafety({
    ok: true,
    mode: 'preview',
    candidate,
    version,
    budget: cfg,
    testPlan,
    blockedReason: version ? testPlan?.blockedReason || null : 'no_candidate_or_version_selected',
  });
}

async function runRound(store, options = {}) {
  const cfg = budget(options.budget || options);
  const start = Date.now();
  const candidateId = options.candidateId || store.list('candidates')[0]?.candidateId;
  const candidate = candidateId ? store.findById('candidates', candidateId) : null;
  if (!candidate) return model.withSafety({ ok: false, status: 'blocked', blockedReason: 'no_candidate_available', budget: cfg });

  const versions = store.list('versions', { candidateId: candidate.candidateId });
  if (versions.length >= cfg.maxVersionsPerStrategy) {
    return model.withSafety({ ok: false, status: 'blocked', blockedReason: 'max_versions_per_strategy_reached', budget: cfg });
  }

  let version = options.pineVersionId ? store.findById('versions', options.pineVersionId) : selectVersion(store, candidate.candidateId);
  if (!version) return model.withSafety({ ok: false, status: 'blocked', blockedReason: 'no_version_available', budget: cfg });

  if (!version.sourceCode) {
    version = store.saveVersion(generator.generatePineVersion(version), { dedupe: cfg.dedupeEnabled });
  }
  version = store.saveVersion(validator.validatePineVersion(version), { dedupe: false });

  const testResult = testRunService.runTestPlan(version, { store, maxTests: cfg.maxTestsPerRound });
  let evaluationResult = null;
  let childVersion = null;

  if (options.runAi === true && Date.now() - start < cfg.maxRuntimeMs) {
    evaluationResult = await aiEvaluationService.runEvaluation({
      store,
      pineVersionId: version.pineVersionId,
      providerMode: options.providerMode,
      providerCall: options.providerCall,
      allowDeterministicFallback: options.allowDeterministicFallback === true,
    });
    if (evaluationResult.evaluation?.nextAction === 'create_child_version' && versions.length + 1 < cfg.maxVersionsPerStrategy) {
      childVersion = createChildVersion(store, version, evaluationResult.evaluation);
    }
  }

  store.appendEvent({
    type: 'loop.run_round',
    id: candidate.candidateId,
    at: model.nowIso(),
    details: {
      pineVersionId: version.pineVersionId,
      testStatus: testResult.status,
      aiStatus: evaluationResult?.status || 'not_run',
      childVersionId: childVersion?.pineVersionId || null,
    },
  });

  return model.withSafety({
    ok: true,
    status: 'completed',
    candidate,
    version,
    testResult,
    evaluationResult,
    childVersion,
    budget: cfg,
  });
}

module.exports = {
  DEFAULT_BUDGET,
  budget,
  orbCandidate,
  orbVersionInputs,
  ensureOrbPilot,
  selectVersion,
  applyRecommendedChanges,
  createChildVersion,
  previewLoop,
  runRound,
};
