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

{
  const result = recon.compareSnapshots({
    intents: [{ executionId: 'crash123', idempotencyKey: 'idem-crash', status: 'submit_started', orderRef: 'TOS-PAPER-crash123-entry' }],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert(result.discrepancies.some((row) => row.type === 'unknown_submit_state'));
}

(async () => {
  const service = recon.createIbPaperBrokerReconciliationService({
    adapter: {
      getStatus: () => ({ connected: true, nextValidIdReady: true }),
      getOpenPaperOrders: async () => ({ ok: false, timedOut: true, blocker: 'reconciliation_open_orders_timeout', orders: [] }),
      getPaperExecutions: async () => ({ ok: true, executions: [] }),
      getPaperPositions: async () => ({ ok: true, positions: [] }),
      getOrderStatuses: () => [],
    },
    intentService: { listIntents: () => [] },
  });
  process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
  const snapshot = await service.reconcilePaperBroker({ force: true });
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.newEntriesAllowed, false);
  assert.equal(snapshot.blockedReason, 'reconciliation_open_orders_timeout');

  const disconnected = recon.createIbPaperBrokerReconciliationService({
    adapter: { getStatus: () => ({ connected: true, nextValidIdReady: false }) },
    intentService: { listIntents: () => [] },
  });
  const disconnectedSnapshot = await disconnected.reconcilePaperBroker({ force: true });
  assert.equal(disconnectedSnapshot.degraded, true);
  assert.equal(disconnectedSnapshot.newEntriesAllowed, false);
  assert.equal(disconnectedSnapshot.blockedReason, 'next_valid_id_not_ready');

  console.log('ibPaperBrokerReconciliationService.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
