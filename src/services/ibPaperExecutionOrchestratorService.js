'use strict';

const crypto = require('crypto');

const configService = require('./ibPaperExecutionConfigService');
const adapterModule = require('./ibPaperExecutionAdapterService');
const intentServiceModule = require('./ibPaperExecutionIntentService');
const guardService = require('./ibPaperExecutionGuardService');
const brokerRiskService = require('./ibPaperBrokerRiskService');
const reconciliationModule = require('./ibPaperBrokerReconciliationService');
const futuresMarketDataService = require('./futuresMarketDataService');
const futuresPaperQuoteSourceService = require('./futuresPaperQuoteSourceService');
const futuresPaperScannerService = require('./futuresPaperScannerService');
const futuresPaperStrategyApprovalService = require('./futuresPaperStrategyApprovalService');
const ibPaperAccountSummaryService = require('./ibPaperAccountSummaryService');
const futuresMarketHoursService = require('./futuresMarketHoursService');

const SAFETY = Object.freeze({
  mode: 'ibkr_paper',
  environment: 'paper',
  paperOnly: true,
  live_trading_enabled: false,
  live_broker_enabled: false,
  live_order_submission_enabled: false,
  live_account_orders_allowed: false,
  source: 'ib_paper_execution_orchestrator',
});

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function safeUpper(value) {
  return safeString(value).toUpperCase();
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sideFromCandidate(candidate = {}) {
  const raw = safeString(candidate.direction || candidate.side || candidate.entrySide || candidate.action).toLowerCase();
  if (['long', 'buy', 'bull', 'bullish', 'up'].includes(raw)) return 'long';
  if (['short', 'sell', 'bear', 'bearish', 'down'].includes(raw)) return 'short';
  return null;
}

function candidateTimestamp(candidate = {}) {
  return candidate.signalTimestamp
    || candidate.timestamp
    || candidate.createdAt
    || candidate.candidateTimestamp
    || null;
}

function ageMsFromTimestamp(ts, now = new Date()) {
  const parsed = Date.parse(ts || '');
  const current = new Date(now).getTime();
  if (!Number.isFinite(parsed) || !Number.isFinite(current)) return null;
  return Math.max(0, current - parsed);
}

function buildExecutionId(seed) {
  return `fxp_${crypto.createHash('sha256').update(String(seed || `${Date.now()}:${Math.random()}`)).digest('hex').slice(0, 16)}`;
}

function normalizeCandidate(input = {}) {
  const candidate = input && typeof input === 'object' ? input : {};
  const root = safeUpper(candidate.root || candidate.symbol || candidate.instrument);
  const strategyId = safeString(candidate.strategyId || candidate.strategy_id || candidate.canonicalStrategyId);
  const direction = sideFromCandidate(candidate);
  const signalTimestamp = candidateTimestamp(candidate);
  const quantity = Math.max(1, Number(candidate.quantity || candidate.contracts || 1) || 1);
  return {
    ...candidate,
    root,
    symbol: root,
    strategyId,
    direction,
    signalTimestamp,
    quantity,
    orderType: safeUpper(candidate.orderType || candidate.entryOrderType || 'MKT'),
    limitPrice: safeNumber(candidate.limitPrice ?? candidate.entryLimitPrice),
    stopLossPrice: safeNumber(candidate.stopLossPrice ?? candidate.stopLoss ?? candidate.stop),
    takeProfitPrice: safeNumber(candidate.takeProfitPrice ?? candidate.takeProfit ?? candidate.takeProfit1),
  };
}

function sanitizeOrderPlan(orderPlan, accountMasked = null) {
  if (!orderPlan) return null;
  return {
    environment: orderPlan.environment,
    contract: orderPlan.contract,
    entry: orderPlan.entry,
    stopLoss: orderPlan.stopLoss,
    takeProfit: orderPlan.takeProfit,
    ocaGroup: orderPlan.ocaGroup,
    transmitSequence: orderPlan.transmitSequence,
    protectiveModel: orderPlan.protectiveModel,
    accountMasked,
    paperOnly: true,
  };
}

function createIbPaperExecutionOrchestratorService(options = {}) {
  const adapter = options.adapter || adapterModule.defaultIbPaperExecutionAdapterService;
  const intentService = options.intentService || intentServiceModule.defaultIbPaperExecutionIntentService;
  const marketData = options.marketDataService || futuresMarketDataService.defaultFuturesMarketDataService;
  const quoteSource = options.quoteSourceService || futuresPaperQuoteSourceService.defaultFuturesPaperQuoteSourceService;
  const scanner = options.scannerService || futuresPaperScannerService.defaultFuturesPaperScannerService;
  const accountSummaryService = options.accountSummaryService || ibPaperAccountSummaryService.defaultIbPaperAccountSummaryService;
  const reconciliation = options.reconciliationService
    || reconciliationModule.createIbPaperBrokerReconciliationService({ adapter, intentService });

  function selectCandidate(candidateInput = null) {
    if (candidateInput && typeof candidateInput === 'object') {
      return { candidate: normalizeCandidate(candidateInput), source: 'request_candidate' };
    }
    const queue = scanner.getCandidates();
    const candidate = Array.isArray(queue.candidates) ? queue.candidates[0] : null;
    return candidate
      ? { candidate: normalizeCandidate(candidate), source: 'futures_candidate_queue' }
      : { candidate: null, source: 'none' };
  }

  async function resolveContract(root) {
    if (!root) return { ok: false, error: 'root_missing' };
    if (!marketData.isEnabled()) return { ok: false, error: 'ib_futures_data_disabled' };
    return marketData.adapter.resolveContract(root);
  }

  async function buildExecutionStatus({ connect = false } = {}) {
    const flags = configService.getFlags();
    let connectionAttempt = null;
    if (connect && flags.executionEnabled) {
      connectionAttempt = await adapter.connectPaperExecutionClient();
    }
    const adapterStatus = adapter.getStatus();
    const accountSummary = await accountSummaryService.getSummary({ maxAgeMs: configService.getPilotLimits().maxAccountSummaryAgeMs }).catch((err) => ({ ok: false, blocker: err.message }));
    const verification = adapter.verifyPaperAccount(accountSummary?.account?.accountIdMasked || null);
    const rec = adapterStatus.connected ? await reconciliation.reconcilePaperBroker({ force: false }) : reconciliation.getCachedReconciliation();
    const safety = configService.buildSafetyView();
    return {
      ok: true,
      generatedAt: nowIso(),
      status: !flags.executionEnabled ? 'disabled' : (flags.shadowMode ? 'shadow' : (flags.submissionEnabled ? 'pilot' : 'paused')),
      flags,
      safety: {
        ...safety,
        verifiedPaperAccount: verification.ok === true && accountSummary?.ok === true,
        liveAccountBlocked: verification.live_account_detected !== true,
      },
      clientIds: configService.getExecutionClientConfig(),
      executionClient: adapterStatus,
      account: {
        ok: accountSummary?.ok === true,
        blocker: accountSummary?.blocker || verification.blocker || null,
        accountIdMasked: accountSummary?.account?.accountIdMasked || verification.accountIdMasked || null,
        classification: accountSummary?.account?.classification || verification.classification || null,
        currency: accountSummary?.account?.currency || null,
        netLiquidation: accountSummary?.account?.netLiquidation ?? null,
        realizedPnl: accountSummary?.account?.realizedPnl ?? null,
        unrealizedPnl: accountSummary?.account?.unrealizedPnl ?? null,
        cacheAgeMs: accountSummary?.cacheAgeMs ?? null,
      },
      paperAccountVerified: verification.ok === true && accountSummary?.ok === true,
      verifiedPaperAccount: verification.ok === true && accountSummary?.ok === true,
      liveAccountBlocked: verification.live_account_detected !== true,
      liveAccountDetected: verification.live_account_detected === true,
      orderSubmissionMode: flags.orderSubmissionMode,
      paperBrokerExecutionEnabled: flags.executionEnabled,
      liveBrokerExecutionEnabled: false,
      reconciliation: {
        status: rec.status,
        degraded: rec.degraded === true,
        blockedReason: rec.blockedReason || null,
        counts: rec.counts || {},
        discrepancies: rec.discrepancies || [],
      },
      killSwitch: configService.readKillSwitch(),
      connectionAttempt,
      ...SAFETY,
    };
  }

  async function buildShadowExecution({ candidate: candidateInput = null, now = new Date(), actualSubmit = false } = {}) {
    const flags = configService.getFlags();
    const selected = selectCandidate(candidateInput);
    if (!selected.candidate) {
      return {
        ok: true,
        status: 'READY_WAITING_FOR_SIGNAL',
        wouldSubmit: false,
        actualSubmit: false,
        blockedReason: 'no_strategy_candidate',
        message: 'Ingen legitim futures-kandidat finns i kön. Ingen falsk signal skapas.',
        orderSubmissionMode: flags.orderSubmissionMode,
        ...SAFETY,
      };
    }

    const candidate = selected.candidate;
    const limits = configService.getPilotLimits();
    const signalTimestamp = candidate.signalTimestamp || nowIso(now);
    const ageMs = ageMsFromTimestamp(signalTimestamp, now);
    const status = await buildExecutionStatus({ connect: flags.executionEnabled });
    const contractResult = await resolveContract(candidate.root);
    const quote = quoteSource.getQuote(candidate.root, now);
    const contract = contractResult.ok ? contractResult.contract : {
      root: candidate.root,
      conId: quote?.conId || null,
      localSymbol: quote?.localSymbol || null,
      expiry: quote?.expiry || null,
      exchange: quote?.exchange || 'CME',
      currency: quote?.currency || 'USD',
      secType: 'FUT',
    };
    const adapterVerification = adapter.verifyPaperAccount(status.account.accountIdMasked || null);
    const accountMasked = status.account.accountIdMasked || adapterVerification.accountIdMasked || null;
    const idempotencyKey = intentService.buildIdempotencyKey({
      strategyId: candidate.strategyId,
      root: candidate.root,
      conId: contract.conId,
      direction: candidate.direction,
      candidateId: candidate.candidateId,
      signalTimestamp,
      accountIdMasked: accountMasked,
      environment: 'paper',
    });
    const executionId = buildExecutionId(idempotencyKey || `${candidate.strategyId}:${candidate.candidateId}:${signalTimestamp}`);
    const duplicate = idempotencyKey ? intentService.getIntent(idempotencyKey) : null;
    const approval = candidate.approval || candidate.approvalEvidence || futuresPaperStrategyApprovalService.evaluateFuturesApprovalGate({ strategyId: candidate.strategyId });
    const entryContract = candidate.entryContract || candidate.paperEntryContract || candidate.approvalEvidence || null;
    const rec = status.reconciliation?.degraded === true
      ? status.reconciliation
      : reconciliation.getCachedReconciliation();
    const brokerRisk = brokerRiskService.evaluateBrokerRisk({
      root: candidate.root,
      quantity: candidate.quantity,
      orderType: candidate.orderType,
      stopLossPrice: candidate.stopLossPrice,
      quote,
      openOrders: rec.openOrders || [],
      positions: rec.positions || [],
      accountSummary: status.account,
      reconciliation: rec,
      now,
    });
    const intent = {
      executionId,
      idempotencyKey,
      environment: 'paper',
      executionTarget: 'ibkr_paper',
      strategyId: candidate.strategyId,
      candidateId: candidate.candidateId || null,
      root: candidate.root,
      direction: candidate.direction,
      quantity: candidate.quantity,
      orderType: candidate.orderType,
      signalTimestamp,
      ageMs,
      maxSubmitAgeMs: limits.maxIntentAgeMs,
      paperAccountIdMasked: accountMasked,
      source: selected.source,
    };
    const guard = guardService.evaluatePaperExecutionGuard({
      intent,
      candidate,
      contract,
      quote,
      accountSummary: {
        ok: status.account.ok,
        account: {
          accountIdMasked: status.account.accountIdMasked,
          classification: status.account.classification,
        },
      },
      adapterStatus: status.executionClient,
      adapterVerification,
      brokerRisk,
      reconciliation: rec,
      approval,
      entryContract,
      idempotency: { duplicate: Boolean(duplicate), existing: duplicate },
      session: futuresMarketHoursService.getCmeEquityIndexFuturesSessionState(now),
      now,
    });

    const intentCreate = guard.allowed && idempotencyKey
      ? intentService.createIntent({
        idempotencyKey,
        executionId,
        intent: {
          ...intent,
          conId: contract.conId,
          executionTarget: 'ibkr_paper',
        },
      })
      : { created: false, skipped: true };
    const orderPlan = adapter.buildOrderPlan({
      executionId,
      contract,
      side: candidate.direction,
      quantity: candidate.quantity,
      entryType: candidate.orderType,
      limitPrice: candidate.limitPrice,
      stopLossPrice: candidate.stopLossPrice,
      takeProfitPrice: candidate.takeProfitPrice,
      tif: candidate.tif || 'GTC',
      outsideRth: candidate.outsideRth !== false,
    });
    const normalizedOrder = {
      internalExecutionId: executionId,
      idempotencyKey,
      candidateId: candidate.candidateId || null,
      strategyId: candidate.strategyId,
      root: candidate.root,
      localSymbol: contract.localSymbol || null,
      conId: contract.conId || null,
      expiry: contract.expiry || null,
      accountMasked,
      action: orderPlan.entry.action,
      quantity: candidate.quantity,
      orderType: orderPlan.entry.orderType,
      limitPrice: orderPlan.entry.lmtPrice ?? null,
      stopPrice: orderPlan.stopLoss.auxPrice ?? null,
      takeProfitPrice: orderPlan.takeProfit?.lmtPrice ?? null,
      parentId: null,
      ocaGroup: orderPlan.ocaGroup,
      tif: orderPlan.entry.tif,
      outsideRth: orderPlan.entry.outsideRth,
      transmit: orderPlan.entry.transmit,
      createdAt: nowIso(now),
      maxSubmitAge: limits.maxIntentAgeMs,
      riskSnapshot: brokerRisk,
      source: selected.source,
      paperOnly: true,
      orderRef: adapter.buildOrderRef(executionId, 'entry'),
      executionTarget: 'ibkr_paper',
      wouldSubmit: guard.allowed === true,
      actualSubmit: false,
    };

    if (intentCreate.created) {
      intentService.updateStatus(idempotencyKey, flags.shadowMode || !actualSubmit ? 'shadow_logged' : 'guard_passed', {
        orderRef: normalizedOrder.orderRef,
      });
    }

    let submitResult = null;
    if (actualSubmit === true) {
      submitResult = await adapter.submitPaperOrder({
        guardDecision: guard,
        intentRecord: intentCreate.record,
        orderPlan,
        verifiedAccount: adapterVerification,
      });
      if (submitResult?.submitted && idempotencyKey) {
        intentService.updateStatus(idempotencyKey, 'submitted', {
          ibOrderId: submitResult.parentOrderId,
          orderRef: normalizedOrder.orderRef,
        });
      } else if (idempotencyKey && submitResult?.blocker) {
        intentService.updateStatus(idempotencyKey, 'reconciliation_required', { blocker: submitResult.blocker });
      }
    }

    return {
      ok: true,
      status: guard.allowed ? 'shadow_ready' : 'blocked',
      wouldSubmit: guard.allowed === true,
      actualSubmit: submitResult?.submitted === true,
      blockedReason: guard.blockedReason || null,
      blockers: guard.blockers,
      candidate,
      contract,
      quote,
      accountMasked,
      approval,
      entryContract,
      brokerRisk,
      guard,
      intent: intentCreate.record || intent,
      intentCreate,
      normalizedOrder,
      orderPlan: sanitizeOrderPlan(orderPlan, accountMasked),
      submitResult,
      orderSubmissionMode: flags.orderSubmissionMode,
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    selectCandidate,
    buildExecutionStatus,
    buildShadowExecution,
    reconciliation,
  };
}

const defaultIbPaperExecutionOrchestratorService = createIbPaperExecutionOrchestratorService();

module.exports = {
  SAFETY,
  normalizeCandidate,
  createIbPaperExecutionOrchestratorService,
  defaultIbPaperExecutionOrchestratorService,
};
