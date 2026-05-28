'use strict';

/**
 * Paper Trading Agent v3 — Stop Weak Conditions
 *
 * Simulates trades based on Decision Monitor signals — NO real orders are ever
 * placed. All decisions are rule-based. No LLM or external broker is called.
 *
 * Enabled state is persisted to disk so a PM2 restart resumes the paper agent
 * when the user has left it ON.
 *
 * v3 changes (2026-05-25):
 *  - Per-subtype risk profiles (target/stop/maxHold) for crypto
 *  - EMA_PULLBACK_DOWN blocked for crypto (historically -0.17% avg)
 *  - Normal-volume crypto: only VWAP subtypes allowed
 *  - EMA_PULLBACK_UP crypto: requires strong volume
 *  - ConfidenceScore ≥50 + extended move + non-strong volume → skip
 *  - checkExit uses per-trade target/stop/maxHold (not globals)
 *  - paperRiskProfile added to every trade record
 *  - Skip events include confidenceScore + volumeState
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { getLatestResults, getStockFeedStatus } = require('../scanner/scheduler');
const { getCryptoResults }                      = require('../scanner/cryptoScheduler');
const { buildDecisionMonitor }                  = require('../scanner/decisionMonitor');
const { getMarketGroup, getRiskProfile, MARKET_PROFILES } = require('../markets/marketProfiles');
const { getMarketCompass }                      = require('../markets/marketCompass');
const { evaluateMarketGate, explainMarketGateDecision,
        THRESHOLD_NORMAL, THRESHOLD_CONSERVATIVE,
        THRESHOLD_OBSERVE_ONLY, THRESHOLD_LEVERAGED,
        THRESHOLD_CRYPTO_SEC, PAPER_RULE_VERSION } = require('../markets/marketGate');
const { buildGateEffectivenessReport }          = require('../markets/marketGateEffectiveness');
const redisService                              = require('../services/redisService');
const agentReasoningService                     = require('../services/agentReasoningService');
const vectorMemoryService                       = require('../services/vectorMemoryService');
const riskEngineService                         = require('../services/riskEngineService');
const exitEngineService                         = require('../services/exitEngineService');
const executionSafetyService                    = require('../services/executionSafetyService');
const auditTrail                                = require('../services/auditTrailService');
const notificationEngineV2                      = require('../alerts/notificationEngineV2');
const strategyRuntimeConnector                  = require('../services/strategyRuntimeConnectorService');

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join(__dirname, '../../data/paper-trading');
const TRADES_FILE = path.join(DATA_DIR, 'trades.jsonl');
const STATE_FILE  = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const GATE_DECISIONS_FILE = path.join(DATA_DIR, 'gate-decisions.jsonl');

// ── Risk & position config ────────────────────────────────────────────────────

const TARGET_PCT       = 0.4;   // +0.4 % → WIN
const STOP_PCT         = 0.25;  // −0.25 % → LOSS
const MAX_HOLD_MINUTES = 20;    // after this → TIMEOUT
const MAX_OPEN_TRADES  = 3;
const COOLDOWN_MINUTES = 20;    // per symbol after close
const TICK_MS          = 30_000;
const MAX_EVENT_ROWS   = 500;
const MEMORY_EVENTS    = 100;
const EVENT_DEDUPE_MS  = 60_000;
const ALLOW_EMA_PAPER_TRADES = String(process.env.PAPER_ALLOW_EMA || 'false').toLowerCase() === 'true';
const WEAK_VOLUME_STATES = new Set(['weak', 'low', 'very_low']);

// ── Allowed signal families / subtypes ───────────────────────────────────────

const ALLOWED_FAMILIES = new Set([
  'VWAP_RECLAIM_REJECTION',
  'NARROW_COMPRESSION',
]);
if (ALLOW_EMA_PAPER_TRADES) ALLOWED_FAMILIES.add('EMA_TREND_PULLBACK');

// ── State helpers ─────────────────────────────────────────────────────────────

function defaultState() {
  return {
    enabled:            false,
    openTrades:         [],
    cooldowns:          {},   // { symbol: isoTimestamp }
    seenSignalIds:      [],   // rolling last-200 to block duplicate signalIds
    emaFilterStartedAt: null, // ISO timestamp when PAPER_ALLOW_EMA=false took effect
    conservativeMode:   false, // auto-set when v2 underperforms (≥30 trades, TO>70% or avgPnl<0)
  };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureGateDecisionsFile() {
  ensureDir();
  if (!fs.existsSync(GATE_DECISIONS_FILE)) fs.closeSync(fs.openSync(GATE_DECISIONS_FILE, 'a'));
}

function loadState() {
  ensureDir();
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      ...defaultState(),
      ...saved,
      openTrades:    Array.isArray(saved.openTrades)    ? saved.openTrades    : [],
      cooldowns:     saved.cooldowns                    || {},
      seenSignalIds: Array.isArray(saved.seenSignalIds) ? saved.seenSignalIds : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  cachePaperState(state, 'saveState');
}

function appendTrade(trade) {
  ensureDir();
  fs.appendFileSync(TRADES_FILE, JSON.stringify(trade) + '\n', 'utf8');
}

function loadJsonl(file) {
  ensureDir();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function loadClosedTrades() {
  return loadJsonl(TRADES_FILE);
}

let recentEvents = [];
let latestAgentAnalysis = null;

function makeEventId() {
  return `pte_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

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

function enrichTradeTimestamps(trade = {}, fallbackEnd = null) {
  const openedAt = trade.opened_at || trade.openedAt || trade.entryTime || trade.createdAt || null;
  const closedAt = trade.closed_at || trade.closedAt || trade.exitTime || (trade.result && trade.result !== 'OPEN' ? fallbackEnd : null);
  const lastUpdateAt = trade.last_update_at || trade.lastUpdateAt || closedAt || trade.updatedAt || openedAt || null;
  const end = closedAt || lastUpdateAt || new Date().toISOString();
  const seconds = durationSeconds(openedAt, end);
  return {
    ...trade,
    opened_at: openedAt,
    closed_at: closedAt,
    last_update_at: lastUpdateAt,
    duration_seconds: seconds,
    duration_label: durationLabel(seconds),
  };
}

function loadEvents(limit = MEMORY_EVENTS) {
  const rows = loadJsonl(EVENTS_FILE);
  return rows.slice(-limit).reverse();
}

function safeEventValue(value) {
  if (value == null) return value;
  const seen = new WeakSet();
  try {
    return JSON.parse(JSON.stringify(value, (key, val) => {
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }));
  } catch (_) {
    return null;
  }
}

function eventMarketType(input) {
  return input?.marketType || input?.market || (String(input?.symbol || '').endsWith('USDT') ? 'crypto' : 'stocks');
}

function eventFromCandidate(type, c, reasonSv, decision = 'skipped') {
  return {
    type,
    symbol:         c?.symbol        || null,
    marketType:     eventMarketType(c),
    decision,
    reasonSv,
    signalFamily:   c?.signalFamily  || null,
    signalSubtype:  c?.signalSubtype || null,
    status:         c?.status        || null,
    nextMoveBias:   c?.nextMoveBias  || null,
    dataFreshness:  c?.dataFreshness || null,
    confidenceScore: c?.confidenceScore ?? null,
    volumeState:    c?.volumeState   || null,
    mode: 'paper',
  };
}

function shouldRecordEvent(event) {
  const latest = recentEvents.find(e =>
    e.type === event.type &&
    (e.symbol || null) === (event.symbol || null) &&
    e.reasonSv === event.reasonSv
  );
  if (!latest?.timestamp) return true;
  return Date.now() - new Date(latest.timestamp).getTime() > EVENT_DEDUPE_MS;
}

function appendEvent(input) {
  ensureDir();
  const event = {
    eventId:         input.eventId   || makeEventId(),
    timestamp:       input.timestamp || new Date().toISOString(),
    type:            input.type,
    symbol:          input.symbol        || null,
    marketType:      input.marketType    || null,
    decision:        input.decision      || null,
    reasonSv:        input.reasonSv      || null,
    signalFamily:    input.signalFamily  || null,
    signalSubtype:   input.signalSubtype || null,
    status:          input.status        || null,
    nextMoveBias:    input.nextMoveBias  || null,
    dataFreshness:   input.dataFreshness || null,
    confidenceScore: input.confidenceScore ?? null,
    volumeState:     input.volumeState   || null,
    aiConfidenceAdjustment: input.aiConfidenceAdjustment ?? null,
    aiShouldBlockTrade: input.aiAgentAnalysis?.should_block_trade === true || input.aiShouldBlockTrade === true,
    riskEvaluation: safeEventValue(input.riskEvaluation || null),
    riskBlockReasons: input.riskEvaluation?.block_reasons || input.riskBlockReasons || [],
    riskWarnings: input.riskEvaluation?.warnings || input.riskWarnings || [],
    riskPositionSizeSek: input.riskEvaluation?.position_size_sek ?? input.riskPositionSizeSek ?? null,
    riskPositionUnits: input.riskEvaluation?.position_size_units ?? input.riskPositionUnits ?? null,
    riskPauseTrading: input.riskEvaluation?.pause_trading === true || input.riskPauseTrading === true,
    executionSafety: safeEventValue(input.executionSafety || null),
    safetyBlockReasons: input.executionSafety?.paper_block_reasons || input.executionSafety?.block_reasons || input.safetyBlockReasons || [],
    safetyWarnings: input.executionSafety?.warnings || input.safetyWarnings || [],
    exitReasonCode: input.exitReasonCode || null,
    exitSource: input.exitSource || null,
    exitEngineDecision: safeEventValue(input.exitEngineDecision || null),
    mode: 'paper',
  };

  if (!event.type || !shouldRecordEvent(event)) return null;

  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
  const auditType = {
    TRADE_OPENED: 'PAPER_TRADE_OPENED',
    TRADE_CLOSED: 'PAPER_TRADE_CLOSED',
    RISK_BLOCKED: 'RISK_BLOCKED',
    SAFETY_BLOCKED: 'SAFETY_BLOCKED',
  }[event.type];
  if (auditType) {
    const label = auditType === 'PAPER_TRADE_OPENED' ? 'Papertrade öppnad'
      : auditType === 'PAPER_TRADE_CLOSED' ? 'Papertrade stängd'
      : auditType === 'SAFETY_BLOCKED' ? 'Safety stoppade signal'
      : 'Risk stoppade signal';
    auditTrail.logAuditEvent({
      type: auditType,
      source: 'paper_trading',
      timestamp: event.timestamp,
      symbol: event.symbol,
      strategy_id: event.signalSubtype || event.signalFamily || null,
      message: event.symbol ? `${label} för ${event.symbol}` : label,
      details: {
        paper_event_id: event.eventId,
        decision: event.decision,
        reasonSv: event.reasonSv,
        status: event.status,
        signalFamily: event.signalFamily,
        signalSubtype: event.signalSubtype,
        riskBlockReasons: event.riskBlockReasons,
        safetyBlockReasons: event.safetyBlockReasons,
        exitReasonCode: event.exitReasonCode,
      },
    });
  }
  const rows = loadJsonl(EVENTS_FILE);
  if (rows.length > MAX_EVENT_ROWS) {
    fs.writeFileSync(EVENTS_FILE, rows.slice(-MAX_EVENT_ROWS).map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
  recentEvents = [event, ...recentEvents].slice(0, MEMORY_EVENTS);
  void redisService.addStream('paper:recent-decisions', event, 200);
  void redisService.setJson('paper:recent-decisions:latest', recentEvents, 300);
  void notificationEngineV2.processPaperEvent(event).catch((err) => {
    console.warn('[paper-trading] notification v2 failed:', err.message);
  });
  return event;
}

// ── Entry validation ──────────────────────────────────────────────────────────

function qualifiesForEntry(c, state) {
  // ── Market & freshness ────────────────────────────────────────────────────
  if (c.dataFreshness !== 'LIVE')                    return { ok: false, reason: `dataFreshness=${c.dataFreshness}` };
  if (c.marketClosed)                                return { ok: false, reason: 'market closed' };

  // Paper-only experiment: pause EMA entries before other entry checks so the
  // event log clearly shows the active filter.
  if (!ALLOW_EMA_PAPER_TRADES && c.signalFamily === 'EMA_TREND_PULLBACK')
    return { ok: false, reason: 'EMA paused in paper test' };

  // ── Decision status ───────────────────────────────────────────────────────
  if (!['watch', 'caution'].includes(c.status))      return { ok: false, reason: `status=${c.status}` };

  // ── Hard blockers ─────────────────────────────────────────────────────────
  if ((c.hardBlockers || []).length > 0)             return { ok: false, reason: 'hardBlockers present' };

  // ── Extension & volume ────────────────────────────────────────────────────
  if (c.extensionLevel === 'extreme')                return { ok: false, reason: 'extensionLevel=extreme' };
  const volState = String(c.volumeState || '').toLowerCase();
  const rawSub = c.signalSubtype || '';
  const cryptoMarket = isCryptoMarket(c);
  const v3GateVolumeState = cryptoMarket && (WEAK_VOLUME_STATES.has(volState) || volState === 'normal' || volState === 'strong');
  if (!['normal', 'strong'].includes(volState) && !v3GateVolumeState)
    return { ok: false, reason: `volumeState=${c.volumeState}` };

  // ── 2m conflict & bias ────────────────────────────────────────────────────
  if (c.twoMinuteConflict === true)                  return { ok: false, reason: 'twoMinuteConflict' };
  if (!['UP', 'DOWN'].includes(c.nextMoveBias))      return { ok: false, reason: `nextMoveBias=${c.nextMoveBias}` };

  // ── Signal family ─────────────────────────────────────────────────────────
  if (!ALLOWED_FAMILIES.has(c.signalFamily))         return { ok: false, reason: `signalFamily=${c.signalFamily}` };

  // ── Subtype per direction ─────────────────────────────────────────────────
  const sub  = rawSub;
  const bias = c.nextMoveBias;
  if (bias === 'UP') {
    const ok = sub === 'VWAP_RECLAIM_UP' ||
               sub === 'EMA_PULLBACK_UP' ||
               (c.signalFamily === 'NARROW_COMPRESSION' && sub.toUpperCase().includes('BULL'));
    if (!ok) return { ok: false, reason: `UP subtype not allowed: ${sub}` };
  } else {
    const ok = sub === 'VWAP_REJECTION_DOWN' ||
               sub === 'EMA_PULLBACK_DOWN' ||
               (c.signalFamily === 'NARROW_COMPRESSION' && sub.toUpperCase().includes('BEAR'));
    if (!ok) return { ok: false, reason: `DOWN subtype not allowed: ${sub}` };
  }

  // ── Crypto safety rules (v3) ──────────────────────────────────────────────
  if (cryptoMarket) {
    // Normal volume: only VWAP/EMA subtypes reach the gate in v3.
    if (volState === 'normal' && !isVwapSubtype(sub) && !isEmaPullbackSubtype(sub))
      return { ok: false, reason: 'crypto_normal_vol_vwap_only' };
    // High confidence + already-extended move + not strong volume → likely late entry.
    // VWAP and EMA are left to Market Gate v3 so observe_only/block is persisted.
    if ((c.confidenceScore ?? 0) >= 50 && (c.extensionLevel || 'none') !== 'none' && volState !== 'strong' && !isVwapSubtype(sub) && !isEmaPullbackSubtype(sub))
      return { ok: false, reason: 'crypto_conf50_late_move' };
  }

  // ── Position limits ───────────────────────────────────────────────────────
  if (state.openTrades.length >= MAX_OPEN_TRADES)
    return { ok: false, reason: 'max open trades' };
  if (state.openTrades.some(t => t.symbol === c.symbol))
    return { ok: false, reason: 'already open for symbol' };

  // ── Cooldown ──────────────────────────────────────────────────────────────
  const cdTs = state.cooldowns[c.symbol];
  if (cdTs) {
    const ageMin = (Date.now() - new Date(cdTs).getTime()) / 60_000;
    if (ageMin < COOLDOWN_MINUTES)
      return { ok: false, reason: `cooldown ${ageMin.toFixed(1)}m remaining` };
  }

  // ── Duplicate signal ──────────────────────────────────────────────────────
  if (c.signalId && state.seenSignalIds.includes(c.signalId))
    return { ok: false, reason: 'duplicate signalId' };

  return { ok: true };
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function isCryptoMarket(c) {
  const mt = String(c.marketType || c.market || '').toLowerCase();
  return mt === 'crypto' || String(c.symbol || '').endsWith('USDT');
}

function isVwapSubtype(subtype) {
  return subtype === 'VWAP_RECLAIM_UP' || subtype === 'VWAP_REJECTION_DOWN';
}

function isEmaPullbackSubtype(subtype) {
  return subtype === 'EMA_PULLBACK_UP' || subtype === 'EMA_PULLBACK_DOWN';
}

/**
 * Returns target/stop/maxHold profile for a candidate.
 * Prefers market profile definition; falls back to per-subtype crypto rules.
 */
