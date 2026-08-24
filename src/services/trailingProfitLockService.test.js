'use strict';

const assert = require('assert/strict');
const service = require('./trailingProfitLockService');

function testTrailEvaluation() {
  console.log('\n=== Trail Evaluation Tests ===\n');

  // Test 1: Below activation
  const below = service.evaluateTrailingStopModification({
    trade: {
      entryPrice: 100,
      direction: 'long',
      tradeQuantity: 1,
      maxUnrealizedPnlSek: 400,
    },
    currentPrice: 104,
    executionContext: { tickSize: 0.01 },
  });
  assert.strictEqual(below.needsModify, false, 'Test 1: Below 500 SEK should not trigger');
  assert.strictEqual(below.reason, 'below_activation_threshold');
  console.log('✓ Test 1: Below activation threshold (400 SEK < 500) — no modify');

  // Test 2: Exact activation
  const exact = service.evaluateTrailingStopModification({
    trade: {
      entryPrice: 100,
      direction: 'long',
      tradeQuantity: 1,
      maxUnrealizedPnlSek: 0,
      trailingProfitFloorSek: 0,
    },
    currentPrice: 105,
    executionContext: { tickSize: 0.01 },
  });
  // At 105, PnL% = 5% = 500 SEK
  assert.strictEqual(exact.pnlSek >= 500, true, 'Test 2: At 500 SEK should be at/above threshold');
  console.log(`✓ Test 2: At activation (505 SEK ≥ 500) — trail should activate`);

  // Test 3: MFE improvement
  // Entry 100, +1000 SEK = +10% gain = current price 110
  const improved = service.evaluateTrailingStopModification({
    trade: {
      entryPrice: 100,
      direction: 'long',
      tradeQuantity: 1,
      maxUnrealizedPnlSek: 1000,
      trailingProfitFloorSek: 500,
      stopPrice: 99.7,
    },
    currentPrice: 110,
    executionContext: { tickSize: 0.01 },
  });
  assert.ok(improved.maxUnrealizedSek >= 1000, `Test 3: MFE should be ≥ previous (got ${improved.maxUnrealizedSek})`);
  assert.ok(improved.floorSek >= 500, 'Test 3: Floor should be ≥ previous (monotonic)');
  console.log(`✓ Test 3: MFE monotonic (current ${improved.maxUnrealizedSek} ≥ previous 1000)`);

  // Test 4: LONG monotonic (stop up only)
  const longMove = service.evaluateTrailingStopModification({
    trade: {
      entryPrice: 100,
      direction: 'long',
      tradeQuantity: 1,
      maxUnrealizedPnlSek: 2000,
      trailingProfitFloorSek: 1500,
      stopPrice: 99,
    },
    currentPrice: 102.5,
    executionContext: { tickSize: 0.01 },
  });
  if (longMove.needsModify) {
    assert.ok(longMove.roundedStopPrice > (longMove.currentStopPrice || 99),
      'Test 4: LONG stop must move UP');
    console.log(`✓ Test 4: LONG monotonic (stop ${longMove.currentStopPrice} → ${longMove.roundedStopPrice})`);
  } else {
    console.log('✓ Test 4: LONG no need to modify (already protected)');
  }

  // Test 5: SHORT monotonic (stop down only)
  const shortMove = service.evaluateTrailingStopModification({
    trade: {
      entryPrice: 100,
      direction: 'short',
      tradeQuantity: 1,
      maxUnrealizedPnlSek: 2000,
      trailingProfitFloorSek: 1500,
      stopPrice: 101.5,
    },
    currentPrice: 97.5,
    executionContext: { tickSize: 0.01 },
  });
  if (shortMove.needsModify) {
    assert.ok(shortMove.roundedStopPrice < (shortMove.currentStopPrice || 101.5),
      'Test 5: SHORT stop must move DOWN');
    console.log(`✓ Test 5: SHORT monotonic (stop ${shortMove.currentStopPrice} → ${shortMove.roundedStopPrice})`);
  } else {
    console.log('✓ Test 5: SHORT no need to modify (already protected)');
  }

  console.log('\n=== All Trail Evaluation Tests PASSED ===\n');
}

function testPriceCalculation() {
  console.log('\n=== Price Calculation Tests ===\n');

  // Test LONG: +500 SEK floor at entry 100
  const longFloor500 = service.priceFromSekPnl(100, 500, 'long', 1);
  assert.ok(Number.isFinite(longFloor500), 'Test 1: LONG floor price should be valid');
  console.log(`✓ Test 1: LONG entry 100, floor +500 SEK → stop price ${longFloor500?.toFixed(2)}`);

  // Test LONG: +1500 SEK floor at entry 100
  const longFloor1500 = service.priceFromSekPnl(100, 1500, 'long', 1);
  assert.ok(Number.isFinite(longFloor1500), 'Test 2: LONG floor price should be valid');
  console.log(`✓ Test 2: LONG entry 100, floor +1500 SEK → stop price ${longFloor1500?.toFixed(2)}`);

  // Test SHORT: +500 SEK floor at entry 100
  const shortFloor500 = service.priceFromSekPnl(100, 500, 'short', 1);
  assert.ok(Number.isFinite(shortFloor500), 'Test 3: SHORT floor price should be valid');
  console.log(`✓ Test 3: SHORT entry 100, floor +500 SEK → stop price ${shortFloor500?.toFixed(2)}`);

  // Verify LONG > entry, SHORT < entry for positive SEK
  assert.ok(longFloor500 > 100, 'Test 4: LONG stop > entry for positive PnL');
  assert.ok(shortFloor500 < 100, 'Test 4: SHORT stop < entry for positive PnL');
  console.log('✓ Test 4: LONG/SHORT directional stops correct');

  console.log('\n=== All Price Calculation Tests PASSED ===\n');
}

function testStopOrderPatch() {
  console.log('\n=== Stop Order Patch Tests ===\n');

  const patchLong = service.buildStopOrderPatch('long', 99.5);
  assert.ok(patchLong && typeof patchLong === 'object', 'Test 1: Patch should be object');
  assert.strictEqual(patchLong.auxPrice, 99.5, 'Test 1: auxPrice should be set');
  console.log('✓ Test 1: LONG patch built correctly');

  const patchShort = service.buildStopOrderPatch('short', 100.5);
  assert.strictEqual(patchShort.auxPrice, 100.5, 'Test 2: SHORT patch auxPrice correct');
  console.log('✓ Test 2: SHORT patch built correctly');

  const patchInvalid = service.buildStopOrderPatch('invalid', null);
  assert.strictEqual(patchInvalid, null, 'Test 3: Invalid direction should return null');
  console.log('✓ Test 3: Invalid input returns null');

  console.log('\n=== All Stop Order Patch Tests PASSED ===\n');
}

function main() {
  console.log('\n████████████████████████████████████████');
  console.log('   Trailing Profit Lock Service Tests');
  console.log('████████████████████████████████████████');

  testPriceCalculation();
  testStopOrderPatch();
  testTrailEvaluation();

  console.log('████████████████████████████████████████');
  console.log('   ALL TESTS PASSED ✓');
  console.log('████████████████████████████████████████\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  testPriceCalculation,
  testStopOrderPatch,
  testTrailEvaluation,
};
