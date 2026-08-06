'use strict';

// FAS C mapping-guard-tester: UNKNOWN/NO_TRADE/LATE_MOVE_BLOCK och contract-
// lösa crypto-VWAP-signaler får aldrig mappas till en strategi (särskilt inte
// crypto_momentum_scalper som catch-all). Kända mappings ska vara oförändrade.
// Read-only regel-logik — inga trades/kandidater skapas, inga stores muteras.

const assert = require('assert/strict');

const conn = require('./strategyRuntimeConnectorService');
const catalog = require('./daytradingStrategyCatalogService');

function decide(signal) {
  const d = conn.canCreatePaperTradeForSignal(signal);
  return {
    strategyId: (d.strategy && d.strategy.strategy_id) || null,
    allowed: d.allowed === true,
    blockedReason: d.blocked_reason_code || null,
  };
}

// 1+2. UNKNOWN ger strategyId=null för både crypto och stocks.
for (const [symbol, market] of [['BTCUSDT', 'crypto'], ['AAPL', 'stocks']]) {
  const r = decide({ signalFamily: 'UNKNOWN', signalSubtype: 'UNKNOWN', symbol, marketType: market });
  assert.equal(r.strategyId, null, `UNKNOWN ${market}: strategyId=null`);
  assert.equal(r.allowed, false);
  assert.equal(r.blockedReason, 'unknown_signal_mapping');
}

// 3. NO_TRADE ger strategyId=null (crypto + stocks).
for (const [symbol, market] of [['ETHUSDT', 'crypto'], ['TSLA', 'stocks']]) {
  const r = decide({ signalFamily: 'UNKNOWN', signalSubtype: 'NO_TRADE', symbol, marketType: market });
  assert.equal(r.strategyId, null, `NO_TRADE ${market}: strategyId=null`);
  assert.equal(r.allowed, false);
  assert.equal(r.blockedReason, 'no_trade_signal');
}

// 4. LATE_MOVE_BLOCK ger strategyId=null — även när subtypen är en variant
// (THREE_FINGER_SPREAD_AVOID) och familjen bär blocket.
for (const sig of [
  { signalFamily: 'LATE_MOVE_BLOCK', signalSubtype: 'LATE_MOVE_BLOCK', symbol: 'QQQ', marketType: 'stocks' },
  { signalFamily: 'LATE_MOVE_BLOCK', signalSubtype: 'THREE_FINGER_SPREAD_AVOID', symbol: 'BTCUSDT', marketType: 'crypto' },
]) {
  const r = decide(sig);
  assert.equal(r.strategyId, null, `LATE_MOVE_BLOCK (${sig.signalSubtype}): strategyId=null`);
  assert.equal(r.allowed, false);
  assert.equal(r.blockedReason, 'late_move_block');
}

// 5+6. Crypto-VWAP utan context mappar INTE till crypto_momentum_scalper och
// ger den stabila missing-context-koden.
for (const subtype of ['VWAP_RECLAIM_UP', 'VWAP_REJECTION_DOWN']) {
  const r = decide({ signalFamily: 'VWAP_RECLAIM_REJECTION', signalSubtype: subtype, symbol: 'BTCUSDT', marketType: 'crypto', nextMoveBias: subtype.endsWith('UP') ? 'UP' : 'DOWN' });
  assert.equal(r.strategyId, null, `crypto ${subtype}: ingen fallback till scalper`);
  assert.notEqual(r.strategyId, 'crypto_momentum_scalper');
  assert.equal(r.allowed, false);
  assert.equal(r.blockedReason, 'runtime_partial_missing_crypto_signal_context');
}

