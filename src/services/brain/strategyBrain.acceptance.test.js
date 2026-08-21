'use strict';

// ── Acceptanstest: kunskapsinsamling och Strategy Brain ─────────────────────
//
// Två saker bär hela fasen:
//
//   · varje replay skapar exakt ett experiment per strategi, och en omkörning
//     skapar inga dubbletter
//   · hjärnan är deterministisk — samma data ger samma rekommendation, annars
//     kan ingen lita på en prioritering som ändrar sig mellan två anrop

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brainModule = require('./strategyBrainService');
const libraryModule = require('../library/strategyLibraryService');
const recorderModule = require('../library/strategyLibraryRecorderService');
const aiMemoryModule = require('../memory/aiMemoryService');
const marketIntelligence = require('../market/marketIntelligenceService');
const strategyDna = require('../dna/strategyDnaService');
const registry = require('../strategyRegistryService');

const SERVICES = path.join(__dirname, '..');

function tmp(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-')), name);
}

let cachedCatalog = null;
function catalog() {
  if (!cachedCatalog) cachedCatalog = marketIntelligence.buildMarketDnaCatalog();
  return cachedCatalog;
}

function freshWorld() {
  const library = libraryModule.createStrategyLibrary({ eventsFile: tmp('lib.jsonl') });
  const memory = aiMemoryModule.createAiMemory({ eventsFile: tmp('mem.jsonl') });
  library.syncFromRegistry();
  return {
    library,
    memory,
    recorder: recorderModule.createStrategyLibraryRecorder({ library, memory }),
    brain: brainModule.createStrategyBrain({ memory }),
  };
}

// En syntetisk körning. Riktiga replays är dyra; det som testas här är
// BOKFÖRINGEN, och den bryr sig inte om var siffrorna kom ifrån.
function fakeRun({ mode = 'strategy', from = '2026-08-11T00:00:00.000Z', to = '2026-08-11T20:00:00.000Z',
  regimeKeys = ['down/normal'], marketHash = 'market-aaa', strategies = null } = {}) {
  const ids = strategies || registry.listStrategies().slice(0, 3).map((row) => row.strategyId || row.strategy_id || row.id);
  const runResult = {
    config: {
      mode, from, to, effectiveTo: to, symbols: ['MNQ', 'MES'],
      fillEngine: { engine: 'simulated_fill', config: { tickSize: 0.25, slippageTicks: 1 } },
    },
    tradesByStrategy: new Map(ids.map((id) => [id, []])),
  };
  const report = {
    marketClassification: { classification: 'range' },
    marketDna: { combinedHash: marketHash, regimeKeys },
    executionScore: { total: 70 },
    strategyScore: {
      perStrategy: ids.map((id, index) => ({
        strategyId: id, total: 50 + index, qualified: true, band: 'promising', components: {},
        stats: {
          trades: 30 + index, winRate: 55, strategyPnlUsd: 400, expectancyUsd: 13,
          profitFactor: 1.6, maxDrawdownUsd: 200, avgWinUsd: 90, avgLossUsd: 60,
        },
      })),
    },
  };
  return { runResult, report, ids };
}

// ── varje replay skapar experiment ══════════════════════════════════════════

test('varje replay skapar exakt ett experiment per strategi', () => {
  const { recorder, memory } = freshWorld();
  const { runResult, report, ids } = fakeRun();

  const out = recorder.recordReplayRun(runResult, report, { requestedBy: 'manual' });
  assert.equal(out.experiments.length, ids.length);
  assert.ok(out.experiments.every((row) => row.recorded), JSON.stringify(out.experiments));
  assert.equal(memory.getStatus().experiments, ids.length,
    'antalet experiment matchar inte antalet strategier i körningen');

  // Ett experiment per STRATEGI, inte per körning: minnets fråga — "har vi
  // prövat det HÄR genomet i den HÄR marknaden?" — är per strategi.
  const dnaHashes = new Set(memory.listExperiments().map((row) => row.identity.strategyDnaHash));
  assert.equal(dnaHashes.size, ids.length, 'två strategier delade experiment');
});

