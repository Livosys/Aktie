'use strict';

const storageService = require('./futuresPaperStorageService');
const futuresPaperAccountService = require('./futuresPaperAccountService');
const strategyTradeControl = require('./strategyTradeControlService');
const futuresContractCatalog = require('./futuresContractCatalogService');
const excursionService = require('./futuresPaperExcursionService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_ledger',
});

const DEFAULT_POSITIONS = Object.freeze({
  open: [],
  closed: [],
  updatedAt: null,
});

// Kontraktsmeta ägs numera av futuresContractCatalogService (MNQ/MES/NQ/ES).
// Behålls som härledd vy för bakåtkompatibilitet med tidigare importörer.
const FUTURES_META = Object.freeze(
  Object.fromEntries(
    Object.values(futuresContractCatalog.FUTURES_CONTRACTS).map((contract) => [
      contract.root,
      {
        pointValueUsd: contract.pointValueUsd,
        label: contract.name,
        exchange: contract.exchange,
        root: contract.root,
        commissionPerSideUsd: contract.defaultCommissionPerSideUsd,
      },
    ]),
  ),
);

const MARGIN_RATE = 0.10;

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

function ensureFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function booleanValue(value, fallback = false) {
  if (value === true || value === false) return value;
  return fallback;
}

function optionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeStrategyControlMetadata(position = {}) {
  const strategyId = optionalText(position.strategyId);
  const strategyFamily = strategyTradeControl.resolveStrategyFamily({
    strategyId,
    strategyFamily: optionalText(position.strategyFamily),
  });
  return {
    strategyFamily,
    familyRank: strategyFamily ? ensureFiniteNumber(position.familyRank) : null,
    familyGateDecision: strategyFamily
      ? (optionalText(position.familyGateDecision) || 'not_applicable')
      : 'not_applicable',
    familyBlockReason: strategyFamily ? optionalText(position.familyBlockReason) : null,
    strategyCooldownDecision: optionalText(position.strategyCooldownDecision) || 'not_applicable',
    strategyCooldownBlockReason: optionalText(position.strategyCooldownBlockReason),
    nextAllowedAt: optionalText(position.nextAllowedAt),
  };
}

