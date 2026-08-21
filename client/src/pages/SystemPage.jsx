import React, { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SystemHealthPage from './SystemHealthPage.jsx';
import AlertsPage from './AlertsPage.jsx';
import { BlockersTab, RiskTab, SafetyTab } from './SakerhetsPage.jsx';
import { ConfigScopeBadge, PlatformEmptyState, PlatformSafetyBar } from '../components/PlatformControls.jsx';
import {
  ActivityList,
  BarChart,
  ChartCard,
  DashboardShell,
} from '../components/dashboard/DashboardKit.jsx';
import ContextNavigation, { contextAction } from '../components/ContextNavigation.jsx';
import {
  MetricCard,
  StatusBadge,
} from '../components/trading/index.js';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';
import { aiStorySystemStatus } from '../services/aiStoryService.js';
import { uiFactorySafeText } from '../services/uiTerminologyService.js';

const TABS = [
  { key: 'health', label: 'Hälsa' },
  { key: 'broker', label: 'Broker' },
  { key: 'providers', label: 'Datakällor' },
  { key: 'safety', label: 'Säkerhet' },
  { key: 'logs', label: 'Loggar' },
];

const HIDDEN_TAB_KEYS = new Set(['overview', 'debug']);

const SAFETY_FLAGS = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

function componentState(items) {
  if (!items || items.length === 0) return 'Problem';
  if (items.some((c) => c.status === 'BROKEN' || c.severity === 'critical')) return 'Problem';
  return 'OK';
}

function systemStatusLabel(value) {
  const status = String(value || '').toLowerCase();
  if (status === 'healthy' || status === 'ok') return 'OK';
  if (status === 'warning' || status === 'degraded') return 'Varning';
  if (status === 'critical' || status === 'broken' || status === 'failed') return 'Problem';
  return 'Okänt';
}

function systemStatusTone(value) {
  const status = String(value || '').toLowerCase();
  if (status === 'healthy' || status === 'ok') return 'success';
  if (status === 'warning' || status === 'degraded') return 'warning';
  if (status === 'critical' || status === 'broken' || status === 'failed') return 'danger';
  return 'neutral';
}

function useHealth() {
  const unified = useUnifiedConfig('health');
  return {
    data: unified.global.systemHealth,
    loading: unified.meta.loading && !unified.global.systemHealth,
  };
}

function SystemMetric({ label, value, state }) {
  const tone = state === 'ok' ? 'success' : state === 'bad' ? 'danger' : state === 'warn' ? 'warning' : 'neutral';
  return <MetricCard label={label} value={value ?? '—'} tone={tone} />;
}

function OverviewTab() {
  const { data, loading } = useHealth();
  const story = aiStorySystemStatus(data || {});
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
  const componentBars = (data?.components || []).length
    ? [
        { label: 'OK', value: counts.ok, tone: 'good' },
        { label: 'Varning', value: counts.stale, tone: 'warning' },
        { label: 'Fel', value: counts.broken, tone: 'danger' },
      ]
    : [];
  const componentActivity = (data?.components || []).slice(0, 7).map((component, index) => ({
    id: component.id || `${component.area || 'component'}-${index}`,
    title: uiFactorySafeText(component.name || component.label || component.area || 'Systemkomponent'),
    meta: uiFactorySafeText(component.messageSv || component.message || component.status || 'Ingen detalj'),
    time: component.updatedAt || component.lastUpdated || null,
    tone: component.status === 'ON'
      ? 'good'
      : component.status === 'BROKEN'
        ? 'danger'
        : 'warning',
  }));

  if (loading) return <div className="m-empty"><div className="m-empty-title">Kontrollerar systemet...</div></div>;

  return (
    <div className="sys-tab-content">
      <div className="sys-hero-state">
        <div>
          <div className="sys-hero-title">{story.headline || data?.summarySv || 'Systemstatus är inte tillgänglig just nu.'}</div>
          <div className="sys-hero-sub">{story.subline || 'System visar driftläge, datakällor och säkerhet. Det startar inga tester eller order.'}</div>
        </div>
        <ConfigScopeBadge scope="global" />
        <StatusBadge tone={systemStatusTone(data?.overallStatus)}>{systemStatusLabel(data?.overallStatus)}</StatusBadge>
      </div>

      <div className="dash-grid-2">
        <ChartCard title="Komponentstatus" subtitle="Fördelning från befintlig systemhälsa" tone="purple">
          <BarChart bars={componentBars} emptyText="Systemkomponenter saknas ännu." />
        </ChartCard>
        <ChartCard title="Hälsoaktivitet" subtitle="Senaste lästa komponentstatusar" tone="warning">
          <ActivityList items={componentActivity} emptyText="Ingen komponentstatus finns ännu." />
        </ChartCard>
      </div>

      <div className="sys-metrics">
        <SystemMetric label="API" value={backendState} state={backendState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Data" value={dataState} state={dataState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Marknadsbevakning" value={scannerState} state={scannerState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Lärande" value={learningState} state={learningState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Datakällor" value={providerState} state={providerState === 'OK' ? 'ok' : 'bad'} />
        <SystemMetric label="Säkerhet" value={safetyState} state="ok" />
      </div>

      <div className="sys-hero-sub">Komponenter: {counts.total} totalt, {counts.ok} OK, {counts.stale} varningar, {counts.broken} fel.</div>
      <div className="sys-hero-sub" style={{ marginTop: 'var(--s2)' }}>{story.why || 'AI behöver mer information för att förklara läget bättre.'}</div>
      <div className="sys-hero-sub">{story.next || 'AI fortsätter att följa systemet.'}</div>

      <div className="sys-metrics">
        <SystemMetric label="Åtgärder tillåtna" value="Nej" state="ok" />
        <SystemMetric label="Kan skicka order" value="Nej" state="ok" />
        <SystemMetric label="Livehandel" value="Nej" state="ok" />
      </div>

      <div className="sys-link-grid">
        <Link to="/system?tab=health" className="sys-link-card">🩺 Systemhälsa</Link>
        <Link to="/system?tab=broker" className="sys-link-card">🏦 Broker</Link>
        <Link to="/system?tab=providers" className="sys-link-card">🔌 Datakällor</Link>
        <Link to="/system?tab=logs" className="sys-link-card">🔔 Loggar & larm</Link>
        <Link to="/system?tab=safety" className="sys-link-card">🛡️ Säkerhet</Link>
      </div>
    </div>
  );
}

function ProvidersTab() {
  const { data, loading } = useHealth();
  const feeds = data?.feeds || {};
  if (loading) return <div className="m-empty"><div className="m-empty-title">Hämtar datakällor...</div></div>;
  const rows = [
    { key: 'stocks', label: 'Aktier', feed: feeds.stocks },
    { key: 'crypto', label: 'Krypto', feed: feeds.crypto },
  ];

  return (
    <div className="sys-tab-content">
      <div className="sys-hero-sub">Datakällor visar var marknadsdata kommer ifrån och om flödet fungerar.</div>
      <div className="sys-provider-grid">
        {rows.map(row => (
          <div key={row.key} className="sys-provider-card">
            <div className="sys-provider-head">
              <strong>{row.label}</strong>
              <span>{uiFactorySafeText(row.feed?.provider || 'okänd källa')}</span>
            </div>
            <div>Status: {uiFactorySafeText(row.feed?.status || 'saknas')}</div>
            <div>Senaste data: {uiFactorySafeText(row.feed?.latestTimestamp || row.feed?.lastUpdated || 'väntar på data')}</div>
            <div>{uiFactorySafeText(row.feed?.messageSv || 'Ingen datakällevarning.')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BrokerTab() {
  return (
    <div className="sys-tab-content">
      <PlatformEmptyState
        title="Broker"
        text="Brokerstatus och kontokoppling finns samlat i Interactive Brokers-vyn."
        action={<Link className="sys-debug-link" to="/interactive-brokers">Öppna Broker</Link>}
      />
    </div>
  );
}

function DebugTab() {
  return (
    <div className="sys-tab-content">
      <PlatformEmptyState
        title="Avancerad felsökning är dold"
        text="Rådata och interna testverktyg ska bara öppnas vid felsökning. Systemet visar först hälsa, datakällor och säkerhet."
        action={<Link className="sys-debug-link" to="/system?tab=health">Öppna systemhälsa</Link>}
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
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'health';
  const active = TABS.some(t => t.key === tab) || HIDDEN_TAB_KEYS.has(tab) ? tab : 'health';

  function setTab(next) {
    setParams(next === 'health' ? {} : { tab: next });
  }

  return (
    <DashboardShell
      title="System"
      subtitle="Hälsa, broker, datakällor, säkerhet och loggar."
      safety={SAFETY_FLAGS}
      tabs={TABS.map((item) => ({ id: item.key, label: item.label }))}
      activeTab={active}
      onTab={setTab}
    >
    <div className="sys-page">
      <PlatformSafetyBar />
      <div style={{ marginBottom: 'var(--s5)' }}>
        <ContextNavigation
          compact
          actions={[
            contextAction('factory', {}, { primary: true }),
            contextAction('test'),
            contextAction('paper'),
          ]}
        />
      </div>

      {active === 'overview' && <OverviewTab />}
      {active === 'health' && <SystemHealthPage />}
      {active === 'broker' && <BrokerTab />}
      {active === 'providers' && <ProvidersTab />}
      {active === 'logs' && <AlertsPage />}
      {active === 'safety' && <SafetyOverviewTab />}
      {active === 'debug' && <DebugTab />}
    </div>
    </DashboardShell>
  );
}
