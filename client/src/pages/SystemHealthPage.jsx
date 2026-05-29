import React, { useMemo, useState } from 'react';
import { SectionHeader, fmtTime } from '../shared.jsx';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

const GROUPS = [
  { key: 'Scanner', title: 'Scanner', icon: '📡' },
  { key: 'Providers', title: 'Datakällor', icon: '🔌' },
  { key: 'Machine', title: 'Motor', icon: '🤖' },
  { key: 'Replay', title: 'Testa historik', icon: '▶️' },
  { key: 'History', title: 'Historik', icon: '📚' },
  { key: 'Learning', title: 'Lärande', icon: '🧠' },
  { key: 'Momentum Intelligence', title: 'Fartanalys', icon: '📈' },
  { key: 'Data Files', title: 'Datafiler', icon: '🗄️' },
  { key: 'APIs', title: 'API:er', icon: '🔌' },
];

function useSystemHealth() {
  const unified = useUnifiedConfig('health');
  return {
    data: unified.global.systemHealth,
    loading: unified.meta.loading && !unified.global.systemHealth,
    error: unified.meta.errors.systemHealth || null,
    refresh: () => unified.refresh('systemHealth'),
  };
}

function groupStatus(items) {
  if (!items || items.length === 0) return 'DISABLED';
  if (items.some((c) => c.status === 'BROKEN' || c.severity === 'critical')) return 'BROKEN';
  if (items.some((c) => c.status === 'STALE' || c.status === 'DISABLED' || c.severity === 'warning')) return 'STALE';
  return 'ON';
}

function statusMeta(status) {
  if (status === 'ON') return { label: 'ON', cls: 'sh-on' };
  if (status === 'MARKET_CLOSED') return { label: 'STÄNGD', cls: 'sh-stale' };
  if (status === 'STALE') return { label: 'GAMMAL', cls: 'sh-stale' };
  if (status === 'DISABLED') return { label: 'AVSTÄNGD', cls: 'sh-stale' };
  return { label: 'TRASIG', cls: 'sh-broken' };
}

function topTitle(status) {
  if (status === 'HEALTHY') return 'Systemet är ON';
  if (status === 'WARNING') return 'Varning: något behöver kollas';
  return 'Kritiskt fel';
}

function overallLabel(status) {
  if (status === 'HEALTHY') return 'FRISKT';
  if (status === 'WARNING') return 'VARNING';
  return 'KRITISKT';
}

function componentLine(c) {
  const m = statusMeta(c.status);
  return (
    <div className="sh-component" key={`${c.area}-${c.name}`}>
      <span className={`sh-dot ${m.cls}`} />
      <div className="sh-component-main">
        <span className="sh-component-name">{c.name}</span>
        <span className="sh-component-msg">{c.messageSv}</span>
      </div>
      <div className="sh-component-meta">
        <span className={`sh-mini-status ${m.cls}`}>{m.label}</span>
        <span>{c.lastUpdated ? fmtTime(c.lastUpdated) : '–'}</span>
      </div>
    </div>
  );
}

