'use strict';

// ── Acceptanstest: Strategy Lifecycle och Strategy Library ───────────────────
//
// Ett test per acceptanskriterium. Biblioteket körs mot en temporär
// händelselogg så att testerna aldrig rör produktionsdata, men mot det RIKTIGA
// registret och den riktiga paper-loggen — annars prövas inte det som ska
// prövas.
//
// Det viktigaste testet är "historik skrivs aldrig över": det muterar
// biblioteket i alla riktningar och kontrollerar att varje tidigare rad ligger
// kvar byte för byte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const libraryModule = require('./strategyLibraryService');
const recorderModule = require('./strategyLibraryRecorderService');
const lifecycle = require('./strategyLifecycle');
const promotion = require('./promotionEngineService');
const retirement = require('./retirementEngineService');
const confidence = require('../score/confidenceScoreService');
const strategyScoreV1 = require('../score/strategyScoreV1Service');
const strategyRegistry = require('../strategyRegistryService');
const aiMemory = require('../memory/aiMemoryService');

function freshLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-library-'));
  const library = libraryModule.createStrategyLibrary({
    eventsFile: path.join(dir, 'events.jsonl'),
  });
  const memory = aiMemory.createAiMemory({ eventsFile: path.join(dir, 'memory.jsonl') });
  return { library, dir, memory, recorder: recorderModule.createStrategyLibraryRecorder({ library, memory }) };
}

// Driver en strategi framåt utan att bry sig om grindarna — för tester som
// behöver ett visst steg utan att först uppfylla varje krav dit.
function forceTo(library, strategyId, target) {
  let guard = 0;
  while (library.getStrategy(strategyId).lifecycle !== target && guard < 20) {
    const from = library.getStrategy(strategyId).lifecycle;
    const next = lifecycle.nextStage(from);
    if (!next) break;
    library.recordTransition({ strategyId, to: next, reason: 'test_setup', actor: 'test' });
    guard += 1;
  }
  return library.getStrategy(strategyId).lifecycle;
}

// ── 1. Alla strategier finns i Strategy Library ═════════════════════════════

test('1 · alla strategier i registret finns i Strategy Library', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();

  const registered = strategyRegistry.listStrategies().map((row) => row.strategyId || row.strategy_id || row.id).sort();
  const inLibrary = library.listStrategies().map((row) => row.strategyId).sort();
  assert.deepEqual(inLibrary, registered, 'biblioteket speglar inte registret');
  assert.ok(inLibrary.length >= 150, 'biblioteket har inte expanderat tillräckligt många strategier');

  // Varje post har den efterfrågade metadatan.
  for (const record of library.listStrategies()) {
    for (const field of [
      'strategyId', 'executionStrategyId', 'originStrategyId', 'nativeStrategyId',
      'currentVersion', 'lifecycle', 'created', 'lastUpdated', 'owner',
      'currentDnaHash', 'currentMarketDnaHash', 'replayHistory', 'paperHistory',
      'liveHistory', 'promotionHistory', 'retirementHistory', 'executionScore',
      'strategyScore', 'confidenceScore', 'productionScore', 'approvals',
    ]) {
      assert.ok(field in record, `${record.strategyId} saknar fältet ${field}`);
    }
    assert.ok(record.currentDnaHash, 'DNA-hash saknas');
    assert.equal(record.lifecycle, lifecycle.STAGES.DRAFT, 'en ny strategi börjar som utkast');
  }
});

test('1b · synken är idempotent och en NY strategi dyker upp automatiskt', () => {
  const { library } = freshLibrary();
  const first = library.syncFromRegistry();
  const second = library.syncFromRegistry();
  assert.equal(second.created.length, 0, 'andra synken skapade dubbletter');
  assert.equal(second.dnaChanged.length, 0);

  // En strategi som tillkommer i registret får sin post utan att en rad i
  // biblioteket ändras.
  const original = strategyRegistry.listStrategies;
  strategyRegistry.listStrategies = () => [...original(), Object.freeze({
    strategyId: 'native_futures_probe_v0',
    strategy_id: 'native_futures_probe_v0',
    strategyVersion: '0.0.1',
    strategy_version: '0.0.1',
    originStrategyId: null,
    origin_strategy_id: null,
    migrated: false,
    targetSignalFamily: null,
    target_signal_family: null,
    targetSignalSubtype: null,
    target_signal_subtype: null,
    defaultOptions: {
      stopLossPct: 0.2,
      takeProfitR: 1.5,
      holdingTimeMin: 12,
      timeoutMin: 12,
      confidenceThreshold: 65,
      variantKey: 'probe',
      variantLabel: 'Probe',
    },
  })];
  try {
    const third = library.syncFromRegistry();
    assert.deepEqual(third.created, ['native_futures_probe_v0']);
    assert.equal(library.listStrategies().length, first.registryStrategies + 1);
  } finally {
    strategyRegistry.listStrategies = original;
  }
});

