'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('./interactiveBrokersPaperMultiStrategyTestPlanService');
const configService = require('./interactiveBrokersPaperMultiStrategyConfigService');

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// Config helper: env-resolved defaults with optional overrides for deterministic tests.
function cfg(overrides = {}) {
  return { ...configService.DEFAULT_LIMITS, enabled: true, includeEtf: false, ...overrides };
}

const bp = (over = {}) => ({
  blueprintId: over.blueprintId || `bp_${over.symbol || 'x'}`,
  symbol: 'AAPL',
  strategyId: 'vwap_failed_breakout_short',
  strategyName: 'VWAP failed breakout short',
  direction: 'short',
  side: 'SELL',
  quantity: 12,
  entryReferencePrice: 200,
  stopLoss: 200.2,
  takeProfit: 199.6,
  blockers: [],
  ...over,
});

const sampleReadOnly = { account: 'DUQ565596', openOrders: [], positions: [], executions: [] };

// Deterministic asset-toggle stub: every asset preview-enabled so the existing
// gate assertions (includeEtf / crypto) stay meaningful independent of any
// on-disk toggle file. Asset-gate-specific tests override this below.
const ALL_ASSETS_ENABLED = {
  getAssetToggles: () => ({ paperPreviewAssetToggles: { stocks: true, etfQqq: true, crypto: true }, assets: [] }),
  classifyCandidateAsset: (c = {}) => {
    const group = String(c.marketGroup || '').toLowerCase();
    const symbol = String(c.symbol || '').toUpperCase();
    let assetKey = 'stocks';
    if (group === 'crypto' || symbol.endsWith('USDT')) assetKey = 'crypto';
    else if (group === 'etf' || symbol === 'QQQ') assetKey = 'etfQqq';
    return { assetKey, label: assetKey, previewEnabled: true, previewOnly: assetKey !== 'stocks', submitEverAllowedThisPhase: false };
  },
};
function makeAssets(enabled) {
  return {
    getAssetToggles: () => ({ paperPreviewAssetToggles: { ...enabled }, assets: [] }),
    classifyCandidateAsset: (c = {}) => {
      const group = String(c.marketGroup || '').toLowerCase();
      const symbol = String(c.symbol || '').toUpperCase();
      let assetKey = 'stocks';
      if (group === 'crypto' || symbol.endsWith('USDT')) assetKey = 'crypto';
      else if (group === 'etf' || symbol === 'QQQ') assetKey = 'etfQqq';
      return { assetKey, label: assetKey, previewEnabled: enabled[assetKey] === true, previewOnly: assetKey !== 'stocks', submitEverAllowedThisPhase: false };
    },
  };
}
function build(input) {
  return svc['buildMultiStrategyTestPlan']({ assetToggleService: ALL_ASSETS_ENABLED, ...input });
}

const previewCandidate = (over = {}) => ({
  strategyId: 'trend_continuation',
  strategyName: 'Trend Continuation',
  symbol: 'TSLA',
  direction: 'unknown',
  normalizedDirection: null,
  directionSource: null,
  source: 'scanner',
  confidence: 'high',
  gateScore: 75,
  allowedForIbPaperPreview: false,
  blockers: ['Riktningen kunde inte verifieras tydligt'],
  marketGroup: 'stocks',
  normalizedMarketGroup: 'stocks',
  marketGroupSource: 'market_universe',
  ...over,
});

