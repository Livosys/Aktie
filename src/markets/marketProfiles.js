'use strict';

const MARKET_PROFILES = {
  US_STOCKS: {
    symbols: ['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'META', 'AMZN', 'NFLX', 'GOOGL'],
    provider: 'Alpaca',
    session: 'NYSE',
    allowedFamilies: ['VWAP_RECLAIM_REJECTION', 'EMA_TREND_PULLBACK', 'NARROW_COMPRESSION'],
    preferredFamilies: ['VWAP_RECLAIM_REJECTION'],
    paperOnly: false,
    risk: 'normal',
    targetPct: 0.25,
    stopPct: 0.18,
    maxHoldMinutes: 20,
  },
  INDEX_ETFS: {
    symbols: ['SPY', 'QQQ', 'IWM', 'DIA'],
    provider: 'Alpaca',
    session: 'NYSE',
    role: 'market_compass',
    allowedFamilies: ['VWAP_RECLAIM_REJECTION', 'NARROW_COMPRESSION'],
    preferredFamilies: ['VWAP_RECLAIM_REJECTION'],
    paperOnly: false,
    risk: 'normal',
    targetPct: 0.18,
    stopPct: 0.12,
    maxHoldMinutes: 20,
  },
  LEVERAGED_ETFS: {
    symbols: ['TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA', 'TZA'],
    provider: 'Alpaca',
    session: 'NYSE',
    paperOnly: true,
    risk: 'high',
    allowedFamilies: ['VWAP_RECLAIM_REJECTION', 'NARROW_COMPRESSION'],
    preferredFamilies: ['VWAP_RECLAIM_REJECTION'],
    targetPct: 0.35,
    stopPct: 0.22,
    maxHoldMinutes: 15,
  },
  CRYPTO_MAJOR: {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    provider: 'Binance',
    session: '24_7',
    paperOnly: false,
    risk: 'normal',
    allowedFamilies: ['VWAP_RECLAIM_REJECTION', 'NARROW_COMPRESSION'],
    preferredFamilies: ['VWAP_RECLAIM_REJECTION'],
    targetPct: 0.25,
    stopPct: 0.20,
    maxHoldMinutes: 20,
  },
  CRYPTO_SECONDARY: {
    symbols: ['BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT'],
    provider: 'Binance',
    session: '24_7',
    paperOnly: true,
    risk: 'normal',
    allowedFamilies: ['VWAP_RECLAIM_REJECTION', 'NARROW_COMPRESSION'],
    preferredFamilies: ['VWAP_RECLAIM_REJECTION'],
    targetPct: 0.30,
    stopPct: 0.22,
    maxHoldMinutes: 15,
  },
};

// symbol → group name lookup (uppercase keys)
const SYMBOL_TO_GROUP = {};
for (const [groupName, profile] of Object.entries(MARKET_PROFILES)) {
  for (const sym of profile.symbols) {
    SYMBOL_TO_GROUP[sym.toUpperCase()] = groupName;
  }
}

function getMarketGroup(symbol) {
  return SYMBOL_TO_GROUP[String(symbol || '').toUpperCase()] || null;
}

function getProfile(symbol) {
  const group = getMarketGroup(symbol);
  if (!group) return null;
  return { ...MARKET_PROFILES[group], groupName: group };
}

function getRiskProfile(symbol) {
  const profile = getProfile(symbol);
  if (!profile) return null;
  return {
    groupName:      profile.groupName,
    targetPct:      profile.targetPct,
    stopPct:        profile.stopPct,
    maxHoldMinutes: profile.maxHoldMinutes,
    paperOnly:      profile.paperOnly,
    risk:           profile.risk,
    session:        profile.session,
  };
}

function isPaperOnly(symbol) {
  const profile = getProfile(symbol);
  return profile?.paperOnly === true;
}

module.exports = {
  MARKET_PROFILES,
  SYMBOL_TO_GROUP,
  getMarketGroup,
  getProfile,
  getRiskProfile,
  isPaperOnly,
};
