'use strict';

// `node src/services/canonical/nativeFuturesCanonicalAdapter.test.js`
// Phase 6 adapter tests: no runtime wiring.

const assert = require('assert');
const fs = require('fs');
const { createNativeFuturesScanner } = require('../nativeFuturesScannerService');
const {
  DECISIONS,
  evaluateNativeFuturesMomentumStrategy,
} = require('../nativeFuturesMomentumStrategyService');
const {
  validateNativeFuturesSignal,
  isNativeFuturesProductionSignal,
} = require('./nativeFuturesSignalContract');
const {
  createNativeFuturesCanonicalAdapter,
  adaptNativeFuturesStrategyDecision,
} = require('./nativeFuturesCanonicalAdapter');

const NOW = new Date('2026-08-13T12:35:00.000Z');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`);
    process.exitCode = 1;
  }
}

function contract(symbol = 'MNQ', overrides = {}) {
  const upper = String(symbol).toUpperCase();
  return {
    root: upper,
    symbol: upper,
    localSymbol: `${upper}U6`,
    conId: upper === 'MNQ' ? 793356225 : 724589104,
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    expiry: '20260918',
    lastTradeDateOrContractMonth: '20260918',
    ...overrides,
  };
}

function candle(symbol = 'MNQ', overrides = {}) {
  return {
    symbol,
    timestamp: '2026-08-13T12:34:00.000Z',
    open: 29870,
    high: 29890,
    low: 29868,
    close: 29886,
    volume: 1200,
    source: 'ibkr_cme_2m',
    ...overrides,
  };
}

function quote(symbol = 'MNQ', overrides = {}) {
  return {
    symbol,
    timestamp: '2026-08-13T12:34:58.000Z',
    bid: 29886,
    ask: 29886.5,
    last: 29886.25,
    source: 'ibkr_realtime',
    ...overrides,
  };
}

function openSession(overrides = {}) {
  return {
    isOpen: true,
    isMarketOpen: true,
    session: 'Globex',
    sessionId: 'us_rth',
    sessionLabel: 'US RTH',
    exchangeTimezone: 'America/Chicago',
    closedReason: null,
    ...overrides,
  };
}

function closedSession(overrides = {}) {
  return {
    isOpen: false,
    isMarketOpen: false,
    session: 'Globex',
    sessionId: 'market_closed',
    sessionLabel: 'Market Closed',
    exchangeTimezone: 'America/Chicago',
    closedReason: 'weekend',
    ...overrides,
  };
}

function snapshotRow({
  symbol = 'MNQ',
  contractOverride = {},
  candleOverride = {},
  quoteOverride = {},
  session = openSession(),
} = {}) {
  const scanner = createNativeFuturesScanner({
    symbols: [symbol],
    timeframe: '2m',
    maxCandleAgeMs: 3 * 60 * 1000,
    maxQuoteAgeMs: 15 * 1000,
    contractReader: () => contract(symbol, contractOverride),
    candleReader: () => [candle(symbol, candleOverride)],
    quoteReader: () => quote(symbol, quoteOverride),
    sessionReader: () => session,
  });
  const result = scanner.scan({ now: NOW });
  assert.strictEqual(result.rows.length, 1);
  return result.rows[0];
}

function strategyDecision(snapshot) {
  return evaluateNativeFuturesMomentumStrategy(snapshot, { now: NOW });
}

function pureStrategyOutput(decision) {
  return {
    decision: decision.decision,
    direction: decision.direction,
    entryPrice: decision.entryPrice,
    stopLoss: decision.stopLoss,
    takeProfit: decision.takeProfit,
    riskReward: decision.riskReward,
    reason: decision.reason,
    strategyId: decision.strategyId,
    strategyVersion: decision.strategyVersion,
    symbol: decision.symbol,
    timeframe: decision.timeframe,
    signalTimestamp: decision.signalTimestamp,
    marketSnapshotTimestamp: decision.marketSnapshotTimestamp,
  };
}

function assertNoRuntimePayload(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [
    'candidateId',
    'intentId',
    'executionId',
    'brokerPayload',
    'orderId',
  ]) {
    assert.strictEqual(text.includes(forbidden), false, `${forbidden} must not be emitted`);
  }
}

console.log('nativeFuturesCanonicalAdapter');

test('NO_SIGNAL returns no canonical signal', () => {
  const snapshot = snapshotRow({
    candleOverride: {
      open: 29880,
      high: 29883,
      low: 29878,
      close: 29881,
    },
  });
  const decision = strategyDecision(snapshot);
  assert.strictEqual(decision.decision, DECISIONS.NO_SIGNAL);

  const result = adaptNativeFuturesStrategyDecision(pureStrategyOutput(decision), {
    marketSnapshot: snapshot,
    now: NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, 'strategy_decision_no_signal');
  assert.strictEqual(result.signal, null);
});

test('BLOCKED returns no canonical signal', () => {
  const snapshot = snapshotRow({ session: closedSession() });
  const decision = strategyDecision(snapshot);
  assert.strictEqual(decision.decision, DECISIONS.BLOCKED);

  const result = adaptNativeFuturesStrategyDecision(pureStrategyOutput(decision), {
    marketSnapshot: snapshot,
    now: NOW,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, 'strategy_decision_blocked');
  assert.strictEqual(result.signal, null);
});

test('SIGNAL returns a valid Native Futures Canonical Signal', () => {
  const snapshot = snapshotRow();
  const decision = pureStrategyOutput(strategyDecision(snapshot));
  const result = adaptNativeFuturesStrategyDecision(decision, {
    marketSnapshot: snapshot,
    now: NOW,
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(result.reason, 'native_futures_canonical_signal_created');
  assert.strictEqual(result.signal.signalSource, 'native_futures');
  assert.strictEqual(result.signal.marketType, 'futures');
  assert.strictEqual(result.signal.provider, 'ibkr');
  assert.strictEqual(result.signal.exchange, 'CME');
  assert.strictEqual(result.signal.symbol, 'MNQ');
  assert.strictEqual(result.signal.contract.localSymbol, 'MNQU6');
  assert.strictEqual(result.signal.timeframe, '2m');
  assert.strictEqual(result.signal.signalTimestamp, '2026-08-13T12:34:00.000Z');
  assert.strictEqual(result.signal.strategyId, decision.strategyId);
  assert.strictEqual(result.signal.strategy.version, decision.strategyVersion);
  assert.strictEqual(result.signal.direction, 'LONG');
  assert.strictEqual(validateNativeFuturesSignal(result.signal, { now: NOW }).ok, true);
  assert.strictEqual(isNativeFuturesProductionSignal(result.signal, { now: NOW }), true);
  assertNoRuntimePayload(result.signal);
});

test('SIGNAL uses closed 2m candle close timestamp from native scanner', () => {
  const snapshot = snapshotRow({
    candleOverride: {
      timestamp: '2026-08-13T12:32:00.000Z',
      t: '2026-08-13T12:32:00.000Z',
      timeframe: '2m',
      isClosed: true,
    },
  });
  const decision = pureStrategyOutput(strategyDecision(snapshot));
  const result = adaptNativeFuturesStrategyDecision(decision, {
    marketSnapshot: snapshot,
    now: NOW,
  });

  assert.strictEqual(decision.signalTimestamp, '2026-08-13T12:34:00.000Z');
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(result.signal.signalTimestamp, '2026-08-13T12:34:00.000Z');
});

test('wrong direction is rejected', () => {
  const snapshot = snapshotRow();
  const decision = {
    ...pureStrategyOutput(strategyDecision(snapshot)),
    direction: 'SIDEWAYS',
  };

  const result = adaptNativeFuturesStrategyDecision(decision, {
    marketSnapshot: snapshot,
    now: NOW,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.reason, 'native_futures_contract_rejected');
  assert.ok(result.errors.includes('invalid_direction:SIDEWAYS'));
});

test('missing stop is rejected', () => {
  const snapshot = snapshotRow();
  const decision = {
    ...pureStrategyOutput(strategyDecision(snapshot)),
    stopLoss: null,
  };

  const result = adaptNativeFuturesStrategyDecision(decision, {
    marketSnapshot: snapshot,
    now: NOW,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.signal, null);
  assert.ok(result.errors.includes('missing_required_field:stopLoss'));
  assert.ok(result.errors.includes('invalid_stop_loss'));
});

test('invalid contract is rejected', () => {
  const validSnapshot = snapshotRow();
  const invalidSnapshot = {
    ...validSnapshot,
    contract: contract('MNQ', {
      conId: null,
      secType: 'CONTFUT',
      exchange: 'NASDAQ',
      localSymbol: 'MNQCONT',
    }),
  };
  const decision = pureStrategyOutput(strategyDecision(validSnapshot));

  const result = adaptNativeFuturesStrategyDecision(decision, {
    marketSnapshot: invalidSnapshot,
    now: NOW,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.signal, null);
  assert.ok(result.errors.includes('contract_conid_missing'));
  assert.ok(result.errors.includes('contract_not_fut:CONTFUT'));
  assert.ok(result.errors.includes('continuous_contract_not_orderable'));
  assert.ok(result.errors.includes('contract_wrong_exchange:NASDAQ'));
});

test('invalid timestamp is rejected', () => {
  const snapshot = snapshotRow();
  const decision = {
    ...pureStrategyOutput(strategyDecision(snapshot)),
    signalTimestamp: 'not-a-date',
  };

  const result = adaptNativeFuturesStrategyDecision(decision, {
    marketSnapshot: snapshot,
    now: NOW,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.signal, null);
  assert.ok(result.errors.includes('invalid_signal_timestamp:not-a-date'));
});

test('factory adapter delegates to the same canonical conversion', () => {
  const snapshot = snapshotRow();
  const decision = pureStrategyOutput(strategyDecision(snapshot));
  const adapter = createNativeFuturesCanonicalAdapter({ marketSnapshot: snapshot, now: NOW });
  const result = adapter.adapt(decision);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.signal.strategyId, decision.strategyId);
  assert.strictEqual(result.signal.signalSource, 'native_futures');
});

test('adapter implementation has no bridge or runtime references', () => {
  const source = fs.readFileSync(require.resolve('./nativeFuturesCanonicalAdapter'), 'utf8');
  for (const forbidden of [
    'TradingOS',
    'DecisionMonitor',
    'Candidate',
    'Execution',
    'brokerPayload',
  ]) {
    assert.strictEqual(source.includes(forbidden), false, `${forbidden} must not appear in adapter source`);
  }
});

console.log(`\nnativeFuturesCanonicalAdapter: ${passed} tests ok`);
