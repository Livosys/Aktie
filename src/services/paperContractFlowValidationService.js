'use strict';

const fs = require('fs');
const path = require('path');

const strategyRuntimeConnector = require('./strategyRuntimeConnectorService');
const paperEnabledStrategies = require('./paperEnabledStrategiesService');
const paperStrategyEntryContracts = require('./paperStrategyEntryContractService');
const strategyTradeControl = require('./strategyTradeControlService');
const daytradingStrategyCatalog = require('./daytradingStrategyCatalogService');
const strategyReadinessService = require('./strategyReadinessService');
const { evaluateMarketGate } = require('../markets/marketGate');
const paperAgent = require('../paperTrading/paperTradingAgent');

const ROOT = path.resolve(__dirname, '../..');
const STATE_FILE = path.join(ROOT, 'data/paper-trading/state.json');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function readState(file = STATE_FILE) {
  try {
    if (!fs.existsSync(file)) return { openTrades: [], cooldowns: {}, strategyCooldowns: {}, familyCooldowns: {}, seenSignalIds: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      openTrades: arr(parsed.openTrades),
      cooldowns: parsed.cooldowns || {},
      strategyCooldowns: parsed.strategyCooldowns || {},
      familyCooldowns: parsed.familyCooldowns || {},
      seenSignalIds: arr(parsed.seenSignalIds),
      conservativeMode: parsed.conservativeMode === true,
    };
  } catch (_) {
    return { openTrades: [], cooldowns: {}, strategyCooldowns: {}, familyCooldowns: {}, seenSignalIds: [], degraded: true };
  }
}

function strategyIdFromRuntimeStrategy(strategy = {}) {
  return strategy.strategy_id
    || strategy.strategyId
    || strategy.resolvedStrategyId
    || strategy.canonicalStrategyId
    || null;
}

function gate(status, reasonCode = null, extra = {}) {
  return { status, reasonCode, ...extra };
}

function scoreOf(row = {}) {
  const n = Number(row.confidenceScore ?? row.confidence ?? row.score);
  return Number.isFinite(n) ? n : 0;
}

function familyOf(row = {}, strategyId = null) {
  return paperAgent._internal.paperCandidateFamily(row, strategyId);
}

