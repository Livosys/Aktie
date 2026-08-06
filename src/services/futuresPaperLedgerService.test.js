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
const accountSvc = createFuturesPaperAccountService({ storageService: storage, allowInternalSimulationForTests: true });
const ledgerSvc = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc, allowInternalSimulationForTests: true });

const retiredRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-ledger-retired-'));
const retiredStorage = createFuturesPaperStorageService({ rootDir: retiredRootDir });
const retiredAccountSvc = createFuturesPaperAccountService({ storageService: retiredStorage });
const retiredLedgerSvc = createFuturesPaperLedgerService({ storageService: retiredStorage, accountService: retiredAccountSvc });

const retiredOpen = retiredLedgerSvc.openFuturesPaperPosition({
  root: 'MNQ',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
});
assert.equal(retiredOpen.ok, false);
assert.equal(retiredOpen.error, 'internal_futures_simulation_disabled');
assert.equal(retiredOpen.code, 'internal_futures_simulation_retired');
assert.equal(retiredOpen.executionTarget, 'ibkr_paper');

const retiredClose = retiredLedgerSvc.closeFuturesPaperPosition({ tradeId: 'legacy-open', exitPrice: 20001 });
assert.equal(retiredClose.ok, false);
assert.equal(retiredClose.error, 'internal_futures_simulation_disabled');

const retiredMark = retiredLedgerSvc.markOpenPositionsToMarket({ prices: { 'legacy-open': 20001 } });
assert.equal(retiredMark.ok, false);
assert.equal(retiredMark.error, 'internal_futures_simulation_disabled');

const retiredReset = retiredLedgerSvc.resetState();
assert.equal(retiredReset.ok, false);
assert.equal(retiredReset.error, 'internal_futures_simulation_disabled');
assert.equal(fs.existsSync(retiredStorage.files.positions), false);
assert.equal(fs.existsSync(retiredStorage.files.trades), false);
assert.equal(fs.existsSync(retiredStorage.files.accountState), false);

const retiredRead = retiredLedgerSvc.getFuturesPaperLedger({ limit: 10 });
assert.equal(retiredRead.ok, true);
assert.equal(retiredRead.readOnly, true);
assert.equal(retiredRead.legacySource, 'internal_legacy_simulation');
assert.equal(retiredRead.internalSimulationRetired, true);
assert.equal(fs.existsSync(retiredStorage.files.positions), false);
assert.equal(fs.existsSync(retiredStorage.files.trades), false);
assert.equal(fs.existsSync(retiredStorage.files.accountState), false);

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
  strategyFamily: 'ema_trend_family',
  familyRank: 1,
  familyGateDecision: 'allowed',
  familyBlockReason: null,
  strategyCooldownDecision: 'allowed',
  strategyCooldownBlockReason: null,
  nextAllowedAt: null,
  entryReason: 'Signal confirmed',
});

assert.equal(openMnq.ok, true);
assert.equal(openMnq.position.root, 'MNQ');
assert.equal(openMnq.position.status, 'open');
assert.equal(openMnq.position.unrealizedPnlUsd, 0);
assert.equal(openMnq.position.strategyFamily, 'ema_trend_family');
assert.equal(openMnq.position.familyRank, 1);
assert.equal(openMnq.position.familyGateDecision, 'allowed');
assert.equal(openMnq.position.familyBlockReason, null);
assert.equal(openMnq.position.strategyCooldownDecision, 'allowed');
assert.equal(openMnq.position.strategyCooldownBlockReason, null);
assert.equal(openMnq.position.nextAllowedAt, null);
assert.equal(openMnq.positions.totalOpen, 1);
assert.equal(openMnq.mode, 'paper_only');
assert.equal(openMnq.actions_allowed, false);
assert.equal(openMnq.market.session, 'Globex');
assert.equal(openMnq.market.sessionId, 'europe');
assert.equal(openMnq.market.isRth, false);
assert.equal(openMnq.market.isGlobex, true);
assert.equal(openMnq.position.entrySession.sessionId, 'europe');
assert.equal(openMnq.position.sessionId, 'europe');

