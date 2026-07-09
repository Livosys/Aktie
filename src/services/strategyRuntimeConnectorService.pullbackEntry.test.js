'use strict';

// Fokuserat test: runtime-kartans per-signal-flagga can_create_paper_trade:false
// ska vinna över strateginivåns active/can_create:true, utan att påverka
// tillåtna signaler och utan att okända signaler faller tillbaka till
// trend_continuation.

const assert = require('assert/strict');

const conn = require('./strategyRuntimeConnectorService');

function assertSafety(result, label) {
  assert.equal(result.actions_allowed, false, `${label}: actions_allowed`);
  assert.equal(result.can_place_orders, false, `${label}: can_place_orders`);
  assert.equal(result.live_trading_enabled, false, `${label}: live_trading_enabled`);
  assert.equal(result.paper_only, true, `${label}: paper_only`);
}

// 1. REGULAR_PULLBACK (kartflagga can_create_paper_trade:false) får inte skapa paper trade.
{
  const stocks = conn.canCreatePaperTradeForSignal({ symbol: 'QQQ', signalSubtype: 'REGULAR_PULLBACK', marketType: 'stocks', status: 'buy', nextMoveBias: 'UP' });
  assert.equal(stocks.allowed, false, 'REGULAR_PULLBACK stocks ska blockas');
  assert.equal(stocks.strategy?.strategy_id, 'trend_continuation', 'REGULAR_PULLBACK mappas fortfarande till trend_continuation');
  assertSafety(stocks, 'pullback stocks');

  const crypto = conn.canCreatePaperTradeForSignal({ symbol: 'ETHUSDT', signalSubtype: 'REGULAR_PULLBACK', marketType: 'crypto', status: 'buy', nextMoveBias: 'DOWN' });
  assert.equal(crypto.allowed, false, 'REGULAR_PULLBACK crypto ska blockas');

  // Även när kandidaten bär explicit strategyId ska raw-signalens kartflagga vinna.
  const explicit = conn.canCreatePaperTradeForSignal({ symbol: 'ETHUSDT', strategyId: 'trend_continuation', signalSubtype: 'REGULAR_PULLBACK', marketType: 'crypto' });
  assert.equal(explicit.allowed, false, 'REGULAR_PULLBACK med explicit trend_continuation ska blockas');
}

// 2. NARROW_WAIT (kartflagga can_create_paper_trade:false) får inte skapa paper trade.
{
  const plain = conn.canCreatePaperTradeForSignal({
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_WAIT',
    nextMoveBias: 'DOWN',
    status: 'watch',
  });
  assert.equal(plain.allowed, false, 'NARROW_WAIT utan explicit strategyId ska blockas');
  assert.equal(plain.strategy?.strategy_id, 'narrow_breakout', 'NARROW_WAIT mappas fortfarande till narrow_breakout');
  assert.equal(plain.strategy?.can_create_paper_trade, false, 'NARROW_WAIT ska ha can_create_paper_trade=false');
  assert.equal(plain.strategy?.blocked_reason_code, 'narrow_wait_not_paper_entry', 'NARROW_WAIT blocker reason code');
  assert.ok(String(plain.reason || '').includes('NARROW_WAIT är ett vänteläge'), `NARROW_WAIT reason, fick: ${plain.reason}`);
  assertSafety(plain, 'narrow wait plain');

  const explicitStrategy = conn.canCreatePaperTradeForSignal({
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    strategyId: 'narrow_breakout',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_WAIT',
    nextMoveBias: 'DOWN',
    status: 'watch',
  });
  assert.equal(explicitStrategy.allowed, false, 'NARROW_WAIT med explicit strategyId ska blockas');

  const explicitSource = conn.canCreatePaperTradeForSignal({
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    sourceStrategyId: 'narrow_breakout',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_WAIT',
    nextMoveBias: 'DOWN',
    status: 'watch',
  });
  assert.equal(explicitSource.allowed, false, 'NARROW_WAIT med explicit sourceStrategyId ska blockas');
}

// 3. Blocker reason för REGULAR_PULLBACK är tydlig och stabil.
{
  const d = conn.canCreatePaperTradeForSignal({ symbol: 'QQQ', signalSubtype: 'REGULAR_PULLBACK', marketType: 'stocks' });
  assert.ok(String(d.reason || '').includes('setup_not_paper_entry'), `reason ska innehålla setup_not_paper_entry, fick: ${d.reason}`);
  assert.equal(d.strategy?.blocked_reason_code, 'setup_not_paper_entry', 'blocked_reason_code ska vara setup_not_paper_entry');
  assert.equal(d.strategy?.can_create_paper_trade, false, 'can_create_paper_trade ska vara false');
}

// 4. trend_continuation via annan tillåten väg påverkas inte (explicit id utan REGULAR_PULLBACK-raw).
{
  const d = conn.canCreatePaperTradeForSignal({ symbol: 'QQQ', strategyId: 'trend_continuation', signalSubtype: 'TREND_CONTINUATION', marketType: 'stocks' });
  assert.equal(d.strategy?.strategy_id, 'trend_continuation', 'explicit trend_continuation resolvas');
  assert.equal(d.allowed, true, 'trend_continuation med annan setup ska inte blockas av pullback-regeln');
  assert.notEqual(d.strategy?.blocked_reason_code, 'setup_not_paper_entry', 'ingen pullback-blocker på annan setup');
}

// 5. Okänd signal faller inte tillbaka till trend_continuation.
{
  const d = conn.canCreatePaperTradeForSignal({ symbol: 'GOOGL', signalFamily: 'UNKNOWN', signalSubtype: 'NO_TRADE', marketType: 'stocks' });
  assert.equal(d.allowed, false, 'okänd signal ska blockas');
  assert.equal(d.strategy?.strategy_id ?? null, null, 'okänd signal ska inte få strategi-id');
}

// 6. EMA-beteendet är oförändrat i denna commit (runtime-gaten släpper fortfarande igenom;
//    EMA-pausen hanteras senare i kedjan precis som före ändringen).
{
  const d = conn.canCreatePaperTradeForSignal({ symbol: 'QQQ', signalSubtype: 'EMA_PULLBACK_UP', marketType: 'stocks' });
  assert.equal(d.strategy?.strategy_id, 'ema_pullback_continuation', 'EMA mappas som förut');
  assert.equal(d.allowed, true, 'EMA runtime-gate-beslut oförändrat (true som före ändringen)');
}

// 7. Tillåtna narrow-strategier påverkas inte.
{
  const bull = conn.canCreatePaperTradeForSignal({ symbol: 'QQQ', signalSubtype: 'NARROW_BULL_ENTRY', marketType: 'stocks' });
  assert.equal(bull.allowed, true, 'NARROW_BULL_ENTRY oförändrad');
  const bear = conn.canCreatePaperTradeForSignal({ symbol: 'QQQ', signalSubtype: 'NARROW_BEAR_ENTRY', marketType: 'stocks' });
  assert.equal(bear.allowed, true, 'NARROW_BEAR_ENTRY oförändrad');
  const fake = conn.canCreatePaperTradeForSignal({ symbol: 'QQQ', signalSubtype: 'NARROW_FAKEOUT', marketType: 'stocks' });
  assert.equal(fake.allowed, true, 'NARROW_FAKEOUT oförändrad');
}

console.log('strategyRuntimeConnectorService.pullbackEntry tests passed.');
