'use strict';

// ── Acceptanstest: Market DNA och Market Intelligence ────────────────────────
//
// Körs mot riktig marknadsdata ur lagret. Det viktigaste testet är det om
// kornighet: att det FINA avtrycket skiljer dagar åt medan den GROVA
// regimnyckeln grupperar dem. Går den balansen förlorad blir Confidence Score
// meningslös — varje ny dag skulle räknas som en ny marknadsregim.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const marketDna = require('./marketDnaService');
const intelligence = require('./marketIntelligenceService');
const coverage = require('../../data/marketDataCoverage');
const historicalFeed = require('../historicalPriceFeedService');
const libraryModule = require('../library/strategyLibraryService');
const confidence = require('../score/confidenceScoreService');

const ROOTS = ['MNQ', 'MES'];
const feed = historicalFeed.createHistoricalPriceFeedService();

function dayCandles(root, date, { timeframe = '2m', limit = 250 } = {}) {
  return feed.getCandles(root, {
    now: new Date(`${date}T20:00:00.000Z`), timeframe, limit,
  }).candles || [];
}

const FULL_DAYS = coverage.listDates('MNQ')
  .filter((date) => coverage.coverageFor('MNQ', date).bars > 600)
  .sort();

let cachedCatalog = null;
function catalog() {
  if (!cachedCatalog) cachedCatalog = intelligence.buildMarketDnaCatalog({ roots: ROOTS, feed });
  return cachedCatalog;
}

test('lagret har handelsdagar att bygga DNA av', () => {
  assert.ok(FULL_DAYS.length >= 4, `för få hela dygn i lagret: ${FULL_DAYS.length}`);
});

// ── DNA räknas på riktig data ═══════════════════════════════════════════════

test('Market DNA beräknas ur samma candles som Native Engine ser', () => {
  const dna = marketDna.computeMarketDna(dayCandles('MNQ', FULL_DAYS.at(-1)), { symbol: 'MNQ' });
  assert.ok(dna.dnaHash, 'inget avtryck beräknades');
  assert.ok(dna.traits, 'inga egenskaper');
  assert.equal(Object.keys(dna.traits).length, 7);
  for (const [key, value] of Object.entries(dna.traits)) {
    assert.ok(typeof value === 'string' && value.length > 0, `egenskapen ${key} saknar band`);
    assert.notEqual(value, 'unknown', `egenskapen ${key} kunde inte bestämmas på riktig data`);
  }
  assert.match(dna.regimeKey, /^(up|down|flat)\/(quiet|normal|volatile)$/);
});

test('för lite data ger ett ärligt okänt DNA, inte ett gissat', () => {
  const dna = marketDna.computeMarketDna(dayCandles('MNQ', FULL_DAYS.at(-1)).slice(0, 5), { symbol: 'MNQ' });
  assert.equal(dna.dnaHash, null);
  assert.equal(dna.regimeKey, 'unknown');
  assert.equal(dna.reason, 'too_few_candles');
});

test('Market DNA är deterministiskt', () => {
  const candles = dayCandles('MNQ', FULL_DAYS.at(-1));
  const a = marketDna.computeMarketDna(candles, { symbol: 'MNQ' });
  const b = marketDna.computeMarketDna(candles, { symbol: 'MNQ' });
  assert.equal(a.dnaHash, b.dnaHash);
  assert.deepEqual(a.traits, b.traits);
});

// ── kornigheten: det centrala testet ════════════════════════════════════════

test('det fina avtrycket skiljer dagar åt — den grova regimen grupperar dem', () => {
  const summary = catalog().summary;
  assert.ok(summary.periods >= 8, `för få perioder att pröva på: ${summary.periods}`);

  // Vore avtrycket för grovt skulle alla dagar se likadana ut.
  assert.ok(summary.distinctProfiles > summary.distinctRegimes,
    'det fina avtrycket skiljer inte fler dagar åt än den grova regimen — då tillför det inget');

  // Vore den grova nyckeln lika fin som avtrycket skulle varje dag bli en egen
  // regim, och "hur många regimer har vi sett" bli detsamma som "hur många
  // dagar har vi kört".
  assert.ok(summary.distinctRegimes < summary.periods,
    'varje period blev sin egen regim — då mäter regimnyckeln bara antalet körningar');

  // Rimlighetsband: den grova nyckeln har högst nio möjliga värden.
  assert.ok(summary.distinctRegimes <= 9);
  console.log(`    (${summary.periods} perioder · ${summary.distinctProfiles} fina profiler`
    + ` · ${summary.distinctRegimes} grova regimer)`);
});

