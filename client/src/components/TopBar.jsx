import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SystemStatusStrip from './SystemStatusStrip.jsx';
import ThemeToggle from './ThemeToggle.jsx';

const SEARCH_ROUTES = [
  { key: 'live', to: '/live' },
  { key: 'scanner', to: '/scanner' },
  { key: 'signaler', to: '/signaler' },
  { key: 'aktier', to: '/aktier' },
  { key: 'krypto', to: '/krypto' },
  { key: 'larm', to: '/alerts' },
  { key: 'diagram', to: '/review-chart' },
  { key: 'historik', to: '/historik' },
  { key: 'replay', to: '/replay' },
  { key: 'intelligens', to: '/machine' },
  { key: 'hälsa', to: '/system-health' },
  { key: 'halsa', to: '/system-health' },
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
    navigate(`/review-chart?symbol=${encodeURIComponent(query.trim().toUpperCase())}&timeframe=2m`);
    setQuery('');
  }

  return (
    <header className="premium-topbar">
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
    </header>
  );
}
