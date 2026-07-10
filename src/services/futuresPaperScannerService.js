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
// - cooldown per strategyId (FUTURES_PAPER_STRATEGY_COOLDOWN_MINUTES om satt,
//   annars central STRATEGY_COOLDOWN_MINUTES, default 30 — strategyTradeControlService)
// - strategy family-exklusivitet: endast bästa kandidaten i en familj per scan,
//   öppen position i familjen blockerar nya, family cooldown (default 30 min)
// - scan history (FUTURES_PAPER_SCAN_HISTORY_LIMIT, default 10)

const path = require('path');
const storageService = require('./futuresPaperStorageService');
const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperPriceFeedService = require('./futuresPaperPriceFeedService');
const strategyPerformanceReadService = require('./strategyPerformanceReadService');
const paperAllowlistService = require('./paperAllowlistService');
const futuresTradingOsSignalAdapterService = require('./futuresTradingOsSignalAdapterService');
const strategyTradeControl = require('./strategyTradeControlService');
const futuresPaperStrategyApproval = require('./futuresPaperStrategyApprovalService');

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
const ENGINE_TEST_MODE_ENV = 'FUTURES_PAPER_ENGINE_TEST_MODE';

const BLOCK_REASON_MAX_TRADES = 'max_strategy_trades_reached';
const BLOCK_REASON_COOLDOWN = strategyTradeControl.BLOCK_REASON_STRATEGY_COOLDOWN;
const FAMILY_BLOCK_REASONS = new Set([
  strategyTradeControl.BLOCK_REASON_FAMILY_NOT_BEST,
  strategyTradeControl.BLOCK_REASON_FAMILY_POSITION_OPEN,
  strategyTradeControl.BLOCK_REASON_FAMILY_COOLDOWN,
]);

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function createCandidateId(now = new Date()) {
  const ts = new Date(now).getTime();
  return `futures_candidate_${Number.isFinite(ts) ? ts : Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function createScanId(now = new Date()) {
  const ts = new Date(now).getTime();
  return `futures_scan_${Number.isFinite(ts) ? ts : Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
  const signalAdapter = options.signalAdapterService || futuresTradingOsSignalAdapterService.defaultFuturesTradingOsSignalAdapterService;
  const configOverrides = options.config || {};
  const stateFile = path.join(storage.rootDir, 'scanner-state.json');
  const candidatesFile = path.join(storage.rootDir, 'candidates.json');
  const scanHistoryFile = path.join(storage.rootDir, 'scan-history.json');
  let autoTimer = null;

  function getEngineConfig() {
    const controlConfig = strategyTradeControl.getStrategyTradeControlConfig();
    return {
      maxTradesPerStrategy: configOverrides.maxTradesPerStrategy
        ?? envInt('FUTURES_PAPER_MAX_TRADES_PER_STRATEGY', 10),
      // Befintlig futures-env respekteras om satt; annars central default 30 min.
      cooldownMinutes: configOverrides.cooldownMinutes
        ?? envInt('FUTURES_PAPER_STRATEGY_COOLDOWN_MINUTES', controlConfig.cooldownMinutes),
      familyCooldownMinutes: configOverrides.familyCooldownMinutes
        ?? controlConfig.familyCooldownMinutes,
      familyExclusiveEnabled: configOverrides.familyExclusiveEnabled
        ?? controlConfig.familyExclusiveEnabled,
      scanHistoryLimit: configOverrides.scanHistoryLimit
        ?? envInt('FUTURES_PAPER_SCAN_HISTORY_LIMIT', 10),
      closedTradesLimit: configOverrides.closedTradesLimit
        ?? envInt('FUTURES_PAPER_CLOSED_TRADES_LIMIT', 100),
      autoIntervalSeconds: configOverrides.autoIntervalSeconds
        ?? envInt('FUTURES_PAPER_AUTO_INTERVAL_SECONDS', 60),
      engineTestMode: configOverrides.engineTestMode
        ?? envBool(ENGINE_TEST_MODE_ENV, false),
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
    const ts = new Date(now).getTime();
    return storage.appendEvent({
      eventId: `futures_scanner_${Number.isFinite(ts) ? ts : Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
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

  function isRealStrategyTrade(row = {}) {
    return row.tradeType === 'trading_os_signal'
      && row.usedRealStrategyLogic === true
      && row.excludedFromStats === false;
  }

  function isExcludedTrade(row = {}) {
    return row.excludedFromStats === true
      || row.tradeType === 'engine_test'
      || row.tradeType === 'manual_simulation'
      || row.tradeType === 'curl_test'
      || row.tradeType === 'cleanup'
      || row.usedRealStrategyLogic !== true;
  }

  // Trade-statistik per strategyId från ledgerns positioner (öppna + stängda).
  function getStrategyTradeStats(strategyId, positionsSummary = null) {
    const positions = positionsSummary || ledger.getPositionsSummary();
    const id = String(strategyId || '');
    const open = (positions.open || []).filter((row) => String(row.strategyId || '') === id);
    const closed = (positions.closed || []).filter((row) => String(row.strategyId || '') === id);
    const realOpen = open.filter(isRealStrategyTrade);
    const realClosed = closed.filter(isRealStrategyTrade);
    const excluded = [...open, ...closed].filter(isExcludedTrade);
    const testTrades = [...open, ...closed].filter((row) => row.tradeType && row.tradeType !== 'trading_os_signal');
    let lastTradeAtMs = 0;
    for (const row of [...open, ...closed]) {
      const openedMs = Date.parse(row.openedAt || '') || 0;
      const closedMs = Date.parse(row.closedAt || '') || 0;
      lastTradeAtMs = Math.max(lastTradeAtMs, openedMs, closedMs);
    }
    const totalPnlAll = Math.round(closed.reduce((acc, row) => acc + (Number(row.realizedPnlSek) || 0), 0) * 100) / 100;
    const totalPnlRealSignals = Math.round(realClosed.reduce((acc, row) => acc + (Number(row.realizedPnlSek) || 0), 0) * 100) / 100;
    const winsAll = closed.filter((row) => (Number(row.realizedPnlSek) || 0) > 0).length;
    const winsRealSignals = realClosed.filter((row) => (Number(row.realizedPnlSek) || 0) > 0).length;
    return {
      openTrades: open.length,
      closedTrades: closed.length,
      tradesUsed: open.length + closed.length,
      totalTradesAll: open.length + closed.length,
      totalTradesRealSignals: realOpen.length + realClosed.length,
      realSignalOpenTrades: realOpen.length,
      realSignalClosedTrades: realClosed.length,
      testTrades: testTrades.length,
      excludedTrades: excluded.length,
      lastTradeAt: lastTradeAtMs ? new Date(lastTradeAtMs).toISOString() : null,
      totalPnlSek: totalPnlAll,
      pnlAll: totalPnlAll,
      pnlRealSignals: totalPnlRealSignals,
      wins: winsAll,
      winsAll,
      winsRealSignals,
    };
  }

  // Familj för en futures-kandidat: explicit fält → katalog-family → rå signalFamily.
  function familyOfCandidate(candidate = {}) {
    return strategyTradeControl.resolveStrategyFamily({
      strategyId: candidate.strategyId || null,
      strategyFamily: candidate.strategyFamily || null,
      signalFamily: candidate.rawSignalSummary?.signalFamily || candidate.signalFamily || null,
    });
  }

  function familyOfPosition(row = {}) {
    return strategyTradeControl.resolveStrategyFamily({
      strategyId: row.strategyId || null,
      strategyFamily: row.strategyFamily || null,
      signalFamily: null,
    });
  }

  // Family-statistik från ledgern: öppna positioner + senaste trade i familjen.
  function getFamilyTradeStats(strategyFamily, positionsSummary = null) {
    const family = String(strategyFamily || '').trim().toLowerCase();
    if (!family) return { strategyFamily: null, openTrades: 0, lastTradeAt: null };
    const positions = positionsSummary || ledger.getPositionsSummary();
    const inFamily = (row) => familyOfPosition(row) === family;
    const open = (positions.open || []).filter(inFamily);
    const closed = (positions.closed || []).filter(inFamily);
    let lastTradeAtMs = 0;
    for (const row of [...open, ...closed]) {
      const openedMs = Date.parse(row.openedAt || '') || 0;
      const closedMs = Date.parse(row.closedAt || '') || 0;
      lastTradeAtMs = Math.max(lastTradeAtMs, openedMs, closedMs);
    }
    return {
      strategyFamily: family,
      openTrades: open.length,
      lastTradeAt: lastTradeAtMs ? new Date(lastTradeAtMs).toISOString() : null,
    };
  }

  // DEL 2 + DEL 3: max trades, cooldown per strategi samt strategy family gate.
  function evaluateStrategyGate(strategyId, {
    now = new Date(),
    positionsSummary = null,
    strategyFamily = null,
    familyRank = null,
  } = {}) {
    const config = getEngineConfig();
    const positions = positionsSummary || ledger.getPositionsSummary();
    const stats = getStrategyTradeStats(strategyId, positions);
    const cooldownMs = config.cooldownMinutes * 60_000;
    const nowMs = new Date(now).getTime();
    const lastTradeMs = stats.lastTradeAt ? Date.parse(stats.lastTradeAt) : 0;
    const cooldownActive = lastTradeMs > 0 && (nowMs - lastTradeMs) < cooldownMs;
    const nextAllowedAt = lastTradeMs > 0 ? new Date(lastTradeMs + cooldownMs).toISOString() : null;
    const cooldownMinutesRemaining = cooldownActive
      ? Math.ceil((lastTradeMs + cooldownMs - nowMs) / 60_000)
      : 0;

    const resolvedFamily = strategyFamily
      || strategyTradeControl.resolveStrategyFamily({ strategyId });
    const familyStats = getFamilyTradeStats(resolvedFamily, positions);
    const familyGate = strategyTradeControl.evaluateFamilyGate({
      strategyFamily: familyStats.strategyFamily,
      familyRank,
      familyHasOpenPosition: familyStats.openTrades > 0,
      familyLastTradeAt: familyStats.lastTradeAt,
      now,
      config: {
        familyCooldownMinutes: config.familyCooldownMinutes,
        familyExclusiveEnabled: config.familyExclusiveEnabled,
      },
    });

    let blockReason = null;
    if (stats.tradesUsed >= config.maxTradesPerStrategy) {
      blockReason = BLOCK_REASON_MAX_TRADES;
    } else if (cooldownActive) {
      blockReason = BLOCK_REASON_COOLDOWN;
    } else if (familyGate.familyBlockReason) {
      blockReason = familyGate.familyBlockReason;
    }

    return {
      strategyId,
      canTradeNow: blockReason === null,
      blockReason,
      strategyFamily: familyStats.strategyFamily,
      familyRank: familyGate.familyRank,
      familyGateDecision: familyGate.familyGateDecision,
      familyBlockReason: familyGate.familyBlockReason,
      familyOpenTrades: familyStats.openTrades,
      familyLastTradeAt: familyStats.lastTradeAt,
      familyNextAllowedAt: familyGate.familyNextAllowedAt,
      familyCooldownMinutesRemaining: familyGate.familyCooldownMinutesRemaining,
      strategyCooldownDecision: cooldownActive ? 'blocked' : 'allowed',
      tradesUsed: stats.tradesUsed,
      maxTrades: config.maxTradesPerStrategy,
      openTrades: stats.openTrades,
      closedTrades: stats.closedTrades,
      totalTradesAll: stats.totalTradesAll,
      totalTradesRealSignals: stats.totalTradesRealSignals,
      realSignalOpenTrades: stats.realSignalOpenTrades,
      realSignalClosedTrades: stats.realSignalClosedTrades,
      testTrades: stats.testTrades,
      excludedTrades: stats.excludedTrades,
      lastTradeAt: stats.lastTradeAt,
      nextAllowedAt,
      cooldownActive,
      cooldownMinutesRemaining,
      totalPnlSek: stats.totalPnlSek,
      pnlAll: stats.pnlAll,
      pnlRealSignals: stats.pnlRealSignals,
      wins: stats.wins,
      winsAll: stats.winsAll,
      winsRealSignals: stats.winsRealSignals,
    };
  }

  function buildEngineTestCandidate({ symbol, quote, now = new Date() }) {
    const price = Number(quote?.price) || null;
    const previous = Number(quote?.previousPrice) || price;
    const direction = price != null && previous != null && price < previous ? 'short' : 'long';
    return {
      candidateId: createCandidateId(now),
      symbol,
      futuresSymbol: symbol,
      mappedFuturesSymbol: symbol,
      direction,
      confidence: 0.5,
      strategyId: 'futures_paper_engine_test',
      strategyName: 'Futures Paper Engine Test',
      entryReason: `Engine-test: simulerad ${direction}-momentum på fallback-pris ${price ?? 'okänt'}.`,
      referencePrice: price,
      entryPrice: price,
      priceSource: quote?.source || 'simulated_fallback',
      simulatedData: true,
      testOnly: true,
      tradeType: 'engine_test',
      signalSource: 'fallback_test',
      dataSource: 'simulated_fallback',
      usedRealStrategyLogic: false,
      usedFallbackPrice: true,
      excludedFromStats: true,
      strategyLogicVersion: null,
      originalSignalId: null,
      originalSymbol: symbol,
      originalMarket: 'mini_futures',
      mappingReason: 'engine_test_no_trading_os_signal',
      mappingConfidence: 1,
      timestamp: nowIso(now),
      source: 'futures_paper_scanner_engine_test',
      paperOnly: true,
      status: 'queued',
      ...SAFETY,
    };
  }

  // Trading OS-driven scan: läs riktiga Trading OS-signaler via adapter och
  // skapa endast futures-kandidater när signalen har riktning, risk och mapping.
  function runScannerOnce({ now = new Date() } = {}) {
    const startedAt = nowIso(now);
    const config = getEngineConfig();
    const feed = priceFeed.tickQuotes(now);
    const { allowlistError } = getApprovedStrategySource();
    const positionsSummary = ledger.getPositionsSummary();
    const queue = readQueue();
    const added = [];
    const skippedStrategies = [];
    const blockedByCooldown = [];
    const blockedByMaxTrades = [];
    const blockedByFamilyGate = [];
    const signalsSkippedNoMapping = [];
    const signalsSkippedNoRisk = [];
    const signalsSkippedOther = [];

    const busySymbols = new Set([
      ...(positionsSummary.open || []).map((row) => String(row.symbol || row.root || '').toUpperCase().slice(0, 3)),
      ...queue.map((row) => String(row.symbol || '').toUpperCase()),
    ]);

    const adapterResult = signalAdapter.getFuturesCandidates({
      now,
      quotes: feed.quotes || [],
    });
    const tradingOsCandidates = Array.isArray(adapterResult?.candidates) ? adapterResult.candidates : [];
    const adapterSkipped = Array.isArray(adapterResult?.skipped) ? adapterResult.skipped : [];
    for (const row of adapterSkipped) {
      const target = row.skipReason === 'no_safe_futures_mapping'
        ? signalsSkippedNoMapping
        : row.skipReason === 'missing_trading_os_risk'
          ? signalsSkippedNoRisk
          : signalsSkippedOther;
      target.push(row);
    }

    // Family-exklusivitet: rangordna kandidaterna inom sina familjer så att
    // endast bästa kandidaten (högst confidence) i varje familj kan gå vidare.
    const familyRanks = strategyTradeControl.rankFamilyCandidates(tradingOsCandidates, {
      familyOf: familyOfCandidate,
    });

    for (const candidate of tradingOsCandidates) {
      const strategyId = String(candidate.strategyId || '');
      const familyMeta = familyRanks.get(candidate)
        || { strategyFamily: familyOfCandidate(candidate), familyRank: null, isBestInFamily: true };
      const symbol = String(candidate.futuresSymbol || candidate.symbol || '').toUpperCase().slice(0, 3);
      if (!strategyId) {
        skippedStrategies.push({ strategyId: null, signalId: candidate.signalId || null, reason: 'missing_strategy_id' });
        continue;
      }
      if (!SCANNER_SYMBOLS.includes(symbol)) {
        skippedStrategies.push({ strategyId, signalId: candidate.signalId || null, reason: 'unsupported_futures_symbol' });
        continue;
      }
      // Futures-scopat approval-lager (separat från vanlig paper). Kompatibilitets-
      // + godkännande-grind INNAN session/risk/dedup. Skapar aldrig en trade.
      // Fail-open vid internt fel så dagens sex aldrig blockeras av ett store-fel.
      const approvalGate = futuresPaperStrategyApproval.evaluateFuturesApprovalGate({ strategyId });
      if (!approvalGate.allowed) {
        skippedStrategies.push({
          strategyId,
          signalId: candidate.signalId || null,
          reason: approvalGate.blockedReason,
          canonicalReplacementId: approvalGate.canonicalReplacementId || null,
        });
        continue;
      }
      if (busySymbols.has(symbol)) {
        skippedStrategies.push({ strategyId, signalId: candidate.signalId || null, reason: 'futures_symbol_busy', symbol });
        continue;
      }
      const hasQueuedCandidate = queue.some((row) => (
        (candidate.signalId && row.signalId === candidate.signalId)
        || (candidate.candidateId && row.candidateId === candidate.candidateId)
        || (row.strategyId === strategyId && String(row.symbol || '').toUpperCase() === symbol)
      )) || added.some((row) => (
        (candidate.signalId && row.signalId === candidate.signalId)
        || (candidate.candidateId && row.candidateId === candidate.candidateId)
        || (row.strategyId === strategyId && String(row.symbol || '').toUpperCase() === symbol)
      ));
      if (hasQueuedCandidate) {
        skippedStrategies.push({ strategyId, signalId: candidate.signalId || null, reason: 'candidate_already_queued' });
        continue;
      }
      if (queue.length + added.length >= MAX_QUEUE_LENGTH) {
        skippedStrategies.push({ strategyId, signalId: candidate.signalId || null, reason: 'queue_full' });
        continue;
      }

      // Family-exklusivitet gäller även mot kandidater som redan står i kön
      // (från tidigare scans) — endast en kandidat per familj åt gången.
      if (config.familyExclusiveEnabled && familyMeta.strategyFamily) {
        const familyAlreadyQueued = [...queue, ...added].some((row) => (
          (row.strategyFamily || familyOfCandidate(row)) === familyMeta.strategyFamily
        ));
        if (familyAlreadyQueued) {
          blockedByFamilyGate.push({
            strategyId,
            signalId: candidate.signalId || null,
            reason: strategyTradeControl.BLOCK_REASON_FAMILY_NOT_BEST,
            strategyFamily: familyMeta.strategyFamily,
            familyRank: familyMeta.familyRank,
            detail: 'family_candidate_already_queued',
          });
          continue;
        }
      }

      const gate = evaluateStrategyGate(strategyId, {
        now,
        positionsSummary,
        strategyFamily: familyMeta.strategyFamily,
        familyRank: familyMeta.familyRank,
      });
      if (gate.blockReason === BLOCK_REASON_COOLDOWN) {
        blockedByCooldown.push({
          strategyId,
          signalId: candidate.signalId || null,
          reason: BLOCK_REASON_COOLDOWN,
          lastTradeAt: gate.lastTradeAt,
          nextAllowedAt: gate.nextAllowedAt,
          cooldownMinutesRemaining: gate.cooldownMinutesRemaining,
        });
        continue;
      }
      if (gate.blockReason === BLOCK_REASON_MAX_TRADES) {
        blockedByMaxTrades.push({
          strategyId,
          signalId: candidate.signalId || null,
          reason: BLOCK_REASON_MAX_TRADES,
          tradesUsed: gate.tradesUsed,
          maxTrades: gate.maxTrades,
        });
        continue;
      }
      if (FAMILY_BLOCK_REASONS.has(gate.blockReason)) {
        blockedByFamilyGate.push({
          strategyId,
          signalId: candidate.signalId || null,
          reason: gate.blockReason,
          strategyFamily: gate.strategyFamily,
          familyRank: gate.familyRank,
          familyOpenTrades: gate.familyOpenTrades,
          familyLastTradeAt: gate.familyLastTradeAt,
          nextAllowedAt: gate.familyNextAllowedAt,
          familyCooldownMinutesRemaining: gate.familyCooldownMinutesRemaining,
        });
        continue;
      }

      // Uppgift 5-metadata: kandidaten bär family/cooldown-beslutet vidare
      // in i kön, simuleringen och ledger-positionen.
      candidate.strategyFamily = familyMeta.strategyFamily || null;
      candidate.familyRank = familyMeta.familyRank ?? null;
      candidate.familyGateDecision = gate.familyGateDecision;
      candidate.familyBlockReason = null;
      candidate.strategyCooldownDecision = gate.strategyCooldownDecision || 'allowed';
      candidate.strategyCooldownBlockReason = null;
      candidate.nextAllowedAt = null;

      added.push(candidate);
      busySymbols.add(symbol);
    }

    let engineTestCandidates = [];
    if (added.length === 0 && config.engineTestMode === true) {
      const freeSymbol = SCANNER_SYMBOLS.find((symbol) => !busySymbols.has(symbol));
      if (freeSymbol && queue.length < MAX_QUEUE_LENGTH) {
        const quote = (feed.quotes || []).find((row) => row.root === freeSymbol || row.symbol === freeSymbol) || null;
        const candidate = buildEngineTestCandidate({ symbol: freeSymbol, quote, now });
        added.push(candidate);
        engineTestCandidates = [candidate];
      }
    }

    const nextQueue = writeQueue([...queue, ...added]);
    const finishedAt = nowIso();
    const realSignalCandidates = added.filter((row) => row.tradeType === 'trading_os_signal');
    const scanRecord = {
      scanId: createScanId(now),
      startedAt,
      finishedAt,
      symbolsScanned: SCANNER_SYMBOLS,
      strategiesChecked: tradingOsCandidates.length,
      approvedStrategies: tradingOsCandidates.length,
      candidatesCreated: added.length,
      skippedStrategies,
      tradesOpened: 0,
      tradesOpenedFromRealSignals: 0,
      tradesOpenedFromTests: 0,
      blockedByCooldown,
      blockedByMaxTrades,
      blockedByFamilyGate,
      dataSource: feed.feed.source,
      simulatedData: feed.feed.simulated === true,
      allowlistError: allowlistError || null,
      tradingOsSignalsRead: adapterResult?.stats?.tradingOsSignalsRead || 0,
      signalsMappedToFutures: adapterResult?.stats?.signalsMappedToFutures || 0,
      signalsSkippedNoMapping: signalsSkippedNoMapping.length,
      signalsSkippedNoRisk: signalsSkippedNoRisk.length,
      signalsSkippedOther: signalsSkippedOther.length,
      engineTestCandidates: engineTestCandidates.length,
      realSignalCandidates: realSignalCandidates.length,
      skippedSignalDetails: {
        noMapping: signalsSkippedNoMapping.slice(0, 10),
        noRisk: signalsSkippedNoRisk.slice(0, 10),
        other: signalsSkippedOther.slice(0, 10),
      },
      status: 'completed',
      summary: `${adapterResult?.stats?.tradingOsSignalsRead || 0} Trading OS-signaler lästa, `
        + `${realSignalCandidates.length} reala futures-kandidater, ${engineTestCandidates.length} engine-test, `
        + `${blockedByCooldown.length} cooldown-blockerade, ${blockedByMaxTrades.length} max-limit-blockerade, `
        + `${blockedByFamilyGate.length} family-gate-blockerade, `
        + `${signalsSkippedNoMapping.length} utan mapping, ${signalsSkippedNoRisk.length} utan risk.`,
      config: {
        maxTradesPerStrategy: config.maxTradesPerStrategy,
        cooldownMinutes: config.cooldownMinutes,
        familyCooldownMinutes: config.familyCooldownMinutes,
        familyExclusiveEnabled: config.familyExclusiveEnabled,
        engineTestMode: config.engineTestMode,
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

    const gate = evaluateStrategyGate(candidate.strategyId, {
      now,
      strategyFamily: candidate.strategyFamily || familyOfCandidate(candidate),
      familyRank: candidate.familyRank ?? null,
    });
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

    const normalizedTradeType = candidate.tradeType || (candidate.usedRealStrategyLogic === true ? 'trading_os_signal' : 'engine_test');
    const isRealSignalCandidate = normalizedTradeType === 'trading_os_signal' && candidate.usedRealStrategyLogic === true;
    const quote = priceFeed.getQuote(candidate.symbol, now);
    const entryPrice = Number(candidate.entryPrice) || Number(candidate.referencePrice) || Number(quote?.price) || null;
    if (!entryPrice || entryPrice <= 0) {
      return { ok: false, error: 'no_simulated_price_available', ...SAFETY };
    }

    const tickSize = Number(quote?.tickSize) || 0.25;
    const isShort = candidate.direction === 'short';
    let stopLoss = Number(candidate.stopLoss) || null;
    let takeProfit = Number(candidate.takeProfit) || null;
    if ((!stopLoss || !takeProfit) && isRealSignalCandidate) {
      return { ok: false, error: 'trading_os_signal_missing_risk_levels', candidate, ...SAFETY };
    }
    if (!stopLoss || !takeProfit) {
      const slDistance = entryPrice * (STOP_LOSS_PCT / 100);
      const tpDistance = entryPrice * (TAKE_PROFIT_PCT / 100);
      stopLoss = futuresPaperPriceFeedService.roundToTick(isShort ? entryPrice + slDistance : entryPrice - slDistance, tickSize);
      takeProfit = futuresPaperPriceFeedService.roundToTick(isShort ? entryPrice - tpDistance : entryPrice + tpDistance, tickSize);
    } else {
      stopLoss = futuresPaperPriceFeedService.roundToTick(stopLoss, tickSize);
      takeProfit = futuresPaperPriceFeedService.roundToTick(takeProfit, tickSize);
    }

    const dataSource = candidate.dataSource || (candidate.usedFallbackPrice ? 'simulated_fallback' : quote?.source || 'simulated_fallback');
    const usedFallbackPrice = candidate.usedFallbackPrice === true || dataSource === 'simulated_fallback' || quote?.fallback === true;
    const excludedFromStats = candidate.excludedFromStats === true
      || usedFallbackPrice
      || normalizedTradeType !== 'trading_os_signal'
      || candidate.usedRealStrategyLogic !== true;

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
      strategyFamily: candidate.strategyFamily || gate.strategyFamily || null,
      familyRank: candidate.familyRank ?? null,
      familyGateDecision: candidate.familyGateDecision || gate.familyGateDecision || null,
      familyBlockReason: candidate.familyBlockReason || gate.familyBlockReason || null,
      strategyCooldownDecision: candidate.strategyCooldownDecision || gate.strategyCooldownDecision || 'allowed',
      strategyCooldownBlockReason: candidate.strategyCooldownBlockReason
        || (gate.strategyCooldownDecision === 'blocked' ? gate.blockReason : null),
      nextAllowedAt: gate.blockReason
        ? (candidate.nextAllowedAt || gate.familyNextAllowedAt || gate.nextAllowedAt || null)
        : null,
      entryReason: `${candidate.entryReason || 'Futures paper candidate'} [source=${candidate.source}, tradeType=${normalizedTradeType}, dataSource=${dataSource}]`,
      tradeType: normalizedTradeType,
      signalSource: candidate.signalSource || (isRealSignalCandidate ? 'trading_os' : 'fallback_test'),
      dataSource,
      usedRealStrategyLogic: candidate.usedRealStrategyLogic === true,
      usedFallbackPrice,
      excludedFromStats,
      strategyLogicVersion: candidate.strategyLogicVersion || null,
      originalSignalId: candidate.originalSignalId || candidate.signalId || null,
      signalId: candidate.signalId || candidate.originalSignalId || null,
      candidateId: candidate.candidateId || null,
      originalSymbol: candidate.originalSymbol || null,
      originalMarket: candidate.originalMarket || null,
      mappedFuturesSymbol: candidate.mappedFuturesSymbol || candidate.futuresSymbol || candidate.symbol,
      mappingReason: candidate.mappingReason || null,
      mappingConfidence: candidate.mappingConfidence ?? null,
      confidence: candidate.confidence ?? null,
      riskReward: candidate.riskReward ?? null,
      timeframe: candidate.timeframe || null,
      riskSource: candidate.riskSource || null,
      approvalReason: candidate.approvalReason || null,
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
      tradeType: normalizedTradeType,
      signalSource: candidate.signalSource || null,
      dataSource,
      usedRealStrategyLogic: candidate.usedRealStrategyLogic === true,
      excludedFromStats,
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
          // Additivt: observerat feed-pris för MFE/MAE-extremen (ej PnL/exit).
          markPrice: price,
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
        const nextCandidate = queue.find((row) => evaluateStrategyGate(row.strategyId, {
          now,
          strategyFamily: row.strategyFamily || familyOfCandidate(row),
          familyRank: row.familyRank ?? null,
        }).canTradeNow);
        if (!nextCandidate) break;
        const simulated = simulateCandidate({ candidateId: nextCandidate.candidateId, now });
        if (!simulated.ok) break;
        simulatedPositions.push(simulated.position);
      }
      if (simulatedPositions.length > 0) {
        const tradesOpenedFromRealSignals = simulatedPositions.filter((row) => row.tradeType === 'trading_os_signal' && row.usedRealStrategyLogic === true && row.excludedFromStats === false).length;
        const tradesOpenedFromTests = simulatedPositions.length - tradesOpenedFromRealSignals;
        bumpLastScan({
          tradesOpened: simulatedPositions.length,
          tradesOpenedFromRealSignals,
          tradesOpenedFromTests,
        });
      }
    }

    const summary = {
      source,
      marketOpen: market.isOpen,
      scanned: Boolean(scan?.ok),
      candidatesAdded: scan?.scan?.candidatesCreated || 0,
      tradesOpened: simulatedPositions.length,
      tradesOpenedFromRealSignals: simulatedPositions.filter((row) => row.tradeType === 'trading_os_signal' && row.usedRealStrategyLogic === true && row.excludedFromStats === false).length,
      tradesOpenedFromTests: simulatedPositions.filter((row) => !(row.tradeType === 'trading_os_signal' && row.usedRealStrategyLogic === true && row.excludedFromStats === false)).length,
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
      const winRateAll = gate.closedTrades > 0
        ? Math.round((gate.winsAll / gate.closedTrades) * 10000) / 100
        : null;
      const winRateRealSignals = gate.realSignalClosedTrades > 0
        ? Math.round((gate.winsRealSignals / gate.realSignalClosedTrades) * 10000) / 100
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
        totalTradesAll: gate.totalTradesAll,
        totalTradesRealSignals: gate.totalTradesRealSignals,
        realSignalOpenTrades: gate.realSignalOpenTrades,
        realSignalClosedTrades: gate.realSignalClosedTrades,
        testTrades: gate.testTrades,
        excludedTrades: gate.excludedTrades,
        lastTradeAt: gate.lastTradeAt,
        nextAllowedAt: gate.nextAllowedAt,
        cooldownActive: gate.cooldownActive,
        cooldownMinutesRemaining: gate.cooldownMinutesRemaining,
        strategyFamily: gate.strategyFamily,
        familyGateDecision: gate.familyGateDecision,
        familyBlockReason: gate.familyBlockReason,
        familyOpenTrades: gate.familyOpenTrades,
        familyNextAllowedAt: gate.familyNextAllowedAt,
        familyCooldownMinutesRemaining: gate.familyCooldownMinutesRemaining,
        canTradeNow: approved && !strategy.skipReason && gate.canTradeNow,
        blockReason: !approved
          ? 'not_in_paper_allowlist'
          : strategy.skipReason || gate.blockReason,
        totalPnlSek: gate.totalPnlSek,
        pnlAll: gate.pnlAll,
        pnlRealSignals: gate.pnlRealSignals,
        winRate: winRateAll,
        winRateAll,
        winRateRealSignals,
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
    const lastScan = state.lastScanSummary || null;
    if (queue.length === 0 && lastScan && Number(lastScan.realSignalCandidates || 0) === 0) {
      reasons.push({ code: 'no_trading_os_signal_available', message: 'Ingen godkänd Trading OS-signal kunde adapteras till MNQ/MES i senaste scan.' });
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
    getFamilyTradeStats,
    familyOfCandidate,
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
