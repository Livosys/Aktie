import React from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function MobileBottomNav() {
  const { pathname } = useLocation();

  const tabs = [
    { id: 'live', label: 'Live', active: pathname.startsWith('/live'), to: '/live' },
    { id: 'paper-trading', label: 'Paper Trading', active: pathname.startsWith('/paper-trading'), to: '/paper-trading' },
    { id: 'futures-paper', label: 'Futures', active: pathname.startsWith('/futures-paper') || pathname.startsWith('/paper-futures'), to: '/futures-paper' },
    { id: 'lab', label: 'Test Lab', active: pathname.startsWith('/lab'), to: '/lab' },
    { id: 'system', label: 'System', active: pathname.startsWith('/system'), to: '/system' },
  ];

  return (
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
    </nav>
  );
}
