import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PlatformEmptyState, PlatformSafetyBar } from '../components/PlatformControls.jsx';
import TradeReplayPanel from '../components/TradeReplayPanel.jsx';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

const TABS = [
  { key: 'oversikt',     label: 'Översikt',       icon: '📊' },
  { key: 'setups',       label: 'Mönsterresultat', icon: '🎯' },
  { key: 'ai',          label: 'AI-resultat',     icon: '🤖' },
  { key: 'replay',      label: 'Replay-resultat', icon: '▶️' },
  { key: 'paper',       label: 'Låtsastrading',   icon: '🧪' },
  { key: 'activity',    label: 'Aktivitet',       icon: '◷' },
  { key: 'daytrading',  label: 'Daytrading-strategier', icon: '🧩' },
  { key: 'memory',      label: 'Historiskt minne', icon: '📚' },
  { key: 'candidates',  label: 'Kandidater',      icon: '◎' },
  { key: 'data-center', label: 'Data Center',     icon: '▣' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function safeText(value, fallback = 'För lite data') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number' && !Number.isFinite(value)) return fallback;
  if (typeof value === 'object') return fallback;
  return String(value);
}

function safeNumber(value, fallback = '–') {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtActivityTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('sv-SE') : '–';
}

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function fmtDate(value) {
  if (!value) return '–';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' });
}

function MetricCard({ icon, value, label, sub, color }) {
  const c = color === 'green' ? '#22c55e' : color === 'red' ? '#ef4444' : color === 'yellow' ? '#f59e0b' : '#93c5fd';
  return (
    <div className="res-metric-card">
      {icon && <div className="res-metric-icon">{icon}</div>}
      <div className="res-metric-value" style={{ color: c }}>{value ?? '–'}</div>
      <div className="res-metric-label">{label}</div>
      {sub && <div className="res-metric-sub">{sub}</div>}
    </div>
  );
}

function WinBar({ wr }) {
  if (wr == null) return <span className="res-no-data">Ingen data</span>;
  const pct = Math.max(0, Math.min(100, wr));
  const color = pct >= 58 ? '#22c55e' : pct >= 45 ? '#f59e0b' : '#ef4444';
  return (
    <div className="res-winbar">
      <div className="res-winbar-track">
        <div className="res-winbar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ color, fontWeight: 600, fontSize: 12 }}>{pct}%</span>
    </div>
  );
}

function SafetyBanner() {
  return (
    <div className="res-safety-banner">
      <span>🔒</span>
      <span className="res-safety-green">Riktig handel är avstängd</span>
      <span className="res-safety-muted">· Bara analys · Inga riktiga orders</span>
    </div>
  );
}

function DailyReportCard({ title, rows, conclusion }) {
  return (
    <div className="res-daily-card">
      <div className="res-daily-card-title">{title}</div>
      <div className="res-daily-rows">
        {rows.map((row) => (
          <div key={row.label} className="res-daily-row">
            <span>{row.label}</span>
            <strong>{safeText(row.value, row.fallback || 'För lite data')}</strong>
          </div>
        ))}
      </div>
      {conclusion && <div className="res-daily-conclusion">{safeText(conclusion)}</div>}
    </div>
  );
}

function DailySystemReport() {
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/results/daily-intelligence').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/pipeline/daily/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/pipeline/daily/recent?limit=5').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([daily, st, rec]) => {
      setReport(daily);
      setStatus(st);
      setRecent(rec?.runs || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function postAction(url, runningLabel) {
    setMessage('');
    setRunning(true);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions_allowed: false, can_place_orders: false, live_trading_enabled: false }) })
      .then(async r => ({ ok: r.ok, body: await r.json().catch(() => null) }))
      .catch(e => ({ ok: false, body: { error: e.message } }));
    setRunning(false);
    setMessage(res.body?.error || runningLabel || (res.ok ? 'Klart.' : 'Kunde inte köra åtgärden.'));
    load();
  }

  if (loading) return <div className="res-loading">Laddar daglig systemrapport...</div>;
  const data = report || {};
  const cfg = status?.config || {};
  const dataFetch = data.data_fetch || {};
  const replay = data.replay || {};
  const batch = data.batch || {};
  const paper = data.paper || {};
  const ai = data.ai_summary || {};
  const safety = data.safety || {};

  return (
    <div className="res-daily-panel">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">Daglig systemrapport</h2>
          <p className="res-section-sub">Historik och analys för data, replay, batch och lärande. Inte live trading och inte runtime.</p>
        </div>
        <button className="res-mini-action" type="button" onClick={load}>Uppdatera</button>
      </div>

      <div className="res-daily-control">
        <div>
          <div className="res-subsection-title">Avancerad pipeline / datajobb</div>
          <div className="res-daily-muted">Detta är en test- och data pipeline, inte live trading. Operativ kontroll hör hemma i Daytrading och safety i System → Safety.</div>
        </div>
        <div className="res-daily-status">
          <span className={status?.enabled ? 'res-daily-on' : 'res-daily-off'}>{status?.enabled ? 'På' : 'Av'}</span>
          <span>Senaste: {fmtActivityTime(status?.last_run_at || data.last_run_at)}</span>
          <span>Nästa: {fmtActivityTime(status?.next_run_at)}</span>
        </div>
        <div className="res-daily-actions">
          <button type="button" onClick={() => postAction('/api/pipeline/daily/run-now', 'Daglig pipeline körd.')} disabled={running || status?.daily_pipeline_running}>
            {running || status?.daily_pipeline_running ? 'Kör...' : 'Kör avancerad pipeline nu'}
          </button>
          <button type="button" onClick={() => postAction('/api/pipeline/daily/enable', 'Automatisk körning aktiverad.')} disabled={running || status?.enabled}>Aktivera pipeline-körning</button>
          <button type="button" onClick={() => postAction('/api/pipeline/daily/disable', 'Automatisk körning avstängd.')} disabled={running || !status?.enabled}>Stäng av pipeline-körning</button>
        </div>
      </div>
      {message && <div className="res-daily-message">{message}</div>}

      <div className="res-daily-grid">
        <DailyReportCard
          title="Datahämtning"
          rows={[
            { label: 'Senaste körning', value: fmtActivityTime(data.last_run_at) },
            { label: 'Symboler hämtade', value: `${safeNumber(dataFetch.symbols_loaded, 0)}/${safeNumber(dataFetch.symbols_requested, 0)}` },
            { label: 'Candles hämtade', value: safeNumber(dataFetch.candles_loaded, 0) },
            { label: 'Dataproblem', value: (dataFetch.warnings || []).slice(0, 2).join(' · ') || 'Inga dataproblem' },
          ]}
          conclusion={dataFetch.conclusion_sv || (dataFetch.status === 'missing' ? 'Ingen prisdata' : 'För lite data')}
        />
        <DailyReportCard
          title="Auto Replay"
          rows={[
            { label: 'Senaste replay', value: replay.session_id || 'Ingen replay körd' },
            { label: 'Händelser', value: safeNumber(replay.events_total, 0) },
            { label: 'Simulerade trades', value: safeNumber(replay.trades_total, 0) },
            { label: 'P/L', value: replay.pnl === '' ? 'För lite data' : fmtPct(replay.pnl) },
            { label: 'Win rate', value: replay.win_rate === '' ? 'För lite data' : `${safeNumber(replay.win_rate, 0)}%` },
          ]}
          conclusion={replay.conclusion_sv || 'Ingen replay körd'}
        />
        <DailyReportCard
          title="Auto Batch-test"
          rows={[
            { label: 'Senaste batch', value: batch.batch_id || 'Ingen batch körd' },
            { label: 'Kombinationer', value: `${safeNumber(batch.completed_total, 0)}/${safeNumber(batch.combinations_total, 0)}` },
            { label: 'Bästa strategi', value: batch.best_strategy || 'Ingen batch körd' },
            { label: 'Bästa symbol', value: batch.best_symbol || 'För lite data' },
            { label: 'Score', value: safeNumber(batch.best_score, 0) },
          ]}
          conclusion={batch.conclusion_sv || 'Ingen batch körd'}
        />
        <DailyReportCard
          title="Paper Trading"
          rows={[
            { label: 'Låtsastrades idag', value: safeNumber(paper.trades_today, 0) },
            { label: 'Total win rate', value: paper.win_rate === '' ? 'Inga låtsastrades ännu' : `${safeNumber(paper.win_rate, 0)}%` },
            { label: 'Snitt P/L', value: paper.avg_pnl === '' ? 'Inga låtsastrades ännu' : fmtPct(paper.avg_pnl) },
            { label: 'Öppna positioner', value: safeNumber(paper.open_positions, 0) },
          ]}
          conclusion={paper.conclusion_sv || 'Inga låtsastrades ännu'}
        />
        <DailyReportCard
          title="AI-slutsats"
          rows={[
            { label: 'Vad fungerade bäst', value: (ai.recommended_strategies || []).join(', ') || ai.main_conclusion_sv || 'För lite data' },
            { label: 'Vad bör undvikas', value: (ai.strategies_to_avoid || []).join(', ') || 'För lite data' },
            { label: 'Nästa test', value: (ai.next_test_plan || []).slice(0, 2).join(' · ') || 'För lite data' },
          ]}
          conclusion={ai.main_conclusion_sv || 'För lite data'}
        />
        <DailyReportCard
          title="Safety"
          rows={[
            { label: 'Inga riktiga orders', value: 'Ja' },
            { label: 'actions_allowed', value: String(safety.actions_allowed === true ? true : false) },
            { label: 'can_place_orders', value: String(safety.can_place_orders === true ? true : false) },
            { label: 'live_trading_enabled', value: String(safety.live_trading_enabled === true ? true : false) },
          ]}
          conclusion="All automation är test, replay, batch, paper och analys only."
        />
      </div>

      {recent.length > 0 && (
        <div className="res-daily-recent">
          <div className="res-subsection-title">Senaste resultat</div>
          {recent.map((run) => (
            <div key={run.run_id} className="res-activity-row">
              <span>{fmtActivityTime(run.completed_at || run.started_at)}</span>
              <strong>{run.pipeline_status}</strong>
              <span>{run.data_fetch?.symbols_loaded ?? 0} symboler · {run.replay?.events_total ?? 0} replay-events</span>
              <em>{run.error_count ?? 0} fel</em>
            </div>
          ))}
        </div>
      )}
      <div className="res-daily-muted">Config: {cfg.cron || '0 2 * * *'} · {cfg.timezone || 'Europe/Stockholm'} · notifications off · live trading off</div>
    </div>
  );
}

