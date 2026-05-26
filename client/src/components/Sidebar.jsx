import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAlerts } from '../alertContext.jsx';
import { applyTheme, getTheme } from './ThemeToggle.jsx';

const NAV_GROUPS = [
  {
    id: 'main',
    label: null,
    items: [
      { path: '/live',     label: 'Live',     icon: '◉', match: ['/', '/live'], accent: 'blue' },
      { path: '/scanner',  label: 'Scanner',  icon: '◆', accent: 'blue' },
      { path: '/signaler', label: 'Signaler', icon: '▣', accent: 'blue' },
    ],
  },
  {
    id: 'markets',
    label: 'Marknader',
    items: [
      { path: '/aktier', label: 'Aktier', icon: 'A', accent: 'green' },
      { path: '/krypto', label: 'Krypto', icon: '₿', accent: 'green' },
    ],
  },
  {
    id: 'tools',
    label: 'Verktyg',
    items: [
      { path: '/review-chart',  label: 'Diagram',       icon: '⌁', accent: 'orange' },
      { path: '/historik',      label: 'Historik',      icon: 'H',  accent: 'orange', match: ['/historik', '/history'] },
      { path: '/replay',        label: 'Replay',        icon: '▶',  accent: 'orange' },
      { path: '/paper-trading', label: 'Paper Trading', icon: '🧪', accent: 'orange' },
      { path: '/risk-engine',   label: 'Riskmotor',     icon: 'R',  accent: 'orange' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { path: '/alerts',        label: 'Larm',        icon: '!', accent: 'purple' },
      { path: '/machine',       label: 'Intelligens', icon: 'I', accent: 'purple', match: ['/machine', '/intelligence', '/intelligens'] },
      { path: '/system-health', label: 'Hälsa',       icon: '+', accent: 'purple', match: ['/system-health', '/health', '/halsa'] },
    ],
  },
];

const ACCENT_CLASS = {
  blue:   'sb-icon-blue',
  green:  'sb-icon-green',
  orange: 'sb-icon-orange',
  purple: 'sb-icon-purple',
};

function isActive(item, pathname) {
  const matches = item.match || [item.path];
  if (item.path === '/live') return pathname === '/' || pathname === '/live';
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
        <Link to="/live" className="sb-brand" onClick={onClose}>
          <img src="/evin.png" alt="" className="sb-brand-logo" />
          <div className="sb-brand-text">
            <strong>Aktier Livosys</strong>
            <small>Fintech kontrollrum</small>
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
            <span>2M Scanner v2</span>
            <span>Ingen handel utförs</span>
          </div>
        </div>

      </aside>
    </>
  );
}
