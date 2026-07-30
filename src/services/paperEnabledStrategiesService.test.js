'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-enabled-strategies-'));
const tmpStore = path.join(tmpDir, 'enabled-strategies.json');
const tmpApprovalStore = path.join(tmpDir, 'strategy-approvals.json');

process.env.PAPER_ENABLED_STRATEGIES_FILE = tmpStore;
process.env.PAPER_STRATEGY_APPROVALS_FILE = tmpApprovalStore;
process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'false';

fs.writeFileSync(tmpApprovalStore, JSON.stringify({
  schemaVersion: 1,
  strategies: {
    narrow_breakout: { status: 'approved' },
  },
  selectedByFamily: { narrow_state: 'narrow_breakout' },
  updatedAt: '2026-07-11T00:00:00.000Z',
}, null, 2));

const approvalBeforeHash = sha256(tmpApprovalStore);
const approvalBeforeMtime = fs.statSync(tmpApprovalStore).mtimeMs;

const catalog = require('./daytradingStrategyCatalogService');
const svc = require('./paperEnabledStrategiesService');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safety(payload) {
  assert.equal(payload.mode, 'paper_only');
  assert.equal(payload.actions_allowed, false);
  assert.equal(payload.can_place_orders, false);
  assert.equal(payload.live_trading_enabled, false);
  assert.equal(payload.broker_enabled, false);
}

function enabledIdsFromStore(store) {
  return Object.entries(store.strategies)
    .filter(([, entry]) => entry.enabled === true)
    .map(([id]) => id)
    .sort();
}

