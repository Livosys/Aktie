'use strict';

// ── Tio samtidiga logiska trades ────────────────────────────────────────────
//
// Taket är höjt till tio. Frågan som avgör om tio betyder TIO är inte taket
// utan ägarskapet: IB aggregerar, så tio MNQ-entries blir EN positionsrad med
// tio kontrakt. Om något i kedjan identifierade en trade på conId eller på
// positionsraden skulle nio av tio tappa sin identitet — och det är inte
// hypotetiskt, det var D1-buggen 2026-08-14 där entryfill nycklad på conId gav
// dagens FÖRSTA fill och därmed fel entry och fel tecken på resultatet.
//
// Testerna bevakar därför kedjan, inte siffran.

const test = require('node:test');
const assert = require('node:assert/strict');

const risk = require('./ibPaperBrokerRiskService');
const config = require('./ibPaperExecutionConfigService');
const reconciliation = require('./ibPaperBrokerReconciliationService');

const CAP = config.HARD_MAX_OPEN_POSITIONS;
const quote = {
  source: 'ibkr_realtime', bid: 22990, ask: 22990.25, last: 22990,
  updatedAt: new Date().toISOString(), simulated: false, delayed: false,
};
const base = {
  executionTarget: 'ibkr_paper', quantity: 1, orderType: 'MKT', stopLossPrice: 22980,
  quote, openOrders: [], reconciliation: { degraded: false }, accountSummary: null,
  now: new Date(),
};

/** IB:s vy: EN rad per kontrakt, med aggregerad signerad kvantitet. */
function aggregatedPositions({ mnq = 0, mes = 0 } = {}) {
  const rows = [];
  if (mnq) rows.push({ conId: 793356225, localSymbol: 'MNQU6', root: 'MNQ', position: mnq });
  if (mes) rows.push({ conId: 793356217, localSymbol: 'MESU6', root: 'MES', position: mes });
  return rows;
}

function allowed(positions, root = 'MNQ') {
  const result = risk.evaluateBrokerRisk({ ...base, root, positions });
  return { ok: risk.partitionBlockers(result).orderRiskAllowed, blockers: result.blockers };
}

test('1. taket är tio och gäller kontrakt, inte positionsrader', () => {
  assert.equal(CAP, 10);
  assert.equal(config.getPilotLimits({ executionTarget: 'ibkr_paper' }).maxOpenPositions, 10);
  // Live rör vi aldrig.
  assert.equal(config.getPilotLimits({ executionTarget: 'ibkr_live' }).maxOpenPositions, 1);
});

test('2. trade 1 till 10 accepteras, trade 11 blockeras', () => {
  for (let open = 0; open < CAP; open += 1) {
    // Allt på SAMMA rot: värsta fallet för aggregeringen.
    const { ok, blockers } = allowed(aggregatedPositions({ mnq: open }));
    assert.equal(ok, true, `med ${open} öppna ska nästa släppas igenom, fick ${JSON.stringify(blockers)}`);
  }
  const eleventh = allowed(aggregatedPositions({ mnq: CAP }));
  assert.equal(eleventh.ok, false, 'trade 11 måste blockeras');
  assert.ok(eleventh.blockers.includes('max_open_broker_positions'));
});

test('3. taket gäller totalen, oavsett hur kontrakten fördelas', () => {
  assert.equal(allowed(aggregatedPositions({ mnq: 6, mes: 3 })).ok, true, '9 kontrakt lämnar plats');
  assert.equal(allowed(aggregatedPositions({ mnq: 6, mes: 4 })).ok, false, '10 kontrakt är taket');
  // Short är exponering, inte negativ exponering.
  assert.equal(allowed(aggregatedPositions({ mnq: -6, mes: -4 })).ok, false);
});

