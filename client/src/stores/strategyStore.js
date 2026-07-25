import {
  EMPTY_STRATEGY_VIEW_MODEL,
  firstValue,
  isStrategyViewModel,
  normalizeStrategyId,
  normalizeStrategyViewModel,
  strategyDisplayName,
  strategyModelKey,
} from '../models/strategyViewModel.js';
import {
  getBlockedStrategies,
  getCandidateStrategies,
  getRunningStrategies,
  getStrategiesByApprovalState,
  getStrategiesByFamily,
  getStrategiesByMarketRegime,
  getStrategiesByRiskState,
  getStrategiesByRuntimeState,
  getStrategiesBySignal,
} from '../domain/StrategyDomain.js';
import { hasValue } from '../utils/tradingFormatters.js';

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function sourceArray(...values) {
  return values.flatMap((value) => {
    if (Array.isArray(value)) return value.filter(Boolean);
    return value ? [value] : [];
  });
}

function populatedObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function idText(value) {
  return hasValue(value) ? String(value) : null;
}

function addBy(map, key, row) {
  const text = idText(key);
  if (text && !map.has(text)) map.set(text, row);
}

function addSourceByStrategyId(map, key, row, slot = 'source') {
  const text = idText(key);
  if (!text || !row) return;
  const existing = map.get(text) || { strategyId: text };
  map.set(text, {
    ...existing,
    [slot]: row,
  });
}

function executionIdFromOrderRef(ref) {
  const text = String(ref || '');
  if (!text.startsWith('TOS-PAPER-')) return null;
  return text.replace(/^TOS-PAPER-/, '').split('-')[0] || null;
}

function strategyIdFromKnownRow(row = {}) {
  return normalizeStrategyId(
    row.strategyId,
    row.strategy_id,
    row.canonicalStrategyId,
    row.canonical_strategy_id,
    row.resolvedStrategyId,
    row.sourceStrategyId,
    row.catalog?.strategyId,
    row.catalog?.strategy_id,
    row.id,
    row.key,
  );
}

function explicitStrategyId(row = {}) {
  return normalizeStrategyId(
    row.strategyId,
    row.strategy_id,
    row.canonicalStrategyId,
    row.canonical_strategy_id,
    row.resolvedStrategyId,
    row.sourceStrategyId,
    row.catalog?.strategyId,
    row.catalog?.strategy_id,
    row.strategy?.strategyId,
    row.strategy?.strategy_id,
  );
}

function candidateIdFromSource(source = {}) {
  return firstValue(
    source.candidateId,
    source.candidate_id,
    source.eventId,
    source.candidate?.candidateId,
    source.candidate?.candidate_id,
  );
}

function orderRefFromSource(source = {}) {
  return firstValue(
    source.orderRef,
    source.order?.orderRef,
    source.execution?.orderRef,
  );
}

function findIntent(source = {}, maps = {}) {
  const orderRef = orderRefFromSource(source);
  const executionId = firstValue(source.executionId, source.internalExecutionId, executionIdFromOrderRef(orderRef));
  return (orderRef && maps.intentByOrderRef.get(String(orderRef)))
    || (executionId && maps.intentByExecutionId.get(String(executionId)))
    || (hasValue(source.candidateId) && maps.intentByCandidateId.get(String(source.candidateId)))
    || (hasValue(source.candidate_id) && maps.intentByCandidateId.get(String(source.candidate_id)))
    || (hasValue(source.orderId) && maps.intentByOrderId.get(String(source.orderId)))
    || (hasValue(source.ibOrderId) && maps.intentByOrderId.get(String(source.ibOrderId)))
    || (hasValue(source.permId) && maps.intentByPermId.get(String(source.permId)))
    || null;
}

function emptyMaps() {
  return {
    sourceByStrategyId: new Map(),
    overviewByStrategyId: new Map(),
    statusByStrategyId: new Map(),
    pulseByStrategyId: new Map(),
    candidateById: new Map(),
    candidateByStrategyId: new Map(),
    intentByOrderRef: new Map(),
    intentByExecutionId: new Map(),
    intentByCandidateId: new Map(),
    intentByOrderId: new Map(),
    intentByPermId: new Map(),
  };
}

function normalizeMaps(maps = {}) {
  return {
    ...emptyMaps(),
    ...(maps || {}),
  };
}

