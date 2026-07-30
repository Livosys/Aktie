'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-entry-contracts-'));
process.env.PAPER_ENTRY_CONTRACT_EVENTS_FILE = path.join(tmpDir, 'events.jsonl');
process.env.PAPER_ENTRY_CONTRACT_TRADES_FILE = path.join(tmpDir, 'trades.jsonl');
process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'false';

fs.writeFileSync(process.env.PAPER_ENTRY_CONTRACT_EVENTS_FILE, '', 'utf8');
fs.writeFileSync(process.env.PAPER_ENTRY_CONTRACT_TRADES_FILE, '', 'utf8');

const catalog = require('./daytradingStrategyCatalogService');
const svc = require('./paperStrategyEntryContractService');

const NOW = new Date('2026-07-11T18:00:00.000Z');
const SIGNAL_TIME = '2026-07-11T17:58:30.000Z';

function safety(payload) {
  assert.equal(payload.mode, 'paper_only');
  assert.equal(payload.actions_allowed, false);
  assert.equal(payload.can_place_orders, false);
  assert.equal(payload.live_trading_enabled, false);
  assert.equal(payload.broker_enabled, false);
}

function base(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    session: '24_7',
    status: 'active',
    nextMoveBias: 'UP',
    signalSubtype: 'NARROW_BULL_ENTRY',
    dataFreshness: 'LIVE',
    signalTimestamp: SIGNAL_TIME,
    twoMinuteConfirmed: true,
    closedCandle: true,
    volumeState: 'strong',
    confidenceScore: 74,
    extensionLevel: 'none',
    ...overrides,
  };
}

function evalFor(strategyId, candidate) {
  return svc.evaluatePaperEntryContract({ strategyId, candidate, now: NOW });
}

function assertPass(strategyId, candidate, message) {
  const result = evalFor(strategyId, candidate);
  assert.equal(result.allowed, true, message || `${strategyId} should pass`);
  assert.equal(result.reasonCode, null);
  safety(result);
  return result;
}

function assertBlock(strategyId, candidate, reasonCode, message) {
  const result = evalFor(strategyId, candidate);
  assert.equal(result.allowed, false, message || `${strategyId} should block`);
  assert.equal(result.reasonCode, reasonCode);
  safety(result);
  return result;
}

