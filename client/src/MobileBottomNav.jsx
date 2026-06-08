import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLanguage } from './i18n/LanguageContext.jsx';

export default function MobileBottomNav() {
  const { pathname } = useLocation();
  const { t } = useLanguage();

  const tabs = [
    { id: 'supervisor', label: t('nav.supervisor', 'Trading OS'), icon: '🧭', active: pathname.startsWith('/supervisor') || pathname.startsWith('/overview') || pathname.startsWith('/oversikt'), to: '/supervisor' },
    { id: 'live',       label: t('nav.live', 'Live'),             icon: '♥', active: pathname === '/' || pathname.startsWith('/live') || pathname.startsWith('/signalpuls'), to: '/live' },
    { id: 'lab',        label: t('nav.lab', 'Lab'),               icon: 'L', active: pathname.startsWith('/lab') || pathname.startsWith('/trading-lab'), to: '/lab' },
    { id: 'insikter',   label: t('nav.insights', 'Insikter'),     icon: 'I', active: pathname.startsWith('/insikter') || pathname.startsWith('/resultat'), to: '/insikter' },
    { id: 'system',     label: t('nav.system', 'System'),         icon: 'S', active: pathname.startsWith('/system') || pathname.startsWith('/sakerhet'), to: '/system' },
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
