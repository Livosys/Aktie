'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const svc = require('./futuresPaperDeskService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-desk-'));
const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage });
accountSvc.setFuturesPaperBalance({ startingBalanceSek: 375000 });
const ledgerSvc = require('./futuresPaperLedgerService').createFuturesPaperLedgerService({
  storageService: storage,
  accountService: accountSvc,
});

ledgerSvc.openFuturesPaperPosition({
  now: '2026-07-06T10:00:00.000Z',
  root: 'MNQ',
  symbol: 'MNQH26',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  entryReason: 'Seed runtime position',
});

const runtime = svc.buildFuturesPaperDeskRuntime({
  now: '2026-07-06T10:00:00.000Z',
  ledger: ledgerSvc.getFuturesPaperLedger({ limit: 20 }),
  universe: {
    groups: { mini_futures: { label_sv: 'Mini futures', enabled: true } },
    symbols: [
      { symbol: 'MNQ', marketGroup: 'mini_futures', enabled: true, test_only: true, risk_level: 'very_high' },
      { symbol: 'MES', marketGroup: 'mini_futures', enabled: false, test_only: true, risk_level: 'very_high' },
    ],
  },
  performance: {
    strategies: [
      { strategy_id: 'trend_continuation', strategy_name: 'Trend Continuation', win_rate: 58.2, avg_pnl: 0.12, score: 74, trades: 128, best_symbol: 'MNQ' },
      { strategy_id: 'pullback_reversal', strategy_name: 'Pullback Reversal', win_rate: 54.1, avg_pnl: 0.08, score: 69, trades: 96, best_symbol: 'MES' },
    ],
  },
  startingBalance: 250000,
});

assert.equal(runtime.ok, true);
assert.equal(runtime.mode, 'paper_only');
assert.equal(runtime.actions_allowed, false);
assert.equal(runtime.can_place_orders, false);
assert.equal(runtime.live_trading_enabled, false);
assert.equal(runtime.broker_enabled, false);
assert.equal(runtime.desk.focusMarkets[0], 'MNQ');
assert.equal(runtime.desk.focusMarkets[1], 'MES');
assert.equal(runtime.account.startingBalanceSek, 375000);
// Entry-fee (MNQ $1.22 * 10.5 = 12.81 SEK) dras vid open → equity = 375000 - 12.81.
assert.equal(runtime.account.equitySek, 374987.19);
assert.equal(runtime.account.totalFeesSek, 12.81);
assert.equal(runtime.strategyPulse.length, 2);
assert.equal(runtime.strategyPulse[0].strategyId, 'trend_continuation');
// Katalogen exponerar nu MNQ/MES/NQ/ES.
assert.equal(runtime.instruments.length, 4);
assert.equal(runtime.instruments[0].symbol, 'MNQ');
assert.equal(runtime.instruments.map((row) => row.symbol).sort().join(','), 'ES,MES,MNQ,NQ');
const mnqInstrument = runtime.instruments.find((row) => row.symbol === 'MNQ');
assert.equal(mnqInstrument.pointValueUsd, 2);
assert.equal(mnqInstrument.commissionPerSideUsd, 1.22);
assert.equal(mnqInstrument.estRoundTripCostUsd, 2.44);
assert.equal(runtime.market.session, 'Globex');
assert.equal(runtime.market.sessionId, 'europe');
assert.equal(runtime.market.sessionLabel, 'Europe');
assert.equal(runtime.market.timezone, 'America/Chicago');
assert.equal(runtime.market.isRth, false);
assert.equal(runtime.market.isGlobex, true);
assert.equal(runtime.market.maintenanceWindow, '16:00-17:00 CT');
assert.equal(runtime.strategyOverviewMeta.totalStrategies, 33);
assert.equal(runtime.strategyOverview.length, 33);
assert.equal(runtime.strategyOverviewMeta.currentSession, 'Europe');
assert.equal(runtime.strategyOverviewMeta.marketOpen, true);
const overviewIds = runtime.strategyOverview.map((row) => row.strategyId);
assert.equal(new Set(overviewIds).size, 33, 'exactly 33 unique strategyIds');
for (const row of runtime.strategyOverview) {
  assert.ok(svc.PAPER_STATUSES.includes(row.paperStatus), `${row.strategyId} has allowed status (${row.paperStatus})`);
}
const trendOverview = runtime.strategyOverview.find((row) => row.strategyId === 'trend_continuation');
assert.ok(trendOverview, 'trend_continuation overview exists');
assert.equal(trendOverview.instrument, 'MNQ / MES');
assert.equal(trendOverview.currentSession, 'Europe');
// Öppen paper-position i ledgern → ACTIVE_PAPER, oavsett readiness-läge.
assert.equal(trendOverview.paperStatus, 'ACTIVE_PAPER');
assert.ok(trendOverview.openPaperPosition, 'open paper position exposed');
assert.equal(trendOverview.openPaperPosition.symbol, 'MNQH26');
// Crypto-strategier saknar futures-mappning → synliga men NOT_APPLICABLE.
const cryptoOverview = runtime.strategyOverview.find((row) => row.strategyId === 'crypto_fast_momentum');
assert.ok(cryptoOverview, 'crypto strategy still visible');
assert.equal(cryptoOverview.paperStatus, 'NOT_APPLICABLE');
assert.equal(cryptoOverview.instrument, null);
assert.equal(cryptoOverview.canTradeNow, false);
assert.equal(cryptoOverview.mainBlocker, 'unsupported_futures_mapping');
assert.equal(runtime.account.fxUsdSek, 10.5);
assert.equal(runtime.positions.totalOpen, 1);
assert.equal(runtime.openPositions.length, 1);
assert.equal(runtime.closedTrades.length, 0);
assert.equal(runtime.latestEvents.length >= 1, true);

