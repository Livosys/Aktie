import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAlerts } from '../alertContext.jsx';
import { applyTheme, getTheme } from './ThemeToggle.jsx';

const NAV_GROUPS = [
  {
    id: 'main',
    label: null,
    items: [
      { path: '/supervisor', label: 'Trading OS', icon: '🧭', match: ['/supervisor', '/oversikt'], accent: 'blue' },
      { path: '/live',       label: 'LIVE',       icon: '♥', match: ['/', '/live', '/signalpuls', '/scanner', '/signaler', '/aktier', '/krypto', '/nasdaq'], accent: 'blue' },
      { path: '/lab',        label: 'LAB',        icon: 'L', match: ['/lab', '/trading-lab', '/strategy-lab', '/replay', '/review-chart', '/intelligence', '/machine'], accent: 'orange' },
      { path: '/insikter',   label: 'INSIKTER',   icon: 'I', match: ['/insikter', '/resultat', '/setup-performance', '/historik', '/paper-trading'], accent: 'green' },
      { path: '/system',     label: 'SYSTEM',     icon: 'S', match: ['/system', '/system-health', '/alerts', '/sakerhet', '/risk', '/risk-engine', '/safety', '/execution-safety'], accent: 'purple' },
    ],
  },
];

const ACCENT_CLASS = {
  blue:   'sb-icon-blue',
  green:  'sb-icon-green',
  orange: 'sb-icon-orange',
  purple: 'sb-icon-purple',
  teal:   'sb-icon-teal',
};

function isActive(item, pathname) {
  const matches = (item.match || [item.path]).map((p) => p.split('?')[0]);
  if (item.path === '/live') return pathname === '/' || pathname === '/signalpuls' || pathname === '/live';
  return matches.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function NavItem({ item, onClose }) {
  const { pathname } = useLocation();
  const { heroToasts } = useAlerts();
  const active = isActive(item, pathname);
  const hasAlerts = item.path === '/alerts' && (heroToasts?.length ?? 0) > 0;
  const iconCls = active ? `sb-icon ${ACCENT_CLASS[item.accent] || 'sb-icon-blue'} sb-icon-active` : `sb-icon ${ACCENT_CLASS[item.accent] || 'sb-icon-blue'}`;

  return (
    <Link
      to={item.path}
      className={`sb-link${active ? ' sb-link-active' : ''}`}
      onClick={onClose}
    >
      <span className={iconCls}>{item.icon}</span>
      <span className="sb-link-label">{item.label}</span>
      {hasAlerts && <span className="sb-alert-pip" />}
      {active && <span className="sb-active-bar" />}
    </Link>
  );
}

function ThemeToggle() {
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    function handler(e) { setThemeState(e.detail); }
    window.addEventListener('themechange', handler);
    return () => window.removeEventListener('themechange', handler);
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setThemeState(next);
  }

  const isDark = theme === 'dark';
  return (
    <button className="sb-theme-toggle" onClick={toggle} type="button">
      <span className="sb-theme-track">
        <span className={`sb-theme-thumb ${isDark ? 'thumb-dark' : 'thumb-light'}`} />
      </span>
      <span className="sb-theme-label">{isDark ? '☾ Mörkt läge' : '☀ Ljust läge'}</span>
    </button>
  );
}

export default function Sidebar({ open, onClose }) {
  return (
    <>
      {open && (
        <button
          className="premium-sidebar-backdrop"
          aria-label="Stäng meny"
          onClick={onClose}
        />
      )}
      <aside className={`premium-sidebar${open ? ' is-open' : ''}`}>

        {/* Brand */}
        <Link to="/supervisor" className="sb-brand" onClick={onClose}>
          <img src="/evin.png" alt="" className="sb-brand-logo" />
          <div className="sb-brand-text">
            <strong>Trading OS</strong>
            <small>Kör bilen · Översikt · Test</small>
          </div>
        </Link>

        {/* Nav */}
        <nav className="sb-nav" aria-label="Huvudnavigation">
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="sb-group">
              {group.label && (
                <div className="sb-group-header">
                  <span className="sb-group-line" />
                  <span className="sb-group-label">{group.label}</span>
                  <span className="sb-group-line" />
                </div>
              )}
              <div className="sb-group-items">
                {group.items.map((item) => (
                  <NavItem key={item.path} item={item} onClose={onClose} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="sb-footer">
          <ThemeToggle />
          <div className="sb-footer-meta">
            <span>Trading OS</span>
            <span>Ingen handel utförs</span>
          </div>
        </div>

      </aside>
    </>
  );
}