function createTradeId(now = new Date()) {
  return `futures_trade_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeRoot(root, symbol = '') {
  return futuresContractCatalog.normalizeRoot(root, symbol);
}

function normalizeSide(side) {
  const value = String(side || '').trim().toLowerCase();
  if (value === 'long' || value === 'short') return value;
  return null;
}

function getPointValueUsd(root) {
  return futuresContractCatalog.getPointValueUsd(root);
}

function getCommissionPerSideUsd(root) {
  return futuresContractCatalog.getCommissionPerSideUsd(root);
}

// Simulerad avgift i USD för ett antal sidor (1 = open eller close, 2 = round trip).
function calcCommissionUsd(root, contracts, sides = 1) {
  return futuresContractCatalog.commissionUsd(root, contracts, sides);
}

function getMarketHoursState(now = new Date()) {
  const current = new Date(now);
  const day = current.getUTCDay();
  const minutes = current.getUTCHours() * 60 + current.getUTCMinutes();
  const maintenanceStart = 22 * 60;
  const maintenanceEnd = 23 * 60;

  let isOpen = false;
  if (day >= 1 && day <= 4) isOpen = !(minutes >= maintenanceStart && minutes < maintenanceEnd);
  else if (day === 5) isOpen = minutes < maintenanceStart;
  else if (day === 0) isOpen = minutes >= maintenanceEnd;

  return {
    isOpen,
    session: 'Globex',
    timezone: 'UTC',
    maintenanceWindow: '22:00-23:00 UTC',
    warning: isOpen ? null : 'Globex-sessionen är stängd eller i underhållsfönster. Positionen hanteras ändå som intern simulation.',
  };
}

function calculatePnlUsd({ root, entryPrice, exitPrice, side, contracts }) {
  const pointValueUsd = getPointValueUsd(root);
  const entry = ensureFiniteNumber(entryPrice);
  const exit = ensureFiniteNumber(exitPrice);
  const size = Number(contracts);
  if (!pointValueUsd || !entry || !exit || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  const raw = side === 'short'
    ? (entry - exit) * pointValueUsd * size
    : (exit - entry) * pointValueUsd * size;
  return round(raw, 2);
}

function toPositionView(position, fxUsdSek = 0) {
  const root = normalizeRoot(position.root, position.symbol);
  const strategyControlMetadata = normalizeStrategyControlMetadata(position);
  const pointValueUsd = getPointValueUsd(root) || 0;
  const currentPrice = ensureFiniteNumber(position.currentPrice ?? position.entryPrice) ?? 0;
  const entryPrice = ensureFiniteNumber(position.entryPrice) ?? 0;
  const contracts = Number(position.contracts) || 0;
  const unrealizedPnlUsd = position.status === 'open'
    ? calculatePnlUsd({ root, entryPrice, exitPrice: currentPrice, side: position.side, contracts }) || 0
    : ensureFiniteNumber(position.unrealizedPnlUsd) ?? 0;
  const realizedPnlUsd = position.status === 'closed'
    ? ensureFiniteNumber(position.realizedPnlUsd) ?? 0
    : 0;
  const unrealizedPnlSek = ensureFiniteNumber(position.unrealizedPnlSek);
  const realizedPnlSek = position.status === 'closed'
    ? (ensureFiniteNumber(position.realizedPnlSek) ?? round(realizedPnlUsd * fxUsdSek, 2))
    : 0;

  // Simulerad courtage/fee. entryFee dras vid open, exitFee tillkommer vid close.
  const isClosed = position.status === 'closed';
  const commissionPerSideUsd = ensureFiniteNumber(position.commissionPerSideUsd)
    ?? getCommissionPerSideUsd(root) ?? 0;
  const entryFeeUsd = ensureFiniteNumber(position.entryFeeUsd)
    ?? round(commissionPerSideUsd * contracts, 2);
  const exitFeeUsd = isClosed
    ? (ensureFiniteNumber(position.exitFeeUsd) ?? round(commissionPerSideUsd * contracts, 2))
    : 0;
  const feesUsd = round(entryFeeUsd + exitFeeUsd, 2);
  const entryFeeSek = round(entryFeeUsd * fxUsdSek, 2);
  const exitFeeSek = round(exitFeeUsd * fxUsdSek, 2);
  const feesSek = round(feesUsd * fxUsdSek, 2);
  // Gross = ren prisrörelse (utan avgifter). Net = gross − avgifter.
  const grossPnlUsd = isClosed
    ? (ensureFiniteNumber(position.grossPnlUsd) ?? round(realizedPnlUsd + feesUsd, 2))
    : unrealizedPnlUsd;
  const grossPnlSek = round(grossPnlUsd * fxUsdSek, 2);

  return {
    tradeId: position.tradeId,
    root,
    symbol: position.symbol || root,
    side: position.side,
    contracts,
    entryPrice,
    currentPrice,
    exitPrice: ensureFiniteNumber(position.exitPrice),
    stopLoss: ensureFiniteNumber(position.stopLoss),
    takeProfit: ensureFiniteNumber(position.takeProfit),
    openedAt: position.openedAt || null,
    closedAt: position.closedAt || null,
    status: position.status || 'open',
    strategyId: position.strategyId || null,
    strategyName: position.strategyName || null,
    ...strategyControlMetadata,
    entryReason: position.entryReason || null,
    exitReason: position.exitReason || null,
    tradeType: position.tradeType || 'manual_simulation',
    signalSource: position.signalSource || 'manual',
    dataSource: position.dataSource || 'simulated_fallback',
    usedRealStrategyLogic: position.usedRealStrategyLogic === true,
    usedFallbackPrice: position.usedFallbackPrice !== false,
    excludedFromStats: position.excludedFromStats !== false,
    strategyLogicVersion: position.strategyLogicVersion || null,
    originalSignalId: position.originalSignalId || position.signalId || null,
    signalId: position.signalId || position.originalSignalId || null,
    candidateId: position.candidateId || null,
    originalSymbol: position.originalSymbol || null,
    originalMarket: position.originalMarket || null,
    mappedFuturesSymbol: position.mappedFuturesSymbol || position.symbol || root,
    mappingReason: position.mappingReason || null,
    mappingConfidence: ensureFiniteNumber(position.mappingConfidence),
    confidence: ensureFiniteNumber(position.confidence),
    riskReward: ensureFiniteNumber(position.riskReward),
    timeframe: position.timeframe || null,
    riskSource: position.riskSource || null,
    approvalReason: position.approvalReason || null,
    unrealizedPnlUsd,
    unrealizedPnlSek: position.status === 'open'
      ? (unrealizedPnlSek ?? round(unrealizedPnlUsd * fxUsdSek, 2))
      : 0,
    realizedPnlUsd,
    realizedPnlSek,
    commissionPerSideUsd,
    entryFeeUsd,
    entryFeeSek,
    exitFeeUsd,
    exitFeeSek,
    feesUsd,
    feesSek,
    grossPnlUsd,
    grossPnlSek,
    netPnlUsd: isClosed ? realizedPnlUsd : round(grossPnlUsd - entryFeeUsd, 2),
    netPnlSek: isClosed ? realizedPnlSek : round((grossPnlUsd - entryFeeUsd) * fxUsdSek, 2),

    // Additiv MFE/MAE-instrumentering (maskad för legacy-positioner).
    ...buildExcursionView(position, isClosed),
  };
}

// Läsvy för excursion-fälten. Strikt null-normalisering (saknat värde blir
// ALDRIG 0) + legacy-maskning: en position utan mfeMaeSource exponerar samtliga
// MFE/MAE-mått som null, även om rå storage råkar innehålla gamla skräpvärden
// (t.ex. lowestPriceWhileOpen=0). Provenance/exitType behålls som legacy.
function buildExcursionView(position = {}, isClosed = false) {
  const en = excursionService.normalizeExcursionNumber;
  const instrumented = excursionService.isInstrumented(position);
  const measure = (value) => (instrumented ? en(value) : null);
  return {
    highestPriceWhileOpen: measure(position.highestPriceWhileOpen),
    lowestPriceWhileOpen: measure(position.lowestPriceWhileOpen),
    maximumFavorableExcursionPoints: measure(position.maximumFavorableExcursionPoints),
    maximumAdverseExcursionPoints: measure(position.maximumAdverseExcursionPoints),
    maximumFavorableExcursionSek: measure(position.maximumFavorableExcursionSek),
    maximumAdverseExcursionSek: measure(position.maximumAdverseExcursionSek),
    maximumFavorableExcursionR: measure(position.maximumFavorableExcursionR),
    maximumAdverseExcursionR: measure(position.maximumAdverseExcursionR),
    peakUnrealizedPnlSek: measure(position.peakUnrealizedPnlSek),
    gaveBackFromPeakSek: measure(position.gaveBackFromPeakSek),
    initialStopPrice: measure(position.initialStopPrice),
    initialTargetPrice: measure(position.initialTargetPrice),
    initialRiskPoints: measure(position.initialRiskPoints),
    initialRiskSek: measure(position.initialRiskSek),
    finalStopPrice: measure(position.finalStopPrice),
    exitType: instrumented
      ? (position.exitType || (isClosed ? 'unknown_legacy' : null))
      : (isClosed ? 'unknown_legacy' : null),
    mfeMaeSource: position.mfeMaeSource || null,
    priceFeedSource: instrumented ? (position.priceFeedSource || position.dataSource || null) : null,
    measurementQuality: instrumented ? (position.measurementQuality || null) : null,
    hasExcursionData: instrumented,
  };
}

function createDefaultPositionsState(now = new Date()) {
  return {
    open: [],
    closed: [],
    updatedAt: nowIso(now),
  };
}

function sum(values) {
  return values.reduce((acc, value) => acc + (Number(value) || 0), 0);
}

function buildAccountState({ config, positionsState, now = new Date() }) {
  const accountSeed = futuresPaperAccountService.createDefaultState(config || futuresPaperAccountService.DEFAULT_CONFIG, now);
  const fxUsdSek = Number(config?.fxUsdSek ?? accountSeed.fxUsdSek ?? futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek) || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek;
  const openPositions = safeArray(positionsState?.open).map((position) => toPositionView(position, fxUsdSek));
  const closedPositions = safeArray(positionsState?.closed).map((position) => toPositionView(position, fxUsdSek));
  const startingBalanceSek = Number(config?.startingBalanceSek ?? accountSeed.startingBalanceSek ?? futuresPaperAccountService.DEFAULT_CONFIG.startingBalanceSek) || futuresPaperAccountService.DEFAULT_CONFIG.startingBalanceSek;
  // Realiserad PnL på stängda trades är redan netto (gross − avgifter).
  const realizedPnlSek = round(sum(closedPositions.map((position) => position.realizedPnlSek)), 2);
  const unrealizedPnlSek = round(sum(openPositions.map((position) => position.unrealizedPnlSek)), 2);
  // Entry-avgiften dras från cash redan vid open (öppna positioner har den kvar
  // som en dragning tills de stängs, då den ingår i den realiserade nettosiffran).
  const openEntryFeesSek = round(sum(openPositions.map((position) => position.entryFeeSek)), 2);
  const closedFeesSek = round(sum(closedPositions.map((position) => position.feesSek)), 2);
  const totalFeesSek = round(closedFeesSek + openEntryFeesSek, 2);
  const cashSek = round(startingBalanceSek + realizedPnlSek - openEntryFeesSek, 2);
  const equitySek = round(cashSek + unrealizedPnlSek, 2);
  const totalPnlSek = round(equitySek - startingBalanceSek, 2);
  const dailyPnlSek = totalPnlSek;
  const peakEquitySek = round(Math.max(startingBalanceSek, accountSeed.peakEquitySek || startingBalanceSek, equitySek), 2);
  const drawdownSek = round(Math.max(0, peakEquitySek - equitySek), 2);
  const drawdownPct = peakEquitySek > 0 ? round((drawdownSek / peakEquitySek) * 100, 2) : 0;
  const openExposureSek = round(sum(openPositions.map((position) => {
    const pointValueUsd = getPointValueUsd(position.root) || 0;
    return (position.currentPrice || position.entryPrice || 0) * pointValueUsd * (position.contracts || 0) * fxUsdSek;
  })), 2);
  const usedMarginSek = round(openExposureSek * MARGIN_RATE, 2);
  const availableMarginSek = round(Math.max(0, equitySek - usedMarginSek), 2);
  const buyingPowerSek = round(Math.max(cashSek, availableMarginSek), 2);

  return futuresPaperAccountService.buildAccountSnapshot({
    config: {
      currency: config?.currency || futuresPaperAccountService.DEFAULT_CONFIG.currency,
      startingBalanceSek,
      fxUsdSek,
    },
    state: {
      currency: config?.currency || futuresPaperAccountService.DEFAULT_CONFIG.currency,
      startingBalanceSek,
      cashSek,
      equitySek,
      realizedPnlSek,
      unrealizedPnlSek,
      totalPnlSek,
      dailyPnlSek,
      peakEquitySek,
      drawdownSek,
      drawdownPct,
      openExposureSek,
      buyingPowerSek,
      usedMarginSek,
      availableMarginSek,
      totalFeesSek,
      fxUsdSek,
      updatedAt: nowIso(now),
    },
    updatedAt: nowIso(now),
  });
}

function createFuturesPaperLedgerService(options = {}) {
  const storage = options.storageService || storageService.defaultFuturesPaperStorageService;
  const accountSvc = options.accountService || futuresPaperAccountService.defaultFuturesPaperAccountService;

  function ensureFiles() {
    storage.ensureDefaults(
      futuresPaperAccountService.DEFAULT_CONFIG,
      futuresPaperAccountService.createDefaultState(futuresPaperAccountService.DEFAULT_CONFIG),
      createDefaultPositionsState(),
    );
  }

  function readPositionsState() {
    ensureFiles();
    const raw = storage.readPositions(createDefaultPositionsState());
    const open = safeArray(raw?.open).map((position) => toPositionView(position, Number(accountSvc.getFuturesPaperAccount().account?.fxUsdSek || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek)));
    const closed = safeArray(raw?.closed).map((position) => toPositionView(position, Number(accountSvc.getFuturesPaperAccount().account?.fxUsdSek || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek)));
    return {
      open,
      closed,
      updatedAt: raw?.updatedAt || null,
    };
  }

  function writePositionsState(state) {
    const nextState = {
      open: safeArray(state?.open).map((position) => ({ ...position })),
      closed: safeArray(state?.closed).map((position) => ({ ...position })),
      updatedAt: nowIso(),
    };
    storage.writePositions(nextState);
    return nextState;
  }

  function readTrades(limit = null) {
    ensureFiles();
    const rows = storage.readTrades();
    const slice = Number.isFinite(Number(limit)) && Number(limit) > 0 ? rows.slice(-Math.max(1, Math.min(1000, Number(limit)))) : rows;
    return slice;
  }

  function persistEvent(type, payload = {}, now = new Date()) {
    return storage.appendEvent({
      eventId: `futures_ledger_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`,
      type,
      timestamp: nowIso(now),
      ...payload,
      ...SAFETY,
    });
  }

  function persistAccountSnapshot(snapshot) {
    const accountState = {
      ...snapshot,
      updatedAt: nowIso(),
    };
    storage.writeAccountState(accountState);
    storage.appendEquityCurve({
      timestamp: accountState.updatedAt,
      currency: accountState.currency,
      startingBalanceSek: accountState.startingBalanceSek,
      cashSek: accountState.cashSek,
      equitySek: accountState.equitySek,
      realizedPnlSek: accountState.realizedPnlSek,
      unrealizedPnlSek: accountState.unrealizedPnlSek,
      totalPnlSek: accountState.totalPnlSek,
      dailyPnlSek: accountState.dailyPnlSek,
      peakEquitySek: accountState.peakEquitySek,
      drawdownSek: accountState.drawdownSek,
      drawdownPct: accountState.drawdownPct,
      openExposureSek: accountState.openExposureSek,
      buyingPowerSek: accountState.buyingPowerSek,
      usedMarginSek: accountState.usedMarginSek,
      availableMarginSek: accountState.availableMarginSek,
      fxUsdSek: accountState.fxUsdSek,
      ...SAFETY,
    });
    return accountState;
  }

  function getCurrentAccount() {
    return accountSvc.getFuturesPaperAccount();
  }

  function getPositionsSummary(positionsState = null) {
    const state = positionsState || readPositionsState();
    return {
      open: state.open,
      closed: state.closed,
      totalOpen: state.open.length,
      totalClosed: state.closed.length,
      updatedAt: state.updatedAt || null,
    };
  }

  function getTradesSummary(limit = null) {
    return {
      trades: readTrades(limit),
    };
  }

  function getFuturesPaperLedger({ limit = 50 } = {}) {
    const now = new Date();
    const account = getCurrentAccount();
    const positions = getPositionsSummary(readPositionsState());
    const trades = readTrades(limit);
    const latestEvents = storage.readJsonl(storage.files.events).slice(-Math.max(1, Math.min(50, Number(limit) || 20)));
    const market = getMarketHoursState(now);

    return {
      ok: true,
      generatedAt: nowIso(now),
      account: account.account || futuresPaperAccountService.createDefaultState(futuresPaperAccountService.DEFAULT_CONFIG),
      accountConfig: account.config || futuresPaperAccountService.DEFAULT_CONFIG,
      positions,
      openPositions: positions.open,
      closedTrades: positions.closed,
      trades,
      latestEvents,
      market,
      ...SAFETY,
    };
  }

  function getFuturesPaperPositions() {
    const bundle = getFuturesPaperLedger({ limit: 100 });
    return {
      ok: true,
      generatedAt: bundle.generatedAt,
      positions: bundle.positions,
      openPositions: bundle.openPositions,
      closedPositions: bundle.closedTrades,
      market: bundle.market,
      ...SAFETY,
    };
  }

  function getFuturesPaperTrades({ limit = 100 } = {}) {
    const bundle = getFuturesPaperLedger({ limit });
    return {
      ok: true,
      generatedAt: bundle.generatedAt,
      trades: bundle.trades,
      totalTrades: bundle.trades.length,
      ...SAFETY,
    };
  }

  function openFuturesPaperPosition(input = {}) {
    ensureFiles();
    const now = input.now ? new Date(input.now) : new Date();
    const root = normalizeRoot(input.root, input.symbol);
    const side = normalizeSide(input.side);
    const contracts = Number(input.contracts);
    const entryPrice = ensureFiniteNumber(input.entryPrice);
    const stopLoss = input.stopLoss == null || input.stopLoss === '' ? null : ensureFiniteNumber(input.stopLoss);
    const takeProfit = input.takeProfit == null || input.takeProfit === '' ? null : ensureFiniteNumber(input.takeProfit);
    const symbol = String(input.symbol || root || '').trim().toUpperCase() || null;
    const strategyId = input.strategyId ? String(input.strategyId).trim() : null;
    const strategyName = input.strategyName ? String(input.strategyName).trim() : null;
    const entryReason = input.entryReason ? String(input.entryReason).trim() : null;
    const tradeType = input.tradeType ? String(input.tradeType).trim() : 'manual_simulation';
    const signalSource = input.signalSource ? String(input.signalSource).trim() : (tradeType === 'trading_os_signal' ? 'trading_os' : 'manual');
    const dataSource = input.dataSource ? String(input.dataSource).trim() : 'simulated_fallback';
    const usedRealStrategyLogic = booleanValue(input.usedRealStrategyLogic, false);
    const usedFallbackPrice = booleanValue(input.usedFallbackPrice, dataSource === 'simulated_fallback');
    const excludedFromStats = booleanValue(
      input.excludedFromStats,
      !(tradeType === 'trading_os_signal' && usedRealStrategyLogic === true && usedFallbackPrice === false),
    );
    const strategyControlMetadata = normalizeStrategyControlMetadata({
      strategyId,
      strategyFamily: input.strategyFamily,
      familyRank: input.familyRank,
      familyGateDecision: input.familyGateDecision,
      familyBlockReason: input.familyBlockReason,
      strategyCooldownDecision: input.strategyCooldownDecision,
      strategyCooldownBlockReason: input.strategyCooldownBlockReason,
      nextAllowedAt: input.nextAllowedAt,
    });
    const account = getCurrentAccount();

    if (!root) return { ok: false, error: 'invalid_root', ...SAFETY };
    if (!side) return { ok: false, error: 'invalid_side', ...SAFETY };
    if (!Number.isInteger(contracts) || contracts <= 0) return { ok: false, error: 'contracts_must_be_a_positive_integer', ...SAFETY };
    if (!entryPrice || entryPrice <= 0) return { ok: false, error: 'entryPrice_must_be_greater_than_0', ...SAFETY };
    if (stopLoss !== null && (!stopLoss || stopLoss <= 0)) return { ok: false, error: 'stopLoss_must_be_greater_than_0', ...SAFETY };
    if (takeProfit !== null && (!takeProfit || takeProfit <= 0)) return { ok: false, error: 'takeProfit_must_be_greater_than_0', ...SAFETY };

    const market = getMarketHoursState(now);
    const positionsState = readPositionsState();
    const currentAccount = account.account || futuresPaperAccountService.createDefaultState(futuresPaperAccountService.DEFAULT_CONFIG);
    const fxUsdSek = Number(account.account?.fxUsdSek || account.config?.fxUsdSek || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek) || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek;
    const commissionPerSideUsd = getCommissionPerSideUsd(root) ?? 0;
    const entryFeeUsd = calcCommissionUsd(root, contracts, 1);
    const entryFeeSek = round(entryFeeUsd * fxUsdSek, 2);
    const position = {
      tradeId: createTradeId(now),
      root,
      symbol: symbol || root,
      side,
      contracts,
      entryPrice: round(entryPrice, 2),
      currentPrice: round(entryPrice, 2),
      stopLoss: stopLoss === null ? null : round(stopLoss, 2),
      takeProfit: takeProfit === null ? null : round(takeProfit, 2),
      openedAt: nowIso(now),
      closedAt: null,
      status: 'open',
      strategyId,
      strategyName,
      ...strategyControlMetadata,
      entryReason,
      exitReason: null,
      tradeType,
      signalSource,
      dataSource,
      usedRealStrategyLogic,
      usedFallbackPrice,
      excludedFromStats,
      strategyLogicVersion: input.strategyLogicVersion || null,
      originalSignalId: input.originalSignalId || input.signalId || null,
      signalId: input.signalId || input.originalSignalId || null,
      candidateId: input.candidateId || null,
      originalSymbol: input.originalSymbol || null,
      originalMarket: input.originalMarket || null,
      mappedFuturesSymbol: input.mappedFuturesSymbol || symbol || root,
      mappingReason: input.mappingReason || null,
      mappingConfidence: ensureFiniteNumber(input.mappingConfidence),
      confidence: ensureFiniteNumber(input.confidence),
      riskReward: ensureFiniteNumber(input.riskReward),
      timeframe: input.timeframe || null,
      riskSource: input.riskSource || null,
      approvalReason: input.approvalReason || null,
      unrealizedPnlUsd: 0,
      unrealizedPnlSek: 0,
      realizedPnlUsd: 0,
      realizedPnlSek: 0,
      commissionPerSideUsd,
      entryFeeUsd,
      entryFeeSek,
      exitFeeUsd: 0,
      exitFeeSek: 0,
      feesUsd: entryFeeUsd,
      feesSek: entryFeeSek,
      grossPnlUsd: 0,
      grossPnlSek: 0,
      marketHoursWarning: market.warning,
    };

    // Additiv MFE/MAE-init (ändrar inte entry/stop/target). Highest/lowest = entry.
    Object.assign(position, excursionService.initExcursion({
      entryPrice: position.entryPrice,
      side,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      pointValueUsd: getPointValueUsd(root) || 0,
      contracts,
      fxUsdSek,
      dataSource,
      usedFallbackPrice,
    }));

    const nextPositionsState = {
      open: [...safeArray(positionsState.open).map((row) => ({ ...row })), position],
      closed: safeArray(positionsState.closed).map((row) => ({ ...row })),
      updatedAt: nowIso(now),
    };
    writePositionsState(nextPositionsState);

    const accountSnapshot = buildAccountState({
      config: account.config || futuresPaperAccountService.DEFAULT_CONFIG,
      positionsState: nextPositionsState,
      now,
    });
    persistAccountSnapshot(accountSnapshot);

    persistEvent('FUTURES_POSITION_OPENED', {
      tradeId: position.tradeId,
      root,
      symbol: position.symbol,
      side,
      contracts,
      entryPrice: position.entryPrice,
      strategyId,
      strategyName,
      ...strategyControlMetadata,
      entryReason,
      tradeType,
      signalSource,
      dataSource,
      usedRealStrategyLogic,
      usedFallbackPrice,
      excludedFromStats,
      originalSignalId: position.originalSignalId,
      originalSymbol: position.originalSymbol,
      mappedFuturesSymbol: position.mappedFuturesSymbol,
      mappingReason: position.mappingReason,
      marketHoursWarning: market.warning,
      account: accountSnapshot,
      market,
    }, now);

    return {
      ok: true,
      position: toPositionView(position, accountSnapshot.fxUsdSek),
      positions: getPositionsSummary(nextPositionsState),
      account: accountSnapshot,
      market,
      marketHoursWarning: market.warning,
      ...SAFETY,
    };
  }

  function closeFuturesPaperPosition(input = {}) {
    ensureFiles();
    const now = input.now ? new Date(input.now) : new Date();
    const tradeId = String(input.tradeId || '').trim();
    const exitPrice = ensureFiniteNumber(input.exitPrice);
    const exitReason = input.exitReason ? String(input.exitReason).trim() : 'manual_close';
    // Observerat feed-pris som utlöste stängningen (kan ligga bortom stop/take).
    // Additivt: används bara för MFE/MAE-extremen, aldrig för PnL/exit-priset.
    const markPrice = ensureFiniteNumber(input.markPrice);

    if (!tradeId) return { ok: false, error: 'tradeId_is_required', ...SAFETY };
    if (!exitPrice || exitPrice <= 0) return { ok: false, error: 'exitPrice_must_be_greater_than_0', ...SAFETY };

    const positionsState = readPositionsState();
    const openIndex = safeArray(positionsState.open).findIndex((row) => String(row.tradeId || '') === tradeId);
    if (openIndex < 0) {
      return { ok: false, error: 'open_position_not_found', ...SAFETY };
    }

    const openPosition = { ...positionsState.open[openIndex] };
    const market = getMarketHoursState(now);
    const account = getCurrentAccount();
    const closeRoot = normalizeRoot(openPosition.root, openPosition.symbol);
    // Gross = ren prisrörelse (pointValue · kontrakt), utan avgifter.
    const grossPnlUsd = calculatePnlUsd({
      root: closeRoot,
      entryPrice: openPosition.entryPrice,
      exitPrice,
      side: openPosition.side,
      contracts: openPosition.contracts,
    });
    const fxUsdSek = Number(account.account?.fxUsdSek || account.config?.fxUsdSek || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek) || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek;
    // Avgifter: entryFee dras vid open (kan vara sparad på positionen), exitFee vid close.
    const commissionPerSideUsd = ensureFiniteNumber(openPosition.commissionPerSideUsd)
      ?? getCommissionPerSideUsd(closeRoot) ?? 0;
    const entryFeeUsd = ensureFiniteNumber(openPosition.entryFeeUsd)
      ?? calcCommissionUsd(closeRoot, openPosition.contracts, 1);
    const exitFeeUsd = calcCommissionUsd(closeRoot, openPosition.contracts, 1);
    const feesUsd = round(entryFeeUsd + exitFeeUsd, 2);
    // Net PnL = gross − totala avgifter. realizedPnl = net (det som påverkar kontot).
    const netPnlUsd = round((grossPnlUsd || 0) - feesUsd, 2);
    const grossPnlSek = round((grossPnlUsd || 0) * fxUsdSek, 2);
    const feesSek = round(feesUsd * fxUsdSek, 2);
    const pnlSek = round(netPnlUsd * fxUsdSek, 2);
    const closedPosition = {
      ...openPosition,
      currentPrice: round(exitPrice, 2),
      exitPrice: round(exitPrice, 2),
      closedAt: nowIso(now),
      status: 'closed',
      exitReason,
      unrealizedPnlUsd: 0,
      unrealizedPnlSek: 0,
      commissionPerSideUsd,
      entryFeeUsd,
      entryFeeSek: round(entryFeeUsd * fxUsdSek, 2),
      exitFeeUsd,
      exitFeeSek: round(exitFeeUsd * fxUsdSek, 2),
      feesUsd,
      feesSek,
      grossPnlUsd: grossPnlUsd || 0,
      grossPnlSek,
      realizedPnlUsd: netPnlUsd,
      realizedPnlSek: pnlSek,
      marketHoursWarning: market.warning,
    };

    // Additiv: frys MFE/MAE. Viker in det observerade markPrice (annars exit-
    // priset) så extremen fångas, sätter exitType + gaveBackFromPeak (gross).
    Object.assign(closedPosition, excursionService.finalizeExcursion(openPosition, {
      exitPrice: markPrice != null ? markPrice : exitPrice,
      exitReason,
      grossPnlSek,
      entryPrice: openPosition.entryPrice,
      side: openPosition.side,
      pointValueUsd: getPointValueUsd(closeRoot) || 0,
      contracts: openPosition.contracts,
      fxUsdSek,
    }));

    const nextPositionsState = {
      open: safeArray(positionsState.open).filter((row) => String(row.tradeId || '') !== tradeId),
      closed: [...safeArray(positionsState.closed).map((row) => ({ ...row })), closedPosition],
      updatedAt: nowIso(now),
    };
    writePositionsState(nextPositionsState);

    const tradeRecord = {
      ...closedPosition,
      type: 'CLOSED_TRADE',
      entryReason: closedPosition.entryReason || null,
      exitReason,
      marketHoursWarning: market.warning,
      ...SAFETY,
    };
    storage.appendTrade(tradeRecord);

    const accountSnapshot = buildAccountState({
      config: account.config || futuresPaperAccountService.DEFAULT_CONFIG,
      positionsState: nextPositionsState,
      now,
    });
    persistAccountSnapshot(accountSnapshot);

    persistEvent('FUTURES_POSITION_CLOSED', {
      tradeId,
      root: closedPosition.root,
      symbol: closedPosition.symbol,
      side: closedPosition.side,
      contracts: closedPosition.contracts,
      entryPrice: closedPosition.entryPrice,
      exitPrice: round(exitPrice, 2),
      grossPnlUsd: closedPosition.grossPnlUsd,
      grossPnlSek: closedPosition.grossPnlSek,
      feesUsd: closedPosition.feesUsd,
      feesSek: closedPosition.feesSek,
      realizedPnlUsd: closedPosition.realizedPnlUsd,
      realizedPnlSek: closedPosition.realizedPnlSek,
      exitReason,
      ...normalizeStrategyControlMetadata(closedPosition),
      tradeType: closedPosition.tradeType || 'manual_simulation',
      signalSource: closedPosition.signalSource || 'manual',
      dataSource: closedPosition.dataSource || 'simulated_fallback',
      usedRealStrategyLogic: closedPosition.usedRealStrategyLogic === true,
      usedFallbackPrice: closedPosition.usedFallbackPrice !== false,
      excludedFromStats: closedPosition.excludedFromStats !== false,
      originalSignalId: closedPosition.originalSignalId || closedPosition.signalId || null,
      originalSymbol: closedPosition.originalSymbol || null,
      mappedFuturesSymbol: closedPosition.mappedFuturesSymbol || closedPosition.symbol || closedPosition.root,
      mappingReason: closedPosition.mappingReason || null,
      marketHoursWarning: market.warning,
      account: accountSnapshot,
      market,
    }, now);

    return {
      ok: true,
      trade: toPositionView(closedPosition, accountSnapshot.fxUsdSek),
      positions: getPositionsSummary(nextPositionsState),
      account: accountSnapshot,
      market,
      marketHoursWarning: market.warning,
      ...SAFETY,
    };
  }

  // Senaste stängda trades, nyast först, i ett komplett vy-format för UI/API.
  function getRecentClosedTrades({ limit = 100 } = {}) {
    ensureFiles();
    const positionsState = readPositionsState();
    const capped = Math.max(1, Math.min(1000, Number(limit) || 100));
    const trades = safeArray(positionsState.closed)
      .slice()
      .sort((a, b) => (Date.parse(b.closedAt || '') || 0) - (Date.parse(a.closedAt || '') || 0))
      .slice(0, capped)
      .map((row) => {
        const openedMs = Date.parse(row.openedAt || '') || 0;
        const closedMs = Date.parse(row.closedAt || '') || 0;
        const durationMinutes = openedMs && closedMs ? round((closedMs - openedMs) / 60000, 1) : null;
        const closeRoot = normalizeRoot(row.root, row.symbol);
        const commissionPerSideUsd = ensureFiniteNumber(row.commissionPerSideUsd)
          ?? getCommissionPerSideUsd(closeRoot) ?? 0;
        const feesUsd = ensureFiniteNumber(row.feesUsd)
          ?? calcCommissionUsd(closeRoot, row.contracts, 2);
        const feesSek = ensureFiniteNumber(row.feesSek) ?? 0;
        const grossPnlUsd = ensureFiniteNumber(row.grossPnlUsd)
          ?? round((ensureFiniteNumber(row.realizedPnlUsd) ?? 0) + feesUsd, 2);
        const grossPnlSek = ensureFiniteNumber(row.grossPnlSek) ?? 0;
        return {
          ...normalizeStrategyControlMetadata(row),
          tradeId: row.tradeId,
          symbol: row.symbol || row.root,
          strategyId: row.strategyId || null,
          strategyName: row.strategyName || null,
          direction: row.side,
          contracts: row.contracts,
          entryPrice: row.entryPrice,
          exitPrice: row.exitPrice,
          stopLoss: row.stopLoss,
          takeProfit: row.takeProfit,
          commissionPerSideUsd,
          feesUsd,
          feesSek,
          grossPnlUsd,
          grossPnlSek,
          netPnlUsd: ensureFiniteNumber(row.realizedPnlUsd) ?? round(grossPnlUsd - feesUsd, 2),
          netPnlSek: ensureFiniteNumber(row.realizedPnlSek) ?? 0,
          realizedPnlUsd: row.realizedPnlUsd,
          realizedPnlSek: row.realizedPnlSek,
          openedAt: row.openedAt,
          closedAt: row.closedAt,
          closeReason: row.exitReason || null,
          durationMinutes,
          tradeType: row.tradeType || 'manual_simulation',
          signalSource: row.signalSource || 'manual',
          dataSource: row.dataSource || 'simulated_fallback',
          usedRealStrategyLogic: row.usedRealStrategyLogic === true,
          usedFallbackPrice: row.usedFallbackPrice !== false,
          excludedFromStats: row.excludedFromStats !== false,
          strategyLogicVersion: row.strategyLogicVersion || null,
          originalSignalId: row.originalSignalId || row.signalId || null,
          originalSymbol: row.originalSymbol || null,
          mappedFuturesSymbol: row.mappedFuturesSymbol || row.symbol || row.root,
          mappingReason: row.mappingReason || null,
          mappingConfidence: ensureFiniteNumber(row.mappingConfidence),
          source: 'futures_paper_desk',
          paperOnly: true,
        };
      });
    return {
      ok: true,
      generatedAt: nowIso(),
      totalClosedTrades: safeArray(positionsState.closed).length,
      limit: capped,
      trades,
      ...SAFETY,
    };
  }

  // Paper-only mark-to-market: uppdaterar currentPrice + orealiserad PnL på
  // öppna positioner utifrån simulerade priser och sparar nytt kontosnapshot.
  function markOpenPositionsToMarket({ prices = {}, now = new Date() } = {}) {
    ensureFiles();
    const positionsState = readPositionsState();
    const account = getCurrentAccount();
    const fxUsdSek = Number(account.account?.fxUsdSek || account.config?.fxUsdSek || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek) || futuresPaperAccountService.DEFAULT_CONFIG.fxUsdSek;
    let updated = 0;

    const nextOpen = safeArray(positionsState.open).map((position) => {
      const price = ensureFiniteNumber(prices[position.tradeId]);
      if (!price || price <= 0) return { ...position };
      const root = normalizeRoot(position.root, position.symbol);
      const unrealizedPnlUsd = calculatePnlUsd({
        root,
        entryPrice: position.entryPrice,
        exitPrice: price,
        side: position.side,
        contracts: position.contracts,
      }) || 0;
      updated += 1;
      // Additiv: vik in observerat pris i MFE/MAE-banan (ingen exit-påverkan).
      const excursion = excursionService.applyPriceObservation(position, {
        price,
        entryPrice: position.entryPrice,
        side: position.side,
        pointValueUsd: getPointValueUsd(root) || 0,
        contracts: position.contracts,
        fxUsdSek,
      });
      return {
        ...position,
        ...excursion,
        currentPrice: round(price, 2),
        unrealizedPnlUsd,
        unrealizedPnlSek: round(unrealizedPnlUsd * fxUsdSek, 2),
      };
    });

    if (updated === 0) {
      return { ok: true, updated: 0, ...SAFETY };
    }

    const nextPositionsState = {
      open: nextOpen,
      closed: safeArray(positionsState.closed).map((row) => ({ ...row })),
      updatedAt: nowIso(now),
    };
    writePositionsState(nextPositionsState);
    const accountSnapshot = buildAccountState({
      config: account.config || futuresPaperAccountService.DEFAULT_CONFIG,
      positionsState: nextPositionsState,
      now,
    });
    persistAccountSnapshot(accountSnapshot);

    return {
      ok: true,
      updated,
      positions: getPositionsSummary(nextPositionsState),
      account: accountSnapshot,
      ...SAFETY,
    };
  }

  function resetState() {
    ensureFiles();
    const defaultPositions = createDefaultPositionsState();
    writePositionsState(defaultPositions);
    return defaultPositions;
  }

  return {
    SAFETY,
    createDefaultPositionsState,
    calculatePnlUsd,
    getMarketHoursState,
    readPositionsState,
    writePositionsState,
    getPositionsSummary,
    getTradesSummary,
    getFuturesPaperLedger,
    getFuturesPaperPositions,
    getFuturesPaperTrades,
    openFuturesPaperPosition,
    closeFuturesPaperPosition,
    getRecentClosedTrades,
    markOpenPositionsToMarket,
    resetState,
  };
}

const defaultFuturesPaperLedgerService = createFuturesPaperLedgerService();

module.exports = {
  SAFETY,
  DEFAULT_POSITIONS,
  FUTURES_META,
  MARGIN_RATE,
  nowIso,
  round,
  safeArray,
  ensureFiniteNumber,
  createTradeId,
  normalizeRoot,
  normalizeSide,
  getPointValueUsd,
  getCommissionPerSideUsd,
  calcCommissionUsd,
  getMarketHoursState,
  calculatePnlUsd,
  toPositionView,
  createDefaultPositionsState,
  buildAccountState,
  createFuturesPaperLedgerService,
  defaultFuturesPaperLedgerService,
};
