'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-runtime-'));
const files = {
  trades: path.join(tmp, 'paper-trading/trades.jsonl'),
  events: path.join(tmp, 'paper-trading/events.jsonl'),
  gateDecisions: path.join(tmp, 'paper-trading/gate-decisions.jsonl'),
  state: path.join(tmp, 'paper-trading/state.json'),
  learningOutcomes: path.join(tmp, 'daytrading-learning/outcomes.jsonl'),
  optimizationCandidates: path.join(tmp, 'optimization/paper-candidates.jsonl'),
  optimizationLatest: path.join(tmp, 'optimization/latest.json'),
};
process.env.PAPER_STRATEGY_APPROVALS_FILE = path.join(tmp, 'paper-trading/strategy-approvals.json');
writeJson(process.env.PAPER_STRATEGY_APPROVALS_FILE, {
  schemaVersion: 1,
  strategies: {
    vwap_failed_breakout_short: { status: 'approved', source: 'test', approvedAt: '2026-06-16T00:00:00.000Z', updatedAt: '2026-06-16T00:00:00.000Z', history: [] },
    narrow_breakout: { status: 'approved', source: 'test', approvedAt: '2026-06-16T00:00:00.000Z', updatedAt: '2026-06-16T00:00:00.000Z', history: [] },
    narrow_fakeout_reversal_v1: { status: 'approved', source: 'test', approvedAt: '2026-06-16T00:00:00.000Z', updatedAt: '2026-06-16T00:00:00.000Z', history: [] },
    trend_continuation: { status: 'approved', source: 'test', approvedAt: '2026-06-16T00:00:00.000Z', updatedAt: '2026-06-16T00:00:00.000Z', history: [] },
  },
  selectedByFamily: {
    vwap_family: 'vwap_failed_breakout_short',
    narrow_state: 'narrow_fakeout_reversal_v1',
    ema_trend_family: 'trend_continuation',
  },
  updatedAt: '2026-06-16T00:00:00.000Z',
});

const svc = require('./paperTradingRuntimeService');

writeJson(files.state, {
  enabled: false,
  openTrades: [
    {
      tradeId: 'open-1',
      symbol: 'NVDA',
      direction: 'UP',
      strategyId: 'ema_pullback_continuation',
      strategyName: 'EMA Pullback Continuation',
      opened_at: '2026-06-11T09:00:00.000Z',
      entryPrice: 100,
      result: 'OPEN',
      paperOnly: true,
    },
  ],
});

writeJsonl(files.trades, [
  {
    tradeId: 'closed-1',
    symbol: 'AAPL',
    direction: 'DOWN',
    strategy_id: 'narrow_breakout',
    strategy_name: 'Narrow Breakout',
    signalSubtype: 'NARROW_WAIT',
    signalFamily: 'NARROW_COMPRESSION',
    opened_at: '2026-06-11T08:00:00.000Z',
    closed_at: '2026-06-11T08:02:00.000Z',
    result: 'LOSS',
    pnlPct: -0.21,
    paperOnly: true,
  },
  {
    tradeId: 'closed-2',
    symbol: 'SOLUSDT',
    direction: 'UP',
    strategy_id: 'narrow_state_expansion_long',
    strategy_name: 'Narrow State Expansion Long',
    signalSubtype: 'NARROW_BULL_ENTRY',
    signalFamily: 'NARROW_COMPRESSION',
    opened_at: '2026-06-11T07:00:00.000Z',
    closed_at: '2026-06-11T07:01:00.000Z',
    result: 'WIN',
    pnlPct: 0.25,
    paperOnly: true,
  },
]);

writeJsonl(files.events, [
  {
    eventId: 'evt-1',
    type: 'TRADE_OPENED',
    timestamp: '2026-06-11T09:00:00.000Z',
    symbol: 'NVDA',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    signalSubtype: 'EMA_PULLBACK_UP',
    source: 'scanner',
    paper_only: true,
  },
  {
    eventId: 'evt-2',
    type: 'RISK_BLOCKED',
    timestamp: '2026-06-11T09:01:00.000Z',
    symbol: 'GOOGL',
    strategyId: 'trend_continuation',
    reasonSv: 'low_confidence',
    source: 'scanner',
    paper_only: true,
  },
]);

writeJsonl(files.learningOutcomes, [
  {
    id: 'lo-1',
    timestamp: '2026-06-16T13:09:56.707Z',
    type: 'paper_trade_opened',
    source: 'paper_agent',
    paper_only: true,
    strategy_id: 'narrow_breakout',
    strategy_name: 'Narrow Breakout',
    symbol: 'QQQ',
    raw_strategy: 'NARROW_WAIT',
    signal_subtype: 'NARROW_WAIT',
    confidence: 92,
    score: 73,
  },
]);

