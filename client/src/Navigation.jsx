import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAlerts } from './alertContext.jsx';

// All original pages live in the Advanced dropdown — routes unchanged
const ADVANCED_ITEMS = [
  { path: '/aktier',          label: 'Aktier',       icon: '📈' },
  { path: '/nasdaq',          label: 'Nasdaq',       icon: '⚡' },
  { path: '/krypto',          label: 'Krypto',       icon: '₿'  },
  { path: '/historik',        label: 'Historik',     icon: '📚' },
  { path: '/replay',          label: 'Testa historik', icon: '▶️' },
  { path: '/machine',         label: 'Motor',          icon: '🤖' },
  { path: '/missed-breakouts',label: 'Missade rörelser', icon: '🎯' },
  { path: '/micro-move',       label: 'Micro Moves',     icon: '⚡' },
  { path: '/wave',            label: 'Vågor',          icon: '🌊' },
  { path: '/review-chart',    label: 'Granska graf',   icon: '🔍' },
  { path: '/quality',         label: 'Signalkvalitet', icon: '📊' },
  { path: '/paper-trading',  label: 'Paper Trading',  icon: '🧪' },
  { path: '/risk-engine',     label: 'Riskmotor',      icon: '🛡️' },
  { path: '/exit-engine',     label: 'Exitmotor',      icon: '↘️' },
];

// Paths that belong to Advanced (for active-state detection)
const ADVANCED_PATHS = ADVANCED_ITEMS.map(i => i.path);

function AdvancedDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { pathname } = useLocation();

  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  // Close when navigating
  useEffect(() => { setOpen(false); }, [pathname]);

  const isActive = ADVANCED_PATHS.some(p => pathname.startsWith(p));

  return (
    <div className="nav-adv-wrap" ref={ref}>
      <button
        className={`nav-link nav-adv-btn${isActive ? ' active' : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        <span>⚙️</span>
        <span>Avancerat</span>
        <span className="nav-adv-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="nav-adv-dropdown">
          {ADVANCED_ITEMS.map(item => (
            <Link
              key={item.path}
              to={item.path}
              className={`nav-adv-item${pathname.startsWith(item.path) ? ' active' : ''}`}
            >
              <span className="nav-adv-icon">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AlertsLink() {
  const { enabled, heroToasts } = useAlerts();
  const { pathname } = useLocation();
  const isActive = pathname.startsWith('/alerts');
  const hasPending = (heroToasts?.length ?? 0) > 0;

  return (
    <Link to="/alerts" className={`nav-link nav-alerts-link${isActive ? ' active' : ''}`}>
      <span>🔔</span>
      <span>Larm</span>
      {hasPending && <span className="nav-badge" />}
      {enabled && <span className="nav-live-dot" title="Larm aktivt" />}
    </Link>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');
  const isLight = theme === 'light';

  function toggleTheme() {
    const next = isLight ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={isLight ? 'Byt till mörkt läge' : 'Byt till ljust läge'}
      title={isLight ? 'Byt till mörkt läge' : 'Byt till ljust läge'}
    >
      <span>{isLight ? '☀️' : '🌙'}</span>
      <span>{isLight ? 'Ljust' : 'Mörkt'}</span>
    </button>
  );
}

export default function Navigation() {
  const { pathname } = useLocation();

  const isLive   = pathname === '/' || pathname === '/live';
  const isIntel  = pathname.startsWith('/intelligence') || pathname.startsWith('/machine');
  const isHealth = pathname.startsWith('/health') || pathname.startsWith('/system-health');
  const isPaper  = pathname.startsWith('/paper-trading');
  const isRisk   = pathname.startsWith('/risk-engine');
  const isExit   = pathname.startsWith('/exit-engine');

  return (
    <nav className="nav">
      <Link to="/live" className="nav-brand">
        <img src="/evin.png" alt="Aktier Livosys" className="app-logo" />
        <span className="nav-brand-text">Aktier Livosys</span>
      </Link>

      <div className="nav-links nav-links-desktop">
        <Link to="/live"         className={`nav-link nav-live${isLive ? ' active' : ''}`}>
          <span>📈</span><span>Live</span>
        </Link>
        <Link to="/intelligence" className={`nav-link nav-intel${isIntel ? ' active' : ''}`}>
          <span>🧠</span><span>Intelligens</span>
        </Link>
        <Link to="/health"       className={`nav-link nav-health-lnk${isHealth ? ' active' : ''}`}>
          <span>🩺</span><span>Hälsa</span>
        </Link>
        <Link to="/paper-trading" className={`nav-link${isPaper ? ' active' : ''}`}>
          <span>🧪</span><span>Paper Trading</span>
        </Link>
        <Link to="/risk-engine" className={`nav-link${isRisk ? ' active' : ''}`}>
          <span>🛡️</span><span>Riskmotor</span>
        </Link>
        <Link to="/exit-engine" className={`nav-link${isExit ? ' active' : ''}`}>
          <span>↘️</span><span>Exitmotor</span>
        </Link>
        <AlertsLink />
        <AdvancedDropdown />
        <ThemeToggle />
      </div>

      {/* Mobile: theme toggle only (nav handled by bottom nav) */}
      <div className="nav-links-mobile">
        <ThemeToggle />
      </div>
    </nav>
  );
}
