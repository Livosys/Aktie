'use strict';

const PROVIDERS = {
  alpaca: {
    provider: 'alpaca',
    label: 'Alpaca',
    group: 'stocks',
    configured: () => !!(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY),
    enabled: () => process.env.ALPACA_ENABLED !== 'false',
  },
  binance: {
    provider: 'binance',
    label: 'Binance',
    group: 'crypto',
    configured: () => true,
    enabled: () => true,
  },
};

const state = {};
const lastLogged = new Map();

for (const key of Object.keys(PROVIDERS)) {
  state[key] = {
    provider: key,
    ok: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorType: null,
    lastErrorMessage: null,
    lastStatusCode: null,
    requestCount: 0,
    errorCount: 0,
  };
}

function classifyProviderError(err, provider = 'provider') {
  const status = err?.response?.status || err?.statusCode || err?.status || null;
  const code = err?.code || null;
  const raw = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Provider request failed';
  const msg = sanitizeMessage(raw);
  const lower = `${msg} ${code || ''}`.toLowerCase();

  let type = 'provider_unavailable';
  if (status === 401 || status === 403 || lower.includes('invalid api') || lower.includes('forbidden') || lower.includes('unauthorized')) {
    type = 'invalid_api_key';
  } else if (status === 429 || lower.includes('rate limit') || lower.includes('too many')) {
    type = 'rate_limited';
  } else if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || lower.includes('timeout') || lower.includes('timed out')) {
    type = 'timeout';
  } else if (code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || lower.includes('network')) {
    type = 'network_error';
  } else if (lower.includes('parse') || lower.includes('malformed') || lower.includes('unexpected token')) {
    type = 'malformed_response';
  }

  return {
    provider,
    type,
    statusCode: status,
    code,
    safeMessage: msg,
    retryable: ['rate_limited', 'timeout', 'network_error', 'provider_unavailable'].includes(type),
  };
}

function sanitizeMessage(value) {
  return String(value || 'Provider request failed')
    .replace(/APCA-[A-Z-]+:\s*[^,\s]+/gi, 'APCA-HEADER:[redacted]')
    .replace(/key[_-]?id[=:]\s*[^,\s]+/gi, 'key_id=[redacted]')
    .replace(/secret[_-]?key[=:]\s*[^,\s]+/gi, 'secret_key=[redacted]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .slice(0, 240);
}

function recordProviderSuccess(provider) {
  const s = state[provider];
  if (!s) return;
  s.ok = true;
  s.lastSuccessAt = new Date().toISOString();
  s.requestCount += 1;
}

function recordProviderError(provider, err, context = {}) {
  const s = state[provider];
  if (!s) return classifyProviderError(err, provider);

  const classified = classifyProviderError(err, provider);
  s.ok = false;
  s.lastErrorAt = new Date().toISOString();
  s.lastErrorType = classified.type;
  s.lastErrorMessage = classified.safeMessage;
  s.lastStatusCode = classified.statusCode;
  s.requestCount += 1;
  s.errorCount += 1;

  logProviderError(provider, classified, context);
  return classified;
}

function logProviderError(provider, classified, context = {}) {
  const key = `${provider}:${classified.type}:${context.symbol || 'global'}`;
  const now = Date.now();
  const last = lastLogged.get(key) || 0;
  if (now - last < 60_000) return;
  lastLogged.set(key, now);

  const parts = [
    `[Provider] ${provider} ${classified.type}`,
    context.symbol ? `symbol=${context.symbol}` : null,
    classified.statusCode ? `http=${classified.statusCode}` : null,
    `message=${classified.safeMessage}`,
  ].filter(Boolean);
  console.warn(parts.join(' '));
}

async function withProviderRetry(provider, fn, options = {}) {
  const attempts = Math.max(1, options.attempts || 2);
  const baseDelayMs = Math.max(0, options.baseDelayMs || 350);
  const context = options.context || {};
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();
      recordProviderSuccess(provider);
      return result;
    } catch (err) {
      lastErr = err;
      const classified = classifyProviderError(err, provider);
      if (attempt >= attempts || !classified.retryable) {
        recordProviderError(provider, err, context);
        throw err;
      }
      await delay(baseDelayMs * attempt);
    }
  }

  recordProviderError(provider, lastErr, context);
  throw lastErr;
}

function buildProviderStatus() {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([key, cfg]) => {
    const s = state[key];
    return [key, {
      provider: cfg.provider,
      label: cfg.label,
      group: cfg.group,
      enabled: cfg.enabled(),
      configured: cfg.configured(),
      ok: s.ok,
      lastSuccessAt: s.lastSuccessAt,
      lastErrorAt: s.lastErrorAt,
      lastErrorType: s.lastErrorType,
      lastErrorMessage: s.lastErrorMessage,
      lastStatusCode: s.lastStatusCode,
      requestCount: s.requestCount,
      errorCount: s.errorCount,
    }];
  }));
}

