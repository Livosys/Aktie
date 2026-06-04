import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReplayPage from './ReplayPage.jsx';
import ReviewChartPage from './ReviewChartPage.jsx';
import IntelligencePage from './IntelligencePage.jsx';
import { AdvancedModeToggle, ConfigScopeBadge, PlatformEmptyState, PlatformSafetyBar, useAdvancedMode } from '../components/PlatformControls.jsx';
import {
  DEFAULT_TRADING_LAB_EXITS as DEFAULT_EXITS,
  DEFAULT_TRADING_LAB_PARAMS as DEFAULT_PARAMS,
  DEFAULT_TRADING_LAB_TOGGLES as DEFAULT_TOGGLES,
  useUnifiedConfig,
} from '../hooks/useUnifiedConfig.js';
import { SignalAge, TradingViewLink } from '../shared.jsx';

// ── Default configs ───────────────────────────────────────────────────────────
const TOGGLE_META = [
  { key: 'vwap_reclaim',      label: 'VWAP-återtagning',   group: 'signal', desc: 'Priset tar tillbaka VWAP uppifrån — bullish momentum' },
  { key: 'vwap_rejection',    label: 'VWAP-avvisning',     group: 'signal', desc: 'Priset studsar från VWAP — bearish momentum' },
  { key: 'ema_trend',         label: 'EMA-trend',          group: 'signal', desc: 'Signal baserad på EMA-trendriktning' },
  { key: 'ema_pullback',      label: 'EMA-rekyl',          group: 'signal', desc: 'Pris rör sig mot EMA och studsar tillbaka' },
  { key: 'narrow_state',      label: 'Narrow State',       group: 'signal', desc: 'Priset är ihoptryckt — klassiskt mönster' },
  { key: 'breakout',          label: 'Utbrott',            group: 'signal', desc: 'Priset bryter ut ur ett konsolideringsläge' },
  { key: 'momentum',          label: 'Stark rörelse',           group: 'signal', desc: 'Stark fart i en riktning bekräftar rörelsen' },
  { key: 'mean_reversion',    label: 'Rekyl/medelvärde',   group: 'signal', desc: 'Priset är för långt ifrån snittet och kan studsa' },
  { key: 'volume_spike',      label: 'Volymtopp',          group: 'signal', desc: 'Ovanligt hög volym — bekräftar signalen' },
  { key: 'ai_agent',          label: 'Analys',              group: 'ai',    desc: 'Analysmotorn granskar signalens kontext och styrka' },
  { key: 'trading_agents',    label: 'Tradingagenter',     group: 'ai',    desc: 'Specialiserade agenter med rollbaserad analys' },
  { key: 'historical_memory', label: 'Historiskt minne',   group: 'ai',    desc: 'Systemet minns vad som fungerat historiskt' },
  { key: 'market_gate',       label: 'Marknadsgrind',      group: 'protection', desc: 'Blockerar signaler om marknaden är för stökig' },
  { key: 'risk_engine',       label: 'Riskmotor',          group: 'protection', desc: 'Utvärderar risk per trade och position' },
  { key: 'safety_engine',     label: 'Säkerhetsmotor',     group: 'protection', desc: 'Sista skyddslagret — blockerar osäkra lägen' },
];

const EXIT_TYPES = [
  { key: 'trailing_stop',   label: 'Trailing Stop',   desc: 'Stop-loss följer priset uppåt — låser in vinst', defaultOn: true },
  { key: 'time_exit',       label: 'Tidsbaserad exit', desc: 'Stäng efter en viss tid oavsett resultat',       defaultOn: true },
  { key: 'ema_exit',        label: 'EMA-exit',        desc: 'Stäng om priset faller under EMA',               defaultOn: false },
  { key: 'vwap_exit',       label: 'VWAP-exit',       desc: 'Stäng om priset tappar VWAP',                    defaultOn: false },
  { key: 'profit_target',   label: 'Vinstmål',        desc: 'Stäng när vinstmål nås',                         defaultOn: true },
  { key: 'dynamic_exit',    label: 'Dynamisk exit',   desc: 'Dynamisk exit baserat på marknadsläget',          defaultOn: false },
  { key: 'volatility_exit', label: 'Volatilitetsxit', desc: 'Stäng om volatiliteten ökar kraftigt',           defaultOn: false },
];

const COMBOS = [
  { label: 'VWAP + Volym',         keys: ['vwap_reclaim', 'volume_spike'],          hint: 'Klassiskt mönster — VWAP med volymbekräftelse' },
  { label: 'Narrow + AI',          keys: ['narrow_state', 'ai_agent'],              hint: 'AI analyserar narrow state-mönster' },
  { key: 'ema_pullback',
    label: 'EMA + Rekyl',          keys: ['ema_trend', 'ema_pullback'],             hint: 'Trend plus rekyl mot EMA' },
  { label: 'VWAP + Trend + Analys', keys: ['vwap_reclaim', 'ema_trend', 'ai_agent'], hint: 'Kombinerat tekniskt stöd' },
  { label: 'Breakout + Volym',     keys: ['breakout', 'volume_spike'],              hint: 'Utbrott bekräftat av volym' },
  { label: 'Narrow + Stark rörelse',    keys: ['narrow_state', 'momentum'],              hint: 'Ihoptryckt pris + fart' },
];

const SLIDER_META = {
  stop_loss: {
    label: 'Max förlust',
    desc: 'Hur mycket priset får gå emot traden innan den stängs.',
    raise: 'Du vill ge traden mer utrymme.',
    lower: 'Du vill stoppa dåliga trades snabbare.',
    risk: 'Högre stop loss betyder större möjlig förlust.',
    riskLevel: 'high',
    recommended: 'För snabba trades: 0.15%-0.30%',
    min: 0.1,
    max: 5,
    step: 0.1,
    defaultValue: 1.5,
    format: v => `${Number(v).toFixed(1)}%`,
  },
  take_profit: {
    label: 'Vinstmål',
    desc: 'Här väljer du hur stor vinst systemet ska sikta på. 1R betyder samma storlek som risken. 2R betyder dubbelt så mycket som risken.',
    raise: 'Du vill sikta på större vinnare.',
    lower: 'Du vill att fler test-trades ska kunna nå målet snabbare.',
    risk: 'Stort vinstmål kan göra att färre trades når målet.',
    riskLevel: 'medium',
    recommended: 'För snabba trades: 1R-3R',
    min: 0.5,
    max: 10,
    step: 0.5,
    defaultValue: 3,
    format: v => `${Number(v).toFixed(1).replace('.0', '')}R`,
  },
  confidence_threshold: {
    label: 'Minsta signalstyrka',
    desc: 'Hur stark signalen måste vara för att systemet ska testa den.',
    raise: 'Du vill ha färre men starkare signaler.',
    lower: 'Du vill testa fler signaler.',
    risk: 'Lågt värde kan släppa igenom fler svaga signaler.',
    riskLevel: 'medium',
    recommended: 'Normal test: 55-75/100',
    min: 40,
    max: 95,
    step: 1,
    defaultValue: 60,
    format: v => `${Math.round(Number(v))}/100`,
  },
  holding_time: {
    label: 'Max tid i trade',
    desc: 'Här bestämmer du hur länge en test-trade får vara öppen.',
    raise: 'Du vill ge setupen mer tid att utvecklas.',
    lower: 'Du testar snabbare trades eller scalping.',
    risk: 'Lång hålltid kan ge fler timeout eller svagare scalping-resultat.',
    riskLevel: 'medium',
    recommended: 'Scalping: 5-45 min',
    min: 1,
    max: 240,
    step: 1,
    defaultValue: 30,
    format: v => formatDuration(v),
  },
  cooldown: {
    label: 'Paus mellan trades',
    desc: 'Hindrar systemet från att ta många trades direkt efter varandra på samma symbol.',
    raise: 'Du vill minska överhandel och upprepade test på samma symbol.',
    lower: 'Du vill testa fler möjligheter snabbare.',
    risk: 'Kort paus kan ge många liknande test-trades i rad.',
    riskLevel: 'low',
    recommended: 'Normal test: 5-20 min',
    min: 0,
    max: 60,
    step: 1,
    defaultValue: 5,
    format: v => Number(v) === 0 ? 'Ingen' : `${Math.round(Number(v))} min`,
  },
  volume_filter: {
    label: 'Minsta volym',
    desc: 'Systemet kräver att volymen är tillräckligt stark innan signalen testas.',
    raise: 'Du vill kräva tydligare aktivitet i symbolen.',
    lower: 'Du vill testa fler signaler även när volymen är svagare.',
    risk: 'Lågt volymkrav kan släppa in svaga signaler.',
    riskLevel: 'medium',
    recommended: 'Normal test: 1.0x-2.0x',
    min: 0.5,
    max: 3,
    step: 0.1,
    defaultValue: 1,
    format: v => `${Number(v).toFixed(1)}x`,
  },
  risk_per_trade: {
    label: 'Test-risk per trade',
    desc: 'Hur stor del av testkapitalet som riskeras i simuleringen.',
    raise: 'Du vill se hur profilen beter sig med större simulerad risk.',
    lower: 'Du vill testa försiktigare kapitalpåverkan.',
    risk: 'Hög risk per trade är endast för test.',
    riskLevel: 'high',
    recommended: 'För test: 0.25%-1.0%',
    min: 0.1,
    max: 5,
    step: 0.1,
    defaultValue: 1,
    format: v => `${Number(v).toFixed(1)}%`,
  },
  timeout: {
    label: 'Avbryt om inget händer',
    desc: 'Om priset inte rör sig tillräckligt inom denna tid stängs testet.',
    raise: 'Du vill ge signalen längre tid att visa riktning.',
    lower: 'Du vill avbryta stillastående test snabbare.',
    risk: 'För lång timeout kan binda testet i svaga lägen.',
    riskLevel: 'low',
    recommended: 'Scalping: 5-45 min',
    min: 1,
    max: 240,
    step: 1,
    defaultValue: 30,
    format: v => formatDuration(v),
  },
  momentum_requirement: {
    label: 'Momentumkrav',
    desc: 'Här väljer du hur stark fart priset måste ha.',
    raise: 'Du bara vill testa starka rörelser.',
    lower: 'Du vill fånga tidigare signaler.',
    risk: 'Lägre krav kan fånga tidigt men släpper igenom mer brus.',
    riskLevel: 'medium',
    recommended: 'Normal test: 55-75/100',
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 60,
    format: v => `${Math.round(Number(v))}/100`,
  },
  vwap_distance: {
    label: 'Avstånd till VWAP',
    desc: 'Här väljer du hur nära priset ska vara VWAP för att signalen ska räknas.',
    raise: 'Du vill tillåta signaler längre från VWAP.',
    lower: 'Du vill kräva tätare VWAP-koppling.',
    risk: 'Stort avstånd kan ge sämre entry efter att rörelsen redan gått.',
    riskLevel: 'medium',
    recommended: 'Normal test: 0.2%-0.8%',
    min: 0.05,
    max: 2,
    step: 0.05,
    defaultValue: 0.4,
    format: v => `${Number(v).toFixed(2)}%`,
  },
  ema_distance: {
    label: 'Avstånd till EMA',
    desc: 'Här väljer du hur nära priset ska vara EMA-linjen.',
    raise: 'Du vill tillåta pullbacks och trendlägen längre från EMA.',
    lower: 'Du vill bara testa signaler nära EMA.',
    risk: 'Stort avstånd kan betyda sämre risk/reward i testet.',
    riskLevel: 'medium',
    recommended: 'Normal test: 0.2%-0.8%',
    min: 0.05,
    max: 2,
    step: 0.05,
    defaultValue: 0.5,
    format: v => `${Number(v).toFixed(2)}%`,
  },
  narrow_sensitivity: {
    label: 'Narrow-känslighet',
    desc: 'Här väljer du hur ihoptryckt priset måste vara för att räknas som Narrow State.',
    raise: 'Strängare - färre signaler.',
    lower: 'Mjukare - fler signaler.',
    risk: 'För mjukt läge kan klassa vanliga rörelser som narrow.',
    riskLevel: 'low',
    recommended: 'Normal test: 4-7',
    min: 1,
    max: 10,
    step: 1,
    defaultValue: 5,
    format: v => `${Math.round(Number(v))}/10`,
  },
  breakout_strength: {
    label: 'Utbrottsstyrka',
    desc: 'Här väljer du hur starkt priset måste bryta ut från en nivå.',
    raise: 'Du vill kräva tydligare utbrott.',
    lower: 'Du vill testa tidigare eller svagare utbrott.',
    risk: 'Lågt krav kan släppa igenom falska utbrott.',
    riskLevel: 'medium',
    recommended: 'Normal test: 60-80/100',
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 65,
    format: v => `${Math.round(Number(v))}/100`,
  },
  reversal_sensitivity: {
    label: 'Vändningskänslighet',
    desc: 'Här testar systemet hur tidigt det ska reagera på en möjlig vändning.',
    raise: 'Du vill att testet ska reagera tidigare på vändningstecken.',
    lower: 'Du vill kräva tydligare bekräftelse innan exit.',
    risk: 'Hög känslighet kan stänga test-trades för tidigt.',
    riskLevel: 'medium',
    recommended: 'Normal test: 45-65/100',
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 55,
    format: v => `${Math.round(Number(v))}/100`,
  },
  max_volatility: {
    label: 'Max volatilitet',
    desc: 'Hindrar systemet från att testa trades när priset hoppar för mycket.',
    raise: 'Du vill tillåta stökigare rörelser i testet.',
    lower: 'Du vill filtrera bort fler ryckiga lägen.',
    risk: 'Högre tak kan ge fler svåra och ryckiga test-trades.',
    riskLevel: 'high',
    recommended: 'Normal test: 1.5-3.0',
    min: 0.5,
    max: 5,
    step: 0.1,
    defaultValue: 3,
    format: v => Number(v).toFixed(1),
  },
  max_spread: {
    label: 'Max spread',
    desc: 'Hindrar test på symboler där skillnaden mellan köp och sälj är för stor.',
    raise: 'Du vill tillåta fler symboler med bredare spread i test.',
    lower: 'Du vill bara testa tajtare och mer likvida lägen.',
    risk: 'Hög spread kan försämra simulerade entries och exits.',
    riskLevel: 'high',
    recommended: 'Scalping: 0.01%-0.20%',
    min: 0.01,
    max: 1,
    step: 0.01,
    defaultValue: 0.15,
    format: v => `${Number(v).toFixed(2)}%`,
  },
  trend_requirement: {
    label: 'Trendkrav',
    desc: 'Här väljer du hur tydlig trenden måste vara.',
    raise: 'Du vill bara testa signaler med tydlig trend.',
    lower: 'Du vill även testa mer neutrala eller tidiga trendlägen.',
    risk: 'Lågt trendkrav kan ge fler sidledes signaler.',
    riskLevel: 'medium',
    recommended: 'Normal test: 50-70/100',
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 55,
    format: v => `${Math.round(Number(v))}/100`,
  },
  index_support: {
    label: 'Index-stöd',
    desc: 'För aktier: kräver att index som QQQ eller SPY stödjer signalen.',
    raise: 'Du vill ha starkare marknadsbekräftelse.',
    lower: 'Du vill testa aktiesignaler mer fristående.',
    risk: 'Lägre indexkrav kan ge fler signaler mot marknaden.',
    riskLevel: 'medium',
    recommended: 'Normal',
    options: ['Av', 'Svag', 'Normal', 'Stark'],
    defaultValue: 'Normal',
  },
  news_risk: {
    label: 'Nyhetsrisk',
    desc: 'Här väljer du om systemet ska vara försiktigt när nyheter skapar stora rörelser.',
    raise: 'Du vill vara mer försiktig runt nyhetsdrivna rörelser.',
    lower: 'Du vill testa fler nyhetslägen.',
    risk: 'Lägre nyhetsskydd kan ge fler stökiga testresultat.',
    riskLevel: 'medium',
    recommended: 'Normal',
    options: ['Av', 'Låg', 'Normal', 'Hög'],
    defaultValue: 'Normal',
  },
  certificate_risk: {
    label: 'Certifikat-risk',
    desc: 'Används för test av Bull/Bear-certifikat och Mini futures. Högre värde gör systemet mer försiktigt.',
    raise: 'Du vill vara mer försiktig med hävstång, spread och produktvillkor.',
    lower: 'Du vill testa fler certifikatlägen med mindre skydd.',
    risk: 'Certifikat kan ha hävstång, spread och produktvillkor. Endast test.',
    riskLevel: 'high',
    recommended: 'Hög eller Mycket hög för certifikat-test',
    options: ['Av', 'Låg', 'Normal', 'Hög', 'Mycket hög'],
    defaultValue: 'Hög',
  },
};

const SLIDER_GROUPS = [
  { title: 'Risk', keys: ['stop_loss', 'risk_per_trade', 'max_spread', 'max_volatility', 'certificate_risk'] },
  { title: 'Entry', keys: ['confidence_threshold', 'momentum_requirement', 'volume_filter', 'vwap_distance', 'ema_distance', 'narrow_sensitivity', 'breakout_strength', 'trend_requirement', 'index_support'] },
  { title: 'Exit', keys: ['take_profit', 'holding_time', 'timeout', 'reversal_sensitivity'] },
  { title: 'Skydd', keys: ['cooldown', 'news_risk', 'certificate_risk'] },
];

const TEST_PRESETS = [
  {
    id: 'careful',
    name: 'Försiktig test',
    desc: 'Lägre risk, högre signalstyrka, kortare hålltid och strängare volymkrav.',
    params: {
      stop_loss: 0.3,
      take_profit: 2,
      confidence_threshold: 75,
      holding_time: 25,
      cooldown: 15,
      volume_filter: 1.8,
      risk_per_trade: 0.5,
      timeout: 20,
      momentum_requirement: 70,
      max_spread: 0.1,
      max_volatility: 2,
      trend_requirement: 65,
      index_support: 'Stark',
      news_risk: 'Hög',
      certificate_risk: 'Mycket hög',
    },
  },
  {
    id: 'normal',
    name: 'Normal test',
    desc: 'Balanserade värden för vanlig paper och replay.',
    params: { ...DEFAULT_PARAMS },
  },
  {
    id: 'aggressive',
    name: 'Aggressiv test',
    desc: 'Lägre signalstyrka, fler signaler och lite högre risk.',
    warning: 'Endast test - använd inte för live trading.',
    params: {
      stop_loss: 0.8,
      take_profit: 4,
      confidence_threshold: 50,
      holding_time: 90,
      cooldown: 1,
      volume_filter: 0.8,
      risk_per_trade: 1.5,
      timeout: 75,
      momentum_requirement: 45,
      max_spread: 0.35,
      max_volatility: 3.8,
      trend_requirement: 45,
      index_support: 'Svag',
      news_risk: 'Låg',
      certificate_risk: 'Normal',
    },
  },
  {
    id: 'scalping',
    name: 'Snabb scalping',
    desc: 'Kort hålltid, tight stop, mindre vinstmål och hög volym.',
    params: {
      stop_loss: 0.2,
      take_profit: 1.5,
      confidence_threshold: 68,
      holding_time: 12,
      cooldown: 8,
      volume_filter: 2.2,
      risk_per_trade: 0.5,
      timeout: 10,
      momentum_requirement: 72,
      vwap_distance: 0.25,
      ema_distance: 0.25,
      max_spread: 0.08,
      max_volatility: 1.8,
      trend_requirement: 62,
      news_risk: 'Normal',
      certificate_risk: 'Hög',
    },
  },
  {
    id: 'certificate',
    name: 'Certifikat-test',
    desc: 'Endast test, mycket försiktig risk, kort hålltid och hög spreadkontroll. live_enabled=false.',
    warning: 'Endast test - använd inte för live trading.',
    params: {
      stop_loss: 0.2,
      take_profit: 1.5,
      confidence_threshold: 78,
      holding_time: 15,
      cooldown: 20,
      volume_filter: 2,
      risk_per_trade: 0.25,
      timeout: 12,
      momentum_requirement: 75,
      max_spread: 0.05,
      max_volatility: 1.5,
      trend_requirement: 70,
      index_support: 'Stark',
      news_risk: 'Hög',
      certificate_risk: 'Mycket hög',
    },
  },
];

