'use strict';

// Test av NARROW_FAKEOUT-producentkedjan (paper/replay-only, aldrig order):
//   calcFakeoutReversal (narrowState) → signalFamilyClassifier-subtyp →
//   strategyRuntimeConnector-mapping till narrow_fakeout_reversal_v1.

const { calcFakeoutReversal } = require('./narrowState');
const { classifySignalFamily } = require('./signalFamilyClassifier');
const {
  inferStrategyForSignal,
  canCreatePaperTradeForSignal,
  getRuntimeStatusForStrategy,
} = require('../services/strategyRuntimeConnectorService');

let passed = 0;
let failed = 0;

function assert(name, condition, got) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed += 1;
  } else {
    console.error(`  ❌ ${name}  →  got: ${JSON.stringify(got)}`);
    failed += 1;
  }
}

// Bygger candles: en flat 8-bars zon runt 100 (high 100.5 / low 99.5),
// därefter valfria lookback-bars. Candle-format är {o,h,l,c,v}. Volym 1000 som bas.
function bar(high, low, close, volume = 1000) {
  return { o: (high + low) / 2, h: high, l: low, c: close, v: volume };
}

function baseCandles() {
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push(bar(100.5, 99.5, 100));
  return candles;
}

const ATR = 0.4; // buffer = max(0.05*0.4, 0.02) = 0.02 → brytnivå 100.52 / 98.98... wait 99.48

console.log('narrowState fakeout-detektor:');

// 1) Misslyckat upp-brott med svag volym + snabb återgång → bearish fakeout.
{
  const candles = baseCandles();
  candles.push(bar(101.2, 100.1, 100.9)); // bryter över 100.52, svag volym
  candles.push(bar(100.9, 99.9, 100.1));  // stänger tillbaka i zonen
  const res = calcFakeoutReversal({ candles2m: candles, atr14: ATR, narrowScore: 70 });
  assert('upp-brott + återgång → active', res.active === true, res);
  assert('riktning bearish (short mot mitten)', res.direction === 'bearish', res);
  assert('brokenSide high', res.brokenSide === 'high', res);
}

// 2) Misslyckat ned-brott → bullish fakeout.
{
  const candles = baseCandles();
  candles.push(bar(99.9, 98.8, 99.1));   // bryter under 99.48, svag volym
  candles.push(bar(100.2, 99.4, 100.0)); // stänger tillbaka i zonen
  const res = calcFakeoutReversal({ candles2m: candles, atr14: ATR, narrowScore: 70 });
  assert('ned-brott + återgång → active', res.active === true, res);
  assert('riktning bullish (long mot mitten)', res.direction === 'bullish', res);
}

// 3) Utbrott med bekräftande volym = riktigt utbrott, inte fakeout.
{
  const candles = baseCandles();
  candles.push(bar(101.2, 100.1, 100.9, 5000)); // 5x volym → bekräftat
  candles.push(bar(100.9, 99.9, 100.1));
  const res = calcFakeoutReversal({ candles2m: candles, atr14: ATR, narrowScore: 70 });
  assert('bekräftad volym → inactive', res.active === false, res);
}

// 4) Priset fortfarande utanför zonen (ingen återgång) → inactive.
{
  const candles = baseCandles();
  candles.push(bar(101.2, 100.1, 100.9));
  candles.push(bar(101.3, 100.8, 101.1)); // stänger kvar ovanför zonen
  const res = calcFakeoutReversal({ candles2m: candles, atr14: ATR, narrowScore: 70 });
  assert('ingen återgång → inactive', res.active === false, res);
}

// 5) narrowScore under 60 (katalogregel narrow_score_gte_60) → inactive.
{
  const candles = baseCandles();
  candles.push(bar(101.2, 100.1, 100.9));
  candles.push(bar(100.9, 99.9, 100.1));
  const res = calcFakeoutReversal({ candles2m: candles, atr14: ATR, narrowScore: 40 });
  assert('narrowScore < 60 → inactive', res.active === false, res);
}

// 6) Inget brott alls → inactive.
{
  const candles = baseCandles();
  candles.push(bar(100.4, 99.6, 100.0));
  candles.push(bar(100.4, 99.6, 100.0));
  const res = calcFakeoutReversal({ candles2m: candles, atr14: ATR, narrowScore: 70 });
  assert('inget brott → inactive', res.active === false, res);
}

console.log('signalFamilyClassifier:');

// 7) eventType NARROW_FAKEOUT klassas som NARROW_COMPRESSION / NARROW_FAKEOUT.
{
  const cls = classifySignalFamily({
    state: 'HIGH_QUALITY_NARROW',
    eventType: 'NARROW_FAKEOUT',
    signal: 'SHORT_WATCH',
  });
  assert('family NARROW_COMPRESSION', cls.signalFamily === 'NARROW_COMPRESSION', cls.signalFamily);
  assert('subtype NARROW_FAKEOUT', cls.signalSubtype === 'NARROW_FAKEOUT', cls.signalSubtype);
}

console.log('strategyRuntimeConnector:');

// 8) NARROW_FAKEOUT-signal mappas till narrow_fakeout_reversal_v1.
{
  const inferred = inferStrategyForSignal({
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_FAKEOUT',
    signal: 'SHORT_WATCH',
    symbol: 'QQQ',
  });
  assert('strategy_id = narrow_fakeout_reversal_v1', inferred.strategy_id === 'narrow_fakeout_reversal_v1', inferred.strategy_id);
  assert('inferred safety: can_place_orders=false', inferred.can_place_orders === false, inferred.can_place_orders);
  assert('inferred safety: live_trading_enabled=false', inferred.live_trading_enabled === false, inferred.live_trading_enabled);
}

// 9) Runtime-profilen exponerar NARROW_FAKEOUT som raw-signal.
{
  const profile = getRuntimeStatusForStrategy('narrow_fakeout_reversal_v1');
  const raws = profile.runtime_raw_signals || [];
  assert('runtime_raw_signals innehåller NARROW_FAKEOUT', raws.includes('NARROW_FAKEOUT'), raws);
  assert('profil safety: can_place_orders=false', profile.can_place_orders === false, profile.can_place_orders);
}

// 10) canCreatePaperTradeForSignal svarar med paper-only safety oavsett utfall.
{
  const decision = canCreatePaperTradeForSignal({
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_FAKEOUT',
    signal: 'SHORT_WATCH',
    symbol: 'QQQ',
  });
  assert('decision.strategy pekar på v1', decision.strategy?.strategy_id === 'narrow_fakeout_reversal_v1', decision.strategy?.strategy_id);
  assert('decision safety: can_place_orders=false', decision.can_place_orders === false, decision.can_place_orders);
  assert('decision safety: live_trading_enabled=false', decision.live_trading_enabled === false, decision.live_trading_enabled);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
