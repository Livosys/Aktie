import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SystemStatusStrip from './SystemStatusStrip.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import AiSummaryBar from './AiSummaryBar.jsx';
import GlobalFilterBar from './GlobalFilterBar.jsx';

const SEARCH_ROUTES = [
  { key: 'supervisor', to: '/supervisor' },
  { key: 'översikt', to: '/supervisor' },
  { key: 'oversikt', to: '/supervisor' },
  { key: 'kör bilen', to: '/supervisor' },
  { key: 'live', to: '/live' },
  { key: 'scanner', to: '/live' },
  { key: 'signaler', to: '/live' },
  { key: 'aktier', to: '/live?filter=stocks' },
  { key: 'nasdaq', to: '/live?filter=nasdaq' },
  { key: 'krypto', to: '/live?filter=crypto' },
  { key: 'daytrading', to: '/daytrading' },
  { key: 'daytrade', to: '/daytrading' },
  { key: 'strategier live', to: '/daytrading' },
  { key: 'strategier', to: '/daytrading' },
  { key: 'live pipeline', to: '/daytrading' },
  { key: 'pipeline', to: '/daytrading' },
  { key: 'paper trades', to: '/daytrading' },
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
  { key: 'insikter', to: '/insikter' },
];

export default function TopBar({ onMenu, status }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

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

  return (
    <header className="premium-topbar">
      <div className="premium-topbar-main">
        <button className="premium-menu-button" type="button" onClick={onMenu} aria-label="Öppna meny">
          <span />
          <span />
          <span />
        </button>

        <form className="premium-search" onSubmit={submitSearch}>
          <span>Sök</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Symbol eller sida"
            aria-label="Sök symbol eller sida"
          />
        </form>

        <SystemStatusStrip status={status} />
        <ThemeToggle />
      </div>
      <GlobalFilterBar />
      <AiSummaryBar />
    </header>
  );
}
