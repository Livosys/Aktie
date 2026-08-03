'use strict';

// Regression: classifyVwapReclaimRejection saknade den metadata-upplösning som
// EMA- och NARROW-grenarna redan gjorde. Utan den fick varje VWAP-signal
// strategyId null, decisionMonitor.js:1169-1175 hade inget att falla tillbaka
// på, och futuresPaperScannerService.js:610 kastade kandidaten på
// missing_strategy_id — vwap_volume_breakout_long kunde aldrig nå IBKR Paper.

const assert = require('assert/strict');

const { classifySignalFamily } = require('./signalFamilyClassifier');

// Fixturen är en avskalad men äkta rad ur data/signals/history (AMZN 2026-07-2x).
// Fälten är precis de evaluateVwapReclaimRejection kräver: färsk data, användbar
// volym, vwap + pris, |vwapDistancePct| <= 0.45 och tf2m/candle i riktningen.
function vwapSignal(overrides = {}) {
  return {
    symbol: 'AMZN',
    market: 'stocks',
    price: 247.39,
    vwap: 247.6455,
    vwapDistancePct: -0.1032,
    relVol20: 0.92,
    rvol: 0.92,
    atr14: 0.3421,
    state: 'REGULAR_TREND',
    volumeState: 'normal',
    signal: 'WAIT',
    eventType: 'NO_TRADE',
    marketDirection: 'bullish',
    tf2m: 'bullish',
    tf5m: 'bullish',
    tf15m: 'bullish',
    timeframeAgreement: {
      tf1h: 'bearish', tf30m: 'bearish', tf15m: 'bullish',
      tf10m: 'bullish', tf5m: 'bullish', tf2m: 'bullish',
    },
    candleScore2m: { scoreDirection: 'bullish', greenCount5: 4, redCount5: 1, netMovePct5: 0.061 },
    ...overrides,
  };
}

// Speglad bearish-variant för VWAP_REJECTION_DOWN.
function vwapShortSignal(overrides = {}) {
  return vwapSignal({
    price: 247.9,
    vwapDistancePct: 0.1032,
    marketDirection: 'bearish',
    tf2m: 'bearish', tf5m: 'bearish', tf15m: 'bearish',
    timeframeAgreement: {
      tf1h: 'bullish', tf30m: 'bullish', tf15m: 'bearish',
      tf10m: 'bearish', tf5m: 'bearish', tf2m: 'bearish',
    },
    candleScore2m: { scoreDirection: 'bearish', greenCount5: 1, redCount5: 4, netMovePct5: -0.061 },
    ...overrides,
  });
}

// (1) Aktie-VWAP long får sitt strategyId tillbaka.
const long = classifySignalFamily(vwapSignal());
assert.equal(long.signalFamily, 'VWAP_RECLAIM_REJECTION');
assert.equal(long.signalSubtype, 'VWAP_RECLAIM_UP');
assert.equal(long.strategyId, 'vwap_volume_breakout_long');
assert.equal(long.resolvedStrategyId, 'vwap_volume_breakout_long');
assert.equal(long.mappingSource, 'explicit');

// (2) Aktie-VWAP short mappar till sin egen strategi, inte long-strategin.
const short = classifySignalFamily(vwapShortSignal());
assert.equal(short.signalSubtype, 'VWAP_REJECTION_DOWN');
assert.equal(short.strategyId, 'vwap_failed_breakout_short');

// (3) Crypto ska INTE få något strategyId. Runtime-mappen har medvetet ingen
// crypto-VWAP-post (FAS C mapping-fix) — crypto-VWAP saknar eget strategy
// contract och ska blockeras i stället för att felattribueras.
for (const cryptoSig of [
  vwapSignal({ symbol: 'ETHUSDT', market: 'crypto' }),
  vwapShortSignal({ symbol: 'BTCUSDT', market: 'crypto' }),
]) {
  const crypto = classifySignalFamily(cryptoSig);
  assert.equal(crypto.signalFamily, 'VWAP_RECLAIM_REJECTION');
  assert.ok(!crypto.strategyId, `crypto fick strategyId ${crypto.strategyId}`);
  assert.ok(!crypto.resolvedStrategyId, `crypto fick resolvedStrategyId ${crypto.resolvedStrategyId}`);
}

// (4) Familj och subtyp är oförändrade — fixen lägger bara till metadata.
assert.equal(classifySignalFamily(vwapSignal()).signalFamily, 'VWAP_RECLAIM_REJECTION');
assert.equal(classifySignalFamily(vwapSignal()).reasonSv, 'Priset testar dagens VWAP. Bevaka om nivån håller.');

// (5) EMA-grenen orörd.
const ema = classifySignalFamily({
  symbol: 'AAPL', market: 'stocks', price: 210, ema9: 209.8, ema21: 209.5, ema50: 208,
  sma20: 209, atr14: 0.4, relVol20: 1.4, rvol: 1.4, volumeState: 'normal',
  state: 'REGULAR_TREND', signal: 'LONG_TRIGGERED', eventType: 'REGULAR_PULLBACK',
  marketDirection: 'bullish', tf2m: 'bullish', tf5m: 'bullish', tf15m: 'bullish',
  timeframeAgreement: { tf1h: 'bullish', tf30m: 'bullish', tf15m: 'bullish', tf10m: 'bullish', tf5m: 'bullish', tf2m: 'bullish' },
  candleScore2m: { scoreDirection: 'bullish' },
});
if (ema.signalFamily === 'EMA_TREND_PULLBACK') {
  assert.equal(ema.strategyId, 'ema_pullback_continuation');
}

// (6) NARROW-grenen orörd.
const narrow = classifySignalFamily({
  symbol: 'META', market: 'stocks', price: 500, atr14: 0.9, relVol20: 1.6, rvol: 1.6,
  volumeState: 'normal', state: 'NARROW', signal: 'LONG_TRIGGERED',
  eventType: 'BULLISH_ELEPHANT_BREAKOUT', signalFamily: 'NARROW_COMPRESSION',
  signalSubtype: 'NARROW_BULL_ENTRY', marketDirection: 'bullish',
  tf2m: 'bullish', tf5m: 'bullish', tf15m: 'bullish', rangeCompression: 0.3,
  timeframeAgreement: { tf1h: 'bullish', tf30m: 'bullish', tf15m: 'bullish', tf10m: 'bullish', tf5m: 'bullish', tf2m: 'bullish' },
  candleScore2m: { scoreDirection: 'bullish' },
});
if (narrow.signalFamily === 'NARROW_COMPRESSION') {
  assert.equal(narrow.strategyId, 'narrow_state_expansion_long');
}

console.log('signalFamilyClassifier.vwapStrategyId.test.js passed');
