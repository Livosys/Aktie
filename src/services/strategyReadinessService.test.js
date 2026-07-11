'use strict';

// Tester för strategyReadinessService (FAS A+B) — read-only readiness-matris
// över canonical-katalogens 33 strategier. Integrationsstil mot verkliga
// källor (katalog, connector, approval-store), precis som övriga tester i
// repot. Inga trades/kandidater skapas, inga stores muteras.

const assert = require('assert/strict');

const svc = require('./strategyReadinessService');
const catalogService = require('./daytradingStrategyCatalogService');

const result = svc.getStrategyReadiness({ noCache: true });
const rows = result.strategies;
const byId = new Map(rows.map((r) => [r.strategyId, r]));

// 1. Endpointen täcker exakt alla canonical-strategier (i dag 33).
const catalogCount = catalogService.getCatalog().strategies.length;
assert.equal(rows.length, catalogCount, 'ska täcka exakt katalogens strategier');
assert.equal(result.summary.total, catalogCount);

// 2. Inga dubbla strategyId.
assert.equal(new Set(rows.map((r) => r.strategyId)).size, rows.length, 'unika strategyId');

// 3. Varje strategi får en readiness ur enum.
const validReadiness = new Set(Object.values(svc.READINESS));
for (const row of rows) {
  assert.ok(validReadiness.has(row.readiness), `${row.strategyId} har giltig readiness (${row.readiness})`);
}

// Summeringen ska täcka alla rader exakt en gång.
const summarySum = Object.entries(result.summary)
  .filter(([k]) => k !== 'total')
  .reduce((acc, [, v]) => acc + v, 0);
assert.equal(summarySum, rows.length, 'summary-kategorierna summerar till total');

// 4+5+6. Ingen strategi utan producent, utan mapping eller med partial
// connector får vara READY_FOR_PAPER.
for (const row of rows) {
  if (row.readiness === svc.READINESS.READY_FOR_PAPER) {
    assert.equal(row.producerStatus, 'ok', `${row.strategyId}: READY_FOR_PAPER kräver producent`);
    assert.ok(row.producedSubtypes.length > 0, `${row.strategyId}: READY_FOR_PAPER kräver mappade subtyper`);
    assert.equal(row.runtimeConnectorStatus, 'active', `${row.strategyId}: READY_FOR_PAPER kräver aktiv connector`);
    assert.equal(row.approved, true, `${row.strategyId}: READY_FOR_PAPER kräver approval`);
    assert.equal(row.familySelectionMismatch, false, `${row.strategyId}: READY_FOR_PAPER kräver kompatibelt familyval`);
  }
}

// 7. Approved men family-not-selected ger NEEDS_APPROVAL_ALIGNMENT.
for (const row of rows) {
  if (row.approved === true && row.familySelectionMismatch === true
      && row.readiness !== svc.READINESS.INTENTIONALLY_DISABLED
      && row.readiness !== svc.READINESS.UNSUPPORTED) {
    assert.equal(row.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT,
      `${row.strategyId}: approved+ej vald i familj => NEEDS_APPROVAL_ALIGNMENT`);
  }
}

// 8. Intentionally disabled klassas INTENTIONALLY_DISABLED.
const newsWatch = byId.get('news_volatility_watch');
assert.ok(newsWatch, 'news_volatility_watch finns');
assert.equal(newsWatch.readiness, svc.READINESS.INTENTIONALLY_DISABLED);
const cryptoFast = byId.get('crypto_fast_momentum');
assert.equal(cryptoFast.readiness, svc.READINESS.INTENTIONALLY_DISABLED);
// trend_continuation: producenten (REGULAR_PULLBACK) är medvetet blockad för
// paper => intentional, och den valda strategin blockerar EMA-syskonet.
const trendCont = byId.get('trend_continuation');
assert.equal(trendCont.readiness, svc.READINESS.INTENTIONALLY_DISABLED);
assert.ok(trendCont.warnings.includes('intentional_paper_block'));
assert.ok(trendCont.warnings.includes('selected_strategy_blocks_family'));

