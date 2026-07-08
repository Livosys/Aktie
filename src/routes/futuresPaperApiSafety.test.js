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

async function assertBlocked(baseUrl, path, payload, expectedError) {
  const result = await postJson(baseUrl, path, payload);
  assert.equal(result.status, 400, `${path} should reject ${JSON.stringify(payload)}`);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, expectedError);
  assert.equal(result.body.mode, 'paper_only');
  assert.equal(result.body.live_trading_enabled, false);
  assert.equal(result.body.broker_enabled, false);
  assert.equal(result.body.actions_allowed, false);
  assert.equal(result.body.can_place_orders, false);
}

async function main() {
  const guardedEndpoints = [
    '/api/futures-paper/scanner/run-once',
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
    for (const endpoint of guardedEndpoints) {
      for (const [payload, expectedError] of cases) {
        await assertBlocked(baseUrl, endpoint, payload, expectedError);
      }
    }
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
