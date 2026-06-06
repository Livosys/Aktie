import React, { useEffect, useMemo, useState } from 'react';
import { SafeText } from '../utils/safeRender.js';

const REFRESH_MS = 20_000;

const SECTIONS = [
  { id: 'overview', label: 'Översikt' },
  { id: 'live', label: 'Live just nu' },
  { id: 'history', label: 'Historik' },
  { id: 'strategies', label: 'Strategier' },
  { id: 'batches', label: 'Batchtester' },
  { id: 'replay', label: 'Replaytester' },
  { id: 'paper', label: 'Låtsashandel' },
  { id: 'data', label: 'Datahämtning' },
  { id: 'ai', label: 'AI-analytiker' },
  { id: 'risks', label: 'Risker' },
  { id: 'technical', label: 'Tekniskt' },
];

function apiJson(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options })
    .then(async (res) => {
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const error = new Error(data?.error || `API ${res.status}`);
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data;
    });
}

function useResearchLabData(limit) {
  const [state, setState] = useState({
    overview: null,
    activity: null,
    batches: null,
    dataJobs: null,
    aiStatus: null,
    aiLatest: null,
    loading: true,
    refreshing: false,
    error: '',
    lastUpdated: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!cancelled) {
        setState((prev) => ({ ...prev, loading: !prev.lastUpdated, refreshing: Boolean(prev.lastUpdated), error: '' }));
      }
      const [overview, activity, batches, dataJobs, aiStatus, aiLatest] = await Promise.all([
        apiJson('/api/supervisor/overview').catch(() => null),
        apiJson(`/api/status/live-activity?limit=${limit}`).catch(() => null),
        apiJson('/api/status/batches').catch(() => null),
        apiJson('/api/status/data-jobs').catch(() => null),
        apiJson('/api/ai/analyst/status').catch(() => null),
        apiJson('/api/ai/analyst/latest').catch(() => null),
      ]);
      if (cancelled) return;
      setState({
        overview,
        activity,
        batches,
        dataJobs,
        aiStatus,
        aiLatest,
        loading: false,
        refreshing: false,
        error: overview ? '' : 'Kunde inte hämta full Supervisor-data. Vyn visar det som finns.',
        lastUpdated: new Date().toISOString(),
      });
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [limit]);

  return state;
}

