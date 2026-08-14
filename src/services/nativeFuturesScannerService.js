'use strict';

// Native Futures Scanner
//
// Phase 4 only: normalize market substrate for native futures. This service
// does not create signals, candidates, strategies, or execution intents, and is
// intentionally not wired into any production scheduler/provider.

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
  paper_only: true,
  live_enabled: false,
  source: 'native_futures_scanner',
});

const DEFAULT_SYMBOLS = Object.freeze(['MNQ', 'MES']);
const SUPPORTED_SYMBOLS = new Set(DEFAULT_SYMBOLS);
const DEFAULT_PROVIDER = 'ibkr';
const DEFAULT_EXCHANGE = 'CME';
const DEFAULT_TIMEFRAME = '2m';
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

function nowIso(now = new Date()) {
  return new Date(now).toISOString();
}

function safeString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function upper(value) {
  const text = safeString(value);
  return text ? text.toUpperCase() : null;
}

function lower(value) {
  const text = safeString(value);
  return text ? text.toLowerCase() : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value == null ? [] : [value];
}

function timeframeToMs(timeframe) {
  const raw = lower(timeframe);
  const match = raw && raw.match(/^(\d+)(m|h)$/);
  if (!match) return 2 * 60 * 1000;
  const size = Number(match[1]);
  return match[2] === 'h' ? size * 60 * 60 * 1000 : size * 60 * 1000;
}

function timestampOf(row = {}) {
  return safeString(row.timestamp || row.time || row.startTime || row.endTime || row.updatedAt || row.generatedAt);
}

function candleTimestampOf(row = {}, timeframe = DEFAULT_TIMEFRAME) {
  const explicitClose = safeString(row.endTime || row.closeTime || row.closedAt || row.completedAt);
  if (explicitClose) return explicitClose;

  const raw = safeString(row.timestamp || row.time || row.startTime || row.ts || row.t);
  const startMs = Date.parse(raw || '');
  if (row.isClosed === true && Number.isFinite(startMs)) {
    return new Date(startMs + timeframeToMs(row.timeframe || timeframe)).toISOString();
  }
  return raw;
}

function ageMs(timestamp, now = new Date()) {
  const parsed = Date.parse(timestamp || '');
  const current = new Date(now).getTime();
  if (!Number.isFinite(parsed) || !Number.isFinite(current)) return null;
  return Math.max(0, current - parsed);
}

function normalizeSymbols(symbols) {
  return safeArray(symbols)
    .map((symbol) => upper(symbol))
    .filter(Boolean);
}

function normalizeContract(contract = {}, symbol) {
  if (!contract || typeof contract !== 'object') return null;
  const expiry = safeString(contract.expiry || contract.lastTradeDateOrContractMonth);
  const root = upper(contract.root || contract.symbol || symbol);
  return {
    root,
    symbol: upper(contract.symbol || root),
    localSymbol: upper(contract.localSymbol),
    conId: numberOrNull(contract.conId),
    secType: upper(contract.secType),
    exchange: upper(contract.exchange),
    currency: upper(contract.currency),
    expiry,
    lastTradeDateOrContractMonth: expiry,
  };
}

function validateContract(contract, symbol) {
  const errors = [];
  if (!contract) return { ok: false, errors: ['contract_missing'] };
  for (const field of REQUIRED_CONTRACT_FIELDS) {
    if (contract[field] == null || contract[field] === '') errors.push(`missing_contract_field:${field}`);
  }
  if (!SUPPORTED_SYMBOLS.has(symbol)) errors.push(`unsupported_futures_symbol:${symbol}`);
  if (contract.root && contract.root !== symbol) errors.push(`contract_root_mismatch:${contract.root}:${symbol}`);
  if (contract.symbol && contract.symbol !== symbol) errors.push(`contract_symbol_mismatch:${contract.symbol}:${symbol}`);
  if (contract.localSymbol && !String(contract.localSymbol).startsWith(symbol)) {
    errors.push(`contract_local_symbol_mismatch:${contract.localSymbol}:${symbol}`);
  }
  if (contract.conId == null || contract.conId <= 0) errors.push('contract_conid_missing');
  if (contract.secType !== 'FUT') errors.push(`contract_not_fut:${contract.secType || null}`);
  if (contract.exchange !== DEFAULT_EXCHANGE) errors.push(`contract_wrong_exchange:${contract.exchange || null}`);
  if (contract.currency !== 'USD') errors.push(`contract_wrong_currency:${contract.currency || null}`);
  if (/CONT/i.test(contract.localSymbol || '') || contract.secType === 'CONTFUT') {
    errors.push('continuous_contract_not_orderable');
  }
  return { ok: errors.length === 0, errors };
}

