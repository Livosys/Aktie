'use strict';

const marketUniverseService = require('./marketUniverseService');
const strategyPerformanceReadService = require('./strategyPerformanceReadService');
const futuresPaperAccountService = require('./futuresPaperAccountService');
const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperScannerService = require('./futuresPaperScannerService');
const paperEnabledStrategiesService = require('./paperEnabledStrategiesService');
const daytradingStrategyCatalogService = require('./daytradingStrategyCatalogService');
const futuresContractCatalog = require('./futuresContractCatalogService');
const futuresMarketHoursService = require('./futuresMarketHoursService');
const futuresMarketDataService = require('./futuresMarketDataService');
const ibPaperAccountSummaryService = require('./ibPaperAccountSummaryService');
const futuresDataPipelineStatusService = require('./futuresDataPipelineStatusService');
const ibPaperExecutionOrchestratorService = require('./ibPaperExecutionOrchestratorService');
const internalSimulationRetirement = require('./futuresInternalSimulationRetirementService');
const futuresPaperStrategyPerformanceService = require('./futuresPaperStrategyPerformanceService');
const ibPaperBrokerReconciliationService = require('./ibPaperBrokerReconciliationService');
const lifecycleIdentity = require('./futuresLifecycleIdentityService');
const futuresPaperStorageService = require('./futuresPaperStorageService');
const canonicalExecutionRouter = require('./canonical/canonicalExecutionRouter');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_desk',
});

const DEFAULT_ACCOUNT = Object.freeze({
  baseCurrency: 'SEK',
  startingBalance: 100000,
});

// Instrumentlistan byggs från den centrala kontraktskatalogen (MNQ/MES/NQ/ES).
// contractSize = pointValueUsd behålls som fältnamn för bakåtkompatibilitet i UI.
const FUTURES_INSTRUMENTS = Object.freeze(
  futuresContractCatalog.listContracts().map((contract, index) => ({
    symbol: contract.root,
    name: `${contract.name} Futures`,
    exchange: contract.exchange,
    root: contract.root,
    underlying: contract.underlying,
    contractClass: contract.contractClass,
    contractSize: contract.pointValueUsd,
    pointValueUsd: contract.pointValueUsd,
    tickSize: contract.tickSize,
    tickValueUsd: contract.tickValueUsd,
    commissionPerSideUsd: contract.defaultCommissionPerSideUsd,
    estRoundTripCostUsd: contract.estRoundTripCostUsd,
    session: 'Globex',
    focusRank: index + 1,
  })),
);

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function safeString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (value === true || value === false) return value;
  }
  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sumNumbersOrNull(values = [], { requireAll = false } = {}) {
  let total = 0;
  let seen = false;
  for (const value of values) {
    const n = numberOrNull(value);
    if (n === null) {
      if (requireAll) return null;
      continue;
    }
    total += n;
    seen = true;
  }
  return seen ? round(total, 2) : null;
}

function latestTimestampOrNull(values = []) {
  let latest = null;
  let latestMs = null;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (latestMs === null || ms > latestMs) {
      latestMs = ms;
      latest = value;
    }
  }
  return latest;
}

function toMap(rows = [], keyOf) {
  const map = new Map();
  for (const row of safeArray(rows)) {
    const key = keyOf(row);
    if (key) map.set(key, row);
  }
  return map;
}

// Fokusinstrument för desken härleds från kontraktskatalogen (micro-klassen),
// aldrig från hårdkodade symboler i overview-raderna.
const DESK_FOCUS_INSTRUMENTS = Object.freeze(
  FUTURES_INSTRUMENTS.filter((row) => row.contractClass === 'micro').map((row) => row.root),
);

// Entry contracts använder aktie-vokabulär för sessioner; futures-sessionens id
// (futuresMarketHoursService) måste översättas innan jämförelse.
const CONTRACT_SESSIONS_ALWAYS_OPEN = Object.freeze(['24_7', 'crypto_24_7']);
const CONTRACT_SESSIONS_US_RTH = Object.freeze(['regular', 'rth', 'nyse', 'nasdaq', 'us_stocks']);

const PAPER_STATUSES = Object.freeze([
  'ACTIVE_PAPER',
  'READY_WAITING_FOR_SIGNAL',
  'SESSION_CLOSED',
  'DATA_BLOCKED',
  'PRODUCER_NOT_IMPLEMENTED',
  'APPROVAL_BLOCKED',
  'ENTRY_CONTRACT_BLOCKED',
  'RISK_BLOCKED',
  'TRADE_CAP_BLOCKED',
  'REPLAY_ONLY',
  'NOT_APPLICABLE',
]);

function inferOverviewInstruments(strategy = {}) {
  const market = String(strategy.market || strategy.market_group || '').toLowerCase();
  if (market === 'crypto') return [];
  return DESK_FOCUS_INSTRUMENTS.slice();
}

function sessionAllowedForStrategy(sessionId, entryContract) {
  if (!entryContract) return true;
  const allowed = safeArray(entryContract.allowedSessions).map((value) => String(value).toLowerCase());
  // Speglar paperStrategyEntryContractService: sessionslistan upprätthålls bara
  // när kontraktet kräver öppen marknad.
  if (entryContract.requiresMarketOpen !== true) return true;
  if (!allowed.length) return true;
  const id = String(sessionId || '').toLowerCase();
  if (allowed.includes(id)) return true;
  if (CONTRACT_SESSIONS_ALWAYS_OPEN.some((value) => allowed.includes(value))) return true;
  if (id === 'us_rth' && CONTRACT_SESSIONS_US_RTH.some((value) => allowed.includes(value))) return true;
  return false;
}

function isRiskBlockReason(reason) {
  return /risk|drawdown|halt|loss_limit/i.test(String(reason || ''));
}

function isTradeCapBlockReason(reason) {
  return /cooldown|family|max_trades|trade_cap|daily_cap/i.test(String(reason || ''));
}

// Fallback-reason per status så att blockerade rader alltid har en explicit blockerare.
const STATUS_FALLBACK_BLOCKER = Object.freeze({
  PRODUCER_NOT_IMPLEMENTED: 'producer_not_implemented',
  DATA_BLOCKED: 'runtime_connector_inactive',
  ENTRY_CONTRACT_BLOCKED: 'entry_contract_missing',
  APPROVAL_BLOCKED: 'not_approved_or_enabled_for_paper',
  RISK_BLOCKED: 'risk_blocked',
  TRADE_CAP_BLOCKED: 'trade_cap_blocked',
  REPLAY_ONLY: 'replay_only',
  NOT_APPLICABLE: 'unsupported_futures_mapping',
  SESSION_CLOSED: 'session_closed',
  READY_WAITING_FOR_SIGNAL: 'waiting_for_signal',
});

function normalizePaperExecutionStatus(row = {}, {
  sessionOpen = false,
  sessionAllowed = true,
  hasOpenPosition = false,
  applicable = true,
  scannerRow = null,
} = {}) {
  // Prioritet: faktiskt tillstånd > permanenta strukturella blockerare >
  // session > operativa blockerare > redo.
  if (hasOpenPosition) return 'ACTIVE_PAPER';
  if (!applicable) return 'NOT_APPLICABLE';
  if (row.producerStatus == null || row.producerStatus === 'none' || (row.producerStatus && row.producerStatus !== 'ok')) {
    return 'PRODUCER_NOT_IMPLEMENTED';
  }
  if (row.readiness === 'READY_FOR_REPLAY' || row.paperEligibility === 'TECHNICALLY_ALLOWED_BUT_LONG_ONLY_INCOMPATIBLE') {
    return 'REPLAY_ONLY';
  }
  if (row.runtimeConnectorStatus && row.runtimeConnectorStatus !== 'active') return 'DATA_BLOCKED';
  if (row.entryContractStatus === 'missing') return 'ENTRY_CONTRACT_BLOCKED';
  // DISABLED_BY_USER = ej godkänd/aktiverad för paper — approval-spärr, inte "ej tillämplig".
  // Raderna kommer från paperEnabledStrategiesService.buildPaperStrategyList, som
  // publicerar approval-tillståndet under legacy*-namn. Läses bara `approved`
  // blir den alltid undefined och VARJE i övrigt körklar strategi felrapporteras
  // som APPROVAL_BLOCKED (vilket i sin tur nollar canTradeNow för hela desken).
  const approvalStatus = String(row.approvalStatus || row.legacyApprovalStatus || '').toLowerCase();
  const approved = row.approved === true || approvalStatus === 'approved';
  if (row.paperEligibility === 'DISABLED_BY_USER'
    || !approved
    || ['paused', 'removed', 'not_approved'].includes(approvalStatus)) {
    return 'APPROVAL_BLOCKED';
  }
  if (!sessionOpen || !sessionAllowed) return 'SESSION_CLOSED';
  const operativeReason = row.paperBlockedReason || scannerRow?.blockReason || null;
  if (isRiskBlockReason(operativeReason)) return 'RISK_BLOCKED';
  if (scannerRow?.cooldownActive === true
    || scannerRow?.familyGateDecision === 'blocked'
    || isTradeCapBlockReason(operativeReason)) {
    return 'TRADE_CAP_BLOCKED';
  }
  return 'READY_WAITING_FOR_SIGNAL';
}