// 7. Explicit contract-match kan fortfarande mappas till crypto_momentum_scalper
// (rå scalper-signal). Paper är fortsatt blockerad tills context finns —
// mappningen är poängen, inte entry.
{
  const r = decide({ signalSubtype: 'CRYPTO_MOMENTUM_SCALPER', symbol: 'BTCUSDT', marketType: 'crypto', nextMoveBias: 'UP' });
  assert.equal(r.strategyId, 'crypto_momentum_scalper', 'uttrycklig contract-signal mappas fortfarande');
  assert.equal(r.allowed, false, 'entry fortsatt blockerad utan context');
}

// 8. Kända Narrow-mappings oförändrade.
{
  const bull = decide({ signalFamily: 'NARROW_COMPRESSION', signalSubtype: 'NARROW_BULL_ENTRY', nextMoveBias: 'UP', symbol: 'BTCUSDT', marketType: 'crypto' });
  assert.equal(bull.strategyId, 'narrow_state_expansion_long');
  assert.equal(bull.allowed, true);
  const bear = decide({ signalFamily: 'NARROW_COMPRESSION', signalSubtype: 'NARROW_BEAR_ENTRY', nextMoveBias: 'DOWN', symbol: 'BTCUSDT', marketType: 'crypto' });
  assert.equal(bear.strategyId, 'narrow_breakout');
  assert.equal(bear.allowed, true);
  const fakeout = decide({ signalFamily: 'NARROW_COMPRESSION', signalSubtype: 'NARROW_FAKEOUT', nextMoveBias: 'UP', symbol: 'AAPL', marketType: 'stocks' });
  assert.equal(fakeout.strategyId, 'narrow_fakeout_reversal_v1');
  assert.equal(fakeout.allowed, true);
}

// 9. EMA long är deklarerad på ema_pullback_continuation. EMA down saknar
// deklarerad strategi-metadata och får därför inte falla tillbaka till long-
// strategins kontrakt.
{
  const up = decide({ signalFamily: 'EMA_TREND_PULLBACK', signalSubtype: 'EMA_PULLBACK_UP', nextMoveBias: 'UP', symbol: 'AAPL', marketType: 'stocks' });
  assert.equal(up.strategyId, 'ema_pullback_continuation', 'EMA_PULLBACK_UP => ema_pullback_continuation');
  assert.equal(up.allowed, true);

  const down = decide({ signalFamily: 'EMA_TREND_PULLBACK', signalSubtype: 'EMA_PULLBACK_DOWN', nextMoveBias: 'DOWN', symbol: 'AAPL', marketType: 'stocks' });
  assert.equal(down.strategyId, null, 'EMA_PULLBACK_DOWN saknar deklarerad runtime-mapping');
  assert.equal(down.allowed, false);
  assert.equal(down.blockedReason, 'unknown_signal_mapping');
  assert.equal(
    conn.getRuntimeStrategyMap().some((entry) => entry.raw_signal === 'EMA_PULLBACK_DOWN'),
    false,
    'runtime-mappen får inte längre innehålla EMA_PULLBACK_DOWN',
  );
}

// 10. Kända stock-VWAP-mappings oförändrade.
{
  const up = decide({ signalFamily: 'VWAP_RECLAIM_REJECTION', signalSubtype: 'VWAP_RECLAIM_UP', nextMoveBias: 'UP', symbol: 'AAPL', marketType: 'stocks' });
  assert.equal(up.strategyId, 'vwap_volume_breakout_long');
  assert.equal(up.allowed, true);
  const down = decide({ signalFamily: 'VWAP_RECLAIM_REJECTION', signalSubtype: 'VWAP_REJECTION_DOWN', nextMoveBias: 'DOWN', symbol: 'AAPL', marketType: 'stocks' });
  assert.equal(down.strategyId, 'vwap_failed_breakout_short');
  assert.equal(down.allowed, true);
}

// REGULAR_PULLBACK: fortsatt trend_continuation med intentional paper block.
{
  const r = decide({ signalFamily: 'REGULAR_PULLBACK', signalSubtype: 'REGULAR_PULLBACK', nextMoveBias: 'UP', symbol: 'AAPL', marketType: 'stocks' });
  assert.equal(r.strategyId, 'trend_continuation');
  assert.equal(r.allowed, false);
  assert.equal(r.blockedReason, 'setup_not_paper_entry');
}

