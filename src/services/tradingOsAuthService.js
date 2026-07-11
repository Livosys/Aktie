'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_COOKIE_NAME = 'trading_os_session';
const DEFAULT_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const DEFAULT_AUDIT_FILE = path.resolve(__dirname, '../../data/auth/trading-os-audit.jsonl');
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

const sessions = new Map();
const loginFailures = new Map();

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function isAuthEnabled() {
  return envFlag('TRADING_OS_AUTH_ENABLED', true);
}

function getAdminUsername() {
  return String(process.env.TRADING_OS_ADMIN_USERNAME || process.env.DASHBOARD_USER || '').trim();
}

function getAdminPasswordHash() {
  return String(process.env.TRADING_OS_ADMIN_PASSWORD_HASH || '').trim();
}

function getSessionSecret() {
  return String(process.env.TRADING_OS_SESSION_SECRET || '').trim();
}

function getSessionMaxAgeMs() {
  const value = Number(process.env.TRADING_OS_SESSION_MAX_AGE_MS);
  if (Number.isFinite(value) && value >= 60_000) return Math.floor(value);
  return DEFAULT_SESSION_MAX_AGE_MS;
}

function getAuditFile() {
  return path.resolve(process.env.TRADING_OS_AUTH_AUDIT_FILE || DEFAULT_AUDIT_FILE);
}

function isConfigured() {
  return Boolean(getAdminUsername() && getAdminPasswordHash() && getSessionSecret());
}

