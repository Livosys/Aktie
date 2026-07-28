'use strict';

// Scenario-test för Futures Paper strategy control:
//  - default cooldown 30 min per strategyId (central STRATEGY_COOLDOWN_MINUTES)
//  - family gate: bara bästa kandidaten i en familj per scan
//  - öppen position i familjen blockerar nya kandidater
//  - family cooldown efter stängd trade
//  - annan familj påverkas inte
//  - allt förblir ibkr_paper shadow utan intern position
// Alla trades sker i tmp-katalog via injicerade services — inget rör prod-data.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-family-gate-'));

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService } = require('./futuresPaperLedgerService');
const { createFuturesPaperScannerService } = require('./futuresPaperScannerService');
const { createFuturesTradingOsSignalAdapterService } = require('./futuresTradingOsSignalAdapterService');

const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage, allowInternalSimulationForTests: true });
const ledger = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc, allowInternalSimulationForTests: true });
let signals = [];

function quotesAt(now) {
  return {
    ok: true,
    generatedAt: now,
    feed: { source: 'real_market_data', simulated: false, fallback: false },
    quotes: [
      { root: 'MNQ', symbol: 'MNQ', price: 20000, previousPrice: 19999, tickSize: 0.25, source: 'real_market_data', fallback: false },
      { root: 'MES', symbol: 'MES', price: 5000, previousPrice: 5001, tickSize: 0.25, source: 'real_market_data', fallback: false },
    ],
  };
}

const priceFeed = {
  tickQuotes: (now) => quotesAt(now),
  getQuotes: (now) => quotesAt(now),
  getQuote: (symbol) => ({ root: symbol, symbol, price: symbol === 'MES' ? 5000 : 20000, previousPrice: 19999, tickSize: 0.25, source: 'real_market_data', fallback: false }),
};

// Godkänn signalens egen strategi (echo) så olika strategyId kan testas.
const signalAdapter = createFuturesTradingOsSignalAdapterService({
  signalReader: () => [],
  approvalService: {
    evaluateSignal: (signal) => ({
      approved: true,
      strategyId: signal.strategyId,
      strategyName: signal.strategyName || signal.strategyId,
      approvalReason: 'test_approved_signal',
    }),
  },
});

const signalProvider = {
  getCanonicalSignals: () => ({
    ok: true,
    signalInputs: signals,
    signals,
    providerResults: {},
    stats: {
      signalInputsRead: signals.length,
      readerSignalsRead: signals.length,
      providerSignalsRead: 0,
      providersEvaluated: 0,
    },
  }),
};

const scanner = createFuturesPaperScannerService({
  storageService: storage,
  ledgerService: ledger,
  allowInternalSimulationForTests: true,
  priceFeedService: priceFeed,
  signalProviderService: signalProvider,
  signalAdapterService: signalAdapter,
  // Detta test verifierar family-gaten, inte entry contracts. Stubben ger alla
  // strategier i scenariot ett kontrakt så att antagningsgrinden inte skymmer
  // det som faktiskt testas — och gör testet oberoende av prod-.env, som annars
  // läcker in via dotenv i @stoqey/ib.
  entryContractService: {
    entryContractsEnabled: () => true,
    getEntryContract: (strategyId) => ({ strategyId, version: 'paper_entry_contract_test' }),
  },
  strategyRegistryService: {
    canExecuteStrategy: (strategyId) => ({
      allowed: ['vwap_volume_breakout_long', 'vwap_failed_breakout_short', 'ema_breakdown'].includes(strategyId),
      strategyId,
      source: 'strategy_registry_execution_allowlist',
      status: ['vwap_volume_breakout_long', 'vwap_failed_breakout_short', 'ema_breakdown'].includes(strategyId) ? 'active' : null,
      enabled: ['vwap_volume_breakout_long', 'vwap_failed_breakout_short', 'ema_breakdown'].includes(strategyId),
      blockedReason: ['vwap_volume_breakout_long', 'vwap_failed_breakout_short', 'ema_breakdown'].includes(strategyId) ? null : 'strategy_not_in_execution_allowlist',
    }),
  },
  allowlistService: {
    getPaperAllowlistStatus: () => ({
      allowlist: [
        { id: 'vwap_volume_breakout_long', name: 'VWAP Volume Breakout Long', readyForPaperRuntime: true, blockers: [] },
        { id: 'vwap_failed_breakout_short', name: 'VWAP Failed Breakout Short', readyForPaperRuntime: true, blockers: [] },
        { id: 'ema_breakdown', name: 'EMA Breakdown', readyForPaperRuntime: true, blockers: [] },
      ],
    }),
  },
  performanceService: { getTopStrategies: () => ({ strategies: [] }) },
  // OBS: ingen cooldownMinutes-override — defaulten (30 min) ska testas.
  config: {
    scanHistoryLimit: 10,
    closedTradesLimit: 100,
    autoIntervalSeconds: 60,
  },
});

