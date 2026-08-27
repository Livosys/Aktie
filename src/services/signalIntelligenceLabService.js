'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lifecycleIdentity = require('./futuresLifecycleIdentityService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');

const SAFETY = Object.freeze({
  ok: true,
  mode: 'observability_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  mutation_allowed: false,
  untouched_modules: [
    'entry_contract',
    'canonical_router',
    'guard',
    'execution_readiness',
    'ibkr',
    'risk_rules',
  ],
});

const STAGES = [
  'market_event',
  'first_setup',
  'producer_detection',
  'quality_evolution',
  'confirmation',
  'extension',
  'entry_ready',
  'candidate_created',
  'canonical',
  'entry_contract',
  'guard',
  'intent',
  'ibkr_order',
  'fill',
  'trade',
  'exit',
  'result',
];

const STAGE_LABELS = Object.freeze({
  market_event: 'Market Event',
  first_setup: 'First Setup',
  producer_detection: 'Producer Detection',
  quality_evolution: 'Quality Evolution',
  confirmation: 'Confirmation',
  extension: 'Extension',
  entry_ready: 'Entry Ready',
  candidate_created: 'Candidate',
  canonical: 'Canonical',
  entry_contract: 'Entry Contract',
  guard: 'Guard',
  intent: 'Intent',
  ibkr_order: 'IBKR Order',
  fill: 'Fill',
  trade: 'Trade',
  exit: 'Exit',
  result: 'Result',
});

const EXTENSION_SCORE = Object.freeze({
  none: 0,
  mild: 1,
  medium: 2,
  hard: 3,
  extreme: 3,
});

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : null;
  }
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function timeMs(value) {
  const iso = toIso(value);
  return iso ? new Date(iso).getTime() : null;
}

function secondsBetween(from, to) {
  const a = timeMs(from);
  const b = timeMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 1000);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function asNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const nums = values.map(asNumber).filter((v) => v != null);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function median(values) {
  const nums = values.map(asNumber).filter((v) => v != null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const middle = Math.floor(nums.length / 2);
  if (nums.length % 2) return nums[middle];
  return (nums[middle - 1] + nums[middle]) / 2;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n == null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return round((numerator / denominator) * 100, 1);
}

function hashId(parts) {
  return crypto
    .createHash('sha1')
    .update(parts.filter((part) => part != null && part !== '').map(String).join('|'))
    .digest('hex')
    .slice(0, 16);
}

function normalizeText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeSymbol(value) {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeStrategyId(value) {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : null;
}

function ymd(date) {
  return toIso(date)?.slice(0, 10) || null;
}

function ymdDaysBack(now, days) {
  const base = new Date(toIso(now) || Date.now());
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(base.getTime());
    date.setUTCDate(date.getUTCDate() - i);
    dates.push(ymd(date));
  }
  return dates.filter(Boolean);
}

function bucketTime(value, minutes = 2) {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return null;
  const size = minutes * 60 * 1000;
  return new Date(Math.floor(ms / size) * size).toISOString();
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, missing: true, rows: [], value: null };
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return { ok: true, empty: true, rows: [], value: null };
    return { ok: true, rows: [], value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message, rows: [], value: null };
  }
}

function safeReadJsonl(filePath, options = {}) {
  const {
    maxLines = 0,
    tailBytes = 0,
  } = options;
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, missing: true, file: filePath, rows: [], bytesRead: 0, totalBytes: 0, truncated: false, parseErrors: 0 };
    }
    const stat = fs.statSync(filePath);
    let raw = '';
    let truncated = false;
    if (tailBytes && Number.isFinite(tailBytes) && stat.size > tailBytes) {
      const fd = fs.openSync(filePath, 'r');
      const start = stat.size - tailBytes;
      const buffer = Buffer.alloc(tailBytes);
      fs.readSync(fd, buffer, 0, tailBytes, start);
      fs.closeSync(fd);
      raw = buffer.toString('utf8');
      truncated = true;
      const firstBreak = raw.indexOf('\n');
      if (firstBreak >= 0) raw = raw.slice(firstBreak + 1);
    } else {
      raw = fs.readFileSync(filePath, 'utf8');
    }
    let lines = raw.split('\n').filter((line) => line.trim());
    if (maxLines && lines.length > maxLines) lines = lines.slice(-maxLines);
    const rows = [];
    let parseErrors = 0;
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch (_) {
        parseErrors += 1;
      }
    }
    return {
      ok: true,
      file: filePath,
      rows,
      bytesRead: Buffer.byteLength(raw),
      totalBytes: stat.size,
      truncated,
      parseErrors,
    };
  } catch (err) {
    return { ok: false, error: err.message, file: filePath, rows: [], bytesRead: 0, totalBytes: 0, truncated: false, parseErrors: 0 };
  }
}

function listJsonlFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (_) {
    return [];
  }
}

function extensionRank(level) {
  const normalized = normalizeText(level)?.toLowerCase();
  return EXTENSION_SCORE[normalized || 'none'] ?? 0;
}

function strongestExtension(a, b) {
  if (extensionRank(b) > extensionRank(a)) return normalizeText(b)?.toLowerCase() || a || 'none';
  return normalizeText(a)?.toLowerCase() || normalizeText(b)?.toLowerCase() || 'none';
}

function normalizeBlocker(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const lower = raw
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o');

  if (lower.includes('extended_move') || lower.includes('for langt') || lower.includes('extended')) return 'extended_move';
  if (lower.includes('status_not_ready') || lower.includes('status ar inte entry-ready') || lower.includes('not_entry_ready')) return 'entry_status_not_ready';
  if (lower.includes('status_wait')) return 'status_wait';
  if (lower.includes('status_caution')) return 'status_caution';
  if (lower.includes('caution_only')) return 'paper_entry_caution_only';
  if (lower.includes('not_ready')) return 'entry_status_not_ready';
  if (lower.includes('market_closed') || lower.includes('marknaden ar stangd')) return 'market_closed';
  if (lower.includes('not active') || lower.includes('inte aktiv') || lower.includes('allowlist')) return 'strategy_not_active';
  if (lower.includes('max_open_broker_positions')) return 'max_open_broker_positions';
  if (lower.includes('duplicate')) return 'duplicate_candidate';
  if (lower.includes('ibkr_order_rejected') || lower.includes('order_rejected')) return 'ibkr_order_rejected';
  if (lower.includes('ibkr_order_cancelled') || lower.includes('order_cancelled')) return 'ibkr_order_cancelled';
  if (lower.includes('manual_user_initiated_required')) return 'manual_user_initiated_required';
  if (lower.includes('paper_only_ack_required')) return 'paper_only_ack_required';
  if (lower.includes('protective_bracket')) return 'protective_bracket_required';
  if (lower.includes('real_submit_gate')) return 'real_submit_gate_closed';
  if (lower.includes('idempotency_key_required')) return 'idempotency_key_required';

  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_blocker';
}

