import React from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function MobileBottomNav() {
  const { pathname } = useLocation();

  const tabs = [
    { id: 'supervisor', label: 'Control Room', icon: '🧭', active: pathname.startsWith('/supervisor'), to: '/supervisor' },
    { id: 'live', label: 'Live', icon: '♥', active: pathname.startsWith('/live'), to: '/live' },
    { id: 'paper', label: 'Paper Trading', icon: '◌', active: pathname.startsWith('/paper-trading'), to: '/paper-trading' },
    { id: 'lab', label: 'Test Lab', icon: '🧪', active: pathname.startsWith('/lab'), to: '/lab' },
    { id: 'system', label: 'System', icon: '🛡️', active: pathname.startsWith('/system'), to: '/system' },
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
          <span className="mob-tab-icon">{tab.icon}</span>
          <span className="mob-tab-label">{tab.label}</span>
          {tab.id === 'live' && <span className="mob-tab-live" />}
        </Link>
      ))}
    </nav>
  );
}
