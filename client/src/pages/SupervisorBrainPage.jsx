import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import GlossaryTooltip from '../components/tradingos/GlossaryTooltip.jsx';

const REFRESH_MS = 15000;
const SUPERVISOR_SECTIONS = [
  { id: 'overview', label: 'Overview', path: '/supervisor/overview' },
  { id: 'live', label: 'Live', path: '/supervisor/live' },
  { id: 'history', label: 'History', path: '/supervisor/history' },
  { id: 'strategies', label: 'Strategies', path: '/supervisor/strategies' },
  { id: 'batches', label: 'Batch tests', path: '/supervisor/batches' },
  { id: 'replay', label: 'Replay tests', path: '/supervisor/replay' },
  { id: 'paper', label: 'Paper', path: '/supervisor/paper' },
  { id: 'data', label: 'Data', path: '/supervisor/data' },
  { id: 'ai', label: 'AI Analyst', path: '/supervisor/ai' },
  { id: 'risks', label: 'Risks', path: '/supervisor/risks' },
  { id: 'technical', label: 'Technical', path: '/supervisor/technical' },
];
const SUPERVISOR_SECTION_IDS = new Set(SUPERVISOR_SECTIONS.map((section) => section.id));

const STRATEGY_META = {
  narrow_breakout_v1: {
    name: 'Breakout after compression',
    description: 'Tests whether price breaks up or down after a compressed regime.',
    tone: 'green',
  },
  narrow_fakeout_reversal_v1: {
    name: 'Fakeout reversal',
    description: 'Tests whether price briefly escapes the range and then reverses back.',
    tone: 'amber',
  },
  narrow_vwap_mean_reversion_v1: {
    name: 'VWAP mean reversion',
    description: 'Tests whether price reverts toward VWAP when the market is compressed.',
    tone: 'blue',
  },
};

const BAND_LABELS = {
  not_narrow: 'Not a valid narrow test',
  weak_narrow: 'Weak narrow',
  confirmed_narrow: 'Confirmed narrow',
  strong_compression: 'Strong compression',
};

const BAND_TONES = {
  not_narrow: 'muted',
  weak_narrow: 'warning',
  confirmed_narrow: 'good',
  strong_compression: 'purple',
};

const CONFIDENCE_LABELS = { none: 'None', low: 'Low', medium: 'Medium', high: 'High' };
const LEARNING_STATUS_LABELS = {
  needs_more_data: 'More data needed',
  low_confidence: 'Low confidence',
  ready: 'Ready',
};

const TERMS = [
  ['Narrow State', 'The market is compressed and quiet. The system looks for compression before a follow-up move.'],
  ['Breakout', 'Price breaks out of a compressed range.'],
  ['Fakeout', 'Price appears to break out and then quickly reverses back.'],
  ['VWAP', 'A volume-weighted reference price used as a market anchor.'],
  ['Replay', 'A historical simulation to see how something would have behaved earlier.'],
  ['Batch', 'Many research combinations are compared in a safe test flow.'],
  ['Paper', 'Test mode with no real orders and no real money.'],
  ['Confidence', 'How strongly the system trusts the current conclusion.'],
];

const PLACEHOLDER_APIS = {
  live: ['/api/status/live-activity'],
  history: ['/api/status/live-activity'],
  batches: ['/api/status/batches', '/api/status/batch-autopilot'],
  replay: ['/api/status/replay', '/api/status/replay-autopilot'],
  paper: ['/api/status/paper-trading'],
  data: ['/api/status/data-jobs'],
  ai: ['/api/ai/analyst/status', '/api/ai/analyst/latest'],
  risks: ['/api/automation/plan', '/api/automation/approvals'],
  technical: ['/api/strategies/runtime-matrix'],
};

function tabFromPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'supervisor') return { active: 'overview', unknown: false };
  const section = parts[1] || 'overview';
  if (SUPERVISOR_SECTION_IDS.has(section)) return { active: section, unknown: false };
  return { active: 'overview', unknown: parts.length > 1 };
}

