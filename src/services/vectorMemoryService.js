'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const redisService = require('./redisService');

let Pg = null;
try {
  Pg = require('pg');
} catch (_) {
  Pg = null;
}

const DATA_DIR = path.resolve(__dirname, '../../data/signal-memory');
const DATA_FILE = path.join(DATA_DIR, 'signal_memory.json');
const LATEST_KEY = 'memory:latest_similarity';
const SYMBOL_KEY_PREFIX = 'memory:similarity:';
const CACHE_TTL_SECONDS = 10 * 60;
const PROVIDER = 'pgvector_or_feature_similarity_v1';
const VECTOR_DIMENSIONS = 12;

let pool = null;
let schemaReady = false;
let pgvectorSupported = false;
let dbLastError = null;
let processMemoryRows = [];

function nowIso() {
  return new Date().toISOString();
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'passed', 'allowed'].includes(v)) return true;
    if (['false', 'no', '0', 'blocked', 'failed'].includes(v)) return false;
  }
  return null;
}

function cleanText(value, fallback = null) {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function upper(value, fallback = null) {
  const s = cleanText(value, fallback);
  return s ? s.toUpperCase() : fallback;
}

function lower(value, fallback = null) {
  const s = cleanText(value, fallback);
  return s ? s.toLowerCase() : fallback;
}

function normalizeDirection(value) {
  const v = upper(value, '');
  if (['UP', 'LONG', 'BUY', 'BULL', 'BULLISH'].includes(v)) return 'UP';
  if (['DOWN', 'SHORT', 'SELL', 'BEAR', 'BEARISH'].includes(v)) return 'DOWN';
  return 'UNCERTAIN';
}

function normalizeState(value) {
  const v = lower(value, 'unknown');
  if (!v || v === 'unknown') return 'unknown';
  if (/narrow|compression|tight|high_quality|medium_narrow/.test(v)) return 'narrow';
  if (/wide|extended|spread/.test(v)) return 'wide';
  if (/trend/.test(v)) return 'trend';
  if (/chop|range|sideway/.test(v)) return 'choppy';
  return v.replace(/[^a-z0-9_:-]+/g, '_').slice(0, 40);
}

function normalizeEmaAlignment(value, context = {}) {
  const raw = lower(value ?? context.tf2m ?? context.timeframeAgreement?.tf2m ?? context.indicators?.tf2m, '');
  if (['bullish', 'bull', 'up', 'long'].includes(raw)) return 'bullish';
  if (['bearish', 'bear', 'down', 'short'].includes(raw)) return 'bearish';
  if (raw && raw !== 'unknown') return raw.slice(0, 32);

  const price = numberOrNull(context.price ?? context.priceAtSignal ?? context.entryPrice);
  const ema9 = numberOrNull(context.ema9 ?? context.indicators?.ema9);
  const ema21 = numberOrNull(context.ema21 ?? context.indicators?.ema21);
  if (price != null && ema9 != null && ema21 != null) {
    if (price >= ema9 && ema9 >= ema21) return 'bullish';
    if (price <= ema9 && ema9 <= ema21) return 'bearish';
  }
  return 'unknown';
}

function normalizeMarketPersonality(value) {
  if (value && typeof value === 'object') {
    if (value.trendFriendly === true) return 'trend';
    if (value.choppy === true || value.choppyState === true) return 'choppy';
    return lower(value.personality || value.type || value.state || value.regime || value.name, 'unknown');
  }
  const v = lower(value, 'unknown');
  if (/trend|momentum/.test(v)) return 'trend';
  if (/chop|range|sideway/.test(v)) return 'choppy';
  return v || 'unknown';
}

function timestampParts(signalContext = {}) {
  const raw = signalContext.timestamp || signalContext.candleTs || signalContext.entryTime || signalContext.createdAt || signalContext.lastUpdate;
  const d = raw ? new Date(raw) : new Date();
  if (!Number.isFinite(d.getTime())) {
    const fallback = new Date();
    return { hour_of_day: fallback.getUTCHours(), day_of_week: fallback.getUTCDay() };
  }
  return { hour_of_day: d.getUTCHours(), day_of_week: d.getUTCDay() };
}

function buildSignalFeatures(signalContext = {}) {
  const c = signalContext && typeof signalContext === 'object' ? signalContext : {};
  const indicators = c.indicators && typeof c.indicators === 'object' ? c.indicators : {};
  const gate = c.gate && typeof c.gate === 'object' ? c.gate : {};
  const volume = c.volume && typeof c.volume === 'object' ? c.volume : {};
  const ts = timestampParts(c);
  const gatePassed = boolOrNull(c.gate_passed ?? c.gatePassed ?? c.allowed ?? gate.allowed ?? gate.passed);
  const gateStatus = lower(c.status ?? gate.status, '');

  return {
    symbol: upper(c.symbol, 'UNKNOWN'),
    direction: normalizeDirection(c.direction ?? c.nextMoveBias ?? c.bias ?? c.tradeDirection ?? c.signal),
    state: normalizeState(c.state ?? c.narrowState ?? c.marketState ?? c.narrowType),
    score: round(c.score ?? c.priorityScore ?? c.tradeScore ?? c.daytradeScore ?? gate.gateScore, 2),
    confidence: round(c.confidence ?? c.confidenceScore ?? c.confidence_score ?? c.confidence?.confidenceScore ?? gate.confidenceScore, 2),
    volume_ratio: round(c.volume_ratio ?? c.volumeRatio ?? c.rvol ?? c.relVol20 ?? c.relativeVolume ?? volume.ratio ?? volume.relativeVolume, 4),
    rsi: round(c.rsi ?? c.rsi14 ?? indicators.rsi ?? indicators.rsi14, 2),
    ema_alignment: normalizeEmaAlignment(c.ema_alignment ?? c.emaAlignment ?? indicators.emaAlignment, c),
    vwap_distance_pct: round(c.vwap_distance_pct ?? c.vwapDistancePct ?? indicators.vwapDistancePct, 4),
    spread_pct: round(c.spread_pct ?? c.spreadPct ?? c.bidAskSpreadPct ?? c.spread?.pct, 4),
    market_personality: normalizeMarketPersonality(c.market_personality ?? c.marketPersonality ?? c.marketRegime),
    timeframe: lower(c.timeframe ?? c.tf ?? c.interval, '2m'),
    hour_of_day: ts.hour_of_day,
    day_of_week: ts.day_of_week,
    gate_passed: gatePassed != null ? gatePassed : (gateStatus ? ['active', 'watch', 'caution', 'allowed'].includes(gateStatus) : null),
  };
}

function hasDbConfig() {
  return !!(
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PGHOST ||
    process.env.PGDATABASE
  );
}

function getPool() {
  if (!Pg || !hasDbConfig()) return null;
  if (pool) return pool;
  const config = {};
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (connectionString) config.connectionString = connectionString;
  if (String(process.env.PGSSLMODE || '').toLowerCase() === 'require') {
    config.ssl = { rejectUnauthorized: false };
  }
  pool = new Pg.Pool({
    ...config,
    max: Number(process.env.PG_POOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 1500,
  });
  return pool;
}

function setDbError(err) {
  dbLastError = err ? { message: err.message || String(err), at: nowIso() } : null;
}

async function ensureSchema() {
  const p = getPool();
  if (!p) return false;
  if (schemaReady) return true;

  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS signal_memory (
        id BIGSERIAL PRIMARY KEY,
        signal_hash TEXT,
        symbol TEXT,
        direction TEXT,
        state TEXT,
        timeframe TEXT,
        features_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        score NUMERIC,
        confidence NUMERIC,
        outcome_type TEXT DEFAULT 'unknown',
        move_after_5m_pct NUMERIC,
        move_after_15m_pct NUMERIC,
        move_after_30m_pct NUMERIC,
        max_favorable_excursion_pct NUMERIC,
        max_adverse_excursion_pct NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ,
        source TEXT DEFAULT 'vector_memory_v1'
      )
    `);
    await p.query('CREATE INDEX IF NOT EXISTS idx_signal_memory_symbol_created ON signal_memory(symbol, created_at DESC)');
    await p.query('CREATE INDEX IF NOT EXISTS idx_signal_memory_setup ON signal_memory(direction, state, timeframe)');
    await p.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_memory_hash ON signal_memory(signal_hash) WHERE signal_hash IS NOT NULL');

    try {
      await p.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (_) {
      // Extension may require elevated DB privileges; feature similarity still works.
    }
    const ext = await p.query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS enabled");
    pgvectorSupported = ext.rows?.[0]?.enabled === true;
    if (pgvectorSupported) {
      try {
        await p.query(`ALTER TABLE signal_memory ADD COLUMN IF NOT EXISTS embedding vector(${VECTOR_DIMENSIONS})`);
      } catch (err) {
        pgvectorSupported = false;
        setDbError(err);
      }
    }

    schemaReady = true;
    if (!dbLastError || pgvectorSupported) setDbError(null);
    return true;
  } catch (err) {
    setDbError(err);
    return false;
  }
}

function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]\n', 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function loadFileRows() {
  try {
    if (!ensureDataFile()) return processMemoryRows;
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return processMemoryRows;
  }
}

function saveFileRows(rows) {
  processMemoryRows = Array.isArray(rows) ? rows : [];
  try {
    if (!ensureDataFile()) return false;
    fs.writeFileSync(DATA_FILE, JSON.stringify(processMemoryRows, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function normalizeOutcomeType(value) {
  const v = lower(value, '');
  if (['win', 'winner', 'success', 'target_hit', 'true'].includes(v)) return 'win';
  if (['loss', 'loser', 'fail', 'failed', 'stop_hit', 'false'].includes(v)) return 'loss';
  if (['tie', 'timeout', 'flat', 'neutral'].includes(v)) return 'tie';
  if (['open', 'pending'].includes(v)) return 'open';
  return 'unknown';
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function normalizeOutcome(outcome = {}, signalContext = {}) {
  const o = outcome && typeof outcome === 'object' ? outcome : {};
  const result = o.result ?? o.outcome_type ?? o.outcomeType ?? signalContext.result;
  const success = o.success ?? signalContext.success;
  let type = normalizeOutcomeType(result);
  if (type === 'unknown' && success === true) type = 'win';
  if (type === 'unknown' && success === false) type = 'loss';

  const mfe = firstNumber(o.max_favorable_excursion_pct, o.maxFavorableExcursionPct, o.maxFavorablePct, signalContext.maxFavorablePct, o.outcome10?.maxMoveUp, signalContext.outcome10?.maxMoveUp, o.pnlPct, signalContext.pnlPct);
  const mae = firstNumber(o.max_adverse_excursion_pct, o.maxAdverseExcursionPct, o.maxAdversePct, signalContext.maxAdversePct, o.outcome10?.maxMoveDown, signalContext.outcome10?.maxMoveDown);

  return {
    outcome_type: type,
    move_after_5m_pct: round(firstNumber(o.move_after_5m_pct, o.moveAfter5mPct, o.outcome3?.priceChangePct, signalContext.outcome3?.priceChangePct)),
    move_after_15m_pct: round(firstNumber(o.move_after_15m_pct, o.moveAfter15mPct, o.outcome10?.priceChangePct, o.outcome5?.priceChangePct, signalContext.outcome10?.priceChangePct, signalContext.outcome5?.priceChangePct, o.pnlPct, signalContext.pnlPct)),
    move_after_30m_pct: round(firstNumber(o.move_after_30m_pct, o.moveAfter30mPct, o.outcome20?.priceChangePct, signalContext.outcome20?.priceChangePct, o.pnlPct, signalContext.pnlPct)),
    max_favorable_excursion_pct: round(mfe == null ? null : Math.max(0, mfe)),
    max_adverse_excursion_pct: round(mae == null ? null : Math.abs(mae)),
    resolved_at: o.resolved_at || o.resolvedAt || signalContext.exitTime || null,
  };
}

function buildSignalHash(features, signalContext = {}, outcome = {}) {
  const identity = signalContext.signalId || signalContext.tradeId || signalContext.id || outcome.signalId || outcome.tradeId;
  if (identity) return crypto.createHash('sha1').update(String(identity)).digest('hex');
  return crypto.createHash('sha1')
    .update(JSON.stringify({
      symbol: features.symbol,
      direction: features.direction,
      timeframe: features.timeframe,
      state: features.state,
      timestamp: signalContext.timestamp || signalContext.candleTs || signalContext.entryTime || null,
      outcome: outcome.outcome_type || outcome.result || null,
    }))
    .digest('hex');
}

function buildFeatureVector(features) {
  const direction = features.direction === 'UP' ? 1 : features.direction === 'DOWN' ? -1 : 0;
  const ema = features.ema_alignment === 'bullish' ? 1 : features.ema_alignment === 'bearish' ? -1 : 0;
  const gate = features.gate_passed === true ? 1 : features.gate_passed === false ? -1 : 0;
  const personality = features.market_personality === 'trend' ? 1 : features.market_personality === 'choppy' ? -1 : 0;
  const state = features.state === 'narrow' ? 1 : features.state === 'wide' ? -1 : 0;
  return [
    direction,
    state,
    (numberOrNull(features.score) ?? 50) / 100,
    (numberOrNull(features.confidence) ?? 50) / 100,
    Math.min(4, numberOrNull(features.volume_ratio) ?? 1) / 4,
    (numberOrNull(features.rsi) ?? 50) / 100,
    ema,
    (numberOrNull(features.vwap_distance_pct) ?? 0) / 5,
    (numberOrNull(features.spread_pct) ?? 0) / 1,
    personality,
    (numberOrNull(features.hour_of_day) ?? 12) / 23,
    gate,
  ].map((n) => Number.isFinite(n) ? round(n, 6) : 0);
}

function vectorLiteral(values) {
  return `[${values.slice(0, VECTOR_DIMENSIONS).map((n) => Number(n) || 0).join(',')}]`;
}

async function saveSignalMemory(signalContext = {}, outcome = {}) {
  const features = buildSignalFeatures(signalContext);
  const normalizedOutcome = normalizeOutcome(outcome, signalContext);
  const signalHash = buildSignalHash(features, signalContext, { ...outcome, ...normalizedOutcome });
  const source = cleanText(outcome.source || signalContext.source, 'manual');

  const dbReady = await ensureSchema();
  if (dbReady) {
    const p = getPool();
    try {
      const baseValues = [
        signalHash,
        features.symbol,
        features.direction,
        features.state,
        features.timeframe,
        JSON.stringify(features),
        features.score,
        features.confidence,
        normalizedOutcome.outcome_type,
        normalizedOutcome.move_after_5m_pct,
        normalizedOutcome.move_after_15m_pct,
        normalizedOutcome.move_after_30m_pct,
        normalizedOutcome.max_favorable_excursion_pct,
        normalizedOutcome.max_adverse_excursion_pct,
        normalizedOutcome.resolved_at,
        source,
      ];
      const embedding = pgvectorSupported ? vectorLiteral(buildFeatureVector(features)) : null;
      const query = pgvectorSupported
        ? `
          INSERT INTO signal_memory (
            signal_hash, symbol, direction, state, timeframe, features_json, embedding, score, confidence,
            outcome_type, move_after_5m_pct, move_after_15m_pct, move_after_30m_pct,
            max_favorable_excursion_pct, max_adverse_excursion_pct, resolved_at, source
          ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$17::vector,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (signal_hash) WHERE signal_hash IS NOT NULL DO NOTHING
          RETURNING id
        `
        : `
          INSERT INTO signal_memory (
            signal_hash, symbol, direction, state, timeframe, features_json, score, confidence,
            outcome_type, move_after_5m_pct, move_after_15m_pct, move_after_30m_pct,
            max_favorable_excursion_pct, max_adverse_excursion_pct, resolved_at, source
          ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (signal_hash) WHERE signal_hash IS NOT NULL DO NOTHING
          RETURNING id
        `;
      const values = pgvectorSupported ? [...baseValues, embedding] : baseValues;
      const result = await p.query(query, values);
      return {
        ok: true,
        provider: PROVIDER,
        storage_provider: pgvectorSupported ? 'postgres_pgvector' : 'postgres_json_features',
        inserted: result.rowCount > 0,
        id: result.rows?.[0]?.id ?? null,
        features,
        outcome: normalizedOutcome,
      };
    } catch (err) {
      setDbError(err);
    }
  }

  const rows = loadFileRows();
  const exists = rows.some((r) => r.signal_hash === signalHash);
  let id = null;
  if (!exists) {
    id = rows.length ? Math.max(...rows.map((r) => Number(r.id) || 0)) + 1 : 1;
    rows.push({
      id,
      signal_hash: signalHash,
      symbol: features.symbol,
      direction: features.direction,
      state: features.state,
      timeframe: features.timeframe,
      features_json: features,
      score: features.score,
      confidence: features.confidence,
      ...normalizedOutcome,
      created_at: signalContext.created_at || signalContext.createdAt || signalContext.timestamp || signalContext.entryTime || nowIso(),
      source,
    });
    saveFileRows(rows);
  }

  return {
    ok: true,
    provider: PROVIDER,
    storage_provider: 'file_json_features',
    inserted: !exists,
    id,
    features,
    outcome: normalizedOutcome,
  };
}

function stateGroup(state) {
  const s = normalizeState(state);
  if (['narrow', 'compression', 'tight'].includes(s)) return 'narrow';
  if (['wide', 'extended'].includes(s)) return 'wide';
  if (['trend', 'trending'].includes(s)) return 'trend';
  if (['choppy', 'range'].includes(s)) return 'choppy';
  return s;
}

function categorySimilarity(a, b, nearFn) {
  if (!a || a === 'unknown') return null;
  if (!b || b === 'unknown') return 0;
  if (a === b) return 1;
  return nearFn ? nearFn(a, b) : 0;
}

function numericSimilarity(a, b, maxDistance) {
  const av = numberOrNull(a);
  const bv = numberOrNull(b);
  if (av == null) return null;
  if (bv == null) return 0;
  return Math.max(0, 1 - Math.abs(av - bv) / maxDistance);
}

function hourSimilarity(a, b) {
  const av = numberOrNull(a);
  const bv = numberOrNull(b);
  if (av == null) return null;
  if (bv == null) return 0;
  const diff = Math.min(Math.abs(av - bv), 24 - Math.abs(av - bv));
  if (diff === 0) return 1;
  if (diff === 1) return 0.7;
  if (diff === 2) return 0.4;
  return 0;
}

function setupSimilarity(target, candidate) {
  let weighted = 0;
  let total = 0;
  function add(weight, score) {
    if (score == null) return;
    total += weight;
    weighted += weight * Math.max(0, Math.min(1, score));
  }

  add(18, categorySimilarity(target.direction, candidate.direction));
  add(12, categorySimilarity(target.state, candidate.state, (a, b) => stateGroup(a) === stateGroup(b) ? 0.65 : 0));
  add(12, numericSimilarity(target.score, candidate.score, 40));
  add(10, numericSimilarity(target.confidence, candidate.confidence, 40));
  add(10, numericSimilarity(target.volume_ratio, candidate.volume_ratio, 3));
  add(8, numericSimilarity(target.rsi, candidate.rsi, 35));
  add(10, categorySimilarity(target.ema_alignment, candidate.ema_alignment));
  add(8, numericSimilarity(target.vwap_distance_pct, candidate.vwap_distance_pct, 1.5));
  add(8, categorySimilarity(target.market_personality, candidate.market_personality, (a, b) => {
    if (['trend', 'momentum', 'trending'].includes(a) && ['trend', 'momentum', 'trending'].includes(b)) return 0.8;
    if (['choppy', 'range'].includes(a) && ['choppy', 'range'].includes(b)) return 0.8;
    return 0;
  }));
  add(4, hourSimilarity(target.hour_of_day, candidate.hour_of_day));

  return total ? Math.round((weighted / total) * 100) : 0;
}

function normalizeRow(row) {
  const features = row.features_json && typeof row.features_json === 'object'
    ? row.features_json
    : (() => { try { return JSON.parse(row.features_json || '{}'); } catch { return {}; } })();
  return {
    id: row.id,
    symbol: row.symbol || features.symbol || 'UNKNOWN',
    direction: row.direction || features.direction || 'UNCERTAIN',
    state: row.state || features.state || 'unknown',
    timeframe: row.timeframe || features.timeframe || '2m',
    features_json: features,
    score: numberOrNull(row.score ?? features.score),
    confidence: numberOrNull(row.confidence ?? features.confidence),
    outcome_type: normalizeOutcomeType(row.outcome_type),
    move_after_5m_pct: numberOrNull(row.move_after_5m_pct),
    move_after_15m_pct: numberOrNull(row.move_after_15m_pct),
    move_after_30m_pct: numberOrNull(row.move_after_30m_pct),
    max_favorable_excursion_pct: numberOrNull(row.max_favorable_excursion_pct),
    max_adverse_excursion_pct: numberOrNull(row.max_adverse_excursion_pct),
    created_at: row.created_at || row.createdAt || null,
    resolved_at: row.resolved_at || row.resolvedAt || null,
    source: row.source || null,
  };
}

async function loadCandidateRows(features, candidateLimit) {
  const dbReady = await ensureSchema();
  if (dbReady) {
    try {
      const result = await getPool().query(`
        SELECT id, symbol, direction, state, timeframe, features_json, score, confidence,
          outcome_type, move_after_5m_pct, move_after_15m_pct, move_after_30m_pct,
          max_favorable_excursion_pct, max_adverse_excursion_pct, created_at, resolved_at, source
        FROM signal_memory
        WHERE ($1::text IS NULL OR timeframe = $1 OR timeframe IS NULL)
          AND ($2::text IS NULL OR direction = $2 OR direction IS NULL)
        ORDER BY created_at DESC
        LIMIT $3
      `, [
        features.timeframe || null,
        features.direction && features.direction !== 'UNCERTAIN' ? features.direction : null,
        candidateLimit,
      ]);
      return {
        storage_provider: pgvectorSupported ? 'postgres_pgvector' : 'postgres_json_features',
        rows: result.rows.map(normalizeRow),
      };
    } catch (err) {
      setDbError(err);
    }
  }

  return {
    storage_provider: 'file_json_features',
    rows: loadFileRows().map(normalizeRow),
  };
}

function average(values) {
  const nums = values.map(numberOrNull).filter((n) => n != null);
  if (!nums.length) return null;
  return round(nums.reduce((sum, n) => sum + n, 0) / nums.length, 4);
}

function highDrawdown(summary) {
  const mae = Math.abs(numberOrNull(summary.avg_mae_pct) ?? 0);
  const move = Math.abs(numberOrNull(summary.avg_move_15m_pct) ?? 0);
  return mae >= Math.max(0.6, move * 1.5);
}

function confidenceAdjustment(sampleSize, winRate, avgMaePct) {
  if (!sampleSize || winRate == null) return 0;
  let adjustment = 0;
  if (sampleSize < 10) {
    if (winRate >= 75) adjustment = 1;
    if (winRate < 35) adjustment = -1;
  } else if (sampleSize < 20) {
    if (winRate >= 70) adjustment = 3;
    else if (winRate >= 60) adjustment = 2;
    else if (winRate < 35) adjustment = -3;
    else if (winRate < 45) adjustment = -2;
  } else {
    if (winRate >= 75) adjustment = 8;
    else if (winRate >= 65) adjustment = 5;
    else if (winRate >= 58) adjustment = 3;
    else if (winRate < 30) adjustment = -10;
    else if (winRate < 35) adjustment = -7;
    else if (winRate < 45) adjustment = -4;
  }
  if (sampleSize >= 10 && Math.abs(numberOrNull(avgMaePct) ?? 0) >= 1.2) adjustment -= 2;
  return Math.max(-10, Math.min(8, Math.round(adjustment)));
}

function summarizeSimilarSetups(matches = []) {
  const resolved = matches.filter((m) => ['win', 'loss', 'tie'].includes(normalizeOutcomeType(m.outcome_type)));
  const wins = resolved.filter((m) => normalizeOutcomeType(m.outcome_type) === 'win').length;
  const losses = resolved.filter((m) => normalizeOutcomeType(m.outcome_type) === 'loss').length;
  const winLossTotal = wins + losses;
  const sampleSize = resolved.length;
  const winRate = winLossTotal ? round((wins / winLossTotal) * 100, 1) : null;
  const summary = {
    sample_size: sampleSize,
    win_rate: winRate,
    avg_move_15m_pct: average(resolved.map((m) => m.move_after_15m_pct)),
    avg_mfe_pct: average(resolved.map((m) => m.max_favorable_excursion_pct)),
    avg_mae_pct: average(resolved.map((m) => m.max_adverse_excursion_pct)),
    memory_confidence_adjustment: 0,
    memory_warning: null,
  };
  summary.memory_confidence_adjustment = confidenceAdjustment(sampleSize, winRate, summary.avg_mae_pct);

  if (sampleSize > 0 && sampleSize < 10) summary.memory_warning = 'Begränsat historiskt underlag.';
  if (sampleSize >= 20 && winRate != null && winRate < 35) summary.memory_warning = 'Liknande historik har låg träffsäkerhet.';
  if (sampleSize >= 10 && highDrawdown(summary)) summary.memory_warning = summary.memory_warning || 'Liknande setups har historiskt haft hög motrörelse.';

  return summary;
}

async function cacheSimilarityResult(symbol, result) {
  try {
    await redisService.setJson(LATEST_KEY, result, CACHE_TTL_SECONDS);
    if (symbol) await redisService.setJson(`${SYMBOL_KEY_PREFIX}${symbol}`, result, CACHE_TTL_SECONDS);
  } catch (err) {
    // redisService already has an in-memory fallback; never fail caller here.
  }
}

async function findSimilarSetups(signalContext = {}, options = {}) {
  const features = buildSignalFeatures(signalContext);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 25)));
  const candidateLimit = Math.max(limit, Math.min(5000, Number(options.candidateLimit || 1000)));
  const minSimilarity = Number.isFinite(Number(options.minSimilarity)) ? Number(options.minSimilarity) : 35;

  let storageProvider = 'unknown';
  let rows = [];
  try {
    const loaded = await loadCandidateRows(features, candidateLimit);
    storageProvider = loaded.storage_provider;
    rows = loaded.rows;
  } catch (err) {
    setDbError(err);
    rows = loadFileRows().map(normalizeRow);
    storageProvider = 'file_json_features';
  }

  const matches = rows
    .map((row) => {
      const rowFeatures = buildSignalFeatures({ ...row.features_json, ...row });
      const similarity_score = setupSimilarity(features, rowFeatures);
      return {
        id: row.id,
        symbol: row.symbol,
        direction: row.direction,
        state: row.state,
        timeframe: row.timeframe,
        score: row.score,
        confidence: row.confidence,
        outcome_type: row.outcome_type,
        move_after_5m_pct: row.move_after_5m_pct,
        move_after_15m_pct: row.move_after_15m_pct,
        move_after_30m_pct: row.move_after_30m_pct,
        max_favorable_excursion_pct: row.max_favorable_excursion_pct,
        max_adverse_excursion_pct: row.max_adverse_excursion_pct,
        similarity_score,
        features: rowFeatures,
        created_at: row.created_at,
        resolved_at: row.resolved_at,
        source: row.source,
        setup_was_actionable: row.outcome_type === 'win' || (row.outcome_type === 'tie' && (row.move_after_15m_pct ?? 0) > 0),
      };
    })
    .filter((m) => m.similarity_score >= minSimilarity)
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, limit);

  const result = {
    ok: true,
    provider: PROVIDER,
    storage_provider: storageProvider,
    matches,
    summary: summarizeSimilarSetups(matches),
    features,
    timestamp: nowIso(),
  };

  if (options.cache !== false && options.replay_mode !== true) {
    await cacheSimilarityResult(features.symbol, result);
  }
  return result;
}

async function getMemoryStatus() {
  const dbReady = await ensureSchema();
  if (dbReady) {
    try {
      const count = await getPool().query('SELECT COUNT(*)::int AS count FROM signal_memory');
      return {
        ok: true,
        provider: PROVIDER,
        storage_provider: pgvectorSupported ? 'postgres_pgvector' : 'postgres_json_features',
        db: { configured: true, available: true, pgDependency: !!Pg, lastError: dbLastError },
        pgvector: { supported: pgvectorSupported },
        count: count.rows?.[0]?.count ?? 0,
        redis: redisService.status(),
        cache_keys: [LATEST_KEY, `${SYMBOL_KEY_PREFIX}{SYMBOL}`],
      };
    } catch (err) {
      setDbError(err);
    }
  }

  const rows = loadFileRows();
  return {
    ok: true,
    provider: PROVIDER,
    storage_provider: 'file_json_features',
    db: { configured: hasDbConfig(), available: false, pgDependency: !!Pg, lastError: dbLastError },
    pgvector: { supported: false },
    count: rows.length,
    redis: redisService.status(),
    cache_keys: [LATEST_KEY, `${SYMBOL_KEY_PREFIX}{SYMBOL}`],
  };
}

async function getCachedSimilarity(symbol) {
  const normalized = upper(symbol, '');
  if (!normalized) return null;
  return redisService.getJson(`${SYMBOL_KEY_PREFIX}${normalized}`, null);
}

module.exports = {
  buildSignalFeatures,
  saveSignalMemory,
  findSimilarSetups,
  summarizeSimilarSetups,
  getMemoryStatus,
  getCachedSimilarity,
  LATEST_KEY,
  SYMBOL_KEY_PREFIX,
  CACHE_TTL_SECONDS,
  PROVIDER,
};
