'use strict';
/**
 * Market Regime Service — Adaptive Market Intelligence v1
 *
 * Analysis-only: synthesizes existing market data into regime detection,
 * dynamic strategy weights, index intelligence, and regime history.
 *
 * SAFETY: no orders, no live config changes, no auto-trading.
 */

const fs   = require('fs');
const path = require('path');

// ── Safety contract ───────────────────────────────────────────────────────────
const SAFETY = Object.freeze({
  actions_allowed:      false,
  can_place_orders:     false,
  live_trading_enabled: false,
  agent_mode:           'analysis_only',
});

// ── File paths ────────────────────────────────────────────────────────────────
const DATA_DIR          = path.join(__dirname, '../../data');
const COMPASS_PATH      = path.join(DATA_DIR, 'market-compass.json');
const PERSONALITY_STOCKS= path.join(DATA_DIR, 'signals/market-personality-stocks.json');
const PERSONALITY_CRYPTO= path.join(DATA_DIR, 'signals/market-personality-crypto.json');
const REGIME_PROFILES   = path.join(DATA_DIR, 'signals/regime-profiles.json');
const TRADES_PATH       = path.join(DATA_DIR, 'paper-trading/trades.jsonl');
const REGIME_DIR        = path.join(DATA_DIR, 'market-regime');
const HISTORY_PATH      = path.join(REGIME_DIR, 'history.json');
const STATUS_PATH       = path.join(REGIME_DIR, 'status.json');

if (!fs.existsSync(REGIME_DIR)) fs.mkdirSync(REGIME_DIR, { recursive: true });

// ── 8 Regime identifiers ──────────────────────────────────────────────────────
const REGIMES = {
  STRONG_BULL_TREND: 'STRONG_BULL_TREND',
  STRONG_BEAR_TREND: 'STRONG_BEAR_TREND',
  CHOPPY_MARKET:     'CHOPPY_MARKET',
  HIGH_VOLATILITY:   'HIGH_VOLATILITY',
  LOW_VOLATILITY:    'LOW_VOLATILITY',
  RISK_OFF:          'RISK_OFF',
  RISK_ON:           'RISK_ON',
  MIXED_MARKET:      'MIXED_MARKET',
};

const REGIME_META = {
  STRONG_BULL_TREND: { labelSv: 'Stark Upptrend',   icon: '🟢', color: '#22c55e', descSv: 'Stark uppåtgående trend. Momentum och VWAP-strategier fungerar bra.' },
  STRONG_BEAR_TREND: { labelSv: 'Stark Nedtrend',    icon: '🔴', color: '#ef4444', descSv: 'Stark nedåtgående trend. Bearish-setups prioriteras.' },
  CHOPPY_MARKET:     { labelSv: 'Stökig Marknad',    icon: '🟡', color: '#f59e0b', descSv: 'Fram och tillbaka utan riktning. Mean reversion fungerar bättre.' },
  HIGH_VOLATILITY:   { labelSv: 'Hög Volatilitet',   icon: '🟠', color: '#f97316', descSv: 'Stora rörelser. Tight stop loss är kritiskt.' },
  LOW_VOLATILITY:    { labelSv: 'Låg Volatilitet',   icon: '⚪', color: '#94a3b8', descSv: 'Svaga rörelser. Volym-baserade setups underpresterar.' },
  RISK_OFF:          { labelSv: 'Risk-Off Miljö',    icon: '🔴', color: '#dc2626', descSv: 'Svaga index och flykt från risk. Undvik bullish setups.' },
  RISK_ON:           { labelSv: 'Risk-On Miljö',     icon: '🟢', color: '#16a34a', descSv: 'Starkt sentiment. Breakouts och momentum fungerar bättre.' },
  MIXED_MARKET:      { labelSv: 'Blandad Marknad',   icon: '🟡', color: '#6b7280', descSv: 'Index håller inte med varandra. Lägre confidence rekommenderas.' },
};

