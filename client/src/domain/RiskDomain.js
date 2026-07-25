import { firstValue } from '../models/strategyViewModel.js';
import { statusTone } from './StrategyDomain.js';

export function riskState(source = {}) {
  const state = firstValue(
    source.riskState,
    source.risk_state,
    source.riskStatus,
    source.riskSnapshot?.status,
    source.strategy?.riskState,
  );
  return {
    state,
    tone: statusTone(state),
  };
}

export function blockedReason(source = {}) {
  return firstValue(
    source.blockedReason,
    source.blocked_reason,
    source.paperBlockedReason,
    source.runtimeBlockedReason,
    source.riskSnapshot?.blockedReason,
    source.candidate?.blockedReason,
    source.candidate?.blockReason,
    source.overview?.mainBlocker,
  );
}

export function pauseReason(source = {}) {
  return firstValue(source.pauseReason, source.pausedReason, source.cooldownReason, blockedReason(source));
}

export function riskExposure(source = {}) {
  return firstValue(source.risk, source.riskUsd, source.openRisk, source.portfolio?.openRisk);
}

export function riskSummary(source = {}) {
  const risk = riskState(source);
  return {
    ...risk,
    blockedReason: blockedReason(source) || null,
    pauseReason: pauseReason(source) || null,
    exposure: riskExposure(source) ?? null,
  };
}
