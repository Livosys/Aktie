'use strict';

const assert = require('assert/strict');
const svc = require('./interactiveBrokersPaperBlueprintNormalizerService');

function assertGoogl(normalized) {
  assert.equal(normalized.symbol, 'GOOGL');
  assert.equal(normalized.side, 'SELL');
  assert.equal(normalized.quantity, 40);
  assert.equal(normalized.marketGroup, 'stock');
  assert.equal(normalized.assetClass, 'STK');
  assert.equal(normalized.secType, 'STK');
  assert.equal(normalized.currency, 'USD');
  assert.equal(normalized.exchange, 'SMART');
  assert.equal(normalized.primaryExchange, 'NASDAQ');
  assert.equal(normalized.entryPrice, 367.04);
  assert.equal(normalized.stopLoss, 367.41);
  assert.equal(normalized.takeProfit, 366.31);
  assert.ok(normalized.stopLossPct >= 0.10);
  assert.equal(normalized.riskReward, 1.97);
  assert.equal(normalized.validForPreflight, true);
  assert.deepEqual(normalized.blockers, []);
}

const minimal = svc.normalizeIbPaperSelectedBlueprint({
  symbol: 'GOOGL',
  side: 'SELL',
  quantity: 40,
  entry: 367.04,
  stopLoss: 367.41,
  takeProfit: 366.31,
});
assertGoogl(minimal);

const manualPanel = svc.normalizeIbPaperSelectedBlueprint({
  symbol: 'GOOGL',
  strategyId: 'narrow_breakout',
  strategyName: 'Narrow Breakout',
  direction: 'short',
  quantity: '40',
  entryPrice: '367.04',
  stopLoss: '367.41',
  takeProfit: '366.31',
  source: 'manual_panel',
});
assertGoogl(manualPanel);
assert.equal(manualPanel.source, 'manual_panel');

const tradeBlueprint = svc.normalizeIbPaperSelectedBlueprint({
  blueprintId: 'ibpb_googl',
  symbol: 'GOOGL',
  strategyId: 'narrow_breakout',
  strategyName: 'Narrow Breakout',
  side: 'SELL',
  quantity: 40,
  entryReferencePrice: 367.04,
  stopLossPrice: 367.41,
  takeProfit1: 366.31,
  marketGroup: 'stocks',
  assetClass: 'STK',
  source: 'trade_blueprint',
});
assertGoogl(tradeBlueprint);
assert.equal(tradeBlueprint.marketGroup, 'stock');
assert.ok(!tradeBlueprint.blockers.includes('unsupported_market'));

const crypto = svc.normalizeIbPaperSelectedBlueprint({
  symbol: 'BTCUSDT',
  side: 'BUY',
  quantity: 1,
  entry: 64000,
  stopLoss: 63900,
  takeProfit: 64200,
});
assert.equal(crypto.marketGroup, 'crypto');
assert.ok(crypto.blockers.includes('crypto_not_allowed_for_ib_paper_first_order'));

const etf = svc.normalizeIbPaperSelectedBlueprint({
  symbol: 'QQQ',
  side: 'BUY',
  quantity: 1,
  entry: 500,
  stopLoss: 499,
  takeProfit: 502,
});
assert.equal(etf.marketGroup, 'etf');
assert.ok(etf.blockers.includes('etf_not_allowed_for_ib_paper_first_order'));

const missingSide = svc.normalizeIbPaperSelectedBlueprint({
  symbol: 'GOOGL',
  quantity: 40,
  entry: 367.04,
  stopLoss: 367.41,
  takeProfit: 366.31,
});
assert.ok(missingSide.blockers.includes('selected_blueprint_side_missing'));

const missingQuantity = svc.normalizeIbPaperSelectedBlueprint({
  symbol: 'GOOGL',
  side: 'SELL',
  entry: 367.04,
  stopLoss: 367.41,
  takeProfit: 366.31,
});
assert.ok(missingQuantity.blockers.includes('selected_blueprint_quantity_missing'));

assert.equal(svc.SAFETY.actions_allowed, false);
assert.equal(svc.SAFETY.can_place_orders, false);
assert.equal(svc.SAFETY.live_trading_enabled, false);
assert.equal(svc.SAFETY.broker_enabled, false);

console.log('interactiveBrokersPaperBlueprintNormalizerService.test.js passed');
