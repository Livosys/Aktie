import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiFactoryDashboard } from '../services/uiTerminologyService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'FactoryDashboardPage.jsx'), 'utf8');
const workflowSource = fs.readFileSync(path.join(here, '../components/factory/FactoryWorkflowPanels.jsx'), 'utf8');
const pipelineSource = fs.readFileSync(path.join(here, '../components/factory/FactoryWorkPipeline.jsx'), 'utf8');
const timelineSource = fs.readFileSync(path.join(here, '../components/factory/FactoryTimeline.jsx'), 'utf8');

test('factory dashboard reuses existing dashboard and trading components', () => {
  for (const component of [
    'DashboardShell',
    'AIStatusPanel',
    'ActionCenter',
    'FactoryLiveActivityFeed',
    'FactoryBrainCards',
    'FactoryStateGrid',
    'FactoryWorkPipeline',
    'FactoryTimeline',
    'QuickHelpModal',
    'Link',
    'useSearchParams',
  ]) {
    assert.match(source, new RegExp(component), `${component} används inte`);
  }
  for (const component of ['OverviewPanel', 'FieldGrid', 'MetricCard', 'StatusBadge', 'Link']) {
    assert.match(workflowSource, new RegExp(component), `workflowkomponenten använder inte ${component}`);
  }
  for (const component of ['OverviewPanel', 'FieldGrid', 'StatusBadge', 'Link']) {
    assert.match(pipelineSource, new RegExp(component), `arbetskedjan använder inte ${component}`);
  }
  for (const component of ['OverviewPanel', 'StatusBadge', 'Link']) {
    assert.match(timelineSource, new RegExp(component), `timelinekomponenten använder inte ${component}`);
  }
});

test('factory dashboard uses shared terminology for visible panel text', () => {
  assert.match(source, /uiTerminologyService/, 'sidan importerar inte terminologitjänsten');
  for (const helper of [
    'uiFactoryDashboard',
    'uiFactoryDecision',
    'uiFactoryGap',
    'uiFactoryReason',
    'uiFactorySafeText',
    'uiName',
    'uiStatus',
    'uiStrategyName',
  ]) {
    assert.match(source, new RegExp(helper), `${helper} används inte`);
  }

  const dashboard = uiFactoryDashboard();
  assert.ok(dashboard.title);
  assert.ok(dashboard.subtitle);

  assert.equal(dashboard.workflow.actionCenter.title, 'Behöver dig');
  assert.equal(dashboard.workflow.aiStatus.title, 'AI:ns läge');
  assert.ok(dashboard.workflow.activityFeed.title, 'aktivitetsflöde saknar titel');
  assert.ok(dashboard.workflow.timeline.title, 'Factory Timeline saknar titel');
  assert.equal(dashboard.labels.progress, 'Framsteg');
  assert.ok(dashboard.workflow.timeline.missing.tests, 'timeline saknar testtomläge');
  assert.ok(dashboard.workflow.timeline.missing.history, 'timeline saknar historiktomläge');
  assert.ok(dashboard.workflow.timeline.missing.improvements, 'timeline saknar förbättringstomläge');
  for (const key of ['today', 'work']) {
    assert.ok(dashboard.today.tabs[key], `${key} saknar fliknamn`);
  }
  for (const key of ['import', 'tests', 'learnings', 'improvement', 'approval', 'paper']) {
    assert.ok(dashboard.pipeline.steps[key]?.title, `${key} saknar arbetssteg`);
    assert.ok(dashboard.pipeline.steps[key]?.body, `${key} saknar beskrivning`);
  }
  for (const key of ['approveStrategy', 'waitTests', 'importHistory', 'reviewPaper', 'noAction']) {
    assert.ok(dashboard.workflow.actions[key]?.title, `${key} saknar uppgiftsrubrik`);
    assert.ok(dashboard.workflow.actions[key]?.explanation, `${key} saknar enkel förklaring`);
    assert.ok(dashboard.workflow.actions[key]?.why, `${key} saknar varför-text`);
    assert.ok(dashboard.workflow.actions[key]?.priority, `${key} saknar prioritet`);
    assert.ok(dashboard.workflow.actions[key]?.button, `${key} saknar knapptext`);
  }
  for (const key of ['historyImported', 'opportunityFound', 'testStarted', 'testCompleted', 'learned', 'improved', 'promoted', 'paperStarted', 'approved']) {
    assert.ok(dashboard.workflow.timeline.events[key]?.icon, `${key} saknar ikon`);
    assert.ok(dashboard.workflow.timeline.events[key]?.title, `${key} saknar rubrik`);
    assert.ok(dashboard.workflow.timeline.events[key]?.description, `${key} saknar beskrivning`);
    assert.ok(dashboard.workflow.timeline.events[key]?.href, `${key} saknar länk`);
  }
});

