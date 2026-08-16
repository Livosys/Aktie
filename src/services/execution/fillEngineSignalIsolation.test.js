'use strict';

// ── Fill Engine får aldrig röra en signal ────────────────────────────────────
//
// Acceptanskriterierna "Fill Engine påverkar aldrig signalerna" och "signalId
// före och efter Fill Model är identisk", prövade på RIKTIGA signaler ur den
// historiska feeden — inte på fixturer.
//
// Varför det spelar roll: så fort exekveringen kan påverka beslutet blir
// backtestet cirkulärt. Strategin skulle då kunna se ut att bli bättre av en
// billigare fyllningsmodell, och AI:n skulle lära sig välja modell i stället
// för att hitta edge.

const test = require('node:test');
const assert = require('node:assert/strict');

const historicalModule = require('../historicalPriceFeedService');
const signalProvider = require('../canonical/nativeFuturesSignalProvider');
const store = require('../../data/marketDataStore');
const iface = require('./fillEngineInterface');
const perfect = require('./perfectFillEngine');
const simulated = require('./simulatedFillEngine');
const report = require('./fillReportService');

const { defaultNativeFuturesSignalReader } = signalProvider._internal;

const ROOTS = ['MNQ', 'MES'];
const TIMEFRAME = '2m';
const REPLAY_QUOTE_AGE_MS = 2 * 60 * 1000;

function availableDay() {
  const listed = store.listAvailableDates('MNQ') || {};
  const dates = Array.isArray(listed) ? listed : [...(listed.raw || []), ...(listed['2m'] || [])];
  for (const date of [...new Set(dates)].sort().reverse()) {
    const mnq = store.loadRawBars('MNQ', date, date, 'ib') || [];
    const mes = store.loadRawBars('MES', date, date, 'ib') || [];
    if (mnq.length > 600 && mes.length > 600) return date;
  }
  return null;
}

const DAY = availableDay();

function collectSignals(feed, { count = 60, startIso } = {}) {
  const start = new Date(startIso).getTime();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const now = new Date(start + i * 2 * 60 * 1000);
    const signals = defaultNativeFuturesSignalReader({
      now, priceFeedService: feed, symbols: ROOTS, timeframe: TIMEFRAME,
      maxQuoteAgeMs: REPLAY_QUOTE_AGE_MS,
    });
    for (const signal of signals) out.push({ now, signal });
  }
  return out;
}

// Ordern byggs UR signalen. Signalen skickas aldrig in i motorn.
function orderFromSignal(signal, now, index) {
  return {
    orderId: `${signal.signalId}#${index}`,
    symbol: signal.symbol,
    side: String(signal.direction).toLowerCase() === 'short' ? 'sell' : 'buy',
    type: 'market',
    quantity: 1,
    expectedPrice: Number(signal.entryPrice),
    timestamp: new Date(now).toISOString(),
  };
}

function barsAfter(root, now, minutes = 30) {
  const date = new Date(now).toISOString().slice(0, 10);
  const nowMs = new Date(now).getTime();
  return (store.loadRawBars(root, date, date, 'ib') || [])
    .filter((bar) => {
      const ts = new Date(bar.ts || bar.t).getTime();
      return ts >= nowMs && ts <= nowMs + minutes * 60 * 1000;
    });
}

test('lagret har en dag att köra på', () => {
  assert.ok(DAY, 'ingen IB-dag i lagret');
});

