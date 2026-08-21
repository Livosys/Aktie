'use strict';

// Regression för den ackumulerade bracket-incidenten 2026-08-14 20:03–20:20:
// 18 entries på 18 minuter, en per scanner-tick, tills kontot bar 19 kontrakt
// och 38 arbetande skyddsordrar. Två oberoende räknare i riskgrinden var
// trasiga samtidigt, och båda måste vara trasiga för att floden ska uppstå.
//
//   D3  getPositionCount räknade positionsRADER. IB:s reqPositions ger EN rad
//       per conId med .position = signerad nettokvantitet, så varje ny entry
//       lade ett kontrakt på en befintlig rad utan att radantalet steg.
//   D4  countPendingEntries identifierade entry-ordern på `role` + parentId.
//       `role` sätts aldrig på broker-rader, och parentId ägs av IB och ändras
//       under orderns livstid.

const assert = require('assert');
const risk = require('./ibPaperBrokerRiskService');

const { countPendingEntries, getPositionCount, legOfOrderRow } = risk._internal;

function protectiveLeg({ executionId, leg, orderType, parentId }) {
  return {
    orderId: 1000,
    order: {
      orderType,
      orderRef: `TOS-PAPER-${executionId}-${leg}`,
      parentId,
      ocaGroup: `oca-${executionId}`,
    },
    state: 'PreSubmitted',
  };
}

function bracketPair(executionId, parentId) {
  return [
    protectiveLeg({ executionId, leg: 'stopLoss', orderType: 'STP', parentId }),
    protectiveLeg({ executionId, leg: 'takeProfit', orderType: 'LMT', parentId }),
  ];
}

// ---------------------------------------------------------------- D3
{
  // Produktionsläget: två positionsrader, nitton kontrakt.
  const positions = [
    { conId: 793356217, localSymbol: 'MESU6', position: -9 },
    { conId: 793356225, localSymbol: 'MNQU6', position: 10 },
  ];
  assert.equal(getPositionCount(positions), 19, 'exponering mäts i kontrakt, inte rader');
  assert.equal(getPositionCount([{ position: 1 }]), 1);
  assert.equal(getPositionCount([]), 0);
  // Signerad kvantitet: en short är exponering, inte negativ exponering.
  assert.equal(getPositionCount([{ position: -3 }]), 3);
  // Alternativa fältnamn från äldre adaptrar.
  assert.equal(getPositionCount([{ signedQuantity: -2 }, { quantity: 4 }]), 6);
  // Skräp får aldrig sänka summan.
  assert.equal(getPositionCount([{ position: 'x' }, { position: 5 }]), 5);
}

// ---------------------------------------------------------------- D4
{
  // Ben läses ur orderRef, inte ur role/parentId.
  assert.equal(legOfOrderRow({ order: { orderRef: 'TOS-PAPER-fxp_a1-entry' } }), 'entry');
  assert.equal(legOfOrderRow({ order: { orderRef: 'TOS-PAPER-fxp_a1-stopLoss' } }), 'stopLoss');
  assert.equal(legOfOrderRow({ order: { orderRef: 'TOS-PAPER-fxp_a1-takeProfit' } }), 'takeProfit');
  assert.equal(legOfOrderRow({ order: { orderRef: 'TOS-LIVE-fxp_a1-flatten' } }), 'flatten');
  assert.equal(legOfOrderRow({ orderRef: 'TOS-PAPER-fxp_a1-entry' }), 'entry');
  assert.equal(legOfOrderRow({ order: { orderRef: null } }), null);

  // Kärnan i D4: SAMMA bracket-par, bara olika parentId från IB, gav olika svar.
  const justPlaced = bracketPair('fxp_a1', 4711); // föräldern lever -> IB sätter parentId
  const parentGone = bracketPair('fxp_a1', 0);    // föräldern borta -> IB nollställer

  assert.equal(countPendingEntries(justPlaced), 0, 'skyddsben är inte väntande entries');
  assert.equal(countPendingEntries(parentGone), 0, 'och slutar inte vara det när IB nollar parentId');
  assert.equal(
    countPendingEntries(justPlaced),
    countPendingEntries(parentGone),
    'räknaren får inte bero på ett fält som IB ändrar under orderns livstid',
  );

  // En riktig väntande entry räknas — oavsett vad parentId råkar vara.
  const pendingEntry = {
    orderId: 4711,
    order: { orderType: 'MKT', orderRef: 'TOS-PAPER-fxp_a1-entry', parentId: 0 },
    state: 'PreSubmitted',
  };
  assert.equal(countPendingEntries([pendingEntry, ...justPlaced]), 1);

  // Terminala rader räknas inte.
  for (const state of ['Filled', 'Cancelled', 'ApiCancelled']) {
    assert.equal(countPendingEntries([{ ...pendingEntry, state }]), 0, `terminal status ${state}`);
  }

  // Fail closed: en order vi inte lagt själva är okänd och stryper nya entries.
  assert.equal(countPendingEntries([{ orderId: 9, order: { orderType: 'LMT' }, state: 'Submitted' }]), 1);
}

// ------------------------------------------- grinden mot produktionsläget
const quote = {
  root: 'MNQ',
  source: 'ibkr_realtime',
  simulated: false,
  delayed: false,
  updatedAt: '2026-08-14T20:04:00.000Z',
  last: 60000,
  bid: 59999.75,
  ask: 60000,
  spread: 0.25,
  tickSize: 0.25,
};
const accountSummary = {
  ok: true,
  generatedAt: '2026-08-14T20:04:00.000Z',
  cacheAgeMs: 1000,
  account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 },
};
const now = new Date('2026-08-14T20:04:00.000Z');

