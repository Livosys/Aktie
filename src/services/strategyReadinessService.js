'use strict';

/**
 * Strategy Readiness Service — READ-ONLY (FAS A+B).
 *
 * Beräknar den verkliga körbarheten för samtliga canonical-strategier i
 * daytradingStrategyCatalogService genom att korsa fyra befintliga källor:
 *
 *   1. Canonical catalog        (daytradingStrategyCatalogService.getCatalog)
 *   2. Producent-sanningen      (signalFamilyClassifier.PRODUCIBLE_*_SUBTYPES)
 *   3. Runtime connector        (strategyRuntimeConnectorService — status,
 *                                raw signals, required/missing context samt
 *                                mapping-prober via inferStrategyForSignal)
 *   4. Approval/family-store    (paperStrategyApprovalService — read-only)
 *
 * Tjänsten skapar INGEN ny strategilista och muterar INGENTING: inga
 * approvals, inga familyval, inga kandidater, inga trades. Batchmotorn är
 * i dag syntetisk (strategyPerformanceService.deterministicTestResult), så
 * batchEligibility rapporteras ärligt som SYNTHETIC_ONLY.
 *
 * Fault isolation: varje källa läses defensivt; en trasig källa ger
 * sources.<namn>.status = degraded/error och saknade fält blir null —
 * svaret levereras alltid.
 */

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const READINESS = Object.freeze({
  READY_FOR_REPLAY: 'READY_FOR_REPLAY',
  READY_FOR_BATCH: 'READY_FOR_BATCH',
  READY_FOR_PAPER: 'READY_FOR_PAPER',
  NEEDS_PRODUCER: 'NEEDS_PRODUCER',
  NEEDS_MAPPING: 'NEEDS_MAPPING',
  NEEDS_RUNTIME_CONNECTOR: 'NEEDS_RUNTIME_CONNECTOR',
  NEEDS_APPROVAL_ALIGNMENT: 'NEEDS_APPROVAL_ALIGNMENT',
  NEEDS_MARKET_CONTEXT: 'NEEDS_MARKET_CONTEXT',
  NEEDS_ENTRY_CONTRACT: 'NEEDS_ENTRY_CONTRACT',
  NEEDS_COST_MODEL: 'NEEDS_COST_MODEL',
  NEEDS_MORE_TESTING: 'NEEDS_MORE_TESTING',
  INTENTIONALLY_DISABLED: 'INTENTIONALLY_DISABLED',
  UNSUPPORTED: 'UNSUPPORTED',
  BROKEN: 'BROKEN',
});

// Blocked-reason-koder som betyder "medvetet avstängd paper-entry" (inte fel).
const INTENTIONAL_PAPER_BLOCK_REASONS = new Set([
  'setup_not_paper_entry',
  'narrow_wait_not_paper_entry',
]);

const CACHE_TTL_MS = 15_000;
let _cache = null;
let _cacheAt = 0;

