'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  evaluateNativeFuturesEmaPullbackContinuationStrategy: evaluate,
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
// därför byggas relativt verklig tid, annars flaggas serien som gammal, alla
// tidsramar nollställs till 'unknown' och EMA-grenen kan aldrig matcha.
const N = 250;
const NOW = new Date();
const START = NOW.getTime() - N * 120000;

// Uppåttrend -> rekyl mot EMA -> fortsättningsljus. Parametrarna är de som gav
// legacy-träff EMA_PULLBACK_UP i kedjeproben.
function buildCandles({
  base = 30000, drift = 0.15, wick = 2, pullbackBars = 5, pullbackAtr = 2,
  contBars = 3, contAtr = 1, vol = 500, recentVolMult = 0.35,
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
      open, high: open + 0.5, low: close - 0.5, close, volume: Math.round(vol * recentVolMult),
    });
    last = close;
  }
  for (let k = 0; k < contBars; k += 1) {
    const open = last;
    const close = last + (contAtr * atrApprox) / contBars;
    rows.push({
      timestamp: new Date(START + (total + pullbackBars + k) * 120000).toISOString(),
      open, high: close + 0.4, low: open - 0.4, close, volume: Math.round(vol * recentVolMult),
    });
    last = close;
  }
  return rows;
}

// Narrow state-serie: lugn bas + elephant breakout. Ska fångas av
// NARROW_COMPRESSION-grenen INNAN EMA-grenen nås.
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

// Kör legacy-kedjan fristående — facit för identitetstestet.
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

test('trigger: legacy EMA-rekyl ger LONG-signal', () => {
  const decision = evaluate(snapshot(), { now: new Date() });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.direction, 'LONG');
  assert.equal(decision.strategyId, STRATEGY_ID);
  assert.equal(decision.reason, 'ema_pullback_continuation_long');
  assert.equal(decision.evidence.originStrategyId, ORIGIN_STRATEGY_ID);
  assert.equal(decision.evidence.signalFamily, 'EMA_TREND_PULLBACK');
  assert.equal(decision.evidence.signalSubtype, 'EMA_PULLBACK_UP');
  // Legacy-motorn löser själv upp katalogens strategyId via runtime-mappen.
  assert.equal(decision.evidence.legacyStrategyId, ORIGIN_STRATEGY_ID);
});

test('beslutet är identiskt med legacy-kedjan', () => {
  const candles = buildCandles();
  const legacy = legacyDecision(candles);
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(legacy.signalFamily, 'EMA_TREND_PULLBACK');
  assert.equal(legacy.signalSubtype, 'EMA_PULLBACK_UP');
  assert.equal(decision.evidence.signalFamily, legacy.signalFamily);
  assert.equal(decision.evidence.signalSubtype, legacy.signalSubtype);
  assert.equal(decision.evidence.legacyStrategyId, legacy.strategyId);
  assert.equal(decision.evidence.legacyDirection, legacy.nextMoveBias);
  assert.equal(decision.evidence.legacyPriority, legacy.priority);
  assert.deepEqual(decision.evidence.timeframeAgreement, legacy.timeframeAgreement || legacy.timeframes);
});

test('samtliga indata når strategin: ema21, ema50, atr14, vwap, tf5m/15m/30m/1h, narrowState', () => {
  const decision = evaluate(snapshot(), { now: new Date() });
  const ev = decision.evidence;

  for (const key of ['ema21', 'ema50', 'atr14', 'vwap']) {
    assert.ok(typeof ev[key] === 'number' && Number.isFinite(ev[key]), `${key} saknas: ${ev[key]}`);
  }
  const tf = ev.timeframeAgreement;
  assert.ok(tf && typeof tf === 'object', 'timeframeAgreement saknas');
  for (const key of ['tf2m', 'tf5m', 'tf10m', 'tf15m', 'tf30m', 'tf1h']) {
    assert.ok(['bullish', 'bearish', 'neutral'].includes(tf[key]), `${key} = ${tf[key]}`);
  }
  assert.ok(typeof ev.narrowState === 'string' && ev.narrowState.length > 0);
  assert.ok(Number.isFinite(ev.agreementCount));
  // Trendstödet som EMA-regeln kräver ska vara verkligt räknat, inte defaultat.
  assert.ok(ev.emaAttempt && ev.emaAttempt.matched === true);
  assert.ok(ev.emaAttempt.details.majorTrendCount >= 1, 'majorTrendCount måste vara >= 1');
  assert.equal(ev.emaAttempt.details.nearPullbackLevel, true);
});

test('nivåerna följer katalogen: stop 0,22 % och take profit 1,7R', () => {
  const decision = evaluate(snapshot(), { now: new Date() });
  const entry = decision.entryPrice;

  const expectedStop = Number((Math.round((entry * (1 - 0.0022)) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.stopLoss, expectedStop);
  assert.ok(decision.stopLoss < entry, 'stop måste ligga under entry på en long');

  const risk = entry - decision.stopLoss;
  const expectedTarget = Number((Math.round((entry + risk * 1.7) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.takeProfit, expectedTarget);
  assert.ok(decision.takeProfit > entry, 'target måste ligga över entry på en long');
  assert.equal(decision.riskReward, 1.7);
});

test('narrow-kontext triggar inte — den vägen tillhör NARROW_COMPRESSION', () => {
  const candles = buildNarrowCandles();
  const decision = evaluate(snapshot({ candles }), { now: new Date() });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'ema_pullback_continuation_not_triggered');
  assert.notEqual(decision.evidence.signalSubtype, 'EMA_PULLBACK_UP');
  // Precedensen kommer från legacy classifySignalFamily, inte från den här modulen.
  assert.equal(legacyDecision(candles).signalSubtype, decision.evidence.signalSubtype);
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
