'use strict';

const assert = require('assert');
const recon = require('./ibPaperBrokerReconciliationService');

{
  const result = recon.compareSnapshots({
    intents: [{
      executionId: 'abc123',
      idempotencyKey: 'idem-1',
      status: 'submitted',
      orderRef: 'TOS-PAPER-abc123-entry',
    }],
    openOrders: [{
      order: { orderRef: 'TOS-PAPER-abc123-entry', orderType: 'MKT' },
      state: 'Submitted',
    }],
    executions: [],
    positions: [],
    orderStatuses: [],
  });
  assert.equal(result.discrepancies.length, 0);
  assert.equal(result.counts.openOrders, 1);
}

{
  const result = recon.compareSnapshots({
    intents: [],
    openOrders: [{ order: { orderRef: 'TOS-PAPER-unknown-entry', orderType: 'MKT' }, state: 'Submitted' }],
    executions: [],
    positions: [],
  });
  assert(result.discrepancies.some((row) => row.type === 'ib_order_missing_locally'));
}

{
  const result = recon.compareSnapshots({
    intents: [{ executionId: 'abc123', idempotencyKey: 'idem-1', status: 'submitted', orderRef: 'TOS-PAPER-abc123-entry' }],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert(result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
}

{
  const result = recon.compareSnapshots({
    intents: [],
    openOrders: [],
    executions: [],
    positions: [{ position: 1, localSymbol: 'MNQU6' }],
  });
  assert(result.discrepancies.some((row) => row.type === 'unprotected_position'));
}

{
  const result = recon.compareSnapshots({
    intents: [
      { executionId: 'a', idempotencyKey: 'dup', status: 'submitted' },
      { executionId: 'b', idempotencyKey: 'dup', status: 'submitted' },
    ],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert(result.discrepancies.some((row) => row.type === 'duplicate_intent'));
}

console.log('ibPaperBrokerReconciliationService.test.js passed');