writeJsonl(files.optimizationCandidates, [
  {
    candidateId: 'cand-narrow-fakeout',
    strategyId: 'narrow_fakeout_reversal_v1',
    strategyName: 'Narrow Fakeout Reversal Strategy',
    source: 'ai_agent_batch_recommendation',
    sourceLabel: 'AI-agent paper',
    createdAt: '2026-06-16T09:08:39.517Z',
    updatedAt: '2026-06-16T09:08:39.517Z',
    testedConfig: { symbol: 'QQQ', timeframe: '2m' },
    overallScore: 61,
    confidence: 72,
    metrics: { trades: 15, winRate: 60, avgPnlPct: 0.1423, totalPnlPct: 2.1338, score: 61 },
    recommendation: { decision: 'watch', reason: 'Lovande, men kräver mer data innan promotion till paper allowlist.', confidence: 'medium' },
    allowlistStatus: 'approved',
    allowlistReason: 'Strategin är redan godkänd i paper allowlist.',
  },
  {
    candidateId: 'cand-vwap-short',
    strategyId: 'vwap_failed_breakout_short',
    strategyName: 'VWAP Failed Breakout Short',
    source: 'ai_agent_batch_recommendation',
    sourceLabel: 'AI-agent paper',
    createdAt: '2026-06-16T09:57:33.400Z',
    updatedAt: '2026-06-16T09:57:33.400Z',
    overallScore: 83,
    confidence: 83,
    metrics: { trades: 3, winRate: 62.5, avgPnlPct: 0.143, totalPnlPct: 4.5772, score: 83 },
    recommendation: { decision: 'watch', reason: 'Stark resultatdata.', confidence: 'medium' },
    allowlistStatus: 'approved',
    allowlistReason: 'Strategin är redan godkänd i paper allowlist.',
  },
]);

writeJson(files.optimizationLatest, {
  daytradingStrategies: {
    bestStrategy: {
      strategy_id: 'vwap_failed_breakout_short',
      strategy_name: 'VWAP Failed Breakout Short',
      symbols: [
        { symbol: 'AAPL', runs: 2, total_pnl: 0.286 },
        { symbol: 'QQQ', runs: 2, total_pnl: 0 },
      ],
    },
  },
});

writeJsonl(files.gateDecisions, [
  {
    event_id: 'gate-1',
    timestamp: '2026-06-11T09:02:00.000Z',
    symbol: 'META',
    strategyId: 'vwap_failed_breakout_short',
    signalSubtype: 'VWAP_REJECTION_DOWN',
    signalFamily: 'VWAP_RECLAIM_REJECTION',
    allowed: false,
    reasonSv: 'compass_conflict',
  },
]);

const runtime = svc.buildPaperTradingRuntime({ files, limit: 50 });
assert.equal(runtime.ok, true);
assert.equal(runtime.mode, 'paper_only');
assert.equal(runtime.safety.live_trading_enabled, false);
assert.equal(runtime.summary.openCount, 1);
assert.equal(runtime.summary.closedCount, 2);
assert.equal(runtime.summary.limit, 50);
assert.equal(runtime.summary.returnedCount, 6);
assert.equal(runtime.tradeSource, 'paper_trading_legacy_file');
assert.equal(runtime.openTrades[0].strategy_id, 'ema_pullback_continuation');
assert.equal(runtime.closedTrades[0].strategy_id, 'narrow_breakout');
assert.equal(runtime.closedTrades[0].paperOnly, true);
assert.ok(runtime.blockedCandidates.some((row) => row.strategy_id === 'trend_continuation'));
assert.ok(runtime.blockedCandidates.some((row) => row.strategy_id === 'vwap_failed_breakout_short'));
assert.ok(runtime.strategies.some((row) => row.strategy_id === 'narrow_breakout'));
assert.ok(runtime.strategies.some((row) => row.strategy_id === 'ema_pullback_continuation'));

const summary = svc.buildSupervisorPaperRuntimeSummary({ files, limit: 5 });
assert.equal(summary.status, runtime.status);
assert.equal(summary.summary.closedCount, 2);
assert.ok(Array.isArray(summary.latestClosedTrades));
assert.ok(Array.isArray(summary.latestBlockedCandidates));
assert.equal(summary.live_trading_enabled, false);