function evaluate({ openOrders, positions }) {
  return risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 59900,
    quote,
    openOrders,
    positions,
    accountSummary,
    reconciliation: { degraded: false },
    executionTarget: 'ibkr_paper',
    now,
  });
}

{
  // Rent konto: en entry ska släppas igenom.
  const clean = evaluate({ openOrders: [], positions: [] });
  assert.equal(clean.allowed, true, `rent konto ska tillåtas, fick ${JSON.stringify(clean.blockers)}`);
}

{
  // Steget som startade floden: EN öppen position, ETT bracket-par kvar.
  //
  // Same_root-grinden togs bort 2026-08-20 — paper får numera bära flera
  // positioner i samma instrument. Steget SKA därför släppas igenom, och det
  // som håller emot är kontrakttaket längre ned, inte instrumentet.
  //
  // Det som fortfarande måste hålla är D4: bracket-benen får aldrig räknas som
  // väntande entries, oavsett vilket parentId IB råkar ha satt. Räknades de
  // som entries skulle taket för väntande order slå i falskt — och räknades de
  // inte alls skulle en riktig kö av entries kunna byggas obemärkt.
  for (const parentId of [4711, 0]) {
    const openOrders = bracketPair('fxp_a1', parentId);
    const result = evaluate({
      openOrders,
      positions: [{ conId: 793356225, localSymbol: 'MNQU6', position: 1 }],
    });
    assert.equal(countPendingEntries(openOrders), 0, `parentId=${parentId}: skyddsben är inte entries`);
    assert.equal(result.allowed, true,
      `parentId=${parentId} ska släppas igenom, fick ${JSON.stringify(result.blockers)}`);
  }
}

{
  // Slutläget: 19 kontrakt, 38 skyddsordrar.
  const openOrders = [];
  for (let i = 0; i < 19; i += 1) openOrders.push(...bracketPair(`fxp_orphan${i}`, 0));
  const positions = [
    { conId: 793356217, localSymbol: 'MESU6', position: -9 },
    { conId: 793356225, localSymbol: 'MNQU6', position: 10 },
  ];
  const result = evaluate({ openOrders, positions });
  const positionCheck = result.checks.find((c) => c.code === 'max_open_paper_positions');
  const pendingCheck = result.checks.find((c) => c.code === 'max_pending_paper_entries');

  assert.equal(result.allowed, false);
  assert.equal(positionCheck.openPositionCount, 19, 'grinden ska se 19 kontrakt, inte 2 rader');
  assert.equal(positionCheck.ok, false);
  assert.equal(pendingCheck.pendingEntries, 0, '38 skyddsben är noll väntande entries');
  assert.equal(pendingCheck.ok, true);
  assert(result.blockers.includes('max_open_broker_positions'));
}

{
  // Quantity/exposure räknas fortfarande i kontrakt, även om två roots får
  // vara öppna samtidigt.
  const positions = [{ conId: 793356225, localSymbol: 'MNQU6', position: 3 }];
  assert.equal(getPositionCount(positions), 3, '3 kontrakt på en rad är 3, inte 1');
}

// ------------------------------------------- 1 entry -> 1 position + 2 ben
{
  // Invarianten som prioritet 2 kräver: en entry ger exakt en position, ett
  // stop och en take profit — och inget mer öppnas efter den.
  const executionId = 'fxp_single';
  const openOrders = bracketPair(executionId, 0);
  const positions = [{ conId: 793356225, localSymbol: 'MNQU6', position: 1 }];

  const legs = openOrders.map((row) => legOfOrderRow(row)).sort();
  assert.deepEqual(legs, ['stopLoss', 'takeProfit'], 'exakt ett stop och en take profit');
  assert.equal(openOrders.length, 2, 'inga extra ben');
  assert.equal(new Set(openOrders.map((r) => r.order.ocaGroup)).size, 1, 'båda benen i samma OCA-grupp');
  assert.equal(getPositionCount(positions), 1, 'exakt ett kontrakt');
  assert.equal(countPendingEntries(openOrders), 0, 'ingen entry ligger kvar och väntar');

  const next = evaluate({ openOrders, positions });
  assert.equal(next.allowed, true, 'en andra position i samma instrument är tillåten sedan 2026-08-20');

  // ── Men taket biter, och det biter på KONTRAKT ──────────────────────────
  //
  // Det är hela skyddet mot floden nu när instrumentgrinden är borta. Testet
  // läser taket ur konfigurationen: ett hårdkodat tal här hade tyst blivit
  // fel nästa gång policyn flyttas, och då hade regressionen sett grön ut.
  const cap = require('./ibPaperExecutionConfigService').HARD_MAX_OPEN_POSITIONS;
  const atCap = evaluate({
    openOrders,
    // EN rad, hela taket. Radräkning hade sett detta som en position — det var
    // precis D3, och det var så nitton kontrakt kunde byggas upp.
    positions: [{ conId: 793356225, localSymbol: 'MNQU6', position: cap }],
  });
  assert.equal(atCap.allowed, false, 'vid taket måste nästa entry blockeras');
  assert(atCap.blockers.includes('max_open_broker_positions'));

  // Och samma tak oavsett hur kontrakten fördelar sig mellan rötterna.
  const split = evaluate({
    openOrders,
    positions: [
      { conId: 793356225, localSymbol: 'MNQU6', position: Math.ceil(cap / 2) },
      { conId: 793356217, localSymbol: 'MESU6', position: -Math.floor(cap / 2) },
    ],
  });
  assert.equal(split.allowed, false, 'taket gäller totalen, inte per rot');
}

console.log('ibPaperBrokerRiskService.bracketAccumulation.test.js passed');
