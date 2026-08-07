'use strict';

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function firstText(...values) {
  for (const value of values) {
    const out = text(value);
    if (out) return out;
  }
  return null;
}

function nested(row = {}, key) {
  const containers = [
    row,
    row?.metadata,
    row?.details,
    row?.payload,
    row?.context,
    row?.candidate,
    row?.intent,
    row?.order,
    row?.execution,
    row?.trade,
  ];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
  }
  return null;
}

function explicitLifecycleIdFrom(row = {}) {
  return firstText(
    nested(row, 'lifecycleId'),
    nested(row, 'lifecycle_id'),
  );
}

function identityFrom(row = {}) {
  const candidateId = firstText(
    nested(row, 'candidateId'),
    nested(row, 'candidate_id'),
    nested(row, 'sourceCandidateId'),
  );
  const signalId = firstText(
    nested(row, 'signalId'),
    nested(row, 'signal_id'),
    nested(row, 'originalSignalId'),
    nested(row, 'original_signal_id'),
  );
  const executionId = firstText(
    nested(row, 'executionId'),
    nested(row, 'execution_id'),
    nested(row, 'executionAttemptId'),
    nested(row, 'execution_attempt_id'),
  );
  const idempotencyKey = firstText(
    nested(row, 'idempotencyKey'),
    nested(row, 'idempotency_key'),
  );
  const intentId = firstText(
    nested(row, 'intentId'),
    nested(row, 'intent_id'),
  );
  const tradeId = firstText(
    nested(row, 'tradeId'),
    nested(row, 'trade_id'),
  );
  const lifecycleId = explicitLifecycleIdFrom(row);

  return {
    lifecycleId,
    candidateId,
    signalId,
    intentId,
    executionId,
    idempotencyKey,
    tradeId,
  };
}

function compact(identity = {}) {
  return Object.fromEntries(
    Object.entries(identity)
      .map(([key, value]) => [key, text(value)])
      .filter(([, value]) => value),
  );
}

function mergeIdentity(...sources) {
  return compact(
    sources.reduce((acc, source) => {
      const next = identityFrom(source);
      const explicitLifecycleId = explicitLifecycleIdFrom(source);
      return {
        lifecycleId: explicitLifecycleId || acc.lifecycleId || next.lifecycleId,
        candidateId: acc.candidateId || next.candidateId,
        signalId: acc.signalId || next.signalId,
        intentId: acc.intentId || next.intentId,
        executionId: acc.executionId || next.executionId,
        idempotencyKey: acc.idempotencyKey || next.idempotencyKey,
        tradeId: acc.tradeId || next.tradeId,
      };
    }, {}),
  );
}

module.exports = {
  text,
  firstText,
  identityFrom,
  compact,
  mergeIdentity,
};
