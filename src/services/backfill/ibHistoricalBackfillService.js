'use strict';

const fs = require('fs');
const path = require('path');

const candleAggregator = require('../../data/candleAggregator');
const planner = require('./ibHistoricalBackfillPlanner');
const validator = require('./ibHistoricalBackfillValidator');
const futuresMarketHours = require('../futuresMarketHoursService');
const contractProvenance = require('./canonicalContractProvenanceService');
const { createIbHistoricalBackfillManifest } = require('./ibHistoricalBackfillManifest');
const { createIbHistoricalBackfillProgressTracker } = require('./ibHistoricalBackfillProgressTracker');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  readOnly: true,
  source: 'ib_historical_backfill_service',
});

const DEFAULT_MARKET_DATA_ROOT = path.resolve(__dirname, '../../../data/market-data');
const DEFAULT_PACING_MS = 15500;

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function appendJsonl(file, rows = []) {
  if (!rows.length) return 0;
  ensureDir(file);
  fs.appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return rows.length;
}

function contractPathSegment(contractKey) {
  return contractKey ? path.join('contracts', encodeURIComponent(String(contractKey))) : '';
}

function rawFileFor(root, date, marketDataRoot = DEFAULT_MARKET_DATA_ROOT, contractKey = null) {
  return path.join(marketDataRoot, 'ib', 'raw', root, contractPathSegment(contractKey), `${date}.jsonl`);
}

function candles2mFileFor(root, date, marketDataRoot = DEFAULT_MARKET_DATA_ROOT, contractKey = null) {
  return path.join(marketDataRoot, 'candles-2m', root, contractPathSegment(contractKey), `${date}.jsonl`);
}

function toIbUtcDateTime(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function nowIso(clock) {
  return new Date(typeof clock === 'function' ? clock() : Date.now()).toISOString();
}

function isRetryableHistoricalError(error) {
  const value = String(error || '').toLowerCase();
  if (/error 200|no security definition|no data|historical unavailable|contract_|active_window|validation_failed|provenance|timestamp_conflict|monotonic/.test(value)) return false;
  if (/timeout|disconnect|pacing|socket|connection|temporar/.test(value)) return true;
  return true;
}

function timestampOf(row = {}) {
  return validator._internal.toIso(row.ts || row.t || row.timestamp || row.epoch || row.time);
}

function normalizeNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function firstValue(row = {}, names = []) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return null;
}

