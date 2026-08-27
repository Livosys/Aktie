'use strict';

const replayQueue = require('./replayQueueService');
const strategyRegistry = require('./strategyRegistryService');
const strategyScore = require('./strategyScoreService');
const strategyHistory = require('./strategyHistoryService');
const dataCoverage = require('./dataCoverageExpansionService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  paper_only: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  scheduler_runs_replay: false,
});

const DEFAULT_SYMBOLS = Object.freeze({
  crypto: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  stocks: ['QQQ', 'SPY', 'NVDA'],
  index: ['QQQ', 'SPY'],
  etf: ['QQQ', 'SPY'],
  nasdaq100: ['QQQ', 'NVDA', 'MSFT'],
  sp500: ['SPY', 'AAPL', 'MSFT'],
  unknown: ['QQQ', 'SPY'],
});

const MODE_BOOST = Object.freeze({
  manual: 100,
  coverage: 22,
  confidence: 18,
  regression: 14,
  evolution: 16,
  optimizer: 12,
});

function nowIso() {
  return new Date().toISOString();
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function safeString(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = safeNumber(value, min);
  return Math.max(min, Math.min(max, n));
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : {};
  } catch (_) {
    return {};
  }
}

function normalizeSymbols(value) {
  const symbols = Array.isArray(value)
    ? value
    : (value == null || value === '' ? [] : String(value).split(','));
  return [...new Set(symbols
    .map((symbol) => safeString(symbol).toUpperCase())
    .filter(Boolean))]
    .sort();
}

