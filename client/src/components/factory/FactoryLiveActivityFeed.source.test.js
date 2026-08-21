import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'FactoryLiveActivityFeed.jsx'), 'utf8');

test('FactoryLiveActivityFeed is a shared frontend-only live feed', () => {
  for (const term of [
    'OverviewPanel',
    'StatusBadge',
    'Link',
    'aiStoryEventText',
    'uiFactorySafeText',
    'FILTERS',
    'formatRelativeTime',
    'groupItems',
    'categoryFor',
  ]) {
    assert.match(source, new RegExp(term), `${term} saknas`);
  }

  for (const filter of ['Alla', 'AI', 'Tester', 'Strategier', 'Paper Trading']) {
    assert.match(source, new RegExp(filter), `${filter} saknas`);
  }

  for (const marker of [
    'data-factory-live-activity-feed',
    'data-factory-live-activity-item',
    'role="tablist"',
    'aria-pressed',
    'Senaste händelsen',
  ]) {
    assert.match(source, new RegExp(marker), `${marker} saknas`);
  }

  assert.equal(/fetch\s*\(/.test(source), false, 'feeden får inte göra egna API-anrop');
  assert.equal(/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/.test(source), false, 'feeden får inte mutera data');
});
