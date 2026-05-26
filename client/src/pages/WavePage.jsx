import React, { useState, useEffect, useCallback } from 'react';
import { tvLink, cryptoTvLink, fmtTime, fmt } from '../shared.jsx';

const REFRESH_MS = 15_000;

const PHASE_CONFIG = {
  COMPRESSION: {
    icon: '🌱',
    label: 'Sammandragning',
    labelSv: 'Sammandragning',
    cls: 'wave-compression',
    badgeCls: 'badge-yellow',
    hint: 'Priset samlar energi. Vänta på utbrott med volym och större rörelse.',
  },
  IMPULSE_START: {
    icon: '🚀',
    label: 'Rörelsen startar',
    labelSv: 'Rörelsen startar',
    cls: 'wave-impulse-start',
    badgeCls: 'badge-green',
    hint: 'Utbrott har börjat. Volym stödjer rörelsen. Vänta på tillbakagång för bättre läge.',
  },
  IMPULSE_CONTINUATION: {
    icon: '🌊',
    label: 'Fortsättning',
    labelSv: 'Fortsättning',
    cls: 'wave-continuation',
    badgeCls: 'badge-blue',
    hint: 'Trenden fortsätter. Läget kan vara sent, så vänta på tillbakagång eller ny bekräftelse.',
  },
  PULLBACK_CORRECTION: {
    icon: '↩️',
    label: 'Tillbakagång',
    labelSv: 'Tillbakagång',
    cls: 'wave-pullback',
    badgeCls: 'badge-orange',
    hint: 'Tillbakagång mot SMA20. Trenden är kvar och läget kan vara värt att bevaka.',
  },
  EXHAUSTION_RISK: {
    icon: '⚠️',
    label: 'Trött rörelse',
    labelSv: 'Trött rörelse',
    cls: 'wave-exhaustion',
    badgeCls: 'badge-red',
    hint: 'Rörelsen är stark men börjar bli utsträckt. Var försiktig med sena lägen.',
  },
  CHOPPY_UNKNOWN: {
    icon: '❓',
    label: 'Stökigt',
    labelSv: 'Oklar / Sidledes',
    cls: 'wave-choppy',
    badgeCls: 'badge-gray',
    hint: 'Ingen tydlig fas. Vänta på klarhet innan du agerar.',
  },
};

const PHASE_ORDER = [
  'IMPULSE_CONTINUATION',
  'IMPULSE_START',
  'PULLBACK_CORRECTION',
  'COMPRESSION',
  'EXHAUSTION_RISK',
  'CHOPPY_UNKNOWN',
];

function useWaveScan() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/wave');
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchData]);

  return { data, loading, error, lastFetch, refresh: fetchData };
}

function isCryptoSymbol(symbol) {
  return /USDT$/i.test(symbol) || /^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA)/.test(symbol);
}

function buildTvLink(symbol) {
  return isCryptoSymbol(symbol) ? cryptoTvLink(symbol) : tvLink(symbol);
}

function directionLabel(dir) {
  if (dir === 'bullish') return { label: '▲ Uppåt', cls: 'wave-dir-up' };
  if (dir === 'bearish') return { label: '▼ Nedåt', cls: 'wave-dir-down' };
  return { label: '— Sidledes', cls: 'wave-dir-neutral' };
}

function waveNumLabel(n) {
  if (n === null || n === undefined) return null;
  const labels = { 1: 'Wave 1', 2: 'Wave 2', 3: 'Wave 3', 4: 'Wave 4', 5: 'Wave 5' };
  return labels[n] || null;
}

function ConfidenceBar({ value }) {
  const pct = Math.max(0, Math.min(100, value));
  let color = '#57637e';
  if (pct >= 70) color = 'var(--green)';
  else if (pct >= 45) color = 'var(--blue)';
  else if (pct >= 25) color = 'var(--yellow)';
  return (
    <div className="wave-conf-bar">
      <div className="wave-conf-track">
        <div className="wave-conf-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="wave-conf-num" style={{ color }}>{pct}%</span>
    </div>
  );
}

