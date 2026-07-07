'use strict';

const marketUniverseService = require('./marketUniverseService');
const strategyPerformanceReadService = require('./strategyPerformanceReadService');
const futuresPaperAccountService = require('./futuresPaperAccountService');
const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperScannerService = require('./futuresPaperScannerService');

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

const FUTURES_INSTRUMENTS = Object.freeze([
  {
    symbol: 'MNQ',
    name: 'Nasdaq 100 Micro E-mini Futures',
    exchange: 'CME',
    root: 'MNQ',
    underlying: 'Nasdaq 100',
    contractSize: 2,
    tickSize: 0.25,
    tickValueUsd: 0.50,
    session: 'Globex',
    focusRank: 1,
  },
  {
    symbol: 'MES',
    name: 'S&P 500 Micro E-mini Futures',
    exchange: 'CME',
    root: 'MES',
    underlying: 'S&P 500',
    contractSize: 5,
    tickSize: 0.25,
    tickValueUsd: 1.25,
    session: 'Globex',
    focusRank: 2,
  },
]);

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

function getFuturesSessionState(now = new Date()) {
  const current = new Date(now);
  const day = current.getUTCDay();
  const minutes = current.getUTCHours() * 60 + current.getUTCMinutes();

  // Approximation for a read-only desk shell:
  // - Sunday opens at 23:00 UTC
  // - Friday closes at 22:00 UTC
  // - Saturday is closed
  // - Mon-Thu are open except the daily maintenance window around 22:00-23:00 UTC
  const maintenanceStart = 22 * 60;
  const maintenanceEnd = 23 * 60;
  let isOpen = false;
  if (day >= 1 && day <= 4) isOpen = !(minutes >= maintenanceStart && minutes < maintenanceEnd);
  else if (day === 5) isOpen = minutes < maintenanceStart;
  else if (day === 0) isOpen = minutes >= maintenanceEnd;
  else isOpen = false;

  return {
    isOpen,
    session: 'Globex',
    timezone: 'UTC',
    description: isOpen ? 'Futures-sessionen är öppen.' : 'Futures-sessionen är stängd eller i underhållsfönster.',
    maintenanceWindow: '22:00-23:00 UTC',
    nextChangeHint: isOpen ? 'Följ sessionen och kontrollerade pauser.' : 'Vänta på nästa Globex-fönster.',
  };
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
      description: instrument.symbol === 'MNQ'
        ? 'Nasdaq-fokuserad kontraktsvisning för den nya paper-desken.'
        : 'S&P 500-fokuserad kontraktsvisning för den nya paper-desken.',
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

  return {
    ok: true,
    generatedAt: nowIso(now),
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
      strategySource: 'strategyPerformanceReadService',
      accountSource: 'futuresPaperAccountService',
      scannerSource: 'futuresPaperScannerService',
      priceFeedSource: 'futuresPaperPriceFeedService (simulated_fallback)',
    },
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  FUTURES_INSTRUMENTS,
  DEFAULT_ACCOUNT,
  getFuturesSessionState,
  calcFuturesPnl,
  buildFuturesPaperDeskRuntime,
};