function blockerLabel(code) {
  return String(code || 'unknown_blocker')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferStrategyFromSignalShape(row = {}) {
  const direct = normalizeStrategyId(
    row.strategyId
    || row.resolvedStrategyId
    || row.strategy
    || row.strategy_id
    || row.metadata?.strategy_id
    || row.metadata?.strategyId
    || row.metadata?.resolved_strategy_id
  );
  if (direct && direct !== 'no_trade') return direct;

  const text = [
    row.eventType,
    row.raw_signal,
    row.signal,
    row.state,
    row.signalFamily,
    row.signalSubtype,
    row.narrowType,
    row.metadata?.signal_family,
    row.metadata?.signal_subtype,
  ].filter(Boolean).join(' ').toUpperCase();

  if (text.includes('EMA_PULLBACK') || text.includes('EMA_TREND_PULLBACK')) return 'ema_pullback_continuation';
  if (text.includes('VWAP') && (text.includes('BREAKOUT') || text.includes('RECLAIM') || text.includes('LONG'))) return 'vwap_volume_breakout_long';
  if (text.includes('NARROW') || text.includes('LOW_VOLATILITY') || text.includes('EXPANSION')) return 'narrow_state_expansion_long';
  if (text.includes('REGULAR_PULLBACK')) return 'trend_continuation';
  return null;
}

function isSetupLike(row = {}) {
  const eventType = String(row.eventType || row.raw_signal || '').toUpperCase();
  const signal = String(row.signal || row.raw_signal || '').toUpperCase();
  const state = String(row.state || '').toUpperCase();
  if (signal.includes('TRIGGERED')) return true;
  if (eventType && !['NO_TRADE', 'WAIT', 'THREE_FINGER_SPREAD_AVOID'].includes(eventType)) return true;
  if (state.includes('NARROW') && !state.includes('AVOID')) return true;
  return false;
}

function eventTime(row = {}) {
  return toIso(row.timestamp || row.createdAt || row.generatedAt || row.at || row.recordedAt || row.archivedAt || row.openedAt || row.closedAt);
}

function candidateTime(row = {}) {
  return toIso(row.createdAt || row.timestamp || row.signalTimestamp || row.archivedAt || row.at);
}

function collectMetrics(row = {}) {
  const evidence = row.producerEntryReadiness?.evidence || row.evidence || {};
  const closedCandle = evidence.closedCandle || {};
  const extensionMeta = row.extensionMeta || {};
  const volume = evidence.volume || {};
  const metrics = {
    price: asNumber(row.price ?? row.entryPrice ?? row.referencePrice ?? evidence.price ?? evidence.emaContext?.price ?? evidence.vwapContext?.price),
    tradeScore: asNumber(row.tradeScore ?? row.score ?? row.confidence_score ?? row.metadata?.confidence_score ?? (row.confidence != null ? row.confidence * 100 : null)),
    atr: asNumber(row.atr14 ?? row.atr ?? row.atrPoints ?? row.metadata?.atr14),
    atrMove: asNumber(extensionMeta.recentMoveAtr ?? evidence.recentMoveAtr),
    priceToZoneAtr: asNumber(extensionMeta.priceToZoneAtr ?? evidence.priceToZoneAtr),
    priceMovePct: asNumber(row.priceMovePct ?? closedCandle.netMovePct5 ?? evidence.candleScore2m?.netMovePct5),
    entryPrice: asNumber(row.entryPrice),
    referencePrice: asNumber(row.referencePrice),
    stopLoss: asNumber(row.stopLoss),
    takeProfit: asNumber(row.takeProfit),
    riskReward: asNumber(row.riskReward),
    volume: asNumber(row.volume ?? closedCandle.volume),
    rvol: asNumber(row.rvol ?? row.relVol20 ?? volume.rvol),
    volatility: asNumber(row.volatility ?? row.atrPct120 ?? row.bbwPct120),
    atrPct120: asNumber(row.atrPct120),
    bbwPct120: asNumber(row.bbwPct120),
    extensionScore: extensionRank(row.extensionLevel ?? extensionMeta.level ?? evidence.extensionLevel),
  };
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value != null));
}

function extractBlockers(row = {}) {
  const values = [];
  if (row.archiveReason) values.push(row.archiveReason);
  if (row.blockedReason) values.push(row.blockedReason);
  if (row.blocker) values.push(row.blocker);
  if (row.reason && (row.decision === 'blocked' || String(row.event_type || row.type || '').includes('blocked') || String(row.event_type || '').includes('skipped'))) values.push(row.reason);
  if (Array.isArray(row.blockers)) values.push(...row.blockers);
  if (Array.isArray(row.producerEntryReadiness?.blockers)) values.push(...row.producerEntryReadiness.blockers);
  if (Array.isArray(row.metadata?.risk_block_reasons)) values.push(...row.metadata.risk_block_reasons);
  if (Array.isArray(row.metadata?.safety_block_reasons)) values.push(...row.metadata.safety_block_reasons);
  if (row.metadata?.paper_event_type && row.decision === 'blocked') values.push(row.metadata.paper_event_type);
  return [...new Set(values.map(normalizeBlocker).filter(Boolean))];
}

function confirmationStateFromCandidate(candidate = {}) {
  const readiness = candidate.producerEntryReadiness || {};
  const evidence = readiness.evidence || candidate.evidence || {};
  const observed = new Set(Array.isArray(readiness.confirmationObserved) ? readiness.confirmationObserved : []);
  const missing = new Set(Array.isArray(readiness.missingConfirmations) ? readiness.missingConfirmations : []);

  const rows = [];
  const push = (code, passed, detail) => {
    rows.push({ code, passed: Boolean(passed), detail: detail || null });
  };

  push(
    'two_minute_confirmation',
    observed.has('two_minute_confirmation') || evidence.twoMinuteConfirmed === true,
    evidence.tf2m || evidence.timeframes?.tf2m || null,
  );
  push(
    'closed_candle_confirmation',
    observed.has('closed_candle_confirmation') || evidence.closedCandle?.confirmed === true || candidate.closedCandleConfirmed === true,
    evidence.closedCandle?.source || null,
  );
  push(
    'volume_confirmation',
    observed.has('volume_confirmation') || evidence.volume?.strong === true,
    evidence.volume?.state || null,
  );

  if (candidate.strategyId === 'ema_pullback_continuation' || observed.has('ema_pullback_reclaim') || missing.has('ema_pullback_reclaim')) {
    push('ema_pullback_reclaim', observed.has('ema_pullback_reclaim') || evidence.emaContext?.reclaimConfirmed === true, evidence.emaContext?.relation || null);
  }
  if (candidate.strategyId === 'vwap_volume_breakout_long' || observed.has('vwap_reclaim_confirmation') || missing.has('vwap_reclaim_confirmation')) {
    push('vwap_reclaim_confirmation', observed.has('vwap_reclaim_confirmation') || evidence.vwapContext?.reclaimConfirmed === true, evidence.vwapContext?.priceVsVwap || null);
  }
  if (candidate.strategyId === 'narrow_state_expansion_long' || observed.has('narrow_state_expansion') || missing.has('narrow_state_expansion')) {
    push('narrow_state_expansion', observed.has('narrow_state_expansion') || candidate.signalSubtype === 'NARROW_STATE_EXPANSION_LONG', candidate.signalSubtype || null);
  }

  return rows.map((row) => ({
    ...row,
    missing: missing.has(row.code) || !row.passed,
  }));
}

function normalizeStatusFromRecord(record) {
  if (record.flags.hasExit) return 'closed_trade';
  if (record.flags.hasTrade) return 'open_trade';
  if (record.flags.hasFill) return 'filled';
  if (record.flags.hasOrder) return 'order_sent';
  if (record.flags.hasIntent) return 'intent';
  if (record.flags.isEntryReady) return 'entry_ready';
  if (record.blockers.length) return 'stopped';
  if (record.flags.hasCandidate) return 'candidate';
  if (record.flags.hasProducerDetection) return 'detected';
  return 'setup';
}