// ── 2. Replay uppdaterar Library ════════════════════════════════════════════

test('2 · Replay uppdaterar Library', () => {
  const { library, recorder } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'ema_pullback_continuation';

  const runResult = {
    config: { mode: 'strategy', from: '2026-08-11T00:00:00.000Z', to: '2026-08-14T20:00:00.000Z' },
    tradesByStrategy: new Map([[strategyId, []]]),
  };
  const report = {
    marketClassification: { classification: 'range' },
    // Market DNA följer med rapporten sedan fas 6. Utan den sätts inget
    // marknads-DNA — biblioteket hittar inte på ett.
    marketDna: { combinedHash: 'aabbccdd11223344', regimeKeys: ['flat/normal'] },
    executionScore: { total: 71 },
    strategyScore: {
      perStrategy: [{
        strategyId, total: 62, qualified: true, components: {},
        stats: {
          trades: 40,
          winRate: 55,
          strategyPnlUsd: 300,
          profitFactor: 1.4,
          expectancyUsd: 7.5,
          maxDrawdownUsd: 150,
          avgWinUsd: 80,
          avgLossUsd: 45,
        },
      }],
    },
  };

  const result = recorder.recordReplayRun(runResult, report);
  assert.equal(result.written.length, 1);

  const record = library.getStrategy(strategyId);
  assert.equal(record.replayHistory.length, 1);
  assert.equal(record.replayHistory[0].trades, 40);
  assert.equal(record.replayHistory[0].marketClassification, 'range');
  assert.equal(record.replayHistory[0].profitFactor, 1.4);
  assert.equal(record.replayHistory[0].expectancyUsd, 7.5);
  assert.equal(record.replayHistory[0].maxDrawdownUsd, 150);
  assert.equal(record.replayHistory[0].avgWinUsd, 80);
  assert.equal(record.replayHistory[0].avgLossUsd, 45);
  assert.equal(record.replayHistory[0].band, null);
  assert.equal(record.replayHistory[0].recoveryFactor, 2);
  assert.equal(record.replayHistory[0].sharpe, null);
  assert.equal(record.replayHistory[0].sharpeAvailable, false);
  assert.equal(record.strategyScore, 62);
  assert.equal(record.executionScore, 71);
  assert.ok(record.confidenceScore != null, 'Confidence räknades inte');
  assert.ok(record.currentMarketDnaHash, 'market-DNA sattes inte');
});

// ── 3+4. Paper och Live uppdaterar Library ══════════════════════════════════

test('3 · Paper uppdaterar Library, idempotent', () => {
  const { library, recorder } = freshLibrary();
  library.syncFromRegistry();

  const first = recorder.ingestExecutionHistory({ target: 'paper' });
  assert.ok(first.written > 0, 'inga paper-affärer lästes in — testet vore tomt');
  const second = recorder.ingestExecutionHistory({ target: 'paper' });
  assert.equal(second.written, 0, 'samma affär bokfördes två gånger');
  assert.equal(second.duplicates, first.written);

  const withPaper = library.listStrategies().filter((row) => row.paperHistory.length > 0);
  assert.ok(withPaper.length > 0);
  for (const record of withPaper) {
    assert.ok(record.productionScore != null, 'Production Score räknades inte på paper-affärer');
    const ids = record.paperHistory.map((row) => row.tradeId);
    assert.equal(new Set(ids).size, ids.length, 'dubbletter i paper-historiken');
  }

  // Legacy-id som fortfarande saknar mappning rapporteras, men expansionen kan
  // också ha gjort att ingenting längre faller bort.
  assert.ok(Array.isArray(first.skipped));
  if (first.skipped.length > 0) {
    assert.ok(first.skipped.every((row) => row.reason === 'unresolved_strategy_id'));
  }
  console.log(`    (paper: ${first.written} affärer på ${withPaper.length} strategier`
    + ` · ${first.skipped.length} legacy-affärer utan native-motsvarighet)`);
});

