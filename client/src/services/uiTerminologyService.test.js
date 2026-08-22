import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FACTORY_DASHBOARD_PANEL_KEYS,
  FACTORY_FLOW_STEP_KEYS,
  FACTORY_STATUS_KEYS,
  FACTORY_TERM_KEYS,
  uiDecisionJournal,
  uiFactoryDashboard,
  uiFactoryDashboardPanel,
  uiFactoryDecision,
  uiFactoryExplorer,
  uiFactoryFlowNavigation,
  uiDescription,
  uiFactoryAction,
  uiFactoryGap,
  uiFactoryReason,
  uiFactorySafeText,
  uiLifecycleStage,
  uiName,
  uiPanelHelpItems,
  uiStatus,
} from './uiTerminologyService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('factory terminology exposes every required display name', () => {
  const expected = {
    [FACTORY_TERM_KEYS.FACTORY_DIRECTOR]: 'Nästa steg',
    [FACTORY_TERM_KEYS.FACTORY_STATUS]: 'AI Fabriken',
    [FACTORY_TERM_KEYS.AI_DECISION_JOURNAL]: 'AI-beslutsjournal',
    [FACTORY_TERM_KEYS.STRATEGY_FAMILY_TREE]: 'Strategiträd',
    [FACTORY_TERM_KEYS.STRATEGY_BRAIN]: 'AI tänker',
    [FACTORY_TERM_KEYS.AI_MEMORY]: 'Tidigare tester',
    [FACTORY_TERM_KEYS.REPLAY_QUEUE]: 'Testkö',
    [FACTORY_TERM_KEYS.REPLAY_SCHEDULER]: 'Testplanering',
    [FACTORY_TERM_KEYS.REPLAY_ENGINE]: 'Testmotor',
    [FACTORY_TERM_KEYS.HISTORICAL_BACKFILL]: 'Historisk import',
    [FACTORY_TERM_KEYS.HISTORICAL_PRICE_FEED]: 'Historisk marknadsdata',
    [FACTORY_TERM_KEYS.STRATEGY_RUNTIME]: 'Strategimotor',
    [FACTORY_TERM_KEYS.STRATEGY_LIBRARY]: 'Strategibibliotek',
    [FACTORY_TERM_KEYS.STRATEGY_DNA]: 'Strategiprofil',
    [FACTORY_TERM_KEYS.MARKET_DNA]: 'Marknadstyp',
    [FACTORY_TERM_KEYS.AI_OPTIMIZER]: 'AI förbättrar',
    [FACTORY_TERM_KEYS.EVOLUTION_ENGINE]: 'Strategiförbättring',
    [FACTORY_TERM_KEYS.APPROVAL]: 'Godkännande',
    [FACTORY_TERM_KEYS.PAPER_TRADING]: 'Paper Trading',
    [FACTORY_TERM_KEYS.KNOWLEDGE_GAPS]: 'Saknade tester',
    [FACTORY_TERM_KEYS.BLIND_SPOTS]: 'Otestade marknader',
    [FACTORY_TERM_KEYS.CANDIDATE]: 'Redo för Paper',
    [FACTORY_TERM_KEYS.DRAFT]: 'Under utveckling',
    [FACTORY_TERM_KEYS.TESTING]: 'Testas',
    [FACTORY_TERM_KEYS.PAPER]: 'Paper Trading',
    [FACTORY_TERM_KEYS.LIVE]: 'Live Trading',
    [FACTORY_TERM_KEYS.RETIRED]: 'Arkiverad',
  };

  for (const [key, value] of Object.entries(expected)) {
    assert.equal(uiName(key), value, key);
    assert.ok(uiDescription(key), `${key} saknar beskrivning`);
    assert.equal(uiPanelHelpItems(key).length >= 3, true, `${key} saknar komplett panelhjälp`);
  }
});

test('factory status names are centralized and Swedish', () => {
  assert.equal(uiStatus(FACTORY_STATUS_KEYS.RUNNING), 'Körs');
  assert.equal(uiStatus(FACTORY_STATUS_KEYS.WAITING), 'Väntar');
  assert.equal(uiStatus(FACTORY_STATUS_KEYS.PAUSED), 'Pausad');
  assert.equal(uiStatus(FACTORY_STATUS_KEYS.COMPLETED), 'Klar');
  assert.equal(uiStatus(FACTORY_STATUS_KEYS.FAILED), 'Misslyckades');
  assert.equal(uiStatus(FACTORY_STATUS_KEYS.IDLE), 'Redo');
});