export function buildStrategyViewModelMaps({
  runtimeSnapshot = null,
  executionSnapshot = null,
  strategyOverview = [],
  strategyStatus = [],
  strategyPulse = [],
  strategies = [],
  candidateQueue = {},
  candidates = [],
  reconciliation = {},
} = {}) {
  const runtime = runtimeSnapshot || {};
  const execution = executionSnapshot || {};
  const runtimeCandidateQueue = runtime.candidateQueue || {};
  const resolvedReconciliation = populatedObject(reconciliation)
    ? reconciliation
    : (runtime.brokerReconciliation || execution.reconciliation || {});
  const maps = emptyMaps();

  const overviewRows = sourceArray(strategyOverview, runtime.strategyOverview);
  const statusRows = sourceArray(strategyStatus, runtime.strategyStatus);
  const pulseRows = sourceArray(strategyPulse, runtime.strategyPulse);
  const performanceRows = sourceArray(runtime.performance?.strategy);
  const knownStrategyRows = sourceArray(strategies, runtime.strategies, runtime.runtimeStrategies);
  const candidateRows = sourceArray(
    candidates,
    Array.isArray(candidateQueue) ? candidateQueue : candidateQueue.candidates,
    Array.isArray(runtimeCandidateQueue) ? runtimeCandidateQueue : runtimeCandidateQueue.candidates,
  );

  for (const row of overviewRows) {
    const id = strategyIdFromKnownRow(row);
    addBy(maps.overviewByStrategyId, id, row);
    addSourceByStrategyId(maps.sourceByStrategyId, id, row, 'overview');
  }
  for (const row of statusRows) {
    const id = strategyIdFromKnownRow(row);
    addBy(maps.statusByStrategyId, id, row);
    addSourceByStrategyId(maps.sourceByStrategyId, id, row, 'status');
  }
  for (const row of pulseRows) {
    const id = strategyIdFromKnownRow(row);
    addBy(maps.pulseByStrategyId, id, row);
    addSourceByStrategyId(maps.sourceByStrategyId, id, row, 'pulse');
  }
  for (const row of performanceRows) {
    addSourceByStrategyId(maps.sourceByStrategyId, strategyIdFromKnownRow(row), row, 'performance');
  }
  for (const row of knownStrategyRows) {
    addSourceByStrategyId(maps.sourceByStrategyId, strategyIdFromKnownRow(row), row, 'source');
  }
  for (const row of candidateRows) {
    const candidateId = candidateIdFromSource(row);
    const strategyId = explicitStrategyId(row);
    addBy(maps.candidateById, candidateId, row);
    addBy(maps.candidateByStrategyId, strategyId, row);
    addSourceByStrategyId(maps.sourceByStrategyId, strategyId, row, 'candidate');
  }

  for (const intent of list(resolvedReconciliation.intents)) {
    addBy(maps.intentByOrderRef, intent.orderRef, intent);
    addBy(maps.intentByExecutionId, intent.executionId, intent);
    addBy(maps.intentByCandidateId, intent.candidateId, intent);
    addBy(maps.intentByOrderId, intent.ibOrderId, intent);
    addBy(maps.intentByPermId, intent.permId, intent);
    for (const ref of list(intent.orderRefs)) addBy(maps.intentByOrderRef, ref, intent);
    addSourceByStrategyId(maps.sourceByStrategyId, explicitStrategyId(intent), intent, 'intent');
  }

  return maps;
}

export function mergeStrategySources(source = {}, maps = {}, options = {}) {
  const input = source || {};
  const intent = input.intent || findIntent(input, maps);
  const candidateId = firstValue(candidateIdFromSource(input), intent?.candidateId);
  const candidate = input.candidate || (candidateId ? maps.candidateById.get(String(candidateId)) : null);
  const strategyId = options.knownStrategyRow
    ? strategyIdFromKnownRow(input)
    : normalizeStrategyId(
      explicitStrategyId(input),
      candidate?.strategyId,
      candidate?.strategy_id,
      intent?.strategyId,
    );
  const overview = input.overview || (strategyId ? maps.overviewByStrategyId.get(String(strategyId)) : null);
  const status = input.strategyStatus
    || (input.status && typeof input.status === 'object' ? input.status : null)
    || (strategyId ? maps.statusByStrategyId.get(String(strategyId)) : null);
  const pulse = input.pulse || (strategyId ? maps.pulseByStrategyId.get(String(strategyId)) : null);
  const indexed = strategyId ? maps.sourceByStrategyId.get(String(strategyId)) : null;

  return {
    ...(indexed?.source || {}),
    ...(overview || {}),
    ...(status || {}),
    ...(pulse || {}),
    ...(indexed?.performance || {}),
    ...(candidate || {}),
    ...(intent || {}),
    ...input,
    strategyId: strategyId ? String(strategyId) : null,
    candidateId: candidateId ? String(candidateId) : null,
    orderRef: firstValue(orderRefFromSource(input), intent?.orderRef),
    overview,
    strategyStatus: status,
    pulse,
    candidate,
    intent,
  };
}