function normalizeDownloadedBars(rows = [], segment = {}, { downloadedAt = null } = {}) {
  const contract = segment.contract || {};
  return rows
    .map((row) => {
      const ts = timestampOf(row);
      if (!ts) return null;
      const open = normalizeNumber(firstValue(row, ['open', 'o']));
      const high = normalizeNumber(firstValue(row, ['high', 'h']));
      const low = normalizeNumber(firstValue(row, ['low', 'l']));
      const close = normalizeNumber(firstValue(row, ['close', 'c']));
      if (![open, high, low, close].every(Number.isFinite)) return null;
      return {
        ts,
        t: ts,
        timestamp: ts,
        epoch: Math.floor(new Date(ts).getTime() / 1000),
        open,
        high,
        low,
        close,
        volume: normalizeNumber(firstValue(row, ['volume', 'v']), 0),
        tradeCount: normalizeNumber(firstValue(row, ['tradeCount', 'count']), null),
        source: 'ib',
        provider: 'ibkr',
        root: segment.root || contract.root || contract.symbol || null,
        symbol: segment.root || contract.root || contract.symbol || null,
        conId: text(contract.conId),
        localSymbol: text(contract.localSymbol),
        expiry: text(contract.expiry || contract.lastTradeDateOrContractMonth),
        exchange: text(contract.exchange) || 'CME',
        currency: text(contract.currency) || 'USD',
        contractKey: segment.contractKey || planner.contractKey(contract),
        barSize: '1 min',
        backfillRunId: segment.runId || null,
        correlationId: segment.correlationId || segment.runId || null,
        backfillSegmentId: segment.id || null,
        downloadedAt,
        tradingDay: futuresMarketHours.buildFuturesSessionMetadata(ts)?.tradingDay || null,
        session: futuresMarketHours.buildFuturesSessionMetadata(ts)?.sessionId || null,
        provenanceQuality: contractProvenance.PROVENANCE.EXACT,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

function identityOf(row = {}) {
  return validator._internal.contractIdentity(row);
}

function compactRow(row = {}) {
  return {
    open: normalizeNumber(row.open ?? row.o),
    high: normalizeNumber(row.high ?? row.h),
    low: normalizeNumber(row.low ?? row.l),
    close: normalizeNumber(row.close ?? row.c),
    volume: normalizeNumber(row.volume ?? row.v, 0),
    tradeCount: normalizeNumber(row.tradeCount ?? row.count, null),
    conId: text(row.conId),
    localSymbol: text(row.localSymbol),
    expiry: text(row.expiry || row.lastTradeDateOrContractMonth),
  };
}

function valuesMatch(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'number' || typeof b === 'number') {
    return Math.abs(Number(a) - Number(b)) <= 1e-9;
  }
  return String(a) === String(b);
}

function rowsEquivalent(a = {}, b = {}, fields = Object.keys(compactRow(a))) {
  const left = compactRow(a);
  const right = compactRow(b);
  return fields.every((field) => valuesMatch(left[field], right[field]));
}

function physicalMonotonic(rows = []) {
  let previous = null;
  for (const row of rows) {
    const ts = timestampOf(row);
    if (!ts) continue;
    if (previous && ts < previous) return false;
    previous = ts;
  }
  return true;
}

function prepareAppendByTimestamp(file, incoming = [], options = {}) {
  const kind = options.kind || 'rows';
  const compareFields = options.compareFields || ['open', 'high', 'low', 'close', 'volume'];
  const expectedIdentity = options.expectedIdentity || null;
  const checkContractIdentity = options.checkContractIdentity === true;
  const existing = readJsonl(file);
  if (!physicalMonotonic(existing)) {
    return { ok: false, error: `${kind}_existing_file_not_monotonic`, file, existingCount: existing.length };
  }

  if (checkContractIdentity) {
    const existingIdentities = [...new Set(existing.map(identityOf).filter(Boolean))].sort();
    if (existingIdentities.length > 1) {
      return { ok: false, error: `${kind}_existing_file_has_multiple_contracts`, file, identities: existingIdentities };
    }
    if (expectedIdentity && existingIdentities.length === 1 && existingIdentities[0] !== expectedIdentity) {
      return {
        ok: false,
        error: `${kind}_existing_contract_mismatch`,
        file,
        expectedIdentity,
        existingIdentity: existingIdentities[0],
      };
    }
  }

  const existingByTs = new Map();
  let maxExistingTs = null;
  for (const row of existing) {
    const ts = timestampOf(row);
    if (!ts) continue;
    existingByTs.set(ts, row);
    if (!maxExistingTs || ts > maxExistingTs) maxExistingTs = ts;
  }

  const toAppend = [];
  const duplicateTimestamps = [];
  const timestampConflicts = [];
  const incomingByTs = new Map();
  for (const row of incoming) {
    const ts = timestampOf(row);
    if (!ts) continue;
    if (incomingByTs.has(ts) && !rowsEquivalent(incomingByTs.get(ts), row, compareFields)) {
      timestampConflicts.push({ timestamp: ts, reason: `${kind}_incoming_timestamp_conflict` });
      continue;
    }
    incomingByTs.set(ts, row);
  }

  for (const row of [...incomingByTs.values()].sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)))) {
    const ts = timestampOf(row);
    const existingRow = existingByTs.get(ts);
    if (existingRow) {
      if (!rowsEquivalent(existingRow, row, compareFields)) {
        timestampConflicts.push({ timestamp: ts, reason: `${kind}_timestamp_conflict` });
      } else {
        duplicateTimestamps.push(ts);
      }
      continue;
    }
    toAppend.push(row);
  }

  if (timestampConflicts.length) {
    return { ok: false, error: `${kind}_timestamp_conflict`, file, conflicts: timestampConflicts.slice(0, 10) };
  }
  if (maxExistingTs && toAppend.some((row) => timestampOf(row) < maxExistingTs)) {
    return {
      ok: false,
      error: `${kind}_append_would_break_monotonic_file`,
      file,
      maxExistingTs,
      firstAppendTs: timestampOf(toAppend[0]),
    };
  }

  return {
    ok: true,
    file,
    existing,
    existingCount: existing.length,
    incomingCount: incoming.length,
    appendRows: toAppend,
    appendCount: toAppend.length,
    skippedDuplicateCount: duplicateTimestamps.length,
    duplicateTimestamps: duplicateTimestamps.slice(0, 10),
  };
}

