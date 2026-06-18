'use strict';

const assert = require('assert');
const { createLossReviewQueueService } = require('./lossReviewQueueService');

function freezeDeep(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const item of Object.values(value)) freezeDeep(item);
  return value;
}

function makeTrade(overrides = {}) {
  return {
    tradeId: overrides.tradeId || `trade_${Math.random().toString(16).slice(2, 8)}`,
    symbol: overrides.symbol || 'BTCUSDT',
    strategyId: overrides.strategyId || 'trend_continuation',
    setup: overrides.setup || 'REGULAR_PULLBACK',
    result: overrides.result || 'LOSS',
    pnlPct: overrides.pnlPct ?? -0.18,
    openedAt: overrides.openedAt || '2026-06-15T19:00:00.000Z',
    closedAt: overrides.closedAt || '2026-06-15T19:12:00.000Z',
    paperOnly: true,
    statusAtEntry: overrides.statusAtEntry || 'caution',
    bias: overrides.bias || 'DOWN',
    confidenceScore: overrides.confidenceScore ?? 82,
    tradeStats: {
      mfePct: overrides.mfePct ?? -0.01,
      maePct: overrides.maePct ?? -0.18,
      stopLoss: overrides.stopLoss ?? 0.2,
      takeProfit: overrides.takeProfit ?? 0.25,
    },
    raw: overrides.raw || {},
  };
}

function makeExplanation(overrides = {}) {
  return {
    tradeId: overrides.tradeId || null,
    symbol: overrides.symbol || 'BTCUSDT',
    strategyId: overrides.strategyId || 'trend_continuation',
    setup: overrides.setup || 'REGULAR_PULLBACK',
    result: overrides.result || 'LOSS',
    pnlPct: overrides.pnlPct ?? -0.18,
    openedAt: overrides.openedAt || '2026-06-15T19:00:00.000Z',
    closedAt: overrides.closedAt || '2026-06-15T19:12:00.000Z',
    tradeStats: overrides.tradeStats || {
      mfePct: overrides.mfePct ?? -0.01,
      maePct: overrides.maePct ?? -0.18,
      stopLoss: overrides.stopLoss ?? 0.2,
      takeProfit: overrides.takeProfit ?? 0.25,
    },
    entry: overrides.entry || {
      reason: overrides.entryReason || 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
      status: overrides.statusAtEntry || 'caution',
      bias: overrides.bias || 'DOWN',
      confidence: overrides.confidenceScore ?? 82,
      gateStage: 'normal',
      setup: overrides.setup || 'REGULAR_PULLBACK',
      signalStrength: overrides.confidenceScore ?? 82,
      explanation: 'Entry explanation',
    },
    exit: overrides.exit || {
      reason: overrides.exitReason || 'TIMEOUT',
      exitType: overrides.exitType || 'timeout',
      exitSource: overrides.exitSource || 'paper_runtime',
      explanation: 'Exit explanation',
    },
    diagnosis: overrides.diagnosis || {
      summary: 'Closed trade ended with LOSS.',
      whyWinOrLoss: 'Traden blev LOSS eftersom stoppnivån eller en stop-lik exitregel träffades.',
      lesson: overrides.lesson || 'Mönstret visar att entry inte höll tillräckligt länge.',
      possibleIssue: 'Possible issue',
      missingFields: overrides.missingFields || [],
    },
    nearbyEvents: overrides.nearbyEvents || [],
    entryQualityGate: overrides.entryQualityGate || null,
    missingFields: overrides.missingFields || [],
  };
}

