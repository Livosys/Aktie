'use strict';

const fs = require('fs');
const path = require('path');

const lifecycleIdentity = require('./futuresLifecycleIdentityService');
const signalIntelligenceLabService = require('./signalIntelligenceLabService');
const signalCounterfactualAnalyticsService = require('./signalCounterfactualAnalyticsService');
const canonicalExecutionRouter = require('./canonical/canonicalExecutionRouter');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');

const SAFETY = Object.freeze({
  ok: true,
  mode: 'observability_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  mutation_allowed: false,
  source: 'evidence_graph_service',
});

const GRAPH_STAGES = Object.freeze([
  { id: 'signal', label: 'Signal', owner: 'futuresCanonicalSignalProviderService.getCanonicalSignals' },
  { id: 'candidate', label: 'Candidate', owner: 'futuresTradingOsSignalAdapterService / futuresPaperScannerService' },
  { id: 'canonical', label: 'Canonical', owner: 'canonicalSignalAdapters' },
  { id: 'execution_readiness', label: 'Execution Readiness', owner: 'executionReadinessEngine' },
  { id: 'entry_contract', label: 'Entry Contract', owner: 'canonicalExecutionRouter / paperStrategyEntryContractService' },
  { id: 'guard', label: 'Guard', owner: 'ibPaperExecutionGuardService' },
  { id: 'intent', label: 'Intent', owner: 'ibPaperExecutionIntentService' },
  { id: 'order_plan', label: 'Order Plan', owner: 'ibPaperExecutionOrchestratorService' },
  { id: 'broker_order', label: 'Broker Order', owner: 'ibPaperExecutionAdapterService' },
  { id: 'execution', label: 'Execution', owner: 'ibPaperExecutionOrchestratorService / IBKR reconciliation' },
  { id: 'fill', label: 'Fill', owner: 'ibPaperExecutionAdapterService / IBKR reconciliation' },
  { id: 'trade', label: 'Trade', owner: 'futuresPaperLedgerService' },
  { id: 'ledger', label: 'Ledger', owner: 'futuresPaperLedgerService' },
  { id: 'analytics', label: 'Analytics', owner: 'signalIntelligenceLabService' },
  { id: 'counterfactual', label: 'Counterfactual', owner: 'signalCounterfactualAnalyticsService' },
  { id: 'signal_intelligence', label: 'Signal Intelligence', owner: 'signalIntelligenceLabService' },
]);

const STAGE_INDEX = Object.freeze(Object.fromEntries(GRAPH_STAGES.map((stage, index) => [stage.id, index])));

function text(value) {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function relPath(filePath, dataDir) {
  return path.relative(dataDir, filePath).replace(/\\/g, '/');
}

function readTextTail(filePath, tailBytes = 0) {
  if (!fs.existsSync(filePath)) return { ok: false, missing: true, text: '', truncated: false };
  const stat = fs.statSync(filePath);
  const start = tailBytes > 0 && stat.size > tailBytes ? stat.size - tailBytes : 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let textValue = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = textValue.indexOf('\n');
      textValue = firstNewline >= 0 ? textValue.slice(firstNewline + 1) : '';
    }
    return { ok: true, missing: false, text: textValue, truncated: start > 0, bytes: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, missing: true, value: null };
  try {
    return { ok: true, missing: false, value: JSON.parse(fs.readFileSync(filePath, 'utf8') || 'null') };
  } catch (err) {
    return { ok: false, missing: false, value: null, error: err.message };
  }
}

function readJsonl(filePath, { tailBytes = 0 } = {}) {
  const read = readTextTail(filePath, tailBytes);
  if (!read.ok) return { ...read, rows: [] };
  const rows = [];
  let lineNumber = 0;
  for (const line of read.text.split('\n')) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push({ row: JSON.parse(trimmed), lineNumber });
    } catch (_) {
      // Observability only: corrupt historical rows are ignored, not repaired.
    }
  }
  return { ...read, rows };
}

function firstTimestamp(...values) {
  for (const value of values) {
    const iso = toIso(value);
    if (iso) return iso;
  }
  return null;
}

function identityOf(payload = {}) {
  return lifecycleIdentity.identityFrom(payload);
}

function brokerOrderIdsOf(payload = {}) {
  return [
    payload.brokerOrderId,
    payload.ibOrderId,
    payload.orderId,
    payload.parentOrderId,
    payload.filledOrderId,
    ...(Array.isArray(payload.expectedOrderIds) ? payload.expectedOrderIds : []),
    ...(Array.isArray(payload.orderIds) ? payload.orderIds : []),
    ...(Array.isArray(payload.expectedBracketLegs) ? payload.expectedBracketLegs.map((leg) => leg?.orderId) : []),
  ].map(text).filter(Boolean);
}

function orderRefsOf(payload = {}) {
  return [
    payload.orderRef,
    payload.entryOrderRef,
    ...(Array.isArray(payload.orderRefs) ? payload.orderRefs : []),
    ...(Array.isArray(payload.expectedBracketLegs) ? payload.expectedBracketLegs.map((leg) => leg?.orderRef) : []),
  ].map(text).filter(Boolean);
}

function idsOfPayload(payload = {}) {
  const identity = identityOf(payload);
  return [
    identity.lifecycleId,
    identity.candidateId,
    identity.signalId,
    identity.intentId,
    identity.executionId,
    identity.idempotencyKey,
    identity.tradeId,
    ...brokerOrderIdsOf(payload),
    ...orderRefsOf(payload),
  ].map(text).filter(Boolean);
}

function payloadMatchesId(payload = {}, id) {
  const wanted = text(id);
  if (!wanted) return false;
  return idsOfPayload(payload).some((value) => value === wanted);
}

