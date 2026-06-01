'use strict';
const express = require('express');
const router  = express.Router();
const {
  getLatestResults,
  getScanStatus,
  getStockFeedStatus,
  getWatchlist,
  getGroups,
  getLiveCandlesDebug: getStockLiveCandlesDebug,
} = require('../scanner/scheduler');
const {
  getCryptoResults,
  getCryptoStatus,
  getLiveCandlesDebug: getCryptoLiveCandlesDebug,
} = require('../scanner/cryptoScheduler');
const { readLatest }          = require('../scanner/featureLogger');
const { fetchAlpacaBars, isEnabled: alpacaEnabled, hasCredentials } = require('../data/alpacaDataService');
const { fetchBinanceKlines } = require('../data/binanceDataService');
const { saveRawBars, saveCandles2m, loadCandles, listSymbols, listAvailableDates, countCandles, getDatesInRange } = require('../data/marketDataStore');
const { aggregate1mTo2m, filterComplete } = require('../data/candleAggregator');
const { runHistoricalScan, loadSignals }  = require('../scanner/historicalScanner');
const { analyzeOutcomes, loadOutcomes }         = require('../scanner/signalOutcomeAnalyzer');
const { saveLearning, loadLearning }            = require('../scanner/signalLearning');
const { getEdge, getEdgeForSymbol, getEdgeSummary, invalidateCache } = require('../scanner/historicalEdge');
const { runReplay, listRuns, loadRunSummary, loadRunEvents, loadRunInsights } = require('../scanner/replayEngine');
const { runLearningEngine, loadLearningSummary } = require('../scanner/learningEngine');
const { buildRuleMemory, loadRuleMemory }               = require('../scanner/ruleMemoryEngine');
const { buildSymbolProfiles, loadSymbolProfiles }       = require('../scanner/symbolPersonalityEngine');
const { buildRegimeProfiles, loadRegimeProfiles }       = require('../scanner/regimeProfileEngine');
const { loadScoreCalibration }                         = require('../scanner/scoreCalibrationEngine');
const { loadFakeoutDna }                               = require('../scanner/fakeoutDnaEngine');
const { loadRuleHealth }                               = require('../scanner/selfHealingRuleEngine');
const { loadPersonality }                              = require('../scanner/marketPersonalityEngine');
const { loadMomentumBacktest, buildMomentumBacktest }  = require('../history/momentumBacktestAnalyzer');
const { loadMicroMoveAnalysis, buildMicroMoveAnalysis } = require('../history/microMoveAnalyzer');
const { analyzeSignalQuality }                         = require('../history/signalQualityAnalyzer');
const { buildSystemHealth }                            = require('../systemHealth');
const { buildDaytradeSignal }                          = require('../scanner/daytradeSignalEngine');
const { buildSignalDecisionSummary }                   = require('../scanner/signalDecisionSummary');
const { buildDecisionMonitor }                         = require('../scanner/decisionMonitor');
const { buildAiContext }                               = require('../ai/contextBuilder');
const { askAi, isConfigured: aiIsConfigured, RISK_NOTE } = require('../ai/aiService');
const redisService                                      = require('../services/redisService');
const agentReasoningService                            = require('../services/agentReasoningService');
const vectorMemoryService                              = require('../services/vectorMemoryService');
const replayIntelligenceService                        = require('../services/replayIntelligenceService');
const riskEngineService                                = require('../services/riskEngineService');
const exitEngineService                                = require('../services/exitEngineService');
const exitCalibrationService                           = require('../services/exitCalibrationService');
const strategyLabService                               = require('../services/strategyLabService');
const executionSafetyService                           = require('../services/executionSafetyService');
const notificationEngineV2                             = require('../alerts/notificationEngineV2');
const intelligenceAgent                                = require('../services/systemIntelligenceAgentService');
const tradingAgentsAdapter                             = require('../services/tradingAgentsAdapterService');
const tradingAgentsResultMemory                        = require('../services/tradingAgentsResultMemoryService');
const agentDebateEngine                                = require('../services/agentDebateEngineService');
const setupPerformance                                 = require('../services/setupPerformanceService');
const setupFocusMode                                   = require('../services/setupFocusModeService');
const aiOptimizationAgent                              = require('../services/aiOptimizationAgentService');
const marketUniverse    = require('../services/marketUniverseService');
const blockerConfig     = require('../services/blockerConfigService');
const strategyCatalog   = require('../services/strategyCatalogService');
const daytradingStrategyCatalog = require('../services/daytradingStrategyCatalogService');
const strategyPerformance = require('../services/strategyPerformanceService');
const strategyPerformanceRead = require('../services/strategyPerformanceReadService');
const strategyBatchTest = require('../services/strategyBatchTestService');
const strategyTestAutopilot = require('../services/strategyTestAutopilotService');
const learningConnector = require('../services/learningConnectorService');
const topStrategyGrid = require('../services/topStrategyGridService');
const candidateLog      = require('../services/candidateLogService');
const auditTrail        = require('../services/auditTrailService');
const eventLogService   = require('../services/eventLogService');
const tradeOutcomeReplay = require('../services/tradeOutcomeReplayService');
const marketRegime      = require('../services/marketRegimeService');
const priorityEngine    = require('../services/priorityEngineService');
const dailyIntelligencePipeline = require('../services/dailyIntelligencePipelineService');
const historicalDataCenter = require('../services/historicalDataCenterService');
const dataCoverageExpansion = require('../services/dataCoverageExpansionService');
const daytradingControl = require('../services/daytradingControlService');
const daytradingLearning = require('../services/daytradingLearningEngineService');
const supervisorOperationsAdvisorService = require('../services/supervisorOperationsAdvisorService');
const TEST_LIVE_SEND_COOLDOWN_MS = 5 * 60 * 1000;
let testLiveSendLastAt = 0;
const auditScanLastAt = new Map();
const {
  buildSignalAnalysisContext,
  optionallyGenerateAiSummary,
} = require('../ai/analystService');
const {
  acknowledgeAlerts,
  alertsFromScannerResults,
  alertsFromSystemHealth,
  getAlerts,
  recordAlerts,
  resolveMissingSystemAlerts,
  RESOLVED_RECENT_MS,
} = require('../alerts/alertEngine');
const { processSystemHealth, sendTestMessage } = require('../alerts/notificationService');
const { runAutoMachine, isRunning: autoMachineRunning, getStatus: getAutoMachineStatus } = require('../jobs/autoMachine');
const { getSchedulerStatus } = require('../jobs/autoMachineScheduler');
const paperTrading = require('../paperTrading/paperTradingAgent');
const { emptyReport: emptyGateEffectivenessReport } = require('../markets/marketGateEffectiveness');

function auditFilters(req) {
  return {
    limit: req.query.limit || req.query.n,
    type: req.query.type,
    symbol: req.query.symbol,
    source: req.query.source,
    batch_id: req.query.batch_id || req.query.batchId,
    category: req.query.category,
  };
}

function buildScanResponse(results, status, group) {
  const enriched = addDaytradeSignals(results);
  const scanGroup = group || 'all';
  const lastAuditAt = auditScanLastAt.get(scanGroup) || 0;
  if (Date.now() - lastAuditAt > 60_000) {
    auditScanLastAt.set(scanGroup, Date.now());
    auditTrail.logAuditEvent({
      type: 'SYSTEM_SCAN',
      source: 'scanner',
      timestamp: status.lastScan || new Date().toISOString(),
      message: `Systemscan ${scanGroup}`,
      details: { group: scanGroup, count: enriched.length, scanning: status.scanning, feedStatus: status.feedStatus || null },
    });
    const top = enriched.find((row) => row?.symbol);
    if (top) {
      auditTrail.logAuditEvent({
        type: 'SIGNAL_DETECTED',
        source: 'scanner',
        timestamp: status.lastScan || new Date().toISOString(),
        symbol: top.symbol,
        strategy_id: top.signalSubtype || top.signalFamily || null,
        message: `Signal upptäckt för ${top.symbol}`,
        details: { group: scanGroup, score: top.tradeScore ?? top.signalScore ?? top.priorityScore ?? null, signal: top.signal || null },
      });
    }
  }
  return {
    ok: true,
    group: scanGroup,
    lastScan: status.lastScan,
    scanning: status.scanning,
    marketWarning: status.marketWarning,
    feedStatus: status.feedStatus || null,
    count: enriched.length,
    results: enriched,
  };
}

function addDaytradeSignals(results) {
  return (results || []).map((r) => ({
    ...r,
    ...buildDaytradeSignal(r),
  })).map(addStrategyPerformanceContext);
}

function addStrategyPerformanceContext(result) {
  try {
    const strategy = daytradingStrategyCatalog.inferStrategyForSignal(result);
    if (!strategy) return result;
    const performance = strategyPerformance.getSignalPerformanceBadge(strategy.id);
    const priorityBase = Number(result.priorityScore ?? result.tradeScore ?? result.signalScore ?? 0) || 0;
    return {
      ...result,
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      strategyLabel: strategy.name,
      strategy_market_group: strategy.market_group,
      strategy_performance_badge: performance.badge,
      strategy_performance_message: performance.message,
      strategy_priority_score: Math.max(0, Math.min(100, Math.round(priorityBase + performance.priority_adjustment))),
      strategy_performance: {
        win_rate: performance.win_rate,
        trades: performance.trades,
        score: performance.score,
        priority_adjustment: performance.priority_adjustment,
      },
    };
  } catch (_) {
    return result;
  }
}

function normalizeDebugCandle(c) {
  const timestamp = c?.timestamp || c?.ts || c?.t || null;
  return {
    timestamp,
    open: c?.open ?? c?.o ?? null,
    high: c?.high ?? c?.h ?? null,
    low: c?.low ?? c?.l ?? null,
    close: c?.close ?? c?.c ?? null,
    volume: c?.volume ?? c?.v ?? null,
  };
}

function secondsSince(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function readLiveCandleDebug({ symbol, marketType, timeframe, limit }) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const type = String(marketType || '').toLowerCase();
  const tf = String(timeframe || '2m').toLowerCase();
  const checkedSources = [];
  const notes = [];
  const reader = type === 'crypto' ? getCryptoLiveCandlesDebug : getStockLiveCandlesDebug;

  let source = reader(normalizedSymbol, tf);
  checkedSources.push(`${type || 'stock'}:${tf}:live-cache`);

  if (!source && tf === '2m') {
    const oneMinute = reader(normalizedSymbol, '1m');
    checkedSources.push(`${type || 'stock'}:1m:live-cache`);
    if (oneMinute?.candles?.length) {
      const aggregated = filterComplete(aggregate1mTo2m(oneMinute.candles)).map(normalizeDebugCandle);
      source = {
        symbol: normalizedSymbol,
        marketType: oneMinute.marketType || type || 'stock',
        timeframe: '2m',
        sourceName: `${oneMinute.sourceName || 'live_1m'}_aggregated_to_2m`,
        updatedAt: oneMinute.updatedAt,
        candles: aggregated,
      };
      notes.push('2m candles aggregerade från 1m live bars');
    }
  }

  if (!source?.candles?.length) {
    return {
      ok: false,
      error: 'Live candles saknas för symbolen',
      debug: { checkedSources },
    };
  }

  const candles = source.candles
    .map(normalizeDebugCandle)
    .filter((c) => c.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-limit);
  const latestTimestamp = candles[candles.length - 1]?.timestamp || null;

  return {
    ok: true,
    symbol: normalizedSymbol,
    marketType: source.marketType || type || 'stock',
    timeframe: source.timeframe || tf,
    latestTimestamp,
    dataAgeSeconds: secondsSince(latestTimestamp),
    source: source.sourceName || 'live-cache',
    candles,
    debug: {
      hasLiveCandles: candles.length > 0,
      candleCount: candles.length,
      sourceName: source.sourceName || 'live-cache',
      notes,
    },
  };
}