function apiJson(url) {
  return fetch(url, { credentials: 'same-origin' }).then(async (res) => {
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(data?.error || `API ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  });
}

function useSupervisorData() {
  const [state, setState] = useState({
    narrow: null,
    learning: null,
    autopilot: null,
    loading: true,
    refreshing: false,
    error: '',
    lastUpdated: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!cancelled) {
        setState((prev) => ({
          ...prev,
          loading: prev.lastUpdated ? prev.loading : true,
          refreshing: !!prev.lastUpdated,
          error: '',
        }));
      }
      try {
        const [narrow, learning, autopilot] = await Promise.all([
          apiJson('/api/supervisor/narrow-state'),
          apiJson('/api/learning/narrow-performance'),
          apiJson('/api/autopilot/narrow/status').catch(() => null),
        ]);
        if (cancelled) return;
        setState({
          narrow,
          learning,
          autopilot,
          loading: false,
          refreshing: false,
          error: '',
          lastUpdated: new Date().toISOString(),
        });
      } catch (error) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          refreshing: false,
          error: error?.message || 'Unable to load Supervisor data right now.',
          lastUpdated: prev.lastUpdated || new Date().toISOString(),
        }));
      }
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

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function text(value, fallback = 'More data needed') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((item) => text(item, '')).filter(Boolean).join(' · ') || fallback;
  if (typeof value === 'object') {
    return text(
      value.label ?? value.name ?? value.title ?? value.symbol ?? value.message ?? value.summary ?? value.text ?? value.value,
      fallback,
    );
  }
  return fallback;
}

function nowText(iso) {
  if (!iso) return 'missing';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'missing';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatInt(value, fallback = '0') {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : fallback;
}

function formatPct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

function formatSignedPct(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function toneForStatus(status) {
  if (status === 'ready' || status === 'promising') return 'good';
  if (status === 'weak') return 'danger';
  if (status === 'needs_more_data' || status === 'testing' || status === 'low_confidence') return 'warning';
  return 'neutral';
}

function Badge({ tone = 'neutral', children }) {
  return <span className={`sup-brain-badge sup-brain-badge-${tone}`}>{children}</span>;
}

function Card({ className = '', children }) {
  return <article className={`sup-brain-card ${className}`.trim()}>{children}</article>;
}

function SectionTitle({ eyebrow, title, subtitle, helper }) {
  return (
    <div className="sup-brain-section-head">
      <div>
        {eyebrow ? <div className="sup-brain-eyebrow">{eyebrow}</div> : null}
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {helper ? <div className="sup-brain-helper-chip">{helper}</div> : null}
    </div>
  );
}

function StatCard({ icon, title, value, subtitle, detail, tone = 'neutral' }) {
  return (
    <Card className={`sup-brain-stat sup-brain-stat-${tone}`}>
      <div className="sup-brain-stat-head">
        <div className="sup-brain-icon" aria-hidden="true">{icon}</div>
        <div>
          <div className="sup-brain-stat-title">{title}</div>
          <div className="sup-brain-stat-subtitle">{subtitle}</div>
        </div>
      </div>
      <div className="sup-brain-stat-value">{value}</div>
      {detail ? <div className="sup-brain-stat-detail">{detail}</div> : null}
    </Card>
  );
}

function InfoChip({ label, value, tone = 'neutral' }) {
  return (
    <div className={`sup-brain-chip sup-brain-chip-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BeginnerBox({ title, text: body }) {
  return (
    <details className="sup-brain-details">
      <summary>{title}</summary>
      <p>{body}</p>
    </details>
  );
}

function StrategyCard({ strategyId, row, summaryStatus }) {
  const meta = STRATEGY_META[strategyId] || {
    name: strategyId,
    description: 'Tests Narrow State behavior in safe research mode.',
    tone: 'neutral',
  };
  const trades = Number(row?.trades ?? 0) || 0;
  const winRate = Number.isFinite(Number(row?.winRate)) ? Number(row.winRate) : Number(row?.win_rate);
  const avgPnl = Number.isFinite(Number(row?.avgPnl)) ? Number(row.avgPnl) : Number(row?.avg_pnl);
  const confidence = row?.confidence || (trades >= 30 ? 'high' : trades >= 10 ? 'medium' : trades >= 1 ? 'low' : 'none');
  const status = row?.verdict === 'promising'
    ? 'promising'
    : row?.verdict === 'weak'
      ? 'weak'
      : trades === 0
        ? 'needs_more_data'
        : summaryStatus === 'ready' && trades >= 25
          ? 'testing'
          : 'testing';
  const tone = toneForStatus(status);

  return (
    <Card className={`sup-brain-strategy sup-brain-strategy-${meta.tone}`}>
      <div className="sup-brain-strategy-head">
        <div>
          <div className="sup-brain-strategy-name">{meta.name}</div>
          <div className="sup-brain-strategy-id">{strategyId}</div>
        </div>
        <Badge tone={tone}>{LEARNING_STATUS_LABELS[status] || status}</Badge>
      </div>
      <p className="sup-brain-strategy-desc">{meta.description}</p>
      <div className="sup-brain-card-stats">
        <InfoChip label="Research results" value={trades ? formatInt(trades) : 'More data needed'} tone={tone} />
        <InfoChip label="Win rate" value={Number.isFinite(winRate) ? formatPct(winRate, 1) : '—'} tone={Number.isFinite(winRate) && winRate >= 55 ? 'good' : 'neutral'} />
        <InfoChip label="Avg result" value={Number.isFinite(avgPnl) ? formatSignedPct(avgPnl, 3) : '—'} tone={Number.isFinite(avgPnl) && avgPnl >= 0 ? 'good' : 'warning'} />
        <InfoChip label="Confidence" value={CONFIDENCE_LABELS[confidence] || confidence} tone={confidence === 'high' ? 'good' : confidence === 'medium' ? 'blue' : confidence === 'low' ? 'warning' : 'neutral'} />
      </div>
    </Card>
  );
}

function SummaryCard({ title, item, emptyText }) {
  if (!item) {
    return (
      <Card className="sup-brain-summary-card sup-brain-summary-card-empty">
        <div className="sup-brain-summary-title">{title}</div>
        <div className="sup-brain-summary-empty">{emptyText}</div>
      </Card>
    );
  }

  return (
    <Card className="sup-brain-summary-card">
      <div className="sup-brain-summary-title">{title}</div>
      <div className="sup-brain-summary-main">{text(item.name || item.strategy_id || item.title, 'No strong conclusion yet')}</div>
      <div className="sup-brain-summary-sub">{text(item.reason || item.message || item.description, 'More data needed')}</div>
      <div className="sup-brain-card-stats">
        {item.trades != null ? <InfoChip label="Research results" value={formatInt(item.trades)} tone="blue" /> : null}
        {item.winRate != null || item.win_rate != null ? <InfoChip label="Win rate" value={formatPct(firstNonEmpty(item.winRate, item.win_rate), 1)} tone="good" /> : null}
        {item.avgPnl != null || item.avg_pnl != null ? <InfoChip label="Avg result" value={formatSignedPct(firstNonEmpty(item.avgPnl, item.avg_pnl), 3)} tone="blue" /> : null}
      </div>
    </Card>
  );
}

function BandRow({ band, data, maxTrades }) {
  const width = maxTrades > 0 ? Math.max(6, Math.round(((data?.trades || 0) / maxTrades) * 100)) : 8;
  const tone = BAND_TONES[band] || 'neutral';
  const recommendationText = band === 'not_narrow'
    ? 'Baseline only'
    : text(data?.recommendation, 'More data needed');
  const recommendationTone = band === 'not_narrow' ? 'neutral' : tone;

  return (
    <div className={`sup-brain-band sup-brain-band-${tone}`}>
      <div className="sup-brain-band-top">
        <div>
          <div className="sup-brain-band-title">{BAND_LABELS[band] || band}</div>
          <div className="sup-brain-band-range">
            {band === 'not_narrow' ? '0–39' : band === 'weak_narrow' ? '40–59' : band === 'confirmed_narrow' ? '60–79' : '80–100'}
          </div>
        </div>
        <Badge tone={recommendationTone}>{recommendationText}</Badge>
      </div>
      <div className="sup-brain-band-bar" aria-hidden="true">
        <span style={{ width: `${width}%` }} />
      </div>
      <div className="sup-brain-band-stats">
        <InfoChip label="Research results" value={formatInt(data?.trades || 0)} tone={tone === 'good' ? 'good' : tone === 'purple' ? 'blue' : tone} />
        <InfoChip label="Win rate" value={data?.winRate != null ? formatPct(data.winRate, 1) : '—'} tone={tone === 'good' ? 'good' : 'neutral'} />
        <InfoChip label="Avg result" value={data?.avgPnl != null ? formatSignedPct(data.avgPnl, 3) : '—'} tone={tone === 'good' ? 'good' : 'warning'} />
      </div>
      {band === 'not_narrow' ? (
        <div className="sup-brain-band-reco">
          Baseline only. The system must not select this as a Narrow test.
        </div>
      ) : null}
    </div>
  );
}

function ConfirmationCard({ confirmation, data }) {
  const impactTone = data?.impact === 'positive' ? 'good' : data?.impact === 'negative' ? 'danger' : data?.impact === 'neutral' ? 'blue' : 'warning';
  const withCount = data?.withConfirmation?.trades ?? data?.with?.trades ?? 0;
  const withoutCount = data?.withoutConfirmation?.trades ?? data?.without?.trades ?? 0;
  const withWin = data?.withConfirmation?.winRate ?? data?.with?.winRate ?? null;
  const withoutWin = data?.withoutConfirmation?.winRate ?? data?.without?.winRate ?? null;
  const withPnl = data?.withConfirmation?.avgPnl ?? data?.with?.avgPnl ?? null;
  const withoutPnl = data?.withoutConfirmation?.avgPnl ?? data?.without?.avgPnl ?? null;

  return (
    <Card className={`sup-brain-confirmation sup-brain-confirmation-${impactTone}`}>
      <div className="sup-brain-confirmation-head">
        <div className="sup-brain-confirmation-name">{confirmation.toUpperCase()}</div>
        <Badge tone={impactTone}>{data?.impact || 'insufficient_data'}</Badge>
      </div>
      <div className="sup-brain-confirmation-grid">
        <div>
          <span>With confirmation</span>
          <strong>{withCount ? `${formatInt(withCount)} results` : 'More data needed'}</strong>
          <small>{withWin != null ? `${formatPct(withWin, 1)} · ${formatSignedPct(withPnl, 3)}` : 'No clear conclusion yet'}</small>
        </div>
        <div>
          <span>Without confirmation</span>
          <strong>{withoutCount ? `${formatInt(withoutCount)} results` : 'More data needed'}</strong>
          <small>{withoutWin != null ? `${formatPct(withoutWin, 1)} · ${formatSignedPct(withoutPnl, 3)}` : 'No clear conclusion yet'}</small>
        </div>
      </div>
    </Card>
  );
}

function StepCard({ index, title, text: body }) {
  return (
    <Card className="sup-brain-step">
      <div className="sup-brain-step-index">{index}</div>
      <div className="sup-brain-step-title">{title}</div>
      <div className="sup-brain-step-body">{body}</div>
    </Card>
  );
}

function ReadOnlyPlaceholder({ title, apis }) {
  return (
    <section className="sup-brain-section">
      <SectionTitle
        eyebrow="Read-only view"
        title={title}
        subtitle="This section belongs to the older Research Lab layout, but its production data source has not been connected yet."
        helper="No actions available"
      />
      <div className="sup-brain-placeholder-grid">
        <Card className="sup-brain-placeholder-card">
          <div className="sup-brain-summary-title">Status</div>
          <div className="sup-brain-summary-main">Read-only / data not connected yet</div>
          <div className="sup-brain-summary-sub">No actions can be performed from this view.</div>
          <div className="sup-brain-card-stats">
            <InfoChip label="Mode" value="PAPER ONLY" tone="good" />
            <InfoChip label="Live trading" value="Off" tone="good" />
            <InfoChip label="Real orders" value="Blocked" tone="good" />
          </div>
        </Card>
        <Card className="sup-brain-placeholder-card">
          <div className="sup-brain-summary-title">Expected data source</div>
          {apis.length ? (
            <ul className="sup-brain-api-list">
              {apis.map((api) => <li key={api}>{api}</li>)}
            </ul>
          ) : (
            <div className="sup-brain-summary-empty">No production API has been assigned to this view yet.</div>
          )}
        </Card>
      </div>
    </section>
  );
}

export default function SupervisorBrainPage() {
  const location = useLocation();
  const { active: activeSection, unknown: unknownSection } = useMemo(() => tabFromPath(location.pathname), [location.pathname]);
  const { narrow, learning, autopilot, loading, refreshing, error, lastUpdated } = useSupervisorData();

  const narrowState = narrow?.narrowState || {};
  const narrowFlags = {
    actions_allowed: narrow?.actions_allowed ?? learning?.actions_allowed ?? false,
    can_place_orders: narrow?.can_place_orders ?? learning?.can_place_orders ?? false,
    live_trading_enabled: narrow?.live_trading_enabled ?? learning?.live_trading_enabled ?? false,
    broker_enabled: narrow?.broker_enabled ?? learning?.broker_enabled ?? false,
  };
  const safetyIsLocked = Object.values(narrowFlags).every((value) => value === false);

  const narrowTopSymbols = safeArray(narrowState.topSymbols);
  const breakoutWatch = safeArray(narrowState.breakoutWatch);
  const fakeoutRisk = safeArray(narrowState.fakeoutRisk);
  const meanReversion = safeArray(narrowState.meanReversion);

  const learningSummary = learning?.summary || {};
  const rankings = safeArray(learning?.rankings);
  const scoreBands = safeArray(learning?.scoreBands);
  const confirmations = safeArray(learning?.confirmations);
  const learningStatus = learningSummary.status || narrowState.status || 'needs_more_data';
  const dataConfidence = learningSummary.dataConfidence || narrowState.dataConfidence || 'none';
  const learningMessage = learningSummary.message || narrowState.message || 'The system still needs more Narrow State data before it can make stable conclusions.';
  const performanceBest = learningSummary.bestStrategy || narrowState.bestStrategy || null;
  const performanceWorst = learningSummary.worstStrategy || narrowState.worstStrategy || null;
  const totalTrades = Number(learningSummary.totalTrades ?? narrowState.totalTrades ?? 0) || 0;
  const strategiesCompared = Number(learningSummary.strategiesCompared ?? rankings.length ?? 0) || 0;
  const generatedAt = firstNonEmpty(learning?.generatedAt, narrow?.generated_at);

  const autopilotScheduler = autopilot?.scheduler || null;
  const researchQueueAvailable = autopilotScheduler?.queueAvailable === true;
  const researchQueueEnabled = autopilotScheduler?.queueEnabled === true;
  const researchQueueExecutionEnabled = autopilotScheduler?.queueExecutionEnabled === true;
  const researchExecutionEnabled = autopilotScheduler?.executionEnabled === true;
  const researchDryRunOnly = autopilotScheduler?.dryRunOnly !== false;
  const researchPaperOnly = autopilot?.mode === 'paper_only' || autopilotScheduler?.mode === 'paper_only';
  const researchBlockedReason = text(autopilotScheduler?.lastBlockedReason, 'missing');
  const researchStatusTitle = researchExecutionEnabled ? 'Research execution active' : 'Automatic execution is off';
  const researchStatusText = researchExecutionEnabled
    ? 'The system can still run research only in paper_only mode. No real orders can be sent.'
    : 'The system can plan the next research test, but automatic execution is disabled.';

  const activeSymbols = Number(narrowState.activeCount ?? narrowTopSymbols.length ?? 0) || 0;
  const strongestCompression = narrowState.strongestCompression || null;

  const controlCards = useMemo(() => ([
    {
      icon: '🔌',
      title: 'Backend',
      value: narrow || learning ? 'Connected' : 'Waiting',
      subtitle: 'Read-only API status',
      detail: 'Production data is readable.',
      tone: narrow || learning ? 'good' : 'warning',
    },
    {
      icon: '📡',
      title: 'Scanner',
      value: activeSymbols > 0 ? 'Active' : 'Waiting',
      subtitle: 'Market scanning in research mode',
      detail: `${formatInt(activeSymbols, '0')} symbols currently in Narrow State.`,
      tone: activeSymbols > 0 ? 'blue' : 'warning',
    },
    {
      icon: '🧠',
      title: 'Learning Engine',
      value: learningStatus === 'ready' ? 'Active' : 'Learning',
      subtitle: 'Reads replay, batch, and paper outcomes',
      detail: `${formatInt(totalTrades, '0')} results · ${formatInt(strategiesCompared, '0')} strategies`,
      tone: totalTrades > 0 ? 'good' : 'warning',
    },
    {
      icon: '🛡️',
      title: 'Safety',
      value: safetyIsLocked ? 'Locked' : 'Check',
      subtitle: 'actions_allowed=false · can_place_orders=false',
      detail: 'Live trading is blocked and cannot be enabled here.',
      tone: safetyIsLocked ? 'good' : 'danger',
    },
  ]), [activeSymbols, learningStatus, narrow, learning, safetyIsLocked, strategiesCompared, totalTrades]);

  const strategyRows = useMemo(() => ([
    { id: 'narrow_breakout_v1', row: rankings.find((item) => item.strategy_id === 'narrow_breakout_v1') },
    { id: 'narrow_fakeout_reversal_v1', row: rankings.find((item) => item.strategy_id === 'narrow_fakeout_reversal_v1') },
    { id: 'narrow_vwap_mean_reversion_v1', row: rankings.find((item) => item.strategy_id === 'narrow_vwap_mean_reversion_v1') },
  ]), [rankings]);

  const recommendation = useMemo(() => {
    const rec = learning?.recommendedNextTest || learningSummary.recommendedNextTest || narrowState.recommendedNextTest;
    if (!rec) return null;
    return {
      title: rec.title || 'Next suggested test',
      reason: rec.reason || rec.message || 'A safe follow-up research test is recommended.',
      strategy: rec.strategy_id || rec.strategyId || rec.title || 'Unknown',
      source: rec.source ? String(rec.source).toUpperCase() : 'PAPER',
      priority: rec.priority || 'low',
    };
  }, [learning, learningSummary.recommendedNextTest, narrowState.recommendedNextTest]);

  const warningItems = useMemo(() => {
    const items = [
      'Some conclusions still need more test data even after the first narrow batch.',
      '2m is used because 5m and 15m are not fully available in this production data set yet.',
      'All results shown here come from paper, replay, or batch research.',
      'Live trading is off and cannot be enabled from this screen.',
    ];
    if (learningMessage && !items.includes(learningMessage)) items.unshift(learningMessage);
    if (error && !items.includes(error)) items.unshift(error);
    return items.slice(0, 6);
  }, [error, learningMessage]);

  const hasFirstBatch = totalTrades > 0 && learningStatus !== 'ready';
  const learningHeadline = learningStatus === 'ready'
    ? 'The system is starting to identify which Narrow strategies look strongest.'
    : hasFirstBatch
      ? 'The first batch test is complete, but this is not proven edge.'
      : 'More data is needed.';
  const firstBatchNote = hasFirstBatch
    ? 'The first batch test is complete. Confidence applies to this sample only, not to proven trading edge.'
    : null;
  const maxBandTrades = Math.max(1, ...scoreBands.map((band) => Number(band?.trades) || 0));
  const mobileSafetyText = 'Read-only analysis mode · No real orders · Paper / Replay / Batch only';

  if (loading && !narrow && !learning) {
    return (
      <div className="sup-brain-page">
        <div className="sup-brain-shell">
          <div className="sup-brain-loading">Loading Supervisor…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="sup-brain-page">
      <div className="sup-brain-shell sup-brain-shell-lab">
        <header className="sup-brain-hero">
          <div className="sup-brain-hero-copy">
            <div className="sup-brain-kicker">Trading OS Research Lab</div>
            <h1>Unified Supervisor</h1>
            <p>A read-only research workspace for system health, learning status, and next-test planning.</p>
            <div className="sup-brain-hero-sub">
              <span className="sup-brain-hero-note">Research Lab / Unified Supervisor</span>
              <span className="sup-brain-hero-note sup-brain-hero-note-soft">Learning Engine · Not live trading</span>
            </div>
          </div>

          <aside className="sup-brain-safety-rail">
            <div className="sup-brain-safety-sticky">
              <div className="sup-brain-safety-tags">
                <Badge tone="good">PAPER ONLY</Badge>
                <Badge tone="blue">LIVE TRADING OFF</Badge>
                <Badge tone="neutral">REAL ORDERS BLOCKED</Badge>
              </div>
              <div className="sup-brain-safety-banner">{mobileSafetyText}</div>
              <div className="sup-brain-safety-flags">
                <span>actions_allowed={String(narrowFlags.actions_allowed)}</span>
                <span>can_place_orders={String(narrowFlags.can_place_orders)}</span>
                <span>live_trading_enabled={String(narrowFlags.live_trading_enabled)}</span>
                <span>broker_enabled={String(narrowFlags.broker_enabled)}</span>
              </div>
              <div className="sup-brain-meta">
                <span>Last updated: {nowText(lastUpdated || generatedAt)}</span>
                {refreshing ? <span>Refreshing…</span> : <span>Auto refresh active</span>}
              </div>
            </div>
          </aside>
        </header>

        <section className="sup-brain-section sup-brain-section-nav">
          <div className="sup-brain-nav-head">
            <div>
              <div className="sup-brain-eyebrow">Research navigation</div>
              <h2>Read-only sections</h2>
              <p>Supervisor is split into safe read-only views. You can inspect the system here, but you cannot start trading or change risk.</p>
            </div>
          </div>
          <div className="sup-brain-nav-layout">
            <nav className="sup-brain-nav-tabs" aria-label="Supervisor sections">
              {SUPERVISOR_SECTIONS.map((section) => (
                <Link
                  key={section.id}
                  to={section.path}
                  className={`sup-brain-nav-tab${activeSection === section.id ? ' active' : ''}`}
                >
                  <span className="sup-brain-nav-tab-label">{section.label}</span>
                </Link>
              ))}
            </nav>
            <div className="sup-brain-nav-copy">
              <Badge tone="good">READ-ONLY</Badge>
              <span>Review system state, research safety, and planning context without any execution controls.</span>
            </div>
          </div>
          {unknownSection ? <div className="sup-brain-banner">Unknown supervisor view. Showing Overview.</div> : null}
        </section>

        {activeSection === 'overview' ? (
          <>
            <section className="sup-brain-section sup-brain-section-safety">
              <SectionTitle
                eyebrow="1. System health"
                title="Is the research system healthy?"
                subtitle="Four fast status cards that show whether production data is being read safely."
                helper="Read-only status"
              />
              <div className="sup-brain-grid sup-brain-grid-4">
                {controlCards.map((card) => <StatCard key={card.title} {...card} />)}
              </div>
              <div className="sup-brain-banner">
                The system can analyze, replay-test, batch-test, and paper-test, but it cannot place real orders.
              </div>
              <BeginnerBox
                title="What does this mean?"
                text="Connected means production data can be read. Active means the system currently has something to analyze. Safety locked means live trading is blocked and no real orders can be sent."
              />
            </section>

            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="2. Learning summary"
                title="What the learning engine sees"
                subtitle="These are research results from replay, batch, and paper test flows only."
                helper={`Confidence: ${CONFIDENCE_LABELS[dataConfidence] || dataConfidence}`}
              />
              <div className="sup-brain-learning-card">
                <div className="sup-brain-learning-top">
                  <div>
                    <div className="sup-brain-learning-status">{LEARNING_STATUS_LABELS[learningStatus] || learningStatus}</div>
                    <h3>{learningHeadline}</h3>
                  </div>
                  <Badge tone={toneForStatus(learningStatus)}>{CONFIDENCE_LABELS[dataConfidence] || dataConfidence}</Badge>
                </div>
                <p className="sup-brain-learning-text">{learningMessage}</p>
                {firstBatchNote ? <div className="sup-brain-banner">{firstBatchNote}</div> : null}
                <div className="sup-brain-card-stats">
                  <InfoChip label="Research results" value={formatInt(totalTrades, '0')} tone="blue" />
                  <InfoChip label="Strategies compared" value={formatInt(strategiesCompared, '0')} tone="blue" />
                  <InfoChip label="Learning mode" value={learningStatus === 'ready' ? 'Warming up' : 'Collecting data'} tone={learningStatus === 'ready' ? 'good' : 'warning'} />
                </div>
              </div>
            </section>

            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="3. Research Autopilot"
                title="Research queue safety"
                subtitle="The queue exists in production, but automatic research execution remains disabled."
                helper="Execution disabled"
              />
              {autopilotScheduler ? (
                <div className="sup-brain-queue-panel">
                  <Card className="sup-brain-next sup-brain-queue-summary">
                    <div className="sup-brain-summary-title">Research queue</div>
                    <div className="sup-brain-summary-main">{researchStatusTitle}</div>
                    <div className="sup-brain-summary-sub">{researchStatusText}</div>
                    <div className="sup-brain-queue-badges">
                      <Badge tone={researchQueueAvailable ? 'good' : 'neutral'}>Research queue: {researchQueueAvailable ? 'Available' : 'Missing'}</Badge>
                      <Badge tone={researchExecutionEnabled ? 'warning' : 'good'}>Automatic execution: {researchExecutionEnabled ? 'On' : 'Off'}</Badge>
                      <Badge tone={researchDryRunOnly ? 'good' : 'warning'}>Dry-run only: {researchDryRunOnly ? 'Yes' : 'No'}</Badge>
                      <Badge tone={researchPaperOnly ? 'good' : 'danger'}>Paper only: {researchPaperOnly ? 'Yes' : 'Check'}</Badge>
                    </div>
                  </Card>
                  <Card className="sup-brain-next">
                    <div className="sup-brain-summary-title">Safety summary</div>
                    <div className="sup-brain-card-stats">
                      <InfoChip label="Last blocked reason" value={researchBlockedReason} tone={researchBlockedReason === 'execution_disabled' ? 'good' : 'warning'} />
                      <InfoChip label="Queue enabled" value={researchQueueEnabled ? 'Yes' : 'No'} tone={researchQueueEnabled ? 'warning' : 'good'} />
                      <InfoChip label="Queue execution" value={researchQueueExecutionEnabled ? 'Yes' : 'No'} tone={researchQueueExecutionEnabled ? 'warning' : 'good'} />
                      <InfoChip label="Broker" value={autopilot?.broker_enabled === false ? 'Off' : 'Check'} tone={autopilot?.broker_enabled === false ? 'good' : 'danger'} />
                      <InfoChip label="Live trading" value={autopilot?.live_trading_enabled === false ? 'Off' : 'Check'} tone={autopilot?.live_trading_enabled === false ? 'good' : 'danger'} />
                      <InfoChip label="Real orders" value={autopilot?.can_place_orders === false ? 'Blocked' : 'Check'} tone={autopilot?.can_place_orders === false ? 'good' : 'danger'} />
                    </div>
                    <div className="sup-brain-learning-text">
                      This queue can plan the next research step, but execution stays blocked until a separate execution gate is explicitly opened. This page cannot change that state.
                    </div>
                  </Card>
                </div>
              ) : (
                <div className="sup-brain-empty">Status could not be read.</div>
              )}
            </section>

            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="4. Warnings"
                title="Research blockers and warnings"
                subtitle="These are calm warnings that explain what still needs more data or follow-up."
                helper="Read-only"
              />
              <div className="sup-brain-warning-list">
                {warningItems.map((item, index) => (
                  <div key={`${index}-${item}`} className="sup-brain-warning-item">
                    <span className="sup-brain-warning-dot" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="5. Next steps"
                title="Next research workflow"
                subtitle="A simple read-only workflow for the next safe research steps."
                helper="Workflow"
              />
              <div className="sup-brain-grid sup-brain-grid-5">
                <StepCard index="1" title="Collect more Narrow State data" text="The goal is a larger sample so the system can reach more stable conclusions." />
                <StepCard index="2" title="Run more batch comparisons" text="Batch testing helps compare strategies in a safe, repeatable research flow." />
                <StepCard index="3" title="Compare 2m with 5m and 15m later" text="Once more candle data is available, timeframe comparisons can be added cleanly." />
                <StepCard index="4" title="Validate the strongest strategy" text="Check whether the current leader remains stable over more test results." />
                <StepCard index="5" title="Feed new lessons back into Supervisor" text="As the data improves, the next suggested test should become clearer and calmer." />
              </div>
            </section>

            <section className="sup-brain-section">
              <SectionTitle eyebrow="6. Terms" title="Glossary" subtitle="Quick help for newer users." helper="Definitions" />
              <div className="sup-brain-glossary">
                {TERMS.map(([term, help]) => (
                  <GlossaryTooltip key={term} term={term} help={help} className="sup-brain-glossary-tooltip" />
                ))}
              </div>
            </section>
          </>
        ) : null}

        {activeSection === 'strategies' ? (
          <>
            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="1. Narrow State"
                title="Current Narrow State"
                subtitle="Compressed markets are tracked here before breakout, fakeout, or VWAP mean reversion tests."
                helper="Live snapshot"
              />
              <div className="sup-brain-grid sup-brain-grid-5">
                <StatCard icon="📈" title="Active Narrow Symbols" value={formatInt(activeSymbols, '0')} subtitle="Symbols currently flagged as compressed" detail={narrowTopSymbols.length ? narrowTopSymbols.slice(0, 3).map((row) => `${row.symbol} · ${row.narrowScore ?? row.score ?? '—'}`).join(' · ') : 'More data needed'} tone="blue" />
                <StatCard icon="🧲" title="Strongest Compression" value={strongestCompression?.symbol || 'Waiting'} subtitle={strongestCompression?.narrowScore != null ? `Score ${strongestCompression.narrowScore}` : 'No strong compression yet'} detail={strongestCompression?.regimeLabel ? text(strongestCompression.regimeLabel, 'Narrow') : 'Waiting for more research results'} tone="purple" />
                <StatCard icon="🚀" title="Breakout Watch" value={formatInt(breakoutWatch.length, '0')} subtitle="Symbols that may break after compression" detail={breakoutWatch.length ? 'Watch only. No live actions.' : 'More data needed'} tone="green" />
                <StatCard icon="⚠️" title="Fakeout Risk" value={formatInt(fakeoutRisk.length, '0')} subtitle="Symbols where a breakout may fail" detail={fakeoutRisk.length ? 'The system is watching for false breaks.' : 'More data needed'} tone="warning" />
                <StatCard icon="🔄" title="Mean Reversion" value={formatInt(meanReversion.length, '0')} subtitle="Symbols that may revert toward VWAP" detail={meanReversion.length ? 'Potential reversion setups.' : 'More data needed'} tone="blue" />
              </div>
              <div className="sup-brain-mini-strip">
                {narrowTopSymbols.length ? narrowTopSymbols.slice(0, 6).map((item, index) => (
                  <div key={`${item.symbol || index}`} className="sup-brain-mini-chip">
                    <strong>{item.symbol || '—'}</strong>
                    <span>{item.narrowScore ?? item.score ?? '—'} · {text(item.band || item.narrowScoreBand, '—')}</span>
                  </div>
                )) : (
                  <div className="sup-brain-empty">No symbols are in Narrow State right now. That is normal when the market is not sufficiently compressed.</div>
                )}
              </div>
            </section>

            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="2. Strategy measurement"
                title="Strategy ranking and next test"
                subtitle="This view reuses the safe production data that already exists for Narrow strategies and recommendations."
                helper="Read-only research data"
              />
              <div className="sup-brain-grid sup-brain-grid-3">
                {strategyRows.map(({ id, row }) => (
                  <StrategyCard key={id} strategyId={id} row={row} summaryStatus={learningStatus} />
                ))}
              </div>
              <div className="sup-brain-grid sup-brain-grid-3">
                <SummaryCard title="Best strategy now" item={performanceBest} emptyText="No clear winner yet" />
                <SummaryCard title="Weakest strategy now" item={performanceWorst} emptyText="More data needed" />
                <Card className="sup-brain-next">
                  <div className="sup-brain-summary-title">Recommended next test</div>
                  {recommendation ? (
                    <>
                      <div className="sup-brain-next-tag">Suggested research test · no automatic change</div>
                      <div className="sup-brain-summary-main">{recommendation.title}</div>
                      <div className="sup-brain-summary-sub">{recommendation.reason}</div>
                      <div className="sup-brain-card-stats">
                        <InfoChip label="Strategy" value={recommendation.strategy} tone="blue" />
                        <InfoChip label="Source" value={recommendation.source} tone="blue" />
                        <InfoChip label="Priority" value={recommendation.priority} tone={recommendation.priority === 'high' ? 'warning' : 'neutral'} />
                      </div>
                    </>
                  ) : (
                    <div className="sup-brain-summary-empty">Waiting for more batch or replay research.</div>
                  )}
                </Card>
              </div>
            </section>

            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="3. Score bands"
                title="Which Narrow score behaves best?"
                subtitle="Higher score means more compression. not_narrow stays baseline-only and must never be selected as a Narrow test."
                helper="Score bands"
              />
              <div className="sup-brain-band-list">
                {['not_narrow', 'weak_narrow', 'confirmed_narrow', 'strong_compression'].map((band) => (
                  <BandRow key={band} band={band} data={scoreBands.find((row) => row.band === band)} maxTrades={maxBandTrades} />
                ))}
                {!scoreBands.length ? <div className="sup-brain-empty">More data needed.</div> : null}
              </div>
            </section>

            <section className="sup-brain-section">
              <SectionTitle
                eyebrow="4. Confirmations"
                title="Which confirmations help?"
                subtitle="A confirmation is extra evidence before a strategy is treated as stronger."
                helper="Comparison"
              />
              <div className="sup-brain-grid sup-brain-grid-5">
                {['vwap', 'volume', 'rsi', 'ema', 'macd'].map((confirmation) => (
                  <ConfirmationCard key={confirmation} confirmation={confirmation} data={confirmations.find((row) => row.confirmation === confirmation)} />
                ))}
              </div>
            </section>
          </>
        ) : null}

        {!['overview', 'strategies'].includes(activeSection) ? (
          <ReadOnlyPlaceholder title={SUPERVISOR_SECTIONS.find((section) => section.id === activeSection)?.label || 'Supervisor'} apis={PLACEHOLDER_APIS[activeSection] || []} />
        ) : null}

        <footer className="sup-brain-footer">
          Trading OS is a learning and research platform. It does not place real orders. All results shown here come from paper, replay, or batch research.
        </footer>
      </div>
    </div>
  );
}