function latestByTimestamp(rows, timeframe = DEFAULT_TIMEFRAME) {
  return safeArray(rows)
    .slice()
    .sort((a, b) => String(candleTimestampOf(b, timeframe) || '').localeCompare(String(candleTimestampOf(a, timeframe) || '')))[0] || null;
}

function normalizeCandle(row = {}, timeframe = DEFAULT_TIMEFRAME) {
  if (!row || typeof row !== 'object') return null;
  return {
    timestamp: candleTimestampOf(row, timeframe),
    open: numberOrNull(row.open ?? row.o),
    high: numberOrNull(row.high ?? row.h),
    low: numberOrNull(row.low ?? row.l),
    close: numberOrNull(row.close ?? row.c),
    volume: numberOrNull(row.volume ?? row.v),
    source: safeString(row.source),
  };
}

function normalizeQuote(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const bid = numberOrNull(row.bid);
  const ask = numberOrNull(row.ask);
  const last = numberOrNull(row.last ?? row.lastPrice);
  const price = numberOrNull(row.price ?? row.mark ?? row.mid)
    ?? last
    ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
  return {
    timestamp: timestampOf(row),
    price,
    bid,
    ask,
    last,
    source: safeString(row.source),
  };
}

function candleStatus(candle, now, maxAgeMs) {
  if (!candle) return { status: 'missing', ageMs: null };
  const currentAge = ageMs(candle.timestamp, now);
  if (currentAge == null) return { status: 'invalid_timestamp', ageMs: null };
  return {
    status: currentAge > maxAgeMs ? 'stale' : 'fresh',
    ageMs: currentAge,
  };
}

function quoteStatus(quote, now, maxAgeMs) {
  if (!quote) return { status: 'missing', ageMs: null };
  const currentAge = ageMs(quote.timestamp, now);
  if (currentAge == null) return { status: 'available', ageMs: null };
  return {
    status: currentAge > maxAgeMs ? 'stale' : 'fresh',
    ageMs: currentAge,
  };
}

function sessionStatus(session = {}) {
  const open = session.isOpen === true || session.isMarketOpen === true;
  return open ? 'open' : 'closed';
}

function rowStatus({ contractValidation, candleState, quoteState, sessionState }) {
  if (contractValidation.ok !== true) return 'invalid_contract';
  if (candleState.status === 'missing' || quoteState.status === 'missing') return 'missing_market_data';
  if (candleState.status === 'stale' || quoteState.status === 'stale') return 'stale_market_data';
  if (candleState.status === 'invalid_timestamp') return 'invalid_market_data_timestamp';
  if (sessionState === 'closed') return 'session_closed';
  return 'ready';
}

function defaultSessionReader() {
  return {
    isOpen: false,
    isMarketOpen: false,
    session: 'Globex',
    sessionId: 'unknown',
    sessionLabel: 'Unknown',
    closedReason: 'session_reader_not_configured',
  };
}