function summarizeStrategySignal(row = {}) {
  const rawSignals = safeArray(row.evidence?.rawSignals);
  if (rawSignals.length) return rawSignals[0];
  if (row.latestCandidate?.signalSubtype) return row.latestCandidate.signalSubtype;
  if (row.latestCandidate?.decision) return row.latestCandidate.decision;
  return null;
}

function candidateStrategyId(candidate = {}) {
  return safeString(candidate.strategyId || candidate.strategy_id || candidate.resolvedStrategyId || candidate.canonicalStrategyId);
}

function evaluateCanonicalCandidateReadiness(candidate = null, { now = new Date(), session = null } = {}) {
  if (!candidate) return null;
  try {
    const routed = canonicalExecutionRouter.routeExecutionReadiness({
      strategyId: candidateStrategyId(candidate),
      candidate,
      now,
      marketContext: {
        marketType: 'futures',
        session: session?.sessionId || null,
        sessionId: session?.sessionId || null,
        isMarketOpen: session?.isMarketOpen === true,
      },
    });
    return {
      allowed: routed.allowed === true,
      verdict: routed.readiness?.verdict || null,
      reasonCode: routed.readiness?.reasonCode || null,
      legacyReasonCode: routed.reasonCode || null,
      decisionSource: routed.decisionSource || null,
      routerVersion: routed.routerVersion || null,
      engineVersion: routed.readiness?.engineVersion || null,
      policyId: routed.readiness?.policyId || null,
      evidenceGaps: routed.readiness?.evidenceGaps || [],
      producerType: routed.readiness?.producerType || null,
      producerFallback: routed.readiness?.producerFallback === true,
      entryContractVersion: routed.entryContractVersion || null,
      canonicalSignal: routed.canonicalSignal || null,
    };
  } catch (err) {
    return {
      allowed: false,
      verdict: 'ERROR',
      reasonCode: 'canonical_readiness_error',
      legacyReasonCode: 'canonical_readiness_error',
      decisionSource: 'canonical_execution_router',
      error: err && err.message ? err.message : String(err),
      canonicalSignal: null,
    };
  }
}