function createLifecycleStore() {
  const records = new Map();
  const byLifecycleId = new Map();
  const byCandidateId = new Map();
  const bySignalId = new Map();
  const byIntentId = new Map();
  const byExecutionId = new Map();
  const byIdempotencyKey = new Map();
  const byTradeId = new Map();
  const bySymbolStrategy = new Map();

  function createRecord(key) {
    return {
      signalKey: key,
      lifecycleId: null,
      candidateId: null,
      signalId: null,
      intentId: null,
      executionId: null,
      idempotencyKey: null,
      tradeId: null,
      symbol: null,
      originalSymbol: null,
      strategyId: null,
      strategyName: null,
      direction: null,
      signalFamily: null,
      signalSubtype: null,
      market: null,
      timeframe: null,
      firstSeenAt: null,
      lastSeenAt: null,
      checkpoints: {},
      metrics: {
        extensionLevel: 'none',
      },
      confirmations: [],
      blockers: [],
      timeline: [],
      sourceRefs: [],
      flags: {
        hasMarketEvent: false,
        hasSetup: false,
        hasProducerDetection: false,
        hasCandidate: false,
        isEntryReady: false,
        hasCanonical: false,
        hasEntryContract: false,
        hasGuard: false,
        hasIntent: false,
        hasOrder: false,
        hasFill: false,
        hasTrade: false,
        hasExit: false,
        won: false,
      },
      _eventIds: new Set(),
    };
  }

  function indexSymbolStrategy(record) {
    if (!record.originalSymbol && !record.symbol) return;
    if (!record.strategyId) return;
    const symbol = record.originalSymbol || record.symbol;
    const indexKey = `${symbol}|${record.strategyId}`;
    if (!bySymbolStrategy.has(indexKey)) bySymbolStrategy.set(indexKey, new Set());
    bySymbolStrategy.get(indexKey).add(record.signalKey);
  }

  function mergeIdentity(record, entity = {}) {
    const identity = lifecycleIdentity.mergeIdentity({
      lifecycleId: record.lifecycleId,
      candidateId: record.candidateId,
      signalId: record.signalId,
      intentId: record.intentId,
      executionId: record.executionId,
      idempotencyKey: record.idempotencyKey,
      tradeId: record.tradeId,
    }, entity);
    const lifecycleId = normalizeText(identity.lifecycleId);
    const candidateId = normalizeText(identity.candidateId);
    const signalId = normalizeText(identity.signalId);
    const intentId = normalizeText(identity.intentId);
    const executionId = normalizeText(identity.executionId);
    const idempotencyKey = normalizeText(identity.idempotencyKey);
    const tradeId = normalizeText(identity.tradeId);

    if (lifecycleId) {
      const previousLifecycleId = record.lifecycleId;
      record.lifecycleId = lifecycleId;
      if (previousLifecycleId) byLifecycleId.set(previousLifecycleId, record.signalKey);
      byLifecycleId.set(lifecycleId, record.signalKey);
    }
    if (candidateId) {
      record.candidateId = record.candidateId || candidateId;
      byCandidateId.set(candidateId, record.signalKey);
    }
    if (signalId) {
      record.signalId = record.signalId || signalId;
      bySignalId.set(signalId, record.signalKey);
    }
    if (intentId) {
      record.intentId = record.intentId || intentId;
      byIntentId.set(intentId, record.signalKey);
    }
    if (executionId) {
      record.executionId = record.executionId || executionId;
      byExecutionId.set(executionId, record.signalKey);
    }
    if (idempotencyKey) {
      record.idempotencyKey = record.idempotencyKey || idempotencyKey;
      byIdempotencyKey.set(idempotencyKey, record.signalKey);
    }
    if (tradeId) {
      record.tradeId = record.tradeId || tradeId;
      byTradeId.set(tradeId, record.signalKey);
    }

    record.symbol = record.symbol || normalizeSymbol(entity.symbol || entity.root || entity.futuresSymbol || entity.executionSymbol);
    record.originalSymbol = record.originalSymbol || normalizeSymbol(entity.originalSymbol);
    record.strategyId = record.strategyId || normalizeStrategyId(entity.strategyId || entity.strategy || entity.strategy_id);
    record.strategyName = record.strategyName || normalizeText(entity.strategyName || entity.metadata?.strategy_name);
    record.direction = record.direction || normalizeText(entity.direction || entity.side || entity.nextMoveBias || entity.metadata?.next_move_bias);
    record.signalFamily = record.signalFamily || normalizeText(entity.signalFamily || entity.metadata?.signal_family);
    record.signalSubtype = record.signalSubtype || normalizeText(entity.signalSubtype || entity.eventType || entity.raw_signal || entity.metadata?.signal_subtype);
    record.market = record.market || normalizeText(entity.market || entity.marketType || entity.originalMarket || entity.metadata?.market_type);
    record.timeframe = record.timeframe || normalizeText(entity.timeframe);

    const metrics = collectMetrics(entity);
    for (const [key, value] of Object.entries(metrics)) {
      if (record.metrics[key] == null) record.metrics[key] = value;
    }

    const extensionLevel = entity.extensionLevel
      || entity.extensionMeta?.level
      || entity.producerEntryReadiness?.evidence?.extensionLevel
      || entity.evidence?.extensionLevel;
    if (extensionLevel) record.metrics.extensionLevel = strongestExtension(record.metrics.extensionLevel, extensionLevel);

    if (entity.realizedPnlSek != null || entity.netPnlSek != null || entity.realizedPnlUsd != null) {
      const pnl = asNumber(entity.realizedPnlSek ?? entity.netPnlSek ?? entity.realizedPnlUsd);
      if (pnl != null) {
        record.metrics.pnl = pnl;
        record.flags.won = pnl > 0;
      }
    }

    indexSymbolStrategy(record);
  }

  function findNearby(entity = {}) {
    const strategyId = normalizeStrategyId(entity.strategyId || entity.strategy || entity.strategy_id);
    const symbols = [
      normalizeSymbol(entity.originalSymbol),
      normalizeSymbol(entity.symbol),
      normalizeSymbol(entity.root),
    ].filter(Boolean);
    const atMs = timeMs(entity.signalTimestamp || entity.timestamp || entity.createdAt || entity.at);
    if (!strategyId || !symbols.length || !Number.isFinite(atMs)) return null;

    let best = null;
    let bestDelta = Infinity;
    for (const symbol of symbols) {
      const indexKey = `${symbol}|${strategyId}`;
      const keys = bySymbolStrategy.get(indexKey);
      if (!keys) continue;
      for (const key of keys) {
        const record = records.get(key);
        if (!record || record.candidateId) continue;
        const setupAt = record.checkpoints.first_setup || record.checkpoints.producer_detection || record.firstSeenAt;
        const setupMs = timeMs(setupAt);
        if (!Number.isFinite(setupMs)) continue;
        const delta = atMs - setupMs;
        if (delta >= 0 && delta <= 12 * 60 * 1000 && delta < bestDelta) {
          best = record;
          bestDelta = delta;
        }
      }
    }
    return best;
  }

  function get(entity = {}) {
    const identity = lifecycleIdentity.identityFrom(entity);
    const lifecycleId = normalizeText(identity.lifecycleId);
    const candidateId = normalizeText(identity.candidateId);
    const signalId = normalizeText(identity.signalId);
    const intentId = normalizeText(identity.intentId);
    const executionId = normalizeText(identity.executionId);
    const idempotencyKey = normalizeText(identity.idempotencyKey);
    const tradeId = normalizeText(identity.tradeId);

    const mappedKey = (lifecycleId && byLifecycleId.get(lifecycleId))
      || (candidateId && byCandidateId.get(candidateId))
      || (signalId && bySignalId.get(signalId))
      || (intentId && byIntentId.get(intentId))
      || (executionId && byExecutionId.get(executionId))
      || (idempotencyKey && byIdempotencyKey.get(idempotencyKey))
      || (tradeId && byTradeId.get(tradeId));
    if (mappedKey && records.has(mappedKey)) {
      const record = records.get(mappedKey);
      mergeIdentity(record, entity);
      return record;
    }

    const nearby = findNearby(entity);
    if (nearby) {
      mergeIdentity(nearby, entity);
      return nearby;
    }

    const strategyId = normalizeStrategyId(entity.strategyId || entity.strategy || entity.strategy_id)
      || inferStrategyFromSignalShape(entity)
      || 'unknown_strategy';
    const symbol = normalizeSymbol(entity.originalSymbol || entity.symbol || entity.root) || 'UNKNOWN';
    const at = toIso(entity.signalTimestamp || entity.timestamp || entity.createdAt || entity.at || entity.archivedAt)
      || new Date(0).toISOString();
    const key = lifecycleId
      || candidateId
      || signalId
      || intentId
      || executionId
      || idempotencyKey
      || tradeId
      || `signal:${hashId([symbol, strategyId, bucketTime(at, 2) || at, entity.eventType || entity.raw_signal || entity.signal || entity.type])}`;
    const record = createRecord(key);
    records.set(key, record);
    mergeIdentity(record, {
      ...entity,
      strategyId,
      symbol,
    });
    return record;
  }

  function addEvent(entity, event) {
    const record = get(entity);
    mergeIdentity(record, entity);
    const at = toIso(event.at || event.timestamp || entity.timestamp || entity.createdAt || entity.at);
    if (!at) return record;
    const stage = STAGES.includes(event.stage) ? event.stage : 'quality_evolution';
    const eventId = event.id || hashId([record.signalKey, stage, at, event.source, event.label, event.blocker, event.status]);
    if (record._eventIds.has(eventId)) return record;
    record._eventIds.add(eventId);

    const metrics = { ...collectMetrics(entity), ...(event.metrics || {}) };
    const blocker = normalizeBlocker(event.blocker);
    const timelineEvent = {
      id: eventId,
      at,
      stage,
      stageLabel: STAGE_LABELS[stage] || stage,
      label: event.label || STAGE_LABELS[stage] || stage,
      status: event.status || null,
      source: event.source || null,
      blocker,
      blockerLabel: blocker ? blockerLabel(blocker) : null,
      metrics,
      details: event.details || null,
    };
    record.timeline.push(timelineEvent);
    record.firstSeenAt = record.firstSeenAt && record.firstSeenAt < at ? record.firstSeenAt : at;
    record.lastSeenAt = record.lastSeenAt && record.lastSeenAt > at ? record.lastSeenAt : at;
    if (!record.checkpoints[stage] || at < record.checkpoints[stage]) record.checkpoints[stage] = at;

    if (stage === 'market_event') record.flags.hasMarketEvent = true;
    if (stage === 'first_setup') record.flags.hasSetup = true;
    if (stage === 'producer_detection') record.flags.hasProducerDetection = true;
    if (stage === 'candidate_created') record.flags.hasCandidate = true;
    if (stage === 'entry_ready' && event.status !== 'blocked' && event.status !== 'not_ready') record.flags.isEntryReady = true;
    if (stage === 'canonical') record.flags.hasCanonical = true;
    if (stage === 'entry_contract') record.flags.hasEntryContract = true;
    if (stage === 'guard') record.flags.hasGuard = true;
    if (stage === 'intent') record.flags.hasIntent = true;
    if (stage === 'ibkr_order') record.flags.hasOrder = true;
    if (stage === 'fill') record.flags.hasFill = true;
    if (stage === 'trade') record.flags.hasTrade = true;
    if (stage === 'exit') record.flags.hasExit = true;

    for (const [key, value] of Object.entries(metrics)) {
      if (record.metrics[key] == null) record.metrics[key] = value;
    }
    if (metrics.extensionLevel) {
      record.metrics.extensionLevel = strongestExtension(record.metrics.extensionLevel, metrics.extensionLevel);
    }
    if (blocker) {
      record.blockers.push({
        code: blocker,
        label: blockerLabel(blocker),
        at,
        stage,
        source: event.source || null,
        delaySeconds: secondsBetween(record.checkpoints.first_setup || record.firstSeenAt, at),
        metrics,
      });
    }
    return record;
  }

  function addSourceRef(entity, sourceRef) {
    const record = get(entity);
    record.sourceRefs.push(sourceRef);
    return record;
  }

  function all() {
    return [...records.values()];
  }

  return {
    get,
    addEvent,
    addSourceRef,
    all,
    byExecutionId,
    byIdempotencyKey,
  };
}