// ── Strategy weights per regime (delta vs neutral 0) ─────────────────────────
// Positive = prioritize, Negative = deprioritize
const REGIME_WEIGHTS = {
  STRONG_BULL_TREND: {
    vwap_reclaim:            15,
    vwap_momentum:           15,
    volume_spike_momentum:   12,
    opening_range_breakout:  12,
    pullback_continuation:   10,
    sector_confirmation:     10,
    momentum:                 8,
    breakout:                10,
    index_trend_mode:         8,
    mean_reversion:          -8,
    mean_reversion_vwap:     -8,
    vwap_rejection:          -8,
    vwap_rejection_short:   -12,
    ema_pullback:            -5,
    news_volatility_watch:   -5,
  },
  STRONG_BEAR_TREND: {
    vwap_rejection:          15,
    vwap_rejection_short:    15,
    mean_reversion:           8,
    mean_reversion_vwap:      8,
    breakout:               -10,
    opening_range_breakout: -10,
    vwap_reclaim:           -12,
    vwap_momentum:          -12,
    momentum:                -8,
    volume_spike_momentum:   -8,
    pullback_continuation:   -5,
    index_trend_mode:        -5,
  },
  CHOPPY_MARKET: {
    mean_reversion:          15,
    mean_reversion_vwap:     15,
    pullback_continuation:    5,
    news_volatility_watch:    5,
    breakout:               -10,
    opening_range_breakout: -10,
    momentum:                -6,
    vwap_momentum:           -6,
    volume_spike_momentum:   -5,
    vwap_reclaim:            -4,
    index_trend_mode:        -8,
  },
  HIGH_VOLATILITY: {
    mean_reversion_vwap:      8,
    mean_reversion:           6,
    news_volatility_watch:   10,
    volume_spike:            -5,
    volume_spike_momentum:   -5,
    breakout:                -8,
    opening_range_breakout:  -8,
    momentum:                -4,
    vwap_momentum:           -4,
  },
  LOW_VOLATILITY: {
    mean_reversion:           5,
    mean_reversion_vwap:      5,
    momentum:               -10,
    vwap_momentum:          -10,
    volume_spike:           -15,
    volume_spike_momentum:  -15,
    breakout:                -8,
  },
  RISK_OFF: {
    vwap_rejection:          10,
    vwap_rejection_short:     8,
    mean_reversion:           5,
    vwap_reclaim:           -10,
    breakout:               -10,
    momentum:                -8,
    opening_range_breakout:  -8,
    vwap_momentum:           -8,
    index_trend_mode:       -10,
  },
  RISK_ON: {
    breakout:                12,
    opening_range_breakout:  12,
    momentum:                10,
    vwap_momentum:           10,
    vwap_reclaim:             8,
    sector_confirmation:      8,
    volume_spike_momentum:    8,
    index_trend_mode:        10,
    mean_reversion:          -5,
  },
  MIXED_MARKET: {},
};

// ── All known strategy keys ───────────────────────────────────────────────────
const ALL_STRATEGY_KEYS = [
  'vwap_reclaim', 'vwap_rejection', 'ema_trend', 'ema_pullback',
  'narrow_state', 'breakout', 'momentum', 'mean_reversion', 'volume_spike',
  'vwap_momentum', 'vwap_rejection_short', 'opening_range_breakout',
  'pullback_continuation', 'mean_reversion_vwap', 'volume_spike_momentum',
  'index_trend_mode', 'sector_confirmation', 'news_volatility_watch',
];

const STRATEGY_LABELS = {
  vwap_reclaim:           'VWAP-återtagning',
  vwap_rejection:         'VWAP-avvisning',
  ema_trend:              'EMA-trend',
  ema_pullback:           'EMA-rekyl',
  narrow_state:           'Narrow State',
  breakout:               'Utbrott',
  momentum:               'Momentum',
  mean_reversion:         'Mean Reversion',
  volume_spike:           'Volymtopp',
  vwap_momentum:          'VWAP Momentum',
  vwap_rejection_short:   'VWAP Avvisning Short',
  opening_range_breakout: 'Opening Range Breakout',
  pullback_continuation:  'Pullback/Rekyl',
  mean_reversion_vwap:    'Mean Reversion VWAP',
  volume_spike_momentum:  'Volym + Momentum',
  index_trend_mode:       'Index-trendläge',
  sector_confirmation:    'Sektorbekräftelse',
  news_volatility_watch:  'Nyhets-volatilitet',
};

