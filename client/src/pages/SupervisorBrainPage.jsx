import React, { useEffect, useMemo, useState } from 'react';
import GlossaryTooltip from '../components/tradingos/GlossaryTooltip.jsx';

const REFRESH_MS = 15000;

const STRATEGY_META = {
  narrow_breakout_v1: {
    name: 'Breakout efter trång marknad',
    description: 'Testar om priset bryter upp eller ner efter compression.',
    tone: 'green',
  },
  narrow_fakeout_reversal_v1: {
    name: 'Falskt breakout och vändning',
    description: 'Testar om priset lurar utanför range och sedan vänder tillbaka.',
    tone: 'amber',
  },
  narrow_vwap_mean_reversion_v1: {
    name: 'Återgång mot VWAP',
    description: 'Testar om priset går tillbaka mot VWAP när marknaden är trång.',
    tone: 'blue',
  },
};

const BAND_LABELS = {
  not_narrow: 'Inte narrow',
  weak_narrow: 'Svag narrow',
  confirmed_narrow: 'Bekräftad narrow',
  strong_compression: 'Stark compression',
};

const BAND_TONES = {
  not_narrow: 'muted',
  weak_narrow: 'warning',
  confirmed_narrow: 'good',
  strong_compression: 'purple',
};

const CONFIDENCE_LABELS = {
  none: 'Ingen',
  low: 'Låg',
  medium: 'Medium',
  high: 'Hög',
};

const LEARNING_STATUS_LABELS = {
  needs_more_data: 'För lite data',
  low_confidence: 'Låg säkerhet',
  ready: 'Redo',
};

const TERMS = [
  ['Narrow State', 'Marknaden rör sig trångt och lugnt. Systemet letar efter compression.'],
  ['Breakout', 'Priset bryter ut från ett trångt intervall.'],
  ['Fakeout', 'Priset ser ut att bryta ut men vänder snabbt tillbaka.'],
  ['VWAP', 'Ett viktat medelpris som många använder som riktmärke.'],
  ['Replay', 'Test på historisk data för att se hur något hade fungerat.'],
  ['Batch', 'Många testkombinationer körs i ett säkert testflöde.'],
  ['Paper', 'Testläge utan riktiga order eller riktiga pengar.'],
  ['Confidence', 'Hur säkert systemet känner sig med slutsatsen.'],
];