// 11. Ingen signal kan mappas till mer än en strategi — inferStrategyForSignal
// är deterministisk och returnerar exakt ett strategy_id (eller null).
{
  const sig = { signalFamily: 'NARROW_COMPRESSION', signalSubtype: 'NARROW_BEAR_ENTRY', nextMoveBias: 'DOWN', symbol: 'BTCUSDT', marketType: 'crypto' };
  const first = conn.inferStrategyForSignal(sig).strategy_id;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(conn.inferStrategyForSignal(sig).strategy_id, first, 'deterministisk mappning');
  }
}

// 12. Paper Trading kan inte skapa trade från null/unknown mapping:
// canCreatePaperTradeForSignal är exakt den gate paper-agenten anropar
// (paperTradingAgent runTick → RUNTIME_REJECTED-skip när allowed=false).
{
  const r = conn.canCreatePaperTradeForSignal({ signalFamily: 'UNKNOWN', signalSubtype: 'UNKNOWN', symbol: 'BTCUSDT', marketType: 'crypto' });
  assert.equal(r.allowed, false);
  assert.equal(r.strategy.can_create_paper_trade, false);
  assert.equal(r.strategy.connected, false);
}

// Legacy-fallbacken i katalogen har inte längre generisk crypto-catch-all.
{
  assert.equal(catalog.inferStrategyForSignal({ signalFamily: 'UNKNOWN', signalSubtype: 'FOO_SIGNAL', symbol: 'BTCUSDT', marketType: 'crypto' }), null,
    'okänd crypto-signal => null i katalogens legacy-inferens');
  const scalper = catalog.inferStrategyForSignal({ signalSubtype: 'CRYPTO_MOMENTUM_SCALPER', symbol: 'BTCUSDT', marketType: 'crypto' });
  assert.equal(scalper && scalper.id, 'crypto_momentum_scalper', 'uttrycklig contract-match fungerar i legacy-inferens');
}

// Runtime-mappen innehåller ingen crypto-VWAP-post som pekar på scalpern.
{
  const cryptoScalperEntries = conn.getRuntimeStrategyMap()
    .filter((e) => e.market === 'crypto'
      && e.strategy_id === 'crypto_momentum_scalper'
      && String(e.raw_signal || '').includes('VWAP'));
  assert.equal(cryptoScalperEntries.length, 0, 'inga crypto-VWAP→scalper-poster kvar i runtime-mappen');
}

// Safety-stämpeln är intakt på besluten (connectorns etablerade kontrakt:
// paper_only=true + alla actionsflaggor false).
{
  const d = conn.canCreatePaperTradeForSignal({ signalFamily: 'UNKNOWN', signalSubtype: 'UNKNOWN', symbol: 'BTCUSDT', marketType: 'crypto' });
  assert.equal(d.paper_only, true);
  assert.equal(d.actions_allowed, false);
  assert.equal(d.can_place_orders, false);
  assert.equal(d.live_trading_enabled, false);
  assert.equal(d.live_enabled, false);
}

// Runtime-mappen är härledd ur katalogmetadata, inte en separat handskriven
// strategi-tabell i connectorn.
{
  for (const entry of conn.getRuntimeStrategyMap()) {
    const strategy = catalog.getStrategyById(entry.strategy_id);
    assert.ok(strategy, `${entry.raw_signal}: strategi finns i katalogen`);
    assert.ok(
      (strategy.runtime_signals || []).some((signal) => signal.raw_signal === entry.raw_signal && signal.routing_enabled !== false),
      `${entry.raw_signal}: runtime-map entry backas av strategy.runtime_signals`,
    );
  }
}

console.log('strategyRuntimeConnectorService.mappingGuard.test.js passed');
