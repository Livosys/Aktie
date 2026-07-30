'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const tradingOsAuthService = require('../services/tradingOsAuthService');

const ROOT = path.resolve(__dirname, '../..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-enabled-strategy-routes-'));
const ENABLED_STORE = path.join(TMP_DIR, 'enabled-strategies.json');
const APPROVAL_STORE = path.join(TMP_DIR, 'strategy-approvals.json');
const ENTRY_EVENTS = path.join(TMP_DIR, 'events.jsonl');
const ENTRY_TRADES = path.join(TMP_DIR, 'trades.jsonl');
const AUTH_AUDIT = path.join(TMP_DIR, 'auth-audit.jsonl');
const ENTRY_FIXTURE_AT = new Date(Date.now() - 60_000).toISOString();

process.env.PAPER_ENABLED_STRATEGIES_FILE = ENABLED_STORE;
process.env.PAPER_STRATEGY_APPROVALS_FILE = APPROVAL_STORE;
process.env.PAPER_ENTRY_CONTRACT_EVENTS_FILE = ENTRY_EVENTS;
process.env.PAPER_ENTRY_CONTRACT_TRADES_FILE = ENTRY_TRADES;

fs.writeFileSync(APPROVAL_STORE, JSON.stringify({
  schemaVersion: 1,
  strategies: {},
  selectedByFamily: {},
  updatedAt: '2026-07-11T00:00:00.000Z',
}, null, 2));
fs.writeFileSync(ENTRY_EVENTS, `${JSON.stringify({
  timestamp: ENTRY_FIXTURE_AT,
  type: 'GATE_BLOCKED',
  strategyId: 'narrow_state_expansion_long',
  symbol: 'BTCUSDT',
  signalSubtype: 'NARROW_BULL_ENTRY',
  status: 'watch',
  blockedReason: 'paper_entry_watch_only',
  entryContractVersion: 'paper_entry_contract_v1',
})}\n`);
fs.writeFileSync(ENTRY_TRADES, `${JSON.stringify({
  entryTime: ENTRY_FIXTURE_AT,
  tradeId: 'pt_route_test',
  strategyId: 'narrow_state_expansion_long',
  symbol: 'BTCUSDT',
  result: 'TIMEOUT',
  mfePct: 0,
  maePct: -0.1,
})}\n`);

const paperEnabledStrategiesService = require('../services/paperEnabledStrategiesService');
paperEnabledStrategiesService._internal.writeStoreAtomic(
  paperEnabledStrategiesService.buildInitialStore({
    now: '2026-07-11T17:00:00.000Z',
    source: 'manual_initial_migration',
  }),
  new Date('2026-07-11T17:00:00.000Z'),
);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

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
  assert.equal(body.user.role, 'admin');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /trading_os_session=/);
  assert.ok(body.csrfToken);
  return { cookie, csrfToken: body.csrfToken };
}

function safety(payload) {
  assert.equal(payload.mode, 'paper_only');
  assert.equal(payload.actions_allowed, false);
  assert.equal(payload.can_place_orders, false);
  assert.equal(payload.live_trading_enabled, false);
  assert.equal(payload.broker_enabled, false);
}

