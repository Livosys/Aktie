'use strict';

let Redis = null;
try {
  Redis = require('ioredis');
} catch (_) {
  Redis = null;
}

const DEFAULT_URL = 'redis://127.0.0.1:6379';
const CONNECT_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS = 1000;
const DEFAULT_TTL_SECONDS = 60;
const MEMORY_MAX_KEYS = 500;

const memoryStore = new Map();
const subscribers = new Map();

let client = null;
let subscriberClient = null;
let connectionStarted = false;
let lastError = null;
let lastConnectedAt = null;
let lastPingAt = null;

function nowIso() {
  return new Date().toISOString();
}

function redisUrl() {
  return process.env.REDIS_URL || DEFAULT_URL;
}

function configured() {
  return !!Redis && String(process.env.REDIS_ENABLED || 'true').toLowerCase() !== 'false';
}

function setLastError(err) {
  if (!err) return;
  lastError = {
    message: err.message || String(err),
    at: nowIso(),
  };
}

function ensureClient() {
  if (!configured()) return null;
  if (client) return client;

  client = new Redis(redisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    retryStrategy(times) {
      return Math.min(times * 500, 5000);
    },
  });

  client.on('ready', () => {
    lastConnectedAt = nowIso();
    lastError = null;
  });
  client.on('error', setLastError);
  client.on('end', () => {
    if (!lastError) lastError = { message: 'Redis connection ended', at: nowIso() };
  });

  return client;
}

async function connect() {
  const c = ensureClient();
  if (!c) return false;
  if (c.status === 'ready') return true;
  if (connectionStarted && ['connecting', 'connect'].includes(c.status)) return false;
  connectionStarted = true;
  try {
    await c.connect();
    lastConnectedAt = nowIso();
    lastError = null;
    return true;
  } catch (err) {
    setLastError(err);
    return false;
  } finally {
    connectionStarted = false;
  }
}

function pruneMemoryStore() {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt && entry.expiresAt <= now) memoryStore.delete(key);
  }
  if (memoryStore.size <= MEMORY_MAX_KEYS) return;
  const overflow = memoryStore.size - MEMORY_MAX_KEYS;
  for (const key of Array.from(memoryStore.keys()).slice(0, overflow)) {
    memoryStore.delete(key);
  }
}

