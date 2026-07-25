import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ActivityList,
  BarChart,
  ChartCard,
  DashboardShell,
} from '../components/dashboard/DashboardKit.jsx';
import {
  createDecisionStore,
  createTradingEventStore,
  SupervisorIntelligence,
} from '../components/trading/index.js';
import {
  createStrategyStore,
  resolveKnownStrategy,
  strategyDisplayName,
} from '../stores/strategyStore.js';

const REFRESH_MS = 30_000;

const SECTIONS = [
  { id: 'oversikt', label: 'Översikt' },
  { id: 'safety', label: 'Safety' },
  { id: 'autopilot', label: 'Autopilot' },
  { id: 'tester', label: 'Tester' },
  { id: 'strategies', label: 'Strategier' },
  { id: 'learning', label: 'Learning' },
  { id: 'risks', label: 'Risker' },
  { id: 'teknik', label: 'Teknik' },
];

const SECTION_GROUP = {
  controlroom: 'oversikt',
  brain: 'autopilot',
  live: 'teknik',
  data: 'teknik',
  replay: 'tester',
  batch: 'tester',
  strategies: 'strategies',
  research: 'strategies',
  learning: 'learning',
  ai: 'risks',
  paper: 'safety',
  tech: 'teknik',
};

function sectionGroup(sectionId) {
  return SECTION_GROUP[sectionId] || sectionId;
}

