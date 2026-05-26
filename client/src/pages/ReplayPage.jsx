import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../shared.jsx';

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00%';
  return `${n.toFixed(2)}%`;
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function fmtTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('sv-SE', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function todayMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function statusSv(status) {
  const map = {
    created: 'Skapad',
    running: 'Kör',
    paused: 'Pausad',
    stopped: 'Stoppad',
    completed: 'Klar',
    failed: 'Fel',
  };
  return map[status] || status || '-';
}

function decisionClass(decision, pnl) {
  if (decision === 'ENTER' && Number(pnl) > 0) return 'badge-green';
  if (decision === 'ENTER' && Number(pnl) < 0) return 'badge-red';
  if (decision === 'L_SKIP') return 'badge-yellow';
  return 'badge-gray';
}

async function api(path, options) {
  const res = await fetch(path, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `API ${res.status}`);
  return json;
}

function useReplaySessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const json = await api('/api/replay/sessions');
      setSessions(json.sessions || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { sessions, loading, error, refresh };
}

function useReplayDetail(sessionId) {
  const [session, setSession] = useState(null);
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const [statusJson, eventsJson, summaryJson] = await Promise.all([
        api(`/api/replay/sessions/${sessionId}`),
        api(`/api/replay/sessions/${sessionId}/events?limit=1000`),
        api(`/api/replay/sessions/${sessionId}/summary`),
      ]);
      setSession(statusJson.session || null);
      setEvents(eventsJson.events || []);
      setSummary(summaryJson.summary || null);
    } catch (_) {
      setSession(null);
      setEvents([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    if (!sessionId) return undefined;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh, sessionId]);

  return { session, summary, events, loading, refresh };
}

function CreateSessionForm({ onCreated }) {
  const [form, setForm] = useState({
    symbols: 'TSLA,NVDA',
    date_from: todayMinus(6),
    date_to: todayMinus(6),
    timeframe: '2m',
    speed: 'instant',
    use_agent_reasoning: true,
    use_memory_similarity: true,
    use_risk_engine: true,
    use_exit_engine: true,
    initial_balance: 100000,
    max_trades: 50,
    risk_profile: 'normal',
  });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function set(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        symbols: form.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
        initial_balance: Number(form.initial_balance),
        max_trades: Number(form.max_trades),
      };
      const json = await api('/api/replay/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      onCreated(json.session.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rpl-form">
      <div className="rpl-form-header">
        <div className="rpl-form-title">Spela upp historik</div>
        <div className="rpl-form-desc">
          Testkörning i isolerat replay-läge. Inga riktiga trades, paper-positioner eller notifieringar skapas.
        </div>
      </div>
      <form className="rpl-form-body" onSubmit={submit}>
        <div className="rpl-form-grid replay-v2-form-grid">
          <label className="rpl-form-group rpl-form-group-wide">
            <span className="rpl-form-label">Symboler</span>
            <input className="rpl-form-input" value={form.symbols} onChange={(e) => set('symbols', e.target.value)} />
          </label>
          <label className="rpl-form-group">
            <span className="rpl-form-label">Från</span>
            <input className="rpl-form-input" type="date" value={form.date_from} onChange={(e) => set('date_from', e.target.value)} />
          </label>
          <label className="rpl-form-group">
            <span className="rpl-form-label">Till</span>
            <input className="rpl-form-input" type="date" value={form.date_to} onChange={(e) => set('date_to', e.target.value)} />
          </label>
          <label className="rpl-form-group">
            <span className="rpl-form-label">Hastighet</span>
            <select className="rpl-form-input" value={form.speed} onChange={(e) => set('speed', e.target.value)}>
              <option value="instant">Instant</option>
              <option value="10x">10x</option>
              <option value="5x">5x</option>
              <option value="1x">1x</option>
            </select>
          </label>
          <label className="rpl-form-group">
            <span className="rpl-form-label">Riskprofil</span>
            <select className="rpl-form-input" value={form.risk_profile} onChange={(e) => set('risk_profile', e.target.value)}>
              <option value="conservative">Konservativ</option>
              <option value="normal">Normal</option>
              <option value="aggressive">Aggressiv</option>
            </select>
          </label>
          <label className="rpl-form-group">
            <span className="rpl-form-label">Startkapital</span>
            <input className="rpl-form-input" type="number" value={form.initial_balance} onChange={(e) => set('initial_balance', e.target.value)} />
          </label>
          <label className="rpl-form-group">
            <span className="rpl-form-label">Max trades</span>
            <input className="rpl-form-input" type="number" value={form.max_trades} onChange={(e) => set('max_trades', e.target.value)} />
          </label>
        </div>
        <div className="replay-v2-toggles">
          <label><input type="checkbox" checked={form.use_agent_reasoning} onChange={(e) => set('use_agent_reasoning', e.target.checked)} /> Agentpåverkan</label>
          <label><input type="checkbox" checked={form.use_memory_similarity} onChange={(e) => set('use_memory_similarity', e.target.checked)} /> Minnespåverkan</label>
          <label><input type="checkbox" checked={form.use_risk_engine} onChange={(e) => set('use_risk_engine', e.target.checked)} /> Risk Engine v2</label>
          <label><input type="checkbox" checked={form.use_exit_engine} onChange={(e) => set('use_exit_engine', e.target.checked)} /> Exit Engine v1</label>
        </div>
        <div className="rpl-form-actions">
          <button className="rpl-btn-submit" type="submit" disabled={submitting}>
            {submitting ? 'Skapar...' : 'Skapa testkörning'}
          </button>
          {error && <span className="rpl-form-error">{error}</span>}
        </div>
      </form>
    </div>
  );
}

function SessionList({ sessions, selectedId, onSelect }) {
  if (!sessions.length) {
    return <div className="rpl-no-runs"><div className="rpl-no-runs-text">Inga testkörningar ännu.</div></div>;
  }
  return (
    <div className="rpl-runs-list">
      {sessions.map((session) => (
        <button
          type="button"
          key={session.id}
          className={`rpl-run-card replay-v2-run-btn${selectedId === session.id ? ' rpl-run-card-active' : ''}`}
          onClick={() => onSelect(session.id)}
        >
          <span className="rpl-run-id">{session.id.slice(-10).toUpperCase()}</span>
          <span className="rpl-run-date">{session.config.date_from} {'->'} {session.config.date_to}</span>
          <span className="rpl-run-syms">{session.config.symbols.join(', ')}</span>
          <span className="rpl-run-stats">
            <span className="rpl-run-stat"><span className="rpl-run-stat-val">{statusSv(session.status)}</span><span className="rpl-run-stat-label">status</span></span>
            <span className="rpl-run-stat"><span className="rpl-run-stat-val">{session.progress?.eventsLogged ?? 0}</span><span className="rpl-run-stat-label">events</span></span>
          </span>
          <span className="rpl-run-created">{fmtTime(session.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}

function ControlBar({ session, onRun, onPause, onStop, onRefresh }) {
  if (!session) return null;
  const running = session.status === 'running';
  const canRun = ['created', 'paused'].includes(session.status);
  const canStop = ['running', 'paused', 'created'].includes(session.status);

  return (
    <div className="replay-v2-controls">
      <span className="status-pill">replay_mode: true</span>
      <span className="status-pill">{statusSv(session.status)}</span>
      <span className="status-pill">{session.progress?.processedCandles ?? 0}/{session.progress?.totalCandles ?? 0} candles</span>
      <button className="btn" onClick={onRun} disabled={!canRun}>Kör</button>
      <button className="btn" onClick={onPause} disabled={!running}>Pausa</button>
      <button className="btn" onClick={onStop} disabled={!canStop}>Stoppa</button>
      <button className="btn" onClick={onRefresh}>Uppdatera</button>
    </div>
  );
}

function MetricCards({ summary }) {
  const cards = [
    ['P/L', fmtPct(summary?.total_pl_pct), Number(summary?.total_pl_pct) >= 0 ? 'var(--green)' : 'var(--red)'],
    ['Win rate', fmtPct(summary?.win_rate), 'var(--green)'],
    ['Trades', summary?.total_trades ?? 0, 'var(--text)'],
    ['Max drawdown', fmtPct(summary?.max_drawdown), 'var(--yellow)'],
    ['Agentpåverkan', summary?.agent_impact?.avg_adjustment ?? 0, 'var(--blue)'],
    ['Minnespåverkan', summary?.memory_impact?.avg_adjustment ?? 0, 'var(--purple)'],
  ];

  return (
    <div className="rpl-summary-strip">
      {cards.map(([label, value, color]) => (
        <div className="rpl-sum-card" key={label}>
          <div className="rpl-sum-val" style={{ color }}>{value}</div>
          <div className="rpl-sum-label">{label}</div>
        </div>
      ))}
      <div className="rpl-sum-card">
        <div className="rpl-sum-val">{fmtMoney(summary?.ending_balance)}</div>
        <div className="rpl-sum-label">Slutbalans</div>
      </div>
    </div>
  );
}

function ImpactPanel({ summary }) {
  const agent = summary?.agent_impact || {};
  const memory = summary?.memory_impact || {};
  const risk = summary?.risk_engine || {};
  const exit = summary?.exit_engine || {};
  return (
    <div className="replay-v2-impact-grid">
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Agentpåverkan</div>
        <div className="replay-v2-kv"><span>Aktiv</span><strong>{agent.enabled ? 'Ja' : 'Nej'}</strong></div>
        <div className="replay-v2-kv"><span>Snittjustering</span><strong>{agent.avg_adjustment ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Negativa events</span><strong>{agent.negative_events ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Positiva events</span><strong>{agent.positive_events ?? 0}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Minnespåverkan</div>
        <div className="replay-v2-kv"><span>Aktiv</span><strong>{memory.enabled ? 'Ja' : 'Nej'}</strong></div>
        <div className="replay-v2-kv"><span>Snittjustering</span><strong>{memory.avg_adjustment ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Negativa events</span><strong>{memory.negative_events ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Positiva events</span><strong>{memory.positive_events ?? 0}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Blockerade affärer</div>
        <div className="replay-v2-kv"><span>Skulle ha förlorat</span><strong>{summary?.blocked_trades_that_would_have_lost ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Skulle ha vunnit</span><strong>{summary?.blocked_trades_that_would_have_won ?? 0}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Risk Engine v2</div>
        <div className="replay-v2-kv"><span>Risk blocks</span><strong>{risk.risk_blocks ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Trades reduced by sizing</span><strong>{risk.trades_reduced_by_sizing ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Avoided losses</span><strong>{fmtPct(risk.avoided_losses)}</strong></div>
        <div className="replay-v2-kv"><span>Missed winners</span><strong>{fmtPct(risk.missed_winners)}</strong></div>
        <div className="replay-v2-kv"><span>Avg position size</span><strong>{fmtMoney(risk.avg_position_size)}</strong></div>
        <div className="replay-v2-kv"><span>Max drawdown with risk engine</span><strong>{fmtPct(risk.max_drawdown_with_risk_engine)}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Exit Engine v1</div>
        <div className="replay-v2-kv"><span>Aktiv</span><strong>{exit.enabled ? 'Ja' : 'Nej'}</strong></div>
        <div className="replay-v2-kv"><span>Timeout minskning</span><strong>{exit.timeout_reduction ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Avg P/L change</span><strong>{fmtPct(exit.avg_pl_change)}</strong></div>
        <div className="replay-v2-kv"><span>Räddade vinster</span><strong>{exit.near_target_saved_trades ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Trailing exits</span><strong>{exit.trailing_stop_exits ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Momentum fade exits</span><strong>{exit.momentum_fade_exits ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Missade större vinnare</span><strong>{exit.missed_bigger_winners ?? 0}</strong></div>
        <div className="replay-v2-kv"><span>Förbättrade exits</span><strong>{exit.improved_exits_vs_baseline ?? 0}</strong></div>
      </div>
    </div>
  );
}

function EventTimeline({ events }) {
  if (!events.length) return <div className="hist-empty-filter">Inga replay events ännu.</div>;
  return (
    <div className="replay-v2-table-wrap">
      <table className="replay-v2-table">
        <thead>
          <tr>
            <th>Tid</th>
            <th>Symbol</th>
            <th>State</th>
            <th>Signal</th>
            <th>Gate</th>
            <th>Agent</th>
            <th>Minne</th>
            <th>Risk</th>
            <th>Konfidens</th>
            <th>Beslut</th>
            <th>P/L</th>
          </tr>
        </thead>
        <tbody>
          {events.slice().reverse().map((event, index) => (
            <tr key={`${event.timestamp}_${event.symbol}_${index}`}>
              <td>{fmtTime(event.timestamp)}</td>
              <td><strong>{event.symbol}</strong></td>
              <td>{event.state}</td>
              <td>{event.engine_signal}</td>
              <td>{event.gate_passed ? 'Ja' : 'Nej'}</td>
              <td>{event.agent_adjustment}</td>
              <td>{event.memory_adjustment}</td>
              <td>{event.risk_allowed === false ? `Block: ${(event.risk_block_reasons || []).join(', ')}` : event.risk_position_size_sek ? fmtMoney(event.risk_position_size_sek) : '-'}</td>
              <td>{event.final_confidence}</td>
              <td><span className={`badge ${decisionClass(event.decision, event.simulated_pnl_pct)}`}>{event.decision}</span></td>
              <td className={Number(event.simulated_pnl_pct) >= 0 ? 'replay-v2-pos' : 'replay-v2-neg'}>{fmtPct(event.simulated_pnl_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecisionList({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <div className="rpl-sym-group">
      <div className="rpl-sym-group-title">{title}</div>
      {rows.slice(0, 6).map((event, index) => (
        <div className="replay-v2-decision-row" key={`${title}_${event.symbol}_${event.timestamp}_${index}`}>
          <span>{event.symbol}</span>
          <strong className={Number(event.simulated_pnl_pct) >= 0 ? 'replay-v2-pos' : 'replay-v2-neg'}>{fmtPct(event.simulated_pnl_pct)}</strong>
          <span>{event.reason}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReplayPage() {
  const [selectedId, setSelectedId] = useState(null);
  const { sessions, loading, error, refresh } = useReplaySessions();
  const { session, summary, events, refresh: refreshDetail } = useReplayDetail(selectedId);

  useEffect(() => {
    if (!selectedId && sessions.length) setSelectedId(sessions[0].id);
  }, [sessions, selectedId]);

  async function created(id) {
    await refresh();
    setSelectedId(id);
  }

  async function runAction(action) {
    if (!selectedId) return;
    await api(`/api/replay/sessions/${selectedId}/${action}`, { method: 'POST' });
    await refresh();
    await refreshDetail();
  }

  const blockedRows = useMemo(() => summary?.blocked_trades || [], [summary]);

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title">Replay Intelligence v2</div>
          <div className="hero-sub">Spela upp historik och testkör fast engine, gate logic, agentpåverkan, minnespåverkan och paper-regler isolerat.</div>
        </div>
        <div className="status-bar-v2">
          <span className="status-pill">Testkörning</span>
          <span className="status-pill">{sessions.length} sessioner</span>
          <button className="btn" onClick={refresh}>Uppdatera</button>
        </div>
      </div>

      {error && <div className="market-banner">{error}</div>}
      <CreateSessionForm onCreated={created} />

      <div className="sec">
        <SectionHeader icon="" title="Testkörningar" count={sessions.length} desc="Välj en session och kör, pausa eller stoppa replay utan live-påverkan." />
        {loading ? <div className="empty">Laddar sessioner...</div> : <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />}
      </div>

      {session && (
        <>
          <div className="sec">
            <SectionHeader icon="" title="Status" desc={`${session.config.symbols.join(', ')} · ${session.config.date_from} -> ${session.config.date_to} · ${session.config.speed}`} />
            <ControlBar
              session={session}
              onRun={() => runAction('run')}
              onPause={() => runAction('pause')}
              onStop={() => runAction('stop')}
              onRefresh={() => { refresh(); refreshDetail(); }}
            />
            <MetricCards summary={summary} />
          </div>

          <div className="sec">
            <SectionHeader icon="" title="Agentpåverkan och minnespåverkan" desc="Justeringar från agent och historisk pattern similarity i replay mode." />
            <ImpactPanel summary={summary} />
          </div>

          <div className="sec">
            <SectionHeader icon="" title="Beslutslinje" count={events.length} desc="Varje sparat replay-beslut med gate, justeringar och simulerat utfall." />
            <EventTimeline events={events} />
          </div>

          <div className="sec replay-v2-decision-grid">
            <DecisionList title="Top winning decisions" rows={summary?.top_winning_decisions} />
            <DecisionList title="Top losing decisions" rows={summary?.top_losing_decisions} />
            <DecisionList title="Blockerade affärer" rows={blockedRows} />
          </div>
        </>
      )}
    </div>
  );
}
