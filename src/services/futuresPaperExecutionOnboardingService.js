'use strict';

const fs = require('fs');
const path = require('path');

const strategyReadinessService = require('./strategyReadinessService');
const paperEnabledStrategiesService = require('./paperEnabledStrategiesService');
const futuresPaperScannerService = require('./futuresPaperScannerService');
const futuresTradingOsSignalAdapterService = require('./futuresTradingOsSignalAdapterService');
const strategyRegistryService = require('./strategyRegistryService');
const ibPaperExecutionConfigService = require('./ibPaperExecutionConfigService');
const ibPaperExecutionIntentService = require('./ibPaperExecutionIntentService');
const ibPaperExecutionOrchestratorService = require('./ibPaperExecutionOrchestratorService');

const ROOT = path.resolve(__dirname, '../..');
const FUTURES_EVENTS_FILE = path.join(ROOT, 'data/futures-paper/events.jsonl');
const INTENT_INDEX_FILE = path.join(ROOT, 'data/futures-paper/ibkr-execution/intent-index.json');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  actions_allowed: false,
  can_place_orders: false,
  read_only: true,
  source: 'futures_paper_execution_onboarding',
});

const STAGES = Object.freeze([
  'producer',
  'candidate',
  'mapping',
  'router',
  'guard',
  'orderPlan',
  'intent',
  'ibkr',
  'fill',
  'trade',
  'ledger',
  'analytics',
]);

const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_REACHED: 'NOT_REACHED',
  NOT_VERIFIED: 'EJ_VERIFIERAT',
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function isSelectableQueueCandidate(candidate = {}) {
  const status = String(candidate.status || 'READY_WAITING_FOR_SIGNAL').trim().toUpperCase();
  return status === 'READY_WAITING_FOR_SIGNAL'
    && !candidate.claimedAt
    && !candidate.claimedBy
    && !candidate.consumedAt
    && !candidate.completedAt
    && !candidate.expiredAt;
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function safeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readRecentJsonl(file, maxLines = 5000) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').slice(-Math.max(1, maxLines)).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function strategyIdOf(row = {}) {
  return safeString(row.strategyId || row.strategy_id || row.resolvedStrategyId || row.canonicalStrategyId);
}

function rootOf(candidate = {}) {
  return safeUpper(candidate.root || candidate.futuresSymbol || candidate.symbol || candidate.instrument);
}

function directionOf(candidate = {}) {
  const raw = String(candidate.direction || candidate.side || candidate.nextMoveBias || '').trim().toLowerCase();
  if (['long', 'buy', 'up', 'bull', 'bullish'].includes(raw)) return 'long';
  if (['short', 'sell', 'down', 'bear', 'bearish'].includes(raw)) return 'short';
  return null;
}

function stage(status, reasonCode = null, evidence = {}) {
  return {
    status,
    ok: status === STATUS.PASS,
    reasonCode: reasonCode || null,
    ...evidence,
  };
}

function emptyStages() {
  return Object.fromEntries(STAGES.map((key) => [key, stage(STATUS.NOT_REACHED)]));
}

function firstFail(stages) {
  return STAGES.find((key) => stages[key]?.status === STATUS.FAIL) || null;
}

function firstNotVerified(stages) {
  return STAGES.find((key) => stages[key]?.status === STATUS.NOT_VERIFIED) || null;
}

