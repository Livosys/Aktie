#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

try {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
} catch (_) {
  // dotenv is a runtime dependency, but keep helper imports usable in tests.
}

const DEFAULT_BASE_URL = process.env.PRODUCTION_BASE_URL
  || process.env.TRADING_OS_BASE_URL
  || process.env.BASE_URL
  || `http://127.0.0.1:${process.env.PORT || 3001}`;

const DEFAULT_DIST_DIR = process.env.CLIENT_DIST_DIR || path.join(ROOT, 'client', 'dist');

const CRITICAL_ENDPOINTS = Object.freeze([
  { name: 'health', path: '/health', auth: false },
  { name: 'api_status', path: '/api/status' },
  { name: 'system_health', path: '/api/system/health' },
  { name: 'supervisor_overview', path: '/api/supervisor/overview' },
  { name: 'ib_connection_readiness', path: '/api/interactive-brokers/connection-readiness' },
  { name: 'ib_gateway_health', path: '/api/interactive-brokers/gateway-health' },
  { name: 'ib_paper_execution_status', path: '/api/interactive-brokers/paper-execution/status' },
  { name: 'futures_runtime', path: '/api/futures-paper/runtime' },
  { name: 'futures_market_data_status', path: '/api/futures-paper/market-data/status' },
  { name: 'futures_price_feed', path: '/api/futures-paper/price-feed' },
  { name: 'futures_ib_account', path: '/api/futures-paper/ib-account' },
  { name: 'paper_trading_status', path: '/api/paper-trading/status' },
  { name: 'ai_analyst_status', path: '/api/ai/analyst/status' },
  { name: 'pine_research_overview', path: '/api/pine-research/overview' },
  { name: 'batch_status', path: '/api/status/batches' },
  { name: 'replay_status', path: '/api/status/replay' },
]);

const IGNORED_SIMULATED_FALLBACK_PATH_PREFIXES = Object.freeze([
  '$.legacyInternalSimulation.',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    distDir: DEFAULT_DIST_DIR,
    timeoutMs: Number(process.env.RELEASE_VERIFY_TIMEOUT_MS || 15000),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url' && argv[i + 1]) {
      options.baseUrl = argv[i + 1];
      i += 1;
    } else if (arg === '--dist-dir' && argv[i + 1]) {
      options.distDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--timeout-ms' && argv[i + 1]) {
      options.timeoutMs = Number(argv[i + 1]);
      i += 1;
    }
  }
  return options;
}

function assetPathFromRef(ref) {
  const clean = String(ref || '').split('?')[0].split('#')[0];
  if (!clean) return null;
  if (clean.startsWith('/')) return clean.slice(1);
  return clean;
}

function collectHtmlAssetRefs(html) {
  const refs = new Set();
  const attrRe = /\b(?:src|href)=["']([^"']+)["']/g;
  let match;
  while ((match = attrRe.exec(html))) {
    const ref = assetPathFromRef(match[1]);
    if (ref && ref.startsWith('assets/')) refs.add(ref);
  }
  return [...refs];
}

