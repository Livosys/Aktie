'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRATEGY_ID,
  ORIGIN_STRATEGY_ID,
  evaluateNativeFuturesNarrowStateExpansionStrategy: evaluate,
} = require('./nativeFuturesNarrowStateExpansionStrategyService');

const NOW = new Date('2026-08-13T18:00:00.000Z');
const START = Date.parse('2026-08-13T06:00:00.000Z');

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

// Serien byggs i native-snapshotens fältnamn (open/high/low/close/volume). Parametrarna
// dipAtr/riseAtr styr hur långt priset dippar under zonen och hur stor utbrottsbaren är —
// de avgör vilket tillstånd den riktiga narrowState-motorn hamnar i.
function buildCandles({ n = 230, base = 30000, qr = 4, dipAtr = 1.2, riseAtr = 2.2, volMult = 6 } = {}) {
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
    timestamp: NOW.toISOString(),
    ...overrides,
  };
}

test('trigger: narrow state + bullish elephant breakout ger LONG-signal', () => {
  const decision = evaluate(snapshot({}, { dipAtr: 1.2, riseAtr: 2.2 }), { now: NOW });

  assert.equal(decision.decision, 'SIGNAL');
  assert.equal(decision.direction, 'LONG');
  assert.equal(decision.strategyId, STRATEGY_ID);
  assert.equal(decision.reason, 'narrow_state_expansion_long');
  assert.equal(decision.evidence.originStrategyId, ORIGIN_STRATEGY_ID);
  assert.ok(['HIGH_QUALITY_NARROW', 'MEDIUM_NARROW'].includes(decision.evidence.narrowState));
  assert.equal(decision.evidence.eventType, 'BULLISH_ELEPHANT_BREAKOUT');
  assert.equal(decision.evidence.engineSignal, 'LONG_TRIGGERED');
  assert.equal(decision.evidence.elephantBarActive, true);
});

test('nivåerna följer katalogen: stop 0,2 % och take profit 1,7R', () => {
  const decision = evaluate(snapshot({}, { dipAtr: 1.2, riseAtr: 2.2 }), { now: NOW });
  const entry = decision.entryPrice;

  // Stop 0,2 % under entry, avrundat till tick.
  const expectedStop = Number((Math.round((entry * 0.998) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.stopLoss, expectedStop);
  assert.ok(decision.stopLoss < entry, 'stop måste ligga under entry på en long');

  // Take profit = entry + 1,7 x risk.
  const risk = entry - decision.stopLoss;
  const expectedTarget = Number((Math.round((entry + risk * 1.7) / 0.25) * 0.25).toFixed(2));
  assert.equal(decision.takeProfit, expectedTarget);
  assert.ok(decision.takeProfit > entry, 'target måste ligga över entry på en long');
  assert.equal(decision.riskReward, 1.7);
});

test('elephant breakout UTAN narrow state triggar inte — den vägen tillhör en annan strategi', () => {
  // dip 0,8 / rise 1,9 ger REGULAR_TREND + BULLISH_ELEPHANT_BREAKOUT i motorn.
  const decision = evaluate(snapshot({}, { dipAtr: 0.8, riseAtr: 1.9 }), { now: NOW });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'narrow_state_expansion_not_triggered');
  assert.equal(decision.evidence.eventType, 'BULLISH_ELEPHANT_BREAKOUT');
  assert.equal(decision.evidence.narrowState, 'REGULAR_TREND');
  assert.equal(decision.direction, null);
});

test('narrow state utan utbrott triggar inte', () => {
  const decision = evaluate(snapshot({}, { dipAtr: 1.2, riseAtr: 1.6 }), { now: NOW });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.ok(['HIGH_QUALITY_NARROW', 'MEDIUM_NARROW'].includes(decision.evidence.narrowState));
  assert.notEqual(decision.evidence.eventType, 'BULLISH_ELEPHANT_BREAKOUT');
});

test('strategin går aldrig short', () => {
  // Spegelvänd serie: kraftig nedåtbar där en both-direction-strategi hade gett SHORT.
  const candles = buildCandles({ dipAtr: 1.2, riseAtr: 2.2 });
  const mirrored = candles.map((row) => ({
    ...row,
    open: 60000 - row.open,
    high: 60000 - row.low,
    low: 60000 - row.high,
    close: 60000 - row.close,
  }));
  const decision = evaluate(snapshot({ candles: mirrored }), { now: NOW });

  assert.notEqual(decision.direction, 'SHORT');
  assert.ok(decision.decision !== 'SIGNAL' || decision.direction === 'LONG');
});

test('för kort historik ger NO_SIGNAL, inte krasch', () => {
  const candles = buildCandles().slice(-10);
  const decision = evaluate(snapshot({ candles }), { now: NOW });

  assert.equal(decision.decision, 'NO_SIGNAL');
  assert.equal(decision.reason, 'insufficient_candle_history');
  assert.equal(decision.evidence.candlesAvailable, 10);
});

test('kontraktsgrindarna delas med momentumstrategin', () => {
  const decision = evaluate(snapshot({
    contract: { ...CONTRACT, secType: 'STK' },
    contractStatus: 'invalid',
    contractErrors: ['contract_not_fut:STK'],
  }), { now: NOW });

  assert.equal(decision.decision, 'BLOCKED');
  assert.equal(decision.ok, false);
  assert.ok(decision.blockers.includes('invalid_contract'));
});

test('stängd session blockerar', () => {
  const decision = evaluate(snapshot({ sessionStatus: 'closed' }), { now: NOW });

  assert.equal(decision.decision, 'BLOCKED');
  assert.ok(decision.blockers.includes('session_closed'));
});
