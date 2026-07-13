'use strict';

const assert = require('assert/strict');

process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'true';

const { buildDecisionMonitor } = require('./decisionMonitor');
const entryContracts = require('../services/paperStrategyEntryContractService');

function iso(ms) {
  return new Date(ms).toISOString();
}

function candle(ts, open, close, volume = 1000, incomplete = false) {
  return {
    timestamp: iso(ts),
    open,
    high: Math.max(open, close) + 0.05,
    low: Math.min(open, close) - 0.05,
    close,
    volume,
    incomplete,
  };
}

function liveDebug(symbol, marketType, candles) {
  return {
    ok: true,
    symbol,
    marketType,
    timeframe: '2m',
    latestTimestamp: candles[candles.length - 1].timestamp,
    dataAgeSeconds: 120,
    source: `${marketType}_fixture_2m`,
    candles,
    debug: {
      hasLiveCandles: true,
      candleCount: candles.length,
      sourceName: `${marketType}_fixture_2m`,
      notes: [],
    },
  };
}

function baseResult(symbol, overrides = {}) {
  const signalTimestamp = iso(Date.now() - 120000);
  return {
    symbol,
    price: 100.4,
    market: 'crypto',
    latest2mTimestamp: signalTimestamp,
    lastUpdate: iso(Date.now()),
    signal: 'LONG_TRIGGERED',
    state: 'TREND',
    stateGraph: { currentState: 'BREAKOUT' },
    tradeScore: 72,
    daytradeScore: 72,
    fakeoutRiskLevel: 'low',
    priceToZoneAtr: 0.2,
    atr14: 1.2,
    recentLow: 99.8,
    recentHigh: 100.6,
    relVol20: 1.4,
    rvol: 1.4,
    volumeState: 'strong',
    marketRegimeV2: 'BULLISH_TREND',
    tf2mDirection: 'bullish',
    tf5mDirection: 'bullish',
    tf15mDirection: 'bullish',
    mtf5m: { direction: 'bullish' },
    mtf15m: { direction: 'bullish' },
    slope20Atr: 0.4,
    sma20: 100,
    sma200: 98,
    ...overrides,
  };
}

function evaluate(strategyId, candidate) {
  return entryContracts.evaluatePaperEntryContract({
    strategyId,
    candidate,
    now: new Date(),
    marketContext: {
      marketType: candidate.marketType || candidate.market,
      session: candidate.session,
    },
  });
}

function assertContractPass(strategyId, candidate) {
  const decision = evaluate(strategyId, candidate);
  assert.equal(decision.allowed, true, `${strategyId} contract should pass: ${decision.reasonCode}`);
  assert.equal(decision.reasonCode, null);
  return decision;
}

