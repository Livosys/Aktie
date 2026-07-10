'use strict';

// Fee-/kostnadsmodell för Futures Paper (MNQ/MES/NQ/ES).
// Verifierar: gross/fees/net PnL per kontrakt, att entry-fee dras vid open och
// exit-fee vid close, att net = gross - totala fees, att okänt kontrakt blockas,
// samt att safety-flaggorna är oförändrade. Endast paper — inga riktiga order.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFuturesPaperStorageService } = require('./futuresPaperStorageService');
const { createFuturesPaperAccountService } = require('./futuresPaperAccountService');
const { createFuturesPaperLedgerService } = require('./futuresPaperLedgerService');
const catalog = require('./futuresContractCatalogService');

function freshLedger() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-fees-'));
  const storage = createFuturesPaperStorageService({ rootDir });
  const accountSvc = createFuturesPaperAccountService({ storageService: storage });
  const ledgerSvc = createFuturesPaperLedgerService({ storageService: storage, accountService: accountSvc });
  return { ledgerSvc };
}

const FX = createFuturesPaperAccountService().DEFAULT_CONFIG.fxUsdSek; // 10.5
function r2(n) { return Math.round(n * 100) / 100; }

// entry 20000 -> exit 20010 = 10 punkter long för alla, olika pointValue/fee.
const cases = [
  { root: 'MNQ', pointValueUsd: 2, commissionPerSideUsd: 1.22, grossUsd: 20, feesUsd: 2.44, netUsd: 17.56 },
  { root: 'MES', pointValueUsd: 5, commissionPerSideUsd: 1.22, grossUsd: 50, feesUsd: 2.44, netUsd: 47.56 },
  { root: 'NQ', pointValueUsd: 20, commissionPerSideUsd: 2.25, grossUsd: 200, feesUsd: 4.50, netUsd: 195.50 },
  { root: 'ES', pointValueUsd: 50, commissionPerSideUsd: 2.25, grossUsd: 500, feesUsd: 4.50, netUsd: 495.50 },
];

for (const c of cases) {
  // Katalogen bär rätt point value och courtage per side.
  assert.equal(catalog.getPointValueUsd(c.root), c.pointValueUsd, `${c.root} pointValue`);
  assert.equal(catalog.getCommissionPerSideUsd(c.root), c.commissionPerSideUsd, `${c.root} commission/side`);

  const { ledgerSvc } = freshLedger();
  const opened = ledgerSvc.openFuturesPaperPosition({
    root: c.root,
    side: 'long',
    contracts: 1,
    entryPrice: 20000,
  });
  assert.equal(opened.ok, true, `${c.root} open ok`);
  assert.equal(opened.position.entryFeeUsd, c.commissionPerSideUsd, `${c.root} entry fee usd`);

  // Fee dras vid open: cash = start - entryFeeSek (avgiften avrundas till öre först).
  const startingBalance = opened.account.startingBalanceSek;
  const entryFeeSek = r2(c.commissionPerSideUsd * FX);
  assert.equal(opened.account.cashSek, r2(startingBalance - entryFeeSek), `${c.root} cash efter open`);
  assert.equal(opened.account.totalFeesSek, entryFeeSek, `${c.root} totalFees efter open`);

  const closed = ledgerSvc.closeFuturesPaperPosition({
    tradeId: opened.position.tradeId,
    exitPrice: 20010,
  });
  assert.equal(closed.ok, true, `${c.root} close ok`);
  assert.equal(closed.trade.grossPnlUsd, c.grossUsd, `${c.root} gross`);
  assert.equal(closed.trade.feesUsd, c.feesUsd, `${c.root} total fees`);
  // Net PnL = gross - totala fees.
  assert.equal(closed.trade.netPnlUsd, c.netUsd, `${c.root} net`);
  assert.equal(r2(c.grossUsd - c.feesUsd), c.netUsd, `${c.root} net = gross - fees`);
  assert.equal(closed.trade.realizedPnlUsd, c.netUsd, `${c.root} realized = net`);
  assert.equal(closed.trade.realizedPnlSek, r2(c.netUsd * FX), `${c.root} realized SEK`);

  // Fee dras vid close: total fees = 2 sidor, konto reflekterar net.
  assert.equal(closed.account.totalFeesSek, r2(c.feesUsd * FX), `${c.root} totalFees efter close`);
  assert.equal(closed.account.cashSek, r2(startingBalance + c.netUsd * FX), `${c.root} cash efter close`);
  assert.equal(closed.account.realizedPnlSek, r2(c.netUsd * FX), `${c.root} realized SEK på konto`);

  // Safety-flaggor oförändrade.
  assert.equal(closed.mode, 'paper_only', `${c.root} mode`);
  assert.equal(closed.actions_allowed, false, `${c.root} actions_allowed`);
  assert.equal(closed.can_place_orders, false, `${c.root} can_place_orders`);
  assert.equal(closed.live_trading_enabled, false, `${c.root} live_trading_enabled`);
  assert.equal(closed.broker_enabled, false, `${c.root} broker_enabled`);
}

// Okänt kontrakt blockas tydligt.
const { ledgerSvc } = freshLedger();
const unknown = ledgerSvc.openFuturesPaperPosition({
  root: 'CL',
  side: 'long',
  contracts: 1,
  entryPrice: 75,
});
assert.equal(unknown.ok, false, 'okänt kontrakt ska blockas');
assert.equal(unknown.error, 'invalid_root', 'okänt kontrakt ger invalid_root');
assert.equal(catalog.isSupportedRoot('CL'), false, 'CL stöds inte');
assert.equal(catalog.getPointValueUsd('CL'), null, 'CL saknar pointValue');

// Round trip-kostnad exponeras för UI.
assert.equal(catalog.roundTripCostUsd('MNQ', 1), 2.44, 'MNQ round trip');
assert.equal(catalog.roundTripCostUsd('NQ', 2), 9, 'NQ round trip 2 kontrakt');

console.log('futuresPaperFees.test.js passed');