function arr(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function text(value, fallback = 'Saknas') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nej';
  if (Array.isArray(value)) return value.map((item) => text(item, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') {
    return text(value.title_sv || value.message_sv || value.summary || value.title || value.message || value.name || value.strategy || value.id, fallback);
  }
  return fallback;
}

const SIMPLE_EVENT_LABELS = {
  run_completed: 'Test klart',
  run_blocked: 'Test stoppat',
  plan_validated: 'Plan kontrollerad',
  'signal detected': 'Signal hittad',
  signal_detected: 'Signal hittad',
  'strategy matched': 'Strategi matchad',
  strategy_matched: 'Strategi matchad',
  SHORT_TRIGGERED: 'Signal hittad',
  dry_run: 'Säker testkörning',
};

const SIMPLE_STRATEGY_LABELS = {
  narrow_fakeout_reversal_v1: 'Fakeout-vändning',
  narrow_vwap_mean_reversion_v1: 'VWAP-vändning',
  narrow_breakout_v1: 'Breakout-test',
  vwap_volume_breakout_long: 'Volym-breakout',
};

function simpleEventLabel(value, fallback = 'Systemhändelse') {
  const raw = text(value, '').trim();
  if (!raw) return fallback;
  return SIMPLE_EVENT_LABELS[raw] || SIMPLE_EVENT_LABELS[raw.toLowerCase()] || raw;
}

function simpleStrategyLabel(value, fallback = 'Strategi') {
  const raw = text(value, '').trim();
  if (!raw) return fallback;
  return SIMPLE_STRATEGY_LABELS[raw] || raw;
}

function fmtNumber(value, fallback = '0') {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('sv-SE').format(n) : fallback;
}

function fmtPct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

function fmtSigned(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function timeText(value) {
  if (!value) return 'Saknas';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saknas';
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function shortTime(value) {
  if (!value) return 'Saknas';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saknas';
  return new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function toneForStatus(status) {
  const s = String(status || '').toLowerCase();
  if (['ok', 'completed', 'complete', 'ready', 'safe', 'disabled'].includes(s)) return 'good';
  if (['running', 'active', 'info'].includes(s)) return 'blue';
  if (['ai', 'learning', 'purple'].includes(s)) return 'purple';
  if (['empty', 'waiting', 'cooldown', 'degraded', 'warning', 'blocked'].includes(s)) return 'warning';
  if (['error', 'failed', 'danger'].includes(s)) return 'danger';
  return 'neutral';
}

function Badge({ tone = 'neutral', children }) {
  return <span className={`research-badge research-badge-${tone}`}>{children}</span>;
}

function autopilotReadiness(summary) {
  if (!summary) return { tone: 'neutral', label: 'Status saknas' };
  if (summary.enabled) return { tone: 'blue', label: 'Förberedd' };
  return { tone: 'good', label: 'Förberedd men avstängd' };
}

function aiReadiness(status) {
  const r = status?.status || status?.readiness || null;
  if (r === 'ready') return { tone: 'purple', label: 'Aktiv' };
  if (r === 'not_configured') return { tone: 'warning', label: 'Inte konfigurerad' };
  return { tone: 'good', label: 'Avstängd' };
}

// Provider-neutral badge label so the UI shows the real active analyst provider.
function aiBadgeLabel(status) {
  const provider = String(status?.provider || '').toLowerCase();
  const r = status?.status || status?.readiness || null;
  if (provider === 'openai') {
    if (r === 'ready') return 'AI Analyst: OpenAI aktiv';
    if (r === 'not_configured') return 'AI Analyst: OpenAI inte konfigurerad';
    return 'AI Analyst: Avstängd';
  }
  if (provider === 'anthropic') {
    if (r === 'ready') return 'AI Analyst: Claude aktiv';
    if (r === 'not_configured') return 'AI Analyst: Claude inte konfigurerad';
    return 'AI Analyst: Avstängd';
  }
  if (provider === 'disabled') return 'AI Analyst: Avstängd';
  return 'AI Analyst: Status okänd';
}

function ReadinessNote({ readiness, lastRun, lastResult }) {
  return (
    <div className="research-readiness">
      <Badge tone={readiness.tone}>{readiness.label}</Badge>
      <span>Endast testläge</span>
      {lastRun ? <span>Senaste händelse: {timeText(lastRun)}</span> : null}
      {lastResult ? <span>Senaste resultat: <SafeText value={lastResult} /></span> : null}
    </div>
  );
}

function Card({ className = '', children }) {
  return <article className={`research-card ${className}`.trim()}>{children}</article>;
}

function EmptyState({ title = 'Ingen data ännu', children }) {
  return (
    <div className="research-empty">
      <strong>{title}</strong>
      <p>{children || 'När systemet har mer testdata visas den här.'}</p>
    </div>
  );
}

function DegradedState({ title = 'Data saknas delvis', children }) {
  return (
    <div className="research-degraded">
      <strong>{title}</strong>
      <p>{children || 'En källa svarade inte, men resten av sidan fortsätter fungera.'}</p>
    </div>
  );
}

function SectionHeader({ eyebrow, title, subtitle, aside }) {
  return (
    <div className="research-section-head">
      <div>
        {eyebrow ? <div className="research-eyebrow">{eyebrow}</div> : null}
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {aside ? <div className="research-section-aside">{aside}</div> : null}
    </div>
  );
}

function MetricCard({ label, value, help, tone = 'neutral' }) {
  return (
    <Card className={`research-metric research-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {help ? <small>{help}</small> : null}
    </Card>
  );
}

function SafetyStatusBar({ overview }) {
  const safety = {
    mode: overview?.mode || 'paper_only',
    actions_allowed: overview?.actions_allowed === true,
    can_place_orders: overview?.can_place_orders === true,
    live_trading_enabled: overview?.live_trading_enabled === true,
    broker_enabled: overview?.broker_enabled === true,
  };
  const locked = safety.mode === 'paper_only'
    && !safety.actions_allowed
    && !safety.can_place_orders
    && !safety.live_trading_enabled
    && !safety.broker_enabled;
  return (
    <div className="research-safetybar">
      <div>
        <strong>{locked ? 'Systemet är säkert' : 'Kontrollera säkerheten'}</strong>
        <span>Ingen riktig handel sker. Plattformen analyserar, testar och lär sig i paper-läge.</span>
      </div>
      <div className="research-safety-flags">
        <Badge tone={locked ? 'good' : 'danger'}>Endast testläge</Badge>
        <Badge tone={!safety.can_place_orders ? 'good' : 'danger'}>Inga riktiga order</Badge>
        <Badge tone={!safety.broker_enabled ? 'good' : 'danger'}>Broker avstängd</Badge>
        <Badge tone={!safety.live_trading_enabled ? 'good' : 'danger'}>Ingen livehandel</Badge>
      </div>
    </div>
  );
}

function SystemPipeline() {
  const steps = [
    ['Data', 'Marknadsdata hämtas och sparas.'],
    ['Test', 'Systemet gör säkra paper/replay/batch-tester.'],
    ['Resultat', 'Utfallet sparas som testdata.'],
    ['AI lär sig', 'Learning Engine och AI sammanfattar mönster.'],
    ['Nästa test', 'Systemet föreslår nästa säkra research-steg.'],
  ];
  return (
    <div className="research-pipeline">
      {steps.map(([title, body], index) => (
        <div key={title} className="research-pipeline-step">
          <span>{index + 1}</span>
          <strong>{title}</strong>
          <small>{body}</small>
        </div>
      ))}
    </div>
  );
}

function activityLabel(event) {
  if (!event) return 'Systemhändelse';
  if (event.title) return simpleEventLabel(event.title);
  if (event.type === 'autopilot') return 'Autopilot planerade';
  if (event.type === 'batch') return 'Batchtest uppdaterades';
  if (event.type === 'data_job') return 'Datahämtning uppdaterades';
  if (event.type === 'ai') return 'AI-analys uppdaterades';
  if (event.type === 'learning') return 'Learning uppdaterades';
  return simpleEventLabel(event.type);
}

function statusSv(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'Pågår';
  if (s === 'completed') return 'Klart';
  if (s === 'blocked') return 'Stoppat';
  if (s === 'failed') return 'Fel';
  if (s === 'waiting') return 'Väntar';
  return 'Info';
}

function LiveActivityFeed({ events = [], limit, compact = false }) {
  const visible = arr(events).slice(0, limit || 20);
  if (!visible.length) {
    return <EmptyState title="Ingen aktivitet ännu">När systemet planerar, testar eller lär sig visas händelser här.</EmptyState>;
  }
  return (
    <div className={`research-timeline ${compact ? 'research-timeline-compact' : ''}`}>
      {visible.map((event, index) => (
        <div key={`${event.id || index}-${event.timestamp || index}`} className={`research-event research-event-${toneForStatus(event.severity || event.status)}`}>
          <div className="research-event-time">{shortTime(event.timestamp)}</div>
          <div className="research-event-dot" />
          <div className="research-event-body">
            <div className="research-event-top">
              <strong>{activityLabel(event)}</strong>
              <Badge tone={toneForStatus(event.status)}>{statusSv(event.status)}</Badge>
            </div>
            <p><SafeText value={simpleEventLabel(event.message, 'Systemet uppdaterade status.')} fallback="Systemet uppdaterade status." /></p>
            <div className="research-event-meta">
              {event.strategy ? <span><SafeText value={simpleStrategyLabel(event.strategy)} /></span> : null}
              {event.symbol ? <span><SafeText value={event.symbol} /></span> : null}
              {event.timeframe ? <span><SafeText value={event.timeframe} /></span> : null}
              <span>Endast testläge</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryTimeline({ tests, limit }) {
  const visible = arr(tests).slice(0, limit);
  if (!visible.length) return <EmptyState title="Ingen testhistorik">När autopilot eller batchtester har historik visas den här.</EmptyState>;
  return (
    <div className="research-history">
      {visible.map((test, index) => {
        const blocked = test.blockedReason || test.type === 'run_blocked';
        return (
          <Card key={`${test.id || index}-${test.timestamp || index}`} className="research-history-card">
            <div className="research-history-top">
              <div>
                <strong>{timeText(test.timestamp)}</strong>
                <span>{simpleStrategyLabel(test.strategy, 'Narrow Autopilot')}</span>
              </div>
              <Badge tone={blocked ? 'warning' : toneForStatus(test.type === 'run_completed' ? 'completed' : 'info')}>
                {blocked ? 'Stoppades' : test.type === 'run_completed' ? 'Test klart' : 'Planering'}
              </Badge>
            </div>
            <div className="research-history-grid">
              <span><b>Testtyp</b>{simpleEventLabel(test.type, 'Testhändelse')}</span>
              <span><b>Symbol/timeframe</b>{text([test.symbol, test.timeframe].filter(Boolean), 'Saknas')}</span>
              <span><b>Säker testkörning</b>{test.dryRun === true ? 'Säker testkörning' : 'Paper/batch-test'}</span>
              <span><b>Ingen riktig körning</b>{test.executed === false ? 'Ja' : test.executed === true ? 'Testdata klar' : 'Ja'}</span>
              <span><b>Andel lyckade tester</b>{test.winRate != null ? fmtPct(test.winRate) : '—'}</span>
              <span><b>Genomsnittligt resultat</b>{test.avgResult != null ? fmtSigned(test.avgResult) : '—'}</span>
            </div>
            {test.scoreBand ? <p className="research-muted">Testnivå: <SafeText value={test.scoreBand} /></p> : null}
            {blocked ? <p className="research-warning-copy">Stoppades därför att: <SafeText value={test.blockedReason || test.reason} /></p> : null}
            {test.recommendation ? <p className="research-muted">Nästa rekommendation: <SafeText value={test.recommendation} /></p> : null}
          </Card>
        );
      })}
    </div>
  );
}

function StrategyCard({ item, tone = 'neutral', note }) {
  if (!item) return <EmptyState title="Saknas">För lite data för att visa strategi.</EmptyState>;
  const rawName = text(item.key || item.strategy || item.strategy_id || item.name, '');
  const label = simpleStrategyLabel(rawName);
  const showTechnicalName = rawName && rawName !== label;
  return (
    <Card className={`research-strategy research-strategy-${tone}`}>
      <div className="research-card-title">
        <strong>
          <SafeText value={label} fallback="Strategi" />
          {showTechnicalName ? <small><SafeText value={rawName} /></small> : null}
        </strong>
        <Badge tone={tone}>{note || 'Testdata'}</Badge>
      </div>
      <div className="research-mini-grid research-mini-grid-quiet">
        <span><b>Andel lyckade tester</b>{item.winRate != null ? fmtPct(item.winRate) : '—'}</span>
        <span><b>Antal tester</b>{fmtNumber(item.trades || item.tradeCount || item.total || 0)}</span>
        <span><b>Genomsnitt</b>{item.avgResult != null || item.avgPnl != null ? fmtSigned(first(item.avgResult, item.avgPnl)) : '—'}</span>
      </div>
    </Card>
  );
}

function BatchStatusCard({ batches }) {
  const latest = batches?.latestBatch || batches?.latestCompletedBatch || null;
  const best = batches?.bestOutcome || latest?.bestOutcome || null;
  const worst = batches?.worstOutcome || latest?.worstOutcome || null;
  return (
    <div className="research-grid research-grid-3">
      <MetricCard label="Batch aktiv nu?" value={batches?.isRunning ? 'Ja' : 'Nej'} help="Endast visning, ingen kontroll här." tone={batches?.isRunning ? 'warning' : 'good'} />
      <MetricCard label="Batcher totalt" value={fmtNumber(batches?.totalBatches || 0)} help={`${fmtNumber(batches?.completedBatches || 0)} klara`} tone="blue" />
      <MetricCard label="Misslyckade" value={fmtNumber(batches?.failedBatches || 0)} help="Visas för felsökning." tone={batches?.failedBatches ? 'warning' : 'good'} />
      <Card className="research-wide">
        <div className="research-card-title">
          <strong>Senaste batch</strong>
          <Badge tone={toneForStatus(latest?.status || batches?.status)}>{text(latest?.status || batches?.status, 'Saknas')}</Badge>
        </div>
        <p><SafeText value={latest?.id} fallback="Ingen batch ännu" /></p>
        <div className="research-mini-grid">
          <span><b>Strategi</b>{simpleStrategyLabel(latest?.strategy, 'Saknas')}</span>
          <span><b>Symboler</b>{text(latest?.symbols, 'Saknas')}</span>
          <span><b>Timeframe</b>{text(latest?.timeframe, 'Saknas')}</span>
          <span><b>Kombinationer</b>{fmtNumber(latest?.combinationsTested || 0)}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Bästa outcome</strong><Badge tone="good">Bäst</Badge></div>
        <p><SafeText value={simpleStrategyLabel(best?.strategy, 'Saknas')} fallback="Saknas" /></p>
        <div className="research-mini-grid">
          <span><b>Win rate</b>{best?.winRate != null ? fmtPct(best.winRate) : '—'}</span>
          <span><b>Avg</b>{best?.avgResult != null ? fmtSigned(best.avgResult) : '—'}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Sämsta outcome</strong><Badge tone="warning">Svagast</Badge></div>
        <p><SafeText value={simpleStrategyLabel(worst?.strategy, 'Saknas')} fallback="Saknas" /></p>
        <div className="research-mini-grid">
          <span><b>Win rate</b>{worst?.winRate != null ? fmtPct(worst.winRate) : '—'}</span>
          <span><b>Avg</b>{worst?.avgResult != null ? fmtSigned(worst.avgResult) : '—'}</span>
        </div>
      </Card>
    </div>
  );
}

function DataPipelineCard({ dataJobs }) {
  const hourly = dataJobs?.hourlyImport || {};
  const weekly = dataJobs?.weeklyBackfill || {};
  const cache = dataJobs?.cacheStatus || {};
  const quality = dataJobs?.dataQuality || {};
  return (
    <>
      <div className="research-pipeline research-pipeline-data">
        {['Alpaca', 'Candles', 'Cache', 'Tester', 'AI lär sig'].map((step, index) => (
          <div key={step} className="research-pipeline-step">
            <span>{index + 1}</span>
            <strong>{step}</strong>
            <small>{index === 0 ? (dataJobs?.alpacaConfigured ? 'Konfigurerad' : 'Saknar config') : 'Read-only status'}</small>
          </div>
        ))}
      </div>
      <div className="research-grid research-grid-4">
        <MetricCard label="Alpaca status" value={dataJobs?.alpacaConfigured ? 'Redo' : 'Saknas'} help="Nycklar visas aldrig." tone={dataJobs?.alpacaConfigured ? 'good' : 'warning'} />
        <MetricCard label="Timvis import" value={text(hourly.status, 'Saknas')} help={`Senast: ${timeText(hourly.lastRun)}`} tone={toneForStatus(hourly.status)} />
        <MetricCard label="Historisk backfill" value={text(weekly.status, 'Saknas')} help={`Jobb: ${fmtNumber(weekly.totalJobs || 0)}`} tone={toneForStatus(weekly.status)} />
        <MetricCard label="Cache age" value={cache.cacheAgeSeconds != null ? `${fmtNumber(cache.cacheAgeSeconds)} sek` : 'Saknas'} help={timeText(cache.lastUpdated)} tone={cache.cacheExists ? 'blue' : 'warning'} />
      </div>
      <Card>
        <div className="research-card-title">
          <strong>Datakvalitet</strong>
          <Badge tone={quality.missingCandles ? 'warning' : 'good'}>{quality.missingCandles ? 'Behöver mer data' : 'OK'}</Badge>
        </div>
        <p><SafeText value={quality.message} fallback="Ingen tydlig datakvalitet rapporterad." /></p>
        <div className="research-mini-grid">
          <span><b>Importerade candles</b>{fmtNumber(hourly.candlesImported || 0)}</span>
          <span><b>Symboler uppdaterade</b>{fmtNumber(arr(hourly.symbolsUpdated).length)}</span>
          <span><b>Providerfel</b>{fmtNumber(arr(quality.providerErrors).length)}</span>
        </div>
      </Card>
    </>
  );
}

function AiAnalystSummary({ status, latest, onRefresh, refreshing }) {
  const latestPayload = latest?.latest || latest || {};
  const output = latestPayload.output || {};
  const provider = status?.provider || latestPayload.provider || 'disabled';
  const disabled = provider === 'disabled' || latestPayload.status === 'disabled' || status?.enabled === false;
  return (
    <div className="research-grid research-grid-2">
      <Card className="research-ai-card">
        <div className="research-card-title">
          <strong>AI-analytiker</strong>
          <Badge tone={disabled ? 'warning' : 'purple'}>{disabled ? 'Avstängd' : 'Read-only'}</Badge>
        </div>
        <p>AI-analytikern läser systemets säkra sammanfattning. AI kan inte handla eller ändra något.</p>
        <div className="research-mini-grid">
          <span><b>Provider</b>{provider}</span>
          <span><b>Model</b>{text(status?.model, 'Saknas')}</span>
          <span><b>Senast</b>{timeText(status?.latestTimestamp || latestPayload.generatedAt)}</span>
          <span><b>Confidence</b>{output.confidence != null ? fmtPct(Number(output.confidence) * 100) : '—'}</span>
        </div>
        <button className="research-soft-button" type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Uppdaterar...' : 'Uppdatera AI-analys'}
        </button>
      </Card>
      <Card className="research-ai-card">
        <div className="research-card-title"><strong>Senaste sammanfattning</strong><Badge tone="purple">AI</Badge></div>
        <p><SafeText value={output.summary} fallback={disabled ? 'AI Analyst är avstängd. Systemet fungerar ändå med intern learning.' : 'Ingen AI-analys sparad ännu.'} /></p>
        <div className="research-list">
          <strong>Vad AI lärde sig</strong>
          {arr(output.what_ai_learned).length ? arr(output.what_ai_learned).slice(0, 4).map((item) => <span key={item}><SafeText value={item} /></span>) : <span>Ingen AI-lärdom sparad ännu.</span>}
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Strategier enligt AI</strong><Badge tone="purple">Analys</Badge></div>
        <div className="research-mini-grid">
          <span><b>Bäst</b>{simpleStrategyLabel(output.best_strategy, 'Saknas')}</span>
          <span><b>Svagast</b>{simpleStrategyLabel(output.weakest_strategy, 'Saknas')}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Nästa rekommenderade tester</strong><Badge tone="blue">Förslag</Badge></div>
        <div className="research-list">
          {arr(output.next_recommended_tests).length ? arr(output.next_recommended_tests).slice(0, 5).map((item) => <span key={item}><SafeText value={item} /></span>) : <span>Vänta in mer testdata eller uppdatera AI-analysen.</span>}
        </div>
      </Card>
    </div>
  );
}

function RiskBlockerCard({ risks, dataJobs, batches, activity }) {
  const providerErrors = arr(dataJobs?.dataQuality?.providerErrors);
  const degradedSources = arr(activity?.sources).filter((source) => source.status === 'degraded');
  const combined = [
    ...arr(risks).map((risk) => ({ tone: toneForStatus(risk.level), title: text(risk.code, 'Risk'), message: text(risk.message_sv, 'Saknas') })),
    ...providerErrors.map((err) => ({ tone: 'warning', title: 'Providerfel', message: text(err.message, 'Datakälla rapporterade fel.') })),
    ...degradedSources.map((source) => ({ tone: 'warning', title: 'Källa saknar data', message: `${source.name} svarade delvis.` })),
  ];
  if (batches?.status === 'empty') combined.push({ tone: 'warning', title: 'Batchdata saknas', message: 'Batchtester har inte tillräcklig historik ännu.' });
  if (!combined.length) combined.push({ tone: 'good', title: 'Livehandel avstängd', message: 'Det är en positiv säkerhet: systemet kan inte handla på riktigt.' });
  return (
    <div className="research-risk-grid">
      {combined.slice(0, 10).map((item, index) => (
        <Card key={`${item.title}-${index}`} className={`research-risk-card research-risk-${item.tone}`}>
          <Badge tone={item.tone}>{item.title}</Badge>
          <p>{item.message}</p>
        </Card>
      ))}
    </div>
  );
}

function TechnicalDetailsPanel({ data }) {
  return (
    <details className="research-tech" open>
      <summary>Tekniska detaljer</summary>
      <div className="research-tech-grid">
        <MetricCard label="mode" value={data.overview?.mode || 'paper_only'} tone="good" />
        <MetricCard label="actions_allowed" value={String(data.overview?.actions_allowed === true ? true : false)} tone="good" />
        <MetricCard label="can_place_orders" value={String(data.overview?.can_place_orders === true ? true : false)} tone="good" />
        <MetricCard label="live_trading_enabled" value={String(data.overview?.live_trading_enabled === true ? true : false)} tone="good" />
        <MetricCard label="broker_enabled" value={String(data.overview?.broker_enabled === true ? true : false)} tone="good" />
        <MetricCard label="AI cache" value={data.aiStatus?.cacheEnabled ? 'På' : 'Av'} help={`${fmtNumber(data.aiStatus?.cacheTtlMs || 0)} ms`} tone="purple" />
        <MetricCard label="Batch API" value={text(data.batches?.status, 'Saknas')} tone={toneForStatus(data.batches?.status)} />
        <MetricCard label="Data API" value={text(data.dataJobs?.status, 'Saknas')} tone={toneForStatus(data.dataJobs?.status)} />
        <MetricCard label="Activity API" value={text(data.activity?.status, 'Saknas')} tone={toneForStatus(data.activity?.status)} />
      </div>
    </details>
  );
}

export default function SupervisorBrainPage() {
  const [active, setActive] = useState('overview');
  const [historyLimit, setHistoryLimit] = useState(20);
  const [aiRefreshing, setAiRefreshing] = useState(false);
  const [aiOverride, setAiOverride] = useState(null);
  const [showAllStrategies, setShowAllStrategies] = useState(false);
  const data = useResearchLabData(historyLimit);
  const overview = data.overview || {};
  const blocks = overview.blocks || {};
  const autopilot = blocks.autopilot?.summary || {};
  const canonical = overview.canonicalStats || {};
  const latestTest = arr(overview.recentTests)[0] || null;
  const strategies = blocks.strategies?.summary || {};
  const topStrategies = arr(strategies.top);
  const weakStrategies = arr(strategies.worst);
  const visibleTopStrategies = showAllStrategies ? topStrategies : topStrategies.slice(0, 3);
  const visibleWeakStrategies = showAllStrategies ? weakStrategies : weakStrategies.slice(0, 3);
  const learning = blocks.learning?.summary || {};
  const narrow = blocks.narrow?.summary || {};
  const recommended = arr(overview.actionPlan)[0] || null;
  const batchAuto = overview.batchAutopilotSummary || null;
  const replayAuto = overview.replayAutopilotSummary || null;
  const aiStatusForReadiness = aiOverride?.status || data.aiStatus || overview.aiAnalystStatus || null;

  const safetyLocked = overview.mode === 'paper_only'
    && overview.actions_allowed === false
    && overview.can_place_orders === false
    && overview.live_trading_enabled === false
    && overview.broker_enabled === false;

  const visibleActivity = useMemo(() => arr(data.activity?.events), [data.activity]);
  const recentTests = useMemo(() => arr(overview.recentTests), [overview.recentTests]);

  async function refreshAiAnalysis() {
    setAiRefreshing(true);
    try {
      const result = await apiJson('/api/ai/analyst/run', { method: 'POST' }).catch((err) => ({ ok: false, error: err.message }));
      const [status, latest] = await Promise.all([
        apiJson('/api/ai/analyst/status').catch(() => data.aiStatus),
        apiJson('/api/ai/analyst/latest').catch(() => ({ latest: result })),
      ]);
      setAiOverride({ status, latest });
    } finally {
      setAiRefreshing(false);
    }
  }

  return (
    <div className="research-lab-page">
      <main className="research-main">
        <header className="research-hero">
          <div>
            <div className="research-eyebrow">AI Kontrollrum</div>
            <h1>Trading OS är en säker AI-forskningsplattform</h1>
            <p>Analys, paper testing, replay, batchtester och learning. Ingen riktig handel sker.</p>
          </div>
          <div className="research-hero-status">
            <Badge tone={safetyLocked ? 'good' : 'danger'}>{safetyLocked ? 'Säkert läge' : 'Kontrollera'}</Badge>
            <span>{timeText(data.lastUpdated)}</span>
            {data.refreshing ? <small>Uppdaterar data...</small> : null}
          </div>
        </header>

        <SafetyStatusBar overview={overview} />

        <nav className="research-tabs" aria-label="Supervisor-sektioner">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={active === section.id ? 'research-tab active' : 'research-tab'}
              onClick={() => setActive(section.id)}
              aria-pressed={active === section.id}
            >
              {section.label}
            </button>
          ))}
        </nav>

        {data.error ? <DegradedState>{data.error}</DegradedState> : null}
        {data.loading ? <EmptyState title="Laddar Research Lab">Hämtar säker systemöversikt...</EmptyState> : null}

        {active === 'overview' ? (
          <section className="research-section">
            <SectionHeader
              eyebrow="Översikt"
              title="Det viktigaste först"
              subtitle="Fyra korta svar: säkerhet, autopilot, senaste test och nästa säkra steg."
              aside={<Badge tone="good">Read-only</Badge>}
            />
            <div className="research-grid research-grid-4">
              <MetricCard label="Är systemet säkert?" value={safetyLocked ? 'Ja' : 'Kontrollera'} help="Paper only betyder låtsashandel och analys." tone={safetyLocked ? 'good' : 'danger'} />
              <MetricCard label="Autopilot" value={autopilot.schedulerActive ? 'Jobbar i bakgrunden' : 'Väntar'} help="Autopilot får bara planera och analysera." tone={autopilot.schedulerActive ? 'blue' : 'warning'} />
              <MetricCard label="Senaste test" value={latestTest ? simpleEventLabel(latestTest.type, 'Testhändelse') : 'Saknas'} help={latestTest ? timeText(latestTest.timestamp) : 'Ingen historik ännu'} tone={latestTest ? 'blue' : 'warning'} />
              <MetricCard label="Nästa säkra test" value={text(recommended?.title_sv || narrow.recommendedNextTest, 'Vänta på mer data')} help={text(recommended?.detail_sv, 'Rekommendation, inte automatisk ändring.')} tone="purple" />
            </div>
            <SystemPipeline />
            <div className="research-grid research-grid-3">
              <MetricCard label="Totalt testade händelser" value={fmtNumber(canonical.totalTrades || 0)} help="Testdata, inte bevisad edge." tone="blue" />
              <MetricCard label="Andel lyckade tester" value={fmtPct(canonical.winRate)} help="Win rate i paper/testdata." tone="good" />
              <MetricCard label="AI-lärdom" value={text(narrow.bestScoreBand, 'För lite data')} help="Bästa narrow-nivå just nu." tone="purple" />
            </div>
          </section>
        ) : null}

        {active === 'live' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Live just nu" title="Vad systemet gör just nu" subtitle="En read-only tidslinje från systemets aktivitet. Den här vyn har inga kontrollknappar." aside={<Badge tone={toneForStatus(data.activity?.status)}>{text(data.activity?.status, 'Saknas')}</Badge>} />
            {visibleActivity[0] ? (
              <ReadinessNote
                readiness={{ tone: 'blue', label: 'Senaste händelse' }}
                lastRun={visibleActivity[0].timestamp}
                lastResult={visibleActivity[0].result}
              />
            ) : null}
            <LiveActivityFeed events={visibleActivity} limit={50} />
          </section>
        ) : null}

        {active === 'history' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Historik" title="Senaste testhändelser" subtitle="Säker testkörning betyder att systemet planerar eller testar utan riktig handel. Ingen riktig körning betyder att inget farligt genomfördes." aside={(
              <label className="research-select-label">
                Visa
                <select value={historyLimit} onChange={(event) => setHistoryLimit(Number(event.target.value))}>
                  {[10, 20, 30, 40, 50].map((value) => <option key={value} value={value}>{value} senaste</option>)}
                </select>
              </label>
            )} />
            <HistoryTimeline tests={recentTests} limit={historyLimit} />
          </section>
        ) : null}

        {active === 'strategies' ? (
          <section className="research-section">
            <SectionHeader
              eyebrow="Strategier"
              title="Vad fungerar och vad behöver mer test"
              subtitle="En lugn sammanfattning av strategi-data från Supervisor."
              aside={(topStrategies.length > 3 || weakStrategies.length > 3) ? (
                <button className="research-link-button" type="button" onClick={() => setShowAllStrategies((value) => !value)}>
                  {showAllStrategies ? 'Visa färre' : 'Visa fler'}
                </button>
              ) : null}
            />
            <div className="research-grid research-grid-2">
              <Card className="research-strategy-group">
                <div className="research-card-title"><strong>Bäst just nu</strong><Badge tone="good">Testdata</Badge></div>
                {visibleTopStrategies.length ? visibleTopStrategies.map((item, index) => <StrategyCard key={item.key || item.strategy || `top-${index}`} item={item} tone="good" note="Bäst" />) : <EmptyState />}
              </Card>
              <Card className="research-strategy-group">
                <div className="research-card-title"><strong>Svagast just nu</strong><Badge tone="warning">Behöver mer test</Badge></div>
                {visibleWeakStrategies.length ? visibleWeakStrategies.map((item, index) => <StrategyCard key={item.key || item.strategy || `worst-${index}`} item={item} tone="warning" note="Svagast" />) : <EmptyState />}
              </Card>
              <MetricCard label="Bästa narrow-strategi" value={simpleStrategyLabel(narrow.bestStrategy, 'Saknas')} help="Från Narrow Learning." tone="good" />
              <MetricCard label="Inte testade nog" value={text(learning.connectorSummary?.strategiesTracked ? 'Fler strategier följs' : 'För lite data')} help="Mer paper/replay/batch behövs." tone="warning" />
            </div>
          </section>
        ) : null}

        {active === 'batches' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Batchtester" title="Batchtester jämför många varianter" subtitle="Batchtester jämför många varianter för att hitta vad som fungerar bäst. Här visas bara status och historik." aside={<Badge tone={autopilotReadiness(batchAuto).tone}>{`Batch-autopilot: ${autopilotReadiness(batchAuto).label}`}</Badge>} />
            {batchAuto ? <ReadinessNote readiness={autopilotReadiness(batchAuto)} lastRun={batchAuto.lastRun} /> : null}
            <BatchStatusCard batches={data.batches || overview.batchSummary} />
          </section>
        ) : null}

        {active === 'replay' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Replaytester" title="Replay testar på gammal data" subtitle="Replay betyder att systemet testar en strategi på historisk marknadsdata. Den här vyn visar bara förslag och händelser." aside={<Badge tone={autopilotReadiness(replayAuto).tone}>{`Replay-autopilot: ${autopilotReadiness(replayAuto).label}`}</Badge>} />
            {replayAuto ? <ReadinessNote readiness={autopilotReadiness(replayAuto)} lastRun={replayAuto.lastRun} lastResult={replayAuto.lastReplayResult} /> : null}
            <div className="research-grid research-grid-2">
              <Card>
                <div className="research-card-title"><strong>Visa replay-förslag</strong><Badge tone="blue">Read-only</Badge></div>
                <p>{text(recommended?.detail_sv, 'Ingen särskild replay-rekommendation finns just nu.')}</p>
              </Card>
              <Card>
                <div className="research-card-title"><strong>Senaste replay-liknande händelser</strong><Badge tone="blue">Historik</Badge></div>
                <LiveActivityFeed events={visibleActivity.filter((event) => event.type === 'replay' || event.type === 'batch')} limit={8} compact />
              </Card>
            </div>
          </section>
        ) : null}

        {active === 'paper' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Paper testing" title="Låtsashandel utan riktiga pengar" subtitle="Paper testing betyder låtsashandel. Inga riktiga pengar används och inga riktiga order läggs." />
            <div className="research-grid research-grid-4">
              <MetricCard label="Simulerade signaler" value={fmtNumber(canonical.totalTrades || 0)} help="Alla är testhändelser." tone="blue" />
              <MetricCard label="Andel lyckade tester" value={fmtPct(canonical.winRate)} help="Baserat på testdata." tone="good" />
              <MetricCard label="Genomsnittligt resultat" value={canonical.avgPnl != null ? fmtSigned(canonical.avgPnl) : '—'} help="Paper-resultat." tone="blue" />
              <MetricCard label="Lärdom" value={simpleStrategyLabel(narrow.bestStrategy, 'Samla mer data')} help="Starkast i test just nu." tone="purple" />
            </div>
            <HistoryTimeline tests={recentTests.filter((test) => test.executed === true || test.type === 'run_completed')} limit={8} />
          </section>
        ) : null}

        {active === 'data' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Datahämtning" title="Data hämtas och sparas för tester" subtitle="Read-only status för Alpaca, historisk backfill, candles och cache. Inga synk- eller datajobbsknappar." />
            <DataPipelineCard dataJobs={data.dataJobs || overview.dataJobsSummary} />
            <LiveActivityFeed events={visibleActivity.filter((event) => event.type === 'data_job')} limit={10} compact />
          </section>
        ) : null}

        {active === 'ai' ? (
          <section className="research-section">
            <SectionHeader eyebrow="AI-analytiker" title="AI förklarar vad som bör testas härnäst" subtitle="AI får bara läsa systemets säkra sammanfattning, sammanfatta och rekommendera säkra research-tester." aside={<Badge tone={aiReadiness(aiStatusForReadiness).tone}>{aiBadgeLabel(aiStatusForReadiness)}</Badge>} />
            {aiStatusForReadiness?.message ? <ReadinessNote readiness={aiReadiness(aiStatusForReadiness)} lastRun={aiStatusForReadiness.latestTimestamp} lastResult={aiStatusForReadiness.message} /> : null}
            <AiAnalystSummary status={aiOverride?.status || data.aiStatus || overview.aiAnalystStatus} latest={aiOverride?.latest || data.aiLatest} onRefresh={refreshAiAnalysis} refreshing={aiRefreshing} />
          </section>
        ) : null}

        {active === 'risks' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Risker" title="Risker och blockers" subtitle="Livehandel avstängd visas som positiv säkerhet. Övriga varningar visar vad som behöver mer data eller kontroll." />
            <RiskBlockerCard risks={overview.risks} dataJobs={data.dataJobs} batches={data.batches} activity={data.activity} />
          </section>
        ) : null}

        {active === 'technical' ? (
          <section className="research-section">
            <SectionHeader eyebrow="Tekniskt" title="Tekniska detaljer" subtitle="Här finns råare statusfält för felsökning. Huvudvyn ovan är förenklad." />
            <TechnicalDetailsPanel data={data} />
          </section>
        ) : null}
      </main>
    </div>
  );
}
