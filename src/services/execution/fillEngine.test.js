'use strict';

// Acceptanskriterierna för Fas 3, ett test per krav.

const test = require('node:test');
const assert = require('node:assert/strict');

const iface = require('./fillEngineInterface');
const perfect = require('./perfectFillEngine');
const simulated = require('./simulatedFillEngine');
const report = require('./fillReportService');

const TICK = 0.25;

// Fem 1-minutersbarer efter beslutet. Priset stiger, vänder och faller.
function bars(startIso = '2026-08-14T14:00:00.000Z') {
  const t0 = new Date(startIso).getTime();
  const rows = [
    { open: 30000, high: 30012, low: 29998, close: 30010 },
    { open: 30010, high: 30030, low: 30006, close: 30028 },
    { open: 30028, high: 30032, low: 29990, close: 29994 },
    { open: 29994, high: 29996, low: 29960, close: 29964 },
    { open: 29964, high: 29970, low: 29940, close: 29946 },
  ];
  return rows.map((row, i) => ({ ...row, ts: new Date(t0 + i * 60000).toISOString() }));
}

function order(patch = {}) {
  return {
    orderId: 'ord-1',
    symbol: 'MNQ',
    side: 'buy',
    type: 'market',
    quantity: 1,
    expectedPrice: 30000,
    timestamp: '2026-08-14T13:59:30.000Z',
    ...patch,
  };
}

// ── kontraktet ───────────────────────────────────────────────────────────────

test('båda motorerna uppfyller FillEngine-kontraktet', () => {
  assert.deepEqual(iface.validateFillEngine(perfect.defaultPerfectFillEngine), { ok: true, errors: [] });
  assert.deepEqual(iface.validateFillEngine(simulated.defaultSimulatedFillEngine), { ok: true, errors: [] });
});

test('resultatet har kontraktets form oavsett utfall', () => {
  const engine = simulated.createSimulatedFillEngine({ tickSize: TICK });
  const filled = engine.fill(order(), { bars: bars() });
  const noFill = engine.fill(order({ type: 'limit', limitPrice: 1 }), { bars: bars() });
  const rejected = engine.fill(order({ side: 'sideways' }), { bars: bars() });
  for (const result of [filled, noFill, rejected]) {
    assert.deepEqual(iface.validateFillResult(result), { ok: true, errors: [] });
  }
  assert.equal(filled.status, iface.FILL_STATUS.FILLED);
  assert.equal(noFill.status, iface.FILL_STATUS.NO_FILL);
  assert.equal(rejected.status, iface.FILL_STATUS.REJECTED);
});

// ── kriterium: replay fungerar utan Fill Model ───────────────────────────────

test('utan Fill Model fylls allt till expectedPrice utan kostnad', () => {
  const engine = perfect.createPerfectFillEngine();
  const result = engine.fill(order());
  assert.equal(result.status, iface.FILL_STATUS.FILLED);
  assert.equal(result.executedPrice, 30000);
  assert.equal(result.priceDifference, 0);
  assert.equal(result.slippage, 0);
  assert.equal(result.spread, 0);
  assert.equal(result.executionCost, 0);
  assert.equal(result.fillDelayMs, 0);
});

// ── kriterium: replay fungerar med Fill Model ────────────────────────────────

test('med Fill Model fylls marknadsordern på nästa bars öppning, sämre än förväntat', () => {
  const engine = simulated.createSimulatedFillEngine({
    tickSize: TICK, slippageTicks: 1, spreadTicks: 1, latencyMs: 0,
  });
  const result = engine.fill(order(), { bars: bars() });
  assert.equal(result.status, iface.FILL_STATUS.FILLED);
  // 30000 open + 1 tick slippage + en halv tick spread = 30000.375 -> tick 30000.5
  assert.equal(result.executedPrice, 30000.5);
  assert.ok(result.priceDifference > 0, 'en köporder ska fyllas sämre, inte bättre');
  assert.equal(result.slippage, 0.25);
  assert.equal(result.spread, 0.125);
  assert.ok(result.executionCost > 0, 'exekveringen ska kosta, inte ge');
});

