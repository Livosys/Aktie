import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_SURFACES,
  navItemsFor,
} from './navigation.js';
import { uiFactoryDashboard } from './services/uiTerminologyService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

test('V1 product navigation contains only the final product entries', () => {
  assert.deepEqual(NAV_GROUPS.map((group) => group.id), ['product', 'operations', 'labs']);
  assert.deepEqual(
    NAV_ITEMS.map((item) => [item.id, item.path, item.group]),
    [
      ['factory', '/factory', 'product'],
      ['strategy-library', '/factory/library', 'product'],
      ['tests', '/factory/replay', 'product'],
      ['paper', '/futures-paper', 'product'],
      ['system', '/system', 'operations'],
      ['labs', '/lab', 'labs'],
    ],
  );
  assert.deepEqual(navItemsFor(NAV_SURFACES.MOBILE_BOTTOM).map((item) => item.id), [
    'factory',
    'strategy-library',
    'tests',
    'paper',
  ]);
});

test('legacy and research routes remain declared but are owned by Labs in navigation', () => {
  const appSource = read('App.jsx');
  const declared = new Set([...appSource.matchAll(/path="([^"]*)"/g)].map((match) => match[1]));
  for (const route of [
    '/trading-lab',
    '/replay',
    '/batch',
    '/ai',
    '/pinescript',
    '/narrow',
    '/insikter',
    '/quality',
    '/review-chart',
  ]) {
    assert.ok(declared.has(route), `${route} saknas som bakåtkompatibel route`);
    assert.ok(NAV_ITEMS.find((item) => item.id === 'labs').match.includes(route), `${route} ägs inte av Labs`);
  }
});

test('search shortcuts point to declared product or legacy routes', () => {
  const appSource = read('App.jsx');
  const topBarSource = read('components/TopBar.jsx');
  const declared = new Set([...appSource.matchAll(/path="([^"]*)"/g)].map((match) => match[1]));
  const shortcuts = [...topBarSource.matchAll(/to:\s*'([^']+)'/g)].map((match) => match[1]);
  for (const shortcut of shortcuts) {
    assert.ok(declared.has(shortcut.split('?')[0]), `${shortcut} pekar inte på en deklarerad route`);
  }
});

test('Paper product view opens on daily state and hides legacy tabs from the top tabs', () => {
  const source = read('pages/FuturesPaperDeskPage.jsx');
  const terminology = read('services/uiTerminologyService.js');
  assert.match(source, /const DEFAULT_TAB = 'oversikt'/);
  assert.match(source, /const PRODUCT_TABS = \[/);
  assert.match(source, /Dagens läge/);
  assert.match(source, /Öppna positioner/);
  assert.match(terminology, /Senaste avslut/);
  assert.match(source, /Visa teknisk information/);
  assert.match(source, /const LEGACY_TABS = \[/);
  assert.match(source, /tabs = useMemo\(\(\) => VISIBLE_TABS\.map/);
});

test('System product view exposes only health, broker, data sources, safety and logs', () => {
  const source = read('pages/SystemPage.jsx');
  assert.match(source, /key: 'health', label: 'Hälsa'/);
  assert.match(source, /key: 'broker', label: 'Broker'/);
  assert.match(source, /key: 'providers', label: 'Datakällor'/);
  assert.match(source, /key: 'safety', label: 'Säkerhet'/);
  assert.match(source, /key: 'logs', label: 'Loggar'/);
  assert.match(source, /HIDDEN_TAB_KEYS = new Set\(\['overview', 'debug'\]\)/);
});

test('Labs is clearly marked as an experimental development surface', () => {
  const source = read('pages/TradingLabPage.jsx');
  assert.match(source, /title="Labs"/);
  assert.match(source, /Experimentella verktyg för analys och utveckling/);
  assert.match(source, /Detta är experimentella verktyg och ingår inte i den dagliga produkten/);
});

test('product terminology avoids backend class names in shared visible copy', () => {
  const terminology = read('services/uiTerminologyService.js');
  const forbiddenVisible = /displayName:\s*'(Factory Director|Strategy Brain|Replay Queue|Replay Engine|AI Optimizer|Evolution Engine|Market DNA|Experiment Registry)'/;
  assert.equal(forbiddenVisible.test(terminology), false);
});

test('AI Fabriken contains V1 workflow panels and user-facing activity labels', () => {
  const dashboardSource = read('pages/FactoryDashboardPage.jsx');
  const workflowSource = read('components/factory/FactoryWorkflowPanels.jsx');
  const timelineSource = read('components/factory/FactoryTimeline.jsx');
  const liveFeedSource = read('components/factory/FactoryLiveActivityFeed.jsx');
  const terminology = read('services/uiTerminologyService.js');
  assert.match(dashboardSource, /data-factory-workflow/);
  assert.match(workflowSource, /data-action-center/);
  assert.match(workflowSource, /data-ai-status-panel/);
  assert.match(workflowSource, /data-factory-activity-feed/);
  assert.match(timelineSource, /data-factory-timeline/);
  assert.match(dashboardSource, /<FactoryTimeline/);
  assert.ok(
    dashboardSource.indexOf('const latestRunningJob =') < dashboardSource.indexOf('const story = aiStoryFactory('),
    'FactoryDashboardPage läser jobb innan AI-story byggs',
  );
  assert.equal(/role="tablist"/.test(liveFeedSource), false, 'aktivitetsflödet använder inte längre tablist-semantik');
  assert.equal(/role="tab"/.test(liveFeedSource), false, 'aktivitetsflödet använder inte längre tab-semantik');
  assert.match(liveFeedSource, /aria-pressed=/, 'aktivitetsflödet använder inte vanliga filterknappar');
  for (const text of [
    'Godkänn strategi',
    'Vänta på tester',
    'Importera historik',
    'Granska Paper-resultat',
    'Inget behöver göras',
    'AI började testa',
    'Test färdigt',
    'Strategi flyttad till Redo för Paper',
    'Historik importerad',
    'AI hittade en möjlighet',
    'Historiskt test startade',
    'Historiskt test klart',
    'AI lärde sig något',
    'Strategin förbättrades',
    'Strategin gick vidare till nästa steg',
    'Paper Trading startade',
    'Godkänd',
    'Inga tester har körts ännu',
    'AI väntar på historisk data',
    'Inga förbättringar har gjorts ännu',
  ]) {
    assert.match(terminology, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Action Center and Factory Timeline links point to declared routes', () => {
  const appSource = read('App.jsx');
  const declared = new Set([...appSource.matchAll(/path="([^"]*)"/g)].map((match) => match[1]));
  const actions = Object.values(uiFactoryDashboard().workflow.actions);
  for (const action of actions) {
    assert.ok(declared.has(action.href.split('?')[0]), `${action.title} pekar på saknad route ${action.href}`);
  }
  const timelineEvents = Object.values(uiFactoryDashboard().workflow.timeline.events);
  for (const event of timelineEvents) {
    assert.ok(declared.has(event.href.split('?')[0]), `${event.title} pekar på saknad route ${event.href}`);
  }
});

test('/paper-trading är nu en vidareväg till futures-paper', () => {
  const appSource = read('App.jsx');
  assert.match(appSource, /Route path="\/paper-trading"\s+element={<Navigate to="\/futures-paper" replace \/>}/, 'legacy paper-trading skickar inte vidare till futures-paper');
});
