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

// ── Självläkning: findResolvableStaleIntents ────────────────────────────────
// Bevisregeln är generell. Testerna nedan varierar ETT bevis i taget så att det
// syns exakt vilket som bär.

const NOW = '2026-08-06T17:15:00.000Z';
const OLD = '2026-07-28T19:50:39.146Z';

// Det historiska fallet: en flatten från 28 juli, ingen broker-ref kvar, och en
// position på SAMMA kontrakt som bevisligen tillhör en annan execution.
const historicalOrphan = {
  executionId: 'emergency_flatten_ms52m5gk7175',
  idempotencyKey: 'flatten:793356225:emergency_flatten_ms52m5gk7175',
  status: 'submitted',
  root: 'MNQ',
  direction: 'short',
  updatedAt: OLD,
};
const foreignPosition = { position: -1, conId: 793356225, localSymbol: 'MNQU6', symbol: 'MNQ' };
const foreignProtectiveOrders = [
  { orderRef: 'TOS-PAPER-fxp_cebb174e813ef953-stopLoss', contract: { conId: 793356225, localSymbol: 'MNQU6' }, orderType: 'STP', status: 'PreSubmitted' },
  { orderRef: 'TOS-PAPER-fxp_cebb174e813ef953-takeProfit', contract: { conId: 793356225, localSymbol: 'MNQU6' }, orderType: 'LMT', status: 'Submitted' },
];

{
  const resolvable = recon.findResolvableStaleIntents({
    now: NOW,
    intents: [historicalOrphan],
    openOrders: foreignProtectiveOrders,
    executions: [],
    positions: [foreignPosition],
  });
  assert.equal(resolvable.length, 1);
  assert.equal(resolvable[0].executionId, 'emergency_flatten_ms52m5gk7175');
}

{
  // Ägs positionen av intenten SJÄLV är den fortfarande exponerad → aldrig läka.
  const ownProtectiveOrders = foreignProtectiveOrders.map((order) => ({
    ...order,
    orderRef: order.orderRef.replace('fxp_cebb174e813ef953', 'emergency_flatten_ms52m5gk7175'),
  }));
  const resolvable = recon.findResolvableStaleIntents({
    now: NOW,
    intents: [historicalOrphan],
    openOrders: ownProtectiveOrders,
    executions: [],
    positions: [foreignPosition],
  });
  assert.equal(resolvable.length, 0);
}

{
  // Går positionen inte att tillskriva NÅGON execution vet vi ingenting.
  // Konservativt beteende: den räknas som exponering och blockerar läkning.
  const resolvable = recon.findResolvableStaleIntents({
    now: NOW,
    intents: [historicalOrphan],
    openOrders: [],
    executions: [],
    positions: [foreignPosition],
  });
  assert.equal(resolvable.length, 0);
}

{
  // Bevis 3: yngre än brokerns bevisfönster → kan legitimt vara på väg.
  const fresh = { ...historicalOrphan, updatedAt: '2026-08-06T16:59:00.000Z' };
  assert.equal(recon.findResolvableStaleIntents({
    now: NOW, intents: [fresh], openOrders: [], executions: [], positions: [],
  }).length, 0);
}

{
  // Bevis 2: brokern känner fortfarande till ordern → rör den inte.
  assert.equal(recon.findResolvableStaleIntents({
    now: NOW,
    intents: [historicalOrphan],
    openOrders: [{ orderRef: 'TOS-PAPER-emergency_flatten_ms52m5gk7175-flatten', contract: {} }],
    executions: [],
    positions: [],
  }).length, 0);

  // Samma sak när beviset ligger i executions i stället för openOrders.
  assert.equal(recon.findResolvableStaleIntents({
    now: NOW,
    intents: [historicalOrphan],
    openOrders: [],
    executions: [{ orderRef: 'TOS-PAPER-emergency_flatten_ms52m5gk7175-flatten' }],
    positions: [],
  }).length, 0);
}

{
  // Bevis 1: redan terminal → utanför regelns mängd.
  for (const status of ['filled', 'cancelled', 'rejected', 'expired']) {
    assert.equal(recon.findResolvableStaleIntents({
      now: NOW, intents: [{ ...historicalOrphan, status }], openOrders: [], executions: [], positions: [],
    }).length, 0, `status ${status} ska aldrig läkas`);
  }
}

{
  // Generalitet: regeln känner inte till flatten, kind eller strategi. En vanlig
  // entry-intent med samma bevisläge läks identiskt.
  const plainEntry = {
    executionId: 'fxp_plain_entry',
    idempotencyKey: 'idem-plain-entry',
    status: 'submitted',
    root: 'MNQ',
    updatedAt: OLD,
    entryFilledAt: OLD,
  };
  const resolvable = recon.findResolvableStaleIntents({
    now: NOW,
    intents: [plainEntry],
    openOrders: foreignProtectiveOrders,
    executions: [],
    positions: [foreignPosition],
  });
  assert.equal(resolvable.length, 1);
  assert.equal(resolvable[0].executionId, 'fxp_plain_entry');
}