// ── Tab: Översikt ─────────────────────────────────────────────────────────────
function OversiktTab() {
  const { test } = useUnifiedConfig('results');
  const perf = test.setupPerformance;
  const paper = test.paperPerformance;
  const [ls, setLs] = useState(null);
  const [replay, setReplay] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/history/learning-summary').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/replay/latest').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([l, rp]) => {
      setLs(l);
      setReplay(rp);
    });
  }, []);

  const topSetups = perf?.topSetups?.length ?? 0;
  const poorSetups = perf?.poorSetups?.length ?? 0;
  const overallWR = ls?.overallWinRate != null ? Math.round(ls.overallWinRate * 100) : null;
  const totalSignals = ls?.totalSignals ?? 0;
  const paperTrades = paper?.totalTrades ?? 0;
  const paperWR = paper?.winRate != null ? Math.round(paper.winRate * 100) : null;
  const paperPnl = paper?.totalPnlPct ?? null;

  return (
    <div className="res-tab-content">
      <DailySystemReport />
      <h2 className="res-section-h2">Systemöversikt</h2>
      <div className="res-metrics-row">
        <MetricCard icon="📊" value={overallWR != null ? `${overallWR}%` : '–'} label="Total träffsäkerhet" sub={`${totalSignals} signaler totalt`} color={overallWR >= 55 ? 'green' : overallWR >= 45 ? 'yellow' : 'red'} />
        <MetricCard icon="🎯" value={topSetups} label="Bra mönster" sub="Historiskt lönsamma" color="green" />
        <MetricCard icon="⚠️" value={poorSetups} label="Svaga mönster" sub="Undvik just nu" color="red" />
        <MetricCard icon="🧪" value={paperTrades} label="Låtsastrades" sub="Paper trading totalt" color="blue" />
        {paperWR != null && <MetricCard icon="💰" value={`${paperWR}%`} label="Paper träffsäkerhet" sub={paperPnl != null ? fmtPct(paperPnl) + ' snitt P/L' : ''} color={paperWR >= 55 ? 'green' : 'yellow'} />}
      </div>

      <div className="res-quick-links">
        <Link to="/daytrading" className="res-quick-btn">◉ DAYTRADING — operativ kontroll</Link>
        <Link to="/lab" className="res-quick-btn">🧪 LAB — analys &amp; test</Link>
        <Link to="/system?tab=safety" className="res-quick-btn">🛡️ SYSTEM — safety &amp; skyddsstatus</Link>
        <Link to="/insikter?tab=data-center" className="res-quick-btn">▣ Data Center — all historik</Link>
      </div>
    </div>
  );
}

