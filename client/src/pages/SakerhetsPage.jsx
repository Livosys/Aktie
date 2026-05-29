import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ConfigScopeBadge, PlatformSafetyBar } from '../components/PlatformControls.jsx';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

const TABS = [
  { key: 'risk',   label: 'Risk',    icon: '🛡️' },
  { key: 'exit',   label: 'Exits',    icon: '↘️' },
  { key: 'safety', label: 'Safety',   icon: '⛔' },
  { key: 'blockers', label: 'Blockers', icon: '🚦' },
  { key: 'discovery', label: 'Discovery Mode', icon: '◎' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function StatusChip({ ok, labelOk, labelBad }) {
  return (
    <span className={`sak-status-chip ${ok ? 'sak-ok' : 'sak-bad'}`}>
      {ok ? labelOk || 'Aktiv' : labelBad || 'Inaktiv'}
    </span>
  );
}

function MetricRow({ label, value, note }) {
  return (
    <div className="sak-metric-row">
      <span className="sak-metric-label">{label}</span>
      <span className="sak-metric-value">{value ?? '–'}</span>
      {note && <span className="sak-metric-note">{note}</span>}
    </div>
  );
}

function SafetyBanner() {
  return (
    <div className="sak-safety-banner">
      <span>🔒</span>
      <span className="sak-green">actions_allowed=false</span>
      <span className="sak-muted">· can_place_orders=false · live_trading_enabled=false</span>
    </div>
  );
}

function SectionCard({ title, icon, children, status }) {
  return (
    <div className="sak-section-card">
      <div className="sak-section-header">
        <div className="sak-section-title-row">
          <span className="sak-section-icon">{icon}</span>
          <span className="sak-section-title">{title}</span>
        </div>
        {status}
      </div>
      {children}
    </div>
  );
}

// ── Risk Tab ──────────────────────────────────────────────────────────────────
export function RiskTab() {
  const { global, meta } = useUnifiedConfig('safety');
  const status = global.riskStatus;
  const config = global.riskConfigResponse;
  const loading = meta.loading && !status && !config;

  if (loading) return <div className="sak-loading">Laddar riskmotor...</div>;

  const isActive = status?.enabled !== false;
  const cfg = config?.config || config || {};

  return (
    <div className="sak-tab-content">
      <SectionCard
        title="Riskmotor"
        icon="🛡️"
        status={<ConfigScopeBadge scope="global" />}
      >
        {status && (
          <div className="sak-metric-list">
            {status.killSwitchActive && (
              <div className="sak-kill-active">⚠️ Kill-switch är aktiverad — alla trades blockerade</div>
            )}
            <MetricRow label="Status" value={isActive ? 'Aktiv och övervakar' : 'Inaktiv'} />
            <MetricRow label="Scope" value="Globalt systemläge" note="Läses av scanner/riskmotor" />
            {status.totalEvaluations != null && <MetricRow label="Utvärderingar totalt" value={status.totalEvaluations} />}
            {status.blockedCount != null && <MetricRow label="Blockerade signals" value={status.blockedCount} />}
            {status.approvedCount != null && <MetricRow label="Godkända signals" value={status.approvedCount} />}
          </div>
        )}

        {Object.keys(cfg).length > 0 && (
          <>
            <div className="sak-subsection">Konfiguration</div>
            <div className="sak-config-grid">
              {cfg.maxRiskPerTrade != null && <MetricRow label="Max risk per trade" value={`${cfg.maxRiskPerTrade}%`} />}
              {cfg.maxDailyLoss != null && <MetricRow label="Max daglig förlust" value={`${cfg.maxDailyLoss}%`} />}
              {cfg.maxOpenPositions != null && <MetricRow label="Max öppna positioner" value={cfg.maxOpenPositions} />}
              {cfg.minConfidence != null && <MetricRow label="Min styrka" value={cfg.minConfidence} />}
            </div>
          </>
        )}
      </SectionCard>

      <div className="sak-nav">
        <Link to="/risk-engine" className="sak-nav-link">Avancerad riskmotor →</Link>
      </div>
    </div>
  );
}

// ── Exit Tab ──────────────────────────────────────────────────────────────────
export function ExitTab() {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/exit/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/exit/config').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/exit/calibration/recent').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, c, cal]) => {
      setStatus(s);
      setConfig(c);
      setCalibration(cal);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="sak-loading">Laddar exitmotor...</div>;

  const isActive = status?.enabled !== false;
  const cfg = config?.config || config || {};

  return (
    <div className="sak-tab-content">
      <SectionCard
        title="Exitmotor"
        icon="↘️"
        status={<StatusChip ok={isActive} />}
      >
        {status && (
          <div className="sak-metric-list">
            <MetricRow label="Status" value={isActive ? 'Aktiv' : 'Inaktiv'} />
            {status.totalExits != null && <MetricRow label="Exits totalt" value={status.totalExits} />}
            {status.avgHoldTime != null && <MetricRow label="Snitt hålltid" value={`${Math.round(status.avgHoldTime / 60)} min`} />}
          </div>
        )}

        {Object.keys(cfg).length > 0 && (
          <>
            <div className="sak-subsection">Konfiguration</div>
            <div className="sak-config-grid">
              {cfg.stopLoss != null && <MetricRow label="Stop Loss" value={`${cfg.stopLoss}%`} />}
              {cfg.takeProfit != null && <MetricRow label="Take Profit" value={`${cfg.takeProfit}R`} />}
              {cfg.maxHoldTime != null && <MetricRow label="Max hålltid" value={`${Math.round(cfg.maxHoldTime / 60)} min`} />}
              {cfg.trailingStop != null && <MetricRow label="Trailing Stop" value={cfg.trailingStop ? 'På' : 'Av'} />}
            </div>
          </>
        )}

        {calibration && (
          <>
            <div className="sak-subsection">Kalibrering (senaste)</div>
            <div className="sak-config-grid">
              {calibration.avgExitPnl != null && (
                <MetricRow
                  label="Snitt exit P/L"
                  value={`${calibration.avgExitPnl >= 0 ? '+' : ''}${calibration.avgExitPnl?.toFixed(2)}%`}
                />
              )}
              {calibration.winRate != null && (
                <MetricRow label="Exit träffsäkerhet" value={`${Math.round(calibration.winRate * 100)}%`} />
              )}
            </div>
          </>
        )}
      </SectionCard>

      <div className="sak-nav">
        <Link to="/exit-engine" className="sak-nav-link">Avancerad exitmotor →</Link>
        <Link to="/lab?tab=exits" className="sak-nav-link">Testa exits i LAB →</Link>
      </div>
    </div>
  );
}