function statusStageLabel(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

function markNotReachedAfter(stages, stopKey) {
  const index = STAGES.indexOf(stopKey);
  if (index < 0) return stages;
  for (const key of STAGES.slice(index + 1)) {
    stages[key] = stage(STATUS.NOT_REACHED, `not_reached_after_${stopKey}`);
  }
  return stages;
}

function flattenSkippedSignalDetails(scan = {}) {
  const details = scan.skippedSignalDetails || {};
  return [
    ...arr(details.noMapping),
    ...arr(details.noRisk),
    ...arr(details.other),
  ];
}

function latestFuturesCandidateEvents() {
  const latestByStrategy = new Map();
  const countsByStrategy = new Map();
  for (const event of readRecentJsonl(FUTURES_EVENTS_FILE)) {
    if (event.type !== 'FUTURES_SCANNER_CANDIDATES_ADDED') continue;
    const timestamp = safeString(event.timestamp || event.at || event.createdAt);
    for (const candidate of arr(event.candidates)) {
      const strategyId = strategyIdOf(candidate);
      if (!strategyId) continue;
      countsByStrategy.set(strategyId, (countsByStrategy.get(strategyId) || 0) + 1);
      const current = latestByStrategy.get(strategyId);
      if (!current || String(timestamp || '') > String(current.at || '')) {
        latestByStrategy.set(strategyId, {
          at: timestamp || null,
          candidateId: candidate.candidateId || null,
          signalId: candidate.signalId || null,
          symbol: candidate.symbol || candidate.futuresSymbol || null,
          signalSubtype: candidate.signalSubtype || null,
          direction: candidate.direction || null,
        });
      }
    }
  }
  return { latestByStrategy, countsByStrategy };
}

function intentStatsByStrategy() {
  const index = readJson(INTENT_INDEX_FILE, {});
  const stats = new Map();
  for (const record of Object.values(index || {})) {
    if (!record || typeof record !== 'object') continue;
    const strategyId = strategyIdOf(record) || 'UNKNOWN';
    const row = stats.get(strategyId) || {
      intents: 0,
      orderRefs: 0,
      ibOrders: 0,
      fills: 0,
      closedTrades: 0,
      statuses: {},
    };
    row.intents += 1;
    row.statuses[record.status || 'UNKNOWN'] = (row.statuses[record.status || 'UNKNOWN'] || 0) + 1;
    if (record.orderRef) row.orderRefs += 1;
    if (record.ibOrderId || record.parentOrderId) row.ibOrders += 1;
    if (record.entryExecId) row.fills += 1;
    if (record.filledExecId) {
      row.fills += 1;
      row.closedTrades += 1;
    }
    stats.set(strategyId, row);
  }
  return stats;
}

function candidateCompleteness(candidate = {}) {
  const missing = [];
  if (!strategyIdOf(candidate)) missing.push('strategy_id');
  if (!rootOf(candidate)) missing.push('futures_root');
  if (!directionOf(candidate)) missing.push('direction');
  if (!safeString(candidate.signalSubtype || candidate.signal_subtype || candidate.subtype)) missing.push('signal_subtype');
  if (!safeString(candidate.signalTimestamp || candidate.timestamp || candidate.createdAt)) missing.push('signal_timestamp');
  if (safeNumber(candidate.entryPrice ?? candidate.entry ?? candidate.referencePrice) == null) missing.push('entry_price');
  if (safeNumber(candidate.stopLossPrice ?? candidate.stopLoss ?? candidate.stop) == null) missing.push('stop_loss');
  if (safeNumber(candidate.takeProfitPrice ?? candidate.takeProfit ?? candidate.takeProfit1) == null) missing.push('take_profit');
  return {
    ok: missing.length === 0,
    missing,
  };
}

function mappingEvidence(candidate = {}) {
  const root = rootOf(candidate);
  const mappingRoot = safeUpper(candidate.mapping?.futuresSymbol || candidate.mappedFuturesSymbol || candidate.futuresSymbol || root);
  const mappingReason = safeString(candidate.mapping?.mappingReason || candidate.mappingReason);
  const ok = ['MNQ', 'MES'].includes(root)
    && (!mappingRoot || mappingRoot === root)
    && mappingReason !== 'no_safe_futures_mapping';
  return {
    ok,
    root,
    mappingRoot,
    mappingReason: mappingReason || null,
  };
}

function mappingEvidenceFromSignal(signal = {}) {
  const mapping = futuresTradingOsSignalAdapterService.mapSignalToFutures(signal);
  return {
    ok: Boolean(mapping.futuresSymbol),
    root: mapping.futuresSymbol || null,
    mappingRoot: mapping.futuresSymbol || null,
    mappingReason: mapping.mappingReason || null,
    originalSymbol: mapping.originalSymbol || signal.symbol || null,
    originalMarket: mapping.originalMarket || signal.market || signal.marketType || null,
  };
}

function buildReadOnlyIntentService() {
  const records = new Map();
  return {
    buildIdempotencyKey: ibPaperExecutionIntentService.buildIdempotencyKey,
    getIntent: (idempotencyKey) => records.get(idempotencyKey) || null,
    createIntent: ({ idempotencyKey, executionId, intent }) => {
      if (!idempotencyKey) return { created: false, error: 'idempotency_key_missing' };
      if (records.has(idempotencyKey)) return { created: false, duplicate: true, existing: records.get(idempotencyKey) };
      const record = {
        executionId,
        idempotencyKey,
        intentId: intent?.intentId || idempotencyKey,
        status: 'intent_created',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        strategyId: intent?.strategyId || null,
        lifecycleId: intent?.lifecycleId || null,
        candidateId: intent?.candidateId || null,
        signalId: intent?.signalId || intent?.originalSignalId || null,
        root: intent?.root || null,
        direction: intent?.direction || null,
        executionTarget: intent?.executionTarget || 'ibkr_paper',
      };
      records.set(idempotencyKey, record);
      return { created: true, record, readOnly: true };
    },
    updateStatus: (idempotencyKey, statusValue, extra = {}) => {
      const record = records.get(idempotencyKey);
      if (!record) return { ok: false, error: 'intent_not_found' };
      Object.assign(record, extra, { status: statusValue, updatedAt: nowIso() });
      records.set(idempotencyKey, record);
      return { ok: true, record, readOnly: true };
    },
  };
}

async function evaluateCandidateWithExecutionChain(candidate, {
  now = new Date(),
  orchestratorFactory = ibPaperExecutionOrchestratorService.createIbPaperExecutionOrchestratorService,
  scannerService = null,
  strategyRegistry = strategyRegistryService,
  adapter = null,
  quoteSourceService = null,
  marketDataService = null,
  accountSummaryService = null,
  reconciliationService = null,
} = {}) {
  const candidateId = candidate.candidateId || candidate.id || null;
  const scanner = scannerService || {
    getCandidates: () => ({
      ok: true,
      candidates: [candidate],
      totalCandidates: 1,
      source: 'futures_paper_execution_onboarding',
    }),
  };
  const reservations = {
    reserveExecutionTarget: () => ({ ok: true, reservation: { status: 'read_only_reserved' } }),
  };
  const reconciliation = reconciliationService || {
    getCachedReconciliation: () => ({
      ok: true,
      status: 'ok',
      openOrders: [],
      positions: [],
      executions: [],
      orderStatuses: [],
      commissions: [],
      intents: [],
      generatedAt: nowIso(now),
    }),
    reconcilePaperBroker: async () => ({
      ok: true,
      status: 'ok',
      openOrders: [],
      positions: [],
      executions: [],
      orderStatuses: [],
      commissions: [],
      intents: [],
      generatedAt: nowIso(now),
    }),
  };
  const orchestrator = orchestratorFactory({
    ...(adapter ? { adapter } : {}),
    ...(quoteSourceService ? { quoteSourceService } : {}),
    ...(marketDataService ? { marketDataService } : {}),
    ...(accountSummaryService ? { accountSummaryService } : {}),
    scannerService: scanner,
    strategyRegistryService: strategyRegistry,
    executionTargetReservationService: reservations,
    intentService: buildReadOnlyIntentService(),
    reconciliationService: reconciliation,
    statusCacheTtlMs: 0,
  });
  return orchestrator.buildShadowExecution({
    candidateId,
    now,
    actualSubmit: false,
  });
}

function currentCandidateForStrategy(strategyId, scannerRuntime = {}) {
  const queue = arr(scannerRuntime?.candidateQueue?.candidates).filter(isSelectableQueueCandidate);
  return queue.find((candidate) => strategyIdOf(candidate) === strategyId) || null;
}

function currentSkipForStrategy(strategyId, scannerRuntime = {}) {
  const scan = scannerRuntime?.scanner?.lastScanSummary || {};
  return flattenSkippedSignalDetails(scan).find((row) => strategyIdOf(row) === strategyId) || null;
}

function buildReadyForPaperRows(options = {}) {
  const readiness = options.readiness
    || strategyReadinessService.getStrategyReadiness({ noCache: options.fresh === true });
  const paperStrategies = options.paperStrategies
    || paperEnabledStrategiesService.buildPaperStrategyList({ fresh: options.fresh === true });
  const paperById = new Map(arr(paperStrategies.strategies).map((row) => [row.strategyId, row]));
  const rows = arr(readiness.strategies)
    .filter((row) => row.readiness === 'READY_FOR_PAPER')
    .map((row) => ({
      ...row,
      paperRow: paperById.get(row.strategyId) || null,
    }));
  return { readiness, paperStrategies, rows };
}

async function buildStrategyExecutionRow(strategy, context) {
  const {
    now,
    scannerRuntime,
    latestEvents,
    intentStats,
    evaluateExecution = evaluateCandidateWithExecutionChain,
  } = context;
  const strategyId = strategy.strategyId;
  const stages = emptyStages();
  const paperRow = strategy.paperRow || {};
  const queueCandidate = currentCandidateForStrategy(strategyId, scannerRuntime);
  const currentSkip = currentSkipForStrategy(strategyId, scannerRuntime);
  const latestEvent = latestEvents.latestByStrategy.get(strategyId) || null;
  const historicalCandidateCount = latestEvents.countsByStrategy.get(strategyId) || 0;
  const historicalStats = intentStats.get(strategyId) || null;
  const latestStrategyCandidate = paperRow.latestCandidate || null;

  if (strategy.producerStatus === 'ok') {
    stages.producer = stage(STATUS.PASS, null, {
      producedSubtypes: arr(strategy.producedSubtypes),
      source: 'strategyReadinessService',
    });
  } else {
    stages.producer = stage(STATUS.FAIL, strategy.producerStatus === 'none' ? 'producer_missing' : (strategy.producerStatus || 'producer_not_ready'), {
      producedSubtypes: arr(strategy.producedSubtypes),
    });
    markNotReachedAfter(stages, 'producer');
  }

  if (stages.producer.status !== STATUS.FAIL) {
    if (queueCandidate) {
      const completeness = candidateCompleteness(queueCandidate);
      stages.candidate = completeness.ok
        ? stage(STATUS.PASS, null, {
          candidateId: queueCandidate.candidateId || null,
          source: 'futures_candidate_queue',
        })
        : stage(STATUS.FAIL, 'candidate_missing_complete_futures_data', {
          candidateId: queueCandidate.candidateId || null,
          missing: completeness.missing,
        });
    } else if (currentSkip) {
      const reason = currentSkip.skipReason || currentSkip.reason || 'candidate_skipped_before_queue';
      stages.candidate = reason === 'no_safe_futures_mapping'
        ? stage(STATUS.PASS, null, {
          source: 'latest_scan_skipped_signal',
          signalId: currentSkip.signalId || null,
          symbol: currentSkip.symbol || null,
        })
        : stage(STATUS.FAIL, reason, {
          source: 'latest_scan_skipped_signal',
          signalId: currentSkip.signalId || null,
          symbol: currentSkip.symbol || null,
        });
    } else if (latestStrategyCandidate) {
      stages.candidate = stage(STATUS.PASS, null, {
        source: 'latest_strategy_candidate',
        signalId: latestStrategyCandidate.signalId || null,
        symbol: latestStrategyCandidate.symbol || null,
        signalSubtype: latestStrategyCandidate.signalSubtype || null,
        decision: latestStrategyCandidate.decision || null,
        blockedReason: latestStrategyCandidate.blockedReason || null,
      });
    } else {
      stages.candidate = stage(STATUS.FAIL, 'no_current_strategy_candidate', {
        latestHistoricalCandidate: latestEvent,
        historicalCandidateCount,
        latestDashboardCandidate: null,
      });
    }
    if (stages.candidate.status === STATUS.FAIL) markNotReachedAfter(stages, 'candidate');
  }

  if (stages.candidate.status === STATUS.PASS) {
    if (queueCandidate) {
      const mapping = mappingEvidence(queueCandidate);
      stages.mapping = mapping.ok
        ? stage(STATUS.PASS, null, mapping)
        : stage(STATUS.FAIL, mapping.mappingReason || 'futures_mapping_not_verified', mapping);
    } else if (currentSkip?.skipReason === 'no_safe_futures_mapping') {
      stages.mapping = stage(STATUS.FAIL, 'no_safe_futures_mapping', {
        symbol: currentSkip.symbol || null,
        mapping: currentSkip.mapping || null,
      });
    } else if (latestStrategyCandidate) {
      const mapping = mappingEvidenceFromSignal(latestStrategyCandidate);
      stages.mapping = mapping.ok
        ? stage(STATUS.PASS, null, mapping)
        : stage(STATUS.FAIL, mapping.mappingReason || 'futures_mapping_not_verified', mapping);
    } else {
      stages.mapping = stage(STATUS.FAIL, 'futures_candidate_missing_after_signal');
    }
    if (stages.mapping.status === STATUS.FAIL) markNotReachedAfter(stages, 'mapping');
  }

  let execution = null;
  if (stages.mapping.status === STATUS.PASS) {
    if (!queueCandidate) {
      stages.router = stage(STATUS.FAIL, 'futures_candidate_not_queued', {
        source: latestStrategyCandidate ? 'latest_strategy_candidate' : 'unknown',
      });
    } else {
      try {
        execution = await evaluateExecution(queueCandidate, { now });
      } catch (err) {
        execution = { ok: false, error: err.message || String(err), status: 'ERROR' };
      }

      const router = execution?.entryContract || null;
      stages.router = router
        ? (router.allowed === true
          ? stage(STATUS.PASS, null, {
            verdict: router.readiness?.verdict || null,
            reasonCode: router.readiness?.reasonCode || null,
            decisionSource: router.decisionSource || null,
          })
          : stage(STATUS.FAIL, router.reasonCode || router.readiness?.reasonCode || 'canonical_router_blocked', {
            verdict: router.readiness?.verdict || null,
            detail: router.readiness?.detail || null,
          }))
        : stage(STATUS.FAIL, execution?.error || execution?.blockedReason || 'canonical_router_not_reached');
    }
    if (stages.router.status === STATUS.FAIL) markNotReachedAfter(stages, 'router');
  }

  if (stages.router.status === STATUS.PASS) {
    const guard = execution?.guard || null;
    stages.guard = guard?.allowed === true
      ? stage(STATUS.PASS, null, { checks: guard.checks || [] })
      : stage(STATUS.FAIL, guard?.blockedReason || execution?.blockedReason || 'guard_blocked', {
        blockers: guard?.blockers || execution?.blockers || [],
        checks: guard?.checks || [],
      });
    if (stages.guard.status === STATUS.FAIL) markNotReachedAfter(stages, 'guard');
  }

  if (stages.guard.status === STATUS.PASS) {
    stages.orderPlan = execution?.orderPlan?.entry
      ? stage(STATUS.PASS, null, {
        orderType: execution.orderPlan.entry.orderType || null,
        action: execution.orderPlan.entry.action || null,
      })
      : stage(STATUS.FAIL, 'order_plan_missing');
    if (stages.orderPlan.status === STATUS.FAIL) markNotReachedAfter(stages, 'orderPlan');
  }

  if (stages.orderPlan.status === STATUS.PASS) {
    stages.intent = execution?.intentCreate?.created === true || execution?.intent?.idempotencyKey
      ? stage(STATUS.PASS, null, {
        idempotencyKey: execution.intent?.idempotencyKey || execution.intentCreate?.record?.idempotencyKey || null,
        readOnly: execution.intentCreate?.readOnly === true,
      })
      : stage(STATUS.FAIL, execution?.intentCreate?.error || execution?.blockedReason || 'intent_not_created');
    if (stages.intent.status === STATUS.FAIL) markNotReachedAfter(stages, 'intent');
  }

  if (!firstFail(stages) && stages.intent.status === STATUS.PASS) {
    const flags = ibPaperExecutionConfigService.getFlags();
    stages.ibkr = execution?.wouldSubmit === true && flags.submissionEnabled === true
      ? stage(STATUS.NOT_VERIFIED, 'broker_order_not_submitted_by_read_only_onboarding', {
        wouldSubmit: true,
        orderSubmissionMode: flags.orderSubmissionMode,
      })
      : stage(STATUS.FAIL, execution?.blockedReason || 'paper_order_submission_not_available', {
        wouldSubmit: execution?.wouldSubmit === true,
        orderSubmissionMode: flags.orderSubmissionMode,
      });
    if (stages.ibkr.status === STATUS.FAIL) markNotReachedAfter(stages, 'ibkr');
  } else if (!firstFail(stages) && historicalStats?.ibOrders > 0) {
    stages.ibkr = stage(STATUS.PASS, null, { ibOrders: historicalStats.ibOrders });
  }

  if (!firstFail(stages) && historicalStats?.fills > 0) {
    stages.fill = stage(STATUS.PASS, null, { fills: historicalStats.fills });
  } else if (!firstFail(stages) && stages.ibkr.status !== STATUS.NOT_REACHED) {
    stages.fill = stage(STATUS.NOT_VERIFIED, 'fill_not_observed_for_strategy');
  }

  if (!firstFail(stages) && historicalStats?.closedTrades > 0) {
    stages.trade = stage(STATUS.PASS, null, { closedTrades: historicalStats.closedTrades });
    stages.ledger = stage(STATUS.PASS, null, { source: 'ibkr_execution_index' });
    stages.analytics = stage(STATUS.PASS, null, { source: 'futuresPaperStrategyPerformanceService' });
  } else if (!firstFail(stages) && stages.fill.status !== STATUS.NOT_REACHED) {
    stages.trade = stage(STATUS.NOT_VERIFIED, 'closed_trade_not_observed_for_strategy');
    stages.ledger = stage(STATUS.NOT_VERIFIED, 'ledger_update_not_observed_for_strategy');
    stages.analytics = stage(STATUS.NOT_VERIFIED, 'analytics_update_not_observed_for_strategy');
  }

  const failedAt = firstFail(stages);
  const notVerifiedAt = failedAt ? null : firstNotVerified(stages);
  const status = failedAt
    ? `BLOCKED_AT_${statusStageLabel(failedAt)}`
    : (notVerifiedAt ? `EJ_VERIFIERAT_AT_${statusStageLabel(notVerifiedAt)}` : 'READY_FOR_IBKR_PAPER_EXECUTION');

  return {
    strategyId,
    displayName: paperRow.displayName || strategy.displayName || strategy.name || strategyId,
    readiness: strategy.readiness,
    enabledForPaper: strategy.enabledForPaper === true,
    entryContractReady: strategy.entryContractReady === true,
    registryAllowed: strategyRegistryService.canExecuteStrategy(strategyId).allowed === true,
    stopAt: failedAt || notVerifiedAt || null,
    status,
    stages,
    evidence: {
      currentCandidateId: queueCandidate?.candidateId || null,
      currentSkip: currentSkip || null,
      latestHistoricalCandidate: latestEvent,
      historicalCandidateCount,
      intentStats: historicalStats,
      execution: execution ? {
        status: execution.status || null,
        blockedReason: execution.blockedReason || null,
        wouldSubmit: execution.wouldSubmit === true,
        actualSubmit: execution.actualSubmit === true,
        orderSubmissionMode: execution.orderSubmissionMode || null,
      } : null,
    },
    ...SAFETY,
  };
}

async function buildExecutionOnboardingStatus(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const { readiness, paperStrategies, rows: readyRows } = buildReadyForPaperRows(options);
  const scannerRuntime = options.scannerRuntime
    || futuresPaperScannerService.defaultFuturesPaperScannerService.getScannerRuntime({ now });
  const latestEvents = options.latestEvents || latestFuturesCandidateEvents();
  const intentStats = options.intentStats || intentStatsByStrategy();
  const strategies = [];
  for (const strategy of readyRows) {
    strategies.push(await buildStrategyExecutionRow(strategy, {
      now,
      scannerRuntime,
      latestEvents,
      intentStats,
      evaluateExecution: options.evaluateExecution || evaluateCandidateWithExecutionChain,
    }));
  }
  const counts = strategies.reduce((acc, row) => {
    acc.total += 1;
    if (row.status === 'READY_FOR_IBKR_PAPER_EXECUTION') acc.ready += 1;
    else if (row.status.startsWith('BLOCKED_AT_')) acc.blocked += 1;
    else acc.notVerified += 1;
    acc.byStop[row.stopAt || 'ready'] = (acc.byStop[row.stopAt || 'ready'] || 0) + 1;
    return acc;
  }, { total: 0, ready: 0, blocked: 0, notVerified: 0, byStop: {} });
  return {
    ok: true,
    generatedAt: nowIso(now),
    stages: STAGES,
    statusValues: STATUS,
    readinessSummary: readiness.summary || null,
    paperSummary: paperStrategies.summary || null,
    scanner: {
      lastScanAt: scannerRuntime?.scanner?.lastScanAt || null,
      queueLength: scannerRuntime?.candidateQueue?.length ?? arr(scannerRuntime?.candidateQueue?.candidates).length,
      signalInputsRead: scannerRuntime?.scanner?.lastScanSummary?.signalInputsRead ?? null,
      readerSignalsRead: scannerRuntime?.scanner?.lastScanSummary?.readerSignalsRead ?? null,
      providerSignalsRead: scannerRuntime?.scanner?.lastScanSummary?.providerSignalsRead ?? null,
      candidatesCreated: scannerRuntime?.scanner?.lastScanSummary?.candidatesCreated ?? null,
    },
    counts,
    strategies,
    note: 'Read-only onboarding status. It reuses the canonical scanner/orchestrator path and stops at the first unverified or blocked stage per READY_FOR_PAPER strategy.',
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  STAGES,
  STATUS,
  buildExecutionOnboardingStatus,
  _internal: {
    candidateCompleteness,
    mappingEvidence,
    buildReadyForPaperRows,
    evaluateCandidateWithExecutionChain,
    latestFuturesCandidateEvents,
    intentStatsByStrategy,
  },
};