test('factory dashboard renders the Meridian two-tab product structure', () => {
  assert.match(source, /const TAB_TODAY = 'idag'/, 'Idag-fliken saknas');
  assert.match(source, /const TAB_WORK = 'arbetet'/, 'Arbetet-fliken saknas');
  assert.match(source, /role="tablist"/, 'flikrad saknas');
  assert.match(source, /data-factory-today data-factory-workflow/, 'Idag saknar stabil workflowmarkör');
  assert.match(source, /data-factory-work/, 'Arbetet saknar stabil markör');
  assert.match(source, /<AIStatusPanel status=\{model\.hero\} copy=\{copy\} \/>/, 'hero-läget renderas inte');
  assert.match(source, /<ActionCenter actions=\{model\.actions\} copy=\{copy\} \/>/, 'Behöver dig renderas inte');
  assert.match(source, /<FactoryStateGrid state=\{model\.state\} copy=\{copy\} \/>/, 'lägeskorten renderas inte');
  assert.match(source, /<FactoryLiveActivityFeed items=\{model\.activity\} copy=\{copy\} \/>/, 'aktivitetsflödet renderas inte');
  assert.match(source, /<FactoryBrainCards cards=\{model\.brainCards\} copy=\{copy\} \/>/, 'AI tänker-korten renderas inte');
  assert.match(source, /<FactoryWorkPipeline pipeline=\{model\.pipeline\} copy=\{copy\} \/>/, 'arbetskedjan renderas inte');
});

test('factory dashboard keeps one shared read-only help entry point', () => {
  assert.match(source, /QuickHelpModal/, 'hjälpmodulen saknas');
  assert.match(source, /helpOpen/, 'hjälpstatus saknas');
  assert.match(source, /setHelpOpen\(true\)/, 'hjälpknappen öppnar inte modalen');
  assert.match(source, /copy\.helpButton/, 'hjälpknappen använder inte gemensam copy');
});

test('factory dashboard is read-only and tolerates missing API sources', () => {
  assert.equal(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test(source), false, 'sidan gör muterande HTTP-anrop');
  assert.equal(/fetch\([^)]*\/api\/[^)]*,\s*\{[^}]*method:/s.test(source), false, 'fetch använder explicit metod');
  assert.match(source, /Promise\.all/, 'sidan hämtar inte källor samlat');
  assert.match(source, /catch\s*\(err\)/, 'sidan fångar inte endpointfel');
  assert.match(source, /emptyResource/, 'sidan saknar fallback för tom källa');
  assert.match(source, /resource\?\.ok/, 'sidan läser inte källor defensivt');
});

