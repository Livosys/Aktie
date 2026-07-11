'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-strategy-auth-route-'));
const TMP_STORE = path.join(TMP_DIR, 'strategy-approvals.json');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function authHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

async function waitForHealth(baseUrl, child) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastErr || new Error('server health timeout');
}

async function readJson(res) {
  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('application/json') ? res.json() : res.text();
}

async function get(baseUrl, endpoint, headers = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, { headers });
  return { status: res.status, body: await readJson(res), headers: res.headers };
}

async function post(baseUrl, endpoint, headers = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
      broker_enabled: false,
      mode: 'paper_only',
    }),
  });
  return { status: res.status, body: await readJson(res), headers: res.headers };
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const user = 'operator';
  const pass = 'secret';
  const strategyId = 'vwap_volume_breakout_long';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_USER: user,
      DASHBOARD_PASSWORD: pass,
      PAPER_STRATEGY_APPROVALS_FILE: TMP_STORE,
      ENABLE_STOCK_SCANNER: 'false',
      ENABLE_CRYPTO_SCANNER: 'false',
      ENABLE_AUTO_MACHINE_SCHEDULER: 'false',
      ENABLE_NARROW_AUTOPILOT_SCHEDULER: 'false',
      ENABLE_BATCH_AUTOPILOT_SCHEDULER: 'false',
      ENABLE_REPLAY_AUTOPILOT_SCHEDULER: 'false',
      ENABLE_DAILY_INTELLIGENCE_SCHEDULER: 'false',
      ENABLE_PAPER_TRADING_INIT: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForHealth(baseUrl, child);

    const mutationEndpoints = [
      `/api/paper-trading/strategies/${strategyId}/approve`,
      `/api/paper-trading/strategies/${strategyId}/pause`,
      `/api/paper-trading/strategies/${strategyId}/resume`,
      `/api/paper-trading/strategies/${strategyId}/remove`,
    ];

    for (const endpoint of mutationEndpoints) {
      const unauth = await post(baseUrl, endpoint);
      assert.equal(unauth.status, 401, `${endpoint} must require dashboard auth`);
      assert.equal(unauth.headers.get('www-authenticate'), 'Basic realm="Scanner Dashboard"');
    }

    const wrongAuth = await post(baseUrl, mutationEndpoints[0], { authorization: authHeader(user, 'wrong-secret') });
    assert.equal(wrongAuth.status, 401, 'wrong dashboard auth must be rejected');
    assert.equal(wrongAuth.headers.get('www-authenticate'), 'Basic realm="Scanner Dashboard"');

    const list = await get(baseUrl, '/api/paper-trading/strategies');
    assert.equal(list.status, 200, 'read-only strategy list remains available without auth');
    assert.equal(list.body.status, 'ok');
    assert.equal(list.body.mode, 'paper_only');

    const detail = await get(baseUrl, `/api/paper-trading/strategies/${strategyId}`);
    assert.equal(detail.status, 200, 'read-only strategy detail remains available without auth');
    assert.equal(detail.body.status, 'ok');
    assert.equal(detail.body.strategy.strategyId, strategyId);

    const headers = { authorization: authHeader(user, pass) };
    const approve = await post(baseUrl, mutationEndpoints[0], headers);
    assert.equal(approve.status, 200);
    assert.equal(approve.body.ok, true);
    assert.equal(approve.body.status, 'approved');
    assert.equal(approve.body.mode, 'paper_only');
    assert.equal(approve.body.actions_allowed, false);
    assert.equal(approve.body.can_place_orders, false);
    assert.equal(approve.body.live_trading_enabled, false);
    assert.equal(approve.body.broker_enabled, false);

    const pause = await post(baseUrl, mutationEndpoints[1], headers);
    assert.equal(pause.status, 200);
    assert.equal(pause.body.ok, true);
    assert.equal(pause.body.status, 'paused');

    const resume = await post(baseUrl, mutationEndpoints[2], headers);
    assert.equal(resume.status, 200);
    assert.equal(resume.body.ok, true);
    assert.equal(resume.body.status, 'approved');

    const remove = await post(baseUrl, mutationEndpoints[3], headers);
    assert.equal(remove.status, 200);
    assert.equal(remove.body.ok, true);
    assert.equal(remove.body.status, 'removed');
    assert.equal(remove.body.mode, 'paper_only');
    assert.equal(remove.body.can_place_orders, false);

    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(serverSource, /app\.use\('\/api', apiLimiter, requireAuthForMutations, apiRouter\)/);
    assert.doesNotMatch(serverSource, /paper-trading\/strategies[^]*return next\(\)/, 'paper strategy mutation endpoints are not made public');
    assert.doesNotMatch(serverSource, /futures-paper\/strategies[^]*return next\(\)/, 'futures strategy mutation endpoints remain behind mutation auth');

    console.log('paperStrategyMutationAuth.test.js passed');
  } catch (err) {
    err.message = `${err.message}\nserver output:\n${output.slice(-2000)}`;
    throw err;
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
