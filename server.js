'use strict';
require('dotenv').config();
console.log('[Server] IBKR_PAPER_EXECUTION_ENABLED at startup:', process.env.IBKR_PAPER_EXECUTION_ENABLED);
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const { startScheduler } = require('./src/scanner/scheduler');
const { startCryptoScheduler } = require('./src/scanner/cryptoScheduler');
const { startAutoMachineScheduler } = require('./src/jobs/autoMachineScheduler');
const { startNarrowAutopilotScheduler } = require('./src/jobs/narrowAutopilotScheduler');
const { startBatchAutopilotScheduler } = require('./src/jobs/batchAutopilotScheduler');
const { startReplayAutopilotScheduler } = require('./src/jobs/replayAutopilotScheduler');
const { startReplayScheduler } = require('./src/jobs/replayScheduler');
const { startFuturesAutonomousScheduler } = require('./src/jobs/futuresAutonomousScheduler');
const apiRouter = require('./src/routes/api');
const { initOnStartup: initPaperTrading } = require('./src/paperTrading/paperTradingAgent');
const { buildProviderStatus } = require('./src/providerStatus');
const redisService = require('./src/services/redisService');
const dailyIntelligencePipeline = require('./src/services/dailyIntelligencePipelineService');
const tradingOsAuthService = require('./src/services/tradingOsAuthService');

const app = express();
const PORT = process.env.PORT || 3001;

function envEnabled(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return String(raw).toLowerCase() !== 'false';
}

const ENABLE_STOCK_SCANNER = envEnabled('ENABLE_STOCK_SCANNER', true);
const ENABLE_CRYPTO_SCANNER = envEnabled('ENABLE_CRYPTO_SCANNER', true);
const ENABLE_AUTO_MACHINE_SCHEDULER = envEnabled('ENABLE_AUTO_MACHINE_SCHEDULER', true);
const ENABLE_NARROW_AUTOPILOT_SCHEDULER = envEnabled('ENABLE_NARROW_AUTOPILOT_SCHEDULER', true);
const ENABLE_BATCH_AUTOPILOT_SCHEDULER = envEnabled('ENABLE_BATCH_AUTOPILOT_SCHEDULER', true);
const ENABLE_REPLAY_AUTOPILOT_SCHEDULER = envEnabled('ENABLE_REPLAY_AUTOPILOT_SCHEDULER', true);
// AI Factory-cykeln. Se src/jobs/replayScheduler.js — flaggan styr numera hela
// kedjan (hjärna → evolution → schemaläggning → replay → bibliotek), inte bara
// köskrivning. Paper_only hela vägen; replay körs i barnprocess.
const ENABLE_REPLAY_SCHEDULER = envEnabled('ENABLE_REPLAY_SCHEDULER', true);
const ENABLE_DAILY_INTELLIGENCE_SCHEDULER = envEnabled('ENABLE_DAILY_INTELLIGENCE_SCHEDULER', true);
const ENABLE_PAPER_TRADING_INIT = envEnabled('ENABLE_PAPER_TRADING_INIT', true);
// Autonomous IBKR-paper futures driver — OFF by default; must be explicitly opted in.
const ENABLE_FUTURES_AUTONOMOUS_SCHEDULER = envEnabled('ENABLE_FUTURES_AUTONOMOUS_SCHEDULER', false);
app.set('trust proxy', 'loopback');

function logStartupError(component, err) {
  const detail = err && err.stack ? err.stack : (err && err.message ? err.message : err);
  console.error(`[Server] ${component} startup failed:`, detail);
}

function startComponent(component, startFn) {
  try {
    return startFn();
  } catch (err) {
    logStartupError(component, err);
    return null;
  }
}

function startAsyncComponent(component, startFn, onSuccess) {
  try {
    return Promise.resolve(startFn())
      .then((result) => {
        if (onSuccess) onSuccess(result);
        return result;
      })
      .catch((err) => {
        logStartupError(component, err);
        return null;
      });
  } catch (err) {
    logStartupError(component, err);
    return Promise.resolve(null);
  }
}

