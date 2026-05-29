import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

const SYSTEM_ITEMS = [
  { path: '/system',            label: 'System Center', icon: '⚙️' },
  { path: '/system?tab=health', label: 'Hälsa',         icon: '🩺' },
  { path: '/system?tab=providers', label: 'Providers',  icon: '🔌' },
  { path: '/system?tab=logs',   label: 'Loggar',        icon: '🔔' },
  { path: '/system?tab=safety', label: 'Safety',        icon: '🛡️' },
];

const SYSTEM_PATHS = SYSTEM_ITEMS.map(i => i.path);

function SystemDropdown() {
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

  useEffect(() => { setOpen(false); }, [pathname]);

  const isActive = SYSTEM_PATHS.some(p => pathname.startsWith(p));

  return (
    <div className="nav-adv-wrap" ref={ref}>
      <button
        className={`nav-link nav-adv-btn${isActive ? ' active' : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        <span>⚙️</span>
        <span>System</span>
        <span className="nav-adv-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="nav-adv-dropdown">
          {SYSTEM_ITEMS.map(item => (
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

  const isPuls       = pathname === '/' || pathname.startsWith('/live') || pathname.startsWith('/signalpuls');
  const isDaytrading = pathname.startsWith('/daytrading');
  const isLab        = pathname.startsWith('/lab') || pathname.startsWith('/trading-lab');
  const isResultat   = pathname.startsWith('/insikter') || pathname.startsWith('/resultat');
  const isSystem     = pathname.startsWith('/system');

  return (
    <nav className="nav">
      <Link to="/live" className="nav-brand">
        <img src="/evin.png" alt="Aktier Livosys" className="app-logo" />
        <span className="nav-brand-text">Trading OS v2</span>
      </Link>

      <div className="nav-links nav-links-desktop">
        <Link to="/live"       className={`nav-link nav-live${isPuls ? ' active' : ''}`}>
          <span>❤️</span><span>LIVE</span>
        </Link>
        <Link to="/daytrading" className={`nav-link${isDaytrading ? ' active' : ''}`}>
          <span>📡</span><span>DAYTRADING</span>
        </Link>
        <Link to="/lab"        className={`nav-link${isLab ? ' active' : ''}`}>
          <span>🧪</span><span>LAB</span>
        </Link>
        <Link to="/insikter"   className={`nav-link${isResultat ? ' active' : ''}`}>
          <span>📊</span><span>INSIKTER</span>
        </Link>
        <Link to="/system"     className={`nav-link${isSystem ? ' active' : ''}`}>
          <span>🛡️</span><span>SYSTEM</span>
        </Link>
        <ThemeToggle />
      </div>

      {/* Mobile: theme toggle only (nav handled by bottom nav) */}
      <div className="nav-links-mobile">
        <ThemeToggle />
      </div>
    </nav>
  );
}