function buildTfDebugForCandidate(candidate) {
  const marketType = candidate.marketType || candidate.market || 'stock';
  const result = readLiveCandleDebug({
    symbol: candidate.symbol,
    marketType,
    timeframe: '2m',
    limit: 5,
  });
  if (!result.ok) {
    return {
      tf2mSource: 'upstream',
      tf2mReason: 'tf2m kommer från upstream tf2mDirection. Råa live-candles finns inte i candidate-objektet.',
      latest2mCandles: [],
      dataAgeSeconds: null,
      candleScore2m: candidate.candleScore2m || {
        scoreDirection: 'unknown',
        reasonSv: '2m candles saknas för candle-score.',
      },
    };
  }
  return {
    tf2mSource: result.source,
    tf2mReason: result.debug.notes?.[0] || 'tf2m kan jämföras mot live 2m candles från debug-cache.',
    latest2mCandles: result.candles,
    dataAgeSeconds: result.dataAgeSeconds,
    candleScore2m: candidate.candleScore2m || null,
  };
}

function buildLiveCandleDebugMap(results) {
  return (results || []).reduce((acc, item) => {
    if (!item?.symbol) return acc;
    const marketType = item._market || item.market || (String(item.symbol).endsWith('USDT') ? 'crypto' : 'stock');
    const result = readLiveCandleDebug({
      symbol: item.symbol,
      marketType,
      timeframe: '2m',
      limit: 5,
    });
    if (result.ok) acc[item.symbol] = result;
    return acc;
  }, {});
}

function buildCurrentDecisionMonitor(options = {}) {
  const stockResults = addDaytradeSignals(getLatestResults());
  const cryptoResults = addDaytradeSignals(getCryptoResults());
  const liveCandleDebugBySymbol = buildLiveCandleDebugMap([
    ...stockResults.map((r) => ({ ...r, _market: 'stock' })),
    ...cryptoResults.map((r) => ({ ...r, _market: 'crypto' })),
  ]);
  const result = buildDecisionMonitor({
    stockResults,
    cryptoResults,
    liveCandleDebugBySymbol,
    familyDebug: options.familyDebug === true,
    stockFeedStatus: getStockFeedStatus(),
  });
  return { result, liveCandleDebugBySymbol };
}

async function attachAnalystSummaries(candidates, liveCandleDebugBySymbol, qualityData) {
  return Promise.all((candidates || []).map(async (candidate) => {
    const candles = liveCandleDebugBySymbol?.[candidate.symbol]?.candles || [];
    const context = buildSignalAnalysisContext(candidate, qualityData, candles);
    const analyst = await optionallyGenerateAiSummary(context);
    return { ...candidate, analyst };
  }));
}

router.get('/scan', (req, res) => {
  res.json(buildScanResponse(getLatestResults(), getScanStatus()));
});

router.get('/scan/stocks', (req, res) => {
  const { stocks } = getGroups();
  const filtered = getLatestResults().filter((r) => stocks.includes(r.symbol));
  res.json(buildScanResponse(filtered, getScanStatus(), 'stocks'));
});

router.get('/scan/nasdaq', (req, res) => {
  const { nasdaq } = getGroups();
  const filtered = getLatestResults().filter((r) => nasdaq.includes(r.symbol));
  res.json(buildScanResponse(filtered, getScanStatus(), 'nasdaq'));
});

router.get('/scan/etfs', (req, res) => {
  const { indexEtfs, leveragedEtfs } = getGroups();
  const all = [...(indexEtfs || []), ...(leveragedEtfs || [])];
  const filtered = getLatestResults().filter((r) => all.includes(r.symbol));
  res.json(buildScanResponse(filtered, getScanStatus(), 'etfs'));
});

router.get('/scan/crypto', (req, res) => {
  const status = getCryptoStatus();
  const results = addDaytradeSignals(getCryptoResults());
  res.json({
    ok: true,
    enabled: true,
    group: 'crypto',
    lastScan: status.lastScan,
    scanning: status.scanning,
    marketWarning: false,
    feedStatus: status.feedStatus || null,
    count: results.length,
    results,
  });
});

// ── GET /api/debug/live-candles ──────────────────────────────────────────────
router.get('/debug/live-candles', (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const marketTypeRaw = String(req.query.marketType || req.query.market || 'stock').trim().toLowerCase();
    const marketType = marketTypeRaw === 'crypto' ? 'crypto' : 'stock';
    const timeframe = String(req.query.timeframe || '2m').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol is required' });
    if (!['1m', '2m'].includes(timeframe)) {
      return res.status(400).json({ ok: false, error: 'timeframe must be 1m or 2m' });
    }

    const payload = readLiveCandleDebug({ symbol, marketType, timeframe, limit });
    return res.status(payload.ok ? 200 : 404).json(payload);
  } catch (err) {
    console.error('[debug/live-candles]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/debug/signal-decisions', (req, res) => {
  const group = String(req.query.group || 'all').toLowerCase();
  const stockResults = addDaytradeSignals(getLatestResults());
  const cryptoResults = addDaytradeSignals(getCryptoResults());

  let results;
  if (group === 'stocks') {
    const { stocks } = getGroups();
    results = stockResults.filter((r) => stocks.includes(r.symbol));
  } else if (group === 'nasdaq') {
    const { nasdaq } = getGroups();
    results = stockResults.filter((r) => nasdaq.includes(r.symbol));
  } else if (group === 'crypto') {
    results = cryptoResults;
  } else {
    results = [...stockResults, ...cryptoResults];
  }

  const signalDecisionSummary = buildSignalDecisionSummary(results, { group });
  const counts = signalDecisionSummary.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  res.json({
    ok: true,
    group,
    count: signalDecisionSummary.length,
    counts,
    signalDecisionSummary,
  });
});

// ── GET /api/live/decision-monitor ──────────────────────────────────────────
router.get('/live/decision-monitor', async (req, res) => {
  try {
    const includeAi = String(req.query.includeAi || '') === '1';
    const familyDebug = String(req.query.familyDebug || '') === '1';
    const { result, liveCandleDebugBySymbol } = buildCurrentDecisionMonitor({ familyDebug });
    if (String(req.query.debug || '') === '1') {
      result.candidates = (result.candidates || []).map((candidate) => ({
        ...candidate,
        tfDebug: buildTfDebugForCandidate(candidate),
      }));
      result.debug = {
        liveCandles: 'enabled',
        note: 'tfDebug läser read-only live candle-cache från scheduler.',
      };
    }
    if (includeAi) {
      const qualityData = analyzeSignalQuality({ days: 14, limit: 300 });
      result.candidates = await attachAnalystSummaries(result.candidates, liveCandleDebugBySymbol, qualityData);
      result.ai = {
        mode: 'rule_based',
        label: 'AI-läge: regelbaserad analys',
      };
    }
    res.json(result);
  } catch (err) {
    console.error('[decision-monitor] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/ai/signal-analysis ──────────────────────────────────────────────
router.get('/ai/signal-analysis', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const timeframe = String(req.query.timeframe || '2m').trim().toLowerCase();
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol is required' });
    if (timeframe !== '2m') return res.status(400).json({ ok: false, error: 'timeframe must be 2m' });

    const { result, liveCandleDebugBySymbol } = buildCurrentDecisionMonitor();
    const candidate = (result.candidates || []).find((c) => c.symbol === symbol);
    if (!candidate) {
      return res.status(404).json({
        ok: false,
        symbol,
        error: 'Signaldata saknas för symbolen',
      });
    }

    const qualityData = analyzeSignalQuality({ days: 14, limit: 300 });
    const candles = liveCandleDebugBySymbol?.[symbol]?.candles || [];
    const context = buildSignalAnalysisContext(candidate, qualityData, candles);
    const analyst = await optionallyGenerateAiSummary(context);

    return res.json({
      ok: true,
      symbol,
      analyst,
    });
  } catch (err) {
    console.error('[ai/signal-analysis] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/ai/ask ─────────────────────────────────────────────────────────
// Read-only AI Copilot. Uses existing /api auth and rate limit from server.js.
router.post('/ai/ask', async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim();
    const page = String(req.body?.page || 'live').trim();
    const symbol = req.body?.symbol ? String(req.body.symbol).trim().toUpperCase() : null;
    const requestContext = req.body?.context;

    if (!question) {
      return res.status(400).json({ ok: false, error: 'question is required' });
    }
    if (question.length > 1200) {
      return res.status(400).json({ ok: false, error: 'question is too long' });
    }
    if (!aiIsConfigured()) {
      return res.status(503).json({ ok: false, error: 'AI is not configured' });
    }

    const baseContext = buildAiContext({ page, symbol });
    const context = requestContext && typeof requestContext === 'object'
      ? { ...baseContext, ...requestContext }
      : baseContext;
    const answer = await askAi({ question, page, symbol, context });

    res.json({
      ok: true,
      answer,
      sources: ['scan', 'alerts', 'systemHealth', 'history'],
      riskNote: RISK_NOTE,
    });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: 'AI is not configured' });
    }
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ ok: false, error: 'AI request timed out' });
    }
    console.warn('[AI] ask failed:', err.message);
    res.status(500).json({ ok: false, error: 'AI request failed' });
  }
});

// ── Hybrid Agent Layer ───────────────────────────────────────────────────────
// Agents are read-only commentary/risk helpers. They never create trades.

router.get('/system/redis-status', async (req, res) => {
  try {
    await redisService.ping();
    res.json(redisService.status());
  } catch (err) {
    res.json({
      ...redisService.status(),
      redisAvailable: false,
      mode: 'fallback',
      lastError: { message: err.message, at: new Date().toISOString() },
    });
  }
});

// ── Risk Engine v2 ──────────────────────────────────────────────────────────
// Read/write endpoints inherit /api auth, rate-limit and JSON limits from server.js.

