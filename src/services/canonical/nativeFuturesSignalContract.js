'use strict';

// Native Futures Signal Contract
//
// Phase 1 only: define and validate the production input shape for native
// futures signals. This module has no side effects and is intentionally not
// wired into scanner, provider, execution, broker, ledger, or UI yet.

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'native_futures_signal_contract',
});

const NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION = 'native-futures-signal-contract-v1';
const REQUIRED_PROVIDER = 'ibkr';
const REQUIRED_EXCHANGE = 'CME';
const REQUIRED_MARKET_TYPE = 'futures';
const REQUIRED_SIGNAL_SOURCE = 'native_futures';

const SUPPORTED_SYMBOLS = Object.freeze(['MNQ', 'MES']);
const SUPPORTED_TIMEFRAMES = Object.freeze(['1m', '2m', '5m', '15m']);
const DIRECTIONS = Object.freeze(['LONG', 'SHORT']);

const REQUIRED_FIELDS = Object.freeze([
  'contractVersion',
  'signalId',
  'signalSource',
  'provider',
  'exchange',
  'marketType',
  'symbol',
  'contract',
  'timeframe',
  'signalTimestamp',
  'strategyId',
  'strategy',
  'direction',
  'entryPrice',
  'stopLoss',
  'takeProfit',
  'riskReward',
]);

const ALLOWED_TOP_LEVEL_FIELDS = Object.freeze([
  ...REQUIRED_FIELDS,
  'root',
  'confidence',
  'generatedAt',
  ...Object.keys(SAFETY),
]);

const REQUIRED_CONTRACT_FIELDS = Object.freeze([
  'root',
  'symbol',
  'localSymbol',
  'conId',
  'secType',
  'exchange',
  'currency',
  'expiry',
  'lastTradeDateOrContractMonth',
]);

const FORBIDDEN_FIELDS = Object.freeze([
  'originalSymbol',
  'originalMarket',
  'mappedFuturesSymbol',
  'mapping',
  'mappingReason',
  'mappingConfidence',
  'proxy',
  'proxyMapping',
  'proxySymbol',
  'proxySource',
  'underlyingStock',
  'stockSymbol',
  'stockFeedStatus',
  'stockMarketStatus',
  'stockScannerStatus',
  'alpacaSymbol',
  'alpacaProvider',
  'decisionMonitor',
  'decisionMonitorCandidate',
  'legacyAdvisory',
]);

const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  { code: 'alpaca', re: /alpaca/i },
  { code: 'stock', re: /\bstocks?\b/i },
  { code: 'equity', re: /\bequit(y|ies)\b/i },
  { code: 'trading_os', re: /trading[_-]?os/i },
  { code: 'decision_monitor', re: /decision[_-]?monitor/i },
  { code: 'proxy', re: /\bproxy\b/i },
]);

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function lower(value) {
  const text = safeString(value);
  return text ? text.toLowerCase() : null;
}

function upper(value) {
  const text = safeString(value);
  return text ? text.toUpperCase() : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function normalizeDirection(value) {
  const raw = upper(value);
  if (['LONG', 'BUY', 'UP', 'BULL', 'BULLISH'].includes(raw)) return 'LONG';
  if (['SHORT', 'SELL', 'DOWN', 'BEAR', 'BEARISH'].includes(raw)) return 'SHORT';
  return raw;
}

function normalizeSymbol(input = {}) {
  return upper(input.symbol || input.root || input.contract?.root || input.contract?.symbol);
}

function normalizeContract(contract = {}, symbol = null) {
  const root = upper(contract.root || contract.symbol || symbol);
  const expiry = safeString(contract.expiry || contract.lastTradeDateOrContractMonth);
  return {
    root,
    symbol: upper(contract.symbol || root),
    localSymbol: upper(contract.localSymbol),
    conId: numberOrNull(contract.conId),
    secType: upper(contract.secType || 'FUT'),
    exchange: upper(contract.exchange || REQUIRED_EXCHANGE),
    currency: upper(contract.currency || 'USD'),
    expiry,
    lastTradeDateOrContractMonth: expiry,
  };
}

function normalizeStrategy(input = {}, fallbackId = null) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: safeString(source.id || source.strategyId || fallbackId),
    name: safeString(source.name || source.strategyName),
    version: safeString(source.version || source.strategyVersion),
  };
}

