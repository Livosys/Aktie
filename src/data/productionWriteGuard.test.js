'use strict';

// ── Sandlådeskyddet ──────────────────────────────────────────────────────────
//
// De permanenta minnena är append-only. En rad som lagts till kan inte tas bort
// utan att historiken förfalskas, vilket gör en verifieringskörning farlig på
// ett sätt som inte syns: elva genom hamnade i driftens släktträd den 20
// augusti 2026 därför att frågan "vad skulle evolutionen föreslå?" bara gick
// att ställa genom att faktiskt köra den.
//
// Skyddet har två lager, och testerna nedan låser bägge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('./productionWriteGuard');
const { createEventLog } = require('./eventLog');

function withSandbox(t, value = '1') {
  const previous = process.env[guard.SANDBOX_ENV];
  process.env[guard.SANDBOX_ENV] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[guard.SANDBOX_ENV];
    else process.env[guard.SANDBOX_ENV] = previous;
  });
}

function tempFile(t, name = 'log.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-guard-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* städat nog */ } });
  return path.join(dir, name);
}

const PRODUCTION_FILE = path.join(guard.PRODUCTION_DATA_DIR, 'ai-memory', 'lineage.jsonl');

// ── vad som räknas som driftens data ────────────────────────────────────────

test('filer under datakatalogen är produktionsdata', () => {
  assert.equal(guard.isProductionPath(PRODUCTION_FILE), true);
  assert.equal(guard.isProductionPath(path.join(guard.PRODUCTION_DATA_DIR, 'vad-som-helst.jsonl')), true);
  assert.equal(guard.isProductionPath('/tmp/nagon-annanstans.jsonl'), false);
  assert.equal(guard.isProductionPath(null), false);
});

test('en katalog som bara BÖRJAR som datakatalogen räknas inte', () => {
  // data-sandbox/ är inte data/. Utan sep-kontrollen hade den blockerats.
  assert.equal(guard.isProductionPath(`${guard.PRODUCTION_DATA_DIR}-sandbox/fil.jsonl`), false);
});

// ── lager 1: avstängt som standard ──────────────────────────────────────────

test('utan sandlådeläge blockeras ingenting', () => {
  assert.equal(guard.sandboxEnabled(), false);
  assert.doesNotThrow(() => guard.assertWritable(PRODUCTION_FILE, 'test'));
});

test('flaggan läses vid varje anrop, inte vid inläsning', (t) => {
  assert.equal(guard.sandboxEnabled(), false);
  withSandbox(t);
  assert.equal(guard.sandboxEnabled(), true);
});

test('bara sanna värden slår på skyddet', (t) => {
  withSandbox(t, 'off');
  assert.equal(guard.sandboxEnabled(), false);
});

// ── lager 2: sandlådan får inte skriva i driften ────────────────────────────

test('en sandlåda som skriver i driften smäller', (t) => {
  withSandbox(t);
  assert.throws(() => guard.assertWritable(PRODUCTION_FILE, 'strategy_family_tree'),
    /strategy_family_tree_blocked_by_sandbox/);
});

test('en sandlåda får skriva utanför driften', (t) => {
  withSandbox(t);
  assert.doesNotThrow(() => guard.assertWritable('/tmp/egen-logg.jsonl', 'test'));
});

test('den delade händelseloggen vägrar skriva i driften från en sandlåda', (t) => {
  withSandbox(t);
  const log = createEventLog({ file: PRODUCTION_FILE, keyField: 'id', eventTypes: ['X'], label: 'test_log' });
  assert.throws(() => log.append('a', 'X', {}), /test_log_blocked_by_sandbox/);
});

test('samma logg skriver som vanligt mot en egen fil', (t) => {
  withSandbox(t);
  const file = tempFile(t);
  const log = createEventLog({ file, keyField: 'id', eventTypes: ['X'], label: 'test_log' });
  assert.doesNotThrow(() => log.append('a', 'X', {}));
  assert.equal(log.read().length, 1);
});

// ── en fullständig omdirigering ─────────────────────────────────────────────

test('sandboxEnv flyttar ALLA tre permanenta minnen', () => {
  const env = guard.sandboxEnv('/tmp/sandlada');
  assert.equal(env[guard.SANDBOX_ENV], '1');
  for (const key of ['STRATEGY_LIBRARY_EVENTS_FILE', 'AI_MEMORY_EVENTS_FILE', 'STRATEGY_FAMILY_TREE_FILE']) {
    assert.ok(env[key], `${key} saknas`);
    // Flyttas bara två skriver den tredje i driften — exakt det som hände när
    // biblioteket och trädet var omdirigerade men AI Memory inte var det.
    assert.equal(guard.isProductionPath(env[key]), false, `${key} pekar fortfarande i driften`);
  }
});

test('omdirigeringen speglar driftens egen layout', () => {
  const env = guard.sandboxEnv('/tmp/sandlada');
  // Släktträdet ligger bredvid AI Memory i driften, inte i en egen katalog.
  assert.match(env.STRATEGY_FAMILY_TREE_FILE, /ai-memory[/\\]lineage\.jsonl$/);
});