// ── Safety Tab ────────────────────────────────────────────────────────────────
export function SafetyTab() {
  const { global, meta } = useUnifiedConfig('safety');
  const [msg, setMsg] = useState(null);
  const status = global.safetyStatus;
  const config = global.safetyConfigResponse;
  const loading = meta.loading && !status && !config;

  if (loading) return <div className="sak-loading">Laddar säkerhetsmotor...</div>;

  const isArmed = status?.armed === true;
  const killActive = status?.killSwitchActive === true;
  const cfg = config?.config || config || {};

  return (
    <div className="sak-tab-content">
      <div className="sak-absolute-safe">
        <span>🔒</span>
        <div>
          <div className="sak-abs-title">Absolut säkerhet</div>
          <div className="sak-abs-sub">
            actions_allowed=false · can_place_orders=false · live_trading_enabled=false
            <br/>Ingen riktig handel kan ske oavsett konfiguration.
          </div>
        </div>
      </div>

      <SectionCard
        title="Säkerhetsmotor"
        icon="⛔"
        status={<ConfigScopeBadge scope="safety" />}
      >
        {killActive && (
          <div className="sak-kill-active">🚨 Kill-switch AKTIVERAD — alla trades blockerade globalt</div>
        )}

        {status && (
          <div className="sak-metric-list">
            <MetricRow label="Motor" value={isArmed ? 'Aktiverad' : 'Avaktiverad'} />
            <MetricRow label="UI-läge" value="Read-only" note="Kan inte stängas av från frontend" />
            <MetricRow label="Kill-switch" value={killActive ? 'AKTIV' : 'Inaktiv'} note={killActive ? 'Alla trades blockerade' : undefined} />
            {status.blockCount != null && <MetricRow label="Blockerade lägen" value={status.blockCount} />}
            {status.lastCheck && (
              <MetricRow
                label="Senaste kontroll"
                value={new Date(status.lastCheck).toLocaleTimeString('sv-SE')}
              />
            )}
          </div>
        )}

        {Object.keys(cfg).length > 0 && (
          <>
            <div className="sak-subsection">Konfiguration</div>
            <div className="sak-config-grid">
              {cfg.maxDailyLoss != null && <MetricRow label="Max daglig förlust" value={`${cfg.maxDailyLoss}%`} />}
              {cfg.maxConsecutiveLosses != null && <MetricRow label="Max förluster i rad" value={cfg.maxConsecutiveLosses} />}
              {cfg.cooldownAfterLoss != null && <MetricRow label="Paus efter förlust" value={`${cfg.cooldownAfterLoss} min`} />}
            </div>
          </>
        )}
      </SectionCard>

      {msg && <div className="sak-msg">{msg}</div>}

      <div className="sak-nav">
        <Link to="/system?tab=safety" className="sak-nav-link">Avancerad säkerhetsmotor →</Link>
      </div>
    </div>
  );
}

