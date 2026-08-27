'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const { createSignalIntelligenceLabService, SAFETY } = require('./signalIntelligenceLabService');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-intelligence-'));
const dataDir = path.join(tmpRoot, 'data');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

writeJsonl(path.join(dataDir, 'feature-logs', '2026-08-07.jsonl'), [
  {
    timestamp: '2026-08-07T12:00:00.000Z',
    symbol: 'AAPL',
    price: 100,
    timeframe: '2m',
    group: 'stocks',
    state: 'REGULAR_TREND',
    signal: 'LONG_TRIGGERED',
    eventType: 'EMA_PULLBACK_UP',
    tradeScore: 74,
    relVol20: 1.4,
    atrPct120: 88,
    bbwPct120: 71,
  },
  {
    timestamp: '2026-08-07T12:04:00.000Z',
    symbol: 'MSFT',
    price: 200,
    timeframe: '2m',
    group: 'stocks',
    state: 'REGULAR_TREND',
    signal: 'LONG_TRIGGERED',
    eventType: 'VWAP_RECLAIM_UP',
    tradeScore: 81,
    relVol20: 2.1,
    atrPct120: 92,
    bbwPct120: 84,
  },
]);

writeJsonl(path.join(dataDir, 'futures-paper', 'candidate-archive.jsonl'), [
  {
    candidateId: 'c1',
    signalId: 'AAPL_2026-08-07T12:02:00.000Z',
    originalSignalId: 'AAPL_2026-08-07T12:02:00.000Z',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    symbol: 'MNQ',
    originalSymbol: 'AAPL',
    direction: 'long',
    signalStatus: 'wait',
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: 'EMA_PULLBACK_UP',
    entryPrice: 102,
    referencePrice: 102,
    confidence: 0.92,
    createdAt: '2026-08-07T12:02:00.000Z',
    timestamp: '2026-08-07T12:02:00.000Z',
    signalTimestamp: '2026-08-07T12:02:00.000Z',
    archivedAt: '2026-08-07T12:02:10.000Z',
    archiveReason: 'paper_entry_status_not_ready',
    status: 'COMPLETED',
    extensionLevel: 'mild',
    extensionMeta: {
      level: 'mild',
      reasons: ['priceToZoneAtr=3.40', 'recentMoveAtr=2.10'],
      priceToZoneAtr: 3.4,
      recentMoveAtr: 2.1,
    },
    producerEntryReadiness: {
      status: 'not_entry_ready',
      entryReady: false,
      confirmationObserved: [
        'two_minute_confirmation',
        'closed_candle_confirmation',
        'volume_confirmation',
        'ema_pullback_reclaim',
      ],
      missingConfirmations: [],
      blockers: ['extended_move', 'status_wait'],
      evidence: {
        generatedAt: '2026-08-07T12:02:09.000Z',
        signalTimestamp: '2026-08-07T12:02:00.000Z',
        tf2m: 'bullish',
        twoMinuteConfirmed: true,
        closedCandle: {
          confirmed: true,
          source: 'fixture',
          close: 102,
          volume: 1250,
        },
        volume: {
          state: 'strong',
          rvol: 1.8,
          strong: true,
        },
        emaContext: {
          hasContext: true,
          trendIntact: true,
          reclaimConfirmed: true,
          relation: 'above_ema21',
        },
        extensionLevel: 'mild',
        extensionReasons: ['priceToZoneAtr=3.40', 'recentMoveAtr=2.10'],
      },
    },
  },
]);

