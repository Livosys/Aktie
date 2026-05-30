'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const daytradingCatalog = require('./daytradingStrategyCatalogService');
const strategyPerformance = require('./strategyPerformanceService');
const auditTrail = require('./auditTrailService');
const marketUniverse = require('./marketUniverseService');
const dataCoverage = require('./dataCoverageExpansionService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  paper_only: true,
  replay_mode: true,
});

const LIMITS = Object.freeze({
  maxStrategiesPerBatch: 8,
  maxSymbolsPerBatch: 20,
  maxParameterCombinations: 500,
  maxDateRangeDays: 45,
  maxConcurrentRuns: 2,
  timeoutPerRunMs: 1500,
});

const CERTIFICATE_SIMULATION_MODES = new Set(['off', 'underlying_only', 'estimated_leverage', 'real_certificate_data']);

const DATA_DIR = path.resolve(__dirname, '../../data/strategy-batches');
const BATCHES_FILE = path.join(DATA_DIR, 'batches-v1.json');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const activeRunners = new Map();

function nowIso() { return new Date().toISOString(); }
function durationSeconds(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}
function durationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}
function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function cleanValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.map(cleanValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, cleanValue(val)]));
  }
  return value;
}
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
}
function readJson(file, fallback) {
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
function safeArray(value) {
  if (Array.isArray(value)) return value.filter(v => v !== null && v !== undefined && v !== '').map(String);
  if (value == null || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}
function numberArray(value, fallback) {
  const arr = safeArray(value).map(Number).filter(Number.isFinite);
  return arr.length ? [...new Set(arr)] : fallback;
}
function resultPath(batchId) {
  return path.join(RESULTS_DIR, `${batchId}.json`);
}
function loadBatches() {
  return readJson(BATCHES_FILE, []);
}
function saveBatches(batches) {
  writeJson(BATCHES_FILE, batches);
}
function loadBatch(batchId) {
  return loadBatches().find((b) => b.id === batchId) || null;
}
function saveBatch(batch) {
  const batches = loadBatches();
  const idx = batches.findIndex((b) => b.id === batch.id);
  if (idx >= 0) batches[idx] = batch;
  else batches.unshift(batch);
  saveBatches(batches.slice(0, 100));
  return batch;
}
function loadResults(batchId) {
  return readJson(resultPath(batchId), []);
}
function saveResults(batchId, results) {
  writeJson(resultPath(batchId), results);
}

function normalizeDate(value, fallback) {
  const raw = value || fallback;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return fallback;
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function symbolCoverage(symbol) {
  try {
    return dataCoverage.getSymbolCoverage(symbol).coverage || {};
  } catch (_) {
    return { symbol, usable_for_batch: false, data_quality: 'unknown', status_sv: 'Datakontroll misslyckades' };
  }
}

function normalizeSymbolsForBatch(symbols) {
  const requested = symbols.map((s) => String(s).toUpperCase());
  const runnable = [];
  const skipped = [];
  for (const symbol of requested) {
    const coverage = symbolCoverage(symbol);
    if (coverage.usable_for_batch) {
      runnable.push(symbol);
    } else {
      skipped.push({
        symbol,
        data_quality: coverage.data_quality,
        status_sv: coverage.status_sv,
        reason: 'missing_data',
        message: 'För lite historik för säkert batchtest.',
        usable_for_batch: false,
      });
    }
  }
  return {
    symbols: [...new Set(runnable)],
    requested_symbols: [...new Set(requested)],
    skipped_symbols: skipped,
    skipped_reasons: skipped.map((row) => ({ symbol: row.symbol, reason: row.reason })),
  };
}

function marketLabel(group, id) {
  return group?.label_sv || group?.label || id;
}

function normalizeMarketsForBatch(markets, certificateSimulationMode) {
  const requested = safeArray(markets).length ? safeArray(markets) : ['all'];
  const hasAll = requested.includes('all');
  const controls = (() => {
    try { return marketUniverse.getMarketControls().controls || []; } catch (_) { return []; }
  })();
  const byId = new Map(controls.map((row) => [row.group_id || row.id, row]).filter(([id]) => id));
  const selected = [];
  const skipped = [];
  const disabled = [];
  const missingData = [];

  const consider = (id, fromAll) => {
    const group = marketUniverse.getGroup(id) || {};
    const control = byId.get(id) || {};
    const enabled = control.enabled_for_batch !== false && marketUniverse.groupEnabledFor(id, 'batch') !== false;
    if (!enabled) {
      const row = {
        id,
        label: marketLabel(group, id),
        reason: 'disabled_by_user',
        message: 'Marknaden är avstängd för batch från Daytrading.',
      };
      skipped.push(row);
      if (!fromAll) disabled.push(row);
      return;
    }
    if ((group?.data_status || control.data_status) === 'needs_provider' && certificateSimulationMode !== 'underlying_only') {
      const row = {
        id,
        label: marketLabel(group, id),
        reason: 'missing_data',
        message: 'Kan inte köras ännu - datakälla saknas.',
      };
      skipped.push(row);
      missingData.push(row);
      return;
    }
    selected.push(id);
  };

  if (hasAll) {
    for (const row of controls) {
      const id = row.group_id || row.id;
      if (id) consider(id, true);
    }
  } else {
    for (const id of requested) consider(id, false);
  }

  return {
    markets: [...new Set(selected)],
    requested_markets: requested,
    skipped_markets: skipped,
    skipped_market_reasons: skipped.map((row) => ({ id: row.id, reason: row.reason })),
    disabled_markets: disabled,
    missing_data_markets: missingData,
  };
}

function defaultConfig(input = {}) {
  const today = nowIso().slice(0, 10);
  const catalog = daytradingCatalog.getCatalog().strategies;
  const strategyIds = safeArray(input.strategy_ids || input.strategyIds || input.strategies)
    .filter((id) => daytradingCatalog.getStrategyById(id));
  const selected = strategyIds.length ? strategyIds : catalog.slice(0, 3).map((s) => s.id);
  const dateFrom = normalizeDate(input.date_from || input.dateFrom, today);
  const dateTo = normalizeDate(input.date_to || input.dateTo, dateFrom);
  const certificateSimulationMode = CERTIFICATE_SIMULATION_MODES.has(input.certificate_simulation_mode) ? input.certificate_simulation_mode : 'off';
  const rawSymbols = safeArray(input.symbols).length ? safeArray(input.symbols).map((s) => s.toUpperCase()) : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AAPL', 'TSLA', 'NVDA', 'QQQ'];
  const rawMarkets = safeArray(input.markets || input.market_groups || input.marketGroups).length ? safeArray(input.markets || input.market_groups || input.marketGroups) : ['all'];
  const symbolPolicy = normalizeSymbolsForBatch(rawSymbols);
  const marketPolicy = normalizeMarketsForBatch(rawMarkets, certificateSimulationMode);
  return {
    strategy_ids: selected,
    symbols: symbolPolicy.symbols,
    requested_symbols: symbolPolicy.requested_symbols,
    skipped_symbols: symbolPolicy.skipped_symbols,
    skipped_reasons: symbolPolicy.skipped_reasons,
    markets: marketPolicy.markets,
    requested_markets: marketPolicy.requested_markets,
    skipped_markets: marketPolicy.skipped_markets,
    skipped_market_reasons: marketPolicy.skipped_market_reasons,
    disabled_markets: marketPolicy.disabled_markets,
    missing_data_markets: marketPolicy.missing_data_markets,
    certificate_simulation_mode: certificateSimulationMode,
    timeframes: safeArray(input.timeframes || input.timeframe).length ? safeArray(input.timeframes || input.timeframe) : ['2m'],
    date_from: dateFrom,
    date_to: dateTo,
    stop_losses: numberArray(input.stop_losses || input.stopLosses || input.sl_values, [0.1, 0.2, 0.3]),
    take_profits: numberArray(input.take_profits || input.takeProfits || input.tp_values, [1, 1.5, 2]),
    holding_times: numberArray(input.holding_times || input.holdingTimes, [5, 8, 12]),
    timeouts: numberArray(input.timeouts, [8, 12]),
    confidence_thresholds: numberArray(input.confidence_thresholds || input.confidenceThresholds, [55, 65, 75]),
    volume_requirements: numberArray(input.volume_requirements || input.volumeRequirements, [1.2, 1.5]),
  };
}

function configSize(config) {
  return config.strategy_ids.length
    * config.symbols.length
    * config.markets.length
    * config.timeframes.length
    * config.stop_losses.length
    * config.take_profits.length
    * config.holding_times.length
    * config.timeouts.length
    * config.confidence_thresholds.length
    * config.volume_requirements.length;
}

function validateConfig(config) {
  const errors = {};
  const warnings = {};
  if (config.skipped_symbols?.length) {
    warnings.needs_data_symbols = config.skipped_symbols;
    warnings.skipped_symbols = config.skipped_symbols;
    warnings.skipped_reasons = config.skipped_reasons || config.skipped_symbols.map((row) => ({ symbol: row.symbol, reason: row.reason || 'missing_data' }));
  }
  if (config.skipped_markets?.length) {
    warnings.skipped_markets = config.skipped_markets;
    warnings.skipped_market_reasons = config.skipped_market_reasons || config.skipped_markets.map((row) => ({ id: row.id, reason: row.reason || 'missing_data' }));
  }
  if (config.strategy_ids.length > LIMITS.maxStrategiesPerBatch) errors.strategy_ids = `max_${LIMITS.maxStrategiesPerBatch}`;
  if (config.symbols.length > LIMITS.maxSymbolsPerBatch) errors.symbols = `max_${LIMITS.maxSymbolsPerBatch}`;
  if (!config.symbols.length) {
    errors.missing_data = 'no_runnable_symbols';
  }
  if (!config.markets.length) {
    errors.market_data = config.disabled_markets?.length ? 'disabled_by_user' : 'missing_data';
  }
  if (daysBetween(config.date_from, config.date_to) > LIMITS.maxDateRangeDays) errors.date_range = `max_${LIMITS.maxDateRangeDays}_days`;
  if (configSize(config) > LIMITS.maxParameterCombinations) {
    errors.parameter_combinations = 'too_large';
  }
  const unknown = config.strategy_ids.filter((id) => !daytradingCatalog.getStrategyById(id));
  if (unknown.length) errors.strategy_ids_unknown = unknown;
  if (config.missing_data_markets?.length && !config.markets.length) {
    errors.unavailable_markets = config.missing_data_markets;
  }
  if (config.disabled_markets?.length) {
    errors.market_controls = 'disabled_by_user';
    errors.batch_disabled_markets = config.disabled_markets;
  }
  if (config.certificate_simulation_mode === 'estimated_leverage') {
    errors.certificate_simulation_mode = 'estimated_leverage_not_supported_yet';
  }
  if (config.certificate_simulation_mode === 'real_certificate_data' && config.missing_data_markets?.length && !config.markets.length) {
    errors.certificate_simulation_mode = 'real_certificate_data_needs_provider';
  }
  const reason = errors.market_controls === 'disabled_by_user'
    ? 'disabled_by_user'
    : errors.missing_data || errors.market_data === 'missing_data'
      ? 'missing_data'
      : null;
  const message = errors.missing_data
    ? 'No runnable symbols with historical data'
    : errors.market_controls === 'disabled_by_user'
      ? 'En eller flera valda marknadsgrupper är avstängda av användaren.'
      : errors.market_data
        ? 'Kan inte köras ännu - datakälla saknas.'
        : errors.certificate_simulation_mode
          ? 'Valt certifikat-testläge stöds inte för körning ännu.'
          : Object.keys(errors).length ? 'Testet är för stort. Minska antal symboler eller parametrar.' : null;
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    warnings,
    reason,
    message,
  };
}

function buildParameterGrid(configInput = {}) {
  const config = defaultConfig(configInput);
  const validation = validateConfig(config);
  const grid = [];
  if (!validation.ok) {
    return cleanValue({
      ok: false,
      config,
      grid: [],
      count: configSize(config),
      limits: LIMITS,
      error: validation.message,
      reason: validation.reason,
      errors: validation.errors,
      warnings: validation.warnings,
      skipped_symbols: config.skipped_symbols || [],
      skipped_reasons: config.skipped_reasons || [],
      skipped_markets: config.skipped_markets || [],
      ...SAFETY,
    });
  }
  for (const strategyId of config.strategy_ids) {
    const strategy = daytradingCatalog.getStrategyById(strategyId);
    for (const symbol of config.symbols) {
      for (const market of config.markets) {
        for (const timeframe of config.timeframes) {
          for (const stopLoss of config.stop_losses) {
            for (const takeProfit of config.take_profits) {
              for (const holdingTime of config.holding_times) {
                for (const timeout of config.timeouts) {
                  for (const confidence of config.confidence_thresholds) {
                    for (const volume of config.volume_requirements) {
                      grid.push({
                        strategy_id: strategy.id,
                        strategy_name: strategy.name,
                        symbol,
                        market_group: market === 'all' ? strategy.market_group : market,
                        certificate_simulation_mode: config.certificate_simulation_mode,
                        timeframe,
                        date_from: config.date_from,
                        date_to: config.date_to,
                        stop_loss: stopLoss,
                        take_profit: takeProfit,
                        holding_time: holdingTime,
                        timeout,
                        confidence_threshold: confidence,
                        volume_requirement: volume,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return cleanValue({ ok: true, config, grid, count: grid.length, limits: LIMITS, warnings: validation.warnings, ...SAFETY });
}

function createBatchTest(input = {}) {
  const config = defaultConfig(input);
  const validation = validateConfig(config);
  if (!validation.ok) {
    return cleanValue({
      ok: false,
      error: validation.message,
      reason: validation.reason,
      errors: validation.errors,
      combination_count: configSize(config),
      limits: LIMITS,
      warnings: validation.warnings,
      skipped_symbols: config.skipped_symbols || [],
      skipped_reasons: config.skipped_reasons || [],
      skipped_markets: config.skipped_markets || [],
      ...SAFETY,
    });
  }
  const grid = buildParameterGrid(config);
  const createdAt = nowIso();
  const batch = {
    id: input.id || `batch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    name: input.name || `Strategy batch ${new Date().toLocaleDateString('sv-SE')}`,
    metadata: input.metadata && typeof input.metadata === 'object' ? cleanValue(input.metadata) : {},
    created_at: createdAt,
    batch_created_at: createdAt,
    updated_at: createdAt,
    batch_started_at: null,
    batch_completed_at: null,
    last_run_at: null,
    status: 'created',
    config,
    coverage_warnings: validation.warnings,
    needs_data_symbols: validation.warnings.needs_data_symbols || [],
    skipped_symbols: config.skipped_symbols || [],
    skipped_reasons: config.skipped_reasons || [],
    skipped_markets: config.skipped_markets || [],
    progress: {
      total: grid.count,
      completed: 0,
      failed: 0,
      pct: 0,
    },
    started_at: null,
    completed_at: null,
    error: null,
    limits: LIMITS,
    ...SAFETY,
  };
  saveBatch(batch);
  saveResults(batch.id, []);
  auditTrail.logAuditEvent({
    type: 'BATCH_CREATED',
    source: 'strategy_batch',
    timestamp: batch.batch_created_at,
    message: 'Batch-test skapat',
    details: { batch_id: batch.id, name: batch.name, combination_count: grid.count, config: batch.config },
  });
  return cleanValue({ ok: true, batch, combination_count: grid.count, ...SAFETY });
}

function activeRunCount() {
  return [...activeRunners.values()].filter((r) => r.running).length;
}

function scoreCombination(row) {
  const timeoutRate = row.trades ? (row.timeouts / row.trades) * 100 : 100;
  const sampleBonus = Math.min(18, row.trades * 0.8);
  const wr = Math.min(36, row.win_rate * 0.36);
  const pnl = Math.max(-20, Math.min(28, row.avg_pnl * 180));
  const timeoutPenalty = Math.min(18, timeoutRate * 0.35);
  const ddPenalty = Math.min(18, Math.abs(row.max_drawdown) * 10);
  const consistency = Math.max(0, 18 - Math.abs(row.avg_pnl) * 12 - timeoutRate * 0.08);
  return Math.round(Math.max(0, Math.min(100, sampleBonus + wr + pnl + consistency - timeoutPenalty - ddPenalty + 15)));
}

function sampleQuality(trades) {
  if (trades >= 50) return 'high';
  if (trades >= 25) return 'medium';
  if (trades >= 10) return 'low';
  return 'needs_more_data';
}

function instrumentMeta(combo = {}) {
  const group = marketUniverse.getGroup(combo.market_group) || {};
  return {
    underlying_symbol: combo.underlying_symbol || combo.underlyingSymbol || combo.signal_symbol || combo.signalSymbol || combo.symbol,
    underlying_market: combo.underlying_market || combo.underlyingMarket || combo.market_group,
    underlying_signal_direction: combo.underlying_signal_direction || combo.underlyingSignalDirection || null,
    underlying_signal_strength: Number.isFinite(Number(combo.underlying_signal_strength ?? combo.underlyingSignalStrength ?? combo.confidence_threshold))
      ? Number(combo.underlying_signal_strength ?? combo.underlyingSignalStrength ?? combo.confidence_threshold)
      : null,
    traded_symbol: combo.traded_symbol || combo.tradedSymbol || combo.symbol,
    traded_instrument_type: combo.traded_instrument_type || combo.tradedInstrumentType || combo.instrument_type || combo.instrumentType || group.product_type || null,
    risk_class: combo.risk_class || combo.riskClass || group.risk_class || null,
    leverage_factor: Number.isFinite(Number(combo.leverage_factor ?? combo.leverageFactor ?? combo.leverage))
      ? Number(combo.leverage_factor ?? combo.leverageFactor ?? combo.leverage)
      : null,
    spread_estimate: Number.isFinite(Number(combo.spread_estimate ?? combo.spreadEstimate ?? combo.spread_percent ?? combo.spreadPct))
      ? Number(combo.spread_estimate ?? combo.spreadEstimate ?? combo.spread_percent ?? combo.spreadPct)
      : null,
    tracking_quality: combo.tracking_quality || combo.trackingQuality || null,
  };
}

function normalizeBatchResult(batchId, combo, saved) {
  const result = saved.result || saved;
  const createdAt = nowIso();
  const completedAt = nowIso();
  const runDuration = durationSeconds(createdAt, completedAt);
  const row = {
    batch_id: batchId,
    run_created_at: createdAt,
    run_started_at: createdAt,
    run_completed_at: completedAt,
    duration_seconds: runDuration,
    duration_label: durationLabel(runDuration),
    strategy_id: combo.strategy_id,
    strategy_name: combo.strategy_name,
    symbol: combo.symbol,
    market_group: combo.market_group,
    certificate_simulation_mode: combo.certificate_simulation_mode || 'off',
    timeframe: combo.timeframe,
    date_from: combo.date_from,
    date_to: combo.date_to,
    stop_loss: combo.stop_loss,
    take_profit: combo.take_profit,
    holding_time: combo.holding_time,
    timeout: combo.timeout,
    confidence_threshold: combo.confidence_threshold,
    volume_requirement: combo.volume_requirement,
    trades: result.trades || 0,
    wins: result.wins || 0,
    losses: result.losses || 0,
    timeouts: result.timeouts || 0,
    win_rate: result.win_rate || 0,
    avg_pnl: result.avg_pnl || 0,
    total_pnl: result.total_pnl || 0,
    max_drawdown: result.max_drawdown || 0,
    score: 0,
    sample_quality: sampleQuality(result.trades || 0),
    ...instrumentMeta(combo),
    paper_pnl_percent: result.total_pnl || 0,
    underlying_move_percent: result.underlying_move_percent || result.underlyingMovePercent || null,
    created_at: createdAt,
    source: 'batch_test',
    mode: 'paper_replay',
    live: false,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
  };
  row.score = scoreCombination(row);
  return row;
}

function runOneCombination(batchId, combo) {
  const saved = strategyPerformance.saveSimulatedStrategyTest({
    batch_id: batchId,
    strategy_id: combo.strategy_id,
    symbols: [combo.symbol],
    market_group: combo.market_group,
    ...instrumentMeta(combo),
    timeframe: combo.timeframe,
    sl: combo.stop_loss,
    tp: combo.take_profit,
    holding_time: combo.holding_time,
    timeout: combo.timeout,
    confidence_threshold: combo.confidence_threshold,
    volume_requirement: combo.volume_requirement,
    source: 'batch_test',
    live: false,
    mode: 'paper_replay',
    certificate_simulation_mode: combo.certificate_simulation_mode || 'off',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
  });
  return normalizeBatchResult(batchId, combo, saved);
}

function runBatchTest(batchId) {
  const batch = loadBatch(batchId);
  if (!batch) return cleanValue({ ok: false, error: 'batch_not_found', ...SAFETY });
  if (batch.status === 'completed') return cleanValue({ ok: true, batch, message: 'already_completed', ...SAFETY });
  if (activeRunners.has(batchId)) return cleanValue({ ok: true, batch, message: 'already_running', ...SAFETY });
  if (activeRunCount() >= LIMITS.maxConcurrentRuns) return cleanValue({ ok: false, error: 'max_concurrent_runs_reached', limits: LIMITS, ...SAFETY });

  const gridResult = buildParameterGrid(batch.config);
  if (!gridResult.ok) {
    return cleanValue({
      ok: false,
      error: gridResult.error,
      reason: gridResult.reason,
      errors: gridResult.errors,
      warnings: gridResult.warnings,
      skipped_symbols: gridResult.skipped_symbols || [],
      skipped_markets: gridResult.skipped_markets || [],
      limits: LIMITS,
      ...SAFETY,
    });
  }

  const existing = loadResults(batchId);
  const runner = {
    running: true,
    paused: false,
    stopped: false,
    index: Math.min(existing.length, gridResult.grid.length),
    grid: gridResult.grid,
  };
  activeRunners.set(batchId, runner);

  batch.status = 'running';
  const startedAt = nowIso();
  batch.started_at = batch.started_at || startedAt;
  batch.batch_started_at = batch.batch_started_at || batch.started_at;
  batch.last_run_at = startedAt;
  batch.updated_at = startedAt;
  batch.progress = {
    total: gridResult.grid.length,
    completed: existing.length,
    failed: batch.progress?.failed || 0,
    pct: gridResult.grid.length ? round((existing.length / gridResult.grid.length) * 100, 2) : 0,
  };
  saveBatch(batch);
  auditTrail.logAuditEvent({
    type: 'BATCH_STARTED',
    source: 'strategy_batch',
    timestamp: startedAt,
    message: 'Batch-test startat',
    details: { batch_id: batch.id, name: batch.name, progress: batch.progress },
  });

  setImmediate(() => processRunner(batchId));
  return cleanValue({ ok: true, batch, started: true, ...SAFETY });
}

function processRunner(batchId) {
  const runner = activeRunners.get(batchId);
  if (!runner || !runner.running) return;
  const batch = loadBatch(batchId);
  if (!batch) {
    activeRunners.delete(batchId);
    return;
  }
  if (runner.stopped || batch.status === 'stopped') {
    runner.running = false;
    activeRunners.delete(batchId);
    batch.status = 'stopped';
    batch.updated_at = nowIso();
    saveBatch(batch);
    auditTrail.logAuditEvent({
      type: 'BATCH_STOPPED',
      source: 'strategy_batch',
      timestamp: batch.updated_at,
      message: 'Batch-test stoppat',
      details: { batch_id: batch.id, name: batch.name, progress: batch.progress },
    });
    return;
  }
  if (runner.paused || batch.status === 'paused') {
    runner.running = false;
    activeRunners.delete(batchId);
    batch.status = 'paused';
    batch.updated_at = nowIso();
    saveBatch(batch);
    auditTrail.logAuditEvent({
      type: 'BATCH_PAUSED',
      source: 'strategy_batch',
      timestamp: batch.updated_at,
      message: 'Batch-test pausat',
      details: { batch_id: batch.id, name: batch.name, progress: batch.progress },
    });
    return;
  }

  const started = Date.now();
  const results = loadResults(batchId);
  let failed = batch.progress?.failed || 0;
  while (runner.index < runner.grid.length && Date.now() - started < LIMITS.timeoutPerRunMs) {
    try {
      const combo = runner.grid[runner.index];
      results.push(runOneCombination(batchId, combo));
    } catch (_) {
      failed += 1;
    }
    runner.index += 1;
  }
  saveResults(batchId, results);
  batch.progress = {
    total: runner.grid.length,
    completed: runner.index,
    failed,
    pct: runner.grid.length ? round((runner.index / runner.grid.length) * 100, 2) : 100,
  };
  batch.updated_at = nowIso();
  if (runner.index >= runner.grid.length) {
    batch.status = 'completed';
    batch.completed_at = nowIso();
    batch.batch_completed_at = batch.completed_at;
    const batchDuration = durationSeconds(batch.batch_started_at || batch.started_at, batch.batch_completed_at);
    batch.duration_seconds = batchDuration;
    batch.duration_label = durationLabel(batchDuration);
    activeRunners.delete(batchId);
  } else {
    batch.status = 'running';
  }
  saveBatch(batch);
  auditTrail.logAuditEvent({
    type: batch.status === 'completed' ? 'BATCH_COMPLETED' : 'BATCH_PROGRESS',
    source: 'strategy_batch',
    timestamp: batch.updated_at,
    message: batch.status === 'completed' ? 'Batch-test klart' : 'Batch-test uppdaterat',
    details: {
      batch_id: batch.id,
      name: batch.name,
      progress: batch.progress,
      duration_seconds: batch.duration_seconds || durationSeconds(batch.batch_started_at || batch.started_at, batch.updated_at),
      duration_label: batch.duration_label || durationLabel(durationSeconds(batch.batch_started_at || batch.started_at, batch.updated_at)),
    },
  });
  if (batch.status === 'running') setTimeout(() => processRunner(batchId), 10);
}

function pauseBatchTest(batchId) {
  const batch = loadBatch(batchId);
  if (!batch) return cleanValue({ ok: false, error: 'batch_not_found', ...SAFETY });
  const runner = activeRunners.get(batchId);
  if (runner) runner.paused = true;
  batch.status = 'paused';
  batch.updated_at = nowIso();
  saveBatch(batch);
  auditTrail.logAuditEvent({
    type: 'BATCH_PAUSED',
    source: 'strategy_batch',
    timestamp: batch.updated_at,
    message: 'Batch-test pausat',
    details: { batch_id: batch.id, name: batch.name, progress: batch.progress },
  });
  return cleanValue({ ok: true, batch, ...SAFETY });
}

function stopBatchTest(batchId) {
  const batch = loadBatch(batchId);
  if (!batch) return cleanValue({ ok: false, error: 'batch_not_found', ...SAFETY });
  const runner = activeRunners.get(batchId);
  if (runner) runner.stopped = true;
  batch.status = 'stopped';
  batch.updated_at = nowIso();
  saveBatch(batch);
  auditTrail.logAuditEvent({
    type: 'BATCH_STOPPED',
    source: 'strategy_batch',
    timestamp: batch.updated_at,
    message: 'Batch-test stoppat',
    details: { batch_id: batch.id, name: batch.name, progress: batch.progress },
  });
  return cleanValue({ ok: true, batch, ...SAFETY });
}

function getBatchTestStatus(batchId) {
  const batch = loadBatch(batchId);
  if (!batch) return cleanValue({ ok: false, error: 'batch_not_found', ...SAFETY });
  return cleanValue({ ok: true, batch, active: activeRunners.has(batchId), ...SAFETY });
}

function rankResults(results) {
  return [...results].sort((a, b) => b.score - a.score);
}

function bestBy(results, key) {
  const byKey = new Map();
  for (const row of results) {
    const k = row[key] || 'unknown';
    const prev = byKey.get(k);
    if (!prev || row.score > prev.score) byKey.set(k, row);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

function getBatchTestResults(batchId) {
  const status = getBatchTestStatus(batchId);
  if (!status.ok) return status;
  const results = loadResults(batchId);
  const ranked = rankResults(results);
  return cleanValue({
    ok: true,
    batch: status.batch,
    count: results.length,
    results,
    top: ranked.slice(0, 20),
    worst: [...results].sort((a, b) => a.score - b.score).slice(0, 20),
    needs_more_data: results.filter((r) => r.sample_quality === 'needs_more_data' || r.sample_quality === 'low').slice(0, 50),
    ...SAFETY,
  });
}

function aggregateField(results, key) {
  const groups = new Map();
  for (const row of results) {
    const k = row[key] ?? 'unknown';
    if (!groups.has(k)) groups.set(k, { key: k, runs: 0, trades: 0, wins: 0, timeouts: 0, total_pnl: 0, max_drawdown: 0, score_sum: 0 });
    const g = groups.get(k);
    g.runs += 1;
    g.trades += row.trades || 0;
    g.wins += row.wins || 0;
    g.timeouts += row.timeouts || 0;
    g.total_pnl += row.total_pnl || 0;
    g.max_drawdown = Math.max(g.max_drawdown, row.max_drawdown || 0);
    g.score_sum += row.score || 0;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    win_rate: g.trades ? round((g.wins / g.trades) * 100, 2) : 0,
    timeout_rate: g.trades ? round((g.timeouts / g.trades) * 100, 2) : 0,
    avg_pnl: g.trades ? round(g.total_pnl / g.trades, 4) : 0,
    avg_score: g.runs ? round(g.score_sum / g.runs, 2) : 0,
  })).sort((a, b) => b.avg_score - a.avg_score);
}

function compareBatchResults(batchId) {
  const status = getBatchTestStatus(batchId);
  if (!status.ok) return status;
  const results = loadResults(batchId);
  const ranked = rankResults(results);
  return cleanValue({
    ok: true,
    batch: status.batch,
    total_results: results.length,
    best_overall: ranked.slice(0, 10),
    worst_overall: [...results].sort((a, b) => a.score - b.score).slice(0, 10),
    best_per_strategy: bestBy(results, 'strategy_id'),
    best_per_symbol: bestBy(results, 'symbol'),
    best_per_market: bestBy(results, 'market_group'),
    needs_more_data: results.filter((r) => r.sample_quality === 'needs_more_data' || r.sample_quality === 'low'),
    by_stop_loss: aggregateField(results, 'stop_loss'),
    by_take_profit: aggregateField(results, 'take_profit'),
    by_holding_time: aggregateField(results, 'holding_time'),
    by_confidence: aggregateField(results, 'confidence_threshold'),
    by_symbol: aggregateField(results, 'symbol'),
    recommended_config: ranked[0] || {},
    ...SAFETY,
  });
}

function listBatchTests() {
  const batches = loadBatches();
  return cleanValue({
    ok: true,
    batches,
    count: batches.length,
    active_count: activeRunCount(),
    limits: LIMITS,
    ...SAFETY,
  });
}

function getLatestBatchComparison() {
  const batches = loadBatches()
    .filter((b) => ['completed', 'running', 'paused', 'stopped'].includes(b.status))
    .filter((b) => (b.progress?.completed || 0) > 0);
  const latest = batches.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!latest) return cleanValue({ ok: true, batch: {}, ...SAFETY });
  return compareBatchResults(latest.id);
}

module.exports = {
  SAFETY,
  LIMITS,
  createBatchTest,
  runBatchTest,
  pauseBatchTest,
  stopBatchTest,
  getBatchTestStatus,
  getBatchTestResults,
  listBatchTests,
  buildParameterGrid,
  compareBatchResults,
  getLatestBatchComparison,
};
