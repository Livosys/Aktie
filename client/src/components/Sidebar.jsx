import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const NAV_GROUPS = [
  {
    id: 'mini-futures',
    label: 'Mini Futures',
    items: [
      { path: '/supervisor', label: 'Översikt', icon: 'O', match: ['/', '/supervisor', '/overview', '/oversikt'], accent: 'blue' },
      { path: '/futures-paper', label: 'Futures', icon: 'F', match: ['/futures-paper', '/paper-futures'], excludeTabs: ['positioner', 'ordrar'], accent: 'teal' },
      { path: '/futures-paper?tab=positioner', label: 'Positioner', icon: 'P', match: ['/futures-paper'], tab: 'positioner', accent: 'green' },
      { path: '/futures-paper?tab=ordrar', label: 'Execution', icon: 'E', match: ['/futures-paper'], tab: 'ordrar', accent: 'orange' },
    ],
  },
  {
    id: 'system',
    label: 'Operativt',
    items: [
      { path: '/insikter', label: 'Historik', icon: 'H', match: ['/insikter', '/resultat', '/history', '/historik', '/data-center', '/datacenter', '/setup-performance', '/setup-resultat'], accent: 'purple' },
      { path: '/system', label: 'System', icon: 'S', match: ['/system', '/system-health', '/health', '/halsa', '/alerts', '/larm', '/sakerhet', '/risk', '/risk-engine', '/safety', '/execution-safety'], accent: 'blue' },
    ],
  },
  {
    id: 'labs',
    label: 'Labs',
    items: [
      { path: '/lab', label: 'Labs', icon: 'L', match: ['/lab', '/trading-lab', '/strategy-lab', '/strategilabb', '/replay', '/review-chart', '/machine', '/intelligence', '/intelligens', '/missed-breakouts', '/micro-move', '/wave', '/exit-engine', '/exit', '/pinescript', '/pine-script', '/ai', '/narrow', '/narrow-state'], accent: 'teal' },
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
  const tab = new URLSearchParams(search).get('tab');
  if (item.tab) {
    return (item.match || [item.path]).some((p) => pathname === p.split('?')[0]) && tab === item.tab;
  }
  const matches = (item.match || [item.path]).map((p) => p.split('?')[0]);
  const matched = matches.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!matched) return false;
  if (item.excludeTabs?.includes(tab)) return false;
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
      <span className="sb-link-label">{item.label}</span>
      {active && <span className="sb-active-bar" />}
    </Link>
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
            <strong>Mini Futures First</strong>
            <small>MNQ · MES</small>
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
          <div className="sb-footer-meta">
            <span>Mini Futures</span>
            <span>Inga affärer utförs</span>
          </div>
        </div>

      </aside>
    </>
  );
}