function stageForTradingEvent(event = {}) {
  const type = String(event.event_type || event.type || '').toLowerCase();
  const source = String(event.source || '').toLowerCase();
  if (type === 'signal.detected') return 'producer_detection';
  if (type === 'strategy.matched') return 'canonical';
  if (type.includes('market_gate')) return 'entry_contract';
  if (type.includes('paper_trade') || source.includes('paper_trading')) return 'guard';
  if (type.includes('execution')) return 'ibkr_order';
  return 'quality_evolution';
}

function stageForArchiveReason(reason) {
  const code = normalizeBlocker(reason);
  if (!code) return 'result';
  if (code.startsWith('paper_entry') || code.includes('entry_status') || code === 'status_wait' || code === 'status_caution') return 'entry_contract';
  if (code.includes('ibkr') || code.includes('broker') || code.includes('max_open')) return 'guard';
  return 'result';
}

function ingestFeatureRows(store, rows, source) {
  for (const row of rows) {
    const strategyId = inferStrategyFromSignalShape(row);
    const at = eventTime(row);
    if (!at) continue;
    if (!strategyId && !isSetupLike(row)) continue;
    const entity = {
      ...row,
      strategyId,
      originalSymbol: row.originalSymbol || row.symbol,
      signalSubtype: row.eventType,
    };
    store.addEvent(entity, {
      at,
      stage: 'market_event',
      label: row.eventType || row.signal || row.state || 'Market event',
      status: row.signal || row.state || null,
      source,
      metrics: collectMetrics(row),
      details: row.actionSv || row.reasonSv || null,
    });
    if (isSetupLike(row) && strategyId) {
      store.addEvent(entity, {
        at,
        stage: 'first_setup',
        label: row.eventType || row.signal || 'Setup',
        status: row.signal || 'setup',
        source,
        metrics: collectMetrics(row),
        details: row.scoreExplanationSv || row.reasonSv || null,
      });
      store.addEvent(entity, {
        at,
        stage: 'quality_evolution',
        label: row.scoreLabel || 'Quality snapshot',
        status: row.state || null,
        source,
        metrics: collectMetrics(row),
        details: row.scoreExplanationSv || row.marketReasonSv || null,
      });
    }
  }
}

function ingestSignalHistoryRows(store, rows, source) {
  for (const row of rows) {
    const at = eventTime(row) || toIso(row.candleTs);
    if (!at) continue;
    const strategyId = inferStrategyFromSignalShape(row);
    const entity = {
      ...row,
      strategyId,
      originalSymbol: row.originalSymbol || row.symbol,
      signalTimestamp: row.candleTs || row.timestamp,
    };
    if (isSetupLike(row) && strategyId) {
      store.addEvent(entity, {
        at: toIso(row.candleTs || row.timestamp),
        stage: 'first_setup',
        label: row.eventType || row.signalSubtype || row.signal || 'Setup',
        status: row.status || row.signal || null,
        source,
        metrics: collectMetrics(row),
      });
    }
    store.addEvent(entity, {
      at,
      stage: 'producer_detection',
      label: row.signalSubtype || row.eventType || row.signal || 'Producer detected signal',
      status: row.status || null,
      source,
      metrics: collectMetrics(row),
    });
    store.addEvent(entity, {
      at,
      stage: 'quality_evolution',
      label: row.scoreLabel || 'Historical signal snapshot',
      status: row.status || null,
      source,
      metrics: collectMetrics(row),
    });
  }
}

function ingestTradingEvents(store, rows, source) {
  for (const event of rows) {
    const at = eventTime(event);
    if (!at) continue;
    const strategyId = inferStrategyFromSignalShape(event);
    if (!strategyId && !isSetupLike(event)) continue;
    const entity = {
      ...event,
      strategyId,
      originalSymbol: event.symbol,
      signalSubtype: event.metadata?.signal_subtype || event.raw_signal,
    };
    const blockers = extractBlockers(event);
    store.addEvent(entity, {
      at,
      stage: stageForTradingEvent(event),
      label: event.event_type || event.type || event.reason || 'Trading event',
      status: event.decision || event.metadata?.status || null,
      source,
      blocker: blockers[0] || null,
      metrics: collectMetrics(event),
      details: event.reason || null,
    });
    for (const blocker of blockers.slice(1)) {
      store.addEvent(entity, {
        at,
        stage: stageForTradingEvent(event),
        label: blockerLabel(blocker),
        status: 'blocked',
        source,
        blocker,
        metrics: collectMetrics(event),
        details: event.reason || null,
      });
    }
  }
}

