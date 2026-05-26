import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { openTradingView } from '../utils/tradingView.js';

const REFRESH_MS = 15_000;

const STATUS_META = {
  active:  { label: 'Kandidat',  cls: 'sc-active'  },
  caution: { label: 'Bevaka',    cls: 'sc-caution'  },
  watch:   { label: 'Bevaka',    cls: 'sc-watch'    },
  wait:    { label: 'Neutral',   cls: 'sc-wait'     },
  avoid:   { label: 'Blockerad', cls: 'sc-avoid'    },
};

const BIAS_META = {
  UP:        { label: '▲ Uppåt',   cls: 'sc-dir-up' },
  DOWN:      { label: '▼ Nedåt',   cls: 'sc-dir-down' },
  NEUTRAL:   { label: '→ Neutral', cls: 'sc-dir-flat' },
  UNCERTAIN: { label: '? Osäker',  cls: 'sc-dir-flat' },
};

const FILTER_OPTIONS = [
  { key: 'all',     label: 'Alla' },
  { key: 'active',  label: 'Kandidater' },
  { key: 'caution', label: 'Obs' },
  { key: 'watch',   label: 'Bevaka' },
  { key: 'avoid',   label: 'Blockerade' },
  { key: 'crypto',  label: 'Krypto' },
  { key: 'stocks',  label: 'Aktier' },
];

function useDecisionData() {
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

function fmtPrice(price, sym) {
  if (price == null) return '–';
  const dec = price > 100 ? 2 : price > 1 ? 3 : 5;
  return `${Number(price).toFixed(dec)}`;
}

function fmtTime(iso) {
  if (!iso) return '–';
  const ago = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (ago < 60) return `${ago} sek`;
  if (ago < 3600) return `${Math.round(ago / 60)} min`;
  return new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function ConfBar({ score }) {
  const pct = Math.min(100, Math.max(0, score || 0));
  const color = pct >= 70 ? 'var(--green)' : pct >= 45 ? 'var(--amber)' : 'var(--muted2)';
  return (
    <div className="sc-conf-bar">
      <div className="sc-conf-bg">
        <div className="sc-conf-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', minWidth: 28 }}>{pct}</span>
    </div>
  );
}

function RiskBadge({ level }) {
  if (!level) return <span style={{ color: 'var(--muted)' }}>–</span>;
  const color = level === 'high' ? 'var(--red)' : level === 'medium' ? 'var(--amber)' : 'var(--green)';
  const label = level === 'high' ? 'Hög' : level === 'medium' ? 'Medel' : 'Låg';
  return <span style={{ color, fontWeight: 700 }}>{label}</span>;
}

function ScannerRow({ c }) {
  const sm = STATUS_META[c.priority] || STATUS_META.wait;
  const bm = BIAS_META[c.nextMoveBias] || BIAS_META.NEUTRAL;

  return (
    <tr>
      <td>
        <div className="sc-sym">{c.symbol}</div>
        <div className="sc-type">{c.market === 'crypto' ? '₿ Krypto' : '📈 Aktie'}</div>
      </td>
      <td>
        <span className="sc-price">{fmtPrice(c.price, c.symbol)}</span>
      </td>
      <td>
        <span className={`sc-status-badge ${sm.cls}`}>{sm.label}</span>
      </td>
      <td><ConfBar score={c.confidenceScore} /></td>
      <td><RiskBadge level={c.fakeoutRiskLevel} /></td>
      <td><span className={bm.cls}>{bm.label}</span></td>
      <td><span className="sc-time">{fmtTime(c.lastUpdate)}</span></td>
      <td>
        <div className="sc-actions">
          <button
            className="btn btn-tv"
            onClick={() => openTradingView(c.symbol, c.market)}
          >
            📈 Graf
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function ScannerPage() {
  const { data, loading, lastFetch, refresh } = useDecisionData();
  const [filter, setFilter] = useState('all');

  const candidates = data?.candidates || [];

  const filtered = useMemo(() => {
    if (filter === 'all')     return candidates;
    if (filter === 'crypto')  return candidates.filter(c => c.market === 'crypto');
    if (filter === 'stocks')  return candidates.filter(c => c.market === 'stocks');
    if (filter === 'active')  return candidates.filter(c => c.priority === 'active');
    if (filter === 'caution') return candidates.filter(c => c.priority === 'caution');
    if (filter === 'watch')   return candidates.filter(c => c.priority === 'watch');
    if (filter === 'avoid')   return candidates.filter(c => c.priority === 'avoid');
    return candidates;
  }, [candidates, filter]);

  return (
    <div className="scanner-page">
      {/* Hero */}
      <div className="scanner-hero">
        <div className="scanner-hero-title">⚡ Scanner</div>
        <div className="scanner-hero-sub">
          Realtidsöversikt över alla bevakade symboler. Uppdateras var 15:e sekund.
          Systemet identifierar kandidater — det ger aldrig handelsorder.
        </div>
      </div>

      {/* Toolbar */}
      <div className="scanner-toolbar">
        {FILTER_OPTIONS.map(f => (
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
          style={{ marginLeft: 4 }}
        >
          {loading ? '...' : '↻'} Uppdatera
        </button>
        <span className="scanner-count">
          {filtered.length} symboler
          {lastFetch && ` · ${lastFetch.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
        </span>
      </div>

      {/* Table */}
      {loading && candidates.length === 0 ? (
        <div className="scanner-empty">
          <span className="spinner" />
          <span>Hämtar scannerdata…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="scanner-empty">
          <strong>Inga symboler i valt filter</strong>
          <span>Inga symboler matchar det valda filtret. Prova ett annat filter.</span>
        </div>
      ) : (
        <div className="scanner-table-wrap">
          <table className="scanner-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Pris</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Risk</th>
                <th>Riktning</th>
                <th>Senast</th>
                <th>Åtgärd</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => <ScannerRow key={c.symbol} c={c} />)}
            </tbody>
          </table>
        </div>
      )}

      {/* Disclaimer */}
      <div className="dm-disclaimer" style={{ fontSize: 11, color: 'var(--muted)', padding: '8px 0' }}>
        Status: Kandidat = titta manuellt, Bevaka = inte klar ännu, Neutral = inget läge, Blockerad = jaga inte.
        Systemet handlar aldrig automatiskt.
      </div>
    </div>
  );
}
