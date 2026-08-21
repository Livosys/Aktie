'use strict';

const crypto = require('crypto');

const { calcIndicators } = require('../scanner/indicators');
const { classifyNarrowState } = require('../scanner/narrowState');
const { applyEngineV3 } = require('../scanner/engineV3');
const { calcMarketRegimeV2, applyMarketRegimeV2 } = require('../scanner/marketRegimeEngine');
const { applyHistoricalEdge } = require('../scanner/historicalEdge');

const RUNTIME_VERSION = 'strategy-runtime-v1';

const SAFETY = Object.freeze({
  source: 'strategy_runtime',
  readOnly: true,
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true
});

const CAPABILITIES = Object.freeze({
  execute: true,
  materialize: true,
  mutates: false,
  optimizes: false,
  runsReplay: false,
  placesOrders: false
});

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashObject(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeVersion(value) {
  if (value === undefined || value === null || value === '') return 'default';
  return String(value);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeIdentity(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const experiment = isPlainObject(source.experiment) ? source.experiment : null;
  const mutated = isPlainObject(source.mutatedDna) ? source.mutatedDna : null;
  const candidate = isPlainObject(source.candidateDna) ? source.candidateDna : null;
  const dna = isPlainObject(source.dna) ? source.dna : null;
  const registered = isPlainObject(source.strategy) ? source.strategy : null;
  const paperCandidate = isPlainObject(source.paperCandidate) ? source.paperCandidate : null;

  if (experiment) {
    return {
      sourceType: 'experiment',
      sourceId: firstValue(experiment.experimentId, experiment.id),
      strategyId: firstValue(experiment.strategyId, experiment.strategy_id, source.strategyId, 'default'),
      strategyVersion: normalizeVersion(firstValue(experiment.strategyVersion, experiment.version, source.strategyVersion)),
      dnaHash: firstValue(experiment.dnaHash, experiment.dna_hash),
      candidateDnaHash: firstValue(experiment.candidateDnaHash, experiment.candidate_dna_hash),
      parameterHash: firstValue(experiment.parameterHash, experiment.parameter_hash),
      marketDnaHash: firstValue(experiment.marketDnaHash, experiment.market_dna_hash),
      executionModel: firstValue(experiment.executionModel, experiment.execution_model),
      replayMode: firstValue(experiment.replayMode, experiment.replay_mode),
      generation: Number.isFinite(Number(experiment.generation)) ? Number(experiment.generation) : 0,
      mutationNumber: Number.isFinite(Number(experiment.mutationNumber)) ? Number(experiment.mutationNumber) : 0,
      lineage: experiment.lineage || null,
      genome: experiment.genome || null
    };
  }

  const dnaSource = mutated || candidate || dna;
  if (dnaSource) {
    const lineage = isPlainObject(dnaSource.lineage) ? dnaSource.lineage : {};
    return {
      sourceType: mutated ? 'mutated_dna' : candidate ? 'candidate_dna' : 'original_dna',
      sourceId: firstValue(dnaSource.dnaId, dnaSource.id),
      strategyId: firstValue(dnaSource.strategyId, dnaSource.strategy_id, source.strategyId, 'default'),
      strategyVersion: normalizeVersion(firstValue(dnaSource.strategyVersion, dnaSource.version, source.strategyVersion)),
      dnaHash: firstValue(dnaSource.dnaHash, dnaSource.dna_hash, dnaSource.originalDnaHash, dnaSource.original_dna_hash),
      candidateDnaHash: firstValue(
        dnaSource.candidateDnaHash,
        dnaSource.candidate_dna_hash,
        dnaSource.mutatedDnaHash,
        dnaSource.mutated_dna_hash,
        mutated || candidate ? firstValue(dnaSource.dnaHash, dnaSource.dna_hash) : null
      ),
      parameterHash: firstValue(dnaSource.parameterHash, dnaSource.parameter_hash),
      marketDnaHash: firstValue(dnaSource.marketDnaHash, dnaSource.market_dna_hash),
      executionModel: firstValue(dnaSource.executionModel, dnaSource.execution_model),
      replayMode: firstValue(dnaSource.replayMode, dnaSource.replay_mode),
      generation: Number.isFinite(Number(dnaSource.generation ?? lineage.generation)) ? Number(dnaSource.generation ?? lineage.generation) : 0,
      mutationNumber: Number.isFinite(Number(dnaSource.mutationNumber ?? lineage.mutationNumber)) ? Number(dnaSource.mutationNumber ?? lineage.mutationNumber) : 0,
      lineage: dnaSource.lineage || null,
      genome: dnaSource.genome || dnaSource.parameters || null
    };
  }

  if (paperCandidate) {
    return {
      sourceType: 'paper_candidate',
      sourceId: firstValue(paperCandidate.candidateId, paperCandidate.id, paperCandidate.strategyId),
      strategyId: firstValue(paperCandidate.strategyId, paperCandidate.strategy_id, source.strategyId, 'default'),
      strategyVersion: normalizeVersion(firstValue(paperCandidate.strategyVersion, paperCandidate.version, source.strategyVersion)),
      dnaHash: null,
      candidateDnaHash: null,
      parameterHash: firstValue(paperCandidate.parameterHash, paperCandidate.parameter_hash),
      marketDnaHash: null,
      executionModel: firstValue(paperCandidate.executionModel, paperCandidate.execution_model),
      replayMode: null,
      generation: 0,
      mutationNumber: 0,
      lineage: null,
      genome: null
    };
  }

  const registeredStrategyId = firstValue(
    source.strategyId,
    source.strategy_id,
    registered && registered.strategyId,
    registered && registered.strategy_id,
    registered && registered.id,
    'default'
  );
  const registeredStrategyVersion = normalizeVersion(firstValue(
    source.strategyVersion,
    source.version,
    registered && registered.strategyVersion,
    registered && registered.version
  ));

  return {
    sourceType: registered || source.strategyId || source.strategy_id ? 'registered_strategy' : 'default_strategy',
    sourceId: registeredStrategyId === 'default' ? null : registeredStrategyId,
    strategyId: registeredStrategyId,
    strategyVersion: registeredStrategyVersion,
    dnaHash: null,
    candidateDnaHash: null,
    parameterHash: null,
    marketDnaHash: null,
    executionModel: null,
    replayMode: null,
    generation: 0,
    mutationNumber: 0,
    lineage: null,
    genome: null
  };
}

function materializeRuntime(input = {}) {
  const identity = normalizeIdentity(input);
  const runtimeId = `runtime_${hashObject({
    version: RUNTIME_VERSION,
    sourceType: identity.sourceType,
    sourceId: identity.sourceId,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    dnaHash: identity.dnaHash,
    candidateDnaHash: identity.candidateDnaHash,
    parameterHash: identity.parameterHash,
    marketDnaHash: identity.marketDnaHash,
    executionModel: identity.executionModel,
    replayMode: identity.replayMode,
    generation: identity.generation,
    mutationNumber: identity.mutationNumber
  }).slice(0, 32)}`;

  return Object.freeze({
    ok: true,
    runtimeId,
    runtimeVersion: RUNTIME_VERSION,
    safety: SAFETY,
    capabilities: CAPABILITIES,
    ...identity
  });
}

function createStrategyRuntime(overrides = {}) {
  const deps = {
    calcIndicators,
    classifyNarrowState,
    applyEngineV3,
    calcMarketRegimeV2,
    applyMarketRegimeV2,
    applyHistoricalEdge,
    ...overrides
  };

  function execute({ symbol, candles, mode = 'scan_only', refResult = null, lastUpdate = null, runtimeContext = null } = {}) {
    if (!symbol) {
      return { ok: false, reason: 'missing_symbol' };
    }
    if (!Array.isArray(candles) || candles.length === 0) {
      return { ok: false, reason: 'missing_candles' };
    }

    const runtime = materializeRuntime(runtimeContext || {});
    const indicators = deps.calcIndicators(candles);
    if (!indicators) {
      return { ok: false, reason: 'indicators_unavailable', runtime };
    }

    const lastCandle = candles[candles.length - 1];
    const candleTime = lastUpdate || lastCandle.t || lastCandle.ts || null;
    const price = Number(lastCandle.c);

    let result = deps.classifyNarrowState({
      symbol,
      price,
      candles2m: candles,
      indicators,
      lastUpdate: candleTime
    });

    result = deps.applyEngineV3(result, refResult);
    const regimeBase = refResult || result;
    const regime = deps.calcMarketRegimeV2(regimeBase);
    result = deps.applyMarketRegimeV2(result, regime);
    result = deps.applyHistoricalEdge(result);

    return {
      ok: true,
      runtime,
      mode,
      result: {
        ...result,
        strategyRuntime: {
          runtimeId: runtime.runtimeId,
          runtimeVersion: runtime.runtimeVersion,
          sourceType: runtime.sourceType,
          strategyId: runtime.strategyId,
          strategyVersion: runtime.strategyVersion
        }
      }
    };
  }

  return Object.freeze({
    materialize: materializeRuntime,
    execute
  });
}

const defaultStrategyRuntime = createStrategyRuntime();

module.exports = {
  RUNTIME_VERSION,
  SAFETY,
  CAPABILITIES,
  createStrategyRuntime,
  defaultStrategyRuntime,
  materializeRuntime,
  _internal: {
    stableStringify,
    hashObject,
    normalizeIdentity,
    firstValue
  }
};