const ibkrRuntime = svc.buildPaperTradingRuntime({
  files,
  limit: 50,
  ibkrIntents: [{
    status: 'filled',
    strategyId: 'trend_continuation',
    tradeId: 'ibkr-trade-1',
    lifecycleId: 'ibkr-life-1',
    signalId: 'ibkr-signal-1',
    candidateId: 'ibkr-candidate-1',
    intentId: 'ibkr-intent-1',
    idempotencyKey: 'ibkr-intent-1',
    executionId: 'ibkr-execution-1',
    root: 'MNQ',
    localSymbol: 'MNQU6',
    direction: 'short',
    quantity: 1,
    entryFilledPrice: 20100,
    filledPrice: 20090,
    entryFilledAt: '2026-06-11T10:00:00.000Z',
    filledAt: '2026-06-11T10:10:00.000Z',
    filledLeg: 'takeProfit',
    filledOrderId: 3101,
    filledExecId: 'ibkr-exec-1',
    entryCommission: 0.61,
    filledCommission: 0.61,
    filledRealizedPNL: 48.78,
  }, {
    status: 'submitted',
    strategyId: 'resistance_rejection',
    tradeId: 'ibkr-open-trade-1',
    lifecycleId: 'ibkr-open-life-1',
    signalId: 'ibkr-open-signal-1',
    candidateId: 'ibkr-open-candidate-1',
    intentId: 'ibkr-open-intent-1',
    idempotencyKey: 'ibkr-open-intent-1',
    executionId: 'ibkr-open-execution-1',
    root: 'MNQ',
    localSymbol: 'MNQU6',
    direction: 'long',
    quantity: 1,
    entryFilledPrice: 20050,
    entryFilledAt: '2026-06-11T10:20:00.000Z',
    ibOrderId: 3200,
    entryExecId: 'ibkr-open-entry-exec-1',
  }],
});
assert.equal(ibkrRuntime.tradeSource, 'ibkr_paper_intent');
assert.equal(ibkrRuntime.summary.openCount, 1);
assert.equal(ibkrRuntime.summary.closedCount, 1);
assert.equal(ibkrRuntime.openTrades[0].source, 'ibkr_paper_intent');
assert.equal(ibkrRuntime.openTrades[0].tradeId, 'ibkr-open-trade-1');
assert.equal(ibkrRuntime.openTrades[0].intentStatus, 'submitted');
assert.equal(ibkrRuntime.openTrades[0].brokerExecutionId, 'ibkr-open-entry-exec-1');
assert.equal(ibkrRuntime.closedTrades[0].source, 'ibkr_paper_intent');
assert.equal(ibkrRuntime.closedTrades[0].tradeId, 'ibkr-trade-1');
assert.equal(ibkrRuntime.closedTrades[0].lifecycleId, 'ibkr-life-1');
assert.equal(ibkrRuntime.closedTrades[0].candidateId, 'ibkr-candidate-1');
assert.equal(ibkrRuntime.closedTrades[0].intentId, 'ibkr-intent-1');
assert.equal(ibkrRuntime.closedTrades[0].executionId, 'ibkr-execution-1');
assert.equal(ibkrRuntime.closedTrades[0].brokerExecutionId, 'ibkr-exec-1');
assert.equal(ibkrRuntime.closedTrades[0].brokerOrderId, 3101);
assert.equal(ibkrRuntime.closedTrades[0].strategy_id, 'trend_continuation');
assert.equal(ibkrRuntime.closedTrades[0].result, 'WIN');
assert.equal(ibkrRuntime.closedTrades[0].pnl, 48.78);
assert.equal(ibkrRuntime.closedTrades[0].commission, 1.22);
assert.equal(ibkrRuntime.strategyPerformance.strategies[0].strategy_id, 'trend_continuation');
assert.equal(ibkrRuntime.strategyPerformance.strategies[0].closedTrades, 1);

const previewA = svc._internal.buildDailySelectionPreview({ files, now: '2026-06-16T14:30:00.000Z', selectionCount: 3 });
const previewB = svc._internal.buildDailySelectionPreview({ files, now: '2026-06-16T14:30:00.000Z', selectionCount: 3 });

assert.equal(previewA.mode, 'preview_only');
assert.equal(previewA.selectionCount, 3);
assert.ok(previewA.candidates.length <= 3, 'daily preview caps at 3 candidates');
assert.deepEqual(previewA.candidates.map((row) => row.canonicalStrategyId), previewB.candidates.map((row) => row.canonicalStrategyId), 'same day selection is stable');
assert.ok(!previewA.allCandidates.some((row) => row.canonicalStrategyId === 'narrow_breakout'), 'approved but not selected family member is excluded');
assert.ok(previewA.candidates.every((row) => row.previewOnly === true && row.wouldCreateTrade === false && row.blockedExecution === true), 'preview rows are read-only');

const cooldownSources = {
  tradeRows: [],
  eventRows: [
    {
      strategy_id: 'trend_continuation',
      symbol: 'AMZN',
      timestamp: '2026-06-16T14:17:26.720Z',
      type: 'TRADE_OPENED',
      source: 'paper_agent',
    },
  ],
  learningRows: [],
  candidateRows: [],
};
const cooldownBlocked = svc._internal.findLatestEligibleActivity(
  'trend_continuation',
  cooldownSources,
  { AMZN: '2026-06-16T15:00:00.000Z' },
  new Date('2026-06-16T14:30:00.000Z').getTime(),
);
assert.equal(cooldownBlocked, null, 'cooldown blocks the candidate');

console.log('# paperTradingRuntimeService tests passed.');