(async () => {
  // ── FAS 5: läkningen ska ge en ren reconciliation utan manuell inblandning ──
  {
    // Ägaren till dagens position måste finnas lokalt, annars flaggas dess
    // skyddsordrar som ib_order_missing_locally och testet mäter fel sak.
    // Så ser produktionsläget ut: en öppen position ligger på 'submitted'.
    const positionOwner = {
      executionId: 'fxp_cebb174e813ef953',
      idempotencyKey: 'idem-position-owner',
      status: 'submitted',
      root: 'MNQ',
      updatedAt: OLD,
      entryFilledAt: OLD,
    };
    const stored = [{ ...historicalOrphan }, positionOwner];
    const writes = [];
    const healingService = recon.createIbPaperBrokerReconciliationService({
      adapter: {
        getStatus: () => ({ connected: true, nextValidIdReady: true }),
        getOpenPaperOrders: async () => ({ ok: true, orders: foreignProtectiveOrders }),
        getPaperExecutions: async () => ({ ok: true, executions: [] }),
        getPaperPositions: async () => ({ ok: true, positions: [foreignPosition] }),
        getAccountSummary: async () => ({ ok: true }),
        getOrderStatuses: () => [],
      },
      intentService: {
        listIntents: () => stored.map((row) => ({ ...row })),
        updateStatus: (key, status, extra) => {
          const record = stored.find((row) => row.idempotencyKey === key);
          if (!record) return { ok: false, error: 'intent_not_found' };
          writes.push({ key, status, extra });
          record.status = status;
          return { ok: true, record };
        },
      },
    });
    process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
    const snapshot = await healingService.reconcilePaperBroker({ force: true });

    assert.equal(writes.length, 1, 'exakt en läkning');
    assert.equal(writes[0].status, 'expired', 'terminal utan att påstå ett utfall');
    assert.equal(writes[0].extra.blocker, 'broker_evidence_window_elapsed');
    assert.equal(writes[0].extra.previousStatus, 'submitted');
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.degraded, false);
    assert.equal(snapshot.newEntriesAllowed, true);
    assert.equal(snapshot.blockedReason, null);
    assert.deepEqual(snapshot.discrepancies, []);
    assert.equal(snapshot.healedIntents.length, 1);

    // Idempotens: andra varvet har inget kvar att läka.
    const second = await healingService.reconcilePaperBroker({ force: true });
    assert.equal(writes.length, 1, 'läkningen får inte upprepas');
    assert.equal(second.healedIntents.length, 0);
    assert.equal(second.newEntriesAllowed, true);
  }

  // ── FAS 6: regression — läkningen får aldrig maskera en riktig blockerare ──
  {
    // Ofullständigt broker-svar: frånvaro bevisar ingenting → ingen läkning.
    const stored = [{ ...historicalOrphan }];
    const writes = [];
    const degradedRead = recon.createIbPaperBrokerReconciliationService({
      adapter: {
        getStatus: () => ({ connected: true, nextValidIdReady: true }),
        getOpenPaperOrders: async () => ({ ok: false, timedOut: true, orders: [] }),
        getPaperExecutions: async () => ({ ok: true, executions: [] }),
        getPaperPositions: async () => ({ ok: true, positions: [] }),
        getAccountSummary: async () => ({ ok: true }),
        getOrderStatuses: () => [],
      },
      intentService: {
        listIntents: () => stored.map((row) => ({ ...row })),
        updateStatus: (key, status, extra) => { writes.push({ key, status, extra }); return { ok: true }; },
      },
    });
    const snapshot = await degradedRead.reconcilePaperBroker({ force: true });
    assert.equal(writes.length, 0, 'aldrig läka på ett trasigt broker-svar');
    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.newEntriesAllowed, false);
    assert.equal(stored[0].status, 'submitted', 'intenten ska stå orörd');
  }

  {
    // En LEVANDE position med egna skyddsordrar ska fortfarande blockera när
    // dess intent hänger — självläkningen får inte röra pågående exponering.
    const liveIntent = {
      executionId: 'fxp_cebb174e813ef953',
      idempotencyKey: 'idem-live-position',
      status: 'submitted',
      root: 'MNQ',
      updatedAt: OLD,
      entryFilledAt: OLD,
    };
    const stored = [liveIntent];
    const writes = [];
    const liveService = recon.createIbPaperBrokerReconciliationService({
      adapter: {
        getStatus: () => ({ connected: true, nextValidIdReady: true }),
        // Skyddsordrarna bär intentens EGET executionId → positionen är dess egen.
        getOpenPaperOrders: async () => ({ ok: true, orders: foreignProtectiveOrders }),
        getPaperExecutions: async () => ({ ok: true, executions: [] }),
        getPaperPositions: async () => ({ ok: true, positions: [foreignPosition] }),
        getAccountSummary: async () => ({ ok: true }),
        getOrderStatuses: () => [],
      },
      intentService: {
        listIntents: () => stored.map((row) => ({ ...row })),
        updateStatus: (key, status, extra) => { writes.push({ key, status, extra }); return { ok: true }; },
      },
    });
    await liveService.reconcilePaperBroker({ force: true });
    assert.equal(writes.length, 0, 'en position med egna skyddsordrar får aldrig läkas bort');
    assert.equal(stored[0].status, 'submitted');
  }

  {
    // Oskyddad position: en riktig, allvarlig avvikelse som måste överleva.
    const unprotected = recon.compareSnapshots({
      now: NOW,
      intents: [],
      openOrders: [],
      executions: [],
      positions: [foreignPosition],
      orderStatuses: [],
    });
    assert(unprotected.discrepancies.some((row) => row.type === 'unprotected_position'));
  }

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
