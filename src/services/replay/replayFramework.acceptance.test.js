'use strict';

// ── Acceptanstest: Replay Framework, tre exekveringslägen ────────────────────
//
// Production Replay  ska vara identisk med Paper Trading
// Strategy Replay    ska isolera strategier — AI:s träningsmiljö
// Portfolio Replay   ska simulera godkända strategier i samma kapital
//
// Det viktigaste testet är det första och det sista: att Production INTE
// ändrades av att lägena tillkom, och att lägena inte är tre motorer.
//
// Körs mot riktig data ur marknadsdatalagret, mot driftmodulerna.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const coverage = require('../../data/marketDataCoverage');
const engineModule = require('./nativeReplayEngineService');
const reportModule = require('./replayReportService');
const allocatorModule = require('./replayBookAllocator');
const strategyScore = require('../score/strategyScoreV1Service');
const tradeLedger = require('../trade/tradeLedgerService');

const { REPLAY_MODES } = allocatorModule;
const ROOTS = ['MNQ', 'MES'];
const DAY = coverage.findCompleteDay({ roots: ROOTS, throughUtcTime: '18:00' });
const WINDOW = DAY ? { from: `${DAY}T13:00:00.000Z`, to: `${DAY}T17:00:00.000Z` } : null;

const runs = new Map();
function runMode(mode, extra = {}) {
  const key = `${mode}|${JSON.stringify(extra)}`;
  if (!runs.has(key)) {
    runs.set(key, engineModule.createNativeReplayEngine().run({ ...WINDOW, mode, ...extra }));
  }
  return runs.get(key);
}

