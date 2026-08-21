import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_SURFACES,
  isNavItemActive,
  navGroupsFor,
  navItemsFor,
} from './navigation.js';

// V1-produkten ska ha en enda huvudväg till fabriken, strategier, tester,
// handelstest och system. Alla äldre utvecklings- och researchvyer ligger bakom
// Labs men behåller sina routes för bokmärken.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

const SIDEBAR = 'components/Sidebar.jsx';
const TOPNAV = 'components/dashboard/DashboardKit.jsx';
const MOBILE = 'MobileBottomNav.jsx';
const RENDERERS = [SIDEBAR, TOPNAV, MOBILE];

const byId = (id) => NAV_ITEMS.find((item) => item.id === id);

// ── V1-produktmenyn ──────────────────────────────────────────────────────────

test('V1-menyn har exakt en huvudväg per produktområde', () => {
  assert.deepEqual(
    NAV_ITEMS.map((item) => item.id),
    ['factory', 'strategy-library', 'tests', 'paper', 'system', 'labs'],
  );
  assert.equal(byId('factory')?.path, '/factory');
  assert.equal(byId('strategy-library')?.path, '/factory/library');
  assert.equal(byId('tests')?.path, '/factory/replay');
  assert.equal(byId('paper')?.path, '/futures-paper');
  assert.equal(byId('system')?.path, '/system');
  assert.equal(byId('labs')?.path, '/lab');
});

test('alla V1-poster visas i sidomeny och toppmeny, med fyra mobilflikar', () => {
  for (const id of ['factory', 'strategy-library', 'tests', 'paper', 'system', 'labs']) {
    const item = byId(id);
    assert.ok(item.surfaces.includes(NAV_SURFACES.SIDEBAR), `${id} saknas i sidomenyn`);
    assert.ok(item.surfaces.includes(NAV_SURFACES.TOPNAV), `${id} saknas i toppmenyn`);
  }
  for (const id of ['factory', 'strategy-library', 'tests', 'paper']) {
    assert.ok(byId(id).surfaces.includes(NAV_SURFACES.MOBILE_BOTTOM), `${id} saknas i mobilens flikrad`);
  }
  for (const id of ['system', 'labs']) {
    assert.ok(byId(id).surfaces.includes(NAV_SURFACES.MOBILE_DRAWER), `${id} saknas i mobilens Mer-meny`);
  }
});

// ── aktiv-regeln ──────────────────────────────────────────────────────────────

test('rätt post lyser på varje flik, och bara en', () => {
  const cases = [
    ['/factory', '', 'factory'],
    ['/decision-journal', '', 'factory'],
    ['/overview', '', 'factory'],
    ['/factory/replay', '', 'tests'],
    ['/factory/library', '', 'strategy-library'],
    ['/factory/family-tree', '', 'strategy-library'],
    ['/factory/market-dna', '', 'strategy-library'],
    ['/futures-paper', '', 'paper'],
    ['/futures-paper', '?tab=positioner', 'paper'],
    ['/paper-futures', '', 'paper'],
    ['/live-scanner', '', 'paper'],
    ['/system', '', 'system'],
    ['/system', '?tab=health', 'system'],
    ['/interactive-brokers', '', 'system'],
    ['/lab', '', 'labs'],
    ['/lab', '?tab=replay', 'labs'],
    ['/replay', '', 'labs'],
    ['/batch', '', 'labs'],
    ['/ai', '', 'labs'],
    ['/pinescript', '', 'labs'],
    ['/narrow', '', 'labs'],
    ['/supervisor', '', 'labs'],
    ['/paper-trading', '', 'labs'],
  ];
  for (const [pathname, search, expected] of cases) {
    const active = navItemsFor(NAV_SURFACES.SIDEBAR)
      .filter((item) => isNavItemActive(item, pathname, search))
      .map((item) => item.id);
    assert.deepEqual(active, [expected], `${pathname}${search}`);
  }
});

// ── konfigurationens integritet ───────────────────────────────────────────────

test('varje post är komplett och unik', () => {
  const ids = new Set();
  const groupIds = new Set(NAV_GROUPS.map((group) => group.id));
  for (const item of NAV_ITEMS) {
    assert.ok(item.id && !ids.has(item.id), `dubblerat id: ${item.id}`);
    ids.add(item.id);
    assert.ok(item.label, `${item.id} saknar etikett`);
    assert.ok(item.path?.startsWith('/'), `${item.id} saknar sökväg`);
    assert.ok(groupIds.has(item.group), `${item.id} pekar på okänd grupp ${item.group}`);
    assert.ok(item.surfaces?.length, `${item.id} visas ingenstans`);
    for (const surface of item.surfaces) {
      assert.ok(Object.values(NAV_SURFACES).includes(surface), `${item.id}: okänd yta ${surface}`);
    }
    // En post med flikparameter måste ha flikparametern i sin sökväg.
    if (item.tab) assert.ok(item.path.includes(`tab=${item.tab}`), `${item.id}: flik och sökväg går isär`);
  }
});

