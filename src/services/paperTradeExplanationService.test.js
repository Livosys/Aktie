'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./paperTradeExplanationService');

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function snapshot(files) {
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]));
}

function assertReadOnly(files, before) {
  for (const [key, file] of Object.entries(files)) {
    assert.equal(fs.readFileSync(file, 'utf8'), before[key], `${key} mutated`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-trade-expl-'));
const files = {
  trades: path.join(tmp, 'paper-trading/trades.jsonl'),
  events: path.join(tmp, 'paper-trading/events.jsonl'),
  state: path.join(tmp, 'paper-trading/state.json'),
};

const trades = [
  {
    tradeId: 'pt_1',
    symbol: 'AAPL',
    strategy_id: 'trend_continuation',
    strategyName: 'Trend Continuation',
    setup: 'REGULAR_PULLBACK',
    opened_at: '2026-06-11T08:00:00.000Z',
    closed_at: '2026-06-11T08:07:00.000Z',
    result: 'LOSS',
    pnlPct: -0.21,
    entryReasonSv: 'Traden öppnades eftersom signalen passade testreglerna.',
    statusAtEntry: 'caution',
    confidenceScore: 84,
    gateDecision: { allowed: true, gateMode: 'normal' },
    maxFavorablePct: 0.17,
    maxAdversePct: 0.09,
    highestPriceDuringTrade: 190.42,
    lowestPriceDuringTrade: 188.12,
    exitReason: 'STOP_HIT',
    exitReasonCode: 'stop_hit',
    exitSource: 'exit_engine_v1',
    paperOnly: true,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
  {
    symbol: 'MSFT',
    strategyId: 'trend_continuation',
    setup: 'REGULAR_PULLBACK',
    openedAt: '2026-06-11T09:00:00.000Z',
    closedAt: '2026-06-11T09:06:00.000Z',
    result: 'WIN',
    pnlPct: 0.33,
    entryReasonSv: 'Older log entry without tradeId.',
    exitReasonCode: 'take_profit',
    exitSource: 'exit_engine_v1',
    statusAtEntry: 'watch',
    confidenceScore: 73,
    gateDecision: { allowed: true, gateMode: 'normal' },
    paperOnly: true,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
  {
    symbol: 'TSLA',
    strategyId: 'trend_continuation',
    setup: 'REGULAR_PULLBACK',
    openedAt: '2026-06-11T10:00:00.000Z',
    closedAt: '2026-06-11T10:05:00.000Z',
    result: 'LOSS',
    pnlPct: -0.44,
    paperOnly: true,
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  },
];

const events = [
  {
    eventId: 'evt-open-aapl',
    type: 'TRADE_OPENED',
    timestamp: '2026-06-11T08:00:02.000Z',
    symbol: 'AAPL',
    strategyId: 'trend_continuation',
    reasonSv: 'Traden öppnades eftersom signalen passade testreglerna.',
    decision: 'opened',
    source: 'paper',
  },
  {
    eventId: 'evt-close-aapl',
    type: 'TRADE_CLOSED',
    timestamp: '2026-06-11T08:07:00.000Z',
    symbol: 'AAPL',
    strategyId: 'trend_continuation',
    reasonSv: 'Stängd med minus.',
    decision: 'closed',
    source: 'paper',
    exitReasonCode: 'stop_hit',
  },
  {
    eventId: 'evt-open-msft',
    type: 'TRADE_OPENED',
    timestamp: '2026-06-11T09:00:01.000Z',
    symbol: 'MSFT',
    strategyId: 'trend_continuation',
    reasonSv: 'Older log entry without tradeId.',
    decision: 'opened',
    source: 'paper',
  },
  {
    eventId: 'evt-close-msft',
    type: 'TRADE_CLOSED',
    timestamp: '2026-06-11T09:06:00.000Z',
    symbol: 'MSFT',
    strategyId: 'trend_continuation',
    reasonSv: 'Stängd med vinst.',
    decision: 'closed',
    source: 'paper',
    exitReasonCode: 'take_profit',
  },
];

writeJson(files.state, {
  enabled: true,
  conservativeMode: false,
  openTrades: [],
});
writeJsonl(files.trades, trades);
writeJsonl(files.events, events);

const before = snapshot(files);

const list = svc.buildTradeExplanations({ files, limit: 10 });
assert.equal(list.ok, true);
assert.equal(list.safety.mode, 'paper_only');
assert.equal(list.count, 3);

const aapl = list.items.find((item) => item.symbol === 'AAPL');
assert.ok(aapl);
assert.equal(aapl.tradeId, 'pt_1');
assert.equal(aapl.entry.reason, 'Traden öppnades eftersom signalen passade testreglerna.');
assert.equal(aapl.exit.exitType, 'stop_loss');
assert.ok(aapl.entryQualityGate);
assert.equal(aapl.entryQualityGate.checks.lateEntry.status, 'warn');
assert.ok(Array.isArray(aapl.recommendations));
assert.ok(aapl.recommendations.every((item) => item.safeActionOnly === true));
assert.ok(aapl.tradeStats.mfePct > 0);
assert.ok(aapl.tradeStats.maePct > 0);

const msft = list.items.find((item) => item.symbol === 'MSFT');
assert.ok(msft);
assert.equal(msft.tradeId, null);
assert.equal(msft.setup, 'REGULAR_PULLBACK');
assert.equal(msft.entry.reason, 'Older log entry without tradeId.');
assert.equal(msft.exit.exitType, 'take_profit');
assert.equal(msft.diagnosis.tradeStats.mfePct, null);
assert.ok(msft.entryQualityGate);
assert.ok(Array.isArray(msft.missingFields));

const tsla = list.items.find((item) => item.symbol === 'TSLA');
assert.ok(tsla);
assert.ok(tsla.diagnosis.possibleIssue.includes('Saknas i äldre loggning'));
assert.ok(tsla.diagnosis.possibleIssue.includes('entryReason'));
assert.equal(tsla.tradeStats.mfePct, null);
assert.ok(tsla.entryQualityGate);
assert.equal(tsla.entryQualityGate.checks.choppyMarket.status, 'unknown');

const lookupByFields = svc.buildTradeExplanationLookup({
  files,
  lookup: {
    symbol: 'MSFT',
    strategyId: 'trend_continuation',
    openedAt: '2026-06-11T09:00:00.000Z',
  },
});
assert.equal(lookupByFields.found, true);
assert.equal(lookupByFields.tradeExplanation.tradeId, null);
assert.equal(lookupByFields.tradeExplanation.symbol, 'MSFT');

const missingTradeIdLookup = svc.buildTradeExplanationLookup({
  files,
  lookup: {
    symbol: 'MSFT',
    strategyId: 'trend_continuation',
    openedAt: '2026-06-11T09:00:05.000Z',
  },
});
assert.equal(missingTradeIdLookup.found, true);
assert.equal(missingTradeIdLookup.tradeExplanation.symbol, 'MSFT');

const failedLookup = svc.buildTradeExplanationLookup({
  files,
  lookup: {
    symbol: 'MSFT',
    strategyId: 'wrong_strategy',
    openedAt: '2026-06-11T09:00:00.000Z',
  },
});
assert.equal(failedLookup.found, false);
assert.equal(failedLookup.diagnosis.reason, 'strategy_id_mismatch');
assert.equal(failedLookup.diagnosis.searchedSymbol, 'MSFT');
assert.equal(failedLookup.diagnosis.searchedStrategyId, 'wrong_strategy');
assert.equal(failedLookup.diagnosis.searchedOpenedAt, '2026-06-11T09:00:00.000Z');
assert.ok(failedLookup.diagnosis.availableClosestMatch);

const insufficientLookup = svc.buildTradeExplanationLookup({
  files,
  lookup: {
    symbol: 'MSFT',
  },
});
assert.equal(insufficientLookup.found, false);
assert.equal(insufficientLookup.diagnosis.reason, 'insufficient_log_fields');

assertReadOnly(files, before);

console.log('# paperTradeExplanationService tests passed.');
