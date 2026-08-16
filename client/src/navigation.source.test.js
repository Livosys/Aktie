'use strict';

// Navigationen är det enda stället där en vy kan sluta existera för en användare
// utan att en enda rad funktionalitet ändras. Testet läser källan som text och
// låser två saker: att Replay, Batch och Live Scanner är egna menyval, och att
// ingen tidigare URL har försvunnit.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const app = read('App.jsx');
const sidebar = read('components/Sidebar.jsx');
const mobile = read('MobileBottomNav.jsx');

// ---------------------------------------------- bakåtkompatibilitet
// Varje sökväg som fanns innan Replay/Batch/Live Scanner blev egna menyval.
// Listan får växa, aldrig krympa: en borttagen rad här är en död bokmärkning.
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

const declaredRoutes = new Set(
  [...app.matchAll(/path="([^"]*)"/g)].map((match) => match[1]),
);

for (const route of ROUTES_BEFORE) {
  assert.ok(declaredRoutes.has(route), `URL ${route} har försvunnit ur App.jsx`);
}

// De tre arbetsytorna har egna adresser. /replay fanns redan.
for (const route of ['/replay', '/batch', '/live-scanner']) {
  assert.ok(declaredRoutes.has(route), `${route} saknas`);
}

// ---------------------------------------------- sidomenyn
for (const [label, target] of [
  ['Replay', '/lab?tab=replay'],
  ['Batch', '/lab?tab=batch'],
  ['Live Scanner', '/futures-paper?tab=ordrar'],
]) {
  const row = sidebar
    .split('\n')
    .find((line) => line.includes(`label: '${label}'`) && line.includes('path:'));
  assert.ok(row, `sidomenyn saknar menyvalet ${label}`);
  assert.ok(
    row.includes(`path: '${target}'`),
    `${label} ska peka på den befintliga vyn ${target}, inte på en ny route`,
  );
}

// Live Scanner ersätter den gamla etiketten Execution, som pekade på samma flik.
assert.ok(!/label: 'Execution'/.test(sidebar), 'Execution-etiketten ska vara borta');

// ---------------------------------------------- Labs får inte kapa dem
{
  const labsRow = sidebar
    .split('\n')
    .find((line) => line.includes("label: 'Labs'") && line.includes('path:'));
  assert.ok(labsRow, 'Labs-posten saknas');
  assert.ok(
    !labsRow.includes("'/replay'"),
    'Labs ska inte längre göra anspråk på /replay',
  );
  assert.match(
    labsRow,
    /excludeTabs: \['replay', 'batch'\]/,
    'Labs ska inte markeras som aktiv när Replay eller Batch är öppen',
  );
}

// ---------------------------------------------- mobilen visar samma tre
for (const label of ['Replay', 'Batch', 'Live Scanner']) {
  assert.ok(
    mobile.includes(`label: '${label}'`),
    `mobilnavigationen saknar ${label}`,
  );
}
assert.ok(!/label: 'Batch Lab'/.test(mobile) && !/label: 'Replay Lab'/.test(mobile),
  'mobilen ska använda samma namn som sidomenyn');

console.log('navigation.source.test.js passed');
