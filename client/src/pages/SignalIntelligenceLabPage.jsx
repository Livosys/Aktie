import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../lib/apiClient.js';

const STATUS_OPTIONS = [
  ['all', 'Alla'],
  ['setup', 'Setup'],
  ['detected', 'Detected'],
  ['candidate', 'Candidate'],
  ['entry_ready', 'Entry Ready'],
  ['stopped', 'Stopped'],
  ['intent', 'Intent'],
  ['order_sent', 'Order'],
  ['filled', 'Fill'],
  ['open_trade', 'Trade'],
  ['closed_trade', 'Closed'],
];

function fmtNumber(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('sv-SE', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function fmtInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('sv-SE', { maximumFractionDigits: 0 });
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  return `${fmtNumber(n, 1)}%`;
}

function fmtRR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${fmtNumber(n, 2)}R`;
}

function fmtSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 60) return `${Math.round(n)}s`;
  return `${fmtNumber(n / 60, 1)}m`;
}

function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toneForStatus(status) {
  if (['closed_trade', 'open_trade', 'filled', 'order_sent'].includes(status)) return 'good';
  if (['entry_ready', 'intent', 'candidate'].includes(status)) return 'info';
  if (status === 'stopped') return 'bad';
  return 'neutral';
}

function verdictCopy(value) {
  if (value === 'protective') return 'Räddar';
  if (value === 'overblocking') return 'Hindrar';
  if (value === 'insufficient_data') return 'Datagap';
  return 'Mixed';
}

function toneForVerdict(value) {
  if (value === 'protective') return 'good';
  if (value === 'overblocking') return 'bad';
  if (value === 'insufficient_data') return 'warn';
  return 'neutral';
}

function toneForStage(stage, blocker) {
  if (blocker) return 'bad';
  if (['trade', 'fill', 'exit', 'result'].includes(stage)) return 'good';
  if (['entry_ready', 'candidate_created', 'intent', 'ibkr_order'].includes(stage)) return 'info';
  if (stage === 'extension') return 'warn';
  return 'neutral';
}

function Kpi({ label, value, hint, tone = 'neutral' }) {
  return (
    <div className={`si-kpi is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function StatusPill({ value }) {
  return <span className={`si-pill is-${toneForStatus(value)}`}>{value || '—'}</span>;
}

function VerdictPill({ value }) {
  return <span className={`si-pill is-${toneForVerdict(value)}`}>{verdictCopy(value)}</span>;
}

function DataTable({ columns, rows, emptyText, rowKey }) {
  if (!rows?.length) return <div className="si-empty">{emptyText || 'Ingen data'}</div>;
  return (
    <div className="si-table-wrap">
      <table className="si-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column.key}>{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey ? rowKey(row, index) : row.id || row.signalKey || index}>
              {columns.map((column) => (
                <td key={column.key}>{column.render ? column.render(row, index) : row[column.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReplayPanel({ payload, loading, replayIndex, setReplayIndex, playing, setPlaying }) {
  const replay = payload?.replay;
  const steps = replay?.steps || [];
  const current = steps[replayIndex] || steps[0] || null;
  const canStep = steps.length > 0;

  useEffect(() => {
    if (!playing || !steps.length) return undefined;
    const timer = setInterval(() => {
      setReplayIndex((index) => {
        if (index >= steps.length - 1) {
          setPlaying(false);
          return index;
        }
        return index + 1;
      });
    }, 900);
    return () => clearInterval(timer);
  }, [playing, setPlaying, setReplayIndex, steps.length]);

  if (loading && !payload) return <div className="si-empty">Laddar replay</div>;
  if (!replay) return <div className="si-empty">Ingen signal vald</div>;

  return (
    <div className="si-replay">
      <div className="si-replay-head">
        <div>
          <strong>{replay.symbol || '—'}</strong>
          <span>{replay.strategyId}</span>
        </div>
        <StatusPill value={replay.status} />
      </div>

      <div className="si-step-card">
        <div className="si-step-meta">
          <span>{current ? `${replayIndex + 1}/${steps.length}` : '0/0'}</span>
          <span>{fmtTime(current?.at)}</span>
          <span>{current?.source || '—'}</span>
        </div>
        <h2>{current?.stageLabel || '—'}</h2>
        <p>{current?.label || '—'}</p>
        {current?.blocker ? <span className="si-blocker-chip">{current.blockerLabel || current.blocker}</span> : null}
        <div className="si-step-metrics">
          <span>Score {fmtNumber(current?.metrics?.tradeScore, 1)}</span>
          <span>ATR {fmtNumber(current?.metrics?.atr ?? current?.metrics?.atrMove, 2)}</span>
          <span>Vol {fmtNumber(current?.metrics?.volume ?? current?.metrics?.rvol, 2)}</span>
          <span>Ext {current?.metrics?.extensionLevel || 'none'}</span>
        </div>
      </div>

      <div className="si-player">
        <button type="button" title="Första" aria-label="Första" onClick={() => setReplayIndex(0)} disabled={!canStep}>|&lt;</button>
        <button type="button" title="Föregående" aria-label="Föregående" onClick={() => setReplayIndex((i) => Math.max(0, i - 1))} disabled={!canStep}>&lt;</button>
        <button type="button" title={playing ? 'Pausa' : 'Spela'} aria-label={playing ? 'Pausa' : 'Spela'} onClick={() => setPlaying((value) => !value)} disabled={!canStep}>
          {playing ? 'II' : '▶'}
        </button>
        <button type="button" title="Nästa" aria-label="Nästa" onClick={() => setReplayIndex((i) => Math.min(steps.length - 1, i + 1))} disabled={!canStep}>&gt;</button>
        <button type="button" title="Sista" aria-label="Sista" onClick={() => setReplayIndex(Math.max(0, steps.length - 1))} disabled={!canStep}>&gt;|</button>
      </div>

      <div className="si-timeline">
        {steps.map((step, index) => (
          <button
            key={step.index}
            type="button"
            className={`si-timeline-row is-${toneForStage(step.stage, step.blocker)}${index === replayIndex ? ' is-active' : ''}`}
            onClick={() => setReplayIndex(index)}
          >
            <span className="si-timeline-dot" />
            <span className="si-timeline-time">{fmtTime(step.at)}</span>
            <span className="si-timeline-main">
              <strong>{step.stageLabel}</strong>
              <small>{step.label}</small>
            </span>
            {step.blocker ? <span className="si-timeline-blocker">{step.blocker}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SignalIntelligenceLabPage() {
  const [days, setDays] = useState('7');
  const [status, setStatus] = useState('all');
  const [strategyId, setStrategyId] = useState('all');
  const [search, setSearch] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [overview, setOverview] = useState(null);
  const [counterfactual, setCounterfactual] = useState(null);
  const [error, setError] = useState(null);
  const [counterfactualError, setCounterfactualError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [counterfactualLoading, setCounterfactualLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [signalPayload, setSignalPayload] = useState(null);
  const [signalLoading, setSignalLoading] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set('days', days);
    params.set('limit', '180');
    params.set('tailMb', days === '30' ? '32' : '16');
    if (status !== 'all') params.set('status', status);
    if (strategyId !== 'all') params.set('strategyId', strategyId);
    if (search.trim()) params.set('q', search.trim());
    return params.toString();
  }, [days, status, strategyId, search]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    apiFetch(`/api/signal-intelligence/overview?${query}`)
      .then((payload) => {
        if (!alive) return;
        setOverview(payload);
        const first = payload.recentSignals?.[0];
        const visibleIds = new Set((payload.recentSignals || []).flatMap((signal) => [signal.candidateId, signal.signalKey].filter(Boolean)));
        setSelectedId((current) => {
          if (current && visibleIds.has(current)) return current;
          return first ? (first.candidateId || first.signalKey) : null;
        });
      })
      .catch((err) => {
        if (alive) setError(err?.message || 'signal_intelligence_failed');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [query, refreshToken]);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    params.set('days', days);
    params.set('limit', '260');
    params.set('signalLimit', '80');
    params.set('tailMb', days === '30' ? '32' : '16');
    params.set('minSamples', '3');
    if (strategyId !== 'all') params.set('strategyId', strategyId);
    setCounterfactualLoading(true);
    setCounterfactualError(null);
    apiFetch(`/api/signal-intelligence/counterfactual?${params.toString()}`)
      .then((payload) => {
        if (alive) setCounterfactual(payload);
      })
      .catch((err) => {
        if (alive) setCounterfactualError(err?.message || 'counterfactual_failed');
      })
      .finally(() => {
        if (alive) setCounterfactualLoading(false);
      });
    return () => { alive = false; };
  }, [days, strategyId, refreshToken]);

  useEffect(() => {
    if (!selectedId) {
      setSignalPayload(null);
      return undefined;
    }
    let alive = true;
    setSignalLoading(true);
    setPlaying(false);
    setReplayIndex(0);
    const params = new URLSearchParams();
    params.set('days', days);
    params.set('tailMb', days === '30' ? '32' : '16');
    apiFetch(`/api/signal-intelligence/signals/${encodeURIComponent(selectedId)}?${params.toString()}`)
      .then((payload) => {
        if (alive) setSignalPayload(payload);
      })
      .catch((err) => {
        if (alive) setSignalPayload({ ok: false, error: err?.message || 'signal_not_found' });
      })
      .finally(() => {
        if (alive) setSignalLoading(false);
      });
    return () => { alive = false; };
  }, [selectedId, days]);

  const summary = overview?.summary || {};
  const strategies = overview?.strategies || [];
  const blockers = overview?.blockers || [];
  const recentSignals = overview?.recentSignals || [];
  const cfSummary = counterfactual?.summary || {};
  const cfGroups = counterfactual?.blockerGroups || [];
  const cfHorizonRows = Object.entries(counterfactual?.horizons || {}).map(([minutes, row]) => ({ minutes, ...row }));
  const strategyOptions = useMemo(() => strategies.map((strategy) => strategy.strategyId).sort(), [strategies]);

  const kpis = [
    { label: 'Signals', value: fmtInt(summary.signals), hint: `${days}d`, tone: 'neutral' },
    { label: 'Setups', value: fmtInt(summary.setups), hint: `${fmtPct((summary.setups / Math.max(summary.signals || 0, 1)) * 100)} av signals`, tone: 'info' },
    { label: 'Entry Ready', value: fmtInt(summary.entryReady), hint: `${fmtPct((summary.entryReady / Math.max(summary.producerDetections || 0, 1)) * 100)} av detected`, tone: 'good' },
    { label: 'Trades', value: fmtInt(summary.trades), hint: `${fmtPct((summary.trades / Math.max(summary.entryReady || 0, 1)) * 100)} av ready`, tone: 'good' },
    { label: 'Stopped', value: fmtInt(summary.stopped), hint: `${fmtInt(summary.blockers)} blockers`, tone: 'bad' },
  ];

  return (
    <div className="page-wrap si-page">
      <header className="si-head">
        <div>
          <h1>Signal Intelligence</h1>
          <p>Lifecycle · Blockers · Replay · Scorecard</p>
        </div>
        <div className="si-safety">
          <span>observability_only</span>
          <span>orders disabled</span>
        </div>
      </header>

      <div className="si-toolbar">
        <label>
          <span>Dagar</span>
          <select value={days} onChange={(event) => setDays(event.target.value)}>
            {['1', '3', '7', '14', '30'].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Strategi</span>
          <select value={strategyId} onChange={(event) => setStrategyId(event.target.value)}>
            <option value="all">Alla</option>
            {strategyOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="si-search">
          <span>Sök</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="symbol, blocker, id" />
        </label>
        <button type="button" className="si-icon-button" title="Uppdatera" aria-label="Uppdatera" onClick={() => setRefreshToken((value) => value + 1)}>
          ↻
        </button>
      </div>

      {error ? <div className="si-error">{error}</div> : null}
      {counterfactualError ? <div className="si-error">{counterfactualError}</div> : null}

      <section className="si-kpi-grid">
        {kpis.map((kpi) => <Kpi key={kpi.label} {...kpi} />)}
      </section>

      <section className="si-grid si-grid-counterfactual">
        <div className="si-panel">
          <div className="si-panel-head">
            <h2>Counterfactual Analytics</h2>
            {counterfactualLoading ? <span>Laddar</span> : <span>{fmtInt(cfSummary.analyzed)} analyserade</span>}
          </div>
          <div className="si-cf-kpis">
            <Kpi label="Blocked" value={fmtInt(cfSummary.blockedSignals)} hint={`${fmtPct(cfSummary.dataCoveragePct)} coverage`} tone="neutral" />
            <Kpi label="Good Blocked" value={fmtInt(cfSummary.blockedGoodTrades)} hint=">= +1R efter block" tone="bad" />
            <Kpi label="Bad Blocked" value={fmtInt(cfSummary.blockedBadTrades)} hint="<= 0R efter block" tone="good" />
            <Kpi label="Expected RR" value={fmtRR(cfSummary.averageExpectedRR)} hint={`MFE ${fmtNumber(cfSummary.averageMfeAtr, 2)} ATR`} tone={Number(cfSummary.averageExpectedRR) > 0 ? 'bad' : 'good'} />
          </div>
          <DataTable
            rows={cfGroups}
            emptyText="Ingen counterfactual-data"
            columns={[
              { key: 'blocker', label: 'Blocker', render: (row) => <span className="si-blocker-chip">{row.blocker}</span> },
              { key: 'count', label: 'Antal', render: (row) => fmtInt(row.count) },
              { key: 'pct', label: '%', render: (row) => fmtPct(row.pct) },
              { key: 'analyzed', label: 'Data', render: (row) => `${fmtInt(row.analyzed)}/${fmtInt(row.count)}` },
              { key: 'mfe', label: 'Avg MFE', render: (row) => `${fmtNumber(row.averageMfeAtr, 2)} ATR` },
              { key: 'mae', label: 'Avg MAE', render: (row) => `${fmtNumber(row.averageMaeAtr, 2)} ATR` },
              { key: 'win', label: 'Win', render: (row) => fmtPct(row.winRate) },
              { key: 'loss', label: 'Loss', render: (row) => fmtPct(row.lossRate) },
              { key: 'rr', label: 'Exp RR', render: (row) => <span className="si-rr">{fmtRR(row.expectedRR)}</span> },
              { key: 'stop', label: 'Stop', render: (row) => fmtPct(row.stopHitRate) },
              { key: 'target', label: 'RR3', render: (row) => fmtPct(row.targetR3Rate) },
              { key: 'verdict', label: 'Resultat', render: (row) => <VerdictPill value={row.verdict} /> },
            ]}
          />
        </div>

        <div className="si-panel">
          <div className="si-panel-head">
            <h2>Efter Block</h2>
            <span>+5 · +10 · +15 · +30 · +60</span>
          </div>
          <DataTable
            rows={cfHorizonRows}
            emptyText="Ingen horisontdata"
            rowKey={(row) => row.minutes}
            columns={[
              { key: 'minutes', label: 'Horisont', render: (row) => `+${row.minutes}m` },
              { key: 'samples', label: 'Samples', render: (row) => fmtInt(row.samples) },
              { key: 'mfe', label: 'MFE', render: (row) => `${fmtNumber(row.averageMfeAtr, 2)} ATR` },
              { key: 'mae', label: 'MAE', render: (row) => `${fmtNumber(row.averageMaeAtr, 2)} ATR` },
              { key: 'win', label: 'Win', render: (row) => fmtPct(row.winRate) },
              { key: 'loss', label: 'Loss', render: (row) => fmtPct(row.lossRate) },
              { key: 'rr', label: 'Exp RR', render: (row) => <span className="si-rr">{fmtRR(row.expectedRR)}</span> },
            ]}
          />
          <div className="si-verdict-grid">
            <div className="si-verdict-card is-good">
              <strong>Räddar oss</strong>
              {(counterfactual?.savesUsFromBadTrades || []).slice(0, 5).map((row) => (
                <span key={row.blocker}>{row.blocker} <b>{fmtRR(row.expectedRR)}</b></span>
              ))}
              {!(counterfactual?.savesUsFromBadTrades || []).length ? <small>Inga verifierade grupper</small> : null}
            </div>
            <div className="si-verdict-card is-bad">
              <strong>Hindrar bra</strong>
              {(counterfactual?.blocksGoodTrades || []).slice(0, 5).map((row) => (
                <span key={row.blocker}>{row.blocker} <b>{fmtRR(row.expectedRR)}</b></span>
              ))}
              {!(counterfactual?.blocksGoodTrades || []).length ? <small>Inga verifierade grupper</small> : null}
            </div>
          </div>
        </div>
      </section>

      <section className="si-grid si-grid-score">
        <div className="si-panel">
          <div className="si-panel-head">
            <h2>Producer Scorecard</h2>
            {loading ? <span>Laddar</span> : <span>{fmtInt(strategies.length)} strategier</span>}
          </div>
          <DataTable
            rows={overview?.scorecard || []}
            emptyText="Ingen scorecard-data"
            columns={[
              { key: 'strategyId', label: 'Strategi', render: (row) => <strong className="si-strategy">{row.strategyId}</strong> },
              { key: 'detectionRate', label: 'Detection', render: (row) => fmtPct(row.detectionRate) },
              { key: 'entryReadyRate', label: 'Entry Ready', render: (row) => fmtPct(row.entryReadyRate) },
              { key: 'tradeRate', label: 'Trade', render: (row) => fmtPct(row.tradeRate) },
              { key: 'executionRate', label: 'Execution', render: (row) => fmtPct(row.executionRate) },
              { key: 'winRate', label: 'Win', render: (row) => fmtPct(row.winRate) },
              { key: 'delay', label: 'Median Delay', render: (row) => fmtSeconds(row.medianDelaySeconds) },
              { key: 'extension', label: 'Avg Ext', render: (row) => fmtNumber(row.averageExtension, 2) },
              { key: 'score', label: 'Avg Score', render: (row) => fmtNumber(row.averageTradeScore, 1) },
            ]}
          />
        </div>

        <div className="si-panel">
          <div className="si-panel-head">
            <h2>Strategier</h2>
            <span>First · Last · Common</span>
          </div>
          <DataTable
            rows={strategies}
            emptyText="Ingen strategidata"
            columns={[
              { key: 'strategyId', label: 'Strategi', render: (row) => <strong className="si-strategy">{row.strategyId}</strong> },
              { key: 'setups', label: 'Setups', render: (row) => fmtInt(row.setups) },
              { key: 'entryReady', label: 'Ready', render: (row) => fmtInt(row.entryReady) },
              { key: 'trades', label: 'Trades', render: (row) => fmtInt(row.trades) },
              { key: 'stopped', label: 'Stopped', render: (row) => fmtInt(row.stopped) },
              { key: 'first', label: 'Första blocker', render: (row) => row.firstBlocker?.code || '—' },
              { key: 'last', label: 'Sista blocker', render: (row) => row.lastBlocker?.code || '—' },
              { key: 'common', label: 'Vanligast', render: (row) => row.commonBlocker?.code || '—' },
            ]}
          />
        </div>
      </section>

      <section className="si-grid si-grid-main">
        <div className="si-panel">
          <div className="si-panel-head">
            <h2>Blockerare</h2>
            <span>{fmtInt(blockers.length)} typer</span>
          </div>
          <DataTable
            rows={blockers}
            emptyText="Inga blockerare"
            columns={[
              { key: 'code', label: 'Blocker', render: (row) => <span className="si-blocker-chip">{row.code}</span> },
              { key: 'count', label: 'Antal', render: (row) => fmtInt(row.count) },
              { key: 'pct', label: '%', render: (row) => fmtPct(row.pct) },
              { key: 'delay', label: 'Median delay', render: (row) => fmtSeconds(row.medianDelaySeconds) },
              { key: 'atr', label: 'Median ATR', render: (row) => fmtNumber(row.medianAtr, 2) },
              { key: 'score', label: 'Score', render: (row) => fmtNumber(row.medianTradeScore, 1) },
              { key: 'volume', label: 'Volume', render: (row) => fmtNumber(row.medianVolume, 2) },
              { key: 'volatility', label: 'Volatility', render: (row) => fmtNumber(row.medianVolatility, 1) },
            ]}
          />

          <div className="si-panel-head si-subhead">
            <h2>Signals</h2>
            <span>{fmtInt(recentSignals.length)} visade</span>
          </div>
          <div className="si-signal-list">
            {recentSignals.length ? recentSignals.map((signal) => {
              const id = signal.candidateId || signal.signalKey;
              const active = id === selectedId || signal.signalKey === selectedId;
              return (
                <button key={signal.signalKey} type="button" className={`si-signal-row${active ? ' is-active' : ''}`} onClick={() => setSelectedId(id)}>
                  <span>
                    <strong>{signal.originalSymbol || signal.symbol || '—'}</strong>
                    <small>{signal.strategyId}</small>
                  </span>
                  <StatusPill value={signal.status} />
                  <span className="si-signal-metrics">
                    <b>{fmtSeconds(signal.metrics?.delaySeconds)}</b>
                    <small>{signal.metrics?.extensionLevel || 'none'}</small>
                  </span>
                  <span className="si-signal-blocker">{signal.lastBlocker?.code || signal.firstBlocker?.code || '—'}</span>
                </button>
              );
            }) : <div className="si-empty">Inga signaler</div>}
          </div>
        </div>

        <div className="si-panel si-replay-panel">
          <div className="si-panel-head">
            <h2>Signal Replay</h2>
            <span>{signalPayload?.signal?.timeline?.length || signalPayload?.replay?.steps?.length || 0} steg</span>
          </div>
          <ReplayPanel
            payload={signalPayload}
            loading={signalLoading}
            replayIndex={replayIndex}
            setReplayIndex={setReplayIndex}
            playing={playing}
            setPlaying={setPlaying}
          />
        </div>
      </section>

      <section className="si-panel si-source-panel">
        <div className="si-panel-head">
          <h2>Källor</h2>
          <span>{overview?.load?.full ? 'full' : `${overview?.load?.tailMb || 0} MB tail`}</span>
        </div>
        <div className="si-source-grid">
          {(overview?.sourceStatus || []).map((source) => (
            <div key={source.source} className={`si-source-row${source.ok ? '' : ' is-missing'}`}>
              <span>{source.source}</span>
              <strong>{source.missing ? 'missing' : fmtInt(source.rows)}</strong>
              {source.truncated ? <small>tail</small> : <small>full</small>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
