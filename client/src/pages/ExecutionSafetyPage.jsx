import React, { useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../shared.jsx';

// Legacy/orphaned page. Canonical safety route lives at /system?tab=safety.
const REFRESH_MS = 15000;

function boolText(value) {
  return value ? 'Ja' : 'Nej';
}

function fmtTime(iso) {
  if (!iso) return '-';
  return `${String(iso).slice(0, 10)} ${String(iso).slice(11, 16)}`;
}

function Metric({ label, value, sub, tone }) {
  return (
    <div className={`safety-metric ${tone ? `safety-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function ListPanel({ title, items, empty }) {
  return (
    <div className="safety-panel">
      <SectionHeader icon="!" title={title} />
      <div className="safety-chip-list">
        {items?.length ? items.map((item) => <span className="safety-chip" key={item}>{item}</span>) : <div className="empty">{empty}</div>}
      </div>
    </div>
  );
}

async function api(path, options) {
  const res = await fetch(path, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `API ${res.status}`);
  return json;
}

export default function ExecutionSafetyPage() {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [replaySafety, setReplaySafety] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [statusJson, configJson, sessionsJson] = await Promise.all([
        api('/api/safety/status'),
        api('/api/safety/config'),
        api('/api/replay/sessions'),
      ]);
      setStatus(statusJson);
      setConfig(configJson.config);
      const latestWithSafety = (sessionsJson.sessions || []).find((s) => s.summary?.execution_safety);
      setReplaySafety(latestWithSafety?.summary?.execution_safety || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function action(path, body = {}, confirmText = null) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const latest = status?.last_evaluation;
  const recent = useMemo(() => (status?.recent_events || []).slice(0, 20), [status]);
  const data = latest?.data_freshness || {};
  const system = latest?.system_health || status?.health_snapshot?.process || {};
  const currentSafetyLevel = status?.kill_switch_active
    ? 'kill_switch'
    : config?.live_trading_enabled === false || config?.require_manual_arming
      ? 'block'
      : (latest?.safety_level === 'kill_switch' ? 'block' : latest?.safety_level || status?.status?.safety_level || 'safe');
  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-blue">Säkerhetsmotor</div>
          <div className="hero-sub">Execution Safety v1 blockerar, pausar och varnar före paper entry och live-readiness. Riktig handel är avstängd.</div>
        </div>
        <button className="btn" onClick={refresh}>Uppdatera</button>
      </div>

      <div className="safety-live-off">Riktig handel avstängd</div>
      {error && <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>{error}</div>}

      <div className="safety-status-strip">
        <Metric label="Safety status" value={currentSafetyLevel} />
        <Metric label="Live trading enabled" value={boolText(false)} tone="danger" />
        <Metric label="Manuell armering" value={boolText(status?.manual_armed || config?.manual_armed)} />
        <Metric label="Nödstopp" value={boolText(status?.kill_switch_active || config?.kill_switch_active)} tone={status?.kill_switch_active ? 'danger' : ''} />
        <Metric label="Redis mode" value={status?.redis?.mode || '-'} />
      </div>

      <div className="safety-actions">
        <button className="btn" disabled={busy} onClick={() => action('/api/safety/manual-arm', { reason: 'UI manual arm' })}>Manual arm</button>
        <button className="btn" disabled={busy} onClick={() => action('/api/safety/manual-disarm', { reason: 'UI manual disarm' })}>Manual disarm</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => action('/api/safety/kill-switch', { reason: 'UI nödstopp' }, 'Aktivera nödstopp? Nya entries blockeras.')}>Trigger kill switch</button>
        <button className="btn" disabled={busy} onClick={() => action('/api/safety/kill-switch/clear', { reason: 'UI clear nödstopp', confirm: true }, 'Rensa nödstopp? Detta aktiverar inte riktig handel.')}>Clear kill switch</button>
      </div>

      <div className="safety-grid">
        <div className="safety-panel">
          <SectionHeader icon="S" title="Senaste evaluation" desc="Senaste safety:last_evaluation." />
          {latest ? (
            <>
              <div className="safety-decision-head">
                <div><strong>{latest.symbol || 'SYSTEM'}</strong><span>{fmtTime(latest.timestamp)} · {latest.context_source || '-'}</span></div>
                <span className={`safety-level safety-level-${latest.safety_level}`}>{latest.safety_level}</span>
              </div>
              <div className="exit-metric-grid">
                <Metric label="Live allowed" value={boolText(latest.live_execution_allowed)} />
                <Metric label="Paper allowed" value={boolText(latest.paper_execution_allowed)} />
                <Metric label="Manual action" value={latest.manual_action || '-'} />
                <Metric label="Kill switch" value={boolText(latest.kill_switch_active)} />
              </div>
            </>
          ) : <div className="empty">Ingen safety evaluation ännu.</div>}
        </div>

        <div className="safety-panel">
          <SectionHeader icon="D" title="Datakvalitet" />
          <div className="exit-metric-grid">
            <Metric label="Prisålder" value={data.price_age_seconds ?? '-'} sub="sekunder" />
            <Metric label="Candleålder" value={data.candle_age_seconds ?? '-'} sub="sekunder" />
            <Metric label="Scanålder" value={data.scan_age_seconds ?? '-'} sub="sekunder" />
            <Metric label="Provider" value={data.provider_status || '-'} />
          </div>
        </div>

        <div className="safety-panel">
          <SectionHeader icon="H" title="Systemhälsa" />
          <div className="exit-metric-grid">
            <Metric label="Memory" value={system.memory_mb ?? status?.health_snapshot?.process?.memory_mb ?? '-'} sub="MB" />
            <Metric label="PM2 restarts" value={system.pm2_restarts_1h ?? '-'} />
            <Metric label="API error storm" value={(system.api_errors_5m ?? 0) > (config?.max_api_errors_5m ?? 20) ? 'Ja' : 'Nej'} />
            <Metric label="Notification" value={system.notification_status || '-'} />
          </div>
        </div>

        <ListPanel title="Blockeringsorsaker" items={latest?.block_reasons || []} empty="Inga live-blockeringar utöver standardstatus." />
        <ListPanel title="Warnings" items={latest?.warnings || []} empty="Inga warnings." />
        <div className="safety-panel">
          <SectionHeader icon="R" title="Replay safety" desc="Visas i Replay Intelligence v2 summary när Execution Safety är på." />
          <div className="exit-metric-grid">
            <Metric label="Safety blocks" value={replaySafety?.safety_blocks ?? 0} />
            <Metric label="Entries prevented" value={replaySafety?.entries_prevented ?? 0} />
            <Metric label="Stale data blocks" value={replaySafety?.stale_data_blocks ?? 0} />
          </div>
        </div>
      </div>

      <div className="safety-panel">
        <SectionHeader icon="E" title="Senaste events" count={recent.length} />
        <div className="exit-decision-list">
          {recent.length ? recent.map((event, index) => (
            <div className="exit-row" key={`${event.timestamp}-${event.type}-${index}`}>
              <div><strong>{event.type}</strong><span>{fmtTime(event.timestamp)} · {event.symbol || 'SYSTEM'}</span></div>
              <p>{event.reason || (event.block_reasons || []).join(', ') || '-'}</p>
            </div>
          )) : <div className="empty">Inga safety events ännu.</div>}
        </div>
      </div>
    </div>
  );
}
