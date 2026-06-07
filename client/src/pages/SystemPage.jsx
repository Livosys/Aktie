import React, { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SystemHealthPage from './SystemHealthPage.jsx';
import AlertsPage from './AlertsPage.jsx';
import { BlockersTab, RiskTab, SafetyTab } from './SakerhetsPage.jsx';
import { ConfigScopeBadge, PlatformEmptyState, PlatformSafetyBar } from '../components/PlatformControls.jsx';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';

const TABS = [
  { key: 'overview', labelKey: 'insights.overview', label: 'Översikt', icon: '⚙️' },
  { key: 'health', labelText: 'Hälsa', label: 'Hälsa', icon: '🩺' },
  { key: 'providers', label: 'Providers', icon: '🔌' },
  { key: 'logs', labelText: 'Loggar', label: 'Loggar', icon: '🔔' },
  { key: 'safety', label: 'Safety', icon: '🛡️' },
  { key: 'debug', label: 'Debug', icon: '🧰' },
];

const SAFETY_FLAGS = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function componentState(items) {
  if (!items || items.length === 0) return 'Fel';
  if (items.some((c) => c.status === 'BROKEN' || c.severity === 'critical')) return 'Fel';
  return 'OK';
}

function useHealth() {
  const unified = useUnifiedConfig('health');
  return {
    data: unified.global.systemHealth,
    loading: unified.meta.loading && !unified.global.systemHealth,
  };
}

function SystemMetric({ label, value, state }) {
  const { tr } = useLanguage();
  return (
    <div className={`sys-metric sys-metric-${state || 'info'}`}>
      <div className="sys-metric-value">{tr(value ?? '–')}</div>
      <div className="sys-metric-label">{tr(label)}</div>
    </div>
  );
}

function OverviewTab() {
  const { tr } = useLanguage();
  const { data, loading } = useHealth();
  const counts = useMemo(() => {
    const comps = data?.components || [];
    return {
      total: comps.length,
      ok: comps.filter(c => c.status === 'ON').length,
      stale: comps.filter(c => c.status === 'STALE' || c.status === 'DISABLED').length,
      broken: comps.filter(c => c.status === 'BROKEN').length,
    };
  }, [data]);
  const backendState = componentState((data?.components || []).filter((c) => ['Runtime', 'APIs'].includes(c.area)));
  const dataState = componentState((data?.components || []).filter((c) => c.area === 'Data Files'));
  const scannerState = componentState((data?.components || []).filter((c) => c.area === 'Scanner'));
  const learningState = componentState((data?.components || []).filter((c) => c.area === 'Learning'));
  const providerState = componentState((data?.components || []).filter((c) => c.area === 'Providers'));
  const safetyState = 'Låst';

  if (loading) return <div className="sys-loading">{tr('Kontrollerar systemet...')}</div>;

  return (
    <div className="sys-tab-content">
      <div className="sys-hero-state">
        <div>
          <div className="sys-hero-title">{data?.summarySv || tr('Systemstatus är inte tillgänglig just nu.')}</div>
          <div className="sys-hero-sub">{tr('System & Safety är teknisk felsökning. Ingen strategi- eller runtime-styrning ska göras här.')}</div>
        </div>
        <ConfigScopeBadge scope="global" />
        <span className={`sys-state sys-state-${(data?.overallStatus || 'unknown').toLowerCase()}`}>
          {data?.overallStatus || 'UNKNOWN'}
        </span>
      </div>

      <div className="sys-metrics">
        <SystemMetric label="Backend" value={backendState} state={backendState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Data" value={dataState} state={dataState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Scanner" value={scannerState} state={scannerState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Learning" value={learningState} state={learningState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Providers" value={providerState} state={providerState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Safety" value={safetyState} state="ok" />
      </div>

      <div className="sys-hero-sub">{tr('Komponenter')}: {counts.total} {tr('totalt')}, {counts.ok} OK, {counts.stale} {tr('varningar')}, {counts.broken} {tr('fel')}.</div>

      <div className="sys-metrics">
        <SystemMetric label="mode" value={SAFETY_FLAGS.mode} state="ok" />
        <SystemMetric label="actions_allowed" value="false" state="ok" />
        <SystemMetric label="can_place_orders" value="false" state="ok" />
        <SystemMetric label="live_trading_enabled" value="false" state="ok" />
        <SystemMetric label="broker_enabled" value="false" state="ok" />
      </div>

      <div className="sys-link-grid">
        <Link to="/system?tab=health" className="sys-link-card">🩺 {tr('Systemhälsa')}</Link>
        <Link to="/system?tab=providers" className="sys-link-card">🔌 {tr('Datakällor')}</Link>
        <Link to="/system?tab=logs" className="sys-link-card">🔔 {tr('Loggar & larm')}</Link>
        <Link to="/system?tab=safety" className="sys-link-card">🛡️ {tr('Safety-status (kanonisk)')}</Link>
      </div>
    </div>
  );
}

function ProvidersTab() {
  const { tr } = useLanguage();
  const { data, loading } = useHealth();
  const feeds = data?.feeds || {};
  if (loading) return <div className="sys-loading">{tr('Hämtar providers...')}</div>;
  const rows = [
    { key: 'stocks', label: tr('Aktier'), feed: feeds.stocks },
    { key: 'crypto', label: tr('Krypto'), feed: feeds.crypto },
  ];

  return (
    <div className="sys-tab-content">
      <div className="sys-hero-sub">{tr('Providers är tekniska källor. De styr inte strategibeslut, bara dataflödet.')}</div>
      <div className="sys-provider-grid">
        {rows.map(row => (
          <div key={row.key} className="sys-provider-card">
            <div className="sys-provider-head">
              <strong>{row.label}</strong>
              <span>{row.feed?.provider || tr('okänd provider')}</span>
            </div>
            <div>Status: {row.feed?.status || tr('saknas')}</div>
            <div>{tr('Senaste data')}: {row.feed?.latestTimestamp || row.feed?.lastUpdated || tr('väntar på data')}</div>
            <div>{row.feed?.messageSv || tr('Ingen provider-varning.')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DebugTab() {
  const { tr } = useLanguage();
  return (
    <div className="sys-tab-content">
      <PlatformEmptyState
        title="Avancerad debug är dold"
        text="Rå JSON och interna testverktyg ska bara öppnas vid felsökning. Systemet visar först hälsa, providers och safety."
        action={<Link className="sys-debug-link" to="/system-health">{tr('Öppna äldre systemhälsa')}</Link>}
      />
    </div>
  );
}

function SafetyOverviewTab() {
  return (
    <div className="sys-tab-content sys-safety-stack">
      <SafetyTab />
      <RiskTab />
      <BlockersTab />
    </div>
  );
}

export default function SystemPage() {
  const { t, tr } = useLanguage();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';
  const active = TABS.some(t => t.key === tab) ? tab : 'overview';

  function setTab(next) {
    setParams(next === 'overview' ? {} : { tab: next });
  }

  return (
    <div className="sys-page">
      <PlatformSafetyBar />

      <div className="sys-page-header">
        <h1 className="sys-page-title">🛡 System &amp; Safety</h1>
        <p className="sys-page-sub">{tr('Teknisk status, hälsa och safety. Ingen strategi- eller runtime-styrning görs här.')}</p>
      </div>

      <div className="sys-tabs">
        {TABS.map(tabItem => (
          <button
            key={tabItem.key}
            className={`sys-tab${active === tabItem.key ? ' sys-tab-active' : ''}`}
            onClick={() => setTab(tabItem.key)}
            type="button"
          >
            <span>{tabItem.icon}</span>
            <span>{tabItem.labelKey ? t(tabItem.labelKey, tabItem.label) : tr(tabItem.labelText || tabItem.label)}</span>
          </button>
        ))}
      </div>

      {active === 'overview' && <OverviewTab />}
      {active === 'health' && <SystemHealthPage />}
      {active === 'providers' && <ProvidersTab />}
      {active === 'logs' && <AlertsPage />}
      {active === 'safety' && <SafetyOverviewTab />}
      {active === 'debug' && <DebugTab />}
    </div>
  );
}
