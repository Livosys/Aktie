import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './controlRoom.css';
import { safeString } from '../utils/safeRender.js';

// Shared building blocks for the read-only pipeline pages. Every page consumes
// the single GET /api/supervisor/overview endpoint and renders one slice of it.
// No backend logic, no order/execution code — research/learning display only.

export function apiJson(url) {
  return fetch(url, { credentials: 'same-origin' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// One shared fetch of the overview endpoint.
export function useOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  function reload() {
    setLoading(true);
    apiJson('/api/supervisor/overview')
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { reload(); }, []);
  return { data, error, loading, reload };
}

export const STATUS_LABEL = { ok: 'Fungerar', empty: 'Ingen data än', degraded: 'Delvis', error: 'Fel', unknown: 'Okänt' };

export function StatusDot({ status }) {
  const s = safeString(status, 'unknown');
  return <span className={`cr-dot cr-dot-${s}`} title={STATUS_LABEL[s] || s}>{STATUS_LABEL[s] || s}</span>;
}

export function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('sv-SE');
}

export function SafetyBanner() {
  return (
    <div className="cr-safety">
      🔒 Paper Only · Live Trading Off · Real Orders Blocked · Broker Disabled
      <Link to="/technical" className="cr-safety-tech">Tekniska detaljer →</Link>
    </div>
  );
}

// Standard page scaffold: safety banner, title, plain-language intro, status dot,
// refresh button, error/empty handling. `next` renders a link to the next step.
export function PipelinePage({ icon, title, intro, status, loading, error, onReload, next, children }) {
  return (
    <div className="cr-page">
      <SafetyBanner />
      <header className="cr-header">
        <div>
          <h1>{icon} {title}</h1>
          {intro && <p className="cr-sub">{intro}</p>}
        </div>
        <div className="cr-head-right">
          {status && <StatusDot status={status} />}
          <button className="cr-refresh" onClick={onReload} disabled={loading}>{loading ? 'Laddar…' : '↻ Uppdatera'}</button>
        </div>
      </header>
      {error && <div className="cr-error">Kunde inte hämta översikten: {error}.</div>}
      {children}
      {next && (
        <p className="cr-next-step">
          Nästa steg i pipelinen: <Link to={next.to}>{next.label} →</Link>
        </p>
      )}
    </div>
  );
}

// A simple key/value KPI grid.
export function Kpis({ items }) {
  return (
    <div className="cr-now-grid">
      {items.map((it, i) => (
        <div key={i} className="cr-now">
          <span className="cr-now-lbl">{it.label}</span>
          <span className="cr-now-val">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

export function EmptyNote({ children }) {
  return <p className="cr-soft">{children || 'Ingen data än — kör fler tester.'}</p>;
}
