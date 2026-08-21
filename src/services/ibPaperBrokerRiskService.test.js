'use strict';

const assert = require('assert');
const paperConfig = require('./ibPaperExecutionConfigService');
const risk = require('./ibPaperBrokerRiskService');

process.env.IBKR_PAPER_PILOT_SYMBOLS = 'MNQ,MES';
process.env.IBKR_PAPER_PILOT_MAX_QUANTITY = '1';
process.env.IBKR_PAPER_MAX_STOP_RISK_USD = '1000';
process.env.IBKR_PAPER_MAX_CONTRACT_NOTIONAL_USD = '100000';

const quote = {
  root: 'MNQ',
  source: 'ibkr_realtime',
  simulated: false,
  delayed: false,
  updatedAt: '2026-07-15T22:29:55.000Z',
  last: 23000,
  bid: 22999.75,
  ask: 23000,
  spread: 0.25,
  tickSize: 0.25,
};

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    openOrders: [],
    positions: [],
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, true);
  assert(result.stopRiskUsd > 0);
}

{
  const result = risk.evaluateBrokerRisk({
    executionTarget: 'ibkr_live',
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    openOrders: [],
    positions: [],
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'U***123', classification: 'live_or_unknown', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.executionTarget, 'ibkr_live');
  assert.equal(result.environment, 'live');
  assert.equal(result.paperOnly, false);
}

{
  const result = risk.evaluateBrokerRisk({
    executionTarget: 'ibkr_live',
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    openOrders: [],
    positions: [],
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('live_account_summary_missing'));
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote: { ...quote, bid: 22999.75, ask: 23002, spread: 2.25 },
    openOrders: [],
    positions: [],
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.spreadTicks, 9);
  assert.equal(result.blockers.includes('spread_too_wide'), false);
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22000,
    quote,
    openOrders: [],
    positions: [],
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.stopRiskUsd, 2000);
  assert.equal(result.limits.maxStopRiskUsd, 1000);
  assert.equal(result.blockers.includes('stop_risk_too_large'), false);
  assert.equal(result.checks.some((check) => check.blocker === 'stop_risk_too_large'), false);
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 59990,
    quote: { ...quote, last: 60000, bid: 59999.75, ask: 60000 },
    openOrders: [],
    positions: [],
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.contractNotionalUsd, 120000);
  assert.equal(result.exposureUsd, 120000);
  assert.equal(result.limits.maxContractNotionalUsd, 100000);
  assert.equal(result.blockers.includes('contract_notional_too_large'), false);
  assert.equal(result.checks.some((check) => check.blocker === 'contract_notional_too_large'), false);
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'NQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote: { ...quote, root: 'NQ' },
    positions: [],
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('symbol_not_allowlisted'));
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 2,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    // Precis över taket, läst ur konfigurationen i stället för som en siffra:
    // paper-taket har flyttats två gånger och testet ska inte behöva följa med
    // en tredje. En enda rad räcker — räknaren summerar |kvantitet|, inte rader.
    positions: [{ position: paperConfig.HARD_MAX_OPEN_POSITIONS }],
    reconciliation: { degraded: true },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
	  assert(result.blockers.includes('quantity_must_be_exactly_one'));
	  assert(result.blockers.includes('max_open_broker_positions'));
	  assert(result.blockers.includes('reconciliation_degraded'));
	}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 0.1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('quantity_must_be_exactly_one'));
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: '1',
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('quantity_must_be_exactly_one'));
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote: { ...quote, bid: undefined, ask: undefined, spread: undefined },
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('quote_bid_missing'));
  assert(result.blockers.includes('quote_ask_missing'));
  assert(result.blockers.includes('spread_unknown'));
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 } },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, true);
  assert(!result.blockers.includes('account_summary_stale'));
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: 22980,
    quote,
    accountSummary: { ok: true, generatedAt: '2026-07-15T22:20:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 } },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('account_summary_stale'));
}

{
  const result = risk.evaluateBrokerRisk({
    root: 'MNQ',
    quantity: 1,
    orderType: 'MKT',
    stopLossPrice: null,
	    quote: { ...quote, delayed: true, source: 'ibkr_delayed' },
	    positions: [],
	    accountSummary: { ok: true, generatedAt: '2026-07-15T22:30:00.000Z', account: { accountIdMasked: 'DU***596', classification: 'paper', realizedPnl: 0 }, cacheAgeMs: 1000 },
    reconciliation: { degraded: false },
    now: new Date('2026-07-15T22:30:00.000Z'),
  });
  assert.equal(result.allowed, false);
  assert(result.blockers.includes('stop_loss_required'));
  assert(result.blockers.includes('quote_not_realtime_ibkr'));
}

console.log('ibPaperBrokerRiskService.test.js passed');