// ── Basic Auth middleware ─────────────────────────────────────────────────────

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  // Always run timingSafeEqual to prevent timing leaks; pad shorter buf
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf); // dummy op to normalize timing
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function basicAuth(req, res, next) {
  const DASHBOARD_USER = process.env.DASHBOARD_USER;
  const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

  if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
    // Auth not configured — block access rather than leave it open
    return res.status(503).json({ error: 'Dashboard auth not configured in .env' });
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Scanner Dashboard"');
    return res.status(401).send('Autentisering krävs');
  }

  let reqUser = '';
  let reqPass = '';
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) throw new Error('no colon');
    reqUser = decoded.slice(0, colon);
    reqPass = decoded.slice(colon + 1);
  } catch (_) {
    res.set('WWW-Authenticate', 'Basic realm="Scanner Dashboard"');
    return res.status(401).send('Ogiltigt format');
  }

  const userOk = safeCompare(reqUser, DASHBOARD_USER);
  const passOk = safeCompare(reqPass, DASHBOARD_PASSWORD);

  if (userOk && passOk) return next();

  res.set('WWW-Authenticate', 'Basic realm="Scanner Dashboard"');
  return res.status(401).send('Felaktigt användarnamn eller lösenord');
}

function legacyRequireAuthForMutations(req, res, next) {
  const path = String(req.path || '');
  if (path.startsWith('/tradingview/webhook')) {
    return next();
  }
  // Paper-only manual risk-review resume. Route/service enforces paper-only safety.
  if (req.method === 'POST' && path === '/paper-trading/risk-review/resume') {
    return next();
  }
  if (path === '/strategies/test-queue/add' || /^\/strategies\/test-queue\/[^/]+\/cancel$/.test(path)) {
    return next();
  }
  // Paper-only allowlist approve/reject — same UI-exposure model as the
  // test-queue actions above. These endpoints are SAFETY-locked (paper_only and
  // reject any live/order/broker intent in the body), so exempting them from
  // dashboard auth never enables real trading, orders, broker or risk changes.
  if (path === '/automation/approvals/approve' || path === '/automation/approvals/reject') {
    return next();
  }
  // Batch/replay paper-candidate creation is also paper-only research and only
  // appends to the candidate log. It cannot trade or touch allowlist state.
  if (path === '/optimization/batch-replay-paper-candidates/create') {
    return next();
  }
  // Replay Intelligence sessions are isolated paper-only test runs
  // (replay_mode:true, live_trading_disabled:true). Create/run/pause/stop only
  // simulate historical candles into an in-memory/file session — they never
  // place orders, touch a broker, the allowlist, risk config or the scheduler.
  // Same UI-exposure + paper-only model as the research endpoints above.
  if (req.method === 'POST'
    && (path === '/replay/sessions' || /^\/replay\/sessions\/[^/]+\/(run|pause|stop)$/.test(path))) {
    return next();
  }
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  return basicAuth(req, res, next);
}

function isPublicApiPath(req) {
  const pathName = String(req.path || '');
  return pathName.startsWith('/tradingview/webhook');
}

function requireTradingOsApiAuth(req, res, next) {
  if (!tradingOsAuthService.isAuthEnabled()) {
    return legacyRequireAuthForMutations(req, res, next);
  }
  if (isPublicApiPath(req)) return next();
  return tradingOsAuthService.requireAdminSession(req, res, next);
}

function requireTradingOsCsrf(req, res, next) {
  if (!tradingOsAuthService.isAuthEnabled()) return next();
  if (isPublicApiPath(req)) return next();
  return tradingOsAuthService.requireCsrf(req, res, next);
}

// ── App setup ─────────────────────────────────────────────────────────────────

