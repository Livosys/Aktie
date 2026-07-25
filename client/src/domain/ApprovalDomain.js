import { firstValue } from '../models/strategyViewModel.js';
import { statusTone } from './StrategyDomain.js';

export function approvalState(source = {}) {
  const approvedValue = firstValue(source.approved, source.enabledForPaper, source.overview?.approved, source.overview?.enabledForPaper);
  const state = firstValue(
    source.approvalState,
    source.approval_state,
    source.approvalStatus,
    source.allowlist?.status,
    source.paperEligibility,
    source.candidate?.approvalState,
    source.candidate?.approvalStatus,
    source.candidate?.executionGate,
    source.overview?.approvalStatus,
    approvedValue === true ? 'approved' : (approvedValue === false ? 'not_approved' : null),
  );
  return {
    state,
    tone: statusTone(state),
  };
}

export function approvalBadge(source = {}) {
  const approval = approvalState(source);
  return {
    label: approval.state || null,
    tone: approval.tone,
  };
}

export function approvalReason(source = {}) {
  return firstValue(
    source.approvalReason,
    source.approval_reason,
    source.allowlist?.reason,
    source.paperEligibilityReason,
    source.candidate?.approvalReason,
  );
}

export function approvalSummary(source = {}) {
  const approval = approvalState(source);
  return {
    ...approval,
    reason: approvalReason(source) || null,
    approved: approval.state === 'approved',
  };
}