test('Fill Engine påverkar aldrig signalerna, och signalId är oförändrat', () => {
  if (!DAY) return;
  const feed = historicalModule.createHistoricalPriceFeedService();
  const collected = collectSignals(feed, { count: 60, startIso: `${DAY}T13:00:00.000Z` });
  assert.ok(collected.length > 0, 'inga signaler att pröva — testet vore meningslöst');

  // Ögonblicksbild INNAN någon fyllningsmodell rört systemet.
  const before = collected.map(({ signal }) => JSON.parse(JSON.stringify(signal)));
  const idsBefore = collected.map(({ signal }) => signal.signalId);

  const engines = [
    perfect.createPerfectFillEngine(),
    simulated.createSimulatedFillEngine({ tickSize: 0.25 }),
    simulated.createSimulatedFillEngine({ tickSize: 0.25, slippageEnabled: false, spreadEnabled: false, latencyMs: 0 }),
    simulated.createSimulatedFillEngine({ tickSize: 0.25, noFillRate: 1 }),
  ];

  for (const engine of engines) {
    collected.forEach(({ signal, now }, index) => {
      const order = orderFromSignal(signal, now, index);
      const result = engine.fill(order, { bars: barsAfter(signal.symbol, now) });
      assert.deepEqual(iface.validateFillResult(result), { ok: true, errors: [] });
    });
  }

  const after = collected.map(({ signal }) => JSON.parse(JSON.stringify(signal)));
  const idsAfter = collected.map(({ signal }) => signal.signalId);

  assert.deepEqual(idsAfter, idsBefore, 'signalId ändrades av fyllningsmodellen');
  assert.deepEqual(after, before, 'en signal muterades av fyllningsmodellen');
  console.log(`    (signaler prövade mot 4 fyllningsmotorer: ${collected.length})`);
});

test('samma signaler ger olika execution cost men identisk Strategy Edge', () => {
  if (!DAY) return;
  const feed = historicalModule.createHistoricalPriceFeedService();
  const collected = collectSignals(feed, { count: 60, startIso: `${DAY}T13:00:00.000Z` });
  if (!collected.length) return;

  // Samma affärer, två fyllningsmotorer. Entry fylls av motorn; exit hålls
  // konstant så att skillnaden i rapporten enbart kommer ur exekveringen.
  function tradesWith(engine) {
    const out = [];
    collected.forEach(({ signal, now }, index) => {
      const order = orderFromSignal(signal, now, index);
      const fill = engine.fill(order, { bars: barsAfter(signal.symbol, now) });
      if (fill.status !== iface.FILL_STATUS.FILLED) return;
      const expectedExit = Number(signal.entryPrice) + (order.side === 'buy' ? 10 : -10);
      out.push({
        symbol: signal.symbol,
        side: order.side,
        quantity: 1,
        multiplier: signal.symbol === 'MES' ? 5 : 2,
        entry: {
          expectedPrice: fill.expectedPrice,
          executedPrice: fill.executedPrice,
          fillDelayMs: fill.fillDelayMs,
          slippage: fill.slippage,
          spread: fill.spread,
          status: fill.status,
        },
        exit: { expectedPrice: expectedExit, executedPrice: expectedExit, fillDelayMs: 0, slippage: 0, spread: 0, status: 'filled' },
      });
    });
    return out;
  }

  const idealTrades = tradesWith(perfect.createPerfectFillEngine());
  const realTrades = tradesWith(simulated.createSimulatedFillEngine({ tickSize: 0.25 }));
  assert.ok(idealTrades.length > 0);
  assert.equal(realTrades.length, idealTrades.length, 'lika många affärer ska ha fyllts');

  const ideal = report.buildFillReport(idealTrades, { engine: 'perfect_fill' });
  const real = report.buildFillReport(realTrades, { engine: 'simulated_fill' });

  // Strategy Edge räknas på expectedPrice och får därför INTE skilja sig.
  assert.equal(real.strategyEdge.pnl, ideal.strategyEdge.pnl,
    'Strategy Edge påverkades av fyllningsmodellen — då kan AI inte optimera mot den');

  // Execution Edge ska däremot skilja sig, och åt det dyrare hållet.
  assert.equal(ideal.executionEdge.totalExecutionCost, 0);
  assert.ok(real.executionEdge.totalExecutionCost > 0,
    'den simulerade motorn ska kosta något — annars mäter vi ingenting');
  assert.ok(real.executionEdge.pnl < ideal.executionEdge.pnl);

  const idealScore = report.calculateExecutionScore(ideal);
  const realScore = report.calculateExecutionScore(real);
  assert.ok(idealScore.total > realScore.total);
  console.log(`    (affärer: ${realTrades.length} · execution cost: ${real.executionEdge.totalExecutionCost} · Execution Score ${realScore.total} mot ${idealScore.total})`);
});
