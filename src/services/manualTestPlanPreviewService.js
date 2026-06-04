'use strict';

const strategyRegistry = require('./strategyRegistryService');
const strategyScore = require('./strategyScoreService');
const strategyHistory = require('./strategyHistoryService');
const manualTestQueue = require('./manualTestQueueService');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mode: 'paper_only',
});

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function normalizeText(value, fallback = '') {
  const text = safeString(value);
  return text || fallback;
}

function normalizeTestType(value) {
  return safeString(value).toLowerCase();
}

function isTradingViewStrategy(queueItem, strategyContext, registry) {
  const strategyId = safeString(queueItem?.strategy_id || strategyContext?.strategy_id || registry?.strategy_id);
  const source = safeString(queueItem?.source || strategyContext?.source || registry?.source).toLowerCase();
  return source === 'tradingview' || strategyId.toUpperCase().startsWith('TV_');
}

function buildObjective(testType) {
  if (testType === 'replay') return 'Verifiera strategin mot historisk data innan mer paper-test.';
  if (testType === 'batch') return 'Jämföra strategin över flera symboler/timeframes/parametrar.';
  if (testType === 'paper_observation') return 'Samla mer paper-observation innan replay/batch.';
  return 'Förstå historiken innan nya tester planeras.';
}

function buildWhatItWouldMeasure(testType) {
  if (testType === 'replay') {
    return [
      'Om signalen hade fungerat historiskt.',
      'Om strategin får falska signaler.',
      'Om timeframe och symbol verkar rimliga.',
    ];
  }
  if (testType === 'batch') {
    return [
      'Robusthet över flera symboler och timeframes.',
      'Sample size och variation i resultat.',
      'Svagheter mot andra strategier och parametrar.',
    ];
  }
  if (testType === 'paper_observation') {
    return [
      'Fler signaler i paper/test-läge.',
      'Om signalen når paper-stage konsekvent.',
      'Om underlaget räcker för senare replay/batch.',
    ];
  }
  return [
    'Varför strategin stoppades.',
    'Om den saknar data eller lärdomar.',
    'Om den bör förbli pausad eller granskas vidare.',
  ];
}

function buildManualNextStep(testType) {
  if (testType === 'replay') {
    return 'Granska planen. Nästa steg längre fram kan vara att skapa en manuell replay-körning, men detta sker inte nu.';
  }
  if (testType === 'batch') {
    return 'Granska scope innan eventuell batch-körning skapas senare.';
  }
  if (testType === 'paper_observation') {
    return 'Låt strategin observeras i paper/test-läge. Ingen live trading.';
  }
  return 'Öppna Strategy History och kontrollera svagheter och rekommendation.';
}

function buildWhyThisTest(queueItem, historyData, scoreData) {
  const reason = normalizeText(queueItem?.reason, 'Ingen förklaring ännu.');
  const status = safeString(historyData?.registry?.status || queueItem?.status || 'paper_only');
  const source = safeString(historyData?.registry?.source || queueItem?.source || 'internal').toLowerCase();
  const score = safeNumber(scoreData?.score, null);
  const confidence = safeNumber(scoreData?.confidence, null);
  const sampleSize = safeNumber(scoreData?.sample_size, null);
  const pieces = [reason];
  if (source === 'tradingview') pieces.push('TradingView-strategi med begränsat underlag.');
  if (status === 'paused' || status === 'deprecated') pieces.push('Strategin är pausad/deprecated.');
  if (score != null) pieces.push(`score=${score}`);
  if (confidence != null) pieces.push(`confidence=${confidence}`);
  if (sampleSize != null) pieces.push(`sample_size=${sampleSize}`);
  return pieces.filter(Boolean).join(' ');
}

function buildLimitations(queueItem, historyData) {
  const out = [
    'Detta är endast en förhandsgranskning.',
    'Inget test körs automatiskt.',
  ];
  const status = safeString(queueItem?.status).toLowerCase();
  if (status === 'cancelled') out.push('Denna köpost är avbruten. Ingen testkörning startades.');
  if (status === 'completed') out.push('Denna köpost är markerad som completed, men preview kör inget.');
  if (status === 'failed') out.push('Denna köpost är markerad som failed, men preview kör inget.');
  if (!historyData || historyData.ok === false) {
    out.push('Historik saknas eller kunde inte läsas fullt ut.');
  }
  return out;
}

function buildSafetyNotes(queueItem) {
  return [
    'Testet startas inte av preview.',
    'Live trading är avstängt.',
    'Broker/order-logik är inte aktiverad.',
  ];
}

function buildDataStatus(historyData) {
  const summary = historyData?.history_summary || {};
  return {
    paper_trades_count: safeNumber(summary.paper_trades_count, 0) || 0,
    replay_tests_count: safeNumber(summary.replay_tests_count, 0) || 0,
    batch_tests_count: safeNumber(summary.batch_tests_count, 0) || 0,
    learning_events_count: safeNumber(summary.learning_events_count, 0) || 0,
    missing_data: summary.missing_data || {
      paper_trades: true,
      replay_tests: true,
      batch_tests: true,
      learning_events: true,
      recent_events: true,
    },
  };
}

