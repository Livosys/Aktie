'use strict';

// Prioritet 2-invarianten: EN entry ska ge EN position, ETT stop och EN take
// profit — och ingenting mer. Den här filen låser fast formen på orderplanen,
// alltså det enda stället där antalet ben bestäms.
//
// Submit-sidan (att exakt tre placeOrder-anrop görs, i rätt ordning, med rätt
// transmit-sekvens och parentId) täcks av ibPaperExecutionAdapterService.test.js.

const assert = require('assert');
const adapterModule = require('./ibPaperExecutionAdapterService');

const service = adapterModule.createIbPaperExecutionAdapterService({
  ibFactory: () => { throw new Error('ingen IB-klient ska behövas för buildOrderPlan'); },
  flagsProvider: () => ({
    executionEnabled: true,
    shadowMode: true,
    submissionEnabled: false,
    orderSubmissionMode: 'shadow',
    live_trading_enabled: false,
  }),
});

const contract = {
  root: 'MNQ',
  conId: 793356225,
  localSymbol: 'MNQU6',
  expiry: '20260918',
  exchange: 'CME',
  currency: 'USD',
};

function planFor({ side, takeProfitPrice }) {
  return service.buildOrderPlan({
    executionId: 'fxp_shape_1234567890',
    contract,
    side,
    quantity: 1,
    entryType: 'MKT',
    stopLossPrice: side === 'short' ? 60120 : 59880,
    takeProfitPrice,
    tif: 'GTC',
  });
}

function legsOf(plan) {
  return [plan.entry, plan.takeProfit, plan.stopLoss].filter(Boolean);
}

// ---------------------------------------------- full bracket: entry + TP + SL
{
  const plan = planFor({ side: 'long', takeProfitPrice: 60300 });
  const legs = legsOf(plan);

  assert.equal(legs.length, 3, 'exakt tre ben — inga extra skyddsordrar');
  assert.deepEqual(
    legs.map((leg) => leg.orderRef.replace(/^TOS-PAPER-fxp_shape_1234567890-/, '')),
    ['entry', 'takeProfit', 'stopLoss'],
    'ett ben per roll, inga dubbletter',
  );

  // Exakt ETT stop och EN take profit.
  assert.equal(legs.filter((leg) => leg.orderType === 'STP').length, 1);
  assert.equal(legs.filter((leg) => leg.orderType === 'LMT').length, 1);

  // Skyddsbenen ligger i SAMMA OCA-grupp med ocaType 1, så att en fill på det
  // ena annullerar det andra hos IB. Det är det som gör att ett stängt läge
  // inte lämnar ett ensamt ben kvar.
  const protective = [plan.takeProfit, plan.stopLoss];
  assert.equal(new Set(protective.map((leg) => leg.ocaGroup)).size, 1, 'en gemensam OCA-grupp');
  assert.equal(protective[0].ocaGroup, plan.ocaGroup);
  for (const leg of protective) assert.equal(leg.ocaType, 1);
  assert.equal(plan.entry.ocaGroup, undefined, 'entry ligger inte i OCA-gruppen');

  // Riktning: skyddsbenen stänger, entryn öppnar.
  assert.equal(plan.entry.action, 'BUY');
  assert.equal(plan.stopLoss.action, 'SELL');
  assert.equal(plan.takeProfit.action, 'SELL');

  // Kvantitet: skyddet täcker hela positionen, varken mer eller mindre.
  for (const leg of legs) assert.equal(leg.totalQuantity, 1);

  // Transmit-kedjan: bara sista ordern aktiverar hela bracketen.
  assert.deepEqual(legs.map((leg) => leg.transmit), [false, false, true]);
  assert.deepEqual(plan.transmitSequence, ['entry:false', 'takeProfit:false', 'stopLoss:true']);
}

// ---------------------------------------------- short speglar long exakt
{
  const plan = planFor({ side: 'short', takeProfitPrice: 59700 });
  assert.equal(legsOf(plan).length, 3);
  assert.equal(plan.entry.action, 'SELL');
  assert.equal(plan.stopLoss.action, 'BUY');
  assert.equal(plan.takeProfit.action, 'BUY');
  assert.equal(plan.stopLoss.ocaGroup, plan.takeProfit.ocaGroup);
}

// ---------------------------------------------- utan TP: stoppet är obligatoriskt
{
  const plan = planFor({ side: 'long', takeProfitPrice: null });
  const legs = legsOf(plan);
  assert.equal(legs.length, 2, 'entry + stop');
  assert.equal(plan.takeProfit, null);
  assert.ok(plan.stopLoss, 'stoppet får aldrig utebli');
  assert.equal(plan.stopLoss.transmit, true, 'stoppet aktiverar kedjan när TP saknas');
  assert.deepEqual(plan.transmitSequence, ['entry:false', 'stopLoss:true']);
}

// ---------------------------------------------- orderRef bär benet, alltid
{
  const plan = planFor({ side: 'long', takeProfitPrice: 60300 });
  for (const leg of legsOf(plan)) {
    assert.match(
      leg.orderRef,
      /^TOS-PAPER-[A-Za-z0-9_-]+-(entry|stopLoss|takeProfit)$/,
      `orderRef måste bära benet: ${leg.orderRef}`,
    );
    assert.ok(leg.orderRef.length <= 48, 'IB kapar orderRef vid 48 tecken');
  }
}

console.log('ibPaperExecutionAdapterService.bracketShape.test.js passed');
