import React, { useEffect, useMemo, useState } from 'react';
import { SectionHeader, fmtTime } from '../shared.jsx';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
const SEVERITY_LABELS = { critical: 'Kritisk', warning: 'Varning', info: 'Info' };

function normalizeSeverity(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical' || s === 'critical'.toUpperCase().toLowerCase()) return 'critical';
  if (s === 'high' || s === 'warning' || s === 'watch') return 'warning';
  return 'info';
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'resolved') return 'resolved';
  if (s === 'acknowledged') return 'acknowledged';
  return 'active';
}

function deliveryBadge(delivery) {
  if (!delivery) return { label: 'Okänd', cls: 'notif-skip' };
  if (delivery.dry_run) return { label: 'Dry-run', cls: 'notif-dryrun' };
  if (delivery.ok) {
    if (delivery.fallback) return { label: 'Fallback logg', cls: 'notif-fallback' };
    return { label: 'Skickad', cls: 'notif-ok' };
  }
  const REASON_LABELS = {
    replay_mode_blocked: 'Blockerad (replay)',
    quiet_hours: 'Tyst tid',
    rate_limited: 'Rate-limited',
    duplicate_alert_blocked: 'Duplikat',
    notification_v2_disabled: 'Inaktiv',
    test_rate_limited: 'Test-gräns',
    missing_confirm_live_send: 'Ej bekräftad',
  };
  return { label: REASON_LABELS[delivery.reason] || 'Blockerad', cls: 'notif-skip' };
}

function friendlyType(type) {
  return String(type || 'Larm')
    .replaceAll('_', ' ')
    .replace('FAKEOUT', 'Risk för falsk rörelse')
    .replace('WATCH MODE', 'Bevaka')
    .replace('SYSTEM', 'System')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function severityClass(severity) {
  const sev = normalizeSeverity(severity);
  if (sev === 'critical') return 'al-critical';
  if (sev === 'warning') return 'al-high';
  return 'al-info';
}

function sortAlerts(rows) {
  return [...(rows || [])].sort((a, b) => {
    const s = (SEVERITY_ORDER[normalizeSeverity(a.severity)] ?? 9) - (SEVERITY_ORDER[normalizeSeverity(b.severity)] ?? 9);
    if (s !== 0) return s;
    return new Date(b.updatedAt || b.lastSeenAt || b.createdAt) - new Date(a.updatedAt || a.lastSeenAt || a.createdAt);
  });
}

function useAlertEvents() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function fetchAlerts() {
    try {
      const [alertsRes, notificationsRes] = await Promise.all([
        fetch('/api/alerts'),
        fetch('/api/notifications/recent?limit=12'),
      ]);
      const [alertsJson, notificationsJson] = await Promise.all([
        alertsRes.json(),
        notificationsRes.json().catch(() => null),
      ]);
      if (!alertsRes.ok) throw new Error(alertsJson.error || `API ${alertsRes.status}`);
      setData({ ...alertsJson, notifications: notificationsRes.ok ? notificationsJson : null });
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAlerts();
    const t = setInterval(fetchAlerts, 30000);
    return () => clearInterval(t);
  }, []);

  return { data, loading, error, refresh: fetchAlerts };
}

function AlertCard({ alert, onAck }) {
  const severity = normalizeSeverity(alert.severity);
  const status = normalizeStatus(alert.status);
  const cls = severityClass(severity);
  const [showTech, setShowTech] = useState(false);
  const seenAt = alert.lastSeenAt || alert.updatedAt || alert.createdAt;

  return (
    <div className={`al-card ${cls} ${status === 'resolved' ? 'al-resolved' : ''}`}>
      <div className="al-card-top">
        <div>
          <div className="al-title">{alert.titleSv}</div>
          <div className="al-meta">
            <span>{friendlyType(alert.type)}</span>
            {alert.symbol && <span>{alert.symbol}</span>}
            <span>Senast: {fmtTime(seenAt)}</span>
            {(alert.count || 1) > 1 && <span>{alert.count} ggr</span>}
          </div>
        </div>
        <span className={`al-severity ${cls}`}>{status === 'resolved' ? 'Löst' : SEVERITY_LABELS[severity]}</span>
      </div>
      <div className="al-message">{alert.messageSv}</div>
      {alert.suggestedActionSv && status !== 'resolved' && (
        <div className="al-action">Åtgärd: {alert.suggestedActionSv}</div>
      )}
      <div className="al-card-actions">
        <button className="btn al-ack-btn" onClick={() => setShowTech(v => !v)}>
          {showTech ? 'Dölj teknisk detalj' : 'Visa teknisk detalj'}
        </button>
        {status === 'active' && (
          <button className="btn al-ack-btn" onClick={() => onAck(alert.id)}>Kvittera</button>
        )}
      </div>
      {showTech && (
        <div className="ux-tech-box">
          Källa: {alert.source || '-'} · Key: {alert.key || '-'} · ID: {alert.id || '-'}
        </div>
      )}
    </div>
  );
}

function AlertSection({ icon, title, desc, alerts, emptyText, onAck }) {
  return (
    <div className="sec al-section">
      <SectionHeader icon={icon} title={title} count={alerts.length} desc={desc} />
      {alerts.length === 0 ? (
        <div className="al-empty">{emptyText}</div>
      ) : (
        <div className="al-list">
          {alerts.map((a) => <AlertCard key={a.id || a.key} alert={a} onAck={onAck} />)}
        </div>
      )}
    </div>
  );
}

