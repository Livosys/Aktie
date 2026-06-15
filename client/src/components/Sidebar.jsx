import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getTheme } from './ThemeToggle.jsx';

const NAV_GROUPS = [
  {
    id: 'pipeline',
    label: 'Trading OS',
    items: [
      { path: '/supervisor', label: 'Control Room', match: ['/supervisor'], accent: 'blue' },
      { path: '/live', label: 'Live', match: ['/live'], accent: 'blue' },
      { path: '/paper-trading', label: 'Paper Trading', match: ['/paper-trading'], accent: 'green' },
      { path: '/lab', label: 'Test Lab', match: ['/lab'], accent: 'orange' },
      { path: '/system', label: 'System', match: ['/system'], accent: 'purple' },
      { path: '/insikter?tab=overview', label: 'Resultat / Data', match: ['/insikter'], accent: 'teal' },
      { path: '/narrow', label: 'Narrow State', match: ['/narrow'], accent: 'teal' },
    ],
  },
];

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

  return (
    <Link
      to={item.path}
      className={`sb-link${active ? ' sb-link-active' : ''}`}
      onClick={onClose}
    >
      <span className="sb-link-copy">
        <span className="sb-link-label">{item.label}</span>
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
          </div>
        </div>

      </aside>
    </>
  );
}