function compactIdentity(payload = {}) {
  const identity = identityOf(payload);
  return lifecycleIdentity.compact({
    ...identity,
    brokerOrderId: brokerOrderIdsOf(payload)[0] || null,
    orderRef: orderRefsOf(payload)[0] || null,
  });
}

function payloadSummary(payload = {}) {
  return {
    type: payload.type || null,
    status: payload.status || payload.signalStatus || payload.verdict || null,
    reasonCode: payload.reasonCode || payload.reason || payload.blockedReason || payload.blocker || null,
    strategyId: payload.strategyId || payload.strategy_id || null,
    symbol: payload.symbol || payload.root || payload.futuresSymbol || null,
    direction: payload.direction || payload.side || null,
  };
}

function createRawEntity(payload, ref, kind, timestamp = null) {
  return {
    payload,
    ref,
    kind,
    timestamp: firstTimestamp(
      timestamp,
      payload.timestamp,
      payload.createdAt,
      payload.updatedAt,
      payload.at,
      payload.signalTimestamp,
      payload.openedAt,
      payload.closedAt,
      payload.filledAt,
      payload.submitStartedAt,
    ),
    identity: compactIdentity(payload),
    ids: idsOfPayload(payload),
  };
}

function loadRawSources({ dataDir = DEFAULT_DATA_DIR, tailBytes = 0 } = {}) {
  const entities = [];
  const sourceStatus = [];
  const add = (payload, ref, kind, timestamp = null) => {
    if (payload && typeof payload === 'object') entities.push(createRawEntity(payload, ref, kind, timestamp));
  };
  const jsonl = (rel, source) => {
    const file = path.join(dataDir, rel);
    const read = readJsonl(file, { tailBytes });
    sourceStatus.push({ source, ok: read.ok, missing: read.missing === true, rows: read.rows.length, truncated: read.truncated === true });
    return { file, rows: read.rows };
  };
  const json = (rel, source) => {
    const file = path.join(dataDir, rel);
    const read = readJson(file);
    const rowCount = Array.isArray(read.value)
      ? read.value.length
      : (read.value && typeof read.value === 'object' ? Object.keys(read.value).length : 0);
    sourceStatus.push({ source, ok: read.ok, missing: read.missing === true, rows: rowCount, truncated: false });
    return { file, value: read.value };
  };

  {
    const { file, rows } = jsonl(path.join('futures-paper', 'events.jsonl'), 'futures-paper/events');
    rows.forEach(({ row }, rowIndex) => {
      const baseRef = { source: 'futures-paper/events', file: relPath(file, dataDir), rowIndex, type: row.type || null, eventId: row.eventId || null };
      add(row, baseRef, 'futures_event', row.timestamp);
      safeArray(row.candidates).forEach((candidate, index) => {
        add(candidate, { ...baseRef, pointer: `candidates[${index}]` }, 'candidate', row.timestamp);
      });
    });
  }

  {
    const { file, value } = json(path.join('futures-paper', 'candidates.json'), 'futures-paper/candidates');
    const rows = Array.isArray(value) ? value : safeArray(value?.candidates);
    rows.forEach((candidate, index) => add(candidate, { source: 'futures-paper/candidates', file: relPath(file, dataDir), pointer: `candidates[${index}]` }, 'candidate'));
  }

  {
    const { file, rows } = jsonl(path.join('futures-paper', 'candidate-archive.jsonl'), 'futures-paper/candidate-archive');
    rows.forEach(({ row }, rowIndex) => add(row, { source: 'futures-paper/candidate-archive', file: relPath(file, dataDir), rowIndex }, 'candidate_archive'));
  }

  {
    const { file, value } = json(path.join('futures-paper', 'ibkr-execution', 'intent-index.json'), 'futures-paper/ibkr-execution/intent-index');
    Object.entries(value || {}).forEach(([idempotencyKey, intent]) => {
      add(
        { ...intent, idempotencyKey: intent?.idempotencyKey || intent?.idempotency_key || idempotencyKey },
        { source: 'futures-paper/ibkr-execution/intent-index', file: relPath(file, dataDir), key: idempotencyKey },
        'intent',
      );
    });
  }

  {
    const { file, rows } = jsonl(path.join('futures-paper', 'ibkr-execution', 'intents.jsonl'), 'futures-paper/ibkr-execution/intents');
    rows.forEach(({ row }, rowIndex) => add(row, { source: 'futures-paper/ibkr-execution/intents', file: relPath(file, dataDir), rowIndex, type: row.type || null }, 'intent_event', row.at));
  }

  for (const [rel, source] of [
    [path.join('interactive-brokers', 'paper-execution-events.jsonl'), 'interactive-brokers/paper-execution-events'],
    [path.join('interactive-brokers', 'paper-executions.jsonl'), 'interactive-brokers/paper-executions'],
  ]) {
    const { file, rows } = jsonl(rel, source);
    rows.forEach(({ row }, rowIndex) => add(row, { source, file: relPath(file, dataDir), rowIndex, type: row.type || null }, 'broker_execution'));
  }

  {
    const { file, rows } = jsonl(path.join('futures-paper', 'trades.jsonl'), 'futures-paper/trades');
    rows.forEach(({ row }, rowIndex) => add(row, { source: 'futures-paper/trades', file: relPath(file, dataDir), rowIndex }, 'trade'));
  }

  {
    const { file, value } = json(path.join('futures-paper', 'positions.json'), 'futures-paper/positions');
    const openRows = safeArray(value?.open || value?.positions?.open);
    const closedRows = safeArray(value?.closed || value?.positions?.closed);
    openRows.forEach((position, index) => add(position, { source: 'futures-paper/positions', file: relPath(file, dataDir), pointer: `open[${index}]` }, 'position'));
    closedRows.forEach((position, index) => add(position, { source: 'futures-paper/positions', file: relPath(file, dataDir), pointer: `closed[${index}]` }, 'position'));
  }

  return { entities, sourceStatus };
}