// Största antal positioner som var öppna samtidigt, räknat ur affärernas
// tidsintervall. Mäter utfallet, inte det motorn påstår.
function peakConcurrency(trades) {
  const events = [];
  for (const row of trades) {
    const open = new Date(row.openedAt).getTime();
    const close = row.closedAt ? new Date(row.closedAt).getTime() : Infinity;
    if (!Number.isFinite(open)) continue;
    events.push([open, 1], [close, -1]);
  }
  // Stängning före öppning vid samma tidpunkt: en frigjord plats får återanvändas.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}

test('lagret har en komplett handelsdag att köra på', () => {
  assert.ok(DAY, 'ingen komplett IB-dag i lagret');
});

// ── Production Replay ═══════════════════════════════════════════════════════

test('Production Replay är oförändrad av att lägena tillkom', () => {
  if (!DAY) return;
  // Utan mode-parameter ska motorn bete sig exakt som innan ramverket fanns.
  const implicit = engineModule.createNativeReplayEngine().run({ ...WINDOW });
  const explicit = runMode(REPLAY_MODES.PRODUCTION);

  assert.equal(implicit.config.mode, REPLAY_MODES.PRODUCTION,
    'production måste vara standardläget — annars ändrade ramverket befintligt beteende');
  assert.deepEqual(implicit.counts, explicit.counts);
  assert.deepEqual(implicit.trades, explicit.trades);
});

test('Production Replay har exakt en bok och ett positionstak', () => {
  if (!DAY) return;
  const run = runMode(REPLAY_MODES.PRODUCTION);
  assert.equal(run.counts.books, 1, 'production ska ha en enda bok, som paper');
  assert.equal(run.books[0].bookId, allocatorModule.PRODUCTION_BOOK);

  // Taket sköts av Broker Risk, inte av allokeringen.
  assert.equal(run.counts.allocationBlocked, 0,
    'production får aldrig blockera på allokering — det vore en grind paper inte har');
  assert.ok(run.counts.riskBlocked > 0, 'Broker Risk stoppade ingenting — då prövades den inte');
  assert.equal(peakConcurrency(run.trades), 1,
    'production överskred paper-taket på en samtidig position');
});

// ── Strategy Replay ═════════════════════════════════════════════════════════

test('Strategy Replay isolerar strategierna från varandra', () => {
  if (!DAY) return;
  const production = runMode(REPLAY_MODES.PRODUCTION);
  const strategy = runMode(REPLAY_MODES.STRATEGY);

  // Samma signalflöde — isoleringen får inte ändra vad strategierna säger.
  assert.equal(strategy.counts.signalsGenerated, production.counts.signalsGenerated,
    'lägesbytet ändrade signalerna, vilket det aldrig får göra');

  // En bok per strategi som faktiskt handlade.
  assert.ok(strategy.counts.books > 1, 'strategy-läget gav inte isolerade böcker');
  for (const book of strategy.books) {
    const strategies = new Set(book.trades.map((row) => row.strategyId));
    assert.equal(strategies.size, 1,
      `boken ${book.bookId} innehåller flera strategier — då är de inte isolerade`);
    assert.equal([...strategies][0], book.bookId, 'boken är inte nycklad på sin strategi');
  }

  // Isoleringen ska SLÄPPA FRAM mer, aldrig mindre.
  assert.ok(strategy.counts.trades >= production.counts.trades,
    'isolering gav färre affärer än den delade kön — då mäter den fel sak');

  // Ingen strategi blockeras längre av en ANNAN strategis position: varje
  // kvarvarande positionsblock måste komma från strategins egen bok.
  const byStrategy = new Map();
  for (const row of strategy.trades) {
    if (!byStrategy.has(row.strategyId)) byStrategy.set(row.strategyId, []);
    byStrategy.get(row.strategyId).push(row);
  }
  for (const [strategyId, rows] of byStrategy) {
    assert.equal(peakConcurrency(rows), 1,
      `${strategyId} hade flera positioner samtidigt i sin egen bok`);
  }
});

test('Strategy Replay ger AI ett underlag per strategi', () => {
  if (!DAY) return;
  const report = reportModule.buildReplayReport(runMode(REPLAY_MODES.STRATEGY));
  assert.equal(report.mode, REPLAY_MODES.STRATEGY);
  assert.ok(report.modeReport.strategies.length > 0);

  for (const row of report.modeReport.strategies) {
    assert.ok(row.strategyId, 'rad utan strategi');
    assert.equal(typeof row.signals, 'number');
    assert.equal(typeof row.trades, 'number');
    assert.equal(typeof row.strategyScore, 'number');
    assert.ok('confidence' in row && 'qualified' in row);
  }
  console.log(`    (strategier i träningsunderlaget: ${report.modeReport.strategies.length}`
    + ` · kvalificerade: ${report.modeReport.strategies.filter((r) => r.qualified).length})`);
});

// ── Portfolio Replay ════════════════════════════════════════════════════════

test('Portfolio Replay håller taket för samtidiga positioner', () => {
  if (!DAY) return;
  for (const cap of [1, 2, 3]) {
    const run = runMode(REPLAY_MODES.PORTFOLIO, { maxConcurrentPositions: cap });
    assert.equal(run.config.allocation.maxConcurrentPositions, cap);
    assert.ok(peakConcurrency(run.trades) <= cap,
      `portföljen hade ${peakConcurrency(run.trades)} samtidiga positioner med taket ${cap}`);
  }

  // Ett hårdare tak får aldrig ge FLER affärer.
  const tight = runMode(REPLAY_MODES.PORTFOLIO, { maxConcurrentPositions: 1 });
  const loose = runMode(REPLAY_MODES.PORTFOLIO, { maxConcurrentPositions: 3 });
  assert.ok(tight.counts.trades <= loose.counts.trades);
  assert.ok(tight.counts.allocationBlocked >= loose.counts.allocationBlocked,
    'ett hårdare tak ska tränga ut fler signaler, inte färre');
});

test('Portfolio Replay släpper bara in godkända strategier', () => {
  if (!DAY) return;
  const all = runMode(REPLAY_MODES.PORTFOLIO, { maxConcurrentPositions: 3 });
  const traded = [...new Set(all.trades.map((row) => row.strategyId))];
  assert.ok(traded.length > 1, 'för få strategier för att pröva godkännandet');

  const approved = [traded[0]];
  const gated = runMode(REPLAY_MODES.PORTFOLIO, {
    maxConcurrentPositions: 3, approvedStrategies: approved,
  });

  const gatedStrategies = [...new Set(gated.trades.map((row) => row.strategyId))];
  assert.deepEqual(gatedStrategies, approved,
    'en icke godkänd strategi handlade i portföljen');
  assert.ok(
    gated.riskBlocks.some((row) => row.blockers.includes(allocatorModule.ALLOCATION_BLOCKS.NOT_APPROVED)),
    'avvisade strategier redovisas inte',
  );
});

test('Portfolio Replay delar kapital — Strategy Replay gör det inte', () => {
  if (!DAY) return;
  const portfolio = engineModule.createNativeReplayEngine().run({
    ...WINDOW, mode: REPLAY_MODES.PORTFOLIO, maxConcurrentPositions: 3,
  });
  const strategy = runMode(REPLAY_MODES.STRATEGY);
  assert.equal(portfolio.config.allocation.sharedCapital, true);
  assert.equal(strategy.config.allocation.sharedCapital, false);

  // Direkt på allokatorn: samma affärer, olika svar på "vilket resultat mäts
  // dagsförlustgränsen mot".
  // Priser i MNQ:s egen storleksordning. Ett exitpris på 0 ger null-PnL i
  // ledgern, och då hade testet mätt frånvaron av data i stället för delat
  // kapital.
  const ENTRY = 20000;
  function seed(mode) {
    const alloc = allocatorModule.createBookAllocator({ mode, maxConcurrentPositions: 5 });
    for (const strategyId of ['a', 'b']) {
      const slot = alloc.acquire({ signalId: `s:${strategyId}`, strategyId });
      const trade = slot.ledger.open({
        signalId: `s:${strategyId}`, strategyId, symbol: 'MNQ', direction: 'LONG', contracts: 1,
        entry: { expectedPrice: ENTRY, executedPrice: ENTRY, timestamp: '2026-08-14T13:00:00.000Z' },
        openedAt: '2026-08-14T13:00:00.000Z',
      });
      // 50 punkter ner: en riktig förlust, lika stor i båda böckerna.
      slot.ledger.close(trade.tradeId, {
        exit: { expectedPrice: ENTRY - 50, executedPrice: ENTRY - 50, timestamp: '2026-08-14T13:10:00.000Z' },
        reason: 'stop_loss',
      });
    }
    return alloc;
  }
  const isolated = seed(REPLAY_MODES.STRATEGY);
  const shared = seed(REPLAY_MODES.PORTFOLIO);
  assert.ok(isolated.realizedPnlFor('a') < 0, 'fixturen gav ingen förlust att mäta');
  assert.equal(isolated.realizedPnlFor('a'), isolated.realizedPnlFor('b'),
    'de två isolerade böckerna gjorde samma förlust');
  assert.ok(shared.realizedPnlFor('a') < isolated.realizedPnlFor('a'),
    'i portföljen ska strategi a också bära b:s förlust — det är vad delat kapital betyder');
  assert.equal(shared.realizedPnlFor('a'), shared.realizedPnlFor('b'),
    'delat kapital ska ge samma svar oavsett vem som frågar');
});

test('Portfolio Replay rangordnar inför Paper', () => {
  if (!DAY) return;
  const report = reportModule.buildReplayReport(
    runMode(REPLAY_MODES.PORTFOLIO, { maxConcurrentPositions: 3 }),
  );
  assert.equal(report.mode, REPLAY_MODES.PORTFOLIO);
  const { ranking, readyForPaper, crowding } = report.modeReport;
  assert.ok(ranking.length > 0);

  // Ogrundade rader hamnar sist, aldrig överst.
  const firstUnqualified = ranking.findIndex((row) => !row.qualified);
  if (firstUnqualified !== -1) {
    assert.ok(ranking.slice(firstUnqualified).every((row) => !row.qualified),
      'en kvalificerad strategi rankades under en ogrundad');
  }
  // Ingen rekommendation kan komma ur ett underlag som inte håller.
  for (const strategyId of readyForPaper) {
    const row = ranking.find((r) => r.strategyId === strategyId);
    assert.equal(row.qualified, true, `${strategyId} rekommenderades utan tillräckligt underlag`);
    assert.ok(row.netPnlUsd > 0, `${strategyId} rekommenderades trots förlust`);
  }
  assert.equal(typeof crowding.blockedByConcurrency, 'number');

  // Andelarna ska ta ut varandra.
  const shares = ranking.map((row) => row.shareOfActivityPct).filter((v) => v != null);
  if (shares.length) {
    const sumAbs = shares.reduce((total, value) => total + Math.abs(value), 0);
    assert.ok(Math.abs(sumAbs - 100) < 0.5,
      `andelarna av portföljens rörelse summerar till ${sumAbs}, inte 100`);
  }
});

// ── Strategy Score får inte krönas av ett sammanträffande ═══════════════════

test('en enda vinnande affär kan aldrig ge bandet strong', () => {
  const luck = strategyScore.scoreTrades(
    [{ strategyPnlUsd: 500, status: 'closed' }],
    { strategyId: 'lucky' },
  );
  assert.ok(luck.total > 70, 'poängen får gärna vara hög — det är bandet som ska hålla emot');
  assert.equal(luck.band, 'insufficient_data');
  assert.equal(luck.qualified, false);
  assert.equal(luck.reason, 'below_min_trades_for_ranking');

  // Med tillräckligt underlag får samma kvalitet ett riktigt omdöme.
  const solid = strategyScore.scoreTrades(
    Array.from({ length: strategyScore.MIN_TRADES_FOR_RANKING }, (_, i) => ({
      status: 'closed', strategyPnlUsd: i % 4 === 0 ? -100 : 200,
    })),
    { strategyId: 'solid' },
  );
  assert.equal(solid.qualified, true);
  assert.notEqual(solid.band, 'insufficient_data');
});

// ── lägena är inte tre motorer ══════════════════════════════════════════════

test('lägena är en seam, inte tre kodvägar', () => {
  const engineSource = fs.readFileSync(path.join(__dirname, 'nativeReplayEngineService.js'), 'utf8');
  const code = engineSource.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  // Motorns loop får inte förgrena sig på läget. Kör den if/switch på mode har
  // vi tre system igen, bara i samma fil.
  assert.doesNotMatch(code, /mode\s*===\s*['"]/, 'replay-motorn jämför mot ett lägesnamn');
  assert.doesNotMatch(code, /switch\s*\(\s*\w*[Mm]ode/, 'replay-motorn förgrenar på läge');
  for (const mode of Object.values(REPLAY_MODES)) {
    assert.doesNotMatch(code, new RegExp(`['"]${mode}['"]`),
      `replay-motorn nämner läget ${mode} vid namn`);
  }

  // Allokatorn får i sin tur inte handla, fylla eller räkna pengar.
  const allocSource = fs.readFileSync(path.join(__dirname, 'replayBookAllocator.js'), 'utf8');
  assert.doesNotMatch(allocSource, /fillEngine|evaluateBrokerRisk|calculatePnl/,
    'allokatorn har tagit över ansvar som hör hemma i kedjan');
  assert.doesNotMatch(allocSource, /Math\.random\(|Date\.now\(/,
    'allokatorn gör körningen oreproducerbar');

  // Pengamatten ägs fortfarande av ett ställe.
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'trade', 'tradeLedgerService.js'), 'utf8'),
    /require\('\.\.\/futuresPaperLedgerService'\)/,
  );
});

test('varje läge är deterministiskt', () => {
  if (!DAY) return;
  for (const mode of Object.values(REPLAY_MODES)) {
    const a = engineModule.createNativeReplayEngine().run({ ...WINDOW, mode, maxConcurrentPositions: 2 });
    const b = engineModule.createNativeReplayEngine().run({ ...WINDOW, mode, maxConcurrentPositions: 2 });
    assert.deepEqual(a.counts, b.counts, `${mode} är inte deterministiskt`);
    assert.deepEqual(a.trades, b.trades, `${mode} gav olika affärer mellan körningar`);
  }
});

test('ett okänt läge avvisas i stället för att tolkas', () => {
  assert.throws(
    () => allocatorModule.createBookAllocator({ mode: 'aggressive' }),
    /replay_unknown_mode:aggressive/,
  );
});

test('den sammanslagna sammanfattningen räknas av ledgerns egen matematik', () => {
  // summarizeTrades är samma funktion som en enskild bok använder — annars
  // hade portföljens totalsiffror kunnat avvika från bokens.
  const rows = [
    { status: 'closed', strategyPnlUsd: 100, executedPnlUsd: 90, netPnlUsd: 88, commissionUsd: 2, executionCostUsd: 10 },
    { status: 'closed', strategyPnlUsd: -50, executedPnlUsd: -60, netPnlUsd: -62, commissionUsd: 2, executionCostUsd: 10 },
  ];
  const summary = tradeLedger.summarizeTrades(rows);
  assert.equal(summary.trades, 2);
  assert.equal(summary.wins, 1);
  assert.equal(summary.strategyPnlUsd, 50);
  assert.equal(summary.winRate, 50);
});
