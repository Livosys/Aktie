import React from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function MobileBottomNav() {
  const { pathname } = useLocation();

  const tabs = [
    { id: 'supervisor', label: 'Control Room', active: pathname.startsWith('/supervisor'), to: '/supervisor' },
    { id: 'live', label: 'Live', active: pathname.startsWith('/live'), to: '/live' },
    { id: 'daytrading', label: 'Daytrading / Paper', active: pathname.startsWith('/daytrading') || pathname.startsWith('/paper-trading'), to: '/daytrading' },
    { id: 'lab', label: 'Test Lab', active: pathname.startsWith('/lab'), to: '/lab' },
    { id: 'system', label: 'System', active: pathname.startsWith('/system'), to: '/system' },
    { id: 'insikter', label: 'Resultat / Data', active: pathname.startsWith('/insikter'), to: '/insikter?tab=overview' },
    { id: 'narrow', label: 'Narrow State', active: pathname.startsWith('/narrow'), to: '/narrow' },
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
