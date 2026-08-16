'use strict';

// `node src/services/futuresPaperStrategyPerformanceService.test.js`

const assert = require('assert');
const perf = require('./futuresPaperStrategyPerformanceService');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`); process.exitCode = 1; }
}

function t(strategyId, netPnlSek, extra = {}) {
  return { strategyId, netPnlSek, grossPnlSek: extra.grossPnlSek ?? netPnlSek, feesSek: extra.feesSek ?? 0, dataSource: extra.dataSource ?? 'simulated_fallback', provenance: extra.provenance ?? 'stored_net' };
}

function intent(strategyId, realizedPnl, extra = {}) {
  return {
    status: extra.status ?? 'filled',
    strategyId,
    filledRealizedPNL: realizedPnl,
    filledExecId: extra.execId ?? `filled-${strategyId}-${realizedPnl}`,
    entryCommission: extra.entryCommission ?? 0,
    filledCommission: extra.filledCommission ?? 0,
    ...extra,
  };
}

// 13) Historisk net PnL summeras korrekt (+ gross/fees).
test('net/gross/fees sum correctly', () => {
  const [s] = perf.aggregateTrades([
    t('a', 100, { grossPnlSek: 110, feesSek: 10 }),
    t('a', -40, { grossPnlSek: -30, feesSek: 10 }),
  ]);
  assert.strictEqual(s.netPnlSek, 60);
  assert.strictEqual(s.grossPnlSek, 80);
  assert.strictEqual(s.feesSek, 20);
  assert.strictEqual(s.bestTradeSek, 100);
  assert.strictEqual(s.worstTradeSek, -40);
});

// 14) Win rate = wins / closedTrades * 100.
test('win rate computed correctly', () => {
  const [s] = perf.aggregateTrades([t('a', 10), t('a', 20), t('a', -5), t('a', -5)]);
  assert.strictEqual(s.wins, 2);
  assert.strictEqual(s.losses, 2);
  assert.strictEqual(s.closedTrades, 4);
  assert.strictEqual(s.winRatePct, 50);
  assert.strictEqual(s.avgNetPnlSek, 5); // (10+20-5-5)/4
});

// 15) Break-even (net==0) ingår i totalen men ej i wins/losses.
test('breakeven counted in total, not wins/losses', () => {
  const [s] = perf.aggregateTrades([t('a', 10), t('a', 0), t('a', -10)]);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.breakevenTrades, 1);
  assert.strictEqual(s.closedTrades, 3);
  assert.strictEqual(s.winRatePct, round1(1 / 3 * 100)); // ~33.3
});
function round1(x) { return Math.round(x * 10) / 10; }

// 16) Profit factor hanterar noll förluster.
test('profit factor handles zero losses', () => {
  const [allWins] = perf.aggregateTrades([t('a', 10), t('a', 20)]);
  assert.strictEqual(allWins.profitFactor, null);
  assert.strictEqual(allWins.profitFactorNote, 'no_losing_trades');
  const [mixed] = perf.aggregateTrades([t('b', 30), t('b', -10)]);
  assert.strictEqual(mixed.profitFactor, 3); // 30 / abs(-10)
});

// 17) Fee-provenance: stored/derived/mixed korrekt.
test('fee provenance stored/derived/mixed', () => {
  const [stored] = perf.aggregateTrades([t('a', 5, { provenance: 'stored_net' })]);
  assert.strictEqual(stored.pnlProvenance, 'stored_net');
  const [derived] = perf.aggregateTrades([t('b', 5, { provenance: 'derived_with_current_commission' })]);
  assert.strictEqual(derived.pnlProvenance, 'derived_with_current_commission');
  const [mixed] = perf.aggregateTrades([t('c', 5, { provenance: 'stored_net' }), t('c', -5, { provenance: 'derived_with_current_commission' })]);
  assert.strictEqual(mixed.pnlProvenance, 'mixed');
  assert.strictEqual(mixed.pnlCalculationSources.stored_net, 1);
  assert.strictEqual(mixed.pnlCalculationSources.derived_with_current_commission, 1);
});

// 18) Högst win rate / avg kräver minst fem trades.
test('rate leaders require >= 5 trades', () => {
  const list = perf.aggregateTrades([
    // strategi hi: 4 trades, 100% win → hög win rate men FÅ trades
    t('hi', 10), t('hi', 10), t('hi', 10), t('hi', 10),
    // strategi lo: 6 trades, 50% win
    t('lo', 10), t('lo', 10), t('lo', 10), t('lo', -10), t('lo', -10), t('lo', -10),
  ]);
  const leaders = perf.buildLeaders(list);
  assert.strictEqual(leaders.highestWinRate.strategyId, 'lo', 'hi har <5 trades och kan ej vinna win-rate-leader');
  assert.strictEqual(leaders.minTradesForRateLeaders, 5);
  assert.strictEqual(leaders.performanceContext, 'ibkr_paper');
  assert.strictEqual(leaders.notRealMarketPerformance, false);
});

// 18b) Tie-break: lika värde → fler trades, sedan strategyId.
test('leader tie-break by trades then strategyId', () => {
  const list = perf.aggregateTrades([
    t('bbb', 50), t('bbb', 50),
    t('aaa', 100),
  ]);
  // mostWins: bbb har 2 wins, aaa 1 → bbb
  assert.strictEqual(perf.buildLeaders(list).mostWins.strategyId, 'bbb');
});

// 19) Live perf-invarianter: wins+losses+breakeven=closed, win rate, simulated context.
test('IBKR paper performance invariants hold', () => {
  const out = perf.getPerformance({
    executions: [
      { strategyId: 'trend_continuation', realizedResult: 125, commission: 2.5, execId: 'exec-1' },
      { strategyId: 'trend_continuation', realizedResult: -25, commission: 2.5, execId: 'exec-2' },
      { strategyId: 'trend_continuation', realizedResult: null, commission: 2.5, execId: 'exec-open-entry' },
    ],
    intents: [],
  });
  assert.strictEqual(out.performanceContext, 'ibkr_paper');
  assert.strictEqual(out.executionSource, 'ibkr_paper');
  assert.strictEqual(out.notRealMarketPerformance, false);
  assert.strictEqual(out.legacySimulationExcluded, true);
  for (const s of out.strategies) {
    assert.strictEqual(s.wins + s.losses + s.breakevenTrades, s.closedTrades, `${s.strategyId} count mismatch`);
    if (s.closedTrades > 0) {
      assert.strictEqual(s.winRatePct, round1(s.wins / s.closedTrades * 100));
      assert.deepStrictEqual(s.executionSources, ['ibkr_paper']);
      assert.strictEqual(s.pnlProvenance, 'broker_fill');
    }
  }
});

test('open broker executions without realized PnL are not closed trades', () => {
  const out = perf.getPerformance({
    executions: [
      { strategyId: 'trend_continuation', realizedResult: null, commission: 2.5, execId: 'exec-open-entry' },
      { strategyId: 'trend_continuation', commission: 2.5, execId: 'exec-missing-realized-pnl' },
    ],
    intents: [],
  });
  assert.strictEqual(out.count, 0);
  assert.deepStrictEqual(out.strategies, []);
});

test('IBKR intent history is included in active performance', () => {
  const out = perf.getPerformance({
    executions: [],
    intents: [
      intent('trend_continuation', 71.28, { execId: 'intent-exit-1', entryCommission: 0.61, filledCommission: 0.61 }),
      intent('trend_continuation', -10, { execId: 'intent-exit-2' }),
    ],
  });
  assert.strictEqual(out.count, 1);
  const [s] = out.strategies;
  assert.strictEqual(s.strategyId, 'trend_continuation');
  assert.strictEqual(s.closedTrades, 2);
  assert.strictEqual(s.netPnlSek, 61.28);
  assert.strictEqual(s.feesSek, 1.22);
  assert.deepStrictEqual(s.executionSources, ['ibkr_paper']);
  assert.strictEqual(s.pnlProvenance, 'broker_fill');
});

test('live broker executions de-duplicate matching filled intents', () => {
  const out = perf.getPerformance({
    executions: [
      { strategyId: 'trend_continuation', realizedResult: 25, commission: 1, execId: 'same-exit' },
    ],
    intents: [
      intent('trend_continuation', 25, { execId: 'same-exit', entryCommission: 1, filledCommission: 1 }),
    ],
  });
  const [s] = out.strategies;
  assert.strictEqual(s.closedTrades, 1);
  assert.strictEqual(s.netPnlSek, 25);
  assert.strictEqual(s.feesSek, 1);
});

test('execution target filters mixed paper and live performance rows', () => {
  const out = perf.getPerformance({
    executionTarget: 'ibkr_live',
    executions: [
      { strategyId: 'trend_continuation', realizedResult: 25, commission: 1, execId: 'live-exit', orderRef: 'TOS-LIVE-live-exit-takeProfit' },
      { strategyId: 'trend_continuation', realizedResult: 99, commission: 1, execId: 'paper-exit', orderRef: 'TOS-PAPER-paper-exit-takeProfit' },
    ],
    intents: [
      intent('trend_continuation', 25, { execId: 'live-exit', executionTarget: 'ibkr_live', orderRef: 'TOS-LIVE-live-exit-entry' }),
      intent('trend_continuation', 99, { execId: 'paper-exit', executionTarget: 'ibkr_paper', orderRef: 'TOS-PAPER-paper-exit-entry' }),
    ],
  });
  assert.strictEqual(out.executionTarget, 'ibkr_live');
  assert.strictEqual(out.performanceContext, 'ibkr_live');
  assert.strictEqual(out.executionSource, 'ibkr_live');
  assert.strictEqual(out.paper_only, false);
  const [s] = out.strategies;
  assert.strictEqual(s.closedTrades, 1);
  assert.strictEqual(s.netPnlSek, 25);
  assert.deepStrictEqual(s.executionSources, ['ibkr_live']);
});

test('performance map uses the same IBKR intent source', () => {
  const map = perf.getPerformanceMap({
    executions: [],
    intents: [intent('trend_continuation', 10, { execId: 'map-exit' })],
  });
  assert.strictEqual(map.get('trend_continuation').closedTrades, 1);
});

// 20) Vanlig Paper Trading blandas inte in och legacy-ledgern är separat.
test('does not read normal paper trading data as active source', () => {
  const src = require('fs').readFileSync(require.resolve('./futuresPaperStrategyPerformanceService.js'), 'utf8');
  assert.ok(!/paper-trading\/trades|paperTradingAgent|automation-approvals/.test(src), 'must not read normal paper trading sources');
  assert.ok(/buildLegacyStrategyStats/.test(src), 'legacy simulation remains a separate archive reader');
  assert.ok(/ibPaperExecutionOrchestratorService/.test(src), 'active performance reads cached IBKR paper executions');
  assert.ok(/ibPaperExecutionIntentService/.test(src), 'active performance reads persisted IBKR paper intents');
});

if (process.exitCode) console.error(`\nfuturesPaperStrategyPerformanceService: FAILURES (passed ${passed})`);
else console.log(`\nfuturesPaperStrategyPerformanceService: all ${passed} tests passed`);