function buildServiceFixture() {
  const trades = freezeDeep([
    makeTrade({
      tradeId: 't_late_1',
      symbol: 'BTCUSDT',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'DOWN',
      confidenceScore: 82,
      pnlPct: -0.21,
      mfePct: -0.01,
      maePct: -0.21,
    }),
    makeTrade({
      tradeId: 't_late_2',
      symbol: 'NVDA',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'DOWN',
      confidenceScore: 83,
      pnlPct: -0.17,
      mfePct: -0.01,
      maePct: -0.17,
    }),
    makeTrade({
      tradeId: 't_2m_1',
      symbol: 'TSLA',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'DOWN',
      confidenceScore: 79,
      pnlPct: -0.14,
      mfePct: 0.01,
      maePct: -0.14,
    }),
    makeTrade({
      tradeId: 't_stop_1',
      symbol: 'AAPL',
      strategyId: 'narrow_breakout',
      setup: 'NARROW_BEAR_ENTRY',
      statusAtEntry: 'watch',
      bias: 'DOWN',
      confidenceScore: 76,
      pnlPct: -0.11,
      mfePct: 0.08,
      maePct: -0.11,
      raw: { exitReason: 'STOP_HIT' },
    }),
    makeTrade({
      tradeId: 't_choppy_1',
      symbol: 'AMZN',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'UP',
      confidenceScore: 68,
      pnlPct: -0.08,
      mfePct: 0.00,
      maePct: -0.08,
    }),
    makeTrade({
      tradeId: 't_missing_1',
      symbol: 'MSFT',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'unknown',
      bias: 'DOWN',
      confidenceScore: null,
      pnlPct: -0.09,
      mfePct: null,
      maePct: null,
    }),
  ]);

  const explanationsByTradeId = freezeDeep({
    t_late_1: makeExplanation({
      tradeId: 't_late_1',
      symbol: 'BTCUSDT',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'DOWN',
      confidenceScore: 82,
      pnlPct: -0.21,
      mfePct: -0.01,
      maePct: -0.21,
      entryReason: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
      missingFields: [],
      entryQualityGate: {
        ok: true,
        entryQuality: 'bad',
        score: 31,
        checks: {
          lateEntry: { status: 'warn', reason: 'Entry togs sent efter att rörelsen redan hade gått en bit.' },
          twoMinuteConfirmation: { status: 'warn', reason: 'Entrytexten nämner ny 2m-bekräftelse.' },
          stopFit: { status: 'pass', reason: 'Stop loss ser inte ut att vara huvudproblemet i denna trade.' },
          choppyMarket: { status: 'pass', reason: 'Inga tydliga tecken på choppy marknad i tillgänglig loggning.' },
        },
        recommendations: [],
        missingFields: [],
      },
    }),
    t_late_2: makeExplanation({
      tradeId: 't_late_2',
      symbol: 'NVDA',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'DOWN',
      confidenceScore: 83,
      pnlPct: -0.17,
      mfePct: -0.01,
      maePct: -0.17,
      entryQualityGate: {
        ok: true,
        entryQuality: 'bad',
        score: 32,
        checks: {
          lateEntry: { status: 'warn', reason: 'Entry togs sent efter att rörelsen redan hade gått en bit.' },
          twoMinuteConfirmation: { status: 'warn', reason: 'Entrytexten nämner ny 2m-bekräftelse.' },
          stopFit: { status: 'pass', reason: 'Stop loss ser inte ut att vara huvudproblemet i denna trade.' },
          choppyMarket: { status: 'pass', reason: 'Inga tydliga tecken på choppy marknad i tillgänglig loggning.' },
        },
        recommendations: [],
        missingFields: [],
      },
    }),
    t_2m_1: makeExplanation({
      tradeId: 't_2m_1',
      symbol: 'TSLA',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'DOWN',
      confidenceScore: 79,
      pnlPct: -0.14,
      mfePct: 0.01,
      maePct: -0.14,
      entryReason: 'Entry väntar på ny 2m-bekräftelse.',
      entryQualityGate: {
        ok: true,
        entryQuality: 'caution',
        score: 55,
        checks: {
          lateEntry: { status: 'pass', reason: 'Entry ser inte sen ut.' },
          twoMinuteConfirmation: { status: 'warn', reason: 'Entrytexten nämner ny 2m-bekräftelse.' },
          stopFit: { status: 'pass', reason: 'Stop loss ser inte ut att vara huvudproblemet i denna trade.' },
          choppyMarket: { status: 'pass', reason: 'Inga tydliga tecken på choppy marknad i tillgänglig loggning.' },
        },
        recommendations: [],
        missingFields: [],
      },
    }),
    t_stop_1: makeExplanation({
      tradeId: 't_stop_1',
      symbol: 'AAPL',
      strategyId: 'narrow_breakout',
      setup: 'NARROW_BEAR_ENTRY',
      statusAtEntry: 'watch',
      bias: 'DOWN',
      confidenceScore: 76,
      pnlPct: -0.11,
      mfePct: 0.08,
      maePct: -0.11,
      exitReason: 'STOP_HIT',
      exitType: 'stop_loss',
      exitSource: 'exit_engine_v1',
      entryQualityGate: {
        ok: true,
        entryQuality: 'caution',
        score: 51,
        checks: {
          lateEntry: { status: 'pass', reason: 'Entry ser inte sen ut.' },
          twoMinuteConfirmation: { status: 'pass', reason: 'Inga tydliga tecken på att en extra 2m-bekräftelse behövdes.' },
          stopFit: { status: 'warn', reason: 'Traden var plus en stund men stoppades senare; testa trailing eller tidigare exit.' },
          choppyMarket: { status: 'pass', reason: 'Inga tydliga tecken på choppy marknad i tillgänglig loggning.' },
        },
        recommendations: [],
        missingFields: [],
      },
    }),
    t_choppy_1: makeExplanation({
      tradeId: 't_choppy_1',
      symbol: 'AMZN',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'caution',
      bias: 'UP',
      confidenceScore: 68,
      pnlPct: -0.08,
      mfePct: 0.00,
      maePct: -0.08,
      nearbyEvents: [{ type: 'blocked', reason: 'blocked', status: 'blocked' }, { type: 'blocked', reason: 'blocked', status: 'blocked' }],
      entryQualityGate: {
        ok: true,
        entryQuality: 'bad',
        score: 39,
        checks: {
          lateEntry: { status: 'pass', reason: 'Entry ser inte sen ut.' },
          twoMinuteConfirmation: { status: 'pass', reason: 'Inga tydliga tecken på att en extra 2m-bekräftelse behövdes.' },
          stopFit: { status: 'pass', reason: 'Stop loss ser inte ut att vara huvudproblemet i denna trade.' },
          choppyMarket: { status: 'warn', reason: 'Många närliggande blocked events tyder på en ryckig eller osäker miljö.' },
        },
        recommendations: [],
        missingFields: [],
      },
    }),
    t_missing_1: makeExplanation({
      tradeId: 't_missing_1',
      symbol: 'MSFT',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'unknown',
      bias: 'DOWN',
      confidenceScore: null,
      pnlPct: -0.09,
      mfePct: null,
      maePct: null,
      missingFields: ['entryReason', 'statusAtEntry', 'confidenceScore', 'maxFavorablePct', 'maxAdversePct', 'exitReason', 'exitReasonCode', 'exitSource'],
      entryQualityGate: {
        ok: true,
        entryQuality: 'unknown',
        score: 0,
        checks: {
          lateEntry: { status: 'unknown', reason: 'Data saknas för att bedöma om entry var sen.' },
          twoMinuteConfirmation: { status: 'unknown', reason: 'Data saknas för att bedöma behovet av 2m-bekräftelse.' },
          stopFit: { status: 'unknown', reason: 'Data saknas för att bedöma stop loss-passform.' },
          choppyMarket: { status: 'unknown', reason: 'Data saknas för att bedöma om marknaden var ryckig.' },
        },
        recommendations: [],
        missingFields: ['entryReason', 'statusAtEntry', 'confidenceScore', 'maxFavorablePct', 'maxAdversePct', 'exitReason', 'exitReasonCode', 'exitSource'],
      },
    }),
  });

  const service = createLossReviewQueueService({
    trades,
    resolveTradeExplanation: (trade) => ({
      ok: true,
      found: true,
      tradeExplanation: explanationsByTradeId[trade.tradeId] || null,
    }),
  });

  return { service, trades, explanationsByTradeId };
}

