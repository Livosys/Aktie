import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

const REFRESH_MS = 15_000;
const FETCH_TIMEOUT_MS = 6_500;

async function fetchJsonWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`timeout_after_${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function usePaperRuntime(limit = 50) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
  });

  useEffect(() => {
    let alive = true;
    let activeController = null;
    const load = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      fetchJsonWithTimeout(`/api/paper-trading/runtime?limit=${encodeURIComponent(limit)}`, {
        signal: activeController.signal,
      })
        .then((data) => {
          if (!alive) return;
          setState({ loading: false, error: null, data });
        })
        .catch((err) => {
          if (!alive) return;
          setState((prev) => ({
            loading: false,
            error: err?.message || 'paper_runtime_unavailable',
            data: prev.data || null,
          }));
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
      if (activeController) activeController.abort();
    };
  }, [limit]);

  return state;
}

function fmtTime(value) {
  if (!value) return '–';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '–';
  return date.toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtPct(value) {
  if (value == null || Number.isNaN(Number(value))) return '–';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function toneForResult(result) {
  const key = String(result || '').toUpperCase();
  if (key === 'WIN') return '#22c55e';
  if (key === 'LOSS') return '#ef4444';
  if (key === 'OPEN') return '#38bdf8';
  if (key === 'TIMEOUT') return '#f59e0b';
  return '#94a3b8';
}

function cellStyle() {
  return {
    padding: '10px 12px',
    borderBottom: '1px solid var(--border)',
    fontSize: 12,
    verticalAlign: 'top',
  };
}

function sectionStyle() {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 18,
    marginBottom: 18,
  };
}

function SafetyBanner({ safety }) {
  return (
    <div style={{
      ...sectionStyle(),
      display: 'flex',
      flexWrap: 'wrap',
      gap: 10,
      alignItems: 'center',
      background: 'rgba(15, 23, 42, 0.8)',
    }}>
      <strong style={{ color: '#22c55e' }}>Endast låtsashandel</strong>
      <span>Inga riktiga order</span>
      <span>Broker avstängd</span>
      <span>Live trading avstängd</span>
      <span>actions_allowed={String(safety?.actions_allowed === true)}</span>
      <span>can_place_orders={String(safety?.can_place_orders === true)}</span>
    </div>
  );
}

function SummaryGrid({ runtime }) {
  const summary = runtime?.summary || {};
  const shown = summary.returnedCount ?? 0;
  const limit = summary.limit ?? 50;
  return (
    <div style={sectionStyle()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Paper trading runtime</h2>
          <div style={{ color: '#94a3b8', marginTop: 4 }}>Verkliga paper-only records från runtime-filerna.</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link to="/live">Till Signalpuls</Link>
          <Link to="/supervisor">Till Supervisor</Link>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {[
          ['Open', summary.openCount ?? 0],
          ['Closed', summary.closedCount ?? 0],
          ['Events', summary.eventCount ?? 0],
          ['Blocked', summary.blockedCount ?? 0],
        ].map(([label, value]) => (
          <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2, #1e2740)' }}>
            <div style={{ color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 12, color: '#cbd5e1', fontSize: 13 }}>
        <strong>Visar senaste {shown}/{limit} paper records</strong>
        <span>Senaste event: {fmtTime(summary.latestEventAt)}</span>
        <span>mode=paper_only</span>
      </div>
      {shown < limit && (
        <div style={{ marginTop: 10, color: '#94a3b8', fontSize: 13 }}>
          Visar senaste {shown}/{limit} paper records. Systemet har inte skapat {limit} ännu.
        </div>
      )}
    </div>
  );
}

function DataTable({ title, subtitle, columns, rows, emptyText, rowKey }) {
  return (
    <div style={sectionStyle()}>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
        {subtitle && <div style={{ color: '#94a3b8', marginTop: 4, fontSize: 13 }}>{subtitle}</div>}
      </div>
      {rows.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} style={{ ...cellStyle(), color: '#94a3b8', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={rowKey(row, index)}>
                  {columns.map((column) => (
                    <td key={column.key} style={cellStyle()}>
                      {column.render ? column.render(row) : row[column.key] ?? '–'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ color: '#94a3b8', fontSize: 13 }}>{emptyText}</div>
      )}
    </div>
  );
}

function usePaperAllowlist() {
  const [state, setState] = useState({ loading: true, data: null });
  useEffect(() => {
    let alive = true;
    fetchJsonWithTimeout('/api/automation/paper-allowlist/status')
      .then((data) => { if (alive) setState({ loading: false, data }); })
      .catch(() => { if (alive) setState({ loading: false, data: null }); });
    return () => { alive = false; };
  }, []);
  return state;
}

function mostCommonReason(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = row?.blockedReason || row?.reasonSv || row?.reason;
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) { best = reason; bestCount = count; }
  }
  return best ? { reason: best, count: bestCount } : null;
}

function MetricCard({ label, value, tone = 'neutral', note }) {
  const colors = { good: '#22c55e', warn: '#f59e0b', bad: '#ef4444', neutral: '#94a3b8' };
  return (
    <div style={{ flex: '1 1 160px', minWidth: 160, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94a3b8' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: colors[tone] || colors.neutral, marginTop: 2 }}>{value}</div>
      {note ? <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, lineHeight: 1.4 }}>{note}</div> : null}
    </div>
  );
}

function WhyNoTradesPanel({ runtime, allowlist }) {
  const summary = runtime?.summary || {};
  const open = Number(summary.openCount) || 0;
  const closed = Number(summary.closedCount) || 0;
  const blocked = Number(summary.blockedCount) || 0;
  const blockedCandidates = Array.isArray(runtime?.blockedCandidates) ? runtime.blockedCandidates : [];
  const approved = allowlist?.totalApproved;
  const ready = allowlist?.readyForPaperRuntime;
  const runtimeActive = runtime?.safety?.mode === 'paper_only' || runtime?.status === 'ok';
  const topReason = mostCommonReason(blockedCandidates);
  const reasonIsAllowlist = !!(topReason && /allowlist/i.test(topReason.reason));

  let conclusion;
  if (open > 0) {
    conclusion = `Det finns ${open} öppna paper trades just nu.`;
  } else if (closed > 0) {
    conclusion = `Inga öppna paper trades just nu, men ${closed} stängda finns i historiken.`;
  } else if (blocked > 0 && reasonIsAllowlist) {
    conclusion = 'Systemet ser signaler, men de stoppas innan en paper trade skapas eftersom de kommer från strategier som inte är godkända i allowlist. Endast de godkända strategierna får skapa låtsasaffärer.';
  } else if (blocked > 0) {
    conclusion = 'Systemet ser signaler, men de stoppas innan en paper trade skapas av testregler, status (Vänta / Jaga inte) eller saknad mappning. De allowlist-godkända strategierna har inte gett en signal som passerat reglerna.';
  } else {
    conclusion = 'Inga paper-events ännu i det här fönstret. Systemet är i testläge och väntar på signaler.';
  }

  return (
    <div style={sectionStyle()}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Varför finns inga paper trades?</div>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>Read-only diagnos. Inga riktiga order, inga actions härifrån.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <MetricCard label="Runtime" value={runtimeActive ? 'Aktiv' : 'Avvaktar'} tone={runtimeActive ? 'good' : 'warn'} note="paper_only, read-only" />
        <MetricCard label="Öppna trades" value={open} tone="neutral" />
        <MetricCard label="Stängda trades" value={closed} tone="neutral" />
        <MetricCard label="Blockerade events" value={blocked} tone={blocked > 0 ? 'warn' : 'neutral'} />
        <MetricCard label="Godkända strategier" value={approved == null ? '–' : approved} tone="neutral" note={ready == null ? null : `${ready} redo för runtime`} />
        <MetricCard label="Senaste event" value={fmtTime(summary.latestEventAt)} tone="neutral" />
        <MetricCard label="Vanligaste orsak" value={topReason ? `${topReason.count}×` : '–'} tone={blocked > 0 ? 'warn' : 'neutral'} note={topReason ? topReason.reason : 'Ingen blockering i fönstret'} />
      </div>
      <div style={{ ...sectionStyle(), marginTop: 12, marginBottom: 0, background: 'rgba(15,23,42,0.55)' }}>
        <strong>Slutsats:</strong> {conclusion}
      </div>
    </div>
  );
}

export default function PaperTradingPage() {
  const runtimeState = usePaperRuntime(50);
  const allowlistState = usePaperAllowlist();
  const runtime = runtimeState.data;
  const summary = runtime?.summary || {};
  const warnings = useMemo(() => {
    const list = [];
    if (runtimeState.error) list.push(`Paper runtime tillfälligt otillgängligt: ${runtimeState.error}`);
    if (runtime?.status === 'degraded') list.push(`Degraded read-only data: ${(runtime.warnings || []).join(', ') || 'okänd källa'}`);
    return list;
  }, [runtimeState.error, runtime]);

  const openTrades = runtime?.openTrades || [];
  const closedTrades = runtime?.closedTrades || [];
  const blockedCandidates = runtime?.blockedCandidates || [];
  const recentEvents = runtime?.recentEvents || [];
  const strategies = runtime?.strategies || [];

  return (
    <div className="page-wrap">
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title">Paper trading</div>
          <div className="hero-sub">Read-only runtimevy för paper-only-systemet.</div>
        </div>
      </div>

      <SafetyBanner safety={runtime?.safety || runtime} />

      <WhyNoTradesPanel runtime={runtime} allowlist={allowlistState.data} />

      {runtimeState.loading && !runtime ? (
        <div style={sectionStyle()}>Hämtar paper runtime...</div>
      ) : null}

      {warnings.length ? (
        <div style={{ ...sectionStyle(), borderColor: 'rgba(245, 158, 11, 0.45)' }}>
          {warnings.map((warning) => (
            <div key={warning} style={{ color: '#fbbf24', marginBottom: 6 }}>{warning}</div>
          ))}
        </div>
      ) : null}

      <SummaryGrid runtime={runtime} />

      <DataTable
        title="Open paper trades"
        subtitle="Aktiva paper-only positioner från state.json"
        rows={openTrades}
        emptyText="Inga öppna paper trades just nu."
        rowKey={(row, index) => row.tradeId || `${row.symbol}-${index}`}
        columns={[
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'setup', label: 'Setup' },
          { key: 'direction', label: 'Direction' },
          { key: 'source', label: 'Source' },
          { key: 'opened_at', label: 'Opened', render: (row) => fmtTime(row.opened_at) },
          { key: 'paperOnly', label: 'paperOnly', render: (row) => String(row.paperOnly === true) },
        ]}
      />

      <DataTable
        title="Closed paper trades"
        subtitle={`Senaste closed trades. Total closed i runtime: ${summary.closedCount ?? 0}`}
        rows={closedTrades}
        emptyText="Inga stängda paper trades ännu."
        rowKey={(row, index) => row.tradeId || `${row.symbol}-${index}`}
        columns={[
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'setup', label: 'Setup' },
          { key: 'result', label: 'Result', render: (row) => <span style={{ color: toneForResult(row.result), fontWeight: 700 }}>{row.result || '–'}</span> },
          { key: 'pnlPct', label: 'PnL %', render: (row) => <span style={{ color: toneForResult(row.result) }}>{fmtPct(row.pnlPct)}</span> },
          { key: 'opened_at', label: 'Opened', render: (row) => fmtTime(row.opened_at) },
          { key: 'closed_at', label: 'Closed', render: (row) => fmtTime(row.closed_at) },
          { key: 'source', label: 'Source' },
          { key: 'paperOnly', label: 'paperOnly', render: (row) => String(row.paperOnly === true) },
        ]}
      />

      <DataTable
        title="Blocked candidates"
        subtitle="Signaler som stoppades innan paper trade skapades"
        rows={blockedCandidates}
        emptyText="Inga blocked candidates i senaste runtime-fönstret."
        rowKey={(row, index) => row.eventId || `${row.symbol}-${index}`}
        columns={[
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'gateStage', label: 'Gate stage' },
          { key: 'blockedReason', label: 'Blocked reason' },
          { key: 'timestamp', label: 'Timestamp', render: (row) => fmtTime(row.timestamp) },
          { key: 'source', label: 'Source' },
        ]}
      />

      <DataTable
        title="Latest paper events"
        subtitle="Senaste paper-only runtime-events"
        rows={recentEvents}
        emptyText="Inga paper events ännu."
        rowKey={(row, index) => row.eventId || `${row.symbol}-${index}`}
        columns={[
          { key: 'type', label: 'Event type' },
          { key: 'symbol', label: 'Symbol' },
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'timestamp', label: 'Timestamp', render: (row) => fmtTime(row.timestamp) },
          { key: 'reason', label: 'Reason / result', render: (row) => row.blockedReason || row.result || row.status || '–' },
          { key: 'source', label: 'Source' },
        ]}
      />

      <DataTable
        title="Strategy summary"
        subtitle="Aggregerat per canonical strategy_id"
        rows={strategies}
        emptyText="Inga strategier i runtime-fönstret ännu."
        rowKey={(row, index) => row.strategy_id || `strategy-${index}`}
        columns={[
          { key: 'strategy_id', label: 'Canonical strategy_id' },
          { key: 'openCount', label: 'Open' },
          { key: 'closedCount', label: 'Closed' },
          { key: 'blockedCount', label: 'Blocked' },
          { key: 'latestEventType', label: 'Latest event' },
          { key: 'latestEventAt', label: 'Latest at', render: (row) => fmtTime(row.latestEventAt) },
        ]}
      />
    </div>
  );
}
