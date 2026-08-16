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

// Navigationen fanns i tre kopior som gled isär: Live Scanner, Replay och Batch
// lades till i sidomenyn medan dashboardens toppmeny — den enda som faktiskt
// syns på Futures-sidorna — stod kvar oförändrad. Testerna nedan låser dels att
// menyn har rätt innehåll, dels att de tre renderarna läser DENNA fil.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

const SIDEBAR = 'components/Sidebar.jsx';
const TOPNAV = 'components/dashboard/DashboardKit.jsx';
const MOBILE = 'MobileBottomNav.jsx';
const RENDERERS = [SIDEBAR, TOPNAV, MOBILE];

const byId = (id) => NAV_ITEMS.find((item) => item.id === id);

// ── de tre arbetsytorna ───────────────────────────────────────────────────────

test('Replay, Batch och Live Scanner pekar på sina befintliga vyer', () => {
  assert.equal(byId('replay').path, '/lab?tab=replay');
  assert.equal(byId('batch').path, '/lab?tab=batch');
  assert.equal(byId('live-scanner').path, '/futures-paper?tab=ordrar');
  // Etiketten Execution pekade på Live Scanner-innehåll och är borta.
  assert.equal(NAV_ITEMS.some((item) => item.label === 'Execution'), false);
});

test('de tre visas i sidomeny, toppmeny och mobil', () => {
  for (const id of ['replay', 'batch', 'live-scanner']) {
    const item = byId(id);
    assert.ok(item.surfaces.includes(NAV_SURFACES.SIDEBAR), `${id} saknas i sidomenyn`);
    assert.ok(item.surfaces.includes(NAV_SURFACES.TOPNAV), `${id} saknas i toppmenyn`);
    const onMobile = item.surfaces.includes(NAV_SURFACES.MOBILE_BOTTOM)
      || item.surfaces.includes(NAV_SURFACES.MOBILE_DRAWER);
    assert.ok(onMobile, `${id} saknas i mobilnavigationen`);
  }
});

// ── aktiv-regeln ──────────────────────────────────────────────────────────────

test('Labs är aktiv i Labs men inte på Replay eller Batch', () => {
  const labs = byId('labs');
  assert.equal(isNavItemActive(labs, '/lab', ''), true);
  assert.equal(isNavItemActive(labs, '/lab', '?tab=strategier'), true);
  assert.equal(isNavItemActive(labs, '/lab', '?tab=replay'), false);
  assert.equal(isNavItemActive(labs, '/lab', '?tab=batch'), false);
  // Labs gör inte längre anspråk på /replay.
  assert.equal(labs.match.includes('/replay'), false);
});

test('rätt post lyser på varje flik, och bara en', () => {
  const cases = [
    ['/lab', '?tab=replay', 'replay'],
    ['/lab', '?tab=batch', 'batch'],
    ['/lab', '', 'labs'],
    ['/futures-paper', '?tab=ordrar', 'live-scanner'],
    ['/futures-paper', '?tab=positioner', 'positioner'],
    ['/futures-paper', '', 'futures'],
    ['/supervisor', '', 'oversikt'],
  ];
  for (const [pathname, search, expected] of cases) {
    const active = navItemsFor(NAV_SURFACES.SIDEBAR)
      .filter((item) => isNavItemActive(item, pathname, search))
      .map((item) => item.id);
    assert.deepEqual(active, [expected], `${pathname}${search}`);
  }
});

test('Futures lyser inte när en underflik äger sidan', () => {
  const futures = byId('futures');
  assert.equal(isNavItemActive(futures, '/futures-paper', '?tab=ordrar'), false);
  assert.equal(isNavItemActive(futures, '/futures-paper', '?tab=positioner'), false);
  assert.equal(isNavItemActive(futures, '/paper-futures', ''), true);
});

test('en flikpost kräver både rätt sida och rätt flik', () => {
  const replay = byId('replay');
  assert.equal(isNavItemActive(replay, '/lab', '?tab=replay'), true);
  assert.equal(isNavItemActive(replay, '/lab', '?tab=batch'), false);
  assert.equal(isNavItemActive(replay, '/insikter', '?tab=replay'), false);
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
  assert.deepEqual(groups.map((group) => group.id), ['mini-futures', 'research', 'system', 'labs']);
  assert.deepEqual(
    groups.find((group) => group.id === 'research').items.map((item) => item.id),
    ['replay', 'batch'],
  );
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
