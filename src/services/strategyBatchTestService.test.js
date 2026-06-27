'use strict';

// Tester för batch-körbarhet (paper-replay). Bevisar att backend accepterar samma
// symboler som UI visar som "körbara": coverage.usable_for_batch === true ELLER
// >= 3 dagar och >= 500 candles. Inga order, ingen broker, ingen runtime startas.

const assert = require('assert/strict');

// Mocka datakällan INNAN tjänsten laddas. Tjänsten håller en referens till samma
// modul-objekt, så att skriva över metoden här räcker.
const dataCoverage = require('./dataCoverageExpansionService');
const COVERAGE = {
  // 9 täckta dagar + 1700 candles → usable_for_batch=false i dataCoverageExpansionService
  // (kräver >= 10 dagar) men SKA vara körbar enligt fallback-regeln.
  AAPL: { days_covered: 9, candles_count: 1700, usable_for_batch: false, market_group: 'nasdaq100' },
  MSFT: { days_covered: 9, candles_count: 1700, usable_for_batch: false, market_group: 'nasdaq100' },
  NVDA: { days_covered: 9, candles_count: 1700, usable_for_batch: false, market_group: 'nasdaq100' },
  TSLA: { days_covered: 9, candles_count: 1700, usable_for_batch: false, market_group: 'nasdaq100' },
  META: { days_covered: 9, candles_count: 1700, usable_for_batch: false, market_group: 'nasdaq100' },
  AMZN: { days_covered: 9, candles_count: 1700, usable_for_batch: false, market_group: 'nasdaq100' },
};
dataCoverage.getSymbolCoverage = (symbol) => {
  const key = String(symbol).toUpperCase();
  const coverage = COVERAGE[key] || { days_covered: 0, candles_count: 0, usable_for_batch: false };
  return { ok: true, coverage: { symbol: key, ...coverage } };
};

const svc = require('./strategyBatchTestService');

(function run() {
  // 1. isBatchRunnableCoverage: ren regel-enhet.
  assert.equal(svc.isBatchRunnableCoverage({ usable_for_batch: true }), true, 'usable_for_batch=true → körbar');
  assert.equal(svc.isBatchRunnableCoverage({ days_covered: 9, candles_count: 1700 }), true, '9 dagar / 1700 candles → körbar');
  assert.equal(svc.isBatchRunnableCoverage({ days_covered: 9, candles_count: 500 }), true, '9 dagar / 500 candles → körbar (gräns)');
  assert.equal(svc.isBatchRunnableCoverage({ daysCovered: 3, candles_2m_count: 500 }), true, 'alternativa fältnamn stöds');
  assert.equal(svc.isBatchRunnableCoverage({ days_covered: 2, candles_count: 5000 }), false, '< 3 dagar → ej körbar');
  assert.equal(svc.isBatchRunnableCoverage({ days_covered: 9, candles_count: 499 }), false, '< 500 candles → ej körbar');
  assert.equal(svc.isBatchRunnableCoverage({}), false, 'tom coverage → ej körbar');
  assert.equal(svc.isBatchRunnableCoverage(null), false, 'null → ej körbar');

  // 2. Exakt payload från diagnosen ska INTE returnera missing_data.
  const payload = {
    symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'META', 'AMZN'],
    timeframes: ['2m'],
    date_from: '2026-06-15',
    date_to: '2026-06-26',
    markets: ['all'],
    // Håll grid:en liten så vi testar körbarhet, inte storleksgränsen.
    strategy_ids: [],
    stop_losses: [0.2],
    take_profits: [1],
    holding_times: [5],
    timeouts: [8],
    confidence_thresholds: [65],
    volume_requirements: [1.2],
  };

  const grid = svc.buildParameterGrid(payload);

  // Alla 6 symboler ska klassas som körbara av backend.
  assert.deepEqual(
    [...grid.config.symbols].sort(),
    ['AAPL', 'AMZN', 'META', 'MSFT', 'NVDA', 'TSLA'],
    'alla 6 symboler ska vara körbara i backend',
  );
  // Ingen missing_data-orsak får finnas.
  assert.notEqual(grid.reason, 'missing_data', 'reason får inte vara missing_data');
  assert.equal(grid.errors?.missing_data, undefined, 'errors.missing_data ska saknas');
  assert.equal(grid.skipped_symbols?.length || 0, 0, 'inga symboler ska skippas pga saknad data');

  // 3. Safety: batch är alltid paper-only, inga order.
  assert.equal(grid.actions_allowed, false);
  assert.equal(grid.can_place_orders, false);
  assert.equal(grid.live_trading_enabled, false);
  assert.equal(grid.paper_only, true);

  console.log('# strategyBatchTestService tests passed.');
  process.exit(0);
})();