function ingestCandidate(store, candidate, source, eventAt = null) {
  if (!candidate || typeof candidate !== 'object') return;
  const at = candidateTime(candidate) || eventAt;
  const evidence = candidate.producerEntryReadiness?.evidence || candidate.evidence || {};
  const readinessAt = toIso(evidence.generatedAt || eventAt || candidate.archivedAt || at);
  const entity = {
    ...candidate,
    strategyId: normalizeStrategyId(candidate.strategyId) || inferStrategyFromSignalShape(candidate),
    originalSymbol: candidate.originalSymbol || candidate.symbol,
  };

  store.addSourceRef(entity, { source, candidateId: candidate.candidateId || null, signalId: candidate.signalId || null });
  if (candidate.signalTimestamp) {
    store.addEvent(entity, {
      at: candidate.signalTimestamp,
      stage: 'producer_detection',
      label: candidate.signalSubtype || candidate.signalFamily || 'Producer signal timestamp',
      status: candidate.signalStatus || null,
      source,
      metrics: collectMetrics(candidate),
    });
  }
  if (at) {
    store.addEvent(entity, {
      at,
      stage: 'candidate_created',
      label: 'Candidate created',
      status: candidate.signalStatus || candidate.status || null,
      source,
      metrics: collectMetrics(candidate),
    });
    store.addEvent(entity, {
      at,
      stage: 'canonical',
      label: candidate.mappedFuturesSymbol || candidate.executionSymbol || 'Canonical candidate observed',
      status: candidate.executionTargetStatus || candidate.executionTarget || candidate.executionGate || null,
      source,
      metrics: collectMetrics(candidate),
    });
  }

  const confirmations = confirmationStateFromCandidate(candidate);
  const record = store.get(entity);
  for (const confirmation of confirmations) {
    const existingIndex = record.confirmations.findIndex((row) => row.code === confirmation.code);
    if (existingIndex >= 0) record.confirmations[existingIndex] = confirmation;
    else record.confirmations.push(confirmation);
    store.addEvent(entity, {
      at: readinessAt || at,
      stage: 'confirmation',
      label: confirmation.code,
      status: confirmation.passed ? 'passed' : 'missing',
      source,
      blocker: confirmation.passed ? null : confirmation.code,
      metrics: collectMetrics(candidate),
      details: confirmation.detail,
    });
  }

  const extensionLevel = candidate.extensionLevel || candidate.extensionMeta?.level || evidence.extensionLevel;
  if (extensionLevel && extensionLevel !== 'none') {
    store.addEvent(entity, {
      at: readinessAt || at,
      stage: 'extension',
      label: `extensionLevel=${extensionLevel}`,
      status: extensionLevel,
      source,
      blocker: extensionRank(extensionLevel) > 0 ? 'extended_move' : null,
      metrics: {
        ...collectMetrics(candidate),
        extensionLevel,
        extensionScore: extensionRank(extensionLevel),
      },
      details: (candidate.extensionMeta?.reasons || evidence.extensionReasons || []).join(', ') || null,
    });
  }

  if (candidate.producerEntryReadiness || candidate.signalStatus) {
    const entryReady = candidate.producerEntryReadiness?.entryReady === true || candidate.signalStatus === 'ready';
    const blockers = extractBlockers(candidate);
    store.addEvent(entity, {
      at: readinessAt || at,
      stage: 'entry_ready',
      label: entryReady ? 'Entry Ready' : 'Entry readiness failed',
      status: entryReady ? 'ready' : 'not_ready',
      source,
      blocker: entryReady ? null : (blockers[0] || normalizeBlocker(candidate.producerEntryReadiness?.status || candidate.signalStatus)),
      metrics: collectMetrics(candidate),
      details: candidate.producerEntryReadiness?.status || candidate.signalStatus || null,
    });
    for (const blocker of blockers.slice(entryReady ? 0 : 1)) {
      store.addEvent(entity, {
        at: readinessAt || at,
        stage: 'entry_ready',
        label: blockerLabel(blocker),
        status: 'blocked',
        source,
        blocker,
        metrics: collectMetrics(candidate),
      });
    }
  }

  if (candidate.executionTargetReservation) {
    store.addEvent(entity, {
      at: candidate.executionTargetReservation.reservedAt || candidate.executionTargetReservation.updatedAt || at,
      stage: 'intent',
      label: 'Execution target reservation',
      status: candidate.executionTargetReservation.status || (candidate.executionTargetReservation.reserved ? 'reserved' : 'not_reserved'),
      source,
      blocker: candidate.executionTargetReservation.duplicate ? 'duplicate_candidate' : null,
      metrics: collectMetrics(candidate),
    });
  }

  if (candidate.archivedAt || candidate.archiveReason) {
    const blockers = extractBlockers(candidate);
    const stage = stageForArchiveReason(candidate.archiveReason);
    store.addEvent(entity, {
      at: candidate.archivedAt || eventAt || at,
      stage,
      label: candidate.archiveReason || 'Candidate archived',
      status: candidate.status || 'archived',
      source,
      blocker: blockers[0] || null,
      metrics: collectMetrics(candidate),
    });
    store.addEvent(entity, {
      at: candidate.archivedAt || eventAt || at,
      stage: 'result',
      label: candidate.archiveReason || candidate.result || 'Archived',
      status: candidate.status || candidate.result || 'archived',
      source,
      blocker: blockers[0] || null,
      metrics: collectMetrics(candidate),
    });
  }
}

function ingestFuturesEvents(store, rows, source) {
  for (const event of rows) {
    const type = event.type || event.event_type;
    const at = eventTime(event);
    if (!type || !at) continue;
    if (Array.isArray(event.candidates)) {
      for (const candidate of event.candidates) ingestCandidate(store, candidate, source, at);
      continue;
    }
    const entity = {
      ...event,
      strategyId: event.strategyId,
    };
    if (type === 'FUTURES_QUEUE_CANDIDATE_CLAIMED') {
      store.addEvent(entity, {
        at: event.claimedAt || at,
        stage: 'intent',
        label: 'Queue candidate claimed',
        status: event.executionTarget || event.mode || null,
        source,
        metrics: collectMetrics(event),
      });
    } else if (type === 'FUTURES_QUEUE_CANDIDATE_COMPLETED') {
      const blockers = extractBlockers(event.outcome || {});
      store.addEvent(entity, {
        at,
        stage: 'result',
        label: event.outcome?.status || type,
        status: event.outcome?.status || null,
        source,
        blocker: blockers[0] || normalizeBlocker(event.outcome?.reason),
        metrics: collectMetrics(event),
      });
    } else if (type === 'FUTURES_POSITION_OPENED') {
      store.addEvent(entity, {
        at: event.openedAt || at,
        stage: 'trade',
        label: 'Position opened',
        status: 'open',
        source,
        metrics: collectMetrics(event),
      });
    } else if (type === 'FUTURES_POSITION_CLOSED') {
      store.addEvent(entity, {
        at: event.closedAt || at,
        stage: 'exit',
        label: event.exitReason || 'Position closed',
        status: 'closed',
        source,
        metrics: collectMetrics(event),
      });
      store.addEvent(entity, {
        at: event.closedAt || at,
        stage: 'result',
        label: event.exitReason || 'Trade result',
        status: asNumber(event.realizedPnlSek) > 0 ? 'win' : 'loss',
        source,
        metrics: collectMetrics(event),
      });
    }
  }
}

function ingestIntentIndex(store, value, source) {
  if (!value || typeof value !== 'object') return;
  for (const [idempotencyKey, intent] of Object.entries(value)) {
    if (!intent || typeof intent !== 'object') continue;
    const entity = {
      ...intent,
      idempotencyKey: intent.idempotencyKey || intent.idempotency_key || idempotencyKey,
    };
    const createdAt = toIso(intent.createdAt || intent.submitStartedAt || intent.updatedAt);
    if (createdAt) {
      store.addEvent(entity, {
        at: createdAt,
        stage: 'intent',
        label: 'IBKR paper intent',
        status: intent.status || null,
        source,
        blocker: intent.blocker || (intent.status === 'rejected' ? 'ibkr_order_rejected' : null),
        metrics: collectMetrics(intent),
      });
    }
    if (intent.submitStartedAt || intent.ibOrderId || intent.expectedOrderIds) {
      store.addEvent(entity, {
        at: intent.submitStartedAt || intent.updatedAt || createdAt,
        stage: 'ibkr_order',
        label: intent.orderRef || 'IBKR order submitted',
        status: intent.status || null,
        source,
        blocker: intent.blocker || (intent.status === 'rejected' ? 'ibkr_order_rejected' : null),
        metrics: collectMetrics(intent),
        details: intent.rejectedReason || intent.cancelReason || null,
      });
    }
    if (intent.filledAt || intent.filledPrice || intent.status === 'filled') {
      store.addEvent(entity, {
        at: intent.filledAt || intent.updatedAt || createdAt,
        stage: 'fill',
        label: intent.filledLeg || 'IBKR fill',
        status: 'filled',
        source,
        metrics: {
          ...collectMetrics(intent),
          price: asNumber(intent.filledPrice),
        },
      });
    }
  }
}