router.get('/risk/status', async (req, res) => {
  try {
    res.json(await riskEngineService.getRiskStatus());
  } catch (err) {
    console.error('[risk/status] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/risk/config', async (req, res) => {
  try {
    res.json({
      ok: true,
      config: await riskEngineService.getRiskConfig(),
      safeFields: riskEngineService.SAFE_CONFIG_FIELDS,
      bounds: riskEngineService.CONFIG_BOUNDS,
    });
  } catch (err) {
    console.error('[risk/config] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/risk/config', async (req, res) => {
  try {
    const result = await riskEngineService.updateRiskConfig(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('[risk/config] update error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/risk/evaluate', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const signalContext = body.signalContext && typeof body.signalContext === 'object'
      ? body.signalContext
      : body;
    const accountState = body.accountState && typeof body.accountState === 'object'
      ? body.accountState
      : {};
    const persist = body.persist === true;
    const evaluation = await riskEngineService.evaluateTradeRisk(
      { ...signalContext, evaluation_source: 'manual_api_test' },
      accountState,
      { persist, evaluationSource: 'manual_api_test' },
    );
    res.json({ ...evaluation, persisted: persist && signalContext?.replay_mode !== true });
  } catch (err) {
    console.error('[risk/evaluate] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Exit Engine v1 ──────────────────────────────────────────────────────────
// Read/write endpoints inherit /api auth, rate-limit and JSON limits from server.js.

router.get('/exit/status', async (req, res) => {
  try {
    res.json(await exitEngineService.getExitEngineStatus());
  } catch (err) {
    console.error('[exit/status] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/exit/config', async (req, res) => {
  try {
    res.json({
      ok: true,
      config: await exitEngineService.getExitConfig(),
      keys: exitEngineService.KEYS,
    });
  } catch (err) {
    console.error('[exit/config] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/exit/config', async (req, res) => {
  try {
    const result = await exitEngineService.updateExitConfig(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('[exit/config] update error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/exit/evaluate', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const openTrade = body.openTrade || body.open_trade || body.trade || body;
    const marketState = body.marketState || body.market_state || {};
    const config = body.exitConfig || body.exit_config || await exitEngineService.getExitConfig();
    const evaluation = await exitEngineService.evaluateExit(openTrade, marketState, config);
    res.json(evaluation);
  } catch (err) {
    console.error('[exit/evaluate] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/exit/calibration', async (req, res) => {
  try {
    res.json(await exitCalibrationService.getCalibration());
  } catch (err) {
    console.error('[exit/calibration] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/exit/calibration/recent', async (req, res) => {
  try {
    res.json(await exitCalibrationService.getRecentCalibration());
  } catch (err) {
    console.error('[exit/calibration/recent] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/exit/calibration/rebuild', async (req, res) => {
  try {
    res.json(await exitCalibrationService.getCalibration({ force: true }));
  } catch (err) {
    console.error('[exit/calibration/rebuild] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Strategy Lab v1 ─────────────────────────────────────────────────────────
// Read-only strategy experimentation. All tests are forced to replay/paper mode.

router.get('/strategy-lab/pipeline', async (req, res) => {
  try {
    res.json(await strategyLabService.getPipelineStatus());
  } catch (err) {
    console.error('[strategy-lab/pipeline] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/strategy-lab/config', async (req, res) => {
  try {
    res.json({ ok: true, config: await strategyLabService.getStrategyConfig(), methods: strategyLabService.METHOD_NAMES, live_trading_enabled: false, replay_mode: true, paper_only: true });
  } catch (err) {
    console.error('[strategy-lab/config] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/strategy-lab/config', async (req, res) => {
  try {
    const result = await strategyLabService.updateStrategyConfig(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('[strategy-lab/config] update error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/strategy-lab/presets', async (req, res) => {
  try {
    res.json({ ok: true, presets: await strategyLabService.listPresets() });
  } catch (err) {
    console.error('[strategy-lab/presets] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/strategy-lab/presets', async (req, res) => {
  try {
    const result = await strategyLabService.savePreset(req.body || {});
    res.status(result.ok ? 201 : 400).json(result);
  } catch (err) {
    console.error('[strategy-lab/presets] save error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/strategy-lab/presets/:id/activate', async (req, res) => {
  try {
    const result = await strategyLabService.activatePreset(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    console.error('[strategy-lab/presets/activate] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/strategy-lab/test', async (req, res) => {
  try {
    res.json(await strategyLabService.runStrategyReplayTest(req.body || {}));
  } catch (err) {
    console.error('[strategy-lab/test] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/strategy-lab/compare', async (req, res) => {
  try {
    const body = req.body || {};
    const runIds = body.runIds || body.run_ids || [body.runA, body.runB, body.runC].filter(Boolean);
    const result = await strategyLabService.compareStrategyRuns(runIds);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('[strategy-lab/compare] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/strategy-lab/results', async (req, res) => {
  try {
    res.json(await strategyLabService.getResults());
  } catch (err) {
    console.error('[strategy-lab/results] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/strategy-lab/tradingagents/status', (req, res) => {
  try {
    res.json(strategyLabService.getTradingAgentsStatus());
  } catch (err) {
    console.error('[strategy-lab/tradingagents/status] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Daytrading Strategy Expansion v1 ────────────────────────────────────────
// Paper/replay only. These endpoints never place orders and always return
// explicit safety flags.

router.get('/daytrading-strategies/catalog', (req, res) => {
  try {
    res.json(daytradingStrategyCatalog.getCatalog());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...daytradingStrategyCatalog.SAFETY });
  }
});

router.get('/daytrading-strategies/performance', (req, res) => {
  try {
    res.json(strategyPerformanceRead.getStrategyPerformance());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyPerformance.SAFETY });
  }
});

router.get('/daytrading-strategies/top', (req, res) => {
  try {
    res.json(strategyPerformanceRead.getTopStrategies(Number(req.query.limit) || 5));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyPerformance.SAFETY });
  }
});

router.get('/daytrading-strategies/worst', (req, res) => {
  try {
    res.json(strategyPerformanceRead.getWorstStrategies(Number(req.query.limit) || 5));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyPerformance.SAFETY });
  }
});

router.get('/daytrading-strategies/:id', (req, res) => {
  try {
    const result = strategyPerformanceRead.getStrategyDetails(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyPerformance.SAFETY });
  }
});

router.post('/daytrading-strategies/test', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = String(body.mode || body.test_mode || 'paper_replay').toLowerCase();
    if (mode.includes('live') || body.live_trading_enabled === true || body.can_place_orders === true || body.actions_allowed === true) {
      return res.status(400).json({
        ok: false,
        error: 'daytrading_strategy_tests_are_paper_replay_only',
        ...strategyPerformance.SAFETY,
      });
    }
    const result = strategyPerformance.saveSimulatedStrategyTest({
      ...body,
      mode: 'paper_replay',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message, ...strategyPerformance.SAFETY });
  }
});

router.post('/daytrading-strategies/compare', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ids = body.strategy_ids || body.strategyIds || body.ids || [];
    res.json(strategyPerformanceRead.compareStrategies(ids));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyPerformance.SAFETY });
  }
});

// ── Daytrading Control Center ───────────────────────────────────────────────
// Aggregates existing scanner, paper trading, strategy, safety and data APIs.
// This is control/config for test and paper mode only. It never places orders.

router.get('/daytrading/status', async (req, res) => {
  try { res.json(await daytradingControl.getStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/strategies', (req, res) => {
  try { res.json(daytradingControl.getStrategies()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/runtime-strategies', (req, res) => {
  try { res.json(daytradingControl.getRuntimeStrategies()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/runtime-strategies/enable-all', (req, res) => {
  try { res.json(daytradingControl.setAllRuntimeStrategies(true)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/runtime-strategies/disable-all', (req, res) => {
  try { res.json(daytradingControl.setAllRuntimeStrategies(false)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/runtime-strategies/:strategyId/toggle', (req, res) => {
  try {
    const result = daytradingControl.toggleRuntimeStrategy(req.params.strategyId);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY });
  }
});

router.get('/daytrading/control', async (req, res) => {
  try {
    res.json({
      ok: true,
      status: await daytradingControl.getStatus(),
      strategies: daytradingControl.getStrategies(),
      runtime: daytradingControl.getRuntimeStrategies(),
      ...daytradingControl.SAFETY,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY });
  }
});

router.post('/daytrading/strategies/:id/update', (req, res) => {
  try {
    const result = daytradingControl.updateStrategy(req.params.id, req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY });
  }
});

router.post('/daytrading/filters', (req, res) => {
  try { res.json(daytradingControl.updateFilters(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/scan', (req, res) => {
  try { res.json(daytradingControl.runScan(req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/pipeline', (req, res) => {
  try { res.json(daytradingControl.getPipeline()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/live-trades', (req, res) => {
  try { res.json(daytradingControl.getLiveTrades({ limit: req.query.limit || req.query.n })); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/paper-trades', (req, res) => {
  try { res.json(daytradingControl.getLiveTrades({ limit: req.query.limit || req.query.n })); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/paper-signals', (req, res) => {
  try { res.json(daytradingControl.getPaperSignals({ limit: req.query.limit || req.query.n })); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/paper-strategy-diagnostics', (req, res) => {
  try { res.json(daytradingControl.getPaperStrategyDiagnostics()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/strategy-flow-diagnostics', (req, res) => {
  try { res.json(daytradingControl.getStrategyFlowDiagnostics()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/recommendation', (req, res) => {
  try { res.json(daytradingControl.getRecommendation()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/impact-summary', (req, res) => {
  try { res.json(daytradingControl.getImpactSummary()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

// Daytrading Learning Engine v1 — read-only, paper/test only. Aldrig order.
router.get('/daytrading/learning-summary', (req, res) => {
  try {
    const hours = Math.max(1, Math.min(720, Number(req.query.hours) || 48));
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
    const data = daytradingLearning.getLearningSummary({ hours, limit });
    res.json({ ok: data.ok !== false, ...daytradingLearning.SAFETY, data });
  } catch (err) {
    // Safe fallback — kasta aldrig om filer saknas eller data är tom.
    res.json({
      ok: false,
      error: err.message,
      ...daytradingLearning.SAFETY,
      data: { ok: false, summary: {}, by_strategy: [], by_market_group: [], by_risk_class: [], by_symbol: [], by_underlying_signal: [], by_traded_instrument: [], by_raw_signal: [], by_config: [], skip_reasons: [] },
    });
  }
});

router.get('/daytrading/symbols', (req, res) => {
  try { res.json(daytradingControl.getSymbols()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/markets', (req, res) => {
  try { res.json(daytradingControl.getMarkets()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.get('/daytrading/market-controls', (req, res) => {
  try { res.json(daytradingControl.getMarketControls()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/market-controls/:groupId/toggle', (req, res) => {
  try {
    const result = daytradingControl.updateMarketControl(req.params.groupId, req.body || {});
    if (result.ok === false && /live\/order/i.test(result.error || '')) return res.status(400).json(result);
    res.status(result.ok === false ? 404 : 200).json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/market-controls/enable-all-risk', (req, res) => {
  try { res.json(daytradingControl.setRiskMarketControls(true)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/market-controls/disable-all-risk', (req, res) => {
  try { res.json(daytradingControl.setRiskMarketControls(false)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/market-controls/enable-all', (req, res) => {
  try { res.json(daytradingControl.setAllMarketControls(true)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/market-controls/disable-all', (req, res) => {
  try { res.json(daytradingControl.setAllMarketControls(false)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

router.post('/daytrading/market-controls/sliders', (req, res) => {
  try {
    const result = daytradingControl.saveMarketControlSliders(req.body || {});
    if (result.ok === false) return res.status(400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message, ...daytradingControl.SAFETY }); }
});

// ── Strategy Batch Testing v1 ───────────────────────────────────────────────
// Runs parameter-grid tests in paper/replay simulation only.

router.get('/strategy-batches', (req, res) => {
  try {
    res.json(strategyBatchTest.listBatchTests());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

router.post('/strategy-batches', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.live_trading_enabled === true || body.can_place_orders === true || body.actions_allowed === true) {
      return res.status(400).json({ ok: false, error: 'strategy_batches_are_paper_replay_only', ...strategyBatchTest.SAFETY });
    }
    const result = strategyBatchTest.createBatchTest(body);
    res.status(result.ok ? 201 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

router.get('/strategy-batches/:id', (req, res) => {
  try {
    const result = strategyBatchTest.getBatchTestStatus(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

router.post('/strategy-batches/:id/run', (req, res) => {
  try {
    const result = strategyBatchTest.runBatchTest(req.params.id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

router.post('/strategy-batches/:id/pause', (req, res) => {
  try {
    const result = strategyBatchTest.pauseBatchTest(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

router.post('/strategy-batches/:id/stop', (req, res) => {
  try {
    const result = strategyBatchTest.stopBatchTest(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

router.get('/strategy-batches/:id/results', (req, res) => {
  try {
    const result = strategyBatchTest.getBatchTestResults(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

router.get('/strategy-batches/:id/compare', (req, res) => {
  try {
    const result = strategyBatchTest.compareBatchResults(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyBatchTest.SAFETY });
  }
});

// ── Strategy Test Autopilot v1 ──────────────────────────────────────────────
// Manual-first, paper/replay/batch-only planning. No live trading or orders.

router.get('/strategy-test-autopilot/status', (req, res) => {
  try {
    res.json(strategyTestAutopilot.getStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyTestAutopilot.SAFETY });
  }
});

router.get('/strategy-test-autopilot/config', (req, res) => {
  try {
    res.json(strategyTestAutopilot.getConfig());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyTestAutopilot.SAFETY });
  }
});

router.post('/strategy-test-autopilot/config', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = strategyTestAutopilot.saveConfig(body);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyTestAutopilot.SAFETY });
  }
});

router.post('/strategy-test-autopilot/run-once', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = strategyTestAutopilot.runOnce(body);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyTestAutopilot.SAFETY });
  }
});

router.post('/strategy-test-autopilot/enable', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = strategyTestAutopilot.enable(body);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyTestAutopilot.SAFETY });
  }
});

router.post('/strategy-test-autopilot/disable', (req, res) => {
  try {
    const result = strategyTestAutopilot.disable();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...strategyTestAutopilot.SAFETY });
  }
});

// ── Daily Intelligence Pipeline v1 ─────────────────────────────────────────
// Test/replay/batch/paper analysis only. It never enables order placement.

router.get('/results/daily-intelligence', (req, res) => {
  try {
    res.json(dailyIntelligencePipeline.latestSummary());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...dailyIntelligencePipeline.SAFETY });
  }
});

router.get('/pipeline/daily/status', (req, res) => {
  try {
    res.json(dailyIntelligencePipeline.status());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...dailyIntelligencePipeline.SAFETY });
  }
});

router.get('/pipeline/daily/recent', (req, res) => {
  try {
    res.json(dailyIntelligencePipeline.recentRuns(req.query.limit || req.query.n || 10));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...dailyIntelligencePipeline.SAFETY });
  }
});

router.post('/pipeline/daily/run-now', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.live_trading_enabled === true || body.can_place_orders === true || body.actions_allowed === true) {
      return res.status(400).json({ ok: false, error: 'daily_pipeline_is_test_only', ...dailyIntelligencePipeline.SAFETY });
    }
    const result = await dailyIntelligencePipeline.runPipeline({ trigger: 'manual_api', date: body.date });
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...dailyIntelligencePipeline.SAFETY });
  }
});

router.post('/pipeline/daily/enable', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.allow_live_trading === true || body.live_trading_enabled === true || body.can_place_orders === true || body.actions_allowed === true) {
      return res.status(400).json({ ok: false, error: 'daily_pipeline_cannot_enable_live_trading', ...dailyIntelligencePipeline.SAFETY });
    }
    res.json(dailyIntelligencePipeline.enable());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...dailyIntelligencePipeline.SAFETY });
  }
});

router.post('/pipeline/daily/disable', (req, res) => {
  try {
    res.json(dailyIntelligencePipeline.disable());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...dailyIntelligencePipeline.SAFETY });
  }
});

router.get('/top-strategy-grid/summary', (req, res) => {
  try {
    const rebuild = req.query.rebuild === '1';
    const result = rebuild ? topStrategyGrid.buildSummary({ persist: true }) : topStrategyGrid.getSummary();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...topStrategyGrid.SAFETY });
  }
});

// ── Audit Trail v1 ───────────────────────────────────────────────────────────
// Read-only paper/replay audit log. It never creates trades or enables live mode.

router.get('/audit/status', (req, res) => {
  try { res.json(auditTrail.getAuditStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...auditTrail.SAFETY }); }
});

router.get('/audit/recent', (req, res) => {
  try { res.json(auditTrail.getRecentAuditEvents(auditFilters(req))); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...auditTrail.SAFETY }); }
});

router.get('/audit/trades/recent', (req, res) => {
  try { res.json(auditTrail.getTradeAuditEvents(auditFilters(req))); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...auditTrail.SAFETY }); }
});

router.get('/audit/candidates/recent', (req, res) => {
  try { res.json(auditTrail.getCandidateAuditEvents(auditFilters(req))); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...auditTrail.SAFETY }); }
});

router.get('/audit/batches/recent', (req, res) => {
  try { res.json(auditTrail.getBatchAuditEvents(auditFilters(req))); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...auditTrail.SAFETY }); }
});

router.get('/audit/summary', (req, res) => {
  try { res.json(auditTrail.buildActivitySummary()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...auditTrail.SAFETY }); }
});

// ── Event Log v1 ─────────────────────────────────────────────────────────────
// Read-only local JSONL mirror of scanner, gate, paper, batch and learning events.
router.get('/events/recent', (req, res) => {
  try {
    res.json(eventLogService.readRecentEvents(req.query.limit || req.query.n || 100));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, actions_allowed: false, can_place_orders: false, live_trading_enabled: false });
  }
});

router.get('/events/status', (req, res) => {
  try {
    res.json(eventLogService.getStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, actions_allowed: false, can_place_orders: false, live_trading_enabled: false });
  }
});

// ── Trade Outcome Replay v1 ─────────────────────────────────────────────────
// Read-only paper/replay analysis. It never creates trades, places orders or changes live config.

router.get('/trade-replay/recent', async (req, res) => {
  try {
    res.json(await tradeOutcomeReplay.getRecentTradeReplays({
      limit: req.query.limit || req.query.n,
      symbol: req.query.symbol,
    }));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...tradeOutcomeReplay.SAFETY });
  }
});

router.get('/trade-replay/:tradeId', async (req, res) => {
  try { res.json(await tradeOutcomeReplay.buildTradeReplay(req.params.tradeId)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...tradeOutcomeReplay.SAFETY }); }
});

router.get('/trade-replay/:tradeId/timeline', (req, res) => {
  try { res.json(tradeOutcomeReplay.getTradeTimeline(req.params.tradeId)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...tradeOutcomeReplay.SAFETY }); }
});

router.get('/trade-replay/:tradeId/alternatives', async (req, res) => {
  try {
    const replay = await tradeOutcomeReplay.buildTradeReplay(req.params.tradeId);
    if (!replay.ok) return res.status(404).json(replay);
    return res.json({
      ok: true,
      trade_id: replay.trade.trade_id,
      alternatives: replay.alternative_exits,
      missed_opportunity: replay.missed_opportunity,
      ...tradeOutcomeReplay.SAFETY,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, ...tradeOutcomeReplay.SAFETY });
  }
});

router.get('/trade-replay/:tradeId/summary', async (req, res) => {
  try { res.json(await tradeOutcomeReplay.buildTradeReplaySummary(req.params.tradeId)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...tradeOutcomeReplay.SAFETY }); }
});

// ── Execution Safety v1 ─────────────────────────────────────────────────────
// Read/write endpoints inherit /api auth, rate-limit and JSON limits from server.js.

router.get('/safety/status', async (req, res) => {
  try {
    res.json(await executionSafetyService.getSafetyStatus());
  } catch (err) {
    console.error('[safety/status] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/safety/config', async (req, res) => {
  try {
    res.json({
      ok: true,
      config: await executionSafetyService.getSafetyConfig(),
      keys: executionSafetyService.KEYS,
      bounds: executionSafetyService.NUMBER_LIMITS,
      safeBooleanFields: executionSafetyService.BOOL_FIELDS,
    });
  } catch (err) {
    console.error('[safety/config] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/safety/config', async (req, res) => {
  try {
    const result = await executionSafetyService.updateSafetyConfig(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('[safety/config] update error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/safety/evaluate', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const evaluation = await executionSafetyService.evaluateExecutionSafety({
      ...body,
      source: body.source || 'manual_api_test',
    });
    res.json(evaluation);
  } catch (err) {
    console.error('[safety/evaluate] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/safety/kill-switch', async (req, res) => {
  try {
    const reason = req.body?.reason || 'manual_api_trigger';
    res.json(await executionSafetyService.triggerKillSwitch(reason));
  } catch (err) {
    console.error('[safety/kill-switch] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/safety/kill-switch/clear', async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'confirm_true_required' });
    }
    const reason = req.body?.reason || 'manual_api_clear';
    res.json(await executionSafetyService.clearKillSwitch(reason));
  } catch (err) {
    console.error('[safety/kill-switch/clear] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/safety/manual-arm', async (req, res) => {
  try {
    const reason = req.body?.reason || 'manual_api_arm';
    res.json(await executionSafetyService.manualArm(reason));
  } catch (err) {
    console.error('[safety/manual-arm] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/safety/manual-disarm', async (req, res) => {
  try {
    const reason = req.body?.reason || 'manual_api_disarm';
    res.json(await executionSafetyService.manualDisarm(reason));
  } catch (err) {
    console.error('[safety/manual-disarm] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Vector Memory / Historical Pattern Similarity ────────────────────────────

router.get('/memory/status', async (req, res) => {
  try {
    res.json(await vectorMemoryService.getMemoryStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/memory/similar', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const signalContext = body.signalContext && typeof body.signalContext === 'object'
      ? body.signalContext
      : body;
    const result = await vectorMemoryService.findSimilarSetups(signalContext, {
      limit: body.limit,
      candidateLimit: body.candidateLimit,
      minSimilarity: body.minSimilarity,
    });
    res.json(result);
  } catch (err) {
    console.error('[memory/similar] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/memory/similar/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol is required' });
    const cached = await vectorMemoryService.getCachedSimilarity(symbol);
    if (cached) return res.json({ ...cached, cached: true });
    res.json({
      ok: true,
      cached: false,
      provider: vectorMemoryService.PROVIDER,
      symbol,
      matches: [],
      summary: vectorMemoryService.summarizeSimilarSetups([]),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/memory/save', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const signalContext = body.signalContext && typeof body.signalContext === 'object'
      ? body.signalContext
      : body;
    const outcome = body.outcome && typeof body.outcome === 'object' ? body.outcome : {};
    const result = await vectorMemoryService.saveSignalMemory(signalContext, outcome);
    res.json(result);
  } catch (err) {
    console.error('[memory/save] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function buildAgentSignalContext(input = {}) {
  const c = input && typeof input === 'object' ? input : {};
  return {
    ...c,
    symbol: String(c.symbol || '').trim().toUpperCase(),
    direction: c.direction || c.nextMoveBias || c.bias || null,
    score: c.score ?? c.priorityScore ?? c.tradeScore ?? c.gateScore ?? c.gate?.gateScore ?? null,
    confidence: c.confidence ?? c.confidenceScore ?? c.gate?.confidenceScore ?? null,
    state: c.state || c.narrowState || c.marketState || null,
    volume: c.volume || {
      state: c.volumeState || null,
      relativeVolume: c.relativeVolume ?? null,
    },
    indicators: c.indicators || {
      signalFamily: c.signalFamily || null,
      signalSubtype: c.signalSubtype || null,
      agreementCount: c.agreementCount ?? null,
      extensionLevel: c.extensionLevel || null,
      tf2m: c.tf2m || c.timeframeAgreement?.tf2m || null,
    },
    gate: c.gate || c.gateDecision || {
      status: c.status || null,
      hardBlockers: c.hardBlockers || [],
      softBlockers: c.softBlockers || [],
      dataFreshness: c.dataFreshness || null,
      gateScore: c.gateScore ?? null,
    },
    paper: c.paper || {},
    marketPersonality: c.marketPersonality || {},
    recentDecisions: Array.isArray(c.recentDecisions) ? c.recentDecisions : [],
  };
}

router.get('/agent/latest-analysis', async (req, res) => {
  try {
    const fallback = paperTrading.getLatestAgentAnalysis
      ? paperTrading.getLatestAgentAnalysis()
      : null;
    const analysis = await agentReasoningService.getLatestAnalysis(fallback);
    if (!analysis) return res.json({ ok: true, analysis: null, source: 'none' });
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/agent/analysis/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol is required' });
    const analysis = await agentReasoningService.getAnalysisForSymbol(symbol, null);
    if (!analysis) return res.status(404).json({ ok: false, symbol, error: 'Ingen agentanalys hittades för symbolen' });
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/agent/analyze-signal', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const suppliedSignalContext = body.signalContext && typeof body.signalContext === 'object'
      ? body.signalContext
      : null;
    const symbol = String(body.symbol || suppliedSignalContext?.symbol || '').trim().toUpperCase();
    const suppliedCandidate = req.body?.candidate && typeof req.body.candidate === 'object'
      ? req.body.candidate
      : null;
    const bodyLooksLikeSignalContext = !suppliedSignalContext && !suppliedCandidate && (
      body.symbol || body.direction || body.score != null || body.confidence != null ||
      body.state || body.volume || body.indicators || body.gate || body.paper ||
      body.marketPersonality || body.recentDecisions
    );

    let signalContext = suppliedSignalContext || suppliedCandidate || (bodyLooksLikeSignalContext ? body : null);
    if (!signalContext) {
      const { result } = buildCurrentDecisionMonitor();
      signalContext = symbol
        ? (result.candidates || []).find((c) => c.symbol === symbol)
        : (result.candidates || [])[0];
    }

    if (!signalContext) signalContext = { symbol: symbol || 'UNKNOWN' };
    const analysis = await agentReasoningService.analyzeSignal(buildAgentSignalContext(signalContext));

    res.json(analysis);
  } catch (err) {
    console.error('[agent/analyze-signal] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Wave Phase routes ──────────────────────────────────────────────────────────

function buildWaveResponse(results, label) {
  const withWave = results.filter((r) => r.waveContext);
  return {
    ok: true,
    group: label,
    count: withWave.length,
    results: withWave.map((r) => ({
      symbol: r.symbol,
      price: r.price,
      lastUpdate: r.lastUpdate,
      waveContext: r.waveContext,
    })),
  };
}

router.get('/wave', (req, res) => {
  const stocks = getLatestResults();
  const crypto = getCryptoResults();
  const all = [...stocks, ...crypto];
  res.json(buildWaveResponse(all, 'all'));
});

router.get('/wave/stocks', (req, res) => {
  res.json(buildWaveResponse(getLatestResults(), 'stocks'));
});

router.get('/wave/crypto', (req, res) => {
  res.json(buildWaveResponse(getCryptoResults(), 'crypto'));
});

router.get('/replay/latest', (req, res) => {
  const symbol = req.query.symbol || null;
  const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const entries = readLatest(symbol, limit);
  res.json({ ok: true, count: entries.length, symbol: symbol || 'all', entries });
});

router.get('/groups', (req, res) => {
  res.json({ ok: true, groups: getGroups() });
});

router.get('/symbols', (req, res) => {
  res.json({ ok: true, symbols: getWatchlist() });
});

router.get('/status', (req, res) => {
  const status = getScanStatus();
  const alpacaConfigured =
    !!process.env.ALPACA_API_KEY_ID && !!process.env.ALPACA_API_SECRET_KEY;
  res.json({
    ok: true,
    alpacaConfigured,
    feed: process.env.ALPACA_DATA_FEED || 'iex',
    ...status,
  });
});

// ── Backfill helpers ──────────────────────────────────────────────────────────

const CRYPTO_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT']);

function isCrypto(symbol) {
  return symbol.endsWith('USDT') || CRYPTO_SYMBOLS.has(symbol.toUpperCase());
}

async function backfillAlpaca(symbol, start, end) {
  const bars = await fetchAlpacaBars({ symbol, timeframe: '1Min', start, end, limit: 10000 });
  if (bars.length === 0) {
    return { rawBars: 0, candles2m: 0, source: 'alpaca', warning: 'no data returned from Alpaca' };
  }

  const byDate = {};
  for (const bar of bars) {
    const date = (bar.ts || '').slice(0, 10);
    if (!date) continue;
    (byDate[date] = byDate[date] || []).push(bar);
  }

  let totalRaw = 0;
  let total2m  = 0;
  for (const [date, dateBars] of Object.entries(byDate)) {
    const saved = saveRawBars(symbol, date, dateBars, 'alpaca');
    if (saved > 0) totalRaw += saved;
    const candles = filterComplete(aggregate1mTo2m(dateBars));
    const saved2m = saveCandles2m(symbol, date, candles);
    if (saved2m > 0) total2m += saved2m;
  }

  return { rawBars: totalRaw, candles2m: total2m, source: 'alpaca' };
}

async function backfillBinance(symbol, start, end) {
  const bars = await fetchBinanceKlines({ symbol, interval: '1m', start, end, limit: 1000 });
  if (bars.length === 0) {
    return { rawBars: 0, candles2m: 0, source: 'binance', warning: 'no data returned from Binance' };
  }

  const byDate = {};
  for (const bar of bars) {
    const date = (bar.ts || '').slice(0, 10);
    if (!date) continue;
    (byDate[date] = byDate[date] || []).push(bar);
  }

  let totalRaw = 0;
  let total2m  = 0;
  for (const [date, dateBars] of Object.entries(byDate)) {
    const saved = saveRawBars(symbol, date, dateBars, 'binance');
    if (saved > 0) totalRaw += saved;
    const candles = filterComplete(aggregate1mTo2m(dateBars));
    const saved2m = saveCandles2m(symbol, date, candles);
    if (saved2m > 0) total2m += saved2m;
  }

  return { rawBars: totalRaw, candles2m: total2m, source: 'binance' };
}

// ── POST /api/data/backfill ───────────────────────────────────────────────────
// Stocks → Alpaca, crypto (USDT pairs) → Binance.
router.post('/data/backfill', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required (YYYY-MM-DD)' });
  }

  const stockSyms  = symbols.filter((s) => !isCrypto(s));
  const cryptoSyms = symbols.filter((s) =>  isCrypto(s));

  // Alpaca credentials required only if stock symbols are requested
  if (stockSyms.length > 0 && (!alpacaEnabled() || !hasCredentials())) {
    return res.status(503).json({
      ok: false,
      error: alpacaEnabled()
        ? 'Alpaca credentials not configured (set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY)'
        : 'ALPACA_ENABLED=false — backfill disabled',
    });
  }

  const result = {};

  for (const symbol of stockSyms) {
    try {
      result[symbol] = await backfillAlpaca(symbol, start, end);
    } catch (err) {
      result[symbol] = { error: err.message, source: 'alpaca' };
    }
  }

  for (const symbol of cryptoSyms) {
    try {
      result[symbol] = await backfillBinance(symbol, start, end);
    } catch (err) {
      result[symbol] = { error: err.message, source: 'binance' };
    }
  }

  res.json({ ok: true, start, end, result });
});

// ── GET /api/data/status ──────────────────────────────────────────────────────
router.get('/data/status', (req, res) => {
  try {
    const symbols = listSymbols();
    const status  = {};

    for (const symbol of symbols) {
      const dates   = listAvailableDates(symbol);
      const raw2m   = dates['2m'] || [];
      let totalCandles = 0;
      for (const date of raw2m) {
        totalCandles += countCandles(symbol, date, '2m');
      }
      status[symbol] = {
        datesRaw:    (dates.raw    || []).length,
        dates2m:     raw2m.length,
        dateRange:   raw2m.length > 0 ? { from: raw2m[0], to: raw2m[raw2m.length - 1] } : null,
        totalCandles2m: totalCandles,
      };
    }

    res.json({
      ok:      true,
      symbols: symbols.length,
      alpacaEnabled:  alpacaEnabled(),
      alpacaConfigured: hasCredentials(),
      data: status,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Historical Data Center v1 ───────────────────────────────────────────────
// Read-only inventory of historical storage. It never starts jobs or places orders.
function dataCenterOptions(req) {
  return { force: req.query.rebuild === '1' || req.query.force === '1' };
}

router.get('/data-center/status', async (req, res) => {
  try {
    res.json(await historicalDataCenter.getStatus(dataCenterOptions(req)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...historicalDataCenter.SAFETY });
  }
});

router.get('/data-center/summary', async (req, res) => {
  try {
    res.json(await historicalDataCenter.getSummary(dataCenterOptions(req)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...historicalDataCenter.SAFETY });
  }
});

router.get('/data-center/symbols', async (req, res) => {
  try {
    res.json(await historicalDataCenter.getSymbols(dataCenterOptions(req)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...historicalDataCenter.SAFETY });
  }
});

router.get('/data-center/storage', async (req, res) => {
  try {
    res.json(await historicalDataCenter.getStorage(dataCenterOptions(req)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...historicalDataCenter.SAFETY });
  }
});

router.get('/data-center/coverage', async (req, res) => {
  try {
    res.json(await historicalDataCenter.getCoverage(dataCenterOptions(req)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...historicalDataCenter.SAFETY });
  }
});

router.get('/data-center/missing', async (req, res) => {
  try {
    res.json(await historicalDataCenter.getMissing(dataCenterOptions(req)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...historicalDataCenter.SAFETY });
  }
});

// ── Data Coverage Expansion v1 ──────────────────────────────────────────────
// Read-only coverage + historical ingestion only. No trading config, no orders.
router.get('/data-coverage/status', (req, res) => {
  try { res.json(dataCoverageExpansion.getCoverageStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.get('/data-coverage/markets', (req, res) => {
  try { res.json(dataCoverageExpansion.getMarketCoverage()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.get('/data-coverage/symbols', (req, res) => {
  try { res.json(dataCoverageExpansion.getAllSymbolCoverage()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.get('/data-coverage/symbols/:symbol', (req, res) => {
  try { res.json(dataCoverageExpansion.getSymbolCoverage(req.params.symbol)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.get('/data-coverage/missing', (req, res) => {
  try { res.json(dataCoverageExpansion.getMissingSymbols()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.get('/data-coverage/plan', (req, res) => {
  try { res.json(dataCoverageExpansion.prioritizeDataBackfill()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.post('/data-coverage/backfill', (req, res) => {
  try {
    const result = dataCoverageExpansion.createBackfillPlan(req.body || {});
    res.status(result.ok ? 201 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY });
  }
});

router.get('/data-coverage/backfill', (req, res) => {
  try { res.json(dataCoverageExpansion.listBackfillJobs()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.get('/data-coverage/backfill/:jobId', (req, res) => {
  try {
    const result = dataCoverageExpansion.getBackfillStatus(req.params.jobId);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.post('/data-coverage/backfill/:jobId/run', (req, res) => {
  try {
    const result = dataCoverageExpansion.runBackfillJob(req.params.jobId);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.post('/data-coverage/backfill/:jobId/pause', (req, res) => {
  try {
    const result = dataCoverageExpansion.pauseBackfillJob(req.params.jobId);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

router.post('/data-coverage/backfill/:jobId/stop', (req, res) => {
  try {
    const result = dataCoverageExpansion.stopBackfillJob(req.params.jobId);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message, ...dataCoverageExpansion.SAFETY }); }
});

// ── POST /api/history/scan ────────────────────────────────────────────────────
router.post('/history/scan', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required' });
  }

  try {
    const summary = await runHistoricalScan({ symbols, start, end, timeframe: '2m' });
    res.json({ ok: true, start, end, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/history/analyze ─────────────────────────────────────────────────
router.post('/history/analyze', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required' });
  }

  try {
    const outcomeSummary  = await analyzeOutcomes({ symbols: symbols || [], start, end });
    const learningSummary = saveLearning({ start, end, symbols: symbols || [] });
    invalidateCache(); // rebuild edge cache after new outcomes
    res.json({ ok: true, start, end, outcomeSummary, learningSummary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/signals ──────────────────────────────────────────────────
router.get('/history/signals', (req, res) => {
  const symbol = req.query.symbol || null;
  const start  = req.query.start  || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const end    = req.query.end    || new Date().toISOString().slice(0, 10);
  const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  try {
    const signals = loadSignals(start, end, symbol);
    const sliced  = signals.slice(-limit);
    res.json({ ok: true, count: sliced.length, symbol, start, end, signals: sliced });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/outcomes ─────────────────────────────────────────────────
router.get('/history/outcomes', (req, res) => {
  const symbol = req.query.symbol || null;
  const start  = req.query.start  || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const end    = req.query.end    || new Date().toISOString().slice(0, 10);
  const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  try {
    const outcomes = loadOutcomes(start, end, symbol);
    const sliced   = outcomes.slice(-limit);
    res.json({ ok: true, count: sliced.length, symbol, start, end, outcomes: sliced });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/history/hunt-signals ────────────────────────────────────────────
// Alias for /api/history/scan with cache invalidation after run.
router.post('/history/hunt-signals', async (req, res) => {
  const { symbols, start, end } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required (YYYY-MM-DD)' });
  }

  try {
    const summary = await runHistoricalScan({ symbols, start, end, timeframe: '2m' });
    invalidateCache(); // edge cache must be rebuilt after new signals
    res.json({ ok: true, start, end, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/edge ─────────────────────────────────────────────────────
router.get('/history/edge', (req, res) => {
  const symbol = req.query.symbol || null;
  try {
    if (symbol) {
      res.json({ ok: true, ...getEdgeForSymbol(symbol) });
    } else {
      res.json({ ok: true, edge: getEdge({}) }); // global fallback
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/edge-summary ────────────────────────────────────────────
router.get('/history/edge-summary', (req, res) => {
  try {
    res.json(getEdgeSummary());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══ Learning Connector (DEL 8) ════════════════════════════════════════════════
// Tunn brygga mellan testerna (scanner/paper/replay/batch/agenter) och hjärnan.
// Connectorn lägger ALDRIG order — alla svar bär safety-flaggorna.

// GET /api/learning/connector/status — är connectorn aktiv och vilka källor matar?
router.get('/learning/connector/status', (req, res) => {
  try {
    res.json(learningConnector.getConnectorStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/learning/strategies — alla strategiers learning-profiler
router.get('/learning/strategies', (req, res) => {
  try {
    res.json(learningConnector.getAllStrategyLearningProfiles());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/learning/strategy/:strategyId — en strategis learning-profil
router.get('/learning/strategy/:strategyId', (req, res) => {
  try {
    const out = learningConnector.getStrategyLearningProfile(req.params.strategyId);
    res.status(out.ok ? 200 : 404).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/learning/latest-summary — senaste connector-summary (för AI Summary)
router.get('/learning/latest-summary', (req, res) => {
  try {
    let summary = learningConnector.loadLatestSummary();
    if (!summary) summary = learningConnector.buildLearningSummary();
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/learning/rebuild — bygg om connector-summary från event-loggen
router.post('/learning/rebuild', (req, res) => {
  try {
    const summary = learningConnector.buildLearningSummary();
    res.json({ ok: true, summary, rebuilt_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Supervisor Operations Advisor ─────────────────────────────────────────────
// Read-only summary over existing learning, runtime, paper and gate histories.

router.get('/supervisor/operations-advisor', (req, res) => {
  try {
    const window = req.query.window || '1d';
    res.json(supervisorOperationsAdvisorService.getOperationsAdvisor(window));
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      ...supervisorOperationsAdvisorService.SAFETY,
    });
  }
});

// ── GET /api/history/learning-summary ────────────────────────────────────────
router.get('/history/learning-summary', (req, res) => {
  try {
    // Prefer Learning Engine v1 summary (new format with full dimensions)
    let summary = loadLearningSummary();
    // Fall back to legacy signalLearning summary if v1 hasn't run yet
    if (!summary) summary = loadLearning();
    if (!summary) {
      return res.json({ ok: true, summary: null, message: 'Ingen learning-summary ännu — kör POST /api/history/update-learning' });
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/rule-memory ─────────────────────────────────────────────
router.get('/history/rule-memory', (req, res) => {
  try {
    const memory = loadRuleMemory();
    if (!memory) {
      return res.json({ ok: true, memory: null, message: 'Ingen rule-memory ännu — kör POST /api/history/update-learning' });
    }
    res.json({ ok: true, memory });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/symbol-profiles ─────────────────────────────────────────
router.get('/history/symbol-profiles', (req, res) => {
  try {
    const profiles = loadSymbolProfiles();
    if (!profiles) {
      return res.json({ ok: true, profiles: null, message: 'Inga symbol-profiler ännu — kör POST /api/history/update-learning' });
    }
    const symbol = req.query.symbol || null;
    if (symbol) {
      const p = profiles.symbols?.[symbol.toUpperCase()];
      if (!p) return res.status(404).json({ ok: false, error: `Ingen profil för ${symbol}` });
      return res.json({ ok: true, symbol: symbol.toUpperCase(), profile: p, globalWinRate: profiles.globalWinRate });
    }
    res.json({ ok: true, profiles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/regime-profiles ─────────────────────────────────────────
router.get('/history/regime-profiles', (req, res) => {
  try {
    const profiles = loadRegimeProfiles();
    if (!profiles) {
      return res.json({ ok: true, profiles: null, message: 'Inga regime-profiler ännu — kör POST /api/history/update-learning' });
    }
    const regime = req.query.regime || null;
    if (regime) {
      const p = profiles.regimes?.[regime.toUpperCase()];
      if (!p) return res.status(404).json({ ok: false, error: `Ingen profil för regime ${regime}` });
      return res.json({ ok: true, regime: regime.toUpperCase(), profile: p, globalWinRate: profiles.globalWinRate });
    }
    res.json({ ok: true, profiles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/score-calibration ───────────────────────────────────────
router.get('/history/score-calibration', (req, res) => {
  try {
    const calibration = loadScoreCalibration();
    if (!calibration) {
      return res.json({ ok: true, calibration: null, message: 'Ingen kalibrering ännu — kör POST /api/history/update-learning' });
    }
    res.json({ ok: true, calibration });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/fakeout-dna ─────────────────────────────────────────────
router.get('/history/fakeout-dna', (req, res) => {
  try {
    const dna = loadFakeoutDna();
    if (!dna) return res.json({ ok: true, dna: null, message: 'Kör Auto Machine för att bygga Fakeout DNA.' });
    res.json({ ok: true, dna });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/rule-health ──────────────────────────────────────────────
router.get('/history/rule-health', (req, res) => {
  try {
    const health = loadRuleHealth();
    if (!health) return res.json({ ok: true, health: null, message: 'Kör Auto Machine för att bygga Rule Health.' });
    res.json({ ok: true, health });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/momentum-backtest ───────────────────────────────────────
router.get('/history/momentum-backtest', (req, res) => {
  try {
    let report = loadMomentumBacktest();
    if (!report && req.query.build === 'true') report = buildMomentumBacktest();
    if (!report) return res.json({ ok: true, report: null, message: 'Kör Auto Machine eller ?build=true för att bygga Momentum Intelligence Backtest.' });
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/micro-move-analysis ─────────────────────────────────────
router.get('/history/micro-move-analysis', (req, res) => {
  try {
    let report = loadMicroMoveAnalysis();
    if (!report && req.query.build === 'true') report = buildMicroMoveAnalysis();
    if (!report) return res.json({ ok: true, report: null, message: 'Kör Auto Machine eller ?build=true för att bygga Micro Move Analysis.' });
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/market/personality ───────────────────────────────────────────────
router.get('/market/personality', (req, res) => {
  try {
    const group  = req.query.group || null;
    const stocks = loadPersonality('stocks');
    const crypto = loadPersonality('crypto');
    if (group === 'stocks') return res.json({ ok: true, personality: stocks });
    if (group === 'crypto') return res.json({ ok: true, personality: crypto });
    res.json({ ok: true, stocks, crypto });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/signal-quality ──────────────────────────────────────────
router.get('/history/signal-quality', (req, res) => {
  try {
    const days  = Math.min(parseInt(req.query.days,  10) || 7, 30);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const result = analyzeSignalQuality({ days, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/history/missed-breakouts ────────────────────────────────────────
const { findMissedBreakouts } = require('../history/missedBreakoutFinder');

router.get('/history/missed-breakouts', (req, res) => {
  const { limit, days, symbol, onlyBlocked } = req.query;
  try {
    const start = days
      ? new Date(Date.now() - parseInt(days, 10) * 86400000).toISOString().slice(0, 10)
      : req.query.start || undefined;
    const end   = days ? new Date().toISOString().slice(0, 10) : req.query.end || undefined;
    const items = findMissedBreakouts({
      start, end,
      limit,
      symbol:      symbol      || null,
      onlyBlocked: onlyBlocked === 'true',
    });
    res.json({ ok: true, count: items.length, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/history/update-learning ────────────────────────────────────────
router.post('/history/update-learning', async (req, res) => {
  try {
    const summary = runLearningEngine();

    // Build rule memory, symbol profiles and regime profiles after learning summary is fresh
    let ruleMemorySummary     = null;
    let symbolProfilesSummary = null;
    let regimeProfilesSummary = null;

    try {
      const rm = buildRuleMemory();
      ruleMemorySummary = { totalRules: rm.totalRules, watchModeRules: rm.watchModeRules };
    } catch (rmErr) {
      console.warn('[API] buildRuleMemory failed (non-fatal):', rmErr.message);
    }

    try {
      const sp = buildSymbolProfiles();
      symbolProfilesSummary = {
        totalSymbols:    sp.totalSymbols,
        highConfSymbols: sp.highConfSymbols,
        watchSymbols:    sp.watchSymbols,
        strongSymbols:   sp.strongSymbols,
      };
    } catch (spErr) {
      console.warn('[API] buildSymbolProfiles failed (non-fatal):', spErr.message);
    }

    try {
      const rp = buildRegimeProfiles();
      regimeProfilesSummary = {
        totalRegimes:    rp.totalRegimes,
        highConfRegimes: rp.highConfRegimes,
        bestRegime:      rp.bestRegime,
        worstRegime:     rp.worstRegime,
      };
    } catch (rpErr) {
      console.warn('[API] buildRegimeProfiles failed (non-fatal):', rpErr.message);
    }

    res.json({
      ok:              true,
      updatedAt:       summary.updatedAt,
      totalSignals:    summary.totalSignals,
      totalOutcomes:   summary.totalOutcomes,
      overallWinRate:  summary.overallWinRate,
      bestSymbols:     summary.bestSymbols,
      bestEventTypes:  summary.bestEventTypes,
      bestHours:       summary.bestHours,
      bestScoreRanges: summary.bestScoreRanges,
      insightsSv:      summary.insightsSv,
      ruleMemory:      ruleMemorySummary,
      symbolProfiles:  symbolProfilesSummary,
      regimeProfiles:  regimeProfilesSummary,
    });
  } catch (err) {
    console.error('[API] update-learning error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REPLAY ENGINE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Replay Intelligence v2 session routes ───────────────────────────────────
router.get('/replay/sessions', (req, res) => {
  try {
    res.json({ ok: true, sessions: replayIntelligenceService.listReplaySessions() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/replay/sessions', async (req, res) => {
  try {
    const session = await replayIntelligenceService.createReplaySession(req.body || {});
    res.status(201).json({ ok: true, session });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/replay/risk-fixture', async (req, res) => {
  try {
    const result = await replayIntelligenceService.runRiskFixtureReplay();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/replay/sessions/:id', (req, res) => {
  try {
    const session = replayIntelligenceService.getReplaySessionStatus(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'Replay session not found' });
    res.json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/replay/sessions/:id/run', async (req, res) => {
  try {
    const session = await replayIntelligenceService.runReplaySession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'Replay session not found' });
    res.json({ ok: true, session });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/replay/sessions/:id/pause', async (req, res) => {
  try {
    const session = await replayIntelligenceService.pauseReplaySession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'Replay session not found' });
    res.json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/replay/sessions/:id/stop', async (req, res) => {
  try {
    const session = await replayIntelligenceService.stopReplaySession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'Replay session not found' });
    res.json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/replay/sessions/:id/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  try {
    const session = replayIntelligenceService.getReplaySessionStatus(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'Replay session not found' });
    const events = replayIntelligenceService.getReplayEvents(req.params.id).slice(-limit);
    res.json({ ok: true, sessionId: req.params.id, count: events.length, events });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/replay/sessions/:id/summary', async (req, res) => {
  try {
    const summary = await replayIntelligenceService.summarizeReplaySession(req.params.id);
    if (!summary) return res.status(404).json({ ok: false, error: 'Replay session not found' });
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/replay/run ──────────────────────────────────────────────────────
router.post('/replay/run', async (req, res) => {
  const { symbols, start, end, mode = 'scan_only' } = req.body || {};

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ ok: false, error: 'symbols array required' });
  }
  if (!start || !end) {
    return res.status(400).json({ ok: false, error: 'start and end dates required (YYYY-MM-DD)' });
  }
  if (!['scan_only', 'with_outcomes', 'debug'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'mode must be scan_only | with_outcomes | debug' });
  }

  try {
    const { runId, summary } = await runReplay({ symbols, start, end, mode });
    res.json({ ok: true, runId, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/runs ──────────────────────────────────────────────────────
router.get('/replay/runs', (req, res) => {
  try {
    res.json({ ok: true, runs: listRuns() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/runs/:runId ───────────────────────────────────────────────
router.get('/replay/runs/:runId', (req, res) => {
  const { runId } = req.params;
  try {
    const summary  = loadRunSummary(runId);
    const insights = loadRunInsights(runId);
    if (!summary) return res.status(404).json({ ok: false, error: 'Run not found' });
    res.json({ ok: true, summary, insights });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/runs/:runId/events ───────────────────────────────────────
router.get('/replay/runs/:runId/events', (req, res) => {
  const { runId } = req.params;
  const symbol    = req.query.symbol || null;
  const limit     = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  try {
    const events = loadRunEvents(runId, { symbol, limit });
    res.json({ ok: true, runId, symbol, count: events.length, events });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/replay/compare ───────────────────────────────────────────────────
router.get('/replay/compare', (req, res) => {
  const { runA, runB } = req.query;
  if (!runA || !runB) {
    return res.status(400).json({ ok: false, error: 'runA and runB query params required' });
  }
  try {
    const a = loadRunSummary(runA);
    const b = loadRunSummary(runB);
    if (!a) return res.status(404).json({ ok: false, error: `Run ${runA} not found` });
    if (!b) return res.status(404).json({ ok: false, error: `Run ${runB} not found` });
    res.json({
      ok: true,
      comparison: {
        runA: { runId: runA, summary: a },
        runB: { runId: runB, summary: b },
        diff: {
          avgTradeScore: round2(a.avgTradeScore, b.avgTradeScore),
          totalEvents:   { a: a.totalEvents, b: b.totalEvents },
          symbols:       { a: a.symbols, b: b.symbols },
        },
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function round2(a, b) {
  if (a == null || b == null) return null;
  return { a, b, delta: Math.round((b - a) * 10) / 10 };
}

// ── GET /api/system/auto-machine-status ───────────────────────────────────────
router.get('/system/auto-machine-status', (req, res) => {
  try {
    const status = getAutoMachineStatus();
    res.json({
      ok:      true,
      running: autoMachineRunning(),
      enabled: (process.env.AUTO_MACHINE_ENABLED || 'false').toLowerCase() === 'true',
      config: {
        intervalMinutes: parseInt(process.env.AUTO_MACHINE_INTERVAL_MINUTES || '60', 10),
        lookbackDays:    parseInt(process.env.AUTO_MACHINE_LOOKBACK_DAYS    || '7',  10),
        groups:          (process.env.AUTO_MACHINE_GROUPS || 'stocks,crypto').split(',').map((g) => g.trim()),
      },
      status: status || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/system/scheduler-status ─────────────────────────────────────────
router.get('/system/scheduler-status', (req, res) => {
  try {
    res.json({ ok: true, ...getSchedulerStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/system/health ───────────────────────────────────────────────────
router.get('/system/health', (req, res) => {
  try {
    const health = buildSystemHealth();
    const healthAlerts = alertsFromSystemHealth(health);
    recordAlerts(healthAlerts);
    resolveMissingSystemAlerts(healthAlerts.map((a) => a.key));
    processSystemHealth(health).catch((err) => console.warn('[Notifier] system processing failed:', err.message));
    notificationEngineV2.processSystemHealth(health).catch((err) => console.warn('[notification-v2] system processing failed:', err.message));
    res.json(health);
  } catch (err) {
    res.status(500).json({
      ok: false,
      overallStatus: 'CRITICAL',
      summarySv: `Kritiskt fel vid health-check: ${err.message}`,
      components: [],
      alerts: [{
        type: 'system',
        severity: 'critical',
        titleSv: 'Health-check misslyckades',
        messageSv: err.message,
        suggestedActionSv: 'Kontrollera serverloggar och senaste deploy.',
        createdAt: new Date().toISOString(),
      }],
    });
  }
});

// ── GET /api/alerts ──────────────────────────────────────────────────────────
router.get('/alerts', (req, res) => {
  try {
    const health = buildSystemHealth();
    const liveResults = [...getLatestResults(), ...getCryptoResults()];
    processSystemHealth(health).catch((err) => console.warn('[Notifier] system processing failed:', err.message));
    const healthAlerts = alertsFromSystemHealth(health);
    const liveAlerts = alertsFromScannerResults(liveResults, 'live');
    const generated = recordAlerts([
      ...healthAlerts,
      ...liveAlerts,
    ]);
    notificationEngineV2.processSystemHealth(health).catch((err) => console.warn('[notification-v2] system processing failed:', err.message));
    const resolvedHealth = resolveMissingSystemAlerts(healthAlerts.map((a) => a.key), 'systemHealth');
    const resolvedLive = resolveMissingSystemAlerts(liveAlerts.map((a) => a.key), 'live');
    const includeAcknowledged = req.query.includeAcknowledged === 'true';
    const limit = parseInt(req.query.limit || '200', 10);
    const alerts = getAlerts({ includeAcknowledged, statuses: ['active'], limit });
    const resolvedLast24h = getAlerts({
      includeAcknowledged: true,
      includeResolved: true,
      statuses: ['resolved'],
      recentMs: RESOLVED_RECENT_MS,
      limit: 100,
    });
    const historyCount = getAlerts({ includeAcknowledged: true, includeResolved: true, limit: 500 }).length;
    res.json({
      ok: true,
      count: alerts.length,
      generated: generated.length,
      autoResolved: resolvedHealth.resolved + resolvedLive.resolved,
      historyCount,
      systemHealth: {
        ok: health.ok,
        overallStatus: health.overallStatus,
        summarySv: health.summarySv,
        generatedAt: health.generatedAt,
        stockFeed: health.stockFeed,
      },
      alerts,
      resolvedLast24h,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/alerts/acknowledge ─────────────────────────────────────────────
router.post('/alerts/acknowledge', (req, res) => {
  try {
    const ids = req.body?.ids || req.body?.id;
    const result = acknowledgeAlerts(ids);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/notifications/test ─────────────────────────────────────────────
router.post('/notifications/test', async (req, res) => {
  try {
    const result = await sendTestMessage();
    if (!result.ok) {
      return res.status(503).json({ ok: false, sent: false, reason: result.reason || 'not_configured' });
    }
    res.json({ ok: true, sent: true, provider: result.provider || null });
  } catch (err) {
    console.warn('[Notifier] test failed:', err.message);
    res.status(500).json({ ok: false, error: 'notification_test_failed' });
  }
});

// ── Notification Engine v2 ───────────────────────────────────────────────────
router.get('/notifications/status', async (req, res) => {
  try {
    res.json(await notificationEngineV2.getStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/notifications/config', async (req, res) => {
  try {
    res.json({
      ok: true,
      config: await notificationEngineV2.getConfig(),
      keys: notificationEngineV2.KEYS,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/notifications/config', async (req, res) => {
  try {
    const result = await notificationEngineV2.updateConfig(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/notifications/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    res.json({
      ok: true,
      source: notificationEngineV2.SOURCE,
      recent: await notificationEngineV2.getRecentAlerts(limit),
      status: await notificationEngineV2.getStatus(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/notifications/test-v2', async (req, res) => {
  try {
    const body = req.body || {};
    const type = body.type || 'TEST_ALERT';

    if (body.replay_mode === true) {
      return res.json({ ok: false, blocked: true, reason: 'replay_mode_blocked' });
    }

    const dryRun = body.dry_run !== false;
    const confirmLive = body.confirm_live_send === true;

    if (!dryRun && !confirmLive) {
      return res.json({ ok: false, blocked: true, reason: 'missing_confirm_live_send' });
    }

    if (!dryRun && confirmLive) {
      const now = Date.now();
      const remaining = TEST_LIVE_SEND_COOLDOWN_MS - (now - testLiveSendLastAt);
      if (remaining > 0) {
        return res.json({ ok: false, blocked: true, reason: 'test_rate_limited', retry_after_seconds: Math.ceil(remaining / 1000) });
      }
      testLiveSendLastAt = now;
      const result = await notificationEngineV2.runTestAlert(type);
      return res.json({ ok: true, type, dry_run: false, result });
    }

    const result = await notificationEngineV2.runTestAlert(type, { dry_run: true });
    return res.json({ ok: true, type, dry_run: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/system/run-auto-machine ─────────────────────────────────────────
router.post('/system/run-auto-machine', async (req, res) => {
  if (autoMachineRunning()) {
    return res.status(409).json({ ok: false, error: 'Auto-machine already running' });
  }

  const lookbackDays = parseInt(
    req.body?.lookbackDays ?? process.env.AUTO_MACHINE_LOOKBACK_DAYS ?? '7',
    10
  );
  const groupsRaw = req.body?.groups ?? process.env.AUTO_MACHINE_GROUPS ?? 'stocks,crypto';
  const groups    = (Array.isArray(groupsRaw) ? groupsRaw : String(groupsRaw).split(',')).map((g) => g.trim()).filter(Boolean);

  if (isNaN(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
    return res.status(400).json({ ok: false, error: 'lookbackDays must be 1–90' });
  }
  if (groups.length === 0) {
    return res.status(400).json({ ok: false, error: 'groups must be a non-empty list (stocks, crypto)' });
  }

  // Fire and return immediately so the client is not blocked
  res.json({ ok: true, message: 'Auto-machine pipeline started', lookbackDays, groups });

  runAutoMachine({ lookbackDays, groups }).catch((err) => {
    console.error('[API] run-auto-machine unhandled error:', err.message);
  });
});

// ── GET /api/review/chart-data ────────────────────────────────────────────────
function calcSMA(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    result[i] = sum / period;
  }
  return result;
}

router.get('/review/chart-data', (req, res) => {
  try {
    const symbol        = (req.query.symbol || '').toUpperCase();
    const timestamp     = req.query.timestamp || '';
    const windowBefore  = Math.min(parseInt(req.query.windowBefore, 10) || 80, 300);
    const windowAfter   = Math.min(parseInt(req.query.windowAfter,  10) || 40, 300);

    if (!symbol || !timestamp) {
      return res.status(400).json({ ok: false, error: 'symbol and timestamp are required' });
    }

    const ts = new Date(timestamp);
    if (isNaN(ts.getTime())) {
      return res.status(400).json({ ok: false, error: 'invalid timestamp' });
    }

    const msPerCandle = 2 * 60 * 1000;

    // Stocks trade ~195 2m candles/day; SMA200 needs ≥200 candles before the window.
    // Always load 5 calendar days back so weekends/holidays don't starve the warmup.
    const SMA200_CALENDAR_DAYS = 5;
    const warmupDate = new Date(ts.getTime() - SMA200_CALENDAR_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const endMs  = ts.getTime() + (windowAfter + 10) * msPerCandle;
    const endDate = new Date(endMs).toISOString().slice(0, 10);

    const warmupCandles = loadCandles(symbol, warmupDate, endDate);

    if (warmupCandles.length === 0) {
      return res.status(404).json({ ok: false, error: `Ingen data hittades för ${symbol}` });
    }

    // Calculate SMA over all warmup candles
    const closes   = warmupCandles.map(c => c.close ?? c.c ?? 0);
    const sma20arr  = calcSMA(closes, 20);
    const sma200arr = calcSMA(closes, 200);

    // Find candle closest to signal timestamp in warmup array
    const tsMs = ts.getTime();
    let fullSignalIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < warmupCandles.length; i++) {
      const cMs = new Date(warmupCandles[i].ts || warmupCandles[i].t).getTime();
      const diff = Math.abs(cMs - tsMs);
      if (diff < minDiff) { minDiff = diff; fullSignalIdx = i; }
    }
    const exactSignalIdx = minDiff <= msPerCandle + 30000 ? fullSignalIdx : -1;
    const usedFallbackTimestamp = exactSignalIdx < 0 && fullSignalIdx >= 0;

    // Slice to display window only
    const startIdx = fullSignalIdx >= 0 ? Math.max(0, fullSignalIdx - windowBefore) : 0;
    const endIdx   = fullSignalIdx >= 0 ? Math.min(warmupCandles.length - 1, fullSignalIdx + windowAfter) : warmupCandles.length - 1;
    const slice    = warmupCandles.slice(startIdx, endIdx + 1);
    const newSignalIdx = fullSignalIdx >= 0 ? fullSignalIdx - startIdx : -1;

    const round4 = v => v != null ? Math.round(v * 10000) / 10000 : null;

    const candles = slice.map((c, i) => {
      const absIdx = startIdx + i;
      return {
        time:   Math.floor(new Date(c.ts || c.t).getTime() / 1000),
        open:   c.open   ?? c.o,
        high:   c.high   ?? c.h,
        low:    c.low    ?? c.l,
        close:  c.close  ?? c.c,
        volume: c.volume ?? c.v,
        sma20:  round4(sma20arr[absIdx]),
        sma200: round4(sma200arr[absIdx]),
      };
    });

    const hasSMA200 = candles.some(c => c.sma200 != null);

    const matchedTimestamp = fullSignalIdx >= 0
      ? (warmupCandles[fullSignalIdx].ts || warmupCandles[fullSignalIdx].t || null)
      : null;

    return res.json({
      ok: true,
      symbol,
      timestamp,
      requestedTimestamp: timestamp,
      matchedTimestamp,
      timestampFallback: usedFallbackTimestamp,
      signalCandleIdx: newSignalIdx,
      hasSMA200,
      candles,
    });
  } catch (err) {
    console.error('[review/chart-data]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Paper Trading ─────────────────────────────────────────────────────────────
// All endpoints are paper-only. No real orders are placed, ever.

router.get('/paper-trading/status', (req, res) => {
  try { res.json(paperTrading.getStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/live-state', async (req, res) => {
  try {
    const fallback = paperTrading.getLiveState ? paperTrading.getLiveState() : {
      ok: true,
      status: paperTrading.getStatus(),
      performance: paperTrading.getPerformance(),
      gateStatus: paperTrading.getGateStatus(),
    };
    const cached = await redisService.getJson('paper:live-state', fallback);
    res.json({
      ok: true,
      source: redisService.status().redisAvailable ? 'redis' : 'fallback',
      state: cached || fallback,
      redis: redisService.status(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/paper-trading/trades', (req, res) => {
  try { res.json(paperTrading.getTrades()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/performance', (req, res) => {
  try { res.json(paperTrading.getPerformance()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/events', (req, res) => {
  try { res.json(paperTrading.getEvents()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/paper-trading/start', (req, res) => {
  try { res.json(paperTrading.start()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/paper-trading/stop', (req, res) => {
  try { res.json(paperTrading.stop()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/calibration-report', (req, res) => {
  try { res.json(paperTrading.getCalibrationReport()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/compass', (req, res) => {
  try { res.json({ ok: true, ...paperTrading.getCompassStatus() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/gate-status', (req, res) => {
  try { res.json(paperTrading.getGateStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/gate-history', (req, res) => {
  try { res.json(paperTrading.getGateHistory()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/gate-decisions', (req, res) => {
  try { res.json(paperTrading.getGateDecisions()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/gate-decisions-history', (req, res) => {
  try {
    res.json(paperTrading.getGateDecisionsHistory({
      limit: req.query.limit,
      since: req.query.since,
    }));
  } catch (err) {
    res.json({ ok: true, count: 0, decisions: [], error: err.message });
  }
});

router.get('/paper-trading/decision-pipeline', (req, res) => {
  try { res.json(paperTrading.getDecisionPipeline()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/paper-trading/gate-effectiveness', (req, res) => {
  try { res.json({ ok: true, report: paperTrading.getGateEffectivenessReport() }); }
  catch (err) { res.json({ ok: false, error: err.message, report: emptyGateEffectivenessReport() }); }
});

// ── System Intelligence Agent v1 ─────────────────────────────────────────────
// Read-only: actions_allowed=false, can_modify_system=false always.

router.get('/intelligence/status', (req, res) => {
  try { res.json(intelligenceAgent.getAgentStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/intelligence/context', async (req, res) => {
  try { res.json(await intelligenceAgent.buildSystemContext()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/intelligence/analyze', async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ ok: false, error: 'question required' });
    }
    res.json(await intelligenceAgent.analyzeSystem(question.slice(0, 500)));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/intelligence/diagnostics/no-trades', async (req, res) => {
  try { res.json(await intelligenceAgent.diagnoseNoTrades()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/intelligence/diagnostics/timeouts', async (req, res) => {
  try { res.json(await intelligenceAgent.diagnoseTimeouts()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/intelligence/recommendations', async (req, res) => {
  try { res.json(await intelligenceAgent.getRecommendations()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/intelligence/explain/latest/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase().slice(0, 20);
    res.json(await intelligenceAgent.explainLatestDecision(symbol));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── TradingAgents v1 ──────────────────────────────────────────────────────────
// Read-only research layer: can_place_orders=false, actions_allowed=false always.

router.get('/tradingagents/status', async (req, res) => {
  try { res.json(await tradingAgentsAdapter.getTradingAgentsStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/tradingagents/analyze', async (req, res) => {
  try {
    const context = req.body || {};
    if (!context.symbol || typeof context.symbol !== 'string') {
      return res.status(400).json({ ok: false, error: 'symbol required' });
    }
    const safe = { ...context, can_place_orders: false, actions_allowed: false };
    res.json(await tradingAgentsAdapter.analyzeWithTradingAgents(safe));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/tradingagents/latest/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase().slice(0, 20);
    res.json(await tradingAgentsAdapter.getLatestAnalysis(symbol));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Agent Debate Engine v1 ───────────────────────────────────────────────────
// Regelbaserad analysis_only/paper_only. Ingen LLM, inga ordervägar.

router.get('/agent-debate/status', (req, res) => {
  try {
    res.json(agentDebateEngine.getStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...agentDebateEngine.SAFETY });
  }
});

router.post('/agent-debate/analyze-signal', (req, res) => {
  try {
    const result = agentDebateEngine.analyzeSignal(req.body || {});
    res.status(result.ok === false ? 400 : 200).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...agentDebateEngine.SAFETY });
  }
});

// ── TradingAgents Result Memory v1 ────────────────────────────────────────────
// Read-only: actions_allowed=false, can_place_orders=false always.

router.get('/tradingagents/results/status', async (req, res) => {
  try {
    const global = await tradingAgentsResultMemory.getTradingAgentsGlobalStats();
    res.json({ ok: true, ...global, ...tradingAgentsResultMemory.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/tradingagents/results/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase().slice(0, 20);
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
    res.json(await tradingAgentsResultMemory.buildResultMemorySummary(symbol));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/tradingagents/lessons/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase().slice(0, 20);
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
    res.json(await tradingAgentsResultMemory.getTradingAgentsLessons(symbol));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/tradingagents/results/reset/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase().slice(0, 20);
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
    res.json(await tradingAgentsResultMemory.resetTradingAgentsResultMemoryForSymbol(symbol));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Setup Performance v1 ─────────────────────────────────────────────────────
router.get('/setups/status', async (req, res) => {
  try { res.json(await setupPerformance.getStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/setups/performance', async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    res.json(await setupPerformance.getPerformance(force));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/setups/top', async (req, res) => {
  try {
    const n = Math.min(Number(req.query.n) || 5, 20);
    res.json(await setupPerformance.getTopSetups(n));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/setups/worst', async (req, res) => {
  try {
    const n = Math.min(Number(req.query.n) || 5, 20);
    res.json(await setupPerformance.getWorstSetups(n));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/setups/:setupId', async (req, res) => {
  try {
    const { setupId } = req.params;
    if (!/^[a-z0-9_]{3,80}$/.test(setupId)) {
      return res.status(400).json({ ok: false, error: 'Invalid setupId format' });
    }
    const result = await setupPerformance.getSetupById(setupId);
    if (!result) return res.status(404).json({ ok: false, error: 'Setup not found' });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Setup Focus Mode v1 ───────────────────────────────────────────────────────
router.get('/setups/focus/status', async (req, res) => {
  try { res.json(await setupFocusMode.getFocusModeStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/setups/focus/config', async (req, res) => {
  try { res.json(await setupFocusMode.getFocusConfig()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/setups/focus/config', async (req, res) => {
  try {
    const result = await setupFocusMode.updateFocusConfig(req.body);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/setups/focus/top', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 3, 10);
    const top   = await setupFocusMode.selectTopSetups(limit);
    res.json({ ok: true, setups: top, count: top.length, ...setupFocusMode.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/setups/focus/recommendation', async (req, res) => {
  try { res.json(await setupFocusMode.buildFocusRecommendation()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── AI Optimization Agent ─────────────────────────────────────────────────────
router.get('/optimization/status', (req, res) => {
  try { res.json(aiOptimizationAgent.getOptimizationStatus()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/summary', (req, res) => {
  try {
    const force = req.query.rebuild === '1';
    const data  = force ? aiOptimizationAgent.buildOptimizationSummary() : aiOptimizationAgent.getCachedSummary();
    res.json(data);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/top-configs', (req, res) => {
  try {
    const configs = aiOptimizationAgent.rankBestConfigurations();
    res.json({ ok: true, configs, count: configs.length, ...aiOptimizationAgent.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/weak-configs', (req, res) => {
  try {
    const configs = aiOptimizationAgent.detectWeakConfigurations();
    res.json({ ok: true, configs, count: configs.length, ...aiOptimizationAgent.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/exits', (req, res) => {
  try { res.json(aiOptimizationAgent.suggestExitImprovements()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/holding-times', (req, res) => {
  try { res.json(aiOptimizationAgent.suggestHoldingTimeImprovements()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/stop-loss', (req, res) => {
  try { res.json(aiOptimizationAgent.suggestStopLossImprovements()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/combinations', (req, res) => {
  try { res.json(aiOptimizationAgent.suggestSignalCombinations()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/recommendations', (req, res) => {
  try {
    const summary = aiOptimizationAgent.getCachedSummary();
    res.json({ ok: true, recommendations: summary.recommendations, ...aiOptimizationAgent.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/optimization/recommended-config', (req, res) => {
  try {
    res.json({ ok: true, ...aiOptimizationAgent.getRecommendedConfig() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Market Universe ───────────────────────────────────────────────────────────
router.get('/markets/universe', (req, res) => {
  try { res.json({ ok: true, ...marketUniverse.getUniverse() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/markets/universe', (req, res) => {
  try {
    let result;
    if (req.body.groups)  result = marketUniverse.updateGroups(req.body.groups);
    if (req.body.symbols) result = marketUniverse.updateSymbols(req.body.symbols);
    res.json({ ok: true, ...(result || marketUniverse.getUniverse()) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/markets/symbols/add', (req, res) => {
  try { res.json(marketUniverse.addSymbol(req.body)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/markets/symbols/remove', (req, res) => {
  try { res.json(marketUniverse.removeSymbol(req.body.symbol)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/markets/symbols/patch', (req, res) => {
  try { res.json(marketUniverse.patchSymbol(req.body.symbol, req.body.patch)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Strategy Catalog ──────────────────────────────────────────────────────────
router.get('/strategies/catalog', (req, res) => {
  try { res.json({ ok: true, ...strategyCatalog.getCatalog() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/strategies/presets', (req, res) => {
  try { res.json({ ok: true, ...strategyCatalog.getPresets() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/strategies/presets', (req, res) => {
  try {
    if (req.body.action === 'save')   return res.json(strategyCatalog.saveCustomPreset(req.body.preset));
    if (req.body.action === 'delete') return res.json(strategyCatalog.deleteCustomPreset(req.body.id));
    res.status(400).json({ ok: false, error: 'action must be save or delete' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Blocker Config ────────────────────────────────────────────────────────────
router.get('/blockers/config', (req, res) => {
  try { res.json({ ok: true, ...blockerConfig.getBlockerConfig() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/blockers/config', (req, res) => {
  try { res.json(blockerConfig.updateBlockerConfig(req.body)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Candidate Log ─────────────────────────────────────────────────────────────
router.get('/candidates/recent', (req, res) => {
  try {
    res.json({ ok: true, candidates: candidateLog.loadRecent(parseInt(req.query.n) || 50), ...candidateLog.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/candidates/stats', (req, res) => {
  try { res.json({ ok: true, ...candidateLog.getStats() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Market Regime / Adaptive Market Intelligence ──────────────────────────────
router.get('/market-regime/status', (req, res) => {
  try {
    const force = req.query.rebuild === '1';
    res.json(marketRegime.buildRegimeSummary(force));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/market-regime/history', (req, res) => {
  try { res.json(marketRegime.getRegimeHistory()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/market-regime/strategies', (req, res) => {
  try { res.json(marketRegime.getRegimeStrategies()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/market-regime/weights', (req, res) => {
  try {
    const regime  = marketRegime.detectMarketRegime();
    const weights = marketRegime.calculateStrategyWeights(regime);
    res.json({ ok: true, ...weights, ...marketRegime.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/market-regime/bias', (req, res) => {
  try {
    const bias = marketRegime.buildMarketBias();
    res.json({ ok: true, ...bias, ...marketRegime.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/market-regime/heatmap', (req, res) => {
  try {
    const heatmap = marketRegime.buildMarketHeatmap();
    res.json({ ok: true, heatmap, count: heatmap.length, ...marketRegime.SAFETY });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Priority & Trade Selection Engine v1 ─────────────────────────────────────
router.get('/priority/top-focus', async (req, res) => {
  try { res.json(await priorityEngine.buildTopFocusResponse()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...priorityEngine.SAFETY }); }
});

router.get('/priority/watchlist', async (req, res) => {
  try { res.json(await priorityEngine.buildWatchlistResponse()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...priorityEngine.SAFETY }); }
});

router.get('/priority/avoid', async (req, res) => {
  try { res.json(await priorityEngine.buildAvoidResponse()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...priorityEngine.SAFETY }); }
});

router.get('/priority/summary', async (req, res) => {
  try { res.json(await priorityEngine.buildPrioritySummary()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...priorityEngine.SAFETY }); }
});

router.get('/priority/market-context', async (req, res) => {
  try { res.json(await priorityEngine.buildMarketContextResponse()); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, ...priorityEngine.SAFETY }); }
});

// ── API 404 — never return HTML for unknown /api/* paths ──────────────────────
router.use((req, res) => {
  res.status(404).json({ ok: false, error: 'API route not found' });
});

// ── API error handler ─────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[API] Unhandled error:', err.message);
  res.status(500).json({ ok: false, error: err.message || 'Internal server error' });
});

module.exports = router;
