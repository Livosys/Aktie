'use strict';

const assert = require('assert/strict');
const express = require('express');

const router = require('./api');

async function withTestServer(fn) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', router);

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function assertBlocked(baseUrl, path, payload, expectedError, expectedMode = 'ibkr_paper') {
  const result = await postJson(baseUrl, path, payload);
  assert.equal(result.status, 400, `${path} should reject ${JSON.stringify(payload)}`);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, expectedError);
  assert.equal(result.body.mode, expectedMode);
  assert.equal(result.body.live_trading_enabled, false);
  assert.equal(result.body.broker_enabled, false);
  assert.equal(result.body.actions_allowed, false);
  assert.equal(result.body.can_place_orders, false);
}

async function assertRetired(baseUrl, path, payload = {}) {
  const result = await postJson(baseUrl, path, payload);
  assert.equal(result.status, 410, `${path} should be retired`);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, 'internal_futures_simulation_retired');
  assert.equal(result.body.code, 'internal_futures_simulation_retired');
  assert.equal(result.body.blocker, 'internal_futures_simulation_disabled');
  assert.equal(result.body.executionTarget, 'ibkr_paper');
  assert.equal(result.body.internalSimulationRetired, true);
}

async function main() {
  const retiredEndpoints = [
    '/api/futures-paper/account/reset',
    '/api/futures-paper/account/set-balance',
    '/api/futures-paper/manual/open',
    '/api/futures-paper/manual/close',
    '/api/futures-paper/candidates/simulate',
    '/api/futures-paper/simulation/tick',
    '/api/futures-paper/auto-simulation',
  ];
  const cases = [
    [{ live_trading_enabled: true }, 'live_trading_is_not_allowed'],
    [{ broker_enabled: true }, 'broker_is_not_allowed'],
    [{ actions_allowed: true }, 'real_actions_are_not_allowed'],
    [{ can_place_orders: true }, 'real_orders_are_not_allowed'],
    [{ mode: 'live' }, 'mode_must_be_paper_only'],
  ];

  await withTestServer(async (baseUrl) => {
    for (const [payload, expectedError] of cases) {
      await assertBlocked(baseUrl, '/api/futures-paper/scanner/run-once', payload, expectedError);
    }
    for (const endpoint of retiredEndpoints) {
      await assertRetired(baseUrl, endpoint, {});
      await assertRetired(baseUrl, endpoint, { live_trading_enabled: true });
    }

    const injectedQuantity = await postJson(baseUrl, '/api/futures-paper/ibkr-paper-execution/shadow', {
      candidateId: 'candidate-server-known',
      quantity: 99,
    });
    assert.equal(injectedQuantity.status, 400);
    assert.equal(injectedQuantity.body.ok, false);
    assert.equal(injectedQuantity.body.error, 'client_supplied_broker_candidate_not_allowed');
    assert.equal(injectedQuantity.body.actualSubmit, false);

    const injectedNow = await postJson(baseUrl, '/api/futures-paper/ibkr-paper-execution/shadow', {
      candidateId: 'candidate-server-known',
      now: '1970-01-01T00:00:00.000Z',
    });
    assert.equal(injectedNow.status, 400);
    assert.equal(injectedNow.body.error, 'client_supplied_broker_candidate_not_allowed');

    const actualSubmit = await postJson(baseUrl, '/api/futures-paper/ibkr-paper-execution/shadow', {
      candidateId: 'candidate-server-known',
      actualSubmit: true,
    });
    assert.equal(actualSubmit.status, 403);
    assert.equal(actualSubmit.body.ok, false);
    assert.equal(actualSubmit.body.error, 'first_paper_order_requires_explicit_user_approval_not_in_shadow_route');
    assert.equal(actualSubmit.body.actualSubmit, false);
  });
}

main()
  .then(() => {
    console.log('futuresPaperApiSafety.test.js passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
