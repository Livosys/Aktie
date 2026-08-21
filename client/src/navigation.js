// ── Huvudnavigation: en enda källa ────────────────────────────────────────────
// Sidomenyn, dashboardens toppmeny och mobilnavigationen renderade tidigare var
// sin egen kopia av samma meny. Kopiorna gled isär: ett menyval kunde bytas i en
// av dem och stå kvar oförändrat i de andra, utan att något test märkte det.
//
// Här bor menyn i stället en gång. Komponenterna väljer bara VILKA ytor de ritar
// och HUR de ser ut — aldrig vilka menyval som finns eller vart de pekar.
//
// Ren data och rena funktioner: ingen React, ingen router, inget nätverk.

import { FACTORY_TERM_KEYS, uiName } from './services/uiTerminologyService.js';

// Ytorna en post kan visas på.
export const NAV_SURFACES = Object.freeze({
  SIDEBAR: 'sidebar',            // vänstermenyn (AppShell)
  TOPNAV: 'topnav',              // horisontella menyn i DashboardShell
  MOBILE_BOTTOM: 'mobileBottom', // de fasta flikarna längst ned
  MOBILE_DRAWER: 'mobileDrawer', // lådan bakom "Mer"
});

// Grupper används av sidomenyn. Ordningen här är ordningen på skärmen.
export const NAV_GROUPS = Object.freeze([
  { id: 'product', label: 'Version 1.0' },
  { id: 'operations', label: 'Drift' },
  { id: 'labs', label: 'Utvecklingsyta' },
]);

const S = NAV_SURFACES;

// Varje post: id, etikett, sökväg, ikonbokstav, accentfärg, grupp, vilka
// sökvägar som räknas som "den här sidan", ev. flikparameter, ev. flikar som
// INTE ska markera posten, och vilka ytor posten visas på.
export const NAV_ITEMS = Object.freeze([
  {
    id: 'factory',
    label: uiName(FACTORY_TERM_KEYS.FACTORY_STATUS),
    path: '/factory',
    icon: '🏭',
    accent: 'teal',
    group: 'product',
    // /factory/loop hör till samma produktområde och får därför INGEN egen
    // menypost — V1-menyn har en huvudväg per område. Den räknas som "den här
    // sidan" så att menyn markerar rätt när man är där.
    match: ['/', '/factory', '/factory/loop', '/decision-journal', '/overview', '/oversikt'],
    exact: true,
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    id: 'strategy-library',
    label: uiName(FACTORY_TERM_KEYS.STRATEGY_LIBRARY),
    path: '/factory/library',
    icon: '📚',
    accent: 'blue',
    group: 'product',
    match: ['/factory/library', '/factory/family-tree', '/factory/market-dna'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    id: 'tests',
    label: 'Tester',
    path: '/factory/replay',
    icon: '🧪',
    accent: 'purple',
    group: 'product',
    match: ['/factory/replay'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    id: 'paper',
    label: 'Handelstest',
    path: '/futures-paper',
    icon: '📈',
    accent: 'teal',
    group: 'product',
    match: ['/futures-paper', '/paper-futures', '/live', '/live-scanner'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    id: 'system',
    label: 'System',
    path: '/system',
    icon: '⚙️',
    accent: 'blue',
    group: 'operations',
    match: ['/system', '/system-health', '/health', '/halsa', '/alerts', '/larm', '/sakerhet', '/risk', '/risk-engine', '/safety', '/execution-safety', '/interactive-brokers'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_DRAWER],
  },
  {
    // Kvar i Labs: gamla översikter, manuell replay/batch, research, AI Research,
    // PineScript, Narrow Lab och övriga experimentella verktyg. Routes finns kvar
    // för bokmärken, men V1-produktmenyn har bara en Labs-ingång.
    id: 'labs',
    label: 'Labs',
    path: '/lab',
    icon: '🧪',
    accent: 'teal',
    group: 'labs',
    match: ['/lab', '/trading-lab', '/strategy-lab', '/strategilabb', '/review-chart', '/machine', '/intelligence', '/intelligens', '/missed-breakouts', '/micro-move', '/wave', '/exit-engine', '/exit', '/pinescript', '/pine-script', '/ai', '/narrow', '/narrow-state', '/supervisor', '/signalpuls', '/scanner', '/signaler', '/insikter', '/resultat', '/history', '/historik', '/data-center', '/datacenter', '/setup-performance', '/setup-resultat', '/daytrading', '/paper-trading', '/replay', '/batch', '/quality'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_DRAWER],
  },
]);

// Den enda definitionen av "den här posten är aktiv". Alla tre menyerna använder
// den, så en post kan inte lysa i en meny och vara släckt i en annan.
export function isNavItemActive(item, pathname, search = '') {
  if (!item) return false;
  const tab = new URLSearchParams(search).get('tab');
  const paths = (item.match || [item.path]).map((path) => path.split('?')[0]);

  // Poster som pekar på en flik kräver att både sidan och fliken stämmer.
  if (item.tab) {
    return paths.some((path) => pathname === path) && tab === item.tab;
  }

  const matched = item.exact
    ? paths.some((path) => pathname === path)
    : paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  if (!matched) return false;
  // En sida vars flik ägs av en annan post ska inte markera den här.
  if (item.excludeTabs?.includes(tab)) return false;
  return true;
}

export function navItemsFor(surface) {
  return NAV_ITEMS.filter((item) => item.surfaces.includes(surface));
}

// Sidomenyns grupper, tomma grupper bortsorterade.
export function navGroupsFor(surface) {
  return NAV_GROUPS
    .map((group) => ({
      ...group,
      items: navItemsFor(surface).filter((item) => item.group === group.id),
    }))
    .filter((group) => group.items.length > 0);
}