const pnlLong = svc.calcFuturesPnl({
  entryPrice: 20000,
  exitPrice: 20001,
  direction: 'long',
  contracts: 2,
  tickSize: 0.25,
  tickValueUsd: 0.50,
  fxRateUsdSek: 10.5,
  commissionsUsd: 1,
});

assert.equal(pnlLong.points, 1);
assert.equal(pnlLong.ticks, 4);
assert.equal(pnlLong.grossPnlUsd, 4);
assert.equal(pnlLong.netPnlUsd, 3);
assert.equal(pnlLong.netPnlSek, 31.5);

const pnlShort = svc.calcFuturesPnl({
  entryPrice: 5000,
  exitPrice: 4999,
  direction: 'short',
  contracts: 1,
  tickSize: 0.25,
  tickValueUsd: 1.25,
});

assert.equal(pnlShort.points, 1);
assert.equal(pnlShort.ticks, 4);
assert.equal(pnlShort.grossPnlUsd, 5);
assert.equal(pnlShort.netPnlUsd, 5);

// ---------------------------------------------------------------------------
// buildCanonicalStrategyOverview: sessionklassning, ACTIVE_PAPER-krav,
// canTradeNow-krav och robusthet vid saknade producer-/datarader.
// ---------------------------------------------------------------------------

const openRthSession = {
  isMarketOpen: true,
  session: 'Globex',
  sessionId: 'us_rth',
  sessionLabel: 'US RTH',
};
const openEuropeSession = {
  isMarketOpen: true,
  session: 'Globex',
  sessionId: 'europe',
  sessionLabel: 'Europe',
};
const maintenanceSession = {
  isMarketOpen: false,
  session: 'Globex',
  sessionId: 'maintenance_break',
  sessionLabel: 'Maintenance Break',
  closedReason: 'daily_maintenance',
};

