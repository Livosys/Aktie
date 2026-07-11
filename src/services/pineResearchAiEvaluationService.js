'use strict';

const axios = require('axios');

const model = require('./pineResearchModelService');

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const PROMPT_VERSION = 'pine_research_eval_v1';
const REQUIRED_AI_RESPONSE_KEYS = Object.freeze([
  'verdict',
  'score',
  'strengths',
  'weaknesses',
  'dataQualityWarnings',
  'overfitWarnings',
  'recommendedChanges',
  'nextAction',
  'confidence',
]);
const AI_RESPONSE_VERDICTS = Object.freeze([
  'strong_candidate',
  'promising',
  'needs_improvement',
  'insufficient_data',
  'hold_for_review',
  'reject_version',
  'ready_for_human_review',
]);
const PERFORMANCE_METRIC_KEYS = Object.freeze([
  'metrics',
  'tradeCount',
  'winRate',
  'profitFactor',
  'drawdown',
  'maxDrawdown',
  'pnl',
  'netPnl',
  'netProfit',
  'mfe',
  'mae',
]);

function provider() {
  return String(process.env.AI_ANALYST_PROVIDER || process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
}

function modelName() {
  return process.env.AI_ANALYST_MODEL || process.env.AI_MODEL || 'gpt-5.5';
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
Return only one JSON object. Do not wrap the response in Markdown. Do not add
explanatory text. Use exactly the required keys and do not omit empty arrays.
Do not recommend live trading, broker use, order routing, approval, READY
status, Paper activation, Futures Paper activation, runtime risk changes,
filesystem paths, shell commands, credentials, or secrets.

Required JSON shape:
{
  "verdict": "insufficient_data",
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
Allowed verdict values: ${AI_RESPONSE_VERDICTS.join(', ')}.
Allowed nextAction values: ${model.NEXT_ACTIONS.join(', ')}.
Allowed change fields: ${model.CHANGE_FIELD_WHITELIST.join(', ')}.
If testRunIds is an empty array, no internal performance test exists. Do not
invent trades, win rate, profit factor, drawdown, PnL, MFE or MAE. Evaluate only
structure, risk rules, session rules and recommended next tests.
`.trim();
}

function extractJson(content) {
  if (!content) throw new Error('ai_response_empty');
  const raw = String(content).trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = (fenced ? fenced[1] : raw).trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    throw new Error('ai_response_malformed_json');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
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

function invalidResponseError(message) {
  const err = new Error(message);
  err.code = 'provider_response_invalid';
  return err;
}

function assertExactKeys(value, allowedKeys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponseError(`${context}_must_be_object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  const missing = expected.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !expected.includes(key));
  if (missing.length) throw invalidResponseError(`${context}_missing_required_fields:${missing.join(',')}`);
  if (unknown.length) throw invalidResponseError(`${context}_unknown_fields:${unknown.join(',')}`);
}

function unwrapAiResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidResponseError('ai_response_must_be_object');
  }
  const topKeys = Object.keys(parsed);
  const direct = REQUIRED_AI_RESPONSE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(parsed, key));
  if (direct) {
    assertExactKeys(parsed, REQUIRED_AI_RESPONSE_KEYS, 'ai_response');
    return parsed;
  }
  if (topKeys.length === 1 && topKeys[0] === 'AIEvaluation') {
    assertExactKeys(parsed.AIEvaluation, REQUIRED_AI_RESPONSE_KEYS, 'ai_response.AIEvaluation');
    return parsed.AIEvaluation;
  }
  if (topKeys.length === 1) {
    throw invalidResponseError(`ai_response_unknown_wrapper:${topKeys[0]}`);
  }
  throw invalidResponseError(`ai_response_unknown_fields:${topKeys.join(',')}`);
}

function assertStringArray(value, field) {
  if (!Array.isArray(value)) throw invalidResponseError(`${field}_must_be_array`);
  for (const item of value) {
    if (typeof item !== 'string') throw invalidResponseError(`${field}_must_contain_strings`);
  }
}

function assertRecommendedChanges(value) {
  if (!Array.isArray(value)) throw invalidResponseError('recommendedChanges_must_be_array');
  for (const change of value) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      throw invalidResponseError('recommendedChanges_items_must_be_objects');
    }
    const keys = Object.keys(change);
    const allowed = ['field', 'operation', 'value', 'reason'];
    const unknown = keys.filter((key) => !allowed.includes(key));
    if (unknown.length) throw invalidResponseError(`recommendedChanges_unknown_fields:${unknown.join(',')}`);
    model.normalizeEvaluation({
      verdict: 'hold_for_review',
      score: 0,
      strengths: [],
      weaknesses: [],
      dataQualityWarnings: [],
      overfitWarnings: [],
      recommendedChanges: [change],
      nextAction: 'hold_for_review',
      confidence: 0,
    });
  }
}

