'use strict';
const fs   = require('fs');
const path = require('path');

const COMPASS_FILE = path.join(__dirname, '../../data/market-compass.json');

let _cache = null;

function computeSymbolTrend(result) {
  if (!result || !result.price) return 'UNKNOWN';
  const price = result.price;
  const ema9  = result.ema9  ?? null;
  const ema21 = result.ema21 ?? null;
  const vwap  = result.vwap  ?? null;
  const sma20 = result.sma20 ?? null;

  let upSignals = 0, downSignals = 0, total = 0;
  if (ema9  != null) { total++; if (price > ema9)  upSignals++; else downSignals++; }
  if (ema21 != null) { total++; if (price > ema21) upSignals++; else downSignals++; }
  if (vwap  != null) { total++; if (price > vwap)  upSignals++; else downSignals++; }
  if (sma20 != null) { total++; if (price > sma20) upSignals++; else downSignals++; }

  if (total === 0) return 'UNKNOWN';
  if (upSignals > downSignals) return 'UP';
  if (downSignals > upSignals) return 'DOWN';
  return 'NEUTRAL';
}

function buildCompass(stockResults) {
  const qqq = (stockResults || []).find(r => r.symbol === 'QQQ');
  const spy = (stockResults || []).find(r => r.symbol === 'SPY');

  const qqqTrend = computeSymbolTrend(qqq);
  const spyTrend = computeSymbolTrend(spy);

  const riskOn  = qqqTrend === 'UP'   && spyTrend === 'UP';
  const riskOff = qqqTrend === 'DOWN' && spyTrend === 'DOWN';

  return {
    updatedAt:     new Date().toISOString(),
    qqqTrend,
    spyTrend,
    qqqPrice:      qqq?.price ?? null,
    spyPrice:      spy?.price ?? null,
    riskOn,
    riskOff,
    bias:          riskOn ? 'RISK_ON' : riskOff ? 'RISK_OFF' : 'MIXED',
    longBiasHint:  riskOff ? 'lower'  : 'normal',
    shortBiasHint: riskOn  ? 'lower'  : 'normal',
    messageSv: riskOn
      ? 'QQQ och SPY pekar uppåt — marknaden ser risk-on ut.'
      : riskOff
        ? 'QQQ och SPY pekar nedåt — marknaden verkar risk-off. Long-signaler i aktier får lägre prioritet.'
        : 'Blandad marknadsbild — ingen tydlig riktning.',
  };
}

function saveCompass(compass) {
  try {
    const dir = path.dirname(COMPASS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COMPASS_FILE, JSON.stringify(compass, null, 2), 'utf8');
    _cache = compass;
  } catch { /* ignore write errors */ }
}

function getMarketCompass() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(COMPASS_FILE, 'utf8'));
    return _cache;
  } catch {
    return null;
  }
}

function computeAndSaveCompass(stockResults) {
  try {
    const compass = buildCompass(stockResults);
    saveCompass(compass);
    return compass;
  } catch { return null; }
}

module.exports = { computeAndSaveCompass, getMarketCompass };
