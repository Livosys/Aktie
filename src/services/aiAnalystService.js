'use strict';

/**
 * AI Analyst Layer v1
 * -------------------
 * Read-only Supervisor analyst. It can summarize sanitized overview data and
 * suggest safe paper/replay/batch learning tests. It never receives tools for
 * trading, files, shell, broker, orders, risk changes or live mode.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const supervisorOverviewService = require('./supervisorOverviewService');

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const SYSTEM_PROMPT = `
Du är AI Analyst för Trading OS Supervisor.

Du får bara analysera en säker, sanerad systemöversikt. Svara på svenska,
kort och enkelt. Du får aldrig ge live trading-råd, köp/sälj-instruktioner,
orderinstruktioner, riskändringar eller auto-apply-förslag.

Returnera endast giltig JSON med exakt denna form:
{
  "summary": "...",
  "what_ai_learned": ["..."],
  "best_strategy": "...",
  "weakest_strategy": "...",
  "risks": ["..."],
  "next_recommended_tests": ["..."],
  "questions_for_user": ["..."],
  "confidence": 0.0,
  "safety": {
    "mode": "paper_only",
    "actions_allowed": false,
    "can_place_orders": false,
    "live_trading_enabled": false,
    "broker_enabled": false
  }
}
`.trim();

const FORBIDDEN_KEY_RE = /(secret|token|password|passwd|api_?key|authorization|cookie|env|credential|private|broker|order|live_endpoint|server_path|path|raw_log|raw|stack)/i;
const MAX_ARRAY = 25;
const MAX_DEPTH = 5;
const MAX_TEXT = 800;

function nowIso() { return new Date().toISOString(); }
function provider() { return String(process.env.AI_ANALYST_PROVIDER || 'disabled').trim().toLowerCase() || 'disabled'; }
function modelForProvider(p = provider()) {
  if (process.env.AI_ANALYST_MODEL) return process.env.AI_ANALYST_MODEL;
  if (p === 'anthropic') return 'claude-3-5-haiku-latest';
  return 'gpt-4o-mini';
}
function timeoutMs() {
  const n = Number(process.env.AI_ANALYST_TIMEOUT_MS || 15000);
  return Number.isFinite(n) ? Math.max(1000, Math.min(60000, n)) : 15000;
}
function cacheTtlMs() {
  const n = Number(process.env.AI_ANALYST_CACHE_TTL_MS || 300000);
  return Number.isFinite(n) ? Math.max(0, n) : 300000;
}
function dataDir() {
  return process.env.AI_ANALYST_DIR
    ? path.resolve(process.env.AI_ANALYST_DIR)
    : path.resolve(__dirname, '../../data/ai-analyst');
}
function latestFile() { return path.join(dataDir(), 'latest.json'); }
function eventsFile() { return path.join(dataDir(), 'analyst-events.jsonl'); }
function ensureDir() { fs.mkdirSync(dataDir(), { recursive: true }); }

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function safeWriteJson(file, value) {
  try {
    writeJson(file, value);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function safeAppendEvent(event) {
  try {
    ensureDir();
    fs.appendFileSync(eventsFile(), JSON.stringify(event) + '\n', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function fileExists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

function lineCount(file, maxBytes = 1024 * 1024) {
  try {
    if (!fs.existsSync(file)) return 0;
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter(Boolean).length;
  } catch (_) {
    return null;
  }
}

function text(value, fallback = '') {
  const out = String(value ?? '').replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, MAX_TEXT) : fallback;
}

function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function safePrimitive(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value);
  return undefined;
}

function sanitizeValue(value, depth = 0) {
  const primitive = safePrimitive(value);
  if (primitive !== undefined) return primitive;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, depth + 1)).filter((v) => v !== undefined);
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_KEY_RE.test(key)) continue;
    const clean = sanitizeValue(val, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function compactBlocks(blocks = {}) {
  const pickBlock = (key) => {
    const b = blocks[key];
    if (!b) return null;
    return sanitizeValue({
      status: b.status,
      source: b.source,
      summary: b.summary,
      error: b.status === 'error' ? b.error : null,
    });
  };
  return {
    system_health: pickBlock('system_health'),
    learning: pickBlock('learning'),
    strategies: pickBlock('strategies'),
    narrow: pickBlock('narrow'),
    autopilot: pickBlock('autopilot'),
    priority: pickBlock('priority'),
    daily_pipeline: pickBlock('daily_pipeline'),
    ai_optimization: pickBlock('ai_optimization'),
    operations_advisor: pickBlock('operations_advisor'),
  };
}

function sanitizeContext(overview = {}) {
  const blocks = overview.blocks || {};
  const narrowSummary = blocks.narrow?.summary || {};
  const strategySummary = blocks.strategies?.summary || {};
  const learningSummary = blocks.learning?.summary || {};
  const autopilotSummary = blocks.autopilot?.summary || {};
  const recommendation = overview.actionPlan?.[0] || narrowSummary.recommendedNextTest || null;

  return sanitizeValue({
    generatedAt: overview.generatedAt || nowIso(),
    safety: {
      mode: overview.mode || SAFETY.mode,
      actions_allowed: overview.actions_allowed === true ? false : false,
      can_place_orders: overview.can_place_orders === true ? false : false,
      live_trading_enabled: overview.live_trading_enabled === true ? false : false,
      broker_enabled: overview.broker_enabled === true ? false : false,
    },
    canonicalStats: overview.canonicalStats || null,
    autopilotStatus: autopilotSummary,
    recentTestsSummary: {
      status: overview.recentTestsStatus?.status || null,
      count: overview.recentTestsStatus?.count ?? arr(overview.recentTests).length,
      latest: arr(overview.recentTests).slice(0, 8).map((t) => ({
        type: t.type,
        timestamp: t.timestamp,
        strategy: t.strategy,
        symbol: t.symbol,
        timeframe: t.timeframe,
        scoreBand: t.scoreBand,
        dryRun: t.dryRun,
        executed: t.executed,
        blockedReason: t.blockedReason,
        tradesCount: t.tradesCount,
        winRate: t.winRate,
        avgResult: t.avgResult,
      })),
    },
    batchSummary: overview.batchSummary || null,
    strategySummary,
    learningSummary,
    narrowSummary,
    risks: arr(overview.risks).slice(0, 12),
    blockers: arr(overview.risks).filter((r) => /block|risk|error|warning/i.test(`${r?.code || ''} ${r?.level || ''}`)).slice(0, 8),
    nextRecommendation: recommendation,
    blocks: compactBlocks(blocks),
  });
}

function inputMetadata(context) {
  return {
    generatedAt: context.generatedAt || null,
    recentTestsCount: context.recentTestsSummary?.count ?? 0,
    riskCount: arr(context.risks).length,
    hasBatchSummary: !!context.batchSummary,
    hasLearningSummary: !!context.learningSummary,
    hasNarrowSummary: !!context.narrowSummary,
  };
}

function outputMetadata(output) {
  const o = output || {};
  return {
    hasSummary: !!o.summary,
    learnedCount: arr(o.what_ai_learned).length,
    riskCount: arr(o.risks).length,
    nextTestCount: arr(o.next_recommended_tests).length,
    questionCount: arr(o.questions_for_user).length,
    confidence: Number.isFinite(Number(o.confidence)) ? Number(o.confidence) : null,
    safety: { ...SAFETY },
  };
}

function safeErrorMessage(value) {
  return text(value, '').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>');
}

function analystEvent({
  eventType,
  provider: eventProvider,
  model,
  status,
  durationMs,
  cacheHit = false,
  disabled = false,
  errorCode = null,
  errorMessage = null,
  inputSummary = null,
  output = null,
}) {
  return {
    timestamp: nowIso(),
    eventType,
    provider: eventProvider,
    model: model || null,
    status,
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    cacheHit: cacheHit === true,
    disabled: disabled === true,
    errorCode: errorCode || null,
    errorMessage: errorMessage ? safeErrorMessage(errorMessage).slice(0, 300) : null,
    inputSummary: inputSummary || null,
    outputSummary: outputMetadata(output),
    safety: { ...SAFETY },
    ...SAFETY,
  };
}

function defaultOutput(overrides = {}) {
  return {
    summary: 'AI Analyst är inte konfigurerad ännu. Systemet är kvar i säkert paper-only-läge.',
    what_ai_learned: [],
    best_strategy: 'För lite AI-analys ännu.',
    weakest_strategy: 'För lite AI-analys ännu.',
    risks: ['AI Analyst får bara läsa säker sammanfattning och kan inte ändra systemet.'],
    next_recommended_tests: ['Fortsätt samla paper/replay/batch-resultat innan slutsatser dras.'],
    questions_for_user: [],
    confidence: 0,
    ...overrides,
    safety: { ...SAFETY, ...(overrides.safety || {}) },
  };
}

function normalizeOutput(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return defaultOutput({
    summary: text(obj.summary, 'AI Analyst kunde inte skapa en tydlig sammanfattning.'),
    what_ai_learned: arr(obj.what_ai_learned).map((v) => text(v)).filter(Boolean).slice(0, 8),
    best_strategy: text(obj.best_strategy, 'För lite data.'),
    weakest_strategy: text(obj.weakest_strategy, 'För lite data.'),
    risks: arr(obj.risks).map((v) => text(v)).filter(Boolean).slice(0, 8),
    next_recommended_tests: arr(obj.next_recommended_tests).map((v) => text(v)).filter(Boolean).slice(0, 8),
    questions_for_user: arr(obj.questions_for_user).map((v) => text(v)).filter(Boolean).slice(0, 5),
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
  });
}

function parseAnalystJson(content) {
  if (content && typeof content === 'object') return normalizeOutput(content);
  const raw = String(content || '').trim();
  if (!raw) return normalizeOutput(null);
  try {
    return normalizeOutput(JSON.parse(raw));
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return normalizeOutput(JSON.parse(match[0])); } catch (_) {}
    }
  }
  return defaultOutput({
    summary: text(raw, 'AI Analyst returnerade text som inte var JSON.'),
    what_ai_learned: ['Svaret normaliserades med säker fallback eftersom JSON-format saknades.'],
    confidence: 0.2,
  });
}

function openAiKey() {
  return process.env.AI_ANALYST_API_KEY || process.env.AI_API_KEY || '';
}

function anthropicKey() {
  return process.env.AI_ANALYST_API_KEY || process.env.AI_ANALYST_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
}

async function callOpenAi(context) {
  const key = openAiKey();
  if (!key) {
    const err = new Error('AI Analyst OpenAI provider saknar API-nyckel.');
    err.code = 'missing_key';
    throw err;
  }
  const res = await axios.post(process.env.AI_ANALYST_BASE_URL || process.env.AI_BASE_URL || DEFAULT_OPENAI_URL, {
    model: modelForProvider('openai'),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(context, null, 2) },
    ],
    temperature: 0.1,
    max_tokens: 900,
  }, {
    timeout: timeoutMs(),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });
  return res.data?.choices?.[0]?.message?.content || '';
}

async function callAnthropic(context) {
  const key = anthropicKey();
  if (!key) {
    const err = new Error('AI Analyst Anthropic provider saknar API-nyckel.');
    err.code = 'missing_key';
    throw err;
  }
  const res = await axios.post(process.env.AI_ANALYST_ANTHROPIC_URL || DEFAULT_ANTHROPIC_URL, {
    model: modelForProvider('anthropic'),
    max_tokens: 900,
    temperature: 0.1,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(context, null, 2) }],
  }, {
    timeout: timeoutMs(),
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
  });
  return arr(res.data?.content).map((part) => part?.text || '').join('\n');
}

function disabledResponse() {
  return {
    ok: true,
    status: 'disabled',
    provider: 'disabled',
    model: null,
    cached: false,
    generatedAt: nowIso(),
    output: defaultOutput({
      summary: 'AI Analyst är avstängd. Sätt AI_ANALYST_PROVIDER=openai eller anthropic för manuell read-only analys.',
      risks: ['AI Analyst är disabled, så inga externa AI-anrop görs.'],
      questions_for_user: ['Vill du aktivera OpenAI eller Anthropic som read-only analyst-provider?'],
    }),
    ...SAFETY,
  };
}

function getLatestAnalysis() {
  const latest = readJson(latestFile(), null);
  if (!latest) {
    return {
      ok: true,
      status: 'empty',
      latest: null,
      cache: { hit: false, ttlMs: cacheTtlMs(), ageMs: null, fresh: false },
      ...SAFETY,
    };
  }
  const ageMs = Math.max(0, Date.now() - new Date(latest.generatedAt || latest.timestamp || 0).getTime());
  return {
    ok: true,
    status: latest.status || 'ok',
    latest,
    cache: { hit: false, ttlMs: cacheTtlMs(), ageMs, fresh: ageMs <= cacheTtlMs() },
    ...SAFETY,
  };
}

function getStatus() {
  const p = provider();
  const latest = getLatestAnalysis();
  const enabled = p === 'openai' ? !!openAiKey() : p === 'anthropic' ? !!anthropicKey() : false;
  const latestPayload = latest.latest || null;
  const latestTimestamp = latestPayload?.generatedAt || latestPayload?.timestamp || null;
  const lastError = latestPayload?.error
    ? safeErrorMessage(latestPayload.error).slice(0, 300)
    : (['error', 'missing_key'].includes(latestPayload?.status) ? latestPayload?.status : null);
  return {
    ok: true,
    provider: p,
    enabled,
    model: p === 'disabled' ? null : modelForProvider(p),
    cacheEnabled: cacheTtlMs() > 0,
    cacheTtlMs: cacheTtlMs(),
    latestExists: !!latestPayload,
    latestTimestamp,
    latestStatus: latest.status,
    latestProvider: latestPayload?.provider || null,
    latestDurationMs: latestPayload?.durationMs ?? null,
    logPathExists: fileExists(eventsFile()),
    logEventCount: lineCount(eventsFile()),
    lastError,
    latestGeneratedAt: latest.latest?.generatedAt || null,
    cache: latest.cache,
    supportedProviders: ['disabled', 'openai', 'anthropic'],
    ...SAFETY,
  };
}

async function runAnalyst(options = {}) {
  const started = Date.now();
  const p = provider();
  if (!['disabled', 'openai', 'anthropic'].includes(p)) {
    const result = {
      ok: false,
      status: 'error',
      provider: p,
      error: 'unsupported_provider',
      message: 'AI_ANALYST_PROVIDER måste vara disabled, openai eller anthropic.',
      ...SAFETY,
    };
    safeAppendEvent(analystEvent({
      eventType: 'analyst.run.rejected',
      provider: p,
      model: null,
      status: 'error',
      durationMs: Date.now() - started,
      errorCode: 'unsupported_provider',
      errorMessage: result.message,
      output: defaultOutput({ summary: result.message }),
    }));
    return result;
  }

  if (p === 'disabled') {
    const response = disabledResponse();
    const durationMs = Date.now() - started;
    const event = analystEvent({
      eventType: 'analyst.run.disabled',
      provider: p,
      model: null,
      status: 'disabled',
      durationMs,
      disabled: true,
      output: response.output,
    });
    safeAppendEvent(event);
    safeWriteJson(latestFile(), { ...response, generatedAt: event.timestamp, durationMs });
    return { ...response, generatedAt: event.timestamp, durationMs };
  }

  const latest = getLatestAnalysis();
  if (!options.force && latest.latest && latest.cache?.fresh) {
    safeAppendEvent(analystEvent({
      eventType: 'analyst.run.cache_hit',
      provider: latest.latest.provider || p,
      model: latest.latest.model || modelForProvider(p),
      status: latest.latest.status || 'ok',
      durationMs: Date.now() - started,
      cacheHit: true,
      inputSummary: latest.latest.input || null,
      output: latest.latest.output || null,
    }));
    return {
      ...latest.latest,
      ok: true,
      cached: true,
      cache: latest.cache,
      ...SAFETY,
    };
  }

  let context = null;
  let output = null;
  let status = 'ok';
  let error = null;
  let errorCode = null;

  try {
    const overview = options.overview || await supervisorOverviewService.getCachedOverview({ force: options.force === true });
    context = sanitizeContext(overview);
    const content = p === 'openai' ? await callOpenAi(context) : await callAnthropic(context);
    output = parseAnalystJson(content);
  } catch (err) {
    status = err.code === 'missing_key' ? 'missing_key' : 'error';
    errorCode = err.code || status;
    error = err && err.message ? safeErrorMessage(err.message) : safeErrorMessage(String(err));
    output = defaultOutput({
      summary: status === 'missing_key'
        ? `AI Analyst provider ${p} saknar API-nyckel. Ingen extern analys kördes.`
        : 'AI Analyst misslyckades men systemet är oförändrat och paper-only.',
      risks: [status === 'missing_key' ? 'Provider saknar nyckel.' : 'AI-anropet misslyckades.'],
      confidence: 0,
    });
  }

  const generatedAt = nowIso();
  const result = {
    ok: status === 'ok',
    status,
    provider: p,
    model: modelForProvider(p),
    generatedAt,
    cached: false,
    input: context ? inputMetadata(context) : null,
    output,
    error,
    durationMs: Date.now() - started,
    ...SAFETY,
  };

  safeAppendEvent(analystEvent({
    eventType: status === 'ok' ? 'analyst.run.completed' : 'analyst.run.failed',
    provider: p,
    model: result.model,
    status,
    durationMs: result.durationMs,
    cacheHit: false,
    errorCode,
    errorMessage: error,
    inputSummary: result.input,
    output,
  }));
  safeWriteJson(latestFile(), result);
  return result;
}

module.exports = {
  SAFETY,
  SYSTEM_PROMPT,
  getStatus,
  getLatestAnalysis,
  runAnalyst,
  sanitizeContext,
  parseAnalystJson,
  normalizeOutput,
  disabledResponse,
};
