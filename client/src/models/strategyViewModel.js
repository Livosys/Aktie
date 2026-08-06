import {
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';

export const EMPTY_STRATEGY_VIEW_MODEL = Object.freeze({
  strategyId: null,
  strategyName: null,
  strategyFamily: null,
  signal: null,
  signalType: null,
  signalFamily: null,
  runtimeState: null,
  approvalState: null,
  riskState: null,
  riskSource: null,
  riskReward: null,
  entryReason: null,
  exitReason: null,
  candidateId: null,
  orderRef: null,
  intentStatus: null,
  marketRegime: null,
  currentCandidate: null,
  entryReady: null,
  canonicalVerdict: null,
  reasonCode: null,
  blocked: null,
  blockedReason: null,
  direction: null,
  symbol: null,
  performance: Object.freeze({
    badge: null,
    winRate: null,
    profitFactor: null,
    trades: null,
    tradesToday: null,
    tradesTotal: null,
    pnlToday: null,
    pnlWeek: null,
    avgPnl: null,
    expectancy: null,
    netPnl: null,
    grossPnl: null,
    commission: null,
    largestWin: null,
    largestLoss: null,
    averageWin: null,
    averageLoss: null,
    drawdown: null,
    wins: null,
    losses: null,
    unrealizedPnl: null,
    score: null,
    consecutiveWins: null,
    consecutiveLosses: null,
    bestMarket: null,
    bestSymbol: null,
  }),
  metadata: Object.freeze({
    source: null,
    dataSource: null,
    timeframe: null,
    market: null,
    status: null,
    createdAt: null,
    updatedAt: null,
  }),
});

export function firstValue(...values) {
  return values.find((value) => hasValue(value)) ?? null;
}

export function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (value === true || value === false) return value;
    if (typeof value !== 'string') continue;
    const text = value.trim().toLowerCase();
    if (['true', 'yes', 'ja'].includes(text)) return true;
    if (['false', 'no', 'nej'].includes(text)) return false;
  }
  return null;
}

function compactSignal(value) {
  if (!hasValue(value)) return null;
  if (Array.isArray(value)) return compactSignal(value[0]);
  if (typeof value === 'object') {
    return firstValue(
      value.currentSignal,
      value.current_signal,
      value.signal,
      value.signalSubtype,
      value.signal_subtype,
      value.signalFamily,
      value.signal_family,
      value.subtype,
      value.decision,
      value.status,
      value.type,
      value.label,
      value.code,
      value.reasonCode,
      value.id,
    ) || null;
  }
  return String(value);
}

export function normalizeStrategyId(...values) {
  return firstValue(...values) || null;
}

function performanceModel(source = {}, overview = null, pulse = null) {
  return {
    badge: firstValue(source.performance?.badge, source.performanceBadge, source.badge, pulse?.badge, overview?.performanceBadge),
    winRate: firstNumber(source.performance?.winRate, source.winRate, source.win_rate, pulse?.winRate, pulse?.win_rate, overview?.winRate, overview?.win_rate),
    profitFactor: firstNumber(source.performance?.profitFactor, source.profitFactor, source.profit_factor, pulse?.profitFactor, pulse?.profit_factor, overview?.profitFactor, overview?.profit_factor),
    trades: firstNumber(source.performance?.trades, source.trades, source.tradeCount, source.paperTradeCount, pulse?.trades, overview?.trades, overview?.paperTradeCount),
    tradesToday: firstNumber(source.performance?.tradesToday, source.tradesToday, source.trades_today, source.todayTrades, source.dailyTrades, pulse?.tradesToday, overview?.tradesToday),
    tradesTotal: firstNumber(source.performance?.tradesTotal, source.tradesTotal, source.totalTrades, source.total_trades, source.tradeCount, source.trades, pulse?.tradesTotal, pulse?.trades, overview?.totalTrades, overview?.tradesUsed, overview?.totalTradesAll, overview?.outcomeCounts?.total),
    pnlToday: firstNumber(source.performance?.pnlToday, source.pnlToday, source.pnl_today, source.dailyPnl, source.dailyPnlUsd, pulse?.pnlToday, overview?.pnlToday),
    pnlWeek: firstNumber(source.performance?.pnlWeek, source.pnlWeek, source.pnl_week, source.weeklyPnl, source.weeklyPnlUsd, pulse?.pnlWeek, overview?.pnlWeek),
    avgPnl: firstNumber(source.performance?.avgPnl, source.avgPnl, source.avg_pnl, pulse?.avgPnl, pulse?.avg_pnl, overview?.avgPnl, overview?.avg_pnl),
    expectancy: firstNumber(source.performance?.expectancy, source.expectancy, source.avgNetPnl, source.avgNetPnlSek),
    netPnl: firstNumber(source.performance?.netPnl, source.netPnl, source.netPnlSek),
    grossPnl: firstNumber(source.performance?.grossPnl, source.grossPnl, source.grossPnlSek),
    commission: firstNumber(source.performance?.commission, source.commission, source.feesSek),
    largestWin: firstNumber(source.performance?.largestWin, source.largestWin, source.bestTradeSek),
    largestLoss: firstNumber(source.performance?.largestLoss, source.largestLoss, source.worstTradeSek),
    averageWin: firstNumber(source.performance?.averageWin, source.averageWin),
    averageLoss: firstNumber(source.performance?.averageLoss, source.averageLoss),
    drawdown: firstNumber(source.performance?.drawdown, source.drawdown),
    wins: firstNumber(source.performance?.wins, source.wins, overview?.outcomeCounts?.WIN),
    losses: firstNumber(source.performance?.losses, source.losses, overview?.outcomeCounts?.LOSS),
    unrealizedPnl: firstNumber(source.performance?.unrealizedPnl, source.unrealizedPnl),
    score: firstNumber(source.performance?.score, source.score, pulse?.score, overview?.score),
    consecutiveWins: firstNumber(source.performance?.consecutiveWins, source.consecutiveWins, source.consecutive_wins, pulse?.consecutiveWins, overview?.consecutiveWins),
    consecutiveLosses: firstNumber(source.performance?.consecutiveLosses, source.consecutiveLosses, source.consecutive_losses, pulse?.consecutiveLosses, overview?.consecutiveLosses),
    bestMarket: firstValue(source.performance?.bestMarket, source.bestMarket, source.best_market, pulse?.bestMarket, pulse?.best_market, overview?.market),
    bestSymbol: firstValue(source.performance?.bestSymbol, source.bestSymbol, source.best_symbol, pulse?.bestSymbol, pulse?.best_symbol, overview?.instrument),
  };
}

