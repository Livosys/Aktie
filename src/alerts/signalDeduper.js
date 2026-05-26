'use strict';

const sentByKey = new Map();
const lastSignatureBySymbol = new Map();

function scoreBucket(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 90) return '90-100';
  if (n >= 80) return '80-89';
  if (n >= 70) return '70-79';
  return 'below-70';
}

function dedupKey(signal) {
  return [
    signal.symbol || 'unknown',
    signal.direction || 'neutral',
    signal.status || 'unknown',
    scoreBucket(signal.score),
  ].join('|');
}

function signature(signal) {
  return [
    signal.symbol || 'unknown',
    signal.direction || 'neutral',
    signal.status || 'unknown',
  ].join('|');
}

function parseCooldownMinutes(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

function shouldSend(signal, now = Date.now(), cooldownMinutes = 15) {
  if (!signal?.symbol) return { ok: false, reason: 'missing_symbol' };

  const key = dedupKey(signal);
  const sig = signature(signal);
  const cooldownMs = parseCooldownMinutes(cooldownMinutes) * 60 * 1000;
  const lastSentAt = sentByKey.get(key);

  if (lastSentAt && now - lastSentAt < cooldownMs) {
    return { ok: false, reason: 'cooldown', key };
  }

  const lastSignature = lastSignatureBySymbol.get(signal.symbol);
  if (lastSignature === sig) {
    return { ok: false, reason: 'same_signal', key };
  }

  return { ok: true, key, signature: sig };
}

function markSent(signal, now = Date.now()) {
  const key = dedupKey(signal);
  sentByKey.set(key, now);
  lastSignatureBySymbol.set(signal.symbol, signature(signal));
  return key;
}

function reset() {
  sentByKey.clear();
  lastSignatureBySymbol.clear();
}

module.exports = {
  dedupKey,
  markSent,
  reset,
  scoreBucket,
  shouldSend,
};