// ── Tab: Mönsterresultat ──────────────────────────────────────────────────────
function SetupsTab() {
  const { test, meta } = useUnifiedConfig('results');
  const data = test.setupPerformance;
  const loading = meta.loading && !data;

  if (loading) return <div className="res-loading">Laddar mönsterresultat...</div>;
  if (!data) return <div className="res-empty">Kunde inte hämta data.</div>;

  const allSetups = [
    ...(data.topSetups || []),
    ...(data.poorSetups || []),
    ...(data.neutralSetups || []),
  ].sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0));

  if (!allSetups.length) return <div className="res-empty">Inga mönster ännu. Kör historisk analys för att fylla på.</div>;

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <h2 className="res-section-h2">Mönsterresultat</h2>
        <span className="res-count">{allSetups.length} mönster</span>
      </div>
      <div className="res-setup-list">
        {allSetups.map(s => (
          <div key={s.setup_id} className={`res-setup-card res-setup-${s.category}`}>
            <div className="res-setup-header">
              <div>
                <div className="res-setup-label">{s.label}</div>
                <div className={`res-setup-badge res-badge-${s.category}`}>{s.label_sv || s.category}</div>
              </div>
              <div className="res-setup-pnl">
                <div className={`res-pnl-big ${(s.avg_pnl_pct ?? 0) >= 0 ? 'res-pnl-pos' : 'res-pnl-neg'}`}>
                  {fmtPct(s.avg_pnl_pct)}
                </div>
                <div className="res-pnl-label">snitt P/L</div>
              </div>
            </div>
            <WinBar wr={s.win_rate} />
            <div className="res-setup-meta">
              <span>{s.total_trades} trades</span>
              <span className="res-wins">{s.wins} vinn</span>
              <span className="res-losses">{s.losses} förlust</span>
              <span className="res-ties">{s.ties ?? 0} timeout</span>
              {s.best_symbol && <span className="res-sym">Bäst: {s.best_symbol}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab: AI-resultat ──────────────────────────────────────────────────────────
function AiTab() {
  const [status, setStatus] = useState(null);
  const [agents, setAgents] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/intelligence/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/tradingagents/results/status').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, a]) => {
      setStatus(s);
      setAgents(a);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="res-loading">Laddar AI-data...</div>;

  return (
    <div className="res-tab-content">
      <h2 className="res-section-h2">AI-resultat</h2>

      {status && (
        <div className="res-ai-section">
          <div className="res-subsection-title">Intelligensmotor</div>
          <div className="res-metrics-row">
            <MetricCard value={status.analysisCount ?? '–'} label="Analyser totalt" />
            <MetricCard value={status.symbolsAnalyzed ?? '–'} label="Symboler analyserade" />
            {status.avgConfidence != null && (
              <MetricCard
                value={`${Math.round(status.avgConfidence * 100)}%`}
                label="Snitt AI-styrka"
                color={status.avgConfidence >= 0.7 ? 'green' : 'yellow'}
              />
            )}
          </div>
        </div>
      )}

      {agents && (
        <div className="res-ai-section">
          <div className="res-subsection-title">Tradingagenter</div>
          <div className="res-metrics-row">
            <MetricCard value={agents.totalAnalyses ?? '–'} label="Agentanalyser" />
            <MetricCard value={agents.symbolsCovered ?? '–'} label="Symboler täckta" />
          </div>
        </div>
      )}

      {!status && !agents && (
        <div className="res-empty">Ingen AI-data tillgänglig ännu.</div>
      )}

      <div className="res-ai-nav">
        <Link to="/intelligence" className="res-ai-link">🧠 Gå till Intelligens →</Link>
      </div>
    </div>
  );
}

// ── Tab: Replay ───────────────────────────────────────────────────────────────
function ReplayTab() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/replay/runs')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const list = d?.runs || d || [];
        setRuns(Array.isArray(list) ? list.slice(0, 10) : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="res-loading">Laddar replay...</div>;

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <h2 className="res-section-h2">Historiska tester (Replay)</h2>
        <Link to="/replay" className="res-nav-link">Öppna Replay →</Link>
      </div>

      {runs.length === 0 ? (
        <div className="res-empty">Inga replay-sessioner ännu. Gå till Replay för att starta ett test.</div>
      ) : (
        <div className="res-replay-list">
          {runs.map((run, i) => (
            <div key={run.runId || i} className="res-replay-card">
              <div className="res-replay-header">
                <span className="res-replay-id">{run.runId || `Run ${i + 1}`}</span>
                <span className="res-replay-date">
                  {run.startTime ? new Date(run.startTime).toLocaleDateString('sv-SE') : ''}
                </span>
              </div>
              <div className="res-replay-meta">
                {run.totalSignals != null && <span>{run.totalSignals} signaler</span>}
                {run.winRate != null && <span className="res-wins">{Math.round(run.winRate * 100)}% träffsäkerhet</span>}
                {run.avgPnl != null && <span className={run.avgPnl >= 0 ? 'res-wins' : 'res-losses'}>{fmtPct(run.avgPnl)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Låtsastrades ─────────────────────────────────────────────────────────
function PaperTab() {
  const { test, meta } = useUnifiedConfig('results');
  const data = test.paperPerformance;
  const [trades, setTrades] = useState([]);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [selectedTradeId, setSelectedTradeId] = useState('');

  useEffect(() => {
    fetch('/api/paper-trading/trades').then(r => r.ok ? r.json() : null).then((tr) => {
      const list = tr?.trades || tr || [];
      setTrades(Array.isArray(list) ? list.slice(0, 20) : []);
      setTradesLoading(false);
    }).catch(() => setTradesLoading(false));
  }, []);

  const loading = (meta.loading && !data) || tradesLoading;
  if (loading) return <div className="res-loading">Laddar låtsastrades...</div>;

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <h2 className="res-section-h2">Historiska paper trades</h2>
        <Link to="/paper-trading" className="res-nav-link">Gå till Låtsastrading →</Link>
      </div>
      <div className="res-daily-muted">Det här är historik över redan skapade paper trades. Nya val för runtime och paper görs i Daytrading. Gamla trades kan bära äldre strateginamn och äldre routingregler.</div>

      {data && (
        <div className="res-metrics-row">
          <MetricCard value={data.totalTrades ?? '–'} label="Trades totalt" />
          {data.winRate != null && (
            <MetricCard
              value={`${Math.round(data.winRate * 100)}%`}
              label="Träffsäkerhet"
              color={data.winRate >= 0.55 ? 'green' : 'yellow'}
            />
          )}
          {data.totalPnlPct != null && (
            <MetricCard
              value={fmtPct(data.totalPnlPct)}
              label="Total P/L"
              color={data.totalPnlPct >= 0 ? 'green' : 'red'}
            />
          )}
          {data.avgPnlPct != null && (
            <MetricCard
              value={fmtPct(data.avgPnlPct)}
              label="Snitt P/L"
              color={data.avgPnlPct >= 0 ? 'green' : 'red'}
            />
          )}
        </div>
      )}

      {trades.length > 0 && (
        <>
          <div className="res-subsection-title">Senaste trades</div>
          <div className="res-trade-list">
            {trades.map((t, i) => (
              <div key={t.tradeId || i} className="res-trade-row">
                <span className="res-trade-sym">{t.symbol || '–'}</span>
                <span className={`res-trade-type ${['LONG', 'UP', 'BUY'].includes(t.direction || t.type) ? 'res-long' : 'res-short'}`}>
                  {t.direction || t.type || '–'}
                </span>
                <span className={`res-trade-pnl ${(t.pnlPct ?? t.pnl ?? 0) >= 0 ? 'res-pnl-pos' : 'res-pnl-neg'}`}>
                  {fmtPct(t.pnlPct ?? t.pnl)}
                </span>
                <span className="res-trade-date">
                  {fmtActivityTime(t.closed_at || t.closedAt || t.exitTime || t.opened_at || t.entryTime)}
                </span>
                <span className="res-trade-date">{t.duration_label || '–'}</span>
                <button className="res-mini-action" type="button" onClick={() => setSelectedTradeId(t.tradeId || t.trade_id)}>
                  Analysera trade
                </button>
              </div>
            ))}
          </div>
          <TradeReplayPanel tradeId={selectedTradeId} onClose={() => setSelectedTradeId('')} />
        </>
      )}

      {!data && trades.length === 0 && (
        <div className="res-empty">Inga låtsastrades ännu. Starta paper trading för att börja.</div>
      )}
    </div>
  );
}

function ActivityTab() {
  const [filter, setFilter] = useState('all');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTradeId, setSelectedTradeId] = useState('');
  const filters = [
    { key: 'all', label: 'Alla' },
    { key: 'trades', label: 'Trades' },
    { key: 'batches', label: 'Batch' },
    { key: 'candidates', label: 'Kandidater' },
    { key: 'blockers', label: 'Blockers' },
  ];

  useEffect(() => {
    setLoading(true);
    const url = filter === 'all' ? '/api/audit/recent?limit=80'
      : filter === 'trades' ? '/api/audit/trades/recent?limit=80'
      : filter === 'batches' ? '/api/audit/batches/recent?limit=80'
      : filter === 'candidates' ? '/api/audit/candidates/recent?limit=80'
      : '/api/audit/recent?category=blockers&limit=80';
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setEvents(d?.events || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [filter]);

  function replayIdForEvent(event) {
    return event?.details?.trade_id || event?.details?.tradeId || event?.details?.paper_event_id || event?.event_id || '';
  }

  function isPaperTradeEvent(event) {
    return ['PAPER_TRADE_OPENED', 'PAPER_TRADE_CLOSED'].includes(String(event?.type || '').toUpperCase());
  }

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <h2 className="res-section-h2">Aktivitet</h2>
        <span className="res-count">{events.length} events</span>
      </div>

      <div className="res-activity-filters">
        {filters.map(item => (
          <button key={item.key} type="button" className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="res-loading">Laddar aktivitet...</div>
      ) : events.length > 0 ? (
        <div className="res-activity-list">
          {events.map(event => (
            <div key={event.event_id} className={`res-activity-row res-activity-${String(event.type || '').toLowerCase()}`}>
              <span className="res-activity-time">{fmtActivityTime(event.timestamp)}</span>
              <strong>{event.symbol || event.details?.batch_id || 'System'}</strong>
              <span>{event.message || event.type}</span>
              <em>{event.details?.duration_label || (event.details?.progress?.pct != null ? `${event.details.progress.pct}%` : event.source)}</em>
              {isPaperTradeEvent(event) && (
                <button className="res-mini-action" type="button" onClick={() => setSelectedTradeId(replayIdForEvent(event))}>
                  Analysera trade
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="res-empty">Ingen aktivitet i audit-loggen ännu.</div>
      )}
      <TradeReplayPanel tradeId={selectedTradeId} onClose={() => setSelectedTradeId('')} />
    </div>
  );
}

// ── Tab: Inlärning ────────────────────────────────────────────────────────────
function LarningTab() {
  const [ls, setLs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/history/learning-summary')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setLs(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="res-loading">Laddar inlärningsdata...</div>;
  if (!ls) return <div className="res-empty">Ingen inlärningsdata tillgänglig. Kör historisk analys.</div>;

  const bySymbol = Object.entries(ls.bySymbol || {})
    .filter(([, v]) => v.samples >= 3)
    .sort(([, a], [, b]) => (b.winRate ?? 0) - (a.winRate ?? 0))
    .slice(0, 20);

  const overallWR = ls.overallWinRate != null ? Math.round(ls.overallWinRate * 100) : null;

  return (
    <div className="res-tab-content">
      <h2 className="res-section-h2">Inlärning</h2>

      <div className="res-metrics-row">
        {overallWR != null && (
          <MetricCard
            icon="📊"
            value={`${overallWR}%`}
            label="Total träffsäkerhet"
            sub={`${ls.totalSignals ?? 0} signaler`}
            color={overallWR >= 55 ? 'green' : overallWR >= 45 ? 'yellow' : 'red'}
          />
        )}
        {ls.worstSymbols?.length > 0 && (
          <MetricCard icon="⚠️" value={ls.worstSymbols.length} label="Svaga symboler" sub="Undvik" color="red" />
        )}
      </div>

      {bySymbol.length > 0 && (
        <>
          <div className="res-subsection-title">Bäst presterande symboler</div>
          <div className="res-learn-list">
            {bySymbol.map(([sym, stats]) => (
              <div key={sym} className="res-learn-row">
                <span className="res-learn-sym">{sym}</span>
                <WinBar wr={stats.winRate != null ? Math.round(stats.winRate * 100) : null} />
                <span className="res-learn-count">{stats.samples} st</span>
              </div>
            ))}
          </div>
        </>
      )}

      {ls.worstSymbols?.length > 0 && (
        <>
          <div className="res-subsection-title res-poor-label">Undvik dessa symboler just nu</div>
          <div className="res-worst-chips">
            {ls.worstSymbols.map(s => (
              <span key={s.key || s} className="res-worst-chip">{s.key || s}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CandidatesTab() {
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/candidates/stats').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/candidates/recent?n=20').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, r]) => {
      setStats(s);
      setRecent(r?.candidates || []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="res-loading">Laddar kandidatstatistik...</div>;

  return (
    <div className="res-tab-content">
      <h2 className="res-section-h2">Kandidater</h2>
      <div className="res-metrics-row">
        <MetricCard value={stats?.total ?? recent.length} label="Kandidater" />
        <MetricCard value={stats?.last24h ?? '–'} label="Senaste 24h" />
        <MetricCard value="Nej" label="Kan lägga orders" color="red" />
      </div>
      {recent.length === 0 ? (
        <PlatformEmptyState title="Inga kandidater loggade" text="Kandidater visas när scanner, riskmotor och låtsastrading har testdata." />
      ) : (
        <div className="res-trade-list">
          {recent.map((c, i) => (
            <div key={`${c.symbol || 'candidate'}-${c.timestamp || i}`} className="res-trade-row">
              <span className="res-trade-sym">{c.symbol || '–'}</span>
              <span>{c.signalFamily || c.setup || c.eventType || 'Mönster saknas'}</span>
              <span>{c.tradeScore ?? c.score ?? '–'} styrka</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StrategyPerfRow({ strategy, tone }) {
  if (!strategy) return null;
  const badge = strategy.performance_badge;
  return (
    <div className={`res-setup-card res-setup-${tone || (badge?.tone === 'bad' ? 'poor' : 'top')}`}>
      <div className="res-setup-header">
        <div>
          <div className="res-setup-label">{strategy.strategy_name}</div>
          <div className={`res-setup-badge res-badge-${badge?.tone || 'neutral'}`}>{badge?.label || 'Ingen badge'}</div>
        </div>
        <div className="res-setup-pnl">
          <div className={`res-pnl-big ${(strategy.avg_pnl ?? 0) >= 0 ? 'res-pnl-pos' : 'res-pnl-neg'}`}>
            {fmtPct(strategy.avg_pnl)}
          </div>
          <div className="res-pnl-label">snitt P/L</div>
        </div>
      </div>
      <WinBar wr={strategy.win_rate} />
      <div className="res-setup-meta">
        <span>{strategy.trades} trades</span>
        <span className="res-wins">{strategy.wins} vinn</span>
        <span className="res-losses">{strategy.losses} förlust</span>
        <span className="res-ties">{strategy.timeouts} timeout</span>
        {strategy.best_market && <span>Bästa marknad: {strategy.best_market.market_group}</span>}
        {strategy.best_params && <span>Bäst: {strategy.best_params.label}</span>}
      </div>
    </div>
  );
}

function DaytradingStrategiesTab() {
  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <h2 className="res-section-h2">Daytrading-strategier</h2>
      </div>
      <div className="dt-moved-notice">
        <div className="dt-moved-icon">📡</div>
        <div className="dt-moved-body">
          <div className="dt-moved-title">Daytrading-strategier har flyttats till en egen live-sida.</div>
          <div className="dt-moved-text">
            Den nya sidan Daytrading Control Center ger livekontroll för strategier, signaler, pipeline och paper trades.
            Insikter fokuserar på historik och lärande.
          </div>
          <Link to="/daytrading" className="dt-moved-btn">Öppna Daytrading Control Center</Link>
        </div>
      </div>
    </div>
  );
}

function DataTone({ tone, label }) {
  const text = label || (tone === 'green' ? 'Bra data' : tone === 'yellow' ? 'Lite data' : 'Saknar data');
  return <span className={`dc-tone dc-tone-${tone || 'yellow'}`}>{text}</span>;
}

function DataCenterCard({ label, value, sub, tone = 'green' }) {
  return (
    <div className={`dc-card dc-card-${tone}`}>
      <div className="dc-card-label">{label}</div>
      <div className="dc-card-value">{value ?? '–'}</div>
      {sub && <div className="dc-card-sub">{sub}</div>}
    </div>
  );
}

function DataCenterList({ rows, empty, render }) {
  if (!rows?.length) return <div className="res-empty">{empty || 'Ingen data hittad.'}</div>;
  return <div className="dc-list">{rows.map(render)}</div>;
}

function DataCenterTab() {
  const [data, setData] = useState(null);
  const [symbols, setSymbols] = useState([]);
  const [storage, setStorage] = useState(null);
  const [missing, setMissing] = useState(null);
  const [coverageStatus, setCoverageStatus] = useState(null);
  const [coverageSymbols, setCoverageSymbols] = useState([]);
  const [coverageMarkets, setCoverageMarkets] = useState([]);
  const [backfillPlan, setBackfillPlan] = useState([]);
  const [backfillJobs, setBackfillJobs] = useState([]);
  const [coverageMessage, setCoverageMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      fetch('/api/data-center/summary').then(r => r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`))),
      fetch('/api/data-center/symbols').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-center/storage').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-center/missing').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/status').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/symbols').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/markets').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/plan').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/data-coverage/backfill').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([summary, syms, store, miss, covStatus, covSymbols, covMarkets, plan, jobs]) => {
      setData(summary);
      setSymbols(syms?.symbols || []);
      setStorage(store?.storage || null);
      setMissing(miss?.missing || null);
      setCoverageStatus(covStatus || null);
      setCoverageSymbols(covSymbols?.symbols || []);
      setCoverageMarkets(covMarkets?.markets || []);
      setBackfillPlan(plan?.plan || []);
      setBackfillJobs(jobs?.jobs || []);
      setLoading(false);
    }).catch((err) => {
      setError(err.message || 'Kunde inte hämta Data Center.');
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="res-loading">Laddar Data Center...</div>;
  if (error || !data) return <div className="res-empty">Kunde inte hämta Data Center. {error}</div>;

  const counts = data.counts || {};
  const health = data.health || {};
  const redis = data.redis_usage || {};
  const mem = data.memory_usage || {};
  const markets = data.markets || [];
  const replay = data.replay_coverage || {};
  const strategy = data.strategy_coverage || {};
  const storageRows = storage?.paths || [];
  const missingRows = (missing?.symbols_missing || []).slice(0, 14);
  const weakRows = (missing?.symbols_weak || []).slice(0, 10);
  const topSymbols = [...symbols].slice(0, 18);
  const coverageRows = coverageSymbols.slice(0, 28);
  const weakMarkets = coverageMarkets.filter((m) => m.missing_count > 0 || m.weak_count > 0).slice(0, 6);
  const activeJobs = backfillJobs.filter((job) => ['created', 'running', 'paused'].includes(job.status)).slice(0, 8);

  async function postCoverage(url, body) {
    setCoverageMessage('');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async r => ({ ok: r.ok, body: await r.json().catch(() => null) })).catch(e => ({ ok: false, body: { error: e.message } }));
    setCoverageMessage(res.body?.message_sv || res.body?.error || (res.ok ? 'Klart.' : 'Kunde inte utföra åtgärden.'));
    await load();
    return res;
  }

  async function createPlanJob(rows = backfillPlan.slice(0, 10)) {
    const selected = rows.map((row) => row.symbol).filter(Boolean);
    if (!selected.length) return;
    await postCoverage('/api/data-coverage/backfill', {
      symbols: selected,
      timeframes: ['2m'],
      from_date: rows[0]?.suggested_from_date,
      to_date: rows[0]?.suggested_to_date,
      provider: 'auto',
      actions_allowed: false,
      can_place_orders: false,
      live_trading_enabled: false,
    });
  }

  async function createSymbolJob(symbol) {
    if (!symbol) return;
    await createPlanJob([{ symbol, suggested_from_date: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), suggested_to_date: new Date().toISOString().slice(0, 10) }]);
  }

  return (
    <div className="res-tab-content dc-panel">
      <div className="res-section-header">
        <div>
          <h2 className="res-section-h2">Data Center</h2>
          <p className="res-section-sub">All historisk data systemet hittar i storage. Bara läsning.</p>
        </div>
        <button className="res-mini-action" type="button" onClick={load}>Uppdatera</button>
      </div>

      <div className="dc-health">
        <DataTone tone={health.tone} label={health.message_sv} />
        <span>{fmtInt(health.good_symbols)} bra symboler</span>
        <span>{fmtInt(health.weak_symbols)} med lite data</span>
        <span>{fmtInt(health.missing_symbols)} saknar data</span>
        <span>Uppdaterad {fmtActivityTime(data.generated_at)}</span>
      </div>

      <div className="dc-card-grid">
        <DataCenterCard label="Replay candles" value={fmtInt(counts.replay_candles)} sub={`${fmtInt(replay.runs)} replay-runs`} tone={counts.replay_candles > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Paper trades" value={fmtInt(counts.paper_trades)} sub="Låtsastrading totalt" tone={counts.paper_trades > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Audit events" value={fmtInt(counts.audit_events)} sub="Audit trail" tone={counts.audit_events > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Batch tests" value={fmtInt(counts.batch_tests)} sub={`${fmtInt(counts.strategy_batch_result_rows)} resultat-rader`} tone={counts.batch_tests > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="Strategy tests" value={fmtInt(counts.strategy_tests)} sub={`${fmtInt(strategy.unique_strategies)} strategier`} tone={counts.strategy_tests > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="Signaler" value={fmtInt(counts.signals)} sub={`${fmtInt(counts.signal_outcomes)} utfall`} tone={counts.signals > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Kandidater" value={fmtInt(counts.candidates)} sub="Candidate log" tone={counts.candidates > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="AI lessons" value={fmtInt(counts.ai_lessons)} sub="Signalminne" tone={counts.ai_lessons > 0 ? 'green' : 'yellow'} />
        <DataCenterCard label="Symboler med historik" value={fmtInt(counts.symbols_with_history)} sub={`${fmtInt(counts.markets_with_data)} marknader`} tone={counts.symbols_with_history > 0 ? 'green' : 'red'} />
        <DataCenterCard label="Första datum" value={fmtDate(data.date_range?.first_date)} sub="Äldsta historik" tone={data.date_range?.first_date ? 'green' : 'red'} />
        <DataCenterCard label="Senaste datum" value={fmtDate(data.date_range?.latest_date)} sub="Nyaste historik" tone={data.date_range?.latest_date ? 'green' : 'red'} />
      </div>

      <div className="dc-coverage-box">
        <div className="res-section-header">
          <div>
            <h2 className="res-section-h2">Data Coverage</h2>
            <p className="res-section-sub">Visar om symboler är redo för replay, batch-test och AI-inlärning.</p>
          </div>
          <DataTone tone={(coverageStatus?.total_coverage_score || 0) >= 70 ? 'green' : (coverageStatus?.total_coverage_score || 0) >= 35 ? 'yellow' : 'red'} label={`${fmtInt(coverageStatus?.total_coverage_score)} / 100`} />
        </div>
        <div className="dc-card-grid">
          <DataCenterCard label="Coverage score" value={`${fmtInt(coverageStatus?.total_coverage_score)} / 100`} sub="Total datatäckning" tone={(coverageStatus?.total_coverage_score || 0) >= 70 ? 'green' : 'yellow'} />
          <DataCenterCard label="Redo för replay" value={fmtInt(coverageStatus?.symbols_ready_for_replay)} sub="Symboler" tone="green" />
          <DataCenterCard label="Redo för batch-test" value={fmtInt(coverageStatus?.symbols_ready_for_batch)} sub="Symboler" tone="green" />
          <DataCenterCard label="Saknar data" value={fmtInt(coverageStatus?.symbols_missing_data)} sub="Symboler" tone={(coverageStatus?.symbols_missing_data || 0) > 0 ? 'red' : 'green'} />
        </div>
        {weakMarkets.length > 0 && (
          <>
            <div className="res-subsection-title">Marknader med svag data</div>
            <div className="dc-list">
              {weakMarkets.map((m) => (
                <div key={m.market_group} className="dc-row">
                  <strong>{m.label_sv}</strong>
                  <span>{fmtInt(m.good_count)} bra</span>
                  <span>{fmtInt(m.weak_count)} lite</span>
                  <span>{fmtInt(m.missing_count)} saknar</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="res-subsection-title">Symbol coverage</div>
      <div className="dc-table">
        <div className="dc-table-head">
          <span>Symbol</span><span>Marknad</span><span>Dagar</span><span>Candles</span><span>Status</span><span>Replay</span><span>Batch</span><span>Åtgärd</span>
        </div>
        {coverageRows.map((row) => (
          <div key={row.symbol} className="dc-table-row">
            <strong>{row.symbol}</strong>
            <span>{row.market_group}</span>
            <span>{fmtInt(row.days_covered)}</span>
            <span>{fmtInt(row.candles_count)}</span>
            <DataTone tone={row.data_quality === 'good' ? 'green' : row.data_quality === 'missing' || row.data_quality === 'missing_provider' ? 'red' : 'yellow'} label={row.status_sv || 'Lite data'} />
            <span>{row.usable_for_replay ? 'Ja' : 'Nej'}</span>
            <span>{row.usable_for_batch ? 'Ja' : 'Nej'}</span>
            <button type="button" className="res-mini-action" onClick={() => createSymbolJob(row.symbol)}>Fyll på data</button>
          </div>
        ))}
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Prioriterad backfill-plan</div>
          <div className="dc-info-box">
            <strong>Systemet föreslår att fylla på dessa först</strong>
            {(backfillPlan || []).slice(0, 10).map((row, i) => (
              <span key={row.symbol}>{i + 1}. {row.symbol} · {row.status_sv || 'Behöver backfill'} · {row.reason}</span>
            ))}
            <button type="button" className="res-mini-action" onClick={() => createPlanJob()}>Skapa datajobb (backfill)</button>
          </div>
        </div>
        <div>
          <div className="res-subsection-title">Datajobb / backfill</div>
          {coverageMessage && <div className="res-daily-message">{coverageMessage}</div>}
          <DataCenterList
            rows={activeJobs}
            empty="Inga aktiva backfill-jobb."
            render={(job) => (
              <div key={job.job_id} className="dc-job-row">
                <strong>{job.symbols?.slice(0, 4).join(', ') || 'Backfill'}</strong>
                <span>{job.status}</span>
                <span>{fmtInt(job.progress?.pct)}%</span>
                <span>{fmtInt(job.candles_downloaded)} candles</span>
                <span>{fmtInt(job.errors?.length)} fel</span>
                <div className="dc-job-actions">
                  <button type="button" onClick={() => postCoverage(`/api/data-coverage/backfill/${job.job_id}/run`)}>Starta datajobb</button>
                  <button type="button" onClick={() => postCoverage(`/api/data-coverage/backfill/${job.job_id}/pause`)}>Pausa datajobb</button>
                  <button type="button" onClick={() => postCoverage(`/api/data-coverage/backfill/${job.job_id}/stop`)}>Stoppa datajobb</button>
                </div>
              </div>
            )}
          />
        </div>
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Marknader med mest data</div>
          <DataCenterList
            rows={markets.slice(0, 8)}
            render={(row) => (
              <div key={row.market_group} className="dc-row">
                <strong>{row.label_sv || row.market_group}</strong>
                <span>{fmtInt(row.total_candle_count)} candles</span>
                <span>{fmtInt(row.symbol_count)} symboler</span>
                <DataTone tone={row.good_symbols > 0 ? 'green' : row.weak_symbols > 0 ? 'yellow' : 'red'} />
              </div>
            )}
          />
        </div>
        <div>
          <div className="res-subsection-title">Top traded symbols</div>
          <DataCenterList
            rows={data.top_traded_symbols || []}
            empty="Inga paper trades ännu."
            render={(row) => (
              <div key={row.symbol} className="dc-row">
                <strong>{row.symbol}</strong>
                <span>{fmtInt(row.count)} trades</span>
              </div>
            )}
          />
          <div className="res-subsection-title dc-subtitle-gap">Top replayed symbols</div>
          <DataCenterList
            rows={data.top_replayed_symbols || []}
            empty="Ingen replay-symbol hittad."
            render={(row) => (
              <div key={row.symbol} className="dc-row">
                <strong>{row.symbol}</strong>
                <span>{fmtInt(row.count)} events</span>
              </div>
            )}
          />
        </div>
      </div>

      <div className="res-subsection-title">Data coverage per symbol</div>
      <div className="dc-symbol-grid">
        {topSymbols.map((row) => (
          <div key={row.symbol} className={`dc-symbol dc-symbol-${row.tone}`}>
            <div className="dc-symbol-head">
              <strong>{row.symbol}</strong>
              <DataTone tone={row.tone} />
            </div>
            <div className="dc-symbol-meta">
              <span>{row.market_group}</span>
              <span>{fmtInt(row.candles_2m_count)} 2m candles</span>
              <span>{fmtInt(row.candles_2m_days)} dagar</span>
              <span>{fmtDate(row.first_date)} - {fmtDate(row.latest_date)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title res-poor-label">Saknar data</div>
          <DataCenterList
            rows={missingRows}
            empty="Inga saknade symboler hittades."
            render={(row) => (
              <div key={row.symbol} className="dc-row dc-row-red">
                <strong>{row.symbol}</strong>
                <span>{row.market_group}</span>
                <em>{row.reason_sv}</em>
              </div>
            )}
          />
        </div>
        <div>
          <div className="res-subsection-title">Lite data</div>
          <DataCenterList
            rows={weakRows}
            empty="Inga svaga symboler hittades."
            render={(row) => (
              <div key={row.symbol} className="dc-row dc-row-yellow">
                <strong>{row.symbol}</strong>
                <span>{row.market_group}</span>
                <em>{row.reason_sv}</em>
              </div>
            )}
          />
        </div>
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Replay coverage</div>
          <div className="dc-info-box">
            <strong>{replay.coverage_sv || 'Ingen replay coverage hittad'}</strong>
            <span>Events: {fmtInt(replay.replay_events)}</span>
            <span>Period: {fmtDate(replay.first_date)} - {fmtDate(replay.latest_date)}</span>
          </div>
        </div>
        <div>
          <div className="res-subsection-title">Strategy coverage</div>
          <div className="dc-info-box">
            <strong>{strategy.coverage_sv || 'Ingen strategy coverage hittad'}</strong>
            <span>Batcher: {fmtInt(strategy.batch_tests)}</span>
            <span>Tester: {fmtInt(strategy.strategy_tests)}</span>
            <span>Period: {fmtDate(strategy.first_date)} - {fmtDate(strategy.latest_date)}</span>
          </div>
        </div>
      </div>

      <div className="res-subsection-title">Storage paths</div>
      <div className="dc-storage">
        {storageRows.map((row) => (
          <div key={row.key} className="dc-storage-row">
            <strong>{row.label}</strong>
            <code>{row.rel}</code>
            <span>{fmtBytes(row.bytes)}</span>
            <span>{fmtInt(row.files)} filer</span>
          </div>
        ))}
      </div>

      <div className="dc-two-col">
        <div>
          <div className="res-subsection-title">Redis usage</div>
          <div className="dc-info-box">
            <strong>{redis.mode || 'fallback'}</strong>
            <span>Status: {redis.clientStatus || 'unknown'}</span>
            <span>Keys: {fmtInt(redis.dbsize ?? redis.memoryFallbackKeys)}</span>
            <span>Memory: {redis.used_memory_human || fmtBytes(redis.used_memory_bytes)}</span>
          </div>
        </div>
        <div>
          <div className="res-subsection-title">Memory usage</div>
          <div className="dc-info-box">
            <strong>Node process</strong>
            <span>RSS: {fmtBytes(mem.rss_bytes)}</span>
            <span>Heap used: {fmtBytes(mem.heap_used_bytes)}</span>
            <span>Heap total: {fmtBytes(mem.heap_total_bytes)}</span>
          </div>
        </div>
      </div>

      <div className="batch-safety">Safety: actions_allowed=false · can_place_orders=false · live_trading_enabled=false · read-only.</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ResultatPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') || 'oversikt';
  const tab = TABS.some(t => t.key === requested) ? requested : 'oversikt';

  function changeTab(next) {
    setParams(next === 'oversikt' ? {} : { tab: next });
  }

  return (
    <div className="res-page">
      <PlatformSafetyBar />

      <div className="res-page-header">
        <h1 className="res-page-title">📊 RESULTAT &amp; HISTORIK</h1>
        <p className="res-page-sub">Sammanfattning och historik för mönster, AI, replay, paper och inlärning. För operativ kontroll: Daytrading. För safety: System → Safety.</p>
        <div className="res-daily-muted">Historiska trades kan visa äldre strateginamn och äldre routingregler. Resultat visar historik och analys, inte runtime eller paper-val.</div>
      </div>

      <div className="res-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`res-tab${tab === t.key ? ' res-tab-active' : ''}`}
            onClick={() => changeTab(t.key)}
            type="button"
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'oversikt'  && <OversiktTab />}
      {tab === 'setups'    && <SetupsTab />}
      {tab === 'ai'        && <AiTab />}
      {tab === 'replay'    && <ReplayTab />}
      {tab === 'paper'     && <PaperTab />}
      {tab === 'activity'  && <ActivityTab />}
      {tab === 'daytrading' && <DaytradingStrategiesTab />}
      {tab === 'memory'    && <LarningTab />}
      {tab === 'candidates' && <CandidatesTab />}
      {tab === 'data-center' && <DataCenterTab />}
    </div>
  );
}