function recordMatchesId(record = {}, id) {
  const wanted = text(id);
  if (!wanted) return false;
  return [
    record.signalKey,
    record.lifecycleId,
    record.candidateId,
    record.signalId,
    record.intentId,
    record.executionId,
    record.idempotencyKey,
    record.tradeId,
  ].map(text).filter(Boolean).includes(wanted);
}

function entityMatchesAnyId(entity, ids) {
  const wanted = new Set([...ids].map(text).filter(Boolean));
  if (!wanted.size) return false;
  return entity.ids.some((id) => wanted.has(id));
}

function identitySetFrom(records, entities) {
  const ids = new Set();
  for (const record of records) {
    [
      record.lifecycleId,
      record.candidateId,
      record.signalId,
      record.intentId,
      record.executionId,
      record.idempotencyKey,
      record.tradeId,
    ].forEach((id) => { if (text(id)) ids.add(text(id)); });
  }
  for (const entity of entities) {
    entity.ids.forEach((id) => ids.add(id));
  }
  return ids;
}

function earliest(entities) {
  return entities
    .filter(Boolean)
    .slice()
    .sort((a, b) => (Date.parse(a.timestamp || '') || Infinity) - (Date.parse(b.timestamp || '') || Infinity))[0] || null;
}

function latest(entities) {
  return entities
    .filter(Boolean)
    .slice()
    .sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0))[0] || null;
}

function findCandidateEntity(entities) {
  return earliest(entities.filter((entity) => entity.kind === 'candidate' || entity.kind === 'candidate_archive'));
}

function findIntentEntity(entities) {
  return latest(entities.filter((entity) => entity.kind === 'intent'));
}

function findIntentEvent(entities, predicate = () => true) {
  return latest(entities.filter((entity) => entity.kind === 'intent_event' && predicate(entity.payload)));
}

function findBrokerEntity(entities) {
  return latest(entities.filter((entity) => entity.kind === 'broker_execution' || brokerOrderIdsOf(entity.payload).length || orderRefsOf(entity.payload).length));
}

function findTradeEntity(entities) {
  const trades = entities.filter((entity) => entity.kind === 'trade' || entity.payload.type === 'FUTURES_POSITION_CLOSED');
  if (trades.length) return latest(trades);
  return latest(entities.filter((entity) => entity.payload.type === 'FUTURES_POSITION_OPENED' || entity.kind === 'position'));
}

function findLedgerEntity(entities) {
  const ledgerRows = entities.filter((entity) => entity.payload.type === 'FUTURES_POSITION_OPENED' || entity.payload.type === 'FUTURES_POSITION_CLOSED' || entity.kind === 'position');
  if (ledgerRows.length) return latest(ledgerRows);
  return latest(entities.filter((entity) => entity.kind === 'trade'));
}

function candidateMarketContext(candidate = {}) {
  const sessionId = candidate.sessionId || candidate.sessionMetadata?.sessionId || null;
  return {
    marketType: 'futures',
    session: sessionId,
    sessionId,
    isMarketOpen: candidate.isMarketOpen === true || candidate.sessionMetadata?.isMarketOpen === true,
  };
}

function deriveReadiness(candidateEntity) {
  const candidate = candidateEntity?.payload;
  if (!candidate || typeof candidate !== 'object' || !candidate.strategyId) return null;
  const now = new Date(firstTimestamp(candidate.timestamp, candidate.createdAt, candidate.signalTimestamp, candidateEntity.timestamp) || Date.now());
  try {
    return canonicalExecutionRouter.routeExecutionReadiness({
      strategyId: candidate.strategyId,
      candidate,
      now,
      marketContext: candidateMarketContext(candidate),
    });
  } catch (err) {
    return {
      allowed: false,
      status: 'error',
      reasonCode: 'readiness_derivation_failed',
      error: err.message,
    };
  }
}

function makeNode({
  stage,
  timestamp = null,
  status = null,
  reasonCode = null,
  ref = null,
  identity = {},
  legacy = false,
  joinMode = 'exact_lifecycle',
  available = true,
  summary = {},
} = {}) {
  const meta = GRAPH_STAGES.find((row) => row.id === stage) || { id: stage, label: stage, owner: null };
  return {
    id: `${String(STAGE_INDEX[stage] ?? 999).padStart(2, '0')}:${stage}`,
    stage,
    label: meta.label,
    timestamp: toIso(timestamp),
    owner: meta.owner,
    reasonCode: text(reasonCode),
    status: text(status) || (available ? 'observed' : 'not_reached'),
    payloadRef: ref || null,
    identity: lifecycleIdentity.compact(identity),
    legacy: legacy === true,
    joinMode,
    available: available === true,
    summary,
  };
}

function nodeFromEntity(stage, entity, { status = null, reasonCode = null, identity = {}, legacy = false, joinMode = 'exact_lifecycle' } = {}) {
  if (!entity) {
    return makeNode({ stage, status: 'not_reached', available: false, identity, legacy, joinMode });
  }
  return makeNode({
    stage,
    timestamp: entity.timestamp,
    status: status || entity.payload.status || entity.payload.signalStatus || entity.payload.type || 'observed',
    reasonCode: reasonCode || entity.payload.reasonCode || entity.payload.blockedReason || entity.payload.blocker || entity.payload.reason,
    ref: entity.ref,
    identity: { ...identity, ...entity.identity },
    legacy,
    joinMode,
    summary: payloadSummary(entity.payload),
  });
}

