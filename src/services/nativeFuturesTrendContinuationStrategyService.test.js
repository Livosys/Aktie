'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  evaluateNativeFuturesTrendContinuationStrategy: evaluate,
} = require('./nativeFuturesTrendContinuationStrategyService');
const {
  evaluateNativeFuturesEmaPullbackContinuationStrategy: evaluateEma,
} = require('./nativeFuturesEmaPullbackContinuationStrategyService');

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

// Trend + paus/rekyl + fortsättning — motorns pullback-detektor sätter
// eventType REGULAR_PULLBACK på den här formen.
function buildCandles({
  base = 30000, drift = 0.3, wick = 2, pullbackBars = 4, pullbackAtr = 1,
  contBars = 2, contAtr = 0.6, vol = 500,
} = {}) {
  const rows = [];
  const total = N - pullbackBars - contBars;
  for (let i = 0; i < total; i += 1) {
    const open = base + i * drift;
    rows.push({
      timestamp: new Date(START + i * 120000).toISOString(),
      open, high: open + wick + drift, low: open - wick, close: open + drift, volume: vol,
    });
  }
  let last = rows[rows.length - 1].close;
  const atrApprox = wick * 2;
  for (let j = 0; j < pullbackBars; j += 1) {
    const open = last;
    const close = last - (pullbackAtr * atrApprox) / pullbackBars;
    rows.push({
      timestamp: new Date(START + (total + j) * 120000).toISOString(),
      open, high: open + 0.5, low: close - 0.5, close, volume: vol,
    });
    last = close;
  }
  for (let k = 0; k < contBars; k += 1) {
    const open = last;
    const close = last + (contAtr * atrApprox) / contBars;
    rows.push({
      timestamp: new Date(START + (total + pullbackBars + k) * 120000).toISOString(),
      open, high: close + 0.4, low: open - 0.4, close, volume: vol,
    });
    last = close;
  }
  return rows;
}

// Spegelvänd serie: samma struktur i nedåttrend.
function mirrorCandles(rows) {
  return rows.map((row) => ({
    ...row,
    open: 60000 - row.open,
    high: 60000 - row.low,
    low: 60000 - row.high,
    close: 60000 - row.close,
  }));
}

function buildNarrowCandles({ base = 30000, qr = 4, dipAtr = 1.2, riseAtr = 2.2, volMult = 6 } = {}) {
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

function snapshot(overrides = {}, candleOptions = {}) {
  const candles = overrides.candles || buildCandles(candleOptions);
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

test('trigger long: legacy REGULAR_PULLBACK i uppåttrend ger LONG', () => {
  const decision = evaluate(snapshot(), { now: new Date() });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.direction, 'LONG');
  assert.equal(decision.strategyId, STRATEGY_ID);
  assert.equal(decision.reason, 'trend_continuation');
  assert.equal(decision.evidence.originStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.signalFamily, 'REGULAR_PULLBACK');
  assert.equal(decision.evidence.signalSubtype, 'REGULAR_PULLBACK');
  assert.equal(decision.evidence.legacyStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.legacyDirection, 'UP');
});

test('trigger short: samma struktur i nedåttrend ger SHORT', () => {
  const decision = evaluate(snapshot({ candles: mirrorCandles(buildCandles()) }), { now: new Date() });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.direction, 'SHORT');
  assert.equal(decision.evidence.legacyDirection, 'DOWN');
  assert.equal(decision.evidence.signalSubtype, 'REGULAR_PULLBACK');
});

test('beslutet är identiskt med legacy-kedjan', () => {
  const candles = buildCandles();
  const legacy = legacyDecision(candles);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(legacy.signalSubtype, 'REGULAR_PULLBACK');
  assert.equal(decision.evidence.signalFamily, legacy.signalFamily);
  assert.equal(decision.evidence.signalSubtype, legacy.signalSubtype);
  assert.equal(decision.evidence.legacyStrategyId, legacy.strategyId);
  assert.equal(decision.evidence.legacyDirection, legacy.familyDebug.direction);
  assert.equal(decision.evidence.legacyPriority, legacy.priority);
});

test('nivåerna följer katalogen i BÅDA riktningar: stop 0,24 % och target 1,8R', () => {
  const long = evaluate(snapshot(), { now: new Date() });
  const short = evaluate(snapshot({ candles: mirrorCandles(buildCandles()) }), { now: new Date() });

  const longStop = Number((Math.round((long.entryPrice * (1 - 0.0024)) / 0.25) * 0.25).toFixed(2));
  assert.equal(long.stopLoss, longStop);
  assert.ok(long.stopLoss < long.entryPrice && long.takeProfit > long.entryPrice);
  const longRisk = long.entryPrice - long.stopLoss;
  assert.equal(long.takeProfit, Number((Math.round((long.entryPrice + longRisk * 1.8) / 0.25) * 0.25).toFixed(2)));

  const shortStop = Number((Math.round((short.entryPrice * (1 + 0.0024)) / 0.25) * 0.25).toFixed(2));
  assert.equal(short.stopLoss, shortStop);
  assert.ok(short.stopLoss > short.entryPrice && short.takeProfit < short.entryPrice);
  const shortRisk = short.stopLoss - short.entryPrice;
  assert.equal(short.takeProfit, Number((Math.round((short.entryPrice - shortRisk * 1.8) / 0.25) * 0.25).toFixed(2)));

  assert.equal(long.riskReward, 1.8);
  assert.equal(short.riskReward, 1.8);
});

test('samtliga indata når strategin', () => {
  const ev = evaluate(snapshot(), { now: new Date() }).evidence;

  for (const key of ['ema21', 'ema50', 'atr14', 'vwap']) {
    assert.ok(typeof ev[key] === 'number' && Number.isFinite(ev[key]), `${key} saknas: ${ev[key]}`);
  }
  const tf = ev.timeframeAgreement;
  for (const key of ['tf2m', 'tf5m', 'tf10m', 'tf15m', 'tf30m', 'tf1h']) {
    assert.ok(['bullish', 'bearish', 'neutral'].includes(tf[key]), `${key} = ${tf[key]}`);
  }
  assert.ok(typeof ev.narrowState === 'string' && ev.narrowState.length > 0);
  assert.equal(ev.eventType, 'REGULAR_PULLBACK');
  assert.ok(Number.isFinite(ev.agreementCount));
});

test('narrow-kontext triggar inte', () => {
  const candles = buildNarrowCandles();
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'trend_continuation_not_triggered');
  assert.equal(legacyDecision(candles).signalSubtype, decision.evidence.signalSubtype);
});

test('REGULAR_PULLBACK kortsluter EMA-grenen — de kan aldrig trigga samtidigt', () => {
  const snap = snapshot();
  const trend = evaluate(snap, { now: new Date() });
  const ema = evaluateEma(snap, { now: new Date() });

  assert.equal(trend.decision, 'SIGNAL');
  assert.equal(ema.decision, 'NO_SIGNAL');
  assert.equal(ema.evidence.signalFamily, 'REGULAR_PULLBACK');
});

test('för kort historik ger NO_SIGNAL, inte krasch', () => {
  const decision = evaluate(snapshot({ candles: buildCandles().slice(-10) }), { now: new Date() });

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
