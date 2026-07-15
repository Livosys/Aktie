'use strict';

// Integrationstest: MFE/MAE-instrumentering via ledgern (open → mark → close).
// Bevisar att exit-/PnL-beteendet är OFÖRÄNDRAT och att banan mäts korrekt.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService, toPositionView } = require('./futuresPaperLedgerService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-excursion-'));
const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage, allowInternalSimulationForTests: true });
const ledger = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc, allowInternalSimulationForTests: true });

// --- Open long MNQ ---
const open = ledger.openFuturesPaperPosition({
  now: '2026-07-06T11:00:00.000Z',
  root: 'MNQ', symbol: 'MNQU26', side: 'long', contracts: 1,
  entryPrice: 20000, stopLoss: 19990, takeProfit: 20020,
  strategyId: 'trend_continuation', strategyName: 'Trend Continuation',
  dataSource: 'simulated_fallback', usedFallbackPrice: true,
});
assert.equal(open.ok, true);
// Excursion initierad vid open: highest/lowest = entry, provenance satt.
assert.equal(open.position.highestPriceWhileOpen, 20000);
assert.equal(open.position.lowestPriceWhileOpen, 20000);
assert.equal(open.position.initialStopPrice, 19990);
assert.equal(open.position.initialTargetPrice, 20020);
assert.equal(open.position.initialRiskPoints, 10);
assert.equal(open.position.measurementQuality, 'simulated');
assert.equal(open.position.mfeMaeSource, 'runtime_price_updates');
assert.equal(open.position.exitType, null, 'öppen position har ingen exitType');
assert.equal(open.position.maximumFavorableExcursionPoints, 0);

const tradeId = open.position.tradeId;

// --- Mark-to-market: pris upp till 20015 (favorable), sedan ned till 20008 ---
ledger.markOpenPositionsToMarket({ prices: { [tradeId]: 20015 }, now: '2026-07-06T11:01:00.000Z' });
ledger.markOpenPositionsToMarket({ prices: { [tradeId]: 20008 }, now: '2026-07-06T11:02:00.000Z' });

let openView = ledger.getPositionsSummary().open.find((p) => p.tradeId === tradeId);
assert.equal(openView.highestPriceWhileOpen, 20015, 'topp fångad');
assert.equal(openView.maximumFavorableExcursionPoints, 15, 'MFE 15 pts');
// MFE SEK gross = 15 * pointValue(2) * 1 * fx(10.5) = 315.
assert.equal(openView.maximumFavorableExcursionSek, 315);
assert.equal(openView.peakUnrealizedPnlSek, 315);
assert.equal(openView.maximumAdverseExcursionPoints, 0, 'aldrig under entry');

// --- Close på take profit; observerat markPrice 20021 (bortom TP) ---
const grossBefore = openView; // för jämförelse
const close = ledger.closeFuturesPaperPosition({
  now: '2026-07-06T11:05:00.000Z',
  tradeId,
  exitPrice: 20020,          // TP-fill
  markPrice: 20021,          // observerat feed-pris (bortom TP)
  exitReason: 'take_profit_hit',
});
assert.equal(close.ok, true);
// PnL-BETEENDE OFÖRÄNDRAT: gross = 20 pts * $2 = $40 (baserat på exitPrice, ej markPrice).
assert.equal(close.trade.grossPnlUsd, 40, 'PnL baseras på exitPrice, inte markPrice');
assert.equal(close.trade.feesUsd, 2.44);
assert.equal(close.trade.realizedPnlUsd, 37.56);
// Excursion fryst: markPrice 20021 fångas som ny topp (21 pts).
assert.equal(close.trade.exitType, 'take_profit');
assert.equal(close.trade.maximumFavorableExcursionPoints, 21, 'markPrice fångas i extremen');
assert.equal(close.trade.finalStopPrice, 19990, 'ingen trailing → final = initial stop');
// gaveBackFromPeak: peak gross SEK = 21*2*10.5 = 441; exit gross SEK = 40*10.5 = 420 → 21.
assert.equal(close.trade.maximumFavorableExcursionSek, 441);
assert.equal(close.trade.gaveBackFromPeakSek, 21);

// --- Persisterad trade i loggen bär excursion-fälten ---
const trades = storage.readTrades();
const stored = trades.find((t) => t.tradeId === tradeId);
assert.equal(stored.maximumFavorableExcursionPoints, 21);
assert.equal(stored.exitType, 'take_profit');
assert.equal(stored.gaveBackFromPeakSek, 21);

// --- Legacy-trade utan excursion renderas säkert (null / unknown_legacy) ---
const legacyView = toPositionView({
  tradeId: 'legacy_1', root: 'MES', symbol: 'MESU26', side: 'long',
  contracts: 1, entryPrice: 5000, exitPrice: 5005, status: 'closed',
  realizedPnlUsd: 25, realizedPnlSek: 262.5, strategyId: 'legacy_strat',
}, 10.5);
assert.equal(legacyView.maximumFavorableExcursionPoints, null, 'legacy MFE null');
assert.equal(legacyView.exitType, 'unknown_legacy', 'legacy exitType');
assert.equal(legacyView.hasExcursionData, false);
assert.equal(legacyView.measurementQuality, null);

// --- Short: favorable = nedåt ---
const openShort = ledger.openFuturesPaperPosition({
  now: '2026-07-06T12:00:00.000Z', root: 'MES', symbol: 'MESU26', side: 'short',
  contracts: 1, entryPrice: 5000, stopLoss: 5010, takeProfit: 4980,
  strategyId: 'resistance_rejection',
});
ledger.markOpenPositionsToMarket({ prices: { [openShort.position.tradeId]: 4990 }, now: '2026-07-06T12:01:00.000Z' });
const shortView = ledger.getPositionsSummary().open.find((p) => p.tradeId === openShort.position.tradeId);
assert.equal(shortView.maximumFavorableExcursionPoints, 10, 'short MFE = entry-low');
assert.equal(shortView.maximumAdverseExcursionPoints, 0);

console.log('futuresPaperExcursion.integration.test.js passed');
