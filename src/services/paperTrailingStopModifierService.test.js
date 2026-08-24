'use strict';

const assert = require('assert/strict');
const service = require('./paperTrailingStopModifierService');

function testOwnershipValidation() {
  console.log('\n=== Ownership Validation Tests ===\n');

  // Test 1: Valid ownership
  const valid = service.validateOwnership({
    trade: {
      paperOnly: true,
      executionId: 'fxp_abc123',
      tradeId: 'TRADE_001',
      tradeQuantity: 1,
      direction: 'long',
    },
    executionContext: {
      stopOrderId: 12345,
      orderRef: 'TOS-PAPER-fxp_abc123-stopLoss',
    },
  });
  assert.strictEqual(valid.valid, true, 'Test 1: Valid ownership should pass');
  console.log('✓ Test 1: Valid ownership PASS');

  // Test 2: Not paper only
  const notPaper = service.validateOwnership({
    trade: {
      paperOnly: false,
      executionId: 'fxp_abc123',
      tradeId: 'TRADE_001',
      tradeQuantity: 1,
      direction: 'long',
    },
    executionContext: {
      stopOrderId: 12345,
      orderRef: 'TOS-PAPER-fxp_abc123-stopLoss',
    },
  });
  assert.strictEqual(notPaper.valid, false, 'Test 2: Non-paper should FAIL');
  assert.ok(notPaper.blockers.includes('paperOnly'), 'Test 2: Should block non-paper');
  console.log('✓ Test 2: Non-paper BLOCKED');

  // Test 3: qty != 1
  const qtyWrong = service.validateOwnership({
    trade: {
      paperOnly: true,
      executionId: 'fxp_abc123',
      tradeId: 'TRADE_001',
      tradeQuantity: 10,
      direction: 'long',
    },
    executionContext: {
      stopOrderId: 12345,
      orderRef: 'TOS-PAPER-fxp_abc123-stopLoss',
    },
  });
  assert.strictEqual(qtyWrong.valid, false, 'Test 3: qty != 1 should FAIL');
  assert.ok(qtyWrong.blockers.includes('qtyIsOne'), 'Test 3: Should block qty != 1');
  console.log('✓ Test 3: qty != 1 BLOCKED');

  // Test 4: Missing executionId
  const noExecId = service.validateOwnership({
    trade: {
      paperOnly: true,
      tradeId: 'TRADE_001',
      tradeQuantity: 1,
      direction: 'long',
    },
    executionContext: {
      stopOrderId: 12345,
    },
  });
  assert.strictEqual(noExecId.valid, false, 'Test 4: Missing executionId should FAIL');
  console.log('✓ Test 4: Missing executionId BLOCKED');

  console.log('\n=== All Ownership Tests PASSED ===\n');
}

function testModificationPrep() {
  console.log('\n=== Modification Prep Tests ===\n');

  // Test 1: Below activation threshold
  const belowThresh = service.prepareModificationPatch({
    trade: {
      paperOnly: true,
      executionId: 'fxp_abc123',
      tradeId: 'TRADE_001',
      tradeQuantity: 1,
      direction: 'long',
      entryPrice: 100,
      maxUnrealizedPnlSek: 400,
    },
    currentPrice: 104,
    executionContext: {
      stopOrderId: 12345,
      orderRef: 'TOS-PAPER-fxp_abc123-stopLoss',
      tickSize: 0.01,
    },
  });
  assert.strictEqual(belowThresh.shouldModify, false, 'Test 1: Below threshold should not modify');
  console.log('✓ Test 1: Below 500 SEK threshold — no modify');

  // Test 2: At activation, needs modify
  const atThresh = service.prepareModificationPatch({
    trade: {
      paperOnly: true,
      executionId: 'fxp_abc123',
      tradeId: 'TRADE_001',
      tradeQuantity: 1,
      direction: 'long',
      entryPrice: 100,
      maxUnrealizedPnlSek: 0,
      stopPrice: 99.7,
    },
    currentPrice: 105.1,  // +5.1% = +510 SEK
    executionContext: {
      stopOrderId: 12345,
      orderRef: 'TOS-PAPER-fxp_abc123-stopLoss',
      tickSize: 0.01,
    },
  });
  assert.strictEqual(atThresh.shouldModify, true, 'Test 2: At activation should prepare modify');
  assert.ok(atThresh.patch, 'Test 2: Should have patch');
  console.log('✓ Test 2: At 500+ SEK — prepared for modify');

  // Test 3: LONG monotonic (stop moves up)
  const longUp = service.prepareModificationPatch({
    trade: {
      paperOnly: true,
      executionId: 'fxp_abc123',
      tradeId: 'TRADE_001',
      tradeQuantity: 1,
      direction: 'long',
      entryPrice: 100,
      maxUnrealizedPnlSek: 2000,
      stopPrice: 99,
    },
    currentPrice: 102.5,
    executionContext: {
      stopOrderId: 12345,
      orderRef: 'TOS-PAPER-fxp_abc123-stopLoss',
      tickSize: 0.01,
    },
    previousStopPrice: 99,
  });
  if (longUp.shouldModify) {
    assert.ok(longUp.newStopPrice > 99, 'Test 3: LONG stop should move UP');
    console.log(`✓ Test 3: LONG stop moved UP (${longUp.newStopPrice})`);
  } else {
    console.log('✓ Test 3: LONG no modify needed (already protected)');
  }

  console.log('\n=== All Modification Prep Tests PASSED ===\n');
}

function main() {
  console.log('\n████████████████████████████████████████');
  console.log('   Trailing Stop Modifier Service Tests');
  console.log('████████████████████████████████████████');

  testOwnershipValidation();
  testModificationPrep();

  console.log('████████████████████████████████████████');
  console.log('   ALL TESTS PASSED ✓');
  console.log('████████████████████████████████████████\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  testOwnershipValidation,
  testModificationPrep,
};