function run() {
  const { service, trades, explanationsByTradeId } = buildServiceFixture();
  const result = service.getLossReviewQueue();

  assert.equal(result.ok, true, 'ok');
  assert.deepEqual(result.safety, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  }, 'safety');
  assert.equal(result.summary.totalClosed, 6, 'closed count');
  assert.equal(result.summary.totalLosses, 6, 'loss count');
  assert.equal(result.summary.reviewedLosses, 6, 'reviewed count');
  assert.equal(result.summary.topIssue, 'late_entry', 'top issue');
  assert.equal(result.summary.topStrategyIssue, 'trend_continuation', 'top strategy');
  assert.ok(Array.isArray(result.groups), 'groups array');

  const lateEntry = result.groups.find((group) => group.issueType === 'late_entry');
  assert.ok(lateEntry, 'late_entry group exists');
  assert.equal(lateEntry.count, 2, 'late_entry count');
  assert.equal(lateEntry.strategyId, 'trend_continuation', 'late_entry strategy');
  assert.equal(lateEntry.setup, 'REGULAR_PULLBACK', 'late_entry setup');
  assert.ok(lateEntry.recommendation.safeActionOnly, 'late_entry safeActionOnly');
  assert.ok(lateEntry.recommendation.proposedVariant.name.includes('late_entry'), 'late_entry variant');

  const twoMinute = result.groups.find((group) => group.issueType === 'missing_2m_confirmation');
  assert.ok(twoMinute, 'missing_2m_confirmation group exists');
  assert.equal(twoMinute.count, 1, '2m count');

  const stopLoss = result.groups.find((group) => group.issueType === 'stop_loss_hit');
  assert.ok(stopLoss, 'stop_loss_hit group exists');
  assert.equal(stopLoss.count, 1, 'stop count');
  assert.ok(stopLoss.examples[0].explanation.length > 0, 'stop example explanation');

  const choppy = result.groups.find((group) => group.issueType === 'choppy_market');
  assert.ok(choppy, 'choppy group exists');
  assert.equal(choppy.count, 1, 'choppy count');
  assert.ok(choppy.recommendation.safeActionOnly, 'choppy safeActionOnly');

  const preview = service.buildTestPreview(lateEntry.id);
  assert.equal(preview.ok, true, 'preview ok');
  assert.equal(preview.preview.mode, 'paper_only', 'preview mode');
  assert.equal(preview.preview.actions_allowed, false, 'preview actions false');
  assert.equal(preview.preview.queue_item.strategy_id, 'trend_continuation', 'preview strategy');
  assert.equal(preview.preview.queue_item.test_type, 'replay', 'preview test type');

  assert.deepEqual(trades.map((trade) => trade.tradeId), ['t_late_1', 't_late_2', 't_2m_1', 't_stop_1', 't_choppy_1', 't_missing_1'], 'trades preserved');
  assert.ok(explanationsByTradeId.t_late_1.entryQualityGate, 'fixture explanation intact');

  const missingPreview = service.buildTestPreview('not-real');
  assert.equal(missingPreview.ok, false, 'missing preview fails');
  assert.equal(missingPreview.error, 'loss_group_not_found', 'missing preview error');

  const resultAgain = service.getLossReviewQueue();
  assert.deepEqual(
    {
      summary: { ...resultAgain.summary, generatedAt: null },
      groups: resultAgain.groups.map((group) => group.id),
      missingFields: resultAgain.missingFields,
    },
    {
      summary: { ...result.summary, generatedAt: null },
      groups: result.groups.map((group) => group.id),
      missingFields: result.missingFields,
    },
    'read-only repeat is stable',
  );

  const missingService = createLossReviewQueueService({
    trades: [makeTrade({
      tradeId: 't_missing_1',
      symbol: 'MSFT',
      strategyId: 'trend_continuation',
      setup: 'REGULAR_PULLBACK',
      statusAtEntry: 'unknown',
      bias: 'DOWN',
      confidenceScore: null,
      pnlPct: -0.09,
      mfePct: 0.12,
      maePct: -0.08,
    })],
    resolveTradeExplanation: () => ({
      ok: true,
      found: true,
      tradeExplanation: makeExplanation({
        tradeId: 't_missing_1',
        symbol: 'MSFT',
        strategyId: 'trend_continuation',
        setup: 'REGULAR_PULLBACK',
        statusAtEntry: 'unknown',
        bias: 'DOWN',
        confidenceScore: null,
        pnlPct: -0.09,
        mfePct: 0.12,
        maePct: -0.08,
        missingFields: ['entryReason', 'statusAtEntry'],
        entryQualityGate: {
          ok: true,
          entryQuality: 'unknown',
          score: 0,
          checks: {
            lateEntry: { status: 'unknown', reason: 'Data saknas för att bedöma om entry var sen.' },
            twoMinuteConfirmation: { status: 'unknown', reason: 'Data saknas för att bedöma behovet av 2m-bekräftelse.' },
            stopFit: { status: 'unknown', reason: 'Data saknas för att bedöma stop loss-passform.' },
            choppyMarket: { status: 'unknown', reason: 'Data saknas för att bedöma om marknaden var ryckig.' },
          },
          recommendations: [],
          missingFields: ['entryReason', 'statusAtEntry'],
        },
      }),
    }),
  });
  const missingResult = missingService.getLossReviewQueue();
  const missing = missingResult.groups.find((group) => group.issueType === 'missing_logging_fields');
  assert.ok(missing, 'missing logging group exists');
  assert.equal(missing.count, 1, 'missing count');
  assert.ok(missing.missingFields.includes('entryReason'), 'missing fields captured');

  console.log('# lossReviewQueueService tests passed.');
}

run();
