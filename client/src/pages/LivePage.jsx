import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SectionHeader, DecisionHeroCard, tvLink, cryptoTvLink, TradeScoreBadge,
} from '../shared.jsx';
import { useAlerts } from '../alertContext.jsx';
import { enrichWithDecisions, getBestSignal, getTopN, isAvoidSignal } from '../decisionEngine.js';
import { isCryptoSymbol, openTradingView } from '../utils/tradingView.js';
import { familyCalibrationMeta, signalFamilyMeta } from '../utils/signalFamilyLabels.js';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';
import { normalizeSignalForChart } from '../utils/chartSignalUtils.js';
import TradingViewSignalPanel from '../components/TradingViewSignalPanel.jsx';

const CHART_SIGNAL_EVENT = 'live:open-chart-signal';

const REFRESH_MS = 15_000;

/* ── Swedish label maps ──────────────────────────────────────────────────────── */

const DECISION_SV = {
  active:  'Titta manuellt',
  caution: 'Nära men försiktig',
  watch:   'Bevaka',
  wait:    'Vänta',
  avoid:   'Jaga inte',
  stale:   'Data gammal',
  unknown: 'Kan inte bedöma',
};

const BIAS_SV = {
  UP:        { text: 'Uppåt',   icon: '▲', cls: 'bias-up' },
  DOWN:      { text: 'Nedåt',   icon: '▼', cls: 'bias-down' },
  NEUTRAL:   { text: 'Neutral', icon: '→', cls: 'bias-neutral' },
  UNCERTAIN: { text: 'Osäker',  icon: '?', cls: 'bias-uncertain' },
};

const TF_LABELS = ['1h', '30m', '15m', '10m', '5m', '2m'];
const TF_KEYS   = ['tf1h', 'tf30m', 'tf15m', 'tf10m', 'tf5m', 'tf2m'];

const GLOSSARY = [
  { term: 'Narrow State',      desc: 'Priset är ihoptryckt och kan snart bryta ut. Bra setup börjar ofta med narrow state.' },
  { term: 'Momentum',          desc: 'Fart i rörelsen. Starkt momentum = priset rör sig med övertygelse i en riktning.' },
  { term: 'Fakeout',           desc: 'Falskt utbrott. Priset bryter en nivå men vänder snabbt tillbaka — farligt att jaga.' },
  { term: 'Pullback',          desc: 'Kort rekyl innan eventuell fortsättning av trenden. Inte nödvändigtvis farligt.' },
  { term: 'Likviditet',        desc: 'Hur lätt det är att handla utan stora prishopp. Låg likviditet = högre risk.' },
  { term: '2m-bekräftelse',    desc: '2-minutersgraf är beslutspunkten. Utan tydlig rörelse på 2m är risken för hög.' },
];

/* ── Data hooks ──────────────────────────────────────────────────────────────── */

function useMultiScan() {
  const [stocks, setStocks] = useState([]);
  const [crypto, setCrypto] = useState([]);
  const [nasdaq, setNasdaq] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [s, c, n] = await Promise.all([
        fetch('/api/scan/stocks').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/scan/crypto').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/scan/nasdaq').then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      setStocks(s?.results || []);
      setCrypto(c?.results || []);
      setNasdaq(n?.results || []);
      setLastFetch(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchAll]);

  return { stocks, crypto, nasdaq, loading, lastFetch, refresh: fetchAll };
}

function useSystemSnapshot() {
  const unified = useUnifiedConfig('health');
  const health = unified.global.systemHealth;
  const [alerts, setAlerts] = useState(null);

  const fetchSnapshot = useCallback(async () => {
    const a = await fetch('/api/alerts').then(r => r.ok ? r.json() : null).catch(() => null);
    setAlerts(a);
  }, []);

  useEffect(() => {
    fetchSnapshot();
    const t = setInterval(fetchSnapshot, 30_000);
    return () => clearInterval(t);
  }, [fetchSnapshot]);

  return { health, alerts, refresh: fetchSnapshot };
}

function useDecisionMonitor() {
  const [data, setData] = useState(null);
  const fetchDm = useCallback(async () => {
    fetch('/api/live/decision-monitor?includeAi=1&familyDebug=1')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setData(d); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    fetchDm();
    const t = setInterval(fetchDm, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchDm]);
  return data;
}

function usePaperTradingEvents() {
  const [data, setData] = useState(null);
  const fetchEvents = useCallback(async () => {
    fetch('/api/paper-trading/events')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setData(d); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    fetchEvents();
    const t = setInterval(fetchEvents, 30_000);
    return () => clearInterval(t);
  }, [fetchEvents]);
  return data;
}

function usePersonality() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/market/personality')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {});
  }, []);
  return data;
}

function paperEventTone(event) {
  if (event?.type === 'TRADE_OPENED' || (event?.type === 'TRADE_CLOSED' && /plus/i.test(event?.reasonSv || ''))) return '#22c55e';
  if (event?.type === 'TRADE_CLOSED' && /minus/i.test(event?.reasonSv || '')) return '#ef4444';
  if (event?.decision === 'skipped' || /tiden tog slut/i.test(event?.reasonSv || '')) return '#eab308';
  return '#94a3b8';
}