test('factory actions, gaps and lifecycle labels use terminology helpers', () => {
  assert.equal(uiFactoryAction('paper'), 'Redo för Paper');
  assert.equal(uiFactoryAction('retire'), 'Föreslås arkiveras');
  assert.equal(uiFactoryGap('missing_market_dna'), 'Otestade marknader');
  assert.equal(uiLifecycleStage('draft'), 'Under utveckling');
  assert.equal(uiLifecycleStage('testing'), 'Testas');
  assert.equal(uiLifecycleStage('candidate'), 'Redo för Paper');
  assert.equal(uiLifecycleStage('paper'), 'Paper Trading');
  assert.equal(uiLifecycleStage('live'), 'Live Trading');
  assert.equal(uiLifecycleStage('retired'), 'Arkiverad');
});

test('factory dashboard exposes every required panel from shared terminology', () => {
  const dashboard = uiFactoryDashboard();
  assert.equal(dashboard.title, 'AI Fabriken');
  assert.ok(dashboard.subtitle);
  assert.ok(dashboard.labels.status);
  assert.ok(dashboard.states.sourceMissing);

  const expectedPanels = [
    [FACTORY_DASHBOARD_PANEL_KEYS.FACTORY, 'AI Fabriken'],
    [FACTORY_DASHBOARD_PANEL_KEYS.BRAIN, 'AI tänker'],
    [FACTORY_DASHBOARD_PANEL_KEYS.TESTS, 'Pågående tester'],
    [FACTORY_DASHBOARD_PANEL_KEYS.IMPROVEMENT, 'Strategiförbättring'],
    [FACTORY_DASHBOARD_PANEL_KEYS.LIBRARY, 'Strategibibliotek'],
    [FACTORY_DASHBOARD_PANEL_KEYS.MARKET, 'Marknad'],
    [FACTORY_DASHBOARD_PANEL_KEYS.MEMORY, 'Tidigare tester'],
  ];

  for (const [key, title] of expectedPanels) {
    const panel = uiFactoryDashboardPanel(key);
    assert.equal(panel.title, title, key);
    assert.ok(panel.icon, `${key} saknar ikon`);
    assert.ok(panel.description, `${key} saknar beskrivning`);
    assert.ok(panel.why, `${key} saknar orsakstext`);
    assert.ok(panel.next, `${key} saknar nästa steg`);
  }

  for (const key of ['aiWorking', 'aiWaiting', 'replayRunning', 'replayCompleted', 'learning', 'brain', 'mutation', 'candidate', 'paper', 'live']) {
    assert.ok(dashboard.live.steps[key].icon, `${key} saknar ikon`);
    assert.ok(dashboard.live.steps[key].label, `${key} saknar namn`);
    assert.ok(dashboard.live.stepReasons[key], `${key} saknar förklaring`);
  }
  assert.ok(dashboard.workflow.actionCenter.title);
  assert.ok(dashboard.workflow.aiStatus.title);
  assert.ok(dashboard.workflow.activityFeed.title);
  assert.ok(dashboard.workflow.timeline.title);
  assert.ok(dashboard.workflow.timeline.subtitle);
  for (const key of ['tests', 'history', 'improvements']) {
    assert.ok(dashboard.workflow.timeline.missing[key], `${key} saknar timeline-tomläge`);
  }
  for (const key of ['checkSystem', 'approveStrategy', 'importHistory', 'waitTests', 'reviewPaper', 'noAction']) {
    assert.ok(dashboard.workflow.actions[key].title, `${key} saknar titel`);
    assert.ok(dashboard.workflow.actions[key].explanation, `${key} saknar förklaring`);
    assert.ok(dashboard.workflow.actions[key].why, `${key} saknar varför`);
    assert.ok(dashboard.workflow.actions[key].priority, `${key} saknar prioritet`);
    assert.ok(dashboard.workflow.actions[key].button, `${key} saknar knapp`);
  }
  for (const key of ['aiStartedTesting', 'testCompleted', 'strategyCandidate', 'strategyApprovedPaper', 'historyImported']) {
    assert.ok(dashboard.workflow.events[key], `${key} saknar aktivitetsrubrik`);
  }
  for (const key of ['historyImported', 'opportunityFound', 'testStarted', 'testCompleted', 'learned', 'improved', 'promoted', 'paperStarted', 'approved']) {
    assert.ok(dashboard.workflow.timeline.events[key].icon, `${key} saknar ikon`);
    assert.ok(dashboard.workflow.timeline.events[key].title, `${key} saknar rubrik`);
    assert.ok(dashboard.workflow.timeline.events[key].description, `${key} saknar beskrivning`);
    assert.ok(dashboard.workflow.timeline.events[key].href, `${key} saknar länk`);
  }
  assert.ok(dashboard.labels.estimatedTime);
  assert.ok(dashboard.labels.latestImprovements);
  assert.ok(dashboard.labels.latestFailures);
  assert.ok(dashboard.labels.latestLearnings);
});

