'use strict';

/**
 * IB Paper Execution v1
 *
 * Strict paper-only execution layer for Interactive Brokers.
 * No live trading, no global safety flips, no credentials stored.
 */

const fs = require('fs');
const path = require('path');

const { IBApi, EventName, OrderAction, OrderType, SecType, TimeInForce, LimitOrder, StopOrder } = require('@stoqey/ib');
const interactiveBrokersPreviewService = require('./interactiveBrokersPreviewService');
const marketUniverseService = require('./marketUniverseService');

const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.resolve(process.env.IB_PAPER_EXECUTION_DATA_DIR || path.join(ROOT, 'data/ib-paper-trading'));
const TRADES_FILE = path.join(DATA_DIR, 'trades.jsonl');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const GATE_DECISIONS_FILE = path.join(DATA_DIR, 'gate-decisions.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const FEATURE_FLAG = 'IB_PAPER_EXECUTION_ENABLED';
const DEFAULT_CLIENT_ID = 1;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_DAILY_TRADES = 3;
const MAX_OPEN_TRADES = 3;
const MIN_STOP_LOSS_PCT = 0.10;
const KILL_SWITCH_LOSS_STREAK = 3;
const PAPER_PORT = 4002;

function nowIso() {
  return new Date().toISOString();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function appendJsonl(file, row) {
  ensureDataDir();
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeUpper(value) {
  return safeString(value).toUpperCase();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function todayKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

function readFeatureFlag() {
  const raw = safeLower(process.env[FEATURE_FLAG]);
  return ['true', '1', 'yes', 'on'].includes(raw);
}

function readExecutionConfig() {
  const portRaw = safeString(process.env.IB_GATEWAY_PORT);
  const clientIdRaw = safeString(process.env.IB_GATEWAY_CLIENT_ID);
  const timeoutRaw = safeString(process.env.IB_PAPER_EXECUTION_TIMEOUT_MS);
  const port = portRaw && Number.isFinite(Number(portRaw)) ? Number(portRaw) : null;
  const clientId = clientIdRaw && Number.isFinite(Number(clientIdRaw)) ? Number(clientIdRaw) : DEFAULT_CLIENT_ID;
  const timeoutMs = timeoutRaw && Number.isFinite(Number(timeoutRaw)) ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  return {
    enabled: readFeatureFlag(),
    host: safeString(process.env.IB_GATEWAY_HOST || '127.0.0.1') || '127.0.0.1',
    port,
    clientId,
    timeoutMs,
  };
}

function loadState() {
  ensureDataDir();
  const saved = readJson(STATE_FILE, {});
  return {
    killSwitch: {
      active: saved.killSwitch?.active === true,
      reason: saved.killSwitch?.reason || null,
      triggeredAt: saved.killSwitch?.triggeredAt || null,
      updatedAt: saved.killSwitch?.updatedAt || null,
    },
    lastExecution: saved.lastExecution || null,
    lastExecutionResult: saved.lastExecutionResult || null,
    lastOrderIds: Array.isArray(saved.lastOrderIds) ? saved.lastOrderIds : [],
    lastSyncAt: saved.lastSyncAt || null,
  };
}

function saveState(next) {
  writeJson(STATE_FILE, next);
}

function normalizeTradeRow(row = {}) {
  const result = safeUpper(row.result || row.status || 'OPEN');
  const openedAt = row.openedAt || row.opened_at || row.timestamp || null;
  const closedAt = row.closedAt || row.closed_at || null;
  return {
    tradeId: safeString(row.tradeId || row.orderId || row.id || row.paperTradeId || null) || null,
    symbol: safeUpper(row.symbol),
    strategyId: safeString(row.strategyId || row.strategy_id || null) || null,
    strategyName: safeString(row.strategyName || row.strategy_name || null) || null,
    direction: safeLower(row.direction),
    entryPrice: safeNumber(row.entryPrice ?? row.entry_price ?? null),
    stopLossPrice: safeNumber(row.stopLossPrice ?? row.stop_loss_price ?? row.stopLoss ?? null),
    takeProfit1: safeNumber(row.takeProfit1 ?? row.take_profit_1 ?? row.takeProfit ?? null),
    takeProfit2: safeNumber(row.takeProfit2 ?? row.take_profit_2 ?? null),
    quantity: safeNumber(row.quantity ?? 1) || 1,
    openedAt,
    closedAt,
    result,
    status: result,
    orderIds: Array.isArray(row.orderIds) ? row.orderIds : [],
    parentOrderId: safeNumber(row.parentOrderId ?? null),
    paperOnly: true,
    executionMode: 'ib_paper',
    liveTradingEnabled: false,
  };
}

function readTrades() {
  return readJsonl(TRADES_FILE).map(normalizeTradeRow);
}

function readEvents() {
  return readJsonl(EVENTS_FILE);
}

function appendTrade(row) {
  appendJsonl(TRADES_FILE, {
    ...row,
    paperOnly: true,
    executionMode: 'ib_paper',
    liveTradingEnabled: false,
    recordedAt: nowIso(),
  });
}

function appendGateDecision(row) {
  appendJsonl(GATE_DECISIONS_FILE, {
    ...row,
    paperOnly: true,
    executionMode: 'ib_paper',
    liveTradingEnabled: false,
    recordedAt: nowIso(),
  });
}

function appendEvent(row) {
  appendJsonl(EVENTS_FILE, {
    ...row,
    paperOnly: true,
    executionMode: 'ib_paper',
    liveTradingEnabled: false,
    recordedAt: nowIso(),
  });
}

function isCryptoSymbol(symbol) {
  const normalized = safeUpper(symbol);
  return normalized.endsWith('USDT');
}

function classifySymbol(symbol, fallbackGroup = null) {
  const normalized = safeUpper(symbol);
  const group = fallbackGroup
    ? safeLower(fallbackGroup)
    : safeLower(marketUniverseService.getGroupForSymbol(normalized, undefined) || '');
  return {
    symbol: normalized || null,
    marketGroup: group || null,
    isCrypto: group === 'crypto' || isCryptoSymbol(normalized),
    isEtf: group === 'etf' || group === 'leveraged_etf',
    isQqq: normalized === 'QQQ',
    isAllowedGroup: ['stocks', 'mag7', 'nasdaq100'].includes(group),
  };
}

function allowedStrategyIndex(orderPreview) {
  const allowed = Array.isArray(orderPreview?.allowedCandidates) ? orderPreview.allowedCandidates : [];
  return new Map(allowed.map((row) => [`${safeUpper(row.symbol)}:${safeString(row.strategyId)}`, row]));
}

function isPaperModeOnlyReadiness(readiness, config) {
  if (!readiness || readiness.gatewayReachable !== true) return false;
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') return false;
  if (Number(config.port) !== PAPER_PORT) return false;
  if (readiness.status !== 'reachable') return false;
  return true;
}

function buildReadinessContext(readiness, config) {
  const host = config.host || '127.0.0.1';
  const normalizedPort = Number.isFinite(Number(config.port)) ? Number(config.port) : null;
  const gatewayReachable = readiness?.gatewayReachable === true;
  const paperPortConfigured = (host === '127.0.0.1' || host === 'localhost') && Number(normalizedPort) === PAPER_PORT;
  const paperModeOnly = gatewayReachable && paperPortConfigured && ['reachable', 'verified'].includes(readiness?.status);
  const ibApiVerified = readiness?.ibApiVerified === true;
  const paperAccountVerified = readiness?.paperAccountVerified === true;
  const paperModeVerified = readiness?.paperModeVerified === true || (ibApiVerified && paperAccountVerified);
  return {
    host,
    port: normalizedPort,
    gatewayReachable,
    paperPortConfigured,
    paperModeOnly,
    paperMode: paperModeVerified ? 'paper_only' : (paperPortConfigured ? 'paper_only' : 'unknown'),
    paperModeVerified,
    ibApiVerified,
    paperAccountVerified,
    managedAccounts: Array.isArray(readiness?.managedAccounts) ? readiness.managedAccounts : [],
    managedAccountCount: Number(readiness?.managedAccountCount || 0),
    paperAccountId: readiness?.paperAccountId || null,
    sessionVerified: readiness?.sessionVerified === true || paperModeVerified,
    blockedReason: !gatewayReachable
      ? 'ib_gateway_unreachable'
      : (!paperPortConfigured ? 'not_paper_mode_or_wrong_port'
        : (!ibApiVerified ? 'ib_api_not_verified'
          : (!paperAccountVerified ? 'paper_account_not_verified' : 'read_only_session_verified'))),
    readinessStatus: readiness?.status || 'unknown',
    readinessBlockedReason: readiness?.blockedReason || null,
  };
}

function flattenValidationErrors(gates) {
  return gates.filter((g) => g.ok !== true).map((g) => g.reason || g.code || 'blocked');
}

function buildStatusFromTrades(trades, state, readiness, config, readinessContext = null) {
  const openTrades = trades.filter((row) => row.result === 'OPEN');
  const closedTrades = trades.filter((row) => row.result !== 'OPEN');
  const today = todayKey();
  const dailyTrades = trades.filter((row) => safeString(row.openedAt || '').slice(0, 10) === today);
  const closedResults = closedTrades.slice().sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')));
  const lastExecution = closedResults[0] || openTrades.slice().sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')))[0] || null;
  const lastThreeClosed = closedResults.slice(0, KILL_SWITCH_LOSS_STREAK);
  const lossStreak = lastThreeClosed.length === KILL_SWITCH_LOSS_STREAK && lastThreeClosed.every((row) => row.result === 'LOSS');
  const readinessProfile = readinessContext || buildReadinessContext(readiness, config);
  const blockers = [
    config.enabled !== true ? 'ib_paper_execution_disabled' : null,
    readinessProfile.gatewayReachable !== true ? 'ib_gateway_unreachable' : null,
    readinessProfile.paperPortConfigured !== true ? 'not_paper_mode_or_wrong_port' : null,
    readinessProfile.ibApiVerified !== true ? 'ib_api_not_verified' : null,
    readinessProfile.paperAccountVerified !== true ? 'paper_account_not_verified' : null,
    openTrades.length >= MAX_OPEN_TRADES ? 'max_open_trades' : null,
    dailyTrades.length >= MAX_DAILY_TRADES ? 'max_daily_trades' : null,
    state.killSwitch.active === true ? 'kill_switch_active' : null,
    lossStreak ? 'three_losses_in_a_row' : null,
  ].filter(Boolean);

  return {
    ok: true,
    dryRun: true,
    mode: 'paper_execution',
    executionEnabled: config.enabled === true,
    orderSendingBlocked: config.enabled !== true,
    liveTradingEnabled: false,
    can_place_orders: false,
    actions_allowed: false,
    broker_enabled: false,
    safety: { ...SAFETY },
    killSwitch: {
      active: state.killSwitch.active === true || lossStreak,
      reason: state.killSwitch.reason || (lossStreak ? 'three_losses_in_a_row' : null),
      triggeredAt: state.killSwitch.triggeredAt || null,
    },
    dailyQuota: {
      used: dailyTrades.length,
      max: MAX_DAILY_TRADES,
      remaining: Math.max(0, MAX_DAILY_TRADES - dailyTrades.length),
    },
    openTrades: openTrades.map((row) => ({ ...row, paperOnly: true })),
    openTradeCount: openTrades.length,
    closedTrades: closedTrades.map((row) => ({ ...row, paperOnly: true })),
    closedTradeCount: closedTrades.length,
    lastExecutionResult: lastExecution
      ? {
          tradeId: lastExecution.tradeId,
          symbol: lastExecution.symbol,
          strategyId: lastExecution.strategyId,
          strategyName: lastExecution.strategyName,
          result: lastExecution.result,
          status: lastExecution.result,
          openedAt: lastExecution.openedAt,
          closedAt: lastExecution.closedAt || null,
          entryPrice: lastExecution.entryPrice,
          stopLossPrice: lastExecution.stopLossPrice,
          takeProfit1: lastExecution.takeProfit1,
          takeProfit2: lastExecution.takeProfit2,
          orderIds: lastExecution.orderIds || [],
        }
      : null,
    blockers,
    blockedReason: blockers[0] || null,
    readinessProfile,
    note: 'IB Paper Execution v1 is paper-only. No live trading and no credentials are stored.',
    dataFiles: {
      trades: TRADES_FILE,
      events: EVENTS_FILE,
      gateDecisions: GATE_DECISIONS_FILE,
    },
    updatedAt: nowIso(),
  };
}

function calculateLossStreak(trades) {
  const closed = trades
    .filter((row) => row.result && row.result !== 'OPEN')
    .sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')));
  const recent = closed.slice(0, KILL_SWITCH_LOSS_STREAK);
  return recent.length === KILL_SWITCH_LOSS_STREAK && recent.every((row) => row.result === 'LOSS');
}

function buildCandidatePayload(input = {}) {
  const source = input.blueprint || input.candidate || input.order || input;
  const symbol = safeUpper(source.symbol);
  const strategyId = safeString(source.strategyId || source.strategy_id || null);
  const strategyName = safeString(source.strategyName || source.strategy_name || strategyId || null);
  const direction = safeLower(source.direction);
  const entryPrice = safeNumber(source.entryPrice ?? source.currentPrice ?? source.price ?? null);
  const stopLossPrice = safeNumber(source.stopLossPrice ?? source.stop_loss_price ?? null);
  const takeProfit1 = safeNumber(source.takeProfit1 ?? source.take_profit_1 ?? source.takeProfit ?? null);
  const takeProfit2 = safeNumber(source.takeProfit2 ?? source.take_profit_2 ?? null);
  const quantity = Math.max(1, Math.round(Number(source.quantity || input.quantity || 1) || 1));
  const marketGroup = safeString(source.marketGroup || source.market_group || source.group || null) || null;
  const classified = classifySymbol(symbol, marketGroup);
  const stopLossDistancePct = entryPrice && stopLossPrice
    ? Math.abs((entryPrice - stopLossPrice) / entryPrice) * 100
    : null;
  const action = direction === 'short' ? 'SELL' : direction === 'long' ? 'BUY' : null;
  const exitAction = direction === 'short' ? 'BUY' : direction === 'long' ? 'SELL' : null;

  return {
    symbol,
    strategyId,
    strategyName,
    direction,
    entryPrice,
    stopLossPrice,
    takeProfit1,
    takeProfit2,
    quantity,
    marketGroup: classified.marketGroup,
    isCrypto: classified.isCrypto,
    isEtf: classified.isEtf,
    isQqq: classified.isQqq,
    isAllowedGroup: classified.isAllowedGroup,
    stopLossDistancePct: stopLossDistancePct == null ? null : round(stopLossDistancePct, 4),
    action,
    exitAction,
    confirmationText: safeString(input.confirmationText || input.confirmText || ''),
  };
}

function getDataPaths() {
  return {
    dataDir: DATA_DIR,
    trades: TRADES_FILE,
    events: EVENTS_FILE,
    gateDecisions: GATE_DECISIONS_FILE,
    state: STATE_FILE,
  };
}

function buildContract(symbol) {
  return {
    symbol,
    exchange: 'SMART',
    currency: 'USD',
    secType: SecType.STK,
  };
}

function buildBracketOrders(candidate, orderId) {
  const parentOrder = new LimitOrder(candidate.action, candidate.entryPrice, candidate.quantity, false);
  parentOrder.orderType = OrderType.LMT;
  parentOrder.orderId = orderId;
  parentOrder.tif = TimeInForce.DAY;
  parentOrder.transmit = false;
  parentOrder.outsideRth = false;
  parentOrder.orderRef = `IBPAPER:${candidate.strategyId || candidate.symbol}`;

  const takeProfitOrder = new LimitOrder(candidate.exitAction, candidate.takeProfit1, candidate.quantity, false);
  takeProfitOrder.orderType = OrderType.LMT;
  takeProfitOrder.orderId = orderId + 1;
  takeProfitOrder.parentId = orderId;
  takeProfitOrder.ocaGroup = `IBPAPER_${orderId}`;
  takeProfitOrder.ocaType = 1;
  takeProfitOrder.tif = TimeInForce.DAY;
  takeProfitOrder.transmit = false;
  takeProfitOrder.orderRef = `IBPAPER:${candidate.strategyId || candidate.symbol}:TP`;

  const stopLossOrder = new StopOrder(candidate.exitAction, candidate.stopLossPrice, candidate.quantity, true, orderId, TimeInForce.DAY);
  stopLossOrder.orderType = OrderType.STP;
  stopLossOrder.orderId = orderId + 2;
  stopLossOrder.parentId = orderId;
  stopLossOrder.ocaGroup = `IBPAPER_${orderId}`;
  stopLossOrder.ocaType = 1;
  stopLossOrder.tif = TimeInForce.DAY;
  stopLossOrder.transmit = true;
  stopLossOrder.orderRef = `IBPAPER:${candidate.strategyId || candidate.symbol}:SL`;

  return { parentOrder, takeProfitOrder, stopLossOrder };
}

function createIbClient(config) {
  return new IBApi({
    host: config.host,
    port: config.port,
    maxReqPerSec: 10,
  });
}

async function connectAndGetNextOrderId(config, options = {}) {
  const client = options.client || createIbClient(config);
  const timeoutMs = options.timeoutMs || config.timeoutMs || DEFAULT_TIMEOUT_MS;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { client.disconnect(); } catch (_) {}
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`ib_connect_timeout_after_${timeoutMs}ms`)), timeoutMs);
    const onError = (error, code) => {
      const message = error?.message || `IB error ${code || 'unknown'}`;
      finish(new Error(message));
    };

    client.once(EventName.nextValidId, (orderId) => {
      clearTimeout(timer);
      client.removeListener(EventName.error, onError);
      finish(null, Number(orderId));
    });
    client.once(EventName.connected, () => {
      try { client.reqIds(1); } catch (err) { finish(err); }
    });
    client.on(EventName.error, onError);
    try {
      client.connect(config.clientId);
    } catch (err) {
      clearTimeout(timer);
      finish(err);
    }
  });
}

