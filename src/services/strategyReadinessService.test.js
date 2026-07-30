'use strict';

// Tester för strategyReadinessService (FAS A+B) — read-only readiness-matris
// över canonical-katalogens 33 strategier. Integrationsstil mot verkliga
// källor (katalog, connector, approval-store), precis som övriga tester i
// repot. Inga trades/kandidater skapas, inga stores muteras.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-readiness-manual-'));
process.env.PAPER_ENABLED_STRATEGIES_FILE = path.join(tmpDir, 'enabled-strategies.json');
process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'false';

const paperEnabledStrategies = require('./paperEnabledStrategiesService');
paperEnabledStrategies._internal.writeStoreAtomic(
  paperEnabledStrategies.buildInitialStore({
    now: '2026-07-11T17:00:00.000Z',
    source: 'manual_initial_migration',
  }),
  new Date('2026-07-11T17:00:00.000Z'),
);

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
const readinessSummaryKeys = new Set([
  'readyForPaper',
  'readyForReplay',
  'readyForBatch',
  'needsProducer',
  'needsMapping',
  'needsRuntimeConnector',
  'needsApprovalAlignment',
  'needsMarketContext',
  'needsEntryContract',
  'needsCostModel',
  'needsMoreTesting',
  'intentionallyDisabled',
  'unsupported',
  'broken',
]);
const summarySum = Object.entries(result.summary)
  .filter(([k]) => readinessSummaryKeys.has(k))
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
// paper => intentional. Efter FAS D2 är den inte längre familjens valda
// strategi (ema_pullback_continuation vald) => blockerar inte EMA-syskonet.
const trendCont = byId.get('trend_continuation');
assert.equal(trendCont.readiness, svc.READINESS.INTENTIONALLY_DISABLED);
assert.ok(trendCont.warnings.includes('intentional_paper_block'));
assert.ok(!trendCont.warnings.includes('selected_strategy_blocks_family'),
  'trend_continuation blockerar inte längre familjen efter D2-alignmenten');

// 9. Short-only-strategi får korrekt research/paper-skillnad. Efter FAS D1 är
// vwap_failed_breakout_short policy-pausad i approval-storen: paper blockerad,
// research/replay fortsatt tillåten, klassad som medvetet avstängd.
const vwapShort = byId.get('vwap_failed_breakout_short');
assert.ok(vwapShort, 'vwap_failed_breakout_short finns');
assert.equal(vwapShort.direction, 'short');
assert.equal(vwapShort.replayEligibility, 'READY', 'research/replay fortsatt tillåten');
assert.equal(vwapShort.paperEligibility, 'BLOCKED', 'paper blockerad efter D1-pausen');
assert.equal(vwapShort.approvalStatus, 'paused');
assert.equal(vwapShort.readiness, svc.READINESS.INTENTIONALLY_DISABLED);
assert.notEqual(vwapShort.readiness, svc.READINESS.READY_FOR_PAPER,
  'short-only får inte visas som READY_FOR_PAPER under LONG_ONLY');
assert.ok(!vwapShort.warnings.includes('approval_mismatch'),
  'policy-paus är ett beslut, inte en approval-mismatch');

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

// 12. narrow_state_expansion_long: approved + family-selected efter FAS D2 —
// den enda long-only-strategin med hela kedjan klar.
const expansionLong = byId.get('narrow_state_expansion_long');
assert.equal(expansionLong.readiness, svc.READINESS.READY_FOR_PAPER);
assert.equal(expansionLong.approved, true);
assert.equal(expansionLong.familySelectionMismatch, false);
assert.equal(expansionLong.producerStatus, 'ok');
assert.equal(expansionLong.direction, 'long');

// 13. ema_pullback_continuation: approved + family-selected efter FAS D2.
const emaPullback = byId.get('ema_pullback_continuation');
assert.equal(emaPullback.readiness, svc.READINESS.READY_FOR_PAPER);
assert.equal(emaPullback.approved, true);
assert.equal(emaPullback.familySelectionMismatch, false);
assert.equal(emaPullback.producerStatus, 'ok');

// 14. vwap_volume_breakout_long: approved + family-selected efter FAS D2.
const vwapVolLong = byId.get('vwap_volume_breakout_long');
assert.equal(vwapVolLong.readiness, svc.READINESS.READY_FOR_PAPER);
assert.equal(vwapVolLong.approved, true);
assert.equal(vwapVolLong.approvalMismatch, false);
assert.ok(!vwapVolLong.warnings.includes('approval_mismatch'));
assert.equal(vwapVolLong.direction, 'long');

