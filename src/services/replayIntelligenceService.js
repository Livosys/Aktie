'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const redisService = require('./redisService');
const agentReasoningService = require('./agentReasoningService');
const vectorMemoryService = require('./vectorMemoryService');
const riskEngineService = require('./riskEngineService');
const exitEngineService = require('./exitEngineService');
const executionSafetyService = require('./executionSafetyService');
const marketUniverse = require('./marketUniverseService');
const notificationEngineV2 = require('../alerts/notificationEngineV2');
const { loadCandles } = require('../data/marketDataStore');
const { toScannerFormat } = require('../data/candleAggregator');
const { calcIndicators } = require('../scanner/indicators');
const { classifyNarrowState } = require('../scanner/narrowState');
const { applyEngineV3 } = require('../scanner/engineV3');
const { calcMarketRegimeV2, applyMarketRegimeV2 } = require('../scanner/marketRegimeEngine');
const { applyHistoricalEdge } = require('../scanner/historicalEdge');
const { buildDaytradeSignal } = require('../scanner/daytradeSignalEngine');
const { evaluateMarketGate, explainMarketGateDecision } = require('../markets/marketGate');

const DATA_DIR = path.resolve(__dirname, '../../data/replay-intelligence');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const SUMMARY_DIR = path.join(DATA_DIR, 'summary');
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

const MIN_CANDLES = 30;
const WARM_CANDLES = 210;
const MAX_WINDOW = 500;
const MAX_EVENTS_IN_REDIS = 5000;
const VALID_SPEEDS = new Set(['1x', '5x', '10x', 'instant']);
const VALID_RISK = new Set(['conservative', 'normal', 'aggressive']);
const VALID_TIMEFRAMES = new Set(['2m']);

const controllers = new Map();

function nowIso() {
  return new Date().toISOString();
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureStorage() {
  ensureDir(SESSIONS_DIR);
  ensureDir(EVENTS_DIR);
  ensureDir(SUMMARY_DIR);
  if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, '[]\n', 'utf8');
}