async function submitPaperOrder(candidate, options = {}) {
  const config = readExecutionConfig();
  const readiness = options.readiness || await interactiveBrokersPreviewService.getConnectionReadiness();
  const readinessProfile = options.readinessProfile || buildReadinessContext(readiness, config);
  const state = options.loadState ? options.loadState() : loadState();
  const currentTrades = options.readTrades ? options.readTrades() : readTrades();
  const orderPreview = options.orderPreview || interactiveBrokersPreviewService.getIbPaperOrderPreview();
  const allowedIndex = allowedStrategyIndex(orderPreview);
  const validation = buildCandidatePayload({
    ...candidate,
    confirmationText: options.confirmationText || candidate?.confirmationText || candidate?.confirmText || '',
  });
  const gates = [];
  const marketKey = `${validation.symbol}:${validation.strategyId}`;
  const allowed = allowedIndex.get(marketKey) || allowedIndex.get(`${validation.symbol}:${validation.strategyId}`);
  const approvedStrategy = Boolean(allowed);
  const clearDirection = validation.direction === 'long' || validation.direction === 'short';
  const stopPct = validation.stopLossDistancePct;
  const todayCount = currentTrades.filter((row) => safeString(row.openedAt || '').slice(0, 10) === todayKey()).length;
  const openTrades = currentTrades.filter((row) => row.result === 'OPEN');
  const sameStrategyOpen = openTrades.some((row) => row.strategyId === validation.strategyId);
  const lossStreak = calculateLossStreak(currentTrades);
  const paperModeOnly = readinessProfile.paperModeOnly === true;
  const featureEnabled = config.enabled === true;

  gates.push({ gate: 'feature_flag', ok: featureEnabled, reason: featureEnabled ? null : 'ib_paper_execution_disabled' });
  gates.push({ gate: 'gateway_reachable', ok: readinessProfile.gatewayReachable === true, reason: readinessProfile.gatewayReachable === true ? null : 'ib_gateway_unreachable' });
  gates.push({ gate: 'paper_mode_only', ok: paperModeOnly, reason: paperModeOnly ? null : 'not_paper_mode_or_wrong_port' });
  gates.push({ gate: 'approved_strategy', ok: approvedStrategy, reason: approvedStrategy ? null : 'strategy_not_approved_or_not_allowed' });
  gates.push({ gate: 'symbol_allowed', ok: !validation.isCrypto && !validation.isEtf && !validation.isQqq && validation.isAllowedGroup, reason: (!validation.isCrypto && !validation.isEtf && !validation.isQqq && validation.isAllowedGroup) ? null : 'symbol_not_allowed' });
  gates.push({ gate: 'clear_direction', ok: clearDirection, reason: clearDirection ? null : 'direction_not_clear' });
  gates.push({ gate: 'stop_loss_exists', ok: validation.stopLossPrice != null, reason: validation.stopLossPrice != null ? null : 'missing_stop_loss' });
  gates.push({ gate: 'stop_loss_min_pct', ok: Number.isFinite(stopPct) && stopPct >= MIN_STOP_LOSS_PCT, reason: Number.isFinite(stopPct) && stopPct >= MIN_STOP_LOSS_PCT ? null : 'stop_loss_below_minimum' });
  gates.push({ gate: 'take_profit_exists', ok: validation.takeProfit1 != null, reason: validation.takeProfit1 != null ? null : 'missing_take_profit' });
  gates.push({ gate: 'daily_quota', ok: todayCount < MAX_DAILY_TRADES, reason: todayCount < MAX_DAILY_TRADES ? null : 'max_3_trades_per_day_reached' });
  gates.push({ gate: 'open_trades', ok: openTrades.length < MAX_OPEN_TRADES, reason: openTrades.length < MAX_OPEN_TRADES ? null : 'max_open_trades_reached' });
  gates.push({ gate: 'strategy_singleton', ok: !sameStrategyOpen, reason: !sameStrategyOpen ? null : 'one_trade_per_strategy_active' });
  gates.push({ gate: 'kill_switch', ok: !state.killSwitch.active && !lossStreak, reason: (!state.killSwitch.active && !lossStreak) ? null : 'kill_switch_active' });
  gates.push({ gate: 'confirmation', ok: validation.confirmationText === 'CONFIRM PAPER TRADE', reason: validation.confirmationText === 'CONFIRM PAPER TRADE' ? null : 'missing_manual_confirmation' });
  gates.push({ gate: 'bracket_supported', ok: true, reason: null });

  const blockers = flattenValidationErrors(gates);
  const blockedReason = blockers[0] || null;

  const gateDecision = {
    timestamp: nowIso(),
    symbol: validation.symbol,
    strategyId: validation.strategyId,
    strategyName: validation.strategyName,
    direction: validation.direction,
    entryPrice: validation.entryPrice,
    stopLossPrice: validation.stopLossPrice,
    stopLossDistancePct: validation.stopLossDistancePct,
    takeProfit1: validation.takeProfit1,
    takeProfit2: validation.takeProfit2,
    quantity: validation.quantity,
    gates,
    blockers,
    blockedReason,
    executionEnabled: featureEnabled,
    orderSendingBlocked: !featureEnabled || blockers.length > 0,
    liveTradingEnabled: false,
    can_place_orders: false,
    actions_allowed: false,
    broker_enabled: false,
    mode: 'paper_only',
  };
  appendGateDecision(gateDecision);

  if (!featureEnabled || blockers.length > 0) {
    appendEvent({
      type: 'paper_execution_blocked',
      symbol: validation.symbol,
      strategyId: validation.strategyId,
      strategyName: validation.strategyName,
      direction: validation.direction,
      reason: blockedReason,
      blockers,
      executionEnabled: featureEnabled,
    });
    saveState({
      ...state,
      lastSyncAt: nowIso(),
      lastExecutionResult: {
        status: 'BLOCKED',
        blockedReason,
        blockers,
        timestamp: nowIso(),
        executionEnabled: featureEnabled,
      },
    });
    return {
      ok: false,
      dryRun: false,
      mode: 'paper_execution',
      executionEnabled: featureEnabled,
      orderSendingBlocked: true,
      liveTradingEnabled: false,
      can_place_orders: false,
      actions_allowed: false,
      broker_enabled: false,
      safety: { ...SAFETY },
      blockedReason: featureEnabled ? blockedReason : 'ib_paper_execution_disabled',
      blockers,
      gateDecision,
      submitted: false,
      orderType: 'LMT',
      bracketSupported: true,
    };
  }

  if (!options.skipBroker) {
    const client = options.client || createIbClient(config);
    const parentOrderId = await connectAndGetNextOrderId(config, { client, timeoutMs: config.timeoutMs });
    const { parentOrder, takeProfitOrder, stopLossOrder } = buildBracketOrders(validation, parentOrderId);
    const contract = buildContract(validation.symbol);

    const submitResult = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        try { client.disconnect(); } catch (_) {}
        if (err) reject(err);
        else resolve(value);
      };

      const timer = setTimeout(() => finish(new Error(`ib_placeorder_timeout_after_${config.timeoutMs}ms`)), config.timeoutMs);
      const onError = (error, code) => {
        const message = error?.message || `IB error ${code || 'unknown'}`;
        clearTimeout(timer);
        finish(new Error(message));
      };
      const onOrderStatus = (orderId, status, filled, remaining, avgFillPrice) => {
        if (![parentOrderId, parentOrderId + 1, parentOrderId + 2].includes(Number(orderId))) return;
        const statusRow = {
          orderId,
          status: String(status || ''),
          filled,
          remaining,
          avgFillPrice,
          timestamp: nowIso(),
        };
        appendEvent({ type: 'order_status', symbol: validation.symbol, strategyId: validation.strategyId, ...statusRow });
      };

      client.on(EventName.error, onError);
      client.on(EventName.orderStatus, onOrderStatus);
      try {
        client.once(EventName.connected, () => {
          try {
            client.placeOrder(parentOrderId, contract, parentOrder);
            client.placeOrder(parentOrderId + 1, contract, takeProfitOrder);
            client.placeOrder(parentOrderId + 2, contract, stopLossOrder);
            clearTimeout(timer);
            appendEvent({
              type: 'paper_execution_submitted',
              symbol: validation.symbol,
              strategyId: validation.strategyId,
              strategyName: validation.strategyName,
              direction: validation.direction,
              orderIds: [parentOrderId, parentOrderId + 1, parentOrderId + 2],
              orderType: 'LMT_BRACKET',
              contract,
            });
            finish(null, {
              parentOrderId,
              orderIds: [parentOrderId, parentOrderId + 1, parentOrderId + 2],
            });
          } catch (err) {
            clearTimeout(timer);
            finish(err);
          }
        });
        client.connect(config.clientId);
      } catch (err) {
        clearTimeout(timer);
        finish(err);
      }
    });

    const submittedAt = nowIso();
    const tradeRecord = {
      tradeId: `ibp_${Date.now()}`,
      symbol: validation.symbol,
      strategyId: validation.strategyId,
      strategyName: validation.strategyName,
      direction: validation.direction,
      entryPrice: validation.entryPrice,
      stopLossPrice: validation.stopLossPrice,
      takeProfit1: validation.takeProfit1,
      takeProfit2: validation.takeProfit2,
      quantity: validation.quantity,
      parentOrderId: submitResult.parentOrderId,
      orderIds: submitResult.orderIds,
      result: 'OPEN',
      status: 'OPEN',
      openedAt: submittedAt,
      closedAt: null,
      stopLossDistancePct: validation.stopLossDistancePct,
      orderType: 'LMT',
      bracketSupported: true,
      executionEnabled: true,
      orderSendingBlocked: false,
      liveTradingEnabled: false,
      paperOnly: true,
      mode: 'paper_only',
    };
    appendTrade(tradeRecord);
    saveState({
      ...state,
      lastExecution: tradeRecord,
      lastExecutionResult: {
        status: 'SUBMITTED',
        timestamp: submittedAt,
        tradeId: tradeRecord.tradeId,
        orderIds: submitResult.orderIds,
        symbol: tradeRecord.symbol,
        strategyId: tradeRecord.strategyId,
        strategyName: tradeRecord.strategyName,
      },
      lastOrderIds: submitResult.orderIds,
      lastSyncAt: submittedAt,
    });

    return {
      ok: true,
      dryRun: false,
      mode: 'paper_execution',
      executionEnabled: true,
      orderSendingBlocked: false,
      liveTradingEnabled: false,
      can_place_orders: false,
      actions_allowed: false,
      broker_enabled: false,
      safety: { ...SAFETY },
      blockedReason: null,
      blockers: [],
      gateDecision,
      submitted: true,
      orderType: 'LMT',
      bracketSupported: true,
      trade: tradeRecord,
      orderIds: submitResult.orderIds,
      parentOrderId: submitResult.parentOrderId,
      dataFiles: { trades: TRADES_FILE, events: EVENTS_FILE, gateDecisions: GATE_DECISIONS_FILE },
    };
  }

  return {
    ok: true,
    dryRun: false,
    mode: 'paper_execution',
    executionEnabled: true,
    orderSendingBlocked: true,
    liveTradingEnabled: false,
    can_place_orders: false,
    actions_allowed: false,
    broker_enabled: false,
    safety: { ...SAFETY },
    blockedReason: null,
    blockers: [],
    gateDecision,
    submitted: false,
    orderType: 'LMT',
    bracketSupported: true,
    note: 'skipBroker=true used for tests or dry-run verification.',
  };
}

