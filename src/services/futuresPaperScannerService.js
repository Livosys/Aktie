'use strict';

// Paper-only futures scanner + candidate queue + auto-simulation för MNQ/MES.
// Skapar aldrig riktiga order, anropar aldrig broker/IBKR och har ingen
// koppling till någon submit-väg. Allt är intern simulation mot den lokala
// futures-paper-ledgern och den simulerade fallback-prisfeeden.

const path = require('path');
const storageService = require('./futuresPaperStorageService');
const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperPriceFeedService = require('./futuresPaperPriceFeedService');
const strategyPerformanceReadService = require('./strategyPerformanceReadService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'futures_paper_scanner',
});

const SCANNER_SYMBOLS = Object.freeze(['MNQ', 'MES']);
const MAX_QUEUE_LENGTH = 10;
const MAX_OPEN_POSITIONS = 2;
const DEFAULT_AUTO_INTERVAL_MS = 60_000;
const STOP_LOSS_PCT = 0.3;
const TAKE_PROFIT_PCT = 0.6;

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function createCandidateId(now = new Date()) {
  return `futures_candidate_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`;
}

// Hård paper-only-gate: vägrar om något live-/broker-flöde efterfrågas.
function assertPaperOnly(input = {}) {
  if (input.live_trading_enabled === true) return 'live_trading_is_not_allowed';
  if (input.broker_enabled === true) return 'broker_is_not_allowed';
  if (input.can_place_orders === true) return 'real_orders_are_not_allowed';
  if (input.actions_allowed === true) return 'real_actions_are_not_allowed';
  if (input.mode != null && String(input.mode) !== 'paper_only') return 'mode_must_be_paper_only';
  return null;
}