function ingestIntentEvents(store, rows, source) {
  for (const event of rows) {
    const at = eventTime(event);
    if (!at) continue;
    const entity = {
      ...event,
      idempotencyKey: event.idempotencyKey,
      executionId: event.executionId,
    };
    const status = normalizeText(event.status);
    const stage = status === 'filled' || event.filledPrice || event.entryFilledPrice ? 'fill' : 'ibkr_order';
    store.addEvent(entity, {
      at,
      stage,
      label: event.type || `IBKR status ${status || ''}`.trim(),
      status,
      source,
      blocker: status === 'rejected' ? 'ibkr_order_rejected' : null,
      metrics: {
        price: asNumber(event.filledPrice ?? event.entryFilledPrice),
        volume: asNumber(event.filledQuantity ?? event.entryQuantity),
      },
    });
  }
}

function ingestPaperExecutions(store, rows, source) {
  for (const row of rows) {
    const at = eventTime(row);
    if (!at) continue;
    const blockers = extractBlockers(row);
    const entity = {
      ...row,
      strategyId: row.strategyId,
    };
    store.addEvent(entity, {
      at,
      stage: row.status === 'FILLED' || row.executed ? 'fill' : 'ibkr_order',
      label: row.type || row.status || 'Paper execution',
      status: row.status || null,
      source,
      blocker: blockers[0] || null,
      metrics: collectMetrics(row),
    });
    for (const blocker of blockers.slice(1)) {
      store.addEvent(entity, {
        at,
        stage: 'guard',
        label: blockerLabel(blocker),
        status: 'blocked',
        source,
        blocker,
        metrics: collectMetrics(row),
      });
    }
  }
}

function ingestTrades(store, rows, source) {
  for (const trade of rows) {
    const entity = {
      ...trade,
      strategyId: trade.strategyId,
    };
    if (trade.openedAt) {
      store.addEvent(entity, {
        at: trade.openedAt,
        stage: 'trade',
        label: trade.entryReason || 'Trade opened',
        status: trade.status || 'open',
        source,
        metrics: collectMetrics(trade),
      });
    }
    if (trade.closedAt) {
      store.addEvent(entity, {
        at: trade.closedAt,
        stage: 'exit',
        label: trade.exitReason || 'Trade closed',
        status: trade.status || 'closed',
        source,
        metrics: collectMetrics(trade),
      });
      store.addEvent(entity, {
        at: trade.closedAt,
        stage: 'result',
        label: asNumber(trade.realizedPnlSek ?? trade.netPnlSek) > 0 ? 'Win' : 'Loss',
        status: asNumber(trade.realizedPnlSek ?? trade.netPnlSek) > 0 ? 'win' : 'loss',
        source,
        metrics: collectMetrics(trade),
      });
    }
  }
}

function compactSourceStatus(sourceStatus) {
  return sourceStatus.map((status) => ({
    source: status.source,
    ok: status.ok === true,
    rows: status.rows || 0,
    truncated: status.truncated === true,
    missing: status.missing === true,
    parseErrors: status.parseErrors || 0,
    error: status.error || null,
  }));
}

function finalizeRecords(records) {
  return records.map((record) => {
    record.timeline.sort((a, b) => (timeMs(a.at) || 0) - (timeMs(b.at) || 0));
    record.blockers.sort((a, b) => (timeMs(a.at) || 0) - (timeMs(b.at) || 0));
    const setupAt = record.checkpoints.first_setup || record.checkpoints.producer_detection || record.firstSeenAt;
    const emitAt = record.checkpoints.candidate_created || record.checkpoints.entry_ready || record.checkpoints.canonical || null;
    const setupEvent = record.timeline.find((event) => event.at === setupAt) || record.timeline[0] || {};
    const emitEvent = emitAt ? record.timeline.find((event) => event.at === emitAt) : null;
    const setupPrice = asNumber(setupEvent.metrics?.price);
    const emitPrice = asNumber(emitEvent?.metrics?.price ?? record.metrics.price);
    const priceMoveBeforeEmit = setupPrice != null && emitPrice != null ? emitPrice - setupPrice : null;
    const atr = asNumber(record.metrics.atr);
    const atrMoveBeforeEmit = priceMoveBeforeEmit != null && atr ? priceMoveBeforeEmit / atr : asNumber(record.metrics.atrMove);
    const delaySeconds = setupAt && emitAt ? secondsBetween(setupAt, emitAt) : null;
    const extensionEvent = record.timeline.find((event) => event.stage === 'extension' && extensionRank(event.status || event.metrics?.extensionLevel) > 0);
    const firstBlocker = record.blockers[0] || null;
    const lastBlocker = record.blockers[record.blockers.length - 1] || null;
    const status = normalizeStatusFromRecord(record);

    return {
      signalKey: record.signalKey,
      lifecycleId: record.lifecycleId,
      candidateId: record.candidateId,
      signalId: record.signalId,
      intentId: record.intentId,
      executionId: record.executionId,
      idempotencyKey: record.idempotencyKey,
      tradeId: record.tradeId,
      symbol: record.symbol,
      originalSymbol: record.originalSymbol,
      strategyId: record.strategyId || 'unknown_strategy',
      strategyName: record.strategyName,
      direction: record.direction,
      signalFamily: record.signalFamily,
      signalSubtype: record.signalSubtype,
      market: record.market,
      timeframe: record.timeframe,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      checkpoints: record.checkpoints,
      status,
      flags: record.flags,
      confirmations: record.confirmations,
      blockers: record.blockers,
      firstBlocker,
      lastBlocker,
      metrics: {
        ...record.metrics,
        extensionLevel: record.metrics.extensionLevel || 'none',
        extensionScore: extensionRank(record.metrics.extensionLevel),
        delaySeconds,
        delayCandles2m: delaySeconds == null ? null : round(delaySeconds / 120, 2),
        priceMoveBeforeEmit: round(priceMoveBeforeEmit, 4),
        atrMoveBeforeEmit: round(atrMoveBeforeEmit, 4),
        extensionBeginsAt: extensionEvent?.at || null,
      },
      timeline: record.timeline,
      sourceRefs: record.sourceRefs,
    };
  }).sort((a, b) => (timeMs(b.lastSeenAt) || 0) - (timeMs(a.lastSeenAt) || 0));
}

