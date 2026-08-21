import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'aiStoryService.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(here, '../pages/FactoryDashboardPage.jsx'), 'utf8');
const journalSource = fs.readFileSync(path.join(here, '../pages/AiDecisionJournalPage.jsx'), 'utf8');
const explorerSource = fs.readFileSync(path.join(here, '../pages/FactoryExplorerPage.jsx'), 'utf8');
const paperSource = fs.readFileSync(path.join(here, '../pages/FuturesPaperDeskPage.jsx'), 'utf8');
const systemSource = fs.readFileSync(path.join(here, '../pages/SystemPage.jsx'), 'utf8');

test('AI story service is read-only and centralized across the product', () => {
  assert.match(source, /export function aiStoryWaiting/);
  assert.match(source, /export function aiStorySystemStatus/);
  assert.match(source, /export function aiStoryPaperStatus/);
  assert.match(source, /export function aiStoryFactoryActivity/);
  assert.equal(/fetch\s*\(/.test(source), false, 'story service must not call fetch');
  assert.equal(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test(source), false, 'story service must not mutate data');

  for (const pageSource of [dashboardSource, journalSource, explorerSource, paperSource, systemSource]) {
    assert.match(pageSource, /aiStoryService/, 'page does not import the shared story service');
  }
});
