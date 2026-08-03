'use strict';

// Futures Paper scanner + candidate queue för MNQ/MES.
// Scannern läser canonical signaler, använder den canonical Candidate-adaptern
// och skriver kö-/scanstatus. Aktiv execution är alltid IBKR Paper shadow/execution;
// den interna futures-simulatorn är pensionerad och får inte muteras.
//
// Automation-regler (Futures Paper Automation Engine):
// - strategikälla = Strategy Registry execution allowlist + paper readiness + strategy performance
// - cooldown per strategyId (FUTURES_PAPER_STRATEGY_COOLDOWN_MINUTES om satt,
//   annars central STRATEGY_COOLDOWN_MINUTES, default 30 — strategyTradeControlService)
// - strategy family-exklusivitet: endast bästa kandidaten i en familj per scan,
//   öppen position i familjen blockerar nya, family cooldown (default 30 min)
// - scan history (FUTURES_PAPER_SCAN_HISTORY_LIMIT, default 10)

const path = require('path');
const storageService = require('./futuresPaperStorageService');
const futuresPaperLedgerService = require('./futuresPaperLedgerService');
const futuresPaperQuoteSourceService = require('./futuresPaperQuoteSourceService');
const strategyPerformanceReadService = require('./strategyPerformanceReadService');
const paperAllowlistService = require('./paperAllowlistService');
const futuresTradingOsSignalAdapterService = require('./futuresTradingOsSignalAdapterService');
const futuresCanonicalSignalProviderService = require('./futuresCanonicalSignalProviderService');
const strategyTradeControl = require('./strategyTradeControlService');
const strategyRegistryService = require('./strategyRegistryService');
const paperStrategyEntryContractService = require('./paperStrategyEntryContractService');
const executionTargetReservationModule = require('./futuresPaperExecutionTargetReservationService');
const { buildFuturesSessionMetadata } = require('./futuresMarketHoursService');
const internalSimulationRetirement = require('./futuresInternalSimulationRetirementService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  executionTarget: 'ibkr_paper',
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

function timestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function candidateAgeMs(candidate = {}, now = new Date()) {
  const ts = candidate.signalTimestamp || candidate.timestamp || candidate.createdAt || candidate.candleTimestamp || null;
  const parsed = timestampMs(ts);
  const current = new Date(now).getTime();
  if (parsed == null || !Number.isFinite(current)) return null;
  return Math.max(0, current - parsed);
}

function countSkipReason(rows, skipReason) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.skipReason === skipReason).length;
}

function pruneStaleQueuedCandidates(queue = [], { now = new Date(), maxAgeMs = 120000 } = {}) {
  const keep = [];
  const pruned = [];
  for (const candidate of Array.isArray(queue) ? queue : []) {
    const ageMs = candidateAgeMs(candidate, now);
    if (ageMs != null && ageMs > maxAgeMs) {
      pruned.push({
        candidateId: candidate.candidateId || null,
        signalId: candidate.signalId || null,
        strategyId: candidate.strategyId || null,
        symbol: candidate.symbol || candidate.futuresSymbol || null,
        signalTimestamp: candidate.signalTimestamp || candidate.timestamp || candidate.createdAt || null,
        ageMs,
        maxAgeMs,
      });
    } else {
      keep.push(candidate);
    }
  }
  return { queue: keep, pruned };
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
  if (input.mode != null && !['paper_only', 'ibkr_paper'].includes(String(input.mode))) return 'mode_must_be_paper_only';
  return null;
}

