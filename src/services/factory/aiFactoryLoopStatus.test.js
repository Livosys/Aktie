'use strict';

// ── Statusvyn räknar ingenting eget ─────────────────────────────────────────
//
// Hela poängen med lagret är att varje siffra har en ägare någon annanstans.
// Ett statuslager som räknar om saker blir förr eller senare oense med det det
// beskriver, och då vet ingen vilken siffra som gäller — och frontend, som
// ritar det här svaret, hade ärvt osäkerheten.

const test = require('node:test');
const assert = require('node:assert/strict');

const status = require('./aiFactoryLoopStatusService');

const RUN = 'factory_run_test';
function stepEvents(step, result, at = '2026-08-20T10:00:00.000Z') {
  return [
    { runId: RUN, step, type: 'STEP_STARTED', recordedAt: at },
    { runId: RUN, step, type: 'STEP_COMPLETED', recordedAt: at, result },
  ];
}

const deps = (overrides = {}) => ({
  orchestrator: { getAuditTrail: () => overrides.trail || [] },
  memory: { getStatus: () => ({ experiments: 100, validForLearning: 90, excluded: 10, repeats: 5, distinctMarkets: 7, byIdentityVersion: { 'ai-memory-v2': 100 } }) },
  library: { getStatus: () => ({ strategies: 30, byStage: { draft: 30 } }) },
  replayQueue: { getStatus: () => ({ completed_jobs: [1, 2, 3], pending_jobs: [], paused: false }) },
  policy: { describePolicy: () => ({ policyVersion: 'research-evidence-policy-v2', status: 'approved' }) },
  calendar: { sharedDays: () => new Array(218), DATA_ACCESS_MODES: { EXACT_CONTRACT: 'exact_contract' } },
  ...overrides.deps,
});

test('1. de sju loopstegen visas i ordning', () => {
  const result = status.getLoopStatus(deps());
  assert.deepEqual(result.steps.map((row) => row.id), [
    'KNOWLEDGE_GAP', 'DNA_GENERATION', 'REPLAY_SCHEDULED',
    'HISTORICAL_REPLAY', 'EVIDENCE_RECORDED', 'POLICY_CLASSIFICATION', 'NEXT_DECISION',
  ]);
});

test('2. utan körning är läget idle och inget hittas på', () => {
  const result = status.getLoopStatus(deps());
  assert.equal(result.status.state, 'idle');
  assert.equal(result.status.currentRunId, null);
  for (const step of result.steps) {
    assert.equal(step.status, 'pending');
    assert.equal(step.strategyId ?? null, null, 'ingen strategi får uppfinnas utan körning');
  }
});

test('3. en riktig körning läses ur spåret, inte ur en gissning', () => {
  const trail = [
    ...stepEvents('SELECT_KNOWLEDGE_GAP', { nextReplay: { strategyId: 's1', dnaHash: 'd1', targetRegime: 'up/quiet', informationGain: 42 } }),
    ...stepEvents('CREATE_DNA_GENERATION', { created: [{}], existingExperiments: [], parentDnaHash: 'p1' }),
    ...stepEvents('SCHEDULE_REPLAY', { appended: { created: 1, duplicates: 0 } }),
    ...stepEvents('EXECUTE_QUEUE', {
      executed: true, replayRunId: 'native_replay:2026-08-17', memoryRecorded: true,
      payload: { research: { classified: [{ strategyId: 'research__x__H101', outcome: 'INSUFFICIENT_EVIDENCE', reason: 'gross_edge_holds_but_costs_are_not_carried' }] } },
    }),
  ];
  const result = status.getLoopStatus(deps({ trail }));
  const byId = Object.fromEntries(result.steps.map((row) => [row.id, row]));

  assert.equal(byId.KNOWLEDGE_GAP.status, 'done');
  assert.equal(byId.KNOWLEDGE_GAP.strategyId, 's1');
  assert.match(byId.KNOWLEDGE_GAP.summary, /up\/quiet/);
  // Sammanfattningen skiljer numera på tre utfall: nytt genom, genom som redan
  // låg i släktträdet, och experiment minnet redan kände igen. De två sista
  // slogs tidigare ihop, och ett genom som redan fanns rapporterades då som nytt.
  assert.equal(byId.DNA_GENERATION.summary, '1 nytt genom, 0 fanns redan, 0 redan känt experiment');
  assert.equal(byId.HISTORICAL_REPLAY.status, 'done');
  assert.equal(byId.EVIDENCE_RECORDED.status, 'done');
  assert.equal(byId.POLICY_CLASSIFICATION.status, 'done');
  assert.equal(byId.POLICY_CLASSIFICATION.outcomes.length, 1);
  assert.equal(result.evidence.outcomes.INSUFFICIENT_EVIDENCE, 1);
  assert.equal(result.evidence.outcomes.HISTORICALLY_VALIDATED_CANDIDATE, 0);
  assert.equal(result.status.currentRunId, RUN);
});

test('4. ett överhoppat steg visas som överhoppat med sitt skäl', () => {
  const trail = [
    ...stepEvents('SELECT_KNOWLEDGE_GAP', { nextReplay: { strategyId: 's1' } }),
    ...stepEvents('CREATE_DNA_GENERATION', { skipped: true, reason: 'market_dna_required' }),
  ];
  const byId = Object.fromEntries(status.getLoopStatus(deps({ trail })).steps.map((r) => [r.id, r]));
  assert.equal(byId.DNA_GENERATION.status, 'skipped');
  assert.match(byId.DNA_GENERATION.summary, /market_dna_required/);
});

test('5. siffrorna kommer från sina ägare, oräknade', () => {
  const result = status.getLoopStatus(deps());
  assert.equal(result.memory.validExperiments, 90);
  assert.equal(result.memory.excludedExperiments, 10);
  assert.equal(result.memory.duplicateSkips, 5);
  assert.equal(result.research.experimentsRun, 100);
  assert.equal(result.research.replaysCompleted, 3);
  assert.equal(result.research.historicalDaysAvailable, 218);
  assert.equal(result.research.dataAccessMode, 'exact_contract');
  assert.equal(result.evidence.policyVersion, 'research-evidence-policy-v2');
  assert.equal(result.evidence.policyStatus, 'approved');
  assert.equal(result.library.strategies, 30);
});

test('6. ett trasigt delsystem tar inte ner vyn', () => {
  const broken = deps();
  broken.memory = { getStatus: () => { throw new Error('minnet nere'); } };
  const result = status.getLoopStatus(broken);
  assert.equal(result.ok, true);
  assert.equal(result.memory.validExperiments, null, 'okänt ska vara null, inte noll');
  assert.equal(result.library.strategies, 30, 'övriga källor ska fortfarande läsas');
});

test('7. vyn är read-only och rör ingen orderväg', () => {
  const result = status.getLoopStatus(deps());
  assert.equal(result.readOnly, true);
  assert.equal(result.actions_allowed, false);
  assert.equal(result.can_place_orders, false);
  assert.equal(result.live_trading_enabled, false);
});

test('8. Factory Director anropas inte — den räknar om hela beslutet', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, 'aiFactoryLoopStatusService.js'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /factoryDirectorService/,
    'Direktören kostar 13–15 sekunder per anrop; statusvyn får inte bero på den');
});

console.log('aiFactoryLoopStatus.test.js loaded');
