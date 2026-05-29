'use strict';
const fs   = require('fs');
const path = require('path');

const SAFETY = Object.freeze({
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  agent_mode: 'config_only',
});

const PRESETS_FILE = '/var/www/nasdaq-scanner/data/config/strategy-presets.json';

const STRATEGY_CATALOG = [
  { key: 'vwap_reclaim',            label: 'VWAP-återtagning',         group: 'classic', scoreImpact: '+8',  desc: 'Pris återtar VWAP',                       paperOnly: false },
  { key: 'vwap_rejection',          label: 'VWAP-avvisning',           group: 'classic', scoreImpact: '+6',  desc: 'Pris avvisas vid VWAP',                   paperOnly: false },
  { key: 'ema_trend',               label: 'EMA-trend',                group: 'classic', scoreImpact: '+5',  desc: 'EMA-baserad trendföljning',               paperOnly: false },
  { key: 'ema_pullback',            label: 'EMA-rekyl',                group: 'classic', scoreImpact: '+4',  desc: 'Rekyl mot EMA i befintlig trend',         paperOnly: false },
  { key: 'narrow_state',            label: 'Narrow State',             group: 'classic', scoreImpact: '+10', desc: 'Marknaden i smalt konsolideringstillstånd', paperOnly: false },
  { key: 'breakout',                label: 'Utbrott',                  group: 'classic', scoreImpact: '+7',  desc: 'Pris bryter ut ur konsolidering',         paperOnly: false },
  { key: 'momentum',                label: 'Momentum',                 group: 'classic', scoreImpact: '+6',  desc: 'Starkt riktat prismomentum',              paperOnly: false },
  { key: 'mean_reversion',          label: 'Rekyl·Medelvärde',         group: 'classic', scoreImpact: '+4',  desc: 'Pris reverterar mot medelvärde',          paperOnly: false },
  { key: 'volume_spike',            label: 'Volymtopp',                group: 'classic', scoreImpact: '+8',  desc: 'Ovanlig volymtopp som förstärker signal', paperOnly: false },

  {
    key: 'vwap_momentum',
    label: 'VWAP Momentum',
    group: 'new',
    scoreImpact: '+10',
    holdingTime: '0–8 min',
    stopLoss: 'Tight (<0.15%)',
    volumeReq: 'Stark',
    desc: 'Pris återtar VWAP med stark volym — kort hålltid tight SL',
    explanation: 'Kärnan i systemet — VWAP + stark volym ger högst win rate',
    paperOnly: true,
  },
  {
    key: 'vwap_rejection_short',
    label: 'VWAP Rejection Short',
    group: 'new',
    scoreImpact: '+8',
    holdingTime: '0–10 min',
    stopLoss: 'Tight (<0.15%)',
    volumeReq: 'Stark',
    desc: 'Pris avvisas vid VWAP med nedåtriktning',
    explanation: 'Short-version av VWAP-setup — bearish momentum',
    paperOnly: true,
  },
  {
    key: 'opening_range_breakout',
    label: 'Opening Range Breakout',
    group: 'new',
    scoreImpact: '+12',
    holdingTime: '5–30 min',
    stopLoss: 'Medium (0.15–0.20%)',
    volumeReq: 'Hög',
    desc: 'Utbrott över/under första 5/15/30-minutersrange med volymkrav',
    explanation: 'Starkt på aktier vid öppning — kräver extra volym',
    paperOnly: true,
  },
  {
    key: 'pullback_continuation',
    label: 'Pullback Continuation',
    group: 'new',
    scoreImpact: '+8',
    holdingTime: '5–15 min',
    stopLoss: 'Medium',
    volumeReq: 'Medel',
    desc: 'Etablerad trend rekyl och återtar riktning',
    explanation: 'Trend + rekyl — bra combo med EMA-trend',
    paperOnly: true,
  },
  {
    key: 'mean_reversion_vwap',
    label: 'Mean Reversion (VWAP)',
    group: 'new',
    scoreImpact: '+6',
    holdingTime: '5–20 min',
    stopLoss: 'Medium',
    volumeReq: 'Medel',
    desc: 'Pris har rört sig långt från VWAP — söker tillbaka',
    explanation: 'Contrarian-setup — bra när trend är utmattad',
    paperOnly: true,
  },
  {
    key: 'volume_spike_momentum',
    label: 'Volume Spike Momentum',
    group: 'new',
    scoreImpact: '+10',
    holdingTime: '0–8 min',
    stopLoss: 'Tight',
    volumeReq: 'Extremt hög (3x+)',
    desc: 'Ovanligt hög volym med snabb rörelse — kort hålltid',
    explanation: 'Extremt selektiv — bara när volym är 3x+ normalt',
    paperOnly: true,
  },
  {
    key: 'index_trend_mode',
    label: 'Index Trend Mode',
    group: 'new',
    scoreImpact: '+5 om index stödjer',
    desc: 'QQQ/SPY styr — aktier får signal bara om index stödjer',
    explanation: 'TSLA bullish men QQQ svag → varning',
    paperOnly: true,
  },
  {
    key: 'sector_confirmation',
    label: 'Sector Confirmation',
    group: 'new',
    scoreImpact: '+4 om sektor stödjer',
    desc: 'Aktie får pluspoäng om sektor håller med',
    explanation: 'Extra konfidensboost från sektorn',
    paperOnly: true,
  },
  {
    key: 'news_volatility_watch',
    label: 'News/Volatility Watch',
    group: 'new',
    scoreImpact: 'Varning/kandidat',
    desc: 'Hög volatilitet ger varning eller kandidat för bevakning',
    explanation: 'Passiv — flaggar hög volatilitet utan att skapa trade',
    paperOnly: true,
  },
];

