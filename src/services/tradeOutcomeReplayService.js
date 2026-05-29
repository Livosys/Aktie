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
  buildTradeReplaySummary,
  getRecentTradeReplays,
};
