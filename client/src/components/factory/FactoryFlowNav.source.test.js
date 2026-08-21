import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FACTORY_FLOW_STEP_KEYS,
  uiFactoryFlowNavigation,
} from '../../services/uiTerminologyService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const source = fs.readFileSync(path.join(here, 'FactoryFlowNav.jsx'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');

test('factory flow navigation uses shared terminology and router links', () => {
  assert.match(source, /uiFactoryFlowNavigation/, 'navigationen hämtar inte text från terminologitjänsten');
  assert.match(source, /<Link/, 'navigationen använder inte routerlänkar');
  assert.match(source, /StatusBadge/, 'aktiv sida markeras inte med befintlig statuskomponent');
  assert.match(source, /aria-current=\{active \? 'page' : undefined\}/, 'aktiv länk saknar sidmarkering');
});

test('factory flow navigation exposes the compact V1 factory shortcuts', () => {
  const flow = uiFactoryFlowNavigation();
  const expected = [
    [FACTORY_FLOW_STEP_KEYS.DASHBOARD, '/factory'],
    [FACTORY_FLOW_STEP_KEYS.REPLAY, '/factory/replay'],
    [FACTORY_FLOW_STEP_KEYS.LIBRARY, '/factory/library'],
    [FACTORY_FLOW_STEP_KEYS.JOURNAL, '/decision-journal'],
  ];

  assert.deepEqual(flow.order, expected.map(([key]) => key));
  for (const [key, route] of expected) {
    assert.equal(flow.items[key].path, route, `${key} har fel sökväg`);
    assert.match(source, /to=\{item\.path\}/, `${key} renderas inte som länk`);
    assert.match(appSource, new RegExp(`path="${route.replace(/\//g, '\\/')}"`), `${route} saknas i App-rutter`);
  }
});

test('factory flow navigation visible text hides internal names', () => {
  const forbidden = /StrategyBrain|ReplayQueue|EvolutionEngine|MarketDNA|AIOptimizer|FactoryDirector|Runtime|ExperimentRegistry|Strategy Brain|Replay Queue|Evolution Engine|Market DNA|AI Optimizer|Factory Director|Experiment Registry/;
  assert.equal(forbidden.test(JSON.stringify(uiFactoryFlowNavigation())), false);
});