function summarizeDiagnosticResult(row = {}) {
  const diag = row.entryContractDiagnostics || null;
  const blocker = row.latestEntryContractBlock || row.commonEntryContractBlocker || null;
  if (blocker && blocker.reasonCode) return blocker.reasonCode;
  if (diag && diag.status) return diag.status;
  if (row.runtimeBlockedReason) return row.runtimeBlockedReason;
  if (row.paperBlockedReason) return row.paperBlockedReason;
  return row.readiness || row.technicalReadiness || null;
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

function buildCanonicalStrategyOverview({
  now,
  session,
  paperStrategies,
  openPositions,
  scannerStrategies,
  candidateQueue,
} = {}) {
  const catalogRows = safeArray(daytradingStrategyCatalogService.getCatalog().strategies);
  const paperRows = safeArray(paperStrategies?.strategies);
  const paperById = toMap(paperRows, (row) => safeString(row.strategyId));
  const scannerById = toMap(safeArray(scannerStrategies), (row) => safeString(row.strategyId));
  const openPositionsByStrategy = toMap(safeArray(openPositions), (row) => safeString(row.strategyId));
  const queuedCandidateByStrategy = toMap(safeArray(candidateQueue).filter(isSelectableQueueCandidate), candidateStrategyId);
  const sessionLabel = session?.sessionLabel || session?.session || 'Globex';
  const sessionId = session?.sessionId || null;
  const sessionOpen = session?.isMarketOpen === true;

  const rows = catalogRows.map((strategy) => {
    const paperRow = paperById.get(strategy.id) || {};
    const scannerRow = scannerById.get(strategy.id) || null;
    const openPosition = openPositionsByStrategy.get(strategy.id) || null;
    const currentCandidateRow = queuedCandidateByStrategy.get(strategy.id) || null;
    const allowedSessions = safeArray(paperRow.entryContract?.allowedSessions);
    const instruments = inferOverviewInstruments(strategy);
    const applicable = instruments.length > 0;
    const sessionAllowed = sessionAllowedForStrategy(sessionId, paperRow.entryContract || null);
    const marketOpenForStrategy = sessionOpen && sessionAllowed;
    const paperStatus = normalizePaperExecutionStatus(paperRow, {
      sessionOpen,
      sessionAllowed,
      hasOpenPosition: Boolean(openPosition),
      applicable,
      scannerRow,
    });
    const canTradeNow = marketOpenForStrategy
      && paperStatus === 'READY_WAITING_FOR_SIGNAL'
      && paperRow.paperEligibility === 'READY'
      && paperRow.readiness === 'READY_FOR_PAPER'
      && (scannerRow ? scannerRow.canTradeNow !== false : true);
    const mainBlocker = !applicable
      ? 'unsupported_futures_mapping'
      : (!sessionOpen
        ? (session?.closedReason || 'session_closed')
        : (!sessionAllowed
          ? 'session_not_allowed_for_strategy'
          : (paperRow.paperBlockedReason
            || scannerRow?.blockReason
            || paperRow.runtimeBlockedReason
            || paperRow.commonEntryContractBlocker?.reasonCode
            || STATUS_FALLBACK_BLOCKER[paperStatus]
            || null)));
    const displayedMainBlocker = canTradeNow || paperStatus === 'ACTIVE_PAPER' ? null : mainBlocker;
    const latestCandidate = currentCandidateRow || paperRow.latestCandidate || null;
    const canonicalReadiness = evaluateCanonicalCandidateReadiness(currentCandidateRow, { now, session });
    const entryReady = currentCandidateRow
      ? firstBoolean(
        currentCandidateRow.producerEntryReadiness?.entryReady,
        currentCandidateRow.entryReady,
        canonicalReadiness?.allowed,
      )
      : false;
    const reasonCode = firstPresent(
      canonicalReadiness?.reasonCode,
      canonicalReadiness?.legacyReasonCode,
      latestCandidate?.reasonCode,
      latestCandidate?.blockedReasonCode,
      latestCandidate?.blockedReason,
      paperRow.latestEntryContractBlock?.reasonCode,
      paperRow.commonEntryContractBlocker?.reasonCode,
      displayedMainBlocker,
    );
    const marketRegime = firstPresent(
      currentCandidateRow?.marketRegime,
      currentCandidateRow?.market_regime,
      currentCandidateRow?.rawSignalSummary?.marketRegime,
      latestCandidate?.marketRegime,
      latestCandidate?.market_regime,
      paperRow.marketRegime,
      scannerRow?.marketRegime,
      scannerRow?.market_regime,
    );

    return {
      strategyId: strategy.id,
      displayName: paperRow.displayName || strategy.name || strategy.id,
      family: paperRow.family || strategy.family || null,
      strategyFamily: paperRow.family || strategy.family || null,
      market: paperRow.market || strategy.market_group || strategy.market || null,
      status: paperStatus,
      runtimeStatus: paperStatus,
      runtimeState: paperStatus,
      instruments,
      instrument: instruments.length ? instruments.join(' / ') : null,
      compatibilityStatus: paperRow.technicalReadiness || paperRow.readiness || null,
      producerStatus: paperRow.producerStatus || null,
      dataStatus: paperRow.runtimeConnectorStatus || paperRow.paperEligibility || null,
      currentSession: sessionLabel,
      currentSessionId: sessionId,
      allowedSessions,
      sessionAllowed,
      marketOpen: marketOpenForStrategy,
      latestDiagnosticResult: summarizeDiagnosticResult(paperRow),
      latestSignal: summarizeStrategySignal({ ...paperRow, latestCandidate }),
      latestCandidate,
      currentCandidate: currentCandidateRow != null,
      currentCandidateId: currentCandidateRow?.candidateId || null,
      candidateId: currentCandidateRow?.candidateId || latestCandidate?.candidateId || null,
      marketRegime,
      entryReady,
      canonicalVerdict: canonicalReadiness?.verdict || null,
      reasonCode,
      canonicalReadiness,
      canonicalSignal: canonicalReadiness?.canonicalSignal || null,
      latestPaperTrade: paperRow.latestPaperTrade || null,
      openPaperPosition: openPosition ? {
        id: openPosition.id || openPosition.positionId || null,
        symbol: openPosition.symbol || openPosition.root || null,
        direction: openPosition.direction || null,
        openedAt: openPosition.openedAt || openPosition.entryTime || null,
      } : null,
      mainBlocker: displayedMainBlocker,
      readinessStatus: paperRow.readiness || paperRow.technicalReadiness || null,
      paperExecutionStatus: paperStatus,
      paperStatus,
      canTradeNow,
      blocked: !(canTradeNow || paperStatus === 'ACTIVE_PAPER'),
      paperBlockedReason: paperRow.paperBlockedReason || null,
      approvalStatus: paperRow.approvalStatus || paperRow.legacyApprovalStatus || null,
      approved: paperRow.approved === true || paperRow.legacyApprovalStatus === 'approved',
      selectedInFamily: paperRow.selectedInFamily === true || paperRow.legacySelectedInFamily === true,
      entryContractStatus: paperRow.entryContractStatus || null,
      entryContractReady: paperRow.entryContractReady === true,
      entryContractVersion: paperRow.entryContractVersion || null,
      requiredContext: paperRow.requiredContext || [],
      missingComponents: paperRow.missingComponents || [],
      warnings: paperRow.warnings || [],
      syntheticBatch: paperRow.syntheticBatch === true,
      manualSelectionStatus: paperRow.manualSelectionStatus || null,
      evidence: paperRow.evidence || null,
      entryContract: paperRow.entryContract || null,
      entryContractDiagnostics: paperRow.entryContractDiagnostics || null,
      latestEntryContractBlock: paperRow.latestEntryContractBlock || null,
      commonEntryContractBlocker: paperRow.commonEntryContractBlocker || null,
      entryContractCandidateCount: paperRow.entryContractCandidateCount || 0,
      entryContractPassCount: paperRow.entryContractPassCount || 0,
      entryContractBlockCount: paperRow.entryContractBlockCount || 0,
      timeoutRate: paperRow.timeoutRate ?? null,
      outcomeCounts: paperRow.outcomeCounts || null,
      avgMfe: paperRow.avgMfe ?? null,
      avgMae: paperRow.avgMae ?? null,
      now: nowIso(now),
    };
  });

  const counts = rows.reduce((acc, row) => {
    acc.total += 1;
    if (row.canTradeNow) acc.canTradeNow += 1;
    if (row.paperStatus === 'ACTIVE_PAPER') acc.active += 1;
    if (row.paperStatus === 'SESSION_CLOSED') acc.sessionClosed += 1;
    if (row.paperStatus === 'DATA_BLOCKED') acc.dataBlocked += 1;
    if (row.paperStatus === 'PRODUCER_NOT_IMPLEMENTED') acc.producerNotImplemented += 1;
    if (row.paperStatus === 'APPROVAL_BLOCKED') acc.approvalBlocked += 1;
    if (row.paperStatus === 'ENTRY_CONTRACT_BLOCKED') acc.entryContractBlocked += 1;
    if (row.paperStatus === 'RISK_BLOCKED') acc.riskBlocked += 1;
    if (row.paperStatus === 'TRADE_CAP_BLOCKED') acc.tradeCapBlocked += 1;
    if (row.paperStatus === 'READY_WAITING_FOR_SIGNAL') acc.readyWaitingForSignal += 1;
    if (row.paperStatus === 'REPLAY_ONLY') acc.replayOnly += 1;
    if (row.paperStatus === 'NOT_APPLICABLE') acc.notApplicable += 1;
    return acc;
  }, {
    total: 0,
    canTradeNow: 0,
    active: 0,
    readyWaitingForSignal: 0,
    sessionClosed: 0,
    dataBlocked: 0,
    producerNotImplemented: 0,
    approvalBlocked: 0,
    entryContractBlocked: 0,
    riskBlocked: 0,
    tradeCapBlocked: 0,
    replayOnly: 0,
    notApplicable: 0,
  });

  return {
    generatedAt: nowIso(now),
    currentSession: sessionLabel,
    currentSessionId: sessionId,
    marketOpen: sessionOpen,
    totalStrategies: rows.length,
    counts,
    strategies: rows,
  };
}

function getFuturesSessionState(now = new Date()) {
  return futuresMarketHoursService.getCmeEquityIndexFuturesSessionState(now);
}

function calcFuturesPnl({
  entryPrice,
  exitPrice,
  direction = 'long',
  contracts = 1,
  tickSize,
  tickValueUsd,
  fxRateUsdSek = 0,
  commissionsUsd = 0,
}) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const size = Number(contracts) || 0;
  const tick = Number(tickSize) || 0;
  const tickValue = Number(tickValueUsd) || 0;
  const fx = Number(fxRateUsdSek) || 0;
  const commissions = Number(commissionsUsd) || 0;

  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !tick || !tickValue || !size) {
    return {
      points: null,
      ticks: null,
      grossPnlUsd: null,
      grossPnlSek: null,
      netPnlUsd: null,
      netPnlSek: null,
    };
  }

  const signedPoints = String(direction).toLowerCase() === 'short'
    ? entry - exit
    : exit - entry;
  const ticks = signedPoints / tick;
  const grossPnlUsd = ticks * tickValue * size;
  const netPnlUsd = grossPnlUsd - commissions;

  return {
    points: round(signedPoints, 4),
    ticks: round(ticks, 4),
    grossPnlUsd: round(grossPnlUsd, 2),
    grossPnlSek: fx > 0 ? round(grossPnlUsd * fx, 2) : null,
    netPnlUsd: round(netPnlUsd, 2),
    netPnlSek: fx > 0 ? round(netPnlUsd * fx, 2) : null,
  };
}

function normalizePerformance(performance) {
  const strategies = safeArray(performance?.strategies || performance?.results || []);
  return strategies.slice(0, 5).map((row) => ({
    strategyId: row.strategy_id || row.strategyId || row.id || null,
    strategyName: row.strategy_name || row.strategyName || row.name || row.strategy_id || row.strategyId || 'Okänd strategi',
    winRate: row.win_rate ?? row.winRate ?? null,
    avgPnl: row.avg_pnl ?? row.avgPnl ?? null,
    score: row.score ?? null,
    trades: row.trades ?? row.trades_count ?? 0,
    bestMarket: row.best_market?.market_group || row.bestMarket?.market_group || row.market_group || row.market || null,
    bestSymbol: row.best_symbol || row.bestSymbol || row.symbol || null,
    badge: row.performance_badge || row.badge || null,
  }));
}

function normalizeMiniFutures(universe = {}) {
  const symbols = safeArray(universe.symbols || []);
  const miniFuturesRows = symbols.filter((row) => String(row.marketGroup || row.group || '').toLowerCase() === 'mini_futures');
  return FUTURES_INSTRUMENTS.map((instrument) => {
    const match = miniFuturesRows.find((row) => String(row.symbol || '').toUpperCase().includes(instrument.root));
    return {
      ...instrument,
      visible: true,
      universeMatch: match || null,
      universeStatus: match ? (match.enabled === false ? 'observe' : 'active') : 'planned',
      testOnly: match ? Boolean(match.test_only) : true,
      riskLevel: match?.risk_level || 'very_high',
      description: String(instrument.underlying || '').includes('Nasdaq')
        ? `${instrument.contractClass === 'micro' ? 'Micro' : 'E-mini'} Nasdaq-100-kontrakt för futures paper-desken.`
        : `${instrument.contractClass === 'micro' ? 'Micro' : 'E-mini'} S&P 500-kontrakt för futures paper-desken.`,
    };
  });
}