test('4 · Live kan uppdatera Library — samma väg, annan sida', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'ema_pullback_continuation';

  library.recordLiveTrade({
    strategyId, tradeId: 'live-1', openedAt: '2026-08-14T13:00:00.000Z',
    closedAt: '2026-08-14T13:30:00.000Z', symbol: 'MNQ', direction: 'long',
    realizedPnlUsd: 42, exitReason: 'take_profit',
  });
  const record = library.getStrategy(strategyId);
  assert.equal(record.liveHistory.length, 1);
  assert.equal(record.liveHistory[0].tradeId, 'live-1');
  assert.equal(record.paperHistory.length, 0, 'en live-affär hamnade i paper-historiken');
});

// ── 5. Lifecycle fungerar ═══════════════════════════════════════════════════

test('5 · livscykeln tillåter ett steg åt gången och inga hopp', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'ema_pullback_continuation';

  // Framåt ett steg: tillåtet.
  const forward = library.recordTransition({ strategyId, to: lifecycle.STAGES.TESTING, reason: 'test' });
  assert.equal(forward.ok, true);
  assert.equal(forward.direction, lifecycle.DIRECTIONS.PROMOTION);

  // Hoppa: nekas, med besked om vilket steg som gällde.
  const jump = library.recordTransition({ strategyId, to: lifecycle.STAGES.LIVE });
  assert.equal(jump.ok, false);
  assert.match(jump.reason, /^skips_stages/);
  assert.equal(jump.expected, lifecycle.STAGES.LEARNING);

  // Bakåt ett steg: tillåtet, och loggas som degradering.
  const back = library.recordTransition({ strategyId, to: lifecycle.STAGES.DRAFT, reason: 'ångrat' });
  assert.equal(back.ok, true);
  assert.equal(back.direction, lifecycle.DIRECTIONS.DEMOTION);

  // Hela kedjan ska gå att vandra, steg för steg.
  assert.equal(forceTo(library, strategyId, lifecycle.STAGES.LIVE), lifecycle.STAGES.LIVE);
  // 2 ovan (framåt + bakåt) plus 7 steg från draft till live.
  assert.equal(library.getStrategy(strategyId).promotionHistory.length, 9);

  // Ordningen i modulen är livscykeln i uppgiften.
  assert.deepEqual(lifecycle.STAGE_ORDER, [
    'draft', 'testing', 'learning', 'candidate', 'paper', 'monitoring', 'approved', 'live',
  ]);
});

// ── 6. Promotion fungerar ═══════════════════════════════════════════════════

test('6 · Promotion Engine flyttar bara den som uppfyller kraven', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'ema_pullback_continuation';

  // Draft → Testing: bara identitet krävs, och den finns efter synken.
  const first = promotion.applyPromotion(library, strategyId);
  assert.equal(first.ok, true);
  assert.equal(library.getStrategy(strategyId).lifecycle, lifecycle.STAGES.TESTING);

  // Testing → Learning kräver replay-affärer. Utan dem: nej, med skäl.
  const blocked = promotion.evaluatePromotion(library.getStrategy(strategyId));
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blockers.includes('has_replay_runs'));

  library.recordReplayRun({
    strategyId, runId: 'r1', mode: 'strategy', trades: 25, winRate: 60,
    strategyPnlUsd: 500, strategyScore: 70, marketClassification: 'range', qualified: true,
  });
  assert.equal(promotion.applyPromotion(library, strategyId).ok, true);
  assert.equal(library.getStrategy(strategyId).lifecycle, lifecycle.STAGES.LEARNING);

  // Beslutets BEVIS ska ligga kvar med övergången.
  const step = library.getStrategy(strategyId).promotionHistory.at(-1);
  assert.ok(Array.isArray(step.evidence?.checks) && step.evidence.checks.length > 0,
    'befordran sparade inte vad den grundades på');
});