function signalNode(candidateEntity, record, identity, legacy, joinMode) {
  if (candidateEntity) {
    const candidate = candidateEntity.payload;
    return makeNode({
      stage: 'signal',
      timestamp: candidate.signalTimestamp || candidate.rawSignalSummary?.timestamp || candidate.createdAt || candidateEntity.timestamp,
      status: candidate.signalStatus || candidate.rawSignalSummary?.status || 'observed',
      reasonCode: candidate.rawSignalSummary?.reasonCode || null,
      ref: { ...candidateEntity.ref, pointer: candidateEntity.ref.pointer ? `${candidateEntity.ref.pointer}.rawSignalSummary` : 'rawSignalSummary' },
      identity: { ...identity, ...candidateEntity.identity },
      legacy,
      joinMode,
      summary: {
        signalFamily: candidate.signalFamily || candidate.rawSignalSummary?.signalFamily || null,
        signalSubtype: candidate.signalSubtype || candidate.rawSignalSummary?.signalSubtype || null,
        source: candidate.signalSource || candidate.source || null,
      },
    });
  }
  if (record) {
    return makeNode({
      stage: 'signal',
      timestamp: record.checkpoints?.producer_detection || record.firstSeenAt,
      status: record.status || 'observed',
      ref: { source: 'signal-intelligence/dataset', derivedBy: 'signalIntelligenceLabService.loadDataset' },
      identity,
      legacy,
      joinMode,
      summary: {
        signalFamily: record.signalFamily || null,
        signalSubtype: record.signalSubtype || null,
        source: 'signal_intelligence_record',
      },
    });
  }
  return makeNode({ stage: 'signal', status: 'missing', available: false, identity, legacy, joinMode });
}

function derivedCanonicalNodes(readiness, candidateEntity, identity, legacy, joinMode) {
  const ref = candidateEntity ? { ...candidateEntity.ref, derivedBy: 'canonicalExecutionRouter.routeExecutionReadiness' } : null;
  const canonicalSignal = readiness?.canonicalSignal || null;
  const readinessRow = readiness?.readiness || null;
  return [
    makeNode({
      stage: 'canonical',
      timestamp: candidateEntity?.timestamp || canonicalSignal?.signalTimestamp,
      status: canonicalSignal ? 'created' : 'not_reached',
      reasonCode: readiness?.reasonCode || readinessRow?.reasonCode || null,
      ref,
      identity,
      legacy,
      joinMode,
      available: Boolean(canonicalSignal),
      summary: canonicalSignal ? {
        producerType: canonicalSignal.producerType || null,
        strategyId: canonicalSignal.strategyId || null,
        signalSubtype: canonicalSignal.signalSubtype || null,
      } : {},
    }),
    makeNode({
      stage: 'execution_readiness',
      timestamp: readinessRow?.evaluatedAt || candidateEntity?.timestamp,
      status: readinessRow?.verdict || readiness?.status || 'not_reached',
      reasonCode: readiness?.reasonCode || readinessRow?.reasonCode || null,
      ref,
      identity,
      legacy,
      joinMode,
      available: Boolean(readinessRow || readiness),
      summary: readinessRow ? {
        policyId: readinessRow.policyId || null,
        engineVersion: readinessRow.engineVersion || null,
        evidenceGaps: readinessRow.evidenceGaps || [],
      } : {},
    }),
    makeNode({
      stage: 'entry_contract',
      timestamp: readinessRow?.evaluatedAt || candidateEntity?.timestamp,
      status: readiness ? (readiness.allowed === true ? 'allowed' : 'blocked') : 'not_reached',
      reasonCode: readiness?.reasonCode || readinessRow?.reasonCode || null,
      ref,
      identity,
      legacy,
      joinMode,
      available: Boolean(readiness),
      summary: readiness ? {
        entryContractVersion: readiness.entryContractVersion || null,
        decisionSource: readiness.decisionSource || null,
      } : {},
    }),
  ];
}

function counterfactualNode(counterfactualPayload, identity, legacy, joinMode) {
  const signal = counterfactualPayload?.signal || null;
  if (counterfactualPayload?.ok === true && signal) {
    return makeNode({
      stage: 'counterfactual',
      timestamp: signal.blockedAt || signal.firstBlocker?.at || signal.signalTimestamp || signal.firstSeenAt,
      status: signal.dataStatus || 'analyzed',
      reasonCode: signal.firstBlocker?.code || null,
      ref: { source: 'signal-counterfactual-analytics', derivedBy: 'signalCounterfactualAnalyticsService.getSignal' },
      identity: { ...identity, ...compactIdentity(signal) },
      legacy,
      joinMode,
      summary: {
        expectedR: signal.expectedR ?? null,
        maxMfeAtr: signal.max?.mfeAtr ?? null,
        maxMaeAtr: signal.max?.maeAtr ?? null,
      },
    });
  }
  return makeNode({
    stage: 'counterfactual',
    status: 'not_applicable',
    reasonCode: counterfactualPayload?.error || 'no_counterfactual_assessment',
    ref: { source: 'signal-counterfactual-analytics', derivedBy: 'signalCounterfactualAnalyticsService.getSignal' },
    identity,
    legacy,
    joinMode,
    available: false,
  });
}

function analyticsNode(record, identity, legacy, joinMode) {
  if (!record) return makeNode({ stage: 'analytics', status: 'missing', available: false, identity, legacy, joinMode });
  return makeNode({
    stage: 'analytics',
    timestamp: record.lastSeenAt || record.firstSeenAt,
    status: record.status || 'observed',
    reasonCode: record.firstBlocker?.code || record.lastBlocker?.code || null,
    ref: { source: 'signal-intelligence/dataset', derivedBy: 'signalIntelligenceLabService.loadDataset' },
    identity: { ...identity, ...compactIdentity(record) },
    legacy,
    joinMode,
    summary: {
      blockers: safeArray(record.blockers).length,
      timelineEvents: safeArray(record.timeline).length,
      metrics: record.metrics || {},
    },
  });
}

