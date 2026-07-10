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

console.log('futuresPaperDeskService.test.js passed');