// 15. Short-läckan är stängd: paper_short_leak-varningen (short-only + approved
// + selected + runtime allowed) får inte längre förekomma någonstans.
for (const row of rows) {
  assert.ok(!row.warnings.includes('paper_short_leak'),
    `${row.strategyId}: paper_short_leak ska vara stängd efter FAS D1`);
}
assert.ok(vwapShort.warnings.includes('short_only_strategy'));

// Entry contracts är runtime-sanning när flaggan är aktiv: strategier som i
// övrigt har producent/mapping/connector får inte räknas som paper-ready utan
// contract.
{
  process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'true';
  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'true';
  const contractGated = svc.getStrategyReadiness({ noCache: true });
  const contractRows = contractGated.strategies;
  const contractById = new Map(contractRows.map((r) => [r.strategyId, r]));
  assert.equal(contractGated.sources.entryContracts.enabled, true);
  assert.equal(contractGated.sources.entryContracts.ready, 5);
  // Fortfarande exakt tre paper-körbara strategier: narrow_fakeout_reversal_v1 har
  // fått ett kontrakt (väg A) men är inte påslagen i den manuella listan och äger
  // inte familjevalet i narrow_state, så den ska INTE vara READY_FOR_PAPER.
  assert.deepEqual(
    contractRows.filter((r) => r.readiness === svc.READINESS.READY_FOR_PAPER).map((r) => r.strategyId).sort(),
    ['ema_pullback_continuation', 'narrow_state_expansion_long', 'vwap_volume_breakout_long'],
  );
  // narrow_fakeout_reversal_v1 är medvetet BORTA ur den här listan — den har numera
  // ett kontrakt. Invarianten "saknar kontrakt ⇒ NEEDS_ENTRY_CONTRACT" prövas kvar
  // med de två som fortfarande saknar kontrakt.
  for (const id of ['narrow_breakout', 'vwap_failed_breakout_short']) {
    const row = contractById.get(id);
    assert.equal(row.entryContractReady, false, `${id}: saknar entry contract`);
    assert.equal(row.technicalReadiness, svc.READINESS.NEEDS_ENTRY_CONTRACT, `${id}: blockas av contract-krav`);
    assert.ok(row.missingComponents.includes('entry_contract'), `${id}: entry_contract finns i missingComponents`);
    assert.notEqual(row.readiness, svc.READINESS.READY_FOR_PAPER, `${id}: får inte vara READY_FOR_PAPER`);
  }
  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'false';
  process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'false';
}

// 16. crypto_momentum_scalper: missing-context kvarstår men catch-all-mapping
// är borta sedan FAS C-mappingfixen — UNKNOWN/NO_TRADE/crypto-VWAP routas inte
// längre till scalpern, så varningen får INTE återkomma.
const cryptoScalper = byId.get('crypto_momentum_scalper');
assert.equal(cryptoScalper.readiness, svc.READINESS.NEEDS_RUNTIME_CONNECTOR);
assert.ok(!cryptoScalper.warnings.includes('catch_all_mapping_risk'),
  'catch_all_mapping_risk ska vara borta efter FAS C mapping-fixen');
assert.ok(cryptoScalper.missingContext.includes('crypto_signal_context'));
assert.equal(cryptoScalper.producerStatus, 'none',
  'scalpern får inte krediteras som producent via catch-all');

// 17. Dublettstrategier klassas UNSUPPORTED.
assert.equal(byId.get('narrow_breakout_v1').readiness, svc.READINESS.UNSUPPORTED);
assert.ok(byId.get('narrow_breakout_v1').warnings.some((w) => w.startsWith('duplicate_of_')));
assert.equal(byId.get('narrow_state_fakeout_reversal').readiness, svc.READINESS.UNSUPPORTED);
assert.ok(byId.get('narrow_state_fakeout_reversal').warnings.some((w) => w.startsWith('duplicate_signal_contract_with_')));

// Särskilda varningar från auditen. Efter FAS D2 är narrow_breakout inte
// längre familjens valda strategi (bear-producenten står tillbaka för
// long-only-strategin) men behåller research-vägen.
const narrowBreakout = byId.get('narrow_breakout');
assert.equal(narrowBreakout.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT);
assert.equal(narrowBreakout.familySelectionMismatch, true);
assert.equal(narrowBreakout.replayEligibility, 'READY');
assert.ok(narrowBreakout.warnings.includes('effective_direction_drift'),
  'narrow_breakout producerar i praktiken bara bear => direction drift');
const narrowFakeout = byId.get('narrow_fakeout_reversal_v1');
assert.equal(narrowFakeout.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT);
assert.equal(narrowFakeout.familySelectionMismatch, true);

