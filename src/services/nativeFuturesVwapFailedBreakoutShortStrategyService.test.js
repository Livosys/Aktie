'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  evaluateNativeFuturesVwapFailedBreakoutShortStrategy: evaluate,
} = require('./nativeFuturesVwapFailedBreakoutShortStrategyService');
const {
  evaluateNativeFuturesVwapVolumeBreakoutStrategy: evaluateLong,
} = require('./nativeFuturesVwapVolumeBreakoutStrategyService');

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

// FÄLLA: decisionMonitor.isDataStale läser Date.now() direkt — fixturen byggs
// relativt verklig tid.
const N = 250;
const NOW = new Date();
const START = NOW.getTime() - N * 120000;

// Sidledes bas, uppgång, sedan avvisning ned genom VWAP med volym.
function buildCandles({
  base = 30000, wick = 2, driftUp = 0.4, rejectBars = 2, rejectAtr = 1.2,
  vol = 500, rejectVolMult = 2.5, upBars = 20,
} = {}) {
  const rows = [];
  const flat = N - upBars - rejectBars;
  for (let i = 0; i < flat; i += 1) {
    const open = base + (i % 2 === 0 ? 0.4 : -0.4);
    const close = base + (i % 3 === 0 ? 0.5 : -0.5);
    rows.push({
      timestamp: new Date(START + i * 120000).toISOString(),
      open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: vol,
    });
  }
  let last = rows[rows.length - 1].close;
  for (let j = 0; j < upBars; j += 1) {
    const open = last;
    const close = last + driftUp;
    rows.push({
      timestamp: new Date(START + (flat + j) * 120000).toISOString(),
      open, high: Math.max(open, close) + wick / 2, low: Math.min(open, close) - wick / 2, close, volume: vol,
    });
    last = close;
  }
  const atrApprox = wick * 2;
  for (let k = 0; k < rejectBars; k += 1) {
    const open = last;
    const close = last - (rejectAtr * atrApprox) / rejectBars;
    rows.push({
      timestamp: new Date(START + (flat + upBars + k) * 120000).toISOString(),
      open, high: open + 0.4, low: close - 0.4, close, volume: Math.round(vol * rejectVolMult),
    });
    last = close;
  }
  return rows;
}

// Long-sidans fixtur (VWAP_RECLAIM_UP) — används för ömsesidig uteslutning.
function buildReclaimCandles({
  base = 30000, wick = 2, driftDown = -0.4, reclaimBars = 3, reclaimAtr = 0.8,
  vol = 500, reclaimVolMult = 2.5, downBars = 20,
} = {}) {
  const rows = [];
  const flat = N - downBars - reclaimBars;
  for (let i = 0; i < flat; i += 1) {
    const open = base + (i % 2 === 0 ? 0.4 : -0.4);
    const close = base + (i % 3 === 0 ? 0.5 : -0.5);
    rows.push({
      timestamp: new Date(START + i * 120000).toISOString(),
      open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: vol,
    });
  }
  let last = rows[rows.length - 1].close;
  for (let j = 0; j < downBars; j += 1) {
    const open = last;
    const close = last + driftDown;
    rows.push({
      timestamp: new Date(START + (flat + j) * 120000).toISOString(),
      open, high: Math.max(open, close) + wick / 2, low: Math.min(open, close) - wick / 2, close, volume: vol,
    });
    last = close;
  }
  const atrApprox = wick * 2;
  for (let k = 0; k < reclaimBars; k += 1) {
    const open = last;
    const close = last + (reclaimAtr * atrApprox) / reclaimBars;
    rows.push({
      timestamp: new Date(START + (flat + downBars + k) * 120000).toISOString(),
      open, high: close + 0.4, low: open - 0.4, close, volume: Math.round(vol * reclaimVolMult),
    });
    last = close;
  }
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

test('trigger: legacy VWAP-avvisning ger SHORT-signal', () => {
  const decision = evaluate(snapshot(), { now: new Date() });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.direction, 'SHORT');
  assert.equal(decision.strategyId, STRATEGY_ID);
  assert.equal(decision.reason, 'vwap_failed_breakout_short');
  assert.equal(decision.evidence.originStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.signalFamily, 'VWAP_RECLAIM_REJECTION');
  assert.equal(decision.evidence.signalSubtype, 'VWAP_REJECTION_DOWN');
  assert.equal(decision.evidence.legacyStrategyId, ORIGIN_STRATEGY_ID);
});

