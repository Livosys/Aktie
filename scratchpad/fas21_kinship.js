'use strict';
const a = require('../src/services/futuresTradingOsSignalAdapterService');
const cases = [
  ['BTCUSDT krypto',   { symbol: 'BTCUSDT', market: 'crypto', marketType: 'crypto', strategyId: 'ema_pullback_continuation' }],
  ['ETHUSDT krypto',   { symbol: 'ETHUSDT', market: 'crypto', marketType: 'crypto', strategyId: 'narrow_state_expansion_long' }],
  ['MSFT aktie',       { symbol: 'MSFT', market: 'stocks', marketType: 'stocks', strategyId: 'ema_pullback_continuation' }],
  ['QQQ ETF',          { symbol: 'QQQ', market: 'stocks', marketType: 'stocks', strategyId: 'vwap_volume_breakout_long' }],
  ['MNQ native',       { symbol: 'MNQ', market: 'futures', marketType: 'futures', strategyId: 'mnq_globex_momentum_v1' }],
  ['SPY → MES',        { symbol: 'SPY', market: 'stocks', marketType: 'stocks', strategyId: 'vwap_volume_breakout_long' }],
  ['okänd symbol/marknad', { symbol: 'XYZ', strategyId: 'ema_pullback_continuation' }],
];
for (const [label, sig] of cases) {
  const m = a.mapSignalToFutures(sig);
  console.log(`${label.padEnd(24)} → ${String(m.futuresSymbol).padEnd(5)} ${m.mappingReason} (conf ${m.mappingConfidence})`);
}