function normalizeDate(value) {
  const text = safeString(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function defaultPeriod(now = nowIso(), days = 30) {
  const end = normalizeDate(now) || nowIso().slice(0, 10);
  return {
    start: addDays(end, -Math.max(1, days) + 1),
    end,
  };
}

function daysSince(value, now) {
  const iso = normalizeDate(value);
  const today = normalizeDate(now);
  if (!iso || !today) return null;
  const a = new Date(`${iso}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

function normalizeStatus(value) {
  return safeString(value || 'paper_only').toLowerCase();
}

function normalizeSource(value) {
  return safeString(value || 'internal').toLowerCase();
}

function strategyIdOf(row = {}) {
  return safeString(row.strategy_id || row.strategyId || row.id || row.strategy?.id || row.name);
}

function scoreStrategyIdOf(row = {}) {
  return safeString(row.strategy_id || row.strategyId || row.id);
}

function inferMarketGroup(strategy = {}, score = {}, gap = {}) {
  gap = gap || {};
  const direct = safeString(
    gap.market_group ||
    gap.marketGroup ||
    strategy.market_group ||
    strategy.marketGroup ||
    strategy.market ||
    score.market_group ||
    score.marketGroup,
  ).toLowerCase();
  if (direct) return direct;
  const tags = [
    ...safeArray(strategy.market_regime_tags),
    ...safeArray(strategy.tags),
    ...safeArray(gap.tags),
    ...normalizeSymbols(gap.symbols || strategy.symbols || strategy.symbol),
  ].map((tag) => String(tag).toLowerCase());
  if (tags.some((tag) => tag.includes('crypto') || tag.endsWith('usdt'))) return 'crypto';
  if (tags.some((tag) => tag.includes('nasdaq'))) return 'nasdaq100';
  if (tags.some((tag) => tag.includes('sp500') || tag.includes('s&p'))) return 'sp500';
  if (tags.some((tag) => tag.includes('etf') || tag === 'qqq' || tag === 'spy')) return 'etf';
  return 'unknown';
}

function inferSymbols(strategy = {}, score = {}, gap = {}) {
  gap = gap || {};
  const direct = normalizeSymbols(
    gap.symbols ||
    gap.symbol ||
    gap.tickers ||
    strategy.symbols ||
    strategy.symbol ||
    strategy.tickers ||
    score.symbols ||
    score.symbol,
  );
  if (direct.length) return direct.slice(0, 6);
  const marketGroup = inferMarketGroup(strategy, score, gap);
  return [...(DEFAULT_SYMBOLS[marketGroup] || DEFAULT_SYMBOLS.unknown)].sort();
}

function coverageBySymbol(rows = []) {
  const out = new Map();
  for (const row of safeArray(rows)) {
    const symbol = safeString(row.symbol).toUpperCase();
    if (!symbol) continue;
    out.set(symbol, row);
  }
  return out;
}

function coverageForSymbols(symbols = [], coverageRows = []) {
  const bySymbol = coverageBySymbol(coverageRows);
  return normalizeSymbols(symbols).map((symbol) => {
    const row = bySymbol.get(symbol) || {};
    return {
      symbol,
      data_quality: row.data_quality || 'unknown',
      coverage_score: safeNumber(row.coverage_score, 0),
      usable_for_replay: row.usable_for_replay === true,
      days_covered: safeNumber(row.days_covered, 0),
      candles_count: safeNumber(row.candles_count, 0),
      reason: row.reason || null,
    };
  });
}

function coverageComponent(symbolCoverage = []) {
  if (!symbolCoverage.length) return 10;
  const ready = symbolCoverage.filter((row) => row.usable_for_replay).length;
  const weak = symbolCoverage.filter((row) => ['weak', 'medium', 'missing', 'missing_provider', 'unknown'].includes(String(row.data_quality))).length;
  return Math.round(clamp((ready / symbolCoverage.length) * 12 + (weak / symbolCoverage.length) * 14, 0, 22));
}

function severityScore(severity) {
  const raw = safeString(severity).toLowerCase();
  if (raw === 'critical') return 38;
  if (raw === 'high') return 30;
  if (raw === 'medium') return 20;
  if (raw === 'low') return 10;
  return 16;
}

function modeFromRecommendedTests(strategy = {}, score = {}, history = {}) {
  const tests = [
    ...safeArray(strategy.recommended_tests),
    safeString(score.recommended_action),
    ...safeArray(score.weaknesses),
    ...safeArray(history.notes),
  ].join(' ').toLowerCase();
  const summary = history.history_summary || {};
  const replayCount = safeNumber(summary.replay_tests_count, 0);
  const batchCount = safeNumber(summary.batch_tests_count, 0);
  const confidence = safeNumber(score.confidence, 100);
  const sampleSize = safeNumber(score.sample_size, 0);

  if (tests.includes('optimizer') || tests.includes('parameter') || tests.includes('batch')) return 'optimizer';
  if (tests.includes('evolution') || tests.includes('förbät') || tests.includes('improv')) return 'evolution';
  if (replayCount > 0 && (tests.includes('regression') || sampleSize >= 20)) return 'regression';
  if (confidence < 50 || sampleSize < 10) return 'confidence';
  if (replayCount === 0 || batchCount === 0) return 'coverage';
  return 'regression';
}

function modeFromGap(gap = {}) {
  const explicit = safeString(gap.replay_mode || gap.replayMode || gap.mode).toLowerCase();
  if (replayQueue.VALID_REPLAY_MODES.has(explicit)) return explicit;
  const type = safeString(gap.type || gap.gap_type || gap.reason).toLowerCase();
  if (type.includes('manual')) return 'manual';
  if (type.includes('regression')) return 'regression';
  if (type.includes('evolution') || type.includes('variant')) return 'evolution';
  if (type.includes('optimizer') || type.includes('parameter') || type.includes('batch')) return 'optimizer';
  if (type.includes('coverage') || type.includes('data')) return 'coverage';
  return 'confidence';
}

function informationGainPriority({
  mode,
  score,
  history,
  gap,
  symbolCoverage,
  now,
}) {
  const summary = history?.history_summary || {};
  const sampleSize = safeNumber(score?.sample_size, 0);
  const confidence = safeNumber(score?.confidence, 50);
  const replayCount = safeNumber(summary.replay_tests_count, 0);
  const paperCount = safeNumber(summary.paper_trades_count, 0);
  const batchCount = safeNumber(summary.batch_tests_count, 0);
  const lastReplayAge = daysSince(summary.last_replay_at, now);

  const components = {
    mode_signal: MODE_BOOST[mode] || 0,
    knowledge_gap: gap ? severityScore(gap.severity) : 0,
    missing_replay: replayCount === 0 ? 24 : 0,
    missing_batch: batchCount === 0 && mode === 'optimizer' ? 10 : 0,
    paper_without_replay: paperCount > 0 && replayCount === 0 ? 14 : 0,
    low_sample_size: sampleSize < 10 ? 18 : sampleSize < 30 ? 8 : 0,
    low_confidence: confidence < 40 ? 18 : confidence < 55 ? 10 : 0,
    stale_replay: lastReplayAge == null ? 0 : Math.min(10, Math.floor(lastReplayAge / 14)),
    coverage_gap: coverageComponent(symbolCoverage),
  };
  const scoreValue = Math.round(clamp(Object.values(components).reduce((sum, value) => sum + safeNumber(value, 0), 0), 0, 100));
  return {
    score: scoreValue,
    metric: 'information_gain',
    components,
    win_rate_used: false,
  };
}

function reasonFor({ strategy, score, history, mode, gap, symbolCoverage }) {
  if (gap) {
    return [
      safeString(gap.reason || gap.description || gap.type || 'Knowledge gap'),
      `mode=${mode}`,
      `strategy=${strategy.strategy_id || strategy.id}`,
    ].filter(Boolean).join(' · ');
  }
  const summary = history?.history_summary || {};
  const pieces = [
    `${strategy.strategy_id || strategy.id}: information-gain replay`,
    `mode=${mode}`,
    `confidence=${safeNumber(score?.confidence, 0)}`,
    `sample_size=${safeNumber(score?.sample_size, 0)}`,
    `replay_tests=${safeNumber(summary.replay_tests_count, 0)}`,
  ];
  const weakSymbols = safeArray(symbolCoverage)
    .filter((row) => row.usable_for_replay !== true || ['weak', 'medium', 'missing', 'missing_provider', 'unknown'].includes(String(row.data_quality)))
    .map((row) => row.symbol)
    .slice(0, 4);
  if (weakSymbols.length) pieces.push(`coverage_gap=${weakSymbols.join(',')}`);
  const action = safeString(score?.recommended_action);
  if (action) pieces.push(`recommended_action=${action}`);
  return pieces.join(' · ');
}

function buildJob({ strategy, score, history, gap, coverageRows, now, requestedBy, periodDays }) {
  const id = strategyIdOf(strategy) || strategyIdOf(gap);
  if (!id) return null;
  const symbols = inferSymbols(strategy, score, gap);
  if (!symbols.length) return null;
  const mode = gap ? modeFromGap(gap) : modeFromRecommendedTests(strategy, score, history);
  const marketGroup = inferMarketGroup(strategy, score, gap);
  const symbolCoverage = coverageForSymbols(symbols, coverageRows);
  const requestedPeriod = gap?.period || gap?.Period || null;
  const period = requestedPeriod && normalizeDate(requestedPeriod.start || requestedPeriod.date_from)
    ? {
      start: normalizeDate(requestedPeriod.start || requestedPeriod.date_from),
      end: normalizeDate(requestedPeriod.end || requestedPeriod.date_to) || normalizeDate(now),
    }
    : defaultPeriod(now, periodDays);
  const marketDna = {
    symbols,
    market_group: marketGroup,
    timeframe: safeString(gap?.timeframe || strategy.timeframe || '2m').toLowerCase(),
    dna_tags: [
      ...safeArray(strategy.market_regime_tags),
      ...safeArray(strategy.tags),
      ...safeArray(gap?.tags),
      mode,
    ].map((tag) => safeString(tag).toLowerCase()).filter(Boolean).sort(),
    coverage: {
      symbols: symbolCoverage,
      ready_count: symbolCoverage.filter((row) => row.usable_for_replay).length,
      weak_count: symbolCoverage.filter((row) => row.usable_for_replay !== true).length,
    },
  };
  const priority = informationGainPriority({
    mode,
    score,
    history,
    gap,
    symbolCoverage,
    now,
  });
  return {
    strategy: {
      id,
      name: safeString(strategy.strategy_name || strategy.name || gap?.strategy_name || id),
      source: normalizeSource(strategy.source || score?.source || gap?.source),
      status: normalizeStatus(strategy.status || score?.status || gap?.status),
    },
    market_dna: marketDna,
    replay_mode: mode,
    period,
    execution_model: {
      engine: 'replayEngine',
      engine_mode: safeString(gap?.engine_mode || gap?.execution_model?.engine_mode || 'scan_only').toLowerCase(),
      timeframe: marketDna.timeframe,
      paper_only: true,
      live_trading_disabled: true,
      scheduler_runs_replay: false,
      queue_invokes_engine: true,
    },
    priority,
    reason: reasonFor({ strategy: { ...strategy, strategy_id: id }, score, history, mode, gap, symbolCoverage }),
    requested_by: safeString(gap?.requested_by || gap?.requestedBy || requestedBy, 'Strategy Brain'),
  };
}

function sortJobs(a, b) {
  return safeNumber(b.priority?.score, 0) - safeNumber(a.priority?.score, 0)
    || String(a.replay_mode).localeCompare(String(b.replay_mode))
    || String(a.strategy?.id).localeCompare(String(b.strategy?.id))
    || (a.market_dna?.symbols || []).join(',').localeCompare((b.market_dna?.symbols || []).join(','));
}

function dedupeJobs(jobs = []) {
  const byId = new Map();
  for (const input of safeArray(jobs)) {
    const normalized = replayQueue._internal.normalizeJob(input);
    if (!normalized.ok) continue;
    if (!byId.has(normalized.job.id)) byId.set(normalized.job.id, normalized.job);
  }
  return [...byId.values()].sort(sortJobs);
}

function config() {
  return {
    enabled: bool(process.env.ENABLE_REPLAY_SCHEDULER, false),
    intervalMinutes: clampInt(process.env.REPLAY_SCHEDULER_INTERVAL_MINUTES, 360, 15, 24 * 60),
    maxJobsPerRun: clampInt(process.env.REPLAY_SCHEDULER_MAX_JOBS_PER_RUN, 10, 1, 100),
    periodDays: clampInt(process.env.REPLAY_SCHEDULER_PERIOD_DAYS, 30, 2, 365),
  };
}

function createReplaySchedulerService(options = {}) {
  const queueService = options.queueService || replayQueue.defaultReplayQueueService;
  const registryService = options.registryService || strategyRegistry;
  const scoreService = options.scoreService || strategyScore.defaultStrategyScoreService;
  const historyService = options.historyService || strategyHistory.defaultStrategyHistoryService;
  const coverageService = options.coverageService || dataCoverage;
  const nowFn = typeof options.now === 'function' ? options.now : nowIso;

  function serviceNowIso() {
    const value = nowFn();
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : nowIso();
  }

  function loadStrategies(explicit) {
    if (Array.isArray(explicit)) return explicit;
    try {
      if (typeof registryService.listStrategies === 'function') return registryService.listStrategies() || [];
    } catch (_) {}
    return [];
  }

  function loadScores(explicit) {
    if (Array.isArray(explicit)) return explicit;
    try {
      const status = typeof scoreService.getStrategyScores === 'function' ? scoreService.getStrategyScores() : null;
      return safeArray(status?.strategies);
    } catch (_) {
      return [];
    }
  }

  function loadHistory(strategyId, explicit) {
    if (explicit && Object.prototype.hasOwnProperty.call(explicit, strategyId)) return explicit[strategyId];
    try {
      if (typeof historyService.getStrategyHistory === 'function') return historyService.getStrategyHistory(strategyId);
    } catch (_) {}
    return null;
  }

  function loadCoverage(explicit) {
    if (Array.isArray(explicit)) return explicit;
    try {
      if (typeof coverageService.getAllSymbolCoverage === 'function') return safeArray(coverageService.getAllSymbolCoverage()?.symbols);
    } catch (_) {}
    return [];
  }

  function buildSchedule(input = {}) {
    const now = safeString(input.now || serviceNowIso());
    const cfg = { ...config(), ...(input.config || {}) };
    const requestedBy = safeString(input.requestedBy || input.requested_by || 'Strategy Brain');
    const strategies = loadStrategies(input.strategies);
    const scores = loadScores(input.scores);
    const scoreById = new Map(scores.map((row) => [scoreStrategyIdOf(row), row]).filter(([id]) => id));
    const coverageRows = loadCoverage(input.coverage);
    const jobs = [];

    for (const gap of safeArray(input.knowledgeGaps || input.knowledge_gaps)) {
      const id = strategyIdOf(gap);
      const strategy = strategies.find((row) => strategyIdOf(row) === id) || {
        strategy_id: id || 'knowledge_gap',
        strategy_name: safeString(gap.strategy_name || gap.name || id || 'Knowledge Gap'),
        source: safeString(gap.source || 'strategy_brain'),
        status: safeString(gap.status || 'paper_only'),
      };
      const score = scoreById.get(strategyIdOf(strategy)) || safeObject(gap.score);
      const history = loadHistory(strategyIdOf(strategy), input.histories) || safeObject(gap.history);
      const job = buildJob({
        strategy,
        score,
        history,
        gap,
        coverageRows,
        now,
        requestedBy,
        periodDays: cfg.periodDays,
      });
      if (job) jobs.push(job);
    }

    for (const strategy of strategies) {
      const id = strategyIdOf(strategy);
      if (!id) continue;
      const status = normalizeStatus(strategy.status);
      if (strategy.enabled === false || status === 'deprecated') continue;
      const score = scoreById.get(id) || {};
      const history = loadHistory(id, input.histories) || {};
      const summary = history.history_summary || {};
      const hasGap = safeNumber(summary.replay_tests_count, 0) === 0
        || safeNumber(score.sample_size, 0) < 10
        || safeNumber(score.confidence, 100) < 55
        || safeArray(score.weaknesses).length > 0
        || safeString(score.recommended_action).toLowerCase().includes('replay')
        || safeArray(strategy.recommended_tests).length > 0;
      if (!hasGap) continue;
      const job = buildJob({
        strategy,
        score,
        history,
        gap: null,
        coverageRows,
        now,
        requestedBy,
        periodDays: cfg.periodDays,
      });
      if (job) jobs.push(job);
    }

    const manualJobs = safeArray(input.manualJobs || input.manual_jobs)
      .map((job) => ({
        ...job,
        replay_mode: 'manual',
        requested_by: safeString(job.requested_by || job.requestedBy || requestedBy, requestedBy),
        priority: job.priority || { score: 100, metric: 'information_gain', components: { manual_request: 100 }, win_rate_used: false },
      }));

    const deduped = dedupeJobs([...manualJobs, ...jobs]).slice(0, cfg.maxJobsPerRun);
    return {
      ok: true,
      generated_at: now,
      scheduler: 'Replay Scheduler',
      scheduler_runs_replay: false,
      prioritizes: 'information_gain',
      win_rate_used_for_priority: false,
      jobs: deduped,
      summary: {
        total_jobs: deduped.length,
        by_mode: deduped.reduce((acc, job) => {
          acc[job.replay_mode] = (acc[job.replay_mode] || 0) + 1;
          return acc;
        }, {}),
      },
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  function runOnce(input = {}) {
    const cfg = { ...config(), ...(input.config || {}) };
    if (input.enforceEnabled !== false && !cfg.enabled) {
      return {
        ok: true,
        scheduled: false,
        blocked: true,
        blockedReason: 'replay_scheduler_disabled',
        plan: null,
        appended: null,
        ...SAFETY,
      };
    }
    const plan = buildSchedule({ ...input, config: cfg });
    const appended = queueService.appendMany(plan.jobs);
    return {
      ok: appended.ok,
      scheduled: true,
      blocked: false,
      blockedReason: null,
      plan,
      appended,
      scheduler_runs_replay: false,
      ...SAFETY,
    };
  }

  function getStatus() {
    const cfg = config();
    const queueStatus = typeof queueService.getStatus === 'function' ? queueService.getStatus() : null;
    return {
      ok: true,
      enabled: cfg.enabled,
      intervalMinutes: cfg.intervalMinutes,
      maxJobsPerRun: cfg.maxJobsPerRun,
      periodDays: cfg.periodDays,
      scheduler_runs_replay: false,
      prioritizes: 'information_gain',
      win_rate_used_for_priority: false,
      queue: queueStatus ? queueStatus.summary : null,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    config,
    buildSchedule,
    runOnce,
    getStatus,
  };
}

const defaultReplaySchedulerService = createReplaySchedulerService();

module.exports = {
  SAFETY,
  DEFAULT_SYMBOLS,
  config,
  createReplaySchedulerService,
  defaultReplaySchedulerService,
  _internal: {
    defaultPeriod,
    informationGainPriority,
    modeFromGap,
    modeFromRecommendedTests,
    dedupeJobs,
    inferSymbols,
    inferMarketGroup,
  },
};
