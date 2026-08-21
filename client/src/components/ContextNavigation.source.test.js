import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiCopy } from '../services/uiTerminologyService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(here, 'ContextNavigation.jsx'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');

const pageSources = Object.fromEntries([
  ['FactoryDashboardPage', 'pages/FactoryDashboardPage.jsx'],
  ['AiDecisionJournalPage', 'pages/AiDecisionJournalPage.jsx'],
  ['FactoryExplorerPage', 'pages/FactoryExplorerPage.jsx'],
  ['FuturesPaperDeskPage', 'pages/FuturesPaperDeskPage.jsx'],
  ['SystemPage', 'pages/SystemPage.jsx'],
].map(([name, file]) => [name, fs.readFileSync(path.join(root, file), 'utf8')]));

test('context navigation is a shared read-only frontend component', () => {
  assert.match(source, /data-context-navigation/, 'komponenten saknar stabil markör');
  assert.match(source, /export function contextHref/, 'komponenten saknar href-byggare');
  assert.match(source, /export function contextAction/, 'komponenten saknar action-byggare');
  assert.match(source, /<Link/, 'komponenten använder inte vanliga produktlänkar');
  assert.match(source, /uiCopy\('contextNavigation'\)/, 'komponenten hämtar inte copy från terminologitjänsten');
  assert.equal(/fetch\(|\/api\//.test(source), false, 'context navigation får inte hämta API-data');
  assert.equal(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test(source), false, 'context navigation får inte mutera');
});

test('context navigation uses only existing product routes', () => {
  for (const route of ['/factory', '/factory/replay', '/factory/library', '/decision-journal', '/futures-paper', '/factory/market-dna']) {
    assert.match(source, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${route} saknas i context navigation`);
    assert.match(appSource, new RegExp(`path="${route.replace(/\//g, '\\/')}"`), `${route} saknas i App-rutter`);
  }
  assert.match(appSource, /path="\/factory\/family-tree"/, 'strategiträdets befintliga route saknas');
});

test('context navigation is wired into all V1 workflow surfaces', () => {
  for (const [name, pageSource] of Object.entries(pageSources)) {
    assert.match(pageSource, /ContextNavigation/, `${name} använder inte ContextNavigation`);
  }
  assert.match(pageSources.FactoryDashboardPage, /contextActions:\s*buildDashboardContextActions/, 'AI Fabriken bygger inte kontextlänkar från befintlig data');
  assert.match(pageSources.FactoryExplorerPage, /selectedIdFromSearch/, 'test- och strategivyer kan inte öppnas från URL-kontext');
  assert.match(pageSources.AiDecisionJournalPage, /selectedIdFromSearch/, 'beslutsjournalen kan inte öppnas från URL-kontext');
  assert.match(pageSources.FuturesPaperDeskPage, /paperContextActions/, 'Paper Trading saknar kontextlänkar');
});

test('context navigation labels come from shared Swedish product terminology', () => {
  const copy = uiCopy('contextNavigation');
  for (const label of [
    'Tillbaka till AI Fabriken',
    'Visa arbetsflöde',
    'Öppna strategi',
    'Visa test',
    'Visa beslut',
    'Öppna Paper Trading',
    'Granska godkännande',
    'Granska resultat',
  ]) {
    assert.match(JSON.stringify(copy), new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${label} saknas i gemensam terminologi`);
  }
});

test('context navigation does not expose internal backend names in labels', () => {
  const copy = uiCopy('contextNavigation');
  const forbidden = /ReplayQueue|ReplayRun|ReplaySession|FactoryDirector|StrategyRuntime|AIOptimizer|EvolutionEngine|ExperimentRegistry|candidateDnaHash|libraryRunId|dnaHash/;
  assert.equal(forbidden.test(JSON.stringify(copy)), false, 'context navigation läcker interna namn');
});