function prepareSegmentWrite(segment = {}, bars = [], marketDataRoot = DEFAULT_MARKET_DATA_ROOT) {
  const gate = contractProvenance.gateBackfill({
    ...(segment.contract || {}),
    root: segment.root,
    contractKey: segment.contractKey,
    activeFrom: segment.contract?.activeFrom || segment.activeFrom,
    activeTo: segment.contract?.activeTo || segment.activeTo,
    readiness: segment.contract?.readiness,
    provenanceSource: segment.contract?.provenanceSource,
  });
  if (!gate.ok) return { ok: false, error: gate.errors[0] || 'contract_provenance_unverified', gate };
  const rawFile = rawFileFor(segment.root, segment.date, marketDataRoot, segment.contractKey);
  const candlesFile = candles2mFileFor(segment.root, segment.date, marketDataRoot, segment.contractKey);
  const expectedIdentity = segment.contractKey || planner.contractKey(segment.contract || {});

  const rawAppend = prepareAppendByTimestamp(rawFile, bars, {
    kind: 'raw',
    checkContractIdentity: true,
    expectedIdentity,
    compareFields: ['open', 'high', 'low', 'close', 'volume', 'tradeCount', 'conId', 'localSymbol', 'expiry'],
  });
  if (!rawAppend.ok) return { ok: false, error: rawAppend.error, raw: rawAppend };

  const combinedRaw = [...rawAppend.existing, ...rawAppend.appendRows]
    .sort((a, b) => String(timestampOf(a)).localeCompare(String(timestampOf(b))));
  const rawValidation = validator.validateBars(combinedRaw, {
    from: segment.request?.from,
    to: segment.request?.to,
    contract: { ...(segment.contract || {}), contractKey: expectedIdentity },
    session: segment.request?.session || 'cme_globex',
    timezone: segment.request?.timezone || 'UTC',
  });
  if (!rawValidation.ok) {
    return { ok: false, error: 'raw_validation_failed', raw: rawAppend, validation: { raw: rawValidation } };
  }

  const expectedCandles2m = candleAggregator.aggregate1mTo2m(combinedRaw)
    .filter((candle) => !candle.incomplete)
    .map((candle) => {
      const session = futuresMarketHours.buildFuturesSessionMetadata(candle.ts);
      return {
        ...candle,
        root: segment.root || null,
        symbol: segment.root || null,
        contractKey: expectedIdentity,
        conId: text(segment.contract?.conId),
        localSymbol: text(segment.contract?.localSymbol),
        expiry: text(segment.contract?.expiry || segment.contract?.lastTradeDateOrContractMonth),
        tradingDay: session?.tradingDay || null,
        session: session?.sessionId || null,
        provenanceQuality: contractProvenance.PROVENANCE.EXACT,
        provider: 'ibkr',
      };
    });
  const candleAppend = prepareAppendByTimestamp(candlesFile, expectedCandles2m, {
    kind: 'candles_2m',
    compareFields: ['open', 'high', 'low', 'close', 'volume'],
  });
  if (!candleAppend.ok) return { ok: false, error: candleAppend.error, raw: rawAppend, candles2m: candleAppend };

  const combinedCandles = [...candleAppend.existing, ...candleAppend.appendRows]
    .sort((a, b) => String(timestampOf(a)).localeCompare(String(timestampOf(b))));
  const aggregationValidation = validator.validateAggregation({
    bars1m: combinedRaw,
    candles2m: combinedCandles,
  });
  if (!aggregationValidation.ok) {
    return {
      ok: false,
      error: 'aggregation_validation_failed',
      raw: rawAppend,
      candles2m: candleAppend,
      validation: { raw: rawValidation, aggregation: aggregationValidation },
    };
  }

  return {
    ok: true,
    raw: rawAppend,
    candles2m: candleAppend,
    validation: {
      ok: true,
      raw: rawValidation,
      aggregation: aggregationValidation,
    },
  };
}