function PaperTradingEventMini({ data, hideHeader = false }) {
  const events = (data?.events || []).slice(0, 3);
  if (!events.length) return null;
  return (
    <div className="paper-event-mini">
      {!hideHeader && (
        <div className="paper-event-mini-head">
          <span>Senaste aktivitet</span>
          <a href="/paper-trading">Paper trading</a>
        </div>
      )}
      <div className="paper-event-mini-list">
        {events.map((event, i) => (
          <div key={event.eventId || `${event.timestamp}-${i}`} className="paper-event-mini-row">
            <span className="paper-event-mini-symbol">{event.symbol || 'SYSTEM'}</span>
            <span style={{ color: paperEventTone(event) }}>{event.reasonSv || 'Ingen orsak sparad.'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Old helper functions (preserved for advanced section) ───────────────────── */

function scoreOf(r) {
  return r?.priorityScore ?? r?._decision?.signalScore ?? r?.tradeScore ?? 0;
}

function directionSv(r) {
  if (r?.signal?.startsWith('LONG')) return 'Uppåt';
  if (r?.signal?.startsWith('SHORT')) return 'Nedåt';
  if (r?.momentumBias === 'bullish') return 'Uppåt';
  if (r?.momentumBias === 'bearish') return 'Nedåt';
  return 'Avvakta';
}

function simpleStatus(r) {
  if (r?.autoFilter?.blocked || r?.fakeoutRiskLevel === 'high' || (r?.fakeoutProbability ?? 0) >= 70) return 'RISK';
  const score = scoreOf(r);
  if (score >= 70) return 'STARK';
  if (r?.watchMode || r?.momentumWatchMode || r?.liquiditySweepWatchMode || score >= 45) return 'BEVAKA';
  return 'VÄNTA';
}

function statusClass(status) {
  if (status === 'STARK') return 'strong';
  if (status === 'RISK') return 'risk';
  if (status === 'BEVAKA') return 'watch';
  return 'wait';
}

function statusLabel(status) {
  if (status === 'STARK') return 'Stark kandidat';
  if (status === 'RISK') return 'Hög risk';
  if (status === 'BEVAKA') return 'Bevaka';
  return 'Vänta';
}

function whyNow(r) {
  return r?.whyNowSv ||
    r?._decision?.explanation ||
    r?.actionSv ||
    r?.momentumExplanationSv ||
    r?.scoreExplanationSv?.[0] ||
    'Systemet bevakar läget och väntar på tydligare bekräftelse.';
}

function riskSv(r) {
  if (r?.fakeoutRiskLevel === 'high' || (r?.fakeoutProbability ?? 0) >= 70) return 'Hög risk för falsk rörelse.';
  if (r?.liquiditySweepDetected) return 'Stopjakt kan vara intressant, men historiken visar ännu inte att den ger bättre resultat.';
  if (r?.autoFilter?.blocked) return 'Reglerna blockerar läget. Jaga inte.';
  return 'Ingen tydlig varningsflagga just nu.';
}

function daytradeDirectionSv(direction) {
  if (direction === 'up') return 'Uppåt';
  if (direction === 'down') return 'Nedåt';
  return 'Neutral';
}

function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function ageLabel(iso) {
  if (!iso) return 'saknas';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return 'saknas';
  const diffMs = Math.max(0, Date.now() - time);
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'nyss';
  if (mins < 60) return `${mins} min sedan`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h sedan`;
  const days = Math.round(hours / 24);
  return `${days} d sedan`;
}

function daytradeTone(status) {
  if (status === 'Titta manuellt' || status === 'Bekräftad') return 'strong';
  if (status === 'Intressant') return 'watch';
  if (status === 'Hög risk') return 'risk';
  if (status === 'Bevaka') return 'watch';
  return 'wait';
}

function tvLinkFor(r) {
  return isCryptoSymbol(r?.symbol) ? cryptoTvLink(r.symbol) : tvLink(r.symbol);
}

function buildReviewChartUrl(c) {
  const qs = new URLSearchParams();
  qs.set('symbol', c.symbol);
  if (c.timestamp || c.lastUpdate) qs.set('timestamp', c.timestamp || c.lastUpdate);
  qs.set('timeframe', '2m');
  qs.set('marketType', c.marketType || c.market || (isCryptoSymbol(c.symbol) ? 'crypto' : 'stocks'));
  if (c.signalId) qs.set('signalId', c.signalId);
  if (c.signal) qs.set('signal', c.signal);
  if (c.signalFamily) qs.set('signalFamily', c.signalFamily);
  if (c.signalSubtype) qs.set('signalSubtype', c.signalSubtype);
  if (c.signalFamilyReasonSv) qs.set('signalFamilyReasonSv', c.signalFamilyReasonSv);
  if (c.dataFreshness) qs.set('dataFreshness', c.dataFreshness);
  if (c.stockFeedStatus?.reasonSv) qs.set('stockFeedReasonSv', c.stockFeedStatus.reasonSv);
  if (c.familyCalibrationHints?.historicalEdge) qs.set('calibrationHistoricalEdge', c.familyCalibrationHints.historicalEdge);
  if (c.familyCalibrationHints?.reasonSv) qs.set('calibrationReasonSv', c.familyCalibrationHints.reasonSv);
  if (c.familyCalibrationHints?.suggestedPriorityBias) qs.set('calibrationPriorityBias', c.familyCalibrationHints.suggestedPriorityBias);
  if (c.familyCalibrationHints?.source) qs.set('calibrationSource', c.familyCalibrationHints.source);
  if (c.tradeScore != null) qs.set('tradeScore', c.tradeScore);
  if (c.price != null) qs.set('price', c.price);
  if (c.decisionTextSv) qs.set('decisionTextSv', c.decisionTextSv);
  if (c.nextMoveBias) qs.set('nextMoveBias', c.nextMoveBias);
  if (c.confidenceScore != null) qs.set('confidence', c.confidenceScore);
  if (c.fakeoutRiskLevel) qs.set('risk', c.fakeoutRiskLevel);
  return `/review-chart?${qs.toString()}`;
}

function useOpenReviewChart() {
  const navigate = useNavigate();
  return useCallback((c) => {
    if (!c?.symbol) return;
    navigate(buildReviewChartUrl(c));
  }, [navigate]);
}

// Öppnar intern chart-panel på samma sida (read-only) via fönster-event,
// så att alla signalkort kan trigga panelen utan prop-drilling.
function useOpenChartSignal() {
  return useCallback((c) => {
    if (!c?.symbol) return;
    window.dispatchEvent(new CustomEvent(CHART_SIGNAL_EVENT, { detail: c }));
  }, []);
}

function healthComponent(health, name) {
  return (health?.components || []).find((c) => c.name === name);
}

function componentOk(component) {
  return component?.status === 'ON';
}

function latestScanLabel(health, fallbackDate) {
  const stock = healthComponent(health, 'Stock scanner')?.lastUpdated;
  const crypto = healthComponent(health, 'Crypto scanner')?.lastUpdated;
  const newest = [stock, crypto, fallbackDate?.toISOString?.()].filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  if (!newest) return 'Senaste scan: okänd';
  const ageSec = Math.max(0, Math.round((Date.now() - new Date(newest).getTime()) / 1000));
  return `Senaste scan: ${ageSec < 60 ? `${ageSec} sek` : `${Math.floor(ageSec / 60)} min`} sedan`;
}

function SystemHealthMini({ health, lastFetch }) {
  const stockScanner = healthComponent(health, 'Stock scanner');
  const cryptoScanner = healthComponent(health, 'Crypto scanner');
  const autoMachine = healthComponent(health, 'Auto Machine');
  const learningComponents = (health?.components || []).filter(c => c.area === 'Learning');
  const scannerOk = componentOk(stockScanner) || componentOk(cryptoScanner);
  const schedulerOk = scannerOk;
  const dataFlowOk = health?.feeds?.stocks?.status === 'ON' || health?.feeds?.crypto?.status === 'ON';
  const learningOk = learningComponents.some(componentOk);
  const issues = (health?.components || [])
    .filter(c => c.severity === 'critical' || c.severity === 'warning')
    .slice(0, 3);

  const rows = [
    { label: 'Backend ansluten', ok: !!health },
    { label: 'Scanner kör', ok: scannerOk },
    { label: 'Scheduler kör', ok: schedulerOk },
    { label: 'Dataflöde aktivt', ok: dataFlowOk },
    { label: 'Inlärning aktiv', ok: learningOk || componentOk(autoMachine) },
  ];

  return (
    <div className="health-mini">
      <div className="health-mini-grid">
        {rows.map(row => (
          <span key={row.label} className={`health-mini-chip ${row.ok ? 'chip-ok' : 'chip-warn'}`}>
            <span className="sys-chip-dot" />
            {row.label}
          </span>
        ))}
        <span className="health-mini-chip chip-info">{latestScanLabel(health, lastFetch)}</span>
      </div>
      {issues.length > 0 && (
        <div className="health-mini-issues">
          {issues.map(issue => (
            <span key={`${issue.name}-${issue.status}`}>{issue.name}: {issue.messageSv}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── NEW: System status row ──────────────────────────────────────────────────── */

function SystemRow({ health, lastFetch, dmSummary }) {
  const sysOk   = health?.overallStatus === 'HEALTHY';
  const sysCrit = health?.overallStatus === 'CRITICAL';
  const sysWarn = !sysOk && !sysCrit && !!health;
  const backOk  = !!health;
  const dataOk  = !!lastFetch;

  return (
    <div className="live-sys-row">
      <span className={`sys-chip ${sysOk ? 'chip-ok' : sysCrit ? 'chip-err' : sysWarn ? 'chip-warn' : ''}`}>
        <span className="sys-chip-dot" />
        {sysOk ? 'Systemet kör' : sysCrit ? 'Systemfel' : sysWarn ? 'Systemvarning' : 'Kontrollerar…'}
      </span>
      <span className={`sys-chip ${dataOk ? 'chip-ok' : 'chip-warn'}`}>
        <span className="sys-chip-dot" />
        {dataOk ? 'Data kommer in' : 'Väntar på data'}
      </span>
      <span className={`sys-chip ${backOk ? 'chip-ok' : 'chip-err'}`}>
        <span className="sys-chip-dot" />
        {backOk ? 'Backend ansluten' : 'Backend okänd'}
      </span>
      <span className="sys-chip chip-info">{latestScanLabel(health, lastFetch)}</span>
      {dmSummary && (
        <div className="sys-summary-counts">
          {dmSummary.active  > 0 && <span className="cnt cnt-active">{dmSummary.active} titta manuellt</span>}
          {dmSummary.caution > 0 && <span className="cnt cnt-caution">{dmSummary.caution} obs</span>}
          {dmSummary.watch   > 0 && <span className="cnt cnt-watch">{dmSummary.watch} bevaka</span>}
          {dmSummary.wait    > 0 && <span className="cnt cnt-wait">{dmSummary.wait} vänta</span>}
          {dmSummary.avoid   > 0 && <span className="cnt cnt-avoid">{dmSummary.avoid} jaga inte</span>}
        </div>
      )}
      {dmSummary?.topBlockers?.length > 0 && (
        <div className="sys-blockers">
          Vanligaste blockerare: {dmSummary.topBlockers.map(b => `${b.label} (${b.count})`).join(', ')}
        </div>
      )}
    </div>
  );
}

/* ── NEW: Timeframe row ──────────────────────────────────────────────────────── */

function TfRow({ timeframes, agreementCount }) {
  if (!timeframes) return null;
  return (
    <div className="new-tf-row">
      {TF_KEYS.map((k, i) => {
        const dir = timeframes[k] || 'neutral';
        return (
          <span
            key={k}
            className={`new-tf-cell tf-${dir} ${k === 'tf2m' ? 'tf-decision-point' : ''}`}
            title={`${TF_LABELS[i]}: ${dir}`}
          >
            <span>{TF_LABELS[i]}{k === 'tf2m' ? ' beslut' : ''}</span>
            <span className="tf-dir">{dir === 'bullish' ? '↑' : dir === 'bearish' ? '↓' : '→'}</span>
          </span>
        );
      })}
      {agreementCount != null && (
        <span className="tf-agreement">{agreementCount}/6 TF</span>
      )}
    </div>
  );
}

/* ── NEW: Best decision box ──────────────────────────────────────────────────── */

function ExplanationList({ title, value }) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return (
    <div className="plain-expl-block">
      <span>{title}</span>
      {items.length <= 1 ? (
        <strong>{items[0] || 'Saknas.'}</strong>
      ) : (
        <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
      )}
    </div>
  );
}

function AnalystMiniPanel({ analyst }) {
  const [open, setOpen] = useState(false);
  if (!analyst) return null;
  return (
    <div className="ai-analysis-box">
      <div className="ai-analysis-head">
        <div>
          <span className="ai-analysis-kicker">AI-analys</span>
          <strong>{analyst.verdict || 'Kan inte bedöma'}</strong>
        </div>
        <span>{analyst.confidence ?? 0}%</span>
      </div>
      <div className="ai-analysis-summary">{analyst.summarySv || 'Data saknas.'}</div>
      <button className="btn btn-sm" onClick={() => setOpen(o => !o)}>
        {open ? 'Dölj AI-förklaring' : 'Visa AI-förklaring'}
      </button>
      {open && (
        <div className="ai-analysis-details">
          <div className="ai-mode-label">{analyst.modeLabel || 'AI-läge: regelbaserad analys'}</div>
          <ExplanationList title="Vad systemet såg" value={analyst.whatSystemSees} />
          <ExplanationList title="Vad stödjer" value={analyst.whatSupports} />
          <ExplanationList title="Vad varnar" value={analyst.whatWarns} />
          <ExplanationList title="Bekräftelse saknas" value={analyst.missingConfirmation} />
          <ExplanationList title="Historik" value={analyst.historicalContextSv} />
          <ExplanationList title="Tajming" value={analyst.timingAssessmentSv} />
          <ExplanationList title="Risk" value={analyst.riskAssessmentSv} />
          <ExplanationList title="Nästa förbättring" value={analyst.nextImprovementSv} />
        </div>
      )}
    </div>
  );
}

function BestDecisionBox({ c, loading }) {
  const [open, setOpen] = useState(false);
  const openReviewChart = useOpenReviewChart();
  const openChartSignal = useOpenChartSignal();

  if (loading) {
    return (
      <div className="best-decision-box bdb-watch" style={{ minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="spinner" style={{ width: 16, height: 16 }} />
      </div>
    );
  }

  if (!c) {
    return (
      <div className="best-decision-box bdb-watch bdb-empty">
        <div className="bdb-empty-title">Inget starkt läge just nu</div>
        <div className="bdb-empty-sub">
          Systemet bevakar marknaden men hittar ingen kandidat som uppfyller kriterierna.
          Kan inte bedöma just nu — vänta på nästa scan.
        </div>
      </div>
    );
  }

  const bias = BIAS_SV[c.nextMoveBias] || BIAS_SV.UNCERTAIN;
  const decisionText = DECISION_SV[c.priority] || 'Vänta';
  const isActive = c.priority === 'active';
  const isRisk   = c.priority === 'avoid';
  const updatedAt = c.timestamp || c.lastUpdate || null;
  const dt = r?.daytradeStatus ? r : null;

  const fmtPrice = (p) => {
    if (p == null) return null;
    const dec = p > 100 ? 2 : p > 1 ? 3 : 5;
    return Number(p).toFixed(dec);
  };

  return (
    <div className={`best-decision-box ${isActive ? 'bdb-active' : isRisk ? 'bdb-risk' : 'bdb-watch'}`}>
      <div className="bdb-header">
        <div className="bdb-left">
          <span className="bdb-kicker">Bästa kandidat just nu</span>
          <span className="bdb-symbol">{c.symbol}</span>
          <span className="bdb-meta">
            {c.market === 'crypto' ? '₿ Krypto' : '📈 Aktie'}
            {fmtPrice(c.price) && <> · <span className="bdb-price">{fmtPrice(c.price)}</span></>}
          </span>
        </div>
        <div className="bdb-right">
          <span className={`bdb-decision-badge badge-${c.priority}`}>{decisionText}</span>
          <span className={`bdb-bias ${bias.cls}`}>
            {bias.icon} {bias.text} 2–5 min
          </span>
        </div>
      </div>

      <div className="bdb-grid">
        <div className="bdb-stat">
          <span>Confidence</span>
          <strong>{c.confidenceScore}</strong>
        </div>
        <div className="bdb-stat">
          <span>Fakeout-risk</span>
          <strong className={c.fakeoutRiskLevel === 'high' ? 'text-red' : c.fakeoutRiskLevel === 'medium' ? 'text-amber' : 'text-green'}>
            {c.fakeoutRiskLevel === 'high' ? 'Hög' : c.fakeoutRiskLevel === 'medium' ? 'Medel' : 'Låg'}
          </strong>
        </div>
        <div className="bdb-stat">
          <span>TF-stöd</span>
          <strong>{c.agreementCount}/6 tidsramar</strong>
        </div>
        <div className="bdb-stat">
          <span>Tillstånd</span>
          <strong style={{ fontSize: 11 }}>{c.stateGraph?.state || '–'}</strong>
        </div>
        <div className="bdb-stat">
          <span>Uppdaterad</span>
          <strong style={{ fontSize: 11 }}>{updatedAt ? formatDateTime(updatedAt) : 'saknas'}</strong>
        </div>
        <div className="bdb-stat">
          <span>Ålder</span>
          <strong style={{ fontSize: 11 }}>{ageLabel(updatedAt)}</strong>
        </div>
        <div className="bdb-stat">
          <span>Paper/test</span>
          <strong style={{ fontSize: 11 }}>{dt ? `${dt.daytradeStatus || 'OKänt'} · ${dt.daytradeScore ?? 0}` : 'Ingen testsignal ännu'}</strong>
        </div>
      </div>

      <div className="bdb-decision-text">{c.decisionTextSv}</div>
      <AnalystMiniPanel analyst={c.analyst} />

      <div className="plain-expl-grid">
        <ExplanationList title="Vad systemet ser" value={c.explanationSv?.sees} />
        <ExplanationList title="Vad som talar för" value={c.explanationSv?.pro} />
        <ExplanationList title="Vad som talar emot" value={c.explanationSv?.against} />
        <ExplanationList title="Vad som saknas" value={c.explanationSv?.missing} />
        <ExplanationList title="Enkel slutsats" value={c.explanationSv?.conclusion} />
      </div>

      <TfRow timeframes={c.timeframes} agreementCount={c.agreementCount} />

      {(c.hardBlockers?.length > 0 || c.softBlockers?.length > 0) && (
        <div className="bdb-blockers">
          {c.hardBlockers?.map(b => <span key={b} className="blocker-hard">{b}</span>)}
          {c.softBlockers?.map(b => <span key={b} className="blocker-soft">{b}</span>)}
        </div>
      )}

      <div className="bdb-actions">
        <button
          className="btn btn-chart"
          onClick={() => openChartSignal(c)}
        >
          📊 Öppna chart
        </button>
        <button
          className="btn btn-tv"
          onClick={() => openReviewChart(c)}
        >
          📈 Öppna graf
        </button>
        <button className="btn" onClick={() => setOpen(o => !o)}>
          {open ? 'Dölj tekniska detaljer' : 'Tekniska detaljer'}
        </button>
      </div>
    </div>
  );
}

/* ── NEW: Candidate card ─────────────────────────────────────────────────────── */

function CandidateCard({ c, rank }) {
  const [open, setOpen] = useState(false);
  const openReviewChart = useOpenReviewChart();
  const openChartSignal = useOpenChartSignal();
  const bias = BIAS_SV[c.nextMoveBias] || BIAS_SV.UNCERTAIN;
  const decisionText = DECISION_SV[c.priority] || 'Vänta';

  const cardCls = c.priority === 'active'  ? 'cand-active'
    : c.priority === 'caution' ? 'cand-caution'
    : c.priority === 'watch'   ? 'cand-watch'
    : c.priority === 'avoid'   ? 'cand-avoid'
    : 'cand-wait';

  const fmtP = (p) => {
    if (p == null) return null;
    const dec = p > 100 ? 2 : p > 1 ? 3 : 5;
    return Number(p).toFixed(dec);
  };

  const primaryReason = primaryCardReason(c);
  const conclusion    = cardConclusion(c);

  return (
    <div className={`cand-card ${cardCls}`}>
      <div className="cand-rank-badge">#{rank}</div>

      {/* Symbol + marknadstyp */}
      <div className="cand-head">
        <span className="cand-sym">{c.symbol}</span>
        <span className="cand-type-badge">{c.market === 'crypto' ? '₿ Krypto' : '📈 Aktie'}</span>
      </div>

      {/* Status + Riktning — alltid synliga */}
      <div className="cand-status-row">
        <span className={`cand-decision-text decision-${c.priority}`}>{decisionText}</span>
        <span className={`cand-bias ${bias.cls}`}>{bias.icon} {bias.text}</span>
      </div>

      {/* Primär orsak — alltid synlig */}
      {primaryReason && (
        <div className="cand-primary-reason">
          <span className="cand-reason-label">Primär orsak</span>
          <span className="cand-reason-text">{primaryReason}</span>
        </div>
      )}

      {/* Enkel slutsats — alltid synlig */}
      {conclusion && (
        <div className="cand-conclusion">
          <span className="cand-reason-label">Slutsats</span>
          <span className="cand-reason-text">{conclusion}</span>
        </div>
      )}

      <SignalFamilySummary candidate={c} compact />

      {/* Knappar */}
      <div className="cand-actions">
        <button className="btn btn-sm btn-chart" onClick={() => openChartSignal(c)}>
          📊 Öppna chart
        </button>
        <button className="btn btn-sm btn-tv" onClick={() => openReviewChart(c)}>
          📈 Graf
        </button>
        <button className="btn btn-sm" onClick={() => setOpen(o => !o)}>
          {open ? '▲ Dölj mer' : '▼ Visa mer'}
        </button>
      </div>

      {/* Detaljer — bakom "Visa mer" */}
      {open && (
        <>
          {fmtP(c.price) && <span className="cand-price-display">{fmtP(c.price)}</span>}
          <div className="cand-metrics">
            <span className="cand-metric">
              <span className="metric-label">Conf</span>
              <strong className="metric-val">{c.confidenceScore}</strong>
            </span>
            <span className="cand-metric">
              <span className="metric-label">Risk</span>
              <strong className={`metric-val ${c.fakeoutRiskLevel === 'high' ? 'text-red' : c.fakeoutRiskLevel === 'medium' ? 'text-amber' : 'text-green'}`}>
                {c.fakeoutRiskLevel === 'high' ? 'Hög' : c.fakeoutRiskLevel === 'medium' ? 'Medel' : 'Låg'}
              </strong>
            </span>
            <span className="cand-metric">
              <span className="metric-label">TF</span>
              <strong className="metric-val">{c.agreementCount}/6</strong>
            </span>
          </div>
          <TfRow timeframes={c.timeframes} />
          <div className="cand-text">{c.decisionTextSv}</div>
          <AnalystMiniPanel analyst={c.analyst} />
          <div className="cand-expl">
            <ExplanationList title="Vad systemet ser" value={c.explanationSv?.sees} />
            <ExplanationList title="Vad som talar för" value={c.explanationSv?.pro} />
            <ExplanationList title="Vad som talar emot" value={c.explanationSv?.against} />
            <ExplanationList title="Vad som saknas" value={c.explanationSv?.missing} />
          </div>
          {c.hardBlockers?.length > 0 && (
            <div className="cand-blockers">
              {c.hardBlockers.map(b => <span key={b} className="blocker-hard">{b}</span>)}
            </div>
          )}
          <div className="cand-tech">
            <div><span>Konfidens</span><strong>{c.confidenceScore}</strong></div>
            <div><span>Fakeout-risk</span><strong>{c.fakeoutRiskLevel || '–'}</strong></div>
            <div><span>Signal-id</span><strong>{c.signalId || 'saknas'}</strong></div>
            <div><span>Tid</span><strong>{c.timestamp || c.lastUpdate || 'saknas'}</strong></div>
          </div>
          <SignalFamilyTechnicalDetails candidate={c} />
        </>
      )}
    </div>
  );
}

/* ── NEW: Candidate grid ─────────────────────────────────────────────────────── */

function CandidateGrid({ candidates, loading }) {
  if (loading && (!candidates || candidates.length === 0)) {
    return (
      <div className="cand-empty">
        <span className="spinner" style={{ width: 16, height: 16 }} />
        <span>Hämtar kandidater…</span>
      </div>
    );
  }

  if (!candidates || candidates.length === 0) {
    return (
      <div className="cand-empty">
        <strong>Inga kandidater just nu</strong>
        <span>Systemet söker. Ingen färsk kandidat ännu.</span>
      </div>
    );
  }

  const crypto = candidates.filter(c => c.market === 'crypto').slice(0, 3);
  const stocks = candidates.filter(c => c.market !== 'crypto').slice(0, 3);
  const seen = new Set();
  const top = [...crypto, ...stocks, ...candidates]
    .filter((c) => {
      if (seen.has(c.symbol)) return false;
      seen.add(c.symbol);
      return true;
    })
    .slice(0, 20);

  return (
    <div className="cand-grid">
      {top.map((c, i) => <CandidateCard key={c.symbol} c={c} rank={i + 1} />)}
    </div>
  );
}

/* ── NEW: Glossary ───────────────────────────────────────────────────────────── */


function TermGlossary() {
  const [open, setOpen] = useState(false);
  return (
    <div className="glossary-box">
      <button className="glossary-toggle" onClick={() => setOpen(o => !o)}>
        <span>📖 Förklaringsguide — vad betyder termerna?</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{open ? '▲ Dölj' : '▼ Visa'}</span>
      </button>
      {open && (
        <div className="glossary-grid">
          {GLOSSARY.map(item => (
            <div key={item.term} className="glossary-item">
              <span className="glossary-term">{item.term}</span>
              <span className="glossary-desc">{item.desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── OLD components preserved for advanced section ───────────────────────────── */

function PulseLine() {
  return (
    <svg className="pulse-line" viewBox="0 0 220 48" aria-hidden="true">
      <polyline points="0,28 35,28 48,18 58,35 72,12 88,28 125,28 138,22 150,31 165,16 184,28 220,28" />
    </svg>
  );
}

function PulseCard({ r }) {
  const status = simpleStatus(r);
  const score = scoreOf(r);
  const dt = r?.daytradeStatus;
  return (
    <button className={`pulse-card pulse-${statusClass(status)}`} onClick={() => openTradingView(r.symbol, isCryptoSymbol(r.symbol) ? 'crypto' : 'stocks')}>
      <div className="pulse-card-top">
        <span className="pulse-symbol">{r.symbol}</span>
        <span className="pulse-status">{statusLabel(status)}</span>
      </div>
      <PulseLine />
      <div className="pulse-card-bottom">
        <span>{score} poäng</span>
        <span>{directionSv(r)}</span>
      </div>
      {dt && (
        <div className={`daytrade-mini daytrade-${daytradeTone(dt)}`}>
          <span>Daytrade</span>
          <strong>{dt} · {r.daytradeScore ?? 0}</strong>
        </div>
      )}
      <div className="pulse-why">{whyNow(r)}</div>
    </button>
  );
}

function MarketPulse({ rows }) {
  const pulseRows = rows
    .filter(r => r?.price && scoreOf(r) > 60)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, 8);

  return (
    <div className="live-command-section">
      <div className="live-section-head">
        <div>
          <div className="live-section-title">Marknadspuls</div>
          <div className="live-section-sub">Symboler över 60 poäng visas som aktiva pulser.</div>
        </div>
      </div>
      {pulseRows.length === 0 ? (
        <div className="live-calm-state">
          <strong>Marknaden är lugn just nu.</strong>
          <span>Inga starka signaler över 60 poäng.</span>
        </div>
      ) : (
        <div className="pulse-grid">
          {pulseRows.map(r => <PulseCard key={`${r.symbol}-${r.signal || ''}`} r={r} />)}
        </div>
      )}
    </div>
  );
}

function BestLiveCard({ r }) {
  const [open, setOpen] = useState(false);
  if (!r) {
    return (
      <div className="live-best-empty">
        <strong>Inget starkt läge just nu</strong>
        <span>Systemet väntar på bättre fart, tydligare riktning eller lägre risk.</span>
      </div>
    );
  }

  const score = scoreOf(r);
  const status = simpleStatus(r);
  const isConfirmed = score >= 60 && status !== 'RISK';
  const action = isConfirmed && status === 'STARK' ? 'Bevaka' : 'Vänta';
  const hist = r?.momentumBacktestApplied
    ? 'Historiken stödjer fart ihop med flera tidsramar.'
    : 'Historiken ger inget extra stöd just nu.';
  const riskText = isConfirmed ? riskSv(r) : 'Inte bekräftad signal. Vänta på tydligare styrka över 60 poäng.';
  const dt = r?.daytradeStatus ? r : null;

  return (
    <div className={`live-best-card live-best-${statusClass(status)}`}>
      <div className="live-best-main">
        <div>
          <div className="live-kicker">Mest intressant just nu (avancerad vy)</div>
          <div className="live-best-symbol">{r.symbol}</div>
          <div className="live-best-dir">{directionSv(r)} · {score} poäng</div>
        </div>
        <div className="live-best-action">{action}</div>
      </div>
      {!isConfirmed && (
        <div className="live-best-confirmation">
          <strong>Inte bekräftad signal</strong>
          <span>Vänta. Poängen är under 60 och risken är högre tills nästa tydliga scan.</span>
        </div>
      )}
      {dt && (
        <div className={`daytrade-panel daytrade-${daytradeTone(dt.daytradeStatus)}`}>
          <div className="daytrade-panel-head">
            <div>
              <span>Daytrade Signal</span>
              <strong>{dt.daytradeStatus} · {dt.daytradeScore} poäng</strong>
            </div>
            <div className="daytrade-dir">{daytradeDirectionSv(dt.daytradeDirection)}</div>
          </div>
          <div className="daytrade-metrics">
            <span>Målzon 1–2%</span>
            <span>Rörelse {fmtPct(dt.targetMove?.currentMovePct)}</span>
            <span>Kvar {fmtPct(dt.targetMove?.remainingToTargetPct)}</span>
          </div>
          {dt.daytradeScore < 60 && <div className="daytrade-note">Inte bekräftad signal</div>}
          {dt.isTooLate && <div className="daytrade-warning">Rörelsen kan vara sen</div>}
          <div className="daytrade-reasons">
            {(dt.daytradeReasons || []).slice(0, 3).map((reason) => <span key={reason}>{reason}</span>)}
            {(dt.daytradeWarnings || []).slice(0, 2).map((warning) => <span key={warning} className="warn">{warning}</span>)}
          </div>
        </div>
      )}
      <div className="live-best-grid">
        <div>
          <span>Varför systemet tittar</span>
          <strong>{whyNow(r)}</strong>
        </div>
        <div>
          <span>Risk</span>
          <strong>{riskText}</strong>
        </div>
        <div>
          <span>Vad historiken säger</span>
          <strong>{hist}</strong>
        </div>
        <div>
          <span>Vad du bör göra</span>
          <strong>{action}</strong>
        </div>
      </div>
      <div className="live-best-actions">
        <button className="btn btn-tv" onClick={() => openTradingView(r.symbol, isCryptoSymbol(r.symbol) ? 'crypto' : 'stocks')}>📈 Öppna TradingView</button>
        <button className="btn btn-secondary" onClick={() => setOpen(o => !o)}>{open ? 'Dölj tekniska detaljer' : 'Visa tekniska detaljer'}</button>
      </div>
      {open && <DecisionHeroCard r={r} tvLinkFn={tvLinkFor} />}
    </div>
  );
}

const STATE_AVOID = new Set(['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID', 'BREAKOUT_ALREADY_OCCURRED', 'NO_TRADE']);
const READY_THRESHOLD = 60;

function signalBoardCandidateScore(r) {
  return Math.max(r?.tradeScore ?? 0, r?.daytradeScore ?? 0, r?._decision?.signalScore ?? 0, r?.priorityScore ?? 0);
}

function hasSignalBoardHardBlock(r, fakeoutHigh) {
  return (
    STATE_AVOID.has(r?.state) ||
    r?.threeFingerSpread?.active === true ||
    r?.tfs?.active === true ||
    r?.tfsActive === true ||
    r?.breakoutAlreadyOccurred === true ||
    fakeoutHigh
  );
}

function isSignalBoardDataWarning(r) {
  if (!r?.price) return true;
  const ageMs = r.lastUpdate ? Date.now() - new Date(r.lastUpdate).getTime() : null;
  if (ageMs !== null && ageMs > 10 * 60 * 1000) return true;
  return r?.candleCount !== undefined && Number(r.candleCount) < 40;
}

function classifySignal(r) {
  if (isSignalBoardDataWarning(r)) return 'DATA_WARNING';
  const score = r.tradeScore ?? 0;
  const cfBlocked = r.autoFilter?.blocked === true;
  const fakeoutHigh = r.fakeoutRiskLevel === 'high' || (r.fakeoutProbability ?? 0) >= 70;
  const hasWatchMode = r.watchMode || r.momentumWatchMode || r.liquiditySweepWatchMode || r.preMoveContext?.preMoveWatchMode;
  const hardBlocked = hasSignalBoardHardBlock(r, fakeoutHigh);
  if (!cfBlocked && !hardBlocked && score >= 60) return 'READY';
  if (!hardBlocked && (hasWatchMode || score >= 20 || ['Bevaka', 'Intressant'].includes(r?.daytradeStatus) || signalBoardCandidateScore(r) >= 45)) return 'WATCH';
  if (cfBlocked || hardBlocked) return 'BLOCKED';
  return 'NO_SIGNAL';
}

function signalBoardHardBlockers(r) {
  const out = [];
  const fakeoutHigh = r?.fakeoutRiskLevel === 'high' || (r?.fakeoutProbability ?? 0) >= 70;
  if (!r?.price) out.push('DATA: missing price');
  if (r?.threeFingerSpread?.active === true || r?.tfs?.active === true || r?.tfsActive === true || r?.state === 'THREE_FINGER_SPREAD_AVOID') out.push('Three Finger Spread');
  if (r?.state === 'WIDE_AVOID') out.push('WIDE_AVOID');
  if (r?.state === 'NO_TRADE') out.push('NO_TRADE');
  if (r?.breakoutAlreadyOccurred === true || r?.state === 'BREAKOUT_ALREADY_OCCURRED') out.push('breakout already occurred');
  if (fakeoutHigh) out.push('fakeout high');
  return [...new Set(out)];
}

function signalBoardSoftBlockers(r) {
  const out = [];
  if (r?.autoFilter?.blocked === true || r?.confidence?.label === 'Blockerad') out.push('Confidence Engine');
  if (r?.priceToZoneAtr !== null && r?.priceToZoneAtr !== undefined && Number(r.priceToZoneAtr) > 1.5) out.push('price extended');
  if (r?.relVol20 !== null && r?.relVol20 !== undefined && Number(r.relVol20) < 0.7) out.push('low liquidity');
  if (['conflicting', 'full_conflict'].includes(r?.mtfAlignment)) out.push('MTF conflict');
  return [...new Set(out)];
}

function signalBoardReadyGap(r) {
  const tradeScore = r?.tradeScore ?? 0;
  const candidate = signalBoardCandidateScore(r);
  const hardBlockers = signalBoardHardBlockers(r);
  const softBlockers = signalBoardSoftBlockers(r);
  const missingScore = Math.max(0, READY_THRESHOLD - tradeScore);
  const rulesRemaining = hardBlockers.length + softBlockers.length + (missingScore > 0 ? 1 : 0);
  const status = classifySignal(r);
  return {
    status, candidateScore: candidate, tradeScore, readyThreshold: READY_THRESHOLD,
    missingScore, hardBlockers, softBlockers, rulesRemaining,
    label: status === 'READY' ? 'READY'
      : hardBlockers.length ? 'Hard block — ska inte jagas'
      : rulesRemaining <= 2 ? 'Nära READY'
      : 'Soft block — bevaka om marknaden förbättras',
  };
}

function classifySignalBoardSection(r) {
  const status = classifySignal(r);
  if (status !== 'BLOCKED') return status;
  return signalBoardHardBlockers(r).length ? 'HARD_BLOCKED' : 'SOFT_BLOCKED';
}

function compareSignalBoardRows(a, b) {
  const ag = signalBoardReadyGap(a);
  const bg = signalBoardReadyGap(b);
  return bg.tradeScore - ag.tradeScore || ag.softBlockers.length - bg.softBlockers.length || bg.candidateScore - ag.candidateScore;
}

function sbBlockReason(r) {
  if (r.autoFilter?.reasonSv) return r.autoFilter.reasonSv;
  if (r.fakeoutRiskLevel === 'high') return `Hög fakeout-risk (${r.fakeoutProbability ?? '?'}%). Vänta på bekräftelse.`;
  const sr = {
    WIDE_AVOID: 'Priset är för utsträckt. Undvik att gå in nu.',
    THREE_FINGER_SPREAD_AVOID: 'Three Finger Spread aktiv — priset är för utsträckt.',
    BREAKOUT_ALREADY_OCCURRED: 'Utbrottet har redan skett — för sent att jaga.',
    NO_TRADE: 'Ingen handelssignal just nu.',
  };
  return sr[r.state] || 'Systemet blockerar signalen just nu.';
}

function sbWatchReason(r) {
  const parts = [];
  if (r.preMoveContext?.preMoveWatchMode) parts.push('Tidigt läge');
  if (r.ruleMemory?.watchMode) parts.push('Historiken stödjer');
  if (r.momentumWatchMode) parts.push('Momentum');
  if (r.watchMode && !parts.length) parts.push('Bevaka');
  return parts.join(' · ') || `Poäng ${r.tradeScore ?? 0}`;
}

function SbRow({ r, cat }) {
  const gap = signalBoardReadyGap(r);
  const blockerText = [
    gap.hardBlockers.length ? `Hard: ${gap.hardBlockers.join(', ')}` : null,
    gap.softBlockers.length ? `Soft: ${gap.softBlockers.join(', ')}` : null,
  ].filter(Boolean).join(' · ');
  const dt = r.daytradeStatus;
  const dir = directionSv(r);
  return (
    <div className="sb-row">
      <span className="sb-sym">{r.symbol}</span>
      <span className="sb-score-pair">
        <span>Cand {gap.candidateScore}</span>
        <span>Trade {gap.tradeScore}/{gap.readyThreshold}</span>
      </span>
      {dir !== 'Avvakta' && <span className="sb-dir">{dir}</span>}
      {dt && <span className="sb-dt">{dt} {r.daytradeScore ?? 0}</span>}
      <span className="sb-why">
        {cat === 'HARD_BLOCKED' || cat === 'SOFT_BLOCKED' ? sbBlockReason(r) : cat === 'WATCH' ? sbWatchReason(r) : whyNow(r)}
      </span>
      <div className="sb-ready-gap">
        <span className={`sb-gap-label ${gap.hardBlockers.length ? 'is-hard' : 'is-soft'}`}>{gap.label}</span>
        <span>{gap.missingScore > 0 ? `${gap.missingScore}p kvar` : 'score klar'}</span>
        {blockerText && <span className="sb-gap-rules">{blockerText}</span>}
      </div>
    </div>
  );
}

function SignalBoard({ allResults }) {
  const cats = { READY: [], WATCH: [], HARD_BLOCKED: [], SOFT_BLOCKED: [], DATA_WARNING: [], NO_SIGNAL: [] };
  for (const r of allResults) {
    cats[classifySignalBoardSection(r)].push(r);
  }
  for (const k of Object.keys(cats)) {
    cats[k].sort(compareSignalBoardRows);
  }

  const sections = [
    { key: 'READY',        icon: '🟢', label: 'READY — Stark kandidat',         cls: 'sb-ready' },
    { key: 'WATCH',        icon: '👁',  label: 'WATCH — Nära READY',             cls: 'sb-watch' },
    { key: 'SOFT_BLOCKED', icon: '🟠', label: 'SOFT BLOCKED — Bevaka förbättring', cls: 'sb-softblocked' },
    { key: 'HARD_BLOCKED', icon: '🔴', label: 'HARD BLOCKED — Jaga inte',       cls: 'sb-blocked' },
    { key: 'DATA_WARNING', icon: '⚠️', label: 'DATA_WARNING — Äldre data',      cls: 'sb-datawarn' },
    { key: 'NO_SIGNAL',    icon: '⏳', label: 'NO_SIGNAL — Inget läge',         cls: 'sb-nosignal' },
  ];

  const hasAny = sections.some(s => cats[s.key].length > 0);
  if (!hasAny) return null;

  return (
    <div className="live-command-section">
      <div className="live-section-head">
        <div>
          <div className="live-section-title">Signalöversikt (avancerad)</div>
          <div className="live-section-sub">Alla symboler kategoriserade</div>
        </div>
      </div>
      <div className="signal-board">
        {sections.map(({ key, icon, label, cls }) => {
          const rows = cats[key];
          if (!rows.length) return null;
          return (
            <div key={key} className={`sb-section ${cls}`}>
              <div className="sb-sec-head">
                <span className="sb-icon">{icon}</span>
                <span className="sb-sec-title">{label}</span>
                <span className="sb-count">{rows.length}</span>
              </div>
              {rows.map(r => <SbRow key={r.symbol} r={r} cat={key} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PRIORITY_STYLE = {
  active:  { cls: 'dm-card-active',  badge: 'Titta manuellt' },
  caution: { cls: 'dm-card-caution', badge: 'Nära men försiktig' },
  watch:   { cls: 'dm-card-watch',   badge: 'Bevaka' },
  wait:    { cls: 'dm-card-wait',    badge: 'Vänta' },
  avoid:   { cls: 'dm-card-avoid',   badge: 'Jaga inte' },
  stale:   { cls: 'dm-card-wait',    badge: 'Data gammal' },
  unknown: { cls: 'dm-card-wait',    badge: 'Kan inte bedöma' },
};

const BIAS_ICON = { UP: '▲', DOWN: '▼', NEUTRAL: '→', UNCERTAIN: '?' };

function primaryStopReason(c) {
  if (c.dataFreshness === 'MARKET_CLOSED') {
    return 'Marknaden är stängd. Visar senaste handelspass.';
  }
  const all = [...(c.hardBlockers || []), ...(c.softBlockers || [])].join(' ').toLowerCase();
  if (c.twoMinuteConflict || all.includes('candles säger emot')) return 'Senaste 2m-candles säger emot';
  if (all.includes('för långt gången') || all.includes('långt gången')) return 'Rörelsen är för långt gången';
  if (all.includes('gammal') || all.includes('stale')) return 'Data är gammal';
  if (all.includes('2m')) return '2m saknar bekräftelse';
  if (all.includes('ryckig')) return 'Marknaden är ryckig';
  if (all.includes('volym') || all.includes('liquidity')) return 'Volymen är svag';
  return c.hardBlockers?.[0] || c.softBlockers?.[0] || 'Vänta på tydligare läge';
}

function primaryCardReason(c) {
  if (c.priority === 'avoid' || c.priority === 'wait') return primaryStopReason(c);
  const sees = Array.isArray(c.explanationSv?.sees) ? c.explanationSv.sees[0] : c.explanationSv?.sees;
  return sees || c.decisionTextSv || 'Systemet bevakar läget.';
}

function cardConclusion(c) {
  const conclusion = Array.isArray(c.explanationSv?.conclusion)
    ? c.explanationSv.conclusion[0]
    : c.explanationSv?.conclusion;
  return conclusion || null;
}

function SignalFamilySummary({ candidate, compact = false }) {
  const meta = signalFamilyMeta(candidate);
  return (
    <div className={`signal-family-box signal-family-${meta.tone}${compact ? ' signal-family-compact' : ''}`}>
      <div className="signal-family-row">
        <span>Signaltyp</span>
        <strong>{meta.familyLabel}</strong>
      </div>
      {meta.subtype !== 'UNKNOWN' && (
        <div className="signal-family-row">
          <span>Undertyp</span>
          <strong>{meta.subtypeLabel}</strong>
        </div>
      )}
      <div className="signal-family-desc">{meta.description}</div>
    </div>
  );
}

function SignalFamilyTechnicalDetails({ candidate }) {
  const meta = signalFamilyMeta(candidate);
  const calibration = familyCalibrationMeta(candidate.familyCalibrationHints);
  return (
    <details className="signal-family-tech">
      <summary>Tekniska signaldetaljer</summary>
      <div className="signal-family-tech-grid">
        <div><span>signalFamily</span><strong>{meta.family}</strong></div>
        <div><span>signalSubtype</span><strong>{meta.subtype}</strong></div>
        <div><span>historicalEdge</span><strong>{calibration.historicalEdge}</strong></div>
        <div><span>suggestedPriorityBias</span><strong>{calibration.suggestedPriorityBias}</strong></div>
        <div className="signal-family-tech-wide"><span>calibrationSource</span><strong>{calibration.source}</strong></div>
        {meta.debugReason && <div className="signal-family-tech-wide"><span>familyDebug</span><strong>{meta.debugReason}</strong></div>}
      </div>
    </details>
  );
}

function FamilyCalibrationSummary({ candidate }) {
  const calibration = familyCalibrationMeta(candidate.familyCalibrationHints);
  return (
    <div className={`family-calibration-box family-calibration-${calibration.edgeTone}`}>
      <div className="family-calibration-row">
        <span>Historisk edge</span>
        <strong>{calibration.edgeLabel}</strong>
      </div>
      <div className="family-calibration-desc">{calibration.reasonSv}</div>
      <div className="family-calibration-action">{calibration.priorityBiasLabel}</div>
    </div>
  );
}

function DecisionCard({ c }) {
  const [open, setOpen] = useState(false);
  const style = PRIORITY_STYLE[c.priority] || PRIORITY_STYLE.wait;
  const openReviewChart = useOpenReviewChart();
  const candleScore = c.tfDebug?.candleScore2m || c.candleScore2m;
  const conclusion = cardConclusion(c);

  return (
    <div className={`dm-card ${style.cls}`}>
      {/* Symbol + Status + Riktning — alltid synliga */}
      <div className="dm-card-top">
        <div className="dm-card-left">
          <span className="dm-sym">{c.symbol}</span>
          {c.price != null && <span className="dm-price">{Number(c.price).toFixed(2)}</span>}
        </div>
        <div className="dm-card-right">
          <span className={`dm-badge dm-badge-${c.priority}`}>{style.badge}</span>
          {c.dataFreshness === 'MARKET_CLOSED' && <span className="dm-badge dm-badge-wait">Marknaden stängd</span>}
          <span className="dm-bias">{BIAS_ICON[c.nextMoveBias] || '?'} {c.nextMoveBiasLabel?.sv || c.nextMoveBias}</span>
        </div>
      </div>

      {/* Primär orsak — alltid synlig */}
      <div className="dm-primary-reason">
        <span>Primär orsak</span>
        <strong>{primaryStopReason(c)}</strong>
      </div>

      {/* Enkel slutsats — alltid synlig */}
      {conclusion && (
        <div className="dm-conclusion">
          <span>Slutsats</span>
          <strong>{conclusion}</strong>
        </div>
      )}

      <SignalFamilySummary candidate={c} />
      <FamilyCalibrationSummary candidate={c} />

      {c.twoMinuteConflict && (
        <div className="dm-conflict-row">2m-konflikt: senaste candles säger emot.</div>
      )}
      {c.status === 'wait' && c.agreementCount >= 5 && (
        <div className="dm-context-note">Stark större bild, men kort signal saknas.</div>
      )}

      {/* Knappar */}
      <div className="dm-actions-row">
        <button className="dm-toggle" onClick={() => openReviewChart(c)}>Öppna graf</button>
        <button className="dm-toggle" onClick={() => setOpen(o => !o)}>
          {open ? '▲ Dölj mer' : '▼ Visa mer'}
        </button>
      </div>

      {/* Detaljer — bakom "Visa mer" */}
      {open && (
        <>
          <div className="dm-decision-text">{c.decisionTextSv}</div>
          <AnalystMiniPanel analyst={c.analyst} />
          {(c.hardBlockers?.length > 0 || c.softBlockers?.length > 0) && (
            <div className="dm-blockers">
              {c.hardBlockers?.map(b => <span key={b} className="dm-blocker dm-hard">{b}</span>)}
              {c.softBlockers?.map(b => <span key={b} className="dm-blocker dm-soft">{b}</span>)}
            </div>
          )}
          <TfRow timeframes={c.timeframes} agreementCount={c.agreementCount} />
          <div className="dm-expl-grid">
            <ExplanationList title="Vad systemet ser" value={c.explanationSv?.sees} />
            <ExplanationList title="Talar för" value={c.explanationSv?.pro} />
            <ExplanationList title="Talar emot" value={c.explanationSv?.against} />
            <ExplanationList title="Saknas" value={c.explanationSv?.missing} />
          </div>
          <div className="dm-details">
            <div className="dm-detail-row"><span>Konfidenspoäng</span><strong>{c.confidenceScore}</strong></div>
            <div className="dm-detail-row"><span>Fakeout-risk</span><strong>{c.fakeoutRiskLevel || '–'}</strong></div>
            {candleScore?.reasonSv && (
              <div className="dm-detail-row"><span>2m candle-score</span><strong>{candleScore.reasonSv}</strong></div>
            )}
          </div>
          <SignalFamilyTechnicalDetails candidate={c} />
        </>
      )}
    </div>
  );
}

function DecisionMonitorSection({ dmData }) {
  const [group, setGroup] = useState('all');
  if (!dmData) {
    return (
      <div className="live-command-section dm-section">
        <div className="live-section-title">Beslutsstöd (avancerad)</div>
        <div className="dm-loading"><span className="spinner" style={{ width: 14, height: 14 }} /> Analyserar…</div>
      </div>
    );
  }
  const { candidates = [], summary = {} } = dmData;
  const filtered = group === 'all' ? candidates
    : group === 'active' ? candidates.filter(c => c.priority === 'active' || c.priority === 'caution' || c.priority === 'watch')
    : candidates.filter(c => c.market === group);

  return (
    <div className="live-command-section dm-section">
      <div className="live-section-head">
        <div>
          <div className="live-section-title">Beslutsstöd (avancerad vy)</div>
          <div className="live-section-sub">Systemet ger aldrig handelsorder.</div>
        </div>
        <div className="dm-summary-chips">
          {summary.active > 0  && <span className="dm-chip dm-chip-active">{summary.active} titta manuellt</span>}
          {summary.caution > 0 && <span className="dm-chip dm-chip-caution">{summary.caution} obs</span>}
          {summary.watch > 0   && <span className="dm-chip dm-chip-watch">{summary.watch} bevaka</span>}
          {summary.wait > 0    && <span className="dm-chip dm-chip-wait">{summary.wait} vänta</span>}
          {summary.avoid > 0   && <span className="dm-chip dm-chip-avoid">{summary.avoid} jaga inte</span>}
        </div>
      </div>
      <div className="dm-filter-row">
        {['all', 'active', 'stocks', 'crypto'].map(g => (
          <button key={g} className={`dm-filter-btn ${group === g ? 'active' : ''}`} onClick={() => setGroup(g)}>
            {g === 'all' ? 'Alla' : g === 'active' ? 'Aktiva' : g === 'stocks' ? 'Aktier' : 'Krypto'}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="dm-empty">Inga kandidater i valt filter.</div>
      ) : (
        <div className="dm-grid">
          {filtered.map(c => <DecisionCard key={c.symbol} c={c} />)}
        </div>
      )}
      <div className="dm-disclaimer">
        Systemet är ett analysstöd. Det ger aldrig handelsorder. TF-riktningar är deriverade.
      </div>
    </div>
  );
}

/* ── Quick Signal View ───────────────────────────────────────────────────────── */

const SIGNAL_TYPE_SV = {
  NARROW_COMPRESSION:    'Tryckt pris',
  EMA_TREND_PULLBACK:    'Trendstuds',
  VWAP_RECLAIM_REJECTION:'VWAP-läge',
};

const SIGNAL_TYPE_DESC_SV = {
  NARROW_COMPRESSION:    'Priset är ihoptryckt. Något kan snart hända.',
  EMA_TREND_PULLBACK:    'Priset studsar i trenden.',
  VWAP_RECLAIM_REJECTION:'Priset testar dagens mittlinje.',
};

const QS_TF_KEYS = ['tf1h', 'tf30m', 'tf15m', 'tf10m', 'tf5m', 'tf2m'];

function isCanUp(c) {
  return (
    c.nextMoveBias === 'UP' ||
    (c.signalFamily === 'NARROW_COMPRESSION' && c.nextMoveBias !== 'DOWN') ||
    c.signalSubtype === 'EMA_PULLBACK_UP' ||
    c.signalSubtype === 'VWAP_RECLAIM_UP'
  );
}

function isCanDown(c) {
  return (
    c.nextMoveBias === 'DOWN' ||
    (c.signalFamily === 'NARROW_COMPRESSION' && c.nextMoveBias === 'DOWN') ||
    c.signalSubtype === 'EMA_PULLBACK_DOWN' ||
    c.signalSubtype === 'VWAP_REJECTION_DOWN'
  );
}

function qsStatusInfo(c, direction) {
  if (c.priority === 'avoid' || (c.hardBlockers?.length > 0 && c.priority !== 'active' && c.priority !== 'caution')) {
    return { text: 'Inte bra nu', cls: 'qs-status-gray' };
  }
  if (c.priority === 'active' || c.priority === 'caution') {
    return direction === 'up'
      ? { text: 'Kan upp', cls: 'qs-status-green' }
      : { text: 'Kan ner', cls: 'qs-status-red' };
  }
  return { text: 'Vänta', cls: 'qs-status-yellow' };
}

function qsSortScore(c) {
  const order = { active: 0, caution: 1, watch: 2, wait: 3, avoid: 4, stale: 5, unknown: 6 };
  return (order[c.priority] ?? 9) * 1000 - (c.confidenceScore ?? 0);
}

function QsMiniSpark({ timeframes, direction }) {
  const pts = QS_TF_KEYS.map((k, i) => {
    const v = timeframes?.[k] || 'neutral';
    const y = v === 'bullish' ? 10 : v === 'bearish' ? 34 : 22;
    return `${i * 22},${y}`;
  });
  const stroke = direction === 'up' ? '#22c55e' : direction === 'down' ? '#ef4444' : '#57637e';
  return (
    <svg className="qs-spark" viewBox="0 0 110 44" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function QsSignalBadge({ signalFamily, signalSubtype }) {
  const typeName = SIGNAL_TYPE_SV[signalFamily] || null;
  const subLabel = SIGNAL_SUBTYPE_LABELS_COMPACT[signalSubtype] || null;
  if (!typeName && !subLabel) return null;
  return (
    <div className="qs-signal-badges">
      {typeName && <span className="qs-signal-type">{typeName}</span>}
      {subLabel  && <span className="qs-signal-sub">{subLabel}</span>}
    </div>
  );
}

const SIGNAL_SUBTYPE_LABELS_COMPACT = {
  EMA_PULLBACK_UP:       'EMA uppåt',
  EMA_PULLBACK_DOWN:     'EMA nedåt',
  VWAP_RECLAIM_UP:       'VWAP uppåt',
  VWAP_REJECTION_DOWN:   'VWAP nedåt',
  REGULAR_PULLBACK:      'Rekyl',
};

function QsCard({ c, direction }) {
  const openReviewChart = useOpenReviewChart();
  const status = qsStatusInfo(c, direction);
  const desc = SIGNAL_TYPE_DESC_SV[c.signalFamily] || null;

  return (
    <div className={`qs-card qs-card-${direction}`}>
      <div className="qs-card-top">
        <span className="qs-symbol">{c.symbol}</span>
        <span className={`qs-status-badge ${status.cls}`}>{status.text}</span>
      </div>
      <QsMiniSpark timeframes={c.timeframes} direction={direction} />
      <QsSignalBadge signalFamily={c.signalFamily} signalSubtype={c.signalSubtype} />
      {desc && <p className="qs-desc">{desc}</p>}
      <div className="qs-actions">
        <button className="qs-btn" onClick={() => openReviewChart(c)}>Öppna graf</button>
      </div>
    </div>
  );
}

function QsColumn({ title, direction, candidates, loading }) {
  const sorted = [...candidates].sort((a, b) => qsSortScore(a) - qsSortScore(b)).slice(0, 6);

  if (loading && sorted.length === 0) {
    return (
      <div className={`qs-column qs-column-${direction}`}>
        <div className={`qs-column-title qs-col-title-${direction}`}>{title}</div>
        <div className="qs-col-empty"><span className="spinner" style={{ width: 14, height: 14 }} /></div>
      </div>
    );
  }

  return (
    <div className={`qs-column qs-column-${direction}`}>
      <div className={`qs-column-title qs-col-title-${direction}`}>
        {direction === 'up' ? '▲' : '▼'} {title}
        {sorted.length > 0 && <span className="qs-col-count">{sorted.length}</span>}
      </div>
      {sorted.length === 0 ? (
        <div className="qs-col-empty">Inga just nu</div>
      ) : (
        <div className="qs-cards">
          {sorted.map(c => <QsCard key={c.symbol} c={c} direction={direction} />)}
        </div>
      )}
    </div>
  );
}

function QuickSignalSection({ candidates, loading }) {
  const upCandidates   = candidates.filter(isCanUp).filter(c => !isCanDown(c) || c.nextMoveBias === 'UP');
  const downCandidates = candidates.filter(isCanDown).filter(c => !isCanUp(c) || c.nextMoveBias === 'DOWN');

  return (
    <section className="qs-section">
      <div className="qs-header">
        <h2 className="qs-title">Snabb signalvy</h2>
        <p className="qs-subtitle">Vad ser ut att kunna röra sig — uppåt eller nedåt?</p>
      </div>
      <div className="qs-columns">
        <QsColumn title="Kan upp"  direction="up"   candidates={upCandidates}   loading={loading} />
        <QsColumn title="Kan ner"  direction="down"  candidates={downCandidates} loading={loading} />
      </div>
    </section>
  );
}

function FocusCard({ c, variant = 'focus' }) {
  const openReviewChart = useOpenReviewChart();
  const openChartSignal = useOpenChartSignal();
  const updatedAt = c.timestamp || c.lastUpdate || null;
  const score = signalBoardCandidateScore(c);
  const decisionText = DECISION_SV[c.priority] || 'Vänta';
  const bias = BIAS_SV[c.nextMoveBias] || BIAS_SV.UNCERTAIN;
  const isAvoid = variant === 'avoid';
  const moreDataNeeded = c.price == null || c.dataFreshness === 'STALE' || (!isAvoid && c.priority === 'watch');
  const paperStatus = c.daytradeStatus ? `${c.daytradeStatus} · ${c.daytradeScore ?? 0}` : 'Ingen testsignal ännu';
  const conclusion = cardConclusion(c);

  return (
    <article className={`live-focus-card ${isAvoid ? 'live-focus-avoid' : `live-focus-${c.priority || 'watch'}`}`}>
      <div className="live-focus-head">
        <div className="live-focus-left">
          <div className="live-focus-symbol-row">
            <span className="live-focus-symbol">{c.symbol}</span>
            <span className={`live-focus-market ${c.market === 'crypto' ? 'is-crypto' : 'is-stock'}`}>
              {c.market === 'crypto' ? '₿ Krypto' : '📈 Aktie'}
            </span>
          </div>
          <div className="live-focus-meta">
            <span>{bias.icon} {bias.text}</span>
            <span>·</span>
            <span>{ageLabel(updatedAt)}</span>
          </div>
        </div>
        <div className="live-focus-right">
          <span className={`live-focus-badge badge-${isAvoid ? 'avoid' : c.priority}`}>
            {isAvoid ? 'Undvik' : decisionText}
          </span>
          <strong>{score}</strong>
        </div>
      </div>

      <div className="live-focus-block">
        <span>Varför</span>
        <strong>{primaryCardReason(c)}</strong>
      </div>

      <div className="live-focus-block">
        <span>Slutsats</span>
        <strong>{conclusion || (moreDataNeeded ? 'Mer data behövs.' : 'Tillräckligt för bevakning.')}</strong>
      </div>

      <div className="live-focus-meta-grid">
        <div>
          <span>Paper/test</span>
          <strong>{paperStatus}</strong>
        </div>
        <div>
          <span>Mer data</span>
          <strong>{moreDataNeeded ? 'Ja' : 'Nej'}</strong>
        </div>
      </div>

      <div className="live-focus-actions">
        <button className="btn btn-sm btn-chart" onClick={() => openChartSignal(c)}>
          📊 Öppna chart
        </button>
        <button className="btn btn-sm btn-tv" onClick={() => openReviewChart(c)}>
          📈 TradingView
        </button>
      </div>
    </article>
  );
}

function FocusNowSection({ candidates, loading }) {
  const focusCandidates = [...candidates]
    .filter(c => c.priority === 'active' || c.priority === 'caution' || c.priority === 'watch')
    .slice(0, 5);
  const avoidCandidates = [...candidates]
    .filter(c => c.priority === 'avoid')
    .slice(0, 5);
  const hasAny = focusCandidates.length > 0 || avoidCandidates.length > 0;

  return (
    <section className="live-command-section live-focus-section">
      <div className="live-section-head live-focus-head-row">
        <div>
          <div className="live-section-title">Fokus just nu</div>
          <div className="live-section-sub">Top 3-5 kandidater att titta på och vad som ska undvikas just nu.</div>
        </div>
      </div>

      {loading && !hasAny ? (
        <div className="live-calm-state">
          <span className="spinner" />
          <span>Hämtar fokusläge…</span>
        </div>
      ) : !hasAny ? (
        <div className="live-calm-state">
          <strong>Systemet söker. Ingen färsk kandidat ännu.</strong>
          <span>Det finns inget nytt fokusläge att visa just nu.</span>
        </div>
      ) : (
        <div className="live-focus-grid">
          <div className="live-focus-column">
            <div className="live-focus-column-title">Fokus just nu</div>
            {focusCandidates.length === 0 ? (
              <div className="live-focus-empty">Inga tydliga fokuslägen just nu.</div>
            ) : (
              <div className="live-focus-list">
                {focusCandidates.map((c, i) => <FocusCard key={`${c.symbol}-${i}`} c={c} />)}
              </div>
            )}
          </div>
          <div className="live-focus-column live-focus-column-avoid">
            <div className="live-focus-column-title">Undvik just nu</div>
            {avoidCandidates.length === 0 ? (
              <div className="live-focus-empty">Inga tydliga undvik-lägen just nu.</div>
            ) : (
              <div className="live-focus-list">
                {avoidCandidates.map((c, i) => <FocusCard key={`${c.symbol}-${i}`} c={c} variant="avoid" />)}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function LatestActivitySection({ paperEvents }) {
  const events = (paperEvents?.events || []).slice(0, 3);
  return (
    <section className="live-command-section live-activity-section">
      <div className="live-section-head">
        <div>
          <div className="live-section-title">Senaste aktivitet</div>
          <div className="live-section-sub">Senaste testbesluten och systemaktiviteten från paper-flödet.</div>
        </div>
      </div>
      {events.length > 0 ? (
        <PaperTradingEventMini data={paperEvents} hideHeader />
      ) : (
        <div className="live-calm-state">
          <strong>Ingen senaste aktivitet ännu.</strong>
          <span>Paper-flödet har inget nytt att visa just nu.</span>
        </div>
      )}
    </section>
  );
}

/* ── Main LivePage ────────────────────────────────────────────────────────────── */

export default function LivePage() {
  const { stocks, crypto, nasdaq, loading, lastFetch, refresh } = useMultiScan();
  const snapshot = useSystemSnapshot();
  const personality  = usePersonality();
  const dmData = useDecisionMonitor();
  const paperEvents = usePaperTradingEvents();
  const { processResults } = useAlerts();
  const [learning, setLearning] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [chartSignal, setChartSignal] = useState(null);

  // Intern chart-panel: lyssna på öppna-event från valfritt signalkort.
  useEffect(() => {
    function handler(e) { setChartSignal(normalizeSignalForChart(e.detail || {})); }
    window.addEventListener(CHART_SIGNAL_EVENT, handler);
    return () => window.removeEventListener(CHART_SIGNAL_EVENT, handler);
  }, []);

  useEffect(() => {
    fetch('/api/history/learning-summary')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.summary) setLearning(j.summary); })
      .catch(() => {});
  }, []);

  useEffect(() => { if (stocks.length) processResults(stocks, 'stocks'); }, [stocks, processResults]);
  useEffect(() => { if (crypto.length) processResults(crypto, 'crypto'); }, [crypto, processResults]);
  useEffect(() => { if (nasdaq.length) processResults(nasdaq, 'nasdaq'); }, [nasdaq, processResults]);

  const allRaw = useMemo(() => [...stocks, ...nasdaq, ...crypto], [stocks, nasdaq, crypto]);
  const allEnriched = useMemo(() => enrichWithDecisions(allRaw, learning), [allRaw, learning]);
  const bestSignal = useMemo(() => getBestSignal(allEnriched), [allEnriched]);
  const hasData = allEnriched.some(r => r.price);

  const candidates = dmData?.candidates || [];
  const topCandidate = candidates[0] || null;

  return (
    <div className="dm-page">
      {/* Page header */}
      <div className="dm-page-header">
        <div>
          <h1 className="dm-page-title">Decision Monitor</h1>
          <p className="dm-page-sub">
            Systemet observerar marknaden och svarar: ska vi titta manuellt, vänta, eller låta bli?
          </p>
        </div>
        <button className="dm-refresh-btn" onClick={() => { refresh(); snapshot.refresh(); }}>
          {loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '↻'} Uppdatera
        </button>
      </div>

      {/* System status row */}
      <SystemRow
        health={snapshot.health}
        lastFetch={lastFetch}
        dmSummary={dmData?.summary}
      />

      <SystemHealthMini health={snapshot.health} lastFetch={lastFetch} />

      {dmData?.summary?.strictnessMessageSv && (
        <div className="dm-strictness-note">{dmData.summary.strictnessMessageSv}</div>
      )}

      {/* Loading state */}
      {loading && !hasData && (
        <div className="empty"><span className="spinner" /> Hämtar live-data…</div>
      )}

      {/* 1. Just nu */}
      <div className="dm-section-group">
        <div className="dm-section-label">1. Just nu</div>
        <div className="live-command-section">
          <div className="live-section-head">
            <div>
              <div className="live-section-title">Vad händer JUST NU?</div>
              <div className="live-section-sub">Senaste toppsignalen med score, orsak, TradingView-länk och ålder.</div>
            </div>
          </div>
          <BestDecisionBox c={topCandidate} loading={loading && !dmData} />
        </div>
      </div>

      {/* 2. Fokus */}
      <div className="dm-section-group">
        <div className="dm-section-label">2. Fokus</div>
        <FocusNowSection candidates={candidates} loading={loading && !dmData} />
      </div>

      {/* 3. Senaste aktivitet */}
      <div className="dm-section-group">
        <div className="dm-section-label">3. Senaste aktivitet</div>
        <LatestActivitySection paperEvents={paperEvents} />
      </div>

      {/* 4. Signaler */}
      <div className="dm-section-group">
        <div className="dm-section-label-row">
          <span className="dm-section-label">4. Signaler</span>
          {candidates.length > 0 && <span className="dm-section-count">{candidates.length} st</span>}
        </div>
        <div className="live-command-section">
          <div className="live-section-head">
            <div>
              <div className="live-section-title">Top 20 signaler just nu</div>
              <div className="live-section-sub">De mest intressanta kandidaterna i aktuell scan.</div>
            </div>
          </div>
          <CandidateGrid candidates={candidates} loading={loading && !dmData} />
        </div>
      </div>

      {/* 5. Historik */}
      <div className="dm-section-group">
        <div className="dm-section-label">5. Historik</div>
        <div className="live-command-section">
          <div className="live-section-head">
            <div>
              <div className="live-section-title">Vad fungerar historiskt?</div>
              <div className="live-section-sub">Här syns vad historiken faktiskt stödjer just nu.</div>
            </div>
          </div>
          <BestLiveCard r={bestSignal} />
        </div>
      </div>

      {/* Advanced section — old UI preserved */}
      <div className="dm-advanced-section">
        <button className="dm-advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
          {showAdvanced ? '▲' : '▼'} 6. Marknadsläge
          <span className="dm-adv-sub">Risk-Off · starkast/svagast · signalöversikt (gamla vyer)</span>
        </button>
        {showAdvanced && hasData && (
          <div className="dm-advanced-body">
            <DecisionMonitorSection dmData={dmData} />
            <MarketPulse rows={allEnriched} />
            <SignalBoard allResults={allEnriched} />
          </div>
        )}
        {showAdvanced && !hasData && (
          <div style={{ padding: '20px', color: 'var(--muted)' }}>
            Ingen live-data tillgänglig för avancerade vyer.
          </div>
        )}
      </div>

      <TermGlossary />

      {/* Intern read-only chart-panel */}
      <TradingViewSignalPanel signal={chartSignal} onClose={() => setChartSignal(null)} />
    </div>
  );
}