function makeSignal({ signalId, strategyId, strategyName, symbol, direction, confidence, entry, stopLoss, takeProfit, createdAt }) {
  return {
    signalId,
    strategyId,
    strategyName: strategyName || strategyId,
    symbol,
    market: 'stocks',
    direction,
    confidence,
    entry,
    stopLoss,
    takeProfit,
    riskReward: 2,
    timeframe: '2m',
    source: 'scanner',
    signalSource: 'scanner',
    dataSource: 'real_market_data',
    approved: true,
    strategyLogicVersion: 'test-v1',
    createdAt,
  };
}

// ── Default engine config: 30 min cooldown + family-exklusivitet PÅ ─────────
const engineConfig = scanner.getEngineConfig();
assert.equal(engineConfig.cooldownMinutes, 30);
assert.equal(engineConfig.familyCooldownMinutes, 30);
assert.equal(engineConfig.familyExclusiveEnabled, true);

// ── Scan 1 (11:00): två kandidater i vwap_family → bara bästa köas ──────────
const t0 = '2026-07-08T11:00:00.000Z';
signals = [
  makeSignal({ signalId: 'sig-vwap-b', strategyId: 'vwap_failed_breakout_short', symbol: 'SPY', direction: 'short', confidence: 0.7, entry: 500, stopLoss: 502.5, takeProfit: 495, createdAt: t0 }),
  makeSignal({ signalId: 'sig-vwap-a', strategyId: 'vwap_volume_breakout_long', symbol: 'QQQ', direction: 'long', confidence: 0.9, entry: 500, stopLoss: 497.5, takeProfit: 505, createdAt: t0 }),
];
let scan = scanner.runScannerOnce({ now: t0 });
assert.equal(scan.ok, true);
assert.equal(scan.candidates.length, 1);
assert.equal(scan.candidates[0].strategyId, 'vwap_volume_breakout_long');
assert.equal(scan.candidates[0].strategyFamily, 'vwap_family');
assert.equal(scan.candidates[0].familyRank, 1);
assert.equal(scan.candidates[0].familyGateDecision, 'allowed');
assert.equal(scan.candidates[0].strategyCooldownDecision, 'allowed');
assert.equal(scan.scan.blockedByFamilyGate.length, 1);
assert.equal(scan.scan.blockedByFamilyGate[0].strategyId, 'vwap_failed_breakout_short');
assert.equal(scan.scan.blockedByFamilyGate[0].reason, 'strategy_family_not_best_candidate');
assert.equal(scan.scan.config.cooldownMinutes, 30);
assert.equal(scan.scan.config.familyExclusiveEnabled, true);
assert.equal(scan.scan.mode, 'ibkr_paper');
assert.equal(scan.scan.live_trading_enabled, false);
assert.equal(scan.scan.broker_enabled, false);
assert.equal(scan.candidates[0].executionTarget, 'ibkr_paper');
assert.equal(scan.candidates[0].internalSimulationRetired, true);

// ── Intern candidate-simulering är pensionerad; family-fixture seedas offline.
const simulated = scanner.simulateCandidate({ now: t0 });
assert.equal(simulated.ok, false);
assert.equal(simulated.error, 'internal_futures_simulation_disabled');
assert.equal(simulated.code, 'internal_futures_simulation_retired');
assert.equal(simulated.can_place_orders, false);
assert.equal(simulated.live_trading_enabled, false);
scanner.resetScanner();