function buildStrategyContext({ queueItem, registry, scoreRow, historyData }) {
  const registryRow = registry || historyData?.registry || {};
  const score = scoreRow || historyData?.score || {};
  return {
    strategy_id: safeString(queueItem?.strategy_id || registryRow?.strategy_id || historyData?.strategy_id),
    source: safeString(registryRow?.source || queueItem?.source || 'internal').toLowerCase() || 'internal',
    status: safeString(registryRow?.status || queueItem?.status || 'paper_only').toLowerCase() || 'paper_only',
    mode: safeString(registryRow?.mode || queueItem?.mode || 'paper_only') || 'paper_only',
    score: safeNumber(score.score, null),
    confidence: safeNumber(score.confidence, null),
    sample_size: safeNumber(score.sample_size, 0) || 0,
    strengths: safeArray(score.strengths),
    weaknesses: safeArray(score.weaknesses),
    recommended_action: score.recommended_action || null,
  };
}

function buildQueueItemView(item) {
  return {
    id: item.id,
    status: item.status,
    strategy_id: item.strategy_id,
    source: item.source,
    test_type: item.test_type,
    priority: item.priority,
    reason: item.reason,
    suggested_scope: item.suggested_scope,
    expected_learning_value: item.expected_learning_value,
    safety_note: item.safety_note,
    created_at: item.created_at,
  };
}

function createManualTestPlanPreviewService(options = {}) {
  const queueService = options.queueService || manualTestQueue.defaultManualTestQueueService;
  const historyService = options.historyService || strategyHistory.defaultStrategyHistoryService;
  const scoreService = options.scoreService || strategyScore.defaultStrategyScoreService;
  const registryService = options.registryService || strategyRegistry;

  function loadQueueItem(queueId) {
    if (typeof queueService.getQueueItem === 'function') return queueService.getQueueItem(queueId);
    const items = typeof queueService.listQueueItems === 'function' ? queueService.listQueueItems() : [];
    return items.find((item) => item.id === queueId) || null;
  }

  function loadStrategyHistory(strategyId) {
    if (typeof historyService.getStrategyHistory !== 'function') return null;
    const result = historyService.getStrategyHistory(strategyId);
    return result?.ok ? result : null;
  }

  function loadStrategyScore(strategyId) {
    if (typeof scoreService.getStrategyScore !== 'function') return null;
    const result = scoreService.getStrategyScore(strategyId);
    return result?.ok ? result.strategy || null : null;
  }

  function loadRegistryStrategy(strategyId) {
    if (typeof registryService.getStrategy !== 'function') return null;
    return registryService.getStrategy(strategyId) || null;
  }

  function getTestPlanPreview(queueId) {
    const id = safeString(queueId);
    if (!id) {
      return { ok: false, error: 'queue_id_required', ...SAFETY };
    }

    const queueItem = loadQueueItem(id);
    if (!queueItem) {
      return { ok: false, error: 'queue_item_not_found', ...SAFETY };
    }

    const historyData = loadStrategyHistory(queueItem.strategy_id);
    const scoreRow = loadStrategyScore(queueItem.strategy_id);
    const registryRow = loadRegistryStrategy(queueItem.strategy_id);
    const strategyContext = buildStrategyContext({
      queueItem,
      registry: registryRow,
      scoreRow,
      historyData,
    });
    const dataStatus = buildDataStatus(historyData);
    const testType = normalizeTestType(queueItem.test_type);
    const isTv = isTradingViewStrategy(queueItem, strategyContext, registryRow);
    const status = safeString(queueItem.status).toLowerCase();

    const planPreview = {
      title: 'Förhandsgranskning av testplan',
      test_type: testType,
      objective: buildObjective(testType),
      why_this_test: buildWhyThisTest(queueItem, historyData, strategyContext),
      suggested_scope: normalizeText(queueItem.suggested_scope, 'Ej konfigurerad'),
      what_it_would_measure: buildWhatItWouldMeasure(testType),
      expected_learning_value: normalizeText(queueItem.expected_learning_value, 'Ej konfigurerad'),
      manual_next_step: buildManualNextStep(testType),
      limitations: buildLimitations(queueItem, historyData),
      safety_notes: buildSafetyNotes(queueItem),
    };

    if (isTv) {
      planPreview.safety_notes = [
        'TradingView-strategi.',
        'Signalen kommer från TradingView/webhook.',
        'TradingView används endast för signaler och test, inte order.',
        ...planPreview.safety_notes,
      ].filter((text, index, array) => array.indexOf(text) === index);
    }

    return {
      ok: true,
      queue_item: buildQueueItemView(queueItem),
      strategy_context: strategyContext,
      data_status: dataStatus,
      plan_preview: planPreview,
      queue_status_message: status === 'pending'
        ? 'Väntar på manuell granskning.'
        : status === 'cancelled'
          ? 'Denna köpost är avbruten. Ingen testkörning startades.'
          : status === 'completed'
            ? 'Denna köpost är markerad som completed, men preview kör inget.'
            : status === 'failed'
              ? 'Denna köpost är markerad som failed, men preview kör inget.'
              : 'Köpoststatus okänd, men preview kör inget.',
      can_execute: false,
      execution_available: false,
      safety: { ...SAFETY },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    getTestPlanPreview,
  };
}

const defaultManualTestPlanPreviewService = createManualTestPlanPreviewService();

module.exports = {
  SAFETY,
  createManualTestPlanPreviewService,
  defaultManualTestPlanPreviewService,
};
