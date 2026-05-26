import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAlerts } from './alertContext.jsx';

const MORE_ITEMS = [
  { path: '/aktier',           label: 'Aktier',           icon: '📈' },
  { path: '/nasdaq',           label: 'Nasdaq',           icon: '⚡' },
  { path: '/krypto',           label: 'Krypto',           icon: '₿'  },
  { path: '/historik',         label: 'Historik',         icon: '📚' },
  { path: '/replay',           label: 'Testa historik',   icon: '▶️' },
  { path: '/machine',          label: 'Motor',            icon: '🤖' },
  { path: '/missed-breakouts', label: 'Missade rörelser', icon: '🎯' },
  { path: '/wave',             label: 'Vågor',            icon: '🌊' },
  { path: '/review-chart',     label: 'Granska graf',     icon: '🔍' },
  { path: '/paper-trading',   label: 'Paper Trading',    icon: '🧪' },
  { path: '/risk-engine',      label: 'Riskmotor',        icon: '🛡️' },
  { path: '/exit-engine',      label: 'Exitmotor',        icon: '↘️' },
];

const MORE_PATHS = MORE_ITEMS.map(i => i.path);

function MoreDrawer({ open, onClose }) {
  const { pathname } = useLocation();

  useEffect(() => { if (open) document.body.style.overflow = 'hidden'; else document.body.style.overflow = ''; return () => { document.body.style.overflow = ''; }; }, [open]);
  useEffect(() => { onClose(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  return (
    <>
      <div className="mob-drawer-overlay" onClick={onClose} />
      <div className="mob-drawer">
        <div className="mob-drawer-handle" />
        <div className="mob-drawer-title">Fler sidor</div>
        <div className="mob-drawer-grid">
          {MORE_ITEMS.map(item => (
            <Link
              key={item.path}
              to={item.path}
              className={`mob-drawer-item${pathname.startsWith(item.path) ? ' active' : ''}`}
            >
              <span className="mob-drawer-icon">{item.icon}</span>
              <span className="mob-drawer-label">{item.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}

export default function MobileBottomNav() {
  const { pathname } = useLocation();
  const { enabled, heroToasts } = useAlerts();
  const [moreOpen, setMoreOpen] = useState(false);

  const isLive    = pathname === '/' || pathname === '/live';
  const isIntel   = pathname.startsWith('/intelligence') || pathname.startsWith('/machine');
  const isAlerts  = pathname.startsWith('/alerts');
  const isHealth  = pathname.startsWith('/health') || pathname.startsWith('/system-health');
  const isMore    = MORE_PATHS.some(p => pathname.startsWith(p)) && !isIntel;

  const hasBadge  = (heroToasts?.length ?? 0) > 0;

  const tabs = [
    { id: 'live',   label: 'Live',       icon: '📈', active: isLive,   to: '/live' },
    { id: 'intel',  label: 'Intelligens', icon: '🧠', active: isIntel,  to: '/machine' },
    { id: 'alerts', label: 'Larm',       icon: '🔔', active: isAlerts, to: '/alerts', badge: hasBadge, live: enabled },
    { id: 'health', label: 'Hälsa',      icon: '🩺', active: isHealth, to: '/system-health' },
    { id: 'more',   label: 'Mer',        icon: '⚙️', active: isMore,   drawer: true },
  ];

  return (
    <>
      <nav className="mob-bottom-nav" role="navigation" aria-label="Mobilnavigation">
        {tabs.map(tab => {
          const inner = (
            <>
              <span className="mob-tab-icon">{tab.icon}</span>
              <span className="mob-tab-label">{tab.label}</span>
              {tab.badge && <span className="mob-tab-badge" />}
              {tab.live  && <span className="mob-tab-live"  />}
            </>
          );
          if (tab.drawer) {
            return (
              <button
                key={tab.id}
                className={`mob-tab${tab.active || moreOpen ? ' mob-tab-active' : ''}`}
                onClick={() => setMoreOpen(v => !v)}
                type="button"
                aria-label={tab.label}
                aria-expanded={moreOpen}
              >
                {inner}
              </button>
            );
          }
          return (
            <Link
              key={tab.id}
              to={tab.to}
              className={`mob-tab${tab.active ? ' mob-tab-active' : ''}`}
              aria-label={tab.label}
            >
              {inner}
            </Link>
          );
        })}
      </nav>
      <MoreDrawer open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}