function createNativeFuturesSignal(input = {}) {
  const symbol = normalizeSymbol(input);
  const contract = normalizeContract(input.contract || {}, symbol);
  const strategyId = safeString(input.strategyId || input.strategy?.id);

  return {
    contractVersion: safeString(input.contractVersion) || NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION,
    signalId: safeString(input.signalId),
    signalSource: safeString(input.signalSource) || REQUIRED_SIGNAL_SOURCE,
    provider: lower(input.provider) || REQUIRED_PROVIDER,
    exchange: upper(input.exchange || contract.exchange) || REQUIRED_EXCHANGE,
    marketType: lower(input.marketType) || REQUIRED_MARKET_TYPE,
    symbol,
    root: symbol,
    contract,
    timeframe: lower(input.timeframe),
    signalTimestamp: safeString(input.signalTimestamp),
    strategyId,
    strategy: normalizeStrategy(input.strategy || {}, strategyId),
    direction: normalizeDirection(input.direction),
    entryPrice: numberOrNull(input.entryPrice ?? input.entry ?? input.referencePrice),
    stopLoss: numberOrNull(input.stopLoss),
    takeProfit: numberOrNull(input.takeProfit),
    riskReward: numberOrNull(input.riskReward),
    confidence: numberOrNull(input.confidence),
    generatedAt: nowIso(input.generatedAt || new Date()),
    ...SAFETY,
  };
}

function isPresent(value) {
  return value != null && value !== '';
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isValidTimestamp(value) {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts);
}

function expiryIsValid(expiry, now = new Date()) {
  const raw = String(expiry || '').slice(0, 8);
  if (!/^\d{8}$/.test(raw)) return false;
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const expiryMs = Date.UTC(y, m - 1, d, 23, 59, 59);
  return Number.isFinite(expiryMs) && expiryMs >= new Date(now).getTime();
}

function pathJoin(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

function collectForbiddenFields(value, errors, path = '') {
  if (!isObject(value) && !Array.isArray(value)) return;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    const field = String(key);
    const childPath = pathJoin(path, field);
    if (FORBIDDEN_FIELDS.includes(field)) errors.push(`forbidden_field:${childPath}`);
    collectForbiddenFields(child, errors, childPath);
  }
}

function collectForbiddenValues(value, errors, path = '') {
  if (typeof value === 'string') {
    for (const { code, re } of FORBIDDEN_VALUE_PATTERNS) {
      if (re.test(value)) errors.push(`forbidden_legacy_value:${path}:${code}`);
    }
    return;
  }
  if (!isObject(value) && !Array.isArray(value)) return;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    collectForbiddenValues(child, errors, pathJoin(path, String(key)));
  }
}

function validateContract(signal = {}, errors, now = new Date()) {
  const contract = signal.contract;
  if (!isObject(contract)) {
    errors.push('contract_missing_or_invalid');
    return;
  }

  for (const field of REQUIRED_CONTRACT_FIELDS) {
    if (!isPresent(contract[field])) errors.push(`missing_contract_field:${field}`);
  }

  const root = upper(contract.root || contract.symbol);
  const symbol = upper(signal.symbol);
  const localSymbol = upper(contract.localSymbol);
  if (root && symbol && root !== symbol) errors.push(`contract_root_mismatch:${root}:${symbol}`);
  if (localSymbol && symbol && !localSymbol.startsWith(symbol)) {
    errors.push(`contract_local_symbol_mismatch:${localSymbol}:${symbol}`);
  }
  if (numberOrNull(contract.conId) == null || numberOrNull(contract.conId) <= 0) {
    errors.push('contract_conid_missing');
  }
  if (upper(contract.secType) !== 'FUT') errors.push(`contract_not_fut:${contract.secType || null}`);
  if (/CONT/i.test(localSymbol || '') || upper(contract.secType) === 'CONTFUT') {
    errors.push('continuous_contract_not_orderable');
  }
  if (upper(contract.exchange) !== REQUIRED_EXCHANGE) errors.push(`contract_wrong_exchange:${contract.exchange || null}`);
  if (upper(contract.currency) !== 'USD') errors.push(`contract_wrong_currency:${contract.currency || null}`);
  if (!expiryIsValid(contract.expiry || contract.lastTradeDateOrContractMonth, now)) {
    errors.push('contract_expired_or_invalid');
  }
}

