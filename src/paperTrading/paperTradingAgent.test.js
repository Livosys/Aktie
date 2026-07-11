'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-agent-manual-gate-'));
process.env.PAPER_ENABLED_STRATEGIES_FILE = path.join(tmpDir, 'enabled-strategies.json');
process.env.PAPER_STRATEGY_APPROVALS_FILE = path.join(tmpDir, 'strategy-approvals.json');
process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'false';
process.env.PAPER_LONG_ONLY_ENABLED = 'true';

fs.writeFileSync(process.env.PAPER_STRATEGY_APPROVALS_FILE, JSON.stringify({
  schemaVersion: 1,
  strategies: {},
  selectedByFamily: {},
  updatedAt: '2026-07-11T00:00:00.000Z',
}, null, 2));

const paperEnabledStrategies = require('../services/paperEnabledStrategiesService');
paperEnabledStrategies._internal.writeStoreAtomic(
  paperEnabledStrategies.buildInitialStore({
    now: '2026-07-11T17:00:00.000Z',
    source: 'manual_initial_migration',
  }),
  new Date('2026-07-11T17:00:00.000Z'),
);

const agent = require('./paperTradingAgent');
const strategyRuntimeConnector = require('../services/strategyRuntimeConnectorService');

function main() {
  const baseRisk = {
    allowed: false,
    block_reasons: ['consecutive_losses_limit'],
    pause_trading: true,
    pause_reasons: ['consecutive_losses_limit'],
    warnings: ['near_consecutive_losses_limit'],
  };

  const paperRiskConfig = agent._internal.ordinaryPaperRiskConfig({
    pause_after_consecutive_losses: true,
    pause_after_daily_loss: true,
    max_consecutive_losses: 4,
    max_daily_loss_pct: 2,
  });
  assert.equal(paperRiskConfig.pause_after_consecutive_losses, false);
  assert.equal(paperRiskConfig.pause_after_daily_loss, true);
  assert.equal(paperRiskConfig.max_consecutive_losses, 4);

  const unchanged = agent._internal.applyManualRiskReviewOverride(baseRisk, false);
  assert.equal(unchanged.overrideActive, false);
  assert.deepEqual(unchanged.riskEvaluation, baseRisk);

  const overridden = agent._internal.applyManualRiskReviewOverride(baseRisk, true);
  assert.equal(overridden.overrideActive, true);
  assert.equal(overridden.riskEvaluation.allowed, true);
  assert.deepEqual(overridden.riskEvaluation.block_reasons, []);
  assert.equal(overridden.riskEvaluation.pause_trading, false);
  assert.deepEqual(overridden.riskEvaluation.pause_reasons, []);

  const mixedRisk = {
    allowed: false,
    block_reasons: ['low_confidence', 'consecutive_losses_limit'],
    pause_trading: true,
    pause_reasons: ['consecutive_losses_limit'],
    warnings: ['near_consecutive_losses_limit'],
  };

  const mixedOverride = agent._internal.applyManualRiskReviewOverride(mixedRisk, true);
  assert.equal(mixedOverride.overrideActive, true);
  assert.equal(mixedOverride.riskEvaluation.allowed, false);
  assert.deepEqual(mixedOverride.riskEvaluation.block_reasons, ['low_confidence']);
  assert.equal(mixedOverride.riskEvaluation.pause_trading, false);
  assert.deepEqual(mixedOverride.riskEvaluation.pause_reasons, []);

  const effectiveRiskState = agent._internal.buildEffectiveRiskReviewState(mixedRisk, {
    active: true,
    expiresAt: '2026-06-18T19:21:31.102Z',
  });
  assert.equal(effectiveRiskState.riskReviewOverrideActive, true);
  assert.equal(effectiveRiskState.riskPauseTrading, false);
  assert.deepEqual(effectiveRiskState.effectiveRiskEvaluation.block_reasons, ['low_confidence']);
  assert.equal(effectiveRiskState.originalRiskEvaluation.pause_trading, true);

  const inactiveRiskState = agent._internal.buildEffectiveRiskReviewState(baseRisk, {
    active: false,
    expiresAt: '2026-06-18T19:21:31.102Z',
  });
  assert.equal(inactiveRiskState.riskReviewOverrideActive, false);
  assert.equal(inactiveRiskState.riskPauseTrading, true);
  assert.deepEqual(inactiveRiskState.effectiveRiskEvaluation.block_reasons, ['consecutive_losses_limit']);

  const nearMiss = agent._internal.buildNearMissLearningGateDecision(
    {
      allowed: false,
      mode: 'blocked',
      gateScore: 69,
      threshold: 70,
      reasons: [],
      warnings: [],
    },
    {
      status: 'watch',
      nextMoveBias: 'UP',
      signalSubtype: 'EMA_PULLBACK_UP',
      strategyId: 'trend_continuation',
      runtimeStatus: 'enabled',
    },
    {
      nearMissLearningEnabled: true,
      nearMissLearningMargin: 5,
    },
  );
  assert.equal(nearMiss.allowed, true);
  assert.equal(nearMiss.eligible, true);
  assert.equal(nearMiss.reasonCode, 'near_miss_learning_entry');

  const latePullbackCandidate = {
    symbol: 'ETHUSDT',
    marketType: 'crypto',
    status: 'caution',
    nextMoveBias: 'UP',
    signalFamily: 'REGULAR_PULLBACK',
    signalSubtype: 'REGULAR_PULLBACK',
    strategyId: 'trend_continuation',
    confidenceScore: 68,
    dataFreshness: 'LIVE',
    decisionTextSv: 'Rörelsen har gått en bit. Bevaka rekyl eller ny 2m-bekräftelse.',
  };
  assert.equal(agent._internal.shouldBlockLateRegularPullbackEntry(latePullbackCandidate), true);
  const latePullbackSkip = agent._internal.buildLateRegularPullbackSkipEvent(latePullbackCandidate, {
    allowed: true,
    mode: 'allow',
    gateScore: 68,
    threshold: 70,
    nearMissLearning: true,
  });
  assert.equal(latePullbackSkip.type, 'TRADE_SKIPPED');
  assert.equal(latePullbackSkip.blockedReason, 'Sen entry — kräver pullback eller ny 2m-bekräftelse');
  assert.equal(latePullbackSkip.reasonSv, 'Sen entry — kräver pullback eller ny 2m-bekräftelse');
  assert.equal(latePullbackSkip.strategyId, 'trend_continuation');
  assert.equal(latePullbackSkip.symbol, 'ETHUSDT');
  assert.equal(latePullbackSkip.setup, 'REGULAR_PULLBACK');
  assert.equal(latePullbackSkip.statusAtEntry, 'caution');
  assert.equal(latePullbackSkip.nearMissLearning, true);
  assert.equal(latePullbackSkip.paperOnly, true);
  assert.equal(latePullbackSkip.actions_allowed, false);
  assert.equal(latePullbackSkip.can_place_orders, false);
  assert.equal(latePullbackSkip.live_trading_enabled, false);
  assert.equal(latePullbackSkip.broker_enabled, false);

  assert.equal(agent._internal.shouldBlockLateRegularPullbackEntry({
    ...latePullbackCandidate,
    status: 'watch',
  }), false);
  assert.equal(agent._internal.buildLateRegularPullbackSkipEvent({
    ...latePullbackCandidate,
    status: 'watch',
  }), null);

  assert.equal(agent._internal.shouldBlockLateRegularPullbackEntry({
    ...latePullbackCandidate,
    strategyId: 'narrow_breakout',
  }), false);
  assert.equal(agent._internal.buildLateRegularPullbackSkipEvent({
    ...latePullbackCandidate,
    strategyId: 'narrow_breakout',
  }), null);

  assert.equal(agent._internal.shouldBlockLateRegularPullbackEntry({
    ...latePullbackCandidate,
    twoMinuteConfirmed: true,
  }), false);

  const manualBullCandidate = {
    symbol: 'AAPL',
    marketType: 'stocks',
    status: 'watch',
    nextMoveBias: 'UP',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_BULL_ENTRY',
    dataFreshness: 'LIVE',
    volumeState: 'normal',
  };
  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'true';
  assert.equal(agent._internal.paperManualStrategyListEnabled(), true);
  const manualBullGate = agent._internal.evaluateManualPaperStrategyGate(manualBullCandidate);
  assert.equal(manualBullGate.allowed, true, 'manual enabled list allows initial enabled narrow long');
  assert.equal(manualBullGate.strategyId, 'narrow_state_expansion_long');
  assert.equal(manualBullGate.isExplicitlyEnabledStrategy, true);

  const manualDisabledGate = agent._internal.evaluateManualPaperStrategyGate({
    ...manualBullCandidate,
    nextMoveBias: 'DOWN',
    signalSubtype: 'NARROW_BEAR_ENTRY',
  });
  assert.equal(manualDisabledGate.allowed, false, 'manual list blocks disabled mapped strategy');
  assert.equal(manualDisabledGate.strategyId, 'narrow_breakout');
  assert.equal(manualDisabledGate.blockedReason, 'paper_strategy_not_enabled');

  const manualUnknownGate = agent._internal.evaluateManualPaperStrategyGate({
    symbol: 'AAPL',
    marketType: 'stocks',
    signalFamily: 'UNKNOWN',
    signalSubtype: 'UNKNOWN',
  });
  assert.equal(manualUnknownGate.allowed, false);
  assert.equal(manualUnknownGate.blockedReason, 'unknown_signal_mapping');

  const manualNoTradeGate = agent._internal.evaluateManualPaperStrategyGate({
    symbol: 'AAPL',
    marketType: 'stocks',
    signalFamily: 'UNKNOWN',
    signalSubtype: 'NO_TRADE',
  });
  assert.equal(manualNoTradeGate.allowed, false);
  assert.equal(manualNoTradeGate.blockedReason, 'no_trade_signal');

  paperEnabledStrategies.enableStrategy('trend_continuation', { source: 'test' });
  const manualTrendGate = agent._internal.evaluateManualPaperStrategyGate({
    symbol: 'AAPL',
    marketType: 'stocks',
    signalFamily: 'REGULAR_PULLBACK',
    signalSubtype: 'REGULAR_PULLBACK',
    nextMoveBias: 'UP',
  });
  assert.equal(manualTrendGate.allowed, true, 'manual enabled strategy can reach runtime gate');
  const trendRuntimeDecision = strategyRuntimeConnector.canCreatePaperTradeForSignal({
    symbol: 'AAPL',
    marketType: 'stocks',
    signalFamily: 'REGULAR_PULLBACK',
    signalSubtype: 'REGULAR_PULLBACK',
    nextMoveBias: 'UP',
  });
  assert.equal(trendRuntimeDecision.allowed, false, 'runtime connector still blocks setup without paper entry contract');
  assert.equal(agent._internal.manualRuntimeBlockedReason(trendRuntimeDecision), 'paper_strategy_enabled_but_entry_contract_missing');
  paperEnabledStrategies.disableStrategy('trend_continuation', { source: 'test' });

  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'false';
  assert.equal(agent._internal.paperManualStrategyListEnabled(), false);
  const legacyRuntimeDecision = strategyRuntimeConnector.canCreatePaperTradeForSignal(manualBullCandidate);
  const legacyRuntimeCandidate = agent._internal.normalizeCandidateStrategyMetadata(manualBullCandidate, legacyRuntimeDecision);
  const legacyGate = agent._internal.evaluateLegacyPaperStrategyGate(
    legacyRuntimeCandidate,
    legacyRuntimeDecision,
    'narrow_state_expansion_long',
  );
  assert.equal(legacyGate.allowed, false, 'flag false keeps legacy approval/family behavior');
  assert.notEqual(legacyGate.blockedReason, 'paper_strategy_not_enabled');

  const entryState = { openTrades: [], cooldowns: {}, seenSignalIds: [] };
  const emaCandidate = {
    symbol: 'AAPL',
    marketType: 'stocks',
    status: 'watch',
    nextMoveBias: 'UP',
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: 'EMA_PULLBACK_UP',
    dataFreshness: 'LIVE',
    marketClosed: false,
    volumeState: 'normal',
  };
  assert.equal(
    agent._internal.qualifiesForEntry(emaCandidate, entryState, { isExplicitlyEnabledStrategy: false }).reason,
    'EMA paused in paper test',
    'non-enabled strategy still hits identity filter',
  );
  assert.equal(
    agent._internal.qualifiesForEntry(emaCandidate, entryState, { isExplicitlyEnabledStrategy: true }).ok,
    true,
    'manual enabled strategy only bypasses the same identity filter approval used to bypass',
  );
  assert.equal(
    agent._internal.qualifiesForEntry({ ...emaCandidate, dataFreshness: 'STALE' }, entryState, { isExplicitlyEnabledStrategy: true }).ok,
    false,
    'freshness still applies to manual enabled strategies',
  );
  assert.equal(
    agent._internal.qualifiesForEntry({ ...emaCandidate, marketClosed: true }, entryState, { isExplicitlyEnabledStrategy: true }).reason,
    'market closed',
    'market/session gate still applies to manual enabled strategies',
  );
  assert.match(
    agent._internal.qualifiesForEntry(emaCandidate, {
      ...entryState,
      cooldowns: { AAPL: new Date().toISOString() },
    }, { isExplicitlyEnabledStrategy: true }).reason,
    /^cooldown/,
    'cooldown still applies to manual enabled strategies',
  );

  assert.equal(agent._internal.paperLongOnlyEnabled(), true);
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'vwap_failed_breakout_short', signalSubtype: 'VWAP_REJECTION_DOWN' }).blockedReason,
    'long_only_short_strategy',
    'short-only VWAP strategy is blocked',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'ema_breakdown', signalSubtype: 'EMA_PULLBACK_DOWN' }).blockedReason,
    'long_only_short_strategy',
    'ema_breakdown short strategy is blocked',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'narrow_breakout', signalSubtype: 'NARROW_BEAR_ENTRY' }).blockedReason,
    'long_only_short_entry',
    'NARROW_BEAR_ENTRY is blocked',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'ema_pullback_continuation', signalSubtype: 'EMA_PULLBACK_DOWN' }).blockedReason,
    'long_only_short_entry',
    'EMA_PULLBACK_DOWN is blocked',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'vwap_volume_breakout_long', signalSubtype: 'VWAP_REJECTION_DOWN' }).blockedReason,
    'long_only_short_entry',
    'VWAP_REJECTION_DOWN is blocked',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'ema_pullback_continuation', side: 'SELL' }).blockedReason,
    'long_only_short_entry',
    'side=SELL is blocked',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'narrow_state_expansion_long', nextMoveBias: 'DOWN', signalSubtype: 'NARROW_BEAR_ENTRY' }).blockedReason,
    'long_only_short_entry',
    'nextMoveBias=DOWN on bearish setup is blocked',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'narrow_state_expansion_long', nextMoveBias: 'UP', signalSubtype: 'NARROW_BULL_ENTRY' }).allowed,
    true,
    'NARROW_BULL_ENTRY can pass LONG_ONLY',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'ema_pullback_continuation', nextMoveBias: 'UP', signalSubtype: 'EMA_PULLBACK_UP' }).allowed,
    true,
    'EMA_PULLBACK_UP can pass LONG_ONLY',
  );
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'vwap_volume_breakout_long', nextMoveBias: 'UP', signalSubtype: 'VWAP_RECLAIM_UP' }).allowed,
    true,
    'VWAP_RECLAIM_UP can pass LONG_ONLY',
  );
  process.env.PAPER_LONG_ONLY_ENABLED = 'false';
  assert.equal(
    agent._internal.evaluateLongOnlyPaperGate({ strategyId: 'vwap_failed_breakout_short', signalSubtype: 'VWAP_REJECTION_DOWN' }).allowed,
    true,
    'feature flag false disables only the LONG_ONLY gate',
  );
  process.env.PAPER_LONG_ONLY_ENABLED = 'true';

  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'false';

  const mixedNarrowCandidate = {
    symbol: 'NVDA',
    marketType: 'stocks',
    price: 100,
    status: 'watch',
    nextMoveBias: 'DOWN',
    signal: 'SHORT_TRIGGERED',
    eventType: 'BEARISH_ELEPHANT_BREAKDOWN',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_BEAR_ENTRY',
    strategyId: 'resistance_rejection',
    strategy_id: 'resistance_rejection',
    strategyName: 'Resistance Rejection',
    strategy_name: 'Resistance Rejection',
    sourceStrategyId: 'narrow_breakout',
    sourceStrategyName: 'Narrow Breakout',
    resolvedStrategyId: 'resistance_rejection',
    resolvedStrategyName: 'Resistance Rejection',
    mappingSource: 'legacy_fallback',
    confidenceScore: 72,
    dataFreshness: 'LIVE',
    volumeState: 'normal',
  };
  const mixedRuntimeDecision = strategyRuntimeConnector.canCreatePaperTradeForSignal(mixedNarrowCandidate);
  assert.equal(mixedRuntimeDecision.allowed, true, 'mixed narrow runtime ska vara allowed');
  assert.equal(mixedRuntimeDecision.strategy?.strategy_id, 'narrow_breakout', 'mixed narrow runtime ska resolvas till narrow_breakout');

  const normalizedMixed = agent._internal.normalizeCandidateStrategyMetadata(mixedNarrowCandidate, mixedRuntimeDecision);
  const mixedEvent = agent._internal.eventFromCandidate('GATE_ALLOWED', normalizedMixed, 'Gate godkänd.', 'allowed');
  assert.equal(mixedEvent.strategyId, 'narrow_breakout');
  assert.equal(mixedEvent.resolvedStrategyId, 'narrow_breakout');
  assert.equal(mixedEvent.strategyName, 'Narrow Breakout');
  assert.equal(mixedEvent.mappingSource, 'runtime_map');
  assert.equal(mixedEvent.signalFamily, 'NARROW_COMPRESSION');
  assert.equal(mixedEvent.signalSubtype, 'NARROW_BEAR_ENTRY');
  assert.equal(mixedEvent.originalStrategyMetadata.strategyId, 'resistance_rejection');
  assert.equal(mixedEvent.originalStrategyMetadata.resolvedStrategyId, 'resistance_rejection');
  assert.equal(mixedEvent.runtimeStrategyMetadata.strategyId, 'narrow_breakout');
  assert.notEqual(mixedEvent.strategyId, 'resistance_rejection');
  assert.notEqual(mixedEvent.mappingSource, 'legacy_fallback');

  const closedMixed = agent._internal.normalizeCandidateStrategyMetadata({
    ...mixedNarrowCandidate,
    dataFreshness: 'MARKET_CLOSED',
    marketClosed: true,
  }, mixedRuntimeDecision);
  const marketClosedEvent = agent._internal.eventFromCandidate('MARKET_CLOSED', closedMixed, 'Skippad — marknaden är stängd.');
  assert.equal(marketClosedEvent.strategyId, 'narrow_breakout');
  assert.equal(marketClosedEvent.resolvedStrategyId, 'narrow_breakout');
  assert.equal(marketClosedEvent.mappingSource, 'runtime_map');
  assert.notEqual(marketClosedEvent.mappingSource, 'legacy_fallback');

  const normalizedTrade = agent._internal.buildOpenTrade(normalizedMixed, {
    allowed: true,
    mode: 'allow',
    gateScore: 75,
    threshold: 70,
  });
  assert.equal(normalizedTrade.strategyId, 'narrow_breakout');
  assert.equal(normalizedTrade.resolvedStrategyId, 'narrow_breakout');
  assert.equal(normalizedTrade.strategyName, 'Narrow Breakout');
  assert.equal(normalizedTrade.mappingSource, 'runtime_map');
  assert.equal(normalizedTrade.originalStrategyMetadata.strategyId, 'resistance_rejection');

  const narrowWait = strategyRuntimeConnector.canCreatePaperTradeForSignal({
    symbol: 'NVDA',
    marketType: 'stocks',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_WAIT',
    status: 'watch',
    nextMoveBias: 'DOWN',
    strategyId: 'narrow_breakout',
  });
  assert.equal(narrowWait.allowed, false, 'NARROW_WAIT ska fortsatt blockas');
  assert.equal(narrowWait.strategy?.blocked_reason_code, 'narrow_wait_not_paper_entry');
  const narrowWaitSkip = agent._internal.classifySkip({}, narrowWait.blocked_reason_code || narrowWait.reason);
  assert.equal(narrowWaitSkip.reasonSv, 'Skippad — NARROW_WAIT är ett vänteläge och inte en paper-entry-setup.');

  const regularPullback = strategyRuntimeConnector.canCreatePaperTradeForSignal({
    symbol: 'NVDA',
    marketType: 'stocks',
    signalSubtype: 'REGULAR_PULLBACK',
    status: 'watch',
    nextMoveBias: 'DOWN',
    strategyId: 'trend_continuation',
  });
  assert.equal(regularPullback.allowed, false, 'REGULAR_PULLBACK ska fortsatt blockas');
  assert.equal(regularPullback.strategy?.blocked_reason_code, 'setup_not_paper_entry');
  const regularPullbackSkip = agent._internal.classifySkip({}, regularPullback.blocked_reason_code || regularPullback.reason);
  assert.equal(regularPullbackSkip.reasonSv, 'Skippad — REGULAR_PULLBACK är inte en paper-entry-setup.');

  const cryptoMomentumVwapPartial = strategyRuntimeConnector.canCreatePaperTradeForSignal({
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    signalFamily: 'VWAP_RECLAIM_REJECTION',
    signalSubtype: 'VWAP_RECLAIM_UP',
    strategyId: 'crypto_momentum_scalper',
  });
  assert.equal(cryptoMomentumVwapPartial.allowed, false, 'crypto_momentum_scalper VWAP ska fortsatt blockas när runtime är partial');
  assert.equal(cryptoMomentumVwapPartial.blocked_reason_code, 'runtime_partial_missing_crypto_signal_context');
  const cryptoMomentumVwapSkip = agent._internal.classifySkip({}, cryptoMomentumVwapPartial.blocked_reason_code || cryptoMomentumVwapPartial.reason);
  assert.equal(cryptoMomentumVwapSkip.type, 'TRADE_SKIPPED');
  assert.equal(cryptoMomentumVwapSkip.reasonSv, 'Runtime partial — saknar crypto signal context.');

  const normalResistanceCandidate = {
    symbol: 'NVDA',
    marketType: 'stocks',
    price: 100,
    status: 'watch',
    nextMoveBias: 'DOWN',
    signal: 'SHORT_TRIGGERED',
    eventType: 'BEARISH_ELEPHANT_BREAKDOWN',
    signalSubtype: 'RESISTANCE_REJECTION_SHORT',
    strategyId: 'resistance_rejection',
    strategy_id: 'resistance_rejection',
    resolvedStrategyId: 'resistance_rejection',
    mappingSource: 'legacy_fallback',
  };
  const normalResistanceDecision = strategyRuntimeConnector.canCreatePaperTradeForSignal(normalResistanceCandidate);
  assert.equal(normalResistanceDecision.allowed, true, 'normal resistance_rejection ska fortsatt vara allowed via runtime');
  const normalizedResistance = agent._internal.normalizeCandidateStrategyMetadata(normalResistanceCandidate, normalResistanceDecision);
  const resistanceEvent = agent._internal.eventFromCandidate('GATE_ALLOWED', normalizedResistance, 'Gate godkänd.', 'allowed');
  assert.equal(resistanceEvent.strategyId, 'resistance_rejection');
  assert.equal(resistanceEvent.resolvedStrategyId, 'resistance_rejection');
  assert.notEqual(resistanceEvent.strategyId, 'narrow_breakout');

  const trade = agent._internal.buildOpenTrade({
    symbol: 'TSLA',
    marketType: 'stocks',
    price: 100,
    status: 'watch',
    nextMoveBias: 'UP',
    signalFamily: 'EMA_TREND_PULLBACK',
    signalSubtype: 'EMA_PULLBACK_UP',
    confidenceScore: 68,
    dataFreshness: 'LIVE',
    strategyId: 'trend_continuation',
    strategyName: 'Trend Continuation',
    originalRiskEvaluation: baseRisk,
  }, {
    ...nearMiss,
    allowed: true,
    mode: 'allow',
    nearMissLearning: true,
    marketGateNearMissOverride: true,
    originalGateScore: 69,
    originalGateThreshold: 70,
    originalGateBlockedReason: null,
    gateScore: 69,
    threshold: 70,
  });
  assert.equal(trade.nearMissLearning, true);
  assert.equal(trade.marketGateNearMissOverride, true);
  assert.equal(trade.originalGateScore, 69);
  assert.equal(trade.originalGateThreshold, 70);
  assert.equal(trade.paperOnly, true);
  assert.equal(trade.exitProfile, 'exit_engine_v1');
  assert.deepEqual(trade.originalRiskEvaluation.block_reasons, ['consecutive_losses_limit']);

  const hardTarget = agent._internal.checkHardExit({
    entryPrice: 100,
    targetPct: 0.4,
    stopPct: 0.25,
    maxHoldMinutes: 20,
    entryTime: '2026-06-11T08:00:00.000Z',
    direction: 'UP',
  }, 100.5);
  assert.equal(hardTarget.exitReasonCode, 'target_hit');
  assert.equal(hardTarget.exitSource, 'legacy_hard_rule');

  const hardStop = agent._internal.checkHardExit({
    entryPrice: 100,
    targetPct: 0.4,
    stopPct: 0.25,
    maxHoldMinutes: 20,
    entryTime: '2026-06-11T08:00:00.000Z',
    direction: 'UP',
  }, 99.7);
  assert.equal(hardStop.exitReasonCode, 'stop_hit');
  assert.equal(hardStop.exitSource, 'legacy_hard_rule');

  console.log('# paperTradingAgent override tests passed.');
}

try {
  main();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
