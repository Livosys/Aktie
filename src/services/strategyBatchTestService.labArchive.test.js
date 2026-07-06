'use strict';

const assert = require('assert');
const svc = require('./strategyBatchTestService');

const internal = svc._internal;

assert.equal(internal.isCryptoSymbol('BTCUSDT'), true);
assert.equal(internal.isCryptoSymbol('AAPL'), false);
assert.equal(internal.isCryptoStrategy({ id: 'crypto_momentum_scalper', market_group: 'crypto' }), true);
assert.equal(internal.isCryptoStrategy({ id: 'trend_continuation', market_group: 'stocks' }), false);
assert.equal(internal.isLabArchivedMarket('crypto'), true);
assert.equal(internal.isLabArchivedMarket('stocks'), false);

assert.equal(
  internal.hasLabBatchHistoricalData('AAPL', { days_covered: 6, candles_count: 1189, usable_for_batch: false }),
  true,
);
assert.equal(
  internal.hasLabBatchHistoricalData('BTCUSDT', { days_covered: 30, candles_count: 10000, usable_for_batch: true }),
  false,
);

const stockGrid = svc.buildParameterGrid({
  strategy_ids: ['trend_continuation', 'crypto_momentum_scalper'],
  markets: ['stocks', 'crypto'],
  symbols: ['AAPL', 'BTCUSDT'],
  timeframes: ['2m'],
  stop_losses: [0.2],
  take_profits: [1.5],
  holding_times: [5],
  timeouts: [8],
  confidence_thresholds: [65],
  volume_requirements: [1.2],
});

assert.equal(stockGrid.ok, true);
assert.deepEqual(stockGrid.config.symbols, ['AAPL']);
assert.deepEqual(stockGrid.config.strategy_ids, ['trend_continuation']);
assert.equal(stockGrid.config.markets.includes('crypto'), false);
assert.equal(stockGrid.grid.every((row) => row.symbol === 'AAPL'), true);
assert.equal(stockGrid.grid.every((row) => row.market_group !== 'crypto'), true);

const cryptoOnly = svc.buildParameterGrid({
  strategy_ids: ['crypto_momentum_scalper'],
  markets: ['crypto'],
  symbols: ['BTCUSDT'],
  timeframes: ['2m'],
  stop_losses: [0.2],
  take_profits: [1.5],
  holding_times: [5],
  timeouts: [8],
  confidence_thresholds: [65],
  volume_requirements: [1.2],
});

assert.equal(cryptoOnly.ok, false);
assert.match(cryptoOnly.error, /Inga körbara aktie\/index\/ETF-symboler/);
assert.equal(cryptoOnly.skipped_symbols[0].archiveReason, 'crypto_lab_archived');
assert.equal(cryptoOnly.archived_lab_strategies[0].archiveReason, 'crypto_lab_archived');

console.log('# strategyBatchTestService lab archive tests passed.');
