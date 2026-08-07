'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const intentModule = require('./ibPaperExecutionIntentService');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-service-'));

function freshService(name) {
  return intentModule.createIbPaperExecutionIntentService({ dir: path.join(tmp, name) });
}

function seed(service, key = 'idem-1') {
  service.createIntent({
    idempotencyKey: key,
    executionId: 'fxp_test_1',
    intent: {
      lifecycleId: 'life-1',
      candidateId: 'cand-1',
      signalId: 'sig-1',
      intentId: key,
      root: 'MNQ',
      direction: 'short',
      strategyId: 'mnq_globex_momentum_v1',
    },
  });
  return key;
}

{
  // Kärnan i städningen: updateStatus vitlistade ~40 fältnamn medan
  // revisionsloggen spred hela `extra`. Ett fält utanför listan hamnade i
  // intents.jsonl men aldrig på posten — tyst. Nu ska godtyckliga fält skrivas
  // igenom, så att ett nytt fält aldrig kan försvinna på vägen.
  const service = freshService('passthrough');
  const key = seed(service);

  const result = service.updateStatus(key, 'expired', {
    blocker: 'broker_evidence_window_elapsed',
    resolvedBy: 'reconciliation_self_heal',
    resolvedAt: '2026-08-06T17:59:09.843Z',
    previousStatus: 'submitted',
    submittedAt: '2026-07-28T19:50:39.146Z',
    cancelOrderId: 39,
    conId: 793356225,
  });

  assert.equal(result.ok, true);
  const record = service.getIntent(key);
  assert.equal(record.lifecycleId, 'life-1');
  assert.equal(record.candidateId, 'cand-1');
  assert.equal(record.signalId, 'sig-1');
  assert.equal(record.intentId, key);
  assert.equal(record.status, 'expired');
  // Fält som den gamla vitlistan tappade.
  assert.equal(record.resolvedBy, 'reconciliation_self_heal');
  assert.equal(record.resolvedAt, '2026-08-06T17:59:09.843Z');
  assert.equal(record.previousStatus, 'submitted');
  assert.equal(record.submittedAt, '2026-07-28T19:50:39.146Z');
  assert.equal(record.cancelOrderId, 39, 'vitlistan stavade fältet cancelledOrderId');
  assert.equal(record.conId, 793356225, 'persistExecutionDetails fyller i kontraktet');
  // Fält som redan fungerade ska fortsätta fungera.
  assert.equal(record.blocker, 'broker_evidence_window_elapsed');

  // Posten och revisionsloggen ska nu säga samma sak.
  const events = service.listEvents({ limit: 10 });
  const statusChange = events.find((row) => row.type === 'status_change');
  assert.equal(statusChange.lifecycleId, 'life-1');
  assert.equal(statusChange.candidateId, 'cand-1');
  assert.equal(statusChange.signalId, 'sig-1');
  assert.equal(statusChange.intentId, key);
  assert.equal(statusChange.resolvedBy, record.resolvedBy);
  assert.equal(statusChange.previousStatus, record.previousStatus);
}

{
  // Identitet och härkomst får aldrig skrivas om av en statusändring.
  const service = freshService('immutable');
  const key = seed(service);
  const before = service.getIntent(key);

  service.updateStatus(key, 'filled', {
    lifecycleId: 'kapad-life',
    candidateId: 'kapad-candidate',
    signalId: 'kapad-signal',
    intentId: 'kapad-intent',
    idempotencyKey: 'kapad-nyckel',
    executionId: 'kapat-id',
    createdAt: '1999-01-01T00:00:00.000Z',
    status: 'cancelled',
  });

  const after = service.getIntent(key);
  assert.equal(after.lifecycleId, before.lifecycleId);
  assert.equal(after.candidateId, before.candidateId);
  assert.equal(after.signalId, before.signalId);
  assert.equal(after.intentId, before.intentId);
  assert.equal(after.idempotencyKey, before.idempotencyKey);
  assert.equal(after.executionId, before.executionId);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.status, 'filled', 'status kommer från argumentet, inte från extra');
  // Posten ska fortfarande gå att slå upp på sin ursprungliga nyckel.
  assert.equal(service.getIntent('kapad-nyckel'), null);
}

{
  // Null-skyddet på orderfälten ska bevaras exakt: en statusändring utan känd
  // order får inte nolla en order vi redan känner.
  const service = freshService('null-guard');
  const key = seed(service);
  service.updateStatus(key, 'submitted', { ibOrderId: 39, permId: 12345, orderRef: 'TOS-PAPER-fxp_test_1-entry' });
  service.updateStatus(key, 'acknowledged', { ibOrderId: null, permId: null, orderRef: '' });

  const record = service.getIntent(key);
  assert.equal(record.ibOrderId, 39);
  assert.equal(record.permId, 12345);
  assert.equal(record.orderRef, 'TOS-PAPER-fxp_test_1-entry');

  // 0 är ett giltigt order-id och ska INTE behandlas som saknat.
  service.updateStatus(key, 'acknowledged', { ibOrderId: 0 });
  assert.equal(service.getIntent(key).ibOrderId, 0);

  // undefined skriver aldrig något alls.
  service.updateStatus(key, 'acknowledged', { blocker: undefined });
  assert.equal(Object.prototype.hasOwnProperty.call(service.getIntent(key), 'blocker'), false);
}

{
  // Nollvärden på vanliga observationsfält ska däremot skrivas igenom — det var
  // vitlistans beteende och flera anropare nollställer medvetet.
  const service = freshService('explicit-null');
  const key = seed(service);
  service.updateStatus(key, 'submitted', { blocker: 'något' });
  service.updateStatus(key, 'filled', { blocker: null, filledPrice: null });
  const record = service.getIntent(key);
  assert.equal(record.blocker, null);
  assert.equal(record.filledPrice, null);
}

{
  // Statusmaskinen ska fortsatt avvisa okända statusar och okända nycklar.
  const service = freshService('guards');
  const key = seed(service);
  assert.equal(service.updateStatus(key, 'not_a_status', {}).ok, false);
  assert.equal(service.updateStatus('finns-inte', 'filled', {}).ok, false);
  assert.equal(service.getIntent(key).status, 'intent_created');
}

console.log('ibPaperExecutionIntentService.test.js passed');