function collectCssAssetRefs(css) {
  const refs = new Set();
  const urlRe = /url\(([^)]+)\)/g;
  let match;
  while ((match = urlRe.exec(css))) {
    const raw = String(match[1] || '').trim().replace(/^["']|["']$/g, '');
    if (!raw || raw.startsWith('data:') || /^[a-z]+:/i.test(raw)) continue;
    const ref = assetPathFromRef(raw);
    if (ref && ref.startsWith('assets/')) refs.add(ref);
  }
  return [...refs];
}

function collectJsAssetRefs(js) {
  const refs = new Set();
  const assetRe = /["'`](\/?assets\/[^"'`]+)["'`]/g;
  let match;
  while ((match = assetRe.exec(js))) {
    const ref = assetPathFromRef(match[1]);
    if (ref && ref.startsWith('assets/')) refs.add(ref);
  }
  return [...refs];
}

function verifyBuildAssets(distDir = DEFAULT_DIST_DIR) {
  const failures = [];
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return { ok: false, distDir, checked: [], failures: [{ code: 'missing_index_html', file: indexPath }] };
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const refs = collectHtmlAssetRefs(html);
  const checked = refs.slice();
  const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
  const cssRefs = refs.filter((ref) => ref.endsWith('.css'));
  if (!jsRefs.length) failures.push({ code: 'missing_js_asset_reference', file: indexPath });
  if (!cssRefs.length) failures.push({ code: 'missing_css_asset_reference', file: indexPath });

  const queued = [...refs];
  const seen = new Set(refs);
  for (let index = 0; index < queued.length; index += 1) {
    const ref = queued[index];
    const assetPath = path.join(distDir, ref);
    if (!fs.existsSync(assetPath)) {
      failures.push({ code: 'missing_asset', file: assetPath, ref });
      continue;
    }
    if (ref.endsWith('.css')) {
      const css = fs.readFileSync(assetPath, 'utf8');
      for (const cssRef of collectCssAssetRefs(css)) {
        checked.push(cssRef);
        const cssAssetPath = path.join(distDir, cssRef);
        if (!fs.existsSync(cssAssetPath)) {
          failures.push({ code: 'missing_css_asset', file: cssAssetPath, ref: cssRef, from: ref });
        }
      }
    }
    if (ref.endsWith('.js')) {
      const js = fs.readFileSync(assetPath, 'utf8');
      for (const jsRef of collectJsAssetRefs(js)) {
        if (!seen.has(jsRef)) {
          seen.add(jsRef);
          checked.push(jsRef);
          queued.push(jsRef);
        }
      }
    }
  }

  return { ok: failures.length === 0, distDir, checked, failures };
}

function scanJson(value, predicate, currentPath = '$', hits = []) {
  if (predicate(value, currentPath)) hits.push(currentPath);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanJson(entry, predicate, `${currentPath}[${index}]`, hits));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      scanJson(entry, predicate, `${currentPath}.${key}`, hits);
    }
  }
  return hits;
}

function findRuntimeFailed(payload) {
  const hits = [];
  function walk(value, currentPath = '$') {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${currentPath}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      const nextPath = `${currentPath}.${key}`;
      if (key === 'runtimeState' && String(entry).toUpperCase() === 'FAILED') {
        hits.push(nextPath);
      }
      walk(entry, nextPath);
    }
  }
  walk(payload);
  return hits;
}

function findSimulatedFallback(payload) {
  return scanJson(payload, (value) => value === 'simulated_fallback');
}

function findActiveSimulatedFallback(payload) {
  return findSimulatedFallback(payload)
    .filter((hit) => !IGNORED_SIMULATED_FALLBACK_PATH_PREFIXES.some((prefix) => hit.startsWith(prefix)));
}

function isConnectionReady(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (String(payload.runtimeState || '').toUpperCase() === 'READY') return true;
  if (String(payload.status || '').toUpperCase() === 'READY') return true;
  return payload.status === 'verified' && payload.sessionVerified === true;
}

async function fetchJson(baseUrl, endpoint, { cookie = '', timeoutMs = 15000 } = {}) {
  const url = new URL(endpoint.path || endpoint, baseUrl).toString();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          ...(cookie ? { cookie } : {}),
          connection: 'close',
        },
        signal: ctl.signal,
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_) {
        body = { nonJsonBody: text.slice(0, 500) };
      }
      return { status: res.status, ok: res.ok, body };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function login(baseUrl, timeoutMs = 15000) {
  const session = await fetchJson(baseUrl, { path: '/api/auth/session' }, { timeoutMs });
  if (session.ok && session.body?.authEnabled === false) return '';

  const username = process.env.TRADING_OS_ADMIN_USERNAME || process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!username || !password) {
    throw new Error('auth_credentials_missing');
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL('/api/auth/login', baseUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.authenticated !== true) {
      throw new Error(`auth_login_failed_http_${res.status}`);
    }
    return res.headers.get('set-cookie')?.split(';')[0] || '';
  } finally {
    clearTimeout(timer);
  }
}

function endpointFailure(name, pathName, code, detail = {}) {
  return { area: 'endpoint', endpoint: pathName, name, code, ...detail };
}

async function verifyEndpoints({ baseUrl, timeoutMs }) {
  const failures = [];
  const summaries = [];
  let cookie = '';
  try {
    cookie = await login(baseUrl, timeoutMs);
  } catch (error) {
    failures.push({ area: 'auth', code: error.message || 'auth_failed' });
    return { ok: false, failures, summaries };
  }

  for (const endpoint of CRITICAL_ENDPOINTS) {
    let result;
    try {
      result = await fetchJson(baseUrl, endpoint, {
        cookie: endpoint.auth === false ? '' : cookie,
        timeoutMs,
      });
    } catch (error) {
      failures.push(endpointFailure(endpoint.name, endpoint.path, 'request_failed', { error: error.name || error.message }));
      summaries.push({ name: endpoint.name, path: endpoint.path, error: error.name || error.message });
      continue;
    }

    const body = result.body;
    summaries.push({
      name: endpoint.name,
      path: endpoint.path,
      status: result.status,
      ok: result.ok,
      payloadOk: body?.ok ?? null,
      runtimeState: body?.runtimeState || body?.runtime?.runtimeState || null,
      source: body?.source || body?.feed?.source || null,
    });

    if (!result.ok) {
      failures.push(endpointFailure(endpoint.name, endpoint.path, 'http_error', { status: result.status }));
      continue;
    }
    if (body && body.ok === false) {
      failures.push(endpointFailure(endpoint.name, endpoint.path, 'payload_not_ok', { status: result.status, error: body.error || null }));
    }

    for (const hit of findRuntimeFailed(body)) {
      failures.push(endpointFailure(endpoint.name, endpoint.path, 'runtime_state_failed', { jsonPath: hit }));
    }
    for (const hit of findActiveSimulatedFallback(body)) {
      failures.push(endpointFailure(endpoint.name, endpoint.path, 'simulated_fallback_detected', { jsonPath: hit }));
    }
    if (endpoint.name === 'ib_connection_readiness' && !isConnectionReady(body)) {
      failures.push(endpointFailure(endpoint.name, endpoint.path, 'connection_readiness_not_ready', {
        status: body?.status || null,
        runtimeState: body?.runtimeState || null,
        blockedReason: body?.blockedReason || null,
      }));
    }
  }

  return { ok: failures.length === 0, failures, summaries };
}

async function run(options = parseArgs()) {
  const build = verifyBuildAssets(options.distDir);
  const endpoints = await verifyEndpoints(options);
  const failures = [
    ...build.failures.map((failure) => ({ area: 'build', ...failure })),
    ...endpoints.failures,
  ];
  return {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    build: {
      ok: build.ok,
      distDir: build.distDir,
      checkedAssets: build.checked,
    },
    endpoints: endpoints.summaries,
    failures,
  };
}

if (require.main === module) {
  run().then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  CRITICAL_ENDPOINTS,
  collectCssAssetRefs,
  collectHtmlAssetRefs,
  collectJsAssetRefs,
  findActiveSimulatedFallback,
  findRuntimeFailed,
  findSimulatedFallback,
  isConnectionReady,
  parseArgs,
  run,
  verifyBuildAssets,
};
