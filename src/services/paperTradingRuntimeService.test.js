'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./paperTradingRuntimeService');

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
};

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

console.log('# paperTradingRuntimeService tests passed.');