function commitSegmentWrite(prepared = {}) {
  if (!prepared.ok) return { ok: false, error: prepared.error || 'write_not_prepared' };
  const rawAppended = appendJsonl(prepared.raw.file, prepared.raw.appendRows);
  const candlesAppended = appendJsonl(prepared.candles2m.file, prepared.candles2m.appendRows);
  return {
    ok: true,
    raw: {
      file: prepared.raw.file,
      appended: rawAppended,
      skippedDuplicates: prepared.raw.skippedDuplicateCount,
      total: prepared.raw.existingCount + rawAppended,
    },
    candles2m: {
      file: prepared.candles2m.file,
      appended: candlesAppended,
      skippedDuplicates: prepared.candles2m.skippedDuplicateCount,
      total: prepared.candles2m.existingCount + candlesAppended,
    },
  };
}

function createIbHistoricalDownloader(options = {}) {
  const config = {
    host: options.host || process.env.IB_GATEWAY_HOST || '127.0.0.1',
    port: Number(options.port || process.env.IB_GATEWAY_PORT || 4002),
    clientId: Number(options.clientId || process.env.IB_HISTORICAL_BACKFILL_CLIENT_ID || 976),
    connectTimeoutMs: Number(options.connectTimeoutMs || 12000),
    requestTimeoutMs: Number(options.requestTimeoutMs || 45000),
    pacingMs: Number(options.pacingMs || DEFAULT_PACING_MS),
  };
  let ib = null;
  let connected = false;
  let nextReqId = 73000;
  let lastRequestAt = 0;

  function loadIbApi() {
    const mod = require('@stoqey/ib');
    return { IBApi: mod.IBApi, EventName: mod.EventName };
  }

  async function start() {
    if (connected) return { ok: true, connected: true, clientId: config.clientId, ...SAFETY };
    const { IBApi, EventName } = loadIbApi();
    ib = new IBApi({ host: config.host, port: config.port, clientId: config.clientId });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { ib.disconnect(); } catch (_) { /* ignore */ }
        connected = false;
        resolve({ ok: false, error: `ib_connect_timeout_after_${config.connectTimeoutMs}ms`, ...SAFETY });
      }, config.connectTimeoutMs);
      ib.once(EventName.nextValidId, () => {
        clearTimeout(timer);
        connected = true;
        resolve({ ok: true, connected: true, clientId: config.clientId, ...SAFETY });
      });
      ib.once(EventName.error, (err, code) => {
        if (connected) return;
        clearTimeout(timer);
        try { ib.disconnect(); } catch (_) { /* ignore */ }
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err), code: Number(code) || null, ...SAFETY });
      });
      try {
        ib.connect();
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message, ...SAFETY });
      }
    });
  }

  async function pace() {
    const waitMs = config.pacingMs - (Date.now() - lastRequestAt);
    if (waitMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        if (timer.unref) timer.unref();
      });
    }
    lastRequestAt = Date.now();
  }

  async function fetchHistoricalBars(request = {}) {
    if (!connected) {
      const started = await start();
      if (!started.ok) return { ok: false, error: started.error || 'ib_not_connected', bars: [], ...SAFETY };
    }
    await pace();
    const { EventName } = loadIbApi();
    const reqId = nextReqId++;
    const rows = [];
    const contract = {
      conId: request.contract?.conId ? Number(request.contract.conId) : undefined,
      localSymbol: request.contract?.localSymbol || undefined,
      symbol: request.root || request.contract?.symbol,
      secType: 'FUT',
      exchange: request.contract?.exchange || 'CME',
      primaryExch: request.contract?.primaryExch || request.contract?.primaryExchange || undefined,
      currency: request.contract?.currency || 'USD',
      multiplier: request.contract?.multiplier || undefined,
      tradingClass: request.contract?.tradingClass || undefined,
      lastTradeDateOrContractMonth: request.contract?.lastTradeDateOrContractMonth || request.contract?.expiry || undefined,
      includeExpired: request.includeExpired === true || request.contract?.includeExpired === true,
    };
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        ib.off(EventName.historicalData, onHistoricalData);
        ib.off(EventName.error, onError);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onHistoricalData = (eventReqId, time, open, high, low, close, volume, count) => {
        if (eventReqId !== reqId) return;
        if (String(time).startsWith('finished')) {
          finish({ ok: true, contract: request.contract || contract, bars: rows, ...SAFETY });
          return;
        }
        rows.push({ time, open, high, low, close, volume, count });
      };
      const onError = (err, code, eventReqId) => {
        if (eventReqId !== reqId) return;
        finish({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: Number(code) || null,
          bars: rows,
          ...SAFETY,
        });
      };
      const timer = setTimeout(() => {
        finish({ ok: false, error: `historical_timeout_after_${config.requestTimeoutMs}ms`, bars: rows, timedOut: true, ...SAFETY });
      }, config.requestTimeoutMs);
      ib.on(EventName.historicalData, onHistoricalData);
      ib.on(EventName.error, onError);
      try {
        ib.reqHistoricalData(
          reqId,
          contract,
          toIbUtcDateTime(request.endDateTime || request.to || ''),
          request.duration || '1 D',
          request.barSize || '1 min',
          request.whatToShow || 'TRADES',
          Number(request.useRth || 0),
          2,
          false,
        );
      } catch (err) {
        finish({ ok: false, error: err.message, bars: rows, ...SAFETY });
      }
    });
  }

  function stop() {
    try { if (ib) ib.disconnect(); } catch (_) { /* ignore */ }
    connected = false;
    return { ok: true, ...SAFETY };
  }

  return {
    SAFETY,
    config,
    start,
    stop,
    fetchHistoricalBars,
  };
}

