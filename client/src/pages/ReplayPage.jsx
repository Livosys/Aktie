import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../shared.jsx';
import { createDecisionStore } from '../stores/decisionStore.js';
import { createTradingEventStore } from '../stores/tradingEventStore.js';
import {
  EMPTY_VALUE,
  boolText,
  fmtMoney as formatMoney,
  fmtNumber,
  fmtPercent,
  fmtTime as formatTimestamp,
  hasValue,
  numberOrNull,
} from '../utils/tradingFormatters.js';

function fmtPct(value) {
  return fmtPercent(value, 2);
}

function fmtMoney(value) {
  return formatMoney(value, null, 0);
}

function fmtTime(value) {
  return formatTimestamp(value);
}

function displayCount(value) {
  return hasValue(value) ? fmtNumber(value) : EMPTY_VALUE;
}

function displayRawNumber(value, digits = 2) {
  return hasValue(value) ? fmtNumber(value, digits) : EMPTY_VALUE;
}

function pnlClass(value) {
  const n = numberOrNull(value);
  if (n == null) return '';
  return n >= 0 ? 'replay-v2-pos' : 'replay-v2-neg';
}

function metricColor(value, positive = 'var(--green)', negative = 'var(--red)', missing = 'var(--text)') {
  const n = numberOrNull(value);
  if (n == null) return missing;
  return n >= 0 ? positive : negative;
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
  const n = numberOrNull(pnl);
  if (decision === 'ENTER' && n != null && n > 0) return 'badge-green';
  if (decision === 'ENTER' && n != null && n < 0) return 'badge-red';
  if (decision === 'L_SKIP') return 'badge-yellow';
  return 'badge-gray';
}

async function api(path, options) {
  const method = (options && options.method) || 'GET';
  let res;
  try {
    res = await fetch(path, options);
  } catch (netErr) {
    // fetch() rejects only on network-level failures (offline, CORS block,
    // connection reset). Surface WHICH request failed instead of a bare
    // "Failed to fetch".
    const err = new Error('Kunde inte nå servern (nätverksfel).');
    err.detail = { endpoint: path, method, status: 'network_error', cause: netErr?.message || String(netErr) };
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.detail = {
      endpoint: path,
      method,
      status: res.status,
      backendError: json.error || null,
      blockedSymbols: json.blockedSymbols || null,
      allowedSymbols: json.allowedSymbols || null,
    };
    throw err;
  }
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
      setError(err);
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

// Replay symbol focus is the US market underlying the CME micro futures.
// MNQ/MES are the micro-future instruments but have no replay candles and sit
// outside the replay research-scope (S&P / Nasdaq / Crypto), so the runnable
// default is their US-market proxies QQQ (Nasdaq 100 / MNQ) and SPY (S&P 500 / MES).
const SYMBOL_PRESETS = [
  { key: 'proxy', label: 'US market-proxy', symbols: 'QQQ,SPY', hint: 'QQQ = Nasdaq 100 (MNQ), SPY = S&P 500 (MES) — körbar replay-data' },
  { key: 'futures', label: 'Futures-fokus', symbols: 'MNQ,MES', hint: 'MNQ = Nasdaq 100 Micro E-mini, MES = S&P 500 Micro E-mini — saknar replay-candles, använd proxy' },
  { key: 'legacy', label: 'Aktier / legacy', symbols: 'TSLA,NVDA', hint: 'Äldre aktie-fokus. Finns kvar i historiken men är inte längre standard.' },
];
const SYMBOL_LABELS = {
  MNQ: 'Nasdaq 100 Micro E-mini (futures)',
  MES: 'S&P 500 Micro E-mini (futures)',
  QQQ: 'Nasdaq 100 proxy',
  SPY: 'S&P 500 proxy',
};
// Futures instruments that have no replay candles / are outside replay-scope.
const FUTURES_WITHOUT_CANDLES = new Set(['MNQ', 'MES', 'NQ', 'ES', 'MYM', 'M2K', 'RTY', 'YM']);

function parseSymbols(raw) {
  return String(raw || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function ErrorDetail({ title, error }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!error) return null;
  const detail = error.detail || {};
  return (
    <div className="replay-data-warning" style={{ borderColor: 'rgba(239,68,68,0.35)' }}>
      <div style={{ fontWeight: 800 }}>{title}</div>
      {detail.endpoint && <div>Endpoint: <code>{detail.method || 'GET'} {detail.endpoint}</code></div>}
      {detail.status !== undefined && <div>Status: <strong>{String(detail.status)}</strong></div>}
      <div>Orsak: <strong>{error.message || 'Okänt fel'}</strong></div>
      {Array.isArray(detail.blockedSymbols) && detail.blockedSymbols.length > 0 && (
        <div>Blockerade symboler: <strong>{detail.blockedSymbols.map((b) => b.normalized || b.symbol || b).join(', ')}</strong></div>
      )}
      <button type="button" className="btn" style={{ marginTop: 6 }} onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? 'Dölj tekniskt' : 'Visa tekniskt'}
      </button>
      {showRaw && <pre style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontSize: 11 }}>{JSON.stringify(detail, null, 2)}</pre>}
    </div>
  );
}