writeJsonl(path.join(dataDir, 'futures-paper', 'events.jsonl'), [
  {
    type: 'FUTURES_SCANNER_CANDIDATES_ADDED',
    timestamp: '2026-08-07T12:06:05.000Z',
    scanId: 'scan_fixture',
    candidates: [
      {
        candidateId: 'c2',
        signalId: 'MSFT_2026-08-07T12:06:00.000Z',
        originalSignalId: 'MSFT_2026-08-07T12:06:00.000Z',
        strategyId: 'vwap_volume_breakout_long',
        strategyName: 'VWAP Volume Breakout Long',
        symbol: 'MNQ',
        originalSymbol: 'MSFT',
        direction: 'long',
        signalStatus: 'ready',
        signalFamily: 'VWAP',
        signalSubtype: 'VWAP_RECLAIM_UP',
        entryPrice: 202,
        referencePrice: 202,
        confidence: 0.88,
        createdAt: '2026-08-07T12:06:00.000Z',
        timestamp: '2026-08-07T12:06:00.000Z',
        signalTimestamp: '2026-08-07T12:06:00.000Z',
        producerEntryReadiness: {
          status: 'entry_ready',
          entryReady: true,
          confirmationObserved: [
            'two_minute_confirmation',
            'closed_candle_confirmation',
            'volume_confirmation',
            'vwap_reclaim_confirmation',
          ],
          missingConfirmations: [],
          blockers: [],
          evidence: {
            generatedAt: '2026-08-07T12:06:08.000Z',
            signalTimestamp: '2026-08-07T12:06:00.000Z',
            tf2m: 'bullish',
            twoMinuteConfirmed: true,
            closedCandle: {
              confirmed: true,
              source: 'fixture',
              close: 202,
              volume: 2200,
            },
            volume: {
              state: 'strong',
              rvol: 2.4,
              strong: true,
            },
            vwapContext: {
              hasContext: true,
              reclaimConfirmed: true,
              priceVsVwap: 'above',
            },
            extensionLevel: 'none',
          },
        },
      },
    ],
  },
]);

writeJson(path.join(dataDir, 'futures-paper', 'candidates.json'), { candidates: [] });
writeJson(path.join(dataDir, 'futures-paper', 'positions.json'), { positions: [] });

writeJson(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intent-index.json'), {
  idem_c2: {
    lifecycle_id: 'life_c2',
    candidate_id: 'c2',
    signal_id: 'MSFT_2026-08-07T12:06:00.000Z',
    intent_id: 'intent_c2',
    execution_id: 'exec_c2',
    idempotency_key: 'idem_c2',
    status: 'filled',
    createdAt: '2026-08-07T12:06:20.000Z',
    updatedAt: '2026-08-07T12:07:10.000Z',
    submitStartedAt: '2026-08-07T12:06:25.000Z',
    strategyId: 'vwap_volume_breakout_long',
    candidateId: 'c2',
    root: 'MNQ',
    direction: 'long',
    signalTimestamp: '2026-08-07T12:06:00.000Z',
    orderRef: 'TOS-PAPER-exec_c2-entry',
    ibOrderId: 11,
    filledAt: '2026-08-07T12:07:00.000Z',
    filledPrice: 202.5,
  },
});

writeJsonl(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intents.jsonl'), [
  {
    type: 'status_change',
    lifecycle_id: 'life_c2',
    candidate_id: 'c2',
    signal_id: 'MSFT_2026-08-07T12:06:00.000Z',
    intent_id: 'intent_c2',
    idempotency_key: 'idem_c2',
    execution_id: 'exec_c2',
    status: 'filled',
    filledPrice: 202.5,
    filledQuantity: 1,
    at: '2026-08-07T12:07:05.000Z',
  },
]);

writeJsonl(path.join(dataDir, 'futures-paper', 'trades.jsonl'), [
  {
    lifecycle_id: 'life_c2',
    trade_id: 'trade_c2',
    candidate_id: 'c2',
    signal_id: 'MSFT_2026-08-07T12:06:00.000Z',
    original_signal_id: 'MSFT_2026-08-07T12:06:00.000Z',
    intent_id: 'intent_c2',
    execution_id: 'exec_c2',
    idempotency_key: 'idem_c2',
    symbol: 'MNQ',
    originalSymbol: 'MSFT',
    strategyId: 'vwap_volume_breakout_long',
    openedAt: '2026-08-07T12:07:05.000Z',
    closedAt: '2026-08-07T12:15:00.000Z',
    status: 'closed',
    realizedPnlSek: 140,
  },
]);

