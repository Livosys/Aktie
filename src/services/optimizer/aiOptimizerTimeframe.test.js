'use strict';

// ── Acceptanstest: optimeraren och AI Memory v2 ─────────────────────────────
//
// Optimeraren byggde tidigare alltid v1-identiteter. Det var inte ett medvetet
// val utan en vitlistning: normalizeContext plockade fram en fast uppsättning
// fält, och timeframe fanns inte bland dem — så genomsläppet längre ned var död
// kod och ingen anropare kunde nå v2 hur kontexten än fylldes.
//
// Följden hade varit att evolutionens experiment inte skilde 2m från 5m, alltså
// exakt det fel v2 stänger — en nivå upp.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const optimizerModule = require('./aiOptimizerService');
const aiMemory = require('../memory/aiMemoryService');
const scheduler = require('../replaySchedulerService');

const optimizer = optimizerModule.createAiOptimizer({});
const normalize = optimizer._internal.normalizeContext;
const DNA = Object.freeze({ dnaHash: 'dna-aaa', parameterHash: 'param-aaa', strategyVersion: 'v1' });
const BASE = Object.freeze({ marketDnaHash: 'market-aaa', replayMode: 'strategy', executionModel: 'simulated_fill' });

function keyFor(overrides = {}) {
  const context = normalize({ ...BASE, ...overrides });
  assert.equal(context.ok, true, context.reason);
  return aiMemory.experimentKey(optimizer.buildExperimentSpec(DNA, context));
}

function versionFor(overrides = {}) {
  const context = normalize({ ...BASE, ...overrides });
  return aiMemory.identityVersionFor(optimizer.buildExperimentSpec(DNA, context));
}

test('1. optimeraren med 2m skapar en v2-identitet', () => {
  assert.equal(versionFor({ executedTimeframe: '2m', declaredTimeframe: '2m' }), aiMemory.IDENTITY_VERSIONS.V2);
});

test('2. 5m ger en ANNAN v2-identitet', () => {
  const onTwo = keyFor({ executedTimeframe: '2m', declaredTimeframe: '5m' });
  const onFive = keyFor({ executedTimeframe: '5m', declaredTimeframe: '5m' });
  assert.equal(versionFor({ executedTimeframe: '5m', declaredTimeframe: '5m' }), aiMemory.IDENTITY_VERSIONS.V2);
  assert.notEqual(onTwo, onFive, 'dubblettskyddet skiljer inte 2m från 5m');
});

test('3. samma experiment och timeframe ger stabil nyckel', () => {
  const first = keyFor({ executedTimeframe: '5m', declaredTimeframe: '5m' });
  assert.equal(keyFor({ executedTimeframe: '5m', declaredTimeframe: '5m' }), first);
  // Härkomst får inte flytta identiteten.
  assert.equal(keyFor({
    executedTimeframe: '5m', declaredTimeframe: '5m',
    period: 'annat', symbols: ['MES'], requestedBy: 'human', regimeKeys: ['up/quiet'],
  }), first);
});

test('4. saknad verklig timeframe märks aldrig som v2', () => {
  assert.equal(versionFor({}), aiMemory.IDENTITY_VERSIONS.V1);
  assert.equal(versionFor({ executedTimeframe: null }), aiMemory.IDENTITY_VERSIONS.V1);
  assert.equal(versionFor({ executedTimeframe: '' }), aiMemory.IDENTITY_VERSIONS.V1);
  // En DEKLARERAD timeframe utan en exekverad räcker inte. Det vore att påstå
  // hur körningen gick utifrån vad strategin önskade.
  assert.equal(versionFor({ declaredTimeframe: '5m' }), aiMemory.IDENTITY_VERSIONS.V1);
  // Och v1-nyckeln ska vara ordagrant densamma som före ändringen.
  assert.equal(keyFor({}), aiMemory.experimentKey({
    strategyDnaHash: DNA.dnaHash, parameterHash: DNA.parameterHash,
    marketDnaHash: BASE.marketDnaHash, replayMode: BASE.replayMode,
    executionModel: BASE.executionModel, strategyVersion: DNA.strategyVersion,
  }));
});

test('5. en strategi utan deklarerad timeframe får "none", inte null', () => {
  // Med en exekverad timeframe MÅSTE declaredTimeframe finnas, annars kastar
  // nyckelberäkningen. 'none' är svaret "strategin deklarerar ingen".
  const context = normalize({ ...BASE, executedTimeframe: '2m' });
  assert.equal(context.declaredTimeframe, 'none');
  assert.doesNotThrow(() => aiMemory.experimentKey(optimizer.buildExperimentSpec(DNA, context)));
  // Utan exekverad timeframe ska fältet inte hittas på.
  assert.equal(normalize({ ...BASE }).declaredTimeframe, null);
});

test('6. timeframen kommer ur replay-konfigurationen, inte ur strategimetadata', () => {
  // resolveJobTimeframe är den ENDA definitionen, och den läses av både
  // schemaläggaren och orchestratorn.
  assert.equal(typeof scheduler.resolveJobTimeframe, 'function');
  assert.equal(scheduler.resolveJobTimeframe({ job: { execution_model: { timeframe: '5M' } } }), '5m');
  assert.equal(scheduler.resolveJobTimeframe({ config: { timeframe: '1m' } }), '1m');
  // Null när ingenting anger någon — motorns förval hör hemma vid exekvering,
  // inte vid förslaget.
  assert.equal(scheduler.resolveJobTimeframe({}), null);
  assert.equal(scheduler.DEFAULT_JOB_TIMEFRAME, '2m');

  const orchestrator = fs.readFileSync(
    path.join(__dirname, '../factory/aiFactoryOrchestratorService.js'), 'utf8',
  );
  const fn = orchestrator.slice(orchestrator.indexOf('function plannedExecutedTimeframe'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /replaySchedulerModule\.resolveJobTimeframe/);
  // Orchestratorn får inte räkna ut den på egen hand.
  assert.doesNotMatch(body, /\|\|\s*'2m'/);
});

test('7. optimeraren når faktiskt v2 genom propose()', () => {
  // Slutet-till-slutet: utan genomsläppet i normalizeContext var v2 onåbart
  // oavsett hur anroparen fyllde kontexten.
  const seen = [];
  const memory = {
    lookupOrPlan(spec) {
      seen.push(spec);
      return { cached: false, experimentKey: aiMemory.experimentKey(spec), spec };
    },
    experimentsForDna: () => [],
  };
  const withMemory = optimizerModule.createAiOptimizer({ memory });
  const plan = withMemory.propose({
    parentDna: {
      dnaHash: 'dna-aaa',
      parameterHash: 'param-aaa',
      strategyVersion: 'v1',
      genome: { exit: { values: { takeProfitR: 1.8 }, mutable: true, provenance: 'declared' } },
    },
    context: { ...BASE, executedTimeframe: '5m', declaredTimeframe: '5m' },
    maxCandidates: 1,
  });
  assert.equal(plan.ok, true, plan.reason);
  assert.ok(seen.length > 0, 'optimeraren frågade aldrig minnet');
  for (const spec of seen) {
    assert.equal(spec.executedTimeframe, '5m');
    assert.equal(aiMemory.identityVersionFor(spec), aiMemory.IDENTITY_VERSIONS.V2);
  }
});

console.log('aiOptimizerTimeframe.test.js loaded');