function CreateSessionForm({ onCreated }) {
  const [form, setForm] = useState({
    symbols: 'QQQ,SPY',
    date_from: todayMinus(6),
    date_to: todayMinus(6),
    timeframe: '2m',
    speed: 'instant',
    use_agent_reasoning: true,
    use_memory_similarity: true,
    use_risk_engine: true,
    use_exit_engine: true,
    use_execution_safety: false,
    initial_balance: 100000,
    max_trades: 50,
    risk_profile: 'normal',
  });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [coverageMap, setCoverageMap] = useState({});

  useEffect(() => {
    fetch('/api/data-coverage/symbols')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const map = {};
        (d?.symbols || []).forEach((row) => { map[row.symbol] = row; });
        setCoverageMap(map);
      })
      .catch(() => {});
  }, []);

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
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedSymbols = parseSymbols(form.symbols);
  const selectedCoverage = selectedSymbols
    .map((symbol) => coverageMap[symbol])
    .filter(Boolean);
  const replayWarnings = selectedCoverage.filter((row) => !row.usable_for_replay);
  const futuresSelected = selectedSymbols.filter((s) => FUTURES_WITHOUT_CANDLES.has(s));

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
            <div className="replay-preset-row">
              {SYMBOL_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.key}
                  className={`btn replay-preset-btn${form.symbols.toUpperCase() === preset.symbols ? ' rpl-run-card-active' : ''}`}
                  title={preset.hint}
                  onClick={() => set('symbols', preset.symbols)}
                >
                  {preset.label} <span className="replay-preset-syms">({preset.symbols})</span>
                </button>
              ))}
            </div>
            <input className="rpl-form-input" value={form.symbols} onChange={(e) => set('symbols', e.target.value)} />
            {selectedSymbols.some((s) => SYMBOL_LABELS[s]) && (
              <div className="replay-symbol-legend">
                {selectedSymbols.filter((s) => SYMBOL_LABELS[s]).map((s) => (
                  <span key={s}><strong>{s}</strong> = {SYMBOL_LABELS[s]}</span>
                ))}
              </div>
            )}
          </label>
          {futuresSelected.length > 0 && (
            <div className="rpl-form-group rpl-form-group-wide replay-data-warning">
              {futuresSelected.join(', ')} saknar replay-candles och ligger utanför replay-scope (S&P / Nasdaq / Crypto).
              Använd proxy i stället: <strong>QQQ</strong> (Nasdaq 100 / MNQ), <strong>SPY</strong> (S&P 500 / MES).
            </div>
          )}
          {replayWarnings.length > 0 && (
            <div className="rpl-form-group rpl-form-group-wide replay-data-warning">
              För lite historik för säkert test: {replayWarnings.map((row) => row.symbol).join(', ')}.
            </div>
          )}
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
          <label><input type="checkbox" checked={form.use_execution_safety} onChange={(e) => set('use_execution_safety', e.target.checked)} /> Execution Safety v1</label>
        </div>
        <div className="rpl-form-actions">
          <button className="rpl-btn-submit" type="submit" disabled={submitting}>
            {submitting ? 'Skapar...' : 'Skapa testkörning'}
          </button>
        </div>
        <ErrorDetail title="Replay kunde inte skapas" error={error} />
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
            <span className="rpl-run-stat"><span className="rpl-run-stat-val">{displayCount(session.progress?.eventsLogged)}</span><span className="rpl-run-stat-label">events</span></span>
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
      <span className="status-pill">{displayCount(session.progress?.processedCandles)}/{displayCount(session.progress?.totalCandles)} candles</span>
      <button className="btn" onClick={onRun} disabled={!canRun}>Kör</button>
      <button className="btn" onClick={onPause} disabled={!running}>Pausa</button>
      <button className="btn" onClick={onStop} disabled={!canStop}>Stoppa</button>
      <button className="btn" onClick={onRefresh}>Uppdatera</button>
    </div>
  );
}

