'use strict';

// ── Acceptanstest: AI Memory reconciliation ──────────────────────────────────
//
// Bakgrund. 2026-08-19 skrev en verifieringskörning 472 händelser / 93
// experiment i DRIFTENS AI Memory. Biblioteket och släktträdet var omdirigerade
// till en sandlåda via env; AI Memory saknade motsvarande överstyrning, och
// replay-barnprocessen bygger sin recorder med default-minnet.
//
// Följden var ett minne som påstod sig äga 93 experiment vars resultat inte
// fanns någonstans i produktionsbiblioteket — och som via dubblettskyddet
// permanent hade kunnat blockera de riktiga körningarna av samma identiteter.
//
// Testerna här låser fast båda halvorna av åtgärden:
//   1. isolationen (env når hela vägen ned, även genom en barnprocess)
//   2. reconciliation (uteslutning utan radering, och att en utesluten post
//      inte längre blockerar)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const aiMemory = require('./aiMemoryService');

function tmpFile(name = 'experiments.jsonl') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-recon-')), name);
}

function specFor(overrides = {}) {
  return {
    strategyDnaHash: 'dna-aaa',
    parameterHash: 'param-aaa',
    marketDnaHash: 'market-aaa',
    replayMode: 'strategy',
    executionModel: 'simulated_fill:abc',
    strategyVersion: 'v1',
    period: '2026-01-01T13:00:00.000Z..2026-01-01T17:00:00.000Z',
    symbols: ['MNQ', 'MES'],
    runId: 'run-1',
    requestedBy: 'system',
    regimeKeys: ['up/normal'],
    ...overrides,
  };
}

function ref(overrides = {}) {
  return { source: 'strategy_library', resultType: 'replay', strategyId: 's1', libraryRunId: 'run-1', ...overrides };
}

test('1. ett uteslutet experiment raderas inte — händelsen läggs till', () => {
  const file = tmpFile();
  const memory = aiMemory.createAiMemory({ eventsFile: file });
  const written = memory.recordExperiment(specFor(), ref());
  const before = fs.readFileSync(file, 'utf8');

  memory.exclude(written.experimentKey, aiMemory.EXCLUSION_REASONS.SANDBOX_VERIFICATION_ONLY, {
    detail: 'verifieringskörning',
  });

  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before), 'befintliga rader måste stå kvar oförändrade');
  assert.equal(after.trim().split('\n').length, before.trim().split('\n').length + 1);
  assert.deepEqual(
    memory.getHistory(written.experimentKey).map((row) => row.type),
    ['EXPERIMENT_RECORDED', 'EXPERIMENT_EXCLUDED'],
  );
});

test('2. uteslutning blockerar inte längre en legitim körning av samma identitet', () => {
  const memory = aiMemory.createAiMemory({ eventsFile: tmpFile() });
  const written = memory.recordExperiment(specFor(), ref());
  assert.equal(memory.lookupOrPlan(specFor()).cached, true, 'före uteslutning ska minnet svara cached');

  memory.exclude(written.experimentKey, aiMemory.EXCLUSION_REASONS.SANDBOX_VERIFICATION_ONLY);

  const plan = memory.lookupOrPlan(specFor());
  assert.equal(plan.cached, false, 'ett uteslutet experiment får aldrig svara cached');
  assert.equal(plan.excluded, true, 'men det ska synas ATT posten finns och är utesluten');
  assert.equal(plan.exclusion.reason, 'SANDBOX_VERIFICATION_ONLY');
});

test('3. uteslutna experiment räknas inte som kunskap, men försvinner inte ur revisionen', () => {
  const memory = aiMemory.createAiMemory({ eventsFile: tmpFile() });
  const a = memory.recordExperiment(specFor(), ref());
  memory.recordExperiment(specFor({ marketDnaHash: 'market-bbb', runId: 'run-2' }), ref({ libraryRunId: 'run-2' }));
  memory.exclude(a.experimentKey, aiMemory.EXCLUSION_REASONS.ORPHANED);

  assert.equal(memory.listExperiments().length, 2, 'hela sanningen ska gå att läsa');
  assert.equal(memory.listExperiments({ validForLearning: true }).length, 1);
  assert.equal(memory.experimentsForDna('dna-aaa').length, 1, 'lärande vägar ser bara giltiga poster');
  assert.equal(memory.experimentsForDna('dna-aaa', { includeExcluded: true }).length, 2);

  const status = memory.getStatus();
  assert.equal(status.experiments, 2);
  assert.equal(status.excluded, 1);
  assert.equal(status.validForLearning, 1);
});

test('4. en uteslutning kräver en känd orsak och ett känt experiment', () => {
  const memory = aiMemory.createAiMemory({ eventsFile: tmpFile() });
  const written = memory.recordExperiment(specFor(), ref());
  assert.throws(() => memory.exclude(written.experimentKey, 'FÖR_ATT_JAG_VILL'), /unknown_exclusion_reason/);
  assert.throws(
    () => memory.exclude('finns-inte', aiMemory.EXCLUSION_REASONS.ORPHANED),
    /unknown_experiment/,
    'en annullering får inte kunna skapa en post ur ingenting',
  );
});

test('5. AI_MEMORY_EVENTS_FILE styr default-minnet — annars skriver en sandlåda i drift', () => {
  const file = tmpFile();
  const script = `
    process.env.AI_MEMORY_EVENTS_FILE = ${JSON.stringify(file)};
    const m = require(${JSON.stringify(path.join(__dirname, 'aiMemoryService.js'))});
    process.stdout.write(m.defaultAiMemory.eventsFile);
  `;
  const seen = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(seen, file, 'default-minnet måste följa env, inte den inbyggda sökvägen');
});

test('6. env når hela vägen ned i en barnprocess — det var den vägen läckan gick', () => {
  const file = tmpFile();
  const worker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-child-')), 'worker.js');
  fs.writeFileSync(worker, `
    const m = require(${JSON.stringify(path.join(__dirname, 'aiMemoryService.js'))});
    process.stdout.write(m.defaultAiMemory.eventsFile);
  `);
  // fork() i replayQueueRunnerService skickar { ...process.env, ... } vidare.
  // Testet speglar exakt det: ärvd env, ingen extra parameter.
  const seen = execFileSync(process.execPath, [worker], {
    encoding: 'utf8',
    env: { ...process.env, AI_MEMORY_EVENTS_FILE: file },
  });
  assert.equal(seen, file, 'barnprocessen måste ärva omdirigeringen');
});

test('7. driftens minne är reconcilierat: inga sandlådeexperiment räknas som kunskap', () => {
  const production = aiMemory.defaultAiMemory;
  const rows = production.listExperiments();
  if (!rows.length) return; // tomt minne är också ett konsekvent minne

  const sandboxWindow = rows.filter((row) => (row.provenance || [])
    .some((p) => String(p.recordedAt || '') >= '2026-08-19T07:00:00.000Z'
      && String(p.recordedAt || '') <= '2026-08-19T10:30:00.000Z'));

  for (const row of sandboxWindow) {
    assert.equal(row.excluded, true,
      `experiment ${row.experimentKey} från verifieringsfönstret måste vara uteslutet`);
    assert.equal(production.validForLearning(row), false);
  }
});

console.log('aiMemoryReconciliation.test.js loaded');
