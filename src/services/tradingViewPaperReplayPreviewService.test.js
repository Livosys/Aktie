'use strict';

const assert = require('assert/strict');
const { createTradingViewPaperReplayPreviewService } = require('./tradingViewPaperReplayPreviewService');

function makeRegistry(strategy = null) {
  return {
    getStrategy(id) {
      if (!strategy || strategy.strategy_id !== id) return null;
      return { ...strategy };
    },
    canForwardStrategy(row) {
      if (!row) return { allowed: false, blocked_reason: 'strategy_not_found', strategy: null };
      if (row.status === 'paused' || row.status === 'deprecated' || row.enabled === false) {
        return { allowed: false, blocked_reason: 'strategy_disabled', strategy: row };
      }
      return { allowed: true, blocked_reason: null, strategy: row };
    },
  };
}

function makeAllowlist(ids = []) {
  return {
    getPaperAllowlistStatus() {
      return {
        ok: true,
        source: 'paperAllowlistService',
        totalApproved: ids.length,
        readyForPaperRuntime: ids.length,
        pendingRuntimeConnection: 0,
        allowlist: ids.map((id) => ({ id, name: id })),
      };
    },
  };
}

function assertSafety(obj, label = 'safety') {
  assert.deepEqual(obj, {
    mode: 'paper_only',
    actions_allowed: false,
    can_place_orders: false,
    live_trading_enabled: false,
    broker_enabled: false,
  }, `${label} exact match`);
}

const fixedNow = () => new Date('2026-06-09T12:00:00.000Z');
const strategy = {
  strategy_id: 'narrow_breakout',
  strategy_name: 'Narrow Breakout',
  source: 'internal',
  status: 'active',
  enabled: true,
};

// Default flags off: preview stays dry-run and blocked.
{
  const service = createTradingViewPaperReplayPreviewService({
    env: {
      TRADINGVIEW_WEBHOOK_SECRET: 'top-secret',
      TRADINGVIEW_PAPER_PREVIEW_ENABLED: 'false',
      TRADINGVIEW_PAPER_FORWARDING_ENABLED: 'false',
      TRADINGVIEW_REPLAY_QUEUE_ENABLED: 'false',
    },
    now: fixedNow,
    registryService: makeRegistry(strategy),
    allowlistService: makeAllowlist(['narrow_breakout']),
    webhookSecret: 'top-secret',
  });

  const preview = service.previewTradingViewSignal({
    source: 'tradingview',
    secret: 'top-secret',
    strategyId: 'narrow_breakout',
    symbol: 'AAPL',
    timeframe: '1m',
    signal: 'long',
    timestamp: '2026-06-09T11:55:00.000Z',
    side: 'long',
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.accepted, false);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.wouldCreatePaperTest, false);
  assert.equal(preview.wouldCreateReplayTest, false);
  assert.equal(preview.blockedReason, 'feature_flag_disabled');
  assert.equal(preview.previewReady, false);
  assert.equal(preview.enabled, false);
  assert.equal(preview.forwardingEnabled, false);
  assert.equal(preview.replayQueueEnabled, false);
  assertSafety(preview.safety, 'preview.safety');

  const again = service.previewTradingViewSignal({
    source: 'tradingview',
    secret: 'top-secret',
    strategyId: 'narrow_breakout',
    symbol: 'AAPL',
    timeframe: '1m',
    signal: 'long',
    timestamp: '2026-06-09T11:55:00.000Z',
    side: 'long',
  });
  assert.equal(preview.dedupKey, again.dedupKey, 'dedupKey stable');
}

