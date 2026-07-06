'use strict';

// Trade Outcome Replay v1
// Read-only paper/replay analysis. Never creates trades, changes config, or places orders.

const fs = require('fs');
const path = require('path');

const { loadCandles } = require('../data/marketDataStore');
const auditTrail = require('./auditTrailService');
const setupPerformance = require('./setupPerformanceService');
const strategyPerformance = require('./strategyPerformanceService');
const tradingAgentsResultMemory = require('./tradingAgentsResultMemoryService');
const strategyBatchTest = require('./strategyBatchTestService');
const aiOptimizationAgent = require('./aiOptimizationAgentService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  replay_mode: true,
  paper_only: true,
  read_only: true,
});

const DATA_DIR = path.resolve(__dirname, '../../data');
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trading/trades.jsonl');
const PAPER_STATE_FILE = path.join(DATA_DIR, 'paper-trading/state.json');
const PAPER_EVENTS_FILE = path.join(DATA_DIR, 'paper-trading/events.jsonl');
const AUDIT_EVENTS_FILE = path.join(DATA_DIR, 'audit-trail/events.jsonl');
const DEFAULT_FILES = Object.freeze({
  trades: PAPER_TRADES_FILE,
  state: PAPER_STATE_FILE,
  events: PAPER_EVENTS_FILE,
  auditEvents: AUDIT_EVENTS_FILE,
});

const PROFILE_SPECS = Object.freeze({
  paper_quality_v2: {
    id: 'paper_quality_v2',
    label: 'paper_quality_v2',
    kind: 'adaptive',
    description: 'Referenceprofilen från första testet. Trailing 0.10%, break-even senare än baseline.',
    recommendationHint: 'Baslinje för v2-jämförelse.',
    trailingDistancePct: 0.10,
    breakEvenAfterProfitPct: 0.15,
    momentumFadeMinDurationMs: 4 * 60 * 1000,
    momentumFadeMinProfitPct: 0.03,
    momentumFadeMinMfePct: 0.08,
  },
  paper_quality_v3_soft: {
    id: 'paper_quality_v3_soft',
    label: 'paper_quality_v3_soft',
    kind: 'adaptive',
    description: 'Mjukare testprofil med mer andrum: trailing 0.15%, break-even senare och mer återhållsam momentum-fade.',
    trailingDistancePct: 0.15,
    breakEvenAfterProfitPct: 0.18,
    momentumFadeMinDurationMs: 5 * 60 * 1000,
    momentumFadeMinProfitPct: 0.04,
    momentumFadeMinMfePct: 0.10,
  },
  paper_quality_v3_wide: {
    id: 'paper_quality_v3_wide',
    label: 'paper_quality_v3_wide',
    kind: 'adaptive',
    description: 'Bredare testprofil med ännu mer utrymme för normal rekyl: trailing 0.20% och senare break-even.',
    trailingDistancePct: 0.20,
    breakEvenAfterProfitPct: 0.22,
    momentumFadeMinDurationMs: 6 * 60 * 1000,
    momentumFadeMinProfitPct: 0.05,
    momentumFadeMinMfePct: 0.12,
  },
  paper_quality_v3_entry_filter: {
    id: 'paper_quality_v3_entry_filter',
    label: 'paper_quality_v3_entry_filter',
    kind: 'entry_filter',
    description: 'Behåller baseline exitlogik men exkluderar caution + REGULAR_PULLBACK som wouldSkip/require2mConfirmation.',
    recommendationHint: 'Gör det enklare att se om entry ensam förbättrar resultatet.',
  },
  paper_quality_v3_volatility: {
    id: 'paper_quality_v3_volatility',
    label: 'paper_quality_v3_volatility',
    kind: 'volatility',
    description: 'Adaptiv trailing stop baserad på volatilitetspåslag från 2m-range proxy. Om data saknas markeras profilen som degraded.',
    recommendationHint: 'Bra om volatiliteten faktiskt varierar mycket mellan symboler.',
    volatilityBasePct: 0.12,
    volatilityMultiplier: 0.9,
    volatilityCapPct: 0.40,
    breakEvenAfterProfitPct: 0.18,
    momentumFadeMinDurationMs: 5 * 60 * 1000,
    momentumFadeMinProfitPct: 0.04,
    momentumFadeMinMfePct: 0.10,
  },
});

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readStateOpenTrades() {
  try {
    if (!fs.existsSync(PAPER_STATE_FILE)) return [];
    const state = JSON.parse(fs.readFileSync(PAPER_STATE_FILE, 'utf8'));
    return Array.isArray(state.openTrades) ? state.openTrades : [];
  } catch (_) {
    return [];
  }
}

function allTrades() {
  return [
    ...readJsonl(PAPER_TRADES_FILE),
    ...readStateOpenTrades(),
  ].map(normalizeTradeForReplay);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function maybeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : '';
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function iso(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

function ts(value) {
  const d = new Date(value).getTime();
  return Number.isFinite(d) ? d : 0;
}

function durationSeconds(start, end) {
  const a = ts(start);
  const b = ts(end);
  if (!a || !b) return 0;
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

function cleanValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanValue(v)]));
  }
  return value;
}

function normalizeTradeForReplay(trade = {}) {
  const openedAt = iso(trade.opened_at || trade.openedAt || trade.entryTime || trade.createdAt);
  const closedAt = iso(trade.closed_at || trade.closedAt || trade.exitTime);
  const end = closedAt || iso(trade.last_update_at || trade.lastUpdateAt || trade.updatedAt) || openedAt;
  const seconds = durationSeconds(openedAt, end);
  const entryPrice = num(trade.entry_price ?? trade.entryPrice);
  const exitPrice = num(trade.exit_price ?? trade.exitPrice);
  const pnl = Number.isFinite(Number(trade.pnl_pct ?? trade.pnlPct ?? trade.pnl))
    ? Number(trade.pnl_pct ?? trade.pnlPct ?? trade.pnl)
    : (entryPrice && exitPrice ? calcPnlPct({ ...trade, entryPrice }, exitPrice) : 0);
  const setupId = trade.setup_id || trade.setupId || setupPerformance.buildSetupId(trade);
  return {
    ...trade,
    trade_id: trade.trade_id || trade.tradeId || trade.id || '',
    tradeId: trade.tradeId || trade.trade_id || trade.id || '',
    symbol: String(trade.symbol || '').toUpperCase(),
    strategy_id: trade.strategy_id || trade.strategyId || trade.signalSubtype || trade.signalFamily || '',
    setup: trade.setup || trade.entrySetup || trade.entry_setup || trade.signalSubtype || trade.signalFamily || '',
    setup_id: setupId,
    opened_at: openedAt,
    closed_at: closedAt || '',
    duration_seconds: seconds,
    duration_label: trade.duration_label || trade.durationLabel || durationLabel(seconds),
    entry_price: round(entryPrice),
    exit_price: exitPrice ? round(exitPrice) : '',
    pnl_pct: round(pnl, 4),
    result: normalizeResult(trade.result),
    exit_reason: trade.exit_reason || trade.exitReason || trade.exitReasonCode || '',
    exit_source: trade.exit_source || trade.exitSource || trade.exitEngineDecision?.source || '',
    stop_loss: maybeNum(trade.stop_loss ?? trade.stopPct ?? trade.paperRiskProfile?.stopPct),
    take_profit: maybeNum(trade.take_profit ?? trade.targetPct ?? trade.paperRiskProfile?.targetPct),
    holding_time: maybeNum(trade.holding_time ?? trade.maxHoldMinutes ?? trade.paperRiskProfile?.maxHoldMinutes),
    max_favorable_pct: maybeNum(trade.max_favorable_pct ?? trade.maxFavorablePct ?? trade.mfePct ?? null),
    max_adverse_pct: maybeNum(trade.max_adverse_pct ?? trade.maxAdversePct ?? trade.maePct ?? null),
    highest_price_during_trade: maybeNum(trade.highest_price_during_trade ?? trade.highestPriceDuringTrade ?? null),
    lowest_price_during_trade: maybeNum(trade.lowest_price_during_trade ?? trade.lowestPriceDuringTrade ?? null),
    statusAtEntry: String(trade.statusAtEntry || trade.status_at_entry || trade.runtime_status || trade.runtimeStatus || '').trim(),
    entryReason: String(trade.entryReason || trade.entryReasonSv || trade.entry_reason || trade.entry_reason_sv || '').trim(),
    confidence: maybeNum(trade.confidence ?? trade.confidenceScore),
    signal_score: maybeNum(trade.signal_score ?? trade.score ?? trade.tradeScore ?? trade.gateScore),
    priority_score: maybeNum(trade.priority_score ?? trade.priorityScore ?? trade.strategy_priority_score ?? trade.gateScore),
    market_regime: trade.market_regime || trade.marketRegime || trade.marketPersonality || '',
    market_bias: trade.market_bias || trade.marketBias || trade.compassBias || trade.nextMoveBias || '',
  };
}