test('6b · Promotion Engine befordrar aldrig till Live på egen hand', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'ema_pullback_continuation';
  forceTo(library, strategyId, lifecycle.STAGES.APPROVED);

  const decision = promotion.evaluatePromotion(library.getStrategy(strategyId));
  assert.equal(decision.to, lifecycle.STAGES.LIVE);
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockers.includes('live_requires_explicit_human_release'));
  assert.equal(promotion.applyPromotion(library, strategyId).ok, false);
});

test('6c · Promotion Engine känner inte till AI', () => {
  const source = fs.readFileSync(path.join(__dirname, 'promotionEngineService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(source, /require\(.*(ai|optimi[sz]|evolution|learning)/i,
    'Promotion Engine importerar något AI-relaterat');
  assert.doesNotMatch(source, /Math\.random\(/, 'befordran får aldrig vara slumpmässig');
});

// ── 7. Retirement fungerar ══════════════════════════════════════════════════

test('7 · pensionering bevarar allt och tar aldrig bort något', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'trend_continuation';

  library.recordScore({ strategyId, scoreType: 'strategyScore', value: 12 });
  library.recordScore({ strategyId, scoreType: 'executionScore', value: 38 });
  library.recordScore({ strategyId, scoreType: 'confidenceScore', value: 55 });
  library.recordMarketDna({
    strategyId,
    marketDnaHash: 'abc123def4567890',
    regimeKeys: ['flat/normal', 'up/normal'],
  });
  forceTo(library, strategyId, lifecycle.STAGES.PAPER);
  const before = library.getStrategy(strategyId);

  const result = retirement.applyRetirement(library, strategyId, { reason: 'persistent_underperformance' });
  assert.equal(result.ok, true);

  const after = library.getStrategy(strategyId);
  assert.equal(after.lifecycle, lifecycle.STAGES.RETIRED);
  assert.equal(after.retired, true);

  // Pensioneringen ska innehålla allt uppgiften kräver.
  const entry = after.retirementHistory.at(-1);
  assert.ok(entry.at, 'datum saknas');
  assert.equal(entry.reason, 'persistent_underperformance');
  assert.equal(entry.lastStrategyScore, 12);
  assert.equal(entry.lastExecutionScore, 38);
  assert.equal(entry.lastConfidenceScore, 55);
  assert.equal(entry.lastMarketDnaHash, before.currentMarketDnaHash);
  assert.equal(entry.fromStage, lifecycle.STAGES.PAPER);

  // Posten finns kvar och är läsbar — AI ska kunna läsa pensionerade strategier.
  assert.ok(library.listStrategies().some((row) => row.strategyId === strategyId));
  assert.equal(after.promotionHistory.length, before.promotionHistory.length,
    'pensioneringen ändrade tidigare historik');

  // Pensionering är slutgiltig.
  assert.equal(library.recordTransition({ strategyId, to: lifecycle.STAGES.LIVE }).ok, false);
  assert.equal(library.recordTransition({ strategyId, to: lifecycle.STAGES.PAPER }).reason, 'retired_is_terminal');
  assert.equal(retirement.applyRetirement(library, strategyId, { reason: 'x' }).retirement.ok, false);
});

test('7b · pensionering kräver ett skäl', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const result = retirement.applyRetirement(library, 'ema_pullback_continuation', {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'retirement_requires_reason');
});

// ── 8. Confidence Score fungerar ════════════════════════════════════════════

test('8 · Confidence Score är ett eget mått och blockerar Candidate', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'ema_pullback_continuation';
  forceTo(library, strategyId, lifecycle.STAGES.LEARNING);

  // Utmärkt Strategy Score, men nästan ingenting bakom sig.
  library.recordReplayRun({
    strategyId, runId: 'r1', trades: 25, winRate: 80, strategyPnlUsd: 900,
    strategyScore: 90, marketClassification: 'range', qualified: true,
    from: '2026-08-14T00:00:00.000Z', to: '2026-08-14T20:00:00.000Z',
  });
  library.recordScore({ strategyId, scoreType: 'strategyScore', value: 90 });
  library.recordScore({ strategyId, scoreType: 'confidenceScore', value: 18 });

  const decision = promotion.evaluatePromotion(library.getStrategy(strategyId));
  assert.equal(decision.to, lifecycle.STAGES.CANDIDATE);
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockers.includes('confidence_score_sufficient'),
    'hög Strategy Score tog sig förbi en låg Confidence Score');
  assert.ok(!decision.blockers.includes('strategy_score_sufficient'),
    'Strategy Score var inte problemet — då mäter testet fel sak');

  // Med kunskapen på plats öppnas grinden.
  library.recordReplayRun({
    strategyId, runId: 'r2', trades: 30, winRate: 62, strategyPnlUsd: 400,
    strategyScore: 88, marketClassification: 'trend_up', qualified: true,
    from: '2026-09-01T00:00:00.000Z', to: '2026-09-20T20:00:00.000Z',
  });
  library.recordScore({ strategyId, scoreType: 'confidenceScore', value: 55 });
  assert.equal(promotion.evaluatePromotion(library.getStrategy(strategyId)).allowed, true);
});