test('två perioder med samma karaktär får samma avtryck', () => {
  const byHash = new Map();
  for (const period of catalog().periods) {
    if (!byHash.has(period.dnaHash)) byHash.set(period.dnaHash, []);
    byHash.get(period.dnaHash).push(period);
  }
  const shared = [...byHash.values()].filter((rows) => rows.length > 1);
  assert.ok(shared.length > 0,
    'ingen enda period delade avtryck med någon annan — avtrycket är för fint för att gruppera');

  // Delar de avtryck ska varje egenskap stämma överens. Annars är hashen inte
  // en funktion av egenskaperna.
  for (const rows of shared) {
    for (const row of rows.slice(1)) {
      assert.deepEqual(row.traits, rows[0].traits);
      assert.equal(marketDna.dnaSimilarity(rows[0], row), 1);
    }
  }
});

test('likhet är 1 mot sig själv och lägre mot en annan karaktär', () => {
  const periods = catalog().periods;
  const first = periods[0];
  assert.equal(marketDna.dnaSimilarity(first, first), 1);

  const different = periods.find((row) => row.dnaHash !== first.dnaHash);
  assert.ok(different, 'alla perioder hade samma avtryck');
  const similarity = marketDna.dnaSimilarity(first, different);
  assert.ok(similarity < 1 && similarity >= 0, `orimlig likhet: ${similarity}`);
});

test('en mängd profiler ger samma sammanslagna hash oavsett ordning', () => {
  const a = marketDna.combineMarketDnaHashes(['aaa', 'bbb', 'ccc']);
  const b = marketDna.combineMarketDnaHashes(['ccc', 'aaa', 'bbb']);
  const withDuplicates = marketDna.combineMarketDnaHashes(['aaa', 'bbb', 'ccc', 'aaa']);
  assert.equal(a, b, 'ordningen påverkade avtrycket');
  assert.equal(a, withDuplicates, 'en upprepad profil ändrade avtrycket');
  assert.notEqual(a, marketDna.combineMarketDnaHashes(['aaa', 'bbb']));
  assert.equal(marketDna.combineMarketDnaHashes([]), null);
});

// ── katalogen ═══════════════════════════════════════════════════════════════

test('katalogen byggs ur datalagret, inte ur körningarna', () => {
  const result = catalog();
  assert.ok(result.periods.length >= 8);
  // Halva dagar hoppas över och RÄKNAS — de är inte marknadsregimer.
  assert.ok(result.skipped.every((row) => row.reason === 'insufficient_bars' || row.reason === 'too_few_candles'));
  for (const period of result.periods) {
    assert.ok(ROOTS.includes(period.symbol));
    assert.ok(period.from && period.to);
    assert.ok(period.dnaHash);
  }

  // Källkodsregel: katalogen får inte härledas ur biblioteket. Frågan "vilka
  // regimer finns" ska inte besvaras av "vilka vi råkade köra".
  const source = fs.readFileSync(path.join(__dirname, 'marketIntelligenceService.js'), 'utf8');
  const buildFn = source.slice(
    source.indexOf('function buildMarketDnaCatalog'),
    source.indexOf('function testedProfilesFor'),
  );
  assert.doesNotMatch(buildFn, /library/i, 'katalogen läser biblioteket i stället för lagret');
});

// ── Market Intelligence ═════════════════════════════════════════════════════