test('slippage går alltid emot ordern, även vid sälj', () => {
  const engine = simulated.createSimulatedFillEngine({ tickSize: TICK, latencyMs: 0 });
  const buy = engine.fill(order({ side: 'buy' }), { bars: bars() });
  const sell = engine.fill(order({ orderId: 'ord-2', side: 'sell' }), { bars: bars() });
  assert.ok(buy.executedPrice > 30000, 'köp fylls över öppningen');
  assert.ok(sell.executedPrice < 30000, 'sälj fylls under öppningen');
  assert.ok(buy.executionCost > 0 && sell.executionCost > 0, 'båda ska kosta');
});

// ── kriterium: slippage kan slås av och på ───────────────────────────────────

test('slippage kan slås av och på', () => {
  const on = simulated.createSimulatedFillEngine({ tickSize: TICK, slippageEnabled: true, spreadEnabled: false, latencyMs: 0 });
  const off = simulated.createSimulatedFillEngine({ tickSize: TICK, slippageEnabled: false, spreadEnabled: false, latencyMs: 0 });
  const withSlip = on.fill(order(), { bars: bars() });
  const without = off.fill(order(), { bars: bars() });
  assert.equal(withSlip.slippage, 0.25);
  assert.equal(without.slippage, 0);
  assert.equal(without.executedPrice, 30000, 'utan slippage och spread fylls ordern på öppningen');
  assert.ok(withSlip.executedPrice > without.executedPrice);
});

// ── kriterium: determinism ───────────────────────────────────────────────────

test('resultaten är deterministiska över körningar och instanser', () => {
  const a = simulated.createSimulatedFillEngine({ tickSize: TICK, partialFillRate: 0.5, noFillRate: 0.2 });
  const b = simulated.createSimulatedFillEngine({ tickSize: TICK, partialFillRate: 0.5, noFillRate: 0.2 });
  for (let i = 0; i < 40; i += 1) {
    const o = order({ orderId: `ord-${i}`, quantity: 4, side: i % 2 ? 'sell' : 'buy' });
    const r1 = a.fill(o, { bars: bars() });
    const r2 = b.fill(o, { bars: bars() });
    assert.deepEqual(r2, r1, `order ${i} gav olika resultat mellan två motorer`);
  }
});

test('ingen slump används — variationen kommer ur orderns identitet', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, 'simulatedFillEngine.js'), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/Math\.random/.test(source), 'Math.random gör backtestet oreproducerbart');
  assert.ok(!/Date\.now\(\)/.test(source), 'motorn får inte läsa klockan själv');
});

// ── ordertyper ───────────────────────────────────────────────────────────────

test('limit fylls bara när priset handlas genom limiten', () => {
  const engine = simulated.createSimulatedFillEngine({ tickSize: TICK, latencyMs: 0 });
  const hit = engine.fill(order({ type: 'limit', limitPrice: 29980, side: 'buy' }), { bars: bars() });
  const missed = engine.fill(order({ orderId: 'x', type: 'limit', limitPrice: 29000, side: 'buy' }), { bars: bars() });
  assert.equal(hit.status, iface.FILL_STATUS.FILLED);
  assert.equal(missed.status, iface.FILL_STATUS.NO_FILL);
  assert.equal(missed.reason, 'limit_never_touched');
  // Limitordern betalar spread men inte slippage — man får inte bättre än sin limit.
  assert.equal(hit.slippage, 0);
});