// Invalid symbol blocks before feature flags matter.
{
  const service = createTradingViewPaperReplayPreviewService({
    env: { TRADINGVIEW_WEBHOOK_SECRET: 'top-secret' },
    now: fixedNow,
    registryService: makeRegistry(strategy),
    allowlistService: makeAllowlist(['narrow_breakout']),
    webhookSecret: 'top-secret',
  });

  const preview = service.previewTradingViewSignal({
    source: 'tradingview',
    secret: 'top-secret',
    strategyId: 'narrow_breakout',
    symbol: '???',
    timeframe: '1m',
    signal: 'long',
    timestamp: '2026-06-09T11:55:00.000Z',
  });
  assert.equal(preview.blockedReason, 'invalid_symbol');
  assert.equal(preview.accepted, false);
  assertSafety(preview.safety, 'invalid symbol preview.safety');
}

// Missing strategy is blocked.
{
  const service = createTradingViewPaperReplayPreviewService({
    env: { TRADINGVIEW_WEBHOOK_SECRET: 'top-secret' },
    now: fixedNow,
    registryService: makeRegistry(null),
    allowlistService: makeAllowlist([]),
    webhookSecret: 'top-secret',
  });

  const preview = service.previewTradingViewSignal({
    source: 'tradingview',
    secret: 'top-secret',
    strategyId: 'missing_strategy',
    symbol: 'AAPL',
    timeframe: '1m',
    signal: 'long',
    timestamp: '2026-06-09T11:55:00.000Z',
  });
  assert.equal(preview.blockedReason, 'strategy_not_found');
  assert.equal(preview.candidate.strategyName, null);
  assertSafety(preview.safety, 'missing strategy preview.safety');
}

// Old signal is blocked when a timestamp is supplied.
{
  const service = createTradingViewPaperReplayPreviewService({
    env: { TRADINGVIEW_WEBHOOK_SECRET: 'top-secret' },
    now: fixedNow,
    registryService: makeRegistry(strategy),
    allowlistService: makeAllowlist(['narrow_breakout']),
    webhookSecret: 'top-secret',
  });

  const preview = service.previewTradingViewSignal({
    source: 'tradingview',
    secret: 'top-secret',
    strategyId: 'narrow_breakout',
    symbol: 'AAPL',
    timeframe: '1m',
    signal: 'long',
    timestamp: '2026-06-09T10:00:00.000Z',
  });
  assert.equal(preview.blockedReason, 'signal_too_old');
  assertSafety(preview.safety, 'old signal preview.safety');
}

// Auth mismatch is blocked when auth is configured.
{
  const service = createTradingViewPaperReplayPreviewService({
    env: { TRADINGVIEW_WEBHOOK_SECRET: 'top-secret' },
    now: fixedNow,
    registryService: makeRegistry(strategy),
    allowlistService: makeAllowlist(['narrow_breakout']),
    webhookSecret: 'top-secret',
  });

  const preview = service.previewTradingViewSignal({
    source: 'tradingview',
    secret: 'wrong',
    strategyId: 'narrow_breakout',
    symbol: 'AAPL',
    timeframe: '1m',
    signal: 'long',
    timestamp: '2026-06-09T11:55:00.000Z',
  });
  assert.equal(preview.blockedReason, 'unauthorized');
  assertSafety(preview.safety, 'auth mismatch preview.safety');
}

// Status block is read-only and uses safe defaults.
{
  const service = createTradingViewPaperReplayPreviewService({
    env: { TRADINGVIEW_WEBHOOK_SECRET: 'top-secret' },
    now: fixedNow,
    registryService: makeRegistry(strategy),
    allowlistService: makeAllowlist(['narrow_breakout']),
    webhookSecret: 'top-secret',
  });

  const status = service.buildTradingViewPreviewStatus();
  assert.equal(status.ok, true);
  assert.equal(status.status, 'empty');
  assert.equal(status.enabled, false);
  assert.equal(status.previewReady, false);
  assert.equal(status.forwardingEnabled, false);
  assert.equal(status.replayQueueEnabled, false);
  assert.equal(status.latestPreview, null);
  assert.equal(status.blockedCount, 0);
  assert.equal(status.emptyReason, 'feature_flag_disabled');
  assert.ok(typeof status.message === 'string' && status.message.length > 0);
  assertSafety(status.safety, 'status.safety');
}

console.log('TradingView paper/replay preview tests passed.');
