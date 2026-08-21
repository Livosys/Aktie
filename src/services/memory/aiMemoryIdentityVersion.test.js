'use strict';

// ── Acceptanstest: versionerad experimentidentitet ──────────────────────────
//
// v1 saknade timeframe, och det var osynligt tills det inte var det. Cykel 1
// körde två hypoteser som deklarerar 5m på 2m av misstag; eftersom timeframe
// inte ingick i nyckeln fick den felaktiga och den riktiga körningen SAMMA
// experimentidentitet, och 37 experiment spänner därför över båda passen.
//
// v2 skiljer dem åt. Testerna bevakar att den skillnaden är verklig, att den
// inte kan smyga tillbaka, och att gammal historik står orörd.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aiMemory = require('./aiMemoryService');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-identity-')), 'experiments.jsonl');
}

const BASE = Object.freeze({
  strategyDnaHash: 'dna-aaa',
  parameterHash: 'param-aaa',
  marketDnaHash: 'market-aaa',
  replayMode: 'strategy',
  executionModel: 'simulated_fill:cfg',
  strategyVersion: 'H006:v1:abc',
});

const ref = (overrides = {}) => ({ source: 'strategy_library', resultType: 'replay', strategyId: 's', libraryRunId: 'r1', ...overrides });

test('1. 2m och 5m ger olika v2-nycklar', () => {
  const onTwo = aiMemory.experimentKey({ ...BASE, declaredTimeframe: '5m', executedTimeframe: '2m' });
  const onFive = aiMemory.experimentKey({ ...BASE, declaredTimeframe: '5m', executedTimeframe: '5m' });
  assert.notEqual(onTwo, onFive, 'den exekverade timeframen måste påverka identiteten');

  // Och den DEKLARERADE räcker inte ensam: det var just skillnaden mellan de
  // två som var felet, så båda måste bära.
  const declaredTwo = aiMemory.experimentKey({ ...BASE, declaredTimeframe: '2m', executedTimeframe: '2m' });
  assert.notEqual(declaredTwo, onTwo, 'deklarerad timeframe måste också ingå');
});

test('2. samma verkliga experiment ger stabil nyckel', () => {
  const spec = { ...BASE, declaredTimeframe: '5m', executedTimeframe: '5m' };
  const first = aiMemory.experimentKey(spec);
  assert.equal(aiMemory.experimentKey({ ...spec }), first);
  // Härkomst får inte läcka in i identiteten — lika lite i v2 som i v1.
  assert.equal(aiMemory.experimentKey({
    ...spec, period: 'annat', symbols: ['MES'], runId: 'annan', requestedBy: 'human',
  }), first);
});

test('3. v1-nycklar är oförändrade och hela driftens historik står stilla', () => {
  // Prefixet ÄR versionen, så v1 räknas ordagrant som förut.
  assert.equal(aiMemory.identityVersionFor(BASE), aiMemory.IDENTITY_VERSIONS.V1);
  assert.equal(
    aiMemory.experimentKey(BASE),
    aiMemory.experimentKey(BASE, { version: aiMemory.IDENTITY_VERSIONS.V1 }),
  );

  // Och varje nyckel som redan står i driftens logg måste gå att räkna om.
  // Skulle den här kontrollen falla har hela cykel 1 och 2 tappat sin identitet.
  const file = aiMemory.DEFAULT_EVENTS_FILE;
  if (!fs.existsSync(file)) return;
  let checked = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== 'EXPERIMENT_RECORDED' || !event.identity) continue;
    checked += 1;
    assert.equal(aiMemory.experimentKey(event.identity), event.experimentKey,
      `nyckeln för ${event.experimentKey} går inte längre att räkna om`);
  }
  assert.ok(checked > 0, 'inga händelser kontrollerades');
});

