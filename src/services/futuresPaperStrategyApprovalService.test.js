'use strict';

// `node src/services/futuresPaperStrategyApprovalService.test.js`
// Temporär store-fil → live-data rörs aldrig.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'futures-approval-test-'));
const TMP_STORE = path.join(TMP_DIR, 'strategy-approvals.json');
process.env.FUTURES_PAPER_STRATEGY_APPROVALS_FILE = TMP_STORE;

const service = require('./futuresPaperStrategyApprovalService');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`); process.exitCode = 1; }
}
function reset() {
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
  service.__resetLastKnownGood();
}

// 1) Migration seedar dagens aktiva Futures-runtime, filtrerad genom execution allowlist.
test('migration seeds the runtime union as approved', () => {
  reset();
  const { migrated, store } = service.ensureMigrated();
  assert.strictEqual(migrated, true);
  const union = service.computeMigrationUnion();
  const ids = Object.keys(store.strategies).sort();
  assert.deepStrictEqual(ids, [...union].sort());
  for (const id of ['ema_pullback_continuation', 'vwap_volume_breakout_long', 'narrow_state_expansion_long']) {
    assert.ok(store.strategies[id], `${id} must be seeded`);
    assert.strictEqual(store.strategies[id].status, 'approved');
    assert.strictEqual(store.strategies[id].source, 'initial_migration_from_existing_futures_runtime');
  }
  for (const id of ['low_volatility_breakout', 'ema_breakdown', 'resistance_rejection', 'mnq_globex_momentum_v1']) {
    assert.ok(!store.strategies[id], `${id} must not be reactivated by historical trades`);
  }
});

// 2) Migration gör INTE en strategi omedelbart completed (ny testomgång startar 0/10).
test('migration does not make any strategy immediately completed', () => {
  reset();
  const info = service.listStrategies();
  for (const s of info.strategies) {
    if (s.approval && s.approval.status === 'approved') {
      assert.strictEqual(s.currentTest.currentTestClosedTrades, 0, `${s.strategyId} should start 0`);
      assert.strictEqual(s.currentTest.currentTestStatus, 'in_progress');
    }
  }
  // ema_pullback_continuation har historik men börjar ändå 0/10.
  const ema = service.getStrategy('ema_pullback_continuation');
  assert.strictEqual(ema.currentTest.currentTestClosedTrades, 0);
  assert.ok(ema.currentTest.totalHistoricalClosedTrades >= 10, 'historik bevaras separat');
});

// 3) Ny approve startar på 0/10.
test('fresh approve starts at 0/10', () => {
  reset();
  service.ensureMigrated();
  service.remove('vwap_volume_breakout_long');
  const r = service.approve('vwap_volume_breakout_long');
  assert.strictEqual(r.ok, true);
  const v = service.getStrategy('vwap_volume_breakout_long');
  assert.strictEqual(v.currentTest.currentTestClosedTrades, 0);
  assert.strictEqual(v.currentTest.currentTestTargetTrades, 10);
  assert.strictEqual(v.currentTest.currentTestStatus, 'in_progress');
});

// 4) Gamla trades räknas endast historiskt, inte i ny omgång.
test('old trades count only historically', () => {
  reset();
  service.ensureMigrated();
  const v = service.getStrategy('ema_pullback_continuation');
  assert.ok(v.currentTest.totalHistoricalClosedTrades > 0);
  assert.strictEqual(v.currentTest.currentTestClosedTrades, 0);
});

// 5) Trade stängd EFTER teststart räknas i aktuell omgång; öppna räknas ej.
test('trade closed after test start counts; open not counted', () => {
  reset();
  service.ensureMigrated();
  const entry = { testTargetTrades: 10, testRun: { startedAt: '2020-01-01T00:00:00.000Z' } };
  // 3 stängningar efter start
  const closedTs = new Map([['x', ['2020-02-01T00:00:00.000Z', '2020-03-01T00:00:00.000Z', '2020-04-01T00:00:00.000Z']]]);
  const p = service.computeCurrentTest('x', entry, closedTs);
  assert.strictEqual(p.currentTestClosedTrades, 3);
  // före start räknas inte
  const closedBefore = new Map([['x', ['2019-01-01T00:00:00.000Z']]]);
  assert.strictEqual(service.computeCurrentTest('x', entry, closedBefore).currentTestClosedTrades, 0);
});

// 6) Vinst OCH förlust räknas mot aktuell 10/10 (progress = antal stängda, oavsett utfall).
test('wins and losses both count toward current test', () => {
  reset();
  const entry = { testTargetTrades: 10, testRun: { startedAt: '2020-01-01T00:00:00.000Z' } };
  const closedTs = new Map([['x', Array.from({ length: 4 }, (_, i) => `2020-0${i + 2}-01T00:00:00.000Z`)]]);
  assert.strictEqual(service.computeCurrentTest('x', entry, closedTs).currentTestClosedTrades, 4);
});

// 7) 10 nya avslutade (EFTER teststart) → completed; elfte blockeras.
test('10 new closed after test start => completed, 11th blocked', () => {
  reset();
  service.ensureMigrated();
  // Fräsch approve → testRun.startedAt = nu. Injicera stängningar EFTER nu.
  service.remove('vwap_volume_breakout_long');
  service.approve('vwap_volume_breakout_long');
  const future = (i) => new Date(Date.now() + 60_000 + i * 1000).toISOString();
  const eleven = new Map([['vwap_volume_breakout_long', Array.from({ length: 11 }, (_, i) => future(i))]]);
  const g = service.evaluateFuturesApprovalGate({ strategyId: 'vwap_volume_breakout_long', closedTs: eleven });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.blockedReason, 'futures_test_target_completed');
  assert.strictEqual(g.currentTest.currentTestClosedTrades, 10, 'display capped at target');
  // nio stängda efter start → in_progress, gaten släpper igenom
  const nine = new Map([['vwap_volume_breakout_long', Array.from({ length: 9 }, (_, i) => future(i))]]);
  assert.strictEqual(service.evaluateFuturesApprovalGate({ strategyId: 'vwap_volume_breakout_long', closedTs: nine }).allowed, true);
});

// 8) Mutationer idempotenta; resume endast från paused.
test('mutations idempotent; resume only from paused', () => {
  reset();
  service.ensureMigrated();
  assert.strictEqual(service.pause('ema_pullback_continuation').changed, true);
  assert.strictEqual(service.pause('ema_pullback_continuation').changed, false);
  assert.strictEqual(service.resume('ema_pullback_continuation').changed, true);
  assert.strictEqual(service.resume('ema_pullback_continuation').changed, false);
  service.remove('ema_pullback_continuation');
  assert.strictEqual(service.resume('ema_pullback_continuation').code, 409);
});

// 9) Pausad/borttagen blockeras av gaten (skapar ingen ny trade).
test('paused/removed blocked by gate', () => {
  reset();
  service.ensureMigrated();
  const zero = new Map();
  service.pause('vwap_volume_breakout_long');
  assert.strictEqual(service.evaluateFuturesApprovalGate({ strategyId: 'vwap_volume_breakout_long', closedTs: zero }).blockedReason, 'futures_strategy_paused');
  service.remove('ema_pullback_continuation');
  assert.strictEqual(service.evaluateFuturesApprovalGate({ strategyId: 'ema_pullback_continuation', closedTs: zero }).blockedReason, 'futures_strategy_removed');
});

// 10) Duplicate Fakeout kan inte godkännas; gaten blockerar; crypto/paused avvisas.
test('duplicate/crypto/paused cannot be approved', () => {
  reset();
  service.ensureMigrated();
  const dup = service.approve('narrow_state_fakeout_reversal');
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.canonicalReplacementId, 'narrow_fakeout_reversal_v1');
  assert.strictEqual(service.evaluateFuturesApprovalGate({ strategyId: 'narrow_state_fakeout_reversal', closedTs: new Map() }).blockedReason, 'futures_strategy_duplicate');
  assert.strictEqual(service.approve('crypto_momentum_scalper').ok, false);
  assert.strictEqual(service.approve('news_volatility_watch').ok, false);
});

// 11) LAST-KNOWN-GOOD: korrupt store efter tidigare giltig laddning.
test('last-known-good on corrupt store after valid load', () => {
  reset();
  service.ensureMigrated();          // giltig store + LKG
  service.remove('vwap_volume_breakout_long');
  service.getStrategy('ema_pullback_continuation'); // säkerställ LKG uppdaterad
  fs.writeFileSync(TMP_STORE, '{ this is corrupt json');
  const loaded = service.loadStore();
  assert.strictEqual(loaded.degraded, true);
  const zero = new Map();
  // approved fortsätter
  assert.strictEqual(service.evaluateFuturesApprovalGate({ strategyId: 'ema_pullback_continuation', closedTs: zero }).allowed, true);
  // removed förblir removed
  assert.strictEqual(service.evaluateFuturesApprovalGate({ strategyId: 'vwap_volume_breakout_long', closedTs: zero }).blockedReason, 'futures_strategy_removed');
});

// 12) Vid store-fel släpps okänd strategi INTE igenom; ingen allow-all.
test('unknown strategy not allowed during store error; no allow-all', () => {
  reset();
  service.ensureMigrated();
  fs.writeFileSync(TMP_STORE, 'NOT JSON');
  const zero = new Map();
  const g = service.evaluateFuturesApprovalGate({ strategyId: '__unknown_never_seeded__', closedTs: zero });
  assert.strictEqual(g.allowed, false);
  assert.ok(['futures_approval_state_degraded', 'futures_strategy_not_approved'].includes(g.blockedReason));
});

// 13) Utan tidigare LKG + korrupt store → migrationsseed används (degraded), ingen allow-all.
test('no LKG + corrupt store uses migration seed (degraded)', () => {
  reset();
  fs.writeFileSync(TMP_STORE, 'garbage');
  service.__resetLastKnownGood();
  const loaded = service.loadStore();
  assert.strictEqual(loaded.degraded, true);
  // union-strategi finns i seed → approved → tillåts (om ej target klart)
  const zero = new Map();
  const g = service.evaluateFuturesApprovalGate({ strategyId: 'ema_pullback_continuation', closedTs: zero });
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.degraded, true);
  // okänd → blockeras
  assert.strictEqual(service.evaluateFuturesApprovalGate({ strategyId: '__nope__', closedTs: zero }).allowed, false);
});

// 14) Mutation vägras vid degraderat state (skriver aldrig över korrupt fil).
test('mutation refused while degraded', () => {
  reset();
  service.ensureMigrated();
  fs.writeFileSync(TMP_STORE, '{bad');
  const r = service.pause('ema_pullback_continuation');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 503);
  assert.strictEqual(r.reason, 'futures_approval_state_degraded');
});

// 15) Okänd strategi avvisas (normalläge).
test('unknown strategy rejected', () => {
  reset();
  assert.strictEqual(service.getStrategy('__nope__'), null);
  assert.strictEqual(service.approve('__nope__').code, 404);
});

// 16) Atomisk skrivning: giltig JSON efter många mutationer, inga tempfiler kvar.
test('atomic write leaves no corrupt file / no temp leftovers', () => {
  reset();
  service.ensureMigrated();
  for (let i = 0; i < 20; i += 1) { service.pause('ema_pullback_continuation'); service.resume('ema_pullback_continuation'); }
  JSON.parse(fs.readFileSync(TMP_STORE, 'utf8'));
  assert.strictEqual(fs.readdirSync(TMP_DIR).filter((f) => f.includes('.tmp')).length, 0);
});

// 17) Historik loggar previousStatus/newStatus/action/source/timestamp.
test('history records transitions', () => {
  reset();
  service.ensureMigrated();
  service.pause('ema_pullback_continuation');
  const raw = JSON.parse(fs.readFileSync(TMP_STORE, 'utf8')).strategies.ema_pullback_continuation.history;
  const last = raw[raw.length - 1];
  assert.strictEqual(last.action, 'pause');
  assert.strictEqual(last.previousStatus, 'approved');
  assert.strictEqual(last.newStatus, 'paused');
  assert.ok(last.timestamp);
});

// 18) listStrategies visar katalogen plus registry-strategier, safety paper-only, inga secrets.
test('listStrategies returns catalog and registry strategies, safety, no secrets', () => {
  reset();
  const info = service.listStrategies();
  assert.ok(info.count >= 34);
  assert.strictEqual(info.mode, 'paper_only');
  assert.strictEqual(info.broker_enabled, false);
  const ready = info.strategies.find((s) => s.strategyId === 'ema_pullback_continuation');
  assert.ok(Array.isArray(ready.signalRules), 'backend view exposes catalog signal rules');
  assert.ok(Array.isArray(ready.compatibility.allowedRoots), 'backend view exposes allowed roots');
  const registryStrategy = info.strategies.find((s) => s.strategyId === 'mnq_globex_momentum_v1');
  assert.ok(registryStrategy, 'backend view exposes scanner registry strategy');
  assert.strictEqual(registryStrategy.approval.status, null);
  assert.strictEqual(registryStrategy.approval.source, null);
  assert.deepStrictEqual(registryStrategy.compatibility.roots, ['MNQ']);
  const json = JSON.stringify(info);
  for (const re of [/api[_-]?key/i, /secret/i, /password/i, /token/i, /credential/i, /bearer/i]) {
    assert.ok(!re.test(json), `sensitive term ${re}`);
  }
});

// 19) Dagens READY-lista kommer från backendens kompatibilitet och producerEvidence.
test('READY list is backend-derived with producer evidence', () => {
  reset();
  const info = service.listStrategies();
  const expected = new Map([
    ['ema_pullback_continuation', 'both'],
    ['narrow_state_expansion_long', 'both'],
    // Den här strategin har både scanner-emitter och historiska closed trades i ledgern.
    ['vwap_volume_breakout_long', 'both'],
  ]);
  const ready = new Map(
    info.strategies
      .filter((s) => s.compatibility && s.compatibility.compatibility === service.COMPAT.READY)
      .map((s) => [s.strategyId, s.compatibility.producerEvidence]),
  );
  assert.deepStrictEqual([...ready.keys()].sort(), [...expected.keys()].sort());
  for (const [id, evidence] of expected.entries()) {
    assert.strictEqual(ready.get(id), evidence, `${id} READY evidence`);
  }
});

process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* noop */ } });

if (process.exitCode) console.error(`\nfuturesPaperStrategyApprovalService: FAILURES (passed ${passed})`);
else console.log(`\nfuturesPaperStrategyApprovalService: all ${passed} tests passed`);
