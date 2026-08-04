'use strict';

// `node src/services/canonical/canonicalSignalAdapters.test.js`
// Adaptrarna läser kontraktsregistret (rent minne) — ingen fil, ingen live-data.

const assert = require('assert');
const adapters = require('./canonicalSignalAdapters');
const { validateCanonicalSignal } = require('./canonicalSignal');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n         ${err && err.stack || err}`); process.exitCode = 1; }
}

const NOW = new Date('2026-08-04T18:14:22.000Z');

// Realistisk TradingOS-kandidat, formad som futuresTradingOsSignalAdapterService
// faktiskt bygger den (fältnamnen är tagna ur produktionens events.jsonl).
function tradingOsCandidate(overrides = {}) {
  return {
    candidateId: 'futures_candidate_test_tos',
    signalId: 'TSLA_2026-08-04T18:12:00.000Z',
    strategyId: 'ema_pullback_continuation',
    strategyName: 'EMA Pullback Continuation',
    symbol: 'MNQ',
    originalSymbol: 'TSLA',
    futuresSymbol: 'MNQ',
    direction: 'long',
    signalStatus: 'caution',
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: 'EMA_PULLBACK_UP',
    entryPrice: 29876,
    stopLoss: 29822.22,
    takeProfit: 29950.69,
    timeframe: '2m',
    source: 'trading_os_signal_adapter',
    signalSource: 'trading_os',
    market: 'stocks',
    marketType: 'stocks',
    dataSource: 'real_market_data',
    dataFreshness: 'LIVE',
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    candleTimestamp: '2026-08-04T18:12:00.000Z',
    signalTimestamp: '2026-08-04T18:14:00.000Z',
    twoMinuteConfirmed: true,
    twoMinuteConfirmation: { confirmed: true, tf2m: 'bullish' },
    rvol: 1.04,
    volumeState: 'normal',
    emaContext: { hasContext: true, trendIntact: true, reclaimConfirmed: true, relation: 'above_ema21' },
    vwapContext: { hasContext: true, reclaimConfirmed: false, closeAboveVwap: true, distancePct: 0.616 },
    extensionLevel: 'mild',
    extensionMeta: { level: 'mild', priceToZoneAtr: 2.99, recentMoveAtr: 2.62, fatigueScore: 32 },
    sessionMetadata: { sessionId: 'us_rth', session: 'Globex' },
    ...overrides,
  };
}

// Realistisk native futures-kandidat.
function nativeCandidate(overrides = {}) {
  return {
    candidateId: 'futures_candidate_test_native',
    signalId: 'mnq_globex_momentum_v1:2026-08-04T18:12:00.000Z:long',
    strategyId: 'mnq_globex_momentum_v1',
    strategyName: 'MNQ Globex Momentum',
    symbol: 'MNQ',
    futuresSymbol: 'MNQ',
    direction: 'long',
    signalStatus: 'ready',
    signalFamily: 'futures_globex_momentum',
    signalSubtype: 'GLOBEX_MOMENTUM',
    entryPrice: 29887,
    stopLoss: 29797.34,
    takeProfit: 30066.32,
    timeframe: '1m',
    source: 'trading_os_signal_adapter',
    signalSource: 'futures_native_mnq_candles',
    market: 'futures',
    marketType: 'futures',
    dataSource: 'real_market_data',
    dataFreshness: 'LIVE',
    closedCandleConfirmed: true,
    latestCandleClosed: true,
    candleTimestamp: '2026-08-04T18:12:00.000Z',
    signalTimestamp: '2026-08-04T18:12:00.000Z',
    sessionMetadata: { sessionId: 'us_rth', session: 'Globex' },
    ...overrides,
  };
}

console.log('canonicalSignalAdapters');

// ── TradingOS → Canonical ────────────────────────────────────────────────────

test('TradingOS: symbol, marknad, riktning, strategyId, subtyp översätts', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  assert.strictEqual(s.symbol, 'MNQ');
  assert.strictEqual(s.marketType, 'stocks');
  assert.strictEqual(s.direction, 'LONG');
  assert.strictEqual(s.strategyId, 'ema_pullback_continuation');
  assert.strictEqual(s.signalSubtype, 'EMA_PULLBACK_UP');
  assert.strictEqual(s.signalFamily, 'EMA_TREND_PULLBACK');
  assert.strictEqual(s.producerType, 'tradingos_decision_monitor');
});

test('TradingOS: extension-evidens bär positionellt mått med värde', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  assert.strictEqual(s.evidence.extension.measure, 'price_to_zone_atr');
  assert.strictEqual(s.evidence.extension.value, 2.99);
  assert.strictEqual(s.evidence.extension.level, 'mild');
});

test('TradingOS: volym-evidens översätts', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  assert.strictEqual(s.evidence.volume.rvol, 1.04);
  assert.strictEqual(s.evidence.volume.state, 'normal');
});

test('TradingOS: bekräftelse-evidens samlas som tokens', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  assert.ok(s.evidence.confirmations.includes('two_minute_confirmation'));
  assert.ok(s.evidence.confirmations.includes('closed_candle_confirmation'));
  assert.ok(s.evidence.confirmations.includes('ema_pullback_reclaim'));
});

test('TradingOS: tidsstämplar och signalålder översätts', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  assert.strictEqual(s.signalTimestamp, '2026-08-04T18:14:00.000Z');
  assert.strictEqual(s.evidence.candle.candleTimestamp, '2026-08-04T18:12:00.000Z');
  // now − signalTimestamp = 22 s
  assert.strictEqual(s.evidence.candle.signalAgeMs, 22000);
});

test('TradingOS: kontextflaggor översätts', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  assert.strictEqual(s.evidence.context.dataFreshness, 'LIVE');
  // sessionOf speglar kontraktets :313 och läser BARA toppnivåfälten. Fixturen
  // bär sessionen i sessionMetadata, alltså null här — medan sessionTokens
  // fångar båda. Det är den skillnaden grinden faktiskt jämför mot.
  assert.strictEqual(s.evidence.context.session, null);
  assert.deepStrictEqual(s.evidence.context.sessionTokens, ['globex', 'us_rth']);
  assert.strictEqual(s.evidence.context.emaContextPresent, true);
  assert.strictEqual(s.evidence.context.vwapContextPresent, true);
  assert.strictEqual(s.evidence.context.trendIntact, true);
  assert.strictEqual(s.evidence.context.marketClosed, false);
});

test('TradingOS: producentens statusomdöme läcker ALDRIG in i signalen', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  assert.strictEqual(validateCanonicalSignal(s).ok, true);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('"signalStatus"'), 'signalStatus läckte in');
  assert.ok(!json.includes('"priority"'), 'priority läckte in');
});

// ── Native Futures → Canonical ───────────────────────────────────────────────

test('Native: symbol, marknad, riktning, strategyId, subtyp översätts', () => {
  const s = adapters.nativeCanonicalAdapter(nativeCandidate(), { now: NOW });
  assert.strictEqual(s.symbol, 'MNQ');
  assert.strictEqual(s.marketType, 'futures');
  assert.strictEqual(s.direction, 'LONG');
  assert.strictEqual(s.strategyId, 'mnq_globex_momentum_v1');
  assert.strictEqual(s.signalSubtype, 'GLOBEX_MOMENTUM');
  assert.strictEqual(s.producerType, 'futures_native');
});

test('Native: extension-måttet är LOKALT och värdet aldrig mätt', () => {
  const s = adapters.nativeCanonicalAdapter(nativeCandidate(), { now: NOW });
  assert.strictEqual(s.evidence.extension.measure, 'latest_range_multiple');
  assert.strictEqual(s.evidence.extension.value, null, 'producenten exponerar inte värdet i dag');
  assert.strictEqual(s.evidence.extension.level, null, 'aldrig mätt ska vara null, inte "none"');
});

test('Native: saknad volym ger null, inte 0', () => {
  const s = adapters.nativeCanonicalAdapter(nativeCandidate(), { now: NOW });
  assert.strictEqual(s.evidence.volume.rvol, null);
  assert.strictEqual(s.evidence.volume.state, null);
});

test('Native: stängd candle registreras som bekräftelse', () => {
  const s = adapters.nativeCanonicalAdapter(nativeCandidate(), { now: NOW });
  assert.strictEqual(s.evidence.candle.closedCandleConfirmed, true);
  assert.ok(s.evidence.confirmations.includes('closed_candle_confirmation'));
});

test('Native: producentens ready-literal läcker ALDRIG in i signalen', () => {
  const s = adapters.nativeCanonicalAdapter(nativeCandidate(), { now: NOW });
  assert.strictEqual(validateCanonicalSignal(s).ok, true);
  assert.ok(!JSON.stringify(s).includes('"signalStatus"'));
});

// ── Strukturell identitet mellan producenter ─────────────────────────────────

function shape(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return Object.keys(value).sort().map((k) => `${k}:${shape(value[k])}`).join(',');
}
function keyTree(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.keys(value).sort().flatMap((k) => keyTree(value[k], prefix ? `${prefix}.${k}` : k));
}

test('båda producenterna ger IDENTISK nyckelstruktur', () => {
  const a = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  const b = adapters.nativeCanonicalAdapter(nativeCandidate(), { now: NOW });
  assert.deepStrictEqual(keyTree(a), keyTree(b), 'strukturerna skiljer sig');
});

test('samtliga fem adaptrar ger IDENTISK nyckelstruktur', () => {
  const cand = tradingOsCandidate();
  const trees = [
    adapters.tradingOsCanonicalAdapter(cand, { now: NOW }),
    adapters.nativeCanonicalAdapter(cand, { now: NOW }),
    adapters.replayCanonicalAdapter(cand, { now: NOW }),
    adapters.batchCanonicalAdapter(cand, { now: NOW }),
    adapters.pineCanonicalAdapter(cand, { now: NOW }),
  ].map((s) => keyTree(s));
  for (let i = 1; i < trees.length; i += 1) {
    assert.deepStrictEqual(trees[i], trees[0], `adapter ${i} avviker strukturellt`);
  }
});

test('strukturen är stabil även när all evidens saknas', () => {
  const bare = { strategyId: 'x', signalSubtype: 'Y', direction: 'long', symbol: 'MNQ' };
  const full = adapters.tradingOsCanonicalAdapter(tradingOsCandidate(), { now: NOW });
  const empty = adapters.tradingOsCanonicalAdapter(bare, { now: NOW });
  assert.deepStrictEqual(keyTree(empty), keyTree(full));
});

// ── adapterFor ───────────────────────────────────────────────────────────────

test('adapterFor väljer native på futures_native-källa', () => {
  assert.strictEqual(adapters.adapterFor({ signalSource: 'futures_native_mnq_candles' }), adapters.nativeCanonicalAdapter);
});

test('adapterFor väljer TradingOS på trading_os-källa', () => {
  assert.strictEqual(adapters.adapterFor({ signalSource: 'trading_os' }), adapters.tradingOsCanonicalAdapter);
});

test('adapterFor GISSAR ALDRIG vid okänd producent', () => {
  assert.strictEqual(adapters.adapterFor({ signalSource: 'okänd_källa' }), null);
  assert.strictEqual(adapters.adapterFor({}), null);
});

// ── Riktningsöversättning ────────────────────────────────────────────────────

for (const [raw, expected] of [
  ['long', 'LONG'], ['LONG', 'LONG'], ['up', 'LONG'], ['buy', 'LONG'], ['bullish', 'LONG'],
  ['short', 'SHORT'], ['down', 'SHORT'], ['sell', 'SHORT'], ['bearish', 'SHORT'],
]) {
  test(`riktning "${raw}" → ${expected}`, () => {
    const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate({ direction: raw }), { now: NOW });
    assert.strictEqual(s.direction, expected);
  });
}

test('okänd riktning ger null — aldrig en gissning', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate({ direction: 'sideways', nextMoveBias: null }), { now: NOW });
  assert.strictEqual(s.direction, null);
  assert.strictEqual(validateCanonicalSignal(s).ok, false);
});

test('marknadstyp: USDT-symbol klassas som crypto', () => {
  const s = adapters.tradingOsCanonicalAdapter(tradingOsCandidate({ symbol: 'BTCUSDT', marketType: null, market: null }), { now: NOW });
  assert.strictEqual(s.marketType, 'crypto');
});

test('adaptern muterar aldrig sin indata', () => {
  const candidate = tradingOsCandidate();
  const before = JSON.stringify(candidate);
  adapters.tradingOsCanonicalAdapter(candidate, { now: NOW });
  assert.strictEqual(JSON.stringify(candidate), before);
});

console.log(`\ncanonicalSignalAdapters: ${passed} tester ok`);