test('4. dubblettskyddet fungerar för både v1 och v2 — och blandar dem aldrig', () => {
  const memory = aiMemory.createAiMemory({ eventsFile: tmpFile() });

  // Legacy: en v1-spec skyddas av v1-posten, precis som förut.
  const legacySpec = { ...BASE, runId: 'legacy' };
  memory.recordExperiment(legacySpec, ref());
  assert.equal(memory.lookupOrPlan(legacySpec).cached, true);
  assert.equal(memory.lookupOrPlan(legacySpec).identityVersion, aiMemory.IDENTITY_VERSIONS.V1);

  // v2: samma underliggande genom och marknad, men med timeframe. Den får INTE
  // träffa v1-posten — en v1-post vet inte vilken timeframe den kördes i och
  // kan därför inte svara på frågan.
  const fiveMinute = { ...BASE, declaredTimeframe: '5m', executedTimeframe: '5m', runId: 'v2' };
  assert.equal(memory.lookupOrPlan(fiveMinute).cached, false,
    'en v2-fråga får aldrig besvaras av en v1-post — då blandas 2m och 5m igen');

  const written = memory.recordExperiment(fiveMinute, ref({ libraryRunId: 'r2' }));
  assert.equal(written.identityVersion, aiMemory.IDENTITY_VERSIONS.V2);
  assert.equal(memory.lookupOrPlan(fiveMinute).cached, true, 'v2 skyddar sig själv');

  // Och 2m är fortfarande ett annat experiment.
  const twoMinute = { ...fiveMinute, executedTimeframe: '2m' };
  assert.equal(memory.lookupOrPlan(twoMinute).cached, false,
    'dubblettskyddet får inte låta 5m svara för 2m');

  // v1-posten står kvar, läsbar och giltig.
  assert.equal(memory.listExperiments().length, 2);
  assert.equal(memory.listExperiments({ validForLearning: true }).length, 2);
  assert.deepEqual(memory.getStatus().byIdentityVersion, {
    [aiMemory.IDENTITY_VERSIONS.V1]: 1,
    [aiMemory.IDENTITY_VERSIONS.V2]: 1,
  });
});

test('5. en post utan versionsfält är v1 — frånvaron ÄR svaret', () => {
  // Historiken skrivs inte om för att bli självbeskrivande. Projektionen
  // härleder versionen i stället.
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    experimentKey: 'k1',
    type: 'EXPERIMENT_RECORDED',
    identity: { ...BASE },
    libraryRef: ref(),
    at: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-08-01T00:00:00.000Z',
  })}\n`);
  const memory = aiMemory.createAiMemory({ eventsFile: file });
  assert.equal(memory.listExperiments()[0].identityVersion, aiMemory.IDENTITY_VERSIONS.V1);
});

test('6. den exekverade timeframen kommer ur körningen, inte ur strategin', () => {
  // Recordern får aldrig läsa hypotesens metadata för executedTimeframe. Gjorde
  // den det skulle en felkörd timeframe se korrekt ut i minnet, vilket är exakt
  // det fel v2 finns för att fånga.
  const source = fs.readFileSync(
    path.join(__dirname, '../library/strategyLibraryRecorderService.js'), 'utf8',
  );
  const assignment = source.match(/const executedTimeframe = [^;]+;/);
  assert.ok(assignment, 'executedTimeframe sätts inte längre');
  assert.match(assignment[0], /runResult\.config/,
    'executedTimeframe måste komma ur körningens konfiguration');
  assert.doesNotMatch(assignment[0], /hypothes|declared|semantics/i);
});

test('7. en strategi utan deklarerad timeframe har ingen, inte en okänd', () => {
  const memory = aiMemory.createAiMemory({ eventsFile: tmpFile() });
  const none = {
    ...BASE, declaredTimeframe: aiMemory.NO_DECLARED_TIMEFRAME, executedTimeframe: '2m',
  };
  const written = memory.recordExperiment(none, ref());
  assert.equal(written.identityVersion, aiMemory.IDENTITY_VERSIONS.V2);
  // Ett saknat värde är inte samma sak — det ska kasta, inte tyst bli 'none'.
  assert.throws(
    () => aiMemory.experimentKey({ ...BASE, executedTimeframe: '2m' }),
    /incomplete_experiment_key:declaredTimeframe/,
  );
});

console.log('aiMemoryIdentityVersion.test.js loaded');
