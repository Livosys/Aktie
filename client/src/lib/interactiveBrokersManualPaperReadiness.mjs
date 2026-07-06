const CANONICAL_BRACKET_READINESS_ROUTE = '/api/interactive-brokers/paper-execute/protective-preflight';

function classifyBracketReadinessStatus(payload, error = null) {
  if (error) return 'error';
  if (!payload) return 'idle';
  if (payload.blockedReason === 'bracket_readiness_route_not_found') return 'error';
  if (payload.httpStatus === 401 || payload.httpStatus === 403) return 'error';
  if (payload.error || payload.accepted === false) {
    return (payload.blockedReason || (Array.isArray(payload.blockers) && payload.blockers.length > 0)) ? 'blocked' : 'error';
  }
  if (
    payload.bracketSubmissionPlanReady === true
    && Number(payload.bracketOrderCount || payload.orderCount || 0) === 3
    && payload.entryOnlyBlocked === true
    && (payload.protectivePlanReady === true || payload.protectiveExecutionReady === true || payload.helperReady === true || payload.readyForFirstPaperOrder === true)
  ) {
    return 'ready';
  }
  if (payload.blockedReason || (Array.isArray(payload.blockers) && payload.blockers.length > 0)) {
    return 'blocked';
  }
  return 'idle';
}

function buildBracketReadinessRequest(selectedBlueprint = null, preflightResult = null) {
  const preflightBlueprint = preflightResult?.selectedBlueprintVerification?.selectedBlueprint || preflightResult?.selectedBlueprint || null;
  const selectedBlueprintHasIdentity = Boolean(
    selectedBlueprint
      && typeof selectedBlueprint === 'object'
      && (selectedBlueprint.symbol || selectedBlueprint.blueprintId || selectedBlueprint.candidateId)
      && String(selectedBlueprint.symbol || '').toLowerCase() !== 'none',
  );
  const requestBlueprint = selectedBlueprintHasIdentity ? selectedBlueprint : preflightBlueprint;
  return {
    url: CANONICAL_BRACKET_READINESS_ROUTE,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        blueprintId: requestBlueprint?.blueprintId || null,
        candidateId: requestBlueprint?.candidateId || null,
        selectedBlueprintId: requestBlueprint?.blueprintId || null,
        selectedBlueprint: requestBlueprint || null,
        selectedBlueprintVerification: preflightResult?.selectedBlueprintVerification || null,
        sessionVerification: preflightResult?.sessionVerification || preflightResult?.readinessVerification || null,
        preflightSessionVerification: preflightResult?.sessionVerification || preflightResult?.readinessVerification || null,
        preflightReady: preflightResult?.readyForFirstPaperOrder === true || preflightResult?.accepted === true,
        preflightAccepted: preflightResult?.accepted === true,
        preflightGeneratedAt: preflightResult?.generatedAt || preflightResult?.loadedAt || preflightResult?.preflightGeneratedAt || Date.now(),
        preflightRequestId: preflightResult?.requestId || preflightResult?.preflightRequestId || null,
        dryRun: true,
        preflightOnly: true,
      }),
    },
  };
}

function mapBracketReadinessHttpError(status, message = '') {
  if (Number(status) === 404 || /^HTTP 404$/i.test(String(message || ''))) {
    return {
      status: 'error',
      blockedReason: 'bracket_readiness_route_not_found',
    };
  }
  if (Number(status) === 401 || Number(status) === 403 || /^HTTP (401|403)$/i.test(String(message || ''))) {
    return {
      status: 'error',
      blockedReason: 'bracket_readiness_auth_required',
    };
  }
  if (/^timeout_after_\d+ms$/i.test(String(message || ''))) {
    return {
      status: 'error',
      blockedReason: message,
    };
  }
  return {
    status: 'error',
    blockedReason: String(message || 'protective_readiness_error'),
  };
}

function readinessFalseLabel(status, fallback = 'Inte redo') {
  if (status === 'idle') return 'Ej körd';
  if (status === 'loading') return 'Laddar';
  if (status === 'blocked') return 'Blockerad';
  if (status === 'error') return 'Fel';
  return fallback;
}

export {
  CANONICAL_BRACKET_READINESS_ROUTE,
  classifyBracketReadinessStatus,
  buildBracketReadinessRequest,
  mapBracketReadinessHttpError,
  readinessFalseLabel,
};

export default {
  CANONICAL_BRACKET_READINESS_ROUTE,
  classifyBracketReadinessStatus,
  buildBracketReadinessRequest,
  mapBracketReadinessHttpError,
  readinessFalseLabel,
};