// ── Components ────────────────────────────────────────────────────────────────

function finiteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function safeText(value, fallback = 'Ej inställt') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  return fallback;
}

function formatDuration(value) {
  const minutes = finiteNumber(value, 0);
  if (minutes <= 0) return 'Ej inställt';
  return minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`;
}

function formatSliderValue(meta, value) {
  if (meta.options) return meta.options.includes(value) ? value : meta.defaultValue || 'Ej inställt';
  const safe = finiteNumber(value, meta.defaultValue);
  try {
    return safeText(meta.format ? meta.format(safe) : safe);
  } catch {
    return 'Ej inställt';
  }
}

function GroupHeader({ icon, title }) {
  return (
    <div className="tl-group-header">
      <span>{icon}</span>
      <span>{title}</span>
    </div>
  );
}

function Toggle({ label, desc, value, onChange, disabled, scope = 'test' }) {
  return (
    <div className={`tl-toggle${disabled ? ' tl-toggle-disabled' : ''}`}>
      <div className="tl-toggle-info">
        <div className="tl-toggle-label-row">
          <div className="tl-toggle-label">{label}</div>
          <ConfigScopeBadge scope={disabled ? 'safety' : scope} />
        </div>
        <div className="tl-toggle-desc">{disabled ? `${desc} Påverkar inte live-scannern från Trading Lab.` : `${desc} Påverkar endast tester och analys.`}</div>
      </div>
      <button
        className={`tl-switch${value ? ' tl-switch-on' : ''}`}
        onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        type="button"
        aria-pressed={value}
      >
        <span className="tl-switch-thumb" />
      </button>
    </div>
  );
}

function Slider({ meta, value, onChange }) {
  const options = meta.options || null;
  const numericValue = finiteNumber(value, meta.defaultValue);
  const sliderValue = options
    ? Math.max(0, options.indexOf(options.includes(value) ? value : meta.defaultValue || options[0]))
    : clamp(numericValue, meta.min, meta.max);
  const pct = options
    ? (options.length <= 1 ? 0 : (sliderValue / (options.length - 1)) * 100)
    : ((sliderValue - meta.min) / (meta.max - meta.min)) * 100;
  const display = formatSliderValue(meta, options ? options[sliderValue] : sliderValue);
  const minLabel = options ? options[0] : formatSliderValue(meta, meta.min);
  const maxLabel = options ? options[options.length - 1] : formatSliderValue(meta, meta.max);
  const riskClass = meta.riskLevel ? ` tl-risk-${meta.riskLevel}` : '';
  return (
    <div className="tl-slider-wrap">
      <div className="tl-slider-top">
        <div className="tl-slider-label">{meta.label}</div>
        <div className="tl-slider-value">{display}</div>
      </div>
      <div className="tl-slider-desc">{meta.desc}</div>
      <div className="tl-slider-track">
        <div className="tl-slider-fill" style={{ width: `${clamp(pct, 0, 100)}%` }} />
        <input
          type="range"
          min={options ? 0 : meta.min}
          max={options ? options.length - 1 : meta.max}
          step={options ? 1 : meta.step}
          value={sliderValue}
          onChange={e => {
            const next = options ? options[Number(e.target.value)] : parseFloat(e.target.value);
            onChange(next);
          }}
          className="tl-slider-input"
          aria-label={meta.label}
        />
      </div>
      <div className="tl-slider-ends">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      <div className="tl-slider-help">
        <div><strong>Höj om:</strong> {meta.raise}</div>
        <div><strong>Sänk om:</strong> {meta.lower}</div>
        <div className={`tl-slider-risk${riskClass}`}><strong>Risk:</strong> {meta.risk}</div>
        <div><strong>Rekommenderat:</strong> {meta.recommended}</div>
        <div className="tl-slider-test-only">Endast test, paper och replay.</div>
      </div>
    </div>
  );
}

function SliderGroup({ title, keys, params, onChange }) {
  return (
    <section className="tl-slider-section">
      <h3>{title}</h3>
      <div className="tl-sliders-grid">
        {keys.map(key => (
          <Slider
            key={`${title}-${key}`}
            meta={SLIDER_META[key]}
            value={params[key]}
            onChange={value => onChange(key, value)}
          />
        ))}
      </div>
    </section>
  );
}

function SliderPresetButtons({ onApply }) {
  return (
    <div className="tl-preset-strip">
      {TEST_PRESETS.map(preset => (
        <button
          key={preset.id}
          className={`tl-preset-chip tl-preset-${preset.id}`}
          type="button"
          onClick={() => onApply(preset.params)}
        >
          <span>{preset.name}</span>
          <small>{preset.desc}</small>
          {preset.warning && <em>{preset.warning}</em>}
        </button>
      ))}
    </div>
  );
}

function buildSliderWarnings(params) {
  const warnings = [];
  if (finiteNumber(params.stop_loss, 0) > 0.5) warnings.push('Varning: hög stop loss kan ge större förluster i test.');
  if (finiteNumber(params.take_profit, 0) >= 5) warnings.push('Stort vinstmål kan göra att färre trades når målet.');
  if (finiteNumber(params.holding_time, 0) > 60) warnings.push('Lång hålltid kan ge fler timeout eller svagare scalping-resultat.');
  if (finiteNumber(params.volume_filter, 1) < 1) warnings.push('Lågt volymkrav kan släppa in svaga signaler.');
  if (finiteNumber(params.risk_per_trade, 0) > 1) warnings.push('Hög risk per trade är endast för test.');
  if (safeText(params.certificate_risk, 'Av') !== 'Av') warnings.push('Certifikat kan ha hävstång, spread och produktvillkor. Endast test.');
  return warnings;
}

function profileInterpretation(params) {
  const reasons = [];
  if (finiteNumber(params.stop_loss, 0) > 0.5) reasons.push('stop loss är hög för scalping');
  if (finiteNumber(params.holding_time, 0) > 60) reasons.push('lång hålltid');
  if (finiteNumber(params.risk_per_trade, 0) > 1) reasons.push('hög test-risk');
  if (finiteNumber(params.confidence_threshold, 100) < 55) reasons.push('många svagare signaler kan släppas igenom');
  if (reasons.length === 0) return 'Denna profil är balanserad för test och paper.';
  return `Denna profil är ganska aggressiv eftersom ${reasons.join(', ')}.`;
}

function CurrentTestProfile({ params }) {
  const warnings = buildSliderWarnings(params);
  const rows = [
    ['Max förlust', formatSliderValue(SLIDER_META.stop_loss, params.stop_loss)],
    ['Vinstmål', formatSliderValue(SLIDER_META.take_profit, params.take_profit)],
    ['Minsta signalstyrka', formatSliderValue(SLIDER_META.confidence_threshold, params.confidence_threshold)],
    ['Max tid i trade', formatSliderValue(SLIDER_META.holding_time, params.holding_time)],
    ['Paus mellan trades', formatSliderValue(SLIDER_META.cooldown, params.cooldown)],
    ['Minsta volym', formatSliderValue(SLIDER_META.volume_filter, params.volume_filter)],
    ['Test-risk', formatSliderValue(SLIDER_META.risk_per_trade, params.risk_per_trade)],
    ['Avbryt om inget händer', formatSliderValue(SLIDER_META.timeout, params.timeout)],
  ];
  return (
    <div className="tl-params-summary">
      <div className="tl-params-summary-title">Aktuell testprofil</div>
      <div className="tl-params-grid">
        {rows.map(([label, value]) => (
          <div className="tl-param-chip" key={label}><span>{label}</span> {value}</div>
        ))}
      </div>
      <div className="tl-profile-ai">{profileInterpretation(params)}</div>
      {warnings.length > 0 && (
        <div className="tl-warning-list">
          {warnings.map(warning => <div key={warning} className="tl-warning-item">{warning}</div>)}
        </div>
      )}
    </div>
  );
}

function ExitToggle({ item, value, onChange }) {
  return (
    <div className={`tl-exit-item${value ? ' tl-exit-on' : ''}`}>
      <div className="tl-exit-header">
        <div className="tl-exit-name">{item.label}</div>
        <button
          className={`tl-switch tl-switch-sm${value ? ' tl-switch-on' : ''}`}
          onClick={() => onChange(!value)}
          type="button"
        >
          <span className="tl-switch-thumb" />
        </button>
      </div>
      <div className="tl-exit-desc">{item.desc}</div>
    </div>
  );
}

function ComboCard({ combo, toggles }) {
  const allOn = combo.keys.every(k => toggles[k]);
  const someOn = combo.keys.some(k => toggles[k]);
  const status = allOn ? 'Aktiv' : someOn ? 'Delvis' : 'Inaktiv';
  const statusCls = allOn ? 'tl-combo-active' : someOn ? 'tl-combo-partial' : 'tl-combo-off';
  return (
    <div className={`tl-combo-card ${statusCls}`}>
      <div className="tl-combo-header">
        <div className="tl-combo-label">{combo.label}</div>
        <span className={`tl-combo-badge ${statusCls}`}>{status}</span>
      </div>
      <div className="tl-combo-hint">{combo.hint}</div>
      <div className="tl-combo-keys">
        {combo.keys.map(k => {
          const meta = TOGGLE_META.find(m => m.key === k);
          return (
            <span key={k} className={`tl-combo-key${toggles[k] ? ' tl-combo-key-on' : ''}`}>
              {meta?.label || k}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function SafetyNote() {
  return (
    <div className="tl-safety-note">
      <span>🔒</span>
      <div>
        <div className="tl-safety-note-title">Testmiljö — inga riktiga orders</div>
        <div className="tl-safety-note-sub">Riskmotor och säkerhetsmotor kan inte kringgås. actions_allowed=false alltid.</div>
      </div>
    </div>
  );
}

// ── Optimization Panel components ────────────────────────────────────────────

function useOptimizationSummary() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const load = React.useCallback((rebuild = false) => {
    setLoading(true);
    fetch(`/api/optimization/summary${rebuild ? '?rebuild=1' : ''}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);
  React.useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

function OptScoreBadge({ score }) {
  const color = score >= 60 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';
  return (
    <span className="opt-score-badge" style={{ background: `${color}18`, color, borderColor: `${color}50` }}>
      {score}/100
    </span>
  );
}

function StatRow({ label, value, highlight }) {
  return (
    <div className="opt-stat-row">
      <span className="opt-stat-label">{label}</span>
      <span className={`opt-stat-value${highlight ? ' opt-stat-hi' : ''}`}>{value ?? '–'}</span>
    </div>
  );
}