test('8b · Confidence och Strategy Score mäter olika saker', () => {
  // Samma affärer, samma dag, en enda regim: hög kvalitet, låg kunskap.
  const narrow = Array.from({ length: 25 }, (_, i) => ({
    status: 'closed',
    strategyPnlUsd: i % 5 === 0 ? -100 : 200,
    closedAt: '2026-08-14T15:00:00.000Z',
  }));
  const quality = strategyScoreV1.scoreTrades(narrow, { strategyId: 'x' });
  const knowledge = confidence.calculateConfidenceScore(narrow, { marketClassifications: ['range'] });

  assert.ok(quality.total > 60, 'urvalet skulle ge hög Strategy Score');
  assert.ok(knowledge.total < confidence.CANDIDATE_CONFIDENCE_FLOOR,
    'ett smalt urval ska ge låg Confidence');
  assert.equal(knowledge.meetsCandidateFloor, false);
  // Stabilitet över en enda period går inte att mäta — och ska då ge noll,
  // inte halva poängen.
  assert.equal(knowledge.components.stability, 0);
  assert.equal(knowledge.components.months, confidence.CONFIDENCE_MAX.months / 3);
});

// ── 9+10. Historik skrivs aldrig över, allt är spårbart ═════════════════════

test('9 · historik skrivs aldrig över', () => {
  const { library } = freshLibrary();
  library.syncFromRegistry();
  const strategyId = 'ema_pullback_continuation';
  const file = library.eventsFile;

  const snapshots = [];
  const mutate = [
    () => library.recordTransition({ strategyId, to: lifecycle.STAGES.TESTING, reason: 'a' }),
    () => library.recordScore({ strategyId, scoreType: 'strategyScore', value: 40 }),
    () => library.recordScore({ strategyId, scoreType: 'strategyScore', value: 70 }),
    () => library.recordReplayRun({ strategyId, runId: 'r1', trades: 12, strategyScore: 70 }),
    () => library.recordTransition({ strategyId, to: lifecycle.STAGES.DRAFT, reason: 'b' }),
    () => library.recordApproval({ strategyId, decision: 'approved', approvedBy: 'test' }),
    () => library.recordMarketDna({ strategyId, marketDnaHash: 'feed0000cafe1234' }),
  ];

  for (const step of mutate) {
    snapshots.push(fs.readFileSync(file, 'utf8'));
    step();
    const current = fs.readFileSync(file, 'utf8');
    // Allt som stod där innan står kvar, oförändrat, som ett prefix.
    assert.ok(current.startsWith(snapshots.at(-1)),
      'en tidigare rad ändrades — historik skrevs över');
    assert.ok(current.length > snapshots.at(-1).length, 'ingen ny rad lades till');
  }

  // Båda värdena för Strategy Score finns kvar i loggen, inte bara det sista.
  const scoreEvents = library.getHistory(strategyId, { types: [libraryModule.EVENT_TYPES.SCORE_UPDATED] });
  assert.deepEqual(scoreEvents.map((row) => row.value), [40, 70]);
  assert.equal(scoreEvents[1].previous, 40, 'det tidigare värdet sparades inte med ändringen');
  assert.equal(library.getStrategy(strategyId).strategyScore, 70);
});