function apiJson(url, options = {}) {
  return fetch(url, { credentials: 'same-origin', ...options }).then(async (res) => {
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

function arr(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function text(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nej';
  if (Array.isArray(value)) return value.map((item) => text(item, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') return text(value.title_sv || value.title || value.message_sv || value.message || value.reason || value.name || value.id, fallback);
  return fallback;
}

function supervisorStrategyModel(row = {}) {
  return resolveKnownStrategy(row);
}

function supervisorStrategyLabel(row = {}, fallback = 'Strategi') {
  return strategyDisplayName(supervisorStrategyModel(row), fallback);
}

function number(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtNumber(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('sv-SE').format(n) : fallback;
}

function fmtPct(value, digits = 1) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

function fmtSigned(value, digits = 3) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function countLabel(value, suffix = '') {
  const n = number(value, null);
  if (n === null) return '—';
  return suffix ? `${fmtNumber(n)} ${suffix}` : fmtNumber(n);
}

function boolString(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return '—';
}

function timeText(value) {
  if (!value) return 'Saknas';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saknas';
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function strategyEvidenceText(row, hasHistoricalCoverage) {
  const tests = number(first(row?.testCount, row?.trades, row?.sampleSize), null);
  if (tests && tests > 0) return `Testunderlag ${fmtNumber(tests)}`;
  if (row?.needsMoreData === true && hasHistoricalCoverage) return 'Historik finns – fler tester behövs';
  if (hasHistoricalCoverage) return 'Historik finns – fler tester behövs';
  return 'Testunderlag saknas';
}

function statusTone(status) {
  const key = String(status || '').toLowerCase();
  if (['ok', 'ready', 'safe', 'completed'].includes(key)) return 'good';
  if (['idle', 'running', 'active', 'info'].includes(key)) return 'blue';
  if (['empty', 'warning', 'cooldown', 'waiting', 'paused'].includes(key)) return 'warning';
  if (['degraded', 'missing'].includes(key)) return 'warning';
  if (['error', 'failed', 'blocked'].includes(key)) return 'danger';
  return 'neutral';
}

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  return {
    ok: 'OK',
    ready: 'Redo',
    active: 'Aktiv',
    running: 'Kör',
    idle: 'Väntar',
    empty: 'Tomt ännu',
    degraded: 'Delvis',
    warning: 'Varning',
    blocked: 'Blockerad',
    failed: 'Misslyckad',
    error: 'Fel',
    missing: 'Saknas',
    paused: 'Pausad',
  }[key] || text(status, '—');
}

function overviewSafety(overview = {}) {
  const safety = overview?.safety || {};
  return {
    mode: first(safety.mode, overview.mode),
    actions_allowed: first(safety.actions_allowed, overview.actions_allowed),
    can_place_orders: first(safety.can_place_orders, overview.can_place_orders),
    live_trading_enabled: first(safety.live_trading_enabled, overview.live_trading_enabled),
    broker_enabled: first(safety.broker_enabled, overview.broker_enabled),
  };
}

function safetyLocked(overview) {
  const safety = overviewSafety(overview);
  return safety.mode === 'paper_only'
    && safety.actions_allowed === false
    && safety.can_place_orders === false
    && safety.live_trading_enabled === false
    && safety.broker_enabled === false;
}

function useTradingOsData() {
  const [state, setState] = useState({
    overview: null,
    liveActivity: null,
    replay: null,
    batches: null,
    dataSymbols: null,
    allowlist: null,
    automationPlan: null,
    aiLatest: null,
    loading: true,
    refreshing: false,
    error: '',
    updatedAt: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!cancelled) {
        setState((prev) => ({
          ...prev,
          loading: !prev.updatedAt,
          refreshing: Boolean(prev.updatedAt),
          error: '',
        }));
      }

      const [
        overview,
        liveActivity,
        replay,
        batches,
        dataSymbols,
        allowlist,
        automationPlan,
        aiLatest,
      ] = await Promise.all([
        apiJson('/api/supervisor/overview').catch(() => null),
        apiJson('/api/status/live-activity').catch(() => null),
        apiJson('/api/status/replay').catch(() => null),
        apiJson('/api/status/batches').catch(() => null),
        apiJson('/api/data-center/symbols').catch(() => null),
        apiJson('/api/automation/paper-allowlist/status').catch(() => null),
        apiJson('/api/automation/plan').catch(() => null),
        apiJson('/api/ai/analyst/latest').catch(() => null),
      ]);

      if (cancelled) return;

      setState({
        overview,
        liveActivity,
        replay,
        batches,
        dataSymbols,
        allowlist,
        automationPlan,
        aiLatest,
        loading: false,
        refreshing: false,
        error: overview ? '' : 'Kunde inte läsa Trading OS-översikten. Vyn visar bara det som gick att hämta.',
        updatedAt: new Date().toISOString(),
      });
    }

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return state;
}

function Badge({ tone = 'neutral', children }) {
  return <span className={`tos-badge tos-badge-${tone}`}>{children}</span>;
}

function SectionCard({ title, tone = 'neutral', children, aside = null }) {
  return (
    <article className={`tos-card tos-card-${tone}`}>
      <div className="tos-card-head">
        <strong>{title}</strong>
        {aside}
      </div>
      {children}
    </article>
  );
}

function Metric({ label, value, help, tone = 'neutral' }) {
  return (
    <div className={`tos-metric tos-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {help ? <small>{help}</small> : null}
    </div>
  );
}

function ListBlock({ title, items, emptyText = 'Inget att visa ännu.', renderItem }) {
  return (
    <SectionCard title={title}>
      {items.length ? (
        <div className="tos-list">
          {items.map((item, index) => (
            <div key={`${text(item.id || item.symbol || item.name || item.title, 'row')}-${index}`} className="tos-list-row">
              {renderItem(item)}
            </div>
          ))}
        </div>
      ) : (
        <p className="tos-empty">{emptyText}</p>
      )}
    </SectionCard>
  );
}

function MeaningBlock({ meaning, missing, nextStep }) {
  return (
    <div className="tos-explainer-grid">
      <div>
        <h4>Vad betyder detta?</h4>
        <p>{meaning}</p>
      </div>
      <div>
        <h4>Vad saknas?</h4>
        <p>{missing}</p>
      </div>
      <div>
        <h4>Nästa steg</h4>
        <p>{nextStep}</p>
      </div>
    </div>
  );
}

function PipelineStage({ stage, active, onSelect }) {
  return (
    <button
      type="button"
      className={`tos-stage tos-stage-${stage.tone}${active ? ' is-active' : ''}`}
      onClick={() => onSelect(stage.sectionId)}
    >
      <span className="tos-stage-name">{stage.name}</span>
      <strong>{stage.status}</strong>
      <small>{stage.count}</small>
      <p>{stage.meaning}</p>
    </button>
  );
}

function ResearchAutomationCard({ overview, automationPlan, nextRecommendedActions }) {
  const batchAuto = overview?.batchAutopilotSummary || null;
  const replayAuto = overview?.replayAutopilotSummary || null;
  const enabled = Boolean(batchAuto?.enabled || replayAuto?.enabled);
  const anyDryRun = batchAuto?.dryRunOnly === true || replayAuto?.dryRunOnly === true;
  const mode = enabled ? (anyDryRun ? 'dry_run' : 'paper_only_research') : 'disabled';
  const tone = mode === 'disabled' ? 'warning' : 'good';
  const lastRun = first(replayAuto?.lastRun, batchAuto?.lastRun);
  const nextRun = first(replayAuto?.nextRun, batchAuto?.nextRun);
  const blockedReasons = arr([replayAuto?.lastBlockedReason, batchAuto?.lastBlockedReason]).filter(Boolean);
  const planText = text(
    first(
      replayAuto?.lastReplayPlan?.recommendation,
      batchAuto?.lastPlan?.recommendation,
      automationPlan?.nextSafeStep,
      arr(nextRecommendedActions)[0]?.reason,
    ),
    'Ingen plan sparad ännu.',
  );

  return (
    <SectionCard
      title="Research automation"
      tone={tone}
      aside={<Badge tone={tone}>{mode}</Badge>}
    >
      <div className="tos-metrics-grid">
        <Metric label="Läge" value={mode} help="Standard ska vara disabled eller dry_run." tone={tone} />
        <Metric label="Senaste automation" value={timeText(lastRun)} help="Endast test- och researchplanering." tone="blue" />
        <Metric label="Nästa planerade test" value={timeText(nextRun)} help="Planeras utan broker och utan riktiga order." tone="blue" />
        <Metric label="Blockerat av" value={blockedReasons.length ? blockedReasons.join(', ') : 'Inget just nu'} help="Visar varför något inte kördes." tone={blockedReasons.length ? 'warning' : 'good'} />
      </div>
      <MeaningBlock
        meaning="Automationen ska bara kontrollera data, föreslå replay/batch, skicka resultat vidare till learning och uppdatera AI. Den får aldrig lägga order."
        missing={blockedReasons.length ? `Nuvarande hinder: ${blockedReasons.join(', ')}.` : 'Det som saknas just nu är oftast mer data eller manuell granskning innan nästa paper-only test.'}
        nextStep={planText}
      />
      <div className="tos-safety-line">
        <Badge tone="good">paper_only</Badge>
        <Badge tone="good">broker avstängd</Badge>
        <Badge tone="good">inga riktiga order</Badge>
        <Badge tone="good">ingen livehandel</Badge>
      </div>
    </SectionCard>
  );
}

function DryRunTestCard() {
  // Test-only triggers. These POST to dry-run endpoints that never execute,
  // never place orders and never touch broker/live trading.
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);

  function runDryRun(kind) {
    if (busy) return;
    const url = kind === 'batch' ? '/api/batch-autopilot/dry-run' : '/api/replay-autopilot/dry-run';
    setBusy(kind);
    setResult(null);
    apiJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((data) => setResult({ kind, data }))
      .catch((err) => setResult({ kind, data: { ok: false, error: err.message } }))
      .finally(() => setBusy(''));
  }

  const data = result?.data || null;
  return (
    <SectionCard
      title="Testkörning (dry-run)"
      tone="blue"
      aside={<Badge tone="blue">Endast test</Badge>}
    >
      <p className="tos-muted">
        Knapparna kör <strong>endast en dry-run-plan</strong> (förhandsvisning). Ingen batch eller replay
        startas på riktigt. Inga riktiga order, ingen broker, ingen livehandel.
      </p>
      <div className="tos-safety-line">
        <button type="button" className="research-soft-button" disabled={Boolean(busy)} onClick={() => runDryRun('batch')}>
          {busy === 'batch' ? 'Kör test…' : 'Kör test-batch (dry-run)'}
        </button>
        <button type="button" className="research-soft-button" disabled={Boolean(busy)} onClick={() => runDryRun('replay')}>
          {busy === 'replay' ? 'Kör test…' : 'Kör test-replay (dry-run)'}
        </button>
      </div>
      {data ? (
        <div className="tos-list">
          <div className="tos-list-row">
            <strong>{result.kind === 'batch' ? 'Batch' : 'Replay'} dry-run</strong>
            <span>
              {data.blocked
                ? `Blockerad: ${text(first(data.blockedReason, arr(data.reasons)[0]), 'okänd orsak')}`
                : data.ok
                  ? text(data.note, 'Dry-run-plan skapad. Inget kördes på riktigt.')
                  : `Fel: ${text(data.error, 'okänt fel')}`}
            </span>
            <span>executed: {String(data.executed === true)} · mode: {text(data.mode, 'paper_only')}</span>
          </div>
        </div>
      ) : null}
      <div className="tos-safety-line">
        <Badge tone="good">paper_only</Badge>
        <Badge tone="good">broker avstängd</Badge>
        <Badge tone="good">inga riktiga order</Badge>
        <Badge tone="good">ingen livehandel</Badge>
      </div>
    </SectionCard>
  );
}

export default function SupervisorBrainPage() {
  const [activeSection, setActiveSection] = useState('oversikt');
  const data = useTradingOsData();

  const overview = data.overview || {};
  const liveActivity = data.liveActivity?.ok ? data.liveActivity : null;
  const replay = data.replay || {};
  const batches = data.batches || {};
  const symbols = arr(data.dataSymbols?.symbols);
  const dataStatus = overview.dataStatus || {};
  const liveActivitySummary = overview.liveActivitySummary || liveActivity || {};
  const replayStatus = overview.replayStatus || replay;
  const batchStatus = overview.batchStatus || batches;
  const strategyRanking = overview.strategyRanking || {};
  const learningStatus = overview.learningStatus || {};
  const aiStatus = overview.aiAnalystStatus || {};
  const paperStatus = overview.paperStatus || {};
  const strategyResearch = overview.strategyResearch || {};
  const marketRegime = overview.marketRegime || {};
  const paperSummary = overview.paperSummary || {};
  const hasResearchRecommendations = Array.isArray(strategyResearch.recommendations);
  const researchRecommendations = arr(strategyResearch.recommendations);
  const paperEligibleRecommendations = researchRecommendations.filter((row) => row && row.paperEligible);
  const approvalRecommendations = researchRecommendations.filter((row) => row && row.requiresUserApproval);
  const hasOverviewRisks = Array.isArray(overview.risks);
  const overviewRisks = arr(overview.risks);
  const technical = overview.technical || {};
  const allowlist = data.allowlist?.ok ? data.allowlist : null;
  const automationPlan = data.automationPlan?.ok ? data.automationPlan : null;
  const aiLatest = data.aiLatest?.ok ? data.aiLatest : null;
  const supervisorStrategyStore = useMemo(() => createStrategyStore({
    runtimeSnapshot: overview,
    strategyOverview: overview.strategyOverview || [],
    strategyStatus: overview.strategyStatus || [],
    strategyPulse: overview.strategyPulse || [],
    strategies: [
      ...arr(allowlist?.allowlist),
      ...arr(strategyResearch.recommendations),
      strategyRanking.bestJustNow,
      strategyRanking.weakestJustNow,
    ].filter(Boolean),
  }), [allowlist, overview, strategyRanking.bestJustNow, strategyRanking.weakestJustNow, strategyResearch.recommendations]);
  const tradingEventStore = useMemo(() => createTradingEventStore({
    supervisorSnapshot: overview,
    liveActivity,
    replaySnapshot: replay,
    batchSnapshot: batches,
    automationPlan,
    aiLatest,
    strategyStore: supervisorStrategyStore,
  }), [aiLatest, automationPlan, batches, liveActivity, overview, replay, supervisorStrategyStore]);
  const decisionStore = useMemo(() => createDecisionStore({
    eventStore: tradingEventStore,
    supervisorSnapshot: overview,
    liveActivity,
    replaySnapshot: replay,
    batchSnapshot: batches,
    automationPlan,
    aiLatest,
  }), [aiLatest, automationPlan, batches, liveActivity, overview, replay, tradingEventStore]);
  const safetyIsLocked = safetyLocked(overview);

  const readySymbolNames = arr(dataStatus.readyForReplaySymbols);
  const readySymbolsDetailed = useMemo(() => {
    const readySet = new Set(readySymbolNames);
    return symbols.filter((row) => readySet.has(row.symbol)).sort((a, b) => number(b.total_candle_count, 0) - number(a.total_candle_count, 0));
  }, [symbols, readySymbolNames]);

  const missingSymbols = arr(dataStatus.missingSymbols);
  const totalCandles = useMemo(() => {
    const values = readySymbolsDetailed
      .map((row) => number(row.total_candle_count, null))
      .filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }, [readySymbolsDetailed]);
  const maxHistoryDays = useMemo(() => {
    const values = readySymbolsDetailed
      .map((row) => number(row.candles_2m_days, null))
      .filter((value) => value !== null);
    return values.length ? Math.max(...values) : null;
  }, [readySymbolsDetailed]);

  const liveEvents = arr(liveActivitySummary.latestEvents).length
    ? arr(liveActivitySummary.latestEvents)
    : arr(liveActivity?.events).slice(0, 5);
  const liveCount = number(first(liveActivitySummary.count, liveActivity?.count), null);
  const liveLatestEvent = liveEvents[0] || null;
  const liveSourceBreakdown = arr(liveActivitySummary.sourceBreakdown);
  const liveStatus = liveActivitySummary.status || liveActivity?.status || null;

  const recentReplays = arr(replay.recentReplays);
  const latestReplay = replayStatus.latestReplay || replay.latestReplay || overview.replaySummary?.latestReplay || null;
  const bestReplaySymbol = latestReplay?.bestSymbol || recentReplays[0]?.bestSymbol || null;
  const totalReplayRuns = number(first(replayStatus.totalReplayRuns, overview.replaySummary?.totalReplayTests), null);
  const replayEventsTotal = number(first(replayStatus.summary?.totalEvents, overview.replaySummary?.summary?.totalEvents), null);
  const replaySymbolCount = number(first(
    latestReplay?.symbolCount,
    Array.isArray(latestReplay?.symbols) ? latestReplay.symbols.length : null,
    Array.isArray(replayStatus.symbols) ? replayStatus.symbols.length : null,
  ), null);
  const replayTimeframe = text(first(latestReplay?.timeframe, arr(replayStatus.timeframes)[0]), 'Saknas');

  const latestBatch = batchStatus.latestBatch || batches.latestBatch || overview.batchSummary?.latestBatch || null;
  const bestBatch = batchStatus.bestOutcome || batches.bestOutcome || overview.batchSummary?.bestOutcome || null;
  const worstBatch = batchStatus.worstOutcome || batches.worstOutcome || overview.batchSummary?.worstOutcome || null;
  const batchCombinations = number(first(latestBatch?.totalCombinations, latestBatch?.combinationsTested), null);
  const batchResultRows = number(first(overview.batchSummary?.batchResultRows, batchStatus.batchResultRows), null);

  const topStrategies = arr(strategyRanking.topStrategies).slice(0, 4);
  const weakStrategies = arr(strategyRanking.weakStrategies).slice(0, 4);
  const needsMoreData = arr(strategyRanking.strategiesNeedingMoreData).slice(0, 6);
  const bestJustNow = strategyRanking.bestJustNow || topStrategies[0] || null;
  const weakestJustNow = strategyRanking.weakestJustNow || weakStrategies[0] || null;
  const strategyTests = number(strategyRanking.strategyTests, null);
  const uniqueStrategies = number(strategyRanking.uniqueStrategies, null);
  const strategyBatchRows = number(strategyRanking.batchResultRows, null);
  const historicalCoverageSource = text(strategyRanking.historicalCoverageSource, 'Saknas');
  const hasHistoricalStrategyCoverage = [strategyTests, uniqueStrategies, strategyBatchRows].some((value) => value !== null && value > 0);

  const learningRecommendations = arr(learningStatus.learningRecommendations);
  const nextRecommendedActions = arr(overview.nextRecommendedActions);
  const actionPlan = arr(overview.actionPlan);
  const approvedStrategies = arr(allowlist?.allowlist);
  const paperAllowlist = paperStatus.allowlist || {};
  const learningOutcomeCount = number(first(
    learningStatus.narrowLearning?.totalNarrowTrades,
    learningStatus.signalLearningSummary?.totalOutcomes,
    learningStatus.connectorSummary?.connectorSummary?.totalEvents,
  ), null);
  const learningReplayCount = number(learningStatus.connectorSummary?.connectorSummary?.bySource?.replay, null);
  const learningBatchCount = number(learningStatus.connectorSummary?.connectorSummary?.bySource?.batch, null);
  const paperTradeCount = number(paperStatus.count, null);
  const latestAiOutput = first(
    aiStatus.latestOutputSummary,
    aiLatest?.latest?.summary,
    aiLatest?.summary,
    aiLatest?.latest?.output?.summary,
    aiLatest?.output?.summary,
    aiLatest?.latest?.output?.text,
    aiLatest?.output?.text,
  );
  const latestAiTimestamp = first(aiStatus.latestGeneratedAt, aiLatest?.latest?.generatedAt, aiLatest?.generatedAt, aiStatus.latestTimestamp);
  const hasLatestAiFlag = typeof aiStatus.latestExists === 'boolean';
  const hasAiJournalData = liveCount > 0 || aiStatus.latestExists === true;
  const aiEnvironmentNote = !aiStatus.enabled && aiStatus.latestExists
    ? 'Lokal AI-sammanfattning finns sparad trots att AI Analyst är avstängd i denna miljö.'
    : null;

  const pipelineStages = [
    {
      sectionId: 'live',
      name: 'Aktivitet',
      status: statusLabel(liveStatus),
      count: liveCount !== null ? (liveCount > 0 ? `${fmtNumber(liveCount)} händelser` : 'Tomt ännu') : '—',
      meaning: 'Visar vad systemet faktiskt har gjort senast i read-only-läge.',
      tone: statusTone(liveStatus),
      missing: liveCount !== null && liveCount > 0 ? 'Det finns verkliga händelser att läsa i Supervisor.' : text(liveActivitySummary.message, liveCount === 0 ? 'Ingen aktivitet sparad ännu.' : '—'),
      next: liveLatestEvent ? `Granska senaste händelsen: ${text(liveLatestEvent.title, 'Senaste aktivitet')}.` : 'När systemet sparar nya händelser visas de här först.',
    },
    {
      sectionId: 'data',
      name: 'Data',
      status: statusLabel(dataStatus.status),
      count: countLabel(dataStatus.readyForReplay, 'redo'),
      meaning: 'Historiska candles finns så att systemet kan testa säkert.',
      tone: statusTone(dataStatus.status),
      missing: number(dataStatus.missingData, null) === null ? '—' : dataStatus.missingData > 0 ? `${fmtNumber(dataStatus.missingData)} symboler saknar data.` : 'Inga tydliga datagap just nu.',
      next: nextRecommendedActions.find((item) => /backfill|data/i.test(text(item.title, '')))?.reason || 'Fyll på saknade symboler innan fler tester.',
    },
    {
      sectionId: 'replay',
      name: 'Replay',
      status: statusLabel(replayStatus.status),
      count: countLabel(totalReplayRuns, 'körningar'),
      meaning: 'Replay testar historiska signaler på riktig data.',
      tone: statusTone(replayStatus.status),
      missing: latestReplay ? 'Senaste replay finns sparad och kan jämföras.' : 'Ingen replayhistorik sparad ännu.',
      next: text(first(overview.replayAutopilotSummary?.lastReplayPlan?.recommendation, actionPlan[0]?.detail_sv), 'Samla data och kör replay när symbolerna är redo.'),
    },
    {
      sectionId: 'batch',
      name: 'Batch',
      status: statusLabel(batchStatus.status),
      count: countLabel(batchStatus.totalBatches, 'batchtester'),
      meaning: 'Batch jämför många strategi-inställningar.',
      tone: statusTone(batchStatus.status),
      missing: latestBatch ? 'Det finns minst en batch att läsa resultat från.' : 'Ingen batch ännu att jämföra.',
      next: text(first(overview.batchAutopilotSummary?.lastPlan?.recommendation, nextRecommendedActions.find((item) => /batch/i.test(text(item.title, '')))?.reason), 'Jämför senaste batch innan en ny körning planeras.'),
    },
    {
      sectionId: 'learning',
      name: 'Learning',
      status: statusLabel(learningStatus.status),
      count: countLabel(learningOutcomeCount, 'utfall'),
      meaning: 'Learning sammanfattar vad testerna faktiskt lärde systemet.',
      tone: statusTone(learningStatus.status),
      missing: learningStatus.topInsight ? 'Det finns redan mönster att arbeta vidare med.' : 'Fler testutfall behövs innan tydliga slutsatser går att dra.',
      next: text(learningStatus.nextRecommendedTest?.reason || learningRecommendations[0]?.reason, 'Fortsätt samla testresultat och jämför mot svaga punkter.'),
    },
    {
      sectionId: 'ai',
      name: 'AI Analyst',
      status: statusLabel(aiStatus.readiness || aiStatus.status),
      count: hasLatestAiFlag ? (aiStatus.latestExists ? '1 sparad analys' : 'Ingen sparad analys') : '—',
      meaning: 'AI Analyst läser testdata och föreslår nästa säkra test. AI kan inte handla.',
      tone: statusTone(aiStatus.readiness || aiStatus.status),
      missing: latestAiOutput ? 'Det finns en sparad AI-text att läsa.' : 'Ingen sparad AI-sammanfattning ännu.',
      next: text(nextRecommendedActions[0]?.reason, 'Uppdatera AI efter nästa replay eller batch.'),
    },
    {
      sectionId: 'paper',
      name: 'Paper',
      status: statusLabel(paperStatus.status),
      count: countLabel(paperTradeCount, 'paper trades'),
      meaning: 'Paper Trading är sista säkra teststeget innan något ens kan jämföras i större skala.',
      tone: statusTone(paperStatus.status),
      missing: paperTradeCount !== null && paperTradeCount > 0 ? 'Paper-resultat finns att läsa.' : text(paperStatus.message, 'Inga paper trades finns ännu.'),
      next: text(automationPlan?.nextSafeStep, 'Välj en strategi manuellt för ett paper-only replay efter granskning.'),
    },
  ];

  const activeStage = pipelineStages.find((stage) => sectionGroup(stage.sectionId) === activeSection) || pipelineStages[0];
  const systemHealthBlock = overview.blocks?.system_health || {};
  const systemHealthSummary = systemHealthBlock.summary || {};
  const systemHealthStatus = first(systemHealthSummary.overallStatus, systemHealthBlock.status, overview.status);
  const providerStatusText = aiStatus.enabled
    ? 'Konfigurerad'
    : aiStatus.provider && aiStatus.provider !== 'disabled'
      ? 'Saknar nyckel'
      : 'Avstängd eller okänd';
  const aiBrainRoles = [
    {
      role: 'Observer',
      status: first(systemHealthBlock.status, dataStatus.status, liveStatus),
      visible: 'Supervisor',
      source: 'Supervisor Overview, aktivitet, data och systemhälsa',
      note: 'Ser nuläge, varningar och saknad data.',
    },
    {
      role: 'Analyst',
      status: first(aiStatus.readiness, aiStatus.status),
      visible: 'AI Analyst och signalanalys',
      source: 'AI Analyst, Signal Analyst och Agent Reasoning',
      note: 'Förklarar signaler och testresultat. Den kan inte handla.',
    },
    {
      role: 'Planner',
      status: first(strategyResearch.status),
      visible: 'Strategiforskning',
      source: 'Strategy Research Manager och Strategy Test Planner',
      note: 'Föreslår nästa säkra research- eller paper-only-steg.',
    },
    {
      role: 'Researcher',
      status: first(strategyResearch.status),
      visible: 'Strategiforskning och Lab',
      source: 'AI Optimization Agent, TradingAgents och Agent Debate',
      note: 'Letar testideer för strategier som inte är trade-godkända.',
    },
    {
      role: 'Reviewer',
      status: hasResearchRecommendations ? (approvalRecommendations.length ? 'warning' : 'ok') : null,
      visible: 'Strategiforskning',
      source: 'Research Control och blockeringsregler',
      note: 'Markerar när mer data eller manuell granskning behövs.',
    },
    {
      role: 'Doctor',
      status: systemHealthStatus || 'ok',
      visible: 'Systemhälsa',
      source: 'System Health',
      note: 'Bevakar trasiga flöden, gammal data och systemrisker.',
    },
    {
      role: 'Librarian',
      status: first(learningStatus.status, 'degraded'),
      visible: 'Learning och minne',
      source: 'Learning Connector, Vector Memory och Audit Trail',
      note: 'Samlar lärdomar, minne och journal-liknande historik.',
    },
    {
      role: 'Loop Engine',
      status: 'degraded',
      visible: 'Delvis',
      source: 'Utspridda loop-delar',
      note: 'Observe, analyze, plan, test, learn och journal finns, men inte som en samlad motor.',
    },
    {
      role: 'Supervisor',
      status: safetyIsLocked ? 'ok' : 'blocked',
      visible: 'Denna vy',
      source: 'Safety-flaggor och skyddade zoner',
      note: 'Stoppar allt som rör livehandel, broker, riktiga order eller skyddade strategier.',
    },
  ];
  const aiBrainLoopStages = [
    {
      step: 'observe',
      label: 'Observera',
      status: first(systemHealthBlock.status, dataStatus.status),
      source: 'Systemhälsa, data och aktivitet',
      note: 'Systemet kan läsa nuläge och hitta luckor.',
    },
    {
      step: 'analyze',
      label: 'Analysera',
      status: first(aiStatus.readiness, aiStatus.status),
      source: 'AI Analyst, Agent Reasoning och regelmotorer',
      note: 'Analys finns både som intern logik och extern AI Analyst.',
    },
    {
      step: 'plan',
      label: 'Planera',
      status: first(strategyResearch.status),
      source: 'Strategy Research Control',
      note: 'Planen är read-only och kräver manuell granskning vid skyddade delar.',
    },
    {
      step: 'test',
      label: 'Testa',
      status: first(replayStatus.status, batchStatus.status, paperStatus.status, 'degraded'),
      source: 'Replay, batch och paper-only',
      note: 'Tester hör hemma i säkra testmiljöer, inte i live trading.',
    },
    {
      step: 'learn',
      label: 'Lär',
      status: first(learningStatus.status, 'degraded'),
      source: 'Learning Connector och Daytrading Learning',
      note: 'Learning samlar testutfall och bygger enklare slutsatser.',
    },
    {
      step: 'improve',
      label: 'Förbättra',
      status: hasResearchRecommendations ? 'ok' : null,
      source: 'AI Optimization och research-förslag',
      note: 'Förbättringar får bara vara förslag i research eller paper-only.',
    },
    {
      step: 'journal',
      label: 'Journal',
      status: (liveCount !== null || hasLatestAiFlag) ? (hasAiJournalData ? 'degraded' : 'warning') : null,
      source: 'Audit Trail, activity och AI Analyst-logg',
      note: 'Journal finns delvis. En samlad AI Journal saknas ännu.',
    },
  ];
  const protectedZones = [
    { name: 'Interactive Brokers', status: 'Skyddad zon', note: 'AI Brain får inte styra broker eller konto.' },
    { name: 'Trade-godkända strategier', status: 'Skyddad zon', note: 'AI får bara föreslå manuell granskning.' },
    { name: 'Broker, order och execution', status: 'Blockerat', note: 'Inga riktiga order och ingen orderväg visas här.' },
    { name: 'Live trading', status: 'Avstängt', note: 'Livehandel ska inte kunna aktiveras från AI Brain.' },
    { name: 'Riskändring', status: 'Skyddad', note: 'AI får inte ändra risk automatiskt.' },
    { name: 'Strategy approval', status: 'Manuell process', note: 'AI får inte godkänna eller flytta upp strategier själv.' },
  ];
  const aiBrainSafetyRows = [
    { label: 'mode', value: text(overviewSafety(overview).mode, '—'), good: overviewSafety(overview).mode === 'paper_only' },
    { label: 'actions_allowed', value: boolString(overviewSafety(overview).actions_allowed), good: overviewSafety(overview).actions_allowed === false },
    { label: 'can_place_orders', value: boolString(overviewSafety(overview).can_place_orders), good: overviewSafety(overview).can_place_orders === false },
    { label: 'live_trading_enabled', value: boolString(overviewSafety(overview).live_trading_enabled), good: overviewSafety(overview).live_trading_enabled === false },
    { label: 'broker_enabled', value: boolString(overviewSafety(overview).broker_enabled), good: overviewSafety(overview).broker_enabled === false },
  ];
  const supervisorKpis = [
    {
      label: 'Supervisor',
      value: statusLabel(overview.status),
      hint: data.updatedAt ? `Uppdaterad ${timeText(data.updatedAt)}` : 'Ingen uppdatering ännu',
      tone: statusTone(overview.status),
    },
    {
      label: 'Safety',
      value: safetyIsLocked ? 'Låst' : 'Kontrollera',
      hint: text(overviewSafety(overview).mode, '—'),
      tone: safetyIsLocked ? 'good' : 'danger',
    },
    {
      label: 'Paper trades',
      value: fmtNumber(paperTradeCount),
      hint: statusLabel(paperStatus.status),
      tone: statusTone(paperStatus.status),
    },
    {
      label: 'Batchtester',
      value: fmtNumber(batchStatus.totalBatches),
      hint: latestBatch ? timeText(first(latestBatch.completedAt, latestBatch.startedAt)) : 'Ingen batch ännu',
      tone: statusTone(batchStatus.status),
    },
    {
      label: 'Replay',
      value: fmtNumber(totalReplayRuns),
      hint: latestReplay ? timeText(first(latestReplay.createdAt, latestReplay.timestamp)) : 'Ingen replay ännu',
      tone: statusTone(replayStatus.status),
    },
    {
      label: 'Learning',
      value: fmtNumber(learningOutcomeCount),
      hint: statusLabel(learningStatus.status),
      tone: statusTone(learningStatus.status),
    },
  ];
  const pipelineBars = data.overview
    ? [
        { label: 'Batch', value: batchResultRows, tone: 'purple' },
        { label: 'Replay', value: totalReplayRuns, tone: 'warning' },
        { label: 'Paper', value: paperTradeCount, tone: 'good' },
        { label: 'Learning', value: learningOutcomeCount, tone: 'blue' },
      ]
    : [];
  const supervisorActivity = liveEvents.slice(0, 6).map((event, index) => ({
    id: event.id || event.eventId || `${event.type || 'event'}-${index}`,
    title: text(first(event.title, event.type, event.eventType), 'Systemhändelse'),
    meta: text(first(event.reasonSv, event.reason, event.message, event.status, event.symbol), 'Ingen detalj'),
    time: first(event.timestamp, event.createdAt, event.updatedAt)
      ? timeText(first(event.timestamp, event.createdAt, event.updatedAt))
      : null,
    tone: statusTone(first(event.status, event.severity, 'neutral')),
  }));

  return (
    <DashboardShell
      title="Supervisor"
      subtitle="Samlad paper-only status för safety, tester, strategier, learning och nästa säkra steg."
      safety={overviewSafety(overview)}
      tabs={SECTIONS}
      activeTab={activeSection}
      onTab={setActiveSection}
      kpis={supervisorKpis}
    >
    <div className="research-lab-page tradingos-page">
      <main className="research-main tradingos-main">
        {data.error ? (
          <div className="tos-alert tos-alert-warning">{data.error}</div>
        ) : null}

        {data.loading ? (
          <div className="tos-loading">Laddar Trading OS-pipelinen…</div>
        ) : null}

        {activeSection === 'oversikt' ? (
          <div className="dash-grid-2">
            <ChartCard title="Pipeline-fördelning" subtitle="Befintliga resultat och observationer" tone="purple">
              <BarChart bars={pipelineBars} emptyText="Pipeline-data saknas ännu." />
            </ChartCard>
            <ChartCard title="Senaste aktivitet" subtitle="Read-only events från Supervisor" tone="warning">
              <ActivityList items={supervisorActivity} emptyText="Ingen systemaktivitet finns ännu." />
            </ChartCard>
          </div>
        ) : null}

        {activeSection === 'oversikt' ? (
          <SupervisorIntelligence
            overview={overview}
            liveActivity={liveActivity}
            replay={replay}
            batches={batches}
            allowlist={allowlist}
            automationPlan={automationPlan}
            aiLatest={aiLatest}
            updatedAt={data.updatedAt}
            eventStore={tradingEventStore}
            decisionStore={decisionStore}
            waiting={data.loading}
          />
        ) : null}

        {activeSection === 'oversikt' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Kontrollrum</div>
                <h2>Pipeline-status från data till paper</h2>
                <p>Varje steg visar status, antal, enkel förklaring, vad som saknas och nästa rekommenderade steg.</p>
              </div>
              <Badge tone={activeStage.tone}>{activeStage.status}</Badge>
            </div>

            <SectionCard
              title="Pipeline-översikt"
              tone={safetyIsLocked ? 'good' : 'danger'}
              aside={<Badge tone={safetyIsLocked ? 'good' : 'danger'}>{safetyIsLocked ? 'paper_only' : 'kontrollera safety'}</Badge>}
            >
              <div className="tos-metrics-grid">
                <Metric
                  label="Pipeline-status"
                  value={text(first(overview.blocks?.system_health?.summary?.summarySv, statusLabel(overview.status)), 'Saknas')}
                  help="Övergripande systemhälsa, read-only."
                  tone={statusTone(first(overview.blocks?.system_health?.status, overview.status))}
                />
                <Metric
                  label="Paper trading"
                  value={paperTradeCount !== null && paperTradeCount > 0 ? `${fmtNumber(paperTradeCount)} trades` : paperTradeCount === 0 ? 'Inga trades ännu' : '—'}
                  help={paperTradeCount !== null && paperTradeCount > 0 ? timeText(first(paperStatus.latestPaperTrade?.timestamp, paperStatus.latestPaperTrade?.createdAt)) : text(paperStatus.emptyReason, paperTradeCount === 0 ? 'no_paper_trades' : 'Saknas')}
                  tone={statusTone(paperStatus.status)}
                />
                <Metric
                  label="Senaste batch"
                  value={latestBatch ? `winrate ${fmtPct(latestBatch.winRate)}` : 'Ingen batch ännu'}
                  help={latestBatch ? timeText(first(latestBatch.completedAt, latestBatch.startedAt)) : 'Kör batch när data finns.'}
                  tone={statusTone(batchStatus.status)}
                />
                <Metric
                  label="Senaste replay"
                  value={latestReplay ? `snittbetyg ${fmtNumber(first(latestReplay.avgTradeScore, latestReplay.avgScore))}` : 'Ingen replay ännu'}
                  help={latestReplay ? timeText(first(latestReplay.createdAt, latestReplay.timestamp)) : 'Kör replay när symbolerna är redo.'}
                  tone={statusTone(replayStatus.status)}
                />
                <Metric
                  label="Nästa planerade test"
                  value={timeText(first(overview.replayAutopilotSummary?.nextRun, overview.batchAutopilotSummary?.nextRun))}
                  help="Endast dry-run/research. Inga riktiga order."
                  tone="blue"
                />
                <Metric
                  label="Senaste learning-insikt"
                  value={text(first(learningStatus.narrowLearning?.bestStrategy?.name, learningStatus.topInsight, learningRecommendations[0]?.title, learningRecommendations[0]?.reason), 'Ingen insikt ännu')}
                  help={text(first(learningStatus.narrowLearning?.message, learningStatus.status && `status: ${statusLabel(learningStatus.status)}`), 'Samla fler testutfall.')}
                  tone={statusTone(learningStatus.status)}
                />
              </div>
              {(() => {
                const blockedReasons = arr([
                  overview.replayAutopilotSummary?.lastBlockedReason,
                  overview.batchAutopilotSummary?.lastBlockedReason,
                  overview.blocks?.autopilot?.summary?.blockedReason,
                  dataStatus.status === 'degraded' ? `data:${text(dataStatus.message, 'degraded')}` : null,
                ]).filter(Boolean);
                return (
                  <div className="tos-safety-line">
                    {blockedReasons.length
                      ? blockedReasons.map((reason, index) => (
                          <Badge key={`blocked-${index}`} tone="warning">{reason}</Badge>
                        ))
                      : <Badge tone="good">Inga blockerade händelser</Badge>}
                  </div>
                );
              })()}
              <div className="tos-safety-line">
                <Badge tone="good">paper_only</Badge>
                <Badge tone="good">broker avstängd</Badge>
                <Badge tone="good">inga riktiga order</Badge>
                <Badge tone="good">ingen livehandel</Badge>
              </div>
            </SectionCard>

            <div className="tos-pipeline">
              {pipelineStages.map((stage) => (
                <PipelineStage
                  key={stage.name}
                  stage={stage}
                  active={sectionGroup(stage.sectionId) === activeSection}
                  onSelect={(sectionId) => setActiveSection(sectionGroup(sectionId))}
                />
              ))}
            </div>

            <SectionCard title={`${activeStage.name} just nu`} tone={activeStage.tone} aside={<Badge tone={activeStage.tone}>{activeStage.count}</Badge>}>
              <MeaningBlock
                meaning={activeStage.meaning}
                missing={activeStage.missing}
                nextStep={activeStage.next}
              />
            </SectionCard>

            <div className="tos-two-col">
              <ResearchAutomationCard
                overview={overview}
                automationPlan={automationPlan}
                nextRecommendedActions={nextRecommendedActions}
              />
              <SectionCard title="Nästa säkra steg" tone="blue" aside={<Badge tone="blue">read-only</Badge>}>
                <div className="tos-list">
                  {nextRecommendedActions.slice(0, 5).map((item, index) => (
                    <div key={`${text(item.title, 'next')}-${index}`} className="tos-list-row">
                      <strong>{text(item.title, 'Nästa steg')}</strong>
                      <span>{text(item.reason, 'Saknas')}</span>
                    </div>
                  ))}
                </div>
                {!nextRecommendedActions.length ? <p className="tos-empty">Ingen rekommendation sparad ännu.</p> : null}
              </SectionCard>
            </div>

            <DryRunTestCard />
          </section>
        ) : null}

        {activeSection === 'autopilot' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Autopilot</div>
                <h2>Read-only planering och AI-loop</h2>
                <p>Autopiloterna planerar i dry-run. Den här vyn startar inget, ändrar inget och kan inte handla.</p>
              </div>
              <Badge tone={safetyIsLocked ? 'good' : 'danger'}>{safetyIsLocked ? 'Safety låst' : 'Kontrollera safety'}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Replay autopilot" value={statusLabel(overview.replayAutopilotSummary?.status)} help={timeText(overview.replayAutopilotSummary?.nextRun)} tone={statusTone(overview.replayAutopilotSummary?.status)} />
              <Metric label="Batch autopilot" value={statusLabel(overview.batchAutopilotSummary?.status)} help={timeText(overview.batchAutopilotSummary?.nextRun)} tone={statusTone(overview.batchAutopilotSummary?.status)} />
              <Metric label="Läge" value="Dry-run" help="Planerar men exekverar inte." tone="good" />
              <Metric label="Senaste blockerare" value={text(first(overview.replayAutopilotSummary?.lastBlockedReason, overview.batchAutopilotSummary?.lastBlockedReason), 'Ingen')} help="Read-only status." tone="warning" />
            </div>

            <SectionCard
              title="AI- och loopstatus"
              tone={safetyIsLocked ? 'good' : 'danger'}
              aside={<Badge tone="blue">read-only</Badge>}
            >
              <div className="tos-metrics-grid">
                <Metric label="Safety" value={safetyIsLocked ? 'Låst' : 'Kontrollera'} help="Alla skyddsflaggor ska vara i säkert läge." tone={safetyIsLocked ? 'good' : 'danger'} />
                <Metric label="Extern AI" value={providerStatusText} help={`${text(aiStatus.provider, 'okänd provider')} · ${text(aiStatus.model, 'ingen modell')}`} tone={aiStatus.enabled ? 'good' : 'warning'} />
                <Metric label="Intern AI" value={`${fmtNumber(aiBrainRoles.length)} roller`} help="Regelbaserade agenter, analyst och researchlager finns redan." tone="blue" />
                <Metric label="Minne / learning" value={statusLabel(learningStatus.status)} help="Learning Connector och minneslager finns delvis." tone={statusTone(learningStatus.status)} />
                <Metric label="Journal / audit" value={(liveCount !== null || hasLatestAiFlag) ? (hasAiJournalData ? 'Delvis' : 'Saknas delvis') : '—'} help="Audit och events finns, men inte en samlad AI Journal." tone={(liveCount !== null || hasLatestAiFlag) ? (hasAiJournalData ? 'warning' : 'danger') : 'neutral'} />
                <Metric label="Research Control" value={statusLabel(strategyResearch.status)} help="Styr vad AI får föreslå för strategier." tone={statusTone(strategyResearch.status)} />
                <Metric label="Doctor" value={statusLabel(systemHealthStatus)} help={text(systemHealthSummary.summarySv, 'System Health är Doctor-liknande status.')} tone={statusTone(systemHealthStatus)} />
                <Metric label="Loop Engine" value="Delvis" help="Loopens delar finns, men inte som en samlad motor ännu." tone="warning" />
              </div>
              <div className="tos-safety-line">
                <Badge tone="good">paper_only</Badge>
                <Badge tone="good">livehandel avstängd</Badge>
                <Badge tone="good">broker avstängd</Badge>
                <Badge tone="good">riktiga order blockerade</Badge>
              </div>
            </SectionCard>

            <div className="tos-two-col">
              <SectionCard title="AI-roller som redan finns" tone="blue">
                <div className="tos-list">
                  {aiBrainRoles.map((row) => (
                    <div key={row.role} className="tos-list-row">
                      <strong>{row.role}</strong>
                      <span>{row.note}</span>
                      <span>{row.visible} · {row.source} · {statusLabel(row.status)}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Loop Engine-status" tone="warning" aside={<Badge tone="warning">delvis</Badge>}>
                <div className="tos-list">
                  {aiBrainLoopStages.map((row) => (
                    <div key={row.step} className="tos-list-row">
                      <strong>{row.step}: {row.label}</strong>
                      <span>{row.note}</span>
                      <span>{row.source} · {statusLabel(row.status)}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>

            <div className="tos-two-col">
              <SectionCard title="AI Memory / Knowledge Base" tone="neutral">
                <div className="tos-list">
                  <div className="tos-list-row">
                    <strong>Learning Connector</strong>
                    <span>{statusLabel(learningStatus.status)}. Samlar testutfall och strategilärdomar.</span>
                    <span>Syns i Learning och Supervisor.</span>
                  </div>
                  <div className="tos-list-row">
                    <strong>Vector Memory</strong>
                    <span>Finns som minneslager för liknande signaler och historiska mönster.</span>
                    <span>Syns svagt i UI och bör lyftas senare.</span>
                  </div>
                  <div className="tos-list-row">
                    <strong>Daytrading Learning</strong>
                    <span>Finns som learning engine för paper- och testutfall.</span>
                    <span>Read-only i denna vy.</span>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="AI Journal / Audit Trail" tone="warning">
                <div className="tos-list">
                  <div className="tos-list-row">
                    <strong>Audit Trail</strong>
                    <span>Finns som händelselogg för system, kandidater, paper och batch.</span>
                    <span>Det är journal-liknande, men inte full AI Journal ännu.</span>
                  </div>
                  <div className="tos-list-row">
                    <strong>AI Analyst-logg</strong>
                    <span>{hasLatestAiFlag ? (aiStatus.latestExists ? 'Senaste AI Analyst-resultat finns sparat.' : 'Ingen sparad AI Analyst-text visas här.') : 'AI Analyst-latest saknas i backend-snapshoten.'}</span>
                    <span>{latestAiTimestamp ? timeText(latestAiTimestamp) : 'Tidsstämpel saknas'}</span>
                  </div>
                  <div className="tos-list-row">
                    <strong>Nästa steg</strong>
                    <span>Samla audit, learning och AI-anteckningar i en tydlig AI Journal senare.</span>
                    <span>Fortfarande read-only.</span>
                  </div>
                </div>
              </SectionCard>
            </div>

            <div className="tos-two-col">
              <SectionCard title="Strategy Research Control" tone="blue">
                <MeaningBlock
                  meaning="AI får föreslå research och paper-only tester för strategier som inte är skyddade."
                  missing={hasResearchRecommendations ? (approvalRecommendations.length ? `${fmtNumber(approvalRecommendations.length)} förslag kräver manuell granskning eller mer data.` : 'Inga tydliga research-blockeringar i denna vy just nu.') : 'Research-förslag saknas i backend-snapshoten.'}
                  nextStep="Behåll trade-godkända strategier skyddade. Låt AI bara föreslå research eller manuell granskning."
                />
                <div className="tos-safety-line">
                  <Badge tone="good">research</Badge>
                  <Badge tone="good">paper-only</Badge>
                  <Badge tone="warning">manuell granskning</Badge>
                  <Badge tone="danger">ingen auto-apply</Badge>
                </div>
              </SectionCard>

              <SectionCard title="Skyddade zoner" tone="danger">
                <div className="tos-list">
                  {protectedZones.map((zone) => (
                    <div key={zone.name} className="tos-list-row">
                      <strong>{zone.name}</strong>
                      <span>{zone.note}</span>
                      <span>{zone.status}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>

            <SectionCard title="Safety-flaggor" tone={safetyIsLocked ? 'good' : 'danger'}>
              <div className="tos-detail-grid">
                {aiBrainSafetyRows.map((row) => (
                  <span key={row.label}>
                    <b>{row.label}</b>
                    {row.value}
                  </span>
                ))}
              </div>
              <div className="tos-safety-line">
                {aiBrainSafetyRows.map((row) => (
                  <Badge key={row.label} tone={row.good ? 'good' : 'danger'}>
                    {row.label}: {row.value}
                  </Badge>
                ))}
              </div>
              <p className="tos-muted">Om någon flagga inte är säker ska AI Brain bara visa varning och inte fortsätta någon loop.</p>
            </SectionCard>

            <details className="tos-debug">
              <summary>Visa tekniska källor</summary>
              <pre>{JSON.stringify({
                overview: '/api/supervisor/overview',
                latestAi: '/api/ai/analyst/latest',
                aiAnalystStatus: {
                  provider: aiStatus.provider || null,
                  enabled: aiStatus.enabled === true,
                  model: aiStatus.model || null,
                  latestExists: aiStatus.latestExists === true,
                },
                safety: overviewSafety(overview),
                note: 'AI Brain Steg 1 använder bara redan hämtad read-only status i UI.',
              }, null, 2)}</pre>
            </details>
          </section>
        ) : null}

        {activeSection === 'teknik' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Aktivitet</div>
                <h2>Vad systemet faktiskt gjorde senast</h2>
                <p>Live Activity läser bara sparade events från Data Center, replay, learning, AI och paper-only historik. Den startar inget.</p>
              </div>
              <Badge tone={statusTone(liveStatus)}>{statusLabel(liveStatus)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Händelser" value={fmtNumber(liveCount)} help="Read-only count från live activity." tone="blue" />
              <Metric label="Senaste källa" value={text(liveActivitySummary.latestSource || liveLatestEvent?.source, 'Saknas')} help="Vilken källa den senaste händelsen kom från." tone="blue" />
              <Metric label="Senaste status" value={statusLabel(liveLatestEvent?.status || liveStatus)} help="Status för senaste händelsen." tone={statusTone(liveLatestEvent?.status || liveStatus)} />
              <Metric label="Senast uppdaterad" value={timeText(first(liveActivitySummary.latestAt, liveLatestEvent?.timestamp))} help="Tidsstämpel för senaste sparade händelsen." tone={liveCount > 0 ? 'good' : 'warning'} />
            </div>

            <MeaningBlock
              meaning="Det här är systemets närmaste facit för vad som nyligen hände i paper-only miljön."
              missing={liveCount > 0 ? 'Om något ser fel ut här är nästa steg att jämföra samma källa i dess egen status-API.' : text(liveActivitySummary.message, 'Ingen aktivitet hittades ännu.')}
              nextStep={liveLatestEvent ? `${text(liveLatestEvent.title, 'Senaste aktivitet')}: ${text(liveLatestEvent.message, 'Saknas')}` : 'När nästa replay, batch eller learning-event sparas visas det här.'}
            />

            <ListBlock
              title="Senaste händelser"
              items={liveEvents}
              emptyText="Ingen aktivitet ännu i den här vyn."
              renderItem={(row) => (
                <>
                  <strong>{text(row.title, 'Händelse')}</strong>
                  <span>{text(row.message, 'Saknas')}</span>
                  <span>{timeText(row.timestamp)} · {text(row.symbol || row.strategy || row.source, 'okänd källa')}</span>
                </>
              )}
            />

            <ListBlock
              title="Källor"
              items={liveSourceBreakdown.slice(0, 8)}
              emptyText="Inga live-källor lästa ännu."
              renderItem={(row) => (
                <>
                  <strong>{text(row.name, 'Källa')}</strong>
                  <span>{statusLabel(row.status)} · {fmtNumber(row.count)} händelser</span>
                  <span>{timeText(row.latestAt)}</span>
                </>
              )}
            />
          </section>
        ) : null}

        {activeSection === 'teknik' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Data</div>
                <h2>Historisk data som gör tester möjliga</h2>
                <p>Data är grunden. Utan candles och historik går varken replay, batch eller learning att lita på.</p>
              </div>
              <Badge tone={statusTone(dataStatus.status)}>{statusLabel(dataStatus.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Redo symboler" value={fmtNumber(dataStatus.readyForReplay)} help="Kan användas i replay direkt." tone="good" />
              <Metric label="Saknar data" value={fmtNumber(dataStatus.missingData)} help="Behöver backfill eller provider-stöd." tone={number(dataStatus.missingData, null) === null ? 'blue' : number(dataStatus.missingData, null) > 0 ? 'warning' : 'good'} />
              <Metric label="Candles" value={fmtNumber(totalCandles)} help="Summerat från read-only symbolstatus." tone="blue" />
              <Metric label="Dagar historik" value={fmtNumber(maxHistoryDays)} help="Bästa tillgängliga 2m-fönstret just nu." tone="blue" />
            </div>

            <MeaningBlock
              meaning="Den här sektionen visar om systemet har tillräcklig historik för att börja testa på riktigt i en säker miljö."
              missing={missingSymbols.length ? `${fmtNumber(missingSymbols.length)} symboler saknar tillräcklig historik eller provider-stöd.` : 'Ingen tydlig datalucka just nu.'}
              nextStep={text(nextRecommendedActions.find((item) => /backfill|data/i.test(text(item.title, '')))?.reason, 'Fyll på datagap innan fler symboler går vidare till replay.')}
            />

            <div className="tos-two-col">
              <ListBlock
                title="Redo symboler"
                items={readySymbolsDetailed.slice(0, 8)}
                emptyText="Inga redo symboler i denna vy."
                renderItem={(row) => (
                  <>
                    <strong>{row.symbol}</strong>
                    <span>{fmtNumber(row.total_candle_count)} candles · {fmtNumber(row.candles_2m_days)} dagar</span>
                    <span>{text(row.status_sv, 'Bra data')}</span>
                  </>
                )}
              />
              <ListBlock
                title="Saknar data"
                items={missingSymbols.slice(0, 8)}
                emptyText="Ingen symbol saknar data just nu."
                renderItem={(row) => (
                  <>
                    <strong>{row.symbol}</strong>
                    <span>{text(row.reason, 'Saknas')}</span>
                    <span>{text(row.provider, 'okänd provider')}</span>
                  </>
                )}
              />
            </div>

            <SectionCard title="Provider-status" tone="neutral">
              <div className="tos-provider-grid">
                {Object.entries(dataStatus.providerStatus || {}).map(([key, provider]) => (
                  <div key={key} className="tos-provider-card">
                    <strong>{key}</strong>
                    <Badge tone={provider?.ok ? 'good' : 'warning'}>{provider?.ok ? 'redo' : 'saknas'}</Badge>
                    <span>{text(provider?.message_sv, 'Ingen status')}</span>
                  </div>
                ))}
              </div>
            </SectionCard>
          </section>
        ) : null}

        {activeSection === 'tester' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Replay</div>
                <h2>Historiska signaler testas på riktig data</h2>
                <p>Replay testar historiska signaler på riktig data och visar om strategierna faktiskt fungerar utanför teori.</p>
              </div>
              <Badge tone={statusTone(replayStatus.status)}>{statusLabel(replayStatus.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Replay-runs" value={fmtNumber(totalReplayRuns)} help="Sparade säkra testkörningar." tone="blue" />
              <Metric label="Events" value={fmtNumber(replayEventsTotal)} help="Totalt från replay-status där fältet finns." tone="blue" />
              <Metric label="Symboler" value={fmtNumber(replaySymbolCount)} help="Antal symboler i senaste eller samlade replay-data." tone="blue" />
              <Metric label="Timeframe" value={replayTimeframe} help="Replay körs mot sparad historik, inte live." tone="blue" />
              <Metric label="Bästa symbol" value={text(bestReplaySymbol?.symbol, 'Saknas')} help={bestReplaySymbol?.avgScore != null ? `Snittscore ${fmtNumber(bestReplaySymbol.avgScore)}` : 'Ingen symboltopplista ännu'} tone="good" />
            </div>

            <MeaningBlock
              meaning="Replay hjälper systemet att testa om samma strategi hade gett rimliga utfall på riktig historik."
              missing={latestReplay ? 'Det finns replayhistorik att läsa, men fler körningar ger säkrare jämförelser.' : 'Ingen replay är sparad ännu.'}
              nextStep={text(first(overview.replayAutopilotSummary?.lastReplayPlan?.recommendation, nextRecommendedActions.find((item) => /replay/i.test(text(item.title, '')))?.reason), 'Kör replay när symbolerna är redo och skicka utfallet vidare till learning.')}
            />

            <SectionCard title="Senaste replay" tone="blue" aside={<Badge tone="blue">{latestReplay ? timeText(latestReplay.createdAt) : 'Saknas'}</Badge>}>
              {latestReplay ? (
                <div className="tos-detail-grid">
                  <span><b>Period</b>{`${text(latestReplay.period?.from, '?')} → ${text(latestReplay.period?.to, '?')}`}</span>
                  <span><b>Symboler</b>{fmtNumber(first(latestReplay.symbolCount, Array.isArray(latestReplay.symbols) ? latestReplay.symbols.length : null))}</span>
                  <span><b>Events</b>{fmtNumber(latestReplay.totalEvents)}</span>
                  <span><b>Candles</b>{fmtNumber(latestReplay.totalCandles)}</span>
                  <span><b>Bästa symbol</b>{text(latestReplay.bestSymbol?.symbol, 'Saknas')}</span>
                  <span><b>Sammanfattning</b>{text(latestReplay.outcome, 'Saknas')}</span>
                </div>
              ) : (
                <p className="tos-empty">Ingen replay finns ännu i den här vyn.</p>
              )}
            </SectionCard>

            <ListBlock
              title="Senaste replay-runs"
              items={recentReplays.slice(0, 4)}
              emptyText="Inga replay-runs sparade ännu."
              renderItem={(row) => (
                <>
                  <strong>{timeText(row.createdAt)}</strong>
                  <span>{text(row.bestSymbol?.symbol, 'Ingen topprad')} · {fmtNumber(row.totalEvents)} events</span>
                  <span>{text(row.outcome, 'Saknas')}</span>
                </>
              )}
            />
          </section>
        ) : null}

        {activeSection === 'tester' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Batch</div>
                <h2>Stora jämförelser mellan strategi-inställningar</h2>
                <p>Batch jämför många strategi-inställningar samtidigt och gör det lätt att se vad som fungerar bäst och sämst.</p>
              </div>
              <Badge tone={statusTone(batchStatus.status)}>{statusLabel(batchStatus.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Batchtester" value={fmtNumber(batchStatus.totalBatches)} help="Sparade batchkörningar." tone="blue" />
              <Metric label="Kombinationer" value={fmtNumber(batchCombinations)} help="Inställningar testade i senaste batch." tone="blue" />
              <Metric label="Resultatrader" value={fmtNumber(batchResultRows)} help="Totalt lästa batch-resultatrader från historiken." tone="blue" />
              <Metric label="Senaste batch" value={latestBatch ? timeText(latestBatch.completedAt || latestBatch.startedAt) : 'Saknas'} help="Visar senaste jämförelsen." tone={latestBatch ? 'good' : 'warning'} />
            </div>

            <MeaningBlock
              meaning="Batch används för att jämföra många strategi-inställningar mot samma historik och hitta bättre varianter innan något går vidare."
              missing={latestBatch ? 'Det finns minst en batch att analysera, men fler batcher ger bättre jämförelser.' : 'Ingen batch finns ännu att jämföra.'}
              nextStep={text(first(overview.batchAutopilotSummary?.lastPlan?.recommendation, nextRecommendedActions.find((item) => /batch/i.test(text(item.title, '')))?.reason), 'Jämför senaste batch, välj en svag punkt och planera nästa test.')}
            />

            <div className="tos-two-col">
              <SectionCard title="Bästa batchresultat" tone="good" aside={<Badge tone="good">{fmtPct(bestBatch?.winRate)}</Badge>}>
                {bestBatch ? (
                  <div className="tos-detail-grid">
                    <span><b>Strategi</b>{text(bestBatch.strategy, 'Saknas')}</span>
                    <span><b>Symbol</b>{text(bestBatch.symbol, 'Saknas')}</span>
                    <span><b>Win rate</b>{fmtPct(bestBatch.winRate)}</span>
                    <span><b>Avg PnL</b>{fmtSigned(bestBatch.avgResult)}</span>
                  </div>
                ) : (
                  <p className="tos-empty">Bästa batchresultat saknas.</p>
                )}
              </SectionCard>
              <SectionCard title="Svagaste batchresultat" tone="warning" aside={<Badge tone="warning">{fmtPct(worstBatch?.winRate)}</Badge>}>
                {worstBatch ? (
                  <div className="tos-detail-grid">
                    <span><b>Strategi</b>{text(worstBatch.strategy, 'Saknas')}</span>
                    <span><b>Symbol</b>{text(worstBatch.symbol, 'Saknas')}</span>
                    <span><b>Win rate</b>{fmtPct(worstBatch.winRate)}</span>
                    <span><b>Avg PnL</b>{fmtSigned(worstBatch.avgResult)}</span>
                  </div>
                ) : (
                  <p className="tos-empty">Svagaste batchresultat saknas.</p>
                )}
              </SectionCard>
            </div>
          </section>
        ) : null}

        {activeSection === 'strategies' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Strategier</div>
                <h2>Vilka strategier ser starka eller svaga ut just nu?</h2>
                <p>Här syns vilka strategier som är aktiva, vilka som behöver mer data och vilka som just nu presterar bäst eller svagast.</p>
              </div>
              <Badge tone={statusTone(strategyRanking.status)}>{statusLabel(strategyRanking.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Strategitester" value={fmtNumber(strategyTests)} help="Historiska strategy_tests från Data Center." tone={strategyTests === null ? 'blue' : strategyTests > 0 ? 'good' : 'warning'} />
              <Metric label="Unika strategier" value={fmtNumber(uniqueStrategies)} help="Antal unika strategier med historisk coverage." tone={uniqueStrategies === null ? 'blue' : uniqueStrategies > 0 ? 'good' : 'warning'} />
              <Metric label="Batch-resultatrader" value={fmtNumber(strategyBatchRows)} help="Historiska batch_result_rows från Data Center." tone={strategyBatchRows === null ? 'blue' : strategyBatchRows > 0 ? 'good' : 'warning'} />
              <Metric label="Coverage-källa" value={historicalCoverageSource} help="Read-only källa för historisk strategitäckning." tone={hasHistoricalStrategyCoverage ? 'blue' : 'warning'} />
            </div>

            <MeaningBlock
              meaning="Strategier jämförs här efter testunderlag, win rate, avg PnL och senaste test. Målet är att prioritera fler tester, inte att handla live."
              missing={needsMoreData.length
                ? `${fmtNumber(needsMoreData.length)} strategier behöver mer data innan de går att jämföra rättvist.`
                : (hasHistoricalStrategyCoverage ? 'Historik finns i Data Center även där enskild strategi ännu saknar tydligt testcount.' : 'De flesta strategier har något testunderlag.')}
              nextStep={text(bestJustNow?.recommendedAction || nextRecommendedActions.find((item) => /strategi|granska/i.test(text(item.title, '')))?.reason, 'Välj en stark och en svag strategi för nästa jämförelse.')}
            />

            <div className="tos-two-col">
              <ListBlock
                title="Bästa just nu"
                items={topStrategies}
                emptyText="Ingen topplista ännu."
                renderItem={(row) => (
                  <>
                    <strong>{supervisorStrategyLabel(row)}</strong>
                    <span>Win rate {fmtPct(row.winRate)} · Avg PnL {fmtSigned(row.avgPnl)}</span>
                    <span>{strategyEvidenceText(row, hasHistoricalStrategyCoverage)} · Senaste test {timeText(row.lastTested)}</span>
                  </>
                )}
              />
              <ListBlock
                title="Svagaste just nu"
                items={weakStrategies}
                emptyText="Ingen svaghetslista ännu."
                renderItem={(row) => (
                  <>
                    <strong>{supervisorStrategyLabel(row)}</strong>
                    <span>Win rate {fmtPct(row.winRate)} · Avg PnL {fmtSigned(row.avgPnl)}</span>
                    <span>{strategyEvidenceText(row, hasHistoricalStrategyCoverage)} · {text(row.recommendedAction, 'Saknas')}</span>
                  </>
                )}
              />
            </div>

            <ListBlock
              title="Behöver mer data"
              items={needsMoreData}
              emptyText="Ingen strategi står ut som datatunn just nu."
                renderItem={(row) => (
                  <>
                    <strong>{supervisorStrategyLabel(row)}</strong>
                    <span>{strategyEvidenceText(row, hasHistoricalStrategyCoverage)} · Confidence {fmtNumber(row.confidence)}</span>
                    <span>{text(row.recommendedAction, 'Behöver fler tester')}</span>
                  </>
                )}
            />
          </section>
        ) : null}

        {activeSection === 'learning' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Learning</div>
                <h2>Vad systemet har lärt sig av resultaten</h2>
                <p>Learning tar testresultat från replay, batch och andra säkra källor och sammanfattar vad som fungerar och vad som bör testas mer.</p>
              </div>
              <Badge tone={statusTone(learningStatus.status)}>{statusLabel(learningStatus.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Learning status" value={statusLabel(learningStatus.status)} help="Read-only sammanfattning av lärdomar." tone={statusTone(learningStatus.status)} />
              <Metric label="Confidence" value={text(learningStatus.narrowLearning?.dataConfidence, 'Saknas')} help="Hur säkra de nuvarande slutsatserna är." tone="blue" />
              <Metric label="Replay-koppling" value={fmtNumber(learningReplayCount)} help="Antal replay-events i learning-connectorn." tone={learningReplayCount === null ? 'blue' : learningReplayCount > 0 ? 'good' : 'warning'} />
              <Metric label="Batch-koppling" value={fmtNumber(learningBatchCount)} help="Antal batch-events i learning-connectorn." tone={learningBatchCount === null ? 'blue' : learningBatchCount > 0 ? 'good' : 'warning'} />
              <Metric label="Bästa strategi" value={text(learningStatus.bestLearning?.name, 'Saknas')} help={learningStatus.bestLearning?.winRate != null ? `Win rate ${fmtPct(learningStatus.bestLearning.winRate)}` : 'Saknas'} tone="good" />
              <Metric label="Svagaste punkt" value={text(learningStatus.worstWeakness?.name || learningStatus.signalLearningSummary?.failureAnalysis?.[0]?.labelSv, 'Saknas')} help="Visar var systemet lär sig mest just nu." tone="warning" />
            </div>

            <MeaningBlock
              meaning="Learning visar vad resultaten faktiskt säger: vilken strategi som ser bäst ut, var den svaga punkten ligger och vad som bör testas mer."
              missing={learningStatus.topInsight ? 'Det finns redan lärdomar att agera på i nästa test.' : 'Fler testutfall behövs innan learning kan ge en tydlig riktning.'}
              nextStep={text(learningStatus.nextRecommendedTest?.reason || learningRecommendations[0]?.reason, 'Kör fler replay- och batchtester för att stärka underlaget.')}
            />

            <div className="tos-two-col">
              <SectionCard title="Topplärdom" tone="good">
                <p>{text(learningStatus.topInsight, 'Ingen toppinsikt sparad ännu.')}</p>
              </SectionCard>
              <SectionCard title="Bör testas mer" tone="warning">
                <p>{text(learningStatus.nextRecommendedTest?.title, 'Ingen särskild testidé sparad ännu.')}</p>
                <p className="tos-muted">{text(learningStatus.nextRecommendedTest?.reason, 'Saknas')}</p>
              </SectionCard>
            </div>

            <ListBlock
              title="Learning rekommenderar"
              items={learningRecommendations.slice(0, 5)}
              emptyText="Inga sparade learning-rekommendationer ännu."
              renderItem={(row) => (
                <>
                  <strong>{text(row.title, 'Rekommendation')}</strong>
                  <span>{text(row.reason, 'Saknas')}</span>
                  <span>{text(row.source, 'okänd källa')}</span>
                </>
              )}
            />
          </section>
        ) : null}

        {activeSection === 'strategies' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Strategiforskning</div>
                <h2>Systemet bestämmer vad som ska testas härnäst</h2>
                <p>Strategy Research Manager läser marknadsläge, testresultat och allowlist och föreslår nästa säkra forskningssteg. Den startar inga tester, godkänner inget automatiskt och kan inte handla.</p>
              </div>
              <Badge tone={statusTone(strategyResearch.status)}>{statusLabel(strategyResearch.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Marknadsläge" value={text(marketRegime.regimeLabelSv || marketRegime.regime, 'Saknas')} help="Nuvarande marknadsregim (read-only)." tone="blue" />
              <Metric label="Stagnation" value={strategyResearch.stagnation?.detected ? 'Upptäckt' : 'Nej'} help="Om forskningen står still och behöver mer data." tone={strategyResearch.stagnation?.detected ? 'warning' : 'good'} />
              <Metric label="Paper-redo förslag" value={fmtNumber(first(strategyResearch.paperEligibleCount, Array.isArray(strategyResearch.recommendations) ? paperEligibleRecommendations.length : null))} help="Förslag som redan är godkända för paper-only." tone="good" />
              <Metric label="Kräver godkännande" value={fmtNumber(first(strategyResearch.requiresApprovalCount, Array.isArray(strategyResearch.recommendations) ? approvalRecommendations.length : null))} help="Förslag som behöver din manuella granskning först." tone="warning" />
            </div>

            <MeaningBlock
              meaning="Forskningsplanen är read-only. Den rangordnar vad som vore mest värdefullt att testa härnäst i paper-only, men den kör inget själv."
              missing={strategyResearch.stagnation?.detected ? `Stagnation: ${text(strategyResearch.stagnation?.reason, 'okänd orsak')}.` : 'Forskningen har tillräckligt med kandidater att arbeta med.'}
              nextStep={text(strategyResearch.nextRecommendedAction, 'Fortsätt i paper-only och invänta mer testdata.')}
            />

            <p className="tos-muted">Paper-redo betyder en säker research-kandidat i paper-only. Det betyder INTE live trading, broker eller riktiga order. Om paper-runtime-kopplingen ännu inte är aktiv visas det separat.</p>

            {strategyResearch.topRecommendation ? (
              <SectionCard title="Toppförslag just nu" tone="blue" aside={<Badge tone="blue">{text(strategyResearch.topRecommendation.type, 'förslag')}</Badge>}>
                <p><strong>{supervisorStrategyLabel(strategyResearch.topRecommendation)}</strong></p>
                <p>{text(strategyResearch.topRecommendation.reason, 'Saknas')}</p>
                <div className="tos-safety-line">
                  <Badge tone={strategyResearch.topRecommendation.paperEligible ? 'good' : 'warning'}>{strategyResearch.topRecommendation.paperEligible ? 'Paper-redo' : 'Kräver godkännande'}</Badge>
                  <Badge tone="neutral">prio: {text(strategyResearch.topRecommendation.priority, 'low')}</Badge>
                </div>
              </SectionCard>
            ) : null}

            <div className="tos-two-col">
              <ListBlock
                title="Redo för paper-only"
                items={paperEligibleRecommendations.slice(0, 6)}
                emptyText="Inga förslag är paper-redo ännu. De flesta kräver mer data eller ditt godkännande."
                renderItem={(row) => (
                  <>
                    <strong>{supervisorStrategyLabel(row)}</strong>
                    <span>{text(row.reason, 'Saknas')}</span>
                    <span>paper-runtime: {row.paperRuntimeReady ? 'aktiv (paper-only)' : 'väntar på koppling'}</span>
                  </>
                )}
              />
              <ListBlock
                title="Kräver granskning / mer data"
                items={approvalRecommendations.slice(0, 6)}
                emptyText="Inga förslag väntar på granskning just nu."
                renderItem={(row) => (
                  <>
                    <strong>{supervisorStrategyLabel(row)}</strong>
                    <span>{text(row.blockedReason || row.reason, 'Saknas')}</span>
                    <span>krävs först: {text(arr(row.requiredBeforePaper), 'inget')}</span>
                  </>
                )}
              />
            </div>
          </section>
        ) : null}

        {activeSection === 'risks' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">AI Analyst</div>
                <h2>AI läser testdata men kan inte handla</h2>
                <p>AI Analyst sammanfattar testresultat, pekar ut risker och föreslår nästa säkra test. Den kan inte använda broker eller lägga order.</p>
              </div>
              <Badge tone={statusTone(aiStatus.readiness || aiStatus.status)}>{statusLabel(aiStatus.readiness || aiStatus.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="AI-status" value={text(aiStatus.message, 'Saknas')} help="Visar om AI Analyst är redo i read-only-läge." tone={statusTone(aiStatus.readiness || aiStatus.status)} />
              <Metric label="Model" value={text(aiStatus.model, 'Saknas')} help="Visas bara som metadata. Ingen trading sker." tone="blue" />
              <Metric label="Senaste AI-status" value={statusLabel(aiStatus.latestStatus || aiStatus.status)} help="Status från sparad latest.json om filen finns." tone={statusTone(aiStatus.latestStatus || aiStatus.status)} />
              <Metric label="Senaste AI-tid" value={timeText(latestAiTimestamp)} help="Timestamp från overview.aiAnalystStatus eller latest.json." tone={latestAiTimestamp ? 'good' : 'warning'} />
              <Metric label="AI output" value={text(aiStatus.latestOutputSummary, 'Saknas')} help="Senaste overview-sammanfattning från AI Analyst när den finns." tone={aiStatus.latestOutputSummary ? 'blue' : 'warning'} />
              <Metric label="Risker" value={hasOverviewRisks ? fmtNumber(overviewRisks.length) : '—'} help="Risker i Trading OS översikten." tone={hasOverviewRisks ? (overviewRisks.length ? 'warning' : 'good') : 'neutral'} />
            </div>

            <MeaningBlock
              meaning="AI Analyst använder testdata som indata och hjälper till att formulera nästa test. Den kan inte handla och ska aldrig styra broker eller orderflöden."
              missing={latestAiOutput
                ? (aiEnvironmentNote || 'AI-text finns sparad, men fler färska batch/replay-resultat ger bättre sammanfattningar.')
                : 'Ingen sparad AI-text ännu. Systemet behöver mer färska testresultat eller en ny analyst-körning.'}
              nextStep={text(nextRecommendedActions[0]?.reason, 'Uppdatera AI efter nästa replay eller batch och jämför mot learning.')}
            />

            <SectionCard title="Senaste AI-sammanfattning" tone="purple" aside={<Badge tone="purple">{latestAiTimestamp ? timeText(latestAiTimestamp) : 'AI kan inte handla'}</Badge>}>
              <p>{text(latestAiOutput, learningStatus.topInsight || 'Ingen AI-sammanfattning sparad ännu.')}</p>
              {aiEnvironmentNote ? <p className="tos-muted">{aiEnvironmentNote}</p> : null}
            </SectionCard>

            <div className="tos-two-col">
              <SectionCard title="Datakällor AI läser" tone="neutral">
                <div className="tos-safety-line">
                  <Badge tone="blue">replay</Badge>
                  <Badge tone="blue">batch</Badge>
                  <Badge tone="blue">learning</Badge>
                  <Badge tone="blue">overview</Badge>
                </div>
                <p className="tos-muted">AI läser bara test- och sammanfattningsdata. Ingen brokerkoppling används.</p>
              </SectionCard>
              <SectionCard title="Risker att lyfta" tone="warning">
                {!hasOverviewRisks ? (
                  <p className="tos-empty">Riskfältet saknas i Trading OS-översikten.</p>
                ) : overviewRisks.length ? (
                  <div className="tos-list">
                    {overviewRisks.slice(0, 4).map((risk, index) => (
                      <div key={`${text(risk.code, 'risk')}-${index}`} className="tos-list-row">
                        <strong>{text(risk.level, 'risk')}</strong>
                        <span>{text(risk.message_sv, 'Saknas')}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="tos-empty">Inga särskilda risker i den här vyn just nu.</p>
                )}
              </SectionCard>
            </div>
          </section>
        ) : null}

        {activeSection === 'safety' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Paper Trading</div>
                <h2>Sista säkra teststeget innan något jämförs vidare</h2>
                <p>Paper Trading använder inga riktiga pengar. Här syns allowlist, godkända strategier, blockerade strategier och varför paper inte körs.</p>
              </div>
              <Badge tone={statusTone(paperStatus.status)}>{statusLabel(paperStatus.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Paper trades" value={fmtNumber(paperTradeCount)} help="Sparade låtsasaffärer." tone="blue" />
              <Metric label="Allowlist-status" value={allowlist ? 'Läst' : 'Saknas'} help="Read-only lista över godkända strategier." tone={allowlist ? 'good' : 'warning'} />
              <Metric label="Godkända strategier" value={fmtNumber(first(allowlist?.totalApproved, paperAllowlist.totalApproved))} help="Godkända som paper-only research-kandidater. Betyder inte live trading eller broker." tone="good" />
              <Metric label="Redo i paper-runtime" value={fmtNumber(first(allowlist?.readyForPaperRuntime, paperAllowlist.readyForPaperRuntime))} help="Antal vars paper-simulations-runtime är aktiv (paper-only, ingen broker)." tone="good" />
              <Metric label="Väntar på runtime" value={fmtNumber(first(allowlist?.pendingRuntimeConnection, paperAllowlist.pendingRuntimeConnection))} help="Godkända men paper-runtime-kopplingen är ännu inte aktiv." tone="warning" />
            </div>

            <p className="tos-muted">Paper-redo = en säker research-kandidat i paper-only. Det betyder INTE live trading, broker eller riktiga order.</p>

            <MeaningBlock
              meaning="Paper är ett säkert sista steg där strategier kan följas i en låtsasmiljö. Inga riktiga order eller pengar används."
              missing={paperTradeCount !== null && paperTradeCount > 0 ? 'Det finns paperutfall att analysera, men allowlist och runtime-koppling måste fortfarande vara tydlig.' : text(paperStatus.message, 'Inga paper trades finns ännu.')}
              nextStep={text(automationPlan?.nextSafeStep, 'Nästa säkra steg är att välja en strategi manuellt för ett paper-only replay efter egen granskning.')}
            />

            <div className="tos-two-col">
              <ListBlock
                title="Godkända strategier"
                items={approvedStrategies}
                emptyText="Inga godkända strategier i allowlist ännu."
                renderItem={(row) => (
                  <>
                    <strong>{text(row.name || row.id, 'Strategi')}</strong>
                    <span>{row.readyForPaperRuntime ? 'Paper-simulationens runtime är aktiv (paper-only)' : 'Godkänd för paper-only, runtime-koppling väntar'}</span>
                    <span>{text(row.automaticStatus, 'okänd status')}</span>
                  </>
                )}
              />
              <ListBlock
                title="Blockerade strategier"
                items={arr(automationPlan?.blockedStrategies)}
                emptyText="Ingen strategi är blockerad i den här vyn."
                renderItem={(row) => (
                  <>
                    <strong>{text(row.name || row.id, 'Strategi')}</strong>
                    <span>{text(row.reason, 'Saknas')}</span>
                  </>
                )}
              />
            </div>

            <SectionCard title="Varför paper inte körs" tone="warning" aside={<Badge tone="warning">safety först</Badge>}>
              <div className="tos-list">
                <div className="tos-list-row">
                  <strong>Broker</strong>
                  <span>Avstängd. Ingen extern orderväg får användas.</span>
                </div>
                <div className="tos-list-row">
                  <strong>Livehandel</strong>
                  <span>Avstängd. Trading OS är en testplattform, inte ett auto-trading-system.</span>
                </div>
                <div className="tos-list-row">
                  <strong>Riktiga order</strong>
                  <span>Förbjudet. Endast paper_only, dry_run eller disabled.</span>
                </div>
              </div>
            </SectionCard>
          </section>
        ) : null}

        {activeSection === 'teknik' ? (
          <section className="tos-section">
            <div className="tos-section-head">
              <div>
                <div className="tos-eyebrow">Teknik</div>
                <h2>Teknisk metadata längst ner</h2>
                <p>Den här sektionen samlar cache age, source markers, block status, degraded/missing och rå debug längst ner i sidan.</p>
              </div>
              <Badge tone={statusTone(technical.status)}>{statusLabel(technical.status)}</Badge>
            </div>

            <div className="tos-metrics-grid">
              <Metric label="Cache age" value={fmtNumber(first(overview.cacheAgeMs, technical.cacheAgeMs))} help="Millisekunder från overview-cache." tone="blue" />
              <Metric label="Block total" value={fmtNumber(technical.counts?.total)} help="Antal block i overview." tone="blue" />
              <Metric label="Degraded" value={fmtNumber(technical.counts?.degraded)} help="Block som bara svarade delvis." tone={number(technical.counts?.degraded, null) === null ? 'blue' : number(technical.counts?.degraded, null) > 0 ? 'warning' : 'good'} />
              <Metric label="Errors" value={fmtNumber(technical.counts?.error)} help="Block som kastade fel i overview." tone={number(technical.counts?.error, null) === null ? 'blue' : number(technical.counts?.error, null) > 0 ? 'danger' : 'good'} />
            </div>

            <MeaningBlock
              meaning="Teknikvyn är till för felsökning när ett block saknas eller bara delvis svarar."
              missing={arr(technical.warnings).length ? technical.warnings.join(' ') : 'Inga extra varningar just nu.'}
              nextStep="Om ett block är degraded eller missing: börja med källmarkören, kontrollera read-only endpointen och jämför sedan med overview."
            />

            <div className="tos-two-col">
              <ListBlock
                title="Source markers"
                items={Object.entries(technical.sourceMarkers || {}).slice(0, 10).map(([key, value]) => ({ key, ...value }))}
                emptyText="Inga source markers exponerade ännu."
                renderItem={(row) => (
                  <>
                    <strong>{row.key}</strong>
                    <span>{text(row.status, 'Saknas')}</span>
                    <span>{text(row.source, 'okänd källa')}</span>
                  </>
                )}
              />
              <ListBlock
                title="Block status"
                items={arr(technical.overviewBlocks).slice(0, 12)}
                emptyText="Inga blockstatusar exponerade ännu."
                renderItem={(row) => (
                  <>
                    <strong>{text(row.key, 'Block')}</strong>
                    <span>{text(row.status, 'Saknas')}</span>
                    <span>{text(row.source, 'okänd källa')}</span>
                  </>
                )}
              />
            </div>

            <details className="tos-debug">
              <summary>Visa raw debug</summary>
              <pre>{JSON.stringify({
                technical,
                actionPlan,
                nextRecommendedActions,
                safety: overviewSafety(overview),
              }, null, 2)}</pre>
            </details>
          </section>
        ) : null}

        <footer className="tos-footer">
          <div className="tos-footer-links">
            <Link to="/lab">Öppna Research/Lab</Link>
            <Link to="/lab?tab=replay">Öppna Historik</Link>
            <Link to="/system?tab=safety">Öppna Safety</Link>
          </div>
          <div className="tos-footer-copy">
            Trading OS kör endast read-only, paper_only och testautomation. Ingen broker, inga riktiga order, ingen livehandel.
          </div>
        </footer>
      </main>
    </div>
    </DashboardShell>
  );
}