export function hasStrategyPerformance(performance = {}) {
  return Object.values(performance || {}).some((value) => hasValue(value));
}

export function isStrategyViewModel(value) {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'strategyId') && Object.prototype.hasOwnProperty.call(value, 'performance'));
}

export function normalizeStrategyViewModel(source = {}) {
  const intent = source.intent || null;
  const candidateId = firstValue(source.candidateId, source.candidate_id, intent?.candidateId);
  const candidate = source.candidate || null;
  const strategyId = normalizeStrategyId(
    source.strategyId,
    source.strategy_id,
    source.canonicalStrategyId,
    source.resolvedStrategyId,
    source.sourceStrategyId,
    candidate?.strategyId,
    candidate?.strategy_id,
    intent?.strategyId,
  );
  const overview = source.overview || null;
  const statusSource = source.strategyStatus || (source.status && typeof source.status === 'object' ? source.status : null);
  const rawStatus = source.status && typeof source.status !== 'object' ? source.status : null;
  const pulse = source.pulse || null;
  const approvedValue = firstValue(source.approved, source.enabledForPaper, overview?.approved, overview?.enabledForPaper);
  const signal = compactSignal(firstValue(
    source.currentSignal,
    source.current_signal,
    source.signal,
    source.latestSignal,
    source.signalSubtype,
    source.signal_subtype,
    source.signalFamily,
    source.signal_family,
    source.signalStatus,
    candidate?.currentSignal,
    candidate?.signal,
    candidate?.signalSubtype,
    candidate?.signalFamily,
    overview?.currentSignal,
    overview?.latestSignal,
    overview?.latestCandidate,
  ));
  const signalType = compactSignal(firstValue(
    source.signalType,
    source.signal_type,
    source.signalSubtype,
    source.signal_subtype,
    candidate?.signalType,
    candidate?.signal_type,
    candidate?.signalSubtype,
    candidate?.signal_subtype,
    overview?.signalType,
    overview?.signalSubtype,
    pulse?.signalType,
    pulse?.signalSubtype,
  ));
  const signalFamily = compactSignal(firstValue(
    source.signalFamily,
    source.signal_family,
    candidate?.signalFamily,
    candidate?.signal_family,
    overview?.signalFamily,
    overview?.signal_family,
    pulse?.signalFamily,
    pulse?.signal_family,
  ));

  return {
    strategyId: strategyId ? String(strategyId) : null,
    strategyName: firstValue(source.strategyName, source.strategy_name, source.displayName, source.name, source.label, overview?.displayName, overview?.strategyName, pulse?.strategyName, pulse?.strategy_name),
    strategyFamily: firstValue(source.strategyFamily, source.strategy_family, source.family, source.marketFamily, overview?.strategyFamily, overview?.family, statusSource?.strategyFamily, statusSource?.family, candidate?.strategyFamily, candidate?.family),
    signal,
    signalType,
    signalFamily,
    runtimeState: firstValue(source.runtimeState, source.runtime_state, source.readinessStatus, source.readiness, source.paperExecutionStatus, source.paperStatus, source.runtimeConnectorStatus, candidate?.runtimeState, candidate?.status, candidate?.executionTargetStatus, overview?.paperExecutionStatus, overview?.paperStatus, overview?.readinessStatus, statusSource?.readiness, statusSource?.runtimeConnectorStatus),
    approvalState: firstValue(source.approvalState, source.approval_state, source.approvalStatus, source.allowlist?.status, source.paperEligibility, candidate?.approvalState, candidate?.approvalStatus, candidate?.executionGate, overview?.approvalStatus, approvedValue === true ? 'approved' : (approvedValue === false ? 'not_approved' : null)),
    riskState: firstValue(source.riskState, source.risk_state, source.riskStatus, source.riskSnapshot?.status, candidate?.riskState, candidate?.riskStatus, overview?.riskState, statusSource?.riskState),
    riskSource: firstValue(source.riskSource, source.risk_source, candidate?.riskSource),
    riskReward: firstNumber(source.riskReward, source.risk_reward, source.rr, candidate?.riskReward, overview?.latestCandidate?.riskReward),
    entryReason: firstValue(source.entryReason, source.entry_reason, source.entryReasonSv, candidate?.entryReason, overview?.entryReason, overview?.latestCandidate?.entryReason),
    exitReason: firstValue(source.exitReason, source.exit_reason, source.exitReasonCode, overview?.exitReason, overview?.latestPaperTrade?.exitReason),
    candidateId: candidateId ? String(candidateId) : null,
    orderRef: firstValue(source.orderRef, intent?.orderRef),
    intentStatus: intent?.status || null,
    marketRegime: firstValue(source.marketRegime, source.market_regime, source.regime, candidate?.marketRegime, candidate?.rawSignalSummary?.marketRegime, overview?.marketRegime, statusSource?.marketRegime),
    currentCandidate: firstValue(source.currentCandidate, source.current_candidate, source.hasCurrentCandidate, source.hasCandidate, candidate?.currentCandidate, overview?.currentCandidate),
    entryReady: firstBoolean(source.entryReady, source.entry_ready, source.producerEntryReadiness?.entryReady, candidate?.entryReady, candidate?.producerEntryReadiness?.entryReady, overview?.entryReady),
    canonicalVerdict: firstValue(source.canonicalVerdict, source.canonical_verdict, source.canonicalReadiness?.verdict, source.entryContract?.readiness?.verdict, candidate?.canonicalVerdict, candidate?.canonicalReadiness?.verdict, overview?.canonicalVerdict, overview?.canonicalReadiness?.verdict),
    reasonCode: firstValue(source.reasonCode, source.reason_code, source.blockedReasonCode, source.blocked_reason_code, source.canonicalReadiness?.reasonCode, source.entryContract?.readiness?.reasonCode, candidate?.reasonCode, candidate?.blockedReasonCode, candidate?.canonicalReadiness?.reasonCode, overview?.reasonCode, overview?.canonicalReadiness?.reasonCode, overview?.latestDiagnosticResult, overview?.mainBlocker),
    blocked: firstBoolean(source.blocked, source.isBlocked, source.runtimeBlocked, source.paperBlocked, source.riskBlocked, source.blockedByRisk, overview?.blocked, statusSource?.blocked),
    blockedReason: firstValue(source.blockedReason, source.blocked_reason, source.paperBlockedReason, source.runtimeBlockedReason, source.riskSnapshot?.blockedReason, source.reasonCode, candidate?.blockedReason, candidate?.blockReason, candidate?.reasonCode, overview?.reasonCode, overview?.mainBlocker),
    direction: firstValue(source.direction, source.positionDirection, candidate?.direction, intent?.direction, source.side),
    symbol: firstValue(source.symbol, source.localSymbol, source.root, candidate?.symbol, candidate?.futuresSymbol, candidate?.mappedFuturesSymbol, intent?.root, intent?.localSymbol),
    performance: performanceModel(source, overview, pulse),
    metadata: {
      source: firstValue(source.metadata?.source, source.source, source.executionSource, source.sourceKind, intent?.source),
      dataSource: firstValue(source.metadata?.dataSource, source.dataSource, source.data_source, source.runtimeDataSource, candidate?.dataSource),
      timeframe: firstValue(source.metadata?.timeframe, source.timeframe, source.tf, candidate?.timeframe, overview?.timeframe),
      market: firstValue(source.metadata?.market, source.market, source.marketGroup, source.market_group, overview?.market, pulse?.market),
      status: firstValue(source.metadata?.status, rawStatus, source.runtimeStatus, source.catalogStatus, overview?.status, overview?.runtimeStatus, overview?.paperExecutionStatus, statusSource?.status),
      createdAt: firstValue(source.metadata?.createdAt, source.createdAt, source.created_at, candidate?.createdAt, intent?.createdAt),
      updatedAt: firstValue(source.metadata?.updatedAt, source.updatedAt, source.updated_at, source.timestamp, candidate?.updatedAt, intent?.updatedAt),
    },
  };
}

export function strategyDisplayName(strategy = {}, fallback = '—') {
  return firstValue(strategy.strategyName, strategy.strategyId, fallback);
}

export function strategyModelKey(strategy = {}, fallback = 'strategy') {
  return firstValue(strategy.strategyId, strategy.candidateId, strategy.orderRef, fallback);
}