function FeedStatusPanel({ feeds }) {
  const rows = [
    { key: 'stocks', label: 'Aktier', feed: feeds?.stocks },
    { key: 'crypto', label: 'Krypto', feed: feeds?.crypto },
  ];

  return (
    <div className="ux-feed-grid">
      {rows.map(({ key, label, feed }) => {
        const status = feed?.status || 'BROKEN';
        const m = statusMeta(status === 'WARNING' ? 'STALE' : status);
        const provider = feed?.provider === 'alpaca' ? 'Alpaca' : feed?.provider === 'binance' ? 'Binance' : 'Okänd';
        return (
          <div className="ux-feed-card" key={key}>
            <div className="ux-feed-top">
              <strong>{label}</strong>
              <span className={`sh-mini-status ${m.cls}`}>{m.label}</span>
            </div>
            <div className="ux-feed-line">Datakälla: {provider}</div>
            <div className="ux-feed-line">Senaste candle: {feed?.latestTimestamp || feed?.lastUpdated ? fmtTime(feed.latestTimestamp || feed.lastUpdated) : '–'}</div>
            <div className="ux-feed-line">
              {feed?.status === 'MARKET_CLOSED'
                ? 'Marknaden stängd'
                : feed?.stale
                  ? 'Gammal data'
                  : feed?.status === 'BROKEN' || feed?.status === 'WARNING'
                    ? 'Provider-fel'
                    : 'Färsk data'}
              {feed?.ageMinutes != null ? ` · ${feed.ageMinutes} min` : ''}
            </div>
            {feed?.messageSv && <div className="ux-feed-line">{feed.messageSv}</div>}
            {feed?.status === 'MARKET_CLOSED' && (
              <div className="ux-feed-line">Data används inte som livebeslut.</div>
            )}
            {feed?.latestProviderError && (
              <details className="ux-technical">
                <summary>Visa teknisk detalj</summary>
                {feed.latestProviderError.type}: {feed.latestProviderError.message}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HealthCard({ group, items }) {
  const [open, setOpen] = useState(false);
  const status = groupStatus(items);
  const m = statusMeta(status);
  const primary = items.find((c) => c.status === 'BROKEN') || items.find((c) => c.status === 'STALE') || items[0];

  return (
    <div className="sh-card">
      <div className="sh-card-head">
        <div>
          <div className="sh-card-title">{group.icon} {group.title}</div>
          <div className="sh-card-message">{primary?.messageSv || 'Ingen data ännu.'}</div>
        </div>
        <span className={`sh-status ${m.cls}`}>{m.label}</span>
      </div>
      <div className="sh-card-foot">
        <span>Senast: {primary?.lastUpdated ? fmtTime(primary.lastUpdated) : '–'}</span>
        <button className="btn sh-detail-btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Dölj tekniska detaljer' : 'Visa tekniska detaljer'}
        </button>
      </div>
      {open && (
        <div className="sh-details">
          {items.map(componentLine)}
        </div>
      )}
    </div>
  );
}

export default function SystemHealthPage() {
  const { data, loading, error, refresh } = useSystemHealth();

  const grouped = useMemo(() => {
    const map = {};
    for (const g of GROUPS) map[g.key] = [];
    for (const c of data?.components || []) {
      if (c.area === 'Runtime') map.Scanner.push(c);
      else if (c.area === 'Providers') map.Providers.push(c);
      else if (c.area === 'Machine') map.Machine.push(c);
      else if (c.area === 'APIs') map.APIs.push(c);
      else if (c.area === 'Data Files') {
        if ((c.name || '').includes('History') || (c.name || '').includes('Outcomes')) map.History.push(c);
        else map['Data Files'].push(c);
      } else if (c.area === 'Learning') {
        if ((c.name || '').includes('Momentum')) map['Momentum Intelligence'].push(c);
        else map.Learning.push(c);
      }
    }
    const replay = (data?.components || []).filter((c) => c.name.includes('Replay'));
    if (replay.length) map.Replay.push(...replay);
    const momentum = (data?.components || []).filter((c) => c.name.includes('Momentum Backtest') || c.name.includes('Momentum backtest'));
    if (momentum.length) map['Momentum Intelligence'].push(...momentum);
    return map;
  }, [data]);

  const criticalAlerts = data?.alerts || [];

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-blue">Systemhälsa</div>
          <div className="hero-sub">En enkel kontrollpanel för scanner, motor, historik, testkörning, lärande och datafiler.</div>
        </div>
        <button className="btn" onClick={refresh}>↻ Uppdatera</button>
      </div>

      {loading && <div className="empty"><span className="spinner" /> Kontrollerar systemhälsa…</div>}
      {error && <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>✗ {error}</div>}

      {data && (
        <>
          <div className={`sh-hero sh-${data.overallStatus.toLowerCase()}`}>
            <div>
              <div className="sh-hero-title">{topTitle(data.overallStatus)}</div>
              <div className="sh-hero-sub">{data.summarySv}</div>
            </div>
            <div className="sh-hero-status">{overallLabel(data.overallStatus)}</div>
          </div>

          <div className="sec">
            <SectionHeader
              icon="🔌"
              title="Datakällor"
              desc="Visar om aktier och krypto får färsk data från sina datakällor."
            />
            <FeedStatusPanel feeds={data.feeds} />
          </div>

          {criticalAlerts.length > 0 && (
            <div className="sh-alert-banner">
              <strong>Kritiska varningar</strong>
              {criticalAlerts.map((a, i) => (
                <div key={i} className="sh-alert-line">
                  <span>{a.titleSv}: {a.messageSv}</span>
                  <em>{a.suggestedActionSv}</em>
                </div>
              ))}
            </div>
          )}

          <div className="sec">
            <SectionHeader icon="🩺" title="Kontrollcenter" desc="Tekniska detaljer är dolda tills du öppnar ett kort." />
            <div className="sh-grid">
              {GROUPS.map((g) => (
                <HealthCard key={g.key} group={g} items={grouped[g.key] || []} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