// IBKR levererar positioner och executions utan strategikoppling — den finns bara i
// intent-loggen. Kopplingen görs via orderRef (TOS-PAPER-<executionId>-<leg>) med
// reconciliation-tjänstens egen parser, så parsningslogiken inte dupliceras.
function buildIntentContext(brokerReconciliation = {}) {
  const byExecutionId = new Map();
  for (const intent of safeArray(brokerReconciliation.intents)) {
    const executionId = intent?.executionId || intent?.intent?.executionId;
    if (!executionId) continue;
    // Första posten per executionId är intent_created och bär strategikontexten.
    if (!byExecutionId.has(executionId)) byExecutionId.set(executionId, intent);
  }
  return byExecutionId;
}

// candidateId → den signalidentitet som utlöste entryn, ur den frusna events-loggen.
// Samma läsmönster som provenanceByTradeId använder för trades.jsonl. Loggen är
// append-only och flera MB, därför cachas uppslagningen kort.
const CANDIDATE_SIGNAL_TTL_MS = 60000;
let candidateSignalCache = { at: 0, map: new Map() };

function candidateSignalByCandidateId(now = Date.now()) {
  if (candidateSignalCache.map.size && now - candidateSignalCache.at < CANDIDATE_SIGNAL_TTL_MS) {
    return candidateSignalCache.map;
  }
  const map = new Map();
  try {
    const rows = futuresPaperStorageService.readJsonl(futuresPaperStorageService.FILES.events) || [];
    for (const row of rows) {
      for (const candidate of safeArray(row?.candidates)) {
        const id = candidate?.candidateId;
        if (!id || map.has(id)) continue;
        const subtype = candidate.signalSubtype || null;
        const family = candidate.signalFamily || null;
        if (!subtype && !family) continue;
        map.set(id, {
          entryReason: subtype || family,
          signalSubtype: subtype,
          signalFamily: family,
          confidence: candidate.confidence ?? null,
          timeframe: candidate.timeframe || null,
        });
      }
    }
  } catch (err) { /* loggen kan saknas → entryReason förblir null */ }
  candidateSignalCache = { at: now, map };
  return map;
}

function strategyContextFromIntent(intent) {
  const inner = intent?.intent || {};
  const identity = lifecycleIdentity.mergeIdentity(intent, inner);
  return {
    lifecycleId: identity.lifecycleId || null,
    strategyId: intent?.strategyId || inner.strategyId || null,
    candidateId: identity.candidateId || null,
    signalId: identity.signalId || null,
    intentId: identity.intentId || intent?.idempotencyKey || inner.idempotencyKey || null,
    executionId: identity.executionId || null,
    idempotencyKey: identity.idempotencyKey || null,
    signalTimestamp: intent?.signalTimestamp || inner.signalTimestamp || null,
    intentDirection: intent?.direction || inner.direction || null,
    // entryReason skrivs inte av intent-tjänsten idag; fältet exponeras ändå så att
    // frontend har en stabil plats när källan kopplas in.
    entryReason: intent?.entryReason || inner.entryReason || inner.reason || null,
  };
}

function intentForOrderRef(intentByExecutionId, orderRef) {
  const executionId = ibPaperBrokerReconciliationService.executionIdFromOrderRef(orderRef);
  if (!executionId) return null;
  return intentByExecutionId.get(executionId) || null;
}

// Skyddsordrar (SL/TP) ligger som separata broker-ordrar som bär samma executionId i
// orderRef. De grupperas per conId så en öppen position kan visa sina nivåer och
// härleda vilken strategi som äger exponeringen.
function buildProtectiveContextByConId(brokerOrders = [], intentByExecutionId = new Map()) {
  const byConId = new Map();
  for (const order of safeArray(brokerOrders)) {
    if (order?.conId == null) continue;
    const key = String(order.conId);
    if (!byConId.has(key)) {
      byConId.set(key, { stopLoss: null, takeProfit: null, executionId: null, intent: null });
    }
    const entry = byConId.get(key);
    const ref = String(order.orderRef || '');
    if (ref.endsWith('-stopLoss')) entry.stopLoss = order.stopPrice ?? order.limitPrice ?? null;
    else if (ref.endsWith('-takeProfit')) entry.takeProfit = order.limitPrice ?? order.stopPrice ?? null;
    if (!entry.executionId) {
      const intent = intentForOrderRef(intentByExecutionId, ref);
      if (intent) {
        entry.executionId = ibPaperBrokerReconciliationService.executionIdFromOrderRef(ref);
        entry.intent = intent;
      }
    }
  }
  return byConId;
}

const INSTRUMENT_BY_ROOT = new Map(FUTURES_INSTRUMENTS.map((row) => [String(row.root).toUpperCase(), row]));

function normalizeBrokerPosition(row = {}, { reconciliationTimestamp = null, quote = null, protective = null } = {}) {
  const qty = Number(row.position ?? row.quantity ?? row.size ?? 0);
  const root = safeString(row.symbol || row.root || row.contract?.symbol);
  const strategyContext = strategyContextFromIntent(protective?.intent);
  const candidateSignal = strategyContext.candidateId
    ? (candidateSignalByCandidateId().get(strategyContext.candidateId) || null)
    : null;
  const side = qty > 0 ? 'long' : (qty < 0 ? 'short' : null);
  const entryPrice = protective?.entryPrice ?? null;
  const marketPrice = quote?.last ?? quote?.price ?? null;
  // Live PnL: IBKR skickar ingen unrealizedPnL via reqPositions, men entrypris,
  // marknadspris och kontraktets tickvärde finns — beräknas med befintliga
  // calcFuturesPnl så ingen parallell PnL-logik uppstår.
  const instrument = INSTRUMENT_BY_ROOT.get(String(root).toUpperCase()) || null;
  const livePnl = (entryPrice != null && marketPrice != null && instrument && side)
    ? calcFuturesPnl({
      entryPrice,
      exitPrice: marketPrice,
      direction: side,
      contracts: Math.abs(qty) || 1,
      tickSize: instrument.tickSize,
      tickValueUsd: instrument.tickValueUsd,
    })
    : null;
  return {
    id: row.conId ? `ibkr_paper_position_${row.conId}` : `ibkr_paper_position_${root || 'unknown'}`,
    accountMasked: row.accountMasked || row.accountIdMasked || null,
    account: row.accountMasked || row.accountIdMasked || null,
    root,
    symbol: root,
    localSymbol: row.localSymbol || row.contract?.localSymbol || null,
    conId: row.conId ?? row.contract?.conId ?? null,
    expiry: row.expiry || row.contract?.lastTradeDateOrContractMonth || null,
    side,
    quantity: Number.isFinite(qty) ? Math.abs(qty) : null,
    signedQuantity: Number.isFinite(qty) ? qty : null,
    averageCost: row.avgCost ?? row.averageCost ?? null,
    avgCost: row.avgCost ?? row.averageCost ?? null,
    marketPrice,
    // Brokerns eget värde vinner när det finns; annars det beräknade.
    unrealizedPnl: row.unrealizedPnl ?? livePnl?.grossPnlUsd ?? null,
    unrealizedPnlUsd: row.unrealizedPnl ?? livePnl?.grossPnlUsd ?? null,
    unrealizedPoints: livePnl?.points ?? null,
    unrealizedTicks: livePnl?.ticks ?? null,
    pointValueUsd: instrument?.pointValueUsd ?? null,
    tickSize: instrument?.tickSize ?? null,
    realizedPnl: row.realizedPnl ?? null,
    // Strategikontext och skyddsnivåer kommer från intent-loggen respektive de
    // öppna skyddsordrarna — båda redan hämtade av reconciliation.
    status: 'open',
    lifecycleId: strategyContext.lifecycleId,
    strategyId: strategyContext.strategyId,
    candidateId: strategyContext.candidateId,
    signalId: strategyContext.signalId,
    intentId: strategyContext.intentId,
    executionId: strategyContext.executionId,
    idempotencyKey: strategyContext.idempotencyKey,
    entryTime: strategyContext.signalTimestamp,
    entryPrice,
    exitTime: null,
    exitPrice: null,
    stopLoss: protective?.stopLoss ?? null,
    takeProfit: protective?.takeProfit ?? null,
    // Systemet lagrar ingen fritextmotivering — signalidentiteten som utlöste
    // entryn är den motivering som faktiskt finns.
    entryReason: strategyContext.entryReason || candidateSignal?.entryReason || null,
    entrySignalFamily: candidateSignal?.signalFamily ?? null,
    entryConfidence: candidateSignal?.confidence ?? null,
    entryTimeframe: candidateSignal?.timeframe ?? null,
    exitReason: null,
    source: 'ibkr_paper',
    executionSource: 'ibkr_paper',
    reconciliationTimestamp,
    protectiveOrderStatus: row.protectiveOrderStatus || 'unknown',
    uncertain: false,
  };
}

