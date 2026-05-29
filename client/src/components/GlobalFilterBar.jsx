import React from 'react';
import { useLocation } from 'react-router-dom';
import { DEFAULT_GLOBAL_FILTERS, useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

const MARKETS = [
  { key: 'all', label: 'Alla' },
  { key: 'stocks', label: 'Aktier' },
  { key: 'nasdaq', label: 'Nasdaq' },
  { key: 'crypto', label: 'Krypto' },
  { key: 'etf', label: 'ETF' },
];

const DIRECTIONS = [
  { key: 'all', label: 'Alla' },
  { key: 'long', label: 'Long' },
  { key: 'short', label: 'Short' },
];

function modeForPath(pathname) {
  if (pathname.startsWith('/lab') || pathname.startsWith('/trading-lab')) return { label: 'TEST', className: 'test' };
  if (pathname.startsWith('/insikter') || pathname.startsWith('/resultat')) return { label: 'HISTORIK', className: 'history' };
  if (pathname.startsWith('/system')) return { label: 'SYSTEM', className: 'system' };
  return { label: 'LIVE', className: 'live' };
}

export default function GlobalFilterBar() {
  const { pathname } = useLocation();
  const { ui, setGlobalFilters, resetGlobalFilters } = useUnifiedConfig('core');
  const filters = ui.globalFilters || DEFAULT_GLOBAL_FILTERS;
  const mode = modeForPath(pathname);

  function patch(next) {
    setGlobalFilters(next);
  }

  const hasCustomFilters = JSON.stringify(filters) !== JSON.stringify(DEFAULT_GLOBAL_FILTERS);

  return (
    <div className="global-filter-bar" aria-label="Globala filter">
      <div className={`global-mode-chip global-mode-${mode.className}`}>
        <span className="global-mode-dot" />
        <strong>{mode.label}</strong>
      </div>

      <div className="global-filter-group global-filter-market" aria-label="Marknad">
        {MARKETS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`global-filter-pill${filters.market === item.key ? ' is-active' : ''}`}
            onClick={() => patch({ market: item.key })}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="global-filter-group" aria-label="Riktning">
        {DIRECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`global-filter-pill${filters.direction === item.key ? ' is-active' : ''}`}
            onClick={() => patch({ direction: item.key })}
          >
            {item.label}
          </button>
        ))}
      </div>

      <label className="global-filter-field">
        <span>Min score</span>
        <select value={filters.minScore} onChange={(event) => patch({ minScore: Number(event.target.value) })}>
          <option value={0}>Alla</option>
          <option value={40}>40+</option>
          <option value={60}>60+</option>
          <option value={75}>75+</option>
        </select>
      </label>

      <label className="global-filter-symbol">
        <span>Symbol</span>
        <input
          value={filters.symbol}
          onChange={(event) => patch({ symbol: event.target.value })}
          placeholder="Alla"
          inputMode="text"
          autoComplete="off"
        />
      </label>

      <label className="global-filter-check">
        <input
          type="checkbox"
          checked={filters.hideAvoid}
          onChange={(event) => patch({ hideAvoid: event.target.checked })}
        />
        <span>Dölj avoid</span>
      </label>

      {hasCustomFilters && (
        <button className="global-filter-reset" type="button" onClick={resetGlobalFilters}>
          Rensa
        </button>
      )}
    </div>
  );
}