function MetricCards({ summary }) {
  const cards = [
    ['P/L', fmtPct(summary?.total_pl_pct), metricColor(summary?.total_pl_pct)],
    ['Win rate', fmtPct(summary?.win_rate), numberOrNull(summary?.win_rate) == null ? 'var(--text)' : 'var(--green)'],
    ['Trades', displayCount(summary?.total_trades), 'var(--text)'],
    ['Max drawdown', fmtPct(summary?.max_drawdown), 'var(--yellow)'],
    ['Agentpåverkan', displayRawNumber(summary?.agent_impact?.avg_adjustment), 'var(--blue)'],
    ['Minnespåverkan', displayRawNumber(summary?.memory_impact?.avg_adjustment), 'var(--purple)'],
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
  const safety = summary?.execution_safety || {};
  return (
    <div className="replay-v2-impact-grid">
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Agentpåverkan</div>
        <div className="replay-v2-kv"><span>Aktiv</span><strong>{boolText(agent.enabled)}</strong></div>
        <div className="replay-v2-kv"><span>Snittjustering</span><strong>{displayRawNumber(agent.avg_adjustment)}</strong></div>
        <div className="replay-v2-kv"><span>Negativa events</span><strong>{displayCount(agent.negative_events)}</strong></div>
        <div className="replay-v2-kv"><span>Positiva events</span><strong>{displayCount(agent.positive_events)}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Minnespåverkan</div>
        <div className="replay-v2-kv"><span>Aktiv</span><strong>{boolText(memory.enabled)}</strong></div>
        <div className="replay-v2-kv"><span>Snittjustering</span><strong>{displayRawNumber(memory.avg_adjustment)}</strong></div>
        <div className="replay-v2-kv"><span>Negativa events</span><strong>{displayCount(memory.negative_events)}</strong></div>
        <div className="replay-v2-kv"><span>Positiva events</span><strong>{displayCount(memory.positive_events)}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Blockerade affärer</div>
        <div className="replay-v2-kv"><span>Skulle ha förlorat</span><strong>{displayCount(summary?.blocked_trades_that_would_have_lost)}</strong></div>
        <div className="replay-v2-kv"><span>Skulle ha vunnit</span><strong>{displayCount(summary?.blocked_trades_that_would_have_won)}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Risk Engine v2</div>
        <div className="replay-v2-kv"><span>Risk blocks</span><strong>{displayCount(risk.risk_blocks)}</strong></div>
        <div className="replay-v2-kv"><span>Trades reduced by sizing</span><strong>{displayCount(risk.trades_reduced_by_sizing)}</strong></div>
        <div className="replay-v2-kv"><span>Avoided losses</span><strong>{fmtPct(risk.avoided_losses)}</strong></div>
        <div className="replay-v2-kv"><span>Missed winners</span><strong>{fmtPct(risk.missed_winners)}</strong></div>
        <div className="replay-v2-kv"><span>Avg position size</span><strong>{fmtMoney(risk.avg_position_size)}</strong></div>
        <div className="replay-v2-kv"><span>Max drawdown with risk engine</span><strong>{fmtPct(risk.max_drawdown_with_risk_engine)}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Exit Engine v1</div>
        <div className="replay-v2-kv"><span>Aktiv</span><strong>{boolText(exit.enabled)}</strong></div>
        <div className="replay-v2-kv"><span>Timeout minskning</span><strong>{displayCount(exit.timeout_reduction)}</strong></div>
        <div className="replay-v2-kv"><span>Avg P/L change</span><strong>{fmtPct(exit.avg_pl_change)}</strong></div>
        <div className="replay-v2-kv"><span>Räddade vinster</span><strong>{displayCount(exit.near_target_saved_trades)}</strong></div>
        <div className="replay-v2-kv"><span>Trailing exits</span><strong>{displayCount(exit.trailing_stop_exits)}</strong></div>
        <div className="replay-v2-kv"><span>Momentum fade exits</span><strong>{displayCount(exit.momentum_fade_exits)}</strong></div>
        <div className="replay-v2-kv"><span>Missade större vinnare</span><strong>{displayCount(exit.missed_bigger_winners)}</strong></div>
        <div className="replay-v2-kv"><span>Förbättrade exits</span><strong>{displayCount(exit.improved_exits_vs_baseline)}</strong></div>
      </div>
      <div className="rpl-sym-group">
        <div className="rpl-sym-group-title">Execution Safety v1</div>
        <div className="replay-v2-kv"><span>Aktiv</span><strong>{boolText(safety.enabled)}</strong></div>
        <div className="replay-v2-kv"><span>Safety blocks</span><strong>{displayCount(safety.safety_blocks)}</strong></div>
        <div className="replay-v2-kv"><span>Stale data blocks</span><strong>{displayCount(safety.stale_data_blocks)}</strong></div>
        <div className="replay-v2-kv"><span>Risk pause blocks</span><strong>{displayCount(safety.risk_pause_blocks)}</strong></div>
        <div className="replay-v2-kv"><span>Kill switch blocks</span><strong>{displayCount(safety.kill_switch_blocks)}</strong></div>
        <div className="replay-v2-kv"><span>Entries prevented</span><strong>{displayCount(safety.entries_prevented)}</strong></div>
        <div className="replay-v2-kv"><span>Would-have-entered</span><strong>{displayCount(safety.would_have_entered_count)}</strong></div>
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
              <td>{event.execution_safety_allowed === false ? `Safety: ${(event.execution_safety_block_reasons || []).join(', ')}` : event.risk_allowed === false ? `Block: ${(event.risk_block_reasons || []).join(', ')}` : event.risk_position_size_sek ? fmtMoney(event.risk_position_size_sek) : '-'}</td>
              <td>{event.final_confidence}</td>
              <td><span className={`badge ${decisionClass(event.decision, event.simulated_pnl_pct)}`}>{event.decision}</span></td>
              <td className={pnlClass(event.simulated_pnl_pct)}>{fmtPct(event.simulated_pnl_pct)}</td>
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
          <strong className={pnlClass(event.simulated_pnl_pct)}>{fmtPct(event.simulated_pnl_pct)}</strong>
          <span>{event.reason}</span>
        </div>
      ))}
    </div>
  );
}

