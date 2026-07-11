'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auth = require('./tradingOsAuthService');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-os-auth-'));
const auditFile = path.join(tmpDir, 'audit.jsonl');

const originalEnv = { ...process.env };

function req(overrides = {}) {
  return {
    headers: {
      'user-agent': 'node-test',
      'x-forwarded-for': '203.0.113.10',
      ...(overrides.headers || {}),
    },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function res() {
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    set(name, value) { headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    headers,
  };
}

function cookieFrom(response) {
  const header = response.getHeader('Set-Cookie');
  return Array.isArray(header) ? header[0] : header;
}

try {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'production',
    TRADING_OS_AUTH_ENABLED: 'true',
    TRADING_OS_ADMIN_USERNAME: 'admin',
    TRADING_OS_SESSION_SECRET: 'test-session-secret-with-enough-entropy',
    TRADING_OS_SESSION_MAX_AGE_MS: '3600000',
    TRADING_OS_AUTH_AUDIT_FILE: auditFile,
  };
  process.env.TRADING_OS_ADMIN_PASSWORD_HASH = auth.hashPassword('correct horse battery staple', {
    salt: Buffer.from('0123456789abcdef').toString('base64url'),
  });
  auth._internal._resetForTests();

  assert.equal(auth.isConfigured(), true);
  assert.equal(auth.verifyPasswordHash('correct horse battery staple', process.env.TRADING_OS_ADMIN_PASSWORD_HASH), true);
  assert.equal(auth.verifyPasswordHash('wrong', process.env.TRADING_OS_ADMIN_PASSWORD_HASH), false);

  const badUser = auth.verifyCredentials({ username: 'other', password: 'correct horse battery staple', req: req() });
  const badPass = auth.verifyCredentials({ username: 'admin', password: 'wrong', req: req() });
  assert.equal(badUser.status, 401);
  assert.equal(badPass.status, 401);
  assert.equal(badUser.error, badPass.error);

  auth._internal._resetForTests();
  const login = auth.verifyCredentials({ username: 'admin', password: 'correct horse battery staple', req: req() });
  assert.equal(login.ok, true);

  const response = res();
  const session = auth.createSession(req(), response, login.user);
  const cookie = cookieFrom(response);
  assert.match(cookie, /trading_os_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /correct horse|battery|staple|test-session-secret/);

  const authedReq = req({ headers: { cookie } });
  const payload = auth.buildSessionPayload(authedReq);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.user.username, 'admin');
  assert.equal(payload.user.role, 'admin');
  assert.equal(payload.csrfToken, session.csrfToken);

  assert.equal(auth.verifyCsrf(req({ headers: { cookie, 'x-csrf-token': session.csrfToken } })).ok, true);
  assert.equal(auth.verifyCsrf(req({ headers: { cookie, 'x-csrf-token': 'bad-token' } })).status, 403);

  const response2 = res();
  const session2 = auth.createSession(authedReq, response2, login.user);
  assert.notEqual(session2.id, session.id, 'login regenerates session id');
  assert.equal(auth.getSession(authedReq), null, 'old session is invalidated on regeneration');

  const logoutRes = res();
  assert.equal(auth.destroySession(req({ headers: { cookie: cookieFrom(response2) } }), logoutRes), true);
  assert.match(cookieFrom(logoutRes), /Max-Age=0/);

  auth._internal._resetForTests();
  for (let i = 0; i < 5; i += 1) {
    auth.verifyCredentials({ username: 'admin', password: `wrong-${i}`, req: req() });
  }
  const throttled = auth.verifyCredentials({ username: 'admin', password: 'wrong-later', req: req() });
  assert.equal(throttled.status, 429);

  const audit = fs.readFileSync(auditFile, 'utf8');
  assert.match(audit, /login_success/);
  assert.match(audit, /login_failure/);
  assert.match(audit, /logout/);
  assert.doesNotMatch(audit, /correct horse|wrong-later|test-session-secret|TRADING_OS_SESSION_SECRET/);

  console.log('tradingOsAuthService.test.js passed');
} finally {
  process.env = originalEnv;
  auth._internal._resetForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