function normalizeBrokerExecution(row = {}, commissionsByExecId = new Map(), intentByExecutionId = new Map()) {
  const commission = commissionsByExecId.get(row.execId) || null;
  const strategyContext = strategyContextFromIntent(intentForOrderRef(intentByExecutionId, row.orderRef));
  // Exitorsaken är deterministisk ur vilket orderben som fylldes — IBKR:s orderRef
  // bär benets namn (entry / stopLoss / takeProfit / emergency-flatten).
  const ref = String(row.orderRef || '');
  const exitReason = ref.endsWith('-stopLoss')
    ? 'stop_loss'
    : (ref.endsWith('-takeProfit')
      ? 'take_profit'
      : (ref.includes('emergency') ? 'emergency_flatten' : null));
  return {
    id: row.execId || `${row.orderId || 'order'}_${row.receivedAt || row.time || ''}`,
    ibOrderId: row.orderId ?? null,
    orderId: row.orderId ?? null,
    permId: row.permId ?? null,
    execId: row.execId ?? null,
    orderRef: row.orderRef || null,
    lifecycleId: row.lifecycleId || strategyContext.lifecycleId || null,
    strategyId: row.strategyId || strategyContext.strategyId || null,
    candidateId: row.candidateId || strategyContext.candidateId || null,
    signalId: row.signalId || strategyContext.signalId || null,
    intentId: row.intentId || strategyContext.intentId || null,
    executionId: row.executionId || strategyContext.executionId || null,
    idempotencyKey: row.idempotencyKey || strategyContext.idempotencyKey || null,
    exitReason,
    orderLeg: ref.endsWith('-entry') ? 'entry' : (exitReason || null),
    conId: row.conId ?? null,
    localSymbol: row.localSymbol || null,
    side: row.side || null,
    quantity: row.shares ?? row.quantity ?? null,
    fillPrice: row.price ?? row.fillPrice ?? null,
    commission: commission?.commission ?? row.commission ?? null,
    commissionCurrency: commission?.currency ?? row.commissionCurrency ?? null,
    realizedResult: commission?.realizedPNL ?? row.realizedPnl ?? null,
    accountMasked: row.accountMasked || null,
    time: row.time || row.receivedAt || null,
    receivedAt: row.receivedAt || null,
    source: 'ibkr_paper',
    executionSource: 'ibkr_paper',
  };
}

// Symmetrisk med normalizeBrokerExecution: en broker-order ska bära samma
// strategiidentitet som en broker-fill. Vitlistan här utelämnade strategyId,
// candidateId och executionId helt, så attributionen som orchestratorn gör
// uppströms ströks tyst igen och Futures Desk visade null där backend visste
// svaret. Fälten läses i första hand från raden (redan attribuerad) och faller
// annars tillbaka på intenten via orderRef — samma väg som fills använder.
function normalizeBrokerOrder(row = {}, intentByExecutionId = new Map()) {
  const orderRef = row.order?.orderRef || row.orderRef || null;
  const strategyContext = strategyContextFromIntent(intentForOrderRef(intentByExecutionId, orderRef));
  return {
    id: row.orderId ?? row.order?.orderId ?? row.order?.permId ?? null,
    orderId: row.orderId ?? null,
    permId: row.order?.permId ?? row.permId ?? null,
    orderRef,
    lifecycleId: row.lifecycleId || strategyContext.lifecycleId || null,
    strategyId: row.strategyId || strategyContext.strategyId || null,
    candidateId: row.candidateId || strategyContext.candidateId || null,
    signalId: row.signalId || strategyContext.signalId || null,
    intentId: row.intentId || strategyContext.intentId || null,
    executionId: row.executionId || strategyContext.executionId || null,
    idempotencyKey: row.idempotencyKey || strategyContext.idempotencyKey || null,
    accountMasked: row.order?.accountMasked || row.accountMasked || null,
    conId: row.contract?.conId ?? null,
    localSymbol: row.contract?.localSymbol || null,
    symbol: row.contract?.symbol || null,
    action: row.order?.action || row.action || null,
    quantity: row.order?.totalQuantity ?? row.totalQuantity ?? null,
    orderType: row.order?.orderType || row.orderType || null,
    limitPrice: row.order?.lmtPrice ?? row.lmtPrice ?? null,
    stopPrice: row.order?.auxPrice ?? row.auxPrice ?? null,
    parentId: row.order?.parentId ?? row.parentId ?? null,
    ocaGroup: row.order?.ocaGroup || null,
    transmit: row.order?.transmit === true,
    status: row.state || row.status || null,
    updatedAt: row.updatedAt || null,
    source: 'ibkr_paper',
    executionSource: 'ibkr_paper',
  };
}

function buildCanonicalAccountAndMargin(ibAccount) {
  const ibAccountView = ibAccount?.ok === true ? ibAccount.account : null;
  const blocker = ibAccount?.ok === true
    ? null
    : (ibAccount?.blocker || ibAccount?.error || 'ibkr_paper_account_unavailable');
  const updatedAt = ibAccount?.generatedAt || null;
  const stale = ibAccount?.stale === true;
  const degraded = ibAccount?.ok !== true || ibAccount?.degraded === true || stale;
  const degradedReason = ibAccount?.degradedReason || (stale ? 'stale_account_snapshot' : null);
  const margin = {
    initMarginReq: ibAccountView?.initMarginReq ?? null,
    maintMarginReq: ibAccountView?.maintMarginReq ?? null,
    cushion: ibAccountView?.cushion ?? null,
    fullInitMarginReq: ibAccountView?.fullInitMarginReq ?? null,
    fullMaintMarginReq: ibAccountView?.fullMaintMarginReq ?? null,
    excessLiquidity: ibAccountView?.excessLiquidity ?? null,
    updatedAt,
    source: 'ibkr_paper',
  };
  const account = {
    source: 'ibkr_paper',
    status: ibAccount?.status || null,
    accountIdMasked: ibAccountView?.accountIdMasked || null,
    currency: ibAccountView?.currency || null,
    cash: ibAccountView?.totalCashValue ?? null,
    totalCashValue: ibAccountView?.totalCashValue ?? null,
    netLiquidation: ibAccountView?.netLiquidation ?? null,
    availableFunds: ibAccountView?.availableFunds ?? null,
    buyingPower: ibAccountView?.buyingPower ?? null,
    realizedPnl: ibAccountView?.realizedPnl ?? null,
    unrealizedPnl: ibAccountView?.unrealizedPnl ?? null,
    dailyPnl: ibAccountView?.dailyPnl ?? null,
    updatedAt,
    stale,
    degraded,
    degradedReason,
    blocker,
    unavailableReason: blocker,
    classification: ibAccountView?.classification || null,
    accountType: ibAccountView?.accountType || null,
    ...margin,
  };
  return { account, margin };
}