function getPaperRiskProfile(c) {
  const mpRisk = getRiskProfile(c.symbol);
  if (mpRisk) {
    const sub = c.signalSubtype || '';
    // Crypto: tighter stops for specific subtypes
    if (isCryptoMarket(c)) {
      if (isVwapSubtype(sub) && String(c.volumeState || '').toLowerCase() === 'strong')
        return { targetPct: 0.20, stopPct: 0.18, maxHoldMinutes: 12,
                 profileName: `${mpRisk.groupName.toLowerCase()}_vwap_strong_v3`,
                 reasonSv: 'VWAP i crypto med stark volym.' };
      if (sub === 'VWAP_RECLAIM_UP')
        return { targetPct: mpRisk.targetPct, stopPct: mpRisk.stopPct, maxHoldMinutes: mpRisk.maxHoldMinutes,
                 profileName: `${mpRisk.groupName.toLowerCase()}_vwap_reclaim_up`,
                 reasonSv: 'VWAP återtaget uppåt.' };
      if (sub === 'VWAP_REJECTION_DOWN')
        return { targetPct: mpRisk.targetPct, stopPct: mpRisk.stopPct, maxHoldMinutes: Math.min(mpRisk.maxHoldMinutes, 15),
                 profileName: `${mpRisk.groupName.toLowerCase()}_vwap_rejection_down`,
                 reasonSv: 'VWAP avvisades nedåt.' };
      if (sub === 'EMA_PULLBACK_UP')
        return { targetPct: mpRisk.targetPct, stopPct: mpRisk.stopPct, maxHoldMinutes: Math.min(mpRisk.maxHoldMinutes, 15),
                 profileName: `${mpRisk.groupName.toLowerCase()}_ema_pullback_up`,
                 reasonSv: 'EMA uppåt med stark volym.' };
    }
    return {
      targetPct:      mpRisk.targetPct,
      stopPct:        mpRisk.stopPct,
      maxHoldMinutes: mpRisk.maxHoldMinutes,
      profileName:    `${mpRisk.groupName.toLowerCase()}_default`,
      reasonSv:       `Marknadsprofil ${mpRisk.groupName}.`,
    };
  }

  // Fallback for unknown symbols
  if (isCryptoMarket(c)) {
    return { targetPct: 0.25, stopPct: 0.20, maxHoldMinutes: 20,
             profileName: 'crypto_fallback',
             reasonSv: 'Crypto-standardprofil (fallback).' };
  }
  return { targetPct: TARGET_PCT, stopPct: STOP_PCT, maxHoldMinutes: MAX_HOLD_MINUTES,
           profileName: 'stocks_fallback',
           reasonSv: 'Aktie-standardprofil (fallback).' };
}

// ── Trade factories ───────────────────────────────────────────────────────────