test('stop utlöses av att priset passerar nivån', () => {
  const engine = simulated.createSimulatedFillEngine({ tickSize: TICK, latencyMs: 0 });
  const triggered = engine.fill(order({ type: 'stop', stopPrice: 30025, side: 'buy' }), { bars: bars() });
  const never = engine.fill(order({ orderId: 'x', type: 'stop', stopPrice: 31000, side: 'buy' }), { bars: bars() });
  assert.equal(triggered.status, iface.FILL_STATUS.FILLED);
  assert.ok(triggered.slippage > 0, 'en utlöst stop tar slippage — det är där den gör mest skada');
  assert.equal(never.status, iface.FILL_STATUS.NO_FILL);
  assert.equal(never.reason, 'stop_never_triggered');
});

test('stopLimit kräver både utlöst stop och nådd limit', () => {
  const engine = simulated.createSimulatedFillEngine({ tickSize: TICK, latencyMs: 0 });
  const both = engine.fill(order({ type: 'stopLimit', stopPrice: 30025, limitPrice: 30035, side: 'buy' }), { bars: bars() });
  const stopOnly = engine.fill(order({ orderId: 'x', type: 'stopLimit', stopPrice: 30025, limitPrice: 29000, side: 'buy' }), { bars: bars() });
  assert.equal(both.status, iface.FILL_STATUS.FILLED);
  assert.equal(stopOnly.status, iface.FILL_STATUS.NO_FILL);
  assert.equal(stopOnly.reason, 'stop_triggered_limit_not_filled');
});

// ── latens, partiella och uteblivna fills ────────────────────────────────────

test('latens skjuter fram vilken bar som kan fylla ordern', () => {
  const fast = simulated.createSimulatedFillEngine({ tickSize: TICK, latencyMs: 0, slippageEnabled: false, spreadEnabled: false });
  const slow = simulated.createSimulatedFillEngine({ tickSize: TICK, latencyMs: 90 * 1000, slippageEnabled: false, spreadEnabled: false });
  const o = order({ timestamp: '2026-08-14T14:00:00.000Z' });
  const r1 = fast.fill(o, { bars: bars() });
  const r2 = slow.fill(o, { bars: bars() });
  assert.equal(r1.executedPrice, 30000, 'utan latens fylls första baren');
  assert.equal(r2.executedPrice, 30028, 'med 90 s latens hoppas första baren över');
  assert.ok(r2.fillDelayMs > r1.fillDelayMs);
});

test('partiella fills modelleras och redovisas ärligt', () => {
  const engine = simulated.createSimulatedFillEngine({ tickSize: TICK, partialFillRate: 1 });
  const result = engine.fill(order({ quantity: 4 }), { bars: bars() });
  assert.equal(result.status, iface.FILL_STATUS.PARTIAL);
  assert.ok(result.filledQuantity < result.requestedQuantity);
  assert.equal(result.requestedQuantity, 4);
});

test('uteblivna fills kan modelleras och ger noll kvantitet', () => {
  const engine = simulated.createSimulatedFillEngine({ tickSize: TICK, noFillRate: 1 });
  const result = engine.fill(order(), { bars: bars() });
  assert.equal(result.status, iface.FILL_STATUS.NO_FILL);
  assert.equal(result.filledQuantity, 0);
  assert.equal(result.reason, 'modelled_no_fill');
});

// ── kriterium: rapporten skiljer strategi från exekvering ────────────────────

