'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const { createStrategyRegistryService } = require('./strategyRegistryService');

function makeCatalog() {
  return {
    getCatalog() {
      return {
        strategies: [
          {
            id: 'INTERNAL_ACTIVE',
            name: 'Internal Active',
            status: 'active',
            enabled: true,
            description: 'Active internal strategy',
            performanceSummary: { win_rate: 0.61, avg_pnl: 1.1, trades: 18, score: 72 },
            marketRegimeTags: ['trend'],
            allowedTimeframes: ['5m'],
            entryRules: ['price_above_vwap'],
            exitRules: ['stop_loss'],
          },
          {
            id: 'INTERNAL_PAUSED',
            name: 'Internal Paused',
            status: 'paused',
            enabled: false,
            description: 'Paused internal strategy',
            performanceSummary: { win_rate: 0.35, avg_pnl: -0.4, trades: 9, score: 24 },
            marketRegimeTags: ['chop'],
            allowedTimeframes: ['15m'],
            entryRules: ['range_breakout'],
            exitRules: ['timeout'],
          },
        ],
      };
    },
  };
}

function makeRegistry() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-registry-'));
  const registryFile = path.join(tmpDir, 'strategy-registry.jsonl');
  return createStrategyRegistryService({
    registryFile,
    daytradingCatalog: makeCatalog(),
  });
}

function assertSafety(result, label) {
  assert.equal(result.actions_allowed, false, `${label}: actions_allowed`);
  assert.equal(result.can_place_orders, false, `${label}: can_place_orders`);
  assert.equal(result.live_trading_enabled, false, `${label}: live_trading_enabled`);
  assert.equal(result.broker_enabled, false, `${label}: broker_enabled`);
  assert.equal(result.mode, 'paper_only', `${label}: mode`);
}

{
  const registry = makeRegistry();

  const snapshot = registry.listStrategies();
  assert.ok(snapshot.some((strategy) => strategy.strategy_id === 'INTERNAL_ACTIVE'), 'internal active exists');
  assert.ok(snapshot.some((strategy) => strategy.strategy_id === 'INTERNAL_PAUSED'), 'internal paused exists');

  const active = registry.getStrategy('INTERNAL_ACTIVE');
  assert.equal(active.status, 'active', 'internal active status');
  assert.equal(active.enabled, true, 'internal active enabled');
  assert.equal(active.source, 'internal', 'internal active source');
  assert.equal(active.performance_summary.trades, 18, 'internal active learning summary');
  assert.deepEqual(active.allowed_timeframes, ['5m'], 'internal active timeframes');

  const paused = registry.getStrategy('INTERNAL_PAUSED');
  assert.equal(paused.status, 'paused', 'internal paused status');
  assert.equal(paused.enabled, false, 'internal paused enabled');
  assert.equal(paused.source, 'internal', 'internal paused source');

  const created = registry.registerTradingViewStrategy('TV_ALPHA', {
    strategy_name: 'TV Alpha',
    allowed_timeframes: ['5m'],
    market_regime_tags: ['risk_on'],
    recommended_tests: ['paper_forward'],
  });
  assert.equal(created.ok, true, 'tv create ok');
  assert.equal(created.created, true, 'tv created');
  assertSafety(created, 'tv create safety');

  const tvAlpha = registry.getStrategy('TV_ALPHA');
  assert.equal(tvAlpha.source, 'tradingview', 'tv alpha source');
  assert.equal(tvAlpha.status, 'paper_only', 'tv alpha status');
  assert.equal(tvAlpha.enabled, true, 'tv alpha enabled');
  assert.deepEqual(tvAlpha.recommended_tests, ['paper_forward'], 'tv alpha learning tests');

  const pausedTv = registry.pauseStrategy('TV_ALPHA', 'poor performance');
  assert.equal(pausedTv.ok, true, 'pause ok');
  assert.equal(pausedTv.strategy.status, 'paused', 'paused tv status');
  assert.equal(pausedTv.strategy.enabled, false, 'paused tv disabled');
  assert.equal(pausedTv.strategy.disabled_reason, 'poor performance', 'paused tv reason');
  assertSafety(pausedTv, 'pause safety');

  const blockedPaused = registry.canForwardStrategy('TV_ALPHA');
  assert.equal(blockedPaused.allowed, false, 'paused tv blocked');
  assert.equal(blockedPaused.blocked_reason, 'strategy_disabled', 'paused tv block reason');

  const reactivated = registry.activateStrategy('TV_ALPHA');
  assert.equal(reactivated.ok, true, 'activate ok');
  assert.equal(reactivated.strategy.status, 'active', 'activated tv status');
  assert.equal(reactivated.strategy.enabled, true, 'activated tv enabled');
  assert.equal(reactivated.strategy.disabled_reason, null, 'activated tv reason cleared');
  assertSafety(reactivated, 'activate safety');

  const deprecated = registry.ensureStrategy('TV_BETA', {
    source: 'tradingview',
    status: 'deprecated',
    enabled: false,
    disabled_reason: 'replaced',
    strategy_name: 'TV Beta',
  });
  assert.equal(deprecated.ok, true, 'deprecated create ok');
  assert.equal(deprecated.strategy.status, 'deprecated', 'deprecated status');
  assert.equal(deprecated.strategy.enabled, false, 'deprecated disabled');

  const blockedDeprecated = registry.canForwardStrategy('TV_BETA');
  assert.equal(blockedDeprecated.allowed, false, 'deprecated blocked');
  assert.equal(blockedDeprecated.blocked_reason, 'strategy_disabled', 'deprecated block reason');

  const status = registry.getStatus();
  assert.equal(status.total_strategies, 4, 'status total strategies');
  assert.equal(status.active_strategies, 2, 'status active strategies');
  assert.equal(status.tradingview_strategies, 2, 'status tradingview strategies');
  assert.equal(status.paused_strategies, 1, 'status paused strategies');
  assert.equal(status.deprecated_strategies, 1, 'status deprecated strategies');
  assert.equal(status.enabled_strategies, 2, 'status enabled strategies');
  assert.ok(status.latest_tradingview_strategy, 'status latest tradingview strategy');
  assert.equal(status.latest_tradingview_strategy.source, 'tradingview', 'latest tradingview source');
  assertSafety(status, 'status safety');
}

console.log('Strategy registry tests passed.');
