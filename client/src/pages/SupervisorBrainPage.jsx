import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SafeText } from '../utils/safeRender.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';

const REFRESH_MS = 20_000;

const SECTIONS = [
  { id: 'overview', label: 'Översikt' },
  { id: 'live', label: 'Aktivitet just nu' },
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
    batchAuto: null,
    replayAuto: null,
    replay: null,
    dataJobs: null,
    aiStatus: null,
    aiLatest: null,
    paperTrading: null,
    paperAllowlist: null,
    paperAgent: null,
    schedulerStatus: null,
    runtimeMatrix: null,
    automationPlan: null,
    loading: true,
    refreshing: false,
    error: '',
    lastUpdated: null,
  });

  useEffect(() => {
    let cancelled = false;

    function overviewHasBlock(overview, key) {
      return Boolean(overview && typeof overview === 'object' && overview[key]);
    }

    async function load() {
      if (!cancelled) {
        setState((prev) => ({ ...prev, loading: !prev.lastUpdated, refreshing: Boolean(prev.lastUpdated), error: '' }));
      }
      const overview = await apiJson('/api/supervisor/overview').catch(() => null);

      const needsBatches = !overviewHasBlock(overview, 'batchSummary');
      const needsBatchAuto = !overviewHasBlock(overview, 'batchAutopilotSummary');
      const needsReplayAuto = !overviewHasBlock(overview, 'replayAutopilotSummary');
      const needsDataJobs = !overviewHasBlock(overview, 'dataStatus');
      const needsAiStatus = !overviewHasBlock(overview, 'aiAnalystStatus');
      const needsPaperAgent = !overviewHasBlock(overview, 'paperStatus');
      const needsSchedulerStatus = !overviewHasBlock(overview, 'batchAutopilotSummary') || !overviewHasBlock(overview, 'replayAutopilotSummary');

      // Keep these fetches as deliberate fallbacks/details:
      // - activity: live feed needs richer event details than overview summary
      // - replay: replay list still uses richer recent replay rows
      // - aiLatest: AI detail card still uses latest output details
      // - paperTrading: paper list still uses richer trade details
      // - runtimeMatrix / automationPlan: not unified in overview yet
      const [
        activity,
        batches,
        batchAuto,
        replayAuto,
        replay,
        dataJobs,
        aiStatus,
        aiLatest,
        paperTrading,
        paperAllowlist,
        paperAgent,
        schedulerStatus,
        runtimeMatrix,
        automationPlan,
      ] = await Promise.all([
        apiJson(`/api/status/live-activity?limit=${limit}`).catch(() => null),
        needsBatches ? apiJson('/api/status/batches').catch(() => null) : Promise.resolve(null),
        needsBatchAuto ? apiJson('/api/status/batch-autopilot').catch(() => null) : Promise.resolve(null),
        needsReplayAuto ? apiJson('/api/status/replay-autopilot').catch(() => null) : Promise.resolve(null),
        apiJson('/api/status/replay').catch(() => null),
        needsDataJobs ? apiJson('/api/status/data-jobs').catch(() => null) : Promise.resolve(null),
        needsAiStatus ? apiJson('/api/ai/analyst/status').catch(() => null) : Promise.resolve(null),
        apiJson('/api/ai/analyst/latest').catch(() => null),
        apiJson('/api/status/paper-trading').catch(() => null),
        apiJson('/api/automation/paper-allowlist/status').catch(() => null),
        needsPaperAgent ? apiJson('/api/paper-trading/status').catch(() => null) : Promise.resolve(null),
        needsSchedulerStatus ? apiJson('/api/system/scheduler-status').catch(() => null) : Promise.resolve(null),
        apiJson('/api/strategies/runtime-matrix').catch(() => null),
        apiJson('/api/automation/plan').catch(() => null),
      ]);
      if (cancelled) return;
      setState({
        overview,
        activity,
        batches,
        batchAuto,
        replayAuto,
        replay,
        dataJobs,
        aiStatus,
        aiLatest,
        paperTrading,
        paperAllowlist,
        paperAgent,
        schedulerStatus,
        runtimeMatrix: runtimeMatrix?.ok ? runtimeMatrix : null,
        automationPlan: automationPlan?.ok ? automationPlan : null,
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

function safeString(value, fallback = '—') {
  return text(value, fallback);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function overviewSafety(overview = {}) {
  const safety = overview?.safety || {};
  return {
    mode: safety.mode || overview.mode || 'paper_only',
    actions_allowed: safety.actions_allowed === true || overview.actions_allowed === true,
    can_place_orders: safety.can_place_orders === true || overview.can_place_orders === true,
    live_trading_enabled: safety.live_trading_enabled === true || overview.live_trading_enabled === true,
    broker_enabled: safety.broker_enabled === true || overview.broker_enabled === true,
  };
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
  'Låtsastest klart': 'Simulerat test klart',
  'paper_trade.simulated': 'Simulerat test klart',
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

function safeActivityMessage(value, fallback = 'Systemet uppdaterade status.') {
  const raw = text(value, fallback);
  return raw
    .replace(/\bWIN\b/g, 'Vinst i test')
    .replace(/\bLOSS\b/g, 'Förlust i test')
    .replace(/\bSTOP_HIT\b/g, 'Stop-nivå träffades')
    .replace(/\bEXIT_ENGINE_TARGET_HIT\b/g, 'Systemets mål träffades');
}

function normalizeRecommendationTitle(value, fallback = 'Vänta på mer data') {
  return text(value, fallback).replace(/^Kör\b/i, 'Granska');
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

function fmtSignedPct(value, digits = 3) {
  return fmtSigned(value, digits);
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
  const { tr } = useLanguage();
  return <span className={`research-badge research-badge-${tone}`}>{typeof children === 'string' ? tr(children) : children}</span>;
}

function autopilotReadiness(summary) {
  if (!summary) return { tone: 'neutral', label: 'Status saknas' };
  if (summary.enabled) return { tone: 'blue', label: summary.dryRunOnly ? 'Aktiv dry-run' : 'Förberedd' };
  return { tone: 'good', label: 'Förberedd men avstängd' };
}

function autopilotStatusText(summary) {
  if (!summary) return 'Status saknas';
  if (summary.enabled && summary.dryRunOnly) return 'Aktiv i dry-run';
  if (summary.enabled) return 'Förberedd';
  return 'Förberedd men avstängd';
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
  const { tr } = useLanguage();
  return (
    <div className="research-readiness">
      <Badge tone={readiness.tone}>{readiness.label}</Badge>
      <span>{tr('Endast testläge')}</span>
      {lastRun ? <span>{tr('Senaste händelse')}: {timeText(lastRun)}</span> : null}
      {lastResult ? <span>{tr('Senaste resultat')}: <SafeText value={lastResult} /></span> : null}
    </div>
  );
}

function Card({ className = '', children }) {
  return <article className={`research-card ${className}`.trim()}>{children}</article>;
}

function EmptyState({ title = 'Ingen data ännu', children }) {
  const { tr } = useLanguage();
  return (
    <div className="research-empty">
      <strong>{tr(title)}</strong>
      <p>{typeof children === 'string' ? tr(children) : children || tr('När systemet har mer testdata visas den här.')}</p>
    </div>
  );
}

function DegradedState({ title = 'Data saknas delvis', children }) {
  const { tr } = useLanguage();
  return (
    <div className="research-degraded">
      <strong>{tr(title)}</strong>
      <p>{typeof children === 'string' ? tr(children) : children || tr('En källa svarade inte, men resten av sidan fortsätter fungera.')}</p>
    </div>
  );
}

function SectionHeader({ eyebrow, title, subtitle, aside }) {
  const { tr } = useLanguage();
  return (
    <div className="research-section-head">
      <div>
        {eyebrow ? <div className="research-eyebrow">{tr(eyebrow)}</div> : null}
        <h2>{tr(title)}</h2>
        {subtitle ? <p>{tr(subtitle)}</p> : null}
      </div>
      {aside ? <div className="research-section-aside">{aside}</div> : null}
    </div>
  );
}

function MetricCard({ label, value, help, tone = 'neutral' }) {
  const { tr } = useLanguage();
  return (
    <Card className={`research-metric research-metric-${tone}`}>
      <span>{tr(label)}</span>
      <strong>{typeof value === 'string' ? tr(value) : value}</strong>
      {help ? <small>{tr(help)}</small> : null}
    </Card>
  );
}

function SafetyStatusBar({ overview }) {
  const { t } = useLanguage();
  const safety = overviewSafety(overview);
  const locked = safety.mode === 'paper_only'
    && !safety.actions_allowed
    && !safety.can_place_orders
    && !safety.live_trading_enabled
    && !safety.broker_enabled;
  return (
    <div className="research-safetybar">
      <div>
        <strong>{locked ? t('safety.systemSafe', 'Systemet är säkert') : t('safety.checkSafety', 'Kontrollera säkerheten')}</strong>
        <span>{t('safety.safeDescription', 'Ingen riktig handel sker. Plattformen analyserar, testar och lär sig i testläge.')}</span>
      </div>
      <div className="research-safety-flags">
        <Badge tone={locked ? 'good' : 'danger'}>{t('safety.paperOnly', 'Endast testläge')}</Badge>
        <Badge tone={!safety.can_place_orders ? 'good' : 'danger'}>{t('safety.noRealOrders', 'Inga riktiga order')}</Badge>
        <Badge tone={!safety.broker_enabled ? 'good' : 'danger'}>{t('safety.brokerOff', 'Broker avstängd')}</Badge>
        <Badge tone={!safety.live_trading_enabled ? 'good' : 'danger'}>{t('safety.liveTradingOff', 'Ingen livehandel')}</Badge>
      </div>
    </div>
  );
}

function pipelineSummary(block, fallbackSummary, fallbackHelp) {
  const status = text(block?.status, 'empty').toLowerCase();
  return {
    status,
    tone: toneForStatus(status),
    summary: fallbackSummary,
    help: block?.message || fallbackHelp,
  };
}

function dataPipelineSummary(block) {
  const ready = Math.max(Number(block?.readyForBatch || 0), Number(block?.readyForReplay || 0));
  return pipelineSummary(
    block,
    ready > 0 || Number(block?.missingData || 0) > 0
      ? `${fmtNumber(ready)} symboler redo, ${fmtNumber(block?.missingData || 0)} saknar data`
      : 'Ingen datatäckning ännu',
    'Data betyder historisk marknadsdata som systemet kan testa mot.',
  );
}

function batchPipelineSummary(block) {
  return pipelineSummary(
    block,
    Number(block?.totalBatches || 0) > 0 ? `${fmtNumber(block?.totalBatches || 0)} batchtester` : 'Inga batchtester ännu',
    'Batchtest betyder att systemet testar en strategi på många historiska datapunkter.',
  );
}

function replayPipelineSummary(block) {
  return pipelineSummary(
    block,
    Number(block?.totalReplayRuns || 0) > 0 ? `${fmtNumber(block?.totalReplayRuns || 0)} replay-runs` : 'Inga replaytester ännu',
    'Replay betyder att systemet spelar upp gammal marknadsdata som om det hände live.',
  );
}

function paperPipelineSummary(block) {
  return pipelineSummary(
    block,
    Number(block?.count || 0) > 0 ? `${fmtNumber(block?.count || 0)} paper trades` : 'Ingen låtsashandel ännu',
    'Paper trading betyder låtsashandel. Inga riktiga pengar används.',
  );
}

function learningPipelineSummary(block) {
  const reliable = text(block?.mostReliableSource, '');
  return {
    status: String(block?.status || 'empty').toLowerCase(),
    tone: toneForStatus(block?.status),
    summary: block?.status === 'empty'
      ? 'Ingen learning-data ännu'
      : reliable
        ? `Aktiv, källa: ${reliable}`
        : 'Learning saknar tydlig huvudkälla',
    help: block?.message || 'Learning sammanfattar testresultat och föreslår nästa säkra steg.',
  };
}

function SystemPipeline({ overview }) {
  const { tr } = useLanguage();
  const steps = [
    ['Data', dataPipelineSummary(overview?.dataStatus)],
    ['Batch', batchPipelineSummary(overview?.batchStatus)],
    ['Replay', replayPipelineSummary(overview?.replayStatus)],
    ['Paper', paperPipelineSummary(overview?.paperStatus)],
    ['Learning', learningPipelineSummary(overview?.learningStatus)],
  ];
  return (
    <div className="research-pipeline">
      {steps.map(([title, info], index) => (
        <div key={title} className={`research-pipeline-step research-pipeline-step-${info.tone}`}>
          <span>{index + 1}</span>
          <strong>{tr(title)}</strong>
          <small>{tr(text(info.summary, 'Saknas'))}</small>
          <Badge tone={info.tone}>{info.status}</Badge>
          <small>{tr(text(info.help, 'Saknas'))}</small>
        </div>
      ))}
    </div>
  );
}

function RankingList({ items, tone, emptyText }) {
  const list = arr(items);
  if (!list.length) return <EmptyState title="Ingen data ännu">{emptyText}</EmptyState>;
  return (
    <div className="research-strategy-group">
      {list.map((item, index) => (
        <StrategyCard
          key={`${text(item.key || item.strategy || item.strategy_id || item.name, 'strategy')}-${index}`}
          item={item}
          tone={tone}
          note={tone === 'good' ? 'Starkast just nu' : tone === 'warning' ? 'Svagast just nu' : 'Behöver mer data'}
        />
      ))}
    </div>
  );
}

function StrategyRankingSection({ ranking }) {
  return (
    <section className="research-section supervisor-section supervisor-section-ranking">
      <SectionHeader
        eyebrow="Strategier"
        title="Strategiranking"
        subtitle="Här ser du vilka strategier som ser starkast ut, vilka som är svagare och vilka som behöver mer testdata."
        aside={<Badge tone={sourceTone(ranking?.source || 'missing')}>{blockSourceLabel(ranking?.source || 'missing')}</Badge>}
      />
      <div className="research-grid research-grid-4">
        <MetricCard label="Strategier totalt" value={ranking?.totalStrategies != null ? fmtNumber(ranking.totalStrategies) : '—'} help="Alla kända strategier i registry." tone="blue" />
        <MetricCard label="Aktiva strategier" value={ranking?.activeStrategies != null ? fmtNumber(ranking.activeStrategies) : '—'} help="Kan användas i researchflödet." tone="good" />
        <MetricCard label="Inaktiva strategier" value={ranking?.inactiveStrategies != null ? fmtNumber(ranking.inactiveStrategies) : '—'} help="Pausade, paper_only eller avstängda." tone="warning" />
        <MetricCard label="Behöver mer data" value={hasItems(ranking?.strategiesNeedingMoreData) ? fmtNumber(arr(ranking?.strategiesNeedingMoreData).length) : (ranking?.source === 'missing' ? '—' : '0')} help="För få tester för säker slutsats." tone="blue" />
      </div>
      <div className="research-grid research-grid-3">
        <Card>
          <div className="research-card-title"><strong>Bästa strategier just nu</strong><Badge tone="good">{fmtNumber(arr(ranking?.topStrategies).length)}</Badge></div>
          {ranking?.source !== 'missing' && !arr(ranking?.topStrategies).length && ranking?.totalStrategies > 0
            ? <EmptyState title="Strategier finns, men ranking saknas i denna vy.">Overview saknar toppranking, så sidan visar fallbackdata där det går.</EmptyState>
            : <RankingList items={ranking?.topStrategies} tone="good" emptyText="Inga tydliga toppstrategier hittades ännu." />}
        </Card>
        <Card>
          <div className="research-card-title"><strong>Svagaste strategier</strong><Badge tone="warning">{fmtNumber(arr(ranking?.weakStrategies).length)}</Badge></div>
          <RankingList items={ranking?.weakStrategies} tone="warning" emptyText="Inga tydligt svaga strategier hittades ännu." />
        </Card>
        <Card>
          <div className="research-card-title"><strong>Strategier som behöver mer data</strong><Badge tone="blue">{fmtNumber(arr(ranking?.strategiesNeedingMoreData).length)}</Badge></div>
          <RankingList items={ranking?.strategiesNeedingMoreData} tone="neutral" emptyText="Alla visade strategier har redan viss testdata." />
        </Card>
      </div>
    </section>
  );
}

function RecommendationList({ items, emptyText }) {
  const list = arr(items);
  if (!list.length) return <EmptyState title="Ingen data ännu">{emptyText}</EmptyState>;
  return (
    <div className="research-list">
      {list.map((item, index) => (
        <span key={`${text(item.title || item.strategyId || item.strategy_id || item.problem || item.recommendedNextTest, 'item')}-${index}`}>
          <strong><SafeText value={item.title || item.problem || item.strategyId || item.strategy_id || 'Förslag'} /></strong>
          {' · '}
          <SafeText value={item.reason || item.evidence || item.suggestedChange || item.recommendedNextTest || 'Saknas'} />
        </span>
      ))}
    </div>
  );
}

function OverviewAiSection({ aiRecommendations, lossFeedbackQueue, nextRecommendedActions, learningStatus }) {
  const reliable = text(learningStatus?.mostReliableSource, 'Saknas');
  const narrowRec = learningStatus?.narrowLearning?.recommendedNextTest || null;
  return (
    <section className="research-section supervisor-section supervisor-section-overview-ai">
      <SectionHeader
        eyebrow="Nästa steg"
        title="AI, feedback och nästa rekommendation"
        subtitle="Det här är read-only förslag. Systemet ändrar inte strategier automatiskt."
        aside={<Badge tone="purple">Read-only</Badge>}
      />
      <div className="research-grid research-grid-3">
        <Card>
          <div className="research-card-title"><strong>AI-rekommendationer</strong><Badge tone={toneForStatus(aiRecommendations?.status)}>{text(aiRecommendations?.status, 'empty')}</Badge></div>
          {aiRecommendations?.status === 'empty'
            ? <p>AI-rekommendationer är inte samlade ännu. Backend-strukturen finns, men en tydlig AI-källa är inte vald.</p>
            : <RecommendationList items={aiRecommendations?.items} emptyText="Inga AI-rekommendationer hittades ännu." />}
        </Card>
        <Card>
          <div className="research-card-title"><strong>Loss feedback queue</strong><Badge tone={toneForStatus(lossFeedbackQueue?.status)}>{text(lossFeedbackQueue?.status, 'empty')}</Badge></div>
          {lossFeedbackQueue?.status === 'empty'
            ? <p>Förlust-feedback är inte aktiverad ännu. Senare ska svaga paper-resultat skickas tillbaka till batch/replay.</p>
            : <RecommendationList items={lossFeedbackQueue?.items} emptyText="Ingen loss feedback finns ännu." />}
        </Card>
        <Card>
          <div className="research-card-title"><strong>Nästa rekommenderade steg</strong><Badge tone="blue">{fmtNumber(arr(nextRecommendedActions).length)}</Badge></div>
          {narrowRec ? (
            <div className="research-next-action">
              <strong><SafeText value={narrowRec.title} fallback="Nästa rekommenderade test" /></strong>
              <p><SafeText value={narrowRec.reason} fallback="Narrow learning gav nästa rekommenderade test." /></p>
              <small>Mest tillförlitlig learning-källa: <SafeText value={reliable} /></small>
            </div>
          ) : (
            <RecommendationList items={nextRecommendedActions} emptyText="Inga rekommenderade steg finns ännu." />
          )}
        </Card>
      </div>
    </section>
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
        <div key={`${event.id || index}-${event.timestamp || index}`} className={`research-event research-event-${toneForStatus(event.severity || event.status)}${event.pinned ? ' research-event-pinned' : ''}`}>
          <div className="research-event-time">{shortTime(event.timestamp)}</div>
          <div className="research-event-dot" />
          <div className="research-event-body">
            <div className="research-event-top">
              <strong>{activityLabel(event)}</strong>
              {event.pinned ? <Badge tone="purple">📌 Senaste simulerade test</Badge> : null}
              <Badge tone={toneForStatus(event.status)}>{statusSv(event.status)}</Badge>
            </div>
            <p><SafeText value={safeActivityMessage(event.message)} fallback="Systemet uppdaterade status." /></p>
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
              <span><b>Säker testkörning</b>{test.dryRun === true ? 'Säker testkörning' : 'Låtsas-/batchtest'}</span>
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

function BatchStatusCard({ batches, autopilot }) {
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
          <span><b>Datum/tid</b>{timeText(latest?.completedAt || latest?.startedAt)}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Autopilot-plan</strong><Badge tone={autopilotReadiness(autopilot).tone}>Dry-run</Badge></div>
        <p><SafeText value={autopilot?.lastPlan?.recommendation || autopilot?.message} fallback="Ingen batchplan sparad ännu." /></p>
        <div className="research-mini-grid">
          <span><b>Status</b>{autopilotStatusText(autopilot)}</span>
          <span><b>Planerare</b>{autopilot?.enabled ? 'Förberedd' : 'Avstängd'}</span>
          <span><b>Nästa plan</b>{timeText(autopilot?.nextRun)}</span>
          <span><b>Planer idag</b>{fmtNumber(autopilot?.todayRunCount || 0)}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Bästa utfall</strong><Badge tone="good">Bäst</Badge></div>
        <p><SafeText value={simpleStrategyLabel(best?.strategy, 'Saknas')} fallback="Saknas" /></p>
        <div className="research-mini-grid">
          <span><b>Win rate</b>{best?.winRate != null ? fmtPct(best.winRate) : '—'}</span>
          <span><b>Avg</b>{best?.avgResult != null ? fmtSigned(best.avgResult) : '—'}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Sämsta utfall</strong><Badge tone="warning">Svagast</Badge></div>
        <p><SafeText value={simpleStrategyLabel(worst?.strategy, 'Saknas')} fallback="Saknas" /></p>
        <div className="research-mini-grid">
          <span><b>Win rate</b>{worst?.winRate != null ? fmtPct(worst.winRate) : '—'}</span>
          <span><b>Avg</b>{worst?.avgResult != null ? fmtSigned(worst.avgResult) : '—'}</span>
        </div>
      </Card>
    </div>
  );
}

function ReplayResultsCard({ replay, autopilot }) {
  const { t } = useLanguage();
  const latest = replay?.latestReplay || null;
  const latestResult = replay?.latestResult || latest;
  const period = latest?.period || {};
  const best = latest?.bestSymbol || null;
  return (
    <div className="research-grid research-grid-3">
      <MetricCard label="Replaytester totalt" value={fmtNumber(replay?.totalReplayTests || 0)} help="Sparade replaytester i säkert testläge." tone="blue" />
      <MetricCard label="Senaste replay" value={latest ? timeText(latest.createdAt) : 'Saknas'} help={latest ? `Period ${text(period.from, '?')}–${text(period.to, '?')}` : 'Ingen historik ännu'} tone={latest ? 'blue' : 'warning'} />
      <MetricCard label="Data sträcker sig" value={replay?.earliestPeriod ? `${text(replay.earliestPeriod)} →` : 'Saknas'} help={`Senaste: ${text(replay?.latestPeriod, 'Saknas')}`} tone="purple" />
      <Card className="research-wide">
        <div className="research-card-title">
          <strong>Senaste replay-resultat</strong>
          <Badge tone={toneForStatus(replay?.status)}>{text(replay?.status, 'Saknas')}</Badge>
        </div>
        <p><SafeText value={latest?.runId} fallback="Ingen replay ännu" /></p>
        <div className="research-mini-grid">
          <span><b>Period</b>{`${text(period.from, '?')}–${text(period.to, '?')}`}</span>
          <span><b>Symboler</b>{text(latest?.symbols, 'Saknas')}</span>
          <span><b>Timeframe</b>{text(latest?.timeframe, '2m')}</span>
          <span><b>Lägen hittade</b>{fmtNumber(latest?.totalEvents || 0)}</span>
          <span><b>Snittbetyg</b>{latest?.avgTradeScore != null ? fmtNumber(latest.avgTradeScore) : '—'}</span>
          <span><b>Bäst symbol</b>{best?.symbol ? `${best.symbol} (${fmtNumber(best.avgScore)})` : '—'}</span>
          <span><b>Källa</b>{text(replay?.source || latest?.replayMode, 'data/replay/runs')}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Replay-plan</strong><Badge tone={autopilotReadiness(autopilot).tone}>Dry-run</Badge></div>
        <p><SafeText value={autopilot?.lastReplayPlan?.recommendation || autopilot?.message} fallback="Ingen replay-plan sparad ännu." /></p>
        <div className="research-mini-grid">
          <span><b>Status</b>{autopilotStatusText(autopilot)}</span>
          <span><b>Planerare</b>{autopilot?.enabled ? 'Förberedd' : 'Avstängd'}</span>
          <span><b>Senaste resultat</b>{timeText(latestResult?.createdAt)}</span>
          <span><b>Nästa plan</b>{timeText(autopilot?.nextRun)}</span>
        </div>
      </Card>
    </div>
  );
}

// Map a paper-trade result token to a calm, beginner-safe Swedish badge label.
function paperResultLabel(result, t = null) {
  const label = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);
  const r = String(result || '').toUpperCase();
  if (r === 'WIN') return label('supervisor.resultWin', 'Vinst i test');
  if (r === 'LOSS') return label('supervisor.resultLoss', 'Förlust i test');
  if (r === 'TIMEOUT') return label('supervisor.resultTimeout', 'Avslutades på maxtid');
  if (r === 'SKIPPED') return label('supervisor.resultSkipped', 'Hoppades över');
  if (r === 'BLOCKED' || r === 'SAFETY_BLOCKED') return label('supervisor.resultBlocked', 'Blockerades av säkerhetsregel');
  if (r === 'BREAKEVEN') return 'Nära noll';
  return 'Testhändelse';
}
function paperResultTone(result) {
  const r = String(result || '').toUpperCase();
  if (r === 'WIN') return 'good';
  if (r === 'LOSS') return 'danger';
  if (r === 'TIMEOUT') return 'warning';
  return 'blue';
}

function normalizeOverviewPaperTest(item) {
  if (!item || item.type !== 'paper') return null;
  const pnl = Number(item.avgResult);
  const hasPnl = Number.isFinite(pnl);
  let result = 'SKIPPED';
  if (hasPnl && pnl > 0) result = 'WIN';
  else if (hasPnl && pnl < 0) result = 'LOSS';
  else if (String(item.reason || '').toUpperCase().includes('TIMEOUT')) result = 'TIMEOUT';
  return {
    id: item.id || null,
    timestamp: item.timestamp || null,
    symbol: item.symbol || null,
    timeframe: item.timeframe || null,
    strategy: item.strategy || null,
    strategyLabel: item.strategy || null,
    result,
    pnl: hasPnl ? pnl : null,
    exitReason: item.reason || item.status || null,
    lesson: item.reason || null,
    entryReason: item.recommendation || null,
    mode: 'paper_only',
  };
}

function normalizeOverviewReplayTest(item) {
  if (!item || item.type !== 'replay') return null;
  return {
    runId: item.id || null,
    createdAt: item.timestamp || null,
    symbols: text(item.symbol, '') ? String(item.symbol).split(',').map((s) => s.trim()).filter(Boolean) : [],
    symbolCount: text(item.symbol, '') ? String(item.symbol).split(',').map((s) => s.trim()).filter(Boolean).length : 0,
    timeframe: item.timeframe || null,
    totalEvents: Number(item.tradesCount) || 0,
    totalCandles: 0,
    avgTradeScore: Number.isFinite(Number(item.avgResult)) ? Number(item.avgResult) : null,
    bestSymbol: text(item.recommendation, '') ? { symbol: item.recommendation } : null,
    replayMode: 'overview_recent_tests',
    outcome: item.reason || item.status || null,
    period: {},
  };
}

function sumCounts(...values) {
  const nums = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!nums.length) return null;
  return nums.reduce((total, value) => total + value, 0);
}

function latestKnownTest(overview, batchSummary, replayStatus, paperStatus) {
  if (arr(overview?.recentTests).length) return arr(overview.recentTests)[0];
  const latestPaper = paperStatus?.latestPaperTrade?.timestamp
    ? normalizeOverviewPaperTest({
      id: paperStatus.latestPaperTrade.id,
      type: 'paper',
      timestamp: paperStatus.latestPaperTrade.timestamp,
      strategy: paperStatus.latestPaperTrade.strategy,
      symbol: paperStatus.latestPaperTrade.symbol,
      timeframe: paperStatus.latestPaperTrade.timeframe,
      avgResult: paperStatus.latestPaperTrade.pnl,
      reason: paperStatus.latestPaperTrade.lesson || paperStatus.latestPaperTrade.result,
      status: paperStatus.latestPaperTrade.status,
    })
    : null;
  const latestReplay = replayStatus?.latestReplay
    ? normalizeOverviewReplayTest({
      id: replayStatus.latestReplay.runId,
      type: 'replay',
      timestamp: replayStatus.latestReplay.createdAt,
      symbol: arr(replayStatus.latestReplay.symbols).join(', '),
      timeframe: replayStatus.latestReplay.timeframe,
      tradesCount: replayStatus.latestReplay.totalEvents,
      avgResult: replayStatus.latestReplay.avgTradeScore,
      recommendation: replayStatus.latestReplay.bestSymbol?.symbol,
      reason: replayStatus.latestReplay.outcome,
      status: 'completed',
    })
    : null;
  const latestBatch = batchSummary?.latestBatch
    ? {
      id: batchSummary.latestBatch.id || batchSummary.latestBatch.batchId || null,
      type: 'batch',
      timestamp: batchSummary.latestBatch.completedAt || batchSummary.latestBatch.startedAt || batchSummary.latestBatch.createdAt || null,
      strategy: batchSummary.latestBatch.bestOutcome?.strategy || batchSummary.latestBatch.strategy || null,
      symbol: arr(batchSummary.latestBatch.symbols).join(', ') || batchSummary.latestBatch.bestOutcome?.symbol || null,
      timeframe: batchSummary.latestBatch.timeframe || batchSummary.latestBatch.bestOutcome?.timeframe || null,
      blockedReason: batchSummary.latestBatch.blockedReason || null,
      status: batchSummary.latestBatch.status || null,
    }
    : null;
  return [latestPaper, latestReplay, latestBatch]
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))[0] || null;
}

function knownCount(...values) {
  const counts = values.map((value) => num(value)).filter((value) => value !== null && value >= 0);
  return counts.length ? counts[0] : null;
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasObjectKeys(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

function blockSourceLabel(source) {
  return source === 'overview' ? 'overview' : source === 'fallback' ? 'fallback' : 'saknas';
}

function sourceTone(source) {
  return source === 'overview' ? 'good' : source === 'fallback' ? 'warning' : 'neutral';
}

function getBatchCount(overview, data) {
  const overviewCount = knownCount(overview?.batchStatus?.totalBatches, overview?.batchSummary?.totalBatches);
  const fallbackCount = knownCount(data?.batches?.totalBatches);
  return {
    count: overviewCount ?? fallbackCount,
    source: overviewCount !== null ? 'overview' : fallbackCount !== null ? 'fallback' : 'missing',
    latest: overview?.batchSummary?.latestBatch || data?.batches?.latestBatch || null,
    best: overview?.batchSummary?.bestOutcome || data?.batches?.bestOutcome || null,
    worst: overview?.batchSummary?.worstOutcome || data?.batches?.worstOutcome || null,
    status: first(overview?.batchStatus?.status, overview?.batchSummary?.status, data?.batches?.status),
    autopilot: overview?.batchAutopilotSummary || data?.batchAuto || null,
  };
}

function getReplayCount(overview, data) {
  const overviewCount = knownCount(overview?.replayStatus?.totalReplayRuns, overview?.replaySummary?.totalReplayTests);
  const fallbackCount = knownCount(data?.replay?.totalReplayTests);
  return {
    count: overviewCount ?? fallbackCount,
    source: overviewCount !== null ? 'overview' : fallbackCount !== null ? 'fallback' : 'missing',
    latest: overview?.replayStatus?.latestReplay || data?.replay?.latestReplay || null,
    status: first(overview?.replayStatus?.status, data?.replay?.status),
    autopilot: overview?.replayAutopilotSummary || data?.replayAuto || null,
  };
}

function getPaperTradeCount(overview, data) {
  const overviewCount = knownCount(overview?.paperStatus?.count, overview?.paperTradingSummary?.count);
  const fallbackCount = knownCount(data?.paperTrading?.count, data?.paperTrading?.summary?.totalTrades);
  return {
    count: overviewCount ?? fallbackCount,
    source: overviewCount !== null ? 'overview' : fallbackCount !== null ? 'fallback' : 'missing',
    latest: overview?.paperStatus?.latestPaperTrade || data?.paperTrading?.latestPaperTrade || null,
    summary: overview?.paperStatus?.summary || overview?.paperTradingSummary || data?.paperTrading?.summary || null,
    runtimeStatus: data?.paperAgent || null,
  };
}

function getRecentTests(overview, data, recentPaper, recentReplays, batchRuns) {
  const overviewItems = arr(overview?.recentTests);
  if (overviewItems.length) {
    return { items: overviewItems, source: 'overview', message: null };
  }
  const fallbackItems = [
    ...arr(batchRuns).map((batch) => ({
      id: batch.id || batch.batchId || null,
      type: 'batch',
      timestamp: first(batch.completedAt, batch.startedAt, batch.createdAt),
      strategy: batch.bestOutcome?.strategy || batch.strategy || null,
      symbol: arr(batch.symbols).join(', ') || batch.bestOutcome?.symbol || null,
      timeframe: batch.timeframe || batch.bestOutcome?.timeframe || null,
      avgResult: batch.bestOutcome?.avgResult || null,
      reason: batch.blockedReason || batch.reason || null,
      status: batch.status || null,
    })),
    ...arr(recentReplays).map((run) => ({
      id: run.runId || null,
      type: 'replay',
      timestamp: run.createdAt || null,
      symbol: arr(run.symbols).join(', ') || null,
      timeframe: run.timeframe || null,
      avgResult: run.avgTradeScore || null,
      reason: run.outcome || null,
      status: run.totalEvents > 0 ? 'completed' : 'waiting',
    })),
    ...arr(recentPaper).map((trade) => ({
      id: trade.id || null,
      type: 'paper',
      timestamp: trade.timestamp || null,
      strategy: trade.strategy || null,
      symbol: trade.symbol || null,
      timeframe: trade.timeframe || null,
      avgResult: trade.pnl || null,
      reason: trade.lesson || trade.exitReason || null,
      status: trade.result || null,
    })),
  ]
    .filter((item) => item.timestamp)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return {
    items: fallbackItems,
    source: fallbackItems.length ? 'fallback' : 'missing',
    message: fallbackItems.length ? 'Samlad historikfeed saknas, men separata testresultat finns.' : null,
  };
}

function getStrategyRanking(overview, data) {
  const ranking = overview?.strategyRanking;
  const hasOverviewRanking = hasItems(ranking?.topStrategies) || hasItems(ranking?.weakStrategies) || hasItems(ranking?.strategiesNeedingMoreData);
  if (hasOverviewRanking || knownCount(ranking?.totalStrategies, ranking?.activeStrategies, ranking?.inactiveStrategies) !== null) {
    return {
      ...ranking,
      source: 'overview',
    };
  }
  const matrix = data?.runtimeMatrix;
  const plan = data?.automationPlan;
  const strategies = arr(matrix?.strategies);
  const scored = [...strategies]
    .filter((row) => num(row?.simulationSummary?.score) !== null || num(row?.simulationSummary?.winRate) !== null)
    .sort((a, b) => (num(b?.simulationSummary?.score) || num(b?.simulationSummary?.winRate) || -999) - (num(a?.simulationSummary?.score) || num(a?.simulationSummary?.winRate) || -999));
  const topStrategies = scored.slice(0, 6).map((row) => ({
    key: row.id,
    name: row.name,
    winRate: row.simulationSummary?.winRate,
    trades: row.simulationSummary?.trades,
    avgPnl: row.simulationSummary?.avgPnl,
  }));
  const weakStrategies = hasItems(plan?.weakStrategies)
    ? arr(plan.weakStrategies).slice(0, 6).map((row) => ({ key: row.id, name: row.name }))
    : scored.slice(-3).map((row) => ({
      key: row.id,
      name: row.name,
      winRate: row.simulationSummary?.winRate,
      trades: row.simulationSummary?.trades,
      avgPnl: row.simulationSummary?.avgPnl,
    }));
  const strategiesNeedingMoreData = hasItems(plan?.needsMoreData)
    ? arr(plan.needsMoreData).slice(0, 8).map((row) => ({ key: row.id, name: row.name }))
    : strategies.filter((row) => row.needsMoreData).slice(0, 8).map((row) => ({ key: row.id, name: row.name }));
  return {
    status: matrix?.ok ? 'fallback' : 'missing',
    totalStrategies: knownCount(matrix?.summary?.total, strategies.length),
    activeStrategies: strategies.filter((row) => row.scannerEnabled || row.replayEnabled || row.batchEnabled || row.learningEnabled).length,
    inactiveStrategies: knownCount(matrix?.summary?.total, strategies.length) !== null
      ? Math.max(0, (knownCount(matrix?.summary?.total, strategies.length) || 0) - strategies.filter((row) => row.scannerEnabled || row.replayEnabled || row.batchEnabled || row.learningEnabled).length)
      : null,
    topStrategies,
    weakStrategies,
    strategiesNeedingMoreData,
    source: matrix?.ok ? 'fallback' : 'missing',
  };
}

function getDataCoverage(overview, data) {
  const dataStatus = overview?.dataStatus;
  if (hasObjectKeys(dataStatus)) {
    return {
      source: 'overview',
      status: dataStatus.status || null,
      ready: knownCount(dataStatus.readyForBatch, dataStatus.readyForReplay),
      missing: knownCount(dataStatus.missingData),
      totalSymbols: knownCount(dataStatus.totalSymbols),
      providerStatus: dataStatus.providerStatus || null,
      timeframes: dataStatus.timeframes || null,
      note: null,
    };
  }
  return {
    source: 'missing',
    status: data?.dataJobs?.status || null,
    ready: null,
    missing: null,
    totalSymbols: data?.paperAgent?.marketGroups ? data.paperAgent.marketGroups.reduce((sum, group) => sum + arr(group.symbols).length, 0) : null,
    providerStatus: data?.dataJobs?.providerStatus || null,
    timeframes: data?.dataJobs?.latestImport?.timeframe || null,
    note: data?.dataJobs?.error || 'Datahämtning saknas i samlad vy.',
  };
}

function getLearningSummary(overview, data) {
  const learning = overview?.learningStatus;
  if (hasObjectKeys(learning)) {
    return {
      source: 'overview',
      status: learning.status || null,
      nextActions: arr(overview?.nextRecommendedActions),
      aiRecommendations: overview?.aiRecommendations || { status: 'empty', items: [] },
      summary: learning.message || null,
    };
  }
  return {
    source: 'fallback',
    status: data?.aiLatest?.status || data?.aiStatus?.status || null,
    nextActions: arr(data?.automationPlan?.recommendedPaperCandidates),
    aiRecommendations: { status: 'empty', items: [] },
    summary: data?.aiLatest?.latest?.output?.summary || data?.automationPlan?.nextSafeStep || null,
  };
}

function runtimeAutomaticLabel(status) {
  return {
    fullyAutomatic: 'fully automatic',
    partlyAutomatic: 'partly automatic',
    manualOnly: 'manual only',
    pausedOrBlocked: 'paused/blocked',
  }[status] || 'unknown';
}

function runtimeRecommendationLabel(value) {
  return {
    do_not_automate_yet: 'Do not automate yet',
    reduce_priority_or_review: 'Reduce priority or review',
    safe_to_monitor_more_closely_in_paper_only: 'Monitor more closely in paper only',
    good_candidate_for_more_manual_replay_or_batch: 'Good candidate for more manual replay or batch',
    collect_more_paper_replay_data: 'Collect more paper/replay data',
    manual_lab_replay_batch_only: 'Manual lab/replay/batch only',
    monitor_in_paper_only: 'Monitor in paper only',
  }[value] || text(value, 'No recommendation exposed');
}

function automationSafetyFrom(data = {}) {
  const overview = data.overview || {};
  const baseSafety = overviewSafety(overview);
  const matrixSafety = data.runtimeMatrix?.safety || {};
  return {
    mode: baseSafety.mode || matrixSafety.mode || 'paper_only',
    actions_allowed: baseSafety.actions_allowed === true || matrixSafety.actions_allowed === true,
    can_place_orders: baseSafety.can_place_orders === true || matrixSafety.can_place_orders === true,
    live_trading_enabled: baseSafety.live_trading_enabled === true || matrixSafety.live_trading_enabled === true,
    broker_enabled: baseSafety.broker_enabled === true || matrixSafety.broker_enabled === true,
  };
}

function isAutomationSafetyLocked(safety) {
  return safety.mode === 'paper_only'
    && !safety.actions_allowed
    && !safety.can_place_orders
    && !safety.live_trading_enabled
    && !safety.broker_enabled;
}

function deriveAutomationMode(data = {}) {
  const safety = automationSafetyFrom(data);
  const safe = isAutomationSafetyLocked(safety);
  const narrowSummary = data.overview?.blocks?.autopilot?.summary || null;
  const planners = [
    data.overview?.batchAutopilotSummary || data.batchAuto,
    data.overview?.replayAutopilotSummary || data.replayAuto,
    narrowSummary,
  ].filter(Boolean);
  const anyExecution = planners.some((item) => item.executionEnabled === true || item.dryRunOnly === false);
  const anyPlanner = planners.some((item) => item.enabled === true || item.schedulerActive === true);
  if (!safe) {
    return { key: 'off', label: 'Off', tone: 'danger', meaning: 'Safety is not locked, so automation must stay off.', safety };
  }
  if (anyExecution) {
    return { key: 'manual_approval', label: 'Manual approval', tone: 'warning', meaning: 'A future approval gate is required before any safe test can run.', safety };
  }
  if (anyPlanner) {
    return { key: 'dry_run', label: 'Dry-run', tone: 'blue', meaning: 'System can plan and suggest tests, but does not run them automatically.', safety };
  }
  return { key: 'off', label: 'Off', tone: 'neutral', meaning: 'No automation. Only manual safe tests.', safety };
}

function anyPlannerText(batchAuto, replayAuto, narrowScheduler) {
  if (batchAuto?.enabled || replayAuto?.enabled || narrowScheduler?.schedulerActive) {
    return 'Autopilot kan planera i systemet, men denna sida startar inga tester.';
  }
  if (batchAuto || replayAuto || narrowScheduler) {
    return 'Planerare hittad men inte aktiv just nu.';
  }
  return 'Automation är avstängd. Sidan visar bara status.';
}

function allowlistSourceMeta(endpointAllowlist, overviewAllowlist) {
  if (endpointAllowlist?.ok) return { loaded: true, source: 'endpoint' };
  if (overviewAllowlist?.ok) return { loaded: true, source: 'fallback' };
  return { loaded: false, source: 'missing' };
}

function AutomationModePanel({ data }) {
  const mode = deriveAutomationMode(data);
  const matrix = data.runtimeMatrix || {};
  const overviewRanking = data.overview?.strategyRanking || {};
  const endpointAllowlist = data.paperAllowlist || null;
  const fallbackAllowlist = data.overview?.paperAllowlist || null;
  const overviewAllowlist = endpointAllowlist || fallbackAllowlist || null;
  const strategies = Array.isArray(matrix.strategies) ? matrix.strategies : [];
  const candidateRows = strategies.length ? strategies
    .filter((row) => row.strongCandidate || row.automaticStatus === 'fullyAutomatic')
    .slice(0, 6) : arr(overviewRanking.topStrategies).slice(0, 6).map((row, index) => ({
      id: row.key || row.strategy || `top-${index}`,
      name: row.key || row.strategy || row.name || null,
      automaticStatus: 'manualOnly',
      strongCandidate: true,
      recommendation: 'collect_more_paper_replay_data',
    }));
  const approvedStrategyIds = arr(overviewAllowlist?.allowlist).map((row) => row.id).filter(Boolean);
  const allowlistMeta = allowlistSourceMeta(endpointAllowlist, fallbackAllowlist);
  const allowlistLoaded = allowlistMeta.loaded;
  const approvedStrategyCount = first(overviewAllowlist?.totalApproved, approvedStrategyIds.length);
  const batchAuto = data.overview?.batchAutopilotSummary || data.batchAuto || {};
  const replayAuto = data.overview?.replayAutopilotSummary || data.replayAuto || {};
  const narrowScheduler = data.overview?.blocks?.autopilot?.summary || {};
  const paperStatus = data.overview?.paperStatus || {};
  const paperAgent = data.paperAgent || paperStatus || {};
  const scheduler = data.schedulerStatus || {
    schedulerActive: batchAuto.enabled === true || replayAuto.enabled === true || narrowScheduler.schedulerActive === true,
    intervalMinutes: batchAuto.intervalMinutes || replayAuto.intervalMinutes || null,
  };

  return (
    <section className="research-section supervisor-section supervisor-section-mode">
      <SectionHeader
        eyebrow="Automation foundation"
        title="Automation Mode"
        subtitle="Systemet kan planera tester, men inga riktiga pengar används."
        aside={<Badge tone={mode.tone}>{mode.label}</Badge>}
      />
      <div className="research-grid research-grid-4">
        <MetricCard label="Current mode" value={mode.label} help={mode.meaning} tone={mode.tone} />
        <MetricCard label="Approved strategies" value={allowlistLoaded ? fmtNumber(approvedStrategyCount || 0) : '—'} help={allowlistLoaded ? `Läst från approved-listan i read-only läge. Källa: ${allowlistMeta.source}.` : 'Allowlist-status saknas i denna vy.'} tone={allowlistLoaded ? 'good' : 'warning'} />
        <MetricCard label="Safety status" value={isAutomationSafetyLocked(mode.safety) ? 'Locked' : 'Check'} help="paper_only, no broker, no live trading." tone={isAutomationSafetyLocked(mode.safety) ? 'good' : 'danger'} />
        <MetricCard label="Paper-only automation" value="Not active" help="Foundation only. No paper-only automation is enabled here." tone="warning" />
      </div>
      <div className="automation-mode-grid">
        <Card>
          <div className="research-card-title"><strong>Mode ladder</strong><Badge tone="blue">Read-only</Badge></div>
          <div className="automation-mode-ladder">
            <span className={mode.key === 'off' ? 'automation-mode-active' : ''}><b>Off</b>No automation. Only manual safe tests.</span>
            <span className={mode.key === 'dry_run' ? 'automation-mode-active' : ''}><b>Dry-run</b>System can plan and suggest tests, but does not run them automatically.</span>
            <span className={mode.key === 'manual_approval' ? 'automation-mode-active' : ''}><b>Manual approval</b>System suggests a test, but user must approve before it runs.</span>
            <span className={mode.key === 'paper_only' ? 'automation-mode-active' : ''}><b>Paper-only automation</b>Future mode for approved safe paper/replay/batch tests only.</span>
          </div>
        </Card>
        <Card>
          <div className="research-card-title"><strong>Current automation readers</strong><Badge tone="good">GET only</Badge></div>
          <div className="research-mini-grid">
            <span><b>Batch autopilot</b>{text(batchAuto.status, 'Saknas')} · dryRunOnly={String(batchAuto.dryRunOnly === true)}</span>
            <span><b>Replay autopilot</b>{text(replayAuto.status, 'Saknas')} · dryRunOnly={String(replayAuto.dryRunOnly === true)}</span>
            <span><b>Narrow autopilot</b>{text(narrowScheduler.status || narrowScheduler.blockedReason, 'Saknas')} · dryRunOnly={String(narrowScheduler.dryRunOnly === true)}</span>
            <span><b>Paper agent</b>{paperAgent.count || paperAgent.enabled ? 'Paper status active' : 'Saknas'} · mode={text(paperAgent.mode, 'paper_only')}</span>
            <span><b>Scheduler</b>{scheduler.schedulerActive ? 'Active' : 'Inactive'} · interval={fmtNumber(scheduler.intervalMinutes || 0)} min</span>
            <span><b>Execution</b>{mode.key === 'off' ? 'Automation är avstängd. Sidan visar bara status.' : anyPlannerText(batchAuto, replayAuto, narrowScheduler)}</span>
          </div>
        </Card>
        <Card>
          <div className="research-card-title"><strong>Top strategy candidates</strong><Badge tone="purple">{fmtNumber(candidateRows.length)}</Badge></div>
          <div className="supervisor-runtime-list">
            {candidateRows.length ? candidateRows.map((row) => (
              <div key={row.id} className="supervisor-runtime-row">
                <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
                <span>{runtimeAutomaticLabel(row.automaticStatus)} · {row.strongCandidate ? 'strong candidate' : runtimeRecommendationLabel(row.recommendation)}</span>
              </div>
            )) : <span className="research-muted">No runtime candidates exposed yet.</span>}
          </div>
        </Card>
      </div>
      <p className="research-muted">Autopilot kan planera i systemet, men denna sida startar inga tester.</p>
      <div className="automation-safety-note">
        mode=paper_only · actions_allowed=false · can_place_orders=false · live_trading_enabled=false · broker_enabled=false
      </div>
    </section>
  );
}

function confidenceTone(value) {
  return { high: 'good', medium: 'blue', low: 'neutral' }[value] || 'neutral';
}

function planEvidenceText(evidence = {}) {
  const parts = [];
  if (evidence.paperTrades) parts.push(`Paper ${evidence.paperWinRate ?? '–'}% / ${evidence.paperTrades} trades`);
  if (evidence.simTrades) parts.push(`Sim ${evidence.simWinRate ?? '–'}% / ${evidence.simTrades} trades`);
  parts.push(`Runtime: ${runtimeAutomaticLabel(evidence.runtimeStatus)}`);
  return parts.join(' · ');
}

function planWarningText(warnings = []) {
  const clean = warnings.filter((w) => w && w !== 'none');
  if (!clean.length) return 'Inga varningar';
  return clean.map((w) => String(w).replace(/_/g, ' ').replace('missing data:', 'saknar data: ')).join(' · ');
}

function AutomationPlanPanel({ plan }) {
  const { t } = useLanguage();
  const recommended = Array.isArray(plan?.recommendedPaperCandidates) ? plan.recommendedPaperCandidates : [];
  const promising = Array.isArray(plan?.promisingNeedsManualApproval) ? plan.promisingNeedsManualApproval : [];
  const blocked = Array.isArray(plan?.blockedStrategies) ? plan.blockedStrategies : [];
  const needsData = Array.isArray(plan?.needsMoreData) ? plan.needsMoreData : [];
  const weak = Array.isArray(plan?.weakStrategies) ? plan.weakStrategies : [];

  return (
    <section className="research-section supervisor-section supervisor-section-plan">
      <SectionHeader
        eyebrow="Read-only förslag"
        title="Automation Plan"
        subtitle="Förslag på vilka strategier som senare kan godkännas för paper-only testing. Detta är bara en plan. Inga tester startas automatiskt."
        aside={<Badge tone="blue">Dry-run</Badge>}
      />
      {!plan ? <DegradedState title="Automation Plan saknas">Planen exponeras inte ännu.</DegradedState> : null}
      <Card>
        <div className="research-card-title">
          <strong>{t('supervisor.recommendedForPaper')}</strong>
          <Badge tone="good">{fmtNumber(recommended.length)}</Badge>
        </div>
        <div className="automation-plan-list">
          {recommended.length ? recommended.map((row) => (
            <div key={row.id} className="automation-plan-row">
              <div className="automation-plan-row-head">
                <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
                <Badge tone={confidenceTone(row.confidence)}>{text(row.confidence, 'okänd')}</Badge>
              </div>
              <span className="automation-plan-reason">{text(row.reason)}</span>
              <span className="automation-plan-evidence">{planEvidenceText(row.evidence)}</span>
              <span className="automation-plan-warning">⚠ {planWarningText(row.warnings)}</span>
              <span className="automation-plan-next">Nästa: {text(row.nextStep)}</span>
            </div>
          )) : <span className="research-muted">Inga rekommenderade kandidater exponerade ännu.</span>}
        </div>
      </Card>
      <div className="supervisor-runtime-columns">
        <Card>
          <div className="research-card-title"><strong>Lovande – kräver manuell godkännande</strong><Badge tone="purple">{fmtNumber(promising.length)}</Badge></div>
          <div className="supervisor-runtime-list">
            {promising.length ? promising.map((row) => (
              <div key={row.id} className="supervisor-runtime-row">
                <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
                <span>{text(row.reason)}</span>
              </div>
            )) : <span className="research-muted">Inga lovande kandidater exponerade ännu.</span>}
          </div>
        </Card>
        <Card>
          <div className="research-card-title"><strong>Blockerade strategier</strong><Badge tone="warning">{fmtNumber(blocked.length)}</Badge></div>
          <div className="supervisor-runtime-list">
            {blocked.length ? blocked.map((row) => (
              <div key={row.id} className="supervisor-runtime-row">
                <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
                <span>{text(row.reason)}</span>
              </div>
            )) : <span className="research-muted">Inga blockerade strategier.</span>}
          </div>
        </Card>
        <Card>
          <div className="research-card-title"><strong>Behöver mer data / svaga</strong><Badge tone="blue">{fmtNumber(needsData.length + weak.length)}</Badge></div>
          <div className="supervisor-runtime-list">
            {needsData.slice(0, 6).map((row) => (
              <div key={row.id} className="supervisor-runtime-row">
                <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
                <span>Behöver mer data</span>
              </div>
            ))}
            {weak.slice(0, 4).map((row) => (
              <div key={row.id} className="supervisor-runtime-row">
                <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
                <span>Svag kandidat</span>
              </div>
            ))}
            {!needsData.length && !weak.length ? <span className="research-muted">Inget att visa.</span> : null}
          </div>
        </Card>
      </div>
      <Card className="research-wide">
        <div className="research-card-title"><strong>Nästa säkra steg</strong><Badge tone="blue">Read-only</Badge></div>
        <p className="research-muted">{text(plan?.nextSafeStep, 'Granska planen visuellt. Inga tester startas automatiskt.')}</p>
      </Card>
      <div className="automation-safety-note">
        Detta är bara en plan. Inga tester startas automatiskt. mode=paper_only · actions_allowed=false · can_place_orders=false · live_trading_enabled=false · broker_enabled=false
      </div>
    </section>
  );
}

// Manual Approval — records the user's approve/reject choices for the Automation
// Plan's recommendations. It only calls the approval endpoints (read + a small
// approve/reject write). It never starts a batch, replay or paper trade.
function ManualApprovalPanel({ plan }) {
  const { t } = useLanguage();
  const [approvals, setApprovals] = useState(null);
  const [allowlist, setAllowlist] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  const refresh = React.useCallback(() => {
    return Promise.all([
      apiJson('/api/automation/approvals').catch(() => null),
      apiJson('/api/automation/paper-allowlist/status').catch(() => null),
    ]).then(([approvalData, allowlistData]) => {
      setApprovals(approvalData?.ok ? approvalData : null);
      setAllowlist(allowlistData?.ok ? allowlistData : null);
    }).catch(() => {
      setApprovals(null);
      setAllowlist(null);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function act(endpoint, strategyId) {
    setBusyId(strategyId);
    setError('');
    try {
      const res = await apiJson(`/api/automation/approvals/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId, reason: `Manual ${endpoint} from supervisor` }),
      });
      if (!res?.ok) setError(res?.error || 'Åtgärden kunde inte sparas.');
      await refresh();
    } catch (err) {
      setError(err?.data?.error || err?.message || 'Åtgärden kunde inte sparas.');
    } finally {
      setBusyId('');
    }
  }

  const recommended = Array.isArray(plan?.recommendedPaperCandidates) ? plan.recommendedPaperCandidates : [];
  const approvedIds = Array.isArray(approvals?.approvedStrategyIds) ? approvals.approvedStrategyIds : [];
  const rejectedIds = Array.isArray(approvals?.rejectedStrategyIds) ? approvals.rejectedStrategyIds : [];
  const maxApproved = approvals?.maxApproved ?? 4;
  const atCap = approvedIds.length >= maxApproved;
  const withBlockers = new Set(Array.isArray(approvals?.approvedWithBlockers) ? approvals.approvedWithBlockers : []);
  const noLongerRec = new Set(Array.isArray(approvals?.approvedNoLongerRecommended) ? approvals.approvedNoLongerRecommended : []);
  const allowlistRows = arr(allowlist?.allowlist);
  const allowlistKnown = Boolean(allowlist && allowlist.ok);
  const allowlistTotalApproved = first(allowlist?.totalApproved, allowlistRows.length, 0);
  const allowlistReadyForPaperRuntime = first(allowlist?.readyForPaperRuntime, 0);

  return (
    <section className="research-section supervisor-section supervisor-section-approval">
      <SectionHeader
        eyebrow="Manuellt godkännande"
        title="Manual Approval"
        subtitle={t('supervisor.manualApprovalNote')}
        aside={<Badge tone={atCap ? 'warning' : 'good'}>{fmtNumber(approvedIds.length)} / {maxApproved} {t('supervisor.approved')}</Badge>}
      />
      {error ? <div className="automation-approval-error">⚠ {error}</div> : null}
      <Card>
        <div className="research-card-title">
          <strong>{t('supervisor.recommendedApprove')}</strong>
          <Badge tone="blue">{fmtNumber(recommended.length)}</Badge>
        </div>
        <div className="automation-approval-list">
          {recommended.length ? recommended.map((row) => {
            const approved = approvedIds.includes(row.id);
            const rejected = rejectedIds.includes(row.id);
            const busy = busyId === row.id;
            return (
              <div key={row.id} className="automation-approval-row">
                <div className="automation-approval-row-head">
                  <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
                  <Badge tone={confidenceTone(row.confidence)}>{text(row.confidence, 'okänd')}</Badge>
                  {approved ? <Badge tone="good">{t('supervisor.approved')}</Badge> : null}
                  {rejected ? <Badge tone="warning">{t('supervisor.rejected')}</Badge> : null}
                </div>
                <span className="automation-plan-reason">{text(row.reason)}</span>
                <div className="automation-approval-actions">
                  <button
                    type="button"
                    className="approval-btn approval-btn-approve"
                    disabled={busy || (approved) || (atCap && !approved)}
                    onClick={() => act('approve', row.id)}
                  >
                    {approved ? t('supervisor.approved') : t('supervisor.approveBtn')}
                  </button>
                  <button
                    type="button"
                    className="approval-btn approval-btn-reject"
                    disabled={busy || rejected}
                    onClick={() => act('reject', row.id)}
                  >
                    {rejected ? t('supervisor.rejected') : t('supervisor.rejectBtn')}
                  </button>
                </div>
              </div>
            );
          }) : <span className="research-muted">Inga rekommenderade kandidater att godkänna ännu.</span>}
        </div>
      </Card>
      <Card>
        <div className="research-card-title">
          <strong>Paper Allowlist</strong>
          <Badge tone={allowlistKnown ? 'good' : 'warning'}>{allowlistKnown ? 'Ja' : 'Saknas'}</Badge>
        </div>
        <div className="research-mini-grid">
          <span><b>Läser approved-lista</b>{allowlistKnown ? 'Ja' : 'Allowlist-status saknas i denna vy'}</span>
          <span><b>Approved som paper runtime får testa</b>{allowlistKnown ? `${fmtNumber(allowlistReadyForPaperRuntime)} / ${fmtNumber(allowlistTotalApproved)}` : '—'}</span>
          <span><b>Källa</b>{allowlistKnown ? 'endpoint' : 'saknas'}</span>
        </div>
        <div className="supervisor-runtime-list">
          {allowlistKnown && allowlistRows.length ? allowlistRows.map((row) => (
            <div key={row.id} className="supervisor-runtime-row">
              <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
              <span>{row.readyForPaperRuntime ? 'Redo för paper runtime' : 'Godkänd men väntar på runtime-koppling'}</span>
            </div>
          )) : <span className="research-muted">{allowlistKnown ? (allowlistTotalApproved > 0 ? 'Approved-strategier finns, men strateginamn exponeras inte i denna vy.' : 'Approved-listan är tom just nu.') : 'Allowlist-status saknas i denna vy'}</span>}
        </div>
      </Card>
      <div className="supervisor-runtime-columns">
        <Card>
          <div className="research-card-title"><strong>{t('supervisor.approvedList')} ({fmtNumber(approvedIds.length)})</strong><Badge tone="good">Paper-only</Badge></div>
          <div className="supervisor-runtime-list">
            {approvedIds.length ? approvedIds.map((id) => (
              <div key={id} className="supervisor-runtime-row">
                <strong>{simpleStrategyLabel(id)}</strong>
                {withBlockers.has(id) ? <span className="approval-drift">⚠ Har nu blockers</span>
                  : noLongerRec.has(id) ? <span className="approval-drift">⚠ Inte längre rekommenderad</span>
                  : <span>{t('supervisor.approvedNote')}</span>}
              </div>
            )) : <span className="research-muted">Inga godkända strategier kunde läsas från denna vy.</span>}
          </div>
        </Card>
        <Card>
          <div className="research-card-title"><strong>{t('supervisor.rejectedList')} ({fmtNumber(rejectedIds.length)})</strong><Badge tone="neutral">Read-only</Badge></div>
          <div className="supervisor-runtime-list">
            {rejectedIds.length ? rejectedIds.map((id) => (
              <div key={id} className="supervisor-runtime-row"><strong>{simpleStrategyLabel(id)}</strong><span>{t('supervisor.rejected')}</span></div>
            )) : <span className="research-muted">{t('supervisor.noRejected')}</span>}
          </div>
        </Card>
      </div>
      <div className="automation-safety-note">
        Detta startar inga tester. Det sparar bara ditt godkännande. mode=paper_only · actions_allowed=false · can_place_orders=false · live_trading_enabled=false · broker_enabled=false
      </div>
    </section>
  );
}

function StrategyAutomationStatus({ matrix }) {
  const summary = matrix?.summary || {};
  const strategies = Array.isArray(matrix?.strategies) ? matrix.strategies : [];
  const strong = strategies.filter((row) => row.strongCandidate).slice(0, 8);
  const weak = strategies.filter((row) => row.weakCandidate).slice(0, 8);
  const needsData = strategies.filter((row) => row.needsMoreData).slice(0, 8);

  const list = (items, empty) => (
    <div className="supervisor-runtime-list">
      {items.length ? items.map((row) => (
        <div key={row.id} className="supervisor-runtime-row">
          <strong>{simpleStrategyLabel(row.name || row.id)}</strong>
          <span>{runtimeAutomaticLabel(row.automaticStatus)} · {runtimeRecommendationLabel(row.recommendation)}</span>
        </div>
      )) : <span className="research-muted">{empty}</span>}
    </div>
  );

  return (
    <section className="research-section supervisor-section supervisor-section-automation">
      <SectionHeader
        eyebrow="Runtime truth"
        title="Strategy automation status"
        subtitle="The system is not automating every strategy. Only strategies with scanner/runtime connection can be tested automatically."
        aside={<Badge tone="good">Read-only</Badge>}
      />
      {!matrix ? <DegradedState title="Runtime matrix saknas">Runtime truth not exposed yet.</DegradedState> : null}
      <div className="research-grid research-grid-4">
        <MetricCard label="Fully automatic strategies" value={fmtNumber(summary.fullyAutomatic ?? 0)} help="Scanner and runtime are connected." tone="good" />
        <MetricCard label="Partly automatic" value={fmtNumber(summary.partlyAutomatic ?? 0)} help="Some connection exists, but more conditions are needed." tone="blue" />
        <MetricCard label="Manual only" value={fmtNumber(summary.manualOnly ?? 0)} help="Manual lab, replay, or batch only." tone="neutral" />
        <MetricCard label="Paused/blocked" value={fmtNumber(summary.pausedOrBlocked ?? 0)} help="Should not be automated yet." tone="warning" />
        <MetricCard label="Need more data" value={fmtNumber(summary.needsMoreData ?? 0)} help="Evidence is still thin." tone="warning" />
        <MetricCard label="Strong candidates" value={fmtNumber(summary.strongCandidates ?? 0)} help="Worth watching in paper only." tone="good" />
        <MetricCard label="Weak candidates" value={fmtNumber(summary.weakCandidates ?? 0)} help="Review or reduce priority." tone="warning" />
      </div>
      <div className="supervisor-runtime-columns">
        <Card>
          <div className="research-card-title"><strong>Best automatic candidates</strong><Badge tone="good">{fmtNumber(strong.length)}</Badge></div>
          {list(strong, 'No strong candidates exposed yet.')}
        </Card>
        <Card>
          <div className="research-card-title"><strong>Weak strategies to watch</strong><Badge tone="warning">{fmtNumber(weak.length)}</Badge></div>
          {list(weak, 'No weak candidates exposed yet.')}
        </Card>
        <Card>
          <div className="research-card-title"><strong>Strategies needing more data</strong><Badge tone="blue">{fmtNumber(needsData.length)}</Badge></div>
          {list(needsData, 'No more-data list exposed yet.')}
        </Card>
      </div>
    </section>
  );
}

// Plain-Swedish exit-reason labels. Raw tokens never reach the main view.
const EXIT_REASON_KEYS = {
  WIN: ['supervisor.resultWin', 'Vinst i test'],
  LOSS: ['supervisor.resultLoss', 'Förlust i test'],
  STOP_HIT: ['supervisor.resultStopHit', 'Stop-nivå träffades'],
  STOP_LOSS: ['supervisor.resultStopHit', 'Stop-nivå träffades'],
  STOPLOSS: ['supervisor.resultStopHit', 'Stop-nivå träffades'],
  EXIT_ENGINE_TARGET_HIT: ['supervisor.resultTargetHit', 'Systemets mål träffades'],
  TARGET_HIT: ['supervisor.resultTargetHit', 'Systemets mål träffades'],
  TAKE_PROFIT: ['supervisor.resultTargetHit', 'Systemets mål träffades'],
  TIMEOUT: ['supervisor.resultTimeout', 'Avslutades på maxtid'],
  TIME_EXIT: ['supervisor.resultTimeout', 'Avslutades på maxtid'],
  TIME_LIMIT: ['supervisor.resultTimeout', 'Avslutades på maxtid'],
  SKIPPED: ['supervisor.resultSkipped', 'Hoppades över'],
  BLOCKED: ['supervisor.resultBlocked', 'Blockerades av säkerhetsregel'],
  SAFETY_BLOCKED: ['supervisor.resultBlocked', 'Blockerades av säkerhetsregel'],
};

function exitReasonSv(value, fallback = 'Saknas', t = null) {
  const raw = text(value, '').trim();
  if (!raw) return fallback;
  const mapped = EXIT_REASON_KEYS[raw.toUpperCase()];
  if (!mapped) return raw;
  return typeof t === 'function' ? t(mapped[0], mapped[1]) : mapped[1];
}

function paperExitReasonLabel(value, t = null) {
  return exitReasonSv(value, safeActivityMessage(value, 'Saknas'), t);
}

function paperLesson(trade) {
  const exit = String(trade?.exitReason || '').toUpperCase();
  const result = String(trade?.result || '').toUpperCase();
  if (trade?.lesson) return trade.lesson;
  if (exit.includes('STOP')) return 'Stop-nivån träffades. Regeln kan behöva starkare bekräftelse innan signalen räknas som stark.';
  if (exit.includes('TIMEOUT') || result === 'TIMEOUT') return 'Testet nådde maxtiden. Systemet bör kontrollera om signalen var för svag eller för långsam.';
  if (exit.includes('TARGET') || result === 'WIN') return 'Testet nådde målet. Den här typen av bekräftelse kan vara värd fler säkra tester.';
  if (result === 'LOSS') return 'Testet förlorade. Jämför entry-regeln med liknande signaler innan den får högre vikt.';
  return 'Lärdomen sparas när fler detaljer finns i testresultatet.';
}

// True when the timestamp falls within `days` of the freshest reference time.
function withinDays(ts, days, nowRef) {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  return (nowRef - t) <= days * 86_400_000;
}

function tsValue(value) {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Read-only, expandable list of recent paper trades (låtsastester).
// The summary row stays simple; raw technical info only appears when expanded.
function PaperTradeList({ trades, limit = 14 }) {
  const { t } = useLanguage();
  const visible = arr(trades).slice(0, limit);
  if (!visible.length) return <EmptyState title="Inga låtsastester">Det finns inga låtsastester de senaste 14 dagarna.</EmptyState>;
  return (
    <div className="research-rowlist">
      {visible.map((trade, index) => (
        <details className="research-row" key={`${trade.id || index}-${trade.timestamp || index}`}>
          <summary className="research-row-summary">
            <span className="research-row-time">{timeText(trade.timestamp)}</span>
            <span className="research-row-sym">{text(trade.symbol, '—')}</span>
            <span className="research-row-strat">{simpleStrategyLabel(trade.strategyLabel || trade.strategy, 'Simulerad signal')}</span>
            <span className="research-row-tf">{text(trade.timeframe, '—')}</span>
            <Badge tone={paperResultTone(trade.result)}>{paperResultLabel(trade.result, t)}</Badge>
            <span className={`research-row-pnl ${Number(trade.pnl) >= 0 ? 'research-pos' : 'research-neg'}`}>{trade.pnl != null ? fmtSigned(trade.pnl) : '—'}</span>
            <span className="research-row-reason">{paperExitReasonLabel(trade.exitReason, t)}</span>
            <span className="research-row-caret" aria-hidden="true">▾</span>
          </summary>
          <div className="research-row-detail">
            <p className="research-muted">Vad systemet lärde sig: <SafeText value={paperLesson(trade)} /></p>
            <div className="research-mini-grid">
              <span><b>Varför signalen skapades</b><SafeText value={trade.entryReason} fallback="Saknas" /></span>
              <span><b>Hur testet avslutades</b>{paperExitReasonLabel(trade.exitReason, t)}</span>
              <span><b>Resultat (P/L)</b>{trade.pnl != null ? fmtSigned(trade.pnl) : '—'}</span>
            </div>
            <details className="research-tech research-tech-inline">
              <summary>Visa tekniska detaljer</summary>
              <div className="research-mini-grid">
                <span><b>Tekniskt strateginamn</b>{text(trade.strategy, 'Saknas')}</span>
                <span><b>Rå utfallskod</b>{text(trade.result, 'Saknas')}</span>
                <span><b>Rå exit-kod</b>{text(trade.exitReason, 'Saknas')}</span>
                <span><b>Tekniskt testnamn</b>{text(trade.id, 'Saknas')}</span>
                <span><b>Datakälla</b>låtsashandel (paper)</span>
                <span><b>Läge</b>{text(trade.mode || 'paper_only')}</span>
              </div>
            </details>
          </div>
        </details>
      ))}
    </div>
  );
}

function batchRunsFromStatus(batchSummary, overview) {
  const candidates = [
    batchSummary?.latestBatch,
    batchSummary?.latestCompletedBatch,
    batchSummary?.latestFailedBatch,
    overview?.batchSummary?.latestBatch,
    overview?.batchSummary?.latestCompletedBatch,
    overview?.batchSummary?.latestFailedBatch,
  ];
  const seen = new Set();
  return arr(candidates).filter((batch) => {
    const key = text(first(batch.id, batch.batchId, batch.completedAt, batch.startedAt), '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function batchLesson(batch, fallbackBest) {
  const best = batch?.bestOutcome || fallbackBest || {};
  if (batch?.status === 'failed') {
    return `Batchtestet misslyckades. Orsak: ${text(first(batch.failedReason, batch.reason, batch.blockedReason), 'saknas i statusdata')}.`;
  }
  if (!best?.strategy) return 'Batchtestet finns i status, men bästa resultat saknas i sammanfattningen.';
  return `Batchtestet visade att ${simpleStrategyLabel(best.strategy)} på ${text(best.symbol, 'en symbol')} var bäst i den här körningen.`;
}

function BatchRunList({ runs, fallbackBest, limit = 4 }) {
  const visible = arr(runs).slice(0, limit);
  if (!visible.length) {
    return <DegradedState title="Begränsad batchhistorik">Statusdatan visar batchsammanfattning och totalsiffror, men inte en full 14-dagarslista ännu.</DegradedState>;
  }
  return (
    <div className="research-rowlist">
      {visible.map((batch, index) => {
        const best = batch.bestOutcome || fallbackBest || {};
        return (
          <details className="research-row" key={`${batch.id || batch.batchId || index}-${batch.completedAt || batch.startedAt || index}`}>
            <summary className="research-row-summary">
              <span className="research-row-time">{timeText(batch.completedAt || batch.startedAt || batch.createdAt)}</span>
              <span className="research-row-sym">{text(batch.id || batch.batchId, 'Batchtest')}</span>
              <span className="research-row-strat">{simpleStrategyLabel(best.strategy, 'Bästa strategi saknas')}</span>
              <span className="research-row-tf">{text(first(best.timeframe, batch.timeframe), '—')}</span>
              <Badge tone={toneForStatus(batch.status)}>{text(batch.status, 'Status saknas')}</Badge>
              <span className="research-row-pnl">{best.winRate != null ? fmtPct(best.winRate) : '—'}</span>
              <span className="research-row-reason">{best.symbol ? `Bäst: ${best.symbol}` : 'Symbol saknas'}</span>
              <span className="research-row-caret" aria-hidden="true">▾</span>
            </summary>
            <div className="research-row-detail">
              <p className="research-muted">{batchLesson(batch, fallbackBest)}</p>
              <div className="research-mini-grid">
                <span><b>Score</b>{best.score != null ? fmtNumber(best.score) : '—'}</span>
                <span><b>Win rate</b>{best.winRate != null ? fmtPct(best.winRate) : '—'}</span>
                <span><b>Avg P/L</b>{best.avgResult != null ? fmtSigned(best.avgResult) : '—'}</span>
                <span><b>Total P/L</b>{best.totalPnl != null ? fmtSigned(best.totalPnl) : '—'}</span>
                <span><b>Trades</b>{fmtNumber(best.trades || 0)}</span>
                <span><b>Kombinationer</b>{fmtNumber(batch.combinationsTested || 0)}</span>
              </div>
              <details className="research-tech research-tech-inline">
                <summary>Visa tekniska detaljer</summary>
                <div className="research-mini-grid">
                  <span><b>Tekniskt testnamn</b>{text(batch.id || batch.batchId, 'Saknas')}</span>
                  <span><b>Rå status</b>{text(batch.status, 'Saknas')}</span>
                  <span><b>Dry-run</b>Ja</span>
                </div>
              </details>
            </div>
          </details>
        );
      })}
    </div>
  );
}

// Read-only, expandable list of replay tests (replaytester) for the last days.
function ReplayList({ replays, limit = 10 }) {
  const visible = arr(replays).slice(0, limit);
  if (!visible.length) return <EmptyState title="Inga replaytester">Det finns inga replaytester de senaste 14 dagarna.</EmptyState>;
  return (
    <div className="research-rowlist">
      {visible.map((run, index) => {
        const period = run.period || {};
        const hadActivity = Number(run.totalEvents) > 0 || Number(run.totalCandles) > 0;
        return (
          <details className="research-row" key={`${run.runId || index}-${run.createdAt || index}`}>
            <summary className="research-row-summary">
              <span className="research-row-time">{timeText(run.createdAt)}</span>
              <span className="research-row-sym">{`${text(period.from, '?')}–${text(period.to, '?')}`}</span>
              <span className="research-row-strat">{fmtNumber(run.symbolCount || arr(run.symbols).length)} symboler</span>
              <span className="research-row-tf">{text(run.timeframe, '2m')}</span>
              <Badge tone={hadActivity ? 'blue' : 'warning'}>{hadActivity ? t('supervisor.foundSetups') : t('supervisor.noSetups')}</Badge>
              <span className="research-row-pnl">{fmtNumber(run.totalEvents || 0)} {t("supervisor.setups")}</span>
              <span className="research-row-reason">{hadActivity ? t("supervisor.replayWithActivity") : t("supervisor.replayNoHits")}</span>
              <span className="research-row-caret" aria-hidden="true">▾</span>
            </summary>
            <div className="research-row-detail">
              <p className="research-muted">{hadActivity
                ? t('supervisor.replayFoundNote')
                : t('supervisor.replayNoHitsNote')}</p>
              <div className="research-mini-grid">
                <span><b>Symboler</b>{text(run.symbols, 'Saknas')}</span>
                <span><b>Antal lägen</b>{fmtNumber(run.totalEvents || 0)}</span>
                <span><b>Candles</b>{fmtNumber(run.totalCandles || 0)}</span>
                <span><b>Snittbetyg</b>{run.avgTradeScore != null ? fmtNumber(run.avgTradeScore) : '—'}</span>
                <span><b>Bäst symbol</b>{run.bestSymbol?.symbol ? text(run.bestSymbol.symbol) : '—'}</span>
                <span><b>Sammanfattning</b><SafeText value={run.outcome} fallback="Saknas" /></span>
              </div>
              <details className="research-tech research-tech-inline">
                <summary>Visa tekniska detaljer</summary>
                <div className="research-mini-grid">
                  <span><b>Tekniskt testnamn</b>{text(run.runId, 'Saknas')}</span>
                  <span><b>Replay-läge</b>{text(run.replayMode, 'Saknas')}</span>
                  <span><b>Datakälla</b>data/replay/runs</span>
                </div>
              </details>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function PaperTradingCard({ paper }) {
  const { t } = useLanguage();
  const summary = paper?.summary || {};
  const latest = paper?.latestPaperTrade && paper.latestPaperTrade.id ? paper.latestPaperTrade : null;
  const best = summary.bestStrategy || null;
  return (
    <>
      <div className="research-grid research-grid-4">
        <MetricCard label="Simulerade signaler" value={fmtNumber(paper?.count || summary.totalTrades || 0)} help="Alla är testhändelser. Inga riktiga pengar." tone="blue" />
        <MetricCard label="Andel lyckade tester" value={fmtPct(summary.winRate)} help="Win rate i låtsashandel." tone="good" />
        <MetricCard label="Genomsnittligt resultat" value={summary.avgPnl != null ? fmtSigned(summary.avgPnl) : '—'} help="Simulerat resultat per test." tone="blue" />
        <MetricCard label="Starkast i test" value={simpleStrategyLabel(best?.strategy, 'Samla mer data')} help={best?.winRate != null ? `Träff ${fmtPct(best.winRate)}` : 'För lite data ännu'} tone="purple" />
      </div>
      <Card className="research-wide">
        <div className="research-card-title">
          <strong>Senaste låtsastest</strong>
          <Badge tone={latest ? paperResultTone(latest.result) : toneForStatus(paper?.status)}>
            {latest ? paperResultLabel(latest.result, t) : text(paper?.status, 'Saknas')}
          </Badge>
        </div>
        {latest ? (
          <>
            <p><strong>{timeText(latest.timestamp)}</strong> · <SafeText value={latest.symbol} fallback="Okänd symbol" /></p>
            <div className="research-mini-grid">
              <span><b>Strategi</b>{simpleStrategyLabel(latest.strategyLabel || latest.strategy, 'Simulerad signal')}</span>
              <span><b>Symbol/timeframe</b>{text([latest.symbol, latest.timeframe].filter(Boolean), 'Saknas')}</span>
              <span><b>Resultat</b>{latest.pnl != null ? fmtSigned(latest.pnl) : '—'}</span>
              <span><b>Varför signalen skapades</b><SafeText value={latest.entryReason} fallback="Saknas" /></span>
              <span><b>Hur testet avslutades</b><SafeText value={paperExitReasonLabel(latest.exitReason, t)} fallback="Saknas" /></span>
              <span><b>Vad systemet lärde sig</b><SafeText value={latest.lesson} fallback="Saknas" /></span>
            </div>
          </>
        ) : (
          <p>Det finns inga låtsastester att visa ännu.</p>
        )}
      </Card>
    </>
  );
}

function DataPipelineCard({ dataJobs }) {
  const hourly = dataJobs?.hourlyImport || {};
  const weekly = dataJobs?.weeklyBackfill || {};
  const cache = dataJobs?.cacheStatus || {};
  const quality = dataJobs?.dataQuality || {};
  const coverage = dataJobs?.coverageSummary || {};
  const summary = dataJobs?.summary || {};
  const latestImport = hourly.latestImport || {};
  const latestBackfill = weekly.latestBackfill || {};
  return (
    <>
      <div className="research-pipeline research-pipeline-data">
        {['Alpaca', 'Candles', 'Cache', 'Tester', 'AI lär sig'].map((step, index) => (
          <div key={step} className="research-pipeline-step">
            <span>{index + 1}</span>
            <strong>{step}</strong>
            <small>{index === 0 ? (dataJobs?.alpacaConfigured ? 'Konfigurerad' : 'Saknar config') : 'Endast status'}</small>
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
          <span><b>Tidigaste data</b>{text(weekly.dateRange?.from || latestBackfill.dateRange?.from, 'Saknas')}</span>
          <span><b>Senaste data</b>{text(latestImport.to || weekly.dateRange?.to || latestBackfill.dateRange?.to, 'Saknas')}</span>
          <span><b>Tidsramar</b>{text(latestImport.timeframe || latestBackfill.timeframe || latestBackfill.timeframes, 'Saknas')}</span>
          <span><b>Cache-symboler</b>{fmtNumber(cache.symbolsCached || 0)}</span>
          <span><b>Redo för tester</b>{fmtNumber(summary.readyForTests ?? 0)}</span>
          <span><b>Coverage-ready</b>{fmtNumber((coverage.readyForReplay || 0) + (coverage.readyForBatch || 0))}</span>
          <span><b>Saknar historik</b>{fmtNumber(arr(coverage.missingSymbols).length)}</span>
        </div>
        <p className="research-muted">{safeString(summary.note, 'Datajobb-status saknas.')}</p>
      </Card>
    </>
  );
}

function AiAnalystSummary({ status, latest, learningStatus, nextRecommendedActions, ranking }) {
  const latestPayload = latest?.latest || latest || {};
  const output = latestPayload.output || {};
  const latestOutputSummary = status?.latestOutputSummary || latestPayload.outputSummary || null;
  const provider = status?.provider || learningStatus?.aiAnalystStatus?.provider || latestPayload.provider || 'disabled';
  const disabled = provider === 'disabled' || latestPayload.status === 'disabled' || status?.enabled === false;
  const bestStrategy = first(arr(ranking?.topStrategies)[0]?.key, learningStatus?.narrowLearning?.bestStrategy, output.best_strategy);
  const weakStrategy = first(arr(ranking?.weakStrategies)[0]?.key, learningStatus?.narrowLearning?.worstStrategy, output.weakest_strategy);
  const recommendedTests = arr(nextRecommendedActions).length
    ? arr(nextRecommendedActions).map((item) => item.title || item.reason).filter(Boolean)
    : arr(output.next_recommended_tests);
  const summaryText = first(
    learningStatus?.message,
    output.summary,
    disabled ? 'AI Analyst är avstängd. Systemet fungerar ändå med intern learning.' : 'Ingen AI-analys sparad ännu.',
  );
  return (
    <div className="research-grid research-grid-2">
      <Card className="research-ai-card">
        <div className="research-card-title">
          <strong>AI-analytiker</strong>
          <Badge tone={disabled ? 'warning' : 'purple'}>{disabled ? 'Avstängd' : 'Endast visning'}</Badge>
        </div>
        <p>AI-analytikern läser systemets säkra sammanfattning. AI kan inte handla eller ändra något.</p>
        <div className="research-mini-grid">
          <span><b>Leverantör</b>{provider}</span>
          <span><b>Model</b>{text(status?.model, 'Saknas')}</span>
          <span><b>Senast</b>{timeText(status?.latestTimestamp || learningStatus?.connectorSummary?.generatedAt || latestPayload.generatedAt)}</span>
          <span><b>Confidence</b>{output.confidence != null ? fmtPct(Number(output.confidence) * 100) : '—'}</span>
          <span><b>Lärdomar</b>{fmtNumber(status?.latestLearnedCount ?? arr(latestOutputSummary?.what_ai_learned).length ?? 0)}</span>
          <span><b>Nästa tester</b>{fmtNumber(status?.latestNextTestCount ?? arr(latestOutputSummary?.next_recommended_tests).length ?? 0)}</span>
          <span><b>Risker</b>{fmtNumber(status?.latestRiskCount ?? arr(latestOutputSummary?.risks).length ?? 0)}</span>
        </div>
        <p className="research-muted">Uppdateras automatiskt. AI kan bara läsa och sammanfatta — aldrig handla eller ändra något.</p>
      </Card>
      <Card className="research-ai-card">
        <div className="research-card-title"><strong>AI-forskningssammanfattning</strong><Badge tone="purple">AI Research Summary</Badge></div>
        <p><SafeText value={summaryText} fallback="Ingen data hittades ännu." /></p>
        <p className="research-muted">AI-sammanfattningen är test- och forskningsdata. Den är inte köp- eller säljråd.</p>
        <div className="research-list">
          <strong>Vad AI lärde sig</strong>
          {arr(output.what_ai_learned).length ? arr(output.what_ai_learned).slice(0, 4).map((item) => <span key={item}><SafeText value={item} /></span>) : <span>Ingen AI-lärdom sparad ännu.</span>}
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Strategier enligt AI</strong><Badge tone="purple">Analys</Badge></div>
        <div className="research-mini-grid">
          <span><b>Bäst</b>{simpleStrategyLabel(bestStrategy, 'Saknas')}</span>
          <span><b>Svagast</b>{simpleStrategyLabel(weakStrategy, 'Saknas')}</span>
        </div>
      </Card>
      <Card>
        <div className="research-card-title"><strong>Nästa rekommenderade tester</strong><Badge tone="blue">Förslag</Badge></div>
        <div className="research-list">
          {recommendedTests.length ? recommendedTests.slice(0, 5).map((item) => <span key={item}><SafeText value={item} /></span>) : <span>AI-rekommendationer är inte samlade ännu.</span>}
        </div>
      </Card>
    </div>
  );
}

function riskTone(level) {
  const s = String(level || '').toLowerCase();
  if (s === 'low') return 'good';
  if (s === 'medium') return 'warning';
  if (s === 'high' || s === 'critical') return 'danger';
  return 'neutral';
}

function RiskBlockerCard({ risks, riskSummary, dataJobs, batches, activity, dataStatus }) {
  const providerErrors = arr(dataJobs?.dataQuality?.providerErrors).concat(
    Object.entries(dataStatus?.providerStatus || {})
      .filter(([, row]) => row && row.ok === false)
      .map(([provider, row]) => ({ message: row.message || `${provider} rapporterade fel.` })),
  );
  const degradedSources = arr(activity?.sources).filter((source) => source.status === 'degraded');
  const summaryCards = riskSummary ? [
    {
      tone: riskTone(riskSummary.moneyRiskLevel),
      title: 'Pengarrisk',
      message: `${riskSummary.moneyRiskLevel || 'okänt'} · ${arr(riskSummary.moneyRisks).length} signaler`,
    },
    {
      tone: riskTone(riskSummary.systemRiskLevel),
      title: 'Systemrisk',
      message: `${riskSummary.systemRiskLevel || 'okänt'} · ${arr(riskSummary.systemRisks).length} signaler`,
    },
  ] : [];
  const combined = [
    ...summaryCards,
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

function TechnicalDetailsPanel({ data, technical }) {
  const safety = overviewSafety(data.overview || {});
  const overview = data.overview || {};
  const tech = technical || overview.technical || null;
  return (
    <details className="research-tech">
      <summary>Visa tekniska detaljer</summary>
      <div className="research-tech-grid">
        <MetricCard label="mode" value={safety.mode || 'paper_only'} tone="good" />
        <MetricCard label="actions_allowed" value={String(safety.actions_allowed === true)} tone="good" />
        <MetricCard label="can_place_orders" value={String(safety.can_place_orders === true)} tone="good" />
        <MetricCard label="live_trading_enabled" value={String(safety.live_trading_enabled === true)} tone="good" />
        <MetricCard label="broker_enabled" value={String(safety.broker_enabled === true)} tone="good" />
        <MetricCard label="AI cache" value={(overview.aiAnalystStatus || data.aiStatus)?.cacheEnabled ? 'På' : 'Av'} help={`${fmtNumber((overview.aiAnalystStatus || data.aiStatus)?.cacheTtlMs || 0)} ms`} tone="purple" />
        <MetricCard label="Batch API" value={text(overview.batchStatus?.status || data.batches?.status, 'Saknas')} tone={toneForStatus(overview.batchStatus?.status || data.batches?.status)} />
        <MetricCard label="Batch autopilot" value={text(overview.batchAutopilotSummary?.status || data.batchAuto?.status, 'Saknas')} help={`dryRunOnly=${String((overview.batchAutopilotSummary?.dryRunOnly || data.batchAuto?.dryRunOnly) === true)}`} tone={toneForStatus(overview.batchAutopilotSummary?.status || data.batchAuto?.status)} />
        <MetricCard label="Replay autopilot" value={text(overview.replayAutopilotSummary?.status || data.replayAuto?.status, 'Saknas')} help={`dryRunOnly=${String((overview.replayAutopilotSummary?.dryRunOnly || data.replayAuto?.dryRunOnly) === true)}`} tone={toneForStatus(overview.replayAutopilotSummary?.status || data.replayAuto?.status)} />
        <MetricCard label="Replay API" value={text(overview.replayStatus?.status || data.replay?.status, 'Saknas')} help={`${fmtNumber(overview.replayStatus?.totalReplayRuns || data.replay?.totalReplayTests || 0)} replaytester`} tone={toneForStatus(overview.replayStatus?.status || data.replay?.status)} />
        <MetricCard label="Data API" value={text(overview.dataStatus?.status || data.dataJobs?.status, 'Saknas')} tone={toneForStatus(overview.dataStatus?.status || data.dataJobs?.status)} />
        <MetricCard label="Activity API" value={text(data.activity?.status, 'Saknas')} tone={toneForStatus(data.activity?.status)} />
        <MetricCard label="Provider" value={text(overview.aiAnalystStatus?.provider || data.aiStatus?.provider || data.dataJobs?.providerStatus?.alpaca?.provider, 'Saknas')} tone="neutral" />
        <MetricCard label="scheduler status" value={text([overview.batchAutopilotSummary?.status, overview.replayAutopilotSummary?.status, data.batchAuto?.status, data.replayAuto?.status].filter(Boolean), 'Saknas')} tone="blue" />
      </div>
      {tech ? (
        <>
          <div className="research-tech-grid">
            <MetricCard label="Overview byggd" value={timeText(tech.generatedAt)} tone={toneForStatus(tech.status)} />
            <MetricCard label="Cacheålder" value={tech.cacheAgeMs !== null && tech.cacheAgeMs !== undefined ? `${fmtNumber(tech.cacheAgeMs)} ms` : '—'} tone="blue" />
            <MetricCard label="Block ok/degraded/missing" value={`${fmtNumber(tech.counts?.ok || 0)} / ${fmtNumber(tech.counts?.degraded || 0)} / ${fmtNumber(tech.counts?.missing || 0)}`} tone={toneForStatus(tech.status)} />
            <MetricCard label="Warnings" value={tech.warnings?.length ? fmtNumber(tech.warnings.length) : '0'} tone={tech.warnings?.length ? 'warning' : 'good'} />
          </div>
          <Card className="research-wide">
            <div className="research-card-title"><strong>Source markers</strong><Badge tone={toneForStatus(tech.status)}>{safeString(tech.status, 'Saknas')}</Badge></div>
            <div className="research-mini-grid">
              {Object.entries(tech.sourceMarkers || {}).slice(0, 12).map(([key, marker]) => (
                <span key={key}><b>{key}</b>{`${safeString(marker.status, '—')} · ${safeString(marker.source, 'saknas')}`}</span>
              ))}
            </div>
          </Card>
        </>
      ) : null}
    </details>
  );
}

export default function SupervisorBrainPage() {
  const { t } = useLanguage();
  const [activeSection, setActiveSection] = useState('overview');
  const historyLimit = 100;
  const data = useResearchLabData(historyLimit);
  const overview = data.overview || {};
  const blocks = overview.blocks || {};
  const autopilot = blocks.autopilot?.summary || {};
  const canonical = overview.canonicalStats || {};
  const narrow = blocks.narrow?.summary || {};
  const batchAuto = overview.batchAutopilotSummary || data.batchAuto || null;
  const replayAuto = overview.replayAutopilotSummary || data.replayAuto || null;
  const aiStatusForReadiness = overview.aiAnalystStatus || data.aiStatus || null;
  const aiOutput = data.aiLatest?.latest?.output || data.aiLatest?.output || {};
  const safety = overviewSafety(overview);
  const safetyLocked = safety.mode === 'paper_only'
    && !safety.actions_allowed
    && !safety.can_place_orders
    && !safety.live_trading_enabled
    && !safety.broker_enabled;
  const dataStatus = overview.dataStatus || {};
  const batchStatus = overview.batchStatus || {};
  const replayStatus = overview.replayStatus || {};
  const paperStatus = overview.paperStatus || {};
  const learningStatus = overview.learningStatus || {};
  const strategyRanking = getStrategyRanking(overview, data);
  const overviewRecentTests = arr(overview.recentTests);
  const aiRecommendations = (overview.aiRecommendations || getLearningSummary(overview, data).aiRecommendations || { status: 'empty', items: [] });
  const lossFeedbackQueue = overview.lossFeedbackQueue || { status: 'empty', items: [] };
  const nextRecommendedActions = arr(overview.nextRecommendedActions).length ? arr(overview.nextRecommendedActions) : getLearningSummary(overview, data).nextActions;

  const events = useMemo(() => arr(data.activity?.events), [data.activity]);
  const overviewPaperTests = useMemo(() => overviewRecentTests.map(normalizeOverviewPaperTest).filter(Boolean), [overviewRecentTests]);
  const overviewReplayTests = useMemo(() => overviewRecentTests.map(normalizeOverviewReplayTest).filter(Boolean), [overviewRecentTests]);
  const recentPaper = useMemo(
    () => (overviewPaperTests.length ? overviewPaperTests : arr(data.paperTrading?.recentPaperTrades)),
    [overviewPaperTests, data.paperTrading],
  );
  const recentReplays = useMemo(
    () => (overviewReplayTests.length ? overviewReplayTests : arr(data.replay?.recentReplays)),
    [overviewReplayTests, data.replay],
  );

  // Anchor the 14-day window to the freshest data we have, so the view never
  // looks empty just because the wall clock differs from the dataset.
  const nowRef = useMemo(() => {
    const stamps = [
      Date.now(),
      ...recentPaper.map((t) => tsValue(t.timestamp)),
      ...recentReplays.map((r) => tsValue(r.createdAt)),
      ...events.map((e) => tsValue(e.timestamp)),
    ];
    return Math.max(...stamps, 0);
  }, [recentPaper, recentReplays, events]);

  const paper14 = useMemo(() => recentPaper.filter((t) => withinDays(t.timestamp, 14, nowRef)), [recentPaper, nowRef]);
  const replays14 = useMemo(() => recentReplays.filter((r) => withinDays(r.createdAt, 14, nowRef)), [recentReplays, nowRef]);
  const replaysWithActivityFirst = useMemo(() => [...replays14].sort((a, b) => {
    const aEvents = Number(a.totalEvents || 0);
    const bEvents = Number(b.totalEvents || 0);
    if (aEvents > 0 && bEvents <= 0) return -1;
    if (bEvents > 0 && aEvents <= 0) return 1;
    return tsValue(b.createdAt) - tsValue(a.createdAt);
  }), [replays14]);
  const events14 = useMemo(() => events.filter((e) => withinDays(e.timestamp, 14, nowRef)), [events, nowRef]);

  const latestActivity = events[0] || overviewRecentTests[0] || null;
  const batchSummary = overview.batchSummary || data.batches || {};
  const paperSummary = paperStatus.summary || data.paperTrading?.summary || {};
  const latestPaper = paperStatus.latestPaperTrade?.id ? paperStatus.latestPaperTrade : (data.paperTrading?.latestPaperTrade?.id ? data.paperTrading.latestPaperTrade : null);
  const batchRuns14 = useMemo(() => batchRunsFromStatus(batchSummary, overview).filter((batch) => withinDays(first(batch.completedAt, batch.startedAt, batch.createdAt), 14, nowRef)), [batchSummary, overview, nowRef]);
  const batchView = getBatchCount(overview, data);
  const replayView = getReplayCount(overview, data);
  const paperView = getPaperTradeCount(overview, data);
  const historyView = getRecentTests(overview, data, recentPaper, recentReplays, batchRuns14);
  const dataCoverage = getDataCoverage(overview, data);
  const learningView = getLearningSummary(overview, data);
  const totalTestEvents = sumCounts(batchView.count, replayView.count, paperView.count);
  const latestKnown = latestKnownTest(overview, batchSummary, replayStatus, paperStatus);
  const hasAnyStructuredHistory = totalTestEvents !== null && totalTestEvents > 0;
  const allowlist = data.paperAllowlist?.ok ? data.paperAllowlist : (overview.paperAllowlist?.ok ? overview.paperAllowlist : null);
  const allowlistSource = data.paperAllowlist?.ok ? 'overview-fallback-endpoint' : (overview.paperAllowlist?.ok ? 'overview' : 'missing');

  // Failed/losing tests in the window, with a plain-language root-cause read.
  const losing = paper14.filter((t) => ['LOSS', 'TIMEOUT'].includes(String(t.result).toUpperCase()));
  const stopLosses = losing.filter((t) => /STOP/i.test(String(t.exitReason)));
  const timeoutLosses = paper14.filter((t) => String(t.result).toUpperCase() === 'TIMEOUT' || /TIMEOUT|TIME_EXIT|TIME_LIMIT/i.test(String(t.exitReason)));
  const lossReasonText = (() => {
    if (!losing.length) return 'Inga förluster bland de senaste låtsastesterna. Bra läge att samla mer data.';
    if (stopLosses.length >= timeoutLosses.length && stopLosses.length > 0) {
      return `Vanligaste orsaken var att stop-nivån träffades (${stopLosses.length} av ${losing.length} förluster). Det kan betyda att signalen behöver starkare bekräftelse innan den räknas som stark.`;
    }
    if (timeoutLosses.length > 0) {
      return `Vanligaste orsaken var att testet avslutades på maxtid (${timeoutLosses.length} av ${losing.length}). Rörelsen kom inte igång i tid.`;
    }
    return `Förlusterna hade blandade orsaker (${losing.length} st). Systemet fortsätter samla data.`;
  })();

  // Recommended next test — narrow learning first, then the system action plan.
  const nextOverviewAction = nextRecommendedActions[0] || null;
  const recTitle = normalizeRecommendationTitle(
    first(learningStatus?.narrowLearning?.recommendedNextTest?.title, nextOverviewAction?.title, narrow.recommendedNextTest?.title, arr(overview.actionPlan)[0]?.title_sv, 'Vänta in mer data'),
  );
  const recReason = text(
    first(learningStatus?.narrowLearning?.recommendedNextTest?.reason, nextOverviewAction?.reason, narrow.recommendedNextTest?.reason, arr(overview.actionPlan)[0]?.detail_sv),
    'Systemet samlar fortfarande testdata innan det rekommenderar ett tydligt nästa steg.',
  );

  // Plain-Swedish headline for the strongest batch outcome.
  const bestBatch = batchSummary.bestOutcome || batchSummary.latestBatch?.bestOutcome || batchStatus.latestBatch?.bestOutcome || null;
  const batchHeadline = bestBatch?.strategy
    ? `Batchtestet visade att ${simpleStrategyLabel(bestBatch.strategy)} på ${text(bestBatch.symbol, 'en symbol')} var bäst i den körningen (träff ${fmtPct(bestBatch.winRate)}).`
    : 'Ingen tydlig batchvinnare ännu — systemet behöver fler körningar.';

  const replayDegraded = String(replayStatus?.status || data.replay?.status || '').toLowerCase() === 'degraded';
  const bestStrategyNow = first(arr(strategyRanking.topStrategies)[0]?.key, learningStatus?.narrowLearning?.bestStrategy, narrow.bestStrategy, aiOutput.best_strategy);
  const weakStrategyNow = first(arr(strategyRanking.weakStrategies)[0]?.key, learningStatus?.narrowLearning?.worstStrategy, narrow.worstStrategy, aiOutput.weakest_strategy);

  return (
    <div className="research-lab-page">
      <main className="research-main">
        <header className="research-hero">
          <div>
            <div className="research-eyebrow">{t('supervisor.controlRoom', 'Kontrollrum')}</div>
            <h1>{t('supervisor.heroTitle', 'Vad händer just nu?')}</h1>
            <p>{t('supervisor.heroText', 'Systemet scannar, testar och lär sig. Inga riktiga pengar används. Här ser du de senaste 14 dagarnas testaktivitet i vanlig svenska.')}</p>
          </div>
          <div className="research-hero-status">
            <Badge tone={safetyLocked ? 'good' : 'danger'}>{safetyLocked ? t('supervisor.safeMode', 'Säkert läge') : t('supervisor.check', 'Kontrollera')}</Badge>
            <span>{t('supervisor.updated', 'Uppdaterad')} {timeText(data.lastUpdated)}</span>
            {data.refreshing ? <small>{t('supervisor.refreshing', 'Hämtar ny status...')}</small> : null}
          </div>
        </header>

        <SafetyStatusBar overview={overview} />

        {data.error ? <DegradedState>{data.error}</DegradedState> : null}
        {data.loading ? <EmptyState title={t('supervisor.loadingRoom', 'Laddar kontrollrummet')}>{t('supervisor.loadingStatus', 'Hämtar säker systemstatus...')}</EmptyState> : null}

        <div className="research-tabs" role="tablist" aria-label="Supervisor-menyer">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`research-tab${activeSection === section.id ? ' active' : ''}`}
              aria-selected={activeSection === section.id}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </div>

        {/* 1. Vad händer just nu? */}
        {activeSection === 'overview' ? (
          <>
        <section className="research-section supervisor-section supervisor-section-now">
          <SectionHeader
            eyebrow={t('supervisor.nowEyebrow', 'Just nu')}
            title={t('supervisor.systemState', 'Systemets läge')}
            subtitle={t('supervisor.systemStateSubtitle', 'En snabb bild av att allt är säkert och vad systemet senast gjorde.')}
            aside={<Badge tone="good">{t('safety.readOnly', 'Bara läsning')}</Badge>}
          />
          <div className="research-grid research-grid-3">
            <MetricCard label={t('supervisor.systemIsSafe', 'Systemet är säkert')} value={safetyLocked ? t('supervisor.yes', 'Ja') : t('supervisor.check', 'Kontrollera')} help={`${t('safety.noRealOrders', 'Inga riktiga order')}. ${t('safety.liveTradingOff', 'Ingen livehandel')}.`} tone={safetyLocked ? 'good' : 'danger'} />
            <MetricCard label={t('supervisor.mode', 'Läge')} value={t('supervisor.paperMode', 'Endast låtsasläge')} help={t('safety.noRealMoney', 'Systemet använder inga riktiga pengar')} tone="good" />
            <MetricCard label={t('supervisor.whatSystemDoes', 'Vad systemet gör')} value={autopilot.schedulerActive ? t('supervisor.scanningTesting', 'Scannar och testar') : t('supervisor.resting', 'Vilar')} help="Systemet analyserar testdata i bakgrunden." tone={autopilot.schedulerActive ? 'blue' : 'warning'} />
            <MetricCard label="Totalt testade händelser" value={totalTestEvents !== null ? fmtNumber(totalTestEvents) : '—'} help={totalTestEvents !== null ? `Summerat read-only från batch, replay och paper. Källa: ${[batchView.source, replayView.source, paperView.source].join(' / ')}.` : 'Saknas i samlad vy. Fallbackar gav ingen säker totalsiffra.'} tone={totalTestEvents !== null ? 'blue' : 'warning'} />
            <MetricCard label={t('supervisor.latestEvent', 'Senaste händelse')} value={latestActivity ? simpleEventLabel(latestActivity.title || latestActivity.type, t('insights.activity', 'Aktivitet')) : 'Saknas'} help={latestActivity ? timeText(latestActivity.timestamp) : 'Ingen aktivitet ännu'} tone={latestActivity ? 'blue' : 'warning'} />
            <MetricCard label={t('supervisor.latestTest', 'Senaste test')} value={latestKnown ? simpleEventLabel(latestKnown.type, 'Testhändelse') : '—'} help={latestKnown ? `${text(latestKnown.symbol, 'Saknas')} · ${timeText(latestKnown.timestamp)}` : (hasAnyStructuredHistory ? 'Ingen samlad recentTests-feed ännu, men batch/replay/paper-resultat finns.' : 'Inget test ännu')} tone={latestKnown?.blockedReason ? 'warning' : hasAnyStructuredHistory ? 'blue' : 'warning'} />
            <MetricCard label={t('supervisor.aiStatus', 'AI-status')} value={text(learningStatus?.status, aiReadiness(aiStatusForReadiness).label)} help="AI och learning läser och sammanfattar. De kan inte handla." tone={learningStatus?.status ? toneForStatus(learningStatus.status) : aiReadiness(aiStatusForReadiness).tone} />
          </div>
          <Card className="research-wide">
            <div className="research-card-title"><strong>{t('supervisor.nextCheck', 'Nästa rekommenderade kontroll')}</strong><Badge tone="blue">{t('supervisor.suggestion', 'Förslag')}</Badge></div>
            <p><SafeText value={recTitle} fallback={t('supervisor.waitMoreData', 'Vänta in mer data')} /></p>
            <p className="research-muted"><SafeText value={recReason} /></p>
          </Card>
          <SystemPipeline overview={overview} />
        </section>

        <section className="research-section supervisor-section supervisor-section-chain">
          <SectionHeader
            eyebrow="Systemets kedja"
            title="Data till nästa rekommendation"
            subtitle="Det här är den read-only kedja som visar om systemet har data nog för att analysera, testa och lära sig."
            aside={<Badge tone="good">Overview</Badge>}
          />
          <div className="research-grid research-grid-4">
            <MetricCard label="Data" value={dataPipelineSummary(dataStatus).summary} help={dataPipelineSummary(dataStatus).help} tone={dataPipelineSummary(dataStatus).tone} />
            <MetricCard label="Batch" value={batchPipelineSummary(batchStatus).summary} help={batchPipelineSummary(batchStatus).help} tone={batchPipelineSummary(batchStatus).tone} />
            <MetricCard label="Replay" value={replayPipelineSummary(replayStatus).summary} help={replayPipelineSummary(replayStatus).help} tone={replayPipelineSummary(replayStatus).tone} />
            <MetricCard label="Paper" value={paperPipelineSummary(paperStatus).summary} help={paperPipelineSummary(paperStatus).help} tone={paperPipelineSummary(paperStatus).tone} />
            <MetricCard label="Learning" value={learningPipelineSummary(learningStatus).summary} help={learningPipelineSummary(learningStatus).help} tone={learningPipelineSummary(learningStatus).tone} />
          </div>
        </section>
        <Card className="research-wide">
          <div className="research-card-title"><strong>Datapipeline</strong><Badge tone="blue">Read-only</Badge></div>
          <div className="research-mini-grid">
            <span><b>Data</b>{safeString(dataPipelineSummary(dataStatus).summary)}</span>
            <span><b>Batch</b>{safeString(batchPipelineSummary(batchStatus).summary)}</span>
            <span><b>Replay</b>{safeString(replayPipelineSummary(replayStatus).summary)}</span>
            <span><b>Paper</b>{safeString(paperPipelineSummary(paperStatus).summary)}</span>
            <span><b>Learning</b>{safeString(learningPipelineSummary(learningStatus).summary)}</span>
          </div>
        </Card>
          </>
        ) : null}

        {/* 2. Live händelser just nu */}
        {activeSection === 'live' ? (
        <section className="research-section supervisor-section supervisor-section-live">
          <SectionHeader
            eyebrow={t('supervisor.timeline', 'Tidslinje')}
            title={t('supervisor.liveActivityNow', 'Live händelser just nu')}
            subtitle={t('supervisor.liveActivitySubtitle', 'De senaste sakerna systemet gjorde, förklarat i vanlig svenska.')}
            aside={<Badge tone={toneForStatus(first(overview.liveActivitySummary?.status, data.activity?.status))}>{safeString(first(overview.liveActivitySummary?.status, data.activity?.status), 'Saknas')}</Badge>}
          />
          <div className="research-grid research-grid-4">
            <MetricCard label="Källa" value={overview.liveActivitySummary ? 'overview' : data.activity?.ok ? 'fallback' : '—'} help={overview.liveActivitySummary ? 'Samlad översiktssummering.' : data.activity?.ok ? 'Fallback: /api/status/live-activity' : 'Ingen live-feed hittades.'} tone={overview.liveActivitySummary ? 'good' : data.activity?.ok ? 'warning' : 'neutral'} />
            <MetricCard label="Senaste aktivitet" value={events[0] ? simpleEventLabel(events[0].title || events[0].type, 'Aktivitet') : '—'} help={events[0] ? timeText(events[0].timestamp) : 'Ingen live-feed hittades, men systemstatus kan ändå vara aktiv.'} tone={events[0] ? 'blue' : 'warning'} />
            <MetricCard label="Händelser i feeden" value={events.length ? fmtNumber(events.length) : '—'} help="Visar senaste händelser som read-only." tone={events.length ? 'blue' : 'neutral'} />
            <MetricCard label="Säkerhet" value="paper_only" help="Inga riktiga order eller brokerkopplingar används." tone="good" />
          </div>
          {events.length ? <LiveActivityFeed events={events} limit={8} /> : <EmptyState title="Ingen live-feed hittades">Ingen live-feed hittades, men systemstatus kan ändå vara aktiv.</EmptyState>}
        </section>
        ) : null}

        {activeSection === 'history' ? (
        <section className="research-section supervisor-section supervisor-section-recent-tests">
          <SectionHeader
            eyebrow="Historik"
            title="Samlad historik"
            subtitle="Recent tests från overview används först. Om de saknas byggs en read-only historik av batch, replay och paper där det går."
            aside={<Badge tone={sourceTone(historyView.source)}>{blockSourceLabel(historyView.source)}</Badge>}
          />
          {historyView.message ? <DegradedState title="Samlad historikfeed saknas">{historyView.message}</DegradedState> : null}
          {historyView.items.length
            ? <HistoryTimeline tests={historyView.items} limit={12} />
            : <EmptyState title="Ingen historik hittades ännu.">Ingen samlad historikfeed hittades ännu. Separata batch/replay/paper-resultat kan ändå finnas.</EmptyState>}
        </section>
        ) : null}

        {activeSection === 'strategies' ? (
          <>
            <StrategyRankingSection ranking={strategyRanking} />
            <StrategyAutomationStatus matrix={data.runtimeMatrix} />
          </>
        ) : null}

        {/* 3. Paper trades senaste 14 dagar */}
        {activeSection === 'paper' ? (
        <section className="research-section supervisor-section supervisor-section-paper">
          <SectionHeader
            eyebrow={t('supervisor.last14Days', 'Senaste 14 dagarna')}
            title={t('supervisor.paperTests14', 'Låtsastester senaste 14 dagar')}
            subtitle={t('supervisor.paperTestsSubtitle', 'Simulerade tester. Klicka på en rad för mer detaljer. Inga riktiga pengar används.')}
            aside={<Badge tone={sourceTone(paperView.source)}>{blockSourceLabel(paperView.source)}</Badge>}
          />
          <div className="research-grid research-grid-4">
            <MetricCard label="Tester totalt" value={paperView.count !== null ? fmtNumber(paperView.count) : '—'} help={paperView.count !== null ? `Källa: ${paperView.source}` : 'Saknas i samlad vy'} tone={paperView.count !== null ? 'blue' : 'warning'} />
            <MetricCard label="Andel lyckade" value={fmtPct(paperSummary.winRate)} help="Hur ofta testerna gick plus." tone="good" />
            <MetricCard label="Snittresultat" value={paperSummary.avgPnl != null ? fmtSignedPct(paperSummary.avgPnl) : '—'} help="Genomsnitt per test. Testdata, ingen bevisad vinst." tone="blue" />
            <MetricCard label="Starkast strategi" value={simpleStrategyLabel(paperSummary.bestStrategy?.strategy, 'Samla mer data')} help={paperSummary.bestStrategy?.winRate != null ? `Träff ${fmtPct(paperSummary.bestStrategy.winRate)}` : 'För lite data ännu'} tone="purple" />
          </div>
          <Card className="research-wide">
            <div className="research-card-title"><strong>Paper Allowlist</strong><Badge tone={allowlist ? 'good' : 'warning'}>{allowlist ? blockSourceLabel(allowlistSource) : 'saknas'}</Badge></div>
            <div className="research-mini-grid">
              <span><b>Läser approved-lista</b>{allowlist ? 'Ja' : 'Allowlist-status saknas i denna vy'}</span>
              <span><b>Approved som paper runtime får testa</b>{allowlist ? `${fmtNumber(allowlist.readyForPaperRuntime || 0)} / ${fmtNumber(allowlist.totalApproved || 0)}` : '—'}</span>
              <span><b>Kommentar</b>{allowlist ? (allowlist.totalApproved > 0 ? 'Approved-strategier finns.' : 'Approved-listan är tom just nu.') : 'Saknas i samlad vy'}</span>
            </div>
            <p className="research-muted">Låtsashandel använder inga riktiga pengar.</p>
          </Card>
          <PaperTradeList trades={paper14} limit={14} />
          <div className="research-readiness">
            <Link className="research-link-button" to="/insikter?tab=paper">Se alla låtsastester i Insikter</Link>
          </div>
        </section>
        ) : null}

        {/* 4. Batchtester senaste 14 dagar */}
        {activeSection === 'batches' ? (
        <section className="research-section supervisor-section supervisor-section-batch">
          <SectionHeader
            eyebrow={t('supervisor.last14Days', 'Senaste 14 dagarna')}
            title={t('supervisor.batchTests', 'Batchtester')}
            subtitle={t('supervisor.batchSubtitle', 'Stora testanalyser som jämför många strategier mot varandra.')}
            aside={<Badge tone={sourceTone(batchView.source)}>{blockSourceLabel(batchView.source)}</Badge>}
          />
          {batchView.source === 'fallback' ? <DegradedState title="Källa: batch-status fallback">Overview saknade batchdata i denna vy, så sidan använder batch-status fallback där det går.</DegradedState> : null}
          <Card className="research-wide">
            <div className="research-card-title"><strong>Vad batchen visade</strong><Badge tone="good">Sammanfattning</Badge></div>
            <p>{batchHeadline}</p>
            <p className="research-muted">Batch planeras ungefär var sjätte timme i säkert testläge. En full 14-dagarslista kräver en separat read-only sammanfattning senare.</p>
          </Card>
          <div className="research-grid research-grid-4">
            <MetricCard label="Batch count" value={batchView.count !== null ? fmtNumber(batchView.count) : '—'} help={batchView.count !== null ? `Källa: ${batchView.source}` : 'Saknas i samlad vy'} tone={batchView.count !== null ? 'blue' : 'warning'} />
            <MetricCard label="Senaste batch" value={batchView.latest?.id || batchView.latest?.batchId || '—'} help={batchView.latest ? timeText(first(batchView.latest.completedAt, batchView.latest.startedAt, batchView.latest.createdAt)) : 'Ingen batchdetalj hittades'} tone={batchView.latest ? 'blue' : 'warning'} />
            <MetricCard label="Bästa batch" value={simpleStrategyLabel(batchView.best?.strategy, '—')} help={batchView.best?.symbol ? `Bäst på ${batchView.best.symbol}` : 'Bästa utfall saknas'} tone="good" />
            <MetricCard label="Svagaste batch" value={simpleStrategyLabel(batchView.worst?.strategy, '—')} help={batchView.worst?.symbol ? `Svagast på ${batchView.worst.symbol}` : 'Svagaste utfall saknas'} tone="warning" />
          </div>
          <BatchRunList runs={batchRuns14} fallbackBest={bestBatch} />
          <BatchStatusCard batches={batchSummary} autopilot={batchAuto} />
          <div className="research-readiness">
            <Link className="research-link-button" to="/insikter?tab=batch">Se alla batchtester i Insikter</Link>
          </div>
        </section>
        ) : null}

        {/* 5. Replaytester senaste 14 dagar */}
        {activeSection === 'replay' ? (
        <section className="research-section supervisor-section supervisor-section-replay">
          <SectionHeader
            eyebrow={t('supervisor.last14Days', 'Senaste 14 dagarna')}
            title={t('supervisor.replayTests', 'Replaytester')}
            subtitle={t('supervisor.replaySubtitle', 'Systemet spelar upp gammal marknad igen för att se vad som hade hänt.')}
            aside={<Badge tone={sourceTone(replayView.source)}>{blockSourceLabel(replayView.source)}</Badge>}
          />
          {replayDegraded ? (
            <DegradedState title="Replay fungerade delvis">
              Vissa replaykörningar kunde inte läsas, men det finns replay med aktivitet. Systemet fortsätter ändå att fungera.
            </DegradedState>
          ) : null}
          <div className="research-grid research-grid-4">
            <MetricCard label="Replay count" value={replayView.count !== null ? fmtNumber(replayView.count) : '—'} help={replayView.count !== null ? `Källa: ${replayView.source}` : 'Saknas i samlad vy'} tone={replayView.count !== null ? 'blue' : 'warning'} />
            <MetricCard label="Senaste replay" value={replayView.latest?.runId || '—'} help={replayView.latest ? timeText(replayView.latest.createdAt) : 'Ingen replaydetalj hittades'} tone={replayView.latest ? 'blue' : 'warning'} />
            <MetricCard label="Bästa symbol" value={safeString(replayView.latest?.bestSymbol?.symbol, '—')} help={replayView.latest?.bestSymbol?.avgScore != null ? `Score ${fmtNumber(replayView.latest.bestSymbol.avgScore)}` : 'Saknas i denna vy'} tone="blue" />
            <MetricCard label="Status" value={safeString(replayView.status, '—')} help={replayView.source === 'fallback' ? 'Fallback används eftersom overview saknar replayblock.' : 'Read-only status'} tone={toneForStatus(replayView.status)} />
          </div>
          <Card className="research-wide">
            <div className="research-card-title"><strong>Replay med aktivitet</strong><Badge tone="blue">Prioriterad</Badge></div>
            <p>{replaysWithActivityFirst[0]?.totalEvents > 0
              ? `Den tydligaste replayen hittade ${fmtNumber(replaysWithActivityFirst[0].totalEvents)} testhändelser och ${fmtNumber(replaysWithActivityFirst[0].totalCandles)} candles.`
              : 'Senaste replay hittade inga tydliga testhändelser. Systemet behöver fler replaykörningar med aktivitet.'}</p>
          </Card>
          <ReplayList replays={replaysWithActivityFirst} limit={10} />
          <div className="research-readiness">
            <Link className="research-link-button" to="/insikter?tab=replay">Se alla replaytester i Insikter</Link>
          </div>
        </section>
        ) : null}

        {activeSection === 'data' ? (
        <section className="research-section supervisor-section supervisor-section-chain">
          <SectionHeader
            eyebrow="Datahämtning"
            title="Datahämtning och täckning"
            subtitle="Overview används först. Om den saknas visas bara säkra fallbacksignaler och tydligt vad som inte finns."
            aside={<Badge tone={sourceTone(dataCoverage.source)}>{blockSourceLabel(dataCoverage.source)}</Badge>}
          />
          <div className="research-grid research-grid-4">
            <MetricCard label="Data status" value={safeString(dataCoverage.status, '—')} help={dataCoverage.note || 'Read-only datastatus'} tone={toneForStatus(dataCoverage.status)} />
            <MetricCard label="Symboler totalt" value={dataCoverage.totalSymbols !== null ? fmtNumber(dataCoverage.totalSymbols) : '—'} help="Totalt antal symboler i den tillgängliga vyn." tone={dataCoverage.totalSymbols !== null ? 'blue' : 'neutral'} />
            <MetricCard label="Redo för tester" value={dataCoverage.ready !== null ? fmtNumber(dataCoverage.ready) : '—'} help="Redo för batch/replay i samlad vy." tone={dataCoverage.ready !== null ? 'good' : 'neutral'} />
            <MetricCard label="Saknar data" value={dataCoverage.missing !== null ? fmtNumber(dataCoverage.missing) : '—'} help="Visas bara när overview exponerar det." tone={dataCoverage.missing !== null ? 'warning' : 'neutral'} />
          </div>
          <Card className="research-wide">
            <div className="research-card-title"><strong>Provider och timeframes</strong><Badge tone="blue">Read-only</Badge></div>
            <div className="research-mini-grid">
              <span><b>Provider status</b>{dataCoverage.providerStatus ? 'Finns i denna vy' : 'Saknas i samlad vy'}</span>
              <span><b>Timeframes</b>{safeString(dataCoverage.timeframes, 'Saknas i samlad vy')}</span>
              <span><b>Alpaca/Binance</b>{dataCoverage.providerStatus ? 'Visas i tekniska detaljer när tillgängligt' : 'Saknas i denna vy'}</span>
              <span><b>Kommentar</b>{safeString(dataCoverage.note, 'Overview exponerar inte dataStatus i denna miljö.')}</span>
            </div>
          </Card>
        </section>
        ) : null}

        {/* 6. Vad har systemet lärt sig? */}
        {activeSection === 'ai' ? (
          <>
        <OverviewAiSection
          aiRecommendations={aiRecommendations}
          lossFeedbackQueue={lossFeedbackQueue}
          nextRecommendedActions={nextRecommendedActions}
          learningStatus={learningStatus}
        />
        <section className="research-section supervisor-section supervisor-section-ai">
          <SectionHeader
            eyebrow="Lärdomar"
            title={t('supervisor.learned', 'Vad har systemet lärt sig?')}
            subtitle={t('supervisor.learnedSubtitle', 'En enkel sammanfattning av vad testerna säger hittills.')}
            aside={<Badge tone="purple">{t('supervisor.analysis', 'Analys')}</Badge>}
          />
          <div className="research-grid research-grid-3">
            <MetricCard label="Bästa strategi just nu" value={simpleStrategyLabel(bestStrategyNow, 'Samla mer data')} help="Ser bäst ut i testerna hittills." tone="good" />
            <MetricCard label="Mest riskabel signal" value={simpleStrategyLabel(weakStrategyNow, 'Samla mer data')} help="Presterar svagast just nu." tone="warning" />
            <MetricCard label="Avgörs ofta av maxtid" value={canonical.timeoutRate != null ? fmtPct(canonical.timeoutRate) : '—'} help="Hög andel betyder att rörelsen ofta inte hann komma igång." tone={Number(canonical.timeoutRate) >= 20 ? 'warning' : 'blue'} />
          </div>
          <Card className="research-wide">
            <div className="research-card-title"><strong>Kort sammanfattning</strong><Badge tone="purple">Learning</Badge></div>
            <p>{lossReasonText}</p>
            <p className="research-muted">Allt detta bygger på testdata, inte bevisad handelsvinst. Systemet använder lärdomarna för att föreslå nästa säkra test.</p>
          </Card>
          <AiAnalystSummary
            status={aiStatusForReadiness}
            latest={data.aiLatest}
            learningStatus={learningStatus}
            nextRecommendedActions={nextRecommendedActions}
            ranking={strategyRanking}
          />
        </section>
          </>
        ) : null}

        {/* 7. Misslyckade tester — vad lärde vi oss? */}
        {activeSection === 'risks' ? (
        <section className="research-section supervisor-section supervisor-section-failures">
          <SectionHeader
            eyebrow="Risker"
            title="Risker och blockerare"
            subtitle="Visar degraded-lägen, få tester, saknade block och andra read-only riskindikatorer."
            aside={<Badge tone={losing.length ? 'warning' : 'good'}>{fmtNumber(losing.length)} förluster</Badge>}
          />
          <div className="research-grid research-grid-3">
            <MetricCard label="Förluster (14 dagar)" value={fmtNumber(losing.length)} help="Antal låtsastester som gick minus." tone={losing.length ? 'warning' : 'good'} />
            <MetricCard label="Stop-nivå träffades" value={fmtNumber(stopLosses.length)} help="Priset vände ner till skyddsnivån." tone="warning" />
            <MetricCard label="Avslutades på maxtid" value={fmtNumber(timeoutLosses.length)} help="Rörelsen kom inte igång i tid." tone="warning" />
          </div>
          <Card className="research-wide">
            <div className="research-card-title"><strong>Vad förlusterna säger</strong><Badge tone="warning">Lärdom</Badge></div>
            <p>{lossReasonText}</p>
            <p className="research-muted">Flera tester som avslutas på stop-nivå kan betyda att entry-regeln behöver starkare bekräftelse innan en signal räknas som stark.</p>
          </Card>
          <Card className="research-wide">
            <div className="research-card-title"><strong>Read-only risker</strong><Badge tone="warning">Översikt</Badge></div>
            <div className="research-mini-grid">
              <span><b>Replay degraded</b>{replayDegraded ? 'Ja' : 'Nej / okänt'}</span>
              <span><b>Learning degraded</b>{learningView.source === 'missing' ? 'Ja' : 'Nej / fallback'}</span>
              <span><b>Få tester</b>{totalTestEvents !== null && totalTestEvents < 5 ? 'Ja' : totalTestEvents === null ? 'Okänt' : 'Nej'}</span>
              <span><b>Allowlist tom</b>{allowlist ? (allowlist.totalApproved > 0 ? 'Nej' : 'Ja') : 'Okänt'}</span>
              <span><b>Automation off</b>{deriveAutomationMode(data).key === 'off' ? 'Ja' : 'Nej'}</span>
            </div>
          </Card>
          <RiskBlockerCard risks={overview.risks} riskSummary={overview.riskSummary} dataJobs={data.dataJobs} batches={batchSummary} activity={data.activity} dataStatus={dataStatus} />
        </section>
        ) : null}

        {/* 8. Gå vidare */}
        {activeSection === 'technical' ? (
          <>
        <AutomationModePanel data={data} />
        <AutomationPlanPanel plan={data.automationPlan} />
        <ManualApprovalPanel plan={data.automationPlan} />
        <section className="research-section supervisor-section supervisor-section-nav">
          <SectionHeader
            eyebrow="Tekniskt"
            title="Tekniska källor och status"
            subtitle="Debug och källa per block. Inga farliga knappar visas här."
          />
          <div className="research-grid research-grid-4">
            <Card><strong>Overview-block</strong><span>{Object.keys(overview).length ? Object.keys(overview).join(', ') : 'saknas'}</span></Card>
            <Card><strong>Batch-källa</strong><span>{blockSourceLabel(batchView.source)}</span></Card>
            <Card><strong>Replay-källa</strong><span>{blockSourceLabel(replayView.source)}</span></Card>
            <Card><strong>Paper-källa</strong><span>{blockSourceLabel(paperView.source)}</span></Card>
          </div>
        </section>

        <TechnicalDetailsPanel data={data} technical={overview.technical} />
          </>
        ) : null}
      </main>
    </div>
  );
}