function NotificationV2Panel({ data }) {
  const recent = data?.recent || [];
  const status = data?.status || {};
  return (
    <div className="sec al-section">
      <SectionHeader
        icon="N"
        title="Notification Engine v2"
        count={recent.length}
        desc="Senaste skickade, fallback-loggade och blockerade notifieringar."
      />
      <div className="notif-v2-status">
        <div><span>Status</span><strong>{status.enabled ? 'Aktiv' : 'Av'}</strong></div>
        <div><span>Kanal</span><strong>{status.configured ? status.provider : 'Fallback logg'}</strong></div>
        <div><span>Quiet hours</span><strong>{status.quiet_hours_active ? 'Aktiva' : 'Inaktiva'}</strong></div>
        <div><span>Redis</span><strong>{status.redis?.mode || '-'}</strong></div>
      </div>
      {recent.length === 0 ? (
        <div className="al-empty">Inga Notification v2-events ännu.</div>
      ) : (
        <div className="notif-v2-list">
          {recent.map((item) => {
            const badge = deliveryBadge(item.delivery);
            return (
              <div key={item.id || `${item.type}_${item.createdAt}`} className="notif-v2-row">
                <div>
                  <strong>{item.titleSv || item.type}</strong>
                  <span>{friendlyType(item.type)} · {fmtTime(item.createdAt)} · {item.delivery?.provider || item.delivery?.reason || 'ok'}</span>
                </div>
                <em className={badge.cls}>{badge.label}</em>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AlertsPage() {
  const { data, loading, error, refresh } = useAlertEvents();
  const [acking, setAcking] = useState(false);

  const activeAlerts = useMemo(() => sortAlerts(data?.alerts).filter((a) => normalizeStatus(a.status) === 'active'), [data]);
  const resolvedLast24h = useMemo(() => sortAlerts(data?.resolvedLast24h), [data]);
  const critical = activeAlerts.filter((a) => normalizeSeverity(a.severity) === 'critical');
  const warnings = activeAlerts.filter((a) => normalizeSeverity(a.severity) === 'warning');
  const infos = activeAlerts.filter((a) => normalizeSeverity(a.severity) === 'info');
  const health = data?.systemHealth || null;
  const systemOk = health?.ok === true || health?.overallStatus === 'HEALTHY';
  const hasHistoryOnly = systemOk && (data?.historyCount || 0) > activeAlerts.length && critical.length === 0 && warnings.length === 0;
  const marketClosed = health?.stockFeed?.status === 'MARKET_CLOSED';

  async function acknowledge(id) {
    setAcking(true);
    try {
      await fetch('/api/alerts/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await refresh();
    } finally {
      setAcking(false);
    }
  }

  async function acknowledgeAll() {
    const ids = activeAlerts.map((a) => a.id);
    if (!ids.length) return;
    setAcking(true);
    try {
      await fetch('/api/alerts/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      await refresh();
    } finally {
      setAcking(false);
    }
  }

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-orange">Larm</div>
          <div className="hero-sub">Aktuella systemlarm med SystemHealth som primär sanningskälla.</div>
        </div>
        <div className="status-bar-v2">
          <span className="status-pill">Aktiva: {activeAlerts.length}</span>
          <span className="status-pill" style={{ color: critical.length ? 'var(--red)' : 'var(--green)' }}>Kritiska: {critical.length}</span>
          <button className="btn" onClick={refresh}>Uppdatera</button>
        </div>
      </div>

      {error && <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)' }}>Kunde inte hämta larm. Försök igen strax.<details className="ux-technical"><summary>Visa teknisk detalj</summary>{error}</details></div>}
      {loading && <div className="empty"><span className="spinner" /> Hämtar larm...</div>}

      {!loading && marketClosed && (
        <div className="market-banner">
          Marknaden är stängd — senaste handelspass används.
        </div>
      )}

      {!loading && hasHistoryOnly && (
        <div className="sh-alert-banner al-history-ok">
          Gamla larm finns i historiken, men systemet är friskt just nu.
        </div>
      )}

      {!loading && activeAlerts.length > 0 && (
        <div className="al-toolbar">
          <button className="btn" onClick={acknowledgeAll} disabled={acking}>Kvittera aktiva</button>
        </div>
      )}

      {!loading && (
        <>
          <NotificationV2Panel data={data?.notifications} />
          <AlertSection
            icon="!"
            title="Aktiva kritiska larm"
            count={critical.length}
            desc="Endast aktuella kritiska problem visas här."
            alerts={critical}
            emptyText="Inga aktiva kritiska larm."
            onAck={acknowledge}
          />
          <AlertSection
            icon="?"
            title="Varningar"
            desc="Risk- och datahändelser som inte är kritiska systemfel."
            alerts={warnings}
            emptyText="Inga aktiva varningar."
            onAck={acknowledge}
          />
          {infos.length > 0 && (
            <AlertSection
              icon="i"
              title="Info"
              desc="Aktuell driftinformation som inte är ett fel."
              alerts={infos}
              emptyText="Ingen info."
              onAck={acknowledge}
            />
          )}
          <AlertSection
            icon="✓"
            title="Lösta senaste 24h"
            desc="Problem som auto-resolve markerade som lösta mot SystemHealth."
            alerts={resolvedLast24h}
            emptyText="Inga lösta larm senaste 24h."
            onAck={acknowledge}
          />
        </>
      )}
    </div>
  );
}
