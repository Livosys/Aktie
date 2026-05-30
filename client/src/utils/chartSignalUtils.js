// Read-only chart/signal-hjälpare för /live.
// Endast normalisering + symbol-mapping för visualisering.
// Ingen trading-, order-, broker- eller risklogik. live=false alltid.

const STOCK_MAP = {
  NVDA: 'NASDAQ:NVDA', AAPL: 'NASDAQ:AAPL', MSFT: 'NASDAQ:MSFT', TSLA: 'NASDAQ:TSLA',
  AMD: 'NASDAQ:AMD', META: 'NASDAQ:META', GOOGL: 'NASDAQ:GOOGL', GOOG: 'NASDAQ:GOOG',
  AMZN: 'NASDAQ:AMZN', NFLX: 'NASDAQ:NFLX', AVGO: 'NASDAQ:AVGO', INTC: 'NASDAQ:INTC',
  SMCI: 'NASDAQ:SMCI', PLTR: 'NASDAQ:PLTR', COIN: 'NASDAQ:COIN', MSTR: 'NASDAQ:MSTR',
  QQQ: 'NASDAQ:QQQ', SPY: 'AMEX:SPY',
};

const CRYPTO_MAP = {
  BTCUSDT: 'BINANCE:BTCUSDT', ETHUSDT: 'BINANCE:ETHUSDT', SOLUSDT: 'BINANCE:SOLUSDT',
  XRPUSDT: 'BINANCE:XRPUSDT', ADAUSDT: 'BINANCE:ADAUSDT', DOGEUSDT: 'BINANCE:DOGEUSDT',
  AVAXUSDT: 'BINANCE:AVAXUSDT', LINKUSDT: 'BINANCE:LINKUSDT', MATICUSDT: 'BINANCE:MATICUSDT',
};

const SYMBOL_KEYS = ['symbol', 'ticker', 'instrument', 'base_symbol', 'underlying_symbol'];
const TIMESTAMP_KEYS = ['timestamp', 'signal_time', 'created_at', 'time', 'detected_at', 'lastUpdate'];
const PRICE_KEYS = ['price', 'entry_price', 'current_price', 'latest_price', 'close', 'last_price'];
const DIRECTION_KEYS = ['direction', 'type', 'side', 'bias', 'nextMoveBias', 'signal'];
const STRATEGY_ID_KEYS = ['strategy_id', 'strategy', 'preset', 'runtime_strategy'];
const STRATEGY_NAME_KEYS = ['strategyName', 'strategy_name', 'strategy'];
const SCORE_KEYS = ['score', 'rating', 'tradeScore'];
const CONFIDENCE_KEYS = ['confidence', 'confidenceScore'];
const REASON_KEYS = ['reason', 'explanation', 'why', 'summary', 'decisionTextSv'];
const TIMEFRAME_KEYS = ['timeframe', 'tf', 'interval'];
const ID_KEYS = ['id', 'signalId', 'signal_id'];

function firstField(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeDirection(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).toLowerCase();
  if (/long|buy|bull/.test(s)) return 'long';
  if (/short|sell|bear/.test(s)) return 'short';
  if (/up/.test(s)) return 'up';
  if (/down/.test(s)) return 'down';
  return s;
}

function formatDisplayTime(ts) {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'medium' });
  } catch (_) {
    return String(ts);
  }
}

function buildExternalUrl(tvSymbol) {
  const sym = tvSymbol || '';
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;
}

/**
 * Mappar en rå symbol till en TradingView-symbol (EXCHANGE:SYMBOL).
 * Blockerar aldrig en signal — okänd exchange antas hellre än döljs.
 */
