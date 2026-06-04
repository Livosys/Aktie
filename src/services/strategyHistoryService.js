'use strict';

const fs = require('fs');
const path = require('path');

const strategyRegistry = require('./strategyRegistryService');
const strategyScore = require('./strategyScoreService');
const eventLogService = require('./eventLogService');
const paperTrading = require('../paperTrading/paperTradingAgent');

const DEFAULT_LEARNING_EVENTS_FILE = path.resolve(__dirname, '../../data/learning-connector/events.jsonl');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mode: 'paper_only',
});

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function readJsonl(file) {
  try {
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
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

function strategyKey(row = {}) {
  return safeString(
    row.strategy_id ||
    row.strategyId ||
    row.strategy ||
    row.strategy_name ||
    row.strategyName ||
    row.resolvedStrategyId ||
    row.sourceStrategyId,
  );
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function maxIso(...values) {
  const times = values
    .map((value) => isoOrNull(value))
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function normalizeSource(value) {
  const raw = safeString(value)?.toLowerCase();
  if (!raw) return 'unknown';
  if (['scanner', 'paper', 'replay', 'batch', 'learning', 'tradingview', 'agent', 'strategy_test', 'paper_trading', 'batch_test', 'performance'].includes(raw)) {
    return raw;
  }
  return raw;
}

function eventSummaryForPaperTrade(trade = {}) {
  const result = safeString(trade.result) || 'OPEN';
  const symbol = safeString(trade.symbol) || 'okänd symbol';
  const pnl = trade.pnlPct ?? trade.pnl_pct ?? trade.total_pnl ?? null;
  const pnlText = pnl == null ? '' : ` · PnL ${safeNumber(pnl, 0)}`;
  return `${symbol} · ${result}${pnlText}`;
}

function eventSummaryForLearningEvent(event = {}) {
  const source = normalizeSource(event.source);
  if (source === 'batch') {
    const rec = safeString(event.extra?.recommendation) || 'keep';
    const tests = safeNumber(event.extra?.total_tests, null);
    return `Batch: ${rec}${tests != null ? ` · ${tests} tests` : ''}`;
  }
  if (source === 'replay') {
    const trades = safeNumber(event.extra?.total_trades, null);
    const winRate = safeNumber(event.extra?.win_rate, null);
    return `Replay${trades != null ? ` · ${trades} trades` : ''}${winRate != null ? ` · WR ${winRate}%` : ''}`;
  }
  if (source === 'paper') {
    const outcome = safeString(event.result?.outcome) || 'unknown';
    return `Paper learning · ${outcome}`;
  }
  if (source === 'scanner') {
    return `Scanner learning · ${safeString(event.signal_type) || safeString(event.raw_signal) || 'signal'}`;
  }
  if (source === 'agent') {
    return `Agent finding${event.extra?.recommendation ? ` · ${event.extra.recommendation}` : ''}`;
  }
  return `${source} event`;
}

function eventSummaryForAudit(event = {}) {
  const type = safeString(event.event_type) || 'event';
  const reason = safeString(event.reason) || safeString(event.decision) || '';
  const symbol = safeString(event.symbol) || '';
  const pieces = [type];
  if (symbol) pieces.push(symbol);
  if (reason) pieces.push(reason);
  return pieces.join(' · ');
}

function eventSummaryForPerformance(result = {}) {
  const source = safeString(result.source) || 'test';
  const trades = safeNumber(result.trades, 0) || 0;
  const winRate = safeNumber(result.win_rate, null);
  const avgPnl = safeNumber(result.avg_pnl, null);
  const pieces = [source];
  if (trades) pieces.push(`${trades} trades`);
  if (winRate != null) pieces.push(`WR ${winRate}%`);
  if (avgPnl != null) pieces.push(`avg PnL ${avgPnl}`);
  return pieces.join(' · ');
}

function normalizedRecentEvent(event, sourceHint = null) {
  const timestamp = isoOrNull(event.timestamp || event.received_at || event.created_at || event.test_completed_at || event.closed_at || event.updated_at || event.entryTime || event.opened_at);
  const source = normalizeSource(sourceHint || event.source || event.event_source);
  const eventType = safeString(event.event_type || event.type || event.eventType || event.result || event.decision || source) || source;
  const symbol = safeString(event.symbol || event.traded_symbol || event.strategy_symbol || event.best_symbol || event.underlying_symbol);
  const timeframe = safeString(event.timeframe || event.tf || null);
  const score = event.score != null ? safeNumber(event.score, null) : safeNumber(event.win_rate, null);
  const summary = safeString(
    event.summary ||
    event.message ||
    event.reason ||
    event.note ||
    event.description ||
    eventSummaryForAudit(event),
  ) || eventSummaryForAudit(event);
  return {
    timestamp,
    source,
    event_type: eventType,
    symbol,
    timeframe,
    score,
    summary,
    details: event.details || event.extra || null,
  };
}

function buildNotes({ registry, scoreRow, learningEvents, performanceDetails, paperTradesCount, summary }) {
  const notes = [];
  const badgeMessage = performanceDetails?.performance?.performance_badge?.label;
  const badgeTone = performanceDetails?.performance?.performance_badge?.tone;
  if (badgeMessage) notes.push(`Historik: ${badgeMessage}${badgeTone ? ` (${badgeTone})` : ''}.`);
  if (registry?.disabled_reason) notes.push(`Registry: ${registry.disabled_reason}.`);
  if (summary?.missing_data?.paper_trades) notes.push('Ingen paper-historik ännu.');
  if (summary?.missing_data?.replay_tests) notes.push('Ingen replay-historik ännu.');
  if (summary?.missing_data?.batch_tests) notes.push('Ingen batch-historik ännu.');
  if (safeArray(scoreRow?.weaknesses).length) {
    for (const weakness of scoreRow.weaknesses.slice(0, 2)) {
      notes.push(`Score-svaghet: ${weakness}`);
    }
  }
  if (safeArray(registry?.known_weaknesses).length) {
    for (const weakness of registry.known_weaknesses.slice(0, 2)) {
      notes.push(`Känd svaghet: ${weakness}`);
    }
  }
  if (safeArray(registry?.recommended_tests).length) {
    for (const test of registry.recommended_tests.slice(0, 2)) {
      notes.push(`Rekommenderat test: ${test}`);
    }
  }
  if (learningEvents.length > 0) {
    const batchRec = learningEvents.find((event) => normalizeSource(event.source) === 'batch' && event.extra?.recommendation);
    if (batchRec) notes.push(`Batchrekommendation: ${batchRec.extra.recommendation}.`);
  }
  if (paperTradesCount > 0 && !summary?.replay_tests_count) {
    notes.push('Det finns paper trades, men replay-underlag saknas fortfarande.');
  }
  return [...new Set(notes)].filter(Boolean).slice(0, 5);
}

function buildRecommendedNextSteps({ registry, scoreRow, summary, performanceDetails }) {
  const steps = [];
  const status = safeString(registry?.status) || 'paper_only';
  const sampleSize = safeNumber(scoreRow?.sample_size, 0) || 0;
  const confidence = safeNumber(scoreRow?.confidence, 0) || 0;
  const paper = safeNumber(summary?.paper_trades_count, 0) || 0;
  const replay = safeNumber(summary?.replay_tests_count, 0) || 0;
  const batch = safeNumber(summary?.batch_tests_count, 0) || 0;
  if (status === 'paused' || status === 'deprecated') {
    steps.push('Strategin är pausad/deprecated. Kör inga nya paper entries.');
  } else if (sampleSize === 0) {
    steps.push('Kör replay och batch-test för att få första underlaget.');
  } else if (paper === 0) {
    steps.push('Kör paper-test för att samla faktisk tradinghistorik.');
  } else if (replay === 0) {
    steps.push('Kör replay för att jämföra mot historisk data.');
  } else if (batch === 0) {
    steps.push('Kör batch-test för att jämföra parametrar och marknadslägen.');
  } else if (confidence < 50) {
    steps.push('Fortsätt paper/replay och samla mer säker data innan nästa steg.');
  } else {
    steps.push('Fortsätt övervaka i paper/replay och jämför mot närliggande strategier.');
  }

  if (performanceDetails?.performance?.performance_badge?.label) {
    steps.push(performanceDetails.performance.performance_badge.label);
  }

  return [...new Set(steps)].slice(0, 5);
}

function loadLearningConnectorEvents(filePath) {
  return readJsonl(filePath || DEFAULT_LEARNING_EVENTS_FILE);
}

function createStrategyHistoryService(options = {}) {
  const registryService = options.registryService || strategyRegistry;
  const scoreService = options.scoreService || strategyScore.defaultStrategyScoreService;
  const eventLog = options.eventLogService || eventLogService;
  const paperTradingService = options.paperTradingService || paperTrading;
  const performanceService = options.performanceService || require('./strategyPerformanceService');
  const learningEventsLoader = typeof options.learningEventsLoader === 'function'
    ? options.learningEventsLoader
    : () => loadLearningConnectorEvents(options.learningEventsFile || DEFAULT_LEARNING_EVENTS_FILE);
  const recentEventLimit = Number.isFinite(Number(options.recentEventLimit)) ? Number(options.recentEventLimit) : 500;

  function getRegistryStrategy(strategyId) {
    if (typeof registryService.getStrategy === 'function') {
      const strategy = registryService.getStrategy(strategyId);
      if (strategy) return strategy;
    }
    if (typeof registryService.listStrategies === 'function') {
      return (registryService.listStrategies() || []).find((strategy) => strategy.strategy_id === strategyId || strategy.strategyId === strategyId) || null;
    }
    return null;
  }

  function loadScore(strategyId) {
    if (typeof scoreService.getStrategyScore !== 'function') {
      return { strategy_id: strategyId, score: null, confidence: null, sample_size: 0, strengths: [], weaknesses: [], recommended_action: null };
    }
    const scored = scoreService.getStrategyScore(strategyId);
    return scored?.ok ? (scored.strategy || null) : null;
  }

  function loadPerformance(strategyId) {
    if (!performanceService || typeof performanceService.getStrategyDetails !== 'function') return null;
    const details = performanceService.getStrategyDetails(strategyId);
    return details?.ok ? details : null;
  }

  function loadPaperTrades(strategyId) {
    const trades = paperTradingService?.getTrades?.().trades || [];
    return trades.filter((trade) => strategyKey(trade) === strategyId);
  }

  function loadEventLog(strategyId) {
    const recent = eventLog?.readRecentEvents?.(recentEventLimit)?.events || [];
    return recent.filter((event) => strategyKey(event) === strategyId);
  }

  function loadLearningEvents(strategyId) {
    return learningEventsLoader().filter((event) => strategyKey(event) === strategyId);
  }

  function buildSummary({ paperTrades, performanceDetails, learningEvents, recentEvents }) {
    const performanceResults = performanceDetails?.results || [];
    const paperClosedTrades = paperTrades.filter((trade) => trade.result && trade.result !== 'OPEN');
    const replayResults = performanceResults.filter((row) => normalizeSource(row.source) === 'replay');
    const batchResults = performanceResults.filter((row) => normalizeSource(row.source) === 'batch');
    const learningReplayEvents = learningEvents.filter((row) => normalizeSource(row.source) === 'replay');
    const learningBatchEvents = learningEvents.filter((row) => normalizeSource(row.source) === 'batch');
    const signalEvents = [...recentEvents, ...learningEvents]
      .filter((row) => ['scanner', 'paper', 'tradingview'].includes(normalizeSource(row.source)) || String(row.event_type || '').includes('signal'));

    const lastPaperTradeAt = maxIso(...paperClosedTrades.map((trade) => trade.closed_at || trade.last_update_at || trade.entryTime || trade.opened_at || null));
    const lastReplayAt = maxIso(
      ...replayResults.map((row) => row.test_completed_at || row.completed_at || row.created_at || null),
      ...learningReplayEvents.map((row) => row.timestamp || row.received_at || null),
    );
    const lastBatchAt = maxIso(
      ...batchResults.map((row) => row.test_completed_at || row.completed_at || row.created_at || null),
      ...learningBatchEvents.map((row) => row.timestamp || row.received_at || null),
    );
    const lastLearningEventAt = maxIso(...learningEvents.map((row) => row.timestamp || row.received_at || null));
    const lastSignalAt = maxIso(
      ...signalEvents.map((row) => row.timestamp || row.received_at || null),
      ...recentEvents
        .filter((row) => ['signal.detected', 'strategy.matched', 'paper_trade.opened', 'paper_trade.closed', 'paper_trade.skipped'].includes(String(row.event_type || '').toLowerCase()))
        .map((row) => row.timestamp || row.received_at || null),
    );
    const lastTestAt = maxIso(lastPaperTradeAt, lastReplayAt, lastBatchAt, lastLearningEventAt);

    return {
      paper_trades_count: paperClosedTrades.length,
      replay_tests_count: Math.max(replayResults.length, learningReplayEvents.length),
      batch_tests_count: Math.max(batchResults.length, learningBatchEvents.length),
      learning_events_count: learningEvents.length,
      last_signal_at: lastSignalAt,
      last_paper_trade_at: lastPaperTradeAt,
      last_replay_at: lastReplayAt,
      last_batch_at: lastBatchAt,
      last_learning_event_at: lastLearningEventAt,
      last_test_at: lastTestAt,
      missing_data: {
        paper_trades: paperClosedTrades.length === 0,
        replay_tests: (replayResults.length + learningReplayEvents.length) === 0,
        batch_tests: (batchResults.length + learningBatchEvents.length) === 0,
        learning_events: learningEvents.length === 0,
        recent_events: recentEvents.length === 0,
      },
    };
  }

  function collectRecentEvents({ paperTrades, performanceDetails, learningEvents, eventLogRows }) {
    const recent = [];
    for (const trade of paperTrades) {
      recent.push(normalizedRecentEvent({
        timestamp: trade.closed_at || trade.last_update_at || trade.entryTime || trade.opened_at,
        source: 'paper',
        event_type: trade.result && trade.result !== 'OPEN' ? 'paper_trade.closed' : 'paper_trade.opened',
        symbol: trade.symbol || trade.traded_symbol || null,
        timeframe: trade.timeframe || null,
        score: trade.pnlPct ?? trade.pnl_pct ?? null,
        summary: eventSummaryForPaperTrade(trade),
        details: {
          result: trade.result || null,
          pnl_pct: trade.pnlPct ?? trade.pnl_pct ?? null,
          opened_at: trade.opened_at || trade.entryTime || null,
          closed_at: trade.closed_at || null,
        },
      }, 'paper'));
    }

    for (const result of (performanceDetails?.results || [])) {
      recent.push(normalizedRecentEvent({
        timestamp: result.test_completed_at || result.completed_at || result.created_at || null,
        source: result.source || 'performance',
        event_type: 'strategy_test_result',
        symbol: result.traded_symbol || result.best_symbol || result.symbols?.[0] || null,
        timeframe: result.timeframe || null,
        score: result.score ?? null,
        summary: eventSummaryForPerformance(result),
        details: {
          trades: result.trades || 0,
          wins: result.wins || 0,
          losses: result.losses || 0,
          timeouts: result.timeouts || 0,
          win_rate: result.win_rate ?? null,
          avg_pnl: result.avg_pnl ?? null,
          total_pnl: result.total_pnl ?? null,
          source: result.source || null,
        },
      }, result.source || 'performance'));
    }

    for (const event of learningEvents) {
      recent.push(normalizedRecentEvent({
        timestamp: event.timestamp || event.received_at || null,
        source: `learning_${normalizeSource(event.source)}`,
        event_type: `learning.${normalizeSource(event.source)}`,
        symbol: event.symbol || event.extra?.affected_symbol || event.extra?.symbol || null,
        timeframe: event.timeframe || event.extra?.timeframe || null,
        score: event.confidence ?? event.score ?? null,
        summary: eventSummaryForLearningEvent(event),
        details: {
          recommendation: event.extra?.recommendation || null,
          total_tests: event.extra?.total_tests || null,
          session_id: event.extra?.session_id || null,
          batch_id: event.extra?.batch_id || null,
        },
      }, `learning_${normalizeSource(event.source)}`));
    }

    for (const event of eventLogRows) {
      recent.push(normalizedRecentEvent({
        timestamp: event.timestamp || event.received_at || null,
        source: event.source || 'event_log',
        event_type: event.event_type || event.type || 'event',
        symbol: event.symbol || null,
        timeframe: event.timeframe || null,
        score: event.score ?? null,
        summary: eventSummaryForAudit(event),
        details: event.details || event.metadata || null,
      }, event.source || 'event_log'));
    }

    const deduped = [];
    const seen = new Set();
    for (const row of recent) {
      const key = `${row.timestamp || ''}|${row.source || ''}|${row.event_type || ''}|${row.summary || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }

    return deduped
      .filter((row) => row.timestamp)
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, 5);
  }

  function getStrategyHistory(strategyId) {
    const id = safeString(strategyId);
    if (!id) return { ok: false, error: 'strategy_id_required', ...SAFETY };

    const registry = getRegistryStrategy(id);
    if (!registry) return { ok: false, error: 'unknown_strategy_id', ...SAFETY };

    const scoreRow = loadScore(id);
    const performanceDetails = loadPerformance(id);
    const paperTrades = loadPaperTrades(id);
    const eventLogRows = loadEventLog(id);
    const learningEvents = loadLearningEvents(id);
    const recentEvents = collectRecentEvents({ paperTrades, performanceDetails, learningEvents, eventLogRows });
    const summary = buildSummary({ paperTrades, performanceDetails, learningEvents, recentEvents });
    return {
      ok: true,
      strategy_id: id,
      registry: {
        source: registry.source || 'internal',
        status: registry.status || 'paper_only',
        enabled: registry.enabled !== false,
        mode: registry.mode || 'paper_only',
        last_signal_at: summary.last_signal_at,
        last_test_at: summary.last_test_at,
      },
      score: scoreRow ? {
        score: scoreRow.score ?? null,
        confidence: scoreRow.confidence ?? null,
        sample_size: scoreRow.sample_size ?? 0,
        strengths: safeArray(scoreRow.strengths),
        weaknesses: safeArray(scoreRow.weaknesses),
        recommended_action: scoreRow.recommended_action || null,
      } : {
        score: null,
        confidence: null,
        sample_size: 0,
        strengths: [],
        weaknesses: [],
        recommended_action: null,
      },
      history_summary: summary,
      recent_events: recentEvents,
      learning_notes: buildNotes({
        registry,
        scoreRow,
        learningEvents,
        performanceDetails,
        paperTradesCount: summary.paper_trades_count,
        summary,
      }),
      recommended_next_steps: buildRecommendedNextSteps({
        registry,
        scoreRow,
        summary,
        performanceDetails,
      }),
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    DEFAULT_LEARNING_EVENTS_FILE,
    getStrategyHistory,
  };
}

const defaultStrategyHistoryService = createStrategyHistoryService();

module.exports = {
  SAFETY,
  DEFAULT_LEARNING_EVENTS_FILE,
  createStrategyHistoryService,
  defaultStrategyHistoryService,
};
