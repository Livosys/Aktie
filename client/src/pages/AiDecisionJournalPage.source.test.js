import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiDecisionJournal, uiFactoryFlowNavigation } from '../services/uiTerminologyService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(here, 'AiDecisionJournalPage.jsx'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');
const navSource = fs.readFileSync(path.join(root, 'navigation.js'), 'utf8');

test('AI decision journal reuses existing dashboard and trading components', () => {
  for (const component of [
    'DashboardShell',
    'OverviewPanel',
    'FieldGrid',
    'MetricCard',
    'StatusBadge',
    'DecisionTimeline',
    'Link',
  ]) {
    assert.match(source, new RegExp(component), `${component} används inte`);
  }
});

test('AI decision journal uses shared terminology for visible text', () => {
  assert.match(source, /uiTerminologyService/, 'sidan importerar inte terminologitjänsten');
  for (const helper of [
    'uiDecisionJournal',
    'uiFactoryDecision',
    'uiFactoryGap',
    'uiFactoryReason',
    'uiFactorySafeText',
    'uiName',
    'uiStatus',
  ]) {
    assert.match(source, new RegExp(helper), `${helper} används inte`);
  }

  const journal = uiDecisionJournal();
  assert.ok(journal.title);
  assert.ok(journal.subtitle);
  for (const key of ['time', 'strategy', 'market', 'replay', 'learning', 'memory', 'recommendation', 'mutation', 'result', 'why', 'next']) {
    assert.ok(journal.columns[key], `${key} saknar kolumntext`);
  }
  for (const key of ['replay', 'learning', 'memory', 'brain', 'director', 'optimizer', 'evolution', 'library']) {
    assert.ok(journal.timeline[key], `${key} saknar tidslinjetext`);
    assert.ok(journal.timelineReasons[key], `${key} saknar förklaring`);
    assert.ok(journal.timelineActions[key], `${key} saknar öppningshandling`);
  }
  for (const key of ['time', 'duration', 'status', 'result', 'happened', 'why', 'outcome', 'current', 'open']) {
    assert.ok(journal.timelineFields[key], `${key} saknar tidslinjefält`);
  }
});

test('AI decision journal reads only existing API data', () => {
  const requiredEndpoints = [
    '/api/factory/director',
    '/api/factory/decision',
    '/api/factory/next',
    '/api/factory/status',
    '/api/strategy-brain',
    '/api/replay/queue',
    '/api/strategy-library',
    '/api/strategy-library/audit?limit=5000',
    '/api/ai-memory/status',
    '/api/ai-memory/experiments?limit=2000',
    '/api/strategy-family-tree',
    '/api/ai-optimizer/contract',
    '/api/market-intelligence',
    '/api/market-intelligence/catalog',
    '/api/learning/latest-summary',
    '/api/events/recent?n=100',
    '/api/audit/recent?limit=500',
  ];

  for (const endpoint of requiredEndpoints) {
    assert.match(source, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${endpoint} används inte`);
  }

  assert.equal(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test(source), false, 'sidan gör muterande HTTP-anrop');
  assert.equal(/fetch\([^)]*\/api\/[^)]*,\s*\{[^}]*method:/s.test(source), false, 'fetch använder explicit metod');
  assert.match(source, /Promise\.all/, 'sidan hämtar inte källor samlat');
  assert.match(source, /catch\s*\(err\)/, 'sidan fångar inte endpointfel');
  assert.match(source, /emptyResource/, 'sidan saknar fallback för tom källa');
});

test('AI decision journal renders the required row fields and clickable timeline', () => {
  for (const field of [
    'columns.time',
    'columns.strategy',
    'columns.market',
    'columns.replay',
    'columns.learning',
    'columns.memory',
    'columns.recommendation',
    'columns.mutation',
    'columns.result',
    'columns.why',
    'columns.next',
  ]) {
    assert.match(source, new RegExp(field.replace('.', '\\.')), `${field} renderas inte`);
  }

  assert.match(source, /onClick=\{\(\) => onSelect\(row\.id\)\}/, 'journalraden är inte klickbar');
  assert.match(source, /onClick=\{\(\) => onSelect\(item\.stepKey\)\}/, 'tidslinjesteg är inte klickbara');
  assert.match(source, /function TimelinePanel/, 'tidslinjepanel saknas');
  assert.match(source, /<DecisionTimeline items=\{timeline\}/, 'DecisionTimeline används inte med valda raden');
  assert.match(source, /const TIMELINE_ORDER = Object\.freeze/, 'tidslinjeordning saknas');
  assert.match(source, /data-decision-timeline-step/, 'tidslinjesteg saknar klickbar markör');
  assert.match(source, /TimelineStepDetail/, 'öppnad stegdetalj saknas');
  assert.match(source, /fields\.duration/, 'tidslinjen visar inte varaktighet');
  assert.match(source, /fields\.status/, 'tidslinjen visar inte status');
  assert.match(source, /fields\.result/, 'tidslinjen visar inte resultat');
  assert.match(source, /fields\.happened/, 'stegdetaljen visar inte vad som hände');
  assert.match(source, /fields\.current/, 'stegdetaljen visar inte vad AI gör nu');
  assert.match(source, /href:\s*timelineHref\(key,\s*row\)/, 'tidslinjen saknar länkar till fabriksflödet');
  assert.match(source, /to=\{step\.href\}/, 'öppnad stegdetalj länkar inte vidare');
});

test('AI decision journal has explicit empty-data fallbacks instead of placeholders', () => {
  assert.equal(/placeholder|mock|dummy|sample data/i.test(source), false, 'sidan innehåller placeholderkod');
  const journal = uiDecisionJournal();
  for (const key of [
    'noDecisions',
    'noTimeline',
    'noStrategy',
    'noMarket',
    'noReplay',
    'noLearning',
    'noMemory',
    'noRecommendation',
    'noMutation',
    'noResult',
    'noReason',
    'noNext',
  ]) {
    assert.ok(journal.states[key], `${key} saknas`);
    assert.match(source, new RegExp(key), `${key} används inte av journalen`);
  }
});

test('AI decision journal visible terminology hides internal class names', () => {
  const forbidden = /StrategyBrain|ReplayQueue|EvolutionEngine|MarketDNA|AIOptimizer|FactoryDirector|Runtime|ExperimentRegistry|Strategy Brain|Replay Queue|Evolution Engine|Market DNA|AI Optimizer|Factory Director|Experiment Registry/;
  assert.equal(forbidden.test(JSON.stringify(uiDecisionJournal())), false);
  assert.equal(forbidden.test(JSON.stringify(uiFactoryFlowNavigation())), false);
});

test('AI decision journal is reachable from route and factory context', () => {
  assert.match(appSource, /AiDecisionJournalPage/, 'routen laddar inte journalsidan');
  assert.match(appSource, /path="\/decision-journal"/, 'journalrouten saknas');
  assert.match(appSource, /path="\/factory\/replay"/, 'fabriksrouten för replay saknas');
  assert.match(appSource, /path="\/factory\/library"/, 'fabriksrouten för strategibibliotek saknas');
  assert.match(appSource, /path="\/factory\/family-tree"/, 'fabriksrouten för strategiträd saknas');
  assert.match(appSource, /path="\/factory\/market-dna"/, 'fabriksrouten för marknadstyp saknas');
  assert.match(navSource, /match:\s*\[[^\]]*'\/decision-journal'/s, 'journalen hör inte till AI Fabriken i navigationen');
});