const openMes = ledgerSvc.openFuturesPaperPosition({
  now: '2026-07-06T11:02:00.000Z',
  root: 'MES',
  symbol: 'MESU26',
  side: 'short',
  contracts: 1,
  entryPrice: 5000,
  stopLoss: 5010,
  takeProfit: 4980,
  strategyId: 'resistance_rejection',
  strategyName: 'Resistance Rejection',
  entryReason: 'Momentum fade',
});

assert.equal(openMes.ok, true);
assert.equal(openMes.position.strategyFamily, null);
assert.equal(openMes.position.familyRank, null);
assert.equal(openMes.position.familyGateDecision, 'not_applicable');
assert.equal(openMes.position.familyBlockReason, null);
assert.equal(openMes.position.strategyCooldownDecision, 'not_applicable');
assert.equal(openMes.position.strategyCooldownBlockReason, null);
assert.equal(openMes.positions.totalOpen, 2);

const closeMnq = ledgerSvc.closeFuturesPaperPosition({
  now: '2026-07-06T11:05:00.000Z',
  tradeId: openMnq.position.tradeId,
  exitPrice: 20002,
  exitReason: 'target_hit',
});

assert.equal(closeMnq.ok, true);
assert.equal(closeMnq.trade.status, 'closed');
// Gross = 2 punkter * $2 = $4. Fees = $1.22 open + $1.22 close = $2.44. Net = $1.56.
assert.equal(closeMnq.trade.grossPnlUsd, 4);
assert.equal(closeMnq.trade.feesUsd, 2.44);
assert.equal(closeMnq.trade.realizedPnlUsd, 1.56);
assert.equal(closeMnq.trade.realizedPnlSek, 16.38);
assert.equal(closeMnq.trade.netPnlUsd, 1.56);
assert.equal(closeMnq.trade.strategyFamily, 'ema_trend_family');
assert.equal(closeMnq.trade.familyRank, 1);
assert.equal(closeMnq.trade.familyGateDecision, 'allowed');
assert.equal(closeMnq.trade.strategyCooldownDecision, 'allowed');
assert.equal(closeMnq.trade.entrySession.sessionId, 'europe');
assert.equal(closeMnq.trade.exitSession.sessionId, 'europe');
assert.equal(closeMnq.positions.totalOpen, 1);
assert.equal(closeMnq.positions.totalClosed, 1);

const closeMes = ledgerSvc.closeFuturesPaperPosition({
  now: '2026-07-06T11:10:00.000Z',
  tradeId: openMes.position.tradeId,
  exitPrice: 4998,
  exitReason: 'manual_close',
});

assert.equal(closeMes.ok, true);
// Gross = 2 punkter * $5 = $10. Fees = $2.44. Net = $7.56.
assert.equal(closeMes.trade.grossPnlUsd, 10);
assert.equal(closeMes.trade.feesUsd, 2.44);
assert.equal(closeMes.trade.realizedPnlUsd, 7.56);
assert.equal(closeMes.trade.realizedPnlSek, 79.38);
assert.equal(closeMes.positions.totalOpen, 0);
assert.equal(closeMes.positions.totalClosed, 2);

const ledger = ledgerSvc.getFuturesPaperLedger({ limit: 10 });
assert.equal(ledger.ok, true);
assert.equal(ledger.positions.totalOpen, 0);
assert.equal(ledger.positions.totalClosed, 2);
assert.equal(ledger.openPositions.length, 0);
assert.equal(ledger.closedTrades.length, 2);
assert.equal(ledger.closedTrades[0].strategyFamily, 'ema_trend_family');
assert.equal(ledger.closedTrades[0].familyRank, 1);
assert.equal(ledger.closedTrades[0].familyGateDecision, 'allowed');
assert.equal(ledger.closedTrades[0].strategyCooldownDecision, 'allowed');
assert.equal(ledger.trades.length, 2);
// Netto efter avgifter: 16.38 + 79.38 = 95.76 SEK. Totala fees: 2.44*2*10.5 = 51.24 SEK.
assert.equal(ledger.account.realizedPnlSek, 95.76);
assert.equal(ledger.account.cashSek, 250095.76);
assert.equal(ledger.account.equitySek, 250095.76);
assert.equal(ledger.account.totalPnlSek, 95.76);
assert.equal(ledger.account.totalFeesSek, 51.24);
assert.equal(ledger.account.openExposureSek, 0);
assert.equal(ledger.account.usedMarginSek, 0);
assert.equal(ledger.account.availableMarginSek, 250095.76);
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