writeJsonl(path.join(dataDir, 'events', 'trading-events.jsonl'), []);
writeJsonl(path.join(dataDir, 'interactive-brokers', 'paper-execution-events.jsonl'), []);
writeJsonl(path.join(dataDir, 'interactive-brokers', 'paper-executions.jsonl'), []);

const service = createSignalIntelligenceLabService({
  dataDir,
  now: () => new Date('2026-08-07T13:00:00.000Z'),
  defaultDays: 1,
  defaultTailBytes: 1024 * 1024,
});

{
  assert.equal(SAFETY.mutation_allowed, false, 'service is observability only');
  assert.equal(SAFETY.can_place_orders, false, 'service cannot place orders');
}

{
  const overview = service.buildOverview({ days: 1, full: 1, limit: 20 });
  assert.equal(overview.ok, true, 'overview ok');
  assert.equal(overview.summary.setups, 2, 'two setups observed');
  assert.equal(overview.summary.candidates, 2, 'two candidates observed');
  assert.equal(overview.summary.entryReady, 1, 'one entry-ready candidate');
  assert.equal(overview.summary.trades, 1, 'one trade observed');
  assert.ok(overview.blockers.some((row) => row.code === 'extended_move'), 'extended_move blocker counted');

  const vwap = overview.scorecard.find((row) => row.strategyId === 'vwap_volume_breakout_long');
  assert.ok(vwap, 'vwap scorecard exists');
  assert.equal(vwap.winRate, 100, 'vwap closed trade is a win');
}

{
  const payload = service.getSignal('c1', { days: 1, full: 1 });
  assert.equal(payload.ok, true, 'signal detail ok');
  const stages = payload.signal.timeline.map((row) => row.stage);
  assert.ok(stages.includes('first_setup'), 'first setup stage present');
  assert.ok(stages.includes('candidate_created'), 'candidate stage present');
  assert.ok(stages.includes('extension'), 'extension stage present');
  assert.ok(stages.includes('entry_ready'), 'entry readiness stage present');
  assert.equal(payload.signal.metrics.delaySeconds, 120, 'setup-to-candidate delay measured');
  assert.equal(payload.signal.metrics.extensionBeginsAt, '2026-08-07T12:02:09.000Z', 'extension start measured');
  assert.equal(payload.signal.firstBlocker.code, 'extended_move', 'first blocker captured');
}

{
  const payload = service.getSignal('c2', { days: 1, full: 1 });
  assert.equal(payload.ok, true, 'trade signal detail ok');
  assert.equal(payload.signal.lifecycleId, 'life_c2', 'snake_case lifecycle id merged');
  assert.equal(payload.signal.candidateId, 'c2', 'candidate id retained');
  assert.equal(payload.signal.signalId, 'MSFT_2026-08-07T12:06:00.000Z', 'signal id retained');
  assert.equal(payload.signal.intentId, 'intent_c2', 'snake_case intent id merged');
  assert.equal(payload.signal.executionId, 'exec_c2', 'snake_case execution id merged');
  assert.equal(payload.signal.idempotencyKey, 'idem_c2', 'snake_case idempotency key merged');
  assert.equal(payload.signal.tradeId, 'trade_c2', 'snake_case trade id merged');
  assert.equal(payload.signal.status, 'closed_trade', 'closed trade status');
  assert.equal(payload.signal.flags.hasFill, true, 'fill observed');
  assert.equal(payload.signal.flags.hasTrade, true, 'trade observed');
  assert.equal(payload.signal.flags.won, true, 'win observed');
  assert.ok(payload.replay.steps.some((step) => step.stage === 'ibkr_order'), 'ibkr order step present');

  const byLifecycle = service.getSignal('life_c2', { days: 1, full: 1 });
  assert.equal(byLifecycle.ok, true, 'lifecycle lookup ok');
  assert.equal(byLifecycle.signal.signalKey, payload.signal.signalKey, 'lifecycle lookup resolves same record');
}

console.log('Signal Intelligence Lab service tests passed.');
