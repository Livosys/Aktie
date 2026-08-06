'use strict';

const assert = require('assert/strict');

process.env.IBKR_PAPER_EXECUTION_ENABLED = 'true';
process.env.IBKR_PAPER_EXECUTION_SHADOW_MODE = 'false';
process.env.IBKR_PAPER_ORDER_SUBMISSION_ENABLED = 'true';

const svc = require('./futuresPaperExecutionOnboardingService');

const now = '2026-08-06T13:30:30.000Z';
const signalTs = '2026-08-06T13:30:00.000Z';

function readyRow(strategyId, producedSubtypes) {
  return {
    strategyId,
    displayName: strategyId,
    readiness: 'READY_FOR_PAPER',
    enabledForPaper: true,
    producerStatus: 'ok',
    producedSubtypes,
    entryContractReady: true,
  };
}

function paperRow(strategyId) {
  return {
    strategyId,
    displayName: strategyId,
    latestCandidate: null,
  };
}

function futuresCandidate(overrides = {}) {
  return {
    candidateId: 'candidate-ema-1',
    signalId: 'sig-ema-1',
    strategyId: 'ema_pullback_continuation',
    signalSubtype: 'EMA_PULLBACK_UP',
    symbol: 'MNQ',
    futuresSymbol: 'MNQ',
    mappedFuturesSymbol: 'MNQ',
    direction: 'long',
    entryPrice: 20000,
    stopLoss: 19940,
    takeProfit: 20120,
    orderType: 'MKT',
    signalTimestamp: signalTs,
    timestamp: signalTs,
    createdAt: signalTs,
    market: 'stocks',
    marketType: 'stocks',
    dataSource: 'real_market_data',
    dataFreshness: 'LIVE',
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    mappingReason: 'nasdaq_100_or_large_cap_proxy',
    mapping: {
      futuresSymbol: 'MNQ',
      mappingReason: 'nasdaq_100_or_large_cap_proxy',
      mappingConfidence: 0.95,
    },
    ...overrides,
  };
}

async function main() {
  const readiness = {
    summary: { readyForPaper: 3 },
    strategies: [
      readyRow('ema_pullback_continuation', ['EMA_PULLBACK_UP']),
      readyRow('narrow_state_expansion_long', ['NARROW_BULL_ENTRY']),
      readyRow('vwap_volume_breakout_long', ['VWAP_RECLAIM_UP']),
      readyRow('trend_continuation', ['TREND_LONG']),
    ],
  };
  const paperStrategies = {
    summary: { ready: 3 },
    strategies: [
      paperRow('ema_pullback_continuation'),
      paperRow('narrow_state_expansion_long'),
      paperRow('vwap_volume_breakout_long'),
      {
        ...paperRow('trend_continuation'),
        latestCandidate: {
          at: now,
          symbol: 'QQQ',
          signalSubtype: 'TREND_LONG',
          direction: 'long',
        },
      },
    ],
  };
  const scannerRuntime = {
    scanner: {
      lastScanAt: now,
      lastScanSummary: {
        signalInputsRead: 3,
        readerSignalsRead: 3,
        providerSignalsRead: 0,
        candidatesCreated: 1,
        skippedSignalDetails: {
          noMapping: [{
            strategyId: 'vwap_volume_breakout_long',
            signalId: 'sig-vwap-1',
            symbol: 'XYZ',
            skipReason: 'no_safe_futures_mapping',
            mapping: { futuresSymbol: null, mappingReason: 'no_safe_futures_mapping' },
          }],
          noRisk: [],
          other: [],
        },
      },
    },
    candidateQueue: {
      length: 1,
      candidates: [futuresCandidate()],
    },
  };

  const result = await svc.buildExecutionOnboardingStatus({
    now,
    readiness,
    paperStrategies,
    scannerRuntime,
    latestEvents: { latestByStrategy: new Map(), countsByStrategy: new Map() },
    intentStats: new Map(),
    evaluateExecution: async () => ({
      status: 'shadow_ready',
      wouldSubmit: true,
      actualSubmit: false,
      orderSubmissionMode: 'paper_pilot',
      entryContract: {
        allowed: true,
        decisionSource: 'execution_readiness_engine',
        readiness: { verdict: 'EXECUTABLE', reasonCode: null },
      },
      guard: { allowed: true, checks: [] },
      orderPlan: { entry: { action: 'BUY', orderType: 'MKT' } },
      intent: { idempotencyKey: 'idem-1' },
      intentCreate: { created: true, record: { idempotencyKey: 'idem-1' }, readOnly: true },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.stages, svc.STAGES);
  assert.equal(result.counts.total, 4);

  const byId = Object.fromEntries(result.strategies.map((row) => [row.strategyId, row]));
  assert.equal(byId.ema_pullback_continuation.stages.producer.status, 'PASS');
  assert.equal(byId.ema_pullback_continuation.stages.candidate.status, 'PASS');
  assert.equal(byId.ema_pullback_continuation.stages.mapping.status, 'PASS');
  assert.equal(byId.ema_pullback_continuation.stages.router.status, 'PASS');
  assert.equal(byId.ema_pullback_continuation.stages.guard.status, 'PASS');
  assert.equal(byId.ema_pullback_continuation.stages.orderPlan.status, 'PASS');
  assert.equal(byId.ema_pullback_continuation.stages.intent.status, 'PASS');
  assert.equal(byId.ema_pullback_continuation.stages.ibkr.status, 'EJ_VERIFIERAT');
  assert.equal(byId.ema_pullback_continuation.status, 'EJ_VERIFIERAT_AT_IBKR');

  assert.equal(byId.vwap_volume_breakout_long.stages.producer.status, 'PASS');
  assert.equal(byId.vwap_volume_breakout_long.stages.candidate.status, 'PASS');
  assert.equal(byId.vwap_volume_breakout_long.stages.mapping.status, 'FAIL');
  assert.equal(byId.vwap_volume_breakout_long.stages.mapping.reasonCode, 'no_safe_futures_mapping');
  assert.equal(byId.vwap_volume_breakout_long.stopAt, 'mapping');

  assert.equal(byId.narrow_state_expansion_long.stages.producer.status, 'PASS');
  assert.equal(byId.narrow_state_expansion_long.stages.candidate.status, 'FAIL');
  assert.equal(byId.narrow_state_expansion_long.stages.candidate.reasonCode, 'no_current_strategy_candidate');
  assert.equal(byId.narrow_state_expansion_long.stopAt, 'candidate');

  assert.equal(byId.trend_continuation.stages.producer.status, 'PASS');
  assert.equal(byId.trend_continuation.stages.candidate.status, 'PASS');
  assert.equal(byId.trend_continuation.stages.mapping.status, 'PASS');
  assert.equal(byId.trend_continuation.stages.mapping.mappingReason, 'nasdaq_100_or_large_cap_proxy');
  assert.equal(byId.trend_continuation.stages.router.status, 'FAIL');
  assert.equal(byId.trend_continuation.stages.router.reasonCode, 'futures_candidate_not_queued');
  assert.equal(byId.trend_continuation.stopAt, 'router');

  console.log('futuresPaperExecutionOnboardingService.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