test('Market Intelligence hittar blinda fläckar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-intel-'));
  const library = libraryModule.createStrategyLibrary({ eventsFile: path.join(dir, 'events.jsonl') });
  library.syncFromRegistry();

  const regimes = Object.keys(catalog().summary.regimeCounts);
  assert.ok(regimes.length >= 3, 'för få regimer i lagret för att pröva blinda fläckar');

  // En strategi som bara körts i EN regim.
  const tested = 'native_futures_momentum_v1';
  library.recordReplayRun({
    strategyId: tested, runId: 'r1', trades: 30, winRate: 55, strategyPnlUsd: 200,
    strategyScore: 60, marketRegimeKey: regimes[0], marketDnaHash: 'hash-a',
  });

  const report = intelligence.buildMarketIntelligence({ library, catalog: catalog() });
  const row = report.strategies.find((entry) => entry.strategyId === tested);

  assert.deepEqual(row.regimesTested, [regimes[0]]);
  assert.equal(row.regimesAvailable, regimes.length);
  assert.ok(row.blindSpots.length === regimes.length - 1,
    'de otestade regimerna redovisas inte som blinda fläckar');
  assert.ok(!row.blindSpots.includes(regimes[0]), 'en testad regim listades som blind fläck');
  assert.ok(row.regimeCoveragePct > 0 && row.regimeCoveragePct < 100);

  // En strategi som aldrig körts är blind för allt.
  const untouched = report.strategies.find((entry) => entry.strategyId !== tested);
  assert.deepEqual(untouched.regimesTested, []);
  assert.equal(untouched.blindSpots.length, regimes.length);
  assert.equal(untouched.regimeCoveragePct, 0);

  // Systemets gemensamma blinda fläck: regimer ingen strategi har sett.
  assert.ok(report.market.untestedByAnyone.length === regimes.length - 1);
  assert.ok(!report.market.untestedByAnyone.includes(regimes[0]));

  console.log(`    (${regimes.length} regimer i lagret · ${row.blindSpots.length} blinda fläckar`
    + ` för ${tested} · ${report.market.untestedByAnyone.length} otestade av någon)`);
});

test('en körning över flera regimer räknas som flera sedda — men bevisar ingen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-intel-'));
  const library = libraryModule.createStrategyLibrary({ eventsFile: path.join(dir, 'events.jsonl') });
  library.syncFromRegistry();
  const strategyId = 'native_futures_momentum_v1';
  const regimes = Object.keys(catalog().summary.regimeCounts);
  const [a, b] = regimes;

  // MNQ och MES hade olika karaktär samma dag. Körningen såg BÅDA.
  library.recordReplayRun({
    strategyId, runId: 'mixed', trades: 50, winRate: 60, strategyPnlUsd: 900,
    marketRegimeKeys: [a, b], marketDnaHash: 'hash-mixed',
  });

  const report = intelligence.buildMarketIntelligence({ library, catalog: catalog() });
  const row = report.strategies.find((entry) => entry.strategyId === strategyId);

  // Båda regimerna räknas som SEDDA…
  assert.deepEqual(row.regimesTested.sort(), [a, b].sort());
  assert.ok(!row.blindSpots.includes(a) && !row.blindSpots.includes(b),
    'en sedd regim listades som blind fläck');

  // …men resultatet tillskrivs INGEN av dem. Det går inte att fördela.
  assert.deepEqual(row.performanceByRegime, [],
    'en tvetydig körning användes som evidens för en enskild regim');
  assert.equal(row.mixedRegimeRuns, 1);
  assert.equal(row.mixedRegimeTrades, 50);
  assert.deepEqual(row.conclusiveRegimes, []);

  // Och ingen påhittad sammansatt nyckel får finnas — den skulle aldrig kunna
  // matcha katalogen.
  for (const key of row.regimesTested) {
    assert.ok(!key.includes('+'), `sammansatt regimnyckel läckte igenom: ${key}`);
    assert.ok(Object.keys(catalog().summary.regimeCounts).includes(key),
      `regimen ${key} finns inte i katalogen`);
  }
});

test('gammal historik med sammansatt regimnyckel tolkas rätt utan att skrivas om', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-intel-'));
  const library = libraryModule.createStrategyLibrary({ eventsFile: path.join(dir, 'events.jsonl') });
  library.syncFromRegistry();
  const strategyId = 'native_futures_momentum_v1';
  const regimes = Object.keys(catalog().summary.regimeCounts);
  const [a, b] = regimes;

  // Så såg raderna ut innan mängden lagrades som mängd. Loggen är append-only,
  // så de finns kvar — läsaren måste klara dem.
  library.recordReplayRun({
    strategyId, runId: 'legacy', trades: 30, winRate: 50, strategyPnlUsd: 100,
    marketRegimeKey: `${a}+${b}`,
  });

  const report = intelligence.buildMarketIntelligence({ library, catalog: catalog() });
  const row = report.strategies.find((entry) => entry.strategyId === strategyId);

  assert.deepEqual(row.regimesTested.sort(), [a, b].sort(),
    'den sammansatta nyckeln delades inte upp i sina delar');
  assert.equal(row.mixedRegimeRuns, 1, 'körningen räknades som entydig');
  assert.deepEqual(row.performanceByRegime, [],
    'en sammansatt nyckel användes som evidens för en enskild regim');
  for (const entry of row.performanceByRegime) {
    assert.ok(!entry.regimeKey.includes('+'));
  }
});

