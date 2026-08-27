'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const { createSignalCounterfactualAnalyticsService } = require('./signalCounterfactualAnalyticsService');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-counterfactual-'));
const dataDir = path.join(tmpRoot, 'data');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

writeJsonl(path.join(dataDir, 'futures-paper', 'candidate-archive.jsonl'), [
  {
    candidateId: 'blocked_extended_loss',
    signalId: 'AAPL_2026-08-07T12:02:00.000Z',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    symbol: 'AAPL',
    originalSymbol: 'AAPL',
    direction: 'long',
    signalStatus: 'wait',
    signalSubtype: 'EMA_PULLBACK_UP',
    entryPrice: 100,
    referencePrice: 100,
    stopLoss: 99,
    takeProfit: 102,
    riskReward: 2,
    createdAt: '2026-08-07T12:02:00.000Z',
    timestamp: '2026-08-07T12:02:00.000Z',
    signalTimestamp: '2026-08-07T12:02:00.000Z',
    archivedAt: '2026-08-07T12:02:10.000Z',
    archiveReason: 'paper_entry_status_not_ready',
    status: 'COMPLETED',
    extensionLevel: 'mild',
    extensionMeta: {
      level: 'mild',
      recentMoveAtr: 2.2,
      priceToZoneAtr: 3.5,
    },
    producerEntryReadiness: {
      status: 'not_entry_ready',
      entryReady: false,
      confirmationObserved: ['two_minute_confirmation', 'closed_candle_confirmation', 'volume_confirmation', 'ema_pullback_reclaim'],
      missingConfirmations: [],
      blockers: ['extended_move', 'status_wait'],
      evidence: {
        generatedAt: '2026-08-07T12:02:09.000Z',
        extensionLevel: 'mild',
        closedCandle: { confirmed: true, close: 100, volume: 900 },
        volume: { strong: true, rvol: 1.8 },
        emaContext: { reclaimConfirmed: true },
      },
    },
  },
  {
    lifecycle_id: 'life_volume_win',
    candidateId: 'blocked_volume_win',
    signalId: 'MSFT_2026-08-07T12:06:00.000Z',
    intent_id: 'intent_volume_win',
    execution_id: 'exec_volume_win',
    idempotency_key: 'idem_volume_win',
    strategyId: 'vwap_volume_breakout_long',
    strategyName: 'VWAP Volume Breakout Long',
    symbol: 'MSFT',
    originalSymbol: 'MSFT',
    direction: 'long',
    signalStatus: 'wait',
    signalSubtype: 'VWAP_RECLAIM_UP',
    entryPrice: 200,
    referencePrice: 200,
    stopLoss: 198,
    takeProfit: 204,
    riskReward: 2,
    createdAt: '2026-08-07T12:06:00.000Z',
    timestamp: '2026-08-07T12:06:00.000Z',
    signalTimestamp: '2026-08-07T12:06:00.000Z',
    archivedAt: '2026-08-07T12:06:10.000Z',
    archiveReason: 'paper_entry_status_not_ready',
    status: 'COMPLETED',
    producerEntryReadiness: {
      status: 'not_entry_ready',
      entryReady: false,
      confirmationObserved: ['two_minute_confirmation', 'closed_candle_confirmation', 'vwap_reclaim_confirmation'],
      missingConfirmations: ['volume_confirmation'],
      blockers: ['volume_confirmation', 'status_wait'],
      evidence: {
        generatedAt: '2026-08-07T12:06:09.000Z',
        extensionLevel: 'none',
        closedCandle: { confirmed: true, close: 200, volume: 700 },
        volume: { strong: false, rvol: 0.8 },
        vwapContext: { reclaimConfirmed: true },
      },
    },
  },
]);