function main() {
  const catalogIds = catalog.getCatalog().strategies.map((strategy) => strategy.id);
  assert.equal(catalogIds.length, 33, 'test fixture expects 33 canonical strategies');

  const missing = svc.getAllStrategyStates();
  assert.equal(missing.status, 'missing');
  assert.equal(missing.total, 33, 'missing store still represents every canonical strategy');
  assert.equal(missing.enabled, 0, 'missing store fails closed');
  safety(missing);

  const initial = svc.buildInitialStore({
    now: '2026-07-11T17:00:00.000Z',
    source: 'manual_initial_migration',
  });
  assert.equal(Object.keys(initial.strategies).length, 33, 'initial store represents exactly 33 strategies');
  assert.deepEqual(enabledIdsFromStore(initial), [
    'ema_pullback_continuation',
    'narrow_state_expansion_long',
    'vwap_volume_breakout_long',
  ], 'exactly three initial enabled strategies');

  for (const id of catalogIds) {
    assert.ok(initial.strategies[id], `${id} has an explicit initial state`);
    if (!svc.INITIAL_ENABLED_STRATEGY_IDS.includes(id)) {
      assert.equal(initial.strategies[id].enabled, false, `${id} disabled initially`);
      assert.equal(initial.strategies[id].disabledBy, 'manual_initial_migration');
    }
  }
  assert.equal(initial.history.length, 33, 'initial migration history records all explicit manual decisions');
  assert.ok(initial.history.every((entry) => entry.source === 'manual_initial_migration'));

  svc._internal.writeStoreAtomic(initial, new Date('2026-07-11T17:00:00.000Z'));
  const listed = svc.getAllStrategyStates();
  assert.equal(listed.status, 'ok');
  assert.equal(listed.total, 33);
  assert.equal(listed.enabled, 3);
  assert.deepEqual(Object.values(listed.strategies).filter((row) => row.enabled).map((row) => row.strategyId).sort(), enabledIdsFromStore(initial));
  safety(listed);

  const unknown = svc.enableStrategy('not_a_canonical_strategy', { source: 'manual' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 404);
  assert.equal(unknown.reason, 'unknown_canonical_strategy');
  safety(unknown);

  const historyAtStart = svc.getHistory({ limit: 500 }).total;
  assert.equal(historyAtStart, 33);

  const enableAgain = svc.enableStrategy('ema_pullback_continuation', { source: 'manual' });
  assert.equal(enableAgain.ok, true);
  assert.equal(enableAgain.changed, false);
  assert.equal(svc.getHistory({ limit: 500 }).total, historyAtStart, 'idempotent enable writes no history');

  const disableAgain = svc.disableStrategy('narrow_breakout', { source: 'manual' });
  assert.equal(disableAgain.ok, true);
  assert.equal(disableAgain.changed, false);
  assert.equal(svc.getHistory({ limit: 500 }).total, historyAtStart, 'idempotent disable writes no history');

  const originalRename = fs.renameSync;
  const renameCalls = [];
  fs.renameSync = (src, dest) => {
    renameCalls.push({ src, dest });
    return originalRename(src, dest);
  };
  try {
    const enabled = svc.enableStrategy('narrow_fakeout_reversal_v1', {
      source: 'manual',
      now: '2026-07-11T17:10:00.000Z',
    });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.changed, true);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(renameCalls.length, 1, 'state-changing write uses one rename');
  assert.equal(renameCalls[0].dest, tmpStore, 'atomic rename targets the store file');
  assert.ok(path.basename(renameCalls[0].src).startsWith('.enabled-strategies.'), 'atomic write uses a temp file first');
  assert.equal(fs.readdirSync(tmpDir).some((name) => name.endsWith('.tmp')), false, 'no temp files left behind');
  assert.equal(svc.getHistory({ limit: 500 }).total, historyAtStart + 1);

  const enabledAgain = svc.enableStrategy('narrow_fakeout_reversal_v1', { source: 'manual' });
  assert.equal(enabledAgain.changed, false);
  assert.equal(svc.getHistory({ limit: 500 }).total, historyAtStart + 1);

  const disabled = svc.disableStrategy('narrow_fakeout_reversal_v1', {
    source: 'manual',
    now: '2026-07-11T17:20:00.000Z',
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.changed, true);
  assert.equal(svc.getHistory({ limit: 500 }).total, historyAtStart + 2);

  const disabledAgain = svc.disableStrategy('narrow_fakeout_reversal_v1', { source: 'manual' });
  assert.equal(disabledAgain.changed, false);
  assert.equal(svc.getHistory({ limit: 500 }).total, historyAtStart + 2, 'idempotent disable writes no second history row');

  const projection = svc.buildPaperStrategyList({ fresh: true });
  assert.equal(projection.summary.total, 33);
  assert.equal(projection.summary.enabled, 3);
  assert.equal(projection.runtimeGateMode, 'legacy');
  assert.equal(projection.manualListControlsRuntime, false);
  safety(projection);
  for (const row of projection.strategies) safety(row);

  // Subjektet här måste vara en strategi UTAN entry contract. Det var tidigare
  // narrow_fakeout_reversal_v1, men den har numera ett kontrakt (väg A, generiska
  // confirmations), så invarianten prövas i stället med narrow_breakout — som
  // fortfarande saknar kontrakt.
  process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'true';
  svc.enableStrategy('narrow_breakout', {
    source: 'test',
    now: '2026-07-11T17:30:00.000Z',
  });
  const contractGatedProjection = svc.buildPaperStrategyList({ fresh: true });
  const narrowBreakoutRow = contractGatedProjection.strategies.find((row) => row.strategyId === 'narrow_breakout');
  assert.equal(contractGatedProjection.entryContractsEnabled, true);
  assert.equal(contractGatedProjection.summary.enabled, 4);
  assert.equal(contractGatedProjection.summary.ready, 3, 'missing-contract strategy får inte öka paper-ready count');
  assert.equal(narrowBreakoutRow.entryContractReady, false);
  assert.equal(narrowBreakoutRow.paperEligibility, 'BLOCKED');
  assert.equal(narrowBreakoutRow.paperBlockedReason, 'paper_strategy_enabled_but_entry_contract_missing');
  svc.disableStrategy('narrow_breakout', {
    source: 'test',
    now: '2026-07-11T17:31:00.000Z',
  });
  process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'false';

  assert.equal(sha256(tmpApprovalStore), approvalBeforeHash, 'legacy approval store hash unchanged');
  assert.equal(fs.statSync(tmpApprovalStore).mtimeMs, approvalBeforeMtime, 'legacy approval store mtime unchanged');

  fs.writeFileSync(tmpStore, '{ broken json', 'utf8');
  const corrupt = svc.getAllStrategyStates();
  assert.equal(corrupt.status, 'corrupt');
  assert.equal(corrupt.enabled, 0, 'corrupt store fails closed');
  safety(corrupt);

  console.log('paperEnabledStrategiesService.test.js passed');
}

try {
  main();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
