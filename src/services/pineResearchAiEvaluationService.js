'use strict';

const axios = require('axios');

const model = require('./pineResearchModelService');

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const PROMPT_VERSION = 'pine_research_eval_v1';

function provider() {
  return String(process.env.AI_ANALYST_PROVIDER || process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
}

function modelName() {
  return process.env.AI_ANALYST_MODEL || process.env.AI_MODEL || 'gpt-4o-mini';
}

function timeoutMs() {
  const n = Number(process.env.AI_ANALYST_TIMEOUT_MS || 15000);
  return Number.isFinite(n) ? Math.max(1000, Math.min(60000, n)) : 15000;
}

function compactMetric(run) {
  return {
    testRunId: run.testRunId,
    engine: run.engine,
    symbol: run.symbol,
    timeframe: run.timeframe,
    dateRange: run.dateRange,
    status: run.status,
    parityStatus: run.parityStatus,
    blockedReason: run.blockedReason || null,
    tradeCount: run.tradeCount || 0,
    metrics: {
      netPnl: run.metrics?.netPnl ?? run.metrics?.netProfit ?? null,
      winRate: run.metrics?.winRate ?? null,
      profitFactor: run.metrics?.profitFactor ?? null,
      maxDrawdown: run.metrics?.maxDrawdown ?? null,
      averageTrade: run.metrics?.averageTrade ?? null,
      maxConsecutiveLosses: run.metrics?.maxConsecutiveLosses ?? null,
    },
  };
}

function buildEvaluationInput({ candidate, version, testRuns }) {
  const payload = model.withSafety({
    candidate: candidate ? {
      candidateId: candidate.candidateId,
      baseStrategyId: candidate.baseStrategyId,
      strategyName: candidate.strategyName,
      hypothesis: candidate.hypothesis,
      status: candidate.status,
    } : null,
    pineVersion: version ? {
      pineVersionId: version.pineVersionId,
      baseStrategyId: version.baseStrategyId,
      version: version.version,
      direction: version.direction,
      parameters: version.parameters,
      compileStatus: version.compileStatus,
      compileErrors: version.compileErrors,
      validationWarnings: version.validationWarnings,
      sourceHash: version.sourceHash,
      parameterHash: version.parameterHash,
      parentVersionId: version.parentVersionId,
      changeSummary: version.changeSummary,
    } : null,
    testRuns: (testRuns || []).slice(0, 40).map(compactMetric),
    constraints: {
      allowedNextActions: model.NEXT_ACTIONS,
      allowedChangeFields: model.CHANGE_FIELD_WHITELIST,
      noPromotion: true,
      noExecution: true,
      noRiskMutation: true,
      noLedgerWrites: true,
    },
  });
  model.assertSafeIntent(payload);
  return payload;
}

function systemPrompt() {
  return `
You are Trading OS Pine Research evaluator.
You only evaluate isolated paper/replay research results and Pine version metadata.
Return strict JSON only. Do not recommend live trading, broker use, order routing,
approval, READY status, Paper activation, Futures Paper activation, runtime risk
changes, filesystem paths, shell commands, credentials, or secrets.

Required JSON shape:
{
  "verdict": "needs_improvement",
  "score": 0,
  "strengths": [],
  "weaknesses": [],
  "dataQualityWarnings": [],
  "overfitWarnings": [],
  "recommendedChanges": [
    { "field": "direction", "operation": "set", "value": "short_only", "reason": "..." }
  ],
  "nextAction": "hold_for_review",
  "confidence": 0.0
}
Allowed nextAction values: ${model.NEXT_ACTIONS.join(', ')}.
Allowed change fields: ${model.CHANGE_FIELD_WHITELIST.join(', ')}.
`.trim();
}

function extractJson(content) {
  if (!content) throw new Error('ai_response_empty');
  const text = String(content).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
    throw new Error('ai_response_malformed_json');
  }
}

async function callOpenAi(input, options = {}) {
  const apiKey = process.env.AI_ANALYST_API_KEY || process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI_API_KEY_missing');
  const baseUrl = process.env.AI_ANALYST_BASE_URL || process.env.AI_BASE_URL || DEFAULT_OPENAI_URL;
  const response = await axios.post(baseUrl, {
    model: modelName(),
    temperature: 0.15,
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: JSON.stringify(input) },
    ],
  }, {
    timeout: options.timeoutMs || timeoutMs(),
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
  });
  return response.data?.choices?.[0]?.message?.content || '';
}

