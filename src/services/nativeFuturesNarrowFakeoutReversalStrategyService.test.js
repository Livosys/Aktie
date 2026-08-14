'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  evaluateNativeFuturesNarrowFakeoutReversalStrategy: evaluate,
} = require('./nativeFuturesNarrowFakeoutReversalStrategyService');
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

// Lugn bas (ger narrow state med score >= 60, katalogregeln narrow_score_gte_60),
// sedan ett utbrott med SVAG volym och en återgång in i zonen — motorns
// fakeout-mönster.
function buildCandles({ base = 30000, qr = 4, breakAtr = 0.8, backAtr = -0.2, breakVolMult = 0.8, dir = 1 } = {}) {
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
  const brk = base + dir * breakAtr * qr;
  rows.push({
    timestamp: new Date(START + n * 120000).toISOString(),
    open: base, high: Math.max(base, brk) + 0.5, low: Math.min(base, brk) - 0.5, close: brk,
    volume: Math.round(100 * breakVolMult),
  });
  const back = base + dir * backAtr * qr;
  rows.push({
    timestamp: new Date(START + (n + 1) * 120000).toISOString(),
    open: brk, high: Math.max(brk, back) + 0.3, low: Math.min(brk, back) - 0.3, close: back, volume: 110,
  });
  return rows;
}

// Bekräftat utbrott (stark volym) = INTE fakeout. Samma serie som migrering 1 äger.
function buildConfirmedBreakoutCandles({ base = 30000, qr = 4, dipAtr = 1.2, riseAtr = 2.2, volMult = 6 } = {}) {
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

test('trigger: misslyckat utbrott med svag volym ger fakeout-signal', () => {
  const decision = evaluate(snapshot(), { now: new Date() });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.strategyId, STRATEGY_ID);
  assert.equal(decision.reason, 'narrow_fakeout_reversal');
  assert.equal(decision.evidence.originStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.signalFamily, 'NARROW_COMPRESSION');
  assert.equal(decision.evidence.signalSubtype, 'NARROW_FAKEOUT');
  assert.equal(decision.evidence.legacyStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.fakeoutActive, true);
  assert.equal(decision.evidence.fakeoutBrokenSide, 'high');
  assert.ok(['LONG', 'SHORT'].includes(decision.direction));
});

test('beslutet är identiskt med legacy-kedjan', () => {
  const candles = buildCandles();
  const legacy = legacyDecision(candles);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(legacy.signalSubtype, 'NARROW_FAKEOUT');
  assert.equal(decision.evidence.signalFamily, legacy.signalFamily);
  assert.equal(decision.evidence.signalSubtype, legacy.signalSubtype);
  assert.equal(decision.evidence.legacyStrategyId, legacy.strategyId);
  assert.equal(decision.evidence.legacyDirection, legacy.familyDebug.direction);
  assert.equal(decision.evidence.legacyBias, legacy.nextMoveBias);
});

test('LEGACY-EGENHET, medvetet bevarad: riktningen följer nextMoveBias, inte fakeoutDirection', () => {
  // Två serier med samma misslyckade UPP-brott (fakeoutDirection bearish).
  // Skillnaden är bara hur långt priset återgår, vilket flyttar legacy-biaset.
  // Aktievägen handlar nextMoveBias — adaptern läser det fältet — och den här
  // migreringen gör exakt samma sak. Att låta fakeoutDirection överstyra vore
  // NY handelslogik, inte en migrering.
  const short = evaluate(snapshot({}, { dir: 1, breakAtr: 0.8, backAtr: -0.2 }), { now: new Date() });
  const long = evaluate(snapshot({}, { dir: 1, breakAtr: 0.8, backAtr: 0.2 }), { now: new Date() });

  assert.equal(short.evidence.fakeoutDirection, 'bearish');
  assert.equal(long.evidence.fakeoutDirection, 'bearish');
  assert.equal(short.direction, 'SHORT');
  assert.equal(long.direction, 'LONG');
  // Riktningen kommer från legacy, inte från den här modulen.
  assert.equal(short.evidence.legacyDirection, 'DOWN');
  assert.equal(long.evidence.legacyDirection, 'UP');
});

test('nivåerna följer katalogen i båda riktningar: stop 0,22 % och target 1,3R', () => {
  const short = evaluate(snapshot({}, { dir: 1, breakAtr: 0.8, backAtr: -0.2 }), { now: new Date() });
  const long = evaluate(snapshot({}, { dir: 1, breakAtr: 0.8, backAtr: 0.2 }), { now: new Date() });

  const longStop = Number((Math.round((long.entryPrice * (1 - 0.0022)) / 0.25) * 0.25).toFixed(2));
  assert.equal(long.stopLoss, longStop);
  const longRisk = long.entryPrice - long.stopLoss;
  assert.equal(long.takeProfit, Number((Math.round((long.entryPrice + longRisk * 1.3) / 0.25) * 0.25).toFixed(2)));
  assert.ok(long.stopLoss < long.entryPrice && long.takeProfit > long.entryPrice);

  const shortStop = Number((Math.round((short.entryPrice * (1 + 0.0022)) / 0.25) * 0.25).toFixed(2));
  assert.equal(short.stopLoss, shortStop);
  const shortRisk = short.stopLoss - short.entryPrice;
  assert.equal(short.takeProfit, Number((Math.round((short.entryPrice - shortRisk * 1.3) / 0.25) * 0.25).toFixed(2)));
  assert.ok(short.stopLoss > short.entryPrice && short.takeProfit < short.entryPrice);

  assert.equal(long.riskReward, 1.3);
  assert.equal(short.riskReward, 1.3);
});

test('bekräftat utbrott är INTE fakeout — den serien ägs av narrow state expansion', () => {
  const candles = buildConfirmedBreakoutCandles();
  const fakeout = evaluate(snapshot({ candles }), { now: new Date() });
  const expansion = evaluateNarrowLong(snapshot({ candles }), { now: new Date() });

  assert.equal(fakeout.decision, 'NO_SIGNAL');
  assert.equal(fakeout.reason, 'narrow_fakeout_reversal_not_triggered');
  assert.notEqual(fakeout.evidence.signalSubtype, 'NARROW_FAKEOUT');
  assert.equal(expansion.decision, 'SIGNAL');
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
