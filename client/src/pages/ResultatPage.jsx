import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PlatformEmptyState, PlatformSafetyBar } from '../components/PlatformControls.jsx';
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
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtActivityTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      <h2 className="res-section-h2">Systemöversikt</h2>
      <div className="res-metrics-row">
        <MetricCard icon="📊" value={overallWR != null ? `${overallWR}%` : '–'} label="Total träffsäkerhet" sub={`${totalSignals} signaler totalt`} color={overallWR >= 55 ? 'green' : overallWR >= 45 ? 'yellow' : 'red'} />
        <MetricCard icon="🎯" value={topSetups} label="Bra mönster" sub="Historiskt lönsamma" color="green" />
        <MetricCard icon="⚠️" value={poorSetups} label="Svaga mönster" sub="Undvik just nu" color="red" />
        <MetricCard icon="🧪" value={paperTrades} label="Låtsastrades" sub="Paper trading totalt" color="blue" />
        {paperWR != null && <MetricCard icon="💰" value={`${paperWR}%`} label="Paper träffsäkerhet" sub={paperPnl != null ? fmtPct(paperPnl) + ' snitt P/L' : ''} color={paperWR >= 55 ? 'green' : 'yellow'} />}
      </div>

      <div className="res-quick-links">
        <Link to="/trading-lab" className="res-quick-btn">🧪 Trading Lab — justera parametrar</Link>
        <Link to="/sakerhet" className="res-quick-btn">🛡️ Säkerhet — se skyddsstatus</Link>
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
        <h2 className="res-section-h2">Låtsastrades (Låtsastrading)</h2>
        <Link to="/paper-trading" className="res-nav-link">Gå till Låtsastrading →</Link>
      </div>

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
              </div>
            ))}
          </div>
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
            </div>
          ))}
        </div>
      ) : (
        <div className="res-empty">Ingen aktivitet i audit-loggen ännu.</div>
      )}
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
  const [data, setData] = useState(null);
  const [compare, setCompare] = useState(null);
  const [batchCompare, setBatchCompare] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/daytrading-strategies/performance').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/daytrading-strategies/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([perf, cmp]) => {
      setData(perf);
      setCompare(cmp);
      setLoading(false);
      fetch('/api/strategy-batches')
        .then(r => r.ok ? r.json() : null)
        .then(list => {
          const latest = (list?.batches || []).find(b => (b.progress?.completed || 0) > 0);
          if (!latest) return null;
          return fetch(`/api/strategy-batches/${latest.id}/compare`).then(r => r.ok ? r.json() : null);
        })
        .then(batch => { if (batch) setBatchCompare(batch); })
        .catch(() => {});
    });
  }, []);

  if (loading) return <div className="res-loading">Laddar daytrading-strategier...</div>;
  const strategies = data?.strategies || [];
  const top = [...strategies].filter(s => s.trades > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  const worst = [...strategies].filter(s => s.trades > 0).sort((a, b) => a.score - b.score).slice(0, 5);
  const needs = strategies.filter(s => s.needs_more_data).slice(0, 8);
  const bestMarkets = strategies.filter(s => s.best_market).slice(0, 8);
  const bestParams = strategies.filter(s => s.best_params).slice(0, 8);

  return (
    <div className="res-tab-content">
      <div className="res-section-header">
        <h2 className="res-section-h2">Daytrading-strategier</h2>
        <span className="res-count">{data.results_count || 0} tester</span>
      </div>
      <div className="res-metrics-row">
        <MetricCard value={top[0]?.strategy_name || '–'} label="Bästa strategi" sub={top[0] ? `${top[0].win_rate}% WR · score ${top[0].score}` : ''} color="green" />
        <MetricCard value={worst[0]?.strategy_name || '–'} label="Sämsta strategi" sub={worst[0] ? `${worst[0].win_rate}% WR · score ${worst[0].score}` : ''} color="red" />
        <MetricCard value={needs.length} label="Behöver mer data" color="yellow" />
        <MetricCard value={compare?.winner?.strategy_name || '–'} label="Jämförelsevinnare" sub={compare?.compared_count ? `${compare.compared_count} jämförda` : ''} />
      </div>

      <div className="res-subsection-title">Bästa strategier</div>
      <div className="res-setup-list">
        {top.length
          ? top.map(s => <StrategyPerfRow key={s.strategy_id} strategy={s} tone="top" />)
          : <PlatformEmptyState title="Ingen strategidata ännu" text="Testa strategier i Trading Lab för att fylla bästa/sämsta och jämförelser." />
        }
      </div>

      <div className="res-subsection-title res-poor-label">Sämsta strategier</div>
      <div className="res-setup-list">
        {worst.length
          ? worst.map(s => <StrategyPerfRow key={s.strategy_id} strategy={s} tone="poor" />)
          : <span className="res-no-data">Inga svaga strategier ännu.</span>
        }
      </div>

      <div className="res-subsection-title">Behöver mer data</div>
      <div className="res-worst-chips">
        {needs.map(s => <span key={s.strategy_id} className="res-worst-chip">{s.strategy_name} · {s.trades} trades</span>)}
        {!needs.length && <span className="res-no-data">Alla testade strategier har minst grunddata.</span>}
      </div>

      <div className="res-subsection-title">Bästa marknad per strategi</div>
      <div className="res-trade-list">
        {bestMarkets.map(s => (
          <div key={`${s.strategy_id}-market`} className="res-trade-row">
            <span className="res-trade-sym">{s.strategy_name}</span>
            <span>{s.best_market.market_group}</span>
            <span>{s.best_market.win_rate}% WR</span>
            <span className={s.best_market.avg_pnl >= 0 ? 'res-pnl-pos' : 'res-pnl-neg'}>{fmtPct(s.best_market.avg_pnl)}</span>
          </div>
        ))}
      </div>

      <div className="res-subsection-title">Bästa SL/TP/hålltid</div>
      <div className="res-trade-list">
        {bestParams.map(s => (
          <div key={`${s.strategy_id}-params`} className="res-trade-row">
            <span className="res-trade-sym">{s.strategy_name}</span>
            <span>{s.best_params.label}</span>
            <span>{s.best_params.win_rate}% WR</span>
            <span className={s.best_params.avg_pnl >= 0 ? 'res-pnl-pos' : 'res-pnl-neg'}>{fmtPct(s.best_params.avg_pnl)}</span>
          </div>
        ))}
      </div>

      <div className="res-subsection-title">Batch-resultat</div>
      {!batchCompare?.batch ? (
        <PlatformEmptyState title="Inga batch-resultat ännu" text="Kör Batch-test i Trading Lab för bästa kombinationer och rekommenderad config." />
      ) : (
        <>
          <div className="res-metrics-row">
            <MetricCard value={batchCompare.recommended_config?.strategy_name || '–'} label="Rekommenderad config" sub={batchCompare.recommended_config?.strategy_id ? `${batchCompare.recommended_config.symbol} · score ${batchCompare.recommended_config.score}` : ''} color="green" />
            <MetricCard value={batchCompare.by_stop_loss?.[0]?.key ?? '–'} label="Bästa SL" sub={batchCompare.by_stop_loss?.[0] ? `score ${batchCompare.by_stop_loss[0].avg_score}` : ''} />
            <MetricCard value={batchCompare.by_take_profit?.[0]?.key ?? '–'} label="Bästa TP" sub={batchCompare.by_take_profit?.[0] ? `score ${batchCompare.by_take_profit[0].avg_score}` : ''} />
            <MetricCard value={batchCompare.by_confidence?.[0]?.key ?? '–'} label="Bästa confidence" sub={batchCompare.by_confidence?.[0] ? `score ${batchCompare.by_confidence[0].avg_score}` : ''} />
          </div>

          <div className="res-subsection-title">Bästa kombinationerna</div>
          <div className="res-trade-list">
            {(batchCompare.best_overall || []).slice(0, 10).map((r, i) => (
              <div key={`${r.batch_id}-${r.strategy_id}-${r.symbol}-${i}`} className="res-trade-row">
                <span className="res-trade-sym">{r.strategy_name}</span>
                <span>{r.symbol}</span>
                <span>SL {r.stop_loss}% / TP {r.take_profit}R / {r.holding_time}m</span>
                <span>{r.win_rate}% WR · score {r.score}</span>
              </div>
            ))}
          </div>

          <div className="res-subsection-title res-poor-label">Sämsta kombinationerna</div>
          <div className="res-trade-list">
            {(batchCompare.worst_overall || []).slice(0, 8).map((r, i) => (
              <div key={`${r.batch_id}-${r.strategy_id}-${r.symbol}-w-${i}`} className="res-trade-row">
                <span className="res-trade-sym">{r.strategy_name}</span>
                <span>{r.symbol}</span>
                <span>{r.win_rate}% WR</span>
                <span className="res-pnl-neg">score {r.score}</span>
              </div>
            ))}
          </div>

          <div className="res-subsection-title">Bästa hålltid och symboler</div>
          <div className="res-trade-list">
            {(batchCompare.by_holding_time || []).slice(0, 5).map(r => (
              <div key={`hold-${r.key}`} className="res-trade-row">
                <span className="res-trade-sym">{r.key} min</span>
                <span>{r.win_rate}% WR</span>
                <span>{fmtPct(r.avg_pnl)}</span>
                <span>score {r.avg_score}</span>
              </div>
            ))}
            {(batchCompare.by_symbol || []).slice(0, 5).map(r => (
              <div key={`sym-${r.key}`} className="res-trade-row">
                <span className="res-trade-sym">{r.key}</span>
                <span>{r.win_rate}% WR</span>
                <span>{fmtPct(r.avg_pnl)}</span>
                <span>score {r.avg_score}</span>
              </div>
            ))}
          </div>
        </>
      )}
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
        <h1 className="res-page-title">📊 Resultat &amp; Historik</h1>
        <p className="res-page-sub">Sammanfattning av mönster, AI-resultat, replay och inlärning.</p>
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
    </div>
  );
}