test('samma replay igen ger inga dubbletter', () => {
  const { recorder, memory } = freshWorld();
  const { runResult, report, ids } = fakeRun();

  recorder.recordReplayRun(runResult, report, { requestedBy: 'manual' });
  const second = recorder.recordReplayRun(runResult, report, { requestedBy: 'regression' });

  const status = memory.getStatus();
  assert.equal(status.experiments, ids.length, 'en omkörning skapade nya experiment');
  assert.equal(status.observations, ids.length * 2);
  // Upprepningen döljs inte — den räknas, och recordern säger ifrån.
  assert.equal(status.repeats, ids.length);
  assert.ok(second.experiments.every((row) => row.repeat === true),
    'recordern rapporterade inte att körningen var onödig');
});

test('requestedBy lagras men identifierar inte', () => {
  const { recorder, memory } = freshWorld();
  const { runResult, report, ids } = fakeRun();

  recorder.recordReplayRun(runResult, report, { requestedBy: 'evolution' });
  recorder.recordReplayRun(runResult, report, { requestedBy: 'batch' });

  // Samma DNA, samma marknad, olika beställare = SAMMA experiment. Låg
  // beställaren i nyckeln skulle varje beställartyp få köra om allt en gång var.
  assert.equal(memory.getStatus().experiments, ids.length);

  const record = memory.listExperiments()[0];
  assert.deepEqual(record.provenance.map((row) => row.requestedBy), ['evolution', 'batch']);
  assert.ok(!('requestedBy' in record.identity), 'beställaren läckte in i identiteten');

  // En okänd beställare blir 'system', aldrig tomt.
  const { runResult: r2, report: p2 } = fakeRun({ marketHash: 'market-bbb' });
  recorder.recordReplayRun(r2, p2, { requestedBy: 'något-påhittat' });
  const other = memory.listExperiments().find((row) => row.identity.marketDnaHash === 'market-bbb');
  assert.equal(other.provenance[0].requestedBy, 'system');
});

test('experimentindexet pekar på Library, som bär replaymåtten', () => {
  const { library, recorder, memory } = freshWorld();
  const { runResult, report } = fakeRun();
  recorder.recordReplayRun(runResult, report, { requestedBy: 'manual' });

  const experiment = memory.listExperiments()[0];
  assert.equal(experiment.result, undefined, 'AI Memory lagrar fortfarande replay-resultat');
  for (const field of aiMemoryModule.REMOVED_RESULT_FIELDS) {
    assert.ok(!(field in experiment), `AI Memory exponerar fortfarande ${field}`);
  }

  const ref = experiment.libraryRef;
  assert.equal(ref.source, 'strategy_library');
  assert.equal(ref.resultType, 'replay');
  const record = library.getStrategy(ref.strategyId);
  const replay = record.replayHistory.find((row) => row.runId === ref.libraryRunId);
  assert.ok(replay, 'Library saknar replayraden som Memory pekar på');

  assert.equal(replay.trades, 30, 'tradeCount/sampleSize finns som Library replayHistory.trades');
  assert.equal(replay.strategyScore, 50);
  assert.equal(replay.executionScore, 70);
  assert.ok(record.confidenceScore != null, 'confidenceScore finns i Library score-projektion');
  assert.equal(replay.marketClassification, 'range');
  assert.equal(replay.strategyPnlUsd, 400);
  assert.equal(replay.winRate, 55);
  assert.equal(replay.profitFactor, 1.6);
  assert.equal(replay.expectancyUsd, 13);
  assert.equal(replay.maxDrawdownUsd, 200);
  assert.equal(replay.avgWinUsd, 90);
  assert.equal(replay.avgLossUsd, 60);
  assert.equal(replay.qualified, true);
  assert.equal(replay.band, 'promising');
  assert.equal(replay.recoveryFactor, 2, '400 / 200 ska ge 2');
  assert.equal(replay.sharpe, null);
  assert.equal(replay.sharpeAvailable, false);
});

test('ett experiment utan Market DNA skrivs inte, det rapporteras', () => {
  const { recorder, memory } = freshWorld();
  const { runResult, report } = fakeRun();
  report.marketDna = { combinedHash: null, regimeKeys: [] };

  const out = recorder.recordReplayRun(runResult, report, { requestedBy: 'manual' });
  assert.ok(out.experiments.every((row) => row.recorded === false));
  assert.ok(out.experiments.every((row) => row.reason === 'no_market_dna'));
  assert.equal(memory.getStatus().experiments, 0);
  // Biblioteket skrevs ändå — bokföringen av körningen är oberoende av minnet.
  assert.ok(out.written.length > 0);
});

// ── Strategy Brain ══════════════════════════════════════════════════════════