function apiJson(url) {
  return fetch(url, { credentials: 'same-origin' })
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
      if (!cancelled) setState((prev) => ({ ...prev, loading: prev.lastUpdated ? prev.loading : true, refreshing: !!prev.lastUpdated, error: '' }));
      try {
        const [narrow, learning, autopilot] = await Promise.all([
          apiJson('/api/supervisor/narrow-state'),
          apiJson('/api/learning/narrow-performance'),
          // Autopilot is read-only and optional — never block the page on it.
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
          error: error?.message || 'Kunde inte hämta data just nu.',
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

function nowText(iso) {
  if (!iso) return 'saknas';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'saknas';
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function formatInt(value, fallback = '0') {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('sv-SE').format(n) : fallback;
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

function text(value, fallback = 'För lite data ännu') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nej';
  if (Array.isArray(value)) return value.map((item) => text(item, '')).filter(Boolean).join(' · ') || fallback;
  if (typeof value === 'object') {
    return text(
      value.label ??
      value.name ??
      value.title ??
      value.symbol ??
      value.message ??
      value.summary_sv ??
      value.summary ??
      value.conclusion_sv ??
      value.note_sv ??
      value.text ??
      value.value,
      fallback,
    );
  }
  return fallback;
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
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

function StatCard({ icon, title, value, subtitle, tone = 'neutral', detail }) {
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
    description: 'Testar Narrow State i säkert testläge.',
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
        <InfoChip label="Testresultat" value={trades ? formatInt(trades) : 'För lite data'} tone={tone} />
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
      <div className="sup-brain-summary-main">{text(item.name || item.strategy_id || item.title, 'Ingen säker slutsats')}</div>
      <div className="sup-brain-summary-sub">{text(item.reason || item.message || item.description, 'För lite data ännu')}</div>
      <div className="sup-brain-card-stats">
        {item.trades != null ? <InfoChip label="Testresultat" value={formatInt(item.trades)} tone="blue" /> : null}
        {item.winRate != null || item.win_rate != null ? <InfoChip label="Win rate" value={formatPct(firstNonEmpty(item.winRate, item.win_rate), 1)} tone="good" /> : null}
        {item.avgPnl != null || item.avg_pnl != null ? <InfoChip label="Avg result" value={formatSignedPct(firstNonEmpty(item.avgPnl, item.avg_pnl), 3)} tone="blue" /> : null}
      </div>
      {item.safety ? (
        <div className="sup-brain-summary-foot">
          {item.safety.actions_allowed === false ? 'Ej automatisk ändring' : 'Kontrollera säkerhet'}
        </div>
      ) : null}
    </Card>
  );
}

function BandRow({ band, data, maxTrades }) {
  const width = maxTrades > 0 ? Math.max(6, Math.round(((data?.trades || 0) / maxTrades) * 100)) : 8;
  const tone = BAND_TONES[band] || 'neutral';
  return (
    <div className={`sup-brain-band sup-brain-band-${tone}`}>
      <div className="sup-brain-band-top">
        <div>
          <div className="sup-brain-band-title">{BAND_LABELS[band] || band}</div>
          <div className="sup-brain-band-range">
            {band === 'not_narrow' ? '0–39' : band === 'weak_narrow' ? '40–59' : band === 'confirmed_narrow' ? '60–79' : '80–100'}
          </div>
        </div>
        <Badge tone={tone}>{text(data?.recommendation, 'För lite data ännu')}</Badge>
      </div>
      <div className="sup-brain-band-bar" aria-hidden="true">
        <span style={{ width: `${width}%` }} />
      </div>
      <div className="sup-brain-band-stats">
        <InfoChip label="Testresultat" value={formatInt(data?.trades || 0)} tone={tone === 'good' ? 'good' : tone === 'purple' ? 'blue' : tone} />
        <InfoChip label="Win rate" value={data?.winRate != null ? formatPct(data.winRate, 1) : '—'} tone={tone === 'good' ? 'good' : 'neutral'} />
        <InfoChip label="Avg result" value={data?.avgPnl != null ? formatSignedPct(data.avgPnl, 3) : '—'} tone={tone === 'good' ? 'good' : 'warning'} />
      </div>
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
          <span>Med bekräftelse</span>
          <strong>{withCount ? `${formatInt(withCount)} testresultat` : 'För lite data'}</strong>
          <small>{withWin != null ? `${formatPct(withWin, 1)} · ${formatSignedPct(withPnl, 3)}` : 'Ingen säker slutsats'}</small>
        </div>
        <div>
          <span>Utan bekräftelse</span>
          <strong>{withoutCount ? `${formatInt(withoutCount)} testresultat` : 'För lite data'}</strong>
          <small>{withoutWin != null ? `${formatPct(withoutWin, 1)} · ${formatSignedPct(withoutPnl, 3)}` : 'Ingen säker slutsats'}</small>
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

function formatRecommendation(rec) {
  if (!rec) return null;
  const strategy = rec.strategy_id || rec.strategyId || rec.title || 'För lite data ännu';
  const source = rec.source ? rec.source.toUpperCase() : 'PAPER';
  const symbols = safeArray(firstNonEmpty(rec.suggestedFilters?.symbols, rec.symbols, rec.recommendedSymbols));
  const timeframes = safeArray(firstNonEmpty(rec.suggestedFilters?.timeframes, rec.timeframes, rec.recommendedTimeframes));
  const confirmations = safeArray(firstNonEmpty(rec.suggestedFilters?.confirmations, rec.confirmations, rec.recommendedConfirmations));
  const parts = [
    `Kör mer ${source.toLowerCase()} på ${strategy}`,
    symbols.length ? `för ${symbols.join(', ')}` : '',
    timeframes.length ? `på ${timeframes.join(', ')}` : '',
    confirmations.length ? `med ${confirmations.join(', ')}` : '',
  ].filter(Boolean);

  return {
    title: rec.title || 'Nästa föreslagna test',
    reason: rec.reason || rec.message || parts.join(' · '),
    strategy,
    source,
    priority: rec.priority || 'low',
    symbols,
    timeframes,
    confirmations,
    safety: rec.safety || null,
  };
}

export default function SupervisorBrainPage() {
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
  const strategies = safeArray(narrowState.strategies);
  const latestLessons = safeArray(narrowState.latestLessons);

  const learningSummary = learning?.summary || {};
  const detailedLearning = learning || {};
  const rankings = safeArray(detailedLearning.rankings);
  const scoreBands = safeArray(detailedLearning.scoreBands);
  const confirmations = safeArray(detailedLearning.confirmations);
  const recommendation = formatRecommendation(detailedLearning.recommendedNextTest || learningSummary.recommendedNextTest || narrowState.recommendedNextTest);

  const learningStatus = learningSummary.status || narrowState.status || 'needs_more_data';
  const dataConfidence = learningSummary.dataConfidence || narrowState.dataConfidence || 'none';
  const learningMessage = learningSummary.message || narrowState.message || 'Systemet har ännu för lite Narrow State-data för säker slutsats.';
  const performanceBest = learningSummary.bestStrategy || narrowState.bestStrategy || null;
  const performanceWorst = learningSummary.worstStrategy || narrowState.worstStrategy || null;
  const performanceBand = learningSummary.bestScoreBand || narrowState.bestScoreBand || null;
  const performanceConfirmation = learningSummary.strongestConfirmation || narrowState.strongestConfirmation || null;
  const totalTrades = Number(learningSummary.totalTrades ?? narrowState.totalTrades ?? 0) || 0;
  const strategiesCompared = Number(learningSummary.strategiesCompared ?? detailedLearning.rankings?.length ?? 0) || 0;
  const generatedAt = firstNonEmpty(detailedLearning.generatedAt, narrow?.generated_at, learning?.generatedAt);

  // Narrow Test Autopilot (Goal 6) — read-only planner status.
  const autopilotInfo = autopilot?.autopilot || null;
  const autopilotPlan = autopilotInfo?.currentPlan || null;
  const autopilotValidation = autopilotInfo?.planValidation || null;
  const autopilotEvents = safeArray(autopilotInfo?.recentEvents).slice(-5).reverse();
  const autopilotFlagsLocked = autopilot
    ? [autopilot.actions_allowed, autopilot.can_place_orders, autopilot.live_trading_enabled, autopilot.broker_enabled].every((value) => value === false)
    : true;
  const autopilotBandAvailability = autopilotPlan?.bandAvailability || {};
  const autopilotAvailableBands = autopilotBandAvailability.availableBands || {};
  const autopilotBandSelection = autopilotPlan?.bandSelection || {};
  const requestedBand = autopilotPlan?.requestedNarrowScoreBand || autopilotBandSelection.requestedNarrowScoreBand || autopilotPlan?.filterEnforcement?.requestedNarrowScoreBand || autopilotPlan?.filters?.narrowScoreBand;
  const selectedBand = autopilotPlan?.selectedNarrowScoreBand || autopilotBandSelection.selectedNarrowScoreBand || autopilotPlan?.filterEnforcement?.selectedNarrowScoreBand || autopilotPlan?.filters?.narrowScoreBand;
  const bandSelectionWarnings = safeArray(autopilotPlan?.bandSelectionWarnings || autopilotBandAvailability.warnings);
  const autopilotDateWindowAvailability = autopilotPlan?.dateWindowAvailability || {};
  const autopilotDateWindowSelected = autopilotPlan?.dateWindowSelected || autopilotDateWindowAvailability.bestWindow || null;
  const autopilotDateWindowRequested = autopilotPlan?.dateWindowRequested || {};
  const autopilotCommonDateWindow = autopilotDateWindowAvailability.commonDateWindow || {};
  const autopilotAlreadyTestedWindows = safeArray(autopilotPlan?.alreadyTestedWindows);
  const autopilotWindowAvailability = autopilotDateWindowSelected?.bandAvailability || {};
  const windowBlockedReason = autopilotValidation?.blocked
    ? safeArray(autopilotValidation.reasons).join(', ') || autopilotPlan?.windowSelectionReason
    : autopilotPlan?.windowSelectionReason;

  const activeSymbols = Number(narrowState.activeCount ?? narrowTopSymbols.length ?? 0) || 0;
  const strongestCompression = narrowState.strongestCompression || null;
  const controlCards = useMemo(() => ([
    {
      icon: '🔌',
      title: 'Backend',
      value: narrow || learning ? 'Ansluten' : 'Väntar',
      subtitle: 'Status från lästa API-svar',
      detail: 'Systemet svarar och data går att läsa.',
      tone: narrow || learning ? 'good' : 'warning',
    },
    {
      icon: '📡',
      title: 'Scanner',
      value: activeSymbols > 0 ? 'Aktiv' : 'Väntar',
      subtitle: 'Marknaden skannas i testläge',
      detail: `${formatInt(activeSymbols, '0')} symboler i Narrow State just nu.`,
      tone: activeSymbols > 0 ? 'blue' : 'warning',
    },
    {
      icon: '🧠',
      title: 'Learning Engine',
      value: learningStatus === 'ready' ? 'Aktiv' : 'Lär sig',
      subtitle: 'Analyserar resultat och mönster',
      detail: `${formatInt(totalTrades, '0')} testresultat · ${formatInt(strategiesCompared, '0')} strategier`,
      tone: totalTrades > 0 ? 'good' : 'warning',
    },
    {
      icon: '🛡️',
      title: 'Safety',
      value: safetyIsLocked ? 'Skydd aktivt' : 'Kontrollera',
      subtitle: 'actions_allowed=false · can_place_orders=false',
      detail: 'Live trading är låst och kan inte aktiveras härifrån.',
      tone: safetyIsLocked ? 'good' : 'danger',
    },
  ]), [activeSymbols, learningStatus, narrow, learning, safetyIsLocked, strategiesCompared, totalTrades]);

  const strategyRows = useMemo(() => ([
    { id: 'narrow_breakout_v1', row: rankings.find((item) => item.strategy_id === 'narrow_breakout_v1') },
    { id: 'narrow_fakeout_reversal_v1', row: rankings.find((item) => item.strategy_id === 'narrow_fakeout_reversal_v1') },
    { id: 'narrow_vwap_mean_reversion_v1', row: rankings.find((item) => item.strategy_id === 'narrow_vwap_mean_reversion_v1') },
  ]), [rankings]);

  const maxBandTrades = Math.max(1, ...scoreBands.map((band) => Number(band?.trades) || 0));

  const warningItems = useMemo(() => {
    const items = [
      'För lite data för vissa slutsatser trots att systemet nu har första riktiga narrow-batchen.',
      '2m används eftersom 5m/15m saknas i candle-lagret för den här körningen.',
      'MACD ser starkast ut i den här batchen, men det bör följas upp i en ny körning.',
      'Resultaten är testdata från paper, replay eller batch-testning.',
      'Live trading är avstängt och kan inte slås på härifrån.',
    ];
    if (learningMessage && learningMessage !== 'Systemet har ännu för lite Narrow State-data för säker slutsats.') {
      items.unshift(learningMessage);
    }
    if (narrowState.message && !items.includes(narrowState.message)) {
      items.unshift(narrowState.message);
    }
    return items.slice(0, 6);
  }, [learningMessage, narrowState.message]);

  const mobileSafetyText = 'Endast analysläge · Inga riktiga order · Paper / Replay / Batch only';

  const hasFirstBatch = totalTrades > 0 && learningStatus !== 'ready';
  const learningHeadline = learningStatus === 'ready'
    ? 'Systemet börjar identifiera vilka Narrow-strategier som fungerar bäst.'
    : hasFirstBatch
      ? 'Första batchtestet är klart, men detta är inte bevisad edge.'
      : 'För lite data ännu.';
  const firstBatchNote = hasFirstBatch
    ? 'Första batchtestet är klart. Datatilliten gäller testmängden, inte bevisad trading-edge.'
    : null;

  if (loading && !narrow && !learning) {
    return (
      <div className="sup-brain-page">
        <div className="sup-brain-shell">
          <div className="sup-brain-loading">Laddar Supervisor…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="sup-brain-page">
      <div className="sup-brain-shell">
        <header className="sup-brain-hero">
          <div className="sup-brain-hero-copy">
            <div className="sup-brain-kicker">Trading OS Supervisor</div>
            <h1>Supervisor</h1>
            <p>AI-hjärnan som övervakar systemet, lärandet och nästa test.</p>
            <div className="sup-brain-hero-sub">
              <span className="sup-brain-hero-note">Narrow State-first AI Learning System</span>
              <span className="sup-brain-hero-note sup-brain-hero-note-soft">Detta är inte investeringsråd</span>
            </div>
          </div>

          <aside className="sup-brain-safety-rail">
            <div className="sup-brain-safety-sticky">
              <div className="sup-brain-safety-tags">
                <Badge tone="good">PAPER ONLY</Badge>
                <Badge tone="blue">LIVE TRADING OFF</Badge>
                <Badge tone="neutral">INGA RIKTIGA ORDER</Badge>
              </div>
              <div className="sup-brain-safety-banner">{mobileSafetyText}</div>
              <div className="sup-brain-safety-autopilot">
                <span>Autopilot</span>
                <strong>{autopilotFlagsLocked ? 'Safety låst · paper only' : 'Kontrollera safety'}</strong>
              </div>
              <div className="sup-brain-safety-flags">
                <span>actions_allowed={String(narrowFlags.actions_allowed)}</span>
                <span>can_place_orders={String(narrowFlags.can_place_orders)}</span>
                <span>live_trading_enabled={String(narrowFlags.live_trading_enabled)}</span>
                <span>broker_enabled={String(narrowFlags.broker_enabled)}</span>
              </div>
              <div className="sup-brain-meta">
                <span>Senast uppdaterad: {nowText(lastUpdated || generatedAt)}</span>
                {refreshing ? <span>Uppdaterar…</span> : <span>Automatisk refresh aktiv</span>}
              </div>
            </div>
          </aside>
        </header>

        <section className="sup-brain-section sup-brain-section-safety">
          <SectionTitle
            eyebrow="1. Systemstatus"
            title="Är systemet friskt?"
            subtitle="Fyra snabba statuskort som visar om allt läses korrekt i testläge."
            helper="Vad betyder detta?"
          />
          <div className="sup-brain-grid sup-brain-grid-4">
            {controlCards.map((card) => (
              <StatCard key={card.title} {...card} />
            ))}
          </div>
          <div className="sup-brain-banner">
            Systemet kan analysera, replay-testa, batch-testa och paper-testa men aldrig lägga riktiga order.
          </div>
          <BeginnerBox
            title="Vad betyder statusen?"
            text="Ansluten betyder att data går att läsa. Aktiv betyder att systemet hittar något att analysera. Skydd aktivt betyder att live trading är låst och att inga riktiga order kan skickas."
          />
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="2. AI-lärande"
            title="Vad AI lärde sig"
            subtitle="Detta är bara testresultat från replay, batch och paper."
            helper={CONFIDENCE_LABELS[dataConfidence] ? `Datatillit: ${CONFIDENCE_LABELS[dataConfidence]}` : 'Datatillit'}
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
              <InfoChip label="Testresultat" value={formatInt(totalTrades, '0')} tone="blue" />
              <InfoChip label="Strategier" value={formatInt(strategiesCompared, '0')} tone="blue" />
              <InfoChip label="Lärande" value={learningStatus === 'ready' ? 'Kommer igång' : 'Samlar data'} tone={learningStatus === 'ready' ? 'good' : 'warning'} />
            </div>
            <BeginnerBox
              title="Vad betyder detta?"
              text="Systemet gör inga affärer här. Det läser testdata och försöker förstå vad som verkar fungera bättre, svagare eller kräver mer data."
            />
          </div>
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="3. Narrow State"
            title="📉 Narrow State just nu"
            subtitle="Marknaden rör sig trångt. Systemet letar efter compression före breakout, fakeout eller återgång mot VWAP."
            helper="Vad betyder detta?"
          />
          <div className="sup-brain-grid sup-brain-grid-5">
            <StatCard
              icon="📈"
              title="Active Narrow Symbols"
              value={formatInt(activeSymbols, '0')}
              subtitle="Symboler som ser trånga ut just nu"
              detail={narrowTopSymbols.length ? narrowTopSymbols.slice(0, 3).map((row) => `${row.symbol} · ${row.narrowScore ?? row.score ?? '—'}`).join(' · ') : 'För lite data ännu'}
              tone="blue"
            />
            <StatCard
              icon="🧲"
              title="Strongest Compression"
              value={strongestCompression?.symbol || 'Väntar'}
              subtitle={strongestCompression?.narrowScore != null ? `Score ${strongestCompression.narrowScore}` : 'Ingen stark compression ännu'}
              detail={strongestCompression?.regimeLabel ? text(strongestCompression.regimeLabel, 'Narrow') : 'Väntar på fler batch/replay-resultat'}
              tone="purple"
            />
            <StatCard
              icon="🚀"
              title="Breakout Watch"
              value={formatInt(breakoutWatch.length, '0')}
              subtitle="Symboler där priset kan bryta ut efter trång rörelse"
              detail={breakoutWatch.length ? 'Bevaka men kör inte live.' : 'För lite data ännu'}
              tone="green"
            />
            <StatCard
              icon="⚠️"
              title="Fakeout Risk"
              value={formatInt(fakeoutRisk.length, '0')}
              subtitle="Symboler där utbrott kan misslyckas"
              detail={fakeoutRisk.length ? 'Systemet letar efter falska breakouts.' : 'För lite data ännu'}
              tone="warning"
            />
            <StatCard
              icon="🔄"
              title="Mean Reversion"
              value={formatInt(meanReversion.length, '0')}
              subtitle="Symboler som kan återgå mot VWAP"
              detail={meanReversion.length ? 'Möjliga återgångar mot mitten/VWAP.' : 'För lite data ännu'}
              tone="blue"
            />
          </div>

          <div className="sup-brain-mini-strip">
            {narrowTopSymbols.length ? narrowTopSymbols.slice(0, 6).map((item, index) => (
              <div key={`${item.symbol || index}`} className="sup-brain-mini-chip">
                <strong>{item.symbol || '—'}</strong>
                <span>{item.narrowScore ?? item.score ?? '—'} · {text(item.band || item.narrowScoreBand, '—')}</span>
              </div>
            )) : (
              <div className="sup-brain-empty">Inga symboler i Narrow State just nu. Det är normalt när marknaden inte är tillräckligt trång.</div>
            )}
          </div>

          <BeginnerBox
            title="Vad betyder Narrow State?"
            text="Narrow State betyder att priset är ihoptryckt och rör sig lugnare än vanligt. Det kan föregå breakout, fakeout eller mean reversion."
          />
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="4. Strategimätning"
            title="📈 Strategier som systemet mäter"
            subtitle="Tre Narrow State-strategier testas i paper/replay/batch."
            helper="Testresultat"
          />
          <div className="sup-brain-grid sup-brain-grid-3">
            {strategyRows.map(({ id, row }) => (
              <StrategyCard key={id} strategyId={id} row={row} summaryStatus={learningStatus} />
            ))}
          </div>
          <BeginnerBox
            title="Vad menas med testresultat?"
            text="Varje strategi visar hur många testresultat den har, hur ofta den vinner och om den verkar lovande, svag eller behöver mer data. Inga köp eller sälj görs här."
          />
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="5. Beslutsstöd"
            title="Bästa / Svagaste / Nästa test"
            subtitle="Här ser du vad systemet tycker är bäst just nu och vad som bör testas härnäst. Baserat på testdata, inte investeringsråd."
            helper="Rekommendationer"
          />
          <div className="sup-brain-grid sup-brain-grid-3">
            <SummaryCard
              title="Bästa strategi just nu"
              item={performanceBest}
              emptyText="Ingen säker vinnare ännu"
            />
            <SummaryCard
              title="Svagaste strategi just nu"
              item={performanceWorst}
              emptyText="För lite data ännu"
            />
            <Card className="sup-brain-next">
              <div className="sup-brain-summary-title">Rekommenderat nästa test</div>
              {recommendation ? (
                <>
                  <div className="sup-brain-next-tag">Föreslaget test - ej automatisk ändring</div>
                  <div className="sup-brain-summary-main">{recommendation.title}</div>
                  <div className="sup-brain-summary-sub">{recommendation.reason}</div>
                  <div className="sup-brain-card-stats">
                    <InfoChip label="Strategy" value={recommendation.strategy} tone="blue" />
                    <InfoChip label="Source" value={recommendation.source} tone="blue" />
                    <InfoChip label="Priority" value={recommendation.priority} tone={recommendation.priority === 'high' ? 'warning' : 'neutral'} />
                  </div>
                  <div className="sup-brain-next-filters">
                    {recommendation.symbols.length ? <Badge tone="blue">{recommendation.symbols.join(', ')}</Badge> : <Badge tone="neutral">För lite data ännu</Badge>}
                    {recommendation.timeframes.length ? <Badge tone="blue">{recommendation.timeframes.join(', ')}</Badge> : null}
                    {recommendation.confirmations.length ? <Badge tone="good">{recommendation.confirmations.join(', ')}</Badge> : null}
                  </div>
                </>
              ) : (
                <div className="sup-brain-summary-empty">Väntar på fler batch/replay-resultat.</div>
              )}
            </Card>
          </div>
        </section>

        <section className="sup-brain-section sup-brain-section-autopilot">
          <SectionTitle
            eyebrow="5b. Autopilot"
            title="🤖 Narrow Test Autopilot"
            subtitle="Autopiloten läser rekommendationen och bygger en säker testplan. Den kan bara planera och köra batch/replay/paper-tester — aldrig lägga riktiga order."
            helper="Säker planerare"
          />
          <div className="sup-brain-autopilot">
            <div className="sup-brain-autopilot-head">
              <Badge tone={autopilotFlagsLocked ? 'good' : 'danger'}>{autopilotFlagsLocked ? 'SAFETY LÅST' : 'KONTROLLERA'}</Badge>
              <Badge tone="blue">PAPER ONLY</Badge>
              <Badge tone="neutral">DRY-RUN FÖRST</Badge>
              <Badge tone="neutral">INGA RIKTIGA ORDER</Badge>
            </div>
            {autopilotPlan ? (
              <div className="sup-brain-grid sup-brain-grid-3">
                <Card className="sup-brain-next">
                  <div className="sup-brain-summary-title">Senaste / aktuella plan</div>
                  <div className="sup-brain-summary-main">{STRATEGY_META[autopilotPlan.strategy_id]?.name || autopilotPlan.strategy_id}</div>
                  <div className="sup-brain-summary-sub">{text(autopilotPlan.reason, 'Försiktig default-plan.')}</div>
                  <div className="sup-brain-card-stats">
                    <InfoChip label="Test" value={text(autopilotPlan.testType, 'batch')} tone="blue" />
                    <InfoChip label="Mode" value={text(autopilotPlan.mode, 'paper_only')} tone="good" />
                    <InfoChip label="Priority" value={text(autopilotPlan.priority, 'low')} tone={autopilotPlan.priority === 'high' ? 'warning' : 'neutral'} />
                  </div>
                  <div className="sup-brain-next-filters">
                    {safeArray(autopilotPlan.symbols).length ? <Badge tone="blue">{safeArray(autopilotPlan.symbols).join(', ')}</Badge> : null}
                    {requestedBand ? <Badge tone="neutral">Requested: {BAND_LABELS[requestedBand] || requestedBand}</Badge> : null}
                    {selectedBand ? <Badge tone="purple">Selected: {BAND_LABELS[selectedBand] || selectedBand}</Badge> : <Badge tone="warning">Inget körbart narrow-band</Badge>}
                    {safeArray(autopilotPlan.filters?.confirmations).length ? <Badge tone="good">{safeArray(autopilotPlan.filters.confirmations).join(', ')}</Badge> : null}
                  </div>
                  <div className="sup-brain-timeframes">
                    <div className="sup-brain-timeframes-row">
                      <span>Planerade timeframes:</span>
                      {safeArray(autopilotPlan.requestedTimeframes).length
                        ? safeArray(autopilotPlan.requestedTimeframes).map((tf) => <Badge key={`req-${tf}`} tone="neutral">{tf}</Badge>)
                        : <Badge tone="neutral">2m</Badge>}
                    </div>
                    <div className="sup-brain-timeframes-row">
                      <span>Tillgängliga nu:</span>
                      {safeArray(autopilotPlan.availableTimeframes).length
                        ? safeArray(autopilotPlan.availableTimeframes).map((tf) => <Badge key={`av-${tf}`} tone="good">{tf}</Badge>)
                        : safeArray(autopilotPlan.timeframes).map((tf) => <Badge key={`tf-${tf}`} tone="good">{tf}</Badge>)}
                    </div>
                    {safeArray(autopilotPlan.missingTimeframes).length ? (
                      <div className="sup-brain-timeframes-row">
                        <span>Saknas:</span>
                        {safeArray(autopilotPlan.missingTimeframes).map((tf) => <Badge key={`miss-${tf}`} tone="warning">{tf}</Badge>)}
                      </div>
                    ) : null}
                  </div>
                </Card>
                <Card className="sup-brain-next">
                  <div className="sup-brain-summary-title">Adaptive band selection</div>
                  <div className="sup-brain-summary-main">
                    {selectedBand ? (BAND_LABELS[selectedBand] || selectedBand) : 'Inget narrow-band just nu'}
                  </div>
                  <div className="sup-brain-summary-sub">
                    {text(autopilotBandSelection.selectionReason || autopilotBandAvailability.selectionReason, 'Systemet kontrollerar först vilka score-band som faktiskt finns i aktuell 2m-data.')}
                  </div>
                  <div className="sup-brain-card-stats">
                    <InfoChip label="Requested band" value={requestedBand ? (BAND_LABELS[requestedBand] || requestedBand) : '—'} tone="blue" />
                    <InfoChip label="Selected band" value={selectedBand ? (BAND_LABELS[selectedBand] || selectedBand) : 'Ingen'} tone={selectedBand ? 'good' : 'warning'} />
                    <InfoChip label="not_narrow" value="Aldrig valt" tone="good" />
                  </div>
                  <div className="sup-brain-next-filters">
                    {['confirmed_narrow', 'weak_narrow', 'strong_compression'].map((band) => {
                      const item = autopilotAvailableBands[band] || {};
                      return (
                        <Badge key={band} tone={Number(item.rows || 0) > 0 ? 'good' : 'neutral'}>
                          {BAND_LABELS[band] || band}: {Number(item.rows || 0)}
                        </Badge>
                      );
                    })}
                  </div>
                  {bandSelectionWarnings.length ? (
                    <div className="sup-brain-next-filters">
                      {bandSelectionWarnings.slice(0, 4).map((warning) => (
                        <Badge key={warning} tone="warning">{warning}</Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="sup-brain-learning-text">
                    Systemet kontrollerar först om det finns riktiga trånga lägen. Om confirmed_narrow saknas kan det föreslå weak_narrow, men det använder aldrig not_narrow som giltigt narrow-test.
                  </div>
                </Card>
                <Card className="sup-brain-next">
                  <div className="sup-brain-summary-title">Datafönster & freshness</div>
                  <div className="sup-brain-summary-main">
                    {autopilotDateWindowSelected
                      ? `${autopilotDateWindowSelected.dateFrom} - ${autopilotDateWindowSelected.dateTo}`
                      : 'Inget narrow-fönster hittat'}
                  </div>
                  <div className="sup-brain-summary-sub">
                    {text(autopilotPlan?.freshnessStatus, 'Freshness saknas')} · {text(autopilotPlan?.windowSelectionReason, 'Väntar på analys')}
                  </div>
                  <div className="sup-brain-card-stats">
                    <InfoChip label="Begärt" value={`${text(autopilotDateWindowRequested.timeframe, '2m')} · ${formatInt(autopilotDateWindowRequested.tradingDays, '10')} dagar`} tone="blue" />
                    <InfoChip label="Gemensamt" value={autopilotCommonDateWindow.dateFrom ? `${autopilotCommonDateWindow.dateFrom} - ${autopilotCommonDateWindow.dateTo}` : 'Saknas'} tone="blue" />
                    <InfoChip label="Redan testade" value={formatInt(autopilotAlreadyTestedWindows.length, '0')} tone={autopilotAlreadyTestedWindows.length ? 'warning' : 'good'} />
                  </div>
                  <div className="sup-brain-next-filters">
                    {['confirmed_narrow', 'weak_narrow', 'strong_compression'].map((band) => (
                      <Badge key={`window-${band}`} tone={Number(autopilotWindowAvailability[band] || 0) > 0 ? 'good' : 'neutral'}>
                        {BAND_LABELS[band] || band}: {Number(autopilotWindowAvailability[band] || 0)}
                      </Badge>
                    ))}
                    <Badge tone={Number(autopilotWindowAvailability.not_narrow || 0) > 0 ? 'warning' : 'neutral'}>
                      not_narrow: {Number(autopilotWindowAvailability.not_narrow || 0)}
                    </Badge>
                  </div>
                  {autopilotValidation?.blocked ? (
                    <div className="sup-brain-next-filters">
                      <Badge tone="warning">Blockerat: {text(windowBlockedReason, 'okänd orsak')}</Badge>
                    </div>
                  ) : null}
                  <div className="sup-brain-learning-text">
                    Systemet letar först efter tidsperioder där marknaden faktiskt var trång. Om ingen sådan period finns körs inget test.
                  </div>
                </Card>
                <Card className="sup-brain-next">
                  <div className="sup-brain-summary-title">Safety-validering</div>
                  <div className="sup-brain-summary-main">{autopilotValidation?.blocked ? 'Blockerad' : 'Godkänd'}</div>
                  <div className="sup-brain-summary-sub">
                    {autopilotValidation?.blocked
                      ? 'Planen stoppades av säkerhetskontrollen.'
                      : 'Planen är paper_only och passerade alla säkerhetsregler.'}
                  </div>
                  <div className="sup-brain-card-stats">
                    <InfoChip label="actions_allowed" value="false" tone="good" />
                    <InfoChip label="can_place_orders" value="false" tone="good" />
                    <InfoChip label="live_trading_enabled" value="false" tone="good" />
                    <InfoChip label="broker_enabled" value="false" tone="good" />
                  </div>
                  {safeArray(autopilotValidation?.reasons).length ? (
                    <div className="sup-brain-next-filters">
                      {safeArray(autopilotValidation.reasons).slice(0, 4).map((reason) => (
                        <Badge key={reason} tone="warning">{reason}</Badge>
                      ))}
                    </div>
                  ) : null}
                </Card>
                <Card className="sup-brain-next">
                  <div className="sup-brain-summary-title">Senaste autopilot-händelser</div>
                  {autopilotEvents.length ? (
                    <ul className="sup-brain-autopilot-events">
                      {autopilotEvents.map((event, index) => (
                        <li key={`${event.timestamp || index}-${event.event}`}>
                          <span className="sup-brain-warning-dot" />
                          <span>{text(event.event, 'event')} · {text(event.testType, '—')} · {nowText(event.timestamp)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="sup-brain-summary-empty">Inga autopilot-körningar loggade ännu.</div>
                  )}
                  <div className="sup-brain-next-tag">Dry-run är standard · körning kräver explicit --execute</div>
                </Card>
              </div>
            ) : (
              <div className="sup-brain-empty">Autopiloten är inte tillgänglig just nu.</div>
            )}
            <div className="sup-brain-learning-text">
              Systemet fokuserar just nu på <strong>2-minutersdata</strong>. Det är den timeframe som är stabilt tillgänglig och bäst lämpad för våra första Narrow State-tester. 1m, 5m och 10m kan läggas till senare när datakällorna är fullt kopplade. Systemet fejkar aldrig marknadsdata.
            </div>
            <BeginnerBox
              title="Vad gör autopiloten?"
              text="Systemet letar först efter tidsperioder där marknaden faktiskt var trång. Om ingen sådan period finns körs inget test."
            />
          </div>
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="6. Score-band"
            title="🎯 Vilket Narrow Score fungerar bäst?"
            subtitle="Högre score betyder mer compression. Här visas vilken styrka som verkar bäst."
            helper="Score-band"
          />
          <div className="sup-brain-band-list">
            {['not_narrow', 'weak_narrow', 'confirmed_narrow', 'strong_compression'].map((band) => (
              <BandRow key={band} band={band} data={scoreBands.find((row) => row.band === band)} maxTrades={maxBandTrades} />
            ))}
            {!scoreBands.length ? <div className="sup-brain-empty">För lite data ännu</div> : null}
          </div>
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="7. Confirmations"
            title="✅ Vilka bekräftelser hjälper?"
            subtitle="En bekräftelse är extra bevis innan en strategi räknas som stark."
            helper="Jämförelse"
          />
          <div className="sup-brain-learning-text">
            {performanceConfirmation && performanceConfirmation.confirmation
              ? `Starkaste bekräftelse just nu: ${String(performanceConfirmation.confirmation).toUpperCase()} — gäller testdata, inte bevisad edge.`
              : 'Ingen stark confirmation ännu — testdatan visar ännu ingen bekräftelse med tydlig, säker effekt.'}
          </div>
          <div className="sup-brain-grid sup-brain-grid-5">
            {['vwap', 'volume', 'rsi', 'ema', 'macd'].map((confirmation) => (
              <ConfirmationCard
                key={confirmation}
                confirmation={confirmation}
                data={confirmations.find((row) => row.confirmation === confirmation)}
              />
            ))}
          </div>
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="8. Varningar"
            title="⚠ Risker systemet ser"
            subtitle="Det här är lugna varningar som hjälper dig förstå läget."
            helper="Försiktigt"
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
            eyebrow="9. Handlingsplan"
            title="📋 Nästa handlingsplan"
            subtitle="Ett enkelt research-workflow för nästa steg."
            helper="Workflow"
          />
          <div className="sup-brain-grid sup-brain-grid-5">
            <StepCard index="1" title="Samla mer Narrow State-data" text="Målet är fler testresultat så att systemet får säkrare slutsatser." />
            <StepCard index="2" title="Kör fler batchtester" text="Batch hjälper till att jämföra strategier på ett säkert och repeterbart sätt." />
            <StepCard index="3" title="Jämför 2m mot 5m/15m" text="När mer candle-data finns kan timeframes jämföras på ett renare sätt." />
            <StepCard index="4" title="Validera bästa strategi" text="Kontrollera om den strategi som ser bäst ut också fortsätter att vara stabil." />
            <StepCard index="5" title="Skicka lärdomar till Supervisor" text="När data blir bättre ska nästa test föreslås tydligare och lugnare." />
          </div>
        </section>

        <section className="sup-brain-section">
          <SectionTitle
            eyebrow="10. Begrepp"
            title="Vad betyder detta?"
            subtitle="Snabb hjälp för nya användare."
            helper="Ordlista"
          />
          <div className="sup-brain-glossary">
            {TERMS.map(([term, help]) => (
              <GlossaryTooltip key={term} term={term} help={help} className="sup-brain-glossary-tooltip" />
            ))}
          </div>
        </section>

        <footer className="sup-brain-footer">
          Trading OS är en analys- och forskningsplattform. Den lägger inga riktiga order. Alla resultat är från paper, replay eller batch-testning.
        </footer>
      </div>
    </div>
  );
}