test('10 · alla förändringar är spårbara kronologiskt', () => {
  const { library, recorder } = freshLibrary();
  library.syncFromRegistry();
  recorder.ingestExecutionHistory({ target: 'paper' });
  const strategyId = 'ema_pullback_continuation';
  library.recordTransition({ strategyId, to: lifecycle.STAGES.TESTING, reason: 'test' });
  library.recordApproval({ strategyId, decision: 'approved', approvedBy: 'människa' });
  retirement.applyRetirement(library, 'vwap_volume_breakout_long', { reason: 'stalled' });

  const trail = library.getAuditTrail();
  assert.ok(trail.length > 0);

  // Revisionsordningen är när biblioteket fick veta, och den är monoton.
  const recorded = trail.map((row) => Date.parse(row.recordedAt));
  assert.ok(recorded.every(Number.isFinite), 'en händelse saknar inskrivningstid');
  assert.deepEqual(recorded, [...recorded].sort((a, b) => a - b),
    'revisionsspåret är inte kronologiskt');

  // …och `at` bär när saken faktiskt inträffade, vilket kan ligga före.
  const paperEvent = trail.find((row) => row.type === libraryModule.EVENT_TYPES.PAPER_RECORDED);
  assert.ok(paperEvent, 'inga paper-händelser att pröva på');
  assert.ok(Date.parse(paperEvent.at) < Date.parse(paperEvent.recordedAt),
    'en inläst historisk affär ska bära sin egen tid, inte inläsningens');

  // Varje efterfrågad sorts förändring går att följa.
  const types = new Set(trail.map((row) => row.type));
  for (const required of [
    libraryModule.EVENT_TYPES.REGISTERED,
    libraryModule.EVENT_TYPES.LIFECYCLE_TRANSITION,
    libraryModule.EVENT_TYPES.PAPER_RECORDED,
    libraryModule.EVENT_TYPES.APPROVAL_RECORDED,
    libraryModule.EVENT_TYPES.RETIRED,
    libraryModule.EVENT_TYPES.DNA_UPDATED,
    libraryModule.EVENT_TYPES.SCORE_UPDATED,
  ]) {
    assert.ok(types.has(required), `ingen spårbarhet för ${required}`);
  }

  // Varje händelse bär strategi, tid och typ — annars går den inte att följa.
  for (const event of trail) {
    assert.ok(event.strategyId && event.type && event.at);
  }
});

// ── 11. Ingen separat strategilista ════════════════════════════════════════

test('11 · biblioteket uppfinner inga strategier — det speglar registret', () => {
  const source = fs.readFileSync(path.join(__dirname, 'strategyLibraryService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  // Ingen handskriven lista med strategi-id någonstans i biblioteket.
  assert.doesNotMatch(source, /native_futures_\w+_v\d/,
    'biblioteket har en egen lista med strategi-id');
  assert.match(source, /require\('\.\.\/strategyRegistryService'\)/,
    'biblioteket hämtar inte sin population ur registret');

  // Och recordern översätter identiteter via registret, inte via en egen tabell.
  const recorderSource = fs.readFileSync(path.join(__dirname, 'strategyLibraryRecorderService.js'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(recorderSource, /native_futures_\w+_v\d/,
    'recordern har en egen id-tabell');
  assert.match(recorderSource, /soleNativeStrategyForOrigin/,
    'recordern översätter legacy-id utan registret');
});

// ── ordningen är en enda källa ══════════════════════════════════════════════

test('livscykelns riktning härleds ur ordningen, inte ur en andra tabell', () => {
  const source = fs.readFileSync(path.join(__dirname, 'strategyLifecycle.js'), 'utf8');
  // Ingen handskriven övergångstabell som kan säga emot STAGE_ORDER.
  assert.doesNotMatch(source, /ALLOWED_TRANSITIONS\s*=/,
    'en andra tabell över tillåtna övergångar kan glida isär från ordningen');

  for (let i = 0; i < lifecycle.STAGE_ORDER.length; i += 1) {
    const stage = lifecycle.STAGE_ORDER[i];
    assert.equal(lifecycle.nextStage(stage), lifecycle.STAGE_ORDER[i + 1] || null);
    assert.equal(lifecycle.previousStage(stage), i === 0 ? null : lifecycle.STAGE_ORDER[i - 1]);
    // Retired går att nå från varje steg.
    assert.ok(lifecycle.validateTransition(stage, lifecycle.STAGES.RETIRED).ok);
    // Två steg framåt går aldrig.
    const twoAhead = lifecycle.STAGE_ORDER[i + 2];
    if (twoAhead) assert.equal(lifecycle.validateTransition(stage, twoAhead).ok, false);
  }
});