test('resultat per regim säger ifrån när underlaget är för tunt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-intel-'));
  const library = libraryModule.createStrategyLibrary({ eventsFile: path.join(dir, 'events.jsonl') });
  library.syncFromRegistry();
  const strategyId = 'native_futures_momentum_v1';

  library.recordReplayRun({ strategyId, runId: "a", trades: 40, winRate: 60, strategyPnlUsd: 400, marketRegimeKeys: ["up/normal"] });
  library.recordReplayRun({ strategyId, runId: "b", trades: 3, winRate: 33, strategyPnlUsd: -50, marketRegimeKeys: ["down/quiet"] });

  const report = intelligence.buildMarketIntelligence({ library, catalog: catalog() });
  const row = report.strategies.find((entry) => entry.strategyId === strategyId);
  const byRegime = new Map(row.performanceByRegime.map((entry) => [entry.regimeKey, entry]));

  assert.equal(byRegime.get('up/normal').conclusive, true);
  assert.equal(byRegime.get('down/quiet').conclusive, false,
    'tre affärer räckte som slutsats om en marknadsregim');
  assert.deepEqual(row.conclusiveRegimes, ['up/normal']);
});

test('liknande perioder går att hitta', () => {
  const target = catalog().periods[0];
  const similar = intelligence.findSimilarPeriods(target, catalog(), { limit: 5, minSimilarity: 0.5 });
  assert.ok(similar.length > 0, 'ingen period liknade ens sig själv');
  assert.equal(similar[0].similarity, 1, 'den mest lika perioden ska vara identisk');
  // Sorterad fallande.
  const scores = similar.map((row) => row.similarity);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

// ── kopplingen till Confidence ══════════════════════════════════════════════

test('Confidence räknar grova regimer, inte fina profiler', () => {
  // Samma affärer, samma dagar. Enda skillnaden är vad som skickas in som
  // "regimer". Skickas det fina avtrycket in blir varje period en egen regim
  // och måttet maxar på upplösning i stället för på kunskap.
  const trades = Array.from({ length: 40 }, (_, i) => ({
    strategyPnlUsd: i % 3 === 0 ? -80 : 120,
    closedAt: `2026-08-${String(10 + (i % 5)).padStart(2, '0')}T15:00:00.000Z`,
  }));

  const fine = catalog().periods.map((row) => row.dnaHash);
  const coarse = catalog().periods.map((row) => row.regimeKey);
  assert.ok(new Set(fine).size > new Set(coarse).size, 'testets förutsättning håller inte');

  const withFine = confidence.calculateConfidenceScore(trades, { marketClassifications: fine });
  const withCoarse = confidence.calculateConfidenceScore(trades, { marketClassifications: coarse });

  assert.equal(withFine.components.regimes, confidence.CONFIDENCE_MAX.regimes,
    'det fina avtrycket maxar regimkomponenten — precis den fällan valet undviker');
  assert.ok(withCoarse.components.regimes <= withFine.components.regimes);
  assert.ok(withCoarse.evidence.regimes < withFine.evidence.regimes);

  // Och recordern ska faktiskt skicka in den grova nyckeln.
  const recorderSource = fs.readFileSync(
    path.join(__dirname, '..', 'library', 'strategyLibraryRecorderService.js'), 'utf8',
  );
  assert.match(recorderSource, /marketClassifications:[\s\S]{0,200}marketRegimeKey/,
    'recordern skickar inte den grova regimnyckeln till Confidence');
});

// ── Market DNA hör hemma i marknadslagret ═══════════════════════════════════

test('biblioteket beräknar inte marknads-DNA, det lagrar det', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'library', 'strategyLibraryService.js'), 'utf8',
  ).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  assert.doesNotMatch(source, /function computeMarketDnaHash/,
    'biblioteket räknar fortfarande ut marknads-DNA — det är marknadslagrets uppgift');
  assert.doesNotMatch(source, /require\('\.\.\/market\//,
    'biblioteket importerar marknadslagret; det ska bara ta emot en hash');
});

test('replay-rapporten bär Market DNA vid sidan av klassificeringen', () => {
  const reportSource = fs.readFileSync(
    path.join(__dirname, '..', 'replay', 'replayReportService.js'), 'utf8',
  );
  assert.match(reportSource, /marketDna:\s*\{/, 'rapporten saknar marketDna');
  assert.match(reportSource, /combinedHash/);
  assert.match(reportSource, /regimeKeys/);
  // Klassificeringen finns kvar — DNA ersätter den inte, den kompletterar.
  assert.match(reportSource, /marketClassification: classification/);
});
