'use strict';

const assert = require('assert/strict');

(async () => {
  const resolver = await import('./interactiveBrokersManualPaperBlueprintResolver.mjs');

  const tradeBlueprint = {
    selectedBlueprint: {
      blueprintId: 'ibpb_1',
      symbol: 'GOOGL',
      strategyId: 'narrow_breakout',
      strategyName: 'Narrow Breakout',
      side: 'SELL',
      quantity: 40,
      entryPrice: 367.04,
      stopLoss: 367.41,
      takeProfit: 366.31,
      accountMode: 'ib_paper',
      blueprintReady: true,
      manualApprovalReady: true,
    },
  };

  const protectivePreflight = {
    selectedBlueprint: {
      blueprintId: 'ibpb_1',
      symbol: 'GOOGL',
      strategyId: 'narrow_breakout',
      strategyName: 'Narrow Breakout',
      side: 'SELL',
      quantity: 40,
      entryPrice: 367.04,
      stopLoss: 367.41,
      takeProfit: 366.31,
      accountMode: 'ib_paper',
      account: 'DUQ565596',
    },
    protectivePathAvailable: true,
    protectivePlanReady: true,
    bracketSubmissionPlanReady: true,
    bracketOrderCount: 3,
    entryOnlyBlocked: true,
    account: { paperAccountId: 'DUQ565596' },
    plan: {
      blueprintId: 'ibpb_1',
      symbol: 'GOOGL',
      strategyId: 'narrow_breakout',
      strategyName: 'Narrow Breakout',
      side: 'SELL',
      quantity: 40,
      entryReferencePrice: 367.04,
      stopLoss: 367.41,
      takeProfit: 366.31,
      accountMode: 'ib_paper',
    },
  };

  const tradeReady = resolver.resolveStableSelectedIbPaperBlueprint({
    tradeBlueprint,
    canonicalTruth: {
      ibPaper: {
        selectedBlueprint: tradeBlueprint.selectedBlueprint,
      },
    },
    protectivePreflight,
    tradeBlueprintLoadStatus: 'ok',
    tradeBlueprintLoadError: null,
  });

  assert.equal(tradeReady.source, 'trade_blueprint');
  assert.equal(tradeReady.safeForDisplay, true);
  assert.equal(tradeReady.safeForBracketPreview, true);
  assert.equal(tradeReady.safeForArm, true);
  assert.equal(tradeReady.safeForSubmit, false);
  assert.equal(tradeReady.safetyStatus, 'manual_ready');
  assert.equal(tradeReady.blueprint.symbol, 'GOOGL');
  assert.equal(tradeReady.blueprint.marketGroup, 'stock');
  assert.equal(tradeReady.blueprint.assetClass, 'STK');
  assert.equal(tradeReady.blueprint.secType, 'STK');
  assert.equal(tradeReady.blueprint.currency, 'USD');
  assert.equal(tradeReady.blueprint.exchange, 'SMART');
  assert.equal(tradeReady.blueprint.primaryExchange, 'NASDAQ');
  assert.equal(tradeReady.blueprint.stopLossPct, 0.1008);
  assert.equal(tradeReady.blueprint.riskReward, 1.97);

  const protectiveFallback = resolver.resolveStableSelectedIbPaperBlueprint({
    tradeBlueprint: null,
    canonicalTruth: {
      ibPaper: {
        selectedBlueprint: null,
      },
    },
    protectivePreflight,
    tradeBlueprintLoadStatus: 'timeout',
    tradeBlueprintLoadError: 'timeout_after_6500ms',
  });

  assert.equal(protectiveFallback.source, 'protective_preflight');
  assert.equal(protectiveFallback.isFallback, true);
  assert.equal(protectiveFallback.safeForDisplay, true);
  assert.equal(protectiveFallback.safeForBracketPreview, true);
  assert.equal(protectiveFallback.safeForArm, false);
  assert.equal(protectiveFallback.safeForSubmit, false);
  assert.equal(protectiveFallback.safetyStatus, 'preview_only');
  assert.equal(protectiveFallback.blockedReason, 'selected_blueprint_fallback_not_safe_for_submit');
  assert(protectiveFallback.blockers.includes('selected_blueprint_fallback_not_safe_for_submit'));
  assert.equal(protectiveFallback.blueprint.symbol, 'GOOGL');
  assert.equal(protectiveFallback.loadStatus, 'timeout');
  assert.equal(protectiveFallback.loadError, 'timeout_after_6500ms');

  const lastStable = resolver.resolveStableSelectedIbPaperBlueprint({
    tradeBlueprint: null,
    canonicalTruth: {
      ibPaper: {
        selectedBlueprint: null,
      },
    },
    protectivePreflight: null,
    paperPreflightResult: null,
    preview: null,
    scaffold: null,
    lastStableSelectedBlueprint: {
      blueprintId: 'ibpb_1',
      symbol: 'GOOGL',
      strategyId: 'narrow_breakout',
      strategyName: 'Narrow Breakout',
      side: 'SELL',
      quantity: 40,
      entryPrice: 367.04,
      stopLoss: 367.41,
      takeProfit: 366.31,
      accountMode: 'ib_paper',
      account: 'DUQ565596',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  assert.equal(lastStable.source, 'last_stable');
  assert.equal(lastStable.safeForDisplay, true);
  assert.equal(lastStable.safeForSubmit, false);
  assert.equal(lastStable.safeForArm, false);

  const none = resolver.resolveStableSelectedIbPaperBlueprint({
    tradeBlueprint: null,
    canonicalTruth: null,
    preview: null,
    scaffold: null,
    paperPreflightResult: null,
    protectivePreflight: null,
    lastStableSelectedBlueprint: {
      blueprintId: 'ibpb_1',
      symbol: 'GOOGL',
      strategyId: 'narrow_breakout',
      strategyName: 'Narrow Breakout',
      side: 'SELL',
      quantity: 40,
      entryPrice: 367.04,
      stopLoss: 367.41,
      takeProfit: 366.31,
      accountMode: 'ib_paper',
      account: 'DUQ565596',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });

  assert.equal(none.source, 'none');
  assert.equal(none.safeForDisplay, false);
  assert.equal(none.safeForSubmit, false);

  console.log('interactiveBrokersManualPaperBlueprintResolver.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
