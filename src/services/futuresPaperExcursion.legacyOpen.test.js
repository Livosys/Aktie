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

// Seed en legacy open-position UTAN några excursion-fält (som resistance_rejection
// öppnad före instrumenteringen). Ingen mfeMaeSource, ingen highest/lowest.
const legacy = {
  tradeId: 'legacy_open_1', root: 'MES', symbol: 'MESU26', side: 'long', contracts: 1,
  entryPrice: 5000, currentPrice: 5000, stopLoss: 4990, takeProfit: 5020,
  openedAt: '2026-07-09T10:00:00.000Z', closedAt: null, status: 'open',
  strategyId: 'resistance_rejection', dataSource: 'simulated_fallback', usedFallbackPrice: true,
};
storage.writePositions({ open: [legacy], closed: [], updatedAt: null });

// --- Mark-to-market efter "restart": priset mäts, men mfeMaeSource sätts ALDRIG ---
ledger.markOpenPositionsToMarket({ prices: { legacy_open_1: 5012 }, now: '2026-07-09T10:01:00.000Z' });
const openView = ledger.getPositionsSummary().open.find((p) => p.tradeId === 'legacy_open_1');
assert.equal(openView.mfeMaeSource, null, 'legacy open: mfeMaeSource förblir null');
assert.equal(openView.hasExcursionData, false, 'legacy open: hasExcursionData false');
assert.equal(status.hasFullMfeMae(openView), false, 'legacy open exkluderas ur full-data');

// --- Close på stop loss: PnL/exit OFÖRÄNDRAT, fortfarande ej full instrumenterad ---
const close = ledger.closeFuturesPaperPosition({
  now: '2026-07-09T10:05:00.000Z', tradeId: 'legacy_open_1',
  exitPrice: 4990, markPrice: 4989, exitReason: 'stop_loss_hit',
});
assert.equal(close.ok, true);
// PnL oförändrad: (4990-5000)*$5 = -$50 gross; fees $2.44 → net -$52.44.
assert.equal(close.trade.grossPnlUsd, -50, 'legacy close: gross oförändrad');
assert.equal(close.trade.realizedPnlUsd, -52.44, 'legacy close: net oförändrad');
assert.equal(close.trade.mfeMaeSource, null, 'legacy close: mfeMaeSource fortfarande null');
assert.equal(close.trade.hasExcursionData, false, 'legacy close: hasExcursionData false');
assert.equal(status.hasFullMfeMae(close.trade), false, 'legacy close exkluderas ur tradesWithFullMfeMae');

console.log('futuresPaperExcursion.legacyOpen.test.js passed');
