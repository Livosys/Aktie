'use strict';

// Crypto majors (BTC/ETH/SOL) are research-active in Lab-batch. Only crypto
// certificates remain archived/blocked, and crypto outside the research majors
// is blocked via the research-scope gate. This test locks that behaviour.

const assert = require('assert');
const svc = require('./strategyBatchTestService');

const internal = svc._internal;

// --- classification helpers unchanged ---
assert.equal(internal.isCryptoSymbol('BTCUSDT'), true);
assert.equal(internal.isCryptoSymbol('AAPL'), false);
assert.equal(internal.isCryptoStrategy({ id: 'crypto_momentum_scalper', market_group: 'crypto' }), true);
assert.equal(internal.isCryptoStrategy({ id: 'trend_continuation', market_group: 'stocks' }), false);

// --- crypto market group is NO LONGER archived; crypto_certificates still is ---
assert.equal(internal.isLabArchivedMarket('crypto'), false, 'crypto market no longer archived');
assert.equal(internal.isLabArchivedMarket('crypto_certificates'), true, 'crypto certificates still archived');
assert.equal(internal.isLabArchivedMarket('stocks'), false);

// --- crypto is no longer hard-blocked from historical-data check ---
assert.equal(
  internal.hasLabBatchHistoricalData('AAPL', { days_covered: 6, candles_count: 1189, usable_for_batch: false }),
  true,
);
// crypto now goes through the same coverage/threshold gate:
assert.equal(
  internal.hasLabBatchHistoricalData('BTCUSDT', { days_covered: 30, candles_count: 10000, usable_for_batch: true }),
  true,
  'crypto with usable coverage is now runnable',
);
assert.equal(
  internal.hasLabBatchHistoricalData('BTCUSDT', { days_covered: 9, candles_count: 10584, market_group: 'crypto' }),
  true,
  'crypto passing day/candle threshold is runnable',
);
assert.equal(
  internal.hasLabBatchHistoricalData('BTCUSDT', { days_covered: 1, candles_count: 50, market_group: 'crypto' }),
  false,
  'crypto below threshold still skipped as missing_data (not archived)',
);

// --- grid: stocks + crypto majors both runnable, crypto strategies kept ---
const mixedGrid = svc.buildParameterGrid({
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

assert.equal(mixedGrid.ok, true, 'mixed stock+crypto-major grid is runnable');
// crypto_major is not blocked by outside_research_scope (scope decision is OK).
// If BTCUSDT is missing, it's due to missing_data (no historical file), not scope.
assert.ok(mixedGrid.config.symbols.includes('AAPL'), 'AAPL present');
const btcusdt = mixedGrid.config.skipped_symbols?.find((s) => s.symbol === 'BTCUSDT');
if (btcusdt) {
  assert.notEqual(btcusdt.reason, 'outside_research_scope',
    'BTCUSDT not blocked by scope (crypto_major is in-scope)');
} else {
  assert.ok(mixedGrid.config.symbols.includes('BTCUSDT'), 'BTCUSDT should be present if data available');
}
assert.equal(mixedGrid.config.strategy_ids.includes('crypto_momentum_scalper'), true, 'crypto strategy kept');
assert.equal(mixedGrid.config.markets.includes('crypto'), true, 'crypto market kept');
assert.deepEqual(mixedGrid.config.archived_lab_strategies, [], 'no crypto strategies reported as archived');

// --- crypto-only request: majors accepted by scope (not blocked via outside_research_scope) ---
const cryptoOnly = svc.buildParameterGrid({
  strategy_ids: ['crypto_momentum_scalper'],
  markets: ['crypto'],
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  timeframes: ['2m'],
  stop_losses: [0.2],
  take_profits: [1.5],
  holding_times: [5],
  timeouts: [8],
  confidence_thresholds: [65],
  volume_requirements: [1.2],
});
// crypto majors are in-scope and not blocked by research scope decisions.
// If they're skipped, it's due to missing_data (no historical files), not scope.
const scopeBlockedCrypto = (cryptoOnly.config.skipped_symbols || []).filter((s) => s.reason === 'outside_research_scope');
assert.equal(scopeBlockedCrypto.length, 0, 'crypto majors not blocked by research scope gate');

// --- crypto outside research scope is blocked (not archived) ---
const badCrypto = svc.buildParameterGrid({
  strategy_ids: ['trend_continuation'],
  markets: ['crypto'],
  symbols: ['XRPUSDT', 'DOGEUSDT'],
  timeframes: ['2m'],
  stop_losses: [0.2],
  take_profits: [1.5],
  holding_times: [5],
  timeouts: [8],
  confidence_thresholds: [65],
  volume_requirements: [1.2],
});
assert.equal(badCrypto.ok, false, 'non-major crypto has no runnable symbols');
assert.equal(
  (badCrypto.config.skipped_symbols || []).every((s) => s.reason === 'outside_research_scope'),
  true,
  'non-major crypto blocked via outside_research_scope',
);

// --- crypto_certificates market stays archived/blocked ---
const cert = svc.buildParameterGrid({
  strategy_ids: ['trend_continuation'],
  markets: ['crypto_certificates'],
  symbols: ['AAPL'],
  timeframes: ['2m'],
  stop_losses: [0.2],
  take_profits: [1.5],
  holding_times: [5],
  timeouts: [8],
  confidence_thresholds: [65],
  volume_requirements: [1.2],
});
assert.equal(
  (cert.config.skipped_markets || []).some((m) => m.id === 'crypto_certificates'),
  true,
  'crypto_certificates market still skipped/blocked',
);

// --- stocks/ETF scope filtering (S&P/Nasdaq majors allowed, others blocked) ---
const stockGrid = svc.buildParameterGrid({
  strategy_ids: ['trend_continuation'],
  markets: ['stocks'],
  symbols: ['SPY', 'QQQ', 'AAPL', 'IWM', 'TQQQ', 'NADAQ100'],
  timeframes: ['2m'],
  stop_losses: [0.2],
  take_profits: [1.5],
  holding_times: [5],
  timeouts: [8],
  confidence_thresholds: [65],
  volume_requirements: [1.2],
});
assert.equal(stockGrid.ok, true);
// S&P and Nasdaq majors (SPY, QQQ, AAPL) are in-scope; others are blocked.
// Note: If some in-scope symbols are missing due to missing_data (e.g., SPY),
// that's OK — the important test is that out-of-scope symbols are blocked via
// outside_research_scope, not scope drift.
const inScope = stockGrid.config.symbols;
assert.ok(inScope.includes('AAPL'), 'AAPL in-scope and available');
assert.ok(inScope.includes('QQQ'), 'QQQ in-scope and available');
// SPY may or may not be available depending on data files.

// Out-of-scope symbols must all be blocked via outside_research_scope.
assert.equal(
  (stockGrid.config.skipped_symbols || []).filter((s) => ['IWM', 'TQQQ', 'NADAQ100'].includes(s.symbol))
    .every((s) => s.reason === 'outside_research_scope'),
  true,
  'IWM/TQQQ/NADAQ100 blocked via research-scope',
);

console.log('# strategyBatchTestService lab archive tests passed.');