function buildCanonicalBrokerRuntime({
  brokerReconciliation = {},
  brokerPositions = [],
  brokerOrders = [],
  brokerExecutions = [],
  brokerCommissions = [],
} = {}) {
  const updatedAt = brokerReconciliation?.generatedAt || null;
  const discrepancies = safeArray(brokerReconciliation?.discrepancies);
  const orderStatuses = safeArray(brokerReconciliation?.orderStatuses);
  const counts = {
    positions: brokerReconciliation?.counts?.positions ?? brokerPositions.length,
    openOrders: brokerReconciliation?.counts?.openOrders ?? brokerOrders.length,
    executions: brokerReconciliation?.counts?.executions ?? brokerExecutions.length,
    fills: brokerExecutions.length,
    commissions: brokerCommissions.length,
    orderStatuses: brokerReconciliation?.counts?.orderStatuses ?? orderStatuses.length,
    discrepancies: discrepancies.length,
  };
  const broker = {
    status: brokerReconciliation?.status || null,
    degraded: brokerReconciliation?.degraded === true,
    newEntriesAllowed: brokerReconciliation?.newEntriesAllowed === true,
    blockedReason: brokerReconciliation?.blockedReason || null,
    counts,
    updatedAt,
    source: 'ibkr_paper',
    reconciliation: brokerReconciliation || null,
  };
  const orders = {
    open: safeArray(brokerOrders),
    completed: [],
    statuses: orderStatuses,
    totalOpen: brokerOrders.length,
    totalCompleted: 0,
    updatedAt,
    source: 'ibkr_paper',
  };
  const executions = {
    items: safeArray(brokerExecutions),
    count: brokerExecutions.length,
    updatedAt,
    source: 'ibkr_paper',
  };
  const commissions = {
    items: safeArray(brokerCommissions),
    count: brokerCommissions.length,
    updatedAt,
    source: 'ibkr_paper',
  };
  return { broker, orders, executions, commissions };
}

function buildCanonicalPortfolio({
  account = {},
  positions = {},
  orders = {},
  executions = {},
} = {}) {
  const executionItems = safeArray(executions?.items);
  const realizedPnl = numberOrNull(account?.realizedPnl);
  const unrealizedPnl = numberOrNull(account?.unrealizedPnl);
  return {
    portfolioValue: numberOrNull(account?.netLiquidation),
    marketValue: null,
    openExposure: null,
    openRisk: null,
    portfolioPnl: sumNumbersOrNull([realizedPnl, unrealizedPnl], { requireAll: true }),
    dailyPnl: numberOrNull(account?.dailyPnl),
    realizedPnl,
    unrealizedPnl,
    commission: sumNumbersOrNull(executionItems.map((row) => row?.commission)),
    currency: account?.currency || null,
    updatedAt: latestTimestampOrNull([
      account?.updatedAt,
      positions?.updatedAt,
      orders?.updatedAt,
      executions?.updatedAt,
    ]),
    source: 'ibkr_paper',
  };
}

function buildPerformanceVerificationByStrategy(executions = []) {
  const byStrategy = new Map();
  for (const row of safeArray(executions)) {
    const strategyId = safeString(row?.strategyId || row?.orderRef);
    if (!strategyId) continue;
    if (!byStrategy.has(strategyId)) {
      byStrategy.set(strategyId, {
        executionCount: 0,
        missingRealizedPnl: false,
        missingCommission: false,
      });
    }
    const verification = byStrategy.get(strategyId);
    verification.executionCount += 1;
    if (numberOrNull(row?.realizedResult ?? row?.realizedPnlSek ?? row?.realizedPnl) === null) {
      verification.missingRealizedPnl = true;
    }
    if (numberOrNull(row?.commission) === null) {
      verification.missingCommission = true;
    }
  }
  return byStrategy;
}

function normalizeCanonicalPerformanceStrategy(row = {}, verification = null, unrealizedPnl = null) {
  const tradeCount = numberOrNull(row.closedTrades ?? row.tradeCount);
  const wins = numberOrNull(row.wins);
  const losses = numberOrNull(row.losses);
  const minTradesForRatios = numberOrNull(futuresPaperStrategyPerformanceService.MIN_TRADES_FOR_RATE_LEADERS) ?? 1;
  const hasEnoughTradesForRatios = tradeCount !== null && tradeCount >= minTradesForRatios;
  // Noll stängda trades är ett känt värde, inte ett okänt: antal och summor är
  // definitionsmässigt 0 och ska visas som 0 i stället för att döljas.
  const noClosedTrades = tradeCount === 0;
  const hasVerifiedRealizedPnl = noClosedTrades
    || (verification?.executionCount > 0 && verification.missingRealizedPnl !== true);
  const hasVerifiedCommission = noClosedTrades
    || (verification?.executionCount > 0 && verification.missingCommission !== true);
  return {
    strategyId: row.strategyId || null,
    displayName: row.displayName || row.strategyName || row.strategyId || null,
    tradeCount,
    // wins/losses/breakeven beräknas redan av futuresPaperStrategyPerformanceService
    // men föll tidigare bort här. De kräver ingen ratio-tröskel — det är råa antal.
    wins: hasVerifiedRealizedPnl ? wins : null,
    losses: hasVerifiedRealizedPnl ? losses : null,
    breakevenTrades: hasVerifiedRealizedPnl ? numberOrNull(row.breakevenTrades) : null,
    winRate: hasVerifiedRealizedPnl && hasEnoughTradesForRatios ? numberOrNull(row.winRatePct ?? row.winRate) : null,
    profitFactor: hasVerifiedRealizedPnl && hasEnoughTradesForRatios ? numberOrNull(row.profitFactor) : null,
    expectancy: hasVerifiedRealizedPnl && hasEnoughTradesForRatios ? numberOrNull(row.avgNetPnlSek ?? row.expectancy) : null,
    // Average win/loss och drawdown är härledd statistik och följer samma
    // signifikanströskel som winRate/profitFactor/expectancy.
    averageWin: hasVerifiedRealizedPnl && hasEnoughTradesForRatios && wins > 0 ? numberOrNull(row.avgWinSek ?? row.averageWin) : null,
    averageLoss: hasVerifiedRealizedPnl && hasEnoughTradesForRatios && losses > 0 ? numberOrNull(row.avgLossSek ?? row.averageLoss) : null,
    largestWin: hasVerifiedRealizedPnl && wins !== null && wins > 0 ? numberOrNull(row.bestTradeSek ?? row.largestWin) : null,
    largestLoss: hasVerifiedRealizedPnl && losses !== null && losses > 0 ? numberOrNull(row.worstTradeSek ?? row.largestLoss) : null,
    drawdown: hasVerifiedRealizedPnl && hasEnoughTradesForRatios ? numberOrNull(row.maxDrawdownSek ?? row.drawdown) : null,
    // Orealiserad PnL kommer från öppna positioner, inte från stängda fills.
    unrealizedPnl: numberOrNull(unrealizedPnl),
    unrealizedPnlCurrency: 'SEK',
    netPnl: hasVerifiedRealizedPnl ? numberOrNull(row.netPnlSek ?? row.netPnl) : null,
    netPnlCurrency: hasVerifiedRealizedPnl ? 'SEK' : null,
    grossPnl: hasVerifiedRealizedPnl ? numberOrNull(row.grossPnlSek ?? row.grossPnl) : null,
    grossPnlCurrency: hasVerifiedRealizedPnl ? 'SEK' : null,
    commission: hasVerifiedCommission ? numberOrNull(row.feesSek ?? row.commission) : null,
    commissionCurrency: hasVerifiedCommission ? 'SEK' : null,
  };
}

