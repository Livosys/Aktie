import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

// ── Read-only dashboard shell kit ─────────────────────────────────────────────
// Purely presentational. No data fetching, no POST/PUT/DELETE, no execution.
// Safety flags are displayed but never mutated here.

const TOP_LINKS = [
  { to: '/supervisor', label: 'Supervisor' },
  { to: '/live', label: 'Live Trading' },
  { to: '/paper-trading', label: 'Paper Trading' },
  { to: '/futures-paper', label: 'Futures Paper' },
  { to: '/interactive-brokers', label: 'Interactive Brokers' },
  { to: '/ai', label: 'AI' },
  { to: '/system', label: 'System' },
  { to: '/pinescript', label: 'PineScript' },
  { to: '/lab?tab=batch', label: 'Batch Lab' },
  { to: '/lab?tab=replay', label: 'Replay Lab' },
];

export function DashboardTopNav() {
  const { pathname, search } = useLocation();
  const currentLocation = `${pathname}${search}`;
  return (
    <nav className="dash-topnav" aria-label="Dashboard">
      <div className="dash-topnav-brand">Trading OS</div>
      <div className="dash-topnav-links">
        {TOP_LINKS.map((link) => {
          const active = link.to.includes('?')
            ? currentLocation === link.to
            : pathname === link.to || pathname.startsWith(`${link.to}/`);
          return (
            <Link key={link.to} to={link.to} className={`dash-topnav-link${active ? ' is-active' : ''}`}>
              {link.label}
            </Link>
          );
        })}
      </div>
      <span className="dash-topnav-safety" title="Paper-only research platform">paper-only</span>
    </nav>
  );
}

export function DashboardTabs({ tabs = [], active, onChange }) {
  if (!tabs.length) return null;
  return (
    <div className="dash-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={`dash-tab${active === tab.id ? ' is-active' : ''}`}
          onClick={() => onChange && onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function SafetyBadges({ safety = {} }) {
  const showFlag = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));
  const rows = [
    ['mode', showFlag(safety.mode), safety.mode === 'paper_only'],
    ['live_trading', showFlag(safety.live_trading_enabled), safety.live_trading_enabled === false],
    ['broker', showFlag(safety.broker_enabled), safety.broker_enabled === false],
    ['can_place_orders', showFlag(safety.can_place_orders), safety.can_place_orders === false],
  ];
  return (
    <div className="dash-safety">
      {rows.map(([label, value, ok]) => (
        <span key={label} className={`dash-chip ${ok ? 'is-good' : 'is-danger'}`}>{label}: {value}</span>
      ))}
    </div>
  );
}

export function DashboardShell({ title, subtitle, safety, tabs, activeTab, onTab, kpis, children }) {
  useEffect(() => {
    document.body.dataset.dash = '1';
    return () => { delete document.body.dataset.dash; };
  }, []);

  return (
    <div className="dash-page">
      <DashboardTopNav />
      {(title || subtitle) ? (
        <header className="dash-head">
          <div className="dash-head-copy">
            {title ? <h1>{title}</h1> : null}
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
        </header>
      ) : null}
      {tabs && tabs.length ? <DashboardTabs tabs={tabs} active={activeTab} onChange={onTab} /> : null}
      {kpis && kpis.length ? (
        <div className="dash-kpi-grid">
          {kpis.map((kpi, i) => <Kpi key={kpi.label || i} {...kpi} />)}
        </div>
      ) : null}
      <div className="dash-body">{children}</div>
    </div>
  );
}

export function Kpi({ label, value, hint, tone = 'neutral' }) {
  return (
    <div className={`dash-kpi dash-kpi-${tone}`}>
      <span className="dash-kpi-label">{label}</span>
      <strong className="dash-kpi-value">{value}</strong>
      {hint ? <span className="dash-kpi-hint">{hint}</span> : null}
    </div>
  );
}

export function ChartCard({ title, subtitle, action, tone = 'neutral', children }) {
  return (
    <section className={`dash-card dash-card-${tone}`}>
      <div className="dash-card-head">
        <div>
          {title ? <strong>{title}</strong> : null}
          {subtitle ? <span className="dash-card-sub">{subtitle}</span> : null}
        </div>
        {action || null}
      </div>
      <div className="dash-card-body">{children}</div>
    </section>
  );
}

export function EmptyState({ text = 'Ingen tillräcklig data ännu' }) {
  return <div className="dash-empty">{text}</div>;
}

// ── Hand-rolled SVG charts (no external library) ──────────────────────────────
// Single-hue line, status-colored bars. Marks kept thin; baseline-anchored.

export function LineChart({ points = [], height = 160, stroke = 'var(--blue)', emptyText }) {
  const vals = points.map((p) => Number(p.value)).filter(Number.isFinite);
  if (vals.length < 2) return <EmptyState text={emptyText || 'Ingen tillräcklig data ännu'} />;
  const w = 640;
  const h = height;
  const pad = 8;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (vals.length - 1);
  const toY = (v) => pad + (1 - (v - min) / span) * (h - pad * 2);
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * stepX} ${toY(v)}`).join(' ');
  const areaPath = `${path} L ${pad + (vals.length - 1) * stepX} ${h - pad} L ${pad} ${h - pad} Z`;
  const zeroY = min < 0 && max > 0 ? toY(0) : null;
  return (
    <svg className="dash-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Line chart">
      <path d={areaPath} fill={stroke} opacity="0.08" />
      {zeroY != null ? <line x1={pad} x2={w - pad} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeWidth="1" /> : null}
      <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function BarChart({ bars = [], height = 160, emptyText }) {
  const rows = bars.filter((b) => Number.isFinite(Number(b.value)));
  if (!rows.length) return <EmptyState text={emptyText || 'Ingen tillräcklig data ännu'} />;
  const max = Math.max(...rows.map((b) => Math.abs(Number(b.value))), 1);
  return (
    <div className="dash-bars" style={{ minHeight: height }}>
      {rows.map((b, i) => {
        const pct = Math.round((Math.abs(Number(b.value)) / max) * 100);
        const tone = b.tone || (Number(b.value) < 0 ? 'danger' : 'good');
        return (
          <div key={b.label || i} className="dash-bar-row">
            <span className="dash-bar-label" title={b.label}>{b.label}</span>
            <span className="dash-bar-track">
              <span className={`dash-bar-fill is-${tone}`} style={{ width: `${pct}%` }} />
            </span>
            <span className="dash-bar-value">{b.display ?? b.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ActivityList({ items = [], emptyText }) {
  if (!items.length) return <EmptyState text={emptyText || 'Ingen aktivitet ännu'} />;
  return (
    <div className="dash-activity">
      {items.map((item, i) => (
        <div key={item.id || i} className="dash-activity-row">
          <span className={`dash-dot is-${item.tone || 'neutral'}`} />
          <div className="dash-activity-main">
            <strong>{item.title}</strong>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.time ? <span className="dash-activity-time">{item.time}</span> : null}
        </div>
      ))}
    </div>
  );
}
