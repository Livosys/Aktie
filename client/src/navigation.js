// ── Huvudnavigation: en enda källa ────────────────────────────────────────────
// Sidomenyn, dashboardens toppmeny och mobilnavigationen renderade tidigare var
// sin egen kopia av samma meny. Kopiorna gled isär: ett menyval kunde bytas i en
// av dem och stå kvar oförändrat i de andra, utan att något test märkte det.
//
// Här bor menyn i stället en gång. Komponenterna väljer bara VILKA ytor de ritar
// och HUR de ser ut — aldrig vilka menyval som finns eller vart de pekar.
//
// Ren data och rena funktioner: ingen React, ingen router, inget nätverk.

// Ytorna en post kan visas på.
export const NAV_SURFACES = Object.freeze({
  SIDEBAR: 'sidebar',            // vänstermenyn (AppShell)
  TOPNAV: 'topnav',              // horisontella menyn i DashboardShell
  MOBILE_BOTTOM: 'mobileBottom', // de fasta flikarna längst ned
  MOBILE_DRAWER: 'mobileDrawer', // lådan bakom "Mer"
});

// Grupper används av sidomenyn. Ordningen här är ordningen på skärmen.
export const NAV_GROUPS = Object.freeze([
  { id: 'mini-futures', label: 'Mini Futures' },
  { id: 'research', label: 'Forskning' },
  { id: 'system', label: 'Operativt' },
  { id: 'labs', label: 'Labs' },
]);

const S = NAV_SURFACES;

// Varje post: id, etikett, sökväg, ikonbokstav, accentfärg, grupp, vilka
// sökvägar som räknas som "den här sidan", ev. flikparameter, ev. flikar som
// INTE ska markera posten, och vilka ytor posten visas på.
export const NAV_ITEMS = Object.freeze([
  {
    id: 'oversikt',
    label: 'Översikt',
    path: '/supervisor',
    icon: 'O',
    accent: 'blue',
    group: 'mini-futures',
    match: ['/', '/supervisor', '/overview', '/oversikt'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    id: 'futures',
    label: 'Futures',
    path: '/futures-paper',
    icon: 'F',
    accent: 'teal',
    group: 'mini-futures',
    match: ['/futures-paper', '/paper-futures'],
    excludeTabs: ['positioner', 'ordrar'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    id: 'positioner',
    label: 'Positioner',
    path: '/futures-paper?tab=positioner',
    icon: 'P',
    accent: 'green',
    group: 'mini-futures',
    match: ['/futures-paper'],
    tab: 'positioner',
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    // Flik-id:t heter 'ordrar' av bakåtkompatibilitetsskäl men innehållet är
    // Live Scanner. Etiketten följer innehållet; sökvägen är oförändrad.
    id: 'live-scanner',
    label: 'Live Scanner',
    path: '/futures-paper?tab=ordrar',
    icon: 'L',
    accent: 'orange',
    group: 'mini-futures',
    match: ['/futures-paper'],
    tab: 'ordrar',
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_BOTTOM],
  },
  {
    // Replay och Batch är egna arbetsytor, inte laborationer. De bor kvar på
    // /lab?tab=... så att varje befintlig länk och omdirigering fungerar — det
    // är bara navigationen som slutat gömma dem bakom Labs.
    id: 'replay',
    label: 'Replay',
    path: '/lab?tab=replay',
    icon: 'R',
    accent: 'purple',
    group: 'research',
    match: ['/lab'],
    tab: 'replay',
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_DRAWER],
  },
  {
    id: 'batch',
    label: 'Batch',
    path: '/lab?tab=batch',
    icon: 'B',
    accent: 'teal',
    group: 'research',
    match: ['/lab'],
    tab: 'batch',
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_DRAWER],
  },
  {
    id: 'historik',
    label: 'Historik',
    path: '/insikter',
    icon: 'H',
    accent: 'purple',
    group: 'system',
    match: ['/insikter', '/resultat', '/history', '/historik', '/data-center', '/datacenter', '/setup-performance', '/setup-resultat'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_DRAWER],
  },
  {
    id: 'system',
    label: 'System',
    path: '/system',
    icon: 'S',
    accent: 'blue',
    group: 'system',
    match: ['/system', '/system-health', '/health', '/halsa', '/alerts', '/larm', '/sakerhet', '/risk', '/risk-engine', '/safety', '/execution-safety'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_DRAWER],
  },
  {
    // Kvar i Labs: strategier, review, kandidater, learning, marknader, sliders,
    // exits, AI-agent och beslutsråd — det experimentella. Labs gör inte anspråk
    // på /replay och markeras inte som aktiv på replay- eller batch-fliken.
    id: 'labs',
    label: 'Labs',
    path: '/lab',
    icon: 'X',
    accent: 'teal',
    group: 'labs',
    match: ['/lab', '/trading-lab', '/strategy-lab', '/strategilabb', '/review-chart', '/machine', '/intelligence', '/intelligens', '/missed-breakouts', '/micro-move', '/wave', '/exit-engine', '/exit', '/pinescript', '/pine-script', '/ai', '/narrow', '/narrow-state'],
    excludeTabs: ['replay', 'batch'],
    surfaces: [S.SIDEBAR, S.TOPNAV, S.MOBILE_DRAWER],
  },
  // Enbart i mobillådan sedan tidigare. De ligger här för att lådan ska ritas
  // ur samma lista som allt annat, inte för att de bytt plats.
  {
    id: 'pinescript',
    label: 'PineScript',
    path: '/pinescript',
    icon: 'P',
    accent: 'teal',
    group: 'labs',
    match: ['/pinescript', '/pine-script'],
    surfaces: [S.MOBILE_DRAWER],
  },
  {
    id: 'ai',
    label: 'AI Research',
    path: '/ai',
    icon: 'A',
    accent: 'purple',
    group: 'labs',
    match: ['/ai'],
    surfaces: [S.MOBILE_DRAWER],
  },
  {
    id: 'narrow',
    label: 'Narrow Lab',
    path: '/narrow',
    icon: 'N',
    accent: 'teal',
    group: 'labs',
    match: ['/narrow', '/narrow-state'],
    surfaces: [S.MOBILE_DRAWER],
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

  const matched = paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
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