function readyPaperRow(strategyId, extra = {}) {
  return {
    strategyId,
    paperEligibility: 'READY',
    readiness: 'READY_FOR_PAPER',
    producerStatus: 'ok',
    runtimeConnectorStatus: 'active',
    entryContractStatus: 'ready',
    approved: true,
    approvalStatus: 'approved',
    entryContract: {
      requiresMarketOpen: true,
      allowedSessions: ['regular', 'rth'],
    },
    ...extra,
  };
}

// Redo strategi, tillåten session, ingen position → READY_WAITING_FOR_SIGNAL.
const readyOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [],
});
assert.equal(readyOverview.totalStrategies, 33);
assert.equal(new Set(readyOverview.strategies.map((row) => row.strategyId)).size, 33);
const readyTrend = readyOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(readyTrend.paperStatus, 'READY_WAITING_FOR_SIGNAL');
assert.equal(readyTrend.canTradeNow, true);
assert.equal(readyTrend.marketOpen, true);
assert.equal(readyTrend.mainBlocker, null);

// ACTIVE_PAPER kräver faktisk öppen position — och gäller då även i underhållsfönster.
const activeOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T22:30:00.000Z',
  session: maintenanceSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [{ strategyId: 'trend_continuation', id: 'pos-1', symbol: 'MNQH26', direction: 'long' }],
  scannerStrategies: [],
});
const activeTrend = activeOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(activeTrend.paperStatus, 'ACTIVE_PAPER');
assert.equal(activeTrend.canTradeNow, false, 'canTradeNow false i stängd session även med öppen position');

// Stängd session (maintenance) utan position → SESSION_CLOSED + canTradeNow false.
const closedOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T22:30:00.000Z',
  session: maintenanceSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [],
});
const closedTrend = closedOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(closedTrend.paperStatus, 'SESSION_CLOSED');
assert.equal(closedTrend.canTradeNow, false);
assert.equal(closedTrend.mainBlocker, 'daily_maintenance');

// Öppen marknad men otillåten session (rth-kontrakt under Europe) → SESSION_CLOSED.
const wrongSessionOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T08:00:00.000Z',
  session: openEuropeSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [],
});
const wrongSessionTrend = wrongSessionOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(wrongSessionTrend.paperStatus, 'SESSION_CLOSED');
assert.equal(wrongSessionTrend.canTradeNow, false);
assert.equal(wrongSessionTrend.sessionAllowed, false);
assert.equal(wrongSessionTrend.mainBlocker, 'session_not_allowed_for_strategy');

// Kontrakt utan requiresMarketOpen upprätthåller inte sessionslistan (speglar entry contract-gaten).
const sessionFreeTrend = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T08:00:00.000Z',
  session: openEuropeSession,
  paperStrategies: {
    strategies: [readyPaperRow('trend_continuation', {
      entryContract: { requiresMarketOpen: false, allowedSessions: ['regular', 'rth'] },
    })],
  },
  openPositions: [],
  scannerStrategies: [],
}).strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(sessionFreeTrend.paperStatus, 'READY_WAITING_FOR_SIGNAL');
assert.equal(sessionFreeTrend.canTradeNow, true);

// Saknad producer/data-rad → strategin försvinner INTE, den klassas som blockerad.
const emptyOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: { strategies: [] },
  openPositions: [],
  scannerStrategies: [],
});
assert.equal(emptyOverview.totalStrategies, 33);
assert.equal(new Set(emptyOverview.strategies.map((row) => row.strategyId)).size, 33);
const emptyTrend = emptyOverview.strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(emptyTrend.paperStatus, 'PRODUCER_NOT_IMPLEMENTED');
const emptyCrypto = emptyOverview.strategies.find((row) => row.strategyId === 'crypto_fast_momentum');
assert.equal(emptyCrypto.paperStatus, 'NOT_APPLICABLE');
// Alla blockerade rader ska ha en explicit blockerare (fallback per status vid behov).
for (const row of emptyOverview.strategies) {
  if (!row.canTradeNow && row.paperStatus !== 'ACTIVE_PAPER') {
    assert.ok(row.mainBlocker, `${row.strategyId} (${row.paperStatus}) saknar mainBlocker`);
  }
}

