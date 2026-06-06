'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-analyst-'));
process.env.AI_ANALYST_DIR = tmp;
process.env.AI_ANALYST_PROVIDER = 'disabled';
delete process.env.AI_ANALYST_API_KEY;

const svc = require('./aiAnalystService');

(async () => {
  // 1. latest works when no analysis exists.
  const empty = svc.getLatestAnalysis();
  assert.equal(empty.ok, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.mode, 'paper_only');
  assert.equal(empty.actions_allowed, false);
  assert.equal(empty.can_place_orders, false);
  assert.equal(empty.live_trading_enabled, false);
  assert.equal(empty.broker_enabled, false);

  // 2. sanitizeContext removes dangerous and secrets-like fields.
  const clean = svc.sanitizeContext({
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
    apiKey: 'secret-value',
    env: { AI_API_KEY: 'secret-value' },
    server_path: '/var/www/nasdaq-scanner',
    blocks: {
      learning: {
        status: 'ok',
        source: 'x',
        summary: { winRate: 50, password: 'secret-value' },
      },
    },
    recentTests: [{ symbol: 'MSFT', raw_log: 'hidden', dryRun: true }],
    risks: [{ code: 'paper_only', message_sv: 'safe' }],
  });
  const serialized = JSON.stringify(clean);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(serialized.includes('/var/www'), false);
  assert.equal(clean.safety.mode, 'paper_only');
  assert.equal(clean.safety.actions_allowed, false);

  // 3. JSON fallback works when AI returns non-JSON.
  const fallback = svc.parseAnalystJson('Det här är inte JSON men ska bli säkert.');
  assert.equal(fallback.safety.mode, 'paper_only');
  assert.equal(fallback.actions_allowed, undefined);
  assert.ok(fallback.summary.includes('Det här är inte JSON'));
  assert.ok(Array.isArray(fallback.what_ai_learned));

  // 4. Disabled provider gives safe disabled response and writes latest/event.
  const disabled = await svc.runAnalyst({ force: true, overview: { blocks: {}, risks: [] } });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.provider, 'disabled');
  assert.equal(disabled.mode, 'paper_only');
  assert.equal(disabled.actions_allowed, false);
  assert.equal(disabled.can_place_orders, false);
  assert.equal(disabled.live_trading_enabled, false);
  assert.equal(disabled.broker_enabled, false);
  assert.equal(disabled.output.safety.mode, 'paper_only');
  assert.equal(disabled.output.safety.can_place_orders, false);

  const latest = svc.getLatestAnalysis();
  assert.equal(latest.ok, true);
  assert.equal(latest.status, 'disabled');
  assert.equal(latest.latest.provider, 'disabled');
  assert.ok(fs.existsSync(path.join(tmp, 'latest.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'analyst-events.jsonl')));
  const eventLines = fs.readFileSync(path.join(tmp, 'analyst-events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(eventLines.length >= 1);
  const event = JSON.parse(eventLines[eventLines.length - 1]);
  assert.equal(event.eventType, 'analyst.run.disabled');
  assert.equal(event.cacheHit, false);
  assert.equal(event.disabled, true);
  assert.equal(event.status, 'disabled');
  assert.equal(event.can_place_orders, false);
  assert.ok(event.outputSummary && typeof event.outputSummary === 'object');
  assert.equal(JSON.stringify(event).includes('secret-value'), false);

  // 5. Status is safe and reports provider without exposing keys.
  const status = svc.getStatus();
  assert.equal(status.provider, 'disabled');
  assert.equal(status.enabled, false);
  assert.equal(status.cacheEnabled, true);
  assert.equal(status.cacheTtlMs, 300000);
  assert.equal(status.latestExists, true);
  assert.equal(status.latestStatus, 'disabled');
  assert.equal(status.latestProvider, 'disabled');
  assert.equal(typeof status.latestDurationMs, 'number');
  assert.equal(status.logPathExists, true);
  assert.ok(status.logEventCount >= 1);
  assert.equal(status.broker_enabled, false);
  assert.equal(JSON.stringify(status).includes('secret-value'), false);

  // 6. Log/write failures are fault-isolated; run still returns safe response.
  const badDir = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(badDir, 'file, not directory', 'utf8');
  process.env.AI_ANALYST_DIR = badDir;
  const noCrash = await svc.runAnalyst({ force: true, overview: { blocks: {}, risks: [] } });
  assert.equal(noCrash.ok, true);
  assert.equal(noCrash.status, 'disabled');
  assert.equal(noCrash.mode, 'paper_only');
  assert.equal(noCrash.can_place_orders, false);
  process.env.AI_ANALYST_DIR = tmp;

  console.log('# aiAnalystService tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
