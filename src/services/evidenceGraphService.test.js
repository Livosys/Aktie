'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const { createEvidenceGraphService, GRAPH_STAGES, SAFETY } = require('./evidenceGraphService');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-graph-'));
const dataDir = path.join(tmpRoot, 'data');

const LIFE = 'signal_lifecycle_evidence_26b';
const SIGNAL = 'signal_evidence_26b';
const CANDIDATE = 'candidate_evidence_26b';
const INTENT = 'intent_evidence_26b';
const EXECUTION = 'execution_evidence_26b';
const IDEMPOTENCY = 'idempotency_evidence_26b';
const TRADE = 'trade_evidence_26b';
const BROKER_ORDER = '900126';

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

const candidate = {
  lifecycleId: LIFE,
  signalId: SIGNAL,
  originalSignalId: SIGNAL,
  candidateId: CANDIDATE,
  strategyId: 'mnq_globex_momentum_v1',
  strategyName: 'MNQ Globex Momentum',
  symbol: 'MNQ',
  root: 'MNQ',
  originalSymbol: 'MNQ',
  marketType: 'futures',
  direction: 'long',
  signalStatus: 'ready',
  signalFamily: 'GLOBEX',
  signalSubtype: 'GLOBEX_MOMENTUM',
  entryPrice: 18500,
  referencePrice: 18500,
  stopLoss: 18490,
  takeProfit: 18520,
  riskReward: 2,
  confidence: 0.91,
  sessionId: 'globex',
  session: 'globex',
  isMarketOpen: true,
  timeframe: '2m',
  tf2m: 'bullish',
  closedCandleConfirmed: true,
  volumeState: 'strong',
  rvol: 1.8,
  extensionLevel: 'none',
  createdAt: '2026-08-07T12:06:00.000Z',
  timestamp: '2026-08-07T12:06:00.000Z',
  signalTimestamp: '2026-08-07T12:06:00.000Z',
  producerEntryReadiness: {
    status: 'entry_ready',
    entryReady: true,
    confirmationObserved: ['closed_candle_confirmation'],
    missingConfirmations: [],
    blockers: [],
    evidence: {
      generatedAt: '2026-08-07T12:06:08.000Z',
      signalTimestamp: '2026-08-07T12:06:00.000Z',
      tf2m: 'bullish',
      closedCandle: {
        confirmed: true,
        source: 'fixture',
        close: 18500,
        volume: 1800,
      },
      volume: {
        state: 'strong',
        rvol: 1.8,
        strong: true,
      },
      extensionLevel: 'none',
    },
  },
};

writeJsonl(path.join(dataDir, 'feature-logs', '2026-08-07.jsonl'), [
  {
    timestamp: '2026-08-07T12:04:00.000Z',
    symbol: 'MNQ',
    timeframe: '2m',
    state: 'GLOBEX',
    signal: 'LONG_TRIGGERED',
    eventType: 'GLOBEX_MOMENTUM',
    strategyId: 'mnq_globex_momentum_v1',
    tradeScore: 80,
  },
]);

writeJsonl(path.join(dataDir, 'futures-paper', 'events.jsonl'), [
  {
    type: 'FUTURES_SCANNER_CANDIDATES_ADDED',
    timestamp: '2026-08-07T12:06:05.000Z',
    scanId: 'scan_evidence_26b',
    lifecycleId: LIFE,
    signalId: SIGNAL,
    candidateId: CANDIDATE,
    candidates: [candidate],
  },
  {
    type: 'FUTURES_POSITION_OPENED',
    timestamp: '2026-08-07T12:07:12.000Z',
    openedAt: '2026-08-07T12:07:12.000Z',
    lifecycle_id: LIFE,
    signal_id: SIGNAL,
    candidate_id: CANDIDATE,
    intent_id: INTENT,
    execution_id: EXECUTION,
    idempotency_key: IDEMPOTENCY,
    trade_id: TRADE,
    strategyId: 'mnq_globex_momentum_v1',
    symbol: 'MNQ',
    status: 'open',
  },
]);

writeJsonl(path.join(dataDir, 'futures-paper', 'candidate-archive.jsonl'), [
  {
    candidateId: 'legacy_candidate_26b',
    signalId: 'legacy_signal_26b',
    strategyId: 'mnq_globex_momentum_v1',
    symbol: 'MNQ',
    originalSymbol: 'MNQ',
    marketType: 'futures',
    direction: 'long',
    signalStatus: 'ready',
    signalSubtype: 'GLOBEX_MOMENTUM',
    entryPrice: 18450,
    referencePrice: 18450,
    stopLoss: 18440,
    takeProfit: 18470,
    createdAt: '2026-08-07T12:01:00.000Z',
    timestamp: '2026-08-07T12:01:00.000Z',
    signalTimestamp: '2026-08-07T12:01:00.000Z',
    sessionId: 'globex',
    session: 'globex',
    isMarketOpen: true,
    closedCandleConfirmed: true,
    producerEntryReadiness: {
      status: 'entry_ready',
      entryReady: true,
      confirmationObserved: ['closed_candle_confirmation'],
      missingConfirmations: [],
      blockers: [],
      evidence: {
        generatedAt: '2026-08-07T12:01:05.000Z',
        closedCandle: { confirmed: true, source: 'fixture', close: 18450, volume: 1200 },
        extensionLevel: 'none',
      },
    },
  },
]);