function createFuturesPaperScannerService(options = {}) {
  const storage = options.storageService || storageService.defaultFuturesPaperStorageService;
  const ledger = options.ledgerService || futuresPaperLedgerService.defaultFuturesPaperLedgerService;
  // Composite quote-källa: riktiga IB-quotes när IB_FUTURES_DATA_ENABLED är på
  // och quoten är färsk, annars den simulerade fallback-feeden — alltid med
  // ärlig source-märkning per quote. Interfacet är identiskt med den gamla
  // feeden, så all scanner-logik är oförändrad.
  const priceFeed = options.priceFeedService || futuresPaperQuoteSourceService.defaultFuturesPaperQuoteSourceService;
  const performanceService = options.performanceService || strategyPerformanceReadService;
  const allowlistService = options.allowlistService || paperAllowlistService;
  const signalProvider = options.signalProviderService
    || futuresCanonicalSignalProviderService.defaultFuturesCanonicalSignalProviderService;
  const signalAdapter = options.signalAdapterService || futuresTradingOsSignalAdapterService.defaultFuturesTradingOsSignalAdapterService;
  const strategyRegistry = options.strategyRegistryService || strategyRegistryService;
  const entryContracts = options.entryContractService || paperStrategyEntryContractService;
  const executionTargetReservations = options.executionTargetReservationService
    || executionTargetReservationModule.createFuturesPaperExecutionTargetReservationService({
      dir: path.join(storage.rootDir, 'execution-target-reservations'),
    });
  const internalSimulationState = internalSimulationRetirement.buildRuntimeState(options);
  const configOverrides = options.config || {};
  const stateFile = path.join(storage.rootDir, 'scanner-state.json');
  const candidatesFile = path.join(storage.rootDir, 'candidates.json');
  const scanHistoryFile = path.join(storage.rootDir, 'scan-history.json');
  let autoTimer = null;

  function emptyPositionsSummary() {
    return { open: [], closed: [], totalOpen: 0, totalClosed: 0, updatedAt: null };
  }

  function getActivePositionsSummary() {
    if (internalSimulationState.enabled === true) return ledger.getPositionsSummary();
    return emptyPositionsSummary();
  }

  function retiredMutation(action) {
    return internalSimulationRetirement.buildRetiredMutationResponse({ action });
  }

  function getEngineConfig() {
    const controlConfig = strategyTradeControl.getStrategyTradeControlConfig();
    return {
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
      candidateMaxAgeMs: configOverrides.candidateMaxAgeMs
        ?? envInt('FUTURES_PAPER_CANDIDATE_MAX_AGE_MS', envInt('IBKR_PAPER_PILOT_MAX_INTENT_AGE_MS', 120000)),
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
    const candidates = Array.isArray(raw?.candidates) ? raw.candidates.filter(Boolean) : [];
    return candidates.map((row) => {
      if (row.executionTarget === 'internal_simulation') {
        return {
          ...row,
          legacyExecutionTarget: 'internal_simulation',
          executionTarget: 'ibkr_paper',
          executionSource: 'ibkr_paper',
          executionTargetStatus: 'legacy_candidate_retargeted_to_ibkr_paper_shadow',
          internalSimulationRetired: true,
          status: 'READY_WAITING_FOR_SIGNAL',
        };
      }
      return {
        ...row,
        executionTarget: 'ibkr_paper',
        executionSource: 'ibkr_paper',
        internalSimulationRetired: true,
      };
    });
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
    const timestamp = nowIso(now);
    const sessionMetadata = buildFuturesSessionMetadata(timestamp);
    return storage.appendEvent({
      eventId: `futures_scanner_${Number.isFinite(ts) ? ts : Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      type,
      timestamp,
      sessionMetadata,
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
    return row.usedRealStrategyLogic === true
      && row.excludedFromStats === false
      && !['engine_test', 'manual_simulation', 'curl_test', 'cleanup'].includes(String(row.tradeType || ''));
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
    const positions = positionsSummary || getActivePositionsSummary();
    const id = String(strategyId || '');
    const open = (positions.open || []).filter((row) => String(row.strategyId || '') === id);
    const closed = (positions.closed || []).filter((row) => String(row.strategyId || '') === id);
    const realOpen = open.filter(isRealStrategyTrade);
    const realClosed = closed.filter(isRealStrategyTrade);
    const excluded = [...open, ...closed].filter(isExcludedTrade);
    const testTrades = [...open, ...closed].filter((row) => row.tradeType && !isRealStrategyTrade(row));
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
    const positions = positionsSummary || getActivePositionsSummary();
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

  // DEL 2 + DEL 3: cooldown per strategi samt strategy family gate.
  function evaluateStrategyGate(strategyId, {
    now = new Date(),
    positionsSummary = null,
    strategyFamily = null,
    familyRank = null,
  } = {}) {
    const config = getEngineConfig();
    const positions = positionsSummary || getActivePositionsSummary();
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
    if (cooldownActive) {
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

  function reserveCandidateForIbkrPaper(candidate = {}, { now = new Date() } = {}) {
    const signalTimestamp = candidate.signalTimestamp || candidate.timestamp || candidate.createdAt || null;
    const nextCandidate = {
      ...candidate,
      executionTarget: 'ibkr_paper',
      executionSource: 'ibkr_paper',
      executionTargetStatus: 'ibkr_paper_reserved_for_shadow',
      orderSubmissionEnabled: false,
      actualSubmit: false,
      shadowMode: true,
      internalSimulationRetired: true,
      status: 'READY_WAITING_FOR_SIGNAL',
    };
    const reservation = executionTargetReservations.reserveExecutionTarget({
      candidateId: nextCandidate.candidateId,
      executionTarget: 'ibkr_paper',
      strategyId: nextCandidate.strategyId,
      signalTimestamp,
      status: 'ibkr_paper_reserved_for_shadow',
      now,
      metadata: {
        symbol: nextCandidate.symbol || nextCandidate.futuresSymbol || null,
        source: nextCandidate.source || null,
        tradeType: nextCandidate.tradeType || null,
      },
    });
    if (!reservation.ok) {
      return { ok: false, candidate: nextCandidate, reservation };
    }
    return {
      ok: true,
      candidate: {
        ...nextCandidate,
        executionTargetReservation: {
          reserved: reservation.reserved === true,
          duplicate: reservation.duplicate === true,
          status: reservation.record?.status || 'ibkr_paper_reserved_for_shadow',
          reservedAt: reservation.record?.reservedAt || null,
          updatedAt: reservation.record?.updatedAt || null,
        },
      },
      reservation,
    };
  }

  // Canonical signal-driven scan: skapa endast futures-kandidater via adaptern
  // när signalen har riktning, risk och mapping.
  function runScannerOnce({ now = new Date() } = {}) {
    const startedAt = nowIso(now);
    const scanSessionMetadata = buildFuturesSessionMetadata(startedAt);
    const config = getEngineConfig();
    const feed = priceFeed.tickQuotes(now);
    const signalInputResult = signalProvider.getCanonicalSignals({
      now,
      priceFeedService: priceFeed,
      feed,
    });
    const signalInputs = Array.isArray(signalInputResult?.signalInputs) ? signalInputResult.signalInputs : [];
    const { allowlistError } = getApprovedStrategySource();
    const positionsSummary = getActivePositionsSummary();
    const rawQueue = readQueue();
    const queuePrune = pruneStaleQueuedCandidates(rawQueue, {
      now,
      maxAgeMs: config.candidateMaxAgeMs,
    });
    const queue = queuePrune.queue;
    const staleQueuedCandidates = queuePrune.pruned;
    if (staleQueuedCandidates.length > 0) {
      writeQueue(queue);
      persistEvent('FUTURES_SCANNER_STALE_CANDIDATES_PRUNED', {
        count: staleQueuedCandidates.length,
        candidates: staleQueuedCandidates.slice(0, 10),
      }, now);
    }
    const added = [];
    const skippedStrategies = [];
    const blockedByCooldown = [];
    const blockedByFamilyGate = [];
    const blockedByExecutionTarget = [];
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
      signalInputs,
    });
    const canonicalCandidates = Array.isArray(adapterResult?.candidates) ? adapterResult.candidates : [];
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
    const familyRanks = strategyTradeControl.rankFamilyCandidates(canonicalCandidates, {
      familyOf: familyOfCandidate,
    });

    for (const candidate of canonicalCandidates) {
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
      const executionAllowlist = typeof strategyRegistry.canExecuteStrategy === 'function'
        ? strategyRegistry.canExecuteStrategy(strategyId)
        : { allowed: false, blockedReason: 'strategy_registry_execution_allowlist_unavailable' };
      if (!executionAllowlist.allowed) {
        skippedStrategies.push({
          strategyId,
          signalId: candidate.signalId || null,
          reason: executionAllowlist.blockedReason || 'strategy_not_in_execution_allowlist',
          registryStatus: executionAllowlist.status || null,
          registryEnabled: executionAllowlist.enabled ?? null,
        });
        continue;
      }
      // Kön har bara en plats per rot (busySymbols nedan) och orchestratorn läser
      // alltid köns första kandidat. En strategi utan entry contract kan aldrig
      // passera orchestratorns kontraktsgrind, så om den får ta platsen svälts
      // varje kontrakterad strategi ut. Avvisa den före reservationen i stället.
      if (entryContracts.entryContractsEnabled() && !entryContracts.getEntryContract(strategyId)) {
        skippedStrategies.push({
          strategyId,
          signalId: candidate.signalId || null,
          reason: 'entry_contract_missing',
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
      if (!candidate.sessionMetadata) {
        const candidateTimestamp = candidate.timestamp || candidate.createdAt || startedAt;
        candidate.sessionMetadata = buildFuturesSessionMetadata(candidateTimestamp);
        candidate.session = candidate.sessionMetadata?.session || null;
        candidate.sessionId = candidate.sessionMetadata?.sessionId || null;
        candidate.sessionLabel = candidate.sessionMetadata?.sessionLabel || null;
        candidate.exchangeTimezone = candidate.sessionMetadata?.exchangeTimezone || null;
        candidate.exchangeLocalDate = candidate.sessionMetadata?.exchangeLocalDate || null;
        candidate.exchangeLocalTime = candidate.sessionMetadata?.exchangeLocalTime || null;
        candidate.isRth = candidate.sessionMetadata?.isRth ?? null;
        candidate.isMarketOpen = candidate.sessionMetadata?.isMarketOpen ?? null;
      }

      const reservation = reserveCandidateForIbkrPaper(candidate, { now });
      if (!reservation.ok) {
        blockedByExecutionTarget.push({
          strategyId,
          signalId: candidate.signalId || null,
          candidateId: candidate.candidateId || null,
          reason: reservation.reservation?.blocker || reservation.reservation?.error || 'execution_target_reservation_failed',
          executionTarget: 'ibkr_paper',
        });
        continue;
      }

      added.push(reservation.candidate);
      busySymbols.add(symbol);
    }

    const nextQueue = writeQueue([...queue, ...added]);
    const finishedAt = nowIso();
    const canonicalPipelineCandidates = added.filter(isRealStrategyTrade);
    const scanId = createScanId(now);
    const scanRecord = {
      scanId,
      startedAt,
      finishedAt,
      sessionMetadata: scanSessionMetadata,
      session: scanSessionMetadata?.session || null,
      sessionId: scanSessionMetadata?.sessionId || null,
      sessionLabel: scanSessionMetadata?.sessionLabel || null,
      exchangeTimezone: scanSessionMetadata?.exchangeTimezone || null,
      exchangeLocalDate: scanSessionMetadata?.exchangeLocalDate || null,
      exchangeLocalTime: scanSessionMetadata?.exchangeLocalTime || null,
      isRth: scanSessionMetadata?.isRth ?? null,
      isMarketOpen: scanSessionMetadata?.isMarketOpen ?? null,
      symbolsScanned: SCANNER_SYMBOLS,
      strategiesChecked: canonicalCandidates.length,
      approvedStrategies: canonicalCandidates.length,
      candidatesCreated: added.length,
      skippedStrategies,
      tradesOpened: 0,
      tradesOpenedFromCanonicalSignals: 0,
      tradesOpenedFromTests: 0,
      blockedByCooldown,
      blockedByFamilyGate,
      blockedByExecutionTarget,
      staleQueuedCandidatesPruned: staleQueuedCandidates.length,
      staleQueuedCandidateDetails: staleQueuedCandidates.slice(0, 10),
      dataSource: feed.feed.source,
      simulatedData: feed.feed.simulated === true,
      allowlistError: allowlistError || null,
      signalInputsRead: adapterResult?.stats?.signalInputsRead || 0,
      readerSignalsRead: signalInputResult?.stats?.readerSignalsRead || 0,
      providerSignalsRead: signalInputResult?.stats?.providerSignalsRead || 0,
      providersEvaluated: signalInputResult?.stats?.providersEvaluated || 0,
      signalsMappedToFutures: adapterResult?.stats?.signalsMappedToFutures || 0,
      signalsSkippedNoMapping: signalsSkippedNoMapping.length,
      signalsSkippedNoRisk: signalsSkippedNoRisk.length,
      signalsSkippedOther: signalsSkippedOther.length,
      // Uppdelning INUTI signalsSkippedOther, inte ett komplement till den.
      // Fältet ovan behåller exakt sin gamla betydelse — allt som varken saknar
      // mapping eller risk — så befintliga konsumenter är opåverkade. De två
      // nedan namnger de vanligaste orsakerna i den hinken. Summan är alltså
      // <= signalsSkippedOther; resten är no_futures_entry_price.
      signalsSkippedNoDirection: countSkipReason(signalsSkippedOther, 'missing_signal_direction'),
      signalsSkippedDirectionVetoed: countSkipReason(signalsSkippedOther, 'direction_vetoed_by_bias'),
      signalProviderResults: signalInputResult?.providerResults || {},
      canonicalPipelineCandidates: canonicalPipelineCandidates.length,
      skippedSignalDetails: {
        noMapping: signalsSkippedNoMapping.slice(0, 10),
        noRisk: signalsSkippedNoRisk.slice(0, 10),
        other: signalsSkippedOther.slice(0, 10),
      },
      status: 'completed',
      executionTarget: 'ibkr_paper',
      internalSimulationRetired: true,
      summary: `${adapterResult?.stats?.signalInputsRead || 0} canonical signal inputs lästa, `
        + `${canonicalPipelineCandidates.length} futures-kandidater köade, `
        + `${staleQueuedCandidates.length} stale-kandidater rensade, `
        + `${blockedByCooldown.length} cooldown-blockerade, ${blockedByFamilyGate.length} family-gate-blockerade, ${blockedByExecutionTarget.length} execution-target-blockerade, `
        + `${signalsSkippedNoMapping.length} utan mapping, ${signalsSkippedNoRisk.length} utan risk.`,
      config: {
        cooldownMinutes: config.cooldownMinutes,
        familyCooldownMinutes: config.familyCooldownMinutes,
        familyExclusiveEnabled: config.familyExclusiveEnabled,
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

  function simulateCandidate({ candidateId = null, now = new Date() } = {}) {
    const queue = readQueue();
    const candidate = candidateId
      ? queue.findIndex((row) => String(row.candidateId || '') === String(candidateId))
      : 0;
    const selected = Number.isInteger(candidate) && candidate >= 0 ? queue[candidate] : null;
    return {
      ...retiredMutation('simulate_futures_candidate_internally'),
      generatedAt: nowIso(now),
      candidate: selected,
      queueLength: queue.length,
      message: 'Futures candidates are reserved for IBKR Paper shadow execution only.',
    };
  }

  function refreshOpenPositions({ now = new Date() } = {}) {
    return {
      ...retiredMutation('refresh_internal_futures_positions'),
      generatedAt: nowIso(now),
      updatedPositions: 0,
      autoClosed: [],
    };
  }

  function runSimulationTick({ now = new Date(), source = 'manual' } = {}) {
    stopAutoTimer();
    const blocked = retiredMutation('run_internal_futures_simulation_tick');
    const summary = {
      source,
      scanned: false,
      candidatesAdded: 0,
      tradesOpened: 0,
      simulatedTradeIds: [],
      autoClosed: [],
      updatedPositions: 0,
      blocker: blocked.blocker,
    };
    writeScannerState({ lastTickAt: nowIso(now), lastTickSummary: summary });

    return {
      ...blocked,
      generatedAt: nowIso(now),
      tick: summary,
      scan: null,
      simulatedPositions: [],
      autoClosed: [],
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
    return { ok: false, intervalMs, ...retiredMutation('start_internal_futures_auto_simulation') };
  }

  function setAutoSimulation({ enabled, intervalMs = null } = {}) {
    const state = writeScannerState({
      autoSimulationEnabled: false,
      autoIntervalMs: Math.max(10_000, Number(intervalMs) || readScannerState().autoIntervalMs || getEngineConfig().autoIntervalSeconds * 1000),
    });
    stopAutoTimer();
    persistEvent('FUTURES_AUTO_SIMULATION_RETIRED_BLOCKED', {
      requestedEnabled: enabled === true,
      autoIntervalMs: state.autoIntervalMs,
    });
    return {
      ...retiredMutation('set_internal_futures_auto_simulation'),
      autoSimulation: {
        enabled: false,
        intervalMs: state.autoIntervalMs,
        timerActive: false,
      },
    };
  }

  // DEL 6: strategy status per strategi (godkända + strategier med ledger-historik).
  function getStrategyStatus({ now = new Date() } = {}) {
    const { strategies, allowlistError } = getApprovedStrategySource();
    const positionsSummary = getActivePositionsSummary();
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
    const sessionMetadata = buildFuturesSessionMetadata(nowIso(now));
    const queue = readQueue();
    const reasons = [];
    reasons.push({ code: 'internal_futures_simulation_retired', message: 'Intern futures-simulering är avvecklad. Kandidater går endast till IBKR Paper shadow execution.' });
    if (state.autoSimulationEnabled) {
      reasons.push({ code: 'auto_simulation_forced_off', message: 'Auto simulation är pensionerad och tvingas av.' });
    }
    if (sessionMetadata?.isMarketOpen !== true) {
      reasons.push({ code: 'session_closed', message: 'Session stängd (Globex).' });
    }
    if (queue.length === 0) {
      reasons.push({ code: 'empty_candidate_queue', message: 'Candidate queue är tom — inväntar legitim signal för IBKR Paper shadow.' });
    }
    const lastScan = state.lastScanSummary || null;
    if (queue.length === 0 && lastScan && Number(lastScan.canonicalPipelineCandidates || 0) === 0) {
      reasons.push({ code: 'no_canonical_signal_candidate_available', message: 'Ingen godkänd canonical signal kunde adapteras till MNQ/MES i senaste scan.' });
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
        signalProviderResults: state.lastScanSummary?.signalProviderResults || {},
      },
      autoSimulation: {
        enabled: false,
        intervalMs: state.autoIntervalMs,
        timerActive: false,
        retired: true,
        blocker: internalSimulationRetirement.DISABLED_ERROR,
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
      executionTargetModel: {
        onlyActiveExecutionTarget: 'ibkr_paper',
        internalSimulationRetired: true,
        orderSubmissionEnabled: false,
        shadowMode: true,
      },
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
    if (state.autoSimulationEnabled || autoTimer) {
      stopAutoTimer();
      return writeScannerState({ autoSimulationEnabled: false });
    }
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
    pruneStaleQueuedCandidates,
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
