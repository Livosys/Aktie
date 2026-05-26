'use strict';

/**
 * Market Gate v3 — unit tests
 * Run: node src/markets/marketGate.test.js
 */

const { evaluateMarketGate,
        THRESHOLD_NORMAL, THRESHOLD_CONSERVATIVE,
        THRESHOLD_LEVERAGED, THRESHOLD_CRYPTO_SEC,
        THRESHOLD_OBSERVE_ONLY } = require('./marketGate');

let passed = 0;
let failed = 0;

function assert(name, condition, got) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}  →  got: ${JSON.stringify(got)}`);
    failed++;
  }
}

// Shared compass mock — patch getMarketCompass via require cache
const compassModule = require('./marketCompass');
const _orig = compassModule.getMarketCompass;
function setCompass(c) { compassModule.getMarketCompass = () => c; }
function restoreCompass() { compassModule.getMarketCompass = _orig; }

// ── Test 1: VWAP_RECLAIM_UP + strong + risk-on → allowed ────────────────────
{
  setCompass({ bias: 'RISK_ON', riskOn: true, riskOff: false });
  const d = evaluateMarketGate({
    symbol: 'BTCUSDT', marketType: 'crypto', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'strong', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 60,
  }, { conservativeMode: false });

  assert('T1: VWAP_RECLAIM_UP + strong + risk-on → allowed',     d.allowed === true,          d.allowed);
  assert('T1: mode is normal',                                    d.mode === 'normal',          d.mode);
  assert('T1: gateScore >= THRESHOLD_NORMAL',                    d.gateScore >= THRESHOLD_NORMAL, d.gateScore);
  assert('T1: no compassConflict',                               d.compassConflict === false,  d.compassConflict);
}

// ── Test 2: RISK_OFF + UP + US_STOCKS → compass conflict, penalized ─────────
{
  setCompass({ bias: 'RISK_OFF', riskOn: false, riskOff: true });
  const d = evaluateMarketGate({
    symbol: 'NVDA', marketType: 'stocks', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'strong', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 60,
  }, { conservativeMode: false });

  assert('T2: RISK_OFF + long US_STOCKS → compassConflict', d.compassConflict === true,  d.compassConflict);
  assert('T2: penalties include risk-off',                  d.penalties.some(p => /risk-off/i.test(p)), d.penalties);
}

// ── Test 3: EMA_PULLBACK_DOWN crypto → observe_only ─────────────────────────
{
  setCompass(null);
  const d = evaluateMarketGate({
    symbol: 'BTCUSDT', marketType: 'crypto', signalSubtype: 'EMA_PULLBACK_DOWN',
    nextMoveBias: 'DOWN', volumeState: 'strong', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, {});

  assert('T3: EMA_PULLBACK_DOWN crypto → observe_only',    d.allowed === false, d.allowed);
  assert('T3: mode is observe_only',                       d.mode === 'observe_only', d.mode);
  assert('T3: observe reason mentions EMA',                /EMA i crypto/i.test(d.observeOnlyReasonSv || ''), d.observeOnlyReasonSv);
}

// ── Test 4: Normal vol + EMA_PULLBACK_UP crypto → observe_only ──────────────
{
  setCompass(null);
  const d = evaluateMarketGate({
    symbol: 'ETHUSDT', marketType: 'crypto', signalSubtype: 'EMA_PULLBACK_UP',
    nextMoveBias: 'UP', volumeState: 'normal', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 40,
  }, {});

  assert('T4: normal vol + EMA_PULLBACK_UP crypto → observe_only', d.allowed === false, d.allowed);
  assert('T4: mode is observe_only',                              d.mode === 'observe_only', d.mode);
  assert('T4: observe reason mentions EMA',                       /EMA i crypto/i.test(d.observeOnlyReasonSv || ''), d.observeOnlyReasonSv);
}

// ── Test 5: LEVERAGED_ETFS → threshold 85 ────────────────────────────────────
{
  setCompass({ bias: 'MIXED', riskOn: false, riskOff: false });
  const d = evaluateMarketGate({
    symbol: 'TQQQ', marketType: 'stocks', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'strong', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, { conservativeMode: false });

  assert('T5: LEVERAGED_ETFS threshold = 85',              d.threshold === THRESHOLD_LEVERAGED, d.threshold);
  assert('T5: warnings include hävstångs',                 d.warnings.some(w => /hävstångs/i.test(w)), d.warnings);
}

// ── Test 6: CRYPTO_SECONDARY → threshold 80 ──────────────────────────────────
{
  setCompass(null);
  const d = evaluateMarketGate({
    symbol: 'BNBUSDT', marketType: 'crypto', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'strong', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, { conservativeMode: false });

  assert('T6: CRYPTO_SECONDARY threshold = 80',            d.threshold === THRESHOLD_CRYPTO_SEC, d.threshold);
  assert('T6: warnings include sekundär krypto',           d.warnings.some(w => /sekundär krypto/i.test(w)), d.warnings);
}

// ── Test 7: conservativeMode → threshold 80 ─────────────────────────────────
{
  setCompass(null);
  const d = evaluateMarketGate({
    symbol: 'BTCUSDT', marketType: 'crypto', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'strong', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, { conservativeMode: true });

  assert('T7: conservativeMode → threshold 80',            d.threshold === THRESHOLD_CONSERVATIVE, d.threshold);
  assert('T7: mode is conservative',                       d.mode === 'conservative' || d.mode === 'blocked', d.mode);
  assert('T7: penalties include konservativt',             d.penalties.some(p => /konservativt/i.test(p)), d.penalties);
}

// ── Test 8: marketClosed NYSE → observe_only mode ────────────────────────────
{
  setCompass(null);
  const d = evaluateMarketGate({
    symbol: 'NVDA', marketType: 'stocks', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'strong', dataFreshness: 'LIVE',
    marketClosed: true, extensionLevel: 'none', confidenceScore: 55,
  }, { conservativeMode: false });

  assert('T8: marketClosed NYSE → observe_only mode',      d.mode === 'observe_only', d.mode);
  assert('T8: threshold = OBSERVE_ONLY',                   d.threshold === THRESHOLD_OBSERVE_ONLY, d.threshold);
  assert('T8: warnings include marknaden är stängd',       d.warnings.some(w => /marknaden är stängd/i.test(w)), d.warnings);
}

// ── Test 9: UNKNOWN marketGroup → observe_only exact reason ──────────────────
{
  setCompass(null);
  const d = evaluateMarketGate({
    symbol: 'UNKNOWNUSDT', marketType: 'crypto', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'strong', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, {});

  assert('T9: UNKNOWN marketGroup → observe_only',          d.mode === 'observe_only', d.mode);
  assert('T9: UNKNOWN never allowed',                       d.allowed === false, d.allowed);
  assert('T9: exact observe reason',                        d.observeOnlyReasonSv === 'Marknadsgrupp saknas. Agenten observerar bara.', d.observeOnlyReasonSv);
}

// ── Test 10: Crypto + MIXED + normal volume → observe_only ───────────────────
{
  setCompass({ bias: 'MIXED', riskOn: false, riskOff: false });
  const d = evaluateMarketGate({
    symbol: 'BTCUSDT', marketType: 'crypto', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'normal', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, {});

  assert('T10: MIXED crypto non-strong volume → observe_only', d.mode === 'observe_only', d.mode);
  assert('T10: exact mixed reason',                            d.observeOnlyReasonSv === 'Blandad marknad och inte stark volym.', d.observeOnlyReasonSv);
}

// ── Test 11: Crypto VWAP weak volume → blocked ───────────────────────────────
{
  setCompass({ bias: 'RISK_ON', riskOn: true, riskOff: false });
  const d = evaluateMarketGate({
    symbol: 'BTCUSDT', marketType: 'crypto', signalSubtype: 'VWAP_RECLAIM_UP',
    nextMoveBias: 'UP', volumeState: 'weak', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, {});

  assert('T11: crypto VWAP weak volume → blocked',         d.mode === 'blocked', d.mode);
  assert('T11: volumeGateDecision block',                  d.volumeGateDecision === 'block', d.volumeGateDecision);
  assert('T11: weak volume reason',                        d.reasons.some(r => /svag volym/i.test(r)), d.reasons);
}

// ── Test 12: Crypto non-VWAP + MIXED + weak volume → observe_only ────────────
{
  setCompass({ bias: 'MIXED', riskOn: false, riskOff: false });
  const d = evaluateMarketGate({
    symbol: 'BTCUSDT', marketType: 'crypto', signalSubtype: 'NARROW_BULL',
    nextMoveBias: 'UP', volumeState: 'weak', dataFreshness: 'LIVE',
    extensionLevel: 'none', confidenceScore: 55,
  }, {});

  assert('T12: MIXED crypto weak non-VWAP → observe_only', d.mode === 'observe_only', d.mode);
  assert('T12: mixed reason exact',                        d.observeOnlyReasonSv === 'Blandad marknad och inte stark volym.', d.observeOnlyReasonSv);
}

restoreCompass();

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`Tests: ${passed + failed} total — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