function normalizeResult(result) {
  const r = String(result || '').toUpperCase();
  if (r === 'WIN') return 'win';
  if (r === 'LOSS') return 'loss';
  if (r === 'TIMEOUT') return 'timeout';
  if (r === 'OPEN') return 'open';
  return r ? r.toLowerCase() : 'unknown';
}

function calcPnlPct(trade, price) {
  const entry = num(trade.entryPrice ?? trade.entry_price);
  const px = num(price);
  if (!entry || !px) return 0;
  const raw = ((px - entry) / entry) * 100;
  return String(trade.direction || trade.nextMoveBias || '').toUpperCase() === 'DOWN' ? -raw : raw;
}

function findTrade(tradeId) {
  const id = String(tradeId || '').trim();
  const trades = allTrades();
  let trade = trades.find((t) => [t.trade_id, t.tradeId, t.id].filter(Boolean).map(String).includes(id));
  if (trade) return trade;

  const paperEvent = readJsonl(PAPER_EVENTS_FILE).find((e) => String(e.eventId || e.event_id) === id);
  if (paperEvent) {
    trade = nearestTradeForEvent(trades, paperEvent.symbol, paperEvent.timestamp, paperEvent.type);
    if (trade) return trade;
  }

  const auditEvent = readJsonl(AUDIT_EVENTS_FILE).find((e) => String(e.event_id) === id || String(e.details?.paper_event_id || '') === id);
  if (auditEvent) {
    trade = nearestTradeForEvent(trades, auditEvent.symbol, auditEvent.timestamp, auditEvent.type);
    if (trade) return trade;
  }

  if (id.includes('@')) {
    const [symbol, timestamp] = id.split('@');
    trade = nearestTradeForEvent(trades, symbol, timestamp, '');
  }
  return trade || null;
}

function nearestTradeForEvent(trades, symbol, timestamp, type) {
  const sym = String(symbol || '').toUpperCase();
  const eventTs = ts(timestamp);
  if (!sym || !eventTs) return null;
  const preferClosed = String(type || '').includes('CLOSED');
  const scored = trades
    .filter((t) => t.symbol === sym)
    .map((t) => {
      const anchor = preferClosed ? (ts(t.closed_at) || ts(t.opened_at)) : ts(t.opened_at);
      return { trade: t, delta: Math.abs(anchor - eventTs) };
    })
    .filter((row) => row.delta <= 20 * 60 * 1000)
    .sort((a, b) => a.delta - b.delta);
  return scored[0]?.trade || null;
}

function labelForEvent(event) {
  const type = String(event.type || '').toUpperCase();
  if (type === 'SIGNAL_DETECTED') return 'Signal hittad';
  if (type === 'CANDIDATE_FOUND' || type === 'CANDIDATE_EVALUATED') return 'Kandidat skapad';
  if (type === 'PAPER_TRADE_OPENED' || type === 'TRADE_OPENED') return 'Papertrade öppnad';
  if (type === 'PAPER_TRADE_CLOSED' || type === 'TRADE_CLOSED') {
    const pnl = event.details?.pnl_pct ?? event.pnlPct ?? '';
    const suffix = pnl !== '' ? ` ${Number(pnl) >= 0 ? '+' : ''}${round(pnl, 2)}%` : '';
    return `Papertrade stängd${suffix}`;
  }
  if (type.includes('EXIT_ENGINE_TIGHTEN')) return 'Exitmotor höjde stop';
  if (type.includes('EXIT')) return 'Exitmotor agerade';
  if (type === 'SAFETY_BLOCKED') return 'Safety blockerade';
  if (type === 'RISK_BLOCKED') return 'Riskmotor blockerade';
  if (type.includes('BATCH')) return 'Batch-event';
  return event.message || event.reasonSv || event.type || 'Aktivitet';
}

function normalizeTimelineEvent(event, source = 'audit') {
  const timestamp = iso(event.timestamp);
  return {
    timestamp,
    time_label: timestamp ? new Date(timestamp).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '',
    type: event.type || '',
    label: labelForEvent(event),
    message: event.message || event.reasonSv || labelForEvent(event),
    source,
  };
}

