const STOCK_EXCHANGE = 'NASDAQ';
const CRYPTO_EXCHANGE = 'BINANCE';

const STOCK_SYMBOLS = new Set(['AAPL', 'NVDA', 'TSLA', 'AMD', 'MSFT', 'META', 'AMZN', 'QQQ']);
const CRYPTO_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
const CRYPTO_NORMALIZE = {
  BTCUSD: 'BTCUSDT',
  ETHUSD: 'ETHUSDT',
  SOLUSD: 'SOLUSDT',
};

export function normalizeTradingViewSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  return CRYPTO_NORMALIZE[raw] || raw;
}

export function isCryptoSymbol(symbol) {
  const normalized = normalizeTradingViewSymbol(symbol);
  return CRYPTO_SYMBOLS.has(normalized) || normalized.endsWith('USDT');
}

export function getTradingViewUrl(symbol, marketType) {
  const raw = String(symbol || '').trim().toUpperCase();
  const normalized = normalizeTradingViewSymbol(raw);

  if (!normalized) {
    console.warn('TradingView: okänd symbol', symbol);
    return 'https://www.tradingview.com/chart/';
  }

  const type = marketType || (isCryptoSymbol(normalized) ? 'crypto' : 'stocks');
  if (type === 'crypto' || CRYPTO_SYMBOLS.has(normalized)) {
    if (!CRYPTO_SYMBOLS.has(normalized)) {
      console.warn('TradingView: okänd kryptosymbol, öppnar sökning', raw);
      return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(normalized)}`;
    }
    return `https://www.tradingview.com/chart/?symbol=${CRYPTO_EXCHANGE}:${normalized}`;
  }

  if (STOCK_SYMBOLS.has(normalized)) {
    return `https://www.tradingview.com/chart/?symbol=${STOCK_EXCHANGE}:${normalized}`;
  }

  console.warn('TradingView: okänd aktiesymbol, öppnar sökning', raw);
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(normalized)}`;
}

export function openTradingView(symbol, marketType) {
  const url = getTradingViewUrl(symbol, marketType);
  window.open(url, '_blank', 'noopener,noreferrer');
  return url;
}