writeJson(path.join(dataDir, 'futures-paper', 'candidates.json'), { candidates: [] });
writeJson(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intent-index.json'), {
  [IDEMPOTENCY]: {
    lifecycle_id: LIFE,
    signal_id: SIGNAL,
    candidate_id: CANDIDATE,
    intent_id: INTENT,
    execution_id: EXECUTION,
    idempotency_key: IDEMPOTENCY,
    status: 'filled',
    createdAt: '2026-08-07T12:06:20.000Z',
    updatedAt: '2026-08-07T12:07:10.000Z',
    submitStartedAt: '2026-08-07T12:06:25.000Z',
    strategyId: 'mnq_globex_momentum_v1',
    root: 'MNQ',
    symbol: 'MNQ',
    direction: 'long',
    signalTimestamp: '2026-08-07T12:06:00.000Z',
    orderRef: 'TOS-PAPER-execution_evidence_26b-entry',
    ibOrderId: Number(BROKER_ORDER),
    expectedOrderIds: [Number(BROKER_ORDER), 900127, 900128],
    expectedBracketLegs: [
      { type: 'entry', orderId: Number(BROKER_ORDER), orderRef: 'TOS-PAPER-execution_evidence_26b-entry' },
      { type: 'stop', orderId: 900127, orderRef: 'TOS-PAPER-execution_evidence_26b-stop' },
      { type: 'target', orderId: 900128, orderRef: 'TOS-PAPER-execution_evidence_26b-target' },
    ],
    filledAt: '2026-08-07T12:07:00.000Z',
    filledPrice: 18502,
    filledQuantity: 1,
  },
});

writeJsonl(path.join(dataDir, 'futures-paper', 'ibkr-execution', 'intents.jsonl'), [
  {
    type: 'status_change',
    lifecycle_id: LIFE,
    signal_id: SIGNAL,
    candidate_id: CANDIDATE,
    intent_id: INTENT,
    execution_id: EXECUTION,
    idempotency_key: IDEMPOTENCY,
    status: 'filled',
    ibOrderId: Number(BROKER_ORDER),
    orderRef: 'TOS-PAPER-execution_evidence_26b-entry',
    filledPrice: 18502,
    filledQuantity: 1,
    at: '2026-08-07T12:07:05.000Z',
  },
]);

writeJsonl(path.join(dataDir, 'interactive-brokers', 'paper-execution-events.jsonl'), [
  {
    type: 'ORDER_STATUS',
    lifecycle_id: LIFE,
    signal_id: SIGNAL,
    candidate_id: CANDIDATE,
    intent_id: INTENT,
    execution_id: EXECUTION,
    idempotency_key: IDEMPOTENCY,
    ibOrderId: Number(BROKER_ORDER),
    orderRef: 'TOS-PAPER-execution_evidence_26b-entry',
    status: 'FILLED',
    executed: true,
    timestamp: '2026-08-07T12:07:04.000Z',
  },
]);

writeJsonl(path.join(dataDir, 'interactive-brokers', 'paper-executions.jsonl'), []);
writeJsonl(path.join(dataDir, 'futures-paper', 'trades.jsonl'), [
  {
    lifecycle_id: LIFE,
    signal_id: SIGNAL,
    candidate_id: CANDIDATE,
    intent_id: INTENT,
    execution_id: EXECUTION,
    idempotency_key: IDEMPOTENCY,
    trade_id: TRADE,
    strategyId: 'mnq_globex_momentum_v1',
    symbol: 'MNQ',
    openedAt: '2026-08-07T12:07:12.000Z',
    closedAt: '2026-08-07T12:18:00.000Z',
    status: 'closed',
    realizedPnlSek: 120,
  },
]);

writeJson(path.join(dataDir, 'futures-paper', 'positions.json'), {
  open: [
    {
      lifecycle_id: LIFE,
      signal_id: SIGNAL,
      candidate_id: CANDIDATE,
      intent_id: INTENT,
      execution_id: EXECUTION,
      idempotency_key: IDEMPOTENCY,
      trade_id: TRADE,
      tradeId: TRADE,
      strategyId: 'mnq_globex_momentum_v1',
      symbol: 'MNQ',
      status: 'open',
      openedAt: '2026-08-07T12:07:12.000Z',
      updatedAt: '2026-08-07T12:19:00.000Z',
    },
  ],
});

writeJsonl(path.join(dataDir, 'events', 'trading-events.jsonl'), []);

const service = createEvidenceGraphService({
  dataDir,
  now: () => new Date('2026-08-07T13:00:00.000Z'),
  defaultTailBytes: 1024 * 1024,
});

{
  assert.equal(SAFETY.mutation_allowed, false, 'EvidenceGraphService is read-only');
  assert.equal(SAFETY.can_place_orders, false, 'EvidenceGraphService cannot place orders');
}