function getTradeTimeline(tradeId) {
  const trade = typeof tradeId === 'object' ? normalizeTradeForReplay(tradeId) : findTrade(tradeId);
  if (!trade) return cleanValue({ ok: false, error: 'trade_not_found', timeline: [], ...SAFETY });

  const opened = ts(trade.opened_at);
  const closed = ts(trade.closed_at) || opened;
  const from = opened - 10 * 60 * 1000;
  const to = Math.max(closed, opened) + 20 * 60 * 1000;
  const tradeIds = new Set([trade.trade_id, trade.tradeId].filter(Boolean).map(String));
  const relevantTypes = new Set([
    'SIGNAL_DETECTED', 'CANDIDATE_FOUND', 'CANDIDATE_EVALUATED',
    'PAPER_TRADE_OPENED', 'PAPER_TRADE_CLOSED', 'SAFETY_BLOCKED', 'RISK_BLOCKED',
    'BATCH_CREATED', 'BATCH_STARTED', 'BATCH_PROGRESS', 'BATCH_COMPLETED',
  ]);

  const auditEvents = readJsonl(AUDIT_EVENTS_FILE).filter((event) => {
    const eventTs = ts(event.timestamp);
    const detailTradeId = String(event.details?.trade_id || event.details?.tradeId || '');
    const directMatch = detailTradeId && tradeIds.has(detailTradeId);
    const symbolMatch = event.symbol && String(event.symbol).toUpperCase() === trade.symbol && eventTs >= from && eventTs <= to;
    const typeMatch = relevantTypes.has(String(event.type || '').toUpperCase()) || String(event.type || '').includes('EXIT');
    return directMatch || (symbolMatch && typeMatch);
  }).map((event) => normalizeTimelineEvent(event, 'audit'));

  const paperEvents = readJsonl(PAPER_EVENTS_FILE).filter((event) => {
    const eventTs = ts(event.timestamp);
    return String(event.symbol || '').toUpperCase() === trade.symbol && eventTs >= from && eventTs <= to;
  }).map((event) => normalizeTimelineEvent(event, 'paper'));

  const synthetic = [
    trade.opened_at ? normalizeTimelineEvent({
      timestamp: trade.opened_at,
      type: 'PAPER_TRADE_OPENED',
      message: `Papertrade öppnad för ${trade.symbol}`,
    }, 'trade') : null,
    trade.closed_at ? normalizeTimelineEvent({
      timestamp: trade.closed_at,
      type: 'PAPER_TRADE_CLOSED',
      message: `Papertrade stängd ${trade.pnl_pct >= 0 ? '+' : ''}${round(trade.pnl_pct, 2)}%`,
      details: { pnl_pct: trade.pnl_pct },
    }, 'trade') : null,
    trade.exitEngineLastDecision?.timestamp ? normalizeTimelineEvent({
      timestamp: trade.exitEngineLastDecision.timestamp,
      type: 'EXIT_ENGINE_TIGHTEN_STOP',
      message: trade.exitEngineLastDecision.reason || 'Exitmotor höjde stop',
    }, 'exit_engine') : null,
  ].filter(Boolean);

  const seen = new Set();
  const timeline = [...auditEvents, ...paperEvents, ...synthetic]
    .filter((event) => {
      const key = `${event.timestamp}|${event.type}|${event.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => ts(a.timestamp) - ts(b.timestamp));

  return cleanValue({ ok: true, trade_id: trade.trade_id, timeline, count: timeline.length, ...SAFETY });
}

function explainTradeEntry(tradeInput) {
  const trade = normalizeTradeForReplay(tradeInput);
  const supports = [];
  const warnings = [];
  const subtype = String(trade.signalSubtype || trade.strategy_id || '').toUpperCase();
  const family = String(trade.signalFamily || '').toUpperCase();

  if (subtype.includes('VWAP_RECLAIM')) supports.push('VWAP återtaget');
  if (subtype.includes('VWAP_REJECTION')) supports.push('VWAP avvisades');
  if (family.includes('EMA') || subtype.includes('EMA')) supports.push('EMA-trend stödde setupen');
  if (family.includes('NARROW') || subtype.includes('NARROW')) supports.push('Kompression gav möjlig rörelse');
  if (String(trade.volumeState || '').toLowerCase() === 'strong') supports.push('Stark volym');
  if (['UP', 'DOWN'].includes(String(trade.nextMoveBias || trade.direction || '').toUpperCase())) supports.push('Momentum var tydligt');
  if (trade.aiAgentAnalysis?.should_block_trade === false) supports.push('AI-analysteamet blockerade inte traden');
  if (trade.aiAgentAnalysis?.memory_summary?.win_rate != null) supports.push(`Liknande mönster hade ${round(trade.aiAgentAnalysis.memory_summary.win_rate, 1)}% vinstprocent`);
  if (trade.riskEvaluation?.allowed === true) supports.push('Riskmotor godkände');
  if (trade.executionSafety?.paper_execution_allowed === true) supports.push('Safety godkände paper trade');
  if (trade.gateDecision?.allowed === true) supports.push('Market gate godkände');

  if (trade.compassConflict === true) warnings.push('Mixed market');
  if (String(trade.compassBias || '').includes('RISK_OFF')) warnings.push('Svag marknadsbekräftelse');
  if ((trade.aiAgentAnalysis?.memory_summary?.sample_size || 0) > 0 && trade.aiAgentAnalysis.memory_summary.sample_size < 10) warnings.push('Låg historik');
  if (num(trade.maxHoldMinutes) <= 5 || String(trade.statusAtEntry || '').toLowerCase() === 'caution') warnings.push('Timeout-risk');
  if (String(trade.volumeState || '').toLowerCase().includes('weak')) warnings.push('Svag volym');
  for (const w of trade.gateDecision?.warnings || []) warnings.push(String(w));
  for (const w of trade.riskWarnings || trade.riskEvaluation?.warnings || []) warnings.push(String(w));

  return cleanValue({
    question: 'Varför öppnades traden?',
    summary: supports.length ? supports.slice(0, 3).join(', ') : (trade.entryReasonSv || 'Setupen uppfyllde paper-reglerna.'),
    supports: [...new Set(supports)],
    warnings: [...new Set(warnings)],
    raw_reason: trade.entryReasonSv || '',
    ...SAFETY,
  });
}

function explainTradeExit(tradeInput) {
  const trade = normalizeTradeForReplay(tradeInput);
  const reasons = [];
  const warnings = [];
  const reason = String(trade.exit_reason || '').toUpperCase();
  const source = String(trade.exit_source || '').toLowerCase();

  if (reason.includes('TARGET')) reasons.push('Take profit nåddes');
  if (reason.includes('STOP')) reasons.push('Stop loss träffades');
  if (reason.includes('TIMEOUT')) reasons.push('Timeout');
  if (source.includes('exit_engine')) reasons.push('Exitmotor stängde traden');
  if (reason.includes('TRAIL')) reasons.push('Trailing stop');
  if (reason.includes('MOMENTUM')) reasons.push('Momentum försvagades');
  if (reason.includes('SAFETY') || reason.includes('RISK')) reasons.push('Safety/risk stop');
  if (trade.exitEngineDecision?.reason) reasons.push(trade.exitEngineDecision.reason);
  if (!reasons.length && trade.result === 'open') reasons.push('Traden är fortfarande öppen');
  if (!reasons.length) reasons.push('Systemet stängde enligt paper-reglerna');

  if (trade.pnl_pct < 0) warnings.push('Exit gav förlust');
  if (trade.result === 'timeout') warnings.push('Tiden tog slut innan tydlig exit');

  return cleanValue({
    question: 'Varför stängdes traden?',
    summary: reasons[0],
    reasons: [...new Set(reasons)],
    warnings,
    exit_quality: trade.pnl_pct > 0 ? 'vinst' : trade.pnl_pct < 0 ? 'förlust' : 'oförändrat',
    ...SAFETY,
  });
}

function loadTradeBars(trade) {
  const start = (trade.opened_at || '').slice(0, 10);
  if (!start || !trade.symbol) return [];
  const endDate = new Date(ts(trade.closed_at || trade.opened_at) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return loadCandles(trade.symbol, start, endDate, '2m')
    .map((bar) => ({
      timestamp: iso(bar.timestamp || bar.ts || bar.t),
      open: num(bar.open ?? bar.o),
      high: num(bar.high ?? bar.h),
      low: num(bar.low ?? bar.l),
      close: num(bar.close ?? bar.c),
    }))
    .filter((bar) => bar.timestamp && bar.close)
    .sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
}

function compareLabel(actual, alternative) {
  if (alternative.data_status !== 'ok') return 'för lite data';
  const diff = round(alternative.pnl_pct - actual, 4);
  if (diff > 0.01) return 'hade blivit bättre';
  if (diff < -0.01) return 'hade blivit sämre';
  return 'ingen skillnad';
}

function alternativeResult(trade, label, exitAt, exitPrice, note = '') {
  if (!exitAt || !exitPrice) {
    return { label, result: 'för lite data', pnl_pct: 0, difference_pct: 0, data_status: 'missing', note: note || 'För lite prisdata för alternativ exit.' };
  }
  const pnl = round(calcPnlPct(trade, exitPrice), 4);
  const row = {
    label,
    exit_at: exitAt,
    exit_price: round(exitPrice),
    pnl_pct: pnl,
    difference_pct: round(pnl - num(trade.pnl_pct), 4),
    data_status: 'ok',
    note,
  };
  row.result = compareLabel(num(trade.pnl_pct), row);
  return row;
}

function priceAtHold(trade, bars, minutes) {
  const target = ts(trade.opened_at) + minutes * 60 * 1000;
  const bar = bars.find((b) => ts(b.timestamp) >= target);
  return alternativeResult(trade, `Höll ${minutes} minuter`, bar?.timestamp, bar?.close);
}

function stopOrTarget(trade, bars, label, stopPct, targetPct) {
  const direction = String(trade.direction || trade.nextMoveBias || '').toUpperCase();
  for (const bar of bars) {
    const adversePrice = direction === 'DOWN' ? bar.high : bar.low;
    const favorablePrice = direction === 'DOWN' ? bar.low : bar.high;
    if (calcPnlPct(trade, adversePrice) <= -stopPct) {
      return alternativeResult(trade, label, bar.timestamp, adversePrice, `Stop ${round(stopPct, 2)}% träffades.`);
    }
    if (targetPct && calcPnlPct(trade, favorablePrice) >= targetPct) {
      return alternativeResult(trade, label, bar.timestamp, favorablePrice, `Take profit ${round(targetPct, 2)}% träffades.`);
    }
  }
  const last = bars[bars.length - 1];
  return alternativeResult(trade, label, last?.timestamp, last?.close, 'Ingen alternativ nivå träffades innan prisdata tog slut.');
}

function trailingStop(trade, bars) {
  let best = -Infinity;
  let exitBar = null;
  for (const bar of bars) {
    const pnl = calcPnlPct(trade, bar.close);
    best = Math.max(best, pnl);
    if (best >= 0.12 && pnl <= best - 0.12) {
      exitBar = bar;
      break;
    }
  }
  const last = exitBar || bars[bars.length - 1];
  return alternativeResult(trade, 'Trailing stop', last?.timestamp, last?.close, exitBar ? 'Trailing stop låste in rörelsen.' : 'Trailing stop hann inte slå till.');
}

function compareAlternativeExits(tradeInput) {
  const trade = normalizeTradeForReplay(tradeInput);
  const bars = loadTradeBars(trade).filter((bar) => ts(bar.timestamp) > ts(trade.opened_at));
  const stop = num(trade.stop_loss, 0.25);
  if (!bars.length) {
    const alternatives = ['Höll 3 minuter', 'Höll 5 minuter', 'Höll 8 minuter', 'Höll 12 minuter', 'Tight stop', 'Medium stop', 'Wide stop', 'Trailing stop', 'Take profit 1R', 'Take profit 1.5R', 'Take profit 2R']
      .map((label) => ({ label, result: 'för lite data', pnl_pct: 0, difference_pct: 0, data_status: 'missing', note: 'För lite prisdata för alternativ exit.' }));
    return cleanValue({ ok: true, trade_id: trade.trade_id, alternatives, price_data_points: 0, ...SAFETY });
  }

  const alternatives = [
    priceAtHold(trade, bars, 3),
    priceAtHold(trade, bars, 5),
    priceAtHold(trade, bars, 8),
    priceAtHold(trade, bars, 12),
    stopOrTarget(trade, bars, 'Tight stop', Math.max(0.05, stop * 0.6), 0),
    stopOrTarget(trade, bars, 'Medium stop', stop, 0),
    stopOrTarget(trade, bars, 'Wide stop', stop * 1.8, 0),
    trailingStop(trade, bars),
    stopOrTarget(trade, bars, 'Take profit 1R', stop, stop),
    stopOrTarget(trade, bars, 'Take profit 1.5R', stop, stop * 1.5),
    stopOrTarget(trade, bars, 'Take profit 2R', stop, stop * 2),
  ];

  return cleanValue({ ok: true, trade_id: trade.trade_id, alternatives, price_data_points: bars.length, ...SAFETY });
}

function calculateMissedOpportunity(tradeInput) {
  const trade = normalizeTradeForReplay(tradeInput);
  const alt = compareAlternativeExits(trade).alternatives || [];
  const valid = alt.filter((row) => row.data_status === 'ok');
  if (!valid.length) {
    return cleanValue({
      ok: true,
      trade_id: trade.trade_id,
      missed: false,
      message: 'För lite prisdata för alternativ exit.',
      findings: ['För lite prisdata för alternativ exit.'],
      best_alternative: {},
      ...SAFETY,
    });
  }
  const best = [...valid].sort((a, b) => b.pnl_pct - a.pnl_pct)[0];
  const findings = [];
  if (best.difference_pct > 0.05) findings.push(`Om traden ${best.label.toLowerCase()} hade resultatet varit ${best.pnl_pct >= 0 ? '+' : ''}${round(best.pnl_pct, 2)}% istället för ${trade.pnl_pct >= 0 ? '+' : ''}${round(trade.pnl_pct, 2)}%.`);
  if (trade.result === 'timeout' && best.difference_pct > 0.03) findings.push('Timeout missade en bättre rörelse.');
  if (String(trade.exit_reason).toUpperCase().includes('STOP') && alt.find((a) => a.label === 'Wide stop' && a.difference_pct > 0.03)) findings.push('Stop loss kan ha varit för tight.');
  if (String(trade.exit_reason).toUpperCase().includes('TARGET') && alt.find((a) => /^Höll/.test(a.label) && a.difference_pct > 0.03)) findings.push('Take profit kan ha varit för låg.');
  if (alt.find((a) => a.label === 'Höll 8 minuter' && a.difference_pct > 0.03)) findings.push('Längre holding hade hjälpt.');
  if (!findings.length) findings.push('Exit ser rimlig ut jämfört med enkla alternativ.');

  return cleanValue({
    ok: true,
    trade_id: trade.trade_id,
    missed: best.difference_pct > 0.05,
    message: findings[0],
    findings,
    best_alternative: best,
    ...SAFETY,
  });
}

function exitReasonBucket(exitReasonCode, fallbackResult = '') {
  const reason = String(exitReasonCode || '').toLowerCase();
  const result = String(fallbackResult || '').toLowerCase();
  if (reason.includes('target')) return 'target_hit';
  if (reason.includes('stop')) return 'stop_hit';
  if (reason.includes('trailing')) return 'trailing_stop';
  if (reason.includes('break_even') || reason.includes('break even') || reason.includes('breakeven')) return 'break_even';
  if (reason.includes('momentum')) return 'momentum_fade';
  if (reason.includes('timeout')) return 'timeout';
  if (result === 'timeout') return 'timeout';
  return 'other';
}

function classifyRecommendation(profileRow, baselineRow) {
  if (!profileRow || profileRow.degraded) return 'Data saknas';
  if ((profileRow.simulated_trades || 0) < 10) return 'För få trades';
  const baseAvg = Number(baselineRow?.avg_pnl_pct) || 0;
  const baseWin = Number(baselineRow?.winrate) || 0;
  const avg = Number(profileRow.avg_pnl_pct) || 0;
  const win = Number(profileRow.winrate) || 0;
  const mae = Number(profileRow.max_adverse_excursion_pct) || 0;
  const baseMae = Number(baselineRow?.max_adverse_excursion_pct) || 0;

  if (avg > baseAvg + 0.005 && win >= baseWin - 2 && profileRow.total_trades_reduced !== true) {
    return 'Bättre än baseline';
  }
  if (avg < baseAvg - 0.005 && win < baseWin - 2) {
    return 'Sämre än baseline';
  }
  if (mae < baseMae - 0.03 || mae > baseMae + 0.03 || profileRow.kind === 'volatility') {
    return 'Lovande men högre risk';
  }
  if ((profileRow.trades_skipped || 0) > 0 && avg > baseAvg) {
    return 'Bättre än baseline';
  }
  return avg >= baseAvg ? 'Bättre än baseline' : 'Lovande men högre risk';
}

function computeVolatilityProxyPct(bars) {
  const samples = (Array.isArray(bars) ? bars : [])
    .map((bar) => {
      const close = Number(bar.close);
      const high = Number(bar.high);
      const low = Number(bar.low);
      if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low) || close <= 0) return null;
      return ((high - low) / close) * 100;
    })
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!samples.length) return null;
  return round(median(samples), 4);
}

function summarizeSimulatedTradeRows(rows, extra = {}) {
  const filtered = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const summary = summarizeExitRows(filtered);
  return {
    ...summary,
    simulated_trades: summary.trades,
    data_status: extra.data_status || 'ok',
    degraded: extra.degraded === true,
    degraded_reason: extra.degraded_reason || null,
    stop_formula: extra.stop_formula || null,
    trailing_distance_pct: extra.trailing_distance_pct ?? null,
    break_even_after_profit_pct: extra.break_even_after_profit_pct ?? null,
    momentum_fade_min_duration_ms: extra.momentum_fade_min_duration_ms ?? null,
    momentum_fade_min_profit_pct: extra.momentum_fade_min_profit_pct ?? null,
    momentum_fade_min_mfe_pct: extra.momentum_fade_min_mfe_pct ?? null,
    kind: extra.kind || 'adaptive',
    description: extra.description || null,
    recommendation_hint: extra.recommendation_hint || null,
    trades_considered: extra.trades_considered ?? summary.trades,
    trades_skipped: extra.trades_skipped ?? 0,
  };
}

function getTradeBarsOrNull(trade) {
  const bars = loadTradeBars(trade).filter((bar) => ts(bar.timestamp) > ts(trade.opened_at));
  return bars.length ? bars : null;
}

function simulateAdaptiveProfileTrade(tradeInput, spec = PROFILE_SPECS.paper_quality_v2) {
  const trade = normalizeTradeForReplay(tradeInput);
  const bars = getTradeBarsOrNull(trade);
  if (!bars) {
    return cleanValue({
      ...trade,
      profile: spec.id || 'unknown',
      data_status: 'missing',
      degraded: true,
      exit_reason_code: trade.exit_reason_code || 'unknown',
      exit_source: trade.exit_source || 'unknown',
      duration_ms: (Number(trade.duration_seconds) || 0) * 1000,
      exit_formula: spec.description || null,
    });
  }

  const direction = String(trade.direction || trade.nextMoveBias || '').toUpperCase();
  const originalStop = num(trade.stop_loss, 0.25);
  const originalTarget = num(trade.take_profit, 0.4);
  const trailingDistancePct = Number.isFinite(Number(spec.trailingDistancePct)) ? Number(spec.trailingDistancePct) : 0.10;
  const breakEvenAfterProfitPct = Number.isFinite(Number(spec.breakEvenAfterProfitPct)) ? Number(spec.breakEvenAfterProfitPct) : 0.15;
  const momentumFadeMinDurationMs = Number.isFinite(Number(spec.momentumFadeMinDurationMs)) ? Number(spec.momentumFadeMinDurationMs) : 4 * 60 * 1000;
  const momentumFadeMinProfitPct = Number.isFinite(Number(spec.momentumFadeMinProfitPct)) ? Number(spec.momentumFadeMinProfitPct) : 0.03;
  const momentumFadeMinMfePct = Number.isFinite(Number(spec.momentumFadeMinMfePct)) ? Number(spec.momentumFadeMinMfePct) : 0.08;

  let best = -Infinity;
  let stopThreshold = -originalStop;
  let exitBar = bars[bars.length - 1];
  let exitReasonCode = 'timeout';
  let exitSource = 'paper_replay';

  for (const bar of bars) {
    const closePnl = calcPnlPct(trade, bar.close);
    best = Math.max(best, closePnl);

    if (best >= breakEvenAfterProfitPct) {
      stopThreshold = Math.max(stopThreshold, 0.01);
    }
    if (best >= breakEvenAfterProfitPct * 0.75) {
      stopThreshold = Math.max(stopThreshold, Math.max(0.01, best - trailingDistancePct));
    }

    const adversePrice = direction === 'DOWN' ? bar.high : bar.low;
    const favorablePrice = direction === 'DOWN' ? bar.low : bar.high;
    const adversePnl = calcPnlPct(trade, adversePrice);
    const favorablePnl = calcPnlPct(trade, favorablePrice);

    if (adversePnl <= -originalStop) {
      exitBar = bar;
      exitReasonCode = 'stop_hit';
      exitSource = 'legacy_hard_rule';
      break;
    }
    if (favorablePnl >= originalTarget) {
      exitBar = bar;
      exitReasonCode = 'target_hit';
      exitSource = 'legacy_hard_rule';
      break;
    }
    if (closePnl <= stopThreshold) {
      exitBar = bar;
      exitReasonCode = best >= breakEvenAfterProfitPct ? 'break_even' : 'trailing_stop';
      exitSource = spec.id || 'paper_replay';
      break;
    }

    const elapsedMs = ts(bar.timestamp) - ts(trade.opened_at);
    if (String(trade.exit_reason_code || '').toLowerCase() === 'momentum_fade' || String(trade.exit_reason || '').toLowerCase().includes('momentum')) {
      if (elapsedMs >= momentumFadeMinDurationMs && best >= momentumFadeMinMfePct && closePnl >= momentumFadeMinProfitPct && closePnl < best - 0.03) {
        exitBar = bar;
        exitReasonCode = 'momentum_fade';
        exitSource = spec.id || 'paper_replay';
        break;
      }
    }
  }

  const exitPrice = num(exitBar.close, trade.exit_price || trade.entry_price);
  const pnl = round(calcPnlPct(trade, exitPrice), 4);
  const durationMs = Math.max(0, ts(exitBar.timestamp) - ts(trade.opened_at));
  return cleanValue({
    ...trade,
    profile: spec.id || 'unknown',
    exit_reason_code: exitReasonCode,
    exit_source: exitSource,
    exit_price: round(exitPrice),
    pnl_pct: pnl,
    result: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'timeout',
    duration_ms: durationMs,
    duration_label: durationLabel(Math.round(durationMs / 1000)),
    max_favorable_pct: trade.max_favorable_pct,
    max_adverse_pct: trade.max_adverse_pct,
    original_stop_pct: originalStop,
    original_target_pct: originalTarget,
    effective_stop_pct: stopThreshold,
    trailing_stop_pct: trailingDistancePct,
    break_even_activated: best >= breakEvenAfterProfitPct,
    break_even_threshold_pct: breakEvenAfterProfitPct,
    exit_engine_enabled: true,
    data_status: 'ok',
    degraded: false,
    exit_formula: spec.description || null,
    volatility_proxy_pct: null,
  });
}

function simulateEntryFilterProfileTrade(tradeInput) {
  const trade = normalizeTradeForReplay(tradeInput);
  const status = String(trade.statusAtEntry || '').toLowerCase();
  const setup = String(trade.setup || trade.strategy_id || '').toUpperCase();
  const shouldSkip = status === 'caution' && setup === 'REGULAR_PULLBACK';
  return {
    ...trade,
    profile: 'paper_quality_v3_entry_filter',
    entry_quality_decision: shouldSkip ? 'wouldSkip' : 'pass',
    wouldSkip: shouldSkip,
    wouldRequire2mConfirmation: shouldSkip,
    data_status: 'ok',
    exit_reason_code: trade.exit_reason || trade.exitReasonCode || 'unknown',
    exit_source: trade.exit_source || trade.exitSource || 'unknown',
    duration_ms: (Number(trade.duration_seconds) || 0) * 1000,
    pnl_pct: trade.pnl_pct,
    result: trade.result,
    max_favorable_pct: trade.max_favorable_pct,
    max_adverse_pct: trade.max_adverse_pct,
  };
}

function buildVolatilityProfileTrade(tradeInput) {
  const trade = normalizeTradeForReplay(tradeInput);
  const bars = getTradeBarsOrNull(trade);
  if (!bars) {
    return cleanValue({
      ...trade,
      profile: 'paper_quality_v3_volatility',
      data_status: 'missing',
      degraded: true,
      degraded_reason: 'missing_2m_bars',
      exit_reason_code: trade.exit_reason_code || 'unknown',
      exit_source: trade.exit_source || 'unknown',
      duration_ms: (Number(trade.duration_seconds) || 0) * 1000,
      exit_formula: PROFILE_SPECS.paper_quality_v3_volatility.description,
    });
  }

  const volatilityProxyPct = computeVolatilityProxyPct(bars);
  if (!Number.isFinite(volatilityProxyPct)) {
    return cleanValue({
      ...trade,
      profile: 'paper_quality_v3_volatility',
      data_status: 'degraded',
      degraded: true,
      degraded_reason: 'volatility_proxy_missing',
      exit_reason_code: trade.exit_reason_code || 'unknown',
      exit_source: trade.exit_source || 'unknown',
      duration_ms: (Number(trade.duration_seconds) || 0) * 1000,
      exit_formula: `${PROFILE_SPECS.paper_quality_v3_volatility.description} Formula: trailing = clamp(${PROFILE_SPECS.paper_quality_v3_volatility.volatilityBasePct} + volatilityProxy*${PROFILE_SPECS.paper_quality_v3_volatility.volatilityMultiplier}, ${PROFILE_SPECS.paper_quality_v3_volatility.volatilityBasePct}, ${PROFILE_SPECS.paper_quality_v3_volatility.volatilityCapPct}). volatilityProxy = median((high-low)/close*100).`,
    });
  }

  const trailingDistancePct = round(Math.min(
    PROFILE_SPECS.paper_quality_v3_volatility.volatilityCapPct,
    Math.max(
      PROFILE_SPECS.paper_quality_v3_volatility.volatilityBasePct,
      PROFILE_SPECS.paper_quality_v3_volatility.volatilityBasePct + volatilityProxyPct * PROFILE_SPECS.paper_quality_v3_volatility.volatilityMultiplier,
    ),
  ), 4);
  const spec = {
    ...PROFILE_SPECS.paper_quality_v3_volatility,
    trailingDistancePct,
    breakEvenAfterProfitPct: PROFILE_SPECS.paper_quality_v3_volatility.breakEvenAfterProfitPct,
    description: `${PROFILE_SPECS.paper_quality_v3_volatility.description} Formula: trailing = clamp(${PROFILE_SPECS.paper_quality_v3_volatility.volatilityBasePct} + volatilityProxy*${PROFILE_SPECS.paper_quality_v3_volatility.volatilityMultiplier}, ${PROFILE_SPECS.paper_quality_v3_volatility.volatilityBasePct}, ${PROFILE_SPECS.paper_quality_v3_volatility.volatilityCapPct}); volatilityProxy=${volatilityProxyPct}%.`,
  };
  const simulated = simulateAdaptiveProfileTrade(trade, spec);
  return {
    ...simulated,
    profile: 'paper_quality_v3_volatility',
    volatility_proxy_pct: volatilityProxyPct,
    trailing_stop_pct: trailingDistancePct,
    exit_formula: spec.description,
    data_status: 'ok',
    degraded: false,
  };
}

function summarizeProfileTradeRows(rows, extra = {}) {
  const summary = summarizeExitRows(rows);
  return {
    ...summary,
    simulated_trades: summary.trades,
    data_status: extra.data_status || 'ok',
    degraded: extra.degraded === true,
    degraded_reason: extra.degraded_reason || null,
    stop_formula: extra.stop_formula || null,
    trailing_distance_pct: extra.trailing_distance_pct ?? null,
    break_even_after_profit_pct: extra.break_even_after_profit_pct ?? null,
    momentum_fade_min_duration_ms: extra.momentum_fade_min_duration_ms ?? null,
    momentum_fade_min_profit_pct: extra.momentum_fade_min_profit_pct ?? null,
    momentum_fade_min_mfe_pct: extra.momentum_fade_min_mfe_pct ?? null,
    kind: extra.kind || 'adaptive',
    description: extra.description || null,
    recommendation_hint: extra.recommendation_hint || null,
    trades_considered: extra.trades_considered ?? summary.trades,
    trades_skipped: extra.trades_skipped ?? 0,
    entry_filter_rule: extra.entry_filter_rule || null,
    exit_formula: extra.exit_formula || null,
    volatility_formula: extra.volatility_formula || null,
  };
}

function median(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function countsBy(rows, key) {
  const counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = String(row?.[key] || 'unknown').trim() || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function summarizeExitRows(rows) {
  const trades = rows.length;
  const wins = rows.filter((row) => String(row.result).toLowerCase() === 'win').length;
  const losses = rows.filter((row) => String(row.result).toLowerCase() === 'loss').length;
  const timeouts = rows.filter((row) => String(row.result).toLowerCase() === 'timeout' || exitReasonBucket(row.exit_reason_code, row.result) === 'timeout').length;
  const totalPnl = rows.reduce((sum, row) => sum + (Number(row.pnl_pct) || 0), 0);
  const durations = rows.map((row) => Number(row.duration_ms) || 0);
  const medDurationMs = Math.round(median(durations));
  const maxAdverse = rows.map((row) => Number(row.max_adverse_pct)).filter((value) => Number.isFinite(value));
  const maxFavorable = rows.map((row) => Number(row.max_favorable_pct)).filter((value) => Number.isFinite(value));
  const exitReasonCounts = countsBy(rows, 'exit_reason_code');
  const targetHit = rows.filter((row) => exitReasonBucket(row.exit_reason_code, row.result) === 'target_hit').length;
  const stopHit = rows.filter((row) => exitReasonBucket(row.exit_reason_code, row.result) === 'stop_hit').length;
  const trailingStop = rows.filter((row) => exitReasonBucket(row.exit_reason_code, row.result) === 'trailing_stop').length;
  const breakEven = rows.filter((row) => exitReasonBucket(row.exit_reason_code, row.result) === 'break_even').length;
  const momentumFade = rows.filter((row) => exitReasonBucket(row.exit_reason_code, row.result) === 'momentum_fade').length;
  const timeoutCount = timeouts;
  return {
    trades,
    simulated_trades: trades,
    winrate: trades ? round((wins / trades) * 100, 2) : 0,
    wins,
    losses,
    timeouts,
    median_pnl_pct: round(median(rows.map((row) => row.pnl_pct)), 4),
    avg_pnl_pct: trades ? round(totalPnl / trades, 4) : 0,
    median_duration_ms: medDurationMs,
    median_duration_label: durationLabel(Math.round(medDurationMs / 1000)),
    avg_duration_ms: trades ? Math.round(durations.reduce((sum, value) => sum + value, 0) / trades) : 0,
    exit_reason_counts: exitReasonCounts,
    target_hit_count: targetHit,
    stop_hit_count: stopHit,
    trailing_stop_count: trailingStop,
    break_even_count: breakEven,
    momentum_fade_count: momentumFade,
    timeout_count: timeoutCount,
    exit_source_counts: countsBy(rows, 'exit_source'),
    max_adverse_excursion_pct: maxAdverse.length ? round(Math.min(...maxAdverse), 4) : 0,
    max_favorable_excursion_pct: maxFavorable.length ? round(Math.max(...maxFavorable), 4) : 0,
  };
}

function simulatePaperQualityV2Trade(tradeInput) {
  const trade = normalizeTradeForReplay(tradeInput);
  const bars = loadTradeBars(trade).filter((bar) => ts(bar.timestamp) > ts(trade.opened_at));
  if (!bars.length) {
    return cleanValue({
      ...trade,
      profile: 'paper_quality_v2',
      data_status: 'missing',
      exit_reason_code: trade.exit_reason_code || 'unknown',
      exit_source: trade.exit_source || 'unknown',
      duration_ms: (Number(trade.duration_seconds) || 0) * 1000,
    });
  }

  const direction = String(trade.direction || trade.nextMoveBias || '').toUpperCase();
  const originalStop = num(trade.stop_loss, 0.25);
  const originalTarget = num(trade.take_profit, 0.4);
  const trailingDistance = 0.10;
  const trailAfterProfit = 0.10;
  const breakEvenThreshold = 0.15;
  const minMomentumFadeDurationMs = 4 * 60 * 1000;
  const minMomentumFadeMfe = 0.08;

  let best = -Infinity;
  let stopThreshold = -originalStop;
  let exitBar = bars[bars.length - 1];
  let exitReasonCode = 'timeout';
  let exitSource = 'paper_replay';

  for (const bar of bars) {
    const closePnl = calcPnlPct(trade, bar.close);
    best = Math.max(best, closePnl);
    if (best >= trailAfterProfit) {
      stopThreshold = Math.max(stopThreshold, Math.max(0.01, best - trailingDistance));
    }
    if (best >= breakEvenThreshold) {
      stopThreshold = Math.max(stopThreshold, 0.01);
    }

    const adversePrice = direction === 'DOWN' ? bar.high : bar.low;
    const favorablePrice = direction === 'DOWN' ? bar.low : bar.high;
    const adversePnl = calcPnlPct(trade, adversePrice);
    const favorablePnl = calcPnlPct(trade, favorablePrice);

    if (adversePnl <= -originalStop) {
      exitBar = bar;
      exitReasonCode = 'stop_hit';
      exitSource = 'legacy_hard_rule';
      break;
    }
    if (favorablePnl >= originalTarget) {
      exitBar = bar;
      exitReasonCode = 'target_hit';
      exitSource = 'legacy_hard_rule';
      break;
    }
    if (closePnl <= stopThreshold) {
      exitBar = bar;
      exitReasonCode = best >= breakEvenThreshold ? 'break_even' : 'trailing_stop';
      exitSource = 'paper_quality_v2';
      break;
    }

    const elapsedMs = ts(bar.timestamp) - ts(trade.opened_at);
    if (String(trade.exit_reason_code || '').toLowerCase() === 'momentum_fade' || String(trade.exit_reason || '').toLowerCase().includes('momentum')) {
      if (elapsedMs >= minMomentumFadeDurationMs && best >= minMomentumFadeMfe && closePnl > 0 && closePnl < best - 0.03) {
        exitBar = bar;
        exitReasonCode = 'momentum_fade';
        exitSource = 'paper_quality_v2';
        break;
      }
    }
  }

  const exitPrice = num(exitBar.close, trade.exit_price || trade.entry_price);
  const pnl = round(calcPnlPct(trade, exitPrice), 4);
  const durationMs = Math.max(0, ts(exitBar.timestamp) - ts(trade.opened_at));
  return cleanValue({
    ...trade,
    profile: 'paper_quality_v2',
    exit_reason_code: exitReasonCode,
    exit_source: exitSource,
    exit_price: round(exitPrice),
    pnl_pct: pnl,
    result: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'timeout',
    duration_ms: durationMs,
    duration_label: durationLabel(Math.round(durationMs / 1000)),
    max_favorable_pct: trade.max_favorable_pct,
    max_adverse_pct: trade.max_adverse_pct,
    original_stop_pct: originalStop,
    original_target_pct: originalTarget,
    effective_stop_pct: stopThreshold,
    trailing_stop_pct: trailingDistance,
    break_even_activated: best >= breakEvenThreshold,
    break_even_threshold_pct: breakEvenThreshold,
    exit_engine_enabled: true,
    data_status: 'ok',
  });
}

function buildExitProfileComparison(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const limit = Math.max(1, Math.min(200, Number(options.limit || 131) || 131));
  const paperTrades = readJsonl(files.trades)
    .map(normalizeTradeForReplay)
    .filter((trade) => String(trade.result || '').toUpperCase() !== 'OPEN')
    .slice(0, limit);
  const actual = paperTrades.map((trade) => ({
    trade_id: trade.trade_id,
    symbol: trade.symbol,
    result: normalizeResult(trade.result, trade.pnl_pct, trade.exit_reason),
    pnl_pct: trade.pnl_pct,
    duration_ms: (Number(trade.duration_seconds) || 0) * 1000,
    exit_reason_code: trade.exit_reason || trade.exitReasonCode || 'unknown',
    exit_source: trade.exit_source || trade.exitSource || 'unknown',
    max_favorable_pct: trade.max_favorable_pct,
    max_adverse_pct: trade.max_adverse_pct,
  }));
  const baseline = summarizeExitRows(actual);
  const profiles = [];

  const pushProfile = (row) => {
    profiles.push(cleanValue(row));
  };

  const v2Rows = paperTrades.map((trade) => simulateAdaptiveProfileTrade(trade, PROFILE_SPECS.paper_quality_v2));
  const v2Ok = v2Rows.filter((row) => row.data_status === 'ok');
  const v2Summary = summarizeProfileTradeRows(v2Ok, {
    kind: 'adaptive',
    description: PROFILE_SPECS.paper_quality_v2.description,
    recommendation_hint: PROFILE_SPECS.paper_quality_v2.recommendationHint,
    trailing_distance_pct: PROFILE_SPECS.paper_quality_v2.trailingDistancePct,
    break_even_after_profit_pct: PROFILE_SPECS.paper_quality_v2.breakEvenAfterProfitPct,
    momentum_fade_min_duration_ms: PROFILE_SPECS.paper_quality_v2.momentumFadeMinDurationMs,
    momentum_fade_min_profit_pct: PROFILE_SPECS.paper_quality_v2.momentumFadeMinProfitPct,
    momentum_fade_min_mfe_pct: PROFILE_SPECS.paper_quality_v2.momentumFadeMinMfePct,
    exit_formula: PROFILE_SPECS.paper_quality_v2.description,
  });
  pushProfile({
    id: PROFILE_SPECS.paper_quality_v2.id,
    label: PROFILE_SPECS.paper_quality_v2.label,
    description: PROFILE_SPECS.paper_quality_v2.description,
    recommendation: classifyRecommendation({
      ...v2Summary,
      kind: 'adaptive',
      total_trades_reduced: false,
    }, baseline),
    baseline: true,
    ...v2Summary,
    delta_vs_baseline: {
      median_duration_ms: v2Summary.median_duration_ms - baseline.median_duration_ms,
      median_pnl_pct: round(v2Summary.median_pnl_pct - baseline.median_pnl_pct, 4),
      avg_pnl_pct: round(v2Summary.avg_pnl_pct - baseline.avg_pnl_pct, 4),
      winrate: round(v2Summary.winrate - baseline.winrate, 2),
      trades: v2Summary.simulated_trades - baseline.trades,
    },
  });

  const softRows = paperTrades.map((trade) => simulateAdaptiveProfileTrade(trade, PROFILE_SPECS.paper_quality_v3_soft));
  const softOk = softRows.filter((row) => row.data_status === 'ok');
  const softSummary = summarizeProfileTradeRows(softOk, {
    kind: 'adaptive',
    description: PROFILE_SPECS.paper_quality_v3_soft.description,
    recommendation_hint: PROFILE_SPECS.paper_quality_v3_soft.recommendationHint,
    trailing_distance_pct: PROFILE_SPECS.paper_quality_v3_soft.trailingDistancePct,
    break_even_after_profit_pct: PROFILE_SPECS.paper_quality_v3_soft.breakEvenAfterProfitPct,
    momentum_fade_min_duration_ms: PROFILE_SPECS.paper_quality_v3_soft.momentumFadeMinDurationMs,
    momentum_fade_min_profit_pct: PROFILE_SPECS.paper_quality_v3_soft.momentumFadeMinProfitPct,
    momentum_fade_min_mfe_pct: PROFILE_SPECS.paper_quality_v3_soft.momentumFadeMinMfePct,
    exit_formula: `trailing=${PROFILE_SPECS.paper_quality_v3_soft.trailingDistancePct}%, break-even>=${PROFILE_SPECS.paper_quality_v3_soft.breakEvenAfterProfitPct}%, fade only after ${Math.round(PROFILE_SPECS.paper_quality_v3_soft.momentumFadeMinDurationMs / 60000)}m and >${PROFILE_SPECS.paper_quality_v3_soft.momentumFadeMinProfitPct}% PnL.`,
  });
  pushProfile({
    id: PROFILE_SPECS.paper_quality_v3_soft.id,
    label: PROFILE_SPECS.paper_quality_v3_soft.label,
    description: PROFILE_SPECS.paper_quality_v3_soft.description,
    recommendation: classifyRecommendation({
      ...softSummary,
      kind: 'adaptive',
      total_trades_reduced: false,
    }, baseline),
    ...softSummary,
    delta_vs_baseline: {
      median_duration_ms: softSummary.median_duration_ms - baseline.median_duration_ms,
      median_pnl_pct: round(softSummary.median_pnl_pct - baseline.median_pnl_pct, 4),
      avg_pnl_pct: round(softSummary.avg_pnl_pct - baseline.avg_pnl_pct, 4),
      winrate: round(softSummary.winrate - baseline.winrate, 2),
      trades: softSummary.simulated_trades - baseline.trades,
    },
  });

  const wideRows = paperTrades.map((trade) => simulateAdaptiveProfileTrade(trade, PROFILE_SPECS.paper_quality_v3_wide));
  const wideOk = wideRows.filter((row) => row.data_status === 'ok');
  const wideSummary = summarizeProfileTradeRows(wideOk, {
    kind: 'adaptive',
    description: PROFILE_SPECS.paper_quality_v3_wide.description,
    recommendation_hint: PROFILE_SPECS.paper_quality_v3_wide.recommendationHint,
    trailing_distance_pct: PROFILE_SPECS.paper_quality_v3_wide.trailingDistancePct,
    break_even_after_profit_pct: PROFILE_SPECS.paper_quality_v3_wide.breakEvenAfterProfitPct,
    momentum_fade_min_duration_ms: PROFILE_SPECS.paper_quality_v3_wide.momentumFadeMinDurationMs,
    momentum_fade_min_profit_pct: PROFILE_SPECS.paper_quality_v3_wide.momentumFadeMinProfitPct,
    momentum_fade_min_mfe_pct: PROFILE_SPECS.paper_quality_v3_wide.momentumFadeMinMfePct,
    exit_formula: `trailing=${PROFILE_SPECS.paper_quality_v3_wide.trailingDistancePct}%, break-even>=${PROFILE_SPECS.paper_quality_v3_wide.breakEvenAfterProfitPct}%, fade only after ${Math.round(PROFILE_SPECS.paper_quality_v3_wide.momentumFadeMinDurationMs / 60000)}m and >${PROFILE_SPECS.paper_quality_v3_wide.momentumFadeMinProfitPct}% PnL.`,
  });
  pushProfile({
    id: PROFILE_SPECS.paper_quality_v3_wide.id,
    label: PROFILE_SPECS.paper_quality_v3_wide.label,
    description: PROFILE_SPECS.paper_quality_v3_wide.description,
    recommendation: classifyRecommendation({
      ...wideSummary,
      kind: 'adaptive',
      total_trades_reduced: false,
    }, baseline),
    ...wideSummary,
    delta_vs_baseline: {
      median_duration_ms: wideSummary.median_duration_ms - baseline.median_duration_ms,
      median_pnl_pct: round(wideSummary.median_pnl_pct - baseline.median_pnl_pct, 4),
      avg_pnl_pct: round(wideSummary.avg_pnl_pct - baseline.avg_pnl_pct, 4),
      winrate: round(wideSummary.winrate - baseline.winrate, 2),
      trades: wideSummary.simulated_trades - baseline.trades,
    },
  });

  const entryFilterRows = paperTrades.map((trade) => simulateEntryFilterProfileTrade(trade));
  const entryFilterKept = entryFilterRows.filter((row) => row.wouldSkip !== true);
  const entryFilterSkipped = entryFilterRows.filter((row) => row.wouldSkip === true);
  const entryFilterSummary = summarizeProfileTradeRows(entryFilterKept, {
    kind: 'entry_filter',
    description: PROFILE_SPECS.paper_quality_v3_entry_filter.description,
    recommendation_hint: PROFILE_SPECS.paper_quality_v3_entry_filter.recommendationHint,
    entry_filter_rule: 'statusAtEntry=caution + setup=REGULAR_PULLBACK => wouldSkip/wouldRequire2mConfirmation',
    trades_considered: entryFilterRows.length,
    trades_skipped: entryFilterSkipped.length,
  });
  pushProfile({
    id: PROFILE_SPECS.paper_quality_v3_entry_filter.id,
    label: PROFILE_SPECS.paper_quality_v3_entry_filter.label,
    description: PROFILE_SPECS.paper_quality_v3_entry_filter.description,
    recommendation: classifyRecommendation({
      ...entryFilterSummary,
      trades_skipped: entryFilterSkipped.length,
      total_trades_reduced: entryFilterSkipped.length > 0,
    }, baseline),
    ...entryFilterSummary,
    delta_vs_baseline: {
      median_duration_ms: entryFilterSummary.median_duration_ms - baseline.median_duration_ms,
      median_pnl_pct: round(entryFilterSummary.median_pnl_pct - baseline.median_pnl_pct, 4),
      avg_pnl_pct: round(entryFilterSummary.avg_pnl_pct - baseline.avg_pnl_pct, 4),
      winrate: round(entryFilterSummary.winrate - baseline.winrate, 2),
      trades: entryFilterSummary.simulated_trades - baseline.trades,
    },
  });

  const volatilityRows = paperTrades.map((trade) => buildVolatilityProfileTrade(trade));
  const volatilityOk = volatilityRows.filter((row) => row.data_status === 'ok');
  const volatilityDegradedRows = volatilityRows.filter((row) => row.data_status !== 'ok');
  const volatilitySummary = summarizeProfileTradeRows(volatilityOk, {
    kind: 'volatility',
    description: PROFILE_SPECS.paper_quality_v3_volatility.description,
    recommendation_hint: PROFILE_SPECS.paper_quality_v3_volatility.recommendationHint,
    volatility_formula: 'trailingDistancePct = clamp(0.12 + volatilityProxyPct * 0.9, 0.12, 0.40) where volatilityProxyPct = median((high-low)/close*100) over 2m bars.',
    trailing_distance_pct: volatilityOk.length ? round(median(volatilityOk.map((row) => row.trailing_stop_pct || 0.12)), 4) : null,
    break_even_after_profit_pct: PROFILE_SPECS.paper_quality_v3_volatility.breakEvenAfterProfitPct,
    momentum_fade_min_duration_ms: PROFILE_SPECS.paper_quality_v3_volatility.momentumFadeMinDurationMs,
    momentum_fade_min_profit_pct: PROFILE_SPECS.paper_quality_v3_volatility.momentumFadeMinProfitPct,
    momentum_fade_min_mfe_pct: PROFILE_SPECS.paper_quality_v3_volatility.momentumFadeMinMfePct,
    degraded: volatilityDegradedRows.length > 0 || volatilityOk.length === 0,
    degraded_reason: volatilityDegradedRows.length > 0 ? 'missing_2m_bars_or_proxy' : null,
  });
  pushProfile({
    id: PROFILE_SPECS.paper_quality_v3_volatility.id,
    label: PROFILE_SPECS.paper_quality_v3_volatility.label,
    description: PROFILE_SPECS.paper_quality_v3_volatility.description,
    recommendation: classifyRecommendation({
      ...volatilitySummary,
      kind: 'volatility',
      total_trades_reduced: false,
    }, baseline),
    ...volatilitySummary,
    delta_vs_baseline: {
      median_duration_ms: volatilitySummary.median_duration_ms - baseline.median_duration_ms,
      median_pnl_pct: round(volatilitySummary.median_pnl_pct - baseline.median_pnl_pct, 4),
      avg_pnl_pct: round(volatilitySummary.avg_pnl_pct - baseline.avg_pnl_pct, 4),
      winrate: round(volatilitySummary.winrate - baseline.winrate, 2),
      trades: volatilitySummary.simulated_trades - baseline.trades,
    },
    volatility_formula: 'trailingDistancePct = clamp(0.12 + volatilityProxyPct * 0.9, 0.12, 0.40) where volatilityProxyPct = median((high-low)/close*100) over 2m bars.',
  });

  const exitReasonDelta = {
    baseline: countsBy(actual, 'exit_reason_code'),
  };
  for (const profile of profiles) {
    exitReasonDelta[profile.id] = profile.exit_reason_counts || {};
  }

  const profileMap = Object.fromEntries(profiles.map((profile) => [profile.id, profile]));
  const comparison_note = 'Read-only replay. Baseline är observerade closed paper trades; profilerna är simulerade på samma data eller på reducerat urval när entry-filter används.';

  return cleanValue({
    ok: true,
    profile: 'comparison',
    sample_size: paperTrades.length,
    replay_sample_size: paperTrades.length,
    replay_trade_instances: profiles.reduce((sum, row) => sum + (Number(row.simulated_trades || 0) || 0), 0),
    profile_count: profiles.length,
    baseline,
    profiles,
    profile_map: profileMap,
    exit_reason_delta: exitReasonDelta,
    comparison_note,
    ...profileMap,
    ...SAFETY,
  });
}

async function buildMemoryContext(trade) {
  const parts = {
    result_memory: {},
    setup_performance: {},
    strategy_performance: {},
    batch_result: {},
    ai_optimization: {},
    learning_text: '',
  };
  try {
    parts.result_memory = await tradingAgentsResultMemory.buildResultMemorySummary(trade.symbol);
  } catch (_) {}
  try {
    parts.setup_performance = await setupPerformance.getSetupById(trade.setup_id);
  } catch (_) {}
  try {
    parts.strategy_performance = strategyPerformance.getSignalPerformanceBadge(trade.strategy_id);
  } catch (_) {}
  try {
    parts.batch_result = strategyBatchTest.getLatestBatchComparison();
  } catch (_) {}
  try {
    parts.ai_optimization = aiOptimizationAgent.getRecommendedConfig();
  } catch (_) {}

  const memoryWinRate = trade.aiAgentAnalysis?.memory_summary?.win_rate
    ?? parts.result_memory?.stats?.accuracy_pct
    ?? parts.setup_performance?.win_rate
    ?? parts.strategy_performance?.win_rate;
  if (memoryWinRate !== '' && memoryWinRate != null) {
    parts.learning_text = `Denna trade liknar ett mönster som historiskt har ${round(memoryWinRate, 1)}% vinstprocent.`;
  } else {
    parts.learning_text = 'Systemet behöver mer historik för detta mönster.';
  }
  return cleanValue(parts);
}

function buildLearned(trade, missed, memoryContext) {
  const learned = [];
  learned.push(memoryContext.learning_text);
  if (missed.missed) learned.push('Exit bör jämföras mot längre holding innan regler ändras.');
  if (String(trade.exit_reason).toUpperCase().includes('STOP')) learned.push('Stop loss bör följas upp mot medium/wide stop.');
  if (trade.result === 'win') learned.push('Setupen fungerade i denna paper trade.');
  if (trade.result === 'loss') learned.push('Setupen behöver mer försiktighet i liknande läge.');
  if (trade.result === 'timeout') learned.push('Timeout-risk bör följas upp för detta setup.');
  return [...new Set(learned)];
}

async function buildTradeReplay(tradeId) {
  const trade = findTrade(tradeId);
  if (!trade) return cleanValue({ ok: false, error: 'trade_not_found', trade_id: String(tradeId || ''), ...SAFETY });

  const entry = explainTradeEntry(trade);
  const exit = explainTradeExit(trade);
  const timeline = getTradeTimeline(trade);
  const alternatives = compareAlternativeExits(trade);
  const missed = calculateMissedOpportunity(trade);
  const memory = await buildMemoryContext(trade);
  const replay = {
    ok: true,
    trade: cleanValue({
      trade_id: trade.trade_id,
      symbol: trade.symbol,
      strategy_id: trade.strategy_id,
      setup_id: trade.setup_id,
      opened_at: trade.opened_at,
      closed_at: trade.closed_at || 'öppen',
      duration_label: trade.duration_label,
      entry_price: trade.entry_price,
      exit_price: trade.exit_price,
      pnl_pct: trade.pnl_pct,
      result: trade.result,
      exit_reason: trade.exit_reason,
      exit_source: trade.exit_source,
      stop_loss: trade.stop_loss,
      take_profit: trade.take_profit,
      holding_time: trade.holding_time,
      confidence: trade.confidence,
      signal_score: trade.signal_score,
      priority_score: trade.priority_score,
      market_regime: trade.market_regime,
      market_bias: trade.market_bias,
    }),
    entry_explanation: entry,
    exit_explanation: exit,
    timeline: timeline.timeline,
    alternative_exits: alternatives.alternatives,
    missed_opportunity: missed,
    result_memory: memory,
    learned: buildLearned(trade, missed, memory),
    summary: {
      what_happened: `${trade.symbol} öppnades ${trade.opened_at} och stängdes ${trade.closed_at || 'inte ännu'} med ${trade.pnl_pct >= 0 ? 'vinst' : 'förlust'} ${trade.pnl_pct >= 0 ? '+' : ''}${round(trade.pnl_pct, 2)}%.`,
      entry: entry.summary,
      exit: exit.summary,
      better: missed.message,
    },
    ...SAFETY,
  };
  return cleanValue(replay);
}

async function buildTradeReplaySummary(tradeId) {
  const replay = await buildTradeReplay(tradeId);
  if (!replay.ok) return replay;
  return cleanValue({
    ok: true,
    trade_id: replay.trade.trade_id,
    symbol: replay.trade.symbol,
    result: replay.trade.result,
    pnl_pct: replay.trade.pnl_pct,
    summary: replay.summary,
    learned: replay.learned,
    safety: SAFETY,
    ...SAFETY,
  });
}

async function getRecentTradeReplays(filters = {}) {
  const limit = Math.max(1, Math.min(100, Number(filters.limit || filters.n || 20) || 20));
  const symbol = filters.symbol ? String(filters.symbol).toUpperCase() : '';
  const rows = allTrades()
    .filter((trade) => !symbol || trade.symbol === symbol)
    .sort((a, b) => ts(b.closed_at || b.opened_at) - ts(a.closed_at || a.opened_at))
    .slice(0, limit)
    .map((trade) => ({
      trade_id: trade.trade_id,
      symbol: trade.symbol,
      opened_at: trade.opened_at,
      closed_at: trade.closed_at || 'öppen',
      duration_label: trade.duration_label,
      result: trade.result,
      pnl_pct: trade.pnl_pct,
      exit_reason: trade.exit_reason,
      strategy_id: trade.strategy_id,
      setup_id: trade.setup_id,
      summary: `${trade.symbol} ${trade.result} ${trade.pnl_pct >= 0 ? '+' : ''}${round(trade.pnl_pct, 2)}%`,
    }));
  return cleanValue({ ok: true, replays: rows, count: rows.length, ...SAFETY });
}

module.exports = {
  SAFETY,
  buildTradeReplay,
  getTradeTimeline,
  explainTradeEntry,
  explainTradeExit,
  compareAlternativeExits,
  calculateMissedOpportunity,
  buildExitProfileComparison,
  simulatePaperQualityV2Trade,
  buildTradeReplaySummary,
  getRecentTradeReplays,
};