function publicConfigStatus() {
  return {
    authEnabled: isAuthEnabled(),
    configured: isConfigured(),
    usernameConfigured: Boolean(getAdminUsername()),
    passwordHashConfigured: Boolean(getAdminPasswordHash()),
    sessionSecretConfigured: Boolean(getSessionSecret()),
    sessionMaxAgeMs: getSessionMaxAgeMs(),
    cookieName: SESSION_COOKIE_NAME,
  };
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password, options = {}) {
  const salt = options.salt ? Buffer.from(options.salt, 'base64url') : crypto.randomBytes(16);
  const params = {
    N: Number(options.N) || SCRYPT_PARAMS.N,
    r: Number(options.r) || SCRYPT_PARAMS.r,
    p: Number(options.p) || SCRYPT_PARAMS.p,
    keylen: Number(options.keylen) || SCRYPT_PARAMS.keylen,
  };
  const derived = crypto.scryptSync(String(password || ''), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$v1$${params.N}$${params.r}$${params.p}$${base64url(salt)}$${base64url(derived)}`;
}

function parsePasswordHash(hash) {
  const parts = String(hash || '').split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return null;
  const N = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  const salt = Buffer.from(parts[5], 'base64url');
  const expected = Buffer.from(parts[6], 'base64url');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt.length || !expected.length) return null;
  return { N, r, p, salt, expected };
}

function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a || ''));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b || ''));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left.length ? left : Buffer.from('x'), left.length ? left : Buffer.from('x'));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifyPasswordHash(password, hash) {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const derived = crypto.scryptSync(String(password || ''), parsed.salt, parsed.expected.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: 64 * 1024 * 1024,
  });
  return safeEqual(derived, parsed.expected);
}

function requestIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.ip || req?.socket?.remoteAddress || null;
}

function requestId(req) {
  if (req?.tradingOsRequestId) return req.tradingOsRequestId;
  const header = String(req?.headers?.['x-request-id'] || '').trim();
  if (header) return header.slice(0, 120);
  return crypto.randomUUID();
}

function auditEvent(action, details = {}) {
  const req = details.req || null;
  const event = {
    timestamp: new Date().toISOString(),
    action,
    username: details.username || details.user?.username || null,
    role: details.role || details.user?.role || null,
    targetStrategyId: details.targetStrategyId || null,
    result: details.result || null,
    requestId: details.requestId || requestId(req),
    ip: details.ip || requestIp(req),
    userAgent: details.userAgent || req?.headers?.['user-agent'] || null,
  };
  if (details.reason) event.reason = String(details.reason).slice(0, 160);
  try {
    const file = getAuditFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch (err) {
    console.warn('[TradingOSAuth] audit write failed:', err.message);
  }
  return event;
}

function throttleKey(username, ip) {
  return `${String(username || '').trim().toLowerCase()}|${ip || 'unknown'}`;
}

function getThrottleState(username, ip, now = Date.now()) {
  const key = throttleKey(username, ip);
  const current = loginFailures.get(key);
  if (!current || now - current.firstAt > LOGIN_WINDOW_MS) {
    return { key, count: 0, firstAt: now, lockedUntil: 0 };
  }
  return { key, ...current };
}

function recordLoginFailure(username, ip, now = Date.now()) {
  const state = getThrottleState(username, ip, now);
  const next = {
    count: state.count + 1,
    firstAt: state.firstAt || now,
    lockedUntil: state.count + 1 >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : state.lockedUntil || 0,
  };
  loginFailures.set(state.key, next);
  return next;
}

function clearLoginFailures(username, ip) {
  loginFailures.delete(throttleKey(username, ip));
}

function verifyCredentials({ username, password, req }) {
  const ip = requestIp(req);
  const now = Date.now();
  const state = getThrottleState(username, ip, now);
  if (state.lockedUntil && state.lockedUntil > now) {
    auditEvent('login_failure', { req, username, role: 'admin', result: 'throttled', reason: 'too_many_attempts' });
    return { ok: false, status: 429, error: 'too_many_login_attempts' };
  }

  if (!isConfigured()) {
    auditEvent('login_failure', { req, username, role: 'admin', result: 'auth_not_configured' });
    return { ok: false, status: 503, error: 'auth_not_configured' };
  }

  const expectedUsername = getAdminUsername();
  const userOk = safeEqual(String(username || '').trim(), expectedUsername);
  const passOk = verifyPasswordHash(password, getAdminPasswordHash());
  if (userOk && passOk) {
    clearLoginFailures(username, ip);
    return { ok: true, user: { username: expectedUsername, role: 'admin' } };
  }

  recordLoginFailure(username, ip, now);
  auditEvent('login_failure', { req, username, role: 'admin', result: 'invalid_credentials' });
  return { ok: false, status: 401, error: 'invalid_credentials' };
}

function signSessionId(sessionId) {
  const secret = getSessionSecret();
  return crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
}

function encodeSessionCookie(sessionId) {
  return `${sessionId}.${signSessionId(sessionId)}`;
}

function decodeSessionCookie(value) {
  const raw = String(value || '');
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const sessionId = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!sessionId || !signature) return null;
  if (!getSessionSecret()) return null;
  return safeEqual(signature, signSessionId(sessionId)) ? sessionId : null;
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index <= 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_) {
      cookies[key] = '';
    }
  });
  return cookies;
}

function cookieSecure(req) {
  const explicit = process.env.TRADING_OS_COOKIE_SECURE;
  if (explicit !== undefined) return envFlag('TRADING_OS_COOKIE_SECURE', true);
  if (process.env.NODE_ENV === 'production') return true;
  return String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (Number.isFinite(options.maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join('; ');
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) return res.setHeader('Set-Cookie', cookie);
  if (Array.isArray(existing)) return res.setHeader('Set-Cookie', [...existing, cookie]);
  return res.setHeader('Set-Cookie', [existing, cookie]);
}

function setSessionCookie(req, res, session) {
  appendSetCookie(res, serializeCookie(SESSION_COOKIE_NAME, encodeSessionCookie(session.id), {
    secure: cookieSecure(req),
    sameSite: process.env.TRADING_OS_COOKIE_SAMESITE || 'Lax',
    maxAgeSeconds: Math.floor((session.expiresAtMs - Date.now()) / 1000),
  }));
}

function clearSessionCookie(req, res) {
  appendSetCookie(res, serializeCookie(SESSION_COOKIE_NAME, '', {
    secure: cookieSecure(req),
    sameSite: process.env.TRADING_OS_COOKIE_SAMESITE || 'Lax',
    maxAgeSeconds: 0,
    expires: new Date(0),
  }));
}

function sessionIdFromRequest(req) {
  const cookies = parseCookies(req?.headers?.cookie || '');
  return decodeSessionCookie(cookies[SESSION_COOKIE_NAME]);
}

function getSession(req, options = {}) {
  if (!isAuthEnabled()) return null;
  const sessionId = sessionIdFromRequest(req);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAtMs <= now) {
    sessions.delete(sessionId);
    if (options.auditExpired !== false) {
      auditEvent('session_expired', { req, user: session.user, result: 'expired' });
    }
    return null;
  }
  session.lastSeenAt = new Date(now).toISOString();
  return session;
}

function createSession(req, res, user) {
  const existingSessionId = sessionIdFromRequest(req);
  if (existingSessionId) sessions.delete(existingSessionId);
  const now = Date.now();
  const session = {
    id: randomToken(32),
    csrfToken: randomToken(32),
    user: { username: user.username, role: user.role || 'admin' },
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + getSessionMaxAgeMs()).toISOString(),
    expiresAtMs: now + getSessionMaxAgeMs(),
  };
  sessions.set(session.id, session);
  setSessionCookie(req, res, session);
  auditEvent('login_success', { req, user: session.user, result: 'success' });
  return session;
}

function destroySession(req, res) {
  const session = getSession(req, { auditExpired: false });
  const sessionId = sessionIdFromRequest(req);
  if (sessionId) sessions.delete(sessionId);
  clearSessionCookie(req, res);
  if (session) auditEvent('logout', { req, user: session.user, result: 'success' });
  return Boolean(session);
}

function buildSessionPayload(req) {
  const session = getSession(req, { auditExpired: true });
  if (!session) return { authenticated: false, user: null };
  return {
    authenticated: true,
    user: session.user,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
  };
}

function unauthorized(res, error = 'authentication_required', status = 401) {
  return res.status(status).json({ ok: false, authenticated: false, error });
}

function requireAuthenticatedSession(req, res, next) {
  if (!isAuthEnabled()) return next();
  if (!isConfigured()) return res.status(503).json({ ok: false, error: 'auth_not_configured' });
  const session = getSession(req, { auditExpired: true });
  if (!session) return unauthorized(res);
  req.tradingOsSession = session;
  req.tradingOsUser = session.user;
  return next();
}

function requireAdminSession(req, res, next) {
  return requireAuthenticatedSession(req, res, () => {
    if (req.tradingOsUser?.role !== 'admin') return unauthorized(res, 'admin_required', 403);
    return next();
  });
}

function csrfTokenFromRequest(req) {
  return req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || req.headers['csrf-token'] || '';
}

function verifyCsrf(req) {
  if (!isAuthEnabled()) return { ok: true };
  const session = req.tradingOsSession || getSession(req, { auditExpired: true });
  if (!session) return { ok: false, status: 401, error: 'authentication_required' };
  const token = csrfTokenFromRequest(req);
  if (!token || !safeEqual(String(token), session.csrfToken)) {
    return { ok: false, status: 403, error: 'csrf_token_invalid' };
  }
  req.tradingOsSession = session;
  req.tradingOsUser = session.user;
  return { ok: true, session };
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) return next();
  const result = verifyCsrf(req);
  if (!result.ok) return res.status(result.status || 403).json({ ok: false, error: result.error || 'csrf_token_invalid' });
  return next();
}

function _resetForTests() {
  sessions.clear();
  loginFailures.clear();
}

module.exports = {
  SESSION_COOKIE_NAME,
  hashPassword,
  verifyPasswordHash,
  verifyCredentials,
  createSession,
  destroySession,
  getSession,
  buildSessionPayload,
  requireAuthenticatedSession,
  requireAdminSession,
  requireCsrf,
  verifyCsrf,
  auditEvent,
  isAuthEnabled,
  isConfigured,
  publicConfigStatus,
  requestId,
  _internal: {
    sessions,
    loginFailures,
    parseCookies,
    decodeSessionCookie,
    encodeSessionCookie,
    serializeCookie,
    safeEqual,
    _resetForTests,
  },
};
