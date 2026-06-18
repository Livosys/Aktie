'use strict';

/**
 * Read-only paper trade explanation service.
 *
 * It inspects the existing paper-trading archives and derives a compact
 * explanation for why a closed paper trade opened, why it closed, and which
 * nearby events appear related. The service never mutates data and never talks
 * to broker, live trading, risk, or order placement code.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_FILES = Object.freeze({
  trades: path.join(ROOT, 'data/paper-trading/trades.jsonl'),
  events: path.join(ROOT, 'data/paper-trading/events.jsonl'),
  state: path.join(ROOT, 'data/paper-trading/state.json'),
});

const MATCH_TOLERANCE_SECONDS = 15;
const entryQualityGateService = require('./entryQualityGateService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function clampLimit(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function text(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function iso(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
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

function normalizeStrategyId(row = {}) {
  return text(
    row.strategyId
    || row.strategy_id
    || row.canonicalStrategyId
    || row.canonical_strategy_id
    || row.resolvedStrategyId
    || row.resolved_strategy_id
    || row.resolvedStrategyId
    || row.sourceStrategyId
    || row.source_strategy_id
    || row.inputStrategyKey
    || row.input_strategy_key
    || row.raw_strategy
    || row.setup
    || row.signalSubtype
    || row.signalFamily
    || null,
  );
}

function normalizeSetup(row = {}) {
  return text(
    row.setup
    || row.entrySetup
    || row.entry_setup
    || row.signalSubtype
    || row.signalFamily
    || row.familyLabelSv
    || row.subtypeLabelSv
    || row.strategy
    || row.strategyName
    || row.strategy_name
    || null,
  );
}

function normalizeOpenedAt(row = {}) {
  return iso(row.openedAt || row.opened_at || row.entryTime || row.entry_time || row.timestamp || null);
}

function normalizeClosedAt(row = {}) {
  return iso(row.closedAt || row.closed_at || row.exitTime || row.exit_time || null);
}

function normalizeTradeTime(value) {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

function safeTradeKey(row = {}) {
  const tradeId = text(row.tradeId || row.id || row.signalId || null);
  if (tradeId) return tradeId;
  const symbol = text(row.symbol, 'unknown');
  const strategyId = normalizeStrategyId(row) || 'unknown';
  const openedAt = normalizeOpenedAt(row) || 'unknown';
  return `${symbol}:${strategyId}:${openedAt}`;
}

function normalizeTrade(row = {}) {
  const openedAt = normalizeOpenedAt(row);
  const closedAt = normalizeClosedAt(row);
  const tradeId = text(row.tradeId || row.id || row.signalId || null);
  const canonicalStrategyId = normalizeStrategyId(row);
  const setup = normalizeSetup(row);
  const mfePct = num(row.mfePct ?? row.maxFavorablePct ?? row.max_favorable_pct ?? null);
  const maePct = num(row.maePct ?? row.maxAdversePct ?? row.max_adverse_pct ?? null);
  return {
    tradeId,
    tradeKey: safeTradeKey(row),
    symbol: text(row.symbol, null),
    strategyId: canonicalStrategyId,
    setup,
    result: text(row.result || row.outcome || null, 'unknown'),
    pnlPct: num(row.pnlPct ?? row.pnl_pct ?? row.pnl),
    openedAt,
    closedAt,
    source: text(row.source || row.mode || null),
    tradeStats: {
      mfePct,
      maePct,
      highestPriceDuringTrade: num(row.highestPriceDuringTrade ?? row.highest_price_during_trade ?? null),
      lowestPriceDuringTrade: num(row.lowestPriceDuringTrade ?? row.lowest_price_during_trade ?? null),
      stopLoss: num(row.stopLoss ?? row.stop_loss ?? row.stopPct ?? row.stop_pct ?? null),
      takeProfit: num(row.takeProfit ?? row.take_profit ?? row.targetPct ?? row.target_pct ?? null),
    },
    paperOnly: row.paperOnly === true || row.paper_only === true,
    raw: row,
  };
}

function isClosedTrade(row = {}) {
  const result = String(row.result || row.outcome || '').trim().toUpperCase();
  return result !== 'OPEN' && (row.closed_at || row.closedAt || row.exitTime || row.exit_time || row.result || row.outcome);
}

function eventTime(row = {}) {
  return iso(row.timestamp || row.time || row.created_at || row.createdAt || row.closed_at || row.closedAt || row.entryTime || row.opened_at || row.openedAt || null);
}

function normalizeEvent(row = {}) {
  const timestamp = eventTime(row);
  return {
    eventId: text(row.eventId || row.event_id || null),
    timestamp,
    type: text(row.type || null, 'unknown'),
    symbol: text(row.symbol || null),
    strategyId: normalizeStrategyId(row),
    strategyName: text(row.strategyName || row.strategy_name || row.resolvedStrategyName || row.sourceStrategyName || null),
    decision: text(row.decision || null),
    reason: text(row.reasonSv || row.reason || row.message || null),
    status: text(row.status || null),
    nextMoveBias: text(row.nextMoveBias || row.bias || null),
    confidenceScore: num(row.confidenceScore),
    gateScore: num(row.gateScore),
    gateThreshold: num(row.gateThreshold),
    exitReasonCode: text(row.exitReasonCode || null),
    exitSource: text(row.exitSource || null),
    exitEngineDecision: row.exitEngineDecision || null,
    volumeState: text(row.volumeState || null),
    source: text(row.source || row.mode || null),
    raw: row,
  };
}

function windowMatch(eventTs, openedAt, closedAt) {
  const ts = new Date(eventTs || '').getTime();
  if (!Number.isFinite(ts)) return false;
  const anchorStart = new Date(openedAt || closedAt || '').getTime();
  const anchorEnd = new Date(closedAt || openedAt || '').getTime();
  if (!Number.isFinite(anchorStart) && !Number.isFinite(anchorEnd)) return false;
  const start = Number.isFinite(anchorStart) ? anchorStart - 10 * 60 * 1000 : anchorEnd - 10 * 60 * 1000;
  const end = Number.isFinite(anchorEnd) ? anchorEnd + 10 * 60 * 1000 : anchorStart + 10 * 60 * 1000;
  return ts >= start && ts <= end;
}

function sameIdentity(event, trade) {
  if (!event || !trade) return false;
  if (trade.tradeId && (event.tradeId === trade.tradeId || event.raw?.tradeId === trade.tradeId)) return true;
  if (trade.symbol && event.symbol && trade.symbol !== event.symbol) return false;
  if (trade.strategyId && event.strategyId && trade.strategyId !== event.strategyId) return false;
  return true;
}

function explainEntry(trade, matchedEvents) {
  const raw = trade.raw || {};
  const gateDecision = raw.gateDecision || null;
  const tradeEntryReason = text(raw.entryReason || raw.entryReasonSv || raw.entry_reason || raw.reasonSv || null);
  const eventOpened = matchedEvents.find((event) => event.type === 'TRADE_OPENED') || null;
  const reason = tradeEntryReason || eventOpened?.reason || gateDecision?.reasons?.[0] || gateDecision?.warnings?.[0] || null;
  const status = text(raw.statusAtEntry || raw.runtime_status || raw.runtimeStatus || gateDecision?.mode || null, 'unknown');
  const bias = text(raw.nextMoveBias || raw.bias || gateDecision?.signal?.nextMoveBias || null, 'unknown');
  const confidence = num(raw.confidenceScore ?? raw.gateScore ?? gateDecision?.signal?.confidenceScore);
  const gateStage = text(
    gateDecision?.gateMode
    || gateDecision?.mode
    || matchedEvents.find((event) => /GATE_/i.test(event.type))?.type
    || null,
    'unknown',
  );
  const setup = text(normalizeSetup(raw), 'unknown');
  const missing = [];
  if (!tradeEntryReason) missing.push('entryReason');
  if (!raw.entryReason && !raw.entryReasonSv) missing.push('entryReasonSv');
  if (!raw.statusAtEntry) missing.push('statusAtEntry');
  if (confidence === null) missing.push('confidenceScore');
  if (!raw.gateDecision) missing.push('gateDecision');
  return {
    reason: reason || 'unknown',
    status,
    bias,
    confidence,
    gateStage,
    setup,
    signalStrength: confidence ?? num(raw.gateScore) ?? null,
    explanation: tradeEntryReason
      ? `Traden öppnades eftersom ${tradeEntryReason}`
      : eventOpened?.reason
        ? `Traden öppnades enligt eventloggen: ${eventOpened.reason}`
        : gateDecision?.allowed === true
          ? 'Traden öppnades eftersom paper gate godkände signalen.'
          : 'Entry-förklaringen saknas i loggning. Den härleds endast från statusAtEntry, gateDecision och närliggande events.',
    missingFields: missing,
    recommendedLogging: missing.length
      ? ['entryReason', 'statusAtEntry', 'confidenceScore', 'gateDecision']
      : [],
  };
}

function exitTypeFromTrade(trade, matchedEvents) {
  const raw = trade.raw || {};
  const exitReason = text(raw.exitReason || raw.exitReasonCode || raw.exitSource || null, '');
  const eventClosed = matchedEvents.find((event) => event.type === 'TRADE_CLOSED') || null;
  const reason = `${exitReason} ${eventClosed?.reason || eventClosed?.reasonSv || ''}`.toUpperCase();
  if (/TIMEOUT/.test(reason)) return 'timeout';
  if (/TARGET|TAKE_PROFIT|TARGET_HIT/.test(reason)) return 'take_profit';
  if (/STOP|TRAILING_STOP|BREAK_EVEN|TIGHTENED_STOP|STOP_HIT/.test(reason)) return 'stop_loss';
  if (/REVERSAL|FADE|PULLBACK/.test(reason)) return 'reversal';
  if (trade.result === 'WIN' && trade.pnlPct != null && trade.pnlPct >= 0) return 'take_profit';
  if (trade.result === 'LOSS' && trade.pnlPct != null && trade.pnlPct < 0) return 'stop_loss';
  return 'unknown';
}

function explainExit(trade, matchedEvents) {
  const raw = trade.raw || {};
  const eventClosed = matchedEvents.find((event) => event.type === 'TRADE_CLOSED') || null;
  const exitReason = text(raw.exitReason || raw.exitReasonCode || eventClosed?.reason || eventClosed?.reasonSv || null, null);
  const exitType = exitTypeFromTrade(trade, matchedEvents);
  const exitSource = text(raw.exitSource || eventClosed?.exitSource || null, 'unknown');
  const missing = [];
  if (!raw.exitReason) missing.push('exitReason');
  if (!raw.exitReasonCode) missing.push('exitReasonCode');
  if (!raw.exitSource) missing.push('exitSource');

  let explanation = 'Exakt exitReason saknas i loggning.';
  if (exitReason) explanation = `Traden stängdes enligt ${exitReason}.`;
  else if (exitType === 'take_profit') explanation = 'Traden stängdes när priset nådde vinstmålet eller en target-nära exitregel.';
  else if (exitType === 'stop_loss') explanation = 'Traden stängdes när stoppnivån eller en stop-lik exitregel träffades.';
  else if (exitType === 'timeout') explanation = 'Traden stängdes när hålltiden gick ut.';
  else if (exitType === 'reversal') explanation = 'Traden stängdes när exitlogiken såg en reversering eller momentumförsvagning.';

  return {
    reason: exitReason || 'unknown',
    exitType,
    explanation,
    exitSource,
    missingFields: missing,
    recommendedLogging: missing.length
      ? ['exitReason', 'exitReasonCode', 'exitSource']
      : [],
  };
}

function buildNearbyEvents(trade, events) {
  const nearby = events
    .filter((event) => sameIdentity(event, trade))
    .filter((event) => windowMatch(event.timestamp, trade.openedAt, trade.closedAt))
    .map((event) => {
      const ts = new Date(event.timestamp || '').getTime();
      const opened = new Date(trade.openedAt || '').getTime();
      const offsetMinutes = Number.isFinite(ts) && Number.isFinite(opened) ? Math.round(((ts - opened) / 60000) * 10) / 10 : null;
      return {
        eventId: event.eventId || null,
        timestamp: event.timestamp,
        type: event.type,
        symbol: event.symbol,
        strategyId: event.strategyId,
        strategyName: event.strategyName,
        decision: event.decision || null,
        reason: event.reason || null,
        status: event.status || null,
        nextMoveBias: event.nextMoveBias || null,
        confidenceScore: event.confidenceScore,
        gateScore: event.gateScore,
        gateThreshold: event.gateThreshold,
        exitReasonCode: event.exitReasonCode,
        exitSource: event.exitSource,
        volumeState: event.volumeState,
        offsetMinutes,
        match: event.type === 'TRADE_OPENED' ? 'entry' : event.type === 'TRADE_CLOSED' ? 'exit' : 'context',
      };
    })
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  return nearby;
}

function buildDiagnosis(trade, entry, exit, nearbyEvents) {
  const raw = trade.raw || {};
  const result = String(trade.result || '').toUpperCase();
  const missing = new Set([...(entry.missingFields || []), ...(exit.missingFields || [])]);
  const stats = trade.tradeStats || {};
  const hasExitEngine = !!raw.exitEngineDecision;
  const summary = result === 'WIN'
    ? 'Closed trade ended with WIN.'
    : result === 'LOSS'
      ? 'Closed trade ended with LOSS.'
      : result === 'TIMEOUT'
        ? 'Closed trade ended by TIMEOUT.'
        : 'Closed trade outcome is not fully explained by the archived data.';
  let whyWinOrLoss = 'Resulten är härledd från resultatfältet och närliggande events.';
  if (result === 'WIN') {
    whyWinOrLoss = exit.exitType === 'take_profit'
      ? 'Traden blev WIN eftersom priset nådde target eller en target-nära exitregel.'
      : exit.exitType === 'reversal'
        ? 'Traden blev WIN trots exit via reverseringslogik, men det ser fortfarande ut som en positiv avslutning.'
        : 'Traden blev WIN eftersom nettorörelsen var positiv när den stängdes.';
  } else if (result === 'LOSS') {
    whyWinOrLoss = exit.exitType === 'stop_loss'
      ? 'Traden blev LOSS eftersom stoppnivån eller en stop-lik exitregel träffades.'
      : exit.exitType === 'timeout'
        ? 'Traden blev LOSS eftersom den stängdes utan tillräcklig positiv utveckling innan tidsgränsen.'
        : 'Traden blev LOSS eftersom nettorörelsen var negativ när den stängdes.';
  }
  const lesson = result === 'WIN'
    ? 'Mönstret visar att entry och följande prisrörelse räckte för att nå vinstutfall.'
    : result === 'LOSS'
      ? 'Mönstret visar att entry inte höll tillräckligt länge för att skydda mot motrörelse.'
      : 'Resultatet behöver mer loggdata för att kunna läsas som lärdom.';
  const possibleIssue = missing.size > 0
    ? `Saknas i äldre loggning: ${Array.from(missing).sort().join(', ')}. Logga entryReason, exitReason, confidenceScore, statusAtEntry, gateDecision, stopLoss/takeProfit och mfePct/maePct framöver.`
    : hasExitEngine
      ? 'Exitengine användes och lämnar spår i loggen, men inte alla mellanliggande beslut är fullständigt beskrivna.'
      : 'Loggningen räcker för en grov analys, men mellanliggande prisväg saknas.';
  return {
    summary,
    whyWinOrLoss,
    lesson,
    possibleIssue,
    missingFields: Array.from(missing).sort(),
    tradeStats: {
      mfePct: stats.mfePct,
      maePct: stats.maePct,
      highestPriceDuringTrade: stats.highestPriceDuringTrade,
      lowestPriceDuringTrade: stats.lowestPriceDuringTrade,
      stopLoss: stats.stopLoss,
      takeProfit: stats.takeProfit,
    },
    recommendedLogging: [
      ...(entry.recommendedLogging || []),
      ...(exit.recommendedLogging || []),
      'stopLoss',
      'takeProfit',
      'mfePct',
      'maePct',
    ].filter((value, index, arr) => value && arr.indexOf(value) === index),
  };
}

function buildExplanationForTrade(row, events) {
  const trade = normalizeTrade(row);
  if (!trade || !trade.tradeId && !trade.symbol) return null;
  const matchedEvents = events.filter((event) => sameIdentity(event, trade));
  const entry = explainEntry(trade, matchedEvents);
  const exit = explainExit(trade, matchedEvents);
  const nearbyEvents = buildNearbyEvents(trade, events);
  const diagnosis = buildDiagnosis(trade, entry, exit, nearbyEvents);
  const entryQualityGate = entryQualityGateService.buildEntryQualityGate({
    trade,
    explanation: {
      entry,
      exit,
      diagnosis,
      nearbyEvents,
      tradeStats: trade.tradeStats,
    },
    events: nearbyEvents,
  });
  return {
    tradeId: trade.tradeId || null,
    tradeKey: trade.tradeKey,
    symbol: trade.symbol || 'unknown',
    strategyId: trade.strategyId || 'unknown',
    setup: trade.setup || 'unknown',
    result: trade.result || 'unknown',
    pnlPct: trade.pnlPct,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    tradeStats: trade.tradeStats,
    entry,
    exit,
    diagnosis,
    entryQualityGate,
    recommendations: entryQualityGate.recommendations,
    missingFields: unique([
      ...diagnosis.missingFields,
      ...entryQualityGate.missingFields,
    ]),
    nearbyEvents,
    safety: SAFETY,
  };
}

function findTradeRows(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  return readJsonl(files.trades)
    .filter(isClosedTrade)
    .sort((a, b) => String(normalizeClosedAt(b) || '').localeCompare(String(normalizeClosedAt(a) || '')));
}

function timeMatches(normalizedValue, searchedValue, toleranceMs) {
  if (!normalizedValue || !searchedValue) return false;
  const delta = Math.abs(normalizeTradeTime(normalizedValue) - normalizeTradeTime(searchedValue));
  return Number.isFinite(delta) && delta <= toleranceMs;
}

function compactMatch(row) {
  if (!row) return null;
  const normalized = normalizeTrade(row);
  return {
    tradeId: normalized.tradeId || null,
    symbol: normalized.symbol || null,
    strategyId: normalized.strategyId || null,
    openedAt: normalized.openedAt || null,
    closedAt: normalized.closedAt || null,
    result: normalized.result || null,
  };
}

function scoreMatch(row, criteria = {}) {
  const normalized = normalizeTrade(row);
  const search = {
    tradeId: text(criteria.tradeId || null),
    symbol: text(criteria.symbol || null),
    strategyId: text(criteria.strategyId || criteria.strategy_id || criteria.canonicalStrategyId || criteria.canonical_strategy_id || criteria.resolvedStrategyId || criteria.resolved_strategy_id || null),
    openedAt: iso(criteria.openedAt || criteria.opened_at || null),
    closedAt: iso(criteria.closedAt || criteria.closed_at || null),
  };
  const toleranceMs = (num(criteria.toleranceSeconds) || MATCH_TOLERANCE_SECONDS) * 1000;
  const missingFields = [];
  let score = 0;
  let hardMismatch = false;

  if (search.tradeId) {
    if (!normalized.tradeId) {
      missingFields.push('tradeId');
    } else if (normalized.tradeId === search.tradeId) {
      score += 1000;
    } else {
      return {
        matched: false,
        score: -1,
        reason: 'trade_id_mismatch',
        searched: search,
        missingFields,
        candidate: compactMatch(row),
      };
    }
  } else if (!normalized.tradeId) {
    missingFields.push('tradeId');
  }

  if (search.symbol) {
    if (!normalized.symbol) {
      missingFields.push('symbol');
    } else if (normalized.symbol === search.symbol) {
      score += 200;
    } else {
      hardMismatch = true;
    }
  }

  if (search.strategyId) {
    if (!normalized.strategyId) {
      missingFields.push('strategyId');
    } else if (normalized.strategyId === search.strategyId) {
      score += 180;
    } else {
      hardMismatch = true;
    }
  }

  if (search.openedAt) {
    if (!normalized.openedAt) {
      missingFields.push('openedAt');
    } else if (timeMatches(normalized.openedAt, search.openedAt, toleranceMs)) {
      score += 150;
    } else {
      hardMismatch = true;
    }
  }

  if (search.closedAt) {
    if (!normalized.closedAt) {
      missingFields.push('closedAt');
    } else if (timeMatches(normalized.closedAt, search.closedAt, toleranceMs)) {
      score += 120;
    } else {
      hardMismatch = true;
    }
  }

  if (!normalized.symbol || !normalized.strategyId || !normalized.openedAt) {
    if (!normalized.symbol) missingFields.push('symbol');
    if (!normalized.strategyId) missingFields.push('strategyId');
    if (!normalized.openedAt) missingFields.push('openedAt');
  }

  const enoughIdentity = !!(search.tradeId || (search.symbol && search.strategyId && search.openedAt));
  if (!enoughIdentity) {
    return {
      matched: false,
      score: -1,
      reason: 'insufficient_log_fields',
      searched: search,
      missingFields,
      candidate: compactMatch(row),
    };
  }

  if (hardMismatch) {
    const reason = !normalized.strategyId || !search.strategyId
      ? 'insufficient_log_fields'
      : !search.openedAt || !normalized.openedAt
        ? 'insufficient_log_fields'
        : !timeMatches(normalized.openedAt, search.openedAt, toleranceMs)
          ? 'timestamp_mismatch'
          : 'strategy_id_mismatch';
    return {
      matched: false,
      score,
      reason,
      searched: search,
      missingFields,
      candidate: compactMatch(row),
    };
  }

  const matched = score >= (search.tradeId ? 1000 : 500);
  return {
    matched,
    score,
    reason: matched ? 'matched' : 'timestamp_mismatch',
    searched: search,
    missingFields,
    candidate: compactMatch(row),
  };
}

function findMatchingTrade(rows, criteria = {}) {
  const tradeId = text(criteria.tradeId || null);
  const symbol = text(criteria.symbol || null);
  const strategyId = text(criteria.strategyId || criteria.strategy_id || criteria.canonicalStrategyId || criteria.canonical_strategy_id || criteria.resolvedStrategyId || criteria.resolved_strategy_id || null);
  const openedAt = iso(criteria.openedAt || criteria.opened_at || null);
  const closedAt = iso(criteria.closedAt || criteria.closed_at || null);
  const toleranceMs = (num(criteria.toleranceSeconds) || MATCH_TOLERANCE_SECONDS) * 1000;

  if (tradeId) {
    const exact = rows.find((row) => text(row.tradeId || row.id || row.signalId || null) === tradeId);
    if (exact) return exact;
  }

  if (symbol || strategyId || openedAt || closedAt) {
    const scored = rows
      .map((row) => ({ row, score: scoreMatch(row, { tradeId, symbol, strategyId, openedAt, closedAt, toleranceSeconds: toleranceMs / 1000 }) }))
      .sort((a, b) => b.score.score - a.score.score);
    const best = scored[0];
    if (best && best.score.matched) return best.row;
  }

  return null;
}

function diagnoseTradeLookup(rows, criteria = {}) {
  const tradeId = text(criteria.tradeId || null);
  const symbol = text(criteria.symbol || null);
  const strategyId = text(criteria.strategyId || criteria.strategy_id || criteria.canonicalStrategyId || criteria.canonical_strategy_id || criteria.resolvedStrategyId || criteria.resolved_strategy_id || null);
  const openedAt = iso(criteria.openedAt || criteria.opened_at || null);
  const closedAt = iso(criteria.closedAt || criteria.closed_at || null);
  const searched = { tradeId, symbol, strategyId, openedAt, closedAt };
  const scored = rows
    .map((row) => ({ row, score: scoreMatch(row, { ...searched, toleranceSeconds: MATCH_TOLERANCE_SECONDS }) }))
    .sort((a, b) => b.score.score - a.score.score);
  const best = scored[0] || null;
  const reason = best?.score?.reason || 'insufficient_log_fields';
  return {
    reason,
    searchedSymbol: symbol || null,
    searchedStrategyId: strategyId || null,
    searchedOpenedAt: openedAt || null,
    searchedClosedAt: closedAt || null,
    availableClosestMatch: best && best.score.score > 0 ? compactMatch(best.row) : null,
    candidateCount: rows.length,
    missingFields: best?.score?.missingFields || [],
  };
}

function buildTradeExplanations(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const limit = clampLimit(options.limit, 50);
  const trades = findTradeRows({ files });
  const events = readJsonl(files.events).map(normalizeEvent);
  const state = readJson(files.state, {});
  const explanations = trades.slice(0, limit).map((row) => buildExplanationForTrade(row, events)).filter(Boolean);

  return {
    ok: true,
    count: explanations.length,
    limit,
    items: explanations,
    safety: SAFETY,
    source: {
      trades: files.trades,
      events: files.events,
      state: files.state,
    },
    stateSnapshot: {
      enabled: state?.enabled ?? null,
      conservativeMode: state?.conservativeMode ?? null,
      openTrades: Array.isArray(state?.openTrades) ? state.openTrades.length : null,
    },
  };
}

function buildTradeExplanationLookup(options = {}) {
  const files = { ...DEFAULT_FILES, ...(options.files || {}) };
  const trades = findTradeRows({ files });
  const events = readJsonl(files.events).map(normalizeEvent);
  const trade = findMatchingTrade(trades, options.lookup || options);

  if (!trade) {
    const diagnosis = diagnoseTradeLookup(trades, options.lookup || options);
    return {
      ok: true,
      found: false,
      tradeExplanation: null,
      diagnosis,
      safety: SAFETY,
      source: {
        trades: files.trades,
        events: files.events,
        state: files.state,
      },
      message: 'Trade hittades inte. Kontrollera tradeId eller symbol+strategyId+openedAt.',
    };
  }

  return {
    ok: true,
    found: true,
    tradeExplanation: buildExplanationForTrade(trade, events),
    safety: SAFETY,
    source: {
      trades: files.trades,
      events: files.events,
      state: files.state,
    },
  };
}

module.exports = {
  SAFETY,
  buildTradeExplanations,
  buildTradeExplanationLookup,
  _internal: {
    clampLimit,
    normalizeTrade,
    normalizeEvent,
    buildExplanationForTrade,
    findMatchingTrade,
    diagnoseTradeLookup,
    scoreMatch,
    safeTradeKey,
  },
};
