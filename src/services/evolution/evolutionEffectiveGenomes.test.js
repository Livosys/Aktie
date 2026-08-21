'use strict';

// ── Genom utan verkan ────────────────────────────────────────────────────────
//
// Två fel gjorde att fabriken producerade genom som inte förändrade någonting,
// och rapporterade dem som om de gjorde det.
//
//   1. Trädet svarar `alreadyPresent` när samma arvsmassa nås en andra gång.
//      evolve() kastade bort flaggan, så ett genom som redan fanns räknades som
//      `created` hela vägen upp. Fabriken sa "1 nytt genom" och schemalade en
//      replay — varje cykel, för samma arvsmassa. Mätt: 24 "skapade" genom gav
//      1 ny nod i trädet.
//
//   2. Föräldern hämtades alltid ur registret, alltså generation 0. Varje
//      strategi har en handfull muterbara parametrar och två steg per parameter
//      — åtta enstegsmutationer, sedan var familjen slut. Generation 2 kunde
//      aldrig uppstå, så efter åtta genom var evolutionen steril och allt den
//      producerade var dubbletter.
//
// Testerna kör mot ett eget släktträd i en temporär fil. De rör aldrig
// produktionens träd.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const evolutionModule = require('./evolutionEngineService');
const familyTreeModule = require('./strategyFamilyTreeService');
const strategyDna = require('../dna/strategyDnaService');

const CONTEXT = Object.freeze({
  marketDnaHash: 'a'.repeat(16),
  replayMode: 'strategy',
  executionModel: 'simulated_fill',
  executedTimeframe: '2m',
});

function freshEngine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-'));
  const file = path.join(dir, 'tree.jsonl');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* städat nog */ } });
  const tree = familyTreeModule.createStrategyFamilyTree({ eventsFile: file });
  return { engine: evolutionModule.createEvolutionEngine({ familyTree: tree }), tree };
}

function rootDna() {
  const dna = strategyDna.listStrategyDna().find((row) => row.strategyId === 'native_futures_momentum_v1');
  assert.ok(dna, 'testet kräver att momentum-strategin finns i registret');
  return dna;
}

function contextFor(parent) {
  return { ...CONTEXT, strategyVersion: parent.strategyVersion };
}

// ── 1. ett genom som redan fanns är inte nytt ───────────────────────────────

test('samma mutation två gånger skapar bara en nod', (t) => {
  const { engine, tree } = freshEngine(t);
  const parent = rootDna();
  const changes = { 'entry.minBodyPoints': 7.2 };

  const first = engine.evolve({ parentDna: parent, changes, branch: 'test' });
  assert.equal(first.ok, true);
  assert.equal(first.alreadyPresent, false, 'första gången är genomet nytt');

  const second = engine.evolve({ parentDna: parent, changes, branch: 'test' });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyPresent, true, 'andra gången fanns genomet redan');
  assert.equal(second.dna.dnaHash, first.dna.dnaHash);

  const mutations = tree.listNodes().filter((node) => node.generation > 0);
  assert.equal(mutations.length, 1, 'trädet fick två noder för samma arvsmassa');
});

test('en cykel som inte tillför arvsmassa redovisar det', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  // maxCandidates högt nog att uttömma förälderns enstegsmutationer i ETT svep.
  // Med ett lägre tak tar nästa cykel de parametrar som ännu inte prövats, och
  // de genomen är då genuint nya — det är rätt beteende och inte vad det här
  // testet handlar om.
  const opts = { parentDna: parent, context: contextFor(parent), maxCandidates: 24, branch: 'test' };

  const first = engine.createOptimizedDnaCandidates(opts);
  assert.ok(first.created.length > 0, 'första cykeln ska skapa genom');
  assert.equal(first.addedNewGenome, true);
  assert.equal(first.alreadyInTree.length, 0);

  const second = engine.createOptimizedDnaCandidates(opts);
  assert.equal(second.created.length, 0, 'samma förslag igen är inte nya genom');
  assert.equal(second.addedNewGenome, false);
  assert.equal(second.alreadyInTree.length, first.created.length);
});

