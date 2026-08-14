'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  evaluateNativeFuturesNarrowBreakoutShortStrategy: evaluate,
} = require('./nativeFuturesNarrowBreakoutShortStrategyService');
const {
  evaluateNativeFuturesNarrowStateExpansionStrategy: evaluateNarrowLong,
} = require('./nativeFuturesNarrowStateExpansionStrategyService');

const { classifyNarrowState } = require('../scanner/narrowState');
const { calcIndicators } = require('../scanner/indicators');
const { enrichIndicatorsFromCandles } = require('../scanner/indicatorEnrichment');
const { buildDecisionMonitor } = require('../scanner/decisionMonitor');

const CONTRACT = Object.freeze({
  root: 'MNQ',
  symbol: 'MNQ',
  localSymbol: 'MNQU6',
  conId: 793356225,
  secType: 'FUT',
  exchange: 'CME',
  currency: 'USD',
  expiry: '20260918',
});

// FÄLLA: decisionMonitor.isDataStale läser Date.now() direkt.
const N = 250;
const NOW = new Date();
const START = NOW.getTime() - N * 120000;

function buildNarrowCandles({ base = 30000, qr = 4, dipAtr = 0.8, riseAtr = 2.2, volMult = 4 } = {}) {
  const n = N - 2;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const open = base + (i % 3 === 0 ? 0.3 : -0.3);
    const close = base + (i % 2 === 0 ? 0.4 : -0.4);
    rows.push({
      timestamp: new Date(START + i * 120000).toISOString(),
      open, high: Math.max(open, close) + qr / 2, low: Math.min(open, close) - qr / 2, close, volume: 100 + (i % 7),
    });
  }
  const dipTo = base - dipAtr * qr;
  rows.push({
    timestamp: new Date(START + n * 120000).toISOString(),
    open: base, high: base + 0.5, low: dipTo - 0.5, close: dipTo, volume: 110,
  });
  const close = dipTo + riseAtr * qr;
  rows.push({
    timestamp: new Date(START + (n + 1) * 120000).toISOString(),
    open: dipTo, high: close + 0.4, low: dipTo - 0.3, close, volume: 100 * volMult,
  });
  return rows;
}

// Spegelvänd serie ger utbrott NEDÅT — det är den sida `narrow_breakout` äger.
function mirrorCandles(rows) {
  return rows.map((row) => ({
    ...row,
    open: 60000 - row.open,
    high: 60000 - row.low,
    low: 60000 - row.high,
    close: 60000 - row.close,
  }));
}

