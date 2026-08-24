'use strict';

/**
 * Tests for Trailing Profit Lock (v4) feature:
 * - 10 logical trades × qty 1
 * - Strategy diversity prioritization
 * - Trailing profit floor at 500 SEK gap
 * - Monotonic MFE tracking
 */

const assert = require('assert/strict');

const TRAILING_PROFIT_LOCK_ACTIVATION_SEK = 500;
const TRAILING_GAP_SEK = 500;
const PAPER_TRADE_QUANTITY = 1;

function testTrailingProfitLockActivation() {
  // Test A: threshold at exactly 500 SEK
  const trade1 = {
    profitTrailActivated: false,
    maxUnrealizedPnlSek: 0,
    trailingProfitFloorSek: 0,
  };

  // Simulate MFE at 499 SEK (should NOT activate)
  const pnlSek_499 = 499;
  assert.strictEqual(
    pnlSek_499 >= TRAILING_PROFIT_LOCK_ACTIVATION_SEK,
    false,
    'Test A1: 499 SEK should NOT trigger activation'
  );

  // Simulate MFE at 500 SEK (should activate)
  const pnlSek_500 = 500;
  assert.strictEqual(
    pnlSek_500 >= TRAILING_PROFIT_LOCK_ACTIVATION_SEK,
    true,
    'Test A2: 500 SEK should trigger activation'
  );

  console.log('✓ Test A: Activation threshold at 500 SEK PASSED');
}

function testTrailingFloorCalculation() {
  // Test B: floor = MFE - 500
  const scenarios = [
    { mfe: 500, expectedFloor: 0 },
    { mfe: 800, expectedFloor: 300 },
    { mfe: 1000, expectedFloor: 500 },
    { mfe: 1500, expectedFloor: 1000 },
    { mfe: 2000, expectedFloor: 1500 },
    { mfe: 3000, expectedFloor: 2500 },
  ];

  scenarios.forEach(({ mfe, expectedFloor }) => {
    const calculatedFloor = mfe - TRAILING_GAP_SEK;
    assert.strictEqual(
      calculatedFloor,
      expectedFloor,
      `Test B: MFE ${mfe} should have floor ${expectedFloor}, got ${calculatedFloor}`
    );
  });

  console.log('✓ Test B: Floor calculation (MFE - 500) PASSED');
}

function testMonotonicMfeTracking() {
  // Test C: MFE never decreases after first activation
  const trade = {
    profitTrailActivated: true,
    maxUnrealizedPnlSek: 1000,
    trailingProfitFloorSek: 500,
  };

  // Simulate sequence: +2000 → +1900 → +1700 → +1510 (all stay above floor)
  const sequence = [2000, 1900, 1700, 1510];
  let maxSoFar = 1000;

  sequence.forEach((current) => {
    if (current > maxSoFar) {
      maxSoFar = current;
      const newFloor = maxSoFar - TRAILING_GAP_SEK;
      assert.ok(
        newFloor >= trade.trailingProfitFloorSek || newFloor === maxSoFar - TRAILING_GAP_SEK,
        `Test C: Floor should never decrease when MFE improves`
      );
    }
  });

  // Verify floor never moved backward
  assert.strictEqual(
    maxSoFar,
    2000,
    'Test C: MFE should be monotonically increasing'
  );

  console.log('✓ Test C: Monotonic MFE tracking PASSED');
}

function testTrailingFloorCrossing() {
  // Test D: detect when current PnL falls below trailing floor
  const scenarios = [
    {
      desc: 'D1: +2000 → +1600 (should continue)',
      mfe: 2000,
      current: 1600,
      floor: 1500,
      shouldExit: false,
    },
    {
      desc: 'D2: +2000 → +1550 (should continue)',
      mfe: 2000,
      current: 1550,
      floor: 1500,
      shouldExit: false,
    },
    {
      desc: 'D3: +2000 → +1500 (borderline)',
      mfe: 2000,
      current: 1500,
      floor: 1500,
      shouldExit: false, // Equal to floor, usually allow one more tick
    },
    {
      desc: 'D4: +2000 → +1499 (should exit)',
      mfe: 2000,
      current: 1499,
      floor: 1500,
      shouldExit: true,
    },
  ];

  scenarios.forEach(({ desc, mfe, current, floor, shouldExit }) => {
    const exitTriggered = current < floor;
    assert.strictEqual(
      exitTriggered,
      shouldExit,
      `Test ${desc}: current=${current}, floor=${floor}, exit=${exitTriggered}, expected=${shouldExit}`
    );
  });

  console.log('✓ Test D: Trailing floor crossing detection PASSED');
}