test('beslutet är identiskt med legacy-kedjan', () => {
  const candles = buildCandles();
  const legacy = legacyDecision(candles);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(legacy.signalSubtype, 'VWAP_REJECTION_DOWN');
  assert.equal(decision.evidence.signalFamily, legacy.signalFamily);
  assert.equal(decision.evidence.signalSubtype, legacy.signalSubtype);
  assert.equal(decision.evidence.legacyStrategyId, legacy.strategyId);
  assert.equal(decision.evidence.legacyPriority, legacy.priority);
});

test('samtliga indata når strategin', () => {
  const decision = evaluate(snapshot(), { now: new Date() });
  const ev = decision.evidence;

  for (const key of ['vwap', 'vwapDistancePct', 'atr14']) {
    assert.ok(typeof ev[key] === 'number' && Number.isFinite(ev[key]), `${key} saknas: ${ev[key]}`);
  }
  assert.ok(typeof ev.volumeState === 'string' && ev.volumeState.length > 0);
  const tf = ev.timeframeAgreement;
  for (const key of ['tf2m', 'tf5m', 'tf10m', 'tf15m', 'tf30m', 'tf1h']) {
    assert.ok(['bullish', 'bearish', 'neutral'].includes(tf[key]), `${key} = ${tf[key]}`);
  }
  assert.ok(typeof ev.narrowState === 'string' && ev.narrowState.length > 0);
  assert.ok(ev.vwapAttempt && ev.vwapAttempt.matched === true);
  assert.ok(Math.abs(ev.vwapAttempt.details.distancePct) <= 0.45);
  assert.equal(ev.vwapAttempt.details.volumeUsable, true);
});

test('nivåerna följer katalogen: stop 0,2 % över entry och target 1,4R under', () => {
  const decision = evaluate(snapshot(), { now: new Date() });
  const entry = decision.entryPrice;

  const expectedStop = Number((Math.round((entry * (1 + 0.002)) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.stopLoss, expectedStop);
  assert.ok(decision.stopLoss > entry, 'stop måste ligga ÖVER entry på en short');

  const risk = decision.stopLoss - entry;
  const expectedTarget = Number((Math.round((entry - risk * 1.4) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.takeProfit, expectedTarget);
  assert.ok(decision.takeProfit < entry, 'target måste ligga UNDER entry på en short');
  assert.equal(decision.riskReward, 1.4);
});

test('long- och short-sidan av VWAP-familjen utesluter varandra', () => {
  const shortSnap = snapshot();
  const longSnap = snapshot({ candles: buildReclaimCandles() });

  const shortOnShort = evaluate(shortSnap, { now: new Date() });
  const longOnShort = evaluateLong(shortSnap, { now: new Date() });
  const shortOnLong = evaluate(longSnap, { now: new Date() });
  const longOnLong = evaluateLong(longSnap, { now: new Date() });

  assert.equal(shortOnShort.decision, 'SIGNAL');
  assert.equal(longOnShort.decision, 'NO_SIGNAL');
  assert.equal(longOnLong.decision, 'SIGNAL');
  assert.equal(shortOnLong.decision, 'NO_SIGNAL');
});

test('strategin går aldrig long', () => {
  const candles = buildReclaimCandles();
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.notEqual(decision.direction, 'LONG');
  assert.ok(decision.decision !== 'SIGNAL' || decision.direction === 'SHORT');
});

test('för kort historik ger NO_SIGNAL, inte krasch', () => {
  const candles = buildCandles().slice(-10);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

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
