import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SystemStatusStrip from './SystemStatusStrip.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import AiSummaryBar from './AiSummaryBar.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';

const SEARCH_ROUTES = [
  { key: 'supervisor', to: '/supervisor' },
  { key: 'trading os', to: '/supervisor' },
  { key: 'översikt', to: '/supervisor' },
  { key: 'oversikt', to: '/supervisor' },
  { key: 'kontrollrum', to: '/supervisor' },
  { key: 'live', to: '/live' },
  { key: 'marknad', to: '/live' },
  { key: 'scanner', to: '/live' },
  { key: 'signaler', to: '/live' },
  { key: 'aktier', to: '/live?filter=stocks' },
  { key: 'nasdaq', to: '/live?filter=nasdaq' },
  { key: 'krypto', to: '/live?filter=crypto' },
  { key: 'larm', to: '/system?tab=logs' },
  { key: 'säkerhet', to: '/system?tab=safety' },
  { key: 'safety', to: '/system?tab=safety' },
  { key: 'diagram', to: '/lab?tab=review' },
  { key: 'historik', to: '/insikter?tab=memory' },
  { key: 'replay', to: '/lab?tab=replay' },
  { key: 'intelligens', to: '/lab?tab=adaptive' },
  { key: 'hälsa', to: '/system?tab=health' },
  { key: 'halsa', to: '/system?tab=health' },
  { key: 'system', to: '/system' },
  { key: 'lab', to: '/lab' },
  { key: 'research', to: '/lab' },
  { key: 'insikter', to: '/insikter' },
  { key: 'resultatarkiv', to: '/insikter' },
];

export default function TopBar({ onMenu, status }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { language, setLanguage, t } = useLanguage();

  function submitSearch(event) {
    event.preventDefault();
    const q = query.trim().toLowerCase();
    if (!q) return;
    const route = SEARCH_ROUTES.find((item) => item.key.includes(q) || q.includes(item.key));
    if (route) {
      navigate(route.to);
      setQuery('');
      return;
    }
    navigate(`/lab?tab=review&symbol=${encodeURIComponent(query.trim().toUpperCase())}&timeframe=2m`);
    setQuery('');
  }

  function openHelp() {
    window.dispatchEvent(new CustomEvent('trading-os-help:open'));
  }

  return (
    <header className="premium-topbar">
      <div className="premium-topbar-main">
        <button className="premium-menu-button" type="button" onClick={onMenu} aria-label={t('topbar.openMenu', 'Öppna meny')}>
          <span />
          <span />
          <span />
        </button>

        <form className="premium-search" onSubmit={submitSearch}>
          <span>{t('topbar.search', 'Sök')}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('topbar.searchPlaceholder', 'Symbol eller sida')}
            aria-label={t('topbar.searchAria', 'Sök symbol eller sida')}
          />
        </form>

        <SystemStatusStrip status={status} />
        <button type="button" className="premium-help-button" onClick={openHelp}>
          {t('topbar.newHere', 'Ny här?')}
        </button>
        <div className="language-toggle" role="group" aria-label={t('language.toggleLabel', 'Välj språk')}>
          <button
            type="button"
            className={language === 'sv' ? 'active' : ''}
            onClick={() => setLanguage('sv')}
            aria-pressed={language === 'sv'}
          >
            SV
          </button>
          <span aria-hidden="true">|</span>
          <button
            type="button"
            className={language === 'en' ? 'active' : ''}
            onClick={() => setLanguage('en')}
            aria-pressed={language === 'en'}
          >
            EN
          </button>
        </div>
        <ThemeToggle />
      </div>
      <AiSummaryBar />
    </header>
  );
}