function main() {
  const now = Date.now();
  const bullishCandles = [
    candle(now - 600000, 99.6, 99.8),
    candle(now - 480000, 99.8, 100.0),
    candle(now - 360000, 100.0, 100.15),
    candle(now - 240000, 100.15, 100.3),
    candle(now - 120000, 100.3, 100.45),
  ];

  const stockCandles = [
    candle(now - 600000, 99.6, 99.8, 5000),
    candle(now - 480000, 99.8, 100.0, 6500),
    candle(now - 360000, 100.0, 100.12, 8000),
    candle(now - 240000, 100.12, 100.25, 10000),
    candle(now - 120000, 100.25, 100.42, 14000),
  ];

  const dm = buildDecisionMonitor({
    cryptoResults: [
      baseResult('BTCUSDT', {
        market: 'crypto',
        state: 'HIGH_QUALITY_NARROW',
        narrowType: 'coil_flat',
        price: 100.45,
        vwap: null,
        ema21: 100.1,
        ema50: 99.7,
      }),
      baseResult('ETHUSDT', {
        market: 'crypto',
        state: 'TREND',
        price: 100.35,
        ema9: 100.3,
        ema21: 100.05,
        ema50: 99.5,
        vwap: null,
      }),
    ],
    stockResults: [
      baseResult('AAPL', {
        market: 'stocks',
        state: 'TREND',
        price: 100.42,
        vwap: 100,
        vwapDistancePct: 0.42,
        ema21: null,
        ema50: null,
      }),
    ],
    liveCandleDebugBySymbol: {
      BTCUSDT: liveDebug('BTCUSDT', 'crypto', bullishCandles),
      ETHUSDT: liveDebug('ETHUSDT', 'crypto', bullishCandles),
      AAPL: liveDebug('AAPL', 'stocks', stockCandles),
    },
    stockFeedStatus: { status: 'OPEN' },
  });

  const bySubtype = Object.fromEntries(dm.candidates.map((candidate) => [candidate.signalSubtype, candidate]));
  const narrow = bySubtype.NARROW_BULL_ENTRY;
  const ema = bySubtype.EMA_PULLBACK_UP;
  const vwap = bySubtype.VWAP_RECLAIM_UP;

  assert.ok(narrow, 'producer can create NARROW_BULL_ENTRY');
  assert.ok(ema, 'producer can create EMA_PULLBACK_UP');
  assert.ok(vwap, 'producer can create VWAP_RECLAIM_UP');

  for (const candidate of [narrow, ema, vwap]) {
    assert.equal(candidate.producerConfirmationVersion, 'producer_confirmation_v1');
    assert.equal(candidate.twoMinuteConfirmed, true);
    assert.equal(candidate.closedCandleConfirmed, true);
    assert.equal(candidate.producerEntryReadiness.status, 'entry_ready');
    assert.equal(candidate.status, 'active');
    assert.equal(candidate.dataFreshness, 'LIVE');
    assert.equal(candidate.extensionLevel, 'none');
    assert.ok(candidate.producerEntryReadiness.confirmationObserved.includes('two_minute_confirmation'));
    assert.ok(candidate.producerEntryReadiness.confirmationObserved.includes('closed_candle_confirmation'));
  }

  assert.equal(narrow.confirmation.twoMinuteConfirmed, true);
  assertContractPass('narrow_state_expansion_long', narrow);

  assert.equal(ema.emaContext.hasContext, true);
  assert.equal(ema.emaContext.trendIntact, true);
  assert.equal(ema.emaPullbackConfirmed, true);
  assertContractPass('ema_pullback_continuation', ema);

  assert.equal(vwap.marketType, 'stocks');
  assert.equal(vwap.vwapContext.hasContext, true);
  assert.equal(vwap.vwapContext.closeAboveVwap, true);
  assert.equal(vwap.vwapReclaimConfirmed, true);
  assert.ok(vwap.producerEntryReadiness.confirmationObserved.includes('volume_confirmation'));
  assertContractPass('vwap_volume_breakout_long', vwap);

  const canonicalTf = {
    tf2m: 'bullish',
    tf5m: 'bullish',
    tf10m: 'bullish',
    tf15m: 'bullish',
    tf30m: 'bullish',
    tf1h: 'bullish',
  };
  const canonicalOnly = (overrides = {}) => {
    const row = baseResult('CANON', {
      ...canonicalTf,
      timeframeAgreement: canonicalTf,
      mtf5m: null,
      mtf15m: null,
      ...overrides,
    });
    delete row.tf2mDirection;
    delete row.tf5mDirection;
    delete row.tf15mDirection;
    return row;
  };
  const canonicalDm = buildDecisionMonitor({
    cryptoResults: [
      canonicalOnly({
        symbol: 'BTCUSDT',
        market: 'crypto',
        state: 'HIGH_QUALITY_NARROW',
        narrowType: 'coil_flat',
        price: 100.45,
        vwap: null,
        ema21: 100.1,
        ema50: 99.7,
      }),
      canonicalOnly({
        symbol: 'ETHUSDT',
        market: 'crypto',
        state: 'TREND',
        price: 100.35,
        ema9: 100.3,
        ema21: 100.05,
        ema50: 99.5,
        vwap: null,
      }),
    ],
    stockResults: [
      canonicalOnly({
        symbol: 'AAPL',
        market: 'stocks',
        state: 'TREND',
        price: 100.42,
        vwap: 100,
        vwapDistancePct: 0.42,
        ema21: null,
        ema50: null,
      }),
    ],
    liveCandleDebugBySymbol: {
      BTCUSDT: liveDebug('BTCUSDT', 'crypto', bullishCandles),
      ETHUSDT: liveDebug('ETHUSDT', 'crypto', bullishCandles),
      AAPL: liveDebug('AAPL', 'stocks', stockCandles),
    },
    stockFeedStatus: { status: 'OPEN' },
  });
  const canonicalBySubtype = Object.fromEntries(canonicalDm.candidates.map((candidate) => [candidate.signalSubtype, candidate]));
  assert.equal(canonicalBySubtype.NARROW_BULL_ENTRY.status, 'active');
  assert.equal(canonicalBySubtype.EMA_PULLBACK_UP.status, 'active');
  assert.equal(canonicalBySubtype.VWAP_RECLAIM_UP.status, 'active');
  assertContractPass('narrow_state_expansion_long', canonicalBySubtype.NARROW_BULL_ENTRY);
  assertContractPass('ema_pullback_continuation', canonicalBySubtype.EMA_PULLBACK_UP);
  assertContractPass('vwap_volume_breakout_long', canonicalBySubtype.VWAP_RECLAIM_UP);

  const confirmedNonTriggerDm = buildDecisionMonitor({
    cryptoResults: [
      canonicalOnly({
        symbol: 'BTCUSDT',
        market: 'crypto',
        signal: 'LONG_WATCH',
        state: 'HIGH_QUALITY_NARROW',
        narrowType: 'coil_flat',
        price: 100.45,
        vwap: null,
        ema21: 100.1,
        ema50: 99.7,
      }),
      canonicalOnly({
        symbol: 'ETHUSDT',
        market: 'crypto',
        signal: 'WAIT',
        signalSubtype: 'EMA_PULLBACK_UP',
        eventType: 'EMA_PULLBACK_UP',
        state: 'TREND',
        price: 100.35,
        ema9: 100.3,
        ema21: 100.05,
        ema50: 99.5,
        vwap: null,
      }),
    ],
    stockResults: [
      canonicalOnly({
        symbol: 'AAPL',
        market: 'stocks',
        signal: 'WAIT',
        signalSubtype: 'VWAP_RECLAIM_UP',
        eventType: 'VWAP_RECLAIM_UP',
        state: 'TREND',
        price: 100.42,
        vwap: 100,
        vwapDistancePct: 0.42,
        ema21: null,
        ema50: null,
      }),
    ],
    liveCandleDebugBySymbol: {
      BTCUSDT: liveDebug('BTCUSDT', 'crypto', bullishCandles),
      ETHUSDT: liveDebug('ETHUSDT', 'crypto', bullishCandles),
      AAPL: liveDebug('AAPL', 'stocks', stockCandles),
    },
    stockFeedStatus: { status: 'OPEN' },
  });
  const confirmedNonTrigger = Object.fromEntries(confirmedNonTriggerDm.candidates.map((candidate) => [candidate.signalSubtype, candidate]));
  assert.equal(confirmedNonTrigger.NARROW_BULL_ENTRY.status, 'active');
  assert.equal(confirmedNonTrigger.EMA_PULLBACK_UP.status, 'active');
  assert.equal(confirmedNonTrigger.VWAP_RECLAIM_UP.status, 'active');
  assert.equal(confirmedNonTrigger.NARROW_BULL_ENTRY.producerEntryReadiness.entryReady, true);
  assert.equal(confirmedNonTrigger.EMA_PULLBACK_UP.producerEntryReadiness.entryReady, true);
  assert.equal(confirmedNonTrigger.VWAP_RECLAIM_UP.producerEntryReadiness.entryReady, true);
  assertContractPass('narrow_state_expansion_long', confirmedNonTrigger.NARROW_BULL_ENTRY);
  assertContractPass('ema_pullback_continuation', confirmedNonTrigger.EMA_PULLBACK_UP);
  assertContractPass('vwap_volume_breakout_long', confirmedNonTrigger.VWAP_RECLAIM_UP);

  const openCandleDm = buildDecisionMonitor({
    cryptoResults: [baseResult('SOLUSDT', {
      market: 'crypto',
      state: 'HIGH_QUALITY_NARROW',
      narrowType: 'coil_flat',
      price: 100.45,
      vwap: null,
      ema21: 100.1,
      ema50: 99.7,
    })],
    cryptoResultsOnly: true,
    liveCandleDebugBySymbol: {
      SOLUSDT: liveDebug('SOLUSDT', 'crypto', [
        ...bullishCandles.slice(0, 4),
        candle(now - 30000, 100.3, 100.45, 1000, true),
      ]),
    },
  });
  const openCandleNarrow = openCandleDm.candidates.find((candidate) => candidate.signalSubtype === 'NARROW_BULL_ENTRY');
  assert.ok(openCandleNarrow, 'open candle fixture still produces subtype');
  assert.equal(openCandleNarrow.closedCandleConfirmed, false);
  assert.equal(
    evaluate('narrow_state_expansion_long', openCandleNarrow).reasonCode,
    entryContracts.REASON_CODES.MISSING_CLOSED_CANDLE,
    'open current candle cannot satisfy closed-candle contract',
  );

  console.log('decisionMonitor.producerConfirmation.test.js passed');
}

main();
