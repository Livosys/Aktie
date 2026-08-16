'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'FuturesPaperDeskPage.jsx'), 'utf8');

assert.match(source, /Futures Paper använder IBKR Paper Trading som enda execution-miljö/);
assert.match(source, /faktisk ordersändning är avstängd/);
assert.match(source, /Livekonton och riktiga pengar är blockerade/);

for (const label of [
  'Översikt',
  'IBKR Paper-konto',
  // Positioner är en live trading desk; broker mirror-tabellen heter fortfarande
  // Brokerpositioner men ligger numera under Runtime.
  'Positioner',
  'Brokerpositioner',
  // En sida, ett ansvar — flikarna heter efter vad de faktiskt visar.
  'Broker Orders',
  'Executions',
  'Runtime',
  'IBKR Paper Execution',
  'Godkännande',
  'Teknisk info',
  'Historiskt sim-arkiv',
]) {
  assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

for (const required of [
  'Net Liquidation',
  'Available Funds',
  'Buying Power',
  'Unrealized PnL',
  'Realized PnL',
  'Daily broker PnL',
  'Open broker positions',
  'Open broker orders',
  'brokerOrderIntents',
  'orderLifecycleRows',
  'mergeOrderLifecycleRows',
  'Reconciliation status',
  'brokerMirrorSourceText',
  'source=internal_legacy_simulation',
  'Äldre interna simuleringar',
  // Steg 3: Positioner är en live trading desk byggd på befintlig snapshot.
  'PositionDeskPanel',
  'buildPositionDeskRows',
  'summarizePositionDesk',
  'positionDeskRows',
  'positionDeskSummary',
  'Broker mirror · source=',
]) {
  assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

// Positioner får inte återfå brokerdiagnostiken: positionskorten, den råa
// mirror-tabellen och kontopanelerna ligger på Runtime respektive IBKR Paper-konto.
for (const movedOffPositions of [
  'Live Position System',
  'PositionCard',
  'stablePositionKey',
]) {
  assert.doesNotMatch(source, new RegExp(movedOffPositions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

// Ingen ny datakälla: sidan hämtar fortfarande bara runtime och execution status.
const fetchedUrls = [...source.matchAll(/useJson\('([^']+)'/g)].map((match) => match[1]);
assert.deepEqual(fetchedUrls, [
  '/api/futures-paper/runtime',
  '/api/futures-paper/ibkr-paper-execution/status?connect=false',
]);

for (const retiredActiveSurface of [
  '/api/futures-paper/account/reset',
  '/api/futures-paper/account/set-balance',
  '/api/futures-paper/manual/open',
  '/api/futures-paper/manual/close',
  '/api/futures-paper/candidates/simulate',
  '/api/futures-paper/simulation/tick',
  '/api/futures-paper/auto-simulation',
  'Sim-equity',
  'Sim-PnL',
  'falskt kapital',
  'återställ simulerat konto',
]) {
  assert.doesNotMatch(source, new RegExp(retiredActiveSurface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

console.log('FuturesPaperDeskPage.source.test.js passed');