function memorySet(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  pruneMemoryStore();
  memoryStore.set(key, {
    value,
    updatedAt: nowIso(),
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

function memoryGet(key) {
  pruneMemoryStore();
  return memoryStore.get(key)?.value ?? null;
}

async function setJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  memorySet(key, value, ttlSeconds);
  const c = ensureClient();
  if (!c) return false;
  try {
    if (c.status !== 'ready') await connect();
    if (c.status !== 'ready') return false;
    const payload = JSON.stringify(value);
    if (ttlSeconds) await c.set(key, payload, 'EX', ttlSeconds);
    else await c.set(key, payload);
    return true;
  } catch (err) {
    setLastError(err);
    return false;
  }
}

async function getJson(key, fallback = null) {
  const c = ensureClient();
  if (c) {
    try {
      if (c.status !== 'ready') await connect();
      if (c.status === 'ready') {
        const raw = await c.get(key);
        if (raw == null) return memoryGet(key) ?? fallback;
        return JSON.parse(raw);
      }
    } catch (err) {
      setLastError(err);
    }
  }
  return memoryGet(key) ?? fallback;
}

async function publish(channel, payload) {
  const envelope = {
    timestamp: nowIso(),
    payload,
  };
  const listeners = subscribers.get(channel) || [];
  for (const listener of listeners) {
    try { listener(envelope.payload, envelope); } catch (err) { setLastError(err); }
  }

  const c = ensureClient();
  if (!c) return false;
  try {
    if (c.status !== 'ready') await connect();
    if (c.status !== 'ready') return false;
    await c.publish(channel, JSON.stringify(envelope));
    return true;
  } catch (err) {
    setLastError(err);
    return false;
  }
}

async function addStream(stream, payload, maxLen = 200) {
  const key = `stream:${stream}`;
  const current = memoryGet(key) || [];
  memorySet(key, [{ id: `mem-${Date.now()}`, ...payload }, ...current].slice(0, maxLen), 3600);

  const c = ensureClient();
  if (!c) return false;
  try {
    if (c.status !== 'ready') await connect();
    if (c.status !== 'ready') return false;
    await c.xadd(stream, 'MAXLEN', '~', maxLen, '*', 'json', JSON.stringify(payload));
    return true;
  } catch (err) {
    setLastError(err);
    return false;
  }
}

async function subscribe(channel, listener) {
  if (!subscribers.has(channel)) subscribers.set(channel, []);
  subscribers.get(channel).push(listener);

  if (!configured()) {
    return () => unsubscribeMemory(channel, listener);
  }

  try {
    if (!subscriberClient) {
      subscriberClient = new Redis(redisUrl(), {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        connectTimeout: CONNECT_TIMEOUT_MS,
        commandTimeout: COMMAND_TIMEOUT_MS,
      });
      subscriberClient.on('error', setLastError);
      subscriberClient.on('message', (receivedChannel, raw) => {
        const channelListeners = subscribers.get(receivedChannel) || [];
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = { payload: raw }; }
        for (const fn of channelListeners) {
          try { fn(parsed.payload, parsed); } catch (err) { setLastError(err); }
        }
      });
    }
    if (subscriberClient.status !== 'ready') await subscriberClient.connect();
    await subscriberClient.subscribe(channel);
  } catch (err) {
    setLastError(err);
  }

  return () => unsubscribeMemory(channel, listener);
}

function unsubscribeMemory(channel, listener) {
  const list = subscribers.get(channel) || [];
  subscribers.set(channel, list.filter((fn) => fn !== listener));
}

async function incrWithExpire(key, ttlSeconds) {
  const c = ensureClient();
  if (c) {
    try {
      if (c.status !== 'ready') await connect();
      if (c.status === 'ready') {
        const count = await c.incr(key);
        if (count === 1) await c.expire(key, ttlSeconds);
        return count;
      }
    } catch (err) {
      setLastError(err);
    }
  }
  // Memory fallback — not atomic but crash-safe
  pruneMemoryStore();
  const entry = memoryStore.get(key);
  const now = Date.now();
  if (entry && (!entry.expiresAt || entry.expiresAt > now)) {
    const next = (entry.value || 0) + 1;
    memoryStore.set(key, { value: next, updatedAt: nowIso(), expiresAt: entry.expiresAt });
    return next;
  }
  memoryStore.set(key, { value: 1, updatedAt: nowIso(), expiresAt: now + ttlSeconds * 1000 });
  return 1;
}

async function ping() {
  const c = ensureClient();
  if (!c) return false;
  try {
    if (c.status !== 'ready') await connect();
    if (c.status !== 'ready') return false;
    await c.ping();
    lastPingAt = nowIso();
    lastError = null;
    return true;
  } catch (err) {
    setLastError(err);
    return false;
  }
}

function status() {
  const c = client;
  return {
    ok: true,
    redisConfigured: configured(),
    redisAvailable: c?.status === 'ready',
    mode: c?.status === 'ready' ? 'redis' : 'fallback',
    urlConfigured: !!process.env.REDIS_URL,
    clientStatus: c?.status || (configured() ? 'not_connected' : 'disabled'),
    memoryFallbackKeys: memoryStore.size,
    lastConnectedAt,
    lastPingAt,
    lastError,
  };
}

async function close() {
  try { if (client) await client.quit(); } catch (_) {}
  try { if (subscriberClient) await subscriberClient.quit(); } catch (_) {}
}

module.exports = {
  connect,
  ping,
  status,
  setJson,
  getJson,
  incrWithExpire,
  publish,
  addStream,
  subscribe,
  close,
};
