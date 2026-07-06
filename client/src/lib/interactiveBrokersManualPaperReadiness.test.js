'use strict';

const assert = require('assert/strict');

(async () => {
  const readiness = await import('./interactiveBrokersManualPaperReadiness.mjs');

  assert.equal(readiness.CANONICAL_BRACKET_READINESS_ROUTE, '/api/interactive-brokers/paper-execute/protective-preflight');
  assert.equal(readiness.classifyBracketReadinessStatus(null), 'idle');
  assert.equal(readiness.classifyBracketReadinessStatus({}, new Error('boom')), 'error');
  assert.equal(readiness.classifyBracketReadinessStatus({
    bracketSubmissionPlanReady: true,
    bracketOrderCount: 3,
    entryOnlyBlocked: true,
    protectivePlanReady: true,
  }), 'ready');
  assert.equal(readiness.classifyBracketReadinessStatus({
    blockedReason: 'protective_bracket_submission_required',
    blockers: ['protective_bracket_submission_required'],
  }), 'blocked');
  assert.equal(readiness.readinessFalseLabel('idle'), 'Ej körd');
  assert.equal(readiness.readinessFalseLabel('loading'), 'Laddar');
  assert.equal(readiness.readinessFalseLabel('blocked'), 'Blockerad');
  assert.equal(readiness.readinessFalseLabel('error'), 'Fel');
  const request = readiness.buildBracketReadinessRequest(
    { blueprintId: 'bp-1', candidateId: 'cand-1' },
    { sessionVerification: { source: 'live_connection_readiness' }, selectedBlueprintVerification: { source: 'trade_blueprint' } },
  );
  assert.equal(request.url, '/api/interactive-brokers/paper-execute/protective-preflight');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'include');
  assert.equal(JSON.parse(request.options.body).blueprintId, 'bp-1');
  assert.equal(JSON.parse(request.options.body).sessionVerification.source, 'live_connection_readiness');
  assert.equal(JSON.parse(request.options.body).preflightSessionVerification.source, 'live_connection_readiness');
  assert.equal(JSON.parse(request.options.body).preflightReady, false);
  assert.equal(JSON.parse(request.options.body).preflightAccepted, false);
  assert.equal(typeof JSON.parse(request.options.body).preflightGeneratedAt, 'number');
  assert.equal(JSON.parse(request.options.body).selectedBlueprintVerification.source, 'trade_blueprint');
  assert.equal(JSON.parse(request.options.body).preflightOnly, true);
  assert.equal(JSON.parse(request.options.body).dryRun, true);
  const completeRequest = readiness.buildBracketReadinessRequest(
    {
      blueprintId: 'ibpb_googl',
      candidateId: 'cand_googl',
      symbol: 'GOOGL',
      side: 'SELL',
      quantity: 40,
      marketGroup: 'stock',
      assetClass: 'STK',
      secType: 'STK',
      currency: 'USD',
      exchange: 'SMART',
      primaryExchange: 'NASDAQ',
      entryPrice: 367.04,
      stopLoss: 367.41,
      takeProfit: 366.31,
    },
    {
      accepted: true,
      readyForFirstPaperOrder: true,
      generatedAt: '2026-06-22T08:29:00.000Z',
      requestId: 'req-1',
      sessionVerification: {
        source: 'live_connection_readiness',
        sessionVerified: true,
        selectedAccount: 'DUQ565596',
        paperAccountId: 'DUQ565596',
        accountMatches: true,
      },
      selectedBlueprintVerification: { source: 'trade_blueprint', selectedBlueprint: { symbol: null } },
    },
  );
  const completeBody = JSON.parse(completeRequest.options.body);
  assert.equal(completeBody.selectedBlueprint.symbol, 'GOOGL');
  assert.equal(completeBody.selectedBlueprint.marketGroup, 'stock');
  assert.notEqual(completeBody.selectedBlueprint.symbol, 'none');
  assert.equal(completeBody.preflightReady, true);
  assert.equal(completeBody.preflightAccepted, true);
  assert.equal(completeBody.preflightRequestId, 'req-1');
  assert.equal(completeBody.preflightSessionVerification.sessionVerified, true);
  assert.equal(completeBody.preflightSessionVerification.selectedAccount, 'DUQ565596');
  assert.equal(readiness.mapBracketReadinessHttpError(404).blockedReason, 'bracket_readiness_route_not_found');
  assert.equal(readiness.mapBracketReadinessHttpError(401).blockedReason, 'bracket_readiness_auth_required');
  assert.equal(readiness.mapBracketReadinessHttpError(null, 'timeout_after_6500ms').blockedReason, 'timeout_after_6500ms');

  console.log('interactiveBrokersManualPaperReadiness.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