// 9. Short-only-strategi får korrekt research/paper-skillnad.
const vwapShort = byId.get('vwap_failed_breakout_short');
assert.ok(vwapShort, 'vwap_failed_breakout_short finns');
assert.equal(vwapShort.direction, 'short');
assert.equal(vwapShort.replayEligibility, 'READY');
assert.equal(vwapShort.paperEligibility, 'TECHNICALLY_ALLOWED_BUT_LONG_ONLY_INCOMPATIBLE');
assert.equal(vwapShort.readiness, svc.READINESS.READY_FOR_REPLAY);
assert.notEqual(vwapShort.readiness, svc.READINESS.READY_FOR_PAPER,
  'short-only får inte visas som READY_FOR_PAPER under LONG_ONLY');

// 10. UNKNOWN/NO_TRADE räknas aldrig som producerad strategi-signal.
for (const row of rows) {
  assert.ok(!row.producedSubtypes.includes('UNKNOWN'), `${row.strategyId}: UNKNOWN ej producent`);
  assert.ok(!row.producedSubtypes.includes('NO_TRADE'), `${row.strategyId}: NO_TRADE ej producent`);
  assert.ok(!row.producedSubtypes.includes('NARROW_WAIT'), `${row.strategyId}: NARROW_WAIT ej entry-producent`);
}

// 11. Syntetisk batch markeras ärligt på varje rad.
for (const row of rows) {
  assert.equal(row.syntheticBatch, true, `${row.strategyId}: syntheticBatch=true`);
  assert.equal(row.batchEligibility, 'SYNTHETIC_ONLY');
}

// 12. narrow_state_expansion_long = approval/family mismatch.
const expansionLong = byId.get('narrow_state_expansion_long');
assert.equal(expansionLong.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT);
assert.equal(expansionLong.approved, true);
assert.equal(expansionLong.familySelectionMismatch, true);
assert.equal(expansionLong.producerStatus, 'ok');

// 13. ema_pullback_continuation = approval/family mismatch.
const emaPullback = byId.get('ema_pullback_continuation');
assert.equal(emaPullback.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT);
assert.equal(emaPullback.approved, true);
assert.equal(emaPullback.familySelectionMismatch, true);
assert.equal(emaPullback.producerStatus, 'ok');

// 14. vwap_volume_breakout_long = approval mismatch (producer+runtime ok, ej approved).
const vwapVolLong = byId.get('vwap_volume_breakout_long');
assert.equal(vwapVolLong.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT);
assert.equal(vwapVolLong.approved, false);
assert.equal(vwapVolLong.approvalMismatch, true);
assert.ok(vwapVolLong.warnings.includes('approval_mismatch'));

// 15. vwap_failed_breakout_short får paper_short_leak-varning.
assert.ok(vwapShort.warnings.includes('paper_short_leak'));
assert.ok(vwapShort.warnings.includes('short_only_strategy'));

// 16. crypto_momentum_scalper får catch-all/missing-context.
const cryptoScalper = byId.get('crypto_momentum_scalper');
assert.equal(cryptoScalper.readiness, svc.READINESS.NEEDS_RUNTIME_CONNECTOR);
assert.ok(cryptoScalper.warnings.includes('catch_all_mapping_risk'));
assert.ok(cryptoScalper.missingContext.includes('crypto_signal_context'));

// 17. Dublettstrategier klassas UNSUPPORTED.
assert.equal(byId.get('narrow_breakout_v1').readiness, svc.READINESS.UNSUPPORTED);
assert.ok(byId.get('narrow_breakout_v1').warnings.some((w) => w.startsWith('duplicate_of_')));
assert.equal(byId.get('narrow_state_fakeout_reversal').readiness, svc.READINESS.UNSUPPORTED);
assert.ok(byId.get('narrow_state_fakeout_reversal').warnings.some((w) => w.startsWith('duplicate_signal_contract_with_')));

// Särskilda varningar från auditen.
const narrowBreakout = byId.get('narrow_breakout');
assert.equal(narrowBreakout.readiness, svc.READINESS.READY_FOR_PAPER);
assert.ok(narrowBreakout.warnings.includes('effective_direction_drift'),
  'narrow_breakout producerar i praktiken bara bear => direction drift');
const narrowFakeout = byId.get('narrow_fakeout_reversal_v1');
assert.equal(narrowFakeout.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT);
assert.equal(narrowFakeout.familySelectionMismatch, true);
for (const id of ['high_volatility_reversal', 'support_bounce', 'resistance_rejection', 'trend_exhaustion_short', 'news_volatility_watch']) {
  assert.ok(byId.get(id).warnings.includes('missing_family'), `${id}: missing_family-varning`);
}

