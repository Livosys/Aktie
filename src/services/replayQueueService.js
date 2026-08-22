'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Env-överstyrbar enligt samma mönster som STRATEGY_LIBRARY_EVENTS_FILE,
// AI_MEMORY_EVENTS_FILE och STRATEGY_FAMILY_TREE_FILE.
//
// Utan den skrev en sandlådekörning i DRIFTENS kö även när biblioteket, minnet
// och släktträdet var omdirigerade: orchestratorn bygger kön med sin default,
// och env var enda vägen in. Det inträffade 2026-08-20 15:21–15:26 vid
// verifieringen av fabrikens loop — två jobb, båda körda till COMPLETED.
const DEFAULT_QUEUE_FILE = path.resolve(
  process.env.REPLAY_QUEUE_EVENTS_FILE
    || path.resolve(__dirname, '../../data/replay-queue/events.jsonl'),
);

const SAFETY = Object.freeze({
  mode: 'paper_only',
  paper_only: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const EVENT_TYPES = Object.freeze({
  JOB_APPENDED: 'JOB_APPENDED',
  JOB_STARTED: 'JOB_STARTED',
  JOB_COMPLETED: 'JOB_COMPLETED',
  JOB_FAILED: 'JOB_FAILED',
  QUEUE_PAUSED: 'QUEUE_PAUSED',
  QUEUE_RESUMED: 'QUEUE_RESUMED',
  QUEUE_RESET: 'QUEUE_RESET',
});

const VALID_REPLAY_MODES = new Set([
  'manual',
  'regression',
  'evolution',
  'optimizer',
  'coverage',
  'confidence',
]);

const VALID_ENGINE_MODES = new Set(['scan_only', 'with_outcomes', 'debug']);
const VALID_JOB_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);
const MAX_REASON_LENGTH = 600;
const MAX_REQUESTED_BY_LENGTH = 120;

function nowIso() {
  return new Date().toISOString();
}

function safeString(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function limitText(value, maxLength, fallback = '') {
  return safeString(value, fallback).slice(0, maxLength);
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = safeNumber(value, min);
  return Math.max(min, Math.min(max, n));
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

function safeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item != null);
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

function normalizeReplayMode(value) {
  const mode = safeString(value || 'manual').toLowerCase();
  return VALID_REPLAY_MODES.has(mode) ? mode : null;
}

function normalizeEngineMode(value) {
  const mode = safeString(value || 'scan_only').toLowerCase();
  return VALID_ENGINE_MODES.has(mode) ? mode : 'scan_only';
}

function normalizeStrategy(input = {}) {
  const raw = typeof input === 'string' ? { id: input } : safeObject(input);
  const id = safeString(
    raw.id ||
    raw.strategy_id ||
    raw.strategyId ||
    raw.name ||
    raw.strategy_name ||
    raw.strategyName,
  );
  if (!id) return null;
  return {
    id,
    name: safeString(raw.name || raw.strategy_name || raw.strategyName || id),
    source: safeString(raw.source || 'unknown').toLowerCase(),
    status: safeString(raw.status || 'unknown').toLowerCase(),
  };
}

function normalizeMarketDna(input = {}, fallbackSymbols = []) {
  const raw = safeObject(input);
  const symbols = normalizeSymbols(raw.symbols || raw.symbol || raw.tickers || fallbackSymbols);
  return {
    symbols,
    market_group: safeString(raw.market_group || raw.marketGroup || raw.market || 'unknown').toLowerCase(),
    timeframe: safeString(raw.timeframe || '2m').toLowerCase(),
    dna_tags: normalizeSymbols(raw.dna_tags || raw.tags || raw.market_regime_tags || []).map((tag) => tag.toLowerCase()),
    coverage: safeObject(raw.coverage),
  };
}

function normalizePeriod(input = {}) {
  const raw = safeObject(input);
  const start = normalizeDate(raw.start || raw.date_from || raw.from);
  const end = normalizeDate(raw.end || raw.date_to || raw.to);
  if (!start || !end) return null;
  return { start, end };
}

function normalizeExecutionModel(input = {}) {
  const raw = safeObject(input);
  return {
    engine: 'replayEngine',
    engine_mode: normalizeEngineMode(raw.engine_mode || raw.mode),
    timeframe: safeString(raw.timeframe || '2m').toLowerCase(),
    paper_only: true,
    live_trading_disabled: true,
    scheduler_runs_replay: false,
    queue_invokes_engine: true,
  };
}

function normalizePriority(input = {}) {
  if (typeof input === 'number') {
    return {
      score: Math.round(clamp(input, 0, 100)),
      metric: 'information_gain',
      components: {},
      win_rate_used: false,
    };
  }
  const raw = safeObject(input);
  return {
    score: Math.round(clamp(raw.score ?? raw.information_gain ?? raw.informationGain, 0, 100)),
    metric: 'information_gain',
    components: safeObject(raw.components),
    win_rate_used: false,
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function jobFingerprint(job) {
  return stableHash({
    strategy: job.strategy,
    market_dna: {
      symbols: job.market_dna.symbols,
      market_group: job.market_dna.market_group,
      timeframe: job.market_dna.timeframe,
      dna_tags: job.market_dna.dna_tags,
    },
    replay_mode: job.replay_mode,
    period: job.period,
    execution_model: {
      engine: job.execution_model.engine,
      engine_mode: job.execution_model.engine_mode,
      timeframe: job.execution_model.timeframe,
    },
    // Genomet är en del av jobbets IDENTITET. Utan det såg ett jobb för ett
    // nyskapat genom identiskt ut med det redan avslutade jobbet för samma
    // kunskapslucka: kön svarade `duplicates: 1, created: 0`, EXECUTE_QUEUE
    // hoppade över med no_new_replay_job_created, och fabrikscykeln kunde
    // aldrig komma vidare. Två olika genom är två olika experiment.
    genome: job.genome ? job.genome.dna_hash : null,
  });
}

// ── Genomet jobbet finns FÖR ────────────────────────────────────────────────
//
// Ett replay-jobb skapas i en fabrikscykel som just har muterat fram ett nytt
// genom. Utan det här fältet visste jobbet inte om det: körningen tog registrets
// evolverade genom "de EVOLVED_LIMIT nyaste", och om 24 nyare hunnit skapas
// prövades aldrig det genom jobbet fanns för. Evidensen skrevs då mot en
// strategi som inte kördes.
//
// Fältet bär genomets identitet OCH dess parametrar. Identiteten räcker för att
// köra det (registret slår upp resten i släktträdet); parametrarna finns med för
// att jobbet ska gå att läsa i efterhand utan att trädet behöver konsulteras —
// ett jobb ska kunna förklara sig självt.
function normalizeGenome(value) {
  const raw = safeObject(value);
  const dnaHash = limitText(raw.dna_hash || raw.dnaHash, 64);
  if (!dnaHash) return null;
  const options = safeObject(raw.options || raw.defaultOptions);
  return {
    dna_hash: dnaHash,
    strategy_id: limitText(raw.strategy_id || raw.strategyId, MAX_REQUESTED_BY_LENGTH),
    root_strategy_id: limitText(raw.root_strategy_id || raw.rootStrategyId, MAX_REQUESTED_BY_LENGTH),
    parent_dna_hash: limitText(raw.parent_dna_hash || raw.parentDnaHash, 64),
    generation: Number.isFinite(Number(raw.generation)) ? Number(raw.generation) : null,
    // Endast ändliga tal. En parameter som inte är ett tal är inte en parameter.
    //
    // null måste avvisas FÖRE Number(): Number(null) är 0, så en saknad
    // parameter hade blivit ett mätt nollvärde och strategin körts med en
    // inställning ingen valt. Samma fälla som evidenspolicyns num() bär.
    options: Object.fromEntries(Object.entries(options)
      .filter(([, v]) => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)))
      .map(([k, v]) => [k, Number(v)])),
  };
}

function normalizeJob(input = {}) {
  const raw = safeObject(input);
  const strategy = normalizeStrategy(raw.strategy || raw.Strategy || {
    id: raw.strategy_id || raw.strategyId,
    name: raw.strategy_name || raw.strategyName,
    source: raw.source,
    status: raw.status,
  });
  const replayMode = normalizeReplayMode(raw.replay_mode || raw.replayMode || raw.ReplayMode);
  const period = normalizePeriod(raw.period || raw.Period || raw);
  const fallbackSymbols = raw.symbols || raw.symbol || raw.strategy_symbols || raw.strategySymbols || [];
  const marketDna = normalizeMarketDna(raw.market_dna || raw.marketDna || raw.MarketDNA || {}, fallbackSymbols);
  const executionModel = normalizeExecutionModel(raw.execution_model || raw.executionModel || raw.ExecutionModel || {});
  const priority = normalizePriority(raw.priority || raw.Priority || {});
  const reason = limitText(raw.reason || raw.Reason, MAX_REASON_LENGTH);
  const requestedBy = limitText(raw.requested_by || raw.requestedBy || raw.RequestedBy || 'Strategy Brain', MAX_REQUESTED_BY_LENGTH);
  const genome = normalizeGenome(raw.genome || raw.Genome);

  const errors = [];
  if (!strategy) errors.push('strategy_required');
  if (!marketDna.symbols.length) errors.push('market_dna_symbols_required');
  if (!replayMode) errors.push('invalid_replay_mode');
  if (!period) errors.push('period_required');
  if (period && period.start > period.end) errors.push('period_start_after_end');
  if (!reason) errors.push('reason_required');
  if (!requestedBy) errors.push('requested_by_required');

  const job = {
    schema_version: 'replay_job_v1',
    strategy,
    market_dna: marketDna,
    replay_mode: replayMode,
    period,
    execution_model: executionModel,
    priority,
    reason,
    requested_by: requestedBy,
    genome,
    safety: { ...SAFETY },
    ...SAFETY,
  };
  const fingerprint = jobFingerprint(job);
  return {
    ok: errors.length === 0,
    errors,
    job: {
      id: `replay_job_${fingerprint.slice(0, 20)}`,
      fingerprint,
      ...job,
    },
  };
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function lastResetIndex(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.event_type === EVENT_TYPES.QUEUE_RESET) return i;
  }
  return -1;
}

function statusRank(status) {
  if (status === 'running') return 0;
  if (status === 'pending') return 1;
  if (status === 'completed') return 2;
  if (status === 'failed') return 3;
  return 4;
}

function sortJobs(a, b) {
  return statusRank(a.status) - statusRank(b.status)
    || safeNumber(b.priority?.score, 0) - safeNumber(a.priority?.score, 0)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || String(a.id).localeCompare(String(b.id));
}

function foldQueue(events) {
  const resetIdx = lastResetIndex(events);
  const foldedEvents = events.slice(resetIdx + 1);
  const resetEvent = resetIdx >= 0 ? events[resetIdx] : null;
  const jobs = new Map();
  let paused = false;
  let pausedAt = null;
  let pausedReason = null;

  for (const event of foldedEvents) {
    const type = event?.event_type;
    if (type === EVENT_TYPES.QUEUE_PAUSED) {
      paused = true;
      pausedAt = event.paused_at || event.created_at || null;
      pausedReason = event.reason || null;
      continue;
    }
    if (type === EVENT_TYPES.QUEUE_RESUMED) {
      paused = false;
      pausedAt = null;
      pausedReason = null;
      continue;
    }
    const jobId = safeString(event?.job_id);
    if (!jobId) continue;

    if (type === EVENT_TYPES.JOB_APPENDED) {
      jobs.set(jobId, {
        ...(event.job || {}),
        id: jobId,
        status: 'pending',
        created_at: event.created_at || event.job?.created_at || null,
        updated_at: event.created_at || null,
      });
      continue;
    }

    const current = jobs.get(jobId);
    if (!current) continue;
    if (type === EVENT_TYPES.JOB_STARTED) {
      jobs.set(jobId, {
        ...current,
        status: 'running',
        started_at: event.started_at || event.created_at || null,
        worker_id: event.worker_id || null,
        updated_at: event.created_at || null,
      });
      continue;
    }
    if (type === EVENT_TYPES.JOB_COMPLETED) {
      jobs.set(jobId, {
        ...current,
        status: 'completed',
        completed_at: event.completed_at || event.created_at || null,
        run_id: event.run_id || null,
        replay_summary: event.replay_summary || null,
        memory_recorded: event.memory_recorded === true,
        updated_at: event.created_at || null,
      });
      continue;
    }
    if (type === EVENT_TYPES.JOB_FAILED) {
      jobs.set(jobId, {
        ...current,
        status: 'failed',
        failed_at: event.failed_at || event.created_at || null,
        error: event.error || 'unknown_error',
        memory_recorded: event.memory_recorded === true,
        updated_at: event.created_at || null,
      });
    }
  }

  const items = [...jobs.values()].sort(sortJobs);
  return {
    reset_at: resetEvent?.reset_at || resetEvent?.created_at || null,
    reset_reason: resetEvent?.reason || null,
    paused,
    paused_at: pausedAt,
    paused_reason: pausedReason,
    jobs: items,
    pending_jobs: items.filter((job) => job.status === 'pending'),
    running_jobs: items.filter((job) => job.status === 'running'),
    completed_jobs: items.filter((job) => job.status === 'completed'),
    failed_jobs: items.filter((job) => job.status === 'failed'),
  };
}

function summarize(folded, rawCount) {
  return {
    raw_event_count: rawCount,
    visible_jobs: folded.jobs.length,
    pending: folded.pending_jobs.length,
    running: folded.running_jobs.length,
    completed: folded.completed_jobs.length,
    failed: folded.failed_jobs.length,
    paused: folded.paused,
    reset_at: folded.reset_at,
  };
}

function createReplayQueueService(options = {}) {
  const queueFile = options.queueFile || DEFAULT_QUEUE_FILE;
  const nowFn = typeof options.now === 'function' ? options.now : nowIso;

  function serviceNowIso() {
    const value = nowFn();
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : nowIso();
  }

  function readEvents() {
    return readJsonl(queueFile);
  }

  function getStatus() {
    const events = readEvents();
    const folded = foldQueue(events);
    return {
      ok: true,
      queue_file: queueFile,
      append_only: true,
      mutation_allowed: false,
      rewrite_allowed: false,
      ...folded,
      summary: summarize(folded, events.length),
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  function getJob(jobId) {
    const id = safeString(jobId);
    if (!id) return null;
    return getStatus().jobs.find((job) => job.id === id) || null;
  }

  function appendEvent(row) {
    const createdAt = serviceNowIso();
    const eventIndex = readEvents().length;
    appendJsonl(queueFile, {
      event_id: `replay_queue_event_${stableHash({ row, createdAt, eventIndex }).slice(0, 20)}`,
      created_at: createdAt,
      ...row,
      safety: { ...SAFETY },
      ...SAFETY,
    });
  }

  function appendJob(input = {}) {
    const normalized = normalizeJob(input);
    if (!normalized.ok) {
      return { ok: false, error: normalized.errors[0], errors: normalized.errors, ...SAFETY };
    }
    const now = serviceNowIso();
    const job = {
      ...normalized.job,
      created_at: now,
      updated_at: now,
      status: 'pending',
    };
    const status = getStatus();
    const duplicate = status.jobs.find((item) => item.id === job.id || item.fingerprint === job.fingerprint);
    if (duplicate) {
      return {
        ok: true,
        created: false,
        duplicate: true,
        job: duplicate,
        queue_file: queueFile,
        ...SAFETY,
      };
    }
    appendEvent({
      event_type: EVENT_TYPES.JOB_APPENDED,
      job_id: job.id,
      fingerprint: job.fingerprint,
      job,
    });
    return {
      ok: true,
      created: true,
      duplicate: false,
      job,
      queue_file: queueFile,
      ...SAFETY,
    };
  }

  function appendMany(jobs = []) {
    const results = safeArray(jobs).map((job) => appendJob(job));
    return {
      ok: results.every((row) => row.ok),
      created: results.filter((row) => row.created).length,
      duplicates: results.filter((row) => row.duplicate).length,
      failed: results.filter((row) => !row.ok).length,
      results,
      status: getStatus(),
      ...SAFETY,
    };
  }

  function pauseQueue(reason = 'manual_pause', requestedBy = 'user') {
    const status = getStatus();
    if (!status.paused) {
      const at = serviceNowIso();
      appendEvent({
        event_type: EVENT_TYPES.QUEUE_PAUSED,
        paused_at: at,
        reason: limitText(reason, MAX_REASON_LENGTH, 'manual_pause'),
        requested_by: limitText(requestedBy, MAX_REQUESTED_BY_LENGTH, 'user'),
      });
    }
    return {
      ok: true,
      paused: true,
      status: getStatus(),
      ...SAFETY,
    };
  }

  function resumeQueue(reason = 'manual_resume', requestedBy = 'user') {
    const status = getStatus();
    if (status.paused) {
      const at = serviceNowIso();
      appendEvent({
        event_type: EVENT_TYPES.QUEUE_RESUMED,
        resumed_at: at,
        reason: limitText(reason, MAX_REASON_LENGTH, 'manual_resume'),
        requested_by: limitText(requestedBy, MAX_REQUESTED_BY_LENGTH, 'user'),
      });
    }
    return {
      ok: true,
      paused: false,
      status: getStatus(),
      ...SAFETY,
    };
  }

  function resetQueue(reason = 'manual_reset', requestedBy = 'user') {
    const at = serviceNowIso();
    appendEvent({
      event_type: EVENT_TYPES.QUEUE_RESET,
      reset_at: at,
      reason: limitText(reason, MAX_REASON_LENGTH, 'manual_reset'),
      requested_by: limitText(requestedBy, MAX_REQUESTED_BY_LENGTH, 'user'),
    });
    return {
      ok: true,
      reset: true,
      status: getStatus(),
      ...SAFETY,
    };
  }

  function nextPendingJob() {
    const status = getStatus();
    if (status.paused) {
      return { ok: true, blocked: true, blockedReason: 'replay_queue_paused', job: null, ...SAFETY };
    }
    const job = status.pending_jobs[0] || null;
    return {
      ok: true,
      blocked: false,
      blockedReason: job ? null : 'replay_queue_empty',
      job,
      ...SAFETY,
    };
  }

  function startJob(jobId, { workerId = 'replay_queue_runner' } = {}) {
    const job = getJob(jobId);
    if (!job) return { ok: false, error: 'replay_job_not_found', ...SAFETY };
    if (job.status !== 'pending') {
      return { ok: false, error: 'replay_job_not_pending', job, ...SAFETY };
    }
    const status = getStatus();
    if (status.paused) {
      return { ok: false, error: 'replay_queue_paused', job, ...SAFETY };
    }
    const at = serviceNowIso();
    appendEvent({
      event_type: EVENT_TYPES.JOB_STARTED,
      job_id: job.id,
      started_at: at,
      worker_id: safeString(workerId, 'replay_queue_runner'),
    });
    return { ok: true, started: true, job: getJob(job.id), ...SAFETY };
  }

  function completeJob(jobId, { runId = null, replaySummary = null, memoryRecorded = false } = {}) {
    const job = getJob(jobId);
    if (!job) return { ok: false, error: 'replay_job_not_found', ...SAFETY };
    if (!VALID_JOB_STATUSES.has(job.status)) {
      return { ok: false, error: 'invalid_replay_job_status', job, ...SAFETY };
    }
    const at = serviceNowIso();
    appendEvent({
      event_type: EVENT_TYPES.JOB_COMPLETED,
      job_id: job.id,
      completed_at: at,
      run_id: runId,
      replay_summary: safeObject(replaySummary),
      memory_recorded: memoryRecorded === true,
    });
    return { ok: true, completed: true, job: getJob(job.id), ...SAFETY };
  }

  function failJob(jobId, { error = 'unknown_error', memoryRecorded = false } = {}) {
    const job = getJob(jobId);
    if (!job) return { ok: false, error: 'replay_job_not_found', ...SAFETY };
    const at = serviceNowIso();
    appendEvent({
      event_type: EVENT_TYPES.JOB_FAILED,
      job_id: job.id,
      failed_at: at,
      error: limitText(error, MAX_REASON_LENGTH, 'unknown_error'),
      memory_recorded: memoryRecorded === true,
    });
    return { ok: true, failed: true, job: getJob(job.id), ...SAFETY };
  }

  return {
    SAFETY,
    EVENT_TYPES,
    VALID_REPLAY_MODES,
    VALID_ENGINE_MODES,
    queueFile,
    readEvents,
    getStatus,
    getJob,
    appendJob,
    appendMany,
    pauseQueue,
    resumeQueue,
    resetQueue,
    nextPendingJob,
    startJob,
    completeJob,
    failJob,
  };
}

// Startup stale job recovery: Prevent deadlock on startup if a job was stuck before restart
function recoverStaleJobs() {
  const queueService = createReplayQueueService();
  const status = queueService.getStatus();
  const now = Date.now();
  const MAX_SAFE_JOB_RUNTIME_MS = 1 * 60 * 60 * 1000; // 1 hour max

  if (!status.jobs) return;

  status.jobs.forEach((job) => {
    if (job.status !== 'RUNNING') return;

    const startedAt = new Date(job.started_at || job.createdAt).getTime();
    const elapsed = now - startedAt;

    if (elapsed > MAX_SAFE_JOB_RUNTIME_MS) {
      // Recover stuck job: append JOB_FAILED event
      const queueService = createReplayQueueService();
      queueService.failJob(job.id, {
        error: 'startup_stale_recovery_exceeded_safe_runtime',
        reason: `Job stuck for ${(elapsed / 1000 / 60 / 60).toFixed(1)}h - recovered at startup`,
      });
    }
  });
}

const defaultReplayQueueService = createReplayQueueService();
// Recover any stale jobs from previous crashes/deadlocks at startup
try { recoverStaleJobs(); } catch (_) { /* Silent fail - don't block startup */ }

module.exports = {
  SAFETY,
  EVENT_TYPES,
  VALID_REPLAY_MODES,
  VALID_ENGINE_MODES,
  DEFAULT_QUEUE_FILE,
  createReplayQueueService,
  defaultReplayQueueService,
  _internal: {
    foldQueue,
    normalizeJob,
    normalizeReplayMode,
    normalizeExecutionModel,
    jobFingerprint,
    stableStringify,
  },
};
