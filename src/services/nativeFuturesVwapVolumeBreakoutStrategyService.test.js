'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  evaluateNativeFuturesVwapVolumeBreakoutStrategy: evaluate,
} = require('./nativeFuturesVwapVolumeBreakoutStrategyService');
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

// FÄLLA: decisionMonitor.isDataStale läser Date.now() direkt. Fixturen måste
// byggas relativt verklig tid, annars nollställs alla tidsramar till 'unknown'.
const N = 250;
const NOW = new Date();
const START = NOW.getTime() - N * 120000;

// Sidledes bas som håller VWAP nära priset, en nedgång, sedan återtag upp
// genom VWAP med volym. Parametrarna gav legacy-träff VWAP_RECLAIM_UP i proben.
function buildCandles({
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

// Narrow state-serie: ska fångas av NARROW_COMPRESSION före VWAP-grenen.
function buildNarrowCandles({ base = 30000, qr = 4, dipAtr = 1.2, riseAtr = 2.2, volMult = 6 } = {}) {
  const n = N - 2;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const open = base + (i % 3 === 0 ? 0.3 : -0.3);
    const close = base + (i % 2 === 0 ? 0.4 : -0.4);
    rows.push({
      timestamp: new Date(START + i * 120000).toISOString(),
      open,
      high: Math.max(open, close) + qr / 2,
      low: Math.min(open, close) - qr / 2,
      close,
      volume: 100 + (i % 7),
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

// Legacy-kedjan fristående — facit för identitetstestet.
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

test('trigger: legacy VWAP-återtag ger LONG-signal', () => {
  const decision = evaluate(snapshot(), { now: new Date() });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.direction, 'LONG');
  assert.equal(decision.strategyId, STRATEGY_ID);
  assert.equal(decision.reason, 'vwap_volume_breakout_long');
  assert.equal(decision.evidence.originStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.signalFamily, 'VWAP_RECLAIM_REJECTION');
  assert.equal(decision.evidence.signalSubtype, 'VWAP_RECLAIM_UP');
  assert.equal(decision.evidence.legacyStrategyId, ORIGIN_STRATEGY_ID);
});

test('beslutet är identiskt med legacy-kedjan', () => {
  const candles = buildCandles();
  const legacy = legacyDecision(candles);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(legacy.signalFamily, 'VWAP_RECLAIM_REJECTION');
  assert.equal(legacy.signalSubtype, 'VWAP_RECLAIM_UP');
  assert.equal(decision.evidence.signalFamily, legacy.signalFamily);
  assert.equal(decision.evidence.signalSubtype, legacy.signalSubtype);
  assert.equal(decision.evidence.legacyStrategyId, legacy.strategyId);
  assert.equal(decision.evidence.legacyDirection, legacy.nextMoveBias);
  assert.equal(decision.evidence.legacyPriority, legacy.priority);
});

test('samtliga indata når strategin: vwap, vwapDistancePct, atr14, relVol20, volumeState, tidsramar', () => {
  const decision = evaluate(snapshot(), { now: new Date() });
  const ev = decision.evidence;

  for (const key of ['vwap', 'vwapDistancePct', 'atr14', 'relVol20']) {
    assert.ok(typeof ev[key] === 'number' && Number.isFinite(ev[key]), `${key} saknas: ${ev[key]}`);
  }
  assert.ok(typeof ev.volumeState === 'string' && ev.volumeState.length > 0);
  const tf = ev.timeframeAgreement;
  assert.ok(tf && typeof tf === 'object', 'timeframeAgreement saknas');
  for (const key of ['tf2m', 'tf5m', 'tf10m', 'tf15m', 'tf30m', 'tf1h']) {
    assert.ok(['bullish', 'bearish', 'neutral'].includes(tf[key]), `${key} = ${tf[key]}`);
  }
  assert.ok(typeof ev.narrowState === 'string' && ev.narrowState.length > 0);

  // Katalogens tre regler ska vara verkligt utvärderade, inte defaultade.
  assert.ok(ev.vwapAttempt && ev.vwapAttempt.matched === true);
  assert.ok(Math.abs(ev.vwapAttempt.details.distancePct) <= 0.45, 'priset måste ligga nära VWAP');
  assert.equal(ev.vwapAttempt.details.volumeUsable, true);
  assert.ok(ev.vwapAttempt.details.tf2mAligned || ev.vwapAttempt.details.candleAligned);
});

test('nivåerna följer katalogen: stop 0,18 % och take profit 1,5R', () => {
  const decision = evaluate(snapshot(), { now: new Date() });
  const entry = decision.entryPrice;

  const expectedStop = Number((Math.round((entry * (1 - 0.0018)) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.stopLoss, expectedStop);
  assert.ok(decision.stopLoss < entry, 'stop måste ligga under entry på en long');

  const risk = entry - decision.stopLoss;
  const expectedTarget = Number((Math.round((entry + risk * 1.5) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.takeProfit, expectedTarget);
  assert.ok(decision.takeProfit > entry, 'target måste ligga över entry på en long');
  assert.equal(decision.riskReward, 1.5);
});

test('narrow-kontext triggar inte — den vägen tillhör NARROW_COMPRESSION', () => {
  const candles = buildNarrowCandles();
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'vwap_volume_breakout_not_triggered');
  assert.notEqual(decision.evidence.signalSubtype, 'VWAP_RECLAIM_UP');
  assert.equal(legacyDecision(candles).signalSubtype, decision.evidence.signalSubtype);
});

test('VWAP och EMA kan aldrig trigga på samma ljus — legacy ger exakt en familj', () => {
  const candles = buildCandles();
  const snap = snapshot({ candles });
  const vwap = evaluate(snap, { now: new Date() });
  const ema = evaluateEma(snap, { now: new Date() });

  assert.equal(vwap.decision, 'SIGNAL');
  assert.equal(ema.decision, 'NO_SIGNAL');
  assert.equal(ema.reason, 'ema_pullback_continuation_not_triggered');
  // Båda läser samma legacy-kandidat och ser samma familj.
  assert.equal(ema.evidence.signalFamily, vwap.evidence.signalFamily);
});

test('strategin går aldrig short', () => {
  const candles = buildCandles();
  const mirrored = candles.map((row) => ({
    ...row,
    open: 60000 - row.open,
    high: 60000 - row.low,
    low: 60000 - row.high,
    close: 60000 - row.close,
  }));
  const decision = evaluate(snapshot({ candles: mirrored }), { now: new Date() });

  assert.notEqual(decision.direction, 'SHORT');
  assert.ok(decision.decision !== 'SIGNAL' || decision.direction === 'LONG');
});

test('för kort historik ger NO_SIGNAL, inte krasch', () => {
  const candles = buildCandles().slice(-10);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'insufficient_candle_history');
  assert.equal(decision.evidence.candlesAvailable, 10);
});

test('kontraktsgrindarna delas med momentumstrategin', () => {
  const decision = evaluate(snapshot({
    contract: { ...CONTRACT, secType: 'STK' },
    contractStatus: 'invalid',
    contractErrors: ['contract_not_fut:STK'],
  }), { now: new Date() });

  assert.equal(decision.decision, 'BLOCKED');
  assert.equal(decision.ok, false);
  assert.ok(decision.blockers.includes('invalid_contract'));
});

test('stängd session blockerar', () => {
  const decision = evaluate(snapshot({ sessionStatus: 'closed' }), { now: new Date() });

  assert.equal(decision.decision, 'BLOCKED');
  assert.ok(decision.blockers.includes('session_closed'));
});
