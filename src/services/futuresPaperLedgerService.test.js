'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService } = require('./futuresPaperLedgerService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-ledger-'));
const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage });
const ledgerSvc = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc });

const openMnq = ledgerSvc.openFuturesPaperPosition({
  now: '2026-07-06T11:00:00.000Z',
  root: 'MNQ',
  symbol: 'MNQH26',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
  stopLoss: 19990,
  takeProfit: 20020,
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  entryReason: 'Signal confirmed',
});

assert.equal(openMnq.ok, true);
assert.equal(openMnq.position.root, 'MNQ');
assert.equal(openMnq.position.status, 'open');
assert.equal(openMnq.position.unrealizedPnlUsd, 0);
assert.equal(openMnq.positions.totalOpen, 1);
assert.equal(openMnq.mode, 'paper_only');
assert.equal(openMnq.actions_allowed, false);

const openMes = ledgerSvc.openFuturesPaperPosition({
  now: '2026-07-06T11:02:00.000Z',
  root: 'MES',
  symbol: 'MESU26',
  side: 'short',
  contracts: 1,
  entryPrice: 5000,
  stopLoss: 5010,
  takeProfit: 4980,
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  entryReason: 'Momentum fade',
});

assert.equal(openMes.ok, true);
assert.equal(openMes.positions.totalOpen, 2);

const closeMnq = ledgerSvc.closeFuturesPaperPosition({
  now: '2026-07-06T11:05:00.000Z',
  tradeId: openMnq.position.tradeId,
  exitPrice: 20002,
  exitReason: 'target_hit',
});

assert.equal(closeMnq.ok, true);
assert.equal(closeMnq.trade.status, 'closed');
assert.equal(closeMnq.trade.realizedPnlUsd, 4);
assert.equal(closeMnq.trade.realizedPnlSek, 42);
assert.equal(closeMnq.positions.totalOpen, 1);
assert.equal(closeMnq.positions.totalClosed, 1);

const closeMes = ledgerSvc.closeFuturesPaperPosition({
  now: '2026-07-06T11:10:00.000Z',
  tradeId: openMes.position.tradeId,
  exitPrice: 4998,
  exitReason: 'manual_close',
});

assert.equal(closeMes.ok, true);
assert.equal(closeMes.trade.realizedPnlUsd, 10);
assert.equal(closeMes.trade.realizedPnlSek, 105);
assert.equal(closeMes.positions.totalOpen, 0);
assert.equal(closeMes.positions.totalClosed, 2);

const ledger = ledgerSvc.getFuturesPaperLedger({ limit: 10 });
assert.equal(ledger.ok, true);
assert.equal(ledger.positions.totalOpen, 0);
assert.equal(ledger.positions.totalClosed, 2);
assert.equal(ledger.openPositions.length, 0);
assert.equal(ledger.closedTrades.length, 2);
assert.equal(ledger.trades.length, 2);
assert.equal(ledger.account.realizedPnlSek, 147);
assert.equal(ledger.account.cashSek, 250147);
assert.equal(ledger.account.equitySek, 250147);
assert.equal(ledger.account.totalPnlSek, 147);
assert.equal(ledger.account.openExposureSek, 0);
assert.equal(ledger.account.usedMarginSek, 0);
assert.equal(ledger.account.availableMarginSek, 250147);
assert.equal(ledger.mode, 'paper_only');

const trades = storage.readTrades();
assert.equal(trades.length, 2);
assert.equal(trades[0].tradeId, openMnq.position.tradeId);
assert.equal(trades[1].tradeId, openMes.position.tradeId);
assert.equal(trades[0].mode, 'paper_only');
assert.equal(trades[0].actions_allowed, false);

const events = storage.readJsonl(storage.files.events);
assert.equal(events.length >= 4, true);
assert.equal(events[0].type, 'FUTURES_POSITION_OPENED');
assert.equal(events.at(-1).type, 'FUTURES_POSITION_CLOSED');

const invalidRoot = ledgerSvc.openFuturesPaperPosition({
  root: 'ETH',
  side: 'long',
  contracts: 1,
  entryPrice: 1,
});
assert.equal(invalidRoot.ok, false);

const invalidClose = ledgerSvc.closeFuturesPaperPosition({
  tradeId: 'missing',
  exitPrice: 1,
});
assert.equal(invalidClose.ok, false);

console.log('futuresPaperLedgerService.test.js passed');
