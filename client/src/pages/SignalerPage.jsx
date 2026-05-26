import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { openTradingView } from '../utils/tradingView.js';

const REFRESH_MS = 15_000;

const DECISION_SV = {
  active:  'Titta manuellt',
  caution: 'Bekräftelse saknas',
  watch:   'Setup nära',
  wait:    'Vänta',
  avoid:   'Jaga inte',
};

const BIAS_SV = {
  UP:        { text: '▲ Uppåt',   cls: 'bias-up' },
  DOWN:      { text: '▼ Nedåt',   cls: 'bias-down' },
  NEUTRAL:   { text: '→ Neutral', cls: 'bias-neutral' },
  UNCERTAIN: { text: '? Osäker',  cls: 'bias-uncertain' },
};

const TF_LABELS = ['1h', '30m', '15m', '10m', '5m', '2m'];
const TF_KEYS   = ['tf1h', 'tf30m', 'tf15m', 'tf10m', 'tf5m', 'tf2m'];

function TfMini({ timeframes }) {
  if (!timeframes) return null;
  return (
    <div className="sig-tf-row">
      {TF_KEYS.map((k, i) => {
        const dir = timeframes[k] || 'neutral';
        return (
          <span
            key={k}
            className={`new-tf-cell tf-${dir} ${k === 'tf2m' ? 'tf-decision-point' : ''}`}
            title={`${TF_LABELS[i]}: ${dir}`}
          >
            {TF_LABELS[i]}
            <span className="tf-dir">{dir === 'bullish' ? '↑' : dir === 'bearish' ? '↓' : '→'}</span>
          </span>
        );
      })}
    </div>
  );
}

function RiskLabel({ level }) {
  if (!level) return <span style={{ color: 'var(--muted)' }}>–</span>;
  const color = level === 'high' ? 'var(--red)' : level === 'medium' ? 'var(--amber)' : 'var(--green)';
  const label = level === 'high' ? 'Hög' : level === 'medium' ? 'Medel' : 'Låg';
  return <span style={{ color, fontWeight: 700, fontFamily: 'var(--mono)' }}>{label}</span>;
}

