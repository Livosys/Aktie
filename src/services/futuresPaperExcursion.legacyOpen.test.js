'use strict';

// Regression: en position som öppnades FÖRE MFE/MAE-instrumenteringen (saknar
// mfeMaeSource) får aldrig av misstag klassas som full instrumenterad trade,
// och dess PnL/exit-beteende är oförändrat även efter restart (mark + close).

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService } = require('./futuresPaperLedgerService');
const status = require('./futuresPaperExitExperimentStatusService');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-legacy-'));
const storage = createFuturesPaperStorageService({ rootDir });
const accountSvc = createFuturesPaperAccountService({ storageService: storage });
const ledger = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc });

storage.ensureDefaults(
  { currency: 'SEK', startingBalanceSek: 250000, fxUsdSek: 10.5 },
  {},
  { open: [], closed: [], updatedAt: null },
);

// Seed en legacy open-position MED exakt de skräpvärden live-buggen skapade
// (lowestPriceWhileOpen=0 → falsk MFE) men UTAN mfeMaeSource. Läsvyn måste
// maska bort skräpet till null.
const legacy = {
  tradeId: 'legacy_open_1', root: 'MES', symbol: 'MESU26', side: 'short', contracts: 1,
  entryPrice: 5000, currentPrice: 5000, stopLoss: 5010, takeProfit: 4980,
  openedAt: '2026-07-09T10:00:00.000Z', closedAt: null, status: 'open',
  strategyId: 'resistance_rejection', dataSource: 'simulated_fallback', usedFallbackPrice: true,
  // skräpfält från live-buggen:
  highestPriceWhileOpen: 5030, lowestPriceWhileOpen: 0,
  maximumFavorableExcursionPoints: 5000, maximumFavorableExcursionSek: 262500,
  initialStopPrice: 0, initialRiskPoints: 0, mfeMaeSource: null,
};
storage.writePositions({ open: [legacy], closed: [], updatedAt: null });

// --- Läsvy maskar skräpet direkt (även före mark) ---
const preView = ledger.getPositionsSummary().open.find((p) => p.tradeId === 'legacy_open_1');
assert.equal(preView.lowestPriceWhileOpen, null, 'skräp low=0 maskas till null');
assert.equal(preView.maximumFavorableExcursionPoints, null, 'falsk MFE maskas till null');
assert.equal(preView.maximumFavorableExcursionSek, null, 'falsk MFE SEK maskas till null');
assert.equal(preView.initialStopPrice, null, 'skräp initialStopPrice=0 maskas till null');
assert.equal(preView.hasExcursionData, false, 'ej instrumenterad');

// --- Mark-to-market efter "restart": currentPrice/unrealized uppdateras, men
//     ingen excursion beräknas och inga skräpvärden återuppstår ---
ledger.markOpenPositionsToMarket({ prices: { legacy_open_1: 4990 }, now: '2026-07-09T10:01:00.000Z' });
const openView = ledger.getPositionsSummary().open.find((p) => p.tradeId === 'legacy_open_1');
assert.equal(openView.currentPrice, 4990, 'legacy currentPrice uppdateras');
assert.equal(openView.unrealizedPnlUsd, 50, 'legacy unrealized uppdateras (short: (5000-4990)*$5)');
assert.equal(openView.mfeMaeSource, null, 'legacy open: mfeMaeSource förblir null');
assert.equal(openView.lowestPriceWhileOpen, null, 'ingen ny falsk excursion');
assert.equal(openView.maximumFavorableExcursionPoints, null, 'ingen ny falsk MFE');
assert.equal(openView.hasExcursionData, false, 'legacy open: hasExcursionData false');
assert.equal(status.hasFullMfeMae(openView), false, 'legacy open exkluderas ur full-data');

// --- Close på stop loss (short): PnL/exit OFÖRÄNDRAT, fortfarande legacy ---
const close = ledger.closeFuturesPaperPosition({
  now: '2026-07-09T10:05:00.000Z', tradeId: 'legacy_open_1',
  exitPrice: 5010, markPrice: 5011, exitReason: 'stop_loss_hit',
});
assert.equal(close.ok, true);
// PnL oförändrad (short): (5000-5010)*$5 = -$50 gross; fees $2.44 → net -$52.44.
assert.equal(close.trade.grossPnlUsd, -50, 'legacy close: gross oförändrad');
assert.equal(close.trade.realizedPnlUsd, -52.44, 'legacy close: net oförändrad');
assert.equal(close.trade.exitPrice, 5010, 'exitPrice = angivet stop, ej markPrice');
assert.equal(close.trade.mfeMaeSource, null, 'legacy close: mfeMaeSource fortfarande null');
assert.equal(close.trade.hasExcursionData, false, 'legacy close: hasExcursionData false');
assert.equal(close.trade.exitType, 'unknown_legacy', 'legacy close: exitType unknown_legacy');
assert.equal(close.trade.maximumFavorableExcursionPoints, null, 'legacy close: ingen falsk MFE');
assert.equal(close.trade.gaveBackFromPeakSek, null, 'legacy close: ingen falsk gaveBack');
assert.equal(status.hasFullMfeMae(close.trade), false, 'legacy close exkluderas ur tradesWithFullMfeMae');

// --- Storage: den appendade stängda traden bär inga skräp-excursion-tal ---
const storedTrades = storage.readTrades();
const storedClose = storedTrades.find((t) => t.tradeId === 'legacy_open_1');
assert.equal(storedClose.mfeMaeSource == null, true, 'storage: mfeMaeSource null');
assert.equal(storedClose.lowestPriceWhileOpen == null || storedClose.lowestPriceWhileOpen === undefined || storedClose.lowestPriceWhileOpen === null, true, 'storage: inget low=0-skräp');
assert.notEqual(storedClose.maximumFavorableExcursionPoints, 5000, 'storage: falsk MFE saneras');

console.log('futuresPaperExcursion.legacyOpen.test.js passed');