function buildCanonicalPerformance({
  account = {},
  positions = {},
  orders = {},
  executions = {},
  portfolio = {},
  intents = [],
} = {}) {
  const executionItems = safeArray(executions?.items);
  const intentItems = safeArray(intents);
  // Historiken från intent-loggen verifieras med samma regel som live-executions:
  // den bär broker-verifierad realiserad PnL och avgifter.
  const historicalClosedRows = futuresPaperStrategyPerformanceService.closedIntentRows(intentItems);
  const verificationByStrategy = buildPerformanceVerificationByStrategy(
    [...executionItems, ...historicalClosedRows],
  );
  const strategyStats = futuresPaperStrategyPerformanceService.buildStrategyStats({
    executions: executionItems,
    intents: intentItems,
  });
  // Orealiserad PnL per strategi summeras från de öppna positionerna, som numera
  // bär både strategyId och beräknad live-PnL.
  const unrealizedByStrategy = new Map();
  for (const position of safeArray(positions?.open)) {
    const strategyId = position?.strategyId;
    const value = numberOrNull(position?.unrealizedPnl);
    if (!strategyId || value === null) continue;
    unrealizedByStrategy.set(strategyId, (unrealizedByStrategy.get(strategyId) || 0) + value);
  }
  const statsById = new Map(safeArray(strategyStats).map((row) => [row?.strategyId, row]));
  // En strategi med enbart en öppen position har ingen stängd statistik men ska
  // ändå synas, annars försvinner den orealiserade PnL:en helt.
  for (const strategyId of unrealizedByStrategy.keys()) {
    if (!statsById.has(strategyId)) {
      statsById.set(strategyId, futuresPaperStrategyPerformanceService.emptyStats(strategyId));
    }
  }
  const strategy = Array.from(statsById.values()).map((row) => (
    normalizeCanonicalPerformanceStrategy(
      row,
      verificationByStrategy.get(row?.strategyId),
      unrealizedByStrategy.has(row?.strategyId) ? unrealizedByStrategy.get(row?.strategyId) : null,
    )
  ));
  return {
    context: {
      performanceContext: 'ibkr_paper',
      executionSource: 'ibkr_paper',
      notRealMarketPerformance: false,
      legacySimulationExcluded: true,
      strategyCount: strategy.length,
      minTradesForRateLeaders: futuresPaperStrategyPerformanceService.MIN_TRADES_FOR_RATE_LEADERS ?? null,
      minTradesForRatios: futuresPaperStrategyPerformanceService.MIN_TRADES_FOR_RATE_LEADERS ?? null,
    },
    strategy,
    portfolio: {
      portfolioValue: numberOrNull(portfolio?.portfolioValue),
      marketValue: numberOrNull(portfolio?.marketValue),
      openExposure: numberOrNull(portfolio?.openExposure),
      openRisk: numberOrNull(portfolio?.openRisk),
      portfolioPnl: numberOrNull(portfolio?.portfolioPnl),
      dailyPnl: numberOrNull(portfolio?.dailyPnl),
      realizedPnl: numberOrNull(portfolio?.realizedPnl),
      unrealizedPnl: numberOrNull(portfolio?.unrealizedPnl),
      commission: numberOrNull(portfolio?.commission),
      currency: portfolio?.currency || account?.currency || null,
    },
    updatedAt: latestTimestampOrNull([
      portfolio?.updatedAt,
      executions?.updatedAt,
      positions?.updatedAt,
      orders?.updatedAt,
      account?.updatedAt,
    ]),
    source: 'futuresPaperStrategyPerformanceService',
  };
}

