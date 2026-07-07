'use strict';

// Paper-only futures scanner + candidate queue + auto-simulation för MNQ/MES.
// Skapar aldrig riktiga order, anropar aldrig broker/IBKR och har ingen
// koppling till någon submit-väg. Allt är intern simulation mot den lokala
// futures-paper-ledgern och den simulerade fallback-prisfeeden.
//
// Automation-regler (Futures Paper Automation Engine):
// - strategikälla = samma godkännandekedja som interna Paper Trading
//   (paperAllowlistService -> automationApprovalService)
// - max N trades per strategyId (FUTURES_PAPER_MAX_TRADES_PER_STRATEGY, default 10)
// - cooldown per strategyId (FUTURES_PAPER_STRATEGY_COOLDOWN_MINUTES, default 60)
// - scan history (FUTURES_PAPER_SCAN_HISTORY_LIMIT, default 10)

const path = require('path');
const storageService = require('./futuresPaperStorageService');
const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperPriceFeedService = require('./futuresPaperPriceFeedService');
const strategyPerformanceReadService = require('./strategyPerformanceReadService');
const paperAllowlistService = require('./paperAllowlistService');

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
const STOP_LOSS_PCT = 0.3;
const TAKE_PROFIT_PCT = 0.6;

const BLOCK_REASON_MAX_TRADES = 'max_strategy_trades_reached';
const BLOCK_REASON_COOLDOWN = 'strategy_cooldown_active';

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function createCandidateId(now = new Date()) {
  return `futures_candidate_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`;
}