function providerErrorSv(error) {
  const type = error?.type || error?.lastErrorType || null;
  if (type === 'invalid_api_key') return 'API-nyckel för aktier saknas eller är ogiltig.';
  if (type === 'rate_limited') return 'Rate limit uppnådd hos aktieleverantören.';
  if (type === 'timeout') return 'Aktieleverantören svarar långsamt.';
  if (type === 'network_error') return 'Aktieleverantören kan inte nås just nu.';
  if (type === 'malformed_response') return 'Aktieleverantören skickade ett oväntat svar.';
  if (type === 'provider_unavailable') return 'Aktiedata saknas just nu.';
  return 'Aktiedata saknas just nu.';
}

function minutesSince(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 60000));
}

function secondsSince(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function isUsMarketOpenNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function latestMarketTimestamp(rows, fallback = null) {
  const timestamps = rows
    .map((r) => r?.latest2mTimestamp || r?.latestTimestamp || r?.candleTs || r?.timestamp)
    .filter(Boolean)
    .sort();
  return timestamps[timestamps.length - 1] || fallback || null;
}

function buildFeedStatus({ group, provider, scannerStatus, results, staleMinutes, marketAware = false }) {
  const rows = Array.isArray(results) ? results : [];
  const lastUpdates = rows.map((r) => r?.lastUpdate).filter(Boolean).sort();
  const lastScanUpdated = lastUpdates[lastUpdates.length - 1] || scannerStatus?.lastScan || null;
  const latestTimestamp = marketAware
    ? latestMarketTimestamp(rows, lastScanUpdated)
    : lastScanUpdated;
  const lastUpdated = latestTimestamp || lastScanUpdated;
  const ageMinutes = minutesSince(lastUpdated);
  const ageSeconds = secondsSince(lastUpdated);
  const marketOpen = marketAware ? isUsMarketOpenNow() : true;
  const stale = ageMinutes !== null && ageMinutes > staleMinutes && marketOpen;
  const providerState = buildProviderStatus()[provider] || null;
  const errorRows = rows.filter((r) => String(r?.note || '').startsWith('Error:')).length;
  const latestProviderError = providerState?.lastErrorType ? {
    type: providerState.lastErrorType,
    message: providerState.lastErrorMessage,
    messageSv: providerErrorSv(providerState),
    at: providerState.lastErrorAt,
    statusCode: providerState.lastStatusCode,
  } : null;

  let status = 'BROKEN';
  let messageSv = group === 'stocks' ? 'Aktiedata saknas just nu.' : 'Data saknas just nu.';

  if (!providerState?.enabled || !providerState?.configured) {
    status = 'DISABLED';
    messageSv = group === 'stocks'
      ? 'API-nyckel för aktier saknas eller är ogiltig.'
      : 'Dataleverantören är inte konfigurerad.';
  } else if (stale) {
    status = 'STALE';
    messageSv = group === 'stocks'
      ? 'Aktiedata är gammal — kontrollera provider/scanner.'
      : 'Senaste scan är för gammal.';
  } else if (errorRows > 0) {
    status = 'WARNING';
    messageSv = latestProviderError?.messageSv || (group === 'stocks' ? 'Aktiedata saknas just nu.' : 'Providerfel i dataflödet.');
  } else if (marketAware && !marketOpen && rows.length > 0) {
    status = 'MARKET_CLOSED';
    messageSv = 'Marknaden stängd — senaste aktiedata från senaste handelspass.';
  } else if (rows.length > 0) {
    status = 'ON';
    messageSv = group === 'stocks' ? 'Aktiedata flödar.' : 'Dataflöde aktivt.';
  }

  return {
    group,
    provider,
    configured: providerState?.configured ?? true,
    enabled: providerState?.enabled ?? true,
    scannerRunning: !!scannerStatus?.scanning,
    lastScan: scannerStatus?.lastScan || null,
    lastUpdated,
    latestTimestamp,
    ageSeconds,
    ageMinutes,
    stale,
    staleAfterMinutes: staleMinutes,
    marketOpen,
    count: rows.length,
    errorRows,
    latestProviderError,
    messageSv,
    status,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildFeedStatus,
  buildProviderStatus,
  classifyProviderError,
  recordProviderError,
  recordProviderSuccess,
  withProviderRetry,
  providerErrorSv,
};