function createFuturesPaperScannerService(options = {}) {
  const storage = options.storageService || storageService.defaultFuturesPaperStorageService;
  const ledger = options.ledgerService || futuresPaperLedgerService.defaultFuturesPaperLedgerService;
  const priceFeed = options.priceFeedService || futuresPaperPriceFeedService.defaultFuturesPaperPriceFeedService;
  const performanceService = options.performanceService || strategyPerformanceReadService;
  const stateFile = path.join(storage.rootDir, 'scanner-state.json');
  const candidatesFile = path.join(storage.rootDir, 'candidates.json');
  let autoTimer = null;

  function createDefaultScannerState(now = new Date()) {
    return {
      autoSimulationEnabled: false,
      autoIntervalMs: DEFAULT_AUTO_INTERVAL_MS,
      lastScanAt: null,
      lastScanSummary: null,
      lastTickAt: null,
      lastTickSummary: null,
      updatedAt: nowIso(now),
    };
  }

  function readScannerState() {
    const raw = storageService.readJson(stateFile, null);
    if (raw && typeof raw === 'object') {
      return { ...createDefaultScannerState(), ...raw };
    }
    const fresh = createDefaultScannerState();
    storageService.writeJson(stateFile, fresh);
    return fresh;
  }

  function writeScannerState(patch) {
    const next = { ...readScannerState(), ...patch, updatedAt: nowIso() };
    storageService.writeJson(stateFile, next);
    return next;
  }

  function readQueue() {
    const raw = storageService.readJson(candidatesFile, null);
    return Array.isArray(raw?.candidates) ? raw.candidates.filter(Boolean) : [];
  }

  function writeQueue(candidates) {
    storageService.writeJson(candidatesFile, {
      candidates: candidates.slice(0, MAX_QUEUE_LENGTH),
      updatedAt: nowIso(),
    });
    return candidates.slice(0, MAX_QUEUE_LENGTH);
  }

  function persistEvent(type, payload = {}, now = new Date()) {
    return storage.appendEvent({
      eventId: `futures_scanner_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`,
      type,
      timestamp: nowIso(now),
      ...payload,
      ...SAFETY,
    });
  }

  function getTopStrategiesSafe(limit = 5) {
    try {
      const performance = performanceService.getTopStrategies(limit);
      const rows = Array.isArray(performance?.strategies)
        ? performance.strategies
        : Array.isArray(performance?.results)
          ? performance.results
          : Array.isArray(performance) ? performance : [];
      return rows.filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function buildCandidate({ symbol, quote, strategy, now = new Date() }) {
    const price = Number(quote?.price) || null;
    const previous = Number(quote?.previousPrice) || price;
    const direction = price != null && previous != null && price < previous ? 'short' : 'long';
    const hasStrategy = strategy && (strategy.strategy_id || strategy.strategyId || strategy.id);
    const strategyId = hasStrategy
      ? String(strategy.strategy_id || strategy.strategyId || strategy.id)
      : 'futures_paper_test_dummy';
    const strategyName = hasStrategy
      ? String(strategy.strategy_name || strategy.strategyName || strategy.name || strategyId)
      : 'Test/Simulation Dummy';
    const score = Number(strategy?.score);
    const confidence = hasStrategy && Number.isFinite(score)
      ? Math.max(0.1, Math.min(0.95, score / 100))
      : 0.5;
    return {
      candidateId: createCandidateId(now),
      symbol,
      direction,
      confidence,
      strategyId,
      strategyName,
      entryReason: hasStrategy
        ? `Paper-simulation: ${strategyName} + simulerad ${direction}-momentum på fallback-pris ${price ?? 'okänt'}.`
        : `Test/simulation: dummy-kandidat (ingen strategy performance tillgänglig), simulerad ${direction} på fallback-pris ${price ?? 'okänt'}.`,
      referencePrice: price,
      priceSource: quote?.source || 'simulated_fallback',
      simulatedData: true,
      testOnly: !hasStrategy,
      timestamp: nowIso(now),
      source: 'futures_paper_scanner',
      paperOnly: true,
      status: 'queued',
      ...SAFETY,
    };
  }

  // Kör en scanning: bygger kandidater för MNQ/MES och lägger dem i kön.
  function runScannerOnce({ now = new Date() } = {}) {
    const feed = priceFeed.tickQuotes(now);
    const strategies = getTopStrategiesSafe(5);
    const queue = readQueue();
    const openPositions = ledger.getPositionsSummary().open || [];
    const added = [];
    const skipped = [];

    SCANNER_SYMBOLS.forEach((symbol, index) => {
      const hasOpenPosition = openPositions.some((row) => String(row.symbol || row.root || '').toUpperCase().startsWith(symbol));
      const alreadyQueued = queue.some((row) => String(row.symbol || '').toUpperCase() === symbol && row.status === 'queued');
      if (hasOpenPosition) {
        skipped.push({ symbol, reason: 'open_position_exists' });
        return;
      }
      if (alreadyQueued) {
        skipped.push({ symbol, reason: 'already_queued' });
        return;
      }
      if (queue.length + added.length >= MAX_QUEUE_LENGTH) {
        skipped.push({ symbol, reason: 'queue_full' });
        return;
      }
      const quote = feed.quotes.find((row) => row.root === symbol) || null;
      const candidate = buildCandidate({ symbol, quote, strategy: strategies[index] || strategies[0] || null, now });
      added.push(candidate);
    });

    const nextQueue = writeQueue([...queue, ...added]);
    const summary = {
      scannedSymbols: SCANNER_SYMBOLS,
      candidatesAdded: added.length,
      skipped,
      queueLength: nextQueue.length,
      priceSource: feed.feed.source,
      simulatedData: true,
    };
    writeScannerState({ lastScanAt: nowIso(now), lastScanSummary: summary });
    if (added.length > 0) {
      persistEvent('FUTURES_SCANNER_CANDIDATES_ADDED', { candidates: added, summary }, now);
    }

    return {
      ok: true,
      generatedAt: nowIso(now),
      scan: summary,
      candidates: added,
      queue: nextQueue,
      ...SAFETY,
    };
  }

  function getCandidates() {
    const queue = readQueue();
    return {
      ok: true,
      generatedAt: nowIso(),
      candidates: queue,
      totalCandidates: queue.length,
      ...SAFETY,
    };
  }

  // Konsumerar en kandidat och öppnar en simulerad paper-position via ledgern.
  function simulateCandidate({ candidateId = null, now = new Date() } = {}) {
    const queue = readQueue();
    if (!queue.length) {
      return { ok: false, error: 'no_candidates_in_queue', ...SAFETY };
    }
    const index = candidateId
      ? queue.findIndex((row) => String(row.candidateId || '') === String(candidateId))
      : 0;
    if (index < 0) {
      return { ok: false, error: 'candidate_not_found', ...SAFETY };
    }
    const candidate = queue[index];

    const openPositions = ledger.getPositionsSummary().open || [];
    if (openPositions.length >= MAX_OPEN_POSITIONS) {
      return { ok: false, error: 'max_open_positions_reached', maxOpenPositions: MAX_OPEN_POSITIONS, ...SAFETY };
    }

    const quote = priceFeed.getQuote(candidate.symbol, now);
    const entryPrice = Number(quote?.price) || Number(candidate.referencePrice) || null;
    if (!entryPrice || entryPrice <= 0) {
      return { ok: false, error: 'no_simulated_price_available', ...SAFETY };
    }

    const tickSize = Number(quote?.tickSize) || 0.25;
    const slDistance = entryPrice * (STOP_LOSS_PCT / 100);
    const tpDistance = entryPrice * (TAKE_PROFIT_PCT / 100);
    const isShort = candidate.direction === 'short';
    const stopLoss = futuresPaperPriceFeedService.roundToTick(isShort ? entryPrice + slDistance : entryPrice - slDistance, tickSize);
    const takeProfit = futuresPaperPriceFeedService.roundToTick(isShort ? entryPrice - tpDistance : entryPrice + tpDistance, tickSize);

    const result = ledger.openFuturesPaperPosition({
      now,
      root: candidate.symbol,
      symbol: candidate.symbol,
      side: candidate.direction,
      contracts: 1,
      entryPrice,
      stopLoss,
      takeProfit,
      strategyId: candidate.strategyId,
      strategyName: candidate.strategyName,
      entryReason: `${candidate.entryReason} [source=${candidate.source}, simulated_fallback_price]`,
    });

    if (!result.ok) {
      return { ...result, candidate };
    }

    const nextQueue = queue.filter((_, rowIndex) => rowIndex !== index);
    writeQueue(nextQueue);
    persistEvent('FUTURES_CANDIDATE_SIMULATED', {
      candidate,
      tradeId: result.position?.tradeId || null,
      entryPrice,
      stopLoss,
      takeProfit,
    }, now);

    return {
      ok: true,
      candidate,
      position: result.position,
      positions: result.positions,
      account: result.account,
      queue: nextQueue,
      ...SAFETY,
    };
  }

  // Mark-to-market: uppdatera öppna positioner mot simulerad feed och
  // stäng automatiskt på stop loss / take profit.
  function refreshOpenPositions({ now = new Date() } = {}) {
    const feed = priceFeed.getQuotes(now);
    const openPositions = ledger.getPositionsSummary().open || [];
    const closed = [];
    const updatedPrices = {};

    for (const position of openPositions) {
      const quote = feed.quotes.find((row) => row.root === String(position.root || position.symbol || '').toUpperCase());
      const price = Number(quote?.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      updatedPrices[position.tradeId] = price;

      const stopLoss = Number(position.stopLoss);
      const takeProfit = Number(position.takeProfit);
      const isShort = String(position.side) === 'short';
      let exitReason = null;
      let exitPrice = null;
      if (Number.isFinite(stopLoss) && stopLoss > 0 && (isShort ? price >= stopLoss : price <= stopLoss)) {
        exitReason = 'stop_loss_hit';
        exitPrice = stopLoss;
      } else if (Number.isFinite(takeProfit) && takeProfit > 0 && (isShort ? price <= takeProfit : price >= takeProfit)) {
        exitReason = 'take_profit_hit';
        exitPrice = takeProfit;
      }
      if (exitReason) {
        const closeResult = ledger.closeFuturesPaperPosition({
          now,
          tradeId: position.tradeId,
          exitPrice,
          exitReason,
        });
        if (closeResult.ok) closed.push(closeResult.trade);
      }
    }

    const marked = ledger.markOpenPositionsToMarket({ prices: updatedPrices, now });

    return {
      ok: true,
      generatedAt: nowIso(now),
      updatedPositions: marked.updated || 0,
      autoClosed: closed,
      feed: feed.feed,
      ...SAFETY,
    };
  }

  // En hel simulation-tick: stega priser, scanna, simulera max en kandidat,
  // uppdatera öppna positioner. Anropas manuellt eller av auto-timern.
  function runSimulationTick({ now = new Date(), source = 'manual' } = {}) {
    const market = ledger.getMarketHoursState(now);
    priceFeed.tickQuotes(now);
    const refresh = refreshOpenPositions({ now });

    let scan = null;
    let simulated = null;
    if (market.isOpen) {
      scan = runScannerOnce({ now });
      const openCount = (ledger.getPositionsSummary().open || []).length;
      if (openCount < MAX_OPEN_POSITIONS && readQueue().length > 0) {
        simulated = simulateCandidate({ now });
      }
    }

    const summary = {
      source,
      marketOpen: market.isOpen,
      scanned: Boolean(scan?.ok),
      candidatesAdded: scan?.scan?.candidatesAdded || 0,
      simulatedTradeId: simulated?.position?.tradeId || null,
      autoClosed: (refresh.autoClosed || []).map((row) => row.tradeId),
      updatedPositions: refresh.updatedPositions,
    };
    writeScannerState({ lastTickAt: nowIso(now), lastTickSummary: summary });

    return {
      ok: true,
      generatedAt: nowIso(now),
      market,
      tick: summary,
      scan: scan?.scan || null,
      simulatedPosition: simulated?.ok ? simulated.position : null,
      autoClosed: refresh.autoClosed,
      ...SAFETY,
    };
  }

  function stopAutoTimer() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  function startAutoTimer(intervalMs) {
    stopAutoTimer();
    const interval = Math.max(10_000, Number(intervalMs) || DEFAULT_AUTO_INTERVAL_MS);
    autoTimer = setInterval(() => {
      try {
        runSimulationTick({ source: 'auto_timer' });
      } catch (_) {
        // Paper-only simulation: ett misslyckat tick får aldrig krascha servern.
      }
    }, interval);
    if (typeof autoTimer.unref === 'function') autoTimer.unref();
  }

  function setAutoSimulation({ enabled, intervalMs = null } = {}) {
    const nextEnabled = enabled === true;
    const state = writeScannerState({
      autoSimulationEnabled: nextEnabled,
      autoIntervalMs: Math.max(10_000, Number(intervalMs) || readScannerState().autoIntervalMs || DEFAULT_AUTO_INTERVAL_MS),
    });
    if (nextEnabled) startAutoTimer(state.autoIntervalMs);
    else stopAutoTimer();
    persistEvent(nextEnabled ? 'FUTURES_AUTO_SIMULATION_ENABLED' : 'FUTURES_AUTO_SIMULATION_DISABLED', {
      autoIntervalMs: state.autoIntervalMs,
    });
    return {
      ok: true,
      autoSimulation: {
        enabled: state.autoSimulationEnabled,
        intervalMs: state.autoIntervalMs,
        timerActive: Boolean(autoTimer),
      },
      ...SAFETY,
    };
  }

  // Statusskäl för UI:t: exakt varför trades inte skapas just nu.
  function buildStatusReasons({ now = new Date() } = {}) {
    const state = readScannerState();
    const market = ledger.getMarketHoursState(now);
    const queue = readQueue();
    const account = ledger.getFuturesPaperLedger({ limit: 1 }).account || {};
    const reasons = [];
    if (!state.autoSimulationEnabled) {
      reasons.push({ code: 'auto_simulation_off', message: 'Auto simulation är avstängd.' });
    }
    if (!(Number(account.startingBalanceSek) > 0)) {
      reasons.push({ code: 'no_fake_capital', message: 'Sätt falskt kapital först.' });
    }
    if (!market.isOpen) {
      reasons.push({ code: 'session_closed', message: 'Session stängd (Globex).' });
    }
    reasons.push({ code: 'simulated_data', message: 'Simulated data: fallback-priser används, ingen riktig MNQ/MES-feed.' });
    if (queue.length === 0) {
      reasons.push({ code: 'empty_candidate_queue', message: 'Candidate queue är tom — kör scannern.' });
    }
    return reasons;
  }

  function getScannerRuntime({ now = new Date() } = {}) {
    const state = readScannerState();
    const queue = readQueue();
    const feed = priceFeed.getQuotes(now);
    return {
      ok: true,
      generatedAt: nowIso(now),
      scanner: {
        connected: true,
        symbols: SCANNER_SYMBOLS,
        lastScanAt: state.lastScanAt,
        lastScanSummary: state.lastScanSummary,
        lastTickAt: state.lastTickAt,
        lastTickSummary: state.lastTickSummary,
        maxQueueLength: MAX_QUEUE_LENGTH,
        maxOpenPositions: MAX_OPEN_POSITIONS,
      },
      autoSimulation: {
        enabled: state.autoSimulationEnabled,
        intervalMs: state.autoIntervalMs,
        timerActive: Boolean(autoTimer),
      },
      candidateQueue: {
        connected: true,
        length: queue.length,
        candidates: queue,
      },
      dataFeed: feed.feed,
      quotes: feed.quotes,
      statusReasons: buildStatusReasons({ now }),
      ...SAFETY,
    };
  }

  function resetScanner() {
    stopAutoTimer();
    storageService.writeJson(stateFile, createDefaultScannerState());
    writeQueue([]);
    return { ok: true, ...SAFETY };
  }

  // Återuppta auto-simulation efter restart om den var påslagen (paper-only).
  function resumeFromState() {
    const state = readScannerState();
    if (state.autoSimulationEnabled) startAutoTimer(state.autoIntervalMs);
    return state;
  }

  return {
    SAFETY,
    SCANNER_SYMBOLS,
    MAX_QUEUE_LENGTH,
    MAX_OPEN_POSITIONS,
    stateFile,
    candidatesFile,
    assertPaperOnly,
    readScannerState,
    runScannerOnce,
    getCandidates,
    simulateCandidate,
    refreshOpenPositions,
    runSimulationTick,
    setAutoSimulation,
    buildStatusReasons,
    getScannerRuntime,
    resetScanner,
    resumeFromState,
  };
}

const defaultFuturesPaperScannerService = createFuturesPaperScannerService();
defaultFuturesPaperScannerService.resumeFromState();

module.exports = {
  SAFETY,
  SCANNER_SYMBOLS,
  assertPaperOnly,
  createFuturesPaperScannerService,
  defaultFuturesPaperScannerService,
};