test('4. varje logisk trade behåller sin identitet i orderRef', () => {
  // Tio entries på samma rot ger tio olika executionId, och reconciliation
  // matchar på REF — aldrig på conId eller positionsrad.
  const refs = [];
  for (let i = 0; i < CAP; i += 1) refs.push(`TOS-PAPER-fxp_trade${i}-entry`);
  const ids = refs.map((ref) => reconciliation.executionIdFromOrderRef(ref));
  assert.equal(new Set(ids).size, CAP, 'tio trades måste ge tio identiteter');
  assert.deepEqual(ids[0], 'fxp_trade0');
  // Skyddsbenen bär samma executionId som sin entry — det är kopplingen som
  // gör att en exit hamnar på RÄTT trade.
  for (let i = 0; i < CAP; i += 1) {
    for (const leg of ['stopLoss', 'takeProfit']) {
      assert.equal(reconciliation.executionIdFromOrderRef(`TOS-PAPER-fxp_trade${i}-${leg}`), `fxp_trade${i}`);
    }
  }
});

test('5. tio trades på samma rot reconcileras mot EN aggregerad brokerposition', () => {
  // Det här är fasens stoppvillkor: blir ägarskapet tvetydigt när IB visar en
  // rad med tio kontrakt i stället för tio rader?
  const intents = [];
  const openOrders = [];
  for (let i = 0; i < CAP; i += 1) {
    const executionId = `fxp_trade${i}`;
    intents.push({
      executionId, orderRef: `TOS-PAPER-${executionId}-entry`,
      status: 'entry_filled', root: 'MNQ',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    for (const [leg, orderType] of [['stopLoss', 'STP'], ['takeProfit', 'LMT']]) {
      openOrders.push({
        orderId: 1000 + openOrders.length,
        order: { orderType, orderRef: `TOS-PAPER-${executionId}-${leg}`, ocaGroup: `oca-${executionId}` },
        state: 'PreSubmitted',
      });
    }
  }

  const compared = reconciliation.compareSnapshots({
    intents,
    openOrders,
    executions: [],
    // IB:s aggregerade vy: EN rad, tio kontrakt.
    positions: aggregatedPositions({ mnq: CAP }),
    orderStatuses: [],
    now: new Date(),
  });

  assert.deepEqual(compared.discrepancies, [],
    `tio logiska trades mot en aggregerad rad ska stämma, fick ${JSON.stringify(compared.discrepancies)}`);
});

test('6. en saknad trade upptäcks även när brokerraden ser hel ut', () => {
  // Kontrollen får inte bli blind bara för att positionsraden summerar rätt.
  const intents = [{
    executionId: 'fxp_borta', orderRef: 'TOS-PAPER-fxp_borta-entry',
    status: 'submitted', root: 'MNQ',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }];
  const compared = reconciliation.compareSnapshots({
    intents, openOrders: [], executions: [],
    positions: aggregatedPositions({ mnq: CAP }),
    orderStatuses: [], now: new Date(),
  });
  assert.ok(compared.discrepancies.length > 0, 'en intent utan motsvarighet hos IB måste synas');
});

test('7. helt oskyddad exponering upptäcks fortfarande', () => {
  const compared = reconciliation.compareSnapshots({
    intents: [], openOrders: [], executions: [],
    positions: aggregatedPositions({ mnq: CAP }),
    orderStatuses: [], now: new Date(),
  });
  assert.ok(compared.discrepancies.some((row) => row.type === 'unprotected_position'),
    'tio kontrakt utan en enda stop måste flagga');
});

test('8. övriga paper-gränser är oförändrade', () => {
  const limits = config.getPilotLimits({ executionTarget: 'ibkr_paper' });
  assert.equal(limits.maxQuantity, 1, 'exakt ett kontrakt per entry');
  assert.equal(limits.requireStopLoss, true);
  assert.equal(limits.maxEntriesPerHour, 100);
  assert.deepEqual(limits.symbolAllowlist, ['MNQ', 'MES']);
  assert.equal(require('./futuresPaperDailyTradeCapService').MAX_NEW_PAPER_TRADES_PER_DAY, 100);

  // En entry utan stop blockeras oavsett hur mycket plats som finns i taket.
  const noStop = risk.evaluateBrokerRisk({ ...base, root: 'MNQ', stopLossPrice: null, positions: [] });
  assert.ok(noStop.blockers.includes('stop_loss_required'));
});

console.log('futuresPaperTenConcurrent.acceptance.test.js loaded');
