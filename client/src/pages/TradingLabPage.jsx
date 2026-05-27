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
  { key: 'ai_agent',          label: 'AI-analys',          group: 'ai',    desc: 'AI-motorn analyserar signalens kontext och styrka' },
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
  { key: 'dynamic_exit',    label: 'Dynamisk exit',   desc: 'AI-styrd exit baserat på marknadsläget',         defaultOn: false },
  { key: 'volatility_exit', label: 'Volatilitetsxit', desc: 'Stäng om volatiliteten ökar kraftigt',           defaultOn: false },
];

const COMBOS = [
  { label: 'VWAP + Volym',         keys: ['vwap_reclaim', 'volume_spike'],          hint: 'Klassiskt mönster — VWAP med volymbekräftelse' },
  { label: 'Narrow + AI',          keys: ['narrow_state', 'ai_agent'],              hint: 'AI analyserar narrow state-mönster' },
  { key: 'ema_pullback',
    label: 'EMA + Rekyl',          keys: ['ema_trend', 'ema_pullback'],             hint: 'Trend plus rekyl mot EMA' },
  { label: 'VWAP + Trend + AI',    keys: ['vwap_reclaim', 'ema_trend', 'ai_agent'], hint: 'Kombinerat tekniskt + AI-stöd' },
  { label: 'Breakout + Volym',     keys: ['breakout', 'volume_spike'],              hint: 'Utbrott bekräftat av volym' },
  { label: 'Narrow + Stark rörelse',    keys: ['narrow_state', 'momentum'],              hint: 'Ihoptryckt pris + fart' },
];

// ── Components ────────────────────────────────────────────────────────────────

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

