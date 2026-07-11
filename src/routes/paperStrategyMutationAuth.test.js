'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const tradingOsAuthService = require('../services/tradingOsAuthService');

const ROOT = path.resolve(__dirname, '../..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-strategy-auth-route-'));
const TMP_STORE = path.join(TMP_DIR, 'strategy-approvals.json');
const AUTH_AUDIT = path.join(TMP_DIR, 'auth-audit.jsonl');

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

async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await readJson(res);
  assert.equal(res.status, 200);
  assert.equal(body.authenticated, true);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /trading_os_session=/);
  assert.ok(body.csrfToken);
  return { cookie, csrfToken: body.csrfToken };
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const user = 'operator';
  const pass = 'secret';
  const passHash = tradingOsAuthService.hashPassword(pass);
  const strategyId = 'vwap_volume_breakout_long';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TRADING_OS_AUTH_ENABLED: 'true',
      TRADING_OS_ADMIN_USERNAME: user,
      TRADING_OS_ADMIN_PASSWORD_HASH: passHash,
      TRADING_OS_SESSION_SECRET: 'paper-strategy-route-session-secret',
      TRADING_OS_AUTH_AUDIT_FILE: AUTH_AUDIT,
      TRADING_OS_COOKIE_SECURE: 'false',
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
      assert.equal(unauth.headers.get('www-authenticate'), null);
    }

    const wrongLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: user, password: 'wrong-secret' }),
    });
    assert.equal(wrongLogin.status, 401, 'wrong dashboard auth must be rejected');

    const unauthList = await get(baseUrl, '/api/paper-trading/strategies');
    assert.equal(unauthList.status, 401, 'read-only strategy list requires Trading OS session');

    const session = await login(baseUrl, user, pass);
    const authHeaders = { cookie: session.cookie };
    const mutationHeaders = { cookie: session.cookie, 'x-csrf-token': session.csrfToken };

    const list = await get(baseUrl, '/api/paper-trading/strategies', authHeaders);
    assert.equal(list.status, 200, 'read-only strategy list is available with session');
    assert.equal(list.body.status, 'ok');
    assert.equal(list.body.mode, 'paper_only');

    const detail = await get(baseUrl, `/api/paper-trading/strategies/${strategyId}`, authHeaders);
    assert.equal(detail.status, 200, 'read-only strategy detail is available with session');
    assert.equal(detail.body.status, 'ok');
    assert.equal(detail.body.strategy.strategyId, strategyId);

    const missingCsrf = await post(baseUrl, mutationEndpoints[0], authHeaders);
    assert.equal(missingCsrf.status, 403, 'mutation with session still requires CSRF');

    const approve = await post(baseUrl, mutationEndpoints[0], mutationHeaders);
    assert.equal(approve.status, 200);
    assert.equal(approve.body.ok, true);
    assert.equal(approve.body.status, 'approved');
    assert.equal(approve.body.mode, 'paper_only');
    assert.equal(approve.body.actions_allowed, false);
    assert.equal(approve.body.can_place_orders, false);
    assert.equal(approve.body.live_trading_enabled, false);
    assert.equal(approve.body.broker_enabled, false);

    const pause = await post(baseUrl, mutationEndpoints[1], mutationHeaders);
    assert.equal(pause.status, 200);
    assert.equal(pause.body.ok, true);
    assert.equal(pause.body.status, 'paused');

    const resume = await post(baseUrl, mutationEndpoints[2], mutationHeaders);
    assert.equal(resume.status, 200);
    assert.equal(resume.body.ok, true);
    assert.equal(resume.body.status, 'approved');

    const remove = await post(baseUrl, mutationEndpoints[3], mutationHeaders);
    assert.equal(remove.status, 200);
    assert.equal(remove.body.ok, true);
    assert.equal(remove.body.status, 'removed');
    assert.equal(remove.body.mode, 'paper_only');
    assert.equal(remove.body.can_place_orders, false);

    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(serverSource, /app\.use\('\/api', apiLimiter, requireTradingOsApiAuth, requireTradingOsCsrf, apiRouter\)/);
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