const BUILT_IN_PRESETS = [
  {
    id: 'vwap_scalper',
    name: 'VWAP Scalper',
    icon: '⚡',
    description: 'VWAP + volym kort hålltid tight SL',
    toggles: { vwap_reclaim: true, vwap_rejection: true, volume_spike: true, vwap_momentum: true, narrow_state: false, ema_trend: false, ema_pullback: false },
    params: { stop_loss: 0.12, holding_time: 8, timeout: 8, confidence_threshold: 65 },
    exits: { trailing_stop: true, profit_target: true, time_exit: false },
    blockerMode: 'tight',
  },
  {
    id: 'index_stocks',
    name: 'Index-confirmed Stocks',
    icon: '📈',
    description: 'Aktier + index som filter',
    toggles: { vwap_reclaim: true, narrow_state: true, index_trend_mode: true, sector_confirmation: true, ai_agent: true },
    params: { confidence_threshold: 65, holding_time: 15 },
    exits: { profit_target: true, trailing_stop: true },
    blockerMode: 'tight',
  },
  {
    id: 'crypto_momentum',
    name: 'Crypto Momentum',
    icon: '₿',
    description: 'Krypto med momentumfokus',
    toggles: { vwap_reclaim: true, momentum: true, volume_spike: true, volume_spike_momentum: true, narrow_state: true },
    params: { stop_loss: 0.15, holding_time: 10, confidence_threshold: 60 },
    exits: { trailing_stop: true, profit_target: true },
    blockerMode: 'medium',
  },
  {
    id: 'loose_discovery',
    name: 'Loose Discovery',
    icon: '🔬',
    description: 'Fler signaler — samla mer data',
    toggles: { vwap_reclaim: true, vwap_rejection: true, narrow_state: true, breakout: true, momentum: true, volume_spike: true, vwap_momentum: true, opening_range_breakout: true },
    params: { confidence_threshold: 40, holding_time: 15 },
    exits: { profit_target: true, trailing_stop: true, time_exit: true },
    blockerMode: 'loose',
    discoveryMode: true,
  },
  {
    id: 'tight_scalp',
    name: 'Tight Risk Scalping',
    icon: '🎯',
    description: 'Maximal skydd — bara bästa signalerna',
    toggles: { vwap_reclaim: true, narrow_state: true, vwap_momentum: true, volume_spike: true, ai_agent: true, risk_engine: true, safety_engine: true },
    params: { stop_loss: 0.10, holding_time: 5, confidence_threshold: 75, timeout: 5 },
    exits: { trailing_stop: true, profit_target: true, time_exit: false },
    blockerMode: 'tight',
  },
  {
    id: 'opening_range_test',
    name: 'Opening Range Test',
    icon: '🔔',
    description: 'Opening Range Breakout aktier vid öppning',
    toggles: { opening_range_breakout: true, volume_spike: true, breakout: true },
    params: { confidence_threshold: 60, holding_time: 20 },
    exits: { profit_target: true, trailing_stop: true },
    blockerMode: 'medium',
  },
];

function loadCustomPresets() {
  try {
    const raw = fs.readFileSync(PRESETS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

function savePresetsFile(presets) {
  fs.mkdirSync(path.dirname(PRESETS_FILE), { recursive: true });
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8');
}

function getCatalog() {
  return {
    strategies: STRATEGY_CATALOG,
    newStrategies: STRATEGY_CATALOG.filter(s => s.group === 'new'),
    classicStrategies: STRATEGY_CATALOG.filter(s => s.group === 'classic'),
    ...SAFETY,
  };
}

function getPresets() {
  return {
    builtIn: BUILT_IN_PRESETS,
    custom: loadCustomPresets(),
    ...SAFETY,
  };
}

function saveCustomPreset(preset) {
  const presets = loadCustomPresets();
  const idx = presets.findIndex(p => p.id === preset.id);
  if (idx !== -1) {
    presets[idx] = preset;
  } else {
    presets.push(preset);
  }
  savePresetsFile(presets);
  return { ok: true, preset, ...SAFETY };
}

function deleteCustomPreset(id) {
  const presets = loadCustomPresets().filter(p => p.id !== id);
  savePresetsFile(presets);
  return { ok: true, ...SAFETY };
}

module.exports = {
  SAFETY,
  STRATEGY_CATALOG,
  BUILT_IN_PRESETS,
  getCatalog,
  getPresets,
  saveCustomPreset,
  deleteCustomPreset,
};