function Slider({ label, desc, value, min, max, step, unit, format, onChange }) {
  const pct = ((value - min) / (max - min)) * 100;
  const display = format ? format(value) : `${value}${unit || ''}`;
  return (
    <div className="tl-slider-wrap">
      <div className="tl-slider-top">
        <div className="tl-slider-label">{label}</div>
        <div className="tl-slider-value">{display}</div>
      </div>
      {desc && <div className="tl-slider-desc">{desc}</div>}
      <div className="tl-slider-track">
        <div className="tl-slider-fill" style={{ width: `${pct}%` }} />
        <input
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="tl-slider-input"
        />
      </div>
      <div className="tl-slider-ends">
        <span>{format ? format(min) : `${min}${unit || ''}`}</span>
        <span>{format ? format(max) : `${max}${unit || ''}`}</span>
      </div>
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

// ── AI Optimization Panel components ─────────────────────────────────────────

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

  if (loading) return <div className="opt-apply-loading">Hämtar AI-konfiguration...</div>;
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
    if (typeof val === 'boolean') return val ? 'På' : 'Av';
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
          <div className="opt-apply-title">Auto-apply AI-konfiguration</div>
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
          {adaptiveMode ? '🟢 PÅ' : '⚪ AV'}
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
      <span>AI-agenten analyserar historiska trades...</span>
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
          <div className="opt-title">🤖 AI Optimization Agent</div>
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
                Batch {strategyBatchTesting.latestBatch.name} · {strategyBatchTesting.latestBatch.status} · {strategyBatchTesting.latestBatch.progress?.completed || 0}/{strategyBatchTesting.latestBatch.progress?.total || 0}
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
            <div className="opt-empty">Inga batch-resultat ännu. Kör Batch-test i Trading Lab för att få AI-rekommendationer.</div>
          )}
        </div>
      )}

      {/* Recommendations */}
      {section === 'recs' && (
        <div className="opt-section-content">
          <div className="opt-subsection">Auto-apply — Applicera AI-rekommendationer</div>
          <ApplyPanel
            toggles={toggles}
            params={params}
            exits={exits}
            onApplyParams={onApplyParams}
            onApplyToggles={onApplyToggles}
            onApplyExits={onApplyExits}
          />
          <div className="opt-subsection" style={{ marginTop: '1.5rem' }}>AI-agentens rekommendationer</div>
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

// ── Markets Tab ───────────────────────────────────────────────────────────────
function MarketsTab() {
  const { data, loading, reload } = useMarketUniverse();
  const [addSym, setAddSym] = React.useState('');
  const [addGroup, setAddGroup] = React.useState('stocks');

  async function toggleGroup(key, val, current) {
    await fetch('/api/markets/universe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: { [key]: { ...current, enabled: val } } }),
    }).catch(() => {});
    reload();
  }

  async function addSymbol() {
    const sym = addSym.trim().toUpperCase();
    if (!sym) return;
    await fetch('/api/markets/symbols/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, marketGroup: addGroup }),
    }).catch(() => {});
    setAddSym('');
    reload();
  }

  async function patchSym(symbol, patch) {
    await fetch('/api/markets/symbols/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, patch }),
    }).catch(() => {});
    reload();
  }

  async function removeSym(symbol) {
    await fetch('/api/markets/symbols/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    }).catch(() => {});
    reload();
  }

  if (loading) return <div className="tl-loading">Laddar marknader...</div>;
  if (!data) return <div className="tl-empty">Ingen marknadsdata.</div>;

  const { groups = {}, symbols = [] } = data;

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="🌍" title="Marknadsgrupper" />
      <div className="tl-scope-row">
        <ConfigScopeBadge scope="global" />
        <span>Marknadsuniversum är global scanner-config. Ändringar här påverkar riktiga scannerurvalet.</span>
      </div>
      <div className="mu-group-grid">
        {Object.entries(groups).map(([key, grp]) => (
          <div key={key} className={`mu-group-card${grp.enabled ? ' mu-group-on' : ''}`}>
            <div className="mu-group-header">
              <div className="mu-group-info">
                <div className="mu-group-label" style={{ color: grp.color }}>{grp.label}</div>
                <div className="mu-group-meta">Max {grp.maxSymbols} · Prio {grp.priority}</div>
              </div>
              <button
                className={`tl-switch tl-switch-sm${grp.enabled ? ' tl-switch-on' : ''}`}
                onClick={() => toggleGroup(key, !grp.enabled, grp)}
                type="button"
              >
                <span className="tl-switch-thumb" />
              </button>
            </div>
            <div className="mu-group-badges">
              {grp.paperEnabled && <span className="mu-badge mu-paper">Paper</span>}
              {grp.observeOnly && <span className="mu-badge mu-observe">Bara observera</span>}
            </div>
          </div>
        ))}
      </div>

      <GroupHeader icon="📋" title="Symboler" />
      <div className="mu-add-row">
        <input
          className="mu-sym-input"
          value={addSym}
          onChange={e => setAddSym(e.target.value.toUpperCase())}
          placeholder="Symbol (t.ex. GOOGL)"
          onKeyDown={e => e.key === 'Enter' && addSymbol()}
        />
        <select className="mu-group-select" value={addGroup} onChange={e => setAddGroup(e.target.value)}>
          {Object.entries(groups).map(([key, g]) => <option key={key} value={key}>{g.label}</option>)}
        </select>
        <button className="mu-add-btn" onClick={addSymbol} type="button">+ Lägg till</button>
      </div>
      <div className="mu-sym-list">
        {symbols.map(sym => (
          <div key={sym.symbol} className={`mu-sym-row${sym.paused ? ' mu-sym-paused' : ''}${!sym.enabled ? ' mu-sym-off' : ''}`}>
            <div className="mu-sym-main">
              <span className="mu-sym-name">{sym.symbol}</span>
              <span className="mu-sym-group" style={{ color: groups[sym.marketGroup]?.color }}>
                {groups[sym.marketGroup]?.label || sym.marketGroup}
              </span>
              <span className={`mu-sym-mode mu-mode-${sym.testMode}`}>{sym.testMode}</span>
            </div>
            <div className="mu-sym-actions">
              <button
                className={`mu-sym-toggle${sym.enabled && !sym.paused ? ' mu-active' : ''}`}
                onClick={() => patchSym(sym.symbol, { enabled: !sym.enabled })}
                type="button"
              >{sym.enabled ? 'På' : 'Av'}</button>
              <button
                className={`mu-sym-pause${sym.paused ? ' mu-paused' : ''}`}
                onClick={() => patchSym(sym.symbol, { paused: !sym.paused })}
                type="button"
                title={sym.paused ? 'Återuppta' : 'Pausa'}
              >{sym.paused ? '▶' : '⏸'}</button>
              <button className="mu-sym-remove" onClick={() => removeSym(sym.symbol)} type="button">✕</button>
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
  if (v == null || Number.isNaN(Number(v))) return 'Ingen data';
  return `${Number(v).toFixed(1)}%`;
}

function defaultStrategySettings(strategy) {
  return {
    sl: strategy.default_sl ?? 0.2,
    tp: strategy.default_tp ?? 1.5,
    holding_time: strategy.default_holding_time ?? 10,
    timeout: strategy.default_holding_time ?? 10,
    confidence_threshold: 65,
    volume_requirement: 1.2,
    cooldown: 5,
    max_trades_per_day: 5,
    market_group: strategy.market_group || 'all',
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

function StrategyCard({ strategy, value, onChange, performance, settings, onSettingsChange, onTest }) {
  const [open, setOpen] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [lastResult, setLastResult] = React.useState(null);
  const perf = performance?.[strategy.id];
  const badge = perf?.performance_badge;

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
    <div className={`strat-card${value ? ' strat-card-on' : ''}`}>
      <div className="strat-card-header">
        <div className="strat-info">
          <div className="strat-title-row">
            <div className="strat-label">{strategy.name}</div>
            <span className="strat-paper-badge">Paper only</span>
          </div>
          <div className="strat-score-impact">
            {strategy.market_label || strategy.market_group} · SL {strategy.default_sl}% · TP {strategy.default_tp}R · {strategy.default_holding_time} min
          </div>
        </div>
        <ConfigScopeBadge scope="test" />
        <div className="strat-controls">
          <button className="strat-test-btn" onClick={testStrategy} disabled={testing} type="button">
            {testing ? 'Testar...' : 'Testa strategi'}
          </button>
          <button className="strat-expand" onClick={() => setOpen(v => !v)} type="button">{open ? '▲' : '▼'}</button>
          <button
            className={`tl-switch tl-switch-sm${value ? ' tl-switch-on' : ''}`}
            onClick={() => onChange(!value)}
            type="button"
            aria-pressed={value}
          >
            <span className="tl-switch-thumb" />
          </button>
        </div>
      </div>
      <div className="strat-desc">{strategy.explanation}</div>
      <div className="strat-result-row">
        <span>Historisk vinstprocent: <strong>{perf ? pctText(perf.win_rate) : 'Ingen data'}</strong></span>
        {badge && <span className={`strat-perf-badge strat-perf-${badge.tone}`}>{badge.label}</span>}
        {lastResult && <span>Senast: {lastResult.trades} trades · {pctText(lastResult.win_rate)} WR · {lastResult.total_pnl >= 0 ? '+' : ''}{lastResult.total_pnl}% P/L</span>}
      </div>
      {open && (
        <div className="strat-details">
          <div className="strat-rules">
            {(strategy.signal_rules || []).map(rule => <span key={rule}>{rule.replace(/_/g, ' ')}</span>)}
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

function StrategiesTab({ toggles, onChange }) {
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
  const activeCount = strategies.filter(s => toggles[s.id]).length;

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="🧩" title="Strategikatalog" />
      <p className="tl-combo-intro">
        {activeCount} av {strategies.length} aktiverade · Paper &amp; Replay only · Inga riktiga orders
      </p>
      <div className="strat-list">
        {strategies.map(strategy => (
          <StrategyCard
            key={strategy.id}
            strategy={strategy}
            value={!!toggles[strategy.id]}
            onChange={v => onChange(strategy.id, v)}
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

function BatchTestTab() {
  const [catalog, setCatalog] = React.useState([]);
  const [batches, setBatches] = React.useState([]);
  const [activeBatch, setActiveBatch] = React.useState(null);
  const [compare, setCompare] = React.useState(null);
  const [auditTimeline, setAuditTimeline] = React.useState([]);
  const [message, setMessage] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [form, setForm] = React.useState({
    strategy_ids: ['vwap_momentum_long', 'opening_range_breakout'],
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
  });

  const load = React.useCallback(async () => {
    const [cat, list] = await Promise.all([
      fetch('/api/daytrading-strategies/catalog').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/strategy-batches').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    setCatalog(cat?.strategies || []);
    setBatches(list?.batches || []);
    if (!activeBatch && list?.batches?.[0]) setActiveBatch(list.batches[0]);
    setLoading(false);
  }, [activeBatch]);

  React.useEffect(() => { load(); }, [load]);

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
    const res = await fetch('/api/strategy-batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload()),
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

  return (
    <div className="tl-tab-content">
      <GroupHeader icon="🧪" title="Batch-test" />
      <div className="batch-safety">Paper/replay only · actions_allowed=false · can_place_orders=false · live_trading_enabled=false</div>

      <div className="batch-layout">
        <div className="batch-panel">
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
          <div className="batch-inline-checks">
            {['all', 'crypto', 'stocks', 'index', 'etf'].map(m => (
              <label key={m} className="batch-pill-check">
                <input type="checkbox" checked={form.markets.includes(m)} onChange={() => toggleArray('markets', m)} />
                <span>{m}</span>
              </label>
            ))}
          </div>
          <label className="batch-field">
            <span>Symboler</span>
            <input value={form.symbols} onChange={e => setForm(f => ({ ...f, symbols: e.target.value }))} />
          </label>
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
          <div className="batch-section-title">Parameter grid</div>
          <label className="batch-field"><span>Stop loss %</span><input value={form.stop_losses} onChange={e => setForm(f => ({ ...f, stop_losses: e.target.value }))} /></label>
          <label className="batch-field"><span>Take profit R</span><input value={form.take_profits} onChange={e => setForm(f => ({ ...f, take_profits: e.target.value }))} /></label>
          <label className="batch-field"><span>Holding time min</span><input value={form.holding_times} onChange={e => setForm(f => ({ ...f, holding_times: e.target.value }))} /></label>
          <label className="batch-field"><span>Timeout min</span><input value={form.timeouts} onChange={e => setForm(f => ({ ...f, timeouts: e.target.value }))} /></label>
          <label className="batch-field"><span>Confidence</span><input value={form.confidence_thresholds} onChange={e => setForm(f => ({ ...f, confidence_thresholds: e.target.value }))} /></label>
          <label className="batch-field"><span>Volymkrav</span><input value={form.volume_requirements} onChange={e => setForm(f => ({ ...f, volume_requirements: e.target.value }))} /></label>
        </div>
      </div>

      <div className={`batch-combo-card${comboCount > 500 ? ' batch-too-large' : ''}`}>
        <div><strong>{comboCount}</strong><span>kombinationer</span></div>
        <div><strong>{activeBatch?.status || 'ingen batch'}</strong><span>status</span></div>
        <div><strong>{progress.completed ?? 0}/{progress.total ?? 0}</strong><span>progress</span></div>
        <div><strong>{progress.pct ?? 0}%</strong><span>klart</span></div>
      </div>
      {message && <div className="batch-message">{message}</div>}

      <div className="batch-actions">
        <button type="button" onClick={createBatch}>Skapa batch</button>
        <button type="button" onClick={() => runBatch()} disabled={comboCount > 500}>Starta batch</button>
        <button type="button" onClick={pauseBatch} disabled={!activeBatch}>Pausa</button>
        <button type="button" onClick={stopBatch} disabled={!activeBatch}>Stoppa</button>
        <button type="button" onClick={() => loadCompare()} disabled={!activeBatch}>Uppdatera resultat</button>
      </div>

      <div className="batch-progress-track">
        <div style={{ width: `${Math.max(0, Math.min(100, progress.pct || 0))}%` }} />
      </div>

      {activeBatch && (
        <div className="batch-timeline">
          <div className="batch-section-title">Audit-timeline</div>
          <div className="batch-timeline-grid">
            <div><span>Skapad</span><strong>{fmtBatchTime(activeBatch.batch_created_at || activeBatch.created_at)}</strong></div>
            <div><span>Startad</span><strong>{fmtBatchTime(activeBatch.batch_started_at || activeBatch.started_at)}</strong></div>
            <div><span>Klar</span><strong>{fmtBatchTime(activeBatch.batch_completed_at || activeBatch.completed_at)}</strong></div>
            <div><span>Duration</span><strong>{batchDurationLabel(activeBatch)}</strong></div>
          </div>
          <div className="batch-audit-list">
            {auditTimeline.length > 0 ? auditTimeline.map(event => (
              <div key={event.event_id} className="batch-audit-row">
                <span>{fmtBatchTime(event.timestamp)}</span>
                <strong>{event.message}</strong>
                <em>{event.details?.progress ? `${event.details.progress.completed || 0}/${event.details.progress.total || 0}` : event.type}</em>
              </div>
            )) : (
              <div className="batch-audit-empty">Ingen audit-timeline ännu.</div>
            )}
          </div>
        </div>
      )}

      {batches.length > 0 && (
        <div className="batch-history">
          {batches.slice(0, 6).map(b => (
            <button key={b.id} type="button" className={activeBatch?.id === b.id ? 'active' : ''} onClick={() => { setActiveBatch(b); setCompare(null); setAuditTimeline([]); }}>
              <strong>{b.name}</strong>
              <span>{b.status} · {b.progress?.completed || 0}/{b.progress?.total || 0}</span>
            </button>
          ))}
        </div>
      )}

      {compare?.best_overall?.length > 0 && (
        <div className="batch-results">
          <div className="batch-section-title">Toppresultat</div>
          {compare.best_overall.slice(0, 8).map((r, i) => (
            <div key={`${r.strategy_id}-${r.symbol}-${i}`} className="batch-result-row">
              <strong>{r.score}</strong>
              <span>{r.strategy_name}</span>
              <span>{r.symbol}</span>
              <span>SL {r.stop_loss}% / TP {r.take_profit}R / {r.holding_time}m</span>
              <span>{r.win_rate}% WR · {r.avg_pnl >= 0 ? '+' : ''}{r.avg_pnl}%</span>
            </div>
          ))}
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
                ? 'PÅ — fler signaler släpps igenom. Säkerhetsskyddet är fortfarande aktivt.'
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

function CandidatesTab() {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/candidates/recent?n=40').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/candidates/stats').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([recent, s]) => {
      setData(recent);
      setStats(s);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="tl-loading">Laddar kandidater...</div>;
  const candidates = data?.candidates || [];

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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'strategier',    label: 'Strategier',    icon: '🧩' },
  { key: 'batch',         label: 'Batch-test',     icon: '🧪' },
  { key: 'marknader',     label: 'Marknader',     icon: '🌍' },
  { key: 'sliders',       label: 'Sliders',        icon: '🎚️' },
  { key: 'exits',         label: 'Exits',         icon: '↘️' },
  { key: 'replay',        label: 'Replay',        icon: '▶️' },
  { key: 'ai_agent',      label: 'AI Agent',      icon: '🤖' },
  { key: 'adaptive',      label: 'Adaptive Intelligence', icon: '🧠' },
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
          <h1 className="tl-page-title">🧪 Trading Lab</h1>
          <div className="tl-page-meta">
            <span className="tl-active-count">{activeSignalCount} aktiva motorer</span>
            <ConfigScopeBadge scope="test" />
            <AdvancedModeToggle value={advancedMode} onChange={setAdvancedMode} />
            <button className="tl-reset-btn" onClick={resetAll} type="button">Återställ</button>
          </div>
        </div>
        <p className="tl-page-sub">
          Experimentera med signalmotorer, parametrar och exitstrategier.
          Påverkar endast tester och analys, inte live-scannerns globala config.
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
          <StrategiesTab toggles={toggles} onChange={(k, v) => setToggle(k, v)} />
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
          <GroupHeader icon="🎯" title="Handelsparametrar" />
          <div className="tl-sliders-grid">
            <Slider
              label="Stop Loss" unit="%" desc="Maximalt tillåtet nedgång från entry"
              value={params.stop_loss} min={0.1} max={5} step={0.1}
              onChange={v => setParam('stop_loss', v)}
            />
            <Slider
              label="Take Profit" desc="Vinstmål i förhållande till risk (R)"
              value={params.take_profit} min={0.5} max={10} step={0.5}
              format={v => `${v}R`}
              onChange={v => setParam('take_profit', v)}
            />
            <Slider
              label="Styrketröskell" desc="Minsta signalstyrka för att tillåtas"
              value={params.confidence_threshold} min={40} max={95} step={1}
              format={v => `${v}/100`}
              onChange={v => setParam('confidence_threshold', v)}
            />
            <Slider
              label="Maximal hålltid" desc="Stäng automatiskt efter denna tid"
              value={params.holding_time} min={1} max={240} step={1}
              format={v => v < 60 ? `${v} min` : `${(v/60).toFixed(1)} h`}
              onChange={v => setParam('holding_time', v)}
            />
            <Slider
              label="Väntetid (cooldown)" desc="Paus mellan trades på samma symbol"
              value={params.cooldown} min={0} max={60} step={1}
              format={v => v === 0 ? 'Ingen' : `${v} min`}
              onChange={v => setParam('cooldown', v)}
            />
            <Slider
              label="Volymfilter" desc="Lägsta relativ volym (1.0 = normal)"
              value={params.volume_filter} min={0.5} max={3} step={0.1}
              format={v => `${v}x`}
              onChange={v => setParam('volume_filter', v)}
            />
            <Slider
              label="Risk per trade" unit="%" desc="Max förlust per trade som andel av kapital"
              value={params.risk_per_trade} min={0.1} max={5} step={0.1}
              onChange={v => setParam('risk_per_trade', v)}
            />
            <Slider
              label="Timeout" desc="Stäng om priset inte rört sig inom denna tid"
              value={params.timeout} min={1} max={240} step={1}
              format={v => v < 60 ? `${v} min` : `${(v/60).toFixed(1)} h`}
              onChange={v => setParam('timeout', v)}
            />
          </div>

          <div className="tl-params-summary">
            <div className="tl-params-summary-title">Aktuell konfiguration</div>
            <div className="tl-params-grid">
              <div className="tl-param-chip"><span>SL</span> {params.stop_loss}%</div>
              <div className="tl-param-chip"><span>TP</span> {params.take_profit}R</div>
              <div className="tl-param-chip"><span>Styrka</span> {params.confidence_threshold}/100</div>
              <div className="tl-param-chip"><span>Hålltid</span> {params.holding_time < 60 ? `${params.holding_time}m` : `${(params.holding_time/60).toFixed(1)}h`}</div>
              <div className="tl-param-chip"><span>Cooldown</span> {params.cooldown === 0 ? 'Ingen' : `${params.cooldown}m`}</div>
              <div className="tl-param-chip"><span>Volym</span> {params.volume_filter}x</div>
              <div className="tl-param-chip"><span>Risk</span> {params.risk_per_trade}%</div>
              <div className="tl-param-chip"><span>Timeout</span> {params.timeout < 60 ? `${params.timeout}m` : `${(params.timeout/60).toFixed(1)}h`}</div>
            </div>
          </div>
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
            Fördefinierade kombinationer av signalmotorer. Aktivera motorer i fliken Signaler för att slå på dem.
          </p>
          <div className="tl-combo-grid">
            {COMBOS.map((combo, i) => (
              <ComboCard key={i} combo={combo} toggles={toggles} />
            ))}
          </div>

          <div className="tl-ai-opt-banner">
            <div className="tl-ai-opt-icon">🤖</div>
            <div>
              <div className="tl-ai-opt-title">AI-optimering — kommer snart</div>
              <div className="tl-ai-opt-sub">
                Optimization Agent kommer analysera bästa kombinationer baserat på historisk data.
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
        <Link to="/signalpuls" className="tl-bottom-link">❤️ Signalpuls</Link>
        <Link to="/resultat"   className="tl-bottom-link">📊 Resultat</Link>
        <Link to="/sakerhet"   className="tl-bottom-link">🛡️ Säkerhet</Link>
      </div>
    </div>
  );
}