const premarketOpen = ledgerSvc.openFuturesPaperPosition({
  now: '2026-07-06T12:45:00.000Z',
  root: 'MNQ',
  symbol: 'MNQU26',
  side: 'long',
  contracts: 1,
  entryPrice: 20000,
  stopLoss: 19990,
  takeProfit: 20020,
  strategyId: 'session_metadata_test',
  strategyName: 'Session Metadata Test',
  entryReason: 'Premarket entry metadata test',
});
assert.equal(premarketOpen.ok, true);
assert.equal(premarketOpen.position.entrySession.sessionId, 'us_premarket');
assert.equal(premarketOpen.position.entrySession.exchangeLocalTime, '07:45');

const rthClose = ledgerSvc.closeFuturesPaperPosition({
  now: '2026-07-06T13:45:00.000Z',
  tradeId: premarketOpen.position.tradeId,
  exitPrice: 20010,
  exitReason: 'rth_exit_metadata_test',
});
assert.equal(rthClose.ok, true);
assert.equal(rthClose.trade.entrySession.sessionId, 'us_premarket');
assert.equal(rthClose.trade.exitSession.sessionId, 'us_rth');
assert.equal(rthClose.trade.exitSession.exchangeLocalTime, '08:45');

const stateWithLegacyTrade = storage.readPositions();
storage.writePositions({
  ...stateWithLegacyTrade,
  closed: [
    ...stateWithLegacyTrade.closed,
    {
      tradeId: 'legacy_no_session_metadata',
      root: 'MES',
      symbol: 'MES',
      side: 'short',
      contracts: 1,
      entryPrice: 5000,
      exitPrice: 4999,
      openedAt: '2026-07-01T12:00:00.000Z',
      closedAt: '2026-07-01T13:00:00.000Z',
      status: 'closed',
      realizedPnlUsd: 5,
      realizedPnlSek: 52.5,
      grossPnlUsd: 7.44,
      grossPnlSek: 78.12,
      feesUsd: 2.44,
      feesSek: 25.62,
    },
  ],
});

const legacyRead = ledgerSvc.getRecentClosedTrades({ limit: 10 }).trades
  .find((row) => row.tradeId === 'legacy_no_session_metadata');
assert.equal(legacyRead.entrySession, null);
assert.equal(legacyRead.exitSession, null);
assert.equal(legacyRead.sessionId, null);

let directPositionAccountReads = 0;
const directPositionSvc = createFuturesPaperLedgerService({
  storageService: {
    readPositions() {
      return {
        open: [
          {
            tradeId: 'open_fast_path',
            root: 'MNQ',
            symbol: 'MNQU6',
            side: 'long',
            contracts: 1,
            entryPrice: 20000,
            openedAt: '2026-07-06T11:00:00.000Z',
            status: 'open',
          },
        ],
        closed: [
          {
            tradeId: 'closed_fast_path',
            root: 'MNQ',
            symbol: 'MNQU6',
            side: 'long',
            contracts: 1,
            entryPrice: 20000,
            exitPrice: 20002,
            openedAt: '2026-07-06T11:00:00.000Z',
            closedAt: '2026-07-06T11:05:00.000Z',
            status: 'closed',
            realizedPnlUsd: 1.56,
          },
        ],
        updatedAt: '2026-07-06T11:05:00.000Z',
      };
    },
    readTrades() { throw new Error('getFuturesPaperPositions must not read trades'); },
    readJsonl() { throw new Error('getFuturesPaperPositions must not read event logs'); },
  },
  accountService: {
    getFuturesPaperAccount() {
      directPositionAccountReads += 1;
      return { account: { fxUsdSek: 10.5 } };
    },
  },
});
const directPositions = directPositionSvc.getFuturesPaperPositions();
assert.equal(directPositions.ok, true);
assert.equal(directPositions.positions.totalOpen, 1);
assert.equal(directPositions.positions.totalClosed, 1);
assert.equal(directPositions.openPositions[0].tradeId, 'open_fast_path');
assert.equal(directPositions.closedPositions[0].tradeId, 'closed_fast_path');
assert.equal(directPositionAccountReads, 1, 'positionsläsning ska hämta konto/fx en gång per snapshot');

console.log('futuresPaperLedgerService.test.js passed');
