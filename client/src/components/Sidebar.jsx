import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { navGroupsFor, isNavItemActive, NAV_SURFACES } from '../navigation.js';


const ACCENT_CLASS = {
  blue:   'sb-icon-blue',
  green:  'sb-icon-green',
  orange: 'sb-icon-orange',
  purple: 'sb-icon-purple',
  teal:   'sb-icon-teal',
};

function NavItem({ item, onClose }) {
  const { pathname, search } = useLocation();
  const active = isNavItemActive(item, pathname, search);
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
        <Link to="/factory" className="sb-brand" onClick={onClose}>
          <img src="/evin.png" alt="" className="sb-brand-logo" />
          <div className="sb-brand-text">
            <strong>Mini Futures First</strong>
            <small>MNQ · MES</small>
          </div>
        </Link>

        {/* Nav */}
        <nav className="sb-nav" aria-label="Huvudnavigation">
          {navGroupsFor(NAV_SURFACES.SIDEBAR).map((group) => (
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
                  <NavItem key={item.id} item={item} onClose={onClose} />
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