function MiniBar({ pct, color }) {
  return (
    <div className="opt-minibar-track">
      <div className="opt-minibar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function ConfigCard({ config, rank }) {
  const [open, setOpen] = React.useState(false);
  if (!config.stats) return null;
  const { winRatePct, timeoutRatePct, avgPnl, n } = config.stats;
  const isTop = rank <= 2;
  return (
    <div className={`opt-config-card ${isTop ? 'opt-config-top' : ''}`}>
      <div className="opt-config-header">
        <div className="opt-config-rank">#{rank}</div>
        <div className="opt-config-info">
          <div className="opt-config-label">{config.label}</div>
          <div className="opt-config-n">{n} trades</div>
        </div>
        <OptScoreBadge score={config.score} />
      </div>
      <div className="opt-config-bars">
        <div className="opt-config-bar-row">
          <span>Win rate</span>
          <MiniBar pct={winRatePct} color={winRatePct >= 50 ? '#22c55e' : winRatePct >= 35 ? '#f59e0b' : '#ef4444'} />
          <span className="opt-bar-val">{winRatePct}%</span>
        </div>
        <div className="opt-config-bar-row">
          <span>Timeout</span>
          <MiniBar pct={timeoutRatePct} color={timeoutRatePct > 50 ? '#ef4444' : timeoutRatePct > 30 ? '#f59e0b' : '#22c55e'} />
          <span className="opt-bar-val">{timeoutRatePct}%</span>
        </div>
      </div>
      <div className={`opt-config-pnl ${avgPnl >= 0 ? 'opt-pnl-pos' : 'opt-pnl-neg'}`}>
        {avgPnl >= 0 ? '+' : ''}{(avgPnl * 100).toFixed(3)}% snitt P/L
      </div>
      <button className="opt-expand-btn" onClick={() => setOpen(v => !v)} type="button">
        {open ? '▲ Dölj' : '▼ Parametrar'}
      </button>
      {open && (
        <div className="opt-config-params">
          {Object.entries(config.params || {}).map(([k, v]) => (
            <span key={k} className="opt-param-chip"><span>{k}</span>{v}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function WeakConfigCard({ config }) {
  if (!config.stats) return null;
  const { winRatePct, timeoutRatePct, n } = config.stats;
  return (
    <div className="opt-weak-card">
      <div className="opt-weak-header">
        <span className="opt-weak-icon">⚠️</span>
        <div>
          <div className="opt-weak-label">{config.label}</div>
          <div className="opt-weak-n">{n} trades</div>
        </div>
        <OptScoreBadge score={config.score} />
      </div>
      {config.warning && <div className="opt-weak-warning">{config.warning}</div>}
      <div className="opt-weak-stats">
        <span>WR: {winRatePct}%</span>
        <span>Timeout: {timeoutRatePct}%</span>
      </div>
    </div>
  );
}

function BucketBar({ items, scoreKey = 'score', labelKey = 'label', metricKey = 'stats', metricField = 'winRatePct' }) {
  if (!items?.length) return <div className="opt-empty">Ingen data</div>;
  return (
    <div className="opt-bucket-list">
      {items.map((item, i) => {
        const st = item[metricKey];
        if (!st) return null;
        const val = st[metricField] ?? 0;
        const color = val >= 50 ? '#22c55e' : val >= 35 ? '#f59e0b' : '#ef4444';
        const isBest = i === 0 || (item.score === Math.max(...items.map(x => x.score || 0)));
        return (
          <div key={i} className={`opt-bucket-row ${isBest ? 'opt-bucket-best' : ''}`}>
            <div className="opt-bucket-label">{item[labelKey]}</div>
            <div className="opt-bucket-bar-wrap">
              <MiniBar pct={val} color={color} />
            </div>
            <div className="opt-bucket-vals">
              <span style={{ color, fontWeight: 600 }}>{val}%</span>
              <span className="opt-bucket-n">n={st.n}</span>
              {isBest && <span className="opt-bucket-best-badge">✓ Bäst</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecommendationsList({ recs }) {
  if (!recs) return null;
  return (
    <div className="opt-recs">
      {recs.green?.length > 0 && (
        <div className="opt-rec-group">
          <div className="opt-rec-group-label opt-green-label">🟢 Rekommenderat</div>
          {recs.green.map((r, i) => <div key={i} className="opt-rec-item opt-rec-green">{r}</div>)}
        </div>
      )}
      {recs.yellow?.length > 0 && (
        <div className="opt-rec-group">
          <div className="opt-rec-group-label opt-yellow-label">🟡 Behöver mer data / Justera</div>
          {recs.yellow.map((r, i) => <div key={i} className="opt-rec-item opt-rec-yellow">{r}</div>)}
        </div>
      )}
      {recs.red?.length > 0 && (
        <div className="opt-rec-group">
          <div className="opt-rec-group-label opt-red-label">🔴 Undvik</div>
          {recs.red.map((r, i) => <div key={i} className="opt-rec-item opt-rec-red">{r}</div>)}
        </div>
      )}
      {!recs.green?.length && !recs.yellow?.length && !recs.red?.length && (
        <div className="opt-empty">Inga rekommendationer ännu — kör mer paper trading.</div>
      )}
    </div>
  );
}

function useRecommendedConfig() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    fetch('/api/optimization/recommended-config')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);
  return { data, loading, error };
}

function ApplyPanel({ toggles, params, exits, onApplyParams, onApplyToggles, onApplyExits }) {
  const { data, loading, error } = useRecommendedConfig();
  const [selected, setSelected] = React.useState({});
  const [applied, setApplied] = React.useState(false);
  const [hasBackup, setHasBackup] = React.useState(false);

  React.useEffect(() => {
    setHasBackup(!!localStorage.getItem('tradinglab_config_v1_backup'));
  }, []);

  React.useEffect(() => {
    if (data?.changes) {
      const init = {};
      data.changes.forEach(c => { init[c.id] = true; });
      setSelected(init);
    }
  }, [data]);

  if (loading) return <div className="opt-apply-loading">Hämtar konfiguration...</div>;
  if (error) return <div className="opt-error">Fel: {error}</div>;
  if (!data?.changes?.length) return <div className="opt-empty">Inga rekommendationer tillgängliga ännu — kör mer paper trading.</div>;

  const { changes, tradeCount, hasEnoughData } = data;

  const impactColor = { high: '#ef4444', medium: '#f59e0b', low: '#94a3b8' };
  const impactLabel = { high: 'Hög', medium: 'Medel', low: 'Låg' };

  function getCurrentValue(change) {
    if (change.type === 'param')  return params[change.key];
    if (change.type === 'toggle') return toggles[change.key];
    if (change.type === 'exit')   return exits[change.key];
    return undefined;
  }

  function formatValue(val, change) {
    if (typeof val === 'boolean') return val ? 'Aktiv' : 'Av';
    if (val === undefined || val === null) return '–';
    if (change.unit) return `${val}${change.unit}`;
    return `${val}`;
  }

  function applySelected() {
    localStorage.setItem('tradinglab_config_v1_backup', JSON.stringify({ toggles, params, exits }));
    setHasBackup(true);
    const paramChanges = {}, toggleChanges = {}, exitChanges = {};
    changes.forEach(c => {
      if (!selected[c.id]) return;
      if (c.type === 'param')  paramChanges[c.key]  = c.recommendedValue;
      if (c.type === 'toggle') toggleChanges[c.key] = c.recommendedValue;
      if (c.type === 'exit')   exitChanges[c.key]   = c.recommendedValue;
    });
    if (Object.keys(paramChanges).length)  onApplyParams(paramChanges);
    if (Object.keys(toggleChanges).length) onApplyToggles(toggleChanges);
    if (Object.keys(exitChanges).length)   onApplyExits(exitChanges);
    setApplied(true);
  }

  function undoApply() {
    try {
      const backup = localStorage.getItem('tradinglab_config_v1_backup');
      if (!backup) return;
      const cfg = JSON.parse(backup);
      if (cfg.params)  onApplyParams(cfg.params);
      if (cfg.toggles) onApplyToggles(cfg.toggles);
      if (cfg.exits)   onApplyExits(cfg.exits);
      setApplied(false);
    } catch {}
  }

  const selectedCount = changes.filter(c => selected[c.id]).length;

  return (
    <div className="opt-apply-panel">
      <div className="opt-apply-header">
        <div>
          <div className="opt-apply-title">Auto-apply rekommenderad konfiguration</div>
          <div className="opt-apply-sub">
            {tradeCount} trades analyserade · {hasEnoughData ? 'Tillräcklig data' : 'Begränsad data'}
          </div>
        </div>
        <div className="opt-apply-actions">
          {hasBackup && (
            <button className="opt-undo-btn" onClick={undoApply} type="button">
              ↩ Ångra
            </button>
          )}
          <button
            className={`opt-apply-btn${applied ? ' opt-apply-done' : ''}`}
            onClick={applySelected}
            disabled={selectedCount === 0}
            type="button"
          >
            {applied ? '✓ Applicerat' : `Applicera valda (${selectedCount})`}
          </button>
        </div>
      </div>

      {applied && (
        <div className="opt-apply-success">
          ✅ {selectedCount} ändringar applicerade! Gå till Signaler, Parametrar eller Exits för att se dem.
          {hasBackup && ' Klicka "Ångra" för att återställa.'}
        </div>
      )}

      <div className="opt-apply-list">
        {changes.map(change => {
          const currentVal = getCurrentValue(change);
          const isSelected = !!selected[change.id];
          const color = impactColor[change.impact] || '#94a3b8';
          const isChanged = currentVal !== change.recommendedValue;
          return (
            <div key={change.id} className={`opt-apply-row${isSelected ? ' opt-apply-row-sel' : ''}`}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={e => setSelected(s => ({ ...s, [change.id]: e.target.checked }))}
                className="opt-apply-check"
                id={`apply-${change.id}`}
              />
              <label htmlFor={`apply-${change.id}`} className="opt-apply-row-inner">
                <div className="opt-apply-info">
                  <div className="opt-apply-change-label">{change.label}</div>
                  <div className="opt-apply-rationale">{change.rationale}</div>
                </div>
                <div className="opt-apply-values">
                  <span className="opt-apply-from" style={{ opacity: isChanged ? 1 : 0.5 }}>
                    {formatValue(currentVal, change)}
                  </span>
                  <span className="opt-apply-arrow">→</span>
                  <span className="opt-apply-to">{formatValue(change.recommendedValue, change)}</span>
                </div>
                <span
                  className="opt-apply-impact"
                  style={{ background: `${color}18`, color, borderColor: `${color}50` }}
                >
                  {impactLabel[change.impact]}
                </span>
              </label>
            </div>
          );
        })}
      </div>

      <div className="opt-apply-footer">
        <label className="opt-apply-select-all">
          <input
            type="checkbox"
            checked={selectedCount === changes.length && changes.length > 0}
            onChange={e => {
              const all = {};
              changes.forEach(c => { all[c.id] = e.target.checked; });
              setSelected(all);
            }}
          />
          Välj alla ({changes.length})
        </label>
        <div className="opt-apply-note">🔒 Testmiljö — inga riktiga orders påverkas</div>
      </div>
    </div>
  );
}

// ── Adaptive Intelligence Tab ─────────────────────────────────────────────────
const STRATEGY_LABELS_TL = {
  vwap_reclaim:           'VWAP-återtagning',
  vwap_rejection:         'VWAP-avvisning',
  ema_trend:              'EMA-trend',
  ema_pullback:           'EMA-rekyl',
  narrow_state:           'Narrow State',
  breakout:               'Utbrott',
  momentum:               'Stark rörelse',
  mean_reversion:         'Återgång',
  volume_spike:           'Volymtopp',
  vwap_momentum:          'VWAP Stark rörelse',
  vwap_rejection_short:   'VWAP Avvisning Short',
  opening_range_breakout: 'Opening Range Breakout',
  pullback_continuation:  'Pullback/Rekyl',
  mean_reversion_vwap:    'Återgång VWAP',
  volume_spike_momentum:  'Volym + Stark rörelse',
  index_trend_mode:       'Index-trendläge',
  sector_confirmation:    'Sektorbekräftelse',
  news_volatility_watch:  'Nyhets-volatilitet',
};

function useRegimeStatus() {
  const unified = useUnifiedConfig('lab');
  return {
    data: unified.test.marketRegime,
    loading: unified.meta.loading && !unified.test.marketRegime,
    adaptiveMode: unified.test.adaptiveConfig.enabled,
    setAdaptiveMode: unified.setAdaptiveEnabled,
  };
}

function AdaptiveIntelligenceTab() {
  const { data, loading, adaptiveMode, setAdaptiveMode } = useRegimeStatus();

  function toggleAdaptive() {
    setAdaptiveMode(!adaptiveMode);
  }

  if (loading) {
    return <div className="tl-tab-content"><div className="ami-loading">Laddar marknadsregim...</div></div>;
  }
  if (!data) {
    return <div className="tl-tab-content"><div className="ami-empty">Ingen marknadsdata tillgänglig ännu.</div></div>;
  }

  const {
    regime, regimeMeta, regimeLabelSv, regimeIcon, regimeScore,
    volatilityLabelSv, trendLabelSv, riskEnvLabelSv,
    indexBias, strategyWeights, heatmap, recommendations, strategyPerformance,
  } = data;

  const weights = strategyWeights?.weights || [];
  const topW    = weights.filter(w => w.regimeAdj >= 8);
  const midW    = weights.filter(w => Math.abs(w.regimeAdj) < 8 && w.regimeAdj > -8);
  const botW    = weights.filter(w => w.regimeAdj <= -8);
  const underperforming = weights.filter(w => {
    const sp = strategyPerformance?.byStrategy?.[w.key];
    return sp?.winRate !== null && sp?.winRate !== undefined && sp.winRate < 35 && sp.trades >= 5;
  });

  const overallColor = indexBias?.overall === 'bullish' ? '#22c55e'
    : indexBias?.overall === 'bearish' ? '#ef4444' : '#f59e0b';

  return (
    <div className="tl-tab-content">
      {/* Adaptive mode toggle */}
      <div className="ami-tl-header">
        <div className="ami-tl-title">🧠 Dynamisk prioritering</div>
        <ConfigScopeBadge scope="test" />
        <button
          className={`ami-adaptive-toggle${adaptiveMode ? ' ami-toggle-on' : ''}`}
          onClick={toggleAdaptive}
          type="button"
        >
          {adaptiveMode ? '🟢 Aktiv' : '⚪ Av'}
        </button>
      </div>
      <div className="ami-tl-desc">
        {adaptiveMode
          ? 'Aktivt i analys/test: strategivikter och marknadsläge påverkar visualiserad signalpoäng.'
          : 'Inaktivt i analys/test: statiska vikter visas. Live-scannern ändras inte av denna toggle.'}
      </div>

      {/* Current regime card */}
      <div className="ami-tl-regime-card">
        <div className="ami-tl-rc-left">
          <div className="ami-tl-rc-icon">{regimeIcon}</div>
          <div>
            <div className="ami-tl-rc-name" style={{ color: regimeMeta?.color }}>
              {regimeLabelSv}
            </div>
            <div className="ami-tl-rc-desc">{regimeMeta?.descSv}</div>
          </div>
        </div>
        <div className="ami-tl-rc-score">
          <div className="ami-tl-rc-num" style={{ color: regimeMeta?.color }}>{regimeScore?.score}</div>
          <div className="ami-tl-rc-sublbl">Konfidenspoäng</div>
        </div>
      </div>

      {/* Index states */}
      <div className="ami-tl-idx-row">
        {[
          { label: 'QQQ',    d: indexBias?.nasdaq },
          { label: 'S&P',    d: indexBias?.sp500  },
          { label: 'Krypto', d: indexBias?.crypto  },
          { label: 'Aktier', d: indexBias?.stocks  },
        ].filter(x => x.d).map(({ label, d }) => (
          <div key={label} className={`ami-tl-idx ami-tl-idx-${d.bullish ? 'bull' : 'bear'}`}>
            <span className="ami-tl-idx-name">{label}</span>
            <span className="ami-tl-idx-trend">{d.bullish ? '▲' : '▼'}</span>
          </div>
        ))}
        <div className="ami-tl-idx ami-tl-idx-info">
          <span>{riskEnvLabelSv}</span>
        </div>
      </div>

      {/* Strategy priority */}
      {topW.length > 0 && (
        <>
          <div className="ami-tl-section-title">🚀 Prioriterade strategier nu</div>
          <div className="ami-strat-cards">
            {topW.map(w => {
              const sp = strategyPerformance?.byStrategy?.[w.key];
              return (
                <div key={w.key} className="ami-sc ami-sc-up">
                  <div className="ami-sc-name">{STRATEGY_LABELS_TL[w.key] || w.key}</div>
                  <div className="ami-sc-adj">+{w.regimeAdj} vikting</div>
                  {sp?.winRate != null && (
                    <div className="ami-sc-wr">{sp.winRate}% WR ({sp.trades} trades)</div>
                  )}
                  <div className="ami-sc-reason">{w.reasonSv}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {botW.length > 0 && (
        <>
          <div className="ami-tl-section-title">📉 Nedviktade strategier nu</div>
          <div className="ami-strat-cards">
            {botW.map(w => {
              const sp = strategyPerformance?.byStrategy?.[w.key];
              return (
                <div key={w.key} className="ami-sc ami-sc-down">
                  <div className="ami-sc-name">{STRATEGY_LABELS_TL[w.key] || w.key}</div>
                  <div className="ami-sc-adj">{w.regimeAdj} vikting</div>
                  {sp?.winRate != null && (
                    <div className="ami-sc-wr">{sp.winRate}% WR ({sp.trades} trades)</div>
                  )}
                  <div className="ami-sc-reason">{w.reasonSv}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Underperformance warnings */}
      {underperforming.length > 0 && (
        <>
          <div className="ami-tl-section-title">⚠️ Underpresterar just nu</div>
          <div className="ami-warn-list">
            {underperforming.map(w => {
              const sp = strategyPerformance?.byStrategy?.[w.key];
              return (
                <div key={w.key} className="ami-warn-row">
                  <span className="ami-warn-icon">⚠️</span>
                  <div className="ami-warn-info">
                    <div className="ami-warn-name">{STRATEGY_LABELS_TL[w.key] || w.key}</div>
                    <div className="ami-warn-msg">
                      {sp?.winRate}% träffsäkerhet senaste {sp?.trades} trades — underpresterar i nuvarande marknad.
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Market heatmap */}
      {heatmap?.length > 0 && (
        <>
          <div className="ami-tl-section-title">🌍 Marknadsheatmap</div>
          <div className="ami-heatmap-grid">
            {heatmap.map(h => (
              <div key={h.market} className={`ami-hm-cell ami-hm-${h.bias}`}>
                <div className="ami-hm-icon">{h.icon}</div>
                <div className="ami-hm-name">{h.market}</div>
                <div className="ami-hm-bias">{h.bias === 'bullish' ? '▲ Bullish' : h.bias === 'bearish' ? '▼ Bearish' : '→ Neutral'}</div>
                <div className="ami-hm-vol">{h.volatility === 'high' ? 'Hög volatilitet' : h.volatility === 'low' ? 'Låg volatilitet' : 'Normal'}</div>
                <div className="ami-hm-trust">Förtroende: {h.trustScore}/100</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* AI Recommendations */}
      {recommendations?.length > 0 && (
        <>
          <div className="ami-tl-section-title">🤖 Adaptiva rekommendationer</div>
          <div className="ami-rec-list">
            {recommendations.map((rec, i) => (
              <div key={i} className={`ami-rec ami-rec-${rec.priority}`}>
                <span className="ami-rec-icon">{rec.icon}</span>
                <span className="ami-rec-text">{rec.textSv}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Safety note */}
      <div className="ami-safety-note">
        🔒 Adaptive mode ändrar bara signalvikter för analys — inga riktiga trades, inga automatiska konfigurationsändringar.
      </div>
    </div>
  );
}

function AiOptimizationTab({ toggles, params, exits, onApplyParams, onApplyToggles, onApplyExits }) {
  const { data, loading, error, reload } = useOptimizationSummary();
  const [section, setSection] = React.useState('overview');

  const SECTIONS = [
    { key: 'overview',  label: 'Översikt',     icon: '📊' },
    { key: 'configs',   label: 'Konfigurationer', icon: '🏆' },
    { key: 'params',    label: 'Parametrar',   icon: '⚙️' },
    { key: 'exits_a',   label: 'Exit-analys',  icon: '↘️' },
    { key: 'markets',   label: 'Marknader',    icon: '🌍' },
    { key: 'batch',     label: 'Batch',        icon: '🧪' },
    { key: 'recs',      label: 'Råd',          icon: '💡' },
  ];

  if (loading) return (
    <div className="opt-loading">
      <div className="opt-loading-dot" />
      <span>Analysmotorn analyserar historiska trades...</span>
    </div>
  );

  if (error) return <div className="opt-error">Fel: {error}</div>;
  if (!data) return <div className="opt-empty">Ingen data tillgänglig.</div>;

  const { tradeCount, overallStats, overallScore, topConfigs, weakConfigs,
          stopLoss, holdingTime, exits: exitsData, combinations, markets, confidence, recommendations, strategyBatchTesting } = data;

  const hasData = tradeCount >= 5;

  return (
    <div className="opt-panel">
      {/* Header */}
      <div className="opt-header">
        <div className="opt-header-left">
          <div className="opt-title">🤖 Optimeringsagent</div>
          <div className="opt-subtitle">
            Analyserar {tradeCount} historiska trades — rekommendering only, inga ändringar automatiskt
          </div>
        </div>
        <div className="opt-header-right">
          <OptScoreBadge score={overallScore} />
          <button className="opt-rebuild-btn" onClick={() => reload(true)} type="button" title="Uppdatera analys">
            ↻ Uppdatera
          </button>
        </div>
      </div>

      <div className="opt-safety-note">
        🔒 actions_allowed=false · can_place_orders=false · live_trading_enabled=false — Bara analys
      </div>

      {!hasData && (
        <div className="opt-insufficient">
          ⚠️ Begränsad data ({tradeCount} trades). Kör mer paper trading för bättre insikter.
        </div>
      )}

      {/* Section nav */}
      <div className="opt-section-nav">
        {SECTIONS.map(s => (
          <button
            key={s.key}
            className={`opt-section-btn${section === s.key ? ' opt-section-active' : ''}`}
            onClick={() => setSection(s.key)}
            type="button"
          >
            <span>{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      {/* Overview */}
      {section === 'overview' && (
        <div className="opt-section-content">
          {overallStats && (
            <div className="opt-overview-grid">
              <div className="opt-overview-card">
                <div className="opt-ov-val" style={{ color: overallStats.winRatePct >= 50 ? '#22c55e' : '#f59e0b' }}>
                  {overallStats.winRatePct}%
                </div>
                <div className="opt-ov-label">Total win rate</div>
              </div>
              <div className="opt-overview-card">
                <div className="opt-ov-val" style={{ color: overallStats.timeoutRatePct > 40 ? '#ef4444' : '#22c55e' }}>
                  {overallStats.timeoutRatePct}%
                </div>
                <div className="opt-ov-label">Timeout-rate</div>
              </div>
              <div className="opt-overview-card">
                <div className="opt-ov-val" style={{ color: overallStats.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                  {overallStats.avgPnl >= 0 ? '+' : ''}{(overallStats.avgPnl * 100).toFixed(3)}%
                </div>
                <div className="opt-ov-label">Snitt P/L</div>
              </div>
              <div className="opt-overview-card">
                <div className="opt-ov-val">{tradeCount}</div>
                <div className="opt-ov-label">Trades analyserade</div>
              </div>
            </div>
          )}
          <div className="opt-subsection">Snabba insikter</div>
          <RecommendationsList recs={recommendations} />
        </div>
      )}

      {/* Configurations */}
      {section === 'configs' && (
        <div className="opt-section-content">
          <div className="opt-subsection">🏆 Bästa konfigurationer</div>
          {topConfigs?.length > 0
            ? topConfigs.slice(0, 5).map((c, i) => <ConfigCard key={c.id} config={c} rank={i + 1} />)
            : <div className="opt-empty">Inte tillräcklig data för konfigurationsranking.</div>
          }
          {weakConfigs?.length > 0 && (
            <>
              <div className="opt-subsection opt-weak-sub">⚠️ Svaga konfigurationer</div>
              {weakConfigs.map((c, i) => <WeakConfigCard key={c.id || i} config={c} />)}
            </>
          )}
        </div>
      )}

      {/* Parameters */}
      {section === 'params' && (
        <div className="opt-section-content">
          <div className="opt-subsection">Stop Loss</div>
          {stopLoss?.buckets?.length > 0
            ? <BucketBar items={stopLoss.buckets} />
            : <div className="opt-empty">Ingen SL-data.</div>
          }
          {stopLoss?.recommendation && (
            <div className="opt-rec-note">💡 {stopLoss.recommendation}</div>
          )}

          <div className="opt-subsection">Hålltid (Holding Time)</div>
          {holdingTime?.buckets?.length > 0
            ? <BucketBar items={holdingTime.buckets} />
            : <div className="opt-empty">Ingen hålltid-data.</div>
          }
          {holdingTime?.recommendations?.map((r, i) => (
            <div key={i} className="opt-rec-note">💡 {r}</div>
          ))}

          <div className="opt-subsection">Styrketröskell (Confidence)</div>
          {confidence?.buckets?.length > 0
            ? <BucketBar items={confidence.buckets} />
            : <div className="opt-empty">Ingen styrka-data.</div>
          }
          {confidence?.recommendations?.map((r, i) => (
            <div key={i} className="opt-rec-note">💡 {r}</div>
          ))}
        </div>
      )}

      {/* Exit analysis */}
      {section === 'exits_a' && (
        <div className="opt-section-content">
          <div className="opt-subsection">Exit-typer</div>
          {exitsData?.byReason?.length > 0
            ? <BucketBar items={exitsData.byReason} labelKey="reasonSv" />
            : <div className="opt-empty">Ingen exit-data.</div>
          }
          <div className="opt-exit-meta">
            <div className="opt-exit-stat">
              <span>Timeouts:</span>
              <strong style={{ color: exitsData?.timeoutPct > 40 ? '#ef4444' : '#22c55e' }}>
                {exitsData?.timeoutCount ?? 0} ({exitsData?.timeoutPct ?? 0}%)
              </strong>
            </div>
            {exitsData?.motorExitStats && (
              <div className="opt-exit-stat">
                <span>Exitmotor:</span>
                <strong>{exitsData.motorExitStats.winRatePct}% WR ({exitsData.motorExitStats.n} trades)</strong>
              </div>
            )}
            {exitsData?.manualExitStats && (
              <div className="opt-exit-stat">
                <span>Manuell exit:</span>
                <strong>{exitsData.manualExitStats.winRatePct}% WR ({exitsData.manualExitStats.n} trades)</strong>
              </div>
            )}
          </div>
          {exitsData?.recommendations?.map((r, i) => (
            <div key={i} className="opt-rec-note">💡 {r}</div>
          ))}
        </div>
      )}

      {/* Markets */}
      {section === 'markets' && (
        <div className="opt-section-content">
          <div className="opt-subsection">Marknadstyper</div>
          {markets?.markets?.length > 0 ? (
            <div className="opt-market-list">
              {markets.markets.map((m, i) => (
                <div key={i} className="opt-market-card">
                  <div className="opt-market-header">
                    <span className="opt-market-name">{m.marketSv}</span>
                    <OptScoreBadge score={m.score} />
                  </div>
                  {m.stats && (
                    <div className="opt-market-stats">
                      <StatRow label="Win rate" value={`${m.stats.winRatePct}%`} highlight={m.stats.winRatePct >= 50} />
                      <StatRow label="Timeout" value={`${m.stats.timeoutRatePct}%`} />
                      <StatRow label="Trades" value={m.stats.n} />
                      {m.avgHoldMin && <StatRow label="Snitt hålltid" value={`${m.avgHoldMin} min`} />}
                    </div>
                  )}

                  {/* Signal combinations for this market */}
                  {combinations?.byCombination?.filter(c => true).length > 0 && null}
                </div>
              ))}
            </div>
          ) : <div className="opt-empty">Ingen marknadsdata.</div>}
          {markets?.recommendations?.map((r, i) => (
            <div key={i} className="opt-rec-note">💡 {r}</div>
          ))}
          <div className="opt-subsection">Bästa signalkombinationer</div>
          {combinations?.bestCombinations?.length > 0 ? (
            <div className="opt-combo-list">
              {combinations.bestCombinations.map((c, i) => (
                <div key={i} className="opt-combo-card">
                  <div className="opt-combo-header">
                    <span className="opt-combo-label">{c.label}</span>
                    <OptScoreBadge score={c.score} />
                  </div>
                  {c.stats && <div className="opt-combo-wr">{c.stats.winRatePct}% WR · {c.stats.n} trades</div>}
                </div>
              ))}
            </div>
          ) : <div className="opt-empty">Behöver fler trades för kombinations-analys.</div>}
        </div>
      )}

      {/* Batch optimization */}
      {section === 'batch' && (
        <div className="opt-section-content">
          <div className="opt-subsection">Batch-resultat</div>
          {strategyBatchTesting?.latestBatch?.id ? (
            <>
              <div className="opt-overview-grid">
                <div className="opt-overview-card">
                  <div className="opt-ov-val">{strategyBatchTesting.bestStrategy?.strategy_name || '–'}</div>
                  <div className="opt-ov-label">Bästa strategi</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val">{strategyBatchTesting.bestStopLoss?.key ?? '–'}</div>
                  <div className="opt-ov-label">Bästa SL</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val">{strategyBatchTesting.bestTakeProfit?.key ?? '–'}</div>
                  <div className="opt-ov-label">Bästa TP</div>
                </div>
                <div className="opt-overview-card">
                  <div className="opt-ov-val">{strategyBatchTesting.bestConfidence?.key ?? '–'}</div>
                  <div className="opt-ov-label">Bästa confidence</div>
                </div>
              </div>
              <div className="opt-rec-note">
                Batch {strategyBatchTesting.latestBatch.name} · {getBatchUiStatus(strategyBatchTesting.latestBatch).emoji} {getBatchUiStatus(strategyBatchTesting.latestBatch).label} · {strategyBatchTesting.latestBatch.progress?.completed || 0}/{strategyBatchTesting.latestBatch.progress?.total || 0}
              </div>
              <RecommendationsList recs={strategyBatchTesting.recommendations} />
              {strategyBatchTesting.pauseCandidates?.length > 0 && (
                <>
                  <div className="opt-subsection opt-weak-sub">Strategier att pausa/testa om</div>
                  <div className="opt-market-list">
                    {strategyBatchTesting.pauseCandidates.slice(0, 6).map((s, i) => (
                      <div key={`${s.strategy_id}-${i}`} className="opt-market-card">
                        <div className="opt-market-header">
                          <span className="opt-market-name">{s.strategy_name || s.strategy_id}</span>
                          <OptScoreBadge score={s.score || 0} />
                        </div>
                        <div className="opt-market-stats">
                          <StatRow label="Win rate" value={`${s.win_rate || 0}%`} />
                          <StatRow label="Trades" value={s.trades || 0} />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="opt-empty">Inga batch-resultat ännu. Kör Batch-test i Trading Lab för att få rekommendationer.</div>
          )}
        </div>
      )}

      {/* Recommendations */}
      {section === 'recs' && (
        <div className="opt-section-content">
          <div className="opt-subsection">Auto-apply — Applicera rekommendationer</div>
          <ApplyPanel
            toggles={toggles}
            params={params}
            exits={exits}
            onApplyParams={onApplyParams}
            onApplyToggles={onApplyToggles}
            onApplyExits={onApplyExits}
          />
          <div className="opt-subsection" style={{ marginTop: '1.5rem' }}>Rekommendationer</div>
          <RecommendationsList recs={recommendations} />
        </div>
      )}
    </div>
  );
}

// ── Market Universe ───────────────────────────────────────────────────────────
function useMarketUniverse() {
  const unified = useUnifiedConfig('lab');
  return {
    data: unified.global.marketUniverse,
    loading: unified.meta.loading && !unified.global.marketUniverse,
    reload: () => unified.refresh('marketUniverse'),
  };
}

function useBlockerConfig() {
  const unified = useUnifiedConfig('lab');
  return {
    data: unified.global.blockerConfig,
    loading: unified.meta.loading && !unified.global.blockerConfig,
    reload: () => unified.refresh('blockerConfig'),
  };
}

function usePresets() {
  const [data, setData] = React.useState(null);
  const load = React.useCallback(() => {
    fetch('/api/strategies/presets')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {});
  }, []);
  React.useEffect(() => { load(); }, [load]);
  return { data, reload: load };
}

const DATA_STATUS_LABELS = {
  active: 'Data aktiv',
  missing: 'Data saknas',
  symbol_unverified: 'Symbol ej verifierad',
  manual_watchlist: 'Endast manuell watchlist',
  needs_provider: 'Kräver Avanza/NGM/Nordic data-källa',
  unknown: 'Datakälla saknas',
};

const RISK_LABELS = {
  low: 'Låg risk',
  medium: 'Medelrisk',
  high: 'Hög risk',
  very_high: 'Mycket hög risk',
};

function textOr(value, fallback = 'För lite data') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number' && !Number.isFinite(value)) return fallback;
  if (typeof value === 'object') return fallback;
  return String(value);
}

function groupLabel(grp, key) {
  return textOr(grp?.label_sv || grp?.label, key || 'Marknad saknas');
}

function groupMaxSymbols(grp) {
  const n = Number(grp?.maxSymbols ?? grp?.max_symbols);
  return Number.isFinite(n) ? n : 0;
}

function groupDataStatus(grp) {
  const key = grp?.data_status || grp?.dataStatus || 'unknown';
  return DATA_STATUS_LABELS[key] || 'Datakälla saknas';
}

function isAdvancedProduct(grp) {
  const id = grp?.id || '';
  return Boolean(grp?.test_only || ['avanza_certificates', 'bull_certificates', 'bear_certificates', 'mini_futures', 'commodities', 'forex', 'crypto_certificates'].includes(id));
}

function MarketGroupCard({ groupKey, group, symbols }) {
  const grp = { ...(group || {}), id: groupKey };
  const advanced = isAdvancedProduct(grp);
  const symbolCount = symbols.filter((s) => s.marketGroup === groupKey).length;
  return (
    <div className={`mu-group-card${grp.enabled ? ' mu-group-on' : ''}${advanced ? ' mu-group-risk' : ''}`}>
      <div className="mu-group-header">
        <div className="mu-group-info">
          <div className="mu-group-label" style={{ color: grp.color }}>{groupLabel(grp, groupKey)}</div>
          <div className="mu-group-meta">
            Max {groupMaxSymbols(grp)} · Prio {Number.isFinite(Number(grp.priority)) ? grp.priority : '–'} · {textOr(grp.mode, 'observe')}
          </div>
        </div>
        <span className="mu-static-status">{grp.enabled ? 'Aktiv' : 'Av'}</span>
      </div>
      {grp.description_sv && <div className="mu-group-desc">{textOr(grp.description_sv, 'För lite data')}</div>}
      {advanced && (
        <div className="mu-advanced-note">
          Certifikat är inte samma sak som aktier. De kan röra sig mycket snabbare och påverkas av hävstång, spread och produktvillkor.
        </div>
      )}
      {grp.warning_sv && <div className="mu-group-warning">{textOr(grp.warning_sv, 'Endast testläge')}</div>}
      {grp.data_status === 'needs_provider' && (
        <div className="mu-group-provider">
          Behöver datakälla innan riktiga tester kan köras. Test kan köras mot underliggande marknad, men inte exakt certifikatpris.
        </div>
      )}
      <div className="mu-group-badges">
        {grp.paper_enabled !== false && <span className="mu-badge mu-paper">Paper</span>}
        {grp.batch_enabled !== false && <span className="mu-badge mu-paper">Batch</span>}
        {grp.replay_enabled !== false && <span className="mu-badge mu-paper">Replay</span>}
        {grp.observeOnly && <span className="mu-badge mu-observe">Bara observera</span>}
        {advanced && <span className="mu-badge mu-risk">Avancerad produkt</span>}
        {advanced && <span className="mu-badge mu-risk">Hävstång</span>}
        {grp.test_only && <span className="mu-badge mu-test">Endast test</span>}
        {grp.live_enabled === false && <span className="mu-badge mu-no-live">Inte live</span>}
        <span className="mu-badge mu-data">{groupDataStatus(grp)}</span>
        <span className="mu-badge mu-data">{RISK_LABELS[grp.risk_level] || 'Risk ej verifierad'}</span>
        <span className="mu-badge mu-data">{symbolCount} symboler</span>
      </div>
    </div>
  );
}

// ── Markets Tab ───────────────────────────────────────────────────────────────
function MarketsTab() {
  const { data, loading } = useMarketUniverse();

  if (loading) return <div className="tl-loading">Laddar marknader...</div>;
  if (!data) return <div className="tl-empty">Ingen marknadsdata.</div>;

  const { groups = {}, symbols = [] } = data;
  const groupEntries = Object.entries(groups).sort((a, b) => (Number(a[1]?.priority) || 99) - (Number(b[1]?.priority) || 99));
  const scannerGroups = groupEntries.filter(([, grp]) => grp.section !== 'test' && !grp.test_only);
  const testGroups = groupEntries.filter(([, grp]) => grp.section === 'test' || grp.test_only);

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="🌍" title="Scanner-marknader" />
      <div className="tl-scope-row">
        <ConfigScopeBadge scope="global" />
        <span>Marknader och riskinstrument styrs från Daytrading. Lab visar detta endast för analys/test.</span>
      </div>
      <div className="mu-group-grid">
        {scannerGroups.map(([key, grp]) => (
          <MarketGroupCard key={key} groupKey={key} group={grp} symbols={symbols} />
        ))}
      </div>

      <GroupHeader icon="🧪" title="Testmarknader" />
      <div className="tl-scope-row">
        <ConfigScopeBadge scope="test" />
        <span>Marknader och riskinstrument styrs från Daytrading. Lab visar detta endast för analys/test.</span>
      </div>
      <div className="mu-group-grid">
        {testGroups.map(([key, grp]) => (
          <MarketGroupCard key={key} groupKey={key} group={grp} symbols={symbols} />
        ))}
      </div>

      <GroupHeader icon="📋" title="Symboler" />
      <div className="tl-scope-row">
        <ConfigScopeBadge scope="test" />
        <span>Symboler visas read-only här. Lägg till eller pausa marknader från Daytrading.</span>
      </div>
      <div className="mu-sym-list">
        {symbols.map(sym => (
          <div key={sym.symbol} className={`mu-sym-row${sym.paused ? ' mu-sym-paused' : ''}${!sym.enabled ? ' mu-sym-off' : ''}`}>
            <div className="mu-sym-main">
              <span className="mu-sym-name">{textOr(sym.symbol, 'Symbol ej verifierad')}</span>
              <span className="mu-sym-group" style={{ color: groups[sym.marketGroup]?.color }}>
                {groupLabel(groups[sym.marketGroup], sym.marketGroup)}
              </span>
              <span className={`mu-sym-mode mu-mode-${sym.testMode || 'observe'}`}>{textOr(sym.testMode || sym.mode, 'observe')}</span>
              {(sym.status_label_sv || sym.verification_status === 'unverified' || sym.verification_status === 'invalid') && (
                <span className="mu-sym-status">{textOr(sym.status_label_sv, 'Symbol ej verifierad')}</span>
              )}
              {sym.test_only && <span className="mu-sym-status">Endast testläge</span>}
            </div>
            <div className="mu-sym-actions">
              <span className={`mu-sym-toggle${sym.enabled && !sym.paused ? ' mu-active' : ''}`}>{sym.enabled ? 'Aktiv' : 'Av'}</span>
              <span className={`mu-sym-pause${sym.paused ? ' mu-paused' : ''}`}>{sym.paused ? 'Pausad' : 'Aktiv'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Strategies Tab ────────────────────────────────────────────────────────────
const STRATEGY_SETTINGS_KEY = 'daytrading_strategy_settings_v1';
const MARKET_OPTIONS = [
  { value: 'crypto', label: 'Krypto' },
  { value: 'stocks', label: 'Aktier' },
  { value: 'index', label: 'Index' },
  { value: 'etf', label: 'ETF' },
  { value: 'all', label: 'Alla' },
];
const TIMEFRAME_OPTIONS = ['1m', '2m', '5m', '15m', '30m', '1h'];

function pctText(v) {
  if (v == null || Number.isNaN(Number(v))) return 'Ingen data ännu';
  return `${Number(v).toFixed(1)}%`;
}

function catalogStatusKey(strategy = {}) {
  const status = String(strategy.status || strategy.catalog_status || '').toLowerCase();
  if (['active', 'testing', 'paused', 'roadmap', 'legacy'].includes(status)) return status;
  if (strategy.enabled === false) return 'paused';
  return 'roadmap';
}

function catalogStatusLabel(status) {
  return {
    active: 'ACTIVE',
    testing: 'TESTING',
    paused: 'PAUSED',
    roadmap: 'ROADMAP',
    legacy: 'LEGACY',
  }[String(status || '').toLowerCase()] || 'ROADMAP';
}

function catalogStatusTone(status) {
  return {
    active: 'badge-green',
    testing: 'badge-blue',
    paused: 'badge-yellow',
    roadmap: 'badge-gray',
    legacy: 'badge-red',
  }[String(status || '').toLowerCase()] || 'badge-gray';
}

function capabilityText(label, value) {
  return `${label}: ${value === true ? 'Ja' : 'Nej'}`;
}

function defaultBatchStrategyIds(catalog = []) {
  return catalog
    .filter((strategy) => strategy.enabled !== false)
    .filter((strategy) => ['active', 'testing'].includes(catalogStatusKey(strategy)))
    .filter((strategy) => strategy.supportsBatch !== false)
    .slice(0, 2)
    .map((strategy) => strategy.id)
    .filter(Boolean);
}

function defaultStrategySettings(strategy) {
  return {
    sl: strategy.default_stop_loss_pct ?? strategy.default_sl ?? 0.2,
    tp: strategy.default_take_profit_r ?? strategy.default_tp ?? 1.5,
    holding_time: strategy.default_holding_time_min ?? strategy.default_holding_time ?? 10,
    timeout: strategy.default_timeout_min ?? strategy.default_holding_time_min ?? strategy.default_holding_time ?? 10,
    confidence_threshold: strategy.confidence_threshold ?? 65,
    volume_requirement: 1.2,
    cooldown: 5,
    max_trades_per_day: 5,
    market_group: strategy.market || strategy.market_group || 'all',
    timeframe: strategy.default_timeframes?.[0] || '2m',
    symbols: '',
  };
}

function loadStrategySettings() {
  try { return JSON.parse(localStorage.getItem(STRATEGY_SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

function StrategyMiniSlider({ label, value, min, max, step, format, onChange }) {
  const pct = ((Number(value) - min) / (max - min)) * 100;
  return (
    <div className="strat-param">
      <div className="strat-param-top">
        <span>{label}</span>
        <strong>{format ? format(value) : value}</strong>
      </div>
      <div className="tl-slider-track strat-param-track">
        <div className="tl-slider-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        <input
          className="tl-slider-input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
        />
      </div>
    </div>
  );
}

function StrategyCard({ strategy, performance, settings, onSettingsChange, onTest }) {
  const [open, setOpen] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [lastResult, setLastResult] = React.useState(null);
  const perf = performance?.[strategy.id];
  const badge = perf?.performance_badge;
  const statusKey = catalogStatusKey(strategy);
  const statusLabel = catalogStatusLabel(statusKey);
  const supportBadges = [
    capabilityText('Scanner', strategy.supportsScanner),
    capabilityText('Replay', strategy.supportsReplay),
    capabilityText('Batch', strategy.supportsBatch),
    capabilityText('Paper', strategy.supportsPaper),
    capabilityText('Learning', strategy.supportsLearning),
  ];

  async function testStrategy() {
    setTesting(true);
    try {
      const res = await onTest(strategy, settings);
      if (res?.result) setLastResult(res.result);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="strat-card">
      <div className="strat-card-header">
        <div className="strat-info">
          <div className="strat-title-row">
            <div className="strat-label">{strategy.name}</div>
            <span className={`badge ${catalogStatusTone(statusKey)}`}>{statusLabel}</span>
            {strategy.is_new && <span className="strat-new-badge">Ny strategi</span>}
          </div>
          <div className="strat-score-impact">
            {strategy.market_label || strategy.market || strategy.market_group || 'Alla'} · SL {strategy.default_stop_loss_pct ?? strategy.default_sl}% · TP {strategy.default_take_profit_r ?? strategy.default_tp}R · {strategy.default_holding_time_min ?? strategy.default_holding_time} min
          </div>
        </div>
        <ConfigScopeBadge scope="test" />
        <div className="strat-controls">
          <button className="strat-test-btn" onClick={testStrategy} disabled={testing} type="button">
            {testing ? 'Kör Lab-test...' : 'Kör Lab-test'}
          </button>
          <button className="strat-expand" onClick={() => setOpen(v => !v)} type="button">{open ? '▲' : '▼'}</button>
        </div>
      </div>
      <div className="strat-desc">{strategy.simple_explanation_sv || strategy.description_sv || strategy.explanation}</div>
      <div className="strat-runtime-note">
        Katalogstatus: {statusLabel} · {supportBadges.join(' · ')}
      </div>
      <div className="strat-result-row">
        <span>Historisk vinstprocent: <strong>{perf ? pctText(perf.win_rate) : 'Ingen data ännu'}</strong></span>
        {badge && <span className={`strat-perf-badge strat-perf-${badge.tone}`}>{badge.label}</span>}
        {lastResult && <span>Senast: {lastResult.trades} trades · {pctText(lastResult.win_rate)} WR · {lastResult.total_pnl >= 0 ? '+' : ''}{lastResult.total_pnl}% P/L</span>}
      </div>
      {open && (
        <div className="strat-details">
          <div className="strat-rules">
            {(strategy.engines_used?.length ? strategy.engines_used : strategy.signal_rules || []).map(rule => <span key={rule}>{String(rule).replace(/_/g, ' ')}</span>)}
          </div>
          <div className="strat-param-grid">
            <StrategyMiniSlider label="Stop loss" value={settings.sl} min={0.05} max={2} step={0.01} format={v => `${Number(v).toFixed(2)}%`} onChange={v => onSettingsChange({ sl: v })} />
            <StrategyMiniSlider label="Take profit" value={settings.tp} min={0.2} max={5} step={0.1} format={v => `${Number(v).toFixed(1)}R`} onChange={v => onSettingsChange({ tp: v })} />
            <StrategyMiniSlider label="Holding time" value={settings.holding_time} min={1} max={120} step={1} format={v => `${v} min`} onChange={v => onSettingsChange({ holding_time: v })} />
            <StrategyMiniSlider label="Timeout" value={settings.timeout} min={1} max={120} step={1} format={v => `${v} min`} onChange={v => onSettingsChange({ timeout: v })} />
            <StrategyMiniSlider label="Confidence" value={settings.confidence_threshold} min={20} max={95} step={1} format={v => `${v}/100`} onChange={v => onSettingsChange({ confidence_threshold: v })} />
            <StrategyMiniSlider label="Volymkrav" value={settings.volume_requirement} min={0.5} max={5} step={0.1} format={v => `${Number(v).toFixed(1)}x`} onChange={v => onSettingsChange({ volume_requirement: v })} />
            <StrategyMiniSlider label="Cooldown" value={settings.cooldown} min={0} max={60} step={1} format={v => `${v} min`} onChange={v => onSettingsChange({ cooldown: v })} />
            <StrategyMiniSlider label="Max trades/dag" value={settings.max_trades_per_day} min={1} max={20} step={1} format={v => `${v}`} onChange={v => onSettingsChange({ max_trades_per_day: v })} />
          </div>
          <div className="strat-select-row">
            <label>
              <span>Marknad</span>
              <select value={settings.market_group} onChange={e => onSettingsChange({ market_group: e.target.value })}>
                {MARKET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>
              <span>Timeframe</span>
              <select value={settings.timeframe} onChange={e => onSettingsChange({ timeframe: e.target.value })}>
                {TIMEFRAME_OPTIONS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
              </select>
            </label>
            <label>
              <span>Symboler</span>
              <input value={settings.symbols} onChange={e => onSettingsChange({ symbols: e.target.value.toUpperCase() })} placeholder="AAPL,NVDA eller tomt" />
            </label>
          </div>
          <div className="strat-paper-note">actions_allowed=false · can_place_orders=false · live_trading_enabled=false</div>
        </div>
      )}
    </div>
  );
}

function StrategiesTab() {
  const [catalog, setCatalog] = React.useState(null);
  const [performance, setPerformance] = React.useState({});
  const [settings, setSettings] = React.useState(() => loadStrategySettings());
  const [loading, setLoading] = React.useState(true);

  const reloadPerformance = React.useCallback(() => {
    fetch('/api/daytrading-strategies/performance')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const map = {};
        (d?.strategies || []).forEach(p => { map[p.strategy_id] = p; });
        setPerformance(map);
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    Promise.all([
      fetch('/api/daytrading-strategies/catalog').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/daytrading-strategies/performance').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([cat, perf]) => {
      setCatalog(cat);
      const map = {};
      (perf?.strategies || []).forEach(p => { map[p.strategy_id] = p; });
      setPerformance(map);
      setLoading(false);
    });
  }, []);

  React.useEffect(() => {
    localStorage.setItem(STRATEGY_SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  function getSettings(strategy) {
    return { ...defaultStrategySettings(strategy), ...(settings[strategy.id] || {}) };
  }

  function patchSettings(strategyId, patch) {
    setSettings(prev => ({ ...prev, [strategyId]: { ...(prev[strategyId] || {}), ...patch } }));
  }

  async function testStrategy(strategy, cfg) {
    const res = await fetch('/api/daytrading-strategies/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategy_id: strategy.id,
        ...cfg,
        symbols: cfg.symbols ? cfg.symbols.split(',').map(s => s.trim()).filter(Boolean) : [],
        mode: 'paper_replay',
        actions_allowed: false,
        can_place_orders: false,
        live_trading_enabled: false,
      }),
    }).then(r => r.ok ? r.json() : null).catch(() => null);
    reloadPerformance();
    return res;
  }

  if (loading) return <div className="tl-tab-content"><div className="tl-loading">Laddar strategikatalog...</div></div>;
  const strategies = catalog?.strategies || [];
  const statusCounts = strategies.reduce((acc, strategy) => {
    const key = catalogStatusKey(strategy);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="🧩" title="Strategikatalog" />
      <p className="tl-combo-intro">
        {strategies.length} katalogstrategier · Read-only strategiinfo · Lab påverkar inte paper-runtime
      </p>
      <div className="sup-v2-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <span className={`badge ${catalogStatusTone('active')}`}>ACTIVE {statusCounts.active || 0}</span>
        <span className={`badge ${catalogStatusTone('testing')}`}>TESTING {statusCounts.testing || 0}</span>
        <span className={`badge ${catalogStatusTone('paused')}`}>PAUSED {statusCounts.paused || 0}</span>
        <span className={`badge ${catalogStatusTone('roadmap')}`}>ROADMAP {statusCounts.roadmap || 0}</span>
        <span className={`badge ${catalogStatusTone('legacy')}`}>LEGACY {statusCounts.legacy || 0}</span>
      </div>
      <div className="batch-info">
        <div>
          <strong>Lab påverkar inte vilka strategier som kör paper trades.</strong>
          <div>Vill du styra paper-runtime, gå till Daytrading. Här körs bara test, replay, batch och analys.</div>
        </div>
        <Link className="strat-test-btn" to="/daytrading">Öppna Daytrading-kontroll</Link>
      </div>
      <div className="strat-list">
        {strategies.map(strategy => (
          <StrategyCard
            key={strategy.id}
            strategy={strategy}
            performance={performance}
            settings={getSettings(strategy)}
            onSettingsChange={patch => patchSettings(strategy.id, patch)}
            onTest={testStrategy}
          />
        ))}
      </div>
    </div>
  );
}

function csvNumbers(value) {
  return String(value || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite);
}

function csvSymbols(value) {
  return String(value || '').split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
}

function fmtBatchTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function batchDurationLabel(batch) {
  return batch?.duration_label || batch?.details?.duration_label || '–';
}

function fmtBatchMetric(value, suffix = '') {
  if (value == null || value === '') return '–';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const fixed = Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
  return `${fixed.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')}${suffix}`;
}

function batchSetupLabel(row) {
  if (!row) return '–';
  const parts = [
    `SL ${fmtBatchMetric(row.stop_loss, '%')}`,
    `TP ${fmtBatchMetric(row.take_profit, 'R')}`,
    `${row.holding_time ?? '–'} min`,
  ];
  if (row.timeout != null) parts.push(`timeout ${row.timeout} min`);
  if (row.confidence_threshold != null) parts.push(`styrka ${row.confidence_threshold}`);
  if (row.volume_requirement != null) parts.push(`volym ${row.volume_requirement}x`);
  return parts.join(' / ');
}

function batchStatusLabel(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'completed') return 'Klar';
  if (key === 'running') return 'Kör';
  if (key === 'stopped') return 'Stoppad';
  if (key === 'paused') return 'Pausad';
  if (key === 'created') return 'Väntar';
  if (key === 'failed' || key === 'error') return 'Fel';
  return status || 'Ingen batch';
}

const SWE_MONTHS = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];

// Skapar ett tydligt automatiskt batchnamn när användaren inte angett ett eget.
// Exempel: "BTC ETH NVDA · 2m/5m · 180 tester · 31 maj"
function buildAutoBatchName(form, comboCount) {
  const syms = csvSymbols(form?.symbols).slice(0, 4);
  const symPart = syms.length ? syms.join(' ') : 'Batch';
  const tfPart = (form?.timeframes || []).join('/') || '–';
  const d = new Date();
  const datePart = `${d.getDate()} ${SWE_MONTHS[d.getMonth()] || ''}`.trim();
  const count = Number(comboCount) || 0;
  return `${symPart} · ${tfPart} · ${count} tester · ${datePart}`;
}

// Översätter teknisk batch-status till en tydlig UI-status på enkel svenska.
// Returnerar { key, emoji, label, tone, sentence, busy }.
function getBatchUiStatus(batch) {
  if (!batch || !batch.id) {
    return { key: 'none', emoji: '', label: 'Ingen batch', tone: 'none', sentence: 'Skapa och kör en batch för att börja.', busy: false };
  }
  const status = String(batch.status || '').toLowerCase();
  const total = Number(batch.progress?.total || 0);
  const completed = Number(batch.progress?.completed || 0);
  const done = total > 0 && completed >= total;
  const hasError = !!batch.error || status === 'failed' || status === 'error';

  if (hasError) {
    return { key: 'failed', emoji: '🔴', label: 'Misslyckades', tone: 'failed', busy: false,
      sentence: 'Batch misslyckades. Något gick fel — se orsak och rekommenderad åtgärd nedan.' };
  }
  if (['preparing', 'planning', 'thinking', 'queued'].includes(status)) {
    return { key: 'thinking', emoji: '🔵', label: 'Förbereder', tone: 'thinking', busy: true,
      sentence: 'Systemet förbereder testet. Vänta några sekunder innan du gör något.' };
  }
  if (status === 'running' && !done) {
    return { key: 'running', emoji: '🟡', label: 'Körs', tone: 'running', busy: true,
      sentence: 'Batch körs just nu. Systemet testar strategier. Vänta med att starta en ny batch.' };
  }
  if (status === 'paused') {
    return { key: 'paused', emoji: '🟠', label: 'Pausad', tone: 'partial', busy: false,
      sentence: `Batchen är pausad efter ${completed}/${total} tester. Resultatet är ofullständigt — fortsätt eller kör om.` };
  }
  if (done && status === 'stopped') {
    return { key: 'done_stopped', emoji: '⚪', label: 'Stoppad efter färdig körning', tone: 'stopped', busy: false,
      sentence: 'Batch stoppad efter att alla tester redan var klara. Resultatet är komplett.' };
  }
  if (done) {
    return { key: 'done', emoji: '🟢', label: 'Klar', tone: 'done', busy: false,
      sentence: 'Batch klar. Alla tester är färdiga. Du kan läsa resultatet eller starta en ny batch.' };
  }
  if (status === 'stopped') {
    return { key: 'stopped', emoji: '⚪', label: 'Stoppad – ej klar', tone: 'partial', busy: false,
      sentence: `Batchen stoppades efter ${completed}/${total} tester. Resultatet är halvklart och ska inte användas som slutsats.` };
  }
  if (completed > 0 && completed < total) {
    return { key: 'partial', emoji: '🟠', label: 'Halvklar', tone: 'partial', busy: false,
      sentence: `Batchen hann bara köra ${completed}/${total} tester. Resultatet är inte färdigt och ska bara ses som tidig indikation.` };
  }
  return { key: 'waiting', emoji: '⚪', label: 'Väntar', tone: 'waiting', busy: false,
    sentence: 'Batch väntar på att startas. Klicka "Starta batch" när du är redo.' };
}

// En batch räknas som "upptagen" (systemet arbetar) om den förbereder, ligger i kö eller kör.
function isBatchBusy(batch) {
  const status = String(batch?.status || '').toLowerCase();
  if (['thinking', 'preparing', 'planning', 'queued'].includes(status)) return true;
  if (status === 'running') {
    const total = Number(batch?.progress?.total || 0);
    const completed = Number(batch?.progress?.completed || 0);
    return !(total > 0 && completed >= total);
  }
  return false;
}

function batchDecision(row) {
  const trades = Number(row?.trades || 0);
  const score = Number(row?.score || 0);
  const winRate = Number(row?.win_rate || 0);
  const avgPnl = Number(row?.avg_pnl || 0);
  const quality = String(row?.sample_quality || '');
  if (score >= 60 && winRate >= 50 && avgPnl > 0 && !['low', 'needs_more_data'].includes(quality)) {
    return { label: '✅ Testa vidare', tone: 'go' };
  }
  if (trades < 20 || quality === 'low' || quality === 'needs_more_data') {
    return { label: '⚠️ Behöver mer data', tone: 'more' };
  }
  return { label: '❌ Undvik', tone: 'avoid' };
}

function batchAuditMeta(event) {
  const type = String(event?.type || '').toUpperCase();
  // title = enkel svensk rubrik (ersätter teknisk text), text = förklaring
  if (type.includes('STARTED')) return { icon: '▶', status: 'Kör', title: 'Testet har börjat', text: 'Systemet har börjat köra tester.' };
  if (type.includes('PROGRESS')) return { icon: '↻', status: 'Kör', title: 'Systemet har kört fler tester', text: 'Resultat fylls på steg för steg.' };
  if (type.includes('COMPLETED')) return { icon: '✓', status: 'Klar', title: 'Alla tester är färdiga', text: 'Alla planerade tester är klara.' };
  if (type.includes('STOPPED')) return { icon: '■', status: 'Stoppad', title: 'Testet stoppades', text: 'Batchen stoppades innan allt var klart.' };
  if (type.includes('PAUSED')) return { icon: 'Ⅱ', status: 'Pausad', title: 'Testet pausades', text: 'Batchen är pausad och kan fortsätta senare.' };
  if (type.includes('CREATED')) return { icon: '+', status: 'Väntar', title: 'Testpaket skapat', text: 'Batchen är skapad men inte färdigkörd.' };
  if (type.includes('ERROR') || type.includes('FAILED')) return { icon: '!', status: 'Fel', title: 'Något gick fel', text: 'Ett test eller steg misslyckades.' };
  return { icon: '•', status: event?.type || 'Status', title: event?.message || 'Batch-händelse', text: 'Batch-händelse registrerad.' };
}

function batchPipelineSteps({ form, comboCount, batchBlocked, activeBatch, compare }) {
  const status = String(activeBatch?.status || '').toLowerCase();
  const hasBatch = !!activeBatch?.id;
  const hasResults = (compare?.best_overall || []).length > 0;
  const hasBest = !!(compare?.recommended_config?.strategy_id || compare?.best_overall?.[0]?.strategy_id);
  const paramsReady = ['stop_losses', 'take_profits', 'holding_times', 'timeouts', 'confidence_thresholds', 'volume_requirements']
    .every((key) => csvNumbers(form[key]).length > 0);
  const stopped = status === 'stopped';
  const failed = status === 'failed' || status === 'error' || !!activeBatch?.error;
  const completed = status === 'completed';
  const running = status === 'running';

  return [
    { label: 'Välj strategier', status: form.strategy_ids.length ? 'Klar' : 'Väntar' },
    { label: 'Välj symboler', status: csvSymbols(form.symbols).length ? 'Klar' : 'Väntar' },
    { label: 'Välj timeframes', status: form.timeframes.length ? 'Klar' : 'Väntar' },
    { label: 'Välj parametrar', status: batchBlocked || comboCount > 500 ? 'Fel' : paramsReady ? 'Klar' : 'Väntar' },
    { label: 'Skapa batch', status: hasBatch ? 'Klar' : 'Väntar' },
    { label: 'Kör tester', status: failed ? 'Fel' : stopped ? 'Stoppad' : running ? 'Kör' : completed ? 'Klar' : hasBatch ? 'Väntar' : 'Väntar' },
    { label: 'Jämför resultat', status: hasResults ? 'Klar' : running ? 'Kör' : stopped ? 'Stoppad' : 'Väntar' },
    { label: 'Välj bästa setup', status: hasBest ? 'Klar' : hasResults ? 'Kör' : 'Väntar' },
    { label: 'Analysera slutsats', status: hasBest ? 'Klar' : 'Väntar' },
  ];
}

function BatchTestTab() {
  const { data: marketUniverse } = useMarketUniverse();
  const [catalog, setCatalog] = React.useState([]);
  const [batches, setBatches] = React.useState([]);
  const [activeBatch, setActiveBatch] = React.useState(null);
  const [compare, setCompare] = React.useState(null);
  const [auditTimeline, setAuditTimeline] = React.useState([]);
  const [coverageMap, setCoverageMap] = React.useState({});
  const [message, setMessage] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [form, setForm] = React.useState({
    name: '',
    strategy_ids: [],
    markets: ['all'],
    symbols: 'BTCUSDT,ETHUSDT,NVDA',
    timeframes: ['2m'],
    date_from: new Date().toISOString().slice(0, 10),
    date_to: new Date().toISOString().slice(0, 10),
    stop_losses: '0.2',
    take_profits: '1,1.5',
    holding_times: '5,8',
    timeouts: '8',
    confidence_thresholds: '65',
    volume_requirements: '1.2',
    certificate_simulation_mode: 'off',
  });

  const load = React.useCallback(async () => {
    const [cat, list, coverage] = await Promise.all([
      fetch('/api/daytrading-strategies/catalog').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/strategy-batches').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/symbols').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    setCatalog(cat?.strategies || []);
    setBatches(list?.batches || []);
    const map = {};
    (coverage?.symbols || []).forEach((row) => { map[row.symbol] = row; });
    setCoverageMap(map);
    if (!activeBatch && list?.batches?.[0]) setActiveBatch(list.batches[0]);
    setLoading(false);
  }, [activeBatch]);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    if (catalog.length === 0) return;
    setForm((prev) => {
      if (prev.strategy_ids.length > 0) return prev;
      const defaults = defaultBatchStrategyIds(catalog);
      return defaults.length > 0 ? { ...prev, strategy_ids: defaults } : prev;
    });
  }, [catalog]);

  React.useEffect(() => {
    if (!activeBatch?.id) return undefined;
    const t = setInterval(async () => {
      const status = await fetch(`/api/strategy-batches/${activeBatch.id}`).then(r => r.ok ? r.json() : null).catch(() => null);
      if (status?.batch) setActiveBatch(status.batch);
      const audit = await fetch(`/api/audit/batches/recent?batch_id=${encodeURIComponent(activeBatch.id)}&limit=30`).then(r => r.ok ? r.json() : null).catch(() => null);
      if (audit?.events) setAuditTimeline(audit.events);
      if (status?.batch?.status === 'completed' || status?.batch?.status === 'paused' || status?.batch?.status === 'stopped') {
        const cmp = await fetch(`/api/strategy-batches/${activeBatch.id}/compare`).then(r => r.ok ? r.json() : null).catch(() => null);
        setCompare(cmp);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [activeBatch?.id]);

  React.useEffect(() => {
    if (!activeBatch?.id) return undefined;
    let cancelled = false;
    Promise.all([
      fetch(`/api/strategy-batches/${activeBatch.id}/compare`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/audit/batches/recent?batch_id=${encodeURIComponent(activeBatch.id)}&limit=30`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([cmp, audit]) => {
      if (cancelled) return;
      if (cmp?.ok) setCompare(cmp);
      if (audit?.events) setAuditTimeline(audit.events);
    });
    return () => { cancelled = true; };
  }, [activeBatch?.id]);

  function toggleArray(key, value) {
    setForm(prev => {
      const set = new Set(prev[key] || []);
      if (set.has(value)) set.delete(value); else set.add(value);
      return { ...prev, [key]: [...set] };
    });
  }

  function payload() {
    return {
      strategy_ids: form.strategy_ids,
      markets: form.markets,
      certificate_simulation_mode: form.certificate_simulation_mode,
      symbols: csvSymbols(form.symbols),
      timeframes: form.timeframes,
      date_from: form.date_from,
      date_to: form.date_to,
      stop_losses: csvNumbers(form.stop_losses),
      take_profits: csvNumbers(form.take_profits),
      holding_times: csvNumbers(form.holding_times),
      timeouts: csvNumbers(form.timeouts),
      confidence_thresholds: csvNumbers(form.confidence_thresholds),
      volume_requirements: csvNumbers(form.volume_requirements),
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
    };
  }

  const comboCount = React.useMemo(() => {
    const p = payload();
    return (p.strategy_ids.length || 0) * (p.markets.length || 0) * (p.symbols.length || 0) * (p.timeframes.length || 0)
      * (p.stop_losses.length || 0) * (p.take_profits.length || 0) * (p.holding_times.length || 0)
      * (p.timeouts.length || 0) * (p.confidence_thresholds.length || 0) * (p.volume_requirements.length || 0);
  }, [form]);

  async function createBatch() {
    setMessage('');
    if (anyBatchBusy) {
      setMessage('En batch körs redan. Vänta tills den är klar, stoppad eller har misslyckats innan du startar en ny.');
      return null;
    }
    if (batchBlocked) {
      setMessage('Kan inte köras ännu - datakälla saknas. Välj "Simulera mot underliggande" för test som inte använder exakt certifikatpris.');
      return null;
    }
    const batchName = form.name?.trim() || buildAutoBatchName(form, comboCount);
    const res = await fetch('/api/strategy-batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload(), name: batchName }),
    }).then(async r => ({ ok: r.ok, body: await r.json().catch(() => null) })).catch(e => ({ ok: false, body: { error: e.message } }));
    if (!res.ok || !res.body?.ok) {
      setMessage(res.body?.error || 'Kunde inte skapa batch.');
      return null;
    }
    setActiveBatch(res.body.batch);
    setCompare(null);
    setAuditTimeline([]);
    await load();
    return res.body.batch;
  }

  async function runBatch(batch = activeBatch) {
    setMessage('');
    // Tillåt att starta/återuppta den batch som redan är vald, men blockera om en ANNAN batch arbetar.
    const otherBusy = [activeBatch, ...batches].some(b => b && b.id !== batch?.id && isBatchBusy(b));
    if (otherBusy || (!batch && anyBatchBusy)) {
      setMessage('En batch körs redan. Vänta tills den är klar, stoppad eller har misslyckats innan du startar en ny.');
      return;
    }
    const target = batch || await createBatch();
    if (!target?.id) return;
    const res = await fetch(`/api/strategy-batches/${target.id}/run`, { method: 'POST' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (res?.batch) setActiveBatch(res.batch);
    const audit = await fetch(`/api/audit/batches/recent?batch_id=${encodeURIComponent(target.id)}&limit=30`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (audit?.events) setAuditTimeline(audit.events);
    await load();
  }

  async function pauseBatch() {
    if (!activeBatch?.id) return;
    const res = await fetch(`/api/strategy-batches/${activeBatch.id}/pause`, { method: 'POST' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (res?.batch) setActiveBatch(res.batch);
    const audit = await fetch(`/api/audit/batches/recent?batch_id=${encodeURIComponent(activeBatch.id)}&limit=30`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (audit?.events) setAuditTimeline(audit.events);
  }

  async function stopBatch() {
    if (!activeBatch?.id) return;
    const res = await fetch(`/api/strategy-batches/${activeBatch.id}/stop`, { method: 'POST' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (res?.batch) setActiveBatch(res.batch);
    const audit = await fetch(`/api/audit/batches/recent?batch_id=${encodeURIComponent(activeBatch.id)}&limit=30`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (audit?.events) setAuditTimeline(audit.events);
  }

  async function loadCompare(batch = activeBatch) {
    if (!batch?.id) return;
    const cmp = await fetch(`/api/strategy-batches/${batch.id}/compare`).then(r => r.ok ? r.json() : null).catch(() => null);
    setCompare(cmp);
  }

  if (loading) return <div className="tl-tab-content"><div className="tl-loading">Laddar batch-test...</div></div>;
  const progress = activeBatch?.progress || {};
  const marketGroups = marketUniverse?.groups || {};
  const marketOptions = [{ id: 'all', label: 'Alla', dataStatus: 'active', group: { label: 'Alla', data_status: 'active' } }]
    .concat(Object.entries(marketGroups)
      .filter(([, grp]) => grp.batch_enabled !== false)
      .sort((a, b) => (Number(a[1]?.priority) || 99) - (Number(b[1]?.priority) || 99))
      .map(([id, group]) => ({
        id,
        label: groupLabel(group, id),
        dataStatus: group.data_status || group.dataStatus || 'unknown',
        group,
      })));
  const selectedProviderMissing = marketOptions.filter((m) => form.markets.includes(m.id) && m.dataStatus === 'needs_provider');
  const batchBlocked = selectedProviderMissing.length > 0 && form.certificate_simulation_mode !== 'underlying_only';
  const batchCoverageWarnings = csvSymbols(form.symbols).map((symbol) => coverageMap[symbol]).filter(Boolean).filter((row) => !row.usable_for_batch);
  const bestResult = compare?.recommended_config?.strategy_id ? compare.recommended_config : compare?.best_overall?.[0];
  const bestDecision = batchDecision(bestResult);
  const pipelineSteps = batchPipelineSteps({ form, comboCount, batchBlocked, activeBatch, compare });
  const completedTests = compare?.total_results ?? progress.completed ?? 0;
  const uiStatus = getBatchUiStatus(activeBatch);
  const busyBatch = [activeBatch, ...batches].find((b) => b && isBatchBusy(b));
  const anyBatchBusy = !!busyBatch;
  const autoBatchName = buildAutoBatchName(form, comboCount);
  const summarySentence = bestResult
    ? `${bestResult.strategy_name || bestResult.strategy_id} på ${bestResult.symbol || 'vald symbol'} gav bäst resultat i denna batch.`
    : activeBatch?.id
      ? 'Batchen har ännu ingen tydlig vinnare. Kör klart testerna eller uppdatera resultat.'
      : 'Skapa och kör en batch för att få en tydlig slutsats.';

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="🧪" title="Batch-test" />

      {/* Tydlig aktiv batch-panel: visar alltid vald batch, status, progress och rekommenderad åtgärd */}
      <section className={`batch-active-panel batch-active-${uiStatus.tone}`}>
        <div className="batch-active-head">
          <div className="batch-active-id">
            <span className="batch-active-eyebrow">Vald batch</span>
            <strong className="batch-active-name">{activeBatch?.name || 'Ingen batch vald'}</strong>
          </div>
          <div className={`batch-active-badge batch-active-badge-${uiStatus.tone}`}>
            <span className="batch-active-emoji">{uiStatus.emoji}</span>
            <span>{uiStatus.label}</span>
          </div>
        </div>
        <div className="batch-active-sentence">{uiStatus.sentence}</div>
        <div className="batch-active-meta">
          <div><span>Status</span><strong>{uiStatus.emoji} {uiStatus.label}</strong></div>
          <div><span>Progress</span><strong>{progress.completed ?? 0}/{progress.total ?? 0}</strong></div>
          <div><span>Senast uppdaterad</span><strong>{fmtBatchTime(activeBatch?.updated_at)}</strong></div>
        </div>
        {anyBatchBusy && (
          <div className="batch-active-warn">
            ⚠️ En batch körs redan{busyBatch?.name ? ` (${busyBatch.name})` : ''}. Vänta tills den är klar, stoppad eller har misslyckats innan du startar en ny.
          </div>
        )}
        {uiStatus.key === 'failed' && (
          <div className="batch-active-error">
            <strong>🔴 Vad gick fel?</strong>
            <p>{activeBatch?.error || 'Okänt fel under körningen.'}</p>
            <p className="batch-active-error-meta">
              Påverkad körning: {progress.completed ?? 0}/{progress.total ?? 0} tester hann köras.
              {' '}Resultatet är {(progress.completed || 0) >= (progress.total || 0) && progress.total ? 'troligen användbart men kontrollera' : 'ofullständigt och ska inte användas som slutsats'}.
            </p>
            <p className="batch-active-error-meta">Rekommenderad åtgärd: kontrollera data för valda symboler/timeframes och kör om batchen.</p>
          </div>
        )}
      </section>

      <section className="batch-summary-card">
        <div className="batch-summary-header">
          <div>
            <h2>Batch-slutsats</h2>
            <p>{summarySentence}</p>
          </div>
          <div className={`batch-summary-status batch-summary-status-${uiStatus.tone}`}>
            {uiStatus.emoji} {uiStatus.label}
          </div>
        </div>

        {/* Prominent winner highlight */}
        {bestResult ? (
          <div className="batch-winner-box">
            <div className="batch-winner-trophy">🏆 Bäst i denna batch</div>
            <div className="batch-winner-title">
              {bestResult.strategy_name || bestResult.strategy_id}
              {bestResult.symbol && <span className="batch-winner-on"> på {bestResult.symbol}</span>}
            </div>
            {(bestResult.timeframe || batchSetupLabel(bestResult) !== '–') && (
              <div className="batch-winner-setup">
                {[bestResult.timeframe, batchSetupLabel(bestResult)].filter(s => s && s !== '–').join(' · ')}
              </div>
            )}
            <div className="batch-winner-metrics">
              {bestResult.score != null && (
                <div className="batch-winner-metric"><span>Score</span><strong>{fmtBatchMetric(bestResult.score)}</strong></div>
              )}
              {bestResult.win_rate != null && (
                <div className="batch-winner-metric"><span>Win rate</span><strong>{fmtBatchMetric(bestResult.win_rate, '%')}</strong></div>
              )}
              {bestResult.avg_pnl != null && (
                <div className="batch-winner-metric"><span>Snitt P/L</span><strong>{bestResult.avg_pnl >= 0 ? '+' : ''}{fmtBatchMetric(bestResult.avg_pnl, '%')}</strong></div>
              )}
              <span className={`batch-winner-decision-chip batch-result-${bestDecision.tone}`}>{bestDecision.label}</span>
            </div>
          </div>
        ) : activeBatch?.id ? (
          <div className="batch-winner-empty">
            Batchen är igång eller klar men ingen tydlig vinnare finns ännu. Klicka <strong>Uppdatera resultat</strong> för att hämta jämförelse.
          </div>
        ) : (
          <div className="batch-winner-empty">
            Skapa och kör en batch för att se vilken strategi, symbol och setup som ger bäst resultat.
          </div>
        )}

        <div className="batch-summary-grid">
          <div><span>Bästa strategi</span><strong>{bestResult?.strategy_name || bestResult?.strategy_id || '–'}</strong></div>
          <div><span>Bästa symbol</span><strong>{bestResult?.symbol || '–'}</strong></div>
          <div><span>Bästa timeframe</span><strong>{bestResult?.timeframe || '–'}</strong></div>
          <div><span>Bästa setup</span><strong style={{fontSize:'11px'}}>{batchSetupLabel(bestResult)}</strong></div>
          <div><span>Score</span><strong>{fmtBatchMetric(bestResult?.score)}</strong></div>
          <div><span>Win rate</span><strong>{fmtBatchMetric(bestResult?.win_rate, '%')}</strong></div>
          <div><span>Snitt P/L</span><strong>{bestResult?.avg_pnl != null ? `${bestResult.avg_pnl >= 0 ? '+' : ''}${fmtBatchMetric(bestResult.avg_pnl, '%')}` : '–'}</strong></div>
          <div><span>Antal tester</span><strong>{completedTests}</strong></div>
        </div>

        <div className="batch-summary-recommendation">
          <strong>Rekommendation:</strong> Testa denna setup vidare i replay/paper innan den används i daytrading-test.
          {bestResult && <span> Nästa steg: {bestDecision.label}. Undvik setup med negativt snitt P/L, låg score eller för lite data.</span>}
        </div>
        <div className="batch-summary-actions">
          <span className="batch-summary-safety-note">Resultatet är analys-only. Runtime och paper test styrs på Daytrading.</span>
        </div>
      </section>
      <div className="batch-safety">Paper/replay only · actions_allowed=false · can_place_orders=false · live_trading_enabled=false</div>

      <section className="batch-pipeline-card">
        <div className="batch-pipeline-header">
          <div>
            <div className="batch-section-title">Batch-pipeline</div>
            <div className="batch-pipeline-subtitle">Från konfiguration till paper-test</div>
          </div>
        </div>
        <div className="batch-pipeline-flow">
          {pipelineSteps.map((step, i) => {
            const ico = step.status === 'Klar' ? '✓' : step.status === 'Kör' ? '◌' : step.status === 'Fel' ? '!' : step.status === 'Stoppad' ? '■' : '○';
            return (
              <React.Fragment key={step.label}>
                {i > 0 && <span className="batch-pipeline-arrow">›</span>}
                <div className={`batch-pipeline-step batch-pipeline-${step.status.toLowerCase()}`}>
                  <span className="batch-pipeline-step-icon">{ico}</span>
                  <strong>{step.label}</strong>
                  <span>{step.status}</span>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </section>

      <div className="batch-layout">
        <div className="batch-panel">
          <div className="batch-section-title">Batchnamn</div>
          <label className="batch-field">
            <span>Ge batchen ett tydligt namn (valfritt)</span>
            <input
              value={form.name}
              placeholder={autoBatchName}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </label>
          <div className="batch-info">
            Lämna tomt så namnges batchen automatiskt: <strong>{autoBatchName}</strong>
          </div>

          <div className="batch-section-title">Strategier</div>
          <div className="batch-check-grid">
            {catalog.map(s => (
              <label key={s.id} className="batch-check">
                <input type="checkbox" checked={form.strategy_ids.includes(s.id)} onChange={() => toggleArray('strategy_ids', s.id)} />
                <span>{s.name}</span>
              </label>
            ))}
          </div>

          <div className="batch-section-title">Marknader och symboler</div>
          <label className="batch-field">
            <span>Certifikat-testläge</span>
            <select
              value={form.certificate_simulation_mode}
              onChange={e => setForm(f => ({ ...f, certificate_simulation_mode: e.target.value }))}
            >
              <option value="off">Av</option>
              <option value="underlying_only">Simulera mot underliggande</option>
              <option value="estimated_leverage" disabled>Uppskattad hävstång (ej aktivt)</option>
              <option value="real_certificate_data" disabled>Riktig certifikatdata (kräver datakälla)</option>
            </select>
          </label>
          {form.certificate_simulation_mode === 'underlying_only' && (
            <div className="batch-info">
              Systemet testar idén mot underliggande marknad, inte mot exakt certifikatpris.
            </div>
          )}
          {form.certificate_simulation_mode === 'estimated_leverage' && (
            <div className="batch-warning">
              Detta är bara uppskattning. Certifikatets riktiga pris kan avvika på grund av spread, avgifter och produktvillkor.
            </div>
          )}
          <div className="batch-inline-checks">
            {marketOptions.map(m => {
              const needsProvider = m.dataStatus === 'needs_provider';
              const blocked = needsProvider && form.certificate_simulation_mode !== 'underlying_only';
              return (
              <label key={m.id} className={`batch-pill-check${blocked ? ' batch-pill-blocked' : ''}`}>
                <input type="checkbox" checked={form.markets.includes(m.id)} disabled={blocked} onChange={() => toggleArray('markets', m.id)} />
                <span>{m.label}</span>
                {needsProvider && <em>{blocked ? 'Kan inte köras ännu - datakälla saknas' : 'Simuleras mot underliggande'}</em>}
              </label>
              );
            })}
          </div>
          {batchBlocked && (
            <div className="batch-warning">
              Kan inte köras ännu - datakälla saknas: {selectedProviderMissing.map(m => m.label).join(', ')}.
            </div>
          )}
          <label className="batch-field">
            <span>Symboler</span>
            <input value={form.symbols} onChange={e => setForm(f => ({ ...f, symbols: e.target.value }))} />
          </label>
          {batchCoverageWarnings.length > 0 && (
            <div className="batch-warning">
              För lite historik för säkert test: {batchCoverageWarnings.map((row) => row.symbol).join(', ')}.
            </div>
          )}
          <div className="batch-inline-checks">
            {TIMEFRAME_OPTIONS.map(tf => (
              <label key={tf} className="batch-pill-check">
                <input type="checkbox" checked={form.timeframes.includes(tf)} onChange={() => toggleArray('timeframes', tf)} />
                <span>{tf}</span>
              </label>
            ))}
          </div>

          <div className="batch-date-row">
            <label className="batch-field"><span>Från</span><input type="date" value={form.date_from} onChange={e => setForm(f => ({ ...f, date_from: e.target.value }))} /></label>
            <label className="batch-field"><span>Till</span><input type="date" value={form.date_to} onChange={e => setForm(f => ({ ...f, date_to: e.target.value }))} /></label>
          </div>
        </div>

        <div className="batch-panel">
          <div className="batch-section-title">Parametrar</div>
          <label className="batch-field"><span>Stop loss %</span><input value={form.stop_losses} onChange={e => setForm(f => ({ ...f, stop_losses: e.target.value }))} /></label>
          <label className="batch-field"><span>Take profit R</span><input value={form.take_profits} onChange={e => setForm(f => ({ ...f, take_profits: e.target.value }))} /></label>
          <label className="batch-field"><span>Max tid i trade</span><input value={form.holding_times} onChange={e => setForm(f => ({ ...f, holding_times: e.target.value }))} /></label>
          <label className="batch-field"><span>Timeout min</span><input value={form.timeouts} onChange={e => setForm(f => ({ ...f, timeouts: e.target.value }))} /></label>
          <label className="batch-field"><span>Minsta styrka</span><input value={form.confidence_thresholds} onChange={e => setForm(f => ({ ...f, confidence_thresholds: e.target.value }))} /></label>
          <label className="batch-field"><span>Volymkrav</span><input value={form.volume_requirements} onChange={e => setForm(f => ({ ...f, volume_requirements: e.target.value }))} /></label>
          <div className="lab-batch-help">
            SL = Stop loss · TP = Take profit · R = Risk/reward · Timeframe = vilken tidsram testet kördes på · WR = Win rate
          </div>
        </div>
      </div>

      <div className={`lab-batch-status-grid${comboCount > 500 ? ' batch-too-large' : ''}`}>
        <div><strong>{comboCount}</strong><span>Kombinationer</span></div>
        <div><strong>{uiStatus.emoji} {uiStatus.label}</strong><span>Status</span></div>
        <div><strong>{progress.completed ?? 0}/{progress.total ?? 0}</strong><span>Progress</span></div>
        <div><strong>{progress.pct ?? 0}%</strong><span>Klart %</span></div>
        <div><strong>{fmtBatchTime(activeBatch?.batch_started_at || activeBatch?.started_at)}</strong><span>Starttid</span></div>
        <div><strong>{fmtBatchTime(activeBatch?.batch_completed_at || activeBatch?.completed_at)}</strong><span>Sluttid</span></div>
        <div><strong>{fmtBatchTime(activeBatch?.updated_at)}</strong><span>Senast uppdaterad</span></div>
      </div>
      {message && <div className="batch-message">{message}</div>}
      {anyBatchBusy && (
        <div className="batch-warning">
          En batch körs redan. Vänta tills den är klar, stoppad eller har misslyckats innan du startar en ny.
        </div>
      )}

      <div className="batch-actions">
        <button type="button" onClick={createBatch} disabled={batchBlocked || anyBatchBusy}>Skapa batch</button>
        <button type="button" onClick={() => runBatch()} disabled={comboCount > 500 || batchBlocked || anyBatchBusy}>Starta batch</button>
        <button type="button" onClick={pauseBatch} disabled={!activeBatch}>Pausa</button>
        <button type="button" onClick={stopBatch} disabled={!activeBatch}>Stoppa</button>
        <button type="button" onClick={() => loadCompare()} disabled={!activeBatch}>Uppdatera resultat</button>
      </div>

      <div className="batch-progress-track">
        <div style={{ width: `${Math.max(0, Math.min(100, progress.pct || 0))}%` }} />
      </div>

      {activeBatch && (
	        <div className="batch-timeline lab-batch-timeline">
	          <div className="batch-section-title">Audit-timeline</div>
	          <div className="batch-timeline-grid">
            <div><span>Skapad</span><strong>{fmtBatchTime(activeBatch.batch_created_at || activeBatch.created_at)}</strong></div>
            <div><span>Startad</span><strong>{fmtBatchTime(activeBatch.batch_started_at || activeBatch.started_at)}</strong></div>
            <div><span>Klar</span><strong>{fmtBatchTime(activeBatch.batch_completed_at || activeBatch.completed_at)}</strong></div>
            <div><span>Duration</span><strong>{batchDurationLabel(activeBatch)}</strong></div>
	          </div>
	          <div className="batch-audit-list">
	            {auditTimeline.length > 0 ? auditTimeline.map(event => {
              const meta = batchAuditMeta(event);
              const eventProgress = event.details?.progress ? `${event.details.progress.completed || 0}/${event.details.progress.total || 0}` : '–';
              return (
	              <div key={event.event_id || `${event.timestamp}-${event.type}`} className="batch-audit-row lab-batch-audit-row">
	                <span className="lab-batch-audit-icon">{meta.icon}</span>
	                <span>{fmtBatchTime(event.timestamp)}</span>
	                <strong>{meta.title}</strong>
	                <em>{meta.status}</em>
	                <span>{eventProgress}</span>
	                <small>{meta.text}</small>
	              </div>
              );
            }) : (
	              <div className="batch-audit-empty">Ingen audit-timeline ännu.</div>
	            )}
          </div>
        </div>
      )}

      {batches.length > 0 && (
        <div className="batch-history">
          {batches.slice(0, 6).map(b => {
            const bUi = getBatchUiStatus(b);
            return (
	            <button key={b.id} type="button" className={`${activeBatch?.id === b.id ? 'active' : ''} batch-history-${bUi.tone}`} onClick={() => { setActiveBatch(b); setCompare(null); setAuditTimeline([]); }}>
	              {activeBatch?.id === b.id && <span className="batch-history-selected">✓ Vald</span>}
	              <strong>{b.name}</strong>
	              <span>{bUi.emoji} {bUi.label} · {b.progress?.completed || 0}/{b.progress?.total || 0}</span>
	            </button>
	            );
	          })}
	        </div>
	      )}

	      {compare?.best_overall?.length > 0 && (
	        <div className="batch-results batch-result-table">
	          <div className="batch-selected-banner">
	            <div>Du tittar på resultat från: <strong>{activeBatch?.name || '–'}</strong></div>
	            <div>Status: <strong>{uiStatus.emoji} {uiStatus.label}</strong> · Progress: <strong>{progress.completed ?? 0}/{progress.total ?? 0}</strong></div>
	            <div className="batch-selected-note">Detta resultat gäller endast den här batchen.</div>
	            {(uiStatus.tone === 'partial' || uiStatus.key === 'stopped' || uiStatus.key === 'paused') && (
	              <div className="batch-selected-warn">⚠️ Batchen är inte färdigkörd. Resultatet är bara en tidig indikation och ska inte användas som slutsats.</div>
	            )}
	          </div>
	          <div className="batch-section-title">Topplista</div>
            <div className="batch-result-row batch-result-head">
              <span>Rank</span>
              <span>Score</span>
              <span>Strategi</span>
              <span>Symbol</span>
              <span>Setup</span>
              <span>Timeframe</span>
              <span>Win rate</span>
              <span>Snitt P/L</span>
              <span>Beslut</span>
            </div>
	          {compare.best_overall.slice(0, 8).map((r, i) => {
              const decision = batchDecision(r);
              return (
	            <div key={`${r.strategy_id}-${r.symbol}-${i}`} className={`batch-result-row${i === 0 ? ' batch-result-row-winner' : ''}`}>
	              <strong>#{i + 1}</strong>
	              <span className="batch-result-score">{fmtBatchMetric(r.score)}</span>
	              <span>{r.strategy_name || r.strategy_id}</span>
	              <span className="batch-result-sym">{r.symbol}{r.symbol && <TradingViewLink symbol={r.symbol} marketType={r.marketType} label="TV" size="sm" />}</span>
	              <span className="batch-result-setup">{batchSetupLabel(r)}</span>
	              <span>{r.timeframe || '–'}</span>
	              <span>{fmtBatchMetric(r.win_rate, '%')}</span>
	              <span className={r.avg_pnl >= 0 ? 'batch-result-pos' : 'batch-result-neg'}>{r.avg_pnl >= 0 ? '+' : ''}{fmtBatchMetric(r.avg_pnl, '%')}</span>
	              <span className={`batch-result-decision batch-result-${decision.tone}`}>{decision.label}</span>
	            </div>
              );
            })}
          <div className="batch-result-legend">
            <strong>Förklaring:</strong> SL = Stop loss · TP = Take profit · R = Risk/reward · WR = Win rate · Timeframe = tidsram för testet
          </div>
	        </div>
	      )}
    </div>
  );
}

// ── Blockers Tab ──────────────────────────────────────────────────────────────
const BLOCKER_MODE_OPTIONS = [
  { value: 'block',   label: 'Stoppa hårt',         color: '#ef4444' },
  { value: 'warning', label: 'Bara varna',           color: '#f59e0b' },
  { value: 'ignore',  label: 'Släpp igenom i test',  color: '#22c55e' },
];

function BlockerRow({ blocker, mode, onModeChange }) {
  const opt = BLOCKER_MODE_OPTIONS.find(o => o.value === mode) || BLOCKER_MODE_OPTIONS[0];
  return (
    <div className="blk-row">
      <div className="blk-info">
        <div className="blk-label">{blocker.label}</div>
        <div className="blk-desc">{blocker.desc}</div>
      </div>
      <select
        className="blk-select"
        value={mode}
        onChange={e => onModeChange(blocker.key, e.target.value)}
        style={{ borderColor: opt.color, color: opt.color }}
      >
        {BLOCKER_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function BlockersTab() {
  const { data, loading, reload } = useBlockerConfig();
  const [saving, setSaving] = React.useState(false);

  async function updateMode(key, mode) {
    setSaving(true);
    await fetch('/api/blockers/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockers: { [key]: mode } }),
    }).catch(() => {});
    setSaving(false);
    reload();
  }

  async function toggleDiscovery(val) {
    setSaving(true);
    await fetch('/api/blockers/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discoveryMode: val }),
    }).catch(() => {});
    setSaving(false);
    reload();
  }

  if (loading) return <div className="tl-loading">Laddar blockeringskonfiguration...</div>;
  if (!data) return <div className="tl-empty">Ingen data.</div>;

  const { discoveryMode, blockers = {}, configurableBlockers = [], alwaysHardBlockers = [] } = data;

  return (
    <div className="tl-tab-content">
      <div className={`blk-discovery${discoveryMode ? ' blk-discovery-on' : ''}`}>
        <div className="blk-disc-left">
          <span className="blk-disc-icon">🔬</span>
          <div>
            <div className="blk-disc-title">Fri testinsamling</div>
            <div className="blk-disc-sub">
              {discoveryMode
                ? 'Aktivt — fler signaler släpps igenom. Säkerhetsskyddet är fortfarande aktivt.'
                : 'AV — standard blockeringar gäller. Aktivera för att samla mer data.'}
            </div>
          </div>
        </div>
        <button
          className={`tl-switch${discoveryMode ? ' tl-switch-on' : ''}`}
          onClick={() => toggleDiscovery(!discoveryMode)}
          disabled={saving}
          type="button"
        >
          <span className="tl-switch-thumb" />
        </button>
      </div>

      {discoveryMode && (
        <div className="blk-discovery-effects">
          <div className="blk-effects-title">Effekter av Fri testinsamling:</div>
          <ul className="blk-effects-list">
            <li>low_confidence → varning om styrka ≥ 40</li>
            <li>memory_block → varning (loggas, inte blockad)</li>
            <li>tradingagents_observe → kandidat (inte blockad)</li>
            <li>weak_volume → kandidat</li>
            <li>mixed_market → kandidat</li>
            <li>Fler signaler sparas som kandidater för analys</li>
          </ul>
          <div className="blk-effects-note">🔒 Skyddet är kvar — Safety blockerar alltid farliga lägen</div>
        </div>
      )}

      <GroupHeader icon="🚦" title="Konfigurera blockeringar" />
      <p className="tl-combo-intro">Välj hur varje blockering beter sig i testläge. Safety-blockeringar är alltid låsta.</p>
      <div className="blk-list">
        {configurableBlockers.map(b => (
          <BlockerRow key={b.key} blocker={b} mode={blockers[b.key] || 'block'} onModeChange={updateMode} />
        ))}
      </div>

      <GroupHeader icon="🔒" title="Alltid hårda blockeringar" />
      <p className="tl-combo-intro">Dessa kan ALDRIG mjukas upp — systemets kärnskydd.</p>
      <div className="blk-hard-list">
        {alwaysHardBlockers.map(b => (
          <div key={b.key} className="blk-hard-row">
            <span className="blk-hard-icon">🔒</span>
            <div className="blk-hard-info">
              <div className="blk-hard-label">{b.label}</div>
              <div className="blk-hard-reason">{b.reason}</div>
            </div>
            <span className="blk-hard-badge">Alltid block</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Presets Tab ───────────────────────────────────────────────────────────────
function PresetCard({ preset, onLoad, onDelete, isCustom }) {
  const modeColors = { tight: '#ef4444', medium: '#f59e0b', loose: '#22c55e' };
  const modeLabels = { tight: 'Tight', medium: 'Medium', loose: 'Loose/Discovery' };
  return (
    <div className="preset-card">
      <div className="preset-header">
        <span className="preset-icon">{preset.icon || '🎛️'}</span>
        <div className="preset-info">
          <div className="preset-name">{preset.name}</div>
          <div className="preset-desc">{preset.description}</div>
        </div>
        <div className="preset-btn-row">
          <button className="preset-load-btn" onClick={() => onLoad(preset)} type="button">Ladda</button>
          {isCustom && (
            <button className="preset-del-btn" onClick={() => onDelete(preset.id)} type="button">✕</button>
          )}
        </div>
      </div>
      <div className="preset-meta">
        {preset.blockerMode && (
          <span className="preset-mode" style={{ color: modeColors[preset.blockerMode], borderColor: modeColors[preset.blockerMode] }}>
            {modeLabels[preset.blockerMode] || preset.blockerMode}
          </span>
        )}
        {preset.discoveryMode && <span className="preset-disc">🔬 Fri testinsamling</span>}
      </div>
    </div>
  );
}

function PresetsTab({ toggles, params, exits, onApplyToggles, onApplyParams, onApplyExits }) {
  const { data, reload } = usePresets();
  const [saveName, setSaveName] = React.useState('');
  const [msg, setMsg] = React.useState('');

  function showMsg(text) { setMsg(text); setTimeout(() => setMsg(''), 3000); }

  async function loadPreset(preset) {
    if (preset.toggles) onApplyToggles(preset.toggles);
    if (preset.params)  onApplyParams(preset.params);
    if (preset.exits)   onApplyExits(preset.exits);
    showMsg(`✅ "${preset.name}" laddad!`);
  }

  async function savePreset() {
    const name = saveName.trim();
    if (!name) return;
    await fetch('/api/strategies/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save',
        preset: {
          id: `custom_${Date.now()}`,
          name,
          icon: '🎛️',
          description: `Sparad ${new Date().toLocaleDateString('sv-SE')}`,
          toggles: { ...toggles },
          params: { ...params },
          exits: { ...exits },
        },
      }),
    }).catch(() => {});
    setSaveName('');
    showMsg(`✅ "${name}" sparad!`);
    reload();
  }

  async function deletePreset(id) {
    await fetch('/api/strategies/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    }).catch(() => {});
    reload();
  }

  const builtIn = data?.builtIn || [];
  const custom  = data?.custom  || [];

  return (
    <div className="tl-tab-content">
      {msg && <div className="preset-save-msg">{msg}</div>}

      <GroupHeader icon="💾" title="Spara aktuell konfiguration" />
      <div className="preset-save-row">
        <input
          className="preset-name-input"
          value={saveName}
          onChange={e => setSaveName(e.target.value)}
          placeholder="Namn på din preset..."
          onKeyDown={e => e.key === 'Enter' && savePreset()}
        />
        <button className="preset-save-btn" onClick={savePreset} disabled={!saveName.trim()} type="button">
          💾 Spara
        </button>
      </div>

      {custom.length > 0 && (
        <>
          <GroupHeader icon="🎛️" title="Mina presets" />
          <div className="preset-list">
            {custom.map(p => <PresetCard key={p.id} preset={p} onLoad={loadPreset} onDelete={deletePreset} isCustom />)}
          </div>
        </>
      )}

      <GroupHeader icon="⭐" title="Inbyggda presets" />
      <div className="preset-list">
        {builtIn.map(p => <PresetCard key={p.id} preset={p} onLoad={loadPreset} onDelete={() => {}} isCustom={false} />)}
      </div>
    </div>
  );
}

function useRecentCandidates(limit = 40) {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/candidates/recent?n=${limit}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/candidates/stats').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([recent, s]) => {
      setData(recent);
      setStats(s);
      setLoading(false);
    }).catch(err => {
      setError(err.message);
      setLoading(false);
    });
  }, [limit]);

  useEffect(() => { load(); }, [load]);

  return { data, stats, candidates: data?.candidates || [], loading, error, reload: load };
}

function CandidatesTab() {
  const { data, stats, candidates, loading } = useRecentCandidates(40);

  if (loading) return <div className="tl-loading">Laddar kandidater...</div>;

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="◎" title="Kandidater" />
      <div className="tl-candidate-summary">
        <div><strong>{stats?.total ?? candidates.length}</strong><span>Kandidater loggade</span></div>
        <div><strong>{stats?.last24h ?? '–'}</strong><span>Senaste 24h</span></div>
        <div><strong>{data?.can_place_orders === false ? 'Nej' : 'Nej'}</strong><span>Kan lägga order</span></div>
      </div>
      {candidates.length === 0 ? (
        <PlatformEmptyState title="Inga kandidater ännu" text="Scanner och låtsastrading fyller denna lista när nya testlägen hittas." />
      ) : (
        <div className="tl-candidate-list">
          {candidates.slice(0, 20).map((c, i) => (
            <div key={`${c.symbol || 'candidate'}-${c.timestamp || i}`} className="tl-candidate-row">
              <strong>{c.symbol || 'Okänd symbol'}</strong>
              <span>{c.signalFamily || c.setup || c.eventType || 'Mönster saknas'}</span>
              <span>{c.marketType || c.market || 'Marknad saknas'}</span>
              <span>{c.tradeScore ?? c.score ?? '–'} styrka</span>
              <span className="tl-candidate-actions">
                <SignalAge timestamp={c.timestamp || c.lastUpdate || c.created_at} />
                {c.symbol && <TradingViewLink symbol={c.symbol} marketType={c.marketType || c.market} label="TV" size="sm" />}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function signalDirection(signal = {}) {
  const raw = String(signal.direction || signal.nextMoveBias || signal.bias || signal.signal || '').toUpperCase();
  if (/SHORT|BEAR|DOWN|SELL/.test(raw)) return 'DOWN';
  if (/LONG|BULL|UP|BUY/.test(raw)) return 'UP';
  return 'NEUTRAL';
}

function signalStrength(signal = {}) {
  return nullableNumber(signal.confidence, signal.confidenceScore, signal.tradeScore, signal.priorityScore, signal.score);
}

function nullableNumber(...values) {
  const value = values.find(v => v !== undefined && v !== null && v !== '');
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function signalStrategyLabel(signal = {}) {
  return signal.strategyName || signal.strategy_name || signal.strategy_id || signal.setupId || signal.signalFamily || signal.signal || 'Strategi saknas';
}

function signalOptionLabel(signal = {}, index = 0) {
  const time = formatSignalTimestamp(signal.detected_at || signal.ts || signal.evaluated_at, `#${index + 1}`);
  const strength = signalStrength(signal);
  return `${signal.symbol || 'Okänd'} · ${signalStrategyLabel(signal)} · ${strength == null ? 'score saknas' : strength} · ${time}`;
}

function signalTimestampMs(signal = {}) {
  const raw = signal.detected_at || signal.ts || signal.evaluated_at || signal.timestamp || signal.created_at;
  if (!raw) return 0;
  const d = new Date(raw);
  const ms = d.getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function formatSignalTimestamp(value, fallback = 'Saknas') {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function displaySignalValue(value, suffix = '') {
  if (value === null || value === undefined || value === '') return 'Saknas';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'Saknas';
  return `${value}${suffix}`;
}

function agentDebateText(agent = {}) {
  return agent.rationale_sv || agent.thesis_sv || agent.main_risk || 'Saknas';
}

function buildAgentDebateSignalContext(signal = {}) {
  const marketGroup = signal.market_group || signal.marketGroup || signal.marketType || signal.market || 'unknown';
  const confidence = signalStrength(signal);
  const volumeRatio = nullableNumber(signal.volume_ratio, signal.relativeVolume, signal.volumeRatio, signal.volume_requirement);
  const spreadEstimate = nullableNumber(signal.spread_estimate, signal.spreadEstimate, signal.spread_percent, signal.spreadPct);
  const volatility = nullableNumber(signal.volatility, signal.volatility_score, signal.atr_percent, signal.atrPct);
  const rsi = nullableNumber(signal.rsi, signal.rsi14);
  const missingFields = [];
  if (confidence == null) missingFields.push('confidence');
  if (volumeRatio == null) missingFields.push('volume_ratio');
  if (spreadEstimate == null) missingFields.push('spread_estimate');
  if (volatility == null) missingFields.push('volatility');
  if (rsi == null) missingFields.push('rsi');
  const context = {
    symbol: signal.symbol,
    market_group: marketGroup,
    timeframe: signal.timeframe || signal.tf || '2m',
    direction: signalDirection(signal),
    volume_ratio: volumeRatio,
    spread_estimate: spreadEstimate,
    volatility,
    rsi,
    missing_fields: missingFields,
    risk_class: signal.risk_class || signal.riskClass || 'unknown',
    signalFamily: signal.signalFamily || signal.signal_family || signal.setupId || signal.signal || 'unknown',
    strategy_name: signalStrategyLabel(signal),
    live: false,
    live_enabled: false,
    live_trading_enabled: false,
    actions_allowed: false,
    can_place_orders: false,
    can_modify_system: false,
  };
  if (confidence != null) context.confidence = confidence;
  return context;
}

function AgentDebateTab() {
  const [status, setStatus] = React.useState(null);
  const { candidates, loading: signalsLoading, error: signalsError } = useRecentCandidates(40);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [result, setResult] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    fetch('/api/agent-debate/status')
      .then(r => r.ok ? r.json() : null)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const sortedCandidates = React.useMemo(() => (
    [...candidates].sort((a, b) => signalTimestampMs(b) - signalTimestampMs(a))
  ), [candidates]);

  React.useEffect(() => {
    if (sortedCandidates.length > 0 && selectedIndex >= sortedCandidates.length) setSelectedIndex(0);
  }, [selectedIndex, sortedCandidates.length]);

  async function analyze() {
    const selected = sortedCandidates[selectedIndex] || sortedCandidates[0];
    if (!selected) {
      setError('Ingen signal vald.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const signalContext = buildAgentDebateSignalContext(selected);
      const res = await fetch('/api/agent-debate/analyze-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signalContext),
      });
      const body = await res.json();
      setResult(body);
      if (!res.ok || body.ok === false) setError(body.error || 'Analysen kunde inte köras.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const agents = result?.agents ? Object.entries(result.agents) : [];
  const selectedSignal = sortedCandidates[selectedIndex] || sortedCandidates[0] || null;
  const selectedContext = selectedSignal ? buildAgentDebateSignalContext(selectedSignal) : null;
  const selectedTimestamp = selectedSignal
    ? (selectedSignal.detected_at || selectedSignal.ts || selectedSignal.evaluated_at || selectedSignal.timestamp || selectedSignal.created_at)
    : null;
  const selectedIsLatest = sortedCandidates.length > 0 && selectedIndex === 0;
  const missingFields = result?.missing_fields?.length ? result.missing_fields : selectedContext?.missing_fields || [];
  const blockedBySafety = result?.error === 'live_or_order_intent_blocked' || error === 'live_or_order_intent_blocked';
  const roleLabels = {
    technical: 'Teknisk bild',
    sentiment: 'Sentiment',
    bull: 'Bull case',
    bear: 'Bear case',
    risk: 'Risk',
  };

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="💡" title="Beslutsråd" />
      <div className="ad-safety">
        <span>analysis_only={String((result || status)?.analysis_only === true)}</span>
        <span>paper_only={String((result || status)?.paper_only === true)}</span>
        <span>live=false</span>
        <span>live_enabled=false</span>
        <span>actions_allowed=false</span>
        <span>can_place_orders=false</span>
        <span>can_modify_system=false</span>
      </div>
      <div className="ad-advisory">
        <strong>Beslutsrådet förklarar en signal.</strong> Det optimerar inte strategier och lägger inga order.
      </div>
      <div className="ad-difference">Skillnad: Optimeringsagenten analyserar historiska trades. Beslutsrådet analyserar en enskild signal.</div>
      <div className="agent-debate-safety-row">Rådgivande analys. Ingen riktig order kan läggas.</div>

      <div className="ad-panel">
        {signalsLoading && <div className="tl-loading">Hämtar senaste signaler...</div>}
        {!signalsLoading && signalsError && <div className="ad-error">Kunde inte hämta signaler: {signalsError}</div>}
        {!signalsLoading && !signalsError && sortedCandidates.length === 0 && (
          <PlatformEmptyState title="Inga senaste signaler hittades" text="Inga senaste signaler hittades. Kör scanner eller vänta på nya kandidater." />
        )}
        {!signalsLoading && sortedCandidates.length > 0 && (
          <>
            <label className="agent-debate-select">
              <span>Välj signal</span>
              <select value={selectedIndex} onChange={e => { setSelectedIndex(Number(e.target.value)); setResult(null); setError(null); }}>
                {sortedCandidates.map((signal, index) => (
                  <option key={`${signal.symbol || 'signal'}-${signal.ts || signal.detected_at || index}`} value={index}>
                    {index === 0 ? 'Senaste signal - ' : ''}{signalOptionLabel(signal, index)}
                  </option>
                ))}
              </select>
            </label>
            {selectedContext && (
              <div className="agent-debate-latest-card">
                <div className="agent-debate-latest-head">
                  <strong>{selectedIsLatest ? 'Senaste signal' : 'Vald signal'}</strong>
                  {selectedIsLatest && <span>Senaste signal</span>}
                </div>
                <div className="agent-debate-signal-summary">
                  <span><b>Symbol</b>{displaySignalValue(selectedContext.symbol || selectedSignal.symbol)}</span>
                  <span><b>Strategi</b>{displaySignalValue(selectedContext.strategy_name)}</span>
                  <span><b>Timeframe</b>{displaySignalValue(selectedContext.timeframe)}</span>
                  <span><b>Riktning</b>{displaySignalValue(selectedContext.direction)}</span>
                  <span><b>Confidence/score</b>{displaySignalValue(selectedContext.confidence, '/100')}</span>
                  <span><b>Timestamp</b>{formatSignalTimestamp(selectedTimestamp)}</span>
                </div>
              </div>
            )}
            {selectedContext?.missing_fields?.length > 0 && (
              <div className="agent-debate-missing">Saknad data: {selectedContext.missing_fields.join(', ')}. Null/undefined tolkas inte som 0.</div>
            )}
          </>
        )}
        <button className="ad-run-btn" type="button" onClick={analyze} disabled={loading || signalsLoading || sortedCandidates.length === 0}>
          {loading ? 'Analyserar signal...' : selectedIsLatest ? 'Analysera senaste signal' : 'Analysera vald signal'}
        </button>
      </div>

      {error && <div className="ad-error">{blockedBySafety ? 'Säkerhetsvarning: signalen innehöll live/order-intent och blockerades.' : error}</div>}

      {result?.ok && (
        <div className="ad-result">
          {missingFields.length > 0 && (
            <div className="agent-debate-missing">
              Saknad data: {missingFields.join(', ')}. {result.data_quality_warning || 'Analysen är mer osäker.'}
            </div>
          )}
          <div className="ad-final">
            <div>
              <span>Symbol</span>
              <strong>{displaySignalValue(result.symbol || selectedContext?.symbol || 'Okänd')}</strong>
            </div>
            <div>
              <span>Strategi</span>
              <strong>{displaySignalValue(selectedContext?.strategy_name || result.signal?.signal_family)}</strong>
            </div>
            <div>
              <span>Timeframe</span>
              <strong>{displaySignalValue(result.timeframe || selectedContext?.timeframe)}</strong>
            </div>
            <div>
              <span>Slutbeslut</span>
              <strong>{displaySignalValue(result.final_decision)}</strong>
            </div>
            <div>
              <span>Confidence</span>
              <strong>{displaySignalValue(result.confidence_score, '/100')}</strong>
            </div>
            <div>
              <span>Safety</span>
              <strong>Order blockerad</strong>
            </div>
          </div>
          <p className="ad-rationale">{result.rationale_sv}</p>
          <div className="ad-agent-grid">
            {agents.map(([key, agent]) => (
              <div key={key} className="ad-agent-card">
                <div className="ad-agent-title">{roleLabels[key] || key.replace(/_/g, ' ')}</div>
                <div className="ad-agent-score">
                  {agent.score ?? agent.case_strength ?? agent.risk_level ?? 'neutral'}
                </div>
                <div className="ad-agent-text">{agentDebateText(agent)}</div>
              </div>
            ))}
          </div>
          <div className="agent-debate-safety-row">Rådgivande analys. Ingen riktig order kan läggas.</div>
        </div>
      )}
      {!result?.ok && blockedBySafety && (
        <div className="agent-debate-safety-row">Rådgivande analys. Ingen riktig order kan läggas.</div>
      )}
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'strategier',    label: 'Strategier',    icon: '🧩' },
  { key: 'batch',         label: 'Kör historiskt batch-test',     icon: '🧪' },
  { key: 'marknader',     label: 'Marknader',     icon: '🌍' },
  { key: 'sliders',       label: 'Sliders',        icon: '🎚️' },
  { key: 'exits',         label: 'Exits',         icon: '↘️' },
  { key: 'replay',        label: 'Spela upp historiska signaler',        icon: '▶️' },
  { key: 'ai_agent',      label: 'Föreslå testplan',      icon: '🤖' },
  { key: 'agent_debate',  label: 'Beslutsråd', icon: '💡' },
  { key: 'adaptive',      label: 'Visa lärande från tester', icon: '🧠' },
  { key: 'review',        label: 'Graf',          icon: '⌁' },
  { key: 'candidates',    label: 'Kandidater',    icon: '◎' },
];

// ── Main page ─────────────────────────────────────────────────────────────────
export default function TradingLabPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    test,
    updateTradingLabConfig,
    replaceTradingLabConfig,
  } = useUnifiedConfig('lab');
  const [advancedMode, setAdvancedMode] = useAdvancedMode();
  const requestedTab = searchParams.get('tab') || 'strategier';
  const tab = TABS.some(t => t.key === requestedTab) ? requestedTab : 'strategier';
  const { toggles, params, exits } = test.tradingLabConfig;

  function changeTab(next) {
    setSearchParams(next === 'strategier' ? {} : { tab: next });
  }

  function setToggle(key, val) {
    if (key === 'safety_engine') return;
    updateTradingLabConfig({ toggles: { [key]: val } });
  }
  function setParam(key, val) {
    updateTradingLabConfig({ params: { [key]: val } });
  }
  function setExit(key, val) {
    updateTradingLabConfig({ exits: { [key]: val } });
  }
  function applyToggles(next) {
    updateTradingLabConfig({ toggles: next });
  }
  function applyParams(next) {
    updateTradingLabConfig({ params: next });
  }
  function applyExits(next) {
    updateTradingLabConfig({ exits: next });
  }

  function resetAll() {
    replaceTradingLabConfig({ toggles: DEFAULT_TOGGLES, params: DEFAULT_PARAMS, exits: DEFAULT_EXITS });
  }

  const signalToggles = TOGGLE_META.filter(m => m.group === 'signal');
  const aiToggles     = TOGGLE_META.filter(m => m.group === 'ai');
  const protToggles   = TOGGLE_META.filter(m => m.group === 'protection');

  const activeSignalCount = TOGGLE_META.filter(m => toggles[m.key]).length;

  return (
    <div className="tl-page">
      {/* Header */}
      <div className="tl-page-header">
        <div className="tl-page-title-row">
          <h1 className="tl-page-title">🧪 LAB</h1>
          <div className="tl-page-meta">
            <span className="tl-active-count">{activeSignalCount} aktiva motorer</span>
            <ConfigScopeBadge scope="test" />
            <AdvancedModeToggle value={advancedMode} onChange={setAdvancedMode} />
            <button className="tl-reset-btn" onClick={resetAll} type="button">Återställ</button>
          </div>
        </div>
        <p className="tl-page-sub">
          Lab påverkar inte vilka strategier som kör paper trades. Här kör du bara test, replay, batch, parametrar och analys.
        </p>
      </div>

      <PlatformSafetyBar />
      <SafetyNote />

      {/* Tab bar */}
      <div className="tl-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`tl-tab${tab === t.key ? ' tl-tab-active' : ''}`}
            onClick={() => changeTab(t.key)}
            type="button"
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab: Signaler */}
      {tab === 'strategier' && (
        <>
          <StrategiesTab />
          {advancedMode && (
            <div className="tl-tab-content">
              <GroupHeader icon="📡" title="Signalmotorer" />
              <div className="tl-toggle-list">
                {signalToggles.map(m => (
                  <Toggle key={m.key} label={m.label} desc={m.desc}
                  value={toggles[m.key]} onChange={v => setToggle(m.key, v)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {advancedMode && tab === 'signaler' && (
        <div className="tl-tab-content">
          <GroupHeader icon="📡" title="Signalmotorer" />
          <div className="tl-toggle-list">
            {signalToggles.map(m => (
              <Toggle key={m.key} label={m.label} desc={m.desc}
                value={toggles[m.key]} onChange={v => setToggle(m.key, v)} />
            ))}
          </div>

          <GroupHeader icon="🤖" title="AI &amp; Minne" />
          <div className="tl-toggle-list">
            {aiToggles.map(m => (
              <Toggle key={m.key} label={m.label} desc={m.desc}
                value={toggles[m.key]} onChange={v => setToggle(m.key, v)} />
            ))}
          </div>

          <GroupHeader icon="🛡️" title="Skydd" />
          <div className="tl-toggle-list">
            {protToggles.map(m => (
              <Toggle key={m.key} label={m.label} desc={m.desc}
                value={toggles[m.key]} onChange={v => setToggle(m.key, v)}
                disabled={m.key === 'risk_engine' || m.key === 'safety_engine'}
              />
            ))}
          </div>
          <div className="tl-prot-note">Riskmotor och Säkerhetsmotor kan inte stängas av.</div>
        </div>
      )}

      {tab === 'batch' && <BatchTestTab />}

      {/* Tab: Parametrar */}
      {tab === 'sliders' && (
        <div className="tl-tab-content">
          <GroupHeader icon="🎯" title="Testinställningar" />
          <p className="tl-sliders-intro">
            Här kan du ändra hur systemet testar signaler. Detta påverkar bara test, paper och replay - inte riktiga trades.
          </p>

          <div className="tl-howto-box">
            <div>
              <h2>Så använder du sliders</h2>
              <p>En slider är bara ett reglage som gör systemet mer försiktigt eller mer aggressivt.</p>
            </div>
            <ol>
              <li>Börja med små ändringar.</li>
              <li>Testa en sak i taget.</li>
              <li>Kör batch-test efter ändring.</li>
              <li>Jämför resultat före och efter.</li>
              <li>Använd inte höga riskvärden utan mycket testdata.</li>
            </ol>
          </div>

          <div className="tl-test-safe-box">
            <div>
              <h2>Säkert testläge</h2>
              <p>Inga riktiga köp eller sälj görs. Dessa reglage används bara för analys och låtsastrading.</p>
            </div>
            <div className="tl-tech-flags">
              <span>actions_allowed=false</span>
              <span>can_place_orders=false</span>
              <span>live_trading_enabled=false</span>
            </div>
          </div>

          <SliderPresetButtons onApply={applyParams} />

          {SLIDER_GROUPS.map(group => (
            <SliderGroup
              key={group.title}
              title={group.title}
              keys={group.keys}
              params={params}
              onChange={setParam}
            />
          ))}

          <CurrentTestProfile params={params} />
        </div>
      )}

      {/* Tab: Exits */}
      {tab === 'exits' && (
        <div className="tl-tab-content">
          <GroupHeader icon="↘️" title="Exitstrategier" />
          <p className="tl-exits-intro">
            Välj vilka exit-metoder som ska användas. Flera kan kombineras.
          </p>
          <div className="tl-exits-grid">
            {EXIT_TYPES.map(item => (
              <ExitToggle
                key={item.key}
                item={item}
                value={exits[item.key]}
                onChange={v => setExit(item.key, v)}
              />
            ))}
          </div>

          <div className="tl-exits-active">
            <div className="tl-exits-active-title">Aktiva exits:</div>
            <div className="tl-exits-active-list">
              {EXIT_TYPES.filter(e => exits[e.key]).map(e => (
                <span key={e.key} className="tl-exits-active-chip">{e.label}</span>
              ))}
              {EXIT_TYPES.filter(e => exits[e.key]).length === 0 && (
                <span className="tl-exits-none">Inga exits valda</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Kombinationer */}
      {advancedMode && tab === 'kombinationer' && (
        <div className="tl-tab-content">
          <GroupHeader icon="🧬" title="Signalkombinationer" />
          <p className="tl-combo-intro">
            Fördefinierade kombinationer av signalmotorer för analys i Lab.
          </p>
          <div className="tl-combo-grid">
            {COMBOS.map((combo, i) => (
              <ComboCard key={i} combo={combo} toggles={toggles} />
            ))}
          </div>

          <div className="tl-ai-opt-banner">
            <div className="tl-ai-opt-icon">🤖</div>
            <div>
              <div className="tl-ai-opt-title">Optimering — kommer snart</div>
              <div className="tl-ai-opt-sub">
                Optimeringsmotorn kommer analysera bästa kombinationer baserat på historisk data.
                Konfigurationen du bygger här är grunden för det.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Marknader */}
      {tab === 'marknader' && <MarketsTab />}

      {/* Tab: Blockerare */}
      {advancedMode && tab === 'blockerare' && <BlockersTab />}

      {/* Tab: Presets */}
      {advancedMode && tab === 'presets' && (
        <PresetsTab
          toggles={toggles}
          params={params}
          exits={exits}
          onApplyToggles={applyToggles}
          onApplyParams={applyParams}
          onApplyExits={applyExits}
        />
      )}

      {/* Tab: AI Optimization */}
      {tab === 'ai_agent' && (
        <AiOptimizationTab
          toggles={toggles}
          params={params}
          exits={exits}
          onApplyParams={applyParams}
          onApplyToggles={applyToggles}
          onApplyExits={applyExits}
        />
      )}

      {tab === 'agent_debate' && <AgentDebateTab />}

      {tab === 'replay' && (
        <div className="tl-embedded-page"><ReplayPage /></div>
      )}

      {tab === 'review' && (
        <div className="tl-embedded-page"><ReviewChartPage /></div>
      )}

      {tab === 'adaptive' && <AdaptiveIntelligenceTab />}

      {tab === 'candidates' && <CandidatesTab />}

      {/* Bottom nav */}
      <div className="tl-bottom-nav">
        <Link to="/live" className="tl-bottom-link">❤️ LIVE</Link>
        <Link to="/insikter" className="tl-bottom-link">📊 INSIKTER</Link>
        <Link to="/system?tab=safety" className="tl-bottom-link">🛡️ SYSTEM</Link>
      </div>
    </div>
  );
}