{
  const graph = service.buildGraph(LIFE, { days: 1, full: 1, limit: 50 });
  assert.equal(graph.ok, true, 'graph validates');
  assert.equal(graph.root.lifecycleId, LIFE, 'root lifecycle id is exact');
  assert.equal(graph.root.joinMode, 'exact_lifecycle', 'new root uses exact lifecycle join');
  assert.equal(graph.validation.graphCoveragePct, 100, 'all graph stages are represented');
  assert.equal(graph.validation.joinCoveragePct, 100, 'all nodes use exact lifecycle join');
  assert.equal(graph.validation.identityPreservationPct, 100, 'identity is preserved');
  assert.deepEqual(graph.validation.orphanNodes, [], 'no orphan nodes');
  assert.deepEqual(graph.validation.brokenJoins, [], 'no broken joins');
  assert.deepEqual(graph.validation.duplicateRoots, [], 'no duplicate roots');
  assert.deepEqual(graph.graph.nodes.map((node) => node.stage), GRAPH_STAGES.map((stage) => stage.id), 'stage order is stable');

  const byStage = new Map(graph.graph.nodes.map((node) => [node.stage, node]));
  for (const stage of ['signal', 'candidate', 'canonical', 'execution_readiness', 'entry_contract', 'guard', 'intent', 'order_plan', 'broker_order', 'execution', 'fill', 'trade', 'ledger', 'analytics', 'signal_intelligence']) {
    const node = byStage.get(stage);
    assert.equal(node.available, true, `${stage} is materialized`);
    assert.ok(node.timestamp, `${stage} has timestamp`);
    assert.ok(node.owner, `${stage} has owner`);
    assert.ok(node.status, `${stage} has status`);
    assert.ok(node.payloadRef, `${stage} has payload reference`);
    assert.equal(node.identity.lifecycleId, LIFE, `${stage} keeps lifecycle id`);
  }

  assert.equal(byStage.get('candidate').identity.candidateId, CANDIDATE, 'candidate node keeps candidate id');
  assert.equal(byStage.get('signal').identity.signalId, SIGNAL, 'signal node keeps signal id');
  assert.equal(byStage.get('intent').identity.intentId, INTENT, 'intent node keeps intent id');
  assert.equal(byStage.get('execution').identity.executionId, EXECUTION, 'execution node keeps execution id');
  assert.equal(byStage.get('trade').identity.tradeId, TRADE, 'trade node keeps trade id');
  assert.equal(byStage.get('broker_order').identity.brokerOrderId, BROKER_ORDER, 'broker order node keeps broker order id');
  assert.equal(byStage.get('counterfactual').stage, 'counterfactual', 'counterfactual node is present');
  assert.equal(byStage.get('counterfactual').joinMode, 'exact_lifecycle', 'counterfactual node does not create a synthetic join');
}

for (const id of [LIFE, SIGNAL, CANDIDATE, INTENT, EXECUTION, TRADE, IDEMPOTENCY, BROKER_ORDER]) {
  const graph = service.buildGraph(id, { days: 1, full: 1, limit: 50 });
  assert.equal(graph.ok, true, `graph lookup works for ${id}`);
  assert.equal(graph.root.lifecycleId, LIFE, `${id} resolves to exact lifecycle`);

  const search = service.search({ q: id, days: 1, full: 1, limit: 20 });
  assert.equal(search.ok, true, `search works for ${id}`);
  assert.ok(search.results.some((row) => row.lifecycleId === LIFE), `search returns lifecycle for ${id}`);
}

{
  const replay = service.replay({ days: 1, full: 1, limit: 50 });
  assert.equal(replay.newLifecycleIds, 1, 'legacy rows without lifecycle are ignored by new lifecycle replay');
  assert.equal(replay.graphCoveragePct, 100, 'new lifecycle replay graph coverage is 100%');
  assert.equal(replay.joinCoveragePct, 100, 'new lifecycle replay uses exact joins');
  assert.equal(replay.identityPreservationPct, 100, 'new lifecycle replay preserves identity');
  assert.equal(replay.orphanNodes, 0, 'new lifecycle replay has zero orphan nodes');
  assert.equal(replay.duplicateRoots, 0, 'new lifecycle replay has zero duplicate roots');
  assert.equal(replay.brokenJoins, 0, 'new lifecycle replay has zero broken joins');
}

{
  const legacy = service.buildGraph('legacy_candidate_26b', { days: 1, full: 1, limit: 50 });
  assert.equal(legacy.ok, true, 'legacy graph still renders');
  assert.equal(legacy.root.lifecycleId, null, 'legacy graph does not synthesize lifecycle id');
  assert.equal(legacy.root.joinMode, 'legacy_heuristic', 'legacy graph is clearly marked heuristic');
  assert.equal(legacy.root.legacy, true, 'legacy graph is marked legacy');
  assert.ok(legacy.graph.nodes.every((node) => node.legacy === true), 'legacy nodes are marked legacy');
}

console.log('Evidence Graph service tests passed.');
