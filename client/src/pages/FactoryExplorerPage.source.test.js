import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiFactoryExplorer } from '../services/uiTerminologyService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(here, 'FactoryExplorerPage.jsx'), 'utf8');
const replaySource = fs.readFileSync(path.join(here, 'FactoryReplayExplorerPage.jsx'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');

test('factory explorer pages reuse existing dashboard components and shared navigation', () => {
  for (const component of [
    'DashboardShell',
    'OverviewPanel',
    'FieldGrid',
    'MetricCard',
    'StatusBadge',
  ]) {
    assert.match(source, new RegExp(component), `${component} används inte`);
  }

  assert.match(replaySource, /FactoryExplorerPage/, 'replayutforskaren återanvänder inte fabriksutforskaren');
  assert.match(replaySource, /mode="replay"/, 'replayutforskaren saknar läsläge för historiska tester');
});

test('factory explorer reads existing API data without mutations', () => {
  const requiredEndpoints = [
    '/api/strategy-library',
    '/api/strategy-library/audit?limit=5000',
    '/api/strategy-family-tree',
    '/api/ai-memory/experiments?limit=2000',
    '/api/strategy-brain',
    '/api/market-intelligence',
    '/api/market-intelligence/catalog',
    '/api/replay/queue',
    '/api/learning/latest-summary',
  ];

  for (const endpoint of requiredEndpoints) {
    assert.match(source, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${endpoint} används inte`);
  }

  assert.equal(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test(source), false, 'utforskaren gör muterande HTTP-anrop');
  assert.equal(/fetch\([^)]*\/api\/[^)]*,\s*\{[^}]*method:/s.test(source), false, 'fetch använder explicit metod');
  assert.match(source, /Promise\.all/, 'utforskaren hämtar inte källor samlat');
  assert.match(source, /catch\s*\(err\)/, 'utforskaren fångar inte endpointfel');
  assert.match(source, /emptyResource/, 'utforskaren saknar fallback för tom källa');
});

test('factory explorer rows are clickable and support empty data', () => {
  assert.match(source, /onClick=\{\(\) => onSelect\(row\.id\)\}/, 'utforskarrader är inte klickbara');
  assert.match(source, /selectedId/, 'valt objekt saknas');
  assert.match(source, /copy\.states\.empty/, 'tom data visas inte med central text');
  assert.match(source, /copy\.states\.noSelection/, 'saknat val visas inte med central text');
  assert.match(source, /function buildReplayRows/, 'läsrader för historiska tester saknas');
  assert.match(source, /strategy\.replayHistory/, 'historiska tester läses inte från strategibiblioteket');
  assert.match(source, /queue\.jobs/, 'väntande tester läses inte från testkön');
  assert.equal(/placeholder|mock|dummy|sample data/i.test(source), false, 'utforskaren innehåller placeholderkod');
});

test('strategy library renders the Meridian product library surface', () => {
  const copy = uiFactoryExplorer().libraryProduct;
  for (const text of [
    'Strategiöversikt',
    'Strategier som behöver uppmärksamhet',
    'Alla strategier',
    'Vad strategin gör',
    'Hur den har utvecklats',
    'Historiska tester',
    'Marknadstyper',
    'Senaste resultat',
    'Nästa steg',
    'Lärdomar',
    'Idé',
    'Test',
    'Paper Trading',
    'Live Trading',
    'Pensionerad',
  ]) {
    assert.match(JSON.stringify(copy), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${text} saknas i biblioteksterminologin`);
  }

  for (const marker of [
    'data-strategy-library-product',
    'data-strategy-library-overview',
    'data-strategy-library-attention',
    'data-strategy-library-cards',
    'data-strategy-library-card',
    'data-strategy-library-detail',
    'data-strategy-library-lifecycle',
  ]) {
    assert.match(source, new RegExp(marker), `${marker} saknas`);
  }

  assert.match(source, /if \(mode === 'library'\)/, 'strategibiblioteket saknar egen produktvy');
  assert.match(source, /DashboardShell title=\{model\.copy\.libraryProduct\.title\}/, 'strategibiblioteket använder inte produktcopy i sidhuvudet');
  assert.match(source, /PRODUCT_STAGE_ORDER = Object\.freeze\(\['idea', 'test', 'paper', 'live', 'retired'\]\)/, 'livscykeln är inte förenklad till produktsteg');
  assert.match(source, /model\.attentionRows/, 'uppmärksamhetslistan saknas');
  assert.match(source, /slice\(0, 3\)/, 'uppmärksamhetslistan visar inte högst tre strategier');
});

test('historical tests render the Meridian product test history surface', () => {
  const copy = uiFactoryExplorer().historicalTestsProduct;
  for (const text of [
    'Historiska tester',
    'Pågår',
    'Väntar',
    'Klara',
    'Misslyckade',
    'Senaste tester',
    'Pågående tester',
    'Testdetaljer',
    'Strategi',
    'Marknadstyp',
    'När testet kördes',
    'Resultat',
    'Lärdom',
    'Nästa steg',
    'Vad testades',
    'Varför testades det',
    'Inga historiska tester har körts ännu.',
    'Inga tester pågår just nu.',
  ]) {
    assert.match(JSON.stringify(copy), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${text} saknas i testhistorikens terminologi`);
  }

  for (const marker of [
    'data-historical-tests-product',
    'data-historical-tests-overview',
    'data-historical-tests-latest',
    'data-historical-tests-active',
    'data-historical-test-card',
    'data-historical-test-details',
  ]) {
    assert.match(source, new RegExp(marker), `${marker} saknas`);
  }

  assert.match(source, /if \(mode === 'replay'\)/, 'historiska tester saknar egen produktvy');
  assert.match(source, /DashboardShell title=\{model\.copy\.historicalTestsProduct\.title\}/, 'historiska tester använder inte produktcopy i sidhuvudet');
  assert.match(source, /historicalTestCounts/, 'statuskort för historiska tester saknas');
  assert.match(source, /activeTestRows/, 'pågående tester saknas i modellen');
  assert.match(source, /latestTestRows/, 'senaste tester saknas i modellen');
  assert.match(source, /onClick=\{\(\) => onSelect\(row\.id\)\}/, 'testkort är inte klickbara');
});

test('historical tests product surface hides internal replay fields', () => {
  const copy = uiFactoryExplorer().historicalTestsProduct;
  const forbiddenCopy = /Replay|Replay Queue|Replay Session|ReplayRun|Batch|libraryRunId|candidateDNA|candidateDnaHash|dnaHash|experimentId/;
  assert.equal(forbiddenCopy.test(JSON.stringify(copy)), false, 'testhistorikens produktcopy läcker tekniska begrepp');

  const replayBlock = source.slice(
    source.indexOf('function buildReplayRows'),
    source.indexOf('function productLifecycleCounts'),
  );
  for (const forbiddenLabel of [
    /label:\s*uiName\(FACTORY_TERM_KEYS\.STRATEGY_DNA\)/,
    /label:\s*uiName\(FACTORY_TERM_KEYS\.MARKET_DNA\)/,
    /label:\s*copy\.labels\.source/,
    /label:\s*copy\.labels\.replay/,
    /label:\s*['"`]runId['"`]/,
    /label:\s*['"`]dnaHash['"`]/,
    /label:\s*['"`]experimentId['"`]/,
  ]) {
    assert.equal(forbiddenLabel.test(replayBlock), false, 'testhistoriken visar tekniska fält');
  }
});

test('strategy library product surface hides internal strategy fields', () => {
  const copy = uiFactoryExplorer().libraryProduct;
  const forbiddenCopy = /strategyId|dnaHash|candidateDnaHash|libraryRunId|familyId|Lifecycle|Candidate|Promotion|Approval|Registry|DNA|Lineage|Canonical/;
  assert.equal(forbiddenCopy.test(JSON.stringify(copy)), false, 'bibliotekets produktcopy läcker tekniska begrepp');

  const buildLibraryBlock = source.slice(
    source.indexOf('function buildLibraryRows'),
    source.indexOf('function buildFamilyRows'),
  );
  for (const forbiddenLabel of [
    /label:\s*uiName\(FACTORY_TERM_KEYS\.STRATEGY_DNA\)/,
    /label:\s*uiName\(FACTORY_TERM_KEYS\.MARKET_DNA\)/,
    /label:\s*['"`]strategyId['"`]/,
    /label:\s*['"`]dnaHash['"`]/,
    /label:\s*['"`]familyId['"`]/,
  ]) {
    assert.equal(forbiddenLabel.test(buildLibraryBlock), false, 'bibliotekskort visar tekniska fält');
  }
});

test('factory explorer routes connect library, family tree, market and replay', () => {
  for (const route of ['/factory/replay', '/factory/library', '/factory/family-tree', '/factory/market-dna']) {
    assert.match(appSource, new RegExp(`path="${route.replace(/\//g, '\\/')}"`), `${route} saknas i App-rutter`);
  }
  assert.match(appSource, /<FactoryExplorerPage mode="library" \/>/, 'strategibibliotekets route saknar rätt läge');
  assert.match(appSource, /<FactoryExplorerPage mode="family" \/>/, 'strategiträdets route saknar rätt läge');
  assert.match(appSource, /<FactoryExplorerPage mode="market" \/>/, 'marknadsroutens route saknar rätt läge');
});

test('factory explorer visible terminology hides internal names', () => {
  const forbidden = /StrategyBrain|ReplayQueue|EvolutionEngine|MarketDNA|AIOptimizer|FactoryDirector|Runtime|ExperimentRegistry|Strategy Brain|Replay Queue|Evolution Engine|Market DNA|AI Optimizer|Factory Director|Experiment Registry/;
  assert.equal(forbidden.test(JSON.stringify(uiFactoryExplorer())), false);
});
