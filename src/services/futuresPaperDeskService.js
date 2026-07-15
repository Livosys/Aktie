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
  'DIAGNOSTIC_ONLY',
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
  DIAGNOSTIC_ONLY: 'diagnostic_only',
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
    return 'DIAGNOSTIC_ONLY';
  }
  if (row.runtimeConnectorStatus && row.runtimeConnectorStatus !== 'active') return 'DATA_BLOCKED';
  if (row.entryContractStatus === 'missing') return 'ENTRY_CONTRACT_BLOCKED';
  // DISABLED_BY_USER = ej godkänd/aktiverad för paper — approval-spärr, inte "ej tillämplig".
  if (row.paperEligibility === 'DISABLED_BY_USER'
    || row.approved !== true
    || ['paused', 'removed', 'not_approved'].includes(String(row.approvalStatus || '').toLowerCase())) {
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

function summarizeDiagnosticResult(row = {}) {
  const diag = row.entryContractDiagnostics || null;
  const blocker = row.latestEntryContractBlock || row.commonEntryContractBlocker || null;
  if (blocker && blocker.reasonCode) return blocker.reasonCode;
  if (diag && diag.status) return diag.status;
  if (row.runtimeBlockedReason) return row.runtimeBlockedReason;
  if (row.paperBlockedReason) return row.paperBlockedReason;
  return row.readiness || row.technicalReadiness || null;
}

function buildCanonicalStrategyOverview({
  now,
  session,
  paperStrategies,
  openPositions,
  scannerStrategies,
} = {}) {
  const catalogRows = safeArray(daytradingStrategyCatalogService.getCatalog().strategies);
  const paperRows = safeArray(paperStrategies?.strategies);
  const paperById = toMap(paperRows, (row) => safeString(row.strategyId));
  const scannerById = toMap(safeArray(scannerStrategies), (row) => safeString(row.strategyId));
  const openPositionsByStrategy = toMap(safeArray(openPositions), (row) => safeString(row.strategyId));
  const sessionLabel = session?.sessionLabel || session?.session || 'Globex';
  const sessionId = session?.sessionId || null;
  const sessionOpen = session?.isMarketOpen === true;

  const rows = catalogRows.map((strategy) => {
    const paperRow = paperById.get(strategy.id) || {};
    const scannerRow = scannerById.get(strategy.id) || null;
    const openPosition = openPositionsByStrategy.get(strategy.id) || null;
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

    return {
      strategyId: strategy.id,
      displayName: paperRow.displayName || strategy.name || strategy.id,
      family: paperRow.family || strategy.family || null,
      strategyFamily: paperRow.family || strategy.family || null,
      market: paperRow.market || strategy.market_group || strategy.market || null,
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
      latestSignal: summarizeStrategySignal(paperRow),
      latestCandidate: paperRow.latestCandidate || null,
      latestPaperTrade: paperRow.latestPaperTrade || null,
      openPaperPosition: openPosition ? {
        id: openPosition.id || openPosition.positionId || null,
        symbol: openPosition.symbol || openPosition.root || null,
        direction: openPosition.direction || null,
        openedAt: openPosition.openedAt || openPosition.entryTime || null,
      } : null,
      mainBlocker: canTradeNow || paperStatus === 'ACTIVE_PAPER' ? null : mainBlocker,
      readinessStatus: paperRow.readiness || paperRow.technicalReadiness || null,
      paperExecutionStatus: paperStatus,
      paperStatus,
      canTradeNow,
      paperBlockedReason: paperRow.paperBlockedReason || null,
      approvalStatus: paperRow.approvalStatus || null,
      approved: paperRow.approved === true,
      selectedInFamily: paperRow.selectedInFamily === true,
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
    if (row.paperStatus === 'DIAGNOSTIC_ONLY') acc.diagnosticOnly += 1;
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
    diagnosticOnly: 0,
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

function buildFuturesPaperDeskRuntime(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const universe = options.universe || marketUniverseService.getUniverse();
  const performance = options.performance || strategyPerformanceReadService.getTopStrategies(5);
  const ledgerResult = options.ledger || futuresPaperLedgerService.defaultFuturesPaperLedgerService.getFuturesPaperLedger({
    limit: options.limit || 50,
  });
  const accountResult = options.account || ledgerResult;
  const account = accountResult?.account || futuresPaperAccountService.createDefaultState(futuresPaperAccountService.DEFAULT_CONFIG);
  const instruments = normalizeMiniFutures(universe);
  const session = getFuturesSessionState(now);
  const strategyPulse = normalizePerformance(performance);
  const paperStrategies = options.paperStrategies
    || paperEnabledStrategiesService.buildPaperStrategyList({ fresh: options.fresh === true });
  const baseBalance = Number(account.startingBalanceSek ?? options.startingBalance ?? DEFAULT_ACCOUNT.startingBalance) || DEFAULT_ACCOUNT.startingBalance;
  const positions = ledgerResult?.positions || {
    open: [],
    closed: [],
    totalOpen: 0,
    totalClosed: 0,
  };
  const openPositions = ledgerResult?.openPositions || positions.open || [];
  const closedTrades = ledgerResult?.closedTrades || positions.closed || [];
  const latestEvents = ledgerResult?.latestEvents || [];
  const scannerRuntime = options.scannerRuntime
    || futuresPaperScannerService.defaultFuturesPaperScannerService.getScannerRuntime({ now });
  const strategyStatus = options.strategyStatus
    || futuresPaperScannerService.defaultFuturesPaperScannerService.getStrategyStatus({ now });
  const recentClosedTrades = options.recentClosedTrades
    || futuresPaperLedgerService.defaultFuturesPaperLedgerService.getRecentClosedTrades({
      limit: scannerRuntime?.engineConfig?.closedTradesLimit || 100,
    });
  const strategyOverview = options.strategyOverview
    || buildCanonicalStrategyOverview({
      now,
      session,
      paperStrategies,
      openPositions,
      scannerStrategies: strategyStatus?.strategies || [],
    });

  // Lätta, cache-baserade IB-summeringar (aldrig tunga IB-anrop härifrån).
  let ibDataLayer = { enabled: false, started: false, connected: false, source: 'disabled' };
  let ibAccount = null;
  let dataPipeline = null;
  try { ibDataLayer = futuresMarketDataService.defaultFuturesMarketDataService.getStatusSummary(now); } catch (_) { /* degraded */ }
  try { ibAccount = ibPaperAccountSummaryService.defaultIbPaperAccountSummaryService.getCachedSummary(); } catch (_) { /* degraded */ }
  try {
    const pipeline = futuresDataPipelineStatusService.getStatus({ now });
    dataPipeline = { replay: pipeline.replay, batch: pipeline.batch };
  } catch (_) { /* degraded */ }
  const nextTransition = (() => {
    try { return futuresMarketHoursService.getNextSessionTransition(now); } catch (_) { return null; }
  })();

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
        'Separat futures-desk för MNQ och MES.',
        'Inga riktiga order, ingen broker, ingen live-execution.',
      ],
    },
    market: session,
    account: {
      baseCurrency: account.currency || DEFAULT_ACCOUNT.baseCurrency,
      startingBalanceSek: account.startingBalanceSek ?? baseBalance,
      cashSek: account.cashSek ?? baseBalance,
      equitySek: account.equitySek ?? baseBalance,
      realizedPnlSek: account.realizedPnlSek ?? 0,
      unrealizedPnlSek: account.unrealizedPnlSek ?? 0,
      totalPnlSek: account.totalPnlSek ?? 0,
      dailyPnlSek: account.dailyPnlSek ?? 0,
      peakEquitySek: account.peakEquitySek ?? baseBalance,
      drawdownSek: account.drawdownSek ?? 0,
      drawdownPct: account.drawdownPct ?? 0,
      openExposureSek: account.openExposureSek ?? 0,
      buyingPowerSek: account.buyingPowerSek ?? baseBalance,
      usedMarginSek: account.usedMarginSek ?? 0,
      availableMarginSek: account.availableMarginSek ?? baseBalance,
      totalFeesSek: account.totalFeesSek ?? 0,
      fxUsdSek: account.fxUsdSek ?? futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek,
      updatedAt: account.updatedAt || nowIso(now),
    },
    positions,
    openPositions,
    closedTrades,
    latestEvents,
    instruments,
    strategyPulse,
    scanner: {
      groups: ['mini_futures'],
      marketGroup: universe.groups?.mini_futures || null,
      selectedSymbols: instruments.map((row) => row.symbol),
      note: 'Futures-desken använder befintliga strategier som kandidatkällor och fokuserar på MNQ/MES.',
      signalSource: 'trading_os_signal_adapter',
      connected: Boolean(scannerRuntime?.scanner?.connected),
      lastScanAt: scannerRuntime?.scanner?.lastScanAt || null,
      lastScanSummary: scannerRuntime?.scanner?.lastScanSummary || null,
      lastTickAt: scannerRuntime?.scanner?.lastTickAt || null,
    },
    autoSimulation: scannerRuntime?.autoSimulation || { enabled: false, intervalMs: null, timerActive: false },
    candidateQueue: scannerRuntime?.candidateQueue || { connected: false, length: 0, candidates: [] },
    scanHistory: scannerRuntime?.scanHistory || [],
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
    dataFeed: scannerRuntime?.dataFeed || { source: 'none', simulated: false, fallback: false },
    quotes: scannerRuntime?.quotes || [],
    statusReasons: scannerRuntime?.statusReasons || [],
    chart: {
      activeSymbol: 'MNQ',
      markerPlan: ['entry', 'exit', 'stop_loss', 'take_profit'],
      description: 'Chart-markers byggs från simulerade trades (entry, exit, stop loss, take profit).',
    },
    controls: {
      manualTradingEnabled: true,
      manualTradingNote: 'Manuell simulerad handel och paper-scanner är aktiva. Endast intern simulation.',
      maxTradesPerDay: null,
      maxOpenTrades: scannerRuntime?.scanner?.maxOpenPositions ?? null,
    },
    technical: {
      runtimeSource: 'futuresPaperDeskService',
      universeSource: 'marketUniverseService',
      strategySource: 'futuresTradingOsSignalAdapterService',
      accountSource: 'futuresPaperAccountService',
      scannerSource: 'futuresPaperScannerService',
      priceFeedSource: scannerRuntime?.dataFeed?.source || 'futuresPaperPriceFeedService',
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
  buildCanonicalStrategyOverview,
  buildFuturesPaperDeskRuntime,
};
