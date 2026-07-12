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
process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'false';

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
const strategyTradeControl = require('../services/strategyTradeControlService');
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

  assert.equal(agent._internal.paperEntryContractsEnabled(), false, 'entry contract rollout defaults off');
  const contractReadyNarrow = {
    ...manualBullCandidate,
    status: 'active',
    session: 'regular',
    signalTimestamp: '2026-07-11T17:58:30.000Z',
    twoMinuteConfirmed: true,
    closedCandle: true,
    volumeState: 'normal',
  };
  const contractDisabled = agent._internal.evaluatePaperEntryContractGate(contractReadyNarrow, {
    strategyId: 'narrow_state_expansion_long',
    enabled: false,
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(contractDisabled.allowed, true, 'flag false does not enforce entry contract');
  assert.equal(contractDisabled.enabled, false);

  process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'true';
  assert.equal(agent._internal.paperEntryContractsEnabled(), true, 'flag true enables contract gate');
  const contractPass = agent._internal.evaluatePaperEntryContractGate(contractReadyNarrow, {
    strategyId: 'narrow_state_expansion_long',
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(contractPass.allowed, true, 'confirmed narrow bull can pass entry contract');
  assert.equal(contractPass.entryContractVersion, 'paper_entry_contract_v1');

  const watchBlock = agent._internal.evaluatePaperEntryContractGate({
    ...contractReadyNarrow,
    status: 'watch',
  }, {
    strategyId: 'narrow_state_expansion_long',
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(watchBlock.allowed, false, 'watch signals cannot open entries');
  assert.equal(watchBlock.reasonCode, 'paper_entry_watch_only');

  const missingConfirmation = agent._internal.evaluatePaperEntryContractGate({
    ...contractReadyNarrow,
    twoMinuteConfirmed: false,
  }, {
    strategyId: 'narrow_state_expansion_long',
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(missingConfirmation.allowed, false, 'missing confirmation blocks entries');
  assert.equal(missingConfirmation.reasonCode, 'missing_two_minute_confirmation');

  const missingContract = agent._internal.evaluatePaperEntryContractGate({
    ...contractReadyNarrow,
    signalSubtype: 'REGULAR_PULLBACK',
  }, {
    strategyId: 'trend_continuation',
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(missingContract.allowed, false, 'manually enabled strategy without contract fails closed');
  assert.equal(missingContract.reasonCode, 'entry_contract_missing');

  const bearishField = agent._internal.evaluatePaperEntryContractGate({
    ...contractReadyNarrow,
    side: 'SELL',
  }, {
    strategyId: 'narrow_state_expansion_long',
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(bearishField.allowed, false, 'contract does not bypass bearish/short field checks');
  assert.equal(bearishField.reasonCode, 'invalid_strategy_direction');

  assert.equal(agent._internal.classifySkip(contractReadyNarrow, 'paper_entry_watch_only').type, 'GATE_BLOCKED');

  process.env.PAPER_MANUAL_STRATEGY_LIST_ENABLED = 'true';
  const rankReady = agent._internal.evaluateFamilyRankEntryEligibility(contractReadyNarrow, {
    manualStrategyGateMode: true,
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(rankReady.eligible, true, 'entry-ready narrow bull can participate in family rank');
  assert.equal(rankReady.strategyId, 'narrow_state_expansion_long');

  const rankWatch = agent._internal.evaluateFamilyRankEntryEligibility({
    ...contractReadyNarrow,
    status: 'watch',
  }, {
    manualStrategyGateMode: true,
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(rankWatch.eligible, false, 'watch signals cannot win family rank');
  assert.equal(rankWatch.reason, 'paper_entry_watch_only');

  const rankStale = agent._internal.evaluateFamilyRankEntryEligibility({
    ...contractReadyNarrow,
    dataFreshness: 'STALE',
  }, {
    manualStrategyGateMode: true,
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(rankStale.eligible, false, 'stale signals cannot win family rank');
  assert.equal(rankStale.reason, 'stale_strategy_signal');

  const rankShort = agent._internal.evaluateFamilyRankEntryEligibility({
    ...contractReadyNarrow,
    side: 'SELL',
  }, {
    manualStrategyGateMode: true,
    now: new Date('2026-07-11T18:00:00.000Z'),
  });
  assert.equal(rankShort.eligible, false, 'short fields cannot win family rank in LONG_ONLY mode');
  assert.equal(rankShort.reason, 'long_only_short_entry');

  const malformedRank = agent._internal.evaluateFamilyRankEntryEligibility({ symbol: 'AAPL' }, null);
  assert.equal(malformedRank.eligible, false, 'malformed rank precheck input fails closed');

  const higherConfidenceWatch = {
    ...contractReadyNarrow,
    symbol: 'MSFT',
    status: 'watch',
    confidenceScore: 99,
  };
  const lowerConfidenceReady = {
    ...contractReadyNarrow,
    symbol: 'AAPL',
    status: 'active',
    confidenceScore: 65,
  };
  const entryEligibleRanks = agent._internal.rankEntryEligibleFamilyCandidates(
    [higherConfidenceWatch, lowerConfidenceReady],
    {
      manualStrategyGateMode: true,
      now: new Date('2026-07-11T18:00:00.000Z'),
    },
  );
  assert.equal(entryEligibleRanks.has(higherConfidenceWatch), false, 'higher-confidence watch candidate is excluded from family rank');
  assert.equal(entryEligibleRanks.get(lowerConfidenceReady).familyRank, 1, 'entry-ready candidate wins eligible-only family rank');
  assert.equal(entryEligibleRanks.get(lowerConfidenceReady).isBestInFamily, true);
  assert.equal(lowerConfidenceReady.familyRank, undefined, 'rank precheck does not mutate candidates');
  assert.equal(lowerConfidenceReady.entryContractAllowed, undefined, 'rank precheck does not mark candidates as trade-ready');
  assert.equal(lowerConfidenceReady.tradeId, undefined, 'rank precheck does not create trades');

  const higherConfidenceExtended = {
    ...contractReadyNarrow,
    symbol: 'TSLA',
    extensionLevel: 'mild',
    confidenceScore: 100,
  };
  const extendedRanks = agent._internal.rankEntryEligibleFamilyCandidates(
    [higherConfidenceExtended, lowerConfidenceReady],
    {
      manualStrategyGateMode: true,
      now: new Date('2026-07-11T18:00:00.000Z'),
    },
  );
  assert.equal(extendedRanks.has(higherConfidenceExtended), false, 'extended candidate is excluded from family rank');
  assert.equal(extendedRanks.get(lowerConfidenceReady).familyRank, 1, 'lower-confidence ready candidate still wins over extended candidate');

  const allIneligibleWatch = {
    ...contractReadyNarrow,
    symbol: 'QQQ',
    status: 'watch',
    confidenceScore: 99,
  };
  const allIneligibleCaution = {
    ...contractReadyNarrow,
    symbol: 'SPY',
    status: 'caution',
    confidenceScore: 98,
  };
  const emptyEligibleRanks = agent._internal.rankEntryEligibleFamilyCandidates(
    [allIneligibleWatch, allIneligibleCaution],
    {
      manualStrategyGateMode: true,
      now: new Date('2026-07-11T18:00:00.000Z'),
    },
  );
  assert.equal(emptyEligibleRanks.size, 0, 'all-ineligible family produces no synthetic rank winner');
  const noRankControl = strategyTradeControl.evaluateStrategyTradeControl({
    strategyId: 'narrow_state_expansion_long',
    strategyFamily: agent._internal.paperCandidateFamily(allIneligibleWatch),
    familyRank: emptyEligibleRanks.get(allIneligibleWatch)?.familyRank ?? null,
    familyHasOpenPosition: false,
    familyLastTradeAt: null,
    config: {
      cooldownMinutes: 30,
      familyCooldownMinutes: 30,
      familyExclusiveEnabled: true,
    },
  });
  assert.notEqual(noRankControl.blockReason, 'strategy_family_not_best_candidate');

  process.env.PAPER_ENTRY_CONTRACTS_ENABLED = 'false';

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

  const contractTrade = agent._internal.buildOpenTrade({
    ...contractReadyNarrow,
    price: 100,
    strategyId: 'narrow_state_expansion_long',
    strategyName: 'Narrow State Expansion Long',
    entryContractVersion: contractPass.entryContractVersion,
    entryContractDecision: 'pass',
    entryContractAllowed: true,
    entryContractChecks: contractPass.checks,
    entryContractEvidence: contractPass.evidence,
  }, {
    allowed: true,
    mode: 'allow',
    gateScore: 75,
    threshold: 70,
  });
  assert.equal(contractTrade.entryContractVersion, 'paper_entry_contract_v1');
  assert.equal(contractTrade.entryContractDecision, 'pass');
  assert.equal(contractTrade.entryContractAllowed, true);
  assert.equal(contractTrade.entryContractEvidence.signalAgeMs, 90000);

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