function signalIntelligenceNode(record, identity, legacy, joinMode) {
  if (!record) return makeNode({ stage: 'signal_intelligence', status: 'missing', available: false, identity, legacy, joinMode });
  return makeNode({
    stage: 'signal_intelligence',
    timestamp: record.lastSeenAt || record.firstSeenAt,
    status: record.status || 'observed',
    reasonCode: record.lastBlocker?.code || record.firstBlocker?.code || null,
    ref: { source: 'signal-intelligence/dataset', derivedBy: 'signalIntelligenceLabService.loadDataset' },
    identity: { ...identity, ...compactIdentity(record) },
    legacy,
    joinMode,
    summary: {
      signalKey: record.signalKey || null,
      checkpoints: record.checkpoints || {},
    },
  });
}

function buildEdges(nodes) {
  const sorted = nodes.slice().sort((a, b) => (STAGE_INDEX[a.stage] ?? 999) - (STAGE_INDEX[b.stage] ?? 999));
  const edges = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    edges.push({
      id: `${sorted[i].id}->${sorted[i + 1].id}`,
      from: sorted[i].id,
      to: sorted[i + 1].id,
      status: sorted[i].available && sorted[i + 1].available ? 'observed' : 'structural',
    });
  }
  return edges;
}

function validateGraph({ rootLifecycleId, nodes, duplicateRoots = [] }) {
  const brokenJoins = [];
  const orphanNodes = [];
  const byId = new Set(nodes.map((node) => node.id));
  const edges = buildEdges(nodes);
  const incoming = new Set(edges.map((edge) => edge.to));
  const availableNodes = nodes.filter((node) => node.available);
  let preservedIdentityNodes = 0;
  for (const node of nodes) {
    const nodeLifecycleId = text(node.identity?.lifecycleId);
    if (rootLifecycleId && nodeLifecycleId && nodeLifecycleId !== rootLifecycleId) {
      brokenJoins.push({ nodeId: node.id, lifecycleId: nodeLifecycleId, expectedLifecycleId: rootLifecycleId });
    }
    if (!node.available || !rootLifecycleId || nodeLifecycleId === rootLifecycleId) preservedIdentityNodes += 1;
    if (node.id !== nodes[0]?.id && !incoming.has(node.id)) orphanNodes.push(node.id);
    if (!byId.has(node.id)) orphanNodes.push(node.id);
  }
  const available = availableNodes.length;
  const exactLifecycleNodes = nodes.filter((node) => node.joinMode === 'exact_lifecycle').length;
  const legacyHeuristicNodes = nodes.filter((node) => node.joinMode === 'legacy_heuristic').length;
  return {
    ok: duplicateRoots.length === 0 && brokenJoins.length === 0 && orphanNodes.length === 0,
    graphCoveragePct: nodes.length ? 100 : 0,
    materializedStageCoveragePct: nodes.length ? Math.round((available / nodes.length) * 10000) / 100 : 0,
    joinCoveragePct: nodes.length ? Math.round((exactLifecycleNodes / nodes.length) * 10000) / 100 : 0,
    identityPreservationPct: nodes.length ? Math.round((preservedIdentityNodes / nodes.length) * 10000) / 100 : 0,
    expectedStages: GRAPH_STAGES.length,
    nodes: nodes.length,
    materializedNodes: available,
    exactLifecycleNodes,
    legacyHeuristicNodes,
    orphanNodes,
    duplicateRoots,
    brokenJoins,
  };
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function createEvidenceGraphService(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const now = options.now || (() => new Date());
  const signalIntelligence = options.signalIntelligenceService || signalIntelligenceLabService.createSignalIntelligenceLabService({ dataDir, now });
  const counterfactual = options.counterfactualService || signalCounterfactualAnalyticsService.createSignalCounterfactualAnalyticsService({
    dataDir,
    now,
    signalIntelligenceService: signalIntelligence,
  });
  const defaultTailBytes = options.defaultTailBytes || 24 * 1024 * 1024;

  function readWindow(query = {}) {
    const full = query.full === true || String(query.full || '') === '1';
    const tailMb = clampInt(query.tailMb, Math.round(defaultTailBytes / 1024 / 1024), 1, 128);
    const tailBytes = full ? 0 : tailMb * 1024 * 1024;
    return { full, tailMb, tailBytes };
  }

  function readContext(query = {}, rawOverride = null) {
    const { full, tailMb, tailBytes } = readWindow(query);
    const intelligenceDataset = signalIntelligence.loadDataset({
      ...query,
      full,
      tailMb,
      limit: query.limit || 2000,
    });
    const raw = rawOverride || loadRawSources({ dataDir, tailBytes });
    return { intelligenceDataset, raw, full, tailMb };
  }

  function buildCounterfactualIndex(query = {}) {
    try {
      const dataset = counterfactual.buildAssessments({ ...query, full: query.full ?? 1, limit: query.limit || 3000 });
      const byId = new Map();
      for (const signal of dataset.assessments || []) {
        [
          signal.signalKey,
          signal.lifecycleId,
          signal.candidateId,
          signal.signalId,
          signal.intentId,
          signal.executionId,
          signal.idempotencyKey,
          signal.tradeId,
        ].map(text).filter(Boolean).forEach((id) => byId.set(id, signal));
      }
      return { ok: true, byId };
    } catch (err) {
      return { ok: false, error: err.message, byId: new Map() };
    }
  }

  function getCounterfactualPayload(id, query = {}, counterfactualIndex = null) {
    if (counterfactualIndex) {
      const signal = counterfactualIndex.byId.get(id);
      if (signal) return { ok: true, signal };
      return {
        ok: false,
        error: counterfactualIndex.ok === false ? counterfactualIndex.error : 'counterfactual_signal_not_found',
      };
    }
    try {
      return counterfactual.getSignal(id, { ...query, full: query.full ?? 1, limit: query.limit || 3000 });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function resolve(id, context) {
    const records = context.intelligenceDataset.records.filter((record) => recordMatchesId(record, id));
    const entities = context.raw.entities.filter((entity) => payloadMatchesId(entity.payload, id));
    const lifecycleIds = unique([
      ...records.map((record) => record.lifecycleId),
      ...entities.map((entity) => entity.identity.lifecycleId),
    ]);
    const duplicateRoots = lifecycleIds.length > 1 ? lifecycleIds : [];
    const lifecycleId = lifecycleIds[0] || null;
    const legacy = !lifecycleId;
    let linkedIds = identitySetFrom(records, entities);

    if (lifecycleId) {
      const lifecycleRecords = context.intelligenceDataset.records.filter((record) => record.lifecycleId === lifecycleId);
      const lifecycleEntities = context.raw.entities.filter((entity) => entity.identity.lifecycleId === lifecycleId);
      linkedIds = identitySetFrom(lifecycleRecords, lifecycleEntities);
      return { lifecycleId, legacy: false, records: lifecycleRecords, entities: lifecycleEntities, linkedIds, duplicateRoots };
    }

    const legacyEntities = context.raw.entities.filter((entity) => entityMatchesAnyId(entity, linkedIds));
    const legacyRecords = context.intelligenceDataset.records.filter((record) => [...linkedIds].some((value) => recordMatchesId(record, value)));
    linkedIds = identitySetFrom(legacyRecords, legacyEntities);
    return { lifecycleId: null, legacy, records: legacyRecords, entities: legacyEntities, linkedIds, duplicateRoots };
  }

  function buildGraphFromContext(requestedId, query = {}, context, options = {}) {
    const resolved = resolve(requestedId, context);
    if (!resolved.records.length && !resolved.entities.length) {
      return {
        ...SAFETY,
        ok: false,
        error: 'evidence_graph_not_found',
        id: requestedId,
        generatedAt: now().toISOString(),
      };
    }

    const record = resolved.records[0] || null;
    const candidateEntity = findCandidateEntity(resolved.entities);
    const intentEntity = findIntentEntity(resolved.entities);
    const submitEvent = findIntentEvent(resolved.entities, (row) => row.status === 'submitted' || row.submitStartedAt || row.ibOrderId);
    const fillEvent = findIntentEvent(resolved.entities, (row) => row.status === 'filled' || row.filledPrice || row.entryFilledPrice);
    const brokerEntity = findBrokerEntity(resolved.entities) || submitEvent || intentEntity;
    const tradeEntity = findTradeEntity(resolved.entities);
    const ledgerEntity = findLedgerEntity(resolved.entities);
    const readiness = deriveReadiness(candidateEntity);
    const identity = lifecycleIdentity.compact({
      lifecycleId: resolved.lifecycleId,
      ...(record ? compactIdentity(record) : {}),
      ...(candidateEntity?.identity || {}),
      ...(intentEntity?.identity || {}),
      ...(brokerEntity?.identity || {}),
      ...(fillEvent?.identity || {}),
      ...(tradeEntity?.identity || {}),
    });
    const joinMode = resolved.lifecycleId ? 'exact_lifecycle' : 'legacy_heuristic';
    const counterfactualPayload = getCounterfactualPayload(resolved.lifecycleId || requestedId, query, options.counterfactualIndex || null);

    const derived = derivedCanonicalNodes(readiness, candidateEntity, identity, resolved.legacy, joinMode);
    const guardStatus = intentEntity
      ? (intentEntity.payload.blocker ? 'blocked' : 'passed')
      : (readiness?.allowed === false ? 'not_reached' : 'missing');
    const orderPlanAvailable = Boolean(intentEntity?.payload?.orderRef || intentEntity?.payload?.expectedBracketLegs || intentEntity?.payload?.orderRefs);
    const brokerOrderAvailable = Boolean(brokerEntity && (brokerOrderIdsOf(brokerEntity.payload).length || orderRefsOf(brokerEntity.payload).length || brokerEntity.payload.submitStartedAt));
    const executionAvailable = Boolean(intentEntity?.payload?.executionId || brokerEntity?.identity?.executionId);
    const fillAvailable = Boolean(fillEvent || intentEntity?.payload?.status === 'filled' || intentEntity?.payload?.filledAt || intentEntity?.payload?.filledPrice);

    const nodes = [
      signalNode(candidateEntity, record, identity, resolved.legacy, joinMode),
      nodeFromEntity('candidate', candidateEntity, { status: candidateEntity ? (candidateEntity.payload.status || 'created') : 'not_reached', identity, legacy: resolved.legacy, joinMode }),
      ...derived,
      makeNode({
        stage: 'guard',
        timestamp: intentEntity?.timestamp || candidateEntity?.timestamp,
        status: guardStatus,
        reasonCode: intentEntity?.payload?.blocker || intentEntity?.payload?.blockedReason || readiness?.reasonCode || null,
        ref: intentEntity?.ref || candidateEntity?.ref || null,
        identity: { ...identity, ...(intentEntity?.identity || {}) },
        legacy: resolved.legacy,
        joinMode,
        available: Boolean(intentEntity || readiness),
        summary: intentEntity ? payloadSummary(intentEntity.payload) : {},
      }),
      nodeFromEntity('intent', intentEntity, { identity, legacy: resolved.legacy, joinMode }),
      makeNode({
        stage: 'order_plan',
        timestamp: intentEntity?.payload?.submitStartedAt || intentEntity?.timestamp,
        status: orderPlanAvailable ? 'created' : 'not_reached',
        reasonCode: intentEntity?.payload?.blocker || null,
        ref: intentEntity?.ref || null,
        identity: { ...identity, ...(intentEntity?.identity || {}) },
        legacy: resolved.legacy,
        joinMode,
        available: orderPlanAvailable,
        summary: intentEntity ? { orderRef: intentEntity.payload.orderRef || null, orderRefs: orderRefsOf(intentEntity.payload) } : {},
      }),
      makeNode({
        stage: 'broker_order',
        timestamp: brokerEntity?.payload?.submitStartedAt || brokerEntity?.timestamp,
        status: brokerOrderAvailable ? (brokerEntity.payload.status || 'observed') : 'not_reached',
        reasonCode: brokerEntity?.payload?.blocker || brokerEntity?.payload?.ibErrorCode || null,
        ref: brokerEntity?.ref || null,
        identity: { ...identity, ...(brokerEntity?.identity || {}) },
        legacy: resolved.legacy,
        joinMode,
        available: brokerOrderAvailable,
        summary: brokerEntity ? { brokerOrderIds: brokerOrderIdsOf(brokerEntity.payload), orderRefs: orderRefsOf(brokerEntity.payload) } : {},
      }),
      makeNode({
        stage: 'execution',
        timestamp: brokerEntity?.timestamp || intentEntity?.timestamp,
        status: executionAvailable ? (brokerEntity?.payload?.status || intentEntity?.payload?.status || 'observed') : 'not_reached',
        reasonCode: brokerEntity?.payload?.blocker || intentEntity?.payload?.blocker || null,
        ref: brokerEntity?.ref || intentEntity?.ref || null,
        identity: { ...identity, ...(brokerEntity?.identity || intentEntity?.identity || {}) },
        legacy: resolved.legacy,
        joinMode,
        available: executionAvailable,
        summary: brokerEntity ? payloadSummary(brokerEntity.payload) : {},
      }),
      makeNode({
        stage: 'fill',
        timestamp: fillEvent?.timestamp || intentEntity?.payload?.filledAt || intentEntity?.timestamp,
        status: fillAvailable ? 'filled' : 'not_reached',
        reasonCode: fillEvent?.payload?.blocker || null,
        ref: fillEvent?.ref || intentEntity?.ref || null,
        identity: { ...identity, ...(fillEvent?.identity || intentEntity?.identity || {}) },
        legacy: resolved.legacy,
        joinMode,
        available: fillAvailable,
        summary: fillEvent ? payloadSummary(fillEvent.payload) : (intentEntity ? payloadSummary(intentEntity.payload) : {}),
      }),
      nodeFromEntity('trade', tradeEntity, { identity, legacy: resolved.legacy, joinMode }),
      nodeFromEntity('ledger', ledgerEntity, { identity, legacy: resolved.legacy, joinMode }),
      analyticsNode(record, identity, resolved.legacy, joinMode),
      counterfactualNode(counterfactualPayload, identity, resolved.legacy, joinMode),
      signalIntelligenceNode(record, identity, resolved.legacy, joinMode),
    ].sort((a, b) => (STAGE_INDEX[a.stage] ?? 999) - (STAGE_INDEX[b.stage] ?? 999));
    const edges = buildEdges(nodes);
    const validation = validateGraph({ rootLifecycleId: resolved.lifecycleId, nodes, duplicateRoots: resolved.duplicateRoots });

    return {
      ...SAFETY,
      ok: validation.ok,
      generatedAt: now().toISOString(),
      id: requestedId,
      root: {
        lifecycleId: resolved.lifecycleId,
        graphRootId: resolved.lifecycleId || `legacy:${requestedId}`,
        legacy: resolved.legacy,
        joinMode,
        duplicateRoots: resolved.duplicateRoots,
      },
      identity,
      graph: {
        stages: GRAPH_STAGES,
        nodes,
        edges,
      },
      validation,
      sourceStatus: [...context.raw.sourceStatus, ...(context.intelligenceDataset.sourceStatus || [])],
    };
  }

  function buildGraph(id, query = {}) {
    const requestedId = text(id || query.id || query.q);
    if (!requestedId) return { ...SAFETY, ok: false, error: 'evidence_graph_id_required' };
    return buildGraphFromContext(requestedId, query, readContext(query));
  }

  function search(query = {}) {
    const q = text(query.q || query.id || query.lifecycleId || query.candidateId || query.signalId || query.intentId || query.executionId || query.tradeId || query.brokerOrderId);
    if (!q) return { ...SAFETY, ok: false, error: 'evidence_graph_search_query_required' };
    const context = readContext(query);
    const matches = new Map();
    const addMatch = (key, row) => {
      if (!key || matches.has(key)) return;
      matches.set(key, row);
    };
    for (const record of context.intelligenceDataset.records) {
      const haystack = [
        record.signalKey,
        record.lifecycleId,
        record.candidateId,
        record.signalId,
        record.intentId,
        record.executionId,
        record.idempotencyKey,
        record.tradeId,
        record.strategyId,
        record.symbol,
        record.originalSymbol,
      ].map(text).filter(Boolean);
      if (!haystack.some((value) => value.includes(q) || value === q)) continue;
      const key = record.lifecycleId || record.candidateId || record.signalKey;
      addMatch(key, {
        lifecycleId: record.lifecycleId || null,
        graphRootId: record.lifecycleId || `legacy:${record.candidateId || record.signalKey}`,
        legacy: !record.lifecycleId,
        joinMode: record.lifecycleId ? 'exact_lifecycle' : 'legacy_heuristic',
        candidateId: record.candidateId || null,
        signalId: record.signalId || null,
        intentId: record.intentId || null,
        executionId: record.executionId || null,
        tradeId: record.tradeId || null,
        status: record.status || null,
        timestamp: record.lastSeenAt || record.firstSeenAt || null,
        source: 'signal_intelligence',
      });
    }
    for (const entity of context.raw.entities) {
      if (!entity.ids.some((value) => value.includes(q) || value === q)) continue;
      const key = entity.identity.lifecycleId || entity.identity.candidateId || entity.identity.signalId || entity.ids[0];
      addMatch(key, {
        lifecycleId: entity.identity.lifecycleId || null,
        graphRootId: entity.identity.lifecycleId || `legacy:${entity.identity.candidateId || entity.identity.signalId || entity.ids[0]}`,
        legacy: !entity.identity.lifecycleId,
        joinMode: entity.identity.lifecycleId ? 'exact_lifecycle' : 'legacy_heuristic',
        candidateId: entity.identity.candidateId || null,
        signalId: entity.identity.signalId || null,
        intentId: entity.identity.intentId || null,
        executionId: entity.identity.executionId || null,
        tradeId: entity.identity.tradeId || null,
        brokerOrderId: brokerOrderIdsOf(entity.payload)[0] || null,
        orderRef: orderRefsOf(entity.payload)[0] || null,
        status: entity.payload.status || entity.payload.type || null,
        timestamp: entity.timestamp,
        source: entity.ref.source,
        payloadRef: entity.ref,
      });
    }
    const results = [...matches.values()]
      .sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0))
      .slice(0, clampInt(query.limit, 50, 1, 200));
    return {
      ...SAFETY,
      generatedAt: now().toISOString(),
      query: q,
      count: results.length,
      results,
    };
  }

  function replay(query = {}) {
    const { tailBytes } = readWindow(query);
    const raw = loadRawSources({ dataDir, tailBytes });
    const rawLifecycleIds = unique(raw.entities.map((entity) => entity.identity.lifecycleId))
      .filter((id) => id.startsWith('signal_lifecycle_'));
    const idFields = ['candidateId', 'signalId', 'intentId', 'executionId', 'idempotencyKey', 'tradeId'];
    const duplicateRootRows = [];
    for (const field of idFields) {
      const byId = new Map();
      for (const entity of raw.entities) {
        const value = text(entity.identity[field]);
        const lifecycleId = text(entity.identity.lifecycleId);
        if (!value || !lifecycleId || !lifecycleId.startsWith('signal_lifecycle_')) continue;
        if (!byId.has(value)) byId.set(value, new Set());
        byId.get(value).add(lifecycleId);
      }
      for (const [value, roots] of byId.entries()) {
        if (roots.size > 1) duplicateRootRows.push({ field, value, roots: [...roots] });
      }
    }
    if (!rawLifecycleIds.length) {
      return {
        ...SAFETY,
        generatedAt: now().toISOString(),
        newLifecycleIds: 0,
        graphCoverage: 0,
        graphCoveragePct: 100,
        joinCoveragePct: 100,
        identityPreservationPct: 100,
        orphanNodes: 0,
        duplicateRoots: duplicateRootRows.length,
        brokenJoins: 0,
        exactLifecycleGraphs: 0,
        legacyHeuristicGraphs: 0,
        mismatches: {
          orphanNodes: [],
          duplicateRoots: duplicateRootRows.slice(0, 20),
          brokenJoins: [],
        },
        legacy: {
          allowed: true,
          marker: 'legacy_heuristic',
        },
      };
    }
    const context = readContext(query, raw);
    const lifecycleIds = unique([
      ...context.intelligenceDataset.records.map((record) => record.lifecycleId),
      ...rawLifecycleIds,
    ]).filter((id) => id.startsWith('signal_lifecycle_'));
    const counterfactualIndex = buildCounterfactualIndex(query);
    const graphs = lifecycleIds.map((lifecycleId) => buildGraphFromContext(lifecycleId, query, context, { counterfactualIndex }));
    const brokenJoins = graphs.flatMap((graph) => graph.validation?.brokenJoins || []);
    const orphanNodes = graphs.flatMap((graph) => graph.validation?.orphanNodes || []);
    const graphCoverage = graphs.filter((graph) => graph.validation?.ok === true && graph.validation?.graphCoveragePct === 100).length;
    const joinCoveragePct = graphs.length
      ? Math.round((graphs.reduce((sum, graph) => sum + (graph.validation?.joinCoveragePct || 0), 0) / graphs.length) * 100) / 100
      : 100;
    const identityPreservationPct = graphs.length
      ? Math.round((graphs.reduce((sum, graph) => sum + (graph.validation?.identityPreservationPct || 0), 0) / graphs.length) * 100) / 100
      : 100;
    return {
      ...SAFETY,
      generatedAt: now().toISOString(),
      newLifecycleIds: lifecycleIds.length,
      graphCoverage,
      graphCoveragePct: lifecycleIds.length ? Math.round((graphCoverage / lifecycleIds.length) * 10000) / 100 : 100,
      joinCoveragePct,
      identityPreservationPct,
      orphanNodes: orphanNodes.length,
      duplicateRoots: duplicateRootRows.length,
      brokenJoins: brokenJoins.length,
      exactLifecycleGraphs: graphs.filter((graph) => graph.root?.joinMode === 'exact_lifecycle').length,
      legacyHeuristicGraphs: graphs.filter((graph) => graph.root?.joinMode === 'legacy_heuristic').length,
      mismatches: {
        orphanNodes: orphanNodes.slice(0, 20),
        duplicateRoots: duplicateRootRows.slice(0, 20),
        brokenJoins: brokenJoins.slice(0, 20),
      },
      legacy: {
        allowed: true,
        marker: 'legacy_heuristic',
      },
    };
  }

  return {
    SAFETY,
    GRAPH_STAGES,
    buildGraph,
    search,
    replay,
  };
}

const defaultEvidenceGraphService = createEvidenceGraphService();

module.exports = {
  SAFETY,
  GRAPH_STAGES,
  createEvidenceGraphService,
  defaultEvidenceGraphService,
};
