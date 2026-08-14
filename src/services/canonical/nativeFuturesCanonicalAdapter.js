'use strict';

// Phase 6 only: convert a native futures strategy decision into the Phase 1
// canonical signal contract. This module is intentionally not wired anywhere.

const {
  createNativeFuturesSignal,
  validateNativeFuturesSignal,
  isNativeFuturesProductionSignal,
  SAFETY: CONTRACT_SAFETY,
} = require('./nativeFuturesSignalContract');

const SOURCE = 'native_futures_canonical_adapter';
const SIGNAL_DECISION = 'SIGNAL';
const IGNORED_DECISIONS = new Set(['NO_SIGNAL', 'BLOCKED']);

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: SOURCE,
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function upper(value) {
  const text = safeString(value);
  return text ? text.toUpperCase() : null;
}

function lower(value) {
  const text = safeString(value);
  return text ? text.toLowerCase() : null;
}

function compact(parts) {
  return parts
    .map((part) => safeString(part))
    .filter(Boolean)
    .join(':')
    .replace(/[^A-Za-z0-9:_-]+/g, '_');
}

function snapshotFrom(options = {}) {
  return options.marketSnapshot || options.snapshot || {};
}

function contractFrom(decision = {}, snapshot = {}, options = {}) {
  return decision.contract || options.contract || snapshot.contract || null;
}

function signalTimestampFrom(decision = {}, snapshot = {}, options = {}) {
  return safeString(
    decision.signalTimestamp ||
    options.signalTimestamp ||
    snapshot.latestCandle?.timestamp ||
    decision.marketSnapshotTimestamp ||
    snapshot.timestamp
  );
}

function strategyNameFrom(decision = {}) {
  return safeString(decision.strategyName || decision.strategy?.name || decision.strategyId);
}

function signalIdFrom(decision = {}, snapshot = {}, options = {}) {
  const explicit = safeString(decision.signalId || options.signalId);
  if (explicit) return explicit;
  const contract = contractFrom(decision, snapshot, options) || {};
  return compact([
    upper(decision.symbol || snapshot.symbol || contract.root || contract.symbol),
    safeString(contract.localSymbol) || safeString(contract.conId),
    safeString(decision.strategyId || decision.strategy?.id),
    signalTimestampFrom(decision, snapshot, options),
    upper(decision.direction),
  ]);
}

function ignored(decision = {}, now, reason) {
  return {
    ok: true,
    signal: null,
    reason,
    decision: safeString(decision.decision),
    errors: [],
    generatedAt: nowIso(now),
    contractSource: CONTRACT_SAFETY.source,
    ...SAFETY,
  };
}

function rejected(decision = {}, now, reason, errors = [], rejectedSignal = null) {
  return {
    ok: false,
    signal: null,
    reason,
    decision: safeString(decision.decision),
    errors: errors.length ? [...errors] : [reason],
    rejectedSignal,
    generatedAt: nowIso(now),
    contractSource: CONTRACT_SAFETY.source,
    ...SAFETY,
  };
}

function adaptNativeFuturesStrategyDecision(decision = {}, options = {}) {
  const now = options.now || new Date();

  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return rejected(null, now, 'strategy_decision_missing_or_invalid');
  }

  if (IGNORED_DECISIONS.has(decision.decision)) {
    return ignored(
      decision,
      now,
      decision.decision === 'BLOCKED'
        ? 'strategy_decision_blocked'
        : 'strategy_decision_no_signal'
    );
  }

  if (decision.decision !== SIGNAL_DECISION) {
    return rejected(decision, now, 'unsupported_strategy_decision', [
      `unsupported_strategy_decision:${decision.decision || null}`,
    ]);
  }

  const snapshot = snapshotFrom(options);
  const contract = contractFrom(decision, snapshot, options);
  const signal = createNativeFuturesSignal({
    signalId: signalIdFrom(decision, snapshot, options),
    signalSource: 'native_futures',
    provider: 'ibkr',
    exchange: 'CME',
    marketType: 'futures',
    symbol: upper(decision.symbol || snapshot.symbol || contract?.root || contract?.symbol),
    contract,
    timeframe: lower(decision.timeframe || snapshot.timeframe || options.timeframe),
    signalTimestamp: signalTimestampFrom(decision, snapshot, options),
    strategyId: safeString(decision.strategyId || decision.strategy?.id),
    strategy: {
      id: safeString(decision.strategyId || decision.strategy?.id),
      name: strategyNameFrom(decision),
      version: safeString(decision.strategyVersion || decision.strategy?.version),
    },
    direction: upper(decision.direction),
    entryPrice: decision.entryPrice,
    stopLoss: decision.stopLoss,
    takeProfit: decision.takeProfit,
    riskReward: decision.riskReward,
    confidence: decision.confidence,
    generatedAt: nowIso(now),
  });

  const validation = validateNativeFuturesSignal(signal, { now });
  if (validation.ok !== true || isNativeFuturesProductionSignal(signal, { now }) !== true) {
    return rejected(
      decision,
      now,
      'native_futures_contract_rejected',
      validation.errors,
      signal
    );
  }

  return {
    ok: true,
    signal,
    reason: 'native_futures_canonical_signal_created',
    decision: decision.decision,
    errors: [],
    validation,
    generatedAt: nowIso(now),
    contractSource: CONTRACT_SAFETY.source,
    ...SAFETY,
  };
}

function createNativeFuturesCanonicalAdapter(options = {}) {
  return {
    adapt(decision, overrides = {}) {
      return adaptNativeFuturesStrategyDecision(decision, { ...options, ...overrides });
    },
  };
}

const defaultNativeFuturesCanonicalAdapter = createNativeFuturesCanonicalAdapter();

module.exports = {
  SAFETY,
  createNativeFuturesCanonicalAdapter,
  defaultNativeFuturesCanonicalAdapter,
  adaptNativeFuturesStrategyDecision,
  _internal: {
    signalIdFrom,
    signalTimestampFrom,
    contractFrom,
  },
};