export function normalizeStrategyFromMaps(source = {}, maps = {}, options = {}) {
  if (isStrategyViewModel(source) && !options.force) return source;
  return normalizeStrategyViewModel(mergeStrategySources(source, maps, options));
}

export const normalizeStrategy = normalizeStrategyFromMaps;

export function buildStrategyMap(maps = {}) {
  const strategies = new Map();
  const ids = new Set([
    ...maps.sourceByStrategyId.keys(),
    ...maps.overviewByStrategyId.keys(),
    ...maps.statusByStrategyId.keys(),
    ...maps.pulseByStrategyId.keys(),
    ...maps.candidateByStrategyId.keys(),
  ]);
  for (const id of ids) {
    const strategy = normalizeStrategyFromMaps({ strategyId: id }, maps);
    if (strategy.strategyId) strategies.set(strategy.strategyId, strategy);
  }
  return strategies;
}

function resolveStore(input) {
  if (input && input.__strategyStore === true) return input;
  if (input && (
    input.sourceByStrategyId instanceof Map
    || input.overviewByStrategyId instanceof Map
    || input.statusByStrategyId instanceof Map
    || input.pulseByStrategyId instanceof Map
  )) {
    return createStrategyStore({ maps: input });
  }
  return EMPTY_STRATEGY_STORE;
}

export function createStrategyStore(sources = {}) {
  const maps = sources.maps ? normalizeMaps(sources.maps) : buildStrategyViewModelMaps(sources);
  const strategyById = buildStrategyMap(maps);
  const allStrategies = () => Array.from(strategyById.values());

  const store = {
    __strategyStore: true,
    maps,
    getStrategy(id) {
      const key = idText(id);
      return key ? strategyById.get(key) || null : null;
    },
    getAllStrategies() {
      return allStrategies();
    },
    getRunningStrategies() {
      return getRunningStrategies(allStrategies());
    },
    getBlockedStrategies() {
      return getBlockedStrategies(allStrategies());
    },
    getCandidateStrategies() {
      return getCandidateStrategies(allStrategies());
    },
    getStrategiesByFamily() {
      return getStrategiesByFamily(allStrategies());
    },
    getStrategiesByRuntimeState() {
      return getStrategiesByRuntimeState(allStrategies());
    },
    getStrategiesByApprovalState() {
      return getStrategiesByApprovalState(allStrategies());
    },
    getStrategiesByRiskState() {
      return getStrategiesByRiskState(allStrategies());
    },
    getStrategiesBySignal() {
      return getStrategiesBySignal(allStrategies());
    },
    getStrategiesByMarketRegime() {
      return getStrategiesByMarketRegime(allStrategies());
    },
    resolveStrategy(source = {}, options = {}) {
      return normalizeStrategyFromMaps(source, maps, options);
    },
    normalizeStrategy(source = {}, options = {}) {
      return normalizeStrategyFromMaps(source, maps, options);
    },
    resolveKnownStrategy(source = {}) {
      return normalizeStrategyFromMaps(source, maps, { knownStrategyRow: true });
    },
  };

  return store;
}

export const EMPTY_STRATEGY_STORE = Object.freeze({
  __strategyStore: true,
  maps: emptyMaps(),
  getStrategy: () => null,
  getAllStrategies: () => [],
  getRunningStrategies: () => [],
  getBlockedStrategies: () => [],
  getCandidateStrategies: () => [],
  getStrategiesByFamily: () => new Map(),
  getStrategiesByRuntimeState: () => new Map(),
  getStrategiesByApprovalState: () => new Map(),
  getStrategiesByRiskState: () => new Map(),
  getStrategiesBySignal: () => new Map(),
  getStrategiesByMarketRegime: () => new Map(),
  resolveStrategy: (source = {}, options = {}) => normalizeStrategyFromMaps(source, emptyMaps(), options),
  normalizeStrategy: (source = {}, options = {}) => normalizeStrategyFromMaps(source, emptyMaps(), options),
  resolveKnownStrategy: (source = {}) => normalizeStrategyFromMaps(source, emptyMaps(), { knownStrategyRow: true }),
});

export function resolveStrategy(source = {}, strategyStore = EMPTY_STRATEGY_STORE, options = {}) {
  return resolveStore(strategyStore).resolveStrategy(source, options);
}

export function resolveKnownStrategy(source = {}, strategyStore = EMPTY_STRATEGY_STORE) {
  return resolveStore(strategyStore).resolveKnownStrategy(source);
}

export function getStrategyDisplayName(source = {}, strategyStore = EMPTY_STRATEGY_STORE, fallback = '—') {
  return strategyDisplayName(resolveStrategy(source, strategyStore), fallback);
}

export { strategyDisplayName };
export { strategyModelKey };
export { EMPTY_STRATEGY_VIEW_MODEL };
