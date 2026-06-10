import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAlerts } from '../alertContext.jsx';
import { getTheme } from './ThemeToggle.jsx';

// Trading OS pipeline navigation. The product is the Learning Engine:
// Data → Replay → Batch → Learning → AI Analyst → Paper Trading.
// Signals / Live is intentionally kept unchanged. Legacy paths stay in `match`
// so old links still highlight the right item while redirects resolve them.
const NAV_GROUPS = [
      {
        id: 'main',
        label: null,
        items: [
          { path: '/',      label: 'Control Room',    icon: '🧭', match: ['/', '/control-room', '/supervisor', '/overview', '/oversikt'], accent: 'blue' },
          { path: '/live',  label: 'Signaler / Live', icon: '♥',  match: ['/live', '/signalpuls', '/scanner', '/signaler', '/aktier', '/krypto', '/nasdaq'], accent: 'blue' },
        ],
      },
      {
        id: 'pipeline',
        label: 'Pipeline',
        items: [
          { path: '/data',          label: 'Data',          icon: '🗄️', match: ['/data', '/data-center', '/datacenter'], accent: 'teal' },
          { path: '/replay',        label: 'Replay',        icon: '⏪', match: ['/replay'], accent: 'blue' },
          { path: '/batch',         label: 'Batch',         icon: '🧮', match: ['/batch'], accent: 'orange' },
          { path: '/strategies',    label: 'Strategier',    icon: '🎯', match: ['/strategies', '/strategy-lab', '/strategilabb'], accent: 'orange' },
          { path: '/learning',      label: 'Learning',      icon: '🧠', match: ['/learning', '/narrow', '/narrow-state'], accent: 'purple' },
          { path: '/ai-analyst',    label: 'AI Analyst',    icon: '🤖', match: ['/ai-analyst', '/intelligence', '/intelligens'], accent: 'green' },
          { path: '/paper-trading', label: 'Paper Trading', icon: '📝', match: ['/paper-trading'], accent: 'green' },
        ],
      },
      {
        id: 'system',
        label: 'System',
        items: [
          { path: '/technical', label: 'Technical', icon: '🔧', match: ['/technical', '/system', '/system-health', '/alerts', '/sakerhet', '/risk', '/risk-engine', '/safety', '/execution-safety'], accent: 'purple' },
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
  // Root must match exactly — otherwise startsWith('/') would flag every route.
  return matches.some((p) => (p === '/' ? pathname === '/' : (pathname === p || pathname.startsWith(`${p}/`))));
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

function ThemeStatus() {
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    function handler(e) { setThemeState(e.detail); }
    window.addEventListener('themechange', handler);
    return () => window.removeEventListener('themechange', handler);
  }, []);

  const isDark = theme === 'dark';
  return (
    <div className="sb-theme-status" aria-label="Temastatus">
      <span className="sb-theme-track">
        <span className={`sb-theme-thumb ${isDark ? 'thumb-dark' : 'thumb-light'}`} />
      </span>
      <span className="sb-theme-label">Tema: {isDark ? 'Mörkt läge' : 'Ljust läge'}</span>
    </div>
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
        <Link to="/" className="sb-brand" onClick={onClose}>
          <img src="/evin.png" alt="" className="sb-brand-logo" />
          <div className="sb-brand-text">
            <strong>Trading OS</strong>
            <small>Översikt · test · läsning</small>
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
          <ThemeStatus />
          <div className="sb-footer-meta">
            <span>Trading OS</span>
            <span>Inga affärer utförs</span>
          </div>
        </div>

      </aside>
    </>
  );
}