test('rapporten redovisar execution cost skilt från strategiresultat', () => {
  const trades = [
    {
      symbol: 'MNQ', side: 'buy', quantity: 1, multiplier: 2,
      entry: { expectedPrice: 30000, executedPrice: 30000.5, fillDelayMs: 30000, slippage: 0.25, spread: 0.125, status: 'filled' },
      exit: { expectedPrice: 30030, executedPrice: 30029.5, fillDelayMs: 30000, slippage: 0.25, spread: 0.125, status: 'filled' },
    },
    {
      symbol: 'MES', side: 'sell', quantity: 1, multiplier: 5,
      entry: { expectedPrice: 7800, executedPrice: 7799.5, fillDelayMs: 60000, slippage: 0.25, spread: 0.125, status: 'filled' },
      exit: { expectedPrice: 7790, executedPrice: 7790.5, fillDelayMs: 60000, slippage: 0.25, spread: 0.125, status: 'filled' },
    },
  ];
  const r = report.buildFillReport(trades, { engine: 'simulated_fill', unfilledOrders: 1 });

  // Strategin tjänade på båda; exekveringen kostade på båda.
  assert.equal(r.strategyEdge.pnl, 30 * 2 + 10 * 5);
  assert.ok(r.executionEdge.pnl < r.strategyEdge.pnl, 'verkligt resultat ska vara sämre än strategins');
  assert.ok(r.executionEdge.totalExecutionCost > 0);
  assert.ok(r.executionEdge.costShareOfEdge > 0);
  assert.equal(r.counts.unfilledOrders, 1);
  assert.equal(r.fillRate, round2((2 / 3) * 100));

  // Fill Report-fälten finns per affär.
  for (const row of r.trades) {
    for (const field of ['expectedEntry', 'executedEntry', 'entryDifference',
      'expectedExit', 'executedExit', 'exitDifference', 'fillDelayMs',
      'slippage', 'spread', 'strategyPnl', 'executedPnl', 'executionCost']) {
      assert.ok(field in row, `fältet ${field} saknas i rapporten`);
    }
  }
});

function round2(v) { return Math.round(v * 100) / 100; }

test('Strategy Edge är opåverkad av vilken fyllningsmotor som användes', () => {
  const base = {
    symbol: 'MNQ', side: 'buy', quantity: 1, multiplier: 2,
    entry: { expectedPrice: 30000, executedPrice: 30000 },
    exit: { expectedPrice: 30030, executedPrice: 30030 },
  };
  const withCost = {
    ...base,
    entry: { expectedPrice: 30000, executedPrice: 30002 },
    exit: { expectedPrice: 30030, executedPrice: 30027 },
  };
  const a = report.buildFillReport([base]);
  const b = report.buildFillReport([withCost]);
  assert.equal(b.strategyEdge.pnl, a.strategyEdge.pnl,
    'Strategy Edge får aldrig ändras av exekvering — det är hela poängen med att mäta dem separat');
  assert.ok(b.executionEdge.pnl < a.executionEdge.pnl);
});

// ── Execution Score ──────────────────────────────────────────────────────────

test('Execution Score skiljer rent utförande från dyrt', () => {
  const clean = report.buildFillReport([{
    symbol: 'MNQ', side: 'buy', quantity: 1, multiplier: 2,
    entry: { expectedPrice: 30000, executedPrice: 30000, fillDelayMs: 0 },
    exit: { expectedPrice: 30030, executedPrice: 30030, fillDelayMs: 0 },
  }]);
  const costly = report.buildFillReport([{
    symbol: 'MNQ', side: 'buy', quantity: 1, multiplier: 2,
    entry: { expectedPrice: 30000, executedPrice: 30006, fillDelayMs: 240000 },
    exit: { expectedPrice: 30030, executedPrice: 30024, fillDelayMs: 240000 },
  }]);

  const cleanScore = report.calculateExecutionScore(clean);
  const costlyScore = report.calculateExecutionScore(costly);

  assert.ok(cleanScore.total > costlyScore.total,
    'ett rent utförande måste få högre Execution Score än ett dyrt');
  assert.ok(cleanScore.total >= 80, `rent utförande fick ${cleanScore.total}`);
  assert.equal(cleanScore.band, 'clean');
  assert.ok(costlyScore.total < 80);
  assert.equal(
    Object.values(report.EXECUTION_SCORE_MAX).reduce((a, b) => a + b, 0), 100,
    'komponenterna måste summera till 100',
  );
});

test('Execution Score är noll-säker när ingenting fyllts', () => {
  const empty = report.buildFillReport([], { unfilledOrders: 3 });
  const score = report.calculateExecutionScore(empty);
  assert.equal(empty.fillRate, 0);
  assert.ok(Number.isFinite(score.total));
  assert.equal(score.band, 'prohibitive');
});