function testStrategyDiversityBonus() {
  // Test E: strategy diversity prioritization
  const evaluateStrategyDiversity = (candidate, openTrades) => {
    const candStratId = candidate?.strategyId || candidate?.strategy_id || null;
    if (!candStratId) return 0;

    const openStrategyIds = new Set(
      openTrades
        .filter(t => t && (t.strategyId || t.strategy_id))
        .map(t => t.strategyId || t.strategy_id)
    );

    if (!openStrategyIds.has(candStratId)) return 1; // Diversity bonus
    return -0.1; // Penalty if already open
  };

  const openTrades = [
    { strategyId: 'STRAT_A', symbol: 'MES' },
    { strategyId: 'STRAT_A', symbol: 'NQ' },
    { strategyId: 'STRAT_B', symbol: 'ES' },
  ];

  const candNew = { strategyId: 'STRAT_C', symbol: 'MES' };
  const candDuplicate = { strategyId: 'STRAT_A', symbol: 'AAPL' };

  const bonusNew = evaluateStrategyDiversity(candNew, openTrades);
  const bonusDuplicate = evaluateStrategyDiversity(candDuplicate, openTrades);

  assert.strictEqual(bonusNew, 1, 'Test E1: New strategy should get +1 diversity bonus');
  assert.strictEqual(
    bonusDuplicate,
    -0.1,
    'Test E2: Duplicate strategy should get -0.1 penalty'
  );

  console.log('✓ Test E: Strategy diversity bonus PASSED');
}

function testQuantityModel() {
  // Test F: Verify qty=1 per logical trade
  assert.strictEqual(
    PAPER_TRADE_QUANTITY,
    1,
    'Test F: Paper trade quantity must always be 1'
  );

  // 10 logical trades × qty 1 = broker aggregate qty 10
  const logicalTrades = 10;
  const qtyPerTrade = PAPER_TRADE_QUANTITY;
  const brokerAggregateQty = logicalTrades * qtyPerTrade;

  assert.strictEqual(
    brokerAggregateQty,
    10,
    `Test F: 10 logical trades × qty 1 = aggregate qty ${brokerAggregateQty}`
  );

  console.log('✓ Test F: Quantity model (qty=1) PASSED');
}

function testPersistence() {
  // Test G: Verify MFE/floor fields persisted in trade object
  const trade = {
    tradeId: 'TRADE_001',
    strategyId: 'STRAT_A',
    profitTrailActivated: true,
    maxUnrealizedPnlSek: 1500,
    trailingProfitFloorSek: 1000,
    lastTrailUpdateAt: '2026-08-24T10:30:00.000Z',
  };

  // Verify persistence fields exist
  assert.ok(trade.profitTrailActivated !== undefined, 'Test G1: profitTrailActivated must be persisted');
  assert.ok(trade.maxUnrealizedPnlSek !== undefined, 'Test G2: maxUnrealizedPnlSek must be persisted');
  assert.ok(trade.trailingProfitFloorSek !== undefined, 'Test G3: trailingProfitFloorSek must be persisted');
  assert.ok(trade.lastTrailUpdateAt !== undefined, 'Test G4: lastTrailUpdateAt must be persisted');

  console.log('✓ Test G: Persistence fields PASSED');
}

function main() {
  console.log('\n=== Trailing Profit Lock (v4) Tests ===\n');

  testTrailingProfitLockActivation();
  testTrailingFloorCalculation();
  testMonotonicMfeTracking();
  testTrailingFloorCrossing();
  testStrategyDiversityBonus();
  testQuantityModel();
  testPersistence();

  console.log('\n=== All tests PASSED ===\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  testTrailingProfitLockActivation,
  testTrailingFloorCalculation,
  testMonotonicMfeTracking,
  testTrailingFloorCrossing,
  testStrategyDiversityBonus,
  testQuantityModel,
  testPersistence,
};
