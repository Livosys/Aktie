'use strict';

const assert = require('assert/strict');
const svc = require('./entryQualityGateService');

function makeTrade(overrides = {}) {
  return {
    tradeId: 'pt_test_1',
    symbol: 'AAPL',
    strategyId: 'trend_continuation',
    setup: 'REGULAR_PULLBACK',
    result: 'LOSS',
    pnlPct: -0.21,
    openedAt: '2026-06-11T08:00:00.000Z',
    closedAt: '2026-06-11T08:07:00.000Z',
    tradeStats: {
      mfePct: 0.17,
      maePct: -0.19,
      stopLoss: 0.12,
      takeProfit: 0.24,
    },
    raw: {
      entryReasonSv: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
      statusAtEntry: 'caution',
      confidenceScore: 84,
      nextMoveBias: 'DOWN',
      gateScore: 79,
      gateThreshold: 65,
      exitReason: 'STOP_HIT',
      exitReasonCode: 'stop_hit',
      exitSource: 'exit_engine_v1',
      stopLoss: 0.12,
      takeProfit: 0.24,
      maxFavorablePct: 0.17,
      maxAdversePct: -0.19,
    },
    ...overrides,
  };
}

{
  const gate = svc.buildEntryQualityGate({ trade: makeTrade() });
  assert.equal(gate.ok, true);
  assert.equal(gate.entryQuality, 'bad');
  assert.equal(gate.checks.lateEntry.status, 'warn');
  assert.match(gate.checks.lateEntry.reason, /rörelsen redan hade gått en bit|rörelsen har gått en bit/i);
  assert.equal(gate.checks.twoMinuteConfirmation.status, 'warn');
  assert.equal(gate.checks.stopFit.status, 'warn');
  assert.match(gate.checks.stopFit.reason, /plus en stund|nästan direkt emot|stop/i);
  assert.equal(gate.checks.choppyMarket.status, 'warn');
  assert.ok(gate.recommendations.length > 0);
  assert.ok(gate.recommendations.every((item) => item.safeActionOnly === true));
  assert.ok(gate.missingFields.includes('nearbyEvents'));
}

{
  const directAgainstTrade = svc.buildEntryQualityGate({
    trade: makeTrade({
      raw: {
        entryReasonSv: 'Bevaka. Läget är nära men behöver mer stöd.',
        statusAtEntry: 'watch',
        confidenceScore: 68,
        nextMoveBias: 'UP',
        exitReason: 'STOP_HIT',
        exitReasonCode: 'stop_hit',
        exitSource: 'exit_engine_v1',
        stopLoss: 0.1,
        takeProfit: 0.2,
        maxFavorablePct: 0,
        maxAdversePct: -0.11,
      },
      tradeStats: {
        mfePct: 0,
        maePct: -0.11,
        stopLoss: 0.1,
        takeProfit: 0.2,
      },
    }),
  });
  assert.equal(directAgainstTrade.checks.stopFit.status, 'warn');
  assert.match(directAgainstTrade.checks.stopFit.reason, /nästan direkt emot/i);
}

{
  const plusFirstTrade = svc.buildEntryQualityGate({
    trade: makeTrade({
      raw: {
        entryReasonSv: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
        statusAtEntry: 'caution',
        confidenceScore: 72,
        nextMoveBias: 'DOWN',
        exitReason: 'STOP_HIT',
        exitReasonCode: 'stop_hit',
        exitSource: 'exit_engine_v1',
        stopLoss: 0.1,
        takeProfit: 0.2,
        maxFavorablePct: 0.08,
        maxAdversePct: -0.11,
      },
      tradeStats: {
        mfePct: 0.08,
        maePct: -0.11,
        stopLoss: 0.1,
        takeProfit: 0.2,
      },
    }),
  });
  assert.equal(plusFirstTrade.checks.stopFit.status, 'warn');
  assert.match(plusFirstTrade.checks.stopFit.reason, /plus en stund/i);
}

{
  const unknownGate = svc.buildEntryQualityGate({
    trade: {
      symbol: 'MSFT',
      result: 'LOSS',
    },
  });
  assert.equal(unknownGate.checks.choppyMarket.status, 'unknown');
  assert.equal(unknownGate.entryQuality, 'unknown');
  assert.ok(unknownGate.missingFields.length > 0);
}

{
  const minimal = svc.buildEntryQualityGate({
    trade: {
      symbol: 'TSLA',
    },
  });
  assert.equal(minimal.ok, true);
  assert.ok(Array.isArray(minimal.recommendations));
}

console.log('# entryQualityGateService tests passed.');
