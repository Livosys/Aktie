import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function MobileBottomNav() {
  const { pathname, search } = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const currentLocation = `${pathname}${search}`;
  const currentTab = new URLSearchParams(search).get('tab');
  const onFuturesPage = pathname.startsWith('/futures-paper') || pathname.startsWith('/paper-futures');

  const tabs = [
    { id: 'overview', label: 'Översikt', active: pathname === '/' || pathname.startsWith('/supervisor'), to: '/supervisor' },
    { id: 'futures', label: 'Futures', active: onFuturesPage && !['positioner', 'ordrar'].includes(currentTab), to: '/futures-paper' },
    { id: 'positions', label: 'Positioner', active: onFuturesPage && currentTab === 'positioner', to: '/futures-paper?tab=positioner' },
    // Fliken heter 'ordrar' av bakåtkompatibilitetsskäl men visar Live Scanner.
    { id: 'execution', label: 'Live Scanner', active: onFuturesPage && currentTab === 'ordrar', to: '/futures-paper?tab=ordrar' },
  ];
  // Replay och Batch ligger först: de är egna arbetsytor, inte laborationer.
  // Aktivt läge avgörs av tab-parametern, inte av en exakt URL-sträng, så att
  // /replay och andra omdirigeringar också markerar rätt post.
  const onLabPage = pathname.startsWith('/lab');
  const drawerLinks = [
    { id: 'replay', label: 'Replay', active: (onLabPage && currentTab === 'replay') || pathname.startsWith('/replay'), to: '/lab?tab=replay' },
    { id: 'batch', label: 'Batch', active: (onLabPage && currentTab === 'batch') || pathname.startsWith('/batch'), to: '/lab?tab=batch' },
    { id: 'history', label: 'Historik', active: pathname.startsWith('/insikter'), to: '/insikter' },
    { id: 'system', label: 'System', active: pathname.startsWith('/system'), to: '/system' },
    { id: 'labs', label: 'Labs', active: onLabPage && !['batch', 'replay'].includes(currentTab), to: '/lab' },
    { id: 'pinescript', label: 'PineScript', active: pathname.startsWith('/pinescript') || pathname.startsWith('/pine-script'), to: '/pinescript' },
    { id: 'ai', label: 'AI Research', active: pathname.startsWith('/ai'), to: '/ai' },
    { id: 'narrow', label: 'Narrow Lab', active: pathname.startsWith('/narrow'), to: '/narrow' },
  ];
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
                to={link.to}
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
            to={tab.to}
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
