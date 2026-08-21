'use strict';

const nativeRegistry = require('./nativeFuturesStrategyRegistryService');
const paperEnabledStrategies = require('./paperEnabledStrategiesService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  executionTarget: 'ibkr_paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'futures_paper_strategy_policy',
});

function text(value) {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function resolveIdentity(strategyId, registry = nativeRegistry) {
  const requestedId = text(strategyId);
  const descriptor = requestedId && typeof registry.getNativeStrategy === 'function'
    ? (registry.getNativeStrategy(requestedId)
      || (typeof registry.soleNativeStrategyForOrigin === 'function'
        ? registry.soleNativeStrategyForOrigin(requestedId)
        : null))
    : null;
  const canonicalStrategyId = descriptor?.originStrategyId || requestedId;
  return {
    requestedStrategyId: requestedId,
    nativeStrategyId: descriptor?.strategyId || (requestedId && registry.isNativeStrategyId(requestedId) ? requestedId : null),
    canonicalStrategyId,
    strategyVersion: descriptor?.strategyVersion || null,
    originStrategyId: descriptor?.originStrategyId || null,
    strategyFamily: descriptor?.targetSignalFamily || null,
    signalSubtype: descriptor?.targetSignalSubtype || null,
    nativeRegistered: Boolean(descriptor),
    nativeOnly: Boolean(descriptor && !descriptor.originStrategyId),
  };
}

function evaluateStrategy(strategyId, { fresh = true, enabledService = paperEnabledStrategies } = {}) {
  const identity = resolveIdentity(strategyId);
  const list = enabledService.buildPaperStrategyList({ fresh });
  const row = (list.strategies || []).find((item) => item.strategyId === identity.canonicalStrategyId) || null;
  const enabled = row?.enabledForPaper === true;
  const ready = row?.paperEligibility === 'READY';
  let blockedReason = null;
  if (!identity.requestedStrategyId) blockedReason = 'strategy_id_missing';
  else if (!identity.nativeRegistered) blockedReason = 'strategy_not_registered_for_futures';
  else if (identity.nativeOnly) blockedReason = 'native_strategy_has_no_canonical_approval_identity';
  else if (!row) blockedReason = 'canonical_strategy_not_in_paper_catalog';
  else if (!enabled) blockedReason = 'paper_strategy_not_enabled';
  else if (!ready) blockedReason = row.paperBlockedReason || 'paper_strategy_not_ready';
  return {
    ok: blockedReason == null,
    allowed: blockedReason == null,
    blockedReason,
    identity,
    approval: {
      source: 'paperEnabledStrategiesService',
      enabled,
      readiness: row?.readiness || row?.technicalReadiness || null,
      paperEligibility: row?.paperEligibility || null,
      entryContractReady: row?.entryContractReady === true,
    },
    row,
    ...SAFETY,
  };
}

function annotateCandidate(candidate = {}, options = {}) {
  const decision = evaluateStrategy(candidate.strategyId || candidate.strategy_id, options);
  return {
    ...candidate,
    canonicalStrategyId: decision.identity.canonicalStrategyId,
    nativeStrategyId: decision.identity.nativeStrategyId,
    originStrategyId: decision.identity.originStrategyId,
    strategyVersion: candidate.strategyVersion || decision.identity.strategyVersion,
    strategyFamily: candidate.strategyFamily || decision.identity.strategyFamily,
    paperApproval: {
      allowed: decision.allowed,
      blockedReason: decision.blockedReason,
      canonicalStrategyId: decision.identity.canonicalStrategyId,
      source: decision.approval.source,
    },
  };
}

module.exports = {
  SAFETY,
  resolveIdentity,
  evaluateStrategy,
  annotateCandidate,
};