// Scanner-cooldown/family-gate → TRADE_CAP_BLOCKED.
const cooldownTrend = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: { strategies: [readyPaperRow('trend_continuation')] },
  openPositions: [],
  scannerStrategies: [{
    strategyId: 'trend_continuation',
    canTradeNow: false,
    cooldownActive: true,
    blockReason: 'strategy_cooldown_active',
  }],
}).strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(cooldownTrend.paperStatus, 'TRADE_CAP_BLOCKED');
assert.equal(cooldownTrend.canTradeNow, false);

// Riskskäl → RISK_BLOCKED.
const riskTrend = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: {
    strategies: [readyPaperRow('trend_continuation', { paperBlockedReason: 'risk_pause_triggered' })],
  },
  openPositions: [],
  scannerStrategies: [],
}).strategies.find((row) => row.strategyId === 'trend_continuation');
assert.equal(riskTrend.paperStatus, 'RISK_BLOCKED');
assert.equal(riskTrend.canTradeNow, false);

// Ej godkänd → APPROVAL_BLOCKED; saknat entry contract → ENTRY_CONTRACT_BLOCKED;
// inaktiv runtime-connector → DATA_BLOCKED; replay-only → DIAGNOSTIC_ONLY.
const variantOverview = svc.buildCanonicalStrategyOverview({
  now: '2026-07-06T15:00:00.000Z',
  session: openRthSession,
  paperStrategies: {
    strategies: [
      readyPaperRow('trend_continuation', { approved: false, approvalStatus: 'not_approved' }),
      readyPaperRow('gap_fade', { entryContractStatus: 'missing', entryContract: null }),
      readyPaperRow('support_bounce', { runtimeConnectorStatus: 'blocked' }),
      readyPaperRow('narrow_breakout', { readiness: 'READY_FOR_REPLAY' }),
    ],
  },
  openPositions: [],
  scannerStrategies: [],
});
const variantById = new Map(variantOverview.strategies.map((row) => [row.strategyId, row]));
assert.equal(variantById.get('trend_continuation').paperStatus, 'APPROVAL_BLOCKED');
assert.equal(variantById.get('gap_fade').paperStatus, 'ENTRY_CONTRACT_BLOCKED');
assert.equal(variantById.get('support_bounce').paperStatus, 'DATA_BLOCKED');
assert.equal(variantById.get('narrow_breakout').paperStatus, 'DIAGNOSTIC_ONLY');
for (const row of variantOverview.strategies) {
  assert.ok(svc.PAPER_STATUSES.includes(row.paperStatus), `variant ${row.strategyId} status ${row.paperStatus}`);
  assert.equal(row.canTradeNow === true && row.marketOpen !== true, false, 'canTradeNow kräver öppen/tillåten session');
}

// sessionAllowedForStrategy: futures-session ↔ kontraktsvokabulär.
assert.equal(svc.sessionAllowedForStrategy('us_rth', { requiresMarketOpen: true, allowedSessions: ['rth'] }), true);
assert.equal(svc.sessionAllowedForStrategy('europe', { requiresMarketOpen: true, allowedSessions: ['rth'] }), false);
assert.equal(svc.sessionAllowedForStrategy('europe', { requiresMarketOpen: true, allowedSessions: ['24_7'] }), true);
assert.equal(svc.sessionAllowedForStrategy('europe', { requiresMarketOpen: false, allowedSessions: ['rth'] }), true);
assert.equal(svc.sessionAllowedForStrategy('overnight', null), true);
assert.equal(svc.sessionAllowedForStrategy('us_rth', { requiresMarketOpen: true, allowedSessions: [] }), true);

console.log('futuresPaperDeskService.test.js passed');