writeJson(path.join(dataDir, 'futures-paper', 'candidates.json'), { candidates: [] });
writeJson(path.join(dataDir, 'futures-paper', 'positions.json'), { positions: [] });
writeJson(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intent-index.json'), {});
writeJsonl(path.join(dataDir, 'events', 'trading-events.jsonl'), []);
writeJsonl(path.join(dataDir, 'futures-paper', 'events.jsonl'), []);
writeJsonl(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intents.jsonl'), []);
writeJsonl(path.join(dataDir, 'interactive-brokers', 'paper-execution-events.jsonl'), []);
writeJsonl(path.join(dataDir, 'interactive-brokers', 'paper-executions.jsonl'), []);
writeJsonl(path.join(dataDir, 'futures-paper', 'trades.jsonl'), []);

const candlesBySymbol = {
  AAPL: [
    ['2026-08-07T11:56:00.000Z', 99.8, 100.1, 99.6, 100],
    ['2026-08-07T11:58:00.000Z', 100, 100.2, 99.9, 100.1],
    ['2026-08-07T12:00:00.000Z', 100.1, 100.3, 99.9, 100],
    ['2026-08-07T12:04:00.000Z', 100, 100.2, 98.8, 99],
    ['2026-08-07T12:08:00.000Z', 99, 99.1, 98.5, 98.7],
    ['2026-08-07T12:30:00.000Z', 98.7, 99, 98.2, 98.5],
  ],
  MSFT: [
    ['2026-08-07T12:00:00.000Z', 199.5, 200, 199.2, 199.8],
    ['2026-08-07T12:02:00.000Z', 199.8, 200.2, 199.5, 200],
    ['2026-08-07T12:04:00.000Z', 200, 200.3, 199.7, 200],
    ['2026-08-07T12:08:00.000Z', 200, 202.5, 199.8, 202],
    ['2026-08-07T12:10:00.000Z', 202, 206.2, 201.8, 205.5],
    ['2026-08-07T12:40:00.000Z', 205.5, 206.5, 204, 205],
  ],
};

function toCandle([ts, open, high, low, close]) {
  return { ts, t: ts, open, high, low, close, o: open, h: high, l: low, c: close, volume: 1000 };
}

const service = createSignalCounterfactualAnalyticsService({
  dataDir,
  now: () => new Date('2026-08-07T13:00:00.000Z'),
  defaultLimit: 20,
  loadCandles(symbol) {
    return (candlesBySymbol[symbol] || []).map(toCandle);
  },
});

{
  const overview = service.buildOverview({ days: 1, full: 1, minSamples: 1, limit: 20 });
  assert.equal(overview.ok, true, 'overview ok');
  assert.equal(overview.summary.blockedSignals, 2, 'two blocked signals');
  assert.equal(overview.summary.analyzed, 2, 'two analyzed signals');

  const extended = overview.blockerGroups.find((row) => row.blocker === 'extended_move');
  assert.ok(extended, 'extended group exists');
  assert.equal(extended.verdict, 'protective', 'extended saved from bad trade');
  assert.equal(extended.expectedRR, -1, 'extended expected -1R');
  assert.equal(extended.lossRate, 100, 'extended loss rate');

  const volume = overview.blockerGroups.find((row) => row.blocker === 'volume');
  assert.ok(volume, 'volume group exists');
  assert.equal(volume.verdict, 'overblocking', 'volume blocked a good trade');
  assert.equal(volume.expectedRR, 1, 'volume expected first-touch +1R');
  assert.equal(volume.winRate, 100, 'volume win rate');

  const recentVolume = overview.recentSignals.find((row) => row.candidateId === 'blocked_volume_win');
  assert.equal(recentVolume.lifecycleId, 'life_volume_win', 'counterfactual overview keeps lifecycle id');
  assert.equal(recentVolume.intentId, 'intent_volume_win', 'counterfactual overview keeps intent id');
  assert.equal(recentVolume.executionId, 'exec_volume_win', 'counterfactual overview keeps execution id');
  assert.equal(recentVolume.idempotencyKey, 'idem_volume_win', 'counterfactual overview keeps idempotency key');
}

{
  const payload = service.getSignal('exec_volume_win', { days: 1, full: 1, minSamples: 1, limit: 20 });
  assert.equal(payload.ok, true, 'signal payload ok');
  assert.equal(payload.signal.lifecycleId, 'life_volume_win', 'counterfactual detail keeps lifecycle id');
  assert.equal(payload.signal.intentId, 'intent_volume_win', 'counterfactual detail keeps intent id');
  assert.equal(payload.signal.executionId, 'exec_volume_win', 'counterfactual detail keeps execution id');
  assert.equal(payload.signal.idempotencyKey, 'idem_volume_win', 'counterfactual detail keeps idempotency key');
  assert.equal(payload.signal.targetHitR3, true, 'RR3 target hit');
  assert.equal(payload.signal.expectedR, 1, 'signal expected first-touch +1R');
  assert.equal(payload.signal.horizons['10'].targetHitR3, true, '+10m RR3 hit');
}

console.log('Signal Counterfactual Analytics tests passed.');
