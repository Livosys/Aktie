'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const capModule = require('./futuresPaperDailyTradeCapService');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-paper-cap-'));
const service = capModule.createFuturesPaperDailyTradeCapService({ dir, intentService: { listIntents: () => [] } });
const day = new Date('2026-08-19T22:00:00.000Z');

assert.equal(capModule.tradingDayKey(new Date('2026-08-19T21:59:00.000Z')), '2026-08-18');
assert.equal(capModule.tradingDayKey(day), '2026-08-19');

for (let i = 1; i <= 100; i += 1) {
  const result = service.reserve({ idempotencyKey: `paper-${i}`, strategyId: `strategy-${i}`, now: day });
  assert.equal(result.ok, true, `trade ${i} should be accepted`);
}
const blocked = service.reserve({ idempotencyKey: 'paper-101', strategyId: 'strategy-101', now: day });
assert.equal(blocked.ok, false);
assert.equal(blocked.blockedReason, 'daily_paper_trade_limit_reached');
assert.equal(service.status(day).tradesToday, 100);

const duplicate = service.reserve({ idempotencyKey: 'paper-100', strategyId: 'strategy-100', now: day });
assert.equal(duplicate.ok, true);
assert.equal(duplicate.duplicate, true);
assert.equal(service.status(day).tradesToday, 100);

const restarted = capModule.createFuturesPaperDailyTradeCapService({ dir, intentService: { listIntents: () => [] } });
assert.equal(restarted.status(day).tradesToday, 100);
console.log('futuresPaperDailyTradeCapService.test.js passed');
