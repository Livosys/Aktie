import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function MobileBottomNav() {
  const { pathname, search } = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const currentLocation = `${pathname}${search}`;

  const tabs = [
    { id: 'supervisor', label: 'Supervisor', active: pathname.startsWith('/supervisor'), to: '/supervisor' },
    { id: 'paper-trading', label: 'Paper', active: pathname.startsWith('/paper-trading'), to: '/paper-trading' },
    { id: 'futures-paper', label: 'Futures', active: pathname.startsWith('/futures-paper') || pathname.startsWith('/paper-futures'), to: '/futures-paper' },
    { id: 'ai', label: 'AI', active: pathname.startsWith('/ai'), to: '/ai' },
  ];
  const drawerLinks = [
    { id: 'live', label: 'Live Trading', active: pathname.startsWith('/live'), to: '/live' },
    { id: 'interactive-brokers', label: 'Interactive Brokers', active: pathname.startsWith('/interactive-brokers'), to: '/interactive-brokers' },
    { id: 'system', label: 'System', active: pathname.startsWith('/system'), to: '/system' },
    { id: 'pinescript', label: 'PineScript', active: pathname.startsWith('/pinescript') || pathname.startsWith('/pine-script'), to: '/pinescript' },
    { id: 'batch', label: 'Batch Lab', active: currentLocation === '/lab?tab=batch', to: '/lab?tab=batch' },
    { id: 'replay', label: 'Replay Lab', active: currentLocation === '/lab?tab=replay' || pathname.startsWith('/replay'), to: '/lab?tab=replay' },
    { id: 'lab', label: 'Test Lab', active: pathname.startsWith('/lab') && !['/lab?tab=batch', '/lab?tab=replay'].includes(currentLocation), to: '/lab' },
    { id: 'insikter', label: 'Insikter', active: pathname.startsWith('/insikter'), to: '/insikter' },
    { id: 'daytrading', label: 'Daytrading', active: pathname.startsWith('/daytrading'), to: '/daytrading' },
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
