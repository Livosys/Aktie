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
  'Brokerpositioner',
  'Ordrar',
  'Fills & trades',
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
  'Reconciliation status',
  'source=ibkr_paper',
  'source=internal_legacy_simulation',
  'Äldre interna simuleringar',
]) {
  assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

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