function lazy(modPath) {
  try { return require(modPath); } catch (_) { return null; }
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

// ── Källäsare (alla read-only, alla fault-isolerade) ─────────────────────────

function loadCatalogSource() {
  try {
    const svc = lazy('./daytradingStrategyCatalogService');
    const strategies = arr(svc && svc.getCatalog().strategies);
    if (!strategies.length) return { status: 'empty', strategies: [] };
    return { status: 'ok', strategies };
  } catch (err) {
    return { status: 'error', strategies: [], error: err.message };
  }
}

function loadProducerRegistry() {
  try {
    const classifier = lazy('../scanner/signalFamilyClassifier');
    const entrySubtypes = arr(classifier && classifier.PRODUCIBLE_ENTRY_SUBTYPES);
    if (!entrySubtypes.length) return { status: 'empty', entrySubtypes: [], nonEntrySubtypes: [], directions: {}, families: {} };
    return {
      status: 'ok',
      entrySubtypes,
      nonEntrySubtypes: arr(classifier.PRODUCIBLE_NON_ENTRY_SUBTYPES),
      directions: classifier.PRODUCIBLE_SUBTYPE_DIRECTIONS || {},
      families: classifier.PRODUCIBLE_SUBTYPE_FAMILIES || {},
    };
  } catch (err) {
    return { status: 'error', entrySubtypes: [], nonEntrySubtypes: [], directions: {}, families: {}, error: err.message };
  }
}

function loadApprovalSource(catalogStrategies) {
  try {
    const svc = lazy('./paperStrategyApprovalService');
    if (!svc) return { status: 'error', byId: new Map(), familySelections: [] };
    const status = svc.getAllowlistStatus();
    const byId = new Map();
    for (const strategy of arr(catalogStrategies)) {
      const gate = svc.evaluatePaperApprovalGate({ strategyId: strategy.id });
      byId.set(strategy.id, {
        approved: arr(status.approvedStrategyIds).includes(strategy.id),
        tradable: arr(status.tradableStrategyIds).includes(strategy.id),
        gateAllowed: gate && gate.allowed === true,
        gateBlockedReason: (gate && gate.blockedReason) || null,
        selectedStrategyId: (gate && gate.selectedStrategyId) || null,
        degraded: Boolean(gate && gate.degraded),
      });
    }
    const anyDegraded = [...byId.values()].some((row) => row.degraded);
    return {
      status: status.ok === false || anyDegraded ? 'degraded' : 'ok',
      byId,
      familySelections: arr(status.familySelections),
    };
  } catch (err) {
    return { status: 'error', byId: new Map(), familySelections: [], error: err.message };
  }
}

function loadManualEnabledSource(catalogStrategies) {
  try {
    const svc = lazy('./paperEnabledStrategiesService');
    if (!svc) return { status: 'error', manualMode: false, byId: new Map() };
    const states = svc.getAllStrategyStates();
    const byId = new Map();
    for (const strategy of arr(catalogStrategies)) {
      byId.set(strategy.id, (states.strategies || {})[strategy.id] || {
        strategyId: strategy.id,
        enabled: false,
        storeStatus: states.status || 'missing',
      });
    }
    return {
      status: states.status || 'ok',
      manualMode: svc.manualListControlsRuntime(),
      byId,
      summary: { total: states.total || byId.size, enabled: states.enabled || 0 },
    };
  } catch (err) {
    return { status: 'error', manualMode: false, byId: new Map(), error: err.message };
  }
}

function loadRuntimeSource() {
  try {
    const conn = lazy('./strategyRuntimeConnectorService');
    if (!conn) return { status: 'error', rowsById: new Map(), conn: null };
    const summary = conn.getStrategyRuntimeSummary();
    const rowsById = new Map(arr(summary.strategies).map((row) => [row.id, row]));
    if (!rowsById.size) return { status: 'empty', rowsById, conn };
    return { status: 'ok', rowsById, conn };
  } catch (err) {
    return { status: 'error', rowsById: new Map(), conn: lazy('./strategyRuntimeConnectorService'), error: err.message };
  }
}

// Mapping-prober: för varje producerbar subtyp, fråga befintlig connector-
// mappning vilken canonical-strategi som tar emot signalen på crypto respektive
// aktier. Ren läsning — skapar inga kandidater eller trades.
const PROBE_CONTEXTS = Object.freeze([
  { market: 'crypto', symbol: 'BTCUSDT' },
  { market: 'stocks', symbol: 'AAPL' },
]);

function probeMappings(producerRegistry, runtimeSource) {
  const probes = [];
  const conn = runtimeSource.conn;
  if (!conn || typeof conn.inferStrategyForSignal !== 'function') {
    return { status: 'error', probes };
  }
  const allSubtypes = [
    ...producerRegistry.entrySubtypes.map((s) => ({ subtype: s, entryCapable: true })),
    ...producerRegistry.nonEntrySubtypes.map((s) => ({ subtype: s, entryCapable: false })),
  ];
  for (const { subtype, entryCapable } of allSubtypes) {
    const family = producerRegistry.families[subtype]
      || (subtype === 'NARROW_WAIT' ? 'NARROW_COMPRESSION' : 'UNKNOWN');
    const direction = producerRegistry.directions[subtype] === 'short' ? 'DOWN' : 'UP';
    for (const ctx of PROBE_CONTEXTS) {
      try {
        const signal = {
          signalFamily: family,
          signalSubtype: subtype,
          nextMoveBias: direction,
          symbol: ctx.symbol,
          marketType: ctx.market,
        };
        const inferred = conn.inferStrategyForSignal(signal) || {};
        const decision = conn.canCreatePaperTradeForSignal(signal) || {};
        probes.push({
          subtype,
          entryCapable,
          market: ctx.market,
          mappedStrategyId: inferred.strategy_id || null,
          runtimeStatus: inferred.runtime_status || null,
          paperAllowed: decision.allowed === true,
          blockedReasonCode: decision.blocked_reason_code || null,
        });
      } catch (err) {
        probes.push({ subtype, entryCapable, market: ctx.market, mappedStrategyId: null, error: err.message });
      }
    }
  }
  return { status: probes.some((p) => p.error) ? 'degraded' : 'ok', probes };
}

// ── Klassificering per strategi ───────────────────────────────────────────────

function baseIdWithoutVersionSuffix(id) {
  return String(id || '').replace(/_v\d+$/, '');
}

function nextActionFor(readiness, missingComponents) {
  switch (readiness) {
    case READINESS.READY_FOR_PAPER: return 'Kan paper-testas — övervaka utfall per trade.';
    case READINESS.READY_FOR_REPLAY: return 'Kör replay/batch-research. Paper kräver LONG_ONLY-beslut.';
    case READINESS.READY_FOR_BATCH: return 'Kör batch-research.';
    case READINESS.NEEDS_PRODUCER: return 'Bygg/anslut emitter i scannern innan vidare test (FAS D).';
    case READINESS.NEEDS_MAPPING: return 'Rätta signal→strategi-mappningen i runtime connectorn (FAS C).';
    case READINESS.NEEDS_RUNTIME_CONNECTOR: return 'Komplettera runtime-context i connectorn (FAS E).';
    case READINESS.NEEDS_APPROVAL_ALIGNMENT: return 'Kräver approval-/familyval-beslut av användaren (FAS F).';
    case READINESS.NEEDS_MARKET_CONTEXT: return 'Producera saknad marknadsdata/context innan test (FAS E).';
    case READINESS.INTENTIONALLY_DISABLED: return 'Medvetet avstängd — ingen åtgärd utan nytt beslut.';
    case READINESS.UNSUPPORTED: return 'Dublett/legacy — kandidat för arkivering, ingen testväg.';
    case READINESS.BROKEN: return 'Katalogposten är trasig — undersök manuellt.';
    default: return missingComponents.length ? `Åtgärda: ${missingComponents.join(', ')}` : 'Ingen åtgärd.';
  }
}

function paperBlockedReasonForTechnical(technicalReadiness, context = {}) {
  if (technicalReadiness === 'READY') return null;
  if (technicalReadiness === READINESS.NEEDS_PRODUCER) return 'paper_strategy_enabled_but_no_producer';
  if (technicalReadiness === READINESS.NEEDS_MAPPING) return 'unknown_strategy_mapping';
  if (technicalReadiness === READINESS.NEEDS_RUNTIME_CONNECTOR) return 'paper_strategy_enabled_but_runtime_blocked';
  if (technicalReadiness === READINESS.NEEDS_MARKET_CONTEXT) return context.runtimeBlockedReason || 'missing_market_context';
  if (technicalReadiness === READINESS.NEEDS_ENTRY_CONTRACT) return 'paper_strategy_enabled_but_entry_contract_missing';
  if (technicalReadiness === READINESS.UNSUPPORTED) return 'unsupported_strategy';
  if (technicalReadiness === READINESS.INTENTIONALLY_DISABLED) {
    return context.intentionalPaperBlock
      ? 'paper_strategy_enabled_but_entry_contract_missing'
      : 'intentionally_disabled';
  }
  if (technicalReadiness === READINESS.BROKEN) return 'broken_strategy';
  return 'paper_strategy_enabled_but_runtime_blocked';
}

function classifyStrategy(strategy, sourcesData) {
  const {
    catalogIds,
    producerRegistry,
    approval,
    runtime,
    mapping,
    manual = { status: 'missing', manualMode: false, byId: new Map() },
  } = sourcesData;
  const id = strategy.id;
  const runtimeRow = runtime.rowsById.get(id) || null;
  const approvalRow = approval.byId.get(id) || null;
  const manualRow = manual.byId.get(id) || null;

  const warnings = [];
  const missingComponents = [];
  const entrySubtypeSet = new Set(producerRegistry.entrySubtypes);

  // Mapping-vy: vilka entry-kapabla subtyper landar på denna strategi?
  const wonProbes = mapping.probes.filter((p) => p.entryCapable && p.mappedStrategyId === id);
  const producedSubtypes = [...new Set(wonProbes.map((p) => p.subtype))];
  const rawSignals = arr(runtimeRow && runtimeRow.runtime_raw_signals);
  const producibleRawSignals = rawSignals.filter((s) => entrySubtypeSet.has(s));
  const shadowedSubtypes = producibleRawSignals
    .filter((s) => !producedSubtypes.includes(s))
    .map((subtype) => {
      const winners = [...new Set(mapping.probes
        .filter((p) => p.subtype === subtype && p.mappedStrategyId && p.mappedStrategyId !== id)
        .map((p) => p.mappedStrategyId))];
      return { subtype, wonBy: winners[0] || null, allWinners: winners };
    });

  // Catch-all-risk: strategin tar emot non-entry-signaler (UNKNOWN/NO_TRADE m.fl.).
  const catchAllProbes = mapping.probes.filter((p) => !p.entryCapable && p.mappedStrategyId === id
    && (p.subtype === 'UNKNOWN' || p.subtype === 'NO_TRADE'));
  if (catchAllProbes.length) warnings.push('catch_all_mapping_risk');

  const producerStatus = producedSubtypes.length ? 'ok' : 'none';
  const mappingStatus = producedSubtypes.length
    ? (shadowedSubtypes.length ? 'partial_shadowed' : 'ok')
    : (shadowedSubtypes.length ? 'shadowed' : (rawSignals.length ? 'no_producible_signal' : 'unmapped'));
  for (const shadow of shadowedSubtypes) {
    warnings.push(`signal_shadowed_by_${shadow.wonBy || 'unknown'}`);
  }

  // Riktning: katalog vs faktiskt producerade subtyper.
  const catalogDirection = strategy.direction || null;
  const effectiveDirections = [...new Set(
    producedSubtypes.map((s) => producerRegistry.directions[s]).filter(Boolean),
  )];
  if (catalogDirection === 'both' && effectiveDirections.length === 1 && effectiveDirections[0] !== 'both') {
    warnings.push('effective_direction_drift');
  }
  const shortOnly = catalogDirection === 'short';
  if (shortOnly) warnings.push('short_only_strategy');

  if (!strategy.family) {
    warnings.push('missing_family');
    warnings.push('singleton_family_selection_risk');
  }

  // Approval/familyval (read-only rapportering).
  const approved = approvalRow ? approvalRow.approved : null;
  const approvalStatus = approvalRow
    ? (approvalRow.approved ? 'approved'
      : approvalRow.gateBlockedReason === 'paper_strategy_paused' ? 'paused'
      : approvalRow.gateBlockedReason === 'paper_strategy_removed' ? 'removed'
      : 'not_approved')
    : null;
  const selectedInFamily = approvalRow ? approvalRow.gateAllowed === true
    || (approvalRow.approved && !String(approvalRow.gateBlockedReason || '').includes('family_not_selected')
        && !String(approvalRow.gateBlockedReason || '').includes('not_ready'))
    : null;
  const selectedStrategyId = approvalRow ? approvalRow.selectedStrategyId : null;
  const familySelectionMismatch = approvalRow
    ? approvalRow.approved === true && String(approvalRow.gateBlockedReason || '').includes('family_not_selected')
    : null;
  if (familySelectionMismatch) warnings.push('family_selection_mismatch');

  // Runtime connector.
  const runtimeConnectorStatus = runtimeRow ? runtimeRow.runtime_status : null;
  const requiredContext = arr(runtimeRow && runtimeRow.required_data);
  const missingContext = arr(runtimeRow && runtimeRow.missing_data);
  const enabledByUser = runtimeRow ? runtimeRow.enabled_by_user !== false : true;
  const ownProbe = wonProbes[0] || null;
  const runtimeBlockedReason = runtimeRow && runtimeRow.runtime_status !== 'active'
    ? (runtimeRow.blocked_reason_code || null)
    : (ownProbe && !ownProbe.paperAllowed ? ownProbe.blockedReasonCode : null);

  // Intentional block: alla producerade subtyper är medvetet icke-paper-entries.
  const intentionalPaperBlock = wonProbes.length > 0
    && wonProbes.every((p) => !p.paperAllowed && INTENTIONAL_PAPER_BLOCK_REASONS.has(p.blockedReasonCode || ''));
  if (intentionalPaperBlock) warnings.push('intentional_paper_block');

  // Approval mismatch: fungerande producer + runtime men inte godkänd.
  // Policy-pausade/borttagna strategier är ett beslut, inte en mismatch.
  const runtimeActive = runtimeConnectorStatus === 'active';
  const approvalMismatch = approvalRow
    ? producerStatus === 'ok' && runtimeActive && !intentionalPaperBlock
      && approvalRow.approved !== true && approvalStatus === 'not_approved'
    : null;
  if (approvalMismatch) warnings.push('approval_mismatch');

  // Dubblett-/legacy-detektion (evidensbaserad, ingen hårdkodad lista):
  //  a) versionssuffix vars bas-id också finns i katalogen (narrow_breakout_v1)
  //  b) experimentell, ej godkänd strategi vars samtliga producerbara signaler
  //     vinns av en annan strategi (narrow_state_fakeout_reversal)
  const baseId = baseIdWithoutVersionSuffix(id);
  const suffixDuplicate = baseId !== id && catalogIds.has(baseId) && producerStatus === 'none' && rawSignals.length === 0;
  const shadowDuplicate = producerStatus === 'none'
    && shadowedSubtypes.length > 0
    && strategy.status === 'experimental'
    && approved !== true;
  if (suffixDuplicate) warnings.push(`duplicate_of_${baseId}`);
  if (shadowDuplicate) warnings.push(`duplicate_signal_contract_with_${shadowedSubtypes[0].wonBy || 'unknown'}`);

  const catalogDisabled = strategy.status === 'paused' || strategy.status === 'archived' || strategy.status === 'removed';
  const userDisabled = !enabledByUser || runtimeConnectorStatus === 'disabled';

  const missingCrypto = missingContext.includes('crypto_signal_context');
  const missingMarket = missingContext.filter((m) => m !== 'crypto_signal_context');

  // ── Technical readiness: excludes approval/family and manual selection ────
  let technicalReadiness;
  if (!id) {
    technicalReadiness = READINESS.BROKEN;
  } else if (suffixDuplicate || shadowDuplicate) {
    technicalReadiness = READINESS.UNSUPPORTED;
  } else if (catalogDisabled || userDisabled) {
    technicalReadiness = READINESS.INTENTIONALLY_DISABLED;
  } else if (intentionalPaperBlock) {
    technicalReadiness = READINESS.INTENTIONALLY_DISABLED;
  } else if (producerStatus === 'none') {
    if (missingCrypto) {
      technicalReadiness = READINESS.NEEDS_RUNTIME_CONNECTOR;
      missingComponents.push('runtime_context:crypto_signal_context');
    } else if (missingMarket.length) {
      technicalReadiness = READINESS.NEEDS_MARKET_CONTEXT;
      for (const m of missingMarket) missingComponents.push(`market_context:${m}`);
      missingComponents.push('producer');
    } else if (mappingStatus === 'unmapped' || mappingStatus === 'shadowed') {
      technicalReadiness = READINESS.NEEDS_MAPPING;
      missingComponents.push('mapping');
    } else {
      technicalReadiness = READINESS.NEEDS_PRODUCER;
      missingComponents.push('producer');
    }
  } else if (missingCrypto) {
    technicalReadiness = READINESS.NEEDS_RUNTIME_CONNECTOR;
    missingComponents.push('runtime_context:crypto_signal_context');
  } else if (!runtimeActive) {
    technicalReadiness = READINESS.NEEDS_MARKET_CONTEXT;
    for (const m of missingMarket) missingComponents.push(`market_context:${m}`);
  } else {
    technicalReadiness = 'READY';
  }

  // ── Primär readiness (mode-dependent) ─────────────────────────────────────
  const manualMode = manual.manualMode === true;
  const enabledForPaper = manualRow ? manualRow.enabled === true : false;
  const manualSelectionStatus = enabledForPaper ? 'enabled' : 'disabled';
  let readiness;
  if (manualMode) {
    if (technicalReadiness === 'READY') {
      readiness = enabledForPaper && !shortOnly ? READINESS.READY_FOR_PAPER : READINESS.READY_FOR_REPLAY;
    } else {
      readiness = technicalReadiness;
    }
  } else if (technicalReadiness !== 'READY') {
    if ((approvalStatus === 'paused' || approvalStatus === 'removed')
        && technicalReadiness !== READINESS.UNSUPPORTED
        && technicalReadiness !== READINESS.BROKEN) {
      // Legacy mode still treats explicit approval-store pauses/removals as the
      // primary paper readiness state. Manual mode reports them only as audit.
      readiness = READINESS.INTENTIONALLY_DISABLED;
    } else {
      readiness = technicalReadiness;
    }
  } else if (approvalStatus === 'paused' || approvalStatus === 'removed') {
    readiness = READINESS.INTENTIONALLY_DISABLED;
  } else if (approved !== true || familySelectionMismatch) {
    readiness = READINESS.NEEDS_APPROVAL_ALIGNMENT;
    if (approved !== true) missingComponents.push('approval');
    if (familySelectionMismatch) missingComponents.push('family_selection');
  } else if (shortOnly) {
    // Full legacy chain but short-only: research-ready, not paper-ready.
    readiness = READINESS.READY_FOR_REPLAY;
    warnings.push('paper_short_leak');
  } else {
    readiness = READINESS.READY_FOR_PAPER;
  }

  // Vald familjestrategi som blockerar en producerkapabel syskonstrategi
  // (t.ex. trend_continuation vald men intentionally disabled för paper).
  if (intentionalPaperBlock && approvalRow && approvalRow.approved && selectedInFamily) {
    warnings.push('selected_strategy_blocks_family');
  }

  // ── Eligibility-fält (kan ha flera samtidigt) ──────────────────────────────
  const replayEligibility = producerStatus === 'ok' ? 'READY' : 'NOT_READY';
  const batchEligibility = 'SYNTHETIC_ONLY'; // deterministicTestResult — ingen verklig validering
  let paperEligibility;
  let paperBlockedReason = null;
  if (manualMode) {
    if (!enabledForPaper) {
      paperEligibility = 'DISABLED_BY_USER';
      paperBlockedReason = 'paper_strategy_not_enabled';
    } else if (technicalReadiness !== 'READY') {
      paperEligibility = 'BLOCKED';
      paperBlockedReason = paperBlockedReasonForTechnical(technicalReadiness, {
        runtimeBlockedReason,
        intentionalPaperBlock,
      });
    } else if (shortOnly) {
      paperEligibility = 'BLOCKED';
      paperBlockedReason = 'long_only_short_strategy';
    } else {
      paperEligibility = 'READY';
    }
  } else if (readiness === READINESS.READY_FOR_PAPER) {
    paperEligibility = 'READY';
  } else if (readiness === READINESS.READY_FOR_REPLAY && shortOnly) {
    paperEligibility = 'TECHNICALLY_ALLOWED_BUT_LONG_ONLY_INCOMPATIBLE';
    paperBlockedReason = 'long_only_short_strategy';
  } else {
    paperEligibility = 'BLOCKED';
    paperBlockedReason = paperBlockedReasonForTechnical(technicalReadiness, {
      runtimeBlockedReason,
      intentionalPaperBlock,
    });
  }

  return {
    strategyId: id,
    displayName: strategy.name || id,
    family: strategy.family || null,
    direction: catalogDirection,
    catalogStatus: strategy.status || null,
    enabledForPaper,
    manualSelectionStatus,
    technicalReadiness,
    producerStatus,
    producedSubtypes,
    mappingStatus,
    mappedSubtypes: wonProbes.map((p) => ({ subtype: p.subtype, market: p.market, paperAllowed: p.paperAllowed, blockedReasonCode: p.blockedReasonCode })),
    shadowedSubtypes,
    runtimeConnectorStatus,
    runtimeBlockedReason,
    requiredContext,
    missingContext,
    approvalStatus,
    legacyApprovalStatus: approvalStatus,
    approved,
    approvalMismatch,
    selectedInFamily,
    legacySelectedInFamily: selectedInFamily,
    selectedStrategyId,
    familySelectionMismatch,
    effectiveDirections,
    replayEligibility,
    batchEligibility,
    paperEligibility,
    paperBlockedReason,
    readiness,
    missingComponents,
    nextAction: nextActionFor(readiness, missingComponents),
    evidence: {
      rawSignals,
      paperTrades48h: (runtimeRow && runtimeRow.paper_trades_48h) || 0,
      lastPaperTradeAt: (runtimeRow && runtimeRow.last_paper_trade_at) || null,
      runtimeCommentSv: (runtimeRow && runtimeRow.runtime_comment_sv) || null,
    },
    syntheticBatch: true,
    warnings: [...new Set(warnings)],
    runtimeGateMode: manualMode ? 'manual' : 'legacy',
    manualListControlsRuntime: manualMode,
    ...SAFETY,
  };
}

// ── Publikt API ───────────────────────────────────────────────────────────────

function buildSummary(rows) {
  const count = (readiness) => rows.filter((r) => r.readiness === readiness).length;
  return {
    total: rows.length,
    readyForPaper: count(READINESS.READY_FOR_PAPER),
    readyForReplay: count(READINESS.READY_FOR_REPLAY),
    readyForBatch: count(READINESS.READY_FOR_BATCH),
    needsProducer: count(READINESS.NEEDS_PRODUCER),
    needsMapping: count(READINESS.NEEDS_MAPPING),
    needsRuntimeConnector: count(READINESS.NEEDS_RUNTIME_CONNECTOR),
    needsApprovalAlignment: count(READINESS.NEEDS_APPROVAL_ALIGNMENT),
    needsMarketContext: count(READINESS.NEEDS_MARKET_CONTEXT),
    needsEntryContract: count(READINESS.NEEDS_ENTRY_CONTRACT),
    needsCostModel: count(READINESS.NEEDS_COST_MODEL),
    needsMoreTesting: count(READINESS.NEEDS_MORE_TESTING),
    intentionallyDisabled: count(READINESS.INTENTIONALLY_DISABLED),
    unsupported: count(READINESS.UNSUPPORTED),
    broken: count(READINESS.BROKEN),
    enabledForPaper: rows.filter((r) => r.enabledForPaper === true).length,
    technicalReady: rows.filter((r) => r.technicalReadiness === 'READY').length,
    paperEligible: rows.filter((r) => r.paperEligibility === 'READY').length,
    disabledByUser: rows.filter((r) => r.paperEligibility === 'DISABLED_BY_USER').length,
    paperBlocked: rows.filter((r) => r.paperEligibility === 'BLOCKED').length,
  };
}

function computeStrategyReadiness() {
  const catalog = loadCatalogSource();
  const producerRegistry = loadProducerRegistry();
  const approval = loadApprovalSource(catalog.strategies);
  const manual = loadManualEnabledSource(catalog.strategies);
  const runtime = loadRuntimeSource();
  const mapping = probeMappings(producerRegistry, runtime);

  const catalogIds = new Set(catalog.strategies.map((s) => s.id));
  const sourcesData = { catalogIds, producerRegistry, approval, manual, runtime, mapping };

  const strategies = catalog.strategies.map((strategy) => {
    try {
      return classifyStrategy(strategy, sourcesData);
    } catch (err) {
      return {
        strategyId: strategy.id || null,
        displayName: strategy.name || strategy.id || 'unknown',
        family: strategy.family || null,
        readiness: READINESS.BROKEN,
        missingComponents: ['classification_error'],
        warnings: [`classification_error:${err.message}`],
        syntheticBatch: true,
        ...SAFETY,
      };
    }
  });

  return {
    status: catalog.status === 'ok' ? 'ok' : 'degraded',
    generatedAt: new Date().toISOString(),
    runtimeGateMode: manual.manualMode ? 'manual' : 'legacy',
    manualListControlsRuntime: manual.manualMode === true,
    summary: buildSummary(strategies),
    strategies,
    sources: {
      catalog: { status: catalog.status },
      producerRegistry: { status: producerRegistry.status },
      approvalStore: { status: approval.status },
      manualEnabledStore: { status: manual.status },
      runtimeConnector: { status: runtime.status },
      mappingProbes: { status: mapping.status },
    },
    notes: {
      batch_sv: 'Batchmotorn är syntetisk (deterministicTestResult) — batchEligibility=SYNTHETIC_ONLY betyder att batch INTE validerar verklig entrylogik.',
      replay_sv: 'Replay driver scannerns producenter — endast strategier med verklig producent+mapping kan replay-testas.',
      readOnly_sv: 'Endpointen läser bara. Inga approvals, familyval, kandidater eller trades skapas.',
    },
    // Nästlat safety-objekt enligt endpoint-kontraktet (samma mönster som
    // t.ex. runtime-matrix), utöver de platta flaggorna från spreaden nedan.
    safety: SAFETY,
    ...SAFETY,
  };
}

function getStrategyReadiness(options = {}) {
  const now = Date.now();
  if (!options.noCache && _cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;
  const result = computeStrategyReadiness();
  _cache = result;
  _cacheAt = now;
  return result;
}

module.exports = {
  SAFETY,
  READINESS,
  getStrategyReadiness,
  computeStrategyReadiness,
  _internal: { classifyStrategy, buildSummary, probeMappings },
};