function readJson(file, fallback) {
  ensureStorage();
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureStorage();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJsonl(file) {
  ensureStorage();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

function appendJsonl(file, row) {
  ensureStorage();
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

function sessionPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function eventsPath(sessionId) {
  return path.join(EVENTS_DIR, `${sessionId}.jsonl`);
}

function summaryPath(sessionId) {
  return path.join(SUMMARY_DIR, `${sessionId}.json`);
}

function makeSessionId() {
  return `replay_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeConfig(config = {}) {
  const symbols = Array.isArray(config.symbols)
    ? config.symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean)
    : [];
  if (!symbols.length) throw new Error('symbols array required');

  const dateFrom = String(config.date_from || config.start || '').slice(0, 10);
  const dateTo = String(config.date_to || config.end || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw new Error('date_from and date_to required as YYYY-MM-DD');
  }
  if (dateFrom > dateTo) throw new Error('date_from must be before or equal to date_to');

  const timeframe = String(config.timeframe || '2m').toLowerCase();
  if (!VALID_TIMEFRAMES.has(timeframe)) throw new Error('only timeframe=2m is supported in replay v2');

  const speed = String(config.speed || 'instant').toLowerCase();
  if (!VALID_SPEEDS.has(speed)) throw new Error('speed must be 1x, 5x, 10x or instant');

  const riskProfile = String(config.risk_profile || 'normal').toLowerCase();
  if (!VALID_RISK.has(riskProfile)) throw new Error('risk_profile must be conservative, normal or aggressive');

  const skippedByMarketControls = [...new Set(symbols)]
    .filter((symbol) => !marketUniverse.symbolEnabledFor(symbol, 'replay'))
    .map((symbol) => ({ symbol, reason: 'Marknadsgruppen är avstängd för replay från Daytrading.' }));
  const replaySymbols = [...new Set(symbols)]
    .filter((symbol) => marketUniverse.symbolEnabledFor(symbol, 'replay'))
    .slice(0, 50);
  if (!replaySymbols.length) throw new Error('Alla valda symboler är avstängda för replay i Daytrading.');


  return {
    symbols: replaySymbols,
    requested_symbols: [...new Set(symbols)].slice(0, 50),
    skipped_by_market_controls: skippedByMarketControls,
    date_from: dateFrom,
    date_to: dateTo,
    timeframe,
    speed,
    use_agent_reasoning: config.use_agent_reasoning === true,
    use_memory_similarity: config.use_memory_similarity === true,
    use_risk_engine: config.use_risk_engine !== false,
    use_exit_engine: config.use_exit_engine === true,
    use_execution_safety: config.use_execution_safety === true,
    initial_balance: clamp(config.initial_balance ?? 100000, 1000, 100000000),
    max_trades: Math.round(clamp(config.max_trades ?? 50, 1, 10000)),
    risk_profile: riskProfile,
  };
}

function loadIndex() {
  return readJson(INDEX_FILE, []);
}

function saveIndex(index) {
  writeJson(INDEX_FILE, index);
}

async function persistSession(session) {
  session.updatedAt = nowIso();
  writeJson(sessionPath(session.id), session);
  const index = loadIndex().filter((id) => id !== session.id);
  saveIndex([session.id, ...index].slice(0, 500));
  await redisService.setJson(`replay:session:${session.id}`, session, 0);
  return session;
}

async function persistSummary(sessionId, summary) {
  writeJson(summaryPath(sessionId), summary);
  await redisService.setJson(`replay:summary:${sessionId}`, summary, 0);
}

async function persistEventsCache(sessionId) {
  const events = readJsonl(eventsPath(sessionId)).slice(-MAX_EVENTS_IN_REDIS);
  await redisService.setJson(`replay:events:${sessionId}`, events, 0);
}

function loadSession(sessionId) {
  const session = readJson(sessionPath(sessionId), null);
  return session || null;
}

function delayForSpeed(speed) {
  if (speed === '1x') return 250;
  if (speed === '5x') return 80;
  if (speed === '10x') return 30;
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDirection(value) {
  const raw = String(value || '').toUpperCase();
  if (raw === 'UP' || raw === 'LONG' || raw === 'BUY') return 'UP';
  if (raw === 'DOWN' || raw === 'SHORT' || raw === 'SELL') return 'DOWN';
  return 'UNCERTAIN';
}

function engineSignalFrom(result, daytrade) {
  const rawSignal = String(result?.signal || '').toUpperCase();
  const direction = normalizeDirection(result?.nextMoveBias || daytrade?.daytradeDirection);
  const score = Number(daytrade?.daytradeScore ?? result?.tradeScore ?? 0);
  if (rawSignal.startsWith('LONG') || (direction === 'UP' && score >= 45)) return 'BUY';
  if (rawSignal.startsWith('SHORT') || (direction === 'DOWN' && score >= 45)) return 'SELL';
  return 'HOLD';
}

function stateGroup(state) {
  const s = String(state || '').toLowerCase();
  if (/narrow|compression|tight/.test(s)) return 'narrow';
  if (/wide|extended/.test(s)) return 'wide';
  if (/trend/.test(s)) return 'trend';
  if (/chop|range|sideway/.test(s)) return 'choppy';
  return s || 'unknown';
}

function gateStatusFromDaytrade(status) {
  if (status === 'Bekräftad' || status === 'Intressant') return 'watch';
  if (status === 'Bevaka') return 'caution';
  return 'avoid';
}

function confidenceThreshold(riskProfile) {
  if (riskProfile === 'conservative') return 80;
  if (riskProfile === 'aggressive') return 62;
  return 70;
}

function riskRules(riskProfile) {
  if (riskProfile === 'conservative') return { targetPct: 0.35, stopPct: 0.2, maxHoldCandles: 8 };
  if (riskProfile === 'aggressive') return { targetPct: 0.7, stopPct: 0.4, maxHoldCandles: 15 };
  return { targetPct: 0.45, stopPct: 0.28, maxHoldCandles: 10 };
}

function replayDayKey(timestamp) {
  return String(timestamp || nowIso()).slice(0, 10);
}

function ensureReplayRiskState(session, timestamp) {
  const day = replayDayKey(timestamp);
  if (!session.riskState) {
    session.riskState = {
      balance: session.config.initial_balance,
      equity: session.config.initial_balance,
      day,
      daily_pnl_pct: 0,
      daily_trades: 0,
      consecutive_losses: 0,
      last_loss_at: null,
      open_positions: [],
    };
  }
  if (session.riskState.day !== day) {
    session.riskState.day = day;
    session.riskState.daily_pnl_pct = 0;
    session.riskState.daily_trades = 0;
  }
  return session.riskState;
}

function buildReplayRiskContext(signalContext, finalConfidence, agentBlocked, agentReason, memorySummary, config) {
  const rules = riskRules(config.risk_profile);
  const memoryFlags = [];
  if (memorySummary?.sample_size >= 20 && memorySummary?.win_rate != null && memorySummary.win_rate < 35) {
    memoryFlags.push('bad_historical_setup');
  }
  return {
    ...signalContext,
    replay_mode: true,
    evaluation_source: 'replay',
    confidence: finalConfidence,
    confidenceScore: finalConfidence,
    stop_loss_pct: rules.stopPct,
    target_pct: rules.targetPct,
    spread_pct: signalContext.spread_pct ?? signalContext.spreadPct ?? null,
    liquidity_score: signalContext.liquidity_score ?? signalContext.liquidityScore ?? null,
    volatility_score: signalContext.volatility_score ?? signalContext.volatilityScore ?? null,
    agent: {
      should_block_trade: agentBlocked === true,
      risk_notes: agentReason,
    },
    memory: {
      ...(memorySummary || {}),
      risk_flags: memoryFlags,
    },
  };
}

function buildReplaySafetyContext(signalContext, riskEvaluation, config) {
  const timestamp = signalContext.timestamp || nowIso();
  return {
    symbol: signalContext.symbol,
    direction: signalContext.direction,
    tradeIntent: 'ENTER',
    source: 'replay',
    replay_mode: true,
    market: {
      is_open: true,
      market_group: signalContext.marketGroup || 'REPLAY',
      session: 'replay',
    },
    data: {
      last_price_at: timestamp,
      last_candle_at: timestamp,
      last_scan_at: timestamp,
      provider_status: 'ok',
    },
    system: {
      redis_status: 'fallback',
      memory_mb: Math.round((process.memoryUsage?.().rss || 0) / 1024 / 1024) || null,
      pm2_restarts_1h: 0,
      api_errors_5m: 0,
      notification_status: 'ok',
      overall_status: 'OK',
    },
    risk: {
      allowed: riskEvaluation?.allowed !== false,
      pause_trading: riskEvaluation?.pause_trading === true,
    },
    exit: {
      ready: true,
    },
    config_snapshot: {
      use_execution_safety: config.use_execution_safety === true,
    },
  };
}

function updateReplayRiskStateAfterTrade(session, event, riskEvaluation) {
  const state = ensureReplayRiskState(session, event.timestamp);
  const positionSize = Number(riskEvaluation?.position_size_sek || 0);
  const pnlPct = Number(event.simulated_pnl_pct || 0);
  const pnlSek = positionSize * (pnlPct / 100);
  state.balance = round((Number(state.balance) || session.config.initial_balance) + pnlSek, 2);
  state.equity = state.balance;
  state.daily_trades += 1;
  state.daily_pnl_pct = round((Number(state.daily_pnl_pct) || 0) + pnlPct, 4);
  if (event.outcome === 'loss') {
    state.consecutive_losses += 1;
    state.last_loss_at = event.exit_time || event.timestamp;
  } else if (event.outcome === 'win') {
    state.consecutive_losses = 0;
  }
  return {
    risk_pnl_sek: round(pnlSek, 2),
    risk_equity_after: state.equity,
    risk_daily_trades_after: state.daily_trades,
    risk_consecutive_losses_after: state.consecutive_losses,
  };
}

function volumeState(result) {
  const rel = Number(result?.relVol20 ?? result?.relativeVolume ?? result?.volumeRatio);
  if (!Number.isFinite(rel)) return result?.volumeState || 'normal';
  if (rel >= 1.5) return 'strong';
  if (rel >= 0.8) return 'normal';
  return 'weak';
}

function buildSignalContext(result, daytrade, candle, config) {
  const direction = normalizeDirection(result?.nextMoveBias || daytrade?.daytradeDirection);
  return {
    replay_mode: true,
    symbol: result.symbol,
    timestamp: candle.t || candle.ts || result.lastUpdate,
    candleTs: candle.t || candle.ts || result.lastUpdate,
    timeframe: config.timeframe,
    price: result.price ?? candle.c,
    state: stateGroup(result.state),
    rawState: result.state,
    signal: result.signal,
    direction,
    nextMoveBias: direction,
    confidence: daytrade.daytradeScore,
    confidenceScore: daytrade.daytradeScore,
    score: result.tradeScore ?? daytrade.daytradeScore,
    priorityScore: result.tradeScore ?? daytrade.daytradeScore,
    status: gateStatusFromDaytrade(daytrade.daytradeStatus),
    dataFreshness: 'LIVE',
    marketClosed: false,
    volumeState: volumeState(result),
    signalFamily: result.signalFamily || result.family || (stateGroup(result.state) === 'narrow' ? 'NARROW_COMPRESSION' : 'REPLAY_ENGINE'),
    signalSubtype: result.signalSubtype || result.eventType || result.narrowType || result.signal || 'REPLAY_SIGNAL',
    extensionLevel: result.extensionLevel || (result.breakoutAlreadyOccurred ? 'extended' : 'none'),
    twoMinuteConflict: result.twoMinuteConflict === true,
    hardBlockers: result.hardBlockers || [],
    softBlockers: result.softBlockers || result.daytradeWarnings || [],
    indicators: {
      rsi: result.rsi ?? result.indicators?.rsi,
      ema9: result.ema9,
      ema21: result.ema21,
      vwapDistancePct: result.vwapDistancePct,
      signalFamily: result.signalFamily,
      signalSubtype: result.signalSubtype,
    },
    gate: {
      targetPct: riskRules(config.risk_profile).targetPct,
    },
  };
}

async function simulateOutcome(candles, index, direction, config, signalContext = {}, memorySummary = null) {
  const entry = candles[index];
  const entryPrice = Number(entry?.c);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !['UP', 'DOWN'].includes(direction)) {
    return { result: 'tie', pnlPct: 0, holdMinutes: 0, exitTime: entry?.t || entry?.ts || null };
  }

  const rules = riskRules(config.risk_profile);
  let finalPnl = 0;
  let holdCandles = 0;
  let exitTime = entry.t || entry.ts || null;
  let baseline = null;
  const openTrade = {
    id: `replay_${signalContext.symbol || 'UNKNOWN'}_${index}`,
    replay_mode: true,
    symbol: signalContext.symbol,
    direction,
    entry_price: entryPrice,
    target_pct: rules.targetPct,
    stop_loss_pct: rules.stopPct,
    opened_at: entry.t || entry.ts || signalContext.timestamp,
    max_favorable_pct: 0,
    max_adverse_pct: 0,
    signal_type: signalContext.signalSubtype || signalContext.signalFamily,
    version: 'replay_v2',
    market_group: signalContext.marketGroup || (String(signalContext.symbol || '').endsWith('USDT') ? 'CRYPTO_MAJOR' : 'UNKNOWN'),
    memory_summary: memorySummary,
    max_hold_minutes: rules.maxHoldCandles * 2,
  };

  function withBaseline(result) {
    if (!config.use_exit_engine || !baseline) return result;
    return {
      ...result,
      baseline_pnl_pct: baseline.pnlPct,
      baseline_outcome: baseline.result,
      baseline_hold_minutes: baseline.holdMinutes,
      baseline_exit_time: baseline.exitTime,
      baseline_exit_reason: baseline.exitReason,
      exit_engine_enabled: true,
    };
  }

  for (let offset = 1; offset <= rules.maxHoldCandles && index + offset < candles.length; offset++) {
    const c = candles[index + offset];
    const high = Number(c.h);
    const low = Number(c.l);
    const close = Number(c.c);
    holdCandles = offset;
    exitTime = c.t || c.ts || exitTime;

    const highPnl = direction === 'UP'
      ? ((high - entryPrice) / entryPrice) * 100
      : ((entryPrice - low) / entryPrice) * 100;
    const lowPnl = direction === 'UP'
      ? ((low - entryPrice) / entryPrice) * 100
      : ((entryPrice - high) / entryPrice) * 100;

    if (Number.isFinite(lowPnl) && lowPnl <= -rules.stopPct) {
      baseline = { result: 'loss', pnlPct: round(-rules.stopPct, 4), holdMinutes: offset * 2, exitTime, exitReason: 'stop_loss' };
      return withBaseline({ ...baseline, exit_reason_code: 'stop_loss', exit_engine_enabled: false });
    }
    if (Number.isFinite(highPnl) && highPnl >= rules.targetPct) {
      baseline = { result: 'win', pnlPct: round(rules.targetPct, 4), holdMinutes: offset * 2, exitTime, exitReason: 'target_hit' };
      return withBaseline({ ...baseline, exit_reason_code: 'target_hit', exit_engine_enabled: false });
    }

    if (Number.isFinite(close)) {
      finalPnl = direction === 'UP'
        ? ((close - entryPrice) / entryPrice) * 100
        : ((entryPrice - close) / entryPrice) * 100;
    }

    if (Number.isFinite(highPnl) && highPnl > openTrade.max_favorable_pct) openTrade.max_favorable_pct = round(highPnl, 4);
    if (Number.isFinite(lowPnl) && lowPnl < openTrade.max_adverse_pct) openTrade.max_adverse_pct = round(lowPnl, 4);

    if (config.use_exit_engine) {
      const marketState = {
        replay_mode: true,
        price: close,
        current_pnl_pct: round(finalPnl, 4),
        volume_strength: signalContext.volumeState || 'normal',
        momentum_strength: openTrade.max_favorable_pct - finalPnl >= 0.04 ? 'fading' : 'normal',
        state: signalContext.state || 'unknown',
        spread_pct: signalContext.spread_pct ?? null,
        volatility_score: signalContext.volatility_score ?? null,
        market_compass: signalContext.market_compass || signalContext.marketCompass || 'MIXED',
        seconds_since_update: 0,
        age_minutes: offset * 2,
      };
      const decision = await exitEngineService.evaluateExit(
        { ...openTrade, current_price: close },
        marketState,
        { ...await exitEngineService.getExitConfig(), mode: 'paper' },
      );
      decision.replay_mode = true;
      if (['EXIT', 'TAKE_PROFIT'].includes(decision.action)) {
        baseline = baseline || await simulateOutcome(candles, index, direction, { ...config, use_exit_engine: false }, signalContext, memorySummary);
        return {
          result: finalPnl > 0 ? 'win' : finalPnl < 0 ? 'loss' : 'tie',
          pnlPct: round(finalPnl, 4),
          holdMinutes: offset * 2,
          exitTime,
          exit_reason_code: decision.exit_reason_code,
          exit_engine_action: decision.action,
          exit_engine_reason: decision.reason,
          exit_engine_enabled: true,
          baseline_pnl_pct: baseline.pnlPct,
          baseline_outcome: baseline.result,
          baseline_hold_minutes: baseline.holdMinutes,
          baseline_exit_time: baseline.exitTime,
          baseline_exit_reason: baseline.exitReason,
        };
      }
      if (decision.action === 'TIGHTEN_STOP' && decision.new_stop_loss_pct != null) {
        openTrade.exit_engine_stop_pct = Math.max(Number(openTrade.exit_engine_stop_pct ?? -Infinity), Number(decision.new_stop_loss_pct));
      }
      if (openTrade.exit_engine_stop_pct != null && finalPnl <= Number(openTrade.exit_engine_stop_pct)) {
        baseline = baseline || await simulateOutcome(candles, index, direction, { ...config, use_exit_engine: false }, signalContext, memorySummary);
        return {
          result: finalPnl >= 0 ? 'win' : 'loss',
          pnlPct: round(finalPnl, 4),
          holdMinutes: offset * 2,
          exitTime,
          exit_reason_code: 'break_even',
          exit_engine_action: 'EXIT',
          exit_engine_reason: 'Tightened stop hit in replay.',
          exit_engine_enabled: true,
          baseline_pnl_pct: baseline.pnlPct,
          baseline_outcome: baseline.result,
          baseline_hold_minutes: baseline.holdMinutes,
          baseline_exit_time: baseline.exitTime,
          baseline_exit_reason: baseline.exitReason,
        };
      }
    }
  }

  baseline = {
    result: Math.abs(finalPnl) < 0.05 ? 'tie' : finalPnl > 0 ? 'win' : 'loss',
    pnlPct: round(finalPnl, 4),
    holdMinutes: holdCandles * 2,
    exitTime,
    exitReason: 'timeout',
  };
  return withBaseline({
    ...baseline,
    exit_reason_code: 'timeout',
    exit_engine_enabled: config.use_exit_engine === true,
  });
}

function baseResultForCandle(symbol, candles, i) {
  const sliceStart = Math.max(0, i - MAX_WINDOW);
  const window = candles.slice(sliceStart, i + 1);
  const indicators = calcIndicators(window);
  if (!indicators) return null;

  const candle = candles[i];
  const price = Number(candle.c);
  let result = classifyNarrowState({
    symbol,
    price,
    candles2m: window,
    indicators,
    lastUpdate: candle.t || candle.ts,
  });
  result = applyEngineV3(result, null);
  const marketContext = calcMarketRegimeV2(result);
  result = applyMarketRegimeV2(result, marketContext);
  result = applyHistoricalEdge(result);
  return result;
}

async function replayDecision({ session, symbol, candles, index }) {
  const config = session.config;
  const candle = candles[index];
  let result = null;
  try {
    result = baseResultForCandle(symbol, candles, index);
  } catch (err) {
    return {
      replay_mode: true,
      session_id: session.id,
      timestamp: candle?.t || candle?.ts || null,
      symbol,
      state: 'error',
      engine_signal: 'HOLD',
      gate_passed: false,
      agent_adjustment: 0,
      memory_adjustment: 0,
      final_confidence: 0,
      decision: 'HOLD',
      reason: `Replay engine-fel: ${err.message || String(err)}`,
      simulated_pnl_pct: 0,
      outcome: 'tie',
      hold_minutes: 0,
    };
  }
  if (!result) return null;

  const daytrade = buildDaytradeSignal({
    ...result,
    daytradeIgnoreStale: true,
  });
  const engineSignal = engineSignalFrom(result, daytrade);
  const signalContext = buildSignalContext(result, daytrade, candle, config);
  const gateDecision = evaluateMarketGate(signalContext, {
    conservativeMode: config.risk_profile === 'conservative',
    calibrationStats: {},
    replayMode: true,
  });

  let agentAdjustment = 0;
  let agentBlocked = false;
  let agentReason = null;
  if (config.use_agent_reasoning) {
    const risk = agentReasoningService.buildRiskView(signalContext);
    agentAdjustment = clamp(risk.confidence_adjustment, -15, 10);
    agentBlocked = risk.should_block_trade === true;
    agentReason = risk.risk_notes;
  }

  let memoryAdjustment = 0;
  let memorySummary = null;
  if (config.use_memory_similarity) {
    const memory = await vectorMemoryService.findSimilarSetups(signalContext, {
      limit: 25,
      cache: false,
      replay_mode: true,
    });
    memorySummary = memory.summary || null;
    memoryAdjustment = clamp(memorySummary?.memory_confidence_adjustment ?? 0, -10, 8);
  }

  const baseConfidence = Number(daytrade.daytradeScore ?? result.tradeScore ?? 0);
  const finalConfidence = Math.round(clamp(baseConfidence + agentAdjustment + memoryAdjustment, 0, 100));
  const direction = engineSignal === 'BUY' ? 'UP' : engineSignal === 'SELL' ? 'DOWN' : 'UNCERTAIN';
  const simulated = await simulateOutcome(candles, index, direction, config, signalContext, memorySummary);
  const threshold = confidenceThreshold(config.risk_profile);
  const gatePassed = gateDecision.allowed === true;
  let riskEvaluation = null;
  let executionSafety = null;
  let wouldHaveEntered = false;

  let decision = 'HOLD';
  let reason = 'Fast engine gav ingen köp/sälj-signal.';
  if (engineSignal !== 'HOLD') {
    if (!gatePassed) {
      decision = 'L_SKIP';
      reason = explainMarketGateDecision(gateDecision).replace(/\s+/g, ' ').slice(0, 500);
    } else if (config.use_risk_engine) {
      const riskConfig = await riskEngineService.getRiskConfig();
      const riskState = ensureReplayRiskState(session, signalContext.timestamp);
      riskEvaluation = await riskEngineService.evaluateTradeRisk(
        buildReplayRiskContext(signalContext, finalConfidence, agentBlocked, agentReason, memorySummary, config),
        {
          ...riskState,
          open_positions: [],
          _riskConfig: {
            ...riskConfig,
            mode: 'replay',
          },
        },
        { persist: false, evaluationSource: 'replay' },
      );
      if (!riskEvaluation.allowed) {
        decision = 'L_SKIP';
        reason = `Risk Engine v2 blockerade: ${riskEvaluation.block_reasons.join(', ')}.`;
      } else if (finalConfidence < threshold) {
        decision = 'L_SKIP';
        reason = `Konfidens ${finalConfidence} under replay-tröskel ${threshold}.`;
      } else if (session.progress.tradesTaken >= config.max_trades) {
        decision = 'L_SKIP';
        reason = `Max trades (${config.max_trades}) uppnått i replay-session.`;
      } else if (config.use_execution_safety) {
        wouldHaveEntered = true;
        executionSafety = await executionSafetyService.evaluateExecutionSafety(
          buildReplaySafetyContext(signalContext, riskEvaluation, config),
          { persist: false },
        );
        if ((executionSafety.block_reasons || []).length || executionSafety.paper_execution_allowed === false) {
          decision = 'L_SKIP';
          reason = `Execution Safety v1 blockerade replay-entry: ${(executionSafety.block_reasons || executionSafety.paper_block_reasons || []).join(', ') || 'safety_block'}.`;
        } else {
          decision = 'ENTER';
          reason = `Replay-entry: ${engineSignal}, gate godkänd, risk godkänd, safety godkänd och konfidens ${finalConfidence}.`;
          session.progress.tradesTaken += 1;
        }
      } else {
        decision = 'ENTER';
        reason = `Replay-entry: ${engineSignal}, gate godkänd, risk godkänd och konfidens ${finalConfidence}.`;
        session.progress.tradesTaken += 1;
      }
    } else if (agentBlocked) {
      decision = 'L_SKIP';
      reason = agentReason || 'Agenten blockerade setupen i replay mode.';
    } else if (finalConfidence < threshold) {
      decision = 'L_SKIP';
      reason = `Konfidens ${finalConfidence} under replay-tröskel ${threshold}.`;
    } else if (session.progress.tradesTaken >= config.max_trades) {
      decision = 'L_SKIP';
      reason = `Max trades (${config.max_trades}) uppnått i replay-session.`;
    } else if (config.use_execution_safety) {
      wouldHaveEntered = true;
      executionSafety = await executionSafetyService.evaluateExecutionSafety(
        buildReplaySafetyContext(signalContext, riskEvaluation, config),
        { persist: false },
      );
      if ((executionSafety.block_reasons || []).length || executionSafety.paper_execution_allowed === false) {
        decision = 'L_SKIP';
        reason = `Execution Safety v1 blockerade replay-entry: ${(executionSafety.block_reasons || executionSafety.paper_block_reasons || []).join(', ') || 'safety_block'}.`;
      } else {
        decision = 'ENTER';
        reason = `Replay-entry: ${engineSignal}, gate godkänd, safety godkänd och konfidens ${finalConfidence}.`;
        session.progress.tradesTaken += 1;
      }
    } else {
      decision = 'ENTER';
      reason = `Replay-entry: ${engineSignal}, gate godkänd och konfidens ${finalConfidence}.`;
      session.progress.tradesTaken += 1;
    }
  }

  const event = {
    replay_mode: true,
    session_id: session.id,
    timestamp: candle.t || candle.ts || result.lastUpdate,
    symbol,
    state: signalContext.state,
    engine_signal: engineSignal,
    gate_passed: gatePassed,
    agent_adjustment: agentAdjustment,
    memory_adjustment: memoryAdjustment,
    final_confidence: finalConfidence,
    decision,
    reason,
    simulated_pnl_pct: simulated.pnlPct,
    baseline_pnl_pct: simulated.baseline_pnl_pct ?? simulated.pnlPct,
    baseline_outcome: simulated.baseline_outcome || simulated.result,
    baseline_hold_minutes: simulated.baseline_hold_minutes ?? simulated.holdMinutes,
    baseline_exit_time: simulated.baseline_exit_time || simulated.exitTime,
    baseline_exit_reason: simulated.baseline_exit_reason || simulated.exit_reason_code || null,
    exit_engine_enabled: simulated.exit_engine_enabled === true,
    exit_engine_action: simulated.exit_engine_action || null,
    exit_reason_code: simulated.exit_reason_code || null,
    exit_engine_reason: simulated.exit_engine_reason || null,
    outcome: simulated.result,
    hold_minutes: simulated.holdMinutes,
    exit_time: simulated.exitTime,
    price: round(signalContext.price, 4),
    base_confidence: round(baseConfidence, 2),
    gate_score: gateDecision.gateScore,
    gate_mode: gateDecision.mode,
    memory_sample_size: memorySummary?.sample_size ?? null,
    memory_win_rate: memorySummary?.win_rate ?? null,
    risk_engine_enabled: config.use_risk_engine,
    risk_allowed: riskEvaluation?.allowed ?? null,
    risk_level: riskEvaluation?.risk_level ?? null,
    risk_block_reasons: riskEvaluation?.block_reasons || [],
    risk_warnings: riskEvaluation?.warnings || [],
    risk_position_size_sek: riskEvaluation?.position_size_sek ?? null,
    risk_position_size_units: riskEvaluation?.position_size_units ?? null,
    risk_max_loss_sek: riskEvaluation?.max_loss_sek ?? null,
    risk_actual_position_risk_sek: riskEvaluation?.actual_position_risk_sek ?? null,
    risk_position_clamped: riskEvaluation?.position_clamped === true,
    risk_pause_trading: riskEvaluation?.pause_trading === true,
    execution_safety_enabled: config.use_execution_safety === true,
    execution_safety_allowed: executionSafety ? ((executionSafety.block_reasons || []).length === 0 && executionSafety.paper_execution_allowed !== false) : null,
    execution_safety_level: executionSafety?.safety_level || null,
    execution_safety_block_reasons: executionSafety?.block_reasons || [],
    execution_safety_paper_block_reasons: executionSafety?.paper_block_reasons || [],
    execution_safety_warnings: executionSafety?.warnings || [],
    execution_safety_would_have_entered: wouldHaveEntered === true,
  };

  if (decision === 'ENTER' && riskEvaluation) {
    Object.assign(event, updateReplayRiskStateAfterTrade(session, event, riskEvaluation));
  }

  return event;
}

function summarizeEvents(session, events) {
  const trades = events.filter((e) => e.decision === 'ENTER');
  const wins = trades.filter((e) => e.outcome === 'win').length;
  const losses = trades.filter((e) => e.outcome === 'loss').length;
  const ties = trades.filter((e) => e.outcome === 'tie').length;
  const totalPnl = trades.reduce((sum, e) => sum + (Number(e.simulated_pnl_pct) || 0), 0);
  const blocked = events.filter((e) => e.decision === 'L_SKIP' && ['BUY', 'SELL'].includes(e.engine_signal));
  const blockedLost = blocked.filter((e) => Number(e.simulated_pnl_pct) < 0).length;
  const blockedWon = blocked.filter((e) => Number(e.simulated_pnl_pct) > 0).length;
  const riskBlocks = blocked.filter((e) => (e.risk_block_reasons || []).length > 0 || e.risk_allowed === false);
  const riskTrades = trades.filter((e) => Number.isFinite(Number(e.risk_position_size_sek)));
  const riskAvoidedLosses = riskBlocks
    .filter((e) => Number(e.simulated_pnl_pct) < 0)
    .reduce((sum, e) => sum + Math.abs(Number(e.simulated_pnl_pct) || 0), 0);
  const riskMissedWinners = riskBlocks
    .filter((e) => Number(e.simulated_pnl_pct) > 0)
    .reduce((sum, e) => sum + (Number(e.simulated_pnl_pct) || 0), 0);

  let equity = Number(session.config.initial_balance) || 100000;
  let peak = equity;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity *= 1 + ((Number(trade.simulated_pnl_pct) || 0) / 100);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
  }

  let riskPeak = Number(session.config.initial_balance) || 100000;
  let maxDrawdownWithRiskEngine = 0;
  for (const trade of riskTrades) {
    const riskEquity = Number(trade.risk_equity_after);
    if (!Number.isFinite(riskEquity)) continue;
    riskPeak = Math.max(riskPeak, riskEquity);
    if (riskPeak > 0) {
      maxDrawdownWithRiskEngine = Math.max(maxDrawdownWithRiskEngine, ((riskPeak - riskEquity) / riskPeak) * 100);
    }
  }

  const groupCount = (rows, keyFn) => rows.reduce((acc, row) => {
    const key = keyFn(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const avg = (rows, key) => {
    const nums = rows.map((row) => Number(row[key])).filter(Number.isFinite);
    return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length, 4) : 0;
  };

  const sortedTrades = [...trades].sort((a, b) => (Number(b.simulated_pnl_pct) || 0) - (Number(a.simulated_pnl_pct) || 0));
  const agentDelta = events.reduce((sum, e) => sum + (Number(e.agent_adjustment) || 0), 0);
  const memoryDelta = events.reduce((sum, e) => sum + (Number(e.memory_adjustment) || 0), 0);
  const exitEngineTrades = trades.filter((e) => e.exit_engine_enabled === true);
  const baselinePnl = trades.reduce((sum, e) => sum + (Number(e.baseline_pnl_pct ?? e.simulated_pnl_pct) || 0), 0);
  const baselineTimeouts = trades.filter((e) => (e.baseline_exit_reason || '').includes('timeout') || e.baseline_outcome === 'tie').length;
  const actualTimeouts = trades.filter((e) => (e.exit_reason_code || '').includes('timeout') || e.outcome === 'tie').length;
  const improvedExits = exitEngineTrades.filter((e) => Number(e.simulated_pnl_pct) > Number(e.baseline_pnl_pct ?? e.simulated_pnl_pct) + 0.02);
  const missedBiggerWinners = exitEngineTrades.filter((e) => Number(e.baseline_pnl_pct ?? e.simulated_pnl_pct) > Number(e.simulated_pnl_pct) + 0.02);
  const nearTargetSaved = improvedExits.filter((e) => ['near_target_profit', 'near_target_pullback'].includes(e.exit_reason_code)).length;
  const safetyBlocks = blocked.filter((e) => e.execution_safety_enabled === true && (e.execution_safety_allowed === false || (e.execution_safety_block_reasons || []).length));
  const safetyReasons = safetyBlocks.flatMap((e) => (e.execution_safety_block_reasons || []).map((reason) => ({ reason })));

  return {
    ok: true,
    replay_mode: true,
    session_id: session.id,
    status: session.status,
    config: session.config,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    total_events: events.length,
    total_trades: trades.length,
    win_rate: trades.length ? round((wins / trades.length) * 100, 2) : 0,
    loss_rate: trades.length ? round((losses / trades.length) * 100, 2) : 0,
    tie_rate: trades.length ? round((ties / trades.length) * 100, 2) : 0,
    total_pl_pct: round(totalPnl, 4),
    ending_balance: round(equity, 2),
    avg_pl_per_trade: trades.length ? round(totalPnl / trades.length, 4) : 0,
    max_drawdown: round(maxDrawdown, 4),
    risk_engine: {
      enabled: session.config.use_risk_engine,
      risk_blocks: riskBlocks.length,
      trades_reduced_by_sizing: events.filter((e) => e.risk_position_clamped === true).length,
      avoided_losses: round(riskAvoidedLosses, 4),
      missed_winners: round(riskMissedWinners, 4),
      avg_position_size: riskTrades.length ? round(riskTrades.reduce((sum, e) => sum + (Number(e.risk_position_size_sek) || 0), 0) / riskTrades.length, 2) : 0,
      max_drawdown_with_risk_engine: round(maxDrawdownWithRiskEngine, 4),
      blocks_by_reason: groupCount(riskBlocks.flatMap((e) => (e.risk_block_reasons || []).map((reason) => ({ reason }))), (e) => e.reason),
    },
    best_trade: sortedTrades[0] || null,
    worst_trade: sortedTrades[sortedTrades.length - 1] || null,
    avg_hold_time: avg(trades, 'hold_minutes'),
    trades_by_state: groupCount(trades, (e) => e.state),
    trades_by_symbol: groupCount(trades, (e) => e.symbol),
    agent_impact: {
      enabled: session.config.use_agent_reasoning,
      total_adjustment: round(agentDelta, 2),
      avg_adjustment: events.length ? round(agentDelta / events.length, 2) : 0,
      negative_events: events.filter((e) => Number(e.agent_adjustment) < 0).length,
      positive_events: events.filter((e) => Number(e.agent_adjustment) > 0).length,
    },
    memory_impact: {
      enabled: session.config.use_memory_similarity,
      total_adjustment: round(memoryDelta, 2),
      avg_adjustment: events.length ? round(memoryDelta / events.length, 2) : 0,
      negative_events: events.filter((e) => Number(e.memory_adjustment) < 0).length,
      positive_events: events.filter((e) => Number(e.memory_adjustment) > 0).length,
    },
    exit_engine: {
      enabled: session.config.use_exit_engine === true,
      compared_to_baseline: true,
      timeout_reduction: Math.max(0, baselineTimeouts - actualTimeouts),
      timeout_reduction_pct: baselineTimeouts ? round(((baselineTimeouts - actualTimeouts) / baselineTimeouts) * 100, 2) : 0,
      avg_pl_change: trades.length ? round((totalPnl - baselinePnl) / trades.length, 4) : 0,
      baseline_total_pl_pct: round(baselinePnl, 4),
      near_target_saved_trades: nearTargetSaved,
      trailing_stop_exits: exitEngineTrades.filter((e) => e.exit_reason_code === 'trailing_stop').length,
      momentum_fade_exits: exitEngineTrades.filter((e) => e.exit_reason_code === 'momentum_fade').length,
      timeout_saves: exitEngineTrades.filter((e) => e.exit_reason_code === 'timeout_intelligence').length,
      missed_bigger_winners: missedBiggerWinners.length,
      improved_exits_vs_baseline: improvedExits.length,
    },
    execution_safety: {
      enabled: session.config.use_execution_safety === true,
      safety_blocks: safetyBlocks.length,
      stale_data_blocks: safetyBlocks.filter((e) => (e.execution_safety_block_reasons || []).some((reason) => String(reason).startsWith('stale_'))).length,
      risk_pause_blocks: safetyBlocks.filter((e) => (e.execution_safety_block_reasons || []).includes('risk_pause')).length,
      kill_switch_blocks: safetyBlocks.filter((e) => (e.execution_safety_block_reasons || []).includes('kill_switch_active')).length,
      entries_prevented: safetyBlocks.length,
      would_have_entered_count: events.filter((e) => e.execution_safety_would_have_entered === true).length,
      blocks_by_reason: groupCount(safetyReasons, (e) => e.reason),
    },
    blocked_trades_that_would_have_lost: blockedLost,
    blocked_trades_that_would_have_won: blockedWon,
    top_winning_decisions: sortedTrades.slice(0, 10),
    top_losing_decisions: [...sortedTrades].reverse().slice(0, 10),
    blocked_trades: blocked.slice(0, 100),
    redis_keys: [
      `replay:session:${session.id}`,
      `replay:events:${session.id}`,
      `replay:summary:${session.id}`,
    ],
    storage: {
      session_file: sessionPath(session.id),
      events_file: eventsPath(session.id),
      summary_file: summaryPath(session.id),
    },
    isolation: {
      live_paper_trading_state_touched: false,
      live_gate_status_touched: false,
      real_signal_tables_touched: false,
      notifications_sent: false,
    },
  };
}

async function executeSession(sessionId) {
  let session = loadSession(sessionId);
  if (!session) return;

  const controller = controllers.get(sessionId) || { paused: false, stopped: false };
  controllers.set(sessionId, controller);
  const eventsFile = eventsPath(sessionId);
  const delayMs = delayForSpeed(session.config.speed);

  try {
    session.status = 'running';
    session.startedAt = session.startedAt || nowIso();
    await persistSession(session);

    for (const symbol of session.config.symbols) {
      if (controller.stopped) break;

      const raw = loadCandles(symbol, session.config.date_from, session.config.date_to, session.config.timeframe);
      const candles = toScannerFormat(raw).filter((c) => c.t || c.ts);
      const startAt = candles.length >= WARM_CANDLES ? WARM_CANDLES : MIN_CANDLES;
      session.progress.totalCandles += Math.max(0, candles.length - startAt);
      session.progress.currentSymbol = symbol;
      await persistSession(session);

      for (let i = startAt; i < candles.length; i++) {
        if (controller.stopped) break;
        while (controller.paused && !controller.stopped) {
          session = loadSession(sessionId) || session;
          session.status = 'paused';
          await persistSession(session);
          await sleep(250);
        }
        if (controller.stopped) break;

        const event = await replayDecision({ session, symbol, candles, index: i });
        session.progress.processedCandles += 1;
        session.progress.currentTimestamp = candles[i].t || candles[i].ts || null;

        if (event && (event.engine_signal !== 'HOLD' || event.decision !== 'HOLD')) {
          appendJsonl(eventsFile, event);
          session.progress.eventsLogged += 1;
        }

        if (session.progress.processedCandles % 25 === 0) {
          await persistSession(session);
        }
        if (delayMs) await sleep(delayMs);
      }
    }

    session.status = controller.stopped ? 'stopped' : 'completed';
    session.endedAt = nowIso();
    const events = readJsonl(eventsFile);
    const summary = summarizeEvents(session, events);
    await persistSummary(sessionId, summary);
    void notificationEngineV2.processReplaySummary(summary).catch((err) => {
      console.warn('[replay-intelligence] notification v2 failed:', err.message);
    });
    session.summary = summary;
    await persistSession(session);
    await persistEventsCache(sessionId);
  } catch (err) {
    session.status = 'failed';
    session.error = err.message || String(err);
    session.endedAt = nowIso();
    await persistSession(session);
  } finally {
    controllers.delete(sessionId);
  }
}

function listReplaySessions() {
  return loadIndex()
    .map((id) => loadSession(id))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createReplaySession(config) {
  ensureStorage();
  const normalized = normalizeConfig(config);
  const id = makeSessionId();
  const session = {
    ok: true,
    id,
    replay_mode: true,
    status: 'created',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    config: normalized,
    progress: {
      totalCandles: 0,
      processedCandles: 0,
      eventsLogged: 0,
      tradesTaken: 0,
      currentSymbol: null,
      currentTimestamp: null,
    },
    riskState: {
      balance: normalized.initial_balance,
      equity: normalized.initial_balance,
      day: null,
      daily_pnl_pct: 0,
      daily_trades: 0,
      consecutive_losses: 0,
      last_loss_at: null,
      open_positions: [],
    },
    summary: null,
    safety: {
      isolated_keys_only: true,
      redis_keys: [
        `replay:session:${id}`,
        `replay:events:${id}`,
        `replay:summary:${id}`,
      ],
      live_trading_disabled: true,
      notifications_disabled: true,
    },
  };
  fs.writeFileSync(eventsPath(id), '', 'utf8');
  await persistSession(session);
  await redisService.setJson(`replay:events:${id}`, [], 0);
  return session;
}

async function runReplaySession(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return null;
  if (session.status === 'running') return session;
  if (session.status === 'completed' || session.status === 'failed' || session.status === 'stopped') {
    throw new Error(`session cannot be run from status=${session.status}`);
  }

  const controller = controllers.get(sessionId) || { paused: false, stopped: false };
  controller.paused = false;
  controller.stopped = false;
  controllers.set(sessionId, controller);

  void executeSession(sessionId);
  const updated = loadSession(sessionId) || session;
  updated.status = 'running';
  await persistSession(updated);
  return updated;
}

async function pauseReplaySession(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return null;
  const controller = controllers.get(sessionId);
  if (controller) controller.paused = true;
  session.status = 'paused';
  await persistSession(session);
  return session;
}

async function stopReplaySession(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return null;
  const controller = controllers.get(sessionId);
  if (controller) controller.stopped = true;
  session.status = 'stopped';
  session.endedAt = session.endedAt || nowIso();
  await persistSession(session);
  const events = readJsonl(eventsPath(sessionId));
  const summary = summarizeEvents(session, events);
  await persistSummary(sessionId, summary);
  await persistEventsCache(sessionId);
  return session;
}

function getReplaySessionStatus(sessionId) {
  return loadSession(sessionId);
}

function getReplayEvents(sessionId) {
  return readJsonl(eventsPath(sessionId));
}

async function summarizeReplaySession(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return null;
  const existing = readJson(summaryPath(sessionId), null);
  if (existing && ['completed', 'stopped', 'failed'].includes(session.status)) return existing;
  const events = getReplayEvents(sessionId);
  const summary = summarizeEvents(session, events);
  await persistSummary(sessionId, summary);
  return summary;
}

async function runRiskFixtureReplay() {
  const timestamp = nowIso();
  const session = {
    id: `replay_fixture_${Date.now().toString(36)}`,
    replay_mode: true,
    status: 'completed',
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: timestamp,
    config: {
      symbols: ['RISKFIX'],
      date_from: todayKey(),
      date_to: todayKey(),
      timeframe: '2m',
      speed: 'instant',
      risk_profile: 'normal',
      initial_balance: 100000,
      max_trades: 10,
      use_agent_reasoning: true,
      use_memory_similarity: true,
      use_risk_engine: true,
      use_exit_engine: false,
    },
    progress: {
      totalCandles: 3,
      processedCandles: 3,
      eventsLogged: 3,
      tradesTaken: 0,
      currentSymbol: 'RISKFIX',
      currentTimestamp: timestamp,
    },
    riskState: {
      balance: 100000,
      equity: 100000,
      day: todayKey(),
      daily_pnl_pct: 0,
      daily_trades: 0,
      consecutive_losses: 0,
      last_loss_at: null,
      open_positions: [],
    },
  };

  const riskConfig = {
    ...await riskEngineService.getRiskConfig(),
    mode: 'replay',
  };
  const baseSignal = {
    replay_mode: true,
    evaluation_source: 'replay',
    symbol: 'RISKFIX',
    direction: 'UP',
    score: 84,
    confidence: 84,
    price: 100,
    stop_loss_pct: 0.28,
    target_pct: 0.45,
    spread_pct: 0.02,
    liquidity_score: 90,
    volatility_score: 35,
    agent: {},
    memory: {},
    gate: { allowed: true, targetPct: 0.45 },
  };
  const account = () => ({
    ...session.riskState,
    open_positions: [],
    _riskConfig: riskConfig,
  });
  const buildEnter = async (overrides, pnlPct, outcome, offsetMinutes) => {
    const riskEvaluation = await riskEngineService.evaluateTradeRisk(
      { ...baseSignal, ...overrides },
      account(),
      { persist: false, evaluationSource: 'replay' },
    );
    const event = {
      replay_mode: true,
      session_id: session.id,
      timestamp: new Date(Date.now() + offsetMinutes * 60000).toISOString(),
      symbol: overrides.symbol || baseSignal.symbol,
      state: 'fixture',
      engine_signal: 'BUY',
      gate_passed: true,
      agent_adjustment: 0,
      memory_adjustment: 0,
      final_confidence: overrides.confidence || baseSignal.confidence,
      decision: 'ENTER',
      reason: 'Replay fixture entry med gate och risk godkänd.',
      simulated_pnl_pct: pnlPct,
      outcome,
      hold_minutes: 2,
      exit_time: new Date(Date.now() + (offsetMinutes + 2) * 60000).toISOString(),
      price: overrides.price || baseSignal.price,
      base_confidence: overrides.confidence || baseSignal.confidence,
      gate_score: 90,
      gate_mode: 'strict',
      memory_sample_size: 25,
      memory_win_rate: 58,
      risk_engine_enabled: true,
      risk_allowed: riskEvaluation.allowed,
      risk_level: riskEvaluation.risk_level,
      risk_block_reasons: riskEvaluation.block_reasons || [],
      risk_warnings: riskEvaluation.warnings || [],
      risk_position_size_sek: riskEvaluation.position_size_sek,
      risk_position_size_units: riskEvaluation.position_size_units,
      risk_max_loss_sek: riskEvaluation.max_loss_sek,
      risk_actual_position_risk_sek: riskEvaluation.actual_position_risk_sek,
      risk_position_clamped: riskEvaluation.position_clamped === true,
      risk_pause_trading: riskEvaluation.pause_trading === true,
    };
    session.progress.tradesTaken += 1;
    Object.assign(event, updateReplayRiskStateAfterTrade(session, event, riskEvaluation));
    return event;
  };

  const firstEntry = await buildEnter({}, 0.45, 'win', 0);
  const secondEntry = await buildEnter({ symbol: 'RISKFIX2', price: 101, confidence: 86 }, -0.28, 'loss', 4);
  const blockEvaluation = await riskEngineService.evaluateTradeRisk(
    { ...baseSignal, symbol: 'RISKBLK', confidence: 10, score: 10, price: 102 },
    account(),
    { persist: false, evaluationSource: 'replay' },
  );
  const blocked = {
    replay_mode: true,
    session_id: session.id,
    timestamp: new Date(Date.now() + 8 * 60000).toISOString(),
    symbol: 'RISKBLK',
    state: 'fixture',
    engine_signal: 'BUY',
    gate_passed: true,
    agent_adjustment: 0,
    memory_adjustment: 0,
    final_confidence: 10,
    decision: 'L_SKIP',
    reason: `Risk Engine v2 blockerade: ${blockEvaluation.block_reasons.join(', ')}.`,
    simulated_pnl_pct: -0.28,
    outcome: 'loss',
    hold_minutes: 2,
    exit_time: new Date(Date.now() + 10 * 60000).toISOString(),
    price: 102,
    base_confidence: 10,
    gate_score: 90,
    gate_mode: 'strict',
    memory_sample_size: 25,
    memory_win_rate: 58,
    risk_engine_enabled: true,
    risk_allowed: blockEvaluation.allowed,
    risk_level: blockEvaluation.risk_level,
    risk_block_reasons: blockEvaluation.block_reasons || [],
    risk_warnings: blockEvaluation.warnings || [],
    risk_position_size_sek: blockEvaluation.position_size_sek,
    risk_position_size_units: blockEvaluation.position_size_units,
    risk_max_loss_sek: blockEvaluation.max_loss_sek,
    risk_actual_position_risk_sek: blockEvaluation.actual_position_risk_sek,
    risk_position_clamped: blockEvaluation.position_clamped === true,
    risk_pause_trading: blockEvaluation.pause_trading === true,
  };

  const events = [firstEntry, secondEntry, blocked];
  const summary = summarizeEvents(session, events);
  return {
    ok: true,
    replay_mode: true,
    fixture: 'risk_engine_entry_fixture',
    summary,
    events,
  };
}

module.exports = {
  listReplaySessions,
  createReplaySession,
  runReplaySession,
  pauseReplaySession,
  stopReplaySession,
  getReplaySessionStatus,
  getReplayEvents,
  summarizeReplaySession,
  runRiskFixtureReplay,
  normalizeConfig,
};