function createNativeFuturesScanner(options = {}) {
  const symbols = normalizeSymbols(options.symbols || DEFAULT_SYMBOLS);
  const timeframe = lower(options.timeframe || DEFAULT_TIMEFRAME);
  const provider = lower(options.provider || DEFAULT_PROVIDER);
  const exchange = upper(options.exchange || DEFAULT_EXCHANGE);
  const maxCandleAgeMs = Number.isFinite(Number(options.maxCandleAgeMs))
    ? Number(options.maxCandleAgeMs)
    : Math.max(timeframeToMs(timeframe) * 2, 60 * 1000);
  const maxQuoteAgeMs = Number.isFinite(Number(options.maxQuoteAgeMs))
    ? Number(options.maxQuoteAgeMs)
    : 15 * 1000;
  const contractReader = typeof options.contractReader === 'function' ? options.contractReader : (() => null);
  const candleReader = typeof options.candleReader === 'function' ? options.candleReader : (() => []);
  const quoteReader = typeof options.quoteReader === 'function' ? options.quoteReader : (() => null);
  const sessionReader = typeof options.sessionReader === 'function' ? options.sessionReader : defaultSessionReader;

  function getMonitoredSymbols() {
    return [...symbols];
  }

  function scan({ now = new Date() } = {}) {
    const generatedAt = nowIso(now);
    const rows = symbols.map((symbol) => {
      const contract = normalizeContract(contractReader({ symbol, timeframe, provider, exchange, now }), symbol);
      const contractValidation = validateContract(contract, symbol);
      // Läsaren hämtar redan en serie; tidigare kollapsades den direkt till ett ljus
      // och resten slängdes. Serien exponeras nu vid sidan av latestCandle så
      // indikatorbaserade strategier (ema/vwap/range) kan räknas på den. latestCandle
      // härleds oförändrat, så befintliga strategier påverkas inte.
      const candleRows = candleReader({ symbol, timeframe, contract, provider, exchange, now });
      const latestCandle = normalizeCandle(latestByTimestamp(candleRows, timeframe), timeframe);
      const candles = safeArray(candleRows)
        .map((row) => normalizeCandle(row, timeframe))
        .filter((row) => row && row.timestamp)
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      const latestQuote = normalizeQuote(quoteReader({ symbol, timeframe, contract, provider, exchange, now }));
      const session = sessionReader({ symbol, timeframe, contract, provider, exchange, now }) || defaultSessionReader();
      const candleState = candleStatus(latestCandle, now, maxCandleAgeMs);
      const quoteState = quoteStatus(latestQuote, now, maxQuoteAgeMs);
      const currentSessionStatus = sessionStatus(session);
      const status = rowStatus({
        contractValidation,
        candleState,
        quoteState,
        sessionState: currentSessionStatus,
      });

      return {
        symbol,
        root: symbol,
        contract,
        contractStatus: contractValidation.ok ? 'valid' : 'invalid',
        contractErrors: contractValidation.errors,
        exchange,
        provider,
        timeframe,
        latestCandle,
        candles,
        candleStatus: candleState.status,
        candleAgeMs: candleState.ageMs,
        latestQuote,
        quoteStatus: quoteState.status,
        quoteAgeMs: quoteState.ageMs,
        session,
        sessionStatus: currentSessionStatus,
        timestamp: generatedAt,
        status,
        ...SAFETY,
      };
    });

    return {
      ok: rows.every((row) => row.status === 'ready'),
      generatedAt,
      provider,
      exchange,
      timeframe,
      monitoredSymbols: [...symbols],
      rows,
      stats: {
        monitoredSymbols: symbols.length,
        ready: rows.filter((row) => row.status === 'ready').length,
        invalidContracts: rows.filter((row) => row.contractStatus === 'invalid').length,
        missingMarketData: rows.filter((row) => row.status === 'missing_market_data').length,
        staleMarketData: rows.filter((row) => row.status === 'stale_market_data').length,
        closedSessions: rows.filter((row) => row.sessionStatus === 'closed').length,
      },
      ...SAFETY,
    };
  }

  return {
    SAFETY,
    getMonitoredSymbols,
    scan,
  };
}

const defaultNativeFuturesScanner = createNativeFuturesScanner();

module.exports = {
  SAFETY,
  DEFAULT_SYMBOLS,
  DEFAULT_PROVIDER,
  DEFAULT_EXCHANGE,
  DEFAULT_TIMEFRAME,
  createNativeFuturesScanner,
  defaultNativeFuturesScanner,
  _internal: {
    normalizeContract,
    validateContract,
    normalizeCandle,
    candleTimestampOf,
    normalizeQuote,
    candleStatus,
    quoteStatus,
    timeframeToMs,
  },
};