async function main() {
  const approvalBeforeHash = sha256(APPROVAL_STORE);
  const approvalBeforeMtime = fs.statSync(APPROVAL_STORE).mtimeMs;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const user = 'operator';
  const pass = 'secret';
  const passHash = tradingOsAuthService.hashPassword(pass);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TRADING_OS_AUTH_ENABLED: 'true',
      TRADING_OS_ADMIN_USERNAME: user,
      TRADING_OS_ADMIN_PASSWORD_HASH: passHash,
      TRADING_OS_SESSION_SECRET: 'route-test-session-secret-with-enough-entropy',
      TRADING_OS_AUTH_AUDIT_FILE: AUTH_AUDIT,
      TRADING_OS_COOKIE_SECURE: 'false',
      PAPER_ENABLED_STRATEGIES_FILE: ENABLED_STORE,
      PAPER_STRATEGY_APPROVALS_FILE: APPROVAL_STORE,
      PAPER_ENTRY_CONTRACT_EVENTS_FILE: ENTRY_EVENTS,
      PAPER_ENTRY_CONTRACT_TRADES_FILE: ENTRY_TRADES,
      PAPER_ENTRY_CONTRACTS_ENABLED: 'true',
      PAPER_MANUAL_STRATEGY_LIST_ENABLED: 'false',
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

    const unauthList = await get(baseUrl, '/api/paper-trading/enabled-strategies');
    assert.equal(unauthList.status, 401, 'strategy list is protected by Trading OS session auth');

    const session = await login(baseUrl, user, pass);
    const authHeaders = { cookie: session.cookie };
    const mutationHeaders = { cookie: session.cookie, 'x-csrf-token': session.csrfToken };

    const list = await get(baseUrl, '/api/paper-trading/enabled-strategies', authHeaders);
    assert.equal(list.status, 200);
    assert.equal(list.body.summary.total, 33);
    assert.equal(list.body.summary.enabled, 3);
    // 6 katalogstrategier har kontrakt sedan narrow_breakout och
    // vwap_failed_breakout_short fick sina (väg A, generiska confirmations).
    assert.equal(list.body.summary.entryContractsReady, 6);
    assert.equal(list.body.runtimeGateMode, 'legacy');
    assert.equal(list.body.manualListControlsRuntime, false);
    assert.equal(list.body.entryContractsEnabled, true);
    safety(list.body);
    assert.deepEqual(
      list.body.strategies.filter((row) => row.enabledForPaper).map((row) => row.strategyId).sort(),
      ['ema_pullback_continuation', 'narrow_state_expansion_long', 'vwap_volume_breakout_long'],
    );
    const narrowRow = list.body.strategies.find((row) => row.strategyId === 'narrow_state_expansion_long');
    assert.equal(narrowRow.entryContractStatus, 'ready');
    assert.deepEqual(narrowRow.entryContract.allowedSubtypes, ['NARROW_BULL_ENTRY']);
    assert.equal(narrowRow.entryContractBlockCount, 1);
    assert.equal(narrowRow.commonEntryContractBlocker.reasonCode, 'paper_entry_watch_only');

    const contracts = await get(baseUrl, '/api/paper-trading/entry-contracts', authHeaders);
    assert.equal(contracts.status, 200);
    assert.equal(contracts.body.summary.totalStrategies, 33);
    // 6 av katalogens 33 har kontrakt sedan narrow_breakout och
    // vwap_failed_breakout_short fick sina (väg A, generiska confirmations).
    assert.equal(contracts.body.summary.ready, 6);
    assert.equal(contracts.body.summary.missing, 27);
    assert.equal(contracts.body.entryContractsEnabled, true);
    safety(contracts.body);

    const detail = await get(baseUrl, '/api/paper-trading/enabled-strategies/ema_pullback_continuation', authHeaders);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, 'ok');
    assert.equal(detail.body.strategy.strategyId, 'ema_pullback_continuation');
    assert.equal(detail.body.strategy.enabledForPaper, true);
    safety(detail.body);

    const history = await get(baseUrl, '/api/paper-trading/enabled-strategies/history', authHeaders);
    assert.equal(history.status, 200);
    assert.equal(history.body.status, 'ok');
    assert.equal(history.body.total, 33);
    assert.ok(Array.isArray(history.body.history), '/history route is registered before /:strategyId');
    safety(history.body);

    const unknownDetail = await get(baseUrl, '/api/paper-trading/enabled-strategies/not_a_strategy', authHeaders);
    assert.equal(unknownDetail.status, 404);
    assert.equal(unknownDetail.body.error, 'unknown_canonical_strategy');
    safety(unknownDetail.body);

    for (const endpoint of [
      '/api/paper-trading/enabled-strategies/vwap_volume_breakout_long/disable',
      '/api/paper-trading/enabled-strategies/vwap_volume_breakout_long/enable',
    ]) {
      const unauth = await post(baseUrl, endpoint);
      assert.equal(unauth.status, 401, `${endpoint} requires auth`);
      assert.equal(unauth.headers.get('www-authenticate'), null);
    }

    const noCsrf = await post(baseUrl, '/api/paper-trading/enabled-strategies/vwap_volume_breakout_long/disable', authHeaders);
    assert.equal(noCsrf.status, 403, 'mutations require CSRF token');
    assert.equal(noCsrf.body.error, 'csrf_token_invalid');

    const unknownMutation = await post(baseUrl, '/api/paper-trading/enabled-strategies/not_a_strategy/enable', mutationHeaders);
    assert.equal(unknownMutation.status, 404);
    assert.equal(unknownMutation.body.reason, 'unknown_canonical_strategy');
    safety(unknownMutation.body);

    const disable = await post(baseUrl, '/api/paper-trading/enabled-strategies/vwap_volume_breakout_long/disable', mutationHeaders);
    assert.equal(disable.status, 200);
    assert.equal(disable.body.ok, true);
    assert.equal(disable.body.changed, true);
    assert.equal(disable.body.enabled, false);
    safety(disable.body);

    const disableAgain = await post(baseUrl, '/api/paper-trading/enabled-strategies/vwap_volume_breakout_long/disable', mutationHeaders);
    assert.equal(disableAgain.status, 200);
    assert.equal(disableAgain.body.changed, false);

    const enable = await post(baseUrl, '/api/paper-trading/enabled-strategies/vwap_volume_breakout_long/enable', mutationHeaders);
    assert.equal(enable.status, 200);
    assert.equal(enable.body.ok, true);
    assert.equal(enable.body.changed, true);
    assert.equal(enable.body.enabled, true);

    const afterHistory = await get(baseUrl, '/api/paper-trading/enabled-strategies/history?limit=10', authHeaders);
    assert.equal(afterHistory.body.total, 35, 'history changes only for real disable + enable');

    const audit = fs.readFileSync(AUTH_AUDIT, 'utf8');
    assert.match(audit, /login_success/);
    assert.match(audit, /strategy_disable/);
    assert.match(audit, /strategy_enable/);
    assert.doesNotMatch(audit, /secret|route-test-session-secret/);

    assert.equal(sha256(APPROVAL_STORE), approvalBeforeHash, 'approval store hash unchanged by enabled-list mutations');
    assert.equal(fs.statSync(APPROVAL_STORE).mtimeMs, approvalBeforeMtime, 'approval store mtime unchanged by enabled-list mutations');

    console.log('paperEnabledStrategiesRoutes.test.js passed');
  } catch (err) {
    err.message = `${err.message}\nserver output:\n${output.slice(-3000)}`;
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