function planFrom(inputOrPlan = {}) {
  if (inputOrPlan && Array.isArray(inputOrPlan.segments) && inputOrPlan.plannerVersion) return inputOrPlan;
  return planner.buildPlan(inputOrPlan);
}

function createIbHistoricalBackfillService(options = {}) {
  const marketDataRoot = options.marketDataRoot || DEFAULT_MARKET_DATA_ROOT;
  const downloader = options.downloader || createIbHistoricalDownloader(options.downloaderOptions || {});
  const manifest = options.manifest || createIbHistoricalBackfillManifest(options.manifestOptions || {});
  const progress = options.progress || createIbHistoricalBackfillProgressTracker(options.progressOptions || {});
  const clock = typeof options.now === 'function' ? options.now : () => new Date();

  async function tick(inputOrPlan = {}) {
    const plan = planFrom(inputOrPlan);
    progress.recordRunPlanned(plan);
    manifest.recordPlan(plan);
    if (!plan.ok) {
      manifest.recordBlocker(plan, plan.blockers[0] || { reason: plan.reason || 'plan_blocked' });
      progress.failRun(plan, { error: plan.reason || 'plan_blocked' });
      return { ok: false, status: 'blocked', error: plan.reason || 'plan_blocked', plan, ...SAFETY };
    }

    const state = progress.getRunState(plan.runId);
    if (state.paused) return { ok: true, status: 'paused', plan, state, ...SAFETY };
    progress.startRun(plan);
    const segment = progress.nextPendingSegment(plan);
    if (!segment) {
      progress.completeRun(plan, { completedSegmentCount: state.completedSegmentIds.length });
      return { ok: true, status: 'completed', plan, state: progress.getRunState(plan.runId), ...SAFETY };
    }
    if (progress.isSegmentCompleted(plan.runId, segment.id)) {
      return { ok: true, status: 'skipped_completed_segment', plan, segment, ...SAFETY };
    }

    progress.startSegment(segment);
    try {
      if (typeof downloader.start === 'function') {
        const startResult = await downloader.start();
        if (startResult && startResult.ok === false) {
          throw new Error(startResult.error || 'ib_downloader_start_failed');
        }
      }
      const download = await downloader.fetchHistoricalBars(segment.request);
      if (!download || download.ok !== true) {
        throw new Error(download?.error || 'ib_historical_download_failed');
      }
      const bars = normalizeDownloadedBars(download.bars || [], segment, { downloadedAt: nowIso(clock) });
      const downloadedValidation = validator.validateBars(bars, {
        from: segment.request.from,
        to: segment.request.to,
        contract: { ...(segment.contract || {}), contractKey: segment.contractKey },
        session: segment.request.session,
        timezone: segment.request.timezone,
      });
      if (!downloadedValidation.ok) {
        throw new Error(`downloaded_bars_validation_failed:${downloadedValidation.errors[0] || 'unknown'}`);
      }

      const prepared = prepareSegmentWrite(segment, bars, marketDataRoot);
      if (!prepared.ok) throw new Error(prepared.error || 'segment_write_prepare_failed');
      const committed = commitSegmentWrite(prepared);
      const validation = {
        ok: true,
        raw: prepared.validation.raw,
        aggregation: prepared.validation.aggregation,
      };
      const result = {
        ok: true,
        runId: plan.runId,
        correlationId: plan.correlationId,
        segmentId: segment.id,
        root: segment.root,
        date: segment.date,
        contractKey: segment.contractKey,
        raw: committed.raw,
        candles2m: committed.candles2m,
        downloader: {
          provider: 'ibkr',
          request: {
            barSize: segment.request.barSize,
            duration: segment.request.duration,
            endDateTime: segment.request.endDateTime,
            includeExpired: segment.request.includeExpired === true,
          },
        },
        validation,
        ...SAFETY,
      };
      manifest.recordSegment(segment, result);
      manifest.recordValidation(segment, validation);
      progress.completeSegment(segment, result);
      return { ok: true, status: 'segment_completed', plan, segment, result, ...SAFETY };
    } catch (err) {
      const result = {
        ok: false,
        error: err.message,
        runId: plan.runId,
        segmentId: segment.id,
        root: segment.root,
        date: segment.date,
        contractKey: segment.contractKey,
        retryable: isRetryableHistoricalError(err.message),
        ...SAFETY,
      };
      manifest.recordSegment(segment, result);
      progress.failSegment(segment, result);
      return {
        ok: false,
        status: 'failed',
        plan,
        segment,
        error: err.message,
        retryable: result.retryable,
        ...SAFETY,
      };
    }
  }

  async function runBackfill(inputOrPlan = {}, optionsForRun = {}) {
    const plan = planFrom(inputOrPlan);
    const maxSegments = Number.isFinite(Number(optionsForRun.maxSegments))
      ? Number(optionsForRun.maxSegments)
      : (plan.segments || []).length + 1;
    let last = null;
    for (let index = 0; index < maxSegments; index += 1) {
      last = await tick(plan);
      if (['completed', 'paused', 'blocked'].includes(last.status)) break;
      if (!last.ok && last.retryable !== false) break;
    }
    return last || { ok: false, status: 'empty_run', plan, ...SAFETY };
  }

  function pause(runId, payload = {}) {
    return progress.pause(runId, payload);
  }

  function resume(runId, payload = {}) {
    return progress.resume(runId, payload);
  }

  function getProgress(runId) {
    return progress.getRunState(runId);
  }

  return {
    SAFETY,
    marketDataRoot,
    downloader,
    manifest,
    progress,
    buildPlan: planner.buildPlan,
    tick,
    runBackfill,
    pause,
    resume,
    getProgress,
    files: {
      rawFileFor: (root, date, contractKey) => rawFileFor(root, date, marketDataRoot, contractKey),
      candles2mFileFor: (root, date, contractKey) => candles2mFileFor(root, date, marketDataRoot, contractKey),
    },
    _internal: {
      readJsonl,
      rawFileFor,
      candles2mFileFor,
      normalizeDownloadedBars,
      prepareAppendByTimestamp,
      prepareSegmentWrite,
      commitSegmentWrite,
      createIbHistoricalDownloader,
      toIbUtcDateTime,
    },
  };
}

module.exports = {
  SAFETY,
  DEFAULT_MARKET_DATA_ROOT,
  DEFAULT_PACING_MS,
  createIbHistoricalBackfillService,
  createIbHistoricalDownloader,
  _internal: {
    readJsonl,
    rawFileFor,
    candles2mFileFor,
    normalizeDownloadedBars,
    prepareAppendByTimestamp,
    prepareSegmentWrite,
    commitSegmentWrite,
    toIbUtcDateTime,
  },
};