function createScanId(now = new Date()) {
  return `futures_scan_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`;
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
  const allowlistService = options.allowlistService || paperAllowlistService;
  const configOverrides = options.config || {};
  const stateFile = path.join(storage.rootDir, 'scanner-state.json');
  const candidatesFile = path.join(storage.rootDir, 'candidates.json');
  const scanHistoryFile = path.join(storage.rootDir, 'scan-history.json');
  let autoTimer = null;

  function getEngineConfig() {
    return {
      maxTradesPerStrategy: configOverrides.maxTradesPerStrategy
        ?? envInt('FUTURES_PAPER_MAX_TRADES_PER_STRATEGY', 10),
      cooldownMinutes: configOverrides.cooldownMinutes
        ?? envInt('FUTURES_PAPER_STRATEGY_COOLDOWN_MINUTES', 60),
      scanHistoryLimit: configOverrides.scanHistoryLimit
        ?? envInt('FUTURES_PAPER_SCAN_HISTORY_LIMIT', 10),
      closedTradesLimit: configOverrides.closedTradesLimit
        ?? envInt('FUTURES_PAPER_CLOSED_TRADES_LIMIT', 100),
      autoIntervalSeconds: configOverrides.autoIntervalSeconds
        ?? envInt('FUTURES_PAPER_AUTO_INTERVAL_SECONDS', 60),
    };
  }

  function createDefaultScannerState(now = new Date()) {
    return {
      autoSimulationEnabled: false,
      autoIntervalMs: getEngineConfig().autoIntervalSeconds * 1000,
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

  function readScanHistory() {
    const raw = storageService.readJson(scanHistoryFile, null);
    return Array.isArray(raw?.scans) ? raw.scans.filter(Boolean) : [];
  }

  function appendScanHistory(scanRecord) {
    const limit = getEngineConfig().scanHistoryLimit;
    const scans = [scanRecord, ...readScanHistory()].slice(0, limit);
    storageService.writeJson(scanHistoryFile, { scans, updatedAt: nowIso() });
    return scans;
  }

  function bumpLastScan(patch) {
    const scans = readScanHistory();
    if (!scans.length) return null;
    const next = { ...scans[0], ...patch };
    storageService.writeJson(scanHistoryFile, { scans: [next, ...scans.slice(1)], updatedAt: nowIso() });
    return next;
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

  function getPerformanceMap() {
    try {
      const performance = performanceService.getTopStrategies(50);
      const rows = Array.isArray(performance?.strategies)
        ? performance.strategies
        : Array.isArray(performance?.results)
          ? performance.results
          : Array.isArray(performance) ? performance : [];
      const map = {};
      for (const row of rows.filter(Boolean)) {
        const id = row.strategy_id || row.strategyId || row.id;
        if (id) map[String(id)] = row;
      }
      return map;
    } catch (_) {
      return {};
    }
  }

  // DEL 1: Strategikälla. Samma godkännandekedja som interna Paper Trading:
  // paperAllowlistService (automationApprovalService) + strategy performance.
  function getApprovedStrategySource() {
    let allowlist = [];
    let allowlistError = null;
    try {
      allowlist = allowlistService.getPaperAllowlistStatus().allowlist || [];
    } catch (err) {
      allowlistError = err.message;
    }
    const perfMap = getPerformanceMap();

    const strategies = allowlist.map((row) => {
      const perf = perfMap[row.id] || null;
      const score = Number(perf?.score);
      let skipReason = null;
      if (!row.readyForPaperRuntime) {
        skipReason = row.blockers?.length ? `paper_runtime_blocked:${row.blockers[0]}` : 'paper_runtime_not_ready';
      } else if (!perf) {
        skipReason = 'no_strategy_performance_data';
      }
      return {
        strategyId: row.id,
        strategyName: row.name || row.id,
        approved: true,
        source: 'paper_allowlist',
        performance: perf ? {
          winRate: perf.win_rate ?? perf.winRate ?? null,
          avgPnl: perf.avg_pnl ?? perf.avgPnl ?? null,
          score: Number.isFinite(score) ? score : null,
          trades: perf.trades ?? perf.trades_count ?? 0,
        } : null,
        confidence: Number.isFinite(score) ? Math.max(0.1, Math.min(0.95, score / 100)) : 0.5,
        skipReason,
      };
    });

    return { strategies, allowlistError };
  }

  // Trade-statistik per strategyId från ledgerns positioner (öppna + stängda).
  function getStrategyTradeStats(strategyId, positionsSummary = null) {
    const positions = positionsSummary || ledger.getPositionsSummary();
    const id = String(strategyId || '');
    const open = (positions.open || []).filter((row) => String(row.strategyId || '') === id);
    const closed = (positions.closed || []).filter((row) => String(row.strategyId || '') === id);
    let lastTradeAtMs = 0;
    for (const row of [...open, ...closed]) {
      const openedMs = Date.parse(row.openedAt || '') || 0;
      const closedMs = Date.parse(row.closedAt || '') || 0;
      lastTradeAtMs = Math.max(lastTradeAtMs, openedMs, closedMs);
    }
    return {
      openTrades: open.length,
      closedTrades: closed.length,
      tradesUsed: open.length + closed.length,
      lastTradeAt: lastTradeAtMs ? new Date(lastTradeAtMs).toISOString() : null,
      totalPnlSek: Math.round(closed.reduce((acc, row) => acc + (Number(row.realizedPnlSek) || 0), 0) * 100) / 100,
      wins: closed.filter((row) => (Number(row.realizedPnlSek) || 0) > 0).length,
    };
  }

  // DEL 2 + DEL 3: max trades per strategi och cooldown per strategi.
  function evaluateStrategyGate(strategyId, { now = new Date(), positionsSummary = null } = {}) {
    const config = getEngineConfig();
    const stats = getStrategyTradeStats(strategyId, positionsSummary);
    const cooldownMs = config.cooldownMinutes * 60_000;
    const nowMs = new Date(now).getTime();
    const lastTradeMs = stats.lastTradeAt ? Date.parse(stats.lastTradeAt) : 0;
    const cooldownActive = lastTradeMs > 0 && (nowMs - lastTradeMs) < cooldownMs;
    const nextAllowedAt = lastTradeMs > 0 ? new Date(lastTradeMs + cooldownMs).toISOString() : null;
    const cooldownMinutesRemaining = cooldownActive
      ? Math.ceil((lastTradeMs + cooldownMs - nowMs) / 60_000)
      : 0;

    let blockReason = null;
    if (stats.tradesUsed >= config.maxTradesPerStrategy) {
      blockReason = BLOCK_REASON_MAX_TRADES;
    } else if (cooldownActive) {
      blockReason = BLOCK_REASON_COOLDOWN;
    }

    return {
      strategyId,
      canTradeNow: blockReason === null,
      blockReason,
      tradesUsed: stats.tradesUsed,
      maxTrades: config.maxTradesPerStrategy,
      openTrades: stats.openTrades,
      closedTrades: stats.closedTrades,
      lastTradeAt: stats.lastTradeAt,
      nextAllowedAt,
      cooldownActive,
      cooldownMinutesRemaining,
      totalPnlSek: stats.totalPnlSek,
      wins: stats.wins,
    };
  }

  function buildCandidate({ symbol, quote, strategy, now = new Date() }) {
    const price = Number(quote?.price) || null;
    const previous = Number(quote?.previousPrice) || price;
    const direction = price != null && previous != null && price < previous ? 'short' : 'long';
    return {
      candidateId: createCandidateId(now),
      symbol,
      direction,
      confidence: strategy.confidence ?? 0.5,
      strategyId: strategy.strategyId,
      strategyName: strategy.strategyName,
      entryReason: `Paper-simulation: ${strategy.strategyName} + simulerad ${direction}-momentum på fallback-pris ${price ?? 'okänt'}.`,
      referencePrice: price,
      priceSource: quote?.source || 'simulated_fallback',
      simulatedData: true,
      testOnly: strategy.testOnly === true,
      timestamp: nowIso(now),
      source: 'futures_paper_scanner',
      paperOnly: true,
      status: 'queued',
      ...SAFETY,
    };
  }

  // DEL 4 + DEL 7: strategidriven scan med gates och scan history.
  function runScannerOnce({ now = new Date() } = {}) {
    const startedAt = nowIso(now);
    const config = getEngineConfig();
    const feed = priceFeed.tickQuotes(now);
    const { strategies, allowlistError } = getApprovedStrategySource();
    const positionsSummary = ledger.getPositionsSummary();
    const queue = readQueue();
    const added = [];
    const skippedStrategies = [];
    const blockedByCooldown = [];
    const blockedByMaxTrades = [];

    // Lediga symboler: ingen öppen position och ingen köad kandidat på symbolen.
    const busySymbols = new Set([
      ...(positionsSummary.open || []).map((row) => String(row.symbol || row.root || '').toUpperCase().slice(0, 3)),
      ...queue.map((row) => String(row.symbol || '').toUpperCase()),
    ]);
    const freeSymbols = SCANNER_SYMBOLS.filter((symbol) => !busySymbols.has(symbol));

    const scannableStrategies = strategies.length > 0
      ? strategies
      : [{
        strategyId: 'futures_paper_test_dummy',
        strategyName: 'Test/Simulation Dummy',
        approved: false,
        source: 'test_dummy_no_allowlist',
        performance: null,
        confidence: 0.5,
        skipReason: null,
        testOnly: true,
      }];

    for (const strategy of scannableStrategies) {
      if (strategy.skipReason) {
        skippedStrategies.push({ strategyId: strategy.strategyId, reason: strategy.skipReason });
        continue;
      }
      const gate = evaluateStrategyGate(strategy.strategyId, { now, positionsSummary });
      if (gate.blockReason === BLOCK_REASON_COOLDOWN) {
        blockedByCooldown.push({
          strategyId: strategy.strategyId,
          reason: BLOCK_REASON_COOLDOWN,
          lastTradeAt: gate.lastTradeAt,
          nextAllowedAt: gate.nextAllowedAt,
          cooldownMinutesRemaining: gate.cooldownMinutesRemaining,
        });
        continue;
      }
      if (gate.blockReason === BLOCK_REASON_MAX_TRADES) {
        blockedByMaxTrades.push({
          strategyId: strategy.strategyId,
          reason: BLOCK_REASON_MAX_TRADES,
          tradesUsed: gate.tradesUsed,
          maxTrades: gate.maxTrades,
        });
        continue;
      }
      const hasQueuedCandidate = queue.some((row) => String(row.strategyId || '') === strategy.strategyId)
        || added.some((row) => row.strategyId === strategy.strategyId);
      if (hasQueuedCandidate) {
        skippedStrategies.push({ strategyId: strategy.strategyId, reason: 'candidate_already_queued' });
        continue;
      }
      if (queue.length + added.length >= MAX_QUEUE_LENGTH) {
        skippedStrategies.push({ strategyId: strategy.strategyId, reason: 'queue_full' });
        continue;
      }
      const symbol = freeSymbols.shift();
      if (!symbol) {
        skippedStrategies.push({ strategyId: strategy.strategyId, reason: 'no_free_symbol' });
        continue;
      }
      const quote = feed.quotes.find((row) => row.root === symbol) || null;
      added.push(buildCandidate({ symbol, quote, strategy, now }));
    }

    const nextQueue = writeQueue([...queue, ...added]);
    const finishedAt = nowIso();
    const scanRecord = {
      scanId: createScanId(now),
      startedAt,
      finishedAt,
      symbolsScanned: SCANNER_SYMBOLS,
      strategiesChecked: scannableStrategies.length,
      approvedStrategies: strategies.length,
      candidatesCreated: added.length,
      skippedStrategies,
      tradesOpened: 0,
      blockedByCooldown,
      blockedByMaxTrades,
      dataSource: feed.feed.source,
      simulatedData: true,
      allowlistError: allowlistError || null,
      status: 'completed',
      summary: `${scannableStrategies.length} strategier kontrollerade, ${added.length} kandidater, `
        + `${blockedByCooldown.length} cooldown-blockerade, ${blockedByMaxTrades.length} max-limit-blockerade, `
        + `${skippedStrategies.length} skippade.`,
      config: {
        maxTradesPerStrategy: config.maxTradesPerStrategy,
        cooldownMinutes: config.cooldownMinutes,
      },
      ...SAFETY,
    };
    appendScanHistory(scanRecord);
    writeScannerState({ lastScanAt: startedAt, lastScanSummary: scanRecord });
    if (added.length > 0) {
      persistEvent('FUTURES_SCANNER_CANDIDATES_ADDED', { candidates: added, scanId: scanRecord.scanId }, now);
    }

    return {
      ok: true,
      generatedAt: finishedAt,
      scan: scanRecord,
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
  // Gaterna (max trades + cooldown) kontrolleras igen vid simulering.
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

    const gate = evaluateStrategyGate(candidate.strategyId, { now });
    if (!gate.canTradeNow) {
      return {
        ok: false,
        error: gate.blockReason,
        blockReason: gate.blockReason,
        candidate,
        gate,
        ...SAFETY,
      };
    }

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

  // En hel simulation-tick: stega priser, uppdatera öppna positioner, scanna,
  // simulera kandidater vars strategi-gates tillåter trade just nu.
  function runSimulationTick({ now = new Date(), source = 'manual' } = {}) {
    const market = ledger.getMarketHoursState(now);
    priceFeed.tickQuotes(now);
    const refresh = refreshOpenPositions({ now });

    let scan = null;
    const simulatedPositions = [];
    if (market.isOpen) {
      scan = runScannerOnce({ now });
      // Simulera kandidater i turordning tills max öppna positioner nås.
      // Gate-blockerade kandidater lämnas kvar i kön till nästa tick.
      let guard = readQueue().length;
      while (guard > 0) {
        guard -= 1;
        const openCount = (ledger.getPositionsSummary().open || []).length;
        if (openCount >= MAX_OPEN_POSITIONS) break;
        const queue = readQueue();
        const nextCandidate = queue.find((row) => evaluateStrategyGate(row.strategyId, { now }).canTradeNow);
        if (!nextCandidate) break;
        const simulated = simulateCandidate({ candidateId: nextCandidate.candidateId, now });
        if (!simulated.ok) break;
        simulatedPositions.push(simulated.position);
      }
      if (simulatedPositions.length > 0) {
        bumpLastScan({ tradesOpened: simulatedPositions.length });
      }
    }

    const summary = {
      source,
      marketOpen: market.isOpen,
      scanned: Boolean(scan?.ok),
      candidatesAdded: scan?.scan?.candidatesCreated || 0,
      tradesOpened: simulatedPositions.length,
      simulatedTradeIds: simulatedPositions.map((row) => row.tradeId),
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
      simulatedPositions,
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
    const interval = Math.max(10_000, Number(intervalMs) || getEngineConfig().autoIntervalSeconds * 1000);
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
      autoIntervalMs: Math.max(10_000, Number(intervalMs) || readScannerState().autoIntervalMs || getEngineConfig().autoIntervalSeconds * 1000),
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

  // DEL 6: strategy status per strategi (godkända + strategier med ledger-historik).
  function getStrategyStatus({ now = new Date() } = {}) {
    const { strategies, allowlistError } = getApprovedStrategySource();
    const positionsSummary = ledger.getPositionsSummary();
    const approvedIds = new Set(strategies.map((row) => row.strategyId));

    // Strategier som har trades i ledgern men inte (längre) är godkända.
    const historicalIds = new Set();
    for (const row of [...(positionsSummary.open || []), ...(positionsSummary.closed || [])]) {
      const id = String(row.strategyId || '');
      if (id && !approvedIds.has(id)) historicalIds.add(id);
    }

    const rows = [
      ...strategies.map((strategy) => ({ strategy, approved: true })),
      ...[...historicalIds].map((id) => ({
        strategy: {
          strategyId: id,
          strategyName: [...(positionsSummary.open || []), ...(positionsSummary.closed || [])]
            .find((row) => String(row.strategyId || '') === id)?.strategyName || id,
          approved: false,
          source: 'ledger_history',
          performance: null,
          skipReason: 'not_in_paper_allowlist',
        },
        approved: false,
      })),
    ].map(({ strategy, approved }) => {
      const gate = evaluateStrategyGate(strategy.strategyId, { now, positionsSummary });
      const winRate = gate.closedTrades > 0
        ? Math.round((gate.wins / gate.closedTrades) * 10000) / 100
        : null;
      return {
        strategyId: strategy.strategyId,
        strategyName: strategy.strategyName,
        approved,
        source: strategy.source,
        skipReason: strategy.skipReason || null,
        performance: strategy.performance || null,
        tradesUsed: gate.tradesUsed,
        maxTrades: gate.maxTrades,
        openTrades: gate.openTrades,
        closedTrades: gate.closedTrades,
        lastTradeAt: gate.lastTradeAt,
        nextAllowedAt: gate.nextAllowedAt,
        cooldownActive: gate.cooldownActive,
        cooldownMinutesRemaining: gate.cooldownMinutesRemaining,
        canTradeNow: approved && !strategy.skipReason && gate.canTradeNow,
        blockReason: !approved
          ? 'not_in_paper_allowlist'
          : strategy.skipReason || gate.blockReason,
        totalPnlSek: gate.totalPnlSek,
        winRate,
      };
    });

    return {
      ok: true,
      generatedAt: nowIso(now),
      totalStrategies: rows.length,
      approvedStrategies: rows.filter((row) => row.approved).length,
      tradableNow: rows.filter((row) => row.canTradeNow).length,
      allowlistError: allowlistError || null,
      config: getEngineConfig(),
      strategies: rows,
      ...SAFETY,
    };
  }

  function getScanHistory() {
    const scans = readScanHistory();
    return {
      ok: true,
      generatedAt: nowIso(),
      totalScans: scans.length,
      limit: getEngineConfig().scanHistoryLimit,
      scans,
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
      scanHistory: readScanHistory(),
      dataFeed: feed.feed,
      quotes: feed.quotes,
      engineConfig: getEngineConfig(),
      statusReasons: buildStatusReasons({ now }),
      ...SAFETY,
    };
  }

  function resetScanner() {
    stopAutoTimer();
    storageService.writeJson(stateFile, createDefaultScannerState());
    storageService.writeJson(scanHistoryFile, { scans: [], updatedAt: nowIso() });
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
    scanHistoryFile,
    assertPaperOnly,
    getEngineConfig,
    readScannerState,
    getApprovedStrategySource,
    getStrategyTradeStats,
    evaluateStrategyGate,
    runScannerOnce,
    getCandidates,
    simulateCandidate,
    refreshOpenPositions,
    runSimulationTick,
    setAutoSimulation,
    getStrategyStatus,
    getScanHistory,
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
