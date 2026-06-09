'use strict';

/**
 * Read-only data jobs status service.
 *
 * This service only inspects existing import manifests, backfill job metadata,
 * market-data cache files and recent data events. It never starts imports,
 * backfills, schedulers or provider calls.
 */

const fs = require('fs');
const path = require('path');

const alpacaDataService = require('../data/alpacaDataService');
const marketDataStore = require('../data/marketDataStore');
const dataCoverageExpansion = require('./dataCoverageExpansionService');
const eventLogService = require('./eventLogService');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_IMPORT_MANIFEST = path.join(ROOT, 'data/market-data/imports/alpaca-2m-imports.jsonl');
const DEFAULT_BACKFILL_JOBS_FILE = path.join(ROOT, 'data/data-coverage/backfill-jobs-v1.json');
const DEFAULT_MARKET_DATA_ROOT = path.join(ROOT, 'data/market-data');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso() { return new Date().toISOString(); }
function arr(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}
function safeError(err) {
  const msg = String(err?.message || err || 'unknown_error');
  if (/key|token|secret|password|credential|authorization/i.test(msg)) return 'Provider/config kunde inte läsas utan att visa hemligheter.';
  return msg.slice(0, 180);
}
function fileExists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}
function statFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    return { size: st.size, mtime: st.mtime.toISOString(), ageSeconds: Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000)) };
  } catch (_) {
    return null;
  }
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}
function readJsonlTail(file, limit = 20) {
  try {
    if (!fs.existsSync(file)) return { rows: [], status: 'empty' };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const rows = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try { rows.push(JSON.parse(line)); } catch (_) { /* ignore broken tail rows */ }
    }
    return { rows, status: rows.length ? 'ok' : 'empty', totalLines: lines.length };
  } catch (err) {
    return { rows: [], status: 'degraded', error: safeError(err) };
  }
}
function lower(value) { return String(value || '').toLowerCase(); }
function latestByTime(rows, fields) {
  return [...arr(rows)].sort((a, b) => {
    const ta = String(fields.map((f) => a?.[f]).find(Boolean) || '');
    const tb = String(fields.map((f) => b?.[f]).find(Boolean) || '');
    return tb.localeCompare(ta);
  })[0] || null;
}
function normalizeImportRow(row = {}) {
  if (!row || typeof row !== 'object') return null;
  return {
    provider: 'alpaca',
    status: row.status || null,
    symbol: row.symbol || null,
    timeframe: '2m',
    from: row.from || null,
    to: row.to || null,
    sourceTimeframe: row.sourceTimeframe || null,
    fallbackUsed: row.fallbackUsed === true,
    candlesFetched: num(row.candles_fetched),
    candlesValid: num(row.candles_valid),
    candlesImported: num(row.candles_written),
    duplicatesSkipped: num(row.duplicates_skipped),
    invalidCandlesFiltered: num(row.invalid_candles_filtered),
    missingBusinessDays: num(row.missing_business_days),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    durationMs: durationMs(row.started_at, row.completed_at),
    errors: row.error ? [safeError(row.error)] : [],
    ...SAFETY,
  };
}
function durationMs(startedAt, completedAt) {
  const a = new Date(startedAt || '').getTime();
  const b = new Date(completedAt || '').getTime();
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}
function summarizeImports(manifestFile) {
  const tail = readJsonlTail(manifestFile, 50);
  const rows = tail.rows.map(normalizeImportRow).filter(Boolean);
  const latest = latestByTime(rows, ['completedAt', 'startedAt']);
  const errors = rows.filter((r) => lower(r.status) === 'error' || r.errors.length).slice(0, 5);
  const latestCompletedAt = latest?.completedAt || latest?.startedAt || null;
  return {
    status: tail.status === 'degraded' ? 'degraded' : (latest ? lower(latest.status || 'ok') : 'empty'),
    lastRun: latestCompletedAt,
    nextRun: null,
    symbolsUpdated: [...new Set(rows.filter((r) => lower(r.status) === 'ok').map((r) => r.symbol).filter(Boolean))],
    candlesImported: rows.reduce((sum, r) => sum + (r.candlesImported || 0), 0),
    durationMs: latest?.durationMs ?? null,
    latestImport: latest,
    errors: errors.map((r) => ({ symbol: r.symbol, message: r.errors[0] || 'import_error', at: r.completedAt || r.startedAt })),
    manifestExists: fileExists(manifestFile),
    manifestRowsSeen: tail.totalLines || rows.length,
    message: latest ? 'Senaste Alpaca 2m-import hittad.' : 'Ingen tydlig Alpaca 2m-importhistorik hittades ännu.',
    ...SAFETY,
  };
}
function normalizeBackfillJob(job = {}) {
  if (!job || typeof job !== 'object') return null;
  const progress = job.progress && typeof job.progress === 'object' ? job.progress : {};
  return {
    id: job.job_id || job.id || null,
    status: job.status || null,
    symbols: arr(job.symbols),
    timeframe: job.timeframe || arr(job.timeframes).join(', ') || null,
    timeframes: arr(job.timeframes),
    provider: job.provider || null,
    dateRange: {
      from: job.from_date || null,
      to: job.to_date || null,
    },
    symbolsCovered: arr(job.symbols).length,
    candlesImported: num(job.candles_downloaded),
    progressPct: num(progress.pct),
    completedSteps: num(progress.completed),
    failedSteps: num(progress.failed),
    totalSteps: num(progress.total),
    errors: arr(job.errors).slice(0, 5).map((err) => ({
      symbol: err.symbol || null,
      timeframe: err.timeframe || null,
      message: safeError(err.message || err.error || err),
      at: err.at || null,
    })),
    createdAt: job.created_at || null,
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    updatedAt: job.updated_at || null,
    ...SAFETY,
  };
}
function summarizeBackfills(jobsFile, coverageService) {
  let jobs = readJson(jobsFile, []);
  if (!Array.isArray(jobs) && coverageService && typeof coverageService.listBackfillJobs === 'function') {
    try { jobs = arr(coverageService.listBackfillJobs()?.jobs); } catch (_) { jobs = []; }
  }
  if (!Array.isArray(jobs)) jobs = [];
  const normalized = jobs.map(normalizeBackfillJob).filter(Boolean);
  const latest = latestByTime(normalized, ['updatedAt', 'completedAt', 'startedAt', 'createdAt']);
  const running = normalized.filter((j) => lower(j.status) === 'running');
  const failed = normalized.filter((j) => ['failed', 'error', 'stopped'].includes(lower(j.status)));
  const missingDataCount = normalized.reduce((sum, j) => sum + (j.failedSteps || 0), 0);
  return {
    status: latest ? (running.length ? 'running' : lower(latest.status || 'ok')) : 'empty',
    lastRun: latest?.completedAt || latest?.updatedAt || latest?.startedAt || latest?.createdAt || null,
    nextRun: null,
    dateRange: latest?.dateRange || null,
    symbolsCovered: latest?.symbolsCovered || 0,
    missingDataCount,
    latestBackfill: latest,
    activeJobs: running,
    failedJobs: failed.slice(0, 5),
    totalJobs: normalized.length,
    jobsFileExists: fileExists(jobsFile),
    message: latest ? 'Senaste backfill-jobb hittades.' : 'Ingen tydlig backfill-historik hittades ännu.',
    ...SAFETY,
  };
}
function collectMarketDataCache(marketDataRoot, store) {
  const roots = [
    path.join(marketDataRoot, 'candles-2m'),
    path.join(marketDataRoot, 'alpaca/candles-2m'),
    path.join(marketDataRoot, 'alpaca/raw'),
    path.join(marketDataRoot, 'binance/raw'),
  ];
  let latest = null;
  let fileCount = 0;
  let symbolCount = 0;
  const symbols = new Set();

  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const sym of fs.readdirSync(root)) {
        const symDir = path.join(root, sym);
        if (!fs.statSync(symDir).isDirectory()) continue;
        symbols.add(sym.toUpperCase());
        for (const file of fs.readdirSync(symDir).slice(-120)) {
          if (!/\.jsonl$/i.test(file)) continue;
          fileCount += 1;
          const st = statFile(path.join(symDir, file));
          if (st && (!latest || st.mtime > latest.lastUpdated)) latest = { lastUpdated: st.mtime, source: path.relative(ROOT, path.join(symDir, file)) };
        }
      }
    } catch (_) {
      // A single unreadable cache root should not break the endpoint.
    }
  }

  try {
    if (store && typeof store.listSymbols === 'function') {
      for (const symbol of store.listSymbols()) symbols.add(String(symbol || '').toUpperCase());
    }
  } catch (_) {
    // Ignore store read errors; filesystem scan above is enough for status.
  }
  symbolCount = symbols.size;
  const ageSeconds = latest?.lastUpdated ? Math.max(0, Math.round((Date.now() - new Date(latest.lastUpdated).getTime()) / 1000)) : null;
  return {
    cacheExists: fileCount > 0 || symbolCount > 0,
    cacheAgeSeconds: ageSeconds,
    lastUpdated: latest?.lastUpdated || null,
    latestSource: latest?.source || null,
    symbolsCached: symbolCount,
    filesSeen: fileCount,
    ...SAFETY,
  };
}
function buildProviderStatus(alpacaService, coverageService) {
  const alpacaConfigured = Boolean(alpacaService && typeof alpacaService.hasCredentials === 'function' && alpacaService.hasCredentials());
  const alpacaEnabled = Boolean(alpacaService && typeof alpacaService.isEnabled === 'function' && alpacaService.isEnabled());
  let coverageProviders = null;
  try {
    if (coverageService && typeof coverageService.getProviderStatus === 'function') coverageProviders = coverageService.getProviderStatus();
  } catch (_) {
    coverageProviders = null;
  }
  return {
    alpaca: {
      provider: 'alpaca',
      configured: alpacaConfigured,
      enabled: alpacaEnabled,
      ok: alpacaConfigured && alpacaEnabled,
      message: alpacaConfigured && alpacaEnabled ? 'Alpaca verkar konfigurerad.' : 'Alpaca saknar aktiv/configurerad provider.',
    },
    binance: coverageProviders?.binance || { provider: 'binance', configured: true, enabled: true, ok: true },
    source: coverageProviders ? 'dataCoverageExpansionService' : 'env_boolean_check',
    ...SAFETY,
  };
}
function readRecentDataEvents(logService) {
  try {
    if (!logService || typeof logService.readRecentEvents !== 'function') return [];
    const raw = logService.readRecentEvents(100);
    return arr(raw?.events)
      .filter((event) => /data|alpaca|historical|import|backfill|candle|cache|provider/i.test(`${event.type || event.event_type || ''} ${event.source || ''} ${event.message || ''}`))
      .slice(0, 20)
      .map((event) => ({
        id: event.event_id || event.id || `${event.type || event.event_type}:${event.timestamp || ''}`,
        timestamp: event.timestamp || null,
        type: event.type || event.event_type || 'data.event',
        status: /failed|error/i.test(`${event.type || event.event_type || event.message || ''}`) ? 'failed' : /completed|updated/i.test(`${event.type || event.event_type || ''}`) ? 'completed' : 'info',
        message: event.message || event.reason || event.type || event.event_type || 'Datahändelse',
        source: event.source || 'eventLogService',
        symbol: event.symbol || null,
        ...SAFETY,
      }));
  } catch (_) {
    return [];
  }
}
function buildDataQuality(cacheStatus, weeklyBackfill, recentEvents) {
  const providerErrors = recentEvents.filter((e) => /provider|alpaca|key|failed|error/i.test(`${e.message} ${e.type}`)).slice(0, 5);
  const stale = cacheStatus.cacheAgeSeconds != null && cacheStatus.cacheAgeSeconds > 7 * 86400;
  return {
    staleSymbols: stale ? ['market-data-cache'] : [],
    missingCandles: weeklyBackfill.missingDataCount || 0,
    providerErrors,
    message: !cacheStatus.cacheExists
      ? 'Ingen market-data-cache hittades.'
      : stale
        ? 'Market-data-cache finns men verkar gammal.'
        : 'Market-data-cache finns.',
    ...SAFETY,
  };
}

