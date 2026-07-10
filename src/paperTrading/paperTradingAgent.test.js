'use strict';

const assert = require('assert/strict');
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

main();