test('ett lägre tak utforskar de parametrar som återstår, inte samma igen', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  const opts = { parentDna: parent, context: contextFor(parent), maxCandidates: 2, branch: 'test' };

  const first = engine.createOptimizedDnaCandidates(opts);
  const second = engine.createOptimizedDnaCandidates(opts);
  assert.ok(first.created.length > 0);
  assert.ok(second.created.length > 0, 'nästa cykel ska ta de parametrar som ännu inte prövats');

  const firstPaths = first.created.flatMap((row) => Object.keys(row.applied || {}));
  const secondPaths = second.created.flatMap((row) => Object.keys(row.applied || {}));
  assert.equal(
    firstPaths.filter((path_) => secondPaths.includes(path_)).length, 0,
    'samma parameter muterades två cykler i rad trots outforskade kvar',
  );
});

test('trädet växer inte av upprepade cykler mot samma förälder', (t) => {
  const { engine, tree } = freshEngine(t);
  const parent = rootDna();
  const opts = { parentDna: parent, context: contextFor(parent), maxCandidates: 24, branch: 'test' };

  engine.createOptimizedDnaCandidates(opts);
  const afterFirst = tree.listNodes().length;
  engine.createOptimizedDnaCandidates(opts);
  engine.createOptimizedDnaCandidates(opts);
  assert.equal(tree.listNodes().length, afterFirst, 'trädet växte utan att arvsmassa tillkom');
});

// ── 2. evolutionen kan bygga vidare på sig själv ────────────────────────────

test('ett trädnods genom går att återskapa exakt', (t) => {
  const { engine, tree } = freshEngine(t);
  const parent = rootDna();
  const evolved = engine.evolve({ parentDna: parent, changes: { 'entry.minBodyPoints': 7.2 }, branch: 'test' });
  assert.equal(evolved.ok, true);

  const rebuilt = engine.dnaForNode(evolved.dna.dnaHash);
  assert.ok(rebuilt, 'genomet gick inte att återskapa');
  // Hashen MÅSTE stämma. Ett genom med en annan hash är ett annat genom, och
  // att mutera vidare på det hade brutit släktskapet i trädet.
  assert.equal(rebuilt.dnaHash, evolved.dna.dnaHash);
  assert.equal(tree.getNode(rebuilt.dnaHash).generation, 1);
});

test('roten väljs så länge den har outforskade steg kvar', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  assert.equal(engine.nextParentFor(parent.dnaHash), null, 'ingen nod finns i trädet ännu');

  engine.evolve({ parentDna: parent, changes: { 'entry.minBodyPoints': 7.2 }, branch: 'test' });
  const next = engine.nextParentFor(parent.dnaHash);
  assert.ok(next);
  assert.notEqual(next.dnaHash, parent.dnaHash, 'barnet är minst utforskat och ska väljas');
});

test('när rotens steg är uttömda fortsätter evolutionen i nästa generation', (t) => {
  const { engine, tree } = freshEngine(t);
  const root = rootDna();

  // Uttöm rotens enstegsmutationer.
  engine.createOptimizedDnaCandidates({
    parentDna: root, context: contextFor(root), maxCandidates: 24, branch: 'test',
  });
  const generationOne = tree.listNodes().filter((node) => node.generation === 1).length;
  assert.ok(generationOne > 0);

  // Utan fördjupning hade nästa cykel bara gett dubbletter.
  const parent = engine.nextParentFor(root.dnaHash);
  assert.equal(tree.getNode(parent.dnaHash).generation, 1, 'föräldern ska ha fördjupats');

  const deeper = engine.createOptimizedDnaCandidates({
    parentDna: parent, context: contextFor(parent), maxCandidates: 2, branch: 'test',
  });
  assert.ok(deeper.created.length > 0, 'ingen ny arvsmassa i generation 2');
  assert.equal(tree.listNodes().filter((node) => node.generation === 2).length, deeper.created.length);
});

