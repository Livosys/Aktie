import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAlerts } from './alertContext.jsx';

const NAV_ITEMS = [
  { path: '/aktier',   label: 'Aktier',   icon: '📈', cls: 'nav-stocks' },
  { path: '/nasdaq',   label: 'Nasdaq',   icon: '⚡', cls: 'nav-nasdaq' },
  { path: '/krypto',   label: 'Krypto',   icon: '₿', cls: 'nav-crypto' },
  { path: '/historik', label: 'Historik', icon: '📚', cls: 'nav-history' },
  { path: '/replay',   label: 'Replay',   icon: '▶️', cls: 'nav-replay' },
  { path: '/machine',  label: 'Machine',  icon: '🤖', cls: 'nav-machine' },
];

function AlertButton() {
  const { enabled, notifStatus, activate, deactivate } = useAlerts();

  if (enabled) {
    return (
      <button className="btn-alert btn-alert-active" onClick={deactivate} title="Stäng av ljud och notiser">
        <span className="btn-alert-dot" />
        Stäng av ljud &amp; notiser
      </button>
    );
  }

  const denied = notifStatus === 'denied';
  return (
    <button
      className={`btn-alert${denied ? ' btn-alert-denied' : ''}`}
      onClick={activate}
      title={denied ? 'Notiser blockerade i webbläsaren – ljud aktiveras ändå' : 'Aktivera signalljud och webbläsarnotiser'}
    >
      {denied ? '🔕 Aktivera ljud (notiser blockerade)' : '🔔 Aktivera ljud & notiser'}
    </button>
  );
}

export default function Navigation() {
  const { pathname } = useLocation();
  return (
    <nav className="nav">
      <Link to="/aktier" className="nav-brand">
        <span className="nav-brand-icon">📊</span>
        <span>2M Scanner</span>
      </Link>
      <div className="nav-links">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`nav-link ${item.cls}${pathname.startsWith(item.path) ? ' active' : ''}`}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
      <AlertButton />
    </nav>
  );
}
