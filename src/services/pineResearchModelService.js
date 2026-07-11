'use strict';

const crypto = require('crypto');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const CANDIDATE_STATUSES = Object.freeze(['draft', 'queued', 'researching', 'paused', 'completed', 'rejected']);
const VERSION_STATUSES = Object.freeze(['draft', 'generated', 'invalid', 'ready_for_test', 'testing', 'tested', 'rejected', 'candidate']);
const TEST_RUN_ENGINES = Object.freeze(['batch', 'replay', 'internal_preview', 'tradingview_import']);
const TEST_RUN_STATUSES = Object.freeze(['planned', 'running', 'completed', 'blocked', 'failed']);
const NEXT_ACTIONS = Object.freeze([
  'create_child_version',
  'run_more_tests',
  'reject_version',
  'hold_for_review',
  'request_human_review',
]);
const EVALUATION_VERDICTS = Object.freeze([
  'strong_candidate',
  'promising',
  'needs_improvement',
  'insufficient_data',
  'hold_for_review',
  'reject_version',
  'ready_for_human_review',
  'provider_error',
  'provider_response_invalid',
  'provider_or_test_data_unavailable',
]);
const VALIDATION_STATUSES = Object.freeze(['imported', 'matched', 'minor_differences', 'major_differences', 'invalid', 'needs_review']);
const COMPILE_STATUSES = Object.freeze(['not_checked', 'static_valid', 'static_invalid', 'external_validation_required']);
const DIRECTIONS = Object.freeze(['both', 'long_only', 'short_only']);

const CHANGE_FIELD_WHITELIST = Object.freeze([
  'direction',
  'openingRangeMinutes',
  'entryMode',
  'stopMode',
  'stopValue',
  'targetMode',
  'riskReward',
  'emaFilterEnabled',
  'emaLength',
  'volumeFilterEnabled',
  'volumeMultiplier',
  'lastEntryTime',
  'forcedCloseTime',
  'timezone',
  'session',
]);

const UNSAFE_KEY_RE = /(api_?key|authorization|password|passwd|secret|token|cookie|credential)/i;
const UNSAFE_TEXT_RE = /(live\s*trading|broker|place\s*order|placeorder|submit\s*order|submitorder|execute\s*order|execution\s*route|approval\s*mutation|auto[-_\s]*approve|make\s+ready|futures\s*paper\s*activation|paper\s*trading\s*activation|risk\s*mutation|shell\s*command|api\s*credential)/i;
const UNSAFE_SOURCE_RE = /(strategy\.order\s*\(|alert\s*\(|webhook|request\.seed\s*\(|lookahead_on|broker|placeorder|submitorder)/i;

function nowIso() {
  return new Date().toISOString();
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function hashValue(value) {
  return hashText(stableStringify(value));
}

function shortHash(value, length = 12) {
  return hashValue(value).slice(0, length);
}

function slug(value, fallback = 'item') {
  const out = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || fallback;
}

function makeId(prefix, parts) {
  const cleanPrefix = slug(prefix, 'id');
  const cleanParts = Array.isArray(parts) ? parts : [parts];
  const label = slug(cleanParts.filter(Boolean).join('_'), cleanPrefix);
  return `${cleanPrefix}_${label}_${shortHash(cleanParts, 8)}`;
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function compactObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, val]) => val !== undefined));
}