// ── Data loaders ──────────────────────────────────────────────────────────────
function loadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function loadTrades() {
  try {
    if (!fs.existsSync(TRADES_PATH)) return [];
    const raw = fs.readFileSync(TRADES_PATH, 'utf8');
    return raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function loadHistory() {
  const h = loadJson(HISTORY_PATH);
  return Array.isArray(h) ? h : [];
}

// ── Helper utils ──────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }

function signalFamilyToStrategyKey(signalFamily, signalSubtype) {
  const f = (signalFamily || '').toUpperCase();
  const s = (signalSubtype  || '').toUpperCase();
  if (f.includes('VWAP')) {
    if (s.includes('UP') || s.includes('RECLAIM'))   return 'vwap_reclaim';
    if (s.includes('DOWN') || s.includes('REJECT'))  return 'vwap_rejection';
    return 'vwap_reclaim';
  }
  if (f.includes('EMA'))       return 'ema_trend';
  if (f.includes('NARROW'))    return 'narrow_state';
  if (f.includes('BREAKOUT'))  return 'breakout';
  if (f.includes('MOMENTUM'))  return 'momentum';
  if (f.includes('REVERSION') || f.includes('REVERSAL')) return 'mean_reversion';
  if (f.includes('PULLBACK'))  return 'pullback_continuation';
  return null;
}

// Map old v2 regime labels to new 8-regime system
function mapOldRegimeToNew(oldRegime) {
  const map = {
    BULLISH_TREND:   'STRONG_BULL_TREND',
    TREND_DAY_UP:    'STRONG_BULL_TREND',
    BEARISH_TREND:   'STRONG_BEAR_TREND',
    TREND_DAY_DOWN:  'STRONG_BEAR_TREND',
    CHOPPY:          'CHOPPY_MARKET',
    RANGE_DAY:       'CHOPPY_MARKET',
    HIGH_VOLATILITY: 'HIGH_VOLATILITY',
    PANIC:           'HIGH_VOLATILITY',
    UNKNOWN:         'MIXED_MARKET',
  };
  return map[oldRegime] || 'MIXED_MARKET';
}

// ── 1. detectVolatilityState ──────────────────────────────────────────────────
function detectVolatilityState(personality) {
  const vp  = personality?.volatilityPressure ?? 50;
  const atr = personality?.raw?.avgAtrPct120   ?? 100;

  if (atr > 180 || vp > 80) return 'extreme';
  if (atr > 130 || vp > 60) return 'high';
  if (atr < 55  || vp < 20) return 'low';
  return 'normal';
}

const VOLATILITY_SV = {
  extreme: 'Extrem volatilitet',
  high:    'Hög volatilitet',
  normal:  'Normal volatilitet',
  low:     'Låg volatilitet',
};

// ── 2. detectTrendState ───────────────────────────────────────────────────────
function detectTrendState(compass, personality) {
  const qqqUp  = compass?.qqqTrend === 'UP';
  const spyUp  = compass?.spyTrend === 'UP';
  const tp     = personality?.trendPersistence  ?? 30;
  const cp     = personality?.continuationProbability ?? 50;
  const fr     = personality?.fakeoutRisk       ?? 20;

  const bullScore = (qqqUp ? 30 : 0) + (spyUp ? 20 : 0) + (tp > 40 ? 20 : 0) + (cp > 55 ? 15 : 0) - (fr > 50 ? 20 : 0);
  const bearScore = (!qqqUp ? 30 : 0) + (!spyUp ? 20 : 0) + (tp > 40 ? 20 : 0) + (cp > 55 ? 15 : 0);

  if (bullScore >= 55) return 'strong_bull';
  if (bullScore >= 30) return 'bull';
  if (bearScore >= 55) return 'strong_bear';
  if (bearScore >= 30) return 'bear';
  return 'neutral';
}

const TREND_SV = {
  strong_bull: 'Stark upptrend',
  bull:        'Uppåtgående',
  neutral:     'Neutral/sidrörelse',
  bear:        'Nedåtgående',
  strong_bear: 'Stark nedtrend',
};

// ── 3. detectChoppyMarket ─────────────────────────────────────────────────────
function detectChoppyMarket(compass, personality) {
  const divergent = compass?.qqqTrend !== compass?.spyTrend;
  const pl    = (personality?.personalityLabel || '').toLowerCase();
  const fr    = personality?.fakeoutRisk        ?? 20;
  const tp    = personality?.trendPersistence   ?? 30;
  const bias  = compass?.bias || '';

  const isChoppy = pl.includes('choppy') || pl.includes('trap')
    || bias === 'MIXED'
    || (fr > 40 && tp < 25)
    || (divergent && fr > 30);

  const confidence = isChoppy
    ? clamp(Math.round((fr / 100) * 60 + (divergent ? 30 : 0) + (tp < 20 ? 20 : 0)), 0, 100)
    : 0;

  return { isChoppy, confidence, reason: isChoppy ? 'Motstridiga signaler och hög fakeoutrisk' : null };
}

// ── 4. detectRiskEnvironment ──────────────────────────────────────────────────
function detectRiskEnvironment(compass, personality) {
  if (compass?.riskOff) return 'risk_off';
  if (compass?.riskOn)  return 'risk_on';

  const qqqUp = compass?.qqqTrend === 'UP';
  const spyUp = compass?.spyTrend === 'UP';
  const mt    = personality?.marketTrustScore ?? 60;

  if (qqqUp && spyUp && mt >= 70) return 'risk_on';
  if (!qqqUp && !spyUp && mt < 50) return 'risk_off';
  return 'mixed';
}

const RISK_ENV_SV = {
  risk_on:  'Risk-On miljö',
  risk_off: 'Risk-Off miljö',
  mixed:    'Blandad riskmiljö',
};

// ── 5. detectMarketRegime ─────────────────────────────────────────────────────
function detectMarketRegime() {
  const compass   = loadJson(COMPASS_PATH) || {};
  const pStocks   = loadJson(PERSONALITY_STOCKS) || {};
  const pCrypto   = loadJson(PERSONALITY_CRYPTO) || {};

  const volState  = detectVolatilityState(pStocks);
  const trendState = detectTrendState(compass, pStocks);
  const choppyInfo = detectChoppyMarket(compass, pStocks);
  const riskEnv   = detectRiskEnvironment(compass, pStocks);

  // High volatility overrides most
  if (volState === 'extreme' || (volState === 'high' && choppyInfo.isChoppy)) {
    return REGIMES.HIGH_VOLATILITY;
  }

  // Risk environment strong signals
  if (riskEnv === 'risk_off' && compass?.riskOff) return REGIMES.RISK_OFF;
  if (riskEnv === 'risk_on'  && compass?.riskOn)  return REGIMES.RISK_ON;

  // Choppy wins over trend if strong signal
  if (choppyInfo.isChoppy && choppyInfo.confidence >= 60) return REGIMES.CHOPPY_MARKET;

  // High volatility (non-extreme)
  if (volState === 'high') return REGIMES.HIGH_VOLATILITY;

  // Low volatility
  if (volState === 'low') return REGIMES.LOW_VOLATILITY;

  // Strong directional trend
  if (trendState === 'strong_bull') return REGIMES.STRONG_BULL_TREND;
  if (trendState === 'strong_bear') return REGIMES.STRONG_BEAR_TREND;

  // Mild risk environment
  if (riskEnv === 'risk_on') return REGIMES.RISK_ON;
  if (riskEnv === 'risk_off') return REGIMES.RISK_OFF;

  // Choppy at lower confidence
  if (choppyInfo.isChoppy) return REGIMES.CHOPPY_MARKET;

  // Moderate trend
  if (trendState === 'bull') return REGIMES.STRONG_BULL_TREND;
  if (trendState === 'bear') return REGIMES.STRONG_BEAR_TREND;

  return REGIMES.MIXED_MARKET;
}

// ── 6. buildMarketBias ────────────────────────────────────────────────────────
function buildMarketBias() {
  const compass  = loadJson(COMPASS_PATH) || {};
  const pStocks  = loadJson(PERSONALITY_STOCKS) || {};
  const pCrypto  = loadJson(PERSONALITY_CRYPTO) || {};

  const qqqTrend = compass.qqqTrend || 'NEUTRAL';
  const spyTrend = compass.spyTrend || 'NEUTRAL';

  const cryptoCp = pCrypto.continuationProbability ?? 50;
  const stocksCp = pStocks.continuationProbability ?? 50;

  // Nasdaq proxy = QQQ
  const nasdaqBullish = qqqTrend === 'UP';
  const sp500Bullish  = spyTrend === 'UP';
  const cryptoBullish = cryptoCp >= 55;
  const stocksBullish = stocksCp >= 55;

  const bullCount = [nasdaqBullish, sp500Bullish, cryptoBullish, stocksBullish].filter(Boolean).length;

  let overall;
  if (bullCount >= 3) overall = 'bullish';
  else if (bullCount <= 1) overall = 'bearish';
  else overall = 'mixed';

  const lines = [];
  if (nasdaqBullish) lines.push('Nasdaq är bullish');
  else lines.push('QQQ är svag');
  if (sp500Bullish) lines.push('S&P 500 håller upp');
  else lines.push('S&P 500 är svag');
  if (compass.riskOff) lines.push('Risk-off miljö');
  else if (compass.riskOn) lines.push('Risk-on miljö');
  if (cryptoCp >= 60) lines.push('Krypto starkare än normalt');
  else if (cryptoCp < 40) lines.push('Krypto svagt');
  if (cryptoCp > stocksCp + 10) lines.push('Krypto starkare än aktier');
  else if (stocksCp > cryptoCp + 10) lines.push('Aktier starkare än krypto');

  return {
    nasdaq: {
      trend:     nasdaqBullish ? 'UP' : 'DOWN',
      strength:  clamp(Math.abs((pStocks.trendPersistence ?? 30)), 0, 100),
      label:     `QQQ ${nasdaqBullish ? 'stark' : 'svag'}`,
      bullish:   nasdaqBullish,
    },
    sp500: {
      trend:    sp500Bullish ? 'UP' : 'DOWN',
      strength: clamp(Math.round((pStocks.marketTrustScore ?? 60) * 0.6), 0, 100),
      label:    `S&P ${sp500Bullish ? 'stark' : 'svag'}`,
      bullish:  sp500Bullish,
    },
    iwm: {
      trend:    sp500Bullish ? 'UP' : 'DOWN',
      label:    `IWM ${sp500Bullish ? 'håller' : 'svag'}`,
      bullish:  sp500Bullish,
    },
    crypto: {
      trend:    cryptoBullish ? 'UP' : 'DOWN',
      strength: clamp(cryptoCp, 0, 100),
      label:    `Krypto ${cryptoBullish ? 'stark' : 'svag'}`,
      bullish:  cryptoBullish,
    },
    stocks: {
      trend:    stocksBullish ? 'UP' : 'DOWN',
      strength: clamp(stocksCp, 0, 100),
      label:    `Aktier ${stocksBullish ? 'stark' : 'svag'}`,
      bullish:  stocksBullish,
    },
    overall,
    summaryLines: lines,
    compassBias:  compass.bias || 'MIXED',
    riskOn:       compass.riskOn  || false,
    riskOff:      compass.riskOff || false,
    messageSv:    compass.messageSv || 'Ingen marknadsdata tillgänglig.',
  };
}

// ── 7. calculateStrategyWeights ───────────────────────────────────────────────
function calculateStrategyWeights(regime) {
  const r = regime || detectMarketRegime();
  const weights = REGIME_WEIGHTS[r] || {};

  const enriched = ALL_STRATEGY_KEYS.map(key => {
    const regimeAdj = weights[key] ?? 0;
    const total     = clamp(regimeAdj, -20, 20);
    const priority  = clamp(50 + total * 2.5, 0, 100);
    return {
      key,
      label:     STRATEGY_LABELS[key] || key,
      regimeAdj: total,
      priority:  Math.round(priority),
      direction: total > 0 ? 'boost' : total < 0 ? 'reduce' : 'neutral',
      reasonSv:  total > 5  ? `Passar bra i ${REGIME_META[r]?.labelSv || r}` :
                 total < -5 ? `Fungerar sämre i ${REGIME_META[r]?.labelSv || r}` :
                 'Normal prioritet',
    };
  });

  enriched.sort((a, b) => b.priority - a.priority);

  return {
    regime:          r,
    regimeLabelSv:   REGIME_META[r]?.labelSv || r,
    weights:         enriched,
    topStrategies:   enriched.filter(s => s.regimeAdj >= 8).map(s => s.key),
    bottomStrategies:enriched.filter(s => s.regimeAdj <= -8).map(s => s.key),
    warningStrategies:enriched.filter(s => s.regimeAdj <= -10).map(s => ({
      key: s.key, label: s.label, adj: s.regimeAdj,
      warningSv: `${s.label} är nedviktad i nuvarande marknad.`,
    })),
  };
}

// ── 8. calculateRegimeScore ───────────────────────────────────────────────────
function calculateRegimeScore() {
  const compass  = loadJson(COMPASS_PATH) || {};
  const pStocks  = loadJson(PERSONALITY_STOCKS) || {};

  const mt  = pStocks.marketTrustScore    ?? 60;
  const cp  = pStocks.continuationProbability ?? 50;
  const fr  = pStocks.fakeoutRisk         ?? 20;
  const vp  = pStocks.volatilityPressure  ?? 40;

  const directionAgree = compass.qqqTrend === compass.spyTrend;
  const freshnessAge   = pStocks.computedAt
    ? Math.max(0, (Date.now() - new Date(pStocks.computedAt).getTime()) / 60000)
    : 999;

  let score = 40;
  score += mt * 0.20;
  score += cp * 0.10;
  score -= fr * 0.10;
  score -= vp * 0.05;
  if (directionAgree)  score += 15;
  if (freshnessAge < 5) score += 10;
  else if (freshnessAge > 30) score -= 15;

  const finalScore = Math.round(clamp(score, 0, 100));
  return {
    score:      finalScore,
    confidence: finalScore >= 70 ? 'high' : finalScore >= 45 ? 'medium' : 'low',
    freshness:  freshnessAge < 5 ? 'fresh' : freshnessAge < 30 ? 'ok' : 'stale',
    staleMins:  Math.round(freshnessAge),
  };
}

// ── 9. Strategy performance by regime (from paper trades) ─────────────────────
function buildStrategyPerformanceByRegime() {
  const trades = loadTrades();
  if (!trades.length) return { byRegime: {}, byStrategy: {}, totalTrades: 0 };

  const byRegime    = {};
  const byStrategy  = {};

  // 90-day window for regime-specific analysis
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;

  for (const t of trades) {
    if (!t.result) continue;
    const ts = t.entryTime ? new Date(t.entryTime).getTime() : 0;
    if (ts && ts < cutoff) continue;

    const oldRegime = t.marketRegimeV2 || t.marketContext?.regime || 'UNKNOWN';
    const newRegime = mapOldRegimeToNew(oldRegime);
    const stratKey  = signalFamilyToStrategyKey(t.signalFamily, t.signalSubtype);

    const win  = t.result === 'WIN'     ? 1 : 0;
    const loss = t.result === 'LOSS'    ? 1 : 0;
    const tout = t.result === 'TIMEOUT' ? 1 : 0;
    const pnl  = t.pnlPct ?? 0;

    // By regime
    if (!byRegime[newRegime]) byRegime[newRegime] = { wins: 0, losses: 0, timeouts: 0, trades: 0, pnl: 0, strategies: {} };
    byRegime[newRegime].wins     += win;
    byRegime[newRegime].losses   += loss;
    byRegime[newRegime].timeouts += tout;
    byRegime[newRegime].trades   += 1;
    byRegime[newRegime].pnl      += pnl;

    // By strategy within regime
    if (stratKey) {
      if (!byRegime[newRegime].strategies[stratKey]) {
        byRegime[newRegime].strategies[stratKey] = { wins: 0, losses: 0, timeouts: 0, trades: 0, pnl: 0 };
      }
      const sr = byRegime[newRegime].strategies[stratKey];
      sr.wins += win; sr.losses += loss; sr.timeouts += tout; sr.trades += 1; sr.pnl += pnl;
    }

    // By strategy overall
    if (stratKey) {
      if (!byStrategy[stratKey]) byStrategy[stratKey] = { wins: 0, losses: 0, timeouts: 0, trades: 0, pnl: 0, byRegime: {} };
      byStrategy[stratKey].wins     += win;
      byStrategy[stratKey].losses   += loss;
      byStrategy[stratKey].timeouts += tout;
      byStrategy[stratKey].trades   += 1;
      byStrategy[stratKey].pnl      += pnl;

      if (!byStrategy[stratKey].byRegime[newRegime]) {
        byStrategy[stratKey].byRegime[newRegime] = { wins: 0, losses: 0, timeouts: 0, trades: 0, pnl: 0 };
      }
      const br = byStrategy[stratKey].byRegime[newRegime];
      br.wins += win; br.losses += loss; br.timeouts += tout; br.trades += 1; br.pnl += pnl;
    }
  }

  // Compute win rates
  const summarize = (obj) => {
    const { wins, losses, timeouts, trades, pnl } = obj;
    return {
      ...obj,
      winRate:     trades > 0 ? Math.round((wins / trades) * 100) : null,
      timeoutRate: trades > 0 ? Math.round((timeouts / trades) * 100) : null,
      avgPnl:      trades > 0 ? Math.round((pnl / trades) * 1000) / 1000 : null,
    };
  };

  for (const regime of Object.keys(byRegime)) {
    byRegime[regime] = summarize(byRegime[regime]);
    for (const strat of Object.keys(byRegime[regime].strategies)) {
      byRegime[regime].strategies[strat] = summarize(byRegime[regime].strategies[strat]);
    }
  }
  for (const strat of Object.keys(byStrategy)) {
    byStrategy[strat] = summarize(byStrategy[strat]);
    for (const regime of Object.keys(byStrategy[strat].byRegime)) {
      byStrategy[strat].byRegime[regime] = summarize(byStrategy[strat].byRegime[regime]);
    }
  }

  return { byRegime, byStrategy, totalTrades: trades.length };
}

// ── 10. Market heatmap ────────────────────────────────────────────────────────
function buildMarketHeatmap() {
  const compass  = loadJson(COMPASS_PATH) || {};
  const pStocks  = loadJson(PERSONALITY_STOCKS) || {};
  const pCrypto  = loadJson(PERSONALITY_CRYPTO) || {};

  const cryptoCp = pCrypto.continuationProbability ?? 50;
  const stocksCp = pStocks.continuationProbability ?? 50;
  const cryptoVP = pCrypto.volatilityPressure      ?? 40;
  const stocksVP = pStocks.volatilityPressure      ?? 40;
  const qqqUp    = compass.qqqTrend === 'UP';
  const spyUp    = compass.spyTrend === 'UP';

  function bias(cp, trend, fr) {
    if (cp >= 60 && trend) return 'bullish';
    if (cp <= 40 && !trend) return 'bearish';
    return 'neutral';
  }
  function vol(vp) {
    if (vp > 60) return 'high';
    if (vp < 25) return 'low';
    return 'normal';
  }

  return [
    {
      market:   'Krypto',
      icon:     '₿',
      bias:     bias(cryptoCp, cryptoCp >= 55, pCrypto.fakeoutRisk ?? 20),
      volatility: vol(cryptoVP),
      strength: Math.round(cryptoCp),
      sigDensity: pCrypto.raw?.triggeredCount ?? 0,
      trustScore: pCrypto.marketTrustScore ?? 70,
    },
    {
      market:   'Nasdaq',
      icon:     '📈',
      bias:     qqqUp ? (stocksCp >= 55 ? 'bullish' : 'neutral') : 'bearish',
      volatility: vol(stocksVP),
      strength: qqqUp ? Math.min(80, Math.round(stocksCp)) : Math.max(20, Math.round(100 - stocksCp)),
      sigDensity: Math.round((pStocks.raw?.triggeredCount ?? 0) * 0.6),
      trustScore: pStocks.marketTrustScore ?? 70,
    },
    {
      market:   'S&P 500',
      icon:     '🏦',
      bias:     spyUp ? 'bullish' : 'bearish',
      volatility: vol(stocksVP * 0.8),
      strength: spyUp ? 62 : 38,
      sigDensity: Math.round((pStocks.raw?.triggeredCount ?? 0) * 0.4),
      trustScore: pStocks.marketTrustScore ?? 70,
    },
    {
      market:   'ETF',
      icon:     '🧺',
      bias:     (qqqUp && spyUp) ? 'bullish' : (!qqqUp && !spyUp) ? 'bearish' : 'neutral',
      volatility: vol(stocksVP * 0.7),
      strength: qqqUp && spyUp ? 65 : !qqqUp && !spyUp ? 35 : 50,
      sigDensity: 0,
      trustScore: Math.round((pStocks.marketTrustScore ?? 70) * 0.9),
    },
    {
      market:   'Mag 7',
      icon:     '⭐',
      bias:     qqqUp ? (stocksCp >= 60 ? 'bullish' : 'neutral') : 'bearish',
      volatility: vol(stocksVP * 1.2),
      strength: qqqUp ? Math.min(85, Math.round(stocksCp * 1.1)) : Math.max(15, Math.round((100 - stocksCp) * 0.9)),
      sigDensity: Math.round((pStocks.raw?.triggeredCount ?? 0) * 0.3),
      trustScore: pStocks.marketTrustScore ?? 70,
    },
  ];
}

// ── 11. Adaptive AI recommendations ──────────────────────────────────────────
function buildAdaptiveRecommendations(regime, strategyWeights, perfData, bias) {
  const recs = [];
  const meta = REGIME_META[regime] || {};

  // Regime summary
  recs.push({
    type:     'regime',
    priority: 'high',
    icon:     meta.icon || '🟡',
    textSv:   `${meta.labelSv || regime} — ${meta.descSv || ''}`,
  });

  // Top strategy recommendations
  if (strategyWeights.topStrategies?.length) {
    const top = strategyWeights.topStrategies.slice(0, 2).map(k => STRATEGY_LABELS[k] || k).join(' och ');
    recs.push({
      type:     'strategy_boost',
      priority: 'medium',
      icon:     '🚀',
      textSv:   `${top} prioriteras i nuvarande marknad.`,
    });
  }

  // Bottom strategy warnings
  for (const w of (strategyWeights.warningStrategies || []).slice(0, 2)) {
    // Check actual performance
    const stratPerf = perfData.byStrategy?.[w.key];
    const wr = stratPerf?.winRate;
    recs.push({
      type:     'strategy_warn',
      priority: 'medium',
      icon:     '⚠️',
      textSv:   wr !== null && wr !== undefined
        ? `${w.label}: ${wr}% träffsäkerhet senaste perioden. Fungerar sämre i nuvarande marknad.`
        : `${w.label} är nedviktad i nuvarande marknad.`,
    });
  }

  // Risk-off warning
  if (bias.riskOff) {
    recs.push({
      type:     'risk_warning',
      priority: 'high',
      icon:     '🔴',
      textSv:   'Risk-off marknad — sänk confidence och undvik bullish setups.',
    });
  }

  // Volatility warning
  const volState = detectVolatilityState(loadJson(PERSONALITY_STOCKS) || {});
  if (volState === 'high' || volState === 'extreme') {
    recs.push({
      type:     'volatility',
      priority: 'high',
      icon:     '🟠',
      textSv:   'Hög volatilitet — använd tight stop loss och kortare hålltid.',
    });
  }

  // Choppy warning
  if (regime === 'CHOPPY_MARKET') {
    recs.push({
      type:     'choppy',
      priority: 'medium',
      icon:     '🟡',
      textSv:   'Stökig marknad — momentum- och breakout-strategier fungerar sämre. Välj selektivt.',
    });
  }

  // Index divergence
  if (bias.nasdaq?.trend !== bias.sp500?.trend) {
    recs.push({
      type:     'index_divergence',
      priority: 'low',
      icon:     '⚡',
      textSv:   `Nasdaq och S&P pekar åt olika håll — lägre confidence på index-relaterade setups.`,
    });
  }

  // Momentum vs mean reversion comparison
  const vwapPerf = perfData.byStrategy?.vwap_reclaim?.winRate;
  const mrPerf   = perfData.byStrategy?.mean_reversion?.winRate;
  if (vwapPerf !== null && mrPerf !== null && vwapPerf !== undefined && mrPerf !== undefined) {
    if (vwapPerf > mrPerf + 20) {
      recs.push({
        type:     'performance_insight',
        priority: 'low',
        icon:     '📊',
        textSv:   `VWAP-återtagning (${vwapPerf}% WR) fungerar mycket bättre än mean reversion (${mrPerf}% WR) just nu.`,
      });
    } else if (mrPerf > vwapPerf + 20) {
      recs.push({
        type:     'performance_insight',
        priority: 'low',
        icon:     '📊',
        textSv:   `Mean reversion (${mrPerf}% WR) fungerar bättre än VWAP-strategier (${vwapPerf}% WR) just nu.`,
      });
    }
  }

  return recs;
}

// ── 12. Regime history ────────────────────────────────────────────────────────
let lastHistorySaveAt = 0;
const HISTORY_SAVE_COOLDOWN_MS = 5 * 60 * 1000;

function saveRegimeSnapshot(summary) {
  if (Date.now() - lastHistorySaveAt < HISTORY_SAVE_COOLDOWN_MS) return;
  try {
    const history = loadHistory();
    history.push({
      ts:      new Date().toISOString(),
      regime:  summary.regime,
      score:   summary.regimeScore?.score,
      bias:    summary.indexBias?.overall,
      vol:     summary.volatilityState,
      trend:   summary.trendState,
    });
    // Keep last 200
    const trimmed = history.slice(-200);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
    lastHistorySaveAt = Date.now();
  } catch {}
}

// ── 13. buildRegimeSummary — main aggregate ───────────────────────────────────
let summaryCache   = null;
let summaryCachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function buildRegimeSummary(force = false) {
  if (!force && summaryCache && (Date.now() - summaryCachedAt) < CACHE_TTL_MS) {
    return summaryCache;
  }

  const regime    = detectMarketRegime();
  const meta      = REGIME_META[regime] || {};
  const bias      = buildMarketBias();
  const volState  = detectVolatilityState(loadJson(PERSONALITY_STOCKS) || {});
  const trendState = detectTrendState(loadJson(COMPASS_PATH) || {}, loadJson(PERSONALITY_STOCKS) || {});
  const riskEnv   = detectRiskEnvironment(loadJson(COMPASS_PATH) || {}, loadJson(PERSONALITY_STOCKS) || {});
  const chopInfo  = detectChoppyMarket(loadJson(COMPASS_PATH) || {}, loadJson(PERSONALITY_STOCKS) || {});
  const regScore  = calculateRegimeScore();
  const stratW    = calculateStrategyWeights(regime);
  const perfData  = buildStrategyPerformanceByRegime();
  const heatmap   = buildMarketHeatmap();
  const recs      = buildAdaptiveRecommendations(regime, stratW, perfData, bias);

  const summary = {
    ok:            true,
    computedAt:    new Date().toISOString(),
    regime,
    regimeMeta:    meta,
    regimeLabelSv: meta.labelSv || regime,
    regimeIcon:    meta.icon || '🟡',
    regimeScore:   regScore,
    volatilityState:   volState,
    volatilityLabelSv: VOLATILITY_SV[volState] || volState,
    trendState,
    trendLabelSv:  TREND_SV[trendState] || trendState,
    riskEnvironment:   riskEnv,
    riskEnvLabelSv:    RISK_ENV_SV[riskEnv] || riskEnv,
    isChoppy:      chopInfo.isChoppy,
    indexBias:     bias,
    strategyWeights: stratW,
    strategyPerformance: perfData,
    heatmap,
    recommendations: recs,
    ...SAFETY,
  };

  summaryCache   = summary;
  summaryCachedAt = Date.now();

  saveRegimeSnapshot(summary);

  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(summary, null, 2)); } catch {}

  return summary;
}