function SignalCard({ c }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const decisionText = DECISION_SV[c.priority] || 'Vänta';
  const bias = BIAS_SV[c.nextMoveBias] || BIAS_SV.UNCERTAIN;

  const cardCls = c.priority === 'active' ? 'sig-active'
    : c.priority === 'caution' ? 'sig-caution'
    : 'sig-watch';

  const fmtPrice = (p) => {
    if (p == null) return '–';
    const dec = p > 100 ? 2 : p > 1 ? 3 : 5;
    return Number(p).toFixed(dec);
  };

  return (
    <div className={`sig-card ${cardCls}`}>
      {/* Header */}
      <div className="sig-card-head">
        <div>
          <div className="sig-sym">{c.symbol}</div>
          <div className="sig-type">{c.market === 'crypto' ? '₿ Krypto' : '📈 Aktie'}</div>
        </div>
        <div className="sig-card-right">
          {c.price != null && <span className="sig-price">{fmtPrice(c.price)}</span>}
          <span className={`cand-decision-text decision-${c.priority}`}>{decisionText}</span>
        </div>
      </div>

      {/* Bias */}
      <div className="cand-status-row">
        <span className={`cand-bias ${bias.cls}`}>
          {bias.text} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>nästa 2-5 min</span>
        </span>
      </div>

      {/* Stats grid */}
      <div className="sig-stats-grid">
        <div className="sig-stat">
          <span className="sig-stat-label">Confidence</span>
          <span className="sig-stat-val">{c.confidenceScore}</span>
        </div>
        <div className="sig-stat">
          <span className="sig-stat-label">Fakeout-risk</span>
          <span className="sig-stat-val"><RiskLabel level={c.fakeoutRiskLevel} /></span>
        </div>
        <div className="sig-stat">
          <span className="sig-stat-label">TF-stöd</span>
          <span className="sig-stat-val">{c.agreementCount}/6</span>
        </div>
      </div>

      {/* Timeframe row */}
      <TfMini timeframes={c.timeframes} />

      {/* Decision text */}
      <div className="sig-decision-text">{c.decisionTextSv}</div>

      {/* Blockers */}
      {(c.hardBlockers?.length > 0 || c.softBlockers?.length > 0) && (
        <div className="sig-blockers">
          {c.hardBlockers?.map(b => <span key={b} className="blocker-hard">{b}</span>)}
          {c.softBlockers?.map(b => <span key={b} className="blocker-soft">{b}</span>)}
        </div>
      )}

      {/* Details */}
      {detailsOpen && (
        <div className="sig-details">
          <div className="sig-detail-row">
            <span>Tillstånd</span>
            <strong>{c.stateGraph?.state || '–'}</strong>
          </div>
          {c.stateGraph?.explanationSv && (
            <div className="sig-detail-row">
              <span>Förklaring</span>
              <strong>{c.stateGraph.explanationSv}</strong>
            </div>
          )}
          {c.preMoveContext?.compressionStrength > 0 && (
            <div className="sig-detail-row">
              <span>Komprimering</span>
              <strong>{Math.round(c.preMoveContext.compressionStrength)}%</strong>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="sig-actions">
        <button
          className="btn btn-tv"
          onClick={() => openTradingView(c.symbol, c.market)}
        >
          📈 Öppna graf
        </button>
        <button
          className="btn"
          onClick={() => setDetailsOpen(o => !o)}
        >
          {detailsOpen ? 'Dölj detaljer' : 'Tekniska detaljer'}
        </button>
      </div>
    </div>
  );
}

function useSignalData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/live/decision-monitor');
      if (res.ok) {
        const json = await res.json();
        if (json.ok) {
          setData(json);
          setLastFetch(new Date());
        }
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return { data, loading, lastFetch, refresh: load };
}

const FILTER_OPTS = [
  { key: 'signals',  label: 'Alla signaler' },
  { key: 'active',   label: 'Titta manuellt' },
  { key: 'caution',  label: 'Bekräftelse saknas' },
  { key: 'watch',    label: 'Setup nära' },
  { key: 'crypto',   label: 'Krypto' },
  { key: 'stocks',   label: 'Aktier' },
];

export default function SignalerPage() {
  const { data, loading, lastFetch, refresh } = useSignalData();
  const [filter, setFilter] = useState('signals');

  const candidates = data?.candidates || [];

  const filtered = useMemo(() => {
    let base = candidates.filter(c =>
      c.priority === 'active' || c.priority === 'caution' || c.priority === 'watch'
    );
    if (filter === 'active')  return base.filter(c => c.priority === 'active');
    if (filter === 'caution') return base.filter(c => c.priority === 'caution');
    if (filter === 'watch')   return base.filter(c => c.priority === 'watch');
    if (filter === 'crypto')  return base.filter(c => c.market === 'crypto');
    if (filter === 'stocks')  return base.filter(c => c.market === 'stocks');
    return base;
  }, [candidates, filter]);

  const summary = data?.summary;

  return (
    <div className="signaler-page">
      {/* Hero */}
      <div className="sig-hero">
        <div className="sig-hero-title">📊 Signaler</div>
        <div className="sig-hero-sub">
          Systemets aktuella kandidater — sorterade efter prioritet.
        </div>
        <div className="sig-disclaimer">
          Systemet ger aldrig handelsorder. "Titta manuellt" = systemet ser ett intressant läge — du gör din egen bedömning.
        </div>
      </div>

      {/* Summary chips */}
      {summary && (
        <div className="live-sys-row">
          {summary.active > 0  && <span className="sys-chip chip-ok">{summary.active} Titta manuellt</span>}
          {summary.caution > 0 && <span className="sys-chip chip-warn">{summary.caution} Bekräftelse saknas</span>}
          {summary.watch > 0   && <span className="sys-chip chip-info">{summary.watch} Setup nära</span>}
          {summary.wait > 0    && <span className="sys-chip">{summary.wait} Vänta</span>}
          {summary.avoid > 0   && <span className="sys-chip chip-err">{summary.avoid} Jaga inte</span>}
        </div>
      )}

      {/* Toolbar */}
      <div className="sig-toolbar">
        {FILTER_OPTS.map(f => (
          <button
            key={f.key}
            className={`scanner-filter-btn ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <button
          className="scanner-filter-btn"
          onClick={refresh}
        >
          {loading ? '...' : '↻'} Uppdatera
        </button>
        <span className="sig-count">
          {filtered.length} signaler
          {lastFetch && ` · ${lastFetch.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
        </span>
      </div>

      {/* Signal cards */}
      {loading && candidates.length === 0 ? (
        <div className="sig-empty">
          <span className="spinner" style={{ width: 16, height: 16 }} />
          <span>Hämtar signaler…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="sig-empty">
          <div style={{ fontSize: '2rem' }}>⏳</div>
          <strong>Inga signaler just nu</strong>
          <span>
            Systemet hittar inga aktiva kandidater. Marknaden kan vara lugn, stängd, eller
            systemet väntar på bättre bekräftelse.
          </span>
        </div>
      ) : (
        <div className="sig-grid">
          {filtered.map(c => <SignalCard key={c.symbol} c={c} />)}
        </div>
      )}
    </div>
  );
}