// Daily/autopilot replay lives in a DIFFERENT store than the manual sessions
// below (runs vs sessions). Read-only surface of the latest daily run so Lab and
// Supervisor show the same "senaste replay"-sanning from /api/status/replay.
function useLatestDailyReplay() {
  const [latest, setLatest] = useState(undefined); // undefined=loading, null=none
  useEffect(() => {
    let alive = true;
    fetch('/api/status/replay')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setLatest(d?.latestReplay || null); })
      .catch(() => { if (alive) setLatest(null); });
    return () => { alive = false; };
  }, []);
  return latest;
}

function LatestDailyReplayBanner({ latest }) {
  if (latest === undefined) return <div className="rpl-daily-banner">Senaste dagliga replay: laddar…</div>;
  if (!latest) return <div className="rpl-daily-banner">Ingen daglig replay sparad ännu.</div>;
  const day = latest.createdAt ? new Date(latest.createdAt).toLocaleDateString('sv-SE') : (latest.period?.to || 'okänt datum');
  return (
    <div className="rpl-daily-banner">
      <strong>Senaste dagliga replay</strong> ({latest.replayMode || 'daily'}) · {day} ·{' '}
      {(latest.symbols || []).join(', ') || 'Saknas'} · {displayCount(latest.totalEvents)} events ·{' '}
      {displayCount(latest.totalCandles)} candles · snittbetyg {displayRawNumber(latest.avgTradeScore)}
    </div>
  );
}

export default function ReplayPage() {
  const [selectedId, setSelectedId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const latestDaily = useLatestDailyReplay();
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
    setActionError(null);
    try {
      await api(`/api/replay/sessions/${selectedId}/${action}`, { method: 'POST' });
      await refresh();
      await refreshDetail();
    } catch (err) {
      setActionError(err);
    }
  }

  const blockedRows = useMemo(() => summary?.blocked_trades || [], [summary]);
  const tradingEventStore = useMemo(() => createTradingEventStore({
    replaySnapshot: {
      session,
      summary,
      events,
    },
    events,
  }), [events, session, summary]);
  const tradingEventCount = tradingEventStore.getAllEvents().length;
  const decisionStore = useMemo(() => createDecisionStore({
    eventStore: tradingEventStore,
    replaySnapshot: {
      session,
      summary,
      events,
    },
    decisions: events,
  }), [events, session, summary, tradingEventStore]);
  const decisionCount = decisionStore.getDecisions().length;

  return (
    <div data-trading-event-count={tradingEventCount} data-decision-count={decisionCount}>
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

      <LatestDailyReplayBanner latest={latestDaily} />
      {error && <ErrorDetail title="Kunde inte hämta replay-sessioner" error={error} />}
      {actionError && <ErrorDetail title="Replay-åtgärden misslyckades" error={actionError} />}
      <CreateSessionForm onCreated={created} />

      <div className="sec">
        <SectionHeader icon="" title="Testkörningar" count={sessions.length} desc="Välj en session och kör, pausa eller stoppa replay utan live-påverkan." />
        {loading ? <div className="empty">Laddar sessioner...</div> : <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />}
      </div>

      {session && (
        <>
          <div className="sec">
            <SectionHeader icon="" title="Status" desc={`${session.config.symbols.join(', ')} · ${session.config.date_from} -> ${session.config.date_to} · ${session.config.speed}`} />
            {Array.isArray(session.config.data_gaps) && session.config.data_gaps.length > 0 && (
              <div className="replay-data-warning">
                Datagap – kördes inte (ingen replay-data):{' '}
                {session.config.data_gaps.map((g) => `${g.symbol} (needs_provider${g.proxy ? `, proxy ${g.proxy}` : ''})`).join(', ')}.
              </div>
            )}
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