async function getExecutionStatus(options = {}) {
  const config = readExecutionConfig();
  const readiness = options.readiness || await interactiveBrokersPreviewService.getConnectionReadiness();
  const readinessProfile = options.readinessProfile || buildReadinessContext(readiness, config);
  const state = options.loadState ? options.loadState() : loadState();
  const trades = options.readTrades ? options.readTrades() : readTrades();
  const result = buildStatusFromTrades(trades, state, readiness, config, readinessProfile);
  result.executionEnabled = config.enabled === true;
  result.orderSendingBlocked = config.enabled !== true || result.blockers.length > 0;
  result.liveTradingEnabled = false;
  result.can_place_orders = false;
  result.actions_allowed = false;
  result.broker_enabled = false;
  result.gatewayReachable = readinessProfile.gatewayReachable === true;
  result.ibApiVerified = readinessProfile.ibApiVerified === true;
  result.paperAccountVerified = readinessProfile.paperAccountVerified === true;
  result.readinessProfile = readinessProfile;
  result.featureFlag = FEATURE_FLAG;
  result.config = {
    host: config.host,
    port: config.port,
    clientId: config.clientId,
    timeoutMs: config.timeoutMs,
    enabled: config.enabled,
  };
  result.readiness = readiness;
  result.state = state;
  return result;
}

module.exports = {
  SAFETY,
  FEATURE_FLAG,
  MAX_DAILY_TRADES,
  MAX_OPEN_TRADES,
  MIN_STOP_LOSS_PCT,
  KILL_SWITCH_LOSS_STREAK,
  readExecutionConfig,
  getExecutionStatus,
  submitPaperOrder,
  buildCandidatePayload,
  buildContract,
  buildBracketOrders,
  calculateLossStreak,
  isPaperModeOnlyReadiness,
  buildReadinessContext,
  readTrades,
  readEvents,
  loadState,
  getDataPaths,
  _internal: {
    ensureDataDir,
    readJson,
    writeJson,
    appendJsonl,
    readJsonl,
    safeString,
    safeUpper,
    safeLower,
    safeNumber,
    round,
    todayKey,
    classifySymbol,
    allowedStrategyIndex,
    buildStatusFromTrades,
    flattenValidationErrors,
    createIbClient,
    connectAndGetNextOrderId,
  },
};