function buildFuturesPaperDeskRuntime(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const universe = options.universe || marketUniverseService.getUniverse();
  const performance = options.performance || strategyPerformanceReadService.getTopStrategies(5);
  const legacyLedgerResult = options.legacyLedger || futuresPaperLedgerService.defaultFuturesPaperLedgerService.getFuturesPaperLedger({
    limit: options.limit || 50,
  });
  const instruments = normalizeMiniFutures(universe);
  const session = getFuturesSessionState(now);
  const strategyPulse = normalizePerformance(performance);
  const paperStrategies = options.paperStrategies
    || paperEnabledStrategiesService.buildPaperStrategyList({ fresh: options.fresh === true });
  const scannerRuntime = options.scannerRuntime
    || futuresPaperScannerService.defaultFuturesPaperScannerService.getScannerRuntime({ now });
  const strategyStatus = options.strategyStatus
    || futuresPaperScannerService.defaultFuturesPaperScannerService.getStrategyStatus({ now });

  const brokerReconciliation = options.brokerReconciliation
    || ibPaperExecutionOrchestratorService.defaultIbPaperExecutionOrchestratorService.reconciliation.getCachedReconciliation();
  const brokerCommissionsRaw = safeArray(
    options.brokerCommissions
    || brokerReconciliation.commissions
    || [],
  );
  const commissionsByExecId = new Map(brokerCommissionsRaw.filter((row) => row?.execId).map((row) => [row.execId, row]));
  const quoteByRoot = new Map();
  try {
    const quoteMap = futuresMarketDataService.defaultFuturesMarketDataService.getStatus(now)?.quotes || {};
    for (const [root, row] of Object.entries(quoteMap)) {
      if (row?.root) quoteByRoot.set(String(row.root).toUpperCase(), row);
      else if (row) quoteByRoot.set(String(root).toUpperCase(), row);
    }
  } catch (_) { /* degraded */ }
  // Ordrarna normaliseras före positionerna: skyddsordrarna bär den orderRef som
  // kopplar en position till sin strategi och sina SL/TP-nivåer.
  const intentByExecutionId = buildIntentContext(brokerReconciliation);
  const brokerOrders = safeArray(options.brokerOrders || brokerReconciliation.openOrders)
    .map((row) => normalizeBrokerOrder(row, intentByExecutionId));
  const protectiveByConId = buildProtectiveContextByConId(brokerOrders, intentByExecutionId);
  // Entrypriset för en öppen position finns i entry-fillen från IBKR. Positionens
  // avgCost är kostnadsbas inklusive multiplikator och är därför inte samma sak.
  const rawBrokerExecutions = safeArray(options.brokerExecutions || brokerReconciliation.executions);
  // reqExecutions returnerar HELA handelsdagen, och varje trade på samma kontrakt
  // delar conId. Entryfillen får därför bara komma från positionens EGEN execution —
  // den som de öppna skyddsordrarna redan pekat ut. Utan känd execution vinner den
  // senaste entryfillen, aldrig dagens första.
  const boundExecutionIdByConId = new Map(
    [...protectiveByConId.entries()].map(([key, value]) => [key, value.executionId || null]),
  );
  for (const row of rawBrokerExecutions) {
    const ref = String(row?.orderRef || '');
    if (!ref.endsWith('-entry') || row?.conId == null) continue;
    const key = String(row.conId);
    if (!protectiveByConId.has(key)) {
      protectiveByConId.set(key, { stopLoss: null, takeProfit: null, executionId: null, intent: null });
    }
    const entry = protectiveByConId.get(key);
    const rowExecutionId = ibPaperBrokerReconciliationService.executionIdFromOrderRef(ref);
    const boundExecutionId = boundExecutionIdByConId.get(key) || null;
    if (boundExecutionId && rowExecutionId !== boundExecutionId) continue;
    if (row.price != null) entry.entryPrice = row.price;
    const intent = intentForOrderRef(intentByExecutionId, ref);
    if (intent && (!entry.intent || !boundExecutionId)) {
      entry.intent = intent;
      entry.executionId = rowExecutionId;
    }
  }
  const brokerPositions = safeArray(options.brokerPositions || brokerReconciliation.positions)
    .map((row) => normalizeBrokerPosition(row, {
      reconciliationTimestamp: brokerReconciliation.generatedAt || null,
      quote: quoteByRoot.get(String(row.symbol || row.root || '').toUpperCase()) || null,
      protective: protectiveByConId.get(String(row.conId ?? row.contract?.conId ?? '')) || null,
    }));
  const brokerExecutions = rawBrokerExecutions
    .map((row) => normalizeBrokerExecution(row, commissionsByExecId, intentByExecutionId));
  const closedBrokerExecutions = brokerExecutions.filter(futuresPaperStrategyPerformanceService.isClosedBrokerExecution);
  const {
    broker,
    orders,
    executions,
    commissions,
  } = buildCanonicalBrokerRuntime({
    brokerReconciliation,
    brokerPositions,
    brokerOrders,
    brokerExecutions,
    brokerCommissions: brokerCommissionsRaw,
  });
  const positions = {
    open: brokerPositions,
    closed: [],
    totalOpen: brokerPositions.length,
    totalClosed: 0,
    updatedAt: brokerReconciliation.generatedAt || null,
    source: 'ibkr_paper',
  };
  const closedTrades = closedBrokerExecutions;
  const recentClosedTrades = { ok: true, trades: closedBrokerExecutions, source: 'ibkr_paper' };
  const latestEvents = [];
  const strategyOverview = options.strategyOverview
    || buildCanonicalStrategyOverview({
      now,
	      session,
	      paperStrategies,
	      openPositions: [],
	      scannerStrategies: strategyStatus?.strategies || [],
	      candidateQueue: scannerRuntime?.candidateQueue?.candidates || [],
	    });

  // Lätta, cache-baserade IB-summeringar (aldrig tunga IB-anrop härifrån).
  let ibDataLayer = { enabled: false, started: false, connected: false, source: 'disabled' };
  let ibAccount = options.ibAccount || null;
  let dataPipeline = null;
  try { ibDataLayer = futuresMarketDataService.defaultFuturesMarketDataService.getStatusSummary(now); } catch (_) { /* degraded */ }
  try {
    if (!ibAccount) ibAccount = ibPaperAccountSummaryService.defaultIbPaperAccountSummaryService.getCachedSummary();
  } catch (_) { /* degraded */ }
  try {
    const pipeline = futuresDataPipelineStatusService.getStatus({ now });
    dataPipeline = { replay: pipeline.replay, batch: pipeline.batch };
  } catch (_) { /* degraded */ }
  const nextTransition = (() => {
    try { return futuresMarketHoursService.getNextSessionTransition(now); } catch (_) { return null; }
  })();
  const { account: activeAccount, margin } = buildCanonicalAccountAndMargin(ibAccount);
  const accountUpdatePositions = safeArray(ibAccount?.portfolioPositions).map((row) => normalizeBrokerPosition(row, {
    reconciliationTimestamp: ibAccount?.generatedAt || null,
    quote: quoteByRoot.get(String(row.symbol || row.root || '').toUpperCase()) || null,
  }));
  const runtimeOpenPositions = brokerPositions.length ? brokerPositions : accountUpdatePositions;
  positions.open = runtimeOpenPositions;
  positions.totalOpen = runtimeOpenPositions.length;
  if (!brokerPositions.length && accountUpdatePositions.length) {
    positions.updatedAt = ibAccount?.generatedAt || null;
    positions.source = 'ibkr_paper_account_updates';
  }
  const openPositions = runtimeOpenPositions;
  const portfolio = buildCanonicalPortfolio({
    account: activeAccount,
    positions,
    orders,
    executions,
  });
  const runtimePerformance = buildCanonicalPerformance({
    account: activeAccount,
    positions,
    orders,
    executions: { ...executions, items: closedBrokerExecutions, count: closedBrokerExecutions.length },
    portfolio,
    intents: safeArray(brokerReconciliation.intents),
  });
  const legacyClosedTrades = options.legacyClosedTrades
    || futuresPaperLedgerService.defaultFuturesPaperLedgerService.getRecentClosedTrades({
      limit: scannerRuntime?.engineConfig?.closedTradesLimit || 100,
    });
  const legacyInternalSimulation = {
    ...internalSimulationRetirement.buildReadOnlyLegacyMetadata(),
    archive: true,
    label: 'Äldre interna simuleringar — används inte för nya trades',
    account: legacyLedgerResult?.account || null,
    positions: legacyLedgerResult?.positions || { open: [], closed: [], totalOpen: 0, totalClosed: 0 },
    openPositions: legacyLedgerResult?.openPositions || [],
    closedTrades: legacyLedgerResult?.closedTrades || [],
    recentClosedTrades: legacyClosedTrades?.trades || [],
    latestEvents: legacyLedgerResult?.latestEvents || [],
  };

  return {
    ok: true,
    generatedAt: nowIso(now),
    ibDataLayer,
    ibAccount,
    dataPipeline,
    nextSessionTransition: nextTransition,
    desk: {
      id: 'futures-paper',
      route: '/futures-paper',
      label: 'Paper Futures',
      focusMarkets: ['MNQ', 'MES'],
      scope: 'futures_paper',
      paperOnly: true,
      manualControlsEnabled: false,
      unlimitedTradeLimit: true,
      notes: [
        'Futures Paper använder IBKR Paper Trading som enda execution-miljö.',
        'Shadow mode validerar strategier och orderplaner; faktisk ordersändning är avstängd.',
        'Livekonton och riktiga pengar är blockerade.',
      ],
    },
    market: session,
    account: activeAccount,
    margin,
    portfolio,
    performance: runtimePerformance,
    broker,
    orders,
    executions,
    commissions,
    accountConfig: null,
    positions,
    openPositions,
    closedTrades,
    brokerPositions: runtimeOpenPositions,
    brokerOrders,
    brokerExecutions,
    brokerFills: brokerExecutions,
    brokerCommissions: brokerCommissionsRaw,
    brokerReconciliation,
    latestEvents,
    instruments,
    strategyPulse,
    scanner: {
      groups: ['mini_futures'],
      marketGroup: universe.groups?.mini_futures || null,
      selectedSymbols: instruments.map((row) => row.symbol),
      note: 'Futures-desken använder befintliga strategier som kandidatkällor och fokuserar på MNQ/MES.',
      signalSource: 'canonical_signal_pipeline',
      connected: Boolean(scannerRuntime?.scanner?.connected),
      lastScanAt: scannerRuntime?.scanner?.lastScanAt || null,
      lastScanSummary: scannerRuntime?.scanner?.lastScanSummary || null,
      lastTickAt: scannerRuntime?.scanner?.lastTickAt || null,
    },
    autoSimulation: scannerRuntime?.autoSimulation || { enabled: false, intervalMs: null, timerActive: false, retired: true },
    candidateQueue: scannerRuntime?.candidateQueue || { connected: false, length: 0, candidates: [] },
    scanHistory: scannerRuntime?.scanHistory || [],
    executionTargetModel: scannerRuntime?.executionTargetModel || null,
    strategyStatus: strategyStatus?.strategies || [],
    strategyStatusMeta: strategyStatus ? {
      totalStrategies: strategyStatus.totalStrategies,
      approvedStrategies: strategyStatus.approvedStrategies,
      tradableNow: strategyStatus.tradableNow,
      config: strategyStatus.config,
    } : null,
    strategyOverview: strategyOverview.strategies,
    strategyOverviewMeta: {
      totalStrategies: strategyOverview.totalStrategies,
      currentSession: strategyOverview.currentSession,
      currentSessionId: strategyOverview.currentSessionId,
      marketOpen: strategyOverview.marketOpen,
      counts: strategyOverview.counts,
    },
    recentClosedTrades: recentClosedTrades?.trades || [],
    legacyInternalSimulation,
    dataFeed: scannerRuntime?.dataFeed || { source: 'none', simulated: false, fallback: false },
    quotes: scannerRuntime?.quotes || [],
    statusReasons: scannerRuntime?.statusReasons || [],
    chart: {
      activeSymbol: 'MNQ',
      markerPlan: ['entry', 'exit', 'stop_loss', 'take_profit'],
      description: 'Chart-markers för aktiv Futures Paper byggs bara från IBKR Paper fills när de finns.',
    },
    controls: {
      manualTradingEnabled: false,
      manualTradingNote: 'Intern simulation är avvecklad. Kandidater kan bara nå IBKR Paper shadow execution.',
      maxTradesPerDay: null,
      maxOpenTrades: brokerReconciliation?.counts?.positions ?? null,
    },
    technical: {
      runtimeSource: 'futuresPaperDeskService',
      universeSource: 'marketUniverseService',
      strategySource: 'futuresTradingOsSignalAdapterService',
      accountSource: 'ibPaperAccountSummaryService',
      scannerSource: 'futuresPaperScannerService',
      priceFeedSource: scannerRuntime?.dataFeed?.source || 'futuresPaperPriceFeedService',
      activePositionSource: 'ibPaperBrokerReconciliationService',
      activeTradeSource: 'ibPaperBrokerReconciliationService',
      legacyArchiveSource: 'futuresPaperLedgerService',
    },
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  FUTURES_INSTRUMENTS,
  DESK_FOCUS_INSTRUMENTS,
  DEFAULT_ACCOUNT,
  PAPER_STATUSES,
  getFuturesSessionState,
  calcFuturesPnl,
  sessionAllowedForStrategy,
  normalizePaperExecutionStatus,
  normalizeBrokerOrder,
  buildCanonicalStrategyOverview,
  buildFuturesPaperDeskRuntime,
};
