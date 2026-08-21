'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const capModule = require('./futuresPaperDailyTradeCapService');
const risk = require('./ibPaperBrokerRiskService');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-load-'));
const cap = capModule.createFuturesPaperDailyTradeCapService({ dir, intentService: { listIntents: () => [] } });
const now = new Date('2026-08-19T22:00:00.000Z');
const keys = new Set();
let accepted = 0;
let blocked = 0;
for (let i = 0; i < 150; i += 1) {
  const result = cap.reserve({
    idempotencyKey: `load-${i}`,
    strategyId: `strategy-${i % 10}`,
    canonicalStrategyId: `strategy-${i % 10}`,
    now,
  });
  if (result.ok) accepted += 1;
  else blocked += 1;
  keys.add(`load-${i}`);
}
assert.equal(keys.size, 150);
assert.equal(accepted, 100);
assert.equal(blocked, 50);
assert.equal(cap.status(now).tradesToday, 100);

const quote = {
  source: 'ibkr_realtime', simulated: false, delayed: false,
  updatedAt: now.toISOString(), last: 23000, bid: 22999.75, ask: 23000, spread: 0.25, tickSize: 0.25,
};
const base = { quantity: 1, orderType: 'MKT', stopLossPrice: 22980, quote,
  accountSummary: { ok: true, generatedAt: now.toISOString(), account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
  reconciliation: { degraded: false }, now };
const mnq = risk.evaluateBrokerRisk({ ...base, root: 'MNQ', positions: [] });
assert.equal(mnq.allowed, true);
const mes = risk.evaluateBrokerRisk({ ...base, root: 'MES', quote: { ...quote, root: 'MES', last: 5000 }, positions: [{ root: 'MNQ', localSymbol: 'MNQU6', position: 1 }] });
assert.equal(mes.allowed, true, 'MNQ and MES may be open together');
// Flera positioner i SAMMA instrument är tillåtet sedan 2026-08-20. Grinden
// som förbjöd det tillät aldrig två affärer i samma rot, och med ett tak som
// satt i allowlistens längd blev resultatet i praktiken en enda affär åt
// gången: 2 078 av 2 098 kandidater avvisades 2026-08-19/20.
const sameRoot = risk.evaluateBrokerRisk({ ...base, root: 'MNQ', positions: [{ root: 'MNQ', localSymbol: 'MNQU6', position: 1 }] });
assert.equal(sameRoot.allowed, true, 'flera positioner i samma rot ska tillåtas');

// Skyddet ligger i kontrakttaket, som gäller totalen och räknar |kvantitet|.
const positionCap = require('./ibPaperExecutionConfigService').HARD_MAX_OPEN_POSITIONS;
const atCap = risk.evaluateBrokerRisk({ ...base, root: 'MNQ', positions: [{ root: 'MNQ', localSymbol: 'MNQU6', position: positionCap }] });
assert.equal(atCap.allowed, false, 'vid taket måste nästa entry blockeras');
assert(atCap.blockers.includes('max_open_broker_positions'));
console.log('futuresPaperMultiTradeAcceptance.test.js passed');
