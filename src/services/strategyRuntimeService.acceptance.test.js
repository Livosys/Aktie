'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  createStrategyRuntime,
  materializeRuntime,
  SAFETY
} = require('./strategyRuntimeService');

function repoPath(...parts) {
  return path.resolve(__dirname, '..', '..', ...parts);
}

function readSource(...parts) {
  return fs.readFileSync(repoPath(...parts), 'utf8');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function makeCandles(count = 24) {
  return Array.from({ length: count }, (_, index) => ({
    t: `2026-01-01T10:${String(index).padStart(2, '0')}:00.000Z`,
    o: 100 + index,
    h: 101 + index,
    l: 99 + index,
    c: 100.5 + index,
    v: 1000 + index
  }));
}

function makeRuntime() {
  const calls = [];
  const runtime = createStrategyRuntime({
    calcIndicators(candles) {
      calls.push('indicators');
      return { candleCount: candles.length };
    },
    classifyNarrowState(input) {
      calls.push('classify');
      return {
        symbol: input.symbol,
        price: input.price,
        lastUpdate: input.lastUpdate,
        state: 'HIGH_QUALITY_NARROW',
        signal: 'LONG_TRIGGERED',
        eventType: 'BULLISH_COLOR_CHANGE',
        tradeScore: 80,
        scores: { quality: 80 }
      };
    },
    applyEngineV3(result, refResult) {
      calls.push('engine');
      return { ...result, refSeen: Boolean(refResult) };
    },
    calcMarketRegimeV2(input) {
      calls.push('regime');
      return { source: input.symbol, trend: 'neutral' };
    },
    applyMarketRegimeV2(result, regime) {
      calls.push('regime_apply');
      return { ...result, marketContext: regime };
    },
    applyHistoricalEdge(result) {
      calls.push('edge');
      return { ...result, historicalEdge: { ok: true } };
    }
  });
  return { runtime, calls };
}

function assertStableRuntime(input) {
  const first = materializeRuntime(input);
  const second = materializeRuntime(input);
  assert.strictEqual(first.runtimeId, second.runtimeId);
  return first;
}

{
  const registered = assertStableRuntime({
    strategy: { strategyId: 'registered_alpha', strategyVersion: 'v1' }
  });
  assert.strictEqual(registered.sourceType, 'registered_strategy');
  assert.strictEqual(registered.strategyId, 'registered_alpha');

  const original = assertStableRuntime({
    dna: {
      strategyId: 'mean_reversion',
      strategyVersion: 'v2',
      dnaHash: 'dna_original',
      parameterHash: 'params_original'
    }
  });
  assert.strictEqual(original.sourceType, 'original_dna');
  assert.strictEqual(original.dnaHash, 'dna_original');

  const mutated = assertStableRuntime({
    mutatedDna: {
      strategyId: 'mean_reversion',
      strategyVersion: 'v2',
      dnaHash: 'dna_original',
      candidateDnaHash: 'dna_mutated',
      parameterHash: 'params_mutated',
      lineage: { generation: 2, mutationNumber: 7 }
    }
  });
  assert.strictEqual(mutated.sourceType, 'mutated_dna');
  assert.strictEqual(mutated.candidateDnaHash, 'dna_mutated');
  assert.strictEqual(mutated.generation, 2);
  assert.notStrictEqual(original.runtimeId, mutated.runtimeId);

  const experiment = assertStableRuntime({
    experiment: {
      experimentId: 'experiment_001',
      strategyId: 'mean_reversion',
      strategyVersion: 'v2',
      dnaHash: 'dna_original',
      candidateDnaHash: 'dna_mutated',
      parameterHash: 'params_mutated',
      marketDnaHash: 'market_hash',
      executionModel: 'paper_sim',
      replayMode: 'historical',
      generation: 2,
      mutationNumber: 7
    }
  });
  assert.strictEqual(experiment.sourceType, 'experiment');
  assert.strictEqual(experiment.sourceId, 'experiment_001');
}

{
  const { runtime, calls } = makeRuntime();
  const result = runtime.execute({
    symbol: 'MNQ',
    candles: makeCandles(),
    mode: 'scan_only',
    refResult: { symbol: 'MES' },
    runtimeContext: {
      strategy: { strategyId: 'registered_alpha', strategyVersion: 'v1' }
    }
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(calls, ['indicators', 'classify', 'engine', 'regime', 'regime_apply', 'edge']);
  assert.strictEqual(result.result.symbol, 'MNQ');
  assert.strictEqual(result.result.strategyRuntime.strategyId, 'registered_alpha');
  assert.strictEqual(result.runtime.safety, SAFETY);
}

{
  const { runtime } = makeRuntime();
  const paperRuntime = runtime.materialize({
    paperCandidate: {
      candidateId: 'paper_candidate_1',
      strategyId: 'paper_momentum',
      strategyVersion: 'paper-v1',
      executionModel: 'paper'
    }
  });

  assert.strictEqual(paperRuntime.sourceType, 'paper_candidate');
  assert.strictEqual(paperRuntime.strategyId, 'paper_momentum');

  const result = runtime.execute({
    symbol: 'MES',
    candles: makeCandles(),
    runtimeContext: {
      paperCandidate: {
        candidateId: 'paper_candidate_1',
        strategyId: 'paper_momentum',
        strategyVersion: 'paper-v1',
        executionModel: 'paper'
      }
    }
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.result.strategyRuntime.sourceType, 'paper_candidate');
}

{
  const replaySource = stripComments(readSource('src', 'scanner', 'replayEngine.js'));
  assert.match(replaySource, /strategyRuntimeService/);
  assert.match(replaySource, /runtime\.execute\s*\(/);

  for (const forbidden of [
    "require('./indicators')",
    "require('./narrowState')",
    "require('./engineV3')",
    "require('./marketRegimeEngine')",
    "require('./historicalEdge')"
  ]) {
    assert.strictEqual(replaySource.includes(forbidden), false, forbidden);
  }

  for (const forbidden of [
    /\bcalcIndicators\s*\(/,
    /\bclassifyNarrowState\s*\(/,
    /\bapplyEngineV3\s*\(/,
    /\bapplyHistoricalEdge\s*\(/,
    /\bdna\b/i,
    /\bmutation\b/i,
    /\bexperiment\b/i,
    /\boptimizer\b/i,
    /\bevolution\b/i
  ]) {
    assert.strictEqual(forbidden.test(replaySource), false, String(forbidden));
  }
}

{
  const paperSource = stripComments(readSource('src', 'services', 'paperTradingRuntimeService.js'));
  assert.strictEqual(/new\s+\w*Strategy\b/.test(paperSource), false);
  assert.strictEqual(/replayEngine/i.test(paperSource), false);
  assert.strictEqual(/optimizer/i.test(paperSource), false);
  assert.strictEqual(/evolution/i.test(paperSource), false);
  assert.strictEqual(/\bdna\b/i.test(paperSource), false);
}

{
  const nativeScannerSource = stripComments(readSource('src', 'services', 'nativeFuturesScannerService.js'));
  assert.strictEqual(/\bdna\b/i.test(nativeScannerSource), false);
  assert.strictEqual(/optimizer/i.test(nativeScannerSource), false);
  assert.strictEqual(/evolution/i.test(nativeScannerSource), false);
  assert.strictEqual(/\bmutation\b/i.test(nativeScannerSource), false);
}

console.log('strategyRuntimeService acceptance tests passed');
