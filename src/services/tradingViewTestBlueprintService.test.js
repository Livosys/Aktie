'use strict';

const assert = require('assert/strict');

const { createTradingViewTestBlueprintService } = require('./tradingViewTestBlueprintService');

const service = createTradingViewTestBlueprintService({
  catalogService: {
    getCatalog() {
      return {
        strategies: [
          {
            id: 'TEST_LONG',
            name: 'Test Long',
            direction: 'long',
            market_group: 'stocks',
            default_timeframes: ['5m'],
            signal_rules: ['price_reclaims_vwap', 'volume_above_average', 'momentum_up'],
            exit_rules: ['stop_loss_inside_range', 'take_profit_r_multiple'],
            default_stop_loss_pct: 0.2,
            default_take_profit_r: 1.5,
            default_holding_time_min: 10,
            confidence_threshold: 65,
            required_indicators: ['VWAP', 'Volume'],
            risk_notes: 'Paper only',
          },
          {
            id: 'TEST_BOTH',
            name: 'Test Both',
            direction: 'both',
            market_group: 'all',
            default_timeframes: ['1m', '5m'],
            signal_rules: ['narrow_state_detected', 'price_breaks_range', 'volume_or_relvol_confirms'],
            default_stop_loss_pct: 0.18,
            default_take_profit_r: 1.8,
            default_holding_time_min: 12,
            confidence_threshold: 60,
          },
        ],
      };
    },
    getStrategyById(id) {
      return this.getCatalog().strategies.find((row) => row.id === id) || null;
    },
  },
  registryService: {
    listStrategies() {
      return [
        { strategy_id: 'TEST_LONG', status: 'active' },
        { strategy_id: 'TEST_BOTH', status: 'paused', blocked_reason: 'manual_review' },
      ];
    },
  },
});

{
  const result = service.buildTradingViewTestBlueprints();
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'paper_only');
  assert.equal(result.actions_allowed, false);
  assert.equal(result.summary.totalStrategies, 2);
  assert.equal(result.summary.pineScriptPossible, 2);
  assert.ok(result.fieldInventory.totalStrategies === 2);
  assert.ok(Array.isArray(result.blueprints));

  const long = result.blueprints.find((row) => row.strategyId === 'TEST_LONG');
  assert.equal(long.displayName, 'Test Long');
  assert.equal(long.direction, 'long');
  assert.equal(long.timeframe, '5m');
  assert.equal(long.sessionFilter, 'RTH 09:30-16:00 ET');
  assert.equal(long.pineScriptPossible, true);
  assert.ok(long.entryConditionsPinePseudo.includes('strategy.entry("L"'));
  assert.ok(long.exitConditionsPinePseudo.includes('strategy.exit("XL"'));

  const both = result.blueprints.find((row) => row.strategyId === 'TEST_BOTH');
  assert.equal(both.direction, 'both');
  assert.ok(both.warnings.some((warning) => warning.includes('direction_both')));
  assert.ok(both.missingFields.includes('maxTradesPerDay'));
  assert.ok(both.missingFields.includes('cooldownMinutes'));
}

{
  const single = service.getTradingViewTestBlueprint('TEST_LONG');
  assert.equal(single.ok, true);
  assert.equal(single.blueprint.strategyId, 'TEST_LONG');
}

console.log('TradingView test blueprint service tests passed.');