export function BlockersTab() {
  const { global, meta } = useUnifiedConfig('safety');
  const config = global.blockerConfig;
  const loading = meta.loading && !config;

  if (loading) return <div className="sak-loading">Laddar blockers...</div>;
  const blockers = Array.isArray(config?.blockers)
    ? config.blockers
    : (config?.configurableBlockers || []).map((b) => ({
        ...b,
        mode: config?.blockers?.[b.key] || 'block',
      }));
  const hardBlockers = config?.alwaysHardBlockers || [];

  return (
    <div className="sak-tab-content">
      <SectionCard title="Blockers" icon="🚦" status={<ConfigScopeBadge scope="global" />}>
        {hardBlockers.length > 0 && (
          <div className="sak-metric-list">
            {hardBlockers.map((b) => (
              <MetricRow key={b.key} label={b.label || b.key} value="Alltid hård blocker" note={b.reason} />
            ))}
          </div>
        )}
        {blockers.length === 0 ? (
          <div className="sak-metric-row"><span className="sak-metric-label">Status</span><span className="sak-metric-value">Hårda blockers hanteras av risk- och säkerhetsmotor</span></div>
        ) : (
          <div className="sak-metric-list">
            {blockers.map((b, i) => (
              <MetricRow
                key={b.key || i}
                label={b.labelSv || b.label || b.key}
                value={b.hard || b.mode === 'block' ? 'Hård blocker' : 'Varning'}
                note={b.enabled === false ? 'Av i testläge' : undefined}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

export function DiscoveryTab() {
  return (
    <div className="sak-tab-content">
      <SectionCard title="Discovery Mode" icon="◎" status={<StatusChip ok labelOk="Analys only" />}>
        <div className="sak-metric-list">
          <MetricRow label="Syfte" value="Visa fler kandidater utan att skapa order" />
          <MetricRow label="Orderrättighet" value="can_place_orders=false" />
          <MetricRow label="Livehandel" value="live_trading_enabled=false" />
          <MetricRow label="Adaptive systems" value="Påverkar bara score och ranking" />
        </div>
      </SectionCard>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SakerhetsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') || 'risk';
  const tab = TABS.some(t => t.key === requested) ? requested : 'risk';

  function changeTab(next) {
    setParams(next === 'risk' ? {} : { tab: next });
  }

  return (
    <div className="sak-page">
      <PlatformSafetyBar />

      <div className="sak-page-header">
        <h1 className="sak-page-title">🛡️ Säkerhet</h1>
        <p className="sak-page-sub">
          Riskmotor, exitmotor och säkerhetsmotor i ett centrum.
          Inga riktiga orders kan skapas — detta är alltid aktivt.
        </p>
      </div>

      <div className="sak-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`sak-tab${tab === t.key ? ' sak-tab-active' : ''}`}
            onClick={() => changeTab(t.key)}
            type="button"
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'risk'   && <RiskTab />}
      {tab === 'exit'   && <ExitTab />}
      {tab === 'safety' && <SafetyTab />}
      {tab === 'blockers' && <BlockersTab />}
      {tab === 'discovery' && <DiscoveryTab />}
    </div>
  );
}