function RiskDot({ level, label }) {
  const cls = level === 'high' ? 'wave-risk-high' : level === 'medium' ? 'wave-risk-med' : 'wave-risk-low';
  return <span className={`wave-risk-dot ${cls}`}>{label}: {level === 'high' ? 'Hög' : level === 'medium' ? 'Medium' : 'Låg'}</span>;
}

function WaveCard({ result }) {
  const [expanded, setExpanded] = useState(false);
  const { symbol, price, waveContext } = result;
  if (!waveContext) return null;

  const {
    phase, direction, confidence, probableWave,
    exhaustionRisk, pullbackRisk, summarySv, reasonsSv, metrics,
  } = waveContext;

  const cfg = PHASE_CONFIG[phase] || PHASE_CONFIG.CHOPPY_UNKNOWN;
  const dir = directionLabel(direction);
  const waveNum = waveNumLabel(probableWave);

  return (
    <div className={`wave-card ${cfg.cls}`}>
      <div className="wave-card-header">
        <div className="wave-card-top">
          <span className="wave-card-symbol">{symbol}</span>
          {price != null && (
            <span className="wave-card-price">${Number(price).toLocaleString('en-US', { maximumFractionDigits: price < 10 ? 4 : 2 })}</span>
          )}
        </div>
        <div className="wave-card-badges">
          <span className={`badge ${cfg.badgeCls}`}>{cfg.icon} {cfg.labelSv}</span>
          {waveNum && <span className="badge badge-gray wave-num-badge">{waveNum}</span>}
          <span className={`wave-dir ${dir.cls}`}>{dir.label}</span>
        </div>
      </div>

      <ConfidenceBar value={confidence} />

      <p className="wave-summary">{summarySv}</p>

      <div className="wave-risks">
        <RiskDot level={exhaustionRisk} label="Exhaustion" />
        <RiskDot level={pullbackRisk} label="Pullback-risk" />
      </div>

      <div className="wave-card-footer">
        <button className="wave-expand-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? '▲ Dölj detaljer' : '▼ Visa detaljer'}
        </button>
        <a href={buildTvLink(symbol)} target="_blank" rel="noopener noreferrer" className="btn btn-tv wave-tv-btn">
          TV
        </a>
      </div>

      {expanded && (
        <div className="wave-details">
          <div className="wave-metrics">
            <MetricChip label="Trend slope" value={metrics.trendSlope !== null ? `${metrics.trendSlope > 0 ? '+' : ''}${metrics.trendSlope}%` : '–'} quality={metrics.trendSlope !== null ? (Math.abs(metrics.trendSlope) > 0.15 ? 'good' : Math.abs(metrics.trendSlope) > 0.05 ? 'warn' : 'neutral') : 'neutral'} />
            <MetricChip label="Dist SMA20" value={metrics.distanceFromSma20 !== null ? `${metrics.distanceFromSma20 > 0 ? '+' : ''}${metrics.distanceFromSma20}x` : '–'} quality={metrics.distanceFromSma20 !== null ? (Math.abs(metrics.distanceFromSma20) > 3 ? 'bad' : Math.abs(metrics.distanceFromSma20) > 1.5 ? 'warn' : 'good') : 'neutral'} />
            <MetricChip label="RSI" value={metrics.rsiState} quality={metrics.rsiState === 'overbought' || metrics.rsiState === 'oversold' ? 'bad' : metrics.rsiState === 'bullish' || metrics.rsiState === 'bearish' ? 'warn' : 'neutral'} />
            <MetricChip label="Impuls" value={metrics.impulseStrength !== null ? `${metrics.impulseStrength}x` : '–'} quality={metrics.impulseStrength !== null ? (metrics.impulseStrength > 1.0 ? 'good' : metrics.impulseStrength > 0.5 ? 'warn' : 'neutral') : 'neutral'} />
            <MetricChip label="ATR exp." value={metrics.atrExpansion !== null ? `${Math.round(metrics.atrExpansion)}%` : '–'} quality={metrics.atrExpansion !== null ? (metrics.atrExpansion < 60 ? 'warn' : metrics.atrExpansion > 120 ? 'good' : 'neutral') : 'neutral'} />
            <MetricChip label="Volym rel." value={metrics.volumeSupport !== null ? `${metrics.volumeSupport}x` : '–'} quality={metrics.volumeSupport !== null ? (metrics.volumeSupport > 1.5 ? 'good' : metrics.volumeSupport > 0.8 ? 'neutral' : 'bad') : 'neutral'} />
          </div>

          {reasonsSv && reasonsSv.length > 0 && (
            <div className="why-box wave-why">
              <div className="why-box-title">Analys</div>
              <ul className="why-list">
                {reasonsSv.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricChip({ label, value, quality }) {
  const qualityCls = quality === 'good' ? 'chip-good' : quality === 'bad' ? 'chip-bad' : quality === 'warn' ? 'chip-warn' : '';
  return (
    <div className={`health-chip ${qualityCls}`}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
    </div>
  );
}

function PhaseSection({ phase, results }) {
  const cfg = PHASE_CONFIG[phase] || PHASE_CONFIG.CHOPPY_UNKNOWN;
  if (results.length === 0) return null;

  return (
    <div className="wave-section">
      <div className="wave-section-header">
        <span className="wave-section-icon">{cfg.icon}</span>
        <div>
          <span className="wave-section-title">{cfg.labelSv}</span>
          <span className="wave-section-count"> · {results.length}</span>
        </div>
      </div>
      <p className="wave-section-hint">{cfg.hint}</p>
      <div className="wave-grid">
        {results.map((r) => <WaveCard key={r.symbol} result={r} />)}
      </div>
    </div>
  );
}

export default function WavePage() {
  const { data, loading, error, lastFetch, refresh } = useWaveScan();

  const results = data?.results || [];

  const byPhase = {};
  for (const phase of PHASE_ORDER) byPhase[phase] = [];
  for (const r of results) {
    const phase = r.waveContext?.phase || 'CHOPPY_UNKNOWN';
    if (!byPhase[phase]) byPhase[phase] = [];
    byPhase[phase].push(r);
  }

  const totalActive = results.filter((r) =>
    ['IMPULSE_CONTINUATION', 'IMPULSE_START', 'PULLBACK_CORRECTION'].includes(r.waveContext?.phase)
  ).length;

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <h1 className="hero-title">
            <span className="wave-accent">🌊</span> Wave Phase
          </h1>
          <p className="hero-sub">
            Vi läser vilken fas marknaden befinner sig i: <strong>kompression</strong>, <strong>impuls</strong>, <strong>pullback</strong> eller <strong>exhaustion</strong>.
            {lastFetch && <span> · Uppdaterad {fmtTime(lastFetch.toISOString())}</span>}
          </p>
        </div>
        <div className="wave-hero-right">
          <button className="btn wave-refresh-btn" onClick={refresh} disabled={loading}>
            {loading ? 'Laddar…' : '↻ Uppdatera'}
          </button>
          {totalActive > 0 && (
            <span className="wave-active-badge">{totalActive} aktiv{totalActive === 1 ? '' : 'a'} faser</span>
          )}
        </div>
      </div>

      {error && (
        <div className="wave-error">
          Kunde inte hämta Wave-data: {error}
        </div>
      )}

      {loading && results.length === 0 && (
        <div className="wave-loading">Analyserar wave phases…</div>
      )}

      {!loading && results.length === 0 && !error && (
        <div className="wave-empty">Ingen wave-data tillgänglig ännu. Vänta på nästa scan-cykel.</div>
      )}

      {PHASE_ORDER.map((phase) => (
        <PhaseSection key={phase} phase={phase} results={byPhase[phase] || []} />
      ))}
    </div>
  );
}