function getReadyForPaperStrategyIds(options = {}) {
  if (Array.isArray(options.activeStrategyIds)) {
    return options.activeStrategyIds.map(String).filter(Boolean);
  }
  try {
    return arr(strategyReadinessService.getStrategyReadiness({ noCache: true }).strategies)
      .filter((row) => row.readiness === 'READY_FOR_PAPER')
      .map((row) => row.strategyId)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function summarizeRows(rows, activeStrategyIds = []) {
  const activeSet = new Set(activeStrategyIds);
  const byStop = {};
  const byStrategyId = {};
  for (const row of rows) {
    const stop = row.stopAt || 'unknown';
    byStop[stop] = (byStop[stop] || 0) + 1;
    const strategyId = row.strategyId || 'unmapped';
    if (!byStrategyId[strategyId]) {
      byStrategyId[strategyId] = {
        strategyId,
        candidates: 0,
        producerReady: 0,
        manualPass: 0,
        runtimePass: 0,
        controlPass: 0,
        contractPass: 0,
        qualifiesPass: 0,
        marketGatePass: 0,
        stopped: {},
      };
    }
    const bucket = byStrategyId[strategyId];
    bucket.candidates += 1;
    if (row.producer?.entryReady) bucket.producerReady += 1;
    if (row.gates.manual?.status === 'pass') bucket.manualPass += 1;
    if (row.gates.runtimeConnector?.status === 'pass') bucket.runtimePass += 1;
    if (row.gates.strategyControl?.status === 'pass') bucket.controlPass += 1;
    if (row.gates.entryContract?.status === 'pass') bucket.contractPass += 1;
    if (row.gates.qualifiesForEntry?.status === 'pass') bucket.qualifiesPass += 1;
    if (row.gates.marketGate?.status === 'pass') bucket.marketGatePass += 1;
    bucket.stopped[stop] = (bucket.stopped[stop] || 0) + 1;
  }
  return {
    totalCandidates: rows.length,
    activeStrategyCandidates: rows.filter((row) => activeSet.has(row.strategyId)).length,
    producerReady: rows.filter((row) => row.producer?.entryReady).length,
    contractPass: rows.filter((row) => row.gates.entryContract?.status === 'pass').length,
    contractBlock: rows.filter((row) => row.gates.entryContract?.status === 'block').length,
    marketGatePass: rows.filter((row) => row.gates.marketGate?.status === 'pass').length,
    byStop,
    byStrategyId,
  };
}

function buildContractFlowValidation(options = {}) {
  const now = options.now || new Date();
  const candidates = arr(options.candidates);
  const activeStrategyIds = getReadyForPaperStrategyIds(options);
  const activeStrategySet = new Set(activeStrategyIds);
  const state = options.state || readState(options.stateFile);
  const familyRanks = paperAgent._internal.rankEntryEligibleFamilyCandidates(candidates, {
    manualStrategyGateMode: paperEnabledStrategies.manualListControlsRuntime(),
    now,
  });

  const rows = candidates.map((candidate) => {
    const gates = {};
    let stopAt = null;
    let inferredStrategy = null;
    let runtimeDecision = null;
    let runtimeCandidate = { ...candidate };
    let resolvedStrategyId = null;
    let runtimeStrategy = null;

    const row = {
      symbol: candidate.symbol || null,
      marketType: candidate.marketType || candidate.market || null,
      signalSubtype: candidate.signalSubtype || null,
      signalFamily: candidate.signalFamily || null,
      status: candidate.status || null,
      nextMoveBias: candidate.nextMoveBias || null,
      confidenceScore: candidate.confidenceScore ?? null,
      strategyId: null,
      activeStrategy: false,
      producer: {
        version: candidate.producerConfirmationVersion || null,
        entryReady: candidate.producerEntryReadiness?.entryReady === true,
        status: candidate.producerEntryReadiness?.status || null,
        confirmationObserved: arr(candidate.producerEntryReadiness?.confirmationObserved),
        missingConfirmations: arr(candidate.producerEntryReadiness?.missingConfirmations),
        blockers: arr(candidate.producerEntryReadiness?.blockers),
      },
      gates,
      stopAt: null,
      safety: SAFETY,
      ...SAFETY,
    };

    gates.producerSubtype = candidate.signalSubtype && !['UNKNOWN', 'NO_TRADE'].includes(String(candidate.signalSubtype).toUpperCase())
      ? gate('pass')
      : gate('block', String(candidate.signalSubtype || 'unknown_signal_mapping').toLowerCase());
    if (gates.producerSubtype.status === 'block') stopAt = 'producerSubtype';

    if (!stopAt) {
      try {
        inferredStrategy = strategyRuntimeConnector.inferStrategyForSignal(candidate);
        resolvedStrategyId = strategyIdFromRuntimeStrategy(inferredStrategy);
        row.strategyId = resolvedStrategyId || null;
        row.activeStrategy = activeStrategySet.has(row.strategyId);
        gates.canonicalMapping = resolvedStrategyId
          ? gate('pass', null, { strategyId: resolvedStrategyId, runtimeStatus: inferredStrategy.runtime_status || null })
          : gate('block', inferredStrategy?.blocked_reason_code || 'unknown_strategy_mapping');
      } catch (err) {
        gates.canonicalMapping = gate('block', 'runtime_mapping_error', { error: err.message });
      }
      if (gates.canonicalMapping.status === 'block') stopAt = 'canonicalMapping';
    }

    if (!stopAt) {
      const catalogStrategy = daytradingStrategyCatalog.getStrategyById(resolvedStrategyId);
      gates.catalog = catalogStrategy ? gate('pass') : gate('block', 'unknown_canonical_strategy');
      if (gates.catalog.status === 'block') stopAt = 'catalog';
    }

    if (!stopAt) {
      const manualState = paperEnabledStrategies.getStrategyState(resolvedStrategyId);
      gates.manual = manualState.enabled === true
        ? gate('pass', null, { enabledForPaper: true })
        : gate('block', manualState.known === true ? 'paper_strategy_not_enabled' : 'unknown_canonical_strategy', { enabledForPaper: false });
      if (gates.manual.status === 'block') stopAt = 'manual';
    }

    if (!stopAt) {
      runtimeDecision = strategyRuntimeConnector.canCreatePaperTradeForSignal(candidate);
      runtimeStrategy = runtimeDecision.strategy || inferredStrategy || {};
      gates.runtimeConnector = runtimeDecision.allowed === true
        ? gate('pass', null, { runtimeStatus: runtimeStrategy.runtime_status || null })
        : gate('block', runtimeDecision.blocked_reason_code || runtimeDecision.reason || 'runtime_blocked');
      if (gates.runtimeConnector.status === 'block') stopAt = 'runtimeConnector';
      runtimeCandidate = paperAgent._internal.normalizeCandidateStrategyMetadata(candidate, runtimeDecision);
    }

    if (!stopAt) {
      const longOnly = paperAgent._internal.evaluateLongOnlyPaperGate(
        runtimeCandidate,
        daytradingStrategyCatalog.getStrategyById(resolvedStrategyId),
      );
      gates.longOnly = longOnly.allowed === true
        ? gate('pass')
        : gate('block', longOnly.blockedReason || 'long_only_blocked');
      if (gates.longOnly.status === 'block') stopAt = 'longOnly';
    }

    if (!stopAt) {
      const familyMeta = familyRanks.get(candidate) || {};
      const controlFamily = familyOf(runtimeCandidate, resolvedStrategyId);
      const familyHasOpenPosition = Boolean(controlFamily) && arr(state.openTrades).some((trade) => (
        (trade.strategyFamily || familyOf(trade)) === controlFamily
      ));
      const control = strategyTradeControl.evaluateStrategyTradeControl({
        strategyId: resolvedStrategyId || null,
        strategyName: runtimeStrategy?.strategy_name || null,
        strategyFamily: controlFamily,
        familyRank: familyMeta.strategyFamily === controlFamily ? familyMeta.familyRank : null,
        lastTradeAt: resolvedStrategyId ? (state.strategyCooldowns || {})[resolvedStrategyId] : null,
        familyHasOpenPosition,
        familyLastTradeAt: controlFamily ? (state.familyCooldowns || {})[controlFamily] : null,
        config: strategyTradeControl.getStrategyTradeControlConfig(),
      });
      gates.strategyControl = control.allowed === true
        ? gate('pass', null, { strategyFamily: control.strategyFamily, familyRank: control.familyRank })
        : gate('block', control.blockReason || 'strategy_control_blocked', { strategyFamily: control.strategyFamily, familyRank: control.familyRank });
      if (gates.strategyControl.status === 'block') stopAt = 'strategyControl';
      runtimeCandidate.strategyFamily = control.strategyFamily;
      runtimeCandidate.familyRank = control.familyRank;
    }

    if (!stopAt) {
      const contractDecision = paperStrategyEntryContracts.evaluatePaperEntryContract({
        strategyId: resolvedStrategyId,
        candidate: runtimeCandidate,
        now,
        marketContext: {
          marketType: runtimeCandidate.marketType || runtimeCandidate.market,
          session: runtimeCandidate.session || runtimeCandidate.marketSession || null,
        },
      });
      gates.entryContract = contractDecision.allowed === true
        ? gate('pass', null, { entryContractVersion: contractDecision.entryContractVersion, evidence: contractDecision.evidence })
        : gate('block', contractDecision.reasonCode || 'entry_contract_blocked', { entryContractVersion: contractDecision.entryContractVersion, evidence: contractDecision.evidence });
      if (gates.entryContract.status === 'block') stopAt = 'entryContract';
      if (contractDecision.allowed === true) {
        runtimeCandidate.entryContractAllowed = true;
        runtimeCandidate.entryContractDecision = 'pass';
        runtimeCandidate.entryContractVersion = contractDecision.entryContractVersion;
        runtimeCandidate.entryContractChecks = contractDecision.checks || {};
        runtimeCandidate.entryContractEvidence = contractDecision.evidence || {};
      }
    }

    if (!stopAt) {
      const qualifies = paperAgent._internal.qualifiesForEntry(runtimeCandidate, state, {
        isExplicitlyEnabledStrategy: true,
        entryContractAllowed: runtimeCandidate.entryContractAllowed === true,
      });
      gates.qualifiesForEntry = qualifies.ok === true
        ? gate('pass')
        : gate('block', qualifies.reason || 'qualifies_for_entry_blocked');
      if (gates.qualifiesForEntry.status === 'block') stopAt = 'qualifiesForEntry';
    }

    if (!stopAt) {
      const marketGate = evaluateMarketGate(runtimeCandidate, {
        conservativeMode: state.conservativeMode || false,
        calibrationStats: { bySignalSubtype: {} },
      });
      gates.marketGate = marketGate.allowed === true
        ? gate('pass', null, { mode: marketGate.mode, gateScore: marketGate.gateScore, threshold: marketGate.threshold })
        : gate('block', marketGate.reasons?.[0] || marketGate.observeOnlyReasonSv || marketGate.warnings?.[0] || 'market_gate_blocked', {
          mode: marketGate.mode,
          gateScore: marketGate.gateScore,
          threshold: marketGate.threshold,
        });
      if (gates.marketGate.status === 'block') stopAt = 'marketGate';
    }

    gates.risk = stopAt ? gate('not_reached') : gate('not_evaluated_read_only', 'runtime_risk_gate_not_invoked_by_probe');
    gates.safety = stopAt ? gate('not_reached') : gate('not_evaluated_read_only', 'runtime_safety_gate_not_invoked_by_probe');
    row.stopAt = stopAt || 'paperCandidate';
    row.strategyId = row.strategyId || resolvedStrategyId || null;
    row.activeStrategy = activeStrategySet.has(row.strategyId);
    return row;
  });

  return {
    status: 'ok',
    generatedAt: nowIso(now),
    source: 'paperContractFlowValidationService',
    candidates: rows,
    summary: summarizeRows(rows, activeStrategyIds),
    activeStrategyIds,
    safety: SAFETY,
    ...SAFETY,
  };
}

module.exports = {
  SAFETY,
  buildContractFlowValidation,
  _internal: {
    readState,
    getReadyForPaperStrategyIds,
    summarizeRows,
  },
};
