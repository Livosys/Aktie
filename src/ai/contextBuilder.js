'use strict';

const { getLatestResults, getScanStatus, getGroups } = require('../scanner/scheduler');
const { getCryptoResults, getCryptoStatus } = require('../scanner/cryptoScheduler');
const { buildSystemHealth } = require('../systemHealth');
const { getAlerts } = require('../alerts/alertEngine');
const { loadSignals } = require('../scanner/historicalScanner');
const { getEdgeSummary, getEdgeForSymbol } = require('../scanner/historicalEdge');

const MAX_RESULTS = 12;
const MAX_ALERTS = 12;
const MAX_HISTORY = 10;

function compactResult(r) {
  if (!r) return null;
  return {
    symbol: r.symbol,
    price: r.price,
    state: r.state,
    signal: r.signal,
    eventType: r.eventType,
    tradeScore: r.tradeScore,
    confidence: r.confidence,
    actionSv: r.actionSv,
    reasonSv: r.reasonSv,
    priority: r.priority,
    lastUpdate: r.lastUpdate,
    historicalEdge: r.historicalEdge ? {
      sampleSize: r.historicalEdge.sampleSize,
      winRate: r.historicalEdge.winRate,
      confidence: r.historicalEdge.confidence,
      adjustment: r.historicalEdge.adjustment,
      matchLevel: r.historicalEdge.matchLevel,
    } : null,
    mtf: r.mtf ? {
      alignment: r.mtf.alignment,
      conflict: r.mtf.conflict,
      summarySv: r.mtf.summarySv,
    } : null,
    fakeout: r.fakeoutProbability ? {
      risk: r.fakeoutProbability.risk,
      probability: r.fakeoutProbability.probability,
      summarySv: r.fakeoutProbability.summarySv,
    } : null,
  };
}

function topResults(results, symbol) {
  const list = symbol
    ? results.filter((r) => String(r.symbol || '').toUpperCase() === symbol)
    : results;

  return [...list]
    .sort((a, b) => (b.tradeScore || 0) - (a.tradeScore || 0))
    .slice(0, MAX_RESULTS)
    .map(compactResult)
    .filter(Boolean);
}

function loadRecentSignals(symbol) {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 7 * 86400000);
  const start = startDate.toISOString().slice(0, 10);
  try {
    return loadSignals(start, end, symbol || null)
      .slice(-MAX_HISTORY)
      .map((s) => ({
        signalId: s.signalId,
        timestamp: s.timestamp || s.candleTs,
        symbol: s.symbol,
        signal: s.signal,
        eventType: s.eventType,
        state: s.state,
        tradeScore: s.tradeScore,
        actionSv: s.actionSv,
      }));
  } catch (err) {
    return { error: err.message };
  }
}

function buildHistorySummary(symbol) {
  let edge = null;
  try {
    edge = symbol ? getEdgeForSymbol(symbol) : getEdgeSummary();
  } catch (err) {
    edge = { error: err.message };
  }

  return {
    recentSignals: loadRecentSignals(symbol),
    historicalEdge: edge,
  };
}

function buildAlertsContext() {
  try {
    return getAlerts({ includeAcknowledged: false, limit: MAX_ALERTS }).map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      titleSv: a.titleSv,
      messageSv: a.messageSv,
      suggestedActionSv: a.suggestedActionSv,
      createdAt: a.createdAt,
      symbol: a.symbol,
    }));
  } catch (err) {
    return { error: err.message };
  }
}

function normalizePage(page) {
  const allowed = new Set(['live', 'alerts', 'system-health', 'stocks', 'crypto', 'history', 'review']);
  return allowed.has(page) ? page : 'live';
}

function buildAiContext({ page, symbol } = {}) {
  const selectedSymbol = symbol ? String(symbol).trim().toUpperCase().slice(0, 24) : null;
  const groups = getGroups();
  const stocks = getLatestResults();
  const crypto = getCryptoResults();
  const allResults = [...stocks, ...crypto];

  let health = null;
  try {
    health = buildSystemHealth();
  } catch (err) {
    health = { error: err.message };
  }

  return {
    page: normalizePage(page),
    symbol: selectedSymbol,
    generatedAt: new Date().toISOString(),
    scan: {
      stocksStatus: getScanStatus(),
      cryptoStatus: getCryptoStatus(),
      groups,
      stocks: topResults(stocks, selectedSymbol),
      crypto: topResults(crypto, selectedSymbol),
      selectedSymbol: selectedSymbol ? topResults(allResults, selectedSymbol) : [],
    },
    alerts: buildAlertsContext(),
    systemHealth: health ? {
      ok: health.ok,
      overallStatus: health.overallStatus,
      summarySv: health.summarySv,
      components: Array.isArray(health.components)
        ? health.components.slice(0, 20).map((c) => ({
            name: c.name,
            area: c.area,
            status: c.status,
            summarySv: c.summarySv,
            lastUpdated: c.lastUpdated,
          }))
        : [],
      alerts: Array.isArray(health.alerts) ? health.alerts.slice(0, MAX_ALERTS) : [],
    } : null,
    history: buildHistorySummary(selectedSymbol),
  };
}

module.exports = { buildAiContext };