// Safety-stämpel på svar och varje rad.
assert.equal(result.mode, 'paper_only');
assert.equal(result.actions_allowed, false);
assert.equal(result.can_place_orders, false);
assert.equal(result.live_trading_enabled, false);
assert.equal(result.broker_enabled, false);
for (const row of rows) {
  assert.equal(row.mode, 'paper_only');
  assert.equal(row.actions_allowed, false);
}

// Regression: top-level safety är ett nästlat objekt, aldrig null, med de
// exakta låsta värdena (schemaavvikelsen "safety": null får inte återkomma).
function assertSafetyObject(payload, label) {
  assert.ok(payload.safety !== null && payload.safety !== undefined, `${label}: safety får inte vara null`);
  assert.deepEqual(payload.safety, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  }, `${label}: safety-objektets exakta innehåll`);
}
assertSafetyObject(result, 'normalt svar');

// Safety ska finnas även när en delkälla är degraded/error — simulera trasig
// katalogkälla in-process (ingen disk/store rörs) och återställ i finally.
{
  const catSvc = require('./daytradingStrategyCatalogService');
  const originalGetCatalog = catSvc.getCatalog;
  try {
    catSvc.getCatalog = () => { throw new Error('test_source_failure'); };
    const degraded = svc.computeStrategyReadiness();
    assert.equal(degraded.status, 'degraded', 'trasig katalog => status degraded');
    assertSafetyObject(degraded, 'degraderat svar');
    assert.equal(degraded.mode, 'paper_only');
    assert.equal(degraded.actions_allowed, false);
    assert.equal(degraded.can_place_orders, false);
    assert.equal(degraded.live_trading_enabled, false);
    assert.equal(degraded.broker_enabled, false);
  } finally {
    catSvc.getCatalog = originalGetCatalog;
  }
}

// Efter fixen ska endpointen fortsatt returnera exakt katalogens strategier
// (i dag 33) med den befintliga platta säkerhetsstämpeln på varje rad.
{
  const fresh = svc.getStrategyReadiness({ noCache: true });
  assert.equal(fresh.strategies.length, catalogCount, 'fortsatt exakt 33 strategier');
  assertSafetyObject(fresh, 'färskt svar');
  for (const row of fresh.strategies) {
    assert.equal(row.mode, 'paper_only');
    assert.equal(row.actions_allowed, false);
    assert.equal(row.can_place_orders, false);
    assert.equal(row.live_trading_enabled, false);
    assert.equal(row.broker_enabled, false);
  }
}

// Sources-blocket finns med giltiga statusvärden.
const validSourceStatus = new Set(['ok', 'empty', 'degraded', 'error']);
for (const key of ['catalog', 'producerRegistry', 'approvalStore', 'runtimeConnector']) {
  assert.ok(result.sources[key], `sources.${key} finns`);
  assert.ok(validSourceStatus.has(result.sources[key].status), `sources.${key}.status giltig`);
}

// 18. Fault isolation: classifyStrategy fäller inte hela svaret om en delkälla
// saknas — kör klassificeringen med tomma/degraderade källor och verifiera att
// den fortfarande returnerar rader med readiness.
{
  const emptySources = {
    catalogIds: new Set(['x_strategy']),
    producerRegistry: { status: 'error', entrySubtypes: [], nonEntrySubtypes: [], directions: {}, families: {} },
    approval: { status: 'error', byId: new Map(), familySelections: [] },
    runtime: { status: 'error', rowsById: new Map(), conn: null },
    mapping: { status: 'error', probes: [] },
  };
  const row = svc._internal.classifyStrategy({ id: 'x_strategy', name: 'X', family: null, direction: 'both', status: 'active' }, emptySources);
  assert.ok(validReadiness.has(row.readiness), 'degraderade källor ger ändå en readiness');
  assert.equal(row.approved, null, 'okänd approval rapporteras som null, inte som false-larm');
  assert.equal(row.runtimeConnectorStatus, null);
  assert.equal(row.mode, 'paper_only');
}

console.log('strategyReadinessService.test.js passed');