const seededOpen = ledger.openFuturesPaperPosition({
  now: t0,
  root: 'MNQ',
  symbol: 'MNQ',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
  stopLoss: 19900,
  takeProfit: 20200,
  strategyId: 'vwap_volume_breakout_long',
  strategyName: 'VWAP Volume Breakout Long',
  strategyFamily: 'vwap_family',
  familyRank: 1,
  familyGateDecision: 'allowed',
  familyBlockReason: null,
  strategyCooldownDecision: 'allowed',
  strategyCooldownBlockReason: null,
  nextAllowedAt: null,
  entryReason: 'offline family-gate fixture',
  tradeType: 'offline_unit_test_fixture',
  signalSource: 'unit_test',
  dataSource: 'real_market_data',
  usedRealStrategyLogic: true,
  usedFallbackPrice: false,
  excludedFromStats: false,
});
assert.equal(seededOpen.ok, true);
assert.equal(seededOpen.position.strategyId, 'vwap_volume_breakout_long');
assert.equal(seededOpen.position.strategyFamily, 'vwap_family');
assert.equal(seededOpen.position.familyRank, 1);
assert.equal(seededOpen.position.familyGateDecision, 'allowed');
assert.equal(seededOpen.position.familyBlockReason, null);
assert.equal(seededOpen.position.strategyCooldownDecision, 'allowed');
assert.equal(seededOpen.position.strategyCooldownBlockReason, null);
assert.equal(seededOpen.position.nextAllowedAt, null);

// ── Scan 2 (11:05): öppen vwap-position blockerar familjen, ema släpps ───────
const t1 = '2026-07-08T11:05:00.000Z';
signals = [
  makeSignal({ signalId: 'sig-vwap-c', strategyId: 'vwap_failed_breakout_short', symbol: 'SPY', direction: 'short', confidence: 0.8, entry: 500, stopLoss: 502.5, takeProfit: 495, createdAt: t1 }),
  makeSignal({ signalId: 'sig-ema-a', strategyId: 'ema_breakdown', symbol: 'SPY', direction: 'short', confidence: 0.6, entry: 500, stopLoss: 502.5, takeProfit: 495, createdAt: t1 }),
];
scan = scanner.runScannerOnce({ now: t1 });
assert.equal(scan.ok, true);
const vwapBlocked = scan.scan.blockedByFamilyGate.find((row) => row.strategyId === 'vwap_failed_breakout_short');
assert.ok(vwapBlocked, 'vwap_failed_breakout_short ska family-blockeras');
assert.equal(vwapBlocked.reason, 'strategy_family_position_open');
assert.equal(vwapBlocked.strategyFamily, 'vwap_family');
// Annan familj (ema_trend_family) påverkas inte.
assert.equal(scan.candidates.length, 1);
assert.equal(scan.candidates[0].strategyId, 'ema_breakdown');
assert.equal(scan.candidates[0].strategyFamily, 'ema_trend_family');

// ── Stäng vwap-positionen (11:06) ────────────────────────────────────────────
const closed = ledger.closeFuturesPaperPosition({
  now: '2026-07-08T11:06:00.000Z',
  tradeId: seededOpen.position.tradeId,
  exitPrice: 20100,
  exitReason: 'take_profit_hit',
});
assert.equal(closed.ok, true);
assert.equal(closed.trade.strategyFamily, 'vwap_family');
assert.equal(closed.trade.familyRank, 1);
assert.equal(closed.trade.familyGateDecision, 'allowed');
assert.equal(closed.trade.familyBlockReason, null);
assert.equal(closed.trade.strategyCooldownDecision, 'allowed');
assert.equal(closed.trade.strategyCooldownBlockReason, null);
assert.equal(closed.trade.nextAllowedAt, null);

const recentClosed = ledger.getRecentClosedTrades({ limit: 10 });
const closedView = recentClosed.trades.find((row) => row.tradeId === seededOpen.position.tradeId);
assert.ok(closedView, 'stängd trade ska finnas i recent closed output');
assert.equal(closedView.strategyFamily, 'vwap_family');
assert.equal(closedView.familyRank, 1);
assert.equal(closedView.familyGateDecision, 'allowed');
assert.equal(closedView.familyBlockReason, null);
assert.equal(closedView.strategyCooldownDecision, 'allowed');
assert.equal(closedView.strategyCooldownBlockReason, null);
assert.equal(closedView.nextAllowedAt, null);