test('factory dashboard updates automatically without blocking the UI', () => {
  assert.match(source, /const AUTO_REFRESH_MS = \d+/, 'auto-refresh-intervall saknas');
  assert.match(source, /window\.setInterval/, 'dashboarden pollar inte automatiskt');
  assert.match(source, /window\.clearInterval/, 'dashboarden städar inte pollingintervall');
  assert.match(source, /setState\(\(current\) =>/, 'dashboarden behåller befintlig data under uppdatering');
  assert.match(source, /refreshing:\s*true/, 'uppdateringsstatus saknas');
  assert.equal(/while\s*\(/.test(source), false, 'dashboarden har en blockerande polling-loop');
});

test('factory dashboard panels read existing real API data', () => {
  const requiredEndpoints = [
    '/api/factory/director',
    '/api/factory/decision',
    '/api/factory/next',
    '/api/factory/status',
    '/api/strategy-brain',
    '/api/replay/queue',
    '/api/status/batches',
    '/api/strategy-library',
    '/api/market-intelligence',
    '/api/market-intelligence/catalog',
    '/api/ai-memory/status',
    '/api/ai-memory/experiments?limit=25',
    '/api/strategy-family-tree',
    '/api/learning/latest-summary',
  ];

  for (const endpoint of requiredEndpoints) {
    assert.match(source, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${endpoint} används inte`);
  }

  for (const field of [
    'currentDecision',
    'nextReplay',
    'informationGain',
    'targetRegime',
    'gapsAddressed',
    'pending_jobs',
    'running_jobs',
    'completed_jobs',
    'failed_jobs',
    'latestBatch',
    'replayHistory',
    'regimeCounts',
    'traits',
    'repeats',
    'observations',
    'mutation',
    'nodes',
    'recommendations\\?\\.optimize',
    'learningSummary',
    'learningRecords',
  ]) {
    assert.match(source, new RegExp(field), `${field} läses inte`);
  }
});

test('factory dashboard renders V1 workflow with user action, status, activity and timeline', () => {
  assert.match(source, /data-factory-workflow/, 'workflowytan saknar stabil markör');
  assert.match(source, /<AIStatusPanel status=\{model\.hero\} copy=\{copy\} \/>/, 'AI-läget renderas inte');
  assert.match(source, /<ActionCenter actions=\{model\.actions\} copy=\{copy\} \/>/, 'Behöver dig renderas inte');
  assert.match(source, /<FactoryLiveActivityFeed items=\{model\.activity\} copy=\{copy\} \/>/, 'aktivitetsflödet renderas inte');
  assert.match(source, /<FactoryTimeline/, 'Factory Timeline renderas inte');
  assert.match(source, /function buildActionCenter/, 'Action Center byggs inte från dashboarddata');
  assert.match(source, /function buildHero/, 'AI-läget byggs inte från dashboarddata');
  assert.match(source, /function buildState/, 'lägeskorten byggs inte från dashboarddata');
  assert.match(source, /function buildBrainCards/, 'AI tänker-korten byggs inte från dashboarddata');
  assert.match(source, /function buildImportantActivityFeed/, 'aktivitetsflödet byggs inte från dashboarddata');
  assert.match(source, /function buildFactoryTimeline/, 'Factory Timeline byggs inte från dashboarddata');
  assert.match(source, /function buildPipeline/, 'arbetskedjan byggs inte från dashboarddata');
  assert.match(source, /timestamp:\s*item\.time/, 'aktivitetsflödet behåller inte rå tid');
  assert.match(source, /function timelineEmptyItems/, 'Factory Timeline saknar tomlägen');
  assert.match(source, /historyImported/, 'timeline saknar historikimport');
  assert.match(source, /opportunityFound/, 'timeline saknar AI-fynd');
  assert.match(source, /testStarted/, 'timeline saknar teststart');
  assert.match(source, /testCompleted/, 'timeline saknar testresultat');
  assert.match(source, /learned/, 'timeline saknar lärdom');
  assert.match(source, /improved/, 'timeline saknar förbättring');
  assert.match(source, /promoted/, 'timeline saknar livscykelsteg');
  assert.match(source, /paperStarted/, 'timeline saknar Paper-start');
  assert.match(source, /approved/, 'timeline saknar godkännande');
  assert.match(source, /workflowAction\(copy, 'noAction'\)/, 'Action Center saknar tomt fallbackläge');
  assert.match(source, /REQUEST_BACKFILL_SERVICE/, 'Action Center fångar inte historikimport');
  assert.match(source, /REQUEST_APPROVAL_SERVICE/, 'Action Center fångar inte godkännande');
  assert.match(source, /queueCounts\.running > 0/, 'Action Center fångar inte pågående tester');
  assert.match(source, /queueCounts\.pending > 0/, 'Action Center fångar inte väntande tester');
  assert.match(workflowSource, /data-action-center/, 'Action Center-komponenten saknar stabil markör');
  assert.match(workflowSource, /data-ai-status-panel/, 'AI Status-komponenten saknar stabil markör');
  assert.match(workflowSource, /data-factory-state/, 'lägeskorten saknar stabil markör');
  assert.match(workflowSource, /data-factory-brain/, 'AI tänker-korten saknar stabil markör');
  assert.match(workflowSource, /data-factory-activity-feed/, 'aktivitetsflödet saknar stabil markör');
  assert.match(workflowSource, /panel\.empty/, 'aktivitetsflödet saknar tomläge');
  assert.match(pipelineSource, /data-factory-work-pipeline/, 'arbetskedjan saknar stabil markör');
  assert.match(pipelineSource, /data-factory-pipeline-step/, 'arbetsstegen saknar stabil markör');
  assert.match(pipelineSource, /data-factory-pipeline-learned/, 'lärdomspanelen saknar stabil markör');
  assert.match(pipelineSource, /data-factory-pipeline-attention/, 'misslyckandepanelen saknar stabil markör');
  assert.match(timelineSource, /data-factory-timeline/, 'Factory Timeline saknar stabil markör');
  assert.match(timelineSource, /data-factory-timeline-event/, 'Factory Timeline saknar eventmarkör');
  assert.match(timelineSource, /text\.empty/, 'Factory Timeline saknar tom fallback');
});

test('factory dashboard has explicit empty-data fallbacks instead of placeholders', () => {
  assert.equal(/placeholder|mock|dummy|sample data/i.test(source), false, 'sidan innehåller placeholderkod');
  const combinedSource = `${source}\n${workflowSource}\n${pipelineSource}\n${timelineSource}`;
  const dashboard = uiFactoryDashboard();
  for (const key of [
    'noReplayYet',
    'noImprovementYet',
    'noRecentActivity',
    'noNextActivity',
    'noFailures',
    'noLearnings',
    'genericReason',
    'noMarketSelected',
    'noStrategy',
  ]) {
    assert.ok(dashboard.states[key], `${key} saknas`);
    assert.match(combinedSource, new RegExp(key), `${key} används inte av dashboarden`);
  }
});

test('factory dashboard terminology hides internal names', () => {
  const forbidden = /StrategyBrain|ReplayQueue|EvolutionEngine|MarketDNA|AIOptimizer|FactoryDirector|Runtime|ExperimentRegistry/;
  const visibleText = JSON.stringify(uiFactoryDashboard());
  assert.equal(forbidden.test(visibleText), false);
  assert.equal(forbidden.test(workflowSource), false);
  assert.equal(forbidden.test(pipelineSource), false);
  assert.equal(forbidden.test(timelineSource), false);
});