function validateRisk(signal = {}, errors) {
  const entry = numberOrNull(signal.entryPrice);
  const stop = numberOrNull(signal.stopLoss);
  const target = numberOrNull(signal.takeProfit);
  const rr = numberOrNull(signal.riskReward);
  const direction = upper(signal.direction);

  if (entry == null || entry <= 0) errors.push('invalid_entry_price');
  if (stop == null || stop <= 0) errors.push('invalid_stop_loss');
  if (target == null || target <= 0) errors.push('invalid_take_profit');
  if (rr == null || rr <= 0) errors.push('invalid_risk_reward');
  if ([entry, stop, target].some((n) => n == null || n <= 0)) return;

  if (direction === 'LONG' && !(stop < entry && entry < target)) {
    errors.push('invalid_risk_geometry:LONG');
  }
  if (direction === 'SHORT' && !(target < entry && entry < stop)) {
    errors.push('invalid_risk_geometry:SHORT');
  }
}

function validateNativeFuturesSignal(signal = {}, { now = new Date() } = {}) {
  const errors = [];

  if (!isObject(signal)) {
    return { ok: false, errors: ['signal_not_object'], contractVersion: NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION, ...SAFETY };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!isPresent(signal[field])) errors.push(`missing_required_field:${field}`);
  }
  for (const field of Object.keys(signal)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.includes(field)) errors.push(`unexpected_top_level_field:${field}`);
  }

  collectForbiddenFields(signal, errors);
  collectForbiddenValues(signal, errors);

  if (signal.contractVersion !== NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION) {
    errors.push(`invalid_contract_version:${signal.contractVersion || null}`);
  }
  if (lower(signal.provider) !== REQUIRED_PROVIDER) errors.push(`invalid_provider:${signal.provider || null}`);
  if (upper(signal.exchange) !== REQUIRED_EXCHANGE) errors.push(`invalid_exchange:${signal.exchange || null}`);
  if (lower(signal.marketType) !== REQUIRED_MARKET_TYPE) errors.push(`invalid_market_type:${signal.marketType || null}`);
  if (signal.signalSource !== REQUIRED_SIGNAL_SOURCE) errors.push(`invalid_signal_source:${signal.signalSource || null}`);

  const symbol = upper(signal.symbol);
  if (!SUPPORTED_SYMBOLS.includes(symbol)) errors.push(`unsupported_futures_symbol:${signal.symbol || null}`);
  if (signal.root != null && upper(signal.root) !== symbol) errors.push(`root_symbol_mismatch:${signal.root}:${signal.symbol}`);

  if (!SUPPORTED_TIMEFRAMES.includes(lower(signal.timeframe))) errors.push(`unsupported_timeframe:${signal.timeframe || null}`);
  if (!DIRECTIONS.includes(upper(signal.direction))) errors.push(`invalid_direction:${signal.direction || null}`);
  if (!isValidTimestamp(signal.signalTimestamp)) errors.push(`invalid_signal_timestamp:${signal.signalTimestamp || null}`);

  if (!isObject(signal.strategy)) {
    errors.push('strategy_missing_or_invalid');
  } else {
    if (!isPresent(signal.strategy.id)) errors.push('missing_strategy_field:id');
    if (signal.strategyId && signal.strategy.id && signal.strategyId !== signal.strategy.id) {
      errors.push(`strategy_id_mismatch:${signal.strategyId}:${signal.strategy.id}`);
    }
  }

  validateContract(signal, errors, now);
  validateRisk(signal, errors);

  return {
    ok: errors.length === 0,
    errors,
    contractVersion: NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION,
    ...SAFETY,
  };
}

function isNativeFuturesProductionSignal(signal = {}, options = {}) {
  return validateNativeFuturesSignal(signal, options).ok === true;
}

module.exports = {
  SAFETY,
  NATIVE_FUTURES_SIGNAL_CONTRACT_VERSION,
  REQUIRED_PROVIDER,
  REQUIRED_EXCHANGE,
  REQUIRED_MARKET_TYPE,
  REQUIRED_SIGNAL_SOURCE,
  SUPPORTED_SYMBOLS,
  SUPPORTED_TIMEFRAMES,
  REQUIRED_FIELDS,
  REQUIRED_CONTRACT_FIELDS,
  FORBIDDEN_FIELDS,
  createNativeFuturesSignal,
  validateNativeFuturesSignal,
  isNativeFuturesProductionSignal,
  _internal: {
    normalizeContract,
    normalizeDirection,
    expiryIsValid,
    collectForbiddenFields,
    collectForbiddenValues,
  },
};