function deterministicEvaluation({ candidate, version, testRuns }, reason = 'deterministic_fallback') {
  const blocked = (testRuns || []).filter((run) => run.status === 'blocked');
  const completed = (testRuns || []).filter((run) => run.status === 'completed');
  const warnings = [
    reason,
    completed.length ? null : 'no_completed_internal_tests',
    blocked.length ? 'some_tests_blocked_by_parity_or_data_limits' : null,
  ].filter(Boolean);
  return {
    candidateId: candidate?.candidateId || version?.candidateId || '',
    pineVersionId: version?.pineVersionId || '',
    testRunIds: (testRuns || []).map((run) => run.testRunId),
    verdict: completed.length ? 'hold_for_review' : 'provider_or_test_data_unavailable',
    score: completed.length ? 50 : 0,
    strengths: completed.length ? ['Completed internal tests are available for review.'] : [],
    weaknesses: completed.length ? [] : ['No completed internal test results are available yet.'],
    dataQualityWarnings: warnings,
    overfitWarnings: [],
    recommendedChanges: [],
    nextAction: completed.length ? 'request_human_review' : 'run_more_tests',
    confidence: completed.length ? 0.35 : 0.1,
    modelProvider: 'deterministic_fallback',
    modelName: 'local_rules',
    promptVersion: PROMPT_VERSION,
  };
}

function providerErrorEvaluation({ candidate, version, testRuns, inputHash }, err) {
  return model.normalizeEvaluation({
    candidateId: candidate?.candidateId || version?.candidateId || '',
    pineVersionId: version?.pineVersionId || '',
    testRunIds: (testRuns || []).map((run) => run.testRunId),
    verdict: 'provider_error',
    score: 0,
    strengths: [],
    weaknesses: ['AI provider did not return a valid evaluation.'],
    dataQualityWarnings: [err?.message || String(err || 'provider_error')],
    overfitWarnings: [],
    recommendedChanges: [],
    nextAction: 'hold_for_review',
    confidence: 0,
    modelProvider: provider(),
    modelName: modelName(),
    promptVersion: PROMPT_VERSION,
    inputHash,
    outputHash: '',
  });
}

function normalizeAiOutput(parsed, meta) {
  const outputHash = model.hashValue(parsed);
  return model.normalizeEvaluation({
    ...parsed,
    candidateId: meta.candidateId,
    pineVersionId: meta.pineVersionId,
    testRunIds: meta.testRunIds,
    modelProvider: meta.provider,
    modelName: meta.modelName,
    promptVersion: PROMPT_VERSION,
    inputHash: meta.inputHash,
    outputHash,
    rawResponseArtifact: meta.rawResponseArtifact || null,
  });
}

async function runEvaluation(options = {}) {
  const store = options.store;
  if (!store) throw new Error('store_is_required');
  const version = options.version || store.findById('versions', options.pineVersionId);
  if (!version) throw new Error('pine_version_not_found');
  const candidate = options.candidate || store.findById('candidates', version.candidateId);
  const testRuns = options.testRuns || store.list('testRuns', { pineVersionId: version.pineVersionId });
  const input = buildEvaluationInput({ candidate, version, testRuns });
  const inputHash = model.hashValue(input);

  if (options.providerMode === 'deterministic') {
    const deterministic = model.normalizeEvaluation({
      ...deterministicEvaluation({ candidate, version, testRuns }),
      inputHash,
      outputHash: model.hashValue({ deterministic: true, inputHash }),
    });
    store.saveEvaluation(deterministic);
    return model.withSafety({ ok: true, status: 'deterministic', evaluation: deterministic });
  }

  try {
    const providerCall = options.providerCall || callOpenAi;
    const raw = await providerCall(input, options);
    const parsed = typeof raw === 'string' ? extractJson(raw) : raw;
    const artifact = store.writeArtifact('artifacts', `ai-response-${version.pineVersionId}-${Date.now()}`, JSON.stringify(parsed, null, 2), 'json');
    const evaluation = normalizeAiOutput(parsed, {
      candidateId: version.candidateId,
      pineVersionId: version.pineVersionId,
      testRunIds: testRuns.map((run) => run.testRunId),
      provider: provider(),
      modelName: modelName(),
      inputHash,
      rawResponseArtifact: artifact.artifact,
    });
    store.saveEvaluation(evaluation);
    return model.withSafety({ ok: true, status: 'ok', evaluation });
  } catch (err) {
    if (options.allowDeterministicFallback === true) {
      const fallback = model.normalizeEvaluation({
        ...deterministicEvaluation({ candidate, version, testRuns }, `provider_error:${err?.message || String(err)}`),
        inputHash,
        outputHash: model.hashValue({ fallback: true, inputHash }),
      });
      store.saveEvaluation(fallback);
      return model.withSafety({ ok: true, status: 'deterministic_fallback', evaluation: fallback, providerError: err?.message || String(err) });
    }
    const evaluation = providerErrorEvaluation({ candidate, version, testRuns, inputHash }, err);
    store.saveEvaluation(evaluation);
    return model.withSafety({ ok: false, status: 'provider_error', evaluation, error: err?.message || String(err) });
  }
}

module.exports = {
  PROMPT_VERSION,
  provider,
  modelName,
  timeoutMs,
  buildEvaluationInput,
  extractJson,
  callOpenAi,
  normalizeAiOutput,
  deterministicEvaluation,
  runEvaluation,
};