function assertNoStructuredPerformanceClaims(value) {
  for (const key of Object.keys(value || {})) {
    if (PERFORMANCE_METRIC_KEYS.includes(key)) {
      throw invalidResponseError(`performance_metric_field_not_allowed_without_test_runs:${key}`);
    }
  }
}

function validateAiResponsePayload(payload) {
  assertNoStructuredPerformanceClaims(payload);
  if (!AI_RESPONSE_VERDICTS.includes(payload.verdict)) throw invalidResponseError('verdict_is_invalid');
  if (!Number.isFinite(Number(payload.score)) || Number(payload.score) < 0 || Number(payload.score) > 100) {
    throw invalidResponseError('score_must_be_number_0_100');
  }
  assertStringArray(payload.strengths, 'strengths');
  assertStringArray(payload.weaknesses, 'weaknesses');
  assertStringArray(payload.dataQualityWarnings, 'dataQualityWarnings');
  assertStringArray(payload.overfitWarnings, 'overfitWarnings');
  assertRecommendedChanges(payload.recommendedChanges);
  if (!model.NEXT_ACTIONS.includes(payload.nextAction)) throw invalidResponseError('nextAction_is_invalid');
  if (!Number.isFinite(Number(payload.confidence)) || Number(payload.confidence) < 0 || Number(payload.confidence) > 1) {
    throw invalidResponseError('confidence_must_be_number_0_1');
  }
  return {
    verdict: payload.verdict,
    score: Number(payload.score),
    strengths: payload.strengths,
    weaknesses: payload.weaknesses,
    dataQualityWarnings: payload.dataQualityWarnings,
    overfitWarnings: payload.overfitWarnings,
    recommendedChanges: payload.recommendedChanges,
    nextAction: payload.nextAction,
    confidence: Number(payload.confidence),
  };
}

function normalizeAiOutput(parsed, meta) {
  const payload = validateAiResponsePayload(unwrapAiResponse(parsed));
  const outputHash = model.hashValue(parsed);
  return model.normalizeEvaluation({
    ...payload,
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

function sanitizeDiagnosticSample(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-openai-key]')
    .slice(0, 800);
}

function saveInvalidResponseArtifact(store, version, err, raw) {
  if (!store || typeof store.writeArtifact !== 'function') return null;
  try {
    return store.writeArtifact('artifacts', `ai-invalid-response-${version.pineVersionId}-${Date.now()}`, JSON.stringify({
      status: 'provider_response_invalid',
      schemaValid: false,
      error: err?.message || String(err),
      sample: sanitizeDiagnosticSample(typeof raw === 'string' ? raw : JSON.stringify(raw)),
    }, null, 2), 'json').artifact;
  } catch (_) {
    return null;
  }
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
    let parsed;
    try {
      parsed = typeof raw === 'string' ? extractJson(raw) : raw;
    } catch (err) {
      err.code = 'provider_response_invalid';
      err.diagnosticArtifact = saveInvalidResponseArtifact(store, version, err, raw);
      throw err;
    }
    let evaluation;
    let artifact = null;
    try {
      artifact = store.writeArtifact('artifacts', `ai-response-${version.pineVersionId}-${Date.now()}`, JSON.stringify(parsed, null, 2), 'json');
      evaluation = normalizeAiOutput(parsed, {
        candidateId: version.candidateId,
        pineVersionId: version.pineVersionId,
        testRunIds: testRuns.map((run) => run.testRunId),
        provider: provider(),
        modelName: modelName(),
        inputHash,
        rawResponseArtifact: artifact.artifact,
      });
    } catch (err) {
      if (err.code !== 'provider_response_invalid') err.code = 'provider_response_invalid';
      err.diagnosticArtifact = artifact?.artifact || saveInvalidResponseArtifact(store, version, err, parsed);
      throw err;
    }
    store.saveEvaluation(evaluation);
    return model.withSafety({ ok: true, status: 'ok', evaluation });
  } catch (err) {
    if (err?.code === 'provider_response_invalid') {
      return model.withSafety({
        ok: false,
        status: 'provider_response_invalid',
        schemaValid: false,
        providerResultValid: false,
        diagnosticArtifact: err.diagnosticArtifact || null,
        error: err?.message || String(err),
      });
    }
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
  unwrapAiResponse,
  validateAiResponsePayload,
  deterministicEvaluation,
  runEvaluation,
  REQUIRED_AI_RESPONSE_KEYS,
  AI_RESPONSE_VERDICTS,
};