// CORS — restrict to known origins; localhost variants allowed for local dev
const CORS_ALLOWED = new Set([
  'https://aktier.livosys.se',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3001',
]);
app.use(cors({
  origin(origin, cb) {
    // No origin = server-to-server or same-origin — allow
    if (!origin || CORS_ALLOWED.has(origin)) return cb(null, true);
    cb(new Error(`CORS: origin not allowed — ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.tradingOsRequestId = tradingOsAuthService.requestId(req);
  res.set('X-Request-Id', req.tradingOsRequestId);
  next();
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Too many requests, please try again later',
  },
});

// /health is open — does not expose secrets
app.get('/health', (req, res) => {
  const alpacaConfigured =
    !!process.env.ALPACA_API_KEY_ID && !!process.env.ALPACA_API_SECRET_KEY;
  res.json({
    ok: true,
    service: 'nasdaq-2m-scanner',
    time: new Date().toISOString(),
    alpacaConfigured,
    feed: process.env.ALPACA_DATA_FEED || 'iex',
    env: process.env.NODE_ENV || 'development',
    providers: buildProviderStatus(),
    redis: redisService.status(),
  });
});

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'too_many_login_attempts',
  },
});

app.get('/api/auth/session', apiLimiter, (req, res) => {
  if (!tradingOsAuthService.isAuthEnabled()) {
    return res.json({
      ok: true,
      authEnabled: false,
      authenticated: true,
      user: { username: 'auth_disabled', role: 'admin' },
      csrfToken: null,
      expiresAt: null,
    });
  }
  res.json({
    ok: true,
    authEnabled: true,
    ...tradingOsAuthService.buildSessionPayload(req),
  });
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  if (!tradingOsAuthService.isAuthEnabled()) {
    return res.json({
      ok: true,
      authEnabled: false,
      authenticated: true,
      user: { username: 'auth_disabled', role: 'admin' },
      csrfToken: null,
      expiresAt: null,
    });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const result = tradingOsAuthService.verifyCredentials({ username, password, req });
  if (!result.ok) {
    const status = result.status || 401;
    const error = status === 429 ? 'too_many_login_attempts' : (status === 503 ? 'auth_not_configured' : 'invalid_credentials');
    return res.status(status).json({
      ok: false,
      authenticated: false,
      error,
      message: error === 'invalid_credentials' ? 'Felaktigt användarnamn eller lösenord.' : undefined,
    });
  }
  const session = tradingOsAuthService.createSession(req, res, result.user);
  res.json({
    ok: true,
    authEnabled: true,
    authenticated: true,
    user: session.user,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
  });
});

app.post('/api/auth/logout', apiLimiter, (req, res) => {
  if (!tradingOsAuthService.isAuthEnabled()) {
    return res.json({ ok: true, authEnabled: false, authenticated: false });
  }
  const session = tradingOsAuthService.getSession(req, { auditExpired: true });
  if (session) {
    const csrf = tradingOsAuthService.verifyCsrf(req);
    if (!csrf.ok) {
      return res.status(csrf.status || 403).json({ ok: false, error: csrf.error || 'csrf_token_invalid' });
    }
  }
  tradingOsAuthService.destroySession(req, res);
  res.json({ ok: true, authEnabled: true, authenticated: false });
});

// Trading OS API routes require a server-side admin session when
// TRADING_OS_AUTH_ENABLED is active. Mutations also require CSRF.
app.use('/api', apiLimiter, requireTradingOsApiAuth, requireTradingOsCsrf, apiRouter);
app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Server] nasdaq-2m-scanner running on port ${PORT} (bound to 127.0.0.1)`);
  setInterval(() => {
    const m = process.memoryUsage();
    console.log(`[Memory] heap=${Math.round(m.heapUsed / 1024 / 1024)}MB rss=${Math.round(m.rss / 1024 / 1024)}MB ext=${Math.round(m.external / 1024 / 1024)}MB`);
  }, 5 * 60 * 1000);
  if (ENABLE_STOCK_SCANNER) {
    startComponent('Stock scanner', startScheduler);
  } else {
    console.log('[Server] Stock scanner disabled via ENABLE_STOCK_SCANNER=false');
  }
  if (ENABLE_CRYPTO_SCANNER) {
    console.log('[Server] Crypto scanner enabled for paper/test mode only');
    startComponent('Crypto scanner', startCryptoScheduler);
  } else {
    console.log('[Server] Crypto scanner disabled via ENABLE_CRYPTO_SCANNER=false');
  }
  if (ENABLE_AUTO_MACHINE_SCHEDULER) startComponent('Auto Machine scheduler', startAutoMachineScheduler);
  else console.log('[Server] Auto Machine scheduler disabled via ENABLE_AUTO_MACHINE_SCHEDULER=false');
  if (ENABLE_NARROW_AUTOPILOT_SCHEDULER) startComponent('Narrow autopilot scheduler', startNarrowAutopilotScheduler);
  else console.log('[Server] Narrow autopilot scheduler disabled via ENABLE_NARROW_AUTOPILOT_SCHEDULER=false');
  if (ENABLE_BATCH_AUTOPILOT_SCHEDULER) startComponent('Batch autopilot scheduler', startBatchAutopilotScheduler);
  else console.log('[Server] Batch autopilot scheduler disabled via ENABLE_BATCH_AUTOPILOT_SCHEDULER=false');
  if (ENABLE_REPLAY_AUTOPILOT_SCHEDULER) startComponent('Replay autopilot scheduler', startReplayAutopilotScheduler);
  else console.log('[Server] Replay autopilot scheduler disabled via ENABLE_REPLAY_AUTOPILOT_SCHEDULER=false');
  if (ENABLE_REPLAY_SCHEDULER) startComponent('AI Factory cycle', startReplayScheduler);
  else console.log('[Server] AI Factory cycle disabled via ENABLE_REPLAY_SCHEDULER=false');
  if (ENABLE_DAILY_INTELLIGENCE_SCHEDULER) startComponent('Daily intelligence scheduler', () => dailyIntelligencePipeline.startScheduler());
  else console.log('[Server] Daily intelligence scheduler disabled via ENABLE_DAILY_INTELLIGENCE_SCHEDULER=false');
  if (ENABLE_PAPER_TRADING_INIT) startComponent('Paper trading init', initPaperTrading);
  else console.log('[Server] Paper trading init disabled via ENABLE_PAPER_TRADING_INIT=false');
  // Read-only IB futures-datalager (FUTURES_DATA_LAYER.md). Master-flagga
  // IB_FUTURES_DATA_ENABLED=false → helt inert (ingen IB-anslutning skapas).
  {
    const futuresMarketDataService = require('./src/services/futuresMarketDataService');
    if (futuresMarketDataService.defaultFuturesMarketDataService.isEnabled()) {
      startAsyncComponent(
        'IB futures data layer',
        () => futuresMarketDataService.defaultFuturesMarketDataService.start(),
        (result) => console.log(`[IBFuturesData] start: ${result.ok ? 'ok' : result.error}`),
      );
    } else {
      console.log('[Server] IB futures data layer disabled via IB_FUTURES_DATA_ENABLED=false');
    }
  }
  {
    const ibPaperExecutionOrchestratorService = require('./src/services/ibPaperExecutionOrchestratorService');
    startAsyncComponent(
      'IB paper execution runtime',
      () => ibPaperExecutionOrchestratorService.defaultIbPaperExecutionOrchestratorService.startRuntime(),
      (result) => {
        const state = result?.connectionAttempt?.state || result?.connectionAttempt?.error || result?.error || 'unknown';
        console.log(`[IBPaperExecutionRuntime] start: ${result.ok ? 'ok' : state}`);
      },
    );
  }
  // Autonomous futures driver — starts only when explicitly enabled. Thin wrapper
  // that drives the existing IBKR-paper pipeline (scanner -> shadow execution)
  // during CME hours; all safety gates remain in the underlying services.
  if (ENABLE_FUTURES_AUTONOMOUS_SCHEDULER) startComponent('Futures autonomous scheduler', startFuturesAutonomousScheduler);
  else console.log('[Server] Futures autonomous scheduler disabled via ENABLE_FUTURES_AUTONOMOUS_SCHEDULER=false');
  startAsyncComponent(
    'Redis',
    () => redisService.connect(),
    (connected) => console.log(`[Redis] ${connected ? 'connected' : 'fallback mode'} (${redisService.status().clientStatus})`),
  );

  // ── Förvärm Market DNA-katalogen ──────────────────────────────────────────
  //
  // Katalogen läser en bar-serie per (rot, handelsdag) och kostar ~13 sekunder
  // synkron CPU första gången. Den är cachad per dygn efteråt, så kostnaden
  // betalas exakt en gång per process — men om den betalas av det FÖRSTA
  // anropet står event-loopen still i 13 sekunder mitt i ett användarbesök.
  //
  // Den läggs därför här, efter att servern börjat lyssna men innan trafiken
  // hittat hit. Read-only: bygger bara upp cachen.
  setTimeout(() => {
    const startedAt = Date.now();
    try {
      const marketIntelligence = require('./src/services/market/marketIntelligenceService');
      const catalog = marketIntelligence.buildMarketDnaCatalog();
      console.log(`[MarketDNA] catalog warmed — ${catalog.periods.length} periods in ${Date.now() - startedAt}ms`);
    } catch (err) {
      console.warn(`[MarketDNA] catalog warm-up failed: ${err.message}`);
    }
  }, 2000).unref?.();
});