function stringValue(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

function numberValue(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => stringValue(item)).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function assertAllowed(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field}_is_invalid`);
  return value;
}

function isSafetyObject(value) {
  return value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'mode')
    && Object.prototype.hasOwnProperty.call(value, 'actions_allowed');
}

function assertSafeIntent(value, path = 'root') {
  if (value === null || value === undefined) return;
  if (typeof value === 'boolean') {
    if (['actions_allowed', 'can_place_orders', 'live_trading_enabled', 'broker_enabled'].some((key) => path.endsWith(`.${key}`)) && value === true) {
      throw new Error(`${path.split('.').pop()}_is_not_allowed`);
    }
    return;
  }
  if (typeof value === 'number') return;
  if (typeof value === 'string') {
    if (path.endsWith('.sourceCode')) {
      if (UNSAFE_SOURCE_RE.test(value)) throw new Error('source_contains_unsafe_code');
      return;
    }
    if (UNSAFE_TEXT_RE.test(value)) throw new Error('unsafe_intent_detected');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => assertSafeIntent(item, `${path}[${idx}]`));
    return;
  }
  if (typeof value === 'object') {
    if (isSafetyObject(value)) {
      if (value.mode && value.mode !== SAFETY.mode) throw new Error('mode_must_be_paper_only');
      if (value.actions_allowed === true) throw new Error('actions_allowed_is_not_allowed');
      if (value.can_place_orders === true) throw new Error('can_place_orders_is_not_allowed');
      if (value.live_trading_enabled === true) throw new Error('live_trading_enabled_is_not_allowed');
      if (value.broker_enabled === true) throw new Error('broker_enabled_is_not_allowed');
    }
    for (const [key, val] of Object.entries(value)) {
      if (UNSAFE_KEY_RE.test(key)) throw new Error('credential_field_is_not_allowed');
      assertSafeIntent(val, `${path}.${key}`);
    }
  }
}

function withSafety(value) {
  return {
    ...value,
    safety: { ...SAFETY },
  };
}

function normalizeRules(value) {
  return compactObject(clone(value) || {});
}

function defaultParameters(input = {}) {
  return {
    openingRangeMinutes: numberValue(input.openingRangeMinutes, 30),
    entryMode: stringValue(input.entryMode, 'breakout'),
    direction: assertAllowed(stringValue(input.direction, 'both'), DIRECTIONS, 'direction'),
    stopMode: stringValue(input.stopMode, 'range'),
    stopValue: numberValue(input.stopValue, 20),
    targetMode: stringValue(input.targetMode, 'risk_reward'),
    riskReward: numberValue(input.riskReward, 1.5),
    emaFilterEnabled: booleanValue(input.emaFilterEnabled, false),
    emaLength: numberValue(input.emaLength, 50),
    volumeFilterEnabled: booleanValue(input.volumeFilterEnabled, false),
    volumeMultiplier: numberValue(input.volumeMultiplier, 1.2),
    lastEntryTime: stringValue(input.lastEntryTime, '11:30'),
    forcedCloseTime: stringValue(input.forcedCloseTime, '15:55'),
    timezone: stringValue(input.timezone, 'America/New_York'),
    session: stringValue(input.session, '0930-1600'),
  };
}

function normalizeCandidate(input = {}) {
  assertSafeIntent(input);
  const baseStrategyId = slug(input.baseStrategyId || input.strategyId || 'research_strategy');
  const candidateId = stringValue(input.candidateId, makeId('candidate', [baseStrategyId, input.strategyName || input.hypothesis || 'research']));
  const createdAt = stringValue(input.createdAt, nowIso());
  return withSafety({
    candidateId,
    baseStrategyId,
    strategyName: stringValue(input.strategyName, baseStrategyId.replace(/_/g, ' ')),
    hypothesis: stringValue(input.hypothesis, 'Research candidate for isolated Pine/backtest validation.'),
    generationSource: stringValue(input.generationSource, 'manual'),
    status: assertAllowed(stringValue(input.status, 'draft'), CANDIDATE_STATUSES, 'candidate_status'),
    createdAt,
    updatedAt: stringValue(input.updatedAt, createdAt),
  });
}

function normalizeVersion(input = {}) {
  assertSafeIntent(input);
  const parameters = defaultParameters({ ...(input.parameters || {}), direction: input.direction || input.parameters?.direction });
  const baseStrategyId = slug(input.baseStrategyId || input.strategyId || 'research_strategy');
  const candidateId = stringValue(input.candidateId, makeId('candidate', [baseStrategyId]));
  const version = slug(input.version || input.name || 'v1');
  const pineVersionId = stringValue(input.pineVersionId, `${baseStrategyId}_${version}`);
  const sourceCode = input.sourceCode === null || input.sourceCode === undefined ? '' : String(input.sourceCode);
  const createdAt = stringValue(input.createdAt, nowIso());
  return withSafety({
    pineVersionId,
    candidateId,
    baseStrategyId,
    version,
    name: stringValue(input.name, version.replace(/_/g, ' ')),
    pineLanguageVersion: stringValue(input.pineLanguageVersion, 'v6'),
    sourceCode,
    sourceHash: stringValue(input.sourceHash, sourceCode ? hashText(sourceCode) : ''),
    parameterHash: stringValue(input.parameterHash, hashValue(parameters)),
    parameters,
    symbolRoots: stringArray(input.symbolRoots).length ? stringArray(input.symbolRoots) : ['MNQ', 'MES'],
    timeframes: stringArray(input.timeframes).length ? stringArray(input.timeframes) : ['1m', '5m', '15m'],
    sessionRules: normalizeRules(input.sessionRules),
    entryRules: normalizeRules(input.entryRules),
    exitRules: normalizeRules(input.exitRules),
    riskRules: normalizeRules(input.riskRules),
    direction: parameters.direction,
    parentVersionId: input.parentVersionId ? stringValue(input.parentVersionId) : null,
    generationSource: stringValue(input.generationSource, 'manual'),
    changeSummary: stringValue(input.changeSummary, 'Initial research version.'),
    compileStatus: assertAllowed(stringValue(input.compileStatus, sourceCode ? 'external_validation_required' : 'not_checked'), COMPILE_STATUSES, 'compile_status'),
    compileErrors: stringArray(input.compileErrors),
    validationWarnings: stringArray(input.validationWarnings),
    status: assertAllowed(stringValue(input.status, sourceCode ? 'generated' : 'draft'), VERSION_STATUSES, 'version_status'),
    reviewStatus: stringValue(input.reviewStatus, 'needs_human_review'),
    createdAt,
    updatedAt: stringValue(input.updatedAt, createdAt),
  });
}

function normalizeTestRun(input = {}) {
  assertSafeIntent(input);
  const parameters = compactObject(clone(input.parameters) || {});
  const createdAt = stringValue(input.createdAt, nowIso());
  const pineVersionId = stringValue(input.pineVersionId);
  const symbol = stringValue(input.symbol, 'MNQ').toUpperCase();
  const timeframe = stringValue(input.timeframe, '5m');
  const engine = assertAllowed(stringValue(input.engine, 'internal_preview'), TEST_RUN_ENGINES, 'test_run_engine');
  const testRunId = stringValue(input.testRunId, makeId('test_run', [pineVersionId, engine, symbol, timeframe, input.dateRange || createdAt]));
  return withSafety({
    testRunId,
    candidateId: stringValue(input.candidateId),
    pineVersionId,
    engine,
    symbol,
    timeframe,
    dateRange: compactObject(clone(input.dateRange) || { from: null, to: null }),
    parameters,
    parameterHash: stringValue(input.parameterHash, hashValue(parameters)),
    dataSource: stringValue(input.dataSource, 'internal_historical_data'),
    commission: numberValue(input.commission, 0),
    slippage: numberValue(input.slippage, 0),
    direction: assertAllowed(stringValue(input.direction, 'both'), DIRECTIONS, 'direction'),
    marketRegime: stringValue(input.marketRegime, 'unspecified'),
    session: stringValue(input.session, 'regular'),
    status: assertAllowed(stringValue(input.status, 'planned'), TEST_RUN_STATUSES, 'test_run_status'),
    parityStatus: stringValue(input.parityStatus, 'not_checked'),
    blockedReason: input.blockedReason ? stringValue(input.blockedReason) : null,
    supportedRules: stringArray(input.supportedRules),
    unsupportedRules: stringArray(input.unsupportedRules),
    parityMatrix: Array.isArray(input.parityMatrix) ? input.parityMatrix.slice(0, 50) : [],
    wouldRun: input.wouldRun === true,
    metrics: compactObject(clone(input.metrics) || {}),
    tradeCount: numberValue(input.tradeCount, 0),
    resultArtifact: input.resultArtifact ? stringValue(input.resultArtifact) : null,
    startedAt: input.startedAt ? stringValue(input.startedAt) : null,
    completedAt: input.completedAt ? stringValue(input.completedAt) : null,
    createdAt,
  });
}

function sanitizeRecommendedChanges(changes = []) {
  if (!Array.isArray(changes)) return [];
  return changes.slice(0, 12).map((change) => {
    const field = stringValue(change?.field);
    const operation = stringValue(change?.operation, 'set');
    if (!CHANGE_FIELD_WHITELIST.includes(field)) throw new Error('recommended_change_field_not_allowed');
    if (!['set', 'increase', 'decrease', 'disable', 'enable'].includes(operation)) throw new Error('recommended_change_operation_not_allowed');
    const safe = {
      field,
      operation,
      value: clone(change?.value),
      reason: stringValue(change?.reason, 'No reason supplied.'),
    };
    assertSafeIntent(safe);
    return safe;
  });
}

function normalizeEvaluation(input = {}) {
  assertSafeIntent(input);
  const createdAt = stringValue(input.createdAt, nowIso());
  const evaluationId = stringValue(input.evaluationId, makeId('evaluation', [input.pineVersionId, input.inputHash || createdAt]));
  const recommendedChanges = sanitizeRecommendedChanges(input.recommendedChanges);
  return withSafety({
    evaluationId,
    candidateId: stringValue(input.candidateId),
    pineVersionId: stringValue(input.pineVersionId),
    testRunIds: stringArray(input.testRunIds),
    verdict: assertAllowed(stringValue(input.verdict, 'hold_for_review'), EVALUATION_VERDICTS, 'evaluation_verdict'),
    score: Math.max(0, Math.min(100, numberValue(input.score, 0))),
    strengths: stringArray(input.strengths).slice(0, 12),
    weaknesses: stringArray(input.weaknesses).slice(0, 12),
    dataQualityWarnings: stringArray(input.dataQualityWarnings).slice(0, 12),
    overfitWarnings: stringArray(input.overfitWarnings).slice(0, 12),
    recommendedChanges,
    nextAction: assertAllowed(stringValue(input.nextAction, 'hold_for_review'), NEXT_ACTIONS, 'next_action'),
    confidence: Math.max(0, Math.min(1, numberValue(input.confidence, 0))),
    modelProvider: stringValue(input.modelProvider, 'unknown'),
    modelName: stringValue(input.modelName, 'unknown'),
    promptVersion: stringValue(input.promptVersion, 'pine_research_eval_v1'),
    inputHash: stringValue(input.inputHash, ''),
    outputHash: stringValue(input.outputHash, ''),
    rawResponseArtifact: input.rawResponseArtifact ? stringValue(input.rawResponseArtifact) : null,
    createdAt,
  });
}

function normalizeValidation(input = {}) {
  assertSafeIntent(input);
  const createdAt = stringValue(input.createdAt, nowIso());
  const validationId = stringValue(input.validationId, makeId('validation', [input.pineVersionId, input.internalTestRunId || createdAt]));
  return withSafety({
    validationId,
    candidateId: stringValue(input.candidateId),
    pineVersionId: stringValue(input.pineVersionId),
    internalTestRunId: input.internalTestRunId ? stringValue(input.internalTestRunId) : null,
    importSource: stringValue(input.importSource, 'tradingview_csv'),
    symbol: stringValue(input.symbol, '').toUpperCase(),
    timeframe: stringValue(input.timeframe, ''),
    tradesCsvArtifact: input.tradesCsvArtifact ? stringValue(input.tradesCsvArtifact) : null,
    performanceCsvArtifact: input.performanceCsvArtifact ? stringValue(input.performanceCsvArtifact) : null,
    tradingViewMetrics: compactObject(clone(input.tradingViewMetrics) || {}),
    internalMetrics: compactObject(clone(input.internalMetrics) || {}),
    differences: compactObject(clone(input.differences) || {}),
    validationStatus: assertAllowed(stringValue(input.validationStatus, 'needs_review'), VALIDATION_STATUSES, 'validation_status'),
    warnings: stringArray(input.warnings),
    importHash: input.importHash ? stringValue(input.importHash) : null,
    tradesPreview: Array.isArray(input.tradesPreview) ? input.tradesPreview.slice(0, 25) : [],
    createdAt,
  });
}

function validateWith(normalizer, input) {
  try {
    return { ok: true, value: normalizer(input), errors: [] };
  } catch (err) {
    return { ok: false, value: null, errors: [err?.message || String(err)] };
  }
}

module.exports = {
  SAFETY,
  CANDIDATE_STATUSES,
  VERSION_STATUSES,
  TEST_RUN_ENGINES,
  TEST_RUN_STATUSES,
  NEXT_ACTIONS,
  EVALUATION_VERDICTS,
  VALIDATION_STATUSES,
  COMPILE_STATUSES,
  DIRECTIONS,
  CHANGE_FIELD_WHITELIST,
  nowIso,
  stableStringify,
  hashText,
  hashValue,
  shortHash,
  slug,
  makeId,
  assertSafeIntent,
  withSafety,
  defaultParameters,
  normalizeCandidate,
  normalizeVersion,
  normalizeTestRun,
  normalizeEvaluation,
  normalizeValidation,
  validateCandidate: (input) => validateWith(normalizeCandidate, input),
  validateVersion: (input) => validateWith(normalizeVersion, input),
  validateTestRun: (input) => validateWith(normalizeTestRun, input),
  validateEvaluation: (input) => validateWith(normalizeEvaluation, input),
  validateValidation: (input) => validateWith(normalizeValidation, input),
};
