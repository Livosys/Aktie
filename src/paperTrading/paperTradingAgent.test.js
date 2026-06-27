'use strict';

const assert = require('assert/strict');
const agent = require('./paperTradingAgent');

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
  assert.deepEqual(trade.originalRiskEvaluation.block_reasons, ['consecutive_losses_limit']);
  assert.equal(trade.entryQualityForwardPreview.gateEnabled, false);
  assert.equal(trade.entryQualityForwardPreview.runtimeBlocked, false);
  assert.equal(trade.entryQualityForwardPreview.twoMinuteConfirmationPreview.applies, false);

  const narrowTrade = agent._internal.buildOpenTrade({
    symbol: 'AMD',
    marketType: 'stocks',
    price: 100,
    status: 'watch',
    nextMoveBias: 'UP',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_BULL_ENTRY',
    confidenceScore: 68,
    dataFreshness: 'LIVE',
    strategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    originalRiskEvaluation: baseRisk,
  }, {
    allowed: true,
    mode: 'allow',
    gateScore: 72,
    threshold: 70,
  });
  assert.equal(narrowTrade.entryQualityForwardPreview.gateEnabled, false);
  assert.equal(narrowTrade.entryQualityForwardPreview.runtimeBlocked, false);
  assert.equal(narrowTrade.entryQualityForwardPreview.twoMinuteConfirmationPreview.applies, true);
  assert.equal(narrowTrade.entryQualityForwardPreview.twoMinuteConfirmationPreview.gateEnabled, false);
  assert.equal(narrowTrade.entryQualityForwardPreview.twoMinuteConfirmationPreview.runtimeBlocked, false);
  assert.equal(
    narrowTrade.entryQualityForwardPreview.twoMinuteConfirmationPreview.reasonCode,
    'narrow_compression_2m_confirmation_replay_warning',
  );

  const narrowWaitEvent = agent._internal.eventFromCandidate('MARKET_CLOSED', {
    symbol: 'SPY',
    marketType: 'stocks',
    status: 'watch',
    nextMoveBias: 'UNCERTAIN',
    signalFamily: 'NARROW_COMPRESSION',
    signalSubtype: 'NARROW_WAIT',
    strategyId: 'narrow_breakout',
    strategyName: 'Narrow Breakout',
    dataFreshness: 'MARKET_CLOSED',
  }, 'Skippad — marknaden är stängd.');
  assert.equal(narrowWaitEvent.entryQualityForwardPreview.gateEnabled, false);
  assert.equal(narrowWaitEvent.entryQualityForwardPreview.runtimeBlocked, false);
  assert.equal(narrowWaitEvent.entryQualityForwardPreview.twoMinuteConfirmationPreview.applies, true);
  assert.equal(narrowWaitEvent.entryQualityForwardPreview.twoMinuteConfirmationPreview.cohort, 'narrow_compression');

  const liveFieldNarrowEvent = agent._internal.eventFromCandidate('TRADE_SKIPPED', {
    symbol: 'SPY',
    marketType: 'stocks',
    status: 'watch',
    nextMoveBias: 'UNCERTAIN',
    raw_strategy: 'NARROW_COMPRESSION',
    signal_subtype: 'NARROW_WAIT',
    strategy_id: 'narrow_breakout',
    dataFreshness: 'MARKET_CLOSED',
  }, 'Skippad — marknaden är stängd.');
  assert.equal(liveFieldNarrowEvent.entryQualityForwardPreview.twoMinuteConfirmationPreview.applies, true);

  const vwapEvent = agent._internal.eventFromCandidate('TRADE_SKIPPED', {
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    status: 'caution',
    nextMoveBias: 'DOWN',
    signalSubtype: 'VWAP_REJECTION_DOWN',
    strategyId: 'vwap_failed_breakout_short',
  }, 'Skippad — testreglerna godkände inte signalen.');
  assert.equal(vwapEvent.entryQualityForwardPreview.twoMinuteConfirmationPreview.applies, false);

  const emaEvent = agent._internal.eventFromCandidate('TRADE_SKIPPED', {
    symbol: 'BTCUSDT',
    marketType: 'crypto',
    status: 'wait',
    nextMoveBias: 'UP',
    signalSubtype: 'EMA_PULLBACK_UP',
    strategyId: 'ema_pullback_continuation',
  }, 'Skippad — status var Vänta.');
  assert.equal(emaEvent.entryQualityForwardPreview.twoMinuteConfirmationPreview.applies, false);

  console.log('# paperTradingAgent override tests passed.');
}

main();