function getRegimeHistory() {
  const history = loadHistory();
  return { ok: true, history, count: history.length, ...SAFETY };
}

function getRegimeStrategies() {
  const regime = detectMarketRegime();
  const weights = calculateStrategyWeights(regime);
  const perf    = buildStrategyPerformanceByRegime();

  const enrichedWeights = weights.weights.map(s => {
    const sp = perf.byStrategy?.[s.key];
    return {
      ...s,
      winRate:     sp?.winRate     ?? null,
      timeoutRate: sp?.timeoutRate ?? null,
      avgPnl:      sp?.avgPnl     ?? null,
      samples:     sp?.trades     ?? 0,
      underperforming: sp?.winRate !== null && sp?.winRate !== undefined && sp.winRate < 35 && sp.trades >= 5,
    };
  });

  return { ok: true, regime, strategies: enrichedWeights, ...SAFETY };
}

module.exports = {
  SAFETY,
  REGIMES,
  REGIME_META,
  REGIME_WEIGHTS,
  STRATEGY_LABELS,
  detectMarketRegime,
  buildMarketBias,
  calculateStrategyWeights,
  calculateRegimeScore,
  detectVolatilityState,
  detectTrendState,
  detectChoppyMarket,
  detectRiskEnvironment,
  buildRegimeSummary,
  buildStrategyPerformanceByRegime,
  buildMarketHeatmap,
  buildAdaptiveRecommendations,
  getRegimeHistory,
  getRegimeStrategies,
};
