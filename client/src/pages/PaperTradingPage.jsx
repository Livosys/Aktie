import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PaperCandidatePanel from '../components/PaperCandidatePanel.jsx';

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
          <Link to="/system">Till System</Link>
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

function usePaperAllowlist(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/automation/paper-allowlist/status')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa paper allowlist-status.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function friendlyAllowlistError(err, fallback) {
  const message = String(err?.message || '').trim();
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return fallback;
  if (/^timeout_after_\d+ms$/i.test(message)) return `${fallback} (timeout)`;
  return message || fallback;
}

function usePaperAllowlistConfig(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/automation/paper-allowlist/config')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa allowlist-config.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
  return state;
}

function usePaperApprovals(refreshKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchJsonWithTimeout('/api/automation/approvals')
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          data: null,
          error: friendlyAllowlistError(err, 'Kunde inte läsa approvals.'),
        });
      });
    return () => { alive = false; };
  }, [refreshKey]);
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

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function postApproval(action, strategyId) {
  try {
    const res = await fetch(`/api/automation/approvals/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategyId, reason: 'manual_ui_admin' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    throw new Error(friendlyAllowlistError(err, 'Kunde inte uppdatera approvals.'));
  }
}

async function postPaperAllowlistConfig(maxApproved) {
  try {
    const res = await fetch('/api/automation/paper-allowlist/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxApproved, reason: 'manual_ui_config' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    throw new Error(friendlyAllowlistError(err, 'Kunde inte spara allowlist-config.'));
  }
}

function PaperAllowlistManager({ runtime, allowlist, refreshKey, onRefresh }) {
  const [approvals, setApprovals] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState(null);   // { type: 'ok' | 'error', text }
  const [confirm, setConfirm] = useState(null);    // { kind, action, id, name, maxApproved }
  const [draftMaxApproved, setDraftMaxApproved] = useState('4');

  const approvalsState = usePaperApprovals(refreshKey);
  const configState = usePaperAllowlistConfig(refreshKey);

  useEffect(() => {
    setApprovals(approvalsState.data);
    setConfig(configState.data);
    setLoading(Boolean(approvalsState.loading || configState.loading));
  }, [approvalsState.data, approvalsState.loading, configState.data, configState.loading]);

  useEffect(() => {
    if (configState.data && configState.data.maxApproved != null) {
      setDraftMaxApproved(String(configState.data.maxApproved));
    }
  }, [configState.data]);

  const safe = approvals?.safety || config?.safety || {};
  const paperOnly = (safe.mode || 'paper_only') === 'paper_only'
    && safe.actions_allowed !== true && safe.can_place_orders !== true && safe.live_trading_enabled !== true;

  const approvedIds = Array.isArray(approvals?.approvedStrategyIds) ? approvals.approvedStrategyIds : [];
  const maxApproved = num(config?.maxApproved ?? approvals?.maxApproved);
  const hardMaxApproved = num(config?.hardMaxApproved ?? approvals?.hardMaxApproved) || 10;
  const minApproved = num(config?.minApproved ?? approvals?.minApproved) || 1;
  const approvedCount = approvedIds.length;
  const slotFree = maxApproved > 0 && approvedCount < maxApproved;

  const strategies = Array.isArray(runtime?.strategies) ? runtime.strategies : [];
  const stratById = new Map(strategies.map((s) => [s.strategy_id, s]));
  const allowRows = Array.isArray(allowlist?.allowlist) ? allowlist.allowlist : [];
  const allowMap = new Map(allowRows.map((r) => [r.id, r]));

  const approvedRows = approvedIds.map((id) => {
    const s = stratById.get(id) || {};
    const a = allowMap.get(id) || {};
    return {
      id,
      name: a.name || s.strategy_name || id,
      runtimeReady: a.paperRuntimeReady === true,
      events: num(s.openCount) + num(s.closedCount) + num(s.blockedCount),
      latestAt: s.latestEventAt || '',
    };
  });

  const nonApproved = strategies
    .filter((s) => !approvedIds.includes(s.strategy_id))
    .map((s) => ({
      id: s.strategy_id,
      name: s.strategy_name || s.strategy_id,
      blockedCount: num(s.blockedCount),
      latestAt: s.latestEventAt || '',
      reason: s.latestBlockedReason || '',
    }))
    .sort((a, b) => b.blockedCount - a.blockedCount);

  function ask(action, id, name) { setMessage(null); setConfirm({ kind: 'strategy', action, id, name }); }

  function askConfigSave() {
    setMessage(null);
    setConfirm({ kind: 'config', maxApproved: num(draftMaxApproved) });
  }

  async function runAction() {
    if (!confirm) return;
    if (confirm.kind === 'config') {
      setBusyId('config');
      setConfirm(null);
      setMessage(null);
      try {
        const result = await postPaperAllowlistConfig(confirm.maxApproved);
        setMessage({
          type: 'ok',
          text: result.changed === false
            ? 'Max antal godkända var redan satt till samma värde.'
            : `Max antal godkända uppdaterat till ${result.maxApproved}. Inga trades skapades.`,
        });
        onRefresh();
      } catch (err) {
        setMessage({ type: 'error', text: err?.message || 'Kunde inte spara maxgränsen.' });
      } finally {
        setBusyId('');
      }
      return;
    }

    const { action, id } = confirm;
    setBusyId(id);
    setConfirm(null);
    setMessage(null);
    try {
      await postApproval(action, id);
      setMessage({
        type: 'ok',
        text: action === 'approve'
          ? 'Strategin är nu godkänd för paper trading. Inga riktiga order kan läggas.'
          : 'Strategin är borttagen från paper allowlist. Inga riktiga order påverkas.',
      });
      onRefresh();
    } catch (err) {
      setMessage({ type: 'error', text: err?.message || 'Åtgärden misslyckades.' });
    } finally {
      setBusyId('');
    }
  }

  const btnStyle = (disabled, tone) => ({
    appearance: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: '1px solid var(--border)',
    background: tone === 'danger' ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
    color: tone === 'danger' ? '#ef4444' : '#22c55e',
    fontWeight: 700,
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 8,
  });

  return (
    <div style={sectionStyle()}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Paper Allowlist Manager</div>
      <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, marginBottom: 10 }}>
        Paper allowlist styrs manuellt av dig. Systemet får inte automatiskt lägga till eller ta bort strategier — det får bara visa rekommendationer. Detta gäller endast låtsashandel/paper trading; inga riktiga order kan läggas.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <MetricCard label="Godkända" value={`${approvedCount} / ${maxApproved || '–'}`} tone={slotFree ? 'good' : 'warn'} note={slotFree ? 'Plats finns' : 'Max nått'} />
        <MetricCard label="Max antal godkända" value={maxApproved || '–'} tone="neutral" note={`Manuell config, min ${minApproved}, max ${hardMaxApproved}`} />
        <MetricCard label="Säkerhetsläge" value={paperOnly ? 'paper_only' : 'OKÄND'} tone={paperOnly ? 'good' : 'bad'} note="actions_allowed=false" />
      </div>

      <div style={{ ...sectionStyle(), marginTop: 12, marginBottom: 12, background: 'rgba(15,23,42,0.55)' }}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Styr maxgränsen manuellt</div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
          Paper allowlist styrs manuellt av dig. Systemet får inte automatiskt lägga till eller ta bort strategier. Detta ändrar bara hur många strategier som får vara godkända för låtsashandel. Det skapar inga trades.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
            <span style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Nuvarande maxApproved</span>
            <select
              value={draftMaxApproved}
              onChange={(e) => setDraftMaxApproved(e.target.value)}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--surface)',
                color: 'inherit',
                padding: '10px 12px',
                fontSize: 14,
              }}
            >
              {Array.from({ length: hardMaxApproved }, (_, index) => index + minApproved).map((value) => (
                <option key={value} value={String(value)}>{value}</option>
              ))}
            </select>
          </label>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            Max tillåtet: {hardMaxApproved}. Senast sparat: {num(config?.maxApproved ?? approvals?.maxApproved) || '–'}.
          </div>
          <button
            type="button"
            disabled={busyId === 'config' || num(draftMaxApproved) === maxApproved}
            style={btnStyle(busyId === 'config' || num(draftMaxApproved) === maxApproved, 'ok')}
            onClick={askConfigSave}
          >
            Spara max
          </button>
        </div>
      </div>

      {message ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: message.type === 'ok' ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)', color: message.type === 'ok' ? '#22c55e' : '#ef4444' }}>
          {message.text}
        </div>
      ) : null}

      {confirm ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(56,189,248,0.45)' }}>
          <div style={{ marginBottom: 8 }}>
            {confirm.kind === 'config'
              ? `Detta ändrar bara hur många strategier som får vara godkända för låtsashandel. Det skapar inga trades.`
              : confirm.action === 'approve'
                ? `Detta godkänner ${confirm.name} för låtsashandel. Den får bara skapa paper trades om övriga regler godkänner. Inga riktiga order kan läggas.`
                : `Detta tar bara bort ${confirm.name} från paper allowlist. Inga riktiga order påverkas.`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={btnStyle(false, confirm.kind === 'config' ? 'ok' : (confirm.action === 'approve' ? 'ok' : 'danger'))} onClick={runAction}>Bekräfta</button>
            <button type="button" style={btnStyle(false, 'neutral')} onClick={() => setConfirm(null)}>Avbryt</button>
          </div>
        </div>
      ) : null}

      {loading ? <div style={{ color: '#94a3b8' }}>Hämtar allowlist...</div> : null}

      {approvalsState.error ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(239,68,68,0.45)', color: '#ef4444' }}>
          {approvalsState.error}
        </div>
      ) : null}

      {configState.error ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(239,68,68,0.45)', color: '#ef4444' }}>
          {configState.error}
        </div>
      ) : null}

      {config?.warning ? (
        <div style={{ ...sectionStyle(), marginBottom: 12, borderColor: 'rgba(245, 158, 11, 0.45)', color: '#fbbf24' }}>
          Allowlist-config saknade eller var trasig. Fallback {maxApproved || 4} används tills den sparas igen.
        </div>
      ) : null}

      {!paperOnly && !loading ? (
        <div style={{ ...sectionStyle(), borderColor: 'rgba(239,68,68,0.45)', color: '#ef4444' }}>
          Säkerhetsläget kunde inte bekräftas som paper_only — åtgärder är dolda.
        </div>
      ) : null}

      {paperOnly ? (
        <>
          <div style={{ fontWeight: 800, marginTop: 6, marginBottom: 6 }}>Godkända strategier ({approvedCount})</div>
          {approvedRows.length > 0 ? (
            <div style={{ overflowX: 'auto', marginBottom: 14 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr>{['Strategy id', 'Namn', 'Runtime ready', 'Events (fönster)', 'Senaste aktivitet', ''].map((l) => <th key={l} style={{ ...cellStyle(), color: '#94a3b8' }}>{l}</th>)}</tr></thead>
                <tbody>
                  {approvedRows.map((r) => (
                    <tr key={r.id}>
                      <td style={cellStyle()}>{r.id}</td>
                      <td style={cellStyle()}>{r.name}</td>
                      <td style={cellStyle()}>{r.runtimeReady ? 'Ja' : 'Nej'}</td>
                      <td style={cellStyle()}>{r.events}</td>
                      <td style={cellStyle()}>{r.latestAt ? fmtTime(r.latestAt) : '–'}</td>
                      <td style={cellStyle()}>
                        <button type="button" disabled={busyId === r.id} style={btnStyle(busyId === r.id, 'danger')} onClick={() => ask('reject', r.id, r.name)}>Ta bort från paper allowlist</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: '#94a3b8', marginBottom: 14 }}>Inga godkända strategier ännu.</div>}

          <div style={{ fontWeight: 800, marginBottom: 6 }}>Icke-godkända strategier med aktivitet</div>
          <div style={{ fontSize: 11.5, color: '#94a3b8', marginBottom: 6 }}>
            Sorterade efter antal blockeringar. {slotFree ? '' : 'Max antal godkända är nått — ta bort en strategi först eller höj maxgränsen. '}Om godkännande nekas visas exakt orsak från servern (t.ex. svag strategi eller maxgräns).
          </div>
          {nonApproved.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                <thead><tr>{['Strategy id', 'Namn', 'Blockeringar', 'Senaste orsak', 'Senaste aktivitet', ''].map((l) => <th key={l} style={{ ...cellStyle(), color: '#94a3b8' }}>{l}</th>)}</tr></thead>
                <tbody>
                  {nonApproved.map((r) => (
                    <tr key={r.id}>
                      <td style={cellStyle()}>{r.id}</td>
                      <td style={cellStyle()}>{r.name}</td>
                      <td style={cellStyle()}>{r.blockedCount}</td>
                      <td style={{ ...cellStyle(), maxWidth: 280 }}>{r.reason || '–'}</td>
                      <td style={cellStyle()}>{r.latestAt ? fmtTime(r.latestAt) : '–'}</td>
                      <td style={cellStyle()}>
                        {slotFree ? (
                          <button type="button" disabled={busyId === r.id} style={btnStyle(busyId === r.id, 'ok')} onClick={() => ask('approve', r.id, r.name)}>Lägg till i paper allowlist</button>
                        ) : (
                          <span title="Max antal godkända är nått. Ta bort en strategi först eller höj maxgränsen." style={{ ...btnStyle(true, 'ok'), display: 'inline-block' }}>Max nått</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: '#94a3b8' }}>Inga icke-godkända strategier med aktivitet i fönstret.</div>}
        </>
      ) : null}
    </div>
  );
}

export default function PaperTradingPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const runtimeState = usePaperRuntime(50);
  const allowlistState = usePaperAllowlist(refreshKey);
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

      <PaperAllowlistManager runtime={runtime} allowlist={allowlistState.data} refreshKey={refreshKey} onRefresh={() => setRefreshKey((t) => t + 1)} />

      <PaperCandidatePanel mode="paper" />

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