function buildDataJobsStatus(options = {}) {
  const manifestFile = options.importManifestFile || DEFAULT_IMPORT_MANIFEST;
  const jobsFile = options.backfillJobsFile || DEFAULT_BACKFILL_JOBS_FILE;
  const marketDataRoot = options.marketDataRoot || DEFAULT_MARKET_DATA_ROOT;
  const alpacaService = Object.prototype.hasOwnProperty.call(options, 'alpacaDataService') ? options.alpacaDataService : alpacaDataService;
  const coverageService = Object.prototype.hasOwnProperty.call(options, 'dataCoverageExpansion') ? options.dataCoverageExpansion : dataCoverageExpansion;
  const store = Object.prototype.hasOwnProperty.call(options, 'marketDataStore') ? options.marketDataStore : marketDataStore;
  const logService = Object.prototype.hasOwnProperty.call(options, 'eventLogService') ? options.eventLogService : eventLogService;

  const warnings = [];
  try {
    const providerStatus = buildProviderStatus(alpacaService, coverageService);
    const hourlyImport = summarizeImports(manifestFile);
    const weeklyBackfill = summarizeBackfills(jobsFile, coverageService);
    const cacheStatus = collectMarketDataCache(marketDataRoot, store);
    const recentDataEvents = readRecentDataEvents(logService);
    const dataQuality = buildDataQuality(cacheStatus, weeklyBackfill, recentDataEvents);
    let coverageStatus = null;
    let coverageDetails = null;
    try {
      if (coverageService && typeof coverageService.getCoverageStatus === 'function') {
        coverageStatus = coverageService.getCoverageStatus();
      }
    } catch (err) {
      warnings.push(`coverage_status_error:${safeError(err)}`);
    }
    try {
      if (coverageService && typeof coverageService.getAllSymbolCoverage === 'function') {
        const rawCoverage = coverageService.getAllSymbolCoverage();
        const symbols = arr(rawCoverage?.symbols);
        const readySymbols = symbols.filter((row) => row && (row.usable_for_replay || row.usable_for_batch));
        const missingSymbols = symbols.filter((row) => row && ['weak', 'medium', 'missing', 'missing_provider'].includes(String(row.data_quality || '').toLowerCase()));
        coverageDetails = {
          status: coverageStatus?.status || (symbols.length ? 'ok' : 'empty'),
          source: 'dataCoverageExpansionService',
          symbolsTotal: num(coverageStatus?.symbols_total) || symbols.length,
          readyForReplay: num(coverageStatus?.symbols_ready_for_replay) || readySymbols.filter((row) => row.usable_for_replay).length,
          readyForBatch: num(coverageStatus?.symbols_ready_for_batch) || readySymbols.filter((row) => row.usable_for_batch).length,
          readyForAiLearning: num(coverageStatus?.symbols_ready_for_ai_learning) || 0,
          missingData: num(coverageStatus?.symbols_missing_data) || missingSymbols.length,
          readySymbols: readySymbols.slice(0, 10).map((row) => ({
            symbol: row.symbol,
            marketGroup: row.market_group || null,
            coverageScore: row.coverage_score ?? null,
            daysCovered: row.days_covered ?? null,
          })),
          missingSymbols: missingSymbols.slice(0, 10).map((row) => ({
            symbol: row.symbol,
            marketGroup: row.market_group || null,
            quality: row.data_quality || null,
            reason: row.reason || null,
            provider: row.provider || null,
          })),
          providerStatus: coverageStatus?.provider_status || null,
          generatedAt: coverageStatus?.generated_at || null,
          updatedAt: coverageStatus?.generated_at || null,
        };
      }
    } catch (err) {
      warnings.push(`coverage_details_error:${safeError(err)}`);
      coverageDetails = null;
    }
    if (hourlyImport.status === 'degraded') warnings.push('alpaca_import_manifest_degraded');
    if (!hourlyImport.manifestExists) warnings.push('alpaca_import_manifest_missing');
    if (!weeklyBackfill.jobsFileExists) warnings.push('backfill_jobs_file_missing');
    if (!cacheStatus.cacheExists) warnings.push('market_data_cache_empty');

    const hasAnyHistory = hourlyImport.manifestExists || weeklyBackfill.jobsFileExists || cacheStatus.cacheExists || recentDataEvents.length > 0;
    const status = warnings.some((w) => /degraded/.test(w)) ? 'degraded' : (hasAnyHistory ? 'ok' : 'empty');
    const readyForTests = (coverageDetails?.readyForReplay || 0) + (coverageDetails?.readyForBatch || 0);
    const summary = {
      status,
      readyForTests,
      missingSymbols: coverageDetails?.missingSymbols || [],
      readySymbols: coverageDetails?.readySymbols || [],
      recentDataEventCount: recentDataEvents.length,
      latestImportAt: hourlyImport.lastRun || null,
      latestBackfillAt: weeklyBackfill.lastRun || null,
      cacheAgeSeconds: cacheStatus.cacheAgeSeconds ?? null,
      providerIssues: Object.values(providerStatus || {}).filter((row) => row && row.ok === false).length,
      note: hasAnyHistory
        ? (coverageDetails?.missingSymbols?.length ? 'Datajobb finns, men några symboler behöver mer historik.' : 'Datajobb och cache ser tillräckliga ut för read-only tester.')
        : 'Ingen tydlig datajobs-historik hittades ännu.',
    };
    return {
      ok: true,
      status,
      providerStatus,
      alpacaConfigured: providerStatus.alpaca.configured,
      hourlyImport,
      weeklyBackfill,
      cacheStatus,
      dataQuality,
      coverageSummary: coverageDetails,
      recentDataEvents,
      warnings,
      summary,
      source: ['alpaca-2m-imports.jsonl', 'backfill-jobs-v1.json', 'market-data-cache', 'eventLogService'],
      updatedAt: nowIso(),
      message: hasAnyHistory ? 'Datajobb-status läst.' : 'Ingen tydlig datajobs-historik hittades ännu.',
      ...SAFETY,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      providerStatus: null,
      alpacaConfigured: false,
      hourlyImport: null,
      weeklyBackfill: null,
      cacheStatus: null,
      dataQuality: null,
      recentDataEvents: [],
      source: ['dataJobsStatusService'],
      updatedAt: nowIso(),
      message: safeError(err),
      ...SAFETY,
    };
  }
}