test('en pensionerad gren får inga nya barn', (t) => {
  const { engine, tree } = freshEngine(t);
  const root = rootDna();
  const evolved = engine.evolve({ parentDna: root, changes: { 'entry.minBodyPoints': 7.2 }, branch: 'test' });
  tree.retireNode(evolved.dna.dnaHash, { reason: 'test' });

  const next = engine.nextParentFor(root.dnaHash);
  assert.notEqual(next?.dnaHash, evolved.dna.dnaHash, 'en pensionerad nod valdes som förälder');
});

test('valet av förälder är deterministiskt', (t) => {
  const { engine } = freshEngine(t);
  const root = rootDna();
  engine.createOptimizedDnaCandidates({
    parentDna: root, context: contextFor(root), maxCandidates: 6, branch: 'test',
  });
  assert.equal(engine.nextParentFor(root.dnaHash).dnaHash, engine.nextParentFor(root.dnaHash).dnaHash);
});

test('motorn ger fortfarande ingen behörighet', (t) => {
  const { engine } = freshEngine(t);
  const parent = rootDna();
  const result = engine.createOptimizedDnaCandidates({
    parentDna: parent, context: contextFor(parent), maxCandidates: 1, branch: 'test',
  });
  assert.equal(result.actions_allowed, false);
  assert.equal(result.can_place_orders, false);
  assert.equal(result.live_trading_enabled, false);
});

// ── Nästa förälder väljs på bevis när bevis finns ───────────────────────────
//
// Utan mätvärden är minst-utforskad rätt: att bygga vidare på ett genom man
// inte vet något om är en gissning, inte ett val. Så fort ett genom HAR
// evidens ändras frågan — då är det bästa uppmätta genomet den rimliga
// föräldern, och det är hela poängen med evolution.

test('utan poängsättare väljs den minst utforskade', (t) => {
  const { engine } = freshEngine(t);
  const root = rootDna();
  engine.createOptimizedDnaCandidates({
    parentDna: root, context: contextFor(root), maxCandidates: 4, branch: 'test',
  });
  const chosen = engine.nextParentFor(root.dnaHash);
  assert.ok(chosen);
  // Alla barn har noll barn; roten har fyra. Ett barn ska alltså vinna.
  assert.notEqual(chosen.dnaHash, root.dnaHash);
});

test('med poängsättare vinner det bäst uppmätta genomet', (t) => {
  const { engine, tree } = freshEngine(t);
  const root = rootDna();
  const made = engine.createOptimizedDnaCandidates({
    parentDna: root, context: contextFor(root), maxCandidates: 4, branch: 'test',
  });
  assert.ok(made.created.length > 1);

  const best = made.created[made.created.length - 1].dna.dnaHash;
  const scoreOf = (node) => {
    if (node.dnaHash === best) return 91;
    return node.generation > 0 ? 40 : null;
  };
  assert.equal(engine.nextParentFor(root.dnaHash, { scoreOf }).dnaHash, best);
  assert.equal(tree.getNode(best).generation, 1);
});

test('ett omätt genom är inte samma sak som ett dåligt', (t) => {
  const { engine } = freshEngine(t);
  const root = rootDna();
  const made = engine.createOptimizedDnaCandidates({
    parentDna: root, context: contextFor(root), maxCandidates: 3, branch: 'test',
  });
  const measured = made.created[0].dna.dnaHash;
  // Bara ETT genom är mätt, och det med ett lågt värde. Det ska ändå väljas
  // före de omätta: null betyder "vi vet inte", inte "sämre än noll".
  const scoreOf = (node) => (node.dnaHash === measured ? 3 : null);
  assert.equal(engine.nextParentFor(root.dnaHash, { scoreOf }).dnaHash, measured);
});

test('en trasig poängsättare fäller inte valet', (t) => {
  const { engine } = freshEngine(t);
  const root = rootDna();
  engine.createOptimizedDnaCandidates({
    parentDna: root, context: contextFor(root), maxCandidates: 2, branch: 'test',
  });
  const scoreOf = () => { throw new Error('biblioteket svarade inte'); };
  assert.ok(engine.nextParentFor(root.dnaHash, { scoreOf }), 'valet ska falla tillbaka på utforskning');
});
