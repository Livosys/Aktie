import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { navItemsFor, isNavItemActive, NAV_SURFACES } from './navigation.js';

export default function MobileBottomNav() {
  const { pathname, search } = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const currentLocation = `${pathname}${search}`;

  // Både flikraden och lådan ritas ur den gemensamma menyn, med samma
  // aktiv-regel som sidomenyn och toppmenyn.
  const withActive = (surface) => navItemsFor(surface)
    .map((item) => ({ ...item, active: isNavItemActive(item, pathname, search) }));
  const tabs = withActive(NAV_SURFACES.MOBILE_BOTTOM);
  const drawerLinks = withActive(NAV_SURFACES.MOBILE_DRAWER);
  const drawerActive = drawerLinks.some((link) => link.active);

  useEffect(() => {
    setDrawerOpen(false);
  }, [currentLocation]);

  return (
    <>
      {drawerOpen ? (
        <button
          type="button"
          className="mob-drawer-overlay"
          aria-label="Stäng mobilmeny"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}
      {drawerOpen ? (
        <div className="mob-drawer" id="mobile-nav-drawer" role="dialog" aria-modal="true" aria-label="Fler sidor">
          <div className="mob-drawer-handle" aria-hidden="true" />
          <div className="mob-drawer-title">Huvudnavigation</div>
          <div className="mob-drawer-grid">
            {drawerLinks.map((link) => (
              <Link
                key={link.id}
                to={link.path}
                className={`mob-drawer-item${link.active ? ' active' : ''}`}
                onClick={() => setDrawerOpen(false)}
              >
                <span className="mob-drawer-label">{link.label}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      <nav className="mob-bottom-nav" role="navigation" aria-label="Mobilnavigation">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={tab.path}
            className={`mob-tab${tab.active ? ' mob-tab-active' : ''}`}
            aria-label={tab.label}
          >
            <span className="mob-tab-label">{tab.label}</span>
          </Link>
        ))}
        <button
          type="button"
          className={`mob-tab${drawerOpen || drawerActive ? ' mob-tab-active' : ''}`}
          aria-label="Fler sidor"
          aria-controls="mobile-nav-drawer"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <span className="mob-tab-label">Mer</span>
        </button>
      </nav>
    </>
  );
}