test('Strategy Brain är deterministisk', () => {
  const { library, recorder, brain } = freshWorld();
  const { runResult, report } = fakeRun();
  recorder.recordReplayRun(runResult, report, { requestedBy: 'manual' });

  const now = new Date('2026-08-17T12:00:00.000Z');
  const a = brain.analyze({ library, catalog: catalog(), now });
  const b = brain.analyze({ library, catalog: catalog(), now });

  assert.deepEqual(a.strategies, b.strategies, 'analysen skiljer sig mellan två anrop');
  assert.deepEqual(a.priority, b.priority, 'prioriteringen är inte reproducerbar');
  assert.deepEqual(a.nextReplay, b.nextReplay);
  assert.deepEqual(a.recommendations, b.recommendations);

  // Källkodsregel: ingen egen klocka, ingen slump.
  const source = fs.readFileSync(path.join(__dirname, 'strategyBrainService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source, /Math\.random\(/, 'hjärnan är slumpmässig');
  assert.doesNotMatch(source, /Date\.now\(/, 'hjärnan läser sin egen klocka');
});

test('samma data ger samma rekommendation', () => {
  const first = freshWorld();
  const second = freshWorld();
  const now = new Date('2026-08-17T12:00:00.000Z');
  const run = fakeRun();

  first.recorder.recordReplayRun(run.runResult, run.report, { requestedBy: 'manual' });
  second.recorder.recordReplayRun(run.runResult, run.report, { requestedBy: 'evolution' });

  const a = first.brain.analyze({ library: first.library, catalog: catalog(), now });
  const b = second.brain.analyze({ library: second.library, catalog: catalog(), now });

  assert.deepEqual(
    a.strategies.map((row) => [row.strategyId, row.recommendation.action, row.knowledgeScore]),
    b.strategies.map((row) => [row.strategyId, row.recommendation.action, row.knowledgeScore]),
    'två identiska världar gav olika rekommendationer',
  );
});

test('olika Market DNA ändrar prioriteringen', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');
  const regimes = Object.keys(catalog().summary.regimeCounts);
  assert.ok(regimes.length >= 2, 'för få regimer i lagret');

  function worldTestedIn(regimeKey, marketHash) {
    const world = freshWorld();
    const run = fakeRun({ regimeKeys: [regimeKey], marketHash });
    world.recorder.recordReplayRun(run.runResult, run.report, { requestedBy: 'manual' });
    return world.brain.analyze({ library: world.library, catalog: catalog(), now });
  }

  const inFirst = worldTestedIn(regimes[0], 'market-1');
  const inSecond = worldTestedIn(regimes[1], 'market-2');

  const gapsA = inFirst.strategies[0].blindSpots;
  const gapsB = inSecond.strategies[0].blindSpots;
  assert.notDeepEqual(gapsA, gapsB, 'olika testad regim gav samma blinda fläckar');

  // Och nästa rekommenderade körning pekar på olika hål.
  const targetsA = inFirst.priority.slice(0, 5).map((job) => job.targetRegime);
  const targetsB = inSecond.priority.slice(0, 5).map((job) => job.targetRegime);
  assert.notDeepEqual(targetsA, targetsB, 'prioriteringen påverkades inte av marknadsprofilen');
});

test('prioriteringen bygger på informationsvärde, inte på träffsäkerhet', () => {
  const { library, recorder, brain } = freshWorld();
  const now = new Date('2026-08-17T12:00:00.000Z');
  const ids = registry.listStrategies().map((row) => row.strategyId || row.strategy_id || row.id);

  // En strategi med UTMÄRKT resultat men bara en regim.
  const good = fakeRun({ strategies: [ids[0]], regimeKeys: ['down/normal'], marketHash: 'm1' });
  good.report.strategyScore.perStrategy[0].total = 95;
  good.report.strategyScore.perStrategy[0].stats.winRate = 90;
  recorder.recordReplayRun(good.runResult, good.report, { requestedBy: 'manual' });

  const analysis = brain.analyze({ library, catalog: catalog(), now });

  // Den strategi som ALDRIG körts ska ha högre informationsvärde än den som
  // presterade bäst. Sorterar man på träffsäkerhet kör man om det man vet.
  const neverRun = analysis.priority.find((job) => job.strategyId === ids[1]);
  const bestPerforming = analysis.priority.find((job) => job.strategyId === ids[0]);
  assert.ok(neverRun.informationGain > bestPerforming.informationGain,
    'den bäst presterande strategin prioriterades över den vi inget vet om');

  // Listan är sorterad fallande på informationsvärde.
  const gains = analysis.priority.map((job) => job.informationGain);
  assert.deepEqual(gains, [...gains].sort((a, b) => b - a));
  assert.equal(analysis.priority[0].informationGain, analysis.nextReplay.informationGain);
});

test('ett experiment som redan finns i minnet får informationsvärde noll', () => {
  const { library, recorder, memory, brain } = freshWorld();
  const now = new Date('2026-08-17T12:00:00.000Z');
  const regimes = Object.keys(catalog().summary.regimeCounts);
  const ids = registry.listStrategies().map((row) => row.strategyId || row.strategy_id || row.id);

  // Kör EN strategi i EN regim och bokför experimentet.
  const run = fakeRun({ strategies: [ids[0]], regimeKeys: [regimes[0]], marketHash: 'm1' });
  recorder.recordReplayRun(run.runResult, run.report, { requestedBy: 'manual' });
  assert.ok(memory.getStatus().experiments > 0);

  const analysis = brain.analyze({ library, catalog: catalog(), now, replayMode: 'strategy' });
  const known = analysis.priority.find(
    (job) => job.strategyId === ids[0] && job.targetRegime === regimes[0],
  );
  if (known) {
    assert.equal(known.alreadyKnown, true);
    assert.equal(known.informationGain, 0,
      'ett känt experiment gavs informationsvärde — då föreslår hjärnan en körning vars svar redan finns');
  }
  // Och nästa förslag är aldrig ett känt experiment.
  assert.ok(!analysis.nextReplay || analysis.nextReplay.alreadyKnown === false);
});

// ── kunskapshål före dom ════════════════════════════════════════════════════

test('tunt underlag ger "det saknas data", inte "strategin är dålig"', () => {
  const { library, recorder, brain } = freshWorld();
  const now = new Date('2026-08-17T12:00:00.000Z');
  const ids = registry.listStrategies().map((row) => row.strategyId || row.strategy_id || row.id);

  // Uselt resultat, men bara fyra affärer i en enda regim.
  const run = fakeRun({ strategies: [ids[0]], regimeKeys: ['down/normal'], marketHash: 'm1' });
  run.report.strategyScore.perStrategy[0].total = 4;
  run.report.strategyScore.perStrategy[0].qualified = false;
  run.report.strategyScore.perStrategy[0].stats.trades = 4;
  run.report.strategyScore.perStrategy[0].stats.strategyPnlUsd = -900;
  recorder.recordReplayRun(run.runResult, run.report, { requestedBy: 'manual' });

  const row = brain.analyze({ library, catalog: catalog(), now })
    .strategies.find((entry) => entry.strategyId === ids[0]);

  assert.equal(row.recommendation.action, brainModule.RECOMMENDATIONS.RETEST,
    'en obeprövad strategi rekommenderades för pensionering');
  assert.notEqual(row.recommendation.action, brainModule.RECOMMENDATIONS.RETIRE);
  assert.match(row.recommendation.motivation, /räcker inte|Aldrig prövad/);
  assert.ok(row.gaps.some((gap) => gap.type === brainModule.GAP_TYPES.SAMPLE_SIZE));
});

test('kunskapshålen täcker hela kravlistan', () => {
  const { library, brain } = freshWorld();
  const gaps = brain.knowledgeGaps({ library, catalog: catalog(), now: new Date('2026-08-17T12:00:00.000Z') });

  // En orörd strategi ska ha samtliga hål.
  const untouched = gaps.byStrategy[0];
  const types = untouched.gaps.map((gap) => gap.type).sort();
  assert.deepEqual(types, Object.values(brainModule.GAP_TYPES).sort(),
    'något av de sju kunskapshålen hittas inte');

  // Systemets egna hål.
  assert.ok(Array.isArray(gaps.systemic.regimesNoStrategyHasSeen));
  assert.equal(gaps.systemic.strategiesNeverRun.length, registry.listStrategies().length);
  assert.equal(gaps.systemic.strategiesWithoutLive.length, registry.listStrategies().length);
});

// ── hjärnan utför aldrig något ══════════════════════════════════════════════

test('Strategy Brain rekommenderar men muterar, optimerar och kör ingenting', () => {
  const { library, brain } = freshWorld();
  const analysis = brain.analyze({ library, catalog: catalog(), now: new Date('2026-08-17T12:00:00.000Z') });
  assert.deepEqual(analysis.capabilities, {
    recommends: true, mutates: false, optimizes: false, runsReplay: false, retires: false,
  });

  // Alla rekommendationer ligger inom den slutna mängden.
  for (const row of analysis.strategies) {
    assert.ok(Object.values(brainModule.RECOMMENDATIONS).includes(row.recommendation.action),
      `okänd rekommendation: ${row.recommendation.action}`);
    assert.ok(row.recommendation.motivation, 'en rekommendation utan motivering går inte att ifrågasätta');
  }

  const source = fs.readFileSync(path.join(__dirname, 'strategyBrainService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const imports = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  const forbidden = imports.filter((name) => /replayEngine|fillEngine|Scanner|brokerRisk|evolution/i.test(name));
  assert.deepEqual(forbidden, [], `hjärnan importerar något den inte får: ${forbidden.join(', ')}`);
  // Den skriver ingenting.
  assert.doesNotMatch(source, /\.record[A-Z]|\.retire\(|\.append\(/, 'hjärnan skriver till ett minne');
});

// ── exekveringskedjan är opåverkad ══════════════════════════════════════════

test('varken replay, native engine eller paper känner till hjärnan eller minnet', () => {
  const chain = [
    ['replay', 'nativeReplayEngineService.js'],
    ['replay', 'replayReportService.js'],
    ['replay', 'replayBookAllocator.js'],
    ['.', 'nativeFuturesScannerService.js'],
    ['.', 'ibPaperBrokerRiskService.js'],
    ['.', 'ibPaperExecutionOrchestratorService.js'],
    ['canonical', 'nativeFuturesSignalProvider.js'],
    ['execution', 'simulatedFillEngine.js'],
    ['trade', 'tradeLedgerService.js'],
  ];
  const forbidden = /require\('[^']*\/(brain|memory|evolution|optimizer|dna)\//;
  for (const [dir, file] of chain) {
    const source = fs.readFileSync(path.join(SERVICES, dir, file), 'utf8');
    assert.doesNotMatch(source, forbidden, `${file} importerar AI-lagret`);
  }

  // Recordern FÅR göra det — den är bryggan. Men den ligger utanför kedjan och
  // anropas efter körningen, inte i den.
  const recorderSource = fs.readFileSync(path.join(SERVICES, 'library', 'strategyLibraryRecorderService.js'), 'utf8');
  assert.match(recorderSource, /require\('\.\.\/memory\/aiMemoryService'\)/);
  const engineSource = fs.readFileSync(path.join(SERVICES, 'replay', 'nativeReplayEngineService.js'), 'utf8');
  assert.doesNotMatch(engineSource, /strategyLibraryRecorder/,
    'replay-motorn anropar recordern — då är den inte längre fri från IO');
});

test('DNA-populationen kommer fortfarande ur registren', () => {
  // Två register, en population: Strategy Registry svarar på vilka strategier
  // som är registrerade, native-registret på vilka som har kod att köra.
  // Biblioteket — och därmed hjärnan — är nycklat på båda, så DNA måste täcka
  // båda. Annars hittar Evolution Engine aldrig sin förälder.
  const nativeRegistry = require('../nativeFuturesStrategyRegistryService');
  const population = new Set([
    ...registry.listStrategies().map((row) => row.strategy_id || row.strategyId),
    ...nativeRegistry.listNativeStrategies({ includeVariants: true }).map((row) => row.strategyId),
  ]);
  assert.equal(strategyDna.listStrategyDna().length, population.size);
  const brainSource = fs.readFileSync(path.join(__dirname, 'strategyBrainService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(brainSource, /native_futures_\w+_v\d/, 'hjärnan har en egen strategilista');
});

// ── Kunskapsvärde: fyra signaler, inte bara hål ─────────────────────────────
//
// Hålen ensamma gav varje otestad strategi samma poäng, och ordningen mellan
// dem avgjordes av bokstavsordning. De tre tilläggen ska var för sig kunna
// ändra ordningen, och totalen ska hålla sig på 0–100 (Replay Queue klipper
// där).

function priorityFor(analysis, strategyId) {
  return analysis.priority.find((row) => row.strategyId === strategyId) || null;
}

// En körning för EN strategi med ett bestämt Strategy Score. Varje körning får
// egen marknadshash och eget datum, annars räknas de som samma experiment.
function runFor(strategyId, score, index) {
  const day = `2026-08-${String(11 + index).padStart(2, '0')}`;
  const { runResult, report } = fakeRun({
    strategies: [strategyId],
    from: `${day}T00:00:00.000Z`,
    to: `${day}T20:00:00.000Z`,
    marketHash: `market-${strategyId}-${index}`,
  });
  report.strategyScore.perStrategy[0].total = score;
  return [runResult, report, { requestedBy: 'manual' }];
}

test('vikterna summerar till 1,0 och totalen håller sig på skalan', () => {
  const brain = brainModule.createStrategyBrain({});
  const weights = brainModule.KNOWLEDGE_WEIGHTS;
  const sum = Object.values(weights).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `vikterna summerar till ${sum}, inte 1,0`);

  const world = freshWorld();
  const analysis = world.brain.analyze({ library: world.library, catalog: catalog() });
  for (const row of analysis.priority) {
    assert.ok(row.informationGain >= 0 && row.informationGain <= 100,
      `${row.strategyId} hamnade utanför skalan: ${row.informationGain}`);
    const components = row.knowledgeValue.components;
    for (const [key, value] of Object.entries(components)) {
      assert.ok(value >= 0 && value <= 100, `komponenten ${key} utanför skalan: ${value}`);
    }
  }
  assert.ok(brain);
});

test('en färdigmätt strategi rankas under en osäker med färre körningar', () => {
  const world = freshWorld();
  const ids = registry.listStrategies().slice(0, 2).map((row) => row.strategy_id);
  const [converged, uncertain] = ids;

  // Samma antal körningar, samma marknad — enda skillnaden är spridningen.
  // Den färdigmätta ger identiskt resultat varje gång; den osäkra svänger.
  for (const [index, score] of [50, 50, 50, 50].entries()) {
    world.recorder.recordReplayRun(...runFor(converged, score, index));
  }
  for (const [index, score] of [10, 90, 20, 80].entries()) {
    world.recorder.recordReplayRun(...runFor(uncertain, score, index));
  }

  const analysis = world.brain.analyze({ library: world.library, catalog: catalog() });
  const a = priorityFor(analysis, converged);
  const b = priorityFor(analysis, uncertain);
  assert.ok(a && b, 'båda strategierna ska finnas i prioriteringen');
  assert.equal(a.knowledgeValue.components.uncertainty, 0, 'noll spridning ska ge noll osäkerhet');
  assert.ok(b.knowledgeValue.components.uncertainty > 0, 'spridning ska ge osäkerhet');
  assert.ok(b.informationGain > a.informationGain,
    `osäker (${b.informationGain}) rankades inte över färdigmätt (${a.informationGain})`);
});

test('avtagande avkastning: fler körningar ger mindre osäkerhetsvärde', () => {
  const world = freshWorld();
  const ids = registry.listStrategies().slice(0, 2).map((row) => row.strategy_id);
  const [few, many] = ids;

  // Samma spridning, olika antal körningar.
  [10, 90].forEach((score, index) => world.recorder.recordReplayRun(...runFor(few, score, index)));
  [10, 90, 10, 90, 10, 90, 10, 90].forEach((score, index) => world.recorder.recordReplayRun(...runFor(many, score, index)));

  const analysis = world.brain.analyze({ library: world.library, catalog: catalog() });
  const a = priorityFor(analysis, few);
  const b = priorityFor(analysis, many);
  assert.ok(a.knowledgeValue.components.uncertainty > b.knowledgeValue.components.uncertainty,
    'en nionde körning ska väga mindre än en tredje');
});

test('experiment som redan finns i AI Memory ger värdet noll', () => {
  // Regressionsvakt för att minnesuppslaget flyttades ut ur den inre loopen.
  const world = freshWorld();
  const dnaRow = strategyDna.listStrategyDna()[0];
  world.memory.lookupOrPlan({
    strategyDnaHash: dnaRow.dnaHash,
    parameterHash: dnaRow.parameterHash,
    marketDnaHash: 'market-aaa',
    replayMode: 'strategy',
    executionModel: 'simulated_fill',
    strategyVersion: dnaRow.strategyVersion || 'v1',
    regimeKeys: ['down/normal'],
    requestedBy: 'test',
  });
  const analysis = world.brain.analyze({ library: world.library, catalog: catalog() });
  const known = analysis.priority.filter((row) => row.alreadyKnown);
  for (const row of known) {
    assert.equal(row.informationGain, 0, `${row.strategyId} bar värde trots känt experiment`);
  }
});