test('sidomenyns grupper har innehåll och rätt ordning', () => {
  const groups = navGroupsFor(NAV_SURFACES.SIDEBAR);
  assert.deepEqual(groups.map((group) => group.id), ['product', 'operations', 'labs']);
  assert.deepEqual(
    groups.find((group) => group.id === 'product').items.map((item) => item.id),
    ['factory', 'strategy-library', 'tests', 'paper'],
  );
  assert.deepEqual(groups.find((group) => group.id === 'operations').items.map((item) => item.id), ['system']);
  assert.deepEqual(groups.find((group) => group.id === 'labs').items.map((item) => item.id), ['labs']);
  for (const group of groups) assert.ok(group.items.length > 0, `${group.id} är tom`);
});

test('mobilens flikrad rymmer fyra poster', () => {
  // Fler än så får inte plats bredvid Mer-knappen.
  assert.equal(navItemsFor(NAV_SURFACES.MOBILE_BOTTOM).length, 4);
});

// ── de tre renderarna läser samma källa ───────────────────────────────────────

test('sidomeny, toppmeny och mobil importerar den gemensamma menyn', () => {
  for (const file of RENDERERS) {
    const source = read(file);
    assert.match(source, /from '\.{1,2}(\/\.\.)*\/?navigation\.js'/, `${file} importerar inte navigation.js`);
    assert.match(source, /isNavItemActive/, `${file} använder inte den gemensamma aktiv-regeln`);
    assert.match(source, /navItemsFor|navGroupsFor/, `${file} hämtar inte sina poster ur den gemensamma listan`);
  }
});

test('ingen renderare har en egen menylista kvar', () => {
  for (const file of RENDERERS) {
    const source = read(file);
    // En lokal lista skulle behöva egna etiketter eller sökvägar i filen.
    assert.equal(/label: '/.test(source), false, `${file} deklarerar egna etiketter`);
    assert.equal(/to: '\//.test(source), false, `${file} deklarerar egna sökvägar`);
    assert.equal(/path: '\//.test(source), false, `${file} deklarerar egna sökvägar`);
    // Och ingen egen kopia av aktiv-regeln.
    assert.equal(/function isActive|function isTopLinkActive/.test(source), false, `${file} har en egen aktiv-regel`);
  }
});

test('varje meny renderar exakt de poster konfigurationen ger den', () => {
  // Renderarna får inte filtrera bort eller lägga till poster i JSX:en.
  const surfaceFor = { [SIDEBAR]: 'SIDEBAR', [TOPNAV]: 'TOPNAV' };
  for (const [file, surface] of Object.entries(surfaceFor)) {
    const source = read(file);
    assert.match(
      source,
      new RegExp(`nav(Items|Groups)For\\(NAV_SURFACES\\.${surface}\\)`),
      `${file} hämtar inte ytan ${surface}`,
    );
  }
  const mobile = read(MOBILE);
  for (const surface of ['MOBILE_BOTTOM', 'MOBILE_DRAWER']) {
    assert.match(mobile, new RegExp(`NAV_SURFACES\\.${surface}`), `mobilen saknar ytan ${surface}`);
  }
});

// ── bakåtkompatibilitet ───────────────────────────────────────────────────────

test('ingen tidigare URL har försvunnit', () => {
  // Varje sökväg som fanns innan navigationen byggdes om. Listan får växa,
  // aldrig krympa: en borttagen rad här är en död bokmärkning.
  const ROUTES_BEFORE = [
    '/', '/*', '/admin', '/ai', '/ai/:section', '/aktier', '/alerts',
    '/data-center', '/datacenter', '/daytrading', '/execution-safety', '/exit',
    '/exit-engine', '/futures-paper', '/halsa', '/health', '/historik',
    '/history', '/insikter', '/intelligence', '/intelligens',
    '/interactive-brokers', '/krypto', '/lab', '/larm', '/live', '/login',
    '/machine', '/micro-move', '/missed-breakouts', '/narrow', '/narrow-state',
    '/nasdaq', '/oversikt', '/overview', '/paper-futures', '/paper-trading',
    '/pine-script', '/pinescript', '/quality', '/replay', '/resultat',
    '/review-chart', '/risk', '/risk-engine', '/safety', '/sakerhet', '/scanner',
    '/setup-performance', '/setup-resultat', '/signaler', '/signalpuls',
    '/strategilabb', '/strategy-lab', '/supervisor', '/system', '/system-health',
    '/trading-lab', '/wave',
  ];
  const declared = new Set([...read('App.jsx').matchAll(/path="([^"]*)"/g)].map((m) => m[1]));
  for (const route of ROUTES_BEFORE) {
    assert.ok(declared.has(route), `URL ${route} har försvunnit ur App.jsx`);
  }
  for (const route of ['/replay', '/batch', '/live-scanner']) {
    assert.ok(declared.has(route), `${route} saknas`);
  }
});

test('varje menyval leder till en deklarerad route', () => {
  const declared = new Set([...read('App.jsx').matchAll(/path="([^"]*)"/g)].map((m) => m[1]));
  for (const item of NAV_ITEMS) {
    const routePath = item.path.split('?')[0];
    assert.ok(declared.has(routePath), `${item.id} pekar på ${routePath} som inte är en route`);
  }
});