// FAS D-slutläge: exakt tre long-strategier är paper-körbara och ingen
// short-only-strategi är READY_FOR_PAPER.
{
  const paperReady = rows.filter((r) => r.readiness === svc.READINESS.READY_FOR_PAPER).map((r) => r.strategyId).sort();
  assert.deepEqual(paperReady, ['ema_pullback_continuation', 'narrow_state_expansion_long', 'vwap_volume_breakout_long']);
  for (const row of rows) {
    if (row.direction === 'short') {
      assert.notEqual(row.readiness, svc.READINESS.READY_FOR_PAPER, `${row.strategyId}: short-only aldrig paper-ready`);
    }
  }
  // Inga dubbla familyval: varje familj har högst en vald strategi.
  const seen = new Map();
  for (const row of rows) {
    if (row.family && row.selectedInFamily === true) {
      assert.ok(!seen.has(row.family), `dubbelt familyval i ${row.family}`);
      seen.set(row.family, row.strategyId);
    }
  }
}
for (const id of ['high_volatility_reversal', 'support_bounce', 'resistance_rejection', 'trend_exhaustion_short', 'news_volatility_watch']) {
  assert.ok(byId.get(id).warnings.includes('missing_family'), `${id}: missing_family-varning`);
}

// FAS 5: manual Paper Strategy List separerar teknisk readiness från
// användarens val. Approval/family finns kvar som audit, men styr inte
// huvudreadiness när PAPER_MANUAL_STRATEGY_LIST_ENABLED=true.
{
  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'true';
  const manual = svc.getStrategyReadiness({ noCache: true });
  const manualRows = manual.strategies;
  const manualById = new Map(manualRows.map((r) => [r.strategyId, r]));
  assert.equal(manual.runtimeGateMode, 'manual');
  assert.equal(manual.manualListControlsRuntime, true);
  assert.equal(manualRows.length, catalogCount);
  assert.equal(manual.summary.enabledForPaper, 3);
  assert.deepEqual(manualRows.filter((r) => r.enabledForPaper).map((r) => r.strategyId).sort(), [
    'ema_pullback_continuation',
    'narrow_state_expansion_long',
    'vwap_volume_breakout_long',
  ]);

  const manualReady = manualRows.filter((r) => r.readiness === svc.READINESS.READY_FOR_PAPER).map((r) => r.strategyId).sort();
  assert.deepEqual(manualReady, [
    'ema_pullback_continuation',
    'narrow_state_expansion_long',
    'vwap_volume_breakout_long',
  ], 'READY_FOR_PAPER kräver både enabled och teknisk readiness i manual mode');

  const manualNarrowFakeout = manualById.get('narrow_fakeout_reversal_v1');
  assert.equal(manualNarrowFakeout.enabledForPaper, false);
  assert.equal(manualNarrowFakeout.manualSelectionStatus, 'disabled');
  assert.equal(manualNarrowFakeout.technicalReadiness, 'READY');
  assert.equal(manualNarrowFakeout.paperEligibility, 'DISABLED_BY_USER');
  assert.equal(manualNarrowFakeout.paperBlockedReason, 'paper_strategy_not_enabled');
  assert.equal(manualNarrowFakeout.legacyApprovalStatus, 'approved');
  assert.equal(manualNarrowFakeout.legacySelectedInFamily, false);
  assert.notEqual(manualNarrowFakeout.readiness, svc.READINESS.NEEDS_APPROVAL_ALIGNMENT,
    'manual mode använder inte approval alignment som huvudstatus för disabled strategi');

  paperEnabledStrategies.enableStrategy('crypto_momentum_scalper', { source: 'test' });
  const enabledButBlocked = svc.getStrategyReadiness({ noCache: true });
  const enabledCrypto = enabledButBlocked.strategies.find((r) => r.strategyId === 'crypto_momentum_scalper');
  assert.equal(enabledCrypto.enabledForPaper, true);
  assert.equal(enabledCrypto.manualSelectionStatus, 'enabled');
  assert.equal(enabledCrypto.technicalReadiness, svc.READINESS.NEEDS_RUNTIME_CONNECTOR);
  assert.equal(enabledCrypto.paperEligibility, 'BLOCKED');
  assert.equal(enabledCrypto.paperBlockedReason, 'paper_strategy_enabled_but_runtime_blocked');
  paperEnabledStrategies.disableStrategy('crypto_momentum_scalper', { source: 'test' });

  const manualVwapShort = manualById.get('vwap_failed_breakout_short');
  assert.equal(manualVwapShort.direction, 'short');
  assert.equal(manualVwapShort.enabledForPaper, false);
  assert.equal(manualVwapShort.technicalReadiness, 'READY');
  assert.equal(manualVwapShort.paperEligibility, 'DISABLED_BY_USER');
  assert.ok(manualVwapShort.warnings.includes('short_only_strategy'));

  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'false';
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
for (const key of ['catalog', 'producerRegistry', 'approvalStore', 'manualEnabledStore', 'runtimeConnector']) {
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
fs.rmSync(tmpDir, { recursive: true, force: true });