function snapshot(overrides = {}, candleOptions = {}) {
  const candles = overrides.candles || mirrorCandles(buildNarrowCandles(candleOptions));
  const latestCandle = candles[candles.length - 1];
  return {
    symbol: 'MNQ',
    root: 'MNQ',
    timeframe: '2m',
    contract: CONTRACT,
    contractStatus: 'valid',
    contractErrors: [],
    candles,
    latestCandle,
    candleStatus: 'fresh',
    latestQuote: { price: latestCandle.close, bid: latestCandle.close - 0.25, ask: latestCandle.close + 0.25 },
    quoteStatus: 'fresh',
    sessionStatus: 'open',
    status: 'ready',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function legacyDecision(candles) {
  const engine = candles.map((row) => ({
    o: row.open, h: row.high, l: row.low, c: row.close, v: row.volume, t: row.timestamp, ts: row.timestamp,
  }));
  const indicators = calcIndicators(engine);
  const price = candles[candles.length - 1].close;
  const classified = classifyNarrowState({
    symbol: 'MNQ', price, candles2m: engine, indicators, lastUpdate: new Date().toISOString(),
  });
  const enriched = enrichIndicatorsFromCandles(classified, engine);
  const latest = engine[engine.length - 1];
  const monitor = buildDecisionMonitor({
    stockResults: [{
      ...classified, ...enriched, symbol: 'MNQ', candleTs: latest.t, lastUpdate: latest.t,
    }],
    cryptoResults: [],
    liveCandleDebugBySymbol: { MNQ: { candles } },
    familyDebug: true,
  });
  return monitor.candidates[0];
}

test('trigger: legacy NARROW_BEAR_ENTRY ger SHORT-signal', () => {
  const decision = evaluate(snapshot(), { now: new Date() });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.direction, 'SHORT');
  assert.equal(decision.strategyId, STRATEGY_ID);
  assert.equal(decision.reason, 'narrow_breakout_short');
  assert.equal(decision.evidence.originStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.signalFamily, 'NARROW_COMPRESSION');
  assert.equal(decision.evidence.signalSubtype, 'NARROW_BEAR_ENTRY');
  assert.equal(decision.evidence.legacyStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.legacyDirection, 'DOWN');
});

test('beslutet är identiskt med legacy-kedjan', () => {
  const candles = mirrorCandles(buildNarrowCandles());
  const legacy = legacyDecision(candles);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(legacy.signalSubtype, 'NARROW_BEAR_ENTRY');
  assert.equal(decision.evidence.signalFamily, legacy.signalFamily);
  assert.equal(decision.evidence.signalSubtype, legacy.signalSubtype);
  assert.equal(decision.evidence.legacyStrategyId, legacy.strategyId);
  assert.equal(decision.evidence.legacyDirection, legacy.familyDebug.direction);
});

test('nivåerna följer katalogen: stop 0,2 % över entry och target 1,8R under', () => {
  const decision = evaluate(snapshot(), { now: new Date() });
  const entry = decision.entryPrice;

  const expectedStop = Number((Math.round((entry * (1 + 0.002)) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.stopLoss, expectedStop);
  assert.ok(decision.stopLoss > entry, 'stop måste ligga ÖVER entry på en short');

  const risk = decision.stopLoss - entry;
  assert.equal(decision.takeProfit, Number((Math.round((entry - risk * 1.8) / 0.25) * 0.25).toFixed(2)));
  assert.ok(decision.takeProfit < entry, 'target måste ligga UNDER entry på en short');
  assert.equal(decision.riskReward, 1.8);
});

test('bull-sidan ägs av narrow state expansion — de två kan aldrig trigga samtidigt', () => {
  const bearCandles = mirrorCandles(buildNarrowCandles());
  const bullCandles = buildNarrowCandles({ dipAtr: 1.2, riseAtr: 2.2, volMult: 6 });

  const bearOnBear = evaluate(snapshot({ candles: bearCandles }), { now: new Date() });
  const longOnBear = evaluateNarrowLong(snapshot({ candles: bearCandles }), { now: new Date() });
  const bearOnBull = evaluate(snapshot({ candles: bullCandles }), { now: new Date() });
  const longOnBull = evaluateNarrowLong(snapshot({ candles: bullCandles }), { now: new Date() });

  assert.equal(bearOnBear.decision, 'SIGNAL');
  assert.equal(longOnBear.decision, 'NO_SIGNAL');
  assert.equal(longOnBull.decision, 'SIGNAL');
  assert.equal(bearOnBull.decision, 'NO_SIGNAL');
});

test('strategin går aldrig long', () => {
  const decision = evaluate(snapshot({ candles: buildNarrowCandles({ dipAtr: 1.2, riseAtr: 2.2, volMult: 6 }) }), { now: new Date() });

  assert.notEqual(decision.direction, 'LONG');
  assert.ok(decision.decision !== 'SIGNAL' || decision.direction === 'SHORT');
});

test('NARROW_WAIT skapar aldrig affär — målsubtypen står explicit', () => {
  // Lugn serie utan utbrott: motorn ger vänteläge, inte bear entry.
  const candles = buildNarrowCandles({ dipAtr: 1.2, riseAtr: 0.2, volMult: 1 });
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'narrow_breakout_short_not_triggered');
  assert.notEqual(decision.evidence.signalSubtype, 'NARROW_BEAR_ENTRY');
});

test('för kort historik ger NO_SIGNAL, inte krasch', () => {
  const decision = evaluate(snapshot({ candles: mirrorCandles(buildNarrowCandles()).slice(-10) }), { now: new Date() });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'insufficient_candle_history');
});

test('kontraktsgrindarna delas med momentumstrategin', () => {
  const decision = evaluate(snapshot({
    contract: { ...CONTRACT, secType: 'STK' },
    contractStatus: 'invalid',
    contractErrors: ['contract_not_fut:STK'],
  }), { now: new Date() });

  assert.equal(decision.decision, 'BLOCKED');
  assert.ok(decision.blockers.includes('invalid_contract'));
});

test('stängd session blockerar', () => {
  const decision = evaluate(snapshot({ sessionStatus: 'closed' }), { now: new Date() });

  assert.equal(decision.decision, 'BLOCKED');
  assert.ok(decision.blockers.includes('session_closed'));
});