function buildSupervisorDataJobsSummary() {
  const full = buildDataJobsStatus();
  return {
    status: full.status,
    alpacaConfigured: full.alpacaConfigured,
    providerStatus: full.providerStatus,
    summary: full.summary,
    hourlyImport: full.hourlyImport ? {
      status: full.hourlyImport.status,
      lastRun: full.hourlyImport.lastRun,
      symbolsUpdated: full.hourlyImport.symbolsUpdated,
      candlesImported: full.hourlyImport.candlesImported,
      errors: full.hourlyImport.errors,
    } : null,
    weeklyBackfill: full.weeklyBackfill ? {
      status: full.weeklyBackfill.status,
      lastRun: full.weeklyBackfill.lastRun,
      totalJobs: full.weeklyBackfill.totalJobs,
      missingDataCount: full.weeklyBackfill.missingDataCount,
    } : null,
    cacheStatus: full.cacheStatus,
    dataQuality: full.dataQuality,
    coverageSummary: full.coverageSummary,
    recentEventCount: full.recentDataEvents.length,
    recentDataEvents: full.recentDataEvents.slice(0, 8),
    warnings: full.warnings,
    updatedAt: full.updatedAt,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  buildDataJobsStatus,
  buildSupervisorDataJobsSummary,
  _internal: {
    safeError,
    readJsonlTail,
    normalizeImportRow,
    normalizeBackfillJob,
    collectMarketDataCache,
  },
};