export function mapSymbolToTradingView(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) {
    return { tvSymbol: '', marketType: 'unknown', exchangeAssumed: false, assumedText: '' };
  }

  // 1. Redan prefixad med exchange → returnera som den är.
  if (raw.includes(':')) {
    const exchange = raw.split(':')[0];
    const marketType = exchange === 'BINANCE' || raw.endsWith('USDT') ? 'crypto' : 'stock';
    return { tvSymbol: raw, marketType, exchangeAssumed: false, assumedText: '' };
  }

  // 2. Krypto (känd eller USDT-par).
  if (CRYPTO_MAP[raw]) {
    return { tvSymbol: CRYPTO_MAP[raw], marketType: 'crypto', exchangeAssumed: false, assumedText: '' };
  }
  if (raw.endsWith('USDT')) {
    return { tvSymbol: `BINANCE:${raw}`, marketType: 'crypto', exchangeAssumed: false, assumedText: '' };
  }

  // 3. Känd aktie.
  if (STOCK_MAP[raw]) {
    return { tvSymbol: STOCK_MAP[raw], marketType: 'stock', exchangeAssumed: false, assumedText: '' };
  }

  // 4. Okänd → anta NASDAQ men markera att mappningen är antagen.
  const looksLikeStock = /^[A-Z][A-Z.]{0,5}$/.test(raw);
  return {
    tvSymbol: `NASDAQ:${raw}`,
    marketType: looksLikeStock ? 'stock' : 'unknown',
    exchangeAssumed: true,
    assumedText: 'Exchange antagen: NASDAQ',
  };
}

/**
 * Normaliserar en signal (från valfri del av systemet) till ett chart-objekt.
 * Read-only. Tappar aldrig bort exakt tid/pris om de finns.
 */
export function normalizeSignalForChart(signal = {}) {
  const rawSymbolValue = firstField(signal, SYMBOL_KEYS);
  const symbol = String(rawSymbolValue || '').trim().toUpperCase();
  const map = mapSymbolToTradingView(symbol);

  const timestampValue = firstField(signal, TIMESTAMP_KEYS);
  const priceValue = firstField(signal, PRICE_KEYS);
  const priceNum = priceValue !== undefined && Number.isFinite(Number(priceValue)) ? Number(priceValue) : null;

  const strategyId = firstField(signal, STRATEGY_ID_KEYS) ?? null;
  const strategyName = firstField(signal, STRATEGY_NAME_KEYS) ?? (strategyId != null ? String(strategyId) : null);
  const scoreValue = firstField(signal, SCORE_KEYS);
  const confidenceValue = firstField(signal, CONFIDENCE_KEYS);

  const hasTime = timestampValue !== undefined && timestampValue !== null && timestampValue !== '';
  const hasPrice = priceNum !== null;

  let markerReady = true;
  let markerMissingReason = '';
  if (!hasTime) {
    markerReady = false;
    markerMissingReason = 'Saknar tid för signalen';
  } else if (!hasPrice) {
    markerReady = false;
    markerMissingReason = 'Saknar pris för signalen';
  }

  return {
    id: firstField(signal, ID_KEYS) ?? null,
    symbol,
    rawSymbol: rawSymbolValue != null ? String(rawSymbolValue) : '',
    tvSymbol: map.tvSymbol,
    marketType: map.marketType,
    exchangeAssumed: map.exchangeAssumed,
    exchangeAssumedText: map.assumedText,
    direction: normalizeDirection(firstField(signal, DIRECTION_KEYS)),
    strategyId: strategyId != null ? String(strategyId) : null,
    strategyName,
    timestamp: hasTime ? String(timestampValue) : null,
    displayTime: hasTime ? formatDisplayTime(timestampValue) : null,
    price: priceNum,
    timeframe: String(firstField(signal, TIMEFRAME_KEYS) ?? '2m'),
    score: scoreValue ?? null,
    confidence: confidenceValue ?? null,
    reason: firstField(signal, REASON_KEYS) ?? null,
    markerReady,
    markerMissingReason,
    externalTradingViewUrl: buildExternalUrl(map.tvSymbol),
  };
}