function main() {
  assert.equal(catalog.getCatalog().strategies.length, 33, 'catalog still has 33 canonical strategies');
  assert.equal(svc.entryContractsEnabled(), false, 'code default/flag false keeps rollout off');
  assert.equal(svc.listEntryContracts().length, 5, 'three TradingOS strategies, native MNQ, plus narrow_fakeout_reversal_v1 have entry contracts');

  assert.deepEqual(svc.getEntryContract('narrow_state_expansion_long').allowedSubtypes, ['NARROW_BULL_ENTRY']);
  // narrow_fakeout_reversal_v1 kör på generiska confirmations (väg A): motorn har
  // ingen fakeout-specifik bekräftelse, och kontraktet ska säga det öppet.
  assert.deepEqual(svc.getEntryContract('narrow_fakeout_reversal_v1').allowedSubtypes, ['NARROW_FAKEOUT']);
  assert.deepEqual(svc.getEntryContract('narrow_fakeout_reversal_v1').requiredConfirmations,
    ['two_minute_confirmation', 'closed_candle_confirmation']);
  assert.equal(svc.getEntryContract('narrow_fakeout_reversal_v1').confirmationGrade, 'generic');
  assert.deepEqual(svc.getEntryContract('ema_pullback_continuation').allowedSubtypes, ['EMA_PULLBACK_UP']);
  assert.deepEqual(svc.getEntryContract('vwap_volume_breakout_long').allowedSubtypes, ['VWAP_RECLAIM_UP']);
  assert.deepEqual(svc.getEntryContract('mnq_globex_momentum_v1').allowedSubtypes, ['GLOBEX_MOMENTUM']);
  assert.equal(svc.getEntryContract('narrow_breakout'), null, 'non-active strategy has no contract');

  assertBlock(
    'narrow_breakout',
    base({ strategyId: 'narrow_breakout' }),
    svc.REASON_CODES.CONTRACT_MISSING,
    'enabled strategy without contract fails closed',
  );

  assertPass('narrow_state_expansion_long', base(), 'confirmed narrow bull can pass');
  assertBlock('narrow_state_expansion_long', base({ status: 'watch' }), svc.REASON_CODES.WATCH_ONLY);
  assertBlock('narrow_state_expansion_long', base({ status: 'caution', twoMinuteConfirmed: false }), svc.REASON_CODES.CAUTION_ONLY);
  assertBlock('narrow_state_expansion_long', base({ signalSubtype: 'NARROW_WAIT' }), svc.REASON_CODES.INVALID_SUBTYPE);
  assertBlock('narrow_state_expansion_long', base({ signalSubtype: 'NARROW_BEAR_ENTRY', nextMoveBias: 'DOWN' }), svc.REASON_CODES.INVALID_SUBTYPE);
  assertBlock('narrow_state_expansion_long', base({ extensionLevel: 'mild' }), svc.REASON_CODES.LATE_EXTENDED_ENTRY);
  assertBlock('narrow_state_expansion_long', base({ signalTimestamp: '2026-07-11T17:50:00.000Z' }), svc.REASON_CODES.STALE_SIGNAL);
  assertBlock('narrow_state_expansion_long', base({ twoMinuteConfirmed: false }), svc.REASON_CODES.MISSING_TWO_MINUTE);
  assertBlock('narrow_state_expansion_long', base({ closedCandle: false }), svc.REASON_CODES.MISSING_CLOSED_CANDLE);
  assertBlock(
    'narrow_state_expansion_long',
    base({ decisionTextSv: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.' }),
    svc.REASON_CODES.WATCH_ONLY,
    'observation text is a defensive fallback block',
  );

  const emaReady = base({
    signalSubtype: 'EMA_PULLBACK_UP',
    emaContext: { trendIntact: true, reclaimConfirmed: true },
    emaPullbackConfirmed: true,
    trendDirection: 'UP',
  });
  assertPass('ema_pullback_continuation', emaReady, 'confirmed EMA reclaim can pass');
  assertBlock('ema_pullback_continuation', { ...emaReady, status: 'watch', emaPullbackConfirmed: false }, svc.REASON_CODES.WATCH_ONLY);
  assertBlock('ema_pullback_continuation', { ...emaReady, signalSubtype: 'EMA_PULLBACK_DOWN', nextMoveBias: 'DOWN' }, svc.REASON_CODES.INVALID_SUBTYPE);
  assertBlock('ema_pullback_continuation', { ...emaReady, emaContext: null, trendDirection: null, emaPullbackConfirmed: true }, svc.REASON_CODES.MISSING_EMA_PULLBACK);
  assertBlock('ema_pullback_continuation', { ...emaReady, emaContext: { trendIntact: false, reclaimConfirmed: true } }, svc.REASON_CODES.MISSING_EMA_PULLBACK);
  assertBlock('ema_pullback_continuation', { ...emaReady, emaPullbackConfirmed: false, emaContext: { trendIntact: true, reclaimConfirmed: false } }, svc.REASON_CODES.MISSING_EMA_PULLBACK);
  assertBlock('ema_pullback_continuation', { ...emaReady, extensionLevel: 'medium' }, svc.REASON_CODES.LATE_EXTENDED_ENTRY);
  assertBlock('ema_pullback_continuation', { ...emaReady, signalAgeMs: 240000 }, svc.REASON_CODES.STALE_SIGNAL);

  const vwapReady = base({
    symbol: 'AAPL',
    marketType: 'stocks',
    session: 'regular',
    signalSubtype: 'VWAP_RECLAIM_UP',
    vwapContext: { reclaimConfirmed: true, closeAboveVwap: true },
    vwapReclaimConfirmed: true,
    closeAboveVwap: true,
    volumeConfirmed: true,
  });
  assertPass('vwap_volume_breakout_long', vwapReady, 'confirmed VWAP reclaim can pass');
  assertBlock('vwap_volume_breakout_long', { ...vwapReady, vwapReclaimConfirmed: false, vwapContext: { reclaimConfirmed: false, closeAboveVwap: false }, closeAboveVwap: false }, svc.REASON_CODES.MISSING_VWAP_RECLAIM);
  assertBlock('vwap_volume_breakout_long', { ...vwapReady, signalSubtype: 'VWAP_REJECTION_DOWN', nextMoveBias: 'DOWN' }, svc.REASON_CODES.INVALID_SUBTYPE);
  assertBlock('vwap_volume_breakout_long', { ...vwapReady, symbol: 'BTCUSDT', marketType: 'crypto', session: '24_7' }, svc.REASON_CODES.MISSING_MARKET_CONTEXT);
  assertBlock('vwap_volume_breakout_long', { ...vwapReady, marketClosed: true, dataFreshness: 'MARKET_CLOSED' }, svc.REASON_CODES.STALE_SIGNAL);
  assertBlock('vwap_volume_breakout_long', { ...vwapReady, volumeConfirmed: false, volumeState: 'normal', rvol: 1.0 }, svc.REASON_CODES.MISSING_VOLUME);
  assertBlock('vwap_volume_breakout_long', { ...vwapReady, extensionLevel: 'mild' }, svc.REASON_CODES.LATE_EXTENDED_ENTRY);
  assertBlock('vwap_volume_breakout_long', { ...vwapReady, dataAgeSeconds: 260 }, svc.REASON_CODES.STALE_SIGNAL);

  assertBlock('ema_pullback_continuation', { ...emaReady, side: 'SELL' }, svc.REASON_CODES.INVALID_DIRECTION, 'side=SELL cannot pass contract');
  assertBlock('ema_pullback_continuation', { ...emaReady, signal: 'SHORT_TRIGGERED' }, svc.REASON_CODES.INVALID_DIRECTION, 'bearish producer signal cannot pass contract');

  const nativeReady = {
    symbol: 'MNQ',
    marketType: 'futures',
    session: 'europe',
    signalStatus: 'ready',
    status: 'READY_WAITING_FOR_SIGNAL',
    direction: 'long',
    signalSubtype: 'GLOBEX_MOMENTUM',
    dataFreshness: 'LIVE',
    signalTimestamp: '2026-07-11T17:59:00.000Z',
    closedCandleConfirmed: true,
    extensionLevel: 'none',
  };
  assertPass('mnq_globex_momentum_v1', nativeReady, 'native MNQ long can pass its futures entry contract');
  assertPass('mnq_globex_momentum_v1', { ...nativeReady, direction: 'short' }, 'native MNQ short can pass its futures entry contract');
  assertBlock('mnq_globex_momentum_v1', { ...nativeReady, signalSubtype: 'OTHER' }, svc.REASON_CODES.INVALID_SUBTYPE);
  assertBlock('mnq_globex_momentum_v1', { ...nativeReady, closedCandleConfirmed: false }, svc.REASON_CODES.MISSING_CLOSED_CANDLE);

  process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'true';
  assert.equal(svc.entryContractsEnabled(), true, 'flag true enables runtime rollout');

  fs.appendFileSync(process.env.PAPER_ENTRY_CONTRACT_EVENTS_FILE, `${JSON.stringify({
    timestamp: '2026-07-11T17:59:00.000Z',
    type: 'GATE_BLOCKED',
    strategyId: 'narrow_state_expansion_long',
    symbol: 'BTCUSDT',
    signalSubtype: 'NARROW_BULL_ENTRY',
    status: 'watch',
    blockedReason: svc.REASON_CODES.WATCH_ONLY,
    entryContractVersion: svc.PAPER_ENTRY_CONTRACT_VERSION,
    entryContractEvidence: { signalAgeMs: 10000 },
  })}\n`);
  fs.appendFileSync(process.env.PAPER_ENTRY_CONTRACT_TRADES_FILE, `${JSON.stringify({
    entryTime: '2026-07-11T17:58:45.000Z',
    tradeId: 'pt_test',
    strategyId: 'narrow_state_expansion_long',
    symbol: 'BTCUSDT',
    result: 'TIMEOUT',
    mfePct: 0,
    maePct: -0.1,
  })}\n`);

  const diagnostics = svc.buildEntryContractDiagnostics({ now: NOW, windowHours: 1 });
  assert.equal(diagnostics.byStrategyId.narrow_state_expansion_long.contractBlock, 1);
  assert.equal(diagnostics.byStrategyId.narrow_state_expansion_long.commonBlocker.reasonCode, svc.REASON_CODES.WATCH_ONLY);
  assert.equal(diagnostics.byStrategyId.narrow_state_expansion_long.trades, 1);
  assert.equal(diagnostics.byStrategyId.narrow_state_expansion_long.timeouts, 1);
  safety(diagnostics);

  const response = svc.buildEntryContractsResponse({ now: NOW, windowHours: 1 });
  assert.equal(response.summary.totalStrategies, 33);
  // 4 av katalogens 33 har kontrakt (mnq_globex_momentum_v1 är native futures och
  // ingår inte i katalogen): de tre Trading OS-strategierna + narrow_fakeout_reversal_v1.
  assert.equal(response.summary.ready, 4);
  assert.equal(response.summary.missing, 29);
  assert.equal(response.summary.contractBlock, 1);
  assert.equal(response.entryContractsEnabled, true);
  safety(response);

  console.log('paperStrategyEntryContractService.test.js passed');
}

try {
  main();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