// ── Scan 3a (11:10): samma strategyId 10 min efter trade → strategy cooldown ─
const t2 = '2026-07-08T11:10:00.000Z';
signals = [
  makeSignal({ signalId: 'sig-vwap-d', strategyId: 'vwap_volume_breakout_long', symbol: 'QQQ', direction: 'long', confidence: 0.9, entry: 500, stopLoss: 497.5, takeProfit: 505, createdAt: t2 }),
];
scan = scanner.runScannerOnce({ now: t2 });
assert.equal(scan.candidates.length, 0);
assert.equal(scan.scan.blockedByCooldown.length, 1);
assert.equal(scan.scan.blockedByCooldown[0].strategyId, 'vwap_volume_breakout_long');
assert.equal(scan.scan.blockedByCooldown[0].reason, 'strategy_cooldown_active');
assert.ok(scan.scan.blockedByCooldown[0].cooldownMinutesRemaining > 0);

// ── Scan 3b (11:10): annan strategi i samma familj → family cooldown ─────────
signals = [
  makeSignal({ signalId: 'sig-vwap-e', strategyId: 'vwap_failed_breakout_short', symbol: 'QQQ', direction: 'short', confidence: 0.8, entry: 500, stopLoss: 502.5, takeProfit: 495, createdAt: t2 }),
];
scan = scanner.runScannerOnce({ now: t2 });
assert.equal(scan.candidates.length, 0);
assert.equal(scan.scan.blockedByFamilyGate.length, 1);
assert.equal(scan.scan.blockedByFamilyGate[0].strategyId, 'vwap_failed_breakout_short');
assert.equal(scan.scan.blockedByFamilyGate[0].reason, 'strategy_family_cooldown_active');
assert.ok(scan.scan.blockedByFamilyGate[0].familyCooldownMinutesRemaining > 0);
assert.ok(scan.scan.blockedByFamilyGate[0].nextAllowedAt, 'family-blocket ska ange nextAllowedAt');

// ── Scan 4 (11:45): >30 min efter senaste family-trade → tillåts igen ────────
const t3 = '2026-07-08T11:45:00.000Z';
signals = [
  makeSignal({ signalId: 'sig-vwap-f', strategyId: 'vwap_failed_breakout_short', symbol: 'QQQ', direction: 'short', confidence: 0.8, entry: 500, stopLoss: 502.5, takeProfit: 495, createdAt: t3 }),
];
scan = scanner.runScannerOnce({ now: t3 });
assert.equal(scan.scan.blockedByFamilyGate.length, 0);
assert.equal(scan.scan.blockedByCooldown.length, 0);
assert.equal(scan.candidates.length, 1);
assert.equal(scan.candidates[0].strategyId, 'vwap_failed_breakout_short');
assert.equal(scan.candidates[0].strategyFamily, 'vwap_family');

// ── Strategy status exponerar family-fälten ──────────────────────────────────
const status = scanner.getStrategyStatus({ now: t3 });
const momentumRow = status.strategies.find((row) => row.strategyId === 'vwap_volume_breakout_long');
assert.equal(momentumRow.strategyFamily, 'vwap_family');
assert.ok(['allowed', 'blocked', 'not_applicable'].includes(momentumRow.familyGateDecision));
assert.equal(status.config.cooldownMinutes, 30);
assert.equal(status.mode, 'ibkr_paper');
assert.equal(status.live_trading_enabled, false);
assert.equal(status.broker_enabled, false);
assert.equal(status.actions_allowed, false);
assert.equal(status.can_place_orders, false);

// ── Paper-only-garden är orörd ───────────────────────────────────────────────
assert.equal(scanner.assertPaperOnly({ live_trading_enabled: true }), 'live_trading_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ broker_enabled: true }), 'broker_is_not_allowed');
assert.equal(scanner.assertPaperOnly({ can_place_orders: true }), 'real_orders_are_not_allowed');

console.log('futuresPaperScannerService.familyGate.test.js passed');