function makeTradeId() {
  return `pt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function buildOpenTrade(c, gateDecision = null) {
  const profile    = getPaperRiskProfile(c);
  const mpRisk     = getRiskProfile(c.symbol);
  const marketGrp  = gateDecision?.marketGroup || getMarketGroup(c.symbol) || c.marketGroup || 'UNKNOWN';
  const compass    = getMarketCompass();
  const compassBias = gateDecision?.compassBias || compass?.bias || 'UNKNOWN';
  // Record compass hint: does it agree with trade direction?
  const compassConflict =
    compass && (
      (c.nextMoveBias === 'UP'   && compass.riskOff) ||
      (c.nextMoveBias === 'DOWN' && compass.riskOn)
    );
  const openedAt = new Date().toISOString();

  const trade = {
    tradeId:          makeTradeId(),
    signalId:         c.signalId || null,
    symbol:           c.symbol,
    marketType:       c.marketType || c.market || 'unknown',
    marketGroup:      marketGrp,
    riskProfileName:  profile.profileName,
    paperOnly:        mpRisk?.paperOnly ?? false,
    session:          mpRisk?.session ?? null,
    direction:        c.nextMoveBias,
    entryTime:        openedAt,
    opened_at:        openedAt,
    closed_at:        null,
    last_update_at:   openedAt,
    duration_seconds: 0,
    duration_label:   '0s',
    entryPrice:       c.price,
    entryReasonSv:    c.decisionTextSv || '–',
    signalFamily:     c.signalFamily,
    signalSubtype:    c.signalSubtype,
    familyLabelSv:    c.familyLabelSv  || c.signalFamily,
    subtypeLabelSv:   c.subtypeLabelSv || c.signalSubtype,
    statusAtEntry:    c.status,
    confidenceScore:  c.confidenceScore ?? null,
    baseConfidenceScore: c.baseConfidenceScore ?? c.confidenceScore ?? null,
    aiConfidenceAdjustment: c.aiConfidenceAdjustment ?? null,
    aiRiskFlag:      c.aiRiskFlag === true,
    aiAgentAnalysis: c.aiAgentAnalysis || null,
    riskEvaluation:  safeEventValue(c.riskEvaluation || null),
    executionSafety: safeEventValue(c.executionSafety || null),
    riskPositionSizeSek: c.riskEvaluation?.position_size_sek ?? null,
    riskPositionUnits: c.riskEvaluation?.position_size_units ?? null,
    riskMaxLossSek: c.riskEvaluation?.max_loss_sek ?? null,
    riskBlockReasons: c.riskEvaluation?.block_reasons || [],
    riskWarnings: c.riskEvaluation?.warnings || [],
    nextMoveBias:     c.nextMoveBias,
    volumeState:      c.volumeState     || 'unknown',
    extensionLevel:   c.extensionLevel  || 'none',
    dataFreshness:    c.dataFreshness,
    targetPct:        profile.targetPct,
    stopPct:          profile.stopPct,
    maxHoldMinutes:   profile.maxHoldMinutes,
    paperRiskProfile:        profile,
    paperRulesVersion:       PAPER_RULE_VERSION,
    ruleVersion:             PAPER_RULE_VERSION,
    compassBias,
    compassConflict:         compassConflict || false,
    volumeGateDecision:      gateDecision?.volumeGateDecision || null,
    observeOnlyReasonSv:     gateDecision?.observeOnlyReasonSv || null,
    // gate decision stored for analysis
    gateScore:               gateDecision?.gateScore    ?? null,
    gateThreshold:           gateDecision?.threshold    ?? null,
    gateMode:                gateDecision?.mode         ?? null,
    gateDecision:            gateDecision               ?? null,
    // intrabar tracking — updated every tick while trade is open
    maxFavorablePct:         null,
    maxAdversePct:           null,
    firstTargetTouchAt:      null,
    firstStopTouchAt:        null,
    highestPriceDuringTrade: null,
    lowestPriceDuringTrade:  null,
    exitTime:                null,
    exitPrice:               null,
    exitReason:              null,
    pnlPct:                  null,
    result:                  'OPEN',
    mode:                    'paper',
  };
  return strategyRuntimeConnector.enrichPaperTradeWithStrategy(trade);
}

// Direction-adjusted P&L: positive = profitable regardless of direction
function calcPnlPct(trade, currentPrice) {
  const raw = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
  return trade.direction === 'UP' ? raw : -raw;
}

function checkExit(trade, currentPrice) {
  if (!currentPrice || !trade.entryPrice) return null;
  const pnl    = calcPnlPct(trade, currentPrice);
  const target = trade.targetPct      ?? TARGET_PCT;
  const stop   = trade.stopPct        ?? STOP_PCT;
  const maxMin = trade.maxHoldMinutes ?? MAX_HOLD_MINUTES;

  if (pnl >= target)  return { exitReason: 'TARGET_HIT', pnlPct: pnl, result: 'WIN',  exitPrice: currentPrice };
  if (pnl <= -stop)   return { exitReason: 'STOP_HIT',   pnlPct: pnl, result: 'LOSS', exitPrice: currentPrice };
  if (trade.exitEngineStopPct != null && pnl <= Number(trade.exitEngineStopPct)) {
    return {
      exitReason: 'EXIT_ENGINE_TIGHTENED_STOP',
      exitReasonCode: 'tightened_stop',
      exitSource: 'exit_engine_v1',
      pnlPct: pnl,
      result: pnl >= 0 ? 'WIN' : 'LOSS',
      exitPrice: currentPrice,
    };
  }

  const ageMin = (Date.now() - new Date(trade.entryTime).getTime()) / 60_000;
  if (ageMin >= maxMin)
    return { exitReason: 'TIMEOUT', pnlPct: pnl, result: 'TIMEOUT', exitPrice: currentPrice };

  return null;
}

function checkHardExit(trade, currentPrice) {
  if (!currentPrice || !trade.entryPrice) return null;
  const pnl    = calcPnlPct(trade, currentPrice);
  const target = trade.targetPct ?? TARGET_PCT;
  const stop   = trade.stopPct   ?? STOP_PCT;
  if (pnl >= target)  return { exitReason: 'TARGET_HIT', pnlPct: pnl, result: 'WIN',  exitPrice: currentPrice };
  if (pnl <= -stop)   return { exitReason: 'STOP_HIT',   pnlPct: pnl, result: 'LOSS', exitPrice: currentPrice };
  if (trade.exitEngineStopPct != null && pnl <= Number(trade.exitEngineStopPct)) {
    return {
      exitReason: 'EXIT_ENGINE_TIGHTENED_STOP',
      exitReasonCode: 'tightened_stop',
      exitSource: 'exit_engine_v1',
      pnlPct: pnl,
      result: pnl >= 0 ? 'WIN' : 'LOSS',
      exitPrice: currentPrice,
    };
  }
  return null;
}

function checkTimeoutExit(trade, currentPrice) {
  if (!currentPrice || !trade.entryPrice) return null;
  const maxMin = trade.maxHoldMinutes ?? MAX_HOLD_MINUTES;
  const ageMin = (Date.now() - new Date(trade.entryTime).getTime()) / 60_000;
  if (ageMin < maxMin) return null;
  const pnl = calcPnlPct(trade, currentPrice);
  return { exitReason: 'TIMEOUT', pnlPct: pnl, result: 'TIMEOUT', exitPrice: currentPrice };
}

// ── Intrabar tracking ─────────────────────────────────────────────────────────

function updateIntrabar(trade, currentPrice) {
  if (!currentPrice || !trade.entryPrice) return;
  trade.last_update_at = new Date().toISOString();
  const pnl    = calcPnlPct(trade, currentPrice);
  const target = trade.targetPct ?? TARGET_PCT;
  const stop   = trade.stopPct   ?? STOP_PCT;

  if (trade.maxFavorablePct == null || pnl > trade.maxFavorablePct)
    trade.maxFavorablePct = Math.round(pnl * 10000) / 10000;
  if (trade.maxAdversePct == null || pnl < trade.maxAdversePct)
    trade.maxAdversePct = Math.round(pnl * 10000) / 10000;
  if (trade.highestPriceDuringTrade == null || currentPrice > trade.highestPriceDuringTrade)
    trade.highestPriceDuringTrade = currentPrice;
  if (trade.lowestPriceDuringTrade  == null || currentPrice < trade.lowestPriceDuringTrade)
    trade.lowestPriceDuringTrade  = currentPrice;
  if (!trade.firstTargetTouchAt && pnl >= target)
    trade.firstTargetTouchAt = new Date().toISOString();
  if (!trade.firstStopTouchAt && pnl <= -stop)
    trade.firstStopTouchAt = new Date().toISOString();
}

// ── Safety alert ──────────────────────────────────────────────────────────────

function checkAndApplySafetyAlert(state) {
  const v3Closed = loadClosedTrades().filter(t =>
    (t.paperRulesVersion === PAPER_RULE_VERSION || t.ruleVersion === PAPER_RULE_VERSION) && t.result !== 'OPEN'
  );
  if (v3Closed.length < 30) return;
  const timeouts     = v3Closed.filter(t => t.result === 'TIMEOUT').length;
  const timeoutRate  = (timeouts / v3Closed.length) * 100;
  const avgPnl       = v3Closed.reduce((s, t) => s + (t.pnlPct || 0), 0) / v3Closed.length;
  if (timeoutRate <= 70 && avgPnl >= 0) return;

  state.conservativeMode = true;
  const reason = timeoutRate > 70
    ? `timeout-rate ${timeoutRate.toFixed(0)}% (>70%)`
    : `avg PnL ${avgPnl.toFixed(4)}% (<0)`;
  appendEvent({
    type: 'SAFETY_ALERT', symbol: null, marketType: null, decision: 'info',
    reasonSv: `Säkerhetsvarning — v3-regler: ${reason}. Konservativt läge satt automatiskt.`,
    status: 'conservative', mode: 'paper',
  });
  console.log('[paper-trading] SAFETY ALERT — conservative mode triggered:', reason);
}

function openedReasonSv(c) {
  const subtype = String(c?.signalSubtype || '');
  if (subtype.includes('EMA_PULLBACK_UP')) return 'Test öppnad — EMA uppåt med godkänd volym.';
  if (subtype.includes('EMA_PULLBACK_DOWN')) return 'Test öppnad — EMA nedåt med godkänd volym.';
  if (subtype.includes('VWAP_RECLAIM_UP')) return 'Test öppnad — VWAP återtaget uppåt.';
  if (subtype.includes('VWAP_REJECTION_DOWN')) return 'Test öppnad — VWAP avvisades nedåt.';
  if (subtype.includes('BULL')) return 'Test öppnad — kompression kan bryta uppåt.';
  if (subtype.includes('BEAR')) return 'Test öppnad — kompression kan bryta nedåt.';
  return 'Test öppnad — signalen uppfyllde testreglerna.';
}

function closedReasonSv(exit) {
  if (exit?.result === 'WIN') return 'Stängd med plus.';
  if (exit?.result === 'LOSS') return 'Stängd med minus.';
  if (exit?.result === 'TIMEOUT') return 'Tiden tog slut.';
  return 'Testpositionen stängdes.';
}

function paperTradeOutcomeType(result) {
  if (result === 'WIN') return 'win';
  if (result === 'LOSS') return 'loss';
  if (result === 'TIMEOUT') return 'tie';
  return 'unknown';
}

async function saveClosedTradeMemory(closedTrade) {
  if (!closedTrade || closedTrade.result === 'OPEN') return null;
  const signalContext = {
    ...closedTrade,
    timestamp: closedTrade.entryTime,
    timeframe: '2m',
    direction: closedTrade.direction || closedTrade.nextMoveBias,
    state: closedTrade.state || closedTrade.narrowState || closedTrade.statusAtEntry,
    score: closedTrade.score ?? closedTrade.tradeScore ?? closedTrade.gateScore,
    confidence: closedTrade.confidenceScore,
    volume: {
      state: closedTrade.volumeState,
      relativeVolume: closedTrade.relativeVolume ?? closedTrade.rvol ?? null,
    },
    marketPersonality: closedTrade.marketPersonality || closedTrade.marketRegime || null,
    gatePassed: closedTrade.gateDecision?.allowed ?? true,
    source: 'paper_trading_auto_close',
  };
  const outcome = {
    source: 'paper_trading_auto_close',
    outcome_type: paperTradeOutcomeType(closedTrade.result),
    move_after_5m_pct: closedTrade.pnlPct,
    move_after_15m_pct: closedTrade.pnlPct,
    move_after_30m_pct: closedTrade.pnlPct,
    max_favorable_excursion_pct: closedTrade.maxFavorablePct ?? (closedTrade.pnlPct > 0 ? closedTrade.pnlPct : null),
    max_adverse_excursion_pct: closedTrade.maxAdversePct != null ? Math.abs(closedTrade.maxAdversePct) : (closedTrade.pnlPct < 0 ? Math.abs(closedTrade.pnlPct) : null),
    resolvedAt: closedTrade.exitTime,
    tradeId: closedTrade.tradeId,
    signalId: closedTrade.signalId,
  };
  return vectorMemoryService.saveSignalMemory(signalContext, outcome);
}

function decisionLabel(status) {
  if (status === 'wait') return 'Vänta';
  if (status === 'avoid') return 'Jaga inte';
  if (status === 'watch') return 'Bevaka';
  if (status === 'caution') return 'Obs';
  if (status === 'active') return 'Titta manuellt';
  return status || 'okänd';
}

function classifySkip(c, reason) {
  const hardText = (c?.hardBlockers || []).join(' ').toLowerCase();
  const raw = String(reason || '').toLowerCase();

  if (c?.marketClosed || c?.dataFreshness === 'MARKET_CLOSED' || raw.includes('market closed')) {
    return { type: 'MARKET_CLOSED', reasonSv: 'Skippad — marknaden är stängd.' };
  }
  if (raw.includes('datafreshness')) {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — data var inte färsk.' };
  }
  if (raw.startsWith('status=')) {
    return { type: 'TRADE_SKIPPED', reasonSv: `Skippad — status var ${decisionLabel(c?.status)}.` };
  }
  if (raw.includes('hardblockers')) {
    if (/2m|candle/.test(hardText)) return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — 2m sade emot.' };
    if (/volym|volume/.test(hardText)) return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — volymen var svag.' };
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — en hård blockerare fanns.' };
  }
  if (raw.includes('extensionlevel=extreme')) {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — rörelsen var för långt gången.' };
  }
  if (raw.includes('volumestate')) {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — volymen var svag.' };
  }
  if (raw.includes('twominuteconflict')) {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — 2m sade emot.' };
  }
  if (raw.includes('nextmovebias')) {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — riktningen var oklar.' };
  }
  if (raw.includes('ema paused')) {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — EMA pausad i paper test.' };
  }
  if (raw === 'crypto_ema_down_blocked') {
    return { type: 'TRADE_SKIPPED', reasonSv: 'EMA nedåt i crypto har varit svag i testet. Agenten väntar.' };
  }
  if (raw === 'crypto_normal_vol_vwap_only') {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — normal volym i crypto tillåter bara VWAP-signaler.' };
  }
  if (raw === 'crypto_ema_up_needs_strong') {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — EMA uppåt i crypto kräver stark volym.' };
  }
  if (raw === 'crypto_conf50_late_move') {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Rörelsen kan redan vara sen. Agenten väntar på starkare volym.' };
  }
  if (raw.includes('signalfamily') || raw.includes('subtype not allowed')) {
    return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — signaltypen är inte godkänd.' };
  }
  if (raw.includes('max open trades')) {
    return { type: 'MAX_TRADES_REACHED', reasonSv: 'Skippad — max antal öppna tester är redan nått.' };
  }
  if (raw.includes('already open')) {
    return { type: 'DUPLICATE_SIGNAL', reasonSv: 'Skippad — det finns redan en öppen testposition.' };
  }
  if (raw.includes('cooldown')) {
    return { type: 'COOLDOWN_ACTIVE', reasonSv: 'Skippad — symbolen är i paus efter senaste test.' };
  }
  if (raw.includes('duplicate signalid')) {
    return { type: 'DUPLICATE_SIGNAL', reasonSv: 'Skippad — samma signal har redan testats.' };
  }
  if (raw.includes('gate blockerad') || raw.includes('data inte färsk — signal') || raw.includes('ema nedåt i crypto') || raw.includes('normal volym i crypto') || raw.includes('ema uppåt i crypto')) {
    return { type: 'GATE_BLOCKED', reasonSv: reason || 'Skippad — market gate blockerade signalen.' };
  }

  return { type: 'TRADE_SKIPPED', reasonSv: 'Skippad — testreglerna godkände inte signalen.' };
}

function clampAgentConfidenceAdjustment(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-15, Math.min(10, Math.round(n)));
}

function buildAgentSignalContext(c, gateDecision = null, state = null) {
  return {
    symbol: c?.symbol || '',
    direction: c?.nextMoveBias || c?.direction || null,
    score: c?.priorityScore ?? c?.tradeScore ?? gateDecision?.gateScore ?? null,
    confidence: c?.confidenceScore ?? null,
    state: c?.state || c?.narrowState || c?.marketState || null,
    volume: {
      state: c?.volumeState || null,
      relativeVolume: c?.relativeVolume ?? null,
    },
    indicators: {
      signalFamily: c?.signalFamily || null,
      signalSubtype: c?.signalSubtype || null,
      agreementCount: c?.agreementCount ?? null,
      extensionLevel: c?.extensionLevel || null,
      tf2m: c?.tf2m || c?.timeframeAgreement?.tf2m || null,
    },
    gate: {
      status: c?.status || null,
      hardBlockers: c?.hardBlockers || [],
      softBlockers: c?.softBlockers || [],
      gateScore: gateDecision?.gateScore ?? null,
      threshold: gateDecision?.threshold ?? null,
      mode: gateDecision?.mode || null,
      allowed: gateDecision?.allowed ?? null,
      dataFreshness: c?.dataFreshness || null,
    },
    paper: {
      conservativeMode: state?.conservativeMode || false,
      maxOpenTrades: MAX_OPEN_TRADES,
      openTrades: state?.openTrades?.length ?? null,
    },
    marketPersonality: c?.marketPersonality || {},
    recentDecisions: _recentGateDecisions.slice(0, 10),
    marketType: c?.marketType || c?.market || null,
    status: c?.status || null,
    signalFamily: c?.signalFamily || null,
    signalSubtype: c?.signalSubtype || null,
    confidenceScore: c?.confidenceScore ?? null,
    volumeState: c?.volumeState || null,
    extensionLevel: c?.extensionLevel || null,
    dataFreshness: c?.dataFreshness || null,
    hardBlockers: c?.hardBlockers || [],
    softBlockers: c?.softBlockers || [],
    twoMinuteConflict: c?.twoMinuteConflict === true,
    marketClosed: c?.marketClosed === true,
  };
}

// ── Gate calibration cache ────────────────────────────────────────────────────
// Refreshed at most every 5 minutes to avoid disk reads every tick.

let _gateCalibCache    = null;
let _gateCalibCachedAt = 0;
const GATE_CALIB_TTL   = 5 * 60 * 1000;

function getGateCalibStats() {
  const now = Date.now();
  if (_gateCalibCache && (now - _gateCalibCachedAt) < GATE_CALIB_TTL) return _gateCalibCache;
  try {
    const allClosed = loadClosedTrades();
    const bySignalSubtype = {};
    for (const t of allClosed) {
      const k = t.signalSubtype || 'UNKNOWN';
      if (!bySignalSubtype[k]) bySignalSubtype[k] = { trades: 0, wins: 0, timeouts: 0, pnlSum: 0 };
      bySignalSubtype[k].trades++;
      if (t.result === 'WIN')     bySignalSubtype[k].wins++;
      if (t.result === 'TIMEOUT') bySignalSubtype[k].timeouts++;
      bySignalSubtype[k].pnlSum += (t.pnlPct || 0);
    }
    for (const v of Object.values(bySignalSubtype)) {
      v.timeoutRate = v.trades ? Math.round((v.timeouts / v.trades) * 100) : 0;
      v.avgPnlPct   = v.trades ? Math.round((v.pnlSum / v.trades) * 10000) / 10000 : 0;
    }
    _gateCalibCache    = { bySignalSubtype };
    _gateCalibCachedAt = now;
  } catch { _gateCalibCache = { bySignalSubtype: {} }; }
  return _gateCalibCache;
}

// In-memory rolling buffer for recent gate decisions (last 50)
let _recentGateDecisions = [];

function recordGateDecision(gd) {
  _recentGateDecisions = [gd, ..._recentGateDecisions].slice(0, 50);
  void redisService.setJson('gate:recent-decisions', _recentGateDecisions, 300);
  void redisService.setJson('gate:status', {
    ok: true,
    updatedAt: new Date().toISOString(),
    recentDecisions: _recentGateDecisions.slice(0, 20),
  }, 300);
}

function gateDecisionCode(decision) {
  const text = String(
    decision?.decisionCode ||
    decision?.reasonCode ||
    decision?.code ||
    decision?.observeOnlyReasonSv ||
    decision?.reasons?.[0] ||
    decision?.penalties?.[0] ||
    decision?.warnings?.[0] ||
    ''
  ).toLowerCase();

  if (!text) return decision?.allowed ? 'allowed' : 'blocked';
  if (/data inte f.rsk|datafreshness|fresh/.test(text)) return 'stale_stock_data';
  if (/marknadsgrupp saknas|unknown marketgroup/.test(text)) return 'unknown_market_group_observe_only';
  if (/marknaden .r st.ngd|market closed|session/.test(text)) return 'outside_nyse_session';
  if (/blandad marknad och inte stark volym/.test(text)) return 'mixed_compass_not_strong_volume';
  if (/crypto vwap med normal volym/.test(text)) return 'crypto_vwap_normal_observe_only';
  if (/crypto vwap med svag volym|svag volym i crypto/.test(text)) return 'crypto_vwap_weak_volume_blocked';
  if (/ema i crypto .r pausad/.test(text)) return 'crypto_ema_observe_only';
  if (/ema ned.t.*crypto|crypto_ema_down/.test(text)) return 'crypto_ema_down_blocked';
  if (/normal volym.*crypto|vwap-signaler|normal_vol/.test(text)) return 'crypto_normal_vol_vwap_only';
  if (/ema upp.t.*stark volym|ema_up.*strong/.test(text)) return 'crypto_ema_up_requires_strong_volume';
  if (/blandad marknadsbild|mixed/.test(text)) return 'mixed_compass_low_score';
  if (/risk-off|risk-on|kompass|compass/.test(text)) return 'compass_conflict';
  if (/po.ng|score|tr.skel|threshold/.test(text)) return 'low_gate_score';

  return text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .slice(0, 80) || (decision?.allowed ? 'allowed' : 'blocked');
}

function persistedGateMode(decision) {
  if (decision?.mode === 'observe_only') return 'observe_only';
  if (decision?.allowed === false || decision?.mode === 'blocked') return 'block';
  return 'allow';
}

function normalizeGateDecisionForDisk(decision, candidate = null, timestamp = new Date().toISOString()) {
  const marketGroup = decision?.marketGroup || getMarketGroup(candidate?.symbol) || candidate?.marketGroup || 'UNKNOWN';
  const profile = candidate?.symbol ? getRiskProfile(candidate.symbol) : null;
  const riskProfileName = decision?.riskProfileName ||
    (profile ? `${profile.groupName.toLowerCase()}_default` : null) ||
    candidate?.riskProfileName ||
    'UNKNOWN';
  const reasonSv = decision?.observeOnlyReasonSv ||
    decision?.reasons?.[0] ||
    decision?.penalties?.[0] ||
    decision?.warnings?.[0] ||
    decision?.boosts?.[0] ||
    null;
  const compass = getMarketCompass();

  return {
    ruleVersion: decision?.ruleVersion || PAPER_RULE_VERSION,
    timestamp,
    symbol: candidate?.symbol || decision?.signal?.symbol || null,
    marketGroup,
    riskProfileName,
    signalSubtype: candidate?.signalSubtype || decision?.signal?.signalSubtype || null,
    mode: persistedGateMode(decision),
    allowed: decision?.allowed === true,
    gateScore: decision?.gateScore ?? null,
    allowThreshold: decision?.threshold ?? null,
    observeOnlyThreshold: THRESHOLD_OBSERVE_ONLY,
    volumeGateDecision: decision?.volumeGateDecision || persistedGateMode(decision),
    observeOnlyReasonSv: decision?.observeOnlyReasonSv || null,
    decisionCode: gateDecisionCode(decision),
    reasonSv,
    warnings: Array.isArray(decision?.warnings) ? decision.warnings : [],
    penalties: Array.isArray(decision?.penalties) ? decision.penalties : [],
    boosts: Array.isArray(decision?.boosts) ? decision.boosts : [],
    compassBias: decision?.compassBias || compass?.bias || null,
    compassConflict: decision?.compassConflict === true,
    paperOnly: profile?.paperOnly ?? candidate?.paperOnly ?? false,
    session: profile?.session || candidate?.session || null,
    dataFreshness: candidate?.dataFreshness || null,
    volumeState: candidate?.volumeState || decision?.signal?.volumeState || null,
  };
}

function appendGateDecision(decision, candidate = null, options = {}) {
  const file = options.file || GATE_DECISIONS_FILE;
  const row = normalizeGateDecisionForDisk(decision, candidate, options.timestamp || new Date().toISOString());
  try {
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    console.warn('[paper-trading] gate decision persist failed:', err.message);
  }
  return row;
}

function loadGateDecisionHistory(options = {}) {
  const file = options.file || GATE_DECISIONS_FILE;
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : null;
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  ensureDir();
  if (!fs.existsSync(file)) return [];

  const rows = fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .filter(row => {
      if (!Number.isFinite(sinceMs)) return true;
      const ts = new Date(row.timestamp || 0).getTime();
      return Number.isFinite(ts) && ts >= sinceMs;
    });

  const latest = limit ? rows.slice(-limit) : rows;
  return latest.reverse();
}

// ── Decision Pipeline Metrics (v1.1) ──────────────────────────────────────────
// Daily counters reset at midnight. Rolling arrays hold timestamps (ms) for
// the past 60 minutes and are pruned on every access.

const ROLLING_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

let _pipelineDay = ''; // YYYY-MM-DD — triggers daily reset when date changes

let _daily = {
  scannerCandidates:     0,
  qualifiesChecked:      0,
  qualifiesPassed:       0,
  qualifiesRejected:     0,
  gateEvaluated:         0,
  gateAllowed:           0,
  gateBlocked:           0,
  gateObserveOnly:       0,
  tradesOpened:          0,
};

// Rolling timestamp arrays — one entry per event
let _roll = {
  candidates:    [],
  qualPassed:    [],
  gateEvaluated: [],
  gateAllowed:   [],
  gateBlocked:   [],
  gateObserveOnly: [],
  opened:        [],
};

// Lightweight rejection events buffer (last 100)
let _recentRejections = [];

function _maybeResetDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (_pipelineDay !== today) {
    _pipelineDay = today;
    _daily = { scannerCandidates: 0, qualifiesChecked: 0, qualifiesPassed: 0,
               qualifiesRejected: 0, gateEvaluated: 0, gateAllowed: 0,
               gateBlocked: 0, gateObserveOnly: 0, tradesOpened: 0 };
  }
}

function _trimRolling() {
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  for (const key of Object.keys(_roll)) {
    _roll[key] = _roll[key].filter(t => t > cutoff);
  }
}

function _bump(dailyKey, rollKey) {
  _maybeResetDay();
  _daily[dailyKey]++;
  if (rollKey) _roll[rollKey].push(Date.now());
}

function _getRollingCounts() {
  _trimRolling();
  return {
    candidatesLast60m:    _roll.candidates.length,
    qualifiesPassedLast60m: _roll.qualPassed.length,
    gateEvaluatedLast60m: _roll.gateEvaluated.length,
    gateAllowedLast60m:   _roll.gateAllowed.length,
    gateBlockedLast60m:   _roll.gateBlocked.length,
    gateObserveOnlyLast60m: _roll.gateObserveOnly.length,
    tradesOpenedLast60m:  _roll.opened.length,
  };
}

function getPipelineSnapshot() {
  _maybeResetDay();
  const roll = _getRollingCounts();
  const d = _daily;
  const qualifiesPassRate = d.qualifiesChecked
    ? Math.round((d.qualifiesPassed / d.qualifiesChecked) * 100) : null;
  const gateAllowRate = d.gateEvaluated
    ? Math.round((d.gateAllowed / d.gateEvaluated) * 100) : null;
  const tradeOpenRate = d.qualifiesChecked
    ? Math.round((d.tradesOpened / d.qualifiesChecked) * 100) : null;

  return {
    scannerCandidatesToday:     d.scannerCandidates,
    qualifiesCheckedToday:      d.qualifiesChecked,
    qualifiesPassedToday:       d.qualifiesPassed,
    qualifiesRejectedToday:     d.qualifiesRejected,
    marketGateEvaluatedToday:   d.gateEvaluated,
    marketGateAllowedToday:     d.gateAllowed,
    marketGateBlockedToday:     d.gateBlocked,
    marketGateObserveOnlyToday: d.gateObserveOnly,
    tradesOpenedToday:          d.tradesOpened,
    last60m: roll,
    conversionRates: {
      qualifiesPassRate,
      gateAllowRate,
      tradeOpenRate,
    },
  };
}

// ── Price snapshot ────────────────────────────────────────────────────────────

function getCurrentPrices() {
  const prices = {};
  try {
    for (const r of (getLatestResults() || []))  if (r.symbol && r.price) prices[r.symbol] = Number(r.price);
    for (const r of (getCryptoResults()  || []))  if (r.symbol && r.price) prices[r.symbol] = Number(r.price);
  } catch { /* schedulers not ready */ }
  return prices;
}

function getCurrentMarketRows() {
  const rows = {};
  try {
    for (const r of (getLatestResults() || [])) if (r.symbol) rows[r.symbol] = { ...r, marketType: r.marketType || r.market || 'stock' };
    for (const r of (getCryptoResults() || [])) if (r.symbol) rows[r.symbol] = { ...r, marketType: r.marketType || r.market || 'crypto' };
  } catch { /* schedulers not ready */ }
  return rows;
}

function normalizeExitVolume(value) {
  const v = String(value || '').toLowerCase();
  if (['strong', 'normal', 'weak'].includes(v)) return v;
  if (['low', 'very_low', 'thin'].includes(v)) return 'weak';
  return 'normal';
}

function inferMomentumStrength(trade, marketRow, pnl) {
  const explicit = String(marketRow?.momentum_strength || marketRow?.momentumStrength || '').toLowerCase();
  if (['strong', 'normal', 'fading'].includes(explicit)) return explicit;
  const maxFav = Number(trade.maxFavorablePct);
  if (Number.isFinite(maxFav) && maxFav > 0 && Number.isFinite(pnl) && maxFav - pnl >= 0.04) return 'fading';
  if (String(marketRow?.status || '').toLowerCase() === 'active' && normalizeExitVolume(marketRow?.volumeState || trade.volumeState) === 'strong') return 'strong';
  return 'normal';
}

function buildExitEngineInputs(trade, currentPrice, marketRow = {}) {
  const pnl = currentPrice ? calcPnlPct(trade, currentPrice) : 0;
  const compass = getMarketCompass();
  const calibration = getGateCalibStats()?.bySignalSubtype?.[trade.signalSubtype] || null;
  const openTrade = {
    id: trade.tradeId,
    symbol: trade.symbol,
    direction: trade.direction,
    entry_price: trade.entryPrice,
    current_price: currentPrice,
    target_pct: trade.targetPct,
    stop_loss_pct: trade.stopPct,
    opened_at: trade.entryTime,
    max_favorable_pct: trade.maxFavorablePct ?? pnl,
    max_adverse_pct: trade.maxAdversePct ?? 0,
    signal_type: trade.signalSubtype || trade.signalFamily,
    version: trade.paperRulesVersion || trade.ruleVersion,
    market_group: trade.marketGroup || getMarketGroup(trade.symbol) || 'UNKNOWN',
    exit_engine_stop_pct: trade.exitEngineStopPct,
    max_hold_minutes: trade.maxHoldMinutes,
    volumeState: trade.volumeState,
    signal_stats: calibration ? {
      timeout_rate: calibration.timeoutRate,
      win_rate: calibration.trades ? Math.round((calibration.wins / calibration.trades) * 100) : null,
      sample_size: calibration.trades,
    } : null,
  };
  const marketState = {
    price: currentPrice,
    current_pnl_pct: pnl,
    volume_strength: normalizeExitVolume(marketRow.volumeStrength || marketRow.volumeState || trade.volumeState),
    momentum_strength: inferMomentumStrength(trade, marketRow, pnl),
    state: String(marketRow.state || trade.statusAtEntry || '').toLowerCase(),
    spread_pct: marketRow.spread_pct ?? marketRow.spreadPct ?? null,
    volatility_score: marketRow.volatility_score ?? marketRow.volatilityScore ?? null,
    market_compass: compass?.bias || trade.compassBias || 'UNKNOWN',
    seconds_since_update: marketRow.lastUpdate ? Math.max(0, Math.round((Date.now() - new Date(marketRow.lastUpdate).getTime()) / 1000)) : null,
    age_minutes: trade.entryTime ? (Date.now() - new Date(trade.entryTime).getTime()) / 60000 : null,
  };
  return { openTrade, marketState };
}

function exitEngineClosedReasonSv(decision) {
  if (decision?.exit_reason_code === 'near_target_profit') return 'Exitmotor — tog vinst nära target.';
  if (decision?.exit_reason_code === 'near_target_pullback') return 'Exitmotor — target var nära men priset föll tillbaka.';
  if (decision?.exit_reason_code === 'trailing_stop') return 'Exitmotor — trailing stop träffad.';
  if (decision?.exit_reason_code === 'momentum_fade') return 'Exitmotor — momentum fadeade.';
  if (decision?.exit_reason_code === 'timeout_intelligence') return 'Exitmotor — stängde före timeout.';
  if (decision?.exit_reason_code === 'break_even') return 'Exitmotor — break-even skydd.';
  return 'Exitmotor — stängde testpositionen.';
}

function exitFromExitEngineDecision(trade, currentPrice, decision) {
  if (!['EXIT', 'TAKE_PROFIT'].includes(decision?.action)) return null;
  const pnl = calcPnlPct(trade, currentPrice);
  return {
    exitReason: `EXIT_ENGINE_${String(decision.exit_reason_code || 'exit').toUpperCase()}`,
    exitReasonCode: decision.exit_reason_code || 'exit_engine',
    exitSource: 'exit_engine_v1',
    exitEngineDecision: decision,
    pnlPct: pnl,
    result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'TIMEOUT',
    exitPrice: currentPrice,
  };
}

function buildPaperLiveState(state = loadState(), source = 'memory') {
  const prices = getCurrentPrices();
  const openTrades = (state.openTrades || []).map((t) => {
    const cur = prices[t.symbol];
    const pnl = cur ? calcPnlPct(t, cur) : null;
    const ageMin = t.entryTime ? (Date.now() - new Date(t.entryTime).getTime()) / 60_000 : null;
    return {
      ...t,
      currentPrice: cur ?? null,
      unrealizedPct: pnl != null ? Math.round(pnl * 100) / 100 : null,
      ageMin: ageMin != null ? Math.round(ageMin) : null,
    };
  });
  return {
    ok: true,
    mode: 'paper',
    source,
    updatedAt: new Date().toISOString(),
    enabled: state.enabled,
    openTrades,
    openCount: openTrades.length,
    cooldowns: state.cooldowns || {},
    recentDecisions: recentEvents.slice(0, 20),
    gate: {
      ruleVersion: PAPER_RULE_VERSION,
      recentDecisions: _recentGateDecisions.slice(0, 20),
      pipeline: getPipelineSnapshot(),
    },
    latestAgentAnalysis,
  };
}

function cachePaperState(state, source) {
  const snapshot = buildPaperLiveState(state, source);
  void redisService.setJson('paper:live-state', snapshot, 120);
  void redisService.setJson('paper:active-positions', snapshot.openTrades, 120);
  void redisService.setJson('signal:cooldowns', snapshot.cooldowns, 300);
}

function buildRiskAccountState(state) {
  const today = new Date().toISOString().slice(0, 10);
  const closed = loadClosedTrades()
    .filter((t) => t.result !== 'OPEN')
    .sort((a, b) => new Date(a.exitTime || a.entryTime || 0) - new Date(b.exitTime || b.entryTime || 0));
  const todayClosed = closed.filter((t) => String(t.exitTime || t.entryTime || '').startsWith(today));
  const todayEvents = loadJsonl(EVENTS_FILE).filter((e) => String(e.timestamp || '').startsWith(today));
  const dailyTrades = todayEvents.filter((e) => e.type === 'TRADE_OPENED').length;
  const dailyPnlPct = todayClosed.reduce((sum, t) => sum + (Number(t.pnlPct) || 0), 0);

  let consecutiveLosses = 0;
  let lastLossAt = null;
  for (const trade of [...closed].reverse()) {
    if (trade.result === 'LOSS') {
      consecutiveLosses += 1;
      if (!lastLossAt) lastLossAt = trade.exitTime || trade.entryTime || null;
      continue;
    }
    if (trade.result === 'WIN') break;
  }

  return {
    balance: riskEngineService.DEFAULT_RISK_CONFIG.account_balance,
    equity: riskEngineService.DEFAULT_RISK_CONFIG.account_balance,
    daily_pnl_pct: Math.round(dailyPnlPct * 10000) / 10000,
    daily_trades: dailyTrades,
    consecutive_losses: consecutiveLosses,
    open_positions: state.openTrades || [],
    last_loss_at: lastLossAt,
  };
}

function buildRiskSignalContext(c, gateDecision, agentAnalysis, riskProfile) {
  const memorySummary = agentAnalysis?.memory_summary || null;
  return {
    ...c,
    evaluation_source: 'paper_pipeline',
    symbol: c.symbol,
    direction: c.nextMoveBias || c.direction,
    score: c.priorityScore ?? c.tradeScore ?? gateDecision?.gateScore ?? c.confidenceScore,
    confidence: c.confidenceScore,
    price: c.price,
    stop_loss_pct: riskProfile?.stopPct ?? c.stop_loss_pct ?? c.stopPct,
    target_pct: riskProfile?.targetPct ?? c.target_pct ?? c.targetPct,
    spread_pct: c.spread_pct ?? c.spreadPct ?? null,
    liquidity_score: c.liquidity_score ?? c.liquidityScore ?? null,
    volatility_score: c.volatility_score ?? c.volatilityScore ?? null,
    agent: agentAnalysis || {},
    memory: memorySummary || {},
    gate: gateDecision || {},
  };
}

function candidateTime(c, fallback = new Date().toISOString()) {
  return c?.lastUpdate || c?.last_updated || c?.timestamp || c?.candleTs || c?.candle_ts || c?.updatedAt || fallback;
}

function providerStatusForCandidate(c) {
  const freshness = String(c?.dataFreshness || '').toUpperCase();
  if (freshness === 'LIVE') return 'ok';
  if (freshness === 'STALE') return 'degraded';
  if (freshness === 'MISSING' || freshness === 'ERROR') return 'down';
  return 'ok';
}

async function buildExecutionSafetyContext(c, gateDecision, riskEvaluation, riskProfile) {
  const redis = redisService.status();
  const compass = getMarketCompass();
  const memory = process.memoryUsage ? process.memoryUsage() : {};
  let feedStatus = null;
  try { feedStatus = getStockFeedStatus?.(); } catch (_) {}
  const rowTime = candidateTime(c);
  const group = getMarketGroup(c?.symbol) || c?.marketGroup || 'UNKNOWN';

  return {
    symbol: c?.symbol,
    direction: c?.nextMoveBias || c?.direction,
    tradeIntent: 'ENTER',
    source: 'paper_pipeline',
    replay_mode: false,
    market: {
      is_open: c?.marketClosed === true ? false : feedStatus?.status === 'MARKET_CLOSED' && String(c?.marketType || c?.market || '').toLowerCase() !== 'crypto' ? false : true,
      market_group: group,
      session: String(c?.marketType || c?.market || '').toLowerCase() === 'crypto' ? 'crypto_24_7' : 'market_hours',
      compass: compass?.bias || gateDecision?.compassBias || null,
    },
    data: {
      last_price_at: rowTime,
      last_candle_at: c?.candleTs || c?.latest2mTimestamp || rowTime,
      last_scan_at: rowTime,
      provider_status: providerStatusForCandidate(c),
    },
    system: {
      redis_status: redis.redisAvailable ? 'ok' : redis.mode === 'fallback' ? 'fallback' : 'down',
      memory_mb: memory.rss ? Math.round(memory.rss / 1024 / 1024) : null,
      pm2_restarts_1h: 0,
      api_errors_5m: 0,
      notification_status: 'ok',
      overall_status: 'OK',
    },
    risk: {
      allowed: riskEvaluation?.allowed === true,
      pause_trading: riskEvaluation?.pause_trading === true,
    },
    exit: {
      ready: true,
    },
    gate: {
      allowed: gateDecision?.allowed === true,
      mode: gateDecision?.mode || null,
    },
    risk_profile: riskProfile?.name || c?.paperRiskProfile || null,
  };
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function runTick() {
  const state = loadState();
  if (!state.enabled) return;

  let changed = false;
  const now    = new Date().toISOString();
  const prices = getCurrentPrices();
  const marketRows = getCurrentMarketRows();

  // 1. Check open trades for exits
  const stillOpen = [];
  for (const trade of state.openTrades) {
    const currentPrice = prices[trade.symbol];
    if (!currentPrice) {
      appendEvent({
        type: 'PRICE_MISSING',
        symbol: trade.symbol,
        marketType: trade.marketType,
        decision: 'info',
        reasonSv: 'Pris saknas — kan inte uppdatera testpositionen.',
        signalFamily: trade.signalFamily,
        signalSubtype: trade.signalSubtype,
        status: trade.statusAtEntry,
        nextMoveBias: trade.nextMoveBias,
        dataFreshness: trade.dataFreshness,
        mode: 'paper',
      });
    } else {
      updateIntrabar(trade, currentPrice);
      changed = true;
    }
    let exit = checkHardExit(trade, currentPrice);
    if (!exit && currentPrice) {
      try {
        const { openTrade, marketState } = buildExitEngineInputs(trade, currentPrice, marketRows[trade.symbol]);
        const exitDecision = await exitEngineService.evaluateExit(openTrade, marketState);
        if (exitDecision.action === 'TIGHTEN_STOP' && exitDecision.new_stop_loss_pct != null) {
          const prevStop = Number(trade.exitEngineStopPct ?? -Infinity);
          const nextStop = Number(exitDecision.new_stop_loss_pct);
          if (Number.isFinite(nextStop) && nextStop > prevStop) {
            trade.exitEngineStopPct = nextStop;
            trade.exitEngineLastDecision = exitDecision;
            appendEvent({
              type: 'EXIT_ENGINE_TIGHTEN_STOP',
              symbol: trade.symbol,
              marketType: trade.marketType,
              decision: 'tightened',
              reasonSv: `Exitmotor — tajtade stop till ${nextStop.toFixed(4)}%.`,
              signalFamily: trade.signalFamily,
              signalSubtype: trade.signalSubtype,
              status: 'TIGHTEN_STOP',
              nextMoveBias: trade.nextMoveBias,
              dataFreshness: trade.dataFreshness,
              exitReasonCode: exitDecision.exit_reason_code,
              exitEngineDecision: exitDecision,
              mode: 'paper',
            });
            changed = true;
          }
        } else {
          exit = exitFromExitEngineDecision(trade, currentPrice, exitDecision);
        }
        if (exit) {
          void notificationEngineV2.processExitEngineDecision(exit.exitEngineDecision || exitDecision).catch((err) => {
            console.warn('[paper-trading] exit notification v2 failed:', err.message);
          });
        }
      } catch (err) {
        console.warn(`[paper-trading] exit engine fallback for ${trade.symbol}:`, err.message);
      }
    }
    if (!exit) exit = checkTimeoutExit(trade, currentPrice);
    if (exit) {
      const closed = enrichTradeTimestamps({ ...trade, exitTime: now, closed_at: now, last_update_at: now, ...exit }, now);
      appendTrade(closed);
      void saveClosedTradeMemory(closed).catch((err) => {
        console.warn(`[paper-trading] memory save failed for ${closed.symbol}:`, err.message);
      });
      appendEvent({
        type: 'TRADE_CLOSED',
        symbol: trade.symbol,
        marketType: trade.marketType,
        decision: 'closed',
        reasonSv: exit.exitSource === 'exit_engine_v1' ? exitEngineClosedReasonSv(exit.exitEngineDecision || exit) : closedReasonSv(exit),
        signalFamily: trade.signalFamily,
        signalSubtype: trade.signalSubtype,
        status: exit.result,
        nextMoveBias: trade.nextMoveBias,
        dataFreshness: trade.dataFreshness,
        exitReasonCode: exit.exitReasonCode || null,
        exitSource: exit.exitSource || null,
        exitEngineDecision: exit.exitEngineDecision || null,
        mode: 'paper',
      });
      state.cooldowns[trade.symbol] = now;
      console.log(`[paper-trading] CLOSE ${trade.symbol} ${exit.result} ${exit.pnlPct?.toFixed(2)}% @ ${exit.exitPrice}`);
      changed = true;
      if (!state.conservativeMode) checkAndApplySafetyAlert(state);
    } else {
      stillOpen.push(trade);
    }
  }
  state.openTrades = stillOpen;

  // 2. Evaluate new entry candidates
  if (state.openTrades.length < MAX_OPEN_TRADES) {
    let candidates = [];
    try {
      const stockFeedStatus = (typeof getStockFeedStatus === 'function' ? getStockFeedStatus() : null);
      if (stockFeedStatus?.status === 'MARKET_CLOSED') {
        appendEvent({
          type: 'MARKET_CLOSED',
          symbol: null,
          marketType: 'stocks',
          decision: 'info',
          reasonSv: 'Marknaden är stängd — senaste handelspass används.',
          dataFreshness: 'MARKET_CLOSED',
          mode: 'paper',
        });
      }
      const dm = buildDecisionMonitor({
        stockResults:  getLatestResults()  || [],
        cryptoResults: getCryptoResults()  || [],
        stockFeedStatus,
      });
      candidates = dm.candidates || [];
    } catch (err) {
      appendEvent({
        type: 'CANDIDATE_ERROR',
        symbol: null,
        marketType: null,
        decision: 'skipped',
        reasonSv: 'Skippad — kandidaterna kunde inte läsas.',
        status: 'error',
        mode: 'paper',
      });
      console.warn('[paper-trading] buildDecisionMonitor error:', err.message);
    }

    // Count all scanner candidates before loop filters
    for (const c of candidates) _bump('scannerCandidates', 'candidates');

    for (const c of candidates) {
      if (state.openTrades.length >= MAX_OPEN_TRADES) {
        appendEvent(eventFromCandidate('MAX_TRADES_REACHED', c, 'Skippad — max antal öppna tester är redan nått.'));
        break;
      }
      try {
        _bump('qualifiesChecked', null);
        const check = qualifiesForEntry(c, state);
        if (!check.ok) {
          _bump('qualifiesRejected', null);
          // Lightweight rejection entry for pipeline analysis
          _recentRejections = [{
            type:          'QUALIFIES_REJECTED',
            symbol:        c.symbol,
            marketGroup:   getMarketGroup(c.symbol) || c.marketGroup || 'UNKNOWN',
            signalSubtype: c.signalSubtype || null,
            reason:        check.reason,
            timestamp:     new Date().toISOString(),
          }, ..._recentRejections].slice(0, 100);
          const skip = classifySkip(c, check.reason);
          appendEvent(eventFromCandidate(skip.type, c, skip.reasonSv));
          continue;
        }
        _bump('qualifiesPassed', 'qualPassed');

        // Market Gate v3 — evaluated after qualifiesForEntry passes
        _bump('gateEvaluated', 'gateEvaluated');
        const gateContext  = { conservativeMode: state.conservativeMode || false, calibrationStats: getGateCalibStats() };
        const gateDecision = evaluateMarketGate(c, gateContext);
        const gateDecisionTs = new Date().toISOString();
        const persistedGateDecision = appendGateDecision(gateDecision, c, { timestamp: gateDecisionTs });
        recordGateDecision({
          ...gateDecision,
          timestamp: gateDecisionTs,
          decisionCode: persistedGateDecision.decisionCode,
          reasonSv: persistedGateDecision.reasonSv,
          marketGroup: persistedGateDecision.marketGroup,
          riskProfileName: persistedGateDecision.riskProfileName,
          signalSubtype: persistedGateDecision.signalSubtype,
          compassBias: persistedGateDecision.compassBias,
          volumeGateDecision: persistedGateDecision.volumeGateDecision,
          observeOnlyReasonSv: persistedGateDecision.observeOnlyReasonSv,
          ruleVersion: persistedGateDecision.ruleVersion,
        });

        if (gateDecision.mode === 'observe_only') {
          _bump('gateObserveOnly', 'gateObserveOnly');
          const observeReasonSv = gateDecision.observeOnlyReasonSv
            || gateDecision.warnings?.[0]
            || 'Agenten observerar bara.';
          appendEvent(eventFromCandidate('GATE_OBSERVE_ONLY', c, observeReasonSv, 'observe_only'));
          continue;
        }

        if (!gateDecision.allowed) {
          _bump('gateBlocked', 'gateBlocked');
          const gateReasonSv = gateDecision.reasons[0]
            || `Gate blockerad (poäng ${gateDecision.gateScore}/${gateDecision.threshold}).`;
          appendEvent({
            ...eventFromCandidate('GATE_BLOCKED', c, gateReasonSv),
            gateScore:     gateDecision.gateScore,
            gateThreshold: gateDecision.threshold,
            gateMode:      gateDecision.mode,
          });
          continue;
        }
        _bump('gateAllowed', 'gateAllowed');

        let agentAnalysis = null;
        let aiAdjustment = 0;
        try {
          agentAnalysis = await agentReasoningService.analyzeSignal(buildAgentSignalContext(c, gateDecision, state));
          latestAgentAnalysis = agentAnalysis;
          aiAdjustment = clampAgentConfidenceAdjustment(agentAnalysis.confidence_adjustment);
        } catch (err) {
          console.warn(`[paper-trading] agent fallback används för ${c?.symbol}:`, err.message);
        }

        const adjustedConfidence = Math.max(0, Math.min(100,
          Math.round(Number(c.confidenceScore || 0) + aiAdjustment),
        ));
        const candidateWithAgent = {
          ...c,
          baseConfidenceScore: c.confidenceScore ?? null,
          confidenceScore: adjustedConfidence,
          aiConfidenceAdjustment: aiAdjustment,
          aiRiskFlag: agentAnalysis
            ? /risk|varning|block|utsträckt|konflikt|inte live/i.test(agentAnalysis.risk_notes || '')
            : false,
          aiAgentAnalysis: agentAnalysis,
        };

        const riskProfile = getPaperRiskProfile(candidateWithAgent);
        const riskConfig = await riskEngineService.getRiskConfig();
        const riskAccountState = {
          ...buildRiskAccountState(state),
          balance: riskConfig.account_balance,
          equity: riskConfig.account_balance,
          _riskConfig: riskConfig,
        };
        const riskEvaluation = await riskEngineService.evaluateTradeRisk(
          buildRiskSignalContext(candidateWithAgent, gateDecision, agentAnalysis, riskProfile),
          riskAccountState,
          { persist: true, evaluationSource: 'paper_pipeline' },
        );

        if (riskEvaluation.pause_trading) {
          appendEvent({
            ...eventFromCandidate('RISK_PAUSE_TRIGGERED', candidateWithAgent, `Systempaus — ${riskEvaluation.pause_reasons.join(', ') || 'riskgräns nådd'}.`, 'skipped'),
            aiConfidenceAdjustment: aiAdjustment,
            aiAgentAnalysis: agentAnalysis,
            riskEvaluation,
          });
          console.warn(`[paper-trading] risk pause active, inga nya entries: ${(riskEvaluation.pause_reasons || []).join(',')}`);
          break;
        }

        if (!riskEvaluation.allowed) {
          appendEvent({
            ...eventFromCandidate('RISK_BLOCKED', candidateWithAgent, `Riskmotor blockerade: ${riskEvaluation.block_reasons.join(', ')}.`, 'skipped'),
            aiConfidenceAdjustment: aiAdjustment,
            aiAgentAnalysis: agentAnalysis,
            riskEvaluation,
          });
          console.warn(`[paper-trading] risk block ${c.symbol}: ${riskEvaluation.block_reasons.join(',')}`);
          continue;
        }

        let executionSafety = null;
        try {
          executionSafety = await executionSafetyService.evaluateExecutionSafety(
            await buildExecutionSafetyContext(candidateWithAgent, gateDecision, riskEvaluation, riskProfile),
          );
        } catch (err) {
          const failClosed = {
            ok: true,
            allowed: false,
            safety_level: 'block',
            live_execution_allowed: false,
            paper_execution_allowed: false,
            block_reasons: ['system_health_bad'],
            paper_block_reasons: ['safety_error_fail_closed'],
            warnings: [`execution_safety_error:${err.message || String(err)}`],
            source: 'execution_safety_v1',
            timestamp: new Date().toISOString(),
          };
          appendEvent({
            ...eventFromCandidate('SAFETY_BLOCKED', candidateWithAgent, 'Säkerhetsmotor blockerade entry: safety_error_fail_closed.', 'skipped'),
            aiConfidenceAdjustment: aiAdjustment,
            aiAgentAnalysis: agentAnalysis,
            riskEvaluation,
            executionSafety: failClosed,
          });
          void notificationEngineV2.processExecutionSafetyEvent({
            type: 'safety_block',
            symbol: candidateWithAgent.symbol,
            block_reasons: ['safety_error_fail_closed'],
            safety_level: 'block',
            source: 'execution_safety_v1',
          }).catch((notifyErr) => {
            console.warn('[paper-trading] execution safety fail-closed notification failed:', notifyErr.message);
          });
          console.warn(`[paper-trading] execution safety fail-closed ${c.symbol}:`, err.message);
          continue;
        }

        if (executionSafety.paper_execution_allowed === false) {
          const reasons = executionSafety.paper_block_reasons?.length
            ? executionSafety.paper_block_reasons
            : executionSafety.block_reasons || [];
          appendEvent({
            ...eventFromCandidate('SAFETY_BLOCKED', candidateWithAgent, `Säkerhetsmotor blockerade entry: ${reasons.join(', ') || 'safety_block'}.`, 'skipped'),
            aiConfidenceAdjustment: aiAdjustment,
            aiAgentAnalysis: agentAnalysis,
            riskEvaluation,
            executionSafety,
          });
          void notificationEngineV2.processExecutionSafetyEvent({
            type: 'safety_block',
            symbol: candidateWithAgent.symbol,
            block_reasons: reasons,
            safety_level: executionSafety.safety_level,
            source: 'execution_safety_v1',
          }).catch((err) => {
            console.warn('[paper-trading] execution safety notification failed:', err.message);
          });
          console.warn(`[paper-trading] safety block ${c.symbol}: ${reasons.join(',')}`);
          continue;
        }

        candidateWithAgent.riskEvaluation = riskEvaluation;
        candidateWithAgent.executionSafety = executionSafety;
        const trade = buildOpenTrade(candidateWithAgent, gateDecision);
        _bump('tradesOpened', 'opened');
        state.openTrades.push(trade);
        if (c.signalId) state.seenSignalIds = [...state.seenSignalIds, c.signalId].slice(-200);
        appendEvent({
          ...eventFromCandidate('TRADE_OPENED', candidateWithAgent, openedReasonSv(candidateWithAgent), 'opened'),
          aiConfidenceAdjustment: aiAdjustment,
          riskEvaluation,
          executionSafety,
        });
        changed = true;
        console.log(`[paper-trading] OPEN ${c.symbol} ${trade.direction} ${c.signalFamily}/${c.signalSubtype} @ ${c.price}`);
      } catch (err) {
        appendEvent(eventFromCandidate('CANDIDATE_ERROR', c, 'Skippad — kandidaten kunde inte läsas.', 'skipped'));
        console.warn(`[paper-trading] candidate error (${c?.symbol}), skipping:`, err.message);
      }
    }
  } else {
    appendEvent({
      type: 'MAX_TRADES_REACHED',
      symbol: null,
      marketType: null,
      decision: 'skipped',
      reasonSv: 'Skippad — max antal öppna tester är redan nått.',
      status: 'full',
      mode: 'paper',
    });
  }

  // 3. Prune stale cooldowns
  const cutoff = Date.now() - (COOLDOWN_MINUTES * 2 * 60_000);
  for (const [sym, ts] of Object.entries(state.cooldowns)) {
    if (new Date(ts).getTime() < cutoff) { delete state.cooldowns[sym]; changed = true; }
  }

  if (changed) saveState(state);
}

// ── Ticker ────────────────────────────────────────────────────────────────────

let tickTimer = null;

function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    runTick().catch((err) => { console.error('[paper-trading] tick error:', err.message); });
  }, TICK_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

function initOnStartup() {
  ensureDir();
  ensureGateDecisionsFile();
  recentEvents = loadEvents(MEMORY_EVENTS);
  startTicker();
  const state = loadState();

  // Persist EMA filter start timestamp once, derived from first EMA-paused event
  if (!ALLOW_EMA_PAPER_TRADES && !state.emaFilterStartedAt) {
    const allEvents = loadJsonl(EVENTS_FILE);
    const firstPause = allEvents.find(e => e.reasonSv && e.reasonSv.includes('EMA pausad'));
    state.emaFilterStartedAt = firstPause?.timestamp || new Date().toISOString();
    saveState(state);
    console.log('[paper-trading] emaFilterStartedAt satt till', state.emaFilterStartedAt);
  }

  if (state.enabled) {
    appendEvent({
      type: 'AGENT_STARTED',
      symbol: null,
      marketType: null,
      decision: 'started',
      reasonSv: 'Testläge återupptaget efter restart.',
      status: 'enabled',
      mode: 'paper',
    });
    console.log('[paper-trading] Återupptaget efter restart. Persistent mode — enabled=true. Endast testläge, inga riktiga order.');
  }
}

function start() {
  const state = loadState();
  if (state.enabled) {
    appendEvent({
      type: 'AGENT_STARTED',
      symbol: null,
      marketType: null,
      decision: 'started',
      reasonSv: 'Testläge var redan på.',
      status: 'enabled',
      mode: 'paper',
    });
    return { ok: true, already: true, message: 'Testläge är redan aktivt.' };
  }
  state.enabled = true;
  saveState(state);
  appendEvent({
    type: 'AGENT_STARTED',
    symbol: null,
    marketType: null,
    decision: 'started',
    reasonSv: 'Testläge startat. Inga riktiga order läggs.',
    status: 'enabled',
    mode: 'paper',
  });
  console.log('[paper-trading] STARTED by API');
  return { ok: true, message: 'Testläge aktiverat. Inga riktiga order läggs.' };
}

function stop() {
  const state = loadState();
  state.enabled = false;
  saveState(state);
  appendEvent({
    type: 'AGENT_STOPPED',
    symbol: null,
    marketType: null,
    decision: 'stopped',
    reasonSv: 'Testläge stoppat av användaren.',
    status: 'disabled',
    mode: 'paper',
  });
  console.log('[paper-trading] STOPPED by API');
  return { ok: true, message: 'Testläge stoppat.' };
}

function getCompassStatus() {
  const compass = getMarketCompass();
  if (!compass) return { available: false };
  return { available: true, ...compass };
}

function getStatus() {
  const state  = loadState();
  const prices = getCurrentPrices();
  const openTrades = state.openTrades.map(t => {
    const cur = prices[t.symbol];
    const pnl = cur ? calcPnlPct(t, cur) : null;
    const ageMin = (Date.now() - new Date(t.entryTime).getTime()) / 60_000;
    return {
      ...t,
      currentPrice:   cur   ?? null,
      unrealizedPct:  pnl != null ? Math.round(pnl * 100) / 100 : null,
      ageMin:         Math.round(ageMin),
    };
  });
  return {
    ok:             true,
    mode:           'paper',
    enabled:        state.enabled,
    persistentMode: true,
    messageSv:      state.enabled
      ? 'Testläge är på tills du stoppar det. Inga riktiga order läggs.'
      : 'Testläge är av. Starta för att börja simulera.',
    openTrades,
    openCount:      openTrades.length,
    cooldowns:      state.cooldowns,
    filters: {
      ruleVersion:          PAPER_RULE_VERSION,
      allowEmaPaperTrades:  ALLOW_EMA_PAPER_TRADES,
      allowedFamilies:      Array.from(ALLOWED_FAMILIES),
      emaFilterStartedAt:   state.emaFilterStartedAt || null,
      cryptoRules: {
        blockedSubtypes:       [],
        observeOnlySubtypes:   ['EMA_PULLBACK_UP', 'EMA_PULLBACK_DOWN'],
        normalVolVwapObserveOnly: true,
        weakVolVwapBlocked:    true,
        mixedCompassNeedsStrongVolume: true,
        conf50SafetyFilter:    true,
        profilesActive:        ['crypto_major_vwap_strong_v3'],
      },
    },
    marketCompass: getCompassStatus(),
    marketGroups: Object.keys(MARKET_PROFILES).map(g => ({
      groupName: g,
      symbols:   MARKET_PROFILES[g].symbols,
      paperOnly: MARKET_PROFILES[g].paperOnly,
      risk:      MARKET_PROFILES[g].risk,
      session:   MARKET_PROFILES[g].session,
    })),
  };
}

function getLiveState() {
  return buildPaperLiveState(loadState(), 'memory');
}

function getLatestAgentAnalysis() {
  return latestAgentAnalysis;
}

function getTrades() {
  const state  = loadState();
  const closed = loadClosedTrades().map((trade) => enrichTradeTimestamps(trade));
  const open   = state.openTrades.map((trade) => enrichTradeTimestamps(trade));
  const all    = [...closed, ...open].sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));
  return { ok: true, trades: all, closedCount: closed.length, openCount: open.length };
}

function getPerformance() {
  const state  = loadState();
  const { trades } = getTrades();
  const closed = trades.filter(t => t.result !== 'OPEN');
  const open   = trades.filter(t => t.result === 'OPEN');

  const wins     = closed.filter(t => t.result === 'WIN').length;
  const losses   = closed.filter(t => t.result === 'LOSS').length;
  const timeouts = closed.filter(t => t.result === 'TIMEOUT').length;
  const winRate  = closed.length ? Math.round((wins / closed.length) * 100) : null;
  const avgPnlPct = closed.length
    ? Math.round((closed.reduce((s, t) => s + (t.pnlPct || 0), 0) / closed.length) * 100) / 100
    : null;

  function groupBy(arr, key) {
    return arr.reduce((acc, t) => {
      const k = t[key] || 'UNKNOWN';
      if (!acc[k]) acc[k] = { trades: 0, wins: 0, losses: 0, timeouts: 0, pnlSum: 0 };
      acc[k].trades++;
      if (t.result === 'WIN')     acc[k].wins++;
      if (t.result === 'LOSS')    acc[k].losses++;
      if (t.result === 'TIMEOUT') acc[k].timeouts++;
      acc[k].pnlSum = Math.round((acc[k].pnlSum + (t.pnlPct || 0)) * 100) / 100;
      return acc;
    }, {});
  }

  // After-EMA-filter statistics: trades entered after EMA was paused
  // Priority 1: state.emaFilterStartedAt
  // Priority 2: first "EMA pausad" event in events.jsonl
  let emaFilterStartedAt = state.emaFilterStartedAt || null;
  if (!ALLOW_EMA_PAPER_TRADES && !emaFilterStartedAt) {
    const allEvents = loadJsonl(EVENTS_FILE);
    const firstPause = allEvents.find(e => e.reasonSv && e.reasonSv.includes('EMA pausad'));
    if (firstPause?.timestamp) {
      emaFilterStartedAt = firstPause.timestamp;
      // Persist so future calls don't re-scan events.jsonl
      const s2 = loadState();
      if (!s2.emaFilterStartedAt) { s2.emaFilterStartedAt = emaFilterStartedAt; saveState(s2); }
    }
  }

  let afterFilter;
  if (!ALLOW_EMA_PAPER_TRADES) {
    if (!emaFilterStartedAt) {
      afterFilter = {
        enabled: true, filterName: 'EMA pausad', startedAt: null,
        totalTrades: 0, wins: 0, losses: 0, timeouts: 0,
        winRate: null, avgPnlPct: null,
        bySignalFamily: {}, bySignalSubtype: {},
        messageSv: 'Ingen efter-EMA-data ännu.',
      };
    } else {
      const af        = closed.filter(t => (t.entryTime || '') >= emaFilterStartedAt);
      const afWins    = af.filter(t => t.result === 'WIN').length;
      const afLosses  = af.filter(t => t.result === 'LOSS').length;
      const afTO      = af.filter(t => t.result === 'TIMEOUT').length;
      const afWinRate = af.length ? Math.round((afWins / af.length) * 100) : null;
      const afAvgPnl  = af.length
        ? Math.round((af.reduce((s, t) => s + (t.pnlPct || 0), 0) / af.length) * 100) / 100
        : null;
      afterFilter = {
        enabled: true, filterName: 'EMA pausad', startedAt: emaFilterStartedAt,
        totalTrades: af.length, wins: afWins, losses: afLosses, timeouts: afTO,
        winRate: afWinRate, avgPnlPct: afAvgPnl,
        bySignalFamily:  groupBy(af, 'signalFamily'),
        bySignalSubtype: groupBy(af, 'signalSubtype'),
        messageSv: af.length === 0 ? 'Väntar på nya VWAP/Narrow-tester.' : null,
      };
    }
  } else {
    afterFilter = { enabled: false, filterName: null, startedAt: null };
  }

  // bySession: group by session (NYSE vs 24_7)
  function bySession(arr) {
    return arr.reduce((acc, t) => {
      const k = t.session || (isCryptoMarketType(t.marketType) ? '24_7' : 'NYSE');
      if (!acc[k]) acc[k] = { trades: 0, wins: 0, losses: 0, timeouts: 0, pnlSum: 0 };
      acc[k].trades++;
      if (t.result === 'WIN')     acc[k].wins++;
      if (t.result === 'LOSS')    acc[k].losses++;
      if (t.result === 'TIMEOUT') acc[k].timeouts++;
      acc[k].pnlSum = Math.round((acc[k].pnlSum + (t.pnlPct || 0)) * 100) / 100;
      return acc;
    }, {});
  }

  // Compute winRate for each grouped entry
  function enrichGroup(grouped) {
    const out = {};
    for (const [k, v] of Object.entries(grouped)) {
      out[k] = {
        ...v,
        winRate: v.trades ? Math.round((v.wins / v.trades) * 100) : null,
        avgPnlPct: v.trades ? Math.round((v.pnlSum / v.trades) * 100) / 100 : null,
      };
    }
    return out;
  }

  const byMarketGroup  = enrichGroup(groupBy(closed, 'marketGroup'));
  const byRiskProfile  = enrichGroup(groupBy(closed, 'riskProfileName'));
  const bySessionGroup = enrichGroup(bySession(closed));
  const bySymbolGroup  = enrichGroup(groupBy(closed, 'symbol'));

  // Version split: v1 = no paperRulesVersion, v2/v3 = explicit versions.
  function versionStats(arr) {
    if (!arr.length) return { trades: 0, wins: 0, losses: 0, timeouts: 0, winRate: null, avgPnlPct: null, timeoutRate: null, avgMaxFavorablePct: null, avgMaxAdversePct: null };
    const w  = arr.filter(t => t.result === 'WIN').length;
    const l  = arr.filter(t => t.result === 'LOSS').length;
    const to = arr.filter(t => t.result === 'TIMEOUT').length;
    const pnls = arr.map(t => t.pnlPct || 0);
    const withIntrabar = arr.filter(t => t.maxFavorablePct != null);
    return {
      trades:            arr.length,
      wins:              w,
      losses:            l,
      timeouts:          to,
      winRate:           Math.round((w / arr.length) * 100),
      avgPnlPct:         Math.round((pnls.reduce((a, b) => a + b, 0) / pnls.length) * 10000) / 10000,
      timeoutRate:       Math.round((to / arr.length) * 100),
      avgMaxFavorablePct: withIntrabar.length
        ? Math.round((withIntrabar.reduce((s, t) => s + t.maxFavorablePct, 0) / withIntrabar.length) * 10000) / 10000
        : null,
      avgMaxAdversePct: withIntrabar.length
        ? Math.round((withIntrabar.reduce((s, t) => s + (t.maxAdversePct || 0), 0) / withIntrabar.length) * 10000) / 10000
        : null,
    };
  }

  return {
    ok:            true,
    mode:          'paper',
    totalTrades:   closed.length + open.length,
    openTrades:    open.length,
    wins,
    losses,
    timeouts,
    winRate,
    avgPnlPct,
    bySignalFamily:  groupBy(closed, 'signalFamily'),
    bySignalSubtype: groupBy(closed, 'signalSubtype'),
    bySymbol:        bySymbolGroup,
    byMarketType:    groupBy(closed, 'marketType'),
    byMarketGroup,
    byRiskProfile,
    bySession:       bySessionGroup,
    afterFilter,
    v1v2: {
      v1: versionStats(closed.filter(t => !t.paperRulesVersion)),
      v2: versionStats(closed.filter(t => t.paperRulesVersion === 'v2')),
      v3: versionStats(closed.filter(t => t.paperRulesVersion === 'v3' || t.ruleVersion === 'v3')),
    },
    conservativeMode: state.conservativeMode || false,
  };
}

function isCryptoMarketType(mt) {
  return String(mt || '').toLowerCase() === 'crypto';
}

function mostCommonSkipReason(events) {
  const counts = new Map();
  for (const e of events) {
    if (e.decision !== 'skipped') continue;
    const reason = e.reasonSv || 'Okänd orsak.';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function getEvents() {
  const events = loadEvents(MEMORY_EVENTS);
  recentEvents = events;
  const today = new Date().toISOString().slice(0, 10);
  const todayEvents = events.filter(e => e.timestamp?.startsWith(today));
  return {
    ok: true,
    mode: 'paper',
    events,
    summary: {
      openedToday: todayEvents.filter(e => e.type === 'TRADE_OPENED').length,
      skippedToday: todayEvents.filter(e => e.decision === 'skipped').length,
      closedToday: todayEvents.filter(e => e.type === 'TRADE_CLOSED').length,
      mostCommonSkipReason: mostCommonSkipReason(todayEvents),
    },
  };
}

function getCalibrationReport() {
  const state    = loadState();
  const allClosed = loadClosedTrades();
  const allEvents = loadJsonl(EVENTS_FILE);

  const v1Trades = allClosed.filter(t => !t.paperRulesVersion);
  const v2Trades = allClosed.filter(t => t.paperRulesVersion === 'v2');
  const v3Trades = allClosed.filter(t => t.paperRulesVersion === 'v3' || t.ruleVersion === 'v3');

  function vStats(arr) {
    if (!arr.length) return null;
    const w  = arr.filter(t => t.result === 'WIN').length;
    const l  = arr.filter(t => t.result === 'LOSS').length;
    const to = arr.filter(t => t.result === 'TIMEOUT').length;
    const pnls = arr.map(t => t.pnlPct || 0);
    const withIntrabar = arr.filter(t => t.maxFavorablePct != null);
    return {
      trades:            arr.length,
      wins:  w, losses: l, timeouts: to,
      winRate:           Math.round((w / arr.length) * 100),
      avgPnlPct:         Math.round((pnls.reduce((a, b) => a + b, 0) / pnls.length) * 10000) / 10000,
      timeoutRate:       Math.round((to / arr.length) * 100),
      avgMaxFavorablePct: withIntrabar.length
        ? Math.round((withIntrabar.reduce((s, t) => s + t.maxFavorablePct, 0) / withIntrabar.length) * 10000) / 10000 : null,
      avgMaxAdversePct: withIntrabar.length
        ? Math.round((withIntrabar.reduce((s, t) => s + (t.maxAdversePct || 0), 0) / withIntrabar.length) * 10000) / 10000 : null,
    };
  }

  function groupByKey(arr, key) {
    return arr.reduce((acc, t) => {
      const k = t[key] || 'UNKNOWN';
      if (!acc[k]) acc[k] = { trades: 0, wins: 0, losses: 0, timeouts: 0, pnlSum: 0, maxFavSum: 0, maxFavCount: 0 };
      acc[k].trades++;
      if (t.result === 'WIN')     acc[k].wins++;
      if (t.result === 'LOSS')    acc[k].losses++;
      if (t.result === 'TIMEOUT') acc[k].timeouts++;
      acc[k].pnlSum += (t.pnlPct || 0);
      if (t.maxFavorablePct != null) { acc[k].maxFavSum += t.maxFavorablePct; acc[k].maxFavCount++; }
      return acc;
    }, {});
  }

  function enrichGroupCal(grouped) {
    const out = {};
    for (const [k, v] of Object.entries(grouped)) {
      out[k] = {
        trades: v.trades, wins: v.wins, losses: v.losses, timeouts: v.timeouts,
        winRate:    v.trades ? Math.round((v.wins / v.trades) * 100) : null,
        timeoutRate: v.trades ? Math.round((v.timeouts / v.trades) * 100) : null,
        avgPnlPct:  v.trades ? Math.round((v.pnlSum / v.trades) * 10000) / 10000 : null,
        avgMaxFavorablePct: v.maxFavCount ? Math.round((v.maxFavSum / v.maxFavCount) * 10000) / 10000 : null,
      };
    }
    return out;
  }

  // Top skip reasons from all events
  const skipCounts = {};
  for (const e of allEvents) {
    if (e.decision !== 'skipped') continue;
    const key = e.reasonSv || 'Okänd';
    skipCounts[key] = (skipCounts[key] || 0) + 1;
  }
  const topBlockedReasons = Object.entries(skipCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  // Near-misses: TIMEOUT trades where maxFavorablePct >= 75% of target
  const nearMisses = allClosed.filter(t =>
    t.result === 'TIMEOUT' &&
    t.maxFavorablePct != null &&
    t.maxFavorablePct >= (t.targetPct || TARGET_PCT) * 0.75
  ).slice(-15).map(t => ({
    tradeId: t.tradeId, symbol: t.symbol, signalSubtype: t.signalSubtype,
    entryTime: t.entryTime, targetPct: t.targetPct,
    maxFavorablePct: t.maxFavorablePct, pnlAtExit: t.pnlPct,
    paperRulesVersion: t.paperRulesVersion || 'v1',
  }));

  // Safety alert evaluation
  let safetyAlert = null;
  if (v3Trades.length >= 30) {
    const v3TO  = v3Trades.filter(t => t.result === 'TIMEOUT').length;
    const v3TORate = (v3TO / v3Trades.length) * 100;
    const v3AvgPnl = v3Trades.reduce((s, t) => s + (t.pnlPct || 0), 0) / v3Trades.length;
    safetyAlert = {
      triggered: v3TORate > 70 || v3AvgPnl < 0,
      conservativeModeActive: state.conservativeMode || false,
      timeoutRate: Math.round(v3TORate),
      avgPnl:     Math.round(v3AvgPnl * 10000) / 10000,
      recommendation: (v3TORate > 70 || v3AvgPnl < 0) ? 'Sänk target och stop ytterligare, eller pausa signaltypen.' : null,
    };
  }

  return {
    ok:            true,
    mode:          'paper',
    generatedAt:   new Date().toISOString(),
    rulesVersion:  PAPER_RULE_VERSION,
    conservativeMode: state.conservativeMode || false,
    v1:            vStats(v1Trades),
    v2:            vStats(v2Trades),
    v3:            vStats(v3Trades),
    recentTrades:  allClosed.slice(-20).reverse().map(t => ({
      tradeId: t.tradeId, symbol: t.symbol, signalSubtype: t.signalSubtype,
      direction: t.direction, entryTime: t.entryTime, exitTime: t.exitTime,
      pnlPct: t.pnlPct, result: t.result,
      maxFavorablePct: t.maxFavorablePct ?? null,
      maxAdversePct:   t.maxAdversePct   ?? null,
      firstTargetTouchAt: t.firstTargetTouchAt ?? null,
      targetPct: t.targetPct, stopPct: t.stopPct,
      paperRulesVersion: t.paperRulesVersion || 'v1',
      profileName: t.paperRiskProfile?.profileName || null,
    })),
    bySignalSubtype: enrichGroupCal(groupByKey(allClosed, 'signalSubtype')),
    byProfile:       enrichGroupCal(groupByKey(allClosed, 'riskProfileName')),
    topBlockedReasons,
    nearMisses,
    safetyAlert,
  };
}

function getGateStatus() {
  const state   = loadState();
  const compass = getMarketCompass();
  return {
    ok:   true,
    mode: 'paper',
    ruleVersion: PAPER_RULE_VERSION,
    thresholds: {
      normal:          THRESHOLD_NORMAL,
      conservative:    THRESHOLD_CONSERVATIVE,
      observeOnly:     THRESHOLD_OBSERVE_ONLY,
      LEVERAGED_ETFS:  THRESHOLD_LEVERAGED,
      CRYPTO_SECONDARY: THRESHOLD_CRYPTO_SEC,
    },
    conservativeMode:  state.conservativeMode || false,
    compassBias:       compass?.bias || null,
    compassAvailable:  !!compass,
    activeRules: ['data_freshness', 'session', 'paper_only', 'compass', 'market_group', 'calibration', 'subtype_safety_v3', 'stop_weak_conditions_v3'],
    calibrationStats:  getGateCalibStats(),
    pipeline:          getPipelineSnapshot(),
  };
}

function getDecisionPipeline() {
  const pipeline = getPipelineSnapshot();

  // Top qualifies rejection reasons (from lightweight buffer)
  const rejCounts = {};
  for (const r of _recentRejections) {
    const key = r.reason || 'okänd';
    rejCounts[key] = (rejCounts[key] || 0) + 1;
  }
  const topRejectionReasons = Object.entries(rejCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  // Top gate block reasons (from in-memory gate decisions)
  const blockCounts = {};
  for (const d of _recentGateDecisions) {
    if (d.allowed || d.mode === 'observe_only') continue;
    const key = d.reasons?.[0] || d.penalties?.[0] || 'okänd gate-orsak';
    blockCounts[key] = (blockCounts[key] || 0) + 1;
  }
  const topGateBlockReasons = Object.entries(blockCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  // Summary text (Swedish)
  const p = pipeline;
  const summaryParts = [];
  if (p.scannerCandidatesToday > 0) {
    summaryParts.push(`Agenten har sett ${p.scannerCandidatesToday} kandidat${p.scannerCandidatesToday !== 1 ? 'er' : ''} idag.`);
  } else {
    summaryParts.push('Inga kandidater har setts idag ännu.');
  }
  if (p.qualifiesPassedToday > 0)
    summaryParts.push(`${p.qualifiesPassedToday} passerade första filtret.`);
  if (p.marketGateEvaluatedToday > 0)
    summaryParts.push(`${p.marketGateEvaluatedToday} nådde Market Gate.`);
  if (p.tradesOpenedToday > 0)
    summaryParts.push(`${p.tradesOpenedToday} trade${p.tradesOpenedToday !== 1 ? 's' : ''} öppnades.`);
  else if (p.marketGateObserveOnlyToday > 0)
    summaryParts.push('Agenten väntar på stark volym.');
  else if (p.marketGateEvaluatedToday > 0)
    summaryParts.push('Ingen trade öppnades.');

  return {
    ok:        true,
    mode:      'paper',
    updatedAt: new Date().toISOString(),
    pipeline,
    summary:   summaryParts.join(' '),
    recentRejections:     _recentRejections.slice(0, 50),
    topRejectionReasons,
    topGateBlockReasons,
    recentGateDecisions:  _recentGateDecisions.slice(0, 50),
  };
}

function getGateHistory() {
  const allDecisions = loadGateDecisionHistory();
  const gateEvents = allDecisions.slice(0, 100);
  const blocked = allDecisions.filter(d => d.mode === 'block' || d.allowed === false).length;
  const passed  = allDecisions.filter(d => d.mode === 'allow' || d.allowed === true).length;
  const observeOnly = allDecisions.filter(d => d.mode === 'observe_only').length;
  return {
    ok:         true,
    mode:       'paper',
    source:     'disk',
    totalInLog: allDecisions.length,
    blocked,
    passed,
    observeOnly,
    passRate:   allDecisions.length ? Math.round((passed / allDecisions.length) * 100) : null,
    events:     gateEvents.slice(0, 50),
    decisions:  gateEvents.slice(0, 50),
  };
}

function getGateDecisions() {
  const persisted = loadGateDecisionHistory({ limit: 50 });
  const blocked = _recentGateDecisions.filter(d => d.mode !== 'observe_only' && !d.allowed).length;
  const allowed = _recentGateDecisions.filter(d => d.mode !== 'observe_only' && d.allowed).length;
  const observeOnly = _recentGateDecisions.filter(d => d.mode === 'observe_only').length;
  return {
    ok:        true,
    mode:      'paper',
    source:    'memory',
    decisions: _recentGateDecisions,
    total:     _recentGateDecisions.length,
    blocked,
    allowed,
    observeOnly,
    persisted: {
      source: 'disk',
      count:  loadGateDecisionHistory().length,
      latestAt: persisted[0]?.timestamp || null,
      decisions: persisted,
    },
  };
}

function getGateDecisionsHistory(options = {}) {
  const decisions = loadGateDecisionHistory(options);
  return {
    ok: true,
    source: 'disk',
    count: decisions.length,
    decisions,
  };
}

function getGateEffectivenessReport() {
  const state = loadState();
  const closed = loadClosedTrades();
  const trades = [...closed, ...(state.openTrades || [])];
  const persistedGateDecisions = loadGateDecisionHistory();
  const gateDecisions = persistedGateDecisions.length ? persistedGateDecisions : _recentGateDecisions;
  return buildGateEffectivenessReport({
    trades,
    gateDecisions,
    pipeline: getPipelineSnapshot(),
    gateDecisionSource: persistedGateDecisions.length ? 'disk' : 'memory',
    persistedGateDecisionCount: persistedGateDecisions.length,
    inMemoryGateDecisionCount: _recentGateDecisions.length,
    latestPersistedGateDecisionAt: persistedGateDecisions[0]?.timestamp || null,
  });
}

module.exports = {
  initOnStartup,
  start,
  stop,
  getStatus,
  getLiveState,
  getLatestAgentAnalysis,
  getTrades,
  getPerformance,
  getEvents,
  getCompassStatus,
  getCalibrationReport,
  getGateStatus,
  getGateHistory,
  getGateDecisions,
  getGateDecisionsHistory,
  getDecisionPipeline,
  getGateEffectivenessReport,
  appendGateDecision,
  loadGateDecisionHistory,
};
