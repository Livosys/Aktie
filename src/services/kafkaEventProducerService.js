'use strict';

const crypto = require('crypto');

let KafkaCtor = null;
try {
  ({ Kafka: KafkaCtor } = require('kafkajs'));
} catch (_) {
  KafkaCtor = null;
}

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
});

const DEFAULTS = Object.freeze({
  enabled: false,
  brokers: ['localhost:9092'],
  clientId: 'trading-os-v2',
  topic: 'trading.events',
});

const CONNECT_TIMEOUT_MS = 2500;
const SEND_TIMEOUT_MS = 2500;
const FAILURE_COOLDOWN_MS = 60_000;

let producer = null;
let connectPromise = null;
let lastError = null;
let lastPublishAt = null;
let lastAttemptAt = null;
let disabledUntil = 0;

function nowIso() {
  return new Date().toISOString();
}

function envEnabled() {
  return String(process.env.EVENT_KAFKA_ENABLED || 'false').toLowerCase() === 'true';
}

function envBrokers() {
  const raw = String(process.env.KAFKA_BROKERS || DEFAULTS.brokers.join(','));
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function envClientId() {
  return String(process.env.KAFKA_CLIENT_ID || DEFAULTS.clientId).trim() || DEFAULTS.clientId;
}

function envTopic() {
  return String(process.env.KAFKA_TOPIC_EVENTS || DEFAULTS.topic).trim() || DEFAULTS.topic;
}

function isConfigured() {
  return Boolean(KafkaCtor && envBrokers().length > 0 && envClientId() && envTopic());
}

function isEnabled() {
  return envEnabled();
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timeoutId.unref === 'function') timeoutId.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function createProducer() {
  if (!KafkaCtor) {
    throw new Error('kafkajs_not_installed');
  }
  const kafka = new KafkaCtor({
    clientId: envClientId(),
    brokers: envBrokers(),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: SEND_TIMEOUT_MS,
    retry: {
      retries: 0,
      initialRetryTime: 100,
      factor: 1.5,
      multiplier: 1.5,
      maxRetryTime: 1000,
    },
  });
  producer = kafka.producer({
    allowAutoTopicCreation: false,
  });
  return producer;
}

async function safeDisconnect() {
  if (!producer) return;
  try {
    await producer.disconnect();
  } catch (_) {
    // Best-effort cleanup only.
  } finally {
    producer = null;
    connectPromise = null;
  }
}

async function ensureConnected() {
  if (!producer) createProducer();
  if (!connectPromise) {
    connectPromise = producer.connect().finally(() => {
      connectPromise = null;
    });
  }
  await withTimeout(connectPromise, CONNECT_TIMEOUT_MS, 'kafka connect');
}

function normalizeEventForKafka(event = {}) {
  return {
    ...event,
    kafka_published_at: nowIso(),
    kafka_event_id: crypto.randomUUID ? crypto.randomUUID() : undefined,
  };
}

async function publishEvent(event = {}) {
  lastAttemptAt = nowIso();

  if (!isEnabled()) {
    return { skipped: true, reason: 'disabled', ...SAFETY };
  }
  if (!isConfigured()) {
    lastError = KafkaCtor ? 'kafka_not_configured' : 'kafkajs_not_installed';
    return { skipped: true, reason: 'not_configured', error: lastError, ...SAFETY };
  }
  if (Date.now() < disabledUntil) {
    return { skipped: true, reason: 'cooldown', error: lastError, ...SAFETY };
  }

  try {
    await ensureConnected();
    const message = JSON.stringify(normalizeEventForKafka(event));
    await withTimeout(
      producer.send({
        topic: envTopic(),
        messages: [
          {
            key: String(event?.symbol || event?.event_type || 'event'),
            value: message,
            timestamp: String(Date.parse(event?.timestamp || nowIso()) || Date.now()),
          },
        ],
      }),
      SEND_TIMEOUT_MS,
      'kafka publish',
    );
    lastPublishAt = nowIso();
    lastError = null;
    return { ok: true, published: true, topic: envTopic(), ...SAFETY };
  } catch (err) {
    lastError = err?.message || String(err);
    disabledUntil = Date.now() + FAILURE_COOLDOWN_MS;
    await safeDisconnect();
    console.warn('[kafka-event] publish failed:', lastError);
    return { ok: false, skipped: false, error: lastError, ...SAFETY };
  }
}

function getStatus() {
  return {
    kafka_enabled: isEnabled(),
    kafka_configured: isConfigured(),
    kafka_last_error: lastError,
    kafka_last_publish_at: lastPublishAt,
    kafka_last_attempt_at: lastAttemptAt,
    kafka_disabled_until: disabledUntil > Date.now() ? new Date(disabledUntil).toISOString() : null,
    kafka_client_id: envClientId(),
    kafka_topic: envTopic(),
    kafka_brokers: envBrokers(),
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  isEnabled,
  isConfigured,
  getStatus,
  publishEvent,
};