// 1. Default OFF (env) -> safety false, read-only, current blockers present, phase_2.
withEnv({ IB_PAPER_MULTI_STRATEGY_TEST_MODE: undefined, IB_PAPER_SUBMIT_ROUTES_ENABLED: undefined, IB_PAPER_MULTI_STRATEGY_INCLUDE_ETF: undefined }, () => {
  const plan = build({
    tradeBlueprint: { blueprints: [bp()] },
    readOnlyState: sampleReadOnly,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.enabled, false, 'mode must default OFF');
  assert.equal(plan.submitRoutesEnabled, false);
  assert.deepEqual(plan.safety, {
    mode: 'paper_only', actions_allowed: false, can_place_orders: false,
    live_trading_enabled: false, broker_enabled: false,
  });
  assert.ok(plan.currentBlockers.includes('multi_strategy_test_mode_disabled'));
  assert.ok(plan.currentBlockers.includes('submit_routes_disabled'));
  assert.ok(plan.currentBlockers.includes('phase_2_no_auto_submit'));
  // OFF must keep limits at documented defaults.
  assert.equal(plan.limits.maxCandidates, 20);
  assert.equal(plan.limits.cryptoBlocked, true);
  assert.equal(plan.limits.includeEtf, false);
});

// 1b. Preview/scanner candidates are included even when trade-blueprint has no
// allowed blueprints. Unknown direction stays blocked, never dropped.
{
  const plan = build({
    tradeBlueprint: { blueprints: [], orderPreview: { candidates: [previewCandidate()] } },
    readOnlyState: sampleReadOnly,
    config: cfg(),
  });
  assert.equal(plan.counts.candidateCount, 1);
  assert.equal(plan.counts.blockedCount, 1);
  const c = plan.candidates[0];
  assert.equal(c.symbol, 'TSLA');
  assert.equal(c.strategyId, 'trend_continuation');
  assert.equal(c.source, 'scanner');
  assert.equal(c.rawSource, 'scanner');
  assert.equal(c.marketGroup, 'stocks');
  assert.equal(c.directionVerified, false);
  assert.equal(c.allowed, false);
  assert.ok(c.blockers.includes('direction_not_verified'));
  assert.equal(plan.diagnostics.candidateSource, 'order_preview_candidates');
  assert.equal(plan.diagnostics.previewCandidateCount, 1);
}

// 1c. A preview candidate with verified BUY/SELL and green gates can be allowed
// for planning, while submit remains globally disabled elsewhere.
{
  const plan = build({
    tradeBlueprint: { blueprints: [], orderPreview: { candidates: [previewCandidate({
      symbol: 'AAPL',
      strategyId: 'vwap_volume_breakout_long',
      strategyName: 'VWAP volume breakout long',
      direction: 'BUY',
      normalizedDirection: 'BUY',
      side: 'BUY',
      blockers: [],
      allowedForIbPaperPreview: true,
      stopLoss: 199.8,
      takeProfit: 200.6,
    })] } },
    readOnlyState: sampleReadOnly,
    config: cfg(),
  });
  const c = plan.candidates[0];
  assert.equal(c.resolvedDirection, 'BUY');
  assert.equal(c.side, 'BUY');
  assert.equal(c.directionVerified, true);
  assert.equal(c.allowed, true);
  assert.equal(plan.counts.allowedCount, 1);
}

// 1d. Symbol-less fallback candidates remain surfaced but blocked.
{
  const plan = build({
    tradeBlueprint: { blueprints: [], orderPreview: { candidates: [previewCandidate({
      symbol: '–',
      strategyId: 'ema_pullback_continuation',
      source: 'plan_fallback',
      blockers: ['Okänd marknadsgrupp', 'Riktningen kunde inte verifieras tydligt'],
    })] } },
    readOnlyState: sampleReadOnly,
    config: cfg(),
  });
  const c = plan.candidates[0];
  assert.equal(c.symbol, null);
  assert.equal(c.allowed, false);
  assert.ok(c.blockers.includes('symbol_missing'));
  assert.ok(c.blockers.includes('unknown_market_group'));
}

// 2. ON -> maxCandidates 20 surfaced; default limits.
withEnv({ IB_PAPER_MULTI_STRATEGY_TEST_MODE: 'true', IB_PAPER_SUBMIT_ROUTES_ENABLED: undefined }, () => {
  const many = { blueprints: Array.from({ length: 25 }, (_, i) => bp({ blueprintId: `b${i}`, symbol: `S${i}`, strategyId: `st${i}` })) };
  const plan = build({ tradeBlueprint: many, readOnlyState: sampleReadOnly });
  assert.equal(plan.enabled, true);
  assert.equal(plan.candidates.length, 20, 'maxCandidates caps surfaced candidates at 20');
  assert.equal(plan.limits.globalDailyCap, 10);
  assert.equal(plan.limits.perStrategyDailyCap, 3);
  assert.equal(plan.limits.forceQuantity, 1);
  assert.ok(plan.currentBlockers.includes('submit_routes_disabled'), 'submit stays gated');
  assert.ok(!plan.currentBlockers.includes('multi_strategy_test_mode_disabled'));
});

// 3. Quantity forced to 1, bracket required, entry-only blocked on every candidate.
{
  const plan = build({ tradeBlueprint: { blueprints: [bp(), bp({ blueprintId: 'b2', symbol: 'MSFT', strategyId: 'orb', direction: 'long', side: 'BUY' })] }, readOnlyState: sampleReadOnly, config: cfg() });
  assert.ok(plan.candidates.every((c) => c.wouldForceQuantity === 1));
  assert.ok(plan.candidates.every((c) => c.wouldRequireBracket === true));
  assert.ok(plan.candidates.every((c) => c.wouldBlockEntryOnly === true));
}

// 4. not_top_3_strategy relaxed under multi-strategy mode.
{
  const plan = build({ tradeBlueprint: { blueprints: [bp({ blockers: ['not_top_3_strategy'] })] }, readOnlyState: sampleReadOnly, config: cfg() });
  assert.equal(plan.candidates[0].allowed, true, 'not_top_3 must be relaxed for planning');
}

// 5. ETF/QQQ blocked when includeEtf=false, allowed when includeEtf=true (other gates green).
{
  const etfBp = bp({ blueprintId: 'qqq', symbol: 'QQQ', strategyId: 'etf_mom', direction: 'long', side: 'BUY', blockers: ['etf_not_allowed_for_ib_paper_first_order'] });
  const blocked = build({ tradeBlueprint: { blueprints: [etfBp] }, readOnlyState: sampleReadOnly, config: cfg({ includeEtf: false }) });
  assert.equal(blocked.candidates[0].allowed, false);
  assert.ok(blocked.candidates[0].blockers.includes('etf_not_allowed_for_ib_paper_first_order'));

  const allowed = build({ tradeBlueprint: { blueprints: [etfBp] }, readOnlyState: sampleReadOnly, config: cfg({ includeEtf: true }) });
  assert.equal(allowed.candidates[0].allowed, true, 'ETF allowed when includeEtf=true and other gates green');
}

// 6. Crypto stays blocked even with includeEtf=true.
{
  const cryptoBp = bp({ blueprintId: 'btc', symbol: 'BTCUSDT', strategyId: 'crypto_mom', marketGroup: 'crypto', direction: 'long', side: 'BUY' });
  const plan = build({ tradeBlueprint: { blueprints: [cryptoBp] }, readOnlyState: sampleReadOnly, config: cfg({ includeEtf: true }) });
  assert.equal(plan.candidates[0].isCrypto, true);
  assert.equal(plan.candidates[0].allowed, false);
  assert.ok(plan.candidates[0].blockers.includes('crypto_not_allowed'));
}

// 6b. Preview crypto candidates stay blocked.
{
  const plan = build({
    tradeBlueprint: { blueprints: [], orderPreview: { candidates: [previewCandidate({
      symbol: 'BTCUSDT',
      strategyId: 'crypto_momentum_scalper',
      direction: 'BUY',
      normalizedDirection: 'BUY',
      side: 'BUY',
      marketGroup: 'crypto',
      normalizedMarketGroup: 'crypto',
      blockers: ['Krypto är blockerat i denna fas'],
      stopLoss: 100,
      takeProfit: 101,
    })] } },
    readOnlyState: sampleReadOnly,
    config: cfg({ includeEtf: true }),
  });
  assert.equal(plan.candidates[0].isCrypto, true);
  assert.equal(plan.candidates[0].allowed, false);
  assert.ok(plan.candidates[0].blockers.includes('crypto_not_allowed'));
}

// 7. Bracket required: candidate without take profit is blocked.
{
  const noBracket = bp({ blueprintId: 'nb', takeProfit: null, takeProfit1: null });
  const plan = build({ tradeBlueprint: { blueprints: [noBracket] }, readOnlyState: sampleReadOnly, config: cfg() });
  assert.equal(plan.candidates[0].hasBracket, false);
  assert.ok(plan.candidates[0].blockers.includes('bracket_required_missing'));
}

// 8. Open order guard blocks same symbol.
{
  const plan = build({
    tradeBlueprint: { blueprints: [bp()] },
    readOnlyState: { account: 'DUQ565596', openOrders: [{ symbol: 'AAPL' }], positions: [], executions: [] },
    config: cfg(),
  });
  const c = plan.candidates[0];
  assert.equal(c.openOrderConflict, true);
  assert.equal(c.positionConflict, false);
  assert.equal(c.allowed, false);
  assert.ok(c.blockers.includes('open_order_conflict'));
  assert.equal(plan.ibState.openOrdersCount, 1);
}

// 9. Position guard blocks same symbol (distinct from open order).
{
  const plan = build({
    tradeBlueprint: { blueprints: [bp()] },
    readOnlyState: { account: 'DUQ565596', openOrders: [], positions: [{ symbol: 'AAPL' }], executions: [] },
    config: cfg(),
  });
  const c = plan.candidates[0];
  assert.equal(c.positionConflict, true);
  assert.equal(c.openOrderConflict, false);
  assert.ok(c.blockers.includes('position_conflict'));
}

// 10. Duplicate guard blocks symbol+strategy+side within 30 min.
{
  const now = new Date('2026-06-29T15:00:00.000Z');
  const recent = { openTrades: [{ symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short', direction: 'short', openedAt: '2026-06-29T14:45:00.000Z' }], closedTrades: [], dailyQuota: { used: 0, max: 10 } };
  const plan = build({ tradeBlueprint: { blueprints: [bp()] }, executionStatus: recent, readOnlyState: sampleReadOnly, config: cfg(), now });
  assert.equal(plan.candidates[0].duplicateConflict, true);
  assert.ok(plan.candidates[0].blockers.includes('duplicate_trade_in_window'));

  // Outside the window -> no conflict.
  const old = { openTrades: [{ symbol: 'AAPL', strategyId: 'vwap_failed_breakout_short', direction: 'short', openedAt: '2026-06-29T14:00:00.000Z' }], closedTrades: [] };
  const plan2 = build({ tradeBlueprint: { blueprints: [bp()] }, executionStatus: old, readOnlyState: sampleReadOnly, config: cfg(), now });
  assert.equal(plan2.candidates[0].duplicateConflict, false);
}

// 11. Per-strategy cap: 4 candidates same strategy -> 4th blocked (cap 3).
{
  const dup = { blueprints: Array.from({ length: 4 }, (_, i) => bp({ blueprintId: `d${i}`, symbol: `SYM${i}`, strategyId: 'same_strategy', direction: 'long', side: 'BUY' })) };
  const plan = build({ tradeBlueprint: dup, readOnlyState: sampleReadOnly, config: cfg() });
  const blocked = plan.candidates.filter((c) => c.perStrategyCapReached);
  assert.equal(blocked.length, 1, 'exactly one over per-strategy cap of 3');
  assert.ok(plan.candidates[3].blockers.includes('per_strategy_daily_cap_reached'));
}

// 12. Global cap: 11 distinct candidates -> 11th blocked (cap 10).
{
  const many = { blueprints: Array.from({ length: 11 }, (_, i) => bp({ blueprintId: `g${i}`, symbol: `G${i}`, strategyId: `gs${i}`, direction: 'long', side: 'BUY' })) };
  const plan = build({ tradeBlueprint: many, readOnlyState: sampleReadOnly, config: cfg() });
  const overGlobal = plan.candidates.filter((c) => c.globalCapReached);
  assert.equal(overGlobal.length, 1, 'exactly one over global cap of 10');
  assert.ok(plan.candidates[10].blockers.includes('global_daily_cap_reached'));
}

// 13. Global cap seeded from execution-status dailyQuota.used.
{
  const many = { blueprints: Array.from({ length: 3 }, (_, i) => bp({ blueprintId: `s${i}`, symbol: `Z${i}`, strategyId: `zs${i}`, direction: 'long', side: 'BUY' })) };
  const plan = build({ tradeBlueprint: many, executionStatus: { dailyQuota: { used: 9, max: 10 } }, readOnlyState: sampleReadOnly, config: cfg() });
  // 9 already used -> 1st consumes the 10th slot (ok), 2nd & 3rd over cap.
  assert.equal(plan.candidates.filter((c) => c.globalCapReached).length, 2);
}

// 14. Endpoint shape: counts + ibState + safety.
{
  const plan = build({ tradeBlueprint: { blueprints: [bp(), bp({ blueprintId: 'b2', symbol: 'MSFT', strategyId: 'orb', blockers: ['unapproved_strategy'] })] }, readOnlyState: sampleReadOnly, config: cfg() });
  assert.equal(plan.counts.candidateCount, 2);
  assert.equal(plan.counts.allowedCount + plan.counts.blockedCount, 2);
  assert.equal(plan.ibState.account, 'DUQ565596');
  assert.equal(plan.mode, 'ib_paper_multi_strategy_test_plan');
}

// 15. Candidate carries the required field names.
{
  const plan = build({ tradeBlueprint: { blueprints: [bp()] }, readOnlyState: sampleReadOnly, config: cfg() });
  const c = plan.candidates[0];
  for (const k of ['symbol', 'strategyId', 'side', 'allowed', 'blockers', 'wouldForceQuantity', 'wouldRequireBracket', 'wouldBlockEntryOnly', 'openOrderConflict', 'positionConflict', 'duplicateConflict', 'perStrategyCapReached', 'globalCapReached']) {
    assert.ok(k in c, `candidate must expose ${k}`);
  }
}

// 16. Direction resolver: unverifiable direction is blocked (direction_not_verified).
{
  const noDir = bp({ blueprintId: 'nd', symbol: 'AMD', strategyId: 'trend_continuation', direction: undefined, side: undefined });
  const plan = build({ tradeBlueprint: { blueprints: [noDir] }, readOnlyState: sampleReadOnly, config: cfg() });
  const c = plan.candidates[0];
  assert.equal(c.resolvedDirection, 'UNKNOWN');
  assert.equal(c.directionVerified, false);
  assert.equal(c.allowed, false);
  assert.ok(c.blockers.includes('direction_not_verified'));
}

// 17. Direction resolver: vwap_failed_breakout_short -> SELL, verified.
{
  const sh = bp({ blueprintId: 'sh', symbol: 'QQQ', strategyId: 'vwap_failed_breakout_short', direction: undefined, side: undefined, marketGroup: 'stocks' });
  const plan = build({ tradeBlueprint: { blueprints: [sh] }, readOnlyState: sampleReadOnly, config: cfg() });
  const c = plan.candidates[0];
  assert.equal(c.resolvedDirection, 'SELL');
  assert.equal(c.side, 'SELL');
  assert.equal(c.directionVerified, true);
}

// 18. Asset toggle gate: QQQ blocked when etfQqq preview toggle is OFF, even if includeEtf=true.
{
  const etfBp = bp({ blueprintId: 'qqq2', symbol: 'QQQ', strategyId: 'etf_mom', direction: 'long', side: 'BUY', blockers: [] });
  const off = svc['buildMultiStrategyTestPlan']({
    assetToggleService: makeAssets({ stocks: true, etfQqq: false, crypto: false }),
    tradeBlueprint: { blueprints: [etfBp] }, readOnlyState: sampleReadOnly, config: cfg({ includeEtf: true }),
  });
  assert.equal(off.candidates[0].assetPreviewEnabled, false);
  assert.ok(off.candidates[0].blockers.includes('asset_preview_disabled'));

  const on = svc['buildMultiStrategyTestPlan']({
    assetToggleService: makeAssets({ stocks: true, etfQqq: true, crypto: false }),
    tradeBlueprint: { blueprints: [etfBp] }, readOnlyState: sampleReadOnly, config: cfg({ includeEtf: true }),
  });
  assert.equal(on.candidates[0].assetPreviewEnabled, true);
  assert.equal(on.candidates[0].allowed, true);
}

// 19. directionSummary + assetToggles surfaced at top level.
{
  const plan = svc['buildMultiStrategyTestPlan']({
    assetToggleService: makeAssets({ stocks: true, etfQqq: true, crypto: true }),
    tradeBlueprint: { blueprints: [bp(), bp({ blueprintId: 'x2', symbol: 'AMD', strategyId: 'trend_continuation', direction: undefined, side: undefined })] },
    readOnlyState: sampleReadOnly, config: cfg(),
  });
  assert.equal(plan.directionSummary.sell, 1);
  assert.equal(plan.directionSummary.unknown, 1);
  assert.deepEqual(plan.assetToggles, { stocks: true, etfQqq: true, crypto: true });
}

// 20. Submit routes disabled remains a top-level blocker in ON mode.
withEnv({ IB_PAPER_MULTI_STRATEGY_TEST_MODE: 'true', IB_PAPER_SUBMIT_ROUTES_ENABLED: 'false' }, () => {
  const plan = build({
    tradeBlueprint: { blueprints: [], orderPreview: { candidates: [previewCandidate()] } },
    readOnlyState: sampleReadOnly,
  });
  assert.equal(plan.submitRoutesEnabled, false);
  assert.ok(plan.currentBlockers.includes('submit_routes_disabled'));
  assert.ok(plan.currentBlockers.includes('phase_2_no_auto_submit'));
});

// 21. Service remains read-only: no broker/order submit/cancel calls.
{
  const source = fs.readFileSync(path.join(__dirname, 'interactiveBrokersPaperMultiStrategyTestPlanService.js'), 'utf8');
  assert.equal(/placeOrder\s*\(/.test(source), false);
  assert.equal(/cancelOrder\s*\(/.test(source), false);
  assert.equal(/paper-execute/.test(source), false);
}

console.log('interactiveBrokersPaperMultiStrategyTestPlanService.test.js: all assertions passed');
