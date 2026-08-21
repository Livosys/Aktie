'use strict';

const assert = require('node:assert/strict');
const service = require('./strategyResearchSpecificationService');

const fakeCoverage = {
  listDates(root) { return root === 'MNQ' || root === 'MES' ? ['2026-08-01'] : []; },
  listCompleteDays() { return ['2026-08-01']; },
};
const fakeStore = {
  loadRawBars() { return [{ volume: 100, timestamp: '2026-08-01T10:00:00.000Z' }]; },
};

const options = { coverageService: fakeCoverage, dataStore: fakeStore };
const a = service.buildSpecifications(options);
const b = service.buildSpecifications(options);

assert.deepEqual(a, b, 'same inputs produce deterministic specifications');
assert.deepEqual(a.map((row) => row.strategyId), service.STRATEGY_IDS);

for (const spec of a) {
  assert.equal(spec.schema, service.SPEC_VERSION);
  assert.equal(spec.status, 'RESEARCH_SPECIFIED');
  assert.equal(spec.executable, false);
  assert.equal(spec.runtimeEligible, false);
  assert.equal(spec.historicalData.sourceType, 'real_imported_market_data');
  assert.equal(spec.historicalData.outOfSampleSplitAvailable, false);
  assert.equal(spec.historicalData.sufficientForValidatedStrategy, false);
  assert.ok(spec.researchVariables.length > 0);
  assert.ok(spec.researchVariables.some((row) => row.resolved === false));
  assert.ok(spec.unresolvedBusinessDecisions.length > 0);
  assert.equal(spec.live_trading_enabled, false);
  assert.equal(spec.real_orders_blocked, true);
}

// Stubben speglar aiMemoryService riktiga gränssnitt. Den bar tidigare
// `checkBeforeRun`, en metod som aldrig funnits i AI Memory — kontrollen kunde
// därför bara uppfyllas av en påhittad stub, och med det verkliga minnet
// inkopplat svarade den alltid false.
const work = service.buildResearchWorkItem(a[0], { memory: { lookupOrPlan() {} } });
assert.equal(work.canSchedule, false);
assert.equal(work.status, 'BLOCKED_UNTIL_EXECUTABLE_IDENTITY');
assert.equal(work.memoryAvailable, true);
assert.ok(work.unresolvedParameters.length > 0);

// Och det verkliga minnet måste uppfylla samma kontroll, annars kan stubben
// glida ifrån verkligheten igen.
const realMemory = require('../memory/aiMemoryService').defaultAiMemory;
assert.equal(
  service.buildResearchWorkItem(a[0], { memory: realMemory }).memoryAvailable,
  true,
  'kontrollen känner inte igen det riktiga AI Memory-gränssnittet',
);

assert.throws(() => service.buildSpecification('ema_pullback_continuation', options), /unknown_research_strategy/);

// ── Hypotesen är schemaläggbar där konceptet inte är det ────────────────────
//
// Det är hela skillnaden lagret finns för. Konceptet saknar semantik och
// förblir blockerat; hypotesen är en explicit versionerad tolkning och har
// därför en fullständig experimentidentitet.
const hypotheses = require('./researchHypothesisService');
const boundary = require('./researchDatasetBoundaryService');
const realMemoryForHypothesis = require('../memory/aiMemoryService').defaultAiMemory;
const hypothesisWork = service.buildHypothesisWorkItem(hypotheses.listHypotheses()[0], {
  memory: realMemoryForHypothesis,
  split: boundary.buildSplit(),
});
assert.equal(hypothesisWork.status, 'EXECUTABLE_RESEARCH_HYPOTHESIS');
assert.equal(hypothesisWork.canSchedule, true, 'hypotesen måste kunna schemaläggas');
assert.equal(hypothesisWork.duplicateCheck, 'ai_memory_experiment_key');
assert.deepEqual(hypothesisWork.missingIdentityFields, []);
assert.equal(hypothesisWork.identity.dataAccessMode, 'exact_contract');
// Och den får ändå aldrig bli runtime eller paper.
assert.equal(hypothesisWork.runtimeEligible, false);
assert.equal(hypothesisWork.paperEligible, false);
assert.equal(hypothesisWork.gates.paperEligible, false);
assert.equal(hypothesisWork.gates.runtimeEligible, false);

// Utan minne finns inget dubblettskydd, och då får ingenting schemaläggas.
const noMemory = service.buildHypothesisWorkItem(hypotheses.listHypotheses()[0], { split: boundary.buildSplit() });
assert.equal(noMemory.canSchedule, false);
assert.equal(noMemory.duplicateCheck, 'unavailable_without_ai_memory');

console.log('strategyResearchSpecificationService.test.js passed');