test('factory dashboard terminology does not expose internal code names', () => {
  const forbidden = /StrategyBrain|ReplayQueue|EvolutionEngine|MarketDNA|AIOptimizer|FactoryDirector|Runtime|ExperimentRegistry|Strategy Brain|Replay Queue|Evolution Engine|Market DNA|AI Optimizer|Factory Director|Experiment Registry/;
  const dashboard = uiFactoryDashboard();
  const visibleText = JSON.stringify({
    title: dashboard.title,
    subtitle: dashboard.subtitle,
    labels: dashboard.labels,
    states: dashboard.states,
    units: dashboard.units,
    panels: dashboard.panels,
    decisions: [
      uiFactoryDecision('SAFETY_HOLD'),
      uiFactoryDecision('REQUEST_BACKFILL_SERVICE'),
      uiFactoryDecision('REQUEST_REPLAY_SCHEDULER'),
      uiFactoryDecision('REQUEST_REPLAY_QUEUE'),
      uiFactoryDecision('REQUEST_AI_OPTIMIZER'),
      uiFactoryDecision('REQUEST_EVOLUTION_ENGINE'),
      uiFactoryDecision('REQUEST_APPROVAL_SERVICE'),
      uiFactoryDecision('IDLE'),
    ],
  });

  assert.equal(forbidden.test(visibleText), false);
  assert.equal(uiFactoryReason('replay_job_pending'), 'Ett historiskt test väntar på att köras.');
  assert.equal(uiFactorySafeText('StrategyBrain via ReplayQueue'), 'AI tänker via Testkö');
  assert.equal(
    uiFactorySafeText('ReplayQueueService ReplayRun FactoryDirector StrategyRuntime candidateDnaHash libraryRunId ExperimentRegistry'),
    'Testkö Historiskt test Nästa steg Strategimotor Strategiprofil Resultatreferens Testregister',
  );
});

test('AI decision journal terminology is centralized and hides internal names', () => {
  const journal = uiDecisionJournal();
  assert.equal(journal.title, 'AI-beslutsjournal');
  assert.ok(journal.subtitle);
  assert.ok(journal.columns.time);
  assert.ok(journal.columns.strategy);
  assert.ok(journal.columns.market);
  assert.ok(journal.columns.replay);
  assert.ok(journal.columns.learning);
  assert.ok(journal.columns.memory);
  assert.ok(journal.columns.recommendation);
  assert.ok(journal.columns.mutation);
  assert.ok(journal.columns.result);
  assert.ok(journal.columns.why);
  assert.ok(journal.columns.next);

  for (const key of ['replay', 'learning', 'memory', 'brain', 'director', 'optimizer', 'evolution', 'library']) {
    assert.ok(journal.timeline[key], `${key} saknar tidslinjenamn`);
    assert.ok(journal.timelineReasons[key], `${key} saknar tidslinjetext`);
    assert.ok(journal.timelineActions[key], `${key} saknar öppningstext`);
  }

  for (const key of ['time', 'duration', 'status', 'result', 'happened', 'why', 'outcome', 'current', 'open']) {
    assert.ok(journal.timelineFields[key], `${key} saknar tidslinjefält`);
  }

  const forbidden = /StrategyBrain|ReplayQueue|EvolutionEngine|MarketDNA|AIOptimizer|FactoryDirector|Runtime|ExperimentRegistry|Strategy Brain|Replay Queue|Evolution Engine|Market DNA|AI Optimizer|Factory Director|Experiment Registry/;
  assert.equal(forbidden.test(JSON.stringify(journal)), false);
});