function summarizeStrategy(records, strategyId) {
  const rows = records.filter((record) => record.strategyId === strategyId);
  const setups = rows.filter((record) => record.flags.hasSetup || record.flags.hasProducerDetection).length;
  const producerDetections = rows.filter((record) => record.flags.hasProducerDetection).length;
  const entryReady = rows.filter((record) => record.flags.isEntryReady).length;
  const candidates = rows.filter((record) => record.flags.hasCandidate).length;
  const trades = rows.filter((record) => record.flags.hasTrade).length;
  const executions = rows.filter((record) => record.flags.hasOrder || record.flags.hasFill || record.flags.hasTrade).length;
  const stopped = rows.filter((record) => !record.flags.hasTrade && record.blockers.length).length;
  const closed = rows.filter((record) => record.flags.hasExit).length;
  const wins = rows.filter((record) => record.flags.hasExit && record.flags.won).length;
  const allBlockers = rows.flatMap((record) => record.blockers);
  const counts = new Map();
  for (const blocker of allBlockers) counts.set(blocker.code, (counts.get(blocker.code) || 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const firstBlocker = rows
    .map((record) => record.firstBlocker)
    .filter(Boolean)
    .sort((a, b) => (timeMs(a.at) || 0) - (timeMs(b.at) || 0))[0] || null;
  const lastBlocker = rows
    .map((record) => record.lastBlocker)
    .filter(Boolean)
    .sort((a, b) => (timeMs(b.at) || 0) - (timeMs(a.at) || 0))[0] || null;

  return {
    strategyId,
    strategyName: rows.find((record) => record.strategyName)?.strategyName || strategyId,
    signals: rows.length,
    setups,
    producerDetections,
    candidates,
    entryReady,
    trades,
    stopped,
    firstBlocker: firstBlocker ? { code: firstBlocker.code, label: firstBlocker.label, at: firstBlocker.at } : null,
    lastBlocker: lastBlocker ? { code: lastBlocker.code, label: lastBlocker.label, at: lastBlocker.at } : null,
    commonBlocker: common ? { code: common[0], label: blockerLabel(common[0]), count: common[1] } : null,
    scorecard: {
      detectionRate: pct(producerDetections, setups || rows.length),
      entryReadyRate: pct(entryReady, producerDetections || setups || rows.length),
      tradeRate: pct(trades, entryReady || candidates || setups || rows.length),
      executionRate: pct(executions, entryReady || candidates || rows.length),
      winRate: pct(wins, closed),
      averageDelaySeconds: round(average(rows.map((record) => record.metrics.delaySeconds)), 1),
      medianDelaySeconds: round(median(rows.map((record) => record.metrics.delaySeconds)), 1),
      averageExtension: round(average(rows.map((record) => record.metrics.extensionScore)), 2),
      averageTradeScore: round(average(rows.map((record) => record.metrics.tradeScore)), 1),
    },
  };
}

function summarizeBlockers(records) {
  const blockers = records.flatMap((record) => record.blockers.map((blocker) => ({ record, blocker })));
  const total = blockers.length;
  const byCode = new Map();
  for (const row of blockers) {
    const code = row.blocker.code;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }
  return [...byCode.entries()].map(([code, rows]) => ({
    code,
    label: blockerLabel(code),
    count: rows.length,
    pct: pct(rows.length, total),
    medianDelaySeconds: round(median(rows.map(({ blocker }) => blocker.delaySeconds)), 1),
    medianAtr: round(median(rows.map(({ record, blocker }) => blocker.metrics?.atr ?? record.metrics.atr ?? record.metrics.atrMove)), 3),
    medianTradeScore: round(median(rows.map(({ record, blocker }) => blocker.metrics?.tradeScore ?? record.metrics.tradeScore)), 1),
    medianVolume: round(median(rows.map(({ record, blocker }) => blocker.metrics?.volume ?? blocker.metrics?.rvol ?? record.metrics.volume ?? record.metrics.rvol)), 2),
    medianVolatility: round(median(rows.map(({ record, blocker }) => blocker.metrics?.volatility ?? record.metrics.volatility ?? record.metrics.atrPct120 ?? record.metrics.bbwPct120)), 2),
    examples: rows.slice(-5).map(({ record, blocker }) => ({
      signalKey: record.signalKey,
      lifecycleId: record.lifecycleId,
      candidateId: record.candidateId,
      symbol: record.originalSymbol || record.symbol,
      strategyId: record.strategyId,
      at: blocker.at,
      stage: blocker.stage,
    })),
  })).sort((a, b) => b.count - a.count);
}

function compactSignal(record) {
  return {
    signalKey: record.signalKey,
    lifecycleId: record.lifecycleId,
    candidateId: record.candidateId,
    signalId: record.signalId,
    symbol: record.symbol,
    originalSymbol: record.originalSymbol,
    strategyId: record.strategyId,
    strategyName: record.strategyName,
    direction: record.direction,
    status: record.status,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    checkpoints: record.checkpoints,
    firstBlocker: record.firstBlocker ? {
      code: record.firstBlocker.code,
      label: record.firstBlocker.label,
      at: record.firstBlocker.at,
      stage: record.firstBlocker.stage,
    } : null,
    lastBlocker: record.lastBlocker ? {
      code: record.lastBlocker.code,
      label: record.lastBlocker.label,
      at: record.lastBlocker.at,
      stage: record.lastBlocker.stage,
    } : null,
    metrics: record.metrics,
    flags: record.flags,
  };
}

function applyFilters(records, query = {}) {
  const strategyId = normalizeStrategyId(query.strategyId || query.strategy);
  const status = normalizeText(query.status)?.toLowerCase();
  const blocker = normalizeBlocker(query.blocker);
  const symbol = normalizeSymbol(query.symbol);
  const q = normalizeText(query.q || query.search)?.toLowerCase();
  return records.filter((record) => {
    if (strategyId && record.strategyId !== strategyId) return false;
    if (status && status !== 'all' && record.status !== status) return false;
    if (blocker && !record.blockers.some((row) => row.code === blocker)) return false;
    if (symbol && record.symbol !== symbol && record.originalSymbol !== symbol) return false;
    if (q) {
      const haystack = [
        record.signalKey,
        record.candidateId,
        record.signalId,
        record.symbol,
        record.originalSymbol,
        record.strategyId,
        record.strategyName,
        record.status,
        record.firstBlocker?.code,
        record.lastBlocker?.code,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function buildReplay(record) {
  return {
    signalKey: record.signalKey,
    candidateId: record.candidateId,
    signalId: record.signalId,
    symbol: record.originalSymbol || record.symbol,
    strategyId: record.strategyId,
    status: record.status,
    steps: record.timeline.map((event, index) => ({
      index,
      at: event.at,
      stage: event.stage,
      stageLabel: event.stageLabel,
      label: event.label,
      status: event.status,
      source: event.source,
      blocker: event.blocker,
      blockerLabel: event.blockerLabel,
      metrics: event.metrics,
      details: event.details,
    })),
  };
}

function createSignalIntelligenceLabService(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const now = options.now || (() => new Date());
  const defaultDays = options.defaultDays || 7;
  const maxDays = options.maxDays || 30;
  const defaultLimit = options.defaultLimit || 200;
  const defaultTailBytes = options.defaultTailBytes || 12 * 1024 * 1024;

  function loadDataset(query = {}) {
    const days = clampInt(query.days, defaultDays, 1, maxDays);
    const limit = clampInt(query.limit, defaultLimit, 1, 2000);
    const full = query.full === true || String(query.full || '') === '1';
    const tailMb = clampInt(query.tailMb, Math.round(defaultTailBytes / 1024 / 1024), 1, 128);
    const tailBytes = full ? 0 : tailMb * 1024 * 1024;
    const store = createLifecycleStore();
    const sourceStatus = [];

    const dates = ymdDaysBack(now(), days);
    const featureDir = path.join(dataDir, 'feature-logs');
    for (const date of dates) {
      const filePath = path.join(featureDir, `${date}.jsonl`);
      const read = safeReadJsonl(filePath, { tailBytes });
      sourceStatus.push({ source: `feature-logs/${date}`, ...read, rows: read.rows.length });
      ingestFeatureRows(store, read.rows, `feature-logs/${date}`);
    }

    const signalHistoryDir = path.join(dataDir, 'signals', 'history');
    for (const date of dates) {
      const filePath = path.join(signalHistoryDir, `${date}.jsonl`);
      const read = safeReadJsonl(filePath, { tailBytes });
      sourceStatus.push({ source: `signals/history/${date}`, ...read, rows: read.rows.length });
      ingestSignalHistoryRows(store, read.rows, `signals/history/${date}`);
    }

    const tradingEvents = safeReadJsonl(path.join(dataDir, 'events', 'trading-events.jsonl'), { tailBytes: full ? 0 : Math.max(tailBytes, 24 * 1024 * 1024) });
    sourceStatus.push({ source: 'events/trading-events', ...tradingEvents, rows: tradingEvents.rows.length });
    ingestTradingEvents(store, tradingEvents.rows, 'events/trading-events');

    const futuresEvents = safeReadJsonl(path.join(dataDir, 'futures-paper', 'events.jsonl'), { tailBytes: full ? 0 : Math.max(tailBytes, 24 * 1024 * 1024) });
    sourceStatus.push({ source: 'futures-paper/events', ...futuresEvents, rows: futuresEvents.rows.length });
    ingestFuturesEvents(store, futuresEvents.rows, 'futures-paper/events');

    const liveCandidates = safeReadJson(path.join(dataDir, 'futures-paper', 'candidates.json'));
    const candidateRows = Array.isArray(liveCandidates.value)
      ? liveCandidates.value
      : (Array.isArray(liveCandidates.value?.candidates) ? liveCandidates.value.candidates : []);
    sourceStatus.push({ source: 'futures-paper/candidates', ...liveCandidates, rows: candidateRows.length });
    for (const candidate of candidateRows) ingestCandidate(store, candidate, 'futures-paper/candidates');

    const archive = safeReadJsonl(path.join(dataDir, 'futures-paper', 'candidate-archive.jsonl'), { tailBytes: full ? 0 : Math.max(tailBytes, 24 * 1024 * 1024) });
    sourceStatus.push({ source: 'futures-paper/candidate-archive', ...archive, rows: archive.rows.length });
    for (const candidate of archive.rows) ingestCandidate(store, candidate, 'futures-paper/candidate-archive');

    const intentIndex = safeReadJson(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intent-index.json'));
    sourceStatus.push({ source: 'futures-paper/ibkr-execution/intent-index', ...intentIndex, rows: intentIndex.value ? Object.keys(intentIndex.value).length : 0 });
    ingestIntentIndex(store, intentIndex.value, 'futures-paper/ibkr-execution/intent-index');

    const intentEvents = safeReadJsonl(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intents.jsonl'), { tailBytes: full ? 0 : Math.max(tailBytes, 16 * 1024 * 1024) });
    sourceStatus.push({ source: 'futures-paper/ibkr-execution/intents', ...intentEvents, rows: intentEvents.rows.length });
    ingestIntentEvents(store, intentEvents.rows, 'futures-paper/ibkr-execution/intents');

    const paperExecutionEvents = safeReadJsonl(path.join(dataDir, 'interactive-brokers', 'paper-execution-events.jsonl'), { tailBytes: full ? 0 : tailBytes });
    sourceStatus.push({ source: 'interactive-brokers/paper-execution-events', ...paperExecutionEvents, rows: paperExecutionEvents.rows.length });
    ingestPaperExecutions(store, paperExecutionEvents.rows, 'interactive-brokers/paper-execution-events');

    const paperExecutions = safeReadJsonl(path.join(dataDir, 'interactive-brokers', 'paper-executions.jsonl'), { tailBytes: full ? 0 : tailBytes });
    sourceStatus.push({ source: 'interactive-brokers/paper-executions', ...paperExecutions, rows: paperExecutions.rows.length });
    ingestPaperExecutions(store, paperExecutions.rows, 'interactive-brokers/paper-executions');

    const trades = safeReadJsonl(path.join(dataDir, 'futures-paper', 'trades.jsonl'), { tailBytes: full ? 0 : Math.max(tailBytes, 16 * 1024 * 1024) });
    sourceStatus.push({ source: 'futures-paper/trades', ...trades, rows: trades.rows.length });
    ingestTrades(store, trades.rows, 'futures-paper/trades');

    const positions = safeReadJson(path.join(dataDir, 'futures-paper', 'positions.json'));
    const positionRows = Array.isArray(positions.value)
      ? positions.value
      : (Array.isArray(positions.value?.positions)
        ? positions.value.positions
        : (positions.value?.positionsById ? Object.values(positions.value.positionsById) : []));
    sourceStatus.push({ source: 'futures-paper/positions', ...positions, rows: positionRows.length });
    ingestTrades(store, positionRows, 'futures-paper/positions');

    const records = finalizeRecords(store.all());
    return {
      records,
      sourceStatus: compactSourceStatus(sourceStatus),
      load: {
        days,
        limit,
        full,
        tailMb: full ? null : tailMb,
        generatedAt: now().toISOString(),
      },
    };
  }

  function buildOverview(query = {}) {
    const dataset = loadDataset(query);
    const filtered = applyFilters(dataset.records, query);
    const limit = clampInt(query.limit, defaultLimit, 1, 2000);
    const strategyIds = [...new Set(filtered.map((record) => record.strategyId || 'unknown_strategy'))].sort();
    const strategies = strategyIds.map((strategyId) => summarizeStrategy(filtered, strategyId))
      .sort((a, b) => b.signals - a.signals);
    const blockers = summarizeBlockers(filtered);
    const summary = {
      signals: filtered.length,
      setups: filtered.filter((record) => record.flags.hasSetup || record.flags.hasProducerDetection).length,
      producerDetections: filtered.filter((record) => record.flags.hasProducerDetection).length,
      candidates: filtered.filter((record) => record.flags.hasCandidate).length,
      entryReady: filtered.filter((record) => record.flags.isEntryReady).length,
      trades: filtered.filter((record) => record.flags.hasTrade).length,
      stopped: filtered.filter((record) => !record.flags.hasTrade && record.blockers.length).length,
      blockers: filtered.flatMap((record) => record.blockers).length,
    };

    return {
      ...SAFETY,
      generatedAt: dataset.load.generatedAt,
      load: dataset.load,
      summary,
      strategies,
      scorecard: strategies.map((strategy) => ({
        strategyId: strategy.strategyId,
        strategyName: strategy.strategyName,
        ...strategy.scorecard,
        setups: strategy.setups,
        entryReady: strategy.entryReady,
        trades: strategy.trades,
      })),
      blockers,
      recentSignals: filtered.slice(0, limit).map(compactSignal),
      sourceStatus: dataset.sourceStatus,
      stages: STAGES.map((stage) => ({ id: stage, label: STAGE_LABELS[stage] || stage })),
    };
  }

  function listSignals(query = {}) {
    const dataset = loadDataset(query);
    const limit = clampInt(query.limit, defaultLimit, 1, 2000);
    const records = applyFilters(dataset.records, query).slice(0, limit);
    return {
      ...SAFETY,
      generatedAt: dataset.load.generatedAt,
      load: dataset.load,
      count: records.length,
      signals: records.map(compactSignal),
      sourceStatus: dataset.sourceStatus,
    };
  }

  function getSignal(signalKeyOrId, query = {}) {
    const id = normalizeText(signalKeyOrId);
    const dataset = loadDataset({ ...query, limit: query.limit || 2000 });
    const record = dataset.records.find((row) => (
      row.signalKey === id
      || row.lifecycleId === id
      || row.candidateId === id
      || row.signalId === id
      || row.executionId === id
      || row.idempotencyKey === id
      || row.tradeId === id
    ));
    if (!record) {
      return {
        ...SAFETY,
        ok: false,
        error: 'signal_not_found',
        signalKey: id,
        generatedAt: dataset.load.generatedAt,
      };
    }
    return {
      ...SAFETY,
      generatedAt: dataset.load.generatedAt,
      signal: record,
      replay: buildReplay(record),
      sourceStatus: dataset.sourceStatus,
    };
  }

  function getReplay(signalKeyOrId, query = {}) {
    const payload = getSignal(signalKeyOrId, query);
    if (payload.ok === false) return payload;
    return {
      ...SAFETY,
      generatedAt: payload.generatedAt,
      replay: payload.replay,
    };
  }

  return {
    SAFETY,
    STAGES,
    loadDataset,
    buildOverview,
    listSignals,
    getSignal,
    getReplay,
    _internals: {
      normalizeBlocker,
      inferStrategyFromSignalShape,
      collectMetrics,
      createLifecycleStore,
      finalizeRecords,
      summarizeBlockers,
    },
  };
}

const defaultService = createSignalIntelligenceLabService();

module.exports = {
  SAFETY,
  STAGES,
  createSignalIntelligenceLabService,
  loadDataset: (...args) => defaultService.loadDataset(...args),
  buildOverview: (...args) => defaultService.buildOverview(...args),
  listSignals: (...args) => defaultService.listSignals(...args),
  getSignal: (...args) => defaultService.getSignal(...args),
  getReplay: (...args) => defaultService.getReplay(...args),
};
