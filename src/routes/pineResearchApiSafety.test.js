'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
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

async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  return { status: response.status, body: await response.json() };
}

async function main() {
  const apiSource = fs.readFileSync(path.resolve(__dirname, 'api.js'), 'utf8');
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');

  assert.doesNotMatch(apiSource, /\/pine-research\/(?:activate|approve|ready|paper-forward|futures-forward|broker|order|execute)/);
  assert.doesNotMatch(serverSource, /pine-research/, 'server.js must not add public auth exceptions for pine-research mutations');

  await withTestServer(async (baseUrl) => {
    const config = await getJson(baseUrl, '/api/pine-research/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.safety.mode, 'paper_only');
    assert.equal(config.body.safety.actions_allowed, false);
    assert.equal(config.body.safety.can_place_orders, false);
    assert.equal(config.body.safety.live_trading_enabled, false);
    assert.equal(config.body.safety.broker_enabled, false);

    const unsafe = await postJson(baseUrl, '/api/pine-research/test-runs/preview', {
      pineVersionId: 'missing',
      live_trading_enabled: true,
    });
    assert.equal(unsafe.status, 400);
    assert.equal(unsafe.body.safety.mode, 'paper_only');
    assert.equal(unsafe.body.safety.actions_allowed, false);

    const brokerIntent = await postJson(baseUrl, '/api/pine-research/candidates', {
      baseStrategyId: 'test',
      hypothesis: 'Use broker execution',
    });
    assert.equal(brokerIntent.status, 400);
  });
}

main()
  .then(() => console.log('pineResearchApiSafety.test.js passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
