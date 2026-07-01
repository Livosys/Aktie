'use strict';

const assert = require('assert');
const svc = require('./interactiveBrokersScannerControlRoomService');

const runtime = {
  dailySelectionPreview: {
    candidates: [
      {
        symbol: 'BTCUSDT',
        canonicalStrategyId: 'crypto_momentum',
        source: 'scanner',
        direction: 'UP',
        score: 71,
        entryPrice: null,
        stopLossPrice: '',
        takeProfitPrice: undefined,
        latestActivityAt: '2026-07-01T10:00:00.000Z',
      },
      {
        symbol: 'MSFT',
        canonicalStrategyId: 'trend_continuation',
        source: 'scanner',
        direction: 'DOWN',
        score: 66,
        latestActivityAt: '2026-07-01T10:01:00.000Z',
      },
    ],
  },
  openTrades: [],
  closedTrades: [
    {
      symbol: 'QQQ',
      strategy_id: 'trend_continuation',
      direction: 'DOWN',
      result: 'WIN',
      pnlPct: 0.1,
      timestamp: '2026-07-01T10:02:00.000Z',
    },
  ],
};

const multiStrategyPlan = {
  candidates: [
    {
      symbol: 'AAPL',
      strategyId: 'breakout',
      source: 'trade_blueprint',
      side: 'BUY',
      confidence: 'high',
      allowed: false,
      blockers: ['missing_stop_loss'],
      setupBuilder: {
        setupReady: false,
        bracketReady: false,
        blockers: ['missing_stop_loss'],
      },
      timestamp: '2026-07-01T10:03:00.000Z',
    },
  ],
};

const auditCandidates = {
  events: [
    {
      timestamp: '2026-07-01T10:04:00.000Z',
      source: 'scanner',
      symbol: 'SPY',
      strategy_id: null,
      type: 'SIGNAL_DETECTED',
      details: { group: 'nasdaq', score: 40, signal: 'WAIT_PULLBACK' },
    },
  ],
};

const result = svc.buildScannerControlRoom({
  runtime,
  multiStrategyPlan,
  auditCandidates,
  signalMemoryRows: [
    {
      symbol: 'ETHUSDT',
      direction: 'UP',
      score: 50,
      confidence: 80,
      created_at: '2026-07-01T10:05:00.000Z',
      source: 'signal_memory',
    },
  ],
});

assert.equal(result.ok, true);
assert.equal(result.readOnly, true);
assert.equal(result.safety.can_place_orders, false);
assert.equal(result.summary.ibPaperOrderCount, 0);
assert.equal(result.summary.paperTradeCount, 1);
assert.equal(result.latest50.crypto.length, 2);
assert.equal(result.latest50.stocks.length, 2);
assert.equal(result.latest50.qqqEtf.length, 2);
assert.equal(result.latest50.qqqEtf[0].symbol, 'SPY');
assert.equal(result.paperTrades.latest[0].isIbPaperOrder, false);
assert.equal(result.liveScanner.candidates.some((row) => row.symbol === 'AAPL' && row.kind === 'candidate'), true);

const btc = result.liveScanner.candidates.find((row) => row.symbol === 'BTCUSDT');
assert.equal(btc.entryPrice, null);
assert.equal(btc.stopLossPrice, null);
assert.equal(btc.takeProfitPrice, null);
assert.equal(btc.hasEntryPrice, false);
assert.equal(btc.hasStopLossPrice, false);
assert.equal(btc.hasTakeProfitPrice, false);
assert.equal(btc.priceSource, 'missing');
assert.equal(btc.missingPriceReason, 'missing_entry_price_stop_loss_take_profit');
assert.deepEqual(btc.candidateLineage, {
  stage: 'runtime_preview',
  source: 'scanner',
  upstreamStage: 'scanner_signal',
  rawKind: null,
});
assert.equal(btc.candidateType, 'candidate');
assert.equal(btc.setupBuilderApplied, false);
assert.equal(btc.setupBuilderReason, 'not_applied_to_raw_runtime_candidate');

const aapl = result.liveScanner.candidates.find((row) => row.symbol === 'AAPL');
assert.equal(aapl.candidateLineage.stage, 'multi_strategy_plan');
assert.equal(aapl.candidateLineage.upstreamStage, 'trade_blueprint');
assert.equal(aapl.setupBuilderApplied, true);
assert.equal(aapl.setupBuilderReason, 'setup_builder_blocked');

const ethSignal = result.signals.latest.find((row) => row.symbol === 'ETHUSDT');
assert.equal(ethSignal.candidateType, 'signal');
assert.equal(ethSignal.candidateLineage.stage, 'scanner_signal');
assert.equal(ethSignal.setupBuilderApplied, false);

console.log('interactiveBrokersScannerControlRoomService tests passed');
