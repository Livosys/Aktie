import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getTheme } from './ThemeToggle.jsx';

const NAV_GROUPS = [
  {
    id: 'pipeline',
    label: 'Trading OS',
    items: [
      { path: '/paper-trading', label: 'Paper Trading', subtitle: 'Paper trades', icon: '◌', match: ['/paper-trading'], accent: 'green' },
      { path: '/daytrading', label: 'Daytrading', subtitle: 'Research', icon: '◔', match: ['/daytrading'], accent: 'orange' },
      { path: '/supervisor', label: 'Control Room', subtitle: 'Overview', icon: '🧭', match: ['/supervisor'], accent: 'blue' },
      { path: '/narrow', label: 'Narrow State', subtitle: 'Narrow conditions', icon: '◐', match: ['/narrow'], accent: 'teal' },
      { path: '/system', label: 'System', subtitle: 'Safety', icon: '🛡️', match: ['/system'], accent: 'purple', searchMatch: [] },
      { path: '/lab', label: 'Test Lab', subtitle: 'Replay & batch', icon: '🧪', match: ['/lab'], accent: 'orange' },
      { path: '/live', label: 'Live', subtitle: 'Signals', icon: '♥', match: ['/live'], accent: 'blue' },
      { path: '/insikter?tab=data-center', label: 'Data Center', subtitle: 'Data', icon: '◍', match: ['/insikter'], accent: 'teal', searchMatch: ['tab=data-center'] },
      { path: '/system?tab=logs', label: 'Logs', subtitle: 'System logs', icon: '◈', match: ['/system'], accent: 'purple', searchMatch: ['tab=logs'] },
      { path: '/system?tab=health', label: 'Health', subtitle: 'System status', icon: '◎', match: ['/system'], accent: 'purple', searchMatch: ['tab=health'] },
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

function isActive(item, pathname, search) {
  const matches = (item.match || [item.path]).map((p) => p.split('?')[0]);
  const pathMatched = matches.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!pathMatched) {
    return false;
  }
  if (item.searchMatch?.length) {
    return item.searchMatch.some((token) => search.includes(token));
  }
  return true;
}

function NavItem({ item, onClose }) {
  const { pathname, search } = useLocation();
  const active = isActive(item, pathname, search);
  const iconCls = active ? `sb-icon ${ACCENT_CLASS[item.accent] || 'sb-icon-blue'} sb-icon-active` : `sb-icon ${ACCENT_CLASS[item.accent] || 'sb-icon-blue'}`;

  return (
    <Link
      to={item.path}
      className={`sb-link${active ? ' sb-link-active' : ''}`}
      onClick={onClose}
    >
      <span className={iconCls}>{item.icon}</span>
      <span className="sb-link-copy">
        <span className="sb-link-label">{item.label}</span>
        {item.subtitle && <span className="sb-link-subtitle">{item.subtitle}</span>}
      </span>
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
      <span className="sb-theme-label">Theme: {isDark ? 'Dark mode' : 'Light mode'}</span>
    </div>
  );
}

export default function Sidebar({ open, onClose }) {
  return (
    <>
      {open && (
        <button
          className="premium-sidebar-backdrop"
          aria-label="Close menu"
          onClick={onClose}
        />
      )}
      <aside className={`premium-sidebar${open ? ' is-open' : ''}`}>

        {/* Brand */}
        <Link to="/supervisor" className="sb-brand" onClick={onClose}>
          <img src="/evin.png" alt="" className="sb-brand-logo" />
          <div className="sb-brand-text">
            <strong>Trading OS</strong>
            <small>Paper-only research pipeline</small>
          </div>
        </Link>

        {/* Nav */}
        <nav className="sb-nav" aria-label="Main navigation">
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
            <span>No trades executed</span>
          </div>
        </div>

      </aside>
    </>
  );
}
