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
    now: '2026-07-26T14:00:00.000Z',
    intents: [{
      executionId: 'old-entry-fill',
      idempotencyKey: 'idem-old-entry-fill',
      status: 'submitted',
      orderRef: 'TOS-PAPER-old-entry-fill-entry',
      updatedAt: '2026-07-21T22:46:16.081Z',
      entryFilledAt: '2026-07-21T22:46:16.081Z',
    }],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert.equal(result.discrepancies.length, 0);
}

{
  const result = recon.compareSnapshots({
    now: '2026-07-26T22:19:00.000Z',
    intents: [{
      executionId: 'old-short-entry-fill',
      idempotencyKey: 'idem-old-short-entry-fill',
      status: 'submitted',
      orderRef: 'TOS-PAPER-old-short-entry-fill-entry',
      updatedAt: '2026-07-21T22:46:16.081Z',
      entryFilledAt: '2026-07-21T22:46:16.081Z',
      side: 'SELL',
      localSymbol: 'MNQU6',
    }],
    openOrders: [{ orderType: 'STP', status: 'Submitted' }],
    executions: [],
    positions: [{ position: 1, localSymbol: 'MNQU6' }],
  });
  assert(!result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
}

{
  const result = recon.compareSnapshots({
    now: '2026-07-26T22:19:00.000Z',
    intents: [{
      executionId: 'old-short-entry-fill-open-exposure',
      idempotencyKey: 'idem-old-short-entry-fill-open-exposure',
      status: 'submitted',
      orderRef: 'TOS-PAPER-old-short-entry-fill-open-exposure-entry',
      updatedAt: '2026-07-21T22:46:16.081Z',
      entryFilledAt: '2026-07-21T22:46:16.081Z',
      side: 'SELL',
      localSymbol: 'MNQU6',
    }],
    openOrders: [{ orderType: 'STP', status: 'Submitted' }],
    executions: [],
    positions: [{ position: -1, localSymbol: 'MNQU6' }],
  });
  assert(result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
}

{
  const result = recon.compareSnapshots({
    now: '2026-07-21T22:47:16.000Z',
    intents: [{
      executionId: 'fresh-entry-fill',
      idempotencyKey: 'idem-fresh-entry-fill',
      status: 'submitted',
      orderRef: 'TOS-PAPER-fresh-entry-fill-entry',
      updatedAt: '2026-07-21T22:46:16.081Z',
      entryFilledAt: '2026-07-21T22:46:16.081Z',
    }],
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

// --- Hängande emergency flatten ---------------------------------------------
// En flatten har aldrig entryFilledAt och kan därför strukturellt aldrig fångas
// av isOldEntryFillWithoutBrokerExposure(). Fyllningsvägen kände tidigare inte
// igen '-flatten'-benet, så en flatten som fylldes fastnade på 'submitted' och
// degraderade reconciliation permanent. Bevis för att den gjorde sitt jobb:
// kontraktet den riktades mot är platt.
{
  // Exakt den post som låste produktionen 2026-07-28 → 2026-07-31, kopierad ur
  // intent-index.json. OBS: ingen `kind` och ingen `orderRef` — intent-tjänsten
  // normaliserar bort båda. Identifieringen måste klara just den här formen.
  const result = recon.compareSnapshots({
    now: '2026-07-31T09:11:00.000Z',
    intents: [{
      executionId: 'emergency_flatten_ms52m5gk7175',
      idempotencyKey: 'flatten:793356225:emergency_flatten_ms52m5gk7175',
      status: 'submitted',
      createdAt: '2026-07-28T19:50:39.140Z',
      updatedAt: '2026-07-28T19:50:39.146Z',
      strategyId: null,
      candidateId: null,
      root: 'MNQ',
      conId: null,
      direction: 'short',
      executionTarget: 'ibkr_paper',
      quantity: 1,
      paperAccountIdMasked: 'DU***596',
      localSymbol: null,
      expectedOrderIds: [39],
      side: 'BUY',
      orderRefs: ['TOS-PAPER-emergency_flatten_ms52m5gk7175-flatten'],
    }],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert.equal(result.discrepancies.length, 0);
}

{
  // Kontraktet hittas via conId i idempotencyKey även när posten har conId: null
  // och root saknas — då är nyckeln enda spåret till vilket kontrakt som stängdes.
  const result = recon.compareSnapshots({
    now: '2026-07-31T09:11:00.000Z',
    intents: [{
      executionId: 'emergency_flatten_conid_only',
      idempotencyKey: 'flatten:793356225:emergency_flatten_conid_only',
      status: 'submitted',
      conId: null,
      updatedAt: '2026-07-28T19:50:39.146Z',
    }],
    openOrders: [{ orderType: 'STP', status: 'Submitted' }],
    executions: [],
    positions: [{ position: -1, conId: 793356225 }],
  });
  assert(result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
}

{
  // Exponering kvar på samma kontrakt → fortfarande flaggad. Vi kan inte veta att
  // stängningen gick igenom, så konservativt beteende gäller.
  const result = recon.compareSnapshots({
    now: '2026-07-31T09:11:00.000Z',
    intents: [{
      executionId: 'emergency_flatten_still_exposed',
      idempotencyKey: 'flatten:793356225:emergency_flatten_still_exposed',
      status: 'submitted',
      orderRef: 'TOS-PAPER-emergency_flatten_still_exposed-flatten',
      root: 'MNQ',
      direction: 'short',
      updatedAt: '2026-07-28T19:50:39.146Z',
    }],
    openOrders: [{ orderType: 'STP', status: 'Submitted' }],
    executions: [],
    positions: [{ position: -1, localSymbol: 'MNQU6', symbol: 'MNQ' }],
  });
  assert(result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
}

{
  // Riktningen på en flatten beskriver positionen den STÄNGDE, inte orderns sida.
  // Kontraktsmatchningen får därför inte jämföra riktning: en position som vänt
  // ska fortfarande räknas som kvarvarande exponering.
  const result = recon.compareSnapshots({
    now: '2026-07-31T09:11:00.000Z',
    intents: [{
      executionId: 'emergency_flatten_flipped',
      idempotencyKey: 'flatten:793356225:emergency_flatten_flipped',
      status: 'submitted',
      orderRef: 'TOS-PAPER-emergency_flatten_flipped-flatten',
      root: 'MNQ',
      direction: 'short',
      updatedAt: '2026-07-28T19:50:39.146Z',
    }],
    openOrders: [{ orderType: 'STP', status: 'Submitted' }],
    executions: [],
    positions: [{ position: 1, localSymbol: 'MNQU6', symbol: 'MNQ' }],
  });
  assert(result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
}

{
  // Färsk flatten inom grace-perioden → fortfarande flaggad; den kan legitimt
  // vara på väg. Undantaget får bara gälla poster som bevisligen har fastnat.
  const result = recon.compareSnapshots({
    now: '2026-07-28T20:10:00.000Z',
    intents: [{
      executionId: 'emergency_flatten_fresh',
      idempotencyKey: 'flatten:793356225:emergency_flatten_fresh',
      status: 'submitted',
      orderRef: 'TOS-PAPER-emergency_flatten_fresh-flatten',
      root: 'MNQ',
      direction: 'short',
      updatedAt: '2026-07-28T19:50:39.146Z',
    }],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert(result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
}

{
  // `kind` är den första identifieringsgrenen och används av anropare som skickar
  // posten in-memory, innan intent-tjänsten normaliserat bort fältet. Här saknas
  // både executionId- och idempotencyKey-prefixen, så bara `kind` kan fånga den.
  const result = recon.compareSnapshots({
    now: '2026-07-31T09:11:00.000Z',
    intents: [{
      executionId: 'opaque-id',
      idempotencyKey: 'opaque-key',
      status: 'submitted',
      kind: 'emergency_flatten',
      root: 'MNQ',
      updatedAt: '2026-07-28T19:50:39.146Z',
    }],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert.equal(result.discrepancies.length, 0);
}

{
  // Undantaget får inte läcka till vanliga entry-intents: en gammal submitted
  // entry UTAN entryFilledAt ska fortfarande flaggas.
  const result = recon.compareSnapshots({
    now: '2026-07-31T09:11:00.000Z',
    intents: [{
      executionId: 'plain_entry_no_fill',
      idempotencyKey: 'idem-plain-entry-no-fill',
      status: 'submitted',
      orderRef: 'TOS-PAPER-plain_entry_no_fill-entry',
      root: 'MNQ',
      updatedAt: '2026-07-28T19:50:39.146Z',
    }],
    openOrders: [],
    executions: [],
    positions: [],
  });
  assert(result.discrepancies.some((row) => row.type === 'internal_order_missing_at_ib'));
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