test('factory flow navigation and explorer terminology are centralized', () => {
  const flow = uiFactoryFlowNavigation();
  assert.deepEqual(flow.order, [
    FACTORY_FLOW_STEP_KEYS.DASHBOARD,
    FACTORY_FLOW_STEP_KEYS.REPLAY,
    FACTORY_FLOW_STEP_KEYS.LIBRARY,
    FACTORY_FLOW_STEP_KEYS.JOURNAL,
  ]);

  assert.equal(flow.items[FACTORY_FLOW_STEP_KEYS.DASHBOARD].path, '/factory');
  assert.equal(flow.items[FACTORY_FLOW_STEP_KEYS.JOURNAL].path, '/decision-journal');
  assert.equal(flow.items[FACTORY_FLOW_STEP_KEYS.REPLAY].path, '/factory/replay');
  assert.equal(flow.items[FACTORY_FLOW_STEP_KEYS.LIBRARY].path, '/factory/library');
  assert.equal(flow.items[FACTORY_FLOW_STEP_KEYS.FAMILY].path, '/factory/family-tree');
  assert.equal(flow.items[FACTORY_FLOW_STEP_KEYS.MARKET].path, '/factory/market-dna');

  const explorer = uiFactoryExplorer();
  for (const mode of ['library', 'replay', 'family', 'market']) {
    assert.ok(explorer.modes[mode].title, `${mode} saknar titel`);
    assert.ok(explorer.modes[mode].subtitle, `${mode} saknar undertitel`);
    assert.ok(explorer.modes[mode].summary, `${mode} saknar sammanfattning`);
  }

  const forbidden = /StrategyBrain|ReplayQueue|EvolutionEngine|MarketDNA|AIOptimizer|FactoryDirector|Runtime|ExperimentRegistry|Strategy Brain|Replay Queue|Evolution Engine|Market DNA|AI Optimizer|Factory Director|Experiment Registry/;
  assert.equal(forbidden.test(JSON.stringify({ flow, explorer })), false);
});

test('AI Factory UI components import shared terminology instead of hardcoded factory headings', () => {
  const files = [
    'components/factory/FactoryFlowNav.jsx',
    'pages/FactoryDashboardPage.jsx',
    'pages/AiDecisionJournalPage.jsx',
    'pages/FactoryExplorerPage.jsx',
    'components/trading/StrategyBrainPanel.jsx',
    'components/trading/StrategyLifecyclePanel.jsx',
    'components/trading/StrategyRuntimePanel.jsx',
    'components/trading/StrategyApprovalPanel.jsx',
    'components/tradingos/QuickHelpModal.jsx',
    'pages/FuturesPaperDeskPage.jsx',
    'pages/SupervisorV2Page.jsx',
    'pages/SupervisorBrainPage.jsx',
    'domain/EventDomain.js',
    'domain/StrategyDomain.js',
    'domain/ScannerDomain.js',
    'domain/AIDomain.js',
    'domain/DecisionDomain.js',
  ];

  for (const file of files) {
    assert.match(read(file), /uiTerminologyService/, `${file} använder inte gemensam terminologi`);
  }

  const forbiddenUiStrings = [
    'eyebrow="Strategy Brain"',
    'eyebrow="Strategy Library"',
    'eyebrow="Runtime"',
    'eyebrow="Approval"',
    'title="Runtime State"',
    'title="Approval State"',
    'title="AI Memory / Knowledge Base"',
    'term="Replay"',
    'term="Testkö"',
    'help="Ett test på gammal data',
    "title: 'Testkö'",
    "text: 'En lista med idéer",
    "'Strategy Runtime'",
    "'Replay Decision'",
    "'Supervisor Approval'",
    "'Risk Approval'",
  ];

  for (const file of files) {
    const source = stripComments(read(file));
    for (const text of forbiddenUiStrings) {
      assert.equal(source.includes(text), false, `${file} har hårdkodad UI-text: ${text}`);
    }
  }
});

test('uiFactorySafeText never renders objects as [object Object]', () => {
  assert.equal(uiFactorySafeText(null), '');
  assert.equal(uiFactorySafeText(undefined), '');
  assert.equal(uiFactorySafeText(''), '');
  assert.equal(uiFactorySafeText('normal string'), 'normal string');
  assert.equal(uiFactorySafeText(123), '123');
  assert.equal(uiFactorySafeText(true), 'true');
  assert.equal(uiFactorySafeText(false), 'false');
  const objectResult = uiFactorySafeText({ field: 'value' });
  assert.equal(objectResult.includes('[object Object]'), false, 'uiFactorySafeText must not render objects as [object Object]');
  const arrayResult = uiFactorySafeText(['item1', 'item2']);
  assert.equal(arrayResult.includes('[object Object]'), false, 'uiFactorySafeText must not render arrays as [object Object]');
});
